import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { SWISS_STUDY_AREA } from '../../utils/swissDefaults';

export default function useMapbox(accessToken, initialPadding = null, initialView = null) {

  // define map references
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);

  // indicates when map is ready to be used
  const [mapReady, setMapReady] = useState(false);

  // Study-area extent (center/zoom). Defaults to the Swiss literals — the
  // exact values that used to be hardcoded here ([8.1642, 46.7592] / 7) — so
  // behaviour is identical when no study area is served.
  const center = initialView?.center || SWISS_STUDY_AREA.center;
  const zoom = initialView?.zoom ?? SWISS_STUDY_AREA.zoom;

  // View the map was actually constructed with (see the follow effect below).
  const prevViewRef = useRef(null);

  useEffect(() => {
    if (!mapRef.current && mapContainerRef.current) {
      mapboxgl.accessToken = accessToken;

      // initialize the map
      mapRef.current = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/light-v10',
        center,
        zoom,
      });
      prevViewRef.current = `${center[0]},${center[1]},${zoom}`;

      // Bake the sidebar-compensated padding in before the first frame paints,
      // so the initial view is already centred in the visible map area and
      // usePadding's first easeTo is a visual no-op instead of an on-load pan.
      if (initialPadding) {
        mapRef.current.setPadding(initialPadding);
      }

      mapRef.current.on('load', () => {
        setMapReady(true);
      });
    }
  }, [accessToken]);

  // The map is constructed once (above) with whatever view is known at mount —
  // the Swiss default while study_area.json is still loading. When the study
  // area resolves to a DIFFERENT extent (non-Swiss dataset, or a dataset
  // switch), ease over to it. For Swiss datasets the resolved values equal the
  // construction literals, so this never fires and the initial view is
  // pixel-identical to the pre-generalization behaviour.
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const key = `${center[0]},${center[1]},${zoom}`;
    if (prevViewRef.current === key) return;
    prevViewRef.current = key;
    mapRef.current.easeTo({ center, zoom, duration: 1000 });
  }, [mapReady, center, zoom]);

  return { mapRef, mapContainerRef, mapReady };
}
