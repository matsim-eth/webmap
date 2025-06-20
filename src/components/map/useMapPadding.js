import { useEffect } from 'react';

/**
 * Keeps map view centred when sidebar opens / resizes.
 */
export default function useMapPadding({
  mapRef,
  isSidebarOpen,
  isGraphExpanded,
}) {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let right = 50;
    if (isSidebarOpen) {
      if (['Graph 3', 'Graph 4'].includes(isGraphExpanded)) right = 950;
      else if (['Graph 1', 'Graph 2', 'Volumes', 'Transit'].includes(isGraphExpanded))
        right = 650;
      else right = 350;
    }

    map.easeTo({
      padding: { top: 50, bottom: 50, left: 50, right },
      duration: 600,
    });
  }, [isSidebarOpen, isGraphExpanded, mapRef]);
}
