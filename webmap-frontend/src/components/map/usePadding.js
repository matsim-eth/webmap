import { useEffect, useRef, useState } from 'react';
import { useData } from '../../context/DataContext';
import { computeMapPadding, clampHorizontalPadding } from '../sidebar/sidebarLayout';
import { beginPaddingShift, endPaddingShift } from './_lib/paddingGate';

const PADDING_EASE_MS = 600;
const SEARCH_ZOOM_MS = 1000;

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

  // Avoid fighting the zoom-to-zone fitBounds with a padding ease: effect 2
  // suppresses effect 1 for the duration of that animation.
  //
  // This is *state*, not a ref, on purpose. As a ref, a module switch that
  // landed inside the ~1 s zoom window was dropped for good — effect 1 bailed,
  // and clearing the ref afterwards re-rendered nothing, so the new module's
  // padding was never applied and the map kept the previous module's. As state,
  // clearing it re-runs effect 1, which then applies whatever padding the
  // current sidebar state calls for (a no-op via `samePadding` when the zoom
  // already left the map correctly padded).
  const [paddingSuppressed, setPaddingSuppressed] = useState(false);

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
    if (paddingSuppressed) return;
    const map = mapRef.current;
    if (!map) return;

    // Drop any listener left over from a previous shift — its shift is either
    // settled (the paddingGate id check would ignore it anyway) or superseded
    // by the one below.
    if (gateListenerRef.current) {
      map.off('moveend', gateListenerRef.current);
      gateListenerRef.current = null;
    }

    // Clamped on the same basis as the zoom-to-zone fitBounds below, so the two
    // agree on narrow windows — otherwise every zone zoom would be followed by
    // an ease back to the unclamped value.
    const padding = clampHorizontalPadding(
      computeMapPadding({ isGraphExpanded, isSidebarOpen, isFeatureTableOpen, isLeftSidebarOpen }),
      map.getContainer?.()?.clientWidth,
    );

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
  }, [mapRef, mapReady, isSidebarOpen, isGraphExpanded, isFeatureTableOpen, isLeftSidebarOpen, paddingSuppressed]);

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

    // Resolve the bbox BEFORE suppressing padding. Suppressing first meant a
    // zone the study area carries no bbox for (or a name that isn't in
    // zoneByName) returned here with padding disabled for the rest of the
    // session — nothing but the `moveend` below ever cleared it.
    const bbox = zoneByNameRef.current?.get(searchCanton)?.bbox;
    if (!bbox) return;
    setClickedCanton(searchCanton);
    map.setFilter('selected-canton-border',['==','NAME',searchCanton]);

    // Clamp like useFeatureSelectionFocus does: mapbox's cameraForBounds
    // returns nothing when left+right padding exceeds the canvas (265 + 650 =
    // 915px with the sidebar expanded), and fitBounds then does nothing at all
    // — no camera move, no `moveend`, so the un-suppress below never runs.
    const padding = clampHorizontalPadding(
      // isFeatureTableOpen: false — the table was closed just above, so pad
      // for the sidebar width it is animating to, not the one it had.
      computeMapPadding({
        isGraphExpanded: graphExpandedRef.current,
        isSidebarOpen: isSidebarOpenRef.current,
        isFeatureTableOpen: false,
        isLeftSidebarOpen: isLeftSidebarOpenRef.current,
      }),
      map.getContainer?.()?.clientWidth,
    );

    setPaddingSuppressed(true);

    map.fitBounds(bbox, { padding, maxZoom: 10, duration: SEARCH_ZOOM_MS });

    // Registered after fitBounds: flyTo calls map.stop() first, which fires a
    // `moveend` for whatever animation it interrupted — listening earlier would
    // catch that one and un-suppress before this zoom has even started.
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      map.off('moveend', done);
      setPaddingSuppressed(false);
    };
    map.once('moveend', done);
    // Safety net for the cases where `moveend` never comes (fitBounds refusing
    // to move, or an interrupted/no-op camera change), so suppression can't
    // outlive the animation it belongs to.
    timer = setTimeout(done, SEARCH_ZOOM_MS + 300);
    return done;

  }, [mapRef, searchCanton, setClickedCanton, suppressNextSearchZoom, setIsFeatureTableOpen]);
}
