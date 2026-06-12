const compactMode = document.querySelector('#compactMode');
const debugMode = document.querySelector('#debugMode');
const fontSize = document.querySelector('#fontSize');
const accentColor = document.querySelector('#accentColor');
const saveSettings = document.querySelector('#saveSettings');
const resetSettings = document.querySelector('#resetSettings');
const output = document.querySelector('#settingsOutput');
const quickCommandsOutput = document.querySelector('#quickCommandsOutput');
const userCommandLabel = document.querySelector('#userCommandLabel');
const userCommandValue = document.querySelector('#userCommandValue');
const addUserCommand = document.querySelector('#addUserCommand');
const saveUserCommands = document.querySelector('#saveUserCommands');
const userCommandList = document.querySelector('#userCommandList');
let csrfToken = '';
let userCommands = [];

const defaults = {
  compact: 'false',
  debug: 'false',
  fontSize: '14',
  accent: 'cyan',
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.method && options.method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json();
}

function applySettings() {
  document.body.classList.toggle('compact', compactMode.checked);
  document.documentElement.dataset.accent = accentColor.value;
  document.documentElement.style.setProperty('--terminal-font-size', `${fontSize.value}px`);
}

function readSettings() {
  compactMode.checked = localStorage.getItem('nova.compact') === 'true';
  debugMode.checked = localStorage.getItem('nova.debug') === 'true';
  fontSize.value = localStorage.getItem('nova.fontSize') || defaults.fontSize;
  accentColor.value = localStorage.getItem('nova.accent') || defaults.accent;
  applySettings();
}

function writeSettings() {
  localStorage.setItem('nova.compact', String(compactMode.checked));
  localStorage.setItem('nova.debug', String(debugMode.checked));
  localStorage.setItem('nova.fontSize', fontSize.value);
  localStorage.setItem('nova.accent', accentColor.value);
  applySettings();
}

function resetBrowserSettings() {
  ['nova.compact', 'nova.debug', 'nova.fontSize', 'nova.accent'].forEach((key) => localStorage.removeItem(key));
  readSettings();
}

function renderUserCommands() {
  userCommandList.replaceChildren();
  if (userCommands.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No user commands yet.';
    userCommandList.append(empty);
    return;
  }

  userCommands.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'user-command-row';
    row.innerHTML = '<strong></strong><code></code><button type="button">Remove</button>';
    row.querySelector('strong').textContent = item.label;
    row.querySelector('code').textContent = item.command;
    row.querySelector('button').addEventListener('click', () => {
      userCommands.splice(index, 1);
      renderUserCommands();
    });
    userCommandList.append(row);
  });
}

function addCommand() {
  const label = userCommandLabel.value.trim();
  const command = userCommandValue.value.trim();
  if (!label || !command) {
    return;
  }
  userCommands.push({ label, command });
  userCommandLabel.value = '';
  userCommandValue.value = '';
  renderUserCommands();
}

[compactMode, debugMode, fontSize, accentColor].forEach((control) => {
  control.addEventListener('change', applySettings);
});

saveSettings.addEventListener('click', writeSettings);
resetSettings.addEventListener('click', resetBrowserSettings);
addUserCommand.addEventListener('click', addCommand);
saveUserCommands.addEventListener('click', async () => {
  await api('/api/user-quick-commands', { method: 'PUT', body: JSON.stringify({ commands: userCommands }) });
  quickCommandsOutput.textContent = JSON.stringify(await api('/api/quick-commands'), null, 2);
});

readSettings();

try {
  csrfToken = (await api('/api/csrf')).token;
  const settings = await api('/api/settings');
  output.textContent = JSON.stringify(settings, null, 2);
  const quickCommands = await api('/api/quick-commands');
  quickCommandsOutput.textContent = JSON.stringify(quickCommands, null, 2);
  userCommands = (await api('/api/user-quick-commands')).commands;
  renderUserCommands();
} catch (error) {
  output.textContent = `Failed to load settings: ${error.message}`;
}
