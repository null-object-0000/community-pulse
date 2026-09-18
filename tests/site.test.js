const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../web/shared.js');
const R = require('../scripts/render-site.js');
const { buildProjects, projectPage } = require('../scripts/projects.js');
const { applyEnhancedMarkdown } = require('../scripts/enhanced-report.js');
const { metadataComment, renderLocalizedMarkdown, extractItems, validateLocalization } = require('../.agents/skills/community-pulse/scripts/enhance.js');
const report = (date, sources) => ({ date, results: sources.map(([sourceId, items]) => ({ sourceId, sourceName: sourceId, items })) });

test('repository identities normalize case, trailing slash, query, and .git without colliding owner/repo pairs', () => {
  for (const url of ['https://github.com/Owner/Repo', 'http://www.github.com/OWNER/repo.git/?tab=readme#about']) assert.equal(D.repository({ githubUrl: url }).key, 'owner/repo');
  assert.notEqual(D.repository({ url: 'https://github.com/a-b/c' }).path, D.repository({ url: 'https://github.com/a/b-c' }).path);
  for (const url of ['https://github.com/owner', 'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/blob/main/README.md', 'https://github.com/topics/python', 'https://github.com/orgs/openai', 'https://github.com.evil.test/a/b', 'javascript:alert(1)', 'https://evil.test/a/b', 'https://github.com/a/%2e%2e']) assert.equal(D.repository({ githubUrl: url }), null, url);
  assert.equal(D.repository({ githubUrl: 'https://github.com/owner/repo/issues/1', url: 'https://github.com/other/valid' }).key, 'other/valid');
  // A URL pasted out of a sentence keeps the sentence's full stop: the page must not end in a dot.
  assert.equal(D.repository({ githubUrl: 'https://github.com/larryteal/mcp-workspace.' }).key, 'larryteal/mcp-workspace');
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

test('final matching ignores incidental whitespace and accepts processed items with no source summary', () => {
  const localized = Buffer.from(JSON.stringify({ titleEn: 'Empty repo', summaryZh: '', summaryEn: '', primaryCategory: 'developer-tools' })).toString('base64');
  const raw = report('2026-09-09', [['Feed', [
    { title: 'Trailing title ', summary: 'raw' },
    { title: 'Empty repo', summary: '' },
  ]]]);
  const finalMarkdown = `## Feed（2 条）\n### Trailing title\n> 已整理摘要\n### Empty repo\n<!-- devtrends-i18n:${localized} -->`;
  const enhanced = applyEnhancedMarkdown(raw, finalMarkdown, '2026-09-09');
  assert.equal(enhanced.presentation.summarySource, 'llm-final');
  assert.equal(enhanced.results[0].items[0].summary, '已整理摘要');
  assert.equal(enhanced.results[0].items[1].summary, '');
  assert.equal(enhanced.results[0].items[1].primaryCategory, 'developer-tools');
});

test('bilingual enhancement carries English titles and summaries through hidden final metadata', () => {
  const rawMarkdown = '## Feed（1 条）\n\n### 中文工具\n> 一个帮助开发者整理数据的工具。\n';
  const items = extractItems(rawMarkdown);
  const localized = { schemaVersion: 3, titleEn: 'Developer Data Organizer', summaryZh: '一个帮助开发者整理数据的工具。', summaryEn: 'A tool that helps developers organize data.', primaryCategory: 'developer-tools', taxonomy: { useCases: ['software-development'], agentRoles: [], productForms: [], platforms: [], integrations: [] } };
  const finalMarkdown = renderLocalizedMarkdown(rawMarkdown, items, new Map([[items[0].idx, localized]]));
  assert.ok(finalMarkdown.includes(metadataComment(localized)));
  const enhanced = applyEnhancedMarkdown(report('2026-09-09', [['Feed', [{ title: '中文工具', summary: 'raw' }]]]), finalMarkdown, '2026-09-09');
  const item = enhanced.results[0].items[0];
  assert.equal(item.summaryZh, localized.summaryZh);
  assert.equal(item.summaryEn, localized.summaryEn);
  assert.equal(item.primaryCategory, 'developer-tools');
  assert.deepEqual(item.taxonomy.useCases, ['software-development']);
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
  const taxonomy = { useCases: ['data-operations'], agentRoles: [], productForms: [], platforms: [], integrations: [] };
  assert.equal(validateLocalization({ summaryZh: '数据库监控工具。', summaryEn: item.desc, primaryCategory: 'data-infrastructure', taxonomy }, item).primaryCategory, 'data-infrastructure');
  assert.throws(() => validateLocalization({ summaryZh: '数据库监控工具。', summaryEn: item.desc, primaryCategory: 'random', taxonomy }, item), /primaryCategory/);
  assert.throws(() => validateLocalization({ summaryZh: '数据库监控工具。', summaryEn: item.desc, primaryCategory: 'data-infrastructure', taxonomy: { useCases: ['made-up'] } }, item), /taxonomy\.useCases/);
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
  // Tags live inside the primary cell, so the grid has five tracks: number, avatar, primary, source, score.
  assert.ok(styles.match(/\.feed-item \{ grid-template-columns: 30px 56px minmax\(280px, 1fr\) \d+px 64px;/), 'a stray column means a cell lost its track');
  assert.match(html, /<div class="item-primary">[\s\S]*<p class="summary"[\s\S]*<div class="item-tags">/);
});

test('source scaffolding tags never repeat the row source as a chip', () => {
  const chipTags = item => [...D.renderItem(item, 'zh-CN').matchAll(/data-tag-label="([^"]*)"/g)].map(match => match[1]);
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
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'mystery-source', tags: ['mystery-source', 'python', 'mcp'] }), ['Agent 能力扩展', 'MCP 服务', 'python']);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'weekly-issues', tags: ['submission'], github: { topics: ['cli'] } }), ['命令行工具', '终端']);
});

