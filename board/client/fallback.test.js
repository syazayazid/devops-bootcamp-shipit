import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseFallback, escapeHtml } from './fallback.js';

test('shouldUseFallback when no WebGL or reduced motion', () => {
  assert.equal(shouldUseFallback({ gl: true, reducedMotion: false }), false);
  assert.equal(shouldUseFallback({ gl: false, reducedMotion: false }), true);
  assert.equal(shouldUseFallback({ gl: true, reducedMotion: true }), true);
});

test('escapeHtml neutralises HTML metacharacters', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml('a & b "q" \'z\''), 'a &amp; b &quot;q&quot; &#39;z&#39;');
});
