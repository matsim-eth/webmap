import { useEffect, useRef } from 'react';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

export default function useDrawTools({ mapRef, mapReady, isGraphExpanded, contextDrawRef }) {
  const drawRef = useRef(null);

  // Add/remove draw control when Draw module is toggled
  // effect:audited — imperative mapbox control lifecycle tied to module state
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const drawModules = ['Transit', 'Volumes', 'TransitVolumes', 'LinkSpeeds', 'PolygonTrips'];
    if (drawModules.includes(isGraphExpanded)) {
      if (!drawRef.current) {
        const draw = new MapboxDraw({
          displayControlsDefault: false,
          controls: {},
          defaultMode: 'simple_select',
        });
        map.addControl(draw, 'top-right');
        drawRef.current = draw;
        if (contextDrawRef) contextDrawRef.current = draw;
      }
    } else {
      if (drawRef.current) {
        map.removeControl(drawRef.current);
        drawRef.current = null;
        if (contextDrawRef) contextDrawRef.current = null;
      }
    }

    return () => {
      if (drawRef.current && map) {
        try { map.removeControl(drawRef.current); } catch { /* already removed */ }
        drawRef.current = null;
        if (contextDrawRef) contextDrawRef.current = null;
      }
    };
  }, [mapRef, mapReady, isGraphExpanded, contextDrawRef]);

  return drawRef;
}
