import { useCallback } from 'react';
import { useModule } from '../context/ModuleContext';
import { useMap } from '../context/MapContext';
import { useData } from '../context/DataContext';
import { useFilters } from '../context/FilterContext';
import { useChoropleth } from '../context/ChoroplethContext';
import { clearNetworkGeometryCache } from '../components/map/_lib/networkGeometry';
import { clearPtVolumeCache } from '../components/map/_lib/ptVolumes';

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
  const { setIsFeatureTableOpen } = useData();
  const { setSelectedNetworkModes, setSelectedTransitModes } = useFilters();
  const {
    setHighlightedLineId, setHighlightedRouteIds,
    setSelectedDataset, setSelectedMode,
    updateMapChoropleth,
  } = useChoropleth();

  return useCallback(() => {
    // Let go of the cached per-(dataset, canton) map data. Both caches are
    // keyed the same and the PT bundle holds references into the geometry, so
    // they are always cleared together. This is the escape hatch for a dataset
    // whose assets changed underneath a live session — normal dataset/canton
    // switches invalidate by key on their own.
    clearNetworkGeometryCache();
    clearPtVolumeCache();

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

    setIsSidebarOpen(false);
  }, [
    setResetMapTrigger, setSelectedDataset, setSelectedMode,
    setSelectedNetworkModes, setSelectedTransitModes, updateMapChoropleth,
    resetMapView, setHighlightedLineId, setHighlightedRouteIds,
    setIsGraphExpanded, setIsFeatureTableOpen, setIsSidebarOpen,
  ]);
}
