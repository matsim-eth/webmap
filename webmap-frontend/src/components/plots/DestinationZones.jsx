import React, { useState, useMemo, useRef, useEffect } from "react";
import Plot from "react-plotly.js";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useQuery } from "@tanstack/react-query";

import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useData } from "../../context/DataContext";

import "./DestinationZones.css";

const MODE_COLORS = {
  car: "#636efa",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
  all: "#1f77b4",
};

const MODES = [
  { value: "all", label: "All" },
  { value: "car", label: "Car" },
  { value: "pt", label: "PT" },
  { value: "bike", label: "Bike" },
  { value: "walk", label: "Walk" },
];

const PURPOSES = [
  { value: "all", label: "All" },
  { value: "work", label: "Work" },
  { value: "education", label: "Edu" },
  { value: "shop", label: "Shop" },
  { value: "leisure", label: "Leis" },
];

// Mirrors the +/- CollapseToggle from LinkSpeedsModule so destination cards
// expand/collapse the same way as other module cards.
const CollapseToggle = ({ collapsed, onToggle }) => (
  <span
    role="button"
    tabIndex={0}
    onClick={onToggle}
    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggle(); }}
    aria-label={collapsed ? "Expand" : "Collapse"}
    style={{
      position: "absolute",
      top: 8,
      right: 16,
      cursor: "pointer",
      fontSize: 18,
      lineHeight: 1,
      userSelect: "none",
      color: "var(--color-text-secondary)",
    }}
  >
    {collapsed ? "+" : "−"}
  </span>
);

