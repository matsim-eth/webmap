import { useEffect, useRef } from 'react';
import bboxCache from '../../utils/bboxCanton.json';

export default function useCantons({
  mapRef,
  mapReady,
  setClickedCanton,
  searchCanton,
  isGraphExpanded,
  suppressNextSearchZoom,
  graphExpandedRef,
  setIsFeatureTableOpen
}) {
  
  // 1) load cantons + add layers
  useEffect(() => {
    if (!mapReady) return; // only run when map is ready
    const map = mapRef.current;
    if (!map) return;
    
    // canton geojson will always stay same, no need to load from loadWithFallback / dataURL
    fetch(`https://matsim-eth.github.io/webmap/data/TLM_KANTONSGEBIET.geojson`)
    .then(r => r.json())
    .then(geojson => {
      
      // add mapbox canton source
      map.addSource('cantons', { type: 'geojson', data: geojson });
      
      // canton fill
      map.addLayer({
        id: 'canton-fill',
        type: 'fill',
        source: 'cantons',
        paint: { 'fill-color': '#A07CC5','fill-opacity': 0.15 }
      });
      
      // canton border
      map.addLayer({
        id: 'canton-borders',
        type: 'line',
        source: 'cantons',
        paint: { 'line-color': '#000','line-width': 1 }
      });
      
      // selected canton border
      map.addLayer({
        id: 'selected-canton-border',
        type: 'line',
        source: 'cantons',
        paint: { 'line-color': '#F00','line-width': 2 },
        filter: ['==','NAME','']
      });
      
      // canton highlight on hover
      map.addLayer({
        id: 'canton-highlight',
        type: 'line',
        source: 'cantons',
        paint: { 'line-color': '#FFF','line-width': 3 },
        filter: ['==','NAME','']
      });
    })
    .catch(err => console.error('Cantons load error', err));
  }, [mapRef, mapReady]);
  
  // 2) zoom to canton on click on layer (with correct padding)
  useEffect(() => {
    if (!mapReady) return; // only run when map is ready
    const map = mapRef.current;
    if (!map) return;

    
    const handleMapClick = (e) => {
      
      const clickedFeatures = map.queryRenderedFeatures(e.point);
      const clickedLayerIds = [...new Set(clickedFeatures.map(f => f.layer.id))];
      const isStopClick = clickedLayerIds.includes("inter-cantonal-stops");
      
      // If select same as previous canton, don't do anything
      // (we extract prev canton by getting the current selected-canton-border)
      if (e.features.length > 0 && e.features[0].properties.NAME != map.getFilter("selected-canton-border")[2]) {
        
        const cantonName = e.features[0].properties.NAME;
        const cantonBbox = bboxCache[cantonName];
        
        setClickedCanton(cantonName);
        setIsFeatureTableOpen(false);
        
        // Show the red border only for the selected canton
        map.setFilter('selected-canton-border', ['==', 'NAME', cantonName]);
        
        
        if (isStopClick) {
          return; // if clicked on out of canton stop, dont zoom to it.
        }
        
        // Determine the right padding based on which graph is selected
        let rightPadding = 50; // Default for collapsed sidebar
        
        
        if (graphExpandedRef.current === "Graph 3" || graphExpandedRef.current === "Graph 4"
        ) {
          rightPadding = 950; // Adjust for 900px width
        } else if (
          graphExpandedRef.current === "Graph 1" 
          || graphExpandedRef.current === "Graph 2" 
          || graphExpandedRef.current === "Graph 5" 
          || graphExpandedRef.current === "Graph 6" 
          || graphExpandedRef.current === "Graph 7" 
          || graphExpandedRef.current === "Graph 8"
          || graphExpandedRef.current === "Graph 9"
          || graphExpandedRef.current === "Volumes" 
          || graphExpandedRef.current === "Transit" 
          || graphExpandedRef.current === "Destination") {
            rightPadding = 650; // Adjust for 600px width
          } else {
            rightPadding = 350; // Default open sidebar
          }
          
          map.fitBounds(cantonBbox, {
            padding: { top: 50, bottom: 50, left: 50, right: rightPadding },
            maxZoom: 10,
            duration: 1000
          });
        }
      };
      
      map.on('click','canton-fill', handleMapClick);
      return () => {
        map.off('click','canton-fill', handleMapClick);
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
    
    // 4) Reset selected canton border if searchCanton is cleared
    useEffect(() => {
      const map = mapRef.current;
      if (!map || searchCanton !== null) return;
      
      if (map.getLayer("selected-canton-border")) {
        map.setFilter("selected-canton-border", ["==", "NAME", ""]);
      }
    }, [searchCanton, mapRef]);
  }
  