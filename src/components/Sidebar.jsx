import React, { useState, useEffect  } from "react";
import "./Sidebar.css";

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

const Sidebar = ({canton, isOpen, toggleSidebar, onExpandGraph, setCanton, resetMapView, updateMapSymbology,
  selectedNetworkModes, setSelectedNetworkModes, selectedNetworkFeature, setVisualizeLinkId, dataURL, setDataURL,
  selectedTransitModes, setSelectedTransitModes, selectedTransitStop, highlightedLineId, setHighlightedLineId,
  setHighlightedRouteIds, setHoveredRouteId,showStopVolumeSymbology, setShowStopVolumeSymbology }) => {
    
    // ======================= INITIALIZE VARIABLES =======================
    
    const [selectedGraph, setSelectedGraph] = useState(null); // Current module
    const [selectedMode, setSelectedMode] = useState("None"); // Choropleth mode
    const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // Choropleth dataset
    const [availableModes, setAvailableModes] = useState([]); // Available modes for network filter
    const [selectedAggCol, setSelectedAggCol] = useState("mode"); // For graphs
    const [modesByCanton, setModesByCanton] = useState({}); // For mode filter (only show modes available in each canton)
    const [inputURL, setInputURL] = useState("");
    
    // Transit module
    const [availableTransitModes, setAvailableTransitModes] = useState([]);
    const [transitModesByCanton, setTransitModesByCanton] = useState({});
    
    
    // ======================= GENERAL FEATURES (BUTTONS / DROPDOWN) =======================
    
    // Get modes per canton from JSON file
    useEffect(() => {
      const dataPath = `${dataURL}modes_by_canton.json`;
      fetch(dataPath)
      .then(res => res.json())
      .then(data => setModesByCanton(data))
      .catch(err => console.error("Failed to load modes_by_canton.json", err));
    }, []);
    
    // Get transit modes per stops
    useEffect(() => {
      fetch(`${dataURL}/matsim/transit/transit_stop_modes_by_canton.json`)
      .then((res) => res.json())
      .then((data) => setTransitModesByCanton(data))
      .catch((err) => console.error("Failed to load transit modes:", err));
    }, []);
    
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
              dataURL={dataURL}
              />
              <CantonModeShareTable canton={canton} selectedDataset={selectedDataset} selectedMode={selectedMode} dataURL={dataURL} />
              </div>
            )}
            
            {/* Network Module */}
            {selectedGraph === "Network" && (
              
              <div>
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
                <SegmentAttributesTable properties={selectedNetworkFeature[0]} />
              )}
              </div>
            )}
            
            {selectedGraph === "Volumes" && (
              <div className="plot-container">
              {selectedNetworkFeature && (
                <SegmentAttributesTable properties={selectedNetworkFeature[0]} selectedGraph={selectedGraph}/>
              )}
              
              {selectedNetworkFeature ? (
                <SegmentVolumeHistogram
                linkId={selectedNetworkFeature.map(f => f.id)}
                setVisualizeLinkId={setVisualizeLinkId}
                canton={canton}
                dataURL={dataURL}
                />
              ) : (
                <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
                Click a canton and/or segment to see hourly volumes.
                </p>
              )}
              </div>
            )}
            
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
              <label>
              <input
              type="checkbox"
              checked={showStopVolumeSymbology}
              onChange={(e) => setShowStopVolumeSymbology(e.target.checked)}
              style={{ marginRight: "0.5rem" }}
              />
              Show stop volumes
              </label>
              </div>
              {selectedTransitStop && (
                <TransitStopAttributesTable
                properties={selectedTransitStop}
                highlightedLineId={highlightedLineId}
                onLineClick={(lineId, routeIds) => {
                  setHighlightedLineId(lineId);
                  setHighlightedRouteIds(routeIds);
                }}
                onRouteHover={setHoveredRouteId}
                />
              )}
              {selectedTransitStop && (
                <TransitStopHistogram
                stopIds={selectedTransitStop.stop_ids}
                canton={canton}
                dataURL={dataURL}
                lineId={highlightedLineId}
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
      