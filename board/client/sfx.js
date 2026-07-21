// board/client/sfx.js
// Synthesized cockpit sounds — Web Audio only, no asset files. Every sound is
// oscillators/filtered noise built at call time. The AudioContext unlocks on
// the first user gesture (browsers block audio before one) via unlock().

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let ac = null;
let master = null;
let muted = store.get('shipit-sfx') === 'off';

function ctx() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    master = ac.createGain();
    master.gain.value = 0.5;
    master.connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

function blip(freq, { dur = 0.08, type = 'sine', gain = 0.15, at = 0, slide = 0, attack = 0.004 } = {}) {
  if (muted) return;
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(1, freq + slide), t + dur);
  // Soft attack — instant-on sines click and read as arcade bleeps.
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function whoosh({ dur = 0.3, from = 400, to = 2400, gain = 0.2, at = 0, type = 'bandpass' } = {}) {
  if (muted) return;
  const a = ctx();
  if (!a) return;
  const t = a.currentTime + at;
  const len = Math.ceil(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = type;
  f.Q.value = 1;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.02);
}

// Cockpit palette, not arcade: sines/triangles with soft attacks, low
// registers, filtered-noise air. No square waves, no rising chiptune runs.
export const sfx = {
  get muted() { return muted; },
  set muted(v) { muted = v; store.set('shipit-sfx', v ? 'off' : 'on'); },
  unlock() { if (!muted) ctx(); },
  // Correct keystroke: dampened console tap — a puff of low noise with a
  // faint mid tone, pitch-jittered so a line of typing isn't a metronome.
  key() {
    whoosh({ dur: 0.025, from: 900, to: 500, gain: 0.05, type: 'lowpass' });
    blip(520 + Math.random() * 120, { dur: 0.03, type: 'triangle', gain: 0.04 });
  },
  // Wrong character: soft low bump, pitch sagging.
  miss() { blip(90, { dur: 0.08, type: 'sine', gain: 0.07, slide: -35 }); },
  // Command fully typed (awaiting ENTER): single sonar ping, long tail.
  ready() { blip(880, { dur: 0.35, type: 'sine', gain: 0.08, attack: 0.01 }); },
  // ENTER boost: deep thruster — low noise sweep + a rumble rising under it.
  boost() {
    whoosh({ dur: 0.5, from: 120, to: 1400, gain: 0.28 });
    blip(50, { dur: 0.45, type: 'sine', gain: 0.18, slide: 70 });
  },
  // ENTER on a wrong line: descending double "denied" thunk.
  error() {
    blip(160, { dur: 0.12, type: 'triangle', gain: 0.1, slide: -60 });
    blip(110, { dur: 0.15, type: 'triangle', gain: 0.1, slide: -40, at: 0.12 });
  },
  // Race went live: two low countdown marks, then ignition — tone + rumble.
  go() {
    blip(392, { dur: 0.1, type: 'sine', gain: 0.12 });
    blip(392, { dur: 0.1, type: 'sine', gain: 0.12, at: 0.18 });
    blip(523, { dur: 0.4, type: 'sine', gain: 0.15, at: 0.36 });
    whoosh({ dur: 0.6, from: 80, to: 400, gain: 0.12, at: 0.36, type: 'lowpass' });
  },
  // All prompts done: docking-complete — a warm low chord swelling in, with
  // one soft ping on top. No fanfare arpeggio.
  finish() {
    [130.8, 196, 261.6].forEach((f) => blip(f, { dur: 1.0, type: 'sine', gain: 0.09, attack: 0.15 }));
    blip(784, { dur: 0.6, type: 'sine', gain: 0.07, at: 0.25, attack: 0.02 });
  },
};
