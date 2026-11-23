/**
 * wavecache.js — 波形峰值缓存（内存 LRU + 磁盘）
 *
 * ## 为什么值得缓存
 *
 * 复现一次波形要 `fetch 整段音频 → decodeAudioData → 建 min/max 金字塔`：
 * 一首 18MB 的 FLAC 是 1–2 秒（期间面板显示「波形解码中…」）。
 * 同一首来回切、或者按版本 A/B 对比时，这段时间是纯浪费 —— 峰值只有几 MB。
 *
 * ## 两层
 *
 * | 层 | 命中耗时 | 生命周期 |
 * |---|---|---|
 * | 内存（`ByteLru`，Float32Array 直接复用） | ~0 | 本次运行 |
 * | 磁盘（`userData/wave-cache/*.wave`，二进制） | 几毫秒 | 跨启动 |
 *
 * 两层的预算口径一致：**插入后总量严格小于上限**。上限来自「选项 → 波形缓存」（MB）。
 *
 * ## 键
 *
 * `路径 + 字节数 + 修改时间`。只按路径的话，同名文件被覆盖 / 重新转码之后
 * 会一直显示旧波形，而且看起来「一切正常」。
 */
import { ByteLru } from '@shared/wavelru.js';
import { decodePeaks, encodePeaks, peaksBytes } from '@shared/wavecodec.js';

const STORE_KEY = 'ma-wave-cache-mb';
export const DEFAULT_MB = 64;

function api() {
  return window.api;
}

export function readLimitMb() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw != null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
  } catch {
    /* 隐私模式读不到，用默认值 */
  }
  return DEFAULT_MB;
}

const lru = new ByteLru(0);
let limitMb = readLimitMb();
const counters = { hits: 0, misses: 0, diskHits: 0 };

/**
 * 峰值算法的版本。改了「怎么算波形」就 +1，两层缓存一起失效。
 *
 * v2（2026-11-12）：峰值改成**裁掉编码器预热**再算（见 `createPeaks(…, skip)`），
 * 老缓存是按未裁的采样建的，混用会让波形比播放头长出一个预热（20ms 上下），
 * 而这种偏差在界面上几乎看不出来 —— 只会表现为「对轨怎么都对不准」。
 */
const PEAKS_VERSION = 2;

/** 缓存键：与主进程磁盘文件名无关，只用来在内存层区分 */
function memKey(meta) {
  return `${meta?.path ?? ''}|${meta?.size ?? 0}|${Math.round(Number(meta?.mtimeMs) || 0)}|${meta?.v ?? 0}`;
}

export function metaOf(info) {
  return { path: info?.path ?? '', size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0, v: PEAKS_VERSION };
}

/** 应用上限：内存立刻按新预算淘汰，磁盘交给主进程剪一遍 */
export function applyLimit(mb = limitMb) {
  limitMb = Math.max(0, Math.round(Number(mb) || 0));
  lru.setLimit(limitMb * 1024 * 1024);
  try {
    void api()?.wave?.prune(limitMb * 1024 * 1024);
  } catch {
    /* 老 preload 没有这组接口时，只是没有磁盘层 */
  }
}

export function currentLimitMb() {
  return limitMb;
}

export function setLimitMb(mb) {
  limitMb = Math.max(0, Math.round(Number(mb) || 0));
  try {
    localStorage.setItem(STORE_KEY, String(limitMb));
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  applyLimit(limitMb);
}

/**
 * 取缓存：内存 → 磁盘。
 * @returns 峰值对象或 null（null 表示没命中，调用方去解码）
 */
export async function getCached(info) {
  if (limitMb <= 0 || !info?.path) return null;
  const key = memKey(info);

  const mem = lru.get(key);
  if (mem) {
    counters.hits++;
    return mem;
  }

  let bytes = null;
  try {
    bytes = (await api()?.wave?.get(metaOf(info))) ?? null;
  } catch {
    bytes = null;
  }
  if (!bytes || !bytes.byteLength) {
    counters.misses++;
    return null;
  }
  const peaks = decodePeaks(bytes);
  if (!peaks) {
    // 文件坏了：删掉这一条，别让它永远「读得到但用不了」
    counters.misses++;
    try {
      void api()?.wave?.forget?.(metaOf(info));
    } catch {
      /* ignore */
    }
    return null;
  }
  counters.hits++;
  counters.diskHits++;
  lru.set(key, peaks, peaksBytes(peaks));
  return peaks;
}

/** 解码完写回两层；失败/超预算都只是「下次再解码一次」，不该影响播放 */
export function putCached(info, peaks) {
  if (limitMb <= 0 || !peaks || !info?.path) return;
  const bytes = peaksBytes(peaks);
  const budget = limitMb * 1024 * 1024;
  if (bytes >= budget) return; // 单份就超预算：两层都不收

  lru.set(memKey(info), peaks, bytes);
  try {
    const buf = encodePeaks(peaks);
    void api()?.wave?.put(metaOf(info), buf, budget);
  } catch {
    /* 编码/传输失败不影响本次显示 */
  }
}

/** 内存 + 磁盘的占用（选项面板显示用） */
export async function stats() {
  let disk = { files: 0, bytes: 0, dir: '' };
  try {
    disk = (await api()?.wave?.stats?.()) ?? disk;
  } catch {
    /* ignore */
  }
  return {
    limitMb,
    memItems: lru.size,
    memBytes: lru.bytes,
    memKeys: lru.entries(),
    diskFiles: disk.files,
    diskBytes: disk.bytes,
    dir: disk.dir,
    hits: counters.hits,
    misses: counters.misses,
    diskHits: counters.diskHits,
  };
}

/** 清空两层 */
export async function clearAll() {
  lru.clear();
  let removed = 0;
  try {
    removed = (await api()?.wave?.clear?.()) ?? 0;
  } catch {
    /* ignore */
  }
  counters.hits = 0;
  counters.misses = 0;
  counters.diskHits = 0;
  return removed;
}

/** 启动时调一次：把用户上次设的上限落到内存 LRU，并让主进程按它剪一遍磁盘 */
export function initWaveCache() {
  applyLimit(limitMb);
}
