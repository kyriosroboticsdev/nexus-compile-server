// Nexus Compile Server
// Mirrors the exact IPC contract of main.js so web-stub.js can call it instead.
// Deploy with Docker on Railway / Render / Fly.io.

const express  = require('express');
const cors     = require('cors');
const { spawn } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(os.tmpdir(), 'nexus-sessions');
const SESSION_TTL  = 24 * 60 * 60 * 1000;   // 24 h
const SKIP_DIRS    = new Set(['.git', 'node_modules', '__pycache__', '.vscode', '.pros', '.d', 'firmware']);

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Session helpers ────────────────────────────────────────────────────────────

function sessionDir(id) { return path.join(SESSIONS_DIR, id); }

function getOrCreateSession(id) {
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
  }
  fs.mkdirSync(sessionDir(id), { recursive: true });
  return id;
}

// Resolve and validate a client-supplied relative path.
// Returns null if the resolved path would escape the session root.
function safePath(sessionId, rel) {
  const base = sessionDir(sessionId);
  const abs  = path.resolve(base, rel || '');
  if (!abs.startsWith(base + path.sep) && abs !== base) return null;
  return abs;
}

// Clean up sessions older than SESSION_TTL
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(SESSIONS_DIR).forEach(id => {
      const d = path.join(SESSIONS_DIR, id);
      try {
        if (now - fs.statSync(d).mtimeMs > SESSION_TTL)
          fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    });
  } catch {}
}, 60 * 60 * 1000);

// ── Running process registry ───────────────────────────────────────────────────

const _running = new Map();  // sessionId → child_process

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /ping — returns PROS and GCC version strings (mirrors ideCheckPros + ideCheckToolchain)
app.get('/ping', (_req, res) => {
  const check = (cmd, args) => new Promise(resolve => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', code => resolve(code === 0 ? out.trim() : null));
    p.on('error', () => resolve(null));
  });

  Promise.all([
    check('pros',               ['--version']),
    check('arm-none-eabi-gcc',  ['--version']),
  ]).then(([prosRaw, gccRaw]) => {
    const prosVer = prosRaw ? (prosRaw.match(/(\d+\.\d+[\.\d]*)/) || [])[1] || prosRaw : null;
    const gccVer  = gccRaw  ? (gccRaw.match(/(\d+\.\d+[\.\d]*)/)  || [])[1] || gccRaw.split('\n')[0] : null;
    res.json({ pros: prosVer, gcc: gccVer });
  });
});

// POST /session — create or refresh a session, returns sessionId
app.post('/session', (req, res) => {
  const id = getOrCreateSession(req.body?.sessionId);
  res.json({ sessionId: id });
});

// POST /projects/new — create a PROS project (mirrors ide:newProject)
app.post('/projects/new', (req, res) => {
  const { sessionId, name } = req.body || {};
  if (!sessionId || !name) return res.status(400).json({ error: 'Missing sessionId or name' });

  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const id = getOrCreateSession(sessionId);
  const projPath = path.join(sessionDir(id), 'projects', safeName);

  if (fs.existsSync(projPath))
    return res.status(409).json({ error: 'Project already exists' });

  fs.mkdirSync(path.join(projPath, 'src'),     { recursive: true });
  fs.mkdirSync(path.join(projPath, 'include'), { recursive: true });

  // Try to scaffold with PROS CLI; fall back to minimal template
  const proc = spawn('pros', ['new', projPath]);
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });
  proc.on('close', code => {
    if (code !== 0) {
      // Minimal scaffold fallback
      fs.writeFileSync(path.join(projPath, 'src', 'main.cpp'), MAIN_TEMPLATE);
      fs.writeFileSync(path.join(projPath, 'Makefile'), MAKEFILE_STUB);
      output += '\n[fallback] Scaffolded without PROS CLI.';
    }
    res.json({ ok: true, projectPath: `${id}/projects/${safeName}`, name: safeName, output });
  });
  proc.on('error', () => {
    fs.writeFileSync(path.join(projPath, 'src', 'main.cpp'), MAIN_TEMPLATE);
    fs.writeFileSync(path.join(projPath, 'Makefile'), MAKEFILE_STUB);
    res.json({ ok: true, projectPath: `${id}/projects/${safeName}`, name: safeName, output: '[fallback] Scaffolded without PROS CLI.' });
  });
});

