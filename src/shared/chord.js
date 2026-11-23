/**
 * chord.js — 和弦符号解析内核（纯函数，无 IO）
 *
 * 两套写法都吃：
 *   罗马数字：I / ii6 / V7 / viio7 / Imaj7 / V65 / V7/V / bVII / #iv° / Cad64
 *   绝对音名：C / Am / G7 / F#m7b5 / Bbsus4 / C/E / Dmaj9
 *
 * 为什么值得单独写：网格里的事件一旦有了**精确时值**，就只剩「这个符号是什么」这一层没解决。
 * 解析结果落进 analysis_event.parsed，后面算和弦音、找共同音、标功能、导出 MIDI 都从这里取，
 * 不必再回头去 regex 文本。
 *
 * 解析失败的符号**不猜**：返回 ok:false + errors，界面照旧存文本，只是标黄提醒。
 * 解析器猜错比不解析更糟——它会让之后所有统计都错得很有道理。
 *
 * 注意：`errors` 里的文字是**写库的数据**（解析当时生成、存在 analysis_event.parsed），
 * 所以它不跟界面语言走；跟语言走的只有 describeChord 这种纯展示层的描述。
 */
import { t } from './i18n.js';
import { numeral } from './numeral.js';

/**
 * 哪几条泳道里放的是**和弦符号**（其余泳道放的是转位数字、低音音名、备注、功能标记）。
 *
 * 只在这里定义一份：主进程用它决定要不要算 `parsed`，渲染层用它决定详情栏该看哪一条。
 * 两边各写一份就会漂移 —— 一边算了、另一边不看，表现是「解析明明有，界面却是空」。
 */
export const CHORD_LANES = new Set(['chord', 'chordSymbol', 'symbol', 'degree']);

/** 级数 → 相对主音的半音数（**大调**音阶；小调请走 MODE_STEPS） */
export const DEGREE_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

const LETTER_PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const LETTERS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
const PC_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PC_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * 各调式的音阶（相对主音的半音数）。
 *
 * **和声 / 旋律小调故意与自然小调共用一张表** —— 这是本文件最反直觉、但最重要的一条：
 * 升七级音只属于**属功能**（V / vii°）。把它铺进整条音阶，III 的五音就会变成导音
 * （Eb 和声小调 → G♭ B♭ D），而 III 在实践里是「向关系大调离调」的 G♭ B♭ D♭。
 * 所以这里按自然小调取根音，导音由 `leadingToneStep()` 单独补给 vii°/vii。
 */
const MODE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'natural minor': [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 10],
  'melodic minor': [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
};

/** 小调类调式：这些调式里「vii 要升七级」的规则才成立 */
const MINOR_MODES = new Set(['minor', 'natural minor', 'harmonic minor', 'melodic minor', 'aeolian']);

/** 半音数 → 三度叠置时的字母级数（0=同字母，2=三度，4=五度，6=七度…） */
const DIATONIC_OF_SEMITONE = { 0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3, 6: 4, 7: 4, 8: 4, 9: 5, 10: 6, 11: 6 };

const mod12 = (n) => ((n % 12) + 12) % 12;

function modeSteps(mode) {
  return MODE_STEPS[String(mode ?? '').trim().toLowerCase()] ?? MODE_STEPS.major;
}

/**
 * 某个级数的根音半音数。
 *
 * 小调的第 7 级有两个身份：**导音**（升七级，只给 vii°/viiø/小写 vii）与
 * **下主音**（自然七级，给大写 VII）。同一份音阶表里只能放一个，按符号决定用哪个 ——
 * 否则 Eb 和声小调的 VII 会跑到 D 上（导音），而不是 D♭。
 */
function degreeStep(mode, degree, leading = false) {
  const steps = modeSteps(mode);
  const base = steps[(Number(degree) - 1) % 7];
  if (degree === 7 && MINOR_MODES.has(String(mode ?? '').trim().toLowerCase())) {
    return leading ? 11 : base;   // base 此时一定是 10
  }
  return base;
}

/** 级数 → 音名字母（c d e f g a b 循环，第 3 级就是主音往后数两个字母） */
function letterOfDegree(keyLetter, degree) {
  const i = LETTERS.indexOf(String(keyLetter ?? 'c').toLowerCase());
  return LETTERS[(((i < 0 ? 0 : i) + Number(degree) - 1) % 7 + 7) % 7];
}

/**
 * 给一个音高配上指定字母，算出升降号。
 * 这是「同一个琴键写 G♭ 还是 F♯」的唯一正确做法：字母由音级决定，升降号由音高与字母的距离决定。
 */
/**
 * 升降号怎么写：**±2 用 Unicode 的重升 / 重降**（𝄪 𝄫），其余叠单记号。
 *
 * 以前一律重复 `♯♯` / `♭♭`。改成 𝄪/𝄫 是为了跟词表（`accidentals` 里就放的 𝄪 𝄫）
 * 和用户手动输入的写法一致 —— 不然同一个音在格子里是 `C𝄪`、详情栏却是 `C♯♯`。
 * 三升这种极端情况写成 `𝄪♯`（音乐记谱里也是这么叠）。
 */
function accidentalMark(acc) {
  if (!acc) return '';
  const single = acc > 0 ? '♯' : '♭';
  const double = acc > 0 ? '𝄪' : '𝄫';
  const n = Math.abs(acc);
  return double.repeat(Math.floor(n / 2)) + single.repeat(n % 2);
}

function spellPc(pc, letter) {
  let acc = mod12(pc) - LETTER_PC[letter];
  while (acc > 6) acc -= 12;
  while (acc < -6) acc += 12;
  return letter.toUpperCase() + accidentalMark(acc);
}

/**
 * 叠一个音程：返回 { pc, name }，字母按音程的自然级数走，不按音高就近猜。
 * `letterSteps` 必须由调用方指定**七音**：9 个半音既可能是大六度（+5 字母）也可能是
 * 减七度（+6 字母），只按半音猜会把 G♯°7 的七音写成 E♯（应为 F）。
 */
function spellInterval(rootPc, rootLetter, semitones, letterSteps = DIATONIC_OF_SEMITONE[semitones] ?? 0) {
  const pc = mod12(rootPc + semitones);
  const letter = LETTERS[(LETTERS.indexOf(rootLetter) + letterSteps) % 7];
  return { pc, name: spellPc(pc, letter) };
}

const QUALITY_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
};
/**
 * 三和弦每个音是「几音」—— 只给**省略音**（`no5` / `omit3`）用。
 *
 * 挂在三和弦上是根 / 三 / 五；挂留和弦的第二项是二音或四音（`sus2` 是 2、`sus4` 是 4），
 * 这样 `Csus4no4` 才说得通（去掉那个四音，剩 C–G）。
 */
const QUALITY_DEGREES = {
  major: [1, 3, 5],
  minor: [1, 3, 5],
  dim: [1, 3, 5],
  aug: [1, 3, 5],
  sus2: [1, 2, 5],
  sus4: [1, 4, 5],
};
const SEVENTH_INTERVAL = { none: null, minor: 10, major: 11, dim: 9, 'half-dim': 10 };

/** 词典键：性质 / 七和弦 / 转位 / 级数名，describeChord 与 degreeName 共用 */
const QUALITY_KEY = {
  major: 'chord.quality.major',
  minor: 'chord.quality.minor',
  dim: 'chord.quality.dim',
  aug: 'chord.quality.aug',
  sus2: 'chord.quality.sus2',
  sus4: 'chord.quality.sus4',
};
const SEVENTH_KEY = {
  minor: 'chord.seventh.minor',
  major: 'chord.seventh.major',
  dim: 'chord.seventh.dim',
  'half-dim': 'chord.seventh.half-dim',
};

