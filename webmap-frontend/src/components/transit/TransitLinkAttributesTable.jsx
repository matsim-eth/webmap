import React, { useState } from "react";
import "../Table.css";

const TransitLinkAttributesTable = ({ propertiesList, onLineClick, highlightedLineId, timeRange, linkFilter, volumesByLink }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  if (!propertiesList || !Array.isArray(propertiesList) || propertiesList.length === 0) return null;

  const startTick = timeRange?.[0] ?? 0;
  const endTick = timeRange?.[1] ?? 96;

  // Narrow the displayed links to a chosen subset (the "Link ID" dropdown or a
  // per-direction split selection). null/empty → show every link on the segment.
  const keep = Array.isArray(linkFilter) && linkFilter.length
    ? new Set(linkFilter.map(String))
    : null;

  // Collect common info (assuming all links share same metadata structure)
  const linkIds = Array.from(
    new Set(
      propertiesList.flatMap(p => {
        if (Array.isArray(p.link_ids) && p.link_ids.length) return p.link_ids.map(String);
        if (p.per_id_keys && typeof p.per_id_keys === "string") {
          return p.per_id_keys.split("|").filter(Boolean).map(String);
        }
        return p.id ? [String(p.id)] : [];
      })
    )
  ).filter(id => !keep || keep.has(id)).join(", ");
  
  // Helpers for dedup rows like the MATSim network table
  const fmtNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n)}` : "-";
  };
  const fmtSpeed = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n)} km/h` : "-"; // m/s -> km/h
  };
  const allEqual = (arr) => (arr.length === 0 ? true : arr.every((x) => x === arr[0]));

  // Collect per_id numeric values across all selected features using pipe-separated format
    const collectPerIdValues = (propKey) => {
    const seen = new Map(); // id -> number
    for (const p of propertiesList) {
      const keysRaw = p?.per_id_keys;
      const valuesRaw = p?.[propKey];
      
      // Skip if either property doesn't exist or isn't a string
      if (typeof keysRaw !== "string" || typeof valuesRaw !== "string") continue;
      
      const keys = keysRaw.split("|").filter(Boolean);
      const values = valuesRaw.split("|").filter(Boolean);
      
      keys.forEach((id, index) => {
        if (keep && !keep.has(String(id))) return;
        const num = Number(values[index]);
        if (Number.isFinite(num) && !seen.has(String(id))) {
          seen.set(String(id), num);
        }
      });
    }
    return Array.from(seen.entries()).map(([id, num]) => ({ id, num }));
  };

  const getFirstTopLevelNumber = (propKey) => {
    for (const p of propertiesList) {
      const num = Number(p?.[propKey]);
      if (Number.isFinite(num)) return num;
    }
    return undefined;
  };
  // With a link filter active, rebuild lines/volumes from the per-link lookup
  // (volumesByLink, published by useTransitVolumesLayer via DataContext) — the
  // feature props only carry segment-level merges, so summing those would keep
  // showing BOTH directions' volumes no matter which link is chosen. Falls
  // back to the segment-level merge when no filter is set or the lookup can't
  // resolve the ids (e.g. legacy props carrying raw per_id_keys).
  const cleanId = (id) => String(id).split("_").map((p) => p.split(":")[0]).join("_");
  const keptEntries = keep && volumesByLink
    ? Array.from(keep, (id) => volumesByLink[id] ?? volumesByLink[cleanId(id)]).filter(Boolean)
    : null;
  const useByLink = !!(keptEntries && keptEntries.length);

  // Build merged lines dict, preserving name + mode if present
  const allLines = {};
  const mergeLinesInto = (lines) => {
    for (const [lineId, line] of Object.entries(lines || {})) {
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
  };
  if (useByLink) {
    for (const e of keptEntries) mergeLinesInto(e.lines);
  } else {
    for (const p of propertiesList) mergeLinesInto(p.lines);
  }

  const allModes = useByLink
    ? Array.from(new Set(keptEntries.flatMap((e) => e.modes_list || [])))
    : Array.from(new Set(propertiesList.flatMap((p) => p.modes || [])));

  // Total volumes — per-link full-day totals when filtered, segment totals otherwise
  const totalVolume = useByLink
    ? keptEntries.reduce((sum, e) => sum + (Number(e.linkTotal) || 0), 0)
    : propertiesList.reduce((sum, p) => sum + (p.total_volume ?? 0), 0);
  
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
    <h4>Transit Segment Info</h4>
    {!isCollapsed && (
    <table>
    <tbody>
    <tr><td>Link(s)</td><td>{linkIds}</td></tr>
    <tr><td>Modes</td><td>{allModes.join(", ")}</td></tr>
    <tr><td>Lines</td><td>{lineEntries.length}</td></tr>
    {/* Length (per-id dedup) */}
    {(() => {
      const vals = collectPerIdValues("length");
      if (vals.length === 0) {
        const top = getFirstTopLevelNumber("length");
        return (
          <tr>
            <td>Length</td>
            <td>{Number.isFinite(top) ? `${fmtNum(top)} m` : "-"}</td>
          </tr>
        );
      }
      const only = vals.map(v => v.num);
      const equal = allEqual(only);
      return (
        <tr>
          <td>Length</td>
          <td>
            {equal ? (
              <div>{`${fmtNum(only[0])} m`}</div>
            ) : (
              vals.map(({ id, num }) => (
                <div key={id} style={{ marginBottom: "0.25rem" }}>
                  {`${fmtNum(num)} m`} <span style={{ color: "#888" }}>(ID: {id})</span>
                </div>
              ))
            )}
          </td>
        </tr>
      );
    })()}

    {/* Freespeed (per-id dedup) */}
    {(() => {
      const vals = collectPerIdValues("freespeed");
      if (vals.length === 0) {
        const top = getFirstTopLevelNumber("freespeed");
        return (
          <tr>
            <td>Freespeed</td>
            <td>{Number.isFinite(top) ? fmtSpeed(top) : "-"}</td>
          </tr>
        );
      }
      const only = vals.map(v => v.num);
      const equal = allEqual(only);
      return (
        <tr>
          <td>Freespeed</td>
          <td>
            {equal ? (
              <div>{fmtSpeed(only[0])}</div>
            ) : (
              vals.map(({ id, num }) => (
                <div key={id} style={{ marginBottom: "0.25rem" }}>
                  {fmtSpeed(num)} <span style={{ color: "#888" }}>(ID: {id})</span>
                </div>
              ))
            )}
          </td>
        </tr>
      );
    })()}
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
    )}
    </div>
  );
};

export default TransitLinkAttributesTable;
