import React, { useMemo } from "react";
import { useDashboard } from "../../context/DashboardContext";
import {
  useTransitDatasets,
  useCantonCountsPerDataset,
  useStopAlignment,
  resolveLineId,
  getLineNameFromStop,
  filterCountRows,
} from "../../hooks/useTransitComparison";
import cantonAlias from "../../utils/canton_alias.json";
import PlotLoader from "./PlotLoader";

// Full-width stat row (label left, value(s) right) — stacked vertically like
// the Speed page's "Network Summary" rows, so large totals never overflow.
// In comparison mode (`compact`) the right side stacks one value per dataset,
// each tagged with the dataset's slot color.
const StatRow = ({ label, values, accent, compact }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
      padding: "12px 16px",
      borderRadius: "10px",
      background: "var(--color-bg, #f3f4f6)",
    }}
  >
    <div
      style={{
        fontSize: "12px",
        fontWeight: 600,
        color: "#64748b",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </div>
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "2px" }}>
      {values.map(({ key, value, dotColor, name }) => (
        <div key={key} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {dotColor && (
            <span
              title={name}
              style={{
                width: "9px",
                height: "9px",
                borderRadius: "50%",
                background: dotColor,
                display: "inline-block",
                flexShrink: 0,
              }}
            />
          )}
          <span
            style={{
              fontSize: compact ? "1.25rem" : "1.6rem",
              fontWeight: 700,
              color: accent,
              lineHeight: 1.1,
            }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  </div>
);

const TransitStopSummary = () => {
  const { selectedCanton, selectedTransitStop, selectedTransitLine } = useDashboard();

  const datasets = useTransitDatasets();
  const isComparison = datasets.length > 1;
  const countsPerDataset = useCantonCountsPerDataset(selectedCanton);
  const { resolveStopIds } = useStopAlignment(selectedCanton);

  // Per-dataset boardings/alightings totals. Single mode reduces to the
  // legacy pipeline (cleaned stop ids + line filter, no alignment).
  const perDataset = useMemo(() => {
    return countsPerDataset.map(({ dataset, rows }) => {
      if (!rows) return { dataset, totals: null, unmatched: false };

      const stopIds = selectedTransitStop?.stop_ids
        ? resolveStopIds(dataset, selectedTransitStop)
        : undefined;
      let lineId = selectedTransitLine ?? null;
      if (lineId != null && !dataset.isPrimary) {
        lineId = resolveLineId(rows, lineId, getLineNameFromStop(selectedTransitStop, lineId));
      }

      const filtered = filterCountRows(rows, { stopIds, lineId });
      let boardings = 0;
      let alightings = 0;
      for (const row of filtered) {
        for (const t of row.data) {
          boardings += t.boardings ?? 0;
          alightings += t.alightings ?? 0;
        }
      }
      return { dataset, totals: { boardings, alightings }, unmatched: stopIds === null };
    });
  }, [countsPerDataset, resolveStopIds, selectedTransitStop, selectedTransitLine]);

  // --- Lines / routes stats (from stop properties, no extra fetch needed) ---
  const lineStats = (() => {
    if (!selectedTransitStop?.lines) return null;
    let linesArray = selectedTransitStop.lines;
    if (typeof linesArray === "string") {
      try { linesArray = JSON.parse(linesArray); } catch { return null; }
    }
    if (!Array.isArray(linesArray) || linesArray.length === 0) return null;

    // Each entry in lines[] is a route; group by line_id to count unique lines
    const groupedByLine = linesArray.reduce((acc, l) => {
      const id = String(l.line_id);
      if (!acc[id]) acc[id] = [];
      acc[id].push(l);
      return acc;
    }, {});

    const numLines = Object.keys(groupedByLine).length;   // unique line_ids
    const numRoutes = linesArray.length;                   // total route entries

    // Modes come from the stop-level modes_list property
    let modes = [];
    if (selectedTransitStop.modes_list) {
      const raw = selectedTransitStop.modes_list;
      if (Array.isArray(raw)) {
        modes = raw;
      } else {
        // Handle stringified arrays like '["rail"]' or plain "rail,bus"
        const str = String(raw).trim();
        if (str.startsWith("[")) {
          try { modes = JSON.parse(str); } catch { modes = [str]; }
        } else {
          modes = str.split(",").map((m) => m.trim()).filter(Boolean);
        }
      }
    }

    return { lines: numLines, routes: numRoutes, modes };
  })();

  // --- Label helpers ---
  const scopeLabel = (() => {
    if (selectedTransitStop) {
      if (selectedTransitLine) {
        const lineName =
          getLineNameFromStop(selectedTransitStop, selectedTransitLine) || selectedTransitLine;
        return `${selectedTransitStop.name} (${lineName})`;
      }
      return selectedTransitStop.name;
    }
    return cantonAlias[selectedCanton] || selectedCanton;
  })();

  // --- Render states ---
  if (!selectedCanton || selectedCanton === "All") {
    return (
      <div className="plot-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="plot-loading">Please select a specific canton</div>
      </div>
    );
  }

  const ready = perDataset.filter((d) => d.totals);
  if (ready.length === 0) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <PlotLoader />
      </div>
    );
  }

  const fmt = (n) => n.toLocaleString();
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const buildValues = (pick) =>
    ready.map(({ dataset, totals, unmatched }) => ({
      key: dataset.datasetId,
      name: dataset.name,
      dotColor: isComparison ? dataset.color : null,
      value: unmatched ? "—" : fmt(pick(totals)),
    }));

  const unmatchedNames = ready
    .filter((d) => d.unmatched)
    .map((d) => d.dataset.name);

  return (
    <div
      className="plot-wrapper"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0",
        padding: "8px 4px",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      <h4 className="plot-title" style={{ marginBottom: "10px" }}>
        Daily Summary - {scopeLabel}
      </h4>

      {/* ── Metadata strip ── */}
      {lineStats && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "8px",
            flexWrap: "wrap",
            marginBottom: "16px",
          }}
        >
          <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>
            {lineStats.lines} {lineStats.lines === 1 ? "line" : "lines"}
          </span>
          <span style={{ color: "#cbd5e1", fontSize: "13px" }}>·</span>
          <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>
            {lineStats.routes} {lineStats.routes === 1 ? "route" : "routes"}
          </span>
          {lineStats.modes.length > 0 && (
            <span style={{ color: "#cbd5e1", fontSize: "13px" }}>·</span>
          )}
          {lineStats.modes.map((m) => {
            const modeColors = {
              rail:    { bg: "#ede9fe", color: "#6d28d9", dot: "#7c3aed" },
              bus:     { bg: "#dbeafe", color: "#1d4ed8", dot: "#3b82f6" },
              tram:    { bg: "#d1fae5", color: "#065f46", dot: "#10b981" },
              subway:  { bg: "#fce7f3", color: "#9d174d", dot: "#ec4899" },
              ferry:   { bg: "#cffafe", color: "#155e75", dot: "#06b6d4" },
              funicular: { bg: "#fef9c3", color: "#854d0e", dot: "#eab308" },
            };
            const c = modeColors[m.toLowerCase()] ?? { bg: "#f1f5f9", color: "#475569", dot: "#94a3b8" };
            return (
              <span
                key={m}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: c.color,
                  background: c.bg,
                  borderRadius: "20px",
                  padding: "2px 9px 2px 7px",
                }}
              >
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: c.dot, display: "inline-block", flexShrink: 0 }} />
                {cap(m)}
              </span>
            );
          })}
        </div>
      )}

      {/* ── Comparison legend / unmatched note ── */}
      {isComparison && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "14px",
            flexWrap: "wrap",
            marginBottom: "10px",
          }}
        >
          {ready.map(({ dataset }) => (
            <span
              key={dataset.datasetId}
              style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#475569", fontWeight: 500 }}
            >
              <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: dataset.color, display: "inline-block", flexShrink: 0 }} />
              {dataset.name}
            </span>
          ))}
        </div>
      )}
      {unmatchedNames.length > 0 && (
        <div style={{ textAlign: "center", fontSize: "11px", color: "#b45309", marginBottom: "8px" }}>
          Stop not matched (by id or name) in: {unmatchedNames.join(", ")}
        </div>
      )}

      {/* ── Volume stats (Network-Summary style, stacked rows) ── */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          justifyContent: "center",
          gap: "10px",
        }}
      >
        {/* In comparison mode the slot-color dots already carry the dataset
            identity, so the numbers use a single neutral color to avoid a
            second, conflicting color signal. */}
        <StatRow label="Total Boardings"  values={buildValues((t) => t.boardings)}                accent={isComparison ? "#334155" : "#1d4ed8"} compact={isComparison} />
        <StatRow label="Total Alightings" values={buildValues((t) => t.alightings)}               accent={isComparison ? "#334155" : "#c2410c"} compact={isComparison} />
        <StatRow label="Total Volume"     values={buildValues((t) => t.boardings + t.alightings)} accent={isComparison ? "#334155" : "#15803d"} compact={isComparison} />
      </div>
    </div>
  );
};

export default TransitStopSummary;
