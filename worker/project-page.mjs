import D from '../web/shared.js';

const ORIGIN = 'https://devtrends.site';
const ASSET_VERSION = '20260916-product-links';
const ANALYTICS = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-1E9PXZ2EVK"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-1E9PXZ2EVK');</script><script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i+"?ref=bwt";y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","yhhvfzftgj");</script>`;

const text = (value) => String(value ?? '');
const escapeHtml = (value) => text(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const safeUrl = (value) => {
  try {
    const url = new URL(text(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
};
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const localPath = (route, locale) => locale === 'en' ? `/en${route}` : route;
const dateLabel = (date, locale) => {
  const value = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(value.valueOf()) ? text(date) : new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(value);
};

function summaryOf(item, locale) {
  if (locale === 'en') return text(item.summaryEn || item.summary_en || item.summary || item.summaryZh || item.summary_zh);
  return text(item.summaryZh || item.summary_zh || item.summary || item.summaryEn || item.summary_en);
}

// The detail page offers the same three destinations as the feed rows and resolves them with the
// same shared function. Using the catalogue's canonical URL as the website fallback made 官网 point
// at the repository — a GitHub-backed product's canonical URL IS its repository — so 官网 duplicated
// the GitHub button and the real website was left over as 来源.
function linkEntries(product, locale) {
  const item = product.item || {};
  const labels = locale === 'en'
    ? { repository: 'GitHub', website: 'Website', source: 'Source' }
    : { repository: 'GitHub', website: '官网', source: '来源' };
  const repoUrl = safeUrl(item.githubUrl) || (product.githubRepo ? safeUrl(`https://github.com/${product.githubRepo}`) : '');
  const entries = D.itemLinks(item).map(([key, url]) =>
    // Show the repository with the owner's own casing; the shared resolver lowercases it for identity.
    [labels[key] || key, key === 'repository' && repoUrl ? repoUrl : url]);
  // The catalogue knows the repository even when the stored item lost its githubUrl.
  if (repoUrl && !entries.some(([label]) => label === labels.repository)) entries.unshift([labels.repository, repoUrl]);
  const seen = new Set();
  return entries.filter(([, url]) => url && !seen.has(url.toLowerCase()) && seen.add(url.toLowerCase()));
}

function trustedImage(value) {
  const url = safeUrl(value);
  if (!url) return '';
  const parsed = new URL(url);
  if (['ph-files.imgix.net', 'akxlagkpqhwjrwrq.public.blob.vercel-storage.com'].includes(parsed.hostname.toLowerCase())) return url;
  if (parsed.hostname.toLowerCase() === 'img.devtrends.site' &&
      /^\/images\/[a-f0-9]{64}\.(?:png|jpg|gif|webp|avif|ico|svg)$/.test(parsed.pathname) &&
      !parsed.search && !parsed.hash) return url;
  return '';
}

function productGallery(item, locale) {
  const images = [...new Set([
    ...(Array.isArray(item.images) ? item.images : []),
    ...(Array.isArray(item.imageUrls) ? item.imageUrls : []),
    item.image,
  ].map((value) => trustedImage(typeof value === 'string' ? value : value?.url)).filter(Boolean))].slice(0, 9);
  if (!images.length) return '';
  const label = locale === 'en' ? 'View product image' : '查看产品配图';
  const thumbs = images.slice(0, 3).map((url, index) => {
    const description = `${label} · ${index + 1}/${images.length}`;
    return `<button type="button" class="gallery-thumb" data-index="${index}" aria-label="${escapeHtml(description)}"><img src="${escapeHtml(url)}" alt="${escapeHtml(description)}" loading="lazy"/></button>`;
  }).join('');
  const more = images.length > 3 ? `<button type="button" class="gallery-thumb gallery-more" data-index="3" aria-label="${escapeHtml(`${label} · +${images.length - 3}`)}">+${images.length - 3}</button>` : '';
  return `<section class="panel" id="screenshots"><h2>${locale === 'en' ? 'Product images' : '产品配图'}</h2><div class="item-gallery" data-gallery="${escapeHtml(JSON.stringify(images))}" data-origins="${escapeHtml(JSON.stringify(images.map(() => locale === 'en' ? 'Source image' : '来源原图')))}" role="group" aria-label="${escapeHtml(label)}">${thumbs}${more}</div></section>`;
}

