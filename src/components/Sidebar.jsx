import React, { useState, useEffect, useRef  } from "react";
import "./Sidebar.css";
import { useFileContext } from "../FileContext";

// ======================= IMPORT MODULES / GRAPHS =======================

// Graphs
import ActivityDist from "./plots/ActivityDist";
import AverageDist from "./plots/AverageDist";
import Histogram from "./plots/Histogram";
import StackedBarPlot from "./plots/StackedBarPlot";
import CarAvailability from "./plots/CarAvailability";
import DepartureTimes from "./plots/DepartureTimes";
import ModeShareLinePlot from "./plots/ModeShareLinePlot";
import PtSubscription from "./plots/PtSubscription";
import Demographics from "./plots/Demographics";
import DestinationZones from "./plots/DestinationZones";

// Home Module
import HomeModule from "./HomeModule";

// Choropleth
import ChoroplethControls from "./ChoroplethControls";
import CantonModeShareTable from "./CantonModeShareTable"; 

// Matsim Network
import NetworkModule from "./matsim/NetworkModule";
import VolumesModule from "./matsim/VolumesModule";

// Transit
import TransitModule from "./transit/TransitModule";
import TransitVolumesModule from "./transit/TransitVolumesModule";

// Use uploaded data
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

const Sidebar = ({
  // Map Data
  dataURL, setDataURL,
  
  // Sidebar UI
  isOpen, toggleSidebar, onExpandGraph, resetMapView,
  
  // Map State
  canton,
  
  // Choropleth Module
  updateMapChoropleth,
  
  // Network/Volumes Module
  selectedNetworkModes, setSelectedNetworkModes, selectedNetworkFeature, visualizeLinkId,
  setVisualizeLinkId, showMajorRoadsOnly, setShowMajorRoadsOnly, 
  
  // Transit Module
  selectedTransitModes, setSelectedTransitModes, selectedTransitStop, highlightedLineId, 
  setHighlightedLineId, setHighlightedRouteIds, setHoveredRouteId, showStopVolumeSymbology,
  setShowStopVolumeSymbology,
  
  // Transit Link Volumes Module
  selectedTransitLink, setShowLineSymbology, showLineSymbology,
  
  // Destination data
  setDestinationData,
  
  // Time Range Slider
  timeRange, setTimeRange,
  
  // Plot Aggregation Column
  selectedAggCol, setSelectedAggCol,
  
  // Reset Map State
  setResetMapTrigger
}) => {
  
  // ======================= INITIALIZE VARIABLES =======================
  
  const [selectedGraph, setSelectedGraph] = useState(null); // Current module
  const [selectedMode, setSelectedMode] = useState("None"); // Choropleth mode
  const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // Choropleth dataset
  const [availableModes, setAvailableModes] = useState([]); // Available modes for network filter
  const [modesByCanton, setModesByCanton] = useState({}); // For mode filter (only show modes available in each canton)
  const [inputURL, setInputURL] = useState("");
  
  // Add state for destination outflow data
  const [destinationOutflowData, setDestinationOutflowData] = useState(null);
  
  // Transit module
  const [availableTransitModes, setAvailableTransitModes] = useState([]);
  const [transitModesByCanton, setTransitModesByCanton] = useState({});
  
  // Data upload
  const { handleFolderUpload, fileMap, clearFileMap } = useFileContext();
  const loadWithFallback = useLoadWithFallback(dataURL);
  const fileInputRef = useRef();
  
  // ======================= GENERAL FEATURES (BUTTONS / DROPDOWN) =======================
  
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
    setResetMapTrigger(prev => !prev); // trigger reset in map hooks
    
    setSelectedDataset("Microcensus");
    setSelectedMode("None");
    setSelectedNetworkModes(["all"]);
    setSelectedTransitModes(["all"]);
    updateMapChoropleth("None", selectedDataset);
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
  
  // Get modes per canton from JSON file
  useEffect(() => {
    loadWithFallback("modes_by_canton.json")
    .then(data => setModesByCanton(data))
    .catch(err => console.error("Failed to load modes_by_canton.json", err));
  }, [dataURL]);
  
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
  
  // Get transit modes per stops (keep in sidebar to load only once)
  useEffect(() => {
    loadWithFallback("matsim/transit/transit_modes_by_canton.json")
    .then(data => setTransitModesByCanton(data))
    .catch(err => console.error("Failed to load transit modes:", err));
  }, [dataURL]);
  
  // Get available transit modes per canton
  useEffect(() => {
    if (canton && transitModesByCanton[canton]) {
      setAvailableTransitModes(transitModesByCanton[canton]);
    } else {
      setAvailableTransitModes([]);
    }
  }, [canton]);
  
  // ======================== DESTINATION MODULE =======================
  
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
  
  
  // ======================== SIDEBAR ITEMS =======================
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
          <option value="TransitVolumes">Transit Link Volumes</option>
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
            <HomeModule
            inputURL={inputURL}
            setInputURL={setInputURL}
            setDataURL={setDataURL}
            selectedAggCol={selectedAggCol}
            setSelectedAggCol={setSelectedAggCol}
            fileMap={fileMap}
            fileInputRef={fileInputRef}
            handleFolderUpload={handleFolderUpload}
            />
          )}
          
          {/* Rendering for graphs */}
          {selectedGraph === "Graph 1" && <div className="plot-container"><AverageDist canton={canton || "All"} aggCol={selectedAggCol}/></div>}
          {selectedGraph === "Graph 2" && <div className="plot-container"><Histogram canton={canton || "All"} aggCol={selectedAggCol}/></div>}
          {selectedGraph === "Graph 3" && <div className="plot-container"><StackedBarPlot canton={canton || "All"} aggCol={selectedAggCol}/></div>}
          {selectedGraph === "Graph 4" && <div className="plot-container"><ModeShareLinePlot canton={canton || "All"} aggCol={selectedAggCol}/></div>}
          {selectedGraph === "Graph 5" && <div className="plot-container"><ActivityDist canton={canton || "All"}/></div>}
          {selectedGraph === "Graph 6" && <div className="plot-container"><PtSubscription canton={canton || "All"}/></div>}
          {selectedGraph === "Graph 7" && <div className="plot-container"><CarAvailability canton={canton || "All"}/></div>}
          {selectedGraph === "Graph 8" && <div className="plot-container"><DepartureTimes canton={canton || "All"}/></div>}
          {selectedGraph === "Graph 9" && <div className="plot-container"><Demographics canton={canton || "All"}/></div>}
          
          {/* Mode Share Choropleth Selection */}
          {selectedGraph === "Choropleth" && (
            <div>
            <ChoroplethControls
            selectedMode={selectedMode}
            setSelectedMode={setSelectedMode}
            selectedDataset={selectedDataset}
            setSelectedDataset={setSelectedDataset}
            updateMapChoropleth={updateMapChoropleth}
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
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            onTotalOutflowChange={handleTotalOutflowChange}
            />
            </div>
          )}
          
          {/* Network Module */}
          {selectedGraph === "Network" && (
            <NetworkModule
            selectedNetworkModes={selectedNetworkModes}
            availableModes={availableModes}
            selectedNetworkFeature={selectedNetworkFeature}
            handleModeChange={handleModeChange}
            />
          )}
          
          {/* Road Volume Module */}
          {selectedGraph === "Volumes" && (
            <VolumesModule
            selectedNetworkFeature={selectedNetworkFeature}
            selectedGraph={selectedGraph}
            visualizeLinkId={visualizeLinkId}
            setVisualizeLinkId={setVisualizeLinkId}
            canton={canton}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            showMajorRoadsOnly={showMajorRoadsOnly}
            setShowMajorRoadsOnly={setShowMajorRoadsOnly}
            />
          )}
          
          {/* Transit Module */}
          {selectedGraph === "Transit" && (
            <TransitModule
            selectedTransitModes={selectedTransitModes}
            setSelectedTransitModes={setSelectedTransitModes}
            availableTransitModes={availableTransitModes}
            selectedTransitStop={selectedTransitStop}
            highlightedLineId={highlightedLineId}
            setHighlightedLineId={setHighlightedLineId}
            setHighlightedRouteIds={setHighlightedRouteIds}
            setHoveredRouteId={setHoveredRouteId}
            showStopVolumeSymbology={showStopVolumeSymbology}
            setShowStopVolumeSymbology={setShowStopVolumeSymbology}
            canton={canton}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            />
          )}
          
          {selectedGraph === "TransitVolumes" && (
            <TransitVolumesModule
            selectedTransitModes={selectedTransitModes}
            setSelectedTransitModes={setSelectedTransitModes}
            selectedTransitLink={selectedTransitLink}
            selectedGraph={selectedGraph}
            canton={canton}
            timeRange={timeRange}
            setTimeRange={setTimeRange}
            availableTransitModes={availableTransitModes}
            showLineSymbology={showLineSymbology}
            setShowLineSymbology={setShowLineSymbology}
            />
          )}
          
          </div>
        )}
        </div>
      );
    };
    
    export default Sidebar;
    