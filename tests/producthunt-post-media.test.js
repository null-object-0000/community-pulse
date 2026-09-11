const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', '.agents', 'skills', 'community-pulse', 'scripts');
const { neededIdsByDay, postMediaQuery } = require(path.join(SKILL, 'capture_producthunt_post_media.js'));
const { mediaByPost } = require(path.join(SKILL, 'backfill_producthunt_media.js'));

const DATE = '2026-02-02';
const BASE_FIELDS = ['id', 'name', 'tagline', 'url', 'createdAt', 'description'];
const MEDIA_FIELDS = [...BASE_FIELDS, 'thumbnail', 'media'];

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function post(id, extra = {}) {
  return {
    id,
    name: `Post ${id}`,
    tagline: 'tagline',
    url: `https://www.producthunt.com/posts/post-${id}`,
    createdAt: `${DATE}T03:00:00Z`,
    description: 'description',
    ...extra,
  };
}

function pagination(count, fields) {
  return {
    id: 'capture-1',
    endpoint: 'https://api.producthunt.com/v2/api/graphql',
    apiVersion: 'v2 GraphQL',
    sourceFields: fields,
    order: 'NEWEST',
    pageSize: 20,
    pageCount: 1,
    returnedEdgeCount: count,
    reportedTotalCount: count,
    uniqueReturnedCount: count,
    duplicateEdgeCount: 0,
    passCount: 1,
    excludedAdjacentDayCount: 0,
    stoppedBecause: 'hasNextPage=false',
    pages: [{ number: 1, hasNextPage: false, returnedEdgeCount: count, acceptedRecordCount: count }],
  };
}

// Minimal document that satisfies validate_producthunt_raw.js: one day, two
// posts in the full sweep, one of them officially featured.
function validDocument({ recordMedia } = {}) {
  const records = [post('101'), post('102')];
  const featured = [post('102', {
    thumbnail: { type: 'image', url: 'https://ph-files.imgix.net/featured.png' },
    media: [{ type: 'image', url: 'https://ph-files.imgix.net/shot.png' }],
  })];
  const document = {
    schemaVersion: 1,
    sourceId: 'producthunt',
    sourceName: 'Product Hunt 新品',
    targetDate: DATE,
    timezone: 'Asia/Shanghai',
    status: 'ok',
    complete: true,
    itemCount: records.length,
    contentSha256: digest(records),
    fetchedAt: `${DATE}T04:00:00.000Z`,
    capture: pagination(records.length, BASE_FIELDS),
    officialFeatured: {
      filter: { featured: true },
      complete: true,
      itemCount: featured.length,
      contentSha256: digest(featured),
      fetchedAt: `${DATE}T04:00:00.000Z`,
      capture: pagination(featured.length, MEDIA_FIELDS),
      records: featured,
    },
    records,
  };
  if (recordMedia) document.recordMedia = recordMedia;
  return document;
}

function writeFixture(document) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-record-media-'));
  fs.writeFileSync(path.join(root, `${DATE}.json`), `${JSON.stringify(document, null, 2)}\n`);
  return root;
}

