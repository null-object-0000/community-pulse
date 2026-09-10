/**
 * Pure, offline normalization from source-raw daily files to community-pulse items.
 * This module must not perform network I/O.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { discoverItemRepository, normalizeGitHubRepoUrl } = require('./github_repo_utils');

const VAULT = path.resolve(__dirname, '..', '..', '..', '..');
const DEFAULT_ROOT = path.join(VAULT, '知识', '大家都在做什么', 'source-raw');
const OBSERVED_SOURCES = new Set(['github-trending', 'github-trending-cn']);

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

function issueSummary(body) {
  const clean = (body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/https?:\/\/[^\s)\]]+/g, '')
    .replace(/\s+/g, ' ').trim();
  return clean;
}

function issueItems(document, src) {
  const repository = src.id === 'weekly-issues' ? 'ruanyf/weekly' : '521xueweihan/HelloGitHub';
  const tags = src.id === 'weekly-issues'
    ? ['ruanyf-weekly', 'submission']
    : ['hellogithub', 'submission'];
  // 阮一峰周刊用户投稿里混有文章投稿/推荐（非工具/项目），日报不收录。
  // 匹配「文章自荐」「文章推荐」「文章投稿」标签（含全角/半角括号变体）。
  const isArticleSubmission = (title) => /[\[［【(（]?\s*文章\s*(?:自荐|推荐|投稿)\s*[\]］】)）]?|文章投稿\s*[:：]/.test(title || '');
  return (document.records || [])
    .filter((issue) => src.id !== 'weekly-issues' || !isArticleSubmission(issue.title || ''))
    .map((issue) => {
    const issueUrl = issue.html_url || `https://github.com/${repository}/issues/${issue.number}`;
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
    };
    const githubUrl = discoverItemRepository(item);
    if (githubUrl) item.url = githubUrl;
    else {
      const found = issue.body ? issue.body.match(/https?:\/\/[^\s)\]"']+/g) : null;
      item.url = found?.find((url) => !/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(url)
        && !/github\.com\/(?:user-attachments|[^/]+\/[^/]+\/(?:assets|issues|releases))(?:\/|$)/i.test(url)) || issueUrl;
    }
    return item;
  });
}

function chineseIndieItems(document, src) {
  const items = [];
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
      tags: ['indie-dev', statusName],
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
      image: product.imageUrls?.[0] || product.logoUrl || '',
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

function productHuntItems(document, src) {
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
  return featured.records.map((product) => {
    const productOverview = productPages.get(String(product.id));
    const productLinks = Array.isArray(product.productLinks) ? product.productLinks : [];
    const websiteUrl = productOverview?.websiteUrl || product.website || '';
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
    const item = {
      sourceId: src.id,
      title: product.name || '',
      url: product.url || websiteUrl || '',
      author: '',
      authorUrl: '',
      publishedAt: product.createdAt || null,
      summary: overview || product.description || product.tagline || '',
      tagline: product.tagline || '',
      content: overview || product.description || product.tagline || '',
      metrics: { votes: product.votesCount || 0, comments: product.commentsCount || 0 },
      tags: ['producthunt', 'new', 'official-featured'],
      externalId: String(product.id),
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

const CONVERTERS = {
  vibecafe: vibecafeItems,
  'chinese-indie-dev': chineseIndieItems,
  'weekly-issues': issueItems,
  'hellogithub-issues': issueItems,
  'weekly-issue': weeklyPeriodicalItems,
  'hellogithub-issue': helloGitHubPeriodicalItems,
  'github-trending': trendingItems,
  'github-trending-cn': trendingItems,
  producthunt: productHuntItems,
};

function loadItems(src, options = {}) {
  const converter = CONVERTERS[src.id];
  if (!converter) throw new Error(`no source-raw converter registered for ${src.id}`);
  const loaded = loadDocument(src, options);
  const items = converter(loaded.document, src).map((item) => {
    const githubUrl = normalizeGitHubRepoUrl(item.githubUrl) || discoverItemRepository(item);
    if (!githubUrl) return item;
    return { ...item, githubUrl, github: { ...(item.github || {}), url: githubUrl } };
  });
  const max = src.max_items || items.length;
  return {
    items: items.slice(0, max),
    sourceRaw: {
      sourceId: src.id,
      targetDate: loaded.targetDate,
      path: path.relative(VAULT, loaded.file),
      contentSha256: loaded.document.contentSha256,
      productPagesContentSha256: loaded.document.productPages?.contentSha256 || null,
      capturedAt: loaded.document.fetchedAt,
      complete: loaded.document.complete,
      inputItemCount: loaded.document.itemCount,
      outputItemCount: Math.min(items.length, max),
    },
  };
}

module.exports = { loadItems, latestDate, OBSERVED_SOURCES };
