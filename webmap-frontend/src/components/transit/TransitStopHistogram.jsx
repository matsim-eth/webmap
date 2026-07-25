import React, { useMemo, useRef } from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { lineServesDirection, directionLetter } from "../../utils/directionUtils";
import { useData } from "../../context/DataContext";
import { useQuery } from "@tanstack/react-query";

const TransitStopHistogram = ({ stopIds, canton, lineId, onVolumeUpdate, timeRange, selectedDirection, stopLines }) => {
  const loadWithFallback = useLoadWithFallback();
  const { datasetId } = useData();

  // Stable key for stopIds
  const stopIdsKey = Array.isArray(stopIds) ? stopIds.join(',') : '';

  // Fetch and process passenger data. datasetId in the key: refetch when the
  // dataset switches instead of serving the previous dataset's cached counts.
  const { data: hourlyCounts } = useQuery({
    queryKey: ['transit-stop-histogram', datasetId, canton, stopIdsKey, lineId, selectedDirection],
    queryFn: () => {
      return loadWithFallback(`matsim/transit/per_canton_counts/${encodeURIComponent(canton)}_counts.json`)
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

          const dirLetter = selectedDirection && selectedDirection !== 'total'
            ? directionLetter(selectedDirection) : null;

          // v2 rows carry a per-direction breakdown (`data_by_direction`) per
          // (line, stop); when a direction is active we rescale those rows to
          // that direction's own bins (a row serving only the other direction
          // then contributes 0). Rows WITHOUT the field can't be rescaled, so
          // exclude the ones whose line doesn't serve the selected direction —
          // otherwise they'd leak their full both-direction total. Applied per
          // row (not gated on all rows carrying the field) so a partially
          // populated export can't overcount the direction-less rows.
          // lineServesDirection keeps lines with no direction info, so the
          // filter stays inert when the dataset genuinely can't answer.
          if (dirLetter && Array.isArray(stopLines)) {
            const dirLineIds = new Set(
              stopLines
                .filter(l => lineServesDirection(l, selectedDirection))
                .map(l => l.line_id)
            );
            stopData = stopData.filter(
              d => d.data_by_direction || dirLineIds.has(d.line_id)
            );
          }

          const allTimeBins = [];
          for (const row of stopData) {
            // Prefer the active direction's own bins when present; else the
            // direction-less total.
            const bins = (dirLetter && row.data_by_direction)
              ? (row.data_by_direction[dirLetter] || [])
              : (row.data || []);
            for (const t of bins) {
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
      <div className="plot-card">
        <div className="plot-card-header">
          <h4 style={{ margin: 0 }}>Hourly Boardings{lineId ? " (filtered)" : ""}</h4>
        </div>
        <Plot
          data={[
            { x: filteredLabels, y: filteredBoardings, name: "Boardings", type: "bar", marker: { color: "#1f77b4" } },
          ]}
          layout={{
            font: { family: "Inter, sans-serif" },
            margin: { t: 30, r: 10, l: 40, b: 40 },
            xaxis: { title: { text: "Hour", standoff: 8 }, tickangle: -45, automargin: true },
            yaxis: { title: "Passenger Count", range: [0, maxY] },
            height: 250,
            width: 525,
            paper_bgcolor: "rgba(255,255,255,0)",
            plot_bgcolor: "rgba(255,255,255,0)",
          }}
        />
      </div>

      <div className="plot-card">
        <div className="plot-card-header">
          <h4 style={{ margin: 0 }}>Hourly Alightings{lineId ? " (filtered)" : ""}</h4>
        </div>
        <Plot
          data={[
            { x: filteredLabels, y: filteredAlightings, name: "Alightings", type: "bar", marker: { color: "#ff7f0e" } },
          ]}
          layout={{
            font: { family: "Inter, sans-serif" },
            margin: { t: 30, r: 10, l: 40, b: 40 },
            xaxis: { title: { text: "Hour", standoff: 8 }, tickangle: -45, automargin: true },
            yaxis: { title: "Passenger Count", range: [0, maxY] },
            height: 250,
            width: 525,
            paper_bgcolor: "rgba(255,255,255,0)",
            plot_bgcolor: "rgba(255,255,255,0)",
          }}
        />
      </div>
    </div>
  );
};

export default TransitStopHistogram;
