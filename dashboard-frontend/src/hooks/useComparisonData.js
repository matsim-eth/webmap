import { useMemo } from "react";
import { useDashboard } from "../context/DashboardContext";
import { useBackendData } from "./useBackendData";
import { resolveUrlTemplate } from "../utils/comparisonHelpers";

const buildUrl = (template, query, datasetId) => {
  if (!template || datasetId == null) return null;
  let url = resolveUrlTemplate(template, datasetId);
  if (!query) return url;

  const parsed = new URL(url, window.location.origin);
  Object.entries(query).forEach(([key, value]) => {
    if (value == null || value === "") return;
    parsed.searchParams.set(key, String(value));
  });
  return `${parsed.pathname}${parsed.search}`;
};

/**
 * Multi-dataset comparison data hook.
 *
 * Takes a URL template with {datasetId} placeholder and fetches data for
 * each active comparison slot. Returns an array of { label, color, subDataset, rawPayload }
 * per slot, plus loading state.
 *
 * Uses exactly 2 useBackendData calls (fixed hook count) regardless of active slots.
 * When both slots share the same datasetId, react-query deduplicates automatically.
 */
export function useComparisonData(urlTemplate, { query = null, enabled = true, urlSuffix = null } = {}) {
  const { comparisonSlots, selectedCanton } = useDashboard();
  const cantonKey = selectedCanton || "All";

  const slot0 = comparisonSlots[0] ?? null;
  const slot1 = comparisonSlots[1] ?? null;

  const ds0 = slot0?.datasetId;
  const ds1 = slot1?.datasetId;

  // Build base URLs for each unique datasetId
  let baseUrl0 = useMemo(
    () => buildUrl(urlTemplate, query, ds0),
    [urlTemplate, query, ds0]
  );
  let baseUrl1 = useMemo(
    () => buildUrl(urlTemplate, query, ds1),
    [urlTemplate, query, ds1]
  );

  // Append suffix if provided (e.g., distance_type param)
  if (urlSuffix && baseUrl0) {
    const sep0 = baseUrl0.includes("?") ? "&" : "?";
    baseUrl0 = `${baseUrl0}${sep0}${urlSuffix}`;
  }
  if (urlSuffix && baseUrl1) {
    const sep1 = baseUrl1.includes("?") ? "&" : "?";
    baseUrl1 = `${baseUrl1}${sep1}${urlSuffix}`;
  }

  // If both slots share the same datasetId, skip second fetch (react-query dedup by key)
  const needSecondFetch = ds1 != null && ds1 !== ds0;

  // Always call both hooks (React rules) — disable with enabled flag
  const result0 = useBackendData(baseUrl0, enabled && !!baseUrl0 && !!slot0);
  const result1 = useBackendData(
    needSecondFetch ? baseUrl1 : null,
    enabled && !!baseUrl1 && !!slot1 && needSecondFetch
  );
  const payload0 = result0.payload;
  const payload1 = result1.payload;
  const isFetching = result0.isFetching || result1.isFetching;

  // Build slot data array
  const slotDatasets = useMemo(() => {
    const result = [];

    if (slot0 && payload0) {
      result.push({
        ...slot0,
        rawPayload: payload0,
        cantonKey,
      });
    }

    if (slot1) {
      const raw = needSecondFetch ? payload1 : payload0;
      if (raw) {
        result.push({
          ...slot1,
          rawPayload: raw,
          cantonKey,
        });
      }
    }

    return result;
  }, [slot0, slot1, payload0, payload1, needSecondFetch, cantonKey]);

  const isLoading = (slot0 && !payload0) || (slot1 && !(needSecondFetch ? payload1 : payload0));

  return { slotDatasets, isLoading, isFetching, cantonKey };
}
