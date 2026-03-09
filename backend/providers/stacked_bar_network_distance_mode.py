from .stacked_bar_euclidean_distance_mode import StackedBarDistanceProvider


class StackedBarNetworkDistanceModeProvider(StackedBarDistanceProvider):
    """Stacked bar chart: network distance grouped by mode.

    Query params:
        canton     (str): Comma-separated canton names.
        source     (str): "Synthetic", "Microcensus", or omit for both.
        mode       (str): Comma-separated transport modes to include.
        categories (str): Comma-separated distance boundaries (e.g. "0,1000,5000,25000").
        gender     (str): "0" or "1" to filter by sex.
    """

    ROUTE = "stacked_bar_network_distance_mode.json"
    MC_DISTANCE_COL = "network_distance"
    SYN_DISTANCE_COL = "traveled_distance"
    GROUP_BY = "mode"
