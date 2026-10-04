/* Centralized WhatsApp Web selectors — edit here when WA changes DOM.
   All functions are defensive: try several selectors, return null if missing. */
(function () {
  const SEL = {
    // App loaded indicator
    appRoot: ['#app', 'div[data-testid="app-container"]'],
    // Chat list pane
    chatList: ['div[aria-label="Chat list"]', '#pane-side div[role="grid"]', '#pane-side'],
    chatRow: ['div[role="row"]', 'div[data-testid="cell-frame-container"]'],
    // Search to switch chats
    searchBox: [
      'div[aria-label="Search input textbox"]',
      'div[data-testid="chat-list-search"]',
      '#side div[contenteditable="true"]',
    ],
    // New-chat (contacts) entry + pane
    newChatBtn: [
      'button[aria-label="New chat"]',
      'button[data-testid="new-chat-button"]',
      'button:has(span[data-icon="new-chat"])',
    ],
    contactsPane: [
      'div[aria-label="Contacts"]',
      'div[data-testid="contact-list"]',
      '#side div[role="listbox"]',
    ],
    contactsRow: [
      'div[role="option"]',
      'div[data-testid="cell-frame-container"]',
      'div[role="row"]',
    ],
    contactsBack: [
      'button[aria-label="Back"]',
      'button:has(span[data-icon="back"])',
    ],
    // Main conversation
    main: ['#main', 'div[data-testid="conversation-panel-wrapper"]'],
    convoBody: [
      'div[data-testid="conversation-panel-body"]',
      '#main div[role="log"]',
      '#main div[data-testid="conversation-panel-messages"]',
    ],
    headerTitle: ['#main header [data-testid="conversation-info-header-chat-title"]', '#main header span[title]', '#main header'],
    // Messages
    msgContainer: ['div[data-testid="msg-container"]'],
    msgIn: ['div.message-in'],
    msgOut: ['div.message-out'],
    // Any message row (container or bare bubble) — one selector for scans.
    msgRow: ['div[data-testid="msg-container"]', 'div.message-in', 'div.message-out'],
    msgText: ['div[data-testid="msg-text"]', 'span.selectable-text span', 'div.copyable-text'],
    msgMeta: ['div[data-testid="msg-meta"]', 'span[data-testid="msg-meta"]'],
    // Conversation header + side pane (chat list scope)
    header: ['#main header', 'div[data-testid="conversation-header"]'],
    sidePane: ['#pane-side', '#side'],
    unreadCount: ['div[data-testid="unread-count"]'],
    // Chat-row details (list parsing only — keep icon/testid lists here).
    rowTitle: ['[title]', 'span[title]'],
    rowGroupIcon: ['[data-icon^="default-group"]', '[data-icon="group"]', '[data-icon="default-groupv2"]'],
    // Composer
    composer: [
      'div[aria-label="Type a message"]',
      'div[data-testid="conversation-compose-box-input"] div[contenteditable="true"]',
      '#main footer div[contenteditable="true"]',
    ],
    sendBtn: ['button[aria-label="Send"]', 'button[data-testid="send"]', '#main footer button'],
  };

  function q(root, sels) {
    for (const s of sels) {
      try {
        const el = (root || document).querySelector(s);
        if (el) return el;
      } catch {}
    }
    return null;
  }
  function qa(root, sels) {
    for (const s of sels) {
      try {
        const els = (root || document).querySelectorAll(s);
        if (els && els.length) return [...els];
      } catch {}
    }
    return [];
  }

  window.WADOM = {
    SEL,
    q,
    qa,
    isLoaded() {
      return !!q(document, SEL.appRoot) && !!q(document, SEL.chatList);
    },
    chatListEl() { return q(document, SEL.chatList); },
    newChatBtnEl() { return q(document, SEL.newChatBtn); },
    contactsPaneEl() { return q(document, SEL.contactsPane); },
    convoBodyEl() { return q(document, SEL.convoBody); },
    composerEl() { return q(document, SEL.composer); },
    sendBtnEl() { return q(document, SEL.sendBtn); },
    searchBoxEl() { return q(document, SEL.searchBox); },
    activeChatName() {
      const h = q(document, SEL.headerTitle);
      if (!h) return '';
      return (h.getAttribute('title') || h.textContent || '').trim().slice(0, 120);
    },
    // Message-row helpers (single place for bubble class + testid knowledge).
    msgRowEls(root) { return qa(root || document, SEL.msgRow); },
    msgInEls(root) { return qa(root || document, SEL.msgIn); },
    closestRow(node) {
      try { return node?.closest?.('[data-testid="msg-container"]') || node; }
      catch { return node; }
    },
    isRowBubble(n) {
      try { return !!n?.matches?.('div.message-in, div.message-out'); }
      catch { return false; }
    },
    innerBubble(n) {
      try { return (n && !window.WADOM.isRowBubble(n) && n.querySelector?.('div.message-in, div.message-out')) || n; }
      catch { return n; }
    },
    hasIn(node) {
      try { return node?.classList?.contains('message-in') || !!node?.querySelector?.('.message-in'); }
      catch { return false; }
    },
    hasOut(node) {
      try { return node?.classList?.contains('message-out') || !!node?.querySelector?.('.message-out'); }
      catch { return false; }
    },
    rowTextEl(node) { return q(node, SEL.msgText); },
    rowMetaEl(node) { return q(node, SEL.msgMeta); },
    unreadCountEl(root) { return q(root || document, SEL.unreadCount); },
    rowTitleEl(row) { return q(row, SEL.rowTitle); },
    rowIsGroup(row) {
      try {
        for (const s of SEL.rowGroupIcon) {
          if (row?.querySelector?.(s)) return true;
        }
        return false;
      } catch { return false; }
    },
    sidePaneEl() { return q(document, SEL.sidePane); },
    headerEl() { return q(document, SEL.header); },
    // Group heuristic: member lists / comma names in the header. Locale-
    // fragile by nature — callers treat false as "unknown", never as 1:1
    // proof (the author-header signal decides).
    headerLooksGroup() {
      try {
        const h = window.WADOM.headerEl()?.innerText || '';
        return /members|,/.test(h);
      } catch { return false; }
    },
    hasPrePlain(root) {
      try { return !!(root || document).querySelector?.('[data-pre-plain-text]'); }
      catch { return false; }
    },
    // Layout self-test for the console: which selector families still hit
    // on the live tab, and how many nodes each finds. No message text.
    probeLayout() {
      const out = [];
      const checks = {
        app: SEL.appRoot, chatList: SEL.chatList, chatRow: SEL.chatRow, searchBox: SEL.searchBox,
        convoBody: SEL.convoBody, header: SEL.headerTitle, composer: SEL.composer,
        sendBtn: SEL.sendBtn, sidePane: SEL.sidePane, msgRow: SEL.msgRow,
        msgText: SEL.msgText, msgMeta: SEL.msgMeta,
      };
      for (const [k, sels] of Object.entries(checks)) {
        let found = '', n = 0;
        for (const s of sels) {
          try {
            const els = document.querySelectorAll(s);
            if (els && els.length) { found = s; n = els.length; break; }
          } catch {}
        }
        out.push({ key: k, ok: !!found, selector: found, count: n });
      }
      out.push({ key: 'groupHeuristic', ok: true, selector: 'header text', count: window.WADOM.headerLooksGroup() ? 1 : 0 });
      return out;
    },
  };
})();
