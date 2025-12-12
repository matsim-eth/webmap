import { createContext, useState, useEffect, useRef, useContext } from "react";

const AppContext = createContext();

export const AppProvider = ({ children }) => {
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
  // Pass network/transit geojson to FeatureTable (used for both Network/Volumes and Transit/TransitVolumes modules)
  const [featureGeoJSON, setFeatureGeoJSON] = useState(null);
  // Pass table query to filter features on map (used for both modules)
  const [tableFilterQuery, setTableFilterQuery] = useState(null);


  // Matsim network modes (MatSIM network module)
  const [selectedNetworkModes, setSelectedNetworkModes] = useState(["all"]);

  // Save selected network segment properties
  const [selectedNetworkFeature, setSelectedNetworkFeature] = useState(null);
  // Save focus/zoom selection for map (used for both Network/Volumes and Transit/TransitVolumes modules)
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
  // Volume Flow Analysis - selected segment
  const [volumeFlowSegment, setVolumeFlowSegment] = useState(null);

  // Pass selected mode/dataset from sidebar to map
  const updateMapChoropleth = (mode, dataset) => {
    setSelectedMode(mode);
    setSelectedDataset(dataset);
  };
  // Handle map reset if button clicked in sidebar
  const [resetMapTrigger, setResetMapTrigger] = useState(false);
  // Set label size for network segments
  const [labelSize, setLabelSize] = useState(11);

  // Clear feature selection when switching between module groups
  // Groups: Network/Volumes (share highlights), TransitVolumes (separate), Transit (separate)
  const previousModule = useRef(null);
  useEffect(() => {
    const getModuleGroup = (module) => {
      if (module === 'Network' || module === 'Volumes') return 'network';
      if (module === 'TransitVolumes') return 'transitVolumes';
      if (module === 'Transit') return 'transit';
      return null;
    };

    const currentGroup = getModuleGroup(isGraphExpanded);
    const previousGroup = getModuleGroup(previousModule.current);

    // Only clear if switching between different module groups
    // Keep selection when switching between Network and Volumes only
    if (currentGroup !== previousGroup && previousGroup !== null) {
      setFeatureSelection(null);
    }

    previousModule.current = isGraphExpanded;
  }, [isGraphExpanded]);

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

  const value = {
    dataURL, setDataURL,
    clickedCanton, setClickedCanton,
    isSidebarOpen, setIsSidebarOpen,
    isGraphExpanded, setIsGraphExpanded,
    cantonList, setCantonList,
    aggCol, setAggCol,
    selectedMode, setSelectedMode,
    selectedDataset, setSelectedDataset,
    mapRef,
    isFeatureTableOpen, setIsFeatureTableOpen,
    featureGeoJSON, setFeatureGeoJSON,
    tableFilterQuery, setTableFilterQuery,
    selectedNetworkModes, setSelectedNetworkModes,
    selectedNetworkFeature, setSelectedNetworkFeature,
    featureSelection, setFeatureSelection,
    selectedTransitLink, setSelectedTransitLink,
    showLineSymbology, setShowLineSymbology,
    visualizeLinkId, setVisualizeLinkId,
    selectedTransitModes, setSelectedTransitModes,
    selectedTransitStop, setSelectedTransitStop,
    highlightedLineId, setHighlightedLineId,
    highlightedRouteIds, setHighlightedRouteIds,
    hoveredRouteId, setHoveredRouteId,
    showStopVolumeSymbology, setShowStopVolumeSymbology,
    showMajorRoadsOnly, setShowMajorRoadsOnly,
    timeRange, setTimeRange,
    destinationData, setDestinationData,
    boardingData, setBoardingData,
    updateMapChoropleth,
    resetMapTrigger, setResetMapTrigger,
    labelSize, setLabelSize,
    resetMapView,
    volumeFlowSegment, setVolumeFlowSegment
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within an AppProvider");
  }
  return context;
};
