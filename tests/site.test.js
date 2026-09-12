const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../web/shared.js');
const { buildProjects, projectPage } = require('../scripts/projects.js');
const { applyEnhancedMarkdown } = require('../scripts/enhanced-report.js');
const { metadataComment, renderLocalizedMarkdown, extractItems, validateLocalization } = require('../.agents/skills/community-pulse/scripts/enhance.js');
const report = (date, sources) => ({ date, results: sources.map(([sourceId, items]) => ({ sourceId, sourceName: sourceId, items })) });

test('repository identities normalize case, trailing slash, query, and .git without colliding owner/repo pairs', () => {
  for (const url of ['https://github.com/Owner/Repo', 'http://www.github.com/OWNER/repo.git/?tab=readme#about']) assert.equal(D.repository({ githubUrl: url }).key, 'owner/repo');
  assert.notEqual(D.repository({ url: 'https://github.com/a-b/c' }).path, D.repository({ url: 'https://github.com/a/b-c' }).path);
  for (const url of ['https://github.com/owner', 'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/blob/main/README.md', 'https://github.com/topics/python', 'https://github.com/orgs/openai', 'https://github.com.evil.test/a/b', 'javascript:alert(1)', 'https://evil.test/a/b', 'https://github.com/a/%2e%2e']) assert.equal(D.repository({ githubUrl: url }), null, url);
  assert.equal(D.repository({ githubUrl: 'https://github.com/owner/repo/issues/1', url: 'https://github.com/other/valid' }).key, 'other/valid');
});

test('cross-source and cross-date occurrences become one project with unique discovery days and newest metadata', () => {
  const old = report('2026-01-01', [['old', [{ title: 'old', githubUrl: 'https://github.com/Owner/Repo.git', github: { stars: 9 }, summary: '旧摘要' }]]]);
  const recent = report('2026-09-09', [['one', [{ title: 'new', githubUrl: 'https://github.com/owner/repo', github: { stars: 20, snapshotDate: '2026-09-09' }, summary: '新摘要' }]], ['two', [{ title: 'same', githubUrl: 'https://github.com/OWNER/REPO/' }]], ['product', [{ title: 'website', url: 'https://example.org' }]]]);
  const projects = buildProjects([old, recent]);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].firstSeen, '2026-01-01'); assert.equal(projects[0].lastSeen, '2026-09-09');
  assert.equal(projects[0].observations.length, 2); assert.equal(projects[0].observations[0].sources.length, 2);
  assert.equal(projects[0].item.github.stars, 20);
  assert.equal(recent.results[2].items[0].projectPath, undefined);
  assert.equal(D.itemId(old.results[0].items[0]), D.itemId(recent.results[0].items[0]));
});

test('final summaries override raw and preserve metrics', () => {
  const raw = report('2026-09-09', [['Feed', [{ title: 'Repo', author: 'Author', summary: 'raw', metrics: { stars: 12 } }]]]);
  const enhanced = applyEnhancedMarkdown(raw, '## Feed（1 条）\n### Repo 👤 Author\n> 最终摘要', '2026-09-09');
  assert.equal(enhanced.presentation.summarySource, 'llm-final');
  assert.equal(enhanced.results[0].items[0].summary, '最终摘要');
  assert.equal(enhanced.results[0].items[0].metrics.stars, 12);
  assert.equal(raw.results[0].items[0].summary, 'raw');
});

test('bilingual enhancement carries English titles and summaries through hidden final metadata', () => {
  const rawMarkdown = '## Feed（1 条）\n\n### 中文工具\n> 一个帮助开发者整理数据的工具。\n';
  const items = extractItems(rawMarkdown);
  const localized = { schemaVersion: 2, titleEn: 'Developer Data Organizer', summaryZh: '一个帮助开发者整理数据的工具。', summaryEn: 'A tool that helps developers organize data.', primaryCategory: 'developer-tools' };
  const finalMarkdown = renderLocalizedMarkdown(rawMarkdown, items, new Map([[items[0].idx, localized]]));
  assert.ok(finalMarkdown.includes(metadataComment(localized)));
  const enhanced = applyEnhancedMarkdown(report('2026-09-09', [['Feed', [{ title: '中文工具', summary: 'raw' }]]]), finalMarkdown, '2026-09-09');
  const item = enhanced.results[0].items[0];
  assert.equal(item.summaryZh, localized.summaryZh);
  assert.equal(item.summaryEn, localized.summaryEn);
  assert.equal(item.primaryCategory, 'developer-tools');
  assert.equal(D.displayTitle(item, 'en'), localized.titleEn);
  assert.equal(D.displayTitle(item, 'zh-CN'), '中文工具');
  assert.equal(D.summary(item, 'en').original, false);
});

