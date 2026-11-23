-- 005_recording_link.sql — 录音版本也可以是「外部网络链接」，以及专辑内序号
--
-- 1) recording.link
--    一条录音未必在本地有文件：可能只在网易云 / QQ 音乐 / B 站上。以前这种情况
--    只能靠作品层的 extra.links.netease 表达，于是「哪个版本对应哪个链接」说不清 ——
--    同一部作品在网易云上架的往往是其中一个版本。
--    加上这一列，链接就归到具体录音版本；file_path 与 link 互斥使用（有文件优先）。
--
-- 2) track.album_track_no
--    「这张专辑里的第几首」。专辑本身是自由文本（track.album），
--    序号是这张专辑内部的顺序，不是作品的属性 —— 但也没有别的地方可挂。
--    刻意存 INTEGER 而不是 "3/12" 这种串：total 会随专辑变化，
--    而曲序在补歌时不该被重写。

ALTER TABLE recording ADD COLUMN link TEXT;
ALTER TABLE track ADD COLUMN album_track_no INTEGER;

-- 「有外链的版本」按作品查得比较频繁（列表里标云朵图标）
CREATE INDEX IF NOT EXISTS idx_recording_link ON recording(track_id) WHERE link IS NOT NULL;
