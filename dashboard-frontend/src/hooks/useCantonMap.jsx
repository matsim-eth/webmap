import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

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

export { CANTON_BOUNDS };

/**
 * Custom hook encapsulating all Mapbox GL map lifecycle effects for CantonMap.
 * All useEffect calls here are legitimate external-system synchronisation (Mapbox).
 */
export function useCantonMap({
  mapContainer,
  sidebarCollapsed,
  isExpanded,
  activeTab,
  selectedCanton,
  setSelectedCanton,
  selectedTransitStop,
  setSelectedTransitStop,
  setSelectedTransitLine,
  getCantonData,
}) {
  const map = useRef(null);
  const markerRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const initialCantonRef = useRef(selectedCanton);

  // effect:audited -- external map sync: toggle map interactions on tab change
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

  // effect:audited -- external map sync: resize map after sidebar transition
  useEffect(() => {
    if (!map.current) return;
    const timer = setTimeout(() => {
      map.current.resize();
    }, 350);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);

  // effect:audited -- external map sync: resize observer for container changes
  useEffect(() => {
    if (!map.current || !mapContainer.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (map.current && map.current.isStyleLoaded()) {
        map.current.resize();

        if (activeTab === 'transit-stops') {
          return;
        }

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
  }, [selectedCanton, activeTab, isExpanded, mapContainer]);

  // effect:audited -- external map sync: initialize Mapbox map instance once
  useEffect(() => {
    if (map.current) return;

    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || 'pk.eyJ1IjoiYW5kd29vIiwiYSI6ImNrMjlnYnNkdTEwMHozaG5wamJvZHJyangifQ.6M4eeri_Ubmo7NedQT7NuQ';

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [8.2275, 46.8182],
      zoom: 5.5,
      attributionControl: false,
      preserveDrawingBuffer: true,
      dragPan: false,
      scrollZoom: false,
      boxZoom: false,
      dragRotate: false,
      keyboard: false,
      doubleClickZoom: false,
      touchZoomRotate: false,
    });

    map.current.on('load', () => {
      if (activeTabRef.current === 'transit-stops') {
        map.current.dragPan.enable();
        map.current.scrollZoom.enable();
      }

      map.current.addSource('cantons', {
        type: 'geojson',
        data: 'https://matsim-eth.github.io/webmap/data/TLM_KANTONSGEBIET.geojson'
      });

      map.current.addLayer({
        id: 'canton-fills',
        type: 'fill',
        source: 'cantons',
        paint: {
          'fill-color': '#6366f1',
          'fill-opacity': 0.1
        }
      });

      map.current.addLayer({
        id: 'canton-borders',
        type: 'line',
        source: 'cantons',
        paint: {
          'line-color': '#6366f1',
          'line-width': 1
        }
      });

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

      const initCanton = initialCantonRef.current;
      if (initCanton && initCanton !== "All" && activeTabRef.current !== 'transit-stops') {
        const bounds = CANTON_BOUNDS[initCanton] || CANTON_BOUNDS["All"];
        map.current.fitBounds(bounds, {
          padding: isExpanded ? 50 : 20,
          duration: 0
        });
        map.current.setFilter('canton-highlight', ['==', 'NAME', initCanton]);
      } else if (initCanton && initCanton !== "All") {
        map.current.setFilter('canton-highlight', ['==', 'NAME', initCanton]);
      }

      map.current.on('click', 'canton-fills', (e) => {
        if (e.features && e.features.length > 0) {
          const cantonName = e.features[0].properties.NAME;
          if (cantonName && CANTON_BOUNDS[cantonName]) {
            setSelectedCanton(cantonName);
          }
        }
      });

      map.current.on('dblclick', () => {
        setSelectedCanton('All');
        if (activeTabRef.current !== 'transit-stops') {
          map.current.fitBounds(CANTON_BOUNDS['All'], {
            padding: isExpanded ? 50 : 20,
            duration: 500
          });
        }
      });

      map.current.on('mouseenter', 'canton-fills', () => {
        map.current.getCanvas().style.cursor = 'pointer';
      });

      map.current.on('mouseleave', 'canton-fills', () => {
        map.current.getCanvas().style.cursor = '';
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // effect:audited -- external map sync: load transit stops layer
  useEffect(() => {
    if (!map.current || activeTab !== 'transit-stops' || !selectedCanton || selectedCanton === 'All') {
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
        const geojson = await getCantonData(stopsPath);

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

  // effect:audited -- external map sync: click handler for transit stops
  useEffect(() => {
    if (!map.current || activeTab !== 'transit-stops') return;

    const handleStopClick = (e) => {
      if (!e.features || e.features.length === 0) return;

      const feature = e.features[0];
      const { name, stop_id, lines, modes_list } = feature.properties;
      const coords = feature.geometry.coordinates;

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

      setSelectedTransitLine(null);

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

    map.current.on('click', 'transit-stops-layer', handleStopClick);
    map.current.on('mouseenter', 'transit-stops-layer', handleMouseEnter);
    map.current.on('mouseleave', 'transit-stops-layer', handleMouseLeave);

    return () => {
      if (map.current) {
        map.current.off('click', 'transit-stops-layer', handleStopClick);
        map.current.off('mouseenter', 'transit-stops-layer', handleMouseEnter);
        map.current.off('mouseleave', 'transit-stops-layer', handleMouseLeave);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // effect:audited -- external map sync: zoom to selected transit stop + marker
  useEffect(() => {
    if (!map.current) return;

    if (activeTab !== 'transit-stops') {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    if (!selectedTransitStop) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    const { coords, name } = selectedTransitStop;

    if (markerRef.current) {
      markerRef.current.remove();
    }

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

    map.current.flyTo({
      center: coords,
      zoom: 14,
      duration: 1000
    });

  }, [selectedTransitStop, activeTab]);

  // effect:audited -- external map sync: update map on canton/expanded change
  useEffect(() => {
    if (!map.current) return;

    const updateMap = () => {
      if (!map.current.isStyleLoaded() || !map.current.getLayer('canton-highlight')) {
        return;
      }

      if (selectedCanton === "All") {
        map.current.setFilter('canton-highlight', ['==', 'NAME', '']);
      } else {
        map.current.setFilter('canton-highlight', ['==', 'NAME', selectedCanton]);
      }

      if (activeTab === 'transit-stops' && selectedTransitStop) {
        return;
      }

      setTimeout(() => {
        if (!map.current) return;
        const bounds = CANTON_BOUNDS[selectedCanton] || CANTON_BOUNDS["All"];

        map.current.fitBounds(bounds, {
          padding: isExpanded ? 50 : 20,
          duration: 500
        });
      }, 100);
    };

    if (map.current.isStyleLoaded()) {
      updateMap();
    } else {
      map.current.once('idle', updateMap);
    }
  }, [selectedCanton, activeTab, isExpanded, selectedTransitStop]);

  return map;
}
