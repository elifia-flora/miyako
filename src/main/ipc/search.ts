import type Database from 'better-sqlite3';
import type { SearchSuggestion } from '../../shared/types';
import { PERIODS } from '../../shared/search.js';

/**
 * search.ts — 搜索框补全
 *
 * 只补「一个词」，不补整句：搜索是词之间 AND，用户敲到一半的永远是最后那一段。
 *
 * 候选来源是**词表**：乐器 / 演奏技法 / 作曲技法 / 流派 / 情绪，再加时期。
 * 这几类都是「想不起来叫什么」时最需要的；曲名、作曲家直接敲就行，
 * 列出来只会把真正的词条挤下去。
 *
 * 流派与情绪也在 tag 表里（data/vocab/genre.json / mood.json 同步进来的），
 * 所以这里不另抄一张表：同一个循环按 dim 决定 kind，
 * 词表改了补全自动跟着改，不会出现「补全推的是旧词」。
 */

const norm = (s: unknown) => String(s ?? '').toLowerCase().trim();

/** 这三个维度有自己的 kind / 提示文案；其余标签统一算 instrument 类的 tag */
const KIND_BY_DIM: Record<string, SearchSuggestion['kind']> = {
  mood: 'mood',
  genre: 'genre',
};

/** 命中强度：整词 > 前缀 > 子串。返回实际命中的那个写法（回填时用它） */
function rank(q: string, forms: (string | null | undefined)[]) {
  let score = 0;
  let hit: string | null = null;
  for (const f of forms) {
    const v = norm(f);
    if (!v) continue;
    const s = v === q ? 100 : v.startsWith(q) ? 80 : v.includes(q) ? 55 : 0;
    if (s > score) {
      score = s;
      hit = String(f);
    }
  }
  return hit ? { score, hit } : null;
}

export function suggestSearch(
  { db }: { db: Database.Database },
  input: string,
  limit = 8
): SearchSuggestion[] {
  const q = norm(input);
  if (!q) return [];

  const out: SearchSuggestion[] = [];

  const tags = db.prepare(`SELECT id, dim, name, display FROM tag`).all() as any[];
  const aliases = db.prepare(`SELECT tag_id, alias FROM tag_alias`).all() as any[];
  const aliasBy = new Map<string, string[]>();
  for (const a of aliases) {
    const arr = aliasBy.get(a.tag_id) ?? [];
    arr.push(a.alias);
    aliasBy.set(a.tag_id, arr);
  }
  for (const t of tags) {
    const r = rank(q, [t.display, t.name, ...(aliasBy.get(t.id) ?? [])]);
    if (!r) continue;
    const kind = KIND_BY_DIM[t.dim] ?? 'tag';
    out.push({
      kind,
      id: t.id,
      dim: kind === 'tag' ? t.dim : null,
      label: t.display || t.name,
      en: t.name,
      insert: r.hit,
      // 语义词（流派 / 情绪）命中一样算，但同样的分数下让具体词条排前面
      score: r.score - (kind === 'tag' ? 0 : 4),
    });
  }

  // 时期不是词表（历史分期是定数），仍然从常量表里取
  for (const p of PERIODS) {
    const r = rank(q, [p.label, p.labelEn, ...p.terms]);
    if (!r) continue;
    out.push({
      kind: 'period',
      id: p.id,
      dim: null,
      label: p.label,
      en: p.labelEn,
      insert: r.hit,
      score: r.score - 6,
    });
  }

  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  const seen = new Set<string>();
  return out
    .filter((s) => {
      // 同一个词在多个词根下各有一条（转调 → melodic / harmonic），列表里只留一条
      const k = `${s.kind}:${s.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}
