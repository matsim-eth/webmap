import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

export default function useMapbox(accessToken) {
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const [mapReady, setMapReady] = useState(false);
  
  useEffect(() => {
    if (!mapRef.current && mapContainerRef.current) {
      mapboxgl.accessToken = accessToken;
      
      mapRef.current = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: 'mapbox://styles/mapbox/light-v10',
        center: [8.1642, 46.7592],
        zoom: 7,
      });
      
      mapRef.current.on('load', () => {
        setMapReady(true);
      });
    }
    
    return () => {
      // Optional: clean up only on full page unload
    };
  }, [accessToken]);
  
  return { mapRef, mapContainerRef, mapReady };
}
