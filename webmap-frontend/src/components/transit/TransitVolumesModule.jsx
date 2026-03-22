import React, { useState, useCallback, useRef } from "react";
import TransitLinkAttributesTable from "./TransitLinkAttributesTable";
import TransitLinkHistogram from "./TransitLinkHistogram";
import FeatureTable from "../table/FeatureTable";
import Slider from "rc-slider";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import "rc-slider/assets/index.css";
import { useTableRowBuilder } from "../../hooks/useTableRowBuilder";

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
  isFeatureTableOpen,
  featureGeoJSON,
  transitFeatureTableRef,
  setTableFilterQuery,
  selectedGraph,
  onFocusTransitFeature
}) => {

  // Reset highlighted line when canton changes (was useEffect)
  const prevCantonRef = useRef(canton);
  if (prevCantonRef.current !== canton) {
    prevCantonRef.current = canton;
    setHighlightedLineId(null);
  }

  // Keep highlightedLineId if new link also has it, else reset (was useEffect)
  const prevTransitLinkRef = useRef(selectedTransitLink);
  if (prevTransitLinkRef.current !== selectedTransitLink) {
    prevTransitLinkRef.current = selectedTransitLink;
    if (!Array.isArray(selectedTransitLink) || selectedTransitLink.length === 0) {
      setHighlightedLineId(null);
    } else {
      const hasLine = selectedTransitLink.some(link =>
        link.lines && Object.keys(link.lines).includes(highlightedLineId)
      );
      if (!hasLine) setHighlightedLineId(null);
    }
  }

  // ========= FEATURE TABLE LOGIC =========
  const { showTable, tableRows, rowsReady } = useTableRowBuilder({
    isFeatureTableOpen,
    canton,
    featureGeoJSON,
    selectedGraph,
    setTableFilterQuery,
    useCache: false,
  });

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
    {isFeatureTableOpen ? (
      <FeatureTable
      ref={transitFeatureTableRef}
      tableId="transit-volumes-feature-table"
      rows={tableRows}
      geojson={rowsReady ? null : featureGeoJSON}
      selectedModes={selectedTransitModes}
      onRowClick={handleTableRowSelect}
      onSelectCoords={handleSelectCoords}
      height={"55vh"}
      useScroller
      loading={!showTable || !rowsReady}
      setTableFilterQuery={setTableFilterQuery}
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
    <div className="right-sidebar-control-row">

    {/* Slider and label */}
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

    {/* Checkbox */}
    <label className="right-sidebar-checkbox">
    <input
    type="checkbox"
    checked={showLineSymbology}
    onChange={(e) => setShowLineSymbology(e.target.checked)}
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

      <div style={{ height: 12 }} />

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
