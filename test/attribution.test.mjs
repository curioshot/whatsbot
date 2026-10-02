// node --test test/attribution.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDataIdFlag, parsePreAuthor, attributeMessage, formatTranscript } from '../src/common/attribution.js';

test('parseDataIdFlag', () => {
  assert.equal(parseDataIdFlag('true_AB12_c.us'), 'out');
  assert.equal(parseDataIdFlag('false_XY99_x'), 'in');
  assert.equal(parseDataIdFlag('blah'), null);
  assert.equal(parseDataIdFlag(''), null);
});

test('parsePreAuthor', () => {
  assert.equal(parsePreAuthor('[14:02, 26/09/2026] Tareq A Khan: '), 'Tareq A Khan');
  assert.equal(parsePreAuthor(''), null);
});

test('1:1 incoming: class+id agree → them/chat name', () => {
  const r = attributeMessage({ clsIn: true, clsOut: false, dataId: 'false_h', preAuthor: '', chatName: 'Tareq', isGroup: false });
  assert.deepEqual(r, { dir: 'in', speaker: 'them', name: 'Tareq', via: 'signals' });
});

test('1:1 outgoing: class+id agree → you', () => {
  const r = attributeMessage({ clsIn: false, clsOut: true, dataId: 'true_h', preAuthor: '', chatName: 'Tareq', isGroup: false });
  assert.deepEqual(r, { dir: 'out', speaker: 'you', name: 'You (phone owner)', via: 'signals' });
});

test('class/id disagree → uncertain (never guess)', () => {
  const r = attributeMessage({ clsIn: true, clsOut: false, dataId: 'true_h', preAuthor: '', chatName: 'Tareq', isGroup: false });
  assert.deepEqual(r, { dir: 'uncertain', speaker: 'unknown', name: 'Unknown', via: 'conflict' });
});

test('layout fallback: left→in, right→out, center→uncertain', () => {
  const base = { clsIn: false, clsOut: false, dataId: '', preAuthor: '', chatName: 'Tareq', isGroup: false };
  const l = attributeMessage({ ...base, align: 'left' });
  assert.equal(l.dir, 'in'); assert.equal(l.via, 'layout');
  const r = attributeMessage({ ...base, align: 'right' });
  assert.equal(r.dir, 'out'); assert.equal(r.via, 'layout');
  const c = attributeMessage({ ...base, align: 'center' });
  assert.equal(c.dir, 'uncertain'); assert.equal(c.via, 'none');
});

test('layout never overrules a signal conflict', () => {
  const r = attributeMessage({ clsIn: true, clsOut: false, dataId: 'true_h', preAuthor: '', chatName: 'Tareq', isGroup: false, align: 'left' });
  assert.equal(r.dir, 'uncertain');
});

test('single signal suffices (id only)', () => {
  const r = attributeMessage({ clsIn: false, clsOut: false, dataId: 'false_h', preAuthor: '', chatName: 'Tareq', isGroup: false });
  assert.equal(r.dir, 'in');
});

test('group incoming uses author header', () => {
  const r = attributeMessage({ clsIn: true, clsOut: false, dataId: 'false_h', preAuthor: '[14:02, 26/09/2026] Tareq A Khan: ', chatName: 'Family', isGroup: true });
  assert.deepEqual(r, { dir: 'in', speaker: 'them', name: 'Tareq A Khan', via: 'signals' });
});

test('group incoming without author → flagged, not chat name', () => {
  const r = attributeMessage({ clsIn: true, clsOut: false, dataId: null, preAuthor: '', chatName: 'Family', isGroup: true });
  assert.equal(r.name, 'Family (unknown author)');
});

test('same-name speakers stay distinct by direction', () => {
  const mine = attributeMessage({ clsIn: false, clsOut: true, dataId: 'true_1', preAuthor: '', chatName: 'Tareq', isGroup: false });
  const theirs = attributeMessage({ clsIn: true, clsOut: false, dataId: 'false_2', preAuthor: '', chatName: 'Tareq', isGroup: false });
  assert.equal(mine.speaker, 'you');
  assert.equal(theirs.speaker, 'them');
});

test('formatTranscript prefixes', () => {
  const t = formatTranscript(
    [{ speaker: 'you', text: 'Here are the PDFs' }, { speaker: 'them', name: 'Tareq', text: 'Hello' }, { speaker: 'unknown', text: '???' }],
    { contactName: 'Tareq', chatKind: '1:1' },
  );
  assert.match(t, /^Chat type: 1:1 with "Tareq"/);
  assert.match(t, /YOU: Here are the PDFs/);
  assert.match(t, /THEM \(Tareq\): Hello/);
  assert.match(t, /\?\?\?: \?\?\?/);
});
