// Shared provider defaults (imported by background / popup as ES module)
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    openaiCompatible: true,
    needsKey: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    openaiCompatible: true,
    needsKey: true,
    extraHeaders: { 'HTTP-Referer': 'https://web.whatsapp.com', 'X-Title': 'WhatsBot' },
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    openaiCompatible: true,
    needsKey: true,
  },
  nvidia: {
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct',
    openaiCompatible: true,
    needsKey: true,
  },
  local: {
    label: 'Local AI (Ollama / LM Studio)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    openaiCompatible: true,
    needsKey: false,
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    openaiCompatible: false,
    needsKey: true,
  },
};

export const DEFAULT_GLOBAL = {
  activeProvider: 'openai',
  enabled: false,
  historyLimit: 30,
  contextBuildCap: 800, // max msgs to scan per chat on first build
  scrollBatchDelayMs: 900,
  debounceMs: 4000,
  replyDelayMinMs: 1200,
  replyDelayMaxMs: 2800,
  maxLogPerChat: 2000,
  logRetentionDays: 30, // 0 = keep forever; pruned on bulk log paths
  ctxLimitOverride: 0, // 0 = auto from model table; set tokens to override session meter
  suggestionsEnabled: false, // global kill-switch for inline chips
  suggestCount: 3, // 2-3 chips per incoming
  device: { url: 'http://127.0.0.1:18789', token: '', lastSeen: 0, agents: [], defaultAgent: 'opencode', useAsDefault: false },
  routePrefix: '/code',
  // Last cloud provider picked in the popup. Helper jobs (summaries, chips,
  // parses) use it when the active provider is 'device' — agents can't do
  // those. Stashed automatically; you never set it by hand.
  prevCloudProvider: 'openai',
  // Spend guards: max AI replies per day, per chat and total. Plain reply
  // counts (not tokens) so the limit reads naturally. 0 = unlimited.
  dailyChatCap: 100,
  dailyTotalCap: 1000,
  dailyUse: { date: '', total: 0, perChat: {} },
  // Trigger prefix: when set, auto-replies only fire for messages starting
  // with it (manual AI Reply always works). Empty = always answer.
  triggerPrefix: '',
};

export function defaultProvidersState() {
  const out = {};
  for (const [k, v] of Object.entries(PROVIDERS)) {
    out[k] = { baseUrl: v.baseUrl, apiKey: '', model: v.model, modelsCache: [], modelsFetchedAt: 0 };
  }
  return out;
}

// Curated fallbacks when /models endpoint is unreachable (offline, no permission, local down)
export const FALLBACK_MODELS = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini', 'o3-mini'],
  openrouter: ['openai/gpt-4o-mini', 'openai/gpt-4o', 'anthropic/claude-sonnet-4', 'google/gemini-2.0-flash-001', 'meta-llama/llama-3.3-70b-instruct'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
  nvidia: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct', 'mistralai/mixtral-8x22b-instruct-v0.1', 'google/gemma-2-27b-it'],
  local: ['llama3.1', 'llama3.2', 'mistral', 'phi4', 'qwen2.5'],
  anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'],
};