/**
 * 附加音 / 延伸音 → { semis, ls }。
 *
 * `semis` 是**从根音往上数的绝对半音数**（9 与 add9 差一个八度：14 与 2），
 * 它决定和弦音的**排列顺序**：add2 落在三音之下（C–D–E–G），add9 落在最上面（C–E–G–D）。
 * `ls` 是字母级数，决定音名怎么写 —— 9 音永远是 D（b9 是 D♭），不能按半音就近猜成 C♯。
 *
 * 为什么 add2/add4 不归一成 add9/add11：音高一样，但**读法与排列不同**，
 * 用户写哪个就是想在哪个八度听到它。
 */
const EXT_TOKENS = {
  add13: { semis: 21, ls: 5 },
  add11: { semis: 17, ls: 3 },
  add9: { semis: 14, ls: 1 },
  add6: { semis: 9, ls: 5 },
  add4: { semis: 5, ls: 3 },
  add2: { semis: 2, ls: 1 },
  'b13': { semis: 20, ls: 5 },
  '♭13': { semis: 20, ls: 5 },
  '#11': { semis: 18, ls: 3 },
  '♯11': { semis: 18, ls: 3 },
  b9: { semis: 13, ls: 1 },
  '♭9': { semis: 13, ls: 1 },
  '#9': { semis: 15, ls: 1 },
  '♯9': { semis: 15, ls: 1 },
  '13': { semis: 21, ls: 5 },
  '11': { semis: 17, ls: 3 },
  '9': { semis: 14, ls: 1 },
  '6': { semis: 9, ls: 5 },
};
/** 按长度降序：`add11` 必须先于 `add1…` 被匹配，否则会切错 */
const EXT_ORDER = Object.keys(EXT_TOKENS).sort((a, b) => b.length - a.length);

/** 挂留记号：写在数字前后都行（`Vsus4` / `V7sus4`） */
const SUS_TOKENS = ['sus2', 'sus4', 'sus'];

/**
 * 延伸音记号 → 它是「几音」（`add9` / `♭9` / `9` 都是 9；`add2` 是 2）。省略音按这个数对。
 * 取不到数字就返回 0（不会被省略），宁可不动也不要错删一个音。
 */
function degreeOfExtToken(tok) {
  const m = String(tok ?? '').match(/(\d{1,2})/);
  return m ? Number(m[1]) : 0;
}

/**
 * 省略音里**真的删掉了东西**的那些。
 *
 * `parsed.omits` 存的是这个过滤后的结果：详情栏要写「省略五音」，
 * 那么 `C13no11`（本来就没有 11）就不能凭空说省略了十一音。
 */
function effectiveOmits(quality, seventh, extensions, sub6, omits) {
  const list = (Array.isArray(omits) ? omits : []).map(Number).filter(Boolean);
  if (!list.length) return [];
  const present = new Set(QUALITY_DEGREES[quality] ?? QUALITY_DEGREES.major);
  if (seventh !== 'none' && SEVENTH_INTERVAL[seventh] != null) present.add(7);
  for (const tok of extensions ?? []) present.add(degreeOfExtToken(tok));
  if (sub6) present.add(6);
  return list.filter((n) => present.has(n));
}

/**
 * 三和弦 + 七音 + 延伸音 → 按**实际音高**排好的和弦音。
 *
 * 罗马数字与字母和弦共用这一份 —— 两边各写一份必然漂移
 * （`Vadd2` 与 `Cadd2` 拼出不同的顺序，用户看到的就是「一个对一个错」）。
 * `add2` 落在三音之下、`add9` 落在最上面，靠的就是这里按 semis 排序。
 *
 * `sub6` 是「六音替代五音」：先拆掉三和弦的第五音，再补一个六音。
 * 默认是大六度（9 个半音）；`sub♭6` / `subb6` 用 8 个半音（小六度）。
 * 七音（如果有）原样保留 —— `V7sub6` = G–B–E–F，不是把七音也换掉。
 *
 * `omits` 是**省略音的级数**（`C13no11` → `[11]`）：按「几音」而不是按音高匹配，
 * 所以 `C7♯9no9` 去掉的是那个升九，`Cmaj7no3` 去掉的是三音，不影响别的音。
 */
function buildTones(rootPc, rootLetter, quality, seventh, extensions, sub6 = null, omits = null) {
  const drop = new Set((Array.isArray(omits) ? omits : []).map(Number).filter(Boolean));
  const stack = [];
  const ivs = QUALITY_INTERVALS[quality] ?? QUALITY_INTERVALS.major;
  const degs = QUALITY_DEGREES[quality] ?? QUALITY_DEGREES.major;
  ivs.forEach((iv, i) => {
    if (drop.has(degs[i])) return;
    stack.push({ semis: iv, ls: DIATONIC_OF_SEMITONE[iv] ?? 0 });
  });
  if (seventh !== 'none' && SEVENTH_INTERVAL[seventh] != null && !drop.has(7)) {
    stack.push({ semis: SEVENTH_INTERVAL[seventh], ls: 6 });
  }
  for (const tok of extensions ?? []) {
    const e = EXT_TOKENS[tok];
    if (e && !drop.has(degreeOfExtToken(tok))) stack.push(e);
  }
  if (sub6) {
    // 三和弦的第三项就是五音（sus 的「第五音」位置也一样）
    if (stack.length >= 3) stack.splice(2, 1);
    if (!drop.has(6)) stack.push({ semis: sub6.flat ? 8 : 9, ls: 5 });
  }
  stack.sort((a, b) => a.semis - b.semis);
  return stack.map((x) => spellInterval(rootPc, rootLetter, x.semis, x.ls));
}

function extTokenAt(text) {
  const low = String(text ?? '').toLowerCase();
  for (const tok of EXT_ORDER) {
    if (low.startsWith(tok)) return { tok, len: tok.length };
  }
  return null;
}

/**
 * 调性名 → 主音信息。
 * 库里存的是 "c natural minor" / "g dorian" / "c-sharp natural minor" 这种写法。
 * `letter` / `acc` 是拼写的依据：没有它们就只能按音高猜升降号，降号调会全写成升号。
 */
