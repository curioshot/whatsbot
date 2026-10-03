import { PROVIDERS, DEFAULT_GLOBAL, defaultProvidersState, FALLBACK_MODELS } from '../common/providers.js';
import { modelCaps, BOT_USES, CAP_LABELS } from '../common/models.js';
import { DEVICE_AGENTS } from '../common/device.js';
import { memorySentence, chatStateSentence } from '../common/chattext.js';
import { chatIdForName } from '../common/subbots.js';
import { applyTheme, wireThemeButton, watchSystem } from '../ui/theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const numOr = (v, fb) => { const n = parseInt(String(v).trim(), 10); return Number.isFinite(n) && n >= 0 ? n : fb; };
let state = { global: { ...DEFAULT_GLOBAL }, providers: defaultProvidersState() };

function setStatus(el, msg, kind = '', action) {
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('ok', 'err');
  if (kind) el.classList.add(kind);
  const addBtn = (label, fn, primary) => {
    const b = document.createElement('button');
    b.className = 'btn sm' + (primary ? ' primary' : '');
    b.style.marginLeft = '8px';
    b.textContent = label;
    b.onclick = () => { try { fn && fn(); } catch {} };
    el.appendChild(b);
  };
  // Dismissible errors: an × clears the banner without touching settings.
  if (kind === 'err') addBtn('×', () => { el.textContent = ''; el.classList.remove('ok', 'err'); });
  if (action && action.label) addBtn(action.label, action.fn, true);
}

async function load() {
  await applyTheme();
  watchSystem();
  await wireThemeButton($('themeBtn'));
  const r = await chrome.storage.local.get(['wb_global', 'wb_providers']);
  if (r.wb_global) state.global = { ...DEFAULT_GLOBAL, ...r.wb_global, device: { ...DEFAULT_GLOBAL.device, ...(r.wb_global.device || {}) } };
  if (r.wb_providers) state.providers = { ...defaultProvidersState(), ...r.wb_providers };
  // Sanitize stored provider: garbage in storage must fall back, never kill
  // the popup (PROVIDERS[pid] undefined throws in every render path below).
  // 'device' is a valid choice (local bridge agent instead of a cloud API).
  if (state.global.activeProvider !== 'device' && !PROVIDERS[state.global.activeProvider]) state.global.activeProvider = 'openai';
  if (!state.providers[state.global.activeProvider]) state.providers = defaultProvidersState();
  $('enabled').checked = !!state.global.enabled;
  $('provider').value = state.global.activeProvider || 'openai';
  $('globalInstruction').value = state.global.globalInstruction || '';
  $('devUrl').value = state.global.device?.url || DEFAULT_GLOBAL.device.url;
  $('devToken').value = state.global.device?.token || '';
  $('routePrefix').value = state.global.routePrefix || '/code';
  $('historyLimit').value = state.global.historyLimit ?? DEFAULT_GLOBAL.historyLimit;
  $('ctxLimit').value = state.global.ctxLimitOverride ?? 0;
  try {
    const lr = $('logRetention');
    if (lr) lr.value = state.global.logRetentionDays ?? DEFAULT_GLOBAL.logRetentionDays;
    const se = $('suggestEnabled');
    if (se) se.value = state.global.suggestionsEnabled ? 'on' : 'off';
    const sc = $('suggestCount');
    if (sc) sc.value = state.global.suggestCount ?? DEFAULT_GLOBAL.suggestCount;
  } catch {}
  renderProvFields();
  renderDevice();
  paintNet();
  try {
    const u = await chrome.storage.local.get(['wb_ui']);
    if (u.wb_ui?.tab && $(u.wb_ui.tab)) showTab(u.wb_ui.tab, false);
  } catch {}
}

function paintNet() {
  const on = $('enabled').checked;
  $('netDot').className = 'dot' + (on ? ' ok' : '');
  $('netLabel').textContent = on ? 'Ready' : 'Offline';
}

