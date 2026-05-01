import React, { useCallback } from 'react';
import { useSelection } from '../../context/SelectionContext';
import { useFilters } from '../../context/FilterContext';
import FeatureTable from '../table/FeatureTable';
import '../Table.css';
import './VolumeFlowModule.css';

const DIRECTION_OPTIONS = [
    { value: 'bothflow', label: 'Both' },
    { value: 'inflow', label: 'Inflow' },
    { value: 'outflow', label: 'Outflow' },
];

const VolumeFlowModule = ({
    isFeatureTableOpen,
    featureTableRef,
    setTableFilterQuery
}) => {
    const {
        volumeFlowSegment,
        clickedCanton,
        setFeatureSelection,
        volumeFlowSelectedLink,
        setVolumeFlowSelectedLink,
    } = useSelection();
    const { volumeFlowDirection, setVolumeFlowDirection } = useFilters();
    
    const handleRowClick = useCallback((row) => {
        if (!row) return;
        const coords = row.coords;
        const id = row.rowKey;
        const feature = row.feature;
        if (coords) {
            setFeatureSelection({ id, feature, coords });
        }
    }, [setFeatureSelection]);
    
    const handleSelectCoords = useCallback((coords, row) => {
        if (!row) return;
        handleRowClick({ ...row, coords: coords || row.coords });
    }, [handleRowClick]);
    
    const directionLabel = volumeFlowDirection === 'bothflow'
    ? 'Bidirectional'
    : volumeFlowDirection === 'inflow' ? 'Inflow' : 'Outflow';
    
    return (
        <div className="plot-container">
        {isFeatureTableOpen ? (
            <FeatureTable
            ref={featureTableRef}
            selectedGraph="VolumeFlow"
            tableId="volume-flow-table"
            rows={volumeFlowSegment?.tableRows || []}
            onRowClick={handleRowClick}
            onSelectCoords={handleSelectCoords}
            height="55vh"
            useScroller
            initialOrder={[[1, "desc"]]}
            setTableFilterQuery={setTableFilterQuery}
            />
        ) : (
            <>
            {/* Link selector — only when multiple link IDs on the clicked segment */}
            {volumeFlowSegment?.allKeys && volumeFlowSegment.allKeys.length > 1 && (() => {
                const filteredKeys = volumeFlowSegment.allKeys.filter(
                    key => !key.endsWith("_spec")
                );
                
                return (
                    <div className="link-selector">
                    <label>Link ID:</label>
                    <select
                    value={volumeFlowSelectedLink || ''}
                    onChange={(e) => setVolumeFlowSelectedLink(e.target.value || null)}
                    >
                    <option value="">
                    All ({filteredKeys.length} links)
                    </option>
                    
                    {filteredKeys.map(key => (
                        <option key={key} value={key}>
                        {key}
                        </option>
                    ))}
                    </select>
                    </div>
                );
            })()}
            
            {/* Direction toggle — always visible when canton is selected */}
            {clickedCanton && (
                <div className="flow-direction-toggle">
                {DIRECTION_OPTIONS.map(opt => (
                    <button
                    key={opt.value}
                    className={`flow-dir-btn${volumeFlowDirection === opt.value ? ' active' : ''}`}
                    onClick={() => setVolumeFlowDirection(opt.value)}
                    >
                    {opt.label}
                    </button>
                ))}
                </div>
            )}
            
            {!volumeFlowSegment && (
                <div className="no-selection">
                <p>No link selected</p>
                <p className="hint">
                {clickedCanton
                    ? 'Click on any link on the map to analyze volume flow'
                    : 'Select a canton to load the network'}
                    </p>
                    </div>
                )}
                
                {volumeFlowSegment && (
                    <div className="canton-mode-share">
                    <h4>Segment Info</h4>
                    <table>
                    <tbody>
                    <tr>
                    <td><strong>Target Link</strong></td>
                    <td>{volumeFlowSegment.targetLink}</td>
                    </tr>
                    <tr>
                    <td><strong>Total Trips</strong></td>
                    <td>{volumeFlowSegment.totalTrips.toLocaleString()}</td>
                    </tr>
                    <tr>
                    <td><strong>Daily Avg Volume</strong></td>
                    <td>{volumeFlowSegment.dailyAvgVolume} veh/day</td>
                    </tr>
                    <tr>
                    <td><strong>Direction</strong></td>
                    <td>{directionLabel}</td>
                    </tr>
                    <tr>
                    <td><strong>Modes</strong></td>
                    <td>
                    <div className="mode-badges">
                    {(volumeFlowSegment.modes || '')
                        .split(',')
                        .filter(Boolean)
                        .map(mode => (
                            <span className="mode-badge" key={mode}>{mode}</span>
                        ))}
                        </div>
                        </td>
                        </tr>
                        </tbody>
                        </table>
                        </div>
                    )}
                    </>
                )}
                </div>
            );
        };
        
        export default VolumeFlowModule;
