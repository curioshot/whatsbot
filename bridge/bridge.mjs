// whatsbot-bridge — zero-dependency localhost daemon.
// Lets the WhatsBot Chrome extension spawn headless agent runs:
//   opencode run / codex exec / claude -p / agy -p
// Run: node bridge.mjs [--port 18789] [--no-auth (LAN test only, NOT recommended)]
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const CFG_PATH = path.join(ROOT, 'agents.json');
const DOT = path.join(os.homedir(), '.whatsbot');
const TOKEN_PATH = path.join(DOT, 'token');
const TASK_DIR = path.join(DOT, 'tasks');

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
function argvVal(flag, fb) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fb;
}
const _portRaw = process.env.WB_PORT || argvVal('--port', cfg.port) || 18789;
const PORT = Number(_portRaw);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`bad port: ${JSON.stringify(String(_portRaw)).slice(0, 40)} (use --port 18789 or WB_PORT=18789)`);
  process.exit(2);
}
const NO_AUTH = process.argv.includes('--no-auth');
const MAX_OUT = cfg.maxOutputChars || 12000;

fs.mkdirSync(DOT, { recursive: true });
fs.mkdirSync(TASK_DIR, { recursive: true });

// ---- token ----
let TOKEN = '';
if (!NO_AUTH) {
  if (fs.existsSync(TOKEN_PATH)) TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_PATH, TOKEN, { mode: 0o600 });
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
const ALLOW = (cfg.cwdAllowlist || ['~/projects']).map(expandHome).map((p) => path.resolve(p));

function cwdAllowed(cwd) {
  if (!cwd) {
    // Empty work dir must NOT fall back to the bridge's own cwd (that would
    // run tasks outside the allowlist). Use the first allowlisted dir that
    // exists instead — still useful, still contained.
    const fb = ALLOW.find((a) => { try { return fs.statSync(a).isDirectory(); } catch { return false; } });
    if (!fb) return { ok: false, error: `no working directory: none of the allowlist dirs exist (${ALLOW.join(', ')})` };
    return { ok: true, cwd: fb };
  }
  const resolved = path.resolve(expandHome(cwd));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `cwd not found: ${resolved}` };
  }
  const real = fs.realpathSync(resolved);
  if (!ALLOW.some((a) => real === a || real.startsWith(a + path.sep))) {
    return { ok: false, error: `cwd not in allowlist (${ALLOW.join(', ')}): ${real}` };
  }
  return { ok: true, cwd: real };
}

// ---- helpers ----
function corsOrigin(req) {
  const o = String(req.headers.origin || '');
  // Only the extension (and localhost tooling) get an explicit allow.
  // Random websites get no CORS grant, so a malicious page cannot read
  // localhost responses even if it guesses the port.
  if (o.startsWith('chrome-extension://')) return o;
  if (o.startsWith('http://127.0.0.1:') || o.startsWith('http://localhost:')) return o;
  return '';
}
function send(res, code, obj, req) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, X-WhatsBot-Token',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  };
  const allow = req ? corsOrigin(req) : '';
  if (allow) {
    headers['Access-Control-Allow-Origin'] = allow;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(code, headers);
  res.end(body);
}
function authed(req) {
  // Header only. Query-string tokens end up in logs/history — never accept
  // them. (The extension always sends X-WhatsBot-Token.)
  if (NO_AUTH) return true;
  const h = req.headers['x-whatsbot-token'] || '';
  return !!h && h === TOKEN;
}
function body(req, res) {
  return new Promise((resolve, reject) => {
    let s = '';
    let tooBig = false;
    req.on('data', (c) => {
      s += c;
      if (s.length > 200000 && !tooBig) {
        tooBig = true;
        send(res, 413, { ok: false, error: 'body too large (max 200KB)' }, req);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return reject(new Error('body too large'));
      try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
function runCmd(bin, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error: err?.message || '' });
    });
  });
}
async function detectAgent(id, def) {
  const bins = [def.detect?.[0]].filter(Boolean);
  if (def.altBinaries) bins.push(...def.altBinaries);
  for (const bin of bins) {
    const r = await runCmd(bin, (def.detect || []).slice(1));
    if (r.ok || r.stdout) return { id, label: def.label || id, installed: true, version: (r.stdout || r.stderr || '').split('\n')[0].slice(0, 120), bin };
  }
  return { id, label: def.label || id, installed: false, version: '', bin: def.detect?.[0] || id };
}

