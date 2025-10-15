import React from "react";
import "../Table.css";

const fmtNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)}` : "-";
};
const allEqual = (arr) => (arr.length === 0 ? true : arr.every((x) => x === arr[0]));

const SegmentAttributesTable = ({ propertiesList, selectedGraph, filteredVolume }) => {
  if (!propertiesList || propertiesList.length === 0) return null;
  
  const top = propertiesList[0] || {};
  
  // Parse pipe-separated strings into arrays
  const keys = (top.per_id_keys || "").split("|").filter(Boolean);
  const capacities = (top.per_id_capacities || "").split("|").filter(Boolean);
  const lengths = (top.per_id_lengths || "").split("|").filter(Boolean);
  const freespeeds = (top.per_id_freespeeds || "").split("|").filter(Boolean);
  const daily_avgs = (top.per_id_daily_avgs || "").split("|").filter(Boolean);
  const permlanes = (top.per_id_permlanes || "").split("|").filter(Boolean);
  
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
    <div className="canton-mode-share">
    <h4>Segment Info</h4>
    <table>
    <tbody>
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
    
    {selectedGraph === "Volumes" && (
      <>
      {perIdEntries.length > 1 &&
        renderDedupRow("Volume (per direction)", "daily_avg_volume", {
          useFilteredVolume: hasFiltered,
        })
      }
      
      <tr>
      <td><strong>Avg Daily Volume (total)</strong></td>
      <td>
      {hasFiltered
        ? `${fmtNum(filteredTotal)} vehicles`
        : `${fmtNum(top.daily_avg_volume)} vehicles/day`}
        </td>
        </tr>
        </>
      )}
      
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
        </div>
      );
    };
    
    export default SegmentAttributesTable;
    