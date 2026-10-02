import { applyTheme, wireThemeButton, watchSystem } from '../ui/theme.js';

const $ = (id) => document.getElementById(id);

function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.classList.remove('ok', 'err');
  if (kind) el.classList.add(kind);
}
function setWa(ok, label) {
  $('waDot').className = 'dot' + (ok ? ' ok' : '');
  $('waLabel').textContent = label;
}

async function waTab() {
  const tabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
  if (!tabs.length) throw new Error('Open web.whatsapp.com in a tab first (and scan QR).');
  return tabs[0];
}
async function sendToWA(type, extra = {}) {
  const tab = await waTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, { type, ...extra });
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(e.message || '')) throw e;
    // Content script not alive in that tab (stale tab after extension reload/update).
    // Re-inject our content scripts, then retry once.
    setStatus($('conn'), 'Content script missing in WhatsApp tab — re-injecting…');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/whatsapp-dom.js', 'src/content/content.js'],
    });
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await chrome.tabs.sendMessage(tab.id, { type, ...extra });
    } catch (e2) {
      throw new Error('WhatsApp tab still not responding. Hard-reload it (Ctrl+Shift+R), wait for the WhatsBot floating button to appear, then retry.');
    }
  }
}
async function getStore() {
  const r = await chrome.storage.local.get(['wb_chats', 'wb_logs', 'wb_global', 'wb_subbots']);
  return { chats: r.wb_chats || {}, logs: r.wb_logs || {}, global: r.wb_global || {}, subbots: r.wb_subbots || {} };
}
async function setChats(chats) { await chrome.storage.local.set({ wb_chats: chats }); }
// Read-modify-write a single chat: parallel edits from different cards must
// never clobber each other with stale objects.
async function mutateChat(id, fn) {
  const { chats } = await getStore();
  if (!chats[id]) throw new Error('Chat no longer exists — refresh the list.');
  fn(chats[id]);
  await setChats(chats);
}

$('ping').onclick = async () => {
  try {
    const r = await sendToWA('PING');
    const ok = !!r?.loaded;
    setWa(ok, ok ? `WhatsApp: ${r.chat?.chatName || 'loaded'}` : 'WhatsApp: injected, not loaded');
    setStatus($('conn'), ok ? `Connected. Active: ${r.chat?.chatName || '—'}` : 'Extension injected but WA not loaded yet.', ok ? 'ok' : '');
  } catch (e) { setWa(false, 'WhatsApp: unreachable'); setStatus($('conn'), 'Failed: ' + e.message, 'err'); }
};

$('list').onclick = async () => {
  try {
    const r = await sendToWA('LIST_CHATS');
    const div = $('chatList'); div.innerHTML = '';
    (r.chats || []).forEach((c) => {
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.innerHTML = `<svg class="icon"><use href="#i-chat"/></svg><span></span>`;
      b.querySelector('span').textContent = `${c.name}${c.unread ? ` (${c.unread})` : ''}`;
      b.onclick = async () => {
        try {
          $('buildName').value = c.name; $('newChat').value = c.name;
          await sendToWA('OPEN_CHAT', { name: c.name });
        } catch (e) { setStatus($('conn'), 'Failed to open: ' + e.message, 'err'); }
      };
      div.appendChild(b);
    });
    if (!r.chats?.length) setStatus($('conn'), 'No chats found — is WA loaded?', 'err');
  } catch (e) { setStatus($('conn'), 'Failed: ' + e.message, 'err'); }
};

