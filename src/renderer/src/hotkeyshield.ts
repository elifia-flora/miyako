/**
 * 子窗口的「正在输入」护盾。
 *
 * 主进程会把子窗口里的 Ctrl+R / 空格 / Home 截下来转给主窗口（见 main/index.ts
 * 的 attachHotkeyForwarding）。而 preventDefault 是**把按键吃掉** ——
 * 在歌词播报器里编辑某一句时按空格，如果被主窗口当成「播放/暂停」，
 * 用户就永远打不出空格，这比快捷键失灵更让人恼火。
 *
 * 所以焦点一落到输入控件上就告诉主进程「我在打字，别拦」，离开再恢复。
 *
 * 挂载点放在 main.ts：所有子窗口（lyrics / grid / image / overlay）各挂一次即可，
 * 不需要每个组件自己关心这件事。
 */

type Api = { hotkey?: { editing?: (on: boolean) => void } };

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  if (h.isContentEditable) return true;
  const tag = h.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function installHotkeyShield(api: Api | undefined): void {
  /** 只在状态翻转时发 IPC，focusin/focusout 在长表单里会连续触发很多次 */
  let last = false;

  const sync = () => {
    const on = isEditable(document.activeElement);
    if (on === last) return;
    last = on;
    try {
      api?.hotkey?.editing?.(on);
    } catch {
      /* 上报失败不能影响打字本身 */
    }
  };

  window.addEventListener('focusin', sync, true);
  window.addEventListener('focusout', sync, true);
  /* focusout 那一刻 activeElement 可能还是旧元素，等一帧再读一次才准 */
  window.addEventListener(
    'focusout',
    () => requestAnimationFrame(sync),
    true
  );
  /**
   * 兜底轮询：编辑框被 v-if 直接摘掉时，Chrome 不一定派发 focusout
   * （元素已经从 DOM 里删了，冒泡都冒不出来）。卡在「正在输入」的后果是
   * **所有快捷键一起失灵**，比多读一次 activeElement 贵得多。
   * 去重后只有状态真的翻转才发 IPC。
   */
  setInterval(sync, 1000);
  sync();
}
