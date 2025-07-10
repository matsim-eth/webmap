import { useEffect, useRef } from 'react';
import bboxCache from '../../utils/bboxCanton.json';

export default function useCantons({
  mapRef,
  mapReady,
  dataURL,
  setClickedCanton,
  searchCanton,
  isSidebarOpen,
  isGraphExpanded,
  suppressNextSearchZoom
}) {
  const graphExpandedRef = useRef(isGraphExpanded);
  useEffect(() => { graphExpandedRef.current = isGraphExpanded }, [isGraphExpanded]);

  // 1) load cantons

    useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map || !dataURL) return;

    fetch(`${dataURL}TLM_KANTONSGEBIET.geojson`)
      .then(r => r.json())
      .then(geojson => {
        map.addSource('cantons', { type: 'geojson', data: geojson });
        map.addLayer({
          id: 'canton-fill',
          type: 'fill',
          source: 'cantons',
          paint: { 'fill-color': '#A07CC5','fill-opacity': 0.15 }
        });
        map.addLayer({
          id: 'canton-borders',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#000','line-width': 1 }
        });
        map.addLayer({
          id: 'selected-canton-border',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#F00','line-width': 2 },
          filter: ['==','NAME','']
        });
        map.addLayer({
          id: 'canton-highlight',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#FFF','line-width': 3 },
          filter: ['==','NAME','']
        });
      })
      .catch(err => console.error('Cantons load error', err));

    // cleanup on URL change / unmount
    return () => {
      const map = mapRef.current;
      if (!map) return;
      ['canton-highlight','selected-canton-border','canton-borders','canton-fill']
        .forEach(id => map.getLayer(id) && map.removeLayer(id));
      map.getSource('cantons') && map.removeSource('cantons');
    };
  }, [mapRef, mapReady, dataURL]);

  // click / hover
 useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;

    const handleClick = e => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['canton-fill'] });
      if (!features.length) return;

      // skip if clicking on inter-cantonal stops:
      const layers = [...new Set(features.map(f => f.layer.id))];
      if (layers.includes('inter-cantonal-stops')) return;

      const prev = map.getFilter('selected-canton-border')?.[2];
      const name = features[0].properties.NAME;
      if (name === prev) return;

      setClickedCanton(name);
      map.setFilter('selected-canton-border',['==','NAME',name]);

      // zoom only if it wasn't a “stop” click
      // compute right padding exactly as before:
      let right = 50;
      if (['Graph 3','Graph 4'].includes(graphExpandedRef.current)) right = 950;
      else if (['Graph 1','Graph 2','Graph 5','Graph 6','Graph 7','Graph 8','Graph 9','Volumes','Transit','Destination']
                .includes(graphExpandedRef.current)) right = 650;
      else if (isSidebarOpen) right = 350;

      map.fitBounds(bboxCache[name], {
        padding:{ top:50, bottom:50, left:50, right },
        maxZoom:10,
        duration:1000
      });
    };

    map.on('click','canton-fill', handleClick);
    return () => {
      map.off('click','canton-fill', handleClick);
    };
  }, [
    mapRef,
    mapReady,
    setClickedCanton,
    isSidebarOpen,
    isGraphExpanded,
    suppressNextSearchZoom
  ]);

  // 2) hover highlight
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;

    let frame = null;
    const move = e => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        const f = map.queryRenderedFeatures(e.point,{layers:['canton-fill']})[0];
        const name = f?.properties?.NAME || '';
        map.setFilter('canton-highlight',['==','NAME',name]);
        frame = null;
      });
    };
    const leave = () => map.setFilter('canton-highlight',['==','NAME','']);

    map.on('mousemove','canton-fill',move);
    map.on('mouseleave','canton-fill',leave);
    return () => {
      map.off('mousemove','canton-fill',move);
      map.off('mouseleave','canton-fill',leave);
    };
  }, [mapRef, mapReady]);

  // 3) sidebar padding on resize
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let right=50;
    if (isSidebarOpen) {
      if (['Graph 3','Graph 4'].includes(isGraphExpanded)) right=950;
      else if (['Graph 1','Graph 2','Graph 5','Graph 6','Graph 7','Graph 8','Graph 9','Volumes','Transit','Destination']
                .includes(isGraphExpanded)) right=650;
      else right=350;
    }
    map.easeTo({ padding:{top:50,bottom:50,left:50,right}, duration:600 });
  }, [mapRef, isSidebarOpen, isGraphExpanded]);

  // 4) search‐based zoom
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !searchCanton) return;

    if (suppressNextSearchZoom.current) {
      suppressNextSearchZoom.current = false;
      return;
    }

    const bbox = bboxCache[searchCanton];
    if (!bbox) return;
    setClickedCanton(searchCanton);
    map.setFilter('selected-canton-border',['==','NAME',searchCanton]);

    let right=50;
    if (isSidebarOpen) {
      if (['Graph 3','Graph 4'].includes(graphExpandedRef.current)) right=950;
      else if (['Graph 1','Graph 2','Graph 5','Graph 6','Graph 7','Graph 8','Graph 9','Volumes','Transit','Destination']
                .includes(graphExpandedRef.current)) right=650;
      else right=350;
    }

    map.fitBounds(bbox, {
      padding:{top:50,bottom:50,left:50,right},
      maxZoom:10,
      duration:1000
    });
  }, [mapRef, searchCanton, isSidebarOpen, setClickedCanton, suppressNextSearchZoom]);
}