$('contacts').onclick = async () => {
  setStatus($('conn'), 'Opening contacts… (watch the WhatsApp tab, it opens and closes the New-chat pane)');
  try {
    const r = await sendToWA('LIST_CONTACTS');
    const div = $('contactList'); div.innerHTML = '';
    const mkBtn = (icon, label, title, name) => {
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.title = title;
      b.innerHTML = `<svg class="icon"><use href="#${icon}"/></svg><span></span>`;
      b.querySelector('span').textContent = label;
      b.onclick = async () => {
        $('buildName').value = name; $('newChat').value = name;
        try { await sendToWA('OPEN_CHAT', { name }); }
        catch (e) { setStatus($('conn'), 'Failed to open: ' + e.message, 'err'); }
      };
      return b;
    };
    const h1 = document.createElement('div'); h1.className = 'hint'; h1.textContent = `Contacts (${(r.contacts || []).length}) — click to open, then Add in step 3 with an instruction:`; div.appendChild(h1);
    (r.contacts || []).forEach((c) => div.appendChild(mkBtn('i-contact', c.detail ? `${c.name} — ${c.detail}` : c.name, c.detail || c.name, c.name)));
    const h2 = document.createElement('div'); h2.className = 'hint'; h2.textContent = `Groups (${(r.groups || []).length}) — from your chat list:`; div.appendChild(h2);
    if ((r.groups || []).length) r.groups.forEach((g) => div.appendChild(mkBtn('i-chat', g.name, 'group: ' + g.name, g.name)));
    else {
      const n = document.createElement('div'); n.className = 'hint';
      n.textContent = 'No group icons detected. Groups with existing chats are already in List chats above.';
      div.appendChild(n);
    }
    setStatus($('conn'), `${(r.contacts || []).length} contacts, ${(r.groups || []).length} groups. Open one, then Add it in step 3 with an instruction (required before AI replies).`, 'ok');
  } catch (e) { setStatus($('conn'), 'Failed: ' + e.message, 'err'); }
};

$('buildHere').onclick = async () => {
  await flushPendingSaves();
  setStatus($('buildStatus'), 'Reading full history step-by-step… (watch WA tab scroll)');
  try {
    const r = await sendToWA('BUILD_CONTEXT_HERE');
    setStatus($('buildStatus'), r?.ok ? `Done. ${r.scanned} msgs to context.` : 'Failed: ' + r?.error, r?.ok ? 'ok' : 'err');
    await renderRules();
  } catch (e) { setStatus($('buildStatus'), 'Failed: ' + e.message, 'err'); }
};
$('buildNamed').onclick = async () => {
  await flushPendingSaves();
  const name = $('buildName').value.trim();
  if (!name) return;
  setStatus($('buildStatus'), `Opening "${name}" and reading…`);
  try {
    const r = await sendToWA('BUILD_CONTEXT_NAMED', { name });
    setStatus($('buildStatus'), r?.ok ? `Done. ${r.chatName}: ${r.scanned} msgs.` : 'Failed: ' + r?.error, r?.ok ? 'ok' : 'err');
    await renderRules();
  } catch (e) { setStatus($('buildStatus'), 'Failed: ' + e.message, 'err'); }
};
$('buildAll').onclick = async () => {
  await flushPendingSaves();
  const { chats } = await getStore();
  const allowed = Object.entries(chats).filter(([, c]) => c.allowed).map(([, c]) => c.name).filter(Boolean);
  if (!allowed.length) { setStatus($('buildStatus'), 'No allowed chats. Allow some below first.', 'err'); return; }
  setStatus($('buildStatus'), `Building ${allowed.length} chats sequentially… keep WA tab visible`);
  for (const name of allowed) {
    setStatus($('buildStatus'), `Building "${name}"…`);
    try { await sendToWA('BUILD_CONTEXT_NAMED', { name }); }
    catch (e) { setStatus($('buildStatus'), `Failed on "${name}": ${e.message}`, 'err'); }
  }
  setStatus($('buildStatus'), 'All done.', 'ok');
  await renderRules();
};

