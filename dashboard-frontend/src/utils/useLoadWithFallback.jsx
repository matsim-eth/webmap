import { useFileContext } from "../context/FileContext";
import { useDashboard } from "../context/DashboardContext";
import { handle401 } from "./auth";

export const useLoadWithFallback = (explicitDataURL) => {
  const { fileMap, readJSONFile, dataURL: contextDataURL } = useFileContext();
  const { datasetId } = useDashboard();

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

    // 2. Try from remote sources (backend first, then GitHub fallback)
    const candidates = [
      explicitDataURL,
      contextDataURL,
      BACKEND_DATA_URL,
      DEFAULT_DATA_URL
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
