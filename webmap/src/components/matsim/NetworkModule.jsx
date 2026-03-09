import React, { useCallback, useEffect, useState, useRef } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import FeatureTable, { buildRowsFromGeojson } from "../table/FeatureTable";

// get coords and id of selected row
const buildSelectionPayload = (row) => {
  if (!row) return null;
  const coords= row.coords;
  const id = row.rowKey; // add other ones if needed
  const feature = row.feature;
  return { id, feature, coords };
};

const NetworkModule = ({
  canton,
  selectedGraph,
  selectedNetworkModes,
  availableModes,
  selectedNetworkFeature,
  setSelectedNetworkFeature,
  handleModeChange,
  isFeatureTableOpen,
  featureGeoJSON,
  onFocusNetworkFeature,
  featureTableRef,
  setTableFilterQuery
}) => {
  const [showTable, setShowTable] = useState(false);
  const [tableRows, setTableRows] = useState([]);
  const [rowsReady, setRowsReady] = useState(false);
  const cachedRowsRef = useRef(new Map());
  
  useEffect(() => {
    if (isFeatureTableOpen) {
      // add delay so sidebar can expand first
      const timer = setTimeout(() => {
        setShowTable(true);
      }, 400);
      return () => clearTimeout(timer);
    }
    setShowTable(false);
    setTableFilterQuery(null);
  }, [isFeatureTableOpen]);
  
  const ensureRowsForCanton = useCallback(() => {
    console.log('[NetworkModule] ensureRowsForCanton called', { canton, hasGeoJSON: !!featureGeoJSON, selectedGraph });

    // if missing canton or data, clear
    if (!canton || !featureGeoJSON) {
      console.log('[NetworkModule] Missing canton or geojson, clearing rows');
      setTableRows([]);
      setRowsReady(false);
      return;
    }

    // cache data unless canton changed
    const cacheKey = canton;
    const cached = cachedRowsRef.current.get(cacheKey);
    console.log('[NetworkModule] Cache check:', { cacheKey, hasCached: !!cached, cacheSourceMatch: cached?.source === featureGeoJSON });
    if (cached && cached.source === featureGeoJSON) {
      console.log('[NetworkModule] Using cached rows:', cached.rows.length);
      setTableRows(cached.rows);
      setRowsReady(true);
      return;
    }

    // build rows and then cache from geojson
    console.log('[NetworkModule] Building rows from geojson');
    const builtRows = buildRowsFromGeojson(featureGeoJSON, selectedGraph);
    console.log('[NetworkModule] Built rows:', builtRows.length);
    cachedRowsRef.current.set(cacheKey, { source: featureGeoJSON, rows: builtRows });
    setTableRows(builtRows);
    setRowsReady(true);
    console.log('[NetworkModule] Rows ready set to true');
  }, [canton, featureGeoJSON, selectedGraph]);
  
  useEffect(() => {
    if (!canton || !featureGeoJSON) {
      if (!canton) {
        cachedRowsRef.current.clear();
      }
      setTableRows([]);
      setRowsReady(false);
      return;
    }
    const cached = cachedRowsRef.current.get(canton);

    // use cached if available
    if (cached && cached.source === featureGeoJSON) {
      setTableRows(cached.rows);
      setRowsReady(true);
    } else {
      // clear cache if canton changed
      cachedRowsRef.current.delete(canton);
      setTableRows([]);
      setRowsReady(false);
    }
  }, [canton, featureGeoJSON, selectedGraph]);
  
  useEffect(() => {
    // table not shown, so don't build rows
    if (!showTable) {
      return;
    }
    
    // trigger row building in idle time
    let cancelled = false;
    const run = () => {
      if (!cancelled) {
        ensureRowsForCanton();
      }
    };
    
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      // run when idle, but at most after 200ms
      const idleId = window.requestIdleCallback(run, { timeout: 200 });
      return () => {
        cancelled = true;
        if (typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(idleId);
        }
      };
    }
    
    // fallback for browsers without requestIdleCallback
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
        // sends to update attribute table on sidebar
        setSelectedNetworkFeature?.([featureProps]);
      }
      const payload = buildSelectionPayload(row);
      if (payload) {
        // sends to zoom to feature on map
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
      selectedGraph={selectedGraph}
      tableId="network-feature-table"
      rows={tableRows}
      geojson={rowsReady ? null : featureGeoJSON}
      selectedModes={selectedNetworkModes}
      onRowClick={handleTableRowSelect}
      onSelectCoords={handleSelectCoords}
      height={"55vh"}
      useScroller
      loading={!showTable || !rowsReady}
      setTableFilterQuery={setTableFilterQuery}
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
