import { useEffect, useState, useRef, useCallback } from 'react';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';

export default function useNetworkLayers({
  mapRef,
  canton,
  dataURL,
  selectedNetworkModes,
  visualizeLinkId,
  setSelectedNetworkFeature,
  isGraphExpanded,
}) {
  const loadWithFallback = useLoadWithFallback(dataURL);
  const [isLoading, setIsLoading] = useState(false);
  const modesRef   = useRef(selectedNetworkModes);
  const geoRef     = useRef(null);
  const clickHandlerRef = useRef(null);

  /* ── mode filter helper ─────────────────────────────────────────── */
  const applyModeFilter = useCallback((modes) => {
    const map = mapRef.current;
    if (!map || !map.getLayer('network-layer')) return;

    const filter =
      !modes || modes.includes('all')
        ? null
        : [
            'any',
            ...modes.map((m) => [
              'match',
              ['index-of', m, ['get', 'modes']],
              -1,
              false,
              true,
            ]),
          ];

    ['network-layer', 'click-network-layer', 'network-highlight'].forEach((id) => {
      if (map.getLayer(id)) map.setFilter(id, filter);
    });
  }, [mapRef]);

  /* ── hide / show helper ─────────────────────────────────────────── */
  const setVisibility = useCallback((visible) => {
    const map = mapRef.current;
    ['network-layer', 'click-network-layer', 'network-highlight'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    });
  }, [mapRef]);

  /* ── load network ──────────────────────────────────────────────── */
  const loadNetwork = useCallback(async (c) => {
    const map = mapRef.current;
    if (!map || !c) return;

    setIsLoading(true);
    console.log('[network] Loading', c);

    // remove previous layers & sources
    ['network-layer','click-network-layer','network-highlight','ant-line'].forEach((l)=> map.getLayer(l)&&map.removeLayer(l));
    ['network-source','network-highlight','ant-path'].forEach((s)=> map.getSource(s)&&map.removeSource(s));

    // remove previous click listener
    if (clickHandlerRef.current) {
      map.off('click', 'click-network-layer', clickHandlerRef.current);
      clickHandlerRef.current = null;
    }

    let geo;
    try {
      geo = await loadWithFallback(`matsim/matsim_network_${c}.geojson`);
      console.log('✅  GeoJSON', geo.features.length, 'features');
    } catch (err) {
      console.error('🛑  Fetch failed:', err);
      setIsLoading(false);
      return;
    }
    geoRef.current = geo;

    // add source + layers
    if (!map.getSource('network-source')) {
      map.addSource('network-source', { type: 'geojson', data: geo });
    }

    map.addLayer({
      id: 'network-layer',
      type: 'line',
      source: 'network-source',
      paint: {
        'line-width': [
          'interpolate', ['linear'], ['get','capacity'],
          300,1, 4000,8,
        ],
        'line-color': [
          'interpolate', ['linear'], ['get','freespeed'],
          0,'#ffffb2', 6.94,'#fed976', 13.89,'#feb24c',
          20.83,'#fd8d3c', 27.78,'#fc4e2a',
          34.72,'#e31a1c', 41.67,'#b10026',
        ],
      },
    });

    map.addLayer({
      id: 'click-network-layer',
      type: 'line',
      source: 'network-source',
      paint: { 'line-width': 15, 'line-opacity': 0 },
    });

    /* click ⇒ highlight */
    const handleClick = (e) => {
      if (!e.features?.length) return;
      const id = e.features[0].properties.id;
      const full = geo.features.find((f) => f.properties.id === id);
      if (!full) return;

      if (map.getLayer('network-highlight')) map.removeLayer('network-highlight');
      if (map.getSource('network-highlight')) map.removeSource('network-highlight');

      map.addSource('network-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [full] },
      });

      // put highlight *below* colour-ramp layer
      map.addLayer(
        {
          id: 'network-highlight',
          type: 'line',
          source: 'network-highlight',
          paint: {
            'line-width': [
              'interpolate', ['linear'], ['get','capacity'],
              300,5,4000,14,
            ],
            'line-color': '#8affff',
          },
        },
        'network-layer',
      );

      setSelectedNetworkFeature?.([full.properties]);
    };
    clickHandlerRef.current = handleClick;
    map.on('click', 'click-network-layer', handleClick);

    applyModeFilter(modesRef.current);
    setIsLoading(false);
  }, [applyModeFilter, loadWithFallback, mapRef, setSelectedNetworkFeature]);

  /* ── respond to canton / view changes ─────────────────────────── */
  useEffect(() => {
    if (!canton) return;

    if (['Network','Volumes'].includes(isGraphExpanded)) {
      loadNetwork(canton);
      setVisibility(true);
    } else {
      setVisibility(false); // hide when leaving the module
    }
  }, [canton, isGraphExpanded, loadNetwork, setVisibility]);

  /* ── update mode filter ────────────────────────────────────────── */
  useEffect(() => {
    modesRef.current = selectedNetworkModes;
    applyModeFilter(selectedNetworkModes);
  }, [selectedNetworkModes, applyModeFilter]);

  /* ── ant-path animation ───────────────────────────────────────── */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !visualizeLinkId) return;

    const geo = geoRef.current;
    if (!geo) return;

    const feat = geo.features.find((f) => f.properties.id === visualizeLinkId);
    if (!feat) return;

    const coords = feat.geometry.type === 'LineString'
      ? feat.geometry.coordinates
      : feat.geometry.coordinates.flat();

    if (coords.length < 2) return;

    if (map.getLayer('ant-line')) map.removeLayer('ant-line');
    if (map.getSource('ant-path')) map.removeSource('ant-path');

    map.addSource('ant-path', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } },
    });

    map.addLayer({
      id: 'ant-line',
      type: 'line',
      source: 'ant-path',
      paint: { 'line-color': '#FF00FF', 'line-width': 4, 'line-dasharray': [3, 3] },
    });

    const frames = [...Array(20)].map((_, i) => [i * 0.15, 3, 3 - i * 0.15, 0]);
    let i = 0, last = 0;
    const animate = (ts) => {
      if (!map.getLayer('ant-line')) return;
      if (ts - last > 50) {
        i = (i + 1) % frames.length;
        map.setPaintProperty('ant-line', 'line-dasharray', frames[i]);
        last = ts;
      }
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [visualizeLinkId, mapRef]);

  return { isLoading };
}
