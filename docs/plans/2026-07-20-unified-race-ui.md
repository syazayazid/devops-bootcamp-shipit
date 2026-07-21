# Unified 2D Race UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared DOM race component rendered by both the projector and the learner cockpit, with per-keystroke smooth ship movement and a `/operator` console page replacing curl.

**Architecture:** A pure-DOM rows component (`race-track.js`) replaces the Three.js race scene and its DOM fallback; ship identity comes from one-time GLB→PNG sprite snapshots (`ship-sprite.js`). The WS `progress` message gains a display-only `frac` field so ships glide between prompt completions. A new static `operator.html` page drives the three existing operator endpoints.

**Tech Stack:** Node 20, ESM, `ws`, Three.js (sprite snapshots only), Vite multi-page build, `node --test`.

**Spec:** `docs/specs/2026-07-20-unified-race-ui-design.md` — read it before starting any task.

## Global Constraints

- Node 20, ESM everywhere. Fail loud. No CDN — everything bundled by Vite.
- Tests: `node --test` only (run as `npm test` from `board/`). **No vitest, no Playwright.**
- `frac` is display-only: ranking, finishing, and phase transitions key off `completed` alone.
- Race row order on screen is stable-alphabetical by callsign; rows NEVER reorder mid-race.
- Reduced-motion support = CSS `prefers-reduced-motion` disables the ship transition; no JS branch.
- Do not touch: orbit view (`scene.js`, `fallback.js`, `orbit.js`, `placement.js`), roster/event contract (`room.js`, `/api/event`), `launchpad/` anything.
- All commands below run from `/home/debian/repo/devops-bootcamp-shipit/board` unless stated.
- Commit messages: conventional commits, end body with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Server — `frac` on Race + `report()` entry point

**Files:**
- Modify: `board/src/race.js`
- Test: `board/test/race.test.js`

**Interfaces:**
- Consumes: existing `Race` class (`join/start/progress/reset/snapshot`).
- Produces: `race.report(callsign: string, completed: number, frac: number) -> racer|null` — advance when `completed === racer.completed + 1` (delegates to `progress()`, zeroes `frac`), update `racer.frac` (clamped 0–1, non-finite→0) when `completed === racer.completed`, ignore otherwise. `snapshot().ships[i]` gains `frac: number`. Task 2 calls `report()` from the WS handler; Task 5 reads `frac` from broadcasts.

- [ ] **Step 1: Write the failing tests** — append to `board/test/race.test.js`:

```js
test('report stores clamped frac without advancing', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  r.report('octocat', 0, 0.5);
  let s = r.snapshot().ships[0];
  assert.equal(s.completed, 0);
  assert.equal(s.frac, 0.5);
  r.report('octocat', 0, 7);      // over → clamp 1
  assert.equal(r.snapshot().ships[0].frac, 1);
  r.report('octocat', 0, -2);     // under → clamp 0
  assert.equal(r.snapshot().ships[0].frac, 0);
  r.report('octocat', 0, 'zzz');  // junk → 0
  assert.equal(r.snapshot().ships[0].frac, 0);
});

test('report advances on next index and zeroes frac; gaps ignored', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  r.report('octocat', 0, 0.9);
  r.report('octocat', 1, 0);      // completion
  let s = r.snapshot().ships[0];
  assert.equal(s.completed, 1);
  assert.equal(s.frac, 0);
  r.report('octocat', 3, 0.5);    // gap → fully ignored
  s = r.snapshot().ships[0];
  assert.equal(s.completed, 1);
  assert.equal(s.frac, 0);
});

test('report is ignored when idle or racer unknown', () => {
  const r = new Race({ total: 3 });
  assert.equal(r.report('nobody', 0, 0.5), null);   // idle
  r.join('octocat');
  r.start(prompts(3));
  assert.equal(r.report('ghost', 0, 0.5), null);    // not joined
});

test('start and reset zero frac', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  r.report('octocat', 0, 0.7);
  r.reset();
  assert.equal(r.snapshot().ships[0].frac, 0);
  r.start(prompts(3));
  assert.equal(r.snapshot().ships[0].frac, 0);
});
```

