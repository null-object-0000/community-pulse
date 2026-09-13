const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../web/shared.js');
const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');
const { lastRejectsFuture, rejectsHistorical } = require('../.agents/skills/community-pulse/scripts/capture_v2ex_raw.js');

const ROOT = path.join(__dirname, '..');
const CP = path.join(ROOT, '.agents', 'skills', 'community-pulse');
const SOURCE_RAW = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');
const CONFIG = require(path.join(CP, 'config', 'sources.json'));

function sourceConfig(id) {
  const found = CONFIG.sources.find((source) => source.id === id);
  assert.ok(found, `${id} must be registered in config/sources.json`);
  return found;
}

function writeDocument(sourceId, date, document) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-new-src-'));
  fs.mkdirSync(path.join(root, sourceId), { recursive: true });
  fs.writeFileSync(path.join(root, sourceId, `${date}.json`), JSON.stringify({
    schemaVersion: 1, sourceId, targetDate: date, complete: true, status: 'ok', ...document,
  }));
  return root;
}

const SHOWHN_DOC = {
  sourceId: 'showhn',
  itemCount: 2,
  records: [
    {
      objectID: '42575841', title: 'Show HN: connet – A P2P reverse proxy',
      url: 'https://github.com/connet-dev/connet', author: 'Ingon',
      createdAt: '2026-01-02T16:27:08Z', points: 130, comments: 29,
      storyText: 'Over the past months I built <b>connet</b>.',
      hnUrl: 'https://news.ycombinator.com/item?id=42575841',
    },
    {
      objectID: '42575000', title: 'Show HN: A text-only launch',
      url: 'https://news.ycombinator.com/item?id=42575000', author: 'someone',
      createdAt: '2026-01-02T09:00:00Z', points: 4, comments: 0,
      storyText: '', hnUrl: 'https://news.ycombinator.com/item?id=42575000',
    },
  ],
};

const V2EX_DOC = {
  sourceId: 'v2ex',
  itemCount: 2,
  records: [
    {
      topicId: 1241693, title: '做了个小工具：丢个 HuggingFace 链接进去，自动打出本地模型懒人包',
      url: 'https://www.v2ex.com/t/1241693', author: 'novel',
      createdAt: '2026-09-13T11:31:21.000Z', replies: 3,
      content: '介绍一下 <b>实现思路</b>。', nodeName: 'create',
    },
    {
      topicId: 1241692, title: '原创了一个 Agent + Skill + Toolkit 的 AI 客服工作台',
      url: 'https://www.v2ex.com/t/1241692', author: 'maker',
      createdAt: '2026-09-13T09:00:00Z', replies: 0, content: '', nodeName: 'create',
    },
  ],
};

