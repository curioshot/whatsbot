import { PROVIDERS, defaultProvidersState, FALLBACK_MODELS, buildReplyMessages, extractReplyText, toAnthropicBody, buildContextPrompt, buildInstructionPrompt, cleanInstructionText, buildSuggestMessages, extractSuggestions } from '../common/providers.js';
import { deviceAgents, deviceHealth, deviceRunAndWait, reconcilePendingDeviceTasks, unjournalDevicePending } from '../common/device.js';
import { limitForModel, estimateUsage, newSession, sessionState, decideRollover, closeSession, pruneSessions, formatCtx } from '../common/sessions.js';
import { subbotId, chatIdForName, resolveChatId, baseChatId, normalizeName, canonicalNameFor, autoName, bindWatchRule, restoreRule, newSubbot, parseSubbotOffline } from '../common/subbots.js';
import { getStore, getMeta, setStore, suggestEnabledFor, SKEYS, withStoreLock } from '../common/store.js';
import { on, dispatch, WbError } from '../common/bus.js';

// Suggestion rate guard (in-memory; content cache is the primary dedupe).
// Max 10 calls/min per chat — chips are previews, not replies.
const suggestHits = new Map(); // chatId -> [timestamps]
function suggestRateOk(chatId) {
  const now = Date.now();
  const arr = (suggestHits.get(chatId) || []).filter((t) => now - t < 60000);
  if (arr.length >= 10) return false;
  arr.push(now);
  suggestHits.set(chatId, arr);
  return true;
}

const MAX_WATCH_BOTS = 5;
const MAX_SUBBOT_HISTORY = 20;
async function saveSubbots(subbots) {
  const ids = Object.keys(subbots);
  if (ids.length > MAX_WATCH_BOTS + MAX_SUBBOT_HISTORY) {
    // drop oldest finished bots first, never running/paused ones. If only
    // running/paused bots remain over cap, reject is handled at creation —
    // here enforce a hard ceiling on history so storage cannot grow forever.
    const finished = ids.filter((id) => subbots[id].status !== 'running' && subbots[id].status !== 'paused')
      .sort((a, b) => (subbots[a].createdAt || 0) - (subbots[b].createdAt || 0));
    while (Object.keys(subbots).length > MAX_WATCH_BOTS + MAX_SUBBOT_HISTORY && finished.length) {
      delete subbots[finished.shift()];
    }
    // Absolute backstop: even all-running overflow gets trimmed oldest-first
    // rather than growing without bound. Live bots are unlinked first so
    // the chat doesn't stay managed by a deleted watcher forever.
    const stillOver = Object.keys(subbots).length - (MAX_WATCH_BOTS + MAX_SUBBOT_HISTORY);
    if (stillOver > 0) {
      const oldest = ids.sort((a, b) => (subbots[a].createdAt || 0) - (subbots[b].createdAt || 0)).slice(0, stillOver);
      const { chats } = await getStore();
      let touched = false;
      for (const id of oldest) {
        const b = subbots[id];
        if (b && (b.status === 'running' || b.status === 'paused') && b.targetChatId && chats[b.targetChatId]?.managedBy === id) {
          try { chats[b.targetChatId] = restoreRule(chats[b.targetChatId], b.prev); touched = true; } catch {}
        }
        delete subbots[id];
      }
      if (touched) await setStore({ chats });
    }
  }
  await setStore({ subbots });
}
function runningWatchFor(store, chatId) {
  return Object.values(store.subbots || {}).find((b) => b.kind === 'watch' && b.status === 'running' && b.targetChatId === chatId) || null;
}

