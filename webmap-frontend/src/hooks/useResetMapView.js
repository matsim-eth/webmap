import { useEffect } from 'react';

/**
 * Hook to reset the map view when the resetMapTrigger changes.
 * Zooms back to the original Switzerland extent.
 */
export function useResetMapView({ mapRef, mapReady, resetMapTrigger, isLeftSidebarCollapsed }) {
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const leftPadding = isLeftSidebarCollapsed ? 50 : 185;

    // If user clicked reset, go back to full country view
    mapRef.current.easeTo({
      center: [8.1642, 46.7592],
      zoom: 7,
      duration: 1000,
      padding: { top: 50, bottom: 50, left: leftPadding, right: 50 },
    });
  }, [resetMapTrigger, mapReady]);
}
