import { useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';

const DEMO_SOURCE_ID = 'volume-flow-demo-source';
const HIGHLIGHT_LAYER_ID = 'volume-flow-highlight';
const LABEL_LAYER_ID = 'volume-flow-labels';
const TARGET_LAYER_ID = 'volume-flow-target';
const TARGET_LABEL_ID = 'volume-flow-target-label';

const TARGET_LINK = '868430';
const SPIDER_URL = '/webmap/data/matsim/transit/volume_flow_examples/spider_868430.json';
const NETWORK_URL = '/webmap/data/matsim/Zurich_merged_segments.geojson';

export default function useVolumeFlowLayers({ mapRef, mapReady }) {
    const {
        isGraphExpanded,
        setVolumeFlowSegment,
        setClickedCanton
    } = useApp();

    const dataLoadedRef = useRef(false);
    const clickHandlerRef = useRef(null);
    const spiderRef = useRef(null);
    const enrichedRef = useRef(null);
    const spiderMapRef = useRef(null);

    useEffect(() => {
        if (!mapReady || !mapRef.current) return;

        if (isGraphExpanded !== 'VolumeFlow') {
            // Clean up when leaving module
            const map = mapRef.current;
            [TARGET_LABEL_ID, LABEL_LAYER_ID, TARGET_LAYER_ID, HIGHLIGHT_LAYER_ID].forEach(id => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
            if (map.getSource(DEMO_SOURCE_ID)) map.removeSource(DEMO_SOURCE_ID);
            dataLoadedRef.current = false;
            setVolumeFlowSegment(null);
            return;
        }

        const map = mapRef.current;

        // Auto-select Zurich canton when entering module
        setClickedCanton('Zurich');

        if (!dataLoadedRef.current) {
            // Load spider JSON and Zurich network in parallel
            Promise.all([
                fetch(SPIDER_URL).then(r => r.json()),
                fetch(NETWORK_URL).then(r => r.json())
            ]).then(([spider, network]) => {
                const { total_trips, links: spiderLinks } = spider;
                spiderRef.current = spider;

                // Build lookup map from spider link IDs to percentages
                const spiderMap = new Map(Object.entries(spiderLinks));
                spiderMapRef.current = spiderMap;

                // Filter network features to those in the spider and enrich with flow
                const enrichedFeatures = [];
                let featureIdx = 0;

                for (const feature of network.features) {
                    const keys = (feature.properties.per_id_keys || '').split('|');
                    const isTarget = keys.includes(TARGET_LINK);

                    // Find max flow percentage across all link IDs in this segment
                    let maxPct = 0;
                    for (const key of keys) {
                        const pct = spiderMap.get(key);
                        if (pct !== undefined && pct > maxPct) maxPct = pct;
                    }

                    if (maxPct > 0 || isTarget) {
                        enrichedFeatures.push({
                            ...feature,
                            id: featureIdx,
                            properties: {
                                ...feature.properties,
                                spider_flow: Math.round(maxPct * total_trips),
                                isTarget: isTarget || undefined,
                                featureIndex: featureIdx
                            }
                        });
                        featureIdx++;
                    }
                }

                enrichedRef.current = enrichedFeatures;

                const geojson = { type: 'FeatureCollection', features: enrichedFeatures };

                if (map.getSource(DEMO_SOURCE_ID)) return;

                map.addSource(DEMO_SOURCE_ID, { type: 'geojson', data: geojson });

                // Highlight layer - orange flow lines, hidden by default
                map.addLayer({
                    id: HIGHLIGHT_LAYER_ID,
                    type: 'line',
                    source: DEMO_SOURCE_ID,
                    paint: {
                        'line-color': '#ff8c00',
                        'line-width': ['interpolate', ['linear'], ['get', 'spider_flow'],
                            0, 0,
                            1, 1,
                            10, 3,
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

                // Volume labels - hidden by default, visible at zoom 15+
                map.addLayer({
                    id: LABEL_LAYER_ID,
                    type: 'symbol',
                    source: DEMO_SOURCE_ID,
                    minzoom: 15,
                    layout: {
                        'symbol-placement': 'line-center',
                        'text-field': ['to-string', ['get', 'spider_flow']],
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

                // Target link label - visible at zoom 15+
                map.addLayer({
                    id: TARGET_LABEL_ID,
                    type: 'symbol',
                    source: DEMO_SOURCE_ID,
                    minzoom: 15,
                    layout: {
                        'symbol-placement': 'line-center',
                        'text-field': TARGET_LINK,
                        'text-size': 14,
                        'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                        'text-allow-overlap': true,
                        'text-ignore-placement': true
                    },
                    paint: {
                        'text-color': '#1a73e8',
                        'text-halo-color': '#fff',
                        'text-halo-width': 2
                    },
                    filter: ['==', ['get', 'isTarget'], true]
                });

                dataLoadedRef.current = true;

                // Zoom to target link area in Zurich
                map.flyTo({
                    center: [8.617, 47.411],
                    zoom: 14,
                    duration: 1500
                });
            }).catch(err => console.error('Failed to load volume flow data:', err));
        }

        // Click handler for target link
        const handleClick = (e) => {
            if (!map.getLayer(TARGET_LAYER_ID)) return;

            const features = map.queryRenderedFeatures(e.point, { layers: [TARGET_LAYER_ID] });

            if (features.length > 0) {
                const feature = features[0];
                const spider = spiderRef.current;
                const spiderMap = spiderMapRef.current;
                const enrichedFeatures = enrichedRef.current;
                const totalTrips = spider?.total_trips || 726;

                // Scale target link width based on total trips
                let targetWidth = 8;
                if (totalTrips >= 700) targetWidth = 16;
                else if (totalTrips >= 500) targetWidth = 12 + (totalTrips - 500) / 200 * 4;
                else if (totalTrips >= 300) targetWidth = 8 + (totalTrips - 300) / 200 * 4;
                else if (totalTrips >= 150) targetWidth = 5 + (totalTrips - 150) / 150 * 3;
                else if (totalTrips >= 50) targetWidth = 3 + (totalTrips - 50) / 100 * 2;
                else targetWidth = totalTrips / 50 * 3;
                map.setPaintProperty(TARGET_LAYER_ID, 'line-width', targetWidth);

                // Show all non-target links with flow > 0
                const flowFilter = ['all',
                    ['!=', ['get', 'isTarget'], true],
                    ['>', ['get', 'spider_flow'], 0]
                ];
                map.setFilter(HIGHLIGHT_LAYER_ID, flowFilter);
                map.setFilter(LABEL_LAYER_ID, flowFilter);

                // Build table rows from enriched features for FeatureTable
                const tableRows = [];
                let rowIdx = 0;

                if (enrichedFeatures && spiderMap) {
                    for (const ef of enrichedFeatures) {
                        if (ef.properties.isTarget) continue;

                        const keys = (ef.properties.per_id_keys || '').split('|');
                        const g = ef.geometry;
                        const coords = g?.type === 'LineString'
                            ? g.coordinates
                            : g?.type === 'MultiLineString'
                                ? g.coordinates.flat()
                                : null;

                        for (const key of keys) {
                            const pct = spiderMap.get(key);
                            if (pct !== undefined && pct > 0) {
                                tableRows.push({
                                    rowKey: `vf-${rowIdx}`,
                                    tableId: rowIdx,
                                    directionId: key,
                                    flow: Math.round(pct * totalTrips),
                                    coords,
                                    feature: ef,
                                    featureProps: ef.properties
                                });
                                rowIdx++;
                            }
                        }
                    }
                }

                // Sort by flow descending
                tableRows.sort((a, b) => b.flow - a.flow);

                setVolumeFlowSegment({
                    targetLink: TARGET_LINK,
                    totalTrips,
                    dailyAvgVolume: feature.properties.daily_avg_volume,
                    modes: feature.properties.modes,
                    tableRows
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

// Kept for API compatibility - no direction toggle needed for bidirectional spider
export function updateFlowVisualization() {}