$('addChat').onclick = async () => {
  const name = $('newChat').value.trim();
  if (!name) return;
  try {
    await flushPendingSaves();
    const { chats } = await getStore();
    // Reuse an existing rule when the name matches exactly one stored chat
    // (preserves kind: group vs 1:1). Otherwise create the base 1:1 id —
    // the content script upgrades to #group automatically when the header
    // shows a group, and the worker falls back to base for legacy installs.
    const lower = name.toLowerCase();
    const hits = Object.keys(chats).filter((id) => String(chats[id]?.name || '').toLowerCase() === lower);
    const id = hits.length === 1 ? hits[0] : 'name:' + lower;
    // Preserve everything already stored (sessions, memory, bindings) —
    // re-adding must never amputate a chat's history.
    chats[id] = {
      ...(chats[id] || {}),
      name, kind: chats[id]?.kind || (String(id).endsWith('#group') ? 'group' : 'chat'),
      allowed: true, mode: chats[id]?.mode || 'auto',
      suggestMode: chats[id]?.suggestMode || 'global',
      routeTo: chats[id]?.routeTo || 'cloud',
      cwd: chats[id]?.cwd || '',
      instruction: chats[id]?.instruction || '',
      contextMd: chats[id]?.contextMd || '',
    };
    await setChats(chats);
    $('newChat').value = '';
    await renderRules();
  } catch (e) { setStatus($('conn'), 'Failed: ' + e.message, 'err'); }
};

const ROUTE_OPTS = ['cloud', 'device:opencode', 'device:codex', 'device:claude', 'device:antigravity'];
const esc = (s) => String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Pending autosaves registry: re-rendering the list wipes textareas, so any
// destructive refresh flushes in-flight instruction edits first.
const pendingSaves = new Map();
async function flushPendingSaves() {
  const jobs = [...pendingSaves.values()];
  pendingSaves.clear();
  for (const run of jobs) {
    try { await run(); } catch {}
  }
}

