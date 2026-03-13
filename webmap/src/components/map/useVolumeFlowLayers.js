import { useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { DATASET_ID } from '../../config';

// Spider overlay source + layers (separate from the shared network-source)
const SPIDER_SOURCE_ID = 'volume-flow-spider';
const HIGHLIGHT_LAYER_ID = 'volume-flow-highlight';
const LABEL_LAYER_ID = 'volume-flow-labels';
const TARGET_LAYER_ID = 'volume-flow-target';
const TARGET_LABEL_ID = 'volume-flow-target-label';

// Layer from useNetworkLayers that we attach our click handler to
const NETWORK_CLICK_LAYER = 'click-network-layer';

export default function useVolumeFlowLayers({ mapRef, mapReady }) {
    const {
        isGraphExpanded,
        featureGeoJSON,
        setVolumeFlowSegment,
    } = useApp();

    const clickHandlerRef = useRef(null);

    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        // --- Cleanup helper: only removes spider overlay, not the shared network ---
        const removeSpider = () => {
            [TARGET_LABEL_ID, LABEL_LAYER_ID, TARGET_LAYER_ID, HIGHLIGHT_LAYER_ID].forEach(id => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
            if (map.getSource(SPIDER_SOURCE_ID)) map.removeSource(SPIDER_SOURCE_ID);
            if (clickHandlerRef.current) {
                map.off('click', NETWORK_CLICK_LAYER, clickHandlerRef.current);
                clickHandlerRef.current = null;
            }
        };

        // --- Not in VolumeFlow mode → tear down spider overlay ---
        if (isGraphExpanded !== 'VolumeFlow') {
            removeSpider();
            setVolumeFlowSegment(null);
            return;
        }

        // Network not loaded yet (useNetworkLayers hasn't finished)
        if (!featureGeoJSON?.features || !map.getLayer(NETWORK_CLICK_LAYER)) return;

        // Already set up
        if (clickHandlerRef.current) return;

        // --- Click handler: any link on the shared network layer ---
        const handleClick = async (e) => {
            if (!e.features?.length) return;

            const feature = e.features[0];
            const keys = (feature.properties.per_id_keys || '').split('|').filter(Boolean);
            if (!keys.length) return;

            const linkId = keys[0];

            try {
                const res = await fetch(`/backend/data/${DATASET_ID}/spider_bothflow.json?link_id=${linkId}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const spider = await res.json();
                if (spider.error) {
                    console.warn('Spider query error:', spider.error);
                    return;
                }

                const { total_trips, links: spiderLinks } = spider;
                const spiderMap = new Map(Object.entries(spiderLinks));

                // Build spider overlay features from the shared network GeoJSON
                const spiderFeatures = [];
                let idx = 0;

                for (const f of featureGeoJSON.features) {
                    const fKeys = (f.properties.per_id_keys || '').split('|');
                    const isTarget = fKeys.some(k => keys.includes(k));

                    let maxFlow = 0;
                    for (const k of fKeys) {
                        const vol = spiderMap.get(k);
                        if (vol !== undefined && vol > maxFlow) maxFlow = vol;
                    }

                    if (maxFlow > 0 || isTarget) {
                        spiderFeatures.push({
                            ...f,
                            id: idx,
                            properties: {
                                ...f.properties,
                                spider_flow: maxFlow,
                                isTarget: isTarget || undefined,
                                targetLinkId: isTarget ? linkId : undefined,
                                featureIndex: idx,
                            }
                        });
                        idx++;
                    }
                }

                const spiderGeoJSON = { type: 'FeatureCollection', features: spiderFeatures };

                // Create or update the spider source
                const existingSrc = map.getSource(SPIDER_SOURCE_ID);
                if (existingSrc) {
                    existingSrc.setData(spiderGeoJSON);
                } else {
                    map.addSource(SPIDER_SOURCE_ID, { type: 'geojson', data: spiderGeoJSON });

                    // Highlight layer — orange spider flow
                    map.addLayer({
                        id: HIGHLIGHT_LAYER_ID,
                        type: 'line',
                        source: SPIDER_SOURCE_ID,
                        paint: {
                            'line-color': '#ff8c00',
                            'line-width': ['interpolate', ['linear'], ['get', 'spider_flow'],
                                0, 0, 1, 1, 10, 3, 150, 5, 300, 8, 500, 12, 700, 16
                            ],
                            'line-opacity': 0.85
                        },
                        filter: ['all',
                            ['!=', ['get', 'isTarget'], true],
                            ['>', ['get', 'spider_flow'], 0]
                        ]
                    });

                    // Target link — blue
                    map.addLayer({
                        id: TARGET_LAYER_ID,
                        type: 'line',
                        source: SPIDER_SOURCE_ID,
                        paint: {
                            'line-color': '#1a73e8',
                            'line-width': 8,
                            'line-opacity': 1
                        },
                        filter: ['==', ['get', 'isTarget'], true]
                    });

                    // Volume labels (zoom 15+)
                    map.addLayer({
                        id: LABEL_LAYER_ID,
                        type: 'symbol',
                        source: SPIDER_SOURCE_ID,
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
                        filter: ['all',
                            ['!=', ['get', 'isTarget'], true],
                            ['>', ['get', 'spider_flow'], 0]
                        ]
                    });

                    // Target label (zoom 15+)
                    map.addLayer({
                        id: TARGET_LABEL_ID,
                        type: 'symbol',
                        source: SPIDER_SOURCE_ID,
                        minzoom: 15,
                        layout: {
                            'symbol-placement': 'line-center',
                            'text-field': ['to-string', ['get', 'targetLinkId']],
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
                }

                // Scale target width by trip count
                let tw = 8;
                if (total_trips >= 700) tw = 16;
                else if (total_trips >= 500) tw = 12 + (total_trips - 500) / 200 * 4;
                else if (total_trips >= 300) tw = 8 + (total_trips - 300) / 200 * 4;
                else if (total_trips >= 150) tw = 5 + (total_trips - 150) / 150 * 3;
                else if (total_trips >= 50) tw = 3 + (total_trips - 50) / 100 * 2;
                else tw = Math.max(3, total_trips / 50 * 3);
                map.setPaintProperty(TARGET_LAYER_ID, 'line-width', tw);

                // Fade the base network so the spider overlay stands out
                if (map.getLayer('network-layer')) {
                    map.setPaintProperty('network-layer', 'line-opacity', 0.1);
                }

                // Build table rows
                const tableRows = [];
                let rowIdx = 0;
                for (const ef of spiderFeatures) {
                    if (ef.properties.isTarget) continue;
                    const fKeys = (ef.properties.per_id_keys || '').split('|');
                    const g = ef.geometry;
                    const coords = g?.type === 'LineString'
                        ? g.coordinates
                        : g?.type === 'MultiLineString'
                            ? g.coordinates.flat()
                            : null;

                    for (const k of fKeys) {
                        const vol = spiderMap.get(k);
                        if (vol !== undefined && vol > 0) {
                            tableRows.push({
                                rowKey: `vf-${rowIdx}`,
                                tableId: rowIdx,
                                directionId: k,
                                flow: vol,
                                coords,
                                feature: ef,
                                featureProps: ef.properties
                            });
                            rowIdx++;
                        }
                    }
                }
                tableRows.sort((a, b) => b.flow - a.flow);

                setVolumeFlowSegment({
                    targetLink: linkId,
                    totalTrips: total_trips,
                    dailyAvgVolume: feature.properties.daily_avg_volume,
                    modes: feature.properties.modes,
                    tableRows
                });
            } catch (err) {
                console.error('Failed to fetch spider data:', err);
            }
        };

        map.on('click', NETWORK_CLICK_LAYER, handleClick);
        clickHandlerRef.current = handleClick;

        return () => {
            if (clickHandlerRef.current) {
                map.off('click', NETWORK_CLICK_LAYER, clickHandlerRef.current);
                clickHandlerRef.current = null;
            }
        };
    }, [mapReady, isGraphExpanded, featureGeoJSON, mapRef, setVolumeFlowSegment]);

    return null;
}

export function updateFlowVisualization() {}
