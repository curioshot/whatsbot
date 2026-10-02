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
    msgText: ['div[data-testid="msg-text"]', 'span.selectable-text span', 'div.copyable-text'],
    msgMeta: ['div[data-testid="msg-meta"]', 'span[data-testid="msg-meta"]'],
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
  };
})();
