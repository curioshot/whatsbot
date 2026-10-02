// Model input-capability table (text/image/audio/video).
// Display-only: tells the owner what the chosen model CAN take before they
// confirm + start the bot. Unknown models report honestly instead of guessing.
const RULES = [
  { re: /gpt-4o-audio/i, caps: { text: true, image: false, audio: true, video: false } },
  { re: /whisper/i, caps: { text: true, image: false, audio: true, video: false } },
  { re: /gemini/i, caps: { text: true, image: true, audio: true, video: true } },
  { re: /gpt-4o|gpt-4\.1\b|gpt-4\.1-|o1|o3|o4-mini/i, caps: { text: true, image: true, audio: false, video: false } },
  { re: /claude/i, caps: { text: true, image: true, audio: false, video: false } },
  { re: /llama-3\.2-(11b|90b)|vision|vl\b|qwen2?-?vl/i, caps: { text: true, image: true, audio: false, video: false } },
  { re: /mistral|mixtral|llama|qwen|gemma|phi|deepseek/i, caps: { text: true, image: false, audio: false, video: false } },
];

// WhatsBot's pipeline today: text only (voice notes / photos can't be read
// yet — see roadmap). Shown alongside model caps so owners aren't misled.
export const BOT_USES = { text: true, image: false, audio: false, video: false };

export function modelCaps(providerId, modelId) {
  const id = String(modelId || '');
  for (const r of RULES) {
    if (r.re.test(id)) return { ...r.caps, source: 'known' };
  }
  if (!id) return { text: false, image: false, audio: false, video: false, source: 'unknown' };
  return { text: true, image: false, audio: false, video: false, source: 'guess' };
}

export const CAP_LABELS = [
  ['text', 'Text'],
  ['image', 'Pic'],
  ['audio', 'Audio'],
  ['video', 'Video'],
];
