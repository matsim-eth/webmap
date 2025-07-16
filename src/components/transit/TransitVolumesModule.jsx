import React, { useState, useEffect } from "react";
import SegmentVolumeHistogram from "../matsim/SegmentVolumeHistogram";
import SegmentAttributesTable from "../matsim/SegmentAttributesTable";
import Slider from "rc-slider";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import "rc-slider/assets/index.css";

const TransitVolumesModule = ({
  selectedNetworkFeature, // clicked transit segment(s)
  selectedGraph,
  canton,
  timeRange,
  setTimeRange,
  availableTransitModes,
  selectedTransitModes,
  setSelectedTransitModes
}) => {

  const [filteredVolume, setFilteredVolume] = useState(null);
  
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
    </div>

    {/* Time Range + Slider */}
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0.5rem 2rem 2rem 0.5rem",
      gap: "1rem",
    }}>
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
          onChange={setTimeRange}
          allowCross={false}
          style={{ marginLeft: "10%", width: "80%" }}
        />
      </div>
    </div>
      

      {/* Segment Info */}
      {selectedNetworkFeature && (
        <SegmentAttributesTable
          propertiesList={selectedNetworkFeature}
          selectedGraph={selectedGraph}
          filteredVolume={filteredVolume}
        />
      )}

      {/* Histogram */}
      {selectedNetworkFeature ? (
        <SegmentVolumeHistogram
          linkId={selectedNetworkFeature.map(f => f.id)}
          canton={canton}
          timeRange={timeRange}
          onVolumeUpdate={setFilteredVolume}
          dataPath="matsim/transit/link_passenger_volumes.json" // <- you’ll create this
        />
      ) : (
        <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
          Click a transit segment to see hourly volumes.
        </p>
      )}
    </div>
  );
};

export default TransitVolumesModule;
