(() => {
  'use strict';
  const D = window.DevTrends;
  const page = JSON.parse(document.getElementById('page-data').textContent);
  const locale = page.locale;
  const t = (key, args) => D.t(locale, key, args);
  const params = new URLSearchParams(location.search);
  const sourceFiltering = page.route !== '/';
  let source = sourceFiltering ? params.get('source') || 'all' : 'all';
  let category = page.route === '/' ? params.get('category') || 'all' : 'all';
  let query = params.get('q') || '';
  let sort = 'default';
  let projectPaths = null;
  const search = document.getElementById('search');
  const feed = document.getElementById('feed');
  const status = document.getElementById('status');
  let items = D.reportItems(page.report);
  function readFavorites() {
    try {
      const entries = JSON.parse(localStorage.getItem(D.favoritesKey) || '[]');
      if (!Array.isArray(entries)) return [];
      const seen = new Set();
      return entries.filter(entry => entry?.item && typeof entry.item === 'object').map(entry => ({ ...entry, id: D.favoriteId(entry.item) }))
        .filter(entry => !seen.has(entry.id) && seen.add(entry.id));
    } catch { return []; }
  }
  function savedIds() { return new Set(readFavorites().map(entry => entry.id)); }
  function announce(message) { status.textContent = message; }
  function synchronizeButtons() {
    const ids = savedIds();
    document.querySelectorAll('[data-favorite-id]').forEach(button => {
      const saved = ids.has(button.dataset.favoriteId);
      button.classList.toggle('active', saved); button.setAttribute('aria-pressed', String(saved));
      const item = items.find(item => D.favoriteId(item) === button.dataset.favoriteId) || page.projectItem;
      button.setAttribute('aria-label', `${t(saved ? 'remove' : 'save')} ${item ? D.displayTitle(item, locale) : ''}`);
      button.querySelector('span').textContent = t(saved ? 'saved' : 'save');
    });
  }
  function updateFilterUrl() {
    const url = new URL(location.href);
    query ? url.searchParams.set('q', query) : url.searchParams.delete('q');
    sourceFiltering && source !== 'all' ? url.searchParams.set('source', source) : url.searchParams.delete('source');
    category !== 'all' ? url.searchParams.set('category', category) : url.searchParams.delete('category');
    url.searchParams.delete('style');
    history.replaceState(null, '', url);
  }
  function sourceControls() {
    const chips = document.getElementById('source-chips');
    if (!chips) return;
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.sourceId)) groups.set(item.sourceId, { ...item, count: 0 });
      groups.get(item.sourceId).count++;
    }
    if (source !== 'all' && !groups.has(source)) source = 'all';
    chips.innerHTML = [{ sourceId: 'all', count: items.length }, ...groups.values()].map(item => `<button type="button" data-source="${D.escapeHtml(item.sourceId)}" class="${source === item.sourceId ? 'active' : ''}" aria-pressed="${source === item.sourceId}">${D.escapeHtml(item.sourceId === 'all' ? t('all') : D.sourceName(item, locale))}<b>${item.count}</b></button>`).join('');
  }
  function renderFeed() {
    if (!feed) return;
    const q = query.trim().toLocaleLowerCase(locale);
    const filtered = items.filter(item => (source === 'all' || item.sourceId === source) && (category === 'all' || D.itemCategories(item).includes(category)) && (!q || [item.title, item.titleEn, item.title_en, item.author, item.summary, item.summaryZh, item.summary_zh, item.summaryEn, item.summary_en, D.summary(item, locale).text, item.github?.name, ...(item.tags || []), ...(item.github?.topics || [])].filter(Boolean).join(' ').toLocaleLowerCase(locale).includes(q)));
    const ids = savedIds();
    if (sort === 'popular') filtered.sort((a, b) => Number(D.metric(b, ['stars', 'stargazers_count', 'totalStars', 'votes', 'votesCount']) || 0) - Number(D.metric(a, ['stars', 'stargazers_count', 'totalStars', 'votes', 'votesCount']) || 0));
    feed.innerHTML = filtered.map((item, index) => D.renderItem(item, locale, { date: page.date, index, saved: ids.has(D.favoriteId(item)) })).join('');
    feed.hidden = !filtered.length;
    document.getElementById('empty').hidden = Boolean(filtered.length);
    const favoritesEmpty = page.view === 'favorites' && !items.length;
    document.getElementById('empty-title').textContent = t(favoritesEmpty ? 'emptyFavorites' : 'empty');
    document.getElementById('empty-hint').textContent = t(favoritesEmpty ? 'favoritesHint' : 'emptyHint');
    document.getElementById('clear-filters').hidden = !query && source === 'all' && category === 'all';
    document.getElementById('report-stat').textContent = t('count', { n: filtered.length }) + (page.date ? ` · ${D.dateLabel(page.date, locale)}` : '');
  }
  function loadFavorites() {
    items = readFavorites().map(entry => {
      const item = { ...entry.item };
      const repo = D.repository(item);
      // Old snapshots remain readable; only catalog-confirmed paths become detail links.
      delete item.projectPath;
      if (repo && projectPaths?.[repo.key]) item.projectPath = projectPaths[repo.key];
      return item;
    });
    sourceControls(); renderFeed();
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
  document.getElementById('date-select')?.addEventListener('change', event => {
    const url = new URL(D.localPath(`/reports/${event.target.value}/`, locale), location.origin);
    if (query) url.searchParams.set('q', query);
    if (source !== 'all') url.searchParams.set('source', source);
    location.assign(url.pathname + url.search);
  });
  search?.addEventListener('input', () => { query = search.value; updateFilterUrl(); renderFeed(); });
  document.getElementById('sort-select')?.addEventListener('change', event => { sort = event.target.value; renderFeed(); });
  document.getElementById('view-toggle')?.addEventListener('click', event => {
    const cards = feed.classList.toggle('card-view');
    event.currentTarget.setAttribute('aria-pressed', String(cards));
  });
  document.addEventListener('keydown', event => {
    if (search && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); search.focus(); }
  });
  document.getElementById('source-chips')?.addEventListener('click', event => {
    const button = event.target.closest('button[data-source]'); if (!button) return;
    source = button.dataset.source; sourceControls(); updateFilterUrl(); renderFeed();
    document.querySelector('#source-chips button.active')?.focus();
  });
  document.getElementById('category-chips')?.addEventListener('click', event => {
    const button = event.target.closest('button[data-category]'); if (!button) return;
    category = button.dataset.category;
    document.querySelectorAll('[data-category]').forEach(node => { const active = node.dataset.category === category; node.classList.toggle('active', active); node.setAttribute('aria-pressed', String(active)); });
    updateFilterUrl(); renderFeed(); button.focus();
  });
  document.getElementById('clear-filters')?.addEventListener('click', () => {
    source = 'all'; category = 'all'; query = ''; search.value = ''; sourceControls(); document.querySelectorAll('[data-category]').forEach(node => { const active = node.dataset.category === 'all'; node.classList.toggle('active', active); node.setAttribute('aria-pressed', String(active)); }); updateFilterUrl(); renderFeed(); search.focus();
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-favorite-id]');
    if (button) {
      const id = button.dataset.favoriteId;
      const item = items.find(item => D.favoriteId(item) === id) || (page.projectItem && D.favoriteId(page.projectItem) === id ? page.projectItem : null);
      if (!item) return;
      const favorites = readFavorites(); const found = favorites.findIndex(entry => entry.id === id);
      if (found >= 0) favorites.splice(found, 1);
      else favorites.unshift({ id, savedAt: new Date().toISOString(), item: { ...item, content: '', reportDate: page.date || item.reportDate } });
      try { localStorage.setItem(D.favoritesKey, JSON.stringify(favorites)); }
      catch { announce(t('storageError')); return; }
      announce(t(found >= 0 ? 'remove' : 'saved'));
      if (page.view === 'favorites') loadFavorites(); else synchronizeButtons();
    }
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
  window.addEventListener('storage', event => {
    if (event.key === D.favoritesKey || event.key === null) { if (page.view === 'favorites') loadFavorites(); else synchronizeButtons(); }
    if (event.key === 'devtrends-theme-v1' || event.key === null) { window.DevTrendsTheme.set(event.newValue); syncThemePicker(); }
  });
  if (search) search.value = query;
  if (page.view === 'favorites') {
    loadFavorites();
    fetch('/data/projects.json').then(response => { if (!response.ok) throw new Error('catalog'); return response.json(); }).then(paths => { projectPaths = paths; loadFavorites(); }).catch(() => {});
  } else if (feed) { sourceControls(); renderFeed(); }
  else synchronizeButtons();
  // Preserve legacy date links; legacy style preferences have no effect on the unified theme.
  if (page.route === '/' && /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '')) {
    const select = document.getElementById('date-select');
    if ([...select.options].some(option => option.value === params.get('date'))) {
      const target = new URL(D.localPath(`/reports/${params.get('date')}/`, locale), location.origin);
      if (query) target.searchParams.set('q', query);
      if (source !== 'all') target.searchParams.set('source', source);
      location.replace(target.pathname + target.search);
    }
  }
})();