Also update the existing first test (line 11's `deepEqual`) — new racers carry `frac`:

```js
  assert.deepEqual(a, { completed: 0, finishedAt: null, frac: 0 });
```

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `npm test`
Expected: the 4 new tests + the updated `join` test FAIL (`frac` undefined / `report is not a function`); everything else passes.

- [ ] **Step 3: Implement in `board/src/race.js`**

Add a module-level helper above the class:

```js
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
```

Change `join`, `start`, `progress`, `reset`, `snapshot`, and add `report`:

```js
  join(callsign) {
    if (!this.racers.has(callsign)) this.racers.set(callsign, { completed: 0, finishedAt: null, frac: 0 });
    return this.racers.get(callsign);
  }

  start(prompts) {
    this.prompts = prompts.slice(0, this.total);
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
```

(`messages.js` needs NO change — `raceMsg` spreads snapshot ships, so `frac` flows into broadcasts automatically. Task 2's server test proves it.)

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: PASS, zero failures.

- [ ] **Step 5: Commit**

```bash
git add src/race.js test/race.test.js
git commit -m "feat(board): race racers carry display-only typing frac via report()

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Server — WS handler accepts `frac`, broadcast round-trip test

**Files:**
- Modify: `board/src/app.js:116-119`
- Test: `board/test/server.test.js`

**Interfaces:**
- Consumes: `race.report(callsign, completed, frac)` from Task 1.
- Produces: WS wire contract `{ t: 'progress', completed: int, frac?: number }` accepted from joined cockpits; broadcast `race` message ships now include `frac`. Task 7's cockpit sends this shape.

- [ ] **Step 1: Write the failing test** — append to `board/test/server.test.js` (reuses `post`, `openClient`, `nextMsg`, `postTo`, `opHeader`, `ev` already defined in that file):

```js
test('cockpit frac ripples into the race broadcast without advancing', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: 'op-key' });
  const port = app.port;
  try {
    await post(port, ev);
    const cockpit = await openClient(port);
    await nextMsg(cockpit, (m) => m.t === 'roster');
    cockpit.send(JSON.stringify({ t: 'join', callsign: 'octocat' }));
    await postTo(port, '/api/race/start', { session: 'cicd3' }, opHeader('op-key'));
    await nextMsg(cockpit, (m) => m.t === 'race' && m.phase === 'running');

    cockpit.send(JSON.stringify({ t: 'progress', completed: 0, frac: 0.5 }));
    const partial = await nextMsg(cockpit, (m) =>
      m.t === 'race' && m.ships.some((s) => s.callsign === 'octocat' && s.frac === 0.5));
    assert.equal(partial.ships.find((s) => s.callsign === 'octocat').completed, 0);
    cockpit.close();
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npm test`
Expected: new test FAILS with `timeout` (server never stores frac); all others pass.

- [ ] **Step 3: Implement** — in `board/src/app.js`, replace the `progress` branch of the WS message handler:

```js
      } else if (m.t === 'progress' && ws.callsign && Number.isInteger(m.completed)) {
        race.report(ws.callsign, m.completed, m.frac);
        raceDirty = true;
      }
```

(Only the function call changes: `race.progress(ws.callsign, m.completed)` → `race.report(ws.callsign, m.completed, m.frac)`.)

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.js test/server.test.js
git commit -m "feat(board): ws progress carries typing frac into race broadcasts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Client — pure row math (`race-layout.js`)

**Files:**
- Create: `board/client/race-layout.js`
- Test: `board/client/race-layout.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (Task 5 imports all three):
  - `progressOf(completed: number, frac: number, total: number) -> number` 0..1
  - `laneOrder(ships: {callsign}[]) -> ships[]` stable alphabetical copy
  - `ranks(ships: {callsign, completed, frac, finishedAt}[]) -> Map<callsign, rank>` (1-based)

- [ ] **Step 1: Write the failing tests** — create `board/client/race-layout.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressOf, laneOrder, ranks } from './race-layout.js';

test('progressOf blends completed and frac over total, clamped', () => {
  assert.equal(progressOf(0, 0, 12), 0);
  assert.equal(progressOf(6, 0.5, 12), 6.5 / 12);
  assert.equal(progressOf(12, 0.9, 12), 1);   // finished: frac no longer counts
  assert.equal(progressOf(13, 0, 12), 1);     // over-report clamps
  assert.equal(progressOf(3, -1, 12), 3 / 12); // junk frac clamps low
  assert.equal(progressOf(3, 2, 12), 4 / 12);  // junk frac clamps high
  assert.equal(progressOf(5, 0.5, 0), 0);     // degenerate total
});

test('laneOrder sorts alphabetically without mutating input', () => {
  const ships = [{ callsign: 'zed' }, { callsign: 'ada' }, { callsign: 'mel' }];
  const out = laneOrder(ships);
  assert.deepEqual(out.map((s) => s.callsign), ['ada', 'mel', 'zed']);
  assert.equal(ships[0].callsign, 'zed'); // input untouched
});

test('ranks: finished first by finishedAt, then by completed+frac, ties alphabetical', () => {
  const ships = [
    { callsign: 'slow', completed: 2, frac: 0.1, finishedAt: null },
    { callsign: 'winner', completed: 12, frac: 0, finishedAt: 1 },
    { callsign: 'second', completed: 12, frac: 0, finishedAt: 2 },
    { callsign: 'fast', completed: 7, frac: 0.5, finishedAt: null },
    { callsign: 'alsofast', completed: 7, frac: 0.5, finishedAt: null },
  ];
  const r = ranks(ships);
  assert.equal(r.get('winner'), 1);
  assert.equal(r.get('second'), 2);
  assert.equal(r.get('alsofast'), 3); // tie with fast → alphabetical
  assert.equal(r.get('fast'), 4);
  assert.equal(r.get('slow'), 5);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: the 3 new tests FAIL (`Cannot find module ... race-layout.js`); rest pass.

- [ ] **Step 3: Implement** — create `board/client/race-layout.js`:

```js
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
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/race-layout.js client/race-layout.test.js
git commit -m "feat(board): pure race row math — progressOf, laneOrder, ranks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Client — GLB sprite snapshots (`ship-sprite.js`)

**Files:**
- Create: `board/client/ship-sprite.js`
- Read first (do not modify): `board/client/ship-mesh.js` — confirm the exported names `preloadShipTemplates`, `createShip`, `disposeShip` and how `createShip` is called in `race-view.js:57-58`; if `createShip` renders a callsign label for non-empty callsigns, keep passing `callsign: ''`.

**Interfaces:**
- Consumes: `preloadShipTemplates(): Promise<Map>`, `createShip({callsign, color, shipModel, template}): THREE.Group`, `disposeShip(group)` from `ship-mesh.js`.
- Produces: `shipSprite(shipModel: string, color: string) -> Promise<string|null>` — PNG data-URL, or `null` when WebGL/assets unavailable. Cached per `(shipModel, color)`; never rejects. Task 5 consumes.

No unit test — WebGL rendering is browser-only; validated by hand in Task 9 (repo convention: props are pedagogy-first, visual paths are hand-verified).

- [ ] **Step 1: Implement** — create `board/client/ship-sprite.js`:

```js
// board/client/ship-sprite.js
// One-time GLB → 2D sprite renders for the race track. Each (shipModel, color)
// pair is rendered once to a small transparent canvas and cached as a data-URL;
// after that the race is plain DOM — no per-frame WebGL. Resolves null when
// WebGL or the models are unavailable; the track shows a tinted glyph instead.
import * as THREE from 'three';
import { createShip, preloadShipTemplates, disposeShip } from './ship-mesh.js';

const SIZE = 64;
const cache = new Map(); // `${shipModel}|${color}` -> Promise<string|null>
let ctx; // lazy { renderer, scene, camera }; null = WebGL unavailable

function setup() {
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(SIZE, SIZE);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 50);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(2, 4, 6);
    scene.add(key);
    return { renderer, scene, camera };
  } catch {
    return null;
  }
}

async function render(shipModel, color) {
  const templates = await preloadShipTemplates();
  if (ctx === undefined) ctx = setup();
  if (!ctx) return null;
  const template = templates.get(shipModel) || templates.get('fighter');
  const ship = createShip({ callsign: '', color, shipModel, template });
  ship.rotation.y = Math.PI / 2; // side profile, nose toward +x — matches track direction
  ctx.scene.add(ship);
  ctx.renderer.render(ctx.scene, ctx.camera);
  const url = ctx.renderer.domElement.toDataURL('image/png');
  ctx.scene.remove(ship);
  disposeShip(ship);
  return url;
}

export function shipSprite(shipModel, color) {
  const k = `${shipModel}|${color}`;
  if (!cache.has(k)) cache.set(k, render(shipModel, color).catch(() => null));
  return cache.get(k);
}
```

If reading `ship-mesh.js` shows ships are much larger/smaller than ~2 world units (race-view framed them in a 20-unit frustum with 1.1 lane gaps, so ~1 unit is expected), adjust the ortho bounds (`±1.6`) so the ship fills ~80% of the canvas — note the chosen value in the commit message.

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: vite build succeeds (this also type-sanity-checks the imports resolve).

- [ ] **Step 3: Commit**

```bash
git add client/ship-sprite.js
git commit -m "feat(board): cached GLB->PNG ship sprites for the 2D race track

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Client — the shared race component (`race-track.js` + CSS)

**Files:**
- Create: `board/client/race-track.js`
- Create: `board/client/race-track.css`

**Interfaces:**
- Consumes: `progressOf/laneOrder/ranks` (Task 3), `shipSprite` (Task 4).
- Produces: `createRaceTrack(container: HTMLElement, { me?: string|null }) -> { update(state), dispose() }` where `state = { phase: 'idle'|'running'|'finished', total: number, ships: [{callsign, completed, frac, finishedAt, color, shipModel}] }` — i.e. the WS `race` message minus `prompts`. Tasks 6 & 7 consume.

No unit test (DOM component; the math it leans on is tested in Task 3). Hand-verified in Task 9.

- [ ] **Step 1: Implement `board/client/race-track.js`**

```js
// board/client/race-track.js
// THE race view. Projector and cockpit render this same DOM component: one row
// per racer stacked top-to-bottom (stable alphabetical — rows never reorder),
// ships glide left→right by completed+frac. No rAF and no WebGL at render time
// (sprites are pre-rendered data-URLs), so reduced-motion/no-WebGL needs no
// separate fallback — this component IS the fallback.
import { progressOf, laneOrder, ranks } from './race-layout.js';
import { shipSprite } from './ship-sprite.js';
import './race-track.css';

const NEUTRAL = '#94a3b8'; // matches the board's roster default colour
const DENSE_AT = 25;       // hide callsign labels at this many racers (~<14px rows)
const MEDALS = ['🥇', '🥈', '🥉'];

export function createRaceTrack(container, { me = null } = {}) {
  const root = document.createElement('div');
  root.className = 'race-track';
  const banner = document.createElement('div');
  banner.className = 'race-banner';
  const rowsEl = document.createElement('div');
  rowsEl.className = 'race-rows';
  root.append(banner, rowsEl);
  container.append(root);

  const rows = new Map(); // callsign -> { el, rankEl, ship, img, glyph, meta, spriteKey }
  let disposed = false;

  function ensureRow(s) {
    let r = rows.get(s.callsign);
    if (r) return r;
    const el = document.createElement('div');
    el.className = 'race-row';
    if (me && s.callsign === me) el.classList.add('me');
    el.title = `@${s.callsign}`;

    const rankEl = document.createElement('span'); rankEl.className = 'rank';
    const label = document.createElement('span'); label.className = 'cs';
    label.textContent = `@${s.callsign}`;
    const lane = document.createElement('span'); lane.className = 'lane';
    const ship = document.createElement('span'); ship.className = 'ship';
    const glyph = document.createElement('span'); glyph.className = 'glyph';
    const img = document.createElement('img'); img.className = 'sprite'; img.alt = ''; img.hidden = true;
    ship.append(glyph, img);
    lane.append(ship);
    const meta = document.createElement('span'); meta.className = 'meta';
    el.append(rankEl, label, lane, meta);
    rowsEl.append(el);

    r = { el, rankEl, ship, img, glyph, meta, spriteKey: null };
    rows.set(s.callsign, r);
    return r;
  }

  function applySprite(r, s) {
    const key = `${s.shipModel}|${s.color}`;
    if (r.spriteKey === key) return;
    r.spriteKey = key;
    r.glyph.style.color = s.color || NEUTRAL;
    shipSprite(s.shipModel, s.color).then((url) => {
      if (disposed || r.spriteKey !== key) return; // stale render — a newer look won
      if (url) { r.img.src = url; r.img.hidden = false; r.glyph.hidden = true; }
      else { r.img.hidden = true; r.glyph.hidden = false; }
    });
  }

  function bannerText(phase, ships) {
    if (phase === 'idle') return ships.length ? 'WAITING FOR LAUNCH…' : 'NO RACERS YET — open your ship’s READY link';
    if (phase === 'finished') {
      const podium = ships.filter((s) => s.finishedAt != null)
        .sort((a, b) => a.finishedAt - b.finishedAt).slice(0, 3)
        .map((s, i) => `${MEDALS[i]} @${s.callsign}`);
      return podium.length ? `FINISH ✦ ${podium.join('  ')}` : 'FINISH ✦';
    }
    return '';
  }

  function update(state) {
    const { phase, total = 12, ships = [] } = state;
    root.dataset.phase = phase;
    rowsEl.dataset.dense = ships.length >= DENSE_AT ? '1' : '';
    banner.textContent = bannerText(phase, ships);

    const order = laneOrder(ships);
    const rk = ranks(ships);
    const seen = new Set();
    order.forEach((s, i) => {
      seen.add(s.callsign);
      const r = ensureRow(s);
      applySprite(r, s);
      const p = progressOf(s.completed, s.frac, total);
      r.ship.style.left = `calc((100% - var(--ship-w)) * ${p.toFixed(4)})`;
      r.rankEl.textContent = String(rk.get(s.callsign));
      r.meta.textContent = s.finishedAt != null
        ? `✦ #${rk.get(s.callsign)}`
        : `${((s.completed || 0) + (s.frac || 0)).toFixed(1)}/${total}`;
      r.el.style.order = String(i); // alphabetical slot, whatever the DOM insertion order was
    });
    for (const [callsign, r] of rows) {
      if (!seen.has(callsign)) { r.el.remove(); rows.delete(callsign); }
    }
  }

  return {
    update,
    dispose() { disposed = true; root.remove(); rows.clear(); },
  };
}
```

- [ ] **Step 2: Implement `board/client/race-track.css`**

```css
/* board/client/race-track.css — the shared race view (projector + cockpit).
   Dark-only, same palette family as style.css / play.css. Rows flex-share the
   viewport height so 40+ racers fit with zero scrolling. */
.race-track {
  --ship-w: 26px;
  --accent: #22d3ee;
  --lane-bg: #1e293b;
  --fg: #e2e8f0;
  --dim: #94a3b8;
  display: flex; flex-direction: column;
  width: 100%; height: 100%; min-height: 0; box-sizing: border-box;
  padding: 0.5rem 1rem;
  font: 13px/1.2 ui-monospace, Menlo, Consolas, monospace;
  color: var(--fg);
  background: #0b1220;
}
.race-banner { min-height: 1.3em; padding: 0.15rem 0; text-align: center; color: var(--dim); }
.race-track[data-phase='finished'] .race-banner { color: var(--accent); }

.race-rows { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 2px; }
.race-track[data-phase='idle'] .race-rows { opacity: 0.55; }

.race-row { flex: 1 1 0; min-height: 10px; max-height: 48px; display: flex; align-items: center; gap: 0.5rem; }
.race-row.me { flex-grow: 2; max-height: 64px; }
.race-row.me .cs { color: var(--accent); font-weight: 700; }

.race-row .rank { width: 2ch; text-align: right; color: var(--dim); font-size: 0.85em; }
.race-row .cs { width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.race-row .meta { width: 8ch; text-align: right; color: var(--dim); font-variant-numeric: tabular-nums; }

.race-row .lane { position: relative; flex: 1; min-width: 0; height: 6px; border-radius: 999px; background: var(--lane-bg); }
.race-row .lane::after { /* finish line */
  content: ''; position: absolute; right: 0; top: -5px; bottom: -5px; width: 2px;
  background: var(--accent); opacity: 0.6;
}
.race-row .ship {
  position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: var(--ship-w); height: var(--ship-w);
  display: grid; place-items: center;
  transition: left 150ms linear;
}
@media (prefers-reduced-motion: reduce) { .race-row .ship { transition: none; } }
.race-row .ship .sprite { width: 100%; height: 100%; display: block; object-fit: contain; }
.race-row .ship .glyph { font-size: 12px; line-height: 1; }
.race-row .ship .glyph::before { content: '▶'; }

/* 25+ racers: reclaim label space, shrink sprites, keep every row legible */
.race-rows[data-dense='1'] .cs { display: none; }
.race-rows[data-dense='1'] { --ship-w: 16px; }
.race-rows[data-dense='1'] .race-row { gap: 0.3rem; }
.race-rows[data-dense='1'] .meta { font-size: 0.8em; width: 6ch; }
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add client/race-track.js client/race-track.css
git commit -m "feat(board): shared DOM race-track component — rows, sprites, live glide

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Projector adopts race-track; delete the old race renderers

**Files:**
- Modify: `board/client/main.js`
- Delete: `board/client/race-view.js`, `board/client/race-fallback.js`, `board/client/track.js`, `board/client/track.test.js`

**Interfaces:**
- Consumes: `createRaceTrack` (Task 5); WS `race` message (`phase`, `total`, `ships`, `view`, `clients`).
- Produces: nothing new — projector behaviour: `view: 'race'` shows the track, `'orbit'` unchanged.

- [ ] **Step 1: Rewrite the race path in `board/client/main.js`**

Replace the two race imports (lines 3–4) with one:

```js
import { createRaceTrack } from './race-track.js';
```

Replace the `lastRaceShips` state (line 16) with the full race state:

```js
let lastRace = { phase: 'idle', total: 12, ships: [] }; // race state (rows view)
```

Replace `makeRace` (lines 40–44):

```js
function makeRace() {
  const v = createRaceTrack(app); // its own fallback: DOM-only, reduced-motion via CSS
  v.update(lastRace);
  return v;
}
```

Replace the reduced-motion listener (lines 54–57) — only orbit needs a rebuild now:

```js
mql.addEventListener('change', (e) => {
  if (mode !== 'orbit') return; // race track handles reduced motion in CSS
  view.dispose();
  view = makeOrbit(shouldUseFallback({ gl, reducedMotion: e.matches }));
});
```

Replace the race branch of `ws.onmessage` (lines 68–73):

```js
    } else if (m.t === 'race') {
      lastRace = { phase: m.phase, total: m.total, ships: m.ships || [] };
      setMode(m.view === 'race' ? 'race' : 'orbit');
      if (mode === 'race') view.update(lastRace);
      if (hudClients) hudClients.textContent = String(m.clients ?? 0);
    }
```

- [ ] **Step 2: Delete the superseded files**

```bash
git rm client/race-view.js client/race-fallback.js client/track.js client/track.test.js
```

- [ ] **Step 3: Verify nothing else referenced them, tests pass, build passes**

Run: `grep -rn "race-view\|race-fallback\|from './track" client/ src/ && echo LEFTOVER || echo CLEAN`
Expected: `CLEAN` (grep finds nothing).
Run: `npm test`
Expected: PASS (track.test.js is gone; nothing else breaks).
Run: `npm run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add client/main.js
git commit -m "feat(board): projector renders race via shared race-track; drop 3D race scene

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Cockpit — full-field view + typing dock + frac reporting

**Files:**
- Modify: `board/client/play.html`, `board/client/play.js`, `board/client/play.css`

**Interfaces:**
- Consumes: `createRaceTrack` (Task 5), `typedState` (existing `typing.js`), WS wire contract from Task 2.
- Produces: cockpit sends `{ t: 'progress', completed, frac }` trailing-throttled at 100 ms; completions send immediately (unchanged shape plus frac path).

- [ ] **Step 1: Replace `board/client/play.html` body**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cockpit — Ship It</title>
    <link rel="stylesheet" href="./play.css" />
  </head>
  <body>
    <main id="cockpit">
      <div id="field"></div>
      <div id="dock">
        <p id="status">connecting…</p>
        <pre id="prompt" aria-live="polite"></pre>
        <input id="entry" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
      </div>
    </main>
    <script type="module" src="./play.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Rewrite `board/client/play.js`**

Keeps verbatim: callsign-from-query, denied handling, reconnect loop, optimistic `completed` with server re-sync. Adds: the race-track field and the throttled frac sender.

```js
import './play.css';
import { typedState } from './typing.js';
import { createRaceTrack } from './race-track.js';

const params = new URLSearchParams(location.search);
const callsign = (params.get('callsign') || '').toLowerCase();
const statusEl = document.getElementById('status');
const promptEl = document.getElementById('prompt');
const entry = document.getElementById('entry');
const track = createRaceTrack(document.getElementById('field'), { me: callsign });

let prompts = [];
let phase = 'idle';
let completed = 0;  // my confirmed position (optimistic; server is authoritative)
let synced = false; // true once we've trusted the server's position after (re)connect
let prevPhase = 'idle';

function render() {
  const target = prompts[completed] || '';
  promptEl.textContent = target;
  if (phase === 'running' && completed < prompts.length) {
    const { matched } = typedState(target, entry.value);
    promptEl.dataset.matched = String(matched);
    entry.disabled = false;
  } else {
    entry.disabled = true;
  }
  statusEl.textContent =
    phase === 'running' ? `RACING — ${completed}/${prompts.length}`
    : phase === 'finished' ? 'FINISHED ✦'
    : 'waiting for race…';
}

// Trailing throttle: at most one frac report per 100ms. Completions bypass
// this and send immediately in the input handler.
function fracSender(ws) {
  let timer = null, latest = 0;
  return (frac) => {
    latest = frac;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (ws.readyState === WebSocket.OPEN && phase === 'running') {
        ws.send(JSON.stringify({ t: 'progress', completed, frac: latest }));
      }
    }, 100);
  };
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  const sendFrac = fracSender(ws);
  ws.onopen = () => { synced = false; statusEl.textContent = 'joining…'; ws.send(JSON.stringify({ t: 'join', callsign })); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'denied') { statusEl.textContent = 'Ship not found — run your pipeline first.'; entry.disabled = true; return; }
    if (m.t === 'race') {
      prompts = m.prompts || [];
      phase = m.phase;
      const mine = (m.ships || []).find((s) => s.callsign === callsign);
      const serverCompleted = mine ? mine.completed : 0;
      if (!synced) { completed = serverCompleted; synced = true; }             // (re)connect/reload: trust the server's position
      else if (m.phase === 'running' && prevPhase !== 'running') completed = serverCompleted; // new round: server reset us to 0
      // during a running round, keep the local optimistic `completed`; the server silently rejects bad progress
      prevPhase = m.phase;
      track.update({ phase: m.phase, total: m.total, ships: m.ships || [] });
      render();
    }
  };
  entry.oninput = () => {
    const target = prompts[completed] || '';
    const { matched, done } = typedState(target, entry.value);
    promptEl.dataset.matched = String(matched);
    if (done && phase === 'running') {
      completed += 1;
      entry.value = '';
      ws.send(JSON.stringify({ t: 'progress', completed }));
      render();
    } else if (phase === 'running' && target.length > 0) {
      sendFrac(matched / target.length);
    }
  };
  ws.onclose = () => { statusEl.textContent = 'disconnected — reconnecting…'; setTimeout(connect, 1000); };
  ws.onerror = () => ws.close();
}

