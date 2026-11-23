/**
 * 播放头步长与「扫过发声」的偏好。
 *
 * 两组东西，都是用户 2026-11-23 定的：
 *
 *   1. `Ctrl+Alt+←/→`       走「粗步长」（默认 3 秒）
 *      `Ctrl+Alt+Shift+←/→` 走「细步长」= 一帧
 *   2. 播放头扫过时放一小段声音（配合对轨）。
 *
 * 帧率的**唯一来源**是播放条那颗 `30 fps` 按钮（`localStorage['ma-fps']`，
 * 24/25/30/50/60）。这里不再存一份 fps —— 存两份就会出现「播放条改了、
 * 步长还是老帧率」，而且没人看得出来是哪一份在生效。
 */
import { ref } from 'vue';
import { effectiveFps as calcEffectiveFps, frameStepMs as calcFrameStepMs, scrubDurationMs as calcScrubDuration } from '@shared/playback-step.js';

const KEY = 'ma-playback-step';

/** 细步长的帧率口径。`auto` = 折半到 ≤30（60→30、50→25） */
export type FrameMode = 'follow' | 'auto' | '30' | '25';
/** 扫过发声的触发范围 */
export type ScrubScope = 'all' | 'keys';
/** 时长两个输入的优先级 */
export type ScrubPriority = 'ms' | 'frames';

interface Prefs {
  /** 粗步长（毫秒） */
  coarseMs: number;
  frameMode: FrameMode;
  scrubOn: boolean;
  scrubScope: ScrubScope;
  /** 毫秒数（主） */
  scrubMs: number;
  /** 帧率 × 帧数（换算项） */
  scrubFps: number;
  scrubFrames: number;
  scrubPriority: ScrubPriority;
}

/** 默认：3 秒 / 自动折半 / 开 / 任何方式 / 「24 帧下的 1 帧」 */
const DEFAULTS: Prefs = {
  coarseMs: 3000,
  frameMode: 'auto',
  scrubOn: true,
  scrubScope: 'all',
  // 24fps 的一帧 = 41.67ms，取 42 显示得整齐，误差 0.3ms 对「听一下」没有意义
  scrubMs: 42,
  scrubFps: 24,
  scrubFrames: 1,
  scrubPriority: 'ms',
};

function clampNum(v: unknown, lo: number, hi: number, dflt: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function read(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      coarseMs: clampNum(raw.coarseMs, 50, 60000, DEFAULTS.coarseMs),
      frameMode: (['follow', 'auto', '30', '25'] as const).includes(raw.frameMode)
        ? raw.frameMode
        : DEFAULTS.frameMode,
      scrubOn: typeof raw.scrubOn === 'boolean' ? raw.scrubOn : DEFAULTS.scrubOn,
      scrubScope: raw.scrubScope === 'keys' ? 'keys' : DEFAULTS.scrubScope,
      scrubMs: clampNum(raw.scrubMs, 0, 2000, DEFAULTS.scrubMs),
      scrubFps: clampNum(raw.scrubFps, 1, 240, DEFAULTS.scrubFps),
      scrubFrames: clampNum(raw.scrubFrames, 1, 240, DEFAULTS.scrubFrames),
      scrubPriority: raw.scrubPriority === 'frames' ? 'frames' : DEFAULTS.scrubPriority,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 响应式镜像：设置面板改它，快捷键与 scrub 读它 */
export const stepPrefs = ref<Prefs>(read());

export function saveStepPrefs(patch: Partial<Prefs>) {
  stepPrefs.value = { ...stepPrefs.value, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(stepPrefs.value));
  } catch {
    /* 隐私模式写不了，本次会话仍然生效 */
  }
}

/** 播放条上的帧率（`ma-fps`，与 TransportBar 共用同一个键） */
export function baseFps(): number {
  try {
    const n = Number(localStorage.getItem('ma-fps'));
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* 读不到就当 30 */
  }
  return 30;
}

/**
 * 细步长真正按多少帧算。
 *
 * `auto` 是「除以 2 直到 ≤30」：60→30、120→30、50→25、24/25/30 原样。
 * 为什么这样折：这个设置存在的原因是「高帧率下一帧太短、对轨不好用」，
 * 而人手动对齐时用的基准档就是 30 或 25。
 */
/** 折算规则本身在 shared 里（`effectiveFps`），这里只把当前 fps 与口径喂进去 */
export function effectiveFps(): number {
  return calcEffectiveFps(baseFps(), stepPrefs.value.frameMode);
}

/** 细步长的毫秒数（一帧） */
export function frameStepMs(): number {
  return calcFrameStepMs(baseFps(), stepPrefs.value.frameMode);
}

/** 粗步长的毫秒数 */
export function coarseStepMs(): number {
  return stepPrefs.value.coarseMs;
}

/**
 * 扫过发声该响多久。
 *
 * 两个输入表达同一件事：毫秒数（主）与「多少帧率下的几帧」（换算项）。
 * 谁优先由 `scrubPriority` 决定；被选中的那个是 0 时退回另一个 ——
 * 否则「毫秒留空」就直接静音，用户会以为功能坏了。
 */
export function scrubDurationMs(): number {
  const p = stepPrefs.value;
  return calcScrubDuration({
    ms: p.scrubMs,
    fps: p.scrubFps,
    frames: p.scrubFrames,
    priority: p.scrubPriority,
  });
}

/** 这次移动该不该发声（开关 + 范围） */
export function shouldScrub(fromKeys: boolean): boolean {
  const p = stepPrefs.value;
  if (!p.scrubOn) return false;
  return p.scrubScope === 'all' ? true : fromKeys;
}

/**
 * 模板字体：`sans`（默认，无衬线）或 `mono`（等宽）。
 *
 * **和「界面字体」那个开关无关**：这里只认 `--font-text`（无衬线）与 `--font-mono`
 * （等宽）两个固定字族，换界面字体不会把模板文本一起改掉（用户 2026-11-23 的要求）。
 * 旧版本存的是 `ui`（当时直接借 `--font-ui`），读到时按 `sans` 处理。
 */
const TPL_FONT_KEY = 'ma-tpl-font';
export type TplFont = 'sans' | 'mono';

function readTplFont(): TplFont {
  try {
    return localStorage.getItem(TPL_FONT_KEY) === 'mono' ? 'mono' : 'sans';
  } catch {
    return 'sans';
  }
}

export const tplFont = ref<TplFont>(readTplFont());

export function setTplFont(v: TplFont) {
  tplFont.value = v;
  try {
    localStorage.setItem(TPL_FONT_KEY, v);
  } catch {
    /* 同上 */
  }
  applyTplFont();
}

/** 把字体写进 CSS 变量：模板文本统一用 `var(--tpl-font, var(--font-text))` 读它 */
export function applyTplFont() {
  document.documentElement.style.setProperty(
    '--tpl-font',
    tplFont.value === 'mono' ? 'var(--font-mono)' : 'var(--font-text)'
  );
}
