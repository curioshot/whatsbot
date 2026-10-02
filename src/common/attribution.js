// Speaker attribution — pure functions (no DOM, no chrome.*), unit-tested.
// Triple-signal rule: bubble class + data-id flag must AGREE on direction.
// data-id looks like "true_<hash>_..." (sent by you) or "false_<hash>_..." (received).
export function parseDataIdFlag(dataId) {
  const m = String(dataId || '').match(/^(true|false)_/);
  if (!m) return null;
  return m[1] === 'true' ? 'out' : 'in';
}

// pre-plain-text looks like "[14:02, 26/09/2026] Author Name: " → "Author Name"
export function parsePreAuthor(pre) {
  const m = String(pre || '').match(/\]\s*(.*?):\s*$/);
  const name = (m?.[1] || '').trim();
  return name || null;
}

// signals: { clsIn, clsOut, dataId, preAuthor, chatName, isGroup, align }
// align (optional layout fallback): 'left'|'right'|'center' — bubble center
// vs conversation center. Used ONLY when both primary signals are missing
// (never to overrule a disagreement).
// → { dir: 'in'|'out'|'uncertain', speaker: 'you'|'them'|'unknown', name, via }
export function attributeMessage(s) {
  const fromClass = s.clsOut && !s.clsIn ? 'out' : s.clsIn && !s.clsOut ? 'in' : null;
  const fromId = parseDataIdFlag(s.dataId);
  let dir;
  let via = 'signals';
  if (fromClass && fromId) {
    if (fromClass === fromId) dir = fromClass;
    else return { dir: 'uncertain', speaker: 'unknown', name: 'Unknown', via: 'conflict' };
  } else dir = fromClass || fromId || 'uncertain';
  if (dir === 'uncertain' && !fromClass && !fromId) {
    // layout fallback: incoming bubbles sit left, outgoing right
    if (s.align === 'left') { dir = 'in'; via = 'layout'; }
    else if (s.align === 'right') { dir = 'out'; via = 'layout'; }
  }

  if (dir === 'out') return { dir, speaker: 'you', name: 'You (phone owner)', via };
  if (dir === 'in') {
    // An explicit author header always wins — it is per-message evidence,
    // stronger than any chat-level group flag.
    const author = parsePreAuthor(s.preAuthor);
    const name = author || (s.isGroup ? `${s.chatName || 'Group'} (unknown author)` : s.chatName || 'Contact');
    return { dir, speaker: 'them', name, via };
  }
  return { dir, speaker: 'unknown', name: 'Unknown', via: fromClass || fromId ? 'conflict' : 'none' };
}

// NOTE (MV3 constraint): content scripts are classic scripts and cannot use
// ES modules, so content.js carries a small classic twin of attributeMessage
// (marked clearly there). This file is the tested spec — keep them in sync;
// fixtures live in test/attribution.test.mjs. formatTranscript IS imported
// by providers.js (service worker side), so the prompt rendering has exactly
// one implementation.

// Rigid machine-readable transcript for prompts. directionField: which key
// holds 'in'|'out'|'uncertain' ('dir' from content script).
export function formatTranscript(messages, { contactName = 'Contact', chatKind = '1:1' } = {}) {
  const lines = (messages || []).map((m) => {
    const t = String(m.text || '');
    if (m.speaker === 'you' || m.dir === 'out') return `YOU: ${t}`;
    if (m.speaker === 'unknown' || m.dir === 'uncertain') return `???: ${t}`;
    return `THEM (${m.name || m.sender || contactName}): ${t}`;
  });
  return [
    `Chat type: ${chatKind} with "${contactName}". YOU = sent by the phone owner (never answer these). THEM = incoming (answer only these). Lines starting with ??? have uncertain origin — ignore them.`,
    ...lines,
  ].join('\n');
}
