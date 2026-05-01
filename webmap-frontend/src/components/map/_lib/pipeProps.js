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