async function renderRules() {
  const { chats, logs, subbots } = await getStore();
  const wrap = $('rules'); wrap.innerHTML = '';
  const sel = $('viewChat');
  const keepView = sel.value || '';
  sel.innerHTML = '';
  for (const [id, c] of Object.entries(chats)) {
    const opt = document.createElement('option');
    opt.value = id; opt.dataset.name = c.name || id;
    opt.textContent = `${c.name} (${(logs[id] || []).length} logs)`;
    if (id === keepView) opt.selected = true;
    sel.appendChild(opt);
    const initial = (c.name || '?').trim().charAt(0).toUpperCase();
    const d = document.createElement('div');
    d.className = 'rule';
    d.innerHTML = `
      <div class="rule-head">
        <span class="avatar">${esc(initial)}</span>
        <strong>${esc(c.name)}</strong>
        <span class="badge">${esc(id)}</span>
        <span class="badge">${esc(c.kind || 'chat')}</span>
        <span class="badge">${(logs[id] || []).length} logged</span>
        <span class="badge">${c.contextMsgCount ? `ctx ${c.contextMsgCount}` : 'no ctx'}</span>
        ${c.instruction?.trim() ? '' : '<span class="badge warn" data-k="nobadge">no instruction — AI blocked</span>'}
        ${c.managedBy && subbots[c.managedBy] ? `<span class="badge" data-k="managed" title="Runs: ${subbots[c.managedBy].runCount}">subbot: ${esc(subbots[c.managedBy].name)} · ${esc(subbots[c.managedBy].status)}</span>` : c.managedBy ? '<span class="badge warn" data-k="managed">subbot gone — unlink me</span>' : ''}
        <label class="switch" style="margin-left:auto" title="Allowed"><input type="checkbox" data-k="allowed" ${c.allowed ? 'checked' : ''}><span class="track"></span></label>
      </div>
      <div class="rule-grid">
        <label class="field"><span>Reply mode</span>
          <select data-k="mode">
            <option value="auto" ${c.mode === 'auto' ? 'selected' : ''}>auto-reply</option>
            <option value="manual" ${c.mode === 'manual' ? 'selected' : ''}>manual</option>
            <option value="log-only" ${c.mode === 'log-only' ? 'selected' : ''}>log-only</option>
          </select>
        </label>
        <label class="field"><span>Suggest chips</span>
          <select data-k="suggestMode" title="Inline reply chips under the last incoming message">
            <option value="global" ${(c.suggestMode || 'global') === 'global' ? 'selected' : ''}>follow global</option>
            <option value="on" ${c.suggestMode === 'on' ? 'selected' : ''}>on</option>
            <option value="off" ${c.suggestMode === 'off' ? 'selected' : ''}>off</option>
          </select>
        </label>
        <label class="field"><span>Brain</span>
          <select data-k="routeTo">${(ROUTE_OPTS.includes(c.routeTo || 'cloud') ? ROUTE_OPTS : [...ROUTE_OPTS, c.routeTo]).map((o) => `<option value="${esc(o)}" ${(c.routeTo || 'cloud') === o ? 'selected' : ''}>${esc(o)}${ROUTE_OPTS.includes(o) ? '' : ' (unknown — pick a new one)'}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Work dir</span><input data-k="cwd" placeholder="~/projects/app" value="${esc(c.cwd || '')}"></label>
      </div>
      <label class="field"><span>Instruction for this account (required — AI never replies without it)</span>
        <textarea data-k="instruction" placeholder="Tone, language, boundaries.">${esc(c.instruction || '')}</textarea>
      </label>
      <div class="rule-actions">
        <button class="btn sm primary" data-k="save"><svg class="icon"><use href="#i-save"/></svg>Save instruction</button>
        <button class="btn sm" data-k="auto" title="Draft the instruction from this chat's history + memory, then save it"><svg class="icon"><use href="#i-spark"/></svg>Auto</button>
        <span class="status" data-k="savestate" style="margin:0"></span>
        <button class="btn sm" data-k="open"><svg class="icon"><use href="#i-chat"/></svg>Open</button>
        <button class="btn sm" data-k="build"><svg class="icon"><use href="#i-scan"/></svg>Build</button>
        ${c.managedBy ? '<button class="btn sm" data-k="unlink"><svg class="icon"><use href="#i-x"/></svg>Unlink subbot</button>' : ''}
        <button class="btn sm" data-k="del"><svg class="icon"><use href="#i-x"/></svg>Delete</button>
      </div>`;
    const ta = d.querySelector('[data-k=instruction]');
    const sv = d.querySelector('[data-k=savestate]');
    const say = (msg, kind = '') => { sv.textContent = msg; sv.classList.remove('ok', 'err'); if (kind) sv.classList.add(kind); };
    const saveInstruction = async (via) => {
      try {
        await mutateChat(id, (c) => { c.instruction = ta.value.slice(0, 2000); });
        say(via === 'auto' ? 'Autosaved.' : 'Saved — applies to the next reply.', 'ok');
        // refresh only the warning badge without wiping the textarea
        const badge = d.querySelector('[data-k=nobadge]');
        if (badge) badge.style.display = ta.value.trim() ? 'none' : '';
      } catch (e) { say('Save failed: ' + e.message, 'err'); }
    };
    let deb = null;
    const arm = () => pendingSaves.set(id, async () => { clearTimeout(deb); await saveInstruction('flush'); });
    ta.addEventListener('input', () => { say('Editing…'); clearTimeout(deb); deb = setTimeout(() => { pendingSaves.delete(id); saveInstruction('auto'); }, 900); arm(); });
    ta.addEventListener('change', () => { clearTimeout(deb); pendingSaves.delete(id); saveInstruction('blur'); });
    d.querySelector('[data-k=save]').onclick = () => { clearTimeout(deb); pendingSaves.delete(id); saveInstruction('btn'); };
    d.querySelector('[data-k=auto]').onclick = async () => {
      try {
        await flushPendingSaves();
        say('Drafting instruction…');
        const hasText = ta.value.trim().length > 0;
        let overwrite = false;
        if (hasText) {
          overwrite = confirm('Replace the existing instruction with an auto-drafted one?');
          if (!overwrite) { say('Kept existing instruction.', 'ok'); return; }
        }
        const r = await chrome.runtime.sendMessage({ type: 'AUTO_INSTRUCTION', chatId: id, chatName: c.name, overwrite });
        if (!r?.ok) throw new Error(r?.error || 'auto-draft failed');
        if (r.saved) {
          ta.value = r.instruction;
          clearTimeout(deb); pendingSaves.delete(id);
          say('Auto-drafted + saved — edit freely, it autosaves.', 'ok');
          const badge = d.querySelector('[data-k=nobadge]');
          if (badge) badge.style.display = 'none';
        } else {
          say('Instruction already set — kept yours (confirm replace to overwrite).', 'ok');
        }
      } catch (e) { say('Auto failed: ' + String(e.message || e).slice(0, 160), 'err'); }
    };
    const safe = (fn) => async (e) => { try { await fn(e); } catch (err) { setStatus($('conn'), 'Failed: ' + err.message, 'err'); } };
    // NOTE: no renderRules() here — rebuilding would wipe other cards'
    // in-progress edits; nothing visual depends on these values.
    d.querySelector('[data-k=allowed]').onchange = safe(async (e) => { await mutateChat(id, (c) => { c.allowed = e.target.checked; }); });
    d.querySelector('[data-k=mode]').onchange = safe(async (e) => { await mutateChat(id, (c) => { c.mode = e.target.value; }); });
    d.querySelector('[data-k=suggestMode]').onchange = safe(async (e) => { await mutateChat(id, (c) => { c.suggestMode = e.target.value; }); });
    d.querySelector('[data-k=routeTo]').onchange = safe(async (e) => { await mutateChat(id, (c) => { c.routeTo = e.target.value; }); });
    d.querySelector('[data-k=cwd]').onchange = safe(async (e) => { await mutateChat(id, (c) => { c.cwd = e.target.value.trim(); }); });
    d.querySelector('[data-k=open]').onclick = async () => {
      try { await sendToWA('OPEN_CHAT', { name: c.name }); }
      catch (e) { setStatus($('conn'), 'Failed to open: ' + e.message, 'err'); }
    };
    d.querySelector('[data-k=build]').onclick = async () => {
      try {
        $('buildName').value = c.name;
        $('buildNamed').click();
      } catch (e) { setStatus($('buildStatus'), 'Failed: ' + e.message, 'err'); }
    };
    d.querySelector('[data-k=del]').onclick = async () => {
      try {
        if (!confirm(`Delete "${c.name}" rule + its logs and sessions? This cannot be undone.`)) return;
        await flushPendingSaves();
        const cur = await getStore();
        delete cur.chats[id];
        await setChats(cur.chats);
        renderRules();
      }
      catch (e) { setStatus($('conn'), 'Failed: ' + e.message, 'err'); }
    };
    const unb = d.querySelector('[data-k=unlink]');
    if (unb) unb.onclick = async () => {
      try {
        await flushPendingSaves();
        const { chats: allChats, subbots: allBots } = await getStore();
        if (!allBots[c.managedBy]) {
          // orphan binding (subbot deleted elsewhere): clear locally
          if (allChats[id]) { delete allChats[id].managedBy; await setChats(allChats); }
        } else {
          const r = await chrome.runtime.sendMessage({ type: 'SUBBOT_OP', op: 'unlink', id: c.managedBy });
          if (!r?.ok) throw new Error(r?.error || 'unlink failed');
        }
        setStatus($('conn'), 'Subbot unlinked (paused, instruction kept). Manage it in popup → Bots.', 'ok');
        renderRules();
      } catch (e) { setStatus($('conn'), 'Failed: ' + e.message, 'err'); }
    };
    wrap.appendChild(d);
  }
  if (!Object.keys(chats).length) wrap.innerHTML = '<div class="hint">No chats yet — List chats, then Add.</div>';
}

$('refreshView').onclick = async () => {
  const id = $('viewChat').value;
  if (!id) { $('viewer').textContent = '(no chat selected)'; return; }
  try {
    // dataset.name survives names containing ' (' — textContent splitting does not.
    const chatName = $('viewChat').selectedOptions?.[0]?.dataset?.name || id;
    const r = await chrome.runtime.sendMessage({ type: 'EXPORT_CHAT', chatId: id, chatName });
    if (!r?.ok) throw new Error(r?.error || 'export failed');
    const md = r.chat?.contextMd || '(no context yet — run Build)';
    const n = (r.logs || []).length;
    const tail = (r.logs || []).slice(-60).map((m) => `[${m.dir}${m.sessionId ? ' ' + m.sessionId : ''}] ${m.sender || ''}: ${m.text}`).join('\n');
    const sl = $('sessList'); sl.innerHTML = '';
    (r.sessions || []).slice().reverse().forEach((s) => {
      const d = document.createElement('div');
      d.className = 'agentrow';
      const dot = document.createElement('span');
      dot.className = 'dot' + (s.state === 'active' ? ' ok' : s.state === 'warning' ? ' warn' : s.state === 'full' || s.state === 'error' ? ' err' : '');
      const t = document.createElement('span');
      const when = s.startedAt ? new Date(s.startedAt).toLocaleString() : '-';
      t.textContent = `${s.id || '?'} · #${s.n ?? '—'} · ${s.state} · ${s.msgCount || 0} msgs · ctx ${s.ctx || '?'} · ${when}${s.id === r.activeSessionId ? ' · ACTIVE' : ''}${s.lastError ? ' · err: ' + s.lastError.slice(0, 80) : ''}`;
      d.appendChild(dot); d.appendChild(t); sl.appendChild(d);
    });
    if (!(r.sessions || []).length) sl.innerHTML = '<div class="hint">No sessions yet — the first AI reply opens one.</div>';
    $('viewer').textContent = `# ${r.chat?.name || chatName} — context\nupdated: ${r.chat?.contextUpdatedAt ? new Date(r.chat.contextUpdatedAt).toLocaleString() : '-'}\n\n${md}\n\n---\n## last 60/${n} logged\n${tail}`;
  } catch (e) { $('viewer').textContent = 'Failed: ' + e.message; }
};