if (!callsign) { statusEl.textContent = 'No callsign — open this from your ship’s READY button.'; entry.disabled = true; }
else connect();
```

- [ ] **Step 3: Rewrite `board/client/play.css`**

```css
:root { color-scheme: dark; }
html, body { height: 100%; }
body { margin: 0; background: #0b1220; color: #e2e8f0; font: 16px/1.4 ui-monospace, Menlo, Consolas, monospace; }
#cockpit { height: 100dvh; display: flex; flex-direction: column; }
#field { flex: 1; min-height: 0; }
#dock {
  border-top: 1px solid #1e293b;
  width: 100%; max-width: 640px; margin: 0 auto; box-sizing: border-box;
  padding: 0.75rem 1rem calc(0.75rem + env(safe-area-inset-bottom));
  display: flex; flex-direction: column; gap: 0.5rem;
}
#status { color: #94a3b8; margin: 0; }
#prompt { font-size: 1.4rem; margin: 0; padding: 0.6rem 0.9rem; background: #111a2e; border-radius: 8px; min-height: 1.8rem; }
#entry { font: inherit; font-size: 1.1rem; padding: 0.6rem 0.9rem; background: #0f172a; color: #e2e8f0; border: 2px solid #334155; border-radius: 8px; }
#entry:focus { outline: none; border-color: #22d3ee; }
#entry:disabled { opacity: 0.5; }
```

(The old `#track`/`#me` single-bar styles die with their DOM.)

