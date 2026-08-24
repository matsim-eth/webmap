import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import { useDashboard } from "../../context/DashboardContext";
import { useData } from "../../context/DataContext";
import { useResizeOnSidebarChange } from "../../hooks/useResizeOnSidebarChange";
import {
  useTransitDatasets,
  useTransferDataPerDataset,
  useStopAlignment,
  candidateStopIdsForDataset,
  matchTransferParts,
} from "../../hooks/useTransitComparison";
import { toLineList } from "../../utils/transitLineFilter";
import PlotLoader from "./PlotLoader";

// Merge every matched platform record of the selected station into one
// from-line → to-line matrix plus in/out totals.
const mergeTransfers = (parts) => {
  const lineTransfers = {};
  let totalIn = 0;
  let totalOut = 0;
  for (const part of parts) {
    if (!part?.line_transfers) continue;
    totalIn += part.total_transfers_in || 0;
    totalOut += part.total_transfers_out || 0;
    for (const [fromLine, row] of Object.entries(part.line_transfers)) {
      const target = lineTransfers[fromLine] || (lineTransfers[fromLine] = {});
      for (const [toLine, n] of Object.entries(row)) {
        target[toLine] = (target[toLine] || 0) + n;
      }
    }
  }
  return { lineTransfers, totalIn, totalOut };
};

