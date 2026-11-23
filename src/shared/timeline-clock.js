import { barToTick, computeStartBars, tickToBarBeat, tickToMs } from './barbeat.js';

export function timelineDurationMs(analysis, knownDurationMs = 0) {
  if (Number.isFinite(knownDurationMs) && knownDurationMs > 0) return knownDurationMs;
  if (!analysis) return 0;
  const ppq = analysis.ppq ?? 480;
  const markers = analysis.markers ?? [];
  const rawMeters = markers.filter(m => m.kind === 'meter').sort((a, b) => a.tick - b.tick);
  const meters = computeStartBars(rawMeters.length ? rawMeters : [{ tick: 0, num: analysis.meterNum ?? 4, den: analysis.meterDen ?? 4 }], ppq);
  const tempos = markers.filter(m => m.kind === 'tempo').sort((a, b) => a.tick - b.tick);
  if (!tempos.length) tempos.push({ tick: 0, bpm: analysis.tempoValue ?? 120 });
  let bars = 48;
  for (const marker of markers) {
    bars = Math.max(bars, tickToBarBeat(meters, marker.tick, ppq).bar + (marker.kind === 'section' ? 10 : 1));
  }
  for (const event of analysis.events ?? []) {
    bars = Math.max(bars, tickToBarBeat(meters, event.tick + event.durTicks, ppq).bar + 1);
  }
  return Math.max(1000, tickToMs(tempos, barToTick(meters, bars + 1, ppq), ppq) + (analysis.audioOffsetMs ?? 0));
}

export function createTimelineClock(now = () => performance.now()) {
  let positionMs = 0;
  let startedAt = null;
  let durationMs = 0;
  const position = () => Math.min(durationMs, positionMs + (startedAt === null ? 0 : Math.max(0, now() - startedAt)));
  const pause = () => {
    positionMs = position();
    startedAt = null;
    return positionMs;
  };
  const seek = (ms) => {
    positionMs = Math.max(0, Math.min(durationMs, Number.isFinite(ms) ? ms : 0));
    if (startedAt !== null) startedAt = now();
    return positionMs;
  };
  return {
    position,
    pause,
    seek,
    play() {
      if (durationMs <= 0 || startedAt !== null) return;
      if (positionMs >= durationMs) positionMs = 0;
      startedAt = now();
    },
    setDuration(ms) {
      const at = position();
      durationMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
      seek(at);
      if (at >= durationMs) pause();
      return durationMs;
    },
  };
}
