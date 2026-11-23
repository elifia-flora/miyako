/**
 * peaks.js — 波形峰值金字塔
 *
 * 直接沿用 reference/tallydeck 里已经验证过的做法：把 AudioBuffer 压成多级 min/max，
 * 缩放时按「每像素多少采样」选层，于是任何缩放级别下每像素都只做常数级聚合。
 * 不建金字塔就得对整段音频逐像素重扫，一拉远就卡。
 */

const BASE_BUCKET = 16;

/**
 * @param {AudioBuffer} audioBuffer
 * @param {number} [skipSamples=0] 丢掉开头这么多采样（编码器预热带进来的那段，见 `codecLeadSamples`）
 * @returns {{duration:number,sampleRate:number,channels:number,peaksAbsMax:number,levels:{bucket:number,min:Float32Array,max:Float32Array}[]}}
 */
export function createPeaks(audioBuffer, skipSamples = 0) {
  const sr = audioBuffer.sampleRate;
  const total = audioBuffer.length;
  /**
   * 丢掉编码器预热：mp3（没有 Xing 头）/ aac（没有 edit list）解码后开头会多出
   * 1000 来个采样，波形如果照原样画，就会比「播放到同一时刻」的那一段早一点，
   * 于是「同一偏移量对不齐不同格式」。裁掉之后波形时间轴 = 音乐时间轴。
   */
  const skip = Math.max(0, Math.min(total, Math.round(skipSamples) || 0));
  const len = total - skip;
  const chs = audioBuffer.numberOfChannels;
  const data = new Float32Array(len);

  // 混单声道：多声道取平均，波形更接近听感
  for (let c = 0; c < chs; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] += ch[i + skip] / chs;
  }

  let absMax = 0;
  for (let i = 0; i < len; i++) {
    const v = data[i] < 0 ? -data[i] : data[i];
    if (v > absMax) absMax = v;
  }

  const levels = [];
  let bucket = BASE_BUCKET;
  let count = Math.ceil(len / bucket);
  let min = new Float32Array(count);
  let max = new Float32Array(count);

  for (let b = 0; b < count; b++) {
    let lo = 1;
    let hi = -1;
    const start = b * bucket;
    const end = Math.min(len, start + bucket);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = lo > hi ? 0 : lo;
    max[b] = hi < lo ? 0 : hi;
  }
  levels.push({ bucket, min, max });

  while (count > 256) {
    const pMin = min;
    const pMax = max;
    count = Math.ceil(count / 2);
    min = new Float32Array(count);
    max = new Float32Array(count);
    for (let b = 0; b < count; b++) {
      const i0 = b * 2;
      const i1 = Math.min(pMin.length - 1, i0 + 1);
      min[b] = Math.min(pMin[i0], pMin[i1]);
      max[b] = Math.max(pMax[i0], pMax[i1]);
    }
    bucket *= 2;
    levels.push({ bucket, min, max });
  }

  return {
    duration: len / sr,
    sampleRate: sr,
    channels: chs,
    peaksAbsMax: absMax || 1,
    levels,
  };
}

/** 选出「一个像素覆盖多少采样」对应的那一层 */
export function pickLevel(peaks, samplesPerPixel) {
  const levels = peaks?.levels ?? [];
  if (!levels.length) return null;
  let hit = levels[0];
  for (const l of levels) {
    if (l.bucket <= samplesPerPixel) hit = l;
    else break;
  }
  return hit;
}

/**
 * [s0, s1) 采样区间的 min/max（给某一列像素用）。
 * 返回 null 表示这一列完全落在音频之外。
 */
export function peakRange(peaks, level, s0, s1) {
  if (!peaks || !level) return null;
  const last = level.min.length - 1;
  let b0 = Math.floor(s0 / level.bucket);
  let b1 = Math.floor((Math.max(s0 + 1, s1) - 1) / level.bucket);
  if (b0 > last || b1 < 0) return null;
  b0 = Math.max(0, b0);
  b1 = Math.min(last, b1);
  let lo = level.min[b0];
  let hi = level.max[b0];
  for (let b = b0 + 1; b <= b1; b++) {
    if (level.min[b] < lo) lo = level.min[b];
    if (level.max[b] > hi) hi = level.max[b];
  }
  return { min: lo, max: hi };
}
