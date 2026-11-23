import fs from 'node:fs';
import path from 'node:path';

/**
 * 词表写回：固定 key 顺序 + 2 空格缩进 + UTF-8 无 BOM，
 * 短对象（只有标量/标量数组）保持一行 —— 这样 git diff 每次只显示一行变化。
 */

const KEY_ORDER = [
  'id',
  'name',
  'display',
  'aliases',
  'translations',
  'children',
  'schemaVersion',
  'dim',
  'note',
  'roots',
];

function orderedKeys(obj: Record<string, unknown>): string[] {
  const own = Object.keys(obj);
  const head = KEY_ORDER.filter((k) => own.includes(k));
  return [...head, ...own.filter((k) => !KEY_ORDER.includes(k))];
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function isFlat(v: unknown): boolean {
  if (isScalar(v)) return true;
  if (Array.isArray(v)) return v.every(isScalar);
  return false;
}

function render(value: unknown, indent: number, inline: boolean): string {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    const items = value.map((v) => `${'  '.repeat(indent + 1)}${render(v, indent + 1, false)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = orderedKeys(obj);
    if (!keys.length) return '{}';

    const flat = keys.every((k) => isFlat(obj[k]));
    const parts = keys.map((k) => `${JSON.stringify(k)}: ${render(obj[k], indent + 1, flat)}`);
    if (inline || flat) return `{ ${parts.join(', ')} }`;

    const inner = keys.map((k) => {
      const sub = obj[k];
      const oneLine = isScalar(sub) || (Array.isArray(sub) && sub.every(isScalar));
      return `${'  '.repeat(indent + 1)}${JSON.stringify(k)}: ${render(sub, indent + 1, oneLine)}`;
    });
    return `{\n${inner.join(',\n')}\n${pad}}`;
  }

  return JSON.stringify(value);
}

export function stringifyVocab(doc: unknown): string {
  return render(doc, 0, false) + '\n';
}

/** 往某个维度的词表里追加一个标签（挂在 custom 根下），返回写入的 id */
export function appendVocabTag(dataDir: string, dim: string, tag: { id: string; name: string; display?: string | null; aliases?: string[] }): void {
  const file = path.join(dataDir, 'vocab', `${dim}.json`);
  if (!fs.existsSync(file)) return;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.roots ??= [];

  const node = {
    id: tag.id,
    name: tag.name,
    ...(tag.display ? { display: tag.display } : {}),
    ...(tag.aliases?.length ? { aliases: tag.aliases } : {}),
  };

  let custom = doc.roots.find((r: any) => r.id === 'custom');
  if (!custom) {
    custom = { id: 'custom', name: 'custom', display: '临时新增', children: [] };
    doc.roots.push(custom);
  }
  custom.children ??= [];
  if (!custom.children.some((c: any) => c.id === tag.id)) custom.children.push(node);

  fs.writeFileSync(file, stringifyVocab(doc), 'utf8');
}