- [ ] **Step 4: Tests + build**

Run: `npm test`
Expected: PASS.
Run: `npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add client/play.html client/play.js client/play.css
git commit -m "feat(board): cockpit shows the full shared race field + live frac typing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `/operator` console page

**Files:**
- Create: `board/client/operator.html`, `board/client/operator.js`, `board/client/operator.css`
- Modify: `board/src/app.js` (static alias, next to the `/play` alias at line ~95), `board/vite.config.js` (third input)

**Interfaces:**
- Consumes: existing endpoints `POST /api/race/start {session}`, `POST /api/race/reset`, `POST /api/view {view}` with `Authorization: Bearer <OPERATOR_KEY>`; read-only WS `race` broadcasts.
- Produces: instructor-facing page at `/operator`. No new server endpoints; no auth change.

- [ ] **Step 1: Create `board/client/operator.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Operator — Ship It</title>
    <link rel="stylesheet" href="./operator.css" />
  </head>
  <body>
    <main id="ops">
      <h1>MISSION CONTROL · OPS</h1>
      <label>operator key <input id="key" type="password" autocomplete="off" /></label>
      <label>session
        <select id="session">
          <option value="cicd3">cicd3</option>
          <option value="cicd4">cicd4</option>
        </select>
      </label>
      <div class="buttons">
        <button id="start">▶ START RACE</button>
        <button id="reset">↺ RESET</button>
        <button id="view-orbit">VIEW: ORBIT</button>
        <button id="view-race">VIEW: RACE</button>
      </div>
      <p id="result" aria-live="polite"></p>
      <p id="live">connecting…</p>
    </main>
    <script type="module" src="./operator.js"></script>
  </body>
