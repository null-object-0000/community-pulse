-- 0006：`product_content` 的读取端需要一条能走索引的查询路径。
--
-- 背景：这张表从 09-14 建好起就只写不读（全部 shadow），所以一直没暴露索引缺口。现在要让
-- `/api/v1/products`、`/api/v1/trends` 与产品详情页按 `product_id` 取「当前生效」的双语正文，
-- 查询形状是 `WHERE product_id IN (…) AND is_current = 1`（中英文两行一次取回）。
--
-- 为什么现有键不够：主键是 `(product_id, locale, content_source, created_at)` —— `locale` 夹在
-- 中间，所以按 `product_id + is_current` 过滤时只能用主键的第一列，`is_current` 退化成回表过滤。
-- 列表页一次要取 60~300 个产品，每个产品再回表扫一遍它全部的 shadow 行（同一产品反复加工会
-- 累积多行，实测 21,622 行对应 10,800 个产品），查询随加工批次线性变慢。
--
-- 列顺序按选择性排：`product_id` 等值在前，`locale` 次之（等值两值），`is_current` 最后。
-- 不含 `content_source`：同产品同 locale 同时 current 的行按设计只有一行，取哪一行由
-- `ORDER BY created_at DESC` 在索引内完成（覆盖排序），把版本号放进键反而会让「换加工版本后
-- 旧 current 行还在」的情况出现两条命中。
ALTER TABLE product_content
  ADD KEY idx_content_current (product_id, locale, is_current, created_at);
