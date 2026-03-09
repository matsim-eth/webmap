import React, { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useDashboard } from '../../context/DashboardContext';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';

// Canton bounding boxes for zooming
const CANTON_BOUNDS = {
  "All": [[5.9, 45.8], [10.5, 47.8]],
  "Zurich": [[8.35, 47.15], [8.99, 47.7]],
  "Bern": [[6.85, 46.32], [8.46, 47.35]],
  "Geneve": [[5.95, 46.12], [6.32, 46.37]],
  "Vaud": [[6.07, 46.2], [7.24, 46.98]],
  "Aargau": [[7.71, 47.13], [8.46, 47.62]],
  "StGallen": [[8.79, 46.87], [9.68, 47.53]],
  "Luzern": [[7.83, 46.76], [8.52, 47.27]],
  "Ticino": [[8.38, 45.82], [9.17, 46.64]],
  "Valais": [[6.77, 45.85], [8.48, 46.66]],
  "Basel-Stadt": [[7.55, 47.51], [7.68, 47.6]],
  "Basel-Landschaft": [[7.32, 47.33], [7.97, 47.57]],
  "Fribourg": [[6.74, 46.44], [7.39, 47.01]],
  "Solothurn": [[7.34, 47.07], [7.95, 47.5]],
  "Graubunden": [[8.65, 46.17], [10.49, 47.07]],
  "Thurgau": [[8.63, 47.37], [9.47, 47.7]],
  "Schaffhausen": [[8.4, 47.65], [8.87, 47.8]],
  "Neuchatel": [[6.44, 46.82], [7.07, 47.14]],
  "Schwyz": [[8.42, 46.88], [9.0, 47.23]],
  "Zug": [[8.4, 47.05], [8.65, 47.27]],
  "Glarus": [[8.76, 46.79], [9.23, 47.17]],
  "Jura": [[6.84, 47.14], [7.56, 47.51]],
  "Nidwalden": [[8.2, 46.77], [8.57, 47.0]],
  "Obwalden": [[8.02, 46.72], [8.42, 47.0]],
  "Uri": [[8.38, 46.41], [8.93, 46.99]],
  "AppenzellAusserrhoden": [[9.19, 47.25], [9.61, 47.48]],
  "AppenzellInnerrhoden": [[9.35, 47.24], [9.51, 47.5]],
};

