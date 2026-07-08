import { useCallback } from 'react';
import { useModule } from '../context/ModuleContext';
import { useMap } from '../context/MapContext';
import { useData } from '../context/DataContext';
import { useFilters } from '../context/FilterContext';
import { useChoropleth } from '../context/ChoroplethContext';

/**
 * The Reset button's full behaviour as a shared action: clears module,
 * choropleth, filter and selection state, refits the map to the study area,
 * and closes the right sidebar. Used by the LeftSidebar Reset button and by
 * the dataset selector — switching datasets must behave exactly like a reset
 * so no per-module state (selected stops, flows, drawn polygons, choropleth)
 * leaks from one dataset into the next.
 */
export function useFullReset() {
  const { setIsGraphExpanded } = useModule();
  const { setResetMapTrigger, resetMapView, setIsSidebarOpen } = useMap();
  const { setIsFeatureTableOpen, setDataURL } = useData();
  const { setSelectedNetworkModes, setSelectedTransitModes } = useFilters();
  const {
    setHighlightedLineId, setHighlightedRouteIds,
    setSelectedDataset, setSelectedMode,
    updateMapChoropleth,
  } = useChoropleth();

  return useCallback(() => {
    setResetMapTrigger((prev) => !prev);

    setSelectedDataset('Microcensus');
    setSelectedMode('None');
    setSelectedNetworkModes(['all']);
    setSelectedTransitModes(['all']);
    updateMapChoropleth('None', 'Microcensus');
    resetMapView();

    setHighlightedLineId(null);
    setHighlightedRouteIds([]);

    setIsGraphExpanded(null);
    setIsFeatureTableOpen(false);

    setDataURL('https://matsim-eth.github.io/webmap/data/');

    setIsSidebarOpen(false);
  }, [
    setResetMapTrigger, setSelectedDataset, setSelectedMode,
    setSelectedNetworkModes, setSelectedTransitModes, updateMapChoropleth,
    resetMapView, setHighlightedLineId, setHighlightedRouteIds,
    setIsGraphExpanded, setIsFeatureTableOpen, setDataURL, setIsSidebarOpen,
  ]);
}
