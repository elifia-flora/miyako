/**
 * 输入方式标记：`<html data-input="pointer|keyboard">`。
 *
 * 为什么需要它（用户 2026-11-08 报的 bug）：点一下曲目列表的展开箭头，再按空格播放，
 * 箭头旁边冒出一个绿色方框。根因**不是箭头**，而是「空格是全局播放键」——
 * 鼠标点完按钮焦点留在上面，随手按任意键，Chromium 就按协议把元素提升成
 * `:focus-visible`（鼠标焦点 + 任意按键 = 键盘焦点），于是焦点环冒出来了。
 *
 * 规矩：**只有 Tab 才算键盘导航**。
 *   - 指针按下 → pointer（此后一律不画焦点环，见 tokens.css）
 *   - Tab       → keyboard（此后照常画）
 *   - 别的键（空格 / 字母 / 方向键）**不改变**它 —— 它们是快捷键，不是导航。
 *
 * 别改成「按键就切 keyboard」：那样空格一按环又回来了，等于没修。
 * 也别整个删掉 `:focus-visible`：键盘用户 Tab 过去就看不见焦点在哪了。
 *
 * 监听放在**捕获阶段**：子组件里 `@pointerdown.stop` 一堆（菜单、播放条），
 * 冒泡阶段会被拦掉，标记就滞后了。
 *
 * 所有窗口共用一套（main.ts 里对每个窗口都调一次）：popout 的网格窗口里
 * 空格同样是播放键，同样会长出这个框。
 */
export function installInputMode(): void {
  const html = document.documentElement;
  html.dataset.input = 'pointer';

  document.addEventListener(
    'pointerdown',
    () => {
      if (html.dataset.input !== 'pointer') html.dataset.input = 'pointer';
    },
    true
  );

  window.addEventListener(
    'keydown',
    (ev: KeyboardEvent) => {
      // 只认 Tab（含 Shift+Tab）：那才是「用键盘在控件之间移动」
      if (ev.key === 'Tab' && html.dataset.input !== 'keyboard') html.dataset.input = 'keyboard';
    },
    true
  );
}
