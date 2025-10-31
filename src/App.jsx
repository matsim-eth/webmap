import { useState, useEffect, useRef } from "react";
import Map from "./components/Map";
import Sidebar from "./components/Sidebar";
import CantonSearch from "./components/CantonSearch";
import "./App.css";
import NetworkLegend from "./components/NetworkLegend";
import { FileProvider } from "./FileContext";
function App() {
  
  const [dataURL, setDataURL] = useState("https://matsim-eth.github.io/webmap/data/");
  
  const [clickedCanton, setClickedCanton] = useState(null); // Store clicked canton
  
  const [isSidebarOpen, setIsSidebarOpen] = useState(true); // Tracks if the sidebar is open or collapsed (hidden)
  const [isGraphExpanded, setIsGraphExpanded] = useState(false); // Tracks the current module on the Sidebar
  
  // CantonList for search
  const [cantonList, setCantonList] = useState([]);
  
  // Choropleth Symbology
  const [aggCol, setAggCol] = useState("mode");
  const [selectedMode, setSelectedMode] = useState("None"); // by default, show no mode (transparent purple background)
  const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // by default, show Microcensus
  
  // Intialize reference to store Mapbox instance
  const mapRef = useRef(null);
  

  // ------ FEATURE TABLE --------
  // Track if table is open or not
  const [isFeatureTableOpen, setIsFeatureTableOpen] = useState(false);
  // Pass network geojson to FeatureTable
  const [featureGeoJSON, setFeatureGeoJSON] = useState(null);
  // Pass table query to filter features on map
  const [tableFilterQuery, setTableFilterQuery] = useState(null);


  // Matsim network modes (MatSIM network module)
  const [selectedNetworkModes, setSelectedNetworkModes] = useState(["all"]);
  
  // Save selected network segment properties
  const [selectedNetworkFeature, setSelectedNetworkFeature] = useState(null);
  const [featureSelection, setFeatureSelection] = useState(null);
  // Save selected link for transit volumes module
  const [selectedTransitLink, setSelectedTransitLink] = useState(null);
  // Show selected line for transit volumes module
  const [showLineSymbology, setShowLineSymbology] = useState(false);
  
  // Pass selected link id to map (for ant-path visualization)
  const [visualizeLinkId, setVisualizeLinkId] = useState(null);
  
  // Pass selected transit mode / stop to map
  const [selectedTransitModes, setSelectedTransitModes] = useState(["all"]);
  const [selectedTransitStop, setSelectedTransitStop] = useState(null);
  
  // Pass selected transit line/route to map
  const [highlightedLineId, setHighlightedLineId] = useState(null);
  const [highlightedRouteIds, setHighlightedRouteIds] = useState([]);
  const [hoveredRouteId, setHoveredRouteId] = useState(null);
  const [showStopVolumeSymbology, setShowStopVolumeSymbology] = useState(false);
  
  // Pass showing major roads toggle (volumes module)
  const [showMajorRoadsOnly, setShowMajorRoadsOnly] = useState(true);
  // time range for filtering volumes
  const [timeRange, setTimeRange] = useState([0, 96]);
  // state for destination data (from Sidebar to Map)
  const [destinationData, setDestinationData] = useState(null);
  // state for boarding data (from Sidebar to Map)
  const [boardingData, setBoardingData] = useState(null);
  
  // Pass selected mode/dataset from sidebar to map
  const updateMapChoropleth = (mode, dataset) => {
    setSelectedMode(mode);
    setSelectedDataset(dataset);
  };
  // Handle map reset if button clicked in sidebar
  const [resetMapTrigger, setResetMapTrigger] = useState(false);
  // Set label size for network segments
  const [labelSize, setLabelSize] = useState(11);
  
  // Handle map reset if button clicked in sidebar
  const resetMapView = () => {
    
    // Reset canton
    setClickedCanton(null)
    // Reset selected network, 
    setSelectedNetworkFeature(null)
    setFeatureSelection(null)
    setSelectedTransitLink(null);
    setVisualizeLinkId(null)
    // Reset current module
    setIsGraphExpanded(false);
    setTimeRange([0, 96]); // Reset time range to default
    setShowMajorRoadsOnly(true); // Reset major roads toggle
    setShowStopVolumeSymbology(false); // Reset stop volume symbology toggle
    setIsFeatureTableOpen(false); // Close feature table if open
  };
  
  return (
    <FileProvider dataURL={dataURL}>
    <CantonSearch
    map={mapRef.current}
    cantonList={cantonList} // from app
    onSearch={setClickedCanton} // to map
    />
    
    <Map 
    mapRef={mapRef} // from app
    setClickedCanton={setClickedCanton} // to sidebar
    isSidebarOpen={isSidebarOpen} // from sidebar
    isGraphExpanded={isGraphExpanded} // from sidebar
    searchCanton={clickedCanton} // from canton search
    selectedMode={selectedMode} // from sidebar
    selectedDataset={selectedDataset} // from sidebar
    selectedNetworkModes={selectedNetworkModes}  // from sidebar
    setSelectedNetworkFeature={setSelectedNetworkFeature} // to sidebar
    featureSelection={featureSelection}
    setSelectedTransitLink={setSelectedTransitLink} // to sidebar
    visualizeLinkId={visualizeLinkId} // from segment vol histogram via sidebar
    setVisualizeLinkId={setVisualizeLinkId} // from sidebar
    dataURL={dataURL} // from Sidebar
    selectedTransitModes={selectedTransitModes} // from sidebar
    setSelectedTransitStop={setSelectedTransitStop} // to sidebar
    highlightedLineId={highlightedLineId}
    setHighlightedLineId={setHighlightedLineId}
    highlightedRouteIds={highlightedRouteIds}
    setHighlightedRouteIds = {setHighlightedRouteIds}
    hoveredRouteId={hoveredRouteId}
    showStopVolumeSymbology={showStopVolumeSymbology}
    showLineSymbology = {showLineSymbology}
    showMajorRoadsOnly={showMajorRoadsOnly}
    selectedDestinationData={destinationData} // from sidebar
    selectedBoardingData={boardingData} // from sidebar
    timeRange={timeRange}
    aggCol={aggCol}
    resetMapTrigger={resetMapTrigger} // from sidebar, to reset map
    labelSize={labelSize} // from sidebar
    setFeatureGeoJSON={setFeatureGeoJSON}
    isFeatureTableOpen={isFeatureTableOpen} // from sidebar
    setIsFeatureTableOpen={setIsFeatureTableOpen}
    tableFilterQuery={tableFilterQuery}
    />
    
    <Sidebar
    canton={clickedCanton} // from map
    isOpen={isSidebarOpen} // to map
    toggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} // to map
    onExpandGraph={setIsGraphExpanded} // to map
    resetMapView={resetMapView} // to app
    updateMapChoropleth={updateMapChoropleth} // to map
    selectedAggCol={aggCol}
    setSelectedAggCol={setAggCol}
    selectedNetworkModes={selectedNetworkModes} // to map
    setSelectedNetworkModes={setSelectedNetworkModes} // to change value
    selectedNetworkFeature={selectedNetworkFeature} // from map
    setSelectedNetworkFeature={setSelectedNetworkFeature} 
    onFocusNetworkFeature={setFeatureSelection}
    selectedTransitLink={selectedTransitLink} // from map
    visualizeLinkId={visualizeLinkId} // from map
    setVisualizeLinkId={setVisualizeLinkId} // to map
    dataURL={dataURL}
    setDataURL={setDataURL}
    selectedTransitModes={selectedTransitModes}
    setSelectedTransitModes={setSelectedTransitModes} 
    selectedTransitStop={selectedTransitStop}
    highlightedLineId={highlightedLineId}
    setHighlightedLineId={setHighlightedLineId}
    setHighlightedRouteIds = {setHighlightedRouteIds}
    setHoveredRouteId={setHoveredRouteId}
    showStopVolumeSymbology={showStopVolumeSymbology}
    setShowStopVolumeSymbology={setShowStopVolumeSymbology}
    setShowLineSymbology={setShowLineSymbology}
    showLineSymbology={showLineSymbology}
    showMajorRoadsOnly={showMajorRoadsOnly}
    setShowMajorRoadsOnly={setShowMajorRoadsOnly}
    setDestinationData={setDestinationData} // to map
    setBoardingData={setBoardingData} // to map
    timeRange={timeRange}       
    setTimeRange={setTimeRange}  
    setResetMapTrigger={setResetMapTrigger} // to map
    labelSize={labelSize}
    setLabelSize={setLabelSize} // to map
    featureGeoJSON={featureGeoJSON}
    isFeatureTableOpen={isFeatureTableOpen}
    setIsFeatureTableOpen={setIsFeatureTableOpen}
    setTableFilterQuery={setTableFilterQuery} // to map
    />
    
    <NetworkLegend
    selectedGraph={isGraphExpanded} // from sidebar
    showStopVolumeSymbology={showStopVolumeSymbology}
    />
    </FileProvider>
  );
}
export default App;
