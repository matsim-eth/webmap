import { useMemo, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { useData } from '../context/DataContext';
import { useSelection } from '../context/SelectionContext';
import { useFilters } from '../context/FilterContext';
import { useModule } from '../context/ModuleContext';
import { useMap } from '../context/MapContext';
import './CantonSearch.css';

const DIACRITICS = /[̀-ͯ]/g;
const normalizeString = (str) =>
    String(str || '').normalize('NFD').replace(DIACRITICS, '').toLowerCase();

const parseStopIds = (stopId) => {
    if (Array.isArray(stopId)) return stopId;
    try {
        const parsed = JSON.parse(stopId);
        if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through */ }
    return String(stopId || '').split(',').map((s) => s.trim()).filter(Boolean);
};

const parseJsonArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }
    return [];
};

// Convert LV95 (EPSG:2056) to WGS84. Swisstopo Appendix 1 formula.
const lv95ToWgs84 = (easting, northing) => {
    const y_aux = (easting - 2600000) / 1000000;
    const x_aux = (northing - 1200000) / 1000000;
    const lon = 2.6779094
        + 4.728982 * y_aux
        + 0.791484 * y_aux * x_aux
        + 0.1306 * y_aux * x_aux * x_aux
        - 0.0436 * y_aux * y_aux * y_aux;
    const lat = 16.9023892
        + 3.238272 * x_aux
        - 0.270978 * y_aux * y_aux
        - 0.002528 * x_aux * x_aux
        - 0.0447 * y_aux * y_aux * x_aux
        - 0.0140 * x_aux * x_aux * x_aux;
    return [lon * 100 / 36, lat * 100 / 36];
};

const parseLV95Coords = (input) => {
    const cleaned = input.trim().replace(/\s+/g, ' ').replace(/,/g, ' ').replace(/\t+/g, ' ');
    const parts = cleaned.split(/\s+/);
    if (parts.length !== 2) return null;
    const num1 = parseFloat(parts[0]);
    const num2 = parseFloat(parts[1]);
    if (isNaN(num1) || isNaN(num2)) return null;
    let x, y;
    if (num1 >= 2400000 && num1 <= 2900000) { x = num1; y = num2; }
    else if (num2 >= 2400000 && num2 <= 2900000) { x = num2; y = num1; }
    else return null;
    if (y < 1000000 || y > 1350000) return null;
    return { x, y };
};

