import { useEffect, useRef, useCallback } from 'react';
import { useModule } from '../../context/ModuleContext';
import { useSelection } from '../../context/SelectionContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { useDebounced } from '../../hooks/useDebounced';
import { handle401 } from '../../utils/auth';
import { safeRemoveLayer, safeRemoveSource, setFilter } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';

// Layer/source IDs
const NODES_SOURCE = 'node-flows-nodes';
const NODES_LAYER = 'node-flows-nodes-layer';
const NODES_HOVER_LAYER = 'node-flows-nodes-hover';
const OVERLAY_SOURCE = 'node-flows-overlay';
const ENTERING_LAYER = 'node-flows-entering';
const ENTERING_LABELS = 'node-flows-entering-labels';
const EXITING_LABELS = 'node-flows-exiting-labels';
const NODE_HIGHLIGHT = 'node-flows-node-highlight';
const ANT_LAYER_FROM = 'node-flows-ant-from';
const ANT_LAYER_TO = 'node-flows-ant-to';

// Reset the turning-movement overlay back to the empty state. Idempotent —
// safe to call when no overlay is currently rendered (safeRemove* no-ops on
// missing layers/sources). Used by the Reset Node sidebar button; the hook
// itself relies on the equivalent `removeOverlay` defined on its instance.
export function resetNodeFlowsOverlay(map) {
    if (!map) return;
    safeRemoveLayer(map, [
        ANT_LAYER_FROM,
        ANT_LAYER_TO,
        ENTERING_LABELS,
        EXITING_LABELS,
        ENTERING_LAYER,
        NODE_HIGHLIGHT,
    ]);
    safeRemoveSource(map, OVERLAY_SOURCE);
    if (map.getLayer('network-layer')) {
        map.setPaintProperty('network-layer', 'line-opacity', 0.4);
    }
}

// 8-color palette for up to 4-way intersection (entering + exiting)
const LINK_PALETTE = [
    '#e41a1c',
    '#377eb8',
    '#4daf4a',
    '#984ea3',
    '#ff7f00',
    '#666666',
    '#a65628',
    '#f781bf',
];

// Smooth 20-frame ant-march dasharray sequence (same as useAntPath)
const DASH_SEQ = [
    [0, 0.3, 3, 2.7], [0, 0.6, 3, 2.4], [0, 0.9, 3, 2.1], [0, 1.2, 3, 1.8],
    [0, 1.5, 3, 1.5], [0, 1.8, 3, 1.2], [0, 2.1, 3, 0.9], [0, 2.4, 3, 0.6],
    [0, 2.7, 3, 0.3], [0, 3.0, 3, 0], [0.3, 3, 2.7, 0], [0.6, 3, 2.4, 0],
    [0.9, 3, 2.1, 0], [1.2, 3, 1.8, 0], [1.5, 3, 1.5, 0], [1.8, 3, 1.2, 0],
    [2.1, 3, 0.9, 0], [2.4, 3, 0.6, 0], [2.7, 3, 0.3, 0], [3, 3, 0, 0],
];
const DASH_SEQ_REV = [...DASH_SEQ].reverse();

// Module-level cache for nodes GeoJSON so a background prefetch can populate it
// before the user ever enters NodeFlows. Keyed by `${datasetId}:${canton}`.
// Value is a Promise<geojson|null> so concurrent requests dedupe.
const nodesGeoJSONCache = new Map();

// Per-dataset warmup of backend network-XML topology cache. Keyed by datasetId.
const networkWarmupCache = new Map();