// GET /ls?sessionId=&path= — list directory (mirrors ide:listDir)
app.get('/ls', (req, res) => {
  const id  = getOrCreateSession(req.query.sessionId);
  const abs = safePath(id, req.query.path || '');
  if (!abs) return res.status(403).json({ error: 'Forbidden' });
  if (!fs.existsSync(abs)) return res.json([]);
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({
        name: e.name,
        path: path.join(req.query.path || '', e.name).replace(/\\/g, '/'),
        isDir: e.isDirectory(),
      }));
    res.json(entries);
  } catch { res.json([]); }
});

// GET /read?sessionId=&path= — read file (mirrors ide:readFile)
app.get('/read', (req, res) => {
  const id  = getOrCreateSession(req.query.sessionId);
  const abs = safePath(id, req.query.path);
  if (!abs) return res.status(403).json({ error: 'Forbidden' });
  try { res.send(fs.readFileSync(abs, 'utf8')); }
  catch { res.status(404).json({ error: 'Not found' }); }
});

// POST /write — write file (mirrors ide:writeFile)
app.post('/write', (req, res) => {
  const { sessionId, path: rel, content } = req.body || {};
  const id  = getOrCreateSession(sessionId);
  const abs = safePath(id, rel);
  if (!abs) return res.status(403).json({ error: 'Forbidden' });
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content || '', 'utf8');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /mkdir — create directory (mirrors ide:mkdir)
app.post('/mkdir', (req, res) => {
  const { sessionId, path: rel } = req.body || {};
  const id  = getOrCreateSession(sessionId);
  const abs = safePath(id, rel);
  if (!abs) return res.status(403).json({ error: 'Forbidden' });
  try { fs.mkdirSync(abs, { recursive: true }); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// POST /run — run a command with SSE output (mirrors ide:runCommand + onIdeOutput)
// Body: { sessionId, cmd, args[], cwd }
// Stream: `data: {"type":"out"|"err"|"exit","data":"..."}\n\n`
app.post('/run', (req, res) => {
  const { sessionId, cmd, args = [], cwd } = req.body || {};
  const id  = getOrCreateSession(sessionId);

  // Whitelist allowed commands for security
  const ALLOWED = new Set(['pros', 'make']);
  const basecmd = path.basename(cmd || '');
  if (!ALLOWED.has(basecmd)) return res.status(400).json({ error: 'Command not allowed' });

  const cwdAbs = cwd ? safePath(id, cwd) : sessionDir(id);
  if (!cwdAbs) return res.status(403).json({ error: 'Forbidden cwd' });

  // Kill any previous run for this session
  const prev = _running.get(id);
  if (prev) { try { prev.kill(); } catch {} }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);

  const proc = spawn(cmd, args, { cwd: cwdAbs });
  _running.set(id, proc);

  proc.stdout.on('data', d => send('out', d.toString()));
  proc.stderr.on('data', d => send('err', d.toString()));
  proc.on('close', code => {
    send('exit', code ?? -1);
    _running.delete(id);
    res.end();
  });
  proc.on('error', err => {
    send('err', err.message + '\n');
    send('exit', -1);
    _running.delete(id);
    res.end();
  });

  req.on('close', () => {
    if (_running.get(id) === proc) {
      try { proc.kill(); } catch {}
      _running.delete(id);
    }
  });
});

// POST /stop — kill running process (mirrors ide:stopCommand)
app.post('/stop', (req, res) => {
  const id   = req.body?.sessionId;
  const proc = _running.get(id);
  if (proc) { try { proc.kill(); } catch {} _running.delete(id); }
  res.json({ ok: true });
});

// GET /binary?sessionId=&project= — download compiled binary
app.get('/binary', (req, res) => {
  const id      = req.query.sessionId;
  const project = req.query.project;
  if (!id || !project) return res.status(400).json({ error: 'Missing params' });
  const base = safePath(id, `projects/${project}/bin`);
  if (!base) return res.status(403).json({ error: 'Forbidden' });
  const candidates = ['hot.package.bin', 'cold.package.bin', 'monolith.bin', 'v5.bin'].map(f => path.join(base, f));
  const found = candidates.find(f => fs.existsSync(f));
  if (!found) return res.status(404).json({ error: 'Binary not built yet — run "pros make" first' });
  res.download(found, path.basename(found));
});

// POST /library/add — install a PROS library (mirrors ide:installLibrary)
app.post('/library/add', (req, res) => {
  const { sessionId, library, projectPath } = req.body || {};
  const id     = getOrCreateSession(sessionId);
  const cwdAbs = safePath(id, projectPath);
  if (!cwdAbs) return res.status(403).json({ error: 'Forbidden' });

  const proc = spawn('pros', ['conductor', 'add-depot', library], { cwd: cwdAbs });
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });
  proc.on('close', code => res.json({ ok: code === 0, output }));
  proc.on('error', err => res.json({ ok: false, output: err.message }));
});

// ── Minimal code templates ─────────────────────────────────────────────────────

const MAIN_TEMPLATE = `#include "main.h"

void initialize() {}
void disabled() {}
void competition_initialize() {}

void autonomous() {}

void opcontrol() {
    pros::Controller master(pros::E_CONTROLLER_MASTER);
    pros::Motor leftMotor(1);
    pros::Motor rightMotor(2, true);

    while (true) {
        int power = master.get_analog(pros::E_CONTROLLER_ANALOG_LEFT_Y);
        int turn  = master.get_analog(pros::E_CONTROLLER_ANALOG_RIGHT_X);
        leftMotor  = power + turn;
        rightMotor = power - turn;
        pros::delay(20);
    }
}
`;

const MAKEFILE_STUB = `# Minimal Makefile — replace with proper PROS Makefile
all:
\t@echo "Run 'pros make' with PROS CLI installed."
`;

// ── Notebook publish / public view ────────────────────────────────────────────
// Persistent storage via Supabase (set SUPABASE_URL + SUPABASE_ANON_KEY env vars).
// Falls back to local filesystem when env vars are absent (local dev only —
// Render's filesystem is ephemeral and will lose data on container restart).

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_ANON_KEY;
const NOTEBOOKS_DIR = process.env.NOTEBOOKS_DIR || path.join(__dirname, '_nb_data');
fs.mkdirSync(NOTEBOOKS_DIR, { recursive: true });

function safeTeamCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9\-_]/g, '').slice(0, 20);
}

