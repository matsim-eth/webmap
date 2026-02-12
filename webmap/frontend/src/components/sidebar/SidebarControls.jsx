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
                </select>
            </div>
        </div>
    );
};

export default SidebarControls;
