/**
 * 渲染层的语言状态 —— 只做三件事：记住选择、暴露 t()、切换时同步 DOM 与主进程。
 *
 * 为什么 t() 是个普通函数而不是 computed：
 *   它在模板/计算属性里被调用时会读 locale.value，Vue 照样把它记成依赖；
 *   语言一变，所有用过它的组件一起重渲染。这样每个组件只需要 `import { t }`，
 *   不必给每处文案都套一层 computed。
 */
import { ref } from 'vue';
import {
  DEFAULT_LOCALE,
  guessLocale,
  htmlLang,
  isLocale,
  normalizeLocale,
  t as translate,
  tn as translateCount,
} from '@shared/i18n.js';

const STORAGE_KEY = 'ma-lang';

/** 首次启动按系统语言猜；用户选过就以用户为准 */
function initialLocale(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  const nav = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
  return guessLocale(nav) ?? DEFAULT_LOCALE;
}

export const locale = ref<string>(initialLocale());

export function t(key: string, vars?: Record<string, unknown>): string {
  return translate(locale.value, key, vars);
}

/** 带数量的写法：tn('grid.cell', 3) → 「3 格」/「3 cells」 */
export function tn(key: string, n: number): string {
  return translateCount(locale.value, key, n);
}

/**
 * 切语言。写盘 + 同步 <html lang> + 告诉主进程（窗口标题、文件对话框、
 * 网易云提示语都在主进程里拼，不通知就会中英文混着出现）。
 */
export function setLocale(v: string): string {
  const next = normalizeLocale(v) ?? DEFAULT_LOCALE;
  locale.value = next;
  localStorage.setItem(STORAGE_KEY, next);
  document.documentElement.lang = htmlLang(next);
  (window as any).api?.app?.setLocale?.(next);
  return next;
}

/** 模块加载即对齐一次：首屏不该等到 setLocale 才有正确的 lang */
export function applyLocaleToDom(): void {
  document.documentElement.lang = htmlLang(locale.value);
  (window as any).api?.app?.setLocale?.(locale.value);
}
