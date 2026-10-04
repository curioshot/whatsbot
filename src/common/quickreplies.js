// Quick replies — user-written snippets, fully local (no AI, no network).
// Shape: {id, title, text, chats:['*'] or [chatIds], createdAt, uses}
// Pure helpers so node can unit-test them directly.
export const QUICK_MAX = 50;
export const QUICK_TITLE_MAX = 30;
export const QUICK_TEXT_MAX = 500;

let __qCounter = 0;
export function quickId() {
  __qCounter = (__qCounter + 1) % 46656;
  return `q-${Date.now().toString(36)}${__qCounter.toString(36).padStart(3, '0')}`;
}

export function validateQuick({ title, text }) {
  const t = String(title || '').trim();
  const x = String(text || '').trim();
  if (!t) return 'Give it a short name.';
  if (t.length > QUICK_TITLE_MAX) return `Name too long (max ${QUICK_TITLE_MAX}).`;
  if (!x) return 'Write the message text.';
  if (x.length > QUICK_TEXT_MAX) return `Text too long (max ${QUICK_TEXT_MAX}).`;
  return '';
}

// Snippets visible in a chat: global ones + ones scoped to this chat id.
// Unknown chat ids in scope are ignored (chat deleted → snippet hides).
export function matchQuickreplies(list, chatId) {
  return (list || []).filter((q) => {
    const scope = q?.chats || ['*'];
    return scope.includes('*') || scope.includes(chatId);
  });
}

export function findQuickreply(list, chatId, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const vis = matchQuickreplies(list, chatId);
  return vis.find((q) => String(q.title || '').trim().toLowerCase() === want)
    || vis.filter((q) => String(q.title || '').trim().toLowerCase().startsWith(want))[0]
    || null;
}

// {name} fills with the open chat's contact name on insert.
export function fillPlaceholders(text, chatName) {
  return String(text || '').replaceAll('{name}', String(chatName || '').trim() || 'there');
}
