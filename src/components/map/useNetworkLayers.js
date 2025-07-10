import { useEffect, useState, useRef } from 'react';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';

export default function useNetworkLayers({
  mapRef,
  canton,
  dataURL,
  selectedNetworkModes,
  showMajorRoadsOnly,
  timeRange,
  visualizeLinkId,
  setSelectedNetworkFeature,
  isGraphExpanded,
}) {
  const [isLoading, setIsLoading] = useState(false);
  const originalNetworkGeoJSON = useRef(null);
  const [volumeMap, setVolumeMap] = useState(null);
  const loadWithFallback = useLoadWithFallback(dataURL);
  const loadedCanton = useRef(null);

  // ---------------------- FILTER UTILITY ----------------------
  function updateFilter(map) {
    if (!map.getLayer('network-layer')) return;

    // 1) NETWORK mode → filter by selectedNetworkModes
    if (isGraphExpanded === 'Network') {
      if (!selectedNetworkModes || selectedNetworkModes.includes('all')) {
        map.setFilter('network-layer', null);
        map.setFilter('click-network-layer', null);
        if (map.getLayer('network-highlight'))
          map.setFilter('network-highlight', null);
      } else {
        const modeFilter = [
          'any',
          ...selectedNetworkModes.map(mode =>
            ['match', ['index-of', mode, ['get', 'modes']], -1, false, true]
          )
        ];
        map.setFilter('network-layer', modeFilter);
        map.setFilter('click-network-layer', modeFilter);
        if (map.getLayer('network-highlight'))
          map.setFilter('network-highlight', modeFilter);
      }
      return;
    }

    // 2) VOLUMES mode → car-only + majorOnly
    if (isGraphExpanded === 'Volumes') {
      const carFilter = [
        'match',
        ['index-of', 'car', ['get', 'modes']],
        -1, false, true
      ];
      const finalFilter = showMajorRoadsOnly
        ? ['all', carFilter, ['>', ['get','capacity'], 1000]]
        : carFilter;
      map.setFilter('network-layer', finalFilter);
      map.setFilter('click-network-layer', finalFilter);
      if (map.getLayer('network-highlight'))
        map.setFilter('network-highlight', finalFilter);
      return;
    }

    // 3) other modules → clear
    map.setFilter('network-layer', null);
    map.setFilter('click-network-layer', null);
    if (map.getLayer('network-highlight'))
      map.setFilter('network-highlight', null);
  }

  // ---------------------- LOAD / RELOAD NETWORK ----------------------
  
  async function loadNetworkForCanton(name) {
    const map = mapRef.current;
    if (!map || !name) return;

    // teardown old network & highlight
    ['network-layer','click-network-layer','ant-line','network-highlight']
      .forEach(id => map.getLayer(id) && map.removeLayer(id));
    ['network-source','ant-path','network-highlight']
      .forEach(id => map.getSource(id) && map.removeSource(id));

    setIsLoading(true);
    setSelectedNetworkFeature(null);
    setVolumeMap(null);

    let net;
    try {
      net = await loadWithFallback(`matsim/matsim_network_${name}.geojson`);
    } catch (err) {
      console.warn(`Failed to load network for ${name}`, err);
      setIsLoading(false);
      return;
    }
    if (!net) {
      setIsLoading(false);
      return;
    }

    originalNetworkGeoJSON.current = net;
    map.addSource('network-source', { type: 'geojson', data: net });

    // invisible click layer
    map.addLayer({
      id: 'click-network-layer',
      type: 'line',
      source: 'network-source',
      paint: {
        'line-width': ['interpolate',['linear'],['get','capacity'],300,7,4000,14],
        'line-opacity': 0
      }
    });

    // main network layer
    const ramp = isGraphExpanded === 'Volumes'
      ? ['interpolate',['linear'],['get','daily_avg_volume'],0,'#ffffcc',50,'#c2e699',100,'#78c679',250,'#31a354',500,'#006837']
      : ['interpolate',['linear'],['get','freespeed'],0,'#ffffb2',6.94,'#fed976',13.89,'#feb24c',20.83,'#fd8d3c',27.78,'#fc4e2a',34.72,'#e31a1c',41.67,'#b10026'];

    map.addLayer({
      id: 'network-layer',
      type: 'line',
      source: 'network-source',
      paint: {
        'line-width': ['interpolate',['linear'],['get','capacity'],300,1,4000,8],
        'line-color': ramp
      }
    });

    updateFilter(map);

    // hide spinner when done
    const onIdle = () => {
      setIsLoading(false);
      map.off('idle', onIdle);
    };
    map.on('idle', onIdle);

    // click‐to‐highlight
    const onClick = e => {
      if (!e.features.length) return;
      if (map.getLayer('network-highlight'))
        map.removeLayer('network-highlight');
      if (map.getSource('network-highlight'))
        map.removeSource('network-highlight');

      const picked = e.features[0].properties.id;
      const full = map.getSource('network-source')._data.features
        .find(f => f.properties.id === picked);
      if (!full) return;

      map.addSource('network-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [full] }
      });
      map.addLayer({
        id: 'network-highlight',
        type: 'line',
        source: 'network-highlight',
        paint: {
          'line-width': ['interpolate',['linear'],['get','capacity'],300,5,4000,14],
          'line-color':'#8affff',
          'line-opacity':1
        }
      }, 'network-layer');

      setSelectedNetworkFeature([e.features[0].properties]);
    };
    map.on('click', 'click-network-layer', onClick);
  }

  useEffect(() => {
  const map = mapRef.current;
  if (!map) return;

  const isNetworkTab = isGraphExpanded === 'Network';
  const isVolumesTab = isGraphExpanded === 'Volumes';
  const shouldShow = (isNetworkTab || isVolumesTab) && !!canton;

  if (shouldShow) {
    if (loadedCanton.current !== canton) {
      loadedCanton.current = canton;
      loadNetworkForCanton(canton);
    } else {
      ['network-layer','click-network-layer','network-highlight']
        .forEach(id => map.getLayer(id) && map.setLayoutProperty(id,'visibility','visible'));

      const ramp = isVolumesTab
        ? ['interpolate',['linear'],['get','daily_avg_volume'],0,'#ffffcc',50,'#c2e699',100,'#78c679',250,'#31a354',500,'#006837']
        : ['interpolate',['linear'],['get','freespeed'],0,'#ffffb2',6.94,'#fed976',13.89,'#feb24c',20.83,'#fd8d3c',27.78,'#fc4e2a',34.72,'#e31a1c',41.67,'#b10026'];
      map.setPaintProperty('network-layer','line-color', ramp);
      updateFilter(map);
    }
  } else {
    ['network-layer','click-network-layer','network-highlight']
      .forEach(id => map.getLayer(id) && map.setLayoutProperty(id,'visibility','none'));
    loadedCanton.current = null;
  }
}, [mapRef, canton, isGraphExpanded]);

  // ---------------------- REAPPLY FILTERS on parameter change ----------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    updateFilter(map);
  }, [
    mapRef,
    isGraphExpanded,
    showMajorRoadsOnly,
    selectedNetworkModes
  ]);

  // ---------------------- LOAD VOLUME DATA for Volumes mode ----------------------
  useEffect(() => {
    if (isGraphExpanded !== 'Volumes' || !canton) {
      setVolumeMap(null);
      return;
    }
    loadWithFallback(`matsim/${canton}_link_traffic_volumes.json`)
      .then(raw => {
        // array of { link_id, hourly_avg_volumes }
        // map to { idStr: hourlyMap }
        const vm = Object.fromEntries(
          raw.map(e => [e.link_id.toString(), e.hourly_avg_volumes])
        );
        setVolumeMap(vm);
      })
      .catch(err => console.warn('Vol data load failed', err));
  }, [canton, isGraphExpanded]);

  // ---------------------- UPDATE DAILY_AVG_VOLUME & RAMP on timeRange ----------------------
  useEffect(() => {
    const map = mapRef.current;
    if (
      !map ||
      isGraphExpanded !== 'Volumes' ||
      !volumeMap ||
      !originalNetworkGeoJSON.current
    ) return;

    const start = Math.floor((timeRange[0] ?? 0) / 4);
    const end   = Math.ceil((timeRange[1] ?? 96) / 4);

    const updatedFeatures = originalNetworkGeoJSON.current.features.map(f => {
      const cap = f.properties.capacity ?? 0;
      const vols = volumeMap[f.properties.id.toString()] || {};
      let total = 0;
      for (let h = start; h < end; h++) {
        const key = `HRS${h}-${h+1}avg`;
        total += vols[key] ?? 0;
      }
      return {
        ...f,
        properties: {
          ...f.properties,
          daily_avg_volume: total
        }
      };
    });

    const newData = {
      ...originalNetworkGeoJSON.current,
      features: updatedFeatures
    };
    map.getSource('network-source').setData(newData);

    // also update the paint ramp
    const ramp = [
      'interpolate',['linear'],['get','daily_avg_volume'],
      0,'#ffffcc',50,'#c2e699',100,'#78c679',250,'#31a354',500,'#006837'
    ];
    map.setPaintProperty('network-layer','line-color', ramp);

    // reapply filter in case majorOnly changed
    updateFilter(map);
  }, [
    mapRef,
    timeRange,
    volumeMap,
    showMajorRoadsOnly,
    isGraphExpanded
  ]);

  // ---------------------- ANT-PATH ANIMATION ----------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !visualizeLinkId) return;
    const src = map.getSource('network-source');
    if (!src?._data) return;

    const feat = src._data.features.find(f => f.properties.id === visualizeLinkId);
    if (!feat) return;
    const coords = feat.geometry.type === 'LineString'
      ? feat.geometry.coordinates
      : feat.geometry.type === 'MultiLineString'
        ? feat.geometry.coordinates.flat()
        : [];
    if (coords.length < 2) return;

    if (map.getLayer('ant-line')) map.removeLayer('ant-line');
    if (map.getSource('ant-path')) map.removeSource('ant-path');

    map.addSource('ant-path', { type: 'geojson', data: {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: {}
    }});
    map.addLayer({
      id: 'ant-line',
      type: 'line',
      source: 'ant-path',
      layout: {},
      paint: { 'line-color':'#FF00FF','line-width':4,'line-dasharray':[3,3] }
    });

    const seq = [
      [0,0.3,3,2.7],[0,0.6,3,2.4],[0,0.9,3,2.1],[0,1.2,3,1.8],
      [0,1.5,3,1.5],[0,1.8,3,1.2],[0,2.1,3,0.9],[0,2.4,3,0.6],
      [0,2.7,3,0.3],[0,3.0,3,0],[0.3,3,2.7,0],[0.6,3,2.4,0],
      [0.9,3,2.1,0],[1.2,3,1.8,0],[1.5,3,1.5,0],[1.8,3,1.2,0],
      [2.1,3,0.9,0],[2.4,3,0.6,0],[2.7,3,0.3,0],[3,3,0,0]
    ];
    let idx = 0, last = 0, interval = 50;
    function animate(ts) {
      if (!map.getLayer('ant-line')) return;
      if (ts - last >= interval) {
        idx = (idx + 1) % seq.length;
        map.setPaintProperty('ant-line','line-dasharray', seq[idx]);
        last = ts;
      }
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);

    return () => {
      if (map.getLayer('ant-line')) map.removeLayer('ant-line');
      if (map.getSource('ant-path')) map.removeSource('ant-path');
    };
  }, [mapRef, visualizeLinkId]);

  return { isLoading };
}
