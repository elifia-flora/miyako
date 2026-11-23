/**
 * search.js — 搜索词的「语义展开」
 *
 * 库里的时期存的是**英文规范值**（`classical`），而用户敲的是中文（古典主义）。
 * 流派（`track.genre`）存的是词条 name（`Jazz`），情绪（`extra.moods`）存的是
 * 词条 id（`nostalgic`），用户敲的同样是中文（爵士 / 怀旧）。直接 LIKE 一定搜不到。
 * 这里把这些中文词翻回库里的值，交给 SQL 去命中 —— 不建索引、不改 schema。
 *
 * 纯 JS 纯函数：主进程（tracks.ts）与 node --test 用的是同一份，
 * 免得「界面能搜到、测试搜不到」这种两套逻辑的老问题。
 *
 * 时期与调式是代码里的常量（历史分期与调式名是音乐理论的定数，不会有人去改）；
 * 流派与情绪是 data/vocab/*.json 里的词表，主进程从 tag / tag_alias 缓存里
 * 读出来，按调用传进来 —— 所以**加一个流派或情绪只要改 JSON**，搜索立刻认得。
 */
import { isHant, toHant } from './hant.js';

const norm = (s) => String(s ?? '').toLowerCase().trim();

/**
 * 时期：id 是 track.period 的规范值，terms 是能被识别出的写法。
 *
 * 只收**历史分期**。爵士 / 民族 / 民谣 / 流行不是时期，是流派（见 data/vocab/genre.json）——
 * 把写法与来源混进时间轴里，「浪漫主义 爵士」这种搜索永远分不清用户想限定哪一个。
 */
export const PERIODS = [
  { id: 'medieval', label: '中世纪', labelJa: '中世', labelEn: 'Medieval', terms: ['medieval', 'middle ages', '中世纪'] },
  { id: 'renaissance', label: '文艺复兴', labelJa: 'ルネサンス', labelEn: 'Renaissance', terms: ['renaissance', '文艺复兴'] },
  { id: 'baroque', label: '巴洛克', labelJa: 'バロック', labelEn: 'Baroque', terms: ['baroque', '巴洛克'] },
  { id: 'classical', label: '古典主义', labelJa: '古典派', labelEn: 'Classical', terms: ['classical', '古典主义', '古典乐派', '古典'] },
  { id: 'romantic', label: '浪漫主义', labelJa: 'ロマン派', labelEn: 'Romantic', terms: ['romantic', 'romanticism', '浪漫主义', '浪漫乐派', '浪漫'] },
  { id: 'impressionist', label: '印象派', labelJa: '印象派', labelEn: 'Impressionist', terms: ['impressionist', 'impressionism', '印象派', '印象主义', '印象'] },
  { id: 'modern', label: '现代', labelJa: '近代', labelEn: 'Modern', terms: ['modern', '现代主义', '现代'] },
  { id: 'contemporary', label: '当代', labelJa: '現代', labelEn: 'Contemporary', terms: ['contemporary', '当代', '近现代'] },
];

/**
 * 调式 / 调性：analysis_marker.key_name 是 "c dorian"、"f natural minor" 这种
 * 「主音 + 调式」的写法，所以只匹配调式那一段。
 */
