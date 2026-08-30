import { useLayoutEffect, useState } from 'react';

/**
 * Positions a `position: fixed` panel next to an anchor element.
 *
 * The panel is aligned to the anchor's top, but shifted UP so that its full
 * (measured) height stays on-screen — so expanding every dataset group still
 * shows the whole panel instead of running off the bottom. Only when the
 * content is genuinely taller than the viewport does it pin to the top and cap
 * `maxHeight` (the panel's inner list then scrolls).
 *
 * Re-measures on open, on content resize (ResizeObserver), and on window
 * resize, so it tracks group expand/collapse and the error message appearing.
 *
 * @param {React.RefObject} panelRef  ref on the panel element (measured)
 * @param {React.RefObject} anchorRef ref on the anchor element (button)
 * @param {boolean} isOpen            whether the panel is mounted
 * @param {number} left              fixed left offset in px
 * @returns {{left:number, top:number, maxHeight:number} | null}
 */
export default function useFloatingPanelPosition(panelRef, anchorRef, isOpen, left) {
  const [style, setStyle] = useState(null);

  useLayoutEffect(() => {
    if (!isOpen) {
      setStyle(null);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const margin = 12;

    const measure = () => {
      const vh = window.innerHeight;
      const anchorTop = anchorRef.current?.getBoundingClientRect().top ?? 80;
      const h = panel.offsetHeight;
      // Prefer the anchor's top; shift up if the panel would overflow the bottom.
      let top = Math.max(margin, anchorTop);
      if (top + h + margin > vh) {
        top = Math.max(margin, vh - margin - h);
      }
      const maxHeight = vh - top - margin;
      setStyle((prev) =>
        prev && prev.top === top && prev.maxHeight === maxHeight && prev.left === left
          ? prev
          : { left, top, maxHeight }
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(panel);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [isOpen, left, panelRef, anchorRef]);

  return style;
}
