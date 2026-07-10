/**
 * Config-as-data for the reusable socioeconomic (person) filter panel.
 *
 * `SocioFilterPanel` is a controlled, presentational component driven entirely
 * by these option lists and the small pure helpers below. Keeping the option
 * lists + the filters→query-params mapping here (rather than inside the
 * component) means both the webmap and, later, the dashboard can share one
 * source of truth for the backend contract.
 *
 * Backend contract (zone_flows.json and future providers):
 *   - gender:        "0" (male) | "1" (female)   — omitted for "all"
 *   - age_min:       inclusive int               — omitted when 0
 *   - age_max:       exclusive int               — omitted when >= AGE_SLIDER_MAX
 *   - income_class:  comma-separated ints 1..8
 *   - subscription:  comma-separated subset of ga,halbtax,verbund,strecke,gleis7,junior,other
 */

// [0, AGE_SLIDER_MAX] means "no age filter". Because age_max is exclusive, an
// upper handle sitting at AGE_SLIDER_MAX sends no age_max at all.
export const AGE_SLIDER_MAX = 100;

export const DEFAULT_SOCIO_FILTERS = {
  gender: 'all',
  ageRange: [0, AGE_SLIDER_MAX],
  incomeClasses: [], // empty = no filter
  subscriptions: [], // empty = no filter
};

export const GENDER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: '0', label: 'Male' },
  { value: '1', label: 'Female' },
];

export const INCOME_OPTIONS = Array.from({ length: 8 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

export const SUBSCRIPTION_OPTIONS = [
  { value: 'ga', label: 'GA' },
  { value: 'halbtax', label: 'Halbtax' },
  { value: 'verbund', label: 'Verbund' },
  { value: 'strecke', label: 'Strecke' },
  { value: 'gleis7', label: 'Gleis 7' },
  { value: 'junior', label: 'Junior' },
  { value: 'other', label: 'Other' },
];

/**
 * Build the query-param object for the backend, including ONLY active keys.
 * Returns {} when nothing is active.
 */
export const socioFiltersToParams = (filters) => {
  const f = filters || DEFAULT_SOCIO_FILTERS;
  const params = {};

  if (f.gender && f.gender !== 'all') params.gender = f.gender;

  const [ageMin, ageMax] = f.ageRange || [0, AGE_SLIDER_MAX];
  if (ageMin > 0) params.age_min = String(ageMin);
  if (ageMax < AGE_SLIDER_MAX) params.age_max = String(ageMax);

  if (f.incomeClasses && f.incomeClasses.length) {
    params.income_class = f.incomeClasses.join(',');
  }
  if (f.subscriptions && f.subscriptions.length) {
    params.subscription = f.subscriptions.join(',');
  }

  return params;
};

/** One count per active dimension (gender, age, income, subscriptions). */
export const countActiveSocioFilters = (filters) => {
  const f = filters || DEFAULT_SOCIO_FILTERS;
  let n = 0;
  if (f.gender && f.gender !== 'all') n += 1;
  const [ageMin, ageMax] = f.ageRange || [0, AGE_SLIDER_MAX];
  if (ageMin > 0 || ageMax < AGE_SLIDER_MAX) n += 1;
  if (f.incomeClasses && f.incomeClasses.length) n += 1;
  if (f.subscriptions && f.subscriptions.length) n += 1;
  return n;
};

/** True when the filters equal the default (nothing active). */
export const isSocioDefault = (filters) => countActiveSocioFilters(filters) === 0;