export const KEY_MODES = [
  { id: 'dorian', label: '多利亚', labelJa: 'ドリア', labelEn: 'Dorian', terms: ['dorian', '多利亚', '多里安', '多利安'] },
  { id: 'phrygian', label: '弗里几亚', labelJa: 'フリギア', labelEn: 'Phrygian', terms: ['phrygian', '弗里几亚', '弗里吉亚', '弗利吉亚'] },
  { id: 'lydian', label: '利底亚', labelJa: 'リディア', labelEn: 'Lydian', terms: ['lydian', '利底亚', '吕底亚', '利地亚'] },
  { id: 'mixolydian', label: '混合利底亚', labelJa: 'ミクソリディア', labelEn: 'Mixolydian', terms: ['mixolydian', '混合利底亚', '混合吕底亚'] },
  { id: 'aeolian', label: '伊奥利亚', labelJa: 'エオリア', labelEn: 'Aeolian', terms: ['aeolian', '伊奥利亚', '爱奥利亚', '艾奥里亚'] },
  { id: 'ionian', label: '伊奥尼亚', labelJa: 'イオニア', labelEn: 'Ionian', terms: ['ionian', '伊奥尼亚', '爱奥尼亚'] },
  { id: 'locrian', label: '洛克里亚', labelJa: 'ロクリア', labelEn: 'Locrian', terms: ['locrian', '洛克里亚'] },
  { id: 'natural minor', label: '自然小调', labelJa: '自然短調', labelEn: 'Natural minor', terms: ['natural minor', '自然小调'] },
  { id: 'harmonic minor', label: '和声小调', labelJa: '和声短調', labelEn: 'Harmonic minor', terms: ['harmonic minor', '和声小调'] },
  { id: 'melodic minor', label: '旋律小调', labelJa: '旋律短調', labelEn: 'Melodic minor', terms: ['melodic minor', '旋律小调'] },
  { id: 'major', label: '大调', labelJa: '長調', labelEn: 'Major', terms: ['major', '大调'] },
  { id: 'minor', label: '小调', labelJa: '短調', labelEn: 'Minor', terms: ['minor', '小调'] },
  { id: 'pentatonic', label: '五声', labelJa: '五音音階', labelEn: 'Pentatonic', terms: ['pentatonic', '五声', '五音'] },
  { id: 'whole tone', label: '全音阶', labelJa: '全音音階', labelEn: 'Whole tone', terms: ['whole tone', '全音阶', '全音'] },
  { id: 'blues', label: '布鲁斯', labelJa: 'ブルース', labelEn: 'Blues', terms: ['blues', '布鲁斯', '蓝调'] },
];

/**
 * 词表条目 → 术语表。
 *
 * @param rows 来自 tag / tag_alias 的条目：`{ id, name, display, value?, aliases? }`。
 *   `value` 是「库里真正存的值」——流派存 name（`Jazz`），情绪存 id（`nostalgic`）。
 *   不给就退回 id。
 * @returns `{ value, name, display, terms }[]`，terms 已归一化（小写、去空白）
 */
export function termTable(rows) {
  return (rows ?? [])
    .filter((r) => r && r.id)
    .map((r) => {
      const forms = [r.name, r.display, ...(r.aliases ?? [])].filter(Boolean).map(norm);
      return {
        value: r.value ?? r.id,
        name: r.name ?? r.id,
        display: r.display ?? r.name ?? r.id,
        terms: [...new Set(forms)].filter(Boolean),
      };
    });
}

/**
 * 一条术语是否命中搜索词。
 *
 * 中文按子串（「爵士」出现在「融合爵士」里也该算）；
 * 英文 / 数字按**整词**：词表里有 ost、pop、rock 这种三字母流派，
 * 用子串匹配会让「nostalgic」命中所有原声带（n-o-s-t… 里有个 ost），
 * 也会让「popular」命中所有流摇。这个词表不是手写的小表，必须防这个。
 */
const ASCII_TERM = /^[\x20-\x7e]+$/;

function termHit(q, term) {
  if (!term) return false;
  if (!ASCII_TERM.test(term)) return q.includes(term);
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(q);
}

function expand(table, q) {
  const hits = [];
  for (const row of table ?? []) {
    for (const t of row.terms) {
      if (termHit(q, t)) {
        // 静态表（时期 / 调式）只有 id；词表行由 termTable 给出 value（流派存 name）
        hits.push(row.value ?? row.id);
        break;
      }
    }
  }
  // 同一 id 在多个根下会出现多条（流派 / 情绪都允许），去重后按出现顺序返回
  return [...new Set(hits)];
}

/**
 * 把一句搜索词里的「时期 / 调性 / 情绪 / 流派 / 体裁 / 曲式」抽出来。
 *
 * @param extra `{ moods, genres, compositionTypes, forms }` —— 由 termTable() 从词表缓存造出来的几张表。
 *   不给就只认时期与调式（单元测试与「没有词表」的场景走这条）。
 * @returns {{ periods, keyModes, moods, genres, compositionTypes, forms }}
 *   periods 是 track.period 的值，moods 是 extra.moods 里的 id，genres 是 track.genre 里的 name，
 *   compositionTypes / forms 是 track 两列里存的词表 id。
 */
