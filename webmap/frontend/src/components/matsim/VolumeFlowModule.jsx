import React, { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import { updateFlowVisualization } from '../map/useVolumeFlowLayers';
import './VolumeFlowModule.css';

const VolumeFlowModule = () => {
    const { volumeFlowSegment, mapRef } = useApp();
    const [selectedDirection, setSelectedDirection] = useState('outflow');

    // Always use link 1451949
    const selectedLink = '1451949';

    // Update map when direction changes
    useEffect(() => {
        if (volumeFlowSegment && mapRef) {
            updateFlowVisualization(mapRef, selectedLink, selectedDirection);
        }
    }, [selectedDirection, volumeFlowSegment, mapRef]);

    return (
        <div className="volume-flow-module">
            <h3>Volume Flow Analysis</h3>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '20px' }}>
                {/* Flow Direction Toggle */}
                <div style={{ display: "flex", alignItems: "center", minWidth: 180, marginRight: '20px' }}>
                    <span style={{ marginRight: '8px', fontWeight: selectedDirection === 'outflow' ? 'bold' : 'normal', fontSize: '0.9em' }}>Outflow</span>
                    <label
                        className="switch"
                        style={{
                            display: 'inline-block',
                            position: 'relative',
                            width: '40px',
                            height: '20px',
                            margin: '0px 8px',
                        }}
                    >
                        <input
                            type="checkbox"
                            checked={selectedDirection === 'inflow'}
                            onChange={() => setSelectedDirection(prev => prev === 'outflow' ? 'inflow' : 'outflow')}
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
                                backgroundColor: '#43a047',
                                borderRadius: '20px',
                                transition: '.4s',
                            }}
                        />
                        <span
                            style={{
                                position: 'absolute',
                                left: selectedDirection === 'outflow' ? '2px' : '22px',
                                top: '2px',
                                width: '16px',
                                height: '16px',
                                backgroundColor: '#fff',
                                borderRadius: '50%',
                                transition: '.4s',
                            }}
                        />
                    </label>
                    <span style={{ fontWeight: selectedDirection === 'inflow' ? 'bold' : 'normal', fontSize: '0.9em' }}>Inflow</span>
                </div>

                <p className="module-description" style={{ margin: 0, fontSize: '0.9em', lineHeight: '1.4' }}>
                    Click the <span className="target-indicator">blue target link</span> to analyze flows.
                    <br />
                    <span style={{ fontSize: '0.9em', fontStyle: 'italic', color: '#888' }}>
                        (The data is purely for demonstration purposes<br />and is not accurate)
                    </span>
                </p>
            </div>

            {!volumeFlowSegment ? (
                <div className="no-selection">
                    <p>No link selected</p>
                    <p className="hint">Click on the blue target link on the map</p>
                </div>
            ) : (
                <div className="segment-details">
                    {/* Removed old selector-row */}

                    <div className="segment-header">
                        <span className="total-label">Link {selectedLink}</span>
                        <span className="total-value">
                            {selectedDirection === 'outflow' ? '↑ Outflow' : '↓ Inflow'}
                        </span>
                    </div>

                    <h4>Target Link Details</h4>
                    <table className="links-table">
                        <thead>
                            <tr>
                                <th>Link ID</th>
                                <th>Volume (veh/day)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {volumeFlowSegment.links
                                .filter(link => link.baseId === selectedLink || link.baseId.startsWith(selectedLink))
                                .map((link, i) => (
                                    <tr key={i}>
                                        <td className="volume">
                                            {link.baseId}
                                        </td>
                                        <td className="volume">{link.volume.toLocaleString()}</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export default VolumeFlowModule;
