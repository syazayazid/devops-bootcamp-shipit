// The in-memory roster + event sanitizer. Pure and node-testable.
import { SHIP_IDS, DEFAULT_SHIP, normalizeColor } from './ships.js';

export const STAGES = ['pad', 'build', 'test', 'clearance', 'liftoff'];
export const STATUSES = ['running', 'passed', 'failed', 'aborted', 'shipped'];
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_COLOR = '#94a3b8'; // neutral slate when colour is missing/invalid

const cleanStr = (s, max) =>
  (typeof s === 'string' ? s.replace(/[\u0000-\u001F]/g, '').trim().slice(0, max) : '');

function cleanUrl(v) {
  const s = cleanStr(v, 300);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : undefined;
  } catch { return undefined; }
}

// Strict on identity + enums (a helpful 400 teaches the contract); lenient on
// cosmetics. Returns null when the event is unusable.
export function sanitizeEvent(raw) {
  raw = raw ?? {};
  const callsign = cleanStr(raw.callsign, 39).toLowerCase(); // GitHub usernames are case-insensitive; Pages hostnames are lowercase — canonicalize
  if (!callsign) return null;
  if (!STAGES.includes(raw.stage)) return null;
  if (!STATUSES.includes(raw.status)) return null;

  const entry = {
    callsign,
    stage: raw.stage,
    status: raw.status,
    color: normalizeColor(raw.color) || DEFAULT_COLOR, // accepts hex or a colour name
    shipModel: SHIP_IDS.includes(raw.shipModel) ? raw.shipModel : DEFAULT_SHIP,
  };
  const version = cleanStr(raw.version, 40);
  if (version) entry.version = version;
  const siteUrl = cleanUrl(raw.siteUrl);
  if (siteUrl) entry.siteUrl = siteUrl;
  return entry;
}

export class Roster {
  constructor() { this.ships = new Map(); }
  upsert(event) { this.ships.set(event.callsign, event); return event; } // latest-wins
  list() { return [...this.ships.values()]; }
  get size() { return this.ships.size; }
  has(callsign) { return this.ships.has(callsign); }
  get(callsign) { return this.ships.get(callsign); }
}
