// Versioned central store — the ONLY module allowed to touch chrome.storage
// keys directly (service worker side). Every read flows through getStore()
// (which migrates legacy shapes), every write through setStore().
// Schema history: v1 = legacy unversioned keys; v2 = defaults backfilled +
// wb_schema marker; v3 = chat kind (group disambiguation) + log retention;
// v4 = inline suggestions (global kill-switch + per-chat mode).
// Popup/console/content keep direct reads for now and
// adopt these accessors next (see plan.md Phase A2).
import { DEFAULT_GLOBAL, defaultProvidersState } from './providers.js';

export const SCHEMA_VERSION = 4;
export const SCHEMA_KEY = 'wb_schema';
export const SKEYS = {
  global: 'wb_global',
  providers: 'wb_providers',
  chats: 'wb_chats',
  logs: 'wb_logs',
  subbots: 'wb_subbots',
  theme: 'wb_theme',
  taskhist: 'wb_taskhist',
  quickreplies: 'wb_quickreplies',
};

function fillGlobal(g) {
  const merged = { ...DEFAULT_GLOBAL, ...(g || {}) };
  merged.device = { ...DEFAULT_GLOBAL.device, ...((g || {}).device || {}) };
  return merged;
}

function fillProviders(p) {
  const base = defaultProvidersState();
  const out = { ...base, ...(p || {}) };
  for (const k of Object.keys(base)) out[k] = { ...base[k], ...(out[k] || {}) };
  return out;
}

