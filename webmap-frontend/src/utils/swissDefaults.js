// Swiss study-area fallback. Used whenever the backend's study_area.json is
// unavailable (older backend, CDN-only dataset) OR while it is still loading.
// Every field is built from the existing static Swiss data so that behaviour is
// pixel-identical to the pre-generalization hardcoded values:
//   - zone list  ← canton_alias.json (internal name → display name)
//   - per-zone bbox ← bboxCanton.json (internal name → [minLon,minLat,maxLon,maxLat])
//   - center/zoom ← the literals that used to live in useMapbox / useResetMapView
//   - crs        ← EPSG:2056 (LV95), the Swiss projected CRS
//
// The object matches the backend study_area.json contract shape exactly, so
// consumers can treat the fallback and a real backend response identically.
import cantonAlias from './canton_alias.json';
import bboxCanton from './bboxCanton.json';
import cantonCentroids from './cantonCentroids.json';

// Canonical Swiss canton numbering (matches backend providers/constants.py
// CANTON_MAP and the KANTONSNUMMER on the TLM boundary file). Only used to
// populate the `id` field for completeness — the webmap keys everything on the
// zone `name` string, so these ids are not load-bearing in the frontend.
const CANTON_ID = {
  Zurich: 1, Bern: 2, Luzern: 3, Uri: 4, Schwyz: 5, Obwalden: 6, Nidwalden: 7,
  Glarus: 8, Zug: 9, Fribourg: 10, Solothurn: 11, 'Basel-Stadt': 12,
  'Basel-Landschaft': 13, Schaffhausen: 14, AppenzellAusserrhoden: 15,
  AppenzellInnerrhoden: 16, StGallen: 17, Graubunden: 18, Aargau: 19,
  Thurgau: 20, Ticino: 21, Vaud: 22, Valais: 23, Neuchatel: 24, Geneve: 25,
  Jura: 26,
};

// Swiss map-extent literals — copied verbatim from useMapbox.js (center
// [8.1642, 46.7592], zoom 7) so the initial view is unchanged.
const SWISS_CENTER = [8.1642, 46.7592];
const SWISS_ZOOM = 7;

// Zones: one entry per canton, keyed by the internal `name` (= the TLM `NAME`
// property, the canton_alias key, and the bboxCanton key — the identifier the
// rest of the webmap already uses for clickedCanton / searchCanton / etc).
const zones = Object.entries(cantonAlias).map(([name, displayName]) => ({
  id: CANTON_ID[name] ?? null,
  name,
  display_name: displayName,
  bbox: bboxCanton[name] || null,
  // Inside-polygon point (destination-zones arc endpoints) — same values the
  // module used directly from cantonCentroids before the generalization.
  center: cantonCentroids[name] || null,
}));

// Union of every canton's bbox — the whole-country extent that
// useDestinationZones used to compute from bboxCanton at module load.
const SWISS_BBOX = (() => {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const b of Object.values(bboxCanton)) {
    if (!b) continue;
    if (b[0] < minLon) minLon = b[0];
    if (b[1] < minLat) minLat = b[1];
    if (b[2] > maxLon) maxLon = b[2];
    if (b[3] > maxLat) maxLat = b[3];
  }
  return [minLon, minLat, maxLon, maxLat];
})();

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
