import React from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";

const NetworkModule = ({
  selectedNetworkModes,
  availableModes,
  selectedNetworkFeature,
  handleModeChange,
}) => (
  <div className="plot-container">
    {/* Mode Filter Dropdown */}
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

    {/* Segment Attributes */}
    {selectedNetworkFeature && (
      <SegmentAttributesTable propertiesList={selectedNetworkFeature} />
    )}
  </div>
);

export default NetworkModule;
