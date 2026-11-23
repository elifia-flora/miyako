import fs from 'node:fs';
import path from 'node:path';

/**
 * 字母和弦补全用的词表（`data/vocab/chord-symbols.json`）。
 *
 * 为什么单独一个文件、而不是塞进标签词表：标签词表是「树 + 维度 + 别名」，
 * 这套只是「音名 × 变音 × 性质」的笛卡尔积，结构完全不同；塞进去会让 loadVocab 多出一个假维度。
 *
 * 为什么分三张表而不是一百多个符号：手写列表加一种性质要改 7×5 处，还必然有人漏。
 *
 * v2 起把「根音」拆成**音名（7 个字母）+ 变音记号（还原/♯/♭/𝄪/𝄫）**：
 * 以前 roots 里混着 `C#` 和 `E♭` 两种写法，加一个「重升」就要在 12 条里挑着加，
 * 还会撞上「C# 和 D♭ 是同一个音」的歧义。拆开之后候选 = 字母 × 变音 × 性质，
 * 想加一种变音只改一处，想只保留常用根音就把对应变音删掉。
 */
export interface ChordQuality {
  /** 写进格子的后缀：'' / 'm' / '7' / '7sus4'… */
  suffix: string;
  /** 候选列表右边那句中文说明 */
  label: string;
  /** 只打了根音时是否出现在前 8 条里 */
  primary?: boolean;
  /**
   * 同一性质的其它写法（半减七的 ø / ø7 / min7b5 等）。
   * 会显示在候选说明里；解析器内置常见别名，词表只负责记录与展示。
   */
  aliases?: string[];
}

/** 一个变音记号：`sign` 是拼进和弦名的那个字符，`label` 是给人看的说明 */
export interface ChordAccidental {
  /** '' = 本位音（还原）；其余是 ♯ ♭ 𝄪 𝄫 这类**单个**符号 */
  sign: string;
  label: string;
}

export interface ChordSymbolDoc {
  schemaVersion: number;
  note?: string;
  /** 七个音名，不带任何升降号 */
  letters: string[];
  /** 变音记号表：至少要有一条 sign='' 的本位音，否则 `C` 这种写法出不来 */
  accidentals: ChordAccidental[];
  qualities: ChordQuality[];
}

export const CHORD_SYMBOLS_FILE = 'chord-symbols.json';

export const DEFAULT_CHORD_SYMBOLS: ChordSymbolDoc = {
  schemaVersion: 2,
  note:
    '和弦符号补全：字母和弦 = 音名 × 变音记号 × 性质；级数和弦按这里的性质顺序补全。数组顺序就是补全顺序，可用编辑器上移/下移。别名只进说明，不复制候选行。',
  letters: ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
  accidentals: [
    { sign: '', label: '本位（还原）' },
    { sign: '♯', label: '升' },
    { sign: '♭', label: '降' },
    { sign: '𝄪', label: '重升' },
    { sign: '𝄫', label: '重降' },
  ],
  qualities: [
    { suffix: '', label: '大三和弦', primary: true },
    { suffix: 'm', label: '小三和弦', primary: true, aliases: ['min'] },
    { suffix: '7', label: '属七', primary: true },
    { suffix: '7sus4', label: '属七挂四', primary: true, aliases: ['7sus'] },
    { suffix: '7♭9', label: '属七降九', aliases: ['7b9'] },
    { suffix: '7sub6', label: '属七 · 六音替五音' },
    { suffix: '(6/9)', label: '六九和弦', primary: true, aliases: ['6/9', '69'] },
    { suffix: 'ø7', label: '半减七 · 原位' },
    { suffix: 'ø65', label: '半减七 · 五六' },
    { suffix: 'ø43', label: '半减七 · 三四' },
    { suffix: 'ø42', label: '半减七 · 二' },
    { suffix: 'm7b5', label: '半减七（m7b5）', aliases: ['ø', 'min7b5'] },
    { suffix: 'sus2', label: '挂二', primary: true },
    { suffix: 'sus4', label: '挂四', primary: true, aliases: ['sus'] },
    { suffix: 'sub6', label: '六音替五音' },
    { suffix: 'maj7', label: '大七', primary: true },
    /* 大和弦家族按「七 → 九 → 十三 → 升十一 → 十三升十一 → 十一」排。
       顺序就是补全顺序：字母和弦打 `Cj` 会按这个次序出这六条（见 shared/cellsug.js）。 */
    { suffix: 'maj9', label: '大九' },
    { suffix: 'maj13', label: '大十三' },
    { suffix: 'maj♯11', label: '大七升十一' },
    { suffix: 'maj13(♯11)', label: '大十三升十一' },
    { suffix: 'maj11', label: '大十一' },
    { suffix: 'm7', label: '小七', primary: true, aliases: ['min7'] },
    { suffix: 'dim', label: '减三', primary: true, aliases: ['°', 'o'] },
    { suffix: 'dim7', label: '减七', aliases: ['°7', 'o7'] },
    { suffix: 'aug', label: '增三', aliases: ['+'] },
    { suffix: 'add2', label: '加二音' },
    { suffix: 'add4', label: '加四音' },
    { suffix: 'add6', label: '加六音' },
    { suffix: '6', label: '六和弦' },
    { suffix: 'add9', label: '加九' },
    { suffix: '9', label: '九和弦' },
    { suffix: 'm9', label: '小九', aliases: ['min9'] },
  ],
};

