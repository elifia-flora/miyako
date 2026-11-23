/**
 * 罗马数字 / 绝对和弦 → **斯波索宾（苏俄）体系**标记。
 *
 * 写法约定（2026-11-04 与用户逐条对过）：
 *
 * 1. **原位三和弦不带数字**：`T` / `S` / `D` / `SII` / `DTIII`。只有转位才加数字。
 * 2. **苏俄习惯先读小数字再读大数字**：所以三和弦的第二转位写 `46`，不写 `64`
 *    （终止四六本来就是 `K46`，同一条规则）。七和弦四转位照旧 `7 / 65 / 43 / 2`。
 * 3. **大小写跟和弦性质走**，不跟调号走：
 *    - 大调里可以出现小 `s`（借用小下属，让自然大调「和声大调化」）
 *    - 小调里和声属和弦是大三和弦 → 大写 `D`；自然小调的 v 是小三和弦 → 小写 `d`
 * 4. **副和弦的级数永远大写**：`SII` / `DTIII` / `TSVI` / `DVII` / `dtVII`。
 *    小调里前缀按「有没有升导音」分：
 *    - 自然七级（大三和弦，没有升导音）→ `dtVII`
 *    - 升导音的七级（减三 / 减七）→ `DVII`
 *    - 自然三级（大三）→ `dtIII`；和声小调的增三 → `DtIII`（D 大写、t 保留小写）
 *    - 六级 → `tsVI`
 * 5. **不猜**：副属 / 离调（`V7/ii`）、那不勒斯（`N6`）、借用和弦（`♭VI`）、
 *    延伸音（`V9`）、挂留、六音替五音一律返回 null —— 斯波索宾对它们各有写法，
 *    硬套会生成「看着像对的错标记」。调用方跳过并报数即可。
 *
 * 为什么不放进 `chord.js`：那个文件一改就要 `CHORD_PARSER_VERSION + 1`（全库重算）。
 * 这里只做翻译，解析行为一个字节都没动。
 */

import { parseChord, parseKeyName, degreeOfChord } from './chord.js';

/**
 * 每个级数在该调式里**允许**的三和弦性质。
 *
 * 这一层是「字母和弦反推」的守门员：`D7` 在 C 大调会被反推成 II 级，
 * 若不管性质就会拼出一个像模像样的 `SII7` —— 可那是个属七和弦，根本不是 SII。
 * 表里只放真正会出现的情况：大调的四级允许小三（借用小下属，用户明确要的）。
 */
const DIATONIC_QUALITY = {
  major: { 1: ['major'], 2: ['minor'], 3: ['minor'], 4: ['major', 'minor'], 5: ['major'], 6: ['minor'], 7: ['dim'] },
  minor: { 1: ['minor'], 2: ['dim'], 3: ['major', 'aug'], 4: ['minor'], 5: ['major', 'minor'], 6: ['major'], 7: ['major', 'dim'] },
};

/** 三和弦转位：原位不写数字；四六按苏俄习惯写作 46 */
/**
 * 调式算不算「小调那一套」。
 *
 * `parseKeyName` 返回的 mode 是原始尾巴（`harmonic minor` / `natural minor` / `dorian`…），
 * 直接和 `'minor'` 比会把「和声小调」判成大调 —— 于是 `i` 拼不出来、`iiø7` 被性质表挡掉。
 * 五声调式没有大/小之分，按大调处理（性质表会替我们挡掉不合调的），并在文档里写明这是近似。
 */
const MINORISH = /minor|aeolian|dorian|phrygian|locrian/;

const TRIAD_FIG = ['', '6', '46'];
/**
 * 七和弦四转位。
 *
 * **56 / 34 不是笔误**：苏俄（中译本）习惯「先读小数字、再读大数字」——
 * 五六和弦写 `56`、三四和弦写 `34`、四六写 `46`、二写 `2`。
 * 这与国际通行的 `65 / 43 / 64` 是同一批和弦的两种写法，别改回去。
 */
const SEVENTH_FIG = ['7', '56', '34', '2'];

/**
 * 级数 + 和弦性质 + 上下文（大调 / 小调）→ 功能前缀。
 *
 * 抽成单独函数是因为离调要用两次：一次算「应用和弦在临时主音调里的名字」，
 * 一次算「目标和弦在本调里的名字」。
 */
function labelOf(degree, quality, contextMinor) {
  switch (degree) {
    case 1:
      return quality === 'minor' ? 't' : 'T';
    case 2:
      return (contextMinor ? 's' : 'S') + 'II';
    case 3:
      return !contextMinor ? 'DTIII' : quality === 'aug' ? 'DtIII' : 'dtIII';
    case 4:
      return quality === 'minor' ? 's' : 'S';
    case 5:
      return quality === 'minor' ? 'd' : 'D';
    case 6:
      return (contextMinor ? 'ts' : 'TS') + 'VI';
    case 7:
      // 小调的自然七级是大三和弦（没有升导音）→ dtVII；升导音的 vii° → DVII
      return contextMinor && quality === 'major' ? 'dtVII' : 'DVII';
    default:
      return null;
  }
}

