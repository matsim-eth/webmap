import { useEffect } from 'react';

const AGG_LAYER = 'link-speeds-layer-agg';
const SPLIT_LAYER = 'link-speeds-layer';
const LABEL_RIGHT = 'link-speeds-labels-right';
const LABEL_LEFT = 'link-speeds-labels-left';

const ARROW_RIGHT_FILTER = ['==', ['get', 'ls_arrow'], '→'];
const ARROW_LEFT_FILTER = ['==', ['get', 'ls_arrow'], '←'];

// Apply combined polygon + table-search filtering to LinkSpeeds layers.
//   `visibleSegmentKeys`  — Set<string> of segment `per_id_keys` for the agg layer
//                           (one per canton segment; covers both directions).
//   `visibleSplitIds`     — Set<string> of per-direction `ls_link_ids` for the
//                           split layer + labels (so hiding a single direction
//                           works at high zoom).
// null on either set = clear that layer's filter. Empty set = hide everything.
//
// Also resets `tableFilterQuery` when the table closes or the canton changes,
// so a stale filter from one canton doesn't carry over and hide all links in
// the next canton (which would never match the previous canton's link IDs).
export default function useLinkSpeedsMapFilter({
  mapRef,
  isGraphExpanded,
  visibleSegmentKeys,
  visibleSplitIds,
  isFeatureTableOpen,
  clickedCanton,
  setTableFilterQuery,
}) {
  // effect:audited — reset table filter on close + canton change (LinkSpeeds
  // builds its own rows so it can't piggyback on useTableRowBuilder's reset).
  useEffect(() => {
    if (!setTableFilterQuery) return;
    if (isGraphExpanded !== 'LinkSpeeds') return;
    setTableFilterQuery(null);
  }, [isFeatureTableOpen, clickedCanton, isGraphExpanded, setTableFilterQuery]);


  // effect:audited — imperative mapbox setFilter sync for table+polygon intersection
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || isGraphExpanded !== 'LinkSpeeds') return;

    const toFilter = (set, prop) => {
      if (!set) return null;
      const arr = Array.from(set);
      if (arr.length === 0) return false;
      return ['match', ['get', prop], arr, true, false];
    };

    const aggExtra = toFilter(visibleSegmentKeys, 'per_id_keys');
    const splitExtra = toFilter(visibleSplitIds, 'ls_link_ids');

    const apply = () => {
      if (map.getLayer(AGG_LAYER)) {
        map.setFilter(AGG_LAYER, aggExtra);
      }
      if (map.getLayer(SPLIT_LAYER)) {
        map.setFilter(SPLIT_LAYER, splitExtra);
      }
      if (map.getLayer(LABEL_RIGHT)) {
        map.setFilter(LABEL_RIGHT, splitExtra ? ['all', ARROW_RIGHT_FILTER, splitExtra] : ARROW_RIGHT_FILTER);
      }
      if (map.getLayer(LABEL_LEFT)) {
        map.setFilter(LABEL_LEFT, splitExtra ? ['all', ARROW_LEFT_FILTER, splitExtra] : ARROW_LEFT_FILTER);
      }
    };

    apply();

    return () => {
      if (map.getLayer(AGG_LAYER)) map.setFilter(AGG_LAYER, null);
      if (map.getLayer(SPLIT_LAYER)) map.setFilter(SPLIT_LAYER, null);
      if (map.getLayer(LABEL_RIGHT)) map.setFilter(LABEL_RIGHT, ARROW_RIGHT_FILTER);
      if (map.getLayer(LABEL_LEFT)) map.setFilter(LABEL_LEFT, ARROW_LEFT_FILTER);
    };
  }, [mapRef, isGraphExpanded, visibleSegmentKeys, visibleSplitIds]);
}
