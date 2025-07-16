import { useEffect } from 'react';

import useTransitStops from './useTransitStops';
import useTransitLines from './useTransitLines';
import useTransitVolumesLayer from './useTransitVolumesLayer';

export default function useTransitLayers({
  mapRef,
  loadWithFallback,
  searchCanton,
  selectedTransitModes,
  showStopVolumeSymbology,
  setSelectedTransitStop,
  setHighlightedLineId,
  highlightedLineId,
  highlightedRouteIds,
  setHighlightedRouteIds,
  hoveredRouteId,
  isGraphExpanded,
  suppressNextSearchZoom,
  setClickedCanton,
  timeRange,
  setIsLoading,
  setSelectedTransitLink,
  showLineSymbology
}) {
  
  // Add transit stops and interactions
  useTransitStops({
    mapRef,
    searchCanton,
    isGraphExpanded,
    loadWithFallback,
    showStopVolumeSymbology,
    selectedTransitModes,
    setSelectedTransitStop,
    setHighlightedLineId,
    setHighlightedRouteIds
  });
  
  // Add transit lines and interactions
  useTransitLines(
    mapRef, 
    highlightedRouteIds,
    highlightedLineId,
    hoveredRouteId,
    isGraphExpanded,
    loadWithFallback,
    searchCanton,
    showStopVolumeSymbology,
    setClickedCanton,
    setHighlightedLineId,
    setHighlightedRouteIds,
    setSelectedTransitStop,
    suppressNextSearchZoom
  )
  
  useTransitVolumesLayer({
    mapRef,
    isGraphExpanded,
    searchCanton,
    timeRange,
    loadWithFallback,
    selectedTransitModes,
    setIsLoading,
    setSelectedTransitLink,
    showLineSymbology
  });
  
  // if canton changed, remove current transit layers, reset selected stop
  useEffect(() => {
    const map = mapRef.current;
    if (searchCanton && map) {
      
      if (isGraphExpanded === "Transit") {
        if (map.getLayer("transit-highlight-layer")) map.removeLayer("transit-highlight-layer");
        if (map.getSource("transit-highlight")) map.removeSource("transit-highlight");
        
        setSelectedTransitStop(null);
      } else if (isGraphExpanded !== "TransitVolumes") {
        // for volumes: if switching away, clear state too
        setSelectedNetworkFeature(null);
      }
    }
  }, [searchCanton]); // only update when searchCanton updates
}
