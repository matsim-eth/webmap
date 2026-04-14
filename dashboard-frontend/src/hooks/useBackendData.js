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
 * Phase 1 (immediate): Fetches only what the current view needs:
 *   - Canton "All" + no person filters → summary_only (skip persons JOIN)
 *   - Specific canton → canton=X (targeted query, smaller response)
 * Phase 2 (deferred): Full data loads after initial render for instant canton switching.
 */
export function useBackendData(url, enabled = true) {
  const { getUrlData } = useData();
  const { selectedCanton } = useDashboard();

  const isAllCanton = !selectedCanton || selectedCanton === "All";

  // Build the fast initial URL based on current state
  const fastUrl = !url ? null
    : isAllCanton
      ? appendParam(url, "summary_only", "true")
      : appendParam(url, "canton", selectedCanton);

  // Phase 1: Targeted data for the current view
  const { data: fastPayload } = useQuery({
    queryKey: ["backend-fast", fastUrl],
    queryFn: () => getUrlData(fastUrl),
    enabled: enabled && !!fastUrl,
    staleTime: 5 * 60 * 1000,
  });

  // Phase 2: Full data — fires after initial render for background cache warming
  const { data: fullPayload } = useQuery({
    queryKey: ["backend-full", url],
    queryFn: () => getUrlData(url),
    enabled: enabled && !!url && !!fastPayload,
    staleTime: 5 * 60 * 1000,
  });

  // Prefer fast data (avoids re-render when full arrives with identical visible data).
  // Full data is the fallback — used when fast hasn't loaded yet (e.g. canton switch
  // where full is already cached but new fast query is still in flight).
  return fastPayload ?? fullPayload ?? null;
}
