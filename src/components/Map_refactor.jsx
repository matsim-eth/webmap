import React, { useRef } from 'react';
import "./Loading.css" // loading screen for network
import useMapbox from './map/useMapbox';
import useCantons             from './map/useCantons';
import useNetworkLayers       from './map/useNetworkLayers';
import useTransitStops        from './map/useTransitStops';
import useChoropleth          from './map/useChoropleth';
import useMapPadding          from './map/useMapPadding';

export default function Map(props) {
  const { mapRef, mapContainerRef, mapReady } = useMapbox(import.meta.env.VITE_MAPBOX_TOKEN);
  
  const suppressNextSearchZoom = useRef(false);
  
  useCantons({
    mapRef,
    mapReady,
    dataURL: props.dataURL,
    setClickedCanton:     props.setClickedCanton,
    searchCanton:         props.searchCanton,
    isSidebarOpen:        props.isSidebarOpen,
    isGraphExpanded:      props.isGraphExpanded,
    suppressNextSearchZoom
  });
  
  const { isLoading } = useNetworkLayers({
    mapRef,
    dataURL: props.dataURL,
    searchCanton: props.searchCanton,          
    selectedNetworkModes: props.selectedNetworkModes,
    showMajorRoadsOnly:   props.showMajorRoadsOnly,
    timeRange:            props.timeRange,
    visualizeLinkId:      props.visualizeLinkId,
    setSelectedNetworkFeature: props.setSelectedNetworkFeature,
    isGraphExpanded:      props.isGraphExpanded,
  });
  
  useTransitStops({ 
    mapRef,
    dataURL: props.dataURL,
    searchCanton: props.searchCanton, 
    selectedTransitModes: props.selectedTransitModes,
    showStopVolumeSymbology: props.showStopVolumeSymbology,
    setSelectedTransitStop: props.setSelectedTransitStop,
    setHighlightedLineId: props.setHighlightedLineId,
    highlightedLineId: props.highlightedLineId,
    highlightedRouteIds: props.highlightedRouteIds  ,
    setHighlightedRouteIds: props.setHighlightedRouteIds,
    hoveredRouteId: props.hoveredRouteId,
    isGraphExpanded:      props.isGraphExpanded,
    setClickedCanton:     props.setClickedCanton,
    suppressNextSearchZoom
  });
  
  // useChoropleth({ /* copy-paste your choropleth args */ });
  // useMapPadding({ mapRef, isSidebarOpen: props.isSidebarOpen, isGraphExpanded: props.isGraphExpanded });
  
  return (
    <>
    {isLoading && (
      <div className="map-loading-overlay">
      <div className="spinner" />
      <div className="loading-text">Loading network…</div>
      </div>
    )}
    <div ref={mapContainerRef} style={{ width:'100%',height:'100%' }}/>
    </>
  );
}