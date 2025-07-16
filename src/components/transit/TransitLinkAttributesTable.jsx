import React, { useState } from "react";
import "../Table.css";

const TransitLinkAttributesTable = ({ properties, onLineClick, highlightedLineId, timeRange }) => {
    if (!properties) return null;
    
    const { id, modes, lines, total_volume, length, freespeed } = properties;

    const startTick = timeRange?.[0] ?? 0;
const endTick = timeRange?.[1] ?? 96;

let filtered_volume = 0;

if (lines) {
  const lineFilter = highlightedLineId ? [highlightedLineId] : Object.keys(lines);

  for (const lineId of lineFilter) {
    const line = lines[lineId];
    if (!line) continue;

    const timeBins = line.timeBins || {};
    for (let h = startTick; h < endTick; h++) {
      const hour = Math.floor(h / 4).toString().padStart(2, '0');
      const minute = ((h % 4) * 15).toString().padStart(2, '0');
      const key = `${hour}:${minute}`;
      filtered_volume += timeBins[key] ?? 0;
    }
  }
}
    
    const lineEntries = Object.entries(lines || {});
    
    const activeBadge = highlightedLineId;
    
    const handleBadgeClick = (lineId) => {
        const isActive = highlightedLineId === lineId;
        if (onLineClick) {
            onLineClick(isActive ? null : lineId);
        }
    };
    
    return (
        <div className="canton-mode-share">
        <h4>Link {id}</h4>
        <table>
        <tbody>
        <tr><td>Modes</td><td>{modes?.join(", ")}</td></tr>
        <tr><td>Lines</td><td>{lineEntries.length}</td></tr>
        <tr><td>Length</td><td>{length?.toFixed(1)} m</td></tr>
        <tr><td>Freespeed</td><td>{(freespeed * 3.6).toFixed(1)} km/h</td></tr>
        <tr><td>Volumes</td>
        <td>
        <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <div className="metric-card">
        <div className="metric-label">Filtered</div>
        <div className="metric-value">{filtered_volume}</div>
        </div>
        <div className="metric-card">
        <div className="metric-label">Total</div>
        <div className="metric-value">{total_volume}</div>
        </div>
        </div>
        </td>
        </tr>
        <tr>
        <td>Lines</td>
        <td>
        <div className="badge-container">
        {lineEntries.map(([lineId, line], idx) => (
            <span
            key={idx}
            className={`mode-badge ${activeBadge === lineId ? "active" : ""}`}
            onClick={() => handleBadgeClick(lineId)}
            >
            {line.lineName || lineId} ({line.mode})
            </span>
        ))}
        </div>
        {lineEntries.length > 0 && (
            <div
            onClick={() => setShowLines(!showLines)}
            style={{
                fontWeight: "bold",
                fontSize: "10pt",
                marginTop: "0.5rem",
                cursor: "pointer",
                userSelect: "none",
                color: "#333"
            }}
            >
            </div>
        )}
        </td>
        </tr>
        </tbody>
        </table>
        </div>
    );
};

export default TransitLinkAttributesTable;
