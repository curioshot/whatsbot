// Live-slot harness: boots the REAL service worker with stubbed chrome/fetch
// and exercises every message type. Run: node test/helpers/harness.mjs
// (not part of node --test; it performs live flows with assertions inline).
const store = {
  wb_global: {
    activeProvider: 'openai', enabled: true, historyLimit: 30,
    contextBuildCap: 800, scrollBatchDelayMs: 900, debounceMs: 4000,
    replyDelayMinMs: 1200, replyDelayMaxMs: 2800, maxLogPerChat: 2000,
    ctxLimitOverride: 0, device: { url: 'http://127.0.0.1:9', token: '', lastSeen: 0, agents: [] },
    routePrefix: '/code', globalInstruction: '', suggestionsEnabled: true, suggestCount: 3,
  },
  wb_providers: {
    openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini', modelsCache: [], modelsFetchedAt: 0 },
  },
  wb_chats: {
    'name:tareq': { name: 'Tareq', allowed: true, mode: 'auto', routeTo: 'cloud', cwd: '', instruction: 'Be brief.' },
  },
  wb_logs: {
    'name:tareq': [
      { ts: Date.now() - 86400000 * 2, dir: 'in', sender: 'Tareq', text: 'old msg', msgId: 'o1' },
      { ts: Date.now(), dir: 'in', sender: 'Tareq', text: 'new msg', msgId: 'o2' },
    ],
  },
  wb_subbots: {},
};

const clone = (o) => JSON.parse(JSON.stringify(o));

globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys == null) return clone(store);
        const arr = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of arr) if (k in store) out[k] = clone(store[k]);
        return out;
      },
      set: async (obj) => { Object.assign(store, clone(obj)); },
    },
    session: {
      _m: {},
      get: async (keys) => { const a = Array.isArray(keys) ? keys : [keys]; const o = {}; for (const k of a) if (k in globalThis.chrome.storage.session._m) o[k] = globalThis.chrome.storage.session._m[k]; return o; },
      set: async (obj) => { Object.assign(globalThis.chrome.storage.session._m, clone(obj)); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete globalThis.chrome.storage.session._m[k]; },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    id: 'test-ext',
    onMessage: { addListener(fn) { globalThis.__onMsg = fn; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  tabs: {
    query: async () => [],
    sendMessage: async () => { throw new Error('no WA tab in harness'); },
  },
};

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = String(opts.body || '');
  if (u.includes('127.0.0.1:9')) throw new Error('bridge down (simulated)');
  if (u.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }), text: async () => '' };
  if (body.includes('Known chats:')) return { ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"report_unread"}' } }] }), text: async () => '' };
  if (body.includes('unread messages. Write')) return { ok: true, json: async () => ({ choices: [{ message: { content: 'Report: 1 chat unread.' } }] }), text: async () => '' };
  if (body.includes('Suggest ') && body.includes('suggestions')) return { ok: true, json: async () => ({ choices: [{ message: { content: '{"suggestions": ["Yes", "No", "Call you?"]}' } }] }), text: async () => '' };
  if (body.includes('owner command into EXACTLY')) return { ok: true, json: async () => ({ choices: [{ message: { content: '{"kind":"task","target":"recent","task":"list","name":"T"}' } }] }), text: async () => '' };
  if (body.includes('Summarize this WhatsApp session')) return { ok: true, json: async () => ({ choices: [{ message: { content: 'Summary bullets.' } }] }), text: async () => '' };
  if (body.includes('Build context.md')) return { ok: true, json: async () => ({ choices: [{ message: { content: '# ctx' } }] }), text: async () => '' };
  return { ok: true, json: async () => ({ choices: [{ message: { content: '{"reply": "Hey!"}' } }] }), text: async () => '' };
};

