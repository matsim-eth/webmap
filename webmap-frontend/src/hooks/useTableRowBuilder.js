import { useEffect, useState, useCallback, useRef } from 'react';
import { buildRowsFromGeojson } from '../components/table/FeatureTable';

/**
 * Hook to manage table row building lifecycle for feature tables.
 * Handles: sidebar expand delay, data clearing/caching, and idle row building.
 *
 * @param {Object} options
 * @param {boolean} options.isFeatureTableOpen - Whether the feature table panel is open
 * @param {string|null} options.canton - Current selected canton
 * @param {Object|null} options.featureGeoJSON - GeoJSON data for the current canton
 * @param {string} options.selectedGraph - Current module name
 * @param {Function} options.setTableFilterQuery - Setter for table filter query
 * @param {boolean} [options.useCache=false] - Whether to cache rows by canton
 * @returns {{ showTable: boolean, tableRows: Array, rowsReady: boolean }}
 */
export function useTableRowBuilder({
  isFeatureTableOpen,
  canton,
  featureGeoJSON,
  selectedGraph,
  setTableFilterQuery,
  useCache = false,
}) {
  const [showTable, setShowTable] = useState(false);
  const [tableRows, setTableRows] = useState([]);
  const [rowsReady, setRowsReady] = useState(false);
  const cachedRowsRef = useRef(new Map());

  // effect:audited — timer-based delay to let sidebar animation finish before rendering table
  useEffect(() => {
    if (isFeatureTableOpen) {
      const timer = setTimeout(() => setShowTable(true), 400);
      return () => clearTimeout(timer);
    }
    setShowTable(false);
    setTableFilterQuery?.(null);
  }, [isFeatureTableOpen]);

  const ensureRowsForCanton = useCallback(() => {
    if (!canton || !featureGeoJSON) {
      setTableRows([]);
      setRowsReady(false);
      return;
    }

    if (useCache) {
      const cacheKey = canton;
      const cached = cachedRowsRef.current.get(cacheKey);
      if (cached && cached.source === featureGeoJSON) {
        setTableRows(cached.rows);
        setRowsReady(true);
        return;
      }
      const builtRows = buildRowsFromGeojson(featureGeoJSON, selectedGraph);
      cachedRowsRef.current.set(cacheKey, { source: featureGeoJSON, rows: builtRows });
      setTableRows(builtRows);
      setRowsReady(true);
    } else {
      const builtRows = buildRowsFromGeojson(featureGeoJSON, selectedGraph);
      setTableRows(builtRows);
      setRowsReady(true);
    }
  }, [canton, featureGeoJSON, selectedGraph, useCache]);

  // effect:audited — clears rows when canton/geojson changes to trigger rebuild
  useEffect(() => {
    if (!canton || !featureGeoJSON) {
      if (!canton && useCache) {
        cachedRowsRef.current.clear();
      }
      setTableRows([]);
      setRowsReady(false);
      return;
    }

    if (useCache) {
      const cached = cachedRowsRef.current.get(canton);
      if (cached && cached.source === featureGeoJSON) {
        setTableRows(cached.rows);
        setRowsReady(true);
      } else {
        cachedRowsRef.current.delete(canton);
        setTableRows([]);
        setRowsReady(false);
      }
    } else {
      setTableRows([]);
      setRowsReady(false);
    }
  }, [canton, featureGeoJSON]);

  // effect:audited — idle callback to build rows without blocking the main thread
  useEffect(() => {
    if (!showTable) return;

    let cancelled = false;
    const run = () => {
      if (!cancelled) ensureRowsForCanton();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(run, { timeout: 200 });
      return () => {
        cancelled = true;
        if (typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(idleId);
        }
      };
    }

    const timeoutId = window.setTimeout(run, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [showTable, ensureRowsForCanton, canton, featureGeoJSON]);

  return { showTable, tableRows, rowsReady };
}
