// Subbot helpers — pure functions (no chrome.*), unit-tested.
// A subbot is a user-launched worker: kind 'watch' (continuous replies to
// one chat until stopped) or 'task' (one-shot job, then done/error).
// Collision-safe IDs: crypto.randomUUID when available, otherwise
// timestamp + monotonic counter + random (counter fixes same-ms clashes
// that made the 200-ID uniqueness test flaky at ~1.2%).
let __botCounter = 0;
function botSuffix(len = 8) {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid.replaceAll('-', '').slice(0, len);
  } catch {}
  try {
    const buf = new Uint8Array(len);
    globalThis.crypto?.getRandomValues?.(buf);
    let s = '';
    for (const b of buf) s += (b % 36).toString(36);
    if (s.length >= len) return s.slice(0, len);
  } catch {}
  __botCounter = (__botCounter + 1) % 46656;
  return `${Date.now().toString(36)}${__botCounter.toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 2 + len)}`.slice(0, len + 8);
}
export function subbotId() {
  return `b-${Date.now().toString(36)}${botSuffix(8)}`;
}

export function chatIdForName(name, kind) {
  const base = 'name:' + normalizeName(name);
  // Group suffix disambiguates a group vs 1:1 sharing one display name
  // (previously they shared rules/logs/sessions and corrupted each other).
  // Old installs only have the base id — callers must fall back to it.
  if (String(kind || '').toLowerCase() === 'group') return `${base}#group`;
  return base;
}

// Human-tolerant name key: underscores/hyphens become spaces, whitespace
// collapses, case folds. Fixes the classic stuck-watcher bug where the user
// types `business_assistant` but the chat header is `Business assistant` —
// without this the watcher binds a phantom id and runs:0 forever.
export function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[_–—-]+/g, ' ').replace(/\s+/g, ' ');
}

// Canonical display-name lookup: exact → normalized → base fallbacks, so
// `business_assistant`, `Business-Assistant` and `business  assistant` all
// resolve to the stored `Business assistant` rule instead of forking one.
export function canonicalNameFor(chats, name) {
  const want = normalizeName(name);
  let fallback = null;
  for (const [, c] of Object.entries(chats || {})) {
    const stored = String(c?.name || '');
    if (!stored) continue;
    if (stored.trim().toLowerCase() === String(name || '').trim().toLowerCase()) return stored;
    if (normalizeName(stored) === want && !fallback) fallback = stored;
  }
  return fallback;
}

export function baseChatId(id) {
  return String(id || '').replace(/#group$/, '');
}

export function isGroupId(id) {
  return String(id || '').endsWith('#group');
}

// Resolve an existing chat id for (name, kind): prefer the kind-aware id,
// then normalized-underscore variants, then the legacy base id so pre-v3
// installs keep their history.
export function resolveChatId(chats, name, kind) {
  const exact = chatIdForName(name, kind);
  if (chats && chats[exact]) return exact;
  const base = chatIdForName(name);
  if (chats && chats[base]) return base;
  // Normalized variants: business_assistant ↔ Business assistant.
  if (chats) {
    const want = normalizeName(name);
    const suffix = String(kind || '').toLowerCase() === 'group' ? '#group' : '';
    for (const id of Object.keys(chats)) {
      const b = baseChatId(id).replace(/^name:/, '');
      if (b === want && (suffix ? id.endsWith(suffix) : true)) return id;
    }
    for (const id of Object.keys(chats)) {
      if (baseChatId(id).replace(/^name:/, '') === want) return id;
    }
  }
  // No existing entry — create with the kind-aware id.
  return exact;
}

export function autoName(kind, target) {
  const t = String(target || '').trim().slice(0, 40) || 'general';
  return kind === 'watch' ? `Responder: ${t}` : `Task: ${t}`;
}

// Bind a watch subbot onto a chat rule. Returns { rule, prev } where prev
// captures whatever was there so STOP can restore it exactly. Unknown/future
// rule fields survive via spread — binding must never amputate stored data
// (context dates, counts, sessions).
export function bindWatchRule(rule, subbot) {
  const prev = {
    hadRule: !!rule,
    instruction: rule?.instruction || '',
    allowed: rule ? !!rule.allowed : false,
    mode: rule?.mode || 'auto',
    routeTo: rule?.routeTo || 'cloud',
    cwd: rule?.cwd || '',
  };
  const next = {
    ...(rule || {}),
    name: subbot.target,
    allowed: true,
    mode: 'auto',
    instruction: subbot.instruction,
    managedBy: subbot.id,
  };
  return { rule: next, prev };
}

// Undo bindWatchRule using the snapshot. Auto-created rules (hadRule false)
// are left in place but switched off so no history is lost.
export function restoreRule(rule, prev) {
  if (!prev || !prev.hadRule) {
    return { ...(rule || {}), allowed: false, managedBy: null };
  }
  return {
    ...(rule || {}),
    instruction: prev.instruction,
    allowed: prev.allowed,
    mode: prev.mode,
    routeTo: prev.routeTo,
    cwd: prev.cwd,
    managedBy: null,
  };
}

// Offline fallback parser: common phrasings, zero network. The LLM parser
// stays primary; this runs when it fails or returns unknown, so subbots work
// fully offline for the patterns people actually type. Word matchers are
// typo-tolerant (msg/msges/messages) because real typed input has typos.
const MSGW = '(?:msg\\w*|message\\w*|text\\w*|chat\\w*|writ\\w*)';
export function parseSubbotOffline(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let m = t.match(new RegExp(`(?:respond|reply|answer)\\s+(?:to\\s+)?(.+?)\\s+(?:continuously|always|constantly|every\\s+time|if\\s+\\w+\\s+${MSGW}|when(?:ever)?\\s+\\w+\\s+${MSGW})`, 'i'))
    || t.match(/(?:run|start|make|create)\s+(?:a\s+)?bot\s+(?:that\s+|to\s+)?(?:continuously\s+)?(?:responds?\s+to|reply\s+to|answer)\s+(.+)/i)
    || t.match(new RegExp(`(?:respond|reply|answer)\\s+(?:to\\s+)?(.+?)\\s+(?:if|when|whenever)\\s+`, 'i'))
    || t.match(/(?:watch|follow)\s+(.+)/i);
  if (m?.[1]?.trim()) {
    const target = m[1].trim().replace(/^["']|["']$/g, '').replace(/[.,!?;:]+$/g, '').trim().slice(0, 120);
    if (target) {
      return {
        kind: 'watch', target,
        instruction: 'Reply helpfully and briefly, matching their language.',
        task: '', name: autoName('watch', target),
      };
    }
  }
  m = t.match(/(?:list|show|who).*(?:chatted|messaged|talked|wrote)|(?:recent|active|monthly).*?(?:chat|user|people)|summar(y|ize).*unread/i);
  if (m) {
    return { kind: 'task', target: 'recent chats', instruction: '', task: t.slice(0, 500), name: autoName('task', 'recent chats') };
  }
  return null;
}

export function newSubbot({ kind, name, userText, target, targetKind, instruction, task }) {
  const now = Date.now();
  return {
    id: subbotId(),
    name: name || autoName(kind, target),
    kind, // 'watch' | 'task'
    userText: userText || '',
    target: target || '',
    targetChatId: kind === 'watch' ? chatIdForName(target, targetKind) : '',
    targetKind: targetKind || '',
    instruction: instruction || '',
    task: task || '',
    status: 'running', // running|paused|done|error|stopped
    prev: null,
    createdAt: now,
    lastRunAt: 0,
    runCount: 0,
    lastResult: '',
    lastError: '',
  };
}
