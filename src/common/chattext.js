// Plain-language chat summaries — every number becomes a sentence.
// Normal humans read these; codes and counters stay in diagnostics.
export function memorySentence(chat, logCount) {
  const n = Number(chat?.contextMsgCount || 0);
  if (n > 0) return `Knows you from ${n} message${n === 1 ? '' : 's'}`;
  if (Number(logCount || 0) > 0) return 'Has some history — saving teaches it';
  return 'No memory yet — saving teaches it';
}

export function chatStateSentence(chat, globalEnabled) {
  if (!chat) return 'Not set up yet';
  if (!String(chat.instruction || '').trim()) return 'Needs instructions';
  if (!chat.allowed) return 'Paused';
  if (!globalEnabled) return 'Ready — bot is off';
  if (String(chat.mode || 'auto') !== 'auto') return 'Manual replies only';
  return 'Answering';
}

// Chat-list marker state: which sign a chat row gets, if any.
// 'active' = instruction set + allowed (green dot).
// 'attention' = rule exists but paused or missing instruction (gray ring).
// 'none' = unknown chat (no marker, list stays clean).
export function rowMarkState(chat) {
  if (!chat) return 'none';
  if (String(chat.instruction || '').trim() && chat.allowed) return 'active';
  return 'attention';
}
