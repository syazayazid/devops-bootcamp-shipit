import './play.css';
import { advance } from './typing.js';
import { createRaceTrack } from './race-track.js';
import { sfx } from './sfx.js';

const params = new URLSearchParams(location.search);
const callsign = (params.get('callsign') || '').toLowerCase();
const statusEl = document.getElementById('status');
const typedEl = document.getElementById('typed');
const restEl = document.getElementById('rest');
const caretEl = document.getElementById('caret');
const termEl = document.getElementById('term');
const entry = document.getElementById('entry');
const track = createRaceTrack(document.getElementById('field'), { me: callsign });

let prompts = [];
let phase = 'idle';
let completed = 0;   // my confirmed position (optimistic; server is authoritative)
let synced = false;  // true once we've trusted the server's position after (re)connect
let prevPhase = 'idle';
let typedCount = 0;      // strict cursor into the current prompt — wrong keys never move it
let currentTarget = null;

const muteBtn = document.getElementById('mute');
const showMute = () => { muteBtn.textContent = sfx.muted ? '🔇' : '🔊'; };
muteBtn.onclick = () => { sfx.muted = !sfx.muted; showMute(); };
showMute();

const target = () => prompts[completed] || '';
const lineDone = () => { const t = target(); return t.length > 0 && typedCount === t.length; };

let errTimer = null;
function rejectKey() {
  sfx.miss();
  caretEl.classList.add('err');
  clearTimeout(errTimer);
  errTimer = setTimeout(() => caretEl.classList.remove('err'), 180);
}

function render() {
  const t = target();
  if (t !== currentTarget) { currentTarget = t; typedCount = 0; entry.value = ''; }
  typedEl.textContent = t.slice(0, typedCount);
  restEl.textContent = t.slice(typedCount);
  const active = phase === 'running' && completed < prompts.length;
  termEl.dataset.active = active ? '1' : '';
  termEl.dataset.done = lineDone() ? '1' : '';
  if (active) {
    const wasDisabled = entry.disabled;
    entry.disabled = false;
    // `autofocus` dies while the input is disabled pre-race — without this,
    // race start leaves focus nowhere and keystrokes go to the page.
    if (wasDisabled) entry.focus();
  } else {
    entry.disabled = true;
  }
  statusEl.textContent =
    phase === 'running' ? (lineDone() ? 'ENTER to run ⏎' : `RACING — ${completed}/${prompts.length}`)
    : phase === 'finished' ? 'FINISHED ✦'
    : 'waiting for race…';
}

// Trailing throttle: at most one frac report per 100ms. Completions bypass
// this and send immediately in the keydown handler.
function fracSender(ws) {
  let timer = null, latest = 0;
  const send = (frac) => {
    latest = frac;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (ws.readyState === WebSocket.OPEN && phase === 'running') {
        ws.send(JSON.stringify({ t: 'progress', completed, frac: latest }));
      }
    }, 100);
  };
  send.cancel = () => { if (timer) { clearTimeout(timer); timer = null; } latest = 0; };
  return send;
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
      if (m.phase === 'running' && prevPhase !== 'running') sfx.go();
      prevPhase = m.phase;
      track.update({ phase: m.phase, total: m.total, ships: m.ships || [] });
      render();
    }
  };
  // The hidden input feeds the terminal line. Its value is snapped to the
  // correct prefix after every event, so only the newly typed characters are
  // judged — a wrong key simply never lands (no backspace needed, or allowed).
  entry.oninput = () => {
    const t = target();
    if (phase !== 'running' || !t) { entry.value = ''; return; }
    const prefix = t.slice(0, typedCount);
    const v = entry.value;
    if (v.length > prefix.length) {
      const next = v.startsWith(prefix) ? advance(t, typedCount, v.slice(prefix.length)) : typedCount;
      if (next > typedCount) {
        typedCount = next;
        sfx.key();
        if (typedCount === t.length) sfx.ready();
      } else {
        rejectKey();
      }
    }
    entry.value = t.slice(0, typedCount); // snap: deletions and wrong keys are no-ops
    sendFrac(typedCount === t.length ? 0.9 : typedCount / t.length);
    render();
  };
  entry.onkeydown = (e) => {
    sfx.unlock();
    if (e.key === 'Backspace') { e.preventDefault(); return; } // nothing to erase — wrong keys never landed
    if (e.key !== 'Enter') return;
    if (lineDone() && phase === 'running') {
      sendFrac.cancel();
      completed += 1;
      currentTarget = null;
      typedCount = 0;
      entry.value = '';
      ws.send(JSON.stringify({ t: 'progress', completed }));
      track.boost(callsign);
      if (completed >= prompts.length) sfx.finish(); else sfx.boost();
      render();
    } else if (phase === 'running') {
      sfx.error();
      termEl.classList.remove('shake');
      void termEl.offsetWidth; // restart the animation on rapid re-trigger
      termEl.classList.add('shake');
    }
  };
  ws.onclose = () => { statusEl.textContent = 'disconnected — reconnecting…'; setTimeout(connect, 1000); };
  ws.onerror = () => ws.close();
}

// Click/tap anywhere returns focus to the input — racers never hunt for it.
// Doubles as the audio unlock gesture.
document.addEventListener('click', () => { sfx.unlock(); if (!entry.disabled) entry.focus(); });

if (!callsign) { statusEl.textContent = 'No callsign — open this from your ship\'s READY button.'; entry.disabled = true; }
else connect();
