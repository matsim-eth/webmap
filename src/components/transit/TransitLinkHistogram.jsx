import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const TransitLinkHistogram = ({
  linkId,
  highlightedLineId,
  timeRange = [0, 96],
  canton,
  visualizeLinkId,
  setVisualizeLinkId
}) => {
  const [volumeData, setVolumeData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  const startTick = timeRange?.[0] ?? 0;
  const endTick = timeRange?.[1] ?? 96;

  useEffect(() => {
    if (!linkId || !canton) return;

    loadWithFallback(`matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${canton}.json`)
      .then((raw) => {
        if (raw[linkId]) {
          setVolumeData(raw[linkId]);
        }
      })
      .catch((err) => console.error("Error loading volume data:", err));
  }, [linkId, canton]);

  if (!volumeData) return null;

  const all15MinLabels = Array.from({ length: 96 }, (_, h) => {
    const hour = Math.floor(h / 4).toString().padStart(2, "0");
    const minute = ((h % 4) * 15).toString().padStart(2, "0");
    return `${hour}:${minute}`;
  });

  const labels = all15MinLabels.slice(startTick, endTick);
  const tickvals = labels.filter((_, i) => i % 4 === 0);

  const values = Array(96).fill(0);
  const lines = volumeData.lines || {};
  const lineIds = highlightedLineId ? [highlightedLineId] : Object.keys(lines);

  for (const lineId of lineIds) {
    const bins = lines[lineId]?.timeBins || {};
    for (let h = 0; h < 96; h++) {
      const hour = Math.floor(h / 4).toString().padStart(2, "0");
      const minute = ((h % 4) * 15).toString().padStart(2, "0");
      const key = `${hour}:${minute}`;
      values[h] += bins[key] ?? 0;
    }
  }

  return (
    <div className="plot-container">
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <h4 style={{ margin: 0 }}>Transit Volume for Link {linkId}</h4>
        {setVisualizeLinkId && (
          <button
            className="graph-button small"
            onClick={() => {
              if (linkId !== visualizeLinkId) {
                setVisualizeLinkId(linkId);
              }
            }}
          >
            Visualize
          </button>
        )}
      </div>

      <Plot
        data={[
          {
            x: labels,
            y: values.slice(startTick, endTick),
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
