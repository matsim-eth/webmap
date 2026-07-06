import { useEffect } from 'react';
import { safeRemoveLayer, safeRemoveSource } from './_lib/mapbox';

import useTransitStops from './useTransitStops';
import useTransitLines from './useTransitLines';
import useTransitVolumesLayer from './useTransitVolumesLayer';
import useTransitSymbologyLayer from "./useTransitSymbologyLayer";

export default function useTransitLayers({
  mapRef,
  loadWithFallback,
  datasetId,
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
  showLineSymbology,
  setFeatureGeoJSON,
  tableFilterQuery,
  selectedDirection,
  drawRef
}) {

  // Add transit stops and interactions
  useTransitStops({
    mapRef,
    searchCanton,
    datasetId,
    isGraphExpanded,
    loadWithFallback,
    showStopVolumeSymbology,
    selectedTransitModes,
    setSelectedTransitStop,
    setHighlightedLineId,
    setHighlightedRouteIds,
    highlightedLineId,
    suppressNextSearchZoom,
    setFeatureGeoJSON,
    timeRange,
    selectedDirection,
    drawRef
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
    selectedTransitModes,
    setClickedCanton,
    setHighlightedLineId,
    setHighlightedRouteIds,
    setSelectedTransitStop,
    suppressNextSearchZoom,
    datasetId
  )
  
  useTransitVolumesLayer({
    mapRef,
    isGraphExpanded,
    searchCanton,
    datasetId,
    timeRange,
    loadWithFallback,
    selectedTransitModes,
    setIsLoading,
    setSelectedTransitLink,
    highlightedLineId,
    setFeatureGeoJSON,
    tableFilterQuery,
    drawRef
  });
  
  useTransitSymbologyLayer({
    mapRef,
    searchCanton,
    datasetId,
    isGraphExpanded,
    highlightedLineId,
    loadWithFallback,
    showLineSymbology,
    selectedTransitModes
  });
  
  // if canton changed, remove current transit layers, reset selected stop
  useEffect(() => {
    const map = mapRef.current;
    if (searchCanton && map) {
      
      // Clear drawn polygons on canton change for any draw-enabled module
      if (['Transit', 'TransitVolumes', 'Volumes'].includes(isGraphExpanded)) {
        if (drawRef?.current?.getAll?.()?.features?.length > 0) {
          drawRef.current.deleteAll();
          map.fire('draw.delete', { features: [] });
        }
      }

      if (isGraphExpanded === "Transit") {
        safeRemoveLayer(map, "transit-highlight-layer");
        safeRemoveSource(map, "transit-highlight");

        setSelectedTransitStop(null);
      } else if (isGraphExpanded !== "TransitVolumes") {
        // for volumes: if switching away, clear state too
        setSelectedTransitLink(null);
      }
    }
  }, [searchCanton]); // only update when searchCanton updates
}
