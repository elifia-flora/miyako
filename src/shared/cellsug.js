/**
 * 和弦符号的候选生成（纯函数，主进程与 `node --test` 共用）。
 *
 * 放在 shared 而不是组件里：候选规则（根音最长匹配、词表顺序、级数推断、
 * 双拼前缀）是「输入手感」的核心，写进 .vue 就只能靠点界面验，而这类 bug
 * 往往只是顺序错了。
 *
 * 词表结构（schemaVersion 2，见 `data/vocab/chord-symbols.json`）：
 *   `{ letters, accidentals, qualities: [{suffix,label,primary,aliases?}] }`
 *
 * 三条硬规则：
 * 1. **候选顺序以词表数组为准**，`primary` 只决定「只打根音 / 级数时出不出现」，
 *    不再按 primary 把词表顺序打乱。编辑器上移/下移改的就是这个顺序。
 * 2. **别名只进说明，不复制候选行**；但别名参与输入匹配，打 `7b9` 会得到 `7♭9`。
 * 3. 级数泳道**不做调式推断**：裸 `ii` / `vii` 永远第一；半减七只在
 *    `h / half / b / ban / bj` 或带转位数字时出现。候选仍然全部来自 JSON 词表。
 * 4. 模糊匹配不要求连续：exact / 前缀 / 转位之后，再按「连续子串 > 顺序子序列 >
 *    字符都在（乱序）」补；`V76` / `V67` / `V6` 都能找到 `V7sub6`。
 */

/** 变音记号的正字法：用户打的任何一种写法都归一成词表里的那一个字符 */
const ACC_ALIAS = {
  '#': '♯',
  '♯': '♯',
  b: '♭',
  '♭': '♭',
  x: '𝄪',
  X: '𝄪',
  '𝄪': '𝄪',
  '𝄫': '𝄫',
  '♮': '',
};

/**
 * 把用户打的东西归一成词表写法：`c#7` → `C♯7`、`bb` → `B♭`、`cx` → `C𝄪`、`C##` → `C𝄪`。
 *
 * **只动开头那一个音名后面的变音字母**，后面的性质后缀一个字都不碰 ——
 * `m7b5` 里的 `b` 是「降五音」，把它当变音记号改掉就变成另一个和弦了。
 */
