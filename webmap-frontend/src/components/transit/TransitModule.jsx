import React, {useState, useCallback, useRef, useMemo} from "react";
import TransitStopAttributesTable from "./TransitStopAttributesTable";
import TransitStopHistogram from "./TransitStopHistogram";
import FeatureTable from "../table/FeatureTable";
import { marks, formatTimeLabel } from "../../utils/timeSliderUtils";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import { useLoadWithFallback } from "../../utils/useLoadWithFallback";
import { useQuery } from "@tanstack/react-query";
import { filterRoutesByDirection } from "../../utils/directionUtils";
import usePointPolygon from "../../hooks/usePointPolygon";
import { useData } from "../../context/DataContext";
import { useFilters } from "../../context/FilterContext";
import { useSelection } from "../../context/SelectionContext";
import { useChoropleth } from "../../context/ChoroplethContext";
import { useModule } from "../../context/ModuleContext";
import { useMap } from "../../context/MapContext";
import { useFileContext } from "../../FileContext";


const TransitModule = ({ featureTableRef }) => {
    const { dataURL, isFeatureTableOpen, featureGeoJSON, setTableFilterQuery, setPolygonStopIds } = useData();
    const {
        selectedTransitModes, setSelectedTransitModes,
        showStopVolumeSymbology, setShowStopVolumeSymbology,
        timeRange, setTimeRange,
        selectedDirection, setSelectedDirection,
    } = useFilters();
    const {
        clickedCanton: canton,
        selectedTransitStop, setSelectedTransitStop,
        setFeatureSelection,
    } = useSelection();
    const {
        highlightedLineId, setHighlightedLineId,
        setHighlightedRouteIds,
    } = useChoropleth();
    const { isGraphExpanded } = useModule();
    const { mapRef, drawRef } = useMap();
    const { fileMap } = useFileContext();

    const [filteredStopVolumes, setFilteredStopVolumes] = useState(null); // total filtered volumes per stop
    const [polygonFilteredVolumes, setPolygonFilteredVolumes] = useState(null);
    const loadWithFallback = useLoadWithFallback(dataURL);

    // Per-canton transit mode list — drives the multi-select dropdown.
    const { data: transitModesByCanton = {} } = useQuery({
        queryKey: ['transit-modes-by-canton', dataURL, fileMap.size],
        queryFn: () => loadWithFallback("matsim/transit/transit_modes_by_canton.json"),
    });
    const availableTransitModes = useMemo(() => {
        if (canton && transitModesByCanton[canton]) return transitModesByCanton[canton];
        return [];
    }, [canton, transitModesByCanton]);

    // Polygon selection: aggregate stops within drawn polygons
    const handlePolygonChange = useCallback(() => {
        setSelectedTransitStop?.(null);
        setHighlightedLineId?.(null);
        setHighlightedRouteIds?.([]);
        setPolygonFilteredVolumes(null);
    }, [setSelectedTransitStop, setHighlightedLineId, setHighlightedRouteIds]);

    const { polygonSelection, polygonFeatures } = usePointPolygon({
        mapRef,
        drawRef,
        featureGeoJSON,
        isGraphExpanded,
        selectedTransitModes,
        onPolygonChange: handlePolygonChange,
    });

    // Publish polygon-contained stop IDs so the global search bar can
    // exclude stops outside the polygon. null = no polygon active.
    const prevPolyFeaturesRef = useRef(polygonFeatures);
    if (prevPolyFeaturesRef.current !== polygonFeatures) {
        prevPolyFeaturesRef.current = polygonFeatures;
        setPolygonStopIds?.(
            polygonFeatures.length === 0
                ? null
                : new Set(polygonFeatures.map((f) => f.id))
        );
    }

    // Filtered GeoJSON for table — only polygon-selected features when polygon is active
    const tableGeoJSON = useMemo(() => {
        if (!polygonFeatures.length || !isFeatureTableOpen) return featureGeoJSON;
        return { type: 'FeatureCollection', features: polygonFeatures };
    }, [polygonFeatures, featureGeoJSON, isFeatureTableOpen]);

    // Clear selection when table opens, restore when it closes (was useEffect)
    const prevTableOpenRef = useRef(isFeatureTableOpen);
    if (prevTableOpenRef.current !== isFeatureTableOpen) {
        prevTableOpenRef.current = isFeatureTableOpen;
        if (isFeatureTableOpen) {
            setSelectedTransitStop?.(null);
            setHighlightedLineId?.(null);
            setHighlightedRouteIds?.([]);
        } else {
            setTableFilterQuery?.(null);
        }
    }

    // Handle row selection in table
    const handleTableRowSelect = useCallback(
        (row) => {
            if (!row) return;

            const featureProps = row.featureProps || row.feature?.properties;
            if (featureProps) {
                // Parse stop data
                const stopId = featureProps.stop_id;
                let allStopIds = [];
                if (Array.isArray(stopId)) {
                    allStopIds = stopId;
                } else {
                    try {
                        allStopIds = JSON.parse(stopId);
                    } catch {
                        allStopIds = String(stopId).split(",").map(id => id.trim());
                    }
                }

                // Parse lines
                let combinedLines = [];
                if (Array.isArray(featureProps.lines)) {
                    combinedLines = featureProps.lines;
                } else if (typeof featureProps.lines === 'string') {
                    try {
                        combinedLines = JSON.parse(featureProps.lines);
                    } catch {
                        combinedLines = [];
                    }
                }

                // Parse modes
                let combinedModes = [];
                if (Array.isArray(featureProps.modes_list)) {
                    combinedModes = featureProps.modes_list;
                } else if (typeof featureProps.modes_list === 'string') {
                    try {
                        combinedModes = JSON.parse(featureProps.modes_list);
                    } catch {
                        combinedModes = [];
                    }
                }

                // Update selected transit stop
                const updatedStop = {
                    name: featureProps.name,
                    stop_id: stopId,
                    stop_ids: allStopIds,
                    lines: combinedLines,
                    modes_list: combinedModes,
                    boardings: featureProps.boardings || 0,
                    alightings: featureProps.alightings || 0,
                    total: (featureProps.boardings || 0) + (featureProps.alightings || 0),
                    feature: row.feature,
                    coords: row.coords
                };
                setSelectedTransitStop?.(updatedStop);

                // Reset highlighted line and routes
                setHighlightedLineId?.(null);
                setHighlightedRouteIds?.([]);

                // Create highlight and zoom on map
                if (setFeatureSelection && row.feature && row.coords) {
                    setFeatureSelection({
                        feature: row.feature,
                        coords: row.coords,
                        id: row.rowKey
                    });
                }
            }
        },
        [setFeatureSelection, setSelectedTransitStop, setHighlightedLineId, setHighlightedRouteIds]
    );

    const handleSelectCoords = useCallback(
        (coords, row) => {
            if (!row) return;
            handleTableRowSelect({ ...row, coords: coords || row.coords });
        },
        [handleTableRowSelect]
    );

    // If a new line is selected and its mode is not in the filter, reset to "all" (was useEffect).
    // The line's mode comes from the selected stop's `lines` (each carries `mode`),
    // so there's no need to load the full transit_routes asset here.
    const prevHighlightedLineRef = useRef(highlightedLineId);
    if (prevHighlightedLineRef.current !== highlightedLineId) {
        prevHighlightedLineRef.current = highlightedLineId;
        if (highlightedLineId && Array.isArray(selectedTransitModes) && !selectedTransitModes.includes("all")) {
            const activeLines = polygonSelection?.lines ?? selectedTransitStop?.lines;
            const match = Array.isArray(activeLines)
                ? activeLines.find((l) => String(l?.line_id) === String(highlightedLineId))
                : null;
            const mode = match?.mode && String(match.mode);
            if (mode && !selectedTransitModes.includes(mode)) {
                setSelectedTransitModes(["all"]);
            }
        }
    }

    // Re-filter highlighted route IDs when direction changes while a line is selected
    const prevDirectionRef = useRef(selectedDirection);
    if (prevDirectionRef.current !== selectedDirection) {
        prevDirectionRef.current = selectedDirection;
        const activeLines = polygonSelection?.lines ?? selectedTransitStop?.lines;
        if (highlightedLineId && activeLines) {
            const allLines = Array.isArray(activeLines) ? activeLines : [];
            const routeIds = allLines
                .filter(l => String(l?.line_id) === String(highlightedLineId))
                .map(l => l.route_id);
            setHighlightedRouteIds(filterRoutesByDirection(routeIds, selectedDirection));
        }
    }

    // Push to Map the selected transit stop mode filter
    const handleTransitModeChange = (event) => {
        const selectedOptions = Array.from(event.target.selectedOptions).map((option) => option.value);
        if (selectedOptions.includes("all") || selectedOptions.length === 0) {
            setSelectedTransitModes(["all"]);
        } else {
            setSelectedTransitModes(selectedOptions);
        }
    };

    return(
        <div style={{ overflowY: "auto", overflowX: "hidden", width: "100%" }}>

        {isFeatureTableOpen ? (
            <FeatureTable
                ref={featureTableRef}
                tableId="transit-stops-feature-table"
                geojson={tableGeoJSON}
                selectedGraph="Transit"
                selectedModes={selectedTransitModes}
                onRowClick={handleTableRowSelect}
                onSelectCoords={handleSelectCoords}
                height={"55vh"}
                useScroller
                pageLength={25}
                loading={!featureGeoJSON}
                setTableFilterQuery={setTableFilterQuery}
            />
        ) : (
            <>
            <div className="mode-filter-container">
        <label className="mode-filter-label">Filter by Mode:</label>
        <select
        multiple
        value={selectedTransitModes}
        onChange={handleTransitModeChange}
        className="mode-filter-select"
        >
        <option value="all">All</option>
        {availableTransitModes.map((mode) => (
            <option key={mode} value={mode}>
            {mode.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
            </option>
        ))}
        </select>


        {/* Time Range + Checkbox Row */}
        <div className="right-sidebar-control-row">

        {/* Slider and label */}
        <div style={{ flex: 1 }}>
        <label className="right-sidebar-label" style={{ marginLeft: "7%" }}>
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

        {/* Checkbox */}
        <label className="right-sidebar-checkbox">
        <input
        type="checkbox"
        checked={showStopVolumeSymbology}
        onChange={(e) => setShowStopVolumeSymbology(e.target.checked)}
        />
        Show stop volumes
        </label>

        </div>

        </div>
        </>
        )}

        {/* Histogram and attributes - only show when not in table view */}
        {selectedTransitStop && !isFeatureTableOpen && !polygonSelection && (
            <>
            <TransitStopAttributesTable
            properties={{
                ...selectedTransitStop,
                ...(filteredStopVolumes ?? {})
            }}
            highlightedLineId={highlightedLineId}
            onLineClick={(lineId) => {
                if (lineId) {
                  // Determine mode of the clicked line from the current stop's lines
                  const allLines = Array.isArray(selectedTransitStop?.lines) ? selectedTransitStop.lines : [];
                  const match = allLines.find(l => String(l?.line_id) === String(lineId));
                  const mode = match?.mode && String(match.mode);
                  if (mode && Array.isArray(selectedTransitModes) && !selectedTransitModes.includes('all') && !selectedTransitModes.includes(mode)) {
                    // Reset filter to all first so the line will be visible
                    setSelectedTransitModes(['all']);
                  }
                }
                setHighlightedLineId(lineId);
                setHighlightedRouteIds(lineId ? [lineId] : []);
            }}
            selectedDirection={selectedDirection}
            setSelectedDirection={setSelectedDirection}
            />

            <TransitStopHistogram
            stopIds={selectedTransitStop.stop_ids}
            canton={canton}
            lineId={highlightedLineId}
            onVolumeUpdate={setFilteredStopVolumes}
            timeRange={timeRange}
            selectedDirection={selectedDirection}
            stopLines={selectedTransitStop.lines}
            />
            </>
        )}

        {/* Polygon aggregate view */}
        {polygonSelection && !isFeatureTableOpen && (
            <>
            <TransitStopAttributesTable
            properties={{
                ...polygonSelection,
                ...(polygonFilteredVolumes ?? {})
            }}
            highlightedLineId={highlightedLineId}
            onLineClick={(lineId) => {
                if (lineId) {
                  const allLines = Array.isArray(polygonSelection?.lines) ? polygonSelection.lines : [];
                  const match = allLines.find(l => String(l?.line_id) === String(lineId));
                  const mode = match?.mode && String(match.mode);
                  if (mode && Array.isArray(selectedTransitModes) && !selectedTransitModes.includes('all') && !selectedTransitModes.includes(mode)) {
                    setSelectedTransitModes(['all']);
                  }
                }
                setHighlightedLineId(lineId);
                setHighlightedRouteIds(lineId ? [lineId] : []);
            }}
            selectedDirection={selectedDirection}
            setSelectedDirection={setSelectedDirection}
            />

            <TransitStopHistogram
            stopIds={polygonSelection.stop_ids}
            canton={canton}
            lineId={highlightedLineId}
            onVolumeUpdate={setPolygonFilteredVolumes}
            timeRange={timeRange}
            selectedDirection={selectedDirection}
            stopLines={polygonSelection.lines}
            />
            </>
        )}
        </div>
    );
}

export default TransitModule;
