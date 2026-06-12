const terminalElement = document.querySelector('#terminal');
const connectionStatus = document.querySelector('#connectionStatus');
const statusPulse = document.querySelector('#statusPulse');
const clearButton = document.querySelector('#clearButton');
const reconnectButton = document.querySelector('#reconnectButton');
const newSessionButton = document.querySelector('#newSessionButton');
const sessionList = document.querySelector('#sessionList');
const sessionId = document.querySelector('#sessionId');
const activeSessionName = document.querySelector('#activeSessionName');
const cwdLabel = document.querySelector('#cwdLabel');
const quickCommandBar = document.querySelector('#quickCommandBar');
const quickCommandProfile = document.querySelector('#quickCommandProfile');
const paletteButton = document.querySelector('#paletteButton');
const commandPalette = document.querySelector('#commandPalette');
const paletteSearch = document.querySelector('#paletteSearch');
const paletteResults = document.querySelector('#paletteResults');
const copyOutputButton = document.querySelector('#copyOutputButton');
const downloadLogButton = document.querySelector('#downloadLogButton');
const clearHistoryButton = document.querySelector('#clearHistoryButton');
const debugEnabled = localStorage.getItem('nova.debug') === 'true';

let csrfToken = '';
let socket;
let resizeFrame;
let connectionAttempt = 0;
let activeSessionId = localStorage.getItem('nova.activeSessionId') || '';
let sessions = [];
let quickCommandGroups = [];
let currentOutput = '';

function applyStoredUiSettings() {
  document.body.classList.toggle('compact', localStorage.getItem('nova.compact') === 'true');
  document.documentElement.dataset.accent = localStorage.getItem('nova.accent') || 'cyan';
  document.documentElement.style.setProperty('--terminal-font-size', `${localStorage.getItem('nova.fontSize') || '14'}px`);
}

const terminal = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  cursorStyle: 'bar',
  fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", Menlo, monospace',
  fontSize: Number.parseInt(localStorage.getItem('nova.fontSize') || '14', 10),
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
applyStoredUiSettings();
terminal.loadAddon(fitAddon);
terminal.open(terminalElement);

function debugLog(...args) {
  if (debugEnabled) {
    console.debug('[nova-terminal]', ...args);
  }
}

function setStatus(label, state) {
  connectionStatus.textContent = label;
  statusPulse.className = `pulse ${state}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
  });

  if (response.redirected) {
    window.location.href = response.url;
    throw new Error('Redirected');
  }

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.status === 204 ? null : response.json();
}

async function loadCsrf() {
  const { token } = await api('/api/csrf');
  csrfToken = token;
  document.querySelectorAll('[data-csrf]').forEach((input) => {
    input.value = token;
  });
}

function terminalUrl() {
  fitAddon.fit();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    cols: String(terminal.cols),
    rows: String(terminal.rows),
  });
  if (activeSessionId) {
    params.set('sessionId', activeSessionId);
  }
  return `${protocol}//${window.location.host}/terminal?${params}`;
}

function sendResize() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
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

function updateActiveMeta(meta) {
  activeSessionId = meta.id;
  localStorage.setItem('nova.activeSessionId', activeSessionId);
  sessionId.textContent = meta.id.slice(0, 8);
  activeSessionName.textContent = meta.name;
  cwdLabel.textContent = meta.cwd;
}

function renderSessions() {
  sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No terminal sessions yet.';
    sessionList.append(empty);
    return;
  }

  sessions.forEach((item) => {
    const row = document.createElement('article');
    row.className = `session-row ${item.id === activeSessionId ? 'active' : ''}`;
    row.innerHTML = `
      <button type="button" class="session-main">
        <strong></strong>
        <span></span>
      </button>
      <div class="session-actions">
        <button type="button" data-action="rename">Rename</button>
        <button type="button" data-action="close">Close</button>
      </div>
    `;
    row.querySelector('strong').textContent = item.name;
    row.querySelector('span').textContent = `${item.status} · ${item.clients} attached · ${Math.round(item.outputBytes / 1024)} KB`;
    row.querySelector('.session-main').addEventListener('click', () => attachTerminalSession(item.id));
    row.querySelector('[data-action="rename"]').addEventListener('click', () => renameTerminalSession(item));
    row.querySelector('[data-action="close"]').addEventListener('click', () => closeTerminalSession(item.id));
    sessionList.append(row);
  });
}

