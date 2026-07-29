/**
 * Shared loader + cache for the per-canton merged network geometry
 * (`matsim/{canton}_merged_segments.geojson`).
 *
 * Every network module draws the SAME MATSim links and only changes the
 * symbology: Network / Volumes / VolumeFlow / NodeFlows / LinkSpeeds go through
 * `useNetworkLayers`, and Transit Volumes styles the same links by PT volume
 * (`pt_link_volumes.link_id` IS a `network_links.link_id`; the `pt_*` stop
 * pseudo-links simply never match a geometry feature). Transit Volumes used to
 * fetch and parse its own copy, so entering it after a road module downloaded
 * the same tens-of-MB asset twice — and switching back downloaded it a third
 * time, because `useNetworkLayers` drops `network-source` while another
 * module owns the map.
 *
 * This module makes the geometry a per-(dataset, canton) singleton: fetched,
 * merged and decorated exactly once, then shared by reference. Concurrent
 * callers await the same in-flight promise; failures are not cached so a retry
 * can still succeed.
 *
 * Two entries are kept, because the road Volumes module asks for the major-roads
 * subset (~1/5 the size) while every other module needs the full network — one
 * entry would make each switch between them a refetch. A canton network is tens
 * of MB parsed, and the pre-cache behaviour already peaked at two copies (one
 * per hook), so this is not a memory regression.
 */

import {
  mergeSegmentsByGeometry,
  decorateLineVolumesFromPerId,
  decoratePerIdMinMax,
} from './pipeProps';

// Entries keyed `dataset:canton:variant`, newest last (LRU). Two are kept so the
// road Volumes module's major-roads subset and the full network other modules
// need can both stay warm — toggling "major roads only", or hopping Volumes ↔
// Network, then costs no download.
const MAX_ENTRIES = 2;
const entries = new Map(); // key → { geo, promise }

const cacheKey = (datasetId, canton, major) =>
  `${datasetId ?? ''}:${canton ?? ''}:${major ? 'major' : 'all'}`;

const touch = (key, value) => {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
};

/**
 * Load (or return the cached) merged network geometry for a canton.
 *
 * Returns the same mutable FeatureCollection every module works on — the road
 * modules bake their time-windowed volumes onto its features in place, which is
 * already how they share it among themselves. Read-only consumers get a
 * `sourceHasDailyAvgs` flag (see below) so they can tell what the *file*
 * shipped from what a module later baked on.
 *
 * @param {(relativePath: string) => Promise<any>} loadWithFallback
 * @param {string|number} datasetId
 * @param {string} canton  canton name used in the asset path
 * @returns {Promise<object|null>} the FeatureCollection, or whatever falsy
 *   value the loader produced (never cached)
 */
export async function loadNetworkGeometry(loadWithFallback, datasetId, canton, major = false) {
  const key = cacheKey(datasetId, canton, major);
  const hit = entries.get(key);
  if (hit) {
    touch(key, hit);
    if (hit.geo) return hit.geo;
    if (hit.promise) return hit.promise;
  }

  const promise = (async () => {
    // ?major=1 asks the backend for only the links MAJOR_ROADS_FILTER shows.
    // The CDN fallback ignores the query string and serves the full network,
    // which is still correct — just larger; the map filter narrows it anyway.
    const path = `matsim/${canton}_merged_segments.geojson${major ? '?major=1' : ''}`;
    const geo = await loadWithFallback(path);
    if (!geo?.features?.length) return geo;

    // Does the SOURCE file ship per-link daily volumes? Recorded before any
    // module bakes its own onto the shared features (useNetworkLayers rewrites
    // `per_id_daily_avgs` from the backend traffic volumes while in Volumes),
    // so a consumer that must not see road volumes — Transit Volumes, whose
    // numbers come from pt_link_volumes — can tell the two apart instead of
    // sniffing the property. True on the legacy CDN asset, false on v2 (the
    // backend serves geometry only). First feature only, same assumption
    // mergeSegmentsByGeometry makes about a file having one shape.
    geo.sourceHasDailyAvgs = geo.features[0]?.properties?.per_id_daily_avgs != null;

    // Merge the stripped per-link format (CDN fallback / legacy datasets) into
    // one feature per visual segment; no-op when already merged. Then derive
    // the scalars every downstream hook filters and offsets on.
    geo.features = mergeSegmentsByGeometry(geo.features);
    decorateLineVolumesFromPerId(geo.features);
    decoratePerIdMinMax(geo.features);
    return geo;
  })();

  touch(key, { geo: null, promise });

  try {
    const geo = await promise;
    if (geo?.features?.length) touch(key, { geo, promise: null });
    else entries.delete(key); // nothing usable — don't cache it
    return geo;
  } catch (err) {
    entries.delete(key); // failures aren't cached, so a retry can still succeed
    throw err;
  }
}

/**
 * Is this variant already parsed and in the cache — i.e. would `loadNetworkGeometry`
 * resolve without a download? Lets callers tell "fetch a canton's network" from
 * "hand the same object to Mapbox again" and skip the loading overlay for the
 * latter. In-flight loads count as a miss: the caller still has to wait.
 */
export const hasNetworkGeometry = (datasetId, canton, major = false) =>
  !!entries.get(cacheKey(datasetId, canton, major))?.geo;

/**
 * Warm a variant into the cache in the background, without blocking the caller.
 *
 * The road Volumes module opens on the major-roads subset (~1/5 the payload),
 * which is what makes its first paint fast — but every other network module
 * needs the full network, so leaving Volumes used to pay a full download right
 * when the user was mid-interaction. Kicking the full variant off once the map
 * has settled moves that download into dead time: by the time the user switches,
 * `loadNetworkGeometry` is a cache hit and the switch costs only a re-tile.
 *
 * Best-effort by design: no-op when the key is already cached or in flight,
 * errors are swallowed (the real load will surface them), and it is scheduled
 * through `requestIdleCallback` so it never competes with the first paint. Note
 * the parse + merge of a big canton is still main-thread work that can't be
 * preempted once started — idle time only decides *when* it starts.
 */
export function prefetchNetworkGeometry(loadWithFallback, datasetId, canton, major = false) {
  if (!loadWithFallback || !canton) return;
  const key = cacheKey(datasetId, canton, major);
  if (entries.has(key)) return; // already cached, or a load is in flight

  const start = () => {
    if (entries.has(key)) return; // someone asked for it for real in the meantime
    loadNetworkGeometry(loadWithFallback, datasetId, canton, major).catch(() => {});
  };

  if (typeof requestIdleCallback === 'function') {
    // The timeout keeps a permanently busy tab from starving the prefetch
    // forever; 10 s is well past the point where the initial render settled.
    requestIdleCallback(start, { timeout: 10000 });
  } else {
    setTimeout(start, 2000);
  }
}

/**
 * Drop the cached geometry so the next load refetches — the escape hatch behind
 * the sidebar's Reset button, for when a dataset's assets changed underneath a
 * live session (the cache key only tracks dataset, canton and variant).
 *
 * In-flight loads are left alone: their awaiting callers still need them, and
 * dropping one would only make the next consumer refetch the file already on
 * the wire.
 */
export function clearNetworkGeometryCache() {
  for (const [key, value] of entries) {
    if (!value.promise) entries.delete(key);
  }
}
