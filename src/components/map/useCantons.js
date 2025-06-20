import { useEffect } from 'react';
import bboxCache from '../../utils/bboxCanton.json';

export default function useCantons({
  mapRef,
  dataURL,
  onCantonSelect,
  onHover,
}) {
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let mounted = true;

    fetch(`${dataURL}TLM_KANTONSGEBIET.geojson`)
      .then((r) => r.json())
      .then((geojson) => {
        if (!mounted) return;

        // ----- source
        map.addSource('cantons', { type: 'geojson', data: geojson });

        // ----- fill
        map.addLayer({
          id: 'canton-fill',
          type: 'fill',
          source: 'cantons',
          paint: { 'fill-color': '#A07CC5', 'fill-opacity': 0.15 },
        });

        // ----- all-borders
        map.addLayer({
          id: 'canton-borders',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#000', 'line-width': 1 },
        });

        // ----- selection border
        map.addLayer({
          id: 'selected-canton-border',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#f00', 'line-width': 2 },
          filter: ['==', 'NAME', ''], // nothing selected initially
        });

        // ----- hover outline
        map.addLayer({
          id: 'canton-highlight',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#fff', 'line-width': 3 },
          filter: ['==', 'NAME', ''],
        });

        // click → select
        const handleClick = (e) => {
          if (e.features.length > 0 && e.features[0].properties.NAME != map.getFilter("selected-canton-border")[2]) {
            
          const name = e.features[0].properties.NAME;

          map.setFilter('selected-canton-border', ['==', 'NAME', name]);

          // zoom to bbox
          const bbox = bboxCache[name];
          if (bbox) {
            map.fitBounds(bbox, {
              padding: 50,
              maxZoom: 10,
              duration: 800,
            });
          }
          onCantonSelect?.(name);
        }
        };

        // hover highlight (throttled with rAF)
        let rafId = null;
        const handleMove = (e) => {
          if (rafId) return;
          rafId = requestAnimationFrame(() => {
            const f = map.queryRenderedFeatures(e.point, { layers: ['canton-fill'] })[0];
            const name = f?.properties?.NAME || '';
            map.setFilter('canton-highlight', ['==', 'NAME', name]);
            onHover?.(name || null);
            rafId = null;
          });
        };
        const handleLeave = () => {
          map.setFilter('canton-highlight', ['==', 'NAME', '']);
          onHover?.(null);
        };

        map.on('click', 'canton-fill', handleClick);
        map.on('mousemove', 'canton-fill', handleMove);
        map.on('mouseleave', 'canton-fill', handleLeave);

        // clean-up on unmount
        return () => {
          map.off('click', 'canton-fill', handleClick);
          map.off('mousemove', 'canton-fill', handleMove);
          map.off('mouseleave', 'canton-fill', handleLeave);
        };
      });

    return () => {
      mounted = false;
    };
  }, [mapRef, dataURL, onCantonSelect, onHover]);
}