import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance } from './typing.js';

test('advance consumes matching characters', () => {
  assert.equal(advance('git push', 0, 'git'), 3);
  assert.equal(advance('git push', 3, ' push'), 8);
});

test('advance stops at the first wrong character and drops the rest', () => {
  assert.equal(advance('git', 1, 'xt'), 1);
  assert.equal(advance('git push', 3, ' pxsh'), 5); // " p" lands, "xsh" dropped
});

test('advance never walks past the target', () => {
  assert.equal(advance('ls', 2, 'anything'), 2);
  assert.equal(advance('ls', 0, 'ls -l'), 2);
});

test('advance with empty incoming is a no-op', () => {
  assert.equal(advance('ls', 1, ''), 1);
});