function renderDevice() {
  const d = state.global.device || {};
  const dot = $('devDot');
  const agents = d.agents || [];
  const n = agents.filter((a) => a.installed).length;
  const connected = !!(d.lastSeen && n);
  dot.className = 'dot' + (connected ? ' ok' : '');
  dot.title = d.lastSeen ? `${n}/${agents.length} agents` : 'not connected';
  $('devAgents').innerHTML = agents.length
    ? agents.map((a) => `<div class="agentrow"><span class="dot ${a.installed ? 'ok' : ''}"></span><strong>${esc(a.id)}</strong><span class="hint" style="margin:0">${esc(a.version || (a.installed ? 'installed' : 'missing'))}</span></div>`).join('')
    : '<div class="hint">Press Connect Device — needs bridge running.</div>';
  // Connected state collapses credentials into a summary row (Edit to change).
  const sum = $('devSummary');
  const editing = !connected || $('devUrl')?.dataset.edit === '1';
  for (const id of ['devUrl', 'devToken', 'routePrefix']) {
    const inp = $(id)?.closest?.('.field');
    if (inp) inp.hidden = !editing;
  }
  if (sum) {
    sum.hidden = editing;
    sum.textContent = connected && !editing
      ? `Connected · ${n}/${agents.length} agents · ${d.defaultAgent || 'opencode'} answers all chats${d.useAsDefault ? '' : ' (per-chat brains only)'}`
      : '';
  }
  const eb = $('devEdit');
  if (eb) {
    eb.hidden = editing;
    eb.onclick = () => {
      for (const id of ['devUrl', 'devToken', 'routePrefix']) {
        const inp = $(id);
        if (inp) { inp.dataset.edit = '1'; inp.closest?.('.field') && (inp.closest('.field').hidden = false); }
      }
      if (sum) sum.hidden = true;
      eb.hidden = true;
    };
  }
}

function safePid() {
  const pid = $('provider')?.value;
  if (pid === 'device') return 'device';
  return PROVIDERS[pid] ? pid : 'openai';
}

// Device-as-provider panel: pick a local agent instead of a cloud API.
// Installed bridge agents first, full list as fallback (bridge offline).
function renderDeviceChoice() {
  const d = state.global.device || {};
  const installed = (d.agents || []).filter((a) => a.installed).map((a) => a.id);
  const names = [...new Set([...installed, ...DEVICE_AGENTS, d.defaultAgent || 'opencode'])];
  const cur = names.includes(d.defaultAgent) ? d.defaultAgent : names[0];
  const opts = names.map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}${installed.includes(m) ? ' (installed)' : ''}</option>`).join('');
  $('provFields').innerHTML = `
    <div class="prov"><h4>Device agent (local bridge)</h4>
    <label class="field"><span>Agent</span>
      <select id="f-agent">${opts}</select>
    </label>
    <label class="field"><span style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="f-usedef" ${d.useAsDefault ? 'checked' : ''} style="width:auto"> Answer all chats with this agent</span></label>
    <div class="hint">Chats with an explicit Brain (Chats tab) keep theirs. Needs the bridge running + token in the Device tab. Summaries and chips still use your last cloud provider.</div>
    </div>`;
  $('modelCount').textContent = d.lastSeen ? `bridge seen ${new Date(d.lastSeen).toLocaleString()}` : 'bridge not connected yet — Device tab → Connect Device';
  $('f-agent').onchange = (e) => { state.global.device = { ...(state.global.device || {}), defaultAgent: e.target.value }; renderCaps(); };
  $('f-usedef').onchange = (e) => { state.global.device = { ...(state.global.device || {}), useAsDefault: e.target.checked }; };
  renderCaps();
}

function renderProvFields() {
  const pid = safePid();
  if ($('provider')) $('provider').value = pid;
  if (pid === 'device') return renderDeviceChoice();
  const def = PROVIDERS[pid];
  const cfg = state.providers[pid] || defaultProvidersState()[pid];
  const cached = (cfg.modelsCache && cfg.modelsCache.length ? cfg.modelsCache : FALLBACK_MODELS[pid] || []);
  const cur = cfg.model || def.model;
  const opts = [...new Set([cur, ...cached])].map((m) => `<option value="${esc(m)}" ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('');
  $('provFields').innerHTML = `
    <div class="prov"><h4>${esc(def.label)}</h4>
    <label class="field"><span>Base URL</span><input type="text" id="f-base" value="${esc(cfg.baseUrl || def.baseUrl)}"></label>
    <label class="field"><span>Model — ${cached.length} known</span>
      <select id="f-model-sel">${opts}</select>
      <input type="text" id="f-model" value="${esc(cur)}" placeholder="type or pick model id" style="margin-top:6px">
    </label>
    <label class="field"><span>API key ${def.needsKey ? '' : '(optional for local)'}</span><input type="password" id="f-key" placeholder="${def.needsKey ? 'sk-...' : 'leave empty if none'}" value="${esc(cfg.apiKey || '')}"></label>
    <div class="hint">Fetch Models calls live <span class="mono">/models</span> (Anthropic: <span class="mono">/models?limit=100</span>; local also tries Ollama <span class="mono">/api/tags</span>).</div>
    </div>`;
  $('modelCount').textContent = cached.length ? `${def.label}: ${cached.length} models known${cfg.modelsFetchedAt ? ' (fetched ' + new Date(cfg.modelsFetchedAt).toLocaleString() + ')' : ' (curated list — press Models)'}` : '';
  $('f-base').oninput = (e) => (state.providers[pid].baseUrl = e.target.value.trim());
  $('f-key').oninput = (e) => (state.providers[pid].apiKey = e.target.value.trim());
  $('f-model').oninput = (e) => {
    state.providers[pid].model = e.target.value.trim();
    $('f-model-sel').value = state.providers[pid].model;
    renderCaps();
  };
  $('f-model-sel').onchange = (e) => {
    state.providers[pid].model = e.target.value;
    $('f-model').value = e.target.value;
    renderCaps();
  };
  renderCaps();
}

