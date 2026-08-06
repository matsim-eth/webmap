import React, { useState } from "react";
import "../Table.css";
import DirectionToggle from "./DirectionToggle";

const TransitStopAttributesTable = ({ properties, onLineClick, highlightedLineId, selectedDirection, setSelectedDirection, directionLabels }) => {
  if (!properties) return null;

  const { name, modes_list, lines, boardings, alightings, total } = properties;

  const [isCollapsed, setIsCollapsed] = useState(false);

  const groupedLines = lines.reduce((acc, line) => {
    if (!acc[line.line_id]) acc[line.line_id] = [];
    acc[line.line_id].push(line);
    return acc;
  }, {});

  const numLines = Object.keys(groupedLines).length;

  const activeBadge = highlightedLineId;

  // Selection is keyed purely off line_id — the duckdb boarding data has no
  // per-stop route_id, so clicking a line badge highlights the whole line.
  const handleBadgeClick = (line_id) => {
    const isActive = highlightedLineId === line_id;
    if (onLineClick) {
      onLineClick(isActive ? null : line_id);
    }
  };
  
  return (
    <div className="canton-mode-share" style={{ position: "relative" }}>
    <span
      role="button"
      tabIndex={0}
      onClick={() => setIsCollapsed(v => !v)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setIsCollapsed(v => !v); }}
      aria-label={isCollapsed ? "Expand" : "Collapse"}
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
      {isCollapsed ? "+" : "−"}
    </span>
    <h4>{name}</h4>
    {!isCollapsed && (
    <table>
    <tbody>
    <tr><td>Mode</td><td>{modes_list?.join(", ")}</td></tr>
    <tr><td>Lines</td><td>{numLines}</td></tr>
    <tr><td>Volumes</td><td>
    <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", justifyContent: "flex-end" }}>
    <div className="metric-card">
    <div className="metric-label">Boardings</div>
    <div className="metric-value">{boardings}</div>
    </div>
    <div className="metric-card">
    <div className="metric-label">Alightings</div>
    <div className="metric-value">{alightings}</div>
    </div>
    <div className="metric-card">
    <div className="metric-label">Total Volume</div>
    <div className="metric-value">{total}</div>
    </div>
    </div></td></tr>
    <tr>
    <td>Lines</td>
    <td>
    <div className="badge-container">
    {Object.entries(groupedLines).map(([lineId, routes], idx) => (
      <span
      key={idx}
      className={`mode-badge ${activeBadge === lineId ? "active" : ""}`}
      onClick={() => handleBadgeClick(lineId)}
      >
      {routes[0].line_name || lineId} ({routes[0].mode})
      </span>
    ))}
    </div>
    </td>
    </tr>
    {/* Route-direction filter (.H/.R) — only meaningful with a line selected;
        labels show each direction's most common terminus stop when known. */}
    {highlightedLineId && setSelectedDirection && (
    <tr>
    <td>Direction</td>
    <td>
      <DirectionToggle
        value={selectedDirection}
        onChange={setSelectedDirection}
        labels={directionLabels}
      />
    </td>
    </tr>
    )}
    </tbody>
    </table>
    )}
    </div>
  );
};

export default TransitStopAttributesTable;
