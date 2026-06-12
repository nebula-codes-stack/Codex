import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import pty from 'node-pty';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, '.nova');
const authFile = path.join(dataDir, 'auth.json');
const userQuickCommandsFile = path.join(dataDir, 'quick-commands.user.json');
const quickCommandsDir = path.join(rootDir, 'quick-commands');

const app = express();
const server = http.createServer(app);
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';
const shell = process.env.TERMINAL_SHELL || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const terminalCwd = path.resolve(process.env.TERMINAL_CWD || rootDir);
const sessionTtlMs = 1000 * 60 * 60 * 8;
const terminalIdleMs = Number.parseInt(process.env.NOVA_SESSION_IDLE_MINUTES ?? '60', 10) * 60 * 1000;
const maxOutputChunks = Number.parseInt(process.env.NOVA_OUTPUT_MAX_CHUNKS ?? '2000', 10);
const maxOutputBytes = Number.parseInt(process.env.NOVA_OUTPUT_MAX_BYTES ?? '2000000', 10);
const startupCommand = process.env.NOVA_STARTUP_COMMAND ?? 'cd ~';
const authSessions = new Map();
const terminalSessions = new Map();
const loginFailures = new Map();
let passwordRecord;

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').flatMap((part) => {
    const [name, ...value] = part.trim().split('=');
    return name ? [[name, decodeURIComponent(value.join('='))]] : [];
  }));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { algorithm: 'scrypt', salt, hash };
}

