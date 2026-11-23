import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * 波形缓存（磁盘侧）。
 *
 * 缓存的是**解码后的峰值金字塔**，不是音频本身 —— 复现一次波形要
 * `fetch 整段音频 → decodeAudioData → 建 min/max 金字塔`，一首 18MB 的 FLAC 要 1–2 秒；
 * 而峰值只有几 MB，读盘是毫秒级。
 *
 * ## 键 = 路径 + 字节数 + 修改时间
 *
 * 只按路径做键的话，用户替换同名文件 / 重新转码 / 覆盖下载之后，
 * 界面会一直显示**旧文件的波形**，而且看起来一切正常（最难发现的那种错）。
 * 加上 size + mtime，文件一变键就变，旧条目自然变成孤儿、被 LRU 淘汰掉。
 *
 * ## LRU 用文件的 mtime 表示
 *
 * 命中时 `utimes` 一下，等于「最近用过」。这样不用额外维护索引文件 ——
 * 索引文件本身才是缓存最容易腐坏的部分（写一半、和实际文件对不上）。
 */

export interface WaveMeta {
  path: string;
  size: number;
  mtimeMs: number;
  /**
   * 峰值算法的版本。改了「怎么算波形」（比如 v0.86 开始裁掉编码器预热）
   * 就要 +1，否则旧缓存会继续用老口径，波形和播放头差个 20ms 还查不出来。
   * 缺省按 0 算 —— 老 renderer 传上来的 meta 没有这个字段。
   */
  v?: number;
}

export interface WaveStats {
  files: number;
  bytes: number;
  /** 缓存目录，界面上「打开目录」用得上 */
  dir: string;
}

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'wave-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 同一个音频文件 → 同一个键；文件一改（size/mtime 变）键就变 */
function keyOf(meta: WaveMeta): string {
  const raw = `${meta?.path ?? ''}|${meta?.size ?? 0}|${Math.round(Number(meta?.mtimeMs) || 0)}|${Number(meta?.v) || 0}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20);
}

function fileOf(meta: WaveMeta): string {
  return path.join(cacheDir(), `${keyOf(meta)}.wave`);
}

function scan(): { file: string; bytes: number; atime: number }[] {
  const dir = cacheDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.wave'));
  } catch {
    return [];
  }
  const out: { file: string; bytes: number; atime: number }[] = [];
  for (const n of names) {
    const abs = path.join(dir, n);
    try {
      const st = fs.statSync(abs);
      // mtime 就是「最近使用时间」：读命中会 utimes 一下
      out.push({ file: abs, bytes: st.size, atime: st.mtimeMs });
    } catch {
      /* 并发删掉了 */
    }
  }
  return out;
}

/** 命中返回字节；没命中返回 null（不要抛错：缓存丢了只该多解码一次） */
export function waveGet(meta: WaveMeta): Uint8Array | null {
  const abs = fileOf(meta);
  try {
    const buf = fs.readFileSync(abs);
    const now = new Date();
    try {
      fs.utimesSync(abs, now, now);
    } catch {
      /* 时间戳刷不上不影响内容 */
    }
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * 写入并立刻按预算淘汰。
 *
 * 先写 `.tmp` 再 rename：中途崩了不会留下半截文件被当成有效缓存
 * （半截文件的 header 长度可能对不上，解码会返回 null —— 但那种「永远是 miss 又永远不清」的
 * 垃圾条目最烦人，不如从一开始就不产生）。
 */
export function wavePut(meta: WaveMeta, bytes: Uint8Array, limitBytes: number): WaveStats {
  const limit = Math.max(0, Math.round(Number(limitBytes) || 0));
  if (limit <= 0 || !bytes?.byteLength) return waveStats();

  const abs = fileOf(meta);
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, abs);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return waveStats();
  }
  // 单份就超过预算：留着它会让别人全被挤掉，直接删
  if (bytes.byteLength >= limit) {
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* ignore */
    }
    return waveStats();
  }
  wavePrune(limit);
  return waveStats();
}

/** 淘汰到「总量严格小于 limit」（与内存 LRU 同一口径） */
export function wavePrune(limitBytes: number): number {
  const limit = Math.max(0, Math.round(Number(limitBytes) || 0));
  const items = scan().sort((a, b) => a.atime - b.atime);
  let total = items.reduce((s, x) => s + x.bytes, 0);
  let removed = 0;
  for (const it of items) {
    if (limit > 0 && total < limit) break;
    try {
      fs.rmSync(it.file, { force: true });
      total -= it.bytes;
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export function waveStats(): WaveStats {
  const dir = path.join(app.getPath('userData'), 'wave-cache');
  const items = scan();
  return { files: items.length, bytes: items.reduce((s, x) => s + x.bytes, 0), dir };
}

/**
 * 删掉某一份（解码失败 / 文件损坏时用）。
 *
 * 没有它的话，坏条目会一直「读得到但用不了」：每次都读盘、每次解码失败、
 * 每次还占着预算 —— 缓存里最顽固的垃圾就是这种。
 */
export function waveForget(meta: WaveMeta): boolean {
  try {
    fs.rmSync(fileOf(meta), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function waveClear(): number {
  const items = scan();
  let n = 0;
  for (const it of items) {
    try {
      fs.rmSync(it.file, { force: true });
      n++;
    } catch {
      /* ignore */
    }
  }
  return n;
}
