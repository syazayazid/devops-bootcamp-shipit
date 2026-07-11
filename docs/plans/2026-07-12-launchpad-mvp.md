# Launchpad (Ship) MVP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the learner's customizable ship microsite — a Three.js rocket tinted by a `ship.config.json` the learner edits — that builds to static, passes a config pre-flight gate, and degrades to a static card with no WebGL or reduced motion.

**Architecture:** A Vite app under `launchpad/`. Pure, node-testable logic (config schema/validator, emblem lookup, HTML escaping, fallback decision) lives in small modules with no browser imports; the Three.js scene and DOM rendering are thin and verified visually. The pedagogically-central artifact is `scripts/preflight.mjs` — the exit-code gate wired to `npm test`. All rendering degrades gracefully.

**Tech Stack:** Node 20 (ESM), Vite 6, Three.js 0.169, Node's built-in `node --test` runner (NOT vitest). Poly.pizza rocket `.glb` vendored into `public/`.

## Global Constraints

- **Node 20, ESM only.** Fail loud, no swallowed errors.
- **No CDN.** Bundle Three.js via npm; vendor the rocket `.glb` into `launchpad/public/`.
- **No third-party test framework.** The config gate is `npm test` → `node scripts/preflight.mjs`. Dev-time unit tests use Node's built-in `node --test`. **No `vitest`, no Playwright.**
- **Config file:** `ship.config.json` = `{ shipName, color, emblem }`. `shipName` non-empty ≤ 24 chars; `color` matches `/^#[0-9a-fA-F]{6}$/`; `emblem` ∈ `comet · bolt · star · ring · delta · phoenix`.
- **Identity is NOT in config:** `callsign` = `${{ github.actor }}`, injected later via `VITE_CALLSIGN`; unknown locally → placeholder.
- **Theme-aware + fallbacks:** style for light and dark; `prefers-reduced-motion` and no-WebGL both fall back to a static card.
- **Build:** `vite build` → `dist/`; `vite preview` on `:8080`; `base: './'` so it works under a GitHub Pages subpath.
- **Work directory:** everything in this plan lives under `launchpad/`. Paths below are relative to `launchpad/` unless noted.

---

### Task 1: Config schema + validator (`ship-schema.js`)

The pure core: the allowed values, a strict `validateConfig` (used by the gate), and a lenient `toRenderParams` (used by the browser so a bad config never white-screens the site).

**Files:**
- Create: `launchpad/package.json`
- Create: `launchpad/ship.config.json`
- Create: `launchpad/src/ship-schema.js`
- Test: `launchpad/src/ship-schema.test.mjs`

**Interfaces:**
- Produces:
  - `EMBLEMS: string[]` — the 6 allowed emblem names.
  - `COLOR_RE: RegExp` — `/^#[0-9a-fA-F]{6}$/`.
  - `DEFAULTS: { shipName, color, emblem }`.
  - `validateConfig(cfg) → { ok: boolean, errors: string[] }` — strict.
  - `toRenderParams(cfg) → { shipName, color, emblem }` — lenient, always usable.

- [ ] **Step 1: Write `launchpad/package.json`** (minimal; Vite deps added in Task 3)

```json
{
  "name": "shipit-launchpad",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "The learner ship microsite — a customizable Three.js rocket a pipeline builds, checks, and ships",
  "scripts": {
    "test": "node scripts/preflight.mjs"
  }
}
```

- [ ] **Step 2: Write the starter `launchpad/ship.config.json`**

```json
{
  "shipName": "Nebula Runner",
  "color": "#22d3ee",
  "emblem": "comet"
}
```

