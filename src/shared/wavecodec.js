/**
 * wavecodec.js — 波形峰值金字塔的二进制编解码
 *
 * ## 为什么不用 JSON
 *
 * 一首 4 分钟的曲子，峰值金字塔两级加起来大约 250 万个 Float32（10MB 上下）。
 * JSON 里每个数要写成 0.0123456789… 的文本，体积翻三倍、解析还慢 ——
 * 缓存的意义就是「快」，用 JSON 等于把省下的解码时间换成了解析时间。
 *
 * ## 格式（小端，本机缓存不需要跨平台）
 *
 * ```
 * offset 0   u32  magic = 0x57415631 ("WAV1")
 * offset 4   u32  headerLen（字节，已补齐到 4 的倍数）
 * offset 8   header JSON（UTF-8，用空格补齐到 4 字节对齐）
 * offset 8+headerLen   level0.min (Float32 × len)
 *                      level0.max (Float32 × len)
 *                      level1.min …
 * ```
 *
 * **补齐那一步不是可选的**：`new Float32Array(buffer, offset, len)` 要求 offset 是 4 的倍数，
 * 否则直接抛 RangeError。JSON 长度几乎不可能是 4 的倍数，所以必须 pad。
 */

const MAGIC = 0x57415631; // "WAV1"
const TYPED = typeof Float32Array !== 'undefined';

/** 峰值金字塔占多少字节（用于 LRU 的预算与「占用」显示） */
export function peaksBytes(peaks) {
  if (!peaks?.levels) return 0;
  let n = 0;
  for (const l of peaks.levels) n += (l.min?.byteLength ?? 0) + (l.max?.byteLength ?? 0);
  return n + 256;
}

export function encodePeaks(peaks) {
  if (!TYPED) throw new Error('encodePeaks 需要 Float32Array');
  const levels = peaks.levels ?? [];
  const header = {
    v: 1,
    duration: Number(peaks.duration) || 0,
    sampleRate: Number(peaks.sampleRate) || 0,
    channels: Number(peaks.channels) || 0,
    peaksAbsMax: Number(peaks.peaksAbsMax) || 1,
    levels: levels.map((l) => ({ bucket: Number(l.bucket) || 0, len: l.min.length })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - (json.length % 4)) % 4;
  const headerLen = json.length + pad;
  const total = 8 + headerLen + levels.reduce((s, l) => s + l.min.length * 8, 0);

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, headerLen, true);
  const bytes = new Uint8Array(buf);
  bytes.set(json, 8);
  if (pad) bytes.fill(0x20, 8 + json.length, 8 + headerLen); // 空格补齐

  let off = 8 + headerLen;
  for (const l of levels) {
    new Float32Array(buf, off, l.min.length).set(l.min);
    off += l.min.length * 4;
    new Float32Array(buf, off, l.max.length).set(l.max);
    off += l.max.length * 4;
  }
  return new Uint8Array(buf);
}

/** @returns {null | {duration:number,sampleRate:number,channels:number,peaksAbsMax:number,levels:{bucket:number,min:Float32Array,max:Float32Array}[]}} */
export function decodePeaks(bytes) {
  if (!bytes || bytes.byteLength < 12) return null;
  // 只截出自己这一段：Buffer 池里的 ArrayBuffer 往往比文件大得多
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const headerLen = view.getUint32(4, true);
  if (headerLen <= 0 || 8 + headerLen > buf.byteLength) return null;

  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)));
  } catch {
    return null;
  }
  const levels = [];
  let off = 8 + headerLen;
  for (const meta of header.levels ?? []) {
    const len = Number(meta.len) | 0;
    if (len <= 0 || off + len * 8 > buf.byteLength) return null;
    const min = new Float32Array(buf, off, len);
    off += len * 4;
    const max = new Float32Array(buf, off, len);
    off += len * 4;
    levels.push({ bucket: Number(meta.bucket) || 0, min, max });
  }
  if (!levels.length) return null;
  return {
    duration: Number(header.duration) || 0,
    sampleRate: Number(header.sampleRate) || 0,
    channels: Number(header.channels) || 0,
    peaksAbsMax: Number(header.peaksAbsMax) || 1,
    levels,
  };
}
