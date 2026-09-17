/**
 * Pure, offline normalization from source-raw daily files to community-pulse items.
 * This module must not perform network I/O.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { discoverItemRepository, normalizeGitHubRepoUrl, repositoryKey } = require('./github_repo_utils');
const { descriptionFromIssue } = require('./issue-description');
const { issueImages } = require('./issue-media');
const { issueAdmission } = require('./issue-admission');
const D = require('../../../../web/shared.js');
const { boardBySourceId } = require('./chinese_indie_boards');
const { candidatePage } = require('./site_logo');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
// Sources whose only file is a live observation: they have no date-addressable API, so
// their rows are read by the observation day rather than the report day. Show HN is
// deliberately absent — its Algolia range query makes it addressable by report day.
const OBSERVED_SOURCES = new Set(['github-trending', 'github-trending-cn', 'v2ex']);

function latestDate(root, sourceId) {
  const directory = path.join(root, sourceId);
  if (!fs.existsSync(directory)) throw new Error(`source-raw directory is missing: ${directory}`);
  const dates = fs.readdirSync(directory)
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
    .filter(Boolean)
    .sort();
  if (!dates.length) throw new Error(`source-raw has no daily files: ${directory}`);
  return dates.at(-1);
}

function loadDocument(src, options = {}) {
  const root = path.resolve(options.rawRoot || DEFAULT_ROOT);
  const requestedDate = OBSERVED_SOURCES.has(src.id)
    ? (options.observedDate || options.date)
    : options.date;
  const targetDate = requestedDate || latestDate(root, src.id);
  const file = path.join(root, src.id, `${targetDate}.json`);
  if (!fs.existsSync(file)) {
    const kind = OBSERVED_SOURCES.has(src.id) ? 'observation snapshot' : 'daily source file';
    throw new Error(`${kind} is missing: ${file}`);
  }
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (document.schemaVersion !== 1) throw new Error(`${file}: unsupported schemaVersion ${document.schemaVersion}`);
  if (document.sourceId !== src.id) throw new Error(`${file}: sourceId mismatch`);
  if (document.targetDate !== targetDate) throw new Error(`${file}: targetDate mismatch`);
  if (document.complete !== true) throw new Error(`${file}: source capture is incomplete`);
  if (!['ok', 'empty'].includes(document.status)) throw new Error(`${file}: invalid status ${document.status}`);
  return { document, file, targetDate };
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(/^\$D/, ''));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractJsonStringField(text, anchor, field) {
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex < 0) return '';
  const keyIndex = text.indexOf(`"${field}":`, anchorIndex);
  if (keyIndex < 0 || keyIndex - anchorIndex > 5000) return '';
  const start = text.indexOf('"', keyIndex + field.length + 3);
  if (start < 0) return '';
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') {
      try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { return ''; }
    }
  }
  return '';
}

function extractJsonStringBefore(text, marker, field, maxDistance = 2000) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return '';
  const key = `"${field}":`;
  const keyIndex = text.lastIndexOf(key, markerIndex);
  if (keyIndex < 0 || markerIndex - keyIndex > maxDistance) return '';
  const start = text.indexOf('"', keyIndex + key.length);
  if (start < 0 || start > markerIndex) return '';
  let escaped = false;
  for (let index = start + 1; index < markerIndex; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') {
      try { return JSON.parse(text.slice(start, index + 1)); } catch (_) { return ''; }
    }
  }
  return '';
}

function cleanWebsiteUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch (_) {
    return value;
  }
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractMetaContent(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const metaName = tag.match(/\b(?:name|property)\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (metaName?.toLowerCase() !== name.toLowerCase()) continue;
    return decodeHtmlEntities(tag.match(/\bcontent\s*=\s*(["'])(.*?)\1/i)?.[2] || '');
  }
  return '';
}

/** 投稿 Issue 正文常带「项目地址 / 项目描述」模板字段，交给 issue-description 剥离。 */
function issueSummary(body) {
  return descriptionFromIssue(body);
}