test('the primary language renders once, never twice as a language chip and a tag', () => {
  const chipTags = item => [...D.renderItem(item, 'zh-CN').matchAll(/data-tag-label="([^"]*)"/g)].map(match => match[1]);
  // The github-trending collector repeats the language inside `tags`, beside the language chip.
  const trending = { title: 'OpenMAIC', sourceId: 'github-trending', tags: ['github-trending', 'daily', 'TypeScript'], github: { language: 'TypeScript', topics: [] } };
  assert.deepEqual(chipTags(trending), ['TypeScript']);
  assert.deepEqual(chipTags({ title: 'OpenMAIC', sourceId: 'github-trending', tags: ['github-trending', 'daily', 'Go'], github: { language: 'Go', topics: ['cli', 'go'] } }), ['Go', '命令行工具', '终端']);
  // Casing variants of one tag collapse, including the language written differently in a topic.
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'github-trending', github: { language: 'Python', topics: ['Python', 'python'] } }), ['Python']);
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'mystery-source', tags: ['TypeScript'], github: { language: 'typescript' } }), ['typescript']);
  // A source-less item keeps its language chip and still shows unrelated tags.
  assert.deepEqual(chipTags({ title: 'x', sourceId: 'weekly-issue', tags: ['Rust'], github: { language: 'Rust', topics: ['cli'] } }), ['Rust', '命令行工具', '终端']);
});

test('rendered tags disclose whether DevTrends or the original project supplied them', () => {
  const html = D.renderItem({ title: 'Tagged tool', sourceId: 'weekly-issues', taxonomy: { useCases: ['content-creation'] }, github: { language: 'Go', topics: ['original-topic'] } }, 'zh-CN');
  assert.match(html, /data-tag-origin="language" data-tag-label="Go"[^>]*><small>语言<\/small>/);
  assert.match(html, /data-tag-origin="devtrends" data-tag-label="内容创作"[^>]*><small>DT<\/small>/);
  assert.match(html, /data-tag-origin="source" data-tag-label="original-topic"[^>]*><small>原始<\/small>/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  const originMarker = styles.match(/\.project-tags \.tag small, \.item-tags \.tag small \{[^}]*\}/)[0];
  assert.ok(Number(originMarker.match(/font-size:\s*([\d.]+)rem/)[1]) >= .75, 'tag provenance markers must remain legible');
  assert.match(originMarker, /opacity:\s*1/);
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

test('desktop tags occupy exactly one row beneath the description', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  const tags = styles.match(/\.item-tags \{[^}]*\}/)[0];
  const tag = styles.match(/\.item-tags \.tag \{[^}]*\}/)[0];
  const font = Number(tag.match(/font-size:\s*([\d.]+)rem/)[1]);
  const lineHeight = Number(tag.match(/line-height:\s*([\d.]+)/)[1]);
  const padding = Number(tag.match(/padding:\s*(\d+)px/)[1]);
  const declared = tags.match(/--tag-height:\s*calc\(([\d.]+)rem \* ([\d.]+) \+ (\d+)px\)/);
  assert.ok(declared, '--tag-height must stay in the tag metric terms');
  const tagHeight = Number(declared[1]) * 16 * Number(declared[2]) + Number(declared[3]);
  assert.equal(tagHeight, font * 16 * lineHeight + padding * 2, '--tag-height must equal one rendered tag');
  assert.match(tags, /flex-wrap:\s*nowrap/);
  assert.match(tags, /max-height:\s*var\(--tag-height\)/);
});

test('a long source name stays beside its badge instead of wrapping under it', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.match(styles, /\.item-source \{[^}]*flex-wrap: nowrap[^}]*\}/);
  assert.match(styles, /\.item-source \.source-label \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/);
  // The truncated name keeps its full text reachable through title, e.g. 科技爱好者周刊投稿 (108px at .75rem).
  const html = D.renderItem({ title: 'Kiri', sourceId: 'weekly-issues' }, 'zh-CN');
  assert.ok(html.includes('title="科技爱好者周刊投稿"'), html);
  const clusterHtml = D.renderItem({ title: 'Kiri', sourceId: 'chinese-indie-dev' }, 'zh-CN', { date: '2026-09-12', showDate: true });
  assert.match(clusterHtml, /<div class="item-tags has-date"><time class="tag tag-date item-discovery-date"[^>]*>2026年9月12日<\/time>/);
  // The badge stays beside the name, and the name links to the source's own board: an item that
  // carries no origin URL of its own still has a meaningful 来源 (see tests/item-links.test.js).
  assert.match(clusterHtml, /<a class="source-label" href="https:\/\/github\.com\/1c7\/chinese-independent-developer"[^>]*>中文独立开发者<\/a><\/div>/);
  assert.doesNotMatch(clusterHtml, /<div class="item-source">[\s\S]*?<time/);
  // English is ~6.4px/char at .75rem, so only a short label stays readable inside the same column.
  const english = D.sourceName({ sourceId: 'weekly-issues' }, 'en');
  assert.ok(english.length <= 20, `English source label is too long for the row: ${english}`);
  const sourceColumn = styles.match(/\.feed-item \{ grid-template-columns: 30px 56px minmax\(280px, 1fr\) (\d+)px 64px;/);
  assert.ok(sourceColumn, 'list grid template changed shape');
  assert.ok(Number(sourceColumn[1]) >= 144, `source column must fit badge 28 + gap 8 + label 108, got ${sourceColumn[1]}`);
});

