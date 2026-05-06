import { useQuery } from '@tanstack/react-query';
import { useData } from '../context/DataContext';
import { parseStopFeatureLines } from '../utils/transitLineFilter';

/**
 * Resolve a line's canton list, falling back to inter_cantonal_stops.geojson
 * when `selectedLineMeta.cantons` is empty.
 *
 * Why: lines absent from boarding_data_by_line.json (e.g. zero-volume
 * `92-920-j24-1`) reach LinesAtStop with `cantons: []`, which in turn
 * disables the muni / counts / route-stops queries that all key off it.
 * Scanning the inter-cantonal stops file (~6800 features, ~MB-ish, cached
 * after first use) recovers the canton set for these lines.
 *
 * Returns:
 *   { cantons, isLoading }
 *
 * - When `meta.cantons` has entries, returns them as-is and `isLoading: false`.
 * - When `meta.cantons` is empty and a lineId is set, fires the discovery
 *   query; `cantons` is `[]` while loading and the discovered list once
 *   resolved.
 *
 * Edge case: lines confined to a single canton AND missing from
 * inter_cantonal_stops (purely-intra-canton zero-volume non-catalog lines)
 * still resolve to `[]`. We accept that gap — it's rare, and a full
 * 26-file scan to cover it would be heavier than it's worth.
 */
export function useEffectiveLineCantons(selectedLineMeta) {
  const { getCantonData } = useData();
  const lineId = selectedLineMeta?.line_id ?? null;
  const metaCantons = selectedLineMeta?.cantons ?? [];
  const needsDiscovery = !!lineId && metaCantons.length === 0;

  const { data: discovered, isLoading } = useQuery({
    queryKey: ['discovered-line-cantons', lineId],
    enabled: needsDiscovery,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const geo = await getCantonData(
        'matsim/transit/stops_by_canton/inter_cantonal_stops.geojson'
      ).catch(() => null);
      if (!geo?.features) return [];
      const found = new Set();
      for (const f of geo.features) {
        const parsed = parseStopFeatureLines(f.properties?.lines);
        if (!parsed.some((l) => String(l.line_id) === String(lineId))) continue;
        const c = f.properties?.assigned_canton;
        if (c) found.add(c);
      }
      return [...found];
    },
  });

  if (metaCantons.length > 0) {
    return { cantons: metaCantons, isLoading: false };
  }
  return {
    cantons: discovered ?? [],
    isLoading: needsDiscovery && isLoading,
  };
}
