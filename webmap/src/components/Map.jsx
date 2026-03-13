import React, { useRef, useEffect, useState } from 'react';
import "./Loading.css" // loading screen for network
import { useLoadWithFallback } from '../utils/useLoadWithFallback';
import useMapbox from './map/useMapbox';
import useCantons from './map/useCantons';
import usePadding from './map/usePadding';
import useNetworkLayers from './map/useNetworkLayers';
import useTransitLayers from './map/useTransitLayers';
import useChoropleth from './map/useChoropleth';
import useDestinationZones from './map/useDestinationZones';
import usePtBoardings from './map/usePtBoardings';
import useFeatureSelectionFocus from './map/useFeatureSelectionFocus';
import useVolumeFlowLayers from './map/useVolumeFlowLayers';
import { useApp } from '../context/AppContext';

export default function Map() {
  const {
    dataURL,
    isGraphExpanded,
    mapRef: contextMapRef,
    setClickedCanton,
    clickedCanton: searchCanton, // Alias
    setIsFeatureTableOpen,
    isFeatureTableOpen,
    isSidebarOpen,
    isLeftSidebarCollapsed,
    selectedNetworkModes,
    showMajorRoadsOnly,
    timeRange,
    visualizeLinkId,
    setSelectedNetworkFeature,
    resetMapTrigger,
    labelSize,
    setFeatureGeoJSON,
    selectedTransitModes,
    showStopVolumeSymbology,
    setSelectedTransitStop,
    setHighlightedLineId,
    highlightedLineId,
    highlightedRouteIds,
    setHighlightedRouteIds,
    hoveredRouteId,
    setSelectedTransitLink,
    showLineSymbology,
    tableFilterQuery,
    selectedMode,
    selectedDataset,
    aggCol,
    destinationData: selectedDestinationData, // Alias
    boardingData: selectedBoardingData, // Alias
    featureSelection
  } = useApp();

  // load util for loading in the data (from link or local upload)
  const loadWithFallback = useLoadWithFallback(dataURL);

  // for disabling next zoom to canton (ie when click on out-of-canton transit stop)
  const suppressNextSearchZoom = useRef(false);

  // for setting loading spinner while loading transit geojson
  const [isLoading, setIsLoading] = useState(false);

  // for keeping track of the current sidebar module
  const graphExpandedRef = useRef(isGraphExpanded);
  useEffect(() => {
    graphExpandedRef.current = isGraphExpanded;
  }, [isGraphExpanded]);

  // initialize mapbox map instance
  const {
    mapRef,
    mapContainerRef,
    mapReady
  } = useMapbox(import.meta.env.VITE_MAPBOX_TOKEN);

  useEffect(() => {
    if (contextMapRef) {
      contextMapRef.current = mapRef.current;
    }
  }, [contextMapRef, mapRef, mapReady]);

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
    isLeftSidebarOpen: !isLeftSidebarCollapsed
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
    searchCanton: searchCanton,
    selectedNetworkModes: selectedNetworkModes,
    showMajorRoadsOnly: showMajorRoadsOnly,
    timeRange: timeRange,
    visualizeLinkId: visualizeLinkId,
    setSelectedNetworkFeature: setSelectedNetworkFeature,
    isGraphExpanded: isGraphExpanded,
    resetMapTrigger: resetMapTrigger,
    labelSize: labelSize,
    setIsLoading,
    setFeatureGeoJSON: setFeatureGeoJSON,
  });

  useTransitLayers({
    mapRef,
    loadWithFallback,
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
    tableFilterQuery: tableFilterQuery
  });

  useChoropleth({
    mapRef,
    loadWithFallback,
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
  });

  // this is placed in here so that it will overtake the other zooming effects to
  // force it to zoom back to the original Switzerland extent
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const leftPadding = isLeftSidebarCollapsed ? 50 : 185;

    // If user clicked reset, go back to full country view
    mapRef.current.easeTo({
      center: [8.1642, 46.7592],
      zoom: 7,
      duration: 1000,
      padding: { top: 50, bottom: 50, left: leftPadding, right: 50 },
    });
  }, [resetMapTrigger, mapReady]);

  return (
    <>
      {isLoading && (
        <div className="map-loading-overlay">
          <div className="spinner" />
          <div className="loading-text">Loading network...</div>
        </div>
      )}
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
    </>
  );
}