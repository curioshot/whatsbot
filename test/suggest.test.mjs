// node --test test/suggest.test.mjs — inline suggestion chips contract.
// Suggestions preview only (never auto-send): short plain strings, JSON
// {"suggestions": [...]} gate, per-item refusal of reasoning/echo/scaffold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestMessages, extractSuggestions } from '../src/common/providers.js';
import { suggestEnabledFor, migrateSnapshot, SCHEMA_VERSION } from '../src/common/store.js';

test('suggest prompt asks for JSON array with count', () => {
  const msgs = buildSuggestMessages({
    chatInstruction: 'Be brief.',
    contextMd: '',
    history: [],
    newMessages: [{ dir: 'in', sender: 'A', text: 'salam' }],
    count: 3,
  });
  assert.ok(msgs[0].content.includes('"suggestions"'));
  assert.ok(msgs[msgs.length - 1].content.includes('salam'));
});

test('extractSuggestions accepts clean arrays', () => {
  assert.deepEqual(
    extractSuggestions('{"suggestions": ["تمام", "Ok, got it", "Call you in 5?"]}'),
    ['تمام', 'Ok, got it', 'Call you in 5?'],
  );
});

test('extractSuggestions drops reasoning/echo per-item', () => {
  const raw = '{"suggestions": ["Hey, on my way", "THEM (they sent this): echo dump", "ok"]}';
  assert.deepEqual(extractSuggestions(raw), ['Hey, on my way', 'ok']);
  assert.deepEqual(extractSuggestions('{"suggestions": []}'), []);
  assert.deepEqual(extractSuggestions('not json at all'), []);
  assert.deepEqual(extractSuggestions('{"reply": "hi"}'), []);
});

test('extractSuggestions caps length/lines/braces', () => {
  assert.deepEqual(extractSuggestions('{"suggestions": ["' + 'x'.repeat(200) + '"]}'), []);
  assert.deepEqual(extractSuggestions('{"suggestions": ["a\\nb", "ok"]}'), ['ok']);
  assert.deepEqual(extractSuggestions('{"suggestions": ["use {a}", "ok"]}'), ['ok']);
});

test('suggestEnabledFor: per-chat wins, global fallback', () => {
  assert.equal(suggestEnabledFor({ suggestionsEnabled: true }, { suggestMode: 'global' }), true);
  assert.equal(suggestEnabledFor({ suggestionsEnabled: false }, { suggestMode: 'global' }), false);
  assert.equal(suggestEnabledFor({ suggestionsEnabled: false }, { suggestMode: 'on' }), true);
  assert.equal(suggestEnabledFor({ suggestionsEnabled: true }, { suggestMode: 'off' }), false);
});

test('migrateSnapshot v4 backfills suggest fields', () => {
  const { snapshot } = migrateSnapshot({
    wb_global: { enabled: true },
    wb_chats: { 'name:mom': { name: 'Mom' } },
  });
  assert.equal(snapshot.wb_schema, SCHEMA_VERSION);
  assert.equal(snapshot.wb_global.suggestionsEnabled, false);
  assert.equal(snapshot.wb_global.suggestCount, 3);
  assert.equal(snapshot.wb_chats['name:mom'].suggestMode, 'global');
});
