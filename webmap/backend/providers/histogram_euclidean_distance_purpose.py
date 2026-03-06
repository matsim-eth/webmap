from .distribution_helpers import HistogramDistanceProvider


class HistogramEuclideanDistancePurposeProvider(HistogramDistanceProvider):
    """Histogram of euclidean distances grouped by trip purpose.

    Query params:
        canton       (str):   Comma-separated canton names.
        source       (str):   "Synthetic", "Microcensus", or omit for both.
        purpose      (str):   Comma-separated trip purposes to include.
        num_bins     (int):   Number of histogram bins (default 100).
        max_distance (float): Cap the maximum distance used for binning.

    Example: /data/histogram_euclidean_distance_purpose.json?canton=Bern&purpose=work,education
    """

    ROUTE = "histogram_euclidean_distance_purpose.json"
    DISTANCE_TYPE = "euclidean"
    GROUP_COL = "purpose"
