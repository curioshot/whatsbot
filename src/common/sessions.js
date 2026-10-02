// Session lifecycle core — pure functions, no chrome.* calls, so the service
// worker (ephemeral per skill rule 7) can use them with read-modify-write on
// chrome.storage.local, and node can unit-test them directly.
export const SESSION_VERSION = 1;
export const WARN_RATIO = 0.8;
export const FULL_RATIO = 0.95;
export const MAX_SESSIONS_PER_CHAT = 10;
export const IDLE_CLOSE_MS = 24 * 3600 * 1000;

// Curated context-window limits (tokens). Unknown models fall back to
// DEFAULT_LIMIT and the UI labels the meter "est."
export const DEFAULT_LIMIT = 32000;
export const MODEL_LIMITS = {
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4.1': 1047576,
  'gpt-4.1-mini': 1047576,
  'o4-mini': 200000,
  'o3-mini': 200000,
  'claude-sonnet-4-20250514': 200000,
  'claude-opus-4-20250514': 200000,
  'claude-3-7-sonnet-20250219': 200000,
  'claude-3-5-haiku-20241022': 200000,
  'llama-3.3-70b-versatile': 128000,
  'llama-3.1-8b-instant': 128000,
  'mixtral-8x7b-32768': 32768,
  'gemma2-9b-it': 8192,
  'meta/llama-3.3-70b-instruct': 128000,
  'llama3.1': 128000,
  'llama3.2': 128000,
  'qwen2.5': 32768,
};

export function limitForModel(modelId, override) {
  if (Number.isFinite(override) && override > 0) return { limit: override, known: true };
  if (modelId && MODEL_LIMITS[modelId]) return { limit: MODEL_LIMITS[modelId], known: true };
  // prefix match for versioned ids, e.g. "gpt-4o-2024-11-20". Reverse match
  // requires a decent-length id so "g" doesn't match everything.
  if (modelId) {
    const hit = Object.keys(MODEL_LIMITS).find((k) => modelId.startsWith(k) || (modelId.length >= 4 && k.startsWith(modelId)));
    if (hit) return { limit: MODEL_LIMITS[hit], known: true };
  }
  return { limit: DEFAULT_LIMIT, known: false };
}

// Rough token estimate (chars/4). Labeled "est." in UI — honest, no fake precision.
export function estTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function estimateUsage({ systemChars, historyChars, contextChars, reserveTokens }) {
  const used = estTokens(systemChars) + estTokens(historyChars) + estTokens(contextChars) + (reserveTokens || 0);
  return used;
}

let __idCounter = 0;
function cryptoSuffix(len = 8) {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid.replaceAll('-', '').slice(0, len);
  } catch {}
  try {
    const buf = new Uint8Array(len);
    globalThis.crypto?.getRandomValues?.(buf);
    if (buf[0] !== undefined || len === 0) {
      let s = '';
      for (const b of buf) s += (b % 36).toString(36);
      if (s.length >= len && len > 0) return s.slice(0, len);
    }
  } catch {}
  // Fallback: timestamp + counter + Math.random (counter guarantees
  // uniqueness within the same millisecond, fixing the 200-IDs-in-1ms clash).
  __idCounter = (__idCounter + 1) % 46656;
  return `${Date.now().toString(36)}${__idCounter.toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 2 + len)}`.slice(0, len + 8);
}

export function shortId() {
  return `s-${Date.now().toString(36)}${cryptoSuffix(8)}`;
}

export function newSession(chatId, n, now = Date.now()) {
  return {
    v: SESSION_VERSION, id: shortId(), chatId, n,
    status: 'active', startedAt: now, lastActiveAt: now, endedAt: 0,
    msgCount: 0, estTokens: 0, summary: '', lastError: '',
  };
}

export function sessionRatio(session, limit) {
  if (!limit || limit <= 0) return 0;
  return (session.estTokens || 0) / limit;
}

export function sessionState(session, limit) {
  const r = sessionRatio(session, limit);
  if (session.status !== 'active') return session.status;
  if (r >= FULL_RATIO) return 'full';
  if (r >= WARN_RATIO) return 'warning';
  return 'active';
}

// Pure rollover decision. Returns {action, reason}. Idle is measured from
// last activity (not creation) so a long-lived but busy chat never rolls.
export function decideRollover(session, limit, hadError, now = Date.now()) {
  if (!session || session.status !== 'active') return { action: 'roll-error', reason: 'no active session' };
  const lastActive = session.lastActiveAt || session.startedAt;
  if (now - lastActive > IDLE_CLOSE_MS && session.msgCount > 0) {
    return { action: 'roll-idle', reason: 'idle over 24h' };
  }
  if (hadError) return { action: 'roll-error', reason: 'reply failed' };
  if (sessionRatio(session, limit) >= FULL_RATIO) return { action: 'roll-full', reason: 'context full' };
  return { action: 'keep' };
}

export function closeSession(session, status, now = Date.now()) {
  return { ...session, status, endedAt: now };
}

// Keep only the newest N sessions per chat (oldest dropped; their summaries
// should already be folded into context by the caller).
export function pruneSessions(sessions) {
  return (sessions || []).slice(-MAX_SESSIONS_PER_CHAT);
}

export function formatCtx(used, limit, known) {
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
  return `${k(used)}/${k(limit)}${known ? '' : ' est.'}`;
}
