import React, { useState, useEffect, useRef  } from "react";
import "./Sidebar.css";
import Slider from "rc-slider"; 
import "rc-slider/assets/index.css";
import { useFileContext } from "../FileContext";
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

// Sidebar Modules / Graphs
import ActivityDist from "./ActivityDist";
import AverageDist from "./AverageDist";
import Histogram from "./Histogram";
import StackedBarPlot from "./StackedBarPlot";
import ChoroplethControls from "./ChoroplethControls";
import CantonModeShareTable from "./CantonModeShareTable"; 
import CarAvailability from "./CarAvailability";
import DepartureTimes from "./DepartureTimes";
import ModeShareLinePlot from "./ModeShareLinePlot";
import SegmentAttributesTable from "./SegmentAttributesTable";
import PtSubscription from "./PtSubscription";
import SegmentVolumeHistogram from "./SegmentVolumeHistogram";
import TransitStopAttributesTable from "./TransitStopAttributesTable";
import Demographics from "./Demographics";
import TransitStopHistogram from "./TransitStopHistogram";
import DestinationZones from "./DestinationZones";

const Sidebar = ({canton, isOpen, toggleSidebar, onExpandGraph, setCanton, resetMapView, updateMapSymbology,
  selectedNetworkModes, setSelectedNetworkModes, selectedNetworkFeature, setVisualizeLinkId, dataURL, setDataURL,
  selectedTransitModes, setSelectedTransitModes, selectedTransitStop, highlightedLineId, setHighlightedLineId,
  setHighlightedRouteIds, setHoveredRouteId,showStopVolumeSymbology, setShowStopVolumeSymbology, timeRange, setTimeRange,
  selectedAggCol, setSelectedAggCol, setDestinationData}) => {
    
    // ======================= INITIALIZE VARIABLES =======================
    
    const [selectedGraph, setSelectedGraph] = useState(null); // Current module
    const [selectedMode, setSelectedMode] = useState("None"); // Choropleth mode
    const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // Choropleth dataset
    const [availableModes, setAvailableModes] = useState([]); // Available modes for network filter
    const [modesByCanton, setModesByCanton] = useState({}); // For mode filter (only show modes available in each canton)
    const [inputURL, setInputURL] = useState("");
    
    // Transit module
    const [availableTransitModes, setAvailableTransitModes] = useState([]);
    const [transitModesByCanton, setTransitModesByCanton] = useState({});
    const [filteredStopVolumes, setFilteredStopVolumes] = useState(null); // total filtered volumes per stop
    
    // Add state for destination outflow data
    const [destinationOutflowData, setDestinationOutflowData] = useState(null);

    // Data upload
    const { handleFolderUpload, fileMap, clearFileMap } = useFileContext();
    const loadWithFallback = useLoadWithFallback(dataURL);
    const fileInputRef = useRef();
    
    const formatTimeLabel = (index) => {
      const hours = Math.floor(index / 4);
      const minutes = (index % 4) * 15;
      return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
    };
    const marks = {
      0: "00:00",
      24: "06:00",
      48: "12:00",
      72: "18:00",
      96: "24:00"
    };
    
    // ======================= GENERAL FEATURES (BUTTONS / DROPDOWN) =======================
    
    // Get modes per canton from JSON file
    useEffect(() => {
      loadWithFallback("modes_by_canton.json")
      .then(data => setModesByCanton(data))
      .catch(err => console.error("Failed to load modes_by_canton.json", err));
    }, [dataURL]);
    
    // Get transit modes per stops
    useEffect(() => {
      loadWithFallback("matsim/transit/transit_modes_by_canton.json")
      .then(data => setTransitModesByCanton(data))
      .catch(err => console.error("Failed to load transit modes:", err));
    }, [dataURL]);
    
    // Push current module to Map
    const handleGraphSelection = (event) => {
      const graph = event.target.value;
      setSelectedGraph(graph);
      onExpandGraph(graph);
      
      // Set corresponding default selected modes per module
      if (graph === "Volumes") {
        setSelectedNetworkModes(["car"]);
      }
      
      if (graph === "Network") {
        setSelectedNetworkModes(["all"]);
      }
      
      if (graph != "Network" && graph != "Volumes") {
        setSelectedNetworkModes(["all"]);
      }
    };
    
    // Handle home button click
    const handleHome = () => {
      setSelectedGraph(null);
      onExpandGraph(null);
    };
    
    // Handle reset button click
    const handleReset = () => {
      setCanton(null);
      setSelectedDataset("Microcensus");
      setSelectedMode("None");
      setSelectedNetworkModes(["all"]);
      setSelectedTransitModes(["all"]);
      updateMapSymbology("None", selectedDataset);
      resetMapView();
      
      setHighlightedLineId(null);
      setHighlightedRouteIds([]);

      setSelectedGraph(null);
      onExpandGraph(null);

      clearFileMap();
      setDataURL("https://matsim-eth.github.io/webmap/data/");
      setInputURL(""); // clears the text field if you’re using it

    };
    
    
    // ======================= MATSIM NETWORK MODULE =======================
    
    // Get available modes per canton
    useEffect(() => {
      if (canton && modesByCanton[canton]) {
        setAvailableModes(
          modesByCanton[canton].filter(mode =>
            !["car_passenger", "truck", "train", "other", "pt"].includes(mode)
          )
        );
      } else {
        setAvailableModes([]);
      }
    }, [canton]);
    
    // Push to Map the selected modes
    const handleModeChange = (event) => {
      const selectedOptions = Array.from(event.target.selectedOptions).map((option) => option.value);
      
      if (selectedOptions.includes("all") || selectedOptions.length === 0) {
        setSelectedNetworkModes(["all"]);
      } else {
        setSelectedNetworkModes(selectedOptions);
      }
    };  
    
    // ======================== TRANSIT MODULE =======================
    
    // Get available transit modes per canton
    useEffect(() => {
      if (canton && transitModesByCanton[canton]) {
        setAvailableTransitModes(transitModesByCanton[canton]);
      } else {
        setAvailableTransitModes([]);
      }
    }, [canton]);
    
    // Push to Map the selected transit stop mode filter
    const handleTransitModeChange = (event) => {
      const selectedOptions = Array.from(event.target.selectedOptions).map((option) => option.value);
      if (selectedOptions.includes("all") || selectedOptions.length === 0) {
        setSelectedTransitModes(["all"]);
      } else {
        setSelectedTransitModes(selectedOptions);
      }
    };
    
    // Handle outflow data from DestinationZones and pass to Map
    const handleTotalOutflowChange = (outflowData) => {
      setDestinationOutflowData(outflowData);
      // Pass to Map component via setDestinationData prop
      if (setDestinationData) {
        console.log('Sidebar - calling setDestinationData with:', outflowData);
        setDestinationData(outflowData);
      } else {
        console.log('Sidebar - setDestinationData is not available');
      }
    };

    return (
      
      
      <div className={`floating-panel ${isOpen ?  // Sets the css for sidebar width
        (selectedGraph === "Graph 3" || selectedGraph === "Graph 4" ? "expanded-graph3" : 
          selectedGraph === "Choropleth"  || selectedGraph === "Network" ? "open" : 
          selectedGraph ? "expanded" : "open") 
          : "collapsed"}`}>
          <button className="toggle-button" onClick={toggleSidebar}>{isOpen ? "✕" : "☰"}</button>          
          
          
          {isOpen && (
            <div className="floating-content">
            <br />
            
            {/* Home, Reset, and Graph Selection */}
            <div className="button-row">
            <div className="button-group">
            <button className={`home-button ${!selectedGraph ? "active" : ""}`} onClick={handleHome}>
            Home
            </button>
            <button className="reset-button" onClick={handleReset}>
            Reset
            </button>
            <select className="graph-dropdown" value={selectedGraph || ""} onChange={handleGraphSelection}>
            <option value="">Select a Graph</option>
            <option value="Choropleth">{selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)} by Canton</option>
            <option value="Network">MATSim Network</option>
            <option value="Volumes">Road Volumes</option>
            <option value="Transit">Transit Stops/Lines</option>
            <option value="Destination">Destination Zones</option>
            <option value="Graph 1">Average Distance by {selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)}</option>
            <option value="Graph 2">Distance Distribution by {selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)}</option>
            <option value="Graph 3">{selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)} by Distance (Stacked)</option>
            <option value="Graph 4">{selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)} by Time/Distance (Line)</option>
            <option value="Graph 5">Activity Distribution</option>
            <option value="Graph 6">Public Transport Subscriptions</option>
            <option value="Graph 7">Car Availability Class</option>
            <option value="Graph 8">Departure Times</option>
            <option value="Graph 9">Demographics</option>
            </select>
            </div>
            </div>
            
            {/* Default View */}
            {!selectedGraph && (
              <div className="home-message">
              <p>Select a canton and a visualization to get started!</p>
              
              <div className="mode-filter-container">
              <label className="mode-filter-label">Data Source URL:</label>
              <div style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "10px" }}>
              <input
              type="text"
              value={inputURL} 
              onChange={(e) => setInputURL(e.target.value)}
              placeholder="https://matsim-eth.github.io/webmap/data/"
              className="mode-filter-select url-input"
              style={{ height: "28px" }}
              />
              <button
              className="graph-button"
              style={{ width: "fit-content" }}
              onClick={async () => {
                let trimmed = inputURL.trim() || "https://matsim-eth.github.io/webmap/data/";
                
                if (!trimmed.endsWith("/")) {
                  trimmed += "/";
                }
                
                try {
                  const response = await fetch(`${trimmed}modes_by_canton.json`);
                  if (!response.ok) {
                    throw new Error(`HTTP error ${response.status}`);
                  }
                  // Try to read data from URL
                  await response.json();
                  alert("Data loaded successfully from the provided URL.");
                  setDataURL(trimmed);
                } catch (error) {
                  alert("Failed to load data from the provided URL.\nPlease ensure the URL is correct and accessible.");
                  setDataURL("https://matsim-eth.github.io/webmap/data/"); // fallback
                  console.error("Data source error:", error);
                }
              }}
              >
              Set
              </button>
              </div>
              </div>
              
              <div className="mode-filter-container">
              <label className="mode-filter-label">Group Graphs By:</label>
              <select
              multiple
              value={[selectedAggCol]} // Wrap as array so it works with multiple
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions).map(opt => opt.value);
                if (selected.length > 0) {
                  setSelectedAggCol(selected[selected.length - 1]); // always use the last clicked one
                }
              }}
              className="mode-filter-select"
              >
              <option value="mode">Mode</option>
              <option value="purpose">Purpose</option>
              </select>
              </div>
              </div>
            )}

            {/* Rendering for graphs */}
            {selectedGraph === "Graph 1" && <div className="plot-container"><AverageDist canton={canton || "All"} aggCol={selectedAggCol} dataURL={dataURL}/></div>}
            {selectedGraph === "Graph 2" && <div className="plot-container"><Histogram canton={canton || "All"} aggCol={selectedAggCol} dataURL={dataURL}/></div>}
            {selectedGraph === "Graph 3" && <div className="plot-container"><StackedBarPlot canton={canton || "All"} aggCol={selectedAggCol} dataURL={dataURL}/></div>}
            {selectedGraph === "Graph 4" && <div className="plot-container"><ModeShareLinePlot canton={canton || "All"} aggCol={selectedAggCol} dataURL={dataURL}/></div>}
            {selectedGraph === "Graph 5" && <div className="plot-container"><ActivityDist canton={canton || "All"} dataURL={dataURL} /></div>}
            {selectedGraph === "Graph 6" && <div className="plot-container"><PtSubscription canton={canton || "All"} dataURL={dataURL} /></div>}
            {selectedGraph === "Graph 7" && <div className="plot-container"><CarAvailability canton={canton || "All"} dataURL={dataURL} /></div>}
            {selectedGraph === "Graph 8" && <div className="plot-container"><DepartureTimes canton={canton || "All"} dataURL={dataURL} /></div>}
            {selectedGraph === "Graph 9" && <div className="plot-container"><Demographics canton={canton || "All"} dataURL={dataURL} /></div>}
            
            {/* Mode Share Choropleth Selection */}
            {selectedGraph === "Choropleth" && (
              <div>
                <ChoroplethControls
                  selectedMode={selectedMode}
                  setSelectedMode={setSelectedMode}
                  selectedDataset={selectedDataset}
                  setSelectedDataset={setSelectedDataset}
                  updateMapSymbology={updateMapSymbology}
                  aggCol={selectedAggCol}
                />
                <CantonModeShareTable canton={canton} selectedDataset={selectedDataset} selectedMode={selectedMode} aggCol={selectedAggCol} />
              </div>
            )}
            
            {/* Destination Module */}
            {selectedGraph === "Destination" && (
              <div className="plot-container">
                <DestinationZones
                  canton={canton}
                  dataURL={dataURL}
                  onTotalOutflowChange={handleTotalOutflowChange}
                />
              </div>
            )}

            {/* Network Module */}
            {selectedGraph === "Network" && (
              <div className="plot-container">
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
                        {mode.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                      </option>
                    ))}
                  </select>
                </div>  
                {selectedNetworkFeature && (
                  <SegmentAttributesTable propertiesList={selectedNetworkFeature} />
                )}
              </div>
            )}

            {/* Volumes Module */}
            {selectedGraph === "Volumes" && (
              <div className="plot-container">
                {selectedNetworkFeature && (
                  <SegmentAttributesTable propertiesList={selectedNetworkFeature} selectedGraph={selectedGraph}/>
                )}
                
                {selectedNetworkFeature ? (
                  <SegmentVolumeHistogram
                    linkId={selectedNetworkFeature.map(f => f.id)}
                    setVisualizeLinkId={setVisualizeLinkId}
                    canton={canton}
                  />
                ) : (
                  <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
                    Click a canton and/or segment to see hourly volumes.
                  </p>
                )}
              </div>
            )}
            
            {/* Transit Module */}
            {selectedGraph === "Transit" && (
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
                        Time: {formatTimeLabel(timeRange[0])} – {formatTimeLabel(timeRange[1])}
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
            )}
          </div>
        )}
      </div>
    );
  };

  export default Sidebar;
