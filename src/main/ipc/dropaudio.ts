import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { probeAudioInfo } from '../../shared/audiofile.js';
import { readAudioTags } from '../../shared/audiotags.js';
import {
  classifyDroppedPaths,
  planAudioImport,
  splitDroppedPaths,
  titleFromAudioPath,
} from '../../shared/audiodrop.js';
import { decodeLyricBytes } from '../../shared/lyrictext.js';
import { parseLrc } from '../../shared/lrc.js';
import { parseSrt } from '../../shared/srt.js';

type DropMode = 'versions' | 'variants' | 'tracks';
import { fileSizeOf, readHead, type Ctx } from './audio';
import { hashFile } from './filehash';
import { bindCoverFile, bindLyricFile, type MediaPolicy } from './media';
import { saveRecording, type RecordingPatch } from './recording';
import { createTrack } from './tracks';

/**
 * 从资源管理器 / Everything / 访达拖进来的音频。
 *
 * 作品本身仍走 createTrack（空分析档案一起建），音频仍走 saveRecording
 * （格式探测、主文件指针、音质挂在演奏版本下面，都是那一条路）。
 * 这里只多做三件事：只收音频、按哈希/路径跳过已登记的、按用户选的挂法分组。
 */

export interface DropImportResult {
  tracks: { id: string; title: string }[];
  /** 每个新建作品的第一条演奏版本，用来把同批封面和歌词挂上去 */
  versionIds: { trackId: string; recId: string }[];
  versions: number;
  variants: number;
  skipped: number;
  rejected: number;
  failed: number;
  /** 绑到已有作品，而不是新建作品 */
  attached?: boolean;
  coversBound?: number;
  lyricsBound?: number;
  lyricUnbound?: number;
  mediaSkipped?: number;
}

type ExistingHit = {
  title: string;
  recordingId: string | null;
  trackId: string;
  fileHash: string | null;
};

function foldCase() {
  return process.platform === 'win32';
}

function findExisting(db: Database.Database, hash: string, absPath: string): ExistingHit | null {
  // 访达所在的磁盘区分大小写，不能把路径折成小写再比；Windows 则必须折
  const slash = absPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const key = foldCase() ? slash.toLowerCase() : slash;
  const pathSame = foldCase()
    ? `lower(replace(IFNULL(file_path, ''), char(92), '/')) = @key`
    : `replace(IFNULL(file_path, ''), char(92), '/') = @key`;
  const rec = db
    .prepare(
      `SELECT t.title AS title, t.id AS trackId, r.id AS recordingId, r.file_hash AS fileHash
         FROM recording r
         JOIN track t ON t.id = r.track_id
        WHERE r.deleted_at IS NULL AND t.deleted_at IS NULL
          AND (
            (r.file_hash IS NOT NULL AND r.file_hash = @hash)
            OR r.file_path = @path
            OR ${pathSame.replaceAll('file_path', 'r.file_path')}
          )
        LIMIT 1`
    )
    .get({ hash, path: absPath, key }) as ExistingHit | undefined;
  if (rec?.title) return rec;
  const track = db
    .prepare(
      `SELECT title, id AS trackId, NULL AS recordingId, file_hash AS fileHash
         FROM track
        WHERE deleted_at IS NULL
          AND (
            (file_hash IS NOT NULL AND file_hash = @hash)
            OR file_path = @path
            OR ${pathSame}
          )
        LIMIT 1`
    )
    .get({ hash, path: absPath, key }) as ExistingHit | undefined;
  return track?.title ? track : null;
}

/** 路径已经在库里、但还没记过哈希：补上，下次复制品也能对上 */
function backfillHash(db: Database.Database, hit: ExistingHit, hash: string) {
  if (!hash || hit.fileHash) return;
  if (hit.recordingId) {
    db.prepare(
      `UPDATE recording SET file_hash = ? WHERE id = ? AND (file_hash IS NULL OR file_hash = '')`
    ).run(hash, hit.recordingId);
    return;
  }
  db.prepare(`UPDATE track SET file_hash = ? WHERE id = ? AND (file_hash IS NULL OR file_hash = '')`).run(
    hash,
    hit.trackId
  );
}

