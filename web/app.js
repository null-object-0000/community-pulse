const state = {
  index: null, report: null, markdown: '', source: 'all', query: '',
  style: document.documentElement.dataset.style || 'github',
};

const ids = [
  'date-select', 'style-select', 'mobile-date-select', 'mobile-style-select',
  'search', 'toolbar-search-input', 'toolbar-date', 'toolbar-source-select',
  'github-source-select', 'mobile-source-select', 'section-date', 'report-stat', 'source-chips',
  'feed', 'markdown-view', 'empty', 'community-list', 'history-count',
];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const sourceMarks = {
  vibecafe: 'V', 'chinese-indie-dev': '中', 'weekly-issues': '阮',
  'weekly-issue': '周', 'hellogithub-issues': 'H', 'hellogithub-issue': '月',
  'github-trending': 'GH', 'github-trending-cn': 'CN', producthunt: 'P',
};

const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[char]));

const compact = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return new Intl.NumberFormat('zh-CN', {
    notation: number >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1,
  }).format(number);
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
    ['官网', item.websiteUrl || (!item.url?.includes('github.com') && item.sourceId !== 'producthunt' ? item.url : '')],
    ['GitHub', item.githubUrl || item.github?.url || (item.url?.includes('github.com') ? item.url : '')],
    ['VibeCafé', item.vibecafeUrl],
    ['Product Hunt', item.productHuntUrl || (item.sourceId === 'producthunt' ? item.url : '')],
    ['投稿页', item.issueUrl],
  ];
  const seen = new Set();
  return candidates.filter(([, url]) => url && !seen.has(url) && seen.add(url));
}

function allItems() {
  return (state.report?.results || []).flatMap((source) =>
    (source.items || []).map((item) => ({ ...item, sourceName: source.sourceName })),
  );
}

function sources() {
  return (state.report?.results || []).filter((source) => source.items?.length).map((source) => ({
    id: source.sourceId, name: source.sourceName, count: source.items.length,
    mark: sourceMarks[source.sourceId] || '•',
  }));
}

function filteredItems() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  return allItems().filter((item) => {
    if (state.source !== 'all' && item.sourceId !== state.source) return false;
    if (!query) return true;
    return [item.title, item.summary, item.content, item.author, ...(item.tags || [])]
      .filter(Boolean).join(' ').toLocaleLowerCase('zh-CN').includes(query);
  });
}

function renderSourceControls() {
  const list = sources();
  const total = list.reduce((sum, source) => sum + source.count, 0);
  const options = [{ id: 'all', name: '全部', count: total, mark: '◎' }, ...list];
  const selectOptions = options.map((source) => '<option value="' + escapeHtml(source.id) + '">' + escapeHtml(source.name) + ' (' + source.count + ')</option>').join('');
  ['github-source-select', 'toolbar-source-select', 'mobile-source-select'].forEach((id) => {
    els[id].innerHTML = selectOptions;
    els[id].value = state.source;
    els[id].onchange = () => selectSource(els[id].value);
  });
  els['source-chips'].innerHTML = options.map((source) =>
    '<button data-source="' + escapeHtml(source.id) + '" class="' + (state.source === source.id ? 'active' : '') +
    '" aria-pressed="' + (state.source === source.id) + '"><span>' + escapeHtml(source.name) +
    '</span><b>' + source.count + '</b></button>',
  ).join('');
  document.querySelectorAll('[data-source]').forEach((button) => {
    button.addEventListener('click', () => selectSource(button.dataset.source));
  });
  document.querySelectorAll('[data-vibe-source]').forEach((button) => {
    button.classList.toggle('active', button.dataset.vibeSource === state.source);
    button.onclick = () => selectSource(button.dataset.vibeSource);
  });
}

function selectSource(source) {
  state.source = source;
  renderSourceControls();
  renderFeed();
}

