-- 002_fts_external_content.sql
-- 为什么：001 里的 track_fts 是 content='' 的无内容表，写入/删除必须手工带旧值，
-- 一条漏写就永久脏索引。改成 external content + 触发器，索引跟着 track 自动走。
-- 注意：这一条不改 001（迁移只增不改），并会在末尾 rebuild 一次。

DROP TABLE IF EXISTS track_fts;

CREATE VIRTUAL TABLE track_fts USING fts5(
  title, composer, performer, album, notes,
  content='track', content_rowid='seq',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS trg_track_ai AFTER INSERT ON track BEGIN
  INSERT INTO track_fts(rowid, title, composer, performer, album, notes)
  VALUES (new.seq, new.title, new.composer, new.performer, new.album, new.notes);
END;

CREATE TRIGGER IF NOT EXISTS trg_track_ad AFTER DELETE ON track BEGIN
  INSERT INTO track_fts(track_fts, rowid, title, composer, performer, album, notes)
  VALUES ('delete', old.seq, old.title, old.composer, old.performer, old.album, old.notes);
END;

CREATE TRIGGER IF NOT EXISTS trg_track_au AFTER UPDATE ON track BEGIN
  INSERT INTO track_fts(track_fts, rowid, title, composer, performer, album, notes)
  VALUES ('delete', old.seq, old.title, old.composer, old.performer, old.album, old.notes);
  INSERT INTO track_fts(rowid, title, composer, performer, album, notes)
  VALUES (new.seq, new.title, new.composer, new.performer, new.album, new.notes);
END;

INSERT INTO track_fts(track_fts) VALUES ('rebuild');
