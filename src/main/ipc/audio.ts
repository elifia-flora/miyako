import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { dialog } from 'electron';
import { codecLeadSamples, probeAudioInfo, probeMp4SampleRate, probeOggDuration } from '../../shared/audiofile.js';
import { readAudioTags } from '../../shared/audiotags.js';
import { mt } from '../locale';

export interface AudioInfo {
  trackId: string;
  /** 绝对路径；文件不存在时仍然给出「本来想用哪个」 */
  path: string;
  name: string;
  exists: boolean;
  /** 渲染层直接喂给 <audio> / fetch 的自定义协议地址 */
  url: string;
  size: number;
  /** 文件修改时间（毫秒），波形缓存键要带上它（与 shared/types.ts 的 AudioInfo 一致） */
  mtimeMs: number;
  format: string | null;
  sampleRate: number;
  channels: number;
  bits: number;
  /** 文件头里的真实时长（解码前就能显示） */
  durationMs: number;
  /**
   * 解码后开头会多出多少采样（编码器预热带进来的，按**文件采样率**计）。
   *
   * 容器里有 gapless 信息时是 0（Chromium 自己会裁）；没有时按标准值补
   * （mp3 1105 / aac 1024）。渲染层拿它换算成毫秒去对齐播放与波形 ——
   * 见 `shared/audiofile.js` 里 `codecLeadSamples` 的实测表。
   */
  leadSamples: number;
  /**
   * 是不是 Broadcast Wave：`wav` 且头里有 `bext` 块。
   *
   * Cubase / Pro Tools / Nuendo 这类宿主导出时默认会加，里面装着作者、时间码、
   * 响度（LUFS）等字段。它不是「能不能播」的属性，只是**来源指纹** ——
   * 状态栏标一下，方便一眼分清「DAW 直出」还是「转码器加工过」。
   */
  bwf: boolean;
  /** 路径来源：db = 档案里写的，folder = data/audio 里同名文件兜底 */
  source: 'db' | 'folder' | 'none';
}

export const AUDIO_EXT = ['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.aif'];

export interface Ctx {
  db: Database.Database;
  dataDir: string;
}

