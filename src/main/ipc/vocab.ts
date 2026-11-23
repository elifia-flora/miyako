import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { readTranslations, type VocabSet } from '../vocab/load';
import { stringifyVocab } from '../vocab/write';
import { writeFileAtomic } from '../atomic-write.js';

/**
 * 词表编辑器的主进程一侧。
 *
 * 三条原则：
 * 1. **JSON 是源，库是缓存** —— 保存只改 JSON，随后整表重载 + sync，不手写 tag 表。
 * 2. **结构由这里兜底** —— 界面只发回 roots 树，落盘前逐节点校验并重新规范化，
 *    所以用户把中文名贴进 id、把别名写成字符串、多打一层 children 都不会破坏文件。
 * 3. **不静默删标签** —— 要删的条目只要还有曲目引用，整次保存直接拒绝并报出引用数。
 */

export interface VocabIssue {
  code: 'badShape' | 'badId' | 'dupId' | 'takenId' | 'noName' | 'badAliases' | 'badTranslations' | 'tooDeep';
  id?: string;
}

export interface VocabDoc {
  dim: string;
  file: string;
  note: string;
  schemaVersion: number;
  roots: any[];
  /** 每个 tag id 被多少首曲目引用（删条目前要看这个） */
  refs: Record<string, number>;
}

export type VocabSaveResult =
  | { ok: true; dim: string; removed: string[] }
  | {
      ok: false;
      code: 'unknownDim' | 'badShape' | 'invalid' | 'referenced' | 'io';
      issues?: VocabIssue[];
      refs?: { id: string; count: number }[];
      detail?: string;
    };

