import { useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';

const SOURCE_ID = 'volume-flow-source';
const DEMO_SOURCE_ID = 'volume-flow-demo-source';
const BASE_LAYER_ID = 'volume-flow-base';
const HIGHLIGHT_LAYER_ID = 'volume-flow-highlight';
const LABEL_LAYER_ID = 'volume-flow-labels';
const TARGET_LAYER_ID = 'volume-flow-target';
const ANT_LINE_ID = 'volume-flow-ant-line';
const ANT_SOURCE_ID = 'volume-flow-ant-source';

export default function useVolumeFlowLayers({ mapRef, mapReady }) {
    const {
        isGraphExpanded,
        volumeFlowSegment,
        setVolumeFlowSegment,
        setClickedCanton
    } = useApp();

    const dataLoadedRef = useRef(false);
    const clickHandlerRef = useRef(null);
    const geojsonRef = useRef(null);

    // Load layers when module is active
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;

        if (isGraphExpanded !== 'VolumeFlow') {
            // Clean up when leaving module
            const map = mapRef.current;
            if (map.getLayer(ANT_LINE_ID)) map.removeLayer(ANT_LINE_ID);
            if (map.getSource(ANT_SOURCE_ID)) map.removeSource(ANT_SOURCE_ID);
            if (map.getLayer('volume-flow-target-label')) map.removeLayer('volume-flow-target-label');
            if (map.getLayer(LABEL_LAYER_ID)) map.removeLayer(LABEL_LAYER_ID);
            if (map.getLayer(TARGET_LAYER_ID)) map.removeLayer(TARGET_LAYER_ID);
            if (map.getLayer(HIGHLIGHT_LAYER_ID)) map.removeLayer(HIGHLIGHT_LAYER_ID);
            if (map.getLayer(BASE_LAYER_ID)) map.removeLayer(BASE_LAYER_ID);
            if (map.getSource(DEMO_SOURCE_ID)) map.removeSource(DEMO_SOURCE_ID);
            dataLoadedRef.current = false;
            setVolumeFlowSegment(null);
            return;
        }

        const map = mapRef.current;

        // Auto-select Geneve canton when entering module
        setClickedCanton('Geneve');

        // Load demo GeoJSON
        if (!dataLoadedRef.current) {
            fetch('/webmap/data/matsim/Geneve_merged_segments_demo.geojson')
                .then(res => res.json())
                .then(geojson => {
                    // Add feature index
                    geojson.features = geojson.features.map((f, i) => ({
                        ...f,
                        id: i,
                        properties: {
                            ...f.properties,
                            featureIndex: i
                        }
                    }));

                    geojsonRef.current = geojson;

                    if (map.getSource(DEMO_SOURCE_ID)) return;

                    map.addSource(DEMO_SOURCE_ID, {
                        type: 'geojson',
                        data: geojson
                    });

                    // Base layer removed to hide 0 volume links

                    // Highlight layer - hidden by default, shown when target clicked
                    map.addLayer({
                        id: HIGHLIGHT_LAYER_ID,
                        type: 'line',
                        source: DEMO_SOURCE_ID,
                        paint: {
                            'line-color': '#ff8c00',
                            'line-width': ['interpolate', ['linear'], ['get', 'link_1451949_outflow'],
                                0, 0,
                                1, 1,
                                50, 3,
                                150, 5,
                                300, 8,
                                500, 12,
                                700, 16
                            ],
                            'line-opacity': 0.85
                        },
                        filter: ['==', ['get', 'featureIndex'], -1] // Hidden by default
                    });

                    // Target link layer - always visible in blue
                    map.addLayer({
                        id: TARGET_LAYER_ID,
                        type: 'line',
                        source: DEMO_SOURCE_ID,
                        paint: {
                            'line-color': '#1a73e8',
                            'line-width': 8,
                            'line-opacity': 1
                        },
                        filter: ['==', ['get', 'isTarget'], true]
                    });

                    // Volume labels - hidden by default
                    map.addLayer({
                        id: LABEL_LAYER_ID,
                        type: 'symbol',
                        source: DEMO_SOURCE_ID,
                        layout: {
                            'symbol-placement': 'line-center',
                            'text-field': ['to-string', ['get', 'link_1451949_outflow']],
                            'text-size': 11,
                            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                            'text-allow-overlap': true,
                            'text-ignore-placement': true
                        },
                        paint: {
                            'text-color': '#fff',
                            'text-halo-color': '#ff8c00',
                            'text-halo-width': 2
                        },
                        filter: ['==', ['get', 'featureIndex'], -1] // Hidden by default
                    });

                    // Target link direction label
                    map.addLayer({
                        id: 'volume-flow-target-label',
                        type: 'symbol',
                        source: DEMO_SOURCE_ID,
                        layout: {
                            'symbol-placement': 'line-center',
                            'text-field': '→',
                            'text-size': 16,
                            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                            'text-allow-overlap': true,
                            'text-ignore-placement': true,
                            'text-keep-upright': false
                        },
                        paint: {
                            'text-color': '#1a73e8',
                            'text-halo-color': '#fff',
                            'text-halo-width': 2
                        },
                        filter: ['==', ['get', 'isTarget'], true]
                    });

                    dataLoadedRef.current = true;

                    // Zoom to Geneve demo area
                    map.flyTo({
                        center: [6.148, 46.206],
                        zoom: 15,
                        duration: 1500
                    });
                })
                .catch(err => console.error('Failed to load volume flow GeoJSON:', err));
        }

        // Click handler for target link
        const handleClick = (e) => {
            if (!map.getLayer(TARGET_LAYER_ID)) return;

            const features = map.queryRenderedFeatures(e.point, { layers: [TARGET_LAYER_ID] });

            if (features.length > 0) {
                const feature = features[0];

                // Update target link thickness using same scale as orange links
                // Scale: 0->0, 50->3, 150->5, 300->8, 500->12, 700->16
                const targetVolume = feature.properties.daily_avg_volume || 700;
                let targetWidth = 8; // default
                if (targetVolume >= 700) targetWidth = 16;
                else if (targetVolume >= 500) targetWidth = 12 + (targetVolume - 500) / 200 * 4;
                else if (targetVolume >= 300) targetWidth = 8 + (targetVolume - 300) / 200 * 4;
                else if (targetVolume >= 150) targetWidth = 5 + (targetVolume - 150) / 150 * 3;
                else if (targetVolume >= 50) targetWidth = 3 + (targetVolume - 50) / 100 * 2;
                else targetWidth = targetVolume / 50 * 3;
                map.setPaintProperty(TARGET_LAYER_ID, 'line-width', targetWidth);

                // Show all non-target links with flow visualization
                const flowFilter = ['all',
                    ['!=', ['get', 'isTarget'], true],
                    ['>', ['get', 'link_1451949_outflow'], 0]
                ];
                map.setFilter(HIGHLIGHT_LAYER_ID, flowFilter);
                map.setFilter(LABEL_LAYER_ID, flowFilter);

                // Parse target link properties
                const props = feature.properties;
                const linkIds = props.per_id_keys?.split('|') || [];
                const dailyAvgs = props.per_id_daily_avgs?.split('|').map(Number) || [];
                const directions = props.per_id_directions?.split('|') || [];

                // Build merged links
                const mergedLinks = {};
                linkIds.forEach((id, i) => {
                    const baseId = id.replace('_spec', '');
                    if (!mergedLinks[baseId]) {
                        mergedLinks[baseId] = {
                            baseId,
                            volume: dailyAvgs[i] || 0,
                            direction: directions[i] || 'forward',
                            subLinks: [{ linkId: id, volume: dailyAvgs[i] || 0 }]
                        };
                    } else {
                        mergedLinks[baseId].volume += dailyAvgs[i] || 0;
                        mergedLinks[baseId].subLinks.push({ linkId: id, volume: dailyAvgs[i] || 0 });
                    }
                });

                setVolumeFlowSegment({
                    id: feature.properties.featureIndex,
                    totalVolume: props.daily_avg_volume,
                    links: Object.values(mergedLinks),
                    modes: props.modes
                });
            }
        };

        // Remove old handler
        if (clickHandlerRef.current) {
            map.off('click', clickHandlerRef.current);
        }

        map.on('click', handleClick);
        clickHandlerRef.current = handleClick;

        // Cursor on hover
        map.on('mouseenter', TARGET_LAYER_ID, () => {
            map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', TARGET_LAYER_ID, () => {
            map.getCanvas().style.cursor = '';
        });

        return () => {
            if (clickHandlerRef.current) {
                map.off('click', clickHandlerRef.current);
            }
        };
    }, [mapReady, isGraphExpanded, mapRef, setVolumeFlowSegment, setClickedCanton]);

    return null;
}

