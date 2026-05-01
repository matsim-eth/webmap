import { createContext, useContext, useMemo, useState } from 'react';

const FilterContext = createContext(null);

/**
 * User-controlled filters and toggles consumed by map layer hooks.
 * Each value is a sidebar control that changes how the map renders the
 * current canton's data (mode subset, time window, road type, direction).
 */
export const FilterProvider = ({ children }) => {
  const [timeRange, setTimeRange] = useState([0, 96]);

  const [selectedNetworkModes, setSelectedNetworkModes] = useState(['all']);
  const [selectedTransitModes, setSelectedTransitModes] = useState(['all']);

  const [showMajorRoadsOnly, setShowMajorRoadsOnly] = useState(true);
  const [showStopVolumeSymbology, setShowStopVolumeSymbology] = useState(false);
  const [showLineSymbology, setShowLineSymbology] = useState(false);

  const [selectedDirection, setSelectedDirection] = useState('total');
  const [volumeFlowDirection, setVolumeFlowDirection] = useState('bothflow');
  const [zoneFlowDirection, setZoneFlowDirection] = useState('both');

  const [linkSpeedsMetric, setLinkSpeedsMetric] = useState('congestion_index');
  const [linkSpeedsRoadTypes, setLinkSpeedsRoadTypes] = useState(['all']);

  const value = useMemo(() => ({
    timeRange, setTimeRange,
    selectedNetworkModes, setSelectedNetworkModes,
    selectedTransitModes, setSelectedTransitModes,
    showMajorRoadsOnly, setShowMajorRoadsOnly,
    showStopVolumeSymbology, setShowStopVolumeSymbology,
    showLineSymbology, setShowLineSymbology,
    selectedDirection, setSelectedDirection,
    volumeFlowDirection, setVolumeFlowDirection,
    zoneFlowDirection, setZoneFlowDirection,
    linkSpeedsMetric, setLinkSpeedsMetric,
    linkSpeedsRoadTypes, setLinkSpeedsRoadTypes,
  }), [
    timeRange,
    selectedNetworkModes, selectedTransitModes,
    showMajorRoadsOnly, showStopVolumeSymbology, showLineSymbology,
    selectedDirection, volumeFlowDirection, zoneFlowDirection,
    linkSpeedsMetric, linkSpeedsRoadTypes,
  ]);

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
};

export const useFilters = () => {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error('useFilters must be used within a FilterProvider');
  return ctx;
};
