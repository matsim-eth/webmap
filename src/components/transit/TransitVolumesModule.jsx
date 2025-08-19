import React, { useState, useEffect } from "react";
import TransitLinkAttributesTable from "./TransitLinkAttributesTable";
import TransitLinkHistogram from "./TransitLinkHistogram"; 
import Slider from "rc-slider";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import "rc-slider/assets/index.css";

const TransitVolumesModule = ({
  selectedTransitLink, // clicked transit segment(s)
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
  setVisualizeLinkId
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
      
      {selectedTransitLink.flatMap((props, idx) => {
        const ids = Array.isArray(props.link_ids) && props.link_ids.length
        ? props.link_ids
        : (props.per_id ? Object.keys(props.per_id) : []);
        const baseKey = props.link_key_join || String(idx);
        return ids.map(id => (
          <TransitLinkHistogram
          key={`${baseKey}-${String(id)}`}
          linkId={String(id)}
          highlightedLineId={highlightedLineId}
          timeRange={timeRange}
          canton={canton}
          visualizeLinkId={visualizeLinkId}
          setVisualizeLinkId={setVisualizeLinkId}
          />
        ));
      })}
      
      </>
    )}
    </div>
  );
};

export default TransitVolumesModule;
