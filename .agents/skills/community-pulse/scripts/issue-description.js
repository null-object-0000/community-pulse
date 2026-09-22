/**
 * 投稿类 Issue 正文 → 简介。
 *
 * 用户在 ruanyf/weekly 和 HelloGitHub 里按模板投稿，正文常常是
 * 「项目地址 / 项目标题 / 项目描述」这种字段名加值。原来直接取清洗后的整段正文，
 * 字段名就被当成内容渲染到列表和项目详情页上（2026-09 走查：13.6% 的条目如此）。
 *
 * 这里按行剥离字段名与纯值行，再取描述字段或第一个有意义的段落。
 * 纯函数、无依赖，便于单测；离线语料验证见 scripts/validate_issue_description.js。
 */

// 投稿模板里的字段名。长的必须排在前面，否则「项目地址」会被「地址」抢先匹配。
const FIELD_LABELS = [
  '项目描述', '项目简介', '项目介绍', '项目标题', '项目名称', '项目地址', '项目网址', '项目链接', '项目主页', '项目类别',
  '作品网址', '作品地址', '作品名称', '在线体验', '在线地址', '在线演示', '在线预览',
  '官网地址', '官方网站', '官方网址', '官网', '官方',
  '推荐理由', '项目依赖', '示例代码', '运行环境', '使用方法', '使用说明', '项目文档', '项目语言', '主要语言', '项目截图',
  '后续更新计划', '更新计划', '推荐项目', '开源地址', '产品名称', '网站', '一句话介绍', '详细介绍', '产品介绍',
  'github地址', 'github', '源码地址', '源码', '仓库地址', '仓库',
  '描述', '简介', '介绍', '地址', '网址', '链接', '类别', '语言', '演示',
  // HelloGitHub 现行模板用「必写 / 可选」标注必填与选填
  '必写', '可选',
  'demo', 'website', 'description', 'screenshots', 'screenshot', 'repo', 'repository',
];

// 描述类字段：优先用它的值，而不是正文第一段。
const DESCRIPTION_LABELS = new Set(['项目描述', '项目简介', '项目介绍', '描述', '简介', '介绍', '推荐理由', '一句话介绍', '详细介绍', '产品介绍', 'description']);

// 字段名后面可能跟括号说明（项目简介 (100 字以内)）或并列名（项目描述 & 推荐理由）。
const LABEL_SUFFIX = String.raw`(?:\s*[（(][^）)]*[）)]|\s*[/&+＋、]\s*[^：:\s]{0,12}|\s*与\s*[^：:\s]{0,12})?`;
const LABEL_ANY = new RegExp(`^(?:${FIELD_LABELS.join('|')})${LABEL_SUFFIX}\\s*[：:]?\\s*$`, 'i');
// 捕获组 1 = 字段名，2 = 字段值。
const LABEL_VALUE = new RegExp(`^(${FIELD_LABELS.join('|')})${LABEL_SUFFIX}\\s*[：:]\\s*(.*)$`, 'i');
// 值里残留的内联字段名（「可选：xxx」挤在同一段时用）。
const LABEL_INLINE = new RegExp(`(?:^|[\\s，。；、])(${FIELD_LABELS.join('|')})${LABEL_SUFFIX}\\s*[：:]\\s*`, 'gi');
const LABEL_TRAILING = new RegExp(`\\s*(?:${FIELD_LABELS.join('|')})${LABEL_SUFFIX}\\s*[：:]?\\s*$`, 'i');
// 捕获组 1 = 字段名，2 = 字段值；与 LABEL_VALUE 同形，但**不做任何清洗**，用来取地址字段里的 URL。
const LABEL_URL_VALUE = new RegExp(`^(${FIELD_LABELS.join('|')})${LABEL_SUFFIX}\\s*[：:]\\s*(\\S.*)$`, 'i');

// 「项目地址 / 开源地址 / 仓库地址」这类字段指向的是**产品自己**的仓库或主页。
// 正文其它地方常混着依赖仓库、参考项目、徽章和作者主页的链接，只按「正文第一个 github.com
// 链接」取值会认错产品（2026-09-18 走查：正文先提到参考项目时就会认错）。
// 这份名单必须是 FIELD_LABELS 的子集，否则 LABEL_URL_VALUE 根本匹配不到。
const PROJECT_URL_LABELS = new Set([
  '项目地址', '项目网址', '项目链接', '项目主页', '作品网址', '作品地址',
  '开源地址', '源码地址', '仓库地址', 'github地址', 'github', 'repo', 'repository',
]);
// 「官网 / 官方」这类字段指向产品的对外站点，但**不能**用来定仓库身份：
// 汉化版、fork、二开这类投稿会写「官方：<上游仓库>」，那条地址是上游而不是这个产品
// （实测 ruanyf/weekly #7164 的 gemini-cli 汉化版就会因此被并进上游仓库）。
// 它们只在完全找不到仓库时，作为行链接的兜底候选。
const SITE_URL_LABELS = new Set([
  '官网地址', '官方网站', '官方网址', '官网', '官方', '网站', 'website',
  '在线体验', '在线地址', '在线演示', '在线预览',
]);
const URL_FIELD_LABELS = new Set([...PROJECT_URL_LABELS, ...SITE_URL_LABELS]);

