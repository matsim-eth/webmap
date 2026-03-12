import React, { useState, useEffect, useRef } from "react";
import "./Sidebar.css";
import { useFileContext } from "../FileContext";
import { useApp } from "../context/AppContext";
import SidebarControls from "./sidebar/SidebarControls";

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
import PtBoardings from "./plots/PtBoardings";

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

// Volume Flow Analysis
import VolumeFlowModule from "./matsim/VolumeFlowModule";

// Use uploaded data
import { useLoadWithFallback } from "../utils/useLoadWithFallback";

const Sidebar = () => {
  const {
    dataURL, setDataURL,
    activeDatasetId, setActiveDatasetId,
    isSidebarOpen, setIsSidebarOpen,
    isGraphExpanded, setIsGraphExpanded,
    resetMapView,
    isFeatureTableOpen, setIsFeatureTableOpen, setTableFilterQuery,
    featureGeoJSON,
    clickedCanton: canton, // Alias to match existing code
    updateMapChoropleth,
    selectedNetworkModes, setSelectedNetworkModes,
    selectedNetworkFeature, setSelectedNetworkFeature,
    visualizeLinkId, setVisualizeLinkId,
    showMajorRoadsOnly, setShowMajorRoadsOnly,
    setFeatureSelection, // Was onFocusNetworkFeature & onFocusTransitFeature
    selectedTransitModes, setSelectedTransitModes,
    selectedTransitStop, setSelectedTransitStop,
    highlightedLineId, setHighlightedLineId,
    setHighlightedRouteIds, setHoveredRouteId,
    showStopVolumeSymbology, setShowStopVolumeSymbology,
    selectedTransitLink, setSelectedTransitLink,
    setShowLineSymbology, showLineSymbology,
    setDestinationData,
    setBoardingData,
    timeRange, setTimeRange,
    aggCol: selectedAggCol, // Alias
    setAggCol: setSelectedAggCol, // Alias
    setResetMapTrigger,
    labelSize, setLabelSize
  } = useApp();

  // Alias for functions that were passed as props with different names
  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);
  const onExpandGraph = setIsGraphExpanded;
  const onFocusNetworkFeature = setFeatureSelection;
  const onFocusTransitFeature = setFeatureSelection;

  // ======================= INITIALIZE VARIABLES =======================
  // selectedGraph is now isGraphExpanded from AppContext
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
  const featureTableRef = useRef(null);
  const transitFeatureTableRef = useRef(null);

  // ======================= MATSIM NETWORK MODULE =======================
  useEffect(() => {
    loadWithFallback("modes_by_canton.json")
      .then((data) => setModesByCanton(data))
      .catch((err) => console.error("Failed to load modes_by_canton.json", err));
  }, [dataURL, fileMap]);

  useEffect(() => {
    if (canton && modesByCanton[canton]) {
      setAvailableModes(
        modesByCanton[canton].filter((mode) => !["car_passenger", "truck", "rail", "other", "pt", "taxi"].includes(mode))
      );
    } else {
      setAvailableModes([]);
    }
  }, [canton, modesByCanton]);

  const handleModeChange = (event) => {
    const selectedOptions = Array.from(event.target.selectedOptions).map((option) => option.value);
    if (selectedOptions.includes("all") || selectedOptions.length === 0) {
      setSelectedNetworkModes(["all"]);
    } else {
      setSelectedNetworkModes(selectedOptions);
    }
  };

  // ======================== TRANSIT MODULE =======================
  useEffect(() => {
    loadWithFallback("matsim/transit/transit_modes_by_canton.json")
      .then((data) => setTransitModesByCanton(data))
      .catch((err) => console.error("Failed to load transit modes:", err));
  }, [dataURL, fileMap]);

  useEffect(() => {
    if (canton && transitModesByCanton[canton]) {
      setAvailableTransitModes(transitModesByCanton[canton]);
    } else {
      setAvailableTransitModes([]);
    }
  }, [canton, transitModesByCanton]);

  // ======================== DESTINATION MODULE =======================
  const handleTotalOutflowChange = (outflowData) => {
    setDestinationOutflowData(outflowData);
    if (setDestinationData) {
      console.log("Sidebar - calling setDestinationData with:", outflowData);
      setDestinationData(outflowData);
    } else {
      console.log("Sidebar - setDestinationData is not available");
    }
  };

  // Handle boarding data from PtBoardings
  const handleTotalBoardingsChange = (boardingData) => {
    console.log('Sidebar - boarding data updated:', boardingData);

    // Log detailed information about selected line if available
    if (boardingData.selectedLineInfo) {
      console.log('Sidebar - selected line details:', {
        lineId: boardingData.selectedLineInfo.line_id,
        lineName: boardingData.selectedLineInfo.line_name,
        vehicle: boardingData.selectedLineInfo.vehicle,
        cantons: boardingData.selectedLineInfo.cantons,
        routeIds: boardingData.selectedLineInfo.route_ids
      });
    }

    // Pass to App component via setBoardingData prop
    if (setBoardingData) {
      console.log('Sidebar - calling setBoardingData with:', boardingData);
      setBoardingData(boardingData);
    } else {
      console.log('Sidebar - setBoardingData is not available');
    }
  };


  // ======================= SIDEBAR ITEMS =======================
  return (
    <div
      className={`floating-panel ${isSidebarOpen
        ? isGraphExpanded === "Graph 3" || isGraphExpanded === "Graph 4"
          ? "expanded-graph3"
          : isGraphExpanded === "Choropleth" || isGraphExpanded === "Network"
            ? "open"
            : isGraphExpanded
              ? "expanded"
              : "open"
        : "collapsed"
        } ${isFeatureTableOpen ? "feature-table-open" : ""}`}
    >
      <button className="toggle-button" onClick={toggleSidebar}>
        {isSidebarOpen ? "✕" : "☰"}
      </button>

      {isSidebarOpen && (
        <>
          {/* Scroll area */}
          <div className="floating-content">
            <br />

            <SidebarControls setInputURL={setInputURL} />

            {/* Default View */}
            {!isGraphExpanded && (
              <HomeModule
                inputURL={inputURL}
                setInputURL={setInputURL}
                setDataURL={setDataURL}
                activeDatasetId={activeDatasetId}
                setActiveDatasetId={setActiveDatasetId}
                selectedAggCol={selectedAggCol}
                setSelectedAggCol={setSelectedAggCol}
                fileMap={fileMap}
                fileInputRef={fileInputRef}
                handleFolderUpload={handleFolderUpload}
              />
            )}

            {/* Rendering for graphs */}
            {isGraphExpanded === "Graph 1" && (
              <div className="plot-container">
                <AverageDist canton={canton || "All"} aggCol={selectedAggCol} />
              </div>
            )}
            {isGraphExpanded === "Graph 2" && (
              <div className="plot-container">
                <Histogram canton={canton || "All"} aggCol={selectedAggCol} />
              </div>
            )}
            {isGraphExpanded === "Graph 3" && (
              <div className="plot-container">
                <StackedBarPlot canton={canton || "All"} aggCol={selectedAggCol} />
              </div>
            )}
            {isGraphExpanded === "Graph 4" && (
              <div className="plot-container">
                <ModeShareLinePlot canton={canton || "All"} aggCol={selectedAggCol} />
              </div>
            )}
            {isGraphExpanded === "Graph 5" && (
              <div className="plot-container">
                <ActivityDist canton={canton || "All"} />
              </div>
            )}
            {isGraphExpanded === "Graph 6" && (
              <div className="plot-container">
                <PtSubscription canton={canton || "All"} />
              </div>
            )}
            {isGraphExpanded === "Graph 7" && (
              <div className="plot-container">
                <CarAvailability canton={canton || "All"} />
              </div>
            )}
            {isGraphExpanded === "Graph 8" && (
              <div className="plot-container">
                <DepartureTimes canton={canton || "All"} />
              </div>
            )}
            {isGraphExpanded === "Graph 9" && (
              <div className="plot-container">
                <Demographics canton={canton || "All"} />
              </div>
            )}

            {/* Mode Share Choropleth Selection */}
            {isGraphExpanded === "Choropleth" && (
              <div>
                <ChoroplethControls
                  selectedMode={selectedMode}
                  setSelectedMode={setSelectedMode}
                  selectedDataset={selectedDataset}
                  setSelectedDataset={setSelectedDataset}
                  updateMapChoropleth={updateMapChoropleth}
                  aggCol={selectedAggCol}
                />
                <CantonModeShareTable
                  canton={canton}
                  selectedDataset={selectedDataset}
                  selectedMode={selectedMode}
                  aggCol={selectedAggCol}
                />
              </div>
            )}

            {/* Destination Module */}
            {isGraphExpanded === "Destination" && (
              <div className="plot-container">
                <DestinationZones
                  canton={canton}
                  timeRange={timeRange}
                  setTimeRange={setTimeRange}
                  onTotalOutflowChange={handleTotalOutflowChange}
                />
              </div>
            )}

            {/* PT Boardings Module */}
            {isGraphExpanded === "PtBoardings" && (
              <div className="plot-container">
                <PtBoardings
                  canton={canton}
                  timeRange={timeRange}
                  setTimeRange={setTimeRange}
                  onTotalBoardingsChange={handleTotalBoardingsChange}
                  selectedTransitStop={selectedTransitStop}
                  loadWithFallback={loadWithFallback}
                />
              </div>
            )}

            {/* Volume Flow Analysis Module */}
            {isGraphExpanded === "VolumeFlow" && (
              <div className="plot-container">
                <VolumeFlowModule />
              </div>
            )}

            {/* Network Module */}
            {isGraphExpanded === "Network" && (
              <>
                {/* Buttons ABOVE the module */}
                {canton && (
                  <div className="network-buttons-row">
                    <button
                      className="search-button"
                      onClick={() =>
                        setIsFeatureTableOpen((prev) => !prev)}
                    >
                      {isFeatureTableOpen ? "Hide Table" : "Show Table"}
                    </button>

                    {isFeatureTableOpen && (
                      <button
                        className="search-button secondary"
                        onClick={() => {
                          const exported = featureTableRef.current?.exportCsv?.();
                          if (!exported) {
                            console.warn('Export skipped: no table data available.');
                          }
                        }}
                      >
                        Export Data
                      </button>
                    )}
                  </div>
                )}

                <NetworkModule
                  canton={canton}
                  selectedGraph={isGraphExpanded}
                  selectedNetworkModes={selectedNetworkModes}
                  availableModes={availableModes}
                  selectedNetworkFeature={selectedNetworkFeature}
                  setSelectedNetworkFeature={setSelectedNetworkFeature}
                  handleModeChange={handleModeChange}
                  isFeatureTableOpen={isFeatureTableOpen}
                  featureGeoJSON={featureGeoJSON}
                  onFocusNetworkFeature={onFocusNetworkFeature}
                  featureTableRef={featureTableRef}
                  setTableFilterQuery={setTableFilterQuery}
                />
              </>
            )}

            {/* Road Volume Module */}
            {isGraphExpanded === "Volumes" && (
              <>
                {/* Buttons ABOVE the module */}
                {canton && (
                  <div className="network-buttons-row">
                    <button
                      className="search-button"
                      onClick={() =>
                        setIsFeatureTableOpen((prev) => !prev)}
                    >
                      {isFeatureTableOpen ? "Hide Table" : "Show Table"}
                    </button>

                    {isFeatureTableOpen && (
                      <button
                        className="search-button secondary"
                        onClick={() => {
                          const exported = featureTableRef.current?.exportCsv?.();
                          if (!exported) {
                            console.warn('Export skipped: no table data available.');
                          }
                        }}
                      >
                        Export Data
                      </button>
                    )}
                  </div>
                )}

                <VolumesModule
                  selectedNetworkFeature={selectedNetworkFeature}
                  setSelectedNetworkFeature={setSelectedNetworkFeature}
                  selectedGraph={isGraphExpanded}
                  visualizeLinkId={visualizeLinkId}
                  setVisualizeLinkId={setVisualizeLinkId}
                  canton={canton}
                  timeRange={timeRange}
                  setTimeRange={setTimeRange}
                  showMajorRoadsOnly={showMajorRoadsOnly}
                  setShowMajorRoadsOnly={setShowMajorRoadsOnly}
                  labelSize={labelSize}
                  setLabelSize={setLabelSize}
                  isFeatureTableOpen={isFeatureTableOpen}
                  featureGeoJSON={featureGeoJSON}
                  onFocusNetworkFeature={onFocusNetworkFeature}
                  featureTableRef={featureTableRef}
                  setTableFilterQuery={setTableFilterQuery}
                  selectedNetworkModes={selectedNetworkModes}
                />
              </>
            )}

            {/* Transit Module */}
            {isGraphExpanded === "Transit" && (
              <>
                {/* Buttons for table */}
                {canton && (
                  <div className="network-buttons-row">
                    <button
                      className="search-button"
                      onClick={() =>
                        setIsFeatureTableOpen((prev) => !prev)}
                    >
                      {isFeatureTableOpen ? "Hide Table" : "Show Table"}
                    </button>

                    {isFeatureTableOpen && (
                      <button
                        className="search-button secondary"
                        onClick={() => {
                          if (featureTableRef.current?.exportCsv) {
                            featureTableRef.current.exportCsv();
                          }
                        }}
                      >
                        Export Data
                      </button>
                    )}
                  </div>
                )}

                <TransitModule
                  selectedTransitModes={selectedTransitModes}
                  setSelectedTransitModes={setSelectedTransitModes}
                  availableTransitModes={availableTransitModes}
                  selectedTransitStop={selectedTransitStop}
                  setSelectedTransitStop={setSelectedTransitStop}
                  highlightedLineId={highlightedLineId}
                  setHighlightedLineId={setHighlightedLineId}
                  setHighlightedRouteIds={setHighlightedRouteIds}
                  setHoveredRouteId={setHoveredRouteId}
                  showStopVolumeSymbology={showStopVolumeSymbology}
                  setShowStopVolumeSymbology={setShowStopVolumeSymbology}
                  canton={canton}
                  timeRange={timeRange}
                  setTimeRange={setTimeRange}
                  isFeatureTableOpen={isFeatureTableOpen}
                  featureGeoJSON={featureGeoJSON}
                  featureTableRef={featureTableRef}
                  setTableFilterQuery={setTableFilterQuery}
                  onFocusTransitFeature={onFocusTransitFeature}
                />
              </>
            )}

            {isGraphExpanded === "TransitVolumes" && (
              <>
                {/* Buttons ABOVE the module */}
                {canton && (
                  <div className="network-buttons-row">
                    <button
                      className="search-button"
                      onClick={() =>
                        setIsFeatureTableOpen((prev) => !prev)}
                    >
                      {isFeatureTableOpen ? "Hide Table" : "Show Table"}
                    </button>

                    {isFeatureTableOpen && (
                      <button
                        className="search-button secondary"
                        onClick={() => {
                          const exported = transitFeatureTableRef.current?.exportCsv?.();
                          if (!exported) {
                            console.warn('Export skipped: no table data available.');
                          }
                        }}
                      >
                        Export Data
                      </button>
                    )}
                  </div>
                )}

                <TransitVolumesModule
                  selectedTransitModes={selectedTransitModes}
                  setSelectedTransitModes={setSelectedTransitModes}
                  selectedTransitLink={selectedTransitLink}
                  selectedGraph={isGraphExpanded}
                  canton={canton}
                  timeRange={timeRange}
                  setTimeRange={setTimeRange}
                  availableTransitModes={availableTransitModes}
                  showLineSymbology={showLineSymbology}
                  setShowLineSymbology={setShowLineSymbology}
                  highlightedLineId={highlightedLineId}
                  setHighlightedLineId={setHighlightedLineId}
                  visualizeLinkId={visualizeLinkId}
                  setVisualizeLinkId={setVisualizeLinkId}
                  isFeatureTableOpen={isFeatureTableOpen}
                  featureGeoJSON={featureGeoJSON}
                  transitFeatureTableRef={transitFeatureTableRef}
                  setTableFilterQuery={setTableFilterQuery}
                  setSelectedTransitLink={setSelectedTransitLink}
                  onFocusTransitFeature={onFocusTransitFeature}
                />
              </>
            )}
          </div>

        </>
      )}
    </div>
  );
};

export default Sidebar;