// ---- tasks ----
const tasks = new Map(); // id -> {id, agent, prompt, cwd, state, exitCode, output, error, proc, startedAt, endedAt, logPath}
const MAX_TASKS = 50;
function newId() { return Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

// Bound memory + disk: keep newest tasks, delete log files older than 7 days.
function pruneTasks() {
  while (tasks.size > MAX_TASKS) {
    const oldest = tasks.keys().next().value;
    const t = tasks.get(oldest);
    try { if (t?.logPath && fs.existsSync(t.logPath)) fs.unlinkSync(t.logPath); } catch {}
    tasks.delete(oldest);
  }
}
function pruneOldLogs() {
  try {
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(TASK_DIR)) {
      const p = path.join(TASK_DIR, f);
      try { if (fs.statSync(p).mtimeMs < week) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
pruneOldLogs();

function extractReply(agent, raw) {
  // Best-effort: pull human-readable answer out of JSON event streams; fallback to trimmed raw.
  const text = raw.trim();
  if (!text) return '';
  try {
    if (agent === 'claude') {
      const j = JSON.parse(text);
      if (typeof j.result === 'string') return j.result;
      if (Array.isArray(j.content)) return j.content.map((b) => b.text || '').join('\n').trim() || text.slice(0, MAX_OUT);
    }
    if (agent === 'antigravity') {
      // may be single JSON envelope or NDJSON stream; take last result event
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          if (j.response) return String(j.response).slice(0, MAX_OUT);
          if (j.result?.response) return String(j.result.response).slice(0, MAX_OUT);
        } catch {}
      }
      const j = JSON.parse(text);
      if (j.response) return String(j.response).slice(0, MAX_OUT);
    }
    if (agent === 'codex') {
      // --json NDJSON: final agent message is in last item with type thread/message? fallback: last line text
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(lines[i]);
          const t = j.text || j.message || j.content;
          if (typeof t === 'string' && t.trim()) return t.trim().slice(0, MAX_OUT);
        } catch {}
      }
    }
    if (agent === 'opencode') {
      // --format json event stream; last text event
      const lines = text.split('\n').filter(Boolean);
      let acc = [];
      for (const ln of lines) {
        try {
          const j = JSON.parse(ln);
          const t = j.text || j.content || j.message;
          if (typeof t === 'string') acc.push(t);
        } catch { acc.push(ln); }
      }
      if (acc.length) return acc.join('\n').trim().slice(-MAX_OUT);
    }
  } catch {}
  return text.slice(-MAX_OUT);
}

async function startTask({ agent, prompt, cwd, timeoutMs }) {
  const def = cfg.agents?.[agent];
  if (!def) throw new Error(`unknown agent: ${agent}`);
  if (!prompt?.trim()) throw new Error('prompt required');
  const c = cwdAllowed(cwd || '');
  if (!c.ok) throw new Error(c.error);
  const id = newId();
  const logPath = path.join(TASK_DIR, `${id}.log`);
  const t = { id, agent, prompt: prompt.slice(0, 20000), cwd: c.cwd, state: 'running', exitCode: null, output: '', error: '', startedAt: Date.now(), endedAt: 0, logPath, proc: null, spawnFailed: false };
  tasks.set(id, t);
  pruneTasks();

  // Flag-injection guard: a prompt starting with `-` would be parsed as a
  // CLI flag by most agent CLIs (positional prompt arg). A leading space
  // keeps it a positional value; LLMs ignore it.
  const safePrompt = /^\s*-/.test(prompt) ? ` ${prompt}` : prompt;
  const argv = (def.run || []).map((a) => a.replaceAll('{prompt}', safePrompt).replaceAll('{cwd}', c.cwd));
  const bin = argv[0];
  const args = argv.slice(1);
  // Clamp client timeouts: huge values hit setTimeout overflow and hold a
  // child + poll slot; negatives misbehave. 1s min, 30min max.
  const ms = Math.min(Math.max(Number(timeoutMs) || cfg.defaultTimeoutMs || 180000, 1000), 30 * 60 * 1000);
  const child = spawn(bin, args, { cwd: c.cwd, timeout: ms });
  t.proc = child;
  const log = fs.createWriteStream(logPath, { mode: 0o600 });
  log.write(`$ ${bin} ${args.map((a) => (a.length > 200 ? a.slice(0, 200) + '…' : a)).join(' ')}\n[cwd ${c.cwd}]\n\n`);
  let out = '', err = '';
  child.stdout?.on('data', (d) => { out += d; log.write(d); });
  child.stderr?.on('data', (d) => { err += d; log.write(d); });
  const to = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, ms);
  child.on('close', (code) => {
    clearTimeout(to);
    // spawn failure already recorded a precise error — a trailing close
    // event (code -2/ENOENT) must not overwrite it with a vaguer message.
    if (t.spawnFailed) { try { log.end(`\n--- exit ${code} (after spawn failure) ---\n`); } catch {} return; }
    t.endedAt = Date.now();
    t.exitCode = code;
    t.output = (out + (err && !out ? '\n[stderr]\n' + err : '')).slice(-MAX_OUT * 2);
    t.reply = extractReply(agent, out || err);
    t.error = code === 0 ? '' : (err.slice(-2000) || `exit ${code}`);
    t.state = code === 0 ? 'done' : 'error';
    t.proc = null;
    log.end(`\n--- exit ${code} ---\n`);
  });
  child.on('error', (e) => {
    clearTimeout(to);
    t.endedAt = Date.now();
    t.state = 'error';
    t.spawnFailed = true;
    t.error = `spawn failed (${bin}): ${e.message}. Is ${agent} installed and on PATH?`;
    t.reply = '';
    t.proc = null;
  });
  return { id, state: 'running' };
}

