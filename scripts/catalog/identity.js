const crypto = require('crypto');
const D = require('../../web/shared.js');

function normalizedWebUrl(value) {
  const safe = D.safeUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  url.hostname = url.hostname.toLowerCase();
  return url.href.replace(/\/$/, '').toLowerCase();
}

function identitiesFor(item) {
  const identities = [];
  const repository = D.repository(item);
  if (repository) {
    identities.push({
      canonicalKey: `github:${repository.key}`,
      kind: 'github',
      normalizedValue: repository.key,
      displayValue: repository.url,
      canonicalUrl: repository.url,
      githubRepo: repository.key,
    });
  }

  const website = normalizedWebUrl(item.websiteUrl || item.url);
  let sourceHost = '';
  let sourcePath = '';
  if (website) {
    const parsed = new URL(website);
    sourceHost = parsed.hostname.replace(/^www\./, '');
    sourcePath = parsed.pathname;
  }
  const isSourcePage = website && (
    sourceHost === 'producthunt.com'
    || sourceHost === 'news.ycombinator.com'
    || sourceHost === 'v2ex.com'
    || (sourceHost === 'vibecafe.ai' && sourcePath.startsWith('/products/'))
  );
  if (website && !isSourcePage) {
    identities.push({
      canonicalKey: `url:${website}`,
      kind: 'url',
      normalizedValue: website,
      displayValue: item.websiteUrl || item.url,
      canonicalUrl: item.websiteUrl || item.url,
      githubRepo: '',
    });
  }

  const externalId = String(item.externalId || item.url || item.title || 'untitled').trim();
  const normalized = `${item.sourceId || 'unknown'}:${externalId}`.toLowerCase();
  identities.push({
    canonicalKey: `source:${normalized}`,
    kind: 'source',
    normalizedValue: normalized,
    displayValue: externalId,
    canonicalUrl: item.websiteUrl || item.url || '',
    githubRepo: '',
  });
  return identities;
}

function identityFor(item) {
  return identitiesFor(item)[0];
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function productId(identity) {
  return stableId('prd', identity.canonicalKey);
}

function sourceItemId(sourceId, externalId) {
  return stableId('src', `${sourceId}\u0000${externalId}`);
}

module.exports = { normalizedWebUrl, identitiesFor, identityFor, stableId, productId, sourceItemId };
