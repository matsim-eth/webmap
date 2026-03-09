import React, { useEffect, useState } from "react";
import { useDashboard } from "../../context/DashboardContext";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import cantonAlias from "../../utils/canton_alias.json";

const TransitStopSummary = () => {
  const { selectedCanton, selectedTransitStop, selectedTransitLine } = useDashboard();
  const [totals, setTotals] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  useEffect(() => {
    if (!selectedCanton || selectedCanton === "All") {
      setTotals(null);
      return;
    }

    const dataPath = `matsim/transit/per_canton_counts/${selectedCanton}_counts.json`;

    loadWithFallback(dataPath)
      .then((data) => {
        let filteredData = data;

        // Filter by selected stop
        if (selectedTransitStop && selectedTransitStop.stop_ids) {
          const cleanedIds = selectedTransitStop.stop_ids.flatMap((s) => {
            if (Array.isArray(s)) return s;
            try {
              return JSON.parse(s);
            } catch {
              return String(s).split(",").map((id) => id.trim());
            }
          });
          filteredData = data.filter((d) => cleanedIds.includes(String(d.stop_id)));
        }

        // Filter by selected line
        if (selectedTransitLine) {
          filteredData = filteredData.filter(
            (d) => String(d.line_id) === String(selectedTransitLine)
          );
        }

        // Sum all boardings and alightings across all time bins
        let totalBoardings = 0;
        let totalAlightings = 0;
        for (const row of filteredData) {
          for (const t of row.data) {
            totalBoardings += t.boardings ?? 0;
            totalAlightings += t.alightings ?? 0;
          }
        }

        setTotals({ boardings: totalBoardings, alightings: totalAlightings });
      })
      .catch((error) => {
        console.error("Error loading summary data:", error);
        setTotals(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCanton, selectedTransitStop, selectedTransitLine]);

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
        let linesArray = selectedTransitStop.lines;
        if (typeof linesArray === "string") {
          try { linesArray = JSON.parse(linesArray); } catch { linesArray = []; }
        }
        const lineObj = Array.isArray(linesArray)
          ? linesArray.find((l) => String(l.line_id) === String(selectedTransitLine))
          : null;
        const lineName =
          lineObj?.line_name || lineObj?.lineName || lineObj?.name || selectedTransitLine;
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

  if (!totals) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="plot-loading">Loading…</div>
      </div>
    );
  }

  const fmt = (n) => n.toLocaleString();
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const StatCard = ({ label, value, bg, border, labelColor, valueColor }) => (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: "12px",
        padding: "20px 16px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 600,
          color: labelColor,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: "8px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "2rem",
          fontWeight: 700,
          color: valueColor,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
    </div>
  );

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

      {/* ── Volume cards ── */}
      <div
        style={{
          display: "flex",
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: "12px",
            width: "100%",
          }}
        >
          <StatCard label="Total Boardings"  value={fmt(totals.boardings)}                     bg="linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)" border="#93c5fd" labelColor="#1d4ed8" valueColor="#1e40af" />
          <StatCard label="Total Alightings" value={fmt(totals.alightings)}                    bg="linear-gradient(135deg, #ffedd5 0%, #fed7aa 100%)" border="#fdba74" labelColor="#c2410c" valueColor="#9a3412" />
          <StatCard label="Total Volume"     value={fmt(totals.boardings + totals.alightings)} bg="linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)" border="#86efac" labelColor="#15803d" valueColor="#166534" />
        </div>
      </div>
    </div>
  );
};

export default TransitStopSummary;
