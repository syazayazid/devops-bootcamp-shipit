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
  if (me) root.dataset.me = '1';
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
    // Deterministic per-callsign phase: ships bob/flicker out of sync without
    // re-rolling on every update (negative delay = start mid-cycle, no pop).
    let h = 0;
    for (const ch of s.callsign) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    el.style.setProperty('--bob-dur', `${(2.6 + (h % 90) / 60).toFixed(2)}s`);
    el.style.setProperty('--bob-delay', `-${((h >> 4) % 300) / 100}s`);

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
    r.el.style.setProperty('--ship-color', s.color || NEUTRAL);
    shipSprite(s.shipModel, s.color).then((url) => {
      if (disposed || r.spriteKey !== key) return; // stale render — a newer look won
      if (url) { r.img.src = url; r.img.hidden = false; r.glyph.hidden = true; }
      else { r.img.hidden = true; r.glyph.hidden = false; }
    });
  }

  function medalsText(ships) {
    const podium = ships.filter((s) => s.finishedAt != null)
      .sort((a, b) => a.finishedAt - b.finishedAt).slice(0, 3)
      .map((s, i) => `${MEDALS[i]} @${s.callsign}`);
    return podium.length ? podium.join('  ') : '';
  }

  function bannerText(phase, ships) {
    if (phase === 'idle') return ships.length ? 'WAITING FOR LAUNCH…' : 'NO RACERS YET — open your ship’s READY link';
    if (phase === 'finished') {
      const podium = medalsText(ships);
      return podium ? `FINISH ✦ ${podium}` : 'FINISH ✦';
    }
    // A ghost racer who never finishes blocks the server's 'finished' phase
    // forever, so winners must show as they land, not just at round end.
    if (phase === 'running') {
      const podium = medalsText(ships);
      if (podium) return podium;
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
      // Alphabetical slot, whatever the DOM insertion order was — except the
      // cockpit's own ship, pinned to the bottom so it sits right above the
      // typing dock (your ship moves where your eyes already are).
      r.el.style.order = me && s.callsign === me ? String(order.length) : String(i);
    });
    for (const [callsign, r] of rows) {
      if (!seen.has(callsign)) { r.el.remove(); rows.delete(callsign); }
    }
  }

  // Pulse the ENTER-boost flourish on one ship (lunge + engine flare).
  function boost(callsign) {
    const r = rows.get(callsign);
    if (!r) return;
    r.ship.classList.remove('boost');
    void r.ship.offsetWidth; // restart the animation on rapid re-trigger
    r.ship.classList.add('boost');
    clearTimeout(r.boostTimer);
    r.boostTimer = setTimeout(() => r.ship.classList.remove('boost'), 500);
  }

  return {
    update,
    boost,
    dispose() { disposed = true; root.remove(); rows.clear(); },
  };
}
