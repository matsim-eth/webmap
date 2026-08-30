// Swiss study-area fallback for the dashboard. Used whenever the backend's
// study_area.json is unavailable (older backend, CDN-only dataset) OR while it
// is still loading. Every field is built from the dashboard's own static Swiss
// data so behaviour is value-identical to the pre-generalization hardcoded
// values:
//   - zone list  ← canton_alias.json (internal name → display name)
//   - per-zone bbox ← the CANTON_BOUNDS map that used to live in useCantonMap
//   - center/zoom ← the map-init literals that used to live in useCantonMap
//   - crs        ← EPSG:2056 (LV95), the Swiss projected CRS
//
// The object matches the backend study_area.json contract shape exactly, so
// consumers can treat the fallback and a real backend response identically.
// NOTE: packages are intentionally self-contained — this is a dashboard-local
// copy of the webmap's swissDefaults, not an import from webmap-frontend.
import cantonAlias from './canton_alias.json';

// Canonical Swiss canton numbering (matches backend providers/constants.py
// CANTON_MAP and the KANTONSNUMMER on the TLM boundary file). Populates the
// zone `id` field; the dashboard keys everything on the zone `name` string so
// these ids are not load-bearing in the frontend.
const CANTON_ID = {
  Zurich: 1, Bern: 2, Luzern: 3, Uri: 4, Schwyz: 5, Obwalden: 6, Nidwalden: 7,
  Glarus: 8, Zug: 9, Fribourg: 10, Solothurn: 11, 'Basel-Stadt': 12,
  'Basel-Landschaft': 13, Schaffhausen: 14, AppenzellAusserrhoden: 15,
  AppenzellInnerrhoden: 16, StGallen: 17, Graubunden: 18, Aargau: 19,
  Thurgau: 20, Ticino: 21, Vaud: 22, Valais: 23, Neuchatel: 24, Geneve: 25,
  Jura: 26,
};

// Per-canton zoom bounds, in Mapbox nested-pair form [[minLon,minLat],
// [maxLon,maxLat]]. Moved verbatim from the old useCantonMap CANTON_BOUNDS map
// so the Swiss fit-bounds behaviour is unchanged. "All" is the whole-country
// extent (drives the top-level study-area bbox).
const CANTON_BOUNDS = {
  "All": [[5.9, 45.8], [10.5, 47.8]],
  "Zurich": [[8.35, 47.15], [8.99, 47.7]],
  "Bern": [[6.85, 46.32], [8.46, 47.35]],
  "Geneve": [[5.95, 46.12], [6.32, 46.37]],
  "Vaud": [[6.07, 46.2], [7.24, 46.98]],
  "Aargau": [[7.71, 47.13], [8.46, 47.62]],
  "StGallen": [[8.79, 46.87], [9.68, 47.53]],
  "Luzern": [[7.83, 46.76], [8.52, 47.27]],
  "Ticino": [[8.38, 45.82], [9.17, 46.64]],
  "Valais": [[6.77, 45.85], [8.48, 46.66]],
  "Basel-Stadt": [[7.55, 47.51], [7.68, 47.6]],
  "Basel-Landschaft": [[7.32, 47.33], [7.97, 47.57]],
  "Fribourg": [[6.74, 46.44], [7.39, 47.01]],
  "Solothurn": [[7.34, 47.07], [7.95, 47.5]],
  "Graubunden": [[8.65, 46.17], [10.49, 47.07]],
  "Thurgau": [[8.63, 47.37], [9.47, 47.7]],
  "Schaffhausen": [[8.4, 47.65], [8.87, 47.8]],
  "Neuchatel": [[6.44, 46.82], [7.07, 47.14]],
  "Schwyz": [[8.42, 46.88], [9.0, 47.23]],
  "Zug": [[8.4, 47.05], [8.65, 47.27]],
  "Glarus": [[8.76, 46.79], [9.23, 47.17]],
  "Jura": [[6.84, 47.14], [7.56, 47.51]],
  "Nidwalden": [[8.2, 46.77], [8.57, 47.0]],
  "Obwalden": [[8.02, 46.72], [8.42, 47.0]],
  "Uri": [[8.38, 46.41], [8.93, 46.99]],
  "AppenzellAusserrhoden": [[9.19, 47.25], [9.61, 47.48]],
  "AppenzellInnerrhoden": [[9.35, 47.24], [9.51, 47.5]],
};

// Nested-pair bounds → flat study_area bbox [minLon,minLat,maxLon,maxLat].
const toFlat = (b) => (b ? [b[0][0], b[0][1], b[1][0], b[1][1]] : null);
const midpoint = (b) => (b ? [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2] : null);

// Swiss map-init literals — the center/zoom the Mapbox map was created with in
// useCantonMap (center [8.2275, 46.8182], zoom 5.5), so the initial view is
// unchanged when the fallback drives it.
const SWISS_CENTER = [8.2275, 46.8182];
const SWISS_ZOOM = 5.5;

// Zones: one entry per canton (excluding the "All" pseudo-entry), keyed by the
// internal `name` (= the TLM `NAME` property and the canton_alias key — the
// identifier the dashboard already uses for selectedCanton / ?canton=).
const zones = Object.entries(cantonAlias)
  .filter(([name]) => name !== 'All')
  .map(([name, displayName]) => {
    const bounds = CANTON_BOUNDS[name] || null;
    return {
      id: CANTON_ID[name] ?? null,
      name,
      display_name: displayName,
      bbox: toFlat(bounds),
      center: midpoint(bounds),
    };
  });

// Whole-country extent (drives map init / reset "All" view).
const SWISS_BBOX = toFlat(CANTON_BOUNDS["All"]);

export const SWISS_STUDY_AREA = {
  schema_version: 2,
  name: 'Switzerland',
  crs: 'EPSG:2056',
  primary_zone_type: 'canton',
  zone_label: 'Canton',
  zone_label_plural: 'Cantons',
  zone_types: [{ type: 'canton', label: 'Canton', label_plural: 'Cantons' }],
  bbox: SWISS_BBOX,
  center: SWISS_CENTER,
  zoom: SWISS_ZOOM,
  zones,
};
