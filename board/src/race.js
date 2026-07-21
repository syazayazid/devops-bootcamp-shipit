// board/src/race.js
// The in-memory, authoritative race. Pure and node-testable, like room.js.
// The server owns positions + phase; cockpits only report their next completion.

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export class Race {
  constructor({ total = 12 } = {}) {
    this.total = total;
    this.phase = 'idle';        // idle | running | finished
    this.prompts = [];          // identical ordered command list for every racer
    this.racers = new Map();    // callsign -> { completed, finishedAt, frac }
    this._seq = 0;              // monotonic finish-order counter
  }

  join(callsign) {
    if (!this.racers.has(callsign)) this.racers.set(callsign, { completed: 0, finishedAt: null, frac: 0 });
    return this.racers.get(callsign);
  }

  start(prompts) {
    // The story sets the distance: total follows the prompt list (empty list
    // keeps the configured default so progress math never divides by zero).
    this.prompts = prompts.slice();
    if (this.prompts.length) this.total = this.prompts.length;
    this.phase = 'running';
    this._seq = 0;
    for (const r of this.racers.values()) { r.completed = 0; r.finishedAt = null; r.frac = 0; }
    return this;
  }

  progress(callsign, completed) {
    if (this.phase !== 'running') return null;
    const r = this.racers.get(callsign);
    if (!r) return null;
    if (completed !== r.completed + 1 || completed > this.total) return r; // out-of-order/replay
    r.completed = completed;
    r.frac = 0;
    if (r.completed >= this.total && r.finishedAt == null) r.finishedAt = ++this._seq;
    if (this._allFinished()) this.phase = 'finished';
    return r;
  }

  // One entry point for cockpit reports: a completion advances; a same-index
  // report only refreshes the display-only typing fraction.
  report(callsign, completed, frac) {
    if (this.phase !== 'running') return null;
    const r = this.racers.get(callsign);
    if (!r) return null;
    if (completed === r.completed + 1) return this.progress(callsign, completed);
    if (completed === r.completed) r.frac = clamp01(frac);
    return r;
  }

  reset() {
    this.phase = 'idle';
    this.prompts = [];
    for (const r of this.racers.values()) { r.completed = 0; r.finishedAt = null; r.frac = 0; }
  }

  snapshot() {
    const ships = [...this.racers.entries()].map(([callsign, r]) => ({
      callsign, completed: r.completed, finishedAt: r.finishedAt, frac: r.frac,
    }));
    return { phase: this.phase, total: this.total, prompts: this.prompts, ships };
  }

  _allFinished() {
    if (this.racers.size === 0) return false;
    for (const r of this.racers.values()) if (r.finishedAt == null) return false;
    return true;
  }
}
