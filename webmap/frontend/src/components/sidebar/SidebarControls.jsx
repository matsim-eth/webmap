import React from "react";
import { useApp } from "../../context/AppContext";
import { useFileContext } from "../../FileContext";

const SidebarControls = ({ setInputURL }) => {
    const {
        isGraphExpanded, setIsGraphExpanded,
        setIsFeatureTableOpen,
        setHighlightedLineId, setHighlightedRouteIds,
        setSelectedNetworkModes,
        setResetMapTrigger,
        setSelectedDataset, setSelectedMode,
        setSelectedTransitModes,
        updateMapChoropleth,
        resetMapView,
        setDataURL,
        aggCol: selectedAggCol
    } = useApp();

    const { clearFileMap } = useFileContext();

    const handleGraphSelection = (event) => {
        setIsFeatureTableOpen(false);

        const graph = event.target.value;

        // Clear transit selection when leaving Transit modules
        if (isGraphExpanded === "Transit" || isGraphExpanded === "TransitVolumes") {
            setHighlightedLineId(null);
            setHighlightedRouteIds([]);
        }

        setIsGraphExpanded(graph);

        // Set default network modes per module
        if (graph === "Volumes") setSelectedNetworkModes(["car"]);
        else if (graph === "Network") setSelectedNetworkModes(["all"]);
        else setSelectedNetworkModes(["all"]);
    };

    const handleHome = () => {
        setIsGraphExpanded(null);
    };

    const handleReset = () => {
        setResetMapTrigger((prev) => !prev); // trigger reset in map hooks

        setSelectedDataset("Microcensus");
        setSelectedMode("None");
        setSelectedNetworkModes(["all"]);
        setSelectedTransitModes(["all"]);
        updateMapChoropleth("None", "Microcensus"); // Hardcoded default
        resetMapView();

        setHighlightedLineId(null);
        setHighlightedRouteIds([]);

        // setSelectedGraph(null);
        setIsGraphExpanded(null);

        clearFileMap();
        setDataURL("https://matsim-eth.github.io/webmap/data/");
        if (setInputURL) setInputURL("");
    };

    return (
        <div className="button-row">
            <div className="button-group">
                <button
                    className={`home-button ${!isGraphExpanded ? "active" : ""}`}
                    onClick={handleHome}
                >
                    Home
                </button>
                <button className="reset-button" onClick={handleReset}>
                    Reset
                </button>
                <select
                    className="graph-dropdown"
                    value={isGraphExpanded || ""}
                    onChange={handleGraphSelection}
                >
                    <option value="">Select a Graph</option>
                    <option value="Choropleth">
                        {selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)} by Canton
                    </option>
                    <option value="Network">MATSim Network</option>
                    <option value="Volumes">Road Volumes</option>
                    <option value="VolumeFlow">Volume Flow Analysis [DEMO]</option>
                    <option value="Transit">Transit Stops/Lines</option>
                    <option value="TransitVolumes">Transit Link Volumes</option>
                    <option value="Destination">Destination Zones</option>
                    <option value="PtBoardings">PT Boardings by Vehicle</option>
                    <option value="Graph 1">
                        Average Distance by {selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)}
                    </option>
                    <option value="Graph 2">
                        Distance Distribution by {selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)}
                    </option>
                    <option value="Graph 3">
                        {selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)} by Distance (Stacked)
                    </option>
                    <option value="Graph 4">
                        {selectedAggCol.charAt(0).toUpperCase() + selectedAggCol.slice(1)} by Time/Distance (Line)
                    </option>
                    <option value="Graph 5">Activity Distribution</option>
                    <option value="Graph 6">Public Transport Subscriptions</option>
                    <option value="Graph 7">Car Availability Class</option>
                    <option value="Graph 8">Departure Times</option>
                    <option value="Graph 9">Demographics</option>
                </select>
            </div>
        </div>
    );
};

export default SidebarControls;
