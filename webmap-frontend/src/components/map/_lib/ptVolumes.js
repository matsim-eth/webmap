/**
 * Loader + cache for the heavy per-canton PT volume payload
 * (`matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_{canton}.json`)
 * and everything Transit Volumes derives from it.
 *
 * This is the module's *second* stage: the map already shows the right links
 * (picked by mode — see `transitLinks.js`) by the time this resolves. It is the
 * expensive half — per link × line × 96 bins, so tens of MB over the wire and a
 * full sweep of the canton's geometry to index it — and it used to be redone
 * from scratch on every entry to the module, because everything lived in the
 * hook's `originalGeoJSON` ref which module exit nulls out. Caching it here
 * makes re-entry free.
 *
 * The caller supplies `prepare(volumeJSON)`, which owns all the derivation (it
 * needs the hook's parsing helpers). The bundle it returns holds **references
 * into the shared network geometry**, so this cache and the geometry cache must
 * be invalidated together — both are single-entry and keyed the same way, and
 * `useFullReset` clears both.
 */

// { key, bundle, promise } — `bundle` set once resolved, `promise` while in flight.
let entry = { key: null, bundle: null, promise: null };

const cacheKey = (datasetId, canton) => `${datasetId ?? ''}:${canton ?? ''}`;

/**
 * @param {(relativePath: string) => Promise<any>} loadWithFallback
 * @param {string|number} datasetId
 * @param {string} canton
 * @param {(volumeJSON: any) => object} prepare  derives the bundle; only called on a miss
 * @returns {Promise<object|null>} the prepared bundle, or null when unavailable
 */
export async function loadPtVolumeBundle(loadWithFallback, datasetId, canton, prepare) {
  const key = cacheKey(datasetId, canton);
  if (entry.key === key) {
    if (entry.bundle) return entry.bundle;
    if (entry.promise) return entry.promise;
  }

  const promise = (async () => {
    const path = `matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${canton}.json`;
    const volumeJSON = await loadWithFallback(path);
    if (!volumeJSON) return null;
    return prepare(volumeJSON);
  })();

  entry = { key, bundle: null, promise };

  try {
    const bundle = await promise;
    if (entry.key === key) {
      entry = bundle
        ? { key, bundle, promise: null }
        : { key: null, bundle: null, promise: null };
    }
    return bundle;
  } catch (err) {
    if (entry.key === key) entry = { key: null, bundle: null, promise: null };
    throw err;
  }
}

/**
 * Drop the cached bundle. Called from `useFullReset` alongside
 * `clearNetworkGeometryCache` — the bundle points into that geometry, so the
 * two must never be cleared independently. An in-flight load is left alone;
 * its awaiting callers still need it.
 */
export function clearPtVolumeCache() {
  if (entry.promise) return;
  entry = { key: null, bundle: null, promise: null };
}