// 裸链接的边界（全站唯一一份，`source_raw_items.extractExternalUrls` 直接转发到这里）：
// 在空白、尖括号、引号、括号与中英句末标点处终止。
const BARE_URL_RE = /https?:\/\/[^\s<>()[\]{}"'（）［］【】《》〈〉「」『』，。：；！？、…]+/g;

/**
 * 地址尾巴上不属于地址本身的装饰。
 *
 * 投稿正文里作者爱把链接加粗或放进行内代码，`**` / `_` / `~` / `` ` `` 都在 BARE_URL_RE 的
 * 字符集里，于是收尾符号被当成地址的一部分：ruanyf/weekly #11845 的 `**https://seichigo.com**`
 * 变成了 `https://seichigo.com**`，线上的「官网」按钮指向一个 DNS 解析不了的主机
 * （同一批还有 #11186 `项目地址：**https://smartplot.app/**`、#11246 `**_https://vokie.com/_**`）。
 * 英文句末标点同理：`https://github.com/larryteal/mcp-workspace.` 的句点不是仓库名的一部分。
 *
 * 只剥**结尾**的装饰，地址中间的 `~`（`/~shais/…`）与 `_`（`p2-3_x`）不动；`)` 这类括号本来
 * 就不进 BARE_URL_RE。剥 `_` 有理论上的误伤（地址真的以 `_` 结尾），但实测全量语料里没有，
 * 而留在尾巴上的 `_**` 一定错。
 */
const URL_TAIL_DECORATION = /(?:[*_`~]+|[.,;:!?])+$/;

/** 去掉一条裸链接尾部的 markdown 装饰与句末标点。 */
function cleanBareUrl(value) {
  return String(value ?? '').replace(URL_TAIL_DECORATION, '');
}

/** 文本里的裸链接（按出现顺序、去重），尾部装饰已剥掉。 */
function bareUrls(value) {
  const urls = [];
  const seen = new Set();
  for (const match of String(value ?? '').matchAll(BARE_URL_RE)) {
    const url = cleanBareUrl(match[0]);
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    urls.push(url);
  }
  return urls;
}

// 字段值里的噪声：空回答、占位符。
const NOISE_VALUE = /^(?:no response|_?no response_?|none|null|n\/a|na|无|暂无|没有|待补充|todo|tbd|示例|example)$/i;
// 纯值行：语言名、许可证之类的短标签，不是描述。
const PLAIN_VALUE = /^(?:js|ts|javascript|typescript|python|rust|go|golang|java|kotlin|swift|c\+\+|c#|php|ruby|sql|html|css|shell|bash|vue|react|node(?:\.?js)?|macos|windows|linux|ios|android|web|cli|mit|apache-?2\.?0?|gpl-?3\.?0?|bsd)$/i;

const MIN_DESCRIPTION_LENGTH = 15;

// 投稿正文里真正会出现的 HTML 标签。只吃这份白名单，而不是「任意尖括号」——技术投稿的正文里
// 常有 `<message-id>`、`a < b` 这类内容，它们不是标签。插图 `<img>` 由 issue-media.js 收进配图集。
const HTML_TAG_NAME = new RegExp(
  String.raw`<\/?(?:img|br|hr|div|p|a|span|strong|em|b|i|u|s|del|ins|code|pre|blockquote|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|figure|figcaption|picture|source|video|audio|details|summary|small|sub|sup|kbd|mark|center|font|section|article|header|footer)\b`, 'gi');

/**
 * 删掉白名单里的 HTML 标签。
 *
 * **别把它写回一条正则**：`<\/?(?:…)\b(?:\s+(?:[^<>"']+|"[^"]*"|'[^']*')*)?\/?>` 里的
 * `(?:[^<>"']+|"[^"]*"|'[^']*')*` 是有歧义的重复 —— `[^<>"']+` 能在任意位置把同一段属性文本切开，
 * 整条匹配一旦失败，回溯次数就是指数级。实测 ruanyf/weekly #9746（WorldX，属性里多打了一个引号
 * `…94d7""`）能让它永远跑不完：2026-09-17 的产品库全量补跑就是卡在这一步 4 小时没出来。
 * 顺带它还漏掉了畸形标签（`<img src=" alt="b" width="400"/>` 里只吃掉 `<img src="`）。
 * 改成一次线性扫描：认出标签名后，找引号外的第一个 `>` 收尾；找不到就原样留着。
 *
 * 扫描是**跨行**的（`<img\n src="…"\n alt="…" />` 是投稿模板里的常见写法），但**不跨空行**：
 * 遇到空行说明这段尖括号其实是正文（例如「用 `<img` 标签插图片」后面某行出现 `>`），
 * 这时原样保留，只把扫描位置挪到标签名之后。2026-09-18 之前简介是按行清洗的，跨行的 `<img>`
 * 只会被吃掉 `<img`，剩下的 `src="` `alt="…"` 留在简介里。
 */
function stripHtmlTags(value) {
  const text = String(value ?? '');
  let out = '';
  let last = 0;
  HTML_TAG_NAME.lastIndex = 0;
  for (let match; (match = HTML_TAG_NAME.exec(text)); ) {
    let index = HTML_TAG_NAME.lastIndex;
    let quote = '';
    let prose = false;
    for (; index < text.length; index += 1) {
      const char = text[index];
      // 先遇到 `<` 就说明这个标签是畸形的（例如属性里多打了一个引号）：就地收尾，
      // 把残骸整段删掉，而不是像以前那样把 `<img src=" alt="…` 留在简介里。
      if (char === '<') break;
      // 空行 = 段落边界，标签不会跨段落。
      if (char === '\n' && text[index + 1] === '\n') { prose = true; break; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '>') break;
    }
    if (index >= text.length) break;                 // 到结尾都没收尾：剩下的原样保留
    if (prose) { HTML_TAG_NAME.lastIndex = match.index + match[0].length; continue; }
    out += `${text.slice(last, match.index)} `;
    // `>` 收尾：跳过它；`<` 收尾：从那个 `<` 继续找下一个标签。
    last = text[index] === '>' ? index + 1 : index;
    HTML_TAG_NAME.lastIndex = last;
  }
  return out + text.slice(last);
}

/** 去掉 markdown 内联标记与链接，压平空白。单行语义。 */
function stripInlineMarkup(value) {
  const withoutComments = String(value ?? '').replace(/<!--[\s\S]*?-->/g, ''); // 模板里的 HTML 注释
  return stripHtmlTags(withoutComments)             // HTML 标签（`<img …>` 等）
    .replace(/<https?:\/\/[^>\s]+>/g, '')            // <https://...>
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')         // [文本](链接) → 文本
    .replace(/https?:\/\/[^\s)\]]+/g, '')            // 裸链接
    .replace(/^[\s>*_`#\-–—]+/, '')                  // 标题/引用/列表前缀
    .replace(/[*_`]/g, '')                           // 强调与代码符号
    .replace(/\s+/g, ' ')
    .trim();
}

/** 去掉结尾的「- [项目与下载](url) - [更多介绍](url)」这类导航链接列表。 */
function stripTrailingLinkItems(value) {
  let out = String(value ?? '').trim();
  for (let prev; out !== prev;) {
    prev = out;
    out = out.replace(/\s*[-–—*•]?\s*\[[^\]]{1,16}\]\([^)]*\)\s*$/, '').trim();
  }
  return out.replace(/[\s\-–—*•]+$/, '').trim();
}

/** 去掉选中文本里残留的字段名（含句中被挤在同一段的「可选：xxx」）。 */
function stripResidualLabels(text) {
  return String(text ?? '')
    .replace(LABEL_INLINE, ' ')
    .replace(LABEL_TRAILING, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把正文按字段名切成块；没有字段名的行归入 label 为 null 的块。 */
function splitBlocks(body) {
  const blocks = [];
  let current = { label: null, lines: [] };
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = stripInlineMarkup(raw);
    if (!line) { current.lines.push(''); continue; }
    const pair = line.match(LABEL_VALUE);
    if (pair) {
      blocks.push(current);
      current = { label: pair[1].toLowerCase(), lines: pair[2] ? [pair[2]] : [] };
      continue;
    }
    if (LABEL_ANY.test(line)) {
      blocks.push(current);
      current = { label: line.replace(/[：:]\s*$/, '').toLowerCase(), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  blocks.push(current);
  return blocks
    .map(block => ({ label: block.label, text: block.lines.join(' ').replace(/\s+/g, ' ').trim() }))
    .filter(block => block.text);
}

/** 值是否值得作为简介：不是空回答、不是纯语言名、不太短。 */
function usable(text, minLength) {
  if (!text) return false;
  if (NOISE_VALUE.test(text)) return false;
  if (PLAIN_VALUE.test(text)) return false;
  return text.length >= minLength;
}

/**
 * Issue 正文 → 简介。
 * 优先取描述类字段的值，其次取第一个有意义的段落，最后退到最长的一段；
 * 都没有时返回空串，让上层按自己的规则回退。
 */
function descriptionFromIssue(body) {
  // 整段先删 HTML 标签，再按行切字段：标签可能跨行（`<img\n src="…"\n alt="…" />`），
  // 逐行清洗只会把 `<img` 吃掉，剩下的 `src="` `alt="…"` 变成简介里的残骸（2026-09-18 走查：
  // Illustrator、Skills Manager、MonsterMusic 三条投稿如此）。空行处不跨段，见 stripHtmlTags。
  const blocks = splitBlocks(stripHtmlTags(String(body ?? '').replace(/<!--[\s\S]*?-->/g, '')));
  if (!blocks.length) return '';
  const pick = () => {
    const described = blocks.filter(block => block.label && DESCRIPTION_LABELS.has(block.label));
    for (const block of described) if (usable(block.text, MIN_DESCRIPTION_LENGTH)) return block.text;
    // 描述字段很短时也比正文里的字段名强
    for (const block of described) if (usable(block.text, 4)) return block.text;

    const free = blocks.filter(block => !block.label);
    for (const block of free) if (usable(block.text, MIN_DESCRIPTION_LENGTH)) return block.text;
    for (const block of blocks) if (usable(block.text, MIN_DESCRIPTION_LENGTH)) return block.text;

    // 兜底：取最长的一段，避免完全拿不到简介
    const longest = blocks.map(block => block.text).sort((a, b) => b.length - a.length)[0] || '';
    return NOISE_VALUE.test(longest) ? '' : longest;
  };
  const chosen = stripResidualLabels(pick());
  return NOISE_VALUE.test(chosen) ? '' : chosen;
}

/**
 * Issue 正文里**显式地址字段**的值（按出现顺序、去重）。`labels` 决定认哪些字段名：
 * 默认认全部地址字段；`PROJECT_URL_LABELS` / `SITE_URL_LABELS` 可分别取「产品自己的地址」
 * 与「官网类地址」。
 *
 * 与 `descriptionFromIssue` 的关键区别：这里不做 markdown / 链接清洗 —— `stripInlineMarkup`
 * 会把裸链接整段删掉，用它取地址只会得到空串。所以这里按行扫描原始文本，只在两处收口：
 * 先删 HTML 注释（模板里的示例注释常带假地址），再按 `bareUrls` 的边界（中文标点终止 +
 * 剥掉包裹链接的 markdown 装饰）取值。
 *
 * 支持两种模板写法：「项目地址：https://…」同一行，以及「项目地址」单独一行、值在下一行
 * （下一行自己又写成「Github：https://…」也照收，见 ruanyf/weekly #7728）。
 */
function explicitProjectUrls(body, labels = URL_FIELD_LABELS) {
  const lines = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n').split('\n');
  const urls = [];
  const seen = new Set();
  const collect = (text) => {
    for (const url of bareUrls(text)) {
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
    }
  };
  const isAddressLabel = (name) => labels.has(String(name).trim().toLowerCase());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const pair = line.match(LABEL_URL_VALUE);
    if (pair) {
      if (isAddressLabel(pair[1])) collect(pair[2]);
      continue;
    }
    // 地址字段名单独一行：值在下面连续几行里，遇到空行或**别的**字段名就停。
    if (!isAddressLabel(line.replace(/[：:]\s*$/, ''))) continue;
    for (let next = index + 1; next < lines.length; next += 1) {
      const value = lines[next].trim();
      if (!value) break;
      const inner = value.match(LABEL_URL_VALUE);
      if (inner) {
        if (!isAddressLabel(inner[1])) break;
        collect(inner[2]);
        continue;
      }
      if (LABEL_ANY.test(value)) {
        if (!isAddressLabel(value.replace(/[：:]\s*$/, ''))) break;
        continue;
      }
      collect(value);
    }
  }
  return urls;
}

module.exports = {
  descriptionFromIssue, explicitProjectUrls, stripInlineMarkup, stripTrailingLinkItems, bareUrls, FIELD_LABELS,
  PROJECT_URL_LABELS, SITE_URL_LABELS,
};
