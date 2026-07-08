import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  extractLineIds,
  parseStopFeatureLines,
  isModeFilterActive,
} from '../utils/transitLineFilter';

// Mapbox helpers — guard layer/source mutations so re-runs after partial
// teardown don't throw.
const safeRemoveLayers = (m, ids) => {
  for (const id of ids) if (m.getLayer(id)) m.removeLayer(id);
};
const safeRemoveSources = (m, ids) => {
  for (const id of ids) if (m.getSource(id)) m.removeSource(id);
};

const STOP_TABS = new Set(['transit-stops', 'transit-lines']);

// Compute bbox for an array of GeoJSON features (LineString / MultiLineString
// / Point). Returns `null` if no finite coords found.
const computeFeatureBbox = (features) => {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const expand = (lng, lat) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'LineString') g.coordinates.forEach((c) => expand(c[0], c[1]));
    else if (g.type === 'MultiLineString') g.coordinates.forEach((line) => line.forEach((c) => expand(c[0], c[1])));
    else if (g.type === 'Point') expand(g.coordinates[0], g.coordinates[1]);
  }
  return Number.isFinite(minLng) ? [[minLng, minLat], [maxLng, maxLat]] : null;
};

// Wait until the map style is reported loaded. `isStyleLoaded()` flickers to
// false whenever a source or layer is mid-load (canton stops fetch, flyTo,
// etc.); awaiting `idle` is more reliable than gating on the boolean.
const awaitStyleLoaded = (m) => {
  if (m.isStyleLoaded()) return Promise.resolve();
  return new Promise((resolve) => m.once('idle', resolve));
};

// Fallback "All" extent if the study area lacks a top-level bbox — Switzerland,
// so a mis-served study area still frames the country instead of the whole map.
const DEFAULT_ALL_BOUNDS = [[5.9, 45.8], [10.5, 47.8]];

// Study-area bbox [minLon,minLat,maxLon,maxLat] → Mapbox nested-pair bounds.
const flatBboxToBounds = (b) =>
  Array.isArray(b) && b.length === 4 ? [[b[0], b[1]], [b[2], b[3]]] : null;

// bbox (nested Mapbox bounds) for any GeoJSON feature — walks all coordinate
// rings so Polygon / MultiPolygon zone features resolve when their study-area
// bbox is null. Returns null if no finite coords found.
const featureBounds = (feature) => {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const visit = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [lng, lat] = node;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
      return;
    }
    for (const child of node) visit(child);
  };
  visit(feature?.geometry?.coordinates);
  return Number.isFinite(minLng) ? [[minLng, minLat], [maxLng, maxLat]] : null;
};