/** 文件头 64KB 足够读出 WAV/FLAC/AIFF 的元信息（data 块长度就在头里） */
/** 文件总字节数：MP3 的时长只能靠它算（头里没有总采样数） */
export function fileSizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function readHead(file: string, bytes = 65536): Uint8Array {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return new Uint8Array(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 读文件尾部若干字节。
 *
 * 只有 MP4 需要：`moov`（里面有 `elst` 编辑列表）可能被放在文件末尾，
 * 只看开头会以为「没有 gapless 信息」，于是白白给一轨推偏 23ms。
 */
export function readTail(file: string, bytes = 65536): Uint8Array {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(bytes, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return new Uint8Array(buf);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * wav 且头里有 `bext` 块 → Broadcast Wave。
 *
 * 注意只扫头部 64KB：`iXML` 一般被放在 data 块**之后**（文件尾），所以这里看不到它，
 * 「chunks 里没有 iXML」不等于文件没有 iXML —— 要做元数据面板时得另外读尾巴。
 */
function isBwf(info: ReturnType<typeof probeAudioInfo>): boolean {
  const chunks = (info as any)?.chunks;
  return info?.format === 'wav' && Array.isArray(chunks) && chunks.includes('bext');
}

/** 探一次文件：格式信息 + 编码器延迟（mp4 要把尾巴也带上） */
export function probeFile(file: string): { info: ReturnType<typeof probeAudioInfo>; leadSamples: number } {
  const head = readHead(file);
  const info = probeAudioInfo(head, fileSizeOf(file));
  const chunks = [head];
  if (info?.format === 'mp4') chunks.push(readTail(file));
  /**
   * mp4 的采样率头里读不到（atom 太深），但换算预热需要它 ——
   * 1024 采样在 44.1k 是 23.2ms、48k 是 21.3ms，差 2ms 看着小，
   * 但热身的**方向**错了会整轨推偏，所以宁可多读一次样本条目。
   */
  const sampleRate = info?.format === 'mp4' && !info?.sampleRate ? probeMp4SampleRate(chunks) : (info?.sampleRate ?? 0);
  let merged = info ? { ...info, sampleRate: sampleRate || info.sampleRate } : info;
  /**
   * ogg 的总采样数在**最后一页**（granulepos），头里没有 —— 不补这一步，
   * 时长就永远是 0，界面显示「—」。读尾巴只多一次 open/read，几百微秒。
   */
  if (merged?.format === 'ogg' && !merged.totalSamples) {
    const total = probeOggDuration(readTail(file));
    if (total > 0) {
      merged = { ...merged, totalSamples: total, durationMs: Math.round((total / merged.sampleRate) * 1000) };
    }
  }
  return { info: merged, leadSamples: codecLeadSamples(chunks, info?.format ?? null) };
}

/** 约定：档案没写 file_path 时，去 data/audio/<曲名>.<ext> 找同名文件 */
function findInFolder(dataDir: string, title: string): string | null {
  const dir = path.join(dataDir, 'audio');
  if (!fs.existsSync(dir)) return null;
  const safe = String(title ?? '').replace(/[\\/:*?"<>|]/g, '_');
  for (const ext of AUDIO_EXT) {
    const p = path.join(dir, safe + ext);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function resolveAudio({ db, dataDir }: Ctx, trackId: string): AudioInfo {
  const row = db.prepare(`SELECT id, title, file_path, duration_ms FROM track WHERE id = ?`).get(trackId) as any;
  const url = `ma-audio://audio/${encodeURIComponent(trackId)}`;
  const empty: AudioInfo = {
    trackId,
    path: '',
    name: '',
    exists: false,
    url,
    size: 0,
    mtimeMs: 0,
    format: null,
    sampleRate: 0,
    channels: 0,
    bits: 0,
    durationMs: row?.duration_ms ?? 0,
    leadSamples: 0,
    bwf: false,
    source: 'none',
  };
  if (!row) return empty;

  let file = row.file_path ? String(row.file_path) : '';
  let source: AudioInfo['source'] = 'db';
  if (!file || !fs.existsSync(file)) {
    const found = findInFolder(dataDir, row.title);
    if (!found) return { ...empty, path: file };
    file = found;
    source = 'folder';
  }

  const { info, leadSamples } = probeFile(file);
  const stat = fs.statSync(file);
  return {
    trackId,
    path: file,
    name: path.basename(file),
    exists: true,
    url,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    format: info?.format ?? null,
    sampleRate: info?.sampleRate ?? 0,
    channels: info?.channels ?? 0,
    bits: info?.bits ?? 0,
    durationMs: info?.durationMs || row.duration_ms || 0,
    leadSamples,
    bwf: isBwf(info),
    source,
  };
}

/**
 * 读**某一条音频**的全部元数据（跨容器统一成同一形状）。
 *
 * `recId` 给了就读那条录音版本自己的文件，不给就是作品的主录音 ——
 * 元数据属于**文件**，不属于作品：同一个作品的两个版本可能是两个 DAW 工程导的，
 * 作者、时间码、速度都可能不一样，所以入口挂在录音行上而不是曲目行上。
 *
 * 和播放无关：文件不存在 / 格式不支持 / 标签全乱，都只是返回空列表，
 * 界面显示「这个文件没写元数据」而不是报错。
 * wav 一定要把尾部一起传进去 —— `iXML` 通常躺在 data 块之后（文件尾）。
 */
export function readTags(ctx: Ctx, trackId: string, recId?: string | null): AudioTagsResult {
  const info = recId ? resolveRecordingAudio(ctx, trackId, recId) : resolveAudio(ctx, trackId);
  const empty: AudioTagsResult = {
    path: info.path,
    name: info.name,
    exists: false,
    format: info.format,
    bytes: 0,
    sampleRate: info.sampleRate,
    groups: [],
    standard: {},
  };
  if (!info.exists) return empty;
  const head = readHead(info.path);
  const tail = readTail(info.path);
  const tags = readAudioTags([head, tail], info.format);
  return {
    path: info.path,
    name: info.name,
    exists: true,
    format: info.format,
    bytes: info.size,
    sampleRate: info.sampleRate,
    groups: tags.groups,
    standard: tags.standard,
  };
}

export interface AudioTagsResult {
  path: string;
  name: string;
  exists: boolean;
  format: string | null;
  bytes: number;
  /** 采样率：`bext.timeReference` 是采样数，换算成时分秒要用它 */
  sampleRate: number;
  /** 各容器自己的原始字段，按块分组（bext / iXML / ID3v2.3.0 / VORBIS_COMMENT / STREAMINFO） */
  groups: Array<{ id: string; items: Array<{ key: string; value: string }> }>;
  /** 归一化后的标准字段：title / artist / album / date / encoder / bpm / meter … */
  standard: Record<string, string>;
}

/**
 * 「这一条录音实际该播哪个文件」——解析入口只此一份。
 *
 * 同一演奏版本可能有多个音质文件：
 *   1. 传进来的这条自己绑了文件 → 用它；
 *   2. 否则在「父版本 + 它的所有音质文件」里找第一个还在磁盘上的。
 *
 * 播放信息（resolveRecordingAudio）和协议取流（serveAudio）**必须**共用它：
 * 只让前者认识音质、后者只查 `recording.file_path` 的话，父版本没绑文件时
 * 解析会说「能播」，真正请求音频却 404 —— 表现就是偶发「播放失败」。
 */
function recordingFamily(db: Database.Database, trackId: string, recId: string): { base: any; pick: any } | null {
  const base = db
    .prepare(`SELECT * FROM recording WHERE id = ? AND track_id = ? AND deleted_at IS NULL`)
    .get(recId, trackId) as any;
  if (!base) return null;
  const rootId = base.parent_id ?? base.id;
  const family = db
    .prepare(
      `SELECT * FROM recording
        WHERE track_id = ? AND deleted_at IS NULL AND (id = ? OR parent_id = ?)
        ORDER BY seq_order, seq`
    )
    .all(trackId, rootId, rootId) as any[];
  const own = family.find((x) => x.id === base.id && x.file_path && fs.existsSync(String(x.file_path)));
  const pick = own ?? family.find((x) => x.file_path && fs.existsSync(String(x.file_path)));
  return { base, pick: pick ?? null };
}

/**
 * 按「某条录音版本」解析播放信息。
 *
 * 和 `resolveAudio` 同一套返回结构，只是地址换成 `ma-audio://rec/<trackId>/<recId>`。
 * 中途双击某个演奏版本时用它 —— **不读也不写 track.file_path**，
 * 所以「双击第 3 版试听」不会改变「点作品播放先播哪一版」。
 */
export function resolveRecordingAudio({ db }: Ctx, trackId: string, recId: string): AudioInfo {
  const url = `ma-audio://rec/${encodeURIComponent(trackId)}/${encodeURIComponent(recId)}`;
  const hit = recordingFamily(db, trackId, recId);
  const empty: AudioInfo = {
    trackId,
    path: hit?.base?.file_path ? String(hit.base.file_path) : '',
    name: '',
    exists: false,
    url,
    size: 0,
    mtimeMs: 0,
    format: null,
    sampleRate: 0,
    channels: 0,
    bits: 0,
    durationMs: hit?.base?.duration_ms ?? 0,
    leadSamples: 0,
    bwf: false,
    source: 'none',
  };
  if (!hit?.pick?.file_path) return empty;

  const pick = hit.pick;
  const file = String(pick.file_path);
  const { info, leadSamples } = probeFile(file);
  const stat = fs.statSync(file);
  return {
    trackId,
    path: file,
    name: path.basename(file),
    exists: true,
    url,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    format: info?.format ?? null,
    sampleRate: info?.sampleRate ?? 0,
    channels: info?.channels ?? 0,
    bits: info?.bits ?? 0,
    durationMs: info?.durationMs || pick.duration_ms || 0,
    leadSamples,
    bwf: isBwf(info),
    source: 'db',
  };
}

/** 把路径写进档案，顺手把探测到的时长补上（列表里就能显示） */export function setAudioPath({ db, dataDir }: Ctx, trackId: string, filePath: string): AudioInfo {
  if (filePath && fs.existsSync(filePath)) {
    /**
     * 这里必须走 `probeFile` 而不是裸的 `probeAudioInfo`：
     * ogg 的时长在文件尾部，只读头会拿到 0，然后 0 被当成有效值写进 duration_ms
     * （COALESCE 只挡 NULL，挡不住 0），列表里就永远显示「—」。
     */
    const info = probeFile(filePath).info;
    db.prepare(`UPDATE track SET file_path = ?, duration_ms = COALESCE(?, duration_ms), updated_at = ? WHERE id = ?`).run(
      filePath,
      info?.durationMs || null,
      Date.now(),
      trackId
    );
  } else {
    db.prepare(`UPDATE track SET file_path = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), trackId);
  }
  return resolveAudio({ db, dataDir }, trackId);
}

/** 弹文件对话框选音频（渲染层不能碰文件系统） */
export async function pickAudio(ctx: Ctx, trackId: string): Promise<AudioInfo | null> {
  const current = resolveAudio(ctx, trackId);
  const res = await dialog.showOpenDialog({
    // 对话框是系统画的，弹出这一刻是什么语言就用什么语言（切语言后下次弹出会变）
    title: mt('audio.pickTitle'),
    defaultPath: current.exists ? path.dirname(current.path) : undefined,
    properties: ['openFile'],
    filters: [
      { name: mt('audio.filter.audio'), extensions: AUDIO_EXT.map((e) => e.slice(1)) },
      { name: mt('audio.filter.all'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return setAudioPath(ctx, trackId, res.filePaths[0]);
}

/** 自定义协议用：由 trackId 反查真实路径（只信数据库，不接受任意路径，避免变成任意文件读取） */
export function audioPathFor(db: Database.Database, dataDir: string, trackId: string): string | null {
  const info = resolveAudio({ db, dataDir }, trackId);
  return info.exists ? info.path : null;
}

const MIME: Record<string, string> = {
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
};

/**
 * 自定义协议也是跨源（渲染层 file:// → ma-audio://）。
 * Electron 44 / Chromium 152 起，fetch 必须同时满足两个条件：
 *   1) scheme 在 `registerSchemesAsPrivileged` 里声明 `corsEnabled: true`；
 *   2) 响应带 `Access-Control-Allow-Origin`。
 * 只做第 1 条仍会被拦；只做第 2 条连 CORS 检查都不会进（报「scheme 不支持跨源」）。
 *
 * `Access-Control-Expose-Headers` 是给 `fetch` 读 `Content-Range` / `Content-Length` 用的：
 * 波形那边要靠它算时长与分片进度；不暴露的话这些头在 JS 里读到 null（不报错，静默错）。
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

/**
 * ma-audio:// 的处理器，两种地址：
 *   ma-audio://audio/<trackId>          —— 作品的主录音（track.file_path，最常用）
 *   ma-audio://rec/<trackId>/<recId>    —— 指定录音制品（同一作品的不同版本）
 *
 * 必须自己实现 Range：<audio> 拖动进度、逐帧 seek 全靠 206 分片，
 * 一次性返回整段 18MB 的 FLAC 会让「点哪播哪」变成「等两秒再跳」。
 */
export function serveAudio(db: Database.Database, dataDir: string, req: Request): Response {
  // CORS 预检：Range 虽然是 safelisted，但浏览器版本之间仍有差异，统一回 204 最稳
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  /**
   * 第一段是 **host**，不是 path —— 协议注册成 standard 之后
   * `ma-audio://rec/<trackId>/<recId>` 会被解析成 hostname="rec"、pathname="/<trackId>/<recId>"。
   * 只拆 pathname 的话 seg[0] 永远是 trackId，录音版本那条分支永远进不去，
   * 于是「按 trackId 查」拿 recId 当 id，查不到 → 404：
   * 表现就是双击某个演奏版本后音频不加载、没有波形、一直「未就绪 / 解码中」。
   */
  const seg = [url.hostname, ...url.pathname.split('/').filter(Boolean)].filter(Boolean);
  let file: string | null = null;
  if (seg[0] === 'rec' && seg[1] && seg[2]) {
    // 指定录音：路径只信数据库，且走和 resolveRecordingAudio 同一套音质回退
    const hit = recordingFamily(db, decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
    file = hit?.pick?.file_path ? String(hit.pick.file_path) : null;
  } else {
    file = audioPathFor(db, dataDir, decodeURIComponent(seg[seg.length - 1] ?? ''));
  }
  if (!file) return new Response('audio not found', { status: 404, headers: CORS });

  const stat = fs.statSync(file);
  const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.get('range');
  const common = {
    ...CORS,
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? Number(m[1]) : 0;
      let end = m[2] ? Number(m[2]) : stat.size - 1;
      if (!m[1] && m[2]) {
        // "bytes=-N"：最后 N 字节
        start = Math.max(0, stat.size - Number(m[2]));
        end = stat.size - 1;
      }
      /**
       * 起点已经在文件末尾之外 → **必须回 416**，不能"夹到最后一个字节再给 1 字节"。
       *
       * 播放头拖到曲子末尾时，Chromium 会请求 `bytes=<size>-`。以前这里夹成
       * `bytes=(size-1)-(size-1)` 返回 206 + 1 字节，媒体栈把它当成"数据长度对不上"，
       * 元素进入 error 状态：播放条挂一条橙色的「播放失败」，之后按播放再也不响
       * （画面还停在结尾，看着像卡死）。规范做法就是 416 + `Content-Range: bytes * /size`。
       */
      if (start >= stat.size) {
        return new Response(null, {
          status: 416,
          headers: { ...common, 'Content-Range': `bytes */${stat.size}` },
        });
      }
      start = Math.max(0, Math.min(start, stat.size - 1));
      end = Math.max(start, Math.min(end, stat.size - 1));
      const stream = fs.createReadStream(file, { start, end });
      return new Response(Readable.toWeb(stream) as any, {
        status: 206,
        headers: {
          ...common,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        },
      });
    }
  }

  return new Response(Readable.toWeb(fs.createReadStream(file)) as any, {
    status: 200,
    headers: { ...common, 'Content-Length': String(stat.size) },
  });
}
