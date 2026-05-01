import React, { useState, useRef } from "react";
import "./RightSidebar.css";
import { useModule } from "../../context/ModuleContext";
import { useMap } from "../../context/MapContext";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useChoropleth } from "../../context/ChoroplethContext";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTableList, faFileCsv, faXmark, faChevronLeft, faRotateLeft, faDrawPolygon } from "@fortawesome/free-solid-svg-icons";

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

// Node Flows (turning-movement matrix)
import NodeFlowsModule from "../matsim/NodeFlowsModule";

// Link Speeds
import LinkSpeedsModule from "../matsim/LinkSpeedsModule";

// Zone Flows
import ZoneFlowsModule from "../matsim/ZoneFlowsModule";

// Reset helpers for the spider/turning-movement overlays
import { resetNodeFlowsOverlay } from "../map/useNodeFlowLayers";
import { resetVolumeFlowOverlay } from "../map/useVolumeFlowLayers";

// Module labels for the header
const MODULE_LABELS = {
  Choropleth: "Choropleth",
  Network: "MATSim Network",
  Volumes: "Road Volumes",
  Transit: "Transit Stops",
  TransitVolumes: "Transit Volumes",
  Destination: "Destination Zones",
  PtBoardings: "PT Boardings",
  VolumeFlow: "Volume Flow",
  NodeFlows: "Node Flows",
  LinkSpeeds: "Link Speeds",
  ZoneFlows: "Zone Flows",
};

const TABLE_MODULES = new Set(["Network", "Volumes", "Transit", "TransitVolumes", "VolumeFlow", "LinkSpeeds"]);
const POLYGON_MODULES = new Set(["Transit", "Volumes", "TransitVolumes", "LinkSpeeds"]);

const RightSidebar = () => {
  const { isGraphExpanded } = useModule();
  const { isSidebarOpen, setIsSidebarOpen, mapRef, drawRef } = useMap();
  const {
    isFeatureTableOpen, setIsFeatureTableOpen, setTableFilterQuery,
    nodeFlowsData, setNodeFlowsData,
    setDestinationData, setBoardingData,
  } = useData();
  const { timeRange, setTimeRange } = useFilters();
  const { clickedCanton: canton, selectedTransitStop, setVolumeFlowSegment } = useSelection();
  const {
    updateMapChoropleth,
    aggCol: selectedAggCol,
    setAggCol: setSelectedAggCol,
  } = useChoropleth();

  const [selectedMode, setSelectedMode] = useState("None"); // Choropleth mode
  const [selectedDataset, setSelectedDataset] = useState("Microcensus"); // Choropleth dataset
  const [destinationOutflowData, setDestinationOutflowData] = useState(null);

  const featureTableRef = useRef(null);
  const transitFeatureTableRef = useRef(null);

  const handleTotalOutflowChange = (outflowData) => {
    setDestinationOutflowData(outflowData);
    setDestinationData?.(outflowData);
  };

  const handleTotalBoardingsChange = (boardingData) => {
    setBoardingData?.(boardingData);
  };

  // Does this module have a feature table?
  const hasTable = TABLE_MODULES.has(isGraphExpanded);

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
          <span className="right-sidebar-title">{MODULE_LABELS[isGraphExpanded]}</span>
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

              {POLYGON_MODULES.has(isGraphExpanded) && (
                <>
                  <button
                    className="panel-toolbar-btn"
                    onClick={() => drawRef.current?.changeMode("draw_polygon")}
                  >
                    <FontAwesomeIcon icon={faDrawPolygon} />
                    <span>New Polygon</span>
                  </button>
                  <button
                    className="panel-toolbar-btn"
                    onClick={() => {
                      drawRef.current?.deleteAll();
                      mapRef.current?.fire('draw.delete', { features: [] });
                    }}
                  >
                    <FontAwesomeIcon icon={faRotateLeft} />
                    <span>Clear All</span>
                  </button>
                </>
              )}

              {!isFeatureTableOpen && isGraphExpanded === "NodeFlows" && nodeFlowsData && (
                <button
                  className="panel-toolbar-btn"
                  onClick={() => {
                    setNodeFlowsData(null);
                    resetNodeFlowsOverlay(mapRef?.current);
                  }}
                >
                  <FontAwesomeIcon icon={faRotateLeft} />
                  <span>Reset Node</span>
                </button>
              )}

              {!isFeatureTableOpen && isGraphExpanded === "VolumeFlow" && (
                <button
                  className="panel-toolbar-btn"
                  onClick={() => {
                    setVolumeFlowSegment(null);
                    resetVolumeFlowOverlay(mapRef?.current);
                  }}
                >
                  <FontAwesomeIcon icon={faRotateLeft} />
                  <span>Reset Link</span>
                </button>
              )}
            </div>
          )}

          {/* Scrollable content */}
          <div className="right-sidebar-content">
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

            {isGraphExpanded === "PtBoardings" && (
              <div className="plot-container">
                <PtBoardings
                  canton={canton}
                  timeRange={timeRange}
                  setTimeRange={setTimeRange}
                  onTotalBoardingsChange={handleTotalBoardingsChange}
                  selectedTransitStop={selectedTransitStop}
                />
              </div>
            )}

            {isGraphExpanded === "VolumeFlow" && (
              <VolumeFlowModule
                featureTableRef={featureTableRef}
              />
            )}

            {isGraphExpanded === "NodeFlows" && <NodeFlowsModule />}

            {isGraphExpanded === "LinkSpeeds" && (
              <LinkSpeedsModule
                featureTableRef={featureTableRef}
              />
            )}

            {isGraphExpanded === "ZoneFlows" && <ZoneFlowsModule />}

            {isGraphExpanded === "Network" && (
              <NetworkModule featureTableRef={featureTableRef} />
            )}

            {isGraphExpanded === "Volumes" && (
              <VolumesModule featureTableRef={featureTableRef} />
            )}

            {isGraphExpanded === "Transit" && (
              <TransitModule featureTableRef={featureTableRef} />
            )}

            {isGraphExpanded === "TransitVolumes" && (
              <TransitVolumesModule transitFeatureTableRef={transitFeatureTableRef} />
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