</html>
```

(Session options are hardcoded to match `SESSIONS` in `board/src/corpus.js` — if a session is ever added there, add it here.)

- [ ] **Step 2: Create `board/client/operator.js`**

```js
// board/client/operator.js
// Instructor console: drives the three operator endpoints (key-guarded HTTP
// POSTs) and mirrors the public race broadcast read-only. The key lives in
// localStorage on the operator's device — classroom-grade, rotate per cohort.
import './operator.css';

const keyEl = document.getElementById('key');
const sessionEl = document.getElementById('session');
const resultEl = document.getElementById('result');
const liveEl = document.getElementById('live');

keyEl.value = localStorage.getItem('shipit-operator-key') || '';
keyEl.oninput = () => localStorage.setItem('shipit-operator-key', keyEl.value);

async function call(path, body) {
  resultEl.textContent = `${path} …`;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyEl.value}` },
      body: JSON.stringify(body || {}),
    });
    resultEl.textContent =
      res.status === 202 ? `${path} → 202 ✓`
      : res.status === 401 ? `${path} → 401 wrong key`
      : `${path} → ${res.status}`;
  } catch (err) {
    resultEl.textContent = `${path} → ${err.message}`;
  }
}

document.getElementById('start').onclick = () => call('/api/race/start', { session: sessionEl.value });
document.getElementById('reset').onclick = () => call('/api/race/reset');
document.getElementById('view-orbit').onclick = () => call('/api/view', { view: 'orbit' });
document.getElementById('view-race').onclick = () => call('/api/view', { view: 'race' });

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'race') liveEl.textContent = `phase: ${m.phase} · racers: ${(m.ships || []).length} · viewers: ${m.clients ?? 0}`;
  };
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onerror = () => ws.close();
}
connect();
```