test('preset categories provide one stable primary category and reject unknown LLM output', () => {
  assert.deepEqual(D.categories.map(category => category.id), ['ai', 'developer-tools', 'data-infrastructure', 'design-media', 'productivity-collaboration', 'business-growth', 'learning-research', 'lifestyle-entertainment', 'other']);
  assert.equal(D.itemCategory({ primaryCategory: 'developer-tools', title: 'AI framework' }), 'developer-tools');
  assert.deepEqual(D.itemCategories({ title: 'A terminal and code editor for developers' }), ['developer-tools']);
  assert.equal(D.itemCategory({ title: 'A quiet music player' }), 'design-media');
  const item = { title: 'Data Tool', heading: 'Data Tool', desc: 'A database monitoring tool.', section: 'Feed' };
  assert.equal(validateLocalization({ summaryZh: '数据库监控工具。', summaryEn: item.desc, primaryCategory: 'data-infrastructure' }, item).primaryCategory, 'data-infrastructure');
  assert.throws(() => validateLocalization({ summaryZh: '数据库监控工具。', summaryEn: item.desc, primaryCategory: 'random' }, item), /primaryCategory/);
});

test('list rows carry no per-item date, because the selected report date already scopes the list', () => {
  // weekly-issues items are stamped 2026-09-09T17:22Z (2026-09-10 in Beijing) and used to render as 9月9日
  // inside the 2026-09-10 report, so the row must not restate a source timestamp at all.
  const html = D.renderItem({ title: 'Kiri', sourceId: 'weekly-issues', publishedAt: '2026-09-09T17:22:05Z' }, 'zh-CN', { date: '2026-09-10' });
  assert.ok(!html.includes('item-date'), 'per-item date element');
  assert.ok(!html.includes('<time'), 'per-item time element');
  assert.ok(!/9月9日|Sep 9/.test(html), html);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.ok(!styles.includes('.item-date'), 'stale date column rules');
  // The list grid must keep one column per rendered cell: number, avatar, primary, tags, source, score.
  assert.ok(styles.match(/\.feed-item \{ grid-template-columns: 30px 48px minmax\(280px, 2\.2fr\) minmax\(130px, \.7fr\) \d+px 64px;/), 'a stray column means a cell lost its track');
});

test('source scaffolding tags never repeat the row source as a chip', () => {
  const chipTags = item => [...D.renderItem(item, 'zh-CN').matchAll(/<span class="tag">([^<]*)<\/span>/g)].map(match => match[1]);
  // Every collector prefixes its items with the source itself plus bookkeeping; the row's source
  // column already covers that, so Product Hunt rows end up with no chips at all.
  assert.deepEqual(chipTags({ title: 'Desert Ant Labs', sourceId: 'producthunt', tags: ['producthunt', 'new', 'official-featured'] }), []);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'vibecafe', tags: ['vibecafe', 'product'] }), []);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'weekly-issue', tags: ['ruanyf-weekly', 'official', '工具'] }), ['工具']);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'hellogithub-issue', tags: ['hellogithub', 'official', 'Go'] }), ['Go']);
  // The chinese-independent-developer boards prefix the line's status emoji as a tag; a status is not
  // a topic, so the whole `indie-dev` + status prefix leaves the row chip-less.
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'chinese-indie-dev', tags: ['indie-dev', '已上线'] }), []);
  const indie = (status) => chipTags({ title: 'x', sourceId: 'chinese-indie-dev', tags: ['indie-dev', status] });
  assert.deepEqual(indie('已上线'), []);
  assert.deepEqual(indie('开发中'), []);
  assert.deepEqual(indie('已关闭'), []);
  // The board tag that separates 程序员版 / 游戏版 from the main board is still a chip.
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'chinese-indie-dev-game', tags: ['indie-dev', '已上线', '游戏版'] }), ['游戏版']);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'github-trending', tags: ['github-trending', 'daily', 'Rust'] }), ['Rust']);
  // A tag that merely repeats the source id is dropped too, and content tags are untouched.
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'mystery-source', tags: ['mystery-source', 'python', 'mcp'] }), ['python', 'mcp']);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'weekly-issues', tags: ['submission'], github: { topics: ['cli'] } }), ['cli']);
});

test('the primary language renders once, never twice as a language chip and a tag', () => {
  const chipTags = item => [...D.renderItem(item, 'zh-CN').matchAll(/<span class="tag">([^<]*)<\/span>/g)].map(match => match[1]);
  // The github-trending collector repeats the language inside `tags`, beside the language chip.
  const trending = { title: 'OpenMAIC', sourceId: 'github-trending', tags: ['github-trending', 'daily', 'TypeScript'], github: { language: 'TypeScript', topics: [] } };
  assert.deepEqual(chipTags(trending), ['TypeScript']);
  assert.deepEqual(chipTags({ title: 'OpenMAIC', sourceId: 'github-trending', tags: ['github-trending', 'daily', 'Go'], github: { language: 'Go', topics: ['cli', 'go'] } }), ['Go', 'cli']);
  // Casing variants of one tag collapse, including the language written differently in a topic.
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'github-trending', github: { language: 'Python', topics: ['Python', 'python'] } }), ['Python']);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'mystery-source', tags: ['TypeScript'], github: { language: 'typescript' } }), ['typescript']);
  // A source-less item keeps its language chip and still shows unrelated tags.
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'weekly-issue', tags: ['Rust'], github: { language: 'Rust', topics: ['cli'] } }), ['Rust', 'cli']);
});

