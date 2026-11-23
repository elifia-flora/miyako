/**
 * meter.js — 拍号「类型」的派生规则（单拍子 / 复拍子 / 混合拍子）
 *
 * 为什么要有这个文件：拍号本身只有两个数字（`4/4`），「单/复」是**分类结论**，
 * 不是数据。把它写进 JSON 或库里，等于把一条规则的结果冻成事实 ——
 * 规则改了、换了体系，旧数据立刻自相矛盾，而且没人知道该信哪个。
 * 所以 schema v4 起 `basic.meterType` 从档案里删掉，一律现算。
 *
 * ## 两套体系为什么会打架
 *
 * | | 判据 | 4/4 的结论 |
 * |---|---|---|
 * | 中 / 苏 / 德奥 | 一小节由**几个重音组**组成：两个 → 复拍子 | **复拍子**（2/4 + 2/4） |
 * | 英美 | **一拍内部**能不能均分成两份：能 → simple | **simple meter**（"单拍子"） |
 *
 * 中文里的「单拍子」承袭自俄语（простые размеры）再往上到德语（einfache Taktart），
 * 和英美的 "simple meter" 只是字面撞车，判据不同 —— 不能一对一翻译。
 * 6/8、9/8、12/8 两边都叫复（compound），5/8、7/8 两边都算「混合 / 不规则」，
 * 真正会让人疑惑的只有分子为 4 的拍号，界面只给它挂 ⓘ 说明。
 *
 * 体系由**界面语言**决定：中文界面 → 中/苏/德奥；其它 → 英美。
 * 这是刻意的：你用什么语言读乐理，就用那套术语。
 */

/** @typedef {'simple' | 'compound' | 'mixed'} MeterKind */
/** @typedef {'cn' | 'us'} MeterSystem */

/**
 * 界面语言 → 用哪套术语。
 * @param {string} locale
 * @returns {MeterSystem}
 */
export function meterSystemForLocale(locale) {
  return String(locale ?? '')
    .toLowerCase()
    .startsWith('zh')
    ? 'cn'
    : 'us';
}

/**
 * 派生拍号类型。
 *
 * 规则（两套体系共用骨架，只在 4 的整数倍上分岔）：
 * - 分子 1 / 2 / 3        → 单拍子（每小节一个重音组）
 * - 分子 6 / 9 / 12 …（3 的倍数）→ 复拍子（三个一组叠起来）
 * - 分子 4（4/4、4/2、4/8）→ **分岔**：中/苏/德奥 = 复拍子（2+2）；英美 = 单拍子
 * - 其余（5、7、8、10、11…）→ 混合拍子（二连与三连混着来）
 *
 * @param {number} num 分子
 * @param {number} den 分母（只在 4 的分岔里不参与判断：4/4 与 4/8 结论一致）
 * @param {MeterSystem} [system]
 * @returns {{
 *   kind: MeterKind,
 *   system: MeterSystem,
 *   ambiguous: boolean,
 *   alt: { system: MeterSystem, kind: MeterKind } | null,
 *   num: number,
 *   den: number,
 * }}
 */
export function classifyMeter(num, den, system = 'cn') {
  const n = Math.max(1, Math.round(Number(num) || 0));
  const d = Math.max(1, Math.round(Number(den) || 0));
  const sys = system === 'us' ? 'us' : 'cn';

  let kind = kindOf(n, sys);
  // 另一套体系怎么看同一个拍号：判据完全不同，所以直接重算，不做「近似换算」
  const otherSys = sys === 'cn' ? 'us' : 'cn';
  const altKind = kindOf(n, otherSys);
  const ambiguous = altKind !== kind;

  return {
    kind,
    system: sys,
    ambiguous,
    alt: ambiguous ? { system: otherSys, kind: altKind } : null,
    num: n,
    den: d,
  };
}

/** @returns {MeterKind} */
function kindOf(n, sys) {
  if (n <= 3) return 'simple';
  if (n === 4) return sys === 'cn' ? 'compound' : 'simple';
  if (n % 3 === 0) return 'compound';
  return 'mixed';
}

/**
 * `"4/4"` → `{ num, den }`；认不出返回 null。
 * （`barbeat.js` 里那个 `parseMeter` 带默认值兜底，这里是「能读出来才算」，用途不同）
 */
export function readMeter(text) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  return num > 0 && den > 0 ? { num, den } : null;
}

/**
 * 一次性把界面要的三样都算出来：类型、标签键、ⓘ 说明键。
 * 调用方只负责 `t()` —— 规则和文案彻底分开，i18n 新增语言不用碰这个文件。
 *
 * @param {string} meterText 形如 `4/4`
 * @param {MeterSystem} system
 */
export function meterInfo(meterText, system = 'cn') {
  const parsed = readMeter(meterText);
  if (!parsed) return null;
  const info = classifyMeter(parsed.num, parsed.den, system);
  return {
    ...info,
    /** `meter.kind.simple` / `meter.kind.compound` / `meter.kind.mixed` */
    kindKey: `meter.kind.${info.kind}`,
    /**
     * ⓘ 里那段解释。只有「两套体系结论不同」时才有内容 ——
     * 一样的时候挂个图标纯属噪音。
     */
    noteKey: info.ambiguous ? `meter.note.${info.num}` : null,
  };
}
