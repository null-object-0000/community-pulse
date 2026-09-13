const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const siteConfig = JSON.parse(fs.readFileSync(path.join(root, 'site.config.json'), 'utf8'));
const repo = siteConfig.comments?.repo;
const output = path.join(root, 'data', 'comment-counts.json');

if (!repo) throw new Error('site.config.json is missing comments.repo');

function authToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function fetchDiscussions() {
  const token = authToken();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'DevTrends-comment-count-sync',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const discussions = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repo}/discussions?per_page=100&page=${page}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub Discussions request failed (${response.status}): ${detail}`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub Discussions returned an unexpected response');
    discussions.push(...batch);
    if (batch.length < 100) break;
  }
  return discussions;
}

(async () => {
  const discussions = await fetchDiscussions();
  const counts = {};
  for (const discussion of discussions) {
    if (typeof discussion.title !== 'string' || !/^report:\d{4}-\d{2}-\d{2}$/.test(discussion.title)) continue;
    counts[discussion.title] = Number.isInteger(discussion.comments) && discussion.comments >= 0 ? discussion.comments : 0;
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify({ repo, counts: sorted }, null, 2)}\n`);
  console.log(`Synced ${Object.keys(sorted).length} report discussion counts from ${repo}.`);
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
