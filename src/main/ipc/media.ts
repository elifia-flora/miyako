/**
 * media.ts — 封面与歌词（不是音频，也不是元信息）
 *
 * 为什么单独一块：
 *   封面和歌词都是「跟着曲目走的外部文件」，都不进 FTS，也都不该塞进列。
 *   统一存在 track.extra 里：
 *     covers: { single: 'covers/trk-x-single.jpg', album: 'covers/trk-x-album.jpg' }
 *     lyrics: 'lyrics/灰ト祈リ.lrc'
 *   路径**相对 dataDir**，换机器/换目录不会失效；只有用户从对话框选的原始
 *   文件才会被**复制**进来（原文件删了、移动了都不影响档案）。
 *
 * 封面走 ma-art:// 而不是 file://：
 *   渲染层拿不到任意路径，协议只认 trackId + 种类，路径由数据库决定；
 *   URL 上带 `?v=updated_at`，换封面后浏览器缓存自动失效。
 *
 * 歌词的「自动匹配」只在 data/lyrics 与 assets 里找 .lrc，
 * 用曲名 / 别名做归一化后比较：`GEMS COMPANY - 灰ト祈リ.lrc` 能对上「灰ト祈リ」，
 * 但不会因为一首叫「灰」的曲子就误配。找不到就老实说没有。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import { parseLrc, serializeLrc } from '../../shared/lrc.js';
import { mt } from '../locale';

export type CoverKind = 'single' | 'album';
export const COVER_KINDS: CoverKind[] = ['single', 'album'];

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'];
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

export interface MediaCtx {
  db: Database.Database;
  dataDir: string;
  /** 素材目录（开发时是仓库根的 assets） */
  assetsDir?: string;
}

export interface CoverSet {
  /** 相对 dataDir 的路径；null = 没设 */
  single: string | null;
  album: string | null;
  singleUrl: string | null;
  albumUrl: string | null;
  /** 实际会显示的封面：有独立封面就用独立，没有才退回专辑 */
  url: string | null;
  source: CoverKind | null;
}

interface TrackMediaRow {
  id: string;
  title: string;
  extra: string | null;
  updated_at: number | null;
}

