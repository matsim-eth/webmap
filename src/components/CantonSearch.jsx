import { useState } from 'react';
import mapboxgl from 'mapbox-gl';
import cantonAlias from '../utils/canton_alias.json'; // adjust path as needed
import './CantonSearch.css';

const CantonSearch = ({ onSearch, map }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [filteredCantons, setFilteredCantons] = useState([]);
    const [selectedIndex, setSelectedIndex] = useState(-1);
    const [searchMarker, setSearchMarker] = useState(null);

    // Convert alias JSON to an array of [cleanName, displayName]
    const cantonEntries = Object.entries(cantonAlias);
    const displayNames = cantonEntries.map(([_, displayName]) => displayName);

    const normalizeString = (str) => {
        return str
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase();
    };

    // Convert LV95 (EPSG:2056) to WGS84 (lon, lat)
    // Based on official Swiss transformation formulas (Appendix 1, swisstopo)
    const lv95ToWgs84 = (easting, northing) => {
        // Convert to auxiliary values (in units of 1000 km from false origin)
        const y_aux = (easting - 2600000) / 1000000;
        const x_aux = (northing - 1200000) / 1000000;
        
        // Calculate longitude (λ) - result is in decimal degrees
        const lon = 2.6779094 
            + 4.728982 * y_aux 
            + 0.791484 * y_aux * x_aux 
            + 0.1306 * y_aux * x_aux * x_aux 
            - 0.0436 * y_aux * y_aux * y_aux;
        
        // Calculate latitude (φ) - result is in decimal degrees  
        const lat = 16.9023892 
            + 3.238272 * x_aux 
            - 0.270978 * y_aux * y_aux 
            - 0.002528 * x_aux * x_aux 
            - 0.0447 * y_aux * y_aux * x_aux 
            - 0.0140 * x_aux * x_aux * x_aux;
        
        // Convert from centesimal arc seconds to decimal degrees
        const longitude = lon * 100 / 36;
        const latitude = lat * 100 / 36;
        
        return [longitude, latitude];
    };

    // Check if input looks like LV95 coordinates
    const parseLV95Coords = (input) => {
        // Remove extra whitespace and common separators
        const cleaned = input.trim().replace(/\s+/g, ' ').replace(/,/g, ' ').replace(/\t+/g, ' ');
        const parts = cleaned.split(/\s+/);
        
        if (parts.length !== 2) return null;
        
        const num1 = parseFloat(parts[0]);
        const num2 = parseFloat(parts[1]);
        
        if (isNaN(num1) || isNaN(num2)) return null;
        
        // Switzerland LV95 bounds: X ~2,485,000-2,834,000, Y ~1,075,000-1,296,000
        // Determine which is X and which is Y based on ranges
        let x, y;
        if (num1 >= 2400000 && num1 <= 2900000) {
            x = num1;
            y = num2;
        } else if (num2 >= 2400000 && num2 <= 2900000) {
            x = num2;
            y = num1;
        } else {
            return null; // Neither number is in valid X range
        }
        
        // Validate Y coordinate
        if (y < 1000000 || y > 1350000) return null;
        
        return { x, y };
    };

    const handleSearch = (displayName = null) => {
        const inputText = displayName || searchTerm;
        
        // Try to parse as LV95 coordinates first
        const coords = parseLV95Coords(inputText);
        if (coords && map) {
            const [lon, lat] = lv95ToWgs84(coords.x, coords.y);
            
            // Remove existing marker if any
            if (searchMarker) {
                searchMarker.remove();
            }
            
            // Create a new marker at the coordinate location
            const newMarker = new mapboxgl.Marker({ color: '#FF0000' })
                .setLngLat([lon, lat])
                .addTo(map);
            
            setSearchMarker(newMarker);
            
            map.flyTo({
                center: [lon, lat],
                zoom: 14,
                duration: 1500
            });
            setSearchTerm('');
            setFilteredCantons([]);
            setSelectedIndex(-1);
            return;
        }
        
        // Otherwise, search for canton name
        // Remove marker when searching for canton
        if (searchMarker) {
            searchMarker.remove();
            setSearchMarker(null);
        }
        
        const normalizedSearch = normalizeString(inputText);

        let matched = cantonEntries.find(
            ([_, alias]) => normalizeString(alias) === normalizedSearch
        );

        // Fallback to first suggestion
        if (!matched && filteredCantons.length > 0) {
            const fallback = filteredCantons[0];
            matched = cantonEntries.find(([_, alias]) => alias === fallback);
        }

        if (matched) {
            setSearchTerm('');
            onSearch(matched[0]); // return clean name
            setFilteredCantons([]);
            setSelectedIndex(-1);
        }
    };

    const handleInputChange = (e) => {
        const input = e.target.value;
        setSearchTerm(input);
        setSelectedIndex(-1);

        if (input.trim() === '') {
            setFilteredCantons([]);
            return;
        }

        const normalizedInput = normalizeString(input);
        const startsWithMatches = [];
        const containsMatches = [];

        displayNames.forEach(displayName => {
            const normalized = normalizeString(displayName);
            if (normalized.startsWith(normalizedInput)) {
                startsWithMatches.push(displayName);
            } else if (normalized.includes(normalizedInput)) {
                containsMatches.push(displayName);
            }
        });

        const suggestions = [
            ...startsWithMatches.sort((a, b) => a.localeCompare(b)),
            ...containsMatches.sort((a, b) => a.localeCompare(b))
        ].slice(0, 5);

        setFilteredCantons(suggestions);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            setSelectedIndex((prev) => Math.min(prev + 1, filteredCantons.length - 1));
        } else if (e.key === 'ArrowUp') {
            setSelectedIndex((prev) => Math.max(prev - 1, 0));
        } else if (e.key === 'Enter') {
            // Check if input is coordinates first
            const coords = parseLV95Coords(searchTerm);
            if (coords) {
                handleSearch();
            } else if (selectedIndex >= 0 && filteredCantons.length > 0) {
                handleSearch(filteredCantons[selectedIndex]);
            } else if (filteredCantons.length > 0) {
                handleSearch(filteredCantons[0]);
            } else {
                // Try to search anyway (might be a direct canton match)
                handleSearch();
            }
        }
    };

    return (
        <div className="canton-search">
            <input
                type="text"
                value={searchTerm}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Search Canton..."
                className="canton-input"
            />
            <button onClick={() => handleSearch()} className="search-button">Search</button>

            {filteredCantons.length > 0 && (
                <ul className="suggestions">
                    {filteredCantons.map((name, index) => (
                        <li
                            key={index}
                            onClick={() => handleSearch(name)}
                            className={index === selectedIndex ? "selected" : ""}
                        >
                            {name}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default CantonSearch;
