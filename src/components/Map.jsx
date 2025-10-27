import React, { useRef, useEffect, useState } from 'react';
import "./Loading.css" // loading screen for network
import { useLoadWithFallback }  from '../utils/useLoadWithFallback';
import useMapbox                from './map/useMapbox';
import useCantons               from './map/useCantons';
import usePadding               from './map/usePadding';
import useNetworkLayers         from './map/useNetworkLayers';
import useTransitLayers         from './map/useTransitLayers';
import useChoropleth            from './map/useChoropleth';
import useDestinationZones      from './map/useDestinationZones';
import useFeatureSelectionFocus      from './map/useFeatureSelectionFocus';

export default function Map(props) {
  
  // load util for loading in the data (from link or local upload)
  const loadWithFallback = useLoadWithFallback(props.dataURL);

  // for disabling next zoom to canton (ie when click on out-of-canton transit stop)
  const suppressNextSearchZoom = useRef(false);

  // for setting loading spinner while loading transit geojson
  const [isLoading, setIsLoading] = useState(false);
  
  // for keeping track of the current sidebar module
  const graphExpandedRef = useRef(props.isGraphExpanded);
  useEffect(() => {
    graphExpandedRef.current = props.isGraphExpanded;
  }, [props.isGraphExpanded]);
  
  // initialize mapbox map instance
  const {
    mapRef, 
    mapContainerRef, 
    mapReady 
  } = useMapbox(import.meta.env.VITE_MAPBOX_TOKEN);
  
  useEffect(() => {
    if (props.mapRef) {
      props.mapRef.current = mapRef.current;
    }
  }, [props.mapRef, mapRef, mapReady]);
  
  // add canton layers + interactions
  useCantons({
    mapRef,
    mapReady,
    setClickedCanton:     props.setClickedCanton,
    searchCanton:         props.searchCanton,
    isGraphExpanded:      props.isGraphExpanded,
    suppressNextSearchZoom,
    graphExpandedRef,
    setIsFeatureTableOpen: props.setIsFeatureTableOpen,
    isFeatureTableOpen:   props.isFeatureTableOpen,
    setIsTransitFeatureTableOpen: props.setIsTransitFeatureTableOpen
  });
  
  // pan map depending on sidebar state (keeps map in centre regardless of sidebar width)
  usePadding({
    mapRef,
    setClickedCanton:     props.setClickedCanton,
    searchCanton:         props.searchCanton,
    isSidebarOpen:        props.isSidebarOpen,
    isGraphExpanded:      props.isGraphExpanded,
    suppressNextSearchZoom,
    graphExpandedRef,
    isFeatureTableOpen:  props.isFeatureTableOpen,
    setIsFeatureTableOpen: props.setIsFeatureTableOpen,
    isTransitFeatureTableOpen: props.isTransitFeatureTableOpen,
    setIsTransitFeatureTableOpen: props.setIsTransitFeatureTableOpen
  });
  
  useNetworkLayers({
    mapRef,
    loadWithFallback,
    graphExpandedRef,
    searchCanton:               props.searchCanton,          
    selectedNetworkModes:       props.selectedNetworkModes,
    showMajorRoadsOnly:         props.showMajorRoadsOnly,
    timeRange:                  props.timeRange,
    visualizeLinkId:            props.visualizeLinkId,
    setSelectedNetworkFeature:  props.setSelectedNetworkFeature,
    isGraphExpanded:            props.isGraphExpanded,
    resetMapTrigger:            props.resetMapTrigger,
    labelSize:                  props.labelSize,
    setIsLoading,
    setFeatureGeoJSON:          props.setFeatureGeoJSON,
  });
  
  useTransitLayers({ 
    mapRef,
    loadWithFallback,
    searchCanton:             props.searchCanton, 
    selectedTransitModes:     props.selectedTransitModes,
    showStopVolumeSymbology:  props.showStopVolumeSymbology,
    setSelectedTransitStop:   props.setSelectedTransitStop,
    setHighlightedLineId:     props.setHighlightedLineId,
    highlightedLineId:        props.highlightedLineId,
    highlightedRouteIds:      props.highlightedRouteIds,
    setHighlightedRouteIds:   props.setHighlightedRouteIds,
    hoveredRouteId:           props.hoveredRouteId,
    isGraphExpanded:          props.isGraphExpanded,
    setClickedCanton:         props.setClickedCanton,
    timeRange:                props.timeRange,
    setSelectedTransitLink:  props.setSelectedTransitLink,
    showLineSymbology: props.showLineSymbology,
    setIsLoading,
    suppressNextSearchZoom,
    setTransitFeatureGeoJSON: props.setTransitFeatureGeoJSON,
    transitTableFilterQuery:  props.transitTableFilterQuery
  });
  
  useChoropleth({ 
    mapRef,
    loadWithFallback,
    selectedMode:     props.selectedMode,
    selectedDataset:  props.selectedDataset,
    isGraphExpanded:  props.isGraphExpanded,
    aggCol:           props.aggCol,
  });
  
  useDestinationZones({ 
    mapRef, 
    selectedDestinationData:  props.selectedDestinationData, 
    isGraphExpanded:          props.isGraphExpanded
  });

  // Combined feature selection focus for both network and transit (uses shared network-highlight)
  // Determine which selection/query/modes to use based on current module
  const isTransitMode = props.isGraphExpanded === 'Transit' || props.isGraphExpanded === 'TransitVolumes';
  const activeSelection = isTransitMode ? props.transitFeatureSelection : props.featureSelection;
  const activeQuery = isTransitMode ? props.transitTableFilterQuery : props.tableFilterQuery;
  const activeModes = isTransitMode ? props.selectedTransitModes : props.selectedNetworkModes;

  useFeatureSelectionFocus({
    mapRef, 
    mapReady, 
    selection:            activeSelection,
    query:                activeQuery,
    selectedNetworkModes: activeModes,
    isGraphExpanded:      props.isGraphExpanded,
    showMajorRoadsOnly:   props.showMajorRoadsOnly,
  });

  // this is placed in here so that it will overtake the other zooming effects to
    // force it to zoom back to the original Switzerland extent
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
        <div className="loading-text">Loading network...</div>
        </div>
      )}
      <div ref={mapContainerRef} style={{ width:'100%',height:'100%' }}/>
      </>
    );
  }