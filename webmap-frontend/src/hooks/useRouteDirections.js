import { useQuery } from "@tanstack/react-query";
import { useData } from "../context/DataContext";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

/**
 * Per-line route direction metadata from the backend:
 *   { [line_id]: { H: { terminus, coord: [lon, lat], n_routes }, R: { ... } } }
 *
 * The terminus is the most common end-of-route stop name among the line's
 * route variants in that direction — used to label the .H/.R direction filter
 * ("→ Sursee" instead of "Outbound"). `coord` is that voted stop's own
 * location, so the terminus marker's dot and label stay consistent (see
 * useTransitLines). Only v2 datasets serve this asset; on
 * older datasets the query resolves to null and callers fall back to the
 * generic Outbound/Return labels.
 */
export default function useRouteDirections() {
  const { datasetId, dataURL } = useData();
  const loadWithFallback = useLoadWithFallback(dataURL);

  const { data } = useQuery({
    queryKey: ["transit-route-directions", datasetId, dataURL],
    // Let a fetch failure surface as a query error (not a swallowed null) so
    // React Query retries it — otherwise a single transient/cold-start miss got
    // cached as `null` under `staleTime: Infinity` and the terminus labels never
    // recovered for the rest of the session (stuck on Outbound/Return). Legacy
    // datasets that genuinely 404 exhaust the retries and settle on `undefined`,
    // which still falls back to the generic labels — the intended behaviour.
    queryFn: () => loadWithFallback("matsim/transit/route_directions.json"),
    staleTime: 60 * 60 * 1000,
    retry: 2,
    enabled: datasetId != null,
  });

  return data || null;
}

/** Direction labels for one line: { outbound, return } terminus names (null
 *  when unknown). */
export function directionLabelsForLine(routeDirections, lineId) {
  const info = lineId ? routeDirections?.[lineId] : null;
  return {
    outbound: info?.H?.terminus ?? null,
    return: info?.R?.terminus ?? null,
  };
}
