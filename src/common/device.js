// Device bridge client (imported by background/popup/sidepanel).
// Every call carries a timeout — a dead bridge must fail fast, never hang
// the caller (especially the ephemeral service worker).
export const DEVICE_AGENTS = ['opencode', 'codex', 'claude', 'antigravity'];

const DEFAULT_TIMEOUT_MS = 20000;

export function bridgeHeaders(token) {
  return { 'Content-Type': 'application/json', 'X-WhatsBot-Token': token || '' };
}

async function fetchT(url, opts = {}, ms = DEFAULT_TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`bridge timed out after ${Math.round(ms / 1000)}s (${url}) — is node bridge.mjs running?`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function deviceHealth(url, token) {
  const r = await fetchT(`${url.replace(/\/$/, '')}/health`, { headers: bridgeHeaders(token) }, 10000);
  if (!r.ok) throw new Error(`bridge HTTP ${r.status}`);
  return r.json();
}

export async function deviceAgents(url, token) {
  const r = await fetchT(`${url.replace(/\/$/, '')}/agents`, { headers: bridgeHeaders(token) }, 30000);
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.agents || [];
}

export async function deviceSubmit(url, token, { agent, prompt, cwd, timeoutMs }) {
  const r = await fetchT(`${url.replace(/\/$/, '')}/task`, {
    method: 'POST',
    headers: bridgeHeaders(token),
    body: JSON.stringify({ agent, prompt, cwd, timeoutMs }),
  }, 20000);
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.id;
}

export async function devicePoll(url, token, id) {
  const r = await fetchT(`${url.replace(/\/$/, '')}/task/${id}`, { headers: bridgeHeaders(token) }, 20000);
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.task;
}

// Submit + poll until done/error/timeout. onTick(task, elapsedMs) for progress UI.
// Durability: the bridge task id is journaled to chrome.storage.session
// before polling starts and cleared on settle, so a service-worker restart
// mid-task leaves a recoverable record (see reconcilePendingDeviceTasks +
// the wb-device-tick alarm in the service worker). Polling itself stays a
// tight loop for the common case; the journal is only the fallback.
export const DEVICE_PENDING_KEY = 'wb_device_pending';
export async function deviceRunAndWait(url, token, { agent, prompt, cwd, timeoutMs = 180000, pollMs = 1500, chatId, chatName }, onTick) {
  const id = await deviceSubmit(url, token, { agent, prompt, cwd, timeoutMs });
  try { await journalDevicePending({ id, url, agent, chatId: chatId || '', chatName: chatName || '', startedAt: Date.now() }); } catch {}
  const t0 = Date.now();
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      const t = await devicePoll(url, token, id);
      onTick?.(t, Date.now() - t0);
      if (t.state === 'done' || t.state === 'error') {
        try { await unjournalDevicePending(id); } catch {}
        return t;
      }
      if (Date.now() - t0 > timeoutMs + 15000) throw new Error('device task timed out waiting');
    }
  } catch (e) {
    // Leave the journal entry so the alarm can reconcile an orphan that
    // actually finished in the bridge after we stopped polling.
    throw e;
  }
}

async function readPending() {
  try {
    const r = await chrome.storage.session.get([DEVICE_PENDING_KEY]);
    const v = r?.[DEVICE_PENDING_KEY];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
export async function journalDevicePending(entry) {
  try {
    const cur = await readPending();
    cur.push(entry);
    await chrome.storage.session.set({ [DEVICE_PENDING_KEY]: cur.slice(-10) });
  } catch {}
}
export async function unjournalDevicePending(id) {
  try {
    const cur = await readPending();
    await chrome.storage.session.set({ [DEVICE_PENDING_KEY]: cur.filter((e) => e?.id !== id) });
  } catch {}
}
// Alarm/startup reconciliation: poll each journaled task once. Returns the
// settled tasks so the caller can append them to logs. Never throws.
export async function reconcilePendingDeviceTasks(tokenByUrl) {
  const out = [];
  try {
    const cur = await readPending();
    for (const e of cur) {
      try {
        const token = (tokenByUrl && tokenByUrl[e.url]) || '';
        const t = await devicePoll(e.url, token, e.id);
        if (t.state === 'done' || t.state === 'error') {
          out.push({ entry: e, task: t });
          await unjournalDevicePending(e.id);
        } else if (Date.now() - (e.startedAt || 0) > 30 * 60 * 1000) {
          await unjournalDevicePending(e.id); // stale (>30m), drop
        }
      } catch {}
    }
  } catch {}
  return out;
}
