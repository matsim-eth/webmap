import { useEffect, useRef, useCallback } from 'react';
import { useModule } from '../../context/ModuleContext';
import { useSelection } from '../../context/SelectionContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { handle401 } from '../../utils/auth';
import bboxCache from '../../utils/bboxCanton.json';
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';

const NETWORK_SOURCE_ID = 'zone-flows-network';
const NETWORK_LAYER_ID = 'zone-flows-network-base';
const FLOW_LAYER_ID = 'zone-flows-flow';
const FLOW_LABEL_LAYER_ID = 'zone-flows-flow-labels';

const MODULE_LAYERS = [FLOW_LABEL_LAYER_ID, FLOW_LAYER_ID, NETWORK_LAYER_ID];
const MODULE_SOURCES = [NETWORK_SOURCE_ID];

const unionBbox = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
    ];
};

export default function useZoneFlowLayers({ mapRef, mapReady, loadWithFallback, fileMapSize, setIsLoading }) {
    const { isGraphExpanded } = useModule();
    const { clickedCanton, zoneFlowDestCanton } = useSelection();
    const {
        datasetId,
        zoneFlowData,
        setZoneFlowData,
        setZoneFlowLoading,
    } = useData();
    const { zoneFlowDirection, timeRange } = useFilters();

    const zoneFlowOriginCanton = isGraphExpanded === 'ZoneFlows' ? clickedCanton : null;

    // Cache loaded canton networks: { [cantonName]: featureCollection }
    const networkCacheRef = useRef({});
    // Invalidate cache when fileMap changes so uploaded files take effect
    const fileMapSizeRef = useRef(fileMapSize);
    if (fileMapSizeRef.current !== fileMapSize) {
        networkCacheRef.current = {};
        fileMapSizeRef.current = fileMapSize;
    }
    // Keep latest loadWithFallback in a ref so we don't have to re-derive callbacks
    const loadRef = useRef(loadWithFallback);
    loadRef.current = loadWithFallback;
    // Combined feature collection currently loaded into the source (clean, undecorated)
    const combinedGeoRef = useRef(null);
    // Track latest zoneFlowData so renderNetwork can apply it without becoming dep-bound
    const zoneFlowDataRef = useRef(zoneFlowData);
    zoneFlowDataRef.current = zoneFlowData;
    // Track latest fetch to ignore stale responses
    const fetchTokenRef = useRef(0);
    // Loaded canton key for the current source (to avoid recompute when unchanged)
    const sourceKeyRef = useRef(null);

    const removeAll = useCallback((map) => {
        safeRemoveLayer(map, MODULE_LAYERS);
        safeRemoveSource(map, MODULE_SOURCES);
        sourceKeyRef.current = null;
        combinedGeoRef.current = null;
    }, []);

    const loadCantonNetwork = useCallback(async (canton) => {
        if (networkCacheRef.current[canton]) return networkCacheRef.current[canton];
        try {
            const geo = await loadRef.current(`matsim/${canton}_merged_segments.geojson`);
            if (!geo?.features) return null;
            networkCacheRef.current[canton] = geo;
            return geo;
        } catch (err) {
            console.warn(`Failed to load network for ${canton}`, err);
            return null;
        }
    }, []);

    const buildCombinedNetwork = useCallback(async (origin, dest) => {
        const [og, dg] = await Promise.all([
            loadCantonNetwork(origin),
            origin === dest ? Promise.resolve(null) : loadCantonNetwork(dest),
        ]);

        const features = [];
        const seen = new Set();
        const addAll = (fc) => {
            if (!fc?.features) return;
            for (const f of fc.features) {
                const key = f?.properties?.per_id_keys || '';
                if (key && seen.has(key)) continue;
                if (key) seen.add(key);
                features.push(f);
            }
        };
        addAll(og);
        addAll(dg);
        return { type: 'FeatureCollection', features };
    }, [loadCantonNetwork]);

    const fitToCantons = useCallback((map, origin, dest) => {
        const ob = bboxCache[origin];
        const db = bboxCache[dest];
        const bbox = unionBbox(ob, db);
        if (!bbox) return;
        map.fitBounds(bbox, { padding: { top: 60, bottom: 60, left: 200, right: 700 }, duration: 800, maxZoom: 11 });
    }, []);

    // Decorate combined geo with zf_flow values from a links map and push to the source
    const applyFlowsToSource = useCallback((map, linksMap) => {
        const base = combinedGeoRef.current;
        const source = map.getSource(NETWORK_SOURCE_ID);
        if (!base || !source) return;

        const decorated = base.features.map((f, idx) => {
            const keys = parsePipeList(f.properties?.per_id_keys);
            let maxFlow = 0;
            for (const k of keys) {
                const v = linksMap?.get(String(k));
                if (v !== undefined && v > maxFlow) maxFlow = v;
            }
            return {
                ...f,
                id: idx,
                properties: { ...f.properties, zf_flow: maxFlow },
            };
        });

        source.setData({ type: 'FeatureCollection', features: decorated });
    }, []);

    const ensureFlowLayers = useCallback((map) => {
        if (!map.getLayer(FLOW_LAYER_ID)) {
            map.addLayer({
                id: FLOW_LAYER_ID,
                type: 'line',
                source: NETWORK_SOURCE_ID,
                paint: {
                    'line-color': '#ff8c00',
                    'line-width': ['interpolate', ['linear'], ['get', 'zf_flow'],
                        0, 0, 1, 1, 5, 2, 25, 4, 75, 6, 200, 9, 500, 13, 1000, 18,
                    ],
                    'line-opacity': 0.9,
                },
                filter: ['>', ['get', 'zf_flow'], 0],
            });
        }
        if (!map.getLayer(FLOW_LABEL_LAYER_ID)) {
            map.addLayer({
                id: FLOW_LABEL_LAYER_ID,
                type: 'symbol',
                source: NETWORK_SOURCE_ID,
                minzoom: 15,
                layout: {
                    'symbol-placement': 'line-center',
                    'symbol-spacing': 600,
                    'text-field': ['to-string', ['get', 'zf_flow']],
                    'text-size': 11,
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                    'text-allow-overlap': true,
                    'text-ignore-placement': true,
                    'text-padding': 2,
                },
                paint: {
                    'text-color': '#fff',
                    'text-halo-color': '#ff8c00',
                    'text-halo-width': 2,
                },
                filter: ['>', ['get', 'zf_flow'], 0],
            });
        }
    }, []);

    const renderNetwork = useCallback(async (map, origin, dest) => {
        const key = `${origin}::${dest}`;
        if (sourceKeyRef.current === key && map.getSource(NETWORK_SOURCE_ID)) return;

        setIsLoading?.(true);
        const geo = await buildCombinedNetwork(origin, dest);
        if (!geo || isGraphExpanded !== 'ZoneFlows') {
            setIsLoading?.(false);
            return;
        }

        removeAll(map);
        combinedGeoRef.current = geo;

        map.addSource(NETWORK_SOURCE_ID, { type: 'geojson', data: geo, generateId: true });

        map.addLayer({
            id: NETWORK_LAYER_ID,
            type: 'line',
            source: NETWORK_SOURCE_ID,
            paint: {
                'line-color': '#aaa',
                'line-width': 2,
                'line-opacity': 0.4,
            },
            filter: ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0],
        });

        ensureFlowLayers(map);
        sourceKeyRef.current = key;

        // If flow data already arrived before the network finished loading, apply it now
        const pending = zoneFlowDataRef.current;
        if (pending?.links) {
            const linksMap = new Map();
            for (const [k, v] of Object.entries(pending.links)) linksMap.set(String(k), Number(v));
            applyFlowsToSource(map, linksMap);
        }

        fitToCantons(map, origin, dest);
        setIsLoading?.(false);
    }, [buildCombinedNetwork, removeAll, ensureFlowLayers, applyFlowsToSource, fitToCantons, isGraphExpanded, setIsLoading]);

    // ── EFFECT 1: build/clean network when module / cantons change ──
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        if (isGraphExpanded !== 'ZoneFlows') {
            removeAll(map);
            setZoneFlowData(null);
            return;
        }

        if (!zoneFlowOriginCanton || !zoneFlowDestCanton) {
            removeAll(map);
            setZoneFlowData(null);
            return;
        }

        renderNetwork(map, zoneFlowOriginCanton, zoneFlowDestCanton);
    }, [mapReady, mapRef, isGraphExpanded, zoneFlowOriginCanton, zoneFlowDestCanton, fileMapSize, renderNetwork, removeAll, setZoneFlowData]);

    // ── EFFECT 2: fetch flow data whenever inputs change ──
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        if (isGraphExpanded !== 'ZoneFlows') return;
        if (!zoneFlowOriginCanton || !zoneFlowDestCanton) {
            setZoneFlowData(null);
            return;
        }
        if (zoneFlowOriginCanton === zoneFlowDestCanton) {
            setZoneFlowData(null);
            return;
        }

        const minute_start = (timeRange?.[0] ?? 0) * 15;
        const minute_end = (timeRange?.[1] ?? 96) * 15;

        const params = new URLSearchParams({
            origin_canton: zoneFlowOriginCanton,
            destination_canton: zoneFlowDestCanton,
            direction: zoneFlowDirection,
            minute_start: String(minute_start),
            minute_end: String(minute_end),
        });

        const token = ++fetchTokenRef.current;
        setZoneFlowLoading(true);

        const fetchFlows = async () => {
            const url = `/backend/data/${datasetId}/zone_flows.json?${params.toString()}`;
            try {
                let res = await fetch(url);
                if (res.status === 401) {
                    const refreshed = await handle401();
                    if (!refreshed) return;
                    res = await fetch(url);
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (token !== fetchTokenRef.current) return;
                if (data?.error) {
                    console.warn('zone_flows error:', data.error);
                    setZoneFlowData({ ...data, links: {}, total_trips: 0 });
                } else {
                    setZoneFlowData(data);
                }
            } catch (err) {
                if (token !== fetchTokenRef.current) return;
                console.error('Failed to fetch zone_flows', err);
                setZoneFlowData(null);
            } finally {
                if (token === fetchTokenRef.current) setZoneFlowLoading(false);
            }
        };
        fetchFlows();
    }, [mapReady, mapRef, isGraphExpanded, zoneFlowOriginCanton, zoneFlowDestCanton, zoneFlowDirection, timeRange, datasetId, setZoneFlowData, setZoneFlowLoading]);

    // ── EFFECT 3: paint overlay whenever flow data or source change ──
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        if (isGraphExpanded !== 'ZoneFlows') return;
        const map = mapRef.current;
        if (!map.getSource(NETWORK_SOURCE_ID)) return;

        // Build links map (empty when no data → wipes the orange overlay)
        const linksMap = new Map();
        if (zoneFlowData?.links) {
            for (const [k, v] of Object.entries(zoneFlowData.links)) {
                linksMap.set(String(k), Number(v));
            }
        }
        applyFlowsToSource(map, linksMap);
        ensureFlowLayers(map);
    }, [zoneFlowData, mapReady, mapRef, isGraphExpanded, applyFlowsToSource, ensureFlowLayers]);

    return null;
}
