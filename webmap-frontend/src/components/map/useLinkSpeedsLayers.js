import { useEffect, useRef, useCallback, useState } from 'react';
import { nearestPointOnLine, lineString, point } from '@turf/turf';
import { useModule } from '../../context/ModuleContext';
import { useSelection } from '../../context/SelectionContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { handle401 } from '../../utils/auth';
import { safeRemoveLayer, safeRemoveSource, setVisibility } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';

const SPEEDS_SOURCE_ID = 'link-speeds-source';
const SPEEDS_LAYER_ID = 'link-speeds-layer';
const SPEEDS_AGG_SOURCE_ID = 'link-speeds-source-agg';
const SPEEDS_AGG_LAYER_ID = 'link-speeds-layer-agg';
const SPEEDS_LABELS_RIGHT = 'link-speeds-labels-right';
const SPEEDS_LABELS_LEFT = 'link-speeds-labels-left';
// Zoom at which we swap from the aggregated stacked line to offset per-direction
// lines (matches the label minzoom).
const SPLIT_ZOOM = 15;

// Color ramps per metric.
const COLOR_RAMPS = {
    avg_speed: ['interpolate', ['linear'], ['get', 'ls_avg_speed'],
        0, '#d7191c', 20, '#fdae61', 50, '#ffffbf', 80, '#a6d96a', 120, '#1a9641'],
    freespeed: ['interpolate', ['linear'], ['get', 'ls_freespeed'],
        0, '#d7191c', 20, '#fdae61', 50, '#ffffbf', 80, '#a6d96a', 120, '#1a9641'],
    congestion_index: ['interpolate', ['linear'], ['get', 'ls_congestion'],
        0, '#d7191c', 0.5, '#fdae61', 0.75, '#ffffbf', 0.9, '#a6d96a', 1.0, '#1a9641'],
};

// Offset for parallel opposing-direction sub-features (same pattern as node flows).
const isWestish = ['any', ['>', ['get', 'angle'], 90], ['<=', ['get', 'angle'], -90]];
const LINE_OFFSET_PX = 5;
const LINE_OFFSET_EXPR = ['case',
    ['!', ['get', 'ls_needs_offset']], 0,
    ['==', ['get', 'ls_arrow'], '\u2192'],
        ['case', isWestish, -LINE_OFFSET_PX, LINE_OFFSET_PX],
    ['case', isWestish, LINE_OFFSET_PX, -LINE_OFFSET_PX],
];
const LABEL_OFFSET_NORMAL = 1;
const LABEL_OFFSET_WIDE = 1.6;

// Per-direction aggregation for one feature. Shared by both passes.
function aggregatePerDir(f, linksMap) {
    const keys = parsePipeList(f.properties?.per_id_keys);
    const arrows = parsePipeList(f.properties?.per_id_arrows);
    const perDir = {
        '\u2192': { vsum: 0, fsum: 0, volsum: 0, count: 0, ids: [] },
        '\u2190': { vsum: 0, fsum: 0, volsum: 0, count: 0, ids: [] },
    };
    for (let i = 0; i < keys.length; i++) {
        const bucket = perDir[arrows[i]];
        if (!bucket) continue;
        const d = linksMap[keys[i]];
        if (d && d.volume && d.avg_speed != null && d.freespeed) {
            bucket.vsum += d.avg_speed * d.volume;
            bucket.fsum += d.freespeed * d.volume;
            bucket.volsum += d.volume;
            bucket.count += 1;
            bucket.ids.push(keys[i]);
        }
    }
    return perDir;
}

