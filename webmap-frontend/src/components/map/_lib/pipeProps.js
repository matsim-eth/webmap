/**
 * Helpers for the per-segment pipe-delimited properties used by the merged
 * canton network geojson. Each visual segment carries arrays like
 * `per_id_capacities = "300|2000"` — one entry per underlying MATSim link.
 *
 * Mapbox filter expressions can't operate on a pipe-delimited string
 * directly, so we decorate features with `{capacity_min, capacity_max, ...}`
 * up front and let filters reference those scalars.
 */

/** "a|b||c" → ["a","b","c"]. Empty string → []. */
export const parsePipeList = (str) =>
  (str || '').split('|').filter(Boolean);

/** Flatten a feature's geometry to a [[lng,lat], ...] list, or null. */
const featureCoords = (f) => {
  const g = f?.geometry;
  if (g?.type === 'LineString') return g.coordinates;
  if (g?.type === 'MultiLineString') return g.coordinates.flat();
  return null;
};

/**
 * Direction glyph for one link from its own coordinates, matching the old
 * `_arrow_for_segment` preprocessing: westward (start lon > end lon) → "←",
 * otherwise "→". Lets offset rendering split a merged segment into its two
 * opposing directions.
 */
const arrowForCoords = (coords) => {
  if (!coords || coords.length < 2) return '→';
  const [sLon, sLat] = coords[0];
  const [eLon, eLat] = coords[coords.length - 1];
  // East/west by longitude, matching the old `_arrow_for_segment`; fall back to
  // latitude for (near-)vertical links so a reversed pair still gets opposite
  // glyphs (otherwise both land in the same offset bucket and overlap).
  if (sLon !== eLon) return sLon > eLon ? '←' : '→';
  return sLat > eLat ? '←' : '→';
};

/**
 * Direction-independent geometry key, matching the old `_norm_key`: the smaller
 * of the forward and reversed coordinate sequences, so a link and its
 * reversed-coordinate twin hash to the same bucket. Reverse links share the
 * exact same vertex values (same network export), so a raw join is faithful.
 */
const geometryKey = (coords) => {
  const parts = new Array(coords.length);
  for (let i = 0; i < coords.length; i++) parts[i] = coords[i][0] + ',' + coords[i][1];
  const fwd = parts.join(';');
  const rev = parts.slice().reverse().join(';');
  return fwd <= rev ? fwd : rev;
};

/**
 * Merge the new per-link `merged_segments` format (one feature per directed
 * MATSim link with a singular `link_id`, served from the duckdb `static_assets`
 * BLOB) back into one visual segment per shared 2D geometry — the contract every
 * map hook expects. Forward + reverse links collapse into a single clickable
 * segment so VolumeFlow can query both directions at once, the link dropdown
 * returns, and offset rendering can draw the two directions as parallel lines.
 *
 * Each merged feature carries (index-aligned, one entry per underlying link):
 *   per_id_keys       — '|'-joined link ids on the segment
 *   per_id_arrows     — '|'-joined direction glyphs, computed on the fly
 *   per_id_freespeeds — '|'-joined freespeeds (drives freespeed_min/max)
 *   per_id_capacities — '|'-joined capacities (drives capacity_min/max)
 *   per_id_lengths    — '|'-joined lengths (drives length_min/max)
 *   per_id_permlanes  — '|'-joined lane counts (Segment table, per direction)
 *
 * Format-agnostic: if features already carry `per_id_keys` (old merged asset or
 * CDN fallback) the input is returned unchanged. Returns a (possibly new)
 * features array — callers should assign it back. Call before
 * decorateLineVolumesFromPerId / decoratePerIdMinMax.
 */
export const mergeSegmentsByGeometry = (features) => {
  if (!Array.isArray(features) || features.length === 0) return features;
  if (features[0]?.properties?.per_id_keys) return features; // already merged format

  const groups = new Map();
  const singletons = [];
  for (const f of features) {
    const coords = featureCoords(f);
    const linkId = f?.properties?.link_id;
    if (!coords || coords.length < 2 || linkId === undefined || linkId === null) {
      singletons.push(f);
      continue;
    }
    const key = geometryKey(coords);
    let grp = groups.get(key);
    if (!grp) {
      grp = { feature: f, keys: [], arrows: [], freespeeds: [], capacities: [], lengths: [], permlanes: [] };
      groups.set(key, grp);
    }
    const p = f.properties;
    grp.keys.push(String(linkId));
    grp.arrows.push(arrowForCoords(coords));
    grp.freespeeds.push(p.freespeed ?? '');
    grp.capacities.push(p.capacity ?? '');
    grp.lengths.push(p.length ?? '');
    grp.permlanes.push(p.permlanes ?? '');
  }

  const merged = [];
  for (const grp of groups.values()) {
    merged.push({
      type: 'Feature',
      geometry: grp.feature.geometry,
      properties: {
        ...grp.feature.properties,
        per_id_keys: grp.keys.join('|'),
        per_id_arrows: grp.arrows.join('|'),
        per_id_freespeeds: grp.freespeeds.join('|'),
        per_id_capacities: grp.capacities.join('|'),
        per_id_lengths: grp.lengths.join('|'),
        per_id_permlanes: grp.permlanes.join('|'),
      },
    });
  }
  return singletons.length ? merged.concat(singletons) : merged;
};

