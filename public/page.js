const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.documentElement.classList.add('page-ready');

function cookieValue(name) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') || '';
}

function fillCsrfInputs() {
  const csrf = decodeURIComponent(cookieValue('nova_csrf'));
  document.querySelectorAll('[data-csrf]').forEach((input) => {
    input.value = csrf;
  });
}

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

function submitWithTransition(form) {
  if (reduceMotion || form.dataset.transitioning === 'true') {
    form.submit();
    return;
  }

  form.dataset.transitioning = 'true';
  form.querySelectorAll('button[type=submit]').forEach((control) => {
    control.disabled = true;
  });
  document.documentElement.classList.add('page-leaving');
  window.setTimeout(() => form.submit(), 180);
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
  if (!(form instanceof HTMLFormElement) || form.dataset.noTransition === 'true') {
    return;
  }

  if (form.method.toLowerCase() === 'get') {
    event.preventDefault();
    navigateWithTransition(`${form.action}?${new URLSearchParams(new FormData(form))}`);
    return;
  }

  event.preventDefault();
  submitWithTransition(form);
});

fillCsrfInputs();
