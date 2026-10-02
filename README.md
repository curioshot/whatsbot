# WhatsBot — Multi-LLM WhatsApp Extension (MV3)

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
| Providers | OpenAI, Anthropic, OpenRouter, Groq, NVIDIA NIM, local (Ollama/LM Studio) |
| Suggest chips | 2–3 inline reply drafts under new messages — click inserts, never sends |
| Subbots | Watch bots (reply continuously) and task bots (one-shot jobs), plain words |
| Device agents | Route a chat to opencode / codex / claude / agy running on your machine |
| Safety | Strict-JSON replies + no-leak output filter — reasoning can never be sent |

## Quick start

```bash
# 1. Load the extension
# chrome://extensions → Developer mode → Load unpacked → this folder

# 2. Open web.whatsapp.com, scan QR, hard-reload the tab

# 3. Popup → paste API key → Save → Test

# 4. Optional: on-device agents
cd bridge && node bridge.mjs
```

Then: Console (side panel) → List chats → Add/Allow → write each chat's
instruction → **Save instruction** → Build contexts → enable bot in popup.
The toolbar badge shows `ON` while the bot runs.

## Everyday use

- **Floating dock (in WhatsApp):** AI Reply button, Build button, a thinking
  view (quoted source, stages, session + context meter), and a **task box**.
  Try `msg to krypton that i am going to his home` or `report unread`.
  Slash shortcuts: `/reply /build /auto /code /newbot /report /msg /stop /help`.
- **Console (side panel):** §1 connection/chats/contacts · §2 context builds ·
  §3 per-chat rules · §4 device test bench · §5 context + logs + sessions.
- **Auto-reply:** only in allowed chats in auto mode. The dock thinking pill
  and Last result line show every trigger and outcome.

## Sessions

Each chat gets numbered sessions (`s-…`) with an estimated context meter
(`12.4k/128k`). At 95% the session auto-rolls with a summarized carry-over.
On reply errors it opens fresh and retries once. Every log entry carries its
session id.

## Subbots (WhatsApp dock → Bots section)

Launch workers in plain words. **Watch bots** ("respond to Krypton
continuously") bind to one chat and reply to every message until paused —
a confirmation card shows target + editable instruction first, so they never
start blind. **Task bots** ("list who chatted me last month") run once and
park the result in History (re-runnable). Manage with Pause/Resume/Restart/
Stop/Delete; ⏸ in the dock head pauses every watcher at once. Max 5
concurrent watch bots.

## Device agents (opencode / codex / claude / antigravity)

1. `cd bridge && node bridge.mjs` (token in `~/.whatsbot/token`; systemd unit
   in `bridge/whatsbot-bridge.service` for autostart).
2. Popup → Bridge URL + token → Connect Device.
3. Console → per-chat brain (`cloud` or `device:*`) + work dir (must be in the
   `bridge/agents.json` allowlist). `/code …` forces device on any chat.

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
