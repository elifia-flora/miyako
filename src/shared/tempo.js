/**
 * tempo.js — Tap 速度计算（纯函数，单元测试与播放条共用）
 *
 * Tap 只做一件事：把一串「按下的时刻」换算成 BPM。
 * 这里不碰 DOM、不碰播放器，方便把边界情况（按太少、停太久、速度离谱）钉死在单测里。
 */
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 300;
/** 两次 Tap 间隔超过这个值就当成「重新开始」 */
export const TAP_RESET_MS = 2000;
/** 只保留最近这么多次 Tap（约 8 个间隔，足够平均掉手抖） */
export const TAP_MAX_COUNT = 8;

/**
 * @param {number[]} times 按下时刻（毫秒，单调递增）
 * @param {{min?:number,max?:number,resetMs?:number,maxCount?:number}} [opts]
 * @returns {null | {bpm:number, taps:number, intervals:number}}
 */
export function bpmFromTapTimes(times, opts = {}) {
  const min = opts.min ?? TEMPO_MIN;
  const max = opts.max ?? TEMPO_MAX;
  const resetMs = opts.resetMs ?? TAP_RESET_MS;
  const maxCount = Math.max(2, opts.maxCount ?? TAP_MAX_COUNT);

  const list = (Array.isArray(times) ? times : [])
    .map(Number)
    .filter((t) => Number.isFinite(t));
  if (list.length < 2) return null;

  // 从最后一次往回找，遇到超时就从那里重新开始；同时只保留 maxCount 次
  let start = list.length - 1;
  while (start > 0 && list[start] - list[start - 1] <= resetMs) start--;
  const taps = list.slice(Math.max(start, list.length - maxCount));
  if (taps.length < 2) return null;

  const intervals = taps.length - 1;
  let sum = 0;
  for (let i = 1; i < taps.length; i++) {
    const gap = taps[i] - taps[i - 1];
    if (!(gap > 0) || gap > resetMs) return null;
    sum += gap;
  }
  const avg = sum / intervals;
  const bpm = 60_000 / avg;
  if (!(bpm >= min && bpm <= max)) return null;
  return { bpm: Math.round(bpm * 1000) / 1000, taps: taps.length, intervals };
}
