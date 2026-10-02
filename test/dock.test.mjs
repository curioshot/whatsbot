// node --test test/dock.test.mjs — dock template integrity.
// Guards the class of bug where feedback silently vanishes: duplicate ids
// (querySelector hits the wrong node) or template/wiring drift (wired id
// missing from the template, so its button is dead).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');

// ids the wiring depends on (must exist in the template)
const WIRED = ['wb-think', 'wb-thinktxt', 'wb-elapsed', 'wb-detail', 'wb-quote',
  'wb-tsteps', 'wb-brain', 'wb-scan', 'wb-dom', 'wb-session', 'wb-rlabel',
  'wb-sent', 'wb-result', 'wb-task', 'wb-go', 'wb-subsec', 'wb-bots-toggle',
  'wb-bots-sum', 'wb-subnew', 'wb-subrun', 'wb-subconfirm', 'wb-sublist',
  'wb-panic', 'wb-dismiss', 'wb-onboard', 'wb-steps', 'wb-reply', 'wb-build',
  'wb-fab', 'wb-hide', 'wb-drag', 'wb-ver', 'wb-count'];

test('no duplicate wb-* ids in dock template', () => {
  const ids = [...src.matchAll(/id="(wb-[a-z-]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(id), `duplicate id #${id}`);
    seen.add(id);
  }
});

test('every wired id exists in the template', () => {
  for (const id of WIRED) {
    assert.ok(src.includes(`id="${id}"`), `wired but missing from template: #${id}`);
  }
});

test('DOCK_IDS checklist covers every wired id', () => {
  const m = src.match(/const DOCK_IDS = \[([\s\S]*?)\];/);
  assert.ok(m, 'DOCK_IDS not found');
  for (const id of WIRED) {
    const sel = id === 'wb-status' ? '.wb-status' : `#${id}`;
    assert.ok(m[1].includes(`'${sel}'`), `DOCK_IDS missing ${sel}`);
  }
});
