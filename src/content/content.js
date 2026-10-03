/* WhatsBot content script — runs inside web.whatsapp.com
   Responsibilities: read chats, switch chats, step-by-step full-history scan,
   observe new messages, send replies. Brain (LLM) lives in background worker. */
(() => {
  // Build stamp — shown tiny in the dock head. Single source: the manifest
  // version (bump manifest.json per release). If a fix "doesn't work",
  // compare this stamp: stale tabs keep showing the old one.
  let CODE_VERSION = 'dev';
  try { CODE_VERSION = chrome.runtime.getManifest().version || 'dev'; } catch {}
  // Single-execution guard: manifest injection + programmatic re-inject (the
  // console's stale-tab recovery) must never run two observers — that would
  // double-fire auto-replies. First instance wins; full tab reload picks up
  // newer code after an extension update.
  if (window.__wbLoaded) return;
  window.__wbLoaded = true;
  window.__wbVersion = CODE_VERSION;
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));
  const rand = (a, b) => {
    a = +a || 0; b = +b || 0;
    if (b < a) [a, b] = [b, a];
    return a + Math.random() * (b - a);
  };
  const seenMsgIds = new Set();
  const pendingIncoming = new Map(); // chatKey -> {chatId, chatName, msgs:[], timer}
  let storeCache = { global: {}, chats: {}, subbots: {} };
  let floatingPanel = null;

  // Hygiene: the page context keeps NO secrets — only a boolean per provider
  // (has key?) for the onboarding checklist. Full provider objects (with API
  // keys) never leave extension storage into page memory.
  function hasKeyMap(providers, activePid) {
    const out = {};
    for (const [pid, cfg] of Object.entries(providers || {})) out[pid] = !!(cfg && cfg.apiKey);
    out._active = activePid || 'openai';
    return out;
  }
  async function refreshStore() {
    try {
      const r = await chrome.storage.local.get(['wb_global', 'wb_chats', 'wb_theme', 'wb_providers', 'wb_subbots']);
      storeCache.global = r['wb_global'] || {};
      storeCache.chats = r['wb_chats'] || {};
      storeCache.subbots = r['wb_subbots'] || {};
      storeCache.hasKey = hasKeyMap(r['wb_providers'], storeCache.global.activeProvider);
      applyDockTheme(r['wb_theme'] || 'system');
    } catch {}
  }
  chrome.storage.onChanged.addListener((chg) => {
    if (chg['wb_global']) storeCache.global = chg['wb_global'].newValue || {};
    if (chg['wb_chats']) storeCache.chats = chg['wb_chats'].newValue || {};
    if (chg['wb_subbots']) { storeCache.subbots = chg['wb_subbots'].newValue || {}; refreshDockBots(); }
    if (chg['wb_providers']) storeCache.hasKey = hasKeyMap(chg['wb_providers'].newValue, (chg['wb_global']?.newValue || storeCache.global).activeProvider);
    if (chg['wb_theme']) applyDockTheme(chg['wb_theme'].newValue || 'system');
    paintOnboarding();
  });
  function applyDockTheme(stored) {
    const dock = document.getElementById('whatsbot-dock');
    if (!dock) return;
    const active = stored === 'light' || stored === 'dark'
      ? stored
      : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    dock.dataset.theme = active;
  }

  // ---------- identity ----------
  function activeChatKey() {
    // Use header title as stable-ish key (WA internal ids are obfuscated).
    // Empty header (logged out / loading) keys to name:unknown, never 'name:'.
    // Group suffix (#group) keeps a group and a 1:1 with the same display
    // name on separate rules/logs (legacy base ids still resolve as fallback
    // in the service worker so upgrades lose no history).
    const raw = (window.WADOM.activeChatName() || '').trim();
    const name = raw || 'unknown';
    let suffix = '';
    try {
      if (raw && window.WADOM.headerLooksGroup()) suffix = '#group';
    } catch {}
    return { chatId: 'name:' + (raw ? raw.toLowerCase() : 'unknown') + suffix, chatName: name, kind: suffix ? 'group' : 'chat' };
  }

  // Rule lookup with legacy base-id fallback (pre-v3 installs have no #group).
  function getRule(chatId) {
    const chats = storeCache.chats || {};
    if (chats[chatId]) return chats[chatId];
    const base = String(chatId || '').replace(/#group$/, '');
    if (base !== chatId && chats[base]) return chats[base];
    return null;
  }

  // Mirror of store.js:suggestEnabledFor (classic script, no imports).
  // Kept name-identical on purpose: the attribution twin proved name drift
  // hides logic drift, so both copies share the same function name.
  function suggestEnabledFor(chatId) {
    const g = storeCache.global || {};
    const rule = getRule(chatId);
    const mode = String(rule?.suggestMode || 'global').toLowerCase();
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return !!g.suggestionsEnabled;
  }

  // Running watcher for this chat (if any). Watchers are explicit user bots:
  // they answer even when the master auto-reply switch is OFF — otherwise a
  // single forgotten master switch silently kills every watcher (runs:0).
  function runningWatchFor(chatId) {
    try {
      const bots = Object.values(storeCache.subbots || {});
      const norm = (id) => String(id || '').replace(/#group$/, '');
      return bots.find((b) => b?.kind === 'watch' && b?.status === 'running' &&
        (b.targetChatId === chatId || norm(b.targetChatId) === norm(chatId))) || null;
    } catch { return null; }
  }

  // ---------- reader ----------
  // Triple-signal attribution (classic twin of src/common/attribution.js —
  // content scripts can't import ES modules; keep the rule identical there).
  // Signal 1: bubble class. Signal 2: data-id "true_…" (you) / "false_…" (them).
  // Class and flag must AGREE, else dir 'uncertain' — never guess.
  function attributeSignals({ clsIn, clsOut, dataId, preAuthor, chatName, isGroup, align }) {
    const mId = String(dataId || '').match(/^(true|false)_/);
    const fromId = mId ? (mId[1] === 'true' ? 'out' : 'in') : null;
    const fromClass = clsOut && !clsIn ? 'out' : clsIn && !clsOut ? 'in' : null;
    let dir;
    let via = 'signals';
    if (fromClass && fromId) {
      if (fromClass === fromId) dir = fromClass;
      else return { dir: 'uncertain', speaker: 'unknown', name: 'Unknown', via: 'conflict' };
    } else dir = fromClass || fromId || 'uncertain';
    if (dir === 'uncertain' && !fromClass && !fromId) {
      // layout fallback (WhatsApp build without class/data-id signals):
      // incoming bubbles sit left, outgoing right. Never overrules a conflict.
      if (align === 'left') { dir = 'in'; via = 'layout'; }
      else if (align === 'right') { dir = 'out'; via = 'layout'; }
    }
    if (dir === 'out') return { dir, speaker: 'you', name: 'You (phone owner)', via };
    if (dir === 'in') {
      const am = String(preAuthor || '').match(/\]\s*(.*?):\s*$/);
      const author = (am?.[1] || '').trim();
      const name = author || (isGroup ? `${chatName || 'Group'} (unknown author)` : chatName || 'Contact');
      return { dir, speaker: 'them', name, via };
    }
    return { dir, speaker: 'unknown', name: 'Unknown', via: fromClass || fromId ? 'conflict' : 'none' };
  }

  // Bubble alignment vs conversation center: 'left'|'right'|'center'.
  // System rows (dates, encryption notices) span full width → 'center'.
  function bubbleAlign(rowRect, midX, span) {
    if (!rowRect || !span) return 'center';
    const c = rowRect.left + rowRect.width / 2;
    if (c < midX - span * 0.04) return 'left';
    if (c > midX + span * 0.04) return 'right';
    return 'center';
  }

  // Group-by-signal: a chat is a group if ANY visible message carries an
  // author header (1:1 messages never do). Falls back to the header heuristic.
  function detectGroup(body) {
    if (window.WADOM.headerLooksGroup()) return true;
    return window.WADOM.hasPrePlain(body);
  }

  function parseMessageNode(node, groupHint, geo) {
    try {
      const clsOut = window.WADOM.hasOut(node);
      const clsIn = window.WADOM.hasIn(node);
      // data-id must come from the message ROW itself — never from a descendant:
      // quoted/forwarded bubbles inside carry their own data-id flags and a
      // naive querySelector('[data-id]') picks those up, flipping direction
      // and mass-marking messages 'uncertain'.
      const row = window.WADOM.closestRow(node);
      const dataId =
        row.getAttribute?.('data-id') ||
        node.getAttribute?.('data-id') || '';
      const pre = node.querySelector?.('[data-pre-plain-text]')?.getAttribute?.('data-pre-plain-text') || '';
      const chatName = window.WADOM.activeChatName() || 'Contact';
      const rowEl = row.nodeType === 1 ? row : node;
      const align = geo ? bubbleAlign(rowEl.getBoundingClientRect(), geo.midX, geo.span) : 'center';
      const a = attributeSignals({ clsIn, clsOut, dataId, preAuthor: pre, chatName, isGroup: groupHint ?? window.WADOM.headerLooksGroup(), align });
      const textEl = window.WADOM.rowTextEl(node);
      let text = (textEl?.innerText || node.innerText || '').trim();
      // strip trailing timestamp (e.g. "hello 22:10")
      text = text.replace(/\s\d{1,2}:\d{2}(\s?(AM|PM))?\s*$/, '').trim();
      if (!text) return null;
      const meta = window.WADOM.rowMetaEl(node)?.textContent?.trim() || '';
      const msgId = dataId || `${a.dir}:${text.slice(0, 40)}:${meta}`;
      return { msgId, dir: a.dir, speaker: a.speaker, sender: a.name, name: a.name, via: a.via, text: text.slice(0, 2000), meta };
    } catch {
      return null;
    }
  }

  // Last scan diagnostics (shown in the dock detail drawer so attribution
  // problems are visible instead of silent).
  const lastScan = { at: 0, in: 0, out: 0, uncertain: 0, total: 0, sig: null, dom: '' };

  function readVisibleMessages() {
    const body = window.WADOM.convoBodyEl();
    if (!body) return [];
    const nodes = window.WADOM.msgRowEls(body);
    const out = [];
    const groupHint = detectGroup(body); // once per scan, not per message
    // Signal survey counts each message ROW once: the selector above matches
    // both containers and their inner bubbles, so naive counting doubles.
    const surveyedRows = new Set();
    const sig = { clsIn: 0, clsOut: 0, idTrue: 0, idFalse: 0, idOther: 0, idNone: 0, pre: 0, layIn: 0, layOut: 0 };
    let geo = null;
    try {
      const b = body.getBoundingClientRect();
      geo = { midX: b.left + b.width / 2, span: b.width };
    } catch {}
    for (const n of nodes) {
      // Row wrapper holds the actual bubble; find inner or use node itself.
      const target = window.WADOM.innerBubble(n);
      const rowKey = window.WADOM.closestRow(target);
      if (!surveyedRows.has(rowKey)) {
        surveyedRows.add(rowKey);
        surveySignals(target, sig);
      }
      const p = parseMessageNode(target, groupHint, geo);
      if (p && p.text) {
        if (p.via === 'layout') { if (p.dir === 'in') sig.layIn++; else sig.layOut++; }
        out.push(p);
      }
    }
    lastScan.sig = sig;
    lastScan.dom = domSketch(body);
    // dedupe
    const seen = new Set();
    const deduped = out.filter((m) => (seen.has(m.msgId) ? false : (seen.add(m.msgId), true)));
    lastScan.at = Date.now();
    lastScan.total = deduped.length;
    lastScan.in = deduped.filter((m) => m.dir === 'in').length;
    lastScan.out = deduped.filter((m) => m.dir === 'out').length;
    lastScan.uncertain = deduped.filter((m) => m.dir !== 'in' && m.dir !== 'out').length;
    paintScan();
    return deduped;
  }

  // Count raw signal presence (cheap, no parsing) to diagnose layout drift.
  function surveySignals(node, sig) {
    try {
      if (window.WADOM.hasIn(node)) sig.clsIn++;
      if (window.WADOM.hasOut(node)) sig.clsOut++;
      const row = window.WADOM.closestRow(node);
      const id = row.getAttribute?.('data-id') || node.getAttribute?.('data-id') || '';
      if (!id) sig.idNone++;
      else if (id.startsWith('true_')) sig.idTrue++;
      else if (id.startsWith('false_')) sig.idFalse++;
      else sig.idOther++;
      if (node.querySelector?.('[data-pre-plain-text]')) sig.pre++;
    } catch {}
  }

  // Privacy-safe structure sketch of the first message rows: tag names,
  // class names and ATTRIBUTE NAMES only (plus data-id true_/false_ prefix),
  // never message text. Enough to fix selectors, nothing identifying.
  // Diagnostic sketch, throttled: WhatsApp's minified classes are noise, so
  // only semantic classes survive (direction/testid/bubble/row or dashed),
  // output is capped, and recompute happens at most every 15s.
  let lastDomAt = 0;
  function domSketch(body) {
    try {
      const now = Date.now();
      if (lastScan.dom && now - lastDomAt < 15000) return lastScan.dom;
      lastDomAt = now;
      const rows = window.WADOM.msgRowEls(body);
      const keepCls = (c) => /message|testid|bubble|row|selectable|copyable/i.test(c) || c.includes('-') || c.includes('_') || c.length > 10;
      const sketchEl = (el, depth) => {
        if (!el || depth < 0) return '';
        const tag = el.tagName || '?';
        const cls = (el.className?.baseVal ?? el.className ?? '').toString().split(/\s+/).filter(Boolean).filter(keepCls).slice(0, 3).join('.');
        let attrs = '';
        try {
          attrs = [...(el.attributes || [])].map((a) => {
            if (a.name === 'data-id') {
              const v = a.value || '';
              return 'data-id=' + (v.startsWith('true_') ? 'true_…' : v.startsWith('false_') ? 'false_…' : JSON.stringify(v.slice(0, 12)));
            }
            if (/^data-testid|role|aria-label$/.test(a.name)) return `${a.name}=${JSON.stringify(String(a.value || '').slice(0, 24))}`;
            return null;
          }).filter(Boolean).slice(0, 5).join(' ');
        } catch {}
        const kids = depth > 0
          ? [...(el.children || [])].slice(0, 2).map((c) => sketchEl(c, depth - 1)).filter(Boolean).join(' ')
          : '';
        return `<${tag}${cls ? '.' + cls : ''}${attrs ? ' ' + attrs : ''}>${kids ? ' ' + kids : ''}`;
      };
      const out = [...rows].slice(0, 2).map((r, i) => `row${i + 1}: ${sketchEl(r, 2)}`).join('\n');
      return (out.slice(0, 500) + (out.length > 500 ? '\n…(truncated — signals line above is the diagnosis)' : '')) || '(no rows)';
    } catch (e) {
      return `(sketch failed: ${String(e.message || e).slice(0, 60)})`;
    }
  }

  // Brain call with a ceiling: if the service worker hangs mid-turn, the
  // drawer must say so instead of spinning forever. The timer is disarmed on
  // settle — otherwise the loser branch rejects unobserved (page error noise).
  // Ceiling is 210s: device runs default to 180s, so a 150s cap would orphan
  // every long task before the bridge finishes.
  function sendToBrain(message, timeoutMs = 210000) {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`brain timeout (no reply in ${Math.round(timeoutMs / 1000)}s) — reload the extension, then retry`)), timeoutMs);
    });
    return Promise.race([
      Promise.resolve(chrome.runtime.sendMessage(message)).finally(() => clearTimeout(timer)),
      timeout,
    ]);
  }

  function scanSummary() {
    const watch = obsAlive() ? 'watch live' : 'watch DEAD';
    return `${lastScan.in} incoming / ${lastScan.out} outgoing / ${lastScan.uncertain} uncertain (of ${lastScan.total}) · ${watch}`;
  }

  let lastPaintedScan = '';
  function paintScan() {
    try {
      const el = document.querySelector('#wb-scan');
      if (el) {
        const s = lastScan.sig;
        const sigLine = s ? `\nsignals: class-in ${s.clsIn} · class-out ${s.clsOut} · id-true ${s.idTrue} · id-false ${s.idFalse} · id-other ${s.idOther} · id-none ${s.idNone} · author ${s.pre} · layout-in ${s.layIn || 0} · layout-out ${s.layOut || 0}` : '';
        const txt = lastScan.total ? scanSummary() + sigLine : '—';
        if (txt !== lastPaintedScan) {
          el.textContent = txt;
          lastPaintedScan = txt;
        }
      }
      const dom = document.querySelector('#wb-dom');
      if (dom && dom.textContent !== (lastScan.dom || '—')) dom.textContent = lastScan.dom || '—';
    } catch {}
  }

  function listChats() {
    const rows = window.WADOM.qa(document, window.WADOM.SEL.chatRow).slice(0, 80);
    return rows.map((r) => {
      const lines = (r.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const titleEl = window.WADOM.rowTitleEl(r);
      const title = titleEl?.getAttribute?.('title') || titleEl?.textContent || lines[0] || '';
      const unread = window.WADOM.unreadCountEl(r)?.textContent || '';
      // preview = first informative line that isn't the name, a time/date, or a bare count
      const preview = lines.find((l) => l !== title.trim() && !/^\d{1,2}:\d{2}(\s?(AM|PM))?$/.test(l) && !/^\d+$/.test(l) && !/^(yesterday|today)$/i.test(l) && !/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(l) && !/^\d{1,2}[\/\-.]\d{1,2}([\/\-.]\d{2,4})?$/.test(l)) || '';
      // best-effort group flag: group rows carry a group avatar icon
      const isGroup = window.WADOM.rowIsGroup(r);
      return { name: title.trim().slice(0, 120), unread: unread.trim(), preview: preview.slice(0, 160), kind: isGroup ? 'group' : 'chat' };
    }).filter((c) => c.name);
  }

  // Raw read of whatever the contacts pane currently shows (no open/close).
  function readContactsPane() {
    const pane = window.WADOM.contactsPaneEl();
    const scope = pane || window.WADOM.sidePaneEl() || document;
    const rows = window.WADOM.qa(scope, window.WADOM.SEL.contactsRow).slice(0, 300);
    const skip = /^(new group|new community|starred messages|archived|settings|contacts on whatsapp)$/i;
    const out = [];
    for (const r of rows) {
      const lines = (r.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const name = r.querySelector?.('[title]')?.getAttribute?.('title') || lines[0] || '';
      if (!name || skip.test(name)) continue;
      const detail = lines.find((l) => l !== name) || '';
      out.push({ name: name.slice(0, 120), detail: detail.slice(0, 160) });
    }
    const seen = new Set();
    return out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }

  function closeContactsPane() {
    const back = window.WADOM.q(document, window.WADOM.SEL.contactsBack);
    if (back) back.click();
    else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    }
  }

  // Opens the New-chat contacts pane, waits for lazy loading (with scrolling),
  // reads contacts + existing groups, closes the pane again.
  async function openContactsAndList() {
    const btn = window.WADOM.newChatBtnEl();
    if (!btn) throw new Error('New chat button not found — reload the WhatsApp tab and retry (or the WA layout changed).');
    btn.click();
    let contacts = [];
    try {
      const t0 = Date.now();
      let lastCount = -1, still = 0;
      while (Date.now() - t0 < 10000) {
        await sleep(700);
        contacts = readContactsPane();
        if (contacts.length === lastCount) { still++; } else { still = 0; lastCount = contacts.length; }
        if (contacts.length && still >= 2) break; // loaded and stable
        // scroll the side pane to trigger lazy loading of more contacts
        const side = window.WADOM.sidePaneEl();
        const scroller = window.WADOM.contactsPaneEl() || side;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      }
    } finally {
      closeContactsPane();
      await sleep(600);
    }
    if (!contacts.length) throw new Error('Contacts pane opened but stayed empty — scroll your contacts once inside WhatsApp, then retry.');
    // groups live in the chat list (no separate directory UI) — attach them flagged
    const groups = listChats().filter((c) => c.kind === 'group').map((c) => ({ name: c.name, detail: 'group' }));
    return { contacts, groups };
  }

  // ---------- switcher ----------
  // execCommand is deprecated but still the only reliable WhatsApp driver.
  // All uses funnel through these helpers so a future Clipboard/InputEvent
  // fallback can land in one place when Chrome removes it.
  function cmdOk(cmd, val) {
    try {
      if (typeof document.execCommand !== 'function') return false;
      return document.execCommand(cmd, false, val);
    } catch { return false; }
  }
  function typeInto(el, text) {
    if (cmdOk('insertText', text)) return true;
    // Fallback: direct edit + input event (React picks up the change).
    try {
      el.focus();
      const sel = window.getSelection?.();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (range && el.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
      } else {
        el.textContent = (el.textContent || '') + text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    } catch { return false; }
  }
  function selectAll(el) {
    if (cmdOk('selectAll', null)) return;
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection?.();
      sel?.removeAllRanges?.();
      sel?.addRange?.(r);
    } catch {}
  }
  function clearSearch(box) {
    try {
      box.focus();
      selectAll(box);
      if (!cmdOk('insertText', '')) box.textContent = '';
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      box.blur();
    } catch {}
  }

  async function openChatByName(name, timeoutMs = 8000) {
    const box = window.WADOM.searchBoxEl();
    if (!box) throw new Error('Search box not found (WA layout changed?)');
    box.focus();
    selectAll(box);
    typeInto(box, name);
    box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await sleep(900);
    try {
      const t0 = Date.now();
      const needle = name.toLowerCase();
      const rowName = (r) => ((r.innerText || '').split('\n')[0] || '').trim().toLowerCase();
      while (Date.now() - t0 < timeoutMs) {
        const rows = window.WADOM.qa(document, window.WADOM.SEL.chatRow);
        // exact title first (never open a lookalike), then substring fallback
        const match = rows.find((r) => rowName(r) === needle)
          || rows.find((r) => (r.innerText || '').toLowerCase().includes(needle.slice(0, 12)));
        if (match) {
          match.querySelector?.('div, span')?.click?.();
          (match).click?.();
          await sleep(1200);
          return window.WADOM.activeChatName();
        }
        await sleep(500);
      }
      throw new Error(`Chat "${name}" not found in list`);
    } finally {
      // always leave the chat list unfiltered, success or failure
      clearSearch(box);
    }
  }

  // ---------- replier ----------
  async function sendText(text) {
    const composer = window.WADOM.composerEl();
    if (!composer) throw new Error('Message box not found — open a chat first');
    // Chat the send started in: restoring into another chat after a mid-send
    // switch would leak the owner's draft across conversations.
    const startedChat = activeChatKey().chatId;
    // Preserve the owner's in-progress draft: an auto-reply must never eat it.
    const draft = (composer.innerText || '').trim();
    let sent = false;
    const restoreDraft = async () => {
      if (!draft) return;
      try { if (activeChatKey().chatId !== startedChat) return; } catch {}
      // Re-query the composer: WA re-renders it, and the closed-over node
      // may be detached (restore would silently fail — or hit a stale tree).
      const live = window.WADOM.composerEl() || composer;
      live.focus();
      if (!sent) {
        // send failed midway: clear partial reply text before restoring draft
        selectAll(live);
        cmdOk('delete', null);
        try { live.textContent = ''; } catch {}
      }
      typeInto(live, draft);
      live.dispatchEvent(new InputEvent('input', { bubbles: true }));
    };
    try {
      composer.focus();
      // WhatsApp uses contenteditable; insertText keeps React handlers happy
      selectAll(composer);
      // send in chunks to avoid huge paste issues
      const chunks = text.match(/[\s\S]{1,1000}/g) || [text];
      selectAll(composer);
      cmdOk('delete', null);
      try { if ((composer.innerText || '').trim()) composer.textContent = ''; } catch {}
      for (const c of chunks) {
        typeInto(composer, c);
        composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await sleep(150);
      }
      await sleep(rand(storeCache.global.replyDelayMinMs ?? 1200, storeCache.global.replyDelayMaxMs ?? 2800));
      // Verify before sending: WA may have re-rendered the composer (stale
      // node) — clicking send on an empty box would report success falsely.
      const live = window.WADOM.composerEl();
      const typed = (live || composer).innerText || '';
      if (!typed.includes(text.slice(0, 20))) {
        throw new Error('Composer lost the reply text (page re-rendered) — nothing sent.');
      }
      const btn = window.WADOM.sendBtnEl();
      if (btn) btn.click();
      else (live || composer).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleep(600);
      sent = true;
    } finally {
      await restoreDraft();
    }
  }

  // ---------- step-by-step full history scan (first-run context build) ----------
  async function scanFullHistory(chatId, chatName, onProgress) {
    const body = window.WADOM.convoBodyEl();
    if (!body) throw new Error('Open a chat before building context');
    const cap = storeCache.global.contextBuildCap ?? 800;
    const all = new Map();
    // Discovery order is newest→oldest (viewport first, then scroll-ups), so
    // stamp DECREASING times: background sorts logs oldest→newest by ts.
    const t0base = Date.now();
    let nSeq = 0;
    let stagnant = 0;
    let lastH = -1;
    for (let i = 0; i < 200; i++) {
      // collect current viewport BEFORE scroll
      for (const m of readVisibleMessages()) {
        if (!all.has(m.msgId)) all.set(m.msgId, { ...m, ts: t0base - (nSeq++) });
      }
      onProgress?.({ scanned: all.size, round: i });
      if (all.size >= cap) break;
      body.scrollTop = 0; // jump to top to trigger older load
      body.dispatchEvent(new Event('scroll', { bubbles: true }));
      await sleep(storeCache.global.scrollBatchDelayMs ?? 900);
      // stream batch to background for durable logging
      const batch = readVisibleMessages().filter((m) => !seenMsgIds.has(m.msgId));
      batch.forEach((m) => seenMsgIds.add(m.msgId));
      if (batch.length) {
        try {
          const p = chrome.runtime.sendMessage({ type: 'SAVE_CONTEXT_BATCH', chatId, chatName, messages: batch });
          if (p && p.catch) p.catch(() => {});
        } catch {}
      }
      if (body.scrollHeight === lastH) { stagnant++; if (stagnant >= 4) break; }
      else { stagnant = 0; lastH = body.scrollHeight; }
    }
    // final flush + scroll back to bottom
    const finalBatch = readVisibleMessages().filter((m) => !seenMsgIds.has(m.msgId));
    if (finalBatch.length) {
      await chrome.runtime.sendMessage({ type: 'SAVE_CONTEXT_BATCH', chatId, chatName, messages: finalBatch });
    }
    body.scrollTop = body.scrollHeight;
    return all.size;
  }

  // ---------- observer: new incoming (self-healing) ----------
  // WhatsApp re-renders the conversation container on navigation — an
  // observer bound once at boot silently watches a DETACHED node forever
  // (messages arrive, zero runs, zero errors). So every tick re-validates
  // the observed node and re-attaches when it changed/died.
  let convoObs = null;
  let observedNode = null;
  const obsHealth = { attaches: 0, at: 0 };
  function obsAlive() {
    try { return !!(convoObs && observedNode && observedNode.isConnected && document.contains(observedNode)); } catch { return false; }
  }
  function ensureObserver() {
    try {
      const body = window.WADOM.convoBodyEl();
      if (!body) return false;
      if (observedNode === body && obsAlive()) return true;
      try { convoObs?.disconnect(); } catch {}
      const obs = new MutationObserver(() => { handleSnapshot().catch(() => {}); });
      obs.observe(body, { childList: true, subtree: true, characterData: true });
      convoObs = obs;
      observedNode = body;
      obsHealth.attaches++;
      obsHealth.at = Date.now();
      return true;
    } catch { return false; }
  }
  function watchNewMessages() {
    let tries = 0;
    const t = setInterval(() => {
      if (ensureObserver() || ++tries > 60) clearInterval(t);
    }, 1000);
    // chat-switch detection: header changes reset seen set + force re-attach
    // (switching chats is exactly when WA swaps the container).
    setInterval(() => {
      try {
        const { chatId } = activeChatKey();
        if (watchNewMessages._lastChat && watchNewMessages._lastChat !== chatId) {
          seenMsgIds.clear();
          try {
            // Cancel pending auto-timers for chats we just left: firing them
            // would yank the user back to the old chat. Fresh messages will
            // re-queue from the new chat's own observer prime.
            for (const [pid, p] of pendingIncoming) {
              if (pid !== chatId && p?.timer) { try { clearTimeout(p.timer); } catch {} }
              if (pid !== chatId) pendingIncoming.delete(pid);
            }
          } catch {}
          try {
            clearSuggestRow();
            suggestPendingMsg = '';
            if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null; }
            // Cap dismissed set: chat hops accumulate ids forever otherwise.
            if (suggestDismissed.size > 200) {
              const it = suggestDismissed.values();
              for (let i = 0; i < 100; i++) {
                const n = it.next();
                if (n.done) break;
                suggestDismissed.delete(n.value);
              }
            }
          } catch {}
          ensureObserver();
          handleSnapshot(true).catch(() => {});
        } else {
          ensureObserver();
        }
        watchNewMessages._lastChat = chatId;
      } catch {}
    }, 2000);
    // prime seen set
    setTimeout(() => { ensureObserver(); handleSnapshot(true).catch(() => {}); }, 3000);
  }

  let lastRefreshAt = 0;
  // Reentrancy coalescing: mutations fire hundreds/sec and the awaits below
  // yield — without this, overlapping runs process the same messages twice.
  let snapBusy = false, snapQueued = false;
  // Seen-set cap: ids accumulate forever in long sessions; drop oldest in
  // bulk (iterator order = insertion order). Clearing wholesale would re-fire
  // old messages as fresh — never do that.
  function trimSeen() {
    if (seenMsgIds.size <= 6000) return;
    const it = seenMsgIds.keys();
    for (let i = 0; i < 2000; i++) {
      const n = it.next();
      if (n.done) break;
      seenMsgIds.delete(n.value);
    }
  }
  async function handleSnapshotInner(prime = false) {
    // Storage read per DOM mutation is wasteful (WA fires hundreds/sec);
    // rules still apply within ~2s, and onChanged pushes updates live.
    if (Date.now() - lastRefreshAt > 2000) {
      await refreshStore();
      lastRefreshAt = Date.now();
    }
    const { chatId, chatName } = activeChatKey();
    const msgs = readVisibleMessages();
    // Inline chips are independent of the auto-reply master switch: they
    // preview only, never send. Trigger on open + on fresh incoming.
    try { triggerSuggest(chatId, chatName, msgs, prime); } catch {}
    // Watchers are explicit bots: a running watcher for THIS chat bypasses
    // the master switch (otherwise one forgotten master toggle silently
    // parks every watcher at runs:0 with zero errors).
    const watch = runningWatchFor(chatId);
    if (!storeCache.global.enabled && !watch) return;
    const rule = getRule(chatId);
    const fresh = msgs.filter((m) => m.dir === 'in' && !seenMsgIds.has(m.msgId));
    msgs.forEach((m) => seenMsgIds.add(m.msgId));
    trimSeen();
    if (prime || !fresh.length) return;
    if (!rule?.allowed || rule.mode === 'log-only') {
      // still log quietly — fire-and-forget must never reject unhandled
      try {
        const p = chrome.runtime.sendMessage({ type: 'LOG_INCOMING', chatId, messages: fresh });
        if (p && p.catch) p.catch(() => {});
      } catch {}
      updateBadge(chatName, `logged ${fresh.length} (bot off)`);
      return;
    }
    if (rule.mode === 'manual') {
      updateBadge(chatName, `${fresh.length} new — press AI Reply`, 'warn');
      pendingIncoming.set(chatId, { chatId, chatName, msgs: fresh, history: msgs.slice(-(storeCache.global.historyLimit ?? 30)) });
      return;
    }
    // auto: debounce bursts
    const prev = pendingIncoming.get(chatId);
    if (prev?.timer) clearTimeout(prev.timer);
    const merged = [...(prev?.msgs || []), ...fresh];
    const history = msgs.slice(-(storeCache.global.historyLimit ?? 30));
    const timer = setTimeout(() => fireAutoReply(chatId, chatName, merged, history), storeCache.global.debounceMs ?? 4000);
    pendingIncoming.set(chatId, { chatId, chatName, msgs: merged, history, timer });
    startThinking(chatName, merged, chatId, true);
  }

  // Single-flight wrapper: a run already in flight coalesces reentrant calls
  // into exactly one follow-up pass instead of overlapping full runs.
  async function handleSnapshot(prime = false) {
    if (snapBusy) { snapQueued = true; return; }
    snapBusy = true;
    try { await handleSnapshotInner(prime); }
    finally {
      snapBusy = false;
      if (snapQueued) { snapQueued = false; handleSnapshot().catch(() => {}); }
    }
  }

  function handleReplyRefusal(chatName, res) {
    // Background refused to generate (e.g. missing instruction): never send,
    // just tell the owner what to do. Returns true if it was a refusal.
    if (res?.code === 'NO_INSTRUCTION') {
      updateBadge(chatName, 'blocked: add instruction first (Console → Rules)', 'warn');
      paintResult(`BLOCKED — no instruction saved for this chat.\nFix: Console → Rules → write instruction → Save instruction.\nThen press AI Reply again.`);
      return true;
    }
    if (res?.code === 'NO_DEVICE') {
      updateBadge(chatName, 'blocked: connect device first (popup → Device)', 'warn');
      paintResult(`BLOCKED — device run requested but bridge is not connected.\nFix: popup → Device → paste token → Connect Device.\n${res?.error || ''}`);
      return true;
    }
    if (res?.code === 'DISABLED') {
      updateBadge(chatName, 'bot off — reply skipped (see detail)', 'warn');
      paintResult(`BLOCKED — ${res?.error || 'replies are disabled for this chat.'}\nFix: Console → Rules → Allow the chat, or enable the bot in the popup.`);
      return true;
    }
    if (res?.code === 'FORBIDDEN') {
      updateBadge(chatName, 'blocked: outside call (see detail)', 'err');
      paintResult(`BLOCKED — ${res?.error || 'this call did not come from the extension.'}\nNothing was sent. If you pressed a WhatsBot button, reload the tab.`);
      return true;
    }
    return false;
  }

  // ---------- inline suggestions (native chips under last incoming) ----------
  // Preview-only: chips insert into the composer on click, never auto-send.
  // Cache per msgId (same message never re-calls), dismiss per msgId,
  // debounce bursts, fail closed (any error just clears the row).
  const suggestCache = new Map(); // msgId -> suggestions[]
  const suggestDismissed = new Set();
  let suggestTimer = null;
  let suggestPendingMsg = '';
  function clearSuggestRow() {
    try { document.querySelectorAll('.wb-suggest-row').forEach((el) => el.remove()); } catch {}
  }
  function suggestAnchor() {
    try {
      const body = window.WADOM.convoBodyEl();
      if (!body) return null;
      const ins = window.WADOM.msgInEls(body);
      if (ins?.length) {
        const last = ins[ins.length - 1];
        return window.WADOM.closestRow(last);
      }
      // Fallback when WA renames bubble classes: last message container.
      const rows = window.WADOM.msgRowEls(body);
      if (rows?.length) return rows[rows.length - 1];
      return null;
    } catch { return null; }
  }
  function renderSuggestChips(suggestions) {
    try {
      clearSuggestRow();
      if (!suggestions?.length) return;
      const anchor = suggestAnchor();
      if (!anchor || !anchor.parentNode) return;
      const row = document.createElement('div');
      row.className = 'wb-suggest-row';
      row.dataset.theme = dockTheme();
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'WhatsBot suggested replies');
      for (const s of suggestions.slice(0, 3)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wb-sug-chip';
        b.textContent = s; // textContent only — model output never becomes HTML
        b.setAttribute('dir', 'auto'); // RTL suggestions align correctly
        b.title = s; // full text: chip truncates with ellipsis
        b.setAttribute('aria-label', `Insert suggestion: ${s}`);
        b.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            const composer = window.WADOM.composerEl();
            if (!composer) return;
            composer.focus();
            selectAll(composer);
            cmdOk('delete', null);
            try { composer.textContent = ''; } catch {}
            typeInto(composer, s);
            composer.dispatchEvent(new InputEvent('input', { bubbles: true }));
            composer.focus();
          } catch {}
        };
        row.appendChild(b);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'wb-sug-x';
      x.textContent = '×';
      x.title = 'Dismiss suggestions';
      x.setAttribute('aria-label', 'Dismiss suggestions');
      x.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { if (suggestPendingMsg) suggestDismissed.add(suggestPendingMsg); } catch {}
        clearSuggestRow();
      };
      row.appendChild(x);
      anchor.parentNode.insertBefore(row, anchor.nextSibling);
    } catch { try { clearSuggestRow(); } catch {} }
  }
  // Current theme for page-level elements (chips live outside the dock,
  // so they can't inherit #whatsbot-dock[data-theme] from CSS).
  function dockTheme() {
    try {
      const t = document.getElementById('whatsbot-dock')?.dataset.theme;
      if (t === 'light' || t === 'dark') return t;
      return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch { return 'dark'; }
  }
  // Loading shimmer while the preview generates: users can tell "working"
  // from "off". Replaced by chips, or cleared on failure/dismiss/switch.
  function renderSuggestLoading() {
    try {
      clearSuggestRow();
      const anchor = suggestAnchor();
      if (!anchor || !anchor.parentNode) return;
      const row = document.createElement('div');
      row.className = 'wb-suggest-row loading';
      row.dataset.theme = dockTheme();
      row.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 2; i++) {
        const b = document.createElement('span');
        b.className = 'wb-sug-chip shim';
        row.appendChild(b);
      }
      anchor.parentNode.insertBefore(row, anchor.nextSibling);
    } catch {}
  }
  function triggerSuggest(chatId, chatName, msgs, prime = false) {
    try {
      const incoming = (msgs || []).filter((m) => m.dir === 'in');
      if (!incoming.length) { clearSuggestRow(); return; }
      const last = incoming[incoming.length - 1];
      // Chat switched (prime) or dismissed/new anchor → reset timer state.
      if (prime) {
        if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null; }
        clearSuggestRow();
      }
      if (!suggestEnabledFor(chatId)) { clearSuggestRow(); return; }
      const rule = getRule(chatId);
      if (!rule?.instruction?.trim()) { clearSuggestRow(); return; }
      if (suggestDismissed.has(last.msgId)) { clearSuggestRow(); return; }
      if (suggestCache.has(last.msgId)) {
        suggestPendingMsg = last.msgId;
        renderSuggestChips(suggestCache.get(last.msgId));
        return;
      }
      if (suggestTimer) clearTimeout(suggestTimer);
      const history = msgs.slice(-(storeCache.global.historyLimit ?? 30));
      const fresh = incoming.slice(-3);
      renderSuggestLoading();
      suggestTimer = setTimeout(async () => {
        suggestTimer = null;
        try {
          // Anchor moved on (user switched chat) — drop stale request.
          const now = activeChatKey();
          if (now.chatId !== chatId) return;
          const r = await chrome.runtime.sendMessage({ type: 'SUGGEST_REPLIES', chatId, chatName, history, newMessages: fresh });
          if (!r?.suggestions?.length) {
            // Cache empties too (avoids re-calling for unanswerable msgs).
            suggestCache.set(last.msgId, []);
            if (suggestCache.size > 100) {
              const k = suggestCache.keys().next().value;
              suggestCache.delete(k);
            }
            clearSuggestRow();
            return;
          }
          suggestCache.set(last.msgId, r.suggestions);
          if (suggestCache.size > 100) {
            const k = suggestCache.keys().next().value;
            suggestCache.delete(k);
          }
          const live = activeChatKey();
          if (live.chatId !== chatId || suggestDismissed.has(last.msgId)) return;
          suggestPendingMsg = last.msgId;
          renderSuggestChips(r.suggestions);
        } catch { /* fail closed: no chips, no toast */ }
      }, 1500);
    } catch { /* fail closed */ }
  }

  // Force the feedback path visible: uncollapse panel + open detail drawer +
  // show the thinking pill. User-initiated actions (task box, subbot box,
  // manual reply, build) always reveal; background auto-replies never pop.
  function revealFeedback(label) {
    try {
      const panel = document.getElementById('whatsbot-panel');
      if (panel?.hidden) {
        panel.hidden = false;
        try { localStorage.setItem('wb_collapsed', '0'); } catch {}
      }
      const det = document.querySelector('#wb-detail');
      if (det) { det.hidden = false; think.open = true; }
      const btn = document.querySelector('#wb-think');
      if (btn) { btn.hidden = false; btn.classList.remove('done'); }
      if (label) {
        const txt = document.querySelector('#wb-thinktxt');
        if (txt) txt.textContent = label;
      }
    } catch {}
  }

  // Full-text result/error readout in the detail drawer (badges truncate).
  // Fallback: if the drawer element is somehow absent, the status badge
  // carries a truncated copy — feedback must never vanish silently.
  function paintResult(text) {
    try {
      const el = document.querySelector('#wb-result');
      if (el) { el.textContent = text || '—'; return; }
    } catch {}
    try {
      const { chatName } = activeChatKey();
      updateBadge(chatName, String(text || 'done').slice(0, 90));
    } catch {}
  }

  function ruleSnapshot(chatId) {
    const r = getRule(chatId) || {};
    return `Chat rule: replies ${r.allowed ? 'ON' : 'OFF'} · mode ${r.mode || '—'} · instruction ${r.instruction?.trim() ? 'set' : 'MISSING (Console → step 03 Rules)'} · brain ${r.routeTo || 'cloud'} · suggest ${(r.suggestMode || 'global')}`;
  }

  // ---------- thinking view (popup detail inside WhatsApp) ----------
  const THINK_STAGES = [
    ['detected', 'Message detected'],
    ['waiting', 'Waiting out message burst'],
    ['generating', 'Asking the brain'],
    ['sending', 'Typing into WhatsApp'],
    ['sent', 'Sent'],
  ];
  const think = { active: false, chatName: '', chatId: '', t0: 0, timer: null, stage: '', open: false, waited: false };

  function thinkEls() {
    const dock = document.getElementById('whatsbot-dock');
    if (!dock) return null;
    const q = (s) => dock.querySelector(s);
    if (!q('#wb-think')) return null;
    return {
      btn: q('#wb-think'), txt: q('#wb-thinktxt'), elapsed: q('#wb-elapsed'),
      detail: q('#wb-detail'), quote: q('#wb-quote'), steps: q('#wb-tsteps'),
      brain: q('#wb-brain'), session: q('#wb-session'),
      rlabel: q('#wb-rlabel'), sent: q('#wb-sent'),
    };
  }
  function brainLabel(chatId) {
    const rule = storeCache.chats[chatId] || {};
    if (rule.routeTo?.startsWith('device:')) return `device ${rule.routeTo.slice(7)}${rule.cwd ? ` · ${rule.cwd}` : ''}`;
    return `cloud · ${storeCache.global.activeProvider || 'default model'}`;
  }
  function paintSteps(cur, failed = false) {
    const el = thinkEls(); if (!el) return;
    el.steps.textContent = '';
    const order = THINK_STAGES.map((s) => s[0]);
    const curIdx = order.indexOf(cur);
    for (const [key, label] of THINK_STAGES) {
      if (key === 'waiting' && !think.waited) continue;
      const row = document.createElement('div');
      let cls = 'wb-step';
      if (failed && key === cur) cls += ' fail';
      else if (key === cur) cls += cur === 'sent' ? ' done' : ' doing';
      else if (order.indexOf(key) < curIdx || cur === 'sent') cls += ' done';
      row.className = cls;
      const dot = document.createElement('span'); dot.className = 'st-dot';
      const tx = document.createElement('span'); tx.textContent = label;
      row.appendChild(dot); row.appendChild(tx);
      el.steps.appendChild(row);
    }
  }
  function startThinking(chatName, quotes, chatId, waiting) {
    const el = thinkEls(); if (!el) return;
    think.active = true; think.chatName = chatName; think.chatId = chatId;
    think.t0 = Date.now(); think.waited = !!waiting; think.stage = waiting ? 'waiting' : 'detected';
    el.btn.hidden = false;
    el.btn.classList.remove('done');
    el.detail.hidden = !think.open;
    el.rlabel.hidden = true; el.sent.hidden = true; el.sent.textContent = '';
    el.txt.textContent = waiting ? 'thinking… (waiting for burst)' : 'thinking…';
    el.elapsed.textContent = '0s';
    el.quote.textContent = '';
    (quotes || []).slice(-3).forEach((m, i, arr) => {
      const who = document.createElement('span'); who.className = 'wb-qwho';
      who.textContent = `${m.sender || chatName}: `;
      el.quote.appendChild(who);
      el.quote.appendChild(document.createTextNode((m.text || '').slice(0, 300)));
      if (i < arr.length - 1) el.quote.appendChild(document.createElement('br'));
    });
    el.brain.textContent = brainLabel(chatId);
    if (el.session) { el.session.textContent = 'opening…'; el.session.classList.remove('warn'); }
    paintSteps(think.stage);
    updateBadge(chatName, `thinking… (${(quotes || []).length} new — click panel for detail)`, 'warn');
    clearInterval(think.timer);
    think.timer = setInterval(() => {
      if (!think.active) return;
      const e2 = thinkEls(); if (e2) e2.elapsed.textContent = `${Math.floor((Date.now() - think.t0) / 1000)}s`;
    }, 500);
  }
  function setThinkStage(stage, label) {
    think.stage = stage;
    const el = thinkEls(); if (!el) return;
    paintSteps(stage);
    if (label) el.txt.textContent = label;
  }
  function endThinking(reply, errLabel, sessionInfo) {
    think.active = false; clearInterval(think.timer);
    const el = thinkEls(); if (!el) return;
    el.btn.classList.add('done'); // stop the spinner: job is over
    if (reply === undefined && !errLabel) {
      // neutral park (e.g. confirm card waiting on the user): spinner stops,
      // detail stays open, no success/failure paint.
      el.txt.textContent = 'waiting…';
      paintSteps(think.stage || 'detected');
      return;
    }
    paintResult(errLabel ? `FAILED: ${errLabel}\n${ruleSnapshot(think.chatId)}` : `SENT (${(reply || '').length} chars). ${ruleSnapshot(think.chatId)}`);
    if (sessionInfo && el.session) {
      el.session.textContent = `${sessionInfo.id} · #${sessionInfo.n} · ctx ${sessionInfo.ctx} · ${sessionInfo.state}${sessionInfo.subbot ? ` · via ${sessionInfo.subbot}` : ''}`;
      el.session.classList.toggle('warn', sessionInfo.state === 'warning' || sessionInfo.state === 'full');
    }
    if (errLabel) { paintSteps(think.stage || 'generating', true); el.txt.textContent = errLabel; }
    else {
      paintSteps('sent'); el.txt.textContent = 'sent';
      el.rlabel.hidden = false; el.sent.hidden = false;
      el.sent.textContent = (reply || '').slice(0, 600);
    }
  }

  async function fireAutoReply(chatId, chatName, newMsgs, history, retried = false) {
    pendingIncoming.delete(chatId);
    // Re-check the rule at fire time: the user may have paused, switched to
    // manual, or disabled the bot during the debounce window. A running
    // watcher for this chat bypasses the master switch (see handleSnapshot).
    await refreshStore();
    lastRefreshAt = Date.now();
    if (!storeCache.global.enabled && !runningWatchFor(chatId)) { endThinking(undefined); updateBadge(chatName, 'bot disabled — reply skipped'); return; }
    const liveRule = getRule(chatId);
    if (!liveRule?.allowed || liveRule.mode !== 'auto') {
      endThinking(undefined);
      updateBadge(chatName, 'rule changed mid-wait — reply skipped, press AI Reply for manual');
      return;
    }
    // Wrong-chat race FIRST: the debounce timer may fire after the user
    // switched chats. Never mix history across chats — reopen the target
    // before reading anything live. Same-chat path re-reads to include
    // messages that arrived during debounce.
    try {
      const now0 = activeChatKey();
      if (now0.chatId !== chatId) {
        updateBadge(chatName, 'switching back to target chat…', 'warn');
        await openChatByName(chatName);
        // Verify the reopen actually landed back — the search fallback can
        // open a lookalike, and everything below must not run there.
        const back0 = activeChatKey();
        if (back0.chatId !== chatId) { updateBadge(chatName, `reopen landed on "${back0.chatName}" — reply skipped, press AI Reply for manual`, 'err'); return; }
        const live2 = readVisibleMessages().slice(-(storeCache.global.historyLimit ?? 30));
        if (live2.length) history = live2;
      } else {
        const live = readVisibleMessages().slice(-(storeCache.global.historyLimit ?? 30));
        if (live.length) history = live;
      }
    } catch {}
    try {
      setThinkStage('generating', 'asking the brain…');
      updateBadge(chatName, 'generating reply…', 'warn');
      const res = await sendToBrain({ type: 'GEN_REPLY', chatId, chatName, history, newMessages: newMsgs });
      if (!res?.ok) {
        if (handleReplyRefusal(chatName, res)) { endThinking(null, 'blocked'); return; }
        // BUSY = another turn holds this chat's lock (concurrent burst).
        // Exactly one delayed retry, then surface the error.
        if (res?.code === 'BUSY' && !retried) {
          updateBadge(chatName, 'another reply is running — retrying once in ~4s…', 'warn');
          await sleep(4000);
          return fireAutoReply(chatId, chatName, newMsgs, history, true);
        }
        throw new Error(res?.error || 'LLM failed');
      }
      // Wrong-chat race: the debounce timer may fire after the user switched
      // chats. Never type into the wrong conversation — reopen the target first.
      const now = activeChatKey();
      if (now.chatId !== chatId) {
        updateBadge(chatName, 'switching back to target chat…', 'warn');
        await openChatByName(chatName);
        // Never type into the wrong conversation: abort if the reopen
        // landed on a lookalike instead of the target.
        const back = activeChatKey();
        if (back.chatId !== chatId) { endThinking(null, 'failed'); paintResult(`ABORTED: reopen landed on "${back.chatName}" — nothing sent.`); updateBadge(chatName, 'wrong chat after reopen — reply aborted', 'err'); return; }
      }
      setThinkStage('sending', 'typing into WhatsApp…');
      await sendText(res.reply);
      endThinking(res.reply, null, res.session);
      updateBadge(chatName, 'replied', 'ok');
    } catch (e) {
      endThinking(null, 'failed');
      paintResult(`FAILED: ${String(e.message || e)}\n${ruleSnapshot(chatId)}`);
      updateBadge(chatName, 'error: ' + String(e.message || e).slice(0, 80), 'err');
    }
  }

  async function manualReply() {
    const { chatId, chatName } = activeChatKey();
    const prev = pendingIncoming.get(chatId);
    if (prev?.timer) { try { clearTimeout(prev.timer); } catch {} }
    pendingIncoming.delete(chatId); // manual takes over; drop any queued auto state + cancel its timer
    const msgs = readVisibleMessages();
    const incoming = msgs.filter((m) => m.dir === 'in').slice(-5);
    if (!incoming.length) { revealFeedback(); updateBadge(chatName, `no incoming to answer — scan: ${scanSummary()}`); return; }
    try {
      revealFeedback('thinking…');
      startThinking(chatName, incoming, chatId, false);
      setThinkStage('generating', 'asking the brain…');
      const res = await sendToBrain({
        type: 'GEN_REPLY', chatId, chatName,
        history: msgs.slice(-(storeCache.global.historyLimit ?? 30)),
        newMessages: incoming,
      });
      if (!res?.ok) {
        if (handleReplyRefusal(chatName, res)) { endThinking(null, 'blocked'); return; }
        throw new Error(res?.error);
      }
      setThinkStage('sending', 'typing into WhatsApp…');
      await sendText(res.reply);
      endThinking(res.reply, null, res.session);
      updateBadge(chatName, 'replied', 'ok');
    } catch (e) { endThinking(null, 'failed'); paintResult(`FAILED: ${String(e.message || e)}\n${ruleSnapshot(chatId)}`); updateBadge(chatName, 'error: ' + String(e.message || e).slice(0, 80), 'err'); }
  }

  // ---------- task box ("msg to X that …" / "report unread") ----------
  function endTask(label, body) {
    think.active = false; clearInterval(think.timer);
    const el = thinkEls();
    if (el) {
      el.btn.classList.add('done');
      el.txt.textContent = label;
      el.rlabel.hidden = false; el.sent.hidden = false;
      el.sent.textContent = (body || '').slice(0, 1500);
    }
    paintResult(`${label}:\n${body || ''}`);
  }

  // Local fast parse before spending an LLM call.
  function parseTaskLocal(task) {
    const send = task.match(/^(msg|message|send|tell|text|whatsapp)\s+(?:to\s+)?(.+?)\s+that\s+([\s\S]+)$/i);
    if (send) return { action: 'send_message', chat: send[2].trim(), message: send[3].trim() };
    if (/unread|report|recap|summary of (my )?chats/i.test(task)) return { action: 'report_unread' };
    return null;
  }

  async function runTask(rawTask) {
    const task = (rawTask || '').trim().slice(0, 500);
    if (!task) return;
    const { chatId, chatName } = activeChatKey();
    revealFeedback('working on task…');
    startThinking(chatName, [{ sender: 'You (task)', text: task }], chatId, false);
    setThinkStage('generating', 'working on task…');
    updateBadge(chatName, 'working on task…', 'warn');
    try {
      let plan = parseTaskLocal(task);
      if (!plan) {
        const names = listChats().slice(0, 40).map((c) => c.name);
        const r = await chrome.runtime.sendMessage({ type: 'PARSE_TASK', task, chatNames: names });
        if (!r?.ok) throw new Error(r?.error || 'could not understand task');
        plan = r.plan;
      }
      if (plan.action === 'send_message' && plan.chat && plan.message) {
        const opened = await openChatByName(plan.chat);
        // Verify the opened chat actually matches the requested target
        // (substring fallback can land on a lookalike — never send blind).
        const live = activeChatKey();
        const want = plan.chat.trim().toLowerCase();
        const got = (live.chatName || '').trim().toLowerCase();
        const openedName = String(opened || '').trim().toLowerCase();
        if (got !== want && openedName !== want && !got.startsWith(want + ' ')) {
          throw new Error(`opened "${live.chatName}" but you asked for "${plan.chat}" — nothing sent. Use the exact chat name.`);
        }
        await sleep(800);
        await sendText(plan.message);
        endTask(`sent to ${live.chatName || plan.chat}`, plan.message);
        updateBadge(live.chatName || plan.chat, 'task sent', 'ok');
        return;
      }
      if (plan.action === 'report_unread') {
        const items = listChats().filter((c) => c.unread).map((c) => ({ name: c.name, preview: c.preview, unread: c.unread }));
        if (!items.length) {
          endTask('no unread chats', 'Inbox zero — nothing unread right now.');
          updateBadge(chatName, 'no unread', 'ok');
          return;
        }
        setThinkStage('generating', 'summarizing unread…');
        const r = await chrome.runtime.sendMessage({ type: 'SUMMARIZE_UNREAD', items });
        if (!r?.ok) throw new Error(r?.error || 'summarize failed');
        endTask(`unread report (${items.length} chats)`, r.report);
        updateBadge(chatName, 'report ready', 'ok');
        return;
      }
      throw new Error(`didn't understand. Try: "msg to NAME that TEXT" or "report unread".`);
    } catch (e) {
      endThinking(null, 'failed');
      paintResult(`TASK FAILED: ${String(e.message || e)}\n${ruleSnapshot(chatId)}`);
      updateBadge(chatName, 'task failed: ' + String(e.message || e).slice(0, 60), 'err');
    }
  }

  // ---------- messages from popup/sidepanel ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'PING': sendResponse({ ok: true, loaded: window.WADOM.isLoaded(), chat: activeChatKey() }); break;
        case 'CHECK_LAYOUT': sendResponse({ ok: true, probe: window.WADOM.probeLayout() }); break;
        case 'LIST_CHATS': sendResponse({ ok: true, chats: listChats(), active: activeChatKey() }); break;
        case 'LIST_CONTACTS': {
          const { contacts, groups } = await openContactsAndList();
          sendResponse({ ok: true, contacts, groups });
          break;
        }
        case 'OPEN_CHAT': {
          const opened = await openChatByName(msg.name);
          sendResponse({ ok: true, opened });
          break;
        }
        case 'READ_ACTIVE': sendResponse({ ok: true, ...activeChatKey(), messages: readVisibleMessages().slice(-(msg.limit || 50)) }); break;
        case 'SEND_TEXT': {
          // Optional chat check: if the caller names a chat, refuse instead
          // of typing into whatever happens to be open.
          if (msg.chatId && activeChatKey().chatId !== msg.chatId) {
            const e = new Error('wrong chat open — nothing sent');
            e.code = 'WRONG_CHAT';
            throw e;
          }
          await sendText(msg.text); sendResponse({ ok: true }); break;
        }
        case 'MANUAL_REPLY': await manualReply(); sendResponse({ ok: true }); break;
        case 'BUILD_CONTEXT_HERE': {
          const { chatId, chatName } = activeChatKey();
          let scanned = 0;
          startThinking(chatName, [], chatId, false);
          setThinkStage('generating', 'reading history…');
          scanned = await scanFullHistory(chatId, chatName, (p) => {
            updateBadge(chatName, `reading history… ${p.scanned}`);
            setThinkStage('generating', `reading history… ${p.scanned}`);
          });
          setThinkStage('generating', 'summarizing…');
          updateBadge(chatName, 'summarizing…', 'warn');
          const fin = await chrome.runtime.sendMessage({ type: 'FINALIZE_CONTEXT', chatId, chatName });
          if (!fin?.ok) throw new Error(fin?.error);
          think.active = false;
          try { clearInterval(think.timer); } catch {}
          setThinkStage('sent', `saved ${scanned} msgs`);
          paintResult(`SAVED context (${scanned} msgs). ${ruleSnapshot(chatId)}`);
          sendResponse({ ok: true, scanned, contextMd: fin.contextMd });
          updateBadge(chatName, `context built (${scanned} msgs)`, 'ok');
          break;
        }
        case 'BUILD_CONTEXT_NAMED': {
          await openChatByName(msg.name);
          await sleep(1500);
          const { chatId, chatName } = activeChatKey();
          // Never build memory for a lookalike the search fallback opened.
          if (chatName.trim().toLowerCase() !== String(msg.name || '').trim().toLowerCase()) {
            throw new Error(`opened "${chatName}" but you asked for "${msg.name}" — build aborted. Use the exact chat name.`);
          }
          startThinking(chatName, [], chatId, false);
          setThinkStage('generating', `reading ${msg.name}…`);
          const scanned = await scanFullHistory(chatId, chatName, (p) => {
            updateBadge(chatName, `reading ${msg.name}… ${p.scanned}`);
            setThinkStage('generating', `reading… ${p.scanned}`);
          });
          setThinkStage('generating', 'summarizing…');
          updateBadge(chatName, 'summarizing…', 'warn');
          const fin = await chrome.runtime.sendMessage({ type: 'FINALIZE_CONTEXT', chatId, chatName });
          think.active = false;
          try { clearInterval(think.timer); } catch {}
          setThinkStage('sent', `saved ${scanned} msgs`);
          paintResult(`SAVED context (${scanned} msgs). ${ruleSnapshot(chatId)}`);
          sendResponse({ ok: true, scanned, chatName, contextMd: fin?.contextMd });
          break;
        }
        default: sendResponse({ ok: false, code: 'UNKNOWN_TYPE', error: `unknown content type: ${msg?.type}` });
      }
    })().catch((e) => {
      // Never leave the thinking pill spinning on a failed build/send:
      // park it as failed so seconds stop and state is honest.
      try {
        if (think.active && /^(BUILD|SEND|MANUAL)/.test(msg?.type || '')) endThinking(null, 'failed');
      } catch {}
      sendResponse({ ok: false, code: e?.code || 'ERROR', error: String(e.message || e) });
    });
    return true;
  });

  // ---------- dock build action (shared by button + /build) ----------
  async function doBuild() {
    const { chatName } = activeChatKey();
    revealFeedback('reading history…');
    try {
      const { chatId } = activeChatKey();
      // Run inside the thinking view: elapsed seconds count, stages show,
      // and the badge can't fall back to idle mid-summarize.
      startThinking(chatName, [], chatId, false);
      setThinkStage('generating', 'reading history…');
      const scanned = await scanFullHistory(chatId, chatName, (p) => {
        updateBadge(chatName, `reading… ${p.scanned}`, 'warn');
        setThinkStage('generating', `reading history… ${p.scanned}`);
      });
      setThinkStage('generating', 'summarizing…');
      updateBadge(chatName, 'summarizing…', 'warn');
      const fin = await chrome.runtime.sendMessage({ type: 'FINALIZE_CONTEXT', chatId, chatName });
      if (!fin?.ok) throw new Error(fin?.error || 'summarize failed');
      updateBadge(chatName, `context saved (${scanned})`, 'ok');
      think.active = false;
      try { clearInterval(think.timer); } catch {}
      setThinkStage('sent', `saved ${scanned} msgs`);
      paintResult(`SAVED context (${scanned} msgs). ${ruleSnapshot(chatId)}`);
      paintOnboarding();
    } catch (e) {
      endThinking(null, 'build failed: ' + String(e.message || e).slice(0, 80));
      updateBadge(chatName, 'error: ' + String(e.message || e).slice(0, 80), 'err');
    }
  }

  // ---------- dock subbots section ----------
  let dockSubbots = [];
  function dockEl(id) {
    try { return document.querySelector(id); } catch { return null; }
  }
  async function refreshDockBots() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SUBBOT_LIST' });
      dockSubbots = r?.subbots || [];
    } catch { dockSubbots = []; }
    paintDockBots();
  }
  function paintDockBots() {
    const sum = dockEl('#wb-bots-sum');
    const list = dockEl('#wb-sublist');
    const count = dockEl('#wb-count');
    if (!sum || !list) return;
    const running = dockSubbots.filter((b) => b.kind === 'watch' && b.status === 'running');
    const paused = dockSubbots.filter((b) => b.kind === 'watch' && b.status === 'paused');
    sum.textContent = running.length ? `${running.length} watching` : paused.length ? 'paused' : 'off';
    if (count) {
      count.hidden = !running.length;
      count.textContent = running.length > 9 ? '9+' : String(running.length);
    }
    list.textContent = '';
    const active = dockSubbots.filter((b) => b.status === 'running' || b.status === 'paused').slice(0, 5);
    const hist = dockSubbots.filter((b) => b.status !== 'running' && b.status !== 'paused').slice(0, 5);
      const mkBtn = (parent, label, fn, primary = false, danger = false) => {
        const b = document.createElement('button');
        b.className = 'wb-mini' + (primary ? ' primary' : '') + (danger ? ' danger' : '');
        b.textContent = label;
        b.onclick = fn;
        parent.appendChild(b);
      };
    const card = (b) => {
      const card = document.createElement('div');
      card.className = 'wb-botcard';
      const top = document.createElement('div');
      top.className = 'wb-bottop';
      const dot = document.createElement('span');
      dot.className = 'wb-dot' + (b.status === 'running' ? ' ok' : b.status === 'paused' ? ' warn' : b.status === 'error' ? ' err' : '');
      dot.style.marginLeft = '0';
      const nm = document.createElement('span');
      nm.textContent = `${b.name} · ${b.status}`;
      top.appendChild(dot); top.appendChild(nm);
      card.appendChild(top);
      const sub = document.createElement('div');
      sub.className = 'wb-botsub';
      sub.textContent = b.kind === 'watch'
        ? `target: ${b.target} · runs: ${b.runCount}`
        : (b.lastResult ? b.lastResult.slice(0, 140) : b.lastError ? `error: ${b.lastError.slice(0, 140)}` : 'not run yet');
      card.appendChild(sub);
      const btns = document.createElement('div');
      btns.className = 'wb-botbtns';
      const op = async (label, type, extra = {}) => {
        try {
          const r = await chrome.runtime.sendMessage({ type, id: b.id, ...extra });
          if (!r?.ok) paintResult(`BOT ${label.toUpperCase()} FAILED: ${r?.error || 'unknown'}`);
          refreshDockBots();
        } catch (e) { paintResult(`BOT ${label.toUpperCase()} FAILED: ${String(e.message || e)}`); }
      };
      if (b.kind === 'watch') {
        if (b.status === 'running') mkBtn(btns, 'Pause', () => op('pause', 'SUBBOT_OP', { op: 'pause' }));
        if (b.status === 'paused') mkBtn(btns, 'Resume', () => op('resume', 'SUBBOT_OP', { op: 'resume' }));
        if (b.status === 'stopped') mkBtn(btns, 'Restart', () => op('restart', 'SUBBOT_OP', { op: 'restart' }));
        if (b.status === 'running' || b.status === 'paused') mkBtn(btns, 'Stop', () => op('stop', 'SUBBOT_OP', { op: 'stop' }));
      } else if (b.status === 'done' || b.status === 'error') {
        mkBtn(btns, 'Re-run', async () => {
          try {
            const r = await chrome.runtime.sendMessage({ type: 'SUBBOT_CONFIRM', draft: { kind: 'task', target: b.target, task: b.task || b.userText, name: b.name, userText: b.userText } });
            paintResult(r?.ok ? `RE-RUN DONE:\n${(r.subbot.lastResult || '').slice(0, 800)}` : `RE-RUN FAILED: ${r?.error}`);
            refreshDockBots();
          } catch (e) { paintResult(`RE-RUN FAILED: ${String(e.message || e)}`); }
        });
      }
      mkBtn(btns, 'Delete', () => op('delete', 'SUBBOT_OP', { op: 'delete' }), false, true);
      card.appendChild(btns);
      return card;
    };
    if (!active.length && !hist.length) {
      const h = document.createElement('div');
      h.className = 'wb-botsub';
      h.textContent = 'No subbots yet. Describe one above.';
      list.appendChild(h);
      return;
    }
    active.forEach((b) => list.appendChild(card(b)));
    if (hist.length) {
      const h = document.createElement('div');
      h.className = 'wb-botsub';
      h.textContent = 'History:';
      list.appendChild(h);
      hist.forEach((b) => list.appendChild(card(b)));
    }
  }

  async function dockSubRun(prefill) {
    const input = dockEl('#wb-subnew');
    const text = (prefill ?? input?.value ?? '').trim();
    if (!text) return;
    if (input) input.value = '';
    pushCmdHist(text);
    const { chatId, chatName } = activeChatKey();
    revealFeedback('working…');
    startThinking(chatName, [{ sender: 'You', text: `New bot: ${text}` }], chatId, false);
    setThinkStage('generating', 'understanding…');
    updateBadge(chatName, 'understanding subbot…', 'warn');
    const box = dockEl('#wb-subconfirm');
    if (box) box.textContent = '';
    paintResult('SUBBOT: understanding…');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SUBBOT_PARSE', text });
      if (!r?.ok) throw new Error(r?.error || 'parse failed');
      // Canonicalize the target against the live chat list before showing
      // the confirm card: `business_assistant` → `Business assistant`.
      // Otherwise the user confirms a phantom id and the watcher runs:0.
      try {
        if (r.draft?.kind === 'watch' && r.draft?.target) {
          const norm = (s) => String(s || '').trim().toLowerCase().replace(/[_–—-]+/g, ' ').replace(/\s+/g, ' ');
          const want = norm(r.draft.target);
          const chats = listChats();
          const hit = chats.find((c) => norm(c.name) === want)
            || chats.find((c) => norm(c.name).includes(want.slice(0, 12)) || want.includes(norm(c.name)));
          if (hit?.name) {
            r.draft.target = hit.name;
            if (hit.kind === 'group') r.draft.targetKind = 'group';
          } else {
            r.draft.target = String(r.draft.target).replace(/[_–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
          }
        }
      } catch {}
      dockSubConfirm(r.draft, text);
      endThinking(undefined); // park spinner: waiting on user confirmation
      updateBadge(chatName, 'review the confirm card', 'warn');
    } catch (e) {
      endThinking(null, 'failed');
      paintResult(`SUBBOT FAILED: ${String(e.message || e)}`);
      updateBadge(chatName, 'subbot failed', 'err');
    }
  }

  function dockSubConfirm(draft, userText) {
    const box = dockEl('#wb-subconfirm');
    if (!box) return;
    box.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'wb-botcard wb-confirm';
    const t = document.createElement('div');
    t.className = 'wb-bottop';
    t.textContent = `Confirm ${draft.kind} bot — ${draft.name}`;
    wrap.appendChild(t);
    let targetInput = null, instrInput = null;
    if (draft.kind === 'watch') {
      // Keystrokes here must never reach WhatsApp (Escape would close WA
      // panels mid-typing); Enter in the target field confirms.
      const isolate = (el, onEnter) => el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && onEnter && el.tagName !== 'TEXTAREA') { e.preventDefault(); onEnter(); }
      });
      const r1 = document.createElement('div'); r1.className = 'wb-subrow';
      targetInput = document.createElement('input');
      targetInput.value = draft.target || '';
      targetInput.placeholder = 'Target person';
      r1.appendChild(targetInput); wrap.appendChild(r1);
      const r2 = document.createElement('div'); r2.className = 'wb-subrow';
      instrInput = document.createElement('textarea');
      instrInput.rows = 2;
      instrInput.value = draft.instruction || '';
      instrInput.placeholder = 'How it replies';
      r2.appendChild(instrInput); wrap.appendChild(r2);
      // doStart is defined below; the closure runs on keypress, after init.
      isolate(targetInput, () => doStart());
      isolate(instrInput, null);
    } else {
      const h = document.createElement('div');
      h.className = 'wb-botsub'; h.textContent = draft.task || userText;
      wrap.appendChild(h);
    }
    const row = document.createElement('div'); row.className = 'wb-botbtns';
    const start = document.createElement('button');
    start.className = 'wb-mini primary'; start.textContent = 'Start';
    const doStart = async () => {
      try {
        if (draft.kind === 'watch') {
          draft.target = (targetInput?.value || '').trim();
          draft.instruction = (instrInput?.value || '').trim();
        }
        setThinkStage('generating', 'starting…');
        paintResult('SUBBOT: starting… (tasks may take a minute)');
        const s = await chrome.runtime.sendMessage({ type: 'SUBBOT_CONFIRM', draft: { ...draft, userText } });
        if (!s?.ok) throw new Error(s?.error || 'start failed');
        box.textContent = '';
        if (draft.kind === 'watch') {
          endTask('watching', `${s.subbot.target} — replies until stopped. Pause/Stop anytime in Bots.`);
        } else {
          endTask('task done', (s.subbot.lastResult || s.subbot.lastError || 'done').slice(0, 800));
        }
        refreshDockBots();
      } catch (e) {
        endThinking(null, 'failed');
        paintResult(`SUBBOT FAILED: ${String(e.message || e)}`);
      }
    };
    start.onclick = doStart;
    const cancel = document.createElement('button');
    cancel.className = 'wb-mini'; cancel.textContent = 'Cancel';
    cancel.onclick = () => { box.textContent = ''; endTask('cancelled', 'Subbot creation cancelled.'); };
    row.appendChild(start); row.appendChild(cancel);
    wrap.appendChild(row);
    box.appendChild(wrap);
    // Unstick: the confirm card renders inside the Bots section — make sure
    // it is visible (section open, panel open, scrolled into view), otherwise
    // the pill parks at "review the confirm card" with nothing to review.
    try {
      openDockSubsec();
      wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      targetInput?.focus?.();
    } catch {}
  }

  function wireDockBots(dock) {
    // Reply/Bots tabs (remembered). The old collapsed toggle is gone: bots
    // get equal footing instead of hiding at the bottom.
    const show = (which) => {
      const bots = which === 'bots';
      const paneR = dock.querySelector('#wb-pane-reply');
      const paneB = dock.querySelector('#wb-pane-bots');
      const tabR = dock.querySelector('#wb-tab-reply');
      const tabB = dock.querySelector('#wb-tab-bots');
      if (paneR) paneR.hidden = bots;
      if (paneB) paneB.hidden = !bots;
      tabR?.classList.toggle('active', !bots);
      tabB?.classList.toggle('active', bots);
      try { tabR?.setAttribute('aria-selected', String(!bots)); } catch {}
      try { tabB?.setAttribute('aria-selected', String(bots)); } catch {}
      try { localStorage.setItem('wb_docktab', which); } catch {}
      if (bots) refreshDockBots();
    };
    const tabR = dock.querySelector('#wb-tab-reply');
    const tabB = dock.querySelector('#wb-tab-bots');
    if (tabR) tabR.onclick = () => show('reply');
    if (tabB) tabB.onclick = () => show('bots');
    let init = 'reply';
    try { if (localStorage.getItem('wb_docktab') === 'bots') init = 'bots'; } catch {}
    // Migrate the old collapsed-section preference: previously-open → Bots tab.
    try { if (localStorage.getItem('wb_subsec') === '1') { init = 'bots'; localStorage.removeItem('wb_subsec'); } } catch {}
    show(init);
    dock.querySelector('#wb-subrun').onclick = () => dockSubRun();
    const subnew = dock.querySelector('#wb-subnew');
    wireHistory(subnew);
    subnew.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); dockSubRun(); }
      e.stopPropagation();
    });
  }

  // ---------- command history (↑/↓ walks previous inputs, last 50, draft kept) ----------
  const HIST_KEY = 'wb_taskhist';
  const HIST_MAX = 50;
  const cmdHist = { items: [], idx: -1, draft: '' };
  async function loadCmdHist() {
    try {
      const r = await chrome.storage.local.get([HIST_KEY]);
      if (Array.isArray(r[HIST_KEY])) cmdHist.items = r[HIST_KEY].filter((s) => typeof s === 'string').slice(0, HIST_MAX);
    } catch {}
  }
  async function pushCmdHist(text) {
    const t = (text || '').trim();
    if (!t) return;
    if (cmdHist.items[0] !== t) {
      cmdHist.items.unshift(t);
      cmdHist.items = cmdHist.items.slice(0, HIST_MAX);
      try { await chrome.storage.local.set({ [HIST_KEY]: cmdHist.items }); } catch {}
    }
    cmdHist.idx = -1;
    cmdHist.draft = '';
  }
  function wireHistory(input) {
    // Separate listener from the Enter-submit one; both coexist.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      if (!cmdHist.items.length) return;
      if (cmdHist.idx === -1) cmdHist.draft = input.value; // stash current line
      if (e.key === 'ArrowUp') cmdHist.idx = Math.min(cmdHist.idx + 1, cmdHist.items.length - 1);
      else cmdHist.idx = cmdHist.idx - 1;
      input.value = cmdHist.idx === -1 ? cmdHist.draft : (cmdHist.items[cmdHist.idx] || '');
      try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
    });
  }

  // ---------- slash commands + task box ----------
  function wireTaskBox(dock) {
    const taskInput = dock.querySelector('#wb-task');
    const submitTask = () => {
      const v = taskInput.value;
      taskInput.value = '';
      try { taskInput.blur(); } catch {}
      pushCmdHist(v);
      routeTaskInput(v);
    };
    wireHistory(taskInput);
    dock.querySelector('#wb-go').onclick = submitTask;
    taskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitTask(); }
      e.stopPropagation(); // don't leak keystrokes into WhatsApp shortcuts
    });
  }

  function routeTaskInput(raw) {
    const t = (raw || '').trim();
    if (!t) return;
    if (!t.startsWith('/')) return runTask(t);
    const [cmd, ...rest] = t.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const { chatId, chatName } = activeChatKey();
    switch ((cmd || '').toLowerCase()) {
      case 'reply': return manualReply();
      case 'build': return doBuild();
      case 'auto': return doAutoInstruction(chatId, chatName, /^(overwrite|force|replace)$/i.test(arg));
      case 'code': {
        if (!arg) { paintResult('USAGE: /code your task for the device agent'); return; }
        const prefix = (storeCache.global.routePrefix || '/code');
        return runTask(`${prefix} ${arg}`);
      }
      case 'report': return runTask('report unread');
      case 'msg': return runTask(arg.startsWith('msg ') ? arg : `msg ${arg}`);
      case 'newbot':
        if (!arg) { paintResult('USAGE: /newbot respond to NAME continuously'); return; }
        openDockSubsec();
        dockSubRun(arg);
        return;
      case 'stop':
      case 'pause':
        if (/^(bots|all|watch)/i.test(arg) || !arg) {
          dock.querySelector('#wb-panic')?.click();
          return;
        }
        // Per-bot stop by name: find running/paused watch bot and stop it.
        try {
          const name = arg.trim().toLowerCase();
          chrome.runtime.sendMessage({ type: 'SUBBOT_LIST' }).then((r) => {
            const hit = (r?.subbots || []).find((b) => b.kind === 'watch' &&
              (b.status === 'running' || b.status === 'paused') &&
              String(b.target || '').toLowerCase() === name);
            if (!hit) { paintResult(`No running watch bot for "${arg}". Try /stop bots.`); return; }
            chrome.runtime.sendMessage({ type: 'SUBBOT_OP', op: 'stop', id: hit.id }).then((s) => {
              paintResult(s?.ok ? `Stopped "${hit.target}".` : `STOP FAILED: ${s?.error || 'unknown'}`);
            });
          });
        } catch (e) { paintResult(`STOP FAILED: ${String(e.message || e)}`); }
        return;
      case 'help':
        paintResult('COMMANDS:\n/reply — answer open chat\n/build — build context\n/auto [overwrite] — draft + save this chat\'s instruction\n/code … — device task in open chat\n/newbot … — launch subbot\n/report — unread report\n/msg NAME that TEXT — send message\n/stop bots — pause all watchers\n/stop NAME — stop watcher for NAME');
        return;
      default:
        paintResult(`Unknown command /${cmd}. Try /help.`);
    }
  }

  // Dock shortcut for the auto-instruction builder: drafts the open chat's
  // instruction from history + memory and saves it (overwrite flag only).
  async function doAutoInstruction(chatId, chatName, overwrite = false) {
    revealFeedback('drafting instruction…');
    startThinking(chatName, [{ sender: 'You', text: 'Auto instruction' }], chatId, false);
    setThinkStage('generating', 'drafting instruction…');
    try {
      const r = await sendToBrain({ type: 'AUTO_INSTRUCTION', chatId, chatName, overwrite });
      if (!r?.ok) throw new Error(r?.error || 'auto-draft failed');
      if (r.saved) endTask('instruction saved', r.instruction);
      else endTask('instruction kept', 'Instruction already set — re-run with /auto overwrite to replace it.');
      paintOnboarding();
    } catch (e) {
      endThinking(null, 'failed');
      paintResult(`AUTO-INSTRUCTION FAILED: ${String(e.message || e)}\n${ruleSnapshot(chatId)}`);
    }
  }

  function openDockSubsec() {
    try {
      const pane = document.querySelector('#wb-pane-bots');
      if (pane && pane.hidden) document.querySelector('#wb-tab-bots')?.click();
      const panel = document.getElementById('whatsbot-panel');
      if (panel?.hidden) document.querySelector('#wb-fab')?.click();
    } catch {}
  }

  // ---------- first-run onboarding checklist ----------
  function paintOnboarding() {
    try {
      const box = document.querySelector('#wb-onboard');
      if (!box) return;
      const g = storeCache.global || {};
      const chats = Object.values(storeCache.chats || {});
      const hasKey = (storeCache.hasKey || {})[g.activeProvider || 'openai'] || false;
      const steps = [
        ['Open WhatsApp & scan QR', !!(window.WADOM && window.WADOM.isLoaded())],
        ['Add an API key (extension icon → Model)', hasKey],
        ['Allow a chat + write its instruction (Console §3)', chats.some((c) => c.instruction?.trim())],
        ['Build its context (dock Build button)', chats.some((c) => c.contextMd)],
        ['Enable the bot (extension icon switch)', !!g.enabled],
      ];
      const allDone = steps.every(([, d]) => d);
      const doneN = steps.filter(([, d]) => d).length;
      box.hidden = !!g.onboarded || allDone;
      if (box.hidden) return;
      const count = box.querySelector('#wb-obcount');
      if (count) count.textContent = `${doneN}/${steps.length}`;
      const fill = box.querySelector('#wb-ofill');
      if (fill) fill.style.width = `${Math.round((doneN / steps.length) * 100)}%`;
      const wrap = box.querySelector('#wb-steps');
      wrap.textContent = '';
      for (const [label, done] of steps) {
        const row = document.createElement('div');
        row.className = 'wb-step' + (done ? ' done' : '');
        const dot = document.createElement('span'); dot.className = 'st-dot';
        const tx = document.createElement('span'); tx.textContent = label;
        row.appendChild(dot); row.appendChild(tx);
        wrap.appendChild(row);
      }
    } catch {}
  }

  // ---------- floating UI (FAB + dock card, SVG, light/dark) ----------
  let badgeTimer = null;
  function updateBadge(chatName, text, kind = '') {
    if (!floatingPanel) return;
    const b = floatingPanel.querySelector('.wb-status');
    if (b) b.textContent = `${chatName}: ${text}`;
    const dot = floatingPanel.querySelector('.wb-dot');
    const ring = document.querySelector('#wb-fab .wb-ring');
    if (dot) {
      dot.className = 'wb-dot' + (kind ? ' ' + kind : '');
      if (!kind) dot.classList.toggle('ok', !!storeCache.global.enabled);
    }
    if (ring) {
      ring.className = 'wb-ring' + (kind ? ' ' + kind : (storeCache.global.enabled ? ' ok' : ''));
    }
    // Single status source: the thinking pill owns live state. The badge
    // keeps errors until the next action; transient notes fall back to idle
    // (never while a job is still running).
    try { if (badgeTimer) clearTimeout(badgeTimer); } catch {}
    badgeTimer = null;
    if (b && kind !== 'err') {
      badgeTimer = setTimeout(() => {
        try { if (floatingPanel && !think.active) b.textContent = `${chatName}: idle`; } catch {}
      }, kind === 'ok' ? 5000 : 8000);
    }
  }

  // Every element id the wiring/feedback below depends on. A dock missing
  // ANY of these is stale (built by older code) and must be rebuilt — a
  // half-wired dock renders but silently does nothing.
  const DOCK_IDS = ['#wb-think', '#wb-thinktxt', '#wb-elapsed', '#wb-detail', '#wb-quote', '#wb-tsteps', '#wb-brain', '#wb-scan', '#wb-dom', '#wb-session', '#wb-rlabel', '#wb-sent', '#wb-result', '#wb-task', '#wb-go', '#wb-tab-reply', '#wb-tab-bots', '#wb-pane-reply', '#wb-pane-bots', '#wb-subsec', '#wb-bots-sum', '#wb-subnew', '#wb-subrun', '#wb-subconfirm', '#wb-sublist', '#wb-panic', '#wb-dismiss', '#wb-onboard', '#wb-obcount', '#wb-ofill', '#wb-steps', '#wb-reply', '#wb-build', '#wb-fab', '#wb-hide', '#wb-drag', '#wb-ver', '#wb-count', '.wb-status'];
  function injectPanel() {
    const old = document.getElementById('whatsbot-dock');
    if (old) {
      const complete = DOCK_IDS.every((s) => { try { return !!old.querySelector(s); } catch { return false; } });
      if (complete) { floatingPanel = document.getElementById('whatsbot-panel'); return; }
      old.remove(); // stale/partial dock — rebuild fully
    }
    const dock = document.createElement('div');
    dock.id = 'whatsbot-dock';
    dock.dataset.theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    dock.innerHTML = `
      <div id="whatsbot-panel" role="complementary" aria-label="WhatsBot assistant panel">
        <div class="wb-head" id="wb-drag">
          <span class="wb-mark"><svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="5"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/><path d="M12 8V4M8 4h8"/></svg></span>
          <span>WhatsBot</span>
          <span class="wb-ver" id="wb-ver" title="Build stamp — proves which code this tab runs"></span>
          <span class="wb-dot" aria-hidden="true"></span>
          <button class="wb-panic" id="wb-panic" title="Pause ALL watch bots immediately" aria-label="Pause all watch bots immediately"><svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 5v14M15 5v14"/></svg></button>
          <button class="wb-hide" id="wb-hide" title="Collapse" aria-label="Collapse WhatsBot panel"><svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </div>
        <div class="wb-status" role="status" aria-live="polite">waiting for WhatsApp…</div>
        <div class="wb-onboard" id="wb-onboard" hidden>
          <div class="wb-dsec">Setup <span id="wb-obcount">0/5</span></div>
          <div class="wb-obar"><div class="wb-ofill" id="wb-ofill"></div></div>
          <div id="wb-steps"></div>
          <div class="wb-subrow"><button class="wb-mini" id="wb-dismiss">Dismiss</button></div>
        </div>
        <div class="wb-tabs" role="tablist">
          <button class="wb-tab active" id="wb-tab-reply" role="tab" aria-selected="true">Reply</button>
          <button class="wb-tab" id="wb-tab-bots" role="tab" aria-selected="false">Bots&nbsp;<span id="wb-bots-sum">off</span></button>
        </div>
        <div id="wb-pane-reply">
        <button class="wb-think" id="wb-think" title="Show thinking details" hidden>
          <span class="wb-spinner"></span><span id="wb-thinktxt">thinking…</span><span id="wb-elapsed">0s</span>
        </button>
        <div class="wb-detail" id="wb-detail" hidden>
          <div class="wb-dsec">Replying to</div>
          <div class="wb-quote" id="wb-quote" dir="auto"></div>
          <div class="wb-dsec">Progress</div>
          <div id="wb-tsteps"></div>
          <div class="wb-dsec">Brain</div>
          <div class="wb-brain" id="wb-brain"></div>
          <div class="wb-dsec">Scan</div>
          <div class="wb-brain" id="wb-scan">—</div>
          <div class="wb-dsec">DOM</div>
          <div class="wb-brain wb-mono" id="wb-dom">—</div>
          <div class="wb-dsec">Session</div>
          <div class="wb-brain" id="wb-session">—</div>
          <div class="wb-dsec" id="wb-rlabel" hidden>Sent</div>
          <div class="wb-sent" id="wb-sent" dir="auto" hidden></div>
          <div class="wb-dsec">Last result</div>
          <div class="wb-brain" id="wb-result">—</div>
        </div>
        <div class="wb-row">
          <button class="wb-btn primary" id="wb-reply"><svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/></svg>AI Reply</button>
          <button class="wb-btn" id="wb-build"><svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 20H4v-3"/><path d="M4 12h16"/></svg>Build</button>
        </div>
        <div class="wb-taskrow">
          <input id="wb-task" dir="auto" placeholder='Task, or /reply /build /auto /newbot /report /msg /stop' maxlength="500">
          <button class="wb-go" id="wb-go" title="Run task"><svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m0 0l-5-5m5 5l-5 5"/></svg></button>
        </div>
        </div>
        <div id="wb-pane-bots" hidden>
        <div class="wb-subsec" id="wb-subsec">
          <div class="wb-subrow">
            <input id="wb-subnew" dir="auto" placeholder="New bot: respond to … / list …" maxlength="300">
            <button class="wb-mini primary" id="wb-subrun">Run</button>
          </div>
          <div id="wb-subconfirm"></div>
          <div id="wb-sublist"></div>
        </div>
        </div>
      </div>
      <button id="wb-fab" title="WhatsBot — toggle panel" aria-label="Toggle WhatsBot panel" aria-expanded="true">
        <svg class="wb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="5"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/><path d="M12 8V4M8 4h8"/></svg>
        <span class="wb-ring" aria-hidden="true"></span>
        <span class="wb-count" id="wb-count" hidden>0</span>
      </button>`;
    document.body.appendChild(dock);
    floatingPanel = dock.querySelector('#whatsbot-panel');
    try { dock.querySelector('#wb-ver').textContent = CODE_VERSION; } catch {}
    const panel = floatingPanel;
    const fab = dock.querySelector('#wb-fab');
    // Safe wiring helper: a missing element skips instead of aborting the
    // whole panel (one absent id must never deaden every button).
    const wire = (id, fn) => {
      const el = dock.querySelector(id);
      if (el) el.onclick = fn;
      return el;
    };
    try { if (localStorage.getItem('wb_collapsed') === '1') panel.hidden = true; } catch {}
    try { fab.setAttribute('aria-expanded', String(!panel.hidden)); } catch {}
    fab.onclick = () => {
      panel.hidden = !panel.hidden;
      try { fab.setAttribute('aria-expanded', String(!panel.hidden)); } catch {}
      try { localStorage.setItem('wb_collapsed', panel.hidden ? '1' : '0'); } catch {}
    };
    wire('#wb-hide', () => {
      panel.hidden = true;
      try { fab.setAttribute('aria-expanded', 'false'); } catch {}
      try { localStorage.setItem('wb_collapsed', '1'); } catch {}
    });
    // thinking detail drawer: click the thinking pill to expand/collapse
    wire('#wb-think', () => {
      const det = dock.querySelector('#wb-detail');
      if (!det) return;
      det.hidden = !det.hidden;
      think.open = !det.hidden;
      try { dock.querySelector('#wb-think')?.setAttribute('aria-expanded', String(!det.hidden)); } catch {}
    });
    wire('#wb-dismiss', async () => {
      try {
        const r = await chrome.storage.local.get(['wb_global']);
        await chrome.storage.local.set({ wb_global: { ...(r.wb_global || {}), onboarded: true } });
      } catch {}
      paintOnboarding();
    });
    // drag via header (pointer, small movement only)
    (() => {
      const head = dock.querySelector('#wb-drag');
      if (!head) return;
      let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.wb-hide')) return;
        drag = true; sx = e.clientX; sy = e.clientY;
        const r = dock.getBoundingClientRect();
        ox = window.innerWidth - r.right; oy = window.innerHeight - r.bottom;
        head.setPointerCapture(e.pointerId);
      });
      head.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const nx = Math.max(8, ox + (sx - e.clientX));
        const ny = Math.max(8, oy + (sy - e.clientY));
        dock.style.right = nx + 'px'; dock.style.bottom = ny + 'px';
      });
      head.addEventListener('pointerup', () => { drag = false; });
    })();
    wire('#wb-reply', () => manualReply());
    // panic: pause every watch bot immediately
    wire('#wb-panic', async () => {
      const { chatName } = activeChatKey();
      try {
        updateBadge(chatName, 'pausing all bots…', 'warn');
        const r = await chrome.runtime.sendMessage({ type: 'SUBBOT_PAUSE_ALL' });
        if (!r?.ok) throw new Error(r?.error || 'panic failed');
        paintResult(`PANIC: paused ${r.paused} watch bot(s). Resume individually from Bots.`);
        updateBadge(chatName, `paused ${r.paused} bot(s)`, 'warn');
        refreshDockBots();
      } catch (e) { paintResult(`PANIC FAILED: ${String(e.message || e)}`); updateBadge(chatName, 'panic failed', 'err'); }
    });
    wire('#wb-build', () => doBuild());
    wireDockBots(dock);
    wireTaskBox(dock);
    paintOnboarding();
    refreshDockBots();
    // Follow OS theme while stored theme is 'system' (mirror ui/theme.js).
    try {
      if (!injectPanel._themeWatch) {
        injectPanel._themeWatch = true;
        matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', async () => {
          try {
            const r = await chrome.storage.local.get(['wb_theme']);
            const stored = r?.wb_theme || 'system';
            if (stored === 'system') applyDockTheme('system');
          } catch {}
        });
      }
    } catch {}
    // toggle dot from storage + keep observer + onboarding fresh
    setInterval(async () => {
      try {
        await refreshStore();
        if (!floatingPanel?.isConnected) return;
        ensureObserver();
        paintOnboarding();
        // Preserve live status text across the refresh: split on the FIRST
        // ': ' only (chat names like 'Team: Ops' contain it too).
        const cur = floatingPanel.querySelector('.wb-status')?.textContent || '';
        const i = cur.indexOf(': ');
        updateBadge(window.WADOM.activeChatName() || '—', i >= 0 ? cur.slice(i + 2) : (cur || 'ready'));
      } catch {}
    }, 5000);
  }

  // ---------- boot ----------
  (async function boot() {
    await refreshStore();
    await loadCmdHist();
    injectPanel();
    paintOnboarding();
    const t = setInterval(() => {
      if (window.WADOM.isLoaded()) {
        clearInterval(t);
        // prime seen so old messages don't trigger replies
        readVisibleMessages().forEach((m) => seenMsgIds.add(m.msgId));
        watchNewMessages();
        updateBadge(window.WADOM.activeChatName() || '—', 'ready');
      }
    }, 1000);
  })();
})();
