import React, { useRef, useEffect } from 'react';
import "./Loading.css" // loading screen for network
import useMapbox              from './map/useMapbox';
import useCantons             from './map/useCantons';
import useNetworkLayers       from './map/useNetworkLayers';
import useTransitStops        from './map/useTransitStops';
import useChoropleth          from './map/useChoropleth';
import useDestinationZones    from './map/useDestinationZones';

export default function Map(props) {
  
  const suppressNextSearchZoom = useRef(false);
  
  const {
    mapRef, 
    mapContainerRef, 
    mapReady 
  } = useMapbox(import.meta.env.VITE_MAPBOX_TOKEN);
  
  useCantons({
    mapRef,
    mapReady,
    dataURL:              props.dataURL,
    setClickedCanton:     props.setClickedCanton,
    searchCanton:         props.searchCanton,
    isSidebarOpen:        props.isSidebarOpen,
    isGraphExpanded:      props.isGraphExpanded,
    suppressNextSearchZoom
  });
  
  const { isLoading } = useNetworkLayers({
    mapRef,
    dataURL:                    props.dataURL,
    searchCanton:               props.searchCanton,          
    selectedNetworkModes:       props.selectedNetworkModes,
    showMajorRoadsOnly:         props.showMajorRoadsOnly,
    timeRange:                  props.timeRange,
    visualizeLinkId:            props.visualizeLinkId,
    setSelectedNetworkFeature:  props.setSelectedNetworkFeature,
    isGraphExpanded:            props.isGraphExpanded,
    resetMapTrigger:            props.resetMapTrigger
  });
  
  useTransitStops({ 
    mapRef,
    dataURL:                  props.dataURL,
    searchCanton:             props.searchCanton, 
    selectedTransitModes:     props.selectedTransitModes,
    showStopVolumeSymbology:  props.showStopVolumeSymbology,
    setSelectedTransitStop:   props.setSelectedTransitStop,
    setHighlightedLineId:     props.setHighlightedLineId,
    highlightedLineId:        props.highlightedLineId,
    highlightedRouteIds:      props.highlightedRouteIds  ,
    setHighlightedRouteIds:   props.setHighlightedRouteIds,
    hoveredRouteId:           props.hoveredRouteId,
    isGraphExpanded:          props.isGraphExpanded,
    setClickedCanton:         props.setClickedCanton,
    suppressNextSearchZoom
  });
  
  useChoropleth({ 
    mapRef,
    dataURL:          props.dataURL,
    selectedMode:     props.selectedMode,
    selectedDataset:  props.selectedDataset,
    isGraphExpanded:  props.isGraphExpanded,
    aggCol:           props.aggCol,
  });
  
  useDestinationZones({ 
    mapRef, 
    selectedDestinationData: props.selectedDestinationData, 
    isGraphExpanded: props.isGraphExpanded});
    
    useEffect(() => {
      if (!mapReady || !mapRef.current) return;
      
      // If user clicked reset, go back to full country view
      mapRef.current.easeTo({
        center: [8.1642, 46.7592],
        zoom: 7,
        duration: 1000,
        padding:{top:50,bottom:50,left:50,right:350},
      });
    }, [props.resetMapTrigger, mapReady]);
    
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