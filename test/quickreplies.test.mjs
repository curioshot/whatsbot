// node --test test/quickreplies.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuick, matchQuickreplies, findQuickreply, fillPlaceholders, QUICK_MAX } from '../src/common/quickreplies.js';

const LIST = [
  { id: 'q1', title: 'addr', text: 'Come to {name}', chats: ['*'] },
  { id: 'q2', title: 'price', text: 'It costs 5', chats: ['name:mom'] },
  { id: 'q3', title: 'gone', text: 'x', chats: ['name:deleted'] },
];

test('validateQuick rejects empties and overlong', () => {
  assert.ok(validateQuick({ title: '', text: 'x' }));
  assert.ok(validateQuick({ title: 'a'.repeat(31), text: 'x' }));
  assert.ok(validateQuick({ title: 'ok', text: '' }));
  assert.ok(validateQuick({ title: 'ok', text: 'x'.repeat(501) }));
  assert.equal(validateQuick({ title: 'ok', text: 'hi' }), '');
  assert.equal(QUICK_MAX, 50);
});

test('matchQuickreplies scopes by chat', () => {
  const mom = matchQuickreplies(LIST, 'name:mom').map((q) => q.id);
  assert.deepEqual(mom, ['q1', 'q2']);
  const dad = matchQuickreplies(LIST, 'name:dad').map((q) => q.id);
  assert.deepEqual(dad, ['q1']);
});

test('findQuickreply exact first, then prefix', () => {
  assert.equal(findQuickreply(LIST, 'name:mom', 'ADDR').id, 'q1');
  assert.equal(findQuickreply(LIST, 'name:mom', 'pri').id, 'q2');
  assert.equal(findQuickreply(LIST, 'name:mom', 'nope'), null);
  assert.equal(findQuickreply(LIST, 'name:dad', 'price'), null);
});

test('fillPlaceholders swaps {name}', () => {
  assert.equal(fillPlaceholders('Hi {name}!', 'Mom'), 'Hi Mom!');
  assert.equal(fillPlaceholders('Hi {name}!', ''), 'Hi there!');
});
