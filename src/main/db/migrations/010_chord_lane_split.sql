-- 010 · 2026-11-04：级数与字母和弦拆成两条泳道
--
-- 以前 roman / letter / riemann / voicing 四个视图共用 `lane = 'chord'` 一行数据，
-- 于是「字母和弦」视图里看到的是一串 `I / IV / V7`（那是级数），
-- 在那边敲 `Cmaj7` 又会把级数行覆盖掉。两套符号被绑成了一份数据。
--
-- 现在：
--   lane = 'degree'  → 级数（罗马数字 / 黎曼功能视图的「级数」行）
--   lane = 'chord'   → 绝对和弦（字母和弦视图、和弦组成音视图的「和弦」行）
--
-- 历史数据里 `chord` 绝大多数是级数（字母视图是后加的），所以只把**明确解析成
-- 绝对和弦**的那些留在 chord，其余（含 parsed 为空的旧行）一律判为级数。
-- 判据用 parsed.kind，不靠文字猜：`V7` 与 `G7` 按正则区分早晚会错。
--
-- 注意：不是删数据，是换个泳道名 —— 事件、tick、时值、parsed 全都不动。

UPDATE analysis_event
   SET lane = 'degree'
 WHERE lane = 'chord'
   AND (
     parsed IS NULL
     OR NOT json_valid(parsed)
     OR IFNULL(json_extract(parsed, '$.kind'), '') <> 'absolute'
   );
