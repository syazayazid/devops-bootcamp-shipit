# Typing Race Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multiplayer typing-race mode to the board (server-authoritative race state, a `/play` cockpit, a Three.js orthographic race view, operator control) and a READY button to the launchpad, reusing the existing S3 report/roster contract.

**Architecture:** The board already is a WebSocket hub with an in-memory roster broadcast on a 50 ms tick. This plan adds a pure, node-testable race state machine (`race.js`) and command corpus (`corpus.js`) beside the existing `room.js`; wires inbound cockpit messages (join/progress) and operator HTTP endpoints into `app.js`; and adds two board client surfaces — a typing cockpit (`play.html`) and a Three.js ortho race view that reuses the existing ship meshes. The launchpad stays a static site; it only derives the learner's callsign from `location.hostname` and links to `BOARD_URL/play?callsign=…`.

**Tech Stack:** Node 20 ESM, `ws`, Three.js (bundled via Vite, no CDN), Node's built-in `node --test`.

## Global Constraints

- Node 20, ESM only. No CDN — Three.js is bundled by Vite.
- Tests: Node's built-in `node --test` only. **No vitest, no Playwright.** The one learner-facing gate stays `launchpad/scripts/preflight.mjs`.
- `SHIPIT_TOKEN` is a server-only secret — it must **never** appear in any client bundle. The cockpit WebSocket is unauthenticated by design.
- Callsign identity = the learner's GitHub username, derived at runtime from `location.hostname`. Do **not** add `VITE_CALLSIGN` to any workflow.
- Race entry is gated on the roster: a callsign may only race if it is already present (green pipeline = the ticket).
- Board `board/src/ships.js` must stay byte-identical to `launchpad/src/ship-schema.js` for the shared fields — do not edit the ship registry / hue math in this plan.
- Theme-aware, WebGL + reduced-motion fallbacks (follow the existing `fallback.js` pattern).
- Pure logic lives in its own module with a `node --test` file (repo pattern: `orbit.js` ↔ `orbit.test.js`); DOM/Three render shells are thin and unit-test-free.

---

### Task 1: Race state machine (`board/src/race.js`)

The authoritative, in-memory race. Pure and node-testable, mirroring `room.js`. The server owns each racer's position and the round phase; clients only report completions.

**Files:**
- Create: `board/src/race.js`
- Test: `board/test/race.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `class Race`
  - `new Race({ total = 12 })`
  - `race.phase` → `'idle' | 'running' | 'finished'`
  - `race.total` → number
  - `race.prompts` → `string[]`
  - `race.join(callsign)` → racer record `{ completed, finishedAt }` (idempotent; adds at start line)
  - `race.start(prompts)` → `this` (sets prompts, phase `running`, resets all racers)
  - `race.progress(callsign, completed)` → racer record or `null` (accepts only the expected next index)
  - `race.reset()` → sets phase `idle`, clears prompts, zeroes racers
  - `race.snapshot()` → `{ phase, total, prompts, ships: [{ callsign, completed, finishedAt }] }`

- [ ] **Step 1: Write the failing test**

```js
// board/test/race.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Race } from '../src/race.js';

const prompts = (n) => Array.from({ length: n }, (_, i) => `cmd${i + 1}`);

test('join is idempotent and starts at the line', () => {
  const r = new Race({ total: 3 });
  const a = r.join('octocat');
  assert.deepEqual(a, { completed: 0, finishedAt: null });
  r.join('octocat');
  assert.equal(r.snapshot().ships.length, 1);
});

test('start sets running phase, prompts, and zeroes racers', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  assert.equal(r.phase, 'running');
  assert.deepEqual(r.prompts, ['cmd1', 'cmd2', 'cmd3']);
  assert.equal(r.snapshot().ships[0].completed, 0);
});

test('progress advances only on the expected next index', () => {
  const r = new Race({ total: 3 });
  r.join('octocat');
  r.start(prompts(3));
  assert.equal(r.progress('octocat', 1).completed, 1);
  assert.equal(r.progress('octocat', 3).completed, 1); // gap ignored
  assert.equal(r.progress('octocat', 1).completed, 1); // replay ignored
  assert.equal(r.progress('octocat', 2).completed, 2);
});

test('progress is ignored when not running or unknown racer', () => {
  const r = new Race({ total: 3 });
  assert.equal(r.progress('nobody', 1), null);         // idle
  r.join('octocat'); r.start(prompts(3));
  assert.equal(r.progress('ghost', 1), null);          // not joined
});

test('finishing records finish order; all-finished flips phase', () => {
  const r = new Race({ total: 2 });
  r.join('a'); r.join('b'); r.start(prompts(2));
  r.progress('a', 1); r.progress('a', 2);
  assert.equal(r.phase, 'running');                    // b not done
  const a = r.snapshot().ships.find((s) => s.callsign === 'a');
  assert.equal(a.finishedAt, 1);
  r.progress('b', 1); r.progress('b', 2);
  assert.equal(r.phase, 'finished');
  const b = r.snapshot().ships.find((s) => s.callsign === 'b');
  assert.equal(b.finishedAt, 2);
});

