const compactMode = document.querySelector('#compactMode');
const debugMode = document.querySelector('#debugMode');
const output = document.querySelector('#settingsOutput');

compactMode.checked = localStorage.getItem('nova.compact') === 'true';
debugMode.checked = localStorage.getItem('nova.debug') === 'true';
document.body.classList.toggle('compact', compactMode.checked);

compactMode.addEventListener('change', () => {
  localStorage.setItem('nova.compact', String(compactMode.checked));
  document.body.classList.toggle('compact', compactMode.checked);
});

debugMode.addEventListener('change', () => {
  localStorage.setItem('nova.debug', String(debugMode.checked));
});

fetch('/api/settings')
  .then((response) => response.json())
  .then((settings) => {
    output.textContent = JSON.stringify(settings, null, 2);
  })
  .catch((error) => {
    output.textContent = `Failed to load settings: ${error.message}`;
  });
