-- 009 · 2026-11-04（schema v5）：体裁（composition_type）与曲式（form）
--
-- 为什么要有这两列：
--   以前「体裁」和「流派」揉在一个 genre 列里，于是「交响曲」「弦乐四重奏」「练习曲」
--   这些**作品形制**占着流派的位置。它们的判定依据完全不同 ——
--   流派答「用了哪一路写法」（爵士 / 民谣 / 配乐），体裁答「这是一部什么作品」。
--   曲式则再下一层：答「它按什么骨架长出来」（奏鸣曲式 / 回旋曲式）。
--   三者可以同时成立：一首交响曲（体裁）用奏鸣曲式（曲式）写成古典风格（流派）。
--
-- 存的是**词表条目 id**（symphony / sonata），不是显示名：
--   显示名会随界面语言变（交响曲 / Symphony），id 不会。
--
-- 本迁移做两件事：
--   1) 加两列（默认 NULL，老档案不受影响）；
--   2) 把 genre 里那 6 个体裁型取值搬到 composition_type，
--      genre 回落成它们的父类 Classical（不丢「这是古典」这个信息）。

ALTER TABLE track ADD COLUMN composition_type TEXT;
ALTER TABLE track ADD COLUMN form TEXT;

UPDATE track SET composition_type = 'symphony'       WHERE lower(trim(genre)) IN ('symphony', 'symphonic', '交响曲', '交响');
UPDATE track SET composition_type = 'concerto'       WHERE lower(trim(genre)) IN ('concerto', '协奏曲', '协奏');
UPDATE track SET composition_type = 'string-quartet' WHERE lower(trim(genre)) IN ('string quartet', '弦乐四重奏', '四重奏', '弦四');
UPDATE track SET composition_type = 'chamber-music'  WHERE lower(trim(genre)) IN ('chamber music', 'chamber', '室内乐');
UPDATE track SET composition_type = 'etude'          WHERE lower(trim(genre)) IN ('etude', 'study', '练习曲');
UPDATE track SET composition_type = 'fanfare'        WHERE lower(trim(genre)) IN ('fanfare', '号角曲', '号角');

-- 体裁已经搬走，流派回落成父类。只在「确实搬走了」的行上改，别碰爵士 / 民谣 / 配乐。
UPDATE track SET genre = 'Classical'
 WHERE composition_type IS NOT NULL
   AND (genre IS NULL OR trim(genre) <> '')
   AND lower(trim(genre)) NOT IN ('classical', '古典');