// Single pass: build agg + per-direction sub features + totals in one loop
// over the canton's features, sharing the aggregatePerDir work.
function buildAll(features, linksMap) {
    const totals = { totVolSpeed: 0, totVolFree: 0, totVol: 0, linkCount: 0 };
    const aggFeatures = [];
    const subFeatures = [];
    for (const f of features) {
        const perDir = aggregatePerDir(f, linksMap);
        const right = perDir['\u2192'];
        const left = perDir['\u2190'];
        if (right.volsum === 0 && left.volsum === 0) continue;

        const aggVsum = right.vsum + left.vsum;
        const aggFsum = right.fsum + left.fsum;
        const aggVol = right.volsum + left.volsum;
        const aggAvg = aggVol ? aggVsum / aggVol : null;
        const aggFree = aggVol ? aggFsum / aggVol : null;
        const aggCong = aggFree ? aggAvg / aggFree : null;

        totals.totVolSpeed += aggVsum;
        totals.totVolFree += aggFsum;
        totals.totVol += aggVol;
        totals.linkCount += right.count + left.count;

        aggFeatures.push({
            type: 'Feature',
            geometry: f.geometry,
            properties: {
                ...f.properties,
                ls_avg_speed: aggAvg != null ? Number(aggAvg.toFixed(2)) : -1,
                ls_freespeed: aggFree != null ? Number(aggFree.toFixed(2)) : -1,
                ls_congestion: aggCong != null ? Number(aggCong.toFixed(4)) : -1,
                ls_cong_label: aggCong != null ? aggCong.toFixed(2) : '',
                ls_has_data: 1,
                ls_link_ids: [...right.ids, ...left.ids].join('|'),
            },
        });

        const needsOffset = right.volsum > 0 && left.volsum > 0;
        for (const arrow of ['\u2192', '\u2190']) {
            const p = perDir[arrow];
            if (p.volsum === 0) continue;
            const avg = p.vsum / p.volsum;
            const free = p.fsum / p.volsum;
            const cong = free ? avg / free : null;
            subFeatures.push({
                type: 'Feature',
                geometry: f.geometry,
                properties: {
                    ...f.properties,
                    ls_avg_speed: Number(avg.toFixed(2)),
                    ls_freespeed: Number(free.toFixed(2)),
                    ls_congestion: cong != null ? Number(cong.toFixed(4)) : -1,
                    ls_cong_label: cong != null ? cong.toFixed(2) : '',
                    ls_has_data: 1,
                    ls_arrow: arrow,
                    ls_needs_offset: needsOffset,
                    ls_link_ids: p.ids.join('|'),
                },
            });
        }
    }
    return { aggFeatures, subFeatures, totals };
}

function summarize(t) {
    return {
        totalLinks: t.linkCount,
        avgSpeed: t.totVol ? Number((t.totVolSpeed / t.totVol).toFixed(2)) : null,
        avgFreespeed: t.totVol ? Number((t.totVolFree / t.totVol).toFixed(2)) : null,
        congestionIndex: t.totVolFree ? Number((t.totVolSpeed / t.totVolFree).toFixed(4)) : null,
        totalVolume: Math.round(t.totVol),
    };
}