- [ ] **Step 3: Write the failing tests** — `launchpad/src/ship-schema.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMBLEMS, validateConfig, toRenderParams, DEFAULTS } from './ship-schema.js';

test('validateConfig accepts a well-formed config', () => {
  const r = validateConfig({ shipName: 'Nebula Runner', color: '#22d3ee', emblem: 'comet' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validateConfig rejects a bad colour', () => {
  const r = validateConfig({ shipName: 'X', color: 'blue', emblem: 'comet' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /colour|color/i);
});

test('validateConfig rejects an unknown emblem', () => {
  const r = validateConfig({ shipName: 'X', color: '#000000', emblem: 'banana' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /emblem/);
});

test('validateConfig rejects an over-long shipName', () => {
  const r = validateConfig({ shipName: 'x'.repeat(25), color: '#000000', emblem: 'comet' });
  assert.equal(r.ok, false);
});

test('validateConfig rejects a non-object', () => {
  assert.equal(validateConfig(null).ok, false);
  assert.equal(validateConfig([]).ok, false);
});

test('toRenderParams falls back to DEFAULTS on garbage', () => {
  assert.deepEqual(toRenderParams({ shipName: '', color: 'nope', emblem: 'x' }), DEFAULTS);
  assert.deepEqual(toRenderParams(null), DEFAULTS);
});

test('toRenderParams keeps valid values and trims shipName', () => {
  const p = toRenderParams({ shipName: '  Comet  ', color: '#ABCDEF', emblem: 'bolt' });
  assert.deepEqual(p, { shipName: 'Comet', color: '#ABCDEF', emblem: 'bolt' });
});

test('all EMBLEMS are lowercase words', () => {
  for (const e of EMBLEMS) assert.match(e, /^[a-z]+$/);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd launchpad && node --test src/ship-schema.test.mjs`
Expected: FAIL — `Cannot find module './ship-schema.js'`.

- [ ] **Step 5: Implement `launchpad/src/ship-schema.js`**

```js
// Pure config core — no browser/node-only imports, so both the CLI gate
// (Node) and the site (Vite) can import it.
export const EMBLEMS = ['comet', 'bolt', 'star', 'ring', 'delta', 'phoenix'];
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const DEFAULTS = { shipName: 'Nebula Runner', color: '#22d3ee', emblem: 'comet' };

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Strict — the pre-flight gate. Returns every problem it finds.
export function validateConfig(cfg) {
  if (!isObject(cfg)) return { ok: false, errors: ['config must be a JSON object'] };
  const errors = [];
  if (typeof cfg.shipName !== 'string' || cfg.shipName.trim().length < 1 || cfg.shipName.length > 24) {
    errors.push('shipName must be a non-empty string of at most 24 characters');
  }
  if (typeof cfg.color !== 'string' || !COLOR_RE.test(cfg.color)) {
    errors.push('color must be a hex string like #22d3ee');
  }
  if (typeof cfg.emblem !== 'string' || !EMBLEMS.includes(cfg.emblem)) {
    errors.push(`emblem must be one of: ${EMBLEMS.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}