async function nbStore(teamCode, data) {
  if (SUPABASE_URL && SUPABASE_KEY) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/notebooks`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ team_code: teamCode, data: JSON.stringify(data), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  } else {
    fs.writeFileSync(path.join(NOTEBOOKS_DIR, teamCode + '.json'), JSON.stringify(data), 'utf8');
  }
}

async function nbFetch(teamCode) {
  if (SUPABASE_URL && SUPABASE_KEY) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/notebooks?team_code=eq.${encodeURIComponent(teamCode)}&select=data&limit=1`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const rows = await r.json();
    if (!rows.length) return null;
    return JSON.parse(rows[0].data);
  } else {
    const filePath = path.join(NOTEBOOKS_DIR, teamCode + '.json');
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
}

// POST /nb/publish — team publishes current notebook snapshot
app.post('/nb/publish', async (req, res) => {
  const { teamCode, data } = req.body || {};
  const code = safeTeamCode(teamCode);
  if (!code) return res.status(400).json({ error: 'Invalid team code' });
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Missing data' });
  try {
    await nbStore(code, data);
    res.json({ ok: true, teamCode: code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /nb/data/:teamCode — public read of the published notebook (no auth required)
app.get('/nb/data/:teamCode', async (req, res) => {
  const code = safeTeamCode(req.params.teamCode);
  if (!code) return res.status(400).json({ error: 'Invalid team code' });
  try {
    const data = await nbFetch(code);
    if (!data) return res.status(404).json({ error: 'No published notebook for this team' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Static web app (serve nexus-web/ at root) ─────────────────────────────────
// API routes above take priority; everything else falls through to the SPA.
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (_req, res) => {
    const index = path.join(PUBLIC_DIR, 'index.html');
    fs.existsSync(index) ? res.sendFile(index) : res.status(404).send('Not found');
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Nexus compile server listening on port ${PORT}`));
