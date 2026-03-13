import React, { useEffect, useState, useCallback, useMemo } from "react";
import Plot from "react-plotly.js";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import cantonAlias from "../../utils/canton_alias.json";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";

const MODE_COLORS = {
  car: "#636efa",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
  all: "#1f77b4"  // default color for all modes
};


const DestinationZones = ({ canton, onTotalOutflowChange, timeRange, setTimeRange }) => {
  const [plotData, setPlotData] = useState(null);
  const [selectedMode, setSelectedMode] = useState('all');
  const [selectedPurpose, setSelectedPurpose] = useState('all');
  const [selectedCanton, setSelectedCanton] = useState('all');
  const [isOriginMode, setIsOriginMode] = useState(true);
  
  const loadWithFallback = useLoadWithFallback();
  
  const modes = [
    { value: 'all', label: 'All Modes' },
    { value: 'car', label: 'Car' },
    { value: 'pt', label: 'Public Transport' },
    { value: 'bike', label: 'Bicycle' },
    { value: 'walk', label: 'Walk' }
  ];
  
  const purposes = [
    { value: 'all', label: 'All Purposes'},
    { value: 'work', label: 'Work'},
    { value: 'education', label: 'Education'},
    { value: 'shop', label: 'Shopping'},
    { value: 'leisure', label: 'Leisure'}
  ];
  
  const cantonOptions = [
    { value: 'all', label: 'All Cantons' },
    ...Object.entries(cantonAlias).map(([value, label]) => ({ value, label }))
  ];
  
  const timeToLabel = (value) => {
    const hour = Math.floor(value / 4);
    const minute = (value % 4) * 15;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };
  
  useEffect(() => {
    if (!canton) return;
    
    const path = `destination_data/${canton}.json`;
    
    loadWithFallback(path)
    .then(data => {
      setPlotData(data);
    })
    .catch(err => {
      console.error("Error loading plot data:", err);
    });
  }, [canton]);
  
  const processData = () => {
    if (!plotData) return null;
    
    // reverse mapping of display names to internal values
    const reverseCantonMap = Object.entries(cantonAlias).reduce((acc, [key, value]) => {
      acc[value] = key;
      return acc;
    }, {});
    
    // filter by role (origin/destination mode)
    let filteredData = plotData.filter(d => 
      d.role === (isOriginMode ? 'origin' : 'destination')
    );
    
    // filter by canton
    if (selectedCanton !== 'all') {
      // get the display name to match the internal representation
      filteredData = filteredData.filter(d => {
        if (isOriginMode) {
          // In origin mode, filter by destination canton
          return d.destination === selectedCanton || reverseCantonMap[d.destination] === selectedCanton;
        } else {
          // In destination mode, filter by origin canton
          return d.origin === selectedCanton || reverseCantonMap[d.origin] === selectedCanton;
        }
      });
    }
    // filter by transport mode
    if (selectedMode !== 'all') {
      filteredData = filteredData.filter(d => d.mode === selectedMode);
    }
    // filter by trip purpose 
    if (selectedPurpose !== 'all') {
      filteredData = filteredData.filter(d => d.purpose === selectedPurpose);
    }
    
    // aggregate the filtered bins
    const aggregatedBins = {};
    filteredData.forEach(entry => {
      Object.entries(entry.time_bins).forEach(([time, count]) => {
        // convert HH:MM time to slider index (0-96)
        const [hours, minutes] = time.split(':').map(Number);
        const timeIndex = hours * 4 + Math.floor(minutes / 15);
        
        // limit display to selected time range
        if (timeIndex >= timeRange[0] && timeIndex <= timeRange[1]) {
          if (!aggregatedBins[time]) {
            aggregatedBins[time] = 0;
          }
          aggregatedBins[time] += count;
        }
      });
    });
    
    // sort trip counts by time
    const times = Object.keys(aggregatedBins).sort();
    const counts = times.map(t => aggregatedBins[t]);
    
    return { times, counts };
  };
  
  const data = processData();
  
  // calculating trip outflow based to propagate to map
  useEffect(() => {
    if (!plotData || !onTotalOutflowChange) return;
    
    const reverseCantonMap = Object.entries(cantonAlias).reduce((acc, [key, value]) => {
      acc[value] = key;
      return acc;
    }, {});
    
    // filter by role (origin/destination mode)
    let filteredDataForChoropleth = plotData.filter(d => 
      d.role === (isOriginMode ? 'origin' : 'destination')
    );
    
    if (selectedPurpose !== 'all') {
      filteredDataForChoropleth = filteredDataForChoropleth.filter(d => d.purpose === selectedPurpose);
    }
    
    const initModeTotals = () => {
      return { all: 0, car: 0, pt: 0, bike: 0, walk: 0 };
    };
    
    const modeTotals = initModeTotals();
    const cantonTotals = {};
    
    filteredDataForChoropleth.forEach(entry => {
      Object.entries(entry.time_bins).forEach(([time, count]) => {
        const [hours, minutes] = time.split(':').map(Number);
        const timeIndex = hours * 4 + Math.floor(minutes / 15);
        if (timeIndex >= timeRange[0] && timeIndex <= timeRange[1]) {
          modeTotals.all += count;
          if (modeTotals[entry.mode] !== undefined) {
            modeTotals[entry.mode] += count;
          }
          
          // When in destination mode, show distribution by origin cantons
          // When in origin mode, show distribution by destination cantons
          let cantonKey = isOriginMode ? entry.destination : entry.origin;
          if (reverseCantonMap[cantonKey]) {
            cantonKey = reverseCantonMap[cantonKey];
          }
          if (!cantonTotals[cantonKey]) cantonTotals[cantonKey] = initModeTotals();
          cantonTotals[cantonKey].all += count;
          if (cantonTotals[cantonKey][entry.mode] !== undefined) {
            cantonTotals[cantonKey][entry.mode] += count;
          }
        }
      });
    });
    
    onTotalOutflowChange({ 
      all: modeTotals, 
      perCanton: cantonTotals, 
      selectedMode: selectedMode 
    });
  }, [plotData, selectedCanton, selectedMode, selectedPurpose, timeRange, isOriginMode]);
  
  if (!plotData) {
    return (
      <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
      Click a canton to load destination data.
      </p>
    );
  }
  
  return (
    <div className="plot-container">
    <div style={{ display: 'flex', alignItems: 'flex-start', minHeight: 40 }}>
    <div style={{ minWidth: 260, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
    <h3 style={{ margin: 0 }}>
    {isOriginMode ? "Origin" : "Destination"} Canton: {cantonAlias[canton]}
    </h3>
</div>
</div>

<div
  style={{
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 1rem 1.5rem",
    gap: "1rem"
  }}
>

  {/* OD Toggle */}
  <div style={{ display: "flex", alignItems: "center", minWidth: 180, marginTop: '15px' }}>
    <span style={{ marginRight: '8px', fontWeight: isOriginMode ? 'bold' : 'normal' }}>Origin</span>
    <label
      className="switch"
      style={{
        display: 'inline-block',
        position: 'relative',
        width: '40px',
        height: '20px',
        margin: '0px 14px 0 8px',
      }}
    >
      <input
        type="checkbox"
        checked={!isOriginMode}
        onChange={() => setIsOriginMode((prev) => !prev)}
        style={{ opacity: 0, width: 0, height: 0 }}
      />
      <span
        style={{
          position: 'absolute',
          cursor: 'pointer',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: isOriginMode ? '#2196f3' : '#4caf50',
          borderRadius: '20px',
          transition: '.4s',
        }}
      />
      <span
        style={{
          position: 'absolute',
          left: isOriginMode ? '2px' : '22px',
          top: '2px',
          width: '16px',
          height: '16px',
          backgroundColor: isOriginMode ? '#fff' : '#e8f5e9',
          borderRadius: '50%',
          transition: '.4s',
        }}
      />
    </label>
    <span style={{ fontWeight: !isOriginMode ? 'bold' : 'normal' }}>Destination</span>
  </div>

  {/* Time Slider */}
  <div style={{ flex: 1 }}>
    <label
      style={{
        fontWeight: "bold",
        fontSize: "10pt",
        display: "block",
        marginBottom: "0.25rem",
        marginLeft: "10%",
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
      style={{ marginLeft: "10%", width: "80%" }}
    />
  </div>

  
</div>

    
    <div style={{ display: 'flex', gap: '40px', margin: '20px 10px' }}>
    <div>
    <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Transport Mode</div>
    {modes.map(mode => (
      <div key={mode.value} style={{ marginBottom: '4px' }}>
      <input
      type="radio"
      id={`mode-${mode.value}`}
      name="transport-mode"
      value={mode.value}
      checked={selectedMode === mode.value}
      onChange={(e) => setSelectedMode(e.target.value)}
      />
      <label htmlFor={`mode-${mode.value}`} style={{ marginLeft: '8px' }}>
      {mode.label}
      </label>
      </div>
    ))}
    </div>
    
    <div>
    <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Trip Purpose</div>
    {purposes.map(purpose => (
      <div key={purpose.value} style={{ marginBottom: '4px' }}>
      <input
      type="radio"
      id={`purpose-${purpose.value}`}
      name="trip-purpose"
      value={purpose.value}
      checked={selectedPurpose === purpose.value}
      onChange={(e) => setSelectedPurpose(e.target.value)}
      />
      <label htmlFor={`purpose-${purpose.value}`} style={{ marginLeft: '8px' }}>
      {purpose.label}
      </label>
      </div>
    ))}
    </div>
    
    <div>
    <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
    {isOriginMode ? 'Destination Canton' : 'Origin Canton'}
    </div>
    <select 
    value={selectedCanton}
    onChange={(e) => setSelectedCanton(e.target.value)}
    style={{
      padding: '4px 8px',
      borderRadius: '4px',
      border: '1px solid #ccc',
      fontSize: '14px',
      minWidth: '150px'
    }}
    >
    {cantonOptions.map(option => (
      <option key={option.value} value={option.value}>
      {option.label}
      </option>
    ))}
    </select>
    </div>
    </div>
    
    <h4 style={{ marginTop: "1rem" }}>Trip Counts</h4>
    
    <Plot
    data={[
      {
        x: data.times,
        y: data.counts,
        type: "bar",
        marker: { color: MODE_COLORS[selectedMode] || MODE_COLORS.all }
      }
    ]}
    layout={{
      font: { family: "Inter, sans-serif" },
      margin: { t: 30, r: 10, l: 40, b: 10 },
      xaxis: { title: "Hour", tickangle: -45, automargin: true },
      yaxis: { title: "Trip Count" },
      height: 250,
      width: 525,
      paper_bgcolor: "rgba(255,255,255,0)",
      plot_bgcolor: "rgba(255,255,255,0)",
    }}
    />
    </div>
  );
};

export default DestinationZones;