// Lenient — the browser. Always returns usable params so a bad config
// (which the gate would have blocked anyway) never white-screens the site.
export function toRenderParams(cfg) {
  const raw = isObject(cfg) ? cfg : {};
  const shipName =
    typeof raw.shipName === 'string' && raw.shipName.trim() ? raw.shipName.trim().slice(0, 24) : DEFAULTS.shipName;
  const color = typeof raw.color === 'string' && COLOR_RE.test(raw.color) ? raw.color : DEFAULTS.color;
  const emblem = typeof raw.emblem === 'string' && EMBLEMS.includes(raw.emblem) ? raw.emblem : DEFAULTS.emblem;
  return { shipName, color, emblem };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd launchpad && node --test src/ship-schema.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 7: Commit**

```bash
git add launchpad/package.json launchpad/ship.config.json launchpad/src/ship-schema.js launchpad/src/ship-schema.test.mjs
git commit -m "feat(launchpad): config schema + validator"
```

---

### Task 2: Pre-flight gate CLI (`preflight.mjs`) — the S2 lesson

The exit-code gate. `npm test` runs it against `ship.config.json`; a bad config exits non-zero = ABORT. Tested by spawning it against fixtures and asserting exit codes.

**Files:**
- Create: `launchpad/scripts/preflight.mjs`
- Create: `launchpad/scripts/__fixtures__/valid.json`
- Create: `launchpad/scripts/__fixtures__/bad-color.json`
- Create: `launchpad/scripts/__fixtures__/bad-json.json`
- Test: `launchpad/scripts/preflight.test.mjs`

**Interfaces:**
- Consumes: `validateConfig` from `../src/ship-schema.js`.
- Produces: a CLI `node scripts/preflight.mjs [configPath]` — exit `0` if valid, exit `1` (with an `ABORT` message on stderr) otherwise. Default `configPath` is `ship.config.json`.

- [ ] **Step 1: Write the fixtures**

`launchpad/scripts/__fixtures__/valid.json`:
```json
{ "shipName": "Nebula Runner", "color": "#22d3ee", "emblem": "comet" }
```

`launchpad/scripts/__fixtures__/bad-color.json`:
```json
{ "shipName": "X", "color": "blue", "emblem": "comet" }
```

`launchpad/scripts/__fixtures__/bad-json.json` (deliberately malformed — no closing brace):
```json
{ "shipName": "X", "color": "#000000",
```

- [ ] **Step 2: Write the failing tests** — `launchpad/scripts/preflight.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'preflight.mjs');
const fixture = (name) => path.join(here, '__fixtures__', name);
const run = (configPath) => spawnSync('node', [cli, configPath], { encoding: 'utf8' });

test('exits 0 on a valid config', () => {
  const r = run(fixture('valid.json'));
  assert.equal(r.status, 0, r.stderr);
});

test('exits 1 with ABORT on a bad colour', () => {
  const r = run(fixture('bad-color.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ABORT/);
});

test('exits 1 on malformed JSON', () => {
  const r = run(fixture('bad-json.json'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
});

test('exits 1 when the file is missing', () => {
  const r = run(fixture('does-not-exist.json'));
  assert.equal(r.status, 1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd launchpad && node --test scripts/preflight.test.mjs`
Expected: FAIL — every case reports a spawn error / non-matching status because `scripts/preflight.mjs` does not exist yet.

- [ ] **Step 4: Implement `launchpad/scripts/preflight.mjs`**

```js
#!/usr/bin/env node
// The pre-flight gate. Validates ship.config.json and fails loud.
// `npm test` runs this; a non-zero exit = ABORT (the CI/CD 2 lesson).
import { readFile } from 'node:fs/promises';
import { validateConfig } from '../src/ship-schema.js';

const configPath = process.argv[2] || 'ship.config.json';

let text;
try {
  text = await readFile(configPath, 'utf8');
} catch {
  console.error(`ABORT — cannot read ${configPath}`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(text);
} catch {
  console.error(`ABORT — ${configPath} is not valid JSON`);
  process.exit(1);
}

const { ok, errors } = validateConfig(cfg);
if (!ok) {
  console.error(`ABORT — ${configPath} failed pre-flight:`);
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}

console.log(`✓ pre-flight OK — "${cfg.shipName}" cleared for launch`);
process.exit(0);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd launchpad && node --test scripts/preflight.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 6: Verify the learner-facing gate by hand**

Run: `cd launchpad && npm test`
Expected: prints `✓ pre-flight OK — "Nebula Runner" cleared for launch`, exit 0.

- [ ] **Step 7: Commit**

```bash
git add launchpad/scripts
git commit -m "feat(launchpad): pre-flight config gate wired to npm test"
```

---

### Task 3: Vite app scaffold + build pipeline

Add Vite + Three.js and the smallest app that builds and serves, importing the config.

**Files:**
- Modify: `launchpad/package.json` (add scripts + deps)
- Create: `launchpad/vite.config.js`
- Create: `launchpad/index.html`
- Create: `launchpad/src/config.js`
- Create: `launchpad/src/main.js`
- Create: `launchpad/src/style.css`

**Interfaces:**
- Consumes: `toRenderParams` from `./ship-schema.js`; `ship.config.json`.
- Produces: `ship` (the render params object) exported from `./config.js`, consumed by later tasks.

- [ ] **Step 1: Replace `launchpad/package.json` scripts + deps**

```json
{
  "name": "shipit-launchpad",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "The learner ship microsite — a customizable Three.js rocket a pipeline builds, checks, and ships",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview --host 0.0.0.0 --port 8080",
    "test": "node scripts/preflight.mjs"
  },
  "dependencies": {
    "three": "^0.169.0"
  },
  "devDependencies": {
    "vite": "^6.0.7"
  }
}
```

- [ ] **Step 2: Install**

Run: `cd launchpad && npm install`
Expected: creates `node_modules/` and `package-lock.json`, no errors.

- [ ] **Step 3: Write `launchpad/vite.config.js`**

```js
import { defineConfig } from 'vite';

// base './' → relative asset URLs so the build works under any GitHub
// Pages subpath (https://user.github.io/repo/).
export default defineConfig({
  base: './',
});
```

- [ ] **Step 4: Write `launchpad/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ship — Launchpad</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

- [ ] **Step 5: Write `launchpad/src/config.js`** (Vite-only glue — the JSON import is why this is separate from the node-tested schema)

```js
import raw from '../ship.config.json';
import { toRenderParams } from './ship-schema.js';

export const ship = toRenderParams(raw);
```

- [ ] **Step 6: Write a minimal `launchpad/src/main.js`** (replaced in Task 6)

```js
import { ship } from './config.js';
import './style.css';

const app = document.getElementById('app');
app.textContent = `${ship.shipName} · ${ship.color} · ${ship.emblem}`;
```