// Plain-text submissions often wrap a URL in Chinese punctuation without a
// separating space (`https://example.com/）。说明…`). Stop at prose punctuation
// instead of percent-encoding the following sentence into a bogus URL.
function extractExternalUrls(value) {
  return String(value || '').match(/https?:\/\/[^\s<>()[\]{}"'（）［］【】《》〈〉「」『』，。：；！？、…]+/g) || [];
}

function issueItems(document, src, options = {}) {
  const repository = src.id === 'weekly-issues' ? 'ruanyf/weekly' : '521xueweihan/HelloGitHub';
  const tags = src.id === 'weekly-issues'
    ? ['ruanyf-weekly', 'submission']
    : ['hellogithub', 'submission'];
  // 阮一峰周刊用户投稿里混有文章投稿/推荐（非工具/项目），日报不收录。
  // 匹配「文章自荐」「文章推荐」「文章投稿」标签（含全角/半角括号变体）。
  const isArticleSubmission = (title) => /[\[［【(（]?\s*文章\s*(?:自荐|推荐|投稿)\s*[\]］】)）]?|文章投稿\s*[:：]/.test(title || '');
  return (document.records || [])
    .filter(issue => {
      const decision = issueAdmission({ title: issue.title, sourceId: src.id });
      if (decision.status !== 'accepted') options.onAdmission?.({ sourceId: src.id, externalId: String(issue.number), title: issue.title, ...decision });
      return decision.status !== 'excluded';
    })
    .filter((issue) => src.id !== 'weekly-issues' || !isArticleSubmission(issue.title || ''))
    .map((issue) => {
    const issueUrl = issue.html_url || `https://github.com/${repository}/issues/${issue.number}`;
    // 作者自己在正文里贴的插图 → 产品的「原始配图」（见 issue-media.js）。与简介同源同规则：
    // 图收进配图集，`<img>` 标签不再出现在简介里。
    const images = issueImages(issue.body);
    const item = {
      sourceId: src.id,
      title: issue.title || '',
      url: issueUrl,
      author: issue.user?.login || '',
      authorUrl: issue.user?.html_url || (issue.user?.login ? `https://github.com/${issue.user.login}` : ''),
      publishedAt: issue.created_at || null,
      summary: issueSummary(issue.body),
      content: issue.body || '',
      metrics: { comments: issue.comments || 0 },
      tags,
      externalId: String(issue.number),
      issueUrl,
      ...(images.length ? { images, image: images[0] } : {}),
    };
    const admission = issueAdmission(item);
    if (admission.status === 'review') item.admission = admission;
    const githubUrl = discoverItemRepository(item);
    if (githubUrl) item.url = githubUrl;
    else {
      const found = extractExternalUrls(issue.body);
      item.url = found?.find((url) => !/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(url)
        && !/github\.com\/(?:user-attachments|[^/]+\/[^/]+\/(?:assets|issues|releases))(?:\/|$)/i.test(url)) || issueUrl;
    }
    return D.withTitleFallback(item);
  });
}

function chineseIndieItems(document, src) {
  const items = [];
  // The repository's 程序员版 / 游戏版 boards are separate sources; the tag keeps
  // the board visible in search and in the item tag column.
  const boardTag = boardBySourceId(src.id)?.tag || '';
  let author = '';
  for (const line of (document.sectionMarkdown || '').split('\n')) {
    const text = line.trim();
    const authorMatch = text.match(/^####\s+(.+?)\s*-\s*\[Github\]\(([^)]*)\)/);
    if (authorMatch) {
      author = authorMatch[1].trim();
      continue;
    }
    const match = text.match(/^[-*]\s*:(white_check_mark|clock8|x):\s*\[([^\]]+)\]\(([^)]+)\)\s*[：:，,]?\s*(.*)$/);
    if (!match) continue;
    const [, status, name, url, intro] = match;
    const statusName = { white_check_mark: '已上线', clock8: '开发中', x: '已关闭' }[status] || status;
    items.push({
      sourceId: src.id,
      title: name,
      url,
      author,
      authorUrl: '',
      publishedAt: `${document.targetDate}T00:00:00+08:00`,
      summary: intro,
      content: intro,
      metrics: {},
      tags: ['indie-dev', statusName, ...(boardTag ? [boardTag] : [])],
      externalId: `${document.targetDate}-${name}-${url}`,
    });
  }
  return items;
}

function vibecafeItems(document, src) {
  const details = new Map((document.detailResponses || []).map((detail) => [detail.productId, detail]));
  return (document.records || []).map((product) => {
    const detail = details.get(product.id);
    let detailText = '';
    if (detail?.response?.transferEncoding === 'base64' && detail.response.contentEncoding === 'gzip') {
      detailText = zlib.gunzipSync(Buffer.from(detail.response.body, 'base64')).toString('utf8');
    }
    const githubUrl = discoverItemRepository({ content: detailText });
    const detailDescription = extractJsonStringField(detailText, `"id":"${product.id}"`, 'description');
    const usableDetailDescription = detailDescription && !/^\$[A-Za-z0-9]+$/.test(detailDescription)
      ? detailDescription.trim()
      : '';
    const summary = (usableDetailDescription || product.tagline || '').replace(/\s+/g, ' ').trim();
    // `owner.selectedProduct` describes the author's profile selection, which
    // may be a completely different product. The current product's canonical
    // website is the link attached to the detail page's "体验作品" action.
    const detailWebsiteUrl = extractJsonStringBefore(detailText, '"children":"体验作品 ↗"', 'href');
    const selectedProductWebsite = product.owner?.selectedProduct?.id === product.id
      ? product.owner.selectedProduct.websiteUrl
      : '';
    const websiteUrl = cleanWebsiteUrl(product.websiteUrl || detailWebsiteUrl || selectedProductWebsite || '');
    const vibecafeUrl = `https://vibecafe.ai/products/${product.id}`;
    // VibeCafé stores two distinct media kinds: `logoUrl` is the product mark, while
    // `imageUrls` are the software screenshots (1-9 of them, in display order).
    const logo = typeof product.logoUrl === 'string' ? product.logoUrl.trim() : '';
    const screenshots = [...new Set((Array.isArray(product.imageUrls) ? product.imageUrls : [])
      .filter((url) => typeof url === 'string' && url.trim())
      .map((url) => url.trim()))];
    return {
      sourceId: src.id,
      title: product.name || '',
      url: websiteUrl || githubUrl || vibecafeUrl,
      author: product.owner?.name || product.owner?.handle || '',
      authorUrl: product.owner?.handle ? `https://vibecafe.ai/u/${product.owner.handle}` : '',
      publishedAt: parseDate(product.createdAt),
      summary,
      content: usableDetailDescription || product.tagline || '',
      metrics: {},
      tags: ['vibecafe', 'product'],
      externalId: product.id,
      image: screenshots[0] || logo,
      logo,
      images: screenshots,
      vibecafeId: product.id,
      vibecafeUrl,
      websiteUrl,
      githubUrl,
      github: githubUrl ? { url: githubUrl } : undefined,
    };
  });
}

function decodeContentsRecord(record) {
  if (record?.encoding !== 'base64' || typeof record.content !== 'string') {
    throw new Error(`periodical ${record?.path || '?'} is not a base64 GitHub Contents record`);
  }
  return Buffer.from(record.content.replace(/\s+/g, ''), 'base64').toString('utf8');
}

function extractNextParagraph(lines, index) {
  for (let i = index + 1; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text || /^!\[/.test(text)) continue;
    if (/^\d+、/.test(text) || /^##\s/.test(text)) return '';
    return text;
  }
  return '';
}

function weeklyPeriodicalItems(document, src) {
  const items = [];
  for (const record of document.records || []) {
    const markdown = decodeContentsRecord(record);
    const issue = record.path?.match(/issue-(\d+)\.md$/)?.[1] || '';
    const lines = markdown.split('\n');
    let section = '';
    for (let index = 0; index < lines.length; index += 1) {
      const text = lines[index].trim();
      if (/^##\s/.test(text)) {
        const match = text.match(/^## (\u5de5\u5177|\u8d44\u6e90|\u8f6f\u4ef6|AI \u5de5\u5177|\u5b66\u4e60\u8d44\u6e90)$/);
        section = match ? match[1] : '';
        continue;
      }
      if (!section) continue;
      const match = text.match(/^\d+、\s*\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/);
      if (!match) continue;
      const [, name, url, rest] = match;
      let intro = rest || extractNextParagraph(lines, index);
      let author = '';
      let relatedIssue = null;
      const submission = intro.match(/（\[@([^\]]+)\]\(([^)]+)\)\s*\u6295\u7a3f）$/);
      if (submission) {
        author = submission[1];
        relatedIssue = submission[2];
        intro = intro.slice(0, submission.index).trim();
      }
      items.push({
        sourceId: src.id,
        title: name,
        url,
        author,
        authorUrl: author ? `https://github.com/${author}` : '',
        publishedAt: `${document.targetDate}T00:00:00+08:00`,
        summary: intro,
        content: intro,
        metrics: {},
        tags: ['ruanyf-weekly', 'official', section],
        section,
        externalId: `${issue}-${name}-${url}`,
        relatedIssue,
        issue,
      });
    }
  }
  return items;
}

function helloGitHubPeriodicalItems(document, src) {
  const items = [];
  for (const record of document.records || []) {
    const markdown = decodeContentsRecord(record);
    const issue = record.path?.match(/HelloGitHub(\d+)\.md$/)?.[1] || '';
    let language = '';
    for (const line of markdown.split('\n')) {
      const text = line.trim();
      const heading = text.match(/^###\s+(.+?\u9879\u76ee|\u5176\u5b83.*)$/);
      if (heading) {
        language = heading[1].replace(/\u9879\u76ee$/, '').trim();
        continue;
      }
      if (!language) continue;
      const match = text.match(/^\d+、\s*\[([^\]]+)\]\(([^)]+)\)\s*[：:]\s*(.*)$/);
      if (!match) continue;
      const [, name, rawUrl, fullIntro] = match;
      const target = rawUrl.match(/[?&]target=([^&]+)/);
      const url = target ? decodeURIComponent(target[1]) : rawUrl;
      let intro = fullIntro;
      let author = '';
      const share = fullIntro.match(/\u6765\u81ea\s*\[@([^\]]+)\]\([^)]*\)\s*\u7684\u5206\u4eab$/);
      if (share) {
        author = share[1];
        intro = fullIntro.slice(0, share.index).trim();
      }
      items.push({
        sourceId: src.id,
        title: name,
        url,
        author,
        authorUrl: '',
        publishedAt: `${document.targetDate}T00:00:00+08:00`,
        summary: intro,
        content: intro,
        metrics: {},
        tags: ['hellogithub', 'official', language],
        lang: language,
        externalId: `${issue}-${name}-${url}`,
        relatedShare: author || null,
        issue,
      });
    }
  }
  return items;
}