function renderCaps() {
  const pid = safePid();
  if (pid === 'device') {
    const agent = state.global.device?.defaultAgent || 'opencode';
    $('caps').innerHTML = `<span class="cap on"><svg class="icon"><use href="#i-check"/></svg>agent: ${esc(agent)}</span>`;
    $('capsNote').textContent = `${agent}: runs tools on your machine via the bridge (work-dir allowlist applies). Bot pipeline: text only.`;
    return;
  }
  const model = (state.providers[pid]?.model || '').trim();
  const caps = modelCaps(pid, model);
  $('caps').innerHTML = CAP_LABELS.map(([k, label]) =>
    `<span class="cap ${caps[k] ? 'on' : 'off'}"><svg class="icon"><use href="#${caps[k] ? 'i-check' : 'i-x'}"/></svg>${label}</span>`
  ).join('');
  const srcNote = caps.source === 'known' ? 'from capability table' : caps.source === 'guess' ? 'not in table — text assumed, verify media support' : 'enter a model first';
  const botNote = 'Bot pipeline today: text only (voice notes / photos cannot be read yet).';
  $('capsNote').textContent = `${model || '(no model)'}: ${srcNote}. ${botNote}`;
}

// tabs (null-safe: a renamed pane id must not kill the whole popup).
// The last open tab is remembered across popup opens (wb_ui, UI-only key).
const TABS = [['tabModel', 'paneModel'], ['tabDevice', 'paneDevice'], ['tabChats', 'paneChats'], ['tabHistory', 'paneHistory'], ['tabBots', 'paneBots'], ['tabPolicy', 'panePolicy']];
function showTab(pane, save = true) {
  for (const [b] of TABS) $(b)?.classList.remove('active');
  for (const [, p] of TABS) { const el = $(p); if (el) el.hidden = true; }
  const btn = TABS.find(([, p]) => p === pane)?.[0];
  if (btn) $(btn)?.classList.add('active');
  const pel = $(pane);
  if (pel) pel.hidden = false;
  if (pane === 'paneBots') refreshSubbots();
  if (pane === 'paneChats') renderChatRows().catch(() => {});
  if (pane === 'paneHistory') renderHistory().catch(() => {});
  if (save) { try { chrome.storage.local.set({ wb_ui: { tab: pane } }); } catch {} }
}
for (const [btn, pane] of TABS) {
  const be = $(btn), pe = $(pane);
  if (!be || !pe) continue;
  be.addEventListener('click', () => showTab(pane));
}
$('provider')?.addEventListener('change', renderProvFields);

