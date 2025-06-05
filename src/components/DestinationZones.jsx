import React, { useEffect, useState, useCallback, useMemo } from "react";
import Plot from "react-plotly.js";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import cantonAliases from '../utils/canton_alias.json';

const MODE_COLORS = {
  car: "#636efa",
  pt: "#00cc96",
  bike: "#ab63fa",
  walk: "#ffa15a",
  all: "#1f77b4"  // default color for all modes
};


const DestinationZones = ({ canton, dataURL, onTotalOutflowChange }) => {
  const [plotData, setPlotData] = useState(null);
  const [localTimeRange, setLocalTimeRange] = useState([0, 96]);
  const [selectedMode, setSelectedMode] = useState('all');
  const [selectedPurpose, setSelectedPurpose] = useState('all');
  const [selectedCanton, setSelectedCanton] = useState('all');

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
    ...Object.entries(cantonAliases).map(([value, label]) => ({ value, label }))
  ];

  const timeToLabel = (value) => {
    const hour = Math.floor(value / 4);
    const minute = (value % 4) * 15;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  useEffect(() => {
    if (!canton) return;
    fetch(`/webmap/data/plot_data/${canton}.json`)
      .then(res => res.json())
      .then(data => {
        setPlotData(data);
      })
      .catch(err => {
        console.error("Error loading plot data:", err);
      });
  }, [canton, dataURL]);

  const processData = () => {
    if (!plotData) return null;

    // reverse mapping of display names to internal values
    const reverseCantonMap = Object.entries(cantonAliases).reduce((acc, [key, value]) => {
      acc[value] = key;
      return acc;
    }, {});

    // filter by canton
    let filteredData = plotData;
    if (selectedCanton !== 'all') {
      // get the display name to match the internal representation
      filteredData = plotData.filter(d => 
        d.destination === selectedCanton ||
        reverseCantonMap[d.destination] === selectedCanton
      );
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
        if (timeIndex >= localTimeRange[0] && timeIndex <= localTimeRange[1]) {
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

    const reverseCantonMap = Object.entries(cantonAliases).reduce((acc, [key, value]) => {
      acc[value] = key;
      return acc;
    }, {});

    let filteredDataForChoropleth = plotData;
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
        if (timeIndex >= localTimeRange[0] && timeIndex <= localTimeRange[1]) {
          modeTotals.all += count;
          if (modeTotals[entry.mode] !== undefined) {
            modeTotals[entry.mode] += count;
          }
       
          let cantonKey = entry.destination;
          if (reverseCantonMap[entry.destination]) {
            cantonKey = reverseCantonMap[entry.destination];
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
  }, [plotData, selectedCanton, selectedMode, selectedPurpose, localTimeRange]);

  if (!plotData) return <p>Loading data...</p>;

  return (
      <div className="plot-container">
      <h3>Origin Canton: {canton}</h3>
      <div style={{ width: 500, padding: "20px 10px" }}>
        <div style={{ marginBottom: "8px", fontWeight: "bold"}}>
          Time: {timeToLabel(localTimeRange[0])} – {timeToLabel(localTimeRange[1])}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: "8px" }}></div>
        <Slider
          range
          value={localTimeRange}
          onChange={setLocalTimeRange}
          min={0}
          max={96}
          step={1}
          marks={{
            0: timeToLabel(0),
            24: timeToLabel(24),
            48: timeToLabel(48),
            72: timeToLabel(72),
            96: timeToLabel(96)
          }}
          tipFormatter={timeToLabel}
        />
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
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Destination Canton</div>
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
