/**
 * time.js — 音频毫秒 ↔ tick 的换算（网格/播放头唯一口径）
 *
 * 一处定义，网格、播放条、独立窗口都用它；否则三处各写一份，
 * 迟早出现「播放头比格子晚半拍」这种只能靠肉眼发现的问题。
 */
import { msToTick, tickToAudioMs, tickToMs } from '@shared/barbeat.js';

/** 变速度列表；没有 tempo marker 就退回档案里的单速 */
export function temposOf(analysis) {
  if (!analysis) return [];
  const list = (analysis.markers ?? [])
    .filter((m) => m.kind === 'tempo')
    .map((m) => ({ tick: m.tick, bpm: m.bpm }))
    .sort((a, b) => a.tick - b.tick);
  return list.length ? list : [{ tick: 0, bpm: analysis.tempoValue ?? 120 }];
}

/** tick → 音频毫秒（含 audio_offset_ms：第 1 小节未必在音频 0 秒） */
export function audioMsOfTick(analysis, tempos, tick) {
  return tickToAudioMs(tempos, tick, analysis?.audioOffsetMs ?? 0, analysis?.ppq ?? 480);
}

/** 音频毫秒 → tick（播放头落在哪一格，全靠它） */
export function tickOfAudioMs(analysis, tempos, ms) {
  return msToTick(tempos, ms - (analysis?.audioOffsetMs ?? 0), analysis?.ppq ?? 480);
}

/** 某个 tick 的音频毫秒，不含偏移（用于显示「相对音频」的位置） */
export function relMsOfTick(analysis, tempos, tick) {
  return tickToMs(tempos, tick, analysis?.ppq ?? 480);
}
