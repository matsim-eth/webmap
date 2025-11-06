import { useEffect, useRef } from 'react';
import bboxCache from '../../utils/bboxCanton.json';

export default function useCantons({
  mapRef,
  setClickedCanton,
  searchCanton,
  isSidebarOpen,
  isGraphExpanded,
  suppressNextSearchZoom,
  graphExpandedRef,
  isFeatureTableOpen,
  setIsFeatureTableOpen
}) {
  
  // avoid changing padding when we select new canton 
  const suppressPaddingRef = useRef(false);
  
  // 1) padding on sidebar resize
  useEffect(() => {
    
    if (suppressPaddingRef.current) return;  
    const map = mapRef.current;
    if (!map) return;
    
    let rightPadding = 50;
    
    if (isSidebarOpen) {
      const wideGraphs = ['Graph 3', 'Graph 4'];
      const mediumGraphs = [
        'Graph 1', 'Graph 2', 'Graph 5', 'Graph 6', 'Graph 7', 
        'Graph 8', 'Graph 9', 'Transit', 'Destination'
      ];
      
      if (wideGraphs.includes(isGraphExpanded)) {
        rightPadding = 950;
      } else if (isGraphExpanded === 'Volumes' || isGraphExpanded === 'TransitVolumes') {
        // Volumes/TransitVolumes modules: 950px when table open, 650px otherwise
        rightPadding = isFeatureTableOpen ? 950 : 650;
      } else if (mediumGraphs.includes(isGraphExpanded)) {
        rightPadding = 650;
      } else {
        // Default (Network/Choropleth): 950px when table open, 350px otherwise
        if(isFeatureTableOpen) {
          rightPadding = 950;
        } else {
          rightPadding = 350;
        }
      }
    }
    
    map.easeTo({
      padding: { top: 50, bottom: 50, left: 50, right: rightPadding },
      duration: 600,
    });
  }, [mapRef, isSidebarOpen, isGraphExpanded, isFeatureTableOpen]);
  
  // 2) zoom to canton on search (with correct padding)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !searchCanton) return;
    
    // if we suppress next zoom, dont do anything
    if (suppressNextSearchZoom.current) {
      console.log('suppressing search zoom');
      
      // note we reset supressnextSearchZoom in useTransitStops after we apply the opacity filter to stops
      // not corresponding to the currently selected transit line
      return;
    }
    
    setIsFeatureTableOpen(false);
    suppressPaddingRef.current = true
    
    const bbox = bboxCache[searchCanton];
    if (!bbox) return;
    setClickedCanton(searchCanton);
    map.setFilter('selected-canton-border',['==','NAME',searchCanton]);
    
    // Determine right padding based on sidebar and graph
    let rightPadding = 50;
    
    if (isSidebarOpen) {
      const wideGraphs = ['Graph 3', 'Graph 4'];
      const mediumGraphs = [
        'Graph 1', 'Graph 2', 'Graph 5', 'Graph 6', 'Graph 7',
        'Graph 8', 'Graph 9', 'Volumes', 'Transit', 'TransitVolumes', 'Destination'
      ];
      
      if (wideGraphs.includes(graphExpandedRef.current)) {
        rightPadding = 950;
      } else if (mediumGraphs.includes(graphExpandedRef.current)) {
        rightPadding = 650;
      } else {
        rightPadding = 350;
      }
    }
    
    map.fitBounds(bbox, {
      padding: { top: 50, bottom: 50, left: 50, right: rightPadding },
      maxZoom: 10,
      duration: 1000,
    });
    
    map.once('moveend', () => {                  // re-enable after animation
      suppressPaddingRef.current = false;
    });
    
  }, [mapRef, searchCanton, setClickedCanton, suppressNextSearchZoom]);
}
