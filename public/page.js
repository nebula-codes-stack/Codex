const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.classList.add('page-ready');

function navigateWithTransition(url) {
  if (reduceMotion) {
    window.location.href = url;
    return;
  }

  document.documentElement.classList.add('page-leaving');
  window.setTimeout(() => {
    window.location.href = url;
  }, 220);
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link) {
    return;
  }

  const url = new URL(link.href, window.location.href);
  if (url.origin !== window.location.origin || link.target || link.hasAttribute('download')) {
    return;
  }

  event.preventDefault();
  navigateWithTransition(url.href);
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'get') {
    return;
  }

  event.preventDefault();
  navigateWithTransition(`${form.action}?${new URLSearchParams(new FormData(form))}`);
});