function readExtra(extra: string | null): any {
  if (!extra) return {};
  try {
    const v = JSON.parse(extra);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function safeName(s: string): string {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function absOf(dataDir: string, rel: string | null | undefined): string | null {
  if (!rel) return null;
  const s = String(rel);
  return path.isAbsolute(s) ? s : path.join(dataDir, s);
}

/** 把选择的文件复制进 data/<sub>/，返回相对路径；失败返回 null */
function importFile(dataDir: string, sub: string, src: string, base: string): string | null {
  try {
    const dir = path.join(dataDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(src).toLowerCase() || '.bin';
    const name = `${safeName(base)}${ext}`;
    const dst = path.join(dir, name);
    if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
    return path.posix.join(sub, name);
  } catch {
    return null;
  }
}

function removeMediaFile(dataDir: string, rel: string | null | undefined): void {
  const abs = absOf(dataDir, rel);
  if (!abs) return;
  // 只删自己复制进来的东西（data 目录内的相对路径），绝不碰用户原文件
  const root = path.resolve(dataDir);
  if (!path.resolve(abs).startsWith(root + path.sep)) return;
  try {
    fs.unlinkSync(abs);
  } catch {
    /* 已经不在了 */
  }
}

function trackRow(db: Database.Database, trackId: string): TrackMediaRow | null {
  return (
    (db.prepare(`SELECT id, title, extra, updated_at FROM track WHERE id = ? AND deleted_at IS NULL`).get(trackId) as
      | TrackMediaRow
      | undefined) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* 封面                                                                */
/* ------------------------------------------------------------------ */

export function coversOf(ctx: MediaCtx, trackId: string): CoverSet {
  const row = trackRow(ctx.db, trackId);
  const extra = readExtra(row?.extra ?? null);
  const single = extra?.covers?.single ? String(extra.covers.single) : null;
  const album = extra?.covers?.album ? String(extra.covers.album) : null;
  const q = row?.updated_at ? `?v=${row.updated_at}` : '';
  const url = (kind: CoverKind, rel: string | null) =>
    rel ? `ma-art://cover/${encodeURIComponent(trackId)}/${kind}${q}` : null;
  const singleExists = single && fs.existsSync(absOf(ctx.dataDir, single)!) ? single : null;
  const albumExists = album && fs.existsSync(absOf(ctx.dataDir, album)!) ? album : null;
  const source: CoverKind | null = singleExists ? 'single' : albumExists ? 'album' : null;
  return {
    single,
    album,
    singleUrl: url('single', singleExists),
    albumUrl: url('album', albumExists),
    url: source === 'single' ? url('single', singleExists) : source === 'album' ? url('album', albumExists) : null,
    source,
  };
}

function writeCovers(ctx: MediaCtx, trackId: string, next: Record<string, string | null>): void {
  const row = trackRow(ctx.db, trackId);
  if (!row) return;
  const extra = readExtra(row.extra);
  const covers: any = { ...(extra.covers ?? {}) };
  for (const [k, v] of Object.entries(next)) {
    if (v) covers[k] = v;
    else delete covers[k];
  }
  if (Object.keys(covers).length) extra.covers = covers;
  else delete extra.covers;
  ctx.db
    .prepare(`UPDATE track SET extra = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(extra), Date.now(), trackId);
}

export async function pickCover(ctx: MediaCtx, trackId: string, kind: CoverKind): Promise<CoverSet | null> {
  if (!COVER_KINDS.includes(kind)) return null;
  const row = trackRow(ctx.db, trackId);
  if (!row) return null;
  const cur = coversOf(ctx, trackId);
  const curAbs = absOf(ctx.dataDir, kind === 'single' ? cur.single : cur.album);
  const res = await dialog.showOpenDialog({
    title: mt(kind === 'single' ? 'art.pickSingle' : 'art.pickAlbum'),
    defaultPath: curAbs && fs.existsSync(curAbs) ? path.dirname(curAbs) : undefined,
    properties: ['openFile'],
    filters: [
      { name: mt('art.filter.image'), extensions: IMAGE_EXT.map((e) => e.slice(1)) },
      { name: mt('art.filter.all'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const rel = importFile(ctx.dataDir, 'covers', res.filePaths[0], `${row.title}-${kind}`);
  if (!rel) return null;
  const old = kind === 'single' ? cur.single : cur.album;
  writeCovers(ctx, trackId, { [kind]: rel });
  if (old && old !== rel) removeMediaFile(ctx.dataDir, old);
  return coversOf(ctx, trackId);
}

export function clearCover(ctx: MediaCtx, trackId: string, kind: CoverKind): CoverSet | null {
  if (!COVER_KINDS.includes(kind)) return null;
  const cur = coversOf(ctx, trackId);
  const old = kind === 'single' ? cur.single : cur.album;
  writeCovers(ctx, trackId, { [kind]: null });
  if (old) removeMediaFile(ctx.dataDir, old);
  return coversOf(ctx, trackId);
}

/** 同 audio.ts：自定义协议跨源必须同时声明 corsEnabled + 回 CORS 头 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Cache-Control',
};

/** ma-art://cover/<trackId>/<single|album>?v=… */
export function serveArt(ctx: MediaCtx, req: Request): Response {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const trackId = decodeURIComponent(parts[0] ?? '');
  const kind = (parts[1] ?? '') as CoverKind;
  if (!trackId || !COVER_KINDS.includes(kind))
    return new Response('bad cover url', { status: 400, headers: CORS });

  const covers = coversOf(ctx, trackId);
  const rel = kind === 'single' ? covers.single : covers.album;
  const file = absOf(ctx.dataDir, rel);
  if (!file || !fs.existsSync(file)) return new Response('cover not found', { status: 404, headers: CORS });

  // 只允许 dataDir 与 assetsDir 内的文件（防止 extra 被手改成任意路径）
  const real = path.resolve(file);
  const roots = [path.resolve(ctx.dataDir), ctx.assetsDir ? path.resolve(ctx.assetsDir) : null].filter(Boolean) as string[];
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) {
    return new Response('forbidden', { status: 403, headers: CORS });
  }

  const mime = IMAGE_MIME[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
  return new Response(fs.readFileSync(real) as any, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': mime,
      'Content-Length': String(fs.statSync(real).size),
      // URL 带 ?v=updated_at：内容变了 URL 就变，可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

/* ------------------------------------------------------------------ */
/* 歌词                                                                */
/* ------------------------------------------------------------------ */

export interface LyricLine {
  ms: number;
  text: string;
}

export interface LyricDoc {
  trackId: string;
  found: boolean;
  /** 展示用的文件名；没有就是 null */
  file: string | null;
  /** 绝对路径（渲染层只用来显示在提示里） */
  path: string | null;
  lines: LyricLine[];
  meta: { ti: string; ar: string; al: string; by: string; offset: number; credits: string[] };
  /** 曲目被标记成纯音乐（没有歌词是正常状态，不该显示「未匹配」） */
  instrumental: boolean;
  /** 和曲名对得上的程度：auto = 自动匹配，manual = 用户指定 */
  how: 'manual' | 'auto' | 'none';
}

const EMPTY_META = { ti: '', ar: '', al: '', by: '', offset: 0, credits: [] as string[] };

function lyricDirs(ctx: MediaCtx): string[] {
  const dirs = [path.join(ctx.dataDir, 'lyrics')];
  if (ctx.assetsDir) dirs.push(ctx.assetsDir);
  return dirs.filter((d) => {
    try {
      return fs.existsSync(d);
    } catch {
      return false;
    }
  });
}

/** 归一化：去扩展名、去括号注释、去空白与常见分隔符，小写 */
function norm(s: string): string {
  return String(s ?? '')
    .replace(/\.lrc$/i, '')
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/[\s\-_·・.,，、:：/\\|_]+/g, '')
    .toLowerCase();
}

function titleCandidates(ctx: MediaCtx, trackId: string, title: string): string[] {
  const row = trackRow(ctx.db, trackId);
  const extra = readExtra(row?.extra ?? null);
  const list = [title, ...(Array.isArray(extra.aliases) ? extra.aliases : [])];
  return list.map((x) => norm(String(x ?? ''))).filter((x) => x.length >= 2);
}

/** 在 data/lyrics 与 assets 里找与曲名/别名对得上的 .lrc */
function autoFind(ctx: MediaCtx, trackId: string, title: string): string | null {
  const wanted = titleCandidates(ctx, trackId, title);
  if (!wanted.length) return null;
  let best: { file: string; score: number } | null = null;
  for (const dir of lyricDirs(ctx)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lrc'));
    } catch {
      continue;
    }
    for (const name of names) {
      const n = norm(name);
      const hit = wanted.find((w) => n.includes(w));
      if (!hit) continue;
      // 命中越长的曲名越可信；同分取文件名更短的（更可能是单曲而不是合集）
      const score = hit.length * 1000 - name.length;
      if (!best || score > best.score) best = { file: path.join(dir, name), score };
    }
  }
  return best?.file ?? null;
}

function parseFile(file: string): { lines: LyricLine[]; meta: LyricDoc['meta'] } {
  try {
    const buf = fs.readFileSync(file);
    // 歌词是文本，超过 4MB 基本是选错文件了
    if (buf.length > 4 * 1024 * 1024) return { lines: [], meta: { ...EMPTY_META } };
    // 不猜 GBK：现代 lrc 都是 UTF-8；真遇到乱码用户会换文件
    const text = buf.toString('utf8');
    const { lines, meta } = parseLrc(text);
    return { lines, meta };
  } catch {
    return { lines: [], meta: { ...EMPTY_META } };
  }
}

export function resolveLyrics(ctx: MediaCtx, trackId: string): LyricDoc {
  const row = trackRow(ctx.db, trackId);
  const empty: LyricDoc = {
    trackId,
    found: false,
    file: null,
    path: null,
    lines: [],
    meta: { ...EMPTY_META },
    instrumental: false,
    how: 'none',
  };
  if (!row) return empty;

  const extra = readExtra(row.extra);
  const instrumental = extra.instrumental === true;
  const manual = extra.lyrics ? absOf(ctx.dataDir, String(extra.lyrics)) : null;

  let file: string | null = null;
  let how: LyricDoc['how'] = 'none';
  if (manual && fs.existsSync(manual)) {
    file = manual;
    how = 'manual';
  } else {
    const hit = autoFind(ctx, trackId, row.title);
    if (hit) {
      file = hit;
      how = 'auto';
    }
  }

  if (!file) return { ...empty, instrumental, how: 'none' };
  const { lines, meta } = parseFile(file);
  return {
    trackId,
    found: lines.length > 0,
    file: path.basename(file),
    path: file,
    lines,
    meta,
    instrumental,
    how,
  };
}

/** 选一个 .lrc：复制进 data/lyrics，路径记进 extra */
export async function pickLyrics(ctx: MediaCtx, trackId: string): Promise<LyricDoc | null> {
  const row = trackRow(ctx.db, trackId);
  if (!row) return null;
  const cur = resolveLyrics(ctx, trackId);
  const res = await dialog.showOpenDialog({
    title: mt('lyrics.pickTitle'),
    defaultPath: cur.path ? path.dirname(cur.path) : undefined,
    properties: ['openFile'],
    filters: [
      { name: mt('lyrics.filter.lrc'), extensions: ['lrc', 'txt'] },
      { name: mt('lyrics.filter.all'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const rel = importFile(ctx.dataDir, 'lyrics', res.filePaths[0], row.title);
  if (!rel) return null;
  const extra = readExtra(row.extra);
  extra.lyrics = rel;
  // 指定了歌词就说明它不是纯音乐
  delete extra.instrumental;
  ctx.db
    .prepare(`UPDATE track SET extra = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(extra), Date.now(), trackId);
  return resolveLyrics(ctx, trackId);
}

export function clearLyrics(ctx: MediaCtx, trackId: string): LyricDoc | null {
  const row = trackRow(ctx.db, trackId);
  if (!row) return null;
  const extra = readExtra(row.extra);
  const old = extra.lyrics as string | undefined;
  delete extra.lyrics;
  ctx.db
    .prepare(`UPDATE track SET extra = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(extra), Date.now(), trackId);
  if (old) removeMediaFile(ctx.dataDir, old);
  return resolveLyrics(ctx, trackId);
}

/** 标记 / 取消「纯音乐」：纯音乐没有歌词是正常的，界面换一套说法 */
export function setInstrumental(ctx: MediaCtx, trackId: string, on: boolean): LyricDoc | null {
  const row = trackRow(ctx.db, trackId);
  if (!row) return null;
  const extra = readExtra(row.extra);
  if (on) extra.instrumental = true;
  else delete extra.instrumental;
  ctx.db
    .prepare(`UPDATE track SET extra = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(extra), Date.now(), trackId);
  return resolveLyrics(ctx, trackId);
}

/* ------------------------------------------------------------------ */
/* 歌词编辑（双击改时间戳 / 改歌词）与翻译                              */
/* ------------------------------------------------------------------ */

/**
 * 改一行歌词后写回文件。
 *
 * **只允许写「我们自己管理的文件」** —— 即手动指定的（extra.lyrics）或
 * 自动导入到 data/lyrics 的。assets/ 里的原始素材是只读的：
 * 那是用户放进来的源文件，改坏了要重新去别处找。
 * 自动匹配到 assets 的歌词不给编辑，返回 code:'readonly'，
 * 界面上应该提示「这份歌词是自动匹配的原始文件，请先指定一份」。
 */
export function saveLyricLine(
  ctx: MediaCtx,
  trackId: string,
  patch: { index: number; ms?: number; text?: string }
): LyricDoc | { code: 'readonly' | 'badindex' | 'nodoc' } {
  const doc = resolveLyrics(ctx, trackId);
  if (!doc.found || !doc.path) return { code: 'nodoc' };
  if (doc.how === 'auto') return { code: 'readonly' };

  const idx = Number(patch?.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= doc.lines.length) return { code: 'badindex' };

  const lines = doc.lines.map((l) => ({ ...l }));
  if (typeof patch.ms === 'number' && Number.isFinite(patch.ms)) {
    lines[idx].ms = Math.max(0, Math.round(patch.ms));
  }
  if (typeof patch.text === 'string') {
    // 换行会让这一行变成两条空行以外的怪东西，直接拒掉
    lines[idx].text = patch.text.replace(/[\r\n]+/g, ' ').trim();
  }

  const text = serializeLrc(lines, doc.meta);
  try {
    fs.writeFileSync(doc.path, text, 'utf8');
  } catch (e) {
    console.error('[lyrics] 写回失败', doc.path, e);
    return { code: 'nodoc' };
  }
  return resolveLyrics(ctx, trackId);
}

/**
 * 翻译：支持两种来源。
 *  1) 同目录下同名 `.trans.lrc` / `.中文.lrc` —— 手工对照放的最稳
 *  2) 结构化 JSON（{ from, to, lines: [{ms, text}] }）—— 机器翻译导出的
 * 两种都按 ms 对齐挂到原句上，对不上就按行序兜底。
 */
export function loadLyricsTranslation(
  ctx: MediaCtx,
  trackId: string
): { found: boolean; file: string | null; lines: { ms: number; text: string }[] } {
  const empty = { found: false, file: null, lines: [] as { ms: number; text: string }[] };
  const doc = resolveLyrics(ctx, trackId);
  if (!doc.found || !doc.path) return empty;

  const dir = path.dirname(doc.path);
  const base = path.basename(doc.path).replace(/\.lrc$/i, '');

  // 1) 同名 .trans.lrc / .中文.lrc / .translation.lrc
  const CANDIDATES = [
    `${base}.trans.lrc`, `${base}.zh.lrc`, `${base}.中文.lrc`,
    `${base}.translation.lrc`, `${base}.cn.lrc`,
  ];
  for (const name of CANDIDATES) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const { lines } = parseFile(p);
      if (lines.length) return { found: true, file: name, lines: lines.map((l) => ({ ms: l.ms, text: l.text })) };
    } catch {
      /* 试下一个 */
    }
  }

  // 2) 同名 .json
  const jp = path.join(dir, `${base}.json`);
  if (fs.existsSync(jp)) {
    try {
      const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
      const arr = Array.isArray(j) ? j : Array.isArray(j?.lines) ? j.lines : null;
      if (arr?.length) {
        const lines = arr
          .map((x: any) => ({ ms: Number(x?.ms ?? x?.t ?? 0), text: String(x?.text ?? x?.zh ?? x?.cn ?? '') }))
          .filter((x: any) => x.text);
        if (lines.length) return { found: true, file: path.basename(jp), lines };
      }
    } catch {
      /* JSON 坏了就当没有 */
    }
  }
  return empty;
}

/** 绑定一份翻译：复制进 data/lyrics，路径记进 extra */
export async function pickLyricsTranslation(ctx: MediaCtx, trackId: string): Promise<boolean> {
  const row = trackRow(ctx.db, trackId);
  if (!row) return false;
  const res = await dialog.showOpenDialog({
    title: mt('lyrics.transPickTitle'),
    properties: ['openFile'],
    filters: [
      { name: mt('lyrics.filter.trans'), extensions: ['lrc', 'txt', 'json'] },
      { name: mt('lyrics.filter.all'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return false;
  const rel = importFile(ctx.dataDir, 'lyrics', res.filePaths[0], row.title);
  if (!rel) return false;
  const extra = readExtra(row.extra);
  extra.lyricsTranslation = rel;
  ctx.db
    .prepare(`UPDATE track SET extra = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(extra), Date.now(), trackId);
  return true;
}

/** 清除翻译绑定 */
export function clearLyricsTranslation(ctx: MediaCtx, trackId: string): boolean {
  const row = trackRow(ctx.db, trackId);
  if (!row) return false;
  const extra = readExtra(row.extra);
  const old = extra.lyricsTranslation as string | undefined;
  delete extra.lyricsTranslation;
  ctx.db
    .prepare(`UPDATE track SET extra = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(extra), Date.now(), trackId);
  if (old) removeMediaFile(ctx.dataDir, old);
  return true;
}
