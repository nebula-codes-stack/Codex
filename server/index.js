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

const app = express();
const server = http.createServer(app);
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';
const shell = process.env.TERMINAL_SHELL || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const terminalCwd = path.resolve(process.env.TERMINAL_CWD || rootDir);
const sessionTtlMs = 1000 * 60 * 60 * 8;
const sessions = new Map();
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

function createSession(response) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + sessionTtlMs);
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
    sessions.delete(token);
  }
  response.clearCookie('nova_session');
}

function isAuthenticatedFromCookies(cookies) {
  const token = cookies.nova_session;
  const expiresAt = token ? sessions.get(token) : undefined;

  if (!expiresAt || expiresAt < Date.now()) {
    if (token) {
      sessions.delete(token);
    }
    return false;
  }

  sessions.set(token, Date.now() + sessionTtlMs);
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

app.disable('x-powered-by');
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

  sendPage(response, 'login.html');
});

app.post('/login', (request, response) => {
  const { password, next = '/' } = request.body;

  if (typeof password === 'string' && verifyPassword(password, passwordRecord)) {
    createSession(response);
    response.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
    return;
  }

  response.redirect('/login?error=1');
});

app.post('/logout', requireAuth, (request, response) => {
  destroySession(request, response);
  response.redirect('/login');
});

app.get('/', requireAuth, (_request, response) => sendPage(response, 'index.html'));
app.get('/settings', requireAuth, (_request, response) => sendPage(response, 'settings.html'));
app.get('/debug', requireAuth, (_request, response) => sendPage(response, 'debug.html'));
app.get('/whats-new', requireAuth, (_request, response) => sendPage(response, 'whats-new.html'));
app.get('/something', requireAuth, (_request, response) => sendPage(response, 'something.html'));

app.get('/api/settings', requireAuth, (_request, response) => {
  response.json({
    host,
    port,
    shell,
    terminalCwd,
    authFile,
    sessionHours: sessionTtlMs / 1000 / 60 / 60,
  });
});

app.get('/api/debug', requireAuth, (_request, response) => {
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
    activeSessions: sessions.size,
    memory: process.memoryUsage(),
  });
});

const terminalServer = new WebSocketServer({ server, path: '/terminal' });

terminalServer.on('connection', (socket, request) => {
  if (!isAuthenticatedFromCookies(parseCookies(request.headers.cookie))) {
    socket.send(JSON.stringify({ type: 'exit', message: 'Authentication required. Please log in at /login.' }));
    socket.close(1008, 'Authentication required');
    return;
  }

  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const initialCols = Number.parseInt(url.searchParams.get('cols') || '88', 10);
  const initialRows = Number.parseInt(url.searchParams.get('rows') || '28', 10);
  const terminal = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: Number.isInteger(initialCols) && initialCols > 0 ? initialCols : 88,
    rows: Number.isInteger(initialRows) && initialRows > 0 ? initialRows : 28,
    cwd: terminalCwd,
    env: {
      ...process.env,
      PWD: terminalCwd,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  socket.send(JSON.stringify({
    type: 'banner',
    message: `Connected to ${shell} in ${terminalCwd} from ${remoteAddress}`,
  }));

  let cleanedUp = false;
  let disposable = { dispose() {} };
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    disposable.dispose();
    terminal.kill();
  };

  disposable = terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'output', data }));
    }
  });

  terminal.onExit(({ exitCode, signal }) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'exit',
        message: `Shell exited with code ${exitCode}${signal ? ` (${signal})` : ''}.`,
      }));
      socket.close();
    }
  });

  socket.on('message', (rawMessage) => {
    let message;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      return;
    }

    if (message.type === 'input' && typeof message.data === 'string') {
      terminal.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = Number.parseInt(message.cols, 10);
      const rows = Number.parseInt(message.rows, 10);

      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
        terminal.resize(cols, rows);
      }
    }
  });

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

passwordRecord = await loadPasswordRecord();

server.listen(port, host, () => {
  console.log(`Web terminal listening at http://${host}:${port}`);
  console.log(`Login page: http://${host}:${port}/login`);
  console.log(`Terminal shell: ${shell}`);
  console.log(`Terminal working directory: ${terminalCwd}`);
  console.log('Warning: this app exposes shell access. Keep it bound to localhost unless you add authentication hardening.');
});
