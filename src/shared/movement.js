/**
 * 乐章标题的序数与术语插入。
 *
 * 序数前缀是「默认值」，不是只读的编号：登记乐章时先给「第三乐章」/「III.」，
 * 光标落在末尾，用户直接往后补「行板」「Menuetto - Allegretto」。
 * 所以这里的函数只做三件事：算下一个序数、认出已有标题里的序数、把术语接到正确的位置。
 *
 * 单独放 shared：主进程写默认标题、渲染层的输入框补全、单测都要用同一套规则。
 * 两处各写一份，迟早会在「第 10 乐章」或「省略空格」这种边角上分叉。
 */
import { isHant, toHant } from './hant.js';

const HAN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 汉字数字读法：1 → 一、10 → 十、11 → 十一、20 → 二十、101 → 一百零一 */
export function hanNumber(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 10) return HAN_DIGITS[v];
  if (v < 20) return `十${v % 10 ? HAN_DIGITS[v % 10] : ''}`;
  if (v < 100) return `${HAN_DIGITS[Math.floor(v / 10)]}十${v % 10 ? HAN_DIGITS[v % 10] : ''}`;
  if (v < 1000) {
    const rest = v % 100;
    if (!rest) return `${HAN_DIGITS[Math.floor(v / 100)]}百`;
    if (rest < 10) return `${HAN_DIGITS[Math.floor(v / 100)]}百零${HAN_DIGITS[rest]}`;
    return `${HAN_DIGITS[Math.floor(v / 100)]}百${hanNumber(rest)}`;
  }
  return String(v);
}

const ROMAN_TABLE = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** 罗马数字：1 → I、4 → IV、9 → IX、14 → XIV。超过 3999 退回阿拉伯数字 */
export function romanNumber(n) {
  let v = Math.max(1, Math.round(Number(n) || 1));
  if (v > 3999) return String(v);
  let out = '';
  for (const [value, symbol] of ROMAN_TABLE) {
    while (v >= value) {
      out += symbol;
      v -= value;
    }
  }
  return out;
}

/**
 * 默认乐章标题前缀。
 * 中文：`第三乐章`；英文：`III.`（用户接着打 `Menuetto - Allegretto`）。
 * 末尾不带空格 —— 标题要落库，输入框里由用户自己敲第一个空格。
 */
export function movementPrefix(n, locale = 'zh') {
  const i = Math.max(1, Math.round(Number(n) || 1));
  if (locale === 'en') return `${romanNumber(i)}.`;
  // 日语乐谱里「第3楽章」比「第三楽章」常见，直接用阿拉伯数字
  if (locale === 'ja') return `第${i}楽章`;
  // 繁体只差一个字形（乐→樂），复用同一套汉字数字
  if (isHant(locale)) return toHant(`第${hanNumber(i)}乐章`);
  return `第${hanNumber(i)}乐章`;
}

const HAN_VALUE = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 解析汉字 / 阿拉伯数字串，认不出来返回 null */
function parseHanNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let section = 0;
  let num = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in HAN_VALUE) {
      num = HAN_VALUE[ch];
      seen = true;
    } else if (ch === '十') {
      section += (num || 1) * 10;
      num = 0;
      seen = true;
    } else if (ch === '百') {
      section += (num || 1) * 100;
      num = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? section + num : null;
}

const ROMAN_VALUE = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function parseRoman(raw) {
  const s = String(raw ?? '').toUpperCase();
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN_VALUE[s[i]];
    const next = ROMAN_VALUE[s[i + 1]] ?? 0;
    total += v < next ? -v : v;
  }
  return total > 0 ? total : null;
}

/**
 * 从已有标题里认出乐章序号。
 * 认三种写法：`第三乐章` / `3.` / `III.`（也收全角点和括号）。
 */
export function parseMovementOrdinal(title) {
  const s = String(title ?? '').trim();
  if (!s) return null;

  const zh = s.match(/^第\s*([0-9零〇一二两三四五六七八九十百]+)\s*乐章/);
  if (zh) return parseHanNumber(zh[1]);

  const ar = s.match(/^(\d+)\s*[.、．:：)）]/);
  if (ar) return Number(ar[1]);

  const ro = s.match(/^([IVXLCDMivxlcdm]+)\s*[.、．:：)）]/);
  if (ro) return parseRoman(ro[1]);

  const en = s.match(/^(?:Movement|Mov\.?)\s*(\d+)/i);
  if (en) return Number(en[1]);

  return null;
}

