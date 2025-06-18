import React from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import SegmentVolumeHistogram from "./SegmentVolumeHistogram";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";

const VolumesModule = ({
    selectedNetworkFeature,
    selectedGraph,
    setVisualizeLinkId,
    canton,
    timeRange,
    setTimeRange,
}) => (
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
    </div>
    
    {selectedNetworkFeature && (
        <SegmentAttributesTable propertiesList={selectedNetworkFeature} selectedGraph={selectedGraph}/>
    )}
    
    {selectedNetworkFeature ? (
        <SegmentVolumeHistogram
        linkId={selectedNetworkFeature.map(f => f.id)}
        setVisualizeLinkId={setVisualizeLinkId}
        canton={canton}
        timeRange={timeRange}
        />
    ) : (
        <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
        Click a canton and/or segment to see hourly volumes.
        </p>
    )}
    </div>
);

export default VolumesModule;
