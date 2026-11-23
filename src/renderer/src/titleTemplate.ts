import { movementPrefix, parseMovementOrdinal } from '@shared/movement.js';
import { expandTitleTemplate, templateHasVars } from '@shared/titleTemplate.js';
import { entryLabel } from './vocabLabels';
import { tempoLabel } from './movementLabels';

/**
 * 把曲目数据整理成模板变量的值。
 *
 * 这里只做「值 → 人类可读」的最后一段：
 *   - 体裁 / 子体裁存的是词表 id，按当前界面语言取 display / name；
 *   - `N/A` 是值（流行作品没有作品号），中文界面显示「不适用」；
 *   - 没有的变量给空串，由 shared/titleTemplate 整段省略。
 */
export function templateDataOf(row: any, locale: string, movementNumber?: number | null) {
  // subForm 是旧键：外部旧档案还没迁移时也认，读出来一律用新名字
  const sub = String(row?.subType ?? row?.subForm ?? '').trim();
  const opus = String(row?.opusNumber ?? '').trim();
  return {
    composer: String(row?.credits?.composer ?? row?.composer ?? '').trim(),
    form: entryLabel('composition_type', row?.compositionType ?? '', locale),
    formNumber: String(row?.formNumber ?? '').trim(),
    key: Array.isArray(row?.keys) ? String(row.keys[0] ?? '').trim() : '',
    opusNumber:
      opus && /^n\/?a$/i.test(opus) ? (locale === 'en' ? 'N/A' : '不适用') : opus,
    movementNumber:
      movementNumber && row?.parentId ? movementPrefix(movementNumber, locale) : '',
    subType: entryLabel('composition_type', sub, locale),
    tempoTerm: tempoLabel(row?.tempoTerm, locale),
  };
}

/** 优先用标题里自己写的序号；标题已经是模板（认不出）时退回列表位置 */
export function movementOrdinalOf(row: any, index: number): number {
  return parseMovementOrdinal(row?.title) || index + 1;
}

/** 列表、详情、提示消息统一走这里：没有 `%…}` 就原样返回，老标题零成本 */
export function displayTitleOf(row: any, locale: string, movementNumber?: number | null): string {
  const raw = String(row?.title ?? '');
  if (!templateHasVars(raw)) return raw;
  return expandTitleTemplate(raw, templateDataOf(row, locale, movementNumber), { fallback: raw });
}
