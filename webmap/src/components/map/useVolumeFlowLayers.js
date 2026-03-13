import { useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';
import { DATASET_ID } from '../../config';

const SOURCE_ID = 'volume-flow-source';
const BASE_LAYER_ID = 'volume-flow-base';
const HIGHLIGHT_LAYER_ID = 'volume-flow-highlight';
const LABEL_LAYER_ID = 'volume-flow-labels';
const TARGET_LAYER_ID = 'volume-flow-target';
const TARGET_LABEL_ID = 'volume-flow-target-label';

export default function useVolumeFlowLayers({ mapRef, mapReady }) {
    const {
        isGraphExpanded,
        clickedCanton,
        setVolumeFlowSegment,
    } = useApp();

    const loadWithFallback = useLoadWithFallback();
    const loadRef = useRef(loadWithFallback);
    loadRef.current = loadWithFallback;

    const networkFeaturesRef = useRef(null);
    const loadedCantonRef = useRef(null);
    const clickHandlerRef = useRef(null);
    const mouseEnterRef = useRef(null);
    const mouseLeaveRef = useRef(null);

    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        // --- Cleanup helper ---
        const removeAll = () => {
            [TARGET_LABEL_ID, LABEL_LAYER_ID, TARGET_LAYER_ID, HIGHLIGHT_LAYER_ID, BASE_LAYER_ID].forEach(id => {
                if (map.getLayer(id)) map.removeLayer(id);
            });
            if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
            if (clickHandlerRef.current) {
                map.off('click', BASE_LAYER_ID, clickHandlerRef.current);
                clickHandlerRef.current = null;
            }
            if (mouseEnterRef.current) {
                map.off('mouseenter', BASE_LAYER_ID, mouseEnterRef.current);
                mouseEnterRef.current = null;
            }
            if (mouseLeaveRef.current) {
                map.off('mouseleave', BASE_LAYER_ID, mouseLeaveRef.current);
                mouseLeaveRef.current = null;
            }
            networkFeaturesRef.current = null;
            loadedCantonRef.current = null;
        };

        // --- Not in VolumeFlow mode → tear down ---
        if (isGraphExpanded !== 'VolumeFlow') {
            removeAll();
            setVolumeFlowSegment(null);
            return;
        }

        // Nothing to load without a canton
        if (!clickedCanton) return;

        // Already loaded for this canton
        if (loadedCantonRef.current === clickedCanton && map.getSource(SOURCE_ID)) return;

        // Canton changed — clean previous
        removeAll();

        let cancelled = false;
        const cantonName = clickedCanton;

        loadRef.current(`matsim/${cantonName}_merged_segments.geojson`).then(network => {
            if (cancelled || !network?.features) return;

            // Index every feature with default spider props
            const features = network.features.map((f, i) => ({
                ...f,
                id: i,
                properties: {
                    ...f.properties,
                    featureIndex: i,
                    spider_flow: 0,
                    isTarget: false,
                }
            }));

            networkFeaturesRef.current = features;
            loadedCantonRef.current = cantonName;

            map.addSource(SOURCE_ID, {
                type: 'geojson',
                data: { type: 'FeatureCollection', features }
            });

            // Base layer — all links, thin / subtle
            map.addLayer({
                id: BASE_LAYER_ID,
                type: 'line',
                source: SOURCE_ID,
                paint: {
                    'line-color': '#888',
                    'line-width': 1.5,
                    'line-opacity': 0.4
                }
            });

            // Highlight layer — orange spider flow (hidden until click)
            map.addLayer({
                id: HIGHLIGHT_LAYER_ID,
                type: 'line',
                source: SOURCE_ID,
                paint: {
                    'line-color': '#ff8c00',
                    'line-width': ['interpolate', ['linear'], ['get', 'spider_flow'],
                        0, 0, 1, 1, 10, 3, 150, 5, 300, 8, 500, 12, 700, 16
                    ],
                    'line-opacity': 0.85
                },
                filter: ['==', ['get', 'featureIndex'], -1]
            });

            // Target link — blue (hidden until click)
            map.addLayer({
                id: TARGET_LAYER_ID,
                type: 'line',
                source: SOURCE_ID,
                paint: {
                    'line-color': '#1a73e8',
                    'line-width': 8,
                    'line-opacity': 1
                },
                filter: ['==', ['get', 'featureIndex'], -1]
            });

            // Volume labels (zoom 15+, hidden until click)
            map.addLayer({
                id: LABEL_LAYER_ID,
                type: 'symbol',
                source: SOURCE_ID,
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
                filter: ['==', ['get', 'featureIndex'], -1]
            });

            // Target label (zoom 15+, hidden until click)
            map.addLayer({
                id: TARGET_LABEL_ID,
                type: 'symbol',
                source: SOURCE_ID,
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
                filter: ['==', ['get', 'featureIndex'], -1]
            });

            // --- Click any link → fetch spider data ---
            const handleClick = async (e) => {
                const clicked = map.queryRenderedFeatures(e.point, { layers: [BASE_LAYER_ID] });
                if (!clicked.length) return;

                const feature = clicked[0];
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

                    // Enrich every network feature with spider flow
                    const enriched = networkFeaturesRef.current.map((f, i) => {
                        const fKeys = (f.properties.per_id_keys || '').split('|');
                        const isTarget = fKeys.some(k => keys.includes(k));

                        let maxFlow = 0;
                        for (const k of fKeys) {
                            const vol = spiderMap.get(k);
                            if (vol !== undefined && vol > maxFlow) maxFlow = vol;
                        }

                        return {
                            ...f,
                            id: i,
                            properties: {
                                ...f.properties,
                                spider_flow: maxFlow,
                                isTarget: isTarget || undefined,
                                targetLinkId: isTarget ? linkId : undefined,
                                featureIndex: i
                            }
                        };
                    });

                    // Push enriched data into the source
                    const src = map.getSource(SOURCE_ID);
                    if (src) src.setData({ type: 'FeatureCollection', features: enriched });

                    // Scale target width by trip count
                    let tw = 8;
                    if (total_trips >= 700) tw = 16;
                    else if (total_trips >= 500) tw = 12 + (total_trips - 500) / 200 * 4;
                    else if (total_trips >= 300) tw = 8 + (total_trips - 300) / 200 * 4;
                    else if (total_trips >= 150) tw = 5 + (total_trips - 150) / 150 * 3;
                    else if (total_trips >= 50) tw = 3 + (total_trips - 50) / 100 * 2;
                    else tw = Math.max(3, total_trips / 50 * 3);
                    map.setPaintProperty(TARGET_LAYER_ID, 'line-width', tw);

                    // Show target + highlight layers
                    map.setFilter(TARGET_LAYER_ID, ['==', ['get', 'isTarget'], true]);
                    map.setFilter(TARGET_LABEL_ID, ['==', ['get', 'isTarget'], true]);

                    const flowFilter = ['all',
                        ['!=', ['get', 'isTarget'], true],
                        ['>', ['get', 'spider_flow'], 0]
                    ];
                    map.setFilter(HIGHLIGHT_LAYER_ID, flowFilter);
                    map.setFilter(LABEL_LAYER_ID, flowFilter);

                    // Build table rows
                    const tableRows = [];
                    let rowIdx = 0;
                    for (const ef of enriched) {
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

            map.on('click', BASE_LAYER_ID, handleClick);
            clickHandlerRef.current = handleClick;

            const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
            const onLeave = () => { map.getCanvas().style.cursor = ''; };
            map.on('mouseenter', BASE_LAYER_ID, onEnter);
            map.on('mouseleave', BASE_LAYER_ID, onLeave);
            mouseEnterRef.current = onEnter;
            mouseLeaveRef.current = onLeave;

        }).catch(err => console.error('Failed to load network data:', err));

        return () => { cancelled = true; };
    }, [mapReady, isGraphExpanded, clickedCanton, mapRef, setVolumeFlowSegment]);

    return null;
}

export function updateFlowVisualization() {}
