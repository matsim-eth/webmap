import React, { useRef } from 'react';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useDashboard } from '../../context/DashboardContext';
import { useData } from '../../context/DataContext';
import { useCantonMap } from '../../hooks/useCantonMap';

const CantonMap = ({ sidebarCollapsed, isExpanded = false, activeTab }) => {
  const mapContainer = useRef(null);
  const { selectedCanton, setSelectedCanton, selectedTransitStop, setSelectedTransitStop, setSelectedTransitLine } = useDashboard();
  const { getCantonData } = useData();

  useCantonMap({
    mapContainer,
    sidebarCollapsed,
    isExpanded,
    activeTab,
    selectedCanton,
    setSelectedCanton,
    selectedTransitStop,
    setSelectedTransitStop,
    setSelectedTransitLine,
    getCantonData,
  });

  return (
    <div className="canton-map-container">
      <div ref={mapContainer} className="canton-map" />
    </div>
  );
};

export default CantonMap;