/**
 * Parse pipe-delimited numbers and return the smallest/largest values, or
 * `{min: null, max: null}` when the string is empty / unparseable.
 */
export const pipeMinMax = (str) => {
  const values = parsePipeList(str).map(Number).filter((v) => !Number.isNaN(v));
  if (values.length === 0) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
};

/**
 * Default mapping from per_id_* property names to the {min, max} property
 * names that filters reference. Matches the convention used by
 * useNetworkLayers and the filter expressions in mapboxFilters.js.
 */
export const PER_ID_FIELDS = [
  { src: 'per_id_capacities', minKey: 'capacity_min', maxKey: 'capacity_max' },
  { src: 'per_id_lengths', minKey: 'length_min', maxKey: 'length_max' },
  { src: 'per_id_freespeeds', minKey: 'freespeed_min', maxKey: 'freespeed_max' },
  { src: 'per_id_daily_avgs', minKey: 'volume_min', maxKey: 'volume_max' },
];

/**
 * Mutate each feature in place: for each `{src, minKey, maxKey}` entry,
 * compute pipeMinMax(props[src]) and assign to props[minKey]/props[maxKey].
 * Pass a custom `fields` array to override the default mapping.
 */
export const decoratePerIdMinMax = (features, fields = PER_ID_FIELDS) => {
  if (!Array.isArray(features)) return;
  for (const f of features) {
    const props = f?.properties;
    if (!props) continue;
    for (const { src, minKey, maxKey } of fields) {
      const { min, max } = pipeMinMax(props[src]);
      props[minKey] = min;
      props[maxKey] = max;
    }
  }
};

/**
 * Decorate each line feature with `left_sum`, `right_sum`,
 * `daily_avg_volume`, and `angle` derived from `per_id_arrows` /
 * `per_id_daily_avgs` and the geometry. Mutates features in place.
 *
 * - `angle` is the bearing of the first→last coord of a LineString in
 *   degrees, range (-180, 180]. Used by Mapbox to decide which side to
 *   offset parallel direction lines.
 * - `left_sum` / `right_sum` aggregate `per_id_daily_avgs` by arrow.
 * - `daily_avg_volume` falls back to `left_sum + right_sum` when the
 *   feature doesn't already carry a numeric value.
 */
export const decorateLineVolumesFromPerId = (features) => {
  if (!Array.isArray(features)) return;
  for (const f of features) {
    if (!f.properties) f.properties = {};
    const props = f.properties;

    // Angle from first→last coord, only if missing.
    if (f.geometry?.type === 'LineString' && f.geometry.coordinates?.length > 1) {
      if (typeof props.angle !== 'number') {
        const coords = f.geometry.coordinates;
        const [x0, y0] = coords[0];
        const [x1, y1] = coords[coords.length - 1];
        const dx = x1 - x0;
        const dy = y1 - y0;
        props.angle = (dx === 0 && dy === 0) ? null : (Math.atan2(dy, dx) * 180 / Math.PI);
      }
    } else {
      props.angle = null;
    }

    const arrows = parsePipeList(props.per_id_arrows);
    const dailyAvgs = parsePipeList(props.per_id_daily_avgs);

    let left = 0;
    let right = 0;
    arrows.forEach((arrow, i) => {
      const v = Number(dailyAvgs[i] ?? 0);
      if (arrow === '←') left += v;
      else if (arrow === '→') right += v;
    });

    const fallbackTotal = left + right;
    const existingTotal = Number(props.daily_avg_volume);
    props.daily_avg_volume = Number.isFinite(existingTotal) ? existingTotal : fallbackTotal;
    props.left_sum = left;
    props.right_sum = right;
  }
};