function stripHtml(value) {
  return value.replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/\s+/g, ' ').trim();
}

function trendingItems(document, src) {
  if (document.response?.transferEncoding !== 'base64' || document.response?.contentEncoding !== 'gzip') {
    throw new Error(`${src.id}: unsupported stored response encoding`);
  }
  const html = zlib.gunzipSync(Buffer.from(document.response.body, 'base64')).toString('utf8');
  const since = document.capture?.since || 'daily';
  const items = [];
  for (const block of html.split('class="Box-row"').slice(1)) {
    const name = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"?#]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!name) continue;
    const fullName = name[1].trim();
    const description = block.match(/<p[^>]*class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    const language = block.match(/<span itemprop="programmingLanguage">([^<]+)<\/span>/i)?.[1]?.trim() || '';
    const todayText = block.match(/([\d,]+)\s*stars?\s*today/i)?.[1] || '';
    const today = Number(todayText.replace(/,/g, '')) || 0;
    let stars = 0;
    let forks = 0;
    const builtIndex = block.search(/Built by/i);
    if (builtIndex > 0) {
      const numbers = [...stripHtml(block.slice(0, builtIndex)).matchAll(/([\d,]+)/g)]
        .map((match) => Number(match[1].replace(/,/g, '')) || 0);
      if (numbers.length >= 2) [stars, forks] = numbers.slice(-2);
      else if (numbers.length === 1) [stars] = numbers;
    }
    const owner = fullName.split('/')[0] || '';
    items.push({
      sourceId: src.id,
      title: stripHtml(name[2]),
      url: `https://github.com/${fullName}`,
      author: owner,
      authorUrl: owner ? `https://github.com/${owner}` : '',
      publishedAt: null,
      summary: description ? stripHtml(description[1]) : '',
      content: description ? stripHtml(description[1]) : '',
      metrics: { stars, today, forks, lang: language },
      tags: ['github-trending', since, language],
      externalId: `${since}-${fullName}`,
    });
  }
  return items;
}

function productHuntItems(document, src, options = {}) {
  const featured = document.officialFeatured;
  if (!featured || featured.complete !== true || !Array.isArray(featured.records)) {
    throw new Error(`${src.id}: complete officialFeatured records are missing`);
  }
  const productPages = new Map();
  for (const page of document.productPages?.pages || []) {
    try {
      const html = zlib.gunzipSync(Buffer.from(page.response?.body || '', 'base64')).toString('utf8');
      const metaDescription = extractMetaContent(html, 'description');
      const productAnchor = '"product":{"__typename":"Product"';
      const details = {
        name: extractJsonStringField(html, productAnchor, 'name'),
        tagline: extractJsonStringField(html, productAnchor, 'tagline'),
        description: metaDescription,
        websiteUrl: extractJsonStringField(html, productAnchor, 'websiteUrl'),
        sourceUrl: page.url,
      };
      for (const id of page.postIds || []) productPages.set(String(id), details);
    } catch (_) {
      // Validation reports malformed captures; normalization remains compatible
      // with historical files that predate product-page capture.
    }
  }
  const resolvedLinks = new Map((document.linkResolution?.links || [])
    .filter((link) => link.ok && link.resolvedUrl)
    .map((link) => [link.originalUrl, link.resolvedUrl]));
  // The published daily report intentionally consumes Product Hunt's official
  // featured subset. The product catalog needs the complete daily ledger. Keep
  // both views in this one converter so parsing, URL resolution and identity
  // discovery cannot drift between the report and catalog pipelines.
  const featuredById = new Map(featured.records.map((product) => [String(product.id), product]));
  const records = options.productHuntView === 'all'
    ? (Array.isArray(document.records) ? document.records : [])
    : featured.records;
  return records.map((rawProduct) => {
    const featuredProduct = featuredById.get(String(rawProduct.id));
    const product = featuredProduct ? { ...rawProduct, ...featuredProduct } : rawProduct;
    const productOverview = productPages.get(String(product.id));
    const productLinks = (Array.isArray(product.productLinks) ? product.productLinks : [])
      .map((link) => ({ ...link, url: resolvedLinks.get(link.url) || link.url }));
    const websiteUrl = resolvedLinks.get(product.website) || productOverview?.websiteUrl || product.website || '';
    const identityTokens = (value) => String(value || '').toLowerCase()
      .match(/[a-z0-9][a-z0-9.-]{2,}|[\u4e00-\u9fff]{2,}/g) || [];
    const launchTokens = new Set(identityTokens(product.name));
    const sameProductIdentity = identityTokens(productOverview?.name)
      .some((token) => launchTokens.has(token));
    // A Product Hunt product page can be a broad parent brand (for example,
    // OpenAI) whose launch is a distinct product. Only substitute the overview
    // when the launch and product page clearly refer to the same identity.
    const overview = sameProductIdentity
      ? (productOverview?.description || productOverview?.tagline || '')
      : '';
    // Launch media mirrors VibeCafé's split: `thumbnail` is the product mark, `media`
    // is the gallery (Media.url is the image, or the video cover when videoUrl is set).
    // Posts captured before the featured projection carried media simply have neither.
    const logo = typeof product.thumbnail?.url === 'string' ? product.thumbnail.url.trim() : '';
    const screenshots = [...new Set((Array.isArray(product.media) ? product.media : [])
      .map((entry) => (entry && typeof entry.url === 'string' ? entry.url.trim() : ''))
      .filter((url) => url && url !== logo))];
    const item = {
      sourceId: src.id,
      title: product.name || '',
      url: product.url || websiteUrl || '',
      author: '',
      authorUrl: '',
      publishedAt: product.createdAt || null,
      summary: product.description || product.tagline || overview || '',
      tagline: product.tagline || '',
      content: product.description || product.tagline || overview || '',
      metrics: { votes: product.votesCount || 0, comments: product.commentsCount || 0 },
      tags: ['producthunt', 'new', ...(featuredProduct ? ['official-featured'] : [])],
      externalId: String(product.id),
      image: screenshots[0] || logo,
      logo,
      images: screenshots,
      websiteUrl,
      productLinks,
      productOverview: productOverview || null,
      launch: {
        name: product.name || '',
        tagline: product.tagline || '',
        description: product.description || '',
      },
    };
    const githubUrl = discoverItemRepository(item);
    if (githubUrl) {
      item.githubUrl = githubUrl;
      item.github = { url: githubUrl };
    }
    return item;
  });
}

// Show HN rows: the maker's own announcement, the English-writing world's main
// "I built a thing" channel. Metrics are the snapshot values taken on the source
// day, so they read as "on that day this story had N points".
function showHnItems(document, src) {
  return (document.records || []).map((story) => ({
    sourceId: src.id,
    title: story.title || '',
    url: story.url || story.hnUrl || `https://news.ycombinator.com/item?id=${story.objectID}`,
    author: story.author || '',
    authorUrl: story.author ? `https://news.ycombinator.com/user?id=${story.author}` : '',
    publishedAt: story.createdAt || null,
    summary: stripHtml(story.storyText || ''),
    content: stripHtml(story.storyText || ''),
    metrics: { points: story.points || 0, comments: story.comments || 0 },
    tags: ['showhn'],
    externalId: String(story.objectID),
    hnUrl: story.hnUrl || `https://news.ycombinator.com/item?id=${story.objectID}`,
  }));
}

// V2EX 分享创造 rows. The public API returns the node's current page, so these
// items are whatever the node showed on the observation day.
function v2exItems(document, src) {
  return (document.records || []).map((topic) => ({
    sourceId: src.id,
    title: topic.title || '',
    url: topic.url || `https://www.v2ex.com/t/${topic.topicId}`,
    author: topic.author || '',
    authorUrl: topic.author ? `https://www.v2ex.com/member/${topic.author}` : '',
    publishedAt: topic.createdAt || null,
    summary: stripHtml(topic.content || ''),
    content: stripHtml(topic.content || ''),
    metrics: { replies: topic.replies || 0 },
    tags: ['v2ex', 'create'],
    externalId: String(topic.topicId),
  }));
}

const CONVERTERS = {
  vibecafe: vibecafeItems,
  showhn: showHnItems,
  v2ex: v2exItems,
  'chinese-indie-dev': chineseIndieItems,
  'chinese-indie-dev-programmer': chineseIndieItems,
  'chinese-indie-dev-game': chineseIndieItems,
  'weekly-issues': issueItems,
  'hellogithub-issues': issueItems,
  'weekly-issue': weeklyPeriodicalItems,
  'hellogithub-issue': helloGitHubPeriodicalItems,
  'github-trending': trendingItems,
  'github-trending-cn': trendingItems,
  producthunt: productHuntItems,
};

// The website-logo fallback is an auxiliary source layer: each day file proves which icon the
// official website of a mark-less row declared. Reading it stays offline, and a day without a file
// simply means those rows keep the text avatar.
function loadSiteLogos(date, rawRoot) {
  if (!date) return null;
  const file = path.join(path.resolve(rawRoot || DEFAULT_ROOT), 'site-logos', `${date}.json`);
  if (!fs.existsSync(file)) return null;
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (document.schemaVersion !== 1 || document.sourceId !== 'site-logos') return null;
  const byExternalId = new Map();
  const byPage = new Map();
  for (const record of document.records || []) {
    if (record.status !== 'ok' || typeof record.iconUrl !== 'string' || !record.iconUrl) continue;
    byExternalId.set(`${record.sourceId}\u0000${record.externalId}`, record.iconUrl);
    byPage.set(`${record.sourceId}\u0000${record.pageUrl}`, record.iconUrl);
  }
  return { byExternalId, byPage };
}

// Same day file, second view: the `og:image` and the dedup hashes of the mark. `og:image` is a
// gallery candidate, not a mark — see attachSiteOgImages.
function loadSiteOgImages(date, rawRoot) {
  if (!date) return null;
  const file = path.join(path.resolve(rawRoot || DEFAULT_ROOT), 'site-logos', `${date}.json`);
  if (!fs.existsSync(file)) return null;
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (document.schemaVersion !== 1 || document.sourceId !== 'site-logos') return null;
  const byExternalId = new Map();
  const byPage = new Map();
  for (const record of document.records || []) {
    const og = record.ogImage;
    if (!og || typeof og.url !== 'string' || !og.url) continue;
    const entry = { url: og.url, sha256: og.sha256 || '', dhash: typeof og.dhash === 'number' ? og.dhash : null };
    byExternalId.set(`${record.sourceId}\u0000${record.externalId}`, entry);
    if (record.pageUrl) byPage.set(`${record.sourceId}\u0000${record.pageUrl}`, entry);
  }
  if (!byExternalId.size && !byPage.size) return null;
  return { byExternalId, byPage };
}

// The mark's own dedup hash travels beside the row so the browser can drop an OG image that is
// literally the product logo. Kept out of the item's own fields: it is render metadata.
function attachMarkImage(items, sourceId, date, rawRoot) {
  const index = loadSiteOgImages(date, rawRoot);
  if (!index) return items;
  return items.map((item) => {
    if (item.markImage) return item;
    const page = candidatePage(item);
    const record = index.byExternalId.get(`${sourceId}\u0000${item.externalId}`)
      || (page ? index.byPage.get(`${sourceId}\u0000${page}`) : null);
    if (!record || record.dhash === null) return item;
    return { ...item, markImage: { sha256: record.sha256 || '', dhash: record.dhash } };
  });
}

// A row with its own product mark never borrows the website's: this only fills rows that would
// otherwise render as initials. An interrupted (incomplete) day file still contributes what it has;
// validate_site_logos_raw.js is what guards the layer in production.
function attachSiteLogos(items, sourceId, date, rawRoot) {
  const index = loadSiteLogos(date, rawRoot);
  if (!index) return items;
  return items.map((item) => {
    if (item.logo || item.icon || item.siteLogo) return item;
    const page = candidatePage(item);
    const siteLogo = index.byExternalId.get(`${sourceId}\u0000${item.externalId}`)
      || (page ? index.byPage.get(`${sourceId}\u0000${page}`) : '');
    return siteLogo ? { ...item, siteLogo } : item;
  });
}

// The same day file also carries the page's `og:image`, which is a *gallery* candidate rather than
// a mark: it is far too wide to identify a product at 48px, so it must never reach the avatar. It
// is attached on its own field (`ogImage`) and the browser decides whether to show it after the
// source's own media and our own screenshot.
function attachSiteOgImages(items, sourceId, date, rawRoot) {
  const index = loadSiteOgImages(date, rawRoot);
  if (!index) return items;
  return items.map((item) => {
    if (item.ogImage) return item;
    const page = candidatePage(item);
    const og = index.byExternalId.get(`${sourceId}\u0000${item.externalId}`)
      || (page ? index.byPage.get(`${sourceId}\u0000${page}`) : null);
    return og ? { ...item, ogImage: og } : item;
  });
}

const SOURCE_ID_SCREENSHOTS = 'screenshots';
// 官网首屏截图层：独立目录，一天一个日文件，图片字节按内容寻址存在同级的 -files 目录。
// 上传 R2 后这里存的是镜像路径，与其它图片走同一条 localImage 通道。
function loadScreenshots(date, sourceRawRoot) {
  if (!date) return null;
  const root = path.resolve(sourceRawRoot || DEFAULT_ROOT);
  const file = path.join(root, 'screenshots', `${date}.json`);
  if (!fs.existsSync(file)) return null;
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (document.schemaVersion !== 1 || document.sourceId !== 'screenshots') return null;
  const byKey = new Map();
  for (const record of document.records || []) {
    if (record.status !== 'ok' || !record.screenshot) continue;
    const name = `${record.screenshot.thumbSha256}.${record.screenshot.extension}`;
    const entry = {
      name,
      // `screenshots-files/<name>` is turned into a mirror path by image-store.js; until then the
      // browser drops it, so a missing mirror degrades the row instead of breaking the build.
      source: `${SOURCE_ID_SCREENSHOTS}-files/${name}`,
      sha256: record.screenshot.thumbSha256,
      width: record.screenshot.width || 0,
    };
    byKey.set(`${record.sourceId}\u0000${record.externalId}`, entry);
    byKey.set(`${record.sourceId}\u0000${record.pageUrl}`, entry);
  }
  if (!byKey.size) return null;
  return { byKey };
}

function attachScreenshots(items, screenshots) {
  if (!screenshots) return items;
  return items.map((item) => {
    if (Array.isArray(item.screenshots) && item.screenshots.length) return item;
    const page = candidatePage(item);
    const entry = screenshots.byKey.get(`${item.sourceId}\u0000${item.externalId}`)
      || (page ? screenshots.byKey.get(`${item.sourceId}\u0000${page}`) : null);
    return entry ? { ...item, screenshots: [entry.source] } : item;
  });
}

// ── 产品描述兜底 ─────────────────────────────────────────────────────────────
// 一条行可能三种来源都没有描述：社区采集只给了标题（Show HN 链接帖）、投稿模板字段残缺、
// 或者来源本身就没有长描述。按固定优先级补一个：
//
//   ① 行自带的描述字段（summary / content / tagline / productOverview，取最长的那个）
//   ② GitHub 仓库描述（来自 github-repositories 快照，离线、零请求）
//   ③ 官网描述（<meta name="description"> / og:description，由 site-logos 层顺带抓取）
//
// 三级都不满足阈值就保持原样。**只在原描述过短时填补，绝不覆盖已有的社区描述** ——
// 官网描述常是营销文案（实测有比原描述更差的例子），社区原文才是首选。
const DESCRIPTION_MIN_LENGTH = 40;

// 与 web/shared.js 的展示回退链保持一致：summary → tagline → (github.description) → content。
// 这里不引入 github.description，否则第二级会被自己短路掉、永远走不到第三级。
const SOURCE_DESCRIPTION_FIELDS = ['summary', 'tagline', 'productOverview', 'content', 'description'];

function itemDescriptionCandidates(item) {
  const values = [];
  for (const field of SOURCE_DESCRIPTION_FIELDS) {
    const value = item?.[field];
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
  }
  // Product Hunt 的 launch 块可能带 tagline / description。
  if (item?.launch && typeof item.launch === 'object') {
    for (const field of ['tagline', 'description', 'overview']) {
      const value = item.launch[field];
      if (typeof value === 'string' && value.trim()) values.push(value.trim());
    }
  }
  return values;
}

function sourceDescriptionLength(item) {
  return itemDescriptionCandidates(item).reduce((longest, value) => Math.max(longest, value.replace(/\s+/g, ' ').trim().length), 0);
}

function meetsDescriptionFloor(value) {
  return typeof value === 'string' && value.replace(/\s+/g, ' ').trim().length >= DESCRIPTION_MIN_LENGTH;
}

// 官网描述的读取与 site-logos 图标同源同文件，所以不增加任何请求；文件不存在时静默跳过，
// 那些行就停在第二级。按 externalId 优先、pageUrl 兜底，和 icon 的匹配方式一致。
function loadSiteDescriptions(date, rawRoot) {
  if (!date) return null;
  const file = path.join(path.resolve(rawRoot || DEFAULT_ROOT), 'site-logos', `${date}.json`);
  if (!fs.existsSync(file)) return null;
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  if (document.schemaVersion !== 1 || document.sourceId !== 'site-logos') return null;
  const byExternalId = new Map();
  const byPage = new Map();
  for (const record of document.records || []) {
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    if (!meetsDescriptionFloor(description)) continue;
    byExternalId.set(`${record.sourceId}\u0000${record.externalId}`, description);
    if (record.pageUrl) byPage.set(`${record.sourceId}\u0000${record.pageUrl}`, description);
  }
  if (!byExternalId.size && !byPage.size) return null;
  return { byExternalId, byPage };
}

/**
 * 按「源 → 仓库 → 官网」顺序给描述过短的行补一个产品描述。
 *
 * 必须在 dedupe 之前调用：collect.js 的标题+描述兜底去重要求**两边描述都 ≥ 40 字符**
 * （descriptionSimilarity 的长度守卫），描述空着的行参与不了那道去重。补完描述再排重，
 * 顺带把历史上因描述为空而漏掉的重复也纳入判定。
 *
 * 只写 `summary`，不写 `content`：content 在若干来源里是「原文全文」的语义（如 V2EX 楼层），
 * 断言里也把它当原文存档比对；描述兜底是展示层的事，碰它会让「原文」语义失真。
 */
function attachDescriptionFallback(items, options = {}) {
  const { repositories = null, descriptions = null } = options;
  if (!repositories && !descriptions) return items;
  return items.map((item) => {
    if (sourceDescriptionLength(item) >= DESCRIPTION_MIN_LENGTH) return item;
    const key = repositoryKey(item.githubUrl || item.github?.url);
    const github = (key && repositories?.get(key)) || item.github || null;
    if (github && meetsDescriptionFloor(github.description)) {
      return { ...item, summary: github.description.trim(), descriptionSource: 'repository' };
    }
    if (descriptions) {
      const page = candidatePage(item);
      const fromWebsite = descriptions.byExternalId.get(`${item.sourceId}\u0000${item.externalId}`)
        || (page ? descriptions.byPage.get(`${item.sourceId}\u0000${page}`) : '');
      if (meetsDescriptionFloor(fromWebsite)) {
        return { ...item, summary: fromWebsite.trim(), descriptionSource: 'website' };
      }
    }
    return item;
  });
}

// The GitHub repository snapshot is its own source layer: stars, language and — crucially for the
// website-logo fallback — `homepage` live there, not in the per-source day files. Both the 日报
// generator and capture_site_logos_raw.js read it through this offline helper.
function loadGithubRepositories(sourceRoot, targetDate) {
  const root = path.resolve(sourceRoot || DEFAULT_ROOT);
  const file = path.join(root, 'github-repositories', `${targetDate}.json`);
  if (!fs.existsSync(file)) throw new Error(`GitHub repository snapshot is missing: ${file}`);
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (document.sourceId !== 'github-repositories' || document.targetDate !== targetDate || document.complete !== true) {
    throw new Error(`GitHub repository snapshot is invalid: ${file}`);
  }
  const repositories = new Map();
  for (const record of document.records || []) {
    const repo = record.response || {};
    repositories.set(record.repository, {
      url: repo.html_url,
      name: repo.full_name,
      description: repo.description || '',
      stars: repo.stargazers_count || 0,
      forks: repo.forks_count || 0,
      openIssues: repo.open_issues_count || 0,
      language: repo.language || '',
      license: repo.license?.spdx_id || repo.license?.name || '',
      topics: repo.topics || [],
      homepage: repo.homepage || '',
      defaultBranch: repo.default_branch || '',
      createdAt: repo.created_at || null,
      updatedAt: repo.updated_at || null,
      pushedAt: repo.pushed_at || null,
      archived: repo.archived === true,
      snapshotDate: targetDate,
    });
  }
  return { document, repositories, file };
}

function attachRepositoryFacts(items, repositories) {
  if (!repositories) return items;
  return items.map((item) => {
    const key = repositoryKey(item.githubUrl || item.github?.url);
    const github = key ? repositories.get(key) : null;
    return github ? { ...item, githubUrl: github.url, github } : item;
  });
}

function attachGithubRepositories(results, repositories) {
  for (const result of results) result.items = attachRepositoryFacts(result.items, repositories);
  return results;
}

function loadItems(src, options = {}) {
  const converter = CONVERTERS[src.id];
  if (!converter) throw new Error(`no source-raw converter registered for ${src.id}`);
  const loaded = loadDocument(src, options);
  const admissionDecisions = [];
  const items = converter(loaded.document, src, { ...options, onAdmission: decision => {
    admissionDecisions.push(decision);
    options.onAdmission?.(decision);
  } }).map((item) => {
    const githubUrl = normalizeGitHubRepoUrl(item.githubUrl) || discoverItemRepository(item);
    if (!githubUrl) return item;
    return { ...item, githubUrl, github: { ...(item.github || {}), url: githubUrl } };
  });
  // Aggregators may need the complete normalized ranking before applying a
  // cross-day novelty policy. The default remains source-config truncation so
  // every existing caller keeps its previous behaviour.
  const max = options.maxItems === Infinity ? items.length : (options.maxItems ?? src.max_items ?? items.length);
  // Three views of the same site-logos day file, applied in this order: the mark (48px avatar), the
  // gallery candidate (og:image) and the dedup hash that keeps the two from being shown twice.
  const capped = items.slice(0, max);
  const withLogos = attachSiteLogos(capped, src.id, loaded.targetDate, options.rawRoot);
  const withOgImages = attachSiteOgImages(withLogos, src.id, loaded.targetDate, options.rawRoot);
  const selected = attachMarkImage(withOgImages, src.id, loaded.targetDate, options.rawRoot);
  return {
    items: selected,
    sourceRaw: {
      sourceId: src.id,
      targetDate: loaded.targetDate,
      path: path.relative(VAULT, loaded.file),
      contentSha256: loaded.document.contentSha256,
      linkResolutionContentSha256: loaded.document.linkResolution?.contentSha256 || null,
      productPagesContentSha256: loaded.document.productPages?.contentSha256 || null,
      capturedAt: loaded.document.fetchedAt,
      complete: loaded.document.complete,
      inputItemCount: loaded.document.itemCount,
      outputItemCount: selected.length,
      admissionDecisions,
    },
  };
}

module.exports = {
  loadItems, attachSiteLogos, attachSiteOgImages, attachMarkImage, loadSiteOgImages, loadGithubRepositories, attachGithubRepositories, attachRepositoryFacts, extractExternalUrls,
  loadSiteDescriptions, attachDescriptionFallback, loadScreenshots, attachScreenshots, sourceDescriptionLength, meetsDescriptionFloor, DESCRIPTION_MIN_LENGTH,
  latestDate, OBSERVED_SOURCES,
};
