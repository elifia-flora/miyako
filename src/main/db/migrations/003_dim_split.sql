-- 003_dim_split
--
-- 把 dim 从「technique」一字拆成两义：
--   composition        = 作曲技法（模进、转调、模仿、配器……）
--   instrument_technique = 乐器演奏技法（拨奏、花舌、弱音器……，新增词表 instrument_technique.json）
--
-- 老库里 technique 这一维装的全是作曲技法（来源是样本的 composition techniques 四分类），
-- 所以整体改名即可，不涉及语义拆分；新维度由词表 JSON 新增条目产生。
--
-- tag_alias 的主键是 (alias, dim)，直接 UPDATE 可能撞键，
-- 所以先搬过去（IGNORE 吃掉冲突），再删掉旧行。

UPDATE tag SET dim = 'composition' WHERE dim = 'technique';

INSERT OR IGNORE INTO tag_alias (alias, dim, tag_id)
  SELECT alias, 'composition', tag_id FROM tag_alias WHERE dim = 'technique';

DELETE FROM tag_alias WHERE dim = 'technique';
