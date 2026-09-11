/**
 * Board registry for 1c7/chinese-independent-developer.
 *
 * The repository publishes three README boards that share the exact same
 * `### YYYY 年 M 月 D 号添加` section format but hold different products:
 *   main       - README.md, 打开即用的网站/App
 *   programmer - .github/pages/README-Programmer-Edition.md, 命令行/开源/开发工具
 *   game       - .github/pages/README-Game.md, 游戏
 *
 * Each board is its own source so the immutable daily record stays one board
 * per file and the site can filter them apart.
 */
const REPOSITORY = '1c7/chinese-independent-developer';
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_START = '2026-01-01';

const BOARDS = {
  main: {
    id: 'main',
    sourceId: 'chinese-indie-dev',
    sourceName: '中国独立开发者',
    // `null` means "the repository README", served by the readme endpoint.
    documentPath: null,
    apiPath: 'readme',
    tag: '',
  },
  programmer: {
    id: 'programmer',
    sourceId: 'chinese-indie-dev-programmer',
    sourceName: '中国独立开发者·程序员版',
    documentPath: '.github/pages/README-Programmer-Edition.md',
    apiPath: 'contents/.github/pages/README-Programmer-Edition.md',
    tag: '程序员版',
  },
  game: {
    id: 'game',
    sourceId: 'chinese-indie-dev-game',
    sourceName: '中国独立开发者·游戏版',
    documentPath: '.github/pages/README-Game.md',
    apiPath: 'contents/.github/pages/README-Game.md',
    tag: '游戏版',
  },
};

const BOARD_IDS = Object.keys(BOARDS);

function resolveBoard(value) {
  const requested = String(value || 'main').trim().toLowerCase();
  const board = Object.prototype.hasOwnProperty.call(BOARDS, requested) ? BOARDS[requested] : null;
  if (!board) throw new Error(`unknown --board: ${value} (expected ${BOARD_IDS.join(' | ')})`);
  return board;
}

function boardBySourceId(sourceId) {
  return BOARD_IDS.map((id) => BOARDS[id]).find((board) => board.sourceId === sourceId) || null;
}

module.exports = { REPOSITORY, TIMEZONE, DEFAULT_START, BOARDS, BOARD_IDS, resolveBoard, boardBySourceId };
