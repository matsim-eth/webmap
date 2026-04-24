import React, { useMemo } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import { useApp } from '../../context/AppContext';
import { marks, formatTimeLabel } from '../../utils/timeSliderUtils';
import './NodeFlowsModule.css';

// Lighten a hex color for badge backgrounds (mix with white at given ratio)
const lighten = (hex, ratio = 0) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const lr = Math.round(r + (255 - r) * ratio);
    const lg = Math.round(g + (255 - g) * ratio);
    const lb = Math.round(b + (255 - b) * ratio);
    return `rgb(${lr}, ${lg}, ${lb})`;
};

// Color scale for matrix cells (white → deep purple)
const cellColor = (value, max) => {
    if (!value || !max) return 'transparent';
    const t = Math.min(value / max, 1);
    const r = Math.round(255 - t * 130);
    const g = Math.round(255 - t * 200);
    const b = Math.round(255 - t * 50);
    return `rgb(${r}, ${g}, ${b})`;
};

// White text when cell is dark enough
const cellTextColor = (value, max) => {
    if (!value || !max) return 'inherit';
    const t = Math.min(value / max, 1);
    return t > 0.45 ? '#fff' : 'inherit';
};

const NodeFlowsModule = () => {
    const {
        nodeFlowsData, clickedCanton, hoveredMatrixCell, setHoveredMatrixCell,
        timeRange, setTimeRange,
    } = useApp();

    const timeSlider = (
        <div className="right-sidebar-control-row" style={{ marginBottom: 28 }}>
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
    );

    // Compute max flow for color scaling
    const maxFlow = useMemo(() => {
        if (!nodeFlowsData?.matrix) return 0;
        let max = 0;
        const { matrix, entering_links, exiting_links } = nodeFlowsData;
        for (const e of entering_links) {
            const row = matrix[e.linkId];
            if (!row) continue;
            for (const x of exiting_links) {
                const v = row[x.linkId] || 0;
                if (v > max) max = v;
            }
        }
        return max;
    }, [nodeFlowsData]);

    if (!clickedCanton) {
        return (
            <div className="plot-container">
                {timeSlider}
                <div className="nf-no-selection">
                    <p>No canton selected</p>
                    <p className="nf-hint">Select a canton to load the network</p>
                </div>
            </div>
        );
    }

    if (!nodeFlowsData) {
        return (
            <div className="plot-container">
                {timeSlider}
                <div className="nf-no-selection">
                    <p>No node selected</p>
                </div>
            </div>
        );
    }

    const { node_id, total_movements, entering_links, exiting_links, matrix, linkColors = {} } = nodeFlowsData;

    return (
        <div className="plot-container">
            {timeSlider}
            {/* Summary */}
            <div className="nf-summary">
                <h4>Intersection Info</h4>
                <table className="nf-info-table">
                    <tbody>
                        <tr>
                            <td><strong>Node ID</strong></td>
                            <td>{node_id}</td>
                        </tr>
                        <tr>
                            <td><strong>Total Movements</strong></td>
                            <td>{total_movements.toLocaleString()}</td>
                        </tr>
                        <tr>
                            <td><strong>Entering Arms</strong></td>
                            <td>{entering_links.length}</td>
                        </tr>
                        <tr>
                            <td><strong>Exiting Arms</strong></td>
                            <td>{exiting_links.length}</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            {/* Turning Movement Matrix */}
            {entering_links.length > 0 && exiting_links.length > 0 && (
                <div className="nf-matrix-section">
                    <h4>Turning Movement Matrix</h4>
                    <p className="nf-matrix-hint">Rows = entering, Columns = exiting</p>
                    <div className="nf-matrix-scroll">
                        <table className="nf-matrix">
                            <thead>
                                <tr>
                                    <th className="nf-matrix-corner">From \ To</th>
                                    {exiting_links.map(x => {
                                        const color = linkColors[x.linkId];
                                        return (
                                            <th key={x.linkId} className="nf-matrix-col-header" title={`Link ${x.linkId}`}>
                                                <span className="nf-link-badge" style={color ? { background: color, color: '#fff' } : {}}>{x.linkId}</span>
                                            </th>
                                        );
                                    })}
                                    <th className="nf-matrix-total-header">Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entering_links.map(e => {
                                    const row = matrix[e.linkId] || {};
                                    const rowTotal = exiting_links.reduce((s, x) => s + (row[x.linkId] || 0), 0);
                                    return (
                                        <tr key={e.linkId}>
                                            <td className="nf-matrix-row-header" title={`Link ${e.linkId}`}>
                                                <span className="nf-link-badge" style={linkColors[e.linkId] ? { background: linkColors[e.linkId], color: '#fff' } : {}}>{e.linkId}</span>
                                            </td>
                                            {exiting_links.map(x => {
                                                const val = row[x.linkId] || 0;
                                                const isHovered = hoveredMatrixCell?.from === e.linkId && hoveredMatrixCell?.to === x.linkId;
                                                return (
                                                    <td
                                                        key={x.linkId}
                                                        className={`nf-matrix-cell ${isHovered ? 'hovered' : ''}`}
                                                        style={{ backgroundColor: cellColor(val, maxFlow), color: cellTextColor(val, maxFlow) }}
                                                        onMouseEnter={() => setHoveredMatrixCell({ from: e.linkId, to: x.linkId })}
                                                        onMouseLeave={() => setHoveredMatrixCell(null)}
                                                        title={`${e.linkId} → ${x.linkId}: ${val}`}
                                                    >
                                                        {val > 0 ? val : ''}
                                                    </td>
                                                );
                                            })}
                                            <td className="nf-matrix-total">{rowTotal}</td>
                                        </tr>
                                    );
                                })}
                                {/* Column totals */}
                                <tr className="nf-matrix-totals-row">
                                    <td className="nf-matrix-row-header"><strong>Total</strong></td>
                                    {exiting_links.map(x => {
                                        const colTotal = entering_links.reduce((s, e) => {
                                            const row = matrix[e.linkId] || {};
                                            return s + (row[x.linkId] || 0);
                                        }, 0);
                                        return <td key={x.linkId} className="nf-matrix-total">{colTotal}</td>;
                                    })}
                                    <td className="nf-matrix-grand-total">{total_movements}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Link details */}
            <div className="nf-links-section">
                <div className="nf-links-columns">
                    <div className="nf-links-col">
                        <h5 className="nf-entering-title">Entering</h5>
                        {entering_links.map(e => (
                            <div key={e.linkId} className="nf-link-row">
                                <span className="nf-link-badge" style={linkColors[e.linkId] ? { background: linkColors[e.linkId], color: '#fff' } : {}}>{e.linkId}</span>
                                <span className="nf-link-flow">{e.flow}</span>
                            </div>
                        ))}
                    </div>
                    <div className="nf-links-col">
                        <h5 className="nf-exiting-title">Exiting</h5>
                        {exiting_links.map(x => (
                            <div key={x.linkId} className="nf-link-row">
                                <span className="nf-link-badge" style={linkColors[x.linkId] ? { background: linkColors[x.linkId], color: '#fff' } : {}}>{x.linkId}</span>
                                <span className="nf-link-flow">{x.flow}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NodeFlowsModule;
