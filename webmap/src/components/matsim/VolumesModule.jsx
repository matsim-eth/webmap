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

    // In Volumes module, always rebuild rows (no caching due to timeRange changes)
    // build rows directly from geojson
    const builtRows = buildRowsFromGeojson(featureGeoJSON, selectedGraph);
    setTableRows(builtRows);
    setRowsReady(true);
  }, [canton, featureGeoJSON, selectedGraph]);
  
  useEffect(() => {
    if (!canton || !featureGeoJSON) {
      setTableRows([]);
      setRowsReady(false);
      return;
    }
    
    // In Volumes module, always rebuild when geojson changes (no caching)
    setTableRows([]);
    setRowsReady(false);
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
      selectedGraph={selectedGraph}
      />
    ) : (
      <>
    {/* Time Range Slider UI — shared with Transit */}
    <div className="right-sidebar-control-row">
    <div style={{ flex: 1 }}>
    <label className="right-sidebar-label" style={{ marginLeft: "7%" }}>
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

    <div style={{ padding: "0 16px 12px 12px" }}>
    <label className="right-sidebar-label">
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
    <label className="right-sidebar-checkbox">
    <input
    type="checkbox"
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
        // Extract link IDs from pipe-separated per_id_keys
        const perIdKeys = selectedNetworkFeature[0]?.per_id_keys;
        if (perIdKeys && typeof perIdKeys === 'string') {
          const ids = perIdKeys.split("|").filter(Boolean);
          return ids.length ? ids : [String(selectedNetworkFeature[0]?.id ?? '')];
        }
        // Fallback to feature id if per_id_keys not available
        return [String(selectedNetworkFeature[0]?.id ?? '')];
      })()}
      visualizeLinkId={visualizeLinkId}
      setVisualizeLinkId={setVisualizeLinkId}
      canton={canton}
      timeRange={timeRange}
      onVolumeUpdate={setFilteredVolume}
      />
    ) : (
      <p style={{ padding: "1rem", fontStyle: "italic", color: "#9ca3af" }}>
      Click a canton and/or segment to see hourly volumes.
      </p>
    )}
    </>
    )}
    </div>
  );
}

export default VolumesModule;