const CantonMap = ({ sidebarCollapsed, isExpanded = false, activeTab }) => {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const markerRef = useRef(null);
  const activeTabRef = useRef(activeTab); // Track current activeTab for map handlers
  const { selectedCanton, setSelectedCanton, selectedTransitStop, setSelectedTransitStop, setSelectedTransitLine } = useDashboard();
  const initialCantonRef = useRef(selectedCanton); // Store initial canton on mount
  const loadWithFallback = useLoadWithFallback();

  // Update activeTab ref and toggle map interactions when it changes
  useEffect(() => {
    activeTabRef.current = activeTab;
    if (!map.current) return;

    if (activeTab === 'transit-stops') {
      map.current.dragPan.enable();
      map.current.scrollZoom.enable();
    } else {
      map.current.dragPan.disable();
      map.current.scrollZoom.disable();
    }
  }, [activeTab]);

  // Trigger map resize when sidebar collapses/expands
  useEffect(() => {
    if (!map.current) return;
    const timer = setTimeout(() => {
      map.current.resize();
    }, 100);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  // Trigger map resize when container size changes (e.g., switching between tabs with different layouts)
  useEffect(() => {
    if (!map.current || !mapContainer.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (map.current && map.current.isStyleLoaded()) {
        map.current.resize();
        
        // Don't refit bounds on transit stops page
        if (activeTab === 'transit-stops') {
          return;
        }
        
        // Re-fit bounds after resize to adjust padding for new container size
        const bounds = CANTON_BOUNDS[selectedCanton] || CANTON_BOUNDS["All"];
        map.current.fitBounds(bounds, {
          padding: isExpanded ? 50 : 20,
          duration: 300
        });
      }
    });

    resizeObserver.observe(mapContainer.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [selectedCanton, activeTab, isExpanded]);

  useEffect(() => {
    if (map.current) return; // Initialize map only once

    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [8.2275, 46.8182], // Switzerland center
      zoom: 5.5, // Zoomed out to fit all of Switzerland
      attributionControl: false,
      preserveDrawingBuffer: true, // Required for html2canvas export
      dragPan: false, // disable all map interactions by default
      scrollZoom: false,
      boxZoom: false,
      dragRotate: false,
      keyboard: false,
      doubleClickZoom: false,
      touchZoomRotate: false,
    });

    map.current.on('load', () => {
      // Enable map interactions if already on transit-stops page at mount time
      if (activeTabRef.current === 'transit-stops') {
        map.current.dragPan.enable();
        map.current.scrollZoom.enable();
      }

      // Add canton boundaries source
      map.current.addSource('cantons', {
        type: 'geojson',
        data: 'https://matsim-eth.github.io/webmap/data/TLM_KANTONSGEBIET.geojson'
      });

      // Canton fill layer
      map.current.addLayer({
        id: 'canton-fills',
        type: 'fill',
        source: 'cantons',
        paint: {
          'fill-color': '#6366f1',
          'fill-opacity': 0.1
        }
      });

      // Canton border layer
      map.current.addLayer({
        id: 'canton-borders',
        type: 'line',
        source: 'cantons',
        paint: {
          'line-color': '#6366f1',
          'line-width': 1
        }
      });

      // Highlighted canton layer
      map.current.addLayer({
        id: 'canton-highlight',
        type: 'fill',
        source: 'cantons',
        paint: {
          'fill-color': '#6366f1',
          'fill-opacity': 0.4
        },
        filter: ['==', 'NAME', '']
      });

      // Apply initial canton selection if one was already selected
      const initCanton = initialCantonRef.current;
      if (initCanton && initCanton !== "All" && activeTab !== 'transit-stops') {
        const bounds = CANTON_BOUNDS[initCanton] || CANTON_BOUNDS["All"];
        map.current.fitBounds(bounds, {
          padding: isExpanded ? 50 : 20,
          duration: 0
        });
        map.current.setFilter('canton-highlight', ['==', 'NAME', initCanton]);
      } else if (initCanton && initCanton !== "All") {
        // Still highlight the canton, just don't zoom
        map.current.setFilter('canton-highlight', ['==', 'NAME', initCanton]);
      }

      // Add click handler for canton selection
      map.current.on('click', 'canton-fills', (e) => {
        if (e.features && e.features.length > 0) {
          const cantonName = e.features[0].properties.NAME;
          if (cantonName && CANTON_BOUNDS[cantonName]) {
            setSelectedCanton(cantonName);
          }
        }
      });

      // Add double-click handler to reset to "All"
      map.current.on('dblclick', () => {
        setSelectedCanton('All');
        // Don't zoom on transit-stops page
        if (activeTabRef.current !== 'transit-stops') {
          map.current.fitBounds(CANTON_BOUNDS['All'], {
            padding: isExpanded ? 50 : 20,
            duration: 500
          });
        }
      });

      // Change cursor on hover
      map.current.on('mouseenter', 'canton-fills', () => {
        map.current.getCanvas().style.cursor = 'pointer';
      });

      map.current.on('mouseleave', 'canton-fills', () => {
        map.current.getCanvas().style.cursor = '';
      });
    });
  }, []);

  // Load and display transit stops for transit-stops page
  useEffect(() => {
    if (!map.current || activeTab !== 'transit-stops' || !selectedCanton || selectedCanton === 'All') {
      // Remove transit layers if they exist
      if (map.current) {
        if (map.current.getLayer('transit-stops-label')) {
          map.current.removeLayer('transit-stops-label');
        }
        if (map.current.getLayer('transit-stops-layer')) {
          map.current.removeLayer('transit-stops-layer');
        }
        if (map.current.getSource('transit-stops')) {
          map.current.removeSource('transit-stops');
        }
      }
      return;
    }

    const loadTransitStops = async () => {
      try {
        const stopsPath = `matsim/transit/stops_by_canton/${selectedCanton}_stops.geojson`;
        const geojson = await loadWithFallback(stopsPath);
        
        if (map.current.getSource('transit-stops')) {
          map.current.getSource('transit-stops').setData(geojson);
        } else {
          map.current.addSource('transit-stops', {
            type: 'geojson',
            data: geojson
          });
        }

        if (!map.current.getLayer('transit-stops-layer')) {
          map.current.addLayer({
            id: 'transit-stops-layer',
            type: 'circle',
            source: 'transit-stops',
            paint: {
              'circle-radius': 3,
              'circle-color': '#ff8800',
              'circle-stroke-color': '#333',
              'circle-stroke-width': 1
            }
          });
        }

        // Add transit stop labels
        if (!map.current.getLayer('transit-stops-label')) {
          map.current.addLayer({
            id: 'transit-stops-label',
            type: 'symbol',
            source: 'transit-stops',
            layout: {
              'text-field': ['get', 'name'],
              'text-size': 12,
              'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
              'text-offset': [0, -0.8],
              'text-anchor': 'bottom-left'
            },
            paint: {
              'text-color': '#222',
              'text-halo-color': '#ffffff',
              'text-halo-width': 1
            },
            minzoom: 14
          });
        }
      } catch (error) {
        console.error('Error loading transit stops:', error);
      }
    };

    if (map.current.isStyleLoaded()) {
      loadTransitStops();
    } else {
      map.current.once('load', loadTransitStops);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedCanton]);

  // Add click handler for transit stops
  useEffect(() => {
    if (!map.current || activeTab !== 'transit-stops') return;

    const handleStopClick = (e) => {
      if (!e.features || e.features.length === 0) return;

      const feature = e.features[0];
      const { name, stop_id, lines, modes_list } = feature.properties;
      const coords = feature.geometry.coordinates;

      // Parse stop_ids into array format (matching TransitStopSearch logic)
      let allStopIds = [];
      if (Array.isArray(stop_id)) {
        allStopIds = stop_id;
      } else {
        try {
          allStopIds = JSON.parse(stop_id);
        } catch {
          allStopIds = String(stop_id).split(",").map(id => id.trim());
        }
      }

      // Clear selected line when changing stops
      setSelectedTransitLine(null);
      
      // Update context with selected stop
      setSelectedTransitStop({
        name,
        stop_id,
        stop_ids: allStopIds,
        lines,
        modes_list,
        coords,
        feature
      });
    };

    const handleMouseEnter = () => {
      map.current.getCanvas().style.cursor = 'pointer';
    };

    const handleMouseLeave = () => {
      map.current.getCanvas().style.cursor = '';
    };

    // Add event listeners
    map.current.on('click', 'transit-stops-layer', handleStopClick);
    map.current.on('mouseenter', 'transit-stops-layer', handleMouseEnter);
    map.current.on('mouseleave', 'transit-stops-layer', handleMouseLeave);

    // Cleanup
    return () => {
      if (map.current) {
        map.current.off('click', 'transit-stops-layer', handleStopClick);
        map.current.off('mouseenter', 'transit-stops-layer', handleMouseEnter);
        map.current.off('mouseleave', 'transit-stops-layer', handleMouseLeave);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Zoom to selected transit stop
  useEffect(() => {
    if (!map.current) return;

    // Remove marker if not on transit stops page
    if (activeTab !== 'transit-stops') {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    // Remove existing marker if no stop is selected
    if (!selectedTransitStop) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    const { coords, name } = selectedTransitStop;

    // Remove existing marker
    if (markerRef.current) {
      markerRef.current.remove();
    }

    // Create highlight marker
    const el = document.createElement('div');
    el.className = 'transit-stop-marker';
    el.style.width = '10px';
    el.style.height = '10px';
    el.style.borderRadius = '50%';
    el.style.backgroundColor = '#00ffff';
    el.style.border = '2px solid #fff';
    el.style.boxShadow = '0 0 10px rgba(0,255,255,0.5)';

    markerRef.current = new mapboxgl.Marker(el)
      .setLngLat(coords)
      .addTo(map.current);

    // Zoom to stop
    map.current.flyTo({
      center: coords,
      zoom: 14,
      duration: 1000
    });

  }, [selectedTransitStop, activeTab]);

  // Update map when canton changes (ie from toolbar) or expanded state changes
  useEffect(() => {
    if (!map.current) return;

    const updateMap = () => {
      if (!map.current.isStyleLoaded() || !map.current.getLayer('canton-highlight')) {
        // Wait for map to be ready
        return;
      }

      // update highlighted polygon first
      if (selectedCanton === "All") {
        map.current.setFilter('canton-highlight', ['==', 'NAME', '']);
      } else {
        // Match canton name in geojson (may need adjustment based on actual data)
        map.current.setFilter('canton-highlight', ['==', 'NAME', selectedCanton]);
      }

      // Zoom to canton bounds with a slight delay to ensure it happens after resize
      // Don't zoom if on transit-stops page with a selected stop
      if (activeTab === 'transit-stops' && selectedTransitStop) {
        return;
      }
      
      setTimeout(() => {
        if (!map.current) return;
        const bounds = CANTON_BOUNDS[selectedCanton] || CANTON_BOUNDS["All"];
        
        // zoom to the changed canton
        map.current.fitBounds(bounds, {
          padding: isExpanded ? 50 : 20,
          duration: 500
        });
      }, 100);
    };

    if (map.current.isStyleLoaded()) {
      updateMap();
    } else {
      // Wait for the map to finish loading
      map.current.once('idle', updateMap);
    }
  }, [selectedCanton, activeTab, isExpanded, selectedTransitStop]);

  return (
    <div className="canton-map-container">
      <div ref={mapContainer} className="canton-map" />
    </div>
  );
};

export default CantonMap;