test('a clipped description earns a tooltip while a fully visible one stays bare', () => {
  // The list clips one line horizontally.
  assert.equal(D.isClipped({ scrollWidth: 420, clientWidth: 300, scrollHeight: 20, clientHeight: 20 }), true);
  assert.equal(D.isClipped({ scrollWidth: 300, clientWidth: 300, scrollHeight: 64, clientHeight: 42 }), true);
  assert.equal(D.isClipped({ scrollWidth: 300, clientWidth: 300, scrollHeight: 42, clientHeight: 42 }), false);
  // The markup ships no title: app.js decides on hover, so an unclipped row never shows a duplicate.
  const html = D.renderItem({ title: 'Kiri', summary: '一段很长的产品介绍' }, 'zh-CN');
  assert.ok(!/<p class="summary"[^>]*\stitle=/.test(html), html);
});

test('the two-row tag cap fits exactly two rows, so the second row is never clipped', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  const tags = styles.match(/\.item-tags \{[^}]*\}/)[0];
  const tag = styles.match(/\.item-tags \.tag \{[^}]*\}/)[0];
  const font = Number(tag.match(/font-size:\s*([\d.]+)rem/)[1]);
  const lineHeight = Number(tag.match(/line-height:\s*([\d.]+)/)[1]);
  const padding = Number(tag.match(/padding:\s*(\d+)px/)[1]);
  const gap = Number(tags.match(/gap:\s*(\d+)px/)[1]);
  const declared = tags.match(/--tag-height:\s*calc\(([\d.]+)rem \* ([\d.]+) \+ (\d+)px\)/);
  assert.ok(declared, '--tag-height must stay in the tag metric terms');
  const tagHeight = Number(declared[1]) * 16 * Number(declared[2]) + Number(declared[3]);
  assert.equal(tagHeight, font * 16 * lineHeight + padding * 2, '--tag-height must equal one rendered tag');
  const cap = tags.match(/max-height:\s*calc\(var\(--tag-height\) \* (\d+) \+ (\d+)px\)/);
  assert.ok(cap, 'max-height must derive from --tag-height');
  assert.equal(Number(cap[1]), 2, 'at most two tag rows');
  assert.equal(Number(cap[2]), gap, 'max-height must include the row gap');
});

test('a long source name stays beside its badge instead of wrapping under it', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.match(styles, /\.item-source \{[^}]*flex-wrap: nowrap[^}]*\}/);
  assert.match(styles, /\.item-source a, \.item-source > span:last-child \{[^}]*text-overflow: ellipsis/);
  // The truncated name keeps its full text reachable through title, e.g. 科技爱好者周刊投稿 (108px at .75rem).
  const html = D.renderItem({ title: 'Kiri', sourceId: 'weekly-issues' }, 'zh-CN');
  assert.ok(html.includes('title="科技爱好者周刊投稿"'), html);
  // English is ~6.4px/char at .75rem, so only a short label stays readable inside the same column.
  const english = D.sourceName({ sourceId: 'weekly-issues' }, 'en');
  assert.ok(english.length <= 20, `English source label is too long for the row: ${english}`);
  const sourceColumn = styles.match(/\.feed-item \{ grid-template-columns: 30px 48px minmax\(280px, 2\.2fr\) minmax\(130px, \.7fr\) (\d+)px 64px;/);
  assert.ok(sourceColumn, 'list grid template changed shape');
  assert.ok(Number(sourceColumn[1]) >= 144, `source column must fit badge 28 + gap 8 + label 108, got ${sourceColumn[1]}`);
});

test('known data sources expose safe destination links and real website logos', () => {
  const dist = path.join(__dirname, '../dist');
  for (const sourceId of ['vibecafe', 'chinese-indie-dev', 'chinese-indie-dev-programmer', 'chinese-indie-dev-game', 'weekly-issues', 'weekly-issue', 'hellogithub-issues', 'hellogithub-issue', 'github-trending', 'github-trending-cn', 'producthunt']) {
    const source = D.sourceInfo({ sourceId });
    assert.ok(source, sourceId);
    assert.ok(D.safeUrl(source.url), `${sourceId} URL`);
    assert.match(source.logo, /^\/source-[a-z]+\.(svg|png)$/, `${sourceId} logo`);
    // A logo missing from web/ or from the build output ships as a broken image.
    for (const dir of [path.join(__dirname, '..', 'web'), dist]) assert.ok(fs.existsSync(path.join(dir, source.logo.slice(1))), `${sourceId} logo in ${path.basename(dir)}`);
  }
  assert.equal(D.sourceInfo({ sourceId: 'unknown-source' }), null);
});

