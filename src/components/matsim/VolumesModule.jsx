import React, { useState, useCallback, useEffect, useRef } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import SegmentVolumeHistogram from "./SegmentVolumeHistogram";
import FeatureTable, { buildRowsFromGeojson } from "../table/FeatureTable";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";

// get coords and id of selected row
const buildSelectionPayload = (row) => {
  if (!row) return null;
  const coords= row.coords;
  const id = row.rowKey; // add other ones if needed
  const feature = row.feature;
  return { id, feature, coords };
};

const VolumesModule = ({
  selectedNetworkFeature,
  setSelectedNetworkFeature,
  selectedGraph,
  visualizeLinkId,
  setVisualizeLinkId,
  canton,
  timeRange,
  setTimeRange,
  showMajorRoadsOnly,
  setShowMajorRoadsOnly,
  labelSize,
  setLabelSize,
  isFeatureTableOpen,
  featureGeoJSON,
  onFocusNetworkFeature,
  featureTableRef,
  setTableFilterQuery,
  selectedNetworkModes
}) => {
  
  const [filteredVolume, setFilteredVolume] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const [tableRows, setTableRows] = useState([]);
  const [rowsReady, setRowsReady] = useState(false);
  const cachedRowsRef = useRef(new Map());
  
  useEffect(() => {
    if (isFeatureTableOpen) {
      // add delay so sidebar can expand first
      const timer = setTimeout(() => setShowTable(true), 400);
      return () => clearTimeout(timer);
    }
    setShowTable(false);
    setTableFilterQuery(null);
  }, [isFeatureTableOpen]);
  
  const ensureRowsForCanton = useCallback(() => {

    // if missing canton or data, clear
    if (!canton || !featureGeoJSON) {
      setTableRows([]);
      setRowsReady(false);
      return;
    }

    // cache data unless canton changed
    const cacheKey = canton;
    const cached = cachedRowsRef.current.get(cacheKey);
    if (cached && cached.source === featureGeoJSON) {
      setTableRows(cached.rows);
      setRowsReady(true);
      return;
    }

    // build rows and then cache from geojson
    const builtRows = buildRowsFromGeojson(featureGeoJSON);
    cachedRowsRef.current.set(cacheKey, { source: featureGeoJSON, rows: builtRows });
    setTableRows(builtRows);
    setRowsReady(true);
  }, [canton, featureGeoJSON]);
  
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
  }, [canton, featureGeoJSON]);
  
  useEffect(() => {
    // table not shown, so don't build rows
    if (!showTable) return;
    
    // trigger row building in idle time
    let cancelled = false;
    const run = () => {
      if (!cancelled) ensureRowsForCanton();
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
      tableId="volumes-feature-table"
      rows={tableRows}
      geojson={rowsReady ? null : featureGeoJSON}
      selectedModes={selectedNetworkModes}
      onRowClick={handleTableRowSelect}
      onSelectCoords={handleSelectCoords}
      height={"55vh"}
      useScroller
      loading={!showTable || !rowsReady}
      setTableFilterQuery={setTableFilterQuery}
      showMajorRoadsOnly={showMajorRoadsOnly}
      />
    ) : (
      <>
    {/* Time Range Slider UI — shared with Transit */}
    <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "0.5rem 2rem 1rem 1rem",
    }}
    >
    <div style={{ flex: 1 }}>
    <label
    style={{
      fontWeight: "bold",
      fontSize: "10pt",
      display: "block",
      marginBottom: "0.25rem",
      marginLeft: "7%",
    }}
    >
    Time: {formatTimeLabel(timeRange[0])} - {formatTimeLabel(timeRange[1])}
    </label>
    <Slider
    range
    min={0}
    max={96}
    step={1}
    marks={marks}
    value={timeRange}
    onChange={(val) => setTimeRange(val)}
    allowCross={false}
    style={{ marginLeft: "10%", width: "80%" }}
    />
    </div>
    
    <div style={{ padding: "0 2rem 1rem 1rem" }}>
    <label
    style={{
      fontWeight: "bold",
      fontSize: "10pt",
      display: "block",
      marginBottom: 6
    }}
    >
    Label size: {labelSize}px
    </label>
    <Slider
    min={8}
    max={24}
    step={1}
    value={labelSize}
    onChange={setLabelSize}
    style={{ width: "50%" }}
    />
    </div>
    
    
    {/* Checkbox */}
    <label style={{ fontWeight: "bold", fontSize: "10pt", whiteSpace: "nowrap" }}>
    <input
    type="checkbox"
    style={{ marginRight: "0.5rem" }}
    checked={showMajorRoadsOnly}
    onChange={(e) => setShowMajorRoadsOnly(e.target.checked)}
    />
    Show only major roads
    </label>
    </div>
    
    {selectedNetworkFeature && (
      <SegmentAttributesTable 
      propertiesList={selectedNetworkFeature}
      selectedGraph={selectedGraph}
      filteredVolume={filteredVolume}
      />
    )}
    
    {selectedNetworkFeature ? (
      <SegmentVolumeHistogram
      linkId={(() => {
        const per = selectedNetworkFeature[0]?.per_id;
        const perObj =
        typeof per === 'string'
        ? (() => { try { return JSON.parse(per); } catch { return {}; } })()
        : (per || {});
        const ids = Object.keys(perObj);
        return ids.length ? ids : [String(selectedNetworkFeature[0]?.id ?? '')];
      })()}
      visualizeLinkId={visualizeLinkId}
      setVisualizeLinkId={setVisualizeLinkId}
      canton={canton}
      timeRange={timeRange}
      onVolumeUpdate={setFilteredVolume}
      />
    ) : (
      <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
      Click a canton and/or segment to see hourly volumes.
      </p>
    )}
    </>
    )}
    </div>
  );
}

export default VolumesModule;

