-- 001_init.sql — schema v1
-- 约定：
--   1) 每张表都有 deleted_at（软删除），唯一例外是纯关系表。
--   2) 对外标识一律用 TEXT uuid；内部整数 seq 只用于关联与排序。
--   3) 任何改表都新增 migration 文件，禁止改动本文件。

CREATE TABLE IF NOT EXISTS track (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  title_lang  TEXT,
  title_sort  TEXT,
  composer    TEXT,
  performer   TEXT,
  album       TEXT,
  genre       TEXT,
  period      TEXT,
  duration_ms INTEGER,
  file_path   TEXT,
  file_hash   TEXT,
  notes       TEXT,
  extra       TEXT,
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_track_sort ON track(title_sort);
CREATE INDEX IF NOT EXISTS ix_track_comp ON track(composer);

-- 词表缓存：源在 data/vocab/*.json，本表可被完整重建。
CREATE TABLE IF NOT EXISTS tag (
  id          TEXT PRIMARY KEY,
  dim         TEXT NOT NULL,
  name        TEXT NOT NULL,
  display     TEXT,
  merged_into TEXT REFERENCES tag(id),
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tag_dim ON tag(dim);

CREATE TABLE IF NOT EXISTS tag_edge (
  child_id  TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  PRIMARY KEY (child_id, parent_id)
);
CREATE INDEX IF NOT EXISTS ix_edge_parent ON tag_edge(parent_id);

CREATE TABLE IF NOT EXISTS tag_alias (
  alias  TEXT NOT NULL,
  dim    TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (alias, dim)
);

CREATE TABLE IF NOT EXISTS track_tag (
  track_id TEXT NOT NULL,
  tag_id   TEXT NOT NULL,
  weight   REAL DEFAULT 1,
  PRIMARY KEY (track_id, tag_id)
);
CREATE INDEX IF NOT EXISTS ix_tt_tag ON track_tag(tag_id);

CREATE TABLE IF NOT EXISTS analysis (
  id              TEXT PRIMARY KEY,
  track_id        TEXT NOT NULL REFERENCES track(id),
  title           TEXT,
  ppq             INTEGER NOT NULL DEFAULT 480,
  tempo_value     REAL,
  tempo_unit      TEXT,
  meter_num       INTEGER,
  meter_den       INTEGER,
  meter_type      TEXT,
  meter_note      TEXT,
  audio_offset_ms INTEGER NOT NULL DEFAULT 0,
  view_id         TEXT,
  author          TEXT,
  created_at      INTEGER,
  updated_at      INTEGER,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS ix_analysis_track ON analysis(track_id);

-- 时间轴标记：拍号 / 速度 / 段落 / 调性，共用一张表，靠 kind 隔离。
CREATE TABLE IF NOT EXISTS analysis_marker (
  id          TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analysis(id),
  tick        INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('meter','tempo','section','key','rehearsal')),
  label       TEXT,
  num         INTEGER,
  den         INTEGER,
  bpm         REAL,
  key_name    TEXT,
  start_bar   INTEGER,
  confidence  TEXT NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed','uncertain','guess')),
  note        TEXT,
  sort_order  INTEGER DEFAULT 0,
  UNIQUE (analysis_id, kind, tick)
);
CREATE INDEX IF NOT EXISTS ix_marker ON analysis_marker(analysis_id, kind, tick);

-- 网格内容：稀疏事件，lane 是无约束字符串，由 view 定义呈现方式。
CREATE TABLE IF NOT EXISTS analysis_event (
  id          TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES analysis(id),
  lane        TEXT NOT NULL,
  tick        INTEGER NOT NULL,
  dur_ticks   INTEGER NOT NULL DEFAULT 480,
  text        TEXT NOT NULL,
  parsed      TEXT,
  confidence  TEXT NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed','uncertain','guess')),
  updated_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_event ON analysis_event(analysis_id, tick);

CREATE VIRTUAL TABLE IF NOT EXISTS track_fts USING fts5(
  title, composer, performer, album, notes,
  content='', tokenize='unicode61 remove_diacritics 2'
);
