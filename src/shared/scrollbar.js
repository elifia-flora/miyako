/**
 * 细滚动条的几何计算（纯函数，`node --test` 直接测）。
 *
 * 与 DOM 无关，所以「拖到底时滑块的底边是否正好贴住轨道底边」「内容比视口短时
 * 该不该画条」这类容易写错的地方都能离线验证 —— 这些错在界面上表现为
 * 「拖到底还差一截」或「空列表也有一条不能动的条」，光靠肉眼很难定性。
 */

/** 滑块最短长度：再短就抓不住了（12px 热区里至少留 24px 可拖） */
export const MIN_THUMB = 24;

/**
 * 算一根条上的滑块几何。
 *
 * @param {{ trackLen: number, viewLen: number, contentLen: number }} m
 *   `trackLen` 轨道可用长度（px，已扣掉两端内边距）
 *   `viewLen` 视口长度（`clientHeight` / `clientWidth`）
 *   `contentLen` 内容长度（`scrollHeight` / `scrollWidth`）
 * @returns {{ len: number, maxOffset: number } | null}
 *   不需要滚动时返回 `null`（调用方据此隐藏这根条）
 */
export function thumbMetrics({ trackLen, viewLen, contentLen }) {
  const track = Number(trackLen) || 0;
  const view = Number(viewLen) || 0;
  const content = Number(contentLen) || 0;
  // 1px 容差：子像素布局下 scrollHeight 常比 clientHeight 大一点点，
  // 不设容差的话每个列表都会凭空多出一条不能动的条。
  if (content <= view + 1 || track <= 0) return null;
  const len = Math.max(MIN_THUMB, Math.round((track * view) / content));
  // 内容极短视口极小的时候 len 可能超过 track（MIN_THUMB 撑的）：夹回去
  const clamped = Math.min(track, len);
  return { len: clamped, maxOffset: Math.max(0, track - clamped) };
}

/**
 * 滚动位置 → 滑块在轨道上的偏移。
 *
 * 走「比例」而不是「像素」：两者本来就不是线性同构的，
 * 直接拿 scrollTop 当偏移会在滚到底时差出 (content-view) - (track-len) 像素。
 */
export function thumbOffset(scrollPos, maxScroll, maxOffset) {
  const max = Number(maxScroll) || 0;
  if (max <= 0) return 0;
  const p = Math.min(1, Math.max(0, (Number(scrollPos) || 0) / max));
  return Math.round(p * (Number(maxOffset) || 0));
}

/**
 * 拖动滑块 N 像素 → 内容该滚多少。
 *
 * 是 `thumbOffset` 的逆运算，但**拖动必须走这条**：用比例反推，
 * 鼠标走 1px 滑块，内容走 `maxScroll / maxOffset` px，拖到底时才严丝合缝。
 */
export function scrollForThumbDelta(delta, maxScroll, maxOffset) {
  const max = Number(maxOffset) || 0;
  if (max <= 0) return 0;
  return ((Number(delta) || 0) / max) * (Number(maxScroll) || 0);
}
