/**
 * 调性（key）输入补全：音名 × 调式。
 *
 * 库里存的是 `analysis_marker.key_name`，写法形如 `c dorian` / `g natural minor` /
 * `c-sharp natural minor`（小写、音名与调式之间一个空格）。这个模块只负责
 * 「用户敲了几个字 → 大概想写哪一条」，**不做校验、不拦自由输入**：
 * 认不出来就返回空数组，调用方照旧把原文存进去（调性允许是任何写法）。
 *
 * 为什么不复用 chord.js 的 parseKeyName：它解析的是**已经规范**的库值
 * （`c-sharp natural minor` → pc + mode），而这里要处理 `C#`、`降e`、`多利`、`harm`
 * 这些半成品输入。两者刻意分开，但 tests/keyname.test.mjs 里有 round-trip 断言：
 * 每个候选的 value 喂回 parseKeyName 必须解析成同一个音与调式。
 */
import { KEY_MODES, pickLabel } from './search.js';

/** 12 个音名 → 拼音名（value 里用）。同一个 pitch class 只给一个首选拼法。 */
const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];

/** 候选里 major / natural minor 排最前：这两个写法占了绝大多数 */
const MODE_ORDER = ['major', 'natural minor'];

/**
 * 输入 → `{ letter, acc, rest }`
 * - `acc` 是 '' / 'sharp' / 'flat'
 * - `rest` 是音名之后的剩余文字（可能是空、`dor`、`自然小调`、`-sharp` 之类已被吃掉）
 * 认不出音名返回 null。
 */
export function parseKeyRoot(text) {
  let s = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[♯＃]/g, '#')
    .replace(/[♭]/g, 'b');
  if (!s) return null;
  // 中文升降号写在字母前面：升c / 降e / 升 c
  s = s.replace(/^([升降])\s*([a-g])/, (_, acc, letter) => `${letter}${acc === '升' ? '#' : 'b'}`);

  // `[\s-]*` 而不是 `\s*`：库里的写法是 `c-sharp` / `e-flat`，连字符要紧跟字母
  const m = s.match(/^([a-g])(?:[\s-]*(#|sharp|b|flat|升|降))?/);
  if (!m) return null;
  const letter = m[1];
  const raw = m[2] ?? '';
  const acc = raw === '#' || raw === 'sharp' || raw === '升' ? 'sharp' : raw ? 'flat' : '';
  // 兜底：`b` 既是字母也是降号，"bb" 会被拆成 b + b。字母后面紧跟同一字母且是 b 时，
  // 上面的正则已经正确处理（m[1]='b', m[2]='b'），这里不用再做特判。
  // rest 去掉残留的分隔符：`c- dorian` / `c -dorian` 这类手写习惯不该让调式匹配失效
  return { letter, acc, rest: s.slice(m[0].length).replace(/^[\s-]+/, '').trim() };
}

/** 规范主音写法：c / c-sharp / e-flat */
function rootValue(root) {
  return root.acc ? `${root.letter}-${root.acc}` : root.letter;
}

/** 显示用主音：C / C# / Eb */
function rootLabel(root) {
  const up = root.letter.toUpperCase();
  const acc = root.acc === 'sharp' ? '#' : root.acc === 'flat' ? 'b' : '';
  return `${up}${acc}`;
}

/** 调式按「major → natural minor → 其余」排，同分时保持这个顺序 */
function modeRank(id) {
  const i = MODE_ORDER.indexOf(id);
  return i >= 0 ? i : MODE_ORDER.length + KEY_MODES.findIndex((m) => m.id === id);
}

/**
 * @param {string} input 已敲内容（`c` / `c dor` / `C# 自然小调` / `降e` / `e-flat harm`）
 * @param {string} locale 只影响 label，不影响 value（'en' 出英文，其它出中文）
 * @param {number} limit 最多给几条
 * @returns {{ value: string, root: string, mode: string, label: string }[]}
 */
export function suggestKeyNames(input, locale = 'zh', limit = 8) {
  const root = parseKeyRoot(input);
  if (!root) return [];
  const q = root.rest.trim().toLowerCase();
  const value = rootValue(root);
  const head = rootLabel(root);

  const rows = [];
  for (const mode of KEY_MODES) {
    let score = 0;
    if (!q) {
      // 只敲了音名：把所有调式按固定顺序铺开（major / natural minor 在最前）
      score = 50;
    } else {
      for (const term of mode.terms ?? []) {
        const t = String(term).toLowerCase();
        if (!t) continue;
        const s = t === q ? 100 : t.startsWith(q) ? 80 : q.length >= 2 && t.includes(q) ? 60 : 0;
        if (s > score) score = s;
      }
      // 调式 id 本身也认（`c natural minor` 的 id 用空格，terms 里未必有完整写法）
      const id = String(mode.id ?? '').toLowerCase();
      if (id) {
        const s = id === q ? 100 : id.startsWith(q) ? 80 : q.length >= 2 && id.includes(q) ? 60 : 0;
        if (s > score) score = s;
      }
      if (!score) continue;
    }
    rows.push({
      value: `${value} ${mode.id}`,
      root: value,
      mode: mode.id,
      score,
      rank: modeRank(mode.id),
      label: `${head} ${pickLabel(mode, locale)}`,
    });
  }

  rows.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return rows.slice(0, Math.max(1, limit)).map(({ value: v, root: r, mode, label }) => ({ value: v, root: r, mode, label }));
}
