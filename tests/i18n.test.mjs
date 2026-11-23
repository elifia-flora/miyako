import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DICT,
  LOCALES,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
  guessLocale,
  htmlLang,
  isLocale,
  keyDiff,
  normalizeLocale,
  t,
  tn,
} from '../src/shared/i18n.js';
import { keyModeLabel, periodLabel } from '../src/shared/search.js';
import { ZH_TW } from '../src/shared/i18n.zh-TW.js';
import { ZH_HK } from '../src/shared/i18n.zh-HK.js';
import { HK_PATCH } from '../src/shared/i18n.zh-HK.patch.js';
import { isHant, toHant } from '../src/shared/hant.js';
import { degreeName, describeChord, parseChord } from '../src/shared/chord.js';

/* ---------------- 词典完整性 ---------------- */

test('每个语言都有词典，默认语言是中文', () => {
  for (const l of LOCALES) assert.ok(Object.keys(DICT[l.id]).length > 50, `${l.id} 词典太小`);
  assert.equal(DEFAULT_LOCALE, 'zh');
  assert.equal(FALLBACK_LOCALE, 'zh');
});

test('每种语言的键集都和中文完全一致（.one/.other 折回基键比较）', () => {
  for (const l of LOCALES) {
    if (l.id === DEFAULT_LOCALE) continue;
    const diff = keyDiff('zh', l.id);
    assert.deepEqual(diff.missingInB, [], `${l.id} 缺少这些键`);
    assert.deepEqual(diff.missingInA, [], `${l.id} 多出这些键`);
  }
});

test('日语词典是真翻译，不是把中文抄了一份', () => {
  // 短术语（「作曲」「楽器」）中日同形很正常，所以不逐条要求不同；
  // 但整份词典里绝大多数条目必须换过写法，否则就是漏翻了。
  const zh = DICT.zh;
  const ja = DICT.ja;
  const keys = Object.keys(ja).filter((k) => String(zh[k] ?? '').length >= 6);
  const changed = keys.filter((k) => ja[k] !== zh[k]).length;
  assert.ok(changed / keys.length > 0.8, `只有 ${changed}/${keys.length} 条换过写法`);
  // 日语里必须有假名（片假名或平假名），一个都没有说明写的不是日语
  const kana = /[\u3040-\u30ff]/;
  assert.ok(Object.values(ja).some((v) => kana.test(v)), '日语词典里找不到假名');
});

test('繁体两份不是把简体换了个封面：长条目绝大多数必须与简中不同', () => {
  const zh = DICT.zh;
  for (const id of ['zh-TW', 'zh-HK']) {
    const target = DICT[id];
    const keys = Object.keys(target).filter((k) => String(zh[k] ?? '').length >= 6);
    const changed = keys.filter((k) => target[k] !== zh[k]).length;
    assert.ok(changed / keys.length > 0.8, `${id} 只有 ${changed}/${keys.length} 条与简中不同`);
    // 正体专用的字形至少要有一些，否则说明「转换」根本没生效
    const hantOnly = /[檔設體網頁軟硬預設們來個為與這還過開關時從]/;
    assert.ok(
      Object.values(target).some((v) => hantOnly.test(String(v))),
      `${id} 里找不到正体字形`
    );
  }
});

test('香港版是「台湾 + 差异表」生成的：键集相同，非差异条目只差 裡→裏', () => {
  assert.deepEqual(Object.keys(ZH_HK), Object.keys(ZH_TW), '键集或顺序不一致，说明生成物过期了');
  for (const k of Object.keys(ZH_TW)) {
    const want = k in HK_PATCH ? HK_PATCH[k] : String(ZH_TW[k]).replace(/裡/g, '裏');
    assert.equal(ZH_HK[k], want, `${k} 与「台湾 + 差异表」算出来的不一致（手改过生成物？跑一遍 tools/i18n-hant.mjs）`);
  }
  assert.ok(Object.keys(HK_PATCH).length > 0, '差异表不该是空的');
});

