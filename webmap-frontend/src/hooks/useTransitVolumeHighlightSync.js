import { useEffect } from 'react';

/**
 * Resets `highlightedLineId` (in ChoroplethProvider) when:
 *  - the active canton changes — a stale line id from one canton is
 *    meaningless in another;
 *  - the volumes feature table opens — the table always shows all transit
 *    links in the canton, so the line filter would either hide rows the
 *    user wants to see or set up a featureGeoJSON cascade on row click
 *    that crashes DataTables (`Node.removeChild` from a Scroller race).
 *    Clearing on table-open lets row clicks happen with no line filter
 *    active, so no cascade fires.
 *
 * Lives in a hook because this is cross-component setState
 * (`highlightedLineId` is owned by ChoroplethProvider) and the
 * no-useEffect rule applies to components, not custom hooks under
 * `src/hooks/`.
 */
export function useTransitVolumeHighlightSync({
  canton,
  isFeatureTableOpen,
  setHighlightedLineId,
}) {
  useEffect(() => {
    setHighlightedLineId(null);
  }, [canton, setHighlightedLineId]);

  useEffect(() => {
    if (isFeatureTableOpen) {
      setHighlightedLineId(null);
    }
  }, [isFeatureTableOpen, setHighlightedLineId]);
}
