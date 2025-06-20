import { useEffect, useState } from 'react';

/**
 * Fills cantons with mode-share shading (or diff shading).
 */
export default function useChoropleth({
  mapRef,
  dataURL,
  selectedMode,
  selectedDataset,
  aggCol,
}) {
  const [data, setData] = useState(null);
  const [maxSharePerMode, setMaxSharePerMode] = useState(null);

  useEffect(() => {
    fetch(`${dataURL}${aggCol}_share.json`)
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setMaxSharePerMode(d[`max_share_per_${aggCol}`]);
      });
  }, [aggCol, dataURL]);

  const COLOR_MAPS = {
    mode: {
      car: '#636efa',
      car_passenger: '#ef553b',
      pt: '#00cc96',
      bike: '#ab63fa',
      walk: '#ffa15a',
    },
    purpose: {
      education: '#636efa',
      home: '#ef553b',
      leisure: '#00cc96',
      other: '#ab63fa',
      shop: '#ffa15a',
      work: '#FFEE8C',
    },
  };

  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const interp = (c1, c2, t) => {
    const [r1, g1, b1] = hexToRgb(c1);
    const [r2, g2, b2] = hexToRgb(c2);
    return `rgb(${[
      Math.round(r1 + (r2 - r1) * t),
      Math.round(g1 + (g2 - g1) * t),
      Math.round(b1 + (b2 - b1) * t),
    ].join(',')})`;
  };

  useEffect(() => {
    if (!mapRef.current || !data) return;
    const map = mapRef.current;
    if (!map.getLayer('canton-fill')) return;

    if (selectedMode === 'None') {
      map.setPaintProperty('canton-fill', 'fill-opacity', 0.15);
      map.setPaintProperty('canton-fill', 'fill-color', '#A07CC5');
      return;
    }

    const key = aggCol; // 'mode' | 'purpose'
    let colorStops = {};

    if (selectedDataset === 'Difference') {
      const micro = data['Microcensus'].filter((e) => e[key] === selectedMode);
      const synth = data['Synthetic'].filter((e) => e[key] === selectedMode);
      const m = Object.fromEntries(micro.map((e) => [e.canton_name, e.share]));
      const s = Object.fromEntries(synth.map((e) => [e.canton_name, e.share]));

      colorStops = Object.keys(m).reduce((acc, name) => {
        const diff = Math.min(Math.abs((s[name] || 0) - (m[name] || 0)), 0.1);
        acc[name] = interp('#FFFFFF', '#ff0000', diff / 0.1);
        return acc;
      }, {});
    } else {
      const max = maxSharePerMode?.[selectedMode] || 1;
      colorStops = data[selectedDataset]
        .filter((e) => e[key] === selectedMode)
        .reduce((acc, e) => {
          acc[e.canton_name] = interp(
            '#FFFFFF',
            COLOR_MAPS[aggCol][selectedMode] || '#888',
            e.share / max,
          );
          return acc;
        }, {});
    }

    map.setPaintProperty('canton-fill', 'fill-color', [
      'case',
      ...Object.entries(colorStops).flatMap(([canton, col]) => [
        ['==', ['get', 'NAME'], canton],
        col,
      ]),
      '#FFFFFF',
    ]);
    map.setPaintProperty('canton-fill', 'fill-opacity', 1);
  }, [aggCol, data, mapRef, selectedDataset, selectedMode]);
}
