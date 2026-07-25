import { useEffect, useRef } from 'react';

/**
 * Resets the .H/.R route-direction filter to 'total' whenever the highlighted
 * line changes — a different line's H/R point at different termini, so a stale
 * direction would silently filter the new line.
 *
 * Lives in a hook (not a render-phase ref compare in the component) because
 * `selectedDirection` lives in FilterContext, an ANCESTOR provider: calling its
 * setter during a descendant component's render triggers React's "Cannot update
 * a component while rendering a different component" warning. A useEffect is the
 * correct place to update another component's state, and the
 * no-direct-useEffect-in-components rule applies to `components/`, not custom
 * hooks under `src/hooks/`.
 */
export function useResetDirectionOnLineChange(highlightedLineId, selectedDirection, setSelectedDirection) {
  const prevLineRef = useRef(highlightedLineId);

  useEffect(() => {
    if (prevLineRef.current === highlightedLineId) return;
    prevLineRef.current = highlightedLineId;
    if (selectedDirection !== 'total') setSelectedDirection('total');
  }, [highlightedLineId, selectedDirection, setSelectedDirection]);
}
