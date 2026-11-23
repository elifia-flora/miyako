import { reactive } from 'vue';
import { movementTitlePrefix } from '@shared/movement.js';

/**
 * 乐章术语的显示缓存：速度 / 表情来自 `tempo_marking.json`，
 * 舞曲 / 曲式 / 体裁来自 `composition_type.json`（由主进程合并后一次返回）。
 *
 * 详情里的「Tempo term」和标题模板的 `%Tempo Term}` 都要按界面语言翻：
 * 英文取 `name`（Allegretto），中文取 `display`（小快板）。
 * 用户可能把其中任一写法存进档案，所以匹配 id / name / display / 别名四种。
 */
export interface MovementTermLabel {
  id: string;
  name: string;
  display: string;
  kind: string;
  aliases: string[];
}

export const movementTerms = reactive<MovementTermLabel[]>([]);
let loading: Promise<void> | null = null;

const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .trim();

export function loadMovementLabels(): Promise<void> {
  if (movementTerms.length) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    try {
      const doc = await (window as any).api?.movement?.doc?.();
      const terms = Array.isArray(doc?.terms) ? doc.terms : [];
      movementTerms.splice(
        0,
        movementTerms.length,
        ...terms
          .filter((t: any) => t?.id && t?.name)
          .map((t: any) => ({
            id: String(t.id),
            name: String(t.name),
            display: String(t.display || t.name),
            kind: String(t.kind || ''),
            aliases: Array.isArray(t.aliases) ? t.aliases.map(String) : [],
          }))
      );
    } catch {
      // 词表读不到就原样显示，不影响标题与详情
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** 速度 / 表情术语的显示名；认不出的写法原样返回，不吞用户输入 */
export function tempoLabel(value: string | null | undefined, locale: string): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const k = norm(raw);
  const hit = movementTerms.find(
    (t) =>
      (t.kind === 'tempo' || t.kind === 'character') &&
      [t.id, t.name, t.display, ...t.aliases].some((x) => norm(x) === k)
  );
  if (!hit) return raw;
  return locale === 'en' ? hit.name : hit.display;
}

/**
 * 从乐章标题里认出「真正的术语」，好把列表里写下的字同步进档案字段。
 *
 * 场景（用户 2026-11-23）：在列表树里改名，顺手把 `小步舞曲 - 小快板` 打进去了，
 * 详情页的 Sub-Type / Tempo term 却还是空的 —— 标题只是模板，字段才是数据。
 *
 * 规则：
 *   - 只看前缀之后、按 ` - ` 切开的每一段；
 *   - 段里带 `%`（还是变量）就跳过，那是模板不是值；
 *   - 认得体裁 → subType（去掉 `composition:` 前缀，存词表原始 id）；
 *     认得速度 / 表情 → tempoTerm（存 id，显示时由 `tempoLabel` 翻译）。
 */
export function termsFromMovementTitle(title: string, prefix = ''): { subType?: string; tempoTerm?: string } {
  const raw = String(title ?? '');
  const p = String(prefix ?? '').trim();
  let rest = raw.trim();
  const head = p || movementTitlePrefix(rest);
  if (head && rest.startsWith(head)) rest = rest.slice(head.length).trim();
  const segs = rest
    .split(/\s[-–—·；;－]\s/)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: { subType?: string; tempoTerm?: string } = {};
  for (const seg of segs) {
    if (!seg || seg.includes('%')) continue;
    const k = norm(seg);
    const hit = movementTerms.find((t) => [t.id, t.name, t.display, ...t.aliases].some((x) => norm(x) === k));
    if (!hit) continue;
    if (hit.kind === 'composition') out.subType = hit.id.replace(/^composition:/, '');
    else out.tempoTerm = hit.id;
  }
  return out;
}