function send(msg, sender = { id: 'test-ext' }) {
  return new Promise((resolve, reject) => {
    try {
      globalThis.__onMsg(msg, sender, resolve);
      setTimeout(() => reject(new Error('TIMEOUT ' + msg.type)), 15000);
    } catch (e) { reject(e); }
  });
}
const WA_TAB = { id: 'test-ext', tab: { url: 'https://web.whatsapp.com/' } };
const EVIL_TAB = { id: 'test-ext', tab: { url: 'https://evil.example/' } };

await import('../../src/background/service-worker.js');
const results = [];
async function t(name, msg, check, sender) {
  try {
    const r = await send(msg, sender);
    const ok = check(r);
    results.push([ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(r).slice(0, 200)]);
  } catch (e) { results.push(['FAIL', name, 'threw: ' + e.message]); }
}

await t('GEN_REPLY cloud', { type: 'GEN_REPLY', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [{ dir: 'in', sender: 'Tareq', text: 'hi', msgId: 'm1' }] }, (r) => r.ok && r.reply === 'Hey!' && !!r.session?.id);
await t('GEN_REPLY gate', { type: 'GEN_REPLY', chatId: 'name:x', chatName: 'X', history: [], newMessages: [] }, (r) => !r.ok && r.code === 'NO_INSTRUCTION');
await t('GEN_REPLY prefix-strip', { type: 'GEN_REPLY', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [{ dir: 'in', sender: 'Tareq', text: 'hello again', msgId: 'm2' }] }, (r) => r.ok);
await t('LOG_INCOMING', { type: 'LOG_INCOMING', chatId: 'name:tareq', messages: [{ dir: 'in', text: 'ping', msgId: 'p1' }] }, (r) => r.ok);
await t('SAVE_CONTEXT_BATCH', { type: 'SAVE_CONTEXT_BATCH', chatId: 'name:new', chatName: 'New', messages: [{ dir: 'in', text: 'a', msgId: 'a1' }] }, (r) => r.ok && r.total >= 1);
await t('FINALIZE_CONTEXT', { type: 'FINALIZE_CONTEXT', chatId: 'name:tareq', chatName: 'Tareq' }, (r) => r.ok && typeof r.contextMd === 'string');
await t('FINALIZE_CONTEXT empty-guard', { type: 'FINALIZE_CONTEXT', chatId: 'name:empty', chatName: 'Empty' }, (r) => !r.ok);
await t('TEST_CONNECTION', { type: 'TEST_CONNECTION' }, (r) => r.ok);
await t('LIST_MODELS', { type: 'LIST_MODELS', provider: 'openai' }, (r) => r.ok && r.models.length === 2 && r.source === 'live');
await t('PARSE_TASK', { type: 'PARSE_TASK', task: 'msg to mom that hi', chatNames: ['Mom'] }, (r) => r.ok && r.plan.action === 'report_unread'); // stub returns report_unread plan
await t('SUMMARIZE_UNREAD', { type: 'SUMMARIZE_UNREAD', items: [{ name: 'A', preview: 'x', unread: '2' }] }, (r) => r.ok && r.report.includes('Report'));
await t('SUBBOT_PARSE offline', { type: 'SUBBOT_PARSE', text: 'respond to Mom continuously' }, (r) => r.ok && r.draft.kind === 'watch');
await t('SUBBOT_PARSE llm-branch', { type: 'SUBBOT_PARSE', text: 'zzz unparseable qqq' }, (r) => r.ok && r.draft.kind === 'task' && r.source === 'llm');
await t('SUBBOT_CONFIRM task', { type: 'SUBBOT_CONFIRM', draft: { kind: 'task', target: '', task: 'list recent', name: 'T', userText: 'list recent' } }, (r) => r.ok && ['done', 'error'].includes(r.subbot.status));
await t('SUBBOT_LIST', { type: 'SUBBOT_LIST' }, (r) => r.ok && Array.isArray(r.subbots));
await t('SUBBOT_OP bad-op', { type: 'SUBBOT_OP', op: 'pause', id: 'nope' }, (r) => !r.ok);
await t('DEVICE_PROBE down', { type: 'DEVICE_PROBE', url: 'http://127.0.0.1:9', token: 'x' }, (r) => !r.ok);
await t('DEVICE_TASK down', { type: 'DEVICE_TASK', agent: 'opencode', prompt: 'hi' }, (r) => !r.ok);
await t('NEW_SESSION', { type: 'NEW_SESSION', chatId: 'name:tareq', chatName: 'Tareq' }, (r) => r.ok && !!r.session.id);
await t('EXPORT_CHAT', { type: 'EXPORT_CHAT', chatId: 'name:tareq' }, (r) => r.ok && Array.isArray(r.sessions));
await t('UNKNOWN', { type: 'NOPE_XYZ' }, (r) => !r.ok);
await t('AUTO_INSTRUCTION save', { type: 'AUTO_INSTRUCTION', chatId: 'name:tareq', chatName: 'Tareq', overwrite: true }, (r) => r.ok && !!r.instruction);
await t('SUGGEST_REPLIES chips', { type: 'SUGGEST_REPLIES', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [{ dir: 'in', sender: 'Tareq', text: 'hi', msgId: 'm9' }] }, (r) => r.ok && Array.isArray(r.suggestions) && r.suggestions.length === 3);
await t('SUGGEST_REPLIES empty', { type: 'SUGGEST_REPLIES', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [] }, (r) => r.ok && r.suggestions.length === 0);
await t('AUTO_INSTRUCTION keep', { type: 'AUTO_INSTRUCTION', chatId: 'name:tareq', chatName: 'Tareq' }, (r) => r.ok && r.saved === false);
store.wb_global.device.useAsDefault = true;
await t('GEN_REPLY device-default no-token', { type: 'GEN_REPLY', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [{ dir: 'in', sender: 'Tareq', text: 'hi', msgId: 'm10' }] }, (r) => !r.ok && r.code === 'NO_DEVICE');
store.wb_global.device.token = 'x';
await t('GEN_REPLY device-default bridge-down', { type: 'GEN_REPLY', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [{ dir: 'in', sender: 'Tareq', text: 'hi', msgId: 'm11' }] }, (r) => !r.ok);
store.wb_global.device.useAsDefault = false;
store.wb_global.device.token = '';
await t('FORBIDDEN spoofed sender', { type: 'GEN_REPLY', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [] }, (r) => !r.ok && r.code === 'FORBIDDEN', { id: 'evil-ext' });
await t('FORBIDDEN evil tab', { type: 'GEN_REPLY', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [] }, (r) => !r.ok && r.code === 'FORBIDDEN', EVIL_TAB);
await t('GEN_REPLY from WA tab', { type: 'GEN_REPLY', chatId: 'name:tareq', chatName: 'Tareq', history: [], newMessages: [{ dir: 'in', sender: 'Tareq', text: 'tab hi', msgId: 'm12' }] }, (r) => r.ok && r.reply === 'Hey!', WA_TAB);
await t('DEVICE_TASK bench from tab refused', { type: 'DEVICE_TASK', agent: 'opencode', prompt: 'hi' }, (r) => !r.ok && r.code === 'FORBIDDEN', WA_TAB);
// 6 overlapping watch creates with cap 5 → exactly 5 win, 1 rejected Max.
// Without the store lock all 6 would pass the count check together.
{
  const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => send({ type: 'SUBBOT_CONFIRM', draft: { kind: 'watch', target: 'Cap' + i, instruction: 'Be brief.', name: 'W' + i, userText: 'watch cap' + i } })));
  const okN = rs.filter((r) => r.ok).length;
  const maxN = rs.filter((r) => !r.ok && /Max 5/.test(r.error || '')).length;
  results.push([okN === 5 && maxN === 1 ? 'PASS' : 'FAIL', 'SUBBOT_CONFIRM concurrent cap', `ok=${okN} max-rejected=${maxN}`]);
}

let fail = 0;
for (const [s, n, extra] of results) { console.log(s, '-', n, extra); if (s !== 'PASS') fail++; }
console.log(fail ? 'FAILURES PRESENT' : 'ALL SLOTS PASS');
process.exit(fail ? 1 : 0);
