import { useEffect, useRef, useCallback, useState } from 'react';
import { useApp } from '../../context/AppContext';
import { handle401 } from '../../utils/auth';

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

// Build the two feature sets (sub + aggregated) from the fetched linksMap.
function buildFeatures(features, linksMap) {
    let totVolSpeed = 0, totVolFree = 0, totVol = 0, linkCount = 0;
    const subFeatures = [];
    const aggFeatures = [];

    for (const f of features) {
        const keys = (f.properties?.per_id_keys || '').split('|').filter(Boolean);
        const arrows = (f.properties?.per_id_arrows || '').split('|').filter(Boolean);

        const perDir = {
            '\u2192': { vsum: 0, fsum: 0, volsum: 0, count: 0, ids: [] },
            '\u2190': { vsum: 0, fsum: 0, volsum: 0, count: 0, ids: [] },
        };
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const arrow = arrows[i];
            const d = linksMap[k];
            const bucket = perDir[arrow];
            if (!bucket) continue;
            if (d && d.volume && d.avg_speed != null && d.freespeed) {
                bucket.vsum += d.avg_speed * d.volume;
                bucket.fsum += d.freespeed * d.volume;
                bucket.volsum += d.volume;
                bucket.count += 1;
                bucket.ids.push(k);
            }
        }

        const hasRight = perDir['\u2192'].volsum > 0;
        const hasLeft = perDir['\u2190'].volsum > 0;
        if (!hasRight && !hasLeft) continue;
        const needsOffset = hasRight && hasLeft;

        const aggVsum = perDir['\u2192'].vsum + perDir['\u2190'].vsum;
        const aggFsum = perDir['\u2192'].fsum + perDir['\u2190'].fsum;
        const aggVol = perDir['\u2192'].volsum + perDir['\u2190'].volsum;
        const aggIds = [...perDir['\u2192'].ids, ...perDir['\u2190'].ids];
        const aggAvg = aggVol ? aggVsum / aggVol : null;
        const aggFree = aggVol ? aggFsum / aggVol : null;
        const aggCong = aggFree ? aggAvg / aggFree : null;
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
                ls_link_ids: aggIds.join('|'),
            },
        });

        for (const arrow of ['\u2192', '\u2190']) {
            const p = perDir[arrow];
            if (p.volsum === 0) continue;
            const avg = p.vsum / p.volsum;
            const free = p.fsum / p.volsum;
            const cong = free ? avg / free : null;

            totVolSpeed += p.vsum;
            totVolFree += p.fsum;
            totVol += p.volsum;
            linkCount += p.count;

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

    return {
        subFeatures,
        aggFeatures,
        summary: {
            totalLinks: linkCount,
            avgSpeed: totVol ? Number((totVolSpeed / totVol).toFixed(2)) : null,
            avgFreespeed: totVol ? Number((totVolFree / totVol).toFixed(2)) : null,
            congestionIndex: totVolFree ? Number((totVolSpeed / totVolFree).toFixed(4)) : null,
            totalVolume: Math.round(totVol),
        },
    };
}

