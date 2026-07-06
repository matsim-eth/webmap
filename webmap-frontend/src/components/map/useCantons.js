import { useEffect, useRef } from 'react';
import bboxCache from '../../utils/bboxCanton.json';
import { computeMapPadding } from '../sidebar/sidebarLayout';

export default function useCantons({
  mapRef,
  mapReady,
  setClickedCanton,
  searchCanton,
  isGraphExpanded,
  suppressNextSearchZoom,
  graphExpandedRef,
  setIsFeatureTableOpen,
  isSidebarOpen,
  isLeftSidebarOpen,
  drawRef
}) {

  // 1) load cantons + add layers
  useEffect(() => {
    if (!mapReady) return; // only run when map is ready
    const map = mapRef.current;
    if (!map) return;

    // canton geojson will always stay same, no need to load from loadWithFallback / dataURL
    const abort = new AbortController();
    fetch(`https://matsim-eth.github.io/webmap/data/TLM_KANTONSGEBIET.geojson`, { signal: abort.signal })
      .then(r => r.json())
      .then(geojson => {
        // Effect may have re-run (or the map been torn down) while the fetch
        // was in flight — adding the source twice throws.
        if (map.getSource('cantons')) return;

        // add mapbox canton source
        map.addSource('cantons', { type: 'geojson', data: geojson });

        // canton fill
        map.addLayer({
          id: 'canton-fill',
          type: 'fill',
          source: 'cantons',
          paint: { 'fill-color': '#6366f1', 'fill-opacity': 0.05 }
        });

        // canton border
        map.addLayer({
          id: 'canton-borders',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#6366f1', 'line-width': 1 }
        });

        // selected canton border
        map.addLayer({
          id: 'selected-canton-border',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#4f46e5', 'line-width': 2 },
          filter: ['==', 'NAME', '']
        });

        // canton highlight on hover
        map.addLayer({
          id: 'canton-highlight',
          type: 'line',
          source: 'cantons',
          paint: { 'line-color': '#FFF', 'line-width': 3 },
          filter: ['==', 'NAME', '']
        });
      })
      .catch(err => {
        if (err?.name !== 'AbortError') console.error('Cantons load error', err);
      });
    return () => abort.abort();
  }, [mapRef, mapReady]);

  // avoid re-running click handler effect on every sidebar toggle —
  // use refs so handleMapClick always reads the latest values
  const isLeftSidebarOpenRef = useRef(isLeftSidebarOpen);
  useEffect(() => { isLeftSidebarOpenRef.current = isLeftSidebarOpen; }, [isLeftSidebarOpen]);
  const isSidebarOpenRef = useRef(isSidebarOpen);
  useEffect(() => { isSidebarOpenRef.current = isSidebarOpen; }, [isSidebarOpen]);

  // 2) zoom to canton on click on layer (with correct padding)
  useEffect(() => {
    if (!mapReady) return; // only run when map is ready
    const map = mapRef.current;
    if (!map) return;


    const handleMapClick = (e) => {
      // Skip canton selection when interacting with draw features
      // (drawing, selecting, adjusting vertices, or clicking on drawn polygons)
      if (drawRef?.current) {
        const drawMode = drawRef.current.getMode();
        if (drawMode !== 'simple_select' || drawRef.current.getSelected().features.length > 0) return;
        const clickedLayers = map.queryRenderedFeatures(e.point).map(f => f.layer.id);
        if (clickedLayers.some(id => id.startsWith('gl-draw'))) return;
      }

      const clickedFeatures = map.queryRenderedFeatures(e.point);
      const clickedLayerIds = [...new Set(clickedFeatures.map(f => f.layer.id))];
      const isStopClick = clickedLayerIds.includes("inter-cantonal-stops");

      // Clicks landing on a destination-zone arc or dot are owned by the
      // destination module (toggle selection); they must not switch the hub.
      const DESTINATION_LAYERS = ['destination-arrows-line', 'destination-arrows-selected', 'destination-dots'];
      if (DESTINATION_LAYERS.some(id => clickedLayerIds.includes(id))) return;

      // If select same as previous canton, don't do anything
      // (we extract prev canton by getting the current selected-canton-border)
      if (e.features.length > 0 && e.features[0].properties.NAME != map.getFilter("selected-canton-border")[2]) {

        setIsFeatureTableOpen(false);

        const cantonName = e.features[0].properties.NAME;
        const cantonBbox = bboxCache[cantonName];

        setClickedCanton(cantonName);

        // Highlight the selected canton
        map.setFilter('selected-canton-border', ['==', 'NAME', cantonName]);


        if (isStopClick) {
          return; // if clicked on out of canton stop, dont zoom to it.
        }

        map.fitBounds(cantonBbox, {
          // isFeatureTableOpen: false — the table was closed just above, so
          // pad for the sidebar width it is animating to.
          padding: computeMapPadding({
            isGraphExpanded: graphExpandedRef.current,
            isSidebarOpen: isSidebarOpenRef.current,
            isFeatureTableOpen: false,
            isLeftSidebarOpen: isLeftSidebarOpenRef.current,
          }),
          maxZoom: 10,
          duration: 1000
        });
      }
    };

    map.on('click', 'canton-fill', handleMapClick);
    return () => {
      map.off('click', 'canton-fill', handleMapClick);
    };
  }, [
    mapRef,
    mapReady,
    setClickedCanton,
    isGraphExpanded,
    suppressNextSearchZoom
  ]);

  // 3) hover highlight
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;

    let frame = null;
    const move = e => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        const f = map.queryRenderedFeatures(e.point, { layers: ['canton-fill'] })[0];
        const name = f?.properties?.NAME || '';
        map.setFilter('canton-highlight', ['==', 'NAME', name]);
        frame = null;
      });
    };
    const leave = () => map.setFilter('canton-highlight', ['==', 'NAME', '']);

    map.on('mousemove', 'canton-fill', move);
    map.on('mouseleave', 'canton-fill', leave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      map.off('mousemove', 'canton-fill', move);
      map.off('mouseleave', 'canton-fill', leave);
    };
  }, [mapRef, mapReady]);

  // 4) Reset selected canton border if searchCanton is cleared
  useEffect(() => {
    const map = mapRef.current;
    if (!map || searchCanton !== null) return;

    if (map.getLayer("selected-canton-border")) {
      map.setFilter("selected-canton-border", ["==", "NAME", ""]);
    }
  }, [searchCanton, mapRef]);
}
