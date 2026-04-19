import React from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { useApp } from '../../context/AppContext';
import { marks, formatTimeLabel } from '../../utils/timeSliderUtils';
import './VolumeFlowModule.css';

const METRIC_OPTIONS = [
    { value: 'congestion_index', label: 'Congestion Index' },
    { value: 'avg_speed', label: 'Avg Speed' },
    { value: 'freespeed', label: 'Freespeed' },
];

const ROAD_TYPES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential'];

const LinkSpeedsModule = () => {
    const {
        clickedCanton,
        timeRange, setTimeRange,
        linkSpeedsMetric, setLinkSpeedsMetric,
        linkSpeedsSelected,
        linkSpeedsSummary,
        linkSpeedsRoadTypes, setLinkSpeedsRoadTypes,
    } = useApp();

    const handleRoadTypeChange = (event) => {
        const selected = Array.from(event.target.selectedOptions).map(o => o.value);
        if (selected.includes('all') || selected.length === 0) {
            setLinkSpeedsRoadTypes(['all']);
        } else {
            setLinkSpeedsRoadTypes(selected);
        }
    };

    return (
        <div className="plot-container">
            {/* Metric toggle */}
            <div className="flow-direction-toggle">
                {METRIC_OPTIONS.map(opt => (
                    <button
                        key={opt.value}
                        className={`flow-dir-btn${linkSpeedsMetric === opt.value ? ' active' : ''}`}
                        onClick={() => setLinkSpeedsMetric(opt.value)}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {/* Road type multi-select filter */}
            <div className="mode-filter-container">
                <label className="mode-filter-label">Filter by Road Type:</label>
                <select
                    multiple
                    value={linkSpeedsRoadTypes}
                    onChange={handleRoadTypeChange}
                    className="mode-filter-select"
                >
                    <option value="all">All</option>
                    {ROAD_TYPES.map(rt => (
                        <option key={rt} value={rt}>
                            {rt.charAt(0).toUpperCase() + rt.slice(1)}
                        </option>
                    ))}
                </select>
            </div>

            {/* Time range slider */}
            <div className="right-sidebar-control-row">
                <div style={{ flex: 1 }}>
                    <label className="right-sidebar-label" style={{ marginLeft: '7%' }}>
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
                        style={{ marginLeft: '10%', width: '80%' }}
                    />
                </div>
            </div>

            {/* No-selection hint */}
            {!clickedCanton && (
                <div className="no-selection">
                    <p>No canton selected</p>
                    <p className="hint">Select a canton to load link speeds</p>
                </div>
            )}

            {/* Canton-wide summary */}
            {clickedCanton && linkSpeedsSummary && (
                <div className="canton-mode-share">
                    <h4>Network Summary</h4>
                    <table>
                        <tbody>
                            <tr><td><strong>Links with traffic</strong></td><td>{linkSpeedsSummary.totalLinks.toLocaleString()}</td></tr>
                            <tr><td><strong>Avg Speed</strong></td><td>{linkSpeedsSummary.avgSpeed != null ? `${linkSpeedsSummary.avgSpeed.toFixed(1)} km/h` : '—'}</td></tr>
                            <tr><td><strong>Avg Freespeed</strong></td><td>{linkSpeedsSummary.avgFreespeed != null ? `${linkSpeedsSummary.avgFreespeed.toFixed(1)} km/h` : '—'}</td></tr>
                            <tr><td><strong>Congestion Index</strong></td><td>{linkSpeedsSummary.congestionIndex ?? '—'}</td></tr>
                            <tr><td><strong>Total Volume</strong></td><td>{linkSpeedsSummary.totalVolume.toLocaleString()}</td></tr>
                        </tbody>
                    </table>
                </div>
            )}

            {/* Selected-link detail */}
            {linkSpeedsSelected && (
                <div className="canton-mode-share">
                    <h4>Selected Link</h4>
                    <table>
                        <tbody>
                            <tr><td><strong>Link IDs</strong></td><td style={{ wordBreak: 'break-all' }}>{linkSpeedsSelected.linkId}</td></tr>
                            <tr><td><strong>Avg Speed</strong></td><td>{linkSpeedsSelected.avgSpeed.toFixed(1)} km/h</td></tr>
                            <tr><td><strong>Freespeed</strong></td><td>{linkSpeedsSelected.freespeed.toFixed(1)} km/h</td></tr>
                            <tr><td><strong>Congestion Index</strong></td><td>{linkSpeedsSelected.congestionIndex.toFixed(3)}</td></tr>
                            <tr><td><strong>Daily Volume</strong></td><td>{linkSpeedsSelected.dailyVolume.toLocaleString()} veh/day</td></tr>
                            <tr>
                                <td><strong>Modes</strong></td>
                                <td>
                                    <div className="mode-badges">
                                        {(linkSpeedsSelected.modes || '').split(',').filter(Boolean).map(m => (
                                            <span className="mode-badge" key={m}>{m}</span>
                                        ))}
                                    </div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            )}

            {clickedCanton && !linkSpeedsSelected && (
                <p style={{ padding: '1rem', fontStyle: 'italic', color: '#9ca3af' }}>
                    Click a link on the map to see its speed details.
                </p>
            )}
        </div>
    );
};

export default LinkSpeedsModule;