interface Ctx {
  db: Database.Database;
  vocab: VocabSet;
  dataDir: string;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const MAX_DEPTH = 4;

/** 维度名只能是普通的文件名片段：挡住 `../tracks/xxx` 这类越出 vocab/ 目录的路径 */
const DIM_RE = /^[a-z][a-z0-9_-]{0,59}$/i;

export function isVocabDim(dim: unknown): dim is string {
  return typeof dim === 'string' && DIM_RE.test(dim);
}

/** 不合法的维度名返回空串：调用方的 `existsSync('')` 为 false，自然走「未知维度」分支 */
export function docPath(dataDir: string, dim: string) {
  if (!isVocabDim(dim)) return '';
  return path.join(dataDir, 'vocab', `${dim}.json`);
}

export function readDoc({ db, dataDir }: Ctx, dim: string): VocabDoc {
  const file = docPath(dataDir, dim);
  if (!fs.existsSync(file)) throw new Error(`unknown vocab: ${dim}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const refs: Record<string, number> = {};
  for (const r of db.prepare(`SELECT tag_id AS id, COUNT(*) AS c FROM track_tag GROUP BY tag_id`).all() as any[]) {
    refs[r.id] = r.c;
  }
  return {
    dim,
    file,
    note: typeof raw.note === 'string' ? raw.note : '',
    schemaVersion: Number(raw.schemaVersion) || 1,
    roots: Array.isArray(raw.roots) ? raw.roots : [],
    refs,
  };
}

function collectIds(nodes: any[], out = new Set<string>()): Set<string> {
  for (const n of nodes ?? []) {
    if (n && typeof n === 'object' && typeof n.id === 'string') out.add(n.id);
    if (n?.children) collectIds(n.children, out);
  }
  return out;
}

function validate(nodes: any, otherIds: Set<string>): VocabIssue[] {
  const issues: VocabIssue[] = [];
  const seen = new Map<string, string>();

  /**
   * 同一个 id 允许挂在多个根下（词表里 modulation 同时是旋律技法与和声技法）。
   * 所以「重复」只在**定义不一致**时才算错 —— 各挂各的根是设计，不是手滑。
   */
  const signature = (n: any) => {
    const tr = readTranslations(n.translations);
    return JSON.stringify([
      String(n.name ?? '').trim(),
      String(n.display ?? '').trim(),
      (Array.isArray(n.aliases) ? n.aliases : []).map((a: unknown) => String(a).trim()).sort(),
      Object.keys(tr).sort().map((k) => `${k}=${tr[k]}`),
    ]);
  };

  const walk = (list: any, depth: number) => {
    if (!Array.isArray(list)) {
      issues.push({ code: 'badShape' });
      return;
    }
    for (const n of list) {
      if (!n || typeof n !== 'object' || Array.isArray(n)) {
        issues.push({ code: 'badShape' });
        continue;
      }
      const id = typeof n.id === 'string' ? n.id.trim() : '';
      if (!ID_RE.test(id)) issues.push({ code: 'badId', id: String(n.id ?? '') });
      else if (seen.has(id)) {
        if (seen.get(id) !== signature(n)) issues.push({ code: 'dupId', id });
      } else if (otherIds.has(id)) issues.push({ code: 'takenId', id });
      else seen.set(id, signature(n));

      if (typeof n.name !== 'string' || !n.name.trim()) issues.push({ code: 'noName', id });
      if (n.aliases != null && (!Array.isArray(n.aliases) || n.aliases.some((a: unknown) => typeof a !== 'string'))) {
        issues.push({ code: 'badAliases', id });
      }
      if (n.translations != null) {
        const okMap =
          typeof n.translations === 'object' &&
          !Array.isArray(n.translations) &&
          Object.values(n.translations).every((v) => typeof v === 'string');
        const okList =
          Array.isArray(n.translations) &&
          n.translations.every((it: any) => it && typeof it === 'object' && typeof it.text === 'string');
        if (!okMap && !okList) issues.push({ code: 'badTranslations', id });
      }
      if (n.children != null) {
        if (!Array.isArray(n.children)) issues.push({ code: 'badShape' });
        else if (depth + 1 > MAX_DEPTH) issues.push({ code: 'tooDeep', id });
        else walk(n.children, depth + 1);
      }
    }
  };

  if (!Array.isArray(nodes)) return [{ code: 'badShape' }];
  walk(nodes, 0);
  return issues;
}

/** 只留下词表认识的键，并统一成映射式的译名 —— 多余字段不会跟着落盘 */
function normalizeNode(n: any): any {
  const out: any = { id: String(n.id).trim(), name: String(n.name).trim() };
  const display = typeof n.display === 'string' ? n.display.trim() : '';
  if (display) out.display = display;

  const aliases = [
    ...new Set(
      (Array.isArray(n.aliases) ? n.aliases : []).map((a: unknown) => String(a).trim()).filter(Boolean)
    ),
  ];
  if (aliases.length) out.aliases = aliases;

  const translations = readTranslations(n.translations);
  if (Object.keys(translations).length) out.translations = translations;

  if (typeof n.note === 'string' && n.note.trim()) out.note = n.note.trim();
  if (Array.isArray(n.children) && n.children.length) out.children = n.children.map(normalizeNode);
  return out;
}

/**
 * 保存整棵树。返回失败时**什么都没有写** —— 校验、引用检查、写文件、清库都在
 * 同一条路径上，前一步过不了就不会走到下一步。
 */
export function saveDoc({ db, vocab, dataDir }: Ctx, dim: string, roots: unknown): VocabSaveResult {
  const file = docPath(dataDir, dim);
  if (!fs.existsSync(file)) return { ok: false, code: 'unknownDim' };
  if (!Array.isArray(roots)) return { ok: false, code: 'badShape' };

  const otherIds = new Set(vocab.nodes.filter((n) => n.dim !== dim).map((n) => n.id));
  const issues = validate(roots, otherIds);
  if (issues.length) return { ok: false, code: 'invalid', issues };

  const next = roots.map(normalizeNode);
  const oldIds = new Set((vocab.byDim.get(dim) ?? []).map((n) => n.id));
  const newIds = collectIds(next);
  const removed = [...oldIds].filter((id) => !newIds.has(id));

  // 有引用就整次拒绝：删掉 JSON 条目会让 tag 变孤儿，但曲目上还挂着它 —— 那是最难查的状态
  const refs = removed
    .map((id) => ({
      id,
      count: (db.prepare(`SELECT COUNT(*) AS c FROM track_tag WHERE tag_id = ?`).get(id) as any).c as number,
    }))
    .filter((r) => r.count > 0);
  if (refs.length) return { ok: false, code: 'referenced', refs };

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    return { ok: false, code: 'io', detail: String(err?.message ?? err) };
  }

  raw.schemaVersion ??= 1;
  raw.dim ??= dim;
  raw.roots = next;
  try {
    writeFileAtomic(file, stringifyVocab(raw));
  } catch (err: any) {
    return { ok: false, code: 'io', detail: String(err?.message ?? err) };
  }

  // 删掉的条目（已确认没人引用）连库里的 tag 一起清掉，别留下永远好不了的孤儿
  if (removed.length) {
    const tx = db.transaction(() => {
      for (const id of removed) {
        db.prepare(`DELETE FROM tag_alias WHERE tag_id = ?`).run(id);
        db.prepare(`DELETE FROM tag_edge WHERE child_id = ? OR parent_id = ?`).run(id, id);
        db.prepare(`DELETE FROM tag WHERE id = ?`).run(id);
      }
    });
    tx();
  }

  return { ok: true, dim, removed };
}
