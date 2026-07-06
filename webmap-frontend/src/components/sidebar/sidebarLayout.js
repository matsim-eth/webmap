// Single source of truth for sidebar geometry.
//
// Both sidebars are `position: fixed` overlays on top of the full-viewport
// map canvas (#map-container is 100% of #root), so keeping fitted content
// centred in the *visible* map area means padding the camera by the exact
// overlay width plus a breathing-room margin. The pixel widths here MUST
// match LeftSidebar.css (.left-sidebar / .collapsed) and RightSidebar.css
// (.open / .expanded / .feature-table-open / .collapsed / .hidden) — a drift
// re-introduces off-centre zooms.

export const LEFT_SIDEBAR_WIDTH = 215;
export const LEFT_SIDEBAR_COLLAPSED_WIDTH = 60;

export const RIGHT_SIDEBAR_WIDTHS = {
  hidden: 0,
  collapsed: 48,
  open: 320,
  expanded: 600,
  'feature-table-open': 900,
};

// Modules whose right sidebar uses the narrow `open` width; every other
// module expands.
const NARROW_MODULES = new Set(['Choropleth', 'Network']);

// The width class RightSidebar.jsx applies — shared so the map padding can
// never disagree with the width the sidebar actually renders at.
export function getRightSidebarClass({ isGraphExpanded, isSidebarOpen, isFeatureTableOpen }) {
  if (!isGraphExpanded) return 'hidden';
  if (!isSidebarOpen) return 'collapsed';
  if (isFeatureTableOpen) return 'feature-table-open';
  if (NARROW_MODULES.has(isGraphExpanded)) return 'open';
  return 'expanded';
}

// Margin between the viewport/sidebar edge and the fitted content.
export const MAP_PADDING_BASE = 50;

// Camera padding derived from sidebar *state* — correct even while the 0.3s
// width transition is still animating, because it targets the final widths.
export function computeMapPadding({
  isGraphExpanded,
  isSidebarOpen,
  isFeatureTableOpen = false,
  isLeftSidebarOpen,
  base = MAP_PADDING_BASE,
}) {
  const rightClass = getRightSidebarClass({ isGraphExpanded, isSidebarOpen, isFeatureTableOpen });
  const leftWidth = isLeftSidebarOpen ? LEFT_SIDEBAR_WIDTH : LEFT_SIDEBAR_COLLAPSED_WIDTH;
  return {
    top: base,
    bottom: base,
    left: leftWidth + base,
    right: RIGHT_SIDEBAR_WIDTHS[rightClass] + base,
  };
}

// Camera padding measured off the live DOM — for event handlers that don't
// have the full sidebar state in scope. Only accurate once the width
// transition has settled; prefer computeMapPadding in effects that fire at
// the same moment the sidebar starts animating.
export function measureMapPadding(base = MAP_PADDING_BASE) {
  const left = document.querySelector('.left-sidebar')?.getBoundingClientRect().width ?? 0;
  const right = document.querySelector('.right-sidebar')?.getBoundingClientRect().width ?? 0;
  return { top: base, bottom: base, left: left + base, right: right + base };
}