test('Show HN and V2EX are registered sources with converter and site wiring', () => {
  for (const id of ['showhn', 'v2ex']) {
    sourceConfig(id);
    const label = D.sourceName({ sourceId: id }, 'zh-CN');
    assert.ok(label && label !== id, `${id} needs a site label`);
    assert.ok(D.sourceName({ sourceId: id }, 'en'), `${id} needs an English label`);
    const info = D.sourceInfo({ sourceId: id });
    assert.ok(info && info.url, `${id} needs a source-directory entry`);
    assert.match(info.logo, /^\/source-.+\.svg$/);
    assert.ok(fs.existsSync(path.join(ROOT, 'web', info.logo.replace(/^\//, ''))), `${id} logo file must exist`);
  }
  // The site's own source registry must not advertise a source the pipeline lacks.
  const ids = CONFIG.sources.filter((source) => source.enabled).map((source) => source.id);
  for (const id of ids) {
    assert.ok(D.sourceName({ sourceId: id }, 'zh-CN') !== id, `${id} is enabled but has no site label`);
    assert.ok(D.sourceInfo({ sourceId: id })?.logo, `${id} is enabled but has no source-directory logo`);
  }
});

test('Show HN items carry points/comments and keep the story link separate from the HN thread', () => {
  const root = writeDocument('showhn', '2026-01-02', SHOWHN_DOC);
  const loaded = loadItems(sourceConfig('showhn'), { date: '2026-01-02', rawRoot: root });
  assert.equal(loaded.items.length, 2);
  const [first, second] = loaded.items;
  assert.equal(first.title, 'Show HN: connet – A P2P reverse proxy');
  assert.equal(first.url, 'https://github.com/connet-dev/connet');
  assert.equal(first.hnUrl, 'https://news.ycombinator.com/item?id=42575841');
  assert.deepEqual(first.metrics, { points: 130, comments: 29 });
  assert.equal(first.author, 'Ingon');
  assert.equal(first.publishedAt, '2026-01-02T16:27:08Z');
  assert.equal(first.summary, 'Over the past months I built connet .');
  assert.deepEqual(first.tags, ['showhn']);
  // A story without its own URL falls back to the HN thread, not to an empty link.
  assert.equal(second.url, 'https://news.ycombinator.com/item?id=42575000');
});

test('V2EX items expose the topic thread and its reply count', () => {
  const root = writeDocument('v2ex', '2026-09-13', V2EX_DOC);
  const loaded = loadItems(sourceConfig('v2ex'), { date: '2026-09-13', rawRoot: root });
  assert.equal(loaded.items.length, 2);
  const [first] = loaded.items;
  assert.equal(first.url, 'https://www.v2ex.com/t/1241693');
  assert.equal(first.authorUrl, 'https://www.v2ex.com/member/novel');
  assert.deepEqual(first.metrics, { replies: 3 });
  assert.equal(first.externalId, '1241693');
  assert.equal(first.summary, '介绍一下 实现思路 。');
});

test('both sources hide their scaffolding tags from the visible chip row', () => {
  const root = writeDocument('showhn', '2026-01-02', SHOWHN_DOC);
  const loaded = loadItems(sourceConfig('showhn'), { date: '2026-01-02', rawRoot: root });
  for (const item of loaded.items) {
    const labels = D.visibleTags(item, 'zh-CN').map((value) => String(value).toLowerCase());
    // The source tag repeats what the badge and source column already say, so it must not
    // become a chip. Inferred taxonomy chips are expected and are not what this guards.
    assert.ok(!labels.includes('showhn'), 'the source tag must not render as a chip');
    assert.ok(!labels.includes('hackernews'), 'source aliases must not render as chips');
  }
  const v2root = writeDocument('v2ex', '2026-09-13', V2EX_DOC);
  const v2 = loadItems(sourceConfig('v2ex'), { date: '2026-09-13', rawRoot: v2root });
  for (const item of v2.items) {
    const labels = D.visibleTags(item, 'zh-CN').map((value) => String(value).toLowerCase());
    assert.ok(!labels.includes('v2ex') && !labels.includes('create'),
      'neither the source tag nor the node name may render as a chip');
  }
});

test('Show HN titles drop the "Show HN:" label but V2EX titles keep their prose', () => {
  assert.equal(D.displayTitle({ title: 'Show HN: connet – A P2P reverse proxy' }, 'en'), 'connet – A P2P reverse proxy');
  assert.equal(D.displayTitle({ title: 'Show HN: A text-only launch' }, 'en'), 'A text-only launch');
  const v2exTitle = '做了个小工具：丢个 HuggingFace 链接进去，自动打出本地模型懒人包';
  assert.equal(D.displayTitle({ title: v2exTitle }, 'zh-CN'), v2exTitle);
});

test('V2EX cannot be backfilled and the capture script refuses earlier days', () => {
  assert.equal(sourceConfig('v2ex').daily_filter, false);
  assert.equal(sourceConfig('showhn').daily_filter, undefined);
  // The live V2EX API has no date parameter, so a file is only ever an observation.
  assert.equal(rejectsHistorical('2026-01-15', '2026-09-13'), true);
  assert.equal(rejectsHistorical('2026-09-13', '2026-09-13'), false);
  assert.equal(lastRejectsFuture('2026-09-14', '2026-09-13'), true);
  assert.equal(lastRejectsFuture('2026-09-13', '2026-09-13'), false);
});

test('the new sources are wired into the daily workflow with capture and validate steps', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'daily-report.yml'), 'utf8');
  assert.match(workflow, /capture_showhn_raw\.js/, 'Show HN capture must run in the daily workflow');
  assert.match(workflow, /validate_showhn_raw\.js/, 'Show HN validation must run in the daily workflow');
  assert.match(workflow, /capture_v2ex_raw\.js/, 'V2EX capture must run in the daily workflow');
  assert.match(workflow, /validate_v2ex_raw\.js/, 'V2EX validation must run in the daily workflow');
});