export default function useLinkSpeedsLayers({ mapRef, mapReady, setIsLoading }) {
    const { isGraphExpanded } = useModule();
    const {
        clickedCanton,
        featureSelection,
        setLinkSpeedsSelected,
        setSelectedNetworkFeature,
        setFeatureSelection,
    } = useSelection();
    const {
        featureGeoJSON,
        datasetId,
        setLinkSpeedsSummary,
        setLinkSpeedsLinksMap,
    } = useData();
    const { timeRange, linkSpeedsMetric, linkSpeedsRoadTypes } = useFilters();

    // Cache fetched links keyed by canton+timeRange+dataset so that road-type
    // and metric changes don't trigger a re-fetch from the backend.
    const cacheRef = useRef({ key: null, links: null });
    // Filtered linksMap available to the selection effect.
    const filteredLinksRef = useRef({});
    // Version bump so the selection effect re-runs after data arrives.
    const [dataVersion, setDataVersion] = useState(0);
    // Fetched links (stateful so the build effect can depend on it). Keyed by
    // the same cacheKey so the build effect can skip stale data.
    const [linksState, setLinksState] = useState({ key: null, links: null });

    const removeOverlay = useCallback((map) => {
        safeRemoveLayer(map, [SPEEDS_LABELS_RIGHT, SPEEDS_LABELS_LEFT, SPEEDS_LAYER_ID, SPEEDS_AGG_LAYER_ID]);
        safeRemoveSource(map, [SPEEDS_SOURCE_ID, SPEEDS_AGG_SOURCE_ID]);
        // Restore base network-layer visibility (we hide it while in LinkSpeeds
        // since the colored speed lines cover the same geometry).
        setVisibility(map, 'network-layer', true);
        // Invalidate the links cache so re-entering the module re-fetches/re-builds
        // features (prevents stale symbology when swapping modules).
        cacheRef.current = { key: null, links: null };
    }, []);

    // Synchronously set up empty sources + layers so the symbology is present
    // the moment we enter LinkSpeeds mode (no flash of the previous module's
    // paint during the fetch).
    const ensureLayers = useCallback((map, metric) => {
        const ramp = COLOR_RAMPS[metric] || COLOR_RAMPS.avg_speed;
        const emptyFC = { type: 'FeatureCollection', features: [] };

        if (!map.getSource(SPEEDS_AGG_SOURCE_ID)) {
            map.addSource(SPEEDS_AGG_SOURCE_ID, { type: 'geojson', data: emptyFC });
        }
        if (!map.getSource(SPEEDS_SOURCE_ID)) {
            map.addSource(SPEEDS_SOURCE_ID, { type: 'geojson', data: emptyFC });
        }

        if (!map.getLayer(SPEEDS_AGG_LAYER_ID)) {
            map.addLayer({
                id: SPEEDS_AGG_LAYER_ID,
                type: 'line',
                source: SPEEDS_AGG_SOURCE_ID,
                maxzoom: SPLIT_ZOOM,
                paint: {
                    'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 2, 4000, 9],
                    'line-color': ramp,
                    'line-opacity': 0.9,
                },
            });
        }
        if (!map.getLayer(SPEEDS_LAYER_ID)) {
            map.addLayer({
                id: SPEEDS_LAYER_ID,
                type: 'line',
                source: SPEEDS_SOURCE_ID,
                minzoom: SPLIT_ZOOM,
                paint: {
                    'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 2, 4000, 9],
                    'line-color': ramp,
                    'line-opacity': 0.9,
                    'line-offset': LINE_OFFSET_EXPR,
                },
            });
        }
        if (!map.getLayer(SPEEDS_LABELS_RIGHT)) {
            map.addLayer({
                id: SPEEDS_LABELS_RIGHT,
                type: 'symbol',
                source: SPEEDS_SOURCE_ID,
                minzoom: SPLIT_ZOOM,
                filter: ['==', ['get', 'ls_arrow'], '\u2192'],
                layout: {
                    'symbol-placement': 'line-center',
                    'symbol-spacing': 9999999,
                    'text-keep-upright': true,
                    'text-field': ['concat', ['get', 'ls_cong_label'], ' \u2192'],
                    'text-size': 11,
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                    'text-offset': [0, ['case',
                        ['get', 'ls_needs_offset'],
                            ['case', isWestish, -LABEL_OFFSET_WIDE, LABEL_OFFSET_WIDE],
                        ['case', isWestish, -LABEL_OFFSET_NORMAL, LABEL_OFFSET_NORMAL],
                    ]],
                    'text-allow-overlap': true,
                },
                paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
            });
        }
        if (!map.getLayer(SPEEDS_LABELS_LEFT)) {
            map.addLayer({
                id: SPEEDS_LABELS_LEFT,
                type: 'symbol',
                source: SPEEDS_SOURCE_ID,
                minzoom: SPLIT_ZOOM,
                filter: ['==', ['get', 'ls_arrow'], '\u2190'],
                layout: {
                    'symbol-placement': 'line-center',
                    'symbol-spacing': 9999999,
                    'text-keep-upright': true,
                    'text-field': ['concat', '\u2190 ', ['get', 'ls_cong_label']],
                    'text-size': 11,
                    'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
                    'text-offset': [0, ['case',
                        ['get', 'ls_needs_offset'],
                            ['case', isWestish, LABEL_OFFSET_WIDE, -LABEL_OFFSET_WIDE],
                        ['case', isWestish, LABEL_OFFSET_NORMAL, -LABEL_OFFSET_NORMAL],
                    ]],
                    'text-allow-overlap': true,
                },
                paint: { 'text-color': '#111', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
            });
        }

        // Hide base network-layer — the colored speed lines cover the same
        // geometry, so rendering the gray base underneath is wasted work.
        setVisibility(map, 'network-layer', false);
    }, []);

    // Module-exit teardown (separate so fetch/build effects can be narrow).
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        if (isGraphExpanded === 'LinkSpeeds') return;
        const map = mapRef.current;
        removeOverlay(map);
        setLinkSpeedsSummary(null);
        setLinkSpeedsSelected(null);
        setLinkSpeedsLinksMap(null);
        filteredLinksRef.current = {};
        setIsLoading?.(false);
    }, [isGraphExpanded, mapReady, mapRef, removeOverlay,
        setLinkSpeedsSummary, setLinkSpeedsSelected, setLinkSpeedsLinksMap, setIsLoading]);

    // Per-direction click on the split layer (zoom >= SPLIT_ZOOM). Sets
    // featureSelection with only that direction's link ids so downstream
    // metric computation and highlight styling can branch on ls_arrow.
    // The base click-network-layer handler suppresses itself when a split
    // feature is under the cursor (see useNetworkLayers.js).
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        if (isGraphExpanded !== 'LinkSpeeds') return;
        const map = mapRef.current;

        // Pick the direction whose rendered side matches the click.
        // Mapbox line-offset is paint-only — both split features share the
        // same geometry, so queryRenderedFeatures returns both. Disambiguate
        // by comparing the click's side (relative to line drawing direction)
        // to each feature's paint-offset sign.
        const pickByClickSide = (hits, clickLngLat) => {
            if (hits.length === 1) return hits[0];
            const ref = hits[0];
            if (!ref.properties.ls_needs_offset) return ref;

            const geom = ref.geometry;
            const coords = geom.type === 'LineString' ? geom.coordinates : geom.coordinates[0];
            if (!coords || coords.length < 2) return ref;

            const clickPt = point([clickLngLat.lng, clickLngLat.lat]);
            const snap = nearestPointOnLine(lineString(coords), clickPt);
            const i = Math.min(snap.properties.index ?? 0, coords.length - 2);
            const a = coords[i], b = coords[i + 1];
            const vx = b[0] - a[0], vy = b[1] - a[1];
            const wx = clickLngLat.lng - a[0], wy = clickLngLat.lat - a[1];
            // 2D cross. Positive line-offset = right of drawing direction;
            // in lng/lat (north-up, east-right) that side has cross < 0.
            const clickIsRight = (vx * wy - vy * wx) < 0;

            const offsetSign = (arrow, angle) => {
                const isWest = angle > 90 || angle <= -90;
                if (arrow === '→') return isWest ? -1 : 1;
                return isWest ? 1 : -1;
            };
            const want = clickIsRight ? 1 : -1;
            return hits.find(h => offsetSign(h.properties.ls_arrow, h.properties.angle) === want) || ref;
        };

        const onClick = (e) => {
            if (!e.features?.length) return;
            const clicked = pickByClickSide(e.features, e.lngLat);

            safeRemoveLayer(map, 'network-highlight');
            safeRemoveSource(map, 'network-highlight');
            map.addSource('network-highlight', {
                type: 'geojson',
                data: { type: 'FeatureCollection', features: [clicked] },
            });
            map.addLayer({
                id: 'network-highlight',
                type: 'line',
                source: 'network-highlight',
                paint: {
                    // Narrow highlight — we're only selecting one direction.
                    'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 6, 4000, 15],
                    'line-color': '#00a2ff',
                    'line-opacity': 1,
                    'line-offset': LINE_OFFSET_EXPR,
                },
            }, map.getLayer(SPEEDS_AGG_LAYER_ID) ? SPEEDS_AGG_LAYER_ID : 'network-layer');

            setSelectedNetworkFeature([clicked.properties]);
            const g = clicked.geometry;
            const coords = g?.type === 'LineString' ? g.coordinates
                : g?.type === 'MultiLineString' ? g.coordinates.flat()
                : null;
            if (coords && setFeatureSelection) {
                setFeatureSelection({
                    id: clicked.properties.ls_link_ids,
                    feature: clicked,
                    coords,
                    fromMap: true,
                });
            }
        };
        const onEnter = () => { map.getCanvas().style.cursor = 'pointer'; };
        const onLeave = () => { map.getCanvas().style.cursor = ''; };

        map.on('click', SPEEDS_LAYER_ID, onClick);
        map.on('mouseenter', SPEEDS_LAYER_ID, onEnter);
        map.on('mouseleave', SPEEDS_LAYER_ID, onLeave);
        return () => {
            map.off('click', SPEEDS_LAYER_ID, onClick);
            map.off('mouseenter', SPEEDS_LAYER_ID, onEnter);
            map.off('mouseleave', SPEEDS_LAYER_ID, onLeave);
        };
    }, [isGraphExpanded, mapReady, mapRef, setSelectedNetworkFeature, setFeatureSelection]);

    // Fetch effect: fires as soon as canton+module+dataset are known, in
    // parallel with the network GeoJSON load. No dependency on featureGeoJSON.
    const [tr0, tr1] = timeRange || [0, 96];
    const minuteStart = tr0 * 15;
    const minuteEnd = tr1 * 15;
    const cacheKey = (isGraphExpanded === 'LinkSpeeds' && clickedCanton && datasetId)
        ? `${datasetId}:${clickedCanton}:${minuteStart}:${minuteEnd}`
        : null;

    useEffect(() => {
        if (!cacheKey) return;

        // Already fetched → surface cached value synchronously via state.
        if (cacheRef.current.key === cacheKey) {
            setLinksState({ key: cacheKey, links: cacheRef.current.links });
            return;
        }

        const qs = new URLSearchParams({
            canton: String(clickedCanton),
            minute_start: String(minuteStart),
            minute_end: String(minuteEnd),
        });
        const url = `/backend/data/${datasetId}/link_speeds.json?${qs.toString()}`;

        // AbortController cancels in-flight fetches when params change (time
        // slider drag). Prevents request pileup on large cantons.
        const abort = new AbortController();
        let cancelled = false;
        setIsLoading?.(true);

        (async () => {
            let res;
            try {
                res = await fetch(url, { signal: abort.signal });
                if (res.status === 401) {
                    const ok = await handle401();
                    if (!ok) return;
                    res = await fetch(url, { signal: abort.signal });
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                if (err.name !== 'AbortError') {
                    console.warn('Failed to fetch link speeds:', err);
                    setIsLoading?.(false);  // stop the spinner on error (don't hang forever)
                }
                return;
            }
            const data = await res.json();
            if (cancelled) return;
            if (data.error) {
                console.warn('Link speeds error:', data.error);
                setIsLoading?.(false);  // no link-speed data → clear loading instead of spinning forever
                return;
            }
            const allLinks = data.links || {};
            cacheRef.current = { key: cacheKey, links: allLinks };
            setLinksState({ key: cacheKey, links: allLinks });
        })();

        return () => { cancelled = true; abort.abort(); };
    }, [cacheKey, clickedCanton, datasetId, minuteStart, minuteEnd, setIsLoading]);

    // Build effect: runs when both featureGeoJSON and linksState are ready for
    // the current cacheKey. Single pass produces agg + split + totals.
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        if (isGraphExpanded !== 'LinkSpeeds') return;
        const map = mapRef.current;

        // Symbology up-front regardless of data readiness — no flash.
        ensureLayers(map, linkSpeedsMetric);

        if (!clickedCanton || !featureGeoJSON?.features) return;
        if (!linksState.links || linksState.key !== cacheKey) {
            // Data not ready yet — keep overlay up.
            setIsLoading?.(true);
            return;
        }

        const rtFilter = (linkSpeedsRoadTypes && !linkSpeedsRoadTypes.includes('all'))
            ? new Set(linkSpeedsRoadTypes)
            : null;
        const linksMap = rtFilter
            ? Object.fromEntries(
                Object.entries(linksState.links).filter(([, d]) => d && rtFilter.has(d.road_type))
            )
            : linksState.links;
        filteredLinksRef.current = linksMap;
        setLinkSpeedsLinksMap(linksMap);

        let cancelled = false;
        (async () => {
            // Single-pass build of agg + split + totals.
            const { aggFeatures, subFeatures, totals } = buildAll(featureGeoJSON.features, linksMap);
            if (cancelled) return;
            setLinkSpeedsSummary(summarize(totals));

            // Paint the zoom-visible layer first so the user sees color asap.
            const aggFirst = map.getZoom() < SPLIT_ZOOM;
            const aggSrc = map.getSource(SPEEDS_AGG_SOURCE_ID);
            const subSrc = map.getSource(SPEEDS_SOURCE_ID);
            const aggFC = { type: 'FeatureCollection', features: aggFeatures };
            const subFC = { type: 'FeatureCollection', features: subFeatures };

            if (aggFirst) {
                if (aggSrc) aggSrc.setData(aggFC);
            } else {
                if (subSrc) subSrc.setData(subFC);
            }
            setIsLoading?.(false);

            await new Promise(r => setTimeout(r, 0));
            if (cancelled) return;

            if (aggFirst) {
                if (subSrc) subSrc.setData(subFC);
            } else {
                if (aggSrc) aggSrc.setData(aggFC);
            }
            setDataVersion(v => v + 1);
        })();

        return () => { cancelled = true; };
    // linkSpeedsMetric intentionally excluded — paint-only, handled below.
    }, [
        mapReady, mapRef, isGraphExpanded, clickedCanton, featureGeoJSON,
        linksState, cacheKey, linkSpeedsRoadTypes,
        ensureLayers, setLinkSpeedsSummary, setIsLoading,
    ]);

    // Metric change: cheap paint-only update.
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;
        const ramp = COLOR_RAMPS[linkSpeedsMetric] || COLOR_RAMPS.avg_speed;
        if (map.getLayer(SPEEDS_LAYER_ID)) {
            map.setPaintProperty(SPEEDS_LAYER_ID, 'line-color', ramp);
        }
        if (map.getLayer(SPEEDS_AGG_LAYER_ID)) {
            map.setPaintProperty(SPEEDS_AGG_LAYER_ID, 'line-color', ramp);
        }
    }, [linkSpeedsMetric, mapReady, mapRef]);

    // Adjust network-highlight width so it spans the offset speed sub-features
    // at zoom >= SPLIT_ZOOM. Restores the default width when leaving the module.
    // Runs on mode changes AND on selection changes (highlight is recreated per click).
    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;
        if (!map.getLayer('network-highlight')) return;

        const defaultWidth = ['interpolate', ['linear'], ['get', 'capacity'], 300, 6, 4000, 15];
        // Only widen for merged (non-split) selections — per-direction clicks
        // highlight a single offset line and should stay narrow.
        const isSplitSelection = !!featureSelection?.feature?.properties?.ls_arrow;
        // Push the highlight below the speed layers so the colored line sits
        // on top (user sees a ring). The base click handler in useNetworkLayers
        // inserts it at the bottom of the stack, but speed sources may have
        // been added after that insertion point — move it explicitly.
        if (isGraphExpanded === 'LinkSpeeds' && map.getLayer(SPEEDS_AGG_LAYER_ID)) {
            map.moveLayer('network-highlight', SPEEDS_AGG_LAYER_ID);
        }
        if (isGraphExpanded === 'LinkSpeeds' && !isSplitSelection) {
            map.setPaintProperty('network-highlight', 'line-width', ['step', ['zoom'],
                defaultWidth,
                SPLIT_ZOOM,
                ['interpolate', ['linear'], ['get', 'capacity'], 300, 18, 4000, 28],
            ]);
        } else {
            map.setPaintProperty('network-highlight', 'line-width', defaultWidth);
        }
    }, [isGraphExpanded, featureSelection, mapReady, mapRef]);

    // React to shared featureSelection (set by click-network-layer handler in
    // useNetworkLayers). Compute per-segment speed metrics and push into sidebar.
    useEffect(() => {
        if (isGraphExpanded !== 'LinkSpeeds') return;
        const map = mapRef.current;
        const sel = featureSelection;
        const props = sel?.feature?.properties;
        // Helper: toggle on-map highlight in lockstep with sidebar data so the
        // selection visually disappears when filtered out by road type.
        const setHighlightVisible = (visible) => setVisibility(map, 'network-highlight', visible);
        if (!props) {
            setLinkSpeedsSelected(null);
            setHighlightVisible(false);
            return;
        }
        // Prefer ls_link_ids (direction-specific) over per_id_keys (full segment)
        // so split-layer clicks produce direction-specific metrics.
        const keys = parsePipeList(props.ls_link_ids || props.per_id_keys);
        const linksMap = filteredLinksRef.current || {};
        let vsum = 0, fsum = 0, volsum = 0;
        const matchedIds = [];
        for (const k of keys) {
            const d = linksMap[k];
            if (d && d.volume && d.avg_speed != null && d.freespeed) {
                vsum += d.avg_speed * d.volume;
                fsum += d.freespeed * d.volume;
                volsum += d.volume;
                matchedIds.push(k);
            }
        }
        if (!volsum) {
            setLinkSpeedsSelected(null);
            setHighlightVisible(false);
            return;
        }
        setHighlightVisible(true);
        const avg = vsum / volsum;
        const free = fsum / volsum;
        setLinkSpeedsSelected({
            linkId: matchedIds.join('|'),
            avgSpeed: Number(avg.toFixed(2)),
            freespeed: Number(free.toFixed(2)),
            congestionIndex: free ? Number((avg / free).toFixed(4)) : null,
            dailyVolume: Number(props.daily_avg_volume) || 0,
            modes: props.modes || '',
        });
    }, [featureSelection, isGraphExpanded, setLinkSpeedsSelected, dataVersion]);

    return null;
}
