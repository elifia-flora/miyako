/**
 * barbeat.js — tick / 小节 / 拍 / 秒 的纯换算内核
 *
 * 这里刻意用纯 JS（不是 TS），因为：
 *   1. 主进程、渲染进程都要用；
 *   2. `node --test` 能直接 import 它跑断言，不需要先构建。
 *
 * 所有函数都是无副作用的纯函数，输入输出只有数字 / 数组。
 */

export const DEFAULT_PPQ = 480;

/**
 * 拍号标记需要预先算好 startBar，否则每次换算都要从头累加，既慢又容易差一。
 * @param {{tick:number, num:number, den:number}[]} meters 已按 tick 升序
 * @param {number} ppq
 * @returns {{tick:number,num:number,den:number,startBar:number,barLen:number}[]}
 */
export function computeStartBars(meters, ppq = DEFAULT_PPQ) {
  const out = [];
  let bar = 1;
  let prev = null;

  for (const m of meters) {
    const num = m.num ?? 4;
    const den = m.den ?? 4;
    const barLen = (ppq * num * 4) / den;

    if (prev) {
      const rel = m.tick - prev.tick;
      // 中途变拍：向上取整到整小节，残拍归入上一段
      bar = prev.startBar + Math.ceil(rel / prev.barLen);
    }

    out.push({ tick: m.tick, num, den, startBar: bar, barLen });
    prev = out[out.length - 1];
  }
  return out;
}

/** 找出 tick 时刻生效的标记（最后一个 tick <= 目标） */
export function markerAt(markers, tick) {
  let hit = null;
  for (const m of markers) {
    if (m.tick <= tick) hit = m;
    else break;
  }
  return hit;
}

/**
 * tick → { bar, beat, off }
 * off 是拍内偏移的 tick 数（0 ~ ppq-1）。
 */
export function tickToBarBeat(meters, tick, ppq = DEFAULT_PPQ) {
  if (!meters.length) {
    const barLen = ppq * 4;
    return { bar: Math.floor(tick / barLen) + 1, beat: 1, off: tick % barLen };
  }
  const m = markerAt(meters, tick) ?? meters[0];
  const rel = Math.max(0, tick - m.tick);
  const beatTicks = (ppq * 4) / m.den;
  return {
    bar: m.startBar + Math.floor(rel / m.barLen),
    beat: Math.floor((rel % m.barLen) / beatTicks) + 1,
    off: Math.floor((rel % m.barLen) % beatTicks),
  };
}

/** tick → 第几小节（1 起） */
export function tickToBar(meters, tick, ppq = DEFAULT_PPQ) {
  return tickToBarBeat(meters, tick, ppq).bar;
}

/** 一个十六分音符的 tick 数 */
export function sixteenthTicks(ppq = DEFAULT_PPQ) {
  return Math.max(1, ppq / 4);
}

/**
 * tick → { bar, beat, sixteenth, sub }（Cubase 那条「小节.拍.十六分.tick」的读法）。
 *
 * 前三段都是 1 起，最后一段 `sub` 是**十六分音符内部的 tick**，固定 120 进制（0–119）：
 * Cubase 的 1/16 = 120 tick，两点对齐时一行看起来就是 `11.2.3.45`。
 * 本项目的 ppq 是 480，所以 480/4 = 120，`sub` 就是精确值；
 * 万一以后换成 960，这里按比例折算（并对进位做兜底，别出现 sub=120）。
 */
export function tickToBarBeatSub(meters, tick, ppq = DEFAULT_PPQ) {
  const { bar, beat, off } = tickToBarBeat(meters, tick, ppq);
  const per16 = sixteenthTicks(ppq);
  let sixteenth = Math.floor(off / per16) + 1;
  const rem = off - (sixteenth - 1) * per16;
  let sub = Math.round((rem * 120) / per16);
  // 折算取整可能正好顶到 120（本十六分已经走完）：进位，不要输出 120
  if (sub >= 120) {
    sub = 0;
    sixteenth += 1;   // 这一个十六分之后就是下一拍，交给上层「拍」去进位也无所谓：
                      // 这里只保证 sub ∈ [0,119]，显示上大不了把 `x.4.120` 写成 `x.5.0`
  }
  return { bar, beat, sixteenth, sub };
}