- [ ] **Step 3: Create `board/client/operator.css`**

```css
:root { color-scheme: dark; }
body { margin: 0; background: #0b1220; color: #e2e8f0; font: 16px/1.5 ui-monospace, Menlo, Consolas, monospace; }
#ops { max-width: 420px; margin: 0 auto; padding: 2rem 1rem; display: flex; flex-direction: column; gap: 1rem; }
h1 { font-size: 1.1rem; letter-spacing: 0.1em; color: #22d3ee; margin: 0; }
label { display: flex; flex-direction: column; gap: 0.3rem; color: #94a3b8; font-size: 0.9rem; }
input, select { font: inherit; padding: 0.5rem 0.75rem; background: #0f172a; color: #e2e8f0; border: 2px solid #334155; border-radius: 8px; }
input:focus, select:focus { outline: none; border-color: #22d3ee; }
.buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
button { font: inherit; padding: 0.75rem; background: #111a2e; color: #e2e8f0; border: 2px solid #334155; border-radius: 8px; cursor: pointer; }
button:hover { border-color: #22d3ee; }
#start { grid-column: 1 / -1; border-color: #22d3ee; color: #22d3ee; }
#result, #live { margin: 0; color: #94a3b8; min-height: 1.5em; }
```

- [ ] **Step 4: Wire the route + build input**

