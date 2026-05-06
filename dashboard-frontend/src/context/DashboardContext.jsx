import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

const DashboardContext = createContext();

const SUB_ABBREV = { Microcensus: "MC", Synthetic: "Synth" };

// Full label for the selector panel
const buildFullLabel = (slot) =>
  slot ? `${slot.datasetName} - ${slot.subDataset}` : "";

// Short label for plot legends — omits dataset name when both slots share the same dataset
const buildShortLabel = (slot, allSlots) => {
  if (!slot) return "";
  const allSameDataset = allSlots
    .filter(Boolean)
    .every((s) => s.datasetId === slot.datasetId);
  if (allSameDataset) return slot.subDataset;
  return `${slot.datasetName} (${SUB_ABBREV[slot.subDataset] || slot.subDataset})`;
};

const DEFAULT_SLOTS = [
  { datasetId: 1, datasetName: "Default", subDataset: "Microcensus", color: "#4A90E2" },
  { datasetId: 1, datasetName: "Default", subDataset: "Synthetic", color: "#E07A5F" },
];

export const DashboardProvider = ({ children }) => {
  const [comparisonSlots, setComparisonSlots] = useState(DEFAULT_SLOTS);
  const [selectedCanton, setSelectedCantonInner] = useState("All");
  const [distanceType, setDistanceType] = useState("euclidean"); // "euclidean" or "network"
  const [selectedMode, setSelectedMode] = useState("all"); // "all", "bike", "car", "car_passenger", "pt", "walk"
  const [selectedPurpose, setSelectedPurpose] = useState("all"); // "all", "education", "work", "leisure", "shopping", "business", "escort"
  const [selectedGender, setSelectedGender] = useState("all"); // "all", "male", "female"
  const [selectedIncome, setSelectedIncome] = useState("all"); // "all", "1", ..., "8"
  const [selectedAge, setSelectedAge] = useState("all");
  const [selectedRoadType, setSelectedRoadType] = useState("all"); // "all", "[6, 15)", "[15, 18)", "[18, 24)", "[24, 30)", "[30, 45)", "[45, 65)"
  const [selectedTransitStop, setSelectedTransitStop] = useState(null); // { name, stop_id, coords, ... }
  const [selectedTransitLine, setSelectedTransitLine] = useState(null); // null (all) or line_id string
  const [selectedLineMeta, setSelectedLineMeta] = useState(null); // Transit Lines tab: { line_id, line_name, vehicle, cantons, route_id }
  const [selectedMunicipality, setSelectedMunicipality] = useState(null); // polygon id (bfs_nummer for muni, custom id for uploaded)
  const [selectedLineModes, setSelectedLineModes] = useState(['all']); // Transit Lines tab mode filter

  // Transit Lines tab: polygon set used to aggregate boardings/alightings.
  //
  //   - Default: { kind: 'municipality' } — uses the precomputed
  //     stop_municipality.json lookup + municipalities.geojson overlay.
  //   - Custom: { kind: 'custom', name: <filename>, features: [...],
  //     nameProperty: <key>, availableProperties: [...] } — user-uploaded
  //     GeoJSON. Stop→polygon assignment is done client-side via PiP.
  const [polygonSet, setPolygonSetInner] = useState({
    kind: 'municipality',
    name: 'Municipalities (default)',
  });
  // Polygon IDs aren't portable across sets — clear the highlighted polygon
  // whenever the set changes (whether to a custom upload or back to default).
  const setPolygonSet = useCallback((next) => {
    setPolygonSetInner(next);
    setSelectedMunicipality(null);
  }, []);
  const resetPolygonSet = useCallback(() => {
    setPolygonSet({ kind: 'municipality', name: 'Municipalities (default)' });
  }, [setPolygonSet]);

  // Derived datasetId from slot 0 for backward compat (transit stops, file upload, canton map)
  const datasetId = comparisonSlots[0]?.datasetId ?? 1;
  const setDatasetId = useCallback((id) => {
    setComparisonSlots((prev) =>
      prev.map((slot) => (slot ? { ...slot, datasetId: id } : slot))
    );
  }, []);

  // Labeled slots with computed label fields
  const labeledSlots = useMemo(
    () => {
      const active = comparisonSlots.filter(Boolean);
      return active.map((s) => ({
        ...s,
        label: buildShortLabel(s, active),       // short label for plot legends
        fullLabel: buildFullLabel(s),             // long label for selector panel
      }));
    },
    [comparisonSlots]
  );

  const setSlot = useCallback((index, slot) => {
    setComparisonSlots((prev) => {
      const next = [...prev];
      next[index] = slot;
      return next.slice(0, 2); // max 2 slots
    });
  }, []);

  const setSlotColor = useCallback((index, color) => {
    setComparisonSlots((prev) => {
      const next = [...prev];
      if (next[index]) next[index] = { ...next[index], color };
      return next;
    });
  }, []);

  const removeSlot = useCallback((index) => {
    setComparisonSlots((prev) => {
      const next = [...prev];
      next.splice(index, 1);
      return next;
    });
  }, []);

  // Changing canton invalidates transit-lines selections (stop, line, municipality)
  // since stops/lines/municipalities are scoped per-canton.
  const setSelectedCanton = useCallback((next) => {
    setSelectedCantonInner((prev) => {
      if (prev === next) return prev;
      setSelectedTransitStop(null);
      setSelectedLineMeta(null);
      setSelectedMunicipality(null);
      return next;
    });
  }, []);

  // Atomic set used by the search bar: switches the canton AND selects a
  // line in the same batch. Bypasses setSelectedCanton's auto-clear because
  // the cascading setSelectedLineMeta(null) inside its reducer is queued for
  // the *next* render and would clobber a separate setSelectedLineMeta(line)
  // call made alongside it.
  const setLineWithCanton = useCallback((lineMeta, canton) => {
    setSelectedCantonInner(canton);
    setSelectedLineMeta(lineMeta);
    setSelectedTransitStop(null);
    setSelectedMunicipality(null);
  }, []);

  const value = {
    comparisonSlots: labeledSlots,
    setComparisonSlots,
    setSlot,
    setSlotColor,
    removeSlot,
    datasetId, setDatasetId,
    selectedCanton, setSelectedCanton,
    distanceType, setDistanceType,
    selectedMode, setSelectedMode,
    selectedPurpose, setSelectedPurpose,
    selectedGender, setSelectedGender,
    selectedIncome, setSelectedIncome,
    selectedAge, setSelectedAge,
    selectedRoadType, setSelectedRoadType,
    selectedTransitStop, setSelectedTransitStop,
    selectedTransitLine, setSelectedTransitLine,
    selectedLineMeta, setSelectedLineMeta,
    setLineWithCanton,
    selectedMunicipality, setSelectedMunicipality,
    selectedLineModes, setSelectedLineModes,
    polygonSet, setPolygonSet, resetPolygonSet,
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
};

export const useDashboard = () => {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error("useDashboard must be used within a DashboardProvider");
  }
  return context;
};
