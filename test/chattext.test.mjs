// node --test test/chattext.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { memorySentence, chatStateSentence } from '../src/common/chattext.js';

test('memorySentence counts messages in plain words', () => {
  assert.equal(memorySentence({ contextMsgCount: 42 }, 42), 'Knows you from 42 messages');
  assert.equal(memorySentence({ contextMsgCount: 1 }, 1), 'Knows you from 1 message');
  assert.equal(memorySentence({}, 5), 'Has some history — saving teaches it');
  assert.equal(memorySentence({}, 0), 'No memory yet — saving teaches it');
});

test('chatStateSentence names the state, not the code', () => {
  assert.equal(chatStateSentence(null, true), 'Not set up yet');
  assert.equal(chatStateSentence({ allowed: true, instruction: '' }, true), 'Needs instructions');
  assert.equal(chatStateSentence({ allowed: false, instruction: 'x' }, true), 'Paused');
  assert.equal(chatStateSentence({ allowed: true, instruction: 'x' }, false), 'Ready — bot is off');
  assert.equal(chatStateSentence({ allowed: true, instruction: 'x', mode: 'manual' }, true), 'Manual replies only');
  assert.equal(chatStateSentence({ allowed: true, instruction: 'x', mode: 'auto' }, true), 'Answering');
});
