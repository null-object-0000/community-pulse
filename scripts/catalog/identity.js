/**
 * 转发到技能层的唯一实现：`.agents/skills/community-pulse/scripts/product-identity.js`。
 *
 * 保留这个文件是为了不改动既有 require 路径（build-mysql-import / search-submit / build-site /
 * backfill_issue_entity / tests 都从这里取）。要改身份规则，改技能层那一份。
 */
module.exports = require('../../.agents/skills/community-pulse/scripts/product-identity.js');
