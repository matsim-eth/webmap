import React from "react";
import "./NetworkLegend.css";
import { useModule } from "../context/ModuleContext";
import { useFilters } from "../context/FilterContext";
import { useData } from "../context/DataContext";

const DESTINATION_MODE_COLORS = {
  car: "#636efa",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
  all: "#1f77b4",
};

const DESTINATION_PURPOSE_COLORS = {
  work: "#FFEE8C",
  education: "#636efa",
  shop: "#ffa15a",
  leisure: "#00cc96",
};

// Map a destination-zone sizing factor to the legend-circle diameter in px.
// Mirrors the map paint expressions in useDestinationZones.js:
//   circle-radius      = 1.5 + factor * 36
//   circle-stroke-width = 1.5  (drawn outside the radius)
// Visible diameter = 2 * (radius + stroke) = 6 + factor * 72.
// Legend dots use border-box width with a 1px CSS border, so this same value
// can be passed straight to `width`/`height`.
const destFactorToDiameter = (factor) => Math.round(6 + factor * 72);

// Factor stops mirror the volume/share interpolations in useDestinationZones.js.
const DESTINATION_SHARE_STOPS = [
  { label: "10%", factor: 0.10 },
  { label: "25%", factor: 0.25 },
  { label: "50%", factor: 0.50 },
];
const DESTINATION_VOLUME_STOPS = [
  { label: "100", factor: 0.06 },
  { label: "500", factor: 0.165 },
  { label: "1K",  factor: 0.285 },
];

