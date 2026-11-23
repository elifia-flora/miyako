/**
 * 转位序号的写法：汉字还是阿拉伯数字（v0.76）。
 *
 * 中文排版里「第一转位」是正式写法，「第1转位」是速记 —— 两种都有人用，所以做成偏好。
 * 英文没有汉字这一说，固定 `1st / 2nd / 3rd`。
 *
 * 为什么是**模块级全局**而不是每次调用传参：`describeChord()` 在 20 多处被调，
 * 它只拿得到 `locale`。为此把签名全部改成多带一个参数，改动面比收益大得多。
 * 所以这里放一个「当前风格」，由界面在启动与切换时 `setNumeralStyle()` 一次。
 *
 * **代价**：它是全局可变状态，测试里要显式设回去（`tests/numeral.test.mjs` 有 afterEach）。
 * 如果以后要并发渲染两种风格（比如导出图片），就得改回传参 —— 到那时再说。
 */

const HAN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const EN_ORD = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/** `'han'`（默认，中文界面）或 `'arabic'` */
let style = 'han';

export function setNumeralStyle(next) {
  style = next === 'arabic' ? 'arabic' : 'han';
}

export function getNumeralStyle() {
  return style;
}

/**
 * 1 → `一` / `1` / `1st`
 *
 * @param n 从 1 开始
 * @param locale `'en'` 用序数词，其余用中文那一套
 */
export function numeral(n, locale = 'zh') {
  const i = Math.max(1, Math.min(9, Number(n) || 1)) - 1;
  if (locale === 'en') return EN_ORD[i];
  return style === 'arabic' ? String(i + 1) : HAN[i];
}
