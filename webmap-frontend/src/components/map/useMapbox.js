import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

export default function useMapbox(accessToken, initialPadding = null) {

  // define map references
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);

  // indicates when map is ready to be used
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    if (!mapRef.current && mapContainerRef.current) {
      mapboxgl.accessToken = accessToken;

      // initialize the map
      mapRef.current = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/light-v10',
        center: [8.1642, 46.7592],
        zoom: 7,
      });

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
  
  return { mapRef, mapContainerRef, mapReady };
}
