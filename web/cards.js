(() => {
  'use strict';
  const narrowScreen = window.matchMedia('(max-width: 600px)');
  if (!narrowScreen.matches) {
    location.replace(location.pathname.startsWith('/en/') ? '/en/' : '/');
    return;
  }

  const D = window.DevTrends;
  const page = JSON.parse(document.getElementById('page-data').textContent);
  const locale = page.locale;
  const t = (key, args) => D.t(locale, key, args);
  const items = D.reportItems(page.report);
  const stage = document.querySelector('.swipe-stage');
  const position = document.querySelector('.swipe-position');
  const previous = document.querySelector('.swipe-previous');
  const next = document.querySelector('.swipe-next');
  let storage = null;
  try { storage = window.localStorage; } catch {}
  const saved = D.readCardsProgress(storage, page.date, items.length);
  let index = D.boundedIndex(saved.maxIndex, 0, items.length);
  let pointerStart = null;
  let cancelLink = false;

  function paint(direction = 0) {
    if (!stage || !items.length) return;
    stage.innerHTML = D.renderSwipeItem(items[index], locale, { date: page.date, index });
    stage.dataset.motion = direction > 0 ? 'next' : direction < 0 ? 'previous' : '';
    position.textContent = `${index + 1} / ${items.length}`;
    previous.disabled = index === 0;
    next.disabled = index === items.length - 1;
  }
  function move(delta) {
    const target = D.boundedIndex(index, delta, items.length);
    if (target === index) {
      stage.style.removeProperty('--swipe-offset');
      return;
    }
    index = target;
    D.writeCardsProgress(storage, page.date, index, items.length);
    paint(delta);
  }
  function resetPointer() {
    stage.classList.remove('is-dragging');
    stage.style.removeProperty('--swipe-offset');
    pointerStart = null;
  }

  previous?.addEventListener('click', () => move(-1));
  next?.addEventListener('click', () => move(1));
  document.addEventListener('keydown', event => {
    if (event.target.closest('input, select, textarea')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  });
  stage?.addEventListener('click', event => {
    if (!cancelLink) return;
    event.preventDefault();
    cancelLink = false;
  });
  stage?.addEventListener('pointerdown', event => {
    if (!event.isPrimary || !['touch', 'pen'].includes(event.pointerType)) return;
    if (event.clientX < 24 || event.clientX > window.innerWidth - 24) return;
    pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
    stage.setPointerCapture?.(event.pointerId);
  });
  stage?.addEventListener('pointermove', event => {
    if (!pointerStart || event.pointerId !== pointerStart.id) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
    event.preventDefault();
    cancelLink = true;
    stage.classList.add('is-dragging');
    stage.style.setProperty('--swipe-offset', `${Math.max(-120, Math.min(120, dx * .42))}px`);
  });
  const finishPointer = event => {
    if (!pointerStart || event.pointerId !== pointerStart.id) return;
    const step = event.type === 'pointerup' ? D.swipeStep(event.clientX - pointerStart.x, event.clientY - pointerStart.y) : 0;
    const dragged = cancelLink;
    resetPointer();
    if (step) move(step);
    if (dragged) setTimeout(() => { cancelLink = false; }, 0);
  };
  stage?.addEventListener('pointerup', finishPointer);
  stage?.addEventListener('pointercancel', finishPointer);

  const themePicker = document.getElementById('theme-picker');
  function syncThemePicker() {
    const preference = window.DevTrendsTheme.get();
    themePicker.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference)));
    const label = `${t('theme')}: ${t(preference)}`;
    themePicker.querySelector('summary').setAttribute('aria-label', label);
    themePicker.querySelector('summary').title = label;
  }
  syncThemePicker();
  themePicker.addEventListener('click', event => {
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    window.DevTrendsTheme.set(button.dataset.themeChoice);
    syncThemePicker();
    themePicker.open = false;
    themePicker.querySelector('summary').focus();
  });
  document.getElementById('language-select').addEventListener('change', event => {
    const route = location.pathname.replace(/^\/en(?=\/|$)/, '') || '/';
    location.assign(D.localPath(route, event.target.value));
  });

  narrowScreen.addEventListener?.('change', event => {
    if (!event.matches) location.replace(locale === 'en' ? '/en/' : '/');
  });
  paint();
})();
