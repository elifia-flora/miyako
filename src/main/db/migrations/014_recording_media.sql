-- 014 · 演奏版本自己的歌词与封面
--
-- 作品级的 extra.lyrics / extra.covers 继续当「各版本都能退回去」的默认。
-- 同一场演奏的不同音质（parent_id 非空）不单独挂：时长和速度跟父版本一样，
-- 读的时候走到父行。老行这两列是 NULL，显示顺序与以前相同。

ALTER TABLE recording ADD COLUMN lyrics_rel TEXT;
ALTER TABLE recording ADD COLUMN cover_rel TEXT;
