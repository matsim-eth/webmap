from .distribution_helpers import HistogramDistanceProvider


class HistogramEuclideanDistanceModeProvider(HistogramDistanceProvider):
    """Histogram of euclidean distances grouped by transport mode.

    Query params:
        canton       (str):   Comma-separated canton names.
        source       (str):   "Synthetic", "Microcensus", or omit for both.
        mode         (str):   Comma-separated transport modes to include.
        num_bins     (int):   Number of histogram bins (default 100).
        max_distance (float): Cap the maximum distance used for binning.

    Example: /data/histogram_euclidean_distance_mode.json?canton=Zurich&num_bins=50
    """

    ROUTE = "histogram_euclidean_distance_mode.json"
    DISTANCE_TYPE = "euclidean"
    GROUP_COL = "mode"
