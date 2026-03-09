import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const TransitLinkHistogram = ({
  linkId,                      // pass ONE id per chart (string/number)
  highlightedLineId,
  timeRange = [0, 96],
  canton,
  visualizeLinkId,
  setVisualizeLinkId
}) => {
  const [volumeData, setVolumeData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  const startTick = timeRange?.[0] ?? 0;
  const endTick   = timeRange?.[1] ?? 96;

  useEffect(() => {
    if (!linkId || !canton) return;

    const key = String(linkId);
    const cleanLinkId = (id) =>
      String(id).split("_").map(p => p.split(":")[0]).join("_");

    loadWithFallback(
      `matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${canton}.json`
    )
      .then((raw) => {
        // NEW: array format -> find by link_id, then normalize to lines{lineId:{timeBins,...}}
        if (Array.isArray(raw)) {
          const entry =
            raw.find(e => String(e.link_id) === key) ||
            raw.find(e => String(e.link_id) === cleanLinkId(key));

          if (!entry) {
            setVolumeData(null);
            return;
          }

          const linesObj = {};
          for (const l of entry.lines || []) {
            linesObj[String(l.line_id)] = {
              timeBins: l.hourly_avg_volumes || {},
              line_name: l.line_name ?? null,
              mode: l.mode ?? null,
            };
          }
          setVolumeData({ ...entry, lines: linesObj });
          return;
        }

        // Legacy object shape (kept for compatibility)
        if (raw && typeof raw === "object") {
          const objEntry = raw[key] || raw[cleanLinkId(key)] || null;
          setVolumeData(objEntry || null);
        }
      })
      .catch((err) => console.error("Error loading volume data:", err));
  }, [linkId, canton]);

  if (!volumeData) return null;

  const all15MinLabels = Array.from({ length: 96 }, (_, h) => {
    const hour   = String(Math.floor(h / 4)).padStart(2, "0");
    const minute = String((h % 4) * 15).padStart(2, "0");
    return `${hour}:${minute}`;
  });

  const labels  = all15MinLabels.slice(startTick, endTick);
  const tickvals = labels.filter((_, i) => i % 4 === 0);

  const values = Array(96).fill(0);
  const lines  = volumeData.lines || {};
  const lineIds = highlightedLineId ? [highlightedLineId] : Object.keys(lines);

  for (const id of lineIds) {
    const bins = lines[id]?.timeBins || {};
    for (let h = 0; h < 96; h++) {
      const hour   = String(Math.floor(h / 4)).padStart(2, "0");
      const minute = String((h % 4) * 15).padStart(2, "0");
      const k = `${hour}:${minute}`;
      values[h] += Number(bins[k]) || 0;
    }
  }

  return (
    <div className="plot-container">
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <h4 style={{ margin: 0 }}>Transit Volume for Link {String(linkId)}</h4>
        {setVisualizeLinkId && (
          <button
            className="graph-button small"
            onClick={() => {
              if (linkId !== visualizeLinkId) setVisualizeLinkId(String(linkId));
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
            marker: { color: "#17becf" },
          },
        ]}
        layout={{
          font: { family: "Inter, sans-serif" },
          margin: { t: 30, r: 10, l: 40, b: 100 },
          xaxis: {
            title: { text: "Time", standoff: 20 },
            tickangle: -45,
            tickvals,
            automargin: true,
          },
          yaxis: { title: "Passengers per 15 min" },
          height: 300,
          width: 525,
          paper_bgcolor: "rgba(255,255,255,0)",
          plot_bgcolor: "rgba(255,255,255,0)",
        }}
      />
    </div>
  );
};

export default TransitLinkHistogram;
