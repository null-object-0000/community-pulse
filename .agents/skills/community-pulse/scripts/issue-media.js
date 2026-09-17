/**
 * 投稿类 Issue 正文 → 产品插图。
 *
 * 投稿人自己在正文里贴的图（`<img src>` 与 markdown `![]()`）是这个产品最真实的展示图，
 * 以前被整段丢掉：只有平台自带媒体的来源（VibeCafé 的 `imageUrls`、Product Hunt 的 `media`）
 * 才有插图集，投稿行只能等我们去截官网首屏。这里把它们按正文顺序取出来，作为「原始配图」
 * 层挂到行上 —— 与 `web/shared.js` 的 `mediaEntries` 优先级一致（原始配图 → 官网截图 → OG 图），
 * 所以投稿行现在会先用作者自己选的图当封面与灯箱第一张。
 *
 * 两条边界：
 * ① 只收**页面渲染得出来**的地址。`D.hotlinkable` 是图片白名单的唯一实现（浏览器、Worker、
 *    构建期都在用它）——收进来又渲染不了的图会让构建直接报错（`scripts/image-store.js` 的
 *    `localizeUrl` 对未镜像且不可回源的地址抛错）。所以非 GitHub 图床的长尾（imgur、各类
 *    对象存储）这一版先不收，等它们有了镜像通道再放进来。
 * ② 徽章不是插图：README 风格的正文里混着 shields.io / GitHub Actions 这类动态徽章，
 *    按 host 与文件名剔除。
 *
 * 纯函数、无网络 I/O；离线语料走查见 `validate_issue_media.js`。
 */
const D = require('../../../../web/shared.js');

const IMAGE_TAG = /<img\b[^>]*>/gi;
// 属性名前必须是空白，否则 `data-src` 会被当成 `src`（它常指向懒加载占位图）。
const SRC_ATTR = /(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
// `![alt](url)` 与 `![alt](<url>)`；URL 在第一个空白或 `)` 处结束。
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))/g;

// 徽章图床：这些 host 上的图是构建状态/覆盖率/下载量，不是产品插图。
// github.com 不在这里 —— 它整站不是图床，只有附件路径是图片，由 shared.js 的路径白名单判定。
const BADGE_HOSTS = new Set([
  'img.shields.io', 'shields.io', 'badgen.net', 'badge.fury.io', 'badges.gitter.im',
  'codecov.io', 'coveralls.io', 'travis-ci.org', 'travis-ci.com', 'api.codacy.com',
  'app.codacy.com', 'snyk.io', 'img.badgesize.io', 'packagephobia.now.sh', 'bundlephobia.com',
  'david-dm.org', 'isitmaintained.com', 'opencollective.com', 'cirrus-ci.org', 'scrutinizer-ci.com',
]);
// 仓库自己托管的徽章文件（`assets/badge.svg`）与 GitHub Actions 徽章路径。
const BADGE_PATH = /(?:^|\/)(?:badge|badges|shield|shields|coverage)\.(?:svg|png|webp|jpe?g|gif)$|\/actions\/workflows\//i;

const MAX_IMAGES = 9;

const decodeAmp = (value) => String(value || '').replace(/&amp;/g, '&');

function imageSrc(tag) {
  const attr = tag.match(SRC_ATTR);
  return decodeAmp(attr?.[1] ?? attr?.[2] ?? attr?.[3] ?? '').trim();
}

/** 地址能不能进插图集：是 http(s)、不是徽章、并且页面渲染得出来（白名单唯一口径在 shared.js）。 */
function usableIssueImage(value) {
  if (!/^https?:\/\//i.test(value)) return false;   // data: / 相对路径 / 协议相对都不收
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (BADGE_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  if (BADGE_PATH.test(parsed.pathname)) return false;
  return Boolean(D.hotlinkable(value));
}

// 历史简介里的图片残骸：旧清洗只删了图片的 URL，把壳留在了简介里 ——
//   `<img width="3612" height="1898" alt="Image" src=" />`  标签去掉链接后剩下的残骸
//   `!Image` / `!截图` / `![推广图]`                         markdown 图片去掉链接后剩下的 alt 文字
// 只删残骸本身，**不重算历史简介**：历史行是当时的解析规则产出的，用今天的规则重算会顺带改写
// 大量与图片无关的行（实测同一批正文重算约有一半的行会变，其中多数是措辞细节），超出这次修复
// 的范围。新日报走的是 descriptionFromIssue，本来就不会产生残骸。
const IMG_TAG = /<img\b[^>]*\/?>/gi;
const IMG_TAIL = /<img\b[^>]*?\bsrc\s*=\s*"[\s/]*/gi;
const MD_IMAGE = /!\[[^\]]{0,30}\]\([^)]*\)/g;
// `!` 后面紧跟非空白、且后面是空白/结尾/中文的短 token，是 alt 文字残骸；正常英文的 `!` 后面有空格。
const MD_ALT = /(^|\s)![^\s!，。：；、）】]{1,20}(?=\s|$|[\u4e00-\u9fff])/g;

/** 从已写好的简介里删掉图片残骸（回填历史用；不影响新日报的解析路径）。 */
function stripImageResidue(value) {
  return String(value ?? '')
    .replace(IMG_TAG, ' ')
    .replace(IMG_TAIL, ' ')
    .replace(MD_IMAGE, ' ')
    .replace(MD_ALT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 正文里的插图，按出现顺序、按地址去重、最多 9 张；渲染不出来的地址直接丢。 */
function issueImages(body) {
  const text = String(body ?? '');
  const found = [];
  for (const match of text.matchAll(IMAGE_TAG)) {
    const src = imageSrc(match[0]);
    if (src) found.push({ index: match.index, src });
  }
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const src = decodeAmp(match[1] ?? match[2] ?? '').trim();
    if (src) found.push({ index: match.index, src });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const images = [];
  for (const { src } of found) {
    if (images.length >= MAX_IMAGES) break;
    if (seen.has(src) || !usableIssueImage(src)) continue;
    seen.add(src);
    images.push(src);
  }
  return images;
}

module.exports = { issueImages, usableIssueImage, stripImageResidue, MAX_IMAGES };