/** 转位数字：三和弦原位不带、四六写 46；七和弦 7 / 65 / 43 / 2 */
function figureOf(parsed) {
  const hasSeventh = !!parsed.seventh && parsed.seventh !== 'none';
  const raw = Number(parsed.inversion) || 0;
  if (hasSeventh) return SEVENTH_FIG[Math.min(3, Math.max(0, raw))];
  return TRIAD_FIG[Math.min(2, Math.max(0, raw))];
}

/**
 * 解析结果 → 斯波索宾标记（`T` / `SII7` / `D65` / `K46` …）。
 *
 * @param parsed parseChord 的结果（级数或绝对和弦都行）
 * @param keyName 该 tick 的调性（`c major` / `a minor`）；决定小调的一套写法
 * @returns 拼不出来（非调内 / 副属 / 延伸音…）时返回 null
 */
export function sposobinOf(parsed, keyName) {
  if (!parsed || parsed.ok !== true) return null;
  const key = parseKeyName(keyName);
  if (!key) return null;
  const minorKey = MINORISH.test(String(key.mode ?? ''));

  // 终止四六先认掉：它的 rootName 是 V，但写法是 K46，走后面的分支会拼成 D46
  if (parsed.cadential) return 'K46';

  // 这些在斯波索宾里另有写法，猜不得
  if (parsed.neapolitan) return null;
  if (parsed.sub6) return null; // 六音替五音
  if ((parsed.extensions ?? []).length) return null; // 延伸音（V9 / add9…）
  if (parsed.quality === 'sus2' || parsed.quality === 'sus4') return null;

  /**
   * 离调（副属 / 副导）：用斜杠写法 —— 这是姜之国《音乐考研复习精要·和声学》里的记法。
   *
   * `iii6/III` 在 e♭ 小调 → `DTIII6/dtIII`：
   *   斜杠前 = 应用和弦**以目标为临时主音**时的名字。目标是自然三级（大三和弦），
   *            临时主音调就是大调，所以 `iii6` 写成大调的 `DTIII6`（DT 大写）；
   *   斜杠后 = 目标和弦**在本调里**的名字。本调是小调、目标是自然三级 → `dtIII`（级数 III 大写）。
   *
   * 临时主音调的大小调由解析器的 `appliedMode` 给出（它已经按目标三和弦的性质算过了）。
   */
  if (parsed.appliedTo != null) {
    if ((parsed.appliedAlter ?? 0) !== 0) return null; // 目标带变化音（♭III 之类）：不猜
    /**
     * 重属（属之属）单独一套：`DD` / `DDVII`。
     *
     * 斯波索宾原书对离调大多用斜杠，但「属的属」太常用，专门给了 DD 系列：
     * `V/V` → `DD`、`V7/V` → `DD7`、`vii°7/V` → `DDVII7`，转位照常接数字。
     * 只在目标正好是 V（5 级）且应用和弦是大三/减三时走这条，其它目标仍旧斜杠。
     */
    if (parsed.appliedTo === 5) {
      if (parsed.degree === 5 && parsed.quality === 'major') return 'DD' + figureOf(parsed);
      if (parsed.degree === 7) return 'DDVII' + figureOf(parsed);
    }
    const tempMinor = MINORISH.test(String(parsed.appliedMode ?? ''));
    const tempMode = tempMinor ? 'minor' : 'major';
    const target = labelOf(parsed.appliedTo, tempMinor ? 'minor' : 'major', minorKey);
    const applied = labelOf(parsed.degree, parsed.quality, tempMinor);
    // 应用和弦本身也得是临时主音调里的合法级数（C 大调的 II 级不该是属七）
    const allowedApplied = DIATONIC_QUALITY[tempMode][parsed.degree];
    if (!target || !applied || !allowedApplied || !allowedApplied.includes(parsed.quality)) return null;
    return `${applied}${figureOf(parsed)}/${target}`;
  }

  const deg = degreeOfChord(parsed, keyName);
  if (!deg || !deg.degree || deg.alter !== 0) return null; // 非调内（♭II / ♭VI…）

  const q = parsed.quality; // major / minor / dim / aug
  const allowed = DIATONIC_QUALITY[minorKey ? 'minor' : 'major'][deg.degree];
  if (!allowed || !allowed.includes(q)) return null;

  const label = labelOf(deg.degree, q, minorKey);
  return label ? label + figureOf(parsed) : null;
}

