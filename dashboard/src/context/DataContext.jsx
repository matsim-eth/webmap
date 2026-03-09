import React, { createContext, useContext, useState, useRef, useCallback } from "react";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

const DataContext = createContext();

const estimateSize = (obj) => {
  const str = JSON.stringify(obj);
  return str ? str.length * 2 : 0; // JS strings are ~2 bytes per char
};

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const logCacheStatus = (cache, label) => {
  const entries = Object.keys(cache);
  let totalSize = 0;
  const sizes = {};
  for (const key of entries) {
    if (cache[key] == null) continue;
    const size = estimateSize(cache[key]);
    sizes[key] = formatBytes(size);
    totalSize += size;
  }
  console.log(
    `%c[DataCache] ${label}%c — ${entries.length} files, ${formatBytes(totalSize)} total`,
    "color: #6366f1; font-weight: bold",
    "color: inherit",
    sizes
  );
};

export const DataProvider = ({ children }) => {
  const cacheRef = useRef({});
  const loadingRef = useRef(new Set());
  const [cacheVersion, setCacheVersion] = useState(0);
  const loadWithFallback = useLoadWithFallback();
  const loaderRef = useRef(loadWithFallback);
  loaderRef.current = loadWithFallback; // always keep latest ref

  // Synchronous data access: returns cached data or null (triggers background fetch)
  // Components use this in useMemo — first render returns null ("Loading..."),
  // once fetched the cache updates, getData gets a new identity, useMemo re-runs.
  const getData = useCallback((filename) => {
    if (filename in cacheRef.current) return cacheRef.current[filename];

    if (!loadingRef.current.has(filename)) {
      loadingRef.current.add(filename);
      loaderRef.current(filename)
        .then((data) => {
          cacheRef.current[filename] = data;
          logCacheStatus(cacheRef.current, `Loaded ${filename}`);
          setCacheVersion((v) => v + 1);
        })
        .catch((err) => {
          console.warn(`Failed to load ${filename}:`, err);
          cacheRef.current[filename] = null;
          setCacheVersion((v) => v + 1);
        });
    }

    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion]);

  // Async data access with caching (for per-canton files used in useEffect)
  const getCantonData = useCallback(async (relativePath) => {
    if (relativePath in cacheRef.current) return cacheRef.current[relativePath];

    try {
      const data = await loaderRef.current(relativePath);
      cacheRef.current[relativePath] = data;
      logCacheStatus(cacheRef.current, `Loaded ${relativePath}`);
      return data;
    } catch (err) {
      console.warn(`Failed to load: ${relativePath}`, err);
      cacheRef.current[relativePath] = null;
      return null;
    }
  }, []);

  return (
    <DataContext.Provider value={{ getData, getCantonData }}>
      {children}
    </DataContext.Provider>
  );
};

export const useData = () => {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error("useData must be used within a DataProvider");
  }
  return context;
};
