// Shared Plotly layout/config defaults so plots in the right sidebar share
// a consistent look (typography, gridlines, padding).

const COLOR_TEXT = "#374151";
const COLOR_TEXT_MUTED = "#6b7280";
const COLOR_GRID = "#e5e7eb";
const COLOR_AXIS = "#d1d5db";

export const plotFont = {
  family: "Inter, sans-serif",
  size: 12,
  color: COLOR_TEXT,
};

export const baseAxis = {
  gridcolor: COLOR_GRID,
  zerolinecolor: COLOR_GRID,
  linecolor: COLOR_AXIS,
  tickcolor: COLOR_AXIS,
  tickfont: { size: 11, color: COLOR_TEXT_MUTED },
  titlefont: { size: 12, color: COLOR_TEXT },
  automargin: true,
};

export const basePlotLayout = (overrides = {}) => ({
  font: plotFont,
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  margin: { t: 24, r: 12, l: 48, b: 56 },
  hoverlabel: {
    bgcolor: "#1f2937",
    bordercolor: "#1f2937",
    font: { color: "#f3f4f6", family: "Inter, sans-serif", size: 12 },
  },
  ...overrides,
  xaxis: { ...baseAxis, ...(overrides.xaxis || {}) },
  yaxis: { ...baseAxis, ...(overrides.yaxis || {}) },
});

export const basePlotConfig = {
  displaylogo: false,
  responsive: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
};
