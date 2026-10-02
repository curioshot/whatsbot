// node --test test/models.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCaps, BOT_USES } from '../src/common/models.js';

test('flagship multimodal models', () => {
  assert.deepEqual(modelCaps('openai', 'gpt-4o-mini'), { text: true, image: true, audio: false, video: false, source: 'known' });
  assert.deepEqual(modelCaps('anthropic', 'claude-sonnet-4-20250514').image, true);
  assert.deepEqual(modelCaps('openrouter', 'google/gemini-2.0-flash-001'), { text: true, image: true, audio: true, video: true, source: 'known' });
});

test('text-only families', () => {
  const r = modelCaps('groq', 'llama-3.3-70b-versatile');
  assert.equal(r.text, true);
  assert.equal(r.image, false);
});

test('unknown model is honest', () => {
  const r = modelCaps('local', 'mystery-9b');
  assert.equal(r.source, 'guess');
  assert.equal(r.text, true);
  assert.equal(modelCaps('local', '').source, 'unknown');
});

test('bot pipeline is text-only (honest display)', () => {
  assert.deepEqual(BOT_USES, { text: true, image: false, audio: false, video: false });
});
