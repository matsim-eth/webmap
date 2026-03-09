import React, { createContext, useContext, useState } from "react";

const DashboardContext = createContext();

export const DashboardProvider = ({ children }) => {
  const [selectedCanton, setSelectedCanton] = useState("All");
  const [distanceType, setDistanceType] = useState("euclidean"); // "euclidean" or "network"
  const [selectedMode, setSelectedMode] = useState("all"); // "all", "bike", "car", "car_passenger", "pt", "walk"
  const [selectedPurpose, setSelectedPurpose] = useState("all"); // "all", "education", "work", "leisure", "shopping", "business", "escort"
  const [selectedGender, setSelectedGender] = useState("male"); // "male", "female"
  const [selectedIncome, setSelectedIncome] = useState("1"); // "1", "2", ..., "8"
  const [selectedAge, setSelectedAge] = useState("[6, 15)"); // "[6, 15)", "[15, 18)", "[18, 24)", "[24, 30)", "[30, 45)", "[45, 65)"
  const [selectedTransitStop, setSelectedTransitStop] = useState(null); // { name, stop_id, coords, ... }
  const [selectedTransitLine, setSelectedTransitLine] = useState(null); // null (all) or line_id string

  const value = {
    selectedCanton, setSelectedCanton,
    distanceType, setDistanceType,
    selectedMode, setSelectedMode,
    selectedPurpose, setSelectedPurpose,
    selectedGender, setSelectedGender,
    selectedIncome, setSelectedIncome,
    selectedAge, setSelectedAge,
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
