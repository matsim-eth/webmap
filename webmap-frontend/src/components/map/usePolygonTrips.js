import { useEffect, useRef } from 'react';
import { useModule } from '../../context/ModuleContext';
import { useMap } from '../../context/MapContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import { useSelection } from '../../context/SelectionContext';
import useDrawPolygons from '../../hooks/useDrawPolygons';
import { handle401 } from '../../utils/auth';

const polygonsToParam = (polygons) => {
    // Use the first polygon's outer ring; multi-polygon support can come later.
    const f = polygons?.[0];
    const ring = f?.geometry?.coordinates?.[0];
    if (!ring || ring.length < 3) return null;
    return ring.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
};

/**
 * Fetches /polygon_trips.json whenever the user's drawn polygon (or time
 * window) changes while the PolygonTrips module is active. Pushes results
 * into DataContext so PolygonTripsModule renders the summary table.
 */
export default function usePolygonTrips({ mapRef, mapReady }) {
    const { isGraphExpanded } = useModule();
    const { drawRef } = useMap();
    const {
        datasetId,
        setPolygonTripsData,
        setPolygonTripsLoading,
    } = useData();
    const { timeRange } = useFilters();
    const { clickedCanton } = useSelection();

    const polygons = useDrawPolygons({
        mapRef,
        drawRef,
        isGraphExpanded,
        activeModule: 'PolygonTrips',
    });

    const fetchTokenRef = useRef(0);

    // Clear drawn polygon on canton change (click or search). Sidebar data
    // clears automatically via the fetch effect below once the polygon is gone.
    // effect:audited — mirrors useTransitLayers' canton-change polygon cleanup
    useEffect(() => {
        if (isGraphExpanded !== 'PolygonTrips') return;
        const map = mapRef.current;
        if (!map) return;
        if (drawRef?.current?.getAll?.()?.features?.length > 0) {
            drawRef.current.deleteAll();
            map.fire('draw.delete', { features: [] });
        }
    }, [clickedCanton, isGraphExpanded, mapRef, drawRef]);

    useEffect(() => {
        if (!mapReady || isGraphExpanded !== 'PolygonTrips') {
            setPolygonTripsData(null);
            setPolygonTripsLoading(false);
            return;
        }

        const polygonParam = polygonsToParam(polygons);
        if (!polygonParam) {
            setPolygonTripsData(null);
            setPolygonTripsLoading(false);
            return;
        }

        const minute_start = (timeRange?.[0] ?? 0) * 15;
        const minute_end = (timeRange?.[1] ?? 96) * 15;

        const params = new URLSearchParams({
            polygon: polygonParam,
            minute_start: String(minute_start),
            minute_end: String(minute_end),
        });
        const url = `/backend/data/${datasetId}/polygon_trips.json?${params.toString()}`;

        // Debounce: vertex drags fire draw.update per pointermove. Wait until
        // the user pauses before issuing a request, and skip the loading flag
        // until then so the UI doesn't flicker mid-drag.
        const timer = setTimeout(() => {
            const token = ++fetchTokenRef.current;
            setPolygonTripsLoading(true);

            (async () => {
                try {
                    let res = await fetch(url);
                    if (res.status === 401) {
                        const refreshed = await handle401();
                        if (!refreshed) return;
                        res = await fetch(url);
                    }
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    if (token !== fetchTokenRef.current) return;
                    if (data?.error) {
                        console.warn('polygon_trips error:', data.error);
                        setPolygonTripsData({ error: data.error, by_mode: {}, totals: { outbound: 0, inbound: 0, internal: 0 }, total_trips: 0 });
                    } else {
                        setPolygonTripsData(data);
                    }
                } catch (err) {
                    if (token !== fetchTokenRef.current) return;
                    console.error('Failed to fetch polygon_trips', err);
                    setPolygonTripsData(null);
                } finally {
                    if (token === fetchTokenRef.current) setPolygonTripsLoading(false);
                }
            })();
        }, 150);

        return () => clearTimeout(timer);
    }, [mapReady, isGraphExpanded, polygons, timeRange, datasetId, setPolygonTripsData, setPolygonTripsLoading]);

    return null;
}