const Legend = () => {
  const { isGraphExpanded: selectedGraph } = useModule();
  const { showStopVolumeSymbology, linkSpeedsMetric } = useFilters();
  const { destinationData } = useData();

  const isVolumes = selectedGraph === "Volumes";
  const isNetwork = selectedGraph === "Network";
  const isTransit = selectedGraph === "Transit";
  const isVolumeFlow = selectedGraph === "VolumeFlow";
  const isLinkSpeeds = selectedGraph === "LinkSpeeds";
  const isDestination = selectedGraph === "Destination";

  if (!isVolumes && !isNetwork && !isVolumeFlow && !isLinkSpeeds && !isDestination && !(isTransit && showStopVolumeSymbology)) return null;

  const destModes = destinationData?.selectedModes || [];
  const destPurposes = destinationData?.selectedPurposes || [];
  // Same rule as the map hook: exactly one purpose selected wins, else
  // exactly one mode, else the "all" blue.
  const destColor = (destPurposes.length === 1 && DESTINATION_PURPOSE_COLORS[destPurposes[0]])
    || (destModes.length === 1 && DESTINATION_MODE_COLORS[destModes[0]])
    || DESTINATION_MODE_COLORS.all;
  const destSizingMode = destinationData?.sizingMode || "volume";

  // Link Speeds gradient + scale depends on selected metric
  const speedGradient = "linear-gradient(to right, #d7191c, #fdae61, #ffffbf, #a6d96a, #1a9641)";
  const linkSpeedsTitles = {
    avg_speed: "Average Speed [km/h]",
    freespeed: "Freespeed [km/h]",
    congestion_index: "Congestion Index (avg / freespeed)",
  };
  const linkSpeedsLabels = {
    avg_speed: ["0", "20", "50", "80", "120"],
    freespeed: ["0", "20", "50", "80", "120"],
    congestion_index: ["0", "0.5", "0.75", "0.9", "1.0"],
  };

  return (
    <div className="network-legend-container">
      {/* Speed/Volume Legend */}
      {(isVolumes || isNetwork) && (
        <div className="network-legend-section">
          <div className="network-legend-title">
            {isVolumes ? "Average Daily Volume [vehicles/day]" : "Network Speed [km/h]"}
          </div>
          <div className="network-legend-bar">
            {isVolumes ? (
              <>
                <span className="network-legend-label">0</span>
                <span className="network-legend-label">100</span>
                <span className="network-legend-label">500</span>
              </>
            ) : (
              <>
                <span className="network-legend-label">0</span>
                <span className="network-legend-label">50</span>
                <span className="network-legend-label">100</span>
                <span className="network-legend-label">150</span>
              </>
            )}
          </div>
          <div
            className="network-legend-gradient"
            style={{
              background: isVolumes
                ? "linear-gradient(to right, #ffffcc, #c2e699, #78c679, #31a354, #006837)"
                : "linear-gradient(to right, #ffffb2, #fed976, #feb24c, #fd8d3c, #fc4e2a, #e31a1c, #b10026)",
            }}
          />
        </div>
      )}

      {/* Capacity Legend */}
      {(isVolumes || isNetwork) && (
        <div className="network-legend-section">
          <div className="network-legend-title">Road Capacity</div>
          <div className="capacity-legend">
            <div className="capacity-item">
              <div className="capacity-line thin"></div>
              <span className="network-legend-label">300</span>
            </div>
            <div className="capacity-item">
              <div className="capacity-line medium"></div>
              <span className="network-legend-label">2000</span>
            </div>
            <div className="capacity-item">
              <div className="capacity-line thick"></div>
              <span className="network-legend-label">4000+</span>
            </div>
          </div>
        </div>
      )}

      {/* Transit Stop Volume Legend */}
      {isTransit && (
        <div className="network-legend-section">
          <div className="network-legend-title">Transit Stop Volumes [boardings + alightings]</div>
          <div className="transit-stop-legend">
            {[0, 100, 500, 2500, 10000].map((v, idx) => (
              <div key={idx} className="transit-stop-legend-item">
                <div
                  className="transit-stop-circle"
                  style={{
                    width: `${[6, 9, 18, 26, 34][idx]}px`,
                    height: `${[6, 9, 18, 26, 34][idx]}px`,
                    backgroundColor: "#ff8800",
                  }}
                />
                <span className="network-legend-label">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Link Speeds Legend */}
      {isLinkSpeeds && (
        <div className="network-legend-section">
          <div className="network-legend-title">
            {linkSpeedsTitles[linkSpeedsMetric] || linkSpeedsTitles.avg_speed}
          </div>
          <div className="network-legend-bar">
            {(linkSpeedsLabels[linkSpeedsMetric] || linkSpeedsLabels.avg_speed).map((l, i) => (
              <span key={i} className="network-legend-label">{l}</span>
            ))}
          </div>
          <div
            className="network-legend-gradient"
            style={{ background: speedGradient }}
          />
        </div>
      )}

      {/* Destination Zones Legend — content depends on the sizing toggle */}
      {isDestination && (
        <div className="network-legend-section">
          <div className="network-legend-title">
            {destSizingMode === "share" ? "Share of total flow" : "Destination volume (trips)"}
          </div>
          <div className="transit-stop-legend">
            {(destSizingMode === "share" ? DESTINATION_SHARE_STOPS : DESTINATION_VOLUME_STOPS).map((row) => {
              const d = destFactorToDiameter(row.factor);
              return (
              <div key={row.label} className="transit-stop-legend-item">
                <div
                  className="transit-stop-circle"
                  style={{
                    width: `${d}px`,
                    height: `${d}px`,
                    backgroundColor: destColor,
                    borderColor: "#fff",
                  }}
                />
                <span className="network-legend-label">{row.label}</span>
              </div>
              );
            })}
            {/* Hub marker: only data-scaled (by intra-polygon trips) when the
                "Show internal trips" toggle is on. */}
            {destinationData?.showInternalTrips && (
              <div className="transit-stop-legend-item">
                <div
                  className="transit-stop-circle"
                  style={{
                    width: "16px",
                    height: "16px",
                    backgroundColor: "#ea580c",
                    borderColor: "#fff",
                  }}
                />
                <span className="network-legend-label">Within</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Volume Flow Legend */}
      {isVolumeFlow && (
        <div className="network-legend-section">
          <div className="network-legend-title">Volume Scale [veh/day]</div>
          <div className="capacity-legend">
            <div className="capacity-item">
              <div className="capacity-line" style={{ height: '2px', background: '#ff8c00', width: '30px' }}></div>
              <span className="network-legend-label">10</span>
            </div>
            <div className="capacity-item">
              <div className="capacity-line" style={{ height: '4px', background: '#ff8c00', width: '30px' }}></div>
              <span className="network-legend-label">150</span>
            </div>
            <div className="capacity-item">
              <div className="capacity-line" style={{ height: '7px', background: '#ff8c00', width: '30px' }}></div>
              <span className="network-legend-label">300</span>
            </div>
            <div className="capacity-item">
              <div className="capacity-line" style={{ height: '10px', background: '#ff8c00', width: '30px' }}></div>
              <span className="network-legend-label">500</span>
            </div>
            <div className="capacity-item">
              <div className="capacity-line" style={{ height: '14px', background: '#ff8c00', width: '30px' }}></div>
              <span className="network-legend-label">700+</span>
            </div>
          </div>
          <div className="network-legend-title" style={{ marginTop: '10px' }}>Target Link</div>
          <div className="capacity-legend">
            <div className="capacity-item">
              <div className="capacity-line" style={{ height: '6px', background: '#1a73e8', width: '30px' }}></div>
              <span className="network-legend-label">Target</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Legend;
