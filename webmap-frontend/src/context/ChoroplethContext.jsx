import { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ChoroplethContext = createContext(null);

/**
 * Choropleth symbology + transit line highlight state.
 * Grouped together because the choropleth module owns the transit line
 * highlight ids (line/route/hover) used by the transit layer.
 */
export const ChoroplethProvider = ({ children }) => {
  const [aggCol, setAggCol] = useState('mode');
  const [selectedMode, setSelectedMode] = useState('None');
  const [selectedDataset, setSelectedDataset] = useState('Synthetic');

  const [highlightedLineId, setHighlightedLineId] = useState(null);
  const [highlightedRouteIds, setHighlightedRouteIds] = useState([]);
  const [hoveredRouteId, setHoveredRouteId] = useState(null);

  const updateMapChoropleth = useCallback((mode, dataset) => {
    setSelectedMode(mode);
    setSelectedDataset(dataset);
  }, []);

  const value = useMemo(() => ({
    aggCol, setAggCol,
    selectedMode, setSelectedMode,
    selectedDataset, setSelectedDataset,
    updateMapChoropleth,
    highlightedLineId, setHighlightedLineId,
    highlightedRouteIds, setHighlightedRouteIds,
    hoveredRouteId, setHoveredRouteId,
  }), [
    aggCol, selectedMode, selectedDataset, updateMapChoropleth,
    highlightedLineId, highlightedRouteIds, hoveredRouteId,
  ]);

  return <ChoroplethContext.Provider value={value}>{children}</ChoroplethContext.Provider>;
};

export const useChoropleth = () => {
  const ctx = useContext(ChoroplethContext);
  if (!ctx) throw new Error('useChoropleth must be used within a ChoroplethProvider');
  return ctx;
};
