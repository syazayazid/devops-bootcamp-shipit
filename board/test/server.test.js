import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../src/app.js';
import { STORIES } from '../src/corpus.js';

const post = (port, body, headers = {}) =>
  fetch(`http://localhost:${port}/api/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const openClient = (port) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.on('open', () => resolve(ws));
});
const nextMsg = (ws, pred) => new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('timeout')), 2000);
  const on = (data) => { const m = JSON.parse(data.toString()); if (!pred || pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); } };
  ws.on('message', on);
});

const ev = { callsign: 'octocat', stage: 'build', status: 'passed', color: '#22d3ee' };

test('POST event (open mode) appears in the ws roster', async () => {
  const app = createServer({ port: 0, token: null });
  const port = app.port;
  try {
    const spectator = await openClient(port);
    await nextMsg(spectator, (m) => m.t === 'roster');       // initial snapshot
    assert.equal((await post(port, ev)).status, 202);
    const roster = await nextMsg(spectator, (m) => m.t === 'roster' && m.ships.some((s) => s.callsign === 'octocat'));
    const ship = roster.ships.find((s) => s.callsign === 'octocat');
    assert.equal(ship.stage, 'build');
    assert.equal(ship.status, 'passed');
    spectator.close();
  } finally { await app.close(); }
});

test('latest event wins per callsign', async () => {
  const app = createServer({ port: 0, token: null });
  const port = app.port;
  try {
    await post(port, { ...ev, stage: 'pad', status: 'running' });
    await post(port, { ...ev, stage: 'liftoff', status: 'shipped' });
    const spectator = await openClient(port);
    const roster = await nextMsg(spectator, (m) => m.t === 'roster' && m.ships.some((s) => s.callsign === 'octocat'));
    const mine = roster.ships.filter((s) => s.callsign === 'octocat');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].stage, 'liftoff');
    spectator.close();
  } finally { await app.close(); }
});

test('enforcing mode: 401 without/with wrong token, 202 with right token', async () => {
  const app = createServer({ port: 0, token: 'sooper-secret' });
  const port = app.port;
  try {
    assert.equal((await post(port, ev)).status, 401);
    assert.equal((await post(port, ev, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(port, ev, { authorization: 'Bearer sooper-secret' })).status, 202);
  } finally { await app.close(); }
});

test('malformed / invalid event → 400', async () => {
  const app = createServer({ port: 0, token: null });
  const port = app.port;
  try {
    assert.equal((await post(port, 'not json')).status, 400);
    assert.equal((await post(port, { callsign: 'x', stage: 'nope', status: 'passed' })).status, 400);
  } finally { await app.close(); }
});

test('POST shipModel survives into the ws roster', async () => {
  const app = createServer({ port: 0, token: null });
  const port = app.port;
  try {
    const spectator = await openClient(port);
    await nextMsg(spectator, (m) => m.t === 'roster');
    await post(port, { ...ev, shipModel: 'interceptor' });
    const roster = await nextMsg(spectator, (m) => m.t === 'roster' && m.ships.some((s) => s.callsign === 'octocat'));
    assert.equal(roster.ships.find((s) => s.callsign === 'octocat').shipModel, 'interceptor');
    spectator.close();
  } finally { await app.close(); }
});

const opHeader = (key) => ({ authorization: `Bearer ${key}` });
const postTo = (port, path, body, headers = {}) =>
  fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body || {}),
  });

test('cockpit join is denied for a callsign not on the roster', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: null });
  const port = app.port;
  try {
    const cockpit = await openClient(port);
    await nextMsg(cockpit, (m) => m.t === 'roster');
    cockpit.send(JSON.stringify({ t: 'join', callsign: 'stranger' }));
    const denied = await nextMsg(cockpit, (m) => m.t === 'denied');
    assert.equal(denied.reason, 'not-on-roster');
    cockpit.close();
  } finally { await app.close(); }
});

test('operator can start a race; cockpit progress advances the snapshot', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: 'op-key' });
  const port = app.port;
  try {
    await post(port, ev); // ev = octocat, from existing top-of-file fixture — now on the roster
    const cockpit = await openClient(port);
    await nextMsg(cockpit, (m) => m.t === 'roster');
    cockpit.send(JSON.stringify({ t: 'join', callsign: 'octocat' }));

    assert.equal((await postTo(port, '/api/race/start', { session: 'cicd3' }, opHeader('op-key'))).status, 202);
    const running = await nextMsg(cockpit, (m) => m.t === 'race' && m.phase === 'running');
    assert.deepEqual(running.prompts, STORIES.cicd3); // the full story, in slide order
    assert.equal(running.total, STORIES.cicd3.length);
    const mine = running.ships.find((s) => s.callsign === 'octocat');
    assert.equal(mine.completed, 0);
    assert.equal(mine.color, '#22d3ee'); // enriched from the roster

    cockpit.send(JSON.stringify({ t: 'progress', completed: 1 }));
    const advanced = await nextMsg(cockpit, (m) => m.t === 'race' && m.ships.some((s) => s.callsign === 'octocat' && s.completed === 1));
    assert.ok(advanced);
    cockpit.close();
  } finally { await app.close(); }
});

test('operator endpoints require the operator key when set', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: 'op-key' });
  const port = app.port;
  try {
    assert.equal((await postTo(port, '/api/race/start', {})).status, 401);
    assert.equal((await postTo(port, '/api/race/start', {}, opHeader('wrong'))).status, 401);
    assert.equal((await postTo(port, '/api/view', { view: 'race' }, opHeader('op-key'))).status, 202);
  } finally { await app.close(); }
});

test('cockpit frac ripples into the race broadcast without advancing', async () => {
  const app = createServer({ port: 0, token: null, operatorKey: 'op-key' });
  const port = app.port;
  try {
    await post(port, ev);
    const cockpit = await openClient(port);
    await nextMsg(cockpit, (m) => m.t === 'roster');
    cockpit.send(JSON.stringify({ t: 'join', callsign: 'octocat' }));
    await postTo(port, '/api/race/start', { session: 'cicd3' }, opHeader('op-key'));
    await nextMsg(cockpit, (m) => m.t === 'race' && m.phase === 'running');

    cockpit.send(JSON.stringify({ t: 'progress', completed: 0, frac: 0.5 }));
    const partial = await nextMsg(cockpit, (m) =>
      m.t === 'race' && m.ships.some((s) => s.callsign === 'octocat' && s.frac === 0.5));
    assert.equal(partial.ships.find((s) => s.callsign === 'octocat').completed, 0);
    cockpit.close();
  } finally { await app.close(); }
});
