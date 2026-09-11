const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');

// Every source that publishes product media must keep the product mark (`logo`) apart
// from the launch gallery (`images`). These fixtures mirror the two upstream shapes.
function writeDocument(sourceId, date, document) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-media-'));
  fs.mkdirSync(path.join(root, sourceId), { recursive: true });
  fs.writeFileSync(path.join(root, sourceId, `${date}.json`), JSON.stringify({
    schemaVersion: 1, sourceId, targetDate: date, complete: true, status: 'ok', ...document,
  }));
  return root;
}

test('VibeCafé keeps logoUrl as the mark and every imageUrl as an ordered gallery', () => {
  const date = '2026-09-10';
  const root = writeDocument('vibecafe', date, {
    records: [{
      id: 'cmtvjjfho00010agm0ts8ykmy',
      name: 'Lazer — Music that feels like yours',
      createdAt: `${date}T01:00:00Z`,
      logoUrl: 'https://cdn.example/logo.webp',
      imageUrls: ['https://cdn.example/one.png', 'https://cdn.example/two.jpg', 'https://cdn.example/one.png'],
      owner: { handle: 'chuxuehaocai', name: '初雪' },
      websiteUrl: 'https://lazer.app/',
    }],
    detailResponses: [],
  });
  const { items } = loadItems({ id: 'vibecafe' }, { rawRoot: root, date });
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.logo, 'https://cdn.example/logo.webp');
  assert.deepEqual(item.images, ['https://cdn.example/one.png', 'https://cdn.example/two.jpg']);
  assert.equal(item.image, 'https://cdn.example/one.png');
  assert.equal(item.vibecafeId, 'cmtvjjfho00010agm0ts8ykmy');
});

test('Product Hunt maps thumbnail to the logo and media to the gallery', () => {
  const date = '2026-09-10';
  const root = writeDocument('producthunt', date, {
    officialFeatured: {
      filter: { featured: true },
      complete: true,
      records: [{
        id: '1246124',
        name: 'Noodle Seed',
        tagline: 'Connect your business to AI conversations in minutes',
        description: 'Your product in AI.',
        url: 'https://www.producthunt.com/products/noodle-seed',
        createdAt: `${date}T02:00:00Z`,
        votesCount: 120,
        commentsCount: 4,
        thumbnail: { type: 'image', url: 'https://ph-files.imgix.net/logo.png' },
        media: [
          { type: 'image', url: 'https://ph-files.imgix.net/logo.png' },
          { type: 'image', url: 'https://ph-files.imgix.net/one.png' },
          { type: 'video', url: 'https://ph-files.imgix.net/video-cover.png', videoUrl: 'https://youtu.be/example' },
        ],
      }],
    },
  });
  const { items } = loadItems({ id: 'producthunt' }, { rawRoot: root, date });
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.logo, 'https://ph-files.imgix.net/logo.png');
  // The gallery mirrors Product Hunt: the mark is not repeated as a screenshot, and a
  // video contributes its generated cover so the viewer stays image-only.
  assert.deepEqual(item.images, ['https://ph-files.imgix.net/one.png', 'https://ph-files.imgix.net/video-cover.png']);
  assert.equal(item.image, 'https://ph-files.imgix.net/one.png');
});

test('Product Hunt posts captured before the media projection stay imageless', () => {
  const date = '2026-09-10';
  const root = writeDocument('producthunt', date, {
    officialFeatured: {
      filter: { featured: true },
      complete: true,
      records: [{ id: '1', name: 'Legacy Post', createdAt: `${date}T03:00:00Z`, votesCount: 3, commentsCount: 0 }],
    },
  });
  const { items } = loadItems({ id: 'producthunt' }, { rawRoot: root, date });
  assert.equal(items[0].logo, '');
  assert.deepEqual(items[0].images, []);
  assert.equal(items[0].image, '');
});