function fillChat(id, c) {
  const suggestMode = String(c?.suggestMode || c?.suggest || 'global').toLowerCase();
  return {
    name: c?.name || String(id || '').replace(/^name:/, '').replace(/#group$/, ''),
    kind: c?.kind || (String(id || '').endsWith('#group') ? 'group' : 'chat'),
    allowed: !!c?.allowed,
    mode: c?.mode || 'auto',
    suggestMode: ['on', 'off', 'global'].includes(suggestMode) ? suggestMode : 'global',
    routeTo: c?.routeTo || 'cloud',
    cwd: c?.cwd || '',
    instruction: c?.instruction || '',
    contextMd: c?.contextMd || '',
    contextUpdatedAt: c?.contextUpdatedAt || 0,
    contextMsgCount: c?.contextMsgCount || 0,
    sessions: Array.isArray(c?.sessions) ? c.sessions : [],
    activeSessionId: c?.activeSessionId || null,
    managedBy: c?.managedBy || null,
  };
}

// Suggest resolution: per-chat 'on' wins, 'off' kills, 'global' follows the
// master switch. Instruction gate applies on top (no instruction = no chips).
export function suggestEnabledFor(global, chatCfg) {
  const mode = String(chatCfg?.suggestMode || 'global').toLowerCase();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !!global?.suggestionsEnabled;
}

// Migrate raw storage snapshot → current schema. Pure (no chrome.*) so it is
// unit-testable; pass the object from chrome.storage.local.get(null).
// Self-healing: fillChat/fillGlobal run on EVERY load (not only when the
// version marker is old), so a v4-marked snapshot with unfilled entries
// (e.g. legacy `suggest:'on'` string, missing kind) is still repaired.
export function migrateSnapshot(raw) {
  const snap = { ...(raw || {}) };
  const from = snap[SCHEMA_KEY] || 1;
  if (from < 2) {
    snap[SKEYS.global] = fillGlobal(snap[SKEYS.global]);
    snap[SKEYS.providers] = fillProviders(snap[SKEYS.providers]);
    const chats = snap[SKEYS.chats] || {};
    for (const [id, c] of Object.entries(chats)) chats[id] = fillChat(id, c);
    snap[SKEYS.chats] = chats;
    if (!snap[SKEYS.logs] || typeof snap[SKEYS.logs] !== 'object') snap[SKEYS.logs] = {};
    if (!snap[SKEYS.subbots] || typeof snap[SKEYS.subbots] !== 'object') snap[SKEYS.subbots] = {};
    snap[SCHEMA_KEY] = 2;
  }
  if ((snap[SCHEMA_KEY] || 2) < 3) {
    // v3: backfill kind + logRetentionDays; keep legacy base ids untouched
    // (group-suffixed ids are created going forward; old base ids stay valid
    // via resolveChatId fallback so no history is lost on upgrade).
    snap[SKEYS.global] = { logRetentionDays: 30, ...fillGlobal(snap[SKEYS.global]) };
    if (snap[SKEYS.global].logRetentionDays == null) snap[SKEYS.global].logRetentionDays = 30;
    const chats = snap[SKEYS.chats] || {};
    for (const [id, c] of Object.entries(chats)) chats[id] = fillChat(id, c);
    snap[SKEYS.chats] = chats;
    snap[SCHEMA_KEY] = 3;
  }
  if ((snap[SCHEMA_KEY] || 3) < 4) {
    // v4: inline suggestions — global switch (default off) + per-chat mode.
    snap[SKEYS.global] = { suggestionsEnabled: false, suggestCount: 3, ...fillGlobal(snap[SKEYS.global]) };
    if (snap[SKEYS.global].suggestionsEnabled == null) snap[SKEYS.global].suggestionsEnabled = false;
    if (!Number.isFinite(snap[SKEYS.global].suggestCount)) snap[SKEYS.global].suggestCount = 3;
    const chats = snap[SKEYS.chats] || {};
    for (const [id, c] of Object.entries(chats)) chats[id] = fillChat(id, c);
    snap[SKEYS.chats] = chats;
    snap[SCHEMA_KEY] = SCHEMA_VERSION;
  }
  // Self-heal pass: a snapshot already stamped v4 can still hold unfilled
  // entries (e.g. written before a field existed). fill* are idempotent.
  snap[SKEYS.global] = fillGlobal(snap[SKEYS.global]);
  snap[SKEYS.providers] = fillProviders(snap[SKEYS.providers]);
  {
    const chats = snap[SKEYS.chats] || {};
    for (const [id, c] of Object.entries(chats)) {
      const filled = fillChat(id, c);
      // Preserve unknown future fields (never amputate stored data).
      chats[id] = { ...c, ...filled };
    }
    snap[SKEYS.chats] = chats;
  }
  if (!snap[SKEYS.logs] || typeof snap[SKEYS.logs] !== 'object') snap[SKEYS.logs] = {};
  if (!snap[SKEYS.subbots] || typeof snap[SKEYS.subbots] !== 'object') snap[SKEYS.subbots] = {};
  if (!Array.isArray(snap[SKEYS.quickreplies])) snap[SKEYS.quickreplies] = [];
  return { snapshot: snap, migrated: from !== SCHEMA_VERSION, from };
}

function shape(snapshot) {
  return {
    global: snapshot[SKEYS.global],
    providers: snapshot[SKEYS.providers],
    chats: snapshot[SKEYS.chats],
    logs: snapshot[SKEYS.logs],
    subbots: snapshot[SKEYS.subbots],
    quickreplies: snapshot[SKEYS.quickreplies] || [],
  };
}

export async function getStore() {
  const raw = await chrome.storage.local.get(null);
  const { snapshot, migrated } = migrateSnapshot(raw);
  if (migrated) {
    // Persist backfilled defaults once; failures are non-fatal.
    try { await chrome.storage.local.set(snapshot); } catch {}
  }
  return shape(snapshot);
}

// Lightweight read for hot paths (every reply turn): everything EXCEPT logs,
// which can be megabytes. Callers needing logs fetch wb_logs separately.
export async function getMeta() {
  const raw = await chrome.storage.local.get([SKEYS.global, SKEYS.providers, SKEYS.chats, SKEYS.subbots, SCHEMA_KEY]);
  const { snapshot } = migrateSnapshot(raw);
  const s = shape(snapshot);
  return { global: s.global, providers: s.providers, chats: s.chats, subbots: s.subbots };
}

export async function setStore(patch) {
  const m = {};
  if (patch.global) m[SKEYS.global] = patch.global;
  if (patch.providers) m[SKEYS.providers] = patch.providers;
  if (patch.chats) m[SKEYS.chats] = patch.chats;
  if (patch.logs) m[SKEYS.logs] = patch.logs;
  if (patch.subbots) m[SKEYS.subbots] = patch.subbots;
  if (patch.quickreplies) m[SKEYS.quickreplies] = patch.quickreplies;
  await chrome.storage.local.set(m);
}

// Best-effort per-scope mutex on chrome.storage.session (self-heals via TTL
// when the worker dies mid-hold). Serializes read-modify-write sections that
// would otherwise last-writer-win under concurrent chats/bots — e.g. two
// watch creates both passing the cap check, or a build batch landing
// mid-turn. Scope is a chat id or a area name ('subbots'), never the whole
// store, so unrelated chats don't serialize. Without a session API
// (unit tests) it runs unlocked.
const STORE_LOCK_TTL_MS = 5000;
export async function withStoreLock(scope, fn) {
  const key = `wb_mu_${String(scope || 'global')}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const noSession = !globalThis.chrome?.storage?.session;
  if (noSession) return fn();
  const deadline = Date.now() + STORE_LOCK_TTL_MS;
  for (;;) {
    let cur = null;
    try { cur = (await chrome.storage.session.get([key]))[key]; } catch { return fn(); }
    if (!cur || Date.now() - (cur.ts || 0) > STORE_LOCK_TTL_MS) {
      try { await chrome.storage.session.set({ [key]: { ts: Date.now(), token } }); } catch { return fn(); }
      let re = null;
      try { re = (await chrome.storage.session.get([key]))[key]; } catch {}
      if (re?.token === token) {
        try { return await fn(); }
        finally {
          try {
            const now = (await chrome.storage.session.get([key]))[key];
            if (now?.token === token) await chrome.storage.session.remove([key]);
          } catch {}
        }
      }
    }
    if (Date.now() >= deadline) throw new Error(`store busy (${scope}) — retry`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