const DestinationZones = ({ canton, onTotalOutflowChange, timeRange, setTimeRange }) => {
  const [selectedMode, setSelectedMode] = useState("all");
  const [selectedPurpose, setSelectedPurpose] = useState("all");
  const [isOriginMode, setIsOriginMode] = useState(true);
  // Sizing mode for arcs + dots: 'volume' (absolute trips) or 'share'
  // (relative percent of the origin's total flow).
  const [sizingMode, setSizingMode] = useState("volume");
  const [isListCollapsed, setIsListCollapsed] = useState(false);
  const [isPlotCollapsed, setIsPlotCollapsed] = useState(false);

  const {
    datasetId,
    zones, zoneByName, zoneLabel, zoneLabelPlural,
    destinationHoveredCanton, setDestinationHoveredCanton,
    destinationSelectedCanton, setDestinationSelectedCanton,
  } = useData();
  const loadWithFallback = useLoadWithFallback();

  // display name → internal zone name (was the module-level REVERSE_CANTON
  // built from canton_alias.json — same values for Swiss datasets).
  const REVERSE_CANTON = useMemo(() => {
    const acc = {};
    for (const z of zones) acc[z.displayName] = z.name;
    return acc;
  }, [zones]);
  const displayOf = (name) => zoneByName?.get(name)?.displayName || name;

  // The selected destination drives both map highlight and the trip-count plot
  // filter. null = "all cantons" (no filter applied).
  const filterCanton = destinationSelectedCanton ?? "all";
  const setFilterCanton = (next) => {
    setDestinationSelectedCanton(next === "all" ? null : next);
  };

  // effect:audited — clear the selected destination whenever the origin
  // canton changes; the previous selection no longer makes sense.
  useEffect(() => {
    setDestinationSelectedCanton(null);
  }, [canton, setDestinationSelectedCanton]);

  // Derived from the backend `destination_zones.json` provider (per-hub-canton
  // outflow/inflow by mode/purpose/15-min bin). datasetId in the key so a
  // dataset switch refetches instead of serving the previous dataset's cache.
  const { data: plotData } = useQuery({
    queryKey: ["destination-zones", canton, datasetId],
    queryFn: () => loadWithFallback(`destination_zones.json?canton=${encodeURIComponent(canton)}`),
    enabled: !!canton,
  });

  // Filtered + bucketed time series for the bottom plot.
  const trips = useMemo(() => {
    if (!plotData) return { times: [], counts: [] };
    let filtered = plotData.filter((d) => d.role === (isOriginMode ? "origin" : "destination"));

    if (filterCanton !== "all") {
      filtered = filtered.filter((d) => {
        const key = isOriginMode ? d.destination : d.origin;
        return key === filterCanton || REVERSE_CANTON[key] === filterCanton;
      });
    }
    if (selectedMode !== "all") filtered = filtered.filter((d) => d.mode === selectedMode);
    if (selectedPurpose !== "all") filtered = filtered.filter((d) => d.purpose === selectedPurpose);

    const bins = {};
    filtered.forEach((entry) => {
      Object.entries(entry.time_bins).forEach(([time, count]) => {
        const [h, m] = time.split(":").map(Number);
        const idx = h * 4 + Math.floor(m / 15);
        if (idx >= timeRange[0] && idx <= timeRange[1]) {
          bins[time] = (bins[time] || 0) + count;
        }
      });
    });
    const times = Object.keys(bins).sort();
    return { times, counts: times.map((t) => bins[t]) };
  }, [plotData, isOriginMode, filterCanton, selectedMode, selectedPurpose, timeRange, REVERSE_CANTON]);

  // Per-canton totals used to drive the map arrows + the side list. Does NOT
  // depend on `filterCanton` — the list always shows all destinations so the
  // user can pick a new filter.
  const prevOutflowRef = useRef(null);
  const outflowData = useMemo(() => {
    if (!plotData) return null;
    let filtered = plotData.filter((d) => d.role === (isOriginMode ? "origin" : "destination"));
    if (selectedPurpose !== "all") filtered = filtered.filter((d) => d.purpose === selectedPurpose);

    const blankTotals = () => ({ all: 0, car: 0, pt: 0, bike: 0, walk: 0 });
    const modeTotals = blankTotals();
    const cantonTotals = {};

    filtered.forEach((entry) => {
      Object.entries(entry.time_bins).forEach(([time, count]) => {
        const [h, m] = time.split(":").map(Number);
        const idx = h * 4 + Math.floor(m / 15);
        if (idx < timeRange[0] || idx > timeRange[1]) return;

        modeTotals.all += count;
        if (modeTotals[entry.mode] !== undefined) modeTotals[entry.mode] += count;

        let key = isOriginMode ? entry.destination : entry.origin;
        if (REVERSE_CANTON[key]) key = REVERSE_CANTON[key];
        if (!cantonTotals[key]) cantonTotals[key] = blankTotals();
        cantonTotals[key].all += count;
        if (cantonTotals[key][entry.mode] !== undefined) cantonTotals[key][entry.mode] += count;
      });
    });

    return { all: modeTotals, perCanton: cantonTotals, selectedMode, selectedPurpose, isOriginMode, originCanton: canton, sizingMode };
  }, [plotData, selectedMode, selectedPurpose, timeRange, isOriginMode, canton, sizingMode, REVERSE_CANTON]);

  if (onTotalOutflowChange && outflowData) {
    const key = JSON.stringify(outflowData);
    if (key !== prevOutflowRef.current) {
      prevOutflowRef.current = key;
      onTotalOutflowChange(outflowData);
    }
  }

  // Sorted destination list: name + count + share.
  const destinationRows = useMemo(() => {
    if (!outflowData?.perCanton) return [];
    const rows = Object.entries(outflowData.perCanton)
      .filter(([c]) => c !== canton)
      .map(([c, totals]) => ({ canton: c, volume: Number(totals?.[selectedMode]) || 0 }))
      .filter((r) => r.volume > 0)
      .sort((a, b) => b.volume - a.volume);
    const total = rows.reduce((s, r) => s + r.volume, 0);
    return rows.map((r) => ({ ...r, share: total > 0 ? r.volume / total : 0 }));
  }, [outflowData, selectedMode, canton]);

  if (!canton) {
    return (
      <div className="plot-container">
        <div className="no-selection">
          <p>No {zoneLabel.toLowerCase()} selected</p>
          <p className="hint">Click a {zoneLabel.toLowerCase()} on the map to view destination flows</p>
        </div>
      </div>
    );
  }

  if (!plotData) {
    return (
      <div className="plot-container">
        <p className="plot-empty">Loading destination data…</p>
      </div>
    );
  }

  const directionLabel = isOriginMode ? "Outflow from" : "Inflow to";

  return (
    <div className="plot-container">
      <h3 className="dz-title">{directionLabel} {displayOf(canton)}</h3>

      {/* Direction + Size by on the left (compact), time slider on the right. */}
      <div className="dz-controls-row">
        <div className="dz-view-group dz-view-narrow">
          <span className="dz-control-label">Direction</span>
          <div className="flow-direction-toggle">
            <button
              className={`flow-dir-btn${isOriginMode ? " active" : ""}`}
              onClick={() => setIsOriginMode(true)}
            >Outflow</button>
            <button
              className={`flow-dir-btn${!isOriginMode ? " active" : ""}`}
              onClick={() => setIsOriginMode(false)}
            >Inflow</button>
          </div>
        </div>
        <div className="dz-view-group dz-view-narrow">
          <span className="dz-control-label">Size by</span>
          <div className="flow-direction-toggle">
            <button
              className={`flow-dir-btn${sizingMode === "volume" ? " active" : ""}`}
              onClick={() => setSizingMode("volume")}
              title="Size by absolute trip count"
            >Volume</button>
            <button
              className={`flow-dir-btn${sizingMode === "share" ? " active" : ""}`}
              onClick={() => setSizingMode("share")}
              title="Size by share of total flow"
            >Share</button>
          </div>
        </div>
        <div className="dz-time-block">
          <span className="dz-control-label">
            Time · {formatTimeLabel(timeRange[0])} – {formatTimeLabel(timeRange[1])}
          </span>
          <Slider
            range
            min={0}
            max={96}
            step={1}
            marks={marks}
            value={timeRange}
            onChange={(val) => setTimeRange(val)}
            allowCross={false}
          />
        </div>
      </div>

      {/* "Filter" pair (mode + purpose) — two columns, label on top, chips below. */}
      <div className="dz-filter-stack">
        <div className="dz-filter-row">
          <span className="dz-control-label">Mode</span>
          <div className="flow-direction-toggle">
            {MODES.map((m) => (
              <button
                key={m.value}
                className={`flow-dir-btn${selectedMode === m.value ? " active" : ""}`}
                onClick={() => setSelectedMode(m.value)}
              >{m.label}</button>
            ))}
          </div>
        </div>
        <div className="dz-filter-row">
          <span className="dz-control-label">Purpose</span>
          <div className="flow-direction-toggle">
            {PURPOSES.map((p) => (
              <button
                key={p.value}
                className={`flow-dir-btn${selectedPurpose === p.value ? " active" : ""}`}
                onClick={() => setSelectedPurpose(p.value)}
              >{p.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Destination list — hover/click sync with map arrows */}
      <div className="canton-mode-share dz-list-card" style={{ position: "relative" }}>
        <CollapseToggle collapsed={isListCollapsed} onToggle={() => setIsListCollapsed((v) => !v)} />
        <h4>{isOriginMode ? "Destinations" : "Origins"}</h4>
        {!isListCollapsed && (destinationRows.length === 0 ? (
          <p className="dz-list-empty">No flows in this time range.</p>
        ) : (
          <div className="dz-list">
            <div
              className={`dz-list-row dz-list-all${filterCanton === "all" ? " active" : ""}`}
              onClick={() => setFilterCanton("all")}
            >
              <span className="dz-list-name">All {(zoneLabelPlural || 'Cantons').toLowerCase()}</span>
              <span className="dz-list-count">
                {destinationRows.reduce((s, r) => s + r.volume, 0).toLocaleString()}
              </span>
            </div>
            {destinationRows.map((r) => {
              const color = MODE_COLORS[selectedMode] || MODE_COLORS.all;
              const isActive = filterCanton === r.canton;
              const isHovered = destinationHoveredCanton === r.canton;
              return (
                <div
                  key={r.canton}
                  className={`dz-list-row${isActive ? " active" : ""}${isHovered ? " hovered" : ""}`}
                  onMouseEnter={() => setDestinationHoveredCanton(r.canton)}
                  onMouseLeave={() => setDestinationHoveredCanton(null)}
                  onClick={() => setFilterCanton((prev) => (prev === r.canton ? "all" : r.canton))}
                >
                  <span className="dz-list-name">{displayOf(r.canton)}</span>
                  <div className="dz-list-bar-wrap">
                    <div
                      className="dz-list-bar"
                      style={{ width: `${Math.max(2, r.share * 100)}%`, background: color }}
                    />
                  </div>
                  <span className="dz-list-count">{r.volume.toLocaleString()}</span>
                  <span className="dz-list-share">{(r.share * 100).toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Trip-count time series */}
      <div className="canton-mode-share dz-plot-card" style={{ position: "relative" }}>
        <CollapseToggle collapsed={isPlotCollapsed} onToggle={() => setIsPlotCollapsed((v) => !v)} />
        <h4>
          Trip Counts
          {filterCanton !== "all" && (
            <span className="dz-plot-filter"> · {displayOf(filterCanton)}</span>
          )}
        </h4>
        {!isPlotCollapsed && (
          <Plot
            data={[
              {
                x: trips.times,
                y: trips.counts,
                type: "bar",
                marker: { color: MODE_COLORS[selectedMode] || MODE_COLORS.all },
              },
            ]}
            layout={{
              font: { family: "Inter, sans-serif" },
              margin: { t: 30, r: 10, l: 40, b: 40 },
              xaxis: { title: { text: "Hour", standoff: 8 }, tickangle: -45, automargin: true },
              yaxis: { title: "Trip Count" },
              height: 260,
              width: 520,
              paper_bgcolor: "rgba(255,255,255,0)",
              plot_bgcolor: "rgba(255,255,255,0)",
            }}
          />
        )}
      </div>
    </div>
  );
};

export default DestinationZones;
