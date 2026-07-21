import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressOf, laneOrder, ranks } from './race-layout.js';

test('progressOf blends completed and frac over total, clamped', () => {
  assert.equal(progressOf(0, 0, 12), 0);
  assert.equal(progressOf(6, 0.5, 12), 6.5 / 12);
  assert.equal(progressOf(12, 0.9, 12), 1);   // finished: frac no longer counts
  assert.equal(progressOf(13, 0, 12), 1);     // over-report clamps
  assert.equal(progressOf(3, -1, 12), 3 / 12); // junk frac clamps low
  assert.equal(progressOf(3, 2, 12), 4 / 12);  // junk frac clamps high
  assert.equal(progressOf(5, 0.5, 0), 0);     // degenerate total
});

test('laneOrder sorts alphabetically without mutating input', () => {
  const ships = [{ callsign: 'zed' }, { callsign: 'ada' }, { callsign: 'mel' }];
  const out = laneOrder(ships);
  assert.deepEqual(out.map((s) => s.callsign), ['ada', 'mel', 'zed']);
  assert.equal(ships[0].callsign, 'zed'); // input untouched
});

test('ranks: finished first by finishedAt, then by completed+frac, ties alphabetical', () => {
  const ships = [
    { callsign: 'slow', completed: 2, frac: 0.1, finishedAt: null },
    { callsign: 'winner', completed: 12, frac: 0, finishedAt: 1 },
    { callsign: 'second', completed: 12, frac: 0, finishedAt: 2 },
    { callsign: 'fast', completed: 7, frac: 0.5, finishedAt: null },
    { callsign: 'alsofast', completed: 7, frac: 0.5, finishedAt: null },
  ];
  const r = ranks(ships);
  assert.equal(r.get('winner'), 1);
  assert.equal(r.get('second'), 2);
  assert.equal(r.get('alsofast'), 3); // tie with fast → alphabetical
  assert.equal(r.get('fast'), 4);
  assert.equal(r.get('slow'), 5);
});