test('繁体与简体确实不同（抽样：文件→檔案、软件→軟體 / 軟件）', () => {
  assert.equal(DICT['zh-TW']['menu.file'], '檔案');
  assert.match(DICT['zh-TW']['prefs.undoPersist'], /軟體/);
  assert.match(DICT['zh-HK']['prefs.undoPersist'], /軟件/);
});

test('toHant / isHant：只认两种繁体写法，逐字转换不碰非汉字', () => {
  assert.equal(isHant('zh-TW'), true);
  assert.equal(isHant('zh-HK'), true);
  assert.equal(isHant('zh'), false);
  assert.equal(isHant('ja'), false);
  assert.equal(toHant('第三乐章 浪漫主义 V7 — 42'), '第三樂章 浪漫主義 V7 — 42');
});

test('英文词典里不许出现汉字 —— 漏翻的中文不能静默混进英文界面', () => {
  const han = /[\u3400-\u9fff\uf900-\ufaff]/;
  const dirty = Object.entries(DICT.en)
    .filter(([, v]) => han.test(v))
    .map(([k, v]) => `${k} = ${v}`);
  assert.deepEqual(dirty, []);
});

test('中文词典里不许出现没替换掉的 {占位符} 以外的花括号问题（值不能是 undefined）', () => {
  for (const loc of Object.keys(DICT)) {
    for (const [k, v] of Object.entries(DICT[loc])) {
      assert.equal(typeof v, 'string', `${loc}.${k} 不是字符串`);
    }
  }
});

/* ---------------- 取词与回落 ---------------- */

test('取词：按语言取到各自写法', () => {
  assert.equal(t('zh', 'menu.file'), '文件');
  assert.equal(t('en', 'menu.file'), 'File');
  assert.equal(t('ja', 'menu.file'), 'ファイル');
});

test('未知语言回落到中文，未知键回落到键名（不会返回空白）', () => {
  assert.equal(t('fr', 'menu.file'), '文件');
  assert.equal(t('en', 'no.such.key'), 'no.such.key');
  assert.equal(t('zh', ''), '');
});

test('占位符按名字替换，缺变量就保留原样（能一眼看出来）', () => {
  assert.equal(t('zh', 'msg.playing', { title: '神鹿谣' }), '播放：神鹿谣');
  assert.equal(t('en', 'msg.playing', { title: 'Sacred Deer' }), 'Playing: Sacred Deer');
  assert.equal(t('en', 'msg.playing'), 'Playing: {title}');
});

test('单复数：带数字 n 时选 .one / .other，没有变体就退回基键', () => {
  assert.equal(tn('en', 'status.results', 1), '1 result');
  assert.equal(tn('en', 'status.results', 3), '3 results');
  assert.equal(tn('zh', 'status.results', 1), '1 条结果');
  assert.equal(tn('zh', 'status.results', 3), '3 条结果');
  assert.equal(tn('en', 'grid.cell', 1), '1 cell');
  assert.equal(tn('en', 'grid.cell', 4), '4 cells');
  assert.equal(tn('zh', 'grid.cell', 4), '4 格');
});

test('数字 0 走复数形式（英文 0 results 才是对的）', () => {
  assert.equal(tn('en', 'grid.item', 0), '0 items');
});

/* ---------------- 语言识别 ---------------- */

test('系统语言归一化：zh-CN / en-US / EN / ja-JP / 繁体都认得，法语认不出', () => {
  assert.equal(normalizeLocale('zh-CN'), 'zh');
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('EN'), 'en');
  assert.equal(normalizeLocale('ja-JP'), 'ja');
  assert.equal(normalizeLocale('ja'), 'ja');
  // `jp` 是常见的误写，一并认成日语
  assert.equal(normalizeLocale('jp-JP'), 'ja');
  // 繁体必须早于笼统的 `zh-` 判：否则 zh-TW 会被当简体
  assert.equal(normalizeLocale('zh-TW'), 'zh-TW');
  assert.equal(normalizeLocale('zh-HK'), 'zh-HK');
  assert.equal(normalizeLocale('zh-Hant'), 'zh-TW');
  assert.equal(normalizeLocale('zh-Hant-HK'), 'zh-HK');
  assert.equal(normalizeLocale('zh_TW'), 'zh-TW');
  assert.equal(normalizeLocale('zh-MO'), 'zh-HK');
  assert.equal(normalizeLocale('tw'), 'zh-TW');
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh');
  assert.equal(normalizeLocale('fr-FR'), null);
  assert.equal(normalizeLocale(''), null);
});