function verifyPassword(password, record) {
  const candidate = hashPassword(password, record.salt);
  const expected = Buffer.from(record.hash, 'hex');
  const actual = Buffer.from(candidate.hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function normalizeCommands(commands) {
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands
    .filter(({ label, command }) => typeof label === 'string' && typeof command === 'string')
    .map(({ label, command }) => ({ label, command }));
}

async function detectCommandProfile() {
  if (process.platform === 'win32') {
    return 'Windows';
  }

  if (process.platform === 'darwin') {
    return 'Mac';
  }

  if (process.platform === 'linux') {
    try {
      const osRelease = await fs.readFile('/etc/os-release', 'utf8');
      if (/^ID=ubuntu$/m.test(osRelease) || /^ID_LIKE=.*ubuntu/m.test(osRelease)) {
        return 'Ubuntu';
      }
    } catch {
      // Fall through to generic Linux commands.
    }

    return 'Linux';
  }

  return 'Other';
}

async function readCommandFile(fileName) {
  const commands = JSON.parse(await fs.readFile(path.join(quickCommandsDir, fileName), 'utf8'));
  return normalizeCommands(commands);
}

async function readUserQuickCommands() {
  try {
    return normalizeCommands(JSON.parse(await fs.readFile(userQuickCommandsFile, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function writeUserQuickCommands(commands) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(userQuickCommandsFile, `${JSON.stringify(normalizeCommands(commands), null, 2)}\n`, { mode: 0o600 });
}

async function loadQuickCommands() {
  const detectedProfile = await detectCommandProfile();
  const fileName = `${detectedProfile}.json`;
  let profile = detectedProfile;
  let builtInFile = fileName;
  let builtInCommands;

  try {
    builtInCommands = await readCommandFile(fileName);
  } catch {
    profile = 'Other';
    builtInFile = 'Other.json';
    builtInCommands = await readCommandFile('Other.json');
  }

  const userCommands = await readUserQuickCommands();

  return {
    profile,
    fileName: builtInFile,
    commands: [...builtInCommands, ...userCommands],
    groups: [
      { id: 'built-in', label: `${profile} defaults`, fileName: builtInFile, commands: builtInCommands },
      { id: 'user', label: 'User commands', fileName: '.nova/quick-commands.user.json', commands: userCommands },
    ],
  };
}

async function loadPasswordRecord() {
  await fs.mkdir(dataDir, { recursive: true });

  try {
    return JSON.parse(await fs.readFile(authFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    const initialPassword = process.env.NOVA_PASSWORD || 'nova';
    const record = {
      ...hashPassword(initialPassword),
      createdAt: new Date().toISOString(),
      note: 'Set NOVA_PASSWORD before first launch to choose a different initial password.',
    };

    await fs.writeFile(authFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    console.log(`Created ${authFile} with a hashed initial password.`);
    console.log(process.env.NOVA_PASSWORD ? 'Initial password was read from NOVA_PASSWORD.' : 'Initial password is "nova". Change it by deleting .nova/auth.json and setting NOVA_PASSWORD before the next launch.');
    return record;
  }
}

function createCsrfToken(response) {
  const token = crypto.randomBytes(24).toString('base64url');
  response.cookie('nova_csrf', token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionTtlMs,
  });
  return token;
}

function requireCsrf(request, response, next) {
  const cookies = parseCookies(request.headers.cookie);
  const formToken = request.body?._csrf || request.headers['x-csrf-token'];

  if (cookies.nova_csrf && formToken === cookies.nova_csrf) {
    next();
    return;
  }

  response.status(403).send('Invalid CSRF token. Refresh the page and try again.');
}

function createSession(response) {
  const token = crypto.randomBytes(32).toString('base64url');
  authSessions.set(token, Date.now() + sessionTtlMs);
  response.cookie('nova_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionTtlMs,
  });
}

function destroySession(request, response) {
  const token = parseCookies(request.headers.cookie).nova_session;
  if (token) {
    authSessions.delete(token);
  }
  response.clearCookie('nova_session');
}

function isAuthenticatedFromCookies(cookies) {
  const token = cookies.nova_session;
  const expiresAt = token ? authSessions.get(token) : undefined;

  if (!expiresAt || expiresAt < Date.now()) {
    if (token) {
      authSessions.delete(token);
    }
    return false;
  }

  authSessions.set(token, Date.now() + sessionTtlMs);
  return true;
}

function requireAuth(request, response, next) {
  if (isAuthenticatedFromCookies(parseCookies(request.headers.cookie))) {
    next();
    return;
  }

  response.redirect(`/login?next=${encodeURIComponent(request.originalUrl)}`);
}

function sendPage(response, fileName) {
  response.sendFile(path.join(publicDir, fileName));
}

function clientIp(request) {
  return request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  const record = loginFailures.get(ip);
  if (!record) {
    return false;
  }

  return record.lockedUntil > Date.now();
}

function recordLoginFailure(ip) {
  const current = loginFailures.get(ip) || { count: 0, lockedUntil: 0 };
  const count = current.count + 1;
  loginFailures.set(ip, {
    count,
    lockedUntil: count >= 5 ? Date.now() + Math.min(30000 * count, 300000) : 0,
  });
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function appendOutput(session, data) {
  session.outputChunks.push(data);
  session.outputBytes += Buffer.byteLength(data);

  while (session.outputChunks.length > maxOutputChunks || session.outputBytes > maxOutputBytes) {
    const removed = session.outputChunks.shift();
    session.outputBytes -= Buffer.byteLength(removed);
    session.outputTruncated = true;
  }
}

function terminalSessionMeta(session) {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    cwd: session.cwd,
    shell: session.shell,
    status: session.status,
    clients: session.clients.size,
    outputBytes: session.outputBytes,
    outputChunks: session.outputChunks.length,
    outputTruncated: session.outputTruncated,
  };
}

function broadcast(session, payload) {
  const data = JSON.stringify(payload);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function createTerminalSession({ name = 'Terminal', cols = 88, rows = 28 } = {}) {
  const id = crypto.randomUUID();
  const terminal = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: terminalCwd,
    env: {
      ...process.env,
      PWD: terminalCwd,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });
  const session = {
    id,
    name,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    cwd: terminalCwd,
    shell,
    status: 'running',
    pty: terminal,
    clients: new Set(),
    outputChunks: [],
    outputBytes: 0,
    outputTruncated: false,
  };

  terminalSessions.set(id, session);

  terminal.onData((data) => {
    session.lastActiveAt = new Date().toISOString();
    appendOutput(session, data);
    broadcast(session, { type: 'output', data });
  });

  terminal.onExit(({ exitCode, signal }) => {
    session.status = 'exited';
    const message = `Shell exited with code ${exitCode}${signal ? ` (${signal})` : ''}.`;
    appendOutput(session, `\r\n${message}\r\n`);
    broadcast(session, { type: 'exit', message });
  });

  if (startupCommand) {
    terminal.write(`${startupCommand}\r`);
  }

  const message = `Connected to ${shell} in ${terminalCwd}${startupCommand ? ` after ${startupCommand}` : ''}`;
  setTimeout(() => {
    appendOutput(session, `\r\n${message}\r\n`);
    broadcast(session, { type: 'banner', message });
  }, startupCommand ? 300 : 0);

  return session;
}

function getTerminalSession(id) {
  return terminalSessions.get(id);
}

function closeTerminalSession(id) {
  const session = getTerminalSession(id);
  if (!session) {
    return false;
  }

  session.status = 'exited';
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, 'Terminal session closed');
    }
  }
  session.clients.clear();
  session.pty.kill();
  terminalSessions.delete(id);
  return true;
}

function cleanupIdleTerminalSessions() {
  const now = Date.now();
  for (const [id, session] of terminalSessions) {
    if (session.clients.size > 0) {
      continue;
    }

    if (now - Date.parse(session.lastActiveAt) > terminalIdleMs) {
      closeTerminalSession(id);
    }
  }
}

setInterval(cleanupIdleTerminalSessions, Math.min(terminalIdleMs, 60000)).unref();

app.disable('x-powered-by');
if (process.env.PUBLIC_URL || process.env.NGROK) {
  app.set('trust proxy', 1);
}
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((request, response, next) => {
  if (!request.path.endsWith('.html')) {
    next();
    return;
  }

  const route = request.path === '/index.html' ? '/' : request.path.replace(/\.html$/, '');
  response.redirect(route);
});
app.use(express.static(publicDir, {
  index: false,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

app.get('/healthz', (_request, response) => {
  response.json({ ok: true });
});

app.get('/login', (request, response) => {
  if (isAuthenticatedFromCookies(parseCookies(request.headers.cookie))) {
    response.redirect(request.query.next || '/');
    return;
  }

  createCsrfToken(response);
  sendPage(response, 'login.html');
});

app.post('/login', requireCsrf, (request, response) => {
  const ip = clientIp(request);
  const { password, next = '/' } = request.body;

  if (isRateLimited(ip)) {
    response.redirect('/login?error=rate');
    return;
  }

  if (typeof password === 'string' && verifyPassword(password, passwordRecord)) {
    clearLoginFailures(ip);
    createSession(response);
    response.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
    return;
  }

  recordLoginFailure(ip);
  response.redirect('/login?error=1');
});

app.post('/logout', requireAuth, requireCsrf, (request, response) => {
  destroySession(request, response);
  response.redirect('/login');
});

app.get('/', requireAuth, (_request, response) => sendPage(response, 'index.html'));
app.get('/settings', requireAuth, (_request, response) => sendPage(response, 'settings.html'));
app.get('/debug', requireAuth, (_request, response) => sendPage(response, 'debug.html'));
app.get('/whats-new', requireAuth, (_request, response) => sendPage(response, 'whats-new.html'));
app.get('/something', requireAuth, (_request, response) => sendPage(response, 'something.html'));

app.get('/api/csrf', requireAuth, (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  response.json({ token: cookies.nova_csrf || createCsrfToken(response) });
});

app.get('/api/settings', requireAuth, (_request, response) => {
  response.json({
    host,
    port,
    shell,
    terminalCwd,
    authFile,
    userQuickCommandsFile,
    sessionHours: sessionTtlMs / 1000 / 60 / 60,
    terminalIdleMinutes: terminalIdleMs / 1000 / 60,
    outputLimits: { maxOutputChunks, maxOutputBytes },
    startupCommand,
  });
});

app.get('/api/quick-commands', requireAuth, async (_request, response) => {
  response.json(await loadQuickCommands());
});

app.get('/api/user-quick-commands', requireAuth, async (_request, response) => {
  response.json({ commands: await readUserQuickCommands() });
});

app.put('/api/user-quick-commands', requireAuth, requireCsrf, async (request, response) => {
  const commands = normalizeCommands(request.body?.commands);
  await writeUserQuickCommands(commands);
  response.json({ ok: true, commands });
});

app.get('/api/debug', requireAuth, (_request, response) => {
  const terminalStats = [...terminalSessions.values()].map(terminalSessionMeta);
  response.json({
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    rootDir,
    publicDir,
    terminalCwd,
    shell,
    activeAuthSessions: authSessions.size,
    activeTerminalSessions: terminalSessions.size,
    terminalSessions: terminalStats,
    startupCommand,
    memory: process.memoryUsage(),
  });
});

app.get('/api/terminal-sessions', requireAuth, (_request, response) => {
  response.json({ sessions: [...terminalSessions.values()].map(terminalSessionMeta) });
});

app.post('/api/terminal-sessions', requireAuth, requireCsrf, (request, response) => {
  const cols = Number.parseInt(request.body?.cols || '88', 10);
  const rows = Number.parseInt(request.body?.rows || '28', 10);
  const session = createTerminalSession({
    name: typeof request.body?.name === 'string' && request.body.name.trim() ? request.body.name.trim() : `Terminal ${terminalSessions.size + 1}`,
    cols: Number.isInteger(cols) && cols > 0 ? cols : 88,
    rows: Number.isInteger(rows) && rows > 0 ? rows : 28,
  });
  response.status(201).json({ session: terminalSessionMeta(session) });
});

app.patch('/api/terminal-sessions/:id', requireAuth, requireCsrf, (request, response) => {
  const session = getTerminalSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  if (typeof request.body?.name === 'string' && request.body.name.trim()) {
    session.name = request.body.name.trim();
  }
  response.json({ session: terminalSessionMeta(session) });
});

app.get('/api/terminal-sessions/:id/output', requireAuth, (request, response) => {
  const session = getTerminalSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  response.json({
    sessionId: session.id,
    output: session.outputChunks.join(''),
    truncated: session.outputTruncated,
  });
});

app.delete('/api/terminal-sessions/:id/output', requireAuth, requireCsrf, (request, response) => {
  const session = getTerminalSession(request.params.id);
  if (!session) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  session.outputChunks = [];
  session.outputBytes = 0;
  session.outputTruncated = false;
  response.json({ ok: true, session: terminalSessionMeta(session) });
});

app.delete('/api/terminal-sessions/:id', requireAuth, requireCsrf, (request, response) => {
  if (!closeTerminalSession(request.params.id)) {
    response.status(404).json({ error: 'Session not found' });
    return;
  }

  response.json({ ok: true });
});

const terminalServer = new WebSocketServer({ server, path: '/terminal' });

terminalServer.on('connection', (socket, request) => {
  if (!isAuthenticatedFromCookies(parseCookies(request.headers.cookie))) {
    socket.send(JSON.stringify({ type: 'exit', message: 'Authentication required. Please log in at /login.' }));
    socket.close(1008, 'Authentication required');
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const initialCols = Number.parseInt(url.searchParams.get('cols') || '88', 10);
  const initialRows = Number.parseInt(url.searchParams.get('rows') || '28', 10);
  let session = getTerminalSession(url.searchParams.get('sessionId'));

  if (!session) {
    session = createTerminalSession({
      name: `Terminal ${terminalSessions.size + 1}`,
      cols: Number.isInteger(initialCols) && initialCols > 0 ? initialCols : 88,
      rows: Number.isInteger(initialRows) && initialRows > 0 ? initialRows : 28,
    });
  } else if (session.status === 'running' && Number.isInteger(initialCols) && Number.isInteger(initialRows) && initialCols > 0 && initialRows > 0) {
    session.pty.resize(initialCols, initialRows);
  }

  session.clients.add(socket);
  session.lastActiveAt = new Date().toISOString();
  socket.send(JSON.stringify({ type: 'attached', session: terminalSessionMeta(session), output: session.outputChunks.join(''), truncated: session.outputTruncated }));

  socket.on('message', (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    if (message.type === 'input' && typeof message.data === 'string' && session.status === 'running') {
      session.pty.write(message.data);
      session.lastActiveAt = new Date().toISOString();
      return;
    }

    if (message.type === 'resize' && session.status === 'running') {
      const cols = Number.parseInt(message.cols, 10);
      const rows = Number.parseInt(message.rows, 10);

      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        session.pty.resize(cols, rows);
      }
    }
  });

  socket.on('close', () => {
    session.clients.delete(socket);
    session.lastActiveAt = new Date().toISOString();
  });

  socket.on('error', () => {
    session.clients.delete(socket);
    session.lastActiveAt = new Date().toISOString();
  });
});

passwordRecord = await loadPasswordRecord();

server.listen(port, host, () => {
  console.log(`Web terminal listening at http://${host}:${port}`);
  console.log(`Login page: http://${host}:${port}/login`);
  console.log(`Terminal shell: ${shell}`);
  console.log(`Terminal working directory: ${terminalCwd}`);
  console.log(`Visible startup command: ${startupCommand || 'disabled'}`);
  console.log('Warning: this app exposes shell access. Keep it bound to localhost unless you add authentication hardening.');
});
