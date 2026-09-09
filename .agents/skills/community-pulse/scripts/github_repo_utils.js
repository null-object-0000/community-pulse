/** Shared, offline GitHub repository URL discovery and normalization. */

const REPO_URL_RE = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+[^\s)\]"']*/gi;
const RESERVED_OWNERS = new Set([
  'features', 'marketplace', 'orgs', 'organizations', 'settings', 'site',
  'sponsors', 'topics', 'trending', 'user-attachments', 'users',
]);
// github.com/owner/repo 后面若还跟着子路径（issue/PR/树/文件/发布等页），不是仓库主页。
const NON_REPO_SUBPATH = /\/(?:issues|pull|pulls|tree|blob|releases|commits|actions|discussions|wiki|security|pulse|network|forks|watchers|stargazers|tags|branches|packages|projects|settings)(?:\/|$)/i;

function normalizeGitHubRepoUrl(value) {
  if (!value) return '';
  const text = String(value).replace(/\\\//g, '/');
  const match = text.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (!match) return '';
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '').replace(/[),.;'"]+$/, '');
  if (!owner || !repo || RESERVED_OWNERS.has(owner.toLowerCase())) return '';
  // 若 repo 后面还跟子路径段（如 /issues/123），这是页面而非仓库主页，排除。
  const rest = text.slice(match[0].length);
  if (NON_REPO_SUBPATH.test(rest)) return '';
  return `https://github.com/${owner}/${repo}`;
}

function extractGitHubRepoUrls(...values) {
  const urls = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const text = String(value).replace(/\\\//g, '/');
    for (const match of text.matchAll(REPO_URL_RE)) {
      const url = normalizeGitHubRepoUrl(match[0]);
      if (!url || seen.has(url.toLowerCase())) continue;
      seen.add(url.toLowerCase());
      urls.push(url);
    }
  }
  return urls;
}

function discoverItemRepository(item) {
  const preferred = [
    item.githubUrl,
    item.websiteUrl,
    ...(item.productLinks || []).map((link) => link?.url),
  ];
  for (const value of preferred) {
    const url = normalizeGitHubRepoUrl(value);
    if (url) return url;
  }
  const embedded = extractGitHubRepoUrls(item.content, item.summary)[0];
  if (embedded) return embedded;
  // A GitHub issue is the submission envelope, not necessarily the submitted
  // project. Do not mistake its owner/repository for the product repository.
  if (item.issueUrl && String(item.url || '') === String(item.issueUrl)) return '';
  return normalizeGitHubRepoUrl(item.url);
}

function repositoryKey(value) {
  const url = normalizeGitHubRepoUrl(value);
  return url ? url.slice('https://github.com/'.length).toLowerCase() : '';
}

module.exports = {
  discoverItemRepository,
  extractGitHubRepoUrls,
  normalizeGitHubRepoUrl,
  repositoryKey,
};