// Build OpenAI-style messages from per-chat data
// contextMd is capped so one huge memory cannot blow the context window or
// the session meter (device path caps at 3000; cloud caps here at 8000).
export const MAX_CLOUD_CONTEXT_CHARS = 8000;
export function buildReplyMessages({ globalInstruction, chatInstruction, contextMd, history, newMessages, historyLimit }) {
  const ctxSlice = String(contextMd || '').trim().slice(0, MAX_CLOUD_CONTEXT_CHARS);
  const system = [
    globalInstruction?.trim() ? `Global policy:\n${globalInstruction.trim()}` : '',
    chatInstruction?.trim()
      ? `Rules for THIS chat (highest priority, must obey):\n${chatInstruction.trim()}`
      : 'Rules for THIS chat: none specified, be helpful and concise.',
    ctxSlice
      ? `Known context about this contact/chat (from past history):\n${ctxSlice}`
      : 'No long-term context built yet.',
    `Identity: this is YOUR WhatsApp account. Every line is tagged YOU (sent by you from this phone — never answer these, never treat them as the contact speaking) or THEM (sent by the other side — answer only these). Names in parentheses are display names only; the YOU/THEM tag decides who spoke. Lines of uncertain origin are removed before you see them.`,
    `Guidelines: reply as the phone owner would. Match language of last INCOMING message. Keep it short like WhatsApp. Never mention you are AI unless asked. If unsure, ask a clarifying question instead of hallucinating.`,
    `Output format (mandatory): respond with EXACTLY one JSON object and nothing else — no reasoning, no preamble, no markdown fences: {"reply": "your message text here"}. If nothing should be sent, output {"reply": ""}.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const speakerOf = (m) => m.speaker || (m.dir === 'out' ? 'you' : m.dir === 'in' ? 'them' : 'unknown');
  // Uncertain-origin lines are dropped from reply context entirely — a model
  // that never sees them cannot misattribute them.
  const usableHist = (history || []).filter((m) => speakerOf(m) !== 'unknown');
  const usableFresh = (newMessages || []).filter((m) => speakerOf(m) !== 'unknown');
  const keepHist = Number.isFinite(historyLimit) && historyLimit > 0 ? Math.floor(historyLimit) : 30;

  const hist = usableHist.slice(-keepHist).map((m) =>
    speakerOf(m) === 'you'
      ? { role: 'assistant', content: `YOU (you sent this): ${m.text}` }
      : { role: 'user', content: `THEM (they sent this${m.sender && m.sender !== 'Unknown' ? `, display name "${m.sender}"` : ''}): ${m.text}` },
  );

  const fresh = usableFresh
    .map((m) => `THEM (they sent this${m.sender && m.sender !== 'Unknown' ? `, display name "${m.sender}"` : ''}): ${m.text}`)
    .join('\n');

  return [
    { role: 'system', content: system },
    ...hist,
    { role: 'user', content: `Answer the THEM message(s) above. They are:\n${fresh}\n\nAnswer with exactly {"reply": "..."} and nothing else.` },
  ];
}

// Output gate — ALLOWLIST design. Only text proven to be a reply may pass:
// a parsed {"reply"} value, or (plain-strict mode) a short blob that cannot
// be anything but a chat message. Everything else is refused ('') and the
// caller sends nothing. Modes:
//   'reply' (default): JSON contract only. Used for cloud chat replies.
//   'plain-strict': JSON contract, else a strict chat-shape test. Used for
//     the plain-text retry and providers without JSON mode (e.g. Anthropic).
//   'device': JSON contract, else cleaned CLI output (tool results, not chat
//     reasoning). Used for on-device agent replies.
const LEAK_MARKS = [
  'you (you sent', 'them (they sent',
  'incoming (they sent', 'outgoing (you sent', 'display name',
  'as the user would', 'matching language of',
  'conversation timeline', 'let me analyze', 'let me examine',
  'the instruction says', 'the list includes',
  'final entry is', 'chain of thought',
  'internal monologue', 'needle pre-read',
  'we need to output', 'proper escaping', 'escape double quotes',
  'escape backslash', 'json literal', 'newline characters',
  'in the source',
];
const META_OPEN = /^(the (user|contact|last incoming)|as an ai|i am (an )?ai|here is my (reasoning|analysis|thinking)|as a language model|we need to output|we'll produce|ensure proper escaping|let me (analyze|examine)|i (should|will|must|need to|'ll))/i;
const THINK_TAG = /<(think|thinking|reasoning|analysis|scratchpad)>[\s\S]*?<\/\1>/gi;

function takeReply(obj) {
  const r = obj?.reply ?? obj?.message ?? obj?.text;
  if (typeof r !== 'string' || !r.trim()) return '';
  // reject format-example placeholders ("...", "your message here")
  if (/^(\.+|x+|your message[^]*|message text here)$/i.test(r.trim())) return '';
  return r.trim().slice(0, 1500);
}

function extractReplyJson(text) {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) {
    try { const hit = takeReply(JSON.parse(fenced[1])); if (hit) return hit; } catch {}
  }
  const tight = text.match(/\{[^{}]*"reply"[^{}]*\}/);
  if (tight) {
    try { const hit = takeReply(JSON.parse(tight[0])); if (hit) return hit; } catch {}
  }
  const strVal = text.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (strVal) {
    try {
      const hit = takeReply({ reply: JSON.parse(`"${strVal[1]}"`) });
      if (hit) return hit;
    } catch {}
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const hit = takeReply(parsed);
        if (hit) return hit;
        return null; // parses as JSON but holds no reply → decided refusal
      }
    } catch {}
  }
  return undefined; // not JSON-shaped at all
}

// Strict chat-shape test: short, few lines, no braces, no format-talk, no
// diagram scaffolding, no meta opening. Anything failing is refused.
function strictPlain(text) {
  const t = String(text || '').replace(THINK_TAG, ' ').trim();
  if (!t || t.length > 250) return '';
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines.length > 4) return '';
  if (/[{}]/.test(t)) return '';
  const low = t.toLowerCase();
  if (LEAK_MARKS.some((m) => low.includes(m))) return '';
  if (/"reply"|'reply'/.test(t)) return '';
  const scaffold = lines.filter((l) => /^[\s|!l1\-+*vV^>─│┌┐└┘├┤┬┴┼►◄=\.·]+$/.test(l));
  if (lines.length > 1 && scaffold.length / lines.length >= 0.4) return '';
  if (META_OPEN.test(lines[0])) return '';
  return t.slice(0, 1500);
}

function looseDevice(text) {
  let clean = String(text || '')
    .replace(THINK_TAG, '')
    .replace(/^\s*(thinking|reasoning|analysis)\s*:[\s\S]*?\n\n/i, '')
    .trim();
  const low = clean.toLowerCase();
  if (LEAK_MARKS.some((m) => low.includes(m))) return '';
  const lines = clean.split('\n');
  while (lines.length > 1 && /^(we need to|the (user|contact|last)|i (should|need|will)|here'?s my|analysis|okay,|first,? i)/i.test(lines[0].trim())) {
    lines.shift();
  }
  clean = lines.join('\n').trim();
  if (META_OPEN.test(clean)) return '';
  if (!clean) return '';
  return clean.slice(0, 1500);
}

export function extractReplyText(raw, opts = {}) {
  const mode = opts.mode || 'reply';
  const text = String(raw || '').trim();
  if (!text) return '';
  const json = extractReplyJson(text);
  if (json) return json; // proven reply value
  if (json === null) return ''; // parses as JSON, holds no reply → refuse
  if (mode === 'plain-strict') return strictPlain(text);
  if (mode === 'device') return looseDevice(text);
  return ''; // 'reply': JSON contract only
}

// Convert OpenAI messages -> Anthropic {system, messages}
export function toAnthropicBody({ model, oaMessages, maxTokens = 1024 }) {
  let system = '';
  const messages = [];
  for (const m of oaMessages) {
    if (m.role === 'system') system += (system ? '\n\n' : '') + m.content;
    else messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return { model, max_tokens: maxTokens, system: system || undefined, messages };
}

export function buildContextPrompt({ chatName, chunksText }) {
  return [
    { role: 'system', content: 'You build a long-term memory file for a WhatsApp contact. Output GitHub-flavored Markdown only.' },
    {
      role: 'user',
      content: `Contact/chat: ${chatName}\n\nBelow is their WhatsApp history (oldest first, may be truncated). Build context.md with:\n# ${chatName} — Context\n## Profile (who they are, relationship, language)\n## Tone & style (how user talks to them)\n## Key facts & commitments (dated)\n## Ongoing topics / open loops\n## Do NOT do (boundaries)\n## Useful reply patterns (3-5 short examples in their language)\n\nHistory:\n${chunksText.slice(0, 60000)}`,
    },
  ];
}

