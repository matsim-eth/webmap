import React, { useRef, useState } from 'react';
import "./Loading.css" // loading screen for network
import { useLoadWithFallback } from '../utils/useLoadWithFallback';
import useMapbox from './map/useMapbox';
import useCantons from './map/useCantons';
import usePadding from './map/usePadding';
import useNetworkLayers from './map/useNetworkLayers';
import useNetworkSplitLayers from './map/useNetworkSplitLayers';
import useTransitLayers from './map/useTransitLayers';
import useChoropleth from './map/useChoropleth';
import useDestinationZones from './map/useDestinationZones';
import usePtBoardings from './map/usePtBoardings';
import useFeatureSelectionFocus from './map/useFeatureSelectionFocus';
import useVolumeFlowLayers from './map/useVolumeFlowLayers';
import useNodeFlowLayers from './map/useNodeFlowLayers';
import useLinkSpeedsLayers from './map/useLinkSpeedsLayers';
import useZoneFlowLayers from './map/useZoneFlowLayers';
import usePolygonTrips from './map/usePolygonTrips';
import useDrawTools from './map/useDrawTools';
import { useModule } from '../context/ModuleContext';
import { useMap } from '../context/MapContext';
import { useData } from '../context/DataContext';
import { useFilters } from '../context/FilterContext';
import { useSelection } from '../context/SelectionContext';
import { useChoropleth as useChoroplethState } from '../context/ChoroplethContext';
import { useResetMapView } from '../hooks/useResetMapView';

