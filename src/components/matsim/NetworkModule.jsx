import React, { useCallback, useEffect, useState, useRef } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import FeatureTable, { buildRowsFromGeojson } from "../table/FeatureTable";

const deriveCoords = (row) => {
  if (!row) return null;
  const coords = row.coords;
  if (Array.isArray(coords) && coords.length) {
    return coords;
  }
  const geometry = row.feature?.geometry;
  if (!geometry) return null;
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates;
  }
  if (geometry.type === "MultiLineString" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.flat();
  }
  return null;
};

const buildSelectionPayload = (row) => {
  if (!row) return null;
  const feature = row.feature;
  const coords = deriveCoords(row);
  if (!feature || !coords || !coords.length) {
    return null;
  }
  const props = row.featureProps || feature.properties || {};
  const id =
    props.id ||
    props.link_id ||
    props.segment_id ||
    props.objectid ||
    feature.id ||
    row.segmentLabel ||
    row.rowKey ||
    null;
  return { id, feature, coords };
};

const NetworkModule = ({
  canton,
  selectedNetworkModes,
  availableModes,
  selectedNetworkFeature,
  setSelectedNetworkFeature,
  handleModeChange,
  isFeatureTableOpen,
  featureGeoJSON,
  onFocusNetworkFeature,
  featureTableRef,
  onTableRowsChange,
}) => {
  const [showTable, setShowTable] = useState(false);
  const [tableRows, setTableRows] = useState([]);
  const [rowsReady, setRowsReady] = useState(false);
  const cachedRowsRef = useRef(new Map());

  useEffect(() => {
    if (isFeatureTableOpen) {
      const timer = setTimeout(() => setShowTable(true), 350);
      return () => clearTimeout(timer);
    }
    setShowTable(false);
    return undefined;
  }, [isFeatureTableOpen]);

  useEffect(() => () => onFocusNetworkFeature?.(null), [onFocusNetworkFeature]);

  const ensureRowsForCanton = useCallback(() => {
    if (!canton || !featureGeoJSON) {
      setTableRows([]);
      setRowsReady(false);
      onTableRowsChange?.(false);
      return;
    }
    const cacheKey = canton;
    const cached = cachedRowsRef.current.get(cacheKey);
    if (cached && cached.source === featureGeoJSON) {
      setTableRows(cached.rows);
      setRowsReady(true);
      onTableRowsChange?.(cached.rows.length > 0);
      return;
    }
    const builtRows = buildRowsFromGeojson(featureGeoJSON);
    cachedRowsRef.current.set(cacheKey, { source: featureGeoJSON, rows: builtRows });
    setTableRows(builtRows);
    setRowsReady(true);
    onTableRowsChange?.(builtRows.length > 0);
  }, [canton, featureGeoJSON, onTableRowsChange]);

  useEffect(() => {
    if (!canton || !featureGeoJSON) {
      if (!canton) {
        cachedRowsRef.current.clear();
      }
      setTableRows([]);
      setRowsReady(false);
      onTableRowsChange?.(false);
      return;
    }
    const cached = cachedRowsRef.current.get(canton);
    if (cached && cached.source === featureGeoJSON) {
      setTableRows(cached.rows);
      setRowsReady(true);
      onTableRowsChange?.(cached.rows.length > 0);
    } else {
      cachedRowsRef.current.delete(canton);
      setTableRows([]);
      setRowsReady(false);
      onTableRowsChange?.(false);
    }
  }, [canton, featureGeoJSON, onTableRowsChange]);

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

  const handleTableRowSelect = useCallback(
    (row) => {
      if (!row) return;
      const featureProps = row.featureProps || row.feature?.properties;
      if (featureProps) {
        setSelectedNetworkFeature?.([featureProps]);
      }
      const payload = buildSelectionPayload(row);
      if (payload) {
        onFocusNetworkFeature?.(payload);
      }
    },
    [onFocusNetworkFeature, setSelectedNetworkFeature]
  );

  const handleSelectCoords = useCallback(
    (coords, row) => {
      if (!row) return;
      handleTableRowSelect({ ...row, coords: coords || row.coords });
    },
    [handleTableRowSelect]
  );

  return (
    <div className="plot-container">
      {isFeatureTableOpen ? (
        <FeatureTable
          ref={featureTableRef}
          tableId="network-feature-table"
          rows={tableRows}
          geojson={rowsReady ? null : featureGeoJSON}
          selectedModes={selectedNetworkModes}
          onRowClick={handleTableRowSelect}
          onSelectCoords={handleSelectCoords}
          height={360}
          useScroller
          loading={!showTable || !rowsReady}
        />
      ) : (
        <>
          {canton ? (
            <div className="mode-filter-container">
              <label className="mode-filter-label">Filter by Mode:</label>
              <select
                multiple
                value={selectedNetworkModes}
                onChange={handleModeChange}
                className="mode-filter-select"
              >
                <option value="all">All</option>
                {availableModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
              Click a canton to view MATSim network links.
            </p>
          )}

          {selectedNetworkFeature && (
            <SegmentAttributesTable propertiesList={selectedNetworkFeature} />
          )}
        </>
      )}
    </div>
  );
};

export default NetworkModule;
