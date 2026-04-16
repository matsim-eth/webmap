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
  const [selectedCanton, setSelectedCanton] = useState("All");
  const [distanceType, setDistanceType] = useState("euclidean"); // "euclidean" or "network"
  const [selectedMode, setSelectedMode] = useState("all"); // "all", "bike", "car", "car_passenger", "pt", "walk"
  const [selectedPurpose, setSelectedPurpose] = useState("all"); // "all", "education", "work", "leisure", "shopping", "business", "escort"
  const [selectedGender, setSelectedGender] = useState("all"); // "all", "male", "female"
  const [selectedIncome, setSelectedIncome] = useState("all"); // "all", "1", ..., "8"
  const [selectedAge, setSelectedAge] = useState("all");
  const [selectedRoadType, setSelectedRoadType] = useState("all"); // "all", "[6, 15)", "[15, 18)", "[18, 24)", "[24, 30)", "[30, 45)", "[45, 65)"
  const [selectedTransitStop, setSelectedTransitStop] = useState(null); // { name, stop_id, coords, ... }
  const [selectedTransitLine, setSelectedTransitLine] = useState(null); // null (all) or line_id string

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
