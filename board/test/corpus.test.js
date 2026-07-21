import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORIES, SESSIONS, pickPrompts } from '../src/corpus.js';

test('every session story is a non-empty list of distinct commands', () => {
  for (const [session, story] of Object.entries(STORIES)) {
    assert.ok(story.length > 0, `${session} empty`);
    assert.equal(new Set(story).size, story.length, `${session} has duplicates`);
    for (const cmd of story) assert.ok(typeof cmd === 'string' && cmd.length > 0);
  }
});

test('pickPrompts returns the full story in slide order', () => {
  assert.deepEqual(pickPrompts('cicd3'), STORIES.cicd3);
  assert.deepEqual(pickPrompts('cicd4'), STORIES.cicd4);
});

test('pickPrompts returns a copy, not the story itself', () => {
  const a = pickPrompts('cicd3');
  a.push('rm -rf /');
  assert.notEqual(a.length, STORIES.cicd3.length);
});

test('pickPrompts is empty for an unknown session', () => {
  assert.deepEqual(pickPrompts('nope'), []);
});

test('SESSIONS exposes the same keys app.js validates against', () => {
  assert.deepEqual(Object.keys(SESSIONS), Object.keys(STORIES));
  assert.ok(SESSIONS.cicd3);
  assert.ok(SESSIONS.cicd4);
});

test('stories open with their sequencing anchors', () => {
  // cicd3 starts by signing in and forking THE repo; cicd4 starts by syncing.
  assert.equal(STORIES.cicd3[0], 'gh auth login');
  assert.ok(STORIES.cicd3[1].includes('devops-bootcamp-shipit'));
  assert.equal(STORIES.cicd4[0], 'git fetch upstream');
});
