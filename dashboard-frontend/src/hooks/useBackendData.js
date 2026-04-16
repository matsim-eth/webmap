import { useQuery } from "@tanstack/react-query";
import { useData } from "../context/DataContext";
import { useDashboard } from "../context/DashboardContext";

function appendParam(url, key, value) {
  if (!url) return null;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

/**
 * Two-phase backend data loading hook.
 *
 * Returns { payload, isFetching } — isFetching is true while a request is in
 * flight (including when the URL changes and a new request starts, even if
 * stale data is cached for a different key).
 *
 * Phase 1 (immediate): Fetches only what the current view needs:
 *   - Canton "All" + no person filters → summary_only (skip persons JOIN)
 *   - Specific canton → canton=X (targeted query, smaller response)
 * Phase 2 (deferred): Full data loads after initial render for instant canton switching.
 */
export function useBackendData(url, enabled = true) {
  const { getUrlData } = useData();
  const { selectedCanton } = useDashboard();

  const isAllCanton = !selectedCanton || selectedCanton === "All";

  const fastUrl = !url ? null
    : isAllCanton
      ? appendParam(url, "summary_only", "true")
      : appendParam(url, "canton", selectedCanton);

  const fastQuery = useQuery({
    queryKey: ["backend-fast", fastUrl],
    queryFn: () => getUrlData(fastUrl),
    enabled: enabled && !!fastUrl,
    staleTime: 5 * 60 * 1000,
  });

  const fullQuery = useQuery({
    queryKey: ["backend-full", url],
    queryFn: () => getUrlData(url),
    enabled: enabled && !!url && !!fastQuery.data,
    staleTime: 5 * 60 * 1000,
  });

  const payload = fastQuery.data ?? fullQuery.data ?? null;
  // Only show overlay while the fast (visible-data) query is in flight.
  // Phase 2 (full prefetch) runs silently in the background.
  const isFetching = fastQuery.isFetching;

  return { payload, isFetching };
}
