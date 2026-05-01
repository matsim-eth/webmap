import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useSelection } from './SelectionContext';

const ModuleContext = createContext(null);

const getModuleGroup = (module) => {
  if (module === 'Network' || module === 'Volumes' || module === 'VolumeFlow' || module === 'NodeFlows' || module === 'LinkSpeeds') return 'network';
  if (module === 'TransitVolumes') return 'transitVolumes';
  if (module === 'Transit') return 'transit';
  if (module === 'ZoneFlows') return 'zoneFlows';
  return null;
};

/**
 * Currently active sidebar module (e.g. "Network", "Transit").
 * setIsGraphExpanded clears featureSelection on group change so highlights
 * from one module don't leak into another. Depends on SelectionContext.
 */
export const ModuleProvider = ({ children }) => {
  const { setFeatureSelection } = useSelection();
  const [isGraphExpanded, setIsGraphExpandedRaw] = useState(false);
  const previousModule = useRef(null);

  const setIsGraphExpanded = useCallback((nextModule) => {
    const currentGroup = getModuleGroup(previousModule.current);
    const nextGroup = getModuleGroup(nextModule);
    if (nextGroup !== currentGroup && currentGroup !== null) {
      setFeatureSelection(null);
    }
    previousModule.current = nextModule;
    setIsGraphExpandedRaw(nextModule);
  }, [setFeatureSelection]);

  const value = useMemo(() => ({
    isGraphExpanded,
    setIsGraphExpanded,
  }), [isGraphExpanded, setIsGraphExpanded]);

  return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>;
};

export const useModule = () => {
  const ctx = useContext(ModuleContext);
  if (!ctx) throw new Error('useModule must be used within a ModuleProvider');
  return ctx;
};
