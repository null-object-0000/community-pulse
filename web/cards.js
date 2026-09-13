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
  const close = document.querySelector('.cards-close');
  let storage = null;
  try { storage = window.localStorage; } catch {}
  const saved = D.readCardsProgress(storage, page.date, items.length);
  let index = D.boundedIndex(saved.maxIndex, 0, items.length);

  let drag = null;          // { id, x, y, axis, dx, dy } while a pointer is down
  let cancelLink = false;   // set when a drag happened, so the card link does not also fire
  // Deadline rather than a boolean: a flag that is only cleared by a timer leaves the whole deck
  // permanently unresponsive if that callback ever throws. A timestamp cannot get stuck.
  let animatingUntil = 0;
  const isAnimating = () => Date.now() < animatingUntil;

  // Spring-ish easing for the snap back to rest; commit uses a shorter, decisive ease so the card
  // visibly leaves rather than easing out of sight.
  const SNAP_BACK_MS = 260;
  const FLY_OUT_MS = 220;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motion = () => (reduceMotion.matches ? 0 : 1);

  const cardWidth = () => (stage?.getBoundingClientRect().width || window.innerWidth);

  // Returning through history reuses the homepage from the back/forward cache and restores its
  // exact scroll position. Direct visits retain the anchor's ordinary home fallback.
  close?.addEventListener('click', event => {
    try {
      const from = new URL(document.referrer);
      const homePath = locale === 'en' ? '/en/' : '/';
      if (history.length > 1 && from.origin === location.origin && from.pathname === homePath) {
        event.preventDefault();
        history.back();
      }
    } catch {}
  });

  function paintDeck() {
    if (!stage || !items.length) return;
    // Depth 2 first so depth 0 lands last in the DOM; z-index also orders them, but keeping the
    // source order bottom-up means the a11y tree and the paint order agree.
    const forward = D.swipeDeck(items, index).reverse()
      .map(({ item, index: at, depth, interactive }) => D.renderSwipeItem(item, locale, { date: page.date, index: at, depth, interactive }))
      .join('');
    // The normal stack looks forward. A separate dormant card is the real previous item, ready to
    // be revealed under a right swipe; without it the UI showed the next item underneath and then
    // swapped in the previous item after release, which made only that direction feel abrupt.
    const previous = index > 0
      ? D.renderSwipeItem(items[index - 1], locale, { date: page.date, index: index - 1, depth: 'previous', interactive: false })
      : '';
    stage.innerHTML = previous + forward;
    position.textContent = `${index + 1} / ${items.length}`;
    applyDrag(0);
  }

  // Live drag: the top card follows the finger one-to-one (the deck is not a carousel, so the card
  // must stay under your thumb), while the cards behind it grow and rise as it leaves.
  function applyDrag(dx) {
    if (!stage) return;
    const top = stage.querySelector('.swipe-item[data-depth="0"]');
    const second = stage.querySelector('.swipe-item[data-depth="1"]');
    const third = stage.querySelector('.swipe-item[data-depth="2"]');
    const previous = stage.querySelector('.swipe-item[data-depth="previous"]');
    const width = cardWidth();
    const geometry = D.swipeStackGeometry(dx, width);
    const goingBack = dx > 0;
    if (top) {
      top.style.transform = `translateX(${dx}px) rotate(${geometry.rotate}deg)`;
      // A little fade at the edges sells the motion without a second render pass.
      top.style.opacity = String(1 - geometry.progress * 0.25);
    }
    if (previous) {
      previous.style.visibility = goingBack ? 'visible' : 'hidden';
      previous.style.opacity = goingBack ? '1' : '0';
      previous.style.transform = `translateY(${geometry.nextOffset}px) scale(${geometry.nextScale})`;
    }
    if (second) {
      second.style.visibility = goingBack ? 'hidden' : 'visible';
      second.style.transform = `translateY(${geometry.nextOffset}px) scale(${geometry.nextScale})`;
    }
    if (third) {
      third.style.visibility = goingBack ? 'hidden' : 'visible';
      third.style.transform = `translateY(${geometry.thirdOffset}px) scale(${geometry.thirdScale})`;
    }
  }

  function clearInlineTransforms() {
    stage?.querySelectorAll('.swipe-item').forEach(node => {
      node.style.removeProperty('transform');
      node.style.removeProperty('opacity');
      node.style.removeProperty('transition');
      node.style.removeProperty('visibility');
    });
  }

  // A transition only runs if the browser has committed the "from" state while `transition: none`
  // was in effect. Setting the transition and the new transform in the same style recalc (no reflow
  // between) makes the change land as a jump — which is exactly what made the first version of this
  // feel like a page swap instead of a card leaving. The forced reflow is the whole point.
  function animateNodes(nodes, ms, ease) {
    const live = nodes.filter(Boolean);
    if (!ms || !live.length) return;
    live.forEach(node => { node.style.transition = 'none'; });
    void stage.offsetWidth;
    live.forEach(node => { node.style.transition = `transform ${ms}ms ${ease}, opacity ${ms}ms ease`; });
  }

  function setTransitions(ms, ease) {
    stage?.querySelectorAll('.swipe-item').forEach(node => {
      node.style.transition = `transform ${ms}ms ${ease}, opacity ${ms}ms ease`;
    });
  }

  // Released before the commit distance: the card slides back into the stack, and the card behind it
  // shrinks back to its waiting size.
  function springBack() {
    const ms = motion() ? SNAP_BACK_MS : 0;
    if (!ms) { clearInlineTransforms(); applyDrag(0); return; }
    animatingUntil = Date.now() + ms;
    animateNodes([0, 1, 2].map(depth => stage.querySelector(`.swipe-item[data-depth="${depth}"]`)), ms, 'cubic-bezier(.22,.61,.36,1)');
    applyDrag(0);
    window.setTimeout(() => { clearInlineTransforms(); applyDrag(0); }, ms);
  }

  function center(target) {
    index = D.boundedIndex(target, 0, items.length);
    D.writeCardsProgress(storage, page.date, index, items.length);
    paintDeck();
  }

  // A committed swipe: the top card keeps travelling the way it was thrown while the card behind it
  // grows into place, and only then is the deck rebuilt. Promoting during the fly-out — instead of
  // swapping the contents on release — is what makes the whole card read as moving.
  function commit(delta, dx) {
    if (!items.length) return;
    const target = D.boundedIndex(index, delta, items.length);
    if (target === index) { springBack(); return; }
    const ms = motion() ? FLY_OUT_MS : 0;
    if (!ms) { clearInlineTransforms(); center(target); return; }
    const width = cardWidth();
    const exitX = (delta > 0 ? -1 : 1) * width * 1.15;
    animatingUntil = Date.now() + ms;
    const top = stage.querySelector('.swipe-item[data-depth="0"]');
    const second = stage.querySelector('.swipe-item[data-depth="1"]');
    const third = stage.querySelector('.swipe-item[data-depth="2"]');
    const previous = stage.querySelector('.swipe-item[data-depth="previous"]');
    const incoming = delta < 0 ? previous : second;
    const trailing = delta < 0 ? null : third;
    if (delta < 0 && previous) {
      previous.style.visibility = 'visible';
      previous.style.opacity = '1';
      if (!dx) previous.style.transform = 'translateY(14px) scale(.94)';
      if (second) second.style.visibility = 'hidden';
      if (third) third.style.visibility = 'hidden';
    }
    animateNodes([top, incoming, trailing], ms, 'cubic-bezier(.4,0,.7,.5)');
    if (top) {
      top.style.transform = `translateX(${exitX}px) rotate(${Math.max(-14, Math.min(14, exitX / 14))}deg)`;
      top.style.opacity = '0';
    }
    if (incoming) incoming.style.transform = 'translateY(0) scale(1)';
    if (trailing) trailing.style.transform = 'translateY(14px) scale(.94)';
    window.setTimeout(() => {
      clearInlineTransforms();
      center(target);
    }, ms);
    void dx;
  }

  function go(delta) {
    if (isAnimating() || !items.length) return;
    commit(delta, delta > 0 ? -cardWidth() : cardWidth());
  }

  document.addEventListener('keydown', event => {
    if (event.target.closest('input, select, textarea')) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
  });

  stage?.addEventListener('click', event => {
    if (!cancelLink) return;
    event.preventDefault();
    cancelLink = false;
  });

  stage?.addEventListener('pointerdown', event => {
    if (!event.isPrimary || !['touch', 'pen'].includes(event.pointerType)) return;
    // Leave the screen edges to the browser's own back gesture.
    if (event.clientX < 24 || event.clientX > window.innerWidth - 24) return;
    if (isAnimating()) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, dx: 0, samples: [] };
    // Capture keeps the drag alive when the finger leaves the card. It throws for a pointer id the
    // browser does not know (and on some synthetic events), which must not abort the gesture.
    try { stage.setPointerCapture?.(event.pointerId); } catch {}
    const top = stage.querySelector('.swipe-item[data-depth="0"]');
    if (top) { top.style.transition = 'none'; }
  });

  stage?.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    // Lock the axis on the first meaningful move so a vertical scroll never nudges the card.
    if (!drag.axis) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'x' : 'y';
      if (drag.axis === 'y') { drag = null; return; }
    }
    if (drag.axis !== 'x') return;
    event.preventDefault();
    cancelLink = true;
    drag.dx = dx;
    // Keep a short trail so the release can tell a flick from a slow drag.
    drag.samples.push({ x: event.clientX, t: performance.now() });
    if (drag.samples.length > 8) drag.samples.shift();
    applyDrag(dx);
  });

  const endDrag = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const { dx, samples } = drag;
    drag = null;
    if (event.type !== 'pointerup') { springBack(); return; }
    // Speed of the last movement, taken from the recent samples rather than the whole gesture so a
    // drag that stops before release is not mistaken for a flick.
    const now = performance.now();
    const recent = samples.filter(sample => now - sample.t < 120);
    const first = recent[0] || samples[0];
    const last = recent[recent.length - 1];
    const velocity = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const width = cardWidth();
    // Committing on distance OR speed is the behaviour every platform uses; distance alone makes
    // every card a deliberate drag.
    const far = Math.abs(dx) >= D.swipeCommitDistance(width);
    if (far || D.swipeFlicked(velocity)) commit(dx < 0 ? 1 : -1, dx);
    else springBack();
    window.setTimeout(() => { cancelLink = false; }, 0);
  };
  stage?.addEventListener('pointerup', endDrag);
  stage?.addEventListener('pointercancel', endDrag);

  const themePicker = document.getElementById('theme-picker');
  const accentMessage = { neutral: 'neutralAccent', blue: 'blueAccent', forest: 'forestAccent', violet: 'violetAccent' };
  function syncThemePicker() {
    const preference = window.DevTrendsTheme.get();
    const accent = window.DevTrendsTheme.getAccent();
    themePicker.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference)));
    themePicker.querySelectorAll('[data-accent-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.accentChoice === accent)));
    const label = `${t('theme')}: ${t(preference)} · ${t('accentTheme')}: ${t(accentMessage[accent])}`;
    themePicker.querySelector('summary').setAttribute('aria-label', label);
    themePicker.querySelector('summary').title = label;
  }
  syncThemePicker();
  themePicker.addEventListener('click', event => {
    const accentButton = event.target.closest('[data-accent-choice]');
    if (accentButton) {
      window.DevTrendsTheme.setAccent(accentButton.dataset.accentChoice);
      syncThemePicker();
      themePicker.open = false;
      themePicker.querySelector('summary').focus();
      return;
    }
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    window.DevTrendsTheme.set(button.dataset.themeChoice);
    syncThemePicker();
    themePicker.open = false;
    themePicker.querySelector('summary').focus();
  });
  const languagePicker = document.getElementById('language-picker');
  const languageSummary = languagePicker.querySelector('summary');
  languagePicker.addEventListener('click', event => {
    const button = event.target.closest('[data-language-choice]');
    if (!button) return;
    languagePicker.open = false;
    try { localStorage.setItem('devtrends-locale-v1', button.dataset.languageChoice); } catch {}
    const route = location.pathname.replace(/^\/en(?=\/|$)/, '') || '/';
    location.assign(D.localPath(route, button.dataset.languageChoice));
  });
  languagePicker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && languagePicker.open) {
      event.preventDefault(); languagePicker.open = false; languageSummary.focus(); return;
    }
  });
  document.addEventListener('click', event => {
    if (!languagePicker.contains(event.target)) languagePicker.open = false;
  });

  narrowScreen.addEventListener?.('change', event => {
    if (!event.matches) location.replace(locale === 'en' ? '/en/' : '/');
  });
  // A rotation changes the card width, so the commit distance and the resting stack both change.
  window.addEventListener('resize', () => { if (!drag && !isAnimating()) paintDeck(); });
  paintDeck();
})();
