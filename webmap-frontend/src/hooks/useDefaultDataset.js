import { useEffect } from 'react';
import { useDatasets } from './useDatasets';

/**
 * Resolve the initial `datasetId` instead of using a hardcoded id. Previously
 * `datasetId` defaulted to `1`, so every fresh load fired requests (e.g. the
 * choropleth's `mode_share.json`) against dataset 1 — a dataset the user may not
 * even own — until they manually picked one in the DatasetSelector.
 *
 * Preference order:
 *   1. the dataset an admin marked as default (`is_default`, set in the admin
 *      panel; always public + active, so every user can read it);
 *   2. otherwise the first active dataset, which the dataset service serves in
 *      ascending-id order.
 *
 * The flag is read explicitly rather than relying on the API's default-first
 * ordering, so this keeps working if that ordering ever changes — and matches
 * what the webmap backend prewarms first, meaning the dataset opened here is the
 * one whose caches are already warm.
 *
 * Only sets while `datasetId` is still unresolved (`null`); a user's explicit
 * dataset switch is never overridden.
 */
export function useDefaultDataset(datasetId, setDatasetId) {
  const { data: datasets } = useDatasets();
  useEffect(() => {
    if (datasetId != null) return;
    if (!Array.isArray(datasets) || datasets.length === 0) return;
    const active = datasets.filter((d) => d.status === 'active');
    const preferred = active.find((d) => d.is_default);
    const first = preferred || active[0] || datasets[0];
    if (first?.id != null) setDatasetId(first.id);
  }, [datasetId, datasets, setDatasetId]);
}
