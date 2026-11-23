-- 011 · 2026-11-13：多乐章作品 —— 母作品挂乐章子项
--
-- 一部多乐章作品 = 一个母作品 track（parent_id 为 null，通常不绑音频）+ N 个乐章子 track。
-- 每个乐章有自己的曲式 / 调性 / 分析网格 / 录音，所以它就是一个普通 track，只多一个
-- parent_id 指向母作品。纯加法：可空列，老曲目 parent_id = null，一行都不受影响；
-- 「一份 JSON = 一个 track = 一份 analysis」的不变量不动，乐章只是带 parentId 的普通档案。
ALTER TABLE track ADD COLUMN parent_id TEXT REFERENCES track(id);

-- 按母作品查它的乐章（列表嵌套子行用）；只索引非空，独立曲目不进索引
CREATE INDEX IF NOT EXISTS ix_track_parent ON track(parent_id) WHERE parent_id IS NOT NULL;