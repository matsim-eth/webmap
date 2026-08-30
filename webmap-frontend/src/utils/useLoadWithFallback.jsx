import { useData } from "../context/DataContext";
import { handle401 } from "./auth";

export const useLoadWithFallback = () => {
  const { datasetId } = useData();

  const BACKEND_DATA_URL = `/backend/data/${datasetId}/`;

  // `opts.signal` lets a caller cancel a load whose result is no longer wanted
  // (e.g. the user switched canton mid-fetch). Aborts are rethrown as-is rather
  // than folded into the generic "all attempts failed" error, so callers can
  // tell "I cancelled this" apart from "the backend has no data".
  const loadWithFallback = async (relativePath, opts = {}) => {
    // The dataset-versioned backend is the ONLY source. There used to be a
    // fixed GitHub CDN behind it, which served dataset-INDEPENDENT reference
    // data: whenever a dataset's own asset failed, that CDN answered and every
    // dataset silently showed the SAME numbers (the 1% and 5% runs both
    // reporting 50 boardings at a stop, one dataset's network drawn for
    // another). It was removed once every matsim/* asset was verified servable
    // from each dataset's duckdb — see the dashboard loader, which dropped its
    // fallback for the same reason. A backend miss must now surface as
    // empty/error for that specific dataset instead of being masked.
    const candidates = [BACKEND_DATA_URL];

    const { signal } = opts;

    for (const base of candidates) {
      const finalURL = base + relativePath;
      try {
        let res = await fetch(finalURL, { signal });

        // 401 from our backend → try token refresh, then retry
        if (res.status === 401 && finalURL.startsWith("/backend/")) {
          const refreshed = await handle401();
          if (!refreshed) return null; // redirecting to login
          res = await fetch(finalURL, { signal });
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        console.log(`Loaded from remote URL: ${finalURL}`);

        return json;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        // silently try next
      }
    }

    throw new Error(`All fallback attempts failed for ${relativePath}`);
  };

  return loadWithFallback;
};
