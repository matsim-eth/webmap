import { useDashboard } from "../context/DashboardContext";
import { handle401 } from "./auth";

export const useLoadWithFallback = (explicitDataURL) => {
  const { datasetId } = useDashboard();

  const BACKEND_DATA_URL = `/backend/data/${datasetId}/`;

  const loadWithFallback = async (relativePath) => {
    // Try remote sources in order. The dataset-versioned backend is authoritative and
    // comes FIRST. We deliberately do NOT fall back to the fixed GitHub CDN:
    // that served dataset-independent reference data, so when a dataset's asset
    // failed to load every dataset silently showed the SAME numbers (e.g. the
    // 5% and 15% runs reporting identical passenger counts). A backend miss now
    // surfaces as empty/error for that specific dataset instead of masking it.
    const candidates = [
      BACKEND_DATA_URL,
      explicitDataURL,
    ].filter(Boolean);

    for (const base of candidates) {
      const finalURL = base + relativePath;
      try {
        let res = await fetch(finalURL);

        // 401 from our backend → try token refresh, then retry
        if (res.status === 401 && finalURL.startsWith("/backend/")) {
          const refreshed = await handle401();
          if (!refreshed) return null; // redirecting to login
          res = await fetch(finalURL);
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        console.log(`Loaded from remote URL: ${finalURL}`);
        return json;
      } catch {
        // silently try next
      }
    }

    throw new Error(`All fallback attempts failed for ${relativePath}`);
  };

  return loadWithFallback;
};
