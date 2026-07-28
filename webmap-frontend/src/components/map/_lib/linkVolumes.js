import { handle401 } from '../../../utils/auth';

// Per-link daily volumes, keyed by `${datasetId}:${canton}`. Value is a
// Promise<Map<linkId, volume>|null> so concurrent callers dedupe. The v2
// per-link geometry asset carries no baked volume attribute, so the flow
// modules (VolumeFlow, NodeFlows) derive it from the link_volumes endpoint to
// hide links that carry no trips — a volume-0 gate that also drops artificial /
// synthetic connector links (they have no car volume). Shared across modules so
// the fetch + cache happen once per (dataset, canton).
// Deliberately NOT socio-filtered: link_volumes.json comes from the precomputed
// link_speeds table, which has no person dimension.
const linkVolumesCache = new Map();

export function fetchLinkVolumes(datasetId, canton) {
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
    return p;
}

// Per-link routed-trip counts, keyed by `${datasetId}:${canton}:${socioQuery}`.
// Same shape as fetchLinkVolumes (Promise<Map<linkId, count>|null>), but the
// number is the spider "Total Trips" for that link — the count VolumeFlow shows
// in Segment Info — rather than the link_speeds vehicle volume. VolumeFlow
// filters the displayed network on it so every clickable link actually has a
// spider to draw; volume > 0 was a weaker test (link_speeds counts vehicles that
// have no entry in the spider index, so those links opened an empty spider).
// Socio-filtered, unlike volumes: the spider queries are, so the two must agree.
const linkTripsCache = new Map();

export function fetchLinkTripCounts(datasetId, canton, socioParams = {}) {
    const query = new URLSearchParams({ canton });
    for (const [k, v] of Object.entries(socioParams)) query.set(k, v);
    const socioKey = new URLSearchParams(socioParams).toString();
    const key = `${datasetId}:${canton}:${socioKey}`;
    if (linkTripsCache.has(key)) return linkTripsCache.get(key);
    const url = `/backend/data/${datasetId}/spider_link_trips.json?${query.toString()}`;
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
            if (data.error) { console.warn('spider_link_trips error:', data.error); return null; }
            const links = data.links || {};
            return new Map(Object.entries(links).map(([k, v]) => [String(k), Number(v)]));
        } catch (err) {
            console.warn('Failed to fetch link trip counts:', err);
            linkTripsCache.delete(key);
            return null;
        }
    })();
    linkTripsCache.set(key, p);
    return p;
}
