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
 *   - income_class:  comma-separated ints 0..8
 *   - subscription:  comma-separated subset of ga,halbtax,verbund,strecke,gleis7,junior,other
 */

// [0, AGE_SLIDER_MAX] means "no age filter". Because age_max is exclusive, an
// upper handle sitting at AGE_SLIDER_MAX sends no age_max at all.
export const AGE_SLIDER_MAX = 100;

// Household income classes are the microcensus survey categories 0..8:
// class i covers [INCOME_CLASS_BOUNDS[i], INCOME_CLASS_BOUNDS[i+1]) CHF/month,
// with class 8 open-ended ("more than 16000" — synthetic incomes in it are
// merely *sampled* up to 18000, so it is labelled 16k+, not 16–18k).
// The income slider's integer positions are indices into these boundaries:
// a handle at position p sits on the class-p lower bound; position
// INCOME_SLIDER_MAX (= 9) is the open top of class 8. Selecting [lo, hi]
// therefore means income classes lo..hi-1, and [0, 9] means "no filter".
export const INCOME_CLASS_BOUNDS = [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000];
export const INCOME_SLIDER_MAX = INCOME_CLASS_BOUNDS.length; // 9

const chf = (v) => (v >= 1000 ? `${v / 1000}k` : String(v));

/** Slider tick-mark labels ({position: label}) for rc-slider `marks`. */
export const AGE_SLIDER_MARKS = Object.fromEntries(
  Array.from({ length: AGE_SLIDER_MAX / 20 + 1 }, (_, i) => [i * 20, String(i * 20)])
);

// Label every second class boundary so the narrow sidebar doesn't get crowded.
// Position 9 (the open top of class 8) keeps just its dot — the live row label
// reads "16k+" when a handle sits there.
export const INCOME_SLIDER_MARKS = Object.fromEntries(
  INCOME_CLASS_BOUNDS.flatMap((v, i) => (i % 2 === 0 ? [[i, chf(v)]] : []))
);

/** Human label for an income slider range, e.g. "2k – 8k CHF" or "16k+ CHF". */
export const incomeRangeLabel = ([lo, hi]) => {
  if (lo <= 0 && hi >= INCOME_SLIDER_MAX) return 'All';
  if (hi >= INCOME_SLIDER_MAX) return `${chf(INCOME_CLASS_BOUNDS[lo])}+ CHF`;
  if (lo <= 0) return `< ${chf(INCOME_CLASS_BOUNDS[hi])} CHF`;
  return `${chf(INCOME_CLASS_BOUNDS[lo])} – ${chf(INCOME_CLASS_BOUNDS[hi])} CHF`;
};

export const DEFAULT_SOCIO_FILTERS = {
  gender: 'all',
  ageRange: [0, AGE_SLIDER_MAX],
  incomeRange: [0, INCOME_SLIDER_MAX], // full range = no filter
  subscriptions: [], // empty = no filter
};

export const GENDER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: '0', label: 'Male' },
  { value: '1', label: 'Female' },
];

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

  const [incLo, incHi] = f.incomeRange || [0, INCOME_SLIDER_MAX];
  if (incLo > 0 || incHi < INCOME_SLIDER_MAX) {
    const classes = [];
    for (let c = incLo; c < incHi; c += 1) classes.push(c);
    params.income_class = classes.join(',');
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
  const [incLo, incHi] = f.incomeRange || [0, INCOME_SLIDER_MAX];
  if (incLo > 0 || incHi < INCOME_SLIDER_MAX) n += 1;
  if (f.subscriptions && f.subscriptions.length) n += 1;
  return n;
};

/** True when the filters equal the default (nothing active). */
export const isSocioDefault = (filters) => countActiveSocioFilters(filters) === 0;
