import { useState } from 'react';
import cantonAlias from '../utils/canton_alias.json'; // adjust path as needed
import './CantonSearch.css';

const CantonSearch = ({ onSearch }) => {
    const [searchTerm, setSearchTerm] = useState('');
    const [filteredCantons, setFilteredCantons] = useState([]);
    const [selectedIndex, setSelectedIndex] = useState(-1);

    // Convert alias JSON to an array of [cleanName, displayName]
    const cantonEntries = Object.entries(cantonAlias);
    const displayNames = cantonEntries.map(([_, displayName]) => displayName);

    const normalizeString = (str) => {
        return str
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase();
    };

    const handleSearch = (displayName = null) => {
        const normalizedSearch = normalizeString(displayName || searchTerm);

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
            if (selectedIndex >= 0 && filteredCantons.length > 0) {
                handleSearch(filteredCantons[selectedIndex]);
            } else if (filteredCantons.length > 0) {
                handleSearch(filteredCantons[0]);
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
