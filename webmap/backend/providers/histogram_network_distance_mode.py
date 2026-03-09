from .distribution_helpers import HistogramDistanceProvider


class HistogramNetworkDistanceModeProvider(HistogramDistanceProvider):
    """Histogram of network distances grouped by transport mode.

    Query params:
        canton       (str):   Comma-separated canton names.
        source       (str):   "Synthetic", "Microcensus", or omit for both.
        mode         (str):   Comma-separated transport modes to include.
        num_bins     (int):   Number of histogram bins (default 100).
        max_distance (float): Cap the maximum distance used for binning.

    Example: /data/histogram_network_distance_mode.json?source=Synthetic&mode=car
    """

    ROUTE = "histogram_network_distance_mode.json"
    DISTANCE_TYPE = "network"
    GROUP_COL = "mode"