// Swiss canton name → kantonsnum (1–26), matching the FSO numbering used by
// build_municipalities.py. Exported so CantonMap can pre-filter
// municipalities.geojson by canton (avoids scanning all 2136 features when
// only a few cantons matter).
export const CANTON_NAME_TO_NUM = {
  Zurich: 1, Bern: 2, Luzern: 3, Uri: 4, Schwyz: 5, Obwalden: 6, Nidwalden: 7,
  Glarus: 8, Zug: 9, Fribourg: 10, Solothurn: 11, 'Basel-Stadt': 12,
  'Basel-Landschaft': 13, Schaffhausen: 14, AppenzellAusserrhoden: 15,
  AppenzellInnerrhoden: 16, StGallen: 17, Graubunden: 18, Aargau: 19,
  Thurgau: 20, Ticino: 21, Vaud: 22, Valais: 23, Neuchatel: 24, Geneve: 25,
  Jura: 26,
};

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
  selectedLineMeta,
  setSelectedLineMeta,
  selectedMunicipality,
  setSelectedMunicipality,
  selectedLineModes,
  linePolygonsFC,
  getCantonData,
  hideLineByFilter = false,
  hideStopByFilter = false,
  // Study-area driven map extent + zone layer (Swiss fallback = the old
  // hardcoded canton bounds / TLM boundaries / center+zoom).
  zones = [],
  studyBbox = null,
  initialCenter = [8.2275, 46.8182],
  initialZoom = 5.5,
  getZonesGeojson,
  datasetId,
}) {
  const map = useRef(null);
  const markerRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const initialCantonRef = useRef(selectedCanton);

  // Latest study-area inputs, kept in a ref so the once-only init effect and
  // the dataset-switch reload effect always read current values without
  // re-subscribing.
  const latest = useRef({});
  latest.current = { zones, studyBbox, initialCenter, initialZoom, getZonesGeojson };

  // name -> Mapbox nested bounds. Seeded from each zone's study-area bbox, then
  // filled from the loaded zone geojson for any zone lacking a bbox.
  const boundsRef = useRef(new Map());
  const rebuildBounds = (geo) => {
    const featBounds = new Map();
    for (const f of geo?.features ?? []) {
      const nm = f?.properties?.NAME ?? f?.properties?.name;
      if (nm == null) continue;
      const b = featureBounds(f);
      if (b) featBounds.set(String(nm), b);
    }
    const m = new Map();
    for (const z of latest.current.zones ?? []) {
      const nested = flatBboxToBounds(z.bbox) || featBounds.get(String(z.name));
      if (nested) m.set(z.name, nested);
    }
    // Defensive: keep any geojson feature not present in the zone list.
    for (const [nm, b] of featBounds) if (!m.has(nm)) m.set(nm, b);
    boundsRef.current = m;
  };

  const allBounds = () => flatBboxToBounds(latest.current.studyBbox) || DEFAULT_ALL_BOUNDS;
  const boundsFor = (name) =>
    (name && name !== 'All' && boundsRef.current.get(name)) || allBounds();
  const isZoneClickable = (name) => !!(name && boundsRef.current.has(name));

  // Union bbox of a freshly-loaded zone FeatureCollection → [[sw],[ne]].
  // Used for the study-area fit on a dataset switch: studyBbox (from the async
  // study_area.json query) can still hold the PREVIOUS dataset's extent at the
  // moment the switch fires, whereas the geojson we just drew is authoritative.
  const unionBounds = (geo) => {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const f of geo?.features ?? []) {
      const b = featureBounds(f); // [[sw_lon,sw_lat],[ne_lon,ne_lat]]
      if (!b) continue;
      if (b[0][0] < minLon) minLon = b[0][0];
      if (b[0][1] < minLat) minLat = b[0][1];
      if (b[1][0] > maxLon) maxLon = b[1][0];
      if (b[1][1] > maxLat) maxLat = b[1][1];
    }
    return Number.isFinite(minLon) ? [[minLon, minLat], [maxLon, maxLat]] : null;
  };

  // Load the primary-zone boundary geojson: backend zones.json first
  // (authoritative, per-dataset), CDN TLM boundaries as the last resort so
  // legacy Swiss datasets whose backend lacks the endpoint still render.
  const loadZonesGeojson = async () => {
    const fn = latest.current.getZonesGeojson;
    if (fn) {
      try {
        const g = await fn();
        if (g?.features?.length) return g;
      } catch { /* fall through to CDN */ }
    }
    try {
      const res = await fetch('https://matsim-eth.github.io/webmap/data/TLM_KANTONSGEBIET.geojson');
      if (res.ok) return await res.json();
    } catch { /* give up — empty layer */ }
    return { type: 'FeatureCollection', features: [] };
  };
  // Latest dim-mask state, kept in a ref so loadTransitStops can re-apply it
  // when the layer is (re)created after a canton change post-search.
  const dimMaskRef = useRef({ active: false, lineId: null });
  dimMaskRef.current = {
    active: activeTab === 'transit-lines' && !!selectedLineMeta?.line_id && !hideLineByFilter,
    lineId: selectedLineMeta?.line_id ?? null,
  };

  const applyStopDim = (m) => {
    if (!m) return;
    const STOP = 'transit-stops-layer';
    const LABEL = 'transit-stops-label';
    const { active, lineId } = dimMaskRef.current;
    if (active && lineId != null) {
      const matchExpr = ['in', String(lineId), ['get', 'line_ids']];
      if (m.getLayer(STOP)) {
        m.setPaintProperty(STOP, 'circle-opacity', ['case', matchExpr, 1, 0.2]);
        m.setPaintProperty(STOP, 'circle-stroke-opacity', ['case', matchExpr, 1, 0.2]);
      }
      if (m.getLayer(LABEL)) {
        m.setPaintProperty(LABEL, 'text-opacity', ['case', matchExpr, 1, 0.2]);
      }
    } else {
      if (m.getLayer(STOP)) {
        m.setPaintProperty(STOP, 'circle-opacity', 1);
        m.setPaintProperty(STOP, 'circle-stroke-opacity', 1);
      }
      if (m.getLayer(LABEL)) {
        m.setPaintProperty(LABEL, 'text-opacity', 1);
      }
    }
  };

  // effect:audited -- external map sync: toggle map interactions on tab change
  useEffect(() => {
    activeTabRef.current = activeTab;
    if (!map.current) return;

    if (STOP_TABS.has(activeTab)) {
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

        if (STOP_TABS.has(activeTab)) {
          return;
        }

        const bounds = boundsFor(selectedCanton);
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

    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: latest.current.initialCenter,
      zoom: latest.current.initialZoom,
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

    map.current.on('load', async () => {
      if (STOP_TABS.has(activeTabRef.current)) {
        map.current.dragPan.enable();
        map.current.scrollZoom.enable();
      }

      // Load the zone boundary layer (backend zones.json → CDN TLM) and derive
      // per-zone fit bounds before wiring the layers/handlers that depend on it.
      const cantonsData = await loadZonesGeojson();
      if (!map.current) return;
      rebuildBounds(cantonsData);

      map.current.addSource('cantons', {
        type: 'geojson',
        data: cantonsData,
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
        map.current.fitBounds(boundsFor(initCanton), {
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
          if (isZoneClickable(cantonName)) {
            setSelectedCanton(cantonName);
          }
        }
      });

      map.current.on('dblclick', () => {
        setSelectedCanton('All');
        if (!STOP_TABS.has(activeTabRef.current)) {
          map.current.fitBounds(boundsFor('All'), {
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

  // effect:audited -- external map sync: reload the zone boundary layer when the
  // dataset changes. Different datasets can declare different study areas
  // (e.g. Swiss cantons vs a re-zoned canton's municipalities), so re-fetch
  // zones.json and refresh the 'cantons' source + fit bounds. Skips the first
  // run — the init effect already loads the layer for the initial dataset.
  const didInitDatasetRef = useRef(false);
  useEffect(() => {
    if (!map.current) return;
    if (!didInitDatasetRef.current) {
      didInitDatasetRef.current = true;
      return;
    }
    let cancelled = false;
    const reload = async () => {
      const geo = await loadZonesGeojson();
      if (cancelled || !map.current) return;
      rebuildBounds(geo);
      await awaitStyleLoaded(map.current);
      if (cancelled || !map.current) return;
      const src = map.current.getSource('cantons');
      if (src) src.setData(geo);
      // Zoom into the new study area (animated, like the webmap's dataset
      // switch). selectedCanton was reset to "All" by the context on switch,
      // so fit the whole new area — computed from the geojson we just drew,
      // NOT studyBbox (which may still be the previous dataset's extent).
      // Skip only when the user is mid transit-stop/line drilldown.
      if (!STOP_TABS.has(activeTabRef.current)) {
        const target = (selectedCanton && selectedCanton !== 'All'
          && boundsRef.current.get(selectedCanton))
          || unionBounds(geo) || boundsFor(selectedCanton);
        map.current.fitBounds(target, {
          padding: isExpanded ? 50 : 20,
          duration: 900,
        });
      }
    };
    reload();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  // effect:audited -- external map sync: load transit stops layer
  useEffect(() => {
    if (!map.current || !STOP_TABS.has(activeTab) || !selectedCanton || selectedCanton === 'All') {
      if (map.current) {
        safeRemoveLayers(map.current, ['transit-stops-label', 'transit-stops-layer']);
        safeRemoveSources(map.current, ['transit-stops']);
      }
      return;
    }

    const loadTransitStops = async () => {
      try {
        const stopsPath = `matsim/transit/stops_by_canton/${encodeURIComponent(selectedCanton)}_stops.geojson`;
        const geojson = await getCantonData(stopsPath);

        // Inject `line_ids` into each feature so Mapbox filter expressions can
        // dim stops not on the highlighted line. Mirrors the webmap pattern
        // (useTransitStops.js) — raw `lines` is an array of objects which
        // Mapbox can't introspect.
        const decorated = {
          ...geojson,
          features: (geojson?.features ?? []).map((f) => ({
            ...f,
            properties: { ...f.properties, line_ids: extractLineIds(f.properties?.lines) },
          })),
        };

        if (map.current.getSource('transit-stops')) {
          map.current.getSource('transit-stops').setData(decorated);
        } else {
          map.current.addSource('transit-stops', {
            type: 'geojson',
            data: decorated
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

        // Re-apply dim immediately on (re)create so a canton click made after
        // a search-bar line selection inherits the transparency mask.
        applyStopDim(map.current);
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
    if (!map.current || !STOP_TABS.has(activeTab)) return;

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
      // Clicking a different stop on the transit-lines tab restarts the
      // line-selection flow (LinesAtStop panel will repopulate from the new
      // stop), so wipe any previously selected line.
      if (activeTabRef.current === 'transit-lines') {
        setSelectedLineMeta?.(null);
        setSelectedMunicipality?.(null);
      }

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

    if (!STOP_TABS.has(activeTab)) {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }
      return;
    }

    if (!selectedTransitStop || hideStopByFilter) {
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

  }, [selectedTransitStop, activeTab, hideStopByFilter]);

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
      if (activeTab === 'transit-lines' && (selectedTransitStop || selectedLineMeta)) {
        return;
      }

      setTimeout(() => {
        if (!map.current) return;
        map.current.fitBounds(boundsFor(selectedCanton), {
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
  }, [selectedCanton, activeTab, isExpanded, selectedTransitStop, selectedLineMeta]);

  // effect:audited -- external map sync: filter the transit-stops layer by
  // selected modes (Transit Lines tab). Stops carry `modes_list` which is an
  // array of mode strings; show stops whose modes_list intersects the filter.
  useEffect(() => {
    if (!map.current) return;
    if (activeTab !== 'transit-lines') {
      // Reset filters when leaving the tab so transit-stops tab isn't affected.
      ['transit-stops-layer', 'transit-stops-label'].forEach((id) => {
        if (map.current.getLayer(id)) map.current.setFilter(id, null);
      });
      return;
    }

    const apply = () => {
      const m = map.current;
      if (!m) return;
      const filter = isModeFilterActive(selectedLineModes)
        ? ['any', ...selectedLineModes.map((mode) => ['in', mode, ['get', 'modes_list']])]
        : null;
      ['transit-stops-layer', 'transit-stops-label'].forEach((id) => {
        if (m.getLayer(id)) m.setFilter(id, filter);
      });
    };

    if (map.current.isStyleLoaded()) apply();
    else map.current.once('idle', apply);
  }, [selectedLineModes, activeTab, selectedCanton]);

  // effect:audited -- external map sync: overlay polygons the selected line
  // traverses. Source-agnostic: receives a ready FeatureCollection
  // (`linePolygonsFC`) computed by CantonMap.jsx from the active polygon set
  // (default = municipalities, optional = user-uploaded GeoJSON). Each
  // feature must have a `name` property in its `properties` for the label
  // layer; CantonMap rewrites the property when it's not already there.
  useEffect(() => {
    if (!map.current) return;
    const m = map.current;

    const cleanup = () => {
      safeRemoveLayers(m, [
        'line-polygons-fill',
        'line-polygons-line',
        'line-polygons-label',
      ]);
      safeRemoveSources(m, ['line-polygons']);
    };

    const shouldShow = activeTab === 'transit-lines'
      && selectedLineMeta?.line_id
      && linePolygonsFC?.features?.length > 0
      && !hideLineByFilter;
    if (!shouldShow) {
      cleanup();
      return;
    }

    let cancelled = false;
    const run = async () => {
      await awaitStyleLoaded(m);
      if (cancelled) return;

      // Update the source in place when it already exists — keeps the layer
      // stable across polygon-set switches without a teardown/rebuild flicker.
      if (m.getSource('line-polygons')) {
        m.getSource('line-polygons').setData(linePolygonsFC);
      } else {
        m.addSource('line-polygons', { type: 'geojson', data: linePolygonsFC });

        // Fill+outline+label. Inserted before the route layer if it exists,
        // so the route polyline draws over the fill (which would otherwise
        // hide it).
        const beforeLayer = m.getLayer('transit-line-display') ? 'transit-line-display' : undefined;
        m.addLayer(
          {
            id: 'line-polygons-fill',
            type: 'fill',
            source: 'line-polygons',
            paint: { 'fill-color': '#00a2ff', 'fill-opacity': 0.12 },
          },
          beforeLayer
        );
        m.addLayer(
          {
            id: 'line-polygons-line',
            type: 'line',
            source: 'line-polygons',
            paint: { 'line-color': '#00a2ff', 'line-width': 1, 'line-opacity': 0.6 },
          },
          beforeLayer
        );
        m.addLayer({
          id: 'line-polygons-label',
          type: 'symbol',
          source: 'line-polygons',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-anchor': 'center',
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': '#0066b3',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.2,
          },
          minzoom: 9,
        });
        // Force fill/outline beneath the route polyline if the route layer
        // raced ahead with the wrong beforeId.
        if (m.getLayer('transit-line-display')) {
          ['line-polygons-fill', 'line-polygons-line'].forEach((id) => {
            if (m.getLayer(id)) m.moveLayer(id, 'transit-line-display');
          });
        }
      }
    };

    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedLineMeta, linePolygonsFC, hideLineByFilter]);

  // effect:audited -- external map sync: dim stops not on the highlighted line.
  // When a line is selected on the transit-lines tab, fade non-matching stops
  // to 0.2 (kept clickable so users can pivot). loadTransitStops also calls
  // applyStopDim directly so a canton selected after a search-bar line pick
  // inherits the dim immediately on layer creation.
  useEffect(() => {
    if (!map.current) return;
    const m = map.current;
    if (m.isStyleLoaded()) applyStopDim(m);
    else m.once('idle', () => applyStopDim(m));
  }, [activeTab, selectedLineMeta, selectedCanton, hideLineByFilter]);

  // effect:audited -- external map sync: render the selected transit line's
  // route polylines + fit bounds. Ported from webmap's useTransitLines.js.
  // Split from the inter-cantonal stops effect below so a canton change
  // doesn't trigger a routes re-fetch (routes are canton-independent).
  useEffect(() => {
    if (!map.current) return;
    const m = map.current;

    const cleanup = () => {
      safeRemoveLayers(m, ['transit-line-display']);
      safeRemoveSources(m, ['transit-line-display']);
    };

    if (activeTab !== 'transit-lines' || !selectedLineMeta?.line_id || hideLineByFilter) {
      cleanup();
      return;
    }

    const { line_id } = selectedLineMeta;
    let cancelled = false;

    const run = async () => {
      // Prefer the per-line backend slice (tens of KB) over downloading the
      // whole ~76 MB transit_routes.geojson. On 404 the loader returns null;
      // fall back to the full file + client-side line_id filter so legacy /
      // CDN-only datasets that lack the by_line asset keep working.
      let matchedRoutes = null;
      const byLine = await getCantonData(
        `matsim/transit/routes/by_line/${encodeURIComponent(line_id)}.geojson`
      );
      if (cancelled) return;
      if (byLine?.features?.length) {
        matchedRoutes = byLine.features;
      }

      if (!matchedRoutes) {
        const routesGeo = await getCantonData('matsim/transit/routes/transit_routes.geojson');
        if (cancelled) return;
        if (!routesGeo?.features) {
          console.warn('[transit-lines] transit_routes.geojson failed to load or has no features');
          return;
        }

        // Match by line_id only. boarding_data_by_line route_ids don't match
        // transit_routes.geojson route_ids (dataset-specific namespaces), so
        // we don't restrict on route_id.
        matchedRoutes = routesGeo.features.filter(
          (f) => String(f.properties?.line_id) === String(line_id)
        );
        if (matchedRoutes.length === 0) {
          console.warn(
            `[transit-lines] no routes matched in transit_routes.geojson for line_id="${line_id}".`
          );
        }
      }

      await awaitStyleLoaded(m);
      if (cancelled) return;

      // setData on existing source instead of teardown+rebuild — avoids
      // flicker. Mirrors the webmap's getSource(...).setData(...) path.
      const routeData = { type: 'FeatureCollection', features: matchedRoutes };
      if (m.getSource('transit-line-display')) {
        m.getSource('transit-line-display').setData(routeData);
      } else if (matchedRoutes.length) {
        const beforeLayer = m.getLayer('transit-stops-layer') ? 'transit-stops-layer' : undefined;
        m.addSource('transit-line-display', { type: 'geojson', data: routeData });
        m.addLayer(
          {
            id: 'transit-line-display',
            type: 'line',
            source: 'transit-line-display',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#00a2ff', 'line-width': 2 },
          },
          beforeLayer
        );
        // The municipalities effect can race ahead and add its same-color
        // fill on top, masking the route. Force the fill/outline beneath
        // the route polyline so the line stays visible.
        ['line-polygons-fill', 'line-polygons-line'].forEach((id) => {
          if (m.getLayer(id)) m.moveLayer(id, 'transit-line-display');
        });
      }

      // Bbox from routes only — stops are points along the route, so route
      // geometry dominates the line's geographic extent.
      const bbox = computeFeatureBbox(matchedRoutes);
      if (bbox) {
        m.fitBounds(bbox, {
          padding: isExpanded ? 60 : 30,
          duration: 800,
        });
      }
    };

    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedLineMeta, hideLineByFilter]);

  // effect:audited -- external map sync: inter-cantonal stops on the selected
  // line. Stops in the active canton already render on the main
  // `transit-stops-layer`; this layer covers stops in OTHER cantons the line
  // visits (e.g. a Luzern bus stop while user has Zurich selected). Sources:
  //   1. inter_cantonal_stops.geojson (catches non-catalog lines like
  //      zero-volume `92-920-j24-1`).
  //   2. stops_by_canton/<canton>_stops.geojson for each non-active canton
  //      on the line (intra-canton lines outside the selected canton aren't
  //      in the inter-cantonal file).
  // Split from the routes effect because canton change requires re-running
  // this but not routes.
  useEffect(() => {
    if (!map.current) return;
    const m = map.current;

    const cleanup = () => {
      safeRemoveLayers(m, ['inter-cantonal-stops-label', 'inter-cantonal-stops']);
      safeRemoveSources(m, ['inter-cantonal-stops']);
    };

    if (activeTab !== 'transit-lines' || !selectedLineMeta?.line_id || hideLineByFilter) {
      cleanup();
      return;
    }

    const { line_id } = selectedLineMeta;
    let cancelled = false;

    const run = async () => {
      // Skip the active canton — its stops are already on transit-stops-layer.
      const cantonsForLine = Array.isArray(selectedLineMeta?.cantons) ? selectedLineMeta.cantons : [];
      const otherCantons = cantonsForLine.filter((c) => c !== selectedCanton);
      const stopFetches = [
        getCantonData('matsim/transit/stops_by_canton/inter_cantonal_stops.geojson').catch(() => null),
        ...otherCantons.map((c) =>
          getCantonData(`matsim/transit/stops_by_canton/${encodeURIComponent(c)}_stops.geojson`).catch(() => null)
        ),
      ];
      const stopGeos = await Promise.all(stopFetches);
      if (cancelled) return;

      const seenStopIds = new Set();
      const matchedStops = [];
      stopGeos.forEach((geo, idx) => {
        if (!geo?.features) return;
        // Source 0 carries `assigned_canton`. Source 1+ are per-canton files;
        // tag with their canton name so layer logic stays uniform.
        const fileCanton = idx === 0 ? null : otherCantons[idx - 1];
        for (const f of geo.features) {
          const parsed = parseStopFeatureLines(f.properties?.lines);
          if (!parsed.some((l) => String(l.line_id) === String(line_id))) continue;

          const stopCanton = f.properties?.assigned_canton ?? fileCanton;
          // Belt-and-suspenders: inter-cantonal file may include a stop in
          // the active canton. Skip — already on transit-stops-layer.
          if (selectedCanton && stopCanton === selectedCanton) continue;

          // Dedup by stop_id so a stop present in both files isn't drawn twice.
          const sid = Array.isArray(f.properties?.stop_id)
            ? f.properties.stop_id.join('|')
            : String(f.properties?.stop_id ?? '');
          if (sid && seenStopIds.has(sid)) continue;
          if (sid) seenStopIds.add(sid);

          matchedStops.push({
            ...f,
            properties: { ...f.properties, _kanton: stopCanton },
          });
        }
      });

      await awaitStyleLoaded(m);
      if (cancelled) return;

      const stopData = { type: 'FeatureCollection', features: matchedStops };
      if (m.getSource('inter-cantonal-stops')) {
        m.getSource('inter-cantonal-stops').setData(stopData);
      } else if (matchedStops.length) {
        const beforeLayer = m.getLayer('transit-stops-layer') ? 'transit-stops-layer' : undefined;
        m.addSource('inter-cantonal-stops', { type: 'geojson', data: stopData });
        m.addLayer(
          {
            id: 'inter-cantonal-stops',
            type: 'circle',
            source: 'inter-cantonal-stops',
            paint: {
              'circle-radius': 3,
              'circle-color': '#b0b0b0',
              'circle-stroke-color': '#333',
              'circle-stroke-width': 1,
            },
          },
          beforeLayer
        );
        m.addLayer({
          id: 'inter-cantonal-stops-label',
          type: 'symbol',
          source: 'inter-cantonal-stops',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 12,
            'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
            'text-offset': [0, -0.8],
            'text-anchor': 'bottom-left',
          },
          paint: {
            'text-color': '#222',
            'text-halo-color': '#ffffff',
            'text-halo-width': 1,
          },
          minzoom: 14,
        });
      }
    };

    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedLineMeta, hideLineByFilter, selectedCanton]);

  return map;
}
