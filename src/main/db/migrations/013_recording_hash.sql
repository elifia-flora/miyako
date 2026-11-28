-- 013 · 拖入音频时按内容哈希去重
--
-- 同一份文件复制到另一个路径，路径对不上，但字节一样。
-- 哈希记在录音行上（一个作品可以有多份音频）。老行保持 NULL，
-- 登记时若路径已经在库里，仍算重复，并顺手把哈希补上。
ALTER TABLE recording ADD COLUMN file_hash TEXT;

CREATE INDEX IF NOT EXISTS ix_rec_hash
  ON recording(file_hash) WHERE file_hash IS NOT NULL AND deleted_at IS NULL;
