-- 006_recording_offset.sql — 原点偏移下沉到「录音版本」
--
-- 为什么必须下沉：
--   audio_offset_ms 记的是「第 1 小节落在音频里的哪个位置」。同一部作品的不同录音，
--   开头留白完全不一样 —— 磁带转录的那版前面有三秒走带噪声，CD 抓轨的那版
--   第 1 小节就压在 0.2 秒。挂在作品层，只能对齐其中一个版本，
--   换一版听，播放头就整体偏掉，而且越到后面偏得越离谱。
--
-- 迁移：把作品级的值一次性复制到该作品的**每一条**录音上。
--   之后 analysis.audio_offset_ms 不再被界面读取 —— 只有「一个录音版本都还没有」
--   的作品会兜底用它。导入器仍然往那一列写初始值，再由 ensureRecordingForTrack
--   在创建第一条录音时抄过去，所以新导入的档案不必另外走一遍迁移。

ALTER TABLE recording ADD COLUMN audio_offset_ms INTEGER NOT NULL DEFAULT 0;

-- 相关子查询：一个作品若有多条 analysis（历史遗留），取先建的那条，
-- 和 getAnalysis /readAnalysis 的 LIMIT 1 同一个口径。
UPDATE recording
   SET audio_offset_ms = COALESCE((
         SELECT a.audio_offset_ms FROM analysis a
          WHERE a.track_id = recording.track_id AND a.deleted_at IS NULL
          ORDER BY a.id
          LIMIT 1
       ), 0);
