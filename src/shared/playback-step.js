/**
 * 播放头步长与「扫过发声」时长的**纯计算**。
 *
 * 抽出来是为了能离线测：这两个数直接决定「按一下走多远、响多久」，
 * 而它们依赖的东西（播放条帧率、折算口径、两个时长输入的优先级）全是组合，
 * 靠界面上肉眼看容易漏掉某一格。
 *
 * renderer 的 `playbackPrefs.ts` 负责读 localStorage / 响应式状态，
 * 算数一律走这里。
 */

/** 细步长的帧率口径 */
export const STEP_FRAME_MODES = ['follow', 'auto', '30', '25'];

/**
 * 细步长真正按多少帧算。
 *
 * `auto` = 「除以 2 直到 ≤30」：60→30、120→30、50→25，24/25/30 原样。
 * 存在这个折算是因为**高帧率下一帧太短、对不了轨**，
 * 而人手动对齐时默认用的基准档就是 30 / 25。
 */
export function effectiveFps(baseFps, mode) {
  const base = Number(baseFps) > 0 ? Number(baseFps) : 30;
  if (mode === 'follow') return base;
  if (mode === '30') return 30;
  if (mode === '25') return 25;
  let f = base;
  // 兜底 10 次：荒谬的输入（比如 1e9）不该把界面卡住
  for (let i = 0; i < 10 && f > 30; i++) f /= 2;
  return f;
}

/** 细步长的毫秒数（一帧） */
export function frameStepMs(baseFps, mode) {
  return 1000 / Math.max(1, effectiveFps(baseFps, mode));
}

/**
 * 扫过发声该响多久。
 *
 * 两个输入表达同一件事：毫秒数（主）与「多少帧率下的几帧」（换算项）。
 * 被优先级选中的那个为 0 / 空时**退回另一个** ——
 * 否则「毫秒留空」就直接按 0 算、一点声音都没有，用户会以为功能坏了。
 */
export function scrubDurationMs({ ms, fps, frames, priority }) {
  const byMs = Math.max(0, Number(ms) || 0);
  const f = Math.max(1, Number(fps) || 24);
  const n = Math.max(1, Number(frames) || 1);
  const byFrames = (n * 1000) / f;
  if (priority === 'frames') return byFrames > 0 ? byFrames : byMs;
  return byMs > 0 ? byMs : byFrames;
}
