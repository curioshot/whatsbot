// node --test test/twin.test.mjs — twin-drift guard.
// content.js (classic, no imports) carries a twin of attributeMessage.
// This test extracts the twin from source and runs it against the SAME
// fixture matrix as the module: any behavioral drift fails loudly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attributeMessage } from '../src/common/attribution.js';

const src = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const m = src.match(/function attributeSignals\([\s\S]*?\n  \}\n/);
assert.ok(m, 'twin not found in content.js');
const twin = new Function(`${m[0]}; return attributeSignals;`)();

const MATRIX = [
  { clsIn: true, clsOut: false, dataId: 'false_h', preAuthor: '', chatName: 'Tareq', isGroup: false },
  { clsIn: false, clsOut: true, dataId: 'true_h', preAuthor: '', chatName: 'Tareq', isGroup: false },
  { clsIn: true, clsOut: false, dataId: 'true_h', preAuthor: '', chatName: 'Tareq', isGroup: false },
  { clsIn: false, clsOut: false, dataId: 'false_h', preAuthor: '', chatName: 'Tareq', isGroup: false },
  { clsIn: false, clsOut: false, dataId: '', preAuthor: '', chatName: 'T', isGroup: false, align: 'left' },
  { clsIn: false, clsOut: false, dataId: '', preAuthor: '', chatName: 'T', isGroup: false, align: 'right' },
  { clsIn: false, clsOut: false, dataId: '', preAuthor: '', chatName: 'T', isGroup: false, align: 'center' },
  { clsIn: true, clsOut: false, dataId: '', preAuthor: '[14:02] Someone: ', chatName: 'Fam', isGroup: false },
  { clsIn: true, clsOut: false, dataId: 'false_h', preAuthor: '[14:02] A Khan: ', chatName: 'Family', isGroup: true },
  { clsIn: false, clsOut: true, dataId: '', preAuthor: '', chatName: 'T', isGroup: false },
  { clsIn: true, clsOut: true, dataId: '', preAuthor: '', chatName: 'T', isGroup: false },
  { clsIn: false, clsOut: false, dataId: 'weird', preAuthor: '', chatName: 'T', isGroup: false },
];

test('twin matches module on every fixture', () => {
  for (const s of MATRIX) {
    assert.deepEqual(twin(s), attributeMessage(s), `drift on ${JSON.stringify(s)}`);
  }
});
