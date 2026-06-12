const output = document.querySelector('#debugOutput');

async function refreshDebug() {
  try {
    const response = await fetch('/api/debug');
    output.textContent = JSON.stringify(await response.json(), null, 2);
  } catch (error) {
    output.textContent = `Failed to load debug info: ${error.message}`;
  }
}

refreshDebug();
setInterval(refreshDebug, 5000);
