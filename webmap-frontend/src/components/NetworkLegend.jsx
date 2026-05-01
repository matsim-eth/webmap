import React from "react";
import "./NetworkLegend.css";
import { useModule } from "../context/ModuleContext";
import { useFilters } from "../context/FilterContext";

const Legend = () => {
  const { isGraphExpanded: selectedGraph } = useModule();
  const { showStopVolumeSymbology, linkSpeedsMetric } = useFilters();

  const isVolumes = selectedGraph === "Volumes";
  const isNetwork = selectedGraph === "Network";
  const isTransit = selectedGraph === "Transit";
  const isVolumeFlow = selectedGraph === "VolumeFlow";
  const isLinkSpeeds = selectedGraph === "LinkSpeeds";

  if (!isVolumes && !isNetwork && !isVolumeFlow && !isLinkSpeeds && !(isTransit && showStopVolumeSymbology)) return null;

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
