// node --test test/extract.test.mjs — guards the allowlist output gate.
// Contract: default mode sends ONLY proven {"reply"} values. plain-strict
// additionally sends short blobs that cannot be anything but chat text.
// device mode cleans CLI tool output. Everything else is refused ('').
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReplyText as X } from '../src/common/providers.js';

test('pure JSON reply (all modes)', () => {
  assert.equal(X('{"reply": "All good!"}'), 'All good!');
  assert.equal(X('{"reply": "All good!"}', { mode: 'plain-strict' }), 'All good!');
  assert.equal(X('{"reply": "All good!"}', { mode: 'device' }), 'All good!');
});

test('JSON + trailing reasoning garbage still extracts (no leak)', () => {
  const raw = '{"reply": "Thanks!"}\n\nNote: I kept it short and matched tone.';
  assert.equal(X(raw), 'Thanks!');
});

test('reply text containing braces survives', () => {
  assert.equal(X('{"reply": "use {a} here"} trailing words'), 'use {a} here');
});

test('format-example placeholder is refused, not sent', () => {
  assert.equal(X('I should output {"reply": "..."} for the answer'), '');
});

test('prompt echo dump is refused', () => {
  const dump = 'THEM (they sent this, display name "Tareq"): Hello\nWe need to decide the latest message.';
  assert.equal(X(dump), '');
  assert.equal(X(dump, { mode: 'plain-strict' }), '');
});

test('default mode refuses plain text (allowlist: JSON only)', () => {
  assert.equal(X('Thanks, all set!'), '');
  assert.equal(X('We need to meet tomorrow, ok?'), '');
  assert.equal(X('<think>secret planning</think>Hey, got it!'), '');
});

test('plain-strict sends genuine short replies', () => {
  assert.equal(X('Thanks, all set!', { mode: 'plain-strict' }), 'Thanks, all set!');
  assert.equal(X('We need to meet tomorrow, ok?', { mode: 'plain-strict' }), 'We need to meet tomorrow, ok?');
  assert.equal(X('<think>secret planning</think>Hey, got it!', { mode: 'plain-strict' }), 'Hey, got it!');
  assert.equal(X('تمام، شكرا!', { mode: 'plain-strict' }), 'تمام، شكرا!');
});

test('plain-strict refuses the reported leak blobs', () => {
  assert.equal(X('{"{"', { mode: 'plain-strict' }), ''); // brace fragment
  const escaping = 'We need to output exactly {"reply": "..."} with no extra text. Ensure proper escaping of quotes inside string. Use double quotes for JSON; inside we need to escape double quotes as \\". Also need to escape backslashes if any.';
  assert.equal(X(escaping, { mode: 'plain-strict' }), '');
  const diagram = 'Workflow (ASCII):\n[List Committee Members]\n|\nv\n[Assign Roles]\n|\nv\n[Meeting]';
  assert.equal(X(diagram, { mode: 'plain-strict' }), '');
  const long = 'Hey! ' + 'very '.repeat(100) + 'long message here';
  assert.equal(X(long, { mode: 'plain-strict' }), '');
});

test('pure reasoning dump is refused everywhere, never echoed raw', () => {
  for (const mode of [undefined, { mode: 'plain-strict' }, { mode: 'device' }]) {
    assert.equal(X('<think>long private reasoning here</think>', mode || {}), '', String(mode));
    assert.equal(X('<reasoning>step one\nstep two</reasoning>', mode || {}), '', String(mode));
  }
});

test('bare {} is refused, never sent', () => {
  assert.equal(X('{}'), '');
  assert.equal(X('{}', { mode: 'plain-strict' }), '');
});

test('empty reply field is refused, never sent literally', () => {
  assert.equal(X('{"reply": ""}'), '');
  assert.equal(X('{"reply": "   "}'), '');
});

test('JSON without reply field is refused', () => {
  assert.equal(X('{"foo": "bar"}'), '');
});

test('device mode cleans tool output, refuses meta-talk', () => {
  assert.equal(X('Fixed login bug, 3 files changed.', { mode: 'device' }), 'Fixed login bug, 3 files changed.');
  assert.equal(X('<think>plan</think>Done.', { mode: 'device' }), 'Done.');
  assert.equal(X('We need to output exactly {"reply": "x"}', { mode: 'device' }), '');
});
