// node --test test/sessions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  limitForModel, estTokens, estimateUsage, newSession, shortId, sessionRatio,
  sessionState, decideRollover, closeSession, pruneSessions, formatCtx,
} from '../src/common/sessions.js';

test('limitForModel: known, prefix, unknown, override', () => {
  assert.deepEqual(limitForModel('gpt-4o-mini'), { limit: 128000, known: true });
  assert.deepEqual(limitForModel('gpt-4o-2024-11-20'), { limit: 128000, known: true });
  assert.deepEqual(limitForModel('mystery-model-9'), { limit: 32000, known: false });
  assert.deepEqual(limitForModel('mystery', 50000), { limit: 50000, known: true });
});

test('estTokens ~ chars/4', () => {
  assert.equal(estTokens('abcd'), 1);
  assert.equal(estTokens('abcde'), 2);
  assert.equal(estimateUsage({ systemChars: 'abcd', historyChars: '', contextChars: '', reserveTokens: 10 }), 11);
});

test('sessionState thresholds', () => {
  const s = newSession('c', 1);
  assert.equal(sessionState({ ...s, estTokens: 100 }, 128000), 'active');
  assert.equal(sessionState({ ...s, estTokens: 110000 }, 128000), 'warning');
  assert.equal(sessionState({ ...s, estTokens: 125000 }, 128000), 'full');
  assert.equal(sessionState(closeSession(s, 'closed'), 128000), 'closed');
});

test('decideRollover', () => {
  const s = newSession('c', 1);
  assert.equal(decideRollover(s, 128000, false).action, 'keep');
  assert.equal(decideRollover({ ...s, estTokens: 127000 }, 128000, false).action, 'roll-full');
  assert.equal(decideRollover(s, 128000, true).action, 'roll-error');
  const old = Date.now() - 25 * 3600 * 1000;
  assert.equal(decideRollover({ ...s, startedAt: old, lastActiveAt: old, msgCount: 3 }, 128000, false).action, 'roll-idle');
});

test('pruneSessions keeps newest 10', () => {
  const arr = Array.from({ length: 15 }, (_, i) => ({ n: i + 1 }));
  assert.equal(pruneSessions(arr).length, 10);
  assert.equal(pruneSessions(arr)[0].n, 6);
});

test('formatCtx', () => {
  assert.equal(formatCtx(12400, 128000, true), '12.4k/128.0k');
  assert.equal(formatCtx(500, 32000, false), '500/32.0k est.');
});

test('shortId unique + timestamped', () => {
  const ids = new Set(Array.from({ length: 200 }, shortId));
  assert.equal(ids.size, 200);
});

test('limitForModel reverse-prefix needs length', () => {
  assert.equal(limitForModel('g').known, false);
  assert.equal(limitForModel('gpt-4o-2024-11-20').limit, 128000);
});

test('idle uses lastActiveAt, not creation', () => {
  const now = Date.now();
  const busy = { ...newSession('c', 1, now - 25 * 3600 * 1000), lastActiveAt: now, msgCount: 3 };
  assert.equal(decideRollover(busy, 128000, false, now).action, 'keep');
  const idle = { ...newSession('c', 1, now - 25 * 3600 * 1000), lastActiveAt: now - 25 * 3600 * 1000, msgCount: 3 };
  assert.equal(decideRollover(idle, 128000, false, now).action, 'roll-idle');
});
