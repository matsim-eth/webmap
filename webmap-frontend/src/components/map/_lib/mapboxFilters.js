/**
 * Filter-expression builders used by useFeatureSelectionFocus to translate
 * sidebar table queries into Mapbox filter syntax. Extracted from the focus
 * hook so other modules (LinkSpeeds map filter, future per-module filters)
 * can reuse the same column ↔ property mapping.
 */

/**
 * Filter for "links a user can click / that should render" in the
 * VolumeFlow / NodeFlows / LinkSpeeds modules.
 *
 * - When `modes` is present (the enriched per-canton `merged_segments` from the
 *   backend `network_links`, and old merged-visual-segment datasets), clickable
 *   = car links. We no longer require `daily_avg_volume > 0`: the enriched
 *   geometry carries no baked per-link volume (the modules fetch speeds/volumes
 *   from their own endpoints), so a volume gate would hide everything.
 * - When `modes` is absent (the thin static_asset blob served as a fallback for
 *   datasets without `network_links`), the second branch shows every link —
 *   visualization then keys purely off `link_id`.
 */
export const CLICKABLE_ROAD_FILTER = ['any',
  ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0],
  ['!', ['has', 'modes']],
];

/**
 * "Major roads only" predicate (Volumes module toggle, feature table, polygon
 * selection). Hierarchy-based: a road is major when its `road_type` (the OSM
 * highway class shipped per segment in the v2 merged_segments) is a
 * motorway/primary/secondary class — the same classes the Link Speeds
 * road-type filter exposes; the `_link` variants keep ramps attached.
 *
 * The old `capacity > 1200` test survives only as a per-feature fallback for
 * untagged data (legacy CDN geojson, datasets whose network XML lacked the
 * type attribute → road_type "unknown"). A pure capacity threshold chops
 * corridors mid-way (primary links dip to capacity 0 at signal approaches)
 * and lets isolated minor links through (residential links reach 1800).
 */
export const MAJOR_ROAD_TYPES = [
  'motorway', 'motorway_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
];

const RT = ['get', 'road_type'];
const HAS_ROAD_TYPE = ['all',
  ['==', ['typeof', RT], 'string'],
  ['!=', RT, 'unknown'],
  ['!=', RT, ''],
];

export const MAJOR_ROADS_FILTER = ['case',
  HAS_ROAD_TYPE, ['match', RT, MAJOR_ROAD_TYPES, true, false],
  ['>', ['get', 'capacity'], 1200],
];

/** JS twin of MAJOR_ROADS_FILTER for row/feature arrays outside Mapbox. */
export const isMajorRoad = (props) => {
  const rt = props?.road_type;
  if (typeof rt === 'string' && rt && rt !== 'unknown') {
    return MAJOR_ROAD_TYPES.includes(rt);
  }
  const cap = Number(props?.capacity);
  return Number.isFinite(cap) && cap > 1200;
};

/** Operator + value + getter expression → Mapbox comparison filter. */
export const buildComparisonFilter = (operator, value, expression) => {
  switch (operator) {
    case '>':  return ['>',  expression, value];
    case '<':  return ['<',  expression, value];
    case '>=': return ['>=', expression, value];
    case '<=': return ['<=', expression, value];
    default:   return ['==', expression, value];
  }
};

/**
 * Sidebar column id → underlying pipe-delimited property name.
 * Returns null for columns without a per_id_* counterpart.
 */
export const getPropertyName = (column) => {
  const columnMap = {
    capacity:    'per_id_capacities',
    length:      'per_id_lengths',
    freeSpeed:   'per_id_freespeeds',
    totalVol:    'per_id_daily_avgs',
    directionId: 'per_id_keys',
  };
  return columnMap[column] || null;
};

/**
 * Build a comparison filter against a pipe-delimited property by reading
 * the precomputed `_min`/`_max` scalar properties (see decoratePerIdMinMax).
 *
 * Semantics match "show segments where AT LEAST ONE per-link value satisfies
 * the comparison": `>` checks the max, `<` checks the min, `==` checks that
 * the value sits inside [min, max].
 *
 * For non-numeric pipe properties (e.g. per_id_keys) we fall back to a
 * substring index-of match.
 */
export const buildPipeDelimitedComparison = (operator, value, propName) => {
  const minMaxMap = {
    per_id_capacities:  { min: 'capacity_min',  max: 'capacity_max' },
    per_id_lengths:     { min: 'length_min',    max: 'length_max' },
    per_id_freespeeds:  { min: 'freespeed_min', max: 'freespeed_max' },
    per_id_daily_avgs:  { min: 'volume_min',    max: 'volume_max' },
  };

  const props = minMaxMap[propName];
  if (!props) {
    return ['>=', ['index-of', String(value), ['to-string', ['get', propName]]], 0];
  }

  switch (operator) {
    case '>':
      return ['>',  ['number', ['get', props.max], 0],      value];
    case '<':
      return ['<',  ['number', ['get', props.min], 999999], value];
    case '>=':
      return ['>=', ['number', ['get', props.max], 0],      value];
    case '<=':
      return ['<=', ['number', ['get', props.min], 999999], value];
    case '==':
      return ['all',
        ['<=', ['number', ['get', props.min], 999999], value],
        ['>=', ['number', ['get', props.max], 0],      value],
      ];
    default:
      return ['>=', ['index-of', String(value), ['to-string', ['get', propName]]], 0];
  }
};
