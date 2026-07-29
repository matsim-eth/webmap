// Sequencing gate between the camera padding shift and the heavy module loads.
//
// Opening a module changes the right sidebar's width, and `usePadding` eases the
// camera padding by that amount so the fitted content stays centred in the
// visible map area. That ease is driven by requestAnimationFrame — and it starts
// in the same commit that kicks off the module's data load. Parsing a canton's
// merged_segments (tens of MB), merging it and handing ~180k features to Mapbox
// blocks the main thread for seconds, so the ease gets no frames and the map is
// left sitting at whatever padding it had reached when the block started.
//
// Rather than racing, the loaders wait: `usePadding` opens the gate when it
// starts an ease and closes it on `moveend`, and any loader that is about to do
// main-thread-blocking work awaits `paddingSettled()` first. When no shift is in
// flight (the common case — most module switches keep the same sidebar width)
// the await resolves immediately, so nothing is slowed down for free.

let pending = null; // { promise, resolve, timer }

// Called by usePadding when it starts a padding ease. `durationMs` is the ease
// duration; the timer is a safety net for the case where `moveend` never
// arrives (an interrupted or no-op camera move), so a loader can never hang.
export function beginPaddingShift(durationMs = 600) {
  if (pending) {
    // A second shift landed on top of the first (e.g. the left sidebar toggled
    // mid module switch). Keep the same promise, just push the deadline out.
    clearTimeout(pending.timer);
    pending.timer = setTimeout(endPaddingShift, durationMs + 150);
    return;
  }
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  pending = { promise, resolve, timer: setTimeout(endPaddingShift, durationMs + 150) };
}

// Idempotent — safe to wire straight to a `moveend` handler that may also have
// been registered by an earlier, already-settled shift.
export function endPaddingShift() {
  if (!pending) return;
  const { resolve, timer } = pending;
  pending = null;
  clearTimeout(timer);
  resolve();
}

// Awaited by loaders before any blocking work. Resolves immediately when no
// padding shift is in flight.
export function paddingSettled() {
  return pending ? pending.promise : Promise.resolve();
}
