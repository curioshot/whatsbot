// node --test test/subbots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { subbotId, chatIdForName, normalizeName, canonicalNameFor, resolveChatId, autoName, bindWatchRule, restoreRule, newSubbot, parseSubbotOffline } from '../src/common/subbots.js';

test('chatIdForName normalizes', () => {
  assert.equal(chatIdForName('  Tareq A Khan '), 'name:tareq a khan');
  assert.equal(chatIdForName('business_assistant'), 'name:business assistant');
  assert.equal(chatIdForName('Business-Assistant'), 'name:business assistant');
});

test('subbotId unique', () => {
  assert.equal(new Set(Array.from({ length: 200 }, subbotId)).size, 200);
});

test('bind snapshots + installs instruction (preserves unknown fields)', () => {
  const rule = { name: 'Mom', allowed: false, mode: 'manual', instruction: 'Old.', routeTo: 'cloud', cwd: '', contextMd: 'mem', contextMsgCount: 9 };
  const bot = { id: 'b-1', target: 'Mom', instruction: 'New.' };
  const { rule: next, prev } = bindWatchRule(rule, bot);
  assert.equal(next.instruction, 'New.');
  assert.equal(next.allowed, true);
  assert.equal(next.managedBy, 'b-1');
  assert.equal(next.contextMd, 'mem');
  assert.equal(next.contextMsgCount, 9);
  assert.deepEqual(prev, { hadRule: true, instruction: 'Old.', allowed: false, mode: 'manual', routeTo: 'cloud', cwd: '' });
});

test('restore returns previous state exactly', () => {
  const rule = { name: 'Mom', allowed: true, mode: 'auto', routeTo: 'device:opencode', cwd: '~/x', instruction: 'New.', managedBy: 'b-1' };
  const prev = { hadRule: true, instruction: 'Old.', allowed: false, mode: 'manual', routeTo: 'cloud', cwd: '' };
  const back = restoreRule(rule, prev);
  assert.equal(back.instruction, 'Old.');
  assert.equal(back.allowed, false);
  assert.equal(back.mode, 'manual');
  assert.equal(back.routeTo, 'cloud');
  assert.equal(back.cwd, '');
  assert.equal(back.managedBy, null);
});

test('restore of auto-created rule keeps history, switches off', () => {
  const back = restoreRule({ name: 'X', managedBy: 'b-1', contextMd: 'mem' }, { hadRule: false });
  assert.equal(back.allowed, false);
  assert.equal(back.managedBy, null);
  assert.equal(back.contextMd, 'mem');
});

test('offline parser: watch phrasings', () => {
  for (const t of ['respond to Krypton continuously', 'run a bot that continuously responds to "Mom"', 'watch Family group']) {
    const r = parseSubbotOffline(t);
    assert.ok(r, t);
    assert.equal(r.kind, 'watch');
    assert.ok(r.target.length > 0);
  }
  assert.equal(parseSubbotOffline('respond to Krypton continuously').target, 'Krypton');
});

test('offline parser: task phrasings', () => {
  const r = parseSubbotOffline('make a list of the users who chatted me last month');
  assert.ok(r);
  assert.equal(r.kind, 'task');
  assert.equal(parseSubbotOffline('what is the weather'), null);
  assert.equal(parseSubbotOffline(''), null);
});

test('newSubbot shape', () => {
  const b = newSubbot({ kind: 'watch', target: 'Krypton', instruction: 'Be brief.' });
  assert.equal(b.status, 'running');
  assert.equal(b.targetChatId, 'name:krypton');
  assert.equal(b.name, 'Responder: Krypton');
});

test('underscore/hyphen targets resolve to the stored chat', () => {
  const chats = { 'name:business assistant': { name: 'Business assistant' } };
  assert.equal(canonicalNameFor(chats, 'business_assistant'), 'Business assistant');
  assert.equal(resolveChatId(chats, 'business_assistant', 'chat'), 'name:business assistant');
  assert.equal(normalizeName('Business-Assistant'), 'business assistant');
});
