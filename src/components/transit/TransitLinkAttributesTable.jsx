import React from "react";
import "../Table.css";

const TransitLinkAttributesTable = ({ propertiesList, onLineClick, highlightedLineId, timeRange }) => {
  if (!propertiesList || !Array.isArray(propertiesList) || propertiesList.length === 0) return null;
  
  const startTick = timeRange?.[0] ?? 0;
  const endTick = timeRange?.[1] ?? 96;
  
  // Collect common info (assuming all links share same metadata structure)
  const linkIds = Array.from(
    new Set(
      propertiesList.flatMap(p => {
        if (Array.isArray(p.link_ids) && p.link_ids.length) return p.link_ids.map(String);
        if (p.per_id && typeof p.per_id === "object") return Object.keys(p.per_id).map(String);
        return p.id ? [String(p.id)] : [];
      })
    )
  ).join(", ");
  
  const length = propertiesList[0].length;
  const freespeed = propertiesList[0].freespeed;
  const allModes = Array.from(new Set(propertiesList.flatMap((p) => p.modes || [])));
  // Build merged lines dict, preserving name + mode if present
  const allLines = {};
  
  for (const p of propertiesList) {
    const lines = p.lines || {};
    for (const [lineId, line] of Object.entries(lines)) {
      const lineName = line.line_name ?? line.lineName ?? line.name ?? null; // handle snake/camel
      const mode = line.mode ?? null;
      
      if (!allLines[lineId]) {
        allLines[lineId] = {
          total: 0,
          timeBins: {},
          line_name: lineName,
          mode
        };
      } else {
        if (!allLines[lineId].line_name && lineName) allLines[lineId].line_name = lineName;
        if (!allLines[lineId].mode && mode) allLines[lineId].mode = mode;
      }
      
      // Merge total
      if (typeof line.total === "number") allLines[lineId].total += line.total ?? 0;
      
      // Merge timeBins
      const dest = allLines[lineId].timeBins;
      const src = line.timeBins || {};
      for (const key in src) dest[key] = (dest[key] ?? 0) + (src[key] ?? 0);
    }
  }
  // Total volumes
  const totalVolume = propertiesList.reduce((sum, p) => sum + (p.total_volume ?? 0), 0);
  
  let filteredVolume = 0;
  
  const lineFilter = highlightedLineId ? [highlightedLineId] : Object.keys(allLines);
  
  for (const lineId of lineFilter) {
    const line = allLines[lineId];
    if (!line) continue;
    
    const timeBins = line.timeBins || {};
    for (let h = startTick; h < endTick; h++) {
      const hour = Math.floor(h / 4).toString().padStart(2, '0');
      const minute = ((h % 4) * 15).toString().padStart(2, '0');
      const key = `${hour}:${minute}`;
      filteredVolume += timeBins[key] ?? 0;
    }
  }
  
  const lineEntries = Object.entries(allLines);
  const activeBadge = highlightedLineId;
  
  const handleBadgeClick = (lineId) => {
    const isActive = highlightedLineId === lineId;
    if (onLineClick) {
      onLineClick(isActive ? null : lineId);
    }
  };
  
  return (
    <div className="canton-mode-share">
    <h4>Transit Segment Info</h4>
    <table>
    <tbody>
    <tr><td>Link(s)</td><td>{linkIds}</td></tr>
    <tr><td>Modes</td><td>{allModes.join(", ")}</td></tr>
    <tr><td>Lines</td><td>{lineEntries.length}</td></tr>
    <tr><td>Length</td><td>{length?.toFixed(1)} m</td></tr>
    <tr><td>Freespeed</td><td>{(freespeed * 3.6).toFixed(1)} km/h</td></tr>
    <tr>
    <td>Volumes</td>
    <td>
    <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
    <div className="metric-card">
    <div className="metric-label">Filtered</div>
    <div className="metric-value">{filteredVolume}</div>
    </div>
    <div className="metric-card">
    <div className="metric-label">Total</div>
    <div className="metric-value">{totalVolume}</div>
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
      {line.line_name || lineId} ({line.mode})
      </span>
    ))}
    </div>
    </td>
    </tr>
    </tbody>
    </table>
    </div>
  );
};

export default TransitLinkAttributesTable;
