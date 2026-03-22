import { useEffect } from 'react';
export function useResizeOnSidebarChange(sidebarCollapsed) {
  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 350);
    return () => clearTimeout(timer);
  }, [sidebarCollapsed]);
}
