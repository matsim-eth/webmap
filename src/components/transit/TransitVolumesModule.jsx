import React, { useState, useEffect, useCallback } from "react";
import TransitLinkAttributesTable from "./TransitLinkAttributesTable";
import TransitLinkHistogram from "./TransitLinkHistogram"; 
import FeatureTable, { buildRowsFromGeojson } from "../table/FeatureTable";
import Slider from "rc-slider";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import "rc-slider/assets/index.css";

// get coords and id of selected row
const buildSelectionPayload = (row) => {
  if (!row) return null;
  const coords = row.coords;
  const id = row.rowKey;
  const feature = row.feature;
  return { id, feature, coords };
};

const TransitVolumesModule = ({
  selectedTransitLink, // clicked transit segment(s)
  setSelectedTransitLink,
  timeRange,
  setTimeRange,
  availableTransitModes,
  selectedTransitModes,
  setSelectedTransitModes,
  canton,
  showLineSymbology,
  setShowLineSymbology,
  setHighlightedLineId,
  highlightedLineId,
  visualizeLinkId,
  setVisualizeLinkId,
  isTransitFeatureTableOpen,
  transitFeatureGeoJSON,
  transitFeatureTableRef,
  setTransitTableFilterQuery,
  selectedGraph,
  onFocusTransitFeature
}) => {
  
  // reset selected line when canton changes
  useEffect(() => {
    setHighlightedLineId(null);
  }, [canton]);
  
  
  // keep highlightedLineId if new link also has it, else reset it
  useEffect(() => {
    if (!Array.isArray(selectedTransitLink) || selectedTransitLink.length === 0) {
      setHighlightedLineId(null);
      return;
    }
    
    const hasLine = selectedTransitLink.some(link =>
      link.lines && Object.keys(link.lines).includes(highlightedLineId)
    );
    
    if (!hasLine) setHighlightedLineId(null);
  }, [selectedTransitLink]);
  
  // ========= FEATURE TABLE LOGIC =========
  const [showTable, setShowTable] = useState(false);
  const [tableRows, setTableRows] = useState([]);
  const [rowsReady, setRowsReady] = useState(false);
  
  useEffect(() => {
    if (isTransitFeatureTableOpen) {
      // add delay so sidebar can expand first
      const timer = setTimeout(() => setShowTable(true), 400);
      return () => clearTimeout(timer);
    }
    setShowTable(false);
    setTransitTableFilterQuery(null);
  }, [isTransitFeatureTableOpen]);
  
  const ensureRowsForCanton = useCallback(() => {
    // if missing canton or data, clear
    if (!canton || !transitFeatureGeoJSON) {
      setTableRows([]);
      setRowsReady(false);
      return;
    }

    // In TransitVolumes module, always rebuild rows (no caching due to timeRange changes)
    const builtRows = buildRowsFromGeojson(transitFeatureGeoJSON, selectedGraph);
    setTableRows(builtRows);
    setRowsReady(true);
  }, [canton, transitFeatureGeoJSON, selectedGraph]);
  
  useEffect(() => {
    if (!canton || !transitFeatureGeoJSON) {
      setTableRows([]);
      setRowsReady(false);
      return;
    }
    
    // In TransitVolumes module, always rebuild when geojson changes
    setTableRows([]);
    setRowsReady(false);
  }, [canton, transitFeatureGeoJSON]);
  
  useEffect(() => {
    // table not shown, so don't build rows
    if (!showTable) return;
    
    // trigger row building in idle time
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
  }, [showTable, ensureRowsForCanton, canton, transitFeatureGeoJSON]);
  
  const handleTableRowSelect = useCallback(
    (row) => {
      if (!row) return;
      const featureProps = row.featureProps || row.feature?.properties;
      if (featureProps) {
        // sends to update attribute table on sidebar
        setSelectedTransitLink?.([featureProps]);
      }
      const payload = buildSelectionPayload(row);
      if (payload) {
        // sends to zoom to feature on map
        onFocusTransitFeature?.(payload);
      }
    },
    [onFocusTransitFeature, setSelectedTransitLink]
  );
  
  const handleSelectCoords = useCallback(
    (coords, row) => {
      if (!row) return;
      handleTableRowSelect({ ...row, coords: coords || row.coords });
    },
    [handleTableRowSelect]
  );
  
  
  // Push to Map the selected transit stop mode filter
  const handleTransitModeChange = (event) => {
    const selectedOptions = Array.from(event.target.selectedOptions).map((option) => option.value);
    if (selectedOptions.includes("all") || selectedOptions.length === 0) {
      setSelectedTransitModes(["all"]);
    } else {
      setSelectedTransitModes(selectedOptions);
    }
  };
  
  return (
    <div className="plot-container">
    {isTransitFeatureTableOpen ? (
      <FeatureTable
      ref={transitFeatureTableRef}
      tableId="transit-volumes-feature-table"
      rows={tableRows}
      geojson={rowsReady ? null : transitFeatureGeoJSON}
      selectedModes={selectedTransitModes}
      onRowClick={handleTableRowSelect}
      onSelectCoords={handleSelectCoords}
      height={"55vh"}
      useScroller
      loading={!showTable || !rowsReady}
      setTableFilterQuery={setTransitTableFilterQuery}
      showMajorRoadsOnly={false}
      selectedGraph={selectedGraph}
      />
    ) : (
      <>
    <div style={{ overflowY: "auto", overflowX: "hidden", width: "100%" }}>
    
    {/* Mode Filter Dropdown */}
    <div className="mode-filter-container">
    <label className="mode-filter-label">Filter by Mode:</label>
    <select
    multiple
    value={selectedTransitModes}
    onChange={handleTransitModeChange}
    className="mode-filter-select"
    >
    <option value="all">All</option>
    {availableTransitModes.map((mode) => (
      <option key={mode} value={mode}>
      {mode.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
      </option>
    ))}
    </select>
    {/* Time Range + Checkbox Row */}
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0.5rem 2rem 2rem 0.5rem",
      gap: "1rem",
    }}>
    
    
    {/* Slider and label */}
    <div style={{ flex: 1 }}>
    <label style={{
      fontWeight: "bold",
      fontSize: "10pt",
      display: "block",
      marginBottom: "0.25rem",
      marginLeft: "7%"
    }}>
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
    
    {/* Checkbox */}
    <label style={{ fontWeight: "bold", fontSize: "10pt", whiteSpace: "nowrap" }}>
    <input
    type="checkbox"
    checked={showLineSymbology}
    onChange={(e) => setShowLineSymbology(e.target.checked)}
    style={{ marginRight: "0.5rem" }}
    />
    Toggle Stops
    </label>
    
    </div>
    
    </div>
    
    {/* Link Attributes Table and Histograms */}
    {Array.isArray(selectedTransitLink) && selectedTransitLink.length > 0 && (
      <>
      <TransitLinkAttributesTable
      propertiesList={selectedTransitLink}
      onLineClick={setHighlightedLineId}
      highlightedLineId={highlightedLineId}
      timeRange={timeRange}
      />
      
      {(() => {
        // Collect all unique link IDs across all selected segments
        const allLinkIds = new Set();
        selectedTransitLink.forEach(props => {
          const ids = Array.isArray(props.link_ids) && props.link_ids.length
            ? props.link_ids
            : (props.per_id_keys ? props.per_id_keys.split("|").filter(Boolean) : []);
          ids.forEach(id => allLinkIds.add(String(id)));
        });
        
        // Create one histogram per unique link ID
        return Array.from(allLinkIds).map(id => (
          <TransitLinkHistogram
          key={`transit-hist-${id}`}
          linkId={id}
          highlightedLineId={highlightedLineId}
          timeRange={timeRange}
          canton={canton}
          visualizeLinkId={visualizeLinkId}
          setVisualizeLinkId={setVisualizeLinkId}
          />
        ));
      })()}
      
      </>
    )}
    </div>
    </>
    )}
    </div>
  );
};

export default TransitVolumesModule;
