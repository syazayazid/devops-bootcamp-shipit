// board/client/theme.js
// Blueprint palette + tuning knobs. PLAIN DATA ONLY — no `three`, no DOM —
// so pure modules (orbit.js, launch.js) can import it and stay node --test-able.

export const PALETTE = {
  bg: '#0b1220',          // deep navy — matches devops-bootcamp-app
  grid: '#38f5c9',        // blueprint grid line
  gridDim: '#173b46',     // blueprint grid secondary
  ring: '#22d3ee',        // orbit ring / exhaust trail (blooms)
  hemiSky: '#22d3ee',
  hemiGround: '#020617',
  dir: '#8ecbff',
  labelText: '#eaf6ff',   // callsign fill
  labelOutline: '#04121f', // callsign stroke (legibility over any tint)
  grounded: '#f0505a',    // ABORT marker
  live: '#2fe37a',        // LIVE halo — real Pages site answered 200 (blooms green)
};

export const LAYOUT = {
  PAD_Y: 0, ORBIT_Y: 3.2, ORBIT_R: 2.4,
  GRID_SIZE: 16, GRID_DIV: 16,
  ASCEND_COLS: 8, ASCEND_GAP: 0.7,
};

export const BLOOM = { strength: 0.6, radius: 0.6, threshold: 0.2 };

// Launch beat durations (ms) + geometry. CROUCH_Y = anticipation dip;
// APEX_Y = thrust overshoot above ORBIT_Y before arcing into the ring.
export const LAUNCH = { CHARGE_MS: 600, THRUST_MS: 1200, ARC_MS: 1000, CROUCH_Y: 0.12, APEX_Y: 4.4 };

export const DAMP_K = 6; // ease-to-target damping rate (1/s)
