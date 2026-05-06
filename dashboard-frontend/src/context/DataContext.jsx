import React, { createContext, useContext, useState, useRef, useCallback } from "react";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";
import { handle401 } from "../utils/auth";

const DataContext = createContext();
const DEFAULT_CACHE_LIMIT_MB = Number(import.meta.env.VITE_DATA_CACHE_MB ?? 60);
const CACHE_LIMIT_BYTES =
  (Number.isFinite(DEFAULT_CACHE_LIMIT_MB) && DEFAULT_CACHE_LIMIT_MB > 0
    ? DEFAULT_CACHE_LIMIT_MB
    : 60) * 1024 * 1024;

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
  const cacheOrderRef = useRef(new Map()); // key -> estimated size in bytes (insertion order = LRU)
  const cacheSizeRef = useRef(0);
  const loadingRef = useRef(new Set());
  const inflightRef = useRef(new Map()); // url -> Promise (dedup in-flight fetches)
  const [cacheVersion, setCacheVersion] = useState(0);
  const loadWithFallback = useLoadWithFallback();
  const loaderRef = useRef(loadWithFallback);
  loaderRef.current = loadWithFallback; // always keep latest ref

  const getCached = useCallback((key) => {
    if (!(key in cacheRef.current)) return undefined;

    // Touch key so it becomes most recently used.
    const prevSize = cacheOrderRef.current.get(key) ?? 0;
    cacheOrderRef.current.delete(key);
    cacheOrderRef.current.set(key, prevSize);
    return cacheRef.current[key];
  }, []);

  const evictIfNeeded = useCallback((pinnedKey) => {
    while (cacheSizeRef.current > CACHE_LIMIT_BYTES && cacheOrderRef.current.size > 0) {
      const oldestKey = cacheOrderRef.current.keys().next().value;
      if (!oldestKey) break;

      // Keep the just-written key even if it alone is above the limit.
      if (oldestKey === pinnedKey && cacheOrderRef.current.size === 1) break;

      const oldestSize = cacheOrderRef.current.get(oldestKey) ?? 0;
      cacheOrderRef.current.delete(oldestKey);
      delete cacheRef.current[oldestKey];
      cacheSizeRef.current = Math.max(0, cacheSizeRef.current - oldestSize);
      loadingRef.current.delete(oldestKey);
    }
  }, []);

  const setCached = useCallback(
    (key, value) => {
      const prevSize = cacheOrderRef.current.get(key) ?? 0;
      const nextSize = value == null ? 0 : estimateSize(value);

      cacheRef.current[key] = value;
      cacheOrderRef.current.delete(key);
      cacheOrderRef.current.set(key, nextSize);

      cacheSizeRef.current = Math.max(0, cacheSizeRef.current - prevSize) + nextSize;
      evictIfNeeded(key);
      logCacheStatus(cacheRef.current, `Loaded ${key} (limit ${formatBytes(CACHE_LIMIT_BYTES)})`);
    },
    [evictIfNeeded]
  );

  // Synchronous data access: returns cached data or null (triggers background fetch)
  // Components use this in useMemo — first render returns null ("Loading..."),
  // once fetched the cache updates, getData gets a new identity, useMemo re-runs.
  const getData = useCallback((filename) => {
    const cached = getCached(filename);
    if (cached !== undefined) return cached;

    if (!loadingRef.current.has(filename)) {
      loadingRef.current.add(filename);
      loaderRef.current(filename)
        .then((data) => {
          setCached(filename, data);
          loadingRef.current.delete(filename);
          setCacheVersion((v) => v + 1);
        })
        .catch((err) => {
          console.warn(`Failed to load ${filename}:`, err);
          setCached(filename, null);
          loadingRef.current.delete(filename);
          setCacheVersion((v) => v + 1);
        });
    }

    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, getCached, setCached]);

  // Async data access with caching (for per-canton files used in useEffect)
  const getCantonData = useCallback(async (relativePath) => {
    const cached = getCached(relativePath);
    if (cached !== undefined) return cached;

    try {
      const data = await loaderRef.current(relativePath);
      setCached(relativePath, data);
      return data;
    } catch (err) {
      console.warn(`Failed to load: ${relativePath}`, err);
      setCached(relativePath, null);
      return null;
    }
  }, [getCached, setCached]);

  const getUrlData = useCallback(async (url) => {
    const cached = getCached(url);
    if (cached !== undefined) return cached;

    // Deduplicate in-flight requests for the same URL
    if (inflightRef.current.has(url)) {
      return inflightRef.current.get(url);
    }

    const promise = (async () => {
      let response = await fetch(url);

      // 401 from our backend → try token refresh, then retry
      if (response.status === 401 && url.startsWith("/backend/")) {
        const refreshed = await handle401();
        if (!refreshed) return null; // redirecting to login
        response = await fetch(url);
      }

      if (!response.ok) {
        throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
      }
      const data = await response.json();
      setCached(url, data);
      return data;
    })().finally(() => {
      inflightRef.current.delete(url);
    });

    inflightRef.current.set(url, promise);
    return promise;
  }, [getCached, setCached]);

  // Fire fetches for multiple URLs in parallel; results are cached for components
  const prefetchUrls = useCallback((urls) => {
    urls.forEach((url) => {
      if (url) getUrlData(url);
    });
  }, [getUrlData]);

  return (
    <DataContext.Provider value={{ getData, getCantonData, getUrlData, prefetchUrls }}>
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
