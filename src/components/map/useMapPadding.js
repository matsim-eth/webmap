import { useEffect } from 'react';

/**
* Keeps map view centred when sidebar opens / resizes.
*/
export default function useMapPadding({
  mapRef,
  isSidebarOpen,
  isGraphExpanded,
  searchCanton,
}) {
  
  const graphExpandedRef = useRef(isGraphExpanded);

  useEffect(() => {
    if (mapRef.current) {
      const map = mapRef.current;
      
      // Determine the right padding based on which graph is selected
      let rightPadding = 50; // Default for collapsed sidebar
      
      if (isSidebarOpen) {
        // Widest width
        if (isGraphExpanded === "Graph 3" 
          || isGraphExpanded === "Graph 4") {
            rightPadding = 950; // Adjust for 900px width
            // Middle width
          } else if (isGraphExpanded === "Graph 1" 
            || isGraphExpanded === "Graph 2" 
            || isGraphExpanded === "Graph 5" 
            || isGraphExpanded === "Graph 6" 
            || isGraphExpanded === "Graph 7" 
            || isGraphExpanded === "Graph 8" 
            || isGraphExpanded === "Graph 9" 
            || isGraphExpanded === "Volumes" 
            || isGraphExpanded === "Transit" 
            || isGraphExpanded === "Destination"
          ) {
            rightPadding = 650; // Adjust for 600px width
          } else {
            // Smallest width
            rightPadding = 350;
          }
        }
        
        // Smoothly adjust padding when sidebar changes
        map.easeTo({
          padding: { top: 50, bottom: 50, left: 50, right: rightPadding },
          duration: 600,
        });
      }
    }, [isSidebarOpen, isGraphExpanded]); // Re-run when sidebar size changes
    
    // handle search-based zooming
    useEffect(() => {
      if (searchCanton && mapRef.current && bboxCache[searchCanton]) {
        
        if (suppressNextSearchZoom.current) {
          console.log("Skipping zoom due to suppressNextSearchZoom");
          suppressNextSearchZoom.current = false; // reset after skip
          return;
        }
        
        const map = mapRef.current;
        const cantonBbox = bboxCache[searchCanton]; // fetch bbox
        
        // Determine the correct right padding
        let rightPadding = 50; // Default for collapsed sidebar
        if (isSidebarOpen) {
          if (isGraphExpanded === "Graph 3" 
            || isGraphExpanded === "Graph 4") {
              rightPadding = 950; // Adjust for 900px width
            } else if (isGraphExpanded === "Graph 1" 
              || isGraphExpanded === "Graph 2"
              || isGraphExpanded === "Graph 5" 
              || isGraphExpanded === "Graph 6" 
              || isGraphExpanded === "Graph 7" 
              || isGraphExpanded === "Graph 8" 
              || isGraphExpanded === "Graph 9" 
              || isGraphExpanded === "Volumes" 
              || isGraphExpanded === "Transit" 
              || isGraphExpanded === "Destination"
            ) {
              rightPadding = 650; // Adjust for 600px width
            } else {
              rightPadding = 350; // Default open sidebar
            }
          }
          
          map.fitBounds(cantonBbox, {
            padding: { top: 50, bottom: 50, left: 50, right: rightPadding },
            maxZoom: 10,
            duration: 1000,
          });
          
          setClickedCanton(searchCanton);
          
          map.setFilter("selected-canton-border", ["==", "NAME", searchCanton]);
          
          if (graphExpandedRef.current === "Network" || graphExpandedRef.current === "Volumes") {
            loadNetworkForCanton(searchCanton);
          } else {
            // Remove network-related layers and sources
            if (map.getLayer("network-layer")) {
              map.removeLayer("network-layer");
              map.removeLayer("click-network-layer");
              map.removeSource("network-source");
            }
            if (map.getLayer("ant-line")) {
              map.removeLayer("ant-line");
              map.removeSource("ant-path")
            }
            ["network-highlight"].forEach(id => {
              if (map.getLayer(id)) map.removeLayer(id);
              if (map.getSource(id)) map.removeSource(id);
            });
            
            if (graphExpandedRef.current === "Transit") {
              if (map.getLayer("transit-highlight-layer")) map.removeLayer("transit-highlight-layer");
              if (map.getSource("transit-highlight")) map.removeSource("transit-highlight");
              
              setSelectedTransitStop(null);
            }
          }
        }
      }, [searchCanton]); // only update when searchCanton updates
      
    }
    