/* ------------------------------------------------------------------ */
/* 补全候选                                                           */
/* ------------------------------------------------------------------ */

/** 大调里会出现的前缀（原位三和弦不带数字，转位才加后缀） */
const BASES_MAJOR = ['T', 'S', 'D', 'DD', 'DDVII', 'SII', 'DTIII', 'TSVI', 'DVII'];
/**
 * 小调里会出现的前缀。
 * 同时列大写 `D`（和声小调的属）与小写 `d`（自然小调的 v）——
 * 补全不替用户判断「这里到底是哪个」，只把两种写法都摆出来。
 */
const BASES_MINOR = ['t', 's', 'd', 'D', 'DD', 'DDVII', 'sII', 'tsVI', 'dtIII', 'DtIII', 'dtVII', 'DVII'];

/** 一个前缀能接的后缀：三和弦三态 + 七和弦四转位 */
const FIG_SUFFIXES = ['', '6', '46', '7', '56', '34', '2'];

/**
 * 「常用」优先表（2026-11-05 用户口径）。
 *
 * S 组里 **S6 / S46 / SII6 / SII7 及其转位**比 S7 的转位常用得多：
 * 打 `S` 的时候，除了完全相等的 `S`，接下来先推这几个，再轮到 `S7` 那一族。
 * 数组顺序 = 同档里的先后；其它前缀没有这张表，按「短 → 长」自然排。
 * 要加别的族的常用项，往这里加一行就行（大小写两套）。
 */
const COMMON_MAJOR = ['S6', 'S46', 'SII6', 'SII46', 'SII7', 'SII56', 'SII34', 'SII2'];
const COMMON_MINOR = ['s6', 's46', 'sII6', 'sII46', 'sII7', 'sII56', 'sII34', 'sII2'];

/**
 * 「同族配对」：功能上真是一对的两个前缀（2026-11-05 用户口径）。
 *
 * 打 `DD56`，第一条当然是 `DD56`，第二条要能顺手给出同转位的 `DDVII56` ——
 * 重属与重导七本来就是同一件事的两种写法，转位也一一对应。
 * `D7` ↔ `DVII7`、`S56` ↔ `SII56` 同理。
 *
 * **写成显式表，而不是「凡是以 D 开头的都排前面」**：后者会把 `DTIII7` 塞成 `D7` 的第二条，
 * 那是另一个功能（三级），不是「另一种写法」。
 */
const SIBLINGS = {
  S: ['SII'],
  SII: ['S'],
  s: ['sII'],
  sII: ['s'],
  D: ['DVII'],
  DVII: ['D'],
  d: ['dtVII'],
  dtVII: ['d'],
  DD: ['DDVII'],
  DDVII: ['DD'],
};

/**
 * 把一条标记拆成「前缀 + 转位数字」：`SII56` → `{ base: 'SII', fig: '56' }`。
 * 原位三和弦的 fig 是空串。
 */
function splitBaseFig(text) {
  const s = String(text ?? '');
  const m = s.match(/^(.*?)(\d*)$/);
  return { base: m ? m[1] : s, fig: m ? m[2] : '' };
}

/** 大小写互换第一个字母：用来在小调里认大写 `S`、在大调里认小写 `s` */
function swapCaseHead(base) {
  if (!base) return base;
  const head = base.slice(0, 1);
  const rest = base.slice(1);
  return head === head.toUpperCase() ? head.toLowerCase() + rest : head.toUpperCase() + rest;
}

/**
 * 六级（`tsVI` / `TSVI`）的转位顺序，**和别的族不一样**（2026-11-07 用户口径）：
 * 原位 → 六 → 七 → 五六 → 三四 → 二 → 四六。
 * 也就是三和弦的「四六」（46）沉到最后 —— 六级四六在实际分析里几乎不出现，
 * 让它挤在六和弦旁边只会挡路。
 */
const TSVI_FIG_ORDER = { '': 0, '6': 1, '7': 2, '56': 3, '34': 4, '2': 5, '46': 6 };

/**
 * 打这些键时，**六级系列直接顶到最前面**（2026-11-07 用户口径）。
 *
 * 为什么是这几个：本体系里 `V` / `VI` 不是功能符号，用户打 `v` 只可能是在找
 * 六级（`tsVI`）或七级（`DVII`）；打 `t` / `ts` 时最常接的也是 `tsVI`。
 * 所以 `t / ts / tsv / tsvi / v / vi` 全部把六级排第一，往后才是主和弦等。
 *
 * **这条与「完全相等永远第一」冲突**（打 `t` 时第一条不是 `t`），是用户明确要的，
 * 别再按旧规则「修正」回去。
 */
const TSVI_KEYS = new Set(['t', 'ts', 'tsv', 'tsvi', 'v', 'vi']);

