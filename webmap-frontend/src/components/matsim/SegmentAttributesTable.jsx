import React, { useState } from "react";
import "../Table.css";

const fmtNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}` : "-";
};
const allEqual = (arr) => (arr.length === 0 ? true : arr.every((x) => x === arr[0]));

const SegmentAttributesTable = ({ propertiesList, selectedGraph, filteredVolume, linkFilter }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  if (!propertiesList || propertiesList.length === 0) return null;

  const top = propertiesList[0] || {};

  // Parse pipe-separated strings into arrays
  let keys = (top.per_id_keys || "").split("|").filter(Boolean);
  let capacities = (top.per_id_capacities || "").split("|").filter(Boolean);
  let lengths = (top.per_id_lengths || "").split("|").filter(Boolean);
  let freespeeds = (top.per_id_freespeeds || "").split("|").filter(Boolean);
  let daily_avgs = (top.per_id_daily_avgs || "").split("|").filter(Boolean);
  let permlanes = (top.per_id_permlanes || "").split("|").filter(Boolean);

  // Narrow the per-link arrays to a chosen subset (the Link ID dropdown or a
  // per-direction split selection). null/empty → show every link on the segment.
  if (Array.isArray(linkFilter) && linkFilter.length) {
    const keep = new Set(linkFilter.map(String));
    const idxs = keys.map((k, i) => (keep.has(String(k)) ? i : -1)).filter((i) => i >= 0);
    if (idxs.length) {
      const pick = (arr) => idxs.map((i) => arr[i]);
      keys = pick(keys);
      capacities = pick(capacities);
      lengths = pick(lengths);
      freespeeds = pick(freespeeds);
      daily_avgs = pick(daily_avgs);
      permlanes = pick(permlanes);
    }
  }

  // Build array of objects for easier processing (similar to old per_id entries)
  const perIdEntries = keys.map((id, index) => [
    id,
    {
      capacity: capacities[index],
      length: lengths[index],
      freespeed: freespeeds[index],
      daily_avg_volume: daily_avgs[index],
      permlanes: permlanes[index]
    }
  ]);
  
  const hasFiltered = filteredVolume && typeof filteredVolume === "object";
  const filteredTotal = hasFiltered
  ? perIdEntries.reduce((acc, [id]) => acc + (Number(filteredVolume?.[String(id)]) || 0), 0)
  : null;

  const totalVolume = perIdEntries.reduce(
    (acc, [, obj]) => acc + (Number(obj.daily_avg_volume) || 0), 0
  );
  
  // Deduped row renderer
  const renderDedupRow = (label, field, { unit = "", useFilteredVolume = false } = {}) => {
    const vals = perIdEntries
    .map(([id, obj]) => {
      const raw = useFilteredVolume ? filteredVolume?.[String(id)] : obj?.[field];
      const num = Number(raw);
      return Number.isFinite(num) ? { id, num } : null;
    })
    .filter(Boolean);
    
    const fmt = (x) => (unit ? `${fmtNum(x)} ${unit}` : fmtNum(x));
    
    if (vals.length === 0) {
      return (
        <tr>
        <td><strong>{label}</strong></td>
        <td>-</td>
        </tr>
      );
    }
    
    const onlyNums = vals.map(v => v.num);
    const equal = allEqual(onlyNums);
    
    return (
      <tr>
      <td><strong>{label}</strong></td>
      <td>
      {equal ? (
        <div>{fmt(onlyNums[0])}</div>
      ) : (
        vals.map(({ id, num }) => (
          <div key={id} style={{ marginBottom: "0.25rem" }}>
          {fmt(num)} <span style={{ color: "#888" }}>(ID: {id})</span>
          </div>
        ))
      )}
      </td>
      </tr>
    );
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
    <h4>Segment Info</h4>
    {!isCollapsed && (
    <table>
    <tbody>
    {/* Link id(s) on the segment (respects the dropdown / split filter) */}
    <tr>
    <td><strong>{keys.length > 1 ? "Link IDs" : "Link ID"}</strong></td>
    <td style={{ wordBreak: "break-all" }}>{keys.length ? keys.join(", ") : "-"}</td>
    </tr>

    {/* Road volume — Filtered = time-windowed, Total = full-day */}
    {selectedGraph === "Volumes" && (
      <tr>
      <td><strong>Volumes</strong></td>
      <td>
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", justifyContent: "flex-end" }}>
      <div className="metric-card">
      <div className="metric-label">Filtered</div>
      <div className="metric-value">
        {hasFiltered ? fmtNum(filteredTotal) : fmtNum(top.daily_avg_volume)}
      </div>
      </div>
      <div className="metric-card">
      <div className="metric-label">Total</div>
      <div className="metric-value">
        {fmtNum(totalVolume)}
      </div>
      </div>
      </div>
      </td>
      </tr>
    )}

    {/* Per-direction fields first (deduped) */}
    {renderDedupRow("Length", "length", { unit: "m" })}
    {renderDedupRow("Free Speed", "freespeed", { unit: "km/h" })}
    {renderDedupRow("Capacity (per direction)", "capacity")}
    {renderDedupRow("Lanes (per direction)", "permlanes")}
    
    {/* Link-level capacity */}
    <tr>
    <td><strong>Capacity (link)</strong></td>
    <td>{fmtNum(top.capacity)}</td>
    </tr>
    
    {selectedGraph === "Volumes" && perIdEntries.length > 1 &&
      renderDedupRow("Volume (per direction)", "daily_avg_volume", {
        useFilteredVolume: hasFiltered,
      })
    }
      
      <tr>
      <td><strong>Modes</strong></td>
      <td>
      <div className="mode-badges">
      {(top.modes || "")
        .split(",")
        .filter(Boolean)
        .map((mode) => (
          <span className="mode-badge" key={mode}>{mode}</span>
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
    
    export default SegmentAttributesTable;
    