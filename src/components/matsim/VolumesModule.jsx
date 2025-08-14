import React, { useState } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import SegmentVolumeHistogram from "./SegmentVolumeHistogram";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";

const VolumesModule = ({
    selectedNetworkFeature,
    selectedGraph,
    visualizeLinkId,
    setVisualizeLinkId,
    canton,
    timeRange,
    setTimeRange,
    showMajorRoadsOnly,
    setShowMajorRoadsOnly,
    labelSize,
    setLabelSize
}) => {
    
    const [filteredVolume, setFilteredVolume] = useState(null);


    return (

    <div className="plot-container">
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
    </div>
);
}

export default VolumesModule;
