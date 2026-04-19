import { createContext, useState, useRef, useCallback, useContext } from "react";

const AppContext = createContext();

export const AppProvider = ({ children }) => {
  const [datasetId, setDatasetId] = useState(1);
  const [dataURL, setDataURL] = useState("https://matsim-eth.github.io/webmap/data/");

  const [clickedCanton, setClickedCanton] = useState(null); // Store clicked canton

  const [isSidebarOpen, setIsSidebarOpen] = useState(true); // Tracks if the sidebar is open or collapsed (hidden)
  const [isGraphExpanded, setIsGraphExpanded] = useState(false); // Tracks the current module on the Sidebar
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(false); // Tracks left sidebar collapse state

  // CantonList for search
  const [cantonList, setCantonList] = useState([]);

  // Choropleth Symbology
  const [aggCol, setAggCol] = useState("mode");
  const [selectedMode, setSelectedMode] = useState("None"); // by default, show no mode (transparent purple background)
  const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // by default, show Microcensus

  // Intialize reference to store Mapbox instance
  const mapRef = useRef(null);

  // Reference to MapboxDraw instance (set by useDrawTools)
  const drawRef = useRef(null);

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
  // Volume Flow direction: 'bothflow' | 'inflow' | 'outflow'
  const [volumeFlowDirection, setVolumeFlowDirection] = useState('bothflow');
  // Transit line direction filter: 'total' | 'outbound' | 'return'
  const [selectedDirection, setSelectedDirection] = useState('total');
  // Volume Flow selected link: null = aggregated (all), string = specific link ID
  const [volumeFlowSelectedLink, setVolumeFlowSelectedLink] = useState(null);

  // Node Flows (turning-movement matrix)
  const [nodeFlowsData, setNodeFlowsData] = useState(null);
  // Hovered matrix cell { from, to } — shared between sidebar and map for highlight/ant effect
  const [hoveredMatrixCell, setHoveredMatrixCell] = useState(null);

  // Link Speeds module
  const [linkSpeedsMetric, setLinkSpeedsMetric] = useState('congestion_index'); // 'congestion_index' | 'avg_speed' | 'freespeed'
  const [linkSpeedsSelected, setLinkSpeedsSelected] = useState(null); // clicked link details
  const [linkSpeedsSummary, setLinkSpeedsSummary] = useState(null); // aggregated summary for canton
  const [linkSpeedsRoadTypes, setLinkSpeedsRoadTypes] = useState(['all']); // road type filter

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

  const getModuleGroup = (module) => {
    if (module === 'Network' || module === 'Volumes' || module === 'VolumeFlow' || module === 'NodeFlows' || module === 'LinkSpeeds') return 'network';
    if (module === 'TransitVolumes') return 'transitVolumes';
    if (module === 'Transit') return 'transit';
    return null;
  };

  // Wrap setIsGraphExpanded to clear selection on group change (was a useEffect)
  const setIsGraphExpandedWithClear = (nextModule) => {
    const currentGroup = getModuleGroup(previousModule.current);
    const nextGroup = getModuleGroup(nextModule);

    if (nextGroup !== currentGroup && currentGroup !== null) {
      setFeatureSelection(null);
    }

    previousModule.current = nextModule;
    setIsGraphExpanded(nextModule);
  };

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
    setSelectedDirection('total'); // Reset direction filter
    setNodeFlowsData(null); // Reset node flows
    setHoveredMatrixCell(null); // Reset hovered cell
  };

  const value = {
    datasetId, setDatasetId,
    dataURL, setDataURL,
    clickedCanton, setClickedCanton,
    isSidebarOpen, setIsSidebarOpen,
    isGraphExpanded, setIsGraphExpanded: setIsGraphExpandedWithClear,
    isLeftSidebarCollapsed, setIsLeftSidebarCollapsed,
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
    volumeFlowSegment, setVolumeFlowSegment,
    volumeFlowDirection, setVolumeFlowDirection,
    volumeFlowSelectedLink, setVolumeFlowSelectedLink,
    drawRef,
    selectedDirection, setSelectedDirection,
    nodeFlowsData, setNodeFlowsData,
    hoveredMatrixCell, setHoveredMatrixCell,
    linkSpeedsMetric, setLinkSpeedsMetric,
    linkSpeedsSelected, setLinkSpeedsSelected,
    linkSpeedsSummary, setLinkSpeedsSummary,
    linkSpeedsRoadTypes, setLinkSpeedsRoadTypes,
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
