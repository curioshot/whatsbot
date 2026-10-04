// node --test test/layout.test.mjs — selector centralization.
// WhatsApp renames its DOM often; the fix must always land in exactly one
// file (src/content/whatsapp-dom.js). This test fails if a WA selector
// literal leaks back into content.js — move it into WADOM instead.
// (whatsapp-dom.js itself is SUPPOSED to contain them; it is excluded here.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content = fs.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
const wadom = fs.readFileSync(new URL('../src/content/whatsapp-dom.js', import.meta.url), 'utf8');

const BANNED_IN_CONTENT = [
  'message-in', 'message-out', 'msg-container', 'msg-text', 'msg-meta',
  'unread-count', '#main header', "getElementById('side')", '#pane-side',
];

test('no hardcoded WA selectors in content.js', () => {
  for (const lit of BANNED_IN_CONTENT) {
    assert.ok(!content.includes(lit), `move '${lit}' into whatsapp-dom.js`);
  }
});

test('WADOM exposes every centralized helper content.js uses', () => {
  const used = [...content.matchAll(/window\.WADOM\.(\w+)/g)].map((m) => m[1]);
  for (const name of new Set(used)) {
    if (name === 'SEL') continue;
    assert.ok(new RegExp(`\\b${name}\\s*\\(`).test(wadom), `WADOM missing helper: ${name}`);
  }
});

test('probeLayout covers the critical signals', () => {
  for (const key of ['app', 'chatList', 'chatRow', 'searchBox', 'convoBody', 'header', 'composer', 'sendBtn', 'msgRow', 'msgText']) {
    assert.ok(wadom.includes(key), `probeLayout missing signal: ${key}`);
  }
});
