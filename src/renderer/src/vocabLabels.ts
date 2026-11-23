import { reactive } from 'vue';

/**
 * 流派 / 体裁 / 曲式 / 情绪词表的渲染层缓存。
 *
 * 这几个字段在库里存的是**值**（genre 存 name `Jazz`，composition_type / form / moods 存 id），
 * 界面要显示中文，编辑时还要把中文翻回值 —— 都要一份「值 ↔ 标签 ↔ 别名」的表。
 *
 * 这份表从 data/vocab/*.json 读（`vocab.doc`），不抄在 i18n 里：
 * 词表是唯一源，改了 JSON 就换词，界面、搜索、补全同时跟上。
 * 换语言不影响这里 —— 中文用 display，英文用 name（和标签的约定一致）。
 */

const api = (window as any).api;

/** 需要「值 → 显示名」映射的维度。都是单值字段（情绪是逗号分隔的多值） */
export type LabelDim = 'mood' | 'genre' | 'composition_type' | 'form';

const LABEL_DIMS: LabelDim[] = ['mood', 'genre', 'composition_type', 'form'];

export interface LabelEntry {
  id: string;
  /** 规范名（英文），也是 genre 在库里的值 */
  name: string;
  /** 中文显示名 */
  display: string;
  /** 全部可识别写法（id / name / display / 别名 / 译名），已归一化 */
  terms: string[];
}

export const vocabLabels = reactive<Record<LabelDim, LabelEntry[]>>({
  mood: [],
  genre: [],
  composition_type: [],
  form: [],
});

const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

function flatten(nodes: any[], out: LabelEntry[] = []): LabelEntry[] {
  for (const n of nodes ?? []) {
    if (!n?.id) continue;
    const forms = [n.id, n.name, n.display, ...(n.aliases ?? []), ...Object.values(n.translations ?? {})];
    out.push({
      id: n.id,
      name: n.name ?? n.id,
      display: n.display || n.name || n.id,
      terms: [...new Set(forms.filter(Boolean).map(norm))],
    });
    flatten(n.children ?? [], out);
  }
  return out;
}

/** 启动时读一次；词表在编辑器里保存后要再读一次（onVocabSaved） */
export async function loadVocabLabels() {
  for (const dim of LABEL_DIMS) {
    try {
      const doc = await api.vocab.doc(dim);
      vocabLabels[dim] = flatten(doc?.roots ?? []);
    } catch {
      // 词表文件坏了也不能让整个界面起不来：退化成「原样显示」
      vocabLabels[dim] = [];
    }
  }
}

/** 按值找条目：先认 id / name，再认别名与中文 */
function find(dim: LabelDim, text: string): LabelEntry | null {
  const k = norm(text);
  if (!k) return null;
  const list = vocabLabels[dim];
  return (
    list.find((e) => norm(e.id) === k) ??
    list.find((e) => norm(e.name) === k) ??
    list.find((e) => e.terms.includes(k)) ??
    null
  );
}

/**
 * 详情里的情绪：中文界面写成「怀旧 nostalgic」（值本身是英文枚举，留着便于对照档案），
 * 英文界面就显示值本身。
 */
export function moodLabel(value: string, locale: string): string {
  const hit = find('mood', value);
  if (!hit) return value;
  if (locale === 'en') return hit.name;
  return hit.display === hit.name ? hit.name : `${hit.display} ${hit.name}`;
}

/**
 * 通用：单值字段（流派 / 体裁 / 曲式）的显示名。
 * 中文用 display、英文用 name；词表里没有的原样显示 —— 不吞用户手写的值。
 */
export function entryLabel(dim: LabelDim, value: string | null | undefined, locale: string): string {
  if (!value) return '';
  const hit = find(dim, value);
  if (!hit) return value;
  return locale === 'en' ? hit.name : hit.display;
}

/** 用户敲的中文 / 别名 → 库里要存的值（词表 id）。认不出就按原文存，不吞输入 */
export function entryIdOf(dim: LabelDim, text: string): string {
  const hit = find(dim, text);
  return hit ? hit.id : text.trim();
}

/** 流派：中文显示 display，英文显示 name；词表里没有的原样显示 */
export function genreLabel(value: string | null | undefined, locale: string): string {
  return entryLabel('genre', value, locale);
}

/** 只给一个显示名（编辑态用）：中文 display、英文 name，不夹带英文枚举 */
export function moodDisplay(value: string, locale: string): string {
  const hit = find('mood', value);
  if (!hit) return value;
  return locale === 'en' ? hit.name : hit.display;
}

/** 用户敲的中文 / 别名 → 库里要存的值。认不出就按原样（小写）存，不吞输入 */
export function moodIdOf(text: string): string {
  const hit = find('mood', text);
  return hit ? hit.id : text.trim().toLowerCase();
}

export function genreNameOf(text: string): string {
  const hit = find('genre', text);
  return hit ? hit.name : text.trim();
}
