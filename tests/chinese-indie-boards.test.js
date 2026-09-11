const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../web/shared.js');
const { loadItems } = require('../.agents/skills/community-pulse/scripts/source_raw_items.js');
const {
  REPOSITORY, BOARD_IDS, BOARDS, resolveBoard, boardBySourceId,
} = require('../.agents/skills/community-pulse/scripts/chinese_indie_boards.js');

const ROOT = path.join(__dirname, '..');
const SOURCE_RAW = path.join(ROOT, '知识', '大家都在做什么', 'source-raw');
const FIXTURE = [
  '### 2026 年 9 月 10 号添加',
  '',
  '#### Felicia - [Github](https://github.com/littlePig-zzf)',
  '* :white_check_mark: [Narinig Mo Ba? Fan Guide](https://narinigmoba.app/)：攻略站（免费）',
  '',
].join('\n');

function readDaily(sourceId, date) {
  return JSON.parse(fs.readFileSync(path.join(SOURCE_RAW, sourceId, `${date}.json`), 'utf8'));
}

function writeDocument(sourceId, date, document) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-indie-'));
  fs.mkdirSync(path.join(root, sourceId), { recursive: true });
  fs.writeFileSync(path.join(root, sourceId, `${date}.json`), JSON.stringify({
    schemaVersion: 1, sourceId, targetDate: date, complete: true, status: 'ok', ...document,
  }));
  return root;
}

test('the three chinese-independent-developer boards are wired from registry to site labels', () => {
  assert.deepEqual(BOARD_IDS, ['main', 'programmer', 'game']);
  const registry = JSON.parse(fs.readFileSync(
    path.join(ROOT, '.agents', 'skills', 'community-pulse', 'config', 'sources.json'), 'utf8',
  )).sources;
  for (const board of Object.values(BOARDS)) {
    const source = registry.find((entry) => entry.id === board.sourceId);
    assert.ok(source, `${board.sourceId} missing from config/sources.json`);
    assert.equal(source.enabled, true, `${board.sourceId} is disabled`);
    // The site drops a row back to an initials badge and a raw sourceName when either map misses the id.
    assert.ok(D.sourceInfo({ sourceId: board.sourceId }), `${board.sourceId} missing from sourceDirectory`);
    assert.notEqual(D.sourceName({ sourceId: board.sourceId }, 'zh-CN'), board.sourceId, `${board.sourceId} missing from sourceLabels`);
    assert.equal(boardBySourceId(board.sourceId), board);
    // Only the main board is the repository README; the sub-boards are separate page files.
    if (board.id === 'main') assert.equal(board.documentPath, null);
    else assert.match(board.documentPath, /^\.github\/pages\/README-[A-Za-z-]+\.md$/);
  }
  assert.equal(resolveBoard('programmer'), BOARDS.programmer);
  assert.equal(resolveBoard(''), BOARDS.main);
  assert.throws(() => resolveBoard('archive'), /unknown --board/);
});

test('every board parses the same dated section into items tagged with its own board', () => {
  const date = '2026-09-10';
  for (const board of Object.values(BOARDS)) {
    const root = writeDocument(board.sourceId, date, { sectionMarkdown: FIXTURE });
    const { items, sourceRaw } = loadItems({ id: board.sourceId }, { rawRoot: root, date });
    assert.equal(items.length, 1, board.sourceId);
    assert.equal(sourceRaw.sourceId, board.sourceId);
    assert.equal(items[0].title, 'Narinig Mo Ba? Fan Guide');
    assert.equal(items[0].author, 'Felicia');
    assert.equal(items[0].publishedAt, `${date}T00:00:00+08:00`);
    // The board tag is the only difference between the three otherwise identical sources.
    assert.deepEqual(items[0].tags, ['indie-dev', '已上线', ...(board.tag ? [board.tag] : [])], board.sourceId);
  }
});

test('the main board keeps the legacy readme capture keys while sub-board files use the document keys', () => {
  // 2026-09-05 was captured before the board refactor: only the readme* keys exist.
  const legacy = readDaily('chinese-indie-dev', '2026-09-05');
  assert.equal(legacy.repository, REPOSITORY);
  assert.equal(legacy.capture.readmePath, 'README.md');
  assert.ok(legacy.capture.readmeSha);
  assert.equal(legacy.capture.documentSha, undefined);
  // Every main-board file keeps readmeSha, so a reader that only knows the old key never breaks.
  const current = readDaily('chinese-indie-dev', '2026-09-10');
  assert.ok(current.capture.readmeSha);
  const sub = readDaily('chinese-indie-dev-game', '2026-09-10');
  assert.equal(sub.capture.board, 'game');
  assert.equal(sub.capture.documentPath, '.github/pages/README-Game.md');
  assert.ok(sub.capture.documentSha);
  assert.equal(sub.capture.readmeSha, undefined);
});
