/**
 * 主进程这一侧的语言状态。
 *
 * 主进程也在拼给人看的句子：窗口标题、文件对话框、网易云的提示语。
 * 它读不到渲染层的 localStorage（那是渲染进程的域），所以由界面在启动和切语言时
 * 通过 IPC 推过来一次，这里只记住当前值，别再猜第二遍。
 */
import { DEFAULT_LOCALE, normalizeLocale, t as translate } from '../shared/i18n.js';

let current: string = DEFAULT_LOCALE;
/** 语言一变要重刷窗口标题，注册进来的回调由 index.ts 提供 */
const listeners = new Set<(locale: string) => void>();

export function currentLocale(): string {
  return current;
}

export function setCurrentLocale(v: unknown): string {
  const next = normalizeLocale(v);
  if (!next || next === current) return current;
  current = next;
  for (const fn of listeners) {
    try {
      fn(current);
    } catch {
      /* 单个监听器出错不该影响切语言 */
    }
  }
  return current;
}

export function onLocaleChange(fn: (locale: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 主进程侧取文案：mt('audio.pickTitle') */
export function mt(key: string, vars?: Record<string, unknown>): string {
  return translate(current, key, vars);
}
