import { useEffect } from 'react';
import { useLoadWithFallback } from '../../utils/useLoadWithFallback';

/**
 * Loads + renders MatSim transit stops with optional volume symbology.
 */
export default function useTransitStops({
  mapRef,
  canton,
  dataURL,
  selectedTransitModes,
  showStopVolumeSymbology,
  setSelectedTransitStop,
  setHighlightedLineId,
  highlightedLineId,
  setHighlightedRouteIds,
  hoveredRouteId,
  isGraphExpanded
}) {
  const loadWithFallback = useLoadWithFallback(dataURL);

  // helper to build Mapbox filter from mode list
  const modeFilter = selectedTransitModes.includes('all')
    ? null
    : [
        'any',
        ...selectedTransitModes.map((m) => [
          'match',
          ['index-of', m, ['get', 'modes_list']],
          -1,
          false,
          true,
        ]),
      ];

  useEffect(() => {
    if (!mapRef.current || !canton) return;
    if (isGraphExpanded !== "Transit") return;
    const map = mapRef.current;

    const stopsPath = `matsim/transit/stops_by_canton/${canton}_stops.geojson`;
    const countsPath = `matsim/transit/per_canton_counts/${canton}_counts.json`;

    Promise.all([
      loadWithFallback(stopsPath),
      showStopVolumeSymbology ? loadWithFallback(countsPath) : Promise.resolve(null),
    ]).then(([geojson, counts]) => {
      // --------------- inject volume totals per stop ---------------
      let augmented = geojson;
      if (showStopVolumeSymbology && counts) {
        const totals = {};
        counts.forEach((r) => {
          totals[r.stop_id] =
            (totals[r.stop_id] || 0) +
            r.data.reduce((s, d) => s + d.boardings + d.alightings, 0);
        });
        augmented = {
          ...geojson,
          features: geojson.features.map((f, idx) => ({
            ...f,
            id: idx,
            properties: { ...f.properties, volume: totals[f.properties.stop_id] || 0 },
          })),
        };
      }

      // --------------- add / update source ---------------
      if (!map.getSource('transit-stops')) {
        map.addSource('transit-stops', { type: 'geojson', data: augmented });
      } else {
        map.getSource('transit-stops').setData(augmented);
      }

      // --------------- styling helpers ---------------
      const radiusExpr = showStopVolumeSymbology
        ? [
            'interpolate',
            ['linear'],
            ['get', 'volume'],
            0,
            3,
            100,
            5,
            500,
            10,
            2500,
            15,
            10000,
            20,
          ]
        : 3;

      // --------------- main circles ---------------
      if (!map.getLayer('transit-stops-layer')) {
        map.addLayer({
          id: 'transit-stops-layer',
          type: 'circle',
          source: 'transit-stops',
          paint: {
            'circle-radius': radiusExpr,
            'circle-color': '#ff8800',
            'circle-stroke-color': '#333',
            'circle-stroke-width': 1,
          },
        });
      } else {
        map.setPaintProperty('transit-stops-layer', 'circle-radius', radiusExpr);
      }

      // --------------- labels ---------------
      if (!map.getLayer('transit-stops-label')) {
        map.addLayer({
          id: 'transit-stops-label',
          type: 'symbol',
          source: 'transit-stops',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 12,
            'text-offset': [0, -0.8],
            'text-anchor': 'bottom-left',
          },
          paint: {
            'text-color': '#222',
            'text-halo-color': '#fff',
            'text-halo-width': 1,
          },
          minzoom: 14,
        });
      }

      // --------------- invisible hitbox (bigger radius) ---------------
      if (!map.getLayer('transit-stops-hitbox')) {
        map.addLayer({
          id: 'transit-stops-hitbox',
          type: 'circle',
          source: 'transit-stops',
          paint: { 'circle-radius': 15, 'circle-opacity': 0 },
        });
      }

      // apply mode filter to all layers
      ['transit-stops-layer', 'transit-stops-label', 'transit-stops-hitbox'].forEach((l) => {
        if (map.getLayer(l)) map.setFilter(l, modeFilter);
      });

      // --------------- click interaction ---------------
      map.on('click', 'transit-stops-hitbox', (e) => {
        if (!e.features?.length) return;
        const f = e.features[0];

        // highlight circle
        if (map.getLayer('transit-highlight-layer')) map.removeLayer('transit-highlight-layer');
        if (map.getSource('transit-highlight')) map.removeSource('transit-highlight');

        map.addSource('transit-highlight', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [f] },
        });
        map.addLayer({
          id: 'transit-highlight-layer',
          type: 'circle',
          source: 'transit-highlight',
          paint: {
            'circle-radius': showStopVolumeSymbology ? 8 : 6,
            'circle-color': '#00ffff',
          },
        });

        const props = f.properties;
        setSelectedTransitStop?.(props);
        setHighlightedLineId(null);
        setHighlightedRouteIds([]);
      });
    });
  }, [
    canton,
    dataURL,
    hoveredRouteId,
    loadWithFallback,
    mapRef,
    modeFilter,
    selectedTransitModes,
    setHighlightedLineId,
    setHighlightedRouteIds,
    setSelectedTransitStop,
    showStopVolumeSymbology,
  ]);
}
