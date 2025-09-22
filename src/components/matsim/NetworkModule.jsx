// src/components/matsim/NetworkModule.jsx
import React, { useCallback, useEffect, useState } from "react";
import SegmentAttributesTable from "./SegmentAttributesTable";
import FeatureTable from "../table/FeatureTable";

const fitToCoords = (map, coords) => {
  if (!map || !Array.isArray(coords) || coords.length === 0) return;
  let minLng = Infinity,
    minLat = Infinity,
    maxLng = -Infinity,
    maxLat = -Infinity;
  coords.forEach(([lng, lat]) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  });
  if (![minLng, maxLng, minLat, maxLat].every(Number.isFinite)) return;
  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    {
      padding: { top: 60, bottom: 60, left: 60, right: 440 },
      duration: 800,
    }
  );
};

const highlightRowOnMap = (map, feature) => {
  if (!map || !feature) return;
  if (map.getLayer("ant-line")) map.removeLayer("ant-line");

  const highlightData = { type: "FeatureCollection", features: [feature] };

  if (map.getSource("network-highlight")) {
    map.getSource("network-highlight").setData(highlightData);
  } else {
    map.addSource("network-highlight", { type: "geojson", data: highlightData });
  }

  if (!map.getLayer("network-highlight")) {
    map.addLayer(
      {
        id: "network-highlight",
        type: "line",
        source: "network-highlight",
        paint: {
          "line-width": ["interpolate", ["linear"], ["get", "capacity"], 300, 5, 4000, 14],
          "line-color": "#8affff",
          "line-opacity": 1,
        },
      },
      "network-layer"
    );
  }
};

const NetworkModule = ({
  canton,
  selectedNetworkModes,
  availableModes,
  selectedNetworkFeature,
  setSelectedNetworkFeature, // REQUIRED from Sidebar
  handleModeChange,
  isFeatureTableOpen,
  featureGeoJSON, // OPTIONAL from Sidebar
  mapRef, // REQUIRED for fit/highlight
}) => {
  // Delay mounting heavy DT init (FeatureTable shows its own "Preparing..." when loading=true)
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    if (isFeatureTableOpen) {
      const t = setTimeout(() => setShowTable(true), 350); // match sidebar transition
      return () => clearTimeout(t);
    } else {
      setShowTable(false);
    }
  }, [isFeatureTableOpen]);

  const handleTableRowSelect = useCallback(
    (row) => {
      if (!row) return;
      const map = mapRef?.current;
      const feature = row.feature;
      const coords = row.coords;

      if (feature) highlightRowOnMap(map, feature);

      if (coords) {
        fitToCoords(map, coords);
      } else if (feature?.geometry) {
        const g = feature.geometry;
        const derived =
          g.type === "LineString"
            ? g.coordinates
            : g.type === "MultiLineString"
            ? g.coordinates.flat()
            : null;
        fitToCoords(map, derived);
      }

      if (row.featureProps || feature?.properties) {
        setSelectedNetworkFeature?.([row.featureProps || feature.properties]);
      }
    },
    [mapRef, setSelectedNetworkFeature]
  );

  return (
    <div className="plot-container">
      {isFeatureTableOpen ? (
        <FeatureTable
          tableId="network-feature-table"
          geojson={featureGeoJSON}
          selectedModes={selectedNetworkModes}
          onRowClick={handleTableRowSelect}
          onSelectCoords={(coords, row) => {
            const map = mapRef?.current;
            fitToCoords(map, coords);
            handleTableRowSelect(row);
          }}
          height={360}
          useScroller={true}
          loading={!showTable} // <-- FeatureTable will show "Preparing table…" when true
        />
      ) : (
        <>
          {canton ? (
            <div className="mode-filter-container">
              <label className="mode-filter-label">Filter by Mode:</label>
              <select
                multiple
                value={selectedNetworkModes}
                onChange={handleModeChange}
                className="mode-filter-select"
              >
                <option value="all">All</option>
                {availableModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <p style={{ padding: "1rem", fontStyle: "italic", color: "#555" }}>
              Click a canton to view MATSim network links.
            </p>
          )}

          {selectedNetworkFeature && (
            <SegmentAttributesTable propertiesList={selectedNetworkFeature} />
          )}
        </>
      )}
    </div>
  );
};

export default NetworkModule;
