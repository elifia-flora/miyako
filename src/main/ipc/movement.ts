import fs from 'node:fs';
import path from 'node:path';

/**
 * 乐章标题的行内补全：**两张表合并**。
 *
 * 专业上没有「乐章术语」这个类目（2026-11-14 拆掉）：
 * - 速度 / 表情 → `data/vocab/tempo_marking.json`（非标签维度，同 chord-symbols）
 * - 舞曲 / 曲式 / 体裁 → 直接并进 `data/vocab/composition_type.json` 的树里
 *
 * 这里只读取、不缓存：一张表几十条，合并一次的开销远小于启动时多维护一份状态。
 * 读的时候宽容：手工改坏的条目跳过，不让一个坏字段把整张表变空。
 */

export interface MovementTerm {
  id: string;
  /** 总谱写法（意大利语 / 英语）；英文界面补的是这一列 */
  name: string;
  /** 中文界面的补全文本 */
  display: string;
  /** tempo / character / composition */
  kind: string;
  aliases: string[];
}

export interface MovementTermDoc {
  schemaVersion: number;
  note: string;
  terms: MovementTerm[];
  /** 侧栏「速度术语」那一行的数字：只算 tempo_marking.json，不含体裁 */
  tempoCount: number;
}

export const TEMPO_MARKING_FILE = 'tempo_marking.json';
export const COMPOSITION_FILE = 'composition_type.json';

export function tempoMarkingPath(dataDir: string): string {
  return path.join(dataDir, 'vocab', TEMPO_MARKING_FILE);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error('[movement] 词表解析失败：', file, err);
    return null;
  }
}

function cleanTerm(t: any): MovementTerm | null {
  const id = String(t?.id ?? '').trim();
  const name = String(t?.name ?? '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    display: String(t?.display ?? '').trim() || name,
    kind: String(t?.kind ?? '').trim() || 'character',
    aliases: Array.isArray(t?.aliases) ? t.aliases.map((a: unknown) => String(a).trim()).filter(Boolean) : [],
  };
}

/**
 * 体裁树展平：**只收子节点**（根节点是「器乐 / 声乐 / 舞曲」这类分组，
 * 不是会被写进乐章标题的词）。id 加前缀避免和速度表的 id 混淆。
 */
function compositionTerms(dataDir: string): MovementTerm[] {
  const doc = readJson(path.join(dataDir, 'vocab', COMPOSITION_FILE));
  const out: MovementTerm[] = [];
  const walk = (nodes: any[], depth: number) => {
    for (const n of nodes ?? []) {
      if (depth > 0) {
        const term = cleanTerm({ ...n, id: `composition:${n?.id ?? ''}`, kind: 'composition' });
        if (term) out.push(term);
      }
      walk(n?.children, depth + 1);
    }
  };
  walk(Array.isArray(doc?.roots) ? doc.roots : [], 0);
  return out;
}

export function loadMovementTerms(dataDir: string): MovementTermDoc {
  const raw = readJson(tempoMarkingPath(dataDir));
  const tempoTerms = (Array.isArray(raw?.terms) ? raw.terms : [])
    .map(cleanTerm)
    .filter((t): t is MovementTerm => !!t);
  return {
    schemaVersion: Number(raw?.schemaVersion) || 1,
    note: typeof raw?.note === 'string' ? raw.note : '',
    terms: [...tempoTerms, ...compositionTerms(dataDir)],
    tempoCount: tempoTerms.length,
  };
}
