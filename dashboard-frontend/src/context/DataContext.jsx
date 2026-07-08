import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";
import { useDashboard } from "./DashboardContext";
import { handle401 } from "../utils/auth";

const DataContext = createContext();
// v2 (15x) assets are large: boarding_data_by_line ≈ 38 MB and municipalities
// ≈ 54 MB raw, and estimateSize counts ~2× (stringify length). With the old
// 60 MB budget a single asset exceeded the limit, so any two large assets on a
// tab evicted each other in a loop — getData refetched the evicted file, bumped
// cacheVersion, re-rendered every consumer, and thrashed (constant refetch +
// flicker). Budget must comfortably hold the working set of the heaviest tab.
const DEFAULT_CACHE_LIMIT_MB = Number(import.meta.env.VITE_DATA_CACHE_MB ?? 768);
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

  // Cross-dataset isolation, two layers:
  //
  // 1. Every cache/loading/inflight key is NAMESPACED with the dataset id,
  //    captured at request start (`nsKey`). This is the correctness layer: a
  //    clear-on-switch effect alone is not enough because child effects keyed
  //    on datasetId (e.g. useCantonMap's zone-layer reload) run BEFORE this
  //    provider's effect on the same commit and would read the previous
  //    dataset's entry; and a fetch started pre-switch would resolve
  //    post-clear and re-poison the fresh cache. The ref is assigned during
  //    render, so it is already current when any child effect runs.
  // 2. The clear-on-switch effect below stays as memory hygiene (drop the old
  //    dataset's MBs immediately) and to reset react-query state.
  const queryClient = useQueryClient();
  const { datasetId } = useDashboard();
  const dsRef = useRef(datasetId);
  dsRef.current = datasetId;
  const nsKey = useCallback((key) => `${dsRef.current}::${key}`, []);
  const prevDatasetRef = useRef(datasetId);
  useEffect(() => {
    if (prevDatasetRef.current === datasetId) return;
    prevDatasetRef.current = datasetId;
    cacheRef.current = {};
    cacheOrderRef.current = new Map();
    cacheSizeRef.current = 0;
    inflightRef.current = new Map();
    setCacheVersion((v) => v + 1);
    queryClient.clear();
  }, [datasetId, queryClient]);

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
    // Key captured at request start — if the dataset switches mid-fetch, the
    // result lands under the OLD namespace and is never served to the new one.
    const key = nsKey(filename);
    const cached = getCached(key);
    if (cached !== undefined) return cached;

    if (!loadingRef.current.has(key)) {
      loadingRef.current.add(key);
      loaderRef.current(filename)
        .then((data) => {
          setCached(key, data);
          loadingRef.current.delete(key);
          setCacheVersion((v) => v + 1);
        })
        .catch((err) => {
          console.warn(`Failed to load ${filename}:`, err);
          setCached(key, null);
          loadingRef.current.delete(key);
          setCacheVersion((v) => v + 1);
        });
    }

    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheVersion, getCached, setCached, nsKey]);

  // Async data access with caching (for per-canton files used in useEffect)
  const getCantonData = useCallback(async (relativePath) => {
    const key = nsKey(relativePath);
    const cached = getCached(key);
    if (cached !== undefined) return cached;

    // Dedup concurrent callers for the same path — several map hooks request
    // the same stops_by_canton geojson at once, and without this each fired
    // its own fetch. Reuse the inflight map keyed per (dataset, path).
    if (inflightRef.current.has(key)) {
      return inflightRef.current.get(key);
    }

    const promise = loaderRef.current(relativePath)
      .then((data) => {
        setCached(key, data);
        return data;
      })
      .catch((err) => {
        console.warn(`Failed to load: ${relativePath}`, err);
        setCached(key, null);
        return null;
      })
      .finally(() => {
        inflightRef.current.delete(key);
      });

    inflightRef.current.set(key, promise);
    return promise;
  }, [getCached, setCached, nsKey]);

  const getUrlData = useCallback(async (url) => {
    // Absolute URLs usually embed the dataset id already, but namespace anyway
    // for uniformity (double-keying is harmless; staleness is not).
    const key = nsKey(url);
    const cached = getCached(key);
    if (cached !== undefined) return cached;

    // Deduplicate in-flight requests for the same URL
    if (inflightRef.current.has(key)) {
      return inflightRef.current.get(key);
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
      setCached(key, data);
      return data;
    })().finally(() => {
      inflightRef.current.delete(key);
    });

    inflightRef.current.set(key, promise);
    return promise;
  }, [getCached, setCached, nsKey]);

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
