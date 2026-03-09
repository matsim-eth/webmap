import React, { useEffect, useState, useCallback, useMemo } from "react";
import Plot from "react-plotly.js";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import cantonAlias from "../../utils/canton_alias.json";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";

const VEHICLE_COLORS = {
  rail: "#636efa",
  bus: "#00cc96",
  tram: "#ab63fa",
  funicular: "#ff6692",
  all: "#1f77b4"  // default color for all vehicles
};


const PtBoardings = ({ canton, onTotalBoardingsChange, timeRange, setTimeRange, selectedTransitStop }) => {
  const [plotData, setPlotData] = useState(null);
  const [transferData, setTransferData] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState('all');
  const [selectedLine, setSelectedLine] = useState('all');
  const [availableLines, setAvailableLines] = useState([]);
  const [showStopAnalysis, setShowStopAnalysis] = useState(false);
  const loadWithFallback = useLoadWithFallback();
  
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

  useEffect(() => {
    if (!canton) return;
    
    // Only fetch if we don't already have data
    if (plotData && transferData) return;
    
    Promise.all([
      loadWithFallback('boarding_data_by_line.json'),
      loadWithFallback('stop_transfer_data_by_canton.json')
    ])
    .then(([boardingData, transferData]) => {
      setPlotData(boardingData);
      setTransferData(transferData);
      updateAvailableLines(boardingData, canton, selectedVehicle, selectedTransitStop);
    })
    .catch(err => {
      console.error("Error loading PT data:", err);
    });
  }, [canton]); // Remove loadWithFallback from dependencies to prevent constant refetching

  // Update available lines when vehicle selection changes
  useEffect(() => {
    if (plotData && canton) {
      updateAvailableLines(plotData, canton, selectedVehicle, selectedTransitStop);
      // Reset line selection when vehicle changes
      setSelectedLine('all');
    }
  }, [selectedVehicle, plotData, canton, selectedTransitStop]);

  // Handle selected transit stop
  useEffect(() => {
    if (selectedTransitStop) {
      setShowStopAnalysis(true);
    } else {
      setShowStopAnalysis(false);
    }
  }, [selectedTransitStop]);

  const updateAvailableLines = (data, canton, vehicleFilter, selectedStop = null) => {
    // Extract unique lines for the selected canton
    const linesForCanton = [];
    const uniqueLineIds = new Set();
    
    Object.values(data).forEach(entry => {
      if (entry.cantons && entry.cantons.includes(canton)) {
        // Filter by vehicle type if not 'all'
        if (vehicleFilter === 'all' || entry.vehicle === vehicleFilter) {
          // Only add if we haven't seen this line_id before
          if (!uniqueLineIds.has(entry.line_id)) {
            uniqueLineIds.add(entry.line_id);
            
            // Check if this line serves the selected stop
            let isAtSelectedStop = false;
            if (selectedStop && selectedStop.lines) {
              isAtSelectedStop = selectedStop.lines.some(stopLine => 
                stopLine.line_id === entry.line_id || 
                stopLine.line_name === entry.line_name
              );
            }
            
            linesForCanton.push({
              value: entry.line_id,
              label: `${entry.line_name} (${entry.vehicle})${isAtSelectedStop ? ' ★' : ''}`,
              isAtSelectedStop
            });
          }
        }
      }
    });
    
    // Sort by whether they're at the selected stop first, then by label
    const sortedLines = linesForCanton.sort((a, b) => {
      if (a.isAtSelectedStop && !b.isAtSelectedStop) return -1;
      if (!a.isAtSelectedStop && b.isAtSelectedStop) return 1;
      return a.label.localeCompare(b.label);
    });
    
    setAvailableLines([
      { value: 'all', label: 'All Lines' },
      ...sortedLines
    ]);
  };

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

  // Calculate total boardings to propagate to parent component
  useEffect(() => {
    if (!plotData || !onTotalBoardingsChange || !canton) return;
    
    // Filter data for the selected canton
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
            
            // Track by line
            if (!lineTotals[entry.line_id]) {
              lineTotals[entry.line_id] = { 
                name: entry.line_name, 
                vehicle: entry.vehicle, 
                count: 0,
                route_ids: entry.route_id || [] // route_id is already an array in the data
              };
            }
            lineTotals[entry.line_id].count += boardingCount;
          }
        });
      }
    });
    
    // Get detailed information about the selected line
    let selectedLineInfo = null;
    let rawLineData = null;
    if (selectedLine !== 'all' && plotData) {
      const selectedLineEntry = Object.values(plotData).find(entry => 
        entry.line_id === selectedLine && entry.cantons && entry.cantons.includes(canton)
      );
      if (selectedLineEntry) {
        selectedLineInfo = {
          line_id: selectedLineEntry.line_id,
          line_name: selectedLineEntry.line_name,
          vehicle: selectedLineEntry.vehicle,
          cantons: selectedLineEntry.cantons,
          route_ids: selectedLineEntry.route_id || [] // route_id is already an array in the data
        };
        // Pass the raw line data including boarding information for choropleth
        rawLineData = selectedLineEntry;
      }
    }
    
    onTotalBoardingsChange({ 
      byVehicle: vehicleTotals, 
      byLine: lineTotals,
      selectedVehicle: selectedVehicle,
      selectedLine: selectedLine,
      selectedLineInfo: selectedLineInfo,
      rawLineData: rawLineData,
      timeRange: timeRange,
      canton: canton
    });
  }, [plotData, selectedVehicle, selectedLine, timeRange, canton]);

  if (!plotData) {
    return (
      <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
        Click a canton to load boarding data.
      </p>
    );
  }

  return (
    <div className="plot-container">
      <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: 40 }}>
        <div style={{ minWidth: 260, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
          <h3 style={{ margin: 0 }}>
            PT Boardings: {cantonAlias[canton] || canton}
          </h3>
          {selectedTransitStop && (
            <div style={{ margin: '8px 0', fontSize: '14px', color: '#666' }}>
              <strong>Selected Stop:</strong> {selectedTransitStop.name}
              <button 
                onClick={() => setShowStopAnalysis(!showStopAnalysis)}
                style={{
                  marginLeft: '10px',
                  padding: '4px 8px',
                  fontSize: '12px',
                  border: '1px solid #ccc',
                  borderRadius: '4px',
                  backgroundColor: showStopAnalysis ? '#007AFF' : '#fff',
                  color: showStopAnalysis ? '#fff' : '#333',
                  cursor: 'pointer'
                }}
              >
                {showStopAnalysis ? 'Hide' : 'Show'} Stop Analysis
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          padding: "0 1rem 1.5rem",
          gap: "1rem"
        }}
      >
        {/* Time Slider */}
        <div style={{ flex: 1 }}>
          <label
            style={{
              fontWeight: "bold",
              fontSize: "10pt",
              display: "block",
              marginBottom: "0.25rem",
            }}
          >
            Time: {formatTimeLabel(timeRange[0])} - {formatTimeLabel(timeRange[1])}
          </label>
          <Slider
            range
            min={0}
            max={96}
            step={1}
            marks={marks}
            value={timeRange}
            onChange={(val) => setTimeRange(val)}
            allowCross={false}
            style={{ width: "80%" }}
          />
        </div>
      </div>
      
      <div style={{ display: 'flex', gap: '40px', margin: '20px 10px' }}>
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Vehicle Type</div>
          {vehicles.map(vehicle => (
            <div key={vehicle.value} style={{ marginBottom: '4px' }}>
              <input
                type="radio"
                id={`vehicle-${vehicle.value}`}
                name="vehicle-type"
                value={vehicle.value}
                checked={selectedVehicle === vehicle.value}
                onChange={(e) => setSelectedVehicle(e.target.value)}
              />
              <label htmlFor={`vehicle-${vehicle.value}`} style={{ marginLeft: '8px' }}>
                {vehicle.label}
              </label>
            </div>
          ))}
        </div>
        
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
            Transit Line
            {selectedTransitStop && (
              <span style={{ fontSize: '12px', fontWeight: 'normal', color: '#666', marginLeft: '8px' }}>
                (★ = serves selected stop)
              </span>
            )}
          </div>
          <select 
            value={selectedLine}
            onChange={(e) => setSelectedLine(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: '4px',
              border: '1px solid #ccc',
              fontSize: '14px',
              minWidth: '200px',
              maxWidth: '300px'
            }}
          >
            {availableLines.map(option => (
              <option 
                key={option.value} 
                value={option.value}
                style={{
                  fontWeight: option.isAtSelectedStop ? 'bold' : 'normal'
                }}
              >
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      
      {/* Stop Analysis Section */}
      {showStopAnalysis && selectedTransitStop && (
        <div style={{ margin: '20px 0', padding: '20px', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: '#f9f9f9' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h4 style={{ margin: 0, color: '#333' }}>
              Stop Analysis: {selectedTransitStop.name}
            </h4>
            <button 
              onClick={() => {/* Note: We'll need a way to clear selected stop from parent */}}
              style={{
                padding: '4px 8px',
                fontSize: '12px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                backgroundColor: '#fff',
                color: '#666',
                cursor: 'pointer'
              }}
              title="Clear selected stop"
            >
              ✕ Clear
            </button>
          </div>
          
          {/* Transfer Matrix Heatmap */}
          {transferMatrix && transferMatrix.lineNames.length > 1 ? (
            <div style={{ marginBottom: '20px' }}>
              <h5 style={{ margin: '0 0 10px 0' }}>Line Transfer Matrix (Real Data)</h5>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <Plot
                  data={[{
                    z: transferMatrix.matrix,
                    x: transferMatrix.lineNames,
                    y: transferMatrix.lineNames,
                    type: 'heatmap',
                    colorscale: 'Blues',
                    showscale: true,
                    hoverongaps: false,
                    texttemplate: '%{z}',
                    textfont: { size: 10 }
                  }]}
                  layout={{
                    font: { family: "Inter, sans-serif" },
                    title: 'Actual Transfers Between Lines',
                    xaxis: { title: 'To Line', tickangle: -45 },
                    yaxis: { title: 'From Line' },
                    height: 300,
                    width: 600,
                    margin: { t: 50, r: 50, l: 150, b: 100 },
                    paper_bgcolor: "rgba(255,255,255,0)",
                    plot_bgcolor: "rgba(255,255,255,0)",
                  }}
                  config={{ displayModeBar: false }}
                />
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: '20px', padding: '10px', backgroundColor: '#f0f0f0', borderRadius: '4px' }}>
              <h5 style={{ margin: '0 0 5px 0' }}>Line Transfer Matrix</h5>
              <p style={{ margin: 0, fontSize: '14px', color: '#666' }}>
                {transferData ? 'No transfer data available for this stop.' : 'Loading transfer data...'}
              </p>
            </div>
          )}
          
          {/* Transfer Statistics and Destination Distribution */}
          {destinationDistribution && (
            <div>
              <h5 style={{ margin: '0 0 10px 0' }}>Transfer Statistics</h5>
              
              {/* Transfer Summary */}
              <div style={{ marginBottom: '15px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                <div style={{ padding: '8px 12px', backgroundColor: '#e8f4fd', borderRadius: '4px' }}>
                  <strong>Total Boardings:</strong> {destinationDistribution.transferStats['Total Boardings']}
                </div>
                <div style={{ padding: '8px 12px', backgroundColor: '#e8f4fd', borderRadius: '4px' }}>
                  <strong>Transfers In:</strong> {destinationDistribution.transferStats['Transfers In']}
                </div>
                <div style={{ padding: '8px 12px', backgroundColor: '#e8f4fd', borderRadius: '4px' }}>
                  <strong>Transfers Out:</strong> {destinationDistribution.transferStats['Transfers Out']}
                </div>
              </div>
              
              {/* Top Destinations */}
              {destinationDistribution.topDestinations.length > 0 && (
                <div>
                  <h6 style={{ margin: '0 0 8px 0' }}>Top Transfer Destinations:</h6>
                  <Plot
                    data={[{
                      x: destinationDistribution.topDestinations.map(([stopId, count]) => stopId.slice(0, 15) + '...'),
                      y: destinationDistribution.topDestinations.map(([stopId, count]) => count),
                      type: 'bar',
                      marker: { color: '#ff9500' },
                      name: 'Transfer Count'
                    }]}
                    layout={{
                      font: { family: "Inter, sans-serif" },
                      title: `Transfer Destinations from ${selectedTransitStop.name}`,
                      xaxis: { title: 'Destination Stop', tickangle: -45 },
                      yaxis: { title: 'Transfer Count' },
                      height: 250,
                      width: 600,
                      margin: { t: 50, r: 10, l: 40, b: 100 },
                      paper_bgcolor: "rgba(255,255,255,0)",
                      plot_bgcolor: "rgba(255,255,255,0)",
                    }}
                    config={{ displayModeBar: false }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
      
      <h4 style={{ marginTop: "1rem" }}>Boarding Counts</h4>
      
      {!data || data.times.length === 0 ? (
        <div style={{ 
          padding: "2rem", 
          textAlign: "center", 
          fontStyle: "italic", 
          color: "#888",
          border: "1px dashed #ccc",
          borderRadius: "4px",
          margin: "1rem 0"
        }}>
          No boarding data available for the selected filters.
        </div>
      ) : (
        <Plot
          data={[
            {
              x: data.times,
              y: data.boardings,
              type: "bar",
              marker: { color: VEHICLE_COLORS[selectedVehicle] || VEHICLE_COLORS.all }
            }
          ]}
          layout={{
            font: { family: "Inter, sans-serif" },
            margin: { t: 30, r: 10, l: 40, b: 10 },
            xaxis: { title: "Hour", tickangle: -45, automargin: true },
            yaxis: { title: "Boarding Count" },
            height: 250,
            width: 525,
            paper_bgcolor: "rgba(255,255,255,0)",
            plot_bgcolor: "rgba(255,255,255,0)",
          }}
        />
      )}
    </div>
  );
};

export default PtBoardings;
