import { useEffect, useRef, useCallback } from 'react';
import { useModule } from '../../context/ModuleContext';
import { useData } from '../../context/DataContext';
import { useFileContext } from '../../FileContext';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';

const SOURCE_ID = 'polygon-trips-network';
const LAYER_OUTBOUND = 'polygon-trips-outbound';
const LAYER_INBOUND = 'polygon-trips-inbound';
const LAYER_INTERNAL = 'polygon-trips-internal';

const MODULE_LAYERS = [LAYER_OUTBOUND, LAYER_INBOUND, LAYER_INTERNAL];
const MODULE_SOURCES = [SOURCE_ID];

const COLOR_OUTBOUND = '#f97316'; // orange — leaving polygon
const COLOR_INBOUND = '#0ea5e9';  // blue   — entering polygon
const COLOR_INTERNAL = '#16a34a'; // green  — within polygon

const widthExpr = (propName) => [
    'interpolate', ['linear'], ['coalesce', ['get', propName], 0],
    0, 0, 1, 1, 5, 2, 25, 4, 75, 6, 200, 9, 500, 13, 1000, 18,
];

const cantonKey = (cantons) => cantons.slice().sort().join('::');

const flattenLinks = (perCanton) => {
    const m = new Map();
    if (!perCanton) return m;
    for (const cantonLinks of Object.values(perCanton)) {
        for (const [k, v] of Object.entries(cantonLinks)) {
            m.set(String(k), Number(v));
        }
    }
    return m;
};

const waitForMapIdle = (map) => new Promise((resolve) => {
    if (!map) { resolve(); return; }
    map.once('idle', resolve);
});

/**
 * Renders polygon trip route volumes as three colored line layers:
 *   - outbound (orange) — trips starting inside polygon
 *   - inbound  (blue)   — trips ending   inside polygon
 *   - internal (green)  — trips with both endpoints inside polygon
 *
 * Only car trips are visualized (spider_routes limitation). Multi-canton
 * networks are auto-loaded based on which cantons appear in the response.
 */
export default function usePolygonTripLayers({ mapRef, mapReady }) {
    const { isGraphExpanded } = useModule();
    const { dataURL, polygonRoutesData, showPolygonRoutes } = useData();
    const { fileMap } = useFileContext();

    const loadWithFallback = useLoadWithFallback(dataURL);

    const networkCacheRef = useRef({});
    const fileMapSizeRef = useRef(fileMap.size);
    if (fileMapSizeRef.current !== fileMap.size) {
        networkCacheRef.current = {};
        fileMapSizeRef.current = fileMap.size;
    }

    const loadRef = useRef(loadWithFallback);
    loadRef.current = loadWithFallback;
    const combinedGeoRef = useRef(null);
    const sourceKeyRef = useRef(null);
    const reconcileTokenRef = useRef(0);
    const lastDataRef = useRef(null);
    lastDataRef.current = polygonRoutesData;

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

    const ensureLayers = useCallback((map) => {
        const common = {
            type: 'line',
            source: SOURCE_ID,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
        };
        if (!map.getLayer(LAYER_OUTBOUND)) {
            map.addLayer({
                id: LAYER_OUTBOUND, ...common,
                paint: {
                    'line-color': COLOR_OUTBOUND,
                    'line-width': widthExpr('pt_out'),
                    'line-opacity': 0.75,
                },
                filter: ['>', ['coalesce', ['get', 'pt_out'], 0], 0],
            });
        }
        if (!map.getLayer(LAYER_INBOUND)) {
            map.addLayer({
                id: LAYER_INBOUND, ...common,
                paint: {
                    'line-color': COLOR_INBOUND,
                    'line-width': widthExpr('pt_in'),
                    'line-opacity': 0.75,
                },
                filter: ['>', ['coalesce', ['get', 'pt_in'], 0], 0],
            });
        }
        if (!map.getLayer(LAYER_INTERNAL)) {
            map.addLayer({
                id: LAYER_INTERNAL, ...common,
                paint: {
                    'line-color': COLOR_INTERNAL,
                    'line-width': widthExpr('pt_int'),
                    'line-opacity': 0.85,
                },
                filter: ['>', ['coalesce', ['get', 'pt_int'], 0], 0],
            });
        }
    }, []);

    const applyFlowsToSource = useCallback((map, data) => {
        const base = combinedGeoRef.current;
        const source = map.getSource(SOURCE_ID);
        if (!base || !source) return;

        const out = flattenLinks(data?.routes_by_category?.outbound);
        const inn = flattenLinks(data?.routes_by_category?.inbound);
        const intern = flattenLinks(data?.routes_by_category?.internal);

        const decorated = [];
        if (out.size + inn.size + intern.size > 0) {
            for (let idx = 0; idx < base.features.length; idx++) {
                const f = base.features[idx];
                const keys = parsePipeList(f.properties?.per_id_keys);
                let pt_out = 0, pt_in = 0, pt_int = 0;
                for (const k of keys) {
                    const ks = String(k);
                    const a = out.get(ks); if (a !== undefined && a > pt_out) pt_out = a;
                    const b = inn.get(ks); if (b !== undefined && b > pt_in)  pt_in  = b;
                    const c = intern.get(ks); if (c !== undefined && c > pt_int) pt_int = c;
                }
                if (pt_out > 0 || pt_in > 0 || pt_int > 0) {
                    decorated.push({
                        ...f,
                        id: idx,
                        properties: { ...f.properties, pt_out, pt_in, pt_int },
                    });
                }
            }
        }
        source.setData({ type: 'FeatureCollection', features: decorated });
    }, []);

    const reconcileSource = useCallback(async (map, cantons) => {
        const key = cantonKey(cantons);
        if (sourceKeyRef.current === key && map.getSource(SOURCE_ID)) return;

        const token = ++reconcileTokenRef.current;
        const geos = await Promise.all(cantons.map(loadCantonNetwork));
        if (token !== reconcileTokenRef.current) return;

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

        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, {
                type: 'geojson',
                data: geo,
                generateId: true,
                tolerance: 0.3,
            });
            ensureLayers(map);
        } else {
            map.getSource(SOURCE_ID).setData(geo);
        }
        sourceKeyRef.current = key;

        const pending = lastDataRef.current;
        if (pending) applyFlowsToSource(map, pending);
        await waitForMapIdle(map);
    }, [loadCantonNetwork, ensureLayers, applyFlowsToSource]);

    // Build / tear down whenever module + toggle state or canton set changes.
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        if (isGraphExpanded !== 'PolygonTrips' || !showPolygonRoutes || !polygonRoutesData) {
            removeAll(map);
            return;
        }

        const cantonsInResp = new Set();
        for (const cat of ['outbound', 'inbound', 'internal']) {
            const m = polygonRoutesData?.routes_by_category?.[cat];
            if (m) for (const k of Object.keys(m)) cantonsInResp.add(k);
        }
        const needed = [...cantonsInResp];

        if (needed.length === 0) {
            removeAll(map);
            return;
        }

        reconcileSource(map, needed).then(() => {
            applyFlowsToSource(map, polygonRoutesData);
            ensureLayers(map);
        });
    }, [mapReady, mapRef, isGraphExpanded, showPolygonRoutes, polygonRoutesData,
        reconcileSource, applyFlowsToSource, ensureLayers, removeAll]);

    return null;
}