- [ ] **Step 7: Write a minimal `launchpad/src/style.css`** (expanded in Task 6)

```css
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font-family: system-ui, sans-serif; }
#app { min-height: 100vh; display: grid; place-items: center; }
```

- [ ] **Step 8: Verify build + dev**

Run: `cd launchpad && npm run build`
Expected: writes `dist/index.html` and `dist/assets/*` with no errors.

Run: `cd launchpad && node -e "import('node:fs').then(fs => { if (!fs.existsSync('dist/index.html')) { console.error('no dist/index.html'); process.exit(1); } console.log('dist OK'); })"`
Expected: prints `dist OK`.

- [ ] **Step 9: Commit**

```bash
git add launchpad/package.json launchpad/package-lock.json launchpad/vite.config.js launchpad/index.html launchpad/src/config.js launchpad/src/main.js launchpad/src/style.css
git commit -m "feat(launchpad): vite + three scaffold that builds to static"
```

---

### Task 4: Three.js scene — procedural rocket tinted by colour

A self-contained scene with a low-poly rocket built from primitives, tinted by `params.color`, gently idling. No external asset yet (Task 7 upgrades to the poly.pizza model). Verified visually.

**Files:**
- Create: `launchpad/src/scene.js`
- Modify: `launchpad/src/main.js`

**Interfaces:**
- Consumes: `ship` from `./config.js`.
- Produces: `createScene(container, params) → { dispose() }` — mounts a `<canvas>` into `container`, renders + animates a rocket tinted `params.color`, handles resize.

- [ ] **Step 1: Write `launchpad/src/scene.js`**

```js
import * as THREE from 'three';

export function createScene(container, params) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
  camera.position.set(0, 1.1, 6);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(3, 5, 4);
  scene.add(key);

  const rocket = buildProceduralRocket(params.color);
  scene.add(rocket);

  let raf = 0;
  const clock = new THREE.Clock();
  function tick() {
    const t = clock.getElapsedTime();
    rocket.rotation.y = t * 0.5;
    rocket.position.y = Math.sin(t * 1.5) * 0.15;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  tick();

  function onResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('resize', onResize);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function buildProceduralRocket(color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), metalness: 0.3, roughness: 0.4 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1f2933, metalness: 0.2, roughness: 0.6 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2, 24), bodyMat);
  group.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 24), bodyMat);
  nose.position.y = 1.45;
  group.add(nose);

  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.5), trimMat);
    const a = (i / 3) * Math.PI * 2;
    fin.position.set(Math.cos(a) * 0.5, -0.9, Math.sin(a) * 0.5);
    fin.lookAt(0, -0.9, 0);
    group.add(fin);
  }
  return group;
}
```

- [ ] **Step 2: Update `launchpad/src/main.js` to mount the scene**

```js
import { ship } from './config.js';
import { createScene } from './scene.js';
import './style.css';

const app = document.getElementById('app');
document.title = `${ship.shipName} — Ship`;

const stage = document.createElement('div');
stage.className = 'stage';
app.append(stage);
createScene(stage, ship);
```

- [ ] **Step 3: Add the stage to `launchpad/src/style.css`** (append)

```css
.stage { position: fixed; inset: 0; }
.stage canvas { display: block; width: 100%; height: 100%; }
```

- [ ] **Step 4: Verify the build still succeeds**

Run: `cd launchpad && npm run build`
Expected: builds with no errors (Three.js bundled into `dist/assets`).

- [ ] **Step 5: Visual check** (this task has no automated test — the deliverable is visual)

Run: `cd launchpad && npm run dev` and open the printed URL (or use the playwright-cli skill to screenshot it).
Expected: a cyan (`#22d3ee`) rocket, slowly rotating and bobbing, centered on a transparent background. Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add launchpad/src/scene.js launchpad/src/main.js launchpad/src/style.css
git commit -m "feat(launchpad): three.js scene with a colour-tinted procedural rocket"
```

---

### Task 5: Emblems + overlay chrome

The emblem SVGs and a DOM overlay (ship name, callsign line, emblem badge) laid over the canvas. Emblem lookup and HTML escaping are pure and tested.

**Files:**
- Create: `launchpad/src/dom.js`
- Create: `launchpad/src/dom.test.mjs`
- Create: `launchpad/src/emblems.js`
- Create: `launchpad/src/emblems.test.mjs`
- Create: `launchpad/src/overlay.js`
- Modify: `launchpad/src/main.js`
- Modify: `launchpad/src/style.css`

**Interfaces:**
- Produces:
  - `escapeHtml(s) → string` (from `dom.js`).
  - `emblemSvg(name) → string` (from `emblems.js`) — an inline `<svg>` string using `currentColor`; falls back to `comet` for unknown names.
  - `renderOverlay(root, params, callsign) → void` (from `overlay.js`).

- [ ] **Step 1: Write the failing tests** — `launchpad/src/dom.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './dom.js';

