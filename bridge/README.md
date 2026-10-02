# whatsbot-bridge

Localhost daemon so the WhatsBot Chrome extension can run your on-device agents:
`opencode`, `codex`, `claude` (Claude Code), `antigravity` (`agy`).

## Run

```bash
cd bridge
node bridge.mjs
# → http://127.0.0.1:18789, token in ~/.whatsbot/token
```

Paste that token into the extension popup → **Connect Device**.

## Config (`agents.json`)

- `port`, `cwdAllowlist` (tasks can only run inside these dirs; an empty
  work dir falls back to the first allowlisted dir that exists),
  `defaultTimeoutMs` (client timeouts are clamped to 1s–30min)
- Per-agent `detect` + `run` argv. `{prompt}` and `{cwd}` are substituted; no shell is used.
- `antigravity.altBinaries: ["antigravity"]` — set `run[0]` to whichever binary you have (`agy` vs `antigravity`).
- Task logs are written `0600` and pruned after 7 days.
- Never run with `--no-auth` except for local testing — it disables the token entirely.

## API (header `X-WhatsBot-Token: <token>`)

- `GET /health`
- `GET /agents` → `[{id, installed, version, bin}]`
- `POST /task {agent, prompt, cwd, timeoutMs}` → `{id}`
- `GET /task/:id` → `{task: {state, exitCode, reply, outputTail, error, logPath}}`
- `DELETE /task/:id` → cancel

Logs: `~/.whatsbot/tasks/<id>.log`
