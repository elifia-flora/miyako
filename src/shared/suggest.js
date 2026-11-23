import { sameText } from './text.js';

/**
 * 候选要写进输入框的字面。
 *
 * 中文界面插 display（「神秘」），英文界面插 name（`mysterious`）——
 * 和 `App.vue` 里 `applyFieldSug` 一直以来的规则一致。
 * 规则只留这一份：以前散在两个地方，改一处就会出现「英文界面回填一串汉字」。
 */
export function insertText(hit, locale) {
  const zh = hit?.display || hit?.name || '';
  return locale === 'en' ? hit?.name || zh : zh;
}

/**
 * 按回车时该做什么。
 *
 * `'save'`  = 采纳候选之后的文本和现在一模一样（或压根没有候选）→ 这一次回车就该落库
 * `'adopt'` = 采纳会改变文本（敲的是别名 / 缩写 / 另一种语言）→ 这一次回车只采纳，下一次才落库
 *
 * 为什么要这么分：候选里**保留**了与输入完全相等的那一条（用户要看到「它被认出来了」），
 * 如果这种时候还要求按两次回车，用户会觉得第一下「什么都没发生」。
 */
export function pickMode(token, hit, locale) {
  if (!hit) return 'save';
  return sameText(insertText(hit, locale), token) ? 'save' : 'adopt';
}