$('newSession').onclick = async () => {
  const id = $('viewChat').value;
  if (!id) return;
  try {
    const chatName = $('viewChat').selectedOptions?.[0]?.dataset?.name || id;
    const r = await chrome.runtime.sendMessage({ type: 'NEW_SESSION', chatId: id, chatName });
    if (!r?.ok) throw new Error(r?.error || 'failed');
    $('refreshView').click();
  } catch (e) { $('viewer').textContent = 'Failed: ' + e.message; }
};
function download(filename, text, mime = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('dlCtx').onclick = async () => {
  const id = $('viewChat').value; if (!id) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'EXPORT_CHAT', chatId: id });
    if (!r?.ok) throw new Error(r?.error || 'export failed');
    download(`${r.chat?.name || id}-context.md`, r.chat?.contextMd || '');
  } catch (e) { $('viewer').textContent = 'Failed: ' + e.message; }
};
$('dlLogs').onclick = async () => {
  const id = $('viewChat').value; if (!id) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'EXPORT_CHAT', chatId: id });
    if (!r?.ok) throw new Error(r?.error || 'export failed');
    download(`${r.chat?.name || id}-logs.json`, JSON.stringify(r.logs, null, 2), 'application/json');
  } catch (e) { $('viewer').textContent = 'Failed: ' + e.message; }
};

$('devRun').onclick = async () => {
  setStatus($('devOut'), 'Running on device… (up to 3 min)');
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'DEVICE_TASK',
      agent: $('devAgent').value,
      prompt: $('devPrompt').value || 'Reply with exactly: DEVICE-OK',
      cwd: $('devCwd').value.trim(),
      timeoutMs: 180000,
    });
    setStatus($('devOut'), r?.ok ? `Reply:\n${r.reply}` : 'Failed: ' + r?.error, r?.ok ? 'ok' : 'err');
  } catch (e) { setStatus($('devOut'), 'Failed: ' + e.message, 'err'); }
};

$('fabReply').onclick = async () => {
  try { await sendToWA('MANUAL_REPLY'); } catch (e) { setStatus($('conn'), 'Failed: ' + e.message, 'err'); }
};
$('fabTop').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

(async () => {
  try {
    await applyTheme();
    watchSystem();
    await wireThemeButton($('themeBtn'));
    await renderRules();
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin', `<div class="card">Console failed to start: ${String(e.message || e).slice(0, 200)}. Reload the extension.</div>`);
  }
})();
