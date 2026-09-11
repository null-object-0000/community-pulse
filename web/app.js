(() => {
  'use strict';
  const D = window.DevTrends;
  const page = JSON.parse(document.getElementById('page-data').textContent);
  const locale = page.locale;
  const t = (key, args) => D.t(locale, key, args);
  const params = new URLSearchParams(location.search);
  // Every page filters by the preset categories; the sidebar source directory is informational only.
  let category = D.isCategoryId(params.get('category')) ? params.get('category') : 'all';
  let query = params.get('q') || '';
  let sort = 'default';
  const search = document.getElementById('search');
  const feed = document.getElementById('feed');
  let items = D.reportItems(page.report);
  // ---- screenshot viewer: every gallery thumbnail (feed rows and project pages) opens one dialog ----
  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.hidden = true;
  lightbox.innerHTML = `<div class="lightbox-dialog" role="dialog" aria-modal="true" aria-label="${D.escapeHtml(t('gallery'))}"><button type="button" class="lightbox-close" aria-label="${D.escapeHtml(t('closeViewer'))}">✕</button><button type="button" class="lightbox-step prev" aria-label="${D.escapeHtml(t('previousImage'))}">‹</button><img class="lightbox-image" alt="" /><button type="button" class="lightbox-step next" aria-label="${D.escapeHtml(t('nextImage'))}">›</button><p class="lightbox-counter" aria-live="polite"></p></div>`;
  document.body.appendChild(lightbox);
  const lightboxImage = lightbox.querySelector('.lightbox-image');
  const lightboxCounter = lightbox.querySelector('.lightbox-counter');
  let galleryImages = [];
  let galleryIndex = 0;
  let galleryOpener = null;
  function paintLightbox() {
    lightboxImage.src = galleryImages[galleryIndex];
    lightboxCounter.textContent = t('imageCounter', { n: galleryIndex + 1, total: galleryImages.length });
    lightbox.querySelectorAll('.lightbox-step').forEach(button => { button.hidden = galleryImages.length < 2; });
  }
  function openLightbox(images, index, opener) {
    galleryImages = images; galleryIndex = Math.min(Math.max(index, 0), images.length - 1); galleryOpener = opener || null;
    paintLightbox();
    lightbox.hidden = false;
    document.documentElement.classList.add('lightbox-open');
    lightbox.querySelector('.lightbox-close').focus();
  }
  function closeLightbox() {
    if (lightbox.hidden) return;
    lightbox.hidden = true;
    galleryImages = [];
    lightboxImage.removeAttribute('src');
    document.documentElement.classList.remove('lightbox-open');
    if (galleryOpener?.isConnected) galleryOpener.focus();
    galleryOpener = null;
  }
  function stepLightbox(delta) {
    if (lightbox.hidden || galleryImages.length < 2) return;
    galleryIndex = (galleryIndex + delta + galleryImages.length) % galleryImages.length;
    paintLightbox();
  }
  document.addEventListener('click', event => {
    const thumb = event.target.closest?.('.item-gallery [data-index]');
    if (thumb) {
      let images = [];
      try { images = JSON.parse(thumb.closest('.item-gallery').dataset.gallery || '[]'); } catch { images = []; }
      if (!Array.isArray(images) || !images.length) return;
      event.preventDefault();
      openLightbox(images, Number(thumb.dataset.index) || 0, thumb);
      return;
    }
    if (lightbox.hidden) return;
    if (event.target.closest('.lightbox-close') || event.target === lightbox) closeLightbox();
    else if (event.target.closest('.lightbox-step.prev')) stepLightbox(-1);
    else if (event.target.closest('.lightbox-step.next')) stepLightbox(1);
  });
  document.addEventListener('keydown', event => {
    if (lightbox.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); stepLightbox(-1); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); stepLightbox(1); }
  });
  function updateFilterUrl() {
    const url = new URL(location.href);
    query ? url.searchParams.set('q', query) : url.searchParams.delete('q');
    category !== 'all' ? url.searchParams.set('category', category) : url.searchParams.delete('category');
    // `source` and `style` are legacy parameters the site no longer understands.
    url.searchParams.delete('source');
    url.searchParams.delete('style');
    history.replaceState(null, '', url);
  }
  // ---- filter chips: one row, whatever does not fit collapses into the "more" menu ----
  const filterMeta = () => D.chipFilterMeta(locale);
  const filterContainer = () => document.getElementById(filterMeta().containerId);
  const chipOrder = new WeakMap();
  function filterOptions() {
    return [{ id: 'all', label: filterMeta().all, count: items.length, active: category === 'all' },
      ...D.categories.map(entry => ({ id: entry.id, label: locale === 'en' ? entry.labelEn : entry.labelZh, count: items.filter(item => D.itemCategory(item) === entry.id).length, active: category === entry.id }))];
  }
  function layoutFilter(container) {
    const row = container.querySelector('.chip-row');
    const more = container.querySelector('.chip-more');
    const menu = container.querySelector('.chip-menu');
    const trigger = more?.querySelector('.chip-more-trigger');
    if (!row || !more || !menu || !trigger) return;
    // Chip order is fixed by the markup, captured before anything is collapsed. Restoring it on
    // every pass keeps the row stable instead of appending whatever was in the menu last time.
    let chips = chipOrder.get(container);
    if (!chips) {
      chips = [...row.children].filter(node => node.matches('.chip:not(.chip-more-trigger)'));
      chipOrder.set(container, chips);
    }
    for (const node of chips) row.insertBefore(node, more);
    more.hidden = false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    const width = row.clientWidth;
    if (!width) { more.hidden = true; return; }
    const gap = parseFloat(getComputedStyle(row).columnGap) || 8;
    const widths = chips.map(node => node.offsetWidth);
    const needed = widths.reduce((total, value) => total + value, 0) + gap * Math.max(0, widths.length - 1);
    if (needed <= width) { more.hidden = true; syncMoreTrigger(container); return; }
    const visible = D.fitChipCount(widths, width, trigger.offsetWidth + gap, gap);
    for (const node of chips.slice(visible)) menu.appendChild(node);
    syncMoreTrigger(container);
  }
  // When the active filter is collapsed, the trigger carries its name so the selection stays visible.
  function syncMoreTrigger(container) {
    const more = container.querySelector('.chip-more');
    const trigger = more?.querySelector('.chip-more-trigger');
    if (!more || !trigger) return;
    const active = container.querySelector('.chip-menu .chip.is-active');
    const base = more.dataset.moreLabel || '';
    trigger.querySelector('.chip-more-label').textContent = active ? active.dataset.label : base;
    trigger.classList.toggle('is-active', Boolean(active));
    if (active) trigger.setAttribute('aria-label', `${base}: ${active.dataset.label}`);
    else trigger.removeAttribute('aria-label');
  }
  function closeChipMenus() {
    document.querySelectorAll('.chip-menu:not([hidden])').forEach(menu => {
      menu.hidden = true;
      document.querySelector(`[aria-controls="${menu.id}"]`)?.setAttribute('aria-expanded', 'false');
    });
  }
  function toggleChipMenu(trigger) {
    const menu = document.getElementById(trigger.getAttribute('aria-controls'));
    const opening = menu?.hidden;
    closeChipMenus();
    if (!menu || !opening) return;
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }
  function paintFilter() {
    const container = filterContainer();
    if (!container) return null;
    chipOrder.delete(container);
    container.innerHTML = D.chipFilterHtml(filterOptions(), locale);
    layoutFilter(container);
    return container;
  }
  function syncFilterState() {
    const meta = filterMeta(), container = filterContainer();
    if (!container) return;
    container.querySelectorAll(`[${meta.attr}]`).forEach(node => {
      const active = node.getAttribute(meta.attr) === category;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-pressed', String(active));
    });
    const select = container.querySelector(`#${meta.selectId}`);
    if (select) select.value = category;
    syncMoreTrigger(container);
  }
  function applyFilter(value) {
    category = D.isCategoryId(value) ? value : 'all';
    syncFilterState();
    updateFilterUrl();
    renderFeed();
  }
  function renderFeed() {
    if (!feed) return;
    const q = query.trim().toLocaleLowerCase(locale);
    const filtered = items.filter(item => (category === 'all' || D.itemCategories(item).includes(category)) && (!q || [item.title, item.titleEn, item.title_en, item.author, item.summary, item.summaryZh, item.summary_zh, item.summaryEn, item.summary_en, D.summary(item, locale).text, item.github?.name, ...(item.tags || []), ...(item.github?.topics || [])].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(q)));
    if (sort === 'popular') filtered.sort((a, b) => Number(D.metric(b, ['stars', 'stargazers_count', 'totalStars', 'votes', 'votesCount']) || 0) - Number(D.metric(a, ['stars', 'stargazers_count', 'totalStars', 'votes', 'votesCount']) || 0));
    feed.innerHTML = filtered.map((item, index) => D.renderItem(item, locale, { date: page.date, index })).join('');
    feed.hidden = !filtered.length;
    document.getElementById('empty').hidden = Boolean(filtered.length);
    document.getElementById('empty-title').textContent = t('empty');
    document.getElementById('empty-hint').textContent = t('emptyHint');
    document.getElementById('clear-filters').hidden = !query && category === 'all';
  }
  const themePicker = document.getElementById('theme-picker');
  function syncThemePicker() {
    const preference = window.DevTrendsTheme.get();
    themePicker.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
    });
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
  document.addEventListener('click', event => {
    if (!themePicker.contains(event.target)) themePicker.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && themePicker.open) {
      themePicker.open = false;
      themePicker.querySelector('summary').focus();
    }
  });
  document.getElementById('language-select').addEventListener('change', event => {
    const url = new URL(location.href);
    const route = location.pathname.replace(/^\/en(?=\/|$)/, '') || '/';
    url.pathname = D.localPath(route, event.target.value);
    url.searchParams.delete('style');
    try { localStorage.setItem('devtrends-locale-v1', event.target.value); } catch {}
    location.assign(url.pathname + url.search + url.hash);
  });
  search?.addEventListener('input', () => { query = search.value; updateFilterUrl(); renderFeed(); });
  document.getElementById('sort-select')?.addEventListener('change', event => { sort = event.target.value; renderFeed(); });
  document.addEventListener('keydown', event => {
    if (search && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); search.focus(); }
  });
  document.querySelectorAll('.chip-filter').forEach(container => container.addEventListener('click', event => {
    const trigger = event.target.closest('.chip-more-trigger');
    if (trigger) { toggleChipMenu(trigger); return; }
    const chip = event.target.closest('.chip');
    if (!chip || chip.disabled) return;
    const value = chip.getAttribute(filterMeta().attr);
    if (value === null) return;
    const collapsed = Boolean(chip.closest('.chip-menu'));
    applyFilter(value);
    closeChipMenus();
    (collapsed ? container.querySelector('.chip-more-trigger') : chip)?.focus();
  }));
  document.addEventListener('click', event => {
    if (!event.target.closest('.chip-more') || event.target.closest('.chip-menu .chip')) closeChipMenus();
  });
  document.addEventListener('change', event => {
    const select = event.target.closest('.chip-select select');
    if (select) applyFilter(select.value);
  });
  document.addEventListener('keydown', event => {
    const openMenu = document.querySelector('.chip-menu:not([hidden])');
    if (event.key === 'Escape' && openMenu) {
      const trigger = document.querySelector(`[aria-controls="${openMenu.id}"]`);
      closeChipMenus();
      trigger?.focus();
      return;
    }
    const trigger = document.activeElement?.closest?.('.chip-more-trigger');
    if (trigger && !openMenu && event.key === 'ArrowDown') {
      event.preventDefault();
      toggleChipMenu(trigger);
      document.getElementById(trigger.getAttribute('aria-controls'))?.querySelector('.chip:not(:disabled)')?.focus();
      return;
    }
    if (!openMenu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = [...openMenu.querySelectorAll('.chip:not(:disabled)')];
    if (!options.length) return;
    event.preventDefault();
    const index = options.indexOf(document.activeElement);
    if (event.key === 'Home') options[0].focus();
    else if (event.key === 'End') options[options.length - 1].focus();
    else if (index < 0) options[event.key === 'ArrowDown' ? 0 : options.length - 1].focus();
    else options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
  });
  document.getElementById('clear-filters')?.addEventListener('click', () => {
    category = 'all'; query = ''; search.value = '';
    syncFilterState();
    updateFilterUrl(); renderFeed(); search.focus();
  });
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (link && typeof window.gtag === 'function') {
      try {
        const url = new URL(link.href);
        if (['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin) {
          const row = link.closest('.feed-item');
          window.gtag('event', 'outbound_project_click', { link_url: url.href, link_domain: url.hostname, link_text: link.textContent.trim().slice(0, 100), report_date: page.date || 'project', source_id: row?.dataset.sourceId || page.projectItem?.sourceId || '', item_id: row?.dataset.itemId || page.projectItem?.externalId || '' });
        }
      } catch {}
    }
  });
  // A title or description clipped by the one-line list stays readable through the native tooltip,
  // but only while the rendered row actually hides text — short ones get no title.
  document.addEventListener('pointerover', event => {
    const clipped = event.target.closest?.('.item-primary h2, .item-primary .summary');
    if (!clipped) return;
    if (D.isClipped(clipped)) clipped.title = clipped.textContent;
    else clipped.removeAttribute('title');
  });
  window.addEventListener('storage', event => {
    if (event.key === 'devtrends-theme-v1' || event.key === null) { window.DevTrendsTheme.set(event.newValue); syncThemePicker(); }
  });
  if (search) search.value = query;
  if (feed) { paintFilter(); renderFeed(); updateFilterUrl(); }
  // Re-fit the chip row when the container width changes or web fonts finish loading.
  const filterContainers = [filterContainer()].filter(Boolean);
  const relayoutFilters = () => filterContainers.forEach(layoutFilter);
  if (filterContainers.length && window.ResizeObserver) { const observer = new ResizeObserver(relayoutFilters); filterContainers.forEach(node => observer.observe(node)); }
  window.addEventListener('resize', relayoutFilters);
  if (document.fonts?.ready) document.fonts.ready.then(relayoutFilters).catch(() => {});
  // Preserve legacy date links; legacy style preferences have no effect on the unified theme.
  // Report pages no longer carry a date picker, so the date is validated by shape alone.
  const legacyDate = params.get('date') || '';
  if (page.route === '/' && /^\d{4}-\d{2}-\d{2}$/.test(legacyDate)) {
    const target = new URL(D.localPath(`/reports/${legacyDate}/`, locale), location.origin);
    if (query) target.searchParams.set('q', query);
    if (category !== 'all') target.searchParams.set('category', category);
    location.replace(target.pathname + target.search);
  }
})();
