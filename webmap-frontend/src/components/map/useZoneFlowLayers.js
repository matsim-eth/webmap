import { useEffect, useRef, useCallback } from 'react';
import { useModule } from '../../context/ModuleContext';
import { useSelection } from '../../context/SelectionContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { handle401 } from '../../utils/auth';
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';
import { measureMapPadding } from '../sidebar/sidebarLayout';
import { socioFiltersToParams } from '../filters/socioFilterConfig';

// The backend (zone_flows.json) now returns `flow_geojson` — a FeatureCollection
// of just the flow links (geometry pulled off the network_links join the query
// already does), each carrying its `volume`. So this hook no longer downloads
// whole canton networks and filters them client-side: it just fetches and
// setData's the collection. One source, two layers (line + centred label).
const SOURCE_ID = 'zone-flows-network';
const FLOW_LAYER_ID = 'zone-flows-flow';
const FLOW_LABEL_LAYER_ID = 'zone-flows-flow-labels';
const MODULE_LAYERS = [FLOW_LABEL_LAYER_ID, FLOW_LAYER_ID];

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

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

export default function useZoneFlowLayers({ mapRef, mapReady, setIsLoading }) {
    const { isGraphExpanded } = useModule();
    const { clickedCanton, zoneFlowDestCanton } = useSelection();
    const { datasetId, zoneByName, setZoneFlowData, setZoneFlowLoading } = useData();
    const { zoneFlowDirection, timeRange, socioFilters } = useFilters();

    const zoneFlowOriginCanton = isGraphExpanded === 'ZoneFlows' ? clickedCanton : null;

    // Token to ignore stale responses; pair key so we only re-fit the camera
    // when the canton pair changes (not on direction/time tweaks).
    const fetchTokenRef = useRef(0);
    const prevPairRef = useRef(null);

    const removeAll = useCallback((map) => {
        safeRemoveLayer(map, MODULE_LAYERS);
        safeRemoveSource(map, [SOURCE_ID]);
    }, []);

    const ensureLayers = useCallback((map) => {
        if (!map.getSource(SOURCE_ID)) {
            map.addSource(SOURCE_ID, {
                type: 'geojson',
                data: EMPTY_FC,
                // Default 0.375 simplifies short segments away at low zoom,
                // making the highlighted route look broken.
                tolerance: 0.3,
            });
        }
        if (!map.getLayer(FLOW_LAYER_ID)) {
            map.addLayer({
                id: FLOW_LAYER_ID,
                type: 'line',
                source: SOURCE_ID,
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': '#ff8c00',
                    'line-width': ['interpolate', ['linear'], ['get', 'volume'],
                        0, 0, 1, 1, 5, 2, 25, 4, 75, 6, 200, 9, 500, 13, 1000, 18,
                    ],
                    'line-opacity': 0.9,
                },
                filter: ['>', ['get', 'volume'], 0],
            });
        }
        if (!map.getLayer(FLOW_LABEL_LAYER_ID)) {
            map.addLayer({
                id: FLOW_LABEL_LAYER_ID,
                type: 'symbol',
                source: SOURCE_ID,
                minzoom: 15,
                layout: {
                    'symbol-placement': 'line-center',
                    'symbol-spacing': 600,
                    'text-field': ['to-string', ['get', 'volume']],
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
                filter: ['>', ['get', 'volume'], 0],
            });
        }
    }, []);

    const fitToCantons = useCallback((map, cantons) => {
        let bbox = null;
        for (const c of cantons) bbox = unionBbox(bbox, zoneByName?.get(c)?.bbox);
        if (!bbox) return;
        // Fires after the flow data fetch, so the sidebar widths have settled —
        // measure them live to keep both cantons centred in the visible map.
        map.fitBounds(bbox, { padding: { ...measureMapPadding(), top: 60, bottom: 60 }, duration: 800, maxZoom: 11 });
    }, [zoneByName]);

    const setFlowData = useCallback((map, fc) => {
        const src = map.getSource(SOURCE_ID);
        if (src) src.setData(fc || EMPTY_FC);
    }, []);

    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        const ready = isGraphExpanded === 'ZoneFlows'
            && !!zoneFlowOriginCanton && !!zoneFlowDestCanton
            && zoneFlowOriginCanton !== zoneFlowDestCanton;

        if (!ready) {
            removeAll(map);
            setZoneFlowData(null);
            setZoneFlowLoading(false);
            setIsLoading?.(false);
            prevPairRef.current = null;
            return;
        }

        ensureLayers(map);
        // Clear the previous overlay immediately so a new query doesn't leave
        // stale flows on screen while it loads.
        setFlowData(map, EMPTY_FC);

        // Re-fit only when the canton pair changes.
        const pairKey = `${zoneFlowOriginCanton}::${zoneFlowDestCanton}`;
        if (prevPairRef.current !== pairKey) {
            prevPairRef.current = pairKey;
            fitToCantons(map, [zoneFlowOriginCanton, zoneFlowDestCanton]);
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
        for (const [k, v] of Object.entries(socioFiltersToParams(socioFilters))) params.set(k, v);

        const token = ++fetchTokenRef.current;
        setIsLoading?.(true);
        setZoneFlowLoading(true);
        const abort = new AbortController();

        (async () => {
            const url = `/backend/data/${datasetId}/zone_flows.json?${params.toString()}`;
            try {
                let res = await fetch(url, { signal: abort.signal });
                if (res.status === 401) {
                    const refreshed = await handle401();
                    if (!refreshed) return;
                    res = await fetch(url, { signal: abort.signal });
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (token !== fetchTokenRef.current) return;
                if (data?.error) {
                    console.warn('zone_flows error:', data.error);
                    setZoneFlowData({ ...data, links_by_canton: {}, total_trips: 0 });
                    setFlowData(map, EMPTY_FC);
                } else {
                    setZoneFlowData(data);
                    setFlowData(map, data.flow_geojson);
                }
            } catch (err) {
                if (err?.name === 'AbortError') return;
                if (token !== fetchTokenRef.current) return;
                console.error('Failed to fetch zone_flows', err);
                setZoneFlowData(null);
                setFlowData(map, EMPTY_FC);
            } finally {
                if (token === fetchTokenRef.current) {
                    setIsLoading?.(false);
                    setZoneFlowLoading(false);
                }
            }
        })();

        return () => abort.abort();
    }, [mapReady, mapRef, isGraphExpanded, zoneFlowOriginCanton, zoneFlowDestCanton,
        zoneFlowDirection, timeRange, socioFilters, datasetId, removeAll, ensureLayers,
        fitToCantons, setFlowData, setZoneFlowData, setZoneFlowLoading, setIsLoading]);

    return null;
}