/**
 * 下一个乐章序号 = 已有序号的最大值 + 1；一个都认不出来时退回「条数 + 1」。
 * 用 max 而不是条数：删掉第二乐章后再登记，不该又生出一个「第二乐章」。
 */
export function nextMovementOrdinal(titles = []) {
  let max = 0;
  for (const title of titles) {
    const n = parseMovementOrdinal(title);
    if (n && n > max) max = n;
  }
  return max > 0 ? max + 1 : Math.max(1, titles.length + 1);
}

const DELIM_RE = /\s[-–—·；;－]\s/;

/**
 * 取已有标题里的**序数前缀原文**（`第三乐章` / `III.` / `3.` / `Movement 3`），认不出返回 ''。
 *
 * 右键「更改标题」没有「刚登记时生成的前缀」可以传，靠它把补全接回前缀之后：
 * 否则 `第一乐章 行板` 会被当成一整段去匹配，怎么打都不出候选
 * （只有手打 ` - ` 之后才碰巧匹配到后半段）。前缀是原文而不是重新生成，
 * 这样全角点、括号、`Movement` 这些写法都能原样保留。
 */
export function movementTitlePrefix(title) {
  const s = String(title ?? '').trim();
  if (!s) return '';
  const patterns = [
    /^第\s*[0-9零〇一二两三四五六七八九十百]+\s*乐章/,
    /^\d+\s*[.、．:：)）]/,
    /^[IVXLCDMivxlcdm]+\s*[.、．:：)）]/,
    /^(?:Movement|Mov\.?)\s*\d+/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[0].trim();
  }
  return '';
}

/**
 * 找出「当前该补全的那一段」。
 *
 * 有前缀（刚登记的新乐章）时只看前缀之后；没有显式前缀（右键「更改标题」）时
 * 从文本自己的序数开头认一个前缀；然后以最后一个 ` - ` / ` · ` 为界，
 * 只补最后一段 —— `III. Menuetto - All` 要补的是 `All`，不是整串。
 * 返回的 `start` 是原文里的下标，插入时直接从那里替换。
 */
export function movementFragment(text, prefix = '') {
  let s = String(text ?? '');
  let base = 0;
  let p = String(prefix ?? '');
  if (!p) p = movementTitlePrefix(s);
  if (p && s.startsWith(p)) {
    base = p.length;
    while (s[base] === ' ') base++;
  }
  const rest = s.slice(base);
  let cut = 0;
  const m = [...rest.matchAll(new RegExp(DELIM_RE.source, 'g'))].pop();
  if (m) cut = (m.index ?? 0) + m[0].length;
  const start = base + cut;
  return { start, fragment: s.slice(start).trim() };
}

/**
 * 把选中的术语接到标题里。
 *
 * - 已经打了半截（`All`）→ 原地替换；
 * - 只有前缀（`III.` / `第三乐章`）→ 空格接上；
 * - 前面已经有一段术语 → ` - ` 接上（`III. Menuetto - Allegretto`）。
 */
export function applyMovementTerm(text, prefix, termText) {
  const term = String(termText ?? '').trim();
  const s = String(text ?? '');
  if (!term) return s;
  // 没显式前缀时和 movementFragment 一样从标题里认，保证右键改名与新建乐章落法一致
  const p = String(prefix ?? '').trim() || movementTitlePrefix(s);
  const { start } = movementFragment(s, p);
  const before = s.slice(0, start);
  const hasFragment = start < s.length && s.slice(start).trim() !== '';
  if (hasFragment) return before + term;
  if (!before.trim()) return term;
  if (/[-\u2013\u2014\u00b7；;－]\s*$/.test(before) || /\s$/.test(before)) {
    return before + term;
  }
  if (p && before.trim() === p) {
    return `${before.trimEnd()} ${term}`;
  }
  return `${before.trimEnd()} - ${term}`;
}

/**
 * 「正在补的那一小段」：去掉仍在写的变量（`%Tempo Term}`），再取最后一串
 * 汉字或拉丁字母。
 *
 * 为什么不直接用整段：用户已经有「第二乐章 柔板」之后接着打 `Al` 时，
 * 整段是 `柔板 - Al` / `柔板Al` 这种拼接，按整段去匹配一条都对不上，
 * 界面上就表现为「加了字反而不弹候选」。
 */
export function movementMatchToken(fragment) {
  const t = String(fragment ?? '').replace(/%[^%}]*}/g, ' ').trim();
  if (!t) return '';
  const parts = t.match(/[\u3400-\u9fff]+|[A-Za-z][A-Za-z.'’]*/g);
  return (parts && parts.length ? parts[parts.length - 1] : t).trim();
}
