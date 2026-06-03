import { useQuery } from '@tanstack/react-query';
import { useData } from '../context/DataContext';
import { useDashboard } from '../context/DashboardContext';
import { useEffectiveLineCantons } from './useEffectiveLineCantons';

/**
 * Fetch + merge per_canton_counts files for every canton on the selected
 * line, returning the rows whose `line_id` matches.
 *
 * Output: { rows: [{ line_id, route_id, stop_id, data: [{ time_bin, boardings, alightings }] }] }
 *
 * Used as the base data source for:
 *   - LineHourlyDistribution (aggregates rows by time_bin)
 *   - useLinePolygonCounts (aggregates rows per polygon: muni or custom)
 *
 * Both consumers share the same React Query entry, so the per-line filter
 * pass over ~10–100 MB of canton counts only runs once. Empty
 * `selectedLineMeta.cantons` is recovered via useEffectiveLineCantons so
 * non-catalog lines (e.g. zero-volume `92-920-j24-1` reached through a stop
 * click) still resolve.
 */
export function useLineCantonCounts(selectedLineMeta) {
  const { getCantonData } = useData();
  const { datasetId } = useDashboard();

  const lineId = selectedLineMeta?.line_id ?? null;
  const { cantons, isLoading: cantonsLoading } = useEffectiveLineCantons(selectedLineMeta);
  const cantonsKey = [...cantons].sort().join('|');

  const query = useQuery({
    queryKey: ['line-canton-counts', datasetId, lineId, cantonsKey],
    enabled: !!lineId && cantons.length > 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const results = await Promise.all(
        cantons.map((c) =>
          getCantonData(`matsim/transit/per_canton_counts/${c}_counts.json`).catch(() => null)
        )
      );

      const rows = [];
      for (const result of results) {
        if (!result) continue;
        const list = Array.isArray(result)
          ? result
          : (Array.isArray(result.data) ? result.data : []);
        for (const row of list) {
          if (String(row.line_id) === String(lineId)) rows.push(row);
        }
      }
      return { rows };
    },
  });

  return { ...query, isLoading: query.isLoading || cantonsLoading };
}
