import React, { useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import FeatureTable from '../table/FeatureTable';
import '../Table.css';
import './VolumeFlowModule.css';

const VolumeFlowModule = ({
    isFeatureTableOpen,
    featureTableRef,
    setTableFilterQuery
}) => {
    const { volumeFlowSegment, clickedCanton, setFeatureSelection } = useApp();

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
                                        <td>Bidirectional</td>
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
