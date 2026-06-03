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
const FLOW_LAYER_ID = 'zone-flows-flow';
const FLOW_LABEL_LAYER_ID = 'zone-flows-flow-labels';

const MODULE_LAYERS = [FLOW_LABEL_LAYER_ID, FLOW_LAYER_ID];
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

const cantonKey = (cantons) => cantons.slice().sort().join('::');

// Resolve once Mapbox finishes rendering pending tile/style work — fires
// after setData uploads have been built into renderable tiles.
const waitForMapIdle = (map) => new Promise((resolve) => {
    if (!map) { resolve(); return; }
    map.once('idle', resolve);
});

const flattenLinksByCanton = (linksByCanton) => {
    const m = new Map();
    if (!linksByCanton) return m;
    for (const cantonLinks of Object.values(linksByCanton)) {
        for (const [k, v] of Object.entries(cantonLinks)) {
            m.set(String(k), Number(v));
        }
    }
    return m;
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
    // Track latest zoneFlowData so reconcileSource can apply it without becoming dep-bound
    const zoneFlowDataRef = useRef(zoneFlowData);
    zoneFlowDataRef.current = zoneFlowData;
    // Track latest fetch to ignore stale responses
    const fetchTokenRef = useRef(0);
    // Sorted-canton key for the source's current contents
    const sourceKeyRef = useRef(null);
    // Token for the most recent reconcileSource call, used to ignore stale async results
    const reconcileTokenRef = useRef(0);

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

    const fitToCantons = useCallback((map, cantons) => {
        let bbox = null;
        for (const c of cantons) bbox = unionBbox(bbox, bboxCache[c]);
        if (!bbox) return;
        map.fitBounds(bbox, { padding: { top: 60, bottom: 60, left: 200, right: 700 }, duration: 800, maxZoom: 11 });
    }, []);

    // Decorate combined geo with zf_flow values and push only the segments
    // that carry flow to the source. Mapbox tiles only what we send, so
    // dropping zero-flow features is a real perf win.
    const applyFlowsToSource = useCallback((map, linksMap) => {
        const base = combinedGeoRef.current;
        const source = map.getSource(NETWORK_SOURCE_ID);
        if (!base || !source) return;

        const decorated = [];
        if (linksMap && linksMap.size > 0) {
            for (let idx = 0; idx < base.features.length; idx++) {
                const f = base.features[idx];
                const keys = parsePipeList(f.properties?.per_id_keys);
                let maxFlow = 0;
                for (const k of keys) {
                    const v = linksMap.get(String(k));
                    if (v !== undefined && v > maxFlow) maxFlow = v;
                }
                if (maxFlow > 0) {
                    decorated.push({
                        ...f,
                        id: idx,
                        properties: { ...f.properties, zf_flow: maxFlow },
                    });
                }
            }
        }

        source.setData({ type: 'FeatureCollection', features: decorated });
    }, []);

    const ensureFlowLayers = useCallback((map) => {
        if (!map.getLayer(FLOW_LAYER_ID)) {
            map.addLayer({
                id: FLOW_LAYER_ID,
                type: 'line',
                source: NETWORK_SOURCE_ID,
                layout: {
                    'line-cap': 'round',
                    'line-join': 'round',
                },
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

    // Ensure the source contains exactly the requested set of canton networks.
    // Reuses the existing source via setData when possible; sets up source +
    // base layer + flow layers on first call.
    const reconcileSource = useCallback(async (map, cantons, { fit = false } = {}) => {
        const key = cantonKey(cantons);
        if (sourceKeyRef.current === key && map.getSource(NETWORK_SOURCE_ID)) {
            if (fit) fitToCantons(map, cantons);
            return;
        }

        const token = ++reconcileTokenRef.current;
        setIsLoading?.(true);
        const geos = await Promise.all(cantons.map(loadCantonNetwork));
        if (token !== reconcileTokenRef.current || isGraphExpanded !== 'ZoneFlows') {
            setIsLoading?.(false);
            return;
        }

        const features = [];
        const seen = new Set();
        for (const fc of geos) {
            if (!fc?.features) continue;
            for (const f of fc.features) {
                const k = f?.properties?.per_id_keys || '';
                if (k && seen.has(k)) continue;
                if (k) seen.add(k);
                features.push(f);
            }
        }
        const geo = { type: 'FeatureCollection', features };
        combinedGeoRef.current = geo;

        const existingSource = map.getSource(NETWORK_SOURCE_ID);
        if (!existingSource) {
            map.addSource(NETWORK_SOURCE_ID, {
                type: 'geojson',
                data: geo,
                generateId: true,
                // Default 0.375 simplifies short segments away at low zoom,
                // making the highlighted route look broken.
                tolerance: 0.3,
            });
            ensureFlowLayers(map);
        } else {
            existingSource.setData(geo);
        }
        sourceKeyRef.current = key;

        const pending = zoneFlowDataRef.current;
        if (pending?.links_by_canton) {
            applyFlowsToSource(map, flattenLinksByCanton(pending.links_by_canton));
        }
        if (fit) fitToCantons(map, cantons);

        await waitForMapIdle(map);
        if (token !== reconcileTokenRef.current) return;
        setIsLoading?.(false);
    }, [loadCantonNetwork, ensureFlowLayers, applyFlowsToSource, fitToCantons, isGraphExpanded, setIsLoading]);

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

        // Initial preview: load just origin + dest. Intermediate cantons are
        // added later in EFFECT 3 once the response identifies them.
        const initial = zoneFlowOriginCanton === zoneFlowDestCanton
            ? [zoneFlowOriginCanton]
            : [zoneFlowOriginCanton, zoneFlowDestCanton];
        reconcileSource(map, initial, { fit: true });
    }, [mapReady, mapRef, isGraphExpanded, zoneFlowOriginCanton, zoneFlowDestCanton, fileMapSize, reconcileSource, removeAll, setZoneFlowData]);

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

        // Abort the previous (heavy) zone_flows scan when params change, so a
        // new canton/time selection doesn't leave the old query running on the
        // backend (the token below already discards stale *results*; this also
        // stops the wasted backend work).
        const abort = new AbortController();

        const fetchFlows = async () => {
            const url = `/backend/data/${datasetId}/zone_flows.json?${params.toString()}`;
            try {
                let res = await fetch(url, { signal: abort.signal });
                if (res.status === 401) {
                    const refreshed = await handle401();
                    if (!refreshed) {
                        if (token === fetchTokenRef.current) setZoneFlowLoading(false);
                        return;
                    }
                    res = await fetch(url, { signal: abort.signal });
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (token !== fetchTokenRef.current) return;
                if (data?.error) {
                    console.warn('zone_flows error:', data.error);
                    setZoneFlowData({ ...data, links_by_canton: {}, total_trips: 0 });
                } else {
                    setZoneFlowData(data);
                }
                // Loading stays true here — EFFECT 3 clears it once the map idles.
            } catch (err) {
                if (err?.name === 'AbortError') return;
                if (token !== fetchTokenRef.current) return;
                console.error('Failed to fetch zone_flows', err);
                setZoneFlowData(null);
                setZoneFlowLoading(false);
            }
        };
        fetchFlows();
        return () => abort.abort();
    }, [mapReady, mapRef, isGraphExpanded, zoneFlowOriginCanton, zoneFlowDestCanton, zoneFlowDirection, timeRange, datasetId, setZoneFlowData, setZoneFlowLoading]);

    // ── EFFECT 3: paint overlay whenever flow data changes ──
    // If the response references cantons not in the source yet (intermediate
    // cantons along the route), expand the source to include them.
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        if (isGraphExpanded !== 'ZoneFlows') return;
        const map = mapRef.current;
        if (!map.getSource(NETWORK_SOURCE_ID)) return;

        const cantonsInResp = zoneFlowData?.links_by_canton
            ? Object.keys(zoneFlowData.links_by_canton)
            : [];
        const needed = [...new Set(
            [zoneFlowOriginCanton, zoneFlowDestCanton, ...cantonsInResp].filter(Boolean)
        )];

        let cancelled = false;
        const finishLoading = async () => {
            await waitForMapIdle(map);
            if (cancelled) return;
            setZoneFlowLoading(false);
        };

        if (cantonKey(needed) !== sourceKeyRef.current && needed.length > 0) {
            // Triggers an async load; reconcileSource re-applies pending flows
            // and idles internally before clearing setIsLoading. We still need
            // to clear the fetch-driven loading flag once the paint settles.
            reconcileSource(map, needed, { fit: false });
            finishLoading();
            return () => { cancelled = true; };
        }

        applyFlowsToSource(map, flattenLinksByCanton(zoneFlowData?.links_by_canton));
        ensureFlowLayers(map);
        finishLoading();
        return () => { cancelled = true; };
    }, [zoneFlowData, mapReady, mapRef, isGraphExpanded, zoneFlowOriginCanton, zoneFlowDestCanton, reconcileSource, applyFlowsToSource, ensureFlowLayers, setZoneFlowLoading]);

    return null;
}