// Update flow visualization from sidebar
export function updateFlowVisualization(mapRef, selectedLink, selectedDirection) {
    if (!mapRef.current) return;
    const map = mapRef.current;

    if (!map.getLayer(HIGHLIGHT_LAYER_ID)) return;

    // Determine volume field based on selections
    let volumeField;
    if (selectedLink === '1451949') {
        volumeField = selectedDirection === 'outflow' ? 'link_1451949_outflow' : 'link_1451949_inflow';
    } else {
        volumeField = selectedDirection === 'outflow' ? 'link_1451950_outflow' : 'link_1451950_inflow';
    }

    // Update filter
    const flowFilter = ['all',
        ['!=', ['get', 'isTarget'], true],
        ['>', ['get', volumeField], 0]
    ];
    map.setFilter(HIGHLIGHT_LAYER_ID, flowFilter);
    map.setFilter(LABEL_LAYER_ID, flowFilter);

    // Update line width
    map.setPaintProperty(HIGHLIGHT_LAYER_ID, 'line-width', [
        'interpolate', ['linear'], ['get', volumeField],
        0, 0,
        50, 3,
        150, 5,
        300, 8,
        500, 12,
        700, 16
    ]);

    // Update labels
    map.setLayoutProperty(LABEL_LAYER_ID, 'text-field', ['to-string', ['get', volumeField]]);

    // Update ant-line direction
    // 1451949 goes north (coords 0->1 is south->north)
    // 1451950 goes south (coords 0->1 is south->north, so reverse)
    if (map.getSource(ANT_SOURCE_ID)) {
        const source = map.getSource(ANT_SOURCE_ID);
        const data = source._data;
        if (data && data.geometry && data.geometry.coordinates) {
            const coords = [...data.geometry.coordinates];

            // Determine if animation should be reversed
            // 1451949: outflow goes north (forward), inflow comes from south (reverse)
            // 1451950: outflow goes south (reverse), inflow comes from north (forward)
            let shouldReverse;
            if (selectedLink === '1451949') {
                shouldReverse = selectedDirection === 'inflow';  // inflow = coming from south = reverse
            } else {
                shouldReverse = selectedDirection === 'outflow';  // outflow = going south = reverse
            }

            // Store reversed state on window for animation to read
            window.volumeFlowAnimReverse = shouldReverse;
        }
    }
}
