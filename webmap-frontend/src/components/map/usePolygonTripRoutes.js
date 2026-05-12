import { useEffect, useRef } from 'react';
import { useModule } from '../../context/ModuleContext';
import { useMap } from '../../context/MapContext';
import { useData } from '../../context/DataContext';
import { useFilters } from '../../context/FilterContext';
import useDrawPolygons from '../../hooks/useDrawPolygons';
import { handle401 } from '../../utils/auth';

const polygonsToParam = (polygons) => {
    const f = polygons?.[0];
    const ring = f?.geometry?.coordinates?.[0];
    if (!ring || ring.length < 3) return null;
    return ring.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(';');
};

/**
 * Fetches /polygon_trip_routes.json whenever the user toggles route
 * visualization on with a polygon drawn (PolygonTrips module). Mirrors
 * the debounce + token pattern from usePolygonTrips so vertex drags
 * don't trigger a fetch storm.
 */
export default function usePolygonTripRoutes({ mapRef, mapReady }) {
    const { isGraphExpanded } = useModule();
    const { drawRef } = useMap();
    const {
        datasetId,
        showPolygonRoutes,
        setPolygonRoutesData,
        setPolygonRoutesLoading,
    } = useData();
    const { timeRange } = useFilters();

    const polygons = useDrawPolygons({
        mapRef,
        drawRef,
        isGraphExpanded,
        activeModule: 'PolygonTrips',
    });

    const fetchTokenRef = useRef(0);

    useEffect(() => {
        if (!mapReady
            || isGraphExpanded !== 'PolygonTrips'
            || !showPolygonRoutes) {
            setPolygonRoutesData(null);
            setPolygonRoutesLoading(false);
            return;
        }

        const polygonParam = polygonsToParam(polygons);
        if (!polygonParam) {
            setPolygonRoutesData(null);
            setPolygonRoutesLoading(false);
            return;
        }

        const minute_start = (timeRange?.[0] ?? 0) * 15;
        const minute_end = (timeRange?.[1] ?? 96) * 15;

        const params = new URLSearchParams({
            polygon: polygonParam,
            minute_start: String(minute_start),
            minute_end: String(minute_end),
        });
        const url = `/backend/data/${datasetId}/polygon_trip_routes.json?${params.toString()}`;

        const timer = setTimeout(() => {
            const token = ++fetchTokenRef.current;
            setPolygonRoutesLoading(true);

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
                        console.warn('polygon_trip_routes error:', data.error);
                        setPolygonRoutesData({
                            error: data.error,
                            routes_by_category: { outbound: {}, inbound: {}, internal: {} },
                            category_totals: { outbound: 0, inbound: 0, internal: 0 },
                            total_car_trips: 0,
                        });
                    } else {
                        setPolygonRoutesData(data);
                    }
                } catch (err) {
                    if (token !== fetchTokenRef.current) return;
                    console.error('Failed to fetch polygon_trip_routes', err);
                    setPolygonRoutesData(null);
                } finally {
                    if (token === fetchTokenRef.current) setPolygonRoutesLoading(false);
                }
            })();
        }, 200);

        return () => clearTimeout(timer);
    }, [mapReady, isGraphExpanded, showPolygonRoutes, polygons, timeRange, datasetId,
        setPolygonRoutesData, setPolygonRoutesLoading]);

    return null;
}
