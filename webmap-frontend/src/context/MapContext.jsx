import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useSelection } from './SelectionContext';
import { useFilters } from './FilterContext';
import { useData } from './DataContext';
import { useModule } from './ModuleContext';

const MapContext = createContext(null);

/**
 * Map UI state — refs to the Mapbox map / Draw control, sidebar collapse
 * state, label sizing, and the global resetMapView() that wipes per-module
 * selection + filter state. Innermost provider so it can compose setters
 * from Selection / Filter / Data / Module to build resetMapView.
 */
export const MapProvider = ({ children }) => {
  const mapRef = useRef(null);
  const drawRef = useRef(null);

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(false);
  const [resetMapTrigger, setResetMapTrigger] = useState(false);
  const [labelSize, setLabelSize] = useState(11);
  // Generic map-area loading flag — modules toggle this when an interaction
  // (e.g. volumes time slider) triggers a map re-render the user should see
  // a spinner for. Distinct from the per-module setIsLoading flags.
  const [mapLoading, setMapLoading] = useState(false);

  const {
    setClickedCanton,
    setSelectedNetworkFeature,
    setFeatureSelection,
    setSelectedTransitLink,
    setVisualizeLinkId,
    setHoveredMatrixCell,
    setZoneFlowDestCanton,
  } = useSelection();
  const {
    setTimeRange,
    setShowMajorRoadsOnly,
    setShowStopVolumeSymbology,
    setSelectedDirection,
    setZoneFlowDirection,
  } = useFilters();
  const { setIsFeatureTableOpen, setNodeFlowsData, setZoneFlowData } = useData();
  const { setIsGraphExpanded } = useModule();

  const resetMapView = useCallback(() => {
    setClickedCanton(null);
    setSelectedNetworkFeature(null);
    setFeatureSelection(null);
    setSelectedTransitLink(null);
    setVisualizeLinkId(null);
    setIsGraphExpanded(false);
    setTimeRange([0, 96]);
    setShowMajorRoadsOnly(true);
    setShowStopVolumeSymbology(false);
    setIsFeatureTableOpen(false);
    setSelectedDirection('total');
    setNodeFlowsData(null);
    setHoveredMatrixCell(null);
    setZoneFlowDestCanton(null);
    setZoneFlowDirection('both');
    setZoneFlowData(null);
  }, [
    setClickedCanton, setSelectedNetworkFeature, setFeatureSelection,
    setSelectedTransitLink, setVisualizeLinkId, setIsGraphExpanded,
    setTimeRange, setShowMajorRoadsOnly, setShowStopVolumeSymbology,
    setIsFeatureTableOpen, setSelectedDirection, setNodeFlowsData,
    setHoveredMatrixCell, setZoneFlowDestCanton, setZoneFlowDirection,
    setZoneFlowData,
  ]);

  const value = useMemo(() => ({
    mapRef, drawRef,
    isSidebarOpen, setIsSidebarOpen,
    isLeftSidebarCollapsed, setIsLeftSidebarCollapsed,
    resetMapTrigger, setResetMapTrigger,
    labelSize, setLabelSize,
    mapLoading, setMapLoading,
    resetMapView,
  }), [
    isSidebarOpen, isLeftSidebarCollapsed, resetMapTrigger, labelSize,
    mapLoading,
    resetMapView,
  ]);

  return <MapContext.Provider value={value}>{children}</MapContext.Provider>;
};

export const useMap = () => {
  const ctx = useContext(MapContext);
  if (!ctx) throw new Error('useMap must be used within a MapProvider');
  return ctx;
};