// ---------- LLM call ----------
// Every network call carries an AbortController timeout: a hung provider must
// fail fast, never wedge the reply turn (or the service worker) forever.
// jsonMode: ask the API itself to enforce JSON output (OpenAI-compatible
// response_format). Used for replies so reasoning can never leak; NOT used for
// context summaries (markdown) or connection tests.
async function fetchT(url, opts = {}, ms = 90000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`request timed out after ${Math.round(ms / 1000)}s: ${url}`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function callLLM(oaMessages, { maxTokens = 1024, temperature = 0.7, jsonMode = false } = {}) {
  const { global, providers } = await getMeta();
  // Helper jobs (summaries, chips, parses) run on a cloud model even when
  // the reply default is a device agent — agents can't do those.
  const pid = global.activeProvider === 'device' ? (global.prevCloudProvider || 'openai') : global.activeProvider;
  const def = PROVIDERS[pid];
  const cfg = providers[pid];
  if (!def) throw new Error(`Unknown provider ${pid}`);
  if (def.needsKey && !cfg.apiKey) throw new Error(`Missing API key for ${def.label}. Set it in popup.`);

  if (pid === 'anthropic') {
    // Anthropic has no response_format JSON mode: carry the contract in the
    // prompt instead, or every JSON reply costs a second call (and long
    // plain answers trip the strict filter and fail outright).
    let msgs = oaMessages;
    if (jsonMode) {
      msgs = oaMessages.map((m) => ({ ...m }));
      const last = msgs[msgs.length - 1];
      if (last) last.content = `${last.content}\n\nRespond with ONLY a JSON object like {"reply": "..."} — no other text.`;
    }
    const body = toAnthropicBody({ model: cfg.model, oaMessages: msgs, maxTokens });
    const res = await fetchT(`${cfg.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ ...body, temperature }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const j = await res.json();
    return (j.content || []).map((b) => b.text || '').join('').trim();
  }

  // OpenAI-compatible path: OpenAI, OpenRouter, Groq, NVIDIA NIM, Local
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (pid === 'openrouter') {
    headers['HTTP-Referer'] = 'https://web.whatsapp.com';
    headers['X-Title'] = 'WhatsBot';
  }
  const chatBody = (withJson) => ({
    model: cfg.model,
    messages: oaMessages,
    temperature,
    max_tokens: maxTokens,
    ...(withJson ? { response_format: { type: 'json_object' } } : {}),
  });
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  let res = await fetchT(url, { method: 'POST', headers, body: JSON.stringify(chatBody(jsonMode)) });
  if (jsonMode && !res.ok) {
    // provider/model doesn't support response_format → retry plain, filter still guards output
    const t = await res.text();
    if (/response_format|json_object|invalid_request/i.test(t.slice(0, 300))) {
      res = await fetchT(url, { method: 'POST', headers, body: JSON.stringify(chatBody(false)) });
    } else {
      throw new Error(`${def.label} ${res.status}: ${t.slice(0, 500)}`);
    }
  }
  if (!res.ok) throw new Error(`${def.label} ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${def.label}: empty reply`);
  return text;
}

// ---------- model listing ----------
// GET <base>/models for each provider type. Returns {models:[ids], source:'live'|'fallback', count}
async function listModels(pid) {
  // Device entry lists installed bridge agents instead of cloud models.
  if (pid === 'device') {
    const { global } = await getMeta();
    const url = global.device?.url || 'http://127.0.0.1:18789';
    const token = global.device?.token || '';
    if (!token) throw new Error('Connect the bridge first (popup → Device).');
    const agents = await deviceAgents(url, token);
    const ids = agents.filter((a) => a.installed).map((a) => a.id);
    if (!ids.length) throw new Error('Bridge connected, but no agents installed.');
    return { models: ids, source: 'live (bridge)', count: ids.length };
  }
  const { providers } = await getMeta();
  const def = PROVIDERS[pid];
  const cfg = providers[pid] || {};
  if (!def) throw new Error(`Unknown provider ${pid}`);
  const base = (cfg.baseUrl || def.baseUrl).replace(/\/$/, '');
  const norm = (arr) => [...new Set(arr.filter(Boolean))].sort();

  // Anthropic native endpoint
  if (pid === 'anthropic') {
    if (!cfg.apiKey) throw new Error('Add Anthropic API key first.');
    try {
      const res = await fetchT(`${base}/models?limit=100`, {
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      }, 30000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const ids = (j.data || []).map((m) => m.id).filter(Boolean);
      if (!ids.length) throw new Error('empty list');
      await cacheModels(pid, ids);
      return { models: norm(ids), source: 'live', count: ids.length };
    } catch (e) {
      return { models: FALLBACK_MODELS.anthropic, source: `fallback (${e.message})`, count: FALLBACK_MODELS.anthropic.length };
    }
  }

  // OpenAI-compatible: GET {base}/models
  const headers = {};
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (pid === 'openrouter') {
    headers['HTTP-Referer'] = 'https://web.whatsapp.com';
    headers['X-Title'] = 'WhatsBot';
  }
  try {
    const res = await fetchT(`${base}/models`, { headers }, 30000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    // shapes: {data:[{id}]}, {models:[...]}, [...] — handle all
    let ids = [];
    if (Array.isArray(j?.data)) ids = j.data.map((m) => m.id || m.name);
    else if (Array.isArray(j?.models)) ids = j.models.map((m) => m.id || m.name || m);
    else if (Array.isArray(j)) ids = j.map((m) => m.id || m.name || m);
    ids = ids.filter(Boolean);
    if (!ids.length) throw new Error('empty list');
    await cacheModels(pid, ids);
    return { models: norm(ids), source: 'live', count: ids.length };
  } catch (e) {
    // Local fallback: try Ollama native /api/tags on same origin
    if (pid === 'local') {
      try {
        const origin = new URL(base).origin;
        const r2 = await fetchT(`${origin}/api/tags`, {}, 15000);
        if (r2.ok) {
          const j2 = await r2.json();
          const ids = (j2.models || []).map((m) => m.name).filter(Boolean);
          if (ids.length) {
            await cacheModels(pid, ids);
            return { models: norm(ids), source: 'live (ollama tags)', count: ids.length };
          }
        }
      } catch {}
    }
    return { models: FALLBACK_MODELS[pid] || [], source: `fallback (${e.message})`, count: (FALLBACK_MODELS[pid] || []).length };
  }
}

async function cacheModels(pid, ids) {
  const r = await chrome.storage.local.get([SKEYS.providers]);
  const providers = { ...defaultProvidersState(), ...(r[SKEYS.providers] || {}) };
  providers[pid] = { ...providers[pid], modelsCache: ids.slice(0, 500), modelsFetchedAt: Date.now() };
  await chrome.storage.local.set({ [SKEYS.providers]: providers });
}

// ---------- device bridge ----------
function devicePrompt({ chatName, chatCfg, history, newMessages }) {
  const fresh = (newMessages || []).map((m) => `THEM (they sent this${m.sender ? `, display name "${m.sender}"` : ''}): ${m.text}`).join('\n');
  const hist = (history || []).slice(-12).map((m) => (m.dir === 'out' ? `YOU (you sent this): ${m.text}` : `THEM (they sent this): ${m.text}`)).join('\n');
  return [
    `WhatsApp chat "${chatName}" on YOUR account. Tags decide who spoke: YOU = sent by you (never answer these), THEM = sent by them (answer only these). Do the work and reply with the result text only (short, WhatsApp-style, no preamble).`,
    chatCfg?.instruction ? `Chat rules: ${chatCfg.instruction}` : '',
    chatCfg?.contextMd ? `Known context (truncated):\n${String(chatCfg.contextMd).slice(0, 3000)}` : '',
    hist ? `Recent:\n${hist}` : '',
    `New:\n${fresh}`,
  ].filter(Boolean).join('\n\n');
}

function pickDeviceAgent(chatCfg, newMessages, global) {
  const prefix = global.routePrefix || '/code';
  const text = (newMessages || []).map((m) => m.text || '').join('\n');
  const explicit = text.trim().toLowerCase().startsWith(prefix.toLowerCase());
  const routeTo = chatCfg?.routeTo || 'cloud';
  if (routeTo.startsWith('device:')) return { agent: routeTo.slice(7), via: explicit ? 'rule+prefix' : 'rule' };
  if (explicit && global.device?.token) {
    // explicit /code override on a cloud chat → use first installed agent (saved list) or opencode default
    const found = (global.device.agents || []).find((a) => a.installed)?.id;
    return { agent: found || 'opencode', via: 'prefix', stripPrefix: prefix };
  }
  return null;
}

async function runDeviceTask({ agent, prompt, cwd, timeoutMs = 180000, chatId, chatName }) {
  const { global } = await getStore();
  const url = global.device?.url || 'http://127.0.0.1:18789';
  const token = global.device?.token || '';
  if (!token) throw new WbError('NO_DEVICE', 'Device token missing — paste ~/.whatsbot/token into popup → Connect Device.');
  const task = await deviceRunAndWait(url, token, { agent, prompt, cwd, timeoutMs, chatId, chatName }, null);
  if (task.state !== 'done') throw new Error(`${agent}: ${task.error || 'failed'}`);
  // Never send a canned fallback to a chat: empty output is a failure, not a reply.
  // Device mode: CLI tool results are plain text by nature — cleaned, never raw.
  const text = extractReplyText(task.reply || task.outputTail || '', { mode: 'device' });
  if (!text) throw new Error(`${agent} returned empty output — nothing sent.`);
  return text;
}

// ---------- logs ----------
// Single writer: every stored entry carries sessionId (active session, or
// null for log-only chats with no session yet) so history stays auditable.
function applyRetention(arr, maxPerChat, retentionDays) {
  let out = arr;
  if (Number.isFinite(retentionDays) && retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    out = out.filter((l) => (l.ts || 0) >= cutoff);
  }
  return out.slice(-maxPerChat);
}
async function appendLogs(chatId, entries, sessionId = null) {
  const { global, logs } = await getStore();
  const arr = logs[chatId] || [];
  // Dedupe by msgId (mirror SAVE_CONTEXT_BATCH): BUSY-retry and
  // NO_INSTRUCTION-then-success paths log the same incoming twice otherwise.
  const seen = new Set(arr.map((x) => x.msgId).filter(Boolean));
  for (const e of entries.map((x) => ({ ...x, sessionId: sessionId ?? x.sessionId ?? null }))) {
    if (e.msgId && seen.has(e.msgId)) continue;
    if (e.msgId) seen.add(e.msgId);
    arr.push(e);
  }
  logs[chatId] = applyRetention(arr, global.maxLogPerChat, global.logRetentionDays ?? 30);
  await setStore({ logs });
  // Hot path must respect the whole-chat trim too (it used to run on bulk
  // builds only, so steady messaging grew past 60 chats). Throttled: only
  // when actually over the cap.
  if (Object.keys(logs).length > MAX_LOGGED_CHATS) await enforceQuota({ global, logs });
  return logs[chatId].length;
}

// ---------- sessions (skill rule 7: SW keeps NO in-memory state — every turn
// is read-modify-write on chrome.storage.local) ----------
function activeModelId(store) {
  const pid = store.global.activeProvider;
  return store.providers?.[pid]?.model || '';
}

function ctxLimit(store) {
  const { limit, known } = limitForModel(activeModelId(store), store.global.ctxLimitOverride || 0);
  return { limit, known };
}

// Open (or reuse) the active session for a chat. Persists immediately.
async function openSession(store, chatId, closedReason, chatName) {
  const cfg = store.chats[chatId] || { name: chatName || chatId };
  const sessions = cfg.sessions || [];
  const n = sessions.reduce((m, s) => Math.max(m, s.n || 0), 0) + 1;
  const sess = newSession(chatId, n);
  if (closedReason) sess.openReason = closedReason;
  cfg.sessions = pruneSessions([...sessions, sess]);
  cfg.activeSessionId = sess.id;
  cfg.name = cfg.name || chatId;
  store.chats[chatId] = cfg;
  await setStore({ chats: store.chats });
  return sess;
}

function getActiveSession(store, chatId) {
  const cfg = store.chats[chatId] || {};
  return (cfg.sessions || []).find((s) => s.id === cfg.activeSessionId && s.status === 'active') || null;
}

async function persistSession(store, chatId, sess) {
  const cfg = store.chats[chatId] || {};
  cfg.sessions = pruneSessions((cfg.sessions || []).map((s) => (s.id === sess.id ? sess : s)));
  store.chats[chatId] = cfg;
  await setStore({ chats: store.chats });
}

// Summarize a closing session into a short carry-over (best-effort; never
// blocks the reply if it fails). Fetches logs itself so hot paths can run
// on the lightweight getMeta() store.
async function summarizeSession(store, chatId, sess) {
  try {
    const got = await chrome.storage.local.get([SKEYS.logs]);
    const logs = got?.[SKEYS.logs] || {};
    const lines = ((logs || {})[chatId] || [])
      .filter((l) => l.sessionId === sess.id)
      .slice(-40)
      .map((l) => `[${l.dir === 'out' ? 'YOU' : l.sender || 'THEM'}] ${l.text}`)
      .join('\n')
      .slice(0, 8000);
    if (!lines) return '';
    const out = await callLLM(
      [{ role: 'user', content: `Summarize this WhatsApp session in ≤6 short bullets: key facts, commitments, open loops. No preamble:\n${lines}` }],
      { maxTokens: 300 },
    );
    return String(out || '').trim().slice(0, 1500);
  } catch {
    return '';
  }
}

function isContextError(e) {
  const t = String((e && e.message) || e || '');
  return /context_length|maximum context|too many tokens|input[^.]{0,40}too (long|large)|HTTP\s*41[13]/i.test(t);
}

// Global storage-quota guard: per-chat caps alone can't stop 100 heavy chats
// from filling the 10MB local quota (writes then throw = silent log loss).
// Oldest whole chats are dropped first; runs on bulk paths only, not per message.
// Retention (days) is applied first so old entries age out before whole chats.
const MAX_LOGGED_CHATS = 60;
async function enforceQuota(store) {
  try {
    const retention = store.global?.logRetentionDays ?? 30;
    if (Number.isFinite(retention) && retention > 0) {
      const cutoff = Date.now() - retention * 24 * 3600 * 1000;
      for (const id of Object.keys(store.logs)) {
        store.logs[id] = (store.logs[id] || []).filter((l) => (l.ts || 0) >= cutoff);
        if (!store.logs[id].length) delete store.logs[id];
      }
    }
    const ids = Object.keys(store.logs);
    if (ids.length <= MAX_LOGGED_CHATS) { await setStore({ logs: store.logs }); return; }
    const age = (id) => (store.logs[id] || []).reduce((m, l) => Math.max(m, l.ts || 0), 0);
    ids.sort((a, b) => age(a) - age(b));
    for (const id of ids.slice(0, ids.length - MAX_LOGGED_CHATS)) delete store.logs[id];
    await setStore({ logs: store.logs });
  } catch {}
}

// Per-chat turn lock (TTL in chrome.storage.session: survives SW restarts,
// self-heals if a turn dies mid-flight). Prevents two concurrent replies in
// the same chat from forking sessions/logs.
const LOCK_TTL_MS = 90000;
async function acquireTurnLock(chatId) {
  const key = `wb_lock_${chatId}`;
  const cur = await chrome.storage.session.get([key]);
  const lock = cur[key];
  if (lock && Date.now() - lock.ts < LOCK_TTL_MS) return null;
  let rand = '';
  try {
    rand = globalThis.crypto?.randomUUID?.()?.slice(0, 8)
      || [...globalThis.crypto?.getRandomValues?.(new Uint8Array(6)) || []].map((b) => (b % 36).toString(36)).join('');
  } catch {}
  const token = `${Date.now()}-${rand || Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.session.set({ [key]: { ts: Date.now(), token } });
  const re = await chrome.storage.session.get([key]);
  if (re[key]?.token !== token) return null; // lost the race
  return token;
}
async function releaseTurnLock(chatId, token) {
  try {
    const key = `wb_lock_${chatId}`;
    const cur = await chrome.storage.session.get([key]);
    if (cur[key]?.token === token) await chrome.storage.session.remove([key]);
  } catch {}
}

// Core turn executor shared by cloud + device paths. Handles: session
// select/open, token accounting, context-full rollover (with summary carry),
// error rollover + exactly one retry (cloud only — device runs tools, so a
// blind retry would execute side effects twice). Returns { reply, via, session }.
async function executeReplyTurn(store, chatId, chatName, { kind, build, run }) {
  const isDevice = String(kind || '').startsWith('device:');
  const maxAttempts = isDevice ? 1 : 2;
  const { limit, known } = ctxLimit(store);
  const newCount = 1;
  let rolled = false;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let sess = getActiveSession(store, chatId);
    if (!sess) sess = await openSession(store, chatId, attempt ? 'previous session errored' : 'first session', chatName);

    const payload = build(sess.summary || '');
    const promptChars = typeof payload === 'string' ? payload.length : JSON.stringify(payload).length;
    const usage = estimateUsage({ systemChars: 0, historyChars: promptChars, contextChars: 0, reserveTokens: 600 });
    sess.estTokens = usage;
    // Decide rollover BEFORE stamping activity: stamping first makes the
    // 24h-idle check unreachable (it would always see "just now").
    const decision = decideRollover(sess, limit, false);
    sess.lastActiveAt = Date.now();
    if ((decision.action === 'roll-full' || decision.action === 'roll-idle') && !rolled) {
      rolled = true;
      const summary = await summarizeSession(store, chatId, sess);
      await persistSession(store, chatId, closeSession(sess, decision.action === 'roll-full' ? 'full' : 'closed'));
      sess = await openSession(store, chatId, decision.reason, chatName);
      const payload2 = build(summary);
      const usage2 = estimateUsage({ systemChars: 0, historyChars: typeof payload2 === 'string' ? payload2.length : JSON.stringify(payload2).length, contextChars: 0, reserveTokens: 600 });
      sess.estTokens = usage2;
      sess.lastActiveAt = Date.now();
      sess.msgCount += newCount;
      await persistSession(store, chatId, sess);
      try {
        const reply = await run(payload2);
        sess.summary = summary;
        await persistSession(store, chatId, sess);
        return finishTurn(store, chatId, sess, limit, known, reply, kind);
      } catch (e) {
        lastError = e;
        await persistSession(store, chatId, closeSession({ ...sess, lastError: String(e.message || e) }, 'error'));
        continue;
      }
    }

    sess.msgCount += newCount;
    await persistSession(store, chatId, sess);
    try {
      const reply = await run(payload);
      return finishTurn(store, chatId, sess, limit, known, reply, kind);
    } catch (e) {
      lastError = e;
      await persistSession(store, chatId, closeSession({ ...sess, lastError: String(e.message || e) }, 'error'));
      if (!isDevice && isContextError(e)) continue; // fresh session retry may fit (cloud only)
      if (!isDevice && attempt === 0 && !rolled) continue; // one auto-retry on fresh session for transient errors
      break;
    }
  }
  throw lastError || new Error('reply failed');
}

async function finishTurn(store, chatId, sess, limit, known, reply, kind) {
  const info = {
    id: sess.id, n: sess.n,
    ctx: formatCtx(sess.estTokens || 0, limit, known),
    state: sessionState(sess, limit),
    via: kind,
  };
  return { reply, info };
}



// ---------- toolbar badge: bot state at a glance ----------
// "action" exists in manifest (skill rule 11). Badge is the only visible
// production signal when popup/console are closed.
async function paintBadge() {
  try {
    const { global, subbots } = await getMeta();
    const on = !!global.enabled;
    const watching = Object.values(subbots || {}).filter((b) => b.kind === 'watch' && b.status === 'running');
    await chrome.action.setBadgeText({ text: on ? (watching.length ? String(Math.min(watching.length, 9)) : 'ON') : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ color: '#0a0a0a' });
    const watchBit = watching.length ? ` · ${watching.length} watching (${watching.slice(0, 3).map((b) => b.target).join(', ')})` : '';
    await chrome.action.setTitle({ title: on ? `WhatsBot — bot enabled${watchBit}` : 'WhatsBot — bot off' });
  } catch {}
}
chrome.runtime.onInstalled.addListener(() => { paintBadge(); ensureDeviceAlarm(); });
chrome.runtime.onStartup.addListener(() => { paintBadge(); ensureDeviceAlarm(); reconcileOrphans(); });
chrome.storage.onChanged.addListener((chg) => { if (chg.wb_global || chg.wb_subbots) paintBadge(); });

// Durable-jobs tick: every minute, reconcile journaled bridge tasks that
// outlived a service-worker restart. Settled orphans are appended to logs
// (chatId was journaled by the caller where known) so results are never
// silently lost even though the original GEN_REPLY already timed out.
async function ensureDeviceAlarm() {
  try {
    if (chrome.alarms?.create) await chrome.alarms.create('wb-device-tick', { periodInMinutes: 1 });
  } catch {}
}
async function reconcileOrphans() {
  try {
    const { global } = await getMeta();
    const url = global.device?.url || 'http://127.0.0.1:18789';
    const token = global.device?.token || '';
    if (!token) return;
    const settled = await reconcilePendingDeviceTasks({ [url]: token });
    for (const { entry, task } of settled) {
      try {
        if (!entry?.chatId) continue; // generic journal without chat context: just unjournaled
        const text = extractReplyText(task.reply || task.outputTail || '', { mode: 'device' });
        if (!text) continue;
        const s = await getStore();
        await appendLogs(entry.chatId, [
          { ts: Date.now(), dir: 'out', sender: `device:${task.agent || entry.agent || 'agent'} (late)`, text },
        ], getActiveSession(s, entry.chatId)?.id);
      } catch {}
    }
  } catch {}
}
try {
  chrome.alarms?.onAlarm?.addListener((a) => {
    if (a?.name === 'wb-device-tick') reconcileOrphans();
  });
} catch {}
ensureDeviceAlarm();

// ---------- subbots ----------
function publicBot(b) {
  return { ...b };
}

async function readWhatsAppChats() {
  // Best-effort: ask the open WhatsApp tab for its chat list (names only).
  try {
    const tabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
    if (!tabs?.length) return [];
    const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'LIST_CHATS' });
    return r?.ok ? r.chats || [] : [];
  } catch {
    return [];
  }
}

// Chat-rule lookup with legacy fallback: pre-v3 installs stored only the
// base id (no #group suffix). A group tab sending name:x#group still finds
// its legacy rule instead of hitting a false NO_INSTRUCTION.
function getChatCfg(store, chatId) {
  if (store.chats[chatId]) return { cfg: store.chats[chatId], id: chatId };
  const base = baseChatId(chatId);
  if (base !== chatId && store.chats[base]) return { cfg: store.chats[base], id: base };
  return { cfg: {}, id: chatId };
}

// One-shot task execution. Supports two shapes (see SUBBOT_CONFIRM branch):
// activity-listing ("who chatted me last month") from stored log timestamps
// + live chat list, and generic tasks (summaries/lookups) via the LLM over
// the same activity snapshot. Runs inside SUBBOT_CONFIRM, then parks the bot
// as done/error with the result.
async function runSubbotTask(store, bot) {
  const started = Date.now();
  try {
    const waChats = await readWhatsAppChats();
    const names = new Map(); // lower -> {name, kind}
    for (const c of waChats) if (c?.name) names.set(String(c.name).toLowerCase(), { name: String(c.name), kind: c.kind || 'chat' });
    for (const [id, c] of Object.entries(store.chats)) {
      const k = String(c?.name || '').toLowerCase();
      if (c?.name && !names.has(k)) names.set(k, { name: c.name, kind: c.kind || (String(id).endsWith('#group') ? 'group' : 'chat') });
    }
    for (const [id, arr] of Object.entries(store.logs)) {
      const nm = store.chats[id]?.name || id.replace(/^name:/, '').replace(/#group$/, '');
      if (!names.has(String(nm).toLowerCase())) names.set(String(nm).toLowerCase(), { name: String(nm), kind: String(id).endsWith('#group') ? 'group' : 'chat' });
    }
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    const rows = [];
    for (const [, { name, kind }] of names) {
      const id = resolveChatId(store.chats, name, kind);
      const arr = store.logs[id] || store.logs[chatIdForName(name)] || [];
      const lastTs = arr.reduce((m, l) => Math.max(m, l.ts || 0), 0);
      const waHit = waChats.find((c) => String(c.name).toLowerCase() === name.toLowerCase());
      rows.push({ name, kind, lastActive: lastTs || null, recent: lastTs >= cutoff, unread: waHit?.unread || '' });
    }
    rows.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    const recent = rows.filter((r) => r.recent);
    const lines = rows.slice(0, 60).map((r) =>
      `• ${r.name}${r.kind === 'group' ? ' (group)' : ''}${r.lastActive ? ` — last activity ${new Date(r.lastActive).toLocaleDateString()}` : ' — no logged history'}${r.unread ? ` (${r.unread} unread)` : ''}${r.recent ? ' [ACTIVE THIS MONTH]' : ''}`).join('\n');
    const isActivity = /chatted|messaged|talked|wrote|recent|active|monthly|unread/i.test(bot.task || '');
    const prompt = isActivity
      ? `The owner asked: "${bot.task}".\nChat activity (timestamps reliable only where logged history exists):\n${lines || '(no chats found)'}\n\nAnswer directly: list the people who chatted in the last month first, then the rest briefly. Plain text, short, no preamble.`
      : `The owner asked: "${bot.task}".\nChat activity snapshot (names + last activity; timestamps reliable only where logged history exists):\n${lines || '(no chats found)'}\n\nAnswer the request directly using this snapshot. If it cannot be answered from chat activity, say so in one line and give the closest useful summary. Plain text, short, no preamble.`;
    const report = await callLLM([
      { role: 'user', content: prompt },
    ], { maxTokens: 800 });
    bot.status = 'done';
    bot.runCount = 1;
    bot.lastRunAt = Date.now();
    bot.lastResult = String(report || '').trim().slice(0, 2000) || `Active this month (${recent.length}): ${recent.map((r) => r.name).join(', ') || 'none found'}.`;
    bot.lastError = '';
  } catch (e) {
    bot.status = 'error';
    bot.lastError = String(e.message || e).slice(0, 300);
  }
  bot.lastRunAt = bot.lastRunAt || started;
  const all = await getStore();
  all.subbots[bot.id] = bot;
  await saveSubbots(all.subbots);
  return bot;
}

// ---------- message router (bus registrations; thin wrapper at the bottom) ----------
on('GEN_REPLY', async (msg) => {
        // msg: {chatId, chatName, history, newMessages}
        // Hot path: metadata only (logs fetched lazily where needed).
        const store = await getMeta();
        const { cfg, id: resolvedId } = getChatCfg(store, msg.chatId);
        // Canonicalize group/legacy ids so sessions/logs bind to one id.
        msg.chatId = resolvedId;
        const global = store.global;
        // Hard gate: no per-chat instruction → no AI reply, ever. Log the
        // incoming so nothing is lost, but refuse to answer.
        if (!cfg.instruction?.trim()) {
          await appendLogs(msg.chatId, (msg.newMessages || []).map((m) => ({ ts: Date.now(), dir: 'in', sender: m.sender, text: m.text, msgId: m.msgId })), getActiveSession(store, msg.chatId)?.id);
          throw new WbError('NO_INSTRUCTION', `No instruction for "${msg.chatName}". Add one in Console → Rules before AI replies.`);
        }
        // Allowlist gate: paused/stopped chats and a disabled master switch
        // refuse here too. Content enforces this for its own auto-fire, but
        // a direct GEN_REPLY must never bypass pause/off. Running watchers
        // carry their own permission (they answer even with master off).
        const gateWatcher = runningWatchFor(store, msg.chatId);
        if (cfg.allowed === false && !gateWatcher) {
          await appendLogs(msg.chatId, (msg.newMessages || []).map((m) => ({ ts: Date.now(), dir: 'in', sender: m.sender, text: m.text, msgId: m.msgId })), getActiveSession(store, msg.chatId)?.id);
          throw new WbError('DISABLED', `AI replies are off for "${msg.chatName}". Allow the chat in Console → Rules first.`);
        }
        if (global.enabled === false && !gateWatcher) {
          await appendLogs(msg.chatId, (msg.newMessages || []).map((m) => ({ ts: Date.now(), dir: 'in', sender: m.sender, text: m.text, msgId: m.msgId })), getActiveSession(store, msg.chatId)?.id);
          throw new WbError('DISABLED', 'The bot is disabled in the popup. Turn it on first.');
        }
        const lockToken = await acquireTurnLock(msg.chatId);
        if (!lockToken) {
          await appendLogs(msg.chatId, (msg.newMessages || []).map((m) => ({ ts: Date.now(), dir: 'in', sender: m.sender, text: m.text, msgId: m.msgId })), getActiveSession(store, msg.chatId)?.id);
          throw new WbError('BUSY', 'Another reply turn is already running for this chat.');
        }
        try {
        let routed = pickDeviceAgent(cfg, msg.newMessages, global);
        // Popup device default: chats without an explicit device brain answer
        // through the chosen agent. Explicit per-chat device:X still wins
        // (checked first); a missing token refuses instead of billing cloud.
        if (!routed && global.device?.useAsDefault) {
          if (!global.device?.token) {
            throw new WbError('NO_DEVICE', `Default brain is a device agent but no bridge token is set — popup → Device → Connect Device first. Nothing was sent to the cloud.`);
          }
          routed = { agent: global.device.defaultAgent || 'opencode', via: 'global-default' };
        }
        // Explicit /code with no device token must refuse — never leak code
        // prompts to the cloud provider silently.
        if (!routed && (global.routePrefix || '/code')) {
          const prefix = global.routePrefix || '/code';
          const txt = (msg.newMessages || []).map((m) => m.text || '').join('\n').trim().toLowerCase();
          if (txt.startsWith(prefix.toLowerCase()) && !global.device?.token) {
            throw new WbError('NO_DEVICE', `You're asking for a device run (${prefix}) but no bridge token is set — popup → Device → Connect Device first. Nothing was sent to the cloud.`);
          }
        }
        // Cap total memory fed into the prompt (cloud truncates at 8000 in
        // providers.js; device prompt truncates at 3000) so the session
        // meter stays honest and huge contextMd cannot blow the window.
        const ctxWithSession = (summary) =>
          [cfg.contextMd || '', summary ? `Ongoing session summary (carry-over):\n${summary}` : ''].filter(Boolean).join('\n\n').slice(0, 8000);
        if (routed) {
          const kind = `device:${routed.agent}`;
          const { reply, info } = await executeReplyTurn(store, msg.chatId, msg.chatName, {
            kind,
            build: (summary) => {
              let prompt = devicePrompt({ chatName: msg.chatName, chatCfg: { ...cfg, contextMd: ctxWithSession(summary) }, history: msg.history, newMessages: msg.newMessages });
              if (routed.stripPrefix) {
                // Strip the trigger word where the message actually sits (start
                // of a line inside the prompt), not at string start — the
                // prompt opens with a header, so ^-anchoring never matched.
                const esc = routed.stripPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                prompt = prompt.replace(new RegExp('(^|\\n)' + esc + '\\s*', 'i'), '$1');
              }
              return prompt;
            },
            run: (prompt) => runDeviceTask({ agent: routed.agent, prompt, cwd: cfg.cwd || '', chatId: msg.chatId, chatName: msg.chatName }),
          });
          const watch1 = runningWatchFor(store, msg.chatId);
          if (watch1) { watch1.runCount++; watch1.lastRunAt = Date.now(); await saveSubbots(store.subbots); }
          info.subbot = watch1?.name || null;
          await appendLogs(msg.chatId, [
            ...(msg.newMessages || []).map((m) => ({ ts: Date.now(), dir: 'in', sender: m.sender, text: m.text, msgId: m.msgId })),
            { ts: Date.now(), dir: 'out', sender: watch1 ? `bot:${watch1.id}` : kind, text: reply },
          ], info.id);
          return { reply, via: kind, session: info };
        }
        const { reply, info } = await executeReplyTurn(store, msg.chatId, msg.chatName, {
          kind: 'cloud',
          build: (summary) => buildReplyMessages({
            globalInstruction: global.globalInstruction || '',
            chatInstruction: cfg.instruction || '',
            contextMd: ctxWithSession(summary),
            history: msg.history || [],
            newMessages: msg.newMessages || [],
            historyLimit: global.historyLimit || 30,
          }),
          run: async (oa) => {
            // JSON contract first; plain retry under strict chat-shape test.
            // Anything else is refused — silence beats a leaked thought.
            const raw = await callLLM(oa, { maxTokens: 500, jsonMode: true });
            let text = extractReplyText(raw);
            if (!text) {
              const plain = await callLLM(oa, { maxTokens: 500, jsonMode: false });
              text = extractReplyText(plain, { mode: 'plain-strict' });
            }
            if (!text) throw new Error('Model returned no usable reply twice (JSON + plain). It may be a reasoning-only model — switch to an instruct model (e.g. llama-3.3-70b-instruct, gpt-4o-mini).');
            return text;
          },
        });
        const watch2 = runningWatchFor(store, msg.chatId);
        if (watch2) { watch2.runCount++; watch2.lastRunAt = Date.now(); await saveSubbots(store.subbots); }
        info.subbot = watch2?.name || null;
        await appendLogs(msg.chatId, [
          ...(msg.newMessages || []).map((m) => ({ ts: Date.now(), dir: 'in', sender: m.sender, text: m.text, msgId: m.msgId })),
          { ts: Date.now(), dir: 'out', sender: watch2 ? `bot:${watch2.id}` : 'bot', text: reply },
        ], info.id);
        return { reply, session: info };
        } finally {
          await releaseTurnLock(msg.chatId, lockToken);
        }
});

on('DEVICE_PROBE', async (msg) => {
        const { global } = await getMeta();
        const url = msg.url || global.device?.url || 'http://127.0.0.1:18789';
        const token = msg.token ?? global.device?.token ?? '';
        const health = await deviceHealth(url, token);
        const agents = await deviceAgents(url, token);
        const next = { ...(global.device || {}), url, token, lastSeen: Date.now(), agents };
        await setStore({ global: { ...global, device: next } });
        return { health, agents };
});

on('DEVICE_TASK', async (msg, sender) => {
        // msg: {agent, prompt, cwd, timeoutMs, chatId?, chatName?} — manual test / sidepanel send
        // Bench calls (no chat) are extension-pages-only: a compromised page
        // must not get free bridge execution. Chat-bound calls pass the same
        // allow/master gate as GEN_REPLY.
        if (!msg.chatId && sender?.tab) {
          throw new WbError('FORBIDDEN', 'Device bench runs from extension pages only.');
        }
        if (msg.chatId) {
          const s = await getMeta();
          const { cfg } = getChatCfg(s, msg.chatId);
          if (!cfg.instruction?.trim()) throw new WbError('NO_INSTRUCTION', 'No instruction for this chat.');
          if (cfg.allowed === false && !runningWatchFor(s, msg.chatId)) {
            throw new WbError('DISABLED', 'AI replies are off for this chat.');
          }
          if (s.global.enabled === false && !runningWatchFor(s, msg.chatId)) {
            throw new WbError('DISABLED', 'The bot is disabled in the popup.');
          }
        }
        const reply = await runDeviceTask({ agent: msg.agent, prompt: msg.prompt, cwd: msg.cwd || '', timeoutMs: msg.timeoutMs || 180000 });
        if (msg.chatId) {
          const s = await getStore();
          await appendLogs(msg.chatId, [
            { ts: Date.now(), dir: 'in', sender: msg.chatName || 'user', text: msg.prompt },
            { ts: Date.now(), dir: 'out', sender: `device:${msg.agent}`, text: reply },
          ], getActiveSession(s, msg.chatId)?.id);
        }
        return { reply };
});

on('LOG_INCOMING', async (msg) => {
        const s = await getStore();
        await appendLogs(msg.chatId, (msg.messages || []).map((m) => ({ ts: Date.now(), dir: 'in', sender: m.sender, text: m.text, msgId: m.msgId })), getActiveSession(s, msg.chatId)?.id);
        return {};
});

on('SAVE_CONTEXT_BATCH', async (msg) => {
        // content script streams full-history batches during first-run build.
        // Serialized per chat: a batch landing mid-turn must not clobber it.
        return withStoreLock(`logs:${msg.chatId}`, async () => {
        const { chats, logs } = await getStore();
        const c = chats[msg.chatId] || { name: msg.chatName, allowed: true, mode: 'auto', instruction: '' };
        c.name = msg.chatName || c.name;
        chats[msg.chatId] = c;
        const arr = logs[msg.chatId] || [];
        const batchSessionId = getActiveSession({ chats }, msg.chatId)?.id || null;
        for (const m of msg.messages || []) {
          if (!arr.some((x) => x.msgId && x.msgId === m.msgId)) {
            arr.push({ ts: m.ts || Date.now(), dir: m.dir, sender: m.sender, text: m.text, msgId: m.msgId, sessionId: batchSessionId });
          }
        }
        // keep raw logs sorted oldest->newest, cap. The per-chat cap is the
        // storage guarantee — a lowered maxLogPerChat must win over the
        // (usually larger) build scan cap.
        arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        const { global } = await getStore();
        logs[msg.chatId] = arr.slice(-(global.maxLogPerChat || 2000));
        await setStore({ chats, logs });
        await enforceQuota({ chats, logs });
        return { total: logs[msg.chatId].length };
        });
});

on('FINALIZE_CONTEXT', async (msg) => {
        // msg: {chatId, chatName} -> summarize stored logs into contextMd
        const store = await getStore();
        const arr = store.logs[msg.chatId] || [];
        // Never overwrite good memory with an empty summary: no logs = no build.
        if (!arr.length) throw new WbError('NO_LOGS', `No logged messages for "${msg.chatName}" yet — open the chat so history can be read first.`);
        const text = arr.map((m) => `[${m.dir === 'out' ? 'YOU' : m.sender || 'THEM'}] ${m.text}`).join('\n');
        const oa = buildContextPrompt({ chatName: msg.chatName, chunksText: text });
        const md = await callLLM(oa, { maxTokens: 2000, temperature: 0.3 });
        store.chats[msg.chatId] = {
          ...(store.chats[msg.chatId] || {}),
          name: msg.chatName,
          contextMd: md,
          contextUpdatedAt: Date.now(),
          contextMsgCount: arr.length,
        };
        await setStore({ chats: store.chats });
        return { contextMd: md, msgCount: arr.length };
});

on('TEST_CONNECTION', async () => {
        // Device default: the "connection" is the bridge, not a cloud API.
        const { global } = await getMeta();
        if (global.activeProvider === 'device') {
          const url = global.device?.url || 'http://127.0.0.1:18789';
          const token = global.device?.token || '';
          if (!token) throw new WbError('NO_DEVICE', 'No bridge token — popup → Device → Connect Device first.');
          await deviceHealth(url, token);
          return { reply: 'DEVICE-OK' };
        }
        const t = await callLLM([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 10 });
        return { reply: t };
});

on('AUTO_INSTRUCTION', async (msg) => {
        // msg: {chatId, chatName, overwrite?} -> drafts + SAVES the per-chat
        // instruction from memory + recent logs. Overwrites only when empty
        // or overwrite:true — never silently clobbers a hand-written rule.
        const store = await getStore();
        const { cfg, id: resolvedId } = getChatCfg(store, msg.chatId);
        const existing = String(cfg.instruction || '').trim();
        if (existing && !msg.overwrite) {
          return { instruction: existing, saved: false, reason: 'exists' };
        }
        const arr = store.logs[msg.chatId] || store.logs[baseChatId(msg.chatId)] || [];
        const recentText = arr.slice(-30).map((m) => `[${m.dir === 'out' ? 'YOU' : m.sender || 'THEM'}] ${m.text}`).join('\n');
        if (!recentText && !cfg.contextMd) {
          throw new WbError('NO_LOGS', `No history for "${msg.chatName}" yet — open the chat or press Build first, then Auto again.`);
        }
        const oa = buildInstructionPrompt({
          chatName: msg.chatName,
          contextMd: cfg.contextMd || '',
          recentText,
          globalInstruction: store.global.globalInstruction || '',
        });
        const raw = await callLLM(oa, { maxTokens: 300, temperature: 0.4 });
        const instruction = cleanInstructionText(raw);
        if (!instruction) throw new Error('Model returned an empty instruction — retry once.');
        store.chats[resolvedId] = {
          ...(store.chats[resolvedId] || {}),
          name: msg.chatName,
          kind: store.chats[resolvedId]?.kind || (String(resolvedId).endsWith('#group') ? 'group' : 'chat'),
          instruction,
        };
        await setStore({ chats: store.chats });
        return { instruction, saved: true, chatId: resolvedId };
});

on('LIST_MODELS', async (msg) => {
        // msg: {provider} -> {models, source, count}
        const r = await listModels(msg.provider || (await getStore()).global.activeProvider);
        return { ...r };
});

on('SUGGEST_REPLIES', async (msg) => {
        // msg: {chatId, chatName, history, newMessages} -> {suggestions:[]}
        // Preview-only: never sends, never writes logs. Instruction gate +
        // suggest-mode gate apply; failures return [] (silent, no toast).
        const store = await getMeta();
        const { cfg } = getChatCfg(store, msg.chatId);
        if (!suggestEnabledFor(store.global, cfg)) return { suggestions: [], disabled: true };
        if (!cfg.instruction?.trim()) return { suggestions: [], disabled: true, code: 'NO_INSTRUCTION' };
        if (!suggestRateOk(msg.chatId)) return { suggestions: [], rateLimited: true };
        const fresh = (msg.newMessages || []).filter((m) => m.dir === 'in');
        if (!fresh.length) return { suggestions: [] };
        const count = Math.min(Math.max(store.global.suggestCount || 3, 2), 3);
        const oa = buildSuggestMessages({
          globalInstruction: store.global.globalInstruction || '',
          chatInstruction: cfg.instruction || '',
          contextMd: cfg.contextMd || '',
          history: msg.history || [],
          newMessages: fresh.slice(-3),
          count,
        });
        try {
          const raw = await callLLM(oa, { maxTokens: 200, temperature: 0.5, jsonMode: true });
          const suggestions = extractSuggestions(raw, { max: count });
          if (suggestions.length) return { suggestions };
          const plain = await callLLM(oa, { maxTokens: 200, temperature: 0.5, jsonMode: false });
          return { suggestions: extractSuggestions(plain, { max: count }) };
        } catch {
          return { suggestions: [] };
        }
});

on('PARSE_TASK', async (msg) => {
        // msg: {task, chatNames[]} → {plan:{action,chat?,message?}} via LLM JSON
          const names = (msg.chatNames || []).slice(0, 40).join('\n');
          const raw = await callLLM([
            { role: 'system', content: 'Parse a WhatsApp owner command into EXACTLY one JSON object, nothing else. Actions: "send_message" (needs chat + message), "report_unread" (needs nothing), "unknown". Match "chat" to the closest name from the list; keep "message" verbatim.' },
            { role: 'user', content: `Known chats:\n${names}\n\nCommand: ${msg.task}\n\nAnswer {"action":"...","chat":"...","message":"..."} — omit keys that do not apply.` },
          ], { maxTokens: 200, jsonMode: true });
          // NOTE: do NOT run extractReplyText here — it hunts a "reply" field
          // and would eat this valid plan JSON. Parse the object directly.
          let plan = { action: 'unknown' };
          try {
            const j = JSON.parse(raw);
            if (j && typeof j.action === 'string') plan = { action: j.action, chat: j.chat || '', message: j.message || '' };
          } catch {
            try {
              const m = String(raw || '').match(/\{[\s\S]*\}/);
              const j = m && JSON.parse(m[0]);
              if (j && typeof j.action === 'string') plan = { action: j.action, chat: j.chat || '', message: j.message || '' };
            } catch {}
          }
          if (plan.action !== 'send_message' && plan.action !== 'report_unread') plan = { action: 'unknown' };
          if (plan.action === 'send_message' && (!plan.chat || !plan.message)) plan = { action: 'unknown' };
          return { plan };
});
on('SUMMARIZE_UNREAD', async (msg) => {
        // msg: {items:[{name,preview,unread}]} → {report} plain text
          const lines = (msg.items || []).slice(0, 30).map((c) => `• ${c.name}${c.unread ? ` (${c.unread} unread)` : ''}: ${c.preview || '(no preview)'}`).join('\n');
          const report = await callLLM([
            { role: 'user', content: `These WhatsApp chats have unread messages. Write a short report: per chat one line (who + what it's about), then the 1-2 most urgent first. Plain text, no preamble:\n${lines}` },
          ], { maxTokens: 600 });
          return { report: String(report || '').trim().slice(0, 2000) };
});
on('SUBBOT_PARSE', async (msg) => {
        // msg: {text} → {draft, source:'llm'|'offline'}. Offline patterns run
        // FIRST (instant, free); LLM refines only when offline draws a blank.
        const off = parseSubbotOffline(msg.text);
        if (off) return { draft: off, source: 'offline' };
          const raw = await callLLM([
            { role: 'system', content: 'Parse a WhatsApp owner command into EXACTLY one JSON object, nothing else: {"kind":"watch"|"task"|"unknown","target":"person or topic","instruction":"how the watch bot should behave","task":"what the task bot should do","name":"short name"}. "watch" = continuously reply to one person (needs target; default instruction "Reply helpfully and briefly, matching their language." when unstated). "task" = one-shot job like listing who chatted recently (put the job in "task"). Anything else → "unknown".' },
            { role: 'user', content: `Command: ${msg.text}\n\nAnswer with exactly {"kind":"...","target":"...","instruction":"...","task":"...","name":"..."} and nothing else.` },
          ], { maxTokens: 300, jsonMode: true });
          // NOTE: no extractReplyText — it would eat valid non-"reply" JSON.
          const tryDraft = (j) => {
            if (!(j && (j.kind === 'watch' || j.kind === 'task'))) return null;
            const d = {
              kind: j.kind,
              target: String(j.target || '').slice(0, 120),
              instruction: String(j.instruction || (j.kind === 'watch' ? 'Reply helpfully and briefly, matching their language.' : '')).slice(0, 1000),
              task: String(j.task || msg.text).slice(0, 500),
              name: String(j.name || autoName(j.kind, j.target)).slice(0, 80),
            };
            return d.kind === 'watch' && !d.target ? null : d;
          };
          let d = null;
          try {
            d = tryDraft(JSON.parse(raw));
            if (!d) {
              const m = String(raw || '').match(/\{[\s\S]*\}/);
              d = m ? tryDraft(JSON.parse(m[0])) : null;
            }
          } catch {}
          if (!d) throw new Error(`Could not understand "${String(msg.text || '').slice(0, 60)}". Try: "respond to NAME continuously" or "list who chatted me last month".`);
          return { draft: d, source: 'llm' };
});
on('SUBBOT_CONFIRM', async (msg) => {
        // msg: {draft:{kind,target,targetKind,instruction,task,name,userText}} → creates + starts (watch binds rule; task executes now)
          const store = await getStore();
          const d = msg.draft || {};
          if (d.kind === 'watch') {
            // Serialize creates: the cap + duplicate checks below read-then-
            // write, so overlapping confirms would all pass and overfill.
            return withStoreLock('subbots', async () => {
            const store = await getStore();
            const running = Object.values(store.subbots).filter((b) => b.kind === 'watch' && b.status === 'running').length;
            if (running >= MAX_WATCH_BOTS) throw new Error(`Max ${MAX_WATCH_BOTS} running watch bots. Stop one first.`);
            if (!d.target?.trim()) throw new Error('Watch bot needs a person name.');
            if (!d.instruction?.trim()) throw new Error('Watch bot needs an instruction.');
            // Kind-aware target: explicit targetKind wins, else "group" hint
            // in the name, else reuse an existing rule's kind, else chat.
            // Canonicalize spelling too: `business_assistant` → stored
            // `Business assistant`, so the watcher binds the real chat.
            const rawTarget = d.target.trim();
            const canonical = canonicalNameFor(store.chats, rawTarget) || rawTarget.replace(/[_–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
            const target = canonical;
            let kind = String(d.targetKind || '').toLowerCase() === 'group' ? 'group' : '';
            if (!kind && /\bgroup\b/i.test(target)) kind = 'group';
            if (!kind) {
              const want = normalizeName(target);
              const hit = Object.entries(store.chats).find(([, c]) => normalizeName(c?.name || '') === want);
              if (hit && (hit[1]?.kind === 'group' || String(hit[0]).endsWith('#group'))) kind = 'group';
            }
            const targetChatId = resolveChatId(store.chats, target, kind || 'chat');
            // Reject a second running watcher on the same chat: the second
            // bind would overwrite managedBy+prev and corrupt the first bot.
            const clash = Object.values(store.subbots).find((b) => b.kind === 'watch' && b.status === 'running' && b.targetChatId === targetChatId);
            if (clash) throw new Error(`"${target}" is already watched by "${clash.name}" — pause/stop it first.`);
            const bot = newSubbot({ kind: 'watch', name: d.name, userText: d.userText || '', target, targetKind: kind || 'chat', instruction: d.instruction.trim() });
            bot.targetChatId = targetChatId; // resolved (reuses legacy base id when present)
            const { rule, prev } = bindWatchRule(store.chats[bot.targetChatId], bot);
            rule.kind = kind || store.chats[bot.targetChatId]?.kind || 'chat';
            bot.prev = prev;
            store.chats[bot.targetChatId] = rule;
            store.subbots[bot.id] = bot;
            await setStore({ chats: store.chats });
            await saveSubbots(store.subbots);
            return { subbot: publicBot(bot) };
            });
          } else if (d.kind === 'task') {
            const bot = newSubbot({ kind: 'task', name: d.name, userText: d.userText || '', target: d.target || '', task: d.task || d.userText || '' });
            store.subbots[bot.id] = bot;
            await saveSubbots(store.subbots);
            const result = await runSubbotTask(store, bot);
            return { subbot: publicBot(result) };
          } else {
            throw new Error('Unknown subbot kind.');
          }
});
on('SUBBOT_OP', async (msg) => {
        // msg: {op:'pause'|'resume'|'restart'|'stop'|'delete'|'unlink', id}
          const store = await getStore();
          const bot = store.subbots[msg.id];
          if (!bot) throw new Error('Subbot not found.');
          const wantResume = msg.op === 'resume' || msg.op === 'restart';
          // Dock "Restart" on a stopped bot sends op:resume for back-compat;
          // treat resume-on-stopped as restart (fresh bind, original prev kept
          // when available so a later stop still restores correctly).
          const effectiveOp = (msg.op === 'resume' && bot.status === 'stopped') ? 'restart' : msg.op;
          if (msg.op === 'delete') {
            if (bot.kind === 'watch' && (bot.status === 'running' || bot.status === 'paused')) {
              const cfg = store.chats[bot.targetChatId];
              if (cfg && cfg.managedBy === bot.id) {
                store.chats[bot.targetChatId] = restoreRule(cfg, bot.prev);
                await setStore({ chats: store.chats });
              }
            }
            delete store.subbots[msg.id];
          } else if (msg.op === 'pause' && bot.kind === 'watch') {
            bot.status = 'paused';
            const cfg = store.chats[bot.targetChatId];
            if (cfg && cfg.managedBy === bot.id) { cfg.allowed = false; await setStore({ chats: store.chats }); }
          } else if (wantResume && bot.kind === 'watch') {
            const running = Object.values(store.subbots).filter((b) => b.kind === 'watch' && b.status === 'running').length;
            if (running >= MAX_WATCH_BOTS) throw new Error(`Max ${MAX_WATCH_BOTS} running watch bots.`);
            bot.status = 'running';
            const cfg = store.chats[bot.targetChatId];
            if (cfg && cfg.managedBy === bot.id) { cfg.allowed = true; await setStore({ chats: store.chats }); }
            else if (!cfg || !cfg.managedBy) {
              const { rule, prev } = bindWatchRule(cfg, bot);
              // Keep the ORIGINAL prev when we have it (restart or resume
              // after unlink): stop must restore the pre-watch rule exactly.
              if (!bot.prev) bot.prev = prev;
              store.chats[bot.targetChatId] = rule;
              await setStore({ chats: store.chats });
            }
          } else if (msg.op === 'unlink' && bot.kind === 'watch') {
            bot.status = 'paused';
            const cfg = store.chats[bot.targetChatId];
            if (cfg && cfg.managedBy === bot.id) {
              cfg.managedBy = null;
              cfg.allowed = false;
              await setStore({ chats: store.chats });
            }
          } else if (msg.op === 'stop' && bot.kind === 'watch') {
            bot.status = 'stopped';
            const cfg = store.chats[bot.targetChatId];
            if (cfg && cfg.managedBy === bot.id) {
              store.chats[bot.targetChatId] = restoreRule(cfg, bot.prev);
              await setStore({ chats: store.chats });
            }
          } else {
            throw new Error(`Cannot ${msg.op} a ${bot.kind} bot.`);
          }
          await saveSubbots(store.subbots);
          return { subbot: publicBot(bot) };
});
on('SUBBOT_PAUSE_ALL', async (msg) => {
        // Panic button: pause every RUNNING watch bot at once. Already-paused
        // bots are left alone so the count reports newly-paused only.
          const store = await getStore();
          let n = 0;
          for (const bot of Object.values(store.subbots)) {
            if (bot.kind === 'watch' && bot.status === 'running') {
              bot.status = 'paused';
              const cfg = store.chats[bot.targetChatId];
              if (cfg && cfg.managedBy === bot.id) cfg.allowed = false;
              n++;
            }
          }
          await setStore({ chats: store.chats });
          await saveSubbots(store.subbots);
          return { paused: n };
});
on('SUBBOT_LIST', async () => {
        const store = await getStore();
        // Self-repair pass: watchers created before target canonicalization
        // (e.g. `business_assistant` vs `Business assistant`) sit at runs:0
        // on a phantom id. Remap them to the real chat once, move the rule
        // binding, and persist — so old watchers start firing without
        // forcing the user to delete/recreate.
        let repaired = false;
        for (const bot of Object.values(store.subbots)) {
          if (bot?.kind !== 'watch' || (bot.status !== 'running' && bot.status !== 'paused')) continue;
          if (store.chats[bot.targetChatId]) continue; // already bound to a real rule
          const canonical = canonicalNameFor(store.chats, bot.target);
          if (!canonical) continue;
          const wantId = resolveChatId(store.chats, canonical, bot.targetKind || 'chat');
          if (!store.chats[wantId] || wantId === bot.targetChatId) continue;
          // Never clobber a real hand-written rule: if the target already
          // has an instruction and isn't managed by this bot, leave it alone.
          const existing = store.chats[wantId];
          if (existing && String(existing.instruction || '').trim() && existing.managedBy !== bot.id) continue;
          const oldCfg = store.chats[bot.targetChatId];
          if (oldCfg && oldCfg.managedBy === bot.id) {
            store.chats[bot.targetChatId] = restoreRule(oldCfg, bot.prev);
          }
          bot.target = canonical;
          const { rule, prev } = bindWatchRule(store.chats[wantId], bot);
          if (!bot.prev) bot.prev = prev;
          bot.targetChatId = wantId;
          store.chats[wantId] = rule;
          repaired = true;
        }
        if (repaired) {
          await setStore({ chats: store.chats });
          await saveSubbots(store.subbots);
        }
        return { subbots: Object.values(store.subbots).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(publicBot), repaired };
});

on('NEW_SESSION', async (msg) => {
        // msg: {chatId, chatName} — manual rollover: close active, open fresh.
        // Locked per chat so a concurrent reply turn can't fork sessions.
        return withStoreLock(`chat:${msg.chatId}`, async () => {
        const store = await getStore();
        const cfg = store.chats[msg.chatId] || { name: msg.chatName };
        const active = getActiveSession(store, msg.chatId);
        if (active) await persistSession(store, msg.chatId, closeSession(active, 'closed'));
        const sess = await openSession(store, msg.chatId, 'manual', msg.chatName);
        const { limit, known } = ctxLimit(store);
        return { session: { id: sess.id, n: sess.n, ctx: formatCtx(0, limit, known), state: 'active' } };
        });
});

on('EXPORT_CHAT', async (msg) => {
        // build downloadable context.md / logs.json in sidepanel via data URL; here just return payload
        const store = await getStore();
        const rawChat = store.chats[msg.chatId];
        const chat = rawChat ? { ...rawChat, name: rawChat.name || msg.chatName || msg.chatId } : null;
        const { limit, known } = ctxLimit(store);
        const sessions = (chat?.sessions || []).map((s) => ({
          ...s, ctx: formatCtx(s.estTokens || 0, limit, known), state: sessionState(s, limit),
        }));
        return { chat, logs: store.logs[msg.chatId] || [], sessions, activeSessionId: chat?.activeSessionId || null };
});

// Sender allowlist: only our own extension pages (popup/console, no tab)
// and our content script inside WhatsApp Web may drive the worker. Anything
// else — other extensions, web pages, spoofed senders — gets FORBIDDEN
// before any handler runs.
function senderAllowed(sender) {
  try {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!sender.tab) return true; // extension page or worker self-call
    const url = sender.tab.url || sender.url || '';
    return typeof url === 'string' && /^https:\/\/web\.whatsapp\.com\//.test(url);
  } catch { return false; }
}

// Thin envelope wrapper: handlers return payloads, errors carry .code.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!senderAllowed(sender)) throw new WbError('FORBIDDEN', 'Sender is not part of this extension.');
      const payload = await dispatch(msg, sender);
      sendResponse({ ok: true, ...(payload || {}) });
    } catch (e) {
      sendResponse({ ok: false, ...(e?.code ? { code: e.code } : {}), error: String(e?.message || e) });
    }
  })();
  return true; // async
});
