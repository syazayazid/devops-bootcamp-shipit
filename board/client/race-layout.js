// board/client/race-layout.js
// Pure race → row math for the shared 2D track (successor of track.js's role).
// Node-tested; no DOM, no Three.js.
const byCallsign = (a, b) => (a.callsign < b.callsign ? -1 : a.callsign > b.callsign ? 1 : 0);
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function progressOf(completed, frac, total) {
  if (!(total > 0)) return 0;
  const done = Math.min(Math.max(completed || 0, 0), total);
  const partial = done >= total ? 0 : clamp01(frac);
  return Math.min(1, (done + partial) / total);
}

// Stable lane assignment: rows never reorder mid-race — ships only move
// horizontally. Rank is a separate, updating number (see ranks()).
export function laneOrder(ships) {
  return [...ships].sort(byCallsign);
}

export function ranks(ships) {
  const sorted = [...ships].sort((a, b) => {
    const af = a.finishedAt != null, bf = b.finishedAt != null;
    if (af && bf) return a.finishedAt - b.finishedAt;
    if (af !== bf) return af ? -1 : 1;
    const d = ((b.completed || 0) + clamp01(b.frac)) - ((a.completed || 0) + clamp01(a.frac));
    if (d !== 0) return d;
    return byCallsign(a, b);
  });
  return new Map(sorted.map((s, i) => [s.callsign, i + 1]));
}
