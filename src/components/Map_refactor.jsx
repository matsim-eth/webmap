// HIGHLY WIP, VERY BROKEN ATM

import React, { useMemo } from 'react';
import useMapbox from './map/useMapbox';
import useCantons from './map/useCantons';
import useNetworkLayers from './map/useNetworkLayers';
import useTransitStops from './map/useTransitStops';
import useChoropleth from './map/useChoropleth';
import useMapPadding from './map/useMapPadding';
import './Loading.css'; // spinner styles

export default function Map(props) {
  const { mapRef, mapContainerRef } = useMapbox(import.meta.env.VITE_MAPBOX_TOKEN);

  useCantons({
    mapRef,
    dataURL: props.dataURL,
    onCantonSelect: props.setClickedCanton,
  });

  const activeCanton = useMemo(
    () => props.searchCanton ?? props.clickedCanton ?? null,
    [props.searchCanton, props.clickedCanton],
  );

  const { isLoading: isLoadingNetwork } = useNetworkLayers({
    mapRef,
    canton: activeCanton,
    dataURL: props.dataURL,
    selectedNetworkModes: props.selectedNetworkModes,
    visualizeLinkId: props.visualizeLinkId,
    setSelectedNetworkFeature: props.setSelectedNetworkFeature,
    isGraphExpanded: props.isGraphExpanded,
  });

  useTransitStops({
    mapRef,
    canton: activeCanton,
    dataURL: props.dataURL,
    selectedTransitModes: props.selectedTransitModes,
    showStopVolumeSymbology: props.showStopVolumeSymbology,
    setSelectedTransitStop: props.setSelectedTransitStop,
    setHighlightedLineId: props.setHighlightedLineId,
    highlightedLineId: props.highlightedLineId,
    setHighlightedRouteIds: props.setHighlightedRouteIds,
    hoveredRouteId: props.hoveredRouteId,
    isGraphExpanded: props.isGraphExpanded,
  });

  useChoropleth({
    mapRef,
    dataURL: props.dataURL,
    selectedMode: props.selectedMode,
    selectedDataset: props.selectedDataset,
    aggCol: props.aggCol,
  });

  useMapPadding({
    mapRef,
    isSidebarOpen: props.isSidebarOpen,
    isGraphExpanded: props.isGraphExpanded,
  });

  return (
    <>
      {isLoadingNetwork && (
        <div className="map-loading-overlay">
          <div className="spinner" />
          <div className="loading-text">Loading network...</div>
        </div>
      )}
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />
    </>
  );
}
