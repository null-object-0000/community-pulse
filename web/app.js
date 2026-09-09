const state = {
  index: null,
  report: null,
  source: 'all',
  query: '',
  style: localStorage.getItem('pulse-style') || 'github',
};

const els = {
  date: document.querySelector('#date-select'),
  style: document.querySelector('#style-select'),
  search: document.querySelector('#search'),
  sourceNav: document.querySelector('#source-nav'),
  mobileSources: document.querySelector('#mobile-sources'),
  title: document.querySelector('#report-title'),
  stat: document.querySelector('#report-stat'),
  feed: document.querySelector('#feed'),
  empty: document.querySelector('#empty'),
};

const sourceMarks = {
  vibecafe: 'V',
  'chinese-indie-dev': '中',
  'weekly-issues': '阮',
  'weekly-issue': '周',
  'hellogithub-issues': 'H',
  'hellogithub-issue': '月',
  'github-trending': 'GH',
  'github-trending-cn': 'CN',
  producthunt: 'P',
};

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));

const compact = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return new Intl.NumberFormat('zh-CN', { notation: number >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number);
};

function readMetric(item, names) {
  for (const name of names) {
    const value = item.metrics?.[name] ?? item.github?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function itemLinks(item) {
  const candidates = [
    ['官网', item.websiteUrl || (!item.url?.includes('github.com') ? item.url : '')],
    ['GitHub', item.githubUrl || (item.url?.includes('github.com') ? item.url : '')],
    ['VibeCafé', item.vibecafeUrl],
    ['Product Hunt', item.productHuntUrl || (item.sourceId === 'producthunt' ? item.url : '')],
    ['投稿页', item.issueUrl],
  ];
  const seen = new Set();
  return candidates.filter(([, url]) => url && !seen.has(url) && seen.add(url));
}

function sourceButton(source, compactMode = false) {
  const active = state.source === source.id;
  return `<button class="source-button${active ? ' active' : ''}" data-source="${escapeHtml(source.id)}" aria-pressed="${active}">
    ${compactMode ? '' : `<span class="source-mark">${escapeHtml(source.mark)}</span>`}
    <span>${escapeHtml(source.name)}</span><span class="source-count">${source.count}</span>
  </button>`;
}

function allItems() {
  return (state.report?.results || []).flatMap((source) =>
    (source.items || []).map((item) => ({ ...item, sourceName: source.sourceName })),
  );
}

function renderSources() {
  const sources = (state.report?.results || [])
    .filter((source) => source.items?.length)
    .map((source) => ({
      id: source.sourceId,
      name: source.sourceName,
      count: source.items.length,
      mark: sourceMarks[source.sourceId] || '•',
    }));
  const total = sources.reduce((sum, source) => sum + source.count, 0);
  const options = [{ id: 'all', name: '全部动态', count: total, mark: '◎' }, ...sources];
  els.sourceNav.innerHTML = options.map((source) => sourceButton(source)).join('');
  els.mobileSources.innerHTML = options.map((source) => sourceButton(source, true)).join('');
  document.querySelectorAll('[data-source]').forEach((button) => {
    button.addEventListener('click', () => {
      state.source = button.dataset.source;
      renderSources();
      renderFeed();
    });
  });
}

function renderItem(item, index) {
  const stars = readMetric(item, ['stars', 'stargazers_count', 'totalStars']);
  const forks = readMetric(item, ['forks', 'forks_count']);
  const today = readMetric(item, ['today', 'starsToday', 'todayStars']);
  const votes = readMetric(item, ['votes', 'votesCount']);
  const comments = readMetric(item, ['comments', 'commentsCount']);
  const language = item.github?.language || readMetric(item, ['language', 'lang']);
  const links = itemLinks(item);
  const primary = links[0]?.[1] || item.url || '#';
  const summary = item.summary || item.tagline || item.content || '暂无简介';
  const image = item.image ? `<img class="item-image" src="${escapeHtml(item.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '';
  const metrics = [
    stars !== null ? `<span>★ ${compact(stars)}</span>` : '',
    forks !== null ? `<span>⑂ ${compact(forks)}</span>` : '',
    today !== null ? `<span class="hot">+${compact(today)} 今日</span>` : '',
    votes !== null ? `<span>▲ ${compact(votes)}</span>` : '',
    comments !== null ? `<span>◌ ${compact(comments)}</span>` : '',
    language ? `<span><i class="language-dot"></i>${escapeHtml(language)}</span>` : '',
  ].filter(Boolean).join('');

  return `<article class="feed-item" style="--order:${index}">
    <div class="rank" aria-hidden="true">${String(index + 1).padStart(2, '0')}</div>
    ${image || `<div class="item-fallback" aria-hidden="true">${escapeHtml(sourceMarks[item.sourceId] || '•')}</div>`}
    <div class="item-main">
      <div class="item-kicker"><span>${escapeHtml(item.sourceName)}</span>${item.author ? `<span>by ${escapeHtml(item.author)}</span>` : ''}</div>
      <h2><a href="${escapeHtml(primary)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h2>
      <p class="summary">${escapeHtml(summary)}</p>
      <div class="item-foot">
        <div class="metrics">${metrics}</div>
        <div class="links">${links.map(([label, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`).join('')}</div>
      </div>
    </div>
    <a class="hunt-vote" href="${escapeHtml(primary)}" target="_blank" rel="noopener noreferrer" aria-label="打开 ${escapeHtml(item.title)}"><span>▲</span><b>${compact(votes ?? stars) || index + 1}</b></a>
  </article>`;
}

function renderFeed() {
  const normalizedQuery = state.query.trim().toLocaleLowerCase('zh-CN');
  const items = allItems().filter((item) => {
    if (state.source !== 'all' && item.sourceId !== state.source) return false;
    if (!normalizedQuery) return true;
    return [item.title, item.summary, item.content, item.author, ...(item.tags || [])]
      .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(normalizedQuery);
  });

  els.feed.innerHTML = items.map(renderItem).join('');
  els.feed.hidden = items.length === 0;
  els.empty.hidden = items.length !== 0;
  const total = allItems().length;
  els.stat.textContent = state.query || state.source !== 'all' ? `${items.length} / ${total} 条` : `${total} 条动态`;
}

async function loadReport(date, updateUrl = true) {
  els.feed.innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
  els.empty.hidden = true;
  const response = await fetch(`/data/reports/${date}.json`);
  if (!response.ok) throw new Error(`无法读取 ${date} 日报`);
  state.report = await response.json();
  state.source = 'all';
  els.title.textContent = `大家都在做什么 · ${date}`;
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set('date', date);
    history.replaceState({}, '', url);
  }
  renderSources();
  renderFeed();
}

async function init() {
  try {
    state.index = await fetch('/data/index.json').then((response) => response.json());
    els.date.innerHTML = state.index.dates.map((date) => `<option value="${date}">${date}</option>`).join('');
    const requested = new URL(location.href).searchParams.get('date');
    const initialDate = state.index.dates.includes(requested) ? requested : state.index.latest;
    els.date.value = initialDate;
    els.style.value = state.style;
    await loadReport(initialDate, false);
  } catch (error) {
    els.feed.innerHTML = `<div class="error"><h2>日报暂时没有加载出来</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

els.date.addEventListener('change', () => loadReport(els.date.value));
els.style.addEventListener('change', () => {
  state.style = els.style.value;
  document.documentElement.dataset.style = state.style;
  localStorage.setItem('pulse-style', state.style);
});
els.search.addEventListener('input', () => {
  state.query = els.search.value;
  renderFeed();
});

init();
