import { useEffect, useRef } from "react";
import { useDashboard, PLACEHOLDER_DATASET_NAME } from "../context/DashboardContext";
import { useDatasets } from "./useDatasets";

/**
 * Resolve the placeholder comparison slots to the real default dataset once the
 * dataset list loads.
 *
 * `DEFAULT_SLOTS` can't know which dataset to open — the id isn't available
 * until the API responds — so it ships a placeholder (`PLACEHOLDER_DATASET_NAME`
 * + id 1) that this hook replaces. Preference order matches the webmap's
 * `useDefaultDataset`:
 *
 *   1. the dataset an admin marked as default (`is_default`, set in the admin
 *      panel; always public + active, so every user can read it);
 *   2. otherwise the first active dataset — the dataset service returns them
 *      default-first then ascending id.
 *
 * This previously synced only the *name* of dataset 1 and deliberately kept
 * `datasetId: 1`, which meant the dashboard always opened dataset 1 regardless
 * of the admin's choice (and showed a dataset named "Default" whenever id 1
 * didn't exist). Now the id moves too, so the dashboard, the webmap, and the
 * webmap backend's prewarm all agree on which dataset is the default.
 *
 * Runs once (`initRef`) and only while the slots still carry the placeholder, so
 * a user's explicit dataset switch is never overridden.
 */
export function useAutoInitSlots() {
  const { comparisonSlots, setSlot } = useDashboard();
  const { data: datasets = [] } = useDatasets();
  const initRef = useRef(false);

  const activeDatasets = datasets.filter((d) => d.status === "active");

  useEffect(() => {
    if (initRef.current) return;
    if (activeDatasets.length === 0) return;

    const target =
      activeDatasets.find((d) => d.is_default) || activeDatasets[0];
    if (!target) return;

    // Only touch slots still holding the placeholder. Checking the name (not the
    // id) is what makes an explicit user pick of the same id stick.
    const placeholders = comparisonSlots
      .map((slot, idx) => ({ slot, idx }))
      .filter(({ slot }) => slot?.datasetName === PLACEHOLDER_DATASET_NAME);
    if (placeholders.length === 0) return;

    initRef.current = true;

    placeholders.forEach(({ slot, idx }) => {
      setSlot(idx, { ...slot, datasetId: target.id, datasetName: target.name });
    });
  }, [activeDatasets, comparisonSlots, setSlot]);
}
