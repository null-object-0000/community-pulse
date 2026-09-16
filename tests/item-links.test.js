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