test('official publications use their own name and website, while submission channels stay on GitHub Issues', () => {
  const weekly = D.sourceInfo({ sourceId: 'weekly-issue' });
  assert.equal(weekly.url, 'https://www.ruanyifeng.com/blog/index.html');
  assert.equal(weekly.logo, '/source-ruanyifeng.png');
  assert.equal(D.sourceName({ sourceId: 'weekly-issue' }, 'zh-CN'), '科技爱好者周刊');
  assert.equal(D.sourceName({ sourceId: 'weekly-issue' }, 'en'), 'Tech Enthusiast Weekly');
  const monthly = D.sourceInfo({ sourceId: 'hellogithub-issue' });
  assert.equal(monthly.url, 'https://hellogithub.com/');
  assert.equal(monthly.logo, '/source-hellogithub.svg');
  assert.equal(D.sourceName({ sourceId: 'hellogithub-issue' }, 'zh-CN'), 'HelloGitHub 月刊');
  // Submissions are collected from GitHub Issues, so their link stays on GitHub — but the badge
  // is the publication's own mark, not GitHub's, because the row is branded 科技爱好者周刊投稿.
  assert.equal(D.sourceInfo({ sourceId: 'weekly-issues' }).url, 'https://github.com/ruanyf/weekly/issues');
  assert.equal(D.sourceInfo({ sourceId: 'weekly-issues' }).logo, '/source-ruanyifeng.png');
  assert.equal(D.sourceName({ sourceId: 'weekly-issues' }, 'zh-CN'), '科技爱好者周刊投稿');
  assert.equal(D.sourceInfo({ sourceId: 'hellogithub-issues' }).url, 'https://github.com/521xueweihan/HelloGitHub/issues');
});

test('the VibeCafé source logo is the official mark, pinned dark for the fixed light badge', () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'web', 'source-vibecafe.svg'), 'utf8');
  // Exact geometry of https://vibecafe.ai/favicon.svg. Hashed so a hand-drawn stand-in cannot come back.
  assert.equal(crypto.createHash('sha256').update(svg.match(/<path d="([^"]+)"\/>/)?.[1] || '').digest('hex'), '82f5972e8e35c154fbdec38c86efcc7cd2b55d59055a1fccac5c3f345234bf96');
  assert.deepEqual([...svg.matchAll(/<rect\b[^>]*\/>/g)].map(match => match[0]), [
    '<rect x="60" y="540" width="480" height="60"/>', '<rect x="60" width="420" height="60"/>', '<rect x="540" y="120" width="60" height="480"/>',
    '<rect width="60" height="540"/>', '<rect x="480" y="60" width="60" height="60"/>',
  ]);
  // .source-badge is white in every theme, so the official dark-mode rule would render the mark invisible.
  assert.ok(!svg.includes('prefers-color-scheme'));
  assert.match(svg, /<g fill="#000">/);
  assert.match(svg, /role="img" aria-label="VibeCafé"/);
});

test('the HelloGitHub source logo is the official mark, pinned dark for the fixed light badge', () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'web', 'source-hellogithub.svg'), 'utf8');
  // Exact geometry of https://hellogithub.com/favicon/favicon.svg.
  assert.equal(crypto.createHash('sha256').update(svg.match(/<path[^>]*d="([^"]+)"\/>/)?.[1] || '').digest('hex'), '2903455c15041beb3d82e78d579d74b0bd8ac4b6912eda6fe00f2fa9290d2df6');
  assert.match(svg, /viewBox="0 0 1024 1024"/);
  assert.match(svg, /<g fill="#24292f" stroke="#24292f" stroke-width="16">/);
  assert.ok(!svg.includes('prefers-color-scheme'));
});

test('the Tech Enthusiast Weekly logo is the official favicon.ico frame, vendored as a 32px PNG', () => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'web', 'source-ruanyifeng.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(png.readUInt32BE(16), 32, 'IHDR width');
  assert.equal(png.readUInt32BE(20), 32, 'IHDR height');
  // Byte-for-byte the 32x32 frame of https://www.ruanyifeng.com/favicon.ico, so a redrawn mark is caught.
  assert.equal(crypto.createHash('sha256').update(png).digest('hex'), '5f9ed89c4b6868a1da65263f874d3ead128a5d884359f99668df8aa625078859');
});

