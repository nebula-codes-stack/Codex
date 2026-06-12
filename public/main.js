const terminalElement = document.querySelector('#terminal');
const connectionStatus = document.querySelector('#connectionStatus');
const statusPulse = document.querySelector('#statusPulse');
const clearButton = document.querySelector('#clearButton');
const reconnectButton = document.querySelector('#reconnectButton');
const sessionId = document.querySelector('#sessionId');

const terminal = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: 'bar',
  fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
  fontSize: 14,
  lineHeight: 1.25,
  letterSpacing: 0.3,
  scrollback: 5000,
  convertEol: true,
  theme: {
    background: '#080b15',
    foreground: '#e8eeff',
    cursor: '#62e6ff',
    cursorAccent: '#080b15',
    selectionBackground: '#334155',
    black: '#0f172a',
    red: '#fb7185',
    green: '#67f7b1',
    yellow: '#fbbf24',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#62e6ff',
    white: '#f8fafc',
    brightBlack: '#475569',
    brightRed: '#fda4af',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#a5f3fc',
    brightWhite: '#ffffff',
  },
});

const fitAddon = new FitAddon.FitAddon();
let socket;
let resizeFrame;
let connectionAttempt = 0;

terminal.loadAddon(fitAddon);
terminal.open(terminalElement);

function setStatus(label, state) {
  connectionStatus.textContent = label;
  statusPulse.className = `pulse ${state}`;
}

function terminalUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/terminal`;
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID().slice(0, 8);
  }

  return Math.random().toString(16).slice(2, 10);
}

function sendResize() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({
    type: 'resize',
    cols: terminal.cols,
    rows: terminal.rows,
  }));
}

function fitAndResize() {
  window.cancelAnimationFrame(resizeFrame);
  resizeFrame = window.requestAnimationFrame(() => {
    fitAddon.fit();
    sendResize();
  });
}

function parseServerMessage(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return { type: 'output', data: String(event.data) };
  }
}

function connect() {
  connectionAttempt += 1;
  const attempt = connectionAttempt;

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close(1000, 'Reconnecting');
  }

  sessionId.textContent = createSessionId();
  setStatus('Connecting…', '');
  terminal.writeln('\x1b[38;2;98;230;255m✦ Opening Nova Terminal session…\x1b[0m');

  const nextSocket = new WebSocket(terminalUrl());
  socket = nextSocket;

  nextSocket.addEventListener('open', () => {
    if (attempt !== connectionAttempt) {
      nextSocket.close();
      return;
    }

    setStatus('Connected', 'connected');
    fitAndResize();
    terminal.focus();
  });

  nextSocket.addEventListener('message', (event) => {
    if (attempt !== connectionAttempt) {
      return;
    }

    const message = parseServerMessage(event);

    if (message.type === 'output') {
      terminal.write(message.data);
      return;
    }

    if (message.type === 'banner') {
      terminal.writeln(`\x1b[38;2;103;247;177m${message.message}\x1b[0m`);
      return;
    }

    if (message.type === 'exit') {
      terminal.writeln(`\r\n\x1b[38;2;251;113;133m${message.message}\x1b[0m`);
    }
  });

  nextSocket.addEventListener('close', () => {
    if (attempt === connectionAttempt) {
      setStatus('Disconnected', 'disconnected');
    }
  });

  nextSocket.addEventListener('error', () => {
    if (attempt === connectionAttempt) {
      setStatus('Connection error', 'disconnected');
    }
  });
}

terminal.onData((data) => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', data }));
  }
});

clearButton.addEventListener('click', () => terminal.clear());
reconnectButton.addEventListener('click', connect);
window.addEventListener('resize', fitAndResize);

connect();
fitAndResize();
