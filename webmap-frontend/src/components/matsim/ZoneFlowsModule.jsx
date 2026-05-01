import React, { useMemo } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { useSelection } from '../../context/SelectionContext';
import { useFilters } from '../../context/FilterContext';
import { useData } from '../../context/DataContext';
import { marks, formatTimeLabel } from '../../utils/timeSliderUtils';
import bboxCache from '../../utils/bboxCanton.json';
import cantonAlias from '../../utils/canton_alias.json';
import './VolumeFlowModule.css';
import './ZoneFlowsModule.css';

const DIRECTION_OPTIONS = [
    { value: 'both', label: 'Both' },
    { value: 'origin_to_dest', label: 'O → D' },
    { value: 'dest_to_origin', label: 'D → O' },
];

const ZoneFlowsModule = () => {
    const {
        clickedCanton: zoneFlowOriginCanton,
        zoneFlowDestCanton, setZoneFlowDestCanton,
    } = useSelection();
    const {
        zoneFlowDirection, setZoneFlowDirection,
        timeRange, setTimeRange,
    } = useFilters();
    const { zoneFlowData, zoneFlowLoading } = useData();

    const cantons = useMemo(
        () => Object.keys(bboxCache).sort((a, b) =>
            (cantonAlias[a] || a).localeCompare(cantonAlias[b] || b)
        ),
        []
    );

    const originLabel = zoneFlowOriginCanton ? (cantonAlias[zoneFlowOriginCanton] || zoneFlowOriginCanton) : null;
    const destLabel = zoneFlowDestCanton ? (cantonAlias[zoneFlowDestCanton] || zoneFlowDestCanton) : null;

    const sameCanton = zoneFlowOriginCanton && zoneFlowOriginCanton === zoneFlowDestCanton;
    const totalTrips = zoneFlowData?.total_trips ?? null;
    const linkCount = zoneFlowData?.links ? Object.keys(zoneFlowData.links).length : 0;

    const directionLabel =
        zoneFlowDirection === 'both' ? 'Both directions'
            : zoneFlowDirection === 'origin_to_dest' ? `${originLabel} → ${destLabel}`
                : `${destLabel} → ${originLabel}`;

    return (
        <div className="plot-container">
            {/* Origin (from map click) + Destination dropdown */}
            <div className="zf-canton-pickers">
                <div className="zf-canton-row">
                    <label>Origin</label>
                    <div className="zf-origin-display">
                        {originLabel || <span className="zf-origin-empty">Click a canton</span>}
                    </div>
                </div>
                <div className="zf-canton-row">
                    <label>Destination</label>
                    <select
                        value={zoneFlowDestCanton || ''}
                        onChange={(e) => setZoneFlowDestCanton(e.target.value || null)}
                    >
                        <option value="">— Select —</option>
                        {cantons.map(c => (
                            <option key={c} value={c}>{cantonAlias[c] || c}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Direction toggle */}
            <div className="flow-direction-toggle">
                {DIRECTION_OPTIONS.map(opt => (
                    <button
                        key={opt.value}
                        className={`flow-dir-btn${zoneFlowDirection === opt.value ? ' active' : ''}`}
                        onClick={() => setZoneFlowDirection(opt.value)}
                    >
                        {opt.label}
                    </button>
                ))}
            </div>

            {/* Time slider */}
            <div className="right-sidebar-control-row" style={{ marginBottom: 28, marginTop: 4 }}>
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

            {/* Body */}
            {!zoneFlowOriginCanton ? (
                <div className="no-selection">
                    <p>Click a canton to set the origin</p>
                    <p className="hint">Then pick a destination canton from the dropdown above.</p>
                </div>
            ) : !zoneFlowDestCanton ? (
                <div className="no-selection">
                    <p>Pick a destination canton</p>
                    <p className="hint">Trip routes between the two cantons will be highlighted on the map.</p>
                </div>
            ) : sameCanton ? (
                <div className="no-selection">
                    <p>Origin and destination are the same</p>
                    <p className="hint">Choose two different cantons to see inter-canton flows.</p>
                </div>
            ) : (
                <div className="canton-mode-share">
                    <h4>Flow Summary</h4>
                    <table>
                        <tbody>
                            <tr>
                                <td><strong>Origin</strong></td>
                                <td>{originLabel}</td>
                            </tr>
                            <tr>
                                <td><strong>Destination</strong></td>
                                <td>{destLabel}</td>
                            </tr>
                            <tr>
                                <td><strong>Direction</strong></td>
                                <td>{directionLabel}</td>
                            </tr>
                            <tr>
                                <td><strong>Total Trips</strong></td>
                                <td>
                                    {zoneFlowLoading
                                        ? '…'
                                        : totalTrips != null
                                            ? totalTrips.toLocaleString()
                                            : '—'}
                                </td>
                            </tr>
                            <tr>
                                <td><strong>Links Used</strong></td>
                                <td>{zoneFlowLoading ? '…' : linkCount.toLocaleString()}</td>
                            </tr>
                        </tbody>
                    </table>
                    {!zoneFlowLoading && totalTrips === 0 && (
                        <p className="hint" style={{ marginTop: 10 }}>
                            No trips matched these filters.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default ZoneFlowsModule;
