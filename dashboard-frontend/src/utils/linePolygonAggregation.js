import { parseStopFeatureLines } from './transitLineFilter';
import { findContainingFeature } from './pointInPolygon';

/**
 * Pure steps of the line → polygon aggregation pipeline, shared between
 * useLinePolygonCounts (primary dataset) and useTransitComparison's
 * secondary-dataset pipeline. Keeping them here means the two paths cannot
 * drift apart.
 */

/** Collect the unique stops (with coords) on `lineId` from per-canton stop
 * geojsons. Mirrors the legacy inline queryFn of useLinePolygonCounts. */
export function collectStopsOnLine(stopGeos, lineId) {
  const seen = new Set();
  const stops = [];
  for (const geo of stopGeos) {
    if (!geo?.features) continue;
    for (const f of geo.features) {
      const parsed = parseStopFeatureLines(f.properties?.lines);
      if (!parsed.some((l) => String(l.line_id) === String(lineId))) continue;
      const sid = f.properties?.stop_id;
      const ids = Array.isArray(sid) ? sid : sid != null ? [sid] : [];
      const coords = f.geometry?.coordinates;
      for (const id of ids) {
        const key = String(id);
        if (seen.has(key)) continue;
        seen.add(key);
        stops.push({ stop_id: key, coords });
      }
    }
  }
  return stops;
}

/** Stop → { id, name, kanton? } in a unified shape for both polygon paths. */
export function buildStopToPolygon({ isCustom, stopsOnLine, polygonSet, muniLookup }) {
  if (isCustom) {
    if (!stopsOnLine || !polygonSet?.features?.length || !polygonSet?.nameProperty) return null;
    const out = {};
    for (const stop of stopsOnLine) {
      const poly = findContainingFeature(stop.coords, polygonSet.features);
      if (!poly) continue;
      // Stable polygon id: prefer feature.id, fall back to nameProperty value.
      const idCandidate =
        poly.id ?? poly.properties?.id ?? poly.properties?.[polygonSet.nameProperty];
      if (idCandidate == null) continue;
      out[stop.stop_id] = {
        id: String(idCandidate),
        name: String(poly.properties?.[polygonSet.nameProperty] ?? idCandidate),
      };
    }
    return out;
  }
  // Municipality path
  if (!muniLookup) return null;
  const out = {};
  for (const [sid, m] of Object.entries(muniLookup)) {
    if (m?.bfs_nummer == null) continue;
    out[sid] = {
      id: String(m.bfs_nummer),
      name: m.municipality,
      kanton: m.kanton,
    };
  }
  return out;
}

/** Aggregate count rows to per-polygon totals, seeding zero-count polygons
 * from the line's stop set. Returns rows sorted by total desc. */
export function aggregatePolygonRows(countRows, stopToPolygon, stopsOnLine) {
  const byPoly = new Map();

  // Seed entries from the line's stop set so zero-count polygons render
  // bars at height zero (matches the legacy "show munis on x-axis" feel).
  for (const stop of stopsOnLine) {
    const entry = stopToPolygon[stop.stop_id];
    if (!entry || byPoly.has(entry.id)) continue;
    byPoly.set(entry.id, {
      polygon_id: entry.id,
      name: entry.name,
      kanton: entry.kanton,
      boardings: 0,
      alightings: 0,
    });
  }

  // Fill in counts. Counts files may reference stop_ids missing from the
  // stops geojson (different MATSim variants); tolerate that by adding
  // entries on the fly.
  for (const row of countRows) {
    const entry = stopToPolygon[String(row.stop_id)];
    if (!entry) continue;
    let agg = byPoly.get(entry.id);
    if (!agg) {
      agg = {
        polygon_id: entry.id,
        name: entry.name,
        kanton: entry.kanton,
        boardings: 0,
        alightings: 0,
      };
      byPoly.set(entry.id, agg);
    }
    const bins = Array.isArray(row.data) ? row.data : [];
    for (const t of bins) {
      agg.boardings += Number(t.boardings) || 0;
      agg.alightings += Number(t.alightings) || 0;
    }
  }

  const rows = [...byPoly.values()].map((r) => ({ ...r, total: r.boardings + r.alightings }));
  rows.sort((a, b) => b.total - a.total);
  return rows;
}