const TransferMatrix = ({ sidebarCollapsed, isExpanded = false }) => {
  const { selectedCanton, selectedTransitStop, selectedTransitLine, zoneLabel } = useDashboard();
  const { getData } = useData();

  const datasets = useTransitDatasets();
  const isComparison = datasets.length > 1;
  const transferPerDataset = useTransferDataPerDataset();
  const { resolveStopIds } = useStopAlignment(selectedCanton);
  const boardingData = getData("boarding_data_by_line.json");

  useResizeOnSidebarChange(sidebarCollapsed);

  const anyTransfer = transferPerDataset.some((d) => d.data);

  // Switzerland-wide line_id → display-name lookup. boarding_data_by_line
  // arrives in several shapes ({data:[...]} from the backend, CDN dict,
  // plain array) — toLineList normalizes them all. String keys because
  // matrix line ids come from Object.keys (always strings) while the
  // asset's line_id may be numeric. This is the fallback that resolves
  // lines missing from the selected stop's own lines[] (e.g. platforms
  // merged in from the inter_cantonal bucket).
  const lineNameById = useMemo(() => {
    const m = new Map();
    for (const entry of toLineList(boardingData)) {
      const id = entry?.line_id;
      if (id == null || !entry.line_name) continue;
      const key = String(id);
      if (!m.has(key)) {
        m.set(key, entry.vehicle ? `${entry.line_name} (${entry.vehicle})` : entry.line_name);
      }
    }
    return m;
  }, [boardingData]);

  const matrixResult = useMemo(() => {
    if (!selectedTransitStop || !anyTransfer || !selectedCanton) return null;

    // Merge each dataset's matched-platform records into a matrix + totals.
    const perDataset = transferPerDataset.map(({ dataset, data }) => {
      const candidateIds = candidateStopIdsForDataset(dataset, selectedTransitStop, resolveStopIds);
      const parts = matchTransferParts(data, selectedCanton, candidateIds);
      return { dataset, matched: parts.length, ...mergeTransfers(parts) };
    });

    // When a line is selected, filter the matrix to only show transfers
    // involving that line (as either origin or destination).
    if (selectedTransitLine) {
      for (const d of perDataset) {
        const filtered = {};
        let filteredIn = 0;
        let filteredOut = 0;
        for (const [fromLine, row] of Object.entries(d.lineTransfers)) {
          for (const [toLine, n] of Object.entries(row)) {
            if (fromLine === selectedTransitLine || toLine === selectedTransitLine) {
              const target = filtered[fromLine] || (filtered[fromLine] = {});
              target[toLine] = (target[toLine] || 0) + n;
              if (toLine === selectedTransitLine) filteredIn += n;
              if (fromLine === selectedTransitLine) filteredOut += n;
            }
          }
        }
        d.lineTransfers = filtered;
        d.totalIn = filteredIn;
        d.totalOut = filteredOut;
      }
    }

    // Same-scenario assumption: line ids align across runs, so the axes are
    // the union of line ids seen in either dataset.
    const allLines = new Set();
    for (const d of perDataset) {
      Object.keys(d.lineTransfers).forEach((fromLine) => {
        allLines.add(fromLine);
        Object.keys(d.lineTransfers[fromLine]).forEach((toLine) => allLines.add(toLine));
      });
    }
    if (allLines.size < 2) return null;

    const lineArray = Array.from(allLines).sort();

    // --- Resolve line ids to display names (primary stop + boarding data) ---
    const stopLinesMap = {};
    if (selectedTransitStop?.lines) {
      try {
        const linesArray = typeof selectedTransitStop.lines === "string"
          ? JSON.parse(selectedTransitStop.lines)
          : selectedTransitStop.lines;
        if (Array.isArray(linesArray)) {
          linesArray.forEach((line) => {
            if (line.line_id && !stopLinesMap[line.line_id]) {
              const name = line.line_name || line.lineName || line.name;
              if (name) stopLinesMap[line.line_id] = { name, mode: line.mode };
            }
          });
        }
      } catch { /* ignore parse errors */ }
    }

    const resolveName = (lineId) => {
      const stopLine = stopLinesMap[lineId];
      if (stopLine) return stopLine.mode ? `${stopLine.name} (${stopLine.mode})` : stopLine.name;
      return lineNameById.get(String(lineId)) || lineId;
    };

    const dedupeNames = (ids) => {
      const nameCount = {};
      ids.forEach((id) => {
        const name = resolveName(id);
        nameCount[name] = (nameCount[name] || 0) + 1;
      });
      const nameUsed = {};
      return ids.map((id) => {
        let name = resolveName(id);
        if (nameCount[name] > 1) {
          nameUsed[name] = (nameUsed[name] || 0) + 1;
          name = `${name} #${nameUsed[name]}`;
        }
        return name;
      });
    };

    const valueAt = (d, fromLine, toLine) =>
      fromLine === toLine ? 0 : d.lineTransfers[fromLine]?.[toLine] || 0;

    const a = perDataset[0];
    const b = perDataset[1];

    // When a line is selected, collapse the NxN matrix (mostly zeros except
    // the selected line's row and column) into a compact 2×M layout: one row
    // for outbound transfers, one for inbound.
    if (selectedTransitLine) {
      const partners = lineArray.filter((id) => id !== selectedTransitLine);
      if (partners.length === 0) return null;
      const partnerNames = dedupeNames(partners);

      const outRow = partners.map((toLine) =>
        isComparison
          ? valueAt(a, selectedTransitLine, toLine) - valueAt(b, selectedTransitLine, toLine)
          : valueAt(a, selectedTransitLine, toLine)
      );
      const inRow = partners.map((fromLine) =>
        isComparison
          ? valueAt(a, fromLine, selectedTransitLine) - valueAt(b, fromLine, selectedTransitLine)
          : valueAt(a, fromLine, selectedTransitLine)
      );
      const matrix = [outRow, inRow];

      const countsPerCell = isComparison
        ? [
            partners.map((toLine) => [valueAt(a, selectedTransitLine, toLine), valueAt(b, selectedTransitLine, toLine)]),
            partners.map((fromLine) => [valueAt(a, fromLine, selectedTransitLine), valueAt(b, fromLine, selectedTransitLine)]),
          ]
        : null;

      return {
        compact: true,
        matrix,
        countsPerCell,
        lineNames: partnerNames,
        yLabels: ["Outbound", "Inbound"],
        perDataset,
      };
    }

    // Full NxN matrix (no line selected)
    const lineNames = dedupeNames(lineArray);

    const matrix = lineArray.map((fromLine) =>
      lineArray.map((toLine) =>
        isComparison
          ? valueAt(a, fromLine, toLine) - valueAt(b, fromLine, toLine)
          : valueAt(a, fromLine, toLine)
      )
    );
    const countsPerCell = isComparison
      ? lineArray.map((fromLine) =>
          lineArray.map((toLine) => [valueAt(a, fromLine, toLine), valueAt(b, fromLine, toLine)])
        )
      : null;

    return {
      compact: false,
      matrix,
      countsPerCell,
      lineNames,
      perDataset,
    };
  }, [selectedTransitStop, anyTransfer, transferPerDataset, selectedCanton, resolveStopIds, lineNameById, isComparison, selectedTransitLine]);

  // --- Render states ---
  if (!selectedCanton || selectedCanton === "All") {
    return <div className="plot-loading">Please select a specific {zoneLabel.toLowerCase()}</div>;
  }

  if (!anyTransfer) {
    return <PlotLoader />;
  }

  const titleBase = isComparison
    ? "Transfer Matrix Difference (Inbound)"
    : "Transfer Matrix (Inbound Trips)";

  if (!selectedTransitStop) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="plot-loading" style={{ textAlign: "center", lineHeight: 1.6 }}>
          Select a transit stop to view<br />the transfer matrix
        </div>
      </div>
    );
  }

  if (!matrixResult) {
    return (
      <div className="plot-wrapper" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <h4 className="plot-title">{titleBase} - {selectedTransitStop.name}</h4>
        <div className="plot-loading" style={{ textAlign: "center", lineHeight: 1.6 }}>
          No transfer data available<br />for this stop
        </div>
      </div>
    );
  }

  const { compact, matrix, countsPerCell, lineNames, perDataset } = matrixResult;
  const yLabels = compact ? matrixResult.yLabels : lineNames;
  const flat = matrix.flat();
  const colorA = perDataset[0]?.dataset.color ?? "#1e40af";
  const colorB = perDataset[1]?.dataset.color ?? "#b91c1c";

  // Custom text: signed for the difference view, plain for single dataset;
  // blank out zeros to keep the grid clean.
  const textMatrix = matrix.map((row) =>
    row.map((val) => {
      if (val === 0) return "";
      return isComparison && val > 0 ? `+${val}` : String(val);
    })
  );

  let trace;
  if (isComparison) {
    const maxAbs = Math.max(1, ...flat.map((v) => Math.abs(v)));
    const fontColorMatrix = matrix.map((row) =>
      row.map((val) => (Math.abs(val) > maxAbs * 0.55 ? "#ffffff" : "#1e293b"))
    );
    trace = {
      z: matrix,
      x: lineNames,
      y: yLabels,
      text: textMatrix,
      texttemplate: "%{text}",
      textfont: { size: 10, color: fontColorMatrix },
      type: "heatmap",
      zmid: 0,
      zmin: -maxAbs,
      zmax: maxAbs,
      colorscale: [
        [0, colorB],
        [0.5, "#f8fafc"],
        [1, colorA],
      ],
      showscale: true,
      colorbar: { thickness: 12, len: 0.6, tickfont: { size: 9, color: "#64748b" }, outlinewidth: 0 },
      hoverongaps: false,
      customdata: countsPerCell,
      hovertemplate: compact
        ? `<b>%{y}</b> — %{x}<br>` +
          `<b>${perDataset[0].dataset.name}:</b> %{customdata[0]}<br>` +
          `<b>${perDataset[1].dataset.name}:</b> %{customdata[1]}<br>` +
          `<b>Difference:</b> %{z}<extra></extra>`
        : `<b>From:</b> %{y}<br><b>To:</b> %{x}` +
          `<br><b>${perDataset[0].dataset.name}:</b> %{customdata[0]}` +
          `<br><b>${perDataset[1].dataset.name}:</b> %{customdata[1]}` +
          `<br><b>Difference:</b> %{z}<extra></extra>`,
      xgap: 2,
      ygap: 2,
    };
  } else {
    const allValues = flat.filter((v) => v > 0);
    const maxVal = allValues.length > 0 ? Math.max(...allValues) : 1;
    const midpoint = maxVal / 2;
    const fontColorMatrix = matrix.map((row) =>
      row.map((val) => (val > midpoint ? "#ffffff" : "#1e293b"))
    );
    trace = {
      z: matrix,
      x: lineNames,
      y: yLabels,
      text: textMatrix,
      texttemplate: "%{text}",
      textfont: { size: 10, color: fontColorMatrix },
      type: "heatmap",
      colorscale: [
        [0, "#f8fafc"],
        [0.2, "#dbeafe"],
        [0.4, "#93c5fd"],
        [0.6, "#3b82f6"],
        [0.8, "#1d4ed8"],
        [1, "#1e3a8a"],
      ],
      showscale: true,
      colorbar: { thickness: 12, len: 0.6, tickfont: { size: 9, color: "#64748b" }, outlinewidth: 0 },
      hoverongaps: false,
      hovertemplate: compact
        ? "<b>%{y}</b> — %{x}<br><b>Transfers:</b> %{z}<extra></extra>"
        : "<b>From:</b> %{y}<br><b>To:</b> %{x}<br><b>Transfers:</b> %{z}<extra></extra>",
      xgap: 2,
      ygap: 2,
    };
  }

  const layout = {
    autosize: true,
    margin: compact
      ? { l: 70, r: 60, t: 5, b: 90 }
      : { l: 110, r: 60, t: 5, b: 90 },
    xaxis: {
      title: { text: compact ? "Line" : "To Line", font: { size: 10, color: "#64748b" } },
      tickangle: -45,
      tickfont: { size: 8, color: "#475569" },
      side: "bottom",
    },
    yaxis: {
      title: compact ? undefined : { text: "From Line", font: { size: 10, color: "#64748b" } },
      tickfont: { size: compact ? 10 : 8, color: "#475569" },
      autorange: "reversed",
    },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
  };

  const config = {
    responsive: true,
    displayModeBar: isExpanded ? "hover" : false,
    displaylogo: false,
    toImageButtonOptions: {
      format: "png",
      filename: `${selectedCanton}_transfer_matrix${isComparison ? "_diff" : ""}`,
      height: 800,
      width: 1200,
      scale: 2,
    },
  };

  // In/out badges. Single mode keeps the classic In/Out pair; comparison
  // shows each dataset's In/Out tagged with its slot color, plus a legend
  // for the diverging scale.
  const matchedNote = perDataset
    .filter((d) => isComparison && d.matched === 0)
    .map((d) => d.dataset.name);

  return (
    <div className="plot-wrapper">
      <h4 className="plot-title">{titleBase} - {selectedTransitStop.name}</h4>

      <div style={{ display: "flex", gap: "8px", marginBottom: "4px", flexWrap: "wrap", alignItems: "center" }}>
        {isComparison ? (
          <>
            {perDataset.map((d) => (
              <span
                key={d.dataset.datasetId}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "10px",
                  fontWeight: 600,
                  color: "#475569",
                  background: "var(--color-bg, #f3f4f6)",
                  borderRadius: "12px",
                  padding: "2px 8px",
                }}
              >
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: d.dataset.color, display: "inline-block" }} />
                {d.dataset.name} — In: {d.totalIn} · Out: {d.totalOut}
              </span>
            ))}
            <span style={{ fontSize: "9px", color: "#64748b" }}>
              cell leans toward{" "}
              <span style={{ color: colorA, fontWeight: 700 }}>{perDataset[0].dataset.name}</span>{" "}or{" "}
              <span style={{ color: colorB, fontWeight: 700 }}>{perDataset[1].dataset.name}</span>
            </span>
          </>
        ) : (
          <>
            <span style={{ fontSize: "10px", fontWeight: 600, color: "#1d4ed8", background: "#dbeafe", borderRadius: "12px", padding: "2px 8px" }}>
              In: {perDataset[0].totalIn}
            </span>
            <span style={{ fontSize: "10px", fontWeight: 600, color: "#c2410c", background: "#ffedd5", borderRadius: "12px", padding: "2px 8px" }}>
              Out: {perDataset[0].totalOut}
            </span>
          </>
        )}
      </div>

      {matchedNote.length > 0 && (
        <div style={{ fontSize: "10px", color: "#b45309", marginBottom: "4px" }}>
          Stop not matched (by id or name) in: {matchedNote.join(", ")}
        </div>
      )}

      <Plot
        data={[trace]}
        layout={layout}
        config={config}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler={true}
      />
    </div>
  );
};

export default TransferMatrix;
