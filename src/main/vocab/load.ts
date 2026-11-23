import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export interface VocabNode {
  id: string;
  dim: string;
  name: string;
  display: string | null;
  parentId: string | null;
  aliases: string[];
  /**
   * 其它语言的译名（`{ de: 'Querflöte', ja: 'フルート' }`）。
   * 和别名一样进 aliasIndex / tag_alias：用户在搜索框里敲德语原文也该命中。
   */
  translations: Record<string, string>;
}

/**
 * 译名字段允许两种写法：映射 `{ lang: text }` 或数组 `[{ lang, text }]`。
 * 界面上写的是映射；读的时候宽容一点，手工编辑的 JSON 不至于整条被丢掉。
 */
export function readTranslations(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const lang = String((item as any).lang ?? '').trim().toLowerCase();
      const text = String((item as any).text ?? '').trim();
      if (lang && text) out[lang] = text;
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [lang, text] of Object.entries(raw as Record<string, unknown>)) {
      const key = String(lang).trim().toLowerCase();
      const value = typeof text === 'string' ? text.trim() : '';
      if (key && value) out[key] = value;
    }
  }
  return out;
}

export interface VocabSet {
  nodes: VocabNode[];
  byDim: Map<string, VocabNode[]>;
  byId: Map<string, VocabNode>;
  /** 归一化后的 name/display/alias → tag id */
  aliasIndex: Map<string, string>;
  dims: string[];
  files: string[];
}

/**
 * 归一化实现已搬到 `src/shared/text.js`：渲染层判「输入是否等于候选」也要用它，
 * 两边各写一份会在全角括号这类边角上不一致（静默换字）。
 * 这里 `import` + `export` 都要有 —— 只 `export { norm } from ...` 不会在本文件产生局部绑定，
 * 而本文件自己的 syncVocab 也要用 norm。
 */
import { norm } from '../../shared/text.js';
export { norm };

/** `data/vocab` 里不是标签维度的文件：和弦符号 / 速度术语只是补全素材，不进 tag 表 */
const NON_TAG_FILES = new Set(['chord-symbols.json', 'tempo_marking.json']);

/** 读 data/vocab/*.json，展平成可写库的列表（嵌套树 → tag + edge） */
export function loadVocab(dataDir: string): VocabSet {
  const dir = path.join(dataDir, 'vocab');
  const set: VocabSet = {
    nodes: [], byDim: new Map(), byId: new Map(), aliasIndex: new Map(), dims: [], files: [],
  };
  if (!fs.existsSync(dir)) return set;

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    // 不跳过的话会凭空多出一个 dim，侧边栏与词表编辑器里都会冒出一行空维度
    if (NON_TAG_FILES.has(file)) continue;
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      console.error(`[vocab] 解析失败 ${file}:`, err);
      continue;
    }
    const dim = raw.dim ?? path.basename(file, '.json');
    set.dims.push(dim);
    set.files.push(file);

    const walk = (nodes: any[], parentId: string | null) => {
      for (const n of nodes ?? []) {
        if (!n?.id) continue;
        const node: VocabNode = {
          id: n.id,
          dim,
          name: n.name ?? n.id,
          display: n.display ?? null,
          parentId,
          aliases: Array.isArray(n.aliases) ? n.aliases : [],
          translations: readTranslations(n.translations),
        };
        // 同一个 id 允许挂多个根（DAG），但定义必须一致；这里保留第一次出现的定义
        if (!set.byId.has(node.id)) set.byId.set(node.id, node);
        set.nodes.push(node);
        if (!set.byDim.has(dim)) set.byDim.set(dim, []);
        set.byDim.get(dim)!.push(node);

        for (const key of [node.name, node.display, node.id, ...node.aliases, ...Object.values(node.translations)]) {
          if (key) set.aliasIndex.set(norm(key), node.id);
        }
        if (n.children?.length) walk(n.children, n.id);
      }
    };
    walk(raw.roots ?? [], null);
  }

  return set;
}

export interface SyncResult {
  tags: number;
  edges: number;
  aliases: number;
}

/**
 * 词表 JSON → tag / tag_edge / tag_alias 缓存。
 * 只增改不删：JSON 里删掉的标签，库里保留（可能还有曲目引用），由孤儿报告处理。
 */
export function syncVocab(db: Database.Database, vocab: VocabSet): SyncResult {
  const now = Date.now();
  const upsertTag = db.prepare(`
    INSERT INTO tag (id, dim, name, display, created_at) VALUES (@id, @dim, @name, @display, @now)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, display = excluded.display, dim = excluded.dim
  `);
  const delEdges = db.prepare(`DELETE FROM tag_edge WHERE child_id IN (SELECT id FROM tag WHERE dim = ?)`);
  const insEdge = db.prepare(`INSERT OR IGNORE INTO tag_edge (child_id, parent_id) VALUES (?, ?)`);
  const delAlias = db.prepare(`DELETE FROM tag_alias WHERE dim = ?`);
  const insAlias = db.prepare(`INSERT OR REPLACE INTO tag_alias (alias, dim, tag_id) VALUES (?, ?, ?)`);

  let edges = 0;
  const aliasKeys = new Set<string>();
  const uniqueTags = new Set(vocab.nodes.map((n) => n.id));

  const run = db.transaction(() => {
    for (const node of vocab.nodes) {
      upsertTag.run({ id: node.id, dim: node.dim, name: node.name, display: node.display, now });
    }
    for (const dim of vocab.dims) {
      delEdges.run(dim);
      delAlias.run(dim);
    }
    for (const node of vocab.nodes) {
      if (node.parentId) {
        insEdge.run(node.id, node.parentId);
        edges++;
      }
      for (const key of [node.name, node.display, node.id, ...node.aliases, ...Object.values(node.translations)]) {
        if (!key) continue;
        insAlias.run(norm(key), node.dim, node.id);
        aliasKeys.add(`${node.dim}|${norm(key)}`);
      }
    }
  });
  run();

  // 同一个 id 允许挂多个根（modulation），所以报「唯一条目数」而不是节点数
  return { tags: uniqueTags.size, edges, aliases: aliasKeys.size };
}

/** 库里被引用、但当前词表里已不存在的标签 */
export function findOrphans(db: Database.Database, vocab: VocabSet) {
  const rows = db
    .prepare(
      `SELECT g.id, g.dim, g.name, COUNT(tt.track_id) AS refCount,
              GROUP_CONCAT(tt.track_id) AS ids
         FROM tag g JOIN track_tag tt ON tt.tag_id = g.id
        GROUP BY g.id ORDER BY refCount DESC`
    )
    .all() as any[];

  return rows
    .filter((r) => !vocab.byId.has(r.id))
    .map((r) => ({
      tagId: r.id,
      dim: r.dim,
      name: r.name,
      refCount: r.refCount,
      trackIds: String(r.ids ?? '').split(',').filter(Boolean),
    }));
}
