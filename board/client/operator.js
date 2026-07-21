// board/client/operator.js
// Instructor console: drives the three operator endpoints (key-guarded HTTP
// POSTs) and mirrors the public race broadcast read-only. The key lives in
// localStorage on the operator's device — classroom-grade, rotate per cohort.
import './operator.css';

const keyEl = document.getElementById('key');
const sessionEl = document.getElementById('session');
const resultEl = document.getElementById('result');
const liveEl = document.getElementById('live');

const storage = {
  get() { try { return localStorage.getItem('shipit-operator-key') || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem('shipit-operator-key', v); } catch { /* storage locked — key lives only in the field */ } },
};
keyEl.value = storage.get();
keyEl.oninput = () => storage.set(keyEl.value);

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

const startBtn = document.getElementById('start');
startBtn.onclick = () => call('/api/race/start', { session: sessionEl.value });
document.getElementById('reset').onclick = () => call('/api/race/reset');
document.getElementById('view-orbit').onclick = () => call('/api/view', { view: 'orbit' });
document.getElementById('view-race').onclick = () => call('/api/view', { view: 'race' });

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'race') {
      liveEl.textContent = `phase: ${m.phase} · racers: ${(m.ships || []).length} · viewers: ${m.clients ?? 0}`;
      // Starting mid-round zeroes the server while cockpits keep optimistic
      // positions — a wedged round; RESET first (RESET stays always enabled,
      // it's the escape hatch).
      startBtn.disabled = m.phase === 'running';
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onerror = () => ws.close();
}
connect();
