import { useFileContext } from "../FileContext";

export const useLoadWithFallback = (explicitDataURL) => {
  const { fileMap, readJSONFile, dataURL: contextDataURL } = useFileContext();

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
        // silently fall through to next attempt
      }
    }

    // 2. Try from remote sources
    const candidates = [
      explicitDataURL,
      contextDataURL,
      DEFAULT_DATA_URL
    ].filter(Boolean); // remove undefined/null

    for (const base of candidates) {
      const finalURL = base + relativePath;
      try {
        const res = await fetch(finalURL);
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