test('reset returns to idle and zeroes racers but keeps them joined', () => {
  const r = new Race({ total: 2 });
  r.join('a'); r.start(prompts(2)); r.progress('a', 1);
  r.reset();
  assert.equal(r.phase, 'idle');
  assert.deepEqual(r.prompts, []);
  assert.equal(r.snapshot().ships[0].completed, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd board && node --test test/race.test.js`
Expected: FAIL — `Cannot find module '../src/race.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// board/src/race.js
// The in-memory, authoritative race. Pure and node-testable, like room.js.
// The server owns positions + phase; cockpits only report their next completion.
export class Race {
  constructor({ total = 12 } = {}) {
    this.total = total;
    this.phase = 'idle';        // idle | running | finished
    this.prompts = [];          // identical ordered command list for every racer
    this.racers = new Map();    // callsign -> { completed, finishedAt }
    this._seq = 0;              // monotonic finish-order counter
  }

  join(callsign) {
    if (!this.racers.has(callsign)) this.racers.set(callsign, { completed: 0, finishedAt: null });
    return this.racers.get(callsign);
  }

  start(prompts) {
    this.prompts = prompts.slice(0, this.total);
    this.total = this.prompts.length;
    this.phase = 'running';
    this._seq = 0;
    for (const r of this.racers.values()) { r.completed = 0; r.finishedAt = null; }
    return this;
  }

  progress(callsign, completed) {
    if (this.phase !== 'running') return null;
    const r = this.racers.get(callsign);
    if (!r) return null;
    if (completed !== r.completed + 1 || completed > this.total) return r; // out-of-order/replay
    r.completed = completed;
    if (r.completed >= this.total && r.finishedAt == null) r.finishedAt = ++this._seq;
    if (this._allFinished()) this.phase = 'finished';
    return r;
  }

  reset() {
    this.phase = 'idle';
    this.prompts = [];
    for (const r of this.racers.values()) { r.completed = 0; r.finishedAt = null; }
  }

  snapshot() {
    const ships = [...this.racers.entries()].map(([callsign, r]) => ({
      callsign, completed: r.completed, finishedAt: r.finishedAt,
    }));
    return { phase: this.phase, total: this.total, prompts: this.prompts, ships };
  }

  _allFinished() {
    if (this.racers.size === 0) return false;
    for (const r of this.racers.values()) if (r.finishedAt == null) return false;
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd board && node --test test/race.test.js`
Expected: PASS — all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add board/src/race.js board/test/race.test.js
git commit -m "feat(board): authoritative race state machine"
```

---

### Task 2: Session-gated command corpus (`board/src/corpus.js`)

The pool of CLI commands the race draws prompts from, filtered by session so a race only ever shows commands taught up to that point.

**Files:**
- Create: `board/src/corpus.js`
- Test: `board/test/corpus.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `CORPUS` → `{ linux: string[], git: string[], gh: string[], docker: string[], aws: string[] }`
  - `SESSIONS` → `{ cicd3: string[], cicd4: string[] }` (tool keys unlocked per session)
  - `pool(session)` → `string[]` (flattened unlocked commands; empty array for unknown session)
  - `pickPrompts(session, n = 12, rand = Math.random)` → `string[]` (n distinct commands)

- [ ] **Step 1: Write the failing test**

```js
// board/test/corpus.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, SESSIONS, pool, pickPrompts } from '../src/corpus.js';

test('pool flattens the unlocked tools for a session', () => {
  const p = pool('cicd3');
  assert.ok(p.includes('git status'));
  assert.ok(p.includes('docker build -t'));
  assert.equal(p.length, SESSIONS.cicd3.reduce((n, k) => n + CORPUS[k].length, 0));
});

test('pool is empty for an unknown session', () => {
  assert.deepEqual(pool('nope'), []);
});

test('pickPrompts returns n distinct commands from the pool', () => {
  const picks = pickPrompts('cicd3', 12);
  assert.equal(picks.length, 12);
  assert.equal(new Set(picks).size, 12);
  const p = pool('cicd3');
  for (const cmd of picks) assert.ok(p.includes(cmd));
});

test('pickPrompts is deterministic given a rand stub', () => {
  const first = () => 0;
  const a = pickPrompts('cicd3', 5, first);
  const b = pickPrompts('cicd3', 5, first);
  assert.deepEqual(a, b);
});

test('pickPrompts caps at pool size', () => {
  const picks = pickPrompts('cicd3', 99999);
  assert.equal(picks.length, pool('cicd3').length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd board && node --test test/corpus.test.js`
Expected: FAIL — `Cannot find module '../src/corpus.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// board/src/corpus.js
// Commands the race can quiz, grouped by tool. Session-gated so a race only
// shows commands taught up to that point (inventory: slides repo, up to CI/CD 3).
export const CORPUS = {
  linux: [
    'ls -l', 'cd ..', 'pwd', 'cat file.txt', 'mkdir build', 'touch app.js',
    'cp a.txt b.txt', 'mv old new', 'rm -f tmp', 'chmod +x run.sh', 'grep -r TODO',
    'ps aux', 'kill -9 123', 'curl -sS localhost', 'ssh ec2-user@host', 'tail -f log',
  ],
  git: [
    'git init', 'git status', 'git add .', 'git commit -m "wip"', 'git push',
    'git pull', 'git switch main', 'git checkout -b feat', 'git merge dev', 'git log --oneline',
  ],
  gh: [
    'gh repo fork', 'gh repo sync', 'gh pr create', 'gh pr merge', 'gh secret set SHIPIT_TOKEN',
    'gh variable set BOARD_URL', 'gh secret list', 'gh workflow view',
  ],
  docker: [
    'docker build -t app .', 'docker run -d -p 3000:3000 app', 'docker ps -a', 'docker pull nginx',
    'docker logs -f app', 'docker exec -it app sh', 'docker stop app', 'docker push app', 'docker compose up -d',
  ],
  aws: [
    'aws configure', 'aws sts get-caller-identity', 'aws s3 ls', 'aws s3 cp f s3://b',
    'aws ec2 describe-instances', 'aws ssm start-session', 'aws ecr get-login-password',
  ],
};

// Which tool pools are unlocked by (i.e. taught by) a given session.
export const SESSIONS = {
  cicd3: ['linux', 'git', 'gh', 'docker', 'aws'],
  cicd4: ['linux', 'git', 'gh', 'docker', 'aws'],
};

export function pool(session) {
  const tools = SESSIONS[session] || [];
  return tools.flatMap((k) => CORPUS[k] || []);
}

export function pickPrompts(session, n = 12, rand = Math.random) {
  const avail = [...pool(session)];
  const picked = [];
  while (picked.length < n && avail.length) {
    const i = Math.floor(rand() * avail.length);
    picked.push(avail.splice(i, 1)[0]);
  }
  return picked;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd board && node --test test/corpus.test.js`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add board/src/corpus.js board/test/corpus.test.js
git commit -m "feat(board): session-gated command corpus"
```

---

### Task 3: Server wiring — cockpit WebSocket, roster gate, operator control (`board/src/app.js`)

Wire the race + corpus into the HTTP/WS server: accept inbound cockpit `join`/`progress`, gate `join` on the roster, add operator HTTP endpoints to start/reset a race and toggle the projector view, and broadcast an enriched race snapshot on its own dirty tick.

**Files:**
- Modify: `board/src/room.js` (add `has`/`get` to `Roster`)
- Modify: `board/src/messages.js` (add `raceMsg`)
- Modify: `board/src/app.js` (cockpit WS, operator endpoints, race broadcast)
- Modify: `board/src/index.js` (read `OPERATOR_KEY`)
- Test: `board/test/server.test.js` (append cases)

**Interfaces:**
- Consumes: `Race` (Task 1), `pickPrompts` (Task 2), `Roster`/`sanitizeEvent` (existing), `parse`/`rosterMsg` (existing).
- Produces:
  - `Roster.prototype.has(callsign)` → boolean
  - `Roster.prototype.get(callsign)` → event or undefined
  - `raceMsg(snapshot, view, clients)` → JSON string `{ t:'race', view, clients, phase, total, prompts, ships }` where each `ship` is enriched with `color`/`shipModel` from the roster
  - `createServer({ port, token, operatorKey, publicDir })` — now also handles `POST /api/race/start` `{ session }`, `POST /api/race/reset`, `POST /api/view` `{ view }` (all guarded by `operatorKey` when set), and inbound cockpit WS messages
  - Cockpit inbound: `{ t:'join', callsign }`, `{ t:'progress', completed }`
  - Server → cockpit on gate failure: `{ t:'denied', reason:'not-on-roster' }`

- [ ] **Step 1: Write the failing test**

```js
// board/test/server.test.js  — APPEND these to the existing file
import { Race } from '../src/race.js'; // (add alongside existing imports if not present)

const opHeader = (key) => ({ authorization: `Bearer ${key}` });
const postTo = (port, path, body, headers = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });

test('cockpit join is denied for a callsign not on the roster', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: null });
  const port = app.port;
  try {
    const cockpit = await openClient(port);
    await nextMsg(cockpit, (m) => m.t === 'roster');
    cockpit.send(JSON.stringify({ t: 'join', callsign: 'stranger' }));
    const denied = await nextMsg(cockpit, (m) => m.t === 'denied');
    assert.equal(denied.reason, 'not-on-roster');
    cockpit.close();
  } finally { await app.close(); }
});

test('operator can start a race; cockpit progress advances the snapshot', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: 'op-key' });
  const port = app.port;
  try {
    await post(port, ev); // ev = octocat, from existing top-of-file fixture — now on the roster
    const cockpit = await openClient(port);
    await nextMsg(cockpit, (m) => m.t === 'roster');
    cockpit.send(JSON.stringify({ t: 'join', callsign: 'octocat' }));

    assert.equal((await postTo(port, '/api/race/start', { session: 'cicd3' }, opHeader('op-key'))).status, 202);
    const running = await nextMsg(cockpit, (m) => m.t === 'race' && m.phase === 'running');
    assert.equal(running.prompts.length, 12);
    const mine = running.ships.find((s) => s.callsign === 'octocat');
    assert.equal(mine.completed, 0);
    assert.equal(mine.color, '#22d3ee'); // enriched from the roster

    cockpit.send(JSON.stringify({ t: 'progress', completed: 1 }));
    const advanced = await nextMsg(cockpit, (m) => m.t === 'race' && m.ships.some((s) => s.callsign === 'octocat' && s.completed === 1));
    assert.ok(advanced);
    cockpit.close();
  } finally { await app.close(); }
});

test('operator endpoints require the operator key when set', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: 'op-key' });
  const port = app.port;
  try {
    assert.equal((await postTo(port, '/api/race/start', {})).status, 401);
    assert.equal((await postTo(port, '/api/race/start', {}, opHeader('wrong'))).status, 401);
    assert.equal((await postTo(port, '/api/view', { view: 'race' }, opHeader('op-key'))).status, 202);
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd board && node --test test/server.test.js`
Expected: FAIL — join is ignored (no `denied`), `/api/race/start` 404s.

- [ ] **Step 3a: Add roster helpers**

```js
// board/src/room.js  — add two methods inside class Roster
  has(callsign) { return this.ships.has(callsign); }
  get(callsign) { return this.ships.get(callsign); }
```

- [ ] **Step 3b: Add the race message builder**

```js
// board/src/messages.js  — append
// Enrich race positions with each ship's roster appearance (color/shipModel).
export const raceMsg = (snap, view, clients, roster) => JSON.stringify({
  t: 'race', view, clients,
  phase: snap.phase, total: snap.total, prompts: snap.prompts,
  ships: snap.ships.map((s) => {
    const r = roster.get(s.callsign);
    return { ...s, color: r?.color, shipModel: r?.shipModel };
  }),
});
```

- [ ] **Step 3c: Rewrite `board/src/app.js`**

```js
// board/src/app.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Roster, sanitizeEvent } from './room.js';
import { parse, rosterMsg, raceMsg } from './messages.js';
import { Race } from './race.js';
import { pickPrompts } from './corpus.js';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
};

function send(ws, msg) { try { if (ws.readyState === 1) ws.send(msg); } catch { /* ignore */ } }
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Constant-time bearer check.
function authorized(req, token) {
  const m = /^Bearer (.+)$/.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) req.destroy(new Error('too large')); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function createServer({ port = 3000, token = null, operatorKey = null, publicDir = DIST } = {}) {
  const roster = new Roster();
  const race = new Race({ total: 12 });
  const clients = new Set();
  let view = 'orbit';        // projector view: 'orbit' | 'race'
  let session = 'cicd3';
  let dirty = false;         // roster changed
  let raceDirty = false;     // race state or view changed

  // Operator-guarded control endpoints. When operatorKey is null, open (dev).
  function operate(req, res, fn) {
    if (operatorKey && !authorized(req, operatorKey)) return json(res, 401, { error: 'unauthorized' });
    return fn();
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/api/event') {
        if (token && !authorized(req, token)) return json(res, 401, { error: 'unauthorized' });
        const event = sanitizeEvent(parse(await readBody(req)) || {});
        if (!event) return json(res, 400, { error: 'invalid event: need callsign + known stage/status' });
        roster.upsert(event);
        dirty = true;
        return json(res, 202, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/api/race/start') {
        const body = parse(await readBody(req)) || {};
        return operate(req, res, () => {
          if (body.session) session = String(body.session);
          race.start(pickPrompts(session, race.total));
          raceDirty = true;
          return json(res, 202, { ok: true });
        });
      }
      if (req.method === 'POST' && req.url === '/api/race/reset') {
        await readBody(req);
        return operate(req, res, () => { race.reset(); raceDirty = true; return json(res, 202, { ok: true }); });
      }
      if (req.method === 'POST' && req.url === '/api/view') {
        const body = parse(await readBody(req)) || {};
        return operate(req, res, () => {
          if (body.view === 'orbit' || body.view === 'race') view = body.view;
          raceDirty = true;
          return json(res, 202, { ok: true });
        });
      }
      // static: serve the Vite-built client
      let rel = decodeURIComponent((req.url || '/').split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.join(publicDir, path.normalize(rel));
      if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end('forbidden'); }
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch { res.writeHead(404); res.end('not found'); }
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    clients.add(ws);
    dirty = true; raceDirty = true; // snapshot on next tick (see room note)
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'join' && typeof m.callsign === 'string') {
        if (!roster.has(m.callsign)) return send(ws, JSON.stringify({ t: 'denied', reason: 'not-on-roster' }));
        ws.callsign = m.callsign;
        race.join(m.callsign);
        raceDirty = true;
      } else if (m.t === 'progress' && ws.callsign && Number.isInteger(m.completed)) {
        race.progress(ws.callsign, m.completed);
        raceDirty = true;
      }
    });
    const drop = () => clients.delete(ws);
    ws.on('close', drop);
    ws.on('error', drop);
  });

  const tick = setInterval(() => {
    if (dirty) { dirty = false; const msg = rosterMsg(roster.list()); for (const ws of clients) send(ws, msg); }
    if (raceDirty) { raceDirty = false; const msg = raceMsg(race.snapshot(), view, clients.size, roster); for (const ws of clients) send(ws, msg); }
  }, 50);

  server.listen(port);
  return {
    get port() { const a = server.address(); return a && typeof a === 'object' ? a.port : port; },
    roster, race, server, wss,
    close() { clearInterval(tick); wss.close(); return new Promise((r) => server.close(r)); },
  };
}
```

Note on the operator endpoints: each reads its JSON body with `await readBody(req)` *before* calling `operate`, because `readBody` is async while `operate`'s callback is sync — the `await` cannot live inside the callback.

- [ ] **Step 3d: Wire `OPERATOR_KEY` in the entrypoint**

```js
// board/src/index.js
import { createServer } from './app.js';

const port = Number(process.env.PORT) || 3000;
const token = process.env.SHIPIT_TOKEN || null;
const operatorKey = process.env.OPERATOR_KEY || null;

createServer({ port, token, operatorKey });

if (token) {
  console.log(`[board] Mission Control on :${port} — auth ENFORCED (Bearer $SHIPIT_TOKEN)`);
} else {
  console.warn('[board] SHIPIT_TOKEN unset — accepting UNAUTHENTICATED events (dev mode)');
  console.log(`[board] Mission Control on :${port}`);
}
if (!operatorKey) console.warn('[board] OPERATOR_KEY unset — race controls are OPEN (dev mode)');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd board && node --test`
Expected: PASS — existing `room`/`server` tests plus the three new server cases and Tasks 1–2.

- [ ] **Step 5: Commit**

```bash
git add board/src/app.js board/src/index.js board/src/room.js board/src/messages.js board/test/server.test.js
git commit -m "feat(board): cockpit ws + roster-gated join + operator race control"
```

---

### Task 4: Launchpad callsign derivation (`launchpad/src/callsign.js`)

Derive the learner's GitHub username from the Pages hostname at runtime — no build var, no pin reversal.

**Files:**
- Create: `launchpad/src/callsign.js`
- Test: `launchpad/src/callsign.test.mjs`

**Interfaces:**
- Consumes: nothing (pure for the tested part).
- Produces:
  - `callsignFromHostname(hostname)` → string (username for `<user>.github.io`, else `''`)
  - `resolveCallsign()` → string (hostname first, then `VITE_CALLSIGN`, then `''`) — thin runtime wrapper

- [ ] **Step 1: Write the failing test**

```js
// launchpad/src/callsign.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callsignFromHostname } from './callsign.js';

test('extracts the username from a github.io hostname', () => {
  assert.equal(callsignFromHostname('octocat.github.io'), 'octocat');
  assert.equal(callsignFromHostname('My-User.github.io'), 'my-user'); // lowercased
});

test('returns empty for non-Pages hostnames', () => {
  assert.equal(callsignFromHostname('localhost'), '');
  assert.equal(callsignFromHostname('example.com'), '');
  assert.equal(callsignFromHostname('octocat.github.io.evil.com'), '');
  assert.equal(callsignFromHostname(''), '');
  assert.equal(callsignFromHostname(undefined), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd launchpad && node --test src/callsign.test.mjs`
Expected: FAIL — `Cannot find module './callsign.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// launchpad/src/callsign.js
// Identity = the learner's GitHub username, derived from the Pages hostname at
// runtime: `user.github.io` (user + project pages both) -> `user`. No build var,
// no VITE_CALLSIGN in the taught workflow. Falls back to VITE_CALLSIGN then ''.
export function callsignFromHostname(hostname) {
  if (typeof hostname !== 'string') return '';
  const m = /^([a-z0-9-]+)\.github\.io$/.exec(hostname.toLowerCase());
  return m ? m[1] : '';
}

export function resolveCallsign() {
  return callsignFromHostname(window.location.hostname) || import.meta.env.VITE_CALLSIGN || '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd launchpad && node --test src/callsign.test.mjs`
Expected: PASS — both tests.

- [ ] **Step 5: Commit**

```bash
git add launchpad/src/callsign.js launchpad/src/callsign.test.mjs
git commit -m "feat(launchpad): derive callsign from Pages hostname"
```

---

### Task 5: Launchpad READY button

Give the static site a button that carries the learner to the board cockpit as themselves. Inert (hidden) until both a callsign and `VITE_BOARD_URL` are known.

**Files:**
- Create: `launchpad/src/ready.js`
- Modify: `launchpad/src/main.js` (use `resolveCallsign`, mount the button)
- Modify: `launchpad/src/style.css` (button styling)

**Interfaces:**
- Consumes: `resolveCallsign` (Task 4).
- Produces: `renderReady(root, callsign)` → the button element or `null` (null when no callsign or no `VITE_BOARD_URL`).

- [ ] **Step 1: Write `ready.js`**

```js
// launchpad/src/ready.js
// The one bridge from the static site to the server: a link to the board cockpit,
// carrying the learner's callsign. Hidden unless we know both who they are and
// where the board is. BOARD_URL is a public build var — never a secret.
export function readyHref(boardUrl, callsign) {
  if (!boardUrl || !callsign) return null;
  return `${boardUrl.replace(/\/$/, '')}/play?callsign=${encodeURIComponent(callsign)}`;
}

export function renderReady(root, callsign) {
  const href = readyHref(import.meta.env.VITE_BOARD_URL, callsign);
  if (!href) return null;
  const a = document.createElement('a');
  a.className = 'ready';
  a.href = href;
  a.textContent = 'READY ▸ JOIN RACE';
  root.append(a);
  return a;
}
```

- [ ] **Step 2: Wire it into `main.js`**

Replace the callsign line and add the button mount. In `launchpad/src/main.js`:

```js
// change the import block top of file — add:
import { resolveCallsign } from './callsign.js';
import { renderReady } from './ready.js';

// replace:  const callsign = import.meta.env.VITE_CALLSIGN || '';
const callsign = resolveCallsign();
```

Then, at the very end of the file (after the `if/else` fallback block), mount the button so it appears in both the WebGL and fallback paths:

```js
renderReady(app, callsign);
```

- [ ] **Step 3: Style the button**

```css
/* launchpad/src/style.css  — append */
.ready {
  position: fixed;
  bottom: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  padding: 0.7rem 1.4rem;
  font: 700 0.95rem/1 ui-monospace, Menlo, Consolas, monospace;
  letter-spacing: 0.08em;
  color: #0b1220;
  background: var(--ship-color, #22d3ee);
  border-radius: 999px;
  text-decoration: none;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.15), 0 8px 30px rgba(0, 0, 0, 0.45);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.ready:hover { transform: translateX(-50%) translateY(-2px); }
.ready:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
```

- [ ] **Step 4: Verify the build succeeds**

Run: `cd launchpad && VITE_BOARD_URL=https://board.example npm run build`
Expected: PASS — build completes, no errors. (Manual check: `dist/assets/*.js` contains the `/play?callsign=` string. With `VITE_BOARD_URL` unset the button is simply absent.)

- [ ] **Step 5: Commit**

```bash
git add launchpad/src/ready.js launchpad/src/main.js launchpad/src/style.css
git commit -m "feat(launchpad): READY button linking to the board cockpit"
```

---

### Task 6: Board cockpit page (`board/client/play.*`)

The laptop typing surface. Connects to the board, joins as the URL's callsign, shows the current command, and reports each exact-match completion. Registered as a second Vite entry.

**Files:**
- Create: `board/client/typing.js`
- Test: `board/client/typing.test.js`
- Create: `board/client/play.html`
- Create: `board/client/play.js`
- Modify: `board/vite.config.js` (multi-page input)

**Interfaces:**
- Consumes: race broadcast `{ t:'race', phase, prompts, ships }`, `{ t:'denied' }` (Task 3).
- Produces:
  - `typedState(target, input)` → `{ matched: number, done: boolean }` (`matched` = length of the correct leading prefix; `done` = exact full match)
  - cockpit sends `{ t:'join', callsign }` on open and `{ t:'progress', completed }` on each completion.

- [ ] **Step 1: Write the failing test**

```js
// board/client/typing.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { typedState } from './typing.js';

test('matched counts the correct leading prefix', () => {
  assert.deepEqual(typedState('git status', 'git s'), { matched: 5, done: false });
  assert.deepEqual(typedState('git status', 'git x'), { matched: 4, done: false });
  assert.deepEqual(typedState('git status', ''), { matched: 0, done: false });
});

test('done is true only on an exact full match', () => {
  assert.deepEqual(typedState('ls -l', 'ls -l'), { matched: 5, done: true });
  assert.deepEqual(typedState('ls -l', 'ls -l '), { matched: 5, done: false }); // trailing extra
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd board && node --test client/typing.test.js`
Expected: FAIL — `Cannot find module './typing.js'`.

- [ ] **Step 3: Write `typing.js`**

```js
// board/client/typing.js
// Pure keystroke evaluation for the cockpit. `matched` drives per-character
// colouring; `done` fires the progress report. Correctness is judged client-side
// (the server stays authoritative over position — see the spec's security note).
export function typedState(target, input) {
  let matched = 0;
  while (matched < input.length && matched < target.length && input[matched] === target[matched]) matched++;
  return { matched, done: input === target };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd board && node --test client/typing.test.js`
Expected: PASS — both tests.

- [ ] **Step 5: Write the cockpit page**

```html
<!-- board/client/play.html -->
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
      <p id="status">connecting…</p>
      <div id="track"><div id="me"></div></div>
      <pre id="prompt" aria-live="polite"></pre>
      <input id="entry" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus />
    </main>
    <script type="module" src="./play.js"></script>
  </body>
</html>
```

```js
// board/client/play.js
import './play.css';
import { typedState } from './typing.js';

const params = new URLSearchParams(location.search);
const callsign = (params.get('callsign') || '').toLowerCase();
const statusEl = document.getElementById('status');
const promptEl = document.getElementById('prompt');
const entry = document.getElementById('entry');
const me = document.getElementById('me');

let prompts = [];
let phase = 'idle';
let completed = 0; // my confirmed position

function render() {
  const target = prompts[completed] || '';
  promptEl.textContent = target;
  if (phase === 'running' && completed < prompts.length) {
    const { matched } = typedState(target, entry.value);
    promptEl.dataset.matched = String(matched);
    me.style.left = `${(completed / Math.max(1, prompts.length)) * 100}%`;
    entry.disabled = false;
  } else {
    entry.disabled = true;
  }
  statusEl.textContent =
    phase === 'running' ? `RACING — ${completed}/${prompts.length}`
    : phase === 'finished' ? 'FINISHED ✦'
    : 'waiting for race…';
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => { statusEl.textContent = 'joining…'; ws.send(JSON.stringify({ t: 'join', callsign })); };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'denied') { statusEl.textContent = 'Ship not found — run your pipeline first.'; entry.disabled = true; return; }
    if (m.t === 'race') {
      prompts = m.prompts || [];
      phase = m.phase;
      const mine = (m.ships || []).find((s) => s.callsign === callsign);
      if (mine && phase !== 'running') completed = mine.completed; // resync when idle/finished
      if (phase === 'running' && mine && mine.completed === 0 && completed !== 0) completed = 0; // fresh round
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
    }
  };
  ws.onclose = () => { statusEl.textContent = 'disconnected — reconnecting…'; setTimeout(connect, 1000); };
  ws.onerror = () => ws.close();
}

if (!callsign) { statusEl.textContent = 'No callsign — open this from your ship’s READY button.'; entry.disabled = true; }
else connect();
```

```css
/* board/client/play.css */
:root { color-scheme: dark; }
body { margin: 0; background: #0b1220; color: #e2e8f0; font: 16px/1.4 ui-monospace, Menlo, Consolas, monospace; }
#cockpit { max-width: 640px; margin: 0 auto; padding: 2rem 1rem; display: flex; flex-direction: column; gap: 1rem; }
#status { color: #94a3b8; margin: 0; }
#track { position: relative; height: 10px; background: #1e293b; border-radius: 999px; }
#me { position: absolute; top: -3px; left: 0; width: 16px; height: 16px; border-radius: 50%; background: #22d3ee; transition: left 0.15s ease; }
#prompt { font-size: 1.6rem; margin: 0; padding: 0.75rem 1rem; background: #111a2e; border-radius: 8px; min-height: 2rem; }
#entry { font: inherit; font-size: 1.2rem; padding: 0.75rem 1rem; background: #0f172a; color: #e2e8f0; border: 2px solid #334155; border-radius: 8px; }
#entry:focus { outline: none; border-color: #22d3ee; }
#entry:disabled { opacity: 0.5; }
```

- [ ] **Step 6: Register the second Vite entry**

```js
// board/vite.config.js
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

// The client lives in client/; build it to board/dist, which the Node server
// serves static. base: './' so it works behind any path. Two pages: the
// projector spectator (index.html) and the laptop cockpit (play.html).
export default defineConfig({
  root: 'client',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: { input: { main: r('client/index.html'), play: r('client/play.html') } },
  },
});
```

The server already serves any built file under `dist`; requests to `/play` resolve because the cockpit's built page is `dist/play.html`. Add a fallback so the extensionless `/play` maps to `play.html` — in `board/src/app.js`, just before the `rel === '/' ...` line:

```js
      if (rel === '/play') rel = '/play.html';
```

- [ ] **Step 7: Verify the build + serve**

Run: `cd board && npm run build && node --test client/typing.test.js`
Expected: PASS — build emits `dist/index.html` and `dist/play.html`; typing test green.

- [ ] **Step 8: Commit**

```bash
git add board/client/typing.js board/client/typing.test.js board/client/play.html board/client/play.js board/client/play.css board/vite.config.js board/src/app.js
git commit -m "feat(board): typing cockpit page (/play)"
```

---

### Task 7: Board race view (Three.js ortho) + projector view switch

The projector's race track. A Three.js orthographic scene that reuses the existing ship meshes, positions each ship by race progress, and shows a live server HUD. `main.js` switches between the orbit view and the race view on the operator's toggle.

**Files:**
- Create: `board/client/track.js`
- Test: `board/client/track.test.js`
- Create: `board/client/race-view.js`
- Modify: `board/client/main.js` (handle `{ t:'race' }`, swap views, drive the HUD)
- Modify: `board/client/index.html` (HUD element)

**Interfaces:**
- Consumes: `preloadShipTemplates`, `createShip` (existing `ship-mesh.js`); race broadcast `{ t:'race', view, clients, phase, ships }` (Task 3).
- Produces:
  - `trackPosition(completed, total, lane, { length = 16, gap = 1.1 } = {})` → `{ x, y, z }`
  - `createRaceView(container)` → `{ update(ships), dispose() }` (same shape as `createScene`)

- [ ] **Step 1: Write the failing test**

```js
// board/client/track.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackPosition } from './track.js';

test('x runs left→right with progress, centered on the track', () => {
  const start = trackPosition(0, 12, 0, { length: 12 });
  const end = trackPosition(12, 12, 0, { length: 12 });
  assert.equal(start.x, -6);
  assert.equal(end.x, 6);
});

test('lane sets the vertical slot; z is flat', () => {
  const lane0 = trackPosition(0, 12, 0, { gap: 1 });
  const lane2 = trackPosition(0, 12, 2, { gap: 1 });
  assert.equal(lane2.y - lane0.y, 2);
  assert.equal(lane0.z, 0);
});

test('total of 0 does not divide by zero', () => {
  const p = trackPosition(0, 0, 0, { length: 12 });
  assert.equal(Number.isFinite(p.x), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd board && node --test client/track.test.js`
Expected: FAIL — `Cannot find module './track.js'`.

- [ ] **Step 3: Write `track.js`**

```js
// board/client/track.js
// Pure race → world mapping. x is progress along the track (centered on 0);
// y is the racer's lane; z is flat. Mirrors orbit.js's role for the orbit scene.
export function trackPosition(completed, total, lane, { length = 16, gap = 1.1 } = {}) {
  const frac = total > 0 ? Math.min(1, completed / total) : 0;
  return { x: frac * length - length / 2, y: lane * gap, z: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd board && node --test client/track.test.js`
Expected: PASS — all 3 tests.

- [ ] **Step 5: Write `race-view.js`**

```js
// board/client/race-view.js
import * as THREE from 'three';
import { createShip, preloadShipTemplates } from './ship-mesh.js';
import { trackPosition } from './track.js';
import { PALETTE } from './theme.js';

// A side-on orthographic race track. Reuses the same GLB ships as the orbit
// scene; positions them by race progress. Same { update, dispose } shape as
// createScene so main.js can swap the two freely.
export function createRaceView(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.bg);

  const aspect = container.clientWidth / Math.max(1, container.clientHeight);
  const H = 10; // half-height of the ortho frustum in world units
  const camera = new THREE.OrthographicCamera(-H * aspect, H * aspect, H, -H, 0.1, 100);
  camera.position.set(0, 3, 20); camera.lookAt(0, 3, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 0.8));
  const key = new THREE.DirectionalLight(PALETTE.dir, 0.9); key.position.set(2, 6, 8); scene.add(key);

  // Finish line at the right edge of the track.
  const finish = new THREE.Mesh(
    new THREE.PlaneGeometry(0.15, 16),
    new THREE.MeshBasicMaterial({ color: PALETTE.ring }),
  );
  finish.position.set(8, 3, -0.5); scene.add(finish);

  const ships = new Map(); // callsign -> { group, data }
  let templates = null;
  let pending = null;
  let disposed = false;
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();

  function laneOf(list) {
    const sorted = [...list].sort((a, b) => (a.callsign < b.callsign ? -1 : 1));
    const map = new Map();
    sorted.forEach((s, i) => map.set(s.callsign, i - (sorted.length - 1) / 2));
    return map;
  }

  function update(list) {
    if (!templates) { pending = list; return; }
    const seen = new Set();
    const lanes = laneOf(list);
    list.forEach((s) => {
      seen.add(s.callsign);
      let rec = ships.get(s.callsign);
      if (!rec || rec.data.color !== s.color || rec.data.shipModel !== s.shipModel) {
        if (rec) scene.remove(rec.group);
        const template = templates.get(s.shipModel) || templates.get('fighter');
        const group = createShip({ callsign: s.callsign, color: s.color || '#94a3b8', shipModel: s.shipModel, template });
        group.rotation.y = Math.PI / 2; // nose down the track (+x)
        scene.add(group);
        rec = { group };
        ships.set(s.callsign, rec);
      }
      rec.data = s;
      rec.target = trackPosition(s.completed || 0, s.total || 12, lanes.get(s.callsign) || 0);
    });
    for (const [callsign, rec] of ships) {
      if (!seen.has(callsign)) { scene.remove(rec.group); ships.delete(callsign); }
    }
  }

  let raf = 0;
  function frame() {
    const dt = clock.getDelta();
    const damp = 1 - Math.exp(-6 * dt);
    for (const rec of ships.values()) {
      if (!rec.target) continue;
      tmp.set(rec.target.x, 3 + rec.target.y, rec.target.z);
      rec.group.position.lerp(tmp, damp);
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  frame();

  function onResize() {
    const w = container.clientWidth, h = container.clientHeight, a = w / Math.max(1, h);
    camera.left = -H * a; camera.right = H * a; camera.top = H; camera.bottom = -H;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', onResize);
  onResize();

  preloadShipTemplates().then((t) => {
    if (disposed) return;
    templates = t;
    if (pending) { const l = pending; pending = null; update(l); }
  }).catch(() => { /* orbit view owns the fallback path */ });

  return {
    update,
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      for (const rec of ships.values()) scene.remove(rec.group);
      ships.clear();
      finish.geometry.dispose(); finish.material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
```

- [ ] **Step 6: Add the HUD element to the projector page**

```html
<!-- board/client/index.html — add inside <body>, near the existing #count element -->
<div id="hud" hidden><span id="hud-clients">0</span> connected · <span id="hud-hz">20</span>×/sec</div>
```

- [ ] **Step 7: Switch views in `main.js`**

Rewrite `board/client/main.js`'s connect + view management so a `{ t:'race' }` message with `view: 'race'` swaps in the race view and `view: 'orbit'` swaps back, and the HUD reflects `clients`:

```js
// board/client/main.js
import './style.css';
import { createScene } from './scene.js';
import { createRaceView } from './race-view.js';
import { createFallback, detectWebGL, shouldUseFallback } from './fallback.js';

const app = document.getElementById('app');
const count = document.getElementById('count');
const toasts = document.getElementById('toasts');
const hud = document.getElementById('hud');
const hudClients = document.getElementById('hud-clients');
const gl = detectWebGL();
const mql = window.matchMedia('(prefers-reduced-motion: reduce)');

let lastShips = [];       // roster (orbit)
let lastRaceShips = [];   // race positions
let mode = 'orbit';       // 'orbit' | 'race'
let view = makeOrbit(shouldUseFallback({ gl, reducedMotion: mql.matches }));

function showLiftoff(callsign) {
  if (!toasts) return;
  while (toasts.children.length >= 5) toasts.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = `LIFTOFF ✦ @${callsign}`;
  toasts.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 3000);
}

function makeOrbit(useFallback) {
  const v = useFallback ? createFallback(app) : createScene(app, {
    onLiftoff: showLiftoff,
    onPreloadError: () => { view.dispose(); view = createFallback(app); view.update(lastShips); },
  });
  v.update(lastShips);
  return v;
}

function setMode(next) {
  if (next === mode) return;
  view.dispose();
  mode = next;
  if (mode === 'race') { view = createRaceView(app); view.update(lastRaceShips); if (hud) hud.hidden = false; }
  else { view = makeOrbit(shouldUseFallback({ gl, reducedMotion: mql.matches })); if (hud) hud.hidden = true; }
}

mql.addEventListener('change', (e) => {
  if (mode !== 'orbit') return;
  view.dispose();
  view = makeOrbit(shouldUseFallback({ gl, reducedMotion: e.matches }));
});
window.addEventListener('pagehide', () => view.dispose());

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'roster' && Array.isArray(m.ships)) {
      lastShips = m.ships;
      if (mode === 'orbit') view.update(lastShips);
      if (count) count.textContent = `${lastShips.length} ship${lastShips.length === 1 ? '' : 's'}`;
    } else if (m.t === 'race') {
      lastRaceShips = m.ships || [];
      setMode(m.view === 'race' ? 'race' : 'orbit');
      if (mode === 'race') view.update(lastRaceShips);
      if (hudClients) hudClients.textContent = String(m.clients ?? 0);
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onerror = () => ws.close();
}
connect();
```

- [ ] **Step 8: Verify build + all board tests**

Run: `cd board && npm run build && node --test`
Expected: PASS — build emits `dist/index.html` + `dist/play.html`; every board test green (race, corpus, room, server, orbit, placement, launch, fallback, typing, track).

- [ ] **Step 9: Commit**

```bash
git add board/client/track.js board/client/track.test.js board/client/race-view.js board/client/main.js board/client/index.html
git commit -m "feat(board): ortho race view + operator view switch + server HUD"
```

---

## Self-Review

**1. Spec coverage:**

| Spec item | Task |
|---|---|
| Launchpad stays static + READY button | Task 5 |
| Callsign from `location.hostname`, no `VITE_CALLSIGN` | Tasks 4, 5 |
| `VITE_BOARD_URL` public var, button hidden when unset | Task 5 |
| Board `/play` cockpit, inbound WS | Tasks 3, 6 |
| Authoritative `race.js` | Task 1 |
| Roster gate (green pipeline = ticket) | Task 3 |
| Operator control (`OPERATOR_KEY`, start/reset/view) | Task 3 |
| Session-gated corpus, N=12, tiers by tool | Task 2 |
| Three.js ortho race view reusing `.glb` ships | Task 7 |
| Live server HUD (clients connected) | Task 7 |
| WS protocol (join/progress/race/roster/denied) | Tasks 3, 6, 7 |
| Token never client-side; cockpit WS unauthenticated | Tasks 3, 6 (no token in any client file) |
| Reuse roster color/shipModel for appearance | Task 3 (enrich), Task 7 (render) |
| Tests: `node --test` only, preflight untouched | all tasks |

Kill-server demo, two-URL contrast, and cicd3/cicd4 session framing are operator/slides concerns (slides issue #161), not code — no task required.

**2. Placeholder scan:** The only intentional "write this cleanly yourself" is the operator-endpoint note in Task 3 Step 3c, which is immediately followed by the complete real code for all three endpoints. No TBD/TODO/"handle edge cases" left.

**3. Type consistency:** `race.snapshot()` → `{ phase, total, prompts, ships }` is consumed by `raceMsg` (Task 3) and rendered by cockpit (Task 6) and race view (Task 7) with matching field names (`completed`, `total`, `color`, `shipModel`). `typedState` returns `{ matched, done }` — consumed only in Task 6. `trackPosition(completed, total, lane, opts)` — consumed only in Task 7. `createRaceView` returns `{ update, dispose }` matching `createScene`'s shape used by `main.js`. Consistent.

## Notes for the executor

- Run all board tests with `cd board && node --test` (auto-discovers `test/*.test.js` and `client/*.test.js`).
- Run launchpad unit tests with `cd launchpad && node --test`.
- `board/scripts/smoke.sh` boots the built server for a manual end-to-end check; use it after Task 7 to click through orbit → race with `curl -X POST -H "Authorization: Bearer $OPERATOR_KEY" localhost:3000/api/race/start`.
- Nothing here touches `.github/workflows/` or `launchpad/ship.config.json` — the sync-fork discipline rule holds.
