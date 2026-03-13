import React, { useState, useEffect, useRef } from "react";
import "./RightSidebar.css";
import { useFileContext } from "../../FileContext";
import { useApp } from "../../context/AppContext";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTableList, faFileCsv, faXmark, faChevronLeft, faRotateLeft } from "@fortawesome/free-solid-svg-icons";

// ======================= IMPORT MODULES / GRAPHS =======================

// Modules
import DestinationZones from "../plots/DestinationZones";
import PtBoardings from "../plots/PtBoardings";

// Choropleth
import ChoroplethControls from "../ChoroplethControls";
import CantonModeShareTable from "../CantonModeShareTable";

// Matsim Network
import NetworkModule from "../matsim/NetworkModule";
import VolumesModule from "../matsim/VolumesModule";

// Transit
import TransitModule from "../transit/TransitModule";
import TransitVolumesModule from "../transit/TransitVolumesModule";

// Volume Flow Analysis
import VolumeFlowModule from "../matsim/VolumeFlowModule";

// Use uploaded data
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const RightSidebar = () => {
  const {
    dataURL,
    isSidebarOpen, setIsSidebarOpen,
    isGraphExpanded,
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
    labelSize, setLabelSize,
    setVolumeFlowSegment,
    mapRef
  } = useApp();

  // Alias for functions that were passed as props with different names
  const onFocusNetworkFeature = setFeatureSelection;
  const onFocusTransitFeature = setFeatureSelection;

  // ======================= INITIALIZE VARIABLES =======================
  // selectedGraph is now isGraphExpanded from AppContext
  const [selectedMode, setSelectedMode] = useState("None"); // Choropleth mode
  const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // Choropleth dataset
  const [availableModes, setAvailableModes] = useState([]); // Available modes for network filter
  const [modesByCanton, setModesByCanton] = useState({}); // For mode filter (only show modes available in each canton)

  // Add state for destination outflow data
  const [destinationOutflowData, setDestinationOutflowData] = useState(null);

  // Transit module
  const [availableTransitModes, setAvailableTransitModes] = useState([]);
  const [transitModesByCanton, setTransitModesByCanton] = useState({});

  // Data loading
  const { fileMap } = useFileContext();
  const loadWithFallback = useLoadWithFallback(dataURL);
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

  // Module labels for the header
  const moduleLabels = {
    Choropleth: "Choropleth",
    Network: "MATSim Network",
    Volumes: "Road Volumes",
    Transit: "Transit Stops",
    TransitVolumes: "Transit Volumes",
    Destination: "Destination Zones",
    PtBoardings: "PT Boardings",
    VolumeFlow: "Volume Flow",
  };

  // Does this module have a feature table?
  const hasTable = ["Network", "Volumes", "Transit", "TransitVolumes", "VolumeFlow"].includes(isGraphExpanded);

  // Determine width class
  let sidebarClass = "hidden";
  if (isGraphExpanded) {
    if (!isSidebarOpen) {
      sidebarClass = "collapsed";
    } else if (isFeatureTableOpen) {
      sidebarClass = "feature-table-open";
    } else if (isGraphExpanded === "Choropleth" || isGraphExpanded === "Network") {
      sidebarClass = "open";
    } else {
      sidebarClass = "expanded";
    }
  }

  return (
    <aside className={`right-sidebar ${sidebarClass}`}>
      {isGraphExpanded && (
        <>
      {/* Header */}
      <div className="right-sidebar-header">
        {isSidebarOpen && (
          <span className="right-sidebar-title">{moduleLabels[isGraphExpanded]}</span>
        )}
        <button
          className="right-sidebar-close"
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          title={isSidebarOpen ? "Collapse" : "Expand"}
        >
          <FontAwesomeIcon icon={isSidebarOpen ? faXmark : faChevronLeft} />
        </button>
      </div>

      {isSidebarOpen && (
        <>
          {/* Toolbar — show table / export icons */}
          {hasTable && canton && (
            <div className="right-sidebar-toolbar">
              <button
                className="panel-toolbar-btn"
                onClick={() => setIsFeatureTableOpen((prev) => !prev)}
              >
                <FontAwesomeIcon icon={faTableList} />
                <span>{isFeatureTableOpen ? "Close Table" : "Open Table"}</span>
              </button>

              {/* Reset Link button — only when table is closed, only for VolumeFlow */}
              {!isFeatureTableOpen && isGraphExpanded === "VolumeFlow" && (
                <button
                  className="panel-toolbar-btn"
                  onClick={() => {
                    setVolumeFlowSegment(null);
                    // Remove spider overlay source + layers
                    const map = mapRef?.current;
                    if (map) {
                      ['volume-flow-target-label','volume-flow-labels','volume-flow-target','volume-flow-highlight'].forEach(id => {
                        if (map.getLayer(id)) map.removeLayer(id);
                      });
                      if (map.getSource('volume-flow-spider')) map.removeSource('volume-flow-spider');
                      // Restore base network opacity
                      if (map.getLayer('network-layer')) map.setPaintProperty('network-layer', 'line-opacity', 0.4);
                    }
                  }}
                >
                  <FontAwesomeIcon icon={faRotateLeft} />
                  <span>Reset Link</span>
                </button>
              )}

              {isFeatureTableOpen && (
                <button
                  className="panel-toolbar-btn"
                  onClick={() => {
                    const ref = isGraphExpanded === "TransitVolumes"
                      ? transitFeatureTableRef
                      : featureTableRef;
                    const exported = ref.current?.exportCsv?.();
                    if (!exported) {
                      console.warn("Export skipped: no table data available.");
                    }
                  }}
                >
                  <FontAwesomeIcon icon={faFileCsv} />
                  <span>Export Table</span>
                </button>
              )}
            </div>
          )}

          {/* Scrollable content */}
          <div className="right-sidebar-content">
            {/* Mode Share Choropleth */}
            {isGraphExpanded === "Choropleth" && (
              <div>
                <ChoroplethControls
                  selectedMode={selectedMode}
                  setSelectedMode={setSelectedMode}
                  selectedDataset={selectedDataset}
                  setSelectedDataset={setSelectedDataset}
                  updateMapChoropleth={updateMapChoropleth}
                  aggCol={selectedAggCol}
                  setAggCol={setSelectedAggCol}
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
              <VolumeFlowModule
                isFeatureTableOpen={isFeatureTableOpen}
                featureTableRef={featureTableRef}
                setTableFilterQuery={setTableFilterQuery}
              />
            )}

            {/* Network Module */}
            {isGraphExpanded === "Network" && (
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
            )}

            {/* Road Volume Module */}
            {isGraphExpanded === "Volumes" && (
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
            )}

            {/* Transit Module */}
            {isGraphExpanded === "Transit" && (
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
            )}

            {/* Transit Volumes Module */}
            {isGraphExpanded === "TransitVolumes" && (
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
            )}
          </div>
        </>
      )}
      </>
      )}
    </aside>
  );
};

export default RightSidebar;