export function normalizeRootText(s) {
  const t = String(s ?? '').trim();
  // {0,4} 而不是 {0,2}：𝄪/𝄫 是代理对，正则的量词数的是 code unit（占 2 个）
  const m = t.match(/^([A-Ga-g])([#b♯♭xX𝄪𝄫♮]{0,4})/);
  if (!m) return t;
  const letter = m[1].toUpperCase();
  let acc = '';
  for (const ch of m[2]) {
    const canon = ACC_ALIAS[ch];
    // 认不出的字符原样留着：宁可匹配不上，也不要悄悄改成别的音
    acc += canon === undefined ? ch : canon;
  }
  // 连打两个同一个记号 = 重升/重降（`##` / `bb`）
  acc = acc.replace(/♯♯/g, '𝄪').replace(/♭♭/g, '𝄫');
  return letter + acc + t.slice(m[0].length);
}

/**
 * 词表 → 根音全列表（音名 × 变音）。
 *
 * 顺序就是候选的顺序：先字母、再变音 —— 于是 `C` `C♯` `C♭` `C𝄪` `C𝄫` `D`…，
 * 打了 `C` 看到的前几条是最常用的那几个，不像「按字母聚成一堆」那样跳出 `C𝄫`。
 */
export function chordRoots(doc) {
  const letters = Array.isArray(doc?.letters) ? doc.letters.filter((x) => typeof x === 'string' && x) : [];
  const signs = Array.isArray(doc?.accidentals)
    ? doc.accidentals
        .map((a) => (typeof a === 'string' ? a : a?.sign))
        .filter((x) => typeof x === 'string')
    : [];
  const out = [];
  for (const l of letters) for (const s of signs) out.push(l + s);
  return out;
}

/* ---------------- 词表 → 规整的性质表 ---------------- */

function textList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  return [];
}

function qualityList(doc) {
  return (Array.isArray(doc?.qualities) ? doc.qualities : [])
    .filter((q) => q && typeof q.suffix === 'string')
    .map((q) => ({
      suffix: q.suffix,
      label: String(q.label ?? q.suffix),
      primary: q.primary === true,
      aliases: textList(q.aliases),
    }));
}

/** 级数泳道不能直接用的字母和弦后缀：大小写已经表达大小三，`6` 在级数里是转位 */
function degreeAllowed(q) {
  const s = String(q?.suffix ?? '');
  if (s === 'm7b5') return true; // 半减七的字母写法，解析器专门认
  if (s === '6') return false;
  return !/^m(?!aj)/i.test(s);
}

/** 字母泳道不用的后缀：ø 的转位写法只服务级数，字母和弦用 Cø7 / Cø7/E♭ 表达低音 */
function letterAllowed(q) {
  return !/^ø(?:65|43|42)$/i.test(String(q?.suffix ?? ''));
}

/**
 * 字母泳道对某些后缀**换个写法**（2026-11-08 用户口径）。
 *
 * 词表里只存一种 `(6/9)`，但字母和弦写成 `C69`：这里没有数字低音，
 * 括号纯属多余，`C69` 也更好读好打。级数泳道必须保留 `V(6/9)` ——
 * 那边 `6` 是转位记法，去掉括号就变成「V6 再加个 9」。
 *
 * 解析器两边都认（`C69` / `C6/9` / `C(6/9)`），所以这里只管候选怎么显示。
 */
const LETTER_SUFFIX_OVERRIDE = { '(6/9)': '69' };

function letterSuffix(q) {
  return LETTER_SUFFIX_OVERRIDE[q?.suffix] ?? q?.suffix ?? '';
}

/** 半减七（含 ø 的各种转位写法）；m7b5 在级数泳道被上面的规则排除，但字母泳道还在 */
function isHalfDim(q) {
  const s = String(q?.suffix ?? '').toLowerCase();
  if (s.startsWith('ø') || s === 'm7b5') return true;
  return (q?.aliases ?? []).some((a) => /^(ø|m7b5|min7b5)/i.test(String(a)));
}

/** 候选右侧的说明：标签 + 别名；别名不复制成第二条候选 */
function hintOf(q) {
  const label = q.label || q.suffix || '大三和弦';
  return q.aliases.length ? `${label} · ${q.aliases.join(' / ')}` : label;
}

/**
 * 级数里的同一串后缀，说法跟着大小写走：
 * `V7` 是属七，`ii7` 是小七；`ii` 是小三，不能拿字母和弦的「大三和弦」标签糊弄。
 * 只覆盖会因大小写改变说法的几个后缀，其余继续用词表 label。
 */
function degreeHint(q, lower) {
  if (!lower) return hintOf(q);
  const map = {
    '': '小三和弦',
    '7': '小七',
    '7sus4': '小七挂四',
    '7♭9': '小七降九',
    '7sub6': '小七 · 六音替五音',
    '9': '小九',
  };
  return map[q.suffix] ?? hintOf(q);
}

/* ---------------- 模糊匹配（不连续的 2~3 个字符） ---------------- */

function isSubsequence(query, text) {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i++;
    if (i >= query.length) return true;
  }
  return i >= query.length;
}

function containsAllChars(query, text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  for (const ch of query) {
    const n = counts.get(ch) ?? 0;
    if (n <= 0) return false;
    counts.set(ch, n - 1);
  }
  return true;
}

/**
 * 输入片段的匹配强度：3 = 连续子串，2 = 按顺序但不连续，1 = 字符都在但顺序不同。
 * `V76` / `V67` / `V6` 都能靠它找到 `V7sub6`；exact / 前缀仍然排在前面。
 */
function fuzzyTier(token, query) {
  const t = String(token ?? '').toLowerCase();
  const q = String(query ?? '').toLowerCase();
  if (!t || !q) return 0;
  if (t.includes(q)) return 3;
  if (isSubsequence(q, t)) return 2;
  if (containsAllChars(q, t)) return 1;
  return 0;
}

/**
 * 追加模糊候选：只在 exact / 前缀之后用，保证「打全了/打对了前缀」不会被模糊项挤掉。
 * 同一档内仍然按词表顺序，`used` 里已有的 value 不重复出现。
 */
function fuzzyQualityCandidates(quals, query, base, hintFn, used, suffixOf = (q) => q.suffix) {
  const q = String(query ?? '').toLowerCase();
  if (!q) return [];
  /**
   * 单字符只对**数字**且候选里至少有两个数字时开模糊：
   * `V6 → V7sub6`、`V7 → Vm7b5` 可以用；但 `iis` 不该被 `7sus4` 的 s 拉出半屏候选，
   * `C6` 也不该把 `add6` 这类单数字项全塞进来。
   */
  const single = q.length === 1;
  if (single && !/\d/.test(q)) return [];
  const scored = [];
  quals.forEach((quality, i) => {
    if (!quality.suffix) return;
    let tier = 0;
    let starts = 0;
    for (const token of [quality.suffix, ...quality.aliases]) {
      if (single && (String(token).match(/\d/g) ?? []).length < 2) continue;
      const t = String(token).toLowerCase();
      if (t.startsWith(q[0])) starts = 1;
      tier = Math.max(tier, fuzzyTier(token, q));
    }
    if (tier) scored.push({ quality, i, tier, starts });
  });
  // 同一档里优先「首字符就对上」的：Vs6 的 sub6 要排在 7sub6 前面
  scored.sort((a, b) => b.tier - a.tier || b.starts - a.starts || a.i - b.i);
  return scored
    .map(({ quality }) => ({
      value: base + suffixOf(quality),
      label: base + suffixOf(quality),
      hint: hintFn(quality),
    }))
    .filter((x) => !used.has(x.value));
}

/* ---------------- 省略音关键字 ---------------- */

/**
 * 省略音的两个写法（用户 2026-11-08）：`no` 短、`omit` 明确。解析器两个都认。
 * 顺序就是补全顺序：打 `o` 时 `omit` 在前、`no` 在后。
 */
const OMIT_WORDS = ['omit', 'no'];

/**
 * 末尾的省略音关键字补全：`C13o` → `C13omit` / `C13no`；`C13n` → `C13no`。
 *
 * 触发条件很窄：关键字前面必须是**数字或括号**（`C13o` / `C13(no`）。
 * 这样 `Co` 不会被抢走 —— 那是 Cdim 的别名，用户打它就是想写减三和弦。
 * 已经打全的关键字不再给候选（`C13omit` 返回空），否则会出现「候选和你打的一模一样」。
 *
 * 返回完整候选值（`C13omit`），带着已经打好的前缀：选完光标停在末尾，接着打数字就行。
 */
export function omitWordSuggestions(text) {
  const raw = String(text ?? '');
  const m = raw.match(/([\d)）(（])(omit|omi|om|o|no|n)$/i);
  if (!m) return [];
  const partial = m[2].toLowerCase();
  const head = raw.slice(0, raw.length - m[2].length);
  return OMIT_WORDS.filter((w) => w.includes(partial) && w !== partial).map((w) => head + w);
}

/* ---------------- 字母和弦 ---------------- */

/**
 * 单字母缩写（2026-11-08 用户要求的手感，当日又按「谁更常用」调过一次顺序）。
 *
 *   `Cj` → Cmaj7 / Cmaj9 / Cmaj13 / Cmaj♯11 / Cmaj13(♯11) / Cmaj11
 *   `Ca` → Cadd2 / Cadd4 / Cadd6 / Cadd9 → Caug → 上面那串 maj
 *
 * 为什么是这两个字母：`j` 是 `maj` 里的那个 j（手指根本到不了 a）；
 * `a` 是 `aug` 的首字母。**但 a 的第一顺位给了 add 系列** —— 用户 2026-11-08 复盘：
 * 「aug 不如 add 系列常用」。所以 `Ca` 的顺序是 **add 族 → aug → maj 族**。
 *
 * 只认这两个字母，**不推广成「任意单字母都模糊匹配」**：那会让 `Cd` 一次蹦出
 * dim / dim7 / add6 / add9 一大片，`Cs` 也会把 `7sus4` 顶到 sus2 前面。
 * 别的前缀缩写（`Cm` / `Cs` / `Cd`）继续走原来的前缀匹配，行为不变。
 *
 * 每一档用 `family` 正则而不是写死后缀表：以后在词表里加 `add…` / `maj…`、
 * 或调整顺序，候选会自己跟上。
 */
const SINGLE_ABBREV = {
  j: [{ family: /^maj/i }],
  a: [{ family: /^add/i }, { first: ['aug'] }, { family: /^maj/i }],
};

/**
 * 缩写一共 11 条（add 四 + aug + maj 六），比常规的 8 条上限多。
 * 这个分支**不受 8 条限制**：缩写本来就是「一次看全，再按方向键挑」的场景，
 * 截断等于把 maj11 藏起来。上限只做兜底，防止以后词表里 `add…` / `maj…` 爆炸。
 */
const ABBREV_LIMIT = 14;

/** 单字母缩写展开成候选：按 `SINGLE_ABBREV` 的档位顺序，每档内部按词表顺序 */
function abbrevCandidates(quals, letter, root, hintFn) {
  const groups = SINGLE_ABBREV[letter];
  if (!groups) return null;
  const picked = [];
  const used = new Set();
  const push = (q) => {
    if (!q || used.has(q.suffix)) return;
    used.add(q.suffix);
    picked.push({
      value: root + letterSuffix(q),
      label: root + letterSuffix(q),
      hint: hintFn(q),
      primary: q.primary,
      order: quals.indexOf(q),
    });
  };
  for (const g of groups) {
    for (const suffix of g.first ?? []) {
      push(quals.find((q) => String(q.suffix).toLowerCase() === suffix.toLowerCase()));
    }
    if (g.family) for (const q of quals) if (g.family.test(String(q.suffix))) push(q);
  }
  return picked;
}

/**
 * 生成字母和弦候选：先精确命中，再按前缀匹配，最后按词表顺序。
 *
 * 为什么根音要「从长到短」匹配：`C♯` 必须先于 `C`，否则 `C♯7` 会被拆成 `C` + `♯7`，
 * 于是一个候选都出不来（而用户完全看不出为什么）。重升记号是**一个字符**，
 * 但 `C##` 归一之后也是两个字符，长度排序同样能兜住。
 */
export function letterCandidates(doc, token, limit = 8) {
  if (!doc || !Array.isArray(doc.qualities)) return [];
  const roots = chordRoots(doc);
  if (!roots.length) return [];
  const text = normalizeRootText(String(token ?? '').trim());
  if (!text) return [];

  const root = [...roots]
    .filter((r) => typeof r === 'string' && r)
    .sort((a, b) => b.length - a.length)
    .find((r) => text.toLowerCase().startsWith(r.toLowerCase()));
  if (!root) return [];

  const rest = text.slice(root.length);
  const quals = qualityList(doc).filter(letterAllowed);
  const all = quals.map((q) => ({
    value: root + letterSuffix(q),
    label: root + letterSuffix(q),
    hint: hintOf(q),
    primary: q.primary,
    order: quals.indexOf(q),
  }));

  const low = rest.toLowerCase();
  const exact = all.filter((x) => {
    const q = quals[x.order];
    return [q.suffix, ...q.aliases].some((t) => t.toLowerCase() === low);
  });
  const prefix = all
    .filter((x) => {
      if (exact.includes(x)) return false;
      const q = quals[x.order];
      return [q.suffix, ...q.aliases].some((t) => low && t.toLowerCase().startsWith(low));
    })
    /**
     * 前缀命中里，查询后面**紧跟数字**的排前面。
     *
     * 打 `Cm` 想找的是 m7 / m9 / m7b5，不是 maj7 —— 但 `m` / `maj` 都以 m 开头，
     * 按词表顺序排的话，maj 家族（现在有六条）会把 m7 / m9 挤到 8 条上限之外。
     * 判据很直白：`m` 后面跟数字是**同一个词的延续**（m7），跟字母往往是**另一个词**（maj）。
     * 同档内仍是词表顺序（sort 是稳定的），所以这次调整只影响「m 之后」这一种情况。
     */
    .sort((a, b) => {
      const nextIsDigit = (x) => (/^\d/.test(String(quals[x.order].suffix).slice(low.length)) ? 0 : 1);
      return nextIsDigit(a) - nextIsDigit(b);
    });

  let ordered;
  // 单字母缩写（`Cj` / `Ca`）：整套候选由它决定，不掺 exact / 前缀 / 模糊
  const abbrev = rest ? abbrevCandidates(quals, low, root, hintOf) : null;
  if (!rest) {
    // 只打了根音：精确的 C 先出，再按词表顺序出 primary 性质
    const exactRoot = all.filter((x) => x.value.toLowerCase() === text.toLowerCase());
    const primary = all.filter((x) => x.primary && !exactRoot.includes(x));
    ordered = [...exactRoot, ...primary];
  } else if (abbrev) {
    ordered = abbrev;
  } else {
    ordered = [...exact, ...prefix];
    // 打 `C76` / `C67` / `C6` 也能找到 C7sub6：不连续、甚至顺序不同都算
    const used = new Set(ordered.map((x) => x.value));
    ordered.push(...fuzzyQualityCandidates(quals, rest, root, hintOf, used, letterSuffix));
  }

  const seen = new Set();
  const cap = abbrev ? Math.max(limit, ABBREV_LIMIT) : limit;
  return ordered
    .filter((x) => {
      if (seen.has(x.value)) return false;
      seen.add(x.value);
      return true;
    })
    .slice(0, cap)
    .map(({ value, label, hint }) => ({ value, label, hint }));
}

/* ---------------- 级数和弦 ---------------- */

const ROMAN_DEGREES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const DEGREE_RE = /^(vii|iii|vi|iv|v|ii|i)/i;

/**
 * 级数前的降 / 升前缀。
 *
 * 除了 `b` / `#`，还认中文拼音与小鹤双拼：
 *   降：b / j / jiang / jl
 *   升：s / sheng / u / ug
 * 这些只用于**级数前**（bII → ♭II），字母和弦根音仍用 C# / Cb ——
 * 否则 `b` 和音名 B 会打架。
 */
const ACC_PREFIXES = [
  ['jiang', '♭'],
  ['sheng', '♯'],
  ['jl', '♭'],
  ['ug', '♯'],
  ['#', '♯'],
  ['♯', '♯'],
  ['b', '♭'],
  ['♭', '♭'],
  ['j', '♭'],
  ['s', '♯'],
  ['u', '♯'],
  ['♮', ''],
].sort((a, b) => b[0].length - a[0].length);

/** 把开头的降/升前缀拆出来；rest 为空或后面紧跟罗马数字才算前缀 */
function splitAccidentalPrefix(text) {
  const t = String(text ?? '').trim();
  for (const [word, sign] of ACC_PREFIXES) {
    if (t.toLowerCase().startsWith(word.toLowerCase())) {
      const rest = t.slice(word.length);
      if (!rest || DEGREE_RE.test(rest)) return { sign, hadPrefix: true, rest };
    }
  }
  return { sign: '', hadPrefix: false, rest: t };
}

/** `ø7` → '7'、`ø65` → '65'、`m7b5` → '7'；用来匹配 h42 / b65 这类输入 */
function halfFigureOf(q) {
  const s = String(q?.suffix ?? '');
  if (s.startsWith('ø')) return s.slice(1);
  if (s === 'm7b5') return '7';
  return '';
}

/**
 * `ii h42` / `ii b42` / `ii half42` → `iiø42`。
 * 后面的数字是半减七的转位（7 / 65 / 43 / 42），允许只打一半（h4 → ø43 / ø42）。
 * 数字不是转位（比如 b9）时返回 null，让调用方继续走普通性质/模糊匹配。
 */
function halfFigureCandidates(quals, base, suffix, lower, limit) {
  const m = String(suffix ?? '').match(/^(half|ban|bj|h|b)(\d*)$/i);
  if (!m) return null;
  const digits = m[2] ?? '';
  if (digits && !/^[764]/.test(digits)) return null;
  const half = quals.filter(isHalfDim);
  const hits = digits ? half.filter((q) => halfFigureOf(q).startsWith(digits)) : half;
  return hits.slice(0, limit).map((q) => ({
    value: base + q.suffix,
    label: base + q.suffix,
    hint: degreeHint(q, lower),
  }));
}

function accName(sign) {
  if (sign === '♭') return '降';
  if (sign === '♯') return '升';
  return '本位';
}

/** 级数泳道的转位后缀：只在打了 6/4 开头时才出现，不挤占常用性质的位置 */
const ROMAN_INVERSIONS = [
  ['6', '第一转位'],
  ['65', '五六'],
  ['64', '四六'],
  ['43', '三四'],
  ['42', '二'],
];

/**
 * 级数和弦候选。
 *
 * **不再按小调 ii / 大调 vii 把半减七顶到第一位**（用户实际用下来觉得反而碍事）：
 * 裸 `ii` / `vii` 永远先出，半减七只在 `h / half / b / ban / bj` 或带转位数字时出现。
 * `keyName` 参数保留只为调用点兼容，当前不参与排序。
 */
export function degreeCandidates(doc, token, _keyName = null, limit = 8) {
  if (!doc || !Array.isArray(doc.qualities)) return [];
  const quals = qualityList(doc);
  if (!quals.length) return [];

  const raw = String(token ?? '').trim();
  if (!raw) return [];
  const { sign, hadPrefix, rest: afterAcc } = splitAccidentalPrefix(raw);

  const dm = afterAcc.match(DEGREE_RE);
  if (!dm) {
    // 只打了 b / j / jiang / jl / s / sheng / u / ug：先列出七个升降级数
    if (!hadPrefix) return [];
    return ROMAN_DEGREES.map((d, i) => ({
      value: sign + d,
      label: sign + d,
      hint: `${accName(sign)} ${i + 1} 级`,
    }));
  }

  const degreeText = dm[0];
  const suffix = afterAcc.slice(degreeText.length);
  const base = sign + degreeText;
  const lower = degreeText === degreeText.toLowerCase();

  const low = suffix.toLowerCase();
  const withSuffix = quals.filter((q) => degreeAllowed(q));
  /** `6` / `69` 的六九和弦由下面的转位分支单独补，别在普通前缀里抢到 `V6` 前面 */
  const skip69InPrefix = (q) => q.suffix === '(6/9)' && (low === '6' || low === '69');

  // 半减七的输入（h42 / b65 / half7…）优先按「半减七 + 转位」解释
  const halfHit = halfFigureCandidates(withSuffix, base, suffix, lower, limit);
  if (halfHit) return halfHit.slice(0, limit);

  const exact = withSuffix.filter(
    (q) => !skip69InPrefix(q) && [q.suffix, ...q.aliases].some((t) => t.toLowerCase() === low)
  );
  const prefix = withSuffix.filter((q) => {
    if (skip69InPrefix(q) || exact.includes(q)) return false;
    return [q.suffix, ...q.aliases].some((t) => low && t.toLowerCase().startsWith(low));
  });

  let ordered = [];
  if (!suffix) {
    // 裸级数永远第一：`ii` / `vii` 不再被半减七抢位置
    const exactRoot = withSuffix.filter((q) => q.suffix === '');
    const primary = withSuffix.filter((q) => q.primary && q.suffix !== '');
    ordered = [...exactRoot, ...primary];
  } else {
    ordered = [...exact, ...prefix];
  }

  const out = ordered
    .map((q) => ({ value: base + q.suffix, label: base + q.suffix, hint: degreeHint(q, lower) }))
    .filter((x, i, arr) => arr.findIndex((y) => y.value === x.value) === i);

  // 级数里的 `6` 是转位，不是「六和弦」；`6/9` 必须带括号
  if (/^[0-9]/.test(suffix)) {
    const inv = [];
    const exactInv = ROMAN_INVERSIONS.find(([fig]) => fig === suffix);
    if (exactInv) inv.push({ value: base + exactInv[0], label: base + exactInv[0], hint: exactInv[1] });
    if (/^6(?:9|\/9?)?$/.test(suffix) || /^\(6(?:\/9?)?$/.test(suffix)) {
      inv.push({ value: `${base}(6/9)`, label: `${base}(6/9)`, hint: '六九和弦' });
    }
    for (const [fig, hint] of ROMAN_INVERSIONS) {
      if (fig === suffix || !fig.startsWith(suffix)) continue;
      inv.push({ value: base + fig, label: base + fig, hint });
    }
    for (const c of inv) {
      if (!out.some((x) => x.value === c.value)) out.push(c);
    }
  }

  // 最后补「不连续字符」候选：V76 / V67 / V6 → V7sub6；exact / 前缀 / 转位都排在它前面
  const used = new Set(out.map((x) => x.value));
  out.push(...fuzzyQualityCandidates(withSuffix, suffix, base, (q) => degreeHint(q, lower), used));

  return out.slice(0, limit);
}
