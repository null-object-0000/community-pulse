const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../web/shared.js');

const byKey = (links, key) => links.find(([label]) => label === key)?.[1] || '';

test('a GitHub product sends 官网 to its declared site and 来源 to the board that listed it', () => {
  // The shape that exposed the bug: a board item keeps the product link in `url`, so the old
  // `|| item.url` source fallback repeated 官网, and the catalogue's canonical URL (the repository)
  // was used as the website.
  const links = D.itemLinks({
    sourceId: 'chinese-indie-dev', title: 'hippoxOS', url: 'https://hippoxos.vercel.app/',
    githubUrl: 'https://github.com/HippoxHQ/hippoxOS', github: { homepage: 'https://hippoxos.vercel.app' },
  });
  assert.deepEqual(links, [
    ['repository', 'https://github.com/hippoxhq/hippoxos'],
    ['website', 'https://hippoxos.vercel.app/'],
    ['source', 'https://github.com/1c7/chinese-independent-developer'],
  ]);
});

test('来源 never repeats the website or the repository', () => {
  // Trending stores the repository in `url`; the owner casing differs from the lowercased repository
  // identity, so a byte comparison used to publish the same GitHub page twice.
  assert.deepEqual(D.itemLinks({ sourceId: 'github-trending', url: 'https://github.com/Homebrew/BrewUI', githubUrl: 'https://github.com/Homebrew/BrewUI' }), [
    ['repository', 'https://github.com/homebrew/brewui'],
    ['source', 'https://github.com/trending'],
  ]);
  // Alone on a board, the product's own site must not double as its source.
  assert.deepEqual(D.itemLinks({ sourceId: 'chinese-indie-dev', url: 'https://picpermit.com/' }), [
    ['website', 'https://picpermit.com/'],
    ['source', 'https://github.com/1c7/chinese-independent-developer'],
  ]);
});

test('an item that carries its own thread links the thread instead of the board', () => {
  const showhn = D.itemLinks({
    sourceId: 'showhn', url: 'https://github.com/a/b', githubUrl: 'https://github.com/a/b',
    github: { homepage: 'https://b.dev/' }, hnUrl: 'https://news.ycombinator.com/item?id=1',
  });
  assert.equal(byKey(showhn, 'website'), 'https://b.dev/');
  assert.equal(byKey(showhn, 'source'), 'https://news.ycombinator.com/item?id=1');

  const submission = D.itemLinks({
    sourceId: 'weekly-issues', url: 'https://github.com/a/b', githubUrl: 'https://github.com/a/b',
    issueUrl: 'https://github.com/ruanyf/weekly/issues/1',
  });
  assert.equal(byKey(submission, 'source'), 'https://github.com/ruanyf/weekly/issues/1');

  const vibecafe = D.itemLinks({ sourceId: 'vibecafe', url: 'https://site.dev/', vibecafeUrl: 'https://vibecafe.ai/products/x' });
  assert.equal(byKey(vibecafe, 'source'), 'https://vibecafe.ai/products/x');
});

test('a repository with no declared website publishes no 官网 rather than the repository twice', () => {
  const links = D.itemLinks({ sourceId: 'github-trending', title: 'BrewUI', url: 'https://github.com/Homebrew/BrewUI', githubUrl: 'https://github.com/Homebrew/BrewUI' });
  assert.equal(byKey(links, 'website'), '');
  assert.equal(links.filter(([, url]) => url.startsWith('https://github.com/Homebrew')).length, 0);
});
// 投稿正文里的 markdown 装饰会漏进地址（`**https://seichigo.com**` → host `seichigo.com**`），
// 而 `new URL()` 接受它，所以「官网」按钮照常渲染、点开才失败。数据层已经剥掉了（bareUrls），
// 这里是第二道：host 不像 host 就不渲染成链接。
test('a host that cannot resolve is never published as a link', () => {
  assert.equal(D.safeUrl('https://seichigo.com**'), '');
  assert.equal(D.safeUrl('https://createvision.ai)'), '');
  assert.equal(D.itemLinks({ sourceId: 'weekly-issues', url: 'https://seichigo.com**', issueUrl: 'https://github.com/ruanyf/weekly/issues/11845' })
    .find(([label]) => label === 'website'), undefined);
  // 正常形状照旧：IDN 到这里已经是 punycode，IPv6 保留方括号，下划线主机在实践中存在。
  assert.equal(D.safeUrl('https://例え.jp/a'), 'https://xn--r8jz45g.jp/a');
  assert.equal(D.safeUrl('https://[::1]/x'), 'https://[::1]/x');
  assert.equal(D.safeUrl('https://foo_bar.example.com/x'), 'https://foo_bar.example.com/x');
  assert.equal(D.safeUrl('https://www.cs.huji.ac.il/~shais/x'), 'https://www.cs.huji.ac.il/~shais/x');
});
