// board/src/liveness.js
// Tracks which learners' Pages sites are actually reachable (HTTP 200), so the
// board can show a ship as LIVE only when its *real* deploy responds — not just
// because report.sh POSTed an event. Pure of the HTTP server: hand it a roster
// (anything with .list() -> [{ callsign, siteUrl? }]) and it sweeps each entry's
// siteUrl on an interval, flipping a per-callsign boolean.
//
// Why a periodic re-check, not a one-shot verify: a fresh GitHub Pages deploy
// can 404 for ~1 min after the report lands. A single probe would miss it; the
// sweep flips the ship green the moment the site actually comes up. A non-200 or
// timeout means "not live yet," never an error.

export const DEFAULTS = { interval: 30_000, timeout: 4_000, concurrency: 8 };

export function createLiveness({
  roster,
  fetchImpl = fetch,
  interval = DEFAULTS.interval,
  timeout = DEFAULTS.timeout,
  concurrency = DEFAULTS.concurrency,
  onChange = () => {},
} = {}) {
  const live = new Map(); // callsign -> boolean
  let timer = null;

  async function reachable(url) {
    try {
      const res = await fetchImpl(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      return res.status === 200;
    } catch { return false; } // DNS/timeout/network → not live yet, not an error
  }

  async function probe(entry) {
    if (!entry?.siteUrl) return;
    const ok = await reachable(entry.siteUrl);
    if (live.get(entry.callsign) !== ok) { live.set(entry.callsign, ok); onChange(); }
  }

  // One bounded-concurrency pass over every roster entry carrying a siteUrl.
  async function sweep() {
    const targets = roster.list().filter((e) => e.siteUrl);
    for (let i = 0; i < targets.length; i += concurrency) {
      await Promise.all(targets.slice(i, i + concurrency).map(probe));
    }
  }

  return {
    isLive: (callsign) => live.get(callsign) === true,
    probe,   // probe one entry now — call on arrival for snappy first-contact
    sweep,   // one full pass — exposed for tests
    start() { if (!timer) { sweep(); timer = setInterval(sweep, interval); timer.unref?.(); } },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
