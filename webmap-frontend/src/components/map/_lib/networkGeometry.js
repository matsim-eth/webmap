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
 * Only the newest (dataset, canton) is kept. A canton network is tens of MB
 * parsed, and the previous behaviour already peaked at two copies (one per
 * hook), so a single entry is strictly cheaper than what it replaces.
 */

import {
  mergeSegmentsByGeometry,
  decorateLineVolumesFromPerId,
  decoratePerIdMinMax,
} from './pipeProps';

// { key, geo, promise } — `geo` set once resolved, `promise` while in flight.
let entry = { key: null, geo: null, promise: null };

const cacheKey = (datasetId, canton) => `${datasetId ?? ''}:${canton ?? ''}`;

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
export async function loadNetworkGeometry(loadWithFallback, datasetId, canton) {
  const key = cacheKey(datasetId, canton);
  if (entry.key === key) {
    if (entry.geo) return entry.geo;
    if (entry.promise) return entry.promise;
  }

  const promise = (async () => {
    const geo = await loadWithFallback(`matsim/${canton}_merged_segments.geojson`);
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

  entry = { key, geo: null, promise };

  try {
    const geo = await promise;
    if (entry.key === key) {
      entry = geo?.features?.length
        ? { key, geo, promise: null }
        : { key: null, geo: null, promise: null };
    }
    return geo;
  } catch (err) {
    if (entry.key === key) entry = { key: null, geo: null, promise: null };
    throw err;
  }
}

/**
 * Drop the cached geometry so the next load refetches — the escape hatch behind
 * the sidebar's Reset button, for when a dataset's assets changed underneath a
 * live session (the cache key only tracks dataset + canton).
 *
 * An in-flight load is left alone: its awaiting callers still need it, and
 * clearing it would only make the next consumer refetch the file already on the
 * wire.
 */
export function clearNetworkGeometryCache() {
  if (entry.promise) return;
  entry = { key: null, geo: null, promise: null };
}