/**
 * tick → `"11.2.3.45"`（不填 0）。
 *
 * **点号的位置要固定**，所以这里给的是「不补零的裸数字」，
 * 对齐交给界面：每个字段放进固定宽度的格子里右对齐（`ch` 单位 + tabular-nums），
 * 这样 `9.1.1.0` 和 `106.2.3.45` 的小数点仍落在同两列上 —— Cubase 就是这个观感。
 */
export function formatBarBeatSub(meters, tick, ppq = DEFAULT_PPQ) {
  const p = tickToBarBeatSub(meters, tick, ppq);
  return `${p.bar}.${p.beat}.${p.sixteenth}.${p.sub}`;
}

/**
 * `"11.2"` / `"11.2.3"` / `"11.2.3.45"` → tick（缺的段按 1 / 0 补）。
 *
 * 播放条的读数框直接把这个字符串交给它。**不做越界夹取**：拍号只有 4 拍时写第 5 拍，
 * 算出来就是下一小节第 1 拍 —— 那正好是用户想要的「跨过去」。真正越界的夹取在调用方
 * （夹到 0 与音频总长之间）。
 *
 * @returns tick；写坏了（字母、负数、层数过多）返回 null，让界面保持原样。
 */
export function barBeatToTick(meters, text, ppq = DEFAULT_PPQ) {
  const parts = String(text ?? '')
    .trim()
    .split(/[.:\s]+/)
    .filter((p) => p !== '');
  if (!parts.length || parts.length > 4) return null;
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  const bar = Math.max(1, Number(parts[0]) || 1);
  const beat = Math.max(1, Number(parts[1] ?? 1) || 1);
  const sixteenth = Math.max(1, Number(parts[2] ?? 1) || 1);
  const sub = Math.min(119, Math.max(0, Number(parts[3] ?? 0) || 0));
  const base = barToTick(meters, bar, ppq);
  const m = meters.length ? markerAt(meters, base) ?? meters[0] : null;
  const beatTicks = m ? (ppq * 4) / m.den : ppq * 4;
  const per16 = sixteenthTicks(ppq);
  return base + (beat - 1) * beatTicks + (sixteenth - 1) * per16 + Math.round((sub * per16) / 120);
}

/**
 * `"00:01:23:15"` → 毫秒（非 drop-frame）。帧号超出帧率、分钟/秒越界都算写坏了。
 * `HH:MM:SS` 三段也认（帧按 0 算）。
 */
export function parseTimecode(text, fps = 30) {
  const m = String(text ?? '')
    .trim()
    .match(/^(\d+):(\d{1,2}):(\d{1,2})(?::(\d{1,3}))?$/);
  if (!m) return null;
  const rate = Math.max(1, Math.round(Number(fps) || 30));
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = Number(m[3]);
  const frame = Number(m[4] ?? 0);
  if (mi > 59 || sec > 59 || frame >= rate) return null;
  return (h * 3600 + mi * 60 + sec) * 1000 + Math.round((frame / rate) * 1000);
}

/**
 * 播放条 `m:ss.mmm` 读数的反解。也认纯秒数（`"83"` / `"83.5"`），
 * 手打时少写两个冒号不必报错。
 */
export function parseMsText(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const m = s.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  if (Number(m[2]) > 59) return null;
  const frac = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
  return (Number(m[1]) * 60 + Number(m[2])) * 1000 + frac;
}

/** 小节（1 起）→ tick，用该小节所在段的拍号 */
export function barToTick(meters, bar, ppq = DEFAULT_PPQ) {
  if (!meters.length) return (bar - 1) * ppq * 4;
  let m = meters[0];
  for (const x of meters) if (x.startBar <= bar) m = x;
  return m.tick + (bar - m.startBar) * m.barLen;
}

