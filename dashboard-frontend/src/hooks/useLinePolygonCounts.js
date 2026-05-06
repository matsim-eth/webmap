import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useData } from '../context/DataContext';
import { useLineCantonCounts } from './useLineCantonCounts';
import { useEffectiveLineCantons } from './useEffectiveLineCantons';
import { parseStopFeatureLines } from '../utils/transitLineFilter';
import { findContainingFeature } from '../utils/pointInPolygon';

/**
 * Aggregate per-stop boardings/alightings to per-polygon totals for the
 * selected transit line. Replaces useLineMunicipalityCounts; the same fast
 * default path is preserved (precomputed stop_municipality lookup) and a new
 * custom path runs client-side point-in-polygon against a user-uploaded
 * polygon GeoJSON.
 *
 *   polygonSet:
 *     { kind: 'municipality', ... }  → default (uses stop_municipality.json)
 *     { kind: 'custom', features, nameProperty, ... }  → PiP each stop against
 *       the supplied polygon FeatureCollection. `nameProperty` selects which
 *       property of each polygon feature is used as the chart label / map
 *       label.
 *
 * Output (sorted by total ridership desc):
 *   { rows: [{ polygon_id, name, kanton?, boardings, alightings, total }] }
 *
 * Strategy: muni *list* and custom *list* are both seeded from the line's
 * stops so polygons with all-zero boardings still render bars at zero height.
 * Counts then fill in metric values where available.
 */
export function useLinePolygonCounts(selectedLineMeta, polygonSet) {
  const { getCantonData } = useData();

  const lineId = selectedLineMeta?.line_id ?? null;
  const { cantons, isLoading: cantonsLoading } = useEffectiveLineCantons(selectedLineMeta);
  const cantonsKey = [...cantons].sort().join('|');
  const enabled = !!lineId && cantons.length > 0;
  const isCustom = polygonSet?.kind === 'custom';

  const { data: countsData, isLoading: countsLoading, isError: countsError } =
    useLineCantonCounts(selectedLineMeta);

  // Stops on the line, with coords. Used for muni-seeding (so zero-count
  // munis still render) AND for the custom PiP path.
  const { data: stopsOnLine, isLoading: stopsLoading, isError: stopsError } = useQuery({
    queryKey: ['line-stops-with-coords', lineId, cantonsKey],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const stopGeos = await Promise.all(
        cantons.map((c) =>
          getCantonData(`matsim/transit/stops_by_canton/${c}_stops.geojson`).catch(() => null)
        )
      );
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
    },
  });

  // Default-only: precomputed stop → muni lookup. The cantons param trims the
  // response from ~10 MB to <1 MB per canton.
  const {
    data: muniLookup,
    isLoading: muniLookupLoading,
    isError: muniLookupError,
  } = useQuery({
    queryKey: ['stop-municipality-lookup', cantonsKey],
    enabled: enabled && !isCustom,
    staleTime: 5 * 60 * 1000,
    queryFn: () => {
      const cantonsQs = `?cantons=${cantons.map(encodeURIComponent).join(',')}`;
      return getCantonData(`stop_municipality.json${cantonsQs}`);
    },
  });

  // Stop → { id, name, kanton? } in a unified shape. The two paths produce
  // the same shape so the aggregation below stays single-purpose.
  const stopToPolygon = useMemo(() => {
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
  }, [isCustom, stopsOnLine, polygonSet, muniLookup]);

  const data = useMemo(() => {
    if (!countsData?.rows || !stopToPolygon || !stopsOnLine) return null;

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
    for (const row of countsData.rows) {
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
    return { rows };
  }, [countsData, stopToPolygon, stopsOnLine]);

  return {
    data,
    isLoading:
      cantonsLoading ||
      countsLoading ||
      stopsLoading ||
      (!isCustom && muniLookupLoading),
    isError: countsError || stopsError || (!isCustom && muniLookupError),
  };
}
