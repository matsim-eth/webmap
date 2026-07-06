import { useEffect, useRef } from 'react';
import bboxCache from '../../utils/bboxCanton.json';
import { computeMapPadding } from '../sidebar/sidebarLayout';

export default function usePadding({
  mapRef,
  mapReady,
  setClickedCanton,
  searchCanton,
  isSidebarOpen,
  isGraphExpanded,
  suppressNextSearchZoom,
  graphExpandedRef,
  isFeatureTableOpen,
  setIsFeatureTableOpen,
  isLeftSidebarOpen
}) {

  // avoid changing padding when we select new canton
  const suppressPaddingRef = useRef(false);

  // avoid re-running search-zoom effect on every sidebar toggle —
  // use refs so fitBounds always reads the latest values without re-triggering
  const isLeftSidebarOpenRef = useRef(isLeftSidebarOpen);
  useEffect(() => { isLeftSidebarOpenRef.current = isLeftSidebarOpen; }, [isLeftSidebarOpen]);
  const isSidebarOpenRef = useRef(isSidebarOpen);
  useEffect(() => { isSidebarOpenRef.current = isSidebarOpen; }, [isSidebarOpen]);

  // 1) padding on sidebar resize
  useEffect(() => {

    if (!mapReady) return;
    if (suppressPaddingRef.current) return;
    const map = mapRef.current;
    if (!map) return;

    map.easeTo({
      padding: computeMapPadding({ isGraphExpanded, isSidebarOpen, isFeatureTableOpen, isLeftSidebarOpen }),
      duration: 600,
    });
  }, [mapRef, mapReady, isSidebarOpen, isGraphExpanded, isFeatureTableOpen, isLeftSidebarOpen]);

  // 2) zoom to canton on search (with correct padding)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !searchCanton) return;

    // if we suppress next zoom, dont do anything
    if (suppressNextSearchZoom.current) {
      console.log('suppressing search zoom');

      // note we reset supressnextSearchZoom in useTransitStops after we apply the opacity filter to stops
      // not corresponding to the currently selected transit line
      return;
    }

    setIsFeatureTableOpen(false);
    suppressPaddingRef.current = true

    const bbox = bboxCache[searchCanton];
    if (!bbox) return;
    setClickedCanton(searchCanton);
    map.setFilter('selected-canton-border',['==','NAME',searchCanton]);

    map.fitBounds(bbox, {
      // isFeatureTableOpen: false — the table was closed just above, so pad
      // for the sidebar width it is animating to, not the one it had.
      padding: computeMapPadding({
        isGraphExpanded: graphExpandedRef.current,
        isSidebarOpen: isSidebarOpenRef.current,
        isFeatureTableOpen: false,
        isLeftSidebarOpen: isLeftSidebarOpenRef.current,
      }),
      maxZoom: 10,
      duration: 1000,
    });

    map.once('moveend', () => {                  // re-enable after animation
      suppressPaddingRef.current = false;
    });

  }, [mapRef, searchCanton, setClickedCanton, suppressNextSearchZoom]);
}
