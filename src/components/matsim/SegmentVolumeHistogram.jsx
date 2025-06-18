import React, { useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const SegmentVolumeHistogram = ({
  linkId,
  setVisualizeLinkId,
  canton,
  timeRange = [0, 96],        // [startTick, endTick]
}) => {
  const [volumeData, setVolumeData] = useState(null);
  const loadWithFallback = useLoadWithFallback();

  // always treat as array
  const linkIds = Array.isArray(linkId) ? linkId : [linkId];

  /* ---------- LOAD VOLUME JSON (once per canton / link set) ---------- */
  useEffect(() => {
    if (!linkIds.length || !canton) return;

    loadWithFallback(`matsim/${canton}_link_traffic_volumes.json`)
      .then((raw) => {
        // keep only requested links, map = { id: {HRS0-1avg: …, … } }
        const mapped = Object.fromEntries(
          raw
            .filter((e) => linkIds.includes(e.link_id.toString()))
            .map((e) => [e.link_id.toString(), e.hourly_avg_volumes])
        );
        setVolumeData(mapped);
      })
      .catch((err) =>
        console.error("Error loading link traffic volumes:", err)
      );
  }, [linkId, canton]);               // re-load if either changes

  if (!volumeData) return <p>Loading volume data…</p>;

  /* ---------- SLIDER → HOUR RANGE ---------- */
  const startHour = Math.floor((timeRange?.[0] ?? 0) / 4);   // inclusive
  const endHour   = Math.ceil((timeRange?.[1] ?? 96) / 4);   // exclusive

  // helper to build 24 labels "00:00" … "23:00"
  const fullHourLabels = Array.from({ length: 24 }, (_, h) =>
    `${String(h).padStart(2, "0")}:00`
  );

  return (
    <div className="plot-container">
      {linkIds.map((id) => {
        const hourly = volumeData[id.toString()];
        if (!hourly) return null;

        // pad missing hours with 0 so we can slice safely
        const padded = Array.from({ length: 24 }, (_, h) => {
          const key = `HRS${h}-${h + 1}avg`;
          return hourly[key] ?? 0;
        });

        // slice by slider (converted to hours)
        const labels   = fullHourLabels.slice(startHour, endHour);
        const values   = padded.slice(startHour,   endHour);
        const tickvals = labels.filter((_, i) => i % 2 === 0); // every 2 hrs

        return (
          <div key={id}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <h4 style={{ margin: 0 }}>Hourly Volume for Link {id}</h4>
              <button
                className="graph-button small"
                onClick={() => setVisualizeLinkId(id)}
              >
                Visualize
              </button>
            </div>

            <Plot
              data={[
                {
                  x: labels,
                  y: values,
                  type: "bar",
                  marker: { color: "#17becf" },
                },
              ]}
              layout={{
                margin: { t: 30, r: 10, l: 40, b: 100 },
                xaxis: {
                  title: { text: "Hour", standoff: 20 },
                  tickangle: -45,
                  tickvals,
                  automargin: true,
                },
                yaxis: { title: "Avg Vehicles/hour" },
                height: 300,
                width: 525,
                paper_bgcolor: "rgba(255,255,255,0)",
                plot_bgcolor: "rgba(255,255,255,0)",
              }}
            />
          </div>
        );
      })}
    </div>
  );
};

export default SegmentVolumeHistogram;
