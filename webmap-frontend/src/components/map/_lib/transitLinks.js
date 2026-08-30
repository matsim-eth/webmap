/**
 * Which network links can carry public transit, judged from the link's own
 * `modes` — no volume data required.
 *
 * This is what lets Transit Volumes draw its links before the (large) per-line
 * volume payload arrives, the same way the road modules draw the network before
 * `link_traffic_volumes.json` colours it. Measured against dataset 3's
 * `network_links` vs `pt_link_volumes`: the mode test misses **zero** of the
 * 307,774 links that actually carry service, keeps 28% of the network, and
 * over-selects the served set by ~1.6× (~1.4× in Zürich/Luzern). The extra
 * links are ones a PT mode is *allowed* on but no line runs over; they drop out
 * on their own when the volume data lands and replaces the feature set.
 *
 * Tokens are matched exactly (comma-delimited), never as substrings — `pt`
 * must not match `transport`, and `bus` must not match `busway`.
 */

// Every PT-ish mode token present in the MATSim network export, most common
// first. `artificial` / `stopFacilityLink` are deliberately absent: they are
// structural markers that always co-occur with a real mode (`artificial,bus`,
// `artificial,rail`), so including them would add nothing but noise.
export const TRANSIT_LINK_MODES = [
  'bus', 'pt', 'rail', 'tram', 'subway', 'light_rail', 'train',
  'funicular', 'ferry', 'cable car',
];

const TRANSIT_MODE_SET = new Set(TRANSIT_LINK_MODES);

/** True when a feature's `modes` (comma string or array) names a transit mode. */
export const hasTransitMode = (modes) => {
  if (!modes) return false;
  const tokens = Array.isArray(modes) ? modes : String(modes).split(',');
  for (const token of tokens) {
    if (TRANSIT_MODE_SET.has(String(token).trim())) return true;
  }
  return false;
};

/** The subset of network features a transit line could run on. */
export const filterTransitFeatures = (features) =>
  (features || []).filter((f) => hasTransitMode(f?.properties?.modes));

/**
 * Just the transit tokens of a link's `modes`, dropping car/truck/taxi/etc.
 * Used as the mode list for links that carry no service, so the module's mode
 * filter still places them (a ferry link with no volume rows is still a ferry
 * link) without claiming they are road links.
 */
export const transitModesOf = (modes) => {
  if (!modes) return [];
  const tokens = Array.isArray(modes) ? modes : String(modes).split(',');
  const out = [];
  for (const token of tokens) {
    const t = String(token).trim();
    if (TRANSIT_MODE_SET.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
};