// Auto-instruction: draft the per-chat instruction (tone, language,
// boundaries) from memory + recent messages. Returns OpenAI messages;
// the caller cleans the output to plain prose (no JSON, no fences).
export function buildInstructionPrompt({ chatName, contextMd, recentText, globalInstruction }) {
  return [
    { role: 'system', content: 'You write short WhatsApp reply instructions. Output plain prose only — no JSON, no markdown fences, no preamble.' },
    {
      role: 'user',
      content: `Write the reply instruction for the WhatsApp chat "${chatName}" (the phone owner's side).\n${globalInstruction?.trim() ? `Global policy to respect:\n${globalInstruction.trim().slice(0, 500)}\n\n` : ''}${contextMd?.trim() ? `Known context:\n${String(contextMd).slice(0, 4000)}\n\n` : ''}${recentText?.trim() ? `Recent messages:\n${String(recentText).slice(0, 4000)}\n\n` : ''}Rules: 2-4 lines, max 500 chars. Cover: language to match, tone/length (short WhatsApp style), and 1-2 hard boundaries (never reveal reasoning, never hallucinate — ask when unsure). Do not mention you are AI unless the history shows the owner wants that. Output ONLY the instruction text.`,
    },
  ];
}

// Strip fences/quotes from a drafted instruction; hard-cap length.
export function cleanInstructionText(raw, max = 2000) {
  let t = String(raw || '').trim();
  // Tolerate a JSON-shaped answer (some models echo {"reply": ...} or
  // {"instruction": ...} despite the plain-prose contract): use the value.
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const v = j?.instruction ?? j?.reply ?? j?.message ?? j?.text;
      if (typeof v === 'string' && v.trim()) t = v.trim();
    } catch {
      const m = t.match(/"(?:instruction|reply|message|text)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        try { t = JSON.parse(`"${m[1]}"`); } catch {}
      }
    }
  }
  const fenced = t.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
  if (fenced) t = fenced[1].trim();
  t = t.replace(/^["']|["']$/g, '').trim();
  // Collapse blank-line runs; instructions must stay scannable.
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, max);
}