// ---- server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'OPTIONS') {
    const allow = corsOrigin(req);
    const h = { 'Access-Control-Allow-Headers': 'Content-Type, X-WhatsBot-Token', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' };
    if (allow) { h['Access-Control-Allow-Origin'] = allow; h['Vary'] = 'Origin'; }
    res.writeHead(204, h); return res.end();
  }
  // bind check message only; actual bind is 127.0.0.1 below
  if (url.pathname === '/health' && req.method === 'GET') {
    if (!authed(req) && !NO_AUTH) {
      // Unauthenticated callers learn only that the bridge is online and
      // that auth is required — never the agent list (info-leak fix).
      return send(res, 200, { ok: true, bridge: 'whatsbot-bridge', version: '0.1.0', auth: 'required' }, req);
    }
    return send(res, 200, { ok: true, bridge: 'whatsbot-bridge', version: '0.1.0', auth: NO_AUTH ? 'off' : 'on' }, req);
  }
  if (!authed(req)) return send(res, 401, { ok: false, error: 'bad token. Paste token from ~/.whatsbot/token into extension popup.' }, req);

  try {
    if (url.pathname === '/agents' && req.method === 'GET') {
      const out = [];
      for (const [id, def] of Object.entries(cfg.agents || {})) out.push(await detectAgent(id, def));
      return send(res, 200, { ok: true, agents: out }, req);
    }
    if (url.pathname === '/task' && req.method === 'POST') {
      const b = await body(req, res);
      const r = await startTask({ agent: b.agent, prompt: b.prompt, cwd: b.cwd, timeoutMs: b.timeoutMs });
      return send(res, 200, { ok: true, ...r }, req);
    }
    const m = url.pathname.match(/^\/task\/([A-Za-z0-9]+)$/);
    if (m) {
      const t = tasks.get(m[1]);
      if (!t) return send(res, 404, { ok: false, error: 'unknown task' }, req);
      if (req.method === 'GET') {
        const { proc, ...pub } = t;
        return send(res, 200, { ok: true, task: { ...pub, outputTail: (t.output || '').slice(-3000) } }, req);
      }
      if (req.method === 'DELETE') {
        if (t.state !== 'running') return send(res, 200, { ok: true, cancelled: false, state: t.state }, req);
        try { t.proc?.kill('SIGTERM'); setTimeout(() => { try { t.proc?.kill('SIGKILL'); } catch {} }, 3000); } catch {}
        t.state = 'error'; t.error = 'cancelled by user'; t.endedAt = Date.now();
        return send(res, 200, { ok: true, cancelled: true }, req);
      }
    }
    return send(res, 404, { ok: false, error: 'not found' }, req);
  } catch (e) {
    if (res.headersSent) return; // e.g. oversize-body path already answered
    return send(res, 400, { ok: false, error: String(e.message || e) }, req);
  }
});

// Main-guard: importing this file must not boot the server (keeps it
// testable and safe to inspect). Only `node bridge.mjs` listens.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`whatsbot-bridge on http://127.0.0.1:${PORT}`);
    console.log(`auth: ${NO_AUTH ? 'OFF (--no-auth)' : 'token in ' + TOKEN_PATH}`);
    console.log(`agents: ${Object.keys(cfg.agents || {}).join(', ')}`);
    console.log(`cwd allowlist: ${ALLOW.join(', ')}`);
  });
}
export { server, cfg, startTask };