/**
 * tick → 毫秒。速度是分段的，所以必须逐段积分。
 * @param {{tick:number, bpm:number}[]} tempos 已按 tick 升序
 */
export function tickToMs(tempos, tick, ppq = DEFAULT_PPQ) {
  if (!tempos.length) return 0;
  let ms = 0;
  for (let i = 0; i < tempos.length; i++) {
    const cur = tempos[i];
    const next = tempos[i + 1];
    if (tick <= cur.tick) break;                      // 还没走进这一段
    const to = next ? Math.min(tick, next.tick) : tick;
    ms += ((to - cur.tick) / ppq) * (60000 / (cur.bpm || 120));
    if (!next || tick <= next.tick) break;
  }
  return ms;
}

/** 音频位置(ms) = audio_offset_ms + tickToMs(tick) —— 导出音频前后有余量时必须加这一项 */
export function tickToAudioMs(tempos, tick, audioOffsetMs = 0, ppq = DEFAULT_PPQ) {
  return audioOffsetMs + tickToMs(tempos, tick, ppq);
}

/**
 * ms → tick：tickToMs 的反函数。
 *
 * 播放头要落在格子上，靠的就是这一条；没有它就只能拿「平均 BPM」除，
 * 一旦曲中有变速度，越到后面偏得越多。
 * 允许返回负数：音频比第 1 小节早开始时（offset < 实际前奏）playhead 本来就该在原点左侧。
 * @param {{tick:number, bpm:number}[]} tempos 已按 tick 升序
 */
export function msToTick(tempos, ms, ppq = DEFAULT_PPQ) {
  if (!tempos.length) return 0;
  let acc = 0;
  for (let i = 0; i < tempos.length; i++) {
    const cur = tempos[i];
    const next = tempos[i + 1];
    const msPerTick = 60000 / (cur.bpm || 120) / ppq;
    const segMs = next ? (next.tick - cur.tick) * msPerTick : Infinity;
    if (ms <= acc + segMs) return Math.round(cur.tick + (ms - acc) / msPerTick);
    acc += segMs;
  }
  return Math.round(tempos[tempos.length - 1].tick);
}

/** ms → "m:ss.SSS" */
export function formatMs(ms) {
  const neg = ms < 0;
  const v = Math.abs(ms);
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  const frac = Math.round(v % 1000);
  const body = `${m}:${String(s).padStart(2, '0')}.${String(frac).padStart(3, '0')}`;
  return neg ? `-${body}` : body;
}

/** ms → "m:ss"（列表里用，不要假装有毫秒精度） */
export function formatMsShort(ms) {
  if (ms == null) return '—';
  const v = Math.round(ms / 1000);
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * 毫秒 → `HH:MM:SS:FF`（非 drop-frame 时间码）。
 *
 * 帧号用 **floor** 而不是 round：时间码是「已经走到第几帧」，
 * 四舍五入会让 00:00:00:29.6 提前显示成下一秒的第 0 帧。
 * 只支持整数帧率；本项目的设置里提供 24 / 25 / 30 / 50 / 60。
 */
export function formatTimecode(ms, fps = 30) {
  const rate = Math.max(1, Math.round(Number(fps) || 30));
  const totalFrames = Math.floor((Math.max(0, Number(ms) || 0) / 1000) * rate);
  const frames = totalFrames % rate;
  const totalSeconds = Math.floor(totalFrames / rate);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

/**
 * 由段落 marker 推出每段的 tick 长度（末段没有终点时为 null）。
 * 输出用于网格渲染与详情栏表格。
 */
export function sectionSpans(markers, totalTicks = null) {
  return markers.map((m, i) => {
    const next = markers[i + 1];
    const end = next ? next.tick : totalTicks;
    return { ...m, endTick: end, durTicks: end == null ? null : end - m.tick };
  });
}

/** 拍号字符串 "3/4" → {num:3, den:4} */
export function parseMeter(text) {
  const m = String(text ?? '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return { num: 4, den: 4 };
  return { num: Number(m[1]), den: Number(m[2]) };
}