/** 打 `t` / `T` 时，主和弦七和弦四转位的次序：`t7 → t56 → t34 → t2` */
const HEAD_SEVENTH_ORDER = { '7': 0, '56': 1, '34': 2, '2': 3 };

/**
 * 打 `v` / `vi` 时，**六级之后**接着给的一串（2026-11-07 用户口径）：
 *
 *   DVII7 → DVII56 → DVII34 → DVII2 → DDVII → DDVII7 → DDVII56 → DDVII34 → DDVII2
 *
 * 也就是「先导七的四个转位，再重导系列」。为什么是七和弦而不是三和弦：
 * 用户打 `v` 时想的是「导音上的和弦」，而导三和弦（`DVII`）在功能上远不如导七常用；
 * 重导同理。DVII 原位仍在候选里，只是落在这串之后（没被删掉）。
 */
const VI_TAIL_ORDER = new Map([
  ['dvii7', 0],
  ['dvii56', 1],
  ['dvii34', 2],
  ['dvii2', 3],
  ['ddvii', 4],
  ['ddvii7', 5],
  ['ddvii56', 6],
  ['ddvii34', 7],
  ['ddvii2', 8],
]);

/**
 * 只打 `i` / `ii` 时的候选次序（2026-11-07 用户口径，**按键名全小写匹配**）：
 *
 *   sII6 → sII56 → sII → tsVI → 二级其余 → 六级其余
 *
 * 注意前四项是用户逐个点的名，别再按「常用表」重排 —— 常用表里 `sII47` 之类会挤进
 * 前四，而用户的直觉是「二级先给最常用的三个，然后就是六级」。
 * 大写输入（`I`）走同一张表：表按小写键查，大调池里只有大写写法，出 `SII6 / SII56 / SII / TSVI`。
 */
const I_MODE_ORDER = new Map([
  ['sii6', 0],
  ['sii56', 1],
  ['sii', 2],
  ['tsvi', 3],
  ['sii46', 4],
  ['sii7', 5],
  ['sii34', 6],
  ['sii2', 7],
  ['tsvi6', 8],
  ['tsvi7', 9],
  ['tsvi56', 10],
  ['tsvi34', 11],
  ['tsvi2', 12],
  ['tsvi46', 13],
]);

/** 子序列匹配：输入的字符按顺序出现在候选里就算命中（忽略大小写）。空串不设限（斜杠后刚开打） */
function isSubsequence(needle, hay) {
  const n = String(needle ?? '').toLowerCase();
  if (!n) return true;
  const h = String(hay ?? '').toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return false;
}

/** 第一个字符命中在哪一位（越小越「靠前」，0 = 就是这个前缀开头的族） */
function firstHitAt(needle, hay) {
  const n = String(needle ?? '').toLowerCase();
  if (!n) return 0;
  const idx = String(hay ?? '').toLowerCase().indexOf(n[0]);
  return idx < 0 ? 999 : idx;
}

/**
 * 候选匹配 + 排序。
 *
 * **匹配：子序列**（不连续、不分大小写）。原来是「前缀 base 开头 + 转位数字开头」，
 * 于是打 `i` / `v` 一个候选都不出 —— 可这两个字母正是六级（`tsVI`）、
 * 三级（`dtIII`）、七级（`DVII`）里出现的位置。子序列把这条打通：
 *   `i`  → `sII…`（两个 I）、`tsVI`、`dtIII`、`DVII`
 *   `ii` → 只留有两个 I 的：`sII…` / `dtIII…`，`tsVI` 自动出局
 *   `v`  → `tsVI…`、`DVII…`
 *   `s5` → `s56` 与 `sII56`（中间隔着 II，子序列照样过得去）
 *
 * **排序**七道闸门：
 *   ⓪ 六级特例：`t / ts / v / vi` 开头时，`tsVI` 整族顶到最前，族内按 `TSVI_FIG_ORDER`
 *   ⓪' 只打 `i` / `ii` 时，按「二级族 → 六级族 → 其它（三级 / 七级）」三段排
 *   ① 完全相等永远第一（打 `S56` 先给 `S56`）
 *   ② 大小写打反但字母一致的（小调里敲 `S` 也先给 `s`）
 *   ③ 常用表（S 组见 `COMMON_*`）—— **排在「字面以输入开头」之前**：
 *      打 `s5` 时 `sII56` 不在字面开头却更常用，得让它赢
 *   ④ 字面上以输入开头的（`DD5` 先给 `DD56`，别被同族的抢了位）
 *   ⑤ 同族（`SIBLINGS`）：`DD56` 之后紧跟 `DDVII56`、`D7` 之后紧跟 `DVII7`
 *   ⑥ 首字母出现得越靠前越好（打 `i` 时 `SII` 在 `TSVI` 前）
 *   ⑦ 前缀短 → 全串短 → 字母序，保证结果稳定
 */
