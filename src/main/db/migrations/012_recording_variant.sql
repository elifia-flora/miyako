-- 012 · 2026-11-13：同一演奏版本下的多音质 / 多转码文件
--
-- 原来的 recording 一行 = 一次演奏 + 一个文件。于是同一版录音的 flac / mp3 / ogg
-- 会变成三条互不相干的「版本」，演奏家、厂牌、录音年份全要抄三遍；而不同演奏家的
-- 两次录音又和转码混在同一层，顺序列表里看不出谁是谁的派生。
--
-- 现在加一层可空 parent_id：
--   parent_id = null  → 演奏版本（谁演的、哪个厂牌、哪年录的、原点偏移都在这一行）
--   parent_id = 父 id → 同版音质（只贡献 file_path / format / 采样率等技术信息）
--
-- 纯加法：老录音 parent_id 全为 null，行为与以前完全一致；不搬迁任何数据。
-- 一个演奏版本最多引用一个父级（不做嵌套），引擎在 create/save 里挡住。
ALTER TABLE recording ADD COLUMN parent_id TEXT REFERENCES recording(id);

-- 按父版本查它的音质文件；只索引非空，独立版本不进索引
CREATE INDEX IF NOT EXISTS ix_recording_parent ON recording(parent_id) WHERE parent_id IS NOT NULL;
