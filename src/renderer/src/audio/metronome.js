/**
 * metronome.js — 节拍器（只在音频宿主窗口发声）
 *
 * 为什么用 Web Audio 而不是再建一个 `<audio>`：
 *   `<audio>` 已经明确「整个应用只有一个」，它负责音乐；节拍器是短促的合成点击声，
 *   用 OscillatorNode + 包络最省事，也不会和音乐元素抢 src / 播放状态。
 *
 * 节拍判定不靠 setInterval（会漂）：播放条的 `onFrame` 每帧把当前毫秒传进来，
 * 这里换算成 tick → 小节/拍，只在「拍号变了」时响一下。暂停时 `wasPlaying` 复位，
 * 下次起播不会在拍中间乱响。
 */
import { reactive } from 'vue';
import { tickToBarBeat } from '@shared/barbeat.js';
import { tickOfAudioMs } from './time.js';

const isHost = !/^#?(grid|lyrics|overlay|image)/.test(location.hash || '');
const STORE_KEY = 'ma-metronome';

function clamp01(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { on: raw.on === true, volume: clamp01(Number(raw.volume)), accent: raw.accent !== false };
  } catch {
    return { on: false, volume: 0.5, accent: true };
  }
}

const saved = load();
export const metroState = reactive({
  on: saved.on,
  volume: saved.volume,
  accent: saved.accent,
});

function save() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ on: metroState.on, volume: metroState.volume, accent: metroState.accent })
    );
  } catch {
    /* 隐私模式写不了就算了 */
  }
}

let ctx = null;
let lastKey = '';
let wasPlaying = false;

function ensureCtx() {
  if (!isHost) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  // 浏览器自动播放策略：第一次 enable 是用户手势，可以 resume；失败就等下一次手势
  if (ctx.state === 'suspended') void ctx.resume?.().catch(() => {});
  return ctx;
}

function click(accent) {
  if (metroState.volume <= 0) return;
  const ac = ensureCtx();
  if (!ac) return;
  const t = ac.currentTime + 0.004;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'square';
  osc.frequency.value = accent ? 1760 : 1100;
  const peak = metroState.volume * (accent ? 0.35 : 0.18);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.001);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
  osc.connect(gain).connect(ac.destination);
  osc.start(t);
  osc.stop(t + 0.055);
}

export function setMetronomeOn(on, opts = {}) {
  metroState.on = !!on;
  // 只有真实点击（TransportBar 的开关）才在此时解锁 AudioContext；
  // 冒烟/调试钩子只改状态，不能在后台建 AudioContext（Chromium 会记一条 autoplay warning）。
  if (metroState.on && opts.unlock === true) ensureCtx();
  if (!metroState.on) {
    wasPlaying = false;
    lastKey = '';
  }
  save();
}

export function setMetronomeVolume(v) {
  metroState.volume = clamp01(Number(v));
  save();
}

export function setMetronomeAccent(v) {
  metroState.accent = !!v;
  save();
}

/**
 * 每帧调用。只有「正在播放 + 已启用 + 宿主窗口」才会发声。
 *
 * @param {number} ms 当前音频位置
 * @param {any} analysis 当前分析档案（要 ppq / audioOffsetMs）
 * @param {{tick:number,bpm:number}[]} tempos
 * @param {{tick:number,num:number,den:number,startBar:number,barLen:number}[]} meters
 * @param {number} ppq
 * @param {boolean} playing
 */
export function metronomeTick(ms, analysis, tempos, meters, ppq, playing) {
  if (!isHost || !metroState.on || !analysis || !playing) {
    wasPlaying = false;
    lastKey = '';
    return;
  }
  const tick = tickOfAudioMs(analysis, tempos, ms);
  if (!Number.isFinite(tick) || tick < 0) {
    lastKey = '';
    return;
  }
  const bb = tickToBarBeat(meters, tick, ppq);
  const key = `${bb.bar}:${bb.beat}`;
  if (!wasPlaying) {
    wasPlaying = true;
    lastKey = key;
    // 正好从拍点起播时补一下，否则等下一拍（不要在拍中间「补响」）
    if (bb.off <= Math.max(1, ppq) * 0.1) click(bb.beat === 1 && metroState.accent);
    return;
  }
  if (key === lastKey) return;
  lastKey = key;
  click(bb.beat === 1 && metroState.accent);
}

if (typeof window !== 'undefined') {
  window.__metro = {
    state: () => ({ ...metroState, isHost }),
    set: setMetronomeOn,
    tick: metronomeTick,
  };
}