export default function Map() {
  const { isGraphExpanded } = useModule();
  const {
    mapRef: contextMapRef,
    drawRef: contextDrawRef,
    isSidebarOpen,
    isLeftSidebarCollapsed,
    resetMapTrigger,
    labelSize,
    mapLoading,
    setMapLoading,
  } = useMap();
  const {
    datasetId,
    dataURL,
    setIsFeatureTableOpen,
    isFeatureTableOpen,
    setFeatureGeoJSON,
    featureGeoJSON,
    tableFilterQuery,
    destinationData: selectedDestinationData,
    boardingData: selectedBoardingData,
    zoneFlowLoading,
  } = useData();
  const {
    selectedNetworkModes,
    selectedTransitModes,
    showMajorRoadsOnly,
    showStopVolumeSymbology,
    showLineSymbology,
    timeRange,
    selectedDirection,
  } = useFilters();
  const {
    setClickedCanton,
    clickedCanton: searchCanton,
    visualizeLinkId,
    visualizeNonce,
    setSelectedNetworkFeature,
    setSelectedTransitStop,
    setSelectedTransitLink,
    featureSelection,
    setFeatureSelection,
  } = useSelection();
  const {
    selectedMode,
    selectedDataset,
    aggCol,
    setHighlightedLineId,
    highlightedLineId,
    highlightedRouteIds,
    setHighlightedRouteIds,
    hoveredRouteId,
  } = useChoroplethState();

  // load util for loading in the data (from link or local upload)
  const loadWithFallback = useLoadWithFallback(dataURL);

  // for disabling next zoom to canton (ie when click on out-of-canton transit stop)
  const suppressNextSearchZoom = useRef(false);

  // for setting loading spinner while loading transit geojson
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSpeeds, setIsLoadingSpeeds] = useState(false);
  const [isLoadingZoneFlows, setIsLoadingZoneFlows] = useState(false);

  // for keeping track of the current sidebar module
  const graphExpandedRef = useRef(isGraphExpanded);
  graphExpandedRef.current = isGraphExpanded;

  // initialize mapbox map instance
  const {
    mapRef,
    mapContainerRef,
    mapReady
  } = useMapbox(import.meta.env.VITE_MAPBOX_TOKEN);

  // Sync map instance to context ref (derived assignment, not an effect)
  if (contextMapRef && mapReady) {
    contextMapRef.current = mapRef.current;
  }

  // add canton layers + interactions
  useCantons({
    mapRef,
    mapReady,
    setClickedCanton: setClickedCanton,
    searchCanton: searchCanton,
    isGraphExpanded: isGraphExpanded,
    suppressNextSearchZoom,
    graphExpandedRef,
    setIsFeatureTableOpen: setIsFeatureTableOpen,
    isFeatureTableOpen: isFeatureTableOpen,
    isLeftSidebarOpen: !isLeftSidebarCollapsed,
    drawRef: contextDrawRef
  });

  // pan map depending on sidebar state (keeps map in centre regardless of sidebar width)
  usePadding({
    mapRef,
    mapReady,
    setClickedCanton: setClickedCanton,
    searchCanton: searchCanton,
    isSidebarOpen: isSidebarOpen,
    isGraphExpanded: isGraphExpanded,
    suppressNextSearchZoom,
    graphExpandedRef,
    isFeatureTableOpen: isFeatureTableOpen,
    setIsFeatureTableOpen: setIsFeatureTableOpen,
    isLeftSidebarOpen: !isLeftSidebarCollapsed
  });

  useNetworkLayers({
    mapRef,
    loadWithFallback,
    graphExpandedRef,
    datasetId: datasetId,
    searchCanton: searchCanton,
    selectedNetworkModes: selectedNetworkModes,
    showMajorRoadsOnly: showMajorRoadsOnly,
    timeRange: timeRange,
    visualizeLinkId: visualizeLinkId,
    visualizeNonce: visualizeNonce,
    setSelectedNetworkFeature: setSelectedNetworkFeature,
    setFeatureSelection: setFeatureSelection,
    isGraphExpanded: isGraphExpanded,
    resetMapTrigger: resetMapTrigger,
    labelSize: labelSize,
    setIsLoading,
    setMapLoading,
    setFeatureGeoJSON: setFeatureGeoJSON,
    drawRef: contextDrawRef,
  });

  // LinkSpeeds-style per-direction split overlay for the Network and Volumes
  // modules (offset lines + per-direction click at zoom >= 15; Volumes also gets
  // per-direction volume colour + offset labels). Mounted after useNetworkLayers
  // so the base network-layer exists when this caps its zoom range.
  useNetworkSplitLayers({
    mapRef,
    mapReady,
  });

  useTransitLayers({
    mapRef,
    loadWithFallback,
    datasetId: datasetId,
    searchCanton: searchCanton,
    selectedTransitModes: selectedTransitModes,
    showStopVolumeSymbology: showStopVolumeSymbology,
    setSelectedTransitStop: setSelectedTransitStop,
    setHighlightedLineId: setHighlightedLineId,
    highlightedLineId: highlightedLineId,
    highlightedRouteIds: highlightedRouteIds,
    setHighlightedRouteIds: setHighlightedRouteIds,
    hoveredRouteId: hoveredRouteId,
    isGraphExpanded: isGraphExpanded,
    setClickedCanton: setClickedCanton,
    timeRange: timeRange,
    setSelectedTransitLink: setSelectedTransitLink,
    showLineSymbology: showLineSymbology,
    setIsLoading,
    suppressNextSearchZoom,
    setFeatureGeoJSON: setFeatureGeoJSON,
    tableFilterQuery: tableFilterQuery,
    selectedDirection: selectedDirection,
    drawRef: contextDrawRef
  });

  useChoropleth({
    mapRef,
    loadWithFallback,
    datasetId: datasetId,
    selectedMode: selectedMode,
    selectedDataset: selectedDataset,
    isGraphExpanded: isGraphExpanded,
    aggCol: aggCol,
  });

  useDestinationZones({
    mapRef,
    selectedDestinationData: selectedDestinationData,
    isGraphExpanded: isGraphExpanded
  });

  usePtBoardings({
    mapRef,
    selectedBoardingData: selectedBoardingData,
    setHighlightedLineId: setHighlightedLineId,
    setHighlightedRouteIds: setHighlightedRouteIds,
    isGraphExpanded: isGraphExpanded,
    loadWithFallback,
    searchCanton: searchCanton,
    setSelectedTransitStop: setSelectedTransitStop
  })

  // Volume Flow Analysis layers
  useVolumeFlowLayers({
    mapRef,
    mapReady,
  });

  // Node Flows (turning-movement matrix) layers
  useNodeFlowLayers({
    mapRef,
    mapReady,
  });

  // Link Speeds overlay
  useLinkSpeedsLayers({
    mapRef,
    mapReady,
    setIsLoading: setIsLoadingSpeeds,
  });

  // Zone Flows overlay (inter-canton trip routes — flow_geojson from the backend)
  useZoneFlowLayers({
    mapRef,
    mapReady,
    setIsLoading: setIsLoadingZoneFlows,
  });

  // Draw tools (polygon draw/delete)
  useDrawTools({
    mapRef,
    mapReady,
    isGraphExpanded,
    contextDrawRef,
  });

  // Polygon Trips (in/out/within mode summary for a drawn polygon)
  usePolygonTrips({ mapRef, mapReady });

  // Combined feature selection focus for both network and transit (uses shared network-highlight)
  // Determine which query/modes to use based on current module
  const isTransitMode = isGraphExpanded === 'Transit' || isGraphExpanded === 'TransitVolumes';
  const activeQuery = tableFilterQuery;
  const activeModes = isTransitMode ? selectedTransitModes : selectedNetworkModes;

  useFeatureSelectionFocus({
    mapRef,
    mapReady,
    selection: featureSelection,
    query: activeQuery,
    selectedNetworkModes: activeModes,
    isGraphExpanded: isGraphExpanded,
    showMajorRoadsOnly: showMajorRoadsOnly,
    showStopVolumeSymbology: showStopVolumeSymbology,
    featureGeoJSON: featureGeoJSON,
  });

  // this is placed in here so that it will overtake the other zooming effects to
  // force it to zoom back to the original Switzerland extent
  useResetMapView({ mapRef, mapReady, resetMapTrigger, isLeftSidebarCollapsed });

  // Keep the zone-flows overlay up for the WHOLE pipeline, not just the initial
  // endpoint-network load: isLoadingZoneFlows covers reconcileSource, while
  // zoneFlowLoading spans the backend fetch + full-route load until the flows
  // are painted. Gated to the module so a stray flag can't leak into others.
  const zoneFlowsBusy = isGraphExpanded === 'ZoneFlows'
    && (isLoadingZoneFlows || zoneFlowLoading);

  return (
    <>
      {(isLoading || isLoadingSpeeds) && (
        <div className="map-loading-overlay">
          <div className="spinner" />
          <div className="loading-text">
            {isLoading ? 'Loading network...' : 'Loading link speeds...'}
          </div>
        </div>
      )}
      {zoneFlowsBusy && !isLoading && !isLoadingSpeeds && (
        <div className="map-loading-overlay">
          <div className="spinner" />
          <div className="loading-text">Loading zone flows...</div>
        </div>
      )}
      {mapLoading && !isLoading && !isLoadingSpeeds && !zoneFlowsBusy && (
        <div className="map-loading-overlay">
          <div className="spinner" />
          <div className="loading-text">Updating map...</div>
        </div>
      )}
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
    </>
  );
}