function rankByPrefix(list, prefix) {
  const { base, fig } = splitBaseFig(prefix);
  const lowPrefix = prefix.toLowerCase();
  // 同族表按打出来的大小写查；只有查不到才退到大小写互换的那个（小调里敲大写 S 也认）
  const sibBases = SIBLINGS[base] ?? SIBLINGS[swapCaseHead(base)] ?? [];
  const sibSet = new Set(sibBases);
  /**
   * 常用表按**候选自己的大小写**取：打 `S` 时用的是 `COMMON_MAJOR`（`S6 / S46 / SII6…`），
   * 打 `s` 时用 `COMMON_MINOR`。两套候选现在同池并存，只认一张表会让另一套退化成字母序。
   */
  const orderUpper = new Map(COMMON_MAJOR.map((v, i) => [v, i]));
  const orderLower = new Map(COMMON_MINOR.map((v, i) => [v, i]));
  const rankInCommon = (v) =>
    (/^[A-Z]/.test(v) ? orderUpper : orderLower).get(v) ?? Number.POSITIVE_INFINITY;
  /** 打的是六级的那几个键？大小写不影响（大调出 TSVI、小调出 tsVI，看池子里有谁） */
  const tsviMode = fig === '' && TSVI_KEYS.has(lowPrefix);
  /**
   * 只打了 `i` / `ii`（罗马数字的 I 串）：这时用户在想「二级还是六级」，
   * 按「二级族 → 六级族 → 其它（三级 / 七级）」三段排（2026-11-07 用户口径）。
   * `ii` 时六级本来就被子序列挡掉了（`tsVI` 只有一个 I），第三段照常。
   */
  const iiMode = /^i+$/.test(lowPrefix) && fig === '';
  /** 打的是 `v` / `vi`：六级之后要接导七、重导那一串（`t` / `ts` 不接） */
  const viTailMode = lowPrefix === 'v' || lowPrefix === 'vi';
  const isTsvi = (v) => splitBaseFig(v).base.toLowerCase() === 'tsvi';
  /**
   * 功能首字母过滤：打 `s` / `t` / `d` / `k` 时，只留**首字母完全相同**（含大小写）的族。
   *
   * 两条作用：
   *   ① 大小写服从输入（v0.74）：打 `S` 就只给 `S / SII …`，打 `s` 就只给 `s / sII …`。
   *      候选池是两套的并集，这里负责把它们按用户敲的那个字母分开 —— 不再出现
   *      「小调里打大写 S，补出来的却是小写 s」。
   *   ② 顺带挡掉 `s5` 拖出 `TSVI56`（`tsVI` 里也有 s，但那是主-下属功能，不是 S 族）。
   * `t / ts / v / vi` 走六级特例，关掉过滤（否则打 `v` 会把 `tsVI` 整族筛掉）。
   */
  const FUNC_LETTERS = new Set(['t', 's', 'd', 'k', 'T', 'S', 'D', 'K']);
  const headChar = prefix[0] ?? '';
  /** 打 `t` / `T` 时，源族（主和弦本身）的三和弦三态排最前：`t / t6 / t46` */
  const headBaseSrc = headChar;
  const headFilter = !tsviMode && FUNC_LETTERS.has(headChar);
  /** 输入里有没有大写字母：决定六级的两套写法谁先、以及 `i` 这类输入给哪一套 */
  const wantUpper = /[A-Z]/.test(prefix);
  const wantTsvi = wantUpper ? 'TSVI' : 'tsVI';

  const hits = list.filter((v) => {
    if (!isSubsequence(prefix, v)) return false;
    if (headFilter && splitBaseFig(v).base.slice(0, 1) !== headChar) return false;
    /**
     * 六级也按大小写只留一套：打 `v` 就给 `tsVI` 七项，打 `V` 就给 `TSVI` 七项。
     * 两套都塞进来的话，另一套会占掉 7 个位置，把用户排好的导七（`DVII7…`）挤到看不见。
     */
    const b = splitBaseFig(v).base;
    if (tsviMode && b.toLowerCase() === 'tsvi' && b !== wantTsvi) return false;
    return true;
  });

  hits.sort((a, b) => {
    // ⓪ 六级特例：整族先走，族内按用户要的转位顺序
    if (tsviMode) {
      /**
       * 档位（v0.75 按用户口径改回来）：
       *   0 源族三和弦 —— 打 `t` 给 `t / t6 / t46`，打 `T` 给 `T / T6 / T46`
       *   1 六级整族 —— `tsVI / tsVI6 / …`
       *   2 导七与重导 —— 只有打 `v` / `vi` 时才有
       *   3 源族七和弦 —— `t7 / t56 / t34 / t2`（**排在六级之后**，符合「七和弦那个序列最后」）
       *   4 其余
       *
       * `v` / `vi` 没有源族（子序列够不着 `t`），所以那边仍是六级打头 —— 和之前一样。
       */
      const rank = (v) => {
        const { base: b, fig: f } = splitBaseFig(v);
        if (b === headBaseSrc) return f === '' || f === '6' || f === '46' ? 0 : 3;
        if (isTsvi(v)) return 1;
        if (viTailMode && VI_TAIL_ORDER.has(v.toLowerCase())) return 2;
        return 4;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1) {
        const fa = TSVI_FIG_ORDER[splitBaseFig(a).fig] ?? 99;
        const fb = TSVI_FIG_ORDER[splitBaseFig(b).fig] ?? 99;
        if (fa !== fb) return fa - fb;
      }
      if (ra === 2) {
        const oa = VI_TAIL_ORDER.get(a.toLowerCase()) ?? 99;
        const ob = VI_TAIL_ORDER.get(b.toLowerCase()) ?? 99;
        if (oa !== ob) return oa - ob;
      }
      // 源族的七和弦那一组：`t7 → t56 → t34 → t2`（用户要求的次序，不是字母序）
      if (ra === 3) {
        const oa = HEAD_SEVENTH_ORDER[splitBaseFig(a).fig] ?? 99;
        const ob = HEAD_SEVENTH_ORDER[splitBaseFig(b).fig] ?? 99;
        if (oa !== ob) return oa - ob;
      }
    }
    /**
     * 大小写偏好：其余场合（打 `i` / `ii` 这类不是功能字母的输入）下，
     * 首字母与输入同大小写的排前面。打 `i` 先给小写族、打 `I` 先给大写族。
     */
    {
      const ca = /^[A-Z]/.test(a) === wantUpper ? 0 : 1;
      const cb = /^[A-Z]/.test(b) === wantUpper ? 0 : 1;
      if (ca !== cb) return ca - cb;
    }
    // ⓪' 只打 i / ii：按用户给的次序（二级的三个 → 六级原位 → 二级其余 → 六级其余）
    if (iiMode) {
      const oa = I_MODE_ORDER.get(a.toLowerCase()) ?? 99;
      const ob = I_MODE_ORDER.get(b.toLowerCase()) ?? 99;
      if (oa !== ob) return oa - ob;
    }
    const ae = a === prefix ? 0 : 1;
    const be = b === prefix ? 0 : 1;
    if (ae !== be) return ae - be;
    // 大小写打反了（小调里敲 `S`）：同字母异大小写也算「就是它」
    const ai = a.toLowerCase() === lowPrefix ? 0 : 1;
    const bi = b.toLowerCase() === lowPrefix ? 0 : 1;
    if (ai !== bi) return ai - bi;
    const ao = rankInCommon(a);
    const bo = rankInCommon(b);
    if (ao !== bo) return ao - bo;
    // 字面把整段输入含进去的排在前面：打 `DD5` 第一条必须是 `DD56`
    const ap = a.startsWith(prefix) ? 0 : 1;
    const bp = b.startsWith(prefix) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    // 同族的排在这里：`DD56` 后面就是 `DDVII56`（但别抢上面那几条的位）。
    // 只推「转位也对得上」的那一条：打 `DD` 时不要把 `DDVII2 / DDVII6 …` 全塞到前面。
    const sibOf = (v) => {
      const c = splitBaseFig(v);
      const same = fig === '' ? c.fig === '' : c.fig.startsWith(fig);
      return sibSet.has(c.base) && same ? 0 : 1;
    };
    const as = sibOf(a);
    const bs = sibOf(b);
    if (as !== bs) return as - bs;
    const ah = firstHitAt(prefix, a);
    const bh = firstHitAt(prefix, b);
    if (ah !== bh) return ah - bh;
    const ab = splitBaseFig(a).base.length;
    const bb = splitBaseFig(b).base.length;
    if (ab !== bb) return ab - bb;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  });
  return [...new Set(hits)];
}