export function renderProductPage(model, locale = 'zh-CN') {
  const product = model.product;
  const item = product.item || {};
  const en = locale === 'en';
  const route = product.route;
  const canonical = ORIGIN + localPath(route, locale);
  const zhUrl = ORIGIN + route;
  const enUrl = ORIGIN + `/en${route}`;
  const summary = summaryOf(item, locale) || (en ? 'A product discovered by DevTrends.' : 'DevTrends 收录的开发者产品。');
  const indexable = String(item.summaryZh || item.summaryEn || item.summary || '').trim().length >= 20;
  const title = `${text(product.title)} | DevTrends`;
  const description = `${text(product.title)} — ${summary}`.slice(0, 165);
  const links = linkEntries(product, locale);
  const gallery = productGallery(item, locale);
  const mark = trustedImage(item.logo) || trustedImage(item.icon) || trustedImage(item.siteLogo);
  // Each row is one source's first/last sighting. The dates collapse to a single label when a
  // product was only seen once, so the common case reads as a date instead of a redundant range.
  const sourceRows = (product.sources || []).map((source) => {
    const first = dateLabel(source.firstSeenDate, locale);
    const last = dateLabel(source.lastSeenDate, locale);
    const range = first === last ? first : `${first} – ${last}`;
    const count = en ? `${source.observationCount} observations` : `${source.observationCount} 次收录`;
    return `<li><b>${escapeHtml(source.sourceName || source.sourceId)}</b><p class="source-history-meta">${escapeHtml(range)} · ${escapeHtml(count)}</p></li>`;
  }).join('');
  const facets = Object.values(item.taxonomy || {}).flat().filter(Boolean);
  const tags = [...new Set([...(item.tags || []), ...facets])].slice(0, 12);
  const repo = product.githubRepo || '';
  const owner = repo.includes('/') ? repo.split('/')[0] : '';
  const name = repo.includes('/') ? repo.split('/').slice(1).join('/') : product.title;
  const kind = repo ? 'SoftwareSourceCode' : 'SoftwareApplication';
  // Same mark fallback chain as the feed rows: platform logo → declared site icon → initials.
  const initials = escapeHtml(text(name).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '·');
  const structured = {
    '@context': 'https://schema.org', '@graph': [
      { '@type': 'WebPage', '@id': canonical, url: canonical, name: title, description, inLanguage: locale,
        dateModified: product.lastSeenDate, isPartOf: { '@id': `${ORIGIN}/#website` }, mainEntity: { '@id': `${canonical}#product` } },
      { '@type': kind, '@id': `${canonical}#product`, name: product.title, description: summary,
        url: canonical, ...(repo ? { codeRepository: `https://github.com/${repo}` } : {}) },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: en ? 'Discover' : '今日发现', item: ORIGIN + localPath('/', locale) },
        { '@type': 'ListItem', position: 2, name: product.title, item: canonical },
      ] },
    ],
  };
  const pageData = { locale, view: 'project', route, date: product.lastSeenDate,
    projectItem: { sourceId: item.sourceId || '', externalId: item.externalId || product.id },
    catalogVersion: model.catalogVersion };
  const commentTerm = repo ? `project:${repo}` : `product:${product.id}`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><meta name="color-scheme" content="light dark"/><meta name="theme-color" content="#f6f6f3"/><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"/><meta name="robots" content="${indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow'}"/><link rel="canonical" href="${escapeHtml(canonical)}"/><link rel="alternate" hreflang="zh-CN" href="${escapeHtml(zhUrl)}"/><link rel="alternate" hreflang="en" href="${escapeHtml(enUrl)}"/><link rel="alternate" hreflang="x-default" href="${escapeHtml(zhUrl)}"/><link rel="alternate" type="application/rss+xml" href="${ORIGIN}${localPath('/feed.xml', locale)}"/><link rel="icon" href="/logo.svg?v=${ASSET_VERSION}" type="image/svg+xml"/><link rel="apple-touch-icon" href="/logo-512.png"/><meta property="og:type" content="website"/><meta property="og:site_name" content="DevTrends"/><meta property="og:title" content="${escapeHtml(title)}"/><meta property="og:description" content="${escapeHtml(description)}"/><meta property="og:url" content="${escapeHtml(canonical)}"/><meta property="og:image" content="${ORIGIN}/og-image.png"/><meta property="og:image:type" content="image/png"/><meta property="og:image:width" content="1200"/><meta property="og:image:height" content="630"/><meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${escapeHtml(title)}"/><meta name="twitter:description" content="${escapeHtml(description)}"/><meta name="twitter:image" content="${ORIGIN}/og-image.png"/><script src="/theme.js?v=${ASSET_VERSION}"></script><link rel="stylesheet" href="/token.css?v=${ASSET_VERSION}"/><link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}"/>${ANALYTICS}<script type="application/ld+json">${json(structured)}</script></head><body data-view="project"><a class="skip-link" href="#main">${en ? 'Skip to content' : '跳到正文'}</a>${D.topbarHtml({ locale, active: 'project', homePath: localPath('/', locale) })}<main id="main" class="workspace"><nav class="breadcrumb"><a href="${localPath('/', locale)}">${en ? 'Discover' : '今日发现'}</a><span>/</span><span>${en ? 'Product details' : '产品详情'}</span></nav><article class="project-hero"><div class="project-identity"><span class="project-mark${mark ? ' has-logo' : ''}" aria-hidden="true">${mark ? `<img src="${escapeHtml(mark)}" class="is-logo" alt="${escapeHtml(product.title)}"/>` : initials}</span><div class="project-heading"><div><p class="project-owner">${escapeHtml(owner || (en ? 'Product' : '产品'))}${owner ? ' /' : ''}</p><h1>${escapeHtml(name)}</h1></div></div></div><p class="project-summary">${escapeHtml(summary)}</p>${tags.length ? `<div class="project-tags">${tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>` : ''}<div class="project-links">${links.map(([label, url], index) => `<a class="button${index === 0 ? ' primary' : ''}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`).join('')}</div></article><div class="project-layout"><div>${gallery}<section class="panel"><h2>${en ? 'About' : '关于'}</h2><p>${escapeHtml(summary)}</p></section><section class="panel"><h2>${en ? 'Discovery history' : '收录记录'}</h2><ol class="timeline source-history">${sourceRows}</ol></section></div><aside class="project-sidebar"><section class="panel"><h2>${en ? 'Catalog facts' : '产品库信息'}</h2><dl class="facts"><div><dt>${en ? 'First seen' : '首次收录'}</dt><dd>${escapeHtml(dateLabel(product.firstSeenDate, locale))}</dd></div><div><dt>${en ? 'Last seen' : '最近收录'}</dt><dd>${escapeHtml(dateLabel(product.lastSeenDate, locale))}</dd></div><div><dt>${en ? 'Sources' : '数据来源'}</dt><dd>${product.sources.length}</dd></div></dl></section></aside></div><section class="comments-panel" data-giscus-comments data-giscus-repo="null-object-0000/devtrends-comments" data-giscus-repo-id="R_kgDOUYgtow" data-giscus-category="Announcements" data-giscus-category-id="DIC_kwDOUYgto84DFetK" data-giscus-term="${escapeHtml(commentTerm)}" data-giscus-lang="${locale}"><div class="comments-heading"><h2>${en ? 'Discuss this product' : '讨论这个产品'}</h2></div><div class="giscus"></div></section></main>${D.footerHtml({ locale, homePath: localPath('/', locale) })}<script id="page-data" type="application/json">${json(pageData)}</script><script src="/shared.js?v=${ASSET_VERSION}" defer></script><script src="/app.js?v=${ASSET_VERSION}" defer></script></body></html>`;
}
