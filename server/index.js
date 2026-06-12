import express from 'express';
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

const app = express();
const server = http.createServer(app);
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const host = process.env.HOST ?? '127.0.0.1';
const shell = process.env.TERMINAL_SHELL || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const terminalCwd = path.resolve(process.env.TERMINAL_CWD || process.cwd());

app.disable('x-powered-by');
app.use(express.static(publicDir, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

app.get('/healthz', (_request, response) => {
  response.json({ ok: true });
});

const terminalServer = new WebSocketServer({ server, path: '/terminal' });

terminalServer.on('connection', (socket, request) => {
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  const terminal = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 88,
    rows: 28,
    cwd: terminalCwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });

  socket.send(JSON.stringify({
    type: 'banner',
    message: `Connected to ${shell} from ${remoteAddress}`,
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

server.listen(port, host, () => {
  console.log(`Web terminal listening at http://${host}:${port}`);
  console.log(`Terminal shell: ${shell}`);
  console.log(`Terminal working directory: ${terminalCwd}`);
  console.log('Warning: this app exposes shell access. Keep it bound to localhost unless you add authentication.');
});
