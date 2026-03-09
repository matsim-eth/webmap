from .stacked_bar_euclidean_distance_mode import StackedBarDistanceProvider


class StackedBarEuclideanDistancePurposeProvider(StackedBarDistanceProvider):
    """Stacked bar chart: euclidean distance grouped by purpose.

    Query params:
        canton     (str): Comma-separated canton names.
        source     (str): "Synthetic", "Microcensus", or omit for both.
        purpose    (str): Comma-separated purposes to include.
        categories (str): Comma-separated distance boundaries (e.g. "0,1000,5000,25000").
        gender     (str): "0" or "1" to filter by sex.
    """

    ROUTE = "stacked_bar_euclidean_distance_purpose.json"
    MC_DISTANCE_COL = "crowfly_distance"
    SYN_DISTANCE_COL = "euclidean_distance"
    GROUP_BY = "purpose"
