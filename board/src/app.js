import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Roster, sanitizeEvent } from './room.js';
import { parse, rosterMsg, raceMsg } from './messages.js';
import { Race } from './race.js';
import { createLiveness } from './liveness.js';
import { pickPrompts, SESSIONS } from './corpus.js';

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

export function createServer({ port = 3000, token = null, operatorKey = null, publicDir = DIST, fetchImpl = fetch } = {}) {
  const roster = new Roster();
  const race = new Race({ total: 12 });
  const clients = new Set();
  let view = 'orbit';        // projector view: 'orbit' | 'race'
  let session = 'cicd3';
  let dirty = false;         // roster changed
  let raceDirty = false;     // race state or view changed
  // Liveness: a ship is LIVE only when its real Pages site answers 200. Reported
  // siteUrls are probed on arrival + on a periodic sweep; a flip marks dirty so
  // the next tick rebroadcasts the roster with fresh `live` flags.
  const liveness = createLiveness({ roster, fetchImpl, onChange: () => { dirty = true; } });

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
        liveness.probe(event); // check the real site now — snappy first-contact green
        return json(res, 202, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/api/race/start') {
        const body = parse(await readBody(req)) || {};
        return operate(req, res, () => {
          const s = body.session ? String(body.session) : session;
          if (!SESSIONS[s]) return json(res, 400, { error: 'unknown session' });
          session = s;
          race.start(pickPrompts(session));
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
      if (rel === '/play') rel = '/play.html';
      if (rel === '/operator') rel = '/operator.html';
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
    dirty = true; raceDirty = true; // send the roster + race snapshot on the next tick
    ws.on('message', (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.t === 'join' && typeof m.callsign === 'string') {
        if (!roster.has(m.callsign)) return send(ws, JSON.stringify({ t: 'denied', reason: 'not-on-roster' }));
        ws.callsign = m.callsign;
        race.join(m.callsign);
        raceDirty = true;
      } else if (m.t === 'progress' && ws.callsign && Number.isInteger(m.completed)) {
        race.report(ws.callsign, m.completed, m.frac);
        raceDirty = true;
      }
    });
    const drop = () => clients.delete(ws);
    ws.on('close', drop);
    ws.on('error', drop);
  });

  const tick = setInterval(() => {
    if (dirty) { dirty = false; const msg = rosterMsg(roster.list().map((s) => ({ ...s, live: liveness.isLive(s.callsign) }))); for (const ws of clients) send(ws, msg); }
    if (raceDirty) { raceDirty = false; const msg = raceMsg(race.snapshot(), view, clients.size, roster); for (const ws of clients) send(ws, msg); }
  }, 50);

  server.listen(port);
  liveness.start();
  return {
    get port() { const a = server.address(); return a && typeof a === 'object' ? a.port : port; },
    roster, race, liveness, server, wss,
    close() { clearInterval(tick); liveness.stop(); wss.close(); return new Promise((r) => server.close(r)); },
  };
}