function warmNetworkTopology(datasetId) {
    if (networkWarmupCache.has(datasetId)) return networkWarmupCache.get(datasetId);
    const url = `/backend/data/${datasetId}/node_flows.json?warmup=1`;
    const p = (async () => {
        try {
            let res = await fetch(url);
            if (res.status === 401) {
                const ok = await handle401();
                if (!ok) return null;
                res = await fetch(url);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            console.warn('Network topology warmup failed:', err);
            networkWarmupCache.delete(datasetId);
            return null;
        }
    })();
    networkWarmupCache.set(datasetId, p);
    return p;
}

function fetchNodesGeoJSON(datasetId, canton) {
    const key = `${datasetId}:${canton}`;
    if (nodesGeoJSONCache.has(key)) return nodesGeoJSONCache.get(key);
    const url = `/backend/data/${datasetId}/nodes_geojson.json?canton=${encodeURIComponent(canton)}`;
    const p = (async () => {
        try {
            let res = await fetch(url);
            if (res.status === 401) {
                const ok = await handle401();
                if (!ok) return null;
                res = await fetch(url);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const geojson = await res.json();
            if (geojson.error) { console.warn('Nodes load error:', geojson.error); return null; }
            return geojson;
        } catch (err) {
            console.warn('Failed to fetch nodes GeoJSON:', err);
            nodesGeoJSONCache.delete(key);
            return null;
        }
    })();
    nodesGeoJSONCache.set(key, p);
    return p;
}

export default function useNodeFlowLayers({ mapRef, mapReady, setIsLoading }) {
    const { isGraphExpanded } = useModule();
    const { clickedCanton, hoveredMatrixCell, setHoveredMatrixCell } = useSelection();
    const { featureGeoJSON, setNodeFlowsData, datasetId } = useData();
    const { timeRange } = useFilters();

    const debouncedTimeRange = useDebounced(timeRange, 400);

    const featureGeoJSONRef = useRef(featureGeoJSON);
    featureGeoJSONRef.current = featureGeoJSON;
    const prevCantonRef = useRef(null);
    const clickHandlerRef = useRef(null);
    const hoverHandlerRef = useRef(null);
    const leaveHandlerRef = useRef(null);
    const lastNodeRef = useRef(null);
    const nodeAbortRef = useRef(null); // aborts the previous node_flows fetch
    const antIntervalRef = useRef(null);
    // Per linkId: true if the linestring's last coord is closer to the node than the first
    const coordsEndAtNodeRef = useRef({});

    // -- cleanup helpers --
    const removeAnt = (map) => {
        if (antIntervalRef.current) {
            cancelAnimationFrame(antIntervalRef.current);
            antIntervalRef.current = null;
        }
        safeRemoveLayer(map, [ANT_LAYER_FROM, ANT_LAYER_TO]);
    };

    const removeOverlay = (map) => {
        removeAnt(map);
        safeRemoveLayer(map, [ENTERING_LABELS, EXITING_LABELS, ENTERING_LAYER, NODE_HIGHLIGHT, 'node-flows-exiting']);
        safeRemoveSource(map, OVERLAY_SOURCE);
    };

    const removeNodes = (map) => {
        safeRemoveLayer(map, [NODES_HOVER_LAYER, NODES_LAYER]);
        safeRemoveSource(map, NODES_SOURCE);
    };

    const removeHandlers = (map) => {
        if (clickHandlerRef.current) {
            map.off('click', NODES_LAYER, clickHandlerRef.current);
            clickHandlerRef.current = null;
        }
        if (hoverHandlerRef.current) {
            map.off('mousemove', NODES_LAYER, hoverHandlerRef.current);
            hoverHandlerRef.current = null;
        }
        if (leaveHandlerRef.current) {
            map.off('mouseleave', NODES_LAYER, leaveHandlerRef.current);
            leaveHandlerRef.current = null;
        }
    };

    const cleanAll = (map) => {
        removeOverlay(map);
        removeHandlers(map);
        removeNodes(map);
    };

    // -- build link lookup from network GeoJSON --
    const buildLinkLookup = useCallback(() => {
        const features = featureGeoJSONRef.current?.features;
        if (!features) return new Map();
        const lookup = new Map();
        for (const f of features) {
            const keys = parsePipeList(f.properties.per_id_keys);
            const arrows = parsePipeList(f.properties.per_id_arrows);
            for (let i = 0; i < keys.length; i++) {
                lookup.set(keys[i], { feature: f, arrow: arrows[i] || '→' });
            }
        }
        return lookup;
    }, []);

    // -- render turning movement overlay for a node --
    const renderOverlay = useCallback((map, data, nodeCoord) => {
        removeOverlay(map);

        const { node_id, entering_links, exiting_links, matrix, total_movements } = data;

        // Compute total flow per entering/exiting link
        const enteringFlows = {};
        const exitingFlows = {};
        for (const fromLink of entering_links) {
            let total = 0;
            const row = matrix[fromLink] || {};
            for (const toLink of exiting_links) total += row[toLink] || 0;
            enteringFlows[fromLink] = total;
        }
        for (const toLink of exiting_links) {
            let total = 0;
            for (const fromLink of entering_links)
                total += (matrix[fromLink] || {})[toLink] || 0;
            exitingFlows[toLink] = total;
        }

        // Assign a unique color to each link from the palette
        const allLinkIds = [...entering_links, ...exiting_links];
        const linkColors = {};
        const seen = new Set();
        let colorIdx = 0;
        for (const linkId of allLinkIds) {
            if (seen.has(linkId)) continue;
            seen.add(linkId);
            linkColors[linkId] = LINK_PALETTE[colorIdx % LINK_PALETTE.length];
            colorIdx++;
        }

        // Always update sidebar data (doesn't depend on GeoJSON)
        const enteringRows = entering_links.map(linkId => ({
            linkId, flow: enteringFlows[linkId] || 0,
        })).filter(r => r.flow > 0);

        const exitingRows = exiting_links.map(linkId => ({
            linkId, flow: exitingFlows[linkId] || 0,
        })).filter(r => r.flow > 0);

        setNodeFlowsData({
            node_id, total_movements,
            entering_links: enteringRows,
            exiting_links: exitingRows,
            matrix,
            linkColors,
        });

        // Build map overlay (needs network GeoJSON)
        const linkLookup = buildLinkLookup();
        const features = [];
        let idx = 0;

        const segmentLinkCounts = new Map();

        if (linkLookup.size) {
            // Count overlapping segments + compute coordinate direction relative to node
            const endAtNode = {};
            for (const linkId of allLinkIds) {
                const entry = linkLookup.get(linkId);
                if (!entry) continue;
                const segKey = entry.feature.properties.per_id_keys;
                segmentLinkCounts.set(segKey, (segmentLinkCounts.get(segKey) || 0) + 1);
                // Check if the linestring's last coord is closer to the node than the first
                if (nodeCoord) {
                    const geom = entry.feature.geometry;
                    const coords = geom?.type === 'LineString' ? geom.coordinates
                        : geom?.type === 'MultiLineString' ? geom.coordinates.flat() : [];
                    if (coords.length >= 2) {
                        const first = coords[0];
                        const last = coords[coords.length - 1];
                        const d1 = (first[0] - nodeCoord[0]) ** 2 + (first[1] - nodeCoord[1]) ** 2;
                        const d2 = (last[0] - nodeCoord[0]) ** 2 + (last[1] - nodeCoord[1]) ** 2;
                        endAtNode[linkId] = d2 < d1; // true = last coord is near node
                    }
                }
            }
            coordsEndAtNodeRef.current = endAtNode;

            for (const linkId of entering_links) {
                const entry = linkLookup.get(linkId);
                if (!entry) continue;
                const { feature: f, arrow } = entry;
                const segKey = f.properties.per_id_keys;
                const needsOffset = segmentLinkCounts.get(segKey) > 1;
                features.push({
                    type: 'Feature', id: idx++,
                    geometry: f.geometry,
                    properties: {
                        linkId, direction: 'entering',
                        flow: enteringFlows[linkId] || 0,
                        angle: f.properties.angle || 0,
                        arrow, needsOffset,
                        color: linkColors[linkId],
                    },
                });
            }
            for (const linkId of exiting_links) {
                const entry = linkLookup.get(linkId);
                if (!entry) continue;
                const { feature: f, arrow } = entry;
                const segKey = f.properties.per_id_keys;
                const needsOffset = segmentLinkCounts.get(segKey) > 1;
                features.push({
                    type: 'Feature', id: idx++,
                    geometry: f.geometry,
                    properties: {
                        linkId, direction: 'exiting',
                        flow: exitingFlows[linkId] || 0,
                        angle: f.properties.angle || 0,
                        arrow, needsOffset,
                        color: linkColors[linkId],
                    },
                });
            }
        }

        // Highlighted node point
        if (nodeCoord) {
            features.push({
                type: 'Feature', id: idx++,
                geometry: { type: 'Point', coordinates: nodeCoord },
                properties: { direction: 'node', node_id, flow: 0, linkId: '__node__' },
            });
        }

        if (!features.length) return;

        map.addSource(OVERLAY_SOURCE, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features },
        });

        // Angle-based flip (same as road volumes)
        const isWestish = ['any', ['>', ['get', 'angle'], 90], ['<=', ['get', 'angle'], -90]];
        const lineOffsetPx = 4;

        const lineOffset = ['case',
            ['!', ['get', 'needsOffset']], 0,
            ['==', ['get', 'arrow'], '\u2192'],
                ['case', isWestish, -lineOffsetPx, lineOffsetPx],
            ['case', isWestish, lineOffsetPx, -lineOffsetPx],
        ];

        const lineWidth = 5;

        map.addLayer({
            id: ENTERING_LAYER, type: 'line', source: OVERLAY_SOURCE,
            filter: ['!=', ['get', 'direction'], 'node'],
            paint: {
                'line-color': ['get', 'color'],
                'line-width': lineWidth,
                'line-opacity': 0.85,
                'line-offset': lineOffset,
            },
        });

        const labelOffsetNormal = 1;
        const labelOffsetWide = 1.6;

        map.addLayer({
            id: ENTERING_LABELS, type: 'symbol', source: OVERLAY_SOURCE,
            filter: ['all', ['!=', ['get', 'direction'], 'node'], ['==', ['get', 'arrow'], '\u2192']],
            minzoom: 14,
            layout: {
                'symbol-placement': 'line-center',
                'symbol-spacing': 9999999,
                'text-keep-upright': true,
                'text-field': ['concat', ['get', 'linkId'], ' \u2192'],
                'text-size': 11,
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-offset': [0, ['case',
                    ['get', 'needsOffset'],
                        ['case', isWestish, -labelOffsetWide, labelOffsetWide],
                    ['case', isWestish, -labelOffsetNormal, labelOffsetNormal],
                ]],
                'text-allow-overlap': true,
            },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
        });

        map.addLayer({
            id: EXITING_LABELS, type: 'symbol', source: OVERLAY_SOURCE,
            filter: ['all', ['!=', ['get', 'direction'], 'node'], ['==', ['get', 'arrow'], '\u2190']],
            minzoom: 14,
            layout: {
                'symbol-placement': 'line-center',
                'symbol-spacing': 9999999,
                'text-keep-upright': true,
                'text-field': ['concat', '\u2190 ', ['get', 'linkId']],
                'text-size': 11,
                'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                'text-offset': [0, ['case',
                    ['get', 'needsOffset'],
                        ['case', isWestish, labelOffsetWide, -labelOffsetWide],
                    ['case', isWestish, labelOffsetNormal, -labelOffsetNormal],
                ]],
                'text-allow-overlap': true,
            },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
        });

        map.addLayer({
            id: NODE_HIGHLIGHT, type: 'circle', source: OVERLAY_SOURCE,
            filter: ['==', ['get', 'direction'], 'node'],
            paint: {
                'circle-radius': 9,
                'circle-color': '#7c4dff',
                'circle-stroke-color': '#fff',
                'circle-stroke-width': 2.5,
                'circle-opacity': 0.95,
            },
        });

        if (map.getLayer('network-layer'))
            map.setPaintProperty('network-layer', 'line-opacity', 0.15);
    }, [buildLinkLookup, setNodeFlowsData]);

    // -- hover effect: dim other links + ant-march on hovered pair --
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        if (!map.getLayer(ENTERING_LAYER) || !map.getSource(OVERLAY_SOURCE)) return;

        if (!hoveredMatrixCell) {
            // Restore full opacity
            map.setPaintProperty(ENTERING_LAYER, 'line-opacity', 0.85);
            if (map.getLayer(ENTERING_LABELS))
                map.setPaintProperty(ENTERING_LABELS, 'text-opacity', 1);
            if (map.getLayer(EXITING_LABELS))
                map.setPaintProperty(EXITING_LABELS, 'text-opacity', 1);
            removeAnt(map);
            return;
        }

        const { from, to } = hoveredMatrixCell;
        const fromStr = String(from);
        const toStr = String(to);

        // Dim non-hovered links
        map.setPaintProperty(ENTERING_LAYER, 'line-opacity', [
            'case',
            ['any',
                ['==', ['get', 'linkId'], fromStr],
                ['==', ['get', 'linkId'], toStr],
            ], 0.9,
            0.15,
        ]);

        const labelOpacity = [
            'case',
            ['any',
                ['==', ['get', 'linkId'], fromStr],
                ['==', ['get', 'linkId'], toStr],
            ], 1,
            0.2,
        ];
        if (map.getLayer(ENTERING_LABELS))
            map.setPaintProperty(ENTERING_LABELS, 'text-opacity', labelOpacity);
        if (map.getLayer(EXITING_LABELS))
            map.setPaintProperty(EXITING_LABELS, 'text-opacity', labelOpacity);

        // Two ant-march layers (one per link) on OVERLAY_SOURCE so they inherit the
        // same geometry + offset. Each uses the correct dash direction based on arrow.
        removeAnt(map);

        const isWestish = ['any', ['>', ['get', 'angle'], 90], ['<=', ['get', 'angle'], -90]];
        const lineOffsetPx = 4;
        const lineOffset = ['case',
            ['!', ['get', 'needsOffset']], 0,
            ['==', ['get', 'arrow'], '\u2192'],
                ['case', isWestish, -lineOffsetPx, lineOffsetPx],
            ['case', isWestish, lineOffsetPx, -lineOffsetPx],
        ];

        const antPaint = {
            'line-color': '#ffffff',
            'line-width': 2.5,
            'line-opacity': 0.85,
            'line-dasharray': [3, 3],
            'line-offset': lineOffset,
        };

        // Pick dash direction per link based on coordinate order relative to node:
        // "from" (entering) link: ant should march TOWARD the node
        //   - coords end at node → forward dashes go toward node ✓
        //   - coords start at node → reversed dashes go toward node ✓
        // "to" (exiting) link: ant should march AWAY from the node
        //   - coords end at node → reversed dashes go away from node ✓
        //   - coords start at node → forward dashes go away from node ✓
        const endAt = coordsEndAtNodeRef.current;
        const fromSeq = endAt[fromStr] ? DASH_SEQ : DASH_SEQ_REV;   // entering: forward if ends at node
        const toSeq = endAt[toStr] ? DASH_SEQ_REV : DASH_SEQ;       // exiting: reverse if ends at node

        const antLayers = [
            { id: ANT_LAYER_FROM, linkId: fromStr, seq: fromSeq },
            { id: ANT_LAYER_TO, linkId: toStr, seq: toSeq },
        ];

        for (const ant of antLayers) {
            map.addLayer({
                id: ant.id, type: 'line', source: OVERLAY_SOURCE,
                filter: ['==', ['get', 'linkId'], ant.linkId],
                paint: { ...antPaint },
            }, NODE_HIGHLIGHT);
        }

        // Smooth requestAnimationFrame animation (same as useAntPath)
        let idx = 0;
        let last = 0;
        const frameIntervalMs = 50;

        function animate(ts) {
            if (!map.getLayer(ANT_LAYER_FROM) && !map.getLayer(ANT_LAYER_TO)) return;
            if (ts - last >= frameIntervalMs) {
                idx = idx + 1;
                for (const ant of antLayers) {
                    if (map.getLayer(ant.id)) {
                        map.setPaintProperty(ant.id, 'line-dasharray', ant.seq[idx % ant.seq.length]);
                    }
                }
                last = ts;
            }
            antIntervalRef.current = requestAnimationFrame(animate);
        }
        antIntervalRef.current = requestAnimationFrame(animate);

        return () => removeAnt(map);
    }, [mapReady, mapRef, hoveredMatrixCell]);

    // -- fetch node flows from backend --
    const fetchNodeFlows = useCallback(async (nodeId) => {
        // Cancel the previous node's (heavy) flow query so clicking through
        // several nodes doesn't stack concurrent scans on the backend.
        if (nodeAbortRef.current) nodeAbortRef.current.abort();
        const abort = new AbortController();
        nodeAbortRef.current = abort;
        const minuteStart = (debouncedTimeRange?.[0] ?? 0) * 15;
        const minuteEnd = (debouncedTimeRange?.[1] ?? 96) * 15;
        const url = `/backend/data/${datasetId}/node_flows.json?node_id=${nodeId}&minute_start=${minuteStart}&minute_end=${minuteEnd}`;
        try {
            let res = await fetch(url, { signal: abort.signal });
            if (res.status === 401) {
                const refreshed = await handle401();
                if (!refreshed) return null;
                res = await fetch(url, { signal: abort.signal });
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) { console.warn('Node flows error:', data.error); return null; }
            return data;
        } catch (err) {
            if (err?.name === 'AbortError') return null;
            console.error('Failed to fetch node flows:', err); return null;
        }
    }, [datasetId, debouncedTimeRange]);

    // -- load nodes GeoJSON for a canton --
    const loadNodes = useCallback(async (map, canton) => {
        removeNodes(map);
        console.log('[NodeFlows] Loading nodes for canton:', canton);
        const geojson = await fetchNodesGeoJSON(datasetId, canton);
        if (!geojson) return;
        console.log('[NodeFlows] Loaded', geojson.features?.length, 'nodes');
        try {

            map.addSource(NODES_SOURCE, { type: 'geojson', data: geojson });

            map.addLayer({
                id: NODES_LAYER, type: 'circle', source: NODES_SOURCE,
                minzoom: 11,
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1, 13, 2, 16, 5, 18, 7],
                    'circle-color': '#7c4dff',
                    'circle-opacity': 0.6,
                    'circle-stroke-color': '#fff',
                    'circle-stroke-width': 0.5,
                },
            });

            map.addLayer({
                id: NODES_HOVER_LAYER, type: 'circle', source: NODES_SOURCE,
                minzoom: 11,
                paint: {
                    'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 13, 4, 16, 7, 18, 10],
                    'circle-color': '#7c4dff',
                    'circle-opacity': 0.9,
                    'circle-stroke-color': '#fff',
                    'circle-stroke-width': 2,
                },
                filter: ['==', ['get', 'id'], ''],
            });

        } catch (err) { console.warn('Failed to load nodes GeoJSON:', err); }
    }, [datasetId]);

    // Background prefetch: warm the nodes GeoJSON cache as soon as a canton is
    // selected, regardless of active module, so entering NodeFlows is instant.
    useEffect(() => {
        if (!datasetId || !clickedCanton) return;
        fetchNodesGeoJSON(datasetId, clickedCanton);
        warmNetworkTopology(datasetId);
    }, [datasetId, clickedCanton]);

    // -- main effect --
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;
        let cancelled = false;

        if (clickedCanton !== prevCantonRef.current) {
            prevCantonRef.current = clickedCanton;
            lastNodeRef.current = null;
            cleanAll(map);
            setNodeFlowsData(null);
            setHoveredMatrixCell(null);
        }

        if (isGraphExpanded !== 'NodeFlows') {
            cleanAll(map);
            lastNodeRef.current = null;
            setNodeFlowsData(null);
            setHoveredMatrixCell(null);
            return;
        }

        if (map.getLayer('network-layer'))
            map.setPaintProperty('network-layer', 'line-opacity', 0.4);

        const vfFilter = ['all',
            ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0],
            ['>', ['get', 'daily_avg_volume'], 0],
        ];
        setFilter(map, ['network-layer', 'click-network-layer'], vfFilter);

        if (!clickedCanton) return;

        const attachHandlers = () => {
            removeHandlers(map);

            const onHover = (e) => {
                if (!e.features?.length) return;
                map.getCanvas().style.cursor = 'pointer';
                const nodeId = e.features[0].properties.id;
                if (map.getLayer(NODES_HOVER_LAYER))
                    map.setFilter(NODES_HOVER_LAYER, ['==', ['get', 'id'], nodeId]);
            };
            const onLeave = () => {
                map.getCanvas().style.cursor = '';
                if (map.getLayer(NODES_HOVER_LAYER))
                    map.setFilter(NODES_HOVER_LAYER, ['==', ['get', 'id'], '']);
            };
            const onClick = async (e) => {
                if (!e.features?.length) return;
                const feat = e.features[0];
                const nodeId = feat.properties.id;
                const coords = feat.geometry.coordinates;
                console.log('[NodeFlows] Clicked node:', nodeId, coords);
                lastNodeRef.current = { nodeId, coords };

                setIsLoading?.(true);
                let data;
                try {
                    data = await fetchNodeFlows(nodeId);
                } finally {
                    setIsLoading?.(false);
                }
                console.log('[NodeFlows] Received data:', data);
                if (!cancelled && data) {
                    renderOverlay(map, data, coords);
                }
            };

            map.on('mousemove', NODES_LAYER, onHover);
            map.on('mouseleave', NODES_LAYER, onLeave);
            map.on('click', NODES_LAYER, onClick);
            hoverHandlerRef.current = onHover;
            leaveHandlerRef.current = onLeave;
            clickHandlerRef.current = onClick;
            console.log('[NodeFlows] Handlers attached');
        };

        const setup = async () => {
            if (!map.getSource(NODES_SOURCE)) {
                await loadNodes(map, clickedCanton);
            }
            if (cancelled) return;

            if (map.getLayer(NODES_LAYER)) {
                attachHandlers();
            }

            if (lastNodeRef.current && featureGeoJSONRef.current) {
                const { nodeId, coords } = lastNodeRef.current;
                const data = await fetchNodeFlows(nodeId);
                if (!cancelled && data) renderOverlay(map, data, coords);
            }
        };

        setup();

        return () => {
            cancelled = true;
            removeHandlers(map);
        };
    }, [mapReady, isGraphExpanded, clickedCanton, featureGeoJSON, mapRef,
        setNodeFlowsData, setHoveredMatrixCell, loadNodes, fetchNodeFlows, renderOverlay]);

    return null;
}
