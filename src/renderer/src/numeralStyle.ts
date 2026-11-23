/**
 * 「转位序号的写法」偏好：汉字（第一转位）或阿拉伯（第1转位）。
 *
 * 这个 ref 是给界面用的**响应式镜像**；真正的判定在 `shared/numeral.js` 里，
 * 因为 `describeChord()` 之类在 shared 层的函数只拿得到 locale。
 * 两边靠 `applyNumeralStyle()` 同步 —— 改设置时同时更新 ref 与 shared 的全局值。
 *
 * 英文界面没有汉字这一说，那边固定 `1st / 2nd / 3rd`（`numeral()` 内部按 locale 分流），
 * 所以选项面板里这一项**只在中文与日语界面显示**（英文那次是用户 2026-11-07 定的）。
 *
 * 日语乐典现在通写「第1転回」，初次进日语界面就默认阿拉伯数字；
 * 用户自己选过就一律以存下来的为准。
 */
import { ref } from 'vue';
import { setNumeralStyle } from '@shared/numeral.js';
import { locale } from './i18n';

const KEY = 'ma-fig-numeral';

function read(): 'han' | 'arabic' {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'arabic' || v === 'han') return v;
  } catch {
    /* 隐私模式读不到，用下面的默认值 */
  }
  return locale.value === 'ja' ? 'arabic' : 'han';
}

export const numeralStyle = ref<'han' | 'arabic'>(read());

/** 启动时调一次：把存下来的偏好灌给 shared 层 */
export function initNumeralStyle() {
  setNumeralStyle(numeralStyle.value);
}

/** 改设置：三处一起动（ref / shared / localStorage），最后广播给需要重算的组件 */
export function applyNumeralStyle(next: 'han' | 'arabic') {
  numeralStyle.value = next;
  setNumeralStyle(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'numeralStyle' } }));
}
