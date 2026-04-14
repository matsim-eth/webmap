export const DEFAULT_COLORS = ["#4A90E2", "#E07A5F", "#ccebc5", "#decbe4"];

export const LINE_STYLES = ["solid", "dash", "dot", "dashdot"];

export const resolveUrlTemplate = (template, datasetId) =>
  template ? template.replace("{datasetId}", datasetId) : null;

export const extractSubDataset = (payload, cantonKey, subDataset) =>
  payload?.[cantonKey]?.[subDataset] ?? null;

/**
 * Extract histogram data for distance plots where keys are flat:
 * microcensus_histogram, synthetic_histogram, microcensus_mean, etc.
 */
export const extractHistogramData = (payload, cantonKey, option, subDataset) => {
  const optionData = payload?.[cantonKey]?.[option];
  if (!optionData) return null;

  const prefix = subDataset.toLowerCase(); // "microcensus" or "synthetic"
  return {
    histogram: optionData[`${prefix}_histogram`] ?? [],
    mean: optionData[`${prefix}_mean`] ?? 0,
    sampleSize: optionData[`${prefix}_sample_size`] ?? 0,
    bins: optionData.bins ?? [],
    binWidth: optionData.bin_width ?? 0,
  };
};