test('首次启动猜语言：按顺序取第一个认得的，全不认得就中文', () => {
  assert.equal(guessLocale(['fr-FR', 'en-GB']), 'en');
  assert.equal(guessLocale(['zh-CN', 'en-US']), 'zh');
  assert.equal(guessLocale(['ja-JP', 'ko-KR']), 'ja');
  assert.equal(guessLocale(['ko-KR', 'zh-CN']), 'zh');
  assert.equal(guessLocale([]), 'zh');
  assert.equal(guessLocale(undefined), 'zh');
});

test('isLocale 只认已支持的语言', () => {
  assert.equal(isLocale('zh'), true);
  assert.equal(isLocale('en'), true);
  assert.equal(isLocale('ja'), true);
  assert.equal(isLocale('zh-TW'), true);
  assert.equal(isLocale('zh-HK'), true);
  assert.equal(isLocale('en-US'), false);
  assert.equal(isLocale('fr'), false);
  assert.equal(isLocale(null), false);
});

test('html lang 跟着语言走（简中 zh-CN / 繁中 zh-Hant-* / 英 en / 日 ja）', () => {
  assert.equal(htmlLang('zh'), 'zh-CN');
  assert.equal(htmlLang('zh-TW'), 'zh-Hant-TW');
  assert.equal(htmlLang('zh-HK'), 'zh-Hant-HK');
  assert.equal(htmlLang('en'), 'en');
  assert.equal(htmlLang('ja'), 'ja');
});

/* ---------------- 共享模块的输出也跟着语言走 ---------------- */

test('时期 / 调式：英文界面给英文标签，默认仍然是中文', () => {
  assert.equal(periodLabel('contemporary', 'en'), 'Contemporary');
  assert.equal(periodLabel('baroque', 'en'), 'Baroque');
  // 繁体走「逐字转繁」：巴洛克同形，浪漫主义要变「浪漫主義」
  assert.equal(periodLabel('romantic', 'zh-TW'), '浪漫主義');
  assert.equal(keyModeLabel('natural minor', 'zh-HK'), '自然小調');
  assert.equal(keyModeLabel('natural minor', 'en'), 'Natural minor');
  assert.equal(periodLabel('baroque'), '巴洛克');
  // 词典没收录的规范值不猜，原样返回
  assert.equal(periodLabel('whatever', 'en'), 'whatever');
});

test('和弦描述：英文整句都是英文，默认仍然是中文', () => {
  const v7 = parseChord('V7');
  const en = describeChord(v7, 'en');
  assert.match(en, /degree 5/);
  assert.match(en, /dominant seventh/);
  assert.match(en, /root position/);
  assert.doesNotMatch(en, /[\u4e00-\u9fff]/);
  assert.match(describeChord(parseChord('@@'), 'en'), /cannot parse/);
  // 日语：整句日语，不能漏出中文的「级」「原位」
  const ja = describeChord(v7, 'ja');
  assert.match(ja, /属七の和音/);
  assert.match(ja, /基本形/);
  assert.doesNotMatch(ja, /级|原位|小七/);
  // 繁体：整句正体，不许漏出简体字
  const tw = describeChord(v7, 'zh-TW');
  assert.match(tw, /屬七和絃|屬七和弦/);
  assert.match(tw, /原位/);
  // 中文默认不变
  assert.match(describeChord(v7), /5 级/);
  assert.match(describeChord(parseChord('@@')), /无法解析/);
  assert.equal(degreeName(5, 'en'), 'dominant');
  assert.equal(degreeName(5), '属');
});
