import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";

const TransitStopHistogram = ({ stopIds, canton, dataURL, lineId, onVolumeUpdate }) => {
  const [hourlyCounts, setHourlyCounts] = useState(null);

  // Fetch and process passenger data
  useEffect(() => {
    if (!stopIds || stopIds.length === 0 || !canton) return;

    fetch(`${dataURL}/matsim/transit/${canton}_pt_passenger_counts.json`)
      .then(res => res.json())
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

        const sorted = Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b));
        setHourlyCounts(sorted);
      })
      .catch(err => {
        console.error("Error loading pt passenger counts:", err);
      });
  }, [stopIds, canton, lineId]);

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

  const maxY = Math.max(...paddedBoardings, ...paddedAlightings);

  // Notify parent of volume totals
  useEffect(() => {
    if (!hourlyCounts || !onVolumeUpdate) return;
    const totalBoardings = paddedBoardings.reduce((sum, val) => sum + val, 0);
    const totalAlightings = paddedAlightings.reduce((sum, val) => sum + val, 0);
    onVolumeUpdate({ boardings: totalBoardings, alightings: totalAlightings, total: totalBoardings + totalAlightings });
  }, [hourlyCounts, onVolumeUpdate]);

  if (!hourlyCounts) return <p>Loading passenger data...</p>;

  return (
    <div className="plot-container">
      <h4 style={{ marginTop: "1rem" }}>Hourly Boardings{lineId ? " (filtered)" : ""}</h4>
      <Plot
        data={[
          { x: fullLabels, y: paddedBoardings, name: "Boardings", type: "bar", marker: { color: "#1f77b4" } },
        ]}
        layout={{
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
          { x: fullLabels, y: paddedAlightings, name: "Alightings", type: "bar", marker: { color: "#ff7f0e" } },
        ]}
        layout={{
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
