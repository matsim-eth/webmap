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

// Bumped by clearPtVolumeCache. A load that started in an earlier epoch derived
// its bundle from geometry that has since been discarded, so its result must not
// be cached even though its awaiting callers still get it.
let epoch = 0;

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

  const loadEpoch = epoch;
  const promise = (async () => {
    const path = `matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${canton}.json`;
    const volumeJSON = await loadWithFallback(path);
    if (!volumeJSON) return null;
    return prepare(volumeJSON);
  })();

  entry = { key, bundle: null, promise };

  // Identity, not key equality: after a clear, a *newer* load for the same
  // canton may already own the entry, and this (now stale) one must not touch it.
  const owned = () => entry.promise === promise;

  try {
    const bundle = await promise;
    if (owned()) {
      entry = bundle && loadEpoch === epoch
        ? { key, bundle, promise: null }
        : { key: null, bundle: null, promise: null };
    }
    return bundle;
  } catch (err) {
    if (owned()) entry = { key: null, bundle: null, promise: null };
    throw err;
  }
}

/**
 * Drop the cached bundle. Called from `useFullReset` alongside
 * `clearNetworkGeometryCache` — the bundle points into that geometry, so the
 * two must never be cleared independently.
 *
 * An in-flight load keeps running (its awaiting callers still need a result),
 * but the epoch bump stops its bundle from being *cached*: it was derived from
 * geometry the companion clear has already discarded, so caching it would leave
 * the next entry reusing features detached from the freshly refetched geometry.
 */
export function clearPtVolumeCache() {
  epoch++;
  entry = { key: null, bundle: null, promise: null };
}
