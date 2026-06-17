import { useEffect, useRef, useState } from 'react';
import useAntPath from './useAntPath';
import { safeRemoveLayer, safeRemoveSource, setVisibility, setFilter } from './_lib/mapbox';
import { parsePipeList, decoratePerIdMinMax, decorateLineVolumesFromPerId, mergeSegmentsByGeometry } from './_lib/pipeProps';
import { CLICKABLE_ROAD_FILTER } from './_lib/mapboxFilters';

export default function useNetworkLayers({
  mapRef,
  searchCanton,
  loadWithFallback,
  selectedNetworkModes,
  showMajorRoadsOnly,
  timeRange,
  visualizeLinkId,
  visualizeNonce,
  setSelectedNetworkFeature,
  setFeatureSelection,
  isGraphExpanded,
  resetMapTrigger,
  graphExpandedRef,
  setIsLoading,
  setMapLoading,
  labelSize,
  setFeatureGeoJSON,
  drawRef
}) {
  const [linkVolumeData, setLinkVolumeData] = useState(null);
  const originalNetworkGeoJSON = useRef(null);
  const selectedNetworkModesRef = useRef(selectedNetworkModes);
  
  useEffect(() => {
    selectedNetworkModesRef.current = selectedNetworkModes;
  }, [selectedNetworkModes]);
  
  // --- helpers ---------------------------------------------------------------
  
  // recompute per-id volumes for a feature based on linkVolumeData + timeRange
  const recomputeVolumesForFeature = (f, startHour, endHour) => {
    const props = f.properties || {};

    // Parse pipe-separated strings
    const keys = parsePipeList(props.per_id_keys);
    const arrows = parsePipeList(props.per_id_arrows);
    const daily_avgs = parsePipeList(props.per_id_daily_avgs);
    
    let left = 0, right = 0;
    
    keys.forEach((id, index) => {
      const hourly = linkVolumeData?.[id.toString()];
      let s = 0;
      if (hourly && Array.isArray(hourly) && hourly.length === 24) {
        // Sum volumes from startHour to endHour using array indexing
        for (let h = startHour; h < endHour; h++) {
          s += hourly[h] ?? 0;
        }
      } else {
        // Fallback to daily average if hourly data not available
        s = Number(daily_avgs[index] ?? 0);
      }
      
      const arrow = arrows[index];
      if (arrow === '←') left += s;
      else if (arrow === '→') right += s;
    });
    
    f.properties = {
      ...f.properties,
      daily_avg_volume: left + right, // total
      left_sum: left,
      right_sum: right
    };
    
    return { left, right, total: left + right };
  };
  
  // ── Label helpers ───────────────────────────────────────────────────────
  const LABEL_IDS = ['network-label-left', 'network-label-right'];
  const offsetEm = 1;

  // west-ish if angle in (90, 180] ∪ (-180, -90]
  const offsetPos = ['any', ['>', ['get', 'angle'], 90], ['<=', ['get', 'angle'], -90]];

  const setLabelVisibility = (map, visible) => setVisibility(map, LABEL_IDS, visible);

  const applyLabelFilter = (map, showMajorRoadsOnly) => {
    const labelFilter = showMajorRoadsOnly ? ['>', ['get', 'capacity'], 1200] : null;
    setFilter(map, LABEL_IDS, labelFilter);
  };

  // Ensure labels in Volumes mode are always car-only (optionally major roads only)
  const applyLabelCarAndMajorFilter = (map, showMajorRoadsOnly) => {
    // Exact match for "car" mode (prevents matching "cable car")
    const carFilter = ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0];
    const labelFilter = showMajorRoadsOnly
      ? ['all', carFilter, ['>', ['get', 'capacity'], 1200]]
      : carFilter;
    setFilter(map, LABEL_IDS, labelFilter);
  };
  
  const addLabelLayersIfMissing = (map) => {
    if (!map.getSource('network-source')) return;
    
    // LEFT (always ABOVE): "← NNN"
    if (!map.getLayer('network-label-left')) {
      map.addLayer({
        id: 'network-label-left',
        type: 'symbol',
        source: 'network-source',
        minzoom: 15,
        layout: {
          'symbol-placement': 'line-center',
          'symbol-spacing': 9999999, // no repeat
          'text-keep-upright': true,
          'text-field': [
            'case',
            ['==', ['round', ['number', ['get', 'right_sum'], 0]], 0],
            '',
            ['concat', ['to-string', ['round', ['number', ['get', 'right_sum'], 0]]], ' \u2192']
          ],
          'text-size': Number(labelSize) || 11,             // ← numeric, no variables
          'text-offset': [0, ['case', offsetPos, -offsetEm, offsetEm]], // flip when west-ish
          'text-allow-overlap': true,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold']
        },
        paint: { 'text-halo-width': 1, 'text-halo-color': '#ffffff' }
      }, 'network-layer');
    }
    
    // RIGHT (always BELOW): "NNN →"
    if (!map.getLayer('network-label-right')) {
      map.addLayer({
        id: 'network-label-right',
        type: 'symbol',
        source: 'network-source',
        minzoom: 15,
        layout: {
          'symbol-placement': 'line-center',
          'symbol-spacing': 9999999,
          'text-keep-upright': true,
          'text-field': [
            'case',
            ['==', ['round', ['number', ['get', 'left_sum'], 0]], 0],
            '',
            ['concat', '\u2190 ', ['to-string', ['round', ['number', ['get', 'left_sum'], 0]]]]
          ],
          'text-size': Number(labelSize) || 11,             // ← numeric, no variables
          'text-offset': [0, ['case', offsetPos, offsetEm, -offsetEm]], // flip when west-ish
          'text-allow-overlap': true,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold']
        },
        paint: { 'text-halo-width': 1, 'text-halo-color': '#ffffff' }
      }, 'network-layer');
    }
  };
  
  
  // --- LOAD NETWORK (UPDATED to use merged file) -----------------------------
  
  const loadNetworkForCanton = async ( cantonName ) => {
    const map = mapRef.current;
    if (!map) return;
    
    safeRemoveLayer(map, [
      'network-layer', 'click-network-layer', 'ant-line', 'network-highlight',
      'network-label-left', 'network-label-right'
    ]);
    safeRemoveSource(map, ['network-source', 'network-highlight', 'ant-path']);

    setIsLoading(true);
    setSelectedNetworkFeature(null);
    
    // NEW: fixed filename you gave
    const relativePath = `matsim/${cantonName}_merged_segments.geojson`;
    
    let networkGeojson;
    try {
      networkGeojson = await loadWithFallback(relativePath);
    } catch (error) {
      console.warn(`Failed to load network`, error);
      setFeatureGeoJSON?.(null);
      setIsLoading(false);
      return;
    }
    if (!networkGeojson) {
      setFeatureGeoJSON?.(null);
      setIsLoading(false);
      return;
    }
    
    // New per-link merged_segments format (one feature per directed link,
    // singular `link_id`, no per_id_*) → merge forward+reverse links sharing a
    // geometry into one segment carrying per_id_keys/per_id_arrows, so the
    // downstream hooks (VolumeFlow dropdown, LinkSpeeds/NodeFlows offset) work as
    // before. No-op on old-format data that already has per_id_keys.
    networkGeojson.features = mergeSegmentsByGeometry(networkGeojson.features);

    originalNetworkGeoJSON.current = networkGeojson;

    decorateLineVolumesFromPerId(networkGeojson.features);
    decoratePerIdMinMax(networkGeojson.features);

    setFeatureGeoJSON?.(networkGeojson);
    
    map.addSource('network-source', { type: 'geojson', data: networkGeojson, generateId: true });
    
    map.addLayer({
      id: 'click-network-layer',
      type: 'line',
      source: 'network-source',
      paint: {
        'line-width': (graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')
          ? 10
          : ['interpolate', ['linear'], ['get', 'capacity'], 300, 10, 4000, 21],
        'line-opacity': 0
      }
    });
    
    map.addLayer({
      id: 'network-layer',
      type: 'line',
      source: 'network-source',
      paint: {
        'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 1, 4000, 8],
        'line-color':
          ((graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds'))
          ? ['interpolate', ['linear'], ['get', 'daily_avg_volume'],
            0, '#ffffcc', 50, '#c2e699', 100, '#78c679', 250, '#31a354', 500, '#006837']
          : ['interpolate', ['linear'], ['get', 'freespeed'],
            0, '#ffffb2', 25, '#fed976', 50, '#feb24c', 75, '#fd8d3c', 100, '#fc4e2a', 125, '#e31a1c', 150, '#b10026']
      }
    });

    // VolumeFlow/NodeFlows: override to gray immediately after creation
    if (graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds') {
      map.setPaintProperty('network-layer', 'line-color', '#aaa');
      map.setPaintProperty('network-layer', 'line-width', 2);
      map.setPaintProperty('network-layer', 'line-opacity', 0.4);
    }
    
    // ensure labels exist for this source
    addLabelLayersIfMissing(map);
    if ((graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')) {
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    } else {
      applyLabelFilter(map, showMajorRoadsOnly);
    }
    
    // if we're not in Volumes, hide them now
    setLabelVisibility(map, graphExpandedRef.current === 'Volumes');
    
    updateNetworkFilter(selectedNetworkModesRef.current);
    
    if (graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds') {
      // VolumeFlow/NodeFlows: clickable road links (car+volume for rich datasets,
      // all links for the stripped per-link merged_segments format), no labels
      map.setFilter('click-network-layer', CLICKABLE_ROAD_FILTER);
      map.setFilter('network-layer', CLICKABLE_ROAD_FILTER);
    } else if (graphExpandedRef.current === 'Volumes') {
      // Volumes: car roads + optional major roads filter
      const carFilter = ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0];
      let filter = carFilter;
      if (showMajorRoadsOnly) {
        filter = ['all', carFilter, ['>', ['get', 'capacity'], 1200]];
      }
      map.setFilter('click-network-layer', filter);
      map.setFilter('network-layer', filter);
      if (map.getLayer('network-highlight')) map.setFilter('network-highlight', filter);
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
      addLabelLayersIfMissing(map);
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    }
    
    const handleIdle = () => { setIsLoading(false); map.off('idle', handleIdle); };
    map.on('idle', handleIdle);
    
    // UPDATED click handler: use clicked feature directly (no single id anymore)
    map.on('click', 'click-network-layer', (e) => {
      if (!e.features.length) return;
      // VolumeFlow/NodeFlows have their own click handler on this layer
      if (graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows') return;
      // LinkSpeeds: at zoom >= 15 only the split layer's click handler applies.
      // Merged (per_id_keys) selection would be wrong when the split visual is
      // on-screen, so suppress this base handler entirely past the threshold.
      if (graphExpandedRef.current === 'LinkSpeeds' && map.getZoom() >= 15) return;

      // Skip selection when actively drawing or clicking on draw features
      if (drawRef?.current) {
        const mode = drawRef.current.getMode();
        if (mode === 'draw_polygon' || mode === 'direct_select') return;
        const clickedLayers = map.queryRenderedFeatures(e.point).map(fl => fl.layer.id);
        if (clickedLayers.some(id => id.startsWith('gl-draw'))) return;
        // Clear drawn polygons on single-click selection
        if (drawRef.current.getAll?.()?.features?.length > 0) {
          drawRef.current.deleteAll();
          map.fire('draw.delete', { features: [] });
        }
      }
      
      safeRemoveLayer(map, ['ant-line', 'network-highlight']);
      safeRemoveSource(map, ['network-highlight']);
      
      const clicked = e.features[0]; // full feature
      const highlightGeoJSON = { type: 'FeatureCollection', features: [clicked] };
      
      map.addSource('network-highlight', { type: 'geojson', data: highlightGeoJSON });
      map.addLayer({
        id: 'network-highlight',
        type: 'line',
        source: 'network-highlight',
        paint: {
          'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 6, 4000, 15],
          'line-color': '#00a2ff',
          'line-opacity': 1
        }
      }, 'network-layer');
      
      // keep your sidebar selection shape: an array of property objects
      setSelectedNetworkFeature([clicked.properties]);

      // Also set featureSelection so the highlight persists across module switches
      const g = clicked.geometry;
      const coords = g?.type === 'LineString'
        ? g.coordinates
        : g?.type === 'MultiLineString'
          ? g.coordinates.flat()
          : null;
      if (coords && setFeatureSelection) {
        setFeatureSelection({ id: clicked.properties.per_id_keys, feature: clicked, coords, fromMap: true });
      }
    });

    // Pointer cursor on hover over clickable network links
    map.on('mouseenter', 'click-network-layer', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'click-network-layer', () => {
      map.getCanvas().style.cursor = '';
    });
  };
  
  // --------- UPDATING NETWORK BY MODE ----------
  const updateNetworkFilter = (modes) => {
    const map = mapRef.current;
    if (!map || !map.getLayer('network-layer')) return;
    
    // If "all" modes selected, remove filter (or apply car filter for VolumeFlow)
    if (!modes || modes.includes('all')) {
      if (graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds') {
        // VolumeFlow/NodeFlows: clickable road links (tolerates stripped format)
        setFilter(map, ['network-layer', 'click-network-layer'], CLICKABLE_ROAD_FILTER);
      } else {
        setFilter(map, ['network-layer', 'click-network-layer', 'network-highlight'], null);
      }
      // In Volumes, labels stay car-only regardless of sidebar mode filter
      if (graphExpandedRef.current === 'Volumes') {
        applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
      } else {
        // In Network / VolumeFlow, clear label filter
        applyLabelFilter(map, null);
      }
    } else {
      // Wrap modes with commas for exact matching (prevents "car" matching "cable car")
      const wrappedModes = ['concat', ',', ['get', 'modes'], ','];
      const filter = [
        'any',
        ...modes.map(mode => ['>=', ['index-of', `,${mode},`, wrappedModes], 0])
      ];
      setFilter(map, ['network-layer', 'click-network-layer', 'network-highlight'], filter);
      if ((graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')) {
        // Keep labels car-only in Volumes
        applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
      } else {
        // Mirror selected modes to labels in Network view
        setFilter(map, LABEL_IDS, filter);
      }
    }
  };
  
  useEffect(() => {
    if (!mapRef.current) return;
    selectedNetworkModesRef.current = selectedNetworkModes;
    updateNetworkFilter(selectedNetworkModes);
  }, [selectedNetworkModes]);
  
  
  // update label size on map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (graphExpandedRef.current !== 'Volumes') return;
    
    const ids = ['network-label-left', 'network-label-right'];
    ids.forEach(id => {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'text-size', Number(labelSize) || 11);
      }
    });
  }, [labelSize, isGraphExpanded]); 
  
  // major roads filter changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !(graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')) return;

    // Exact match for "car" mode (prevents matching "cable car")
    const carFilter = ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0];
    let fullFilter;
    if (isGraphExpanded === 'VolumeFlow' || isGraphExpanded === 'NodeFlows' || isGraphExpanded === 'LinkSpeeds') {
      // VolumeFlow/NodeFlows: clickable road links (never major-only; tolerates
      // the stripped per-link merged_segments format that lacks modes/volume)
      fullFilter = CLICKABLE_ROAD_FILTER;
    } else if (showMajorRoadsOnly) {
      fullFilter = ['all', carFilter, ['>', ['get', 'capacity'], 1200]];
    } else {
      fullFilter = carFilter;
    }
    
    if (!showMajorRoadsOnly && originalNetworkGeoJSON) {
      const source = map.getSource('network-source');
      if (source) source.setData(originalNetworkGeoJSON.current);
    }
    
    setFilter(map, ['network-layer', 'click-network-layer', 'network-highlight'], fullFilter);

    // Clear selection if the highlighted feature is filtered out (e.g. non-car link in Volumes)
    if (map.getSource('network-highlight') && map.getLayer('network-highlight')) {
      const visible = map.querySourceFeatures('network-highlight', { filter: fullFilter });
      if (!visible.length) {
        setSelectedNetworkFeature(null);
        setFeatureSelection(null);
      }
    }

    // filter labels too
    if ((graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')) {
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    }
  }, [showMajorRoadsOnly, isGraphExpanded, originalNetworkGeoJSON]);
  
  // ANT PATH — pass `isGraphExpanded` so the effect re-runs (and cleans up
  // the ant-line layer) when the user switches to a module that doesn't own
  // this overlay (e.g. TransitStops).
  useAntPath(mapRef, visualizeLinkId, graphExpandedRef, isGraphExpanded, visualizeNonce);
  
  // Module switching (keep your logic; also update color ramps)
  useEffect(() => {
    const map = mapRef.current;
    const canton = searchCanton;
    
    if (!map || !canton) return;
    
    // Fully remove network layers + source. Used when switching to a module
    // (e.g. TransitVolumes) that renders its own styling off the same network
    // geometry — leaving hidden network layers around causes z-order issues
    // because other hooks insert their layers below `canton-highlight`.
    const NETWORK_LAYERS = ['network-layer','click-network-layer','network-highlight',
      'network-label-left','network-label-right'];

    const removeAll = () => {
      safeRemoveLayer(map, NETWORK_LAYERS);
      safeRemoveSource(map, ['network-source','network-highlight','ant-path']);
    };

      const show = () => setVisibility(map, NETWORK_LAYERS, true);
        
        if (isGraphExpanded === 'Network' || isGraphExpanded === 'Volumes' || isGraphExpanded === 'VolumeFlow' || isGraphExpanded === 'NodeFlows' || isGraphExpanded === 'LinkSpeeds') {
          if (map.getLayer('network-layer')) {
            show();
            // Always re-sync featureGeoJSON on entry to any network module — the
            // context value may have been cleared by another module (e.g. Transit
            // stops) or never set in this session. Consumers (VolumeFlow,
            // NodeFlows, LinkSpeeds) read it via a ref and break silently if null.
            const source = map.getSource('network-source');
            if (source && originalNetworkGeoJSON.current) {
              source.setData(originalNetworkGeoJSON.current);
              setFeatureGeoJSON?.(originalNetworkGeoJSON.current);
            } else if (source && !originalNetworkGeoJSON.current) {
              loadNetworkForCanton(canton);
            }
            if (isGraphExpanded === 'Network') {
              setFilter(map, ['network-layer','click-network-layer','network-highlight'], null);
              setLabelVisibility(map, false);
            }
          } else {
            loadNetworkForCanton(canton);
            addLabelLayersIfMissing(map);          
            applyLabelFilter(map, showMajorRoadsOnly);
            if ((graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')) {
              applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
            }
          }
        } else {
          removeAll();
          originalNetworkGeoJSON.current = null;
          setLinkVolumeData(null);
          setFeatureGeoJSON?.(null);
          setSelectedNetworkFeature(null);
          return;
        }
        
        if (!map.getLayer('network-layer')) return;
        
        if (isGraphExpanded === 'VolumeFlow' || isGraphExpanded === 'NodeFlows' || isGraphExpanded === 'LinkSpeeds') {
          // VolumeFlow/NodeFlows: subtle gray roads, flat click hitbox, no labels
          map.setPaintProperty('network-layer', 'line-color', '#aaa');
          map.setPaintProperty('network-layer', 'line-width', 2);
          map.setPaintProperty('network-layer', 'line-opacity', 0.4);
          map.setPaintProperty('click-network-layer', 'line-width', 10);
          setLabelVisibility(map, false);
          // Clickable road links (tolerates stripped per-link merged_segments format)
          setFilter(map, ['network-layer', 'click-network-layer'], CLICKABLE_ROAD_FILTER);
        } else {
          // Network / Volumes: full color ramp
          const colorRamp = isGraphExpanded === 'Volumes'
            ? ['interpolate', ['linear'], ['get', 'daily_avg_volume'],
              0, '#ffffcc', 50, '#c2e699', 100, '#78c679', 250, '#31a354', 500, '#006837']
            : ['interpolate', ['linear'], ['get', 'freespeed'],
              0, '#ffffb2', 25, '#fed976', 50, '#feb24c', 75, '#fd8d3c', 100, '#fc4e2a', 125, '#e31a1c', 150, '#b10026'];
          map.setPaintProperty('network-layer', 'line-color', colorRamp);
          map.setPaintProperty('network-layer', 'line-width',
            ['interpolate', ['linear'], ['get', 'capacity'], 300, 1, 4000, 8]);
          map.setPaintProperty('network-layer', 'line-opacity', 1);
          map.setPaintProperty('click-network-layer', 'line-width',
            ['interpolate', ['linear'], ['get', 'capacity'], 300, 10, 4000, 21]);
        }
        
        if (map.getLayer('ant-line')) map.removeLayer('ant-line');
      }, [isGraphExpanded]);
      
      // --- LOAD per-link hourly volumes (unchanged path format you use) ----------
      useEffect(() => {
        const loadAllLinkVolumes = async () => {
          if (!searchCanton || graphExpandedRef.current !== 'Volumes') return;
          try {
            const path = `matsim/${searchCanton}_link_traffic_volumes.json`;
            const raw = await loadWithFallback(path);
            const volumeMap = Object.fromEntries(
              raw.map(e => [e.link_id.toString(), e.hourly_avg_volumes])
            );
            setLinkVolumeData(volumeMap);
          } catch (err) {
            console.warn('Failed to load all link volumes', err);
          }
        };
        loadAllLinkVolumes();
      }, [searchCanton, isGraphExpanded]);
      
      // --- APPLY timeRange to both line data and labels --------------------------
      useEffect(() => {
        const map = mapRef.current;
        if (!map || graphExpandedRef.current !== 'Volumes') return;
        
        const source = map.getSource('network-source');
        if (!source || !source._data) return;
        
        const startHour = Math.floor((timeRange?.[0] ?? 0) / 4);
        const endHour   = Math.ceil((timeRange?.[1] ?? 96) / 4);
        
        // update line features' total volume
        const updatedLineFeatures = source._data.features.map(f => {
          if (!f?.properties?.per_id_keys) return f; // nothing to recompute
          recomputeVolumesForFeature(f, startHour, endHour);
          return f;
        });
        
        const updatedGeo = { ...source._data, features: updatedLineFeatures };
        source.setData(updatedGeo);

        // Update feature table with new filtered volumes
        setFeatureGeoJSON?.(updatedGeo);

        // Clear the slider-triggered map loading overlay once the new GeoJSON
        // is parsed and rendered. Using 'idle' would hang indefinitely when
        // the ant-path animation keeps repainting; 'sourcedata' fires per
        // setData and is the right signal here.
        if (setMapLoading) {
          const onSourceData = (e) => {
            if (e.sourceId !== 'network-source' || !e.isSourceLoaded) return;
            map.off('sourcedata', onSourceData);
            setMapLoading(false);
          };
          map.on('sourcedata', onSourceData);
        }

      }, [timeRange, linkVolumeData, isGraphExpanded, showMajorRoadsOnly]);
      
      // --- Canton change / cleanup ----------------------------------------------
      useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        
        if (searchCanton && (graphExpandedRef.current === 'Network' || graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')) {
          loadNetworkForCanton(searchCanton);
        } else {
          safeRemoveLayer(map, ['network-layer','click-network-layer','network-highlight',
            'network-label-left','network-label-right']);
          safeRemoveSource(map, ['network-source','network-highlight','ant-path']);
          }
        }, [searchCanton]);

        useEffect(() => {
          const map = mapRef.current;
          if (!map) return;

          safeRemoveLayer(map, [
            'network-layer','click-network-layer','ant-line','network-highlight',
            'network-label-left','network-label-right',
          ]);
          safeRemoveSource(map, ['network-source','ant-path','network-highlight']);
          
          originalNetworkGeoJSON.current = null;
          setLinkVolumeData(null);
          setFeatureGeoJSON?.(null); 
          setSelectedNetworkFeature(null);
        }, [resetMapTrigger]);
      }