function renderCommunityRail() {
  els['community-list'].innerHTML = sources().slice(0, 6).map((source, index) =>
    '<button data-rail-source="' + escapeHtml(source.id) + '"><span class="rail-mark">' +
    escapeHtml(source.mark) + '</span><span><small>p/' + escapeHtml(source.id) + '</small><b>' +
    escapeHtml(source.name) + '</b><em>' + source.count + ' 条今日动态 · ' + (index + 1) +
    ' 个信号源</em></span></button>',
  ).join('');
  document.querySelectorAll('[data-rail-source]').forEach((button) => {
    button.addEventListener('click', () => selectSource(button.dataset.railSource));
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
  const tags = (item.tags || []).filter((tag) => !['product', 'vibecafe'].includes(tag)).slice(0, 3);
  const visual = item.image
    ? '<img class="item-visual" src="' + escapeHtml(item.image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />'
    : '<div class="item-visual item-fallback" aria-hidden="true">' + escapeHtml(sourceMarks[item.sourceId] || '•') + '</div>';
  const metrics = [
    language ? '<span><i class="language-dot"></i>' + escapeHtml(language) + '</span>' : '',
    stars !== null ? '<span>☆ ' + compact(stars) + '</span>' : '',
    forks !== null ? '<span>⑂ ' + compact(forks) + '</span>' : '',
    votes !== null ? '<span>▲ ' + compact(votes) + '</span>' : '',
    comments !== null ? '<span>◌ ' + compact(comments) + '</span>' : '',
  ].filter(Boolean).join('');
  const source = escapeHtml(item.sourceName) + (item.author ? '<span>by ' + escapeHtml(item.author) + '</span>' : '');
  const linkHtml = links.map(([label, url]) =>
    '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + ' ↗</a>',
  ).join('');
  const tagHtml = tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
  const todayHtml = today !== null ? '<b>☆ ' + compact(today) + ' stars today</b>' : '';
  return '<article class="feed-item">' + visual +
    '<div class="item-content"><div class="item-source">' + source + '</div><h2><span class="repo-icon">▣</span>' +
    '<a href="' + escapeHtml(primary) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(item.title) +
    '</a></h2><p class="summary">' + escapeHtml(summary) + '</p><div class="item-meta"><div class="metrics">' +
    metrics + tagHtml + '</div><div class="links">' + linkHtml + '</div></div></div>' +
    '<div class="github-item-actions"><a href="' + escapeHtml(primary) +
    '" target="_blank" rel="noopener noreferrer">☆&nbsp; Star</a>' + todayHtml + '</div>' +
    '<div class="ph-item-actions"><span>◌<b>' + (compact(comments) || '—') + '</b></span><a href="' +
    escapeHtml(primary) + '" target="_blank" rel="noopener noreferrer">△<b>' + (compact(votes) || '—') +
    '</b></a></div><span class="item-number">' + String(index + 1).padStart(2, '0') + '</span></article>';
}

function inlineMarkdown(value) {
  let output = escapeHtml(value);
  output = output.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  output = output.replace(new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g'), '<code>$1</code>');
  output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/(^|[^\*])\*([^*]+)\*/g, '$1<em>$2</em>');
  return output;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) html.push('</ul>');
    inList = false;
  };
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const list = line.match(/^\s*[-*]\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
    } else if (/^>\s?/.test(line)) {
      closeList();
      html.push('<blockquote>' + inlineMarkdown(line.replace(/^>\s?/, '')) + '</blockquote>');
    } else if (list) {
      if (!inList) html.push('<ul>');
      inList = true;
      html.push('<li>' + inlineMarkdown(list[1]) + '</li>');
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      html.push('<p>' + inlineMarkdown(line) + '</p>');
    }
  }
  closeList();
  return html.join('');
}

function renderFeed() {
  const markdownMode = state.style === 'markdown';
  els.feed.hidden = markdownMode;
  els['markdown-view'].hidden = !markdownMode;
  els.empty.hidden = true;
  if (markdownMode) {
    els['markdown-view'].innerHTML = renderMarkdown(state.markdown);
    els['report-stat'].textContent = 'Markdown';
    return;
  }
  const items = filteredItems();
  els.feed.innerHTML = items.map(renderItem).join('');
  els.feed.hidden = items.length === 0;
  els.empty.hidden = items.length !== 0;
  els['report-stat'].textContent = items.length + ' 条';
}

function applyStyle(style) {
  state.style = style;
  document.documentElement.dataset.style = style;
  localStorage.setItem('pulse-style', style);
  els['style-select'].value = style;
  els['mobile-style-select'].value = style;
  const url = new URL(location.href);
  url.searchParams.set('style', style);
  history.replaceState({}, '', url);
  renderFeed();
}

async function loadReport(date, updateUrl = true) {
  els.feed.innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
  els['markdown-view'].hidden = true;
  const [reportResponse, markdownResponse] = await Promise.all([
    fetch('/data/reports/' + date + '.json'),
    fetch('/data/markdown/' + date + '.md'),
  ]);
  if (!reportResponse.ok) throw new Error('无法读取 ' + date + ' 日报');
  state.report = await reportResponse.json();
  state.markdown = markdownResponse.ok ? await markdownResponse.text() : '# 大家都在做什么 · ' + date + '\n\n当天暂无 Markdown 日报。';
  state.source = 'all';
  els['date-select'].value = date;
  els['mobile-date-select'].value = date;
  els['toolbar-date'].textContent = date;
  els['section-date'].textContent = '日报：' + date;
  if (updateUrl) {
    const url = new URL(location.href);
    url.searchParams.set('date', date);
    history.replaceState({}, '', url);
  }
  renderSourceControls();
  renderCommunityRail();
  renderFeed();
}

function bindInputs() {
  [['date-select', 'mobile-date-select'], ['mobile-date-select', 'date-select']].forEach(([source, mirror]) => {
    els[source].addEventListener('change', () => {
      els[mirror].value = els[source].value;
      loadReport(els[source].value);
    });
  });
  ['style-select', 'mobile-style-select'].forEach((source) => {
    els[source].addEventListener('change', () => applyStyle(els[source].value));
  });
  [['search', 'toolbar-search-input'], ['toolbar-search-input', 'search']].forEach(([source, mirror]) => {
    els[source].addEventListener('input', () => {
      state.query = els[source].value;
      els[mirror].value = state.query;
      renderFeed();
    });
  });
}

async function init() {
  try {
    state.index = await fetch('/data/index.json').then((response) => response.json());
    const options = state.index.dates.map((date) => '<option value="' + date + '">' + date + '</option>').join('');
    els['date-select'].innerHTML = options;
    els['mobile-date-select'].innerHTML = options;
    els['history-count'].textContent = state.index.dates.length + ' day archive ✨';
    els['style-select'].value = state.style;
    els['mobile-style-select'].value = state.style;
    bindInputs();
    const requested = new URL(location.href).searchParams.get('date');
    await loadReport(state.index.dates.includes(requested) ? requested : state.index.latest, false);
  } catch (error) {
    els.feed.innerHTML = '<div class="error"><h2>日报暂时没有加载出来</h2><p>' + escapeHtml(error.message) + '</p></div>';
  }
}

init();
