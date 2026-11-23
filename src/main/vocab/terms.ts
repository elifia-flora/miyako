import type Database from 'better-sqlite3';
import { termTable } from '../../shared/search.js';

/**
 * 词表 → 搜索用的术语表。
 *
 * 流派（genre）与情绪（mood）的源是 data/vocab/*.json，启动时 sync 进 tag / tag_alias。
 * 搜索与补全都在主进程，直接从库里取 —— 不必让渲染层把整棵词表传下来，
 * 也不会出现「词表改了、搜索还是旧词」的两套数据。
 */

export interface TermRow {
  id: string;
  name: string;
  display: string | null;
  /** 库里真正存的值：流派存 name（Jazz），情绪存 id（nostalgic） */
  value: string;
  aliases: string[];
}

export function termRows(db: Database.Database, dim: string, valueOf: 'id' | 'name' = 'id'): TermRow[] {
  const tags = db.prepare(`SELECT id, name, display FROM tag WHERE dim = ?`).all(dim) as any[];
  const aliases = db.prepare(`SELECT tag_id, alias FROM tag_alias WHERE dim = ?`).all(dim) as any[];
  const aliasBy = new Map<string, string[]>();
  for (const a of aliases) {
    const arr = aliasBy.get(a.tag_id) ?? [];
    arr.push(a.alias);
    aliasBy.set(a.tag_id, arr);
  }
  return tags.map((t) => ({
    id: t.id,
    name: t.name,
    display: t.display,
    value: valueOf === 'name' ? t.name : t.id,
    aliases: aliasBy.get(t.id) ?? [],
  }));
}

/**
 * 搜索要用的几张词表。
 *
 * 注意两边存的**不是同一种值**：流派存 name（历史档案里就是 `Jazz` / `Folk`），
 * 情绪 / 体裁 / 曲式存 id（`nostalgic` / `symphony` / `sonata`）。
 * 所以这里分别取 name / id，免得展开出来的值在 SQL 里对不上列。
 */
export function searchTermTables(db: Database.Database) {
  return {
    moods: termTable(termRows(db, 'mood', 'id')),
    genres: termTable(termRows(db, 'genre', 'name')),
    compositionTypes: termTable(termRows(db, 'composition_type', 'id')),
    forms: termTable(termRows(db, 'form', 'id')),
  };
}
