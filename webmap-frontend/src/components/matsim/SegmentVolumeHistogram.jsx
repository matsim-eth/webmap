import React, { useMemo, useRef } from "react";
import Plot from "react-plotly.js";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useQuery } from "@tanstack/react-query";

const SegmentVolumeHistogram = ({
  linkId,
  triggerVisualize,
  canton,
  timeRange = [0, 96],        // [startTick, endTick]
  onVolumeUpdate,
  aggregate = false            // when true, sum all links into one chart
}) => {
  const loadWithFallback = useLoadWithFallback();

  // always treat as array
  const linkIdKey = Array.isArray(linkId) ? linkId.sort().join(",") : linkId?.toString();
  const linkIds = linkIdKey.split(",");

  /* ---------- LOAD VOLUME JSON (once per canton / link set) ---------- */
  const { data: volumeData } = useQuery({
    queryKey: ['link-traffic-volumes', canton, linkIdKey],
    queryFn: () => loadWithFallback(`matsim/${canton}_link_traffic_volumes.json`)
      .then((raw) => {
        const mapped = Object.fromEntries(
          raw
          .filter((e) => linkIdKey.includes(e.link_id.toString()))
          .map((e) => [e.link_id.toString(), e.hourly_avg_volumes])
        );
        return mapped;
      }),
    enabled: !!linkIdKey.length && !!canton,
  });

/* ---------- SLIDER → HOUR RANGE ---------- */
const startHour = Math.floor((timeRange?.[0] ?? 0) / 4);   // inclusive
const endHour   = Math.ceil((timeRange?.[1] ?? 96) / 4);   // exclusive

// helper to build 24 labels "0:00–1:00" … "23:00–24:00"
const fullHourLabels = Array.from({ length: 24 }, (_, h) =>
  `${h}:00–${h + 1}:00`
);

const prevTotalsRef = useRef(null);

// Derived: compute totals from volumeData + time range and notify parent
const volumeTotals = useMemo(() => {
  if (!volumeData) return null;

  const totals = {};

  for (const id of linkIds) {
    const hourly = volumeData[id.toString()];
    if (!hourly) continue;

    if (!Array.isArray(hourly) || hourly.length !== 24) {
      console.warn(`Invalid hourly data for link ${id}: expected array of 24 values`);
      continue;
    }

    let total = 0;
    for (let h = startHour; h < endHour; h++) {
      total += hourly[h] ?? 0;
    }

    totals[id] = total;
  }

  return totals;
}, [volumeData, startHour, endHour, linkIds]);

// Notify parent when totals change (compare to avoid infinite loops)
if (onVolumeUpdate && volumeTotals) {
  const changed = JSON.stringify(volumeTotals) !== JSON.stringify(prevTotalsRef.current);
  if (changed) {
    prevTotalsRef.current = volumeTotals;
    onVolumeUpdate(volumeTotals);
  }
}

if (!volumeData) return <p className="plot-empty">Loading volume data…</p>;

// Aggregate mode: sum all links into a single chart
if (aggregate) {
  const combined = new Array(24).fill(0);
  let hasData = false;
  for (const id of linkIds) {
    const hourly = volumeData[id.toString()];
    if (!hourly || !Array.isArray(hourly) || hourly.length !== 24) continue;
    hasData = true;
    for (let h = 0; h < 24; h++) combined[h] += hourly[h] ?? 0;
  }
  if (!hasData) return null;

  const labels = fullHourLabels.slice(startHour, endHour);
  const values = combined.slice(startHour, endHour);
  const tickvals = labels.filter((_, i) => i % 2 === 0);

  return (
    <div className="plot-container">
      <div className="plot-card">
        <div className="plot-card-header">
          <h4 style={{ margin: 0 }}>Aggregate Volume ({linkIds.length} links)</h4>
        </div>
        <Plot
          data={[{ x: labels, y: values, type: "bar", marker: { color: "#17becf" } }]}
          layout={{
            font: { family: "Inter, sans-serif" },
            margin: { t: 30, r: 10, l: 40, b: 40 },
            xaxis: { title: { text: "Hour", standoff: 8 }, tickangle: -45, tickvals, automargin: true },
            yaxis: { title: "Avg Vehicles/hour" },
            height: 300, width: 525,
            paper_bgcolor: "rgba(255,255,255,0)", plot_bgcolor: "rgba(255,255,255,0)",
          }}
        />
      </div>
    </div>
  );
}

return (
  <div className="plot-container">
  {linkIds.map((id) => {
    const hourly = volumeData[id.toString()];
    if (!hourly) return null;

    // Validate array format
    if (!Array.isArray(hourly) || hourly.length !== 24) {
      console.warn(`Invalid hourly data for link ${id}: expected array of 24 values`);
      return null;
    }

    // hourly is now already an array of 24 numeric values [hour0, hour1, ..., hour23]
    // slice by slider (converted to hours)
    const labels   = fullHourLabels.slice(startHour, endHour);
    const values   = hourly.slice(startHour, endHour);
    const tickvals = labels.filter((_, i) => i % 2 === 0); // every 2 hrs

    return (
      <div key={id} className="plot-card">
        <div className="plot-card-header">
          <h4 style={{ margin: 0 }}>Hourly Volume for Link {id}</h4>
          <button
            className="graph-button small"
            onClick={() => triggerVisualize?.(id)}
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
            font: { family: "Inter, sans-serif" },
            margin: { t: 30, r: 10, l: 40, b: 40 },
            xaxis: {
              title: { text: "Hour", standoff: 8 },
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