test('escapeHtml neutralises HTML metacharacters', () => {
  assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
});

test('escapeHtml stringifies non-strings', () => {
  assert.equal(escapeHtml(42), '42');
});
```

- [ ] **Step 2: Write the failing tests** — `launchpad/src/emblems.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMBLEMS } from './ship-schema.js';
import { emblemSvg } from './emblems.js';

test('every allowed emblem has an <svg>', () => {
  for (const name of EMBLEMS) {
    assert.match(emblemSvg(name), /^<svg/, `missing svg for ${name}`);
  }
});

test('unknown emblem falls back to comet', () => {
  assert.equal(emblemSvg('banana'), emblemSvg('comet'));
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd launchpad && node --test src/dom.test.mjs src/emblems.test.mjs`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement `launchpad/src/dom.js`**

```js
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
```

- [ ] **Step 5: Implement `launchpad/src/emblems.js`**

```js
// Inline SVGs, one per allowed emblem. `currentColor` lets CSS tint them.
const SVGS = {
  comet: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="15" cy="9" r="5"/><path d="M3 21 L11 13" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="13,2 4,14 11,14 9,22 20,9 13,9"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,2 15,9 22,9.3 16.5,14 18.5,21 12,17 5.5,21 7.5,14 2,9.3 9,9"/></svg>',
  ring: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>',
  delta: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,3 21,20 3,20"/></svg>',
  phoenix: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,3 20,20 12,15 4,20"/></svg>',
};

export function emblemSvg(name) {
  return SVGS[name] || SVGS.comet;
}
```

- [ ] **Step 6: Run both to verify they pass**

Run: `cd launchpad && node --test src/dom.test.mjs src/emblems.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 7: Implement `launchpad/src/overlay.js`**

```js
import { emblemSvg } from './emblems.js';
import { escapeHtml } from './dom.js';

export function renderOverlay(root, params, callsign) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.style.setProperty('--ship-color', params.color);
  el.innerHTML = `
    <div class="badge">${emblemSvg(params.emblem)}</div>
    <h1 class="ship-name">${escapeHtml(params.shipName)}</h1>
    <p class="callsign">${callsign ? '@' + escapeHtml(callsign) : 'callsign set at launch'}</p>
  `;
  root.append(el);
}
```

- [ ] **Step 8: Wire the overlay in `launchpad/src/main.js`**

```js
import { ship } from './config.js';
import { createScene } from './scene.js';
import { renderOverlay } from './overlay.js';
import './style.css';

const app = document.getElementById('app');
document.title = `${ship.shipName} — Ship`;

const callsign = import.meta.env.VITE_CALLSIGN || '';

const stage = document.createElement('div');
stage.className = 'stage';
app.append(stage);
createScene(stage, ship);
renderOverlay(app, ship, callsign);
```

- [ ] **Step 9: Add overlay styles to `launchpad/src/style.css`** (append)

```css
.overlay {
  position: fixed; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column; align-items: center; gap: 0.25rem;
  padding: 1.5rem; text-align: center; pointer-events: none;
}
.overlay .badge { width: 48px; height: 48px; color: var(--ship-color); }
.overlay .badge svg { width: 100%; height: 100%; }
.overlay .ship-name { margin: 0; font-size: clamp(1.4rem, 4vw, 2.4rem); letter-spacing: 0.02em; }
.overlay .callsign { margin: 0; opacity: 0.7; font-variant: small-caps; }
```

- [ ] **Step 10: Verify build + visual**

Run: `cd launchpad && npm run build`
Expected: no errors.
Visual (`npm run dev`): the rotating rocket plus a bottom overlay — cyan comet badge, "Nebula Runner", "callsign set at launch".

- [ ] **Step 11: Commit**

```bash
git add launchpad/src/dom.js launchpad/src/dom.test.mjs launchpad/src/emblems.js launchpad/src/emblems.test.mjs launchpad/src/overlay.js launchpad/src/main.js launchpad/src/style.css
git commit -m "feat(launchpad): emblem badges + ship-name overlay"
```

---

### Task 6: Fallback — no-WebGL / reduced-motion static card

The graceful-degradation path. `shouldUseFallback` is pure and tested; `renderFallback` draws a static card; `main.js` chooses scene vs fallback.

**Files:**
- Create: `launchpad/src/fallback.js`
- Create: `launchpad/src/fallback.test.mjs`
- Modify: `launchpad/src/main.js`
- Modify: `launchpad/src/style.css`

**Interfaces:**
- Consumes: `emblemSvg`, `escapeHtml`.
- Produces:
  - `shouldUseFallback({ gl, reducedMotion }) → boolean`.
  - `detectWebGL() → boolean` (browser-only; not unit-tested).
  - `renderFallback(root, params, callsign) → void`.

- [ ] **Step 1: Write the failing test** — `launchpad/src/fallback.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseFallback } from './fallback.js';

test('uses the scene when WebGL is present and motion is allowed', () => {
  assert.equal(shouldUseFallback({ gl: true, reducedMotion: false }), false);
});

test('falls back when WebGL is missing', () => {
  assert.equal(shouldUseFallback({ gl: false, reducedMotion: false }), true);
});

test('falls back when the user prefers reduced motion', () => {
  assert.equal(shouldUseFallback({ gl: true, reducedMotion: true }), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd launchpad && node --test src/fallback.test.mjs`
Expected: FAIL — `./fallback.js` not found.

Note: `fallback.js` imports only `emblems.js` + `dom.js` (no `three`), so the test runs under Node.

- [ ] **Step 3: Implement `launchpad/src/fallback.js`**

```js
import { emblemSvg } from './emblems.js';
import { escapeHtml } from './dom.js';

export function shouldUseFallback({ gl, reducedMotion }) {
  return !gl || !!reducedMotion;
}

export function detectWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}

export function renderFallback(root, params, callsign) {
  const el = document.createElement('div');
  el.className = 'fallback';
  el.style.setProperty('--ship-color', params.color);
  el.innerHTML = `
    <div class="badge">${emblemSvg(params.emblem)}</div>
    <h1 class="ship-name">${escapeHtml(params.shipName)}</h1>
    <p class="callsign">${callsign ? '@' + escapeHtml(callsign) : 'callsign set at launch'}</p>
    <div class="swatch"></div>
    <p class="note">Static view — motion off (reduced-motion or no WebGL).</p>
  `;
  root.append(el);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd launchpad && node --test src/fallback.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Replace `launchpad/src/main.js` with the branching version**

```js
import { ship } from './config.js';
import { createScene } from './scene.js';
import { renderOverlay } from './overlay.js';
import { shouldUseFallback, detectWebGL, renderFallback } from './fallback.js';
import './style.css';

const app = document.getElementById('app');
document.title = `${ship.shipName} — Ship`;

const callsign = import.meta.env.VITE_CALLSIGN || '';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const gl = detectWebGL();

if (shouldUseFallback({ gl, reducedMotion })) {
  renderFallback(app, ship, callsign);
} else {
  const stage = document.createElement('div');
  stage.className = 'stage';
  app.append(stage);
  createScene(stage, ship);
  renderOverlay(app, ship, callsign);
}
```

- [ ] **Step 6: Add fallback styles to `launchpad/src/style.css`** (append)

```css
.fallback {
  min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0.6rem; padding: 2rem; text-align: center;
}
.fallback .badge { width: 72px; height: 72px; color: var(--ship-color); }
.fallback .badge svg { width: 100%; height: 100%; }
.fallback .ship-name { margin: 0; font-size: clamp(1.6rem, 5vw, 2.6rem); }
.fallback .callsign { margin: 0; opacity: 0.7; font-variant: small-caps; }
.fallback .swatch { width: 96px; height: 8px; border-radius: 4px; background: var(--ship-color); }
.fallback .note { margin: 0; opacity: 0.55; font-size: 0.85rem; }
```

- [ ] **Step 7: Verify build + both paths**

Run: `cd launchpad && npm run build`
Expected: no errors.
Visual: normal load → 3D scene + overlay; with OS "reduce motion" on (or emulated in devtools) → the static card. Confirm both.

- [ ] **Step 8: Commit**

```bash
git add launchpad/src/fallback.js launchpad/src/fallback.test.mjs launchpad/src/main.js launchpad/src/style.css
git commit -m "feat(launchpad): reduced-motion / no-WebGL static fallback"
```

---

### Task 7: Poly.pizza rocket (progressive enhancement)

Vendor a real low-poly rocket `.glb` and load it over the procedural rocket. If the asset is absent or fails to load, the procedural rocket stays — the site never breaks.

**Files:**
- Create: `launchpad/public/rocket.glb` (downloaded)
- Create: `launchpad/CREDITS.md`
- Modify: `launchpad/src/scene.js`

**Interfaces:**
- Consumes: `params.color`.
- Produces: no new exports — `createScene` internally upgrades the rocket when `rocket.glb` loads.

- [ ] **Step 1: Vendor a rocket model from poly.pizza**

Download one CC0 / CC-BY **low-poly rocket** `.glb` from https://poly.pizza (search "rocket"; pick a small CC0 model) and save it as `launchpad/public/rocket.glb`. Keep it small (ideally < 1 MB). Note the model name, author, source URL, and license — you'll record them next.

Verify: `cd launchpad && node -e "const s=require('fs').statSync('public/rocket.glb'); console.log('rocket.glb', s.size, 'bytes')"`
Expected: prints a non-zero byte count.

- [ ] **Step 2: Record attribution in `launchpad/CREDITS.md`**

Fill in the real values for the model you chose:

```markdown
# Credits

## 3D assets

- **`public/rocket.glb`** — "<MODEL NAME>" by <AUTHOR>, from Poly Pizza (<SOURCE URL>).
  Licensed <CC0 / CC-BY 4.0>. <If CC-BY: attribution required — keep this line.>
```

- [ ] **Step 3: Upgrade `launchpad/src/scene.js` to prefer the glb**

Replace the file with this version (adds a GLTF load that swaps in the model, tints it, and keeps the procedural rocket on any failure):

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export function createScene(container, params) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 100);
  camera.position.set(0, 1.1, 6);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.append(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.3);
  key.position.set(3, 5, 4);
  scene.add(key);

  // Start with the procedural rocket (instant, always works); upgrade to the
  // vendored model if it loads.
  let rocket = buildProceduralRocket(params.color);
  scene.add(rocket);

  new GLTFLoader().load(
    import.meta.env.BASE_URL + 'rocket.glb',
    (gltf) => {
      const model = gltf.scene;
      tint(model, params.color);
      fitToHeight(model, 2.4);
      scene.remove(rocket);
      rocket = model;
      scene.add(rocket);
    },
    undefined,
    (err) => {
      // Graceful degradation, but not silent — keep the procedural rocket and log why.
      console.warn('rocket.glb failed to load — using the procedural rocket', err);
    },
  );

  let raf = 0;
  const clock = new THREE.Clock();
  function tick() {
    const t = clock.getElapsedTime();
    rocket.rotation.y = t * 0.5;
    rocket.position.y = Math.sin(t * 1.5) * 0.15;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  }
  tick();

  function onResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('resize', onResize);

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function tint(object3d, color) {
  const c = new THREE.Color(color);
  object3d.traverse((node) => {
    if (node.isMesh && node.material) {
      node.material = node.material.clone();
      node.material.color = c;
    }
  });
}

function fitToHeight(object3d, targetHeight) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  const scale = size.y > 0 ? targetHeight / size.y : 1;
  object3d.scale.setScalar(scale);
  object3d.position.sub(center.multiplyScalar(scale));
}

function buildProceduralRocket(color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), metalness: 0.3, roughness: 0.4 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1f2933, metalness: 0.2, roughness: 0.6 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2, 24), bodyMat);
  group.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 24), bodyMat);
  nose.position.y = 1.45;
  group.add(nose);

  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.5), trimMat);
    const a = (i / 3) * Math.PI * 2;
    fin.position.set(Math.cos(a) * 0.5, -0.9, Math.sin(a) * 0.5);
    fin.lookAt(0, -0.9, 0);
    group.add(fin);
  }
  return group;
}
```

- [ ] **Step 4: Verify build + visual**

Run: `cd launchpad && npm run build`
Expected: no errors; `dist/rocket.glb` is present (Vite copies `public/`).
Visual (`npm run dev`): the vendored rocket appears, tinted cyan, rotating. Temporarily rename `public/rocket.glb` and reload → the procedural rocket shows instead (no crash). Restore the file.

- [ ] **Step 5: Commit**

```bash
git add launchpad/public/rocket.glb launchpad/CREDITS.md launchpad/src/scene.js
git commit -m "feat(launchpad): poly.pizza rocket via GLTFLoader, procedural fallback"
```

---

### Task 8: Pages-ready polish + README + full verification

Confirm the whole thing: gate both ways, all unit tests, a clean build served from a subpath, and learner-facing docs.

**Files:**
- Modify: `launchpad/README.md`

**Interfaces:** none new.

- [ ] **Step 1: Rewrite `launchpad/README.md`**

```markdown
# launchpad — your ship

A small personal **ship microsite**: a Three.js rocket you customize, and the thing your
CI/CD pipeline builds, checks, and ships across the four sessions.

## Customize it

Edit **`ship.config.json`** — the only file you need to touch:

```json
{
  "shipName": "Nebula Runner",
  "color": "#22d3ee",
  "emblem": "comet"
}
```

- `shipName` — up to 24 characters.
- `color` — a hex colour like `#22d3ee` (tints your rocket).
- `emblem` — one of: `comet`, `bolt`, `star`, `ring`, `delta`, `phoenix`.

Your **callsign** is your GitHub username — it's set automatically when the pipeline runs.

## Run it

```bash
npm install
npm run dev        # live preview
npm test           # pre-flight check — fails (ABORT) if ship.config.json is invalid
npm run build      # static site → dist/
npm run preview    # serve the built site on :8080
```

`npm test` is the pre-flight gate: a bad `ship.config.json` exits non-zero and blocks the launch.
```

- [ ] **Step 2: Run the full dev test suite**

Run: `cd launchpad && node --test src/ship-schema.test.mjs src/dom.test.mjs src/emblems.test.mjs src/fallback.test.mjs scripts/preflight.test.mjs`
Expected: PASS — all suites green.

- [ ] **Step 3: Verify the gate fails loud on a bad config**

Run:
```bash
cd launchpad && cp ship.config.json /tmp/ship.ok.json \
  && node -e "const c=require('./ship.config.json'); c.color='not-a-colour'; require('fs').writeFileSync('ship.config.json', JSON.stringify(c,null,2))" \
  && (npm test; echo "exit=$?") \
  && cp /tmp/ship.ok.json ship.config.json
```
Expected: prints `ABORT — ship.config.json failed pre-flight` and `exit=1`, then restores the good config.

- [ ] **Step 4: Verify a subpath-served build works (Pages simulation)**

Run: `cd launchpad && npm run build && npm run preview`
Then fetch it: `curl -s http://localhost:8080/ | grep -q '<div id="app">' && echo "serves OK"`
Expected: `serves OK`. Confirm asset URLs in `dist/index.html` are relative (start with `./`). Stop preview.

- [ ] **Step 5: Confirm the working tree is clean and commit the README**

```bash
git add launchpad/README.md
git commit -m "docs(launchpad): customize + run instructions"
```

- [ ] **Step 6: Milestone check**

Confirm all true:
- `npm test` passes on the valid config, ABORTs (exit 1) on an invalid one.
- `node --test …` — all unit suites green.
- `npm run build` → `dist/` with the rocket, overlay, bundled Three.js, and `rocket.glb`.
- Reduced-motion / no-WebGL → static card.
- `dist/` serves correctly from `:8080` with relative asset paths.

---

## Self-Review

**Spec coverage (Milestone 1 in the design doc):**
- "Three.js rocket" → Tasks 4, 7. ✓
- "poly.pizza `.glb`" → Task 7 (with procedural fallback so the plan is executable before sourcing). ✓
- "`ship.config.json`" → Task 1. ✓
- "config pre-flight validation gate (`scripts/preflight.mjs`)" → Task 2, verified again in Task 8. ✓
- "static `vite build` … builds to `dist/`" → Tasks 3, 8. ✓
- "reduced-motion / no-WebGL fallback" → Task 6. ✓
- Global constraints (no vitest/Playwright, no CDN, theme-aware, callsign not in config, emblem set, colour regex) → honored across tasks; dev tests use `node --test`. ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases" left. The only human-supplied values are the poly.pizza model bytes + its real attribution in `CREDITS.md` (Task 7) — inherent to choosing an asset, and the download is an executable step (execution has web access), not a code placeholder.

**Type consistency:** `createScene(container, params) → { dispose() }` consistent across Tasks 4 and 7. `shouldUseFallback({ gl, reducedMotion })`, `renderFallback(root, params, callsign)`, `renderOverlay(root, params, callsign)`, `emblemSvg(name)`, `escapeHtml(s)`, `validateConfig(cfg) → {ok,errors}`, `toRenderParams(cfg) → {shipName,color,emblem}` — all used with the same signatures where consumed. `ship` (render params) exported from `config.js` and consumed by `main.js`. ✓