async function loadTerminalSessions() {
  const data = await api('/api/terminal-sessions');
  sessions = data.sessions;
  renderSessions();
  return sessions;
}

async function createTerminalSession(name = '') {
  fitAddon.fit();
  const data = await api('/api/terminal-sessions', {
    method: 'POST',
    body: JSON.stringify({ name, cols: terminal.cols, rows: terminal.rows }),
  });
  sessions = [data.session, ...sessions.filter((item) => item.id !== data.session.id)];
  renderSessions();
  attachTerminalSession(data.session.id);
}

async function renameTerminalSession(item) {
  const name = window.prompt('Session name', item.name);
  if (!name) {
    return;
  }

  await api(`/api/terminal-sessions/${item.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  await loadTerminalSessions();
}

async function closeTerminalSession(id) {
  if (!window.confirm('Close this terminal session?')) {
    return;
  }

  await api(`/api/terminal-sessions/${id}`, { method: 'DELETE' });
  if (id === activeSessionId) {
    activeSessionId = '';
    localStorage.removeItem('nova.activeSessionId');
    terminal.clear();
    currentOutput = '';
    setStatus('Session closed', 'disconnected');
    if (socket) {
      socket.close();
    }
  }
  await loadTerminalSessions();
}

async function attachTerminalSession(id) {
  activeSessionId = id;
  localStorage.setItem('nova.activeSessionId', id);
  terminal.clear();
  currentOutput = '';
  connect();
  await loadTerminalSessions();
}

function sendCommand(command) {
  if (socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
  terminal.focus();
}

function renderQuickCommands({ profile, fileName, groups, commands }) {
  quickCommandProfile.textContent = `${profile} · ${fileName}`;
  quickCommandGroups = groups?.length ? groups : [{ id: 'commands', label: 'Commands', commands }];
  quickCommandBar.replaceChildren();

  quickCommandGroups.flatMap((group) => group.commands).forEach(({ label, command }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-command';
    button.textContent = label;
    button.title = command;
    button.addEventListener('click', () => sendCommand(command));
    quickCommandBar.append(button);
  });
}

async function loadQuickCommands() {
  try {
    renderQuickCommands(await api('/api/quick-commands'));
  } catch (error) {
    quickCommandProfile.textContent = 'unavailable';
    debugLog('quick commands failed', error);
  }
}

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    cwdLabel.textContent = settings.terminalCwd;
    debugLog('settings', settings);
  } catch (error) {
    cwdLabel.textContent = 'unavailable';
    debugLog('settings failed', error);
  }
}

function handleAttach(message) {
  updateActiveMeta(message.session);
  currentOutput = message.output || '';
  terminal.clear();
  if (currentOutput) {
    terminal.write(currentOutput);
  }
  if (message.truncated) {
    terminal.writeln('\r\n\x1b[38;2;251;191;36mEarlier output was truncated by server limits.\x1b[0m');
  }
  renderSessions();
}

function connect() {
  connectionAttempt += 1;
  const attempt = connectionAttempt;

  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close(1000, 'Reconnecting');
  }

  setStatus('Connecting…', '');
  const nextSocket = new WebSocket(terminalUrl());
  debugLog('connecting', nextSocket.url);
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

    if (message.type === 'attached') {
      handleAttach(message);
      return;
    }

    if (message.type === 'output') {
      currentOutput += message.data;
      terminal.write(message.data);
      terminal.scrollToBottom();
      return;
    }

    if (message.type === 'banner') {
      currentOutput += `\r\n${message.message}\r\n`;
      terminal.writeln(`\x1b[38;2;103;247;177m${message.message}\x1b[0m`);
      loadTerminalSessions();
      return;
    }

    if (message.type === 'exit') {
      currentOutput += `\r\n${message.message}\r\n`;
      terminal.writeln(`\r\n\x1b[38;2;251;113;133m${message.message}\x1b[0m`);
      loadTerminalSessions();
    }
  });

  nextSocket.addEventListener('close', () => {
    if (attempt === connectionAttempt) {
      setStatus('Detached', 'disconnected');
      debugLog('disconnected');
      loadTerminalSessions();
    }
  });

  nextSocket.addEventListener('error', () => {
    if (attempt === connectionAttempt) {
      setStatus('Connection error', 'disconnected');
      debugLog('connection error');
    }
  });
}

function buildPaletteItems() {
  const quickItems = quickCommandGroups.flatMap((group) => group.commands.map((command) => ({
    label: command.label,
    detail: command.command,
    run: () => sendCommand(command.command),
  })));
  const actionItems = [
    { label: 'New session', detail: 'Create a detachable PTY session', run: () => createTerminalSession() },
    { label: 'Copy output', detail: 'Copy stored output to clipboard', run: copyOutput },
    { label: 'Download log', detail: 'Download stored session output', run: downloadLog },
    { label: 'Clear history', detail: 'Clear stored output history', run: clearHistory },
    { label: 'Reconnect', detail: 'Reconnect to active session', run: connect },
  ];
  return [...actionItems, ...quickItems];
}

function renderPalette() {
  const query = paletteSearch.value.toLowerCase();
  const items = buildPaletteItems().filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(query));
  paletteResults.replaceChildren();
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'palette-result';
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = item.label;
    button.querySelector('span').textContent = item.detail;
    button.addEventListener('click', () => {
      commandPalette.close();
      item.run();
    });
    paletteResults.append(button);
  });
}

function openPalette() {
  renderPalette();
  commandPalette.showModal();
  paletteSearch.value = '';
  paletteSearch.focus();
}

async function copyOutput() {
  await navigator.clipboard.writeText(currentOutput);
  setStatus('Output copied', 'connected');
}

function downloadLog() {
  const blob = new Blob([currentOutput], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${activeSessionId || 'terminal'}.log`;
  link.click();
  URL.revokeObjectURL(url);
}

async function clearHistory() {
  if (!activeSessionId || !window.confirm('Clear stored output history for this session?')) {
    return;
  }
  await api(`/api/terminal-sessions/${activeSessionId}/output`, { method: 'DELETE' });
  currentOutput = '';
  terminal.clear();
  await loadTerminalSessions();
}

terminal.onData((data) => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', data }));
  }
});

clearButton.addEventListener('click', () => terminal.clear());
reconnectButton.addEventListener('click', connect);
newSessionButton.addEventListener('click', () => createTerminalSession());
paletteButton.addEventListener('click', openPalette);
paletteSearch.addEventListener('input', renderPalette);
copyOutputButton.addEventListener('click', copyOutput);
downloadLogButton.addEventListener('click', downloadLog);
clearHistoryButton.addEventListener('click', clearHistory);
window.addEventListener('resize', fitAndResize);
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  }
});

async function bootstrap() {
  await loadCsrf();
  await loadSettings();
  await loadQuickCommands();
  const existingSessions = await loadTerminalSessions();
  if (activeSessionId && existingSessions.some((item) => item.id === activeSessionId)) {
    connect();
  } else if (existingSessions.length > 0) {
    attachTerminalSession(existingSessions[0].id);
  } else {
    createTerminalSession();
  }
  fitAndResize();
}

bootstrap().catch((error) => {
  setStatus('Startup failed', 'disconnected');
  console.error(error);
});
