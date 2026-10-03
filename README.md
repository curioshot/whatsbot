# WhatsBot — Multi-LLM WhatsApp Extension 

[![version](https://img.shields.io/badge/version-0.2.4-blue)](manifest.json)
[![tests](https://img.shields.io/badge/tests-62%20passing-green)](test/)
[![manifest](https://img.shields.io/badge/manifest-V3-orange)](manifest.json)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

A browser extension that reads, replies, and automates WhatsApp Web with any
LLM — per-chat instructions, auto-built memory, on-device coding agents, and a
command box right inside WhatsApp.

## Features

| Area | What you get |
|---|---|
| Per-chat bot | Allowlist + mandatory per-chat instruction — no instruction, no reply, ever |
| Memory | Auto-built `context.md` per chat from full history scan |
| Sessions | Numbered sessions with context meter, auto-rollover at 95% |
| Providers | OpenAI, Anthropic, OpenRouter, Groq, NVIDIA NIM, local (Ollama/LM Studio) — or a device agent, picked in the same popup list |
| Suggest chips | 2–3 inline reply drafts under new messages, following the OS light/dark setting — click inserts, never sends |
| Subbots | Watch bots (reply continuously) and task bots (one-shot jobs), plain words |
| Device agents | Route a chat to opencode / codex / claude / agy running on your machine |
| Safety | Strict-JSON replies + no-leak output filter — reasoning can never be sent |

## Quick start

```bash
# 1. Load the extension
# chrome://extensions → Developer mode → Load unpacked → this folder

# 2. Open web.whatsapp.com, scan QR, hard-reload the tab

# 3. Popup → pick a brain: a cloud provider (paste API key → Save → Test)
#    or "Device agent" (pick opencode/codex/claude/antigravity → tick
#    "Answer all chats" → Connect Device → Confirm & start)

# 4. Optional: on-device agents
cd bridge && node bridge.mjs
```

Then: popup → **Chats** → Find WhatsApp chats → tick the ones you want →
tell each how to behave → **Save — teaches it** (learns past messages
automatically) → enable bot in popup. The toolbar badge shows `ON` while
the bot runs. (The old sidepanel Console still exists but is legacy —
everything above lives in the popup now.)

## Everyday use

- **Floating dock (in WhatsApp):** two tabs — **Reply** (AI Reply button, Build button, thinking view with quoted source, stages, session + context meter, sent receipt, and a **task box**) and **Bots** (watch/task launch, cards, history). Try `msg to krypton that i am going to his home` or `report unread`.
  Slash shortcuts: `/reply /build /auto /code /newbot /report /msg /stop /help`. The status line keeps errors until the next action; transient notes fade to idle. Setup progress (`n/5`) shows until everything is done.
- **Suggestions (optional):** Popup → Policy → Suggestions On + Console §3 per-chat Suggest (follow global/on/off). When on and the chat has an instruction, 2-3 chips appear under the last incoming message in WhatsApp — a shimmer shows while they generate; click inserts into the box, never sends. `×` dismisses per message.
- **Console:** stepper nav shows live counts (§1 connection · §2 contexts built · §3 rules allowed · §4 device · §5 logs). §3 rule cards collapse (attention-needed cards start open) with Allow-all / Build-all / Expand-all / Collapse-all; §5 filters logs by direction + text. Popup remembers its last tab; the Device tab collapses credentials into a summary row once connected.
- **Auto-reply:** only in allowed chats in auto mode. The dock thinking pill
  and Last result line show every trigger and outcome.

## Sessions

Each chat gets numbered sessions (`s-…`) with an estimated context meter
(`12.4k/128k`). At 95% the session auto-rolls with a summarized carry-over.
On cloud-reply errors it opens fresh and retries once; device runs are
single-attempt by design (a blind retry would execute tools twice).
Reply-turn entries carry their session id; history-build entries carry the
active session id when one exists.

## Subbots (WhatsApp dock → Bots section)

Launch workers in plain words. **Watch bots** ("respond to Krypton
continuously") bind to one chat and reply to every message until paused —
a confirmation card shows target + editable instruction first, so they never
start blind. **Task bots** ("list who chatted me last month") run once and
park the result in History (re-runnable). Manage with Pause/Resume/Restart/
Stop/Delete; ⏸ in the dock head pauses every watcher at once. Max 5
concurrent watch bots; watch-bot replies are logged as `bot:<id>`
(other replies log as `bot` or `device:<agent>`).

## Device agents (opencode / codex / claude / antigravity)

1. `cd bridge && node bridge.mjs` (token in `~/.whatsbot/token`; systemd unit
   in `bridge/whatsbot-bridge.service` for autostart).
2. Popup → Bridge URL + token → Connect Device. Or skip this tab: popup →
   Brain list → "Device agent" answers everything through one agent.
3. Console → per-chat brain (`cloud` or `device:*`) + work dir (must be in the
   `bridge/agents.json` allowlist; empty work dir falls back to the first
   allowlisted dir that exists). `/code …` forces device on any chat.
   Per-chat `device:*` always wins over the popup default. Summaries, chips,
   and parses still use your last cloud provider (agents can't do those).

## How it fits together

```
WhatsApp Web page
├─ whatsapp-dom.js — all selectors, defensive fallbacks
└─ content.js — reader · switcher · sender · dock · task box
Extension
├─ background/service-worker.js — LLM calls · sessions · logs · subbots
├─ popup/ — keys, models, bridge, policy
├─ sidepanel/ — console: chats, contexts, rules, bench, logs
└─ common/ — providers · sessions · store (schema v4) · bus
Local machine
└─ bridge/bridge.mjs — 127.0.0.1 only, token auth, capped tasks
```

## Security model — read this

- **Chat text leaves your machine** to whichever cloud provider/model you
  select, on every AI reply, parse, and summary. Device-routed chats still
  send message text to the local CLI (which may itself call its own cloud).
  Assume anything the bot reads can be transmitted.
- **Keys + token** live in `chrome.storage.local` (this machine only, never
  synced) and `~/.whatsbot/token` (mode 0600). Anyone with your OS user
  account can read them.
- **Bridge** binds `127.0.0.1` only, requires the token header (never in
  URLs), spawns CLIs with argv arrays (no shell), enforces the cwd allowlist,
  caps tasks/logs. It runs with YOUR user privileges: a WhatsApp message
  routed to a device agent executes real tools. `agents.json` passes **no
  auto-approve flags** — each CLI's own permission policy stays in charge.
  Never run with `--no-auth`.
- **Logs** (message contents) persist locally, capped per chat + retention
  days (Policy tab, default 30, 0=forever), exportable; bridge task logs live
  7 days under `~/.whatsbot/tasks/`.
- **Permissions, justified:** `storage` (settings/logs), `scripting`
  (re-inject into stale WhatsApp tabs), `alarms` (1-min device-task orphan
  reconcile), host `web.whatsapp.com` (read/reply), provider API hosts (chat
  completions), `localhost`/`127.0.0.1` (bridge + local models). Nothing else.
- **Suggestions privacy:** chips send the same preview text (instruction +
  memory + last incoming) to your provider, max 10 calls/min/chat, cached per
  message. No logs are written for previews.

## Files

- `manifest.json` — MV3 (`storage`, `scripting`, `alarms`)
- `src/common/` — `providers.js` (prompts, model lists, no-leak filter),
  `device.js` (bridge client), `sessions.js` + `attribution.js` (pure,
  unit-tested)
- `src/background/service-worker.js` — LLM calls (90s timeout), sessions
  lifecycle, logs
- `src/content/` — `whatsapp-dom.js` (all selectors — fix here when WA
  changes), `content.js` (reader/switcher/replier/observer/dock)
- `src/popup/*`, `src/sidepanel/*`, `src/ui/*` (tokens/components/icons/theme)
- `bridge/` — daemon, `agents.json`, systemd unit
- `test/` — `node --test test/` (62 tests) + `node test/helpers/harness.mjs`
  (25 live slots, every background message type)

## Known limitations

- WhatsApp changes its DOM often; the dock Scan line exposes signal counts
  so breakage is visible.
- Same-name 1:1 vs group are split (`name:x` vs `name:x#group`, legacy base
  ids resolve as fallback). Two 1:1 chats with the identical name still share
  one entry (WA exposes no stable id).
- Long device tasks poll from the service worker with a 1-min `alarms`
  reconcile journal; very long browser-idle gaps can still outlive the
  originating reply turn — the task keeps running in the bridge and its log
  survives.
- `document.execCommand` is deprecated; all uses funnel through centralized
  helpers with a direct-edit + `InputEvent` fallback.

## Contributing

Small, focused pull requests — one change each. Run `node --test test/` before opening one —
it must stay 62/62 green. Never commit API keys, tokens, chat exports, or
screenshots with real chats in them.

## License

MIT — see [LICENSE](LICENSE).
