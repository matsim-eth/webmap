import React, {useState, useEffect} from "react";
import TransitStopAttributesTable from "./TransitStopAttributesTable";
import TransitStopHistogram from "./TransitStopHistogram";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";


const TransitModule = ({
    selectedTransitModes,
    selectedTransitStop,
    highlightedLineId,
    setHighlightedLineId,
    setHighlightedRouteIds,
    setSelectedTransitModes, 
    setHoveredRouteId,
    showStopVolumeSymbology,
    setShowStopVolumeSymbology,
    canton,
    availableTransitModes,
    timeRange,
    setTimeRange,
}) => {
    
    const [filteredStopVolumes, setFilteredStopVolumes] = useState(null); // total filtered volumes per stop
    const loadWithFallback = useLoadWithFallback();

    // If a new line is selected and its mode is not included in the current filter,
    // reset the mode filter to "all" so the line remains visible.
    useEffect(() => {
        const resetIfExcluded = async () => {
            if (!highlightedLineId) return;
            if (!Array.isArray(selectedTransitModes)) return;
            if (selectedTransitModes.includes("all")) return;
            try {
                const routes = await loadWithFallback("matsim/transit/routes/transit_routes.geojson");
                const feat = routes?.features?.find(
                    (f) => String(f?.properties?.line_id) === String(highlightedLineId)
                );
                const mode = feat?.properties?.mode && String(feat.properties.mode);
                if (mode && !selectedTransitModes.includes(mode)) {
                    setSelectedTransitModes(["all"]);
                }
            } catch (e) {
                // ignore fetch/parse issues silently
            }
        };
        resetIfExcluded();
    }, [highlightedLineId]);

    // Push to Map the selected transit stop mode filter
    const handleTransitModeChange = (event) => {
        const selectedOptions = Array.from(event.target.selectedOptions).map((option) => option.value);
        if (selectedOptions.includes("all") || selectedOptions.length === 0) {
            setSelectedTransitModes(["all"]);
        } else {
            setSelectedTransitModes(selectedOptions);
        }
    };
    
    return(
        <div style={{ overflowY: "auto", overflowX: "hidden", width: "100%" }}>
        
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
        checked={showStopVolumeSymbology}
        onChange={(e) => setShowStopVolumeSymbology(e.target.checked)}
        style={{ marginRight: "0.5rem" }}
        />
        Show stop volumes
        </label>
        
        </div>
        
        </div>
        {selectedTransitStop && (
            <>
            <TransitStopAttributesTable
            properties={{
                ...selectedTransitStop,
                ...(filteredStopVolumes ?? {}) 
            }}
            highlightedLineId={highlightedLineId}
            onLineClick={(lineId, routeIds) => {
                if (lineId) {
                  // Determine mode of the clicked line from the current stop's lines
                  const allLines = Array.isArray(selectedTransitStop?.lines) ? selectedTransitStop.lines : [];
                  const match = allLines.find(l => String(l?.line_id) === String(lineId));
                  const mode = match?.mode && String(match.mode);
                  if (mode && Array.isArray(selectedTransitModes) && !selectedTransitModes.includes('all') && !selectedTransitModes.includes(mode)) {
                    // Reset filter to all first so the line will be visible
                    setSelectedTransitModes(['all']);
                  }
                }
                setHighlightedLineId(lineId);
                setHighlightedRouteIds(routeIds);
            }}
            onRouteHover={setHoveredRouteId}
            />
            
            </>
            
        )}
        {selectedTransitStop && (
            <TransitStopHistogram
            stopIds={selectedTransitStop.stop_ids}
            canton={canton}
            lineId={highlightedLineId}
            onVolumeUpdate={setFilteredStopVolumes}
            timeRange={timeRange}
            />
        )}
        </div>
    );
}

export default TransitModule;
