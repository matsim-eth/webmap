import { useEffect, useRef, useCallback } from 'react';
import { useModule } from '../../context/ModuleContext';
import { useSelection } from '../../context/SelectionContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { handle401 } from '../../utils/auth';
import { safeRemoveLayer, safeRemoveSource, setFilter } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';
import { CLICKABLE_ROAD_FILTER } from './_lib/mapboxFilters';

// Spider overlay source + layers (separate from the shared network-source)
const SPIDER_SOURCE_ID = 'volume-flow-spider';
const HIGHLIGHT_LAYER_ID = 'volume-flow-highlight';
const LABEL_LAYER_ID = 'volume-flow-labels';
const TARGET_LAYER_ID = 'volume-flow-target';
const TARGET_LABEL_ID = 'volume-flow-target-label';

// Layer from useNetworkLayers that we attach our click handler to
const NETWORK_HITBOX_LAYER = 'network-layer-hitbox';

// Reset the spider overlay (and any ad-hoc network-highlight from a click) to
// the empty state. Idempotent. Used by the Reset Link sidebar button; the
// hook's own cleanup is the equivalent `removeSpider`.
export function resetVolumeFlowOverlay(map) {
    if (!map) return;
    safeRemoveLayer(map, [
        TARGET_LABEL_ID,
        LABEL_LAYER_ID,
        TARGET_LAYER_ID,
        HIGHLIGHT_LAYER_ID,
        'network-highlight',
    ]);
    safeRemoveSource(map, [SPIDER_SOURCE_ID, 'network-highlight']);
    if (map.getLayer('network-layer')) {
        map.setPaintProperty('network-layer', 'line-opacity', 0.4);
    }
}

// Per-link daily volumes, keyed by `${datasetId}:${canton}`. Value is a
// Promise<Map<linkId, volume>|null> so concurrent callers dedupe. The new v2
// per-link geometry asset has no baked volume attribute, so VolumeFlow derives
// it from the link_volumes endpoint to hide links that carry no trips.
const linkVolumesCache = new Map();
// Cap the per-canton volume cache (FIFO) so exploring many cantons in one
// session doesn't retain every canton's link volumes for the tab's lifetime.
const LINK_VOL_CACHE_MAX = 8;

function fetchLinkVolumes(datasetId, canton) {
    const key = `${datasetId}:${canton}`;
    if (linkVolumesCache.has(key)) return linkVolumesCache.get(key);
    const url = `/backend/data/${datasetId}/link_volumes.json?canton=${encodeURIComponent(canton)}`;
    const p = (async () => {
        try {
            let res = await fetch(url);
            if (res.status === 401) {
                const ok = await handle401();
                if (!ok) return null;
                res = await fetch(url);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.error) { console.warn('link_volumes error:', data.error); return null; }
            const links = data.links || {};
            return new Map(Object.entries(links).map(([k, v]) => [String(k), Number(v)]));
        } catch (err) {
            console.warn('Failed to fetch link volumes:', err);
            linkVolumesCache.delete(key);
            return null;
        }
    })();
    linkVolumesCache.set(key, p);
    if (linkVolumesCache.size > LINK_VOL_CACHE_MAX) {
        linkVolumesCache.delete(linkVolumesCache.keys().next().value);
    }
    return p;
}

