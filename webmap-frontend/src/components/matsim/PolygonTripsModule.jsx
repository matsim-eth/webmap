import React, { useMemo } from 'react';
import Slider from 'rc-slider';
import 'rc-slider/assets/index.css';
import PolygonTripsTable from './PolygonTripsTable';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { useMap } from '../../context/MapContext';
import useDrawPolygons from '../../hooks/useDrawPolygons';
import { useModule } from '../../context/ModuleContext';
import { marks, formatTimeLabel } from '../../utils/timeSliderUtils';
import './PolygonTripsModule.css';

const POLYGON_TRIPS_COLUMNS = [
    { key: 'mode', title: 'Mode', numeric: false },
    { key: 'internal', title: 'Internal', numeric: true },
    { key: 'outbound', title: 'Outbound', numeric: true },
    { key: 'inbound', title: 'Inbound', numeric: true },
    { key: 'total', title: 'Total', numeric: true },
];

const ROUTE_CATEGORY_OPTIONS = [
    { value: 'internal', label: 'Internal' },
    { value: 'outbound', label: 'Outbound' },
    { value: 'inbound', label: 'Inbound' },
];

const MODE_ORDER = ['car', 'pt', 'walk', 'bike', 'car_passenger', 'truck'];

const orderModes = (modes) => {
    const known = MODE_ORDER.filter((m) => modes.includes(m));
    const extra = modes.filter((m) => !MODE_ORDER.includes(m)).sort();
    return [...known, ...extra];
};

const PolygonTripsModule = ({ featureTableRef }) => {
    const {
        polygonTripsData, polygonTripsLoading,
        showPolygonRoutes, setShowPolygonRoutes,
        polygonRoutesData, polygonRoutesLoading,
    } = useData();
    const {
        timeRange, setTimeRange,
        polygonRoutesCategory, setPolygonRoutesCategory,
    } = useFilters();
    const { mapRef, drawRef } = useMap();
    const { isGraphExpanded } = useModule();

    const polygons = useDrawPolygons({
        mapRef,
        drawRef,
        isGraphExpanded,
        activeModule: 'PolygonTrips',
    });
    const hasPolygon = polygons.length > 0;

    const modes = useMemo(() => {
        if (!polygonTripsData?.by_mode) return [];
        return orderModes(Object.keys(polygonTripsData.by_mode));
    }, [polygonTripsData]);

    const totals = polygonTripsData?.totals || { outbound: 0, inbound: 0, internal: 0 };

    const tableRows = useMemo(() => {
        if (!polygonTripsData?.by_mode) return [];
        return modes.map((mode) => {
            const r = polygonTripsData.by_mode[mode];
            return {
                rowKey: `polygon-trips-${mode}`,
                mode: mode.replace('_', ' '),
                outbound: r.outbound,
                inbound: r.inbound,
                internal: r.internal,
                total: r.outbound + r.inbound + r.internal,
            };
        });
    }, [polygonTripsData, modes]);

    return (
        <div className="plot-container">
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

            {!hasPolygon ? (
                <div className="pt-no-polygon">
                    <p>Draw a polygon to summarise trips.</p>
                    <p className="hint">Use the “New Polygon” button above, then click on the map to place vertices. Double-click to finish.</p>
                </div>
            ) : (
                <>
                    <div className="pt-routes-toggle">
                        <label>
                            <input
                                type="checkbox"
                                checked={showPolygonRoutes}
                                onChange={(e) => setShowPolygonRoutes(e.target.checked)}
                            />
                            Show trip routes on map
                            {showPolygonRoutes && polygonRoutesLoading && <span> · loading…</span>}
                        </label>
                        <span className="pt-routes-note">car only</span>
                    </div>

                    {showPolygonRoutes && (
                        <div className="pt-direction-toggle">
                            {ROUTE_CATEGORY_OPTIONS.map((opt) => {
                                const count = polygonRoutesData?.category_totals?.[opt.value];
                                return (
                                    <button
                                        key={opt.value}
                                        className={`pt-direction-btn${polygonRoutesCategory === opt.value ? ' active' : ''}`}
                                        onClick={() => setPolygonRoutesCategory(opt.value)}
                                    >
                                        {opt.label}
                                        {count != null ? ` (${count.toLocaleString()})` : ''}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <div className="pt-totals-card">
                        <div className="pt-total-cell">
                            <span className="pt-total-label">Internal</span>
                            <span className="pt-total-value">
                                {polygonTripsLoading ? '…' : totals.internal.toLocaleString()}
                            </span>
                        </div>
                        <div className="pt-total-cell">
                            <span className="pt-total-label">Outbound</span>
                            <span className="pt-total-value">
                                {polygonTripsLoading ? '…' : totals.outbound.toLocaleString()}
                            </span>
                        </div>
                        <div className="pt-total-cell">
                            <span className="pt-total-label">Inbound</span>
                            <span className="pt-total-value">
                                {polygonTripsLoading ? '…' : totals.inbound.toLocaleString()}
                            </span>
                        </div>
                    </div>

                    <PolygonTripsTable
                        ref={featureTableRef}
                        tableId="polygon-trips-table"
                        columns={POLYGON_TRIPS_COLUMNS}
                        rows={tableRows}
                        loading={polygonTripsLoading}
                    />

                    {!polygonTripsLoading && polygonTripsData?.total_trips === 0 && (
                        <p className="pt-no-polygon hint" style={{ marginTop: 10 }}>
                            No trips intersect this polygon for the selected time window.
                        </p>
                    )}
                </>
            )}
        </div>
    );
};

export default PolygonTripsModule;
