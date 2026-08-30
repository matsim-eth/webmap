// Accent/space-insensitive name matching. Mirrors the backend's `norm_name`
// (webmap-backend/providers/zone_registry.py): strip diacritics, lowercase, and
// drop non-alphanumerics — so 'Zurich' matches 'Zürich' and
// 'Appenzell Ausserrhoden' matches 'AppenzellAusserrhoden'.
//
// Needed because the canton the user clicks (`clickedCanton`) is the polygon's
// display NAME ('Zürich', from hot_polygons via tlm_kantonsgebiet), while assets
// keyed per canton (e.g. transit_modes_by_canton.json) use the registry's ASCII
// spelling ('Zurich') — a direct `obj[canton]` lookup misses for accented names.

export const normalizeName = (s) =>
  (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// Look up `key` in `obj` accent/space-insensitively. Exact key first (fast
// path), then a normalized scan. Returns undefined when nothing matches.
export const lookupByName = (obj, key) => {
  if (!obj || key == null) return undefined;
  if (obj[key] !== undefined) return obj[key];
  const target = normalizeName(key);
  if (!target) return undefined;
  for (const k in obj) {
    if (normalizeName(k) === target) return obj[k];
  }
  return undefined;
};