// Inline suggestions: 2-3 short reply chips for the open chat. Same context
// as a reply (instruction + memory + recent) but a tiny JSON contract:
// {"suggestions": ["...", "..."]}. Never auto-sends — chips only.
export const MAX_SUGGESTIONS = 3;
export function buildSuggestMessages({ globalInstruction, chatInstruction, contextMd, history, newMessages, count = 3 }) {
  const n = Math.min(Math.max(count || 3, 2), MAX_SUGGESTIONS);
  const ctxSlice = String(contextMd || '').trim().slice(0, 4000);
  const system = [
    globalInstruction?.trim() ? `Global policy:\n${globalInstruction.trim()}` : '',
    chatInstruction?.trim()
      ? `Rules for THIS chat (highest priority, must obey):\n${chatInstruction.trim()}`
      : 'Rules for THIS chat: be helpful and concise.',
    ctxSlice ? `Known context:\n${ctxSlice}` : 'No long-term context built yet.',
    `Identity: this is YOUR WhatsApp account. Lines tagged YOU were sent by you (never answer these); THEM lines are incoming (suggest replies to these). Match the language of the last THEM message.`,
    `Output format (mandatory): EXACTLY one JSON object, no preamble, no fences: {"suggestions": ["reply 1", "reply 2"]}. Each suggestion max 60 chars, 1 line, WhatsApp-style, no quotes inside. Give ${n} options with different tones (e.g. confirm / question / short ack). If nothing fits, output {"suggestions": []}.`,
  ].filter(Boolean).join('\n\n');

  const speakerOf = (m) => m.speaker || (m.dir === 'out' ? 'you' : m.dir === 'in' ? 'them' : 'unknown');
  const usableHist = (history || []).filter((m) => speakerOf(m) !== 'unknown');
  const usableFresh = (newMessages || []).filter((m) => speakerOf(m) !== 'unknown');
  const hist = usableHist.slice(-10).map((m) =>
    speakerOf(m) === 'you'
      ? { role: 'assistant', content: `YOU: ${m.text}` }
      : { role: 'user', content: `THEM: ${m.text}` },
  );
  const fresh = usableFresh.map((m) => `THEM: ${m.text}`).join('\n');
  return [
    { role: 'system', content: system },
    ...hist,
    { role: 'user', content: `Suggest ${n} replies to:\n${fresh}\n\nAnswer with exactly {"suggestions": [...]} and nothing else.` },
  ];
}

// Allowlist gate for suggestion arrays: short plain strings only. Anything
// looking like reasoning, prompt echo, or scaffolding is dropped item-wise;
// the caller sends chips only for survivors (possibly zero).
export function extractSuggestions(raw, { max = 3 } = {}) {
  const text = String(raw || '').trim();
  if (!text) return [];
  let arr = null;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) arr = j;
    else if (Array.isArray(j?.suggestions)) arr = j.suggestions;
  } catch {}
  if (!arr) {
    const m = text.match(/\{[\s\S]*"suggestions"[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        if (Array.isArray(j?.suggestions)) arr = j.suggestions;
      } catch {}
    }
  }
  if (!arr) {
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenced) {
      try {
        const j = JSON.parse(fenced[1]);
        if (Array.isArray(j?.suggestions)) arr = j.suggestions;
      } catch {}
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (typeof s !== 'string') continue;
    const t = s.replace(/<(think|thinking|reasoning|analysis|scratchpad)>[\s\S]*?<\/\1>/gi, ' ').trim();
    if (!t || t.length > 120) continue;
    if (/[\n{}]/.test(t)) continue;
    const low = t.toLowerCase();
    if (/^(the (user|contact|last incoming)|as an ai|i am (an )?ai|here is my|let me (analyze|examine)|we need to output|ensure proper escaping)/i.test(t)) continue;
    if (/(you \(you sent|them \(they sent|display name|conversation timeline|chain of thought)/i.test(low)) continue;
    if (/^["'].*["']$/.test(t) && t.length > 100) continue;
    out.push(t.slice(0, 120));
    if (out.length >= Math.min(Math.max(max || 3, 1), MAX_SUGGESTIONS)) break;
  }
  return out;
}
