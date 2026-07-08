import { useEffect, useRef } from 'react';
import { computeMapPadding } from '../components/sidebar/sidebarLayout';
import { useData } from '../context/DataContext';
import { SWISS_STUDY_AREA } from '../utils/swissDefaults';

/**
 * Hook to reset the map view when the resetMapTrigger changes.
 * Zooms back to the study area's full extent (Switzerland for legacy
 * datasets — the Swiss fallback carries the exact literals this hook
 * used to hardcode: center [8.1642, 46.7592], zoom 7).
 */
export function useResetMapView({ mapRef, mapReady, resetMapTrigger, isLeftSidebarCollapsed }) {
  const { studyArea } = useData();

  // Read the extent through a ref so a study-area load doesn't retrigger the
  // reset animation — only resetMapTrigger (and initial mapReady) should.
  const extentRef = useRef(null);
  extentRef.current = {
    center: studyArea?.center || SWISS_STUDY_AREA.center,
    zoom: studyArea?.zoom ?? SWISS_STUDY_AREA.zoom,
  };

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    // If user clicked reset, go back to full study-area view. Reset also
    // closes the active module, so the right sidebar is hidden.
    mapRef.current.easeTo({
      center: extentRef.current.center,
      zoom: extentRef.current.zoom,
      duration: 1000,
      padding: computeMapPadding({
        isGraphExpanded: null,
        isSidebarOpen: false,
        isLeftSidebarOpen: !isLeftSidebarCollapsed,
      }),
    });
  }, [resetMapTrigger, mapReady]);
}
