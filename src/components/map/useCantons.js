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
        
        // Show the red border only for the selected canton
        map.setFilter('selected-canton-border', ['==', 'NAME', cantonName]);
        
        
        if (isStopClick) {
          return; // if clicked on out of canton stop, dont zoom to it.
        }
        
        // Determine the right padding based on which graph is selected
        let rightPadding = 50; // Default for collapsed sidebar
        
        
        if (graphExpandedRef.current === "Graph 3" || graphExpandedRef.current === "Graph 4") {
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
          console.log('suppressing search zoom');
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
      