import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useData } from '../context/DataContext';
import { useDashboard } from '../context/DashboardContext';
import { useLineCantonCounts } from './useLineCantonCounts';
import { useEffectiveLineCantons } from './useEffectiveLineCantons';
import {
  useTransitDatasets,
  useLineCantonCountsMulti,
  resolveLineIdFromStopGeos,
} from './useTransitComparison';
import {
  collectStopsOnLine,
  buildStopToPolygon,
  aggregatePolygonRows,
} from '../utils/linePolygonAggregation';

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
 * Counts then fill in metric values where available. The pure pipeline steps
 * live in utils/linePolygonAggregation.js, shared with the secondary-dataset
 * path in useLinePolygonCountsMulti.
 */
export function useLinePolygonCounts(selectedLineMeta, polygonSet) {
  const { getCantonData } = useData();
  const { datasetId } = useDashboard();

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
    queryKey: ['line-stops-with-coords', datasetId, lineId, cantonsKey],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const stopGeos = await Promise.all(
        cantons.map((c) =>
          getCantonData(`matsim/transit/stops_by_canton/${c}_stops.geojson`).catch(() => null)
        )
      );
      return collectStopsOnLine(stopGeos, lineId);
    },
  });

  // Default-only: precomputed stop → muni lookup. The cantons param trims the
  // response from ~10 MB to <1 MB per canton.
  const {
    data: muniLookup,
    isLoading: muniLookupLoading,
    isError: muniLookupError,
  } = useQuery({
    queryKey: ['stop-municipality-lookup', datasetId, cantonsKey],
    enabled: enabled && !isCustom,
    staleTime: 5 * 60 * 1000,
    queryFn: () => {
      const cantonsQs = `?cantons=${cantons.map(encodeURIComponent).join(',')}`;
      return getCantonData(`stop_municipality.json${cantonsQs}`);
    },
  });

  // Stop → { id, name, kanton? } in a unified shape. The two paths produce
  // the same shape so the aggregation below stays single-purpose.
  const stopToPolygon = useMemo(
    () => buildStopToPolygon({ isCustom, stopsOnLine, polygonSet, muniLookup }),
    [isCustom, stopsOnLine, polygonSet, muniLookup]
  );

  const data = useMemo(() => {
    if (!countsData?.rows || !stopToPolygon || !stopsOnLine) return null;
    return { rows: aggregatePolygonRows(countsData.rows, stopToPolygon, stopsOnLine) };
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

/**
 * Comparison variant: runs the polygon aggregation pipeline once per unique
 * dataset in the comparison slots. Primary delegates to useLinePolygonCounts
 * above (cache shared with single-dataset consumers); the secondary dataset
 * gets its own stops-on-line (with line id→name fallback), its own
 * stop→municipality lookup, and its own counts, all fetched from
 * `/backend/data/{id}/...`.
 *
 * Returns [{ dataset, rows, isLoading, isError }] aligned with
 * useTransitDatasets().
 */
export function useLinePolygonCountsMulti(selectedLineMeta, polygonSet) {
  const datasets = useTransitDatasets();
  const { getUrlData } = useData();
  const ds0 = datasets[0] ?? null;
  const ds1 = datasets[1] ?? null;

  const lineId = selectedLineMeta?.line_id ?? null;
  const lineName = selectedLineMeta?.line_name ?? null;
  const { cantons } = useEffectiveLineCantons(selectedLineMeta);
  const cantonsKey = [...cantons].sort().join('|');
  const isCustom = polygonSet?.kind === 'custom';
  const enabled = !!ds1 && !!lineId && cantons.length > 0;

  const primary = useLinePolygonCounts(selectedLineMeta, polygonSet);
  const countsPerDataset = useLineCantonCountsMulti(selectedLineMeta);
  const secondaryCounts = countsPerDataset[1] ?? null;

  const { data: stopsOnLine1, isLoading: stopsLoading1, isError: stopsError1 } = useQuery({
    queryKey: ['line-stops-with-coords-secondary', ds1?.datasetId, lineId, cantonsKey],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const stopGeos = await Promise.all(
        cantons.map((c) =>
          getUrlData(`/backend/data/${ds1.datasetId}/matsim/transit/stops_by_canton/${c}_stops.geojson`)
            .catch(() => null)
        )
      );
      // The secondary run may label the same line with a different id.
      const effectiveId = resolveLineIdFromStopGeos(stopGeos, lineId, lineName);
      return collectStopsOnLine(stopGeos, effectiveId);
    },
  });

  const {
    data: muniLookup1,
    isLoading: muniLookupLoading1,
    isError: muniLookupError1,
  } = useQuery({
    queryKey: ['stop-municipality-lookup', ds1?.datasetId, cantonsKey],
    enabled: enabled && !isCustom,
    staleTime: 5 * 60 * 1000,
    queryFn: () => {
      const cantonsQs = `?cantons=${cantons.map(encodeURIComponent).join(',')}`;
      return getUrlData(`/backend/data/${ds1.datasetId}/stop_municipality.json${cantonsQs}`)
        .catch(() => null);
    },
  });

  const secondaryRows = useMemo(() => {
    if (!secondaryCounts?.rows || !stopsOnLine1) return null;
    const stopToPolygon = buildStopToPolygon({
      isCustom,
      stopsOnLine: stopsOnLine1,
      polygonSet,
      muniLookup: muniLookup1,
    });
    if (!stopToPolygon) return null;
    return aggregatePolygonRows(secondaryCounts.rows, stopToPolygon, stopsOnLine1);
  }, [secondaryCounts, stopsOnLine1, isCustom, polygonSet, muniLookup1]);

  return useMemo(() => {
    const out = [];
    if (ds0) {
      out.push({
        dataset: ds0,
        rows: primary.data?.rows ?? null,
        isLoading: primary.isLoading,
        isError: primary.isError,
      });
    }
    if (ds1) {
      out.push({
        dataset: ds1,
        rows: secondaryRows,
        isLoading:
          (secondaryCounts?.isLoading ?? false) ||
          stopsLoading1 ||
          (!isCustom && muniLookupLoading1),
        isError: stopsError1 || (!isCustom && muniLookupError1),
      });
    }
    return out;
  }, [
    ds0, ds1,
    primary.data, primary.isLoading, primary.isError,
    secondaryRows, secondaryCounts,
    stopsLoading1, stopsError1,
    isCustom, muniLookupLoading1, muniLookupError1,
  ]);
}
