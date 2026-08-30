import { useEffect, useRef, useState } from 'react';
import useAntPath from './useAntPath';
import { safeRemoveLayer, safeRemoveSource, setVisibility, setFilter } from './_lib/mapbox';
import { parsePipeList } from './_lib/pipeProps';
import { CLICKABLE_ROAD_FILTER, MAJOR_ROADS_FILTER } from './_lib/mapboxFilters';
import {
  loadNetworkGeometry, prefetchNetworkGeometry, hasNetworkGeometry,
} from './_lib/networkGeometry';
import { paddingSettled } from './_lib/paddingGate';
// Modules that aren't "network modules" but render the SAME MATSim links with
// their own symbology (their layers replace the road network's on screen, so
// the base layers are hidden rather than destroyed — see the module-switch
// effect), and the set of modules the base network actually belongs to. Shared
// with every other hook that touches base-network visibility.
import { SHARES_NETWORK_GEOMETRY, ownsBaseNetwork } from './_lib/networkModules';

export default function useNetworkLayers({
  mapRef,
  searchCanton,
  datasetId,
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
  // Bumped whenever a fresh network-source is loaded, so the Volumes colour
  // recompute re-runs once geometry is ready even if the (now fast major-only)
  // volume fetch already finished before it — otherwise colours stay at 0 until
  // a time-slider nudge re-triggers the recompute.
  const [networkVersion, setNetworkVersion] = useState(0);
  const originalNetworkGeoJSON = useRef(null);
  // Per-canton traffic-volume cache: a cheap major-roads-only variant (the
  // default view) and the full variant (fetched lazily when "major roads only"
  // is unchecked). Keyed by `${datasetId}:${canton}`.
  const volCacheRef = useRef({ key: null, major: null, full: null });
  // Which geometry variant is currently in `network-source`. Only the road
  // Volumes module shows the major-roads subset; every other network module
  // needs the full set (CLICKABLE_ROAD_FILTER is all car links, LinkSpeeds and
  // the Network view are all links), so switching between them has to reload.
  // Tracked here rather than derived, so both the module-switch and the
  // major-toggle effect can tell "already loaded" from "needs a reload".
  const loadedMajorRef = useRef(null);
  const wantMajorGeometry = () =>
    graphExpandedRef.current === 'Volumes' && !!showMajorRoadsOnly;
  /**
   * Can the geometry already in `network-source` serve the current module?
   *
   * The major-roads variant is a strict SUBSET of the full network, so this is
   * NOT symmetric: a loaded full network serves every module (Volumes narrows
   * it with MAJOR_ROADS_FILTER client-side anyway — that is exactly what it did
   * before `?major=1` existed), while the major subset genuinely can't answer
   * for a module that needs every link.
   *
   * Testing `loadedMajorRef.current === wantMajorGeometry()` instead treated a
   * *bigger* loaded network as a mismatch too, and since major-roads-only is
   * Volumes' default that made every switch into or out of Volumes a full
   * reload: "Loading network..." plus a re-tile of ~99k features, where the
   * shared source is supposed to give a show() and a repaint. Now only the
   * downgrade direction reloads, so a canton pays that at most once.
   */
  const canReuseLoadedGeometry = () => {
    if (loadedMajorRef.current === null) return false; // nothing loaded yet
    if (loadedMajorRef.current === false) return true; // full network serves everyone
    return wantMajorGeometry();                        // major subset: only Volumes' major view
  };
  // Serialises loads. A module switch can run the major-toggle effect and the
  // module-switch effect in the same commit, and both may decide to load; the
  // geometry cache dedupes the fetch, but two resolutions would both reach
  // addSource and the second would throw on the duplicate id. Only the newest
  // load is allowed past its await. Also covers a canton change mid-load.
  const loadTokenRef = useRef(0);

  const selectedNetworkModesRef = useRef(selectedNetworkModes);
  // The click/hover handlers on 'network-layer-hitbox' read only refs, so they
  // are bound once for the map's lifetime. Without this guard loadNetworkForCanton
  // stacked three fresh anonymous listeners on every canton/dataset switch.
  const hitboxHandlersBoundRef = useRef(false);

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

    let left = 0, right = 0;             // time-windowed directional sums
    let leftTotal = 0, rightTotal = 0;   // full-day directional sums
    // Per-link full-day totals, reconstructed from the backend traffic volumes.
    // The v2 `merged_segments.geojson` ships no `per_id_daily_avgs`, so without
    // this the selected-segment side panel (keyed off `per_id_daily_avgs`) and
    // the table column's map-side numeric filter would be blank/broken.
    // Full-day totals are time-window-independent, so they're recomputed
    // identically on every slider change.
    const fullDayPerId = new Array(keys.length);

    keys.forEach((id, index) => {
      const hourly = linkVolumeData?.[id.toString()];
      let windowed = 0;   // time-windowed → drives left/right + map color
      let fullDay = 0;    // unfiltered all-day → drives the table's Total column
      if (hourly && Array.isArray(hourly) && hourly.length === 24) {
        for (let h = startHour; h < endHour; h++) windowed += hourly[h] ?? 0;
        for (let h = 0; h < 24; h++) fullDay += hourly[h] ?? 0;
      } else {
        // No backend hourly data → fall back to any daily average that shipped
        // with the geojson (legacy CDN datasets); 0 for v2.
        windowed = Number(daily_avgs[index] ?? 0);
        fullDay = Number(daily_avgs[index] ?? 0);
      }
      fullDayPerId[index] = fullDay;

      const arrow = arrows[index];
      if (arrow === '←') { left += windowed; leftTotal += fullDay; }
      else if (arrow === '→') { right += windowed; rightTotal += fullDay; }
    });

    f.properties = {
      ...f.properties,
      daily_avg_volume: left + right, // time-windowed total
      daily_avg_volume_full: leftTotal + rightTotal, // unfiltered full-day total
      left_sum: left,
      right_sum: right,
      // Full-day directional totals: the table's "Total Daily Volume" column
      // reads these so it stays consistent with the directional "Filtered
      // Volume" (left_sum/right_sum) — Total ≥ Filtered, equal at full window.
      left_total: leftTotal,
      right_total: rightTotal,
      per_id_daily_avgs: fullDayPerId.join('|'),
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
    const labelFilter = showMajorRoadsOnly ? MAJOR_ROADS_FILTER : null;
    setFilter(map, LABEL_IDS, labelFilter);
  };

  // Ensure labels in Volumes mode are always car-only (optionally major roads only)
  const applyLabelCarAndMajorFilter = (map, showMajorRoadsOnly) => {
    // Exact match for "car" mode (prevents matching "cable car")
    const carFilter = ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0];
    const labelFilter = showMajorRoadsOnly
      ? ['all', carFilter, MAJOR_ROADS_FILTER]
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
      'network-layer', 'network-layer-hitbox', 'ant-line', 'network-highlight',
      'network-label-left', 'network-label-right'
    ]);
    safeRemoveSource(map, ['network-source', 'network-highlight', 'ant-path']);

    setSelectedNetworkFeature(null);

    // Shared per-(dataset, canton, variant) geometry: fetched, merged (the
    // stripped per-link CDN format → one feature per visual segment) and
    // decorated once, then handed to every module that symbolises these links —
    // including Transit Volumes, which used to fetch its own copy of the file.
    // Claim the variant before any await so the sibling effect can see what is
    // being loaded and doesn't kick off a duplicate load for the same view.
    const major = wantMajorGeometry();
    loadedMajorRef.current = major;
    const token = ++loadTokenRef.current;

    // Only put the loading overlay up for an actual load. When the variant is
    // already parsed in the shared cache — the common case now that the full
    // network is prefetched behind Volumes' major-roads view — all that's left
    // is handing the same object back to Mapbox, and covering a sub-second
    // re-tile with a spinner is what made switching modules feel heavier than
    // it is. `handleIdle` clears the flag either way, so this is safe to skip.
    const cached = hasNetworkGeometry(datasetId, cantonName, major);
    if (!cached) setIsLoading(true);

    // Let the sidebar-driven camera padding shift play out before touching the
    // geometry. Fetching + merging a canton's merged_segments and handing it to
    // Mapbox blocks the main thread for seconds, which starves the rAF-driven
    // ease and leaves the map stuck at a half-applied padding. Resolves
    // immediately when no shift is in flight. Any spinner we raised is
    // translucent, so the pan stays visible while we wait.
    await paddingSettled();
    if (token !== loadTokenRef.current || !mapRef.current) return;

    let networkGeojson;
    try {
      networkGeojson = await loadNetworkGeometry(loadWithFallback, datasetId, cantonName, major);
    } catch (error) {
      if (token !== loadTokenRef.current) return;
      console.warn(`Failed to load network`, error);
      loadedMajorRef.current = null; // nothing loaded — let a retry through
      setFeatureGeoJSON?.(null);
      setIsLoading(false);
      return;
    }
    // Superseded by a newer load — that one owns the map now, so stop before
    // touching any source or layer.
    if (token !== loadTokenRef.current) return;
    // The user switched to a module that isn't ours while the geometry was in
    // flight. The module-switch effect already ran its hide()/removeAll() on
    // layers that didn't exist yet, so adding them now would drop a freshly
    // created (therefore VISIBLE) road network on top of whatever owns the map —
    // Transit Volumes in particular — and overwrite its featureGeoJSON. Bail and
    // clear the variant marker so re-entry reloads (from the geometry cache, so
    // it costs a re-tile, not a download).
    if (!ownsBaseNetwork(graphExpandedRef.current)) {
      loadedMajorRef.current = null;
      // Leave the spinner alone for a module that drives it itself (Transit
      // Volumes owns both its on and off switch); otherwise clear ours so the
      // overlay we put up can't outlive the load we just abandoned.
      if (!SHARES_NETWORK_GEOMETRY.has(graphExpandedRef.current)) setIsLoading(false);
      return;
    }
    if (!networkGeojson) {
      loadedMajorRef.current = null;
      setFeatureGeoJSON?.(null);
      setIsLoading(false);
      return;
    }

    originalNetworkGeoJSON.current = networkGeojson;

    setFeatureGeoJSON?.(networkGeojson);
    
    map.addSource('network-source', { type: 'geojson', data: networkGeojson, generateId: true });
    // Signal that the source is ready so the Volumes colour recompute re-runs
    // (covers the case where volume data arrived before the geometry).
    setNetworkVersion(v => v + 1);

    map.addLayer({
      id: 'network-layer-hitbox',
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
      map.setFilter('network-layer-hitbox', CLICKABLE_ROAD_FILTER);
      map.setFilter('network-layer', CLICKABLE_ROAD_FILTER);
    } else if (graphExpandedRef.current === 'Volumes') {
      // Volumes: car roads + optional major roads filter
      const carFilter = ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0];
      let filter = carFilter;
      if (showMajorRoadsOnly) {
        filter = ['all', carFilter, MAJOR_ROADS_FILTER];
      }
      map.setFilter('network-layer-hitbox', filter);
      map.setFilter('network-layer', filter);
      if (map.getLayer('network-highlight')) map.setFilter('network-highlight', filter);
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
      addLabelLayersIfMissing(map);
      applyLabelCarAndMajorFilter(map, showMajorRoadsOnly);
    }
    
    const handleIdle = () => {
      setIsLoading(false);
      map.off('idle', handleIdle);
      // We just installed the major-roads subset (Volumes' fast first paint).
      // Every other network module needs the full network, so warm it now, in
      // idle time, instead of at the switch: leaving Volumes then costs a
      // re-tile rather than a ~48 MB download. No-op once it's cached, and the
      // one direction that still has to reload (major → full) is the only one
      // this can help — the reverse reuses what's already loaded.
      if (major) prefetchNetworkGeometry(loadWithFallback, datasetId, cantonName, false);
    };
    map.on('idle', handleIdle);

    // UPDATED click handler: use clicked feature directly (no single id anymore)
    map.on('click', 'network-layer-hitbox', (e) => {
      if (!e.features.length) return;
      // VolumeFlow/NodeFlows have their own click handler on this layer
      if (graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows') return;
      // LinkSpeeds/Network/Volumes: at zoom >= 15 only the split layer's click
      // handler applies. Merged (per_id_keys) selection would be wrong when the
      // split visual is on-screen, so suppress this base handler past the threshold.
      if ((graphExpandedRef.current === 'LinkSpeeds' || graphExpandedRef.current === 'Network'
           || graphExpandedRef.current === 'Volumes') && map.getZoom() >= 15) return;

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
    map.on('mouseenter', 'network-layer-hitbox', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'network-layer-hitbox', () => {
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
        setFilter(map, ['network-layer', 'network-layer-hitbox'], CLICKABLE_ROAD_FILTER);
      } else {
        setFilter(map, ['network-layer', 'network-layer-hitbox', 'network-highlight'], null);
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
      setFilter(map, ['network-layer', 'network-layer-hitbox', 'network-highlight'], filter);
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

    // Unticking "major roads only" needs links the major-roads subset doesn't
    // contain, so that direction reloads (both variants stay cached, so it's a
    // re-tile rather than a download). Ticking it does NOT: the full network
    // already contains every major road, and MAJOR_ROADS_FILTER below hides the
    // rest — reloading just to fetch a smaller file the user already has would
    // put a spinner on a pure filter change.
    if (searchCanton && loadedMajorRef.current !== null && !canReuseLoadedGeometry()) {
      loadNetworkForCanton(searchCanton);
      return;
    }

    // Exact match for "car" mode (prevents matching "cable car")
    const carFilter = ['>=', ['index-of', ',car,', ['concat', ',', ['get', 'modes'], ',']], 0];
    let fullFilter;
    if (isGraphExpanded === 'VolumeFlow' || isGraphExpanded === 'NodeFlows' || isGraphExpanded === 'LinkSpeeds') {
      // VolumeFlow/NodeFlows: clickable road links (never major-only; tolerates
      // the stripped per-link merged_segments format that lacks modes/volume)
      fullFilter = CLICKABLE_ROAD_FILTER;
    } else if (showMajorRoadsOnly) {
      fullFilter = ['all', carFilter, MAJOR_ROADS_FILTER];
    } else {
      fullFilter = carFilter;
    }
    
    // Restore the unfiltered feature set when major-roads-only is off. This
    // effect also re-runs on every module switch, so skip the setData when the
    // source already holds this exact object — setData re-tiles every feature
    // (~99k on Zürich), which is the whole cost of a module switch and shows up
    // as a stutter on a change that is otherwise just a filter + repaint.
    if (!showMajorRoadsOnly && originalNetworkGeoJSON.current) {
      const source = map.getSource('network-source');
      if (source && source._data !== originalNetworkGeoJSON.current) {
        source.setData(originalNetworkGeoJSON.current);
      }
    }

    setFilter(map, ['network-layer', 'network-layer-hitbox', 'network-highlight'], fullFilter);

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
    // that has nothing to do with the road network — leaving hidden layers
    // around caused z-order issues, because other hooks insert their layers
    // below `canton-highlight` while these sit above it.
    const NETWORK_LAYERS = ['network-layer','network-layer-hitbox','network-highlight',
      'network-label-left','network-label-right'];

    const removeAll = () => {
      safeRemoveLayer(map, NETWORK_LAYERS);
      safeRemoveSource(map, ['network-source','network-highlight','ant-path']);
    };

    const show = () => setVisibility(map, NETWORK_LAYERS, true);
    const hide = () => setVisibility(map, NETWORK_LAYERS, false);
        
        if (isGraphExpanded === 'Network' || isGraphExpanded === 'Volumes' || isGraphExpanded === 'VolumeFlow' || isGraphExpanded === 'NodeFlows' || isGraphExpanded === 'LinkSpeeds') {
          // Reuse whatever is loaded unless it's too small for this module —
          // coming out of Volumes' major-roads view into VolumeFlow with the
          // major subset still in the source would hide every minor road from a
          // module that is supposed to show them all. Every other combination
          // stays on the show()+repaint path (see canReuseLoadedGeometry).
          if (map.getLayer('network-layer') && canReuseLoadedGeometry()) {
            show();
            // Always re-sync featureGeoJSON on entry to any network module — the
            // context value may have been cleared by another module (e.g. Transit
            // stops) or never set in this session. Consumers (VolumeFlow,
            // NodeFlows, LinkSpeeds) read it via a ref and break silently if null.
            const source = map.getSource('network-source');
            if (source && originalNetworkGeoJSON.current) {
              // Only push data the source doesn't already hold. setData forces
              // Mapbox to re-tile every feature, which on a big canton is the
              // whole cost of re-entering a module — and coming back from
              // Transit Volumes the source still holds this exact object.
              if (source._data !== originalNetworkGeoJSON.current) {
                source.setData(originalNetworkGeoJSON.current);
              }
              setFeatureGeoJSON?.(originalNetworkGeoJSON.current);
            } else if (source && !originalNetworkGeoJSON.current) {
              loadNetworkForCanton(canton);
            }
            if (isGraphExpanded === 'Network') {
              setFilter(map, ['network-layer','network-layer-hitbox','network-highlight'], null);
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
        } else if (SHARES_NETWORK_GEOMETRY.has(isGraphExpanded)) {
          // Transit Volumes styles these very links by PT volume, so it takes
          // the map over but the geometry stays relevant. Tearing the source
          // down here meant coming back re-added ~180k features to Mapbox and
          // put "Loading network..." on screen for something that isn't a load
          // at all — the inconsistency being that switching *between* network
          // modules never does this. Hide instead: the return trip is a show().
          // Hidden layers are neither drawn nor hit-tested, so they can't cover
          // or steal clicks from the transit layers.
          hide();
          // featureGeoJSON belongs to whoever owns the map — Transit Volumes
          // publishes its own — but originalNetworkGeoJSON/linkVolumeData stay
          // so the return trip needs neither a fetch nor a re-tile.
          setFeatureGeoJSON?.(null);
          setSelectedNetworkFeature(null);
          return;
        } else {
          removeAll();
          originalNetworkGeoJSON.current = null;
          loadedMajorRef.current = null; // source gone → next entry must reload
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
          map.setPaintProperty('network-layer-hitbox', 'line-width', 10);
          setLabelVisibility(map, false);
          // Clickable road links (tolerates stripped per-link merged_segments format)
          setFilter(map, ['network-layer', 'network-layer-hitbox'], CLICKABLE_ROAD_FILTER);
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
          map.setPaintProperty('network-layer-hitbox', 'line-width',
            ['interpolate', ['linear'], ['get', 'capacity'], 300, 10, 4000, 21]);
        }
        
        if (map.getLayer('ant-line')) map.removeLayer('ant-line');
      }, [isGraphExpanded]);
      
      // --- LOAD per-link hourly volumes ------------------------------------------
      // The default Volumes view is "major roads only", and the map filters to the
      // same major-road set (?major=1 mirrors MAJOR_ROADS_FILTER server-side),
      // so by default we only fetch major-road volumes (~10× smaller payload). The
      // full set is fetched lazily only when "major roads only" is unchecked
      // (minor roads then become visible and need their volumes). Both variants
      // are cached per canton so toggling back is instant.
      useEffect(() => {
        if (!searchCanton || graphExpandedRef.current !== 'Volumes') return;

        const cacheKey = `${datasetId}:${searchCanton}`;
        if (volCacheRef.current.key !== cacheKey) {
          volCacheRef.current = { key: cacheKey, major: null, full: null };
        }
        const cache = volCacheRef.current;
        const needFull = !showMajorRoadsOnly;

        // Serve the best already-cached variant (full is a superset of major).
        if (cache.full) { setLinkVolumeData(cache.full); return; }
        if (!needFull && cache.major) { setLinkVolumeData(cache.major); return; }
        // Full needed but only major cached → show major now while full loads.
        if (needFull && cache.major) setLinkVolumeData(cache.major);

        let cancelled = false;
        (async () => {
          const path = needFull
            ? `matsim/${searchCanton}_link_traffic_volumes.json`
            : `matsim/${searchCanton}_link_traffic_volumes.json?major=1`;
          try {
            const raw = await loadWithFallback(path);
            if (cancelled || volCacheRef.current.key !== cacheKey) return;
            const volumeMap = Object.fromEntries(
              raw.map(e => [e.link_id.toString(), e.hourly_avg_volumes])
            );
            if (needFull) volCacheRef.current.full = volumeMap;
            else volCacheRef.current.major = volumeMap;
            setLinkVolumeData(volCacheRef.current.full || volumeMap);
          } catch (err) {
            console.warn('Failed to load all link volumes', err);
          }
        })();
        return () => { cancelled = true; };
      }, [searchCanton, isGraphExpanded, datasetId, showMajorRoadsOnly]);
      
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

      }, [timeRange, linkVolumeData, isGraphExpanded, showMajorRoadsOnly, networkVersion]);

      // --- Canton change / cleanup ----------------------------------------------
      useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        
        if (searchCanton && (graphExpandedRef.current === 'Network' || graphExpandedRef.current === 'Volumes' || graphExpandedRef.current === 'VolumeFlow' || graphExpandedRef.current === 'NodeFlows' || graphExpandedRef.current === 'LinkSpeeds')) {
          loadNetworkForCanton(searchCanton);
        } else {
          safeRemoveLayer(map, ['network-layer','network-layer-hitbox','network-highlight',
            'network-label-left','network-label-right']);
          safeRemoveSource(map, ['network-source','network-highlight','ant-path']);
          loadedMajorRef.current = null;
          }
        // datasetId: on a dataset switch, reload the active network module's
        // geometry for the current canton from the new dataset (loadNetworkForCanton
        // always fetches fresh, so the stale cache is replaced).
        }, [searchCanton, datasetId]);

        useEffect(() => {
          const map = mapRef.current;
          if (!map) return;

          safeRemoveLayer(map, [
            'network-layer','network-layer-hitbox','ant-line','network-highlight',
            'network-label-left','network-label-right',
          ]);
          safeRemoveSource(map, ['network-source','ant-path','network-highlight']);

          originalNetworkGeoJSON.current = null;
          loadedMajorRef.current = null;
          // The per-canton hourly traffic volumes are cached by (dataset,
          // canton) and survive module switches; Reset means "assume this
          // session's data is stale", so drop them alongside the geometry the
          // sidebar already clears via clearNetworkGeometryCache().
          volCacheRef.current = { key: null, major: null, full: null };
          setLinkVolumeData(null);
          setFeatureGeoJSON?.(null);
          setSelectedNetworkFeature(null);
        }, [resetMapTrigger]);
      }

