(() => {
  'use strict';
  const D = window.DevTrends;
  const page = JSON.parse(document.getElementById('page-data').textContent);
  const locale = page.locale;
  const t = (key, args) => D.t(locale, key, args);
  const params = new URLSearchParams(location.search);
  // Every page filters by the preset categories; the sidebar source directory is informational only.
  let category = page.view !== 'trend-cluster' && D.isCategoryId(params.get('category')) ? params.get('category') : 'all';
  let query = params.get('q') || '';
  let sort = 'default';
  // The category library renders wide ranges incrementally; report feeds keep rendering everything.
  let chunkSize = 0;
  let chunkShown = 1;
  const loadMoreButton = document.getElementById('load-more');
  const search = document.getElementById('search');
  const feed = document.getElementById('feed');
  const domFeed = page.feedMode === 'dom';
  const feedRows = domFeed && feed ? [...feed.querySelectorAll(':scope > .feed-item')] : [];
  let items = domFeed ? [] : D.reportItems(page.report);
  // ---- comments: one stable GitHub Discussion per report, shared by home/archive and zh/en routes ----
  const comments = document.querySelector('[data-giscus-comments]');
  function giscusTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }
  function syncGiscusTheme() {
    const frame = document.querySelector('iframe.giscus-frame');
    frame?.contentWindow?.postMessage({ giscus: { setConfig: { theme: giscusTheme() } } }, 'https://giscus.app');
  }
  function loadComments() {
    if (!comments || comments.dataset.giscusLoaded === '1') return;
    comments.dataset.giscusLoaded = '1';
    const script = document.createElement('script');
    script.src = 'https://giscus.app/client.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    const config = {
      repo: comments.dataset.giscusRepo,
      repoId: comments.dataset.giscusRepoId,
      category: comments.dataset.giscusCategory,
      categoryId: comments.dataset.giscusCategoryId,
      mapping: 'specific',
      term: comments.dataset.giscusTerm,
      strict: '1',
      reactionsEnabled: '1',
      emitMetadata: '0',
      inputPosition: 'top',
      theme: giscusTheme(),
      lang: comments.dataset.giscusLang,
      loading: 'lazy',
    };
    for (const [key, value] of Object.entries(config)) script.dataset[key] = value;
    comments.querySelector('.giscus').appendChild(script);
  }
  if (comments) {
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        loadComments();
      }, { rootMargin: '500px 0px' });
      observer.observe(comments);
    } else loadComments();
    new MutationObserver(syncGiscusTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  // ---- screenshot viewer: every gallery thumbnail (feed rows and project pages) opens one dialog ----
  const lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.hidden = true;
  lightbox.innerHTML = `<div class="lightbox-dialog" role="dialog" aria-modal="true" aria-label="${D.escapeHtml(t('gallery'))}"><button type="button" class="lightbox-close" aria-label="${D.escapeHtml(t('closeViewer'))}">✕</button><button type="button" class="lightbox-step prev" aria-label="${D.escapeHtml(t('previousImage'))}">‹</button><img class="lightbox-image" alt="${D.escapeHtml(t('gallery'))}" /><button type="button" class="lightbox-step next" aria-label="${D.escapeHtml(t('nextImage'))}">›</button><p class="lightbox-counter" aria-live="polite"></p></div>`;
  document.body.appendChild(lightbox);
  const lightboxImage = lightbox.querySelector('.lightbox-image');
  const lightboxCounter = lightbox.querySelector('.lightbox-counter');
  let galleryImages = [];
  let galleryOrigins = [];
  let galleryIndex = 0;
  let galleryOpener = null;
  function paintLightbox() {
    lightboxImage.src = galleryImages[galleryIndex];
    // The dialog repeats the thumbnail's own description so its alt is never empty either.
    lightboxImage.alt = galleryOpener?.getAttribute('aria-label') || t('gallery');
    // Name the image's origin beside the counter: "our screenshot" and "the site's OG card" look
    // alike in a viewer but mean different things.
    const origin = galleryOrigins[galleryIndex];
    lightboxCounter.textContent = t('imageCounter', { n: galleryIndex + 1, total: galleryImages.length }) + (origin ? ` · ${origin}` : '');
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
    galleryOrigins = [];
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
      let origins = [];
      try {
        const box = thumb.closest('.item-gallery');
        images = JSON.parse(box.dataset.gallery || '[]');
        origins = JSON.parse(box.dataset.origins || '[]');
      } catch { images = []; origins = []; }
      if (!Array.isArray(images) || !images.length) return;
      event.preventDefault();
      galleryOrigins = Array.isArray(origins) ? origins : [];
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
    return [{ id: 'all', label: filterMeta().all, count: domFeed ? feedRows.length : items.length, active: category === 'all' },
      ...D.categories.map(entry => ({ id: entry.id, label: locale === 'en' ? entry.labelEn : entry.labelZh,
        count: domFeed ? feedRows.filter(row => row.dataset.category === entry.id).length : items.filter(item => D.itemCategory(item) === entry.id).length,
        active: category === entry.id }))];
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
  function renderFeed(resetPage = true) {
    if (!feed) return;
    const q = query.trim().toLocaleLowerCase(locale);
    if (domFeed) {
      if (sort !== feed.dataset.sort) {
        const ordered = sort === 'popular'
          ? feedRows.map((row, index) => ({ row, index })).sort((a, b) => Number(b.row.dataset.score) - Number(a.row.dataset.score) || a.index - b.index).map(entry => entry.row)
          : feedRows;
        feed.append(...ordered);
        feed.dataset.sort = sort;
      }
      let visible = 0;
      for (const row of feedRows) {
        row.hidden = (category !== 'all' && row.dataset.category !== category) || Boolean(q && !row.dataset.search.includes(q));
        if (!row.hidden) visible++;
      }
      feed.hidden = visible === 0;
      document.getElementById('empty').hidden = visible > 0;
      document.getElementById('empty-title').textContent = t('empty');
      document.getElementById('empty-hint').textContent = t('emptyHint');
      document.getElementById('clear-filters').hidden = !query && category === 'all';
      return;
    }
    const filtered = items.filter(item => (category === 'all' || D.itemCategories(item).includes(category)) && (!q || [item.title, item.titleEn, item.title_en, item.author, item.summary, item.summaryZh, item.summary_zh, item.summaryEn, item.summary_en, D.summary(item, locale).text, item.github?.name, ...(item.tags || []), ...(item.github?.topics || [])].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(q)));
    if (sort === 'popular') filtered.sort((a, b) => Number(D.metric(b, ['stars', 'stargazers_count', 'totalStars', 'votes', 'votesCount']) || 0) - Number(D.metric(a, ['stars', 'stargazers_count', 'totalStars', 'votes', 'votesCount']) || 0));
    if (resetPage) chunkShown = 1;
    const clipped = chunkSize ? filtered.slice(0, chunkShown * chunkSize) : filtered;
    feed.innerHTML = clipped.map((item, index) => D.renderItem(item, locale, { date: page.view === 'trend-cluster' ? (item.trendDate || page.date) : page.date, index, showDate: page.view === 'trend-cluster' })).join('');
    feed.hidden = !filtered.length;
    document.getElementById('empty').hidden = Boolean(filtered.length);
    document.getElementById('empty-title').textContent = t('empty');
    document.getElementById('empty-hint').textContent = t('emptyHint');
    document.getElementById('clear-filters').hidden = !query && category === 'all';
    if (loadMoreButton) {
      const remaining = filtered.length - clipped.length;
      loadMoreButton.hidden = !chunkSize || remaining <= 0;
      loadMoreButton.textContent = remaining > 0 ? t('trendsLoadMore', { n: remaining }) : '';
    }
  }
  const themePicker = document.getElementById('theme-picker');
  const accentMessage = { neutral: 'neutralAccent', blue: 'blueAccent', forest: 'forestAccent', violet: 'violetAccent' };
  function syncThemePicker() {
    if (!themePicker) return;
    const preference = window.DevTrendsTheme.get();
    const accent = window.DevTrendsTheme.getAccent();
    themePicker.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference));
    });
    themePicker.querySelectorAll('[data-accent-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.accentChoice === accent));
    });
    const label = `${t('theme')}: ${t(preference)} · ${t('accentTheme')}: ${t(accentMessage[accent])}`;
    themePicker.querySelector('summary').setAttribute('aria-label', label);
    themePicker.querySelector('summary').title = label;
  }
  syncThemePicker();
  // Every page shell ships the picker, but a missing one must never take the rest of the script down
  // with it (that is how the dynamic product pages used to lose their filters and tracking).
  themePicker?.addEventListener('click', event => {
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
  document.addEventListener('click', event => {
    if (themePicker && !themePicker.contains(event.target)) themePicker.open = false;
  });
  document.addEventListener('keydown', event => {
    if (themePicker && event.key === 'Escape' && themePicker.open) {
      themePicker.open = false;
      themePicker.querySelector('summary').focus();
    }
  });
  function bindMenuPicker(picker, choiceAttribute, onChoose) {
    if (!picker) return;
    const summary = picker.querySelector('summary');
    const buttons = [...picker.querySelectorAll(`[${choiceAttribute}]`)];
    const choose = button => {
      buttons.forEach(option => option.setAttribute('aria-checked', String(option === button)));
      picker.querySelector('[data-menu-current]').textContent = button.dataset.menuLabel;
      picker.open = false;
      summary.focus();
      onChoose(button.getAttribute(choiceAttribute));
    };
    picker.addEventListener('click', event => {
      const button = event.target.closest(`[${choiceAttribute}]`);
      if (button) choose(button);
    });
    picker.addEventListener('keydown', event => {
      if (event.target === summary && event.key === 'ArrowDown') {
        event.preventDefault(); picker.open = true; buttons[0]?.focus(); return;
      }
      if (event.key === 'Escape' && picker.open) {
        event.preventDefault(); picker.open = false; summary.focus(); return;
      }
      if (!buttons.includes(document.activeElement) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
  }
  bindMenuPicker(document.getElementById('language-picker'), 'data-language-choice', value => {
    const url = new URL(location.href);
    const route = location.pathname.replace(/^\/en(?=\/|$)/, '') || '/';
    url.pathname = D.localPath(route, value);
    url.searchParams.delete('style');
    try { localStorage.setItem('devtrends-locale-v1', value); } catch {}
    location.assign(url.pathname + url.search + url.hash);
  });
  search?.addEventListener('input', () => { query = search.value; updateFilterUrl(); renderFeed(); });
  bindMenuPicker(document.getElementById('sort-picker'), 'data-sort-choice', value => { sort = value; renderFeed(); });
  document.addEventListener('click', event => {
    document.querySelectorAll('.menu-picker[open]').forEach(picker => { if (!picker.contains(event.target)) picker.open = false; });
  });
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
  // ---- trend lens: business use cases are the default; the other stable facets are opt-in ----
  const trendFacets = document.querySelector('.trend-facets');
  if (trendFacets) {
    const allowedFacets = ['useCases', 'agentRoles', 'languages'];
    let activeFacet = allowedFacets.includes(params.get('facet')) ? params.get('facet') : 'useCases';
    const sourceFilter = document.querySelector('[data-trend-source-filter]');
    const sourceOptions = sourceFilter?.querySelector('[data-source-options]');
    const sourceStatus = sourceFilter?.querySelector('[data-source-status]');
    const sourceToggle = sourceFilter?.querySelector('[data-source-toggle]');
    const sourcePanel = sourceFilter?.querySelector('[data-source-panel]');
    const sourceValue = sourceFilter?.querySelector('[data-source-value]');
    let catalogSources = Array.isArray(page.trends?.sources) ? page.trends.sources : [];
    let selectedSources = new Set();
    let trendRequest = 0;
    let trendRefreshTimer = 0;
    const staticFacetHtml = new Map([...document.querySelectorAll('[data-trend-facet-panel]')].map(panel => [panel.dataset.trendFacetPanel, panel.innerHTML]));
    const staticCurrentWindow = document.querySelector('[data-trend-current-window]')?.textContent || '';
    const staticBaselineWindow = document.querySelector('[data-trend-baseline-window]')?.textContent || '';
    const staticCoverage = document.querySelector('[data-trend-coverage]')?.textContent || '';

    const isCustomSourceSet = () => selectedSources.size > 0 && selectedSources.size < catalogSources.length;

    const number = value => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN').format(value);
    const percent = value => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
      style: 'percent', maximumFractionDigits: 1,
    }).format(value);
    const localTrendPath = path => {
      const local = locale === 'en' ? `/en${path}` : path;
      if (!catalogSources.length || selectedSources.size === catalogSources.length) return local;
      const target = new URL(local, location.origin);
      target.searchParams.set('sources', [...selectedSources].sort().join(','));
      return `${target.pathname}${target.search}`;
    };
    function catalogCard(row, rows) {
      const label = locale === 'en' ? row.labelEn : row.labelZh;
      const parentLabel = row.parentId ? D.facetLabel(activeFacet, row.parentId, locale) : '';
      const parent = parentLabel ? (locale === 'en' ? `SUBTOPIC · ${parentLabel}` : `子主题 · ${parentLabel}`) : '';
      const href = row.path ? localTrendPath(row.path) : '';
      const title = href ? `<a href="${D.escapeHtml(href)}">${D.escapeHtml(label)}</a>` : D.escapeHtml(label);
      const change = row.isNew
        ? `<strong class="trend-change is-new">${locale === 'en' ? 'NEW' : '新出现'}</strong>`
        : `<strong class="trend-change${row.growth < 0 ? ' is-down' : ''}">${row.growth >= 0 ? '+' : ''}${percent(row.growth)}</strong>`;
      const weekly = row.weekly || [];
      const peak = Math.max(1, ...weekly.map(point => point.count));
      const bars = weekly.map((point, index) => {
        const range = `${D.dateLabel(point.start, locale)} – ${D.dateLabel(point.end, locale)}`;
        const description = locale === 'en' ? `${range}: ${number(point.count)} products` : `${range}：${number(point.count)} 个产品`;
        const height = point.count ? Math.max(8, Math.round(point.count / peak * 100)) : 3;
        return `<span class="trend-bar" data-trend-week="${index}" title="${D.escapeHtml(description)}" aria-label="${D.escapeHtml(description)}"><i style="height:${height}%"></i></span>`;
      }).join('');
      const starts = [4, 8, 12].map(weeks => `${weeks}:${weekly[Math.max(0, weekly.length - weeks)]?.start || ''}`).join(';');
      const spark = weekly.length ? `<div class="trend-spark" aria-label="${locale === 'en' ? 'Weekly new products' : '每周新增产品'}"><div class="trend-spark-heading"><span>${locale === 'en' ? 'Weekly new products' : '每周新增产品'}</span></div><div class="trend-bars">${bars}</div><div class="trend-axis"><time class="trend-axis-start" data-trend-starts="${D.escapeHtml(starts)}">${D.escapeHtml(D.dateLabel(weekly[0].start, locale))}</time><time>${D.escapeHtml(D.dateLabel(weekly.at(-1).end, locale))}</time></div></div>` : '';
      const examples = (row.examples || []).map(example => `<li>${example.url ? `<a href="${D.escapeHtml(example.internal ? D.localPath(example.url, locale) : example.url)}"${example.internal ? '' : ' target="_blank" rel="noopener noreferrer"'}>${D.escapeHtml(example.title)}<span aria-hidden="true">↗</span></a>` : `<span>${D.escapeHtml(example.title)}</span>`}<time datetime="${D.escapeHtml(example.date)}">${D.escapeHtml(D.dateLabel(example.date, locale))}</time></li>`).join('');
      const children = rows.filter(candidate => candidate.parentId === row.id && candidate.currentCount > 0);
      const subtopics = children.length ? `<p class="trend-subtopics"><span>${locale === 'en' ? 'Subtopics' : '子主题'}</span>${children.map(child => `<a href="${D.escapeHtml(localTrendPath(child.path))}">${D.escapeHtml(locale === 'en' ? child.labelEn : child.labelZh)}<em>${number(child.currentCount)}</em></a>`).join('')}</p>` : '';
      const count = locale === 'en' ? `${number(row.currentCount)} products` : `${number(row.currentCount)} 个产品`;
      const countHtml = href ? `<a href="${D.escapeHtml(href)}">${count} →</a>` : count;
      return `<article class="trend-card${row.parentId ? ' is-subtopic' : ''}" data-catalog-trend-id="${D.escapeHtml(row.id)}"><header><div><span class="trend-kind">${D.escapeHtml(parent || (locale === 'en' ? 'FULL CATALOG' : '全量产品库'))}</span><h2>${title}</h2></div>${change}</header><div class="trend-metrics"><b>${countHtml}</b><span>${locale === 'en' ? `${number(row.sourceCount)} sources` : `${number(row.sourceCount)} 个来源`}</span><span>${locale === 'en' ? 'Baseline' : '基线'} ${number(row.previousCount)}</span></div>${spark}${subtopics}${examples ? `<h3>${locale === 'en' ? 'Recent examples' : '近期代表'}</h3><ul>${examples}</ul>` : ''}</article>`;
    }
    function updateSourceUrl() {
      const url = new URL(location.href);
      const selected = [...selectedSources].sort();
      if (selected.length === catalogSources.length) url.searchParams.delete('sources');
      else url.searchParams.set('sources', selected.join(','));
      history.replaceState(null, '', url);
    }
    async function refreshCatalogTrends() {
      if (!catalogSources.length || !selectedSources.size) {
        paintSourceStatus(locale === 'en' ? 'Choose at least one source.' : '请至少选择一个数据源。');
        const panel = document.querySelector(`[data-trend-facet-panel="${activeFacet}"]`);
        if (panel) panel.innerHTML = `<p class="trend-empty">${locale === 'en' ? 'Choose at least one source to calculate trends.' : '请选择至少一个数据源后再计算趋势。'}</p>`;
        return;
      }
      const requestId = ++trendRequest;
      const panel = document.querySelector(`[data-trend-facet-panel="${activeFacet}"]`);
      panel?.setAttribute('aria-busy', 'true');
      const query = new URLSearchParams({ facet: activeFacet, sources: [...selectedSources].sort().join(',') });
      try {
        const response = await fetch(`/api/v1/trends?${query}`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (requestId !== trendRequest) return;
        const rows = data.results.filter(row => row.currentCount > 0);
        if (panel) panel.innerHTML = rows.length
          ? rows.map(row => catalogCard(row, data.results)).join('')
          : `<p class="trend-empty">${locale === 'en' ? 'No matching products in this period.' : '当前周期没有符合条件的产品。'}</p>`;
        const currentWindow = document.querySelector('[data-trend-current-window]');
        const baselineWindow = document.querySelector('[data-trend-baseline-window]');
        const coverage = document.querySelector('[data-trend-coverage]');
        if (currentWindow) currentWindow.textContent = `${D.dateLabel(data.filters.from, locale)} – ${D.dateLabel(data.filters.to, locale)}`;
        if (baselineWindow) baselineWindow.textContent = `${D.dateLabel(data.filters.comparison.from, locale)} – ${D.dateLabel(data.filters.comparison.to, locale)}`;
        if (coverage) coverage.textContent = locale === 'en'
          ? `${number(data.coverage.uniqueProducts)} unique products · ${number(data.coverage.classifiedProducts)} classified · ${percent(data.coverage.classificationRate)} coverage. First-seen dates are recomputed within the selected sources.`
          : `${number(data.coverage.uniqueProducts)} 个去重产品 · ${number(data.coverage.classifiedProducts)} 个已有分类 · 分类覆盖率 ${percent(data.coverage.classificationRate)}。首次发现日期按当前所选来源重新计算。`;
        paintSourceStatus(locale === 'en'
          ? `${selectedSources.size} of ${catalogSources.length} sources participate in this result.`
          : `${catalogSources.length} 个来源中有 ${selectedSources.size} 个参与本次计算。`);
        const period = document.querySelector('.trend-period');
        if (period) period.hidden = false;
        period?.querySelector('[data-trend-weeks][aria-pressed="true"]')?.click();
      } catch (_) {
        if (requestId === trendRequest) paintSourceStatus(locale === 'en'
          ? 'The full-catalog query is temporarily unavailable; showing the static fallback.'
          : '全量产品库查询暂时不可用，当前保留静态兜底结果。');
      } finally {
        if (requestId === trendRequest) panel?.removeAttribute('aria-busy');
      }
    }
    function scheduleCatalogTrends() {
      clearTimeout(trendRefreshTimer);
      trendRefreshTimer = setTimeout(refreshCatalogTrends, 220);
    }
    function restoreCatalogSnapshot() {
      trendRequest++;
      for (const panel of document.querySelectorAll('[data-trend-facet-panel]')) {
        if (staticFacetHtml.has(panel.dataset.trendFacetPanel)) panel.innerHTML = staticFacetHtml.get(panel.dataset.trendFacetPanel);
        panel.removeAttribute('aria-busy');
      }
      const currentWindow = document.querySelector('[data-trend-current-window]');
      const baselineWindow = document.querySelector('[data-trend-baseline-window]');
      const coverage = document.querySelector('[data-trend-coverage]');
      if (currentWindow) currentWindow.textContent = staticCurrentWindow;
      if (baselineWindow) baselineWindow.textContent = staticBaselineWindow;
      if (coverage) coverage.textContent = staticCoverage;
      paintSourceStatus(locale === 'en'
        ? `All ${catalogSources.length} sources · static catalog snapshot.`
        : `全部 ${catalogSources.length} 个来源 · 静态产品库快照。`);
      document.querySelector('.trend-period')?.querySelector('[data-trend-weeks][aria-pressed="true"]')?.click();
    }
    // The explanation lives inside the checklist, but the fetch result also matters after the
    // checklist closes, so the same sentence is mirrored onto the trigger as a native tooltip.
    function paintSourceStatus(text) {
      if (sourceStatus) sourceStatus.textContent = text;
      if (sourceToggle) sourceToggle.title = text;
    }
    // The trigger names the current selection, so the closed select still says what it filters by:
    // a single source reads as its own name and the full set reads as "all sources".
    function paintSourceSummary() {
      if (!sourceValue) return;
      const selected = [...selectedSources];
      const source = catalogSources.find(candidate => candidate.id === selected[0]);
      const label = !selected.length
        ? (locale === 'en' ? 'No sources' : '未选择来源')
        : selected.length === catalogSources.length
          ? (locale === 'en' ? 'All sources' : '全部来源')
          : selected.length === 1
            ? D.sourceName({ sourceId: selected[0], sourceName: source?.name }, locale)
            : (locale === 'en' ? `${number(selected.length)} sources` : `${number(selected.length)} 个来源`);
      sourceValue.textContent = label;
    }
    function paintSourcePanel(open) {
      if (!sourcePanel || !sourceToggle) return;
      sourcePanel.hidden = !open;
      sourceToggle.setAttribute('aria-expanded', String(open));
    }
    function paintSourceOptions() {
      if (!sourceOptions) return;
      sourceOptions.innerHTML = catalogSources.map(source => {
        const name = D.sourceName({ sourceId: source.id, sourceName: source.name }, locale);
        const count = locale === 'en' ? `${number(source.productCount)} products` : `${number(source.productCount)} 个产品`;
        return `<label title="${D.escapeHtml(`${name} · ${count}`)}"><input type="checkbox" value="${D.escapeHtml(source.id)}"${selectedSources.has(source.id) ? ' checked' : ''}/><span>${D.escapeHtml(name)}</span><em>${D.escapeHtml(number(source.productCount))}</em></label>`;
      }).join('');
      paintSourceSummary();
    }
    async function loadCatalogSources() {
      if (!sourceFilter) return;
      try {
        if (!catalogSources.length) {
          const response = await fetch('/api/v1/sources', { headers: { accept: 'application/json' } });
          if (!response.ok) return;
          const data = await response.json();
          if (!Array.isArray(data.sources) || !data.sources.length) return;
          catalogSources = data.sources;
        }
        const requested = new Set((params.get('sources') || '').split(',').filter(Boolean));
        selectedSources = requested.size
          ? new Set(catalogSources.map(source => source.id).filter(id => requested.has(id)))
          : new Set(catalogSources.map(source => source.id));
        if (!selectedSources.size) selectedSources = new Set(catalogSources.map(source => source.id));
        paintSourceOptions();
        sourceFilter.hidden = false;
        if (isCustomSourceSet()) await refreshCatalogTrends();
        else restoreCatalogSnapshot();
      } catch (_) {
        // Static report-derived trends remain visible when the database is unavailable.
      }
    }
    function paintTrendFacet(updateUrl = true) {
      trendFacets.querySelectorAll('[data-trend-facet]').forEach(button => {
        const active = button.dataset.trendFacet === activeFacet;
        button.setAttribute('aria-selected', String(active));
      });
      document.querySelectorAll('[data-trend-facet-panel]').forEach(panel => { panel.hidden = panel.dataset.trendFacetPanel !== activeFacet; });
      if (!updateUrl) return;
      const url = new URL(location.href);
      activeFacet === 'useCases' ? url.searchParams.delete('facet') : url.searchParams.set('facet', activeFacet);
      history.replaceState(null, '', url);
    }
    trendFacets.addEventListener('click', event => {
      const button = event.target.closest('[data-trend-facet]');
      if (!button) return;
      activeFacet = button.dataset.trendFacet;
      paintTrendFacet();
      if (isCustomSourceSet()) scheduleCatalogTrends();
    });
    paintTrendFacet(Boolean(params.has('facet')));
    sourceToggle?.addEventListener('click', () => paintSourcePanel(sourcePanel.hidden));
    sourcePanel?.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      paintSourcePanel(false);
      sourceToggle.focus();
    });
    document.addEventListener('click', event => {
      if (!sourcePanel || sourcePanel.hidden || sourceFilter.contains(event.target)) return;
      paintSourcePanel(false);
    });
    sourceOptions?.addEventListener('change', event => {
      const input = event.target.closest('input[type="checkbox"]');
      if (!input) return;
      input.checked ? selectedSources.add(input.value) : selectedSources.delete(input.value);
      paintSourceSummary();
      updateSourceUrl();
      if (selectedSources.size === catalogSources.length) restoreCatalogSnapshot();
      else scheduleCatalogTrends();
    });
    sourceFilter?.querySelector('[data-source-all]')?.addEventListener('click', () => {
      selectedSources = new Set(catalogSources.map(source => source.id));
      paintSourceOptions(); updateSourceUrl(); restoreCatalogSnapshot();
    });
    sourceFilter?.querySelector('[data-source-none]')?.addEventListener('click', () => {
      selectedSources.clear();
      paintSourceOptions(); updateSourceUrl(); scheduleCatalogTrends();
    });
    loadCatalogSources();
  }
  // ---- trend horizon: keep one 12-week series in the static page and reveal the requested tail ----
  const trendPeriod = document.querySelector('.trend-period');
  if (trendPeriod) {
    const allowedWeeks = [4, 8, 12];
    const requested = Number((params.get('period') || '').replace(/w$/, ''));
    let visibleWeeks = allowedWeeks.includes(requested) ? requested : 12;
    function paintTrendPeriod(updateUrl = true) {
      trendPeriod.querySelectorAll('[data-trend-weeks]').forEach(button => {
        button.setAttribute('aria-pressed', String(Number(button.dataset.trendWeeks) === visibleWeeks));
      });
      document.querySelectorAll('.trend-bars').forEach(bars => {
        const points = [...bars.querySelectorAll('[data-trend-week]')];
        points.forEach((point, index) => { point.hidden = index < Math.max(0, points.length - visibleWeeks); });
      });
      document.querySelectorAll('.trend-axis-start').forEach(label => {
        const starts = Object.fromEntries((label.dataset.trendStarts || '').split(';').map(value => value.split(':')));
        if (starts[visibleWeeks]) label.textContent = D.dateLabel(starts[visibleWeeks], locale);
      });
      if (!updateUrl) return;
      const url = new URL(location.href);
      visibleWeeks === 12 ? url.searchParams.delete('period') : url.searchParams.set('period', `${visibleWeeks}w`);
      history.replaceState(null, '', url);
    }
    trendPeriod.addEventListener('click', event => {
      const button = event.target.closest('[data-trend-weeks]');
      if (!button) return;
      visibleWeeks = Number(button.dataset.trendWeeks);
      paintTrendPeriod();
    });
    paintTrendPeriod(Boolean(params.has('period')));
  }
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
    if (event.key === 'devtrends-accent-v1' || event.key === null) { window.DevTrendsTheme.setAccent(event.newValue); syncThemePicker(); }
    if (event.key === D.cardsProgressKey || event.key === null) paintCardsEntry();
  });
  function paintCardsEntry() {
    const entry = document.querySelector('[data-home-entry="cards"]');
    if (!entry) return;
    const total = Number(entry.dataset.total) || 0;
    let storage = null;
    try { storage = window.localStorage; } catch {}
    const progress = D.readCardsProgress(storage, entry.dataset.date, total);
    entry.querySelector('[data-cards-progress]').textContent = progress.complete
      ? t('cardsComplete')
      : t('cardsRead', { n: progress.readCount, total });
  }
  paintCardsEntry();
  window.addEventListener('pageshow', paintCardsEntry);
  // Warm the standalone flows only on the mobile surface where the entries are visible. Combined
  // with cross-document View Transitions this removes the blank navigation beat without turning the
  // routes into a stateful SPA.
  if (window.matchMedia('(max-width: 600px)').matches) {
    for (const entry of document.querySelectorAll('[data-home-entry]')) {
      const prefetch = document.createElement('link');
      prefetch.rel = 'prefetch';
      prefetch.href = entry.href;
      prefetch.as = 'document';
      document.head.append(prefetch);
    }
  }
  if (search) search.value = query;
  // ---- category library: recent / 4-week / 12-week views come from the versioned static snapshot.
  // The default recent list is server-rendered; wider fixed ranges lazy-load one category file.
  const clusterRange = document.querySelector('[data-cluster-range]');
  if (clusterRange && feed && page.view === 'trend-cluster') {
    const cluster = page.trendCluster || {};
    const ranges = cluster.ranges || {};
    const dataPath = cluster.dataPath;
    let range = ['4w', '12w'].includes(params.get('range')) ? params.get('range') : 'recent';
    let library = null;
    const catalogRanges = new Map();
    const statsEl = document.getElementById('cluster-range-stats');
    const countEl = document.getElementById('cluster-count');
    const sourcesEl = document.getElementById('cluster-sources');
    function paintRangeButtons() {
      clusterRange.querySelectorAll('[data-range]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.range === range));
      });
    }
    function syncRangeUrl() {
      const url = new URL(location.href);
      range === 'recent' ? url.searchParams.delete('range') : url.searchParams.set('range', range);
      history.replaceState(null, '', url);
    }
    function paintRangeStats() {
      const spec = ranges[range];
      if (!spec || !statsEl) return;
      statsEl.textContent = t('trendsRangeSpan', { n: spec.count, start: D.dateLabel(spec.start, locale), end: D.dateLabel(spec.end, locale) });
      if (countEl) countEl.textContent = range === 'recent' ? t('trendsProjects', { n: spec.count }) : t('count', { n: spec.count });
      if (sourcesEl) sourcesEl.textContent = t('trendsSources', { n: spec.sources });
    }
    async function loadCustomRange(id) {
      if (!params.get('sources')) return null;
      if (catalogRanges.has(id)) return catalogRanges.get(id);
      const spec = ranges[id];
      if (!spec) return null;
      const products = [];
      const sourceIds = new Set();
      for (let pageNumber = 1; ; pageNumber++) {
        const query = new URLSearchParams({ facet: cluster.type, term: cluster.id, sources: params.get('sources'),
          from: spec.start, to: spec.end, page: String(pageNumber), pageSize: '300' });
        const response = await fetch(`/api/v1/products?${query}`, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`catalog ${response.status}`);
        const data = await response.json();
        products.push(...(data.products || []));
        for (const product of data.products || []) for (const sourceId of product.sourceIds || [product.sourceId]) if (sourceId) sourceIds.add(sourceId);
        if (!data.hasMore) break;
      }
      ranges[id] = { ...spec, count: products.length, sources: sourceIds.size };
      catalogRanges.set(id, products);
      return products;
    }
    async function activateRange() {
      paintRangeButtons();
      paintRangeStats();
      syncRangeUrl();
      if (params.get('sources')) {
        try {
          chunkSize = 60;
          items = await loadCustomRange(range);
          paintRangeStats();
          const buttonCount = clusterRange.querySelector(`[data-range="${range}"] em`);
          if (buttonCount) buttonCount.textContent = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN').format(items.length);
          renderFeed();
          return;
        } catch (_) {
          // Keep the matching static all-source range readable while a personalized query is unavailable.
        }
      }
      if (range === 'recent') {
        chunkSize = 0;
        items = D.reportItems(page.report);
        renderFeed();
        return;
      }
      if (!library) {
        feed.hidden = true;
        try {
          const response = await fetch(dataPath);
          if (!response.ok) throw new Error(`library ${response.status}`);
          library = await response.json();
        } catch (error) {
          range = 'recent';
          paintRangeButtons();
          paintRangeStats();
          syncRangeUrl();
          items = D.reportItems(page.report);
          renderFeed();
          return;
        }
      }
      const start = (library.ranges && library.ranges[range]) ? library.ranges[range].start : (ranges[range] ? ranges[range].start : null);
      chunkSize = 60;
      items = (library.projects || []).filter(row => !start || row.trendDate >= start);
      renderFeed();
    }
    clusterRange.addEventListener('click', event => {
      const button = event.target.closest('[data-range]');
      if (!button || button.dataset.range === range) return;
      range = button.dataset.range;
      activateRange();
    });
    loadMoreButton?.addEventListener('click', () => { chunkShown++; renderFeed(false); });
    if (range !== 'recent' || params.get('sources')) activateRange();
  }
  if (feed) {
    if (domFeed) {
      syncFilterState();
      layoutFilter(filterContainer());
      if (query || category !== 'all') renderFeed();
    } else { paintFilter(); renderFeed(); }
    updateFilterUrl();
  }
  // Fix a desktop sidebar only when the complete module fits in the viewport. A taller sidebar
  // remains in normal document flow, avoiding a second scrollbar beside the page scrollbar.
  const stickySidebars = [...document.querySelectorAll('.discovery-sidebar, .project-sidebar')];
  function updateStickySidebars() {
    stickySidebars.forEach(sidebar => {
      const minWidth = sidebar.classList.contains('discovery-sidebar') ? 1361 : 901;
      const height = Math.ceil(sidebar.getBoundingClientRect().height);
      sidebar.classList.toggle('is-sticky', D.canStickSidebar(window.innerWidth, window.innerHeight, height, minWidth));
    });
  }
  let sidebarLayoutFrame = 0;
  function scheduleStickySidebars() {
    if (sidebarLayoutFrame) cancelAnimationFrame(sidebarLayoutFrame);
    sidebarLayoutFrame = requestAnimationFrame(() => { sidebarLayoutFrame = 0; updateStickySidebars(); });
  }
  updateStickySidebars();
  if (stickySidebars.length && window.ResizeObserver) {
    const sidebarObserver = new ResizeObserver(scheduleStickySidebars);
    stickySidebars.forEach(sidebar => sidebarObserver.observe(sidebar));
  }
  window.addEventListener('resize', scheduleStickySidebars);
  // Re-fit the chip row when the container width changes or web fonts finish loading.
  const filterContainers = [filterContainer()].filter(Boolean);
  const relayoutFilters = () => filterContainers.forEach(layoutFilter);
  if (filterContainers.length && window.ResizeObserver) { const observer = new ResizeObserver(relayoutFilters); filterContainers.forEach(node => observer.observe(node)); }
  window.addEventListener('resize', relayoutFilters);
  if (document.fonts?.ready) document.fonts.ready.then(() => { relayoutFilters(); scheduleStickySidebars(); }).catch(() => {});
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