/**
 * 斯波索宾泳道的输入候选。
 *
 * 候选表按**当前调式**给：大调出 `T / S / D / SII / DTIII / TSVI / DVII`，
 * 小调出 `t / s / d / D / sII / tsVI / dtIII / DtIII / dtVII / DVII`，各自接转位后缀。
 * 输入里带斜杠时（离调），只补**斜杠后**的目标：前半截用户自己清楚。
 *
 * @param token 正在敲的整段文本
 * @param keyName 该 tick 的调性（决定大小写那一套）
 */
export function sposobinCandidates(token, keyName) {
  const key = parseKeyName(keyName);
  const minorKey = MINORISH.test(String(key?.mode ?? ''));
  /**
   * **候选池始终是两套大小写的并集**（v0.74）。
   *
   * 以前按调式只给一套：小调里只有 `s / sII`，于是敲大写 `S` 靠「大小写打反也算命中」
   * 补出来的还是小写 `s` —— 用户想写「同主音大调借用过来的大下属」时，眼睁睁看着
   * 补全把大写改成小写。反过来大调里敲 `s` 也永远得不到小下属（和声大调里那是常客）。
   *
   * 现在两套都在池子里，由**输入的大小写**决定给哪一套（见 rankByPrefix 的功能首字母过滤）。
   */
  const bases = [...new Set([...BASES_MAJOR, ...BASES_MINOR])];
  const all = [...bases.flatMap((b) => FIG_SUFFIXES.map((f) => b + f)), 'K46'];
  const raw = String(token ?? '').trim();
  if (!raw) return [];
  const slash = raw.lastIndexOf('/');
  if (slash >= 0) {
    const head = raw.slice(0, slash + 1);
    return rankByPrefix(all, raw.slice(slash + 1)).map((v) => head + v);
  }
  return rankByPrefix(all, raw);
}