In `board/src/app.js`, directly under `if (rel === '/play') rel = '/play.html';` add:

```js
      if (rel === '/operator') rel = '/operator.html';
```

In `board/vite.config.js`, extend `rollupOptions.input`:

```js
    rollupOptions: { input: { main: r('client/index.html'), play: r('client/play.html'), operator: r('client/operator.html') } },
```

- [ ] **Step 5: Tests + build**

Run: `npm test`
Expected: PASS.
Run: `npm run build && ls dist/operator.html`
Expected: build succeeds; `dist/operator.html` exists.

- [ ] **Step 6: Commit**

```bash
git add client/operator.html client/operator.js client/operator.css src/app.js vite.config.js
git commit -m "feat(board): /operator console — start/reset/view buttons replace curl

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end verification (hand-driven)

**Files:** none (verification only).

- [ ] **Step 1: Full test suite + clean build**

Run: `npm test && npm run build`
Expected: all tests pass, build clean.

- [ ] **Step 2: Boot a dev board and walk the whole flow**

```bash
OPERATOR_KEY= node src/index.js   # dev mode: operator endpoints open, event POSTs open
```

Then verify in a browser (all on `http://localhost:3000`):

1. Seed two ships: `curl -X POST localhost:3000/api/event -H 'content-type: application/json' -d '{"callsign":"alpha","stage":"liftoff","status":"shipped","color":"#22d3ee","shipModel":"fighter"}'` and the same with `"callsign":"bravo","color":"red","shipModel":"hauler"`.
2. Open `/` (projector), `/play?callsign=alpha` and `/play?callsign=bravo` (two tabs), `/operator` (fourth tab).
3. `/operator`: leave key empty (dev mode), press **VIEW: RACE** → projector flips to the rows view, both ships on the start line, banner `WAITING FOR LAUNCH…`.
4. Press **▶ START RACE** (session cicd3) → both cockpits' inputs enable simultaneously; `/operator` live line shows `phase: running · racers: 2`.
5. Type in alpha's tab: its ship **glides smoothly** mid-prompt on BOTH the cockpit and the projector (not just on completion). Verify bravo's tab shows alpha moving too.
6. Check ship sprites show the real models/colors (cyan fighter, red hauler); rank chips update as they overtake; rows never swap positions.
7. Finish both racers → banner shows `FINISH ✦ 🥇 … 🥈 …`, finished rows show `✦ #N`.
8. **RESET** → back to `WAITING FOR LAUNCH…`; **VIEW: ORBIT** → projector returns to orbit.
9. Reduced-motion: in devtools, emulate `prefers-reduced-motion: reduce` → ships step instead of glide, everything else identical.
10. Wrong key: set any key on the server (`OPERATOR_KEY=k node src/index.js`), enter a wrong key on `/operator`, press START → result line shows `401 wrong key`.

- [ ] **Step 3: Density sanity check**

Seed 40 ships and confirm rows shrink, labels hide, no scrolling, `me` row still highlighted:

```bash
for i in $(seq 1 40); do curl -s -X POST localhost:3000/api/event -H 'content-type: application/json' -d "{\"callsign\":\"crew$i\",\"stage\":\"liftoff\",\"status\":\"shipped\",\"color\":\"cyan\",\"shipModel\":\"scout\"}" > /dev/null; done
```

Then join a few via `/play?callsign=crew1` etc., start a race, eyeball `/` at a projector-ish window size AND a phone-ish size (~390×844).

- [ ] **Step 4: Update memory of delivered state** — nothing to commit if all green; if any step failed, fix forward with a `fix(board):` commit and re-run this task from Step 1.
