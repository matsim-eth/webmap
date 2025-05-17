import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";

const PtStopPassengerHistogram = ({ stopIds, canton, dataURL, lineId }) => {
  const [hourlyCounts, setHourlyCounts] = useState(null);
  
  useEffect(() => {
    
    
    console.log("Fetching passenger counts for stops:", stopIds, "in canton:", canton);
    if (!stopIds || stopIds.length === 0 || !canton) return;
    
    fetch(`${dataURL}/matsim/transit/${canton}_pt_passenger_counts.json`)
    .then(res => res.json())
    .then(data => {
      const cleanedIds = Array.isArray(stopIds) ? stopIds.filter(Boolean).map(String) : [];
      
      // Filter only matching stop_ids
      let stopData = data.filter(d => cleanedIds.includes(String(d.stop_id)));
      if (lineId) {
        stopData = stopData.filter(d => d.line_id === lineId);
      }
      
      // Flatten the nested `data` arrays
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
      
      // Group by time_bin
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
  
  if (!hourlyCounts) return <p>Loading passenger data...</p>;
  
  const labels = hourlyCounts.map(([time]) => time);
  const boardings = hourlyCounts.map(([, v]) => v.boardings);
  const alightings = hourlyCounts.map(([, v]) => v.alightings);
  
  return (
    <div className="plot-container">
    <h4 style={{ margin: 0 }}>Hourly Passenger Volumes{lineId ? " (filtered)" : ""}</h4>
    <Plot
    data={[
      { x: labels, y: boardings, name: "Boardings", type: "bar", marker: { color: "#1f77b4" } },
      { x: labels, y: alightings, name: "Alightings", type: "bar", marker: { color: "#ff7f0e" } },
    ]}
    layout={{
      barmode: "group",
      margin: { t: 30, r: 10, l: 40, b: 100 },
      xaxis: {
        title: "Hour",
        tickangle: -45,
        automargin: true,
      },
      yaxis: { title: "Passenger Count" },
      height: 300,
      width: 525,
      paper_bgcolor: "rgba(255,255,255,0)",
      plot_bgcolor: "rgba(255,255,255,0)",
    }}
    />
    </div>
  );
};

export default PtStopPassengerHistogram;