const CantonSearch = ({ onSearch }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [searchMarker, setSearchMarker] = useState(null);
    const [isOpen, setIsOpen] = useState(false);

    const { featureGeoJSON, polygonStopIds, zones, zoneLabel, zoneLabelPlural } = useData();
    const {
        clickedCanton,
        setSelectedTransitStop,
        setFeatureSelection,
    } = useSelection();
    const { selectedTransitModes } = useFilters();
    const { isGraphExpanded } = useModule();
    const { mapRef } = useMap();

    // [internalName, displayName] pairs from the study-area zone list — same
    // values as the old canton_alias.json for Swiss datasets by construction.
    const cantonEntries = useMemo(
        () => zones.map((z) => [z.name, z.displayName]),
        [zones]
    );
    const displayNames = useMemo(
        () => cantonEntries.map(([, displayName]) => displayName),
        [cantonEntries]
    );

    const isTransitMode = isGraphExpanded === 'Transit';
    const hasCanton = !!clickedCanton && clickedCanton !== 'All';

    // === Build suggestion lists ===
    const { cantonSuggestions, stopSuggestions } = useMemo(() => {
        const term = searchTerm.trim();
        if (!term) return { cantonSuggestions: [], stopSuggestions: [] };

        const q = normalizeString(term);

        // --- Cantons ---
        const cStarts = [];
        const cContains = [];
        for (const name of displayNames) {
            const n = normalizeString(name);
            if (n.startsWith(q)) cStarts.push(name);
            else if (n.includes(q)) cContains.push(name);
        }
        const cantons = [
            ...cStarts.sort((a, b) => a.localeCompare(b)),
            ...cContains.sort((a, b) => a.localeCompare(b)),
        ].slice(0, 5);

        // --- Stops (only in Transit module with a canton selected) ---
        let stops = [];
        if (isTransitMode && hasCanton && featureGeoJSON?.features?.length) {
            const polygonActive = polygonStopIds && polygonStopIds.size > 0;
            const modeFilterActive =
                Array.isArray(selectedTransitModes) && !selectedTransitModes.includes('all');

            const sStarts = [];
            const sContains = [];
            for (const f of featureGeoJSON.features) {
                if (f.geometry?.type !== 'Point') continue;

                // Polygon filter
                if (polygonActive && !polygonStopIds.has(f.id)) continue;

                // Mode filter
                if (modeFilterActive) {
                    const modes = parseJsonArray(f.properties?.modes_list);
                    if (!modes.some((m) => selectedTransitModes.includes(m))) continue;
                }

                const name = f.properties?.name;
                const n = normalizeString(name);
                if (!n) continue;
                if (n.startsWith(q)) sStarts.push(f);
                else if (n.includes(q)) sContains.push(f);
            }
            const byName = (a, b) =>
                (a.properties?.name || '').localeCompare(b.properties?.name || '');
            stops = [...sStarts.sort(byName), ...sContains.sort(byName)].slice(0, 8);
        }

        return { cantonSuggestions: cantons, stopSuggestions: stops };
    }, [
        searchTerm, displayNames,
        isTransitMode, hasCanton,
        featureGeoJSON, polygonStopIds, selectedTransitModes,
    ]);

    // Flat list for unified keyboard navigation: cantons first, then stops.
    const flatSuggestions = useMemo(
        () => [
            ...cantonSuggestions.map((name) => ({ kind: 'canton', name })),
            ...stopSuggestions.map((stop) => ({ kind: 'stop', stop })),
        ],
        [cantonSuggestions, stopSuggestions]
    );

    const closeDropdown = () => {
        setIsOpen(false);
        setSelectedIndex(-1);
    };

    const clearMarker = () => {
        if (searchMarker) {
            searchMarker.remove();
            setSearchMarker(null);
        }
    };

    // === Selection handlers ===
    const handleSelectCanton = (displayName) => {
        clearMarker();
        const matched = cantonEntries.find(([, alias]) => alias === displayName);
        if (!matched) return;
        setSearchTerm('');
        onSearch(matched[0]);
        closeDropdown();
    };

    const handleSelectStop = (stop) => {
        if (!stop) return;
        clearMarker();
        const props = stop.properties || {};
        const stop_ids = parseStopIds(props.stop_id);
        const lines = parseJsonArray(props.lines);
        const modes_list = parseJsonArray(props.modes_list);
        const coords = stop.geometry?.coordinates || null;

        setSelectedTransitStop?.({
            name: props.name,
            stop_id: props.stop_id,
            stop_ids,
            lines,
            modes_list,
        });

        // Triggers transit-highlight + fitBounds via useFeatureSelectionFocus.
        setFeatureSelection?.({
            feature: stop,
            coords,
            id: stop_ids.length ? stop_ids.join('|') : String(props.stop_id ?? props.name),
        });

        setSearchTerm(props.name || '');
        closeDropdown();
    };

    const handleCoordsSearch = (input) => {
        const coords = parseLV95Coords(input);
        const map = mapRef.current;
        if (!coords || !map) return false;
        const [lon, lat] = lv95ToWgs84(coords.x, coords.y);

        clearMarker();
        const newMarker = new mapboxgl.Marker({ color: '#FF0000' })
            .setLngLat([lon, lat])
            .addTo(map);
        setSearchMarker(newMarker);

        setTimeout(() => {
            const el = newMarker.getElement();
            if (el) {
                el.style.transition = 'opacity 0.5s';
                el.style.opacity = '0';
                setTimeout(() => {
                    newMarker.remove();
                    setSearchMarker(null);
                }, 500);
            }
        }, 3000);

        map.flyTo({ center: [lon, lat], zoom: 16, duration: 1500 });
        setSearchTerm('');
        closeDropdown();
        return true;
    };

    // Submit: prefer highlighted suggestion → coords → first suggestion → exact canton match.
    const handleSearch = (override = null) => {
        if (override?.kind === 'canton') return handleSelectCanton(override.name);
        if (override?.kind === 'stop') return handleSelectStop(override.stop);

        const input = searchTerm;
        if (handleCoordsSearch(input)) return;

        if (selectedIndex >= 0 && flatSuggestions[selectedIndex]) {
            const pick = flatSuggestions[selectedIndex];
            if (pick.kind === 'canton') return handleSelectCanton(pick.name);
            return handleSelectStop(pick.stop);
        }

        // Try exact canton match
        const norm = normalizeString(input);
        const exact = cantonEntries.find(([, alias]) => normalizeString(alias) === norm);
        if (exact) return handleSelectCanton(exact[1]);

        // Fall back to first suggestion
        if (flatSuggestions.length > 0) {
            const first = flatSuggestions[0];
            if (first.kind === 'canton') return handleSelectCanton(first.name);
            return handleSelectStop(first.stop);
        }
    };

    const handleInputChange = (e) => {
        setSearchTerm(e.target.value);
        setSelectedIndex(-1);
        setIsOpen(true);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            setSearchTerm('');
            closeDropdown();
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((i) => Math.min(i + 1, flatSuggestions.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            handleSearch();
        }
    };

    const zoneLabelLower = (zoneLabel || 'Canton').toLowerCase();
    const placeholder = isTransitMode && hasCanton
        ? `Search ${zoneLabelLower} or stop...`
        : `Search ${zoneLabelLower}...`;

    return (
        <div className="canton-search">
            <input
                type="text"
                value={searchTerm}
                onChange={handleInputChange}
                onFocus={() => searchTerm.trim() !== '' && setIsOpen(true)}
                onBlur={() => setTimeout(closeDropdown, 150)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className="canton-input"
            />
            <button onClick={() => handleSearch()} className="search-button">Search</button>

            {isOpen && flatSuggestions.length > 0 && (
                <ul className="suggestions">
                    {cantonSuggestions.length > 0 && (
                        <>
                            {stopSuggestions.length > 0 && (
                                <li className="suggestion-header">{zoneLabelPlural || 'Cantons'}</li>
                            )}
                            {cantonSuggestions.map((name, idx) => {
                                const flatIdx = idx;
                                return (
                                    <li
                                        key={`c-${name}`}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            handleSelectCanton(name);
                                        }}
                                        className={
                                            'suggestion-canton' +
                                            (flatIdx === selectedIndex ? ' selected' : '')
                                        }
                                    >
                                        {name}
                                    </li>
                                );
                            })}
                        </>
                    )}
                    {stopSuggestions.length > 0 && (
                        <>
                            <li className="suggestion-header">Stops</li>
                            {stopSuggestions.map((stop, idx) => {
                                const flatIdx = cantonSuggestions.length + idx;
                                const props = stop.properties || {};
                                const modes = Array.isArray(props.modes_list)
                                    ? props.modes_list.join(', ')
                                    : '';
                                return (
                                    <li
                                        key={`s-${props.stop_id ?? idx}`}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            handleSelectStop(stop);
                                        }}
                                        className={
                                            'suggestion-stop' +
                                            (flatIdx === selectedIndex ? ' selected' : '')
                                        }
                                    >
                                        <div className="stop-name">{props.name}</div>
                                        {modes && <div className="stop-modes">{modes}</div>}
                                    </li>
                                );
                            })}
                        </>
                    )}
                </ul>
            )}
        </div>
    );
};

export default CantonSearch;
