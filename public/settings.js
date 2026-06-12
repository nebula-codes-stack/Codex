const compactMode = document.querySelector('#compactMode');
const debugMode = document.querySelector('#debugMode');
const fontSize = document.querySelector('#fontSize');
const accentColor = document.querySelector('#accentColor');
const saveSettings = document.querySelector('#saveSettings');
const resetSettings = document.querySelector('#resetSettings');
const output = document.querySelector('#settingsOutput');
const quickCommandsOutput = document.querySelector('#quickCommandsOutput');

const defaults = {
  compact: 'false',
  debug: 'false',
  fontSize: '14',
  accent: 'cyan',
};

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

[compactMode, debugMode, fontSize, accentColor].forEach((control) => {
  control.addEventListener('change', applySettings);
});

saveSettings.addEventListener('click', writeSettings);
resetSettings.addEventListener('click', resetBrowserSettings);

readSettings();

fetch('/api/settings')
  .then((response) => response.json())
  .then((settings) => {
    output.textContent = JSON.stringify(settings, null, 2);
  })
  .catch((error) => {
    output.textContent = `Failed to load settings: ${error.message}`;
  });

fetch('/api/quick-commands')
  .then((response) => response.json())
  .then((quickCommands) => {
    quickCommandsOutput.textContent = JSON.stringify(quickCommands, null, 2);
  })
  .catch((error) => {
    quickCommandsOutput.textContent = `Failed to load quick commands: ${error.message}`;
  });
