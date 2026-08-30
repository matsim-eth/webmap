import { useEffect, useRef } from 'react';

/**
 * Resets the Transit Volumes per-link dropdown (`transitSelectedLink`) to "All"
 * whenever a different transit segment/direction is selected, and clears any
 * ant-line left over from a previous link's "Visualize". Mirrors the
 * prevSelKeyRef reset in useNetworkSplitLayers, keyed on the selection's
 * ls_link_ids (a per-direction split click) → link_key_join → per_id_keys.
 *
 * Lives in a hook because the no-direct-useEffect-in-components rule applies to
 * components under `components/`, not custom hooks under `src/hooks/`.
 */
export function useTransitVolumeLinkReset({
  selectedTransitLink,
  setTransitSelectedLink,
  triggerVisualize,
}) {
  const prevSelKeyRef = useRef(null);

  useEffect(() => {
    const p = Array.isArray(selectedTransitLink) ? selectedTransitLink[0] : null;
    const selKey = p ? (p.ls_link_ids || p.link_key_join || p.per_id_keys || '') : null;
    if (selKey !== prevSelKeyRef.current) {
      prevSelKeyRef.current = selKey;
      setTransitSelectedLink(null);
      triggerVisualize(null);
    }
  }, [selectedTransitLink, setTransitSelectedLink, triggerVisualize]);
}
