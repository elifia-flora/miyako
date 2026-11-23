/**
 * 中文输入法的「组合态」判断。
 *
 * 组合期按 Enter 是「确认候选词」，不是提交；此刻 Vue 的 v-model 还没把组合文本
 * 同步过来（组合期内的 input 事件会被 vModelText 丢掉）。不当心放过去的话：
 *   - 输入框会把**组合前的旧值**存进库（表现为「打完字回车保存不上」，甚至变成清空）；
 *   - 候选下拉会把 Enter 当成「选中高亮项」，把刚上屏的字换掉；
 *   - 网格会把 Enter 当成「写库并跳到下一格」，直接写进错误的内容。
 *
 * 两个条件都要看：`isComposing` 是标准；`keyCode === 229` 是 Chromium 在部分输入法
 * 与合成事件（自动化 / 冒烟脚本）下的兜底。少一个就会在某些路径上静默漏判。
 *
 * 还有一条配套约束：模板里**不要写 `@keydown.enter.prevent`**。
 * `.prevent` 在组合期也会执行，会打断输入法把候选词上屏（用户连字都打不出来）。
 * 由处理函数在确认「不在组合态」之后再自己调 `preventDefault()`。
 */
export function isComposing(ev: KeyboardEvent): boolean {
  return ev.isComposing === true || ev.keyCode === 229;
}

/**
 * 焦点是不是在一个「能打字」的元素里。
 *
 * 全局热键（window 级 keydown）必须先问这一句。不问的后果不是「没反应」，而是
 * **把输入框里的按键抢去干别的**：
 *   - `Ctrl+R` 会新建作品并切走选中项 → 正在编辑的框被卸载，敲的字全丢；
 *   - `Ctrl+Z` 会去撤销上一笔网格操作并写库，原生文本撤销还被 preventDefault 掉；
 *   - `Alt+字母` 会展开菜单。
 * 这几种都不会报错，用户只会觉得「输入框怪怪的」。
 *
 * SELECT / contentEditable 也要算：谓词组件、行内编辑都可能长这样。
 */
export function isEditableTarget(el: EventTarget | null): boolean {
  const h = el as HTMLElement | null;
  if (!h) return false;
  if (h.isContentEditable) return true;
  const tag = h.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
