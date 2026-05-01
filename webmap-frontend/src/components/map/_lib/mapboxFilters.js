/**
 * Filter-expression builders used by useFeatureSelectionFocus to translate
 * sidebar table queries into Mapbox filter syntax. Extracted from the focus
 * hook so other modules (LinkSpeeds map filter, future per-module filters)
 * can reuse the same column ↔ property mapping.
 */

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
