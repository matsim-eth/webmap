import React, { useEffect, useState, useRef } from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const TransitLinkHistogram = ({
  linkId,
  highlightedLineId,
  canton,
  timeRange = [0, 96],
  onVolumeUpdate
}) => {
  const [volumeData, setVolumeData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  const startTick = timeRange?.[0] ?? 0;
  const endTick = timeRange?.[1] ?? 96;
  const prevTotalsRef = useRef(null);

  useEffect(() => {
    if (!linkId || !canton) return;

    loadWithFallback(
      `matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${canton}.json`
    )
      .then((raw) => {
        setVolumeData(raw[linkId.toString()]);
      })
      .catch((err) => {
        console.error("Error loading transit link volumes:", err);
      });
  }, [linkId, canton]);

  useEffect(() => {
    if (!onVolumeUpdate || !volumeData) return;

    let total = 0;
    const lines = volumeData?.lines || {};
    const lineIds = highlightedLineId ? [highlightedLineId] : Object.keys(lines);

    for (const lineId of lineIds) {
      const timeBins = lines[lineId]?.timeBins || {};
      for (let h = startTick; h < endTick; h++) {
        const hour = Math.floor(h / 4).toString().padStart(2, "0");
        const minute = ((h % 4) * 15).toString().padStart(2, "0");
        const key = `${hour}:${minute}`;
        total += timeBins[key] ?? 0;
      }
    }

    const changed = total !== prevTotalsRef.current;
    if (changed) {
      prevTotalsRef.current = total;
      onVolumeUpdate({ [linkId]: total });
    }
  }, [volumeData, highlightedLineId, startTick, endTick, onVolumeUpdate, linkId]);

  if (!volumeData) return <p>Loading transit volume data…</p>;

  // 96 tick labels (15-min intervals)
  const all15MinLabels = Array.from({ length: 96 }, (_, h) => {
    const hour = Math.floor(h / 4).toString().padStart(2, "0");
    const minute = ((h % 4) * 15).toString().padStart(2, "0");
    return `${hour}:${minute}`;
  });

  const labels = all15MinLabels.slice(startTick, endTick);
  const tickvals = labels.filter((_, i) => i % 4 === 0); // every hour

  // Collect 15-min values
  const allValues = Array(96).fill(0);
  const lines = volumeData.lines || {};
  const lineIds = highlightedLineId ? [highlightedLineId] : Object.keys(lines);

  for (const lineId of lineIds) {
    const timeBins = lines[lineId]?.timeBins || {};
    for (let h = 0; h < 96; h++) {
      const hour = Math.floor(h / 4).toString().padStart(2, "0");
      const minute = ((h % 4) * 15).toString().padStart(2, "0");
      const key = `${hour}:${minute}`;
      allValues[h] += timeBins[key] ?? 0;
    }
  }

  const slicedValues = allValues.slice(startTick, endTick);

  return (
    <div className="plot-container">
      <h4>15-Minute Volume for Transit Link {linkId}</h4>
      <Plot
        data={[
          {
            x: labels,
            y: slicedValues,
            type: "bar",
            marker: { color: "#17becf" }
          }
        ]}
        layout={{
          margin: { t: 30, r: 10, l: 40, b: 100 },
          xaxis: {
            title: { text: "Time", standoff: 20 },
            tickangle: -45,
            tickvals,
            automargin: true
          },
          yaxis: { title: "Passengers per 15 min" },
          height: 300,
          width: 525,
          paper_bgcolor: "rgba(255,255,255,0)",
          plot_bgcolor: "rgba(255,255,255,0)"
        }}
      />
    </div>
  );
};

export default TransitLinkHistogram;
