import React, { useState, useCallback, useMemo, useRef } from "react";
import Plot from "react-plotly.js";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import cantonAlias from "../../utils/canton_alias.json";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useData } from "../../context/DataContext";
import { basePlotLayout, basePlotConfig } from "../../utils/plotTheme";
import { useQuery } from "@tanstack/react-query";

const VEHICLE_COLORS = {
  rail: "#636efa",
  bus: "#00cc96",
  tram: "#ab63fa",
  funicular: "#ff6692",
  all: "#1f77b4"  // default color for all vehicles
};


const PtBoardings = ({ canton, onTotalBoardingsChange, timeRange, setTimeRange, selectedTransitStop }) => {
  const [selectedVehicle, setSelectedVehicle] = useState('all');
  const [selectedLine, setSelectedLine] = useState('all');
  const [showStopAnalysis, setShowStopAnalysis] = useState(false);
  const loadWithFallback = useLoadWithFallback();
  const { datasetId } = useData();
  
  const vehicles = [
    { value: 'all', label: 'All Vehicles' },
    { value: 'rail', label: 'Rail' },
    { value: 'bus', label: 'Bus' },
    { value: 'tram', label: 'Tram' },
    { value: 'funicular', label: 'Funicular' }
  ];
  
  const timeToLabel = (value) => {
    const hour = Math.floor(value / 4);
    const minute = (value % 4) * 15;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  // datasetId in the key: refetch when the dataset switches instead of
  // serving the previous dataset's cached boarding/transfer data.
  const { data: ptDataBundle } = useQuery({
    queryKey: ['pt-boardings-data', datasetId],
    queryFn: () => Promise.all([
      loadWithFallback('boarding_data_by_line.json'),
      loadWithFallback('stop_transfer_data_by_canton.json')
    ]).then(([boardingData, transferData]) => ({ boardingData, transferData })),
    enabled: !!canton,
  });

  const plotData = ptDataBundle?.boardingData ?? null;
  const transferData = ptDataBundle?.transferData ?? null;

  // Derived: available lines based on current filters
  const availableLines = useMemo(() => {
    if (!plotData || !canton) return [{ value: 'all', label: 'All Lines' }];

    const linesForCanton = [];
    const uniqueLineIds = new Set();

    Object.values(plotData).forEach(entry => {
      if (entry.cantons && entry.cantons.includes(canton)) {
        if (selectedVehicle === 'all' || entry.vehicle === selectedVehicle) {
          if (!uniqueLineIds.has(entry.line_id)) {
            uniqueLineIds.add(entry.line_id);

            let isAtSelectedStop = false;
            if (selectedTransitStop && selectedTransitStop.lines) {
              isAtSelectedStop = selectedTransitStop.lines.some(stopLine =>
                stopLine.line_id === entry.line_id ||
                stopLine.line_name === entry.line_name
              );
            }

            linesForCanton.push({
              value: entry.line_id,
              label: `${entry.line_name} (${entry.vehicle})${isAtSelectedStop ? ' \u2605' : ''}`,
              isAtSelectedStop
            });
          }
        }
      }
    });

    const sortedLines = linesForCanton.sort((a, b) => {
      if (a.isAtSelectedStop && !b.isAtSelectedStop) return -1;
      if (!a.isAtSelectedStop && b.isAtSelectedStop) return 1;
      return a.label.localeCompare(b.label);
    });

    return [{ value: 'all', label: 'All Lines' }, ...sortedLines];
  }, [plotData, canton, selectedVehicle, selectedTransitStop]);

  // Reset line selection when vehicle changes (moved from useEffect to handler below)
  const prevVehicleRef = useRef(selectedVehicle);
  if (prevVehicleRef.current !== selectedVehicle) {
    prevVehicleRef.current = selectedVehicle;
    if (selectedLine !== 'all') setSelectedLine('all');
  }

  // Sync showStopAnalysis with selectedTransitStop changes
  const prevStopRef = useRef(selectedTransitStop);
  if (selectedTransitStop !== prevStopRef.current) {
    prevStopRef.current = selectedTransitStop;
    const nextShow = !!selectedTransitStop;
    if (nextShow !== showStopAnalysis) setShowStopAnalysis(nextShow);
  }

  const processData = () => {
    if (!plotData || !canton) return null;
    
    // Filter data for the selected canton
    let filteredData = Object.values(plotData).filter(entry => 
      entry.cantons && entry.cantons.includes(canton)
    );
    
    // Filter by vehicle type
    if (selectedVehicle !== 'all') {
      filteredData = filteredData.filter(entry => entry.vehicle === selectedVehicle);
    }
    
    // Filter by specific line
    if (selectedLine !== 'all') {
      filteredData = filteredData.filter(entry => entry.line_id === selectedLine);
    }
    
    // Aggregate boarding data by time
    const aggregatedBoardings = {};
    
    filteredData.forEach(entry => {
      if (entry.boardings) {
        Object.entries(entry.boardings).forEach(([time, cantonBoardings]) => {
          // Convert HH:MM time to slider index (0-96)
          const [hours, minutes] = time.split(':').map(Number);
          const timeIndex = hours * 4 + Math.floor(minutes / 15);
          
          // Only include data within selected time range
          if (timeIndex >= timeRange[0] && timeIndex <= timeRange[1]) {
            if (!aggregatedBoardings[time]) {
              aggregatedBoardings[time] = 0;
            }
            // Sum boardings for the selected canton
            if (cantonBoardings[canton]) {
              aggregatedBoardings[time] += cantonBoardings[canton];
            }
          }
        });
      }
    });
    
    // Sort times and prepare data for plotting
    const times = Object.keys(aggregatedBoardings).sort();
    const boardings = times.map(t => aggregatedBoardings[t]);
    
    return { times, boardings };
  };

  const createTransferMatrix = () => {
    if (!selectedTransitStop || !plotData || !canton || !transferData) {
      return null;
    }
    
    // Get transfer data for this canton
    const cantonData = transferData[canton];
    
    if (!cantonData) {
      return null;
    }
    
    // Try multiple ways to find the stop data
    let foundStopData = null;
    let foundStopId = null;
    
    // First try the direct stop_id
    const primaryStopId = selectedTransitStop.stop_id;
    if (primaryStopId && cantonData[primaryStopId]) {
      foundStopData = cantonData[primaryStopId];
      foundStopId = primaryStopId;
    }
    
    // If not found, try all stop_ids variations
    if (!foundStopData && selectedTransitStop.stop_ids) {
      for (const altStopId of selectedTransitStop.stop_ids) {
        if (cantonData[altStopId]) {
          foundStopData = cantonData[altStopId];
          foundStopId = altStopId;
          break;
        }
      }
    }
    
    // If still not found, try searching by partial match (the keys in JSON might have additional suffixes)
    if (!foundStopData) {
      const stopIdVariations = [primaryStopId, ...(selectedTransitStop.stop_ids || [])];
      
      for (const stopId of stopIdVariations) {
        if (!stopId) continue;
        
        // Try to find keys that contain this stop ID
        const matchingKeys = Object.keys(cantonData).filter(key => 
          key.includes(stopId) || stopId.includes(key.split(':')[0] + ':')
        );
        
        if (matchingKeys.length > 0) {
          foundStopData = cantonData[matchingKeys[0]];
          foundStopId = matchingKeys[0];
          console.log(`Found transfer data using partial match: ${stopId} -> ${matchingKeys[0]}`);
          break;
        }
      }
    }
    
    if (!foundStopData || !foundStopData.line_transfers) {
      console.log('No transfer data found for stop:', selectedTransitStop.name, 'Stop IDs tried:', [primaryStopId, ...(selectedTransitStop.stop_ids || [])]);
      return null;
    }
    
    // Get all lines involved in transfers at this stop
    const lineTransfers = foundStopData.line_transfers;
    const allLines = new Set();
    
    // Collect all lines that have transfers (both from and to)
    Object.keys(lineTransfers).forEach(fromLine => {
      allLines.add(fromLine);
      Object.keys(lineTransfers[fromLine]).forEach(toLine => {
        allLines.add(toLine);
      });
    });
    
    if (allLines.size < 2) return null; // Need at least 2 lines for a transfer matrix
    
    const lineArray = Array.from(allLines).sort();
    const matrix = [];
    const lineNames = [];
    
    // Create line names with vehicle type from boarding data
    lineArray.forEach(lineId => {
      const lineEntry = Object.values(plotData).find(entry => entry.line_id === lineId);
      if (lineEntry) {
        lineNames.push(`${lineEntry.line_name} (${lineEntry.vehicle})`);
      } else {
        lineNames.push(lineId); // fallback to line ID
      }
    });
    
    // Build the transfer matrix
    lineArray.forEach((fromLine, i) => {
      const row = [];
      lineArray.forEach((toLine, j) => {
        if (i === j) {
          row.push(0); // No self-transfers
        } else {
          // Get transfer count from data
          const transferCount = lineTransfers[fromLine]?.[toLine] || 0;
          row.push(transferCount);
        }
      });
      matrix.push(row);
    });
    
    return { matrix, lineNames };
  };

  const createDestinationDistribution = () => {
    if (!selectedTransitStop || !transferData || !canton) {
      return null;
    }
    
    const cantonData = transferData[canton];
    if (!cantonData) {
      return null;
    }
    
    // Use the same logic as createTransferMatrix to find the stop data
    let foundStopData = null;
    
    // First try the direct stop_id
    const primaryStopId = selectedTransitStop.stop_id;
    if (primaryStopId && cantonData[primaryStopId]) {
      foundStopData = cantonData[primaryStopId];
    }
    
    // If not found, try all stop_ids variations
    if (!foundStopData && selectedTransitStop.stop_ids) {
      for (const altStopId of selectedTransitStop.stop_ids) {
        if (cantonData[altStopId]) {
          foundStopData = cantonData[altStopId];
          break;
        }
      }
    }
    
    // If still not found, try searching by partial match
    if (!foundStopData) {
      const stopIdVariations = [primaryStopId, ...(selectedTransitStop.stop_ids || [])];
      
      for (const stopId of stopIdVariations) {
        if (!stopId) continue;
        
        const matchingKeys = Object.keys(cantonData).filter(key => 
          key.includes(stopId) || stopId.includes(key.split(':')[0] + ':')
        );
        
        if (matchingKeys.length > 0) {
          foundStopData = cantonData[matchingKeys[0]];
          break;
        }
      }
    }
    
    if (!foundStopData) {
      return null;
    }
    
    // Create distribution showing transfer patterns
    const transferStats = {
      'Total Boardings': foundStopData.total_boardings || 0,
      'Transfers In': foundStopData.total_transfers_in || 0,
      'Transfers Out': foundStopData.total_transfers_out || 0
    };
    
    // Also show top destination stops if available
    const stopTransfers = foundStopData.stop_transfers || {};
    const topDestinations = Object.entries(stopTransfers)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5); // Top 5 destinations
    
    // Combine transfer stats and destination data for visualization
    const categories = Object.keys(transferStats);
    const values = Object.values(transferStats);
    
    // Add top destinations
    topDestinations.forEach(([destStopId, count]) => {
      categories.push(`To ${destStopId.slice(0, 10)}...`); // Shortened stop ID
      values.push(count);
    });
    
    return { 
      categories, 
      values,
      transferStats,
      topDestinations 
    };
  };

  const data = processData();
  const transferMatrix = createTransferMatrix();
  const destinationDistribution = createDestinationDistribution();

  // Derived: compute total boardings and notify parent
  const prevBoardingsRef = useRef(null);
  const boardingsPayload = useMemo(() => {
    if (!plotData || !canton) return null;

    let filteredDataForTotal = Object.values(plotData).filter(entry =>
      entry.cantons && entry.cantons.includes(canton)
    );

    const vehicleTotals = { all: 0, rail: 0, bus: 0, tram: 0, funicular: 0 };
    const lineTotals = {};

    filteredDataForTotal.forEach(entry => {
      if (entry.boardings) {
        Object.entries(entry.boardings).forEach(([time, cantonBoardings]) => {
          const [hours, minutes] = time.split(':').map(Number);
          const timeIndex = hours * 4 + Math.floor(minutes / 15);

          if (timeIndex >= timeRange[0] && timeIndex <= timeRange[1]) {
            const boardingCount = cantonBoardings[canton] || 0;

            vehicleTotals.all += boardingCount;
            if (vehicleTotals[entry.vehicle] !== undefined) {
              vehicleTotals[entry.vehicle] += boardingCount;
            }

            if (!lineTotals[entry.line_id]) {
              lineTotals[entry.line_id] = {
                name: entry.line_name,
                vehicle: entry.vehicle,
                count: 0,
                route_ids: entry.route_id || []
              };
            }
            lineTotals[entry.line_id].count += boardingCount;
          }
        });
      }
    });

    let selectedLineInfo = null;
    let rawLineData = null;
    if (selectedLine !== 'all') {
      const selectedLineEntry = Object.values(plotData).find(entry =>
        entry.line_id === selectedLine && entry.cantons && entry.cantons.includes(canton)
      );
      if (selectedLineEntry) {
        selectedLineInfo = {
          line_id: selectedLineEntry.line_id,
          line_name: selectedLineEntry.line_name,
          vehicle: selectedLineEntry.vehicle,
          cantons: selectedLineEntry.cantons,
          route_ids: selectedLineEntry.route_id || []
        };
        rawLineData = selectedLineEntry;
      }
    }

    return {
      byVehicle: vehicleTotals,
      byLine: lineTotals,
      selectedVehicle,
      selectedLine,
      selectedLineInfo,
      rawLineData,
      timeRange,
      canton
    };
  }, [plotData, selectedVehicle, selectedLine, timeRange, canton]);

  // Notify parent when boarding totals change
  if (onTotalBoardingsChange && boardingsPayload) {
    const key = JSON.stringify(boardingsPayload);
    if (key !== prevBoardingsRef.current) {
      prevBoardingsRef.current = key;
      onTotalBoardingsChange(boardingsPayload);
    }
  }

  if (!plotData) {
    return (
      <div className="plot-container">
        <p className="plot-empty">Click a canton to load boarding data.</p>
      </div>
    );
  }

  return (
    <div className="plot-container">
      <h3>PT Boardings · {cantonAlias[canton] || canton}</h3>
      {selectedTransitStop && (
        <div className="plot-context-pill">
          <span><strong>Selected stop:</strong> {selectedTransitStop.name}</span>
          <button
            className={`plot-action-btn ${showStopAnalysis ? "is-active" : ""}`}
            onClick={() => setShowStopAnalysis(!showStopAnalysis)}
          >
            {showStopAnalysis ? "Hide" : "Show"} stop analysis
          </button>
        </div>
      )}

      <div className="plot-time-row">
        <div className="plot-time-slider">
          <span className="plot-time-label">
            Time · {formatTimeLabel(timeRange[0])} – {formatTimeLabel(timeRange[1])}
          </span>
          <Slider
            range
            min={0}
            max={96}
            step={1}
            marks={marks}
            value={timeRange}
            onChange={(val) => setTimeRange(val)}
            allowCross={false}
          />
        </div>
      </div>

      <div className="plot-controls">
        <div className="plot-controls-group">
          <span className="plot-controls-label">Vehicle Type</span>
          {vehicles.map(vehicle => (
            <label key={vehicle.value} htmlFor={`vehicle-${vehicle.value}`}>
              <input
                type="radio"
                id={`vehicle-${vehicle.value}`}
                name="vehicle-type"
                value={vehicle.value}
                checked={selectedVehicle === vehicle.value}
                onChange={(e) => setSelectedVehicle(e.target.value)}
              />
              {vehicle.label}
            </label>
          ))}
        </div>

        <div className="plot-controls-group" style={{ minWidth: 220 }}>
          <span className="plot-controls-label">
            Transit Line
            {selectedTransitStop && (
              <span className="plot-controls-hint">★ serves selected stop</span>
            )}
          </span>
          <select
            className="plot-select"
            value={selectedLine}
            onChange={(e) => setSelectedLine(e.target.value)}
            style={{ minWidth: 220, maxWidth: 300 }}
          >
            {availableLines.map(option => (
              <option
                key={option.value}
                value={option.value}
                style={{ fontWeight: option.isAtSelectedStop ? "bold" : "normal" }}
              >
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Stop Analysis Section */}
      {showStopAnalysis && selectedTransitStop && (
        <div className="plot-card">
          <div className="plot-card-header">
            <h4 style={{ margin: 0 }}>Stop Analysis · {selectedTransitStop.name}</h4>
            <button
              className="plot-action-btn"
              onClick={() => {/* clear selected stop */}}
              title="Clear selected stop"
            >
              ✕ Clear
            </button>
          </div>

          {transferMatrix && transferMatrix.lineNames.length > 1 ? (
            <div>
              <h5>Line Transfer Matrix</h5>
              <Plot
                data={[{
                  z: transferMatrix.matrix,
                  x: transferMatrix.lineNames,
                  y: transferMatrix.lineNames,
                  type: "heatmap",
                  colorscale: "Blues",
                  showscale: true,
                  hoverongaps: false,
                  texttemplate: "%{z}",
                  textfont: { size: 10, color: "#1f2937" },
                }]}
                layout={basePlotLayout({
                  height: 320,
                  width: 560,
                  margin: { t: 20, r: 40, l: 150, b: 110 },
                  xaxis: { title: "To Line", tickangle: -45 },
                  yaxis: { title: "From Line" },
                })}
                config={{ ...basePlotConfig, displayModeBar: false }}
              />
            </div>
          ) : (
            <div>
              <h5>Line Transfer Matrix</h5>
              <p className="plot-empty">
                {transferData ? "No transfer data available for this stop." : "Loading transfer data…"}
              </p>
            </div>
          )}

          {destinationDistribution && (
            <div>
              <h5>Transfer Statistics</h5>
              <div className="plot-stats">
                <span className="plot-stat-chip">
                  Total boardings <strong>{destinationDistribution.transferStats["Total Boardings"]}</strong>
                </span>
                <span className="plot-stat-chip">
                  Transfers in <strong>{destinationDistribution.transferStats["Transfers In"]}</strong>
                </span>
                <span className="plot-stat-chip">
                  Transfers out <strong>{destinationDistribution.transferStats["Transfers Out"]}</strong>
                </span>
              </div>

              {destinationDistribution.topDestinations.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <h6>Top Transfer Destinations</h6>
                  <Plot
                    data={[{
                      x: destinationDistribution.topDestinations.map(([stopId]) => stopId.slice(0, 15) + "…"),
                      y: destinationDistribution.topDestinations.map(([, count]) => count),
                      type: "bar",
                      marker: { color: "#0d9488" },
                      name: "Transfer Count",
                      hovertemplate: "%{x}<br>%{y:,}<extra></extra>",
                    }]}
                    layout={basePlotLayout({
                      height: 240,
                      width: 560,
                      margin: { t: 16, r: 12, l: 52, b: 100 },
                      xaxis: { title: "Destination Stop", tickangle: -45 },
                      yaxis: { title: "Transfer Count" },
                    })}
                    config={{ ...basePlotConfig, displayModeBar: false }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="plot-card">
        <h4>Boarding Counts</h4>
        {!data || data.times.length === 0 ? (
          <p className="plot-empty">No boarding data available for the selected filters.</p>
        ) : (
          <Plot
            data={[
              {
                x: data.times,
                y: data.boardings,
                type: "bar",
                marker: { color: VEHICLE_COLORS[selectedVehicle] || VEHICLE_COLORS.all },
                hovertemplate: "%{x}<br>%{y:,} boardings<extra></extra>",
              },
            ]}
            layout={basePlotLayout({
              height: 260,
              width: 520,
              margin: { t: 16, r: 12, l: 52, b: 70 },
              xaxis: { title: "Hour", tickangle: -45 },
              yaxis: { title: "Boarding Count" },
            })}
            config={basePlotConfig}
          />
        )}
      </div>
    </div>
  );
};

export default PtBoardings;