export default function useLinkSpeedsLayers({ mapRef, mapReady }) {
    const {
        isGraphExpanded,
        clickedCanton,
        featureGeoJSON,
        datasetId,
        timeRange,
        linkSpeedsMetric,
        linkSpeedsRoadTypes,
        featureSelection,
        setLinkSpeedsSelected,
        setLinkSpeedsSummary,
    } = useApp();

    // Cache fetched links keyed by canton+timeRange+dataset so that road-type
    // and metric changes don't trigger a re-fetch from the backend.
    const cacheRef = useRef({ key: null, links: null });
    // Filtered linksMap available to the selection effect.
    const filteredLinksRef = useRef({});
    // Version bump so the selection effect re-runs after data arrives.
    const [dataVersion, setDataVersion] = useState(0);

    const removeOverlay = useCallback((map) => {
        [SPEEDS_LABELS_RIGHT, SPEEDS_LABELS_LEFT, SPEEDS_LAYER_ID, SPEEDS_AGG_LAYER_ID].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource(SPEEDS_SOURCE_ID)) map.removeSource(SPEEDS_SOURCE_ID);
        if (map.getSource(SPEEDS_AGG_SOURCE_ID)) map.removeSource(SPEEDS_AGG_SOURCE_ID);
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

        // Fade base network-layer underneath (synchronously, so no flash).
        if (map.getLayer('network-layer')) {
            map.setPaintProperty('network-layer', 'line-color', '#ccc');
            map.setPaintProperty('network-layer', 'line-width', 1.5);
            map.setPaintProperty('network-layer', 'line-opacity', 0.3);
        }
    }, []);

    useEffect(() => {
        if (!mapReady || !mapRef.current) return;
        const map = mapRef.current;

        if (isGraphExpanded !== 'LinkSpeeds') {
            removeOverlay(map);
            setLinkSpeedsSummary(null);
            setLinkSpeedsSelected(null);
            filteredLinksRef.current = {};
            return;
        }

        if (!clickedCanton || !featureGeoJSON?.features) return;

        // Set up symbology synchronously — no flash while fetch is in flight.
        ensureLayers(map, linkSpeedsMetric);

        const [tr0, tr1] = timeRange || [0, 96];
        const minuteStart = tr0 * 15;
        const minuteEnd = tr1 * 15;
        const cacheKey = `${datasetId}:${clickedCanton}:${minuteStart}:${minuteEnd}`;
        const rtFilter = (linkSpeedsRoadTypes && !linkSpeedsRoadTypes.includes('all'))
            ? new Set(linkSpeedsRoadTypes)
            : null;

        const qs = new URLSearchParams({
            canton: String(clickedCanton),
            minute_start: String(minuteStart),
            minute_end: String(minuteEnd),
        });
        const url = `/backend/data/${datasetId}/link_speeds.json?${qs.toString()}`;

        let cancelled = false;

        (async () => {
            let allLinks = cacheRef.current.key === cacheKey ? cacheRef.current.links : null;

            if (!allLinks) {
                let res;
                try {
                    res = await fetch(url);
                    if (res.status === 401) {
                        const ok = await handle401();
                        if (!ok) return;
                        res = await fetch(url);
                    }
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                } catch (err) {
                    console.warn('Failed to fetch link speeds:', err);
                    return;
                }
                const data = await res.json();
                if (cancelled) return;
                if (data.error) {
                    console.warn('Link speeds error:', data.error);
                    return;
                }
                allLinks = data.links || {};
                cacheRef.current = { key: cacheKey, links: allLinks };
            }

            const linksMap = rtFilter
                ? Object.fromEntries(
                    Object.entries(allLinks).filter(([, d]) => d && rtFilter.has(d.road_type))
                )
                : allLinks;

            const { subFeatures, aggFeatures, summary } = buildFeatures(featureGeoJSON.features, linksMap);

            if (cancelled) return;

            setLinkSpeedsSummary(summary);
            filteredLinksRef.current = linksMap;
            setDataVersion(v => v + 1);

            const aggSrc = map.getSource(SPEEDS_AGG_SOURCE_ID);
            const subSrc = map.getSource(SPEEDS_SOURCE_ID);
            if (aggSrc) aggSrc.setData({ type: 'FeatureCollection', features: aggFeatures });
            if (subSrc) subSrc.setData({ type: 'FeatureCollection', features: subFeatures });
        })();

        return () => {
            cancelled = true;
        };
    // linkSpeedsMetric intentionally excluded — it only changes paint (handled
    // by the separate metric-change effect below) and shouldn't trigger a refetch.
    }, [
        mapReady, mapRef, isGraphExpanded, clickedCanton, featureGeoJSON,
        datasetId, timeRange, linkSpeedsRoadTypes,
        removeOverlay, ensureLayers,
        setLinkSpeedsSelected, setLinkSpeedsSummary,
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
        if (isGraphExpanded === 'LinkSpeeds') {
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
        const sel = featureSelection;
        const props = sel?.feature?.properties;
        if (!props) {
            setLinkSpeedsSelected(null);
            return;
        }
        const keys = (props.per_id_keys || '').split('|').filter(Boolean);
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
        if (!volsum) { setLinkSpeedsSelected(null); return; }
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
