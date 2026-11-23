import type Database from 'better-sqlite3';
import type { OrphanReport, TagSuggestion } from '../../shared/types';
import { findOrphans, norm, type VocabSet } from '../vocab/load';
import { appendVocabTag } from '../vocab/write';

interface TagCtx {
  db: Database.Database;
  vocab: VocabSet;
  dataDir: string;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * 输入补全：完全相等 → 别名 → 前缀 → 子串 → 编辑距离 ≤2 → 允许新建。
 *
 * 「完全相等」必须当成一条**正常候选**返回（`how: 'exact'` + `exact: true`），
 * 不能因为「用户已经打全了」就把它藏起来：渲染层要把它显示出来并默认选中，
 * 用户按回车时才知道自己敲的那条被认出来了。藏起来的后果是候选里只剩编辑距离
 * ≤2 的近似项（`神秘` → 悲伤 / 忧郁…），默认高亮第一条，回车把用户敲的字**换掉**。
 *
 * 分数刻意分层：exact(100) > alias(96) > 前缀(80) > 子串(60) > 模糊(40-10*dist)。
 * 别名不能和 exact 同分 —— 同分时 `name.localeCompare` 兜底会让正主排到别人后面。
 */
export function suggestTags({ db }: TagCtx, dim: string, input: string): TagSuggestion[] {
  const q = norm(input);
  if (!q) return [];

  const tags = db.prepare(`SELECT id, dim, name, display FROM tag WHERE dim = ?`).all(dim) as any[];
  const aliases = db.prepare(`SELECT alias, tag_id FROM tag_alias WHERE dim = ?`).all(dim) as any[];
  const aliasByTag = new Map<string, string[]>();
  for (const a of aliases) {
    const arr = aliasByTag.get(a.tag_id) ?? [];
    arr.push(a.alias);
    aliasByTag.set(a.tag_id, arr);
  }

  const out: TagSuggestion[] = [];
  for (const t of tags) {
    const nameQ = norm(t.name);
    const displayQ = norm(t.display);
    const aliasQ = (aliasByTag.get(t.id) ?? []).map((a) => norm(a)).filter(Boolean);
    // 规范名 / 显示名 / 别名分开比：`display` 常常也被写进 aliases（mood.json 里「神秘」就是），
    // 只用一个数组判等的话，说不清这条到底是「正主」还是「别名兜住的」。
    const canonHit = (!!nameQ && nameQ === q) || (!!displayQ && displayQ === q);
    const aliasHit = !canonHit && aliasQ.includes(q);
    const forms = [nameQ, displayQ, ...aliasQ].filter(Boolean);

    let how: TagSuggestion['how'] = 'prefix';
    let score = 0;

    if (canonHit) {
      how = 'exact';
      score = 100;
    } else if (aliasHit) {
      how = 'alias';
      score = 96;
    } else if (forms.some((n) => n.startsWith(q))) {
      how = 'prefix';
      score = 80;
    } else if (forms.some((n) => n.includes(q))) {
      how = 'prefix';
      score = 60;
    } else {
      const dist = Math.min(...forms.map((n) => levenshtein(q, n)));
      if (dist <= 2) {
        how = 'fuzzy';
        score = 40 - dist * 10;
      } else continue;
    }

    out.push({
      id: t.id,
      dim: t.dim,
      name: t.name,
      display: t.display,
      how,
      score,
      exact: canonHit || aliasHit,
    });
  }

  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return out.slice(0, 12);
}

function slugify(v: string): string {
  return norm(v)
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** 确认新建一个标签：写库 + 写回词表 JSON（JSON 是源，库是缓存） */
export function ensureTag({ db, dataDir }: TagCtx, dim: string, name: string): string {
  const clean = String(name ?? '').trim();
  if (!clean) throw new Error('标签名不能为空');

  const hit = db
    .prepare(`SELECT tag_id FROM tag_alias WHERE alias = ? AND dim = ?`)
    .get(norm(clean), dim) as any;
  if (hit) return hit.tag_id;

  let id = `${dim}-${slugify(clean)}`;
  let i = 2;
  while (db.prepare(`SELECT 1 FROM tag WHERE id = ?`).get(id)) id = `${dim}-${slugify(clean)}-${i++}`;

  db.prepare(`INSERT INTO tag (id, dim, name, display, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id, dim, clean, clean, Date.now()
  );
  db.prepare(`INSERT OR REPLACE INTO tag_alias (alias, dim, tag_id) VALUES (?, ?, ?)`).run(norm(clean), dim, id);

  try {
    appendVocabTag(dataDir, dim, { id, name: clean, display: clean, aliases: [norm(clean)] });
  } catch (err) {
    console.error('[vocab] 写回失败（库里已存在，词表下次启动会对不上）:', err);
  }
  return id;
}

/** 合并：不删行，只把 from 指向 to，读取时经 resolveTag 跳转 */
export function mergeTags({ db }: TagCtx, from: string, to: string): void {
  if (from === to) return;
  const run = db.transaction(() => {
    db.prepare(`UPDATE tag SET merged_into = ? WHERE id = ?`).run(to, from);
    db.prepare(`INSERT OR IGNORE INTO track_tag (track_id, tag_id, weight) SELECT track_id, ?, weight FROM track_tag WHERE tag_id = ?`).run(to, from);
    db.prepare(`DELETE FROM track_tag WHERE tag_id = ?`).run(from);
    db.prepare(`INSERT OR IGNORE INTO tag_edge (child_id, parent_id) SELECT child_id, ? FROM tag_edge WHERE parent_id = ?`).run(to, from);
    db.prepare(`DELETE FROM tag_edge WHERE parent_id = ?`).run(from);
  });
  run();
}

export function orphans(ctx: TagCtx): OrphanReport[] {
  return findOrphans(ctx.db, ctx.vocab);
}

export function tagTree({ db }: TagCtx, dim: string) {
  const tags = db.prepare(`SELECT id, name, display FROM tag WHERE dim = ? ORDER BY name`).all(dim) as any[];
  const edges = db.prepare(`SELECT child_id, parent_id FROM tag_edge`).all() as any[];
  const parentOf = new Map(edges.map((e) => [e.child_id, e.parent_id]));
  return tags.map((t) => ({
    id: t.id,
    name: t.name,
    display: t.display,
    parent: parentOf.get(t.id) ?? null,
  }));
}

export function attachTag({ db }: TagCtx, trackId: string, tagId: string) {
  db.prepare(`INSERT OR IGNORE INTO track_tag (track_id, tag_id, weight) VALUES (?, ?, 1)`).run(trackId, tagId);
  db.prepare(`UPDATE track SET updated_at = ? WHERE id = ?`).run(Date.now(), trackId);
}

export function detachTag({ db }: TagCtx, trackId: string, tagId: string) {
  db.prepare(`DELETE FROM track_tag WHERE track_id = ? AND tag_id = ?`).run(trackId, tagId);
  db.prepare(`UPDATE track SET updated_at = ? WHERE id = ?`).run(Date.now(), trackId);
}
