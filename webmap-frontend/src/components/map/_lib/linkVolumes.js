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
