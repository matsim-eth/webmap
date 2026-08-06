import { useEffect, useRef } from 'react';

export function useVolumeHighlightSync({
  isFeatureTableOpen,
  hasPolygon,
  setSelectedNetworkFeature,
}) {
  const wasOpenRef = useRef(isFeatureTableOpen);
  useEffect(() => {
    if (wasOpenRef.current && !isFeatureTableOpen && hasPolygon) {
      setSelectedNetworkFeature?.(null);
    }
    wasOpenRef.current = isFeatureTableOpen;
  }, [isFeatureTableOpen, hasPolygon, setSelectedNetworkFeature]);
}
