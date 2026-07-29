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

let pending = null; // { id, promise, resolve, timer }
let nextId = 0;

// Called by usePadding when it starts a padding ease. `durationMs` is the ease
// duration; the timer is a safety net for the case where `moveend` never
// arrives (an interrupted or no-op camera move), so a loader can never hang.
// Returns the shift's id — pass it to endPaddingShift so a `moveend` belonging
// to an already-settled shift can't close a later one (see below).
export function beginPaddingShift(durationMs = 600) {
  if (pending) {
    // A second shift landed on top of the first (e.g. the left sidebar toggled
    // mid module switch). Keep the same promise, just push the deadline out.
    clearTimeout(pending.timer);
    const { id } = pending;
    pending.timer = setTimeout(() => endPaddingShift(id), durationMs + 150);
    return id;
  }
  const id = ++nextId;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  pending = {
    id, promise, resolve,
    timer: setTimeout(() => endPaddingShift(id), durationMs + 150),
  };
  return id;
}

// Idempotent — safe to call more than once for the same shift.
//
// Pass the id returned by beginPaddingShift when closing from a `moveend`
// listener. The safety timer can fire first (interrupted or no-op camera move),
// which clears `pending` while that listener is still armed; without the id
// check the next `moveend` from any source — a user pan — would resolve
// whatever shift happened to be pending *then*, letting a loader start its
// main-thread-blocking work mid-ease. Calling with no id closes unconditionally,
// which is what the "padding already matches, nothing to animate" path wants.
export function endPaddingShift(id) {
  if (!pending) return;
  if (id !== undefined && id !== pending.id) return; // stale listener
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