/**
 * 候选右侧的说明（补全框里那行灰字）。
 *
 * 和级数泳道的提示同一个用意：级数那边写「小三 · 第一转位」，这边写「**罗马数字 + 转位**」——
 * 用户看到 `D56` 时最想知道的就是「这是 V65」，一眼对上他脑子里那套写法。
 *
 * 拆成两截是为了让调用方拼 i18n：`roman` 是语言无关的记号，`figKey` 交给 `t()`。
 * 译不出来（自由文本、K46 之外的生造符号）时 `roman` 为 null，调用方只显示转位那一截。
 */
/**
 * 后缀 → **转位序号**（0 = 原位）。界面拿它拼「第N转位」，N 的写法由 `shared/numeral.js`
 * 决定（汉字 / 阿拉伯），所以这里不返回任何文案。
 * 三和弦与七和弦共用同一套序号：`6` 与 `56` 都是第 1 转位，`46` 与 `34` 都是第 2 转位。
 */
const FIG_INVERSION = {
  '': 0,
  '6': 1,
  '46': 2,
  '7': 0,
  '56': 1,
  '34': 2,
  '2': 3,
};

export function sposobinHint(value, keyName) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  // K46 = 终止四六：它没有「级数」，罗马写法是解析器自己的 Cad64，交给调用方单独给文案
  if (/^K46$/i.test(raw)) return { roman: 'Cad64', inv: null };
  const { fig } = splitBaseFig(raw);
  return { roman: romanFromSposobin(raw, keyName), inv: FIG_INVERSION[fig] ?? null };
}

/**
 * 大小写「越界」时的附注（v0.74）：大写的下属出现在小调里、小写的出现在大调里。
 *
 * 这两件事在斯波索宾体系里都不是错，只是**来历不同**，配色也就不同：
 *   - 小调里的大下属（`S`）：只有同主音大调借用、或旋律小调上行时才出现，**少见** → 橙黄警告。
 *   - 大调里的小下属（`s`）：和声大调（降六级）里的常客，**常用** → 品牌绿。
 * 多利亚不算「少见」：它的 IV 本来是大三和弦，大 `S` 在那儿是默认写法，不提示。
 *
 * 只认 S 族（`S` / `SII`）—— `T` / `D` 的大小写在两套调式里都是常规对立，没有「越界」可言。
 *
 * @returns `'rare' | 'borrowed' | null`
 */
export function sposobinCaseNote(value, keyName) {
  const base = splitBaseFig(value).base;
  if (!/^s(ii)?$/i.test(base)) return null;
  const key = parseKeyName(keyName);
  const mode = String(key?.mode ?? '');
  const minorish = MINORISH.test(mode);
  const dorian = /dorian/i.test(mode);
  const upper = base.slice(0, 1) === 'S';
  if (minorish && !dorian && upper) return 'rare';
  if (!minorish && !upper) return 'borrowed';
  return null;
}

/** 便捷版：直接给文本（级数或绝对和弦）+ 调性 */
export function sposobinOfText(text, keyName) {
  return sposobinOf(parseChord(text, { key: keyName }), keyName);
}

/* ------------------------------------------------------------------ */
/* 反解：斯波索宾标记 → 罗马数字写法                                     */
/* ------------------------------------------------------------------ */

