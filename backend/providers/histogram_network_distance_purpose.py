from .distribution_helpers import HistogramDistanceProvider


class HistogramNetworkDistancePurposeProvider(HistogramDistanceProvider):
    """Histogram of network distances grouped by trip purpose.

    Query params:
        canton       (str):   Comma-separated canton names.
        source       (str):   "Synthetic", "Microcensus", or omit for both.
        purpose      (str):   Comma-separated trip purposes to include.
        num_bins     (int):   Number of histogram bins (default 100).
        max_distance (float): Cap the maximum distance used for binning.

    Example: /data/histogram_network_distance_purpose.json?canton=Geneve&num_bins=200
    """

    ROUTE = "histogram_network_distance_purpose.json"
    DISTANCE_TYPE = "network"
    GROUP_COL = "purpose"
