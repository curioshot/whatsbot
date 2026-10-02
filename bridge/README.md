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

- `port`, `cwdAllowlist` (tasks can only run inside these dirs), `defaultTimeoutMs`
- Per-agent `detect` + `run` argv. `{prompt}` and `{cwd}` are substituted; no shell is used.
- `antigravity.altBinaries: ["antigravity"]` — set `run[0]` to whichever binary you have (`agy` vs `antigravity`).

## API (header `X-WhatsBot-Token: <token>`)

- `GET /health`
- `GET /agents` → `[{id, installed, version, bin}]`
- `POST /task {agent, prompt, cwd, timeoutMs}` → `{id}`
- `GET /task/:id` → `{task: {state, exitCode, reply, outputTail, error, logPath}}`
- `DELETE /task/:id` → cancel

Logs: `~/.whatsbot/tasks/<id>.log`
