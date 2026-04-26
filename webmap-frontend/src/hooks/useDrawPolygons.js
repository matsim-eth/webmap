import { useState, useEffect } from 'react';

/**
 * Reactive accessor for the current set of MapboxDraw polygon features.
 * Listens to draw.create/update/delete and exposes the polygons array as
 * state, so consumers can run point-in-polygon checks that re-render
 * automatically when the user edits the drawing.
 */
export default function useDrawPolygons({ mapRef, drawRef, isGraphExpanded, activeModule }) {
  const [polygons, setPolygons] = useState([]);

  // effect:audited — imperative mapbox draw event listeners; mirrors useLinePolygon lifecycle
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || isGraphExpanded !== activeModule) {
      setPolygons([]);
      return;
    }

    const update = () => {
      const draw = drawRef?.current;
      const list = draw?.getAll?.()?.features || [];
      setPolygons(list);
    };

    map.on('draw.create', update);
    map.on('draw.update', update);
    map.on('draw.delete', update);
    update();

    return () => {
      map.off('draw.create', update);
      map.off('draw.update', update);
      map.off('draw.delete', update);
    };
  }, [mapRef, drawRef, isGraphExpanded, activeModule]);

  return polygons;
}
