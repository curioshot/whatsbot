import { PROVIDERS, DEFAULT_GLOBAL, defaultProvidersState, FALLBACK_MODELS } from '../common/providers.js';
import { modelCaps, BOT_USES, CAP_LABELS } from '../common/models.js';
import { applyTheme, wireThemeButton, watchSystem } from '../ui/theme.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const numOr = (v, fb) => { const n = parseInt(String(v).trim(), 10); return Number.isFinite(n) && n >= 0 ? n : fb; };
let state = { global: { ...DEFAULT_GLOBAL }, providers: defaultProvidersState() };

function setStatus(el, msg, kind = '') {
  el.textContent = msg;
  el.classList.remove('ok', 'err');
  if (kind) el.classList.add(kind);
}

async function load() {
  await applyTheme();
  watchSystem();
  await wireThemeButton($('themeBtn'));
  const r = await chrome.storage.local.get(['wb_global', 'wb_providers']);
  if (r.wb_global) state.global = { ...DEFAULT_GLOBAL, ...r.wb_global, device: { ...DEFAULT_GLOBAL.device, ...(r.wb_global.device || {}) } };
  if (r.wb_providers) state.providers = { ...defaultProvidersState(), ...r.wb_providers };
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
  dot.className = 'dot' + (d.lastSeen && n ? ' ok' : '');
  dot.title = d.lastSeen ? `${n}/${agents.length} agents` : 'not connected';
  $('devAgents').innerHTML = agents.length
    ? agents.map((a) => `<div class="agentrow"><span class="dot ${a.installed ? 'ok' : ''}"></span><strong>${esc(a.id)}</strong><span class="hint" style="margin:0">${esc(a.version || (a.installed ? 'installed' : 'missing'))}</span></div>`).join('')
    : '<div class="hint">Press Connect Device — needs bridge running.</div>';
}

function renderProvFields() {
  const pid = $('provider').value;
  const def = PROVIDERS[pid];
  const cfg = state.providers[pid];
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
  const pid = $('provider').value;
  const model = (state.providers[pid]?.model || '').trim();
  const caps = modelCaps(pid, model);
  $('caps').innerHTML = CAP_LABELS.map(([k, label]) =>
    `<span class="cap ${caps[k] ? 'on' : 'off'}"><svg class="icon"><use href="#${caps[k] ? 'i-check' : 'i-x'}"/></svg>${label}</span>`
  ).join('');
  const srcNote = caps.source === 'known' ? 'from capability table' : caps.source === 'guess' ? 'not in table — text assumed, verify media support' : 'enter a model first';
  const botNote = 'Bot pipeline today: text only (voice notes / photos cannot be read yet).';
  $('capsNote').textContent = `${model || '(no model)'}: ${srcNote}. ${botNote}`;
}

// tabs
const TABS = [['tabModel', 'paneModel'], ['tabDevice', 'paneDevice'], ['tabBots', 'paneBots'], ['tabPolicy', 'panePolicy']];
for (const [btn, pane] of TABS) {
  $(btn).addEventListener('click', () => {
    for (const [b] of TABS) $(b).classList.remove('active');
    for (const [, p] of TABS) $(p).hidden = true;
    $(btn).classList.add('active');
    $(pane).hidden = false;
    if (pane === 'paneBots') refreshSubbots();
  });
}
$('provider').addEventListener('change', renderProvFields);

$('confirmStart').onclick = async () => {
  try {
    await collectAndSave();
    const pid = state.global.activeProvider;
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
    setStatus($('status'), `Bot started with ${cfg.model} (${media}). Reply scope: allowed chats only.`, 'ok');
  } catch (e) { setStatus($('status'), 'Failed: ' + e.message, 'err'); }
};
$('enabled').addEventListener('change', async () => {
  try {
    if ($('enabled').checked) {
      // Same gate as Confirm & Start: never enable on a failing model.
      await collectAndSave();
      const pid = state.global.activeProvider;
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
    paintNet(); await collectAndSave();
  } catch (e) { setStatus($('status'), 'Failed: ' + e.message, 'err'); }
});

async function collectAndSave() {
  state.global.enabled = $('enabled').checked;
  state.global.activeProvider = $('provider').value;
  state.global.globalInstruction = $('globalInstruction').value;
  state.global.device = {
    ...(state.global.device || {}),
    url: $('devUrl').value.trim() || DEFAULT_GLOBAL.device.url,
    token: $('devToken').value.trim(),
  };
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
  setStatus($('status'), `Fetching ${PROVIDERS[pid].label} models…`);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'LIST_MODELS', provider: pid });
    if (!r?.ok) throw new Error(r?.error || 'fetch failed');
    const s = await chrome.storage.local.get(['wb_providers']);
    if (s.wb_providers) state.providers = { ...defaultProvidersState(), ...s.wb_providers };
    const list = r.models || [];
    // Preserve the user's model choice: a sorted live list's first entry is
    // almost never what they want (e.g. dall-e on OpenAI). Only note it.
    let note = '';
    if (list.length && !list.includes(state.providers[pid].model)) {
      note = ` Current "${state.providers[pid].model}" not in live list — kept. Pick from the dropdown if you want to switch.`;
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
  } catch (e) {
    setStatus($('devStatus'), 'Failed: ' + e.message, 'err');
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
  // Resolve a real window id first: WINDOW_ID_CURRENT (-2) is rejected by
  // sidePanel.open on some Chrome builds (uncaught error on Errors page).
  try {
    if (chrome.sidePanel) {
      const w = await chrome.windows.getLastFocused();
      if (w?.id != null) await chrome.sidePanel.open({ windowId: w.id });
    }
  } catch {}
  chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/sidepanel.html') });
};

try {
  load().catch((e) => {
    document.body.insertAdjacentHTML('afterbegin', `<div class="card">Popup failed to start: ${String(e.message || e).slice(0, 160)}</div>`);
  });
} catch (e) {
  document.body.insertAdjacentHTML('afterbegin', `<div class="card">Popup failed to start: ${String(e.message || e).slice(0, 160)}</div>`);
}
