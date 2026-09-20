/**
 * 产品身份：把一行内容归一成一个稳定的 canonical key，再哈希成 product_id。
 *
 * **这是全站唯一一份身份实现**，四条链路共用：采集归一（collect）、LLM 增强（enhance）、
 * 产品库导入（build-mysql-import）与站点构建（build-site）。放在技能层而不是 scripts/catalog/
 * 是因为前两条链路在技能里，而 catalog 本来就依赖技能（反向依赖会成环）；`scripts/catalog/identity.js`
 * 现在只是这里的转发，保持既有 require 路径不变。
 *
 * 为什么必须共用一份：2026-09-18 修投稿实体识别时发现，「日报行的地址」和「产品库行的身份」
 * 是两条独立推导 —— 同一行在日报上指向 A 仓库、在产品库里是 B 仓库，两边都不报错。
 * 报告行带上这里算出的 productId 之后，这种漂移才有办法被门禁发现。
 */
const crypto = require('crypto');
const D = require('../../../../web/shared.js');

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
