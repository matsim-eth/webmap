import { useEffect, useRef } from 'react';
import { useData } from '../../context/DataContext';
import { computeMapPadding } from '../sidebar/sidebarLayout';
import { beginPaddingShift, endPaddingShift } from './_lib/paddingGate';

const PADDING_EASE_MS = 600;

// Mapbox stores padding as floats; treat sub-pixel differences as "already there".
const samePadding = (a, b) =>
  !!a && ['top', 'bottom', 'left', 'right'].every(k => Math.abs((a[k] ?? 0) - b[k]) < 0.5);

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

  const { zoneByName } = useData();
  // Latest zone bbox lookup, read inside the search-zoom effect without
  // adding it as a dep (which would re-trigger the zoom on study-area load).
  const zoneByNameRef = useRef(zoneByName);
  zoneByNameRef.current = zoneByName;

  // avoid changing padding when we select new canton
  const suppressPaddingRef = useRef(false);

  // avoid re-running search-zoom effect on every sidebar toggle —
  // use refs so fitBounds always reads the latest values without re-triggering
  const isLeftSidebarOpenRef = useRef(isLeftSidebarOpen);
  useEffect(() => { isLeftSidebarOpenRef.current = isLeftSidebarOpen; }, [isLeftSidebarOpen]);
  const isSidebarOpenRef = useRef(isSidebarOpen);
  useEffect(() => { isSidebarOpenRef.current = isSidebarOpen; }, [isSidebarOpen]);

  // Last `moveend` gate-closer, so it can be detached instead of lingering
  // armed after the shift it belonged to has already settled.
  const gateListenerRef = useRef(null);

  // 1) padding on sidebar resize
  useEffect(() => {

    if (!mapReady) return;
    if (suppressPaddingRef.current) return;
    const map = mapRef.current;
    if (!map) return;

    // Drop any listener left over from a previous shift — its shift is either
    // settled (the paddingGate id check would ignore it anyway) or superseded
    // by the one below.
    if (gateListenerRef.current) {
      map.off('moveend', gateListenerRef.current);
      gateListenerRef.current = null;
    }

    const padding = computeMapPadding({ isGraphExpanded, isSidebarOpen, isFeatureTableOpen, isLeftSidebarOpen });

    // Most module switches keep the same sidebar width (both 'expanded'), so
    // there is nothing to animate. Bail before opening the gate — otherwise
    // every such switch would make its data load wait out a no-op ease.
    if (samePadding(map.getPadding?.(), padding)) {
      endPaddingShift();
      return;
    }

    // Hold back the module's heavy load until the camera has finished moving:
    // the ease is rAF-driven, and a load that blocks the main thread starves it
    // and strands the map at a half-applied padding. See _lib/paddingGate.js.
    const shiftId = beginPaddingShift(PADDING_EASE_MS);
    const closeGate = () => {
      gateListenerRef.current = null;
      endPaddingShift(shiftId);
    };
    gateListenerRef.current = closeGate;
    map.easeTo({ padding, duration: PADDING_EASE_MS });
    map.once('moveend', closeGate);
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

    const bbox = zoneByNameRef.current?.get(searchCanton)?.bbox;
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
