import React, { useMemo, useRef } from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useQuery } from "@tanstack/react-query";

const TransitStopHistogram = ({ stopIds, canton, lineId, onVolumeUpdate, timeRange }) => {
  const loadWithFallback = useLoadWithFallback();

  // Stable key for stopIds
  const stopIdsKey = Array.isArray(stopIds) ? stopIds.join(',') : '';

  // Fetch and process passenger data
  const { data: hourlyCounts } = useQuery({
    queryKey: ['transit-stop-histogram', canton, stopIdsKey, lineId],
    queryFn: () => {
      return loadWithFallback(`matsim/transit/per_canton_counts/${canton}_counts.json`)
        .then(data => {
          const cleanedIds = stopIds.flatMap(s => {
            if (Array.isArray(s)) return s;
            try {
              return JSON.parse(s);
            } catch {
              return String(s).split(",").map(id => id.trim());
            }
          });

          let stopData = data.filter(d => cleanedIds.includes(String(d.stop_id)));
          if (lineId) stopData = stopData.filter(d => d.line_id === lineId);

          const allTimeBins = [];
          for (const row of stopData) {
            for (const t of row.data) {
              allTimeBins.push({
                time_bin: t.time_bin,
                boardings: t.boardings,
                alightings: t.alightings,
              });
            }
          }

          const grouped = {};
          for (const row of allTimeBins) {
            if (!grouped[row.time_bin]) {
              grouped[row.time_bin] = { boardings: 0, alightings: 0 };
            }
            grouped[row.time_bin].boardings += row.boardings;
            grouped[row.time_bin].alightings += row.alightings;
          }

          return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
        });
    },
    enabled: !!stopIds && stopIds.length > 0 && !!canton,
  });

  // Generate full label and padded values
  const fullLabels = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      const hour = String(h).padStart(2, '0');
      const min = String(m).padStart(2, '0');
      fullLabels.push(`${hour}:${min}`);
    }
  }

  const labels = hourlyCounts?.map(([time]) => time) || [];
  const boardings = hourlyCounts?.map(([, v]) => v.boardings) || [];
  const alightings = hourlyCounts?.map(([, v]) => v.alightings) || [];

  const boardingMap = Object.fromEntries(labels.map((t, i) => [t, boardings[i]]));
  const alightingMap = Object.fromEntries(labels.map((t, i) => [t, alightings[i]]));

  const paddedBoardings = fullLabels.map(t => boardingMap[t] ?? 0);
  const paddedAlightings = fullLabels.map(t => alightingMap[t] ?? 0);

  // Step: Convert timeRange index (e.g. 0–96) to slice of fullLabels
  // Note: endTick is exclusive to match useTransitStops filtering logic
const filteredLabels = fullLabels.slice(timeRange?.[0] ?? 0, timeRange?.[1] ?? 96);
const filteredBoardings = paddedBoardings.slice(timeRange?.[0] ?? 0, timeRange?.[1] ?? 96);
const filteredAlightings = paddedAlightings.slice(timeRange?.[0] ?? 0, timeRange?.[1] ?? 96);


  const maxY = Math.max(...filteredBoardings, ...filteredAlightings);

  // Derived: compute volume totals and notify parent
  const prevVolumesRef = useRef(null);
  const volumeSummary = useMemo(() => {
    if (!hourlyCounts) return null;
    const totalBoardings = filteredBoardings.reduce((sum, val) => sum + val, 0);
    const totalAlightings = filteredAlightings.reduce((sum, val) => sum + val, 0);
    return { boardings: totalBoardings, alightings: totalAlightings, total: totalBoardings + totalAlightings };
  }, [hourlyCounts, filteredBoardings, filteredAlightings]);

  if (onVolumeUpdate && volumeSummary) {
    const key = JSON.stringify(volumeSummary);
    if (key !== prevVolumesRef.current) {
      prevVolumesRef.current = key;
      onVolumeUpdate(volumeSummary);
    }
  }

  if (!hourlyCounts) return <p>Loading passenger data...</p>;

  return (
    <div className="plot-container">
     <h4 style={{ marginTop: "1rem" }}>Hourly Boardings{lineId ? " (filtered)" : ""}</h4>
<Plot
  data={[
    { x: filteredLabels, y: filteredBoardings, name: "Boardings", type: "bar", marker: { color: "#1f77b4" } },
  ]}
  layout={{
    font: { family: "Inter, sans-serif" },
    margin: { t: 30, r: 10, l: 40, b: 10 },
    xaxis: { title: "Hour", tickangle: -45, automargin: true },
    yaxis: { title: "Passenger Count", range: [0, maxY] },
    height: 250,
    width: 525,
    paper_bgcolor: "rgba(255,255,255,0)",
    plot_bgcolor: "rgba(255,255,255,0)",
  }}
/>

<h4 style={{ marginBottom: 0 }}>Hourly Alightings{lineId ? " (filtered)" : ""}</h4>
<Plot
  data={[
    { x: filteredLabels, y: filteredAlightings, name: "Alightings", type: "bar", marker: { color: "#ff7f0e" } },
  ]}
  layout={{
    font: { family: "Inter, sans-serif" },
    margin: { t: 30, r: 10, l: 40, b: 10 },
    xaxis: { title: "Hour", tickangle: -45, automargin: true },
    yaxis: { title: "Passenger Count", range: [0, maxY] },
    height: 250,
    width: 525,
    paper_bgcolor: "rgba(255,255,255,0)",
    plot_bgcolor: "rgba(255,255,255,0)",
  }}
/>
    </div>
  );
};

export default TransitStopHistogram;