test('desktop scores keep breathing room inside the hovered row edge', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  assert.match(styles, /@media \(min-width: 601px\) \{ \.item-score \{ padding-right: 12px; \} \}/);
  assert.match(styles, /\.item-score \{[^}]*white-space: nowrap;/);
  const html = D.renderItem({ title: 'HelloGitHub', sourceId: 'github-trending-cn', github: { stars: 176000 } }, 'zh-CN');
  assert.match(html, /<div class="item-score">[\s\S]*<span>17\.6万<\/span>/);
});

test('known data sources expose safe destination links and real website logos', () => {
  const dist = path.join(__dirname, '../dist');
  for (const sourceId of ['vibecafe', 'chinese-indie-dev', 'chinese-indie-dev-programmer', 'chinese-indie-dev-game', 'weekly-issues', 'weekly-issue', 'hellogithub-issues', 'hellogithub-issue', 'github-trending', 'github-trending-cn', 'producthunt', 'v2ex']) {
    const source = D.sourceInfo({ sourceId });
    assert.ok(source, sourceId);
    assert.ok(D.safeUrl(source.url), `${sourceId} URL`);
    assert.match(source.logo, /^\/source-[a-z0-9]+\.(svg|png)$/, `${sourceId} logo`);
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

test('the V2EX source logo is the site favicon, vendored as a 32px PNG', () => {
  const png = fs.readFileSync(path.join(__dirname, '..', 'web', 'source-v2ex.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(png.readUInt32BE(16), 32, 'IHDR width');
  assert.equal(png.readUInt32BE(20), 32, 'IHDR height');
  // Byte-for-byte the body of https://www.v2ex.com/static/favicon.ico?v=bd989a59ed950fa4feded2ea25d8ddd5,
  // so the hand-drawn grey "V" stand-in cannot come back.
  assert.equal(crypto.createHash('sha256').update(png).digest('hex'), '9c3dc86307a63f5e5b1d2ed7840c7ef4796185ece9209a69a093fe127f680428');
  assert.equal(D.sourceInfo({ sourceId: 'v2ex' }).logo, '/source-v2ex.png');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'web', 'source-v2ex.svg')), 'the invented SVG mark is gone');
});

test('list source badges render the real source logo, never an invented letter or a borrowed mark', () => {
  const badgeOf = item => D.renderItem({ title: 'x', ...item }, 'zh-CN').match(/<span class="source-mini[^"]*" aria-hidden="true">(.*?)<\/span>/)?.[1];
  for (const sourceId of ['vibecafe', 'chinese-indie-dev', 'chinese-indie-dev-programmer', 'chinese-indie-dev-game', 'weekly-issues', 'weekly-issue', 'hellogithub-issues', 'hellogithub-issue', 'github-trending', 'github-trending-cn', 'producthunt', 'v2ex']) {
    assert.equal(badgeOf({ sourceId }), `<img src="${D.sourceInfo({ sourceId }).logo}" alt="${D.escapeHtml(D.sourceName({ sourceId }, 'zh-CN'))}" loading="lazy" />`, sourceId);
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
  assert.equal((home.match(/<button[^>]+data-category="/g) || []).length, D.categories.length + 1);
  // The report pages filter by the same preset categories; the source directory is not a filter.
  const report = fs.readFileSync(path.join(dist, 'reports/2026-09-10/index.html'), 'utf8');
  assert.equal((report.match(/<button[^>]+data-category="/g) || []).length, D.categories.length + 1);
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

test('language and sort controls use the same custom menu pattern as the site pickers', () => {
  const home = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
  assert.match(home, /<details class="menu-picker language-picker" id="language-picker">/);
  assert.match(home, /data-language-choice="zh-CN"/);
  assert.match(home, /data-language-choice="en"/);
  assert.match(home, /<details class="menu-picker sort-picker" id="sort-picker">/);
  assert.match(home, /data-sort-choice="default"/);
  assert.match(home, /data-sort-choice="popular"/);
  assert.doesNotMatch(home, /id="language-select"|id="sort-select"/);
  const styles = fs.readFileSync(path.join(__dirname, '../web/styles.css'), 'utf8');
  assert.match(styles, /\.menu-options \{[^}]*box-shadow: var\(--shadow-floating\)/);
});

test('discovery, archive, trends, trend cluster, and project pages share the same wide desktop canvas', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'web', 'styles.css'), 'utf8');
  for (const view of ['report', 'archive', 'trends', 'trend-cluster', 'project']) {
    assert.ok(styles.includes(`body[data-view="${view}"] .topbar-inner`), `${view} topbar width`);
    assert.ok(styles.includes(`body[data-view="${view}"] .workspace`), `${view} workspace width`);
    assert.ok(styles.includes(`body[data-view="${view}"] .footer`), `${view} footer width`);
  }
  assert.match(styles, /body\[data-view="project"\] \.workspace \{ max-width: 1720px; \}/);
  assert.match(styles, /body\[data-view="project"\] \.footer \{ max-width: 1624px; \}/);
  assert.match(styles, /@media \(min-width: 1500px\) \{ \.trend-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \} \}/);
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
  // 正文里的插图 `<img>` 归 issue-media.js 的配图集，标签本身不能当简介（曾经留下 `src=" />` 残骸）
  assert.equal(descriptionFromIssue('<img width="3612" height="1898" alt="Image" src="https://github.com/user-attachments/assets/abc" />\n\n一张手绘风图标库，零依赖、支持 currentColor。'), '一张手绘风图标库，零依赖、支持 currentColor。');
  assert.equal(descriptionFromIssue('<p>一个把命令行输出变好看的终端工具，支持主题。</p>'), '一个把命令行输出变好看的终端工具，支持主题。');
  // 正文里的 `<` `>` 比较符不是标签，不能被吃掉
  assert.equal(descriptionFromIssue('把 a < b > c 的比较结果画成图表，支持导出 PNG。'), '把 a < b > c 的比较结果画成图表，支持导出 PNG。');
  // 属性里带 `>` 的标签照常删干净
  assert.equal(descriptionFromIssue('<img alt="a > b" src="https://x/a.png">文字'), '文字');
  // ruanyf/weekly#9746（WorldX）：属性里多打了一个引号（`…94d7""`），而清洗用的那条
  // `(?:[^<>"']+|"[^"]*"|'[^']*')*` 是有歧义重复的正则，回溯是指数级的 —— 2026-09-17 的产品库
  // 全量补跑卡在这一行 4 小时没出来。现在改成线性扫描，畸形标签整段删掉。
  const worldX = '<td align="center" valign="top" width="50%"><img src="https://github.com/user-attachments/assets/57b464a7-5954-4e57-a293-c4c9e34c94d7"" alt="WorldX: pixel world simulation with character dialogue sidebar" width="400"/></td>';
  assert.equal(descriptionFromIssue(worldX), '');
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
  const tokens = fs.readFileSync(path.join(__dirname, '../web/token.css'), 'utf8');
  const luminance = hex => {
    const value = parseInt(hex.slice(1), 16), channel = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
  };
  const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (hi + 0.05) / (lo + 0.05); };
  const faint = tokens.match(/--color-text-faint:\s*(#[0-9a-f]{6})/i)[1];
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

test('sidebars only stick when their complete height fits the desktop viewport', () => {
  assert.equal(D.canStickSidebar(1440, 900, 820, 1361), true);
  assert.equal(D.canStickSidebar(1440, 820, 800, 1361), false);
  assert.equal(D.canStickSidebar(1280, 900, 700, 1361), false);
  assert.equal(D.canStickSidebar(1024, 800, 760, 901), true);
  const css = fs.readFileSync(path.join(__dirname, '../web/styles.css'), 'utf8');
  assert.match(css, /\.discovery-sidebar\.is-sticky \{ position: sticky/);
  assert.match(css, /\.project-sidebar\.is-sticky \{ position: sticky/);
  assert.doesNotMatch(css, /\.(?:discovery|project)-sidebar \{[^}]*overflow-y: auto/);
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
  // 漏写开括号的投稿标签（右括号还在）也要清掉：2026-09-17 的 11762 就是 `开源自荐】PiX`。
  assert.equal(title('开源自荐】PiX: 把 AI Agent 会话变成一张图的桌面工作台'), 'PiX: 把 AI Agent 会话变成一张图的桌面工作台');
  assert.equal(title('工具自荐】MathLite —— 打开即用的纯前端数学工具箱'), 'MathLite —— 打开即用的纯前端数学工具箱');
  assert.equal(title('开源推荐] RustDesk 远程桌面'), 'RustDesk 远程桌面');
  // 右括号出现得早、但那段不是投稿标签时不能动开头。
  assert.equal(title('C++ 性能优化】实战笔记'), 'C++ 性能优化】实战笔记');
  assert.equal(title('支持 Markdown 推荐】输出'), '支持 Markdown 推荐】输出');
  // 整个标题就是标签时同样退回原标题。
  assert.equal(title('开源自荐】'), '开源自荐】');
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

test('static report feed is searchable without embedding or repainting the full report', () => {
  const sample = report('2026-09-14', [['showhn', [{ title: 'Test tool', author: 'Hidden maker', summary: 'A novel writing app', tags: ['fiction'], metrics: { votes: 7 }, primaryCategory: 'ai' }]]]);
  const html = R.reportPage(sample, sample.date, 'zh-CN', true);
  const data = JSON.parse(html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.feedMode, 'dom');
  assert.equal(data.report, undefined);
  assert.match(html, /data-category="ai"/);
  assert.match(html, /data-score="7"/);
  assert.match(html, /data-search="[^"]*hidden maker[^"]*fiction/);
  assert.match(html, /rel="preload" as="image" href="\/globe\.svg\?v=[a-f0-9]{16}" fetchpriority="high"/);
  const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
  assert.match(app, /if \(domFeed\) \{/);
  assert.match(app, /if \(query \|\| category !== 'all'\) renderFeed\(\)/);
});

test('saved theme applies before rendering, reacts to system changes, and tolerates blocked storage', () => {
  function environment(saved, blocked = false) {
    let change; const attrs = {};
    const document = { documentElement: { dataset: {}, style: {} }, querySelector: () => ({ setAttribute: (k, v) => { attrs[k] = v; } }) };
    const media = { matches: true, addEventListener: (_, callback) => { change = callback; } };
    const context = { document, localStorage: { getItem(key) { if (blocked) throw Error('blocked'); return typeof saved === 'object' ? saved[key] : (key === 'devtrends-theme-v1' ? saved : null); }, setItem() { if (blocked) throw Error('blocked'); } }, window: { matchMedia: () => media } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/theme.js'), 'utf8'), context);
    return { document, media, change: () => change(), theme: context.window.DevTrendsTheme, attrs };
  }
  const env = environment({ 'devtrends-theme-v1': 'light', 'devtrends-accent-v1': 'forest' });
  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.document.documentElement.dataset.accent, 'forest');
  env.theme.set('system'); assert.equal(env.document.documentElement.dataset.theme, 'dark');
  env.theme.setAccent('violet'); assert.equal(env.document.documentElement.dataset.accent, 'violet');
  env.media.matches = false; env.change(); assert.equal(env.document.documentElement.dataset.theme, 'light');
  const blocked = environment(null, true);
  assert.equal(blocked.document.documentElement.dataset.theme, 'dark');
  assert.equal(blocked.document.documentElement.dataset.accent, 'neutral');
});

test('every page carries the site analytics tags', () => {
  const template = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  assert.ok(template.includes('https://www.clarity.ms/tag/') && template.includes('"clarity", "script", "yhhvfzftgj"'), 'Clarity tag must stay in the shared head template');
  assert.ok(template.includes('googletagmanager.com/gtag/js?id=G-1E9PXZ2EVK'));
  // 每个页面都走同一个 shell，所以首页渲染出来就证明全站都带上了这两个标签。
  const home = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf8');
  assert.ok(home.includes('"clarity", "script", "yhhvfzftgj"'));
  assert.ok(home.includes('gtag(\'config\',\'G-1E9PXZ2EVK\')'));
});

test('HTML pages keep a browser cache window while fingerprinted assets stay immutable', () => {
  // Cloudflare 的 html_handling 自己解析目录索引（`/` → `/index.html`），这类响应拿不到 ETag /
  // Last-Modified，所以 `max-age=0, must-revalidate` 等于每次导航全文重下（首页压缩 78 KB、解码
  // 455 KB）。一个正的 max-age 是唯一能让浏览器直接复用页面的手段；实测 Chrome 对顶层导航不应用
  // stale-while-revalidate，所以 SWR 只能跟在 max-age 后面当补充，不能拿它当主开关。
  const dist = path.join(__dirname, '../dist');
  const headers = fs.readFileSync(path.join(dist, '_headers'), 'utf8');
  const htmlCache = '  Cache-Control: public, max-age=300, stale-while-revalidate=86400';
  for (const route of ['/', '/en/', '/reports/*', '/en/reports/*', '/trends/*', '/en/trends/*']) {
    assert.ok(headers.includes(`${route}\n${htmlCache}`), `${route} must carry the HTML cache window`);
  }
  // `_headers` 的规则在 Cloudflare 侧是叠加的：一条路径命中多条就把同名头逗号拼起来，带指纹资源的
  // `immutable` 会被污染，所以这里既断言它还在，也禁止再出现会撞上它的通配规则。
  assert.ok(headers.includes('/app.js\n  Cache-Control: public, max-age=31536000, immutable'), 'fingerprinted assets must stay immutable');
  assert.ok(!/^\/\*/m.test(headers), 'a catch-all _headers rule would clash with every per-asset Cache-Control');
  assert.ok(!/^\/en\/\*\n/m.test(headers), 'a bare /en/* rule would also hit /en/feed.xml, which has no cache rule of its own');
});

test('pages preconnect the image origins they really reference, and only those', () => {
  const dist = path.join(__dirname, '../dist');
  // 图片在镜像域名和来源 CDN 上，HTML 的连接复用不了；浏览器要等 body 解析完才发现它们，冷链路上
  // 每次握手比图片本身还贵（一张 logo 只有几 KB）。
  for (const [name, file] of [['home', 'index.html'], ['report', 'reports/2026-09-15/index.html']]) {
    const html = fs.readFileSync(path.join(dist, file), 'utf8');
    const origins = [...html.matchAll(/<link rel="preconnect" href="(https:\/\/[^/"]+)"/g)].map(match => match[1]);
    assert.ok(origins.length > 0, `${name} renders mirrored images, so it must hint their origins`);
    assert.equal(new Set(origins).size, origins.length, `${name} must not hint the same origin twice`);
    for (const origin of origins) {
      assert.ok(html.includes(`src="${origin}/`), `${name} preconnects ${origin} but never loads an image from it`);
      assert.ok(html.includes(`<link rel="dns-prefetch" href="${origin}"`), `${name} needs the dns-prefetch fallback for ${origin}`);
    }
  }
  // 这几类页面一张外域图片都没有，多一条预连接就白占一个 socket。
  for (const file of ['404.html', 'reports/index.html', 'trends/index.html']) {
    assert.ok(!fs.readFileSync(path.join(dist, file), 'utf8').includes('rel="preconnect"'), `${file} has no external image to preconnect to`);
  }
});

test('every site verification file is served from the site root byte-for-byte', () => {
  const dist = path.join(__dirname, '../dist');
  const directory = path.join(__dirname, '../verification');
  const names = fs.readdirSync(directory).sort();
  assert.ok(names.length > 0, 'verification/ must hold at least one ownership file');
  for (const name of names) assert.deepEqual(fs.readFileSync(path.join(dist, name)), fs.readFileSync(path.join(directory, name)), name);
  // 站长平台按文件名 + 内容核对归属，内容被改写验证就会失效，所以这几个码固定断言。
  assert.equal(fs.readFileSync(path.join(dist, 'baidu_verify_codeva-PJeG1Qb5NW.html'), 'utf8').trim(), 'eb183876075868f7a4e2e0429c5bd045');
  assert.equal(fs.readFileSync(path.join(dist, 'baidu_verify_codeva-u7AKnhQOjC.html'), 'utf8').trim(), '0c4b01be5dededec00ebc9432ef7c9c6');
  assert.equal(fs.readFileSync(path.join(dist, 'dd375fa2f04a48819425622556a589bb.txt'), 'utf8').trim(), 'f970d68256a5b5859160a2a189d45611006b23dc');
});

test('the worker serves verification .html files with 200 instead of the html_handling redirect', async () => {
  const directory = path.join(__dirname, '../verification');
  const names = fs.readdirSync(directory).filter(name => name.endsWith('.html')).sort();
  assert.ok(names.length > 0, 'verification/ must hold at least one .html ownership file');
  // Cloudflare 静态资源默认把 /x.html 307 到 /x；run_worker_first 必须覆盖这些路径，否则百度又只看到 307。
  const config = fs.readFileSync(path.join(__dirname, '../wrangler.toml'), 'utf8');
  assert.match(config, /run_worker_first\s*=\s*\[[^\]]*"\/baidu_verify_\*"/);
  const worker = (await import(require('node:url').pathToFileURL(path.join(__dirname, '../worker/index.js')).href)).default;
  for (const name of names) {
    const expected = fs.readFileSync(path.join(directory, name), 'utf8').trim();
    const requested = [];
    const env = { ASSETS: { fetch: async request => {
      const pathname = new URL(request.url).pathname;
      requested.push(pathname);
      return pathname === `/${name.replace(/\.html$/, '')}`
        ? new Response(expected, { status: 200 })
        : new Response(null, { status: 307, headers: { location: pathname.replace(/\.html$/, '') } });
    } } };
    const response = await worker.fetch(new Request(`https://devtrends.site/${name}`), env);
    assert.equal(response.status, 200, `${name} must be served with 200, not the 307 html_handling redirect`);
    assert.equal((await response.text()).trim(), expected);
    assert.deepEqual(requested, [`/${name.replace(/\.html$/, '')}`]);
  }
});

test('enumerable pages are static while sitemap product routes are reserved for the Worker', () => {
  const dist = path.join(__dirname, '../dist');
  const index = JSON.parse(fs.readFileSync(path.join(dist, 'data/index.json')));
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/catalog/site-snapshot/manifest.json')));
  assert.equal(index.catalogVersion, snapshot.catalogVersion);
  assert.equal(index.productCount, snapshot.productRoutes.length);
  assert.ok(!fs.existsSync(path.join(dist, 'data/projects.json')), 'the old static project index is retired');
  const trends = JSON.parse(fs.readFileSync(path.join(dist, 'data/trends.json')));
  assert.equal(trends.clusters.length, index.trendCount);
  assert.equal(trends.catalogClusters.length, index.categoryCount);
  assert.ok(trends.catalogClusters.length >= trends.clusters.length);
  for (const cluster of trends.catalogClusters) {
    assert.ok(fs.existsSync(path.join(dist, cluster.path.replace(/^\//, ''), 'index.html')), cluster.path);
    assert.ok(fs.existsSync(path.join(dist, 'en', cluster.path.replace(/^\//, ''), 'index.html')), `/en${cluster.path}`);
  }
  assert.ok(fs.existsSync(path.join(dist, 'trends', 'index.html')));
  assert.ok(fs.existsSync(path.join(dist, 'en', 'trends', 'index.html')));
  const trendsPage = fs.readFileSync(path.join(dist, 'trends', 'index.html'), 'utf8');
  assert.ok(Buffer.byteLength(trendsPage) < 250_000, 'trend HTML must not embed every recent category product');
  assert.ok(fs.statSync(path.join(dist, 'data/trends.json')).size < 250_000, 'public trend JSON is a lean card projection');
  assert.match(trendsPage, /data-trend-weeks="4"/);
  assert.match(trendsPage, /data-trend-weeks="8"/);
  assert.match(trendsPage, /data-trend-weeks="12"/);
  assert.match(trendsPage, /role="tab"[^>]+aria-selected="true"[^>]+data-trend-facet="useCases"/);
  assert.match(trendsPage, /data-trend-facet="agentRoles"/);
  assert.match(trendsPage, /data-trend-facet="languages"/);
  assert.match(trendsPage, /data-trend-facet-panel="agentRoles" hidden/);
  assert.match(trendsPage, /data-trend-facet-panel="languages" hidden/);
  assert.match(trendsPage, /class="trend-bar" data-trend-week="11"/);
  // The source filter is a select-sized trigger inside the lens/period row, and it opens a
  // checklist; the whole card that used to sit above the row is gone.
  assert.ok(!trendsPage.includes('trend-source-picker'), 'the source picker card is replaced by the row control');
  assert.match(trendsPage, /class="trend-controls"[^>]*><div class="trend-facets"[\s\S]*?class="trend-controls-tail">[\s\S]*?class="trend-period"[\s\S]*?data-trend-source-filter[\s\S]*?data-source-toggle[^>]+aria-expanded="false"[^>]+aria-controls="trend-source-panel"/);
  assert.match(trendsPage, /data-source-panel hidden/);
  assert.match(trendsPage, /data-source-options role="group"/);
  assert.match(trendsPage, /data-source-status aria-live="polite"/);
  assert.match(trendsPage, /<span id="trend-source-value" data-source-value>全部来源<\/span>/);
  const enTrendsPage = fs.readFileSync(path.join(dist, 'en', 'trends', 'index.html'), 'utf8');
  assert.match(enTrendsPage, />Sources<\/span>/);
  assert.match(enTrendsPage, /data-source-value>All sources<\/span>/);
  // The MySQL snapshot may have no current language rows while enrichment coverage is still being
  // backfilled, but every controlled language category route remains pre-generated and reachable.
  const languageClusters = trends.clusters.filter(cluster => cluster.type === 'languages');
  if (languageClusters.length) {
    const language = languageClusters[0];
    assert.ok(language?.path?.startsWith('/trends/programming-languages/'));
    assert.ok(fs.existsSync(path.join(dist, language.path.replace(/^\//, ''), 'index.html')));
  }
  assert.ok(trends.catalogClusters.some(cluster => cluster.type === 'languages'));
  const contentCreation = trends.clusters.find(cluster => cluster.key === 'useCases:content-creation');
  assert.ok(contentCreation?.path);
  const travel = trends.clusters.find(cluster => cluster.key === 'useCases:travel-mobility');
  assert.ok(travel?.path === '/trends/use-cases/travel-mobility/');
  assert.ok(fs.existsSync(path.join(dist, travel.path.replace(/^\//, ''), 'index.html')));
  const clusterPagePath = path.join(dist, contentCreation.path.replace(/^\//, ''), 'index.html');
  assert.ok(fs.existsSync(clusterPagePath));
  const clusterPage = fs.readFileSync(clusterPagePath, 'utf8');
  assert.match(clusterPage, new RegExp(`${contentCreation.recentCount} 个新项目`));
  assert.equal((clusterPage.match(/class="feed-item"/g) || []).length, contentCreation.recentCount);
  assert.match(clusterPage, /data-tag-origin="devtrends"/);
  assert.match(clusterPage, /class="tag tag-date item-discovery-date" datetime="2026-09-/);
  // A published sub-topic must be reachable from its parent and route back: novel-writing sits under
  // content-creation (see web/shared.js `taxonomyParents`). The sub-topic itself is data-gated, so these
  // assertions only run while the window carries enough novel-writing projects.
  const novel = trends.clusters.find(cluster => cluster.key === 'useCases:novel-writing');
  if (novel) {
    assert.ok(fs.existsSync(path.join(dist, novel.path.replace(/^\//, ''), 'index.html')));
    assert.ok(clusterPage.includes(`href="${novel.path}"`), 'the parent topic links its published sub-topic');
    assert.match(clusterPage, /class="trend-subtopics trend-subtopics-page"/);
    const novelPage = fs.readFileSync(path.join(dist, novel.path.replace(/^\//, ''), 'index.html'), 'utf8');
    assert.match(novelPage, /业务场景 · 内容创作 › 小说创作/);
    assert.ok(novelPage.includes(`href="${contentCreation.path}"`), 'the sub-topic links back to its parent');
    assert.match(novelPage, /"position":3,"name":"小说创作"/);
  }
  const sitemapRoot = fs.readFileSync(path.join(dist, 'sitemap.xml'), 'utf8');
  const sitemapParts = [...sitemapRoot.matchAll(/<loc>https:\/\/devtrends\.site\/(sitemap-\d+\.xml)<\/loc>/g)]
    .map(match => fs.readFileSync(path.join(dist, match[1]), 'utf8'));
  const sitemap = sitemapParts.length ? sitemapParts.join('\n') : sitemapRoot;
  assert.ok(sitemapParts.length || sitemapRoot.includes('<urlset'), 'root sitemap is a urlset or an index');
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.equal(urls.filter(url => /^https:\/\/devtrends\.site\/(?:en\/)?(?:projects|products)\//.test(url)).length,
    snapshot.productRoutes.filter(route => route.indexable).length * 2);
  assert.equal(new Set(urls).size, urls.length);
  assert.match(sitemap, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.equal((sitemap.match(/hreflang="zh-CN"/g) || []).length, urls.length);
  assert.equal((sitemap.match(/hreflang="en"/g) || []).length, urls.length);
  assert.equal((sitemap.match(/hreflang="x-default"/g) || []).length, urls.length);
  // 百度已明确不再抓取索引型 sitemap，所以百度那份必须是扁平 urlset（首个文件占用不带序号的名字）。
  const baiduFiles = ['sitemap-baidu.xml',
    ...fs.readdirSync(dist).filter(name => /^sitemap-baidu-\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))];
  const baiduSitemap = baiduFiles.map(name => fs.readFileSync(path.join(dist, name), 'utf8')).join('\n');
  assert.ok(!baiduSitemap.includes('<sitemapindex'), 'Baidu no longer crawls index-style sitemaps');
  for (const name of baiduFiles) assert.ok(fs.readFileSync(path.join(dist, name), 'utf8').includes('<urlset'), name);
  const baiduUrls = [...baiduSitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
  assert.equal(baiduUrls.length * 2, urls.length);
  assert.ok(baiduUrls.every(url => url.startsWith(D.origin + '/') && !url.startsWith(D.origin + '/en/')));
  assert.ok(!baiduSitemap.includes('hreflang'));
  const robots = fs.readFileSync(path.join(dist, 'robots.txt'), 'utf8');
  assert.ok(robots.includes(`${D.origin}/sitemap.xml`));
  for (const name of baiduFiles) assert.ok(robots.includes(`${D.origin}/${name}`), `${name} must be declared in robots.txt`);
  for (const locale of ['', 'en/']) {
    const feed = fs.readFileSync(path.join(dist, locale, 'feed.xml'), 'utf8');
    assert.match(feed, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(feed, /<rss version="2\.0"/);
    assert.ok((feed.match(/<item>/g) || []).length > 0);
    assert.ok((feed.match(/<item>/g) || []).length <= 30);
  }
  // Favorites were removed: no page, navigation link, or stored-state copy may survive the build.
  assert.ok(!fs.existsSync(path.join(dist, 'favorites')), 'favorites page must not be built');
  assert.ok(!fs.existsSync(path.join(dist, 'en', 'favorites')), 'English favorites page must not be built');
  assert.ok(!fs.readFileSync(path.join(dist, 'index.html'), 'utf8').includes('/favorites/'), 'navigation must not link favorites');
  for (const url of urls) {
    assert.ok(url.startsWith(D.origin + '/'));
    const route = url.slice(D.origin.length);
    if (/^\/(?:en\/)?(?:projects|products)\//.test(route)) {
      assert.ok(!fs.existsSync(path.join(dist, route, 'index.html')), `${route} must be rendered by the Worker`);
      continue;
    }
    const html = fs.readFileSync(path.join(dist, route, 'index.html'), 'utf8');
    assert.ok(html.includes(`<link rel="canonical" href="${url}"`), url);
    assert.ok(html.includes(`<html lang="${route.startsWith('/en/') ? 'en' : 'zh-CN'}">`), url);
    assert.ok(html.includes('type="application/rss+xml"'), url);
    assert.ok(html.includes('<meta property="og:image" content="https://devtrends.site/og-image.png"'), url);
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image"'), url);
    assert.ok(!html.includes('style-select'), url);
    for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => JSON.parse(match[1]), url);
    const data = JSON.parse(html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    assert.ok(data.locale);
  }
  const homeHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  assert.ok(homeHtml.includes('"@type":"WebSite"'));
  assert.ok(homeHtml.includes('"alternateName":["开发者趋势","devtrends.site"]'));
  assert.ok(fs.statSync(path.join(dist, 'logo-512.png')).size > 1000);
  assert.ok(fs.statSync(path.join(dist, 'og-image.png')).size > 1000);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../site.config.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(dist, `${config.indexNowKey}.txt`), 'utf8').trim(), config.indexNowKey);
  for (const date of index.dates) {
    const data = JSON.parse(fs.readFileSync(path.join(dist, `data/reports/${date}.json`)));
    for (const item of D.reportItems(data)) {
      assert.ok(D.isCategoryId(D.itemCategory(item)), `${date}: ${item.title}`);
      assert.equal(D.itemCategories(item).length, 1, `${date}: ${item.title}`);
      if (D.repository(item)) assert.equal(item.projectPath, D.repository(item).path);
      else assert.match(item.projectPath, /^\/products\/prd_[a-f0-9]{24}\/$/);
    }
    if (fs.existsSync(path.join(__dirname, `../知识/大家都在做什么/final/${date}.md`))) {
      assert.ok(['llm-final', 'mixed'].includes(data.presentation.summarySource), date);
      assert.equal(data.presentation.enhancedItemCount, D.reportItems(data).filter(item => item.summarySource === 'llm-final').length);
      if (date === index.latest) assert.equal(data.presentation.summarySource, 'llm-final');
    }
  }
});