export default function useVolumeFlowLayers({ mapRef, mapReady }) {
    const { isGraphExpanded } = useModule();
    const {
        clickedCanton,
        featureSelection,
        setVolumeFlowSegment,
        setFeatureSelection,
        setSelectedNetworkFeature,
        volumeFlowSelectedLink,
        setVolumeFlowSelectedLink,
    } = useSelection();
    const { featureGeoJSON, datasetId } = useData();
    const { volumeFlowDirection } = useFilters();

    const clickHandlerRef = useRef(null);
    const featureGeoJSONRef = useRef(featureGeoJSON);
    featureGeoJSONRef.current = featureGeoJSON;

    // Store last clicked link so we can re-fetch when direction changes
    const lastClickRef = useRef(null); // { keys, feature }
    // Cache spider data per key + aggregated so link switching doesn't re-fetch
    const spiderCacheRef = useRef(null);
    // Abort in-flight spider fetches when a new link is clicked. Each spider
    // query is a multi-second scan of the 255M-row index; without cancelling,
    // rapid clicking piles up dozens of concurrent heavy queries and saturates
    // the backend.
    const spiderAbortRef = useRef(null);
    // Ref to read current selectedLink without adding it to main effect deps
    const selectedLinkRef = useRef(volumeFlowSelectedLink);
    selectedLinkRef.current = volumeFlowSelectedLink;
    // Track featureSelection from context to sync when re-entering VolumeFlow
    const featureSelectionRef = useRef(featureSelection);
    featureSelectionRef.current = featureSelection;
    // Track canton to clear lastClickRef when canton changes
    const prevCantonRef = useRef(clickedCanton);

    // --- Cleanup helper: removes spider overlay layers/source only ---
    const removeSpider = (map) => {
        safeRemoveLayer(map, [TARGET_LABEL_ID, LABEL_LAYER_ID, TARGET_LAYER_ID, HIGHLIGHT_LAYER_ID]);
        safeRemoveSource(map, SPIDER_SOURCE_ID);
    };

    const removeClickHandler = (map) => {
        if (clickHandlerRef.current) {
            map.off('click', NETWORK_HITBOX_LAYER, clickHandlerRef.current);
            clickHandlerRef.current = null;
        }
    };

    // --- Render spider overlay from a spiderMap (no fetching) ---
    const renderSpiderOverlay = useCallback((map, spiderMap, totalTrips, targetKeys, feature, displayLinkId) => {
        const currentFeatures = featureGeoJSONRef.current?.features;
        if (!currentFeatures) return null;

        // Build spider overlay features from the shared network GeoJSON
        const spiderFeatures = [];
        let idx = 0;

        for (const f of currentFeatures) {
            const fKeys = parsePipeList(f.properties.per_id_keys);
            const isTarget = fKeys.some(k => targetKeys.includes(k));

            // Sum flow across every link on this segment (e.g. forward + reverse)
            // so a merged segment's label is the total of its directions. When
            // the target is "All", each direction's contribution comes from a
            // different target link, so summing yields 4 + 3 = 7 rather than
            // max(4, 3) = 4.
            let segFlow = 0;
            for (const k of fKeys) {
                const vol = spiderMap.get(k);
                if (vol !== undefined) segFlow += vol;
            }

            if (segFlow > 0 || isTarget) {
                spiderFeatures.push({
                    ...f,
                    id: idx,
                    properties: {
                        ...f.properties,
                        spider_flow: segFlow,
                        isTarget: isTarget || undefined,
                        targetLinkId: isTarget ? displayLinkId : undefined,
                        featureIndex: idx,
                    }
                });
                idx++;
            }
        }

        const spiderGeoJSON = { type: 'FeatureCollection', features: spiderFeatures };

        // Remove existing spider layers before creating/updating
        removeSpider(map);

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

        // Scale target width by trip count
        let tw = 8;
        if (totalTrips >= 700) tw = 16;
        else if (totalTrips >= 500) tw = 12 + (totalTrips - 500) / 200 * 4;
        else if (totalTrips >= 300) tw = 8 + (totalTrips - 300) / 200 * 4;
        else if (totalTrips >= 150) tw = 5 + (totalTrips - 150) / 150 * 3;
        else if (totalTrips >= 50) tw = 3 + (totalTrips - 50) / 100 * 2;
        else tw = Math.max(3, totalTrips / 50 * 3);
        map.setPaintProperty(TARGET_LAYER_ID, 'line-width', tw);

        // Fade the base network so the spider overlay stands out
        if (map.getLayer('network-layer')) {
            map.setPaintProperty('network-layer', 'line-opacity', 0.2);
        }

        // Build table rows
        const tableRows = [];
        let rowIdx = 0;
        for (const ef of spiderFeatures) {
            if (ef.properties.isTarget) continue;
            const fKeys = parsePipeList(ef.properties.per_id_keys);
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

        return { tableRows, totalTrips };
    }, []);

    // --- Fetch spider data for ALL keys, cache, then render for a selection ---
    const fetchAndCacheSpiders = useCallback(async (map, keys, feature, direction) => {
        // Cancel any spider fetches still running from a previous click so they
        // don't pile up on the backend.
        if (spiderAbortRef.current) spiderAbortRef.current.abort();
        const abort = new AbortController();
        spiderAbortRef.current = abort;
        const signal = abort.signal;
        try {
            // Fetch spider data for all keys in parallel
            const results = await Promise.all(
                keys.map(async (key) => {
                    let res = await fetch(`/backend/data/${datasetId}/spider_${direction}.json?link_id=${key}`, { signal });
                    if (res.status === 401) {
                      const refreshed = await handle401();
                      if (!refreshed) return { key, total_trips: 0, spiderMap: new Map() };
                      res = await fetch(`/backend/data/${datasetId}/spider_${direction}.json?link_id=${key}`, { signal });
                    }
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const spider = await res.json();
                    if (spider.error) {
                        console.warn(`Spider query error for ${key}:`, spider.error);
                        return { key, total_trips: 0, spiderMap: new Map() };
                    }
                    const { total_trips, links: spiderLinks } = spider;
                    const needsScale = direction === 'inflow' || direction === 'outflow';
                    const spiderMap = new Map(
                        Object.entries(spiderLinks).map(([k, v]) => [k, needsScale ? Math.round(v * total_trips) : v])
                    );
                    return { key, total_trips, spiderMap };
                })
            );

            // Build per-key cache
            const perKey = {};
            for (const r of results) {
                perKey[r.key] = { total_trips: r.total_trips, spiderMap: r.spiderMap };
            }

            // Build aggregated spider map (sum flows across all keys)
            const aggSpiderMap = new Map();
            let aggTotalTrips = 0;
            for (const r of results) {
                aggTotalTrips += r.total_trips;
                for (const [k, v] of r.spiderMap) {
                    aggSpiderMap.set(k, (aggSpiderMap.get(k) || 0) + v);
                }
            }

            const cache = {
                keys,
                feature,
                perKey,
                aggregated: { total_trips: aggTotalTrips, spiderMap: aggSpiderMap },
            };
            spiderCacheRef.current = cache;

            return cache;
        } catch (err) {
            // Superseded by a newer click → not an error, just stop quietly.
            if (err?.name === 'AbortError') return null;
            console.error('Failed to fetch spider data:', err);
            return null;
        }
    }, [datasetId]);

    // --- Render from cache for a given selection (null = aggregated, key = specific) ---
    const renderForSelection = useCallback((map, cache, selectedLink) => {
        if (!cache) return;

        let data, targetKeys, displayLinkId;

        if (selectedLink && cache.perKey[selectedLink]) {
            data = cache.perKey[selectedLink];
            targetKeys = [selectedLink];
            displayLinkId = selectedLink;
        } else {
            // Aggregated view
            data = cache.aggregated;
            targetKeys = cache.keys;
            displayLinkId = cache.keys.length === 1 ? cache.keys[0] : `All (${cache.keys.length})`;
        }

        const result = renderSpiderOverlay(map, data.spiderMap, data.total_trips, targetKeys, cache.feature, displayLinkId);
        if (!result) return;

        setVolumeFlowSegment({
            targetLink: displayLinkId,
            allKeys: cache.keys,
            totalTrips: data.total_trips,
            dailyAvgVolume: cache.feature.properties.daily_avg_volume,
            modes: cache.feature.properties.modes,
            tableRows: result.tableRows,
        });
    }, [renderSpiderOverlay, setVolumeFlowSegment]);

    // --- Main effect: setup/teardown click handler + re-fetch on direction change ---
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        // Clear stored click when canton changes (old link IDs no longer valid)
        if (clickedCanton !== prevCantonRef.current) {
            prevCantonRef.current = clickedCanton;
            lastClickRef.current = null;
        }

        // Check if spider was active before cleanup (for direction-change re-fetch)
        const hadSpider = !!map.getSource(SPIDER_SOURCE_ID);

        // Direction-only change: keep segment info, just re-fetch spider overlay
        const isDirectionChange = hadSpider && lastClickRef.current && isGraphExpanded === 'VolumeFlow';

        // Always clean up spider overlay + handler first
        removeSpider(map);
        removeClickHandler(map);

        // Only clear segment info when actually leaving VolumeFlow or changing canton/link
        if (!isDirectionChange) {
            setVolumeFlowSegment(null);
            spiderCacheRef.current = null;
        }

        // Not in VolumeFlow → keep lastClickRef for restore, but done here
        if (isGraphExpanded !== 'VolumeFlow') {
            setVolumeFlowSelectedLink(null);
            return;
        }

        // Restore base VolumeFlow opacity (after spider removed)
        if (map.getLayer('network-layer')) {
            map.setPaintProperty('network-layer', 'line-opacity', 0.4);
        }

        // The clickable-road filter is owned by the dedicated volume effect
        // below (which hides links with no trips once volumes load); useNetworkLayers
        // sets a show-all filter on entry so links are clickable meanwhile.

        // Network not loaded yet
        if (!featureGeoJSON?.features || !map.getLayer(NETWORK_HITBOX_LAYER)) return;

        // Sync lastClickRef with current featureSelection (user may have clicked a
        // different link in Network/Volumes while VolumeFlow was inactive)
        const sel = featureSelectionRef.current;
        if (sel?.feature?.properties?.per_id_keys) {
            const selKeys = parsePipeList(sel.feature.properties.per_id_keys);
            const lastKeys = lastClickRef.current?.keys || [];
            if (selKeys.length && selKeys.join('|') !== lastKeys.join('|')) {
                lastClickRef.current = { keys: selKeys, feature: sel.feature };
                setVolumeFlowSelectedLink(null);
            }
        } else {
            // featureSelection cleared (e.g. AppContext group change on module exit)
            // — forget remembered click so re-entry doesn't restore stale spider
            lastClickRef.current = null;
            setVolumeFlowSelectedLink(null);
        }

        // If there's a stored click (direction change or returning to VolumeFlow), re-fetch
        if (lastClickRef.current) {
            const { keys, feature } = lastClickRef.current;
            fetchAndCacheSpiders(map, keys, feature, volumeFlowDirection).then(cache => {
                if (cache) renderForSelection(map, cache, selectedLinkRef.current);
            });
        }

        // --- Click handler: any link on the shared network layer ---
        const handleClick = async (e) => {
            if (!e.features?.length) return;

            const feature = e.features[0];
            const keys = parsePipeList(feature.properties.per_id_keys);
            if (!keys.length) return;

            // Store for re-fetch on direction change
            lastClickRef.current = { keys, feature };
            // Reset link selection to aggregated on new click
            setVolumeFlowSelectedLink(null);

            // Sync with shared highlight so selection persists across module switches
            const g = feature.geometry;
            const coords = g?.type === 'LineString'
                ? g.coordinates
                : g?.type === 'MultiLineString'
                    ? g.coordinates.flat()
                    : null;
            if (coords) {
                setFeatureSelection({ id: feature.properties.per_id_keys, feature, coords, fromMap: true });
            }
            setSelectedNetworkFeature([feature.properties]);

            const cache = await fetchAndCacheSpiders(map, keys, feature, volumeFlowDirection);
            if (cache) renderForSelection(map, cache, null);
        };

        map.on('click', NETWORK_HITBOX_LAYER, handleClick);
        clickHandlerRef.current = handleClick;

        return () => removeClickHandler(map);
    }, [mapReady, isGraphExpanded, clickedCanton, featureGeoJSON, mapRef, setVolumeFlowSegment, volumeFlowDirection, fetchAndCacheSpiders, renderForSelection, setVolumeFlowSelectedLink]);

    // --- Volume filter: hide links with no trips ---
    // The v2 per-link geometry asset carries no baked volume, so fetch per-link
    // daily volumes, bake daily_avg_volume onto the shared network features (same
    // object useNetworkLayers holds, so its own setData calls preserve it), and
    // filter the network to volume > 0. Falls back to the show-all clickable
    // filter if volumes are unavailable so the module still works.
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        if (isGraphExpanded !== 'VolumeFlow') return;
        if (!clickedCanton || !datasetId || !featureGeoJSON?.features) return;
        const map = mapRef.current;

        let cancelled = false;
        (async () => {
            const volMap = await fetchLinkVolumes(datasetId, clickedCanton);
            if (cancelled || isGraphExpanded !== 'VolumeFlow') return;
            if (!map.getLayer(NETWORK_HITBOX_LAYER)) return;

            if (!volMap || volMap.size === 0) {
                setFilter(map, ['network-layer', NETWORK_HITBOX_LAYER], CLICKABLE_ROAD_FILTER);
                return;
            }

            const fc = featureGeoJSONRef.current;
            if (fc?.features) {
                for (const f of fc.features) {
                    const keys = parsePipeList(f.properties.per_id_keys);
                    let total = 0;
                    for (const k of keys) total += volMap.get(k) || 0;
                    f.properties.daily_avg_volume = total;
                }
                const src = map.getSource('network-source');
                if (src) src.setData(fc);
            }

            setFilter(map, ['network-layer', NETWORK_HITBOX_LAYER],
                ['>', ['get', 'daily_avg_volume'], 0]);
        })();

        return () => { cancelled = true; };
    }, [mapReady, mapRef, isGraphExpanded, clickedCanton, datasetId, featureGeoJSON]);

    // --- Effect 2: re-render when selected link changes (from sidebar) ---
    useEffect(() => {
        if (!mapReady || !mapRef.current || isGraphExpanded !== 'VolumeFlow') return;
        if (!spiderCacheRef.current) return;

        const map = mapRef.current;
        renderForSelection(map, spiderCacheRef.current, volumeFlowSelectedLink);
    }, [volumeFlowSelectedLink, mapReady, mapRef, isGraphExpanded, renderForSelection]);

    return null;
}

export function updateFlowVisualization() {}