export function parseKeyName(name) {
  const s = String(name ?? '').trim().toLowerCase();
  if (!s) return null;
  // "e-flat" / "e flat" / "e♭" / "eb" 都要认；末尾的 b 只有不接字母时才是降号（"bb minor" = B♭）
  const m = s.match(/^([a-g])(?:[- ]?(sharp|flat|♯|♭)|([#♯♭])|b(?![a-z]))?/);
  if (!m) return null;
  const letter = m[1];
  const word = m[2] ?? '';
  const sign = m[3] ?? '';
  // 紧凑写法 "eb" / "bb"：结尾那个 b 是降号。单个 "b" 是字母本身，不能当降号（B 大调）。
  const compactFlat = m[0].length > 1 && m[0].endsWith('b');
  let acc = 0;
  if (word === 'sharp' || word === '♯' || sign === '#' || sign === '♯') acc = 1;
  else if (word || sign || compactFlat) acc = -1;
  const mode = s.slice(m[0].length).trim() || 'major';
  return { pc: mod12(LETTER_PC[letter] + acc), mode, letter, acc };
}

/**
 * 变音记号 → 半音数。
 *
 * 认三种写法：ASCII（`#` `b` `x`）、Unicode 单记号（♯ ♭ ♮）、Unicode 双记号（𝄪 𝄫）。
 * 词表里存的是 Unicode（`C♯` / `C𝄪`），而人要打字时按的是 ASCII —— 两边都得认，
 * 否则「候选里明明有 C𝄪，敲进去却报无法解析」。
 */
const ACCIDENTAL_SEMIS = {
  '#': 1, '♯': 1,
  b: -1, '♭': -1,
  x: 2, X: 2, '𝄪': 2,
  '𝄫': -2,
  '♮': 0,
};

/** 一段变音记号串（"#b" / "𝄪" / "bb"）→ 半音数 */
function accidentalSemis(signs) {
  let n = 0;
  for (const ch of String(signs ?? '')) {
    const v = ACCIDENTAL_SEMIS[ch];
    if (v === undefined) return null;
    n += v;
  }
  return n;
}

/** 音名（"C#" / "Db" / "bb" / "C𝄪" / "C♮"）→ pitch class */
export function noteToPc(text) {
  // 量词按 **code unit** 数：𝄪/𝄫 是代理对，占 2 个 —— 写成 {0,3} 会让「C𝄪♯」这种组合被截断
  const m = String(text ?? '').match(/^([a-gA-G])([#b♯♭xX𝄪𝄫♮]{0,6})$/);
  if (!m) return null;
  const acc = accidentalSemis(m[2]);
  if (acc == null) return null;
  const pc = LETTER_PC[m[1].toLowerCase()] + acc;
  return ((pc % 12) + 12) % 12;
}

export function pcName(pc, preferFlat = false) {
  if (pc == null) return '?';
  const list = preferFlat ? PC_NAMES_FLAT : PC_NAMES_SHARP;
  return list[((pc % 12) + 12) % 12];
}

const ROMAN_TOKENS = [
  ['vii', 7],
  ['iii', 3],
  ['vi', 6],
  ['iv', 4],
  ['v', 5],
  ['ii', 2],
  ['i', 1],
];

/** 走完和弦音（三度叠置）后，按转位把低音换到最前 */
function rotate(pcs, inversion) {
  if (!inversion || inversion <= 0 || inversion >= pcs.length) return pcs.slice();
  return [...pcs.slice(inversion), ...pcs.slice(0, inversion)];
}

function triadPcs(rootPc, quality) {
  const iv = QUALITY_INTERVALS[quality] ?? QUALITY_INTERVALS.major;
  return iv.map((n) => ((rootPc + n) % 12 + 12) % 12);
}

function qualityFromSeventh(seventh) {
  if (seventh === 'minor') return 'dominant';
  if (seventh === 'major') return 'major-seventh';
  if (seventh === 'dim') return 'diminished-seventh';
  if (seventh === 'half-dim') return 'half-diminished';
  return null;
}

/**
 * 严格的属七：大三和弦 + 小七度（`V7`、`bII7`）。
 *
 * 为什么不直接用 `chordType === 'dominant'`：`qualityFromSeventh()` 只看七音，
 * 于是 `ii7` / `vi7` 这种小三 + 小七也会被标成 `dominant`。进行识别里要区分
 * 「III7 是借来的属七」和「iii7 是调内小七」，必须看三音性质。
 */
export function isDominantSeventh(parsed) {
  return !!parsed && parsed.quality === 'major' && parsed.seventh === 'minor';
}

/**
 * 属功能和弦：带小七度的属七 / 属九 / 属七挂四 / 增五属七。
 *
 * 三全音替代认的是**功能**，不是拼写：`bII7`、`bII9`、`bII7sus4` 都在代 V7。
 * `bII7b5` 会被归一成半减七，不算这里。
 */
export function isDominantFunctionChord(parsed) {
  return (
    !!parsed &&
    parsed.seventh === 'minor' &&
    ['major', 'sus2', 'sus4', 'aug'].includes(parsed.quality)
  );
}

/**
 * 终止四六的写法：Cad64 / Cad6/4 / K46 / К46（西里尔 К）。
 * 单独抽出来是因为**入口判定**也要用：它不以罗马数字开头，不先认出来会被当成字母和弦去解析。
 */
export function isCadentialSymbol(text) {
  return /^(?:cad|k)\s*(?:6[./]?4|4[./]?6)$/i.test(String(text ?? '').trim().replace(/К/g, 'K'));
}

/**
 * 那不勒斯和弦的记号：`N` / `N6`（也认小写、全角）。
 *
 * 它**就是 ♭II**：降二级上的大三和弦；最常用的是第一转位 `N6`（低音是四级音）。
 * 所以这里不另写一套解析，只把记号翻成 `bII` / `bII6` 交给 `parseRoman` ——
 * 两者必须落在同一个 `degree:2, alter:-1` 上，否则详情栏会说成「2 级」，
 * 而级数泳道按功能筛（下属）也会漏掉它。
 */
export function isNeapolitanSymbol(text) {
  return /^n\s*(?:6)?$/i.test(String(text ?? '').trim());
}

/**
 * 解析罗马数字和弦。
 * 大小写决定三和弦性质：大写 = 大三和弦，小写 = 小三和弦（古典分析的通行约定）。
 * 后缀数字按**数字低音**读：6/64 是三和弦转位，7/65/43/42 是七和弦转位。
 *
 * `mode` 决定级数落在哪个音上（小调 b3/b6/b7），`keyLetter` 决定拼写（G♭ 还是 F♯）。
 * 两者缺一都会「音高对、结果不对」，所以 parseChord 一律传齐。
 */
export function parseRoman(raw, keyPc = 0, mode = 'major', keyLetter = null) {
  const errors = [];
  const text = String(raw ?? '').trim();

  /**
   * 终止四六（Cad64 / K46 / 西里尔 К46）。
   *
   * 它不是「主和弦的第二转位」——斯波索宾体系里它是**属功能**：
   * 低音是属音，六度与四度是**双外音**（倚音），向下解决到五度与三度。
   * 所以：根音 = 属音（第 5 级）、**原位**（属音就在低音）、音从低到高是「属–主–中音」。
   * 写成 I64 只是「音一样」的巧合，功能上完全不同 —— 这一条决定详情栏怎么解释它。
   */
  const cadText = text.replace(/К/g, 'K');
  const isCadential = isCadentialSymbol(cadText);
  let body = text;

  /**
   * 括号里的一组「和弦类型」：`V(6/9)`、`I(add9)`。
   *
   * 为什么六九和弦必须打括号：罗马数字里的 6 是**第一转位**（V6 = 属和弦第一转位），
   * `V6/9` 会被读成「V6 后面跟个 9」，和数字低音体系直接打架。
   * 括号把「这是一个和弦类型」讲清楚，也顺便让斜杠不再被当成分隔副属的符号。
   * 全角括号也认（中文输入法打出来的就是（））。
   */
  let parenGroup = null;
  const pg = body.match(/[（(]\s*([^）)]*)\s*[）)]\s*$/);
  if (pg) {
    parenGroup = pg[1].trim();
    body = body.slice(0, pg.index).trim();
  }

  // 斜杠：右边是罗马数字 = 副属（V7/V）；右边是音名 = 指定低音（I/C）
  let appliedTo = null;
  /** 斜杠右侧自带的升降号（`bII` 的 ♭）：临时主音要跟着走，否则 V/bII 会落在错的主音上 */
  let appliedAlter = 0;
  /** 临时主音的调式：斜杠右侧大写 = 大三和弦 → 大调；小写 = 小三和弦 → 自然小调 */
  let appliedMode = 'major';
  let bassLetter = null;
  let i = 0;
  let alter = 0;
  let degree = null;
  let upper = true;

  if (isCadential) {
    // 属音上的四六：级数就是 5，后面不再解析任何后缀
    degree = 5;
  } else {
    const slash = body.lastIndexOf('/');
    if (slash > 0) {
      const right = body.slice(slash + 1).trim();
      body = body.slice(0, slash).trim();
      const asRoman = right.match(/^([#b♯♭]*)(vii|iii|vi|iv|v|ii|i)$/i);
      if (asRoman) {
        appliedTo = ROMAN_TOKENS.find(([t]) => t === asRoman[2].toLowerCase())[1];
        appliedAlter = [...asRoman[1]].reduce((n, ch) => n + (ch === '#' || ch === '♯' ? 1 : -1), 0);
        // 大小写就是临时主音的三和弦性质，也就决定了它的音阶（见 appliedBase 那段）
        appliedMode = asRoman[2] === asRoman[2].toUpperCase() ? 'major' : 'natural minor';
      } else if (noteToPc(right) != null) {
        bassLetter = right;
      } else if (/^\d{1,2}$/.test(right)) {
        // 六九和弦：斜杠在罗马数字里另有含义（副属 / 指定低音），所以要求打括号
        errors.push(`六九和弦要打括号：写成 V(6/9)，不要写 V6/9`);
      } else {
        errors.push(`斜杠右侧无法识别：${right}`);
      }
    }

    while (i < body.length && /[#b♯♭]/.test(body[i])) {
      alter += body[i] === '#' || body[i] === '♯' ? 1 : -1;
      i++;
    }

    for (const [token, num] of ROMAN_TOKENS) {
      if (body.slice(i, i + token.length).toLowerCase() === token) {
        degree = num;
        upper = body.slice(i, i + token.length) === body.slice(i, i + token.length).toUpperCase();
        i += token.length;
        break;
      }
    }
  }
  if (!degree) {
    return { ok: false, raw: text, kind: 'roman', errors: ['缺少罗马数字级数'], quality: 'major', seventh: 'none', inversion: 0, degree: null, alter };
  }

  let rest = isCadential ? '' : body.slice(i);
  let quality = upper ? 'major' : 'minor';
  let seventh = 'none';
  let inversion = 0;
  let sub6 = null;
  const extensions = [];
  /** 省略音（`V13no11`）：按「几音」匹配，见 buildTones */
  const omits = [];
  /** 真正删掉了东西的省略音（详情栏照着念的那一份），cadential 分支里保持空 */
  let droppedOmits = [];
  const seenExt = new Set();
  /**
   * 记一个附加音/延伸音；重复了要报错（`I#9#9` 是笔误，不该被静默接受）。
   * `implied` = 由别的记号隐含出来的音（`11 → 9` / `13 → 9`）：进 extensions 但不占「重复」名额。
   */
  const pushExt = (tok, implied = false) => {
    if (!implied) {
      if (seenExt.has(tok)) errors.push(`延伸音重复：${tok}`);
      seenExt.add(tok);
    }
    if (!extensions.includes(tok)) extensions.push(tok);
  };

  // 性质符号（写在级数后）：° o ø + dim aug sus
  let m = rest.match(/^(dim|aug|sus2|sus4|sus|ø|°|o|\+)/i);
  if (m) {
    const token = m[1].toLowerCase();
    if (token === 'dim' || token === '°' || token === 'o') quality = 'dim';
    else if (token === 'aug' || token === '+') quality = 'aug';
    else if (token === 'ø') {
      quality = 'dim';
      seventh = 'half-dim';
    } else if (token === 'sus2') quality = 'sus2';
    else quality = 'sus4';
    rest = rest.slice(m[1].length);
  }

  // 级数里的 m7b5 与 ø 是同一个半减七。必须排在 `M`（大七）之前认：
  // 否则大小写不敏感的 `M(?![a-z])` 会把开头的 m 当成大七标记，剩下 `7b5` 又走到绝对和弦的 b5 分支。
  m = rest.match(/^(min7b5|m7b5)/i);
  if (m) {
    quality = 'dim';
    seventh = 'half-dim';
    rest = rest.slice(m[0].length);
  }

  // maj / M（大七）
  let explicitMaj = false;
  m = rest.match(/^(maj|M(?![a-z]))/i);
  if (m) {
    explicitMaj = true;
    seventh = seventh === 'none' ? 'major' : seventh;
    rest = rest.slice(m[1].length);
  }

  // 数字低音
  /**
   * 苏俄体系的写法：属五六 = 56、三四 = 34、四六 = 46、二 = 2。
   * 中文教材里很常见，但规范记法是 65 / 43 / 64 / 42。
   *
   * 这里**照常按规范值解析**，只把「不规范」记进 `figure` 交给界面提示 ——
   * 判成解析失败会让人以为自己把和弦写错了，而其实只是记法不同。
   * `figure` 里只存两个裸符号（不是句子）：`parsed` 是写库数据，不能跟界面语言走。
   */
  const FIGURE_ALIAS = { '56': '65', '34': '43', '46': '64' };
  const FIGURES = [
    ['65', 1, true],
    ['43', 2, true],
    ['42', 3, true],
    ['64', 2, false],
    ['53', 0, false],
    ['7', 0, true],
    ['6', 1, false],
    ['2', 3, true],
  ];
  let figure = null;
  m = rest.match(/^(\d{1,2})/);
  if (m) {
    const fig = m[1];
    const canonical = FIGURE_ALIAS[fig] ?? fig;
    const hit = FIGURES.find(([f]) => f === canonical);
    if (hit) {
      inversion = hit[1];
      if (hit[2] && seventh === 'none') seventh = quality === 'dim' ? 'dim' : 'minor';
      if (canonical !== fig) figure = { found: fig, standard: canonical };
      else if (fig === '2') figure = { found: '2', standard: '42' };
      rest = rest.slice(fig.length);
    } else if (['9', '11', '13'].includes(fig)) {
      /**
       * 延伸音。**写了 `maj` 时七音仍是大七** —— `Imaj9` 是「I 的大九和弦」，
       * 不是「I 小七加九」（以前这里一刀切写成 minor，`Imaj9` 会得到 I–♭3–5–♭7–9）。
       */
      seventh = explicitMaj ? 'major' : quality === 'dim' ? 'dim' : 'minor';
      /**
       * 11 / 13 隐含九音（用户 2026-11-08）：`Imaj11 = I–E…` 的完整十一和弦、
       * `Imaj13(♯11)` 也要有九音。要单独的十一音就写 `add11`。
       */
      if (fig === '11' || fig === '13') pushExt('9', true);
      pushExt(fig);
      rest = rest.slice(fig.length);
    } else {
      errors.push(`数字低音无法识别：${fig}`);
      rest = rest.slice(fig.length);
    }
  }

  /**
   * 一组括号内的记号（`6/9` / `add9` / `b9`）。
   * 里面用空格、逗号、斜杠分隔都行 —— 斜杠在这里只是「六和九」之间的分隔，没有别的含义。
   */
  const takeGroup = (inner) => {
    for (const part of String(inner).split(/[\s,/，、]+/).filter(Boolean)) {
      const low = part.toLowerCase();
      if (SUS_TOKENS.includes(low)) {
        quality = low === 'sus2' ? 'sus2' : 'sus4';
        continue;
      }
      // 括号里的省略音：`V13(no11)` / `V9(omit5)`
      const om = low.match(/^(?:omit|no)(\d{1,2})?$/);
      if (om) {
        if (om[1]) omits.push(Number(om[1]));
        continue;
      }
      if (!EXT_TOKENS[low]) {
        errors.push(`括号内无法识别：${part}`);
        continue;
      }
      pushExt(low);
    }
  };

  /**
   * 附加音 / 延伸音 / 挂留音。三种记号的顺序不固定，所以放在一个循环里按最长匹配吃：
   *   V7sus4      —— 挂四写在七音之后（最常用）
   *   Vsus4add9   —— 挂四 + 附加九音
   *   V9sus4      —— 延伸音 + 挂四
   *   V(6/9)      —— 括号里的一组
   */
  while (rest) {
    // 级数里的 m7b5 与 ø 是同一个半减七；词表两种写法都给候选
    m = rest.match(/^(min7b5|m7b5)/i);
    if (m) {
      quality = 'dim';
      seventh = 'half-dim';
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^sub([b♭])?6(?![0-9])/i);
    if (m) {
      sub6 = { flat: !!m[1] };
      rest = rest.slice(m[0].length);
      continue;
    }
    /**
     * **省略音**：`no5` / `omit3`（`C13no11`、`C9omit5`）。
     * 只写关键字不给数字 = 什么都不省略 —— 补全插进来的 `C13omit` 不会立刻报错，
     * 接着打数字才生效（`no` / `omit` 与别的记号不冲突：没有以 n 开头的后缀）。
     */
    m = rest.match(/^(?:omit|no)(\d{1,2})?/i);
    if (m) {
      if (m[1]) omits.push(Number(m[1]));
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^(sus2|sus4|sus)(?![a-z])/i);
    if (m) {
      quality = m[1].toLowerCase() === 'sus2' ? 'sus2' : 'sus4';
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^[（(]\s*([^）)]*)\s*[）)]/);
    if (m) {
      takeGroup(m[1]);
      rest = rest.slice(m[0].length);
      continue;
    }
    const hit = extTokenAt(rest);
    if (!hit) break;
    pushExt(hit.tok);
    rest = rest.slice(hit.len);
  }

  if (parenGroup) takeGroup(parenGroup);

  if (rest.trim()) errors.push(`多余字符：${rest.trim()}`);

  /**
   * 导音判定：只有 vii°/viiø/小写 vii 才把七级升上去。
   * 大写 VII 是下主音（自然七级），III/VI 更不该被升七级污染 ——
   * 这正是「小调 III 解析成 G B D」的根因。
   */
  const leading = degree === 7 && (!upper || quality === 'dim' || seventh === 'half-dim');

  // 字母序列同样要按调式走：副属和弦的根音是「被属化的那一级再往上五度」
  // 没有 keyLetter（老调用点直接调 parseRoman）时，按常见的降号调习惯猜一个字母
  const FLAT_PCS = new Set([1, 3, 6, 8, 10]);
  const keyLetterSafe =
    keyLetter ??
    ((FLAT_PCS.has(mod12(keyPc)) ? PC_NAMES_FLAT[mod12(keyPc)] : PC_NAMES_SHARP[mod12(keyPc)])[0].toLowerCase());
  /**
   * 副属和弦：斜杠右侧的级数是**临时主音**，分子级数必须在那套临时调音阶里数。
   *
   * 这里曾经把分子也按本调音阶算（`degreeStep(mode, degree)`），结果 Eb 和声小调的
   * `iii6/III` 变成「本调 3 级 + 3 个半音」= A（写出来是 B♭♭），整组 **多降一次**
   * （B♭♭–D♭♭–F♭，正确是 B♭–D♭–F）。III 是 G♭ 大三和弦，它的 iii 是
   * G♭ 上方 **4** 个半音的 B♭ —— 分子只能走临时主音自己的音阶。
   *
   * `appliedMode` 由斜杠右侧大小写定：大写（III / V）→ 大调，小写（iv / ii）→ 自然小调。
   * 自然小调的 5 级仍是纯五度，所以 `V/III` 落在 D♭（还原七级）而不是和声小调的 D，
   * 「副属必须是纯五度」这条硬约束自然成立，不需要再加判断。
   * 复合级数的字母仍按「三级的三级 = 第 5 个字母」推，所以拼写和音高同源。
   */
  const appliedBase = appliedTo ? degreeStep(mode, appliedTo) + appliedAlter : 0;
  const numStep = degreeStep(appliedTo ? appliedMode : mode, degree, leading);
  const rootPc = mod12(keyPc + appliedBase + numStep + alter);
  const rootLetter = letterOfDegree(
    keyLetterSafe,
    appliedTo ? appliedTo + degree - 1 : degree
  );
  const rootName = spellPc(rootPc, rootLetter);

  // 三度叠置：先按根音铺满，再按转位旋转；pcs 与名字必须同源，否则「音对了名字错了」
  let baseTones;
  if (isCadential) {
    /**
     * 终止四六的音**不是**「属三和弦」：它听上去是「属–主–中音」三条音，
     * 六度与四度是外音，所以不能按三度叠置生成（那会得到 G–B–D）。
     * 直接从调式里取第 5 / 1 / 3 级，字母跟着级数走（A 小调 → E–A–C，不是 E–A–C♯）。
     */
    const toneAt = (d) => ({
      pc: mod12(keyPc + degreeStep(mode, d)),
      name: spellPc(mod12(keyPc + degreeStep(mode, d)), letterOfDegree(keyLetterSafe, d)),
    });
    baseTones = [toneAt(5), toneAt(1), toneAt(3)];
    inversion = 0;   // 属音就在低音 → 原位
  } else {
    /**
     * 三和弦 + 七音 + 延伸音，全部换成「从根音往上数的**绝对**半音数」，最后按音高排序。
     *
     * 排序不是洁癖，是「add2 和 add9 是两回事」的唯一实现方式：
     *   Iadd2 → C D E G（二度音夹在根音与三音之间）
     *   Iadd9 → C E G D（九度音在三音五音之上）
     * 两者音高相同（同一个键），只有**排列位置**不同 —— 不按半音数排就分不出来。
     * 字母级数也一并带上：七音必须跨 6 个字母（G♯°7 的七音是 F，不是 E♯），
     * 九音永远是 D（b9 是 D♭，不能按半音就近写成 C♯）。
     */
    // 只保留真的删掉了东西的省略音（详情栏要照着念，不能空口说白话）
    droppedOmits = effectiveOmits(quality, seventh, extensions, sub6, omits);
    baseTones = buildTones(rootPc, rootLetter, quality, seventh, extensions, sub6, droppedOmits);
  }
  let tones = baseTones;

  const uniqTones = (list) => {
    const seen = new Set();
    const out = [];
    for (const t of list) {
      if (seen.has(t.pc)) continue;
      seen.add(t.pc);
      out.push(t);
    }
    return out;
  };

  let bassPc = rotate(tones, inversion)[0].pc;
  let bassName = rotate(tones, inversion)[0].name;
  if (bassLetter) {
    const pc = noteToPc(bassLetter);
    if (pc != null) {
      const idx = tones.findIndex((t) => t.pc === pc);
      if (idx >= 0) {
        inversion = idx;
        // 指定低音本来就是把某个和弦音搬到最低 —— 不重新旋转会出现「说第一转位、音却从根音列起」
        const rotated = rotate(tones, inversion);
        bassPc = rotated[0].pc;
        bassName = spellPc(pc, String(bassLetter).trim()[0].toLowerCase());
        tones = rotated;
      } else {
        errors.push(`低音 ${bassLetter} 不在和弦音内`);
        bassPc = pc;
        bassName = spellPc(pc, String(bassLetter).trim()[0].toLowerCase());
      }
    }
  } else {
    const rotated = rotate(tones, inversion);
    tones = rotated;
  }

  const finalTones = uniqTones(tones);

  return {
    ok: errors.length === 0,
    raw: text,
    kind: 'roman',
    degree,
    alter,
    appliedTo,
    appliedAlter,
    appliedMode: appliedTo ? appliedMode : null,
    /** 终止四六：功能属、原位、双外音。详情栏靠它换一套说法 */
    cadential: isCadential,
    quality,
    seventh,
    chordType: qualityFromSeventh(seventh),
    sub6: !!sub6,
    omits: [...droppedOmits],
    sub6Flat: !!sub6?.flat,
    inversion,
    extensions,
    rootPc,
    bassPc,
    pcs: finalTones.map((t) => t.pc),
    toneNames: finalTones.map((t) => t.name),
    rootName,
    bassName,
    bassLetter,
    figure,
    keyMode: String(mode ?? 'major').trim().toLowerCase(),
    errors,
  };
}

/** 解析绝对音名和弦（流行/爵士写法） */
export function parseAbsolute(raw) {
  const errors = [];
  const text = String(raw ?? '').trim();
  let body = text;

  /**
   * `C6/9` 是字母和弦的常规写法（这里的斜杠不是「指定低音」，是「六和九」）。
   * `C(6/9)` 是级数那边为了跟转位区分要求带括号的写法；两种都收。
   * 先摘掉，否则它会被当成「低音 9」直接报错。
   */
  let sixNine = false;
  if (/\(6\/9\)$/.test(body)) {
    sixNine = true;
    body = body.replace(/\(6\/9\)$/, '');
  } else if (/6\/9$/.test(body)) {
    sixNine = true;
    body = body.replace(/6\/9$/, '');
  } else if (/69$/.test(body)) {
    /**
     * `C69`：字母和弦里没有数字低音，`69` 不会被误读成「转位 6 + 九音」，
     * 所以字母泳道的候选直接写这个（用户 2026-11-08）。
     * 级数泳道仍然要 `V(6/9)` —— 那边 `6` 是转位记号。
     */
    sixNine = true;
    body = body.replace(/69$/, '');
  }

  /**
   * 括号和空格在字母和弦里**只是分组**，不带信息：
   *   `Cmaj13 (♯11)` = `Cmaj13♯11`、`C7(b9)` = `C7b9`、`C 7` = `C7`
   * 词表里就有带空格的写法（`maj13 (♯11)`，爵士谱上也这么印），
   * 到这里先抹平，后面的规则只面对一种形态。
   * 必须排在 `(6/9)` 之后 —— 那一段靠括号才认得出来。
   */
  body = body.replace(/[\s()（）]/g, '');

  let bassPc = null;
  const slash = body.lastIndexOf('/');
  if (slash > 0) {
    const right = body.slice(slash + 1).trim();
    body = body.slice(0, slash).trim();
    const pc = noteToPc(right);
    if (pc == null) errors.push(`低音无法识别：${right}`);
    else bassPc = pc;
  }

  const head = body.match(/^([A-Ga-g])([#b♯♭xX𝄪𝄫♮]{0,6})/);
  if (!head) return { ok: false, raw: text, kind: 'absolute', errors: ['缺少根音音名'], quality: 'major', seventh: 'none', inversion: 0 };

  const rootPc = noteToPc(head[1] + head[2]);
  let rest = body.slice(head[0].length);
  let quality = 'major';
  let seventh = 'none';
  let inversion = 0;
  let sub6 = null;
  const extensions = [];
  /** 省略音（`C13no11`）：按「几音」匹配，见 buildTones */
  const omits = [];

  const seenExt = new Set();
  /**
   * 记一个附加音/延伸音（与罗马数字那边同一套 `EXT_TOKENS`）。
   *
   * `implied` = 由别的记号**隐含**出来的音（`11 → 9` / `13 → 9`）：
   * 它要进 `extensions`（音要响出来），但不占「重复」的名额 ——
   * 否则 `C11` 后面再手写一个 `(9)` 就会被判成笔误。显式重复（`C#9#9`）仍然报错。
   */
  const pushExt = (tok, implied = false) => {
    if (!implied) {
      if (seenExt.has(tok)) errors.push(`延伸音重复：${tok}`);
      seenExt.add(tok);
    }
    if (!extensions.includes(tok)) extensions.push(tok);
  };

  // 性质：m7b5 / min / m / maj / dim / ° / ø / aug / + / sus
  let m = rest.match(/^(min|maj|dim|aug|sus2|sus4|sus|ø|°|o|\+|m(?!aj))/i);
  let explicitMajorSeventh = false;
  if (m) {
    const token = m[1].toLowerCase();
    if (token === 'min' || token === 'm') quality = 'minor';
    else if (token === 'maj') explicitMajorSeventh = true;
    else if (token === 'dim' || token === '°' || token === 'o') quality = 'dim';
    else if (token === 'aug' || token === '+') quality = 'aug';
    else if (token === 'ø') {
      quality = 'dim';
      seventh = 'half-dim';
    } else if (token === 'sus2') quality = 'sus2';
    else quality = 'sus4';
    rest = rest.slice(m[1].length);
  }

  m = rest.match(/^(\d{1,2})/);
  if (m) {
    const fig = m[1];
    if (['7', '9', '11', '13'].includes(fig)) {
      if (explicitMajorSeventh) seventh = 'major';
      else if (seventh === 'half-dim') {
        /**
         * `Cø7` 的 `ø` 已经把七音定成半减了，后面的 7 只是把它写全。
         * 以前这里会先按 `quality === 'dim'` 改成减七，于是 Cø7 和 Cdim7 输出同一组音。
         */
      } else if (quality === 'dim') seventh = 'dim';
      else if (quality === 'minor') seventh = 'minor';
      else seventh = 'minor';
      if (fig !== '7') {
        /**
         * **11 / 13 隐含九音**（用户 2026-11-08）：`C11 = C–E–G–B♭–D–F`、
         * `Cmaj13(♯11) = C–E–G–B–D–F♯–A`。
         * 理由：想要一个单独的十一音，有 `add11` —— 那是另一个音响、另一个写法；
         * 写了 `11` / `13` 就是完整的（十三）和弦。`C9` 早就带七音，
         * 这里只是把同一套「数字越大越全」的直觉补齐。
         */
        if (fig === '11' || fig === '13') pushExt('9', true);
        pushExt(fig);
      }
      rest = rest.slice(fig.length);
    } else if (EXT_TOKENS[fig]) {
      /**
       * `C6` 是**加六音**（C–E–G–A），不是大七和弦。
       * 以前这里把 6 当成 seventh='major'，于是 C6 得到 C E G B、Am6 得到 A C E G（应为 F♯）。
       */
      pushExt(fig);
      rest = rest.slice(fig.length);
    } else {
      errors.push(`延伸音无法识别：${fig}`);
      rest = rest.slice(fig.length);
    }
  } else if (explicitMajorSeventh) {
    seventh = 'major';
  }

  /**
   * 剩下的后缀：挂留 / 附加音 / 变化延伸音。
   * 和罗马数字那边共用 `EXT_TOKENS` —— 同一套记号在两个泳道里必须拼出同一组音。
   */
  while (rest) {
    m = rest.match(/^sub([b♭])?6(?![0-9])/i);
    if (m) {
      sub6 = { flat: !!m[1] };
      rest = rest.slice(m[0].length);
      continue;
    }
    /**
     * **省略音**：`no5` / `omit3`（`C13no11`、`C9omit5`）。
     * 只写关键字不给数字 = 什么都不省略 —— 补全插进来的 `C13omit` 不会立刻报错，
     * 接着打数字才生效（`no` / `omit` 与别的记号不冲突：没有以 n 开头的后缀）。
     */
    m = rest.match(/^(?:omit|no)(\d{1,2})?/i);
    if (m) {
      if (m[1]) omits.push(Number(m[1]));
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^(sus2|sus4|sus)(?![a-z])/i);
    if (m) {
      quality = m[1].toLowerCase() === 'sus2' ? 'sus2' : 'sus4';
      rest = rest.slice(m[0].length);
      continue;
    }
    /**
     * b5 / #5 **改的是三和弦性质**（`C7b5` = 半减、`C7#5` = 增七），不是「多一个音」，
     * 所以不进 `extensions`，直接改 quality。排在延伸音前面认，不然 b5 会被当成别的记号。
     */
    m = rest.match(/^([b♭])5(?![0-9])/);
    if (m) {
      quality = 'dim';
      rest = rest.slice(m[0].length);
      continue;
    }
    m = rest.match(/^([#♯])5(?![0-9])/);
    if (m) {
      quality = 'aug';
      rest = rest.slice(m[0].length);
      continue;
    }
    const hit = extTokenAt(rest);
    if (!hit) break;
    pushExt(hit.tok);
    rest = rest.slice(hit.len);
  }
  if (sixNine) {
    pushExt('6');
    pushExt('9');
  }

  // m7b5 的 b5 在数字之后才读到，这里补正：减三 + 小七 = 半减七
  if (quality === 'dim' && seventh === 'minor') seventh = 'half-dim';

  if (rest.trim()) errors.push(`多余字符：${rest.trim()}`);

  // 绝对音名的拼写由**用户写的根音**决定：写 Bb 就一路用降号，写 A# 就一路用升号
  const rootLetter = head[1].toLowerCase();
  const rootName = spellPc(rootPc, rootLetter);
  // 只保留真的删掉了东西的省略音（同上）
  const droppedOmits = effectiveOmits(quality, seventh, extensions, sub6, omits);
  const baseTones = buildTones(rootPc, rootLetter, quality, seventh, extensions, sub6, droppedOmits);

  let outBassIndex = 0;
  let bassName = baseTones[0].name;
  if (bassPc != null) {
    const idx = baseTones.findIndex((t) => t.pc === bassPc);
    if (idx >= 0) {
      inversion = idx;
      outBassIndex = idx;
      bassName = baseTones[idx].name;
    } else {
      errors.push(`低音 ${pcName(bassPc)} 不在和弦音内`);
      bassName = pcName(bassPc);
    }
  }

  const rotated = rotate(baseTones, outBassIndex);
  const seen = new Set();
  const finalTones = [];
  for (const t of rotated) {
    if (seen.has(t.pc)) continue;
    seen.add(t.pc);
    finalTones.push(t);
  }

  return {
    ok: errors.length === 0,
    raw: text,
    kind: 'absolute',
    rootPc,
    appliedTo: null,
    degree: null,
    alter: 0,
    quality,
    seventh,
    chordType: qualityFromSeventh(seventh),
    sub6: !!sub6,
    omits: [...droppedOmits],
    sub6Flat: !!sub6?.flat,
    inversion,
    extensions,
    bassPc: bassPc ?? finalTones[0].pc,
    bassName,
    rootName,
    pcs: finalTones.map((t) => t.pc),
    toneNames: finalTones.map((t) => t.name),
    figure: null,
    errors,
  };
}

/**
 * 入口：自动判断是罗马数字还是音名。
 * @param {string} text
 * @param {{key?: string|null}} opts key 是 "c natural minor" 这类规范值
 */
export function parseChord(text, opts = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, raw, errors: ['空符号'], quality: 'major', seventh: 'none', inversion: 0, pcs: [] };

  const key = parseKeyName(opts.key);
  /**
   * 那不勒斯记号先翻成 `bII` / `bII6` 再走罗马数字那条路：
   * 记号和它的实际级数必须得出**同一份** parsed，否则 `N6` 与 `♭II6` 在库里是两种和弦。
   */
  const neapolitan = isNeapolitanSymbol(raw);
  const romanText = neapolitan ? (/6\s*$/.test(raw) ? 'bII6' : 'bII') : raw;
  // 大小写都要认：I 与 i 都是级数；A–G 开头才是音名；Cad64 / K46 是终止四六（属功能）
  const looksRoman =
    neapolitan || isCadentialSymbol(raw) || /^[#b♭♯]{0,2}(vii|iii|vi|iv|v|ii|i)/i.test(raw);
  const parsed = looksRoman
    ? parseRoman(romanText, key?.pc ?? 0, key?.mode ?? 'major', key?.letter ?? null)
    : parseAbsolute(raw);
  return {
    // raw 记用户**实际写的**字样（N6 就写 N6），转位/级数仍来自 bII6 那份
    ...parsed,
    raw: neapolitan ? raw : parsed.raw,
    neapolitan,
    keyPc: key?.pc ?? null,
    keyName: opts.key ?? null,
    keyLetter: key?.letter ?? null,
  };
}

/** 和弦音（pitch class），低音在最前 */
/**
 * 和弦在某个调里的**级数**（1–7 + 升降号），字母和弦与罗马数字都适用。
 *
 * 用途：和弦进行识别（王道进行 / 万能和弦进行）。罗马数字本来就有 `degree`；
 * 字母和弦必须按「该 tick 生效的调性」反算级数，否则两套泳道里只有一套能识别。
 *
 * 取「最接近的音阶级」：差值收进 [-6, +5]；距离相同（比如 C 调里的 D♭：
 * 是 ♯1 还是 ♭2）时统一取**降号解释**，与降号调的习惯一致。
 */
export function degreeOfChord(parsed, keyName) {
  if (!parsed) return null;
  if (parsed.kind === 'roman' && parsed.degree) {
    return { degree: parsed.degree, alter: parsed.alter ?? 0 };
  }
  if (typeof parsed.rootPc !== 'number') return null;
  const key = parseKeyName(keyName);
  if (!key) return null;
  const steps = modeSteps(key.mode);
  const rel = mod12(parsed.rootPc - key.pc);
  let best = null;
  for (let i = 0; i < 7; i++) {
    const diff = ((((rel - steps[i] + 6) % 12) + 12) % 12) - 6;
    const score = Math.abs(diff);
    if (!best || score < best.score || (score === best.score && diff < best.diff)) {
      best = { degree: i + 1, alter: diff, score, diff };
    }
  }
  return best ? { degree: best.degree, alter: best.alter } : null;
}

export function chordPcs(parsed) {
  return parsed?.pcs ? [...parsed.pcs] : [];
}

/** 挂留的词典键（只有这两个有说法；`sus` 已经归一到 sus4） */
const SUS_LABEL = { sus2: 'chord.sus.sus2', sus4: 'chord.sus.sus4' };

/**
 * 一个附加音记号的读法：`add2` → 「加 2 音」、`b9` → 「♭9 音」。
 * `b5/#5` 不念 —— 它们是改三和弦性质的写法（`C7b5` 就是半减），`quality` 已经体现了。
 */
/**
 * 延伸音数字的写法。
 *
 * **不能直接用 `numeral()`**：那个函数只管 1–9 的转位序号（超过就夹到九），
 * 拿它念 11 / 13 会得到「九」，`Cmaj13(♯11)` 就成了「升九」。
 * 这里只覆盖真实用得到的几个数。
 */
const EXT_CN = {
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
  7: '七',
  8: '八',
  9: '九',
  11: '十一',
  13: '十三',
};
const EN_ORD_TH = ['th', 'st', 'nd', 'rd'];

function extNumeral(n, locale) {
  const v = Math.trunc(Number(n) || 0);
  if (locale === 'en') {
    const k = v % 100;
    return v + (EN_ORD_TH[(k - 20) % 10] || EN_ORD_TH[k] || EN_ORD_TH[0]);
  }
  return EXT_CN[v] ?? String(v);
}

function extLabel(locale, token) {
  const s = String(token ?? '');
  if (/^[b#♭♯]5$/.test(s)) return '';
  const plain = s.match(/^(?:add)?(\d+)$/i);
  if (plain) return t(locale, 'chord.ext.add', { n: plain[1] });
  const alt = s.match(/^([b#♭♯])(\d+)$/);
  if (alt) {
    // 变化音念成「升十一 / 降九」而不是「♯11 音」：详情栏是给人读的句子
    // （用户 2026-11-08 的口径：大十三和弦 · 升十一）。
    const flat = alt[1] === 'b' || alt[1] === '♭';
    return t(locale, flat ? 'chord.ext.flat' : 'chord.ext.sharp', {
      n: extNumeral(Number(alt[2]), locale),
    });
  }
  return '';
}

/**
 * 人话描述，直接显示在选区条上。
 * @param {object} parsed parseChord 的结果
 * @param {'zh'|'en'} [locale] 取哪套文案；默认中文（老调用点与测试不用改）
 */
/**
 * 有七音时给和弦**起个名字**：按「最高的那个自然延伸音」升级命名。
 *
 *   Cmaj7 → 大七和弦　　Cmaj9 → 大九和弦　　Cmaj13(♯11) → 大十三和弦（+ 升十一）
 *   C7    → 属七和弦　　C9    → 属九和弦
 *   Am7   → 小七和弦　　Am9   → 小九和弦
 *
 * 用户 2026-11-08 的口径：写「大十三和弦 · 升十一」就够。
 * 「加 9 音 · 加 13 音」对懂乐理的人是废话，对不懂的人照样一头雾水 —— 两头不讨好。
 * 名字里已经包含的延伸音（裸 9 / 11 / 13）不再单独念；**变化音**（♯11 / ♭9…）照念。
 *
 * 返回 null 表示「这套名字管不了」（减七 / 半减七 / 挂留 / 增和弦 / 小大七），
 * 调用方回落到原来的「七音 + 逐个延伸音」说法。
 */
function chordTypeName(locale, parsed) {
  const exts = Array.isArray(parsed.extensions) ? parsed.extensions : [];
  const hasBare = (n) => exts.includes(String(n));
  const noSeventh = !parsed.seventh || parsed.seventh === 'none';
  // 六九和弦：没有七音，同时有 6 和 9（`C6/9` / `C69`）
  if (noSeventh && hasBare(6) && hasBare(9)) {
    return { label: t(locale, 'chord.sixNine'), consumed: new Set(['6', '9']) };
  }
  if (noSeventh) return null;
  const fam =
    parsed.quality === 'minor'
      ? parsed.seventh === 'minor'
        ? 'min'
        : null
      : parsed.quality === 'major'
        ? parsed.seventh === 'major'
          ? 'maj'
          : parsed.seventh === 'minor'
            ? 'dom'
            : null
        : null;
  if (!fam) return null;
  const natural = [9, 11, 13].filter((n) => hasBare(n));
  const top = natural.length ? Math.max(...natural) : 7;
  return {
    label: t(locale, `chord.type.${fam}${top}`),
    consumed: new Set([...natural.map(String), '7']),
  };
}

export function describeChord(parsed, locale = 'zh') {
  if (!parsed || parsed.ok === false) {
    return parsed?.raw ? t(locale, 'chord.parseFailed', { raw: parsed.raw }) : '';
  }
  const parts = [];
  if (parsed.cadential) {
    /**
     * 终止四六不能说成「3 级」「大三和弦」——它是属功能 + 双外音。
     * 转位仍然是**原位**（属音就在低音），所以下面的 inversion 分支照常追加。
     */
    parts.push(t(locale, 'chord.cadential'));
    parts.push(t(locale, 'chord.cadentialFunc'));
  } else {
    /**
     * 级数要带上**升降号**：以前只写「2 级」，于是 `♭II`（那不勒斯）和 `II` 在界面上
     * 长得一模一样 —— 音高对、说法错，比解析失败更误导。现在写「♭2 级」。
     */
    if (parsed.kind === 'roman') {
      const alt = accidentalMark(Math.round(Number(parsed.alter) || 0));
      parts.push(t(locale, 'chord.degree', { n: `${alt}${parsed.degree}` }));
      /**
       * 降二级的两种身份，按**功能**分，不按级数硬背：
       * - 带小七度（bII7 / bII9 / bII7sus4…）= 三全音替代，代 V7 解决到 I；
       * - 只有大三和弦（bII / bII6，最多加附加音）= 那不勒斯。
       *
       * 以前只要「♭II + 大三」就叫那不勒斯，于是 `bII7` 被念成那不勒斯 ——
       * 音对了，功能说法反了，比解析失败更误导。
       */
      const flatTwo =
        Number(parsed.degree) === 2 && Math.round(Number(parsed.alter) || 0) === -1;
      if (flatTwo && isDominantFunctionChord(parsed)) {
        parts.push(t(locale, 'chord.tritoneSub'));
      } else if (flatTwo && parsed.quality === 'major' && parsed.seventh === 'none') {
        parts.push(t(locale, 'chord.neapolitan'));
      }
    }
    /**
     * 副属和弦：既要说明「以第 n 级为临时主音」，也要保留分子自己的性质。
     * 以前这里是 else 分支，性质被挤掉了 —— `iii/III` 会被念成「属和弦」，
     * 可它明明是小三和弦。
     */
    if (parsed.appliedTo) parts.push(t(locale, 'chord.applied', { n: parsed.appliedTo }));
    const named = chordTypeName(locale, parsed);
    if (named) {
      parts.push(named.label);
    } else if (parsed.seventh && SEVENTH_KEY[parsed.seventh]) {
      parts.push(t(locale, SEVENTH_KEY[parsed.seventh]));
      /**
       * 有七音时上面那句已经把「性质」占了，挂留就没人说 —— `V7sus4` 会被念成
       * 「小七」而已，那个把三音换成四音的关键反而消失了。这里补一句。
       */
      if (SUS_LABEL[parsed.quality]) parts.push(t(locale, SUS_LABEL[parsed.quality]));
    } else {
      parts.push(t(locale, QUALITY_KEY[parsed.quality] ?? 'chord.quality.other'));
    }
    // 附加音 / 延伸音（`Vadd9` / `V9sus4` / `V(6/9)`）：不说出来等于白解析
    for (const ext of parsed.extensions ?? []) {
      // 名字里已经包含的（大十三和弦 里的 9 / 13）不再单独念
      if (named?.consumed?.has(ext)) continue;
      const label = extLabel(locale, ext);
      if (label) parts.push(label);
    }
    // 六音替五音不是延伸音：五音被拿掉了，必须单独说
    if (parsed.sub6) parts.push(t(locale, parsed.sub6Flat ? 'chord.sub6flat' : 'chord.sub6'));
    /**
     * 省略音（`C9omit5`）：`parsed.omits` 只记**真的删掉了东西**的那些 ——
     * `C13no11` 本来就没有十一音，不能照着念「省略十一音」。
     */
    for (const n of parsed.omits ?? []) {
      parts.push(t(locale, 'chord.omit', { n: extNumeral(n, locale) }));
    }
  }
  const inv = Number(parsed.inversion);
  // 序号写法跟着偏好走：`第一转位` / `第1转位` / `1st inversion`（见 shared/numeral.js）
  if (inv >= 0 && inv <= 3) parts.push(t(locale, `chord.inversion.${inv}`, { n: numeral(inv, locale) }));
  const toneText = (parsed.toneNames?.length ? parsed.toneNames : (parsed.pcs ?? []).map((pc) => pcName(pc))).join('–');
  const head = parts.filter(Boolean).join(' · ');
  return toneText ? head + t(locale, 'chord.tones', { tones: toneText }) : head;
}

/** 调内功能的粗分：主 / 下属 / 属（只对罗马数字有意义） */
export function harmonicFunction(parsed) {
  if (!parsed || parsed.kind !== 'roman' || !parsed.degree) return null;
  if ([1, 6].includes(parsed.degree)) return 'tonic';
  if ([2, 4].includes(parsed.degree)) return 'subdominant';
  if ([5, 7].includes(parsed.degree)) return 'dominant';
  return 'mediant';
}

/** 级数的功能名（主 / 属 / 导音…），英文界面给 tonic / dominant… */
export function degreeName(degree, locale = 'zh') {
  const n = Number(degree);
  if (!(n >= 1 && n <= 7)) return '?';
  return t(locale, `chord.degreeName.${n}`);
}
