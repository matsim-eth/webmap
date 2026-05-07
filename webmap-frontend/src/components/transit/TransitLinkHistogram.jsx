import React from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useQuery } from "@tanstack/react-query";

const TransitLinkHistogram = ({
  linkId,                      // pass ONE id per chart (string/number)
  highlightedLineId,
  timeRange = [0, 96],
  canton,
  visualizeLinkId,
  setVisualizeLinkId
}) => {
  const loadWithFallback = useLoadWithFallback();

  const startTick = timeRange?.[0] ?? 0;
  const endTick   = timeRange?.[1] ?? 96;

  const cleanLinkId = (id) =>
    String(id).split("_").map(p => p.split(":")[0]).join("_");

  const { data: volumeData } = useQuery({
    queryKey: ['transit-link-volume', canton, String(linkId)],
    queryFn: () => {
      const key = String(linkId);
      return loadWithFallback(
        `matsim/transit/volumes_by_link_line/pt_link_volumes_by_link_line_${canton}.json`
      ).then((raw) => {
        if (Array.isArray(raw)) {
          const entry =
            raw.find(e => String(e.link_id) === key) ||
            raw.find(e => String(e.link_id) === cleanLinkId(key));

          if (!entry) return null;

          const linesObj = {};
          for (const l of entry.lines || []) {
            linesObj[String(l.line_id)] = {
              timeBins: l.hourly_avg_volumes || {},
              line_name: l.line_name ?? null,
              mode: l.mode ?? null,
            };
          }
          return { ...entry, lines: linesObj };
        }

        if (raw && typeof raw === "object") {
          return raw[key] || raw[cleanLinkId(key)] || null;
        }
        return null;
      });
    },
    enabled: !!linkId && !!canton,
  });

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
      <div className="plot-card">
        <div className="plot-card-header">
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
            margin: { t: 30, r: 10, l: 40, b: 40 },
            xaxis: {
              title: { text: "Time", standoff: 8 },
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
    </div>
  );
};

export default TransitLinkHistogram;
