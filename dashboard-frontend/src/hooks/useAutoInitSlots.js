import { useEffect, useRef } from "react";
import { useDashboard } from "../context/DashboardContext";
import { useDatasets } from "./useDatasets";

/**
 * Once real datasets load from the API, update the default slots (which use
 * datasetId=1 and datasetName="Default") to carry the correct name from the API.
 * Does NOT change the datasetId — keeps id=1 as the default.
 */
export function useAutoInitSlots() {
  const { comparisonSlots, setSlot } = useDashboard();
  const { data: datasets = [] } = useDatasets();
  const initRef = useRef(false);

  const activeDatasets = datasets.filter((d) => d.status === "active");

  useEffect(() => {
    if (initRef.current) return;
    if (activeDatasets.length === 0) return;

    initRef.current = true;

    // Find the dataset with id=1 to get its real name
    const defaultDs = activeDatasets.find((d) => d.id === 1);
    if (!defaultDs) return;

    // Only update if slots still carry the placeholder name
    const needsSync = comparisonSlots.some(
      (s) => s.datasetName === "Default" && s.datasetId === 1
    );
    if (!needsSync) return;

    // Sync the name only — keep datasetId=1
    comparisonSlots.forEach((slot, idx) => {
      if (slot.datasetId === 1 && slot.datasetName === "Default") {
        setSlot(idx, { ...slot, datasetName: defaultDs.name });
      }
    });
  }, [activeDatasets, comparisonSlots, setSlot]);
}