function probePatch(file: string, hash: string | null): Pick<
  RecordingPatch,
  'filePath' | 'fileHash' | 'durationMs' | 'format' | 'sampleRate' | 'channels' | 'bits'
> {
  let info: ReturnType<typeof probeAudioInfo> = null;
  try {
    info = probeAudioInfo(readHead(file), fileSizeOf(file));
  } catch {
    info = null;
  }
  return {
    filePath: file,
    fileHash: hash,
    durationMs: info?.durationMs ?? null,
    format: info?.format ?? null,
    sampleRate: info?.sampleRate ?? null,
    channels: info?.channels ?? null,
    bits: info?.bits ?? null,
  };
}

/** 录音没挂上的新建作品不该留在库里。只删这次刚建的空壳，不动用户已有的数据。 */
function forgetTrack(db: Database.Database, id: string) {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM analysis_marker WHERE analysis_id IN (SELECT id FROM analysis WHERE track_id = ?)`
    ).run(id);
    db.prepare(
      `DELETE FROM analysis_event WHERE analysis_id IN (SELECT id FROM analysis WHERE track_id = ?)`
    ).run(id);
    db.prepare(`DELETE FROM analysis WHERE track_id = ?`).run(id);
    db.prepare(`DELETE FROM track_tag WHERE track_id = ?`).run(id);
    // 音质行引用演奏版本：先删子行，否则外键会拦住
    db.prepare(`DELETE FROM recording WHERE track_id = ? AND parent_id IS NOT NULL`).run(id);
    db.prepare(`DELETE FROM recording WHERE track_id = ?`).run(id);
    db.prepare(`DELETE FROM track WHERE id = ?`).run(id);
  })();
}

export async function importDroppedAudio(
  ctx: Ctx,
  input: { paths?: unknown; mode?: unknown; untitled?: unknown }
): Promise<DropImportResult> {
  const mode = (['versions', 'variants', 'tracks'] as const).includes(input?.mode as DropMode)
    ? (input.mode as DropMode)
    : 'tracks';
  const untitled = String(input?.untitled ?? '').trim();
  const split = splitDroppedPaths(Array.isArray(input?.paths) ? input.paths : [], { foldCase: foldCase() });
  const result: DropImportResult = {
    tracks: [],
    versionIds: [],
    versions: 0,
    variants: 0,
    skipped: 0,
    rejected: split.rejected.length,
    failed: 0,
  };

  const items: { path: string; hash: string | null; title: string; dupTitle: string | null }[] = [];
  for (const raw of split.audio) {
    const abs = path.resolve(String(raw));
    let hash: string | null = null;
    try {
      hash = await hashFile(abs);
    } catch (err) {
      result.failed++;
      console.error('[drop] 读文件失败：', abs, err);
      continue;
    }
    const hit = findExisting(ctx.db, hash, abs);
    if (hit) backfillHash(ctx.db, hit, hash);
    items.push({
      path: abs,
      hash,
      title: titleForFile(abs, untitled),
      dupTitle: hit?.title ?? null,
    });
  }

  const plan = planAudioImport(items, mode);
  result.skipped = plan.skip.length;

  for (const group of plan.groups) {
    let track: { id: string; title: string } | null = null;
    try {
      track = createTrack(ctx, { title: group.title || untitled || undefined });
    } catch (err) {
      result.failed += group.files.length;
      console.error('[drop] 建作品失败：', group.title, err);
      continue;
    }
    let parentId: string | null = null;
    let versions = 0;
    let variants = 0;
    for (const file of group.files) {
      if (file.role === 'variant' && !parentId) {
        result.failed++;
        continue;
      }
      try {
        const rec = saveRecording(ctx, {
          trackId: track.id,
          parentId: file.role === 'variant' ? parentId ?? undefined : undefined,
          ...probePatch(file.path, file.hash),
        });
        if (file.role === 'variant') variants++;
        else {
          if (!parentId) result.versionIds.push({ trackId: track.id, recId: rec.id });
          parentId = rec.id;
          versions++;
        }
      } catch (err) {
        result.failed++;
        console.error('[drop] 登记录音失败：', file.path, err);
      }
    }
    if (!versions) {
      try {
        forgetTrack(ctx.db, track.id);
      } catch (err) {
        console.error('[drop] 撤回空作品失败：', track.id, err);
      }
      continue;
    }
    result.tracks.push({ id: track.id, title: track.title });
    result.versions += versions;
    result.variants += variants;
  }

  return result;
}

function asPolicy(v: unknown): MediaPolicy {
  return v === 'overwrite' || v === 'skip' || v === 'rename' ? v : 'rename';
}

function asPaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((p) => String(p ?? '').trim()).filter(Boolean);
}

/** 标签里的标题优先，没有就用文件名。读不到标签不算失败。 */
function titleForFile(abs: string, untitled: string): string {
  const fallback = titleFromAudioPath(abs, untitled);
  try {
    const head = readHead(abs);
    const info = probeAudioInfo(head, fileSizeOf(abs));
    const tags = readAudioTags([head], info?.format ?? null);
    const tagged = String(tags?.standard?.title ?? '').replace(/\0/g, '').trim();
    if (tagged) return tagged;
  } catch {
    /* 标签不是登记的前提 */
  }
  return fallback;
}

function describeAudio(abs: string) {
  try {
    const info = probeAudioInfo(readHead(abs), fileSizeOf(abs));
    return {
      format: info?.format ?? '',
      sampleRate: info?.sampleRate ?? 0,
      channels: info?.channels ?? 0,
      bits: info?.bits ?? 0,
      durationMs: info?.durationMs ?? 0,
    };
  } catch {
    return { format: '', sampleRate: 0, channels: 0, bits: 0, durationMs: 0 };
  }
}

function previewLyric(abs: string): { format: string; preview: string[] } {
  try {
    const buf = fs.readFileSync(abs);
    const text = decodeLyricBytes(buf.subarray(0, Math.min(buf.length, 256 * 1024)));
    if (path.extname(abs).toLowerCase() === '.srt') {
      const { lines } = parseSrt(text);
      return { format: 'srt', preview: lines.slice(0, 3).map((l) => l.text) };
    }
    const { lines } = parseLrc(text);
    const format = lines.some((l) => l.words?.length) ? 'elrc' : 'lrc';
    return { format, preview: lines.slice(0, 3).map((l) => l.text) };
  } catch {
    return { format: '', preview: [] };
  }
}

function thumbOf(abs: string): string | null {
  try {
    const img = nativeImage.createFromPath(abs);
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    const small = width > 160 ? img.resize({ width: 160, quality: 'good' }) : img;
    return small.toDataURL();
  } catch {
    return null;
  }
}

/** 弹窗用：不写库。标题、采样率和歌词前几行都在这里。 */
export async function previewDrop(ctx: Ctx, paths: unknown) {
  const split = classifyDroppedPaths(Array.isArray(paths) ? paths : [], { foldCase: foldCase() });
  const audio = [];
  for (const raw of split.audio) {
    const abs = path.resolve(raw);
    let hash: string | null = null;
    try {
      hash = await hashFile(abs);
    } catch {
      hash = null;
    }
    const hit = hash ? findExisting(ctx.db, hash, abs) : null;
    audio.push({
      path: abs,
      name: path.basename(abs),
      title: titleForFile(abs, ''),
      dupTitle: hit?.title ?? null,
      ...describeAudio(abs),
    });
  }
  return {
    audio,
    images: split.image.map((p) => {
      const abs = path.resolve(p);
      return { path: abs, name: path.basename(abs), thumb: thumbOf(abs) };
    }),
    lyrics: split.lyric.map((p) => {
      const abs = path.resolve(p);
      return { path: abs, name: path.basename(abs), ...previewLyric(abs) };
    }),
    rejected: split.rejected.map((p) => path.basename(p)),
  };
}

async function bindSidecars(
  ctx: Ctx,
  plan: {
    bind: 'bundle' | 'album' | 'none';
    tracks: { id: string; title: string }[];
    versionIds: { trackId: string; recId: string }[];
    imagePaths: string[];
    lyricPaths: string[];
    policy: MediaPolicy;
  }
) {
  const out = { coversBound: 0, lyricsBound: 0, lyricUnbound: 0, mediaSkipped: 0 };
  if (!plan.tracks.length || plan.bind === 'none') return out;
  const image = plan.imagePaths[0];
  const lyric = plan.lyricPaths[0];
  const extra = Math.max(0, plan.imagePaths.length - (image ? 1 : 0)) + Math.max(0, plan.lyricPaths.length - (lyric ? 1 : 0));
  if (plan.bind === 'album') {
    if (image) {
      for (const t of plan.tracks) {
        const r = await bindCoverFile(ctx, t.id, image, 'album', null, plan.policy);
        if (r.ok) out.coversBound++;
        else out.mediaSkipped++;
      }
    }
    out.lyricUnbound = plan.lyricPaths.length;
    out.mediaSkipped += Math.max(0, plan.imagePaths.length - 1);
    return out;
  }
  const ver = plan.versionIds[0];
  if (!ver) {
    out.mediaSkipped += plan.imagePaths.length + plan.lyricPaths.length;
    return out;
  }
  if (image) {
    const r = await bindCoverFile(ctx, ver.trackId, image, 'version', ver.recId, plan.policy);
    if (r.ok) out.coversBound = 1;
    else out.mediaSkipped++;
  }
  if (lyric) {
    const r = await bindLyricFile(ctx, ver.trackId, lyric, 'version', ver.recId, plan.policy);
    if (r.ok) out.lyricsBound = 1;
    else out.mediaSkipped++;
  }
  out.mediaSkipped += extra;
  return out;
}

/** 列表区：新建作品。bind=bundle 把第一张图和第一份歌词挂到第一条演奏版本；album 只把图做成专辑封面。 */
export async function commitLibraryDrop(
  ctx: Ctx,
  input: {
    paths?: unknown;
    mode?: unknown;
    untitled?: unknown;
    bind?: unknown;
    imagePaths?: unknown;
    lyricPaths?: unknown;
    policy?: unknown;
  }
): Promise<DropImportResult> {
  const bind = input?.bind === 'bundle' || input?.bind === 'album' ? input.bind : 'none';
  const result = await importDroppedAudio(ctx, {
    paths: input?.paths,
    mode: input?.mode,
    untitled: input?.untitled,
  });
  const side = await bindSidecars(ctx, {
    bind: result.tracks.length ? bind : 'none',
    tracks: result.tracks,
    versionIds: result.versionIds,
    imagePaths: asPaths(input?.imagePaths),
    lyricPaths: asPaths(input?.lyricPaths),
    policy: asPolicy(input?.policy),
  });
  return { ...result, ...side };
}

function trackTitle(db: Database.Database, trackId: string): string {
  const row = db.prepare(`SELECT title FROM track WHERE id = ? AND deleted_at IS NULL`).get(trackId) as
    | { title?: string }
    | undefined;
  return row?.title ?? '';
}

/** 详情区的音频：挂到当前作品，不新建作品。重复文件仍然只跳过。 */
export async function commitDetailAudio(
  ctx: Ctx,
  input: {
    trackId?: unknown;
    paths?: unknown;
    mode?: unknown;
    parentId?: unknown;
    conductor?: unknown;
    orchestra?: unknown;
    recordedYear?: unknown;
    untitled?: unknown;
  }
): Promise<DropImportResult> {
  const trackId = String(input?.trackId ?? '');
  const title = trackTitle(ctx.db, trackId);
  const result: DropImportResult = {
    tracks: title ? [{ id: trackId, title }] : [],
    versionIds: [],
    versions: 0,
    variants: 0,
    skipped: 0,
    rejected: 0,
    failed: 0,
    attached: true,
  };
  if (!title) {
    result.failed++;
    return result;
  }
  const mode = input?.mode === 'variants' ? 'variants' : 'versions';
  const parentId = String(input?.parentId ?? '');
  if (mode === 'variants' && !parentId) throw new Error('missing recording parent');
  const yearRaw = input?.recordedYear;
  const year =
    yearRaw === null || yearRaw === undefined || String(yearRaw).trim() === ''
      ? null
      : Number(yearRaw);
  const split = splitDroppedPaths(asPaths(input?.paths), { foldCase: foldCase() });
  result.rejected = split.rejected.length;
  for (const raw of split.audio) {
    const abs = path.resolve(raw);
    let hash: string | null = null;
    try {
      hash = await hashFile(abs);
    } catch (err) {
      result.failed++;
      console.error('[drop] 读文件失败：', abs, err);
      continue;
    }
    const hit = findExisting(ctx.db, hash, abs);
    if (hit) {
      backfillHash(ctx.db, hit, hash);
      result.skipped++;
      continue;
    }
    try {
      const rec = saveRecording(ctx, {
        trackId,
        parentId: mode === 'variants' ? parentId : undefined,
        conductor: mode === 'versions' ? String(input?.conductor ?? '') : undefined,
        orchestra: mode === 'versions' ? String(input?.orchestra ?? '') : undefined,
        recordedYear: mode === 'versions' && Number.isFinite(year as number) ? (year as number) : undefined,
        ...probePatch(abs, hash),
      });
      if (mode === 'variants') result.variants++;
      else {
        result.versions++;
        result.versionIds.push({ trackId, recId: rec.id });
      }
    } catch (err) {
      result.failed++;
      console.error('[drop] 挂到当前作品失败：', abs, err);
    }
  }
  return result;
}

export async function commitDetailImages(
  ctx: Ctx,
  input: { trackId?: unknown; paths?: unknown; kind?: unknown; recId?: unknown; policy?: unknown }
): Promise<DropImportResult> {
  const trackId = String(input?.trackId ?? '');
  const title = trackTitle(ctx.db, trackId);
  const paths = asPaths(input?.paths);
  const kind = input?.kind === 'album' || input?.kind === 'version' ? input.kind : 'single';
  const result: DropImportResult = {
    tracks: title ? [{ id: trackId, title }] : [],
    versionIds: [],
    versions: 0,
    variants: 0,
    skipped: 0,
    rejected: 0,
    failed: title ? 0 : 1,
    attached: true,
    coversBound: 0,
    mediaSkipped: Math.max(0, paths.length - 1),
  };
  if (!title || !paths.length) return result;
  const bound = await bindCoverFile(ctx, trackId, path.resolve(paths[0]), kind, input?.recId ? String(input.recId) : null, asPolicy(input?.policy));
  if (bound.ok) result.coversBound = 1;
  else result.mediaSkipped = (result.mediaSkipped ?? 0) + 1;
  return result;
}

export async function commitDetailLyrics(
  ctx: Ctx,
  input: { trackId?: unknown; paths?: unknown; scope?: unknown; recId?: unknown; policy?: unknown }
): Promise<DropImportResult> {
  const trackId = String(input?.trackId ?? '');
  const title = trackTitle(ctx.db, trackId);
  const paths = asPaths(input?.paths);
  const scope = input?.scope === 'work' ? 'work' : 'version';
  const result: DropImportResult = {
    tracks: title ? [{ id: trackId, title }] : [],
    versionIds: [],
    versions: 0,
    variants: 0,
    skipped: 0,
    rejected: 0,
    failed: title ? 0 : 1,
    attached: true,
    lyricsBound: 0,
    mediaSkipped: Math.max(0, paths.length - 1),
  };
  if (!title || !paths.length) return result;
  const bound = await bindLyricFile(
    ctx,
    trackId,
    path.resolve(paths[0]),
    scope,
    input?.recId ? String(input.recId) : null,
    asPolicy(input?.policy)
  );
  if (bound.ok) result.lyricsBound = 1;
  else result.mediaSkipped = (result.mediaSkipped ?? 0) + 1;
  return result;
}
