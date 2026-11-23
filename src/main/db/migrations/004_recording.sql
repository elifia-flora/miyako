-- 004_recording.sql — 区分「作品」与「录音制品」
--
-- 为什么需要这一层：
--   古典音乐里同一部作品有多个录音。索菲圣母有 1930 年的 EMI、1961 年的 DG、
--   2010 年的 Harnoncourt 现场版 —— 作曲家、时代、调式、乐器编制全都一样，
--   但**演奏者、乐团、指挥、录音地点、混音与母带、发行年份全都不一样**，
--   时长也会差几十秒。
--
--   这些差异如果挂在 track 上，等于要给同一部作品建 N 条 track 档案，
--   于是「作曲家是谁」「这是什么时期」这些作品级的问题要复制 N 遍，
--   而且搜索会出现 N 条同名结果。
--
-- 怎么分：
--   track（作品层）—— 标题、作曲家、时期、流派、调性、乐器编制、标签。
--                    这些在不同录音版本之间**必然相同**，放作品层。
--   recording（录音层）—— 演奏家、乐团、指挥、混音、母带、发行时间、发行者、
--                      录音地点、文件路径、格式/采样率/声道。
--                      这些**逐版本不同**，放录音层。
--
-- 与既有字段的关系（不做破坏性迁移）：
--   track.file_path / track.duration_ms 保留，作为「主录音」的快捷方式 ——
--   绝大多数作品只有一个录音，列表、播放、波形都直接用它，不必先查录音表。
--   detail 里的 performer 也保留：它是「这台机器上实际那个文件」的执行者摘要。
--   新增录音时，若这是第一条，就同时写进 track.file_path 保持旧行为。

CREATE TABLE IF NOT EXISTS recording (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,
  track_id       TEXT NOT NULL REFERENCES track(id),

  -- 播放者信息：这些正是同一部作品在不同录音间会变的部分
  -- performer 与 orchestra 分开：独奏（演奏者）/ 协奏（乐团）两种都要能记
  performers      TEXT,   -- JSON 字符串数组：['石登忠', 'Mstislav Rostropovich']
  orchestra       TEXT,   -- 乐团 / 合唱团
  conductor       TEXT,   -- 指挥
  soloist         TEXT,   -- 独奏者（协奏曲里的钢琴家等）
  credits_json    TEXT,   -- 其它人名（制作人、录音师…），JSON 对象

  -- 录音工艺信息：混音与母带是录音制品的属性，不是作品的
  recording_place TEXT,   -- 录音地点
  recorded_year   INTEGER,
  mix_engineer    TEXT,   -- 混音师
  mastering_engineer TEXT,-- 母带工程师
  label           TEXT,   -- 唱片公司 / 厂牌
  catalog_no      TEXT,   --  catalog 号
  release_year    INTEGER,-- 发行年份（发行 ≠ 录制，故分两个字段）

  -- 文件与技术信息
  file_path       TEXT,
  duration_ms     INTEGER,
  format          TEXT,   -- flac / wav / mp3…
  sample_rate     INTEGER,
  channels        INTEGER,
  bits            INTEGER,

  -- 排序与标记
  is_default      INTEGER NOT NULL DEFAULT 0,  -- 默认播放的版本
  note            TEXT,
  seq_order       INTEGER NOT NULL DEFAULT 0,

  added_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

-- 一个作品的多条录音：按作品查（详情面板列全部版本）
CREATE INDEX IF NOT EXISTS ix_rec_track ON recording(track_id, deleted_at);
-- 找「哪些作品还没有任何录音」用（迁移时对账）
CREATE INDEX IF NOT EXISTS ix_rec_deleted ON recording(deleted_at);

-- 主录音唯一：一个作品最多一条 is_default=1。
-- 用部分唯一索引而不是应用层保证 —— SQLite 支持 partial index，
-- 应用层漏一处检查就会出现两条「默认」，播放时行为不确定。
CREATE UNIQUE INDEX IF NOT EXISTS ux_rec_default
  ON recording(track_id) WHERE deleted_at IS NULL AND is_default = 1;