export function chordSymbolsPath(dataDir: string): string {
  return path.join(dataDir, 'vocab', CHORD_SYMBOLS_FILE);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 词表里的别名：数组优先；也容忍手写成逗号分隔的字符串 */
function normalizeAliases(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，]/) : [];
  const out: string[] = [];
  for (const item of list) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 老文件（v1）迁移：`roots: ['C','C#','E♭']` → 音名 + 变音两张表。
 *
 * 只在真读到一个带 roots、没有 letters 的文件时走这条路 ——
 * 已经改过结构的文件不受影响。拆的时候认清 ASCII 的 `#`/`b`/`x` 和 Unicode 的 ♯/♭/𝄪/𝄫：
 * 老表里两种写法混着用（`C#` 和 `E♭` 同时存在），不归一的话会冒出「两个不同的 C♯」。
 */
const ACC_CANON: Record<string, string> = {
  '': '',
  '#': '♯', '♯': '♯', '##': '𝄪', 'x': '𝄪', 'X': '𝄪', '𝄪': '𝄪',
  b: '♭', '♭': '♭', bb: '𝄫', '𝄫': '𝄫',
};

function splitRoot(root: string): { letter: string; sign: string } | null {
  const m = String(root ?? '').trim().match(/^([A-Ga-g])([^A-Za-z]*)$/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const tail = m[2].trim();
  const sign = ACC_CANON[tail];
  if (sign === undefined) return null;
  return { letter, sign };
}

/** 读不到 / 结构坏了都退回内置表：补全缺几条远比启动失败好 */
export function loadChordSymbols(dataDir: string): ChordSymbolDoc {
  try {
    const raw = JSON.parse(fs.readFileSync(chordSymbolsPath(dataDir), 'utf8'));
    const qualities = Array.isArray(raw?.qualities)
      ? raw.qualities
          .filter((q: any) => q && typeof q.suffix === 'string')
          .map((q: any) => ({
            suffix: String(q.suffix),
            label: str(q.label) || String(q.suffix),
            primary: q.primary === true,
            aliases: normalizeAliases(q.aliases),
          }))
      : [];
    if (!qualities.length) return { ...DEFAULT_CHORD_SYMBOLS };

    let letters = Array.isArray(raw?.letters) ? raw.letters.map(str).filter(Boolean) : [];
    let accidentals: ChordAccidental[] = Array.isArray(raw?.accidentals)
      ? raw.accidentals
          .filter((a: any) => a && typeof a.sign === 'string')
          .map((a: any) => ({ sign: String(a.sign).trim(), label: str(a.label) || String(a.sign).trim() }))
      : [];

    // v1 文件：roots → letters + accidentals。用户不用手改 JSON 就能升上来
    if (!letters.length && Array.isArray(raw?.roots)) {
      const seenL: string[] = [];
      const seenA: string[] = [];
      for (const r of raw.roots) {
        const hit = splitRoot(str(r));
        if (!hit) continue;
        if (!seenL.includes(hit.letter)) seenL.push(hit.letter);
        if (!seenA.includes(hit.sign)) seenA.push(hit.sign);
      }
      letters = seenL;
      accidentals = seenA.map((sign) => ({ sign, label: sign || '本位（还原）' }));
    }

    if (!letters.length || !accidentals.length) return { ...DEFAULT_CHORD_SYMBOLS };
    return { schemaVersion: 2, note: str(raw?.note), letters, accidentals, qualities };
  } catch {
    return { ...DEFAULT_CHORD_SYMBOLS };
  }
}

/**
 * 保存前做结构与去重校验。
 *
 * 这里**不猜用户想干嘛**：空音名、空说明、空后缀（后缀本来就可以为空，但 label 不能）一律报错，
 * 静默「修正」会让用户以为保存成功了，下次打开发现少了几条。
 *
 * 唯一的例外是**完全空白的新行**：编辑器点「+ 性质 / + 变音记号」会先插一条空行，
 * 用户还没来得及填就点保存时，这条空行直接跳过 —— 否则「添加」本身就会让整张表保存失败。
 * 只填了一半的行仍然报错，并且错误里带行号，能直接找到是哪一行。
 */
export function saveChordSymbols(
  dataDir: string,
  doc: any
): { ok: true; doc: ChordSymbolDoc } | { ok: false; error: string } {
  const letters: string[] = [];
  for (const r of Array.isArray(doc?.letters) ? doc.letters : []) {
    const s = str(r);
    if (!s) continue;
    if (!/^[A-Ga-g]$/.test(s)) return { ok: false, error: `音名只能是单个 A–G 字母：${s}` };
    const up = s.toUpperCase();
    if (!letters.includes(up)) letters.push(up);
  }
  if (!letters.length) return { ok: false, error: '至少要有一个音名' };

  const accidentals: ChordAccidental[] = [];
  const rawAccidentals = Array.isArray(doc?.accidentals) ? doc.accidentals : [];
  for (let i = 0; i < rawAccidentals.length; i++) {
    const a = rawAccidentals[i];
    const sign = str(a?.sign);
    const label = str(a?.label);
    // 完全空白的新行：跳过，不拿它挡住整张表
    if (!sign && !label) continue;
    if (/[\s,]/.test(sign)) return { ok: false, error: `第 ${i + 1} 行变音记号里不能有空格或逗号：${sign}` };
    if (!label) return { ok: false, error: `第 ${i + 1} 行变音记号缺少说明文字` };
    if (accidentals.some((x) => x.sign === sign)) {
      return { ok: false, error: `变音记号重复：${sign || '（本位音）'}` };
    }
    accidentals.push({ sign, label });
  }
  if (!accidentals.length) return { ok: false, error: '至少要有一个变音记号' };
  if (!accidentals.some((a) => a.sign === '')) {
    // 没有本位音就等于「所有和弦都带升降号」，`C` 这种最常用的写法永远出不来
    return { ok: false, error: '要留一条空的变音记号（本位音 / 还原），否则 C 这种写法出不来' };
  }

  const qualities: ChordQuality[] = [];
  const rawQualities = Array.isArray(doc?.qualities) ? doc.qualities : [];
  for (let i = 0; i < rawQualities.length; i++) {
    const q = rawQualities[i];
    const suffix = typeof q?.suffix === 'string' ? q.suffix.trim() : '';
    const label = str(q?.label);
    const rawAliases = Array.isArray(q?.aliases)
      ? q.aliases.map(str).filter(Boolean)
      : typeof q?.aliases === 'string'
        ? q.aliases.split(/[,，]/).map(str).filter(Boolean)
        : [];
    // 完全空白的新行：跳过
    if (!suffix && !label && !rawAliases.length && q?.primary !== true) continue;

    if (!label) return { ok: false, error: `第 ${i + 1} 行性质缺少说明文字` };
    if (suffix && /\s/.test(suffix)) return { ok: false, error: `第 ${i + 1} 行性质后缀里不能有空格：${suffix}` };
    if (qualities.some((x) => x.suffix === suffix)) {
      return { ok: false, error: `性质重复：${suffix || '（大三和弦）'}` };
    }

    const aliases: string[] = [];
    for (const a of rawAliases) {
      if (/\s/.test(a)) return { ok: false, error: `第 ${i + 1} 行别名里不能有空格：${a}` };
      if (a === suffix) return { ok: false, error: `第 ${i + 1} 行别名不能和后缀相同：${a}` };
      if (aliases.includes(a)) return { ok: false, error: `第 ${i + 1} 行别名重复：${a}` };
      aliases.push(a);
    }
    const item: ChordQuality = { suffix, label, primary: q?.primary === true };
    if (aliases.length) item.aliases = aliases;
    qualities.push(item);
  }
  if (!qualities.length) return { ok: false, error: '至少要有一种性质' };

  // 别名不能撞上任何一条性质的后缀 —— 否则补全说明里会出现两种互相矛盾的写法
  for (const q of qualities) {
    for (const a of q.aliases ?? []) {
      if (qualities.some((x) => x.suffix === a)) {
        return { ok: false, error: `别名和性质后缀重名：${a}` };
      }
    }
  }

  /**
   * note 不在编辑器表单里，但它属于这份 JSON。
   * 保存时不能因为界面没提交这个字段就把文件里的说明擦掉：没给就沿用旧文件的。
   */
  let note = str(doc?.note);
  if (typeof doc?.note !== 'string') {
    try {
      const old = JSON.parse(fs.readFileSync(chordSymbolsPath(dataDir), 'utf8'));
      note = str(old?.note);
    } catch {
      /* 旧文件读不到就用空字符串 */
    }
  }

  const out: ChordSymbolDoc = { schemaVersion: 2, note, letters, accidentals, qualities };
  const abs = chordSymbolsPath(dataDir);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // 2 空格缩进 + 结尾换行：跟其它词表一致，git diff 才只显示变化的行
  fs.writeFileSync(abs, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return { ok: true, doc: out };
}