$('confirmStart').onclick = async () => {
  try {
    await collectAndSave();
    const pid = state.global.activeProvider;
    if (pid === 'device') {
      // Same gate as cloud: probe the bridge, enable only on success.
      const agent = state.global.device?.defaultAgent || 'opencode';
      setStatus($('status'), `Probing bridge for ${agent}…`);
      const t = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
      if (!t?.ok) {
        setStatus($('status'), `Bridge test failed: ${t?.error} — bot NOT started.`, 'err');
        return;
      }
      state.global.enabled = true;
      $('enabled').checked = true;
      await chrome.storage.local.set({ wb_global: state.global });
      paintNet();
      setStatus($('status'), `Bot started with device agent ${agent} (${t.reply}). Chats with an explicit Brain keep theirs.`, 'ok');
      return;
    }
    const def = PROVIDERS[pid];
    const cfg = state.providers[pid];
    if (def.needsKey && !cfg.apiKey) {
      setStatus($('status'), `Add your ${def.label} API key first.`, 'err');
      return;
    }
    if (!cfg.model?.trim()) {
      setStatus($('status'), 'Pick a model first (or press Models to fetch the list).', 'err');
      return;
    }
    setStatus($('status'), `Testing ${cfg.model}…`);
    const t = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (!t?.ok) {
      setStatus($('status'), `Model test failed: ${t?.error} — bot NOT started.`, 'err');
      return;
    }
    state.global.enabled = true;
    $('enabled').checked = true;
    await chrome.storage.local.set({ wb_global: state.global });
    paintNet();
    const caps = modelCaps(pid, cfg.model);
    const media = ['image', 'audio', 'video'].filter((k) => caps[k]).join('/') || 'text-only';
    setStatus($('status'), `Bot started with ${cfg.model} (${media}). Allowed chats only, text pipeline — media is not read.`, 'ok');
  } catch (e) { setStatus($('status'), 'Failed: ' + e.message, 'err'); }
};
$('enabled').addEventListener('change', async () => {
  try {
    if ($('enabled').checked) {
      // Same gate as Confirm & Start: never enable on a failing model.
      await collectAndSave();
      const pid = state.global.activeProvider;
      if (pid === 'device') {
        setStatus($('status'), 'Probing bridge before enabling…');
        const t = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
        if (!t?.ok) {
          $('enabled').checked = false;
          state.global.enabled = false;
          await chrome.storage.local.set({ wb_global: state.global });
          paintNet();
          setStatus($('status'), `Bridge test failed: ${t?.error} — bot NOT enabled.`, 'err');
          return;
        }
        setStatus($('status'), `Bot enabled with device agent ${state.global.device?.defaultAgent || 'opencode'}.`, 'ok');
      } else {
      const def = PROVIDERS[pid];
      const cfg = state.providers[pid];
      if (def.needsKey && !cfg.apiKey) {
        $('enabled').checked = false;
        state.global.enabled = false;
        await chrome.storage.local.set({ wb_global: state.global });
        paintNet();
        setStatus($('status'), `Add your ${def.label} API key first — bot NOT enabled.`, 'err');
        return;
      }
      setStatus($('status'), `Testing ${cfg.model} before enabling…`);
      const t = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
      if (!t?.ok) {
        $('enabled').checked = false;
        state.global.enabled = false;
        await chrome.storage.local.set({ wb_global: state.global });
        paintNet();
        setStatus($('status'), `Model test failed: ${t?.error} — bot NOT enabled.`, 'err');
        return;
      }
      setStatus($('status'), `Bot enabled with ${cfg.model}.`, 'ok');
      }
    }
    paintNet(); await collectAndSave();
  } catch (e) { setStatus($('status'), 'Failed: ' + e.message, 'err'); }
});

async function collectAndSave() {
  state.global.enabled = $('enabled').checked;
  state.global.activeProvider = $('provider').value;
  // Stash the last cloud pick: helper jobs (summaries, chips) use it while
  // the reply default is a device agent.
  if (state.global.activeProvider !== 'device' && PROVIDERS[state.global.activeProvider]) {
    state.global.prevCloudProvider = state.global.activeProvider;
  }
  state.global.globalInstruction = $('globalInstruction').value;
  state.global.device = {
    ...(state.global.device || {}),
    url: $('devUrl').value.trim() || DEFAULT_GLOBAL.device.url,
    token: $('devToken').value.trim(),
  };
  // Device-as-provider panel fields (present only when that entry is shown).
  const fa = $('f-agent');
  if (fa && fa.value) state.global.device.defaultAgent = fa.value;
  const fu = $('f-usedef');
  if (fu) state.global.device.useAsDefault = fu.checked;
  state.global.routePrefix = $('routePrefix').value.trim() || '/code';
  state.global.historyLimit = numOr($('historyLimit').value, DEFAULT_GLOBAL.historyLimit);
  state.global.ctxLimitOverride = numOr($('ctxLimit').value, 0);
  try {
    const el = $('logRetention');
    if (el) {
      const n = parseInt(String(el.value).trim(), 10);
      state.global.logRetentionDays = Number.isFinite(n) && n >= 0 ? Math.min(n, 365) : DEFAULT_GLOBAL.logRetentionDays;
    }
    const se = $('suggestEnabled');
    if (se) state.global.suggestionsEnabled = se.value === 'on';
    const sc = $('suggestCount');
    if (sc) {
      const n = parseInt(String(sc.value).trim(), 10);
      state.global.suggestCount = Number.isFinite(n) ? Math.min(Math.max(n, 2), 3) : DEFAULT_GLOBAL.suggestCount;
    }
  } catch {}
  await chrome.storage.local.set({ wb_global: state.global, wb_providers: state.providers });
}

$('save').onclick = async () => {
  await collectAndSave();
  setStatus($('status'), 'Saved.', 'ok');
};

