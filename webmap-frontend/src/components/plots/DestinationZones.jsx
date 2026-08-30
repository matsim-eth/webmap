import React, { useState, useMemo, useRef, useEffect } from "react";
import Plot from "react-plotly.js";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useQuery } from "@tanstack/react-query";

import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { socioFiltersToParams } from "../filters/socioFilterConfig";

import "./DestinationZones.css";

const MODE_COLORS = {
  car: "#636efa",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
  all: "#1f77b4",
};

// Mirrors PURPOSE_PALETTE in useDestinationZones.js.
const PURPOSE_COLORS = {
  work: "#FFEE8C",
  education: "#636efa",
  shop: "#ffa15a",
  leisure: "#00cc96",
};

// Same hex as HUB_COLOR in useDestinationZones.js — the within-hub list row
// shares the hub marker's color.
const HUB_COLOR = "#ea580c";

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

// Multiselect filters: empty array = "All". Note every chip selected is NOT
// the same as "All" — the data holds modes/purposes beyond the chips (e.g.
// car_passenger, home), so an explicit full selection stays explicit.
const toggleSelection = (list, value) =>
  list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

// Sum a per-canton totals bucket ({all, car, pt, bike, walk}) over the
// selected modes; empty selection means "all modes".
const sumModes = (totals, modes) =>
  modes.length
    ? modes.reduce((s, m) => s + (Number(totals?.[m]) || 0), 0)
    : Number(totals?.all) || 0;

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
  // Multiselect filters — empty array means "All".
  const [selectedModes, setSelectedModes] = useState([]);
  const [selectedPurposes, setSelectedPurposes] = useState([]);
  const [isOriginMode, setIsOriginMode] = useState(true);
  // Sizing mode for arcs + dots: 'volume' (absolute trips) or 'share'
  // (relative percent of the origin's total flow).
  const [sizingMode, setSizingMode] = useState("volume");
  const [isListCollapsed, setIsListCollapsed] = useState(false);
  const [isPlotCollapsed, setIsPlotCollapsed] = useState(false);
  // Off (default) hides intra-polygon trips everywhere — list, plot, totals,
  // hub sizing — matching the module's original inter-canton-only view.
  const [showInternalTrips, setShowInternalTrips] = useState(false);

  const {
    datasetId,
    zones, zoneByName, zoneLabel, zoneLabelPlural,
    destinationHoveredCanton, setDestinationHoveredCanton,
    destinationSelectedCanton, setDestinationSelectedCanton,
  } = useData();
  const { socioFilters } = useFilters();
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
  // dataset switch refetches instead of serving the previous dataset's cache;
  // socioFilters in the key so changing a socioeconomic filter refetches.
  const { data: plotData } = useQuery({
    queryKey: ["destination-zones", canton, datasetId, socioFilters],
    queryFn: () => {
      const params = new URLSearchParams({ canton });
      for (const [k, v] of Object.entries(socioFiltersToParams(socioFilters))) params.set(k, v);
      return loadWithFallback(`destination_zones.json?${params.toString()}`);
    },
    enabled: !!canton,
  });

  // Intra-polygon record test: the "other" end of the flow is the hub itself.
  // The backend always ships these rows; the "Show internal trips" toggle
  // decides whether the module uses them.
  const isIntraRecord = (d) => {
    const key = isOriginMode ? d.destination : d.origin;
    return key === canton || REVERSE_CANTON[key] === canton;
  };

  // Filtered + bucketed time series for the bottom plot.
  const trips = useMemo(() => {
    if (!plotData) return { times: [], counts: [] };
    let filtered = plotData.filter((d) => d.role === (isOriginMode ? "origin" : "destination"));
    if (!showInternalTrips) filtered = filtered.filter((d) => !isIntraRecord(d));

    if (filterCanton !== "all") {
      filtered = filtered.filter((d) => {
        const key = isOriginMode ? d.destination : d.origin;
        return key === filterCanton || REVERSE_CANTON[key] === filterCanton;
      });
    }
    if (selectedModes.length) filtered = filtered.filter((d) => selectedModes.includes(d.mode));
    if (selectedPurposes.length) filtered = filtered.filter((d) => selectedPurposes.includes(d.purpose));

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
  }, [plotData, isOriginMode, filterCanton, selectedModes, selectedPurposes, timeRange, REVERSE_CANTON, showInternalTrips, canton]);

  // Per-canton totals used to drive the map arrows + the side list. Does NOT
  // depend on `filterCanton` — the list always shows all destinations so the
  // user can pick a new filter.
  const prevOutflowRef = useRef(null);
  const outflowData = useMemo(() => {
    if (!plotData) return null;
    let filtered = plotData.filter((d) => d.role === (isOriginMode ? "origin" : "destination"));
    if (!showInternalTrips) filtered = filtered.filter((d) => !isIntraRecord(d));
    if (selectedPurposes.length) filtered = filtered.filter((d) => selectedPurposes.includes(d.purpose));

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

    return { all: modeTotals, perCanton: cantonTotals, selectedModes, selectedPurposes, isOriginMode, originCanton: canton, sizingMode, showInternalTrips };
  }, [plotData, selectedModes, selectedPurposes, timeRange, isOriginMode, canton, sizingMode, REVERSE_CANTON, showInternalTrips]);

  if (onTotalOutflowChange && outflowData) {
    const key = JSON.stringify(outflowData);
    if (key !== prevOutflowRef.current) {
      prevOutflowRef.current = key;
      onTotalOutflowChange(outflowData);
    }
  }

  // Sorted destination list: name + count + share. The hub's intra-canton
  // trips become a pinned "Within" row, and shares are computed over the
  // polygon's full trip total (inter-canton + within) so they sum to 100%.
  const { destinationRows, withinRow, grandTotal } = useMemo(() => {
    if (!outflowData?.perCanton) return { destinationRows: [], withinRow: null, grandTotal: 0 };
    const rows = Object.entries(outflowData.perCanton)
      .filter(([c]) => c !== canton)
      .map(([c, totals]) => ({ canton: c, volume: sumModes(totals, selectedModes) }))
      .filter((r) => r.volume > 0)
      .sort((a, b) => b.volume - a.volume);
    const withinVolume = sumModes(outflowData.perCanton[canton], selectedModes);
    const total = rows.reduce((s, r) => s + r.volume, 0) + withinVolume;
    return {
      destinationRows: rows.map((r) => ({ ...r, share: total > 0 ? r.volume / total : 0 })),
      withinRow: withinVolume > 0
        ? { canton, volume: withinVolume, share: total > 0 ? withinVolume / total : 0 }
        : null,
      grandTotal: total,
    };
  }, [outflowData, selectedModes, canton]);

  // Shared color rule (same as the map hook / legend): exactly one purpose
  // selected wins, else exactly one mode, else the "all" blue.
  const activeColor =
    (selectedPurposes.length === 1 && PURPOSE_COLORS[selectedPurposes[0]]) ||
    (selectedModes.length === 1 && MODE_COLORS[selectedModes[0]]) ||
    MODE_COLORS.all;

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
      <div className="dz-title-row">
        <h3 className="dz-title">{directionLabel} {displayOf(canton)}</h3>
        {/* Internal-trips toggle — same checkbox style as "Show only major roads". */}
        <label className="right-sidebar-checkbox dz-internal-toggle">
          <input
            type="checkbox"
            checked={showInternalTrips}
            onChange={(e) => {
              const on = e.target.checked;
              setShowInternalTrips(on);
              // The "Within" filter can't stay selected once its row is hidden.
              if (!on && filterCanton === canton) setFilterCanton("all");
            }}
          />
          Show internal trips
        </label>
      </div>

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
                className={`flow-dir-btn${(m.value === "all" ? selectedModes.length === 0 : selectedModes.includes(m.value)) ? " active" : ""}`}
                onClick={() => setSelectedModes((prev) => (
                  m.value === "all" ? [] : toggleSelection(prev, m.value)
                ))}
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
                className={`flow-dir-btn${(p.value === "all" ? selectedPurposes.length === 0 : selectedPurposes.includes(p.value)) ? " active" : ""}`}
                onClick={() => setSelectedPurposes((prev) => (
                  p.value === "all" ? [] : toggleSelection(prev, p.value)
                ))}
              >{p.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Destination list — hover/click sync with map arrows */}
      <div className="canton-mode-share dz-list-card" style={{ position: "relative" }}>
        <CollapseToggle collapsed={isListCollapsed} onToggle={() => setIsListCollapsed((v) => !v)} />
        <h4>{isOriginMode ? "Destinations" : "Origins"}</h4>
        {!isListCollapsed && (destinationRows.length === 0 && !withinRow ? (
          <p className="dz-list-empty">No flows in this time range.</p>
        ) : (
          <div className="dz-list">
            <div
              className={`dz-list-row dz-list-all${filterCanton === "all" ? " active" : ""}`}
              onClick={() => setFilterCanton("all")}
            >
              <span className="dz-list-name">All {(zoneLabelPlural || 'Cantons').toLowerCase()}</span>
              <span className="dz-list-count">{grandTotal.toLocaleString()}</span>
            </div>
            {withinRow && (
              <div
                className={`dz-list-row dz-list-within${filterCanton === canton ? " active" : ""}${destinationHoveredCanton === canton ? " hovered" : ""}`}
                onMouseEnter={() => setDestinationHoveredCanton(canton)}
                onMouseLeave={() => setDestinationHoveredCanton(null)}
                onClick={() => setFilterCanton((prev) => (prev === canton ? "all" : canton))}
              >
                <span className="dz-list-name">Within {displayOf(canton)}</span>
                <div className="dz-list-bar-wrap">
                  <div
                    className="dz-list-bar"
                    style={{ width: `${Math.max(2, withinRow.share * 100)}%`, background: HUB_COLOR }}
                  />
                </div>
                <span className="dz-list-count">{withinRow.volume.toLocaleString()}</span>
                <span className="dz-list-share">{(withinRow.share * 100).toFixed(1)}%</span>
              </div>
            )}
            {destinationRows.map((r) => {
              const color = activeColor;
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
            <span className="dz-plot-filter">
              {" · "}{filterCanton === canton ? `Within ${displayOf(canton)}` : displayOf(filterCanton)}
            </span>
          )}
        </h4>
        {!isPlotCollapsed && (
          <Plot
            data={[
              {
                x: trips.times,
                y: trips.counts,
                type: "bar",
                marker: { color: filterCanton === canton ? HUB_COLOR : activeColor },
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
