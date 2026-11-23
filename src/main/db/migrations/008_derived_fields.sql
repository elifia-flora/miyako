-- 008 · 2026-10-25（schema v4）：把「派生值」从库里拿掉
--
-- 两件事，同一个理由：能算出来的东西不该存。存了就有两份真相，
-- 改了一边另一边静默过期 —— 而且没人知道该信哪个。
--
-- 1) `track.title_lang`：从 "English" 这种全名改成 BCP-47 主标签（en / ja / zh…）。
--    全名是文案，中文界面里没法翻成「英语」，也没法接系统语言。
--    这里把已有的老行就地归一；认不出的保持原样（宁可留着，也不猜着改）。
--
-- 2) `analysis.meter_type`：整列删除。单/复/混合拍子由 `shared/meter.js` 现算，
--    而且结论**随术语体系变**（中/苏/德奥认为 4/4 是复拍子，英美认为是 simple meter）——
--    一个 TEXT 列装不下「在哪个体系下」这个前提，存进去就必然是半真半假。

UPDATE track SET title_lang = 'zh'
 WHERE lower(trim(title_lang)) IN ('chinese', 'mandarin', '中文', '汉语', '普通话');
UPDATE track SET title_lang = 'yue'
 WHERE lower(trim(title_lang)) IN ('cantonese', '粤语', '粵語');
UPDATE track SET title_lang = 'ja'
 WHERE lower(trim(title_lang)) IN ('japanese', '日本語', '日语');
UPDATE track SET title_lang = 'ko'
 WHERE lower(trim(title_lang)) IN ('korean', '韩语', '韓語');
UPDATE track SET title_lang = 'en'
 WHERE lower(trim(title_lang)) IN ('english');
UPDATE track SET title_lang = 'fr'
 WHERE lower(trim(title_lang)) IN ('french');
UPDATE track SET title_lang = 'de'
 WHERE lower(trim(title_lang)) IN ('german');
UPDATE track SET title_lang = 'it'
 WHERE lower(trim(title_lang)) IN ('italian');
UPDATE track SET title_lang = 'es'
 WHERE lower(trim(title_lang)) IN ('spanish');
UPDATE track SET title_lang = 'pt'
 WHERE lower(trim(title_lang)) IN ('portuguese');
UPDATE track SET title_lang = 'ru'
 WHERE lower(trim(title_lang)) IN ('russian');
UPDATE track SET title_lang = 'la'
 WHERE lower(trim(title_lang)) IN ('latin', '拉丁语');
-- 带地区后缀的（en-US / zh-Hant）取主标签
UPDATE track SET title_lang = substr(title_lang, 1, instr(title_lang, '-') - 1)
 WHERE instr(title_lang, '-') > 0;
UPDATE track SET title_lang = 'zxx'
 WHERE lower(trim(title_lang)) IN ('instrumental', 'none');

ALTER TABLE analysis DROP COLUMN meter_type;