$('fetchModels').onclick = async () => {
  await collectAndSave();
  const pid = $('provider').value;
  const isDev = pid === 'device';
  setStatus($('status'), `Fetching ${(isDev ? { label: 'device agents' } : PROVIDERS[pid]).label}…`);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'LIST_MODELS', provider: pid });
    if (!r?.ok) throw new Error(r?.error || 'fetch failed');
    const s = await chrome.storage.local.get(['wb_providers']);
    if (s.wb_providers) state.providers = { ...defaultProvidersState(), ...s.wb_providers };
    const list = r.models || [];
    // Preserve the user's choice: never auto-switch it to a list head.
    const cur = isDev ? (state.global.device?.defaultAgent || 'opencode') : state.providers[pid].model;
    let note = '';
    if (list.length && !list.includes(cur)) {
      note = isDev
        ? ` Current "${cur}" not installed — kept. Install it or pick from the dropdown.`
        : ` Current "${cur}" not in live list — kept. Pick from the dropdown if you want to switch.`;
    }
    renderProvFields();
    setStatus($('status'), `${list.length} models (${r.source}).${note}`, 'ok');
  } catch (e) {
    setStatus($('status'), 'Failed: ' + e.message, 'err');
  }
};

$('test').onclick = async () => {
  try {
    await collectAndSave();
    setStatus($('status'), 'Testing…');
    const r = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    setStatus($('status'), r?.ok ? `Connected. Reply: ${String(r.reply).slice(0, 120)}` : `Failed: ${r?.error}`, r?.ok ? 'ok' : 'err');
  } catch (e) { setStatus($('status'), 'Failed: ' + e.message, 'err'); }
};

$('devConnect').onclick = async () => {
  await collectAndSave();
  setStatus($('devStatus'), 'Probing bridge… (is node bridge.mjs running?)');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DEVICE_PROBE', url: $('devUrl').value.trim(), token: $('devToken').value.trim() });
    if (!r?.ok) throw new Error(r?.error || 'probe failed');
    const s = await chrome.storage.local.get(['wb_global']);
    state.global = { ...DEFAULT_GLOBAL, ...(s.wb_global || {}), device: { ...DEFAULT_GLOBAL.device, ...((s.wb_global || {}).device || {}) } };
    renderDevice();
    const n = (r.agents || []).filter((a) => a.installed).length;
    setStatus($('devStatus'), `Connected. ${n}/${r.agents.length} agents installed.`, 'ok');
    // Collapse credentials back into the summary row after connecting.
    for (const id of ['devUrl', 'devToken', 'routePrefix']) { try { delete $(id)?.dataset.edit; } catch {} }
    renderDevice();
  } catch (e) {
    setStatus($('devStatus'), 'Failed: ' + e.message, 'err', { label: 'Retry', fn: () => $('devConnect')?.click() });
  }
};

$('devTest').onclick = async () => {
  await collectAndSave();
  setStatus($('devStatus'), 'Sending test task…');
  try {
    const s = await chrome.storage.local.get(['wb_global']);
    const agents = s.wb_global?.device?.agents || [];
    const agent = (agents.find((a) => a.installed) || { id: 'opencode' }).id;
    const r = await chrome.runtime.sendMessage({ type: 'DEVICE_TASK', agent, prompt: 'Reply with exactly: DEVICE-OK', timeoutMs: 120000 });
    setStatus($('devStatus'), r?.ok ? `${agent}: ${String(r.reply).slice(0, 200)}` : 'Failed: ' + r?.error, r?.ok ? 'ok' : 'err');
  } catch (e) {
    setStatus($('devStatus'), 'Failed: ' + e.message, 'err');
  }
};

// ---------- Chats tab (plain-words rules: tick, teach, saving teaches) ----------
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
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/content/whatsapp-dom.js', 'src/content/content.js'],
    });
    await new Promise((r) => setTimeout(r, 1500));
    try {
      return await chrome.tabs.sendMessage(tab.id, { type, ...extra });
    } catch {
      throw new Error('WhatsApp tab still not responding. Hard-reload it, wait for the floating button, then retry.');
    }
  }
}

