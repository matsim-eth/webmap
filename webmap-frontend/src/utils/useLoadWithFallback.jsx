import { useFileContext } from "../FileContext";
import { useData } from "../context/DataContext";
import { handle401 } from "./auth";

export const useLoadWithFallback = (explicitDataURL) => {
  const { fileMap, readJSONFile, dataURL: contextDataURL } = useFileContext();
  const { datasetId } = useData();

  const BACKEND_DATA_URL = `/backend/data/${datasetId}/`;
  const DEFAULT_DATA_URL = "https://matsim-eth.github.io/webmap/data/";

  const loadWithFallback = async (relativePath) => {
    const localPath = `data/${relativePath}`;

    // 1. Try from uploaded files
    if (fileMap.has(localPath)) {
      try {
        const json = await readJSONFile(localPath);
        console.log(`Loaded from uploaded files: ${localPath}`);
        return json;
      } catch (err) {
        console.warn(`Failed parsing uploaded file: ${localPath}`, err);
      }
    }

    // 2. Try from remote sources. The dataset-versioned backend is AUTHORITATIVE
    // and must come first: explicitDataURL/contextDataURL both default to the
    // fixed GitHub CDN, which serves dataset-independent reference data — if it
    // is tried first it wins for dataset-specific assets (e.g.
    // per_canton_counts), so every dataset shows the SAME numbers (the 1% and 5%
    // runs both reporting 50 boardings at a stop). Backend first → each dataset
    // gets its own data; the CDN remains only as a last resort for static assets
    // the backend doesn't serve.
    const candidates = [
      BACKEND_DATA_URL,
      explicitDataURL,
      contextDataURL,
      DEFAULT_DATA_URL
    ].filter(Boolean); // remove undefined/null

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
