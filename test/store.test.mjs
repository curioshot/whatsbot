// node --test test/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSnapshot, SCHEMA_VERSION } from '../src/common/store.js';
import { on, has, types, dispatch, WbError } from '../src/common/bus.js';

test('migrateSnapshot backfills legacy store', () => {
  const { snapshot, migrated, from } = migrateSnapshot({
    wb_global: { enabled: true },
    wb_chats: { 'name:mom': { name: 'Mom' } },
  });
  assert.equal(migrated, true);
  assert.equal(from, 1);
  assert.equal(snapshot.wb_schema, SCHEMA_VERSION);
  assert.equal(snapshot.wb_global.enabled, true);
  assert.equal(snapshot.wb_global.historyLimit, 30);
  assert.equal(snapshot.wb_global.ctxLimitOverride, 0);
  assert.equal(snapshot.wb_chats['name:mom'].mode, 'auto');
  assert.equal(snapshot.wb_chats['name:mom'].allowed, false);
  assert.deepEqual(snapshot.wb_subbots, {});
  assert.equal(snapshot.wb_global.device.defaultAgent, 'opencode');
  assert.equal(snapshot.wb_global.device.useAsDefault, false);
  assert.equal(snapshot.wb_global.prevCloudProvider, 'openai');
  assert.equal(snapshot.wb_global.dailyChatCap, 100);
  assert.equal(snapshot.wb_global.dailyTotalCap, 1000);
  assert.equal(snapshot.wb_global.triggerPrefix, '');
  assert.deepEqual(snapshot.wb_quickreplies, []);
});

test('migrateSnapshot keeps existing quick replies', () => {
  const { snapshot } = migrateSnapshot({ wb_quickreplies: [{ id: 'q1', title: 'a' }] });
  assert.deepEqual(snapshot.wb_quickreplies, [{ id: 'q1', title: 'a' }]);
});

test('migrateSnapshot is idempotent on current schema', () => {
  const once = migrateSnapshot({ wb_schema: SCHEMA_VERSION, wb_global: { enabled: true } });
  assert.equal(once.migrated, false);
  assert.equal(once.snapshot.wb_global.enabled, true);
});

test('bus: register, dispatch, unknown type, duplicate guard', async () => {
  assert.equal(has('TEST_PING_X'), false);
  on('TEST_PING_X', async (msg) => ({ echo: msg.n + 1 }));
  assert.equal(has('TEST_PING_X'), true);
  assert.ok(types().includes('TEST_PING_X'));
  assert.deepEqual(await dispatch({ type: 'TEST_PING_X', n: 1 }), { echo: 2 });
  await assert.rejects(dispatch({ type: 'NOPE_X' }), (e) => e instanceof WbError && e.code === 'UNKNOWN_TYPE');
  assert.throws(() => on('TEST_PING_X', async () => ({})), /duplicate/);
});

test('bus: handler errors propagate with code', async () => {
  on('TEST_FAIL_X', async () => { throw new WbError('NO_INSTRUCTION', 'nope'); });
  await assert.rejects(dispatch({ type: 'TEST_FAIL_X' }), (e) => e.code === 'NO_INSTRUCTION');
});