export function expandQuery(text, extra = {}) {
  const q = norm(text);
  if (!q) return { periods: [], keyModes: [], moods: [], genres: [], compositionTypes: [], forms: [] };
  return {
    periods: expand(PERIODS, q),
    keyModes: expand(KEY_MODES, q),
    moods: expand(extra.moods, q),
    genres: expand(extra.genres, q),
    compositionTypes: expand(extra.compositionTypes, q),
    forms: expand(extra.forms, q),
  };
}

/** 词表里带空格的写法（natural minor / middle ages / Chamber Music）：分词时不能被拆散 */
const BASE_PHRASES = [...PERIODS, ...KEY_MODES]
  .flatMap((row) => row.terms)
  .filter((term) => term.includes(' '))
  .map(norm);

function phrasesOf(extra) {
  const more = [
    ...(extra?.moods ?? []),
    ...(extra?.genres ?? []),
    ...(extra?.compositionTypes ?? []),
    ...(extra?.forms ?? []),
  ]
    .flatMap((row) => row.terms)
    .filter((term) => term.includes(' '));
  return more.length ? [...new Set([...BASE_PHRASES, ...more])] : BASE_PHRASES;
}

/**
 * 搜索框按空格分词，每个词都必须命中（字段之间取并集，词之间取交集）。
 *
 * 为什么必须分词：整句当一个 LIKE（`%钢片琴 低音提琴%`）等于要求两个词
 * 在同一个字段里**连续**出现，而「钢片琴」和「低音提琴」是两个不同标签，
 * 永远不可能出现在同一行 —— 于是越精确的搜索越搜不到。
 *
 * 带空格的调式名（`c natural minor` 里的 `natural minor`）与流派名
 * （`Chamber Music`）按整词保留，否则会被拆成两个更宽的词。
 */
export function splitTerms(text, extra = {}) {
  const phrases = phrasesOf(extra);
  const raw = norm(text).split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    // 只合并相邻两词：当前词表里的短语最长两个词
    const pair = raw[i + 1] ? `${raw[i]} ${raw[i + 1]}` : null;
    if (pair && phrases.includes(pair)) {
      out.push(pair);
      i++;
    } else {
      out.push(raw[i]);
    }
  }
  return out;
}

/**
 * 一张表三套标签：`label` 中文（默认，测试与旧代码都按它断言）、`labelEn` 英文、
 * `labelJa` 日文。缺哪一套就退到英文、再退到 id —— **不退回中文**，
 * 免得日文界面里夹进「巴洛克」这种只有中文读者认得的译名。
 *
 * keyname.js 的调性候选也走这里，所以只维护这一份。
 */
export function pickLabel(hit, locale) {
  if (!hit) return '';
  if (locale === 'ja') return hit.labelJa ?? hit.labelEn ?? hit.id;
  if (locale === 'en') return hit.labelEn ?? hit.id;
  // 繁体：这张表只有简中一份，逐字转繁即可（「浪漫主义」→「浪漫主義」）。
  // 时期 / 调式名不会踩到词汇差异（不需要「檔案」那种整词替换）。
  if (isHant(locale)) return toHant(hit.label ?? hit.id);
  return hit.label ?? hit.id;
}

/** 规范值 → 显示名。 */
export function periodLabel(id, locale = 'zh') {
  if (!id) return '—';
  const hit = PERIODS.find((p) => p.id === norm(id));
  if (!hit) return String(id);
  return pickLabel(hit, locale);
}

/** 调式规范值 → 显示名（详情栏用得上） */
export function keyModeLabel(id, locale = 'zh') {
  if (!id) return '—';
  const hit = KEY_MODES.find((k) => k.id === norm(id));
  if (!hit) return String(id);
  return pickLabel(hit, locale);
}
