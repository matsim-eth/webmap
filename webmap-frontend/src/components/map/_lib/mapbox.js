/**
 * Imperative Mapbox helpers shared by every layer hook.
 *
 * Every helper guards against the layer/source being missing — Mapbox throws
 * if you remove or query a non-existent id, and the layer hooks need to be
 * idempotent (they re-run on mode/canton changes that may have already torn
 * the layers down). Each helper accepts either a single id or an array.
 */

const toArray = (idOrIds) => Array.isArray(idOrIds) ? idOrIds : [idOrIds];

/** Remove each layer that currently exists. No-op for missing ids. */
export const safeRemoveLayer = (map, idOrIds) => {
  if (!map) return;
  for (const id of toArray(idOrIds)) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
};

/** Remove each source that currently exists. No-op for missing ids. */
export const safeRemoveSource = (map, idOrIds) => {
  if (!map) return;
  for (const id of toArray(idOrIds)) {
    if (map.getSource(id)) map.removeSource(id);
  }
};

/**
 * setData when the source already exists, addSource otherwise. Always uses
 * the geojson source type — the only kind these layer hooks add.
 * Pass extra source options (e.g. `{ generateId: true }`) via `extra`.
 */
export const setOrAddSource = (map, id, geojson, extra) => {
  if (!map) return;
  const existing = map.getSource(id);
  if (existing) {
    existing.setData(geojson);
  } else {
    map.addSource(id, { type: 'geojson', data: geojson, ...(extra || {}) });
  }
};

/** Add a layer only if its id is not already present. */
export const addLayerOnce = (map, layerSpec, beforeId) => {
  if (!map || !layerSpec?.id) return;
  if (map.getLayer(layerSpec.id)) return;
  if (beforeId && map.getLayer(beforeId)) {
    map.addLayer(layerSpec, beforeId);
  } else {
    map.addLayer(layerSpec);
  }
};

/**
 * Bind a Mapbox layer event and return a cleanup that unbinds it. Designed
 * for direct use as a useEffect cleanup (`return onLayer(...)`).
 */
export const onLayer = (map, eventName, layerId, handler) => {
  if (!map) return () => {};
  map.on(eventName, layerId, handler);
  return () => map.off(eventName, layerId, handler);
};

/** Set 'visibility' layout property on each existing layer. */
export const setVisibility = (map, idOrIds, visible) => {
  if (!map) return;
  const v = visible ? 'visible' : 'none';
  for (const id of toArray(idOrIds)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
};

/** Set the same filter expression on each existing layer. */
export const setFilter = (map, idOrIds, filter) => {
  if (!map) return;
  for (const id of toArray(idOrIds)) {
    if (map.getLayer(id)) map.setFilter(id, filter);
  }
};