async function renderChatRows() {
  const box = $('chatRows');
  if (!box) return;
  const r = await chrome.storage.local.get(['wb_chats', 'wb_logs', 'wb_global']);
  const chats = r.wb_chats || {};
  const logs = r.wb_logs || {};
  const enabled = !!r.wb_global?.enabled;
  box.innerHTML = '';
  const ids = Object.keys(chats);
  if (!ids.length) {
    box.innerHTML = '<div class="hint">No chats yet — press Find WhatsApp chats, tick the ones you want.</div>';
    return;
  }
  for (const id of ids) {
    const c = chats[id] || {};
    const card = document.createElement('div');
    card.className = 'card';
    card.style.margin = '8px 0 0';
    const head = document.createElement('div');
    head.className = 'row';
    const name = document.createElement('strong');
    name.textContent = c.name || id;
    const st = document.createElement('span');
    st.className = 'hint';
    st.style.margin = '0';
    st.textContent = ` · ${chatStateSentence(c, enabled)}`;
    const sw = document.createElement('label');
    sw.className = 'switch';
    sw.style.marginLeft = 'auto';
    sw.title = 'Let the bot answer this chat';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!c.allowed;
    cb.onchange = async () => {
      try {
        const s = await chrome.storage.local.get(['wb_chats']);
        const all = s.wb_chats || {};
        if (!all[id]) throw new Error('Chat is gone — refresh.');
        all[id].allowed = cb.checked;
        await chrome.storage.local.set({ wb_chats: all });
        st.textContent = ` · ${chatStateSentence(all[id], enabled)}`;
      } catch (e) { setStatus($('chatsStatus'), 'Failed: ' + e.message, 'err'); cb.checked = !cb.checked; }
    };
    const track = document.createElement('span');
    track.className = 'track';
    sw.appendChild(cb); sw.appendChild(track);
    head.appendChild(name); head.appendChild(st); head.appendChild(sw);
    const mem = document.createElement('div');
    mem.className = 'hint';
    mem.textContent = memorySentence(c, (logs[id] || []).length);
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'How should it behave here? e.g. reply short, same language.';
    ta.value = c.instruction || '';
    const row2 = document.createElement('div');
    row2.className = 'row';
    row2.style.marginTop = '6px';
    const save = document.createElement('button');
    save.className = 'btn sm primary';
    save.textContent = 'Save — teaches it';
    const sg = document.createElement('select');
    sg.title = 'Inline reply chips for this chat';
    for (const [v, label] of [['global', 'chips: follow global'], ['on', 'chips: on'], ['off', 'chips: off']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      if ((c.suggestMode || 'global') === v) o.selected = true;
      sg.appendChild(o);
    }
    sg.onchange = async () => {
      try {
        const s = await chrome.storage.local.get(['wb_chats']);
        const all = s.wb_chats || {};
        if (!all[id]) throw new Error('Chat is gone — refresh.');
        all[id].suggestMode = sg.value;
        await chrome.storage.local.set({ wb_chats: all });
      } catch (e) { setStatus($('chatsStatus'), 'Failed: ' + e.message, 'err'); }
    };
    const sst = document.createElement('span');
    sst.className = 'hint';
    sst.style.margin = '0';
    save.onclick = async () => {
      try {
        sst.textContent = 'Saving…';
        const s = await chrome.storage.local.get(['wb_chats']);
        const all = s.wb_chats || {};
        if (!all[id]) throw new Error('Chat is gone — refresh.');
        all[id].instruction = ta.value.slice(0, 2000).trim();
        await chrome.storage.local.set({ wb_chats: all });
        // Teach = instruction + memory in one press: learn past messages
        // automatically when this chat has no memory yet.
        if (!all[id].contextMd) {
          sst.textContent = 'Learning past messages… (opens the chat briefly)';
          const b = await sendToWA('BUILD_CONTEXT_NAMED', { name: all[id].name });
          if (!b?.ok) throw new Error(b?.error || 'learning failed');
          const s2 = await chrome.storage.local.get(['wb_chats', 'wb_logs']);
          Object.assign(all, s2.wb_chats || {});
          Object.assign(logs, s2.wb_logs || {});
        }
        mem.textContent = memorySentence(all[id], (logs[id] || []).length);
        st.textContent = ` · ${chatStateSentence(all[id], enabled)}`;
        sst.textContent = 'Saved.';
      } catch (e) { sst.textContent = 'Failed: ' + e.message; }
    };
    row2.appendChild(sg); row2.appendChild(save); row2.appendChild(sst);
    const adv = document.createElement('div');
    adv.className = 'row';
    adv.style.marginTop = '6px';
    const brain = document.createElement('select');
    brain.title = 'Brain: cloud reply or on-device agent';
    for (const o of ['cloud', 'device:opencode', 'device:codex', 'device:claude', 'device:antigravity']) {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if ((c.routeTo || 'cloud') === o) opt.selected = true;
      brain.appendChild(opt);
    }
    brain.onchange = async () => {
      try {
        const s = await chrome.storage.local.get(['wb_chats']);
        const all = s.wb_chats || {};
        if (!all[id]) throw new Error('Chat is gone — refresh.');
        all[id].routeTo = brain.value;
        await chrome.storage.local.set({ wb_chats: all });
      } catch (e) { setStatus($('chatsStatus'), 'Failed: ' + e.message, 'err'); }
    };
    const cwd = document.createElement('input');
    cwd.placeholder = 'Work dir (device chats)';
    cwd.style.flex = '1'; cwd.style.minWidth = '0';
    cwd.value = c.cwd || '';
    cwd.onchange = async () => {
      try {
        const s = await chrome.storage.local.get(['wb_chats']);
        const all = s.wb_chats || {};
        if (!all[id]) throw new Error('Chat is gone — refresh.');
        all[id].cwd = cwd.value.trim();
        await chrome.storage.local.set({ wb_chats: all });
      } catch (e) { setStatus($('chatsStatus'), 'Failed: ' + e.message, 'err'); }
    };
    adv.appendChild(brain); adv.appendChild(cwd);
    card.appendChild(head); card.appendChild(mem); card.appendChild(ta); card.appendChild(row2); card.appendChild(adv);
    box.appendChild(card);
  }
}

$('chatsRefresh')?.addEventListener('click', async () => {
  try {
    setStatus($('chatsStatus'), 'Reading WhatsApp chats…');
    const r = await sendToWA('LIST_CHATS');
    const found = r.chats || [];
    if (!found.length) { setStatus($('chatsStatus'), 'No chats found — open a conversation in WhatsApp first.', 'err'); return; }
    const s = await chrome.storage.local.get(['wb_chats']);
    const all = s.wb_chats || {};
    let added = 0;
    for (const c of found) {
      if (!c.name) continue;
      const id = chatIdForName(c.name, c.kind);
      if (!all[id]) {
        all[id] = { name: c.name, kind: c.kind || 'chat', allowed: false, mode: 'auto', suggestMode: 'global', routeTo: 'cloud', cwd: '', instruction: '', contextMd: '' };
        added++;
      }
    }
    await chrome.storage.local.set({ wb_chats: all });
    await renderChatRows();
    setStatus($('chatsStatus'), `Found ${found.length} chats${added ? `, ${added} new (tick to allow)` : ''}.`, 'ok');
  } catch (e) { setStatus($('chatsStatus'), 'Failed: ' + e.message, 'err'); }
});
$('chatsAllowAll')?.addEventListener('click', async () => {
  try {
    const s = await chrome.storage.local.get(['wb_chats']);
    const all = s.wb_chats || {};
    for (const c of Object.values(all)) c.allowed = true;
    await chrome.storage.local.set({ wb_chats: all });
    await renderChatRows();
    setStatus($('chatsStatus'), 'All chats ticked. Teach the ones missing instructions.', 'ok');
  } catch (e) { setStatus($('chatsStatus'), 'Failed: ' + e.message, 'err'); }
});

// ---------- History tab (past conversations, memory, sessions) ----------
let histLast = null;
async function renderHistory() {
  const sel = $('histChat');
  if (!sel) return;
  const s = await chrome.storage.local.get(['wb_chats']);
  const chats = s.wb_chats || {};
  const keep = sel.value || '';
  sel.innerHTML = '';
  for (const [id, c] of Object.entries(chats)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = c.name || id;
    if (id === keep) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!Object.keys(chats).length) {
    $('histView').textContent = 'No chats yet — find some in the Chats tab first.';
    return;
  }
  await loadHistory();
}
async function loadHistory() {
  const id = $('histChat')?.value;
  const view = $('histView');
  if (!id) { if (view) view.textContent = '(no chat selected)'; return; }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'EXPORT_CHAT', chatId: id });
    if (!r?.ok) throw new Error(r?.error || 'export failed');
    histLast = r;
    const dirF = $('histDir')?.value || '';
    const q = ($('histQ')?.value || '').trim().toLowerCase();
    let entries = r.logs || [];
    if (dirF) entries = entries.filter((m) => m.dir === dirF);
    if (q) entries = entries.filter((m) => `${m.sender || ''} ${m.text || ''}`.toLowerCase().includes(q));
    const sl = $('histSessions');
    if (sl) {
      sl.innerHTML = '';
      for (const sess of (r.sessions || []).slice().reverse()) {
        const d = document.createElement('div');
        d.className = 'hint';
        d.textContent = `#${sess.n ?? '—'} · ${sess.state} · ${sess.msgCount || 0} msgs · ctx ${sess.ctx || '?'}${sess.id === r.activeSessionId ? ' · current' : ''}`;
        sl.appendChild(d);
      }
      if (!(r.sessions || []).length) sl.innerHTML = '<div class="hint">No sessions yet — the first reply opens one.</div>';
    }
    const md = r.chat?.contextMd || '(no memory yet — teach it in the Chats tab)';
    const tail = entries.slice(-60).map((m) => `[${m.dir}] ${m.sender || ''}: ${m.text}`).join('\n') || '(no entries match)';
    if (view) view.textContent = `${r.chat?.name || id}\n\n${md}\n\n---\nlast ${Math.min(60, entries.length)}/${(r.logs || []).length}${(dirF || q) ? ' (filtered)' : ''}\n${tail}`;
  } catch (e) { if (view) view.textContent = 'Failed: ' + e.message; }
}
function downloadFile(filename, text, mime = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('histRefresh')?.addEventListener('click', () => renderHistory().catch((e) => setStatus($('histStatus'), 'Failed: ' + e.message, 'err')));
$('histDir')?.addEventListener('change', () => loadHistory().catch(() => {}));
$('histQ')?.addEventListener('input', () => loadHistory().catch(() => {}));
$('histNew')?.addEventListener('click', async () => {
  try {
    const id = $('histChat')?.value;
    if (!id) return;
    const r = await chrome.runtime.sendMessage({ type: 'NEW_SESSION', chatId: id });
    if (!r?.ok) throw new Error(r?.error || 'failed');
    await loadHistory();
    setStatus($('histStatus'), 'New session opened.', 'ok');
  } catch (e) { setStatus($('histStatus'), 'Failed: ' + e.message, 'err'); }
});
$('histMd')?.addEventListener('click', async () => {
  try {
    const id = $('histChat')?.value;
    if (!id) return;
    const r = await chrome.runtime.sendMessage({ type: 'EXPORT_CHAT', chatId: id });
    if (!r?.ok) throw new Error(r?.error || 'export failed');
    downloadFile(`${r.chat?.name || id}-context.md`, r.chat?.contextMd || '');
  } catch (e) { setStatus($('histStatus'), 'Failed: ' + e.message, 'err'); }
});
$('histJson')?.addEventListener('click', async () => {
  try {
    const id = $('histChat')?.value;
    if (!id) return;
    const r = await chrome.runtime.sendMessage({ type: 'EXPORT_CHAT', chatId: id });
    if (!r?.ok) throw new Error(r?.error || 'export failed');
    downloadFile(`${r.chat?.name || id}-logs.json`, JSON.stringify(r.logs, null, 2), 'application/json');
  } catch (e) { setStatus($('histStatus'), 'Failed: ' + e.message, 'err'); }
});

// ---------- Device bench (try an agent without touching any chat) ----------
$('benchRun')?.addEventListener('click', async () => {
  const btn = $('benchRun');
  try {
    if (btn) btn.disabled = true;
    setStatus($('benchOut'), 'Running… (up to 3 min)');
    const r = await chrome.runtime.sendMessage({
      type: 'DEVICE_TASK',
      agent: $('benchAgent')?.value || 'opencode',
      prompt: $('benchPrompt')?.value || 'Reply with exactly: DEVICE-OK',
      cwd: $('benchCwd')?.value.trim() || '',
      timeoutMs: 180000,
    });
    // Bench runs have no chat, so the worker's chat gates don't apply —
    // the sender allowlist still does (extension pages only).
    setStatus($('benchOut'), r?.ok ? `Reply:\n${String(r.reply).slice(0, 1500)}` : 'Failed: ' + r?.error, r?.ok ? 'ok' : 'err');
  } catch (e) { setStatus($('benchOut'), 'Failed: ' + e.message, 'err'); }
  finally { try { if (btn) btn.disabled = false; } catch {} }
});

// ---------- subbots (status mirror — full control lives in the WhatsApp dock) ----------
async function refreshSubbots() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'SUBBOT_LIST' });
    const bots = r?.subbots || [];
    const running = bots.filter((b) => b.kind === 'watch' && b.status === 'running');
    const dot = $('botsDot');
    dot.className = 'dot' + (running.length ? ' ok' : bots.some((b) => b.status === 'paused') ? ' warn' : '');
    $('botsMini').textContent = running.length
      ? `${running.length} watching: ${running.slice(0, 3).map((b) => b.target).join(', ')}${running.length > 3 ? '…' : ''}`
      : bots.length ? `${bots.length} subbot(s), none watching.` : 'No subbots yet — launch one from the WhatsApp dock.';
  } catch (e) {
    setStatus($('subStatus'), 'Failed: ' + e.message, 'err');
  }
}

$('openDock').onclick = async () => {
  try {
    const tabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
    if (!tabs.length) { setStatus($('subStatus'), 'Open web.whatsapp.com first.', 'err'); return; }
    const tab = tabs[0];
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    window.close();
  } catch (e) { setStatus($('subStatus'), 'Failed: ' + e.message, 'err'); }
};

$('openPanel').onclick = async () => {
  // The old sidepanel console is gone — its Chats live in the Chats tab now.
  showTab('paneChats');
};

try {
  load().catch((e) => {
    document.body.insertAdjacentHTML('afterbegin', `<div class="card">Popup failed to start: ${String(e.message || e).slice(0, 160)}</div>`);
  });
} catch (e) {
  document.body.insertAdjacentHTML('afterbegin', `<div class="card">Popup failed to start: ${String(e.message || e).slice(0, 160)}</div>`);
}