/**
 * 斯波索宾标记本身**不是**和弦记号，`parseChord` 认不了它（`D7` 会被当成「D 属七」）。
 * 所以想让它像级数标记那样显示和弦音，得先译成罗马数字，再交给同一个解析器：
 *
 *   T → I      S → IV     D → V      SII → ii     DVII → vii°
 *   转位数字也要换：苏俄的 56 / 34 / 46 / 2 → 国际的 65 / 43 / 64 / 42
 *   离调保留斜杠：`DTIII6/dtIII` → `III6/III`
 *   终止四六：`K46` → `Cad64`
 *
 * **性质不能只看大小写**：`TSVI` 大调里是小三（vi）、小调里是大三（VI）；
 * `sII` 小调是减三（ii°）、七和弦是半减（iiø7）。所以本函数要调性。
 *
 * @returns 罗马数字写法；认不出来（自由文本、生造符号）返回 null —— 调用方据此
 *   **留空而不是报错**：斯波索宾泳道允许写注释，不该因此亮「解析失败」。
 */
export function romanFromSposobin(text, keyName) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (/^K46$/i.test(raw)) return 'Cad64';

  const key = parseKeyName(keyName);
  const minorKey = MINORISH.test(String(key?.mode ?? ''));

  const parts = raw.split('/');
  if (parts.length > 2) return null;
  const left = romanPart(parts[0], minorKey, true);
  if (!left) return null;
  if (parts.length === 1) return left;
  const target = romanPart(parts[1], minorKey, false);
  return target ? `${left}/${target}` : null;
}

/** 苏俄转位数字 → 国际写法（先小后大 → 先大后小，意义不变） */
const FIG_ROMAN = { '': '', '6': '6', '46': '64', '7': '7', '56': '65', '34': '43', '2': '42' };
const SEVENTH_FIGS = new Set(['7', '56', '34', '2']);

/** 把 `SII56` 拆成 `{ base: 'SII', fig: '56' }` */
function splitFigure(text) {
  const m = String(text ?? '').match(/^(.*?)(56|34|46|7|6|2)?$/);
  return { base: m ? m[1] : String(text ?? ''), fig: m?.[2] ?? '' };
}

/**
 * 前缀 → 本调里的级数与性质。
 * `hasSeventh` 只用来区分 `sII`（减三）与 `sII7`（半减七）。
 */
function degreeOfBase(base, minorKey, hasSeventh) {
  switch (base) {
    case 'T': return { num: 'I', quality: 'major' };
    case 't': return { num: 'I', quality: 'minor' };
    case 'S': return { num: 'IV', quality: 'major' };
    case 's': return { num: 'IV', quality: 'minor' };
    case 'D': return { num: 'V', quality: 'major' };
    case 'd': return { num: 'V', quality: 'minor' };
    // 小调二级是减三；写成七和弦就是半减七。大调二级是小三。
    case 'SII':
    case 'sII':
      if (!minorKey) return { num: 'II', quality: 'minor' };
      return { num: 'II', quality: 'dim', halfDim: hasSeventh };
    case 'TSVI':
    case 'tsVI':
      return minorKey ? { num: 'VI', quality: 'major' } : { num: 'VI', quality: 'minor' };
    case 'DTIII':
      return minorKey ? { num: 'III', quality: 'major' } : { num: 'III', quality: 'minor' };
    case 'dtIII': return { num: 'III', quality: 'major' };
    case 'DtIII': return { num: 'III', quality: 'aug' };
    case 'DVII':
    case 'dVII': return { num: 'VII', quality: 'dim' };
    case 'dtVII': return { num: 'VII', quality: 'major' };
    default: return null;
  }
}

/** 级数 + 性质 → 罗马数字（大小写表示大小三和弦；减 / 增补符号） */
function numeralOf(num, quality, halfDim = false) {
  if (quality === 'major') return num;
  if (quality === 'aug') return `${num}+`;
  if (quality === 'dim') return `${num.toLowerCase()}${halfDim ? 'ø' : '°'}`;
  return num.toLowerCase();
}

/**
 * 一段（斜杠前 / 斜杠后）→ 罗马数字。
 * 斜杠前带转位数字；斜杠后只是「目标级数」，不带数字。
 */
function romanPart(text, minorKey, withFigure) {
  const { base, fig } = splitFigure(text);

  // 重属 / 重导：它们天生带一个斜杠，直接拼完整写法
  if (base === 'DD' || base === 'DDVII') {
    if (!withFigure) return null;
    const f = FIG_ROMAN[fig];
    if (f === undefined) return null;
    return base === 'DD' ? `V${f}/V` : `vii°${f}/V`;
  }

  const deg = degreeOfBase(base, minorKey, SEVENTH_FIGS.has(fig));
  if (!deg) return null;
  const numeral = numeralOf(deg.num, deg.quality, !!deg.halfDim);
  if (!withFigure) return numeral;

  const f = FIG_ROMAN[fig];
  if (f === undefined) return null;
  // 半减七只有「七和弦」的四种转位，三和弦位置（6 / 46）不存在
  if (deg.halfDim && !SEVENTH_FIGS.has(fig)) return null;
  return numeral + f;
}