test('list source badges render the real source logo, never an invented letter or a borrowed mark', () => {
  const badgeOf = item => D.renderItem({ title: 'x', ...item }, 'zh-CN').match(/<span class="source-mini[^"]*" aria-hidden="true">(.*?)<\/span>/)?.[1];
  for (const sourceId of ['vibecafe', 'chinese-indie-dev', 'chinese-indie-dev-programmer', 'chinese-indie-dev-game', 'weekly-issues', 'weekly-issue', 'hellogithub-issues', 'hellogithub-issue', 'github-trending', 'github-trending-cn', 'producthunt']) {
    assert.equal(badgeOf({ sourceId }), `<img src="${D.sourceInfo({ sourceId }).logo}" alt="" loading="lazy" />`, sourceId);
  }
  // "HelloGitHub" contains "GitHub"; keying the fallback off the display name made it borrow GitHub's mark.
  assert.match(badgeOf({ sourceId: 'hellogithub-issue' }), /source-hellogithub\.svg/);
  // A source with no asset still gets a neutral initials badge rather than a hole.
  assert.match(badgeOf({ sourceId: 'mystery-source', sourceName: 'Zed' }), /^[A-Z]{1,2}$/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.ok(!/\.source-mini-(producthunt|vibecafe|hackernews|reddit|indiehackers)\b/.test(styles), 'invented per-source colours');
  assert.match(styles, /\.source-mini img \{[^}]*object-fit: contain/);
});

test('every source that actually appears in the data has a logo, so no list row falls back to initials', () => {
  const dir = path.join(__dirname, '..', '知识', '大家都在做什么', 'raw');
  const seen = new Set();
  for (const file of fs.readdirSync(dir).filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))) {
    for (const match of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/"sourceId"\s*:\s*"([a-z0-9-]+)"/gi)) seen.add(match[1].toLowerCase());
  }
  // Guard the scan itself: an empty or truncated read would make the loop below vacuously pass.
  assert.ok(seen.size >= 9, `expected at least the nine known sources, found ${seen.size}`);
  for (const sourceId of seen) {
    const logo = D.sourceInfo({ sourceId })?.logo;
    assert.ok(logo, `${sourceId} appears in the reports but has no logo asset`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'web', logo.slice(1))), `${sourceId} logo file is missing from web/`);
    assert.match(D.renderItem({ sourceId, title: 'x' }, 'zh-CN'), new RegExp(`<img src="${logo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), sourceId);
  }
});

test('filter chips carry counts, disable empty filters, and always offer a mobile select', () => {
  const options = [
    { id: 'all', label: '全部', count: 12, active: true },
    { id: 'ai', label: 'AI 与智能体', count: 9, active: false },
    { id: 'other', label: '其他', count: 0, active: false },
  ];
  const html = D.chipFilterHtml(options, 'zh-CN');
  assert.ok(html.includes('class="chip-row"'));
  assert.ok(html.includes('data-more-label="更多分类"'));
  assert.ok(html.includes('id="category-chips-menu"'));
  assert.ok(html.includes('id="category-select"'));
  assert.ok(/data-category="all"[^>]*aria-pressed="true"/.test(html));
  assert.ok(/data-category="other"[^>]*disabled/.test(html));
  assert.ok(html.includes('<option value="other" disabled>其他 (0)</option>'));
  assert.ok(html.includes('<option value="all" selected>全部 (12)</option>'));
  // An empty filter stays selectable when it is the active one, otherwise the state is unreachable.
  assert.ok(!/data-category="other"[^>]*disabled/.test(D.chipFilterHtml([{ ...options[2], active: true }], 'zh-CN')));
  const en = D.chipFilterMeta('en');
  assert.equal(en.containerId, 'category-chips');
  assert.equal(en.selectId, 'category-select');
  assert.equal(en.all, 'All');
  assert.ok(D.chipFilterHtml([{ id: 'all', label: 'All', count: 3, active: true }], 'en').includes('More categories'));
});

test('built pages ship one collapsed chip row with no horizontal scroller', () => {
  const dist = path.join(__dirname, '../dist');
  for (const file of ['index.html', 'en/index.html', 'reports/2026-09-10/index.html', 'en/reports/2026-09-10/index.html']) {
    const html = fs.readFileSync(path.join(dist, file), 'utf8');
    assert.equal((html.match(/class="chip-filter"/g) || []).length, 1, file);
    assert.ok(html.includes('class="chip-more"'), file);
    assert.ok(html.includes('class="chip-select"'), file);
    assert.ok(html.includes('<noscript><style>.chip-row { flex-wrap: wrap; overflow: visible; }</style></noscript>'), file);
    assert.ok(!html.includes('id="view-toggle"'), file);
    assert.ok(!html.includes('class="view-switch"'), file);
    assert.ok(!html.includes('data-view="card"'), file);
    assert.ok(!html.includes('data-view="list"'), file);
  }
  const home = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.equal((home.match(/data-category="/g) || []).length, D.categories.length + 1);
  // The report pages filter by the same preset categories; the source directory is not a filter.
  const report = fs.readFileSync(path.join(dist, 'reports/2026-09-10/index.html'), 'utf8');
  assert.equal((report.match(/data-category="/g) || []).length, D.categories.length + 1);
  for (const html of [home, report]) {
    assert.ok(!html.includes('data-source="'), 'source filter chips');
    assert.ok(!html.includes('id="source-chips"'), 'source filter container');
    assert.ok(!html.includes('id="source-select"'), 'source filter select');
  }
  const styles = fs.readFileSync(path.join(dist, 'styles.css'), 'utf8');
  assert.ok(/\.chip-row \{[^}]*flex-wrap: nowrap[^}]*overflow: hidden/.test(styles));
  assert.ok(!styles.includes('.source-chips'));
});

test('report pages carry the date in the heading instead of a separate meta row', () => {
  const dist = path.join(__dirname, '../dist');
  const zh = fs.readFileSync(path.join(dist, 'reports/2026-09-10/index.html'), 'utf8');
  const en = fs.readFileSync(path.join(dist, 'en/reports/2026-09-10/index.html'), 'utf8');
  assert.ok(zh.includes('<h1>2026年9月10日大家都在做什么</h1>'), 'zh heading');
  assert.ok(en.includes('<h1>Sep 10, 2026 · What developers are building</h1>'), 'en heading');
  for (const html of [zh, en]) {
    // The feed is scoped to one report date, so no count/date meta row and no date picker.
    assert.ok(!html.includes('id="report-stat"'), 'count and date meta row');
    assert.ok(!html.includes('id="date-select"'), 'date picker');
  }
  // Downloading the Markdown stays reachable through the sidebar digest card.
  assert.ok(zh.includes('/data/markdown/2026-09-10.md'), 'zh markdown download');
  assert.ok(en.includes('/data/markdown/2026-09-10.en.md'), 'en markdown download');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.ok(!/date-control|feed-heading|report-controls/.test(styles), 'stale meta row rules');
});

test('chip row keeps only the leading run that fits and never collapses entirely', () => {
  // budget = 400 - 100 = 300: 70, then +8+110, then +8+100 = 296 fits; the 130 chip does not.
  assert.equal(D.fitChipCount([70, 110, 100, 130], 400, 100, 8), 3);
  assert.equal(D.fitChipCount([70, 110, 100], 400, 0, 8), 3);
  assert.equal(D.fitChipCount([70, 110, 100, 130], 200, 0, 8), 2);
  // A single chip wider than the row still stays visible rather than leaving a bare trigger.
  assert.equal(D.fitChipCount([500], 100, 0, 8), 1);
  assert.equal(D.fitChipCount([70], 20, 40, 8), 1);
  assert.equal(D.fitChipCount([], 400, 0, 8), 0);
});

test('submission issue bodies yield the description instead of the template scaffolding', () => {
  const { descriptionFromIssue } = require('../.agents/skills/community-pulse/scripts/issue-description.js');
  const body = '## 推荐项目\n\n- 项目地址：https://github.com/a/b\n- 类别：Rust\n- 项目标题：好工具\n- 项目描述：一个把命令行输出变好看的终端工具，支持主题。\n- 推荐理由：轻量\n';
  assert.equal(descriptionFromIssue(body), '一个把命令行输出变好看的终端工具，支持主题。');
  assert.equal(descriptionFromIssue('项目名称：langid\n\n项目描述：用于识别输入文本所属的语种。\n\n项目依赖：numpy\n'), '用于识别输入文本所属的语种。');
  assert.equal(descriptionFromIssue('这是一段普通介绍，没有模板字段，应当原样保留。'), '这是一段普通介绍，没有模板字段，应当原样保留。');
  // 正文只有字段名和链接时返回空，交给上层用占位文案，而不是把「项目地址：」当简介
  assert.equal(descriptionFromIssue('项目地址：https://github.com/a/b'), '');
  assert.equal(descriptionFromIssue(''), '');
});

test('summary cleanup removes source template leftovers without damaging normal text', () => {
  assert.ok(!/项目地址|项目标题|项目描述|类别/.test(D.summary({ summary: '项目地址 类别 Rust 项目标题 好工具 项目描述 一个把命令行输出变好看的终端工具。' }, 'zh-CN').text));
  // 正常词语不能被误伤：「语言」「地址」出现在词中时保留
  assert.equal(D.summary({ summary: '一个支持多种语言的编辑器，附带在线地址解析能力。' }, 'zh-CN').text, '一个支持多种语言的编辑器，附带在线地址解析能力。');
  assert.equal(D.summary({ summary: '很棒的翻译工具。 No response' }, 'zh-CN').text, '很棒的翻译工具。');
  assert.equal(D.summary({ summary: '跨平台清理工具 - [项目与下载](https://github.com/a/b)' }, 'zh-CN').text, '跨平台清理工具 - 项目与下载');
  // LLM 增强的摘要同样清理，历史 final 里的模板字段重建后不再重现
  assert.equal(D.summary({ summaryZh: '项目名称：A11yKit 主要受众：出海 Web 开发者 项目描述：一套无障碍检测工具。' }, 'zh-CN').text, 'A11yKit 出海 Web 开发者 一套无障碍检测工具。');
  assert.equal(D.summary({ summary: 'No response' }, 'zh-CN').text, D.t('zh-CN', 'noSummary'));
});

test('secondary text and avatar initials meet WCAG AA contrast in the light theme', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/styles.css'), 'utf8');
  const luminance = hex => {
    const value = parseInt(hex.slice(1), 16), channel = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
  };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (hi + 0.05) / (lo + 0.05); };
  const faint = css.match(/--faint:\s*(#[0-9a-f]{6})/i)[1];
  assert.ok(ratio(faint, '#ffffff') >= 4.5, `--faint ${faint} on white is ${ratio(faint, '#ffffff').toFixed(2)}`);
  // 无配图时显示白色首字母，必须对渐变最亮的一端也达标
  for (const name of ['avatar-1', 'avatar-3', 'avatar-4']) {
    const rule = css.match(new RegExp(`\\.${name}\\s*\\{[^}]*\\}`))[0];
    for (const stop of rule.match(/#[0-9a-f]{6}/gi)) assert.ok(ratio('#ffffff', stop) >= 4.5, `${name} ${stop} is ${ratio('#ffffff', stop).toFixed(2)}`);
  }
  const avatar2 = css.match(/\.avatar-2\s*\{[^}]*\}/)[0];
  assert.ok(ratio(avatar2.match(/color:\s*(#[0-9a-f]{6})/i)[1], '#e9eef7') >= 4.5);
});

test('language selection uses translated summaries and explicitly labels fallback originals', () => {
  assert.equal(D.summary({ summary: '中文介绍', summaryEn: 'English translation' }, 'en').text, 'English translation');
  assert.equal(D.summary({ summary: '中文介绍' }, 'en').original, true);
  assert.equal(D.summary({ summary: '中文介绍', github: { description: 'English description' } }, 'en').original, false);
  assert.equal(D.summary({ summary: 'English description' }, 'zh-CN').original, true);
  assert.equal(D.displayTitle({ title: '中文名称', titleEn: 'English Name' }, 'en'), 'English Name');
  assert.deepEqual(Object.keys(D.messages.en).sort(), Object.keys(D.messages['zh-CN']).sort());
});

test('submission labels are stripped from titles in both languages without eating product names', () => {
  const title = value => D.displayTitle({ title: value }, 'zh-CN');
  // 中文投稿标签（老规则）与同义的英文、别的括号写法都要清掉。
  assert.equal(title('【开源自荐】Zedis：Redis 客户端'), 'Zedis：Redis 客户端');
  assert.equal(title('〖工具自荐〗Deck：macOS 剪贴板管理器'), 'Deck：macOS 剪贴板管理器');
  assert.equal(title('[开源推荐] LoongFlow'), 'LoongFlow');
  assert.equal(title('[Open Source] rustnet'), 'rustnet');
  assert.equal(title('[Tool Self-Promotion] C Dance AI'), 'C Dance AI');
  assert.equal(title('[Tool self-recommendation] OSINT Tools'), 'OSINT Tools');
  assert.equal(title('[Show HN] / [Tool] AI Scraper Pro'), 'AI Scraper Pro');
  assert.equal(title('[开源推荐] [Tool Recommendation] Mini-Tools'), 'Mini-Tools');
  assert.equal(title('Recommend: Novel Writer Suite'), 'Novel Writer Suite');
  assert.equal(title('Submit Tool: Gptimage2'), 'Gptimage2');
  assert.equal(title('推荐项目：astock - A股行情工具'), 'astock - A股行情工具');
  assert.equal(title('【开源工具】Vercut 分词工具'), 'Vercut 分词工具');
  // 拿方括号当书名号的产品名、以及其他前缀词不能当成投稿标签。
  assert.equal(title('【Tokenscope】AI tokens dashboard'), '【Tokenscope】AI tokens dashboard');
  assert.equal(title('[MAC] Claude Notch Usage Companion'), '[MAC] Claude Notch Usage Companion');
  assert.equal(title('【开源自荐】【Wegent】开源的AI工作台'), '【Wegent】开源的AI工作台');
  assert.equal(title('AI-Native PM: Product Validation Toolkit'), 'AI-Native PM: Product Validation Toolkit');
  assert.equal(title('ai-credit：统计 AI 工具对代码库的真实贡献'), 'ai-credit：统计 AI 工具对代码库的真实贡献');
  assert.equal(title('Recommendation Engine — 推荐系统实战'), 'Recommendation Engine — 推荐系统实战');
  assert.equal(title('.resume — 简历工具'), '.resume — 简历工具');
  // 整个标题就是标签时退回原标题，列表里不能出现空标题。
  assert.equal(title('[Open Source]'), '[Open Source]');
  // 英文标题走同一套清理。
  assert.equal(D.displayTitle({ title: '中文名', titleEn: '[Open Source] ENZO — self-hosted AI workspace' }, 'en'), 'ENZO — self-hosted AI workspace');
});

test('untrusted source text and URL protocols cannot inject markup or script', () => {
  const item = { title: '<script>alert(1)</script>', summary: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', sourceName: '<svg onload=x>' };
  const html = D.renderItem(item, 'en');
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img')); assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('&lt;script&gt;'));
  const project = buildProjects([report('2026-09-09', [['feed', [{ ...item, githubUrl: 'https://github.com/test/repo', summary: '</script><script>alert(1)</script>' }]]])])[0];
  const rendered = projectPage(project, 'en');
  assert.ok(!rendered.includes('</script><script>alert(1)</script>'));
  const data = JSON.parse(rendered.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.projectItem.summary, project.item.summary);
});

test('saved theme applies before rendering, reacts to system changes, and tolerates blocked storage', () => {
  function environment(saved, blocked = false) {
    let change; const attrs = {};
    const document = { documentElement: { dataset: {}, style: {} }, querySelector: () => ({ setAttribute: (k, v) => { attrs[k] = v; } }) };
    const media = { matches: true, addEventListener: (_, callback) => { change = callback; } };
    const context = { document, localStorage: { getItem() { if (blocked) throw Error('blocked'); return saved; }, setItem() { if (blocked) throw Error('blocked'); } }, window: { matchMedia: () => media } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/theme.js'), 'utf8'), context);
    return { document, media, change: () => change(), theme: context.window.DevTrendsTheme, attrs };
  }
  const env = environment('light'); assert.equal(env.document.documentElement.dataset.theme, 'light');
  env.theme.set('system'); assert.equal(env.document.documentElement.dataset.theme, 'dark');
  env.media.matches = false; env.change(); assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(environment(null, true).document.documentElement.dataset.theme, 'dark');
});

test('every emitted project, report, and sitemap entry has a real static page and canonical language URLs', () => {
  const dist = path.join(__dirname, '../dist');
  const index = JSON.parse(fs.readFileSync(path.join(dist, 'data/index.json')));
  const projects = JSON.parse(fs.readFileSync(path.join(dist, 'data/projects.json')));
  assert.equal(Object.keys(projects).length, index.projectCount); assert.ok(index.projectCount > 0);
  const sitemap = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, urls.length);
  // Favorites were removed: no page, navigation link, or stored-state copy may survive the build.
  assert.ok(!fs.existsSync(path.join(dist, 'favorites')), 'favorites page must not be built');
  assert.ok(!fs.existsSync(path.join(dist, 'en', 'favorites')), 'English favorites page must not be built');
  assert.ok(!fs.readFileSync(path.join(dist, 'index.html'), 'utf8').includes('/favorites/'), 'navigation must not link favorites');
  for (const url of urls) {
    assert.ok(url.startsWith(D.origin + '/'));
    const route = url.slice(D.origin.length);
    const html = fs.readFileSync(path.join(dist, route, 'index.html'), 'utf8');
    assert.ok(html.includes(`<link rel="canonical" href="${url}"`), url);
    assert.ok(html.includes(`<html lang="${route.startsWith('/en/') ? 'en' : 'zh-CN'}">`), url);
    assert.ok(!html.includes('style-select'), url);
    const data = JSON.parse(html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.ok(data.locale);
    if (route.includes('/projects/')) {
      assert.ok(html.includes('SoftwareSourceCode')); assert.ok(html.includes('BreadcrumbList'));
      const repo = D.repository(data.projectItem); assert.ok(repo, url);
      assert.equal(repo.path, route.replace(/^\/en(?=\/)/, ''));
    }
  }
  for (const date of index.dates) {
    const data = JSON.parse(fs.readFileSync(path.join(dist, `data/reports/${date}.json`)));
    for (const item of D.reportItems(data)) {
      assert.ok(D.isCategoryId(D.itemCategory(item)), `${date}: ${item.title}`);
      assert.equal(D.itemCategories(item).length, 1, `${date}: ${item.title}`);
      if (D.repository(item)) assert.equal(item.projectPath, projects[D.repository(item).key]);
      else assert.equal(item.projectPath, undefined);
    }
    if (fs.existsSync(path.join(__dirname, `../知识/大家都在做什么/final/${date}.md`))) {
      assert.ok(['llm-final', 'mixed'].includes(data.presentation.summarySource), date);
      assert.equal(data.presentation.enhancedItemCount, D.reportItems(data).filter(item => item.summarySource === 'llm-final').length);
      if (date === index.latest) assert.equal(data.presentation.summarySource, 'llm-final');
    }
  }
});
