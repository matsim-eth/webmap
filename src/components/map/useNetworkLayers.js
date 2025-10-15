import { useEffect, useRef, useState } from 'react';
import useAntPath from './useAntPath';

export default function useNetworkLayers({
  mapRef,
  searchCanton,
  loadWithFallback,
  selectedNetworkModes,
  showMajorRoadsOnly,
  timeRange,
  visualizeLinkId,
  setSelectedNetworkFeature,
  isGraphExpanded,
  resetMapTrigger,
  graphExpandedRef,
  setIsLoading,
  labelSize,
  setFeatureGeoJSON
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
    const keys = (props.per_id_keys || "").split("|").filter(Boolean);
    const arrows = (props.per_id_arrows || "").split("|").filter(Boolean);
    const daily_avgs = (props.per_id_daily_avgs || "").split("|").filter(Boolean);
    
    let left = 0, right = 0;
    
    keys.forEach((id, index) => {
      const hourly = linkVolumeData?.[id.toString()];
      let s = 0;
      if (hourly) {
        for (let h = startHour; h < endHour; h++) {
          const key = `HRS${h}-${h + 1}avg`;
          s += hourly[key] ?? 0;
        }
      } else {
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
  
  const setLabelVisibility = (map, visible) => {
    const v = visible ? 'visible' : 'none';
    LABEL_IDS.forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v); });
  };
  
  const applyLabelFilter = (map, showMajorRoadsOnly) => {
    const labelFilter = showMajorRoadsOnly ? ['>', ['get', 'capacity'], 1200] : null;
    LABEL_IDS.forEach(id => { if (map.getLayer(id)) map.setFilter(id, labelFilter); });
  };
  
  // Ensure labels in Volumes mode are always car-only (optionally major roads only)
  const applyLabelCarAndMajorFilter = (map, showMajorRoadsOnly) => {
    const carFilter = ['match', ['index-of', 'car', ['get', 'modes']], -1, false, true];
    const labelFilter = showMajorRoadsOnly
    ? ['all', carFilter, ['>', ['get', 'capacity'], 1200]]
    : carFilter;
    LABEL_IDS.forEach(id => { if (map.getLayer(id)) map.setFilter(id, labelFilter); });
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
    
    const layersToRemove = [
      'network-layer', 'click-network-layer', 'ant-line', 'network-highlight',
      'network-label-left', 'network-label-right'
    ];
    const sourcesToRemove = ['network-source', 'network-highlight', 'ant-path'];
    
    layersToRemove.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
    sourcesToRemove.forEach(id => { if (map.getSource(id)) map.removeSource(id); });
    
    setIsLoading(true);
    setSelectedNetworkFeature(null);
    
    // NEW: fixed filename you gave
    const relativePath = `matsim/${cantonName}_merged_segments.geojson`;
    
    let networkGeojson;
    try {
      networkGeojson = await loadWithFallback(relativePath);
    } catch (error) {
      console.warn(`Failed to load network`, error);
      // clear prop if failed
      setFeatureGeoJSON?.(null);
      return;
    }
    if (!networkGeojson) {
      setFeatureGeoJSON?.(null);
      return;
    }
    
    originalNetworkGeoJSON.current = networkGeojson;

    const decorateLineVolumesFromPerId = (features) => {
      for (const f of features) {
        if (!f?.properties) f.properties = {};
        
        // Ensure angle exists
        if (f.geometry?.type === 'LineString' && f.geometry.coordinates?.length > 1) {
          if (typeof f.properties.angle !== 'number') {
            const coords = f.geometry.coordinates;
            const [x0, y0] = coords[0];
            const [x1, y1] = coords[coords.length - 1];
            const dx = x1 - x0, dy = y1 - y0;
            f.properties.angle = (dx === 0 && dy === 0) ? null : (Math.atan2(dy, dx) * 180 / Math.PI);
          }
        } else {
          f.properties.angle = null;
        }
        
        // Parse pipe-separated strings
        const arrows = (f.properties.per_id_arrows || "").split("|").filter(Boolean);
        const daily_avgs = (f.properties.per_id_daily_avgs || "").split("|").filter(Boolean);
        
        // Aggregate left/right totals from per_id entries
        let left = 0, right = 0;
        arrows.forEach((arrow, index) => {
          const v = Number(daily_avgs[index] ?? 0);
          if (arrow === '←') left += v;
          else if (arrow === '→') right += v;
        });
        
        // Ensure these three exist on EVERY feature
        const fallbackTotal = left + right;
        f.properties.daily_avg_volume = Number.isFinite(Number(f.properties.daily_avg_volume))
        ? Number(f.properties.daily_avg_volume)
        : fallbackTotal;
        f.properties.left_sum = left;
        f.properties.right_sum = right;
      }
    };
    
    decorateLineVolumesFromPerId(networkGeojson.features);
    
    setFeatureGeoJSON?.(networkGeojson);
    
    map.addSource('network-source', { type: 'geojson', data: networkGeojson });
    
    map.addLayer({
      id: 'click-network-layer',
      type: 'line',
      source: 'network-source',
      paint: {
        'line-width': ['interpolate', ['linear'], ['get', 'capacity'], 300, 7, 4000, 14],
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
        (graphExpandedRef.current === 'Volumes')
        ? ['interpolate', ['linear'], ['get', 'daily_avg_volume'],
        0, '#ffffcc', 50, '#c2e699', 100, '#78c679', 250, '#31a354', 500, '#006837']
        : ['interpolate', ['linear'], ['get', 'freespeed'],
        0, '#ffffb2', 25, '#fed976', 50, '#feb24c', 75, '#fd8d3c', 100, '#fc4e2a', 125, '#e31a1c', 150, '#b10026']
      }
    });
    
    // ensure labels exist for this source
    addLabelLayersIfMissing(map);
    if (graphExpandedRef.current === 'Volumes') {
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    } else {
      applyLabelFilter(map, showMajorRoadsOnly);
    }
    
    // if we're not in Volumes, hide them now
    setLabelVisibility(map, graphExpandedRef.current === 'Volumes');
    
    updateNetworkFilter(selectedNetworkModesRef.current);
    
    if (graphExpandedRef.current === 'Volumes') {
      const carFilter = ['match', ['index-of', 'car', ['get', 'modes']], -1, false, true];
      let filter = carFilter;
      if (showMajorRoadsOnly) {
        filter = ['all', carFilter, ['>', ['get', 'capacity'], 1200]];
      }
      map.setFilter('click-network-layer', filter);
      map.setFilter('network-layer', filter);
      if (map.getLayer('network-highlight')) map.setFilter('network-highlight', filter);
      // labels mirror car (+major roads) filter in Volumes
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    }
    if (graphExpandedRef.current === 'Volumes') {
      addLabelLayersIfMissing(map);
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    }
    
    const handleIdle = () => { setIsLoading(false); map.off('idle', handleIdle); };
    map.on('idle', handleIdle);
    
    // UPDATED click handler: use clicked feature directly (no single id anymore)
    map.on('click', 'click-network-layer', (e) => {
      if (!e.features.length) return;
      
      if (map.getLayer('ant-line')) map.removeLayer('ant-line');
      ['network-highlight'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      });
      
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
      console.log('Clicked network feature:', clicked.properties);
    });
  };
  
  // --------- UPDATING NETWORK BY MODE ----------
  const updateNetworkFilter = (modes) => {
    const map = mapRef.current;
    if (!map || !map.getLayer('network-layer')) return;
    
    // If "all" modes selected, remove filter
    if (!modes || modes.includes('all')) {
      ['network-layer', 'click-network-layer', 'network-highlight'].forEach(id => {
        if (map.getLayer(id)) map.setFilter(id, null);
      });
      // In Volumes, labels stay car-only regardless of sidebar mode filter
      if (graphExpandedRef.current === 'Volumes') {
        applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
      } else {
        // In Network, clear label filter too
        applyLabelFilter(map, null);
      }
    } else {
      const filter = [
        'any',
        ...modes.map(mode => ['match', ['index-of', mode, ['get', 'modes']], -1, false, true])
      ];
      ['network-layer', 'click-network-layer', 'network-highlight'].forEach(id => {
        if (map.getLayer(id)) map.setFilter(id, filter);
      });
      if (graphExpandedRef.current === 'Volumes') {
        // Keep labels car-only in Volumes
        applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
      } else {
        // Mirror selected modes to labels in Network view
        LABEL_IDS.forEach(id => { if (map.getLayer(id)) map.setFilter(id, filter); });
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
    if (!map || graphExpandedRef.current !== 'Volumes') return;
    
    const carFilter = ['match', ['index-of', 'car', ['get', 'modes']], -1, false, true];
    const fullFilter =
    isGraphExpanded === 'Volumes' && showMajorRoadsOnly
    ? ['all', carFilter, ['>', ['get', 'capacity'], 1200]]
    : carFilter;
    
    if (!showMajorRoadsOnly && originalNetworkGeoJSON) {
      const source = map.getSource('network-source');
      if (source) source.setData(originalNetworkGeoJSON.current);
    }
    
    ['network-layer', 'click-network-layer', 'network-highlight'].forEach(id => {
      if (map.getLayer(id)) map.setFilter(id, fullFilter);
    });
    
    // filter labels too
    if (graphExpandedRef.current === 'Volumes') {
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    }
  }, [showMajorRoadsOnly, isGraphExpanded, originalNetworkGeoJSON]);
  
  // ANT PATH (unchanged)
  useAntPath(mapRef, visualizeLinkId, graphExpandedRef);
  
  // Module switching (keep your logic; also update color ramps)
  useEffect(() => {
    const map = mapRef.current;
    const canton = searchCanton;
    
    if (!map || !canton) return;
    
    const hide = () => ['network-layer','click-network-layer','network-highlight',
      'network-label-left','network-label-right']
      .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
      
      const show = () => ['network-layer','click-network-layer','network-highlight',
        'network-label-left','network-label-right']
        .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'visible'); });
        
        if (isGraphExpanded === 'Network' || isGraphExpanded === 'Volumes') {
          if (map.getLayer('network-layer')) {
            show();
            if (isGraphExpanded === 'Network') {
              const source = map.getSource('network-source');
              if (source && originalNetworkGeoJSON.current) source.setData(originalNetworkGeoJSON.current);
              ['network-layer','click-network-layer','network-highlight'].forEach(id => {
                if (map.getLayer(id)) map.setFilter(id, null);
              });
              setLabelVisibility(map, false);
            }
          } else {
            loadNetworkForCanton(canton);
            addLabelLayersIfMissing(map);          
            applyLabelFilter(map, showMajorRoadsOnly);
            if (graphExpandedRef.current === 'Volumes') {
              applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
            }
          }
        } else {
          hide();
        }
        
        if (!map.getLayer('network-layer')) return;
        
        const colorRamp = isGraphExpanded === 'Volumes'
        ? ['interpolate', ['linear'], ['get', 'daily_avg_volume'],
        0, '#ffffcc', 50, '#c2e699', 100, '#78c679', 250, '#31a354', 500, '#006837']
        : ['interpolate', ['linear'], ['get', 'freespeed'],
        0, '#ffffb2', 25, '#fed976', 50, '#feb24c', 75, '#fd8d3c', 100, '#fc4e2a', 125, '#e31a1c', 150, '#b10026']
        
        map.setPaintProperty('network-layer', 'line-color', colorRamp);
        
        if (map.getLayer('ant-line')) map.removeLayer('ant-line');
        
        // keep your highlight validity for car mode...
        if (map.getSource('network-highlight')) {
          const source = map.getSource('network-highlight');
          let hasCarMode = false;
          if (source && source._data) {
            const features = source._data.features;
            hasCarMode = features.some(f => f.properties?.modes?.split(',').includes('car'));
          }
          if (!hasCarMode) {
            setSelectedNetworkFeature(null);
            if (isGraphExpanded === 'Network' && source?._data?.features?.[0]) {
              setSelectedNetworkFeature([source._data.features[0].properties]);
            }
          }
        }
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
        
        // update line features’ total volume
        const updatedLineFeatures = source._data.features.map(f => {
          if (!f?.properties?.per_id) return f; // nothing to recompute
          recomputeVolumesForFeature(f, startHour, endHour);
          return f;
        });
        
        const updatedGeo = { ...source._data, features: updatedLineFeatures };
        source.setData(updatedGeo);
        
      }, [timeRange, linkVolumeData, isGraphExpanded, showMajorRoadsOnly]);
      
      // --- Canton change / cleanup ----------------------------------------------
      useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        
        if (searchCanton && (graphExpandedRef.current === 'Network' || graphExpandedRef.current === 'Volumes')) {
          loadNetworkForCanton(searchCanton);
        } else {
          ['network-layer','click-network-layer','network-highlight',
            'network-label-left','network-label-right']
            .forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
            
            ['network-source','network-highlight','ant-path']
            .forEach(id => { if (map.getSource(id)) map.removeSource(id); });
          }
        }, [searchCanton]);
        
        useEffect(() => {
          const map = mapRef.current;
          if (!map) return;
          
          const layersToRemove = [
            'network-layer','click-network-layer','ant-line','network-highlight',
            'network-label-left','network-label-right'
          ];
          const sourcesToRemove = ['network-source','ant-path','network-highlight'];
          
          layersToRemove.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
          sourcesToRemove.forEach(id => { if (map.getSource(id)) map.removeSource(id); });
          
          originalNetworkGeoJSON.current = null;
          setLinkVolumeData(null);
          setFeatureGeoJSON?.(null); 
          setSelectedNetworkFeature(null);
        }, [resetMapTrigger]);
      }