function runValidator(root) {
  try {
    const stdout = execFileSync('node', [
      path.join(SKILL, 'validate_producthunt_raw.js'),
      '--root', root, '--start', DATE, '--end', DATE,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

test('Product Hunt day files without recordMedia still validate', () => {
  const result = runValidator(writeFixture(validDocument()));
  assert.equal(result.code, 0, result.stderr);
});

test('recordMedia accepts by-ID media that is attributable to the day records', () => {
  const recordMedia = {
    fetchedAt: `${DATE}T05:00:00.000Z`,
    endpoint: 'https://api.producthunt.com/v2/api/graphql',
    apiVersion: 'v2 GraphQL',
    sourceFields: ['id', 'thumbnail', 'media'],
    requestedCount: 1,
    itemCount: 1,
    failureCount: 0,
    complete: true,
    contentSha256: '',
    records: [{
      id: '101',
      thumbnail: { type: 'image', url: 'https://ph-files.imgix.net/legacy.png' },
      media: [{ type: 'image', url: 'https://ph-files.imgix.net/legacy-shot.png' }],
      error: null,
    }],
  };
  recordMedia.contentSha256 = digest(recordMedia.records);
  const result = runValidator(writeFixture(validDocument({ recordMedia })));
  assert.equal(result.code, 0, result.stderr);
});

test('recordMedia rejects ids that the day records do not contain', () => {
  const recordMedia = {
    fetchedAt: `${DATE}T05:00:00.000Z`,
    endpoint: 'https://api.producthunt.com/v2/api/graphql',
    apiVersion: 'v2 GraphQL',
    sourceFields: ['id', 'thumbnail', 'media'],
    requestedCount: 1,
    itemCount: 1,
    failureCount: 0,
    complete: true,
    contentSha256: '',
    records: [{ id: '999', thumbnail: null, media: null, error: null }],
  };
  recordMedia.contentSha256 = digest(recordMedia.records);
  const result = runValidator(writeFixture(validDocument({ recordMedia })));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /recordMedia 999 is absent from the day's records/);
});

test('recordMedia rejects a tampered hash and a missing media key', () => {
  const recordMedia = {
    fetchedAt: `${DATE}T05:00:00.000Z`,
    endpoint: 'https://api.producthunt.com/v2/api/graphql',
    apiVersion: 'v2 GraphQL',
    sourceFields: ['id', 'thumbnail', 'media'],
    requestedCount: 1,
    itemCount: 1,
    failureCount: 0,
    complete: true,
    contentSha256: 'deadbeef',
    records: [{ id: '101', error: null }],
  };
  const result = runValidator(writeFixture(validDocument({ recordMedia })));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /recordMedia hash mismatch/);
  assert.match(result.stderr, /recordMedia 101 missing thumbnail/);
});

test('neededIdsByDay only plans rows outside the featured subset, attributable to that day', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-plan-'));
  fs.mkdirSync(path.join(root, 'raw'));
  fs.mkdirSync(path.join(root, 'source'));
  fs.writeFileSync(path.join(root, 'source', `${DATE}.json`), JSON.stringify(validDocument()));
  fs.writeFileSync(path.join(root, 'raw', `${DATE}.json`), JSON.stringify({
    date: DATE,
    results: [{
      sourceId: 'producthunt',
      items: [
        { sourceId: 'producthunt', externalId: '101' }, // legacy row, in records
        { sourceId: 'producthunt', externalId: '102' }, // officially featured
        { sourceId: 'producthunt', externalId: '999' }, // not attributable
      ],
    }],
  }));
  const plan = neededIdsByDay(DATE, DATE, {
    sourceRoot: path.join(root, 'source'),
    rawRoot: path.join(root, 'raw'),
  });
  assert.deepEqual(plan.needed.get(DATE), ['101']);
  assert.deepEqual(plan.unattributable, [{ date: DATE, id: '999' }]);
  assert.equal(plan.referenced, 3);
});

test('the by-ID query selects thumbnail and media subfields, never bare fields', () => {
  const query = postMediaQuery('101');
  // Product Hunt rejects a Media field without selections (selectionMismatch),
  // which is exactly how the first production run failed.
  assert.match(query, /post\(id: "101"\)/);
  assert.match(query, /thumbnail \{ type url \}/);
  assert.match(query, /media \{ type url videoUrl \}/);
  assert.doesNotMatch(query, /^\s*thumbnail\s*$/m);
  assert.doesNotMatch(query, /^\s*media\s*$/m);
});

test('backfill prefers the featured projection and falls back to recordMedia', () => {
  const document = validDocument({
    recordMedia: {
      records: [
        { id: '101', thumbnail: { url: 'https://ph-files.imgix.net/legacy.png' }, media: [{ url: 'https://ph-files.imgix.net/legacy-shot.png' }], error: null },
        { id: '102', thumbnail: { url: 'https://ph-files.imgix.net/wrong.png' }, media: null, error: null },
        { id: '103', thumbnail: null, media: null, error: 'post not found' },
      ],
    },
  });
  const media = mediaByPost(document);
  assert.deepEqual(media.get('101'), {
    logo: 'https://ph-files.imgix.net/legacy.png',
    images: ['https://ph-files.imgix.net/legacy-shot.png'],
  });
  // Featured wins: the recordMedia entry for a featured post is ignored.
  assert.deepEqual(media.get('102'), {
    logo: 'https://ph-files.imgix.net/featured.png',
    images: ['https://ph-files.imgix.net/shot.png'],
  });
  // Failed by-ID rows never masquerade as media.
  assert.equal(media.get('103'), undefined);
});
