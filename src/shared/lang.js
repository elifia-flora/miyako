/**
 * lang.js — 曲目「原语言」的取值规范
 *
 * schema v4 起 `title.lang` 只存**短代码**（`en` / `ja` / `zh`…），不再存 "English" 这种
 * 英文全名。理由：
 *   1. 它是**值**不是文案 —— 全名是英文，中文界面里出现 "Japanese" 只能原样显示，
 *      想翻成「日语」就得先认全名，等于把两套词表长期同步；
 *   2. 短代码是 BCP-47 的前缀，以后接系统语言、歌词翻译、发音标记都能直接用。
 *
 * 老档案（v3 及更早）全是全名，所以**读的时候一律过 `normalizeLang`**：
 * 手改的文件、别处导入的文件、以前的 DB 行都能被认成同一个代码。
 */

/** 全名 / 别名 → BCP-47 主语言标签。键一律小写 */
const NAME_TO_CODE = {
  // 中文（含方言）
  chinese: 'zh',
  mandarin: 'zh',
  '中文': 'zh',
  汉语: 'zh',
  普通话: 'zh',
  cantonese: 'yue',
  '粤语': 'yue',
  // 东亚
  japanese: 'ja',
  '日本語': 'ja',
  日语: 'ja',
  korean: 'ko',
  韩语: 'ko',
  // 欧洲主要语言
  english: 'en',
  french: 'fr',
  german: 'de',
  italian: 'it',
  spanish: 'es',
  portuguese: 'pt',
  russian: 'ru',
  polish: 'pl',
  latin: 'la',
  拉丁语: 'la',
  // 人工语言与「无人声」
  instrumental: 'zxx', // ISO 639-2：无语言内容
  none: 'zxx',
};

/**
 * 把任意写法归一成短代码。
 *
 * - `"English"` / `"en"` / `"en-US"` → `en`
 * - `"Japanese"` → `ja`
 * - 空 / 认不出 → `null`（JSON 里干脆不写这个键，而不是写个空字符串）
 */
export function normalizeLang(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // 已经是代码（含 en-US / zh-Hant 这种）：取主标签
  if (/^[a-z]{2,3}([_-][a-z0-9]{2,8})*$/.test(lower)) return lower.split(/[-_]/)[0];

  return NAME_TO_CODE[lower] ?? NAME_TO_CODE[raw] ?? null;
}

/**
 * 这段文字「读起来像哪种语言」—— 只够用来从别名里挑译名，**不是语言识别**。
 *
 * 判据只有一块：它用的是哪套字母。
 *   - 有假名 → ja（日文里汉字再多，只要夹着假名就是日文）
 *   - 有谚文 → ko
 *   - 只有汉字 → zh
 *   - 拉丁字母 → en（罗马字转写、外语原名、乐队名都落在这里）
 * 越南语/俄语等也各有一档，够用；认不出的返回 null。
 */
export function scriptOf(value) {
  const s = String(value ?? '');
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';
  if (/[\uac00-\ud7af]/.test(s)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
  if (/[\u0400-\u04ff]/.test(s)) return 'ru';
  if (/[A-Za-z]/.test(s)) return 'en';
  return null;
}

/**
 * 从曲目的别名里挑一条「用户语言的译名」。
 *
 * 为什么从别名里挑、而不是新开一个 `title.translations` 字段：
 * 别名本来就是用户手填的「这首还能叫什么」，里面既有译名（成人法则），
 * 也有罗马字转写（Otona no Okite）和乐队名（Doughnuts Hole）。
 * 按**字符集**挑能把这三种分开，而且老档案一个字都不用改。
 *
 * 下列情况一律**不显示**（宁可空着，也不显示一个错的）：
 *   - 不知道原语言（`lang` 为空）；
 *   - 原语言就是用户语言（中文界面看中文标题，不需要括号译名）；
 *   - 别名里没有一条读起来是用户语言的。
 */
export function pickTitleTranslation(title, locale) {
  const want = normalizeLang(locale) ?? 'zh';
  const lang = normalizeLang(title?.lang);
  const original = String(title?.original ?? title?.title ?? '').trim();
  if (!lang || lang === want || !original) return null;
  const list = Array.isArray(title?.aliases) ? title.aliases : [];
  const fold = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (!s || fold(s) === fold(original)) continue;
    if (scriptOf(s) === want) return s;
  }
  return null;
}
