-- 键值元数据。第一个用户是「和弦解析器版本」：
-- 解析结果 parsed 是派生数据、只存在库里，改了 chord.js 就必须知道「这批 parsed 是旧版算的」。
-- 没有这张表时唯一的办法是每次启动全量重算（每次都写库），或者干脆不重算（静默显示旧结果）。
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
