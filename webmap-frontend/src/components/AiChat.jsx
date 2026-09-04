import React, { useEffect, useRef, useState } from 'react';
import Plot from 'react-plotly.js';
import { useData } from '../context/DataContext';
import { useMap } from '../context/MapContext';
import { useModule } from '../context/ModuleContext';
import { useFilters } from '../context/FilterContext';
import { useSelection } from '../context/SelectionContext';
import { handle401 } from '../utils/auth';
import './AiChat.css';

const AI_SOURCE = 'ai-query-source';
const AI_LAYER = 'ai-query-layer';
const AI_LABEL_LAYER = 'ai-query-label';
const AI_LOCATE_SOURCE = 'ai-locate-source';
const AI_LOCATE_LAYER = 'ai-locate-layer';
const AI_LOCATE_LABEL = 'ai-locate-label';

const MODE_COLORS = {
  car: '#e4572e', car_passenger: '#f3a712', pt: '#1d7874',
  bike: '#4f46e5', walk: '#8d99ae',
};

export default function AiChat() {
  const { datasetId, setDatasetId } = useData();
  const { mapRef, drawRef, setIsSidebarOpen, resetMapView } = useMap();
  const { isGraphExpanded, setIsGraphExpanded } = useModule();
  const { timeRange, setTimeRange,
    selectedNetworkModes, setSelectedNetworkModes } = useFilters();
  const { clickedCanton, setClickedCanton } = useSelection();

  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);   // feature flag from backend
  const [messages, setMessages] = useState([]);   // {role:'user'|'ai', text, display}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mapActive, setMapActive] = useState(false);
  const bodyRef = useRef(null);
  // Conversation id keys the server-side result registry ("edit chart r2").
  const convoIdRef = useRef(crypto.randomUUID());
  const abortRef = useRef(null);          // in-flight stream (Stop button)
  const pendingGeocodeRef = useRef(null); // locate_failed -> geocoder fallback

  // Is the AI feature turned on server-side? If not, the button never renders.
  useEffect(() => {
    let cancelled = false;
    fetch('/backend/ai_status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((d) => { if (!cancelled) setEnabled(!!d.enabled); })
      .catch((err) => {
        console.error('[AiChat] could not read AI status:', err);
        if (!cancelled) setEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Autoscroll on new messages
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, open]);

  // Dataset switch: drop the conversation + any AI layer (other dataset's data)
  useEffect(() => {
    stopStream();
    setMessages([]);
    clearMapLayer();
    convoIdRef.current = crypto.randomUUID();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetId]);

  // Unmount: make sure AI sources/layers don't linger on the map (GPU memory)
  useEffect(() => {
    return () => { clearMapLayer(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dynamic AI layers (map_layers displays) — ids tracked for cleanup.
  const dynLayersRef = useRef({ layers: [], sources: [] });

  function clearMapLayer() {
    const map = mapRef.current;
    if (!map) return;
    [AI_LAYER, AI_LABEL_LAYER, AI_LOCATE_LAYER, AI_LOCATE_LABEL,
      ...dynLayersRef.current.layers].forEach((l) => {
      if (map.getLayer(l)) map.removeLayer(l);
    });
    [AI_SOURCE, AI_LOCATE_SOURCE, ...dynLayersRef.current.sources].forEach((s) => {
      if (map.getSource(s)) map.removeSource(s);
    });
    dynLayersRef.current = { layers: [], sources: [] };
    setMapActive(false);
  }

  // Generic layer renderer for map_layers displays. Styles recycle the
  // app's existing visual language: polygons like the canton highlight,
  // points like the locate marker, spider/od like showOnMap.
  function showLayers(display) {
    const map = mapRef.current;
    if (!map || !display.layers?.length) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    const scanCoords = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < minLon) minLon = c[0];
        if (c[0] > maxLon) maxLon = c[0];
        if (c[1] < minLat) minLat = c[1];
        if (c[1] > maxLat) maxLat = c[1];
      } else c.forEach(scanCoords);
    };

    for (const layer of display.layers) {
      const src = `ai-dyn-${layer.id}`;
      const gj = layer.geojson;
      if (!gj?.features?.length) continue;
      // replace an existing layer with the same id
      [`${src}-fill`, `${src}-line`, `${src}-case`, `${src}-pt`, `${src}-lbl`,
        `${src}-mid-pt`].forEach((l) => {
        if (map.getLayer(l)) map.removeLayer(l);
      });
      if (map.getSource(`${src}-mid`)) map.removeSource(`${src}-mid`);
      if (map.getSource(src)) map.removeSource(src);
      map.addSource(src, { type: 'geojson', data: gj });

      const color = layer.color || '#7c3aed';
      if (layer.kind === 'polygons') {
        // Fill fades out on zoom-in: inside the polygon a constant tint
        // would wash the whole viewport purple; the outline takes over.
        map.addLayer({ id: `${src}-fill`, type: 'fill', source: src,
          paint: { 'fill-color': color,
            'fill-opacity': ['interpolate', ['linear'], ['zoom'],
              9, 0.18, 12, 0.06, 14, 0.02] } });
        map.addLayer({ id: `${src}-line`, type: 'line', source: src,
          paint: { 'line-color': color, 'line-opacity': 0.9,
            'line-width': ['interpolate', ['linear'], ['zoom'],
              7, 2.5, 12, 4] } });
        map.addLayer({ id: `${src}-lbl`, type: 'symbol', source: src,
          layout: { 'text-field': ['get', 'name'], 'text-size': 13,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] },
          paint: { 'text-color': color, 'text-halo-color': '#fff',
            'text-halo-width': 2 } });
        dynLayersRef.current.layers.push(`${src}-fill`, `${src}-line`, `${src}-lbl`);
      } else if (layer.kind === 'points') {
        map.addLayer({ id: `${src}-pt`, type: 'circle', source: src,
          paint: { 'circle-radius': 8, 'circle-color': color,
            'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
        map.addLayer({ id: `${src}-lbl`, type: 'symbol', source: src,
          layout: { 'text-field': ['get', 'name'], 'text-size': 12,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-offset': [0, -1.4], 'text-anchor': 'bottom' },
          paint: { 'text-color': color, 'text-halo-color': '#fff',
            'text-halo-width': 2 } });
        dynLayersRef.current.layers.push(`${src}-pt`, `${src}-lbl`);
      } else { // lines / od / spider fallback
        const lineColor = layer.color || '#ff8c00';
        const w = layer.width || 2;
        // White casing + zoom-scaled width: a 100 m segment stays legible
        // even at region zoom instead of vanishing into the road network.
        map.addLayer({ id: `${src}-case`, type: 'line', source: src,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-opacity': 0.9,
            'line-width': ['interpolate', ['linear'], ['zoom'],
              7, w + 2, 11, w + 4, 15, w + 7] } });
        map.addLayer({ id: `${src}-line`, type: 'line', source: src,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': lineColor, 'line-opacity': 0.95,
            'line-width': ['interpolate', ['linear'], ['zoom'],
              7, Math.max(3, w - 2), 11, w, 15, w + 3] } });
        map.addLayer({ id: `${src}-lbl`, type: 'symbol', source: src, minzoom: 12,
          layout: { 'symbol-placement': 'line-center',
            'text-field': ['get', 'name'], 'text-size': 11,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'] },
          paint: { 'text-color': lineColor,
            'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
        dynLayersRef.current.layers.push(`${src}-case`, `${src}-line`, `${src}-lbl`);

        // Midpoint markers: scattered short segments get a dot you can
        // spot at any zoom; fades out once the line itself is visible.
        const mids = [];
        for (const f of gj.features) {
          const g = f.geometry || {};
          const line = g.type === 'LineString' ? g.coordinates
            : (g.type === 'MultiLineString' ? g.coordinates[0] : null);
          if (line?.length) {
            mids.push({ type: 'Feature',
              properties: { name: f.properties?.name },
              geometry: { type: 'Point',
                coordinates: line[Math.floor(line.length / 2)] } });
          }
        }
        if (mids.length && mids.length <= 60) {
          const msrc = `${src}-mid`;
          map.addSource(msrc, { type: 'geojson',
            data: { type: 'FeatureCollection', features: mids } });
          map.addLayer({ id: `${msrc}-pt`, type: 'circle', source: msrc,
            paint: {
              'circle-color': lineColor,
              'circle-radius': ['interpolate', ['linear'], ['zoom'],
                6, 7, 12, 9, 14, 0],
              'circle-opacity': ['interpolate', ['linear'], ['zoom'],
                12.5, 0.85, 14, 0],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': ['interpolate', ['linear'], ['zoom'],
                6, 2, 14, 0],
            } });
          dynLayersRef.current.layers.push(`${msrc}-pt`);
          dynLayersRef.current.sources.push(msrc);
        }
      }
      dynLayersRef.current.sources.push(src);
      gj.features.forEach((f) => scanCoords(f.geometry?.coordinates || []));
    }
    setMapActive(true);
    if (minLon <= maxLon) {
      try {
        // Tiny extents (a single road segment) need a close zoom or the
        // highlighted line is invisible at region scale.
        const extent = Math.max(maxLon - minLon, maxLat - minLat);
        const maxZoom = extent < 0.02 ? 14.5 : 12;
        map.fitBounds([[minLon, minLat], [maxLon, maxLat]],
          { padding: 80, duration: 900, maxZoom });
      } catch { /* best effort */ }
    }
  }

  function showOnMap(display) {
    const map = mapRef.current;
    const geojson = display.geojson;
    if (!map || !geojson?.features?.length) return;

    [AI_LAYER, AI_LABEL_LAYER].forEach((l) => { if (map.getLayer(l)) map.removeLayer(l); });
    if (map.getSource(AI_SOURCE)) map.removeSource(AI_SOURCE);
    map.addSource(AI_SOURCE, { type: 'geojson', data: geojson });

    if (display.style === 'links') {
      // Spider look (orange, width by `spider_flow`), but ZOOM-SCALED so a
      // country-wide result shows the whole fine network as thin threads when
      // zoomed out and grows to the full spider thickness as you zoom in — you
      // see everything instead of a few thick blobs hiding the detail.
      map.addLayer({
        id: AI_LAYER, type: 'line', source: AI_SOURCE,
        paint: {
          'line-color': '#ff8c00',
          'line-width': ['interpolate', ['linear'], ['zoom'],
            // country view: thin threads, whole network visible
            8, ['interpolate', ['linear'], ['get', 'spider_flow'],
              0, 0.15, 20, 0.4, 300, 1.2, 700, 2.5],
            // mid view
            11, ['interpolate', ['linear'], ['get', 'spider_flow'],
              0, 0.4, 20, 1, 300, 3, 700, 6],
            // zoomed in: full spider scale
            14, ['interpolate', ['linear'], ['get', 'spider_flow'],
              0, 0, 1, 1, 10, 3, 150, 5, 300, 8, 500, 12, 700, 16]],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.7, 13, 0.9],
        },
      });
      // Volume labels only on the busier links (zoom 15+) so a large result
      // doesn't try to render tens of thousands of text symbols.
      map.addLayer({
        id: AI_LABEL_LAYER, type: 'symbol', source: AI_SOURCE, minzoom: 15,
        filter: ['>=', ['get', 'spider_flow'], 20],
        layout: {
          'symbol-placement': 'line-center',
          // corridors (aggregated OD) carry the raw count in 'trips';
          // road links carry the volume in 'spider_flow'
          'text-field': ['to-string', ['coalesce', ['get', 'trips'], ['get', 'spider_flow']]],
          'text-size': 11,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#b45309', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
      });
    } else {
      // Origin-destination fallback (non-car modes without route links): mode-colored
      map.addLayer({
        id: AI_LAYER, type: 'line', source: AI_SOURCE,
        paint: {
          'line-color': ['match', ['get', 'mode'],
            ...Object.entries(MODE_COLORS).flat(), '#7c3aed'],
          'line-width': 1.6,
          'line-opacity': 0.55,
        },
      });
    }
    setMapActive(true);

    try {
      // Track bounds in a plain loop — a result can have tens of thousands of
      // features (millions of coords); Math.min(...hugeArray) would blow the
      // call stack.
      let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
      const scan = (line) => {
        for (const c of line) {
          if (c[0] < minLon) minLon = c[0];
          if (c[0] > maxLon) maxLon = c[0];
          if (c[1] < minLat) minLat = c[1];
          if (c[1] > maxLat) maxLat = c[1];
        }
      };
      for (const f of geojson.features) {
        const g = f.geometry;
        if (g.type === 'LineString') scan(g.coordinates);
        else if (g.type === 'MultiLineString') g.coordinates.forEach(scan);
      }
      if (minLon <= maxLon) {
        map.fitBounds([[minLon, minLat], [maxLon, maxLat]],
          { padding: 80, duration: 900, maxZoom: 13 });
      }
    } catch { /* fit is best-effort */ }
  }

  function showLocation(display) {
    const map = mapRef.current;
    if (!map || display.lon == null) return;
    const point = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [display.lon, display.lat] },
        properties: { name: display.name },
      }],
    };
    if (map.getSource(AI_LOCATE_SOURCE)) {
      map.getSource(AI_LOCATE_SOURCE).setData(point);
    } else {
      map.addSource(AI_LOCATE_SOURCE, { type: 'geojson', data: point });
      map.addLayer({
        id: AI_LOCATE_LAYER, type: 'circle', source: AI_LOCATE_SOURCE,
        paint: {
          'circle-radius': 10, 'circle-color': '#7c3aed',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 3,
          'circle-opacity': 0.95,
        },
      });
      map.addLayer({
        id: AI_LOCATE_LABEL, type: 'symbol', source: AI_LOCATE_SOURCE,
        layout: {
          'text-field': ['get', 'name'], 'text-size': 13,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-offset': [0, -1.6], 'text-anchor': 'bottom',
        },
        paint: { 'text-color': '#6d28d9', 'text-halo-color': '#fff', 'text-halo-width': 2 },
      });
    }
    setMapActive(true);
    map.flyTo({ center: [display.lon, display.lat], zoom: 14.5, duration: 1200 });
  }

  // The dataset only knows transit stops / municipalities / cantons. For POIs
  // and addresses (ETH, a university, a street) fall back to Mapbox geocoding
  // (the map already has the token). Biased to Switzerland, near its centre.
  async function geocodeFallback(query) {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!token || !query) {
      appendAi(`No place matching "${query}" found.`, { type: 'chat' }, true);
      return;
    }
    try {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`
        + `?access_token=${token}&country=ch&proximity=8.54,47.37&limit=1&language=de,en`;
      const res = await fetch(url);
      const data = await res.json();
      const feat = data.features?.[0];
      if (!feat) {
        appendAi(`Could not find "${query}" - not in the dataset and no map match.`,
          { type: 'chat' }, true);
        return;
      }
      const [lon, lat] = feat.center;
      const label = feat.text || query;
      const display = { type: 'locate', name: label, lon, lat, kind: 'geocoded' };
      appendAi(`Found "${feat.place_name || label}" via map search - marked on the map.`, display);
      showLocation(display);
    } catch (err) {
      console.error('[AiChat] geocode fallback failed:', err);
      appendAi(`Could not look up "${query}".`, { type: 'chat' }, true);
    }
  }

  // Executes curated UI actions the agent requests — the "AI clicks for
  // you" bus. Every action maps to an existing context setter; nothing
  // here can do more than a user could by hand.
  function execUiAction(d) {
    const p = d.params || {};
    try {
      switch (d.action) {
        case 'open_module':
          setIsGraphExpanded(p.module);
          setIsSidebarOpen(true);
          break;
        case 'close_module':
          setIsGraphExpanded(null);
          setIsSidebarOpen(false);
          break;
        case 'select_canton':
          setClickedCanton(p.canton);
          break;
        case 'set_time_range':
          setTimeRange([Math.max(0, Math.round((p.from_hour ?? 0) * 4)),
            Math.min(96, Math.round((p.to_hour ?? 24) * 4))]);
          break;
        case 'set_network_modes':
          setSelectedNetworkModes(p.modes?.length ? p.modes : ['all']);
          break;
        case 'set_dataset':
          if (p.dataset_id != null) setDatasetId(p.dataset_id);
          break;
        case 'fly_to':
          mapRef.current?.flyTo({ center: [p.lon, p.lat],
            zoom: p.zoom ?? 12, duration: 1200 });
          break;
        case 'reset_view':
          resetMapView();
          break;
        case 'start_draw':
          drawRef.current?.changeMode('draw_polygon');
          break;
        case 'clear_drawn':
          if (drawRef.current?.getAll?.()?.features?.length) {
            drawRef.current.deleteAll();
            mapRef.current?.fire('draw.delete', { features: [] });
          }
          break;
        default:
          console.warn('[AiChat] unknown ui_action:', d.action);
      }
    } catch (err) {
      console.error('[AiChat] ui_action failed:', d.action, err);
    }
  }

  function appendAi(text, display, isError = false, steps = null) {
    const displays = display && display.type !== 'chat' ? [display] : [];
    setMessages((m) => [...m, { role: 'ai', text, displays, steps, isError }]);
  }

  // Snapshot of what the user currently sees — sent with every question so
  // the agent can resolve "here"/"this view" and pick fitting ui_actions.
  function collectUiState() {
    let center = null, zoom = null;
    try {
      const map = mapRef.current;
      if (map) {
        const c = map.getCenter();
        center = [Number(c.lng.toFixed(4)), Number(c.lat.toFixed(4))];
        zoom = Number(map.getZoom().toFixed(1));
      }
    } catch { /* map not ready yet */ }
    return {
      surface: 'webmap',
      module: isGraphExpanded || null,
      canton: clickedCanton || null,
      time_range: [timeRange[0] / 4, timeRange[1] / 4],
      network_modes: selectedNetworkModes,
      center,
      zoom,
    };
  }

  // Stop button: tell the server to cancel (deterministic) AND abort the
  // fetch so the UI frees immediately.
  function stopStream() {
    if (!abortRef.current) return;
    fetch('/backend/ai_cancel', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: convoIdRef.current }),
    }).catch(() => {});
    abortRef.current.abort();
  }

  // The streaming answer renders into one "live" message that fills in as
  // events arrive; a `done` event (or an error) finalizes it.
  function pushLive() {
    setMessages((m) => [...m, { role: 'ai', live: true, text: '', displays: [], steps: [] }]);
  }
  function updateLive(fn) {
    setMessages((m) => {
      const last = m[m.length - 1];
      if (!last?.live) return m;
      return [...m.slice(0, -1), fn(last)];
    });
  }
  function dropLive() {
    setMessages((m) => (m[m.length - 1]?.live ? m.slice(0, -1) : m));
  }

  // Map/UI side-effects of a display payload (chat rendering is separate).
  function execDisplay(d) {
    if (d.type === 'map' && d.geojson) showOnMap(d);
    if (d.type === 'map_layers') showLayers(d);
    if (d.type === 'locate') showLocation(d);
    if (d.type === 'clear_map') clearMapLayer();
    if (d.type === 'ui_action') execUiAction(d);
  }

  function handleStreamEvent(ev) {
    switch (ev.type) {
      case 'turn':            // new LLM turn: text so far was provisional
        updateLive((l) => ({ ...l, text: '' }));
        break;
      case 'delta':
        updateLive((l) => ({ ...l, text: l.text + (ev.text || '') }));
        break;
      case 'step':
        updateLive((l) => ({ ...l, steps: [...l.steps, { ...ev.step, pending: true }] }));
        break;
      case 'step_done':
        updateLive((l) => {
          const steps = [...l.steps];
          for (let i = steps.length - 1; i >= 0; i--) {
            if (steps[i].pending) { steps[i] = ev.step; break; }
          }
          return { ...l, steps };
        });
        break;
      case 'display': {
        const d = ev.display;
        if (!d) break;
        if (d.type === 'locate_failed') { pendingGeocodeRef.current = d.query; break; }
        execDisplay(d);
        updateLive((l) => ({ ...l, displays: [...l.displays, d] }));
        break;
      }
      case 'done':
        updateLive((l) => ({
          ...l,
          live: false,
          text: ev.reply || l.text || 'An error occurred.',
          steps: Array.isArray(ev.steps) && ev.steps.length ? ev.steps : l.steps,
          isError: !!ev.error,
        }));
        break;
      default:
        break;
    }
  }

  // Non-streaming responses (older backend, error JSON) in one shot.
  function finalizeFromJson(data, ok) {
    let displays = Array.isArray(data.displays) && data.displays.length
      ? data.displays
      : (data.display && data.display.type !== 'chat' ? [data.display] : []);
    const failed = displays.find((d) => d.type === 'locate_failed');
    displays = displays.filter((d) => d.type !== 'locate_failed');
    for (const d of displays) execDisplay(d);
    updateLive((l) => ({
      ...l, live: false,
      text: data.reply || data.error || 'An error occurred.',
      displays,
      steps: Array.isArray(data.steps) ? data.steps : l.steps,
      isError: !ok || !!data.error,
    }));
    if (failed) pendingGeocodeRef.current = failed.query;
  }

  async function send(textOverride) {
    const question = (typeof textOverride === 'string' ? textOverride : input).trim();
    if (!question || busy) return;
    setInput('');
    setMessages((m) => [...m, { role: 'user', text: question }]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    pendingGeocodeRef.current = null;
    pushLive();
    try {
      const history = messages.slice(-6).map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        text: m.text,
      }));
      const url = `/backend/data/${datasetId}/ai_query`;
      const opts = {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ question, history,
          conversation_id: convoIdRef.current,
          stream: true,
          ui_state: collectUiState(),
          // Outer ring of the first drawn polygon (if any) — lets the AI
          // answer "trips in this area" against the sketched shape.
          polygon: (() => {
            const feats = drawRef.current?.getAll?.()?.features || [];
            const poly = feats.find((f) => f.geometry?.type === 'Polygon');
            const ring = poly?.geometry?.coordinates?.[0];
            return ring?.length >= 3
              ? ring.map(([x, y]) => [Number(x.toFixed(6)), Number(y.toFixed(6))])
              : undefined;
          })() }),
      };
      let res = await fetch(url, opts);
      if (res.status === 401) {
        const ok = await handle401();
        if (!ok) { dropLive(); return; }
        res = await fetch(url, opts);
      }
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok || !res.body || !ctype.includes('ndjson')) {
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) console.error('[AiChat] query error:', res.status, data);
        finalizeFromJson(data, res.ok);
      } else {
        // NDJSON event stream: steps, text deltas and visuals arrive live.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { handleStreamEvent(JSON.parse(line)); }
            catch (err) { console.warn('[AiChat] bad stream line:', err); }
          }
        }
        // Stream ended without a done event -> connection was lost.
        updateLive((l) => (l.live
          ? { ...l, live: false, text: l.text || 'Connection lost - please try again.', isError: !l.text }
          : l));
      }
      const q = pendingGeocodeRef.current;
      pendingGeocodeRef.current = null;
      if (q) await geocodeFallback(q);
    } catch (err) {
      if (err?.name === 'AbortError') {
        updateLive((l) => ({ ...l, live: false, stopped: true,
          text: l.text || 'Stopped.' }));
      } else {
        console.error('[AiChat] request failed:', err);
        updateLive((l) => ({ ...l, live: false,
          text: 'An error occurred - please try again.', isError: true }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  const TRACE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444',
    '#0ea5e9', '#a855f7', '#84cc16', '#64748b'];

  function renderDisplay(d, key) {
    if (!d) return null;
    // Composed charts (render_chart): multiple named traces + layout options.
    if (d.type === 'chart' && d.traces?.length) {
      const lay = d.layout || {};
      const data = d.traces.map((t, i) => ({
        name: t.name,
        x: t.x,
        y: t.y,
        type: t.type === 'area' ? 'scatter' : (t.type === 'line' ? 'scatter' : t.type),
        mode: (t.type === 'line' || t.type === 'area') ? 'lines'
          : (t.type === 'scatter' ? 'markers' : undefined),
        fill: t.type === 'area' ? 'tozeroy' : undefined,
        marker: { color: TRACE_COLORS[i % TRACE_COLORS.length] },
      }));
      return (
        <div className="ai-chart" key={key}>
          {d.result_id && <div className="ai-chart-id">{d.result_id}</div>}
          <Plot
            data={data}
            layout={{
              title: { text: d.title || '', font: { size: 12 } },
              margin: { l: 45, r: 10, t: d.title ? 30 : 10, b: 60 },
              height: 240, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
              barmode: lay.stacked ? 'stack' : 'group',
              showlegend: d.traces.length > 1,
              legend: { font: { size: 9 }, orientation: 'h' },
              xaxis: { tickfont: { size: 9 }, automargin: true,
                       title: { text: lay.x_title || '', font: { size: 10 } } },
              yaxis: { tickfont: { size: 9 },
                       type: lay.y_log ? 'log' : 'linear',
                       title: { text: lay.y_title || '', font: { size: 10 } } },
            }}
            config={{ displayModeBar: false, responsive: true }}
            style={{ width: '100%' }}
          />
        </div>
      );
    }
    if (d.type === 'chart' && d.labels?.length) {
      return (
        <div className="ai-chart" key={key}>
          {d.result_id && <div className="ai-chart-id">{d.result_id}</div>}
          <Plot
            data={[{ type: 'bar', x: d.labels, y: d.values, marker: { color: '#6366f1' } }]}
            layout={{
              title: { text: d.title || '', font: { size: 12 } },
              margin: { l: 45, r: 10, t: d.title ? 30 : 10, b: 60 },
              height: 220, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
              xaxis: { tickfont: { size: 9 }, automargin: true },
              yaxis: { tickfont: { size: 9 } },
            }}
            config={{ displayModeBar: false, responsive: true }}
            style={{ width: '100%' }}
          />
        </div>
      );
    }
    if (d.type === 'table' && d.rows?.length) {
      return (
        <div className="ai-table-wrap" key={key}>
          <table className="ai-table">
            <thead><tr>{d.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>
              {d.rows.slice(0, 50).map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j}>{String(v ?? '-')}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {d.rows.length > 50 && <div className="ai-table-more">… {d.rows.length - 50} more rows</div>}
        </div>
      );
    }
    if (d.type === 'map') {
      return (
        <div className="ai-map-note" key={key}>
          🗺️ {d.style === 'links'
            ? `Routes drawn on the map (${d.shown} road segments)`
            : `${d.shown} of ${d.total} trips on the map`}
          <button className="ai-inline-clear" onClick={clearMapLayer}>remove</button>
        </div>
      );
    }
    if (d.type === 'locate') {
      return (
        <div className="ai-map-note" key={key}>
          📍 {d.name}
          <button className="ai-inline-clear" onClick={clearMapLayer}>remove</button>
        </div>
      );
    }
    if (d.type === 'map_layers') {
      const labels = (d.layers || []).map((l) => l.label || l.id).join(', ');
      return (
        <div className="ai-map-note" key={key}>
          🗺️ {labels || 'Layer drawn on the map'}
          <button className="ai-inline-clear" onClick={clearMapLayer}>remove</button>
        </div>
      );
    }
    if (d.type === 'ui_action') {
      return (
        <div className="ai-map-note" key={key}>
          🎛️ {String(d.action).replace(/_/g, ' ')}
          {d.params?.module ? `: ${d.params.module}` : ''}
          {d.params?.canton ? `: ${d.params.canton}` : ''}
        </div>
      );
    }
    // Custom-run proposal: summary + cost, started only via explicit consent.
    if (d.type === 'sim_proposal') {
      return (
        <div className="ai-sim-card" key={key}>
          <div className="ai-sim-head">🧪 {d.title}
            <span className="ai-sim-badge">proposal</span>
          </div>
          {d.description && <div className="ai-sim-desc">{d.description}</div>}
          <ul className="ai-sim-ops">
            {(d.summary || []).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
          <div className="ai-sim-meta">Estimated runtime: {d.estimate || 'unknown'}</div>
          <button
            className="ai-sim-start"
            disabled={busy}
            onClick={() => send(`Yes, start simulation job ${d.job_id}.`)}
          >
            ▶ Start simulation
          </button>
        </div>
      );
    }
    if (d.type === 'sim_job') {
      const pct = Math.round((d.progress || 0) * 100);
      const failed = d.status === 'failed' || d.status === 'cancelled';
      return (
        <div className="ai-sim-card" key={key}>
          <div className="ai-sim-head">🧪 {d.title}
            <span className={`ai-sim-badge ${failed ? 'fail' : ''} ${d.status === 'done' ? 'done' : ''}`}>
              {d.status}
            </span>
          </div>
          {d.description && <div className="ai-sim-desc">{d.description}</div>}
          {(d.status === 'running' || d.status === 'uploading' || d.status === 'queued') && (
            <>
              <div className="ai-sim-bar"><div style={{ width: `${pct}%` }} /></div>
              <div className="ai-sim-meta">{d.phase || d.status} · {pct}%
                {d.message ? ` · ${d.message}` : ''}</div>
            </>
          )}
          {d.status === 'done' && d.result_dataset_id && (
            <div className="ai-sim-meta">
              ✅ Result stored as your dataset #{d.result_dataset_id} — switch
              to it via the dataset selector or ask me to compare.
            </div>
          )}
          {failed && d.error && <div className="ai-sim-meta">⚠️ {d.error}</div>}
        </div>
      );
    }
    return null;
  }

  // Tool-call trace: what the agent did to arrive at the answer.
  function renderSteps(steps) {
    if (!steps?.length) return null;
    return (
      <div className="ai-chips">
        {steps.map((s, i) => (
          <span key={i}
                className={`ai-chip ${s.pending ? 'pending' : s.ok ? '' : 'fail'}`}
                title={s.pending ? 'Running…'
                  : s.ok ? (s.detail || '')
                    : `Failed attempt (auto-retried): ${s.error || s.detail || ''}`}>
            {s.pending ? <span className="ai-chip-spin" /> : (s.ok ? '🔧' : '⚠️')}
            {' '}{s.tool}{s.detail ? ` · ${s.detail.slice(0, 40)}` : ''}
          </span>
        ))}
      </div>
    );
  }

  // Feature switched off (or key missing) → render nothing at all.
  if (!enabled) return null;

  return (
    <>
      {!open && (
        <div className="ai-fab-stack">
          {mapActive && (
            <button className="ai-layer-pill" onClick={clearMapLayer} title="Remove AI layer from map">
              AI layer ✕
            </button>
          )}
          <button className="ai-fab" onClick={() => setOpen(true)} title="Ask AI">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3l1.8 4.9L19 9.7l-4.4 3.3 1.5 5.3L12 15.4l-4.1 2.9 1.5-5.3L5 9.7l5.2-1.8L12 3z"
                    fill="currentColor"/>
            </svg>
          </button>
        </div>
      )}

      {open && (
        <div className="ai-panel">
          <div className="ai-header">
            <div className="ai-header-title">
              <span className="ai-header-icon">✦</span>
              <div>
                <strong>Ask AI</strong>
                <div className="ai-header-sub">Questions about this dataset</div>
              </div>
            </div>
            <div className="ai-header-actions">
              {mapActive && (
                <button className="ai-clear-btn" onClick={clearMapLayer} title="Remove AI layer from map">
                  Layer ✕
                </button>
              )}
              <button className="ai-close" onClick={() => setOpen(false)}>✕</button>
            </div>
          </div>

          <div className="ai-body" ref={bodyRef}>
            {messages.length === 0 && (
              <div className="ai-hello">
                <p>Ask a question about the data, e.g.:</p>
                <button onClick={() => setInput('Compare car and PT trips by hour of day in one chart')}>
                  "Compare car and PT trips by hour in one chart"
                </button>
                <button onClick={() => setInput('Show the routes of all bike trips longer than 10 km on the map')}>
                  "Show routes of bike trips &gt; 10 km on the map"
                </button>
                <button onClick={() => setInput('How well does the simulation match the microcensus for mode share?')}>
                  "How well does the simulation match the microcensus?"
                </button>
                <button onClick={() => setInput('Highlight the district of Uster and show its mode share')}>
                  "Highlight the district of Uster and show its mode share"
                </button>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`ai-msg ${m.role} ${m.isError ? 'error' : ''}`}>
                {m.role === 'ai' && renderSteps(m.steps)}
                {m.live && !m.text && !m.steps?.length
                  ? <div className="ai-typing"><span></span><span></span><span></span></div>
                  : <div className="ai-msg-text">{m.text}</div>}
                {m.role === 'ai' && (m.displays || []).map((d, j) => renderDisplay(d, j))}
                {m.stopped && <div className="ai-stopped-note">⏹ stopped</div>}
              </div>
            ))}
          </div>

          <div className="ai-input-row">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Type a question… (/sim to request a simulation run)"
              rows={1}
              disabled={busy}
            />
            {busy ? (
              <button className="ai-send ai-stop" title="Stop"
                onClick={stopStream}>
                ◼
              </button>
            ) : (
              <button className="ai-send" onClick={send} disabled={!input.trim()}>
                ➤
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
