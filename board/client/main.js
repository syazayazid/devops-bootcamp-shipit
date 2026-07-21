import './style.css';
import { createScene } from './scene.js';
import { createRaceTrack } from './race-track.js';
import { createFallback, detectWebGL, shouldUseFallback } from './fallback.js';

const app = document.getElementById('app');
const count = document.getElementById('count');
const toasts = document.getElementById('toasts');
const hud = document.getElementById('race-hud');
const orbitHud = document.getElementById('hud');
const hudClients = document.getElementById('hud-clients');
const gl = detectWebGL();
const mql = window.matchMedia('(prefers-reduced-motion: reduce)');

let lastShips = [];       // roster (orbit)
let lastRace = { phase: 'idle', total: 12, ships: [] }; // race state (rows view)
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

function makeRace() {
  const v = createRaceTrack(app); // its own fallback: DOM-only, reduced-motion via CSS
  v.update(lastRace);
  return v;
}

function setMode(next) {
  if (next === mode) return;
  view.dispose();
  mode = next;
  // The orbit HUD legend occludes the top rows at 40-ship density in race mode.
  if (mode === 'race') { view = makeRace(); if (hud) hud.hidden = false; if (orbitHud) orbitHud.hidden = true; }
  else { view = makeOrbit(shouldUseFallback({ gl, reducedMotion: mql.matches })); if (hud) hud.hidden = true; if (orbitHud) orbitHud.hidden = false; }
}

mql.addEventListener('change', (e) => {
  if (mode !== 'orbit') return; // race track handles reduced motion in CSS
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
      lastRace = { phase: m.phase, total: m.total, ships: m.ships || [] };
      setMode(m.view === 'race' ? 'race' : 'orbit');
      if (mode === 'race') view.update(lastRace);
      if (hudClients) hudClients.textContent = String(m.clients ?? 0);
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onerror = () => ws.close();
}
connect();
