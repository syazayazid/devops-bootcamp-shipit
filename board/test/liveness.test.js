import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveness } from '../src/liveness.js';

const rosterOf = (...entries) => ({ list: () => entries });
const ok = () => Promise.resolve({ status: 200 });
const notFound = () => Promise.resolve({ status: 404 });

test('a reachable siteUrl (200) flips the ship live; onChange fires once per flip', async () => {
  let changes = 0;
  const roster = rosterOf({ callsign: 'octocat', siteUrl: 'https://octocat.github.io/x/' });
  const l = createLiveness({ roster, fetchImpl: ok, onChange: () => { changes += 1; } });
  await l.sweep();
  assert.equal(l.isLive('octocat'), true);
  assert.equal(changes, 1);
  await l.sweep(); // still 200 → no state change → no extra onChange
  assert.equal(changes, 1);
});

test('a non-200 site is never live', async () => {
  const roster = rosterOf({ callsign: 'mayday', siteUrl: 'https://mayday.github.io/x/' });
  const l = createLiveness({ roster, fetchImpl: notFound });
  await l.sweep();
  assert.equal(l.isLive('mayday'), false);
});

test('a fetch that throws (timeout/DNS) is treated as not-live, not an error', async () => {
  const roster = rosterOf({ callsign: 'ghost', siteUrl: 'https://ghost.github.io/x/' });
  const l = createLiveness({ roster, fetchImpl: () => Promise.reject(new Error('timeout')) });
  await assert.doesNotReject(l.sweep());
  assert.equal(l.isLive('ghost'), false);
});

test('a first-deploy 404 that later turns 200 flips green on a re-sweep', async () => {
  let phase = 404;
  const roster = rosterOf({ callsign: 'late', siteUrl: 'https://late.github.io/x/' });
  const l = createLiveness({ roster, fetchImpl: () => Promise.resolve({ status: phase }) });
  await l.sweep();
  assert.equal(l.isLive('late'), false);
  phase = 200; // deploy finished
  await l.sweep();
  assert.equal(l.isLive('late'), true);
});

test('entries without a siteUrl are skipped (no fetch, never live)', async () => {
  let called = 0;
  const roster = rosterOf({ callsign: 'nosite' });
  const l = createLiveness({ roster, fetchImpl: () => { called += 1; return ok(); } });
  await l.sweep();
  assert.equal(called, 0);
  assert.equal(l.isLive('nosite'), false);
});

test('HEAD is used with a timeout signal', async () => {
  let seen = null;
  const roster = rosterOf({ callsign: 'octocat', siteUrl: 'https://octocat.github.io/x/' });
  const l = createLiveness({ roster, fetchImpl: (url, opts) => { seen = opts; return ok(); } });
  await l.sweep();
  assert.equal(seen.method, 'HEAD');
  assert.ok(seen.signal, 'passes an AbortSignal so a hung site cannot stall the sweep');
});
