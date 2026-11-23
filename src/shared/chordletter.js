/**
 * 级数 → 字母和弦（`V7` → `G7`）的**反向拼写**。
 *
 * 为什么单独一个文件、不写进 `chord.js`：`chord.js` 一改就要 `CHORD_PARSER_VERSION + 1`
 * （红线 4：库里会留着旧解析结果）。这里只把**解析结果**翻译成另一种写法，
 * 解析行为一个字节都没变，不该连累全库重算。
 *
 * 三条原则：
 * 1. **只翻译，不猜**。查不到的「性质 + 七音」组合直接返回 null，由调用方跳过并报数。
 *    猜一个差不多的写法比不写更糟 —— 用户会以为那是机器算对的。
 * 2. **写完再验一遍**：把拼出来的字母和弦重新解析，音级集合（和低音）必须和原级数一致。
 *    不一致就丢弃。这条能兜住终止四六（`Cad64` 的根音在 I、低音在 V，一个 rootName 表达不了）、
 *    以及各种我没预料到的边角。
 * 3. 终止四六**一律跳过**：`Cad64` 的字母写法是 `C/G`（I 6/4），但解析结果里 rootName 是 V，
 *    硬拼会得到 `G`（G–B–D），错得很自然，所以宁可不算。
 */

import { parseChord } from './chord.js';

/** 「性质 | 七音」→ 字母和弦的后缀。查不到就是 null（不猜） */
const SUFFIX = {
  'major|none': '',
  'major|minor': '7',
  'major|major': 'maj7',
  'minor|none': 'm',
  'minor|minor': 'm7',
  'minor|major': 'mMaj7',
  'dim|none': 'dim',
  'dim|minor': 'm7♭5',
  'dim|half-dim': 'm7♭5',
  'dim|dim': 'dim7',
  'aug|none': 'aug',
  'aug|minor': '7♯5',
  'sus4|none': 'sus4',
  'sus4|minor': '7sus4',
  'sus2|none': 'sus2',
  'sus2|minor': '7sus2',
};

/** 延伸音怎么接在已有的后缀上。同样：没有把握就不接 */
const WITH_EXT = {
  '': (e) => `add${e}`,
  m: (e) => `madd${e}`,
  '7': (e) => e,
  maj7: (e) => `maj${e}`,
  m7: (e) => `m${e}`,
  mMaj7: (e) => `mMaj${e}`,
  '7sus4': (e) => `${e}sus4`,
  '7sus2': (e) => `${e}sus2`,
};

const pcsKey = (p) =>
  [...new Set((p?.pcs ?? []).map((n) => ((n % 12) + 12) % 12))].sort((a, b) => a - b).join(',');

/**
 * 解析结果 → 字母和弦写法（`G7` / `D♭/F` / `B♭9sus4`）。
 *
 * @returns 拼不出来 / 拼完对不上音级集合时返回 null。
 */
export function letterFromRoman(parsed) {
  const p = parsed;
  if (!p || p.ok !== true || p.kind !== 'roman' || !p.rootName) return null;
  // 终止四六：rootName 是 V、实际和弦是 I 6/4，拼 `G` 会得到 G–B–D。跳过。
  if (p.cadential) return null;

  let base = SUFFIX[`${p.quality}|${p.seventh}`];
  if (base === undefined || base === null) return null;

  const ext = (p.extensions ?? []).filter(Boolean);
  // 多个延伸音（V9·11·13）不拼：括号写法有多种，拼法不同音级集合就可能变
  if (ext.length > 1) return null;
  if (ext.length === 1) {
    const raw = String(ext[0]);
    // `Vadd9` 的 extensions 存的是「add9」—— 没有七音的直接挂上去，别当延伸音处理
    if (raw.startsWith('add')) {
      const e = raw.slice(3);
      if (!['9', '11', '13'].includes(e)) return null;
      if (base === '') base = `add${e}`;
      else if (base === 'm') base = `madd${e}`;
      else return null;
    } else {
      if (!['9', '11', '13'].includes(raw)) return null;
      const fn = WITH_EXT[base];
      if (!fn) return null;
      base = fn(raw);
    }
  }
  // 六音替五音（V7sub6）：字母侧就叫 7sub6，词表里认这个写法
  if (p.sub6) {
    if (base !== '7') return null;
    base = '7sub6';
  }

  const text = `${p.rootName}${base}${p.bassName && p.bassName !== p.rootName ? `/${p.bassName}` : ''}`;

  // 写完再验：音级集合一致、低音一致，才算翻译成功
  const back = parseChord(text);
  if (!back?.ok || back.kind !== 'absolute') return null;
  if (pcsKey(back) !== pcsKey(p)) return null;
  if (((back.bassPc ?? 0) % 12) !== ((p.bassPc ?? 0) % 12)) return null;
  return text;
}

/** 便捷版：直接给级数文本 + 上下文（没有预解析结果时用） */
export function letterFromDegreeText(text, ctx) {
  return letterFromRoman(parseChord(text, ctx));
}
