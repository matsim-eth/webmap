import { useEffect } from 'react';
import { computeMapPadding } from '../components/sidebar/sidebarLayout';

/**
 * Hook to reset the map view when the resetMapTrigger changes.
 * Zooms back to the original Switzerland extent.
 */
export function useResetMapView({ mapRef, mapReady, resetMapTrigger, isLeftSidebarCollapsed }) {
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    // If user clicked reset, go back to full country view. Reset also closes
    // the active module, so the right sidebar is hidden.
    mapRef.current.easeTo({
      center: [8.1642, 46.7592],
      zoom: 7,
      duration: 1000,
      padding: computeMapPadding({
        isGraphExpanded: null,
        isSidebarOpen: false,
        isLeftSidebarOpen: !isLeftSidebarCollapsed,
      }),
    });
  }, [resetMapTrigger, mapReady]);
}
