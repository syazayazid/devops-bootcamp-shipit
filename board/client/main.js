import './style.css';
import { createScene } from './scene.js';
import { createFallback, detectWebGL, shouldUseFallback } from './fallback.js';

const app = document.getElementById('app');
const count = document.getElementById('count');
const gl = detectWebGL();
const mql = window.matchMedia('(prefers-reduced-motion: reduce)');

let lastShips = [];
let view = makeView(shouldUseFallback({ gl, reducedMotion: mql.matches }));

function makeView(useFallback) {
  const v = useFallback ? createFallback(app) : createScene(app);
  v.update(lastShips);
  return v;
}

// Real dispose caller #1: user toggles reduced-motion → tear down + swap.
mql.addEventListener('change', (e) => {
  view.dispose();
  view = makeView(shouldUseFallback({ gl, reducedMotion: e.matches }));
});
// Real dispose caller #2: page teardown.
window.addEventListener('pagehide', () => view.dispose());

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'roster' && Array.isArray(m.ships)) {
      lastShips = m.ships;
      view.update(lastShips);
      if (count) count.textContent = `${lastShips.length} ship${lastShips.length === 1 ? '' : 's'}`;
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onerror = () => ws.close();
}
connect();
