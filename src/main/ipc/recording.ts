import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { dialog } from 'electron';
import { probeAudioInfo } from '../../shared/audiofile.js';
import { mt } from '../locale';
import { AUDIO_EXT, fileSizeOf, readHead, resolveAudio, type Ctx } from './audio';
import { hashFile } from './filehash';

/** 只查库、不碰文件的函数只需要 db：分析 / 曲目模块手上只有 `{ db }` */
type DbCtx = Pick<Ctx, 'db'>;
import { newId as makeId } from '../db/ids';

/**
 * recording.ts — 录音制品层。
 *
 * 作品层（track）记「这是什么」：标题、作曲家、时期、调式、乐器编制。
 * 这一层记「这是哪一次录音」：谁演的、哪个乐团、谁指挥、哪年录的、谁做的混音母带。
 *
 * 同一部作品的不同录音，前者完全相同、后者逐条不同 ——
 * 所以作曲家留在作品层，演奏家与母带信息放在这里。
 */

export interface Recording {
  id: string;
  trackId: string;
  /**
   * 归属的演奏版本（同一版录音的不同音质 / 转码）。
   * null = 这是一条演奏版本；非空 = 它只是某个演奏版本的一个文件。
   */
  parentId: string | null;
  /** 只在演奏版本上出现：它名下的音质文件（按顺序，第一首是播放首选） */
  variants: Recording[];
  /** 演奏者数组（JSON 存，读出来是 string[]） */
  performers: string[];
  orchestra: string;
  conductor: string;
  soloist: string;
  credits: Record<string, string>;
  recordingPlace: string;
  recordedYear: number | null;
  mixEngineer: string;
  masteringEngineer: string;
  label: string;
  catalogNo: string;
  releaseYear: number | null;
  filePath: string;
  durationMs: number;
  format: string | null;
  sampleRate: number;
  channels: number;
  bits: number;
  isDefault: boolean;
  note: string;
  /**
   * 这个版本自己的「时间线原点偏移」（毫秒）= 第 1 小节落在音频里的位置。
   *
   * 为什么是录音层的字段：同一部作品换一版录音，开头留白可能差三秒
   * （磁带转录 vs CD 抓轨）。挂在作品层只能对齐其中一个，换版听就整体偏。
   */
  audioOffsetMs: number;
  /** 文件是否真的在（路径存在） */
  fileExists: boolean;
  /** 外部网络链接；没有本地文件时就靠它播 */
  link: string;
  /** 靠外链播放（无本地文件、有链接） */
  isExternal: boolean;
  /** 渲染层喂 <audio> 的地址；缺录音时回落到作品的主文件 */
  url: string;
  /** 这条录音名下的自定义协议地址（便于将来按录音取音频） */
  recUrl: string;
  /**
   * 这一演奏版本自己的歌词（相对 data/）。空 = 退回作品级歌词。
   * 音质行不使用这两列，读的时候会走到父版本。
   */
  lyricsRel: string | null;
  /** 这一演奏版本自己的封面（相对 data/）。空 = 退回作品独立封面，再没有才用专辑封面。 */
  coverRel: string | null;
}

export interface RecordingPatch {
  id?: string;
  trackId: string;
  /** 内部用：把新录音登记为某个演奏版本的音质文件 */
  parentId?: string;
  performers?: string[];
  orchestra?: string;
  conductor?: string;
  soloist?: string;
  credits?: Record<string, string>;
  recordingPlace?: string;
  recordedYear?: number | null;
  mixEngineer?: string;
  masteringEngineer?: string;
  label?: string;
  catalogNo?: string;
  releaseYear?: number | null;
  filePath?: string;
  durationMs?: number | null;
  format?: string | null;
  sampleRate?: number | null;
  channels?: number | null;
  bits?: number | null;
  isDefault?: boolean;
  note?: string;
  /** 外部网络链接；传空串表示清掉 */
  link?: string;
  /** 文件内容的 SHA-256。换了文件却没给新哈希时，旧哈希会被清掉，免得去重认错人 */
  fileHash?: string | null;
  /** 时间线原点偏移（ms）；不传 = 保持原值 */
  audioOffsetMs?: number;
}

const EXT = AUDIO_EXT;

/**
 * 录音版本 id：与曲目用同一套生成器（`rec-<8 位时间>-<10 位随机>`）。
 *
 * 原来这里是 `Math.random()` 8 位 + 时间尾 4 位 —— 能用，但 `Math.random` 是可预测的 PRNG，
 * 而且前缀 / 长度与曲目 id 不一致，排查时还得记两套格式。
 */
function newId(): string {
  return makeId('rec');
}

function safeTitle(title: string): string {
  return String(title ?? '').replace(/[\\/:*?"<>|]/g, '_');
}

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    try {
      const j = JSON.parse(v);
      if (Array.isArray(j)) return j.map((x) => String(x)).filter(Boolean);
    } catch {
      /* 不是 JSON，当成单个名字 */
    }
    return [v];
  }
  return [];
}

function parseObj(v: unknown): Record<string, string> {  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null && x !== undefined && String(x) !== '')
        .map(([k, x]) => [k, String(x)])
    );
  }
  if (typeof v === 'string' && v.trim()) {
    try {
      return parseObj(JSON.parse(v));
    } catch {
      /* 忽略坏 JSON */
    }
  }
  return {};
}

/**
 * 外链规范化。
 *
 * 用户贴链接时常常只写 `music.163.com/song/123`，没有协议头。
 * 渲染层会提示一次，但主进程不能指望所有调用方（导入脚本、将来可能的剪贴板粘贴）
 * 都守规矩，所以这里再补一道：没有 scheme 就补 https。
 * 其它协议（file: / javascript:）原样保留 —— 打不开是 link.open 拒绝的事，
 * 在这里悄悄改写反而更危险。
 */
function normLink(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s.replace(/^\/+/, '')}`;
}

/** DB 行 → 界面对象 */
function rowToRecording(r: any, exists: (p: string) => boolean): Recording {
  return {
    id: r.id,
    trackId: r.track_id,
    parentId: r.parent_id ?? null,
    variants: [],
    performers: parseList(r.performers),
    orchestra: r.orchestra ?? '',
    conductor: r.conductor ?? '',
    soloist: r.soloist ?? '',
    credits: parseObj(r.credits_json),
    recordingPlace: r.recording_place ?? '',
    recordedYear: r.recorded_year ?? null,
    mixEngineer: r.mix_engineer ?? '',
    masteringEngineer: r.mastering_engineer ?? '',
    label: r.label ?? '',
    catalogNo: r.catalog_no ?? '',
    releaseYear: r.release_year ?? null,
    filePath: r.file_path ?? '',
    durationMs: r.duration_ms ?? 0,
    format: r.format ?? null,
    sampleRate: r.sample_rate ?? 0,
    channels: r.channels ?? 0,
    bits: r.bits ?? 0,
    isDefault: r.is_default === 1,
    note: r.note ?? '',
    audioOffsetMs: r.audio_offset_ms ?? 0,
    fileExists: !!r.file_path && exists(r.file_path),
    link: r.link ?? '',
    // 有本地文件就本地优先；链接只是「这个版本在网上在哪」的补充信息
    isExternal: !r.file_path && !!r.link,
    url: '',
    recUrl: `ma-audio://rec/${encodeURIComponent(r.track_id)}/${encodeURIComponent(r.id)}`,
    lyricsRel: r.lyrics_rel ? String(r.lyrics_rel) : null,
    coverRel: r.cover_rel ? String(r.cover_rel) : null,
  };
}

/**
 * 音质行没有自己的歌词和封面。给一个录音 id，返回它所属的演奏版本。
 * 已经是演奏版本时就返回自己。
 */
export function versionMaster(
  ctx: DbCtx,
  recId: string
): { id: string; trackId: string; lyricsRel: string | null; coverRel: string | null } | null {
  const r = ctx.db
    .prepare(
      `SELECT id, track_id, parent_id, lyrics_rel, cover_rel FROM recording WHERE id = ? AND deleted_at IS NULL`
    )
    .get(recId) as any;
  if (!r) return null;
  if (!r.parent_id) {
    return {
      id: r.id,
      trackId: r.track_id,
      lyricsRel: r.lyrics_rel ? String(r.lyrics_rel) : null,
      coverRel: r.cover_rel ? String(r.cover_rel) : null,
    };
  }
  const p = ctx.db
    .prepare(
      `SELECT id, track_id, lyrics_rel, cover_rel FROM recording
        WHERE id = ? AND parent_id IS NULL AND deleted_at IS NULL`
    )
    .get(r.parent_id) as any;
  if (!p) return null;
  return {
    id: p.id,
    trackId: p.track_id,
    lyricsRel: p.lyrics_rel ? String(p.lyrics_rel) : null,
    coverRel: p.cover_rel ? String(p.cover_rel) : null,
  };
}

/** 只改演奏版本上的歌词 / 封面路径。传音质行的 id 会写到它的父版本上。 */
export function setVersionMedia(
  ctx: DbCtx,
  recId: string,
  patch: { lyricsRel?: string | null; coverRel?: string | null }
): { id: string; trackId: string } | null {
  const master = versionMaster(ctx, recId);
  if (!master) return null;
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.lyricsRel !== undefined) {
    sets.push('lyrics_rel = ?');
    args.push(patch.lyricsRel || null);
  }
  if (patch.coverRel !== undefined) {
    sets.push('cover_rel = ?');
    args.push(patch.coverRel || null);
  }
  if (!sets.length) return { id: master.id, trackId: master.trackId };
  sets.push('updated_at = ?');
  args.push(Date.now(), master.id);
  ctx.db.prepare(`UPDATE recording SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return { id: master.id, trackId: master.trackId };
}

/**
 * 顺序就是一切：**列表顺序 = 播放优先级**，不再有「用户挑的默认版本」。
 *
 * 点作品的播放播第一首；想换哪一版就把它往上挪（`reorderRecordings`）。
 * `is_default` 列还留着，但它现在只是「顺序推导出来的结果」——给
 * `track.file_path`（主文件指针）与老查询用，界面上一个字都不再显示。
 */
const SEL = `SELECT * FROM recording WHERE track_id = ? AND deleted_at IS NULL ORDER BY seq_order, seq`;

/**
 * 列出作品的**演奏版本**（parent_id = null），音质文件挂在 `variants` 里。
 *
 * 顺序仍然是播放优先级：`seq_order` 只在同一层内比较，音质文件不参与
 * 「点作品先播哪一版」的排序 —— 它们不是独立的版本，只是同一个版本的不同文件。
 */
export function listRecordings({ db }: DbCtx, trackId: string): Recording[] {
  const rows = db.prepare(SEL).all(trackId) as any[];
  const exists = (p: string) => {
    try {
      return !!p && fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const all = rows.map((r) => rowToRecording(r, exists));
  const byParent = new Map<string, Recording[]>();
  for (const rec of all) {
    if (!rec.parentId) continue;
    const list = byParent.get(rec.parentId) ?? [];
    list.push(rec);
    byParent.set(rec.parentId, list);
  }
  const masters = all.filter((r) => !r.parentId);
  for (const m of masters) m.variants = byParent.get(m.id) ?? [];
  return masters;
}

/** 演奏版本自己有没有可播文件：自己的文件优先，其次看它名下的音质文件 */
export function recordingHasFile(r: Recording): boolean {
  return r.fileExists || r.variants.some((v) => v.fileExists);
}

export function getRecording({ db }: DbCtx, id: string): Recording | null {
  const r = db.prepare(`SELECT * FROM recording WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
  if (!r) return null;
  return rowToRecording(r, (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * 某作品当前在播的那条录音 = **顺序里的第一首**。
 * 第一首要是还没绑文件（「先登记信息、音频后补」很常见），兜到第一个有文件的，
 * 免得整部作品明明有别的版本能播、却被判成「没有音频」。
 */
export function defaultRecording(ctx: DbCtx, trackId: string): Recording | null {
  const all = listRecordings(ctx, trackId);
  if (!all.length) return null;
  return all.find((r) => recordingHasFile(r)) ?? all[0];
}

const _WRITABLE = [
  'orchestra', 'conductor', 'soloist', 'recordingPlace', 'mixEngineer',
  'masteringEngineer', 'label', 'catalogNo', 'note',
] as const;

/** 新建或更新一条录音 */
export function saveRecording(ctx: Ctx, patch: RecordingPatch): Recording {
  const now = Date.now();
  const perf = JSON.stringify(patch.performers ?? []);
  const credits = JSON.stringify(patch.credits ?? {});

  if (patch.id) {
    // 更新：白名单字段 + 技术信息
    const cur = ctx.db.prepare(`SELECT * FROM recording WHERE id = ? AND deleted_at IS NULL`).get(patch.id) as any;
    if (!cur) throw new Error('recording not found');
    const merged: any = {
      orchestra: patch.orchestra ?? cur.orchestra ?? '',
      conductor: patch.conductor ?? cur.conductor ?? '',
      soloist: patch.soloist ?? cur.soloist ?? '',
      recording_place: patch.recordingPlace ?? cur.recording_place ?? '',
      mix_engineer: patch.mixEngineer ?? cur.mix_engineer ?? '',
      mastering_engineer: patch.masteringEngineer ?? cur.mastering_engineer ?? '',
      label: patch.label ?? cur.label ?? '',
      catalog_no: patch.catalogNo ?? cur.catalog_no ?? '',
      note: patch.note ?? cur.note ?? '',
      link: patch.link !== undefined ? normLink(patch.link) : cur.link ?? '',
      audio_offset_ms:
        patch.audioOffsetMs !== undefined
          ? Math.round(Number(patch.audioOffsetMs) || 0)
          : cur.audio_offset_ms ?? 0,
      recorded_year: patch.recordedYear !== undefined ? patch.recordedYear : cur.recorded_year,
      release_year: patch.releaseYear !== undefined ? patch.releaseYear : cur.release_year,
      file_path: patch.filePath !== undefined ? patch.filePath : cur.file_path,
      file_hash:
        patch.fileHash !== undefined
          ? patch.fileHash || null
          : patch.filePath !== undefined && patch.filePath !== cur.file_path
            ? null
            : cur.file_hash ?? null,
      duration_ms: patch.durationMs !== undefined ? patch.durationMs : cur.duration_ms,
      format: patch.format !== undefined ? patch.format : cur.format,
      sample_rate: patch.sampleRate !== undefined ? patch.sampleRate : cur.sample_rate,
      channels: patch.channels !== undefined ? patch.channels : cur.channels,
      bits: patch.bits !== undefined ? patch.bits : cur.bits,
    };
    ctx.db
      .prepare(
        `UPDATE recording SET performers = ?, credits_json = ?, orchestra = ?, conductor = ?,
           soloist = ?, recording_place = ?, mix_engineer = ?, mastering_engineer = ?,
           label = ?, catalog_no = ?, note = ?, recorded_year = ?, release_year = ?,
           file_path = ?, file_hash = ?, duration_ms = ?, format = ?, sample_rate = ?, channels = ?, bits = ?,
           link = ?, audio_offset_ms = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        perf, credits, merged.orchestra, merged.conductor, merged.soloist, merged.recording_place,
        merged.mix_engineer, merged.mastering_engineer, merged.label, merged.catalog_no,
        merged.note, merged.recorded_year, merged.release_year, merged.file_path, merged.file_hash, merged.duration_ms,
        merged.format, merged.sample_rate, merged.channels, merged.bits, merged.link,
        merged.audio_offset_ms, now, patch.id
      );
    if (patch.isDefault !== undefined) setDefault(ctx, patch.trackId, patch.isDefault ? patch.id : undefined);
    // 换了音频文件 / 改了外链，主文件指针要跟着重算（第一首有文件的那条说了算）
    normalizeOrder(ctx, patch.trackId);
    return getRecording(ctx, patch.id)!;
  }

  // 新建：追加到末尾。
  // 用 MAX(seq_order)+1 而不是 COUNT(*) —— 顺序被调整过（或删过版本）之后，
  // seq_order 会出现空号，用条数当序号会让新加的版本插到第一条前面去。
  const parentId = patch.parentId
    ? ((
        ctx.db
          .prepare(
            `SELECT id FROM recording WHERE id = ? AND track_id = ? AND parent_id IS NULL AND deleted_at IS NULL`
          )
          .get(patch.parentId, patch.trackId) as any
      )?.id ?? null)
    : null;
  if (patch.parentId && !parentId) throw new Error('invalid recording parent');
  const id = newId();
  const siblingWhere = parentId ? `track_id = ? AND parent_id = ?` : `track_id = ? AND parent_id IS NULL`;
  const siblingArgs = parentId ? [patch.trackId, parentId] : [patch.trackId];
  const lastOrder = (
    ctx.db
      .prepare(`SELECT MAX(seq_order) m FROM recording WHERE ${siblingWhere} AND deleted_at IS NULL`)
      .get(...siblingArgs) as any
  )?.m;
  const nextOrder = (typeof lastOrder === 'number' ? lastOrder : -1) + 1;

  ctx.db
    .prepare(
      `INSERT INTO recording (id, track_id, parent_id, performers, credits_json, orchestra, conductor, soloist,
         recording_place, recorded_year, mix_engineer, mastering_engineer, label, catalog_no,
         release_year, file_path, file_hash, duration_ms, format, sample_rate, channels, bits,
         is_default, note, link, audio_offset_ms, seq_order, added_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      id, patch.trackId, parentId, perf, credits,
      patch.orchestra ?? '', patch.conductor ?? '', patch.soloist ?? '',
      patch.recordingPlace ?? '', patch.recordedYear ?? null,
      patch.mixEngineer ?? '', patch.masteringEngineer ?? '',
      patch.label ?? '', patch.catalogNo ?? '', patch.releaseYear ?? null,
      patch.filePath ?? '', patch.fileHash || null, patch.durationMs ?? 0, patch.format ?? null,
      patch.sampleRate ?? 0, patch.channels ?? 0, patch.bits ?? 0,
      0, patch.note ?? '', normLink(patch.link),
      Math.round(Number(patch.audioOffsetMs) || 0), nextOrder, now, now
    );

  normalizeOrder(ctx, patch.trackId);
  return getRecording(ctx, id)!;
}

/**
 * 把作品的主文件指针指向某条录音（track.file_path 是「主录音」的快捷方式）。
 *
 * **只在该录音真的有文件时才动 track.file_path。**
 * 切到一条没绑音频的录音上却把 file_path 清空，等于让一首本来能播的歌突然播不出来 ——
 * 而「登记了版本信息但还没拿到文件」是很常见的状态（先记信息，音频后补）。
 */
/**
 * 一条演奏版本实际拿来播放的文件：自己的文件优先；没绑（或文件被挪走）就用
 * 它名下第一个还在磁盘上的音质文件。**只读**，不写库。
 */
function effectiveFile(
  ctx: Ctx,
  trackId: string,
  rec: { id: string; file_path?: string | null; duration_ms?: number | null; file_hash?: string | null }
): { file_path: string; duration_ms: number | null; file_hash: string | null } | null {
  if (rec.file_path && fileOk(rec.file_path)) {
    return { file_path: rec.file_path, duration_ms: rec.duration_ms ?? null, file_hash: rec.file_hash ?? null };
  }
  const kids = ctx.db
    .prepare(
      `SELECT file_path, duration_ms, file_hash FROM recording
        WHERE track_id = ? AND parent_id = ? AND deleted_at IS NULL
        ORDER BY seq_order, seq`
    )
    .all(trackId, rec.id) as any[];
  const hit = kids.find((k) => fileOk(k.file_path));
  return hit
    ? { file_path: hit.file_path, duration_ms: hit.duration_ms ?? null, file_hash: hit.file_hash ?? null }
    : null;
}

/** 把作品的主文件指针指向某条演奏版本实际会播的文件（可能是它的某个音质文件） */
function syncTrackFromRecording(ctx: Ctx, trackId: string, recId: string) {
  const r = ctx.db.prepare(`SELECT id, file_path, duration_ms FROM recording WHERE id = ?`).get(recId) as any;
  if (!r) return;
  const eff = effectiveFile(ctx, trackId, r);
  if (!eff) return;
  ctx.db
    .prepare(
      `UPDATE track SET file_path = ?, duration_ms = COALESCE(?, duration_ms), file_hash = ?, updated_at = ? WHERE id = ?`
    )
    .run(eff.file_path, eff.duration_ms || null, eff.file_hash, Date.now(), trackId);
}

function fileOk(p: unknown): boolean {
  if (!p) return false;
  try {
    return fs.existsSync(String(p));
  } catch {
    return false;
  }
}

/** 按给定顺序重排（ids 就是从前往后的完整清单） */
function writeOrder(ctx: Ctx, trackId: string, ids: string[]) {
  const now = Date.now();
  const st = ctx.db.prepare(
    `UPDATE recording SET seq_order = ?, updated_at = ?
      WHERE id = ? AND track_id = ? AND parent_id IS NULL AND deleted_at IS NULL`
  );
  ctx.db.transaction((list: string[]) => {
    list.forEach((id, i) => st.run(i, now, id, trackId));
  })(ids);
}

/**
 * 重算「谁在主播放位」——顺序变了、加了、删了之后都要调一次。
 *
 * 规则：**第一条有可播文件的演奏版本**把 `is_default` 拿下，同时把
 * `track.file_path` 指过去（该版本自己没文件时，指向它名下第一个音质文件）。
 * 音质文件永远不拿 `is_default`：它们不是独立版本。
 */
function normalizeOrder(ctx: Ctx, trackId: string) {
  const all = ctx.db
    .prepare(
      `SELECT id, file_path, duration_ms, file_hash FROM recording
        WHERE track_id = ? AND deleted_at IS NULL AND parent_id IS NULL
        ORDER BY seq_order, seq`
    )
    .all(trackId) as any[];
  if (!all.length) {
    const anyAlive = ctx.db
      .prepare(`SELECT 1 FROM recording WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(trackId);
    if (!anyAlive) {
      ctx.db.prepare(`UPDATE track SET file_path = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), trackId);
    }
    return;
  }
  const pick = all.find((r) => effectiveFile(ctx, trackId, r)) ?? all[0];
  /**
   * 先全清零、再单独置 1，且包在事务里。
   * 别写成一条 `SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END`：
   * is_default 上有 **partial unique index**，SQLite 是逐行检查的，
   * 目标行先被更新时就会撞上「另一行还是 1」→ UNIQUE constraint failed。
   */
  ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE recording SET is_default = 0 WHERE track_id = ? AND is_default = 1`).run(trackId);
    ctx.db.prepare(`UPDATE recording SET is_default = 1 WHERE id = ?`).run(pick.id);
  })();
  syncTrackFromRecording(ctx, trackId, pick.id);
}

/**
 * 调整录音版本顺序。**这是「换播哪一版」的唯一入口**（原来的「设为默认」已并入这里）。
 * 传完整清单，不要让调用方算 delta —— 少传一条就会把那条排到 0 号位。
 */
export function reorderRecordings(ctx: Ctx, trackId: string, ids: string[]): Recording[] {
  const alive = listRecordings(ctx, trackId).map((r) => r.id);
  // 只认该作品现存的行，防止渲染层拿着过期清单把已删的 id 写回去
  const next = (Array.isArray(ids) ? ids : []).filter((id) => alive.includes(id));
  for (const id of alive) if (!next.includes(id)) next.push(id);
  writeOrder(ctx, trackId, next);
  normalizeOrder(ctx, trackId);
  return listRecordings(ctx, trackId);
}

/**
 * 兼容旧调用：把某条录音设为主播放 = **把它挪到第一位**，再由顺序推导 is_default。
 * 界面已经不再提供「设为默认」按钮，新代码请直接用 `reorderRecordings`。
 */
export function setDefault(ctx: Ctx, trackId: string, recId?: string): Recording | null {
  if (recId) {
    const ids = listRecordings(ctx, trackId).map((r) => r.id);
    const i = ids.indexOf(recId);
    if (i > 0) {
      ids.splice(i, 1);
      ids.unshift(recId);
      writeOrder(ctx, trackId, ids);
    }
  }
  normalizeOrder(ctx, trackId);
  return defaultRecording(ctx, trackId);
}

/** 软删一条录音。删演奏版本会连同它的音质文件一起删；删完按顺序重新推一遍主播放位 */
export function removeRecording(ctx: Ctx, id: string): void {
  const r = ctx.db.prepare(`SELECT track_id, parent_id FROM recording WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
  if (!r) return;
  const now = Date.now();
  ctx.db.transaction(() => {
    if (!r.parent_id) {
      ctx.db
        .prepare(`UPDATE recording SET deleted_at = ? WHERE parent_id = ? AND deleted_at IS NULL`)
        .run(now, id);
    }
    ctx.db.prepare(`UPDATE recording SET deleted_at = ? WHERE id = ?`).run(now, id);
  })();
  normalizeOrder(ctx, r.track_id);
}

/** 给某条录音挑音频文件（对话框），顺手探测格式并回填 */
export async function pickRecordingAudio(ctx: Ctx, trackId: string, recId?: string): Promise<Recording | null> {
  const res = await dialog.showOpenDialog({
    title: mt('audio.pickTitle'),
    properties: ['openFile'],
    filters: [
      { name: mt('audio.filter.audio'), extensions: EXT.map((e) => e.slice(1)) },
      { name: mt('audio.filter.all'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const file = res.filePaths[0];
  const info = probeAudioInfo(readHead(file), fileSizeOf(file));
  const fileHash = await hashFile(file).catch(() => null);
  const patch: RecordingPatch = {
    trackId,
    filePath: file,
    fileHash,
    durationMs: info?.durationMs ?? null,
    format: info?.format ?? null,
    sampleRate: info?.sampleRate ?? null,
    channels: info?.channels ?? null,
    bits: info?.bits ?? null,
  };
  if (recId) patch.id = recId;
  return saveRecording(ctx, patch);
}

/**
 * 给已有演奏版本追加一个「同版音质」（flac / mp3 / ogg…）。
 *
 * 弹一次文件对话框，把文件登记成该版本名下的子记录；演奏信息、厂牌、原点偏移
 * 都留在父版本那一行，子记录只贡献文件与技术参数。播放时父版本自己的文件优先，
 * 没有就用第一个还在磁盘上的音质文件（见 effectiveFile）。
 */
export async function pickRecordingVariant(ctx: Ctx, parentId: string): Promise<Recording | null> {
  const parent = ctx.db
    .prepare(`SELECT id, track_id FROM recording WHERE id = ? AND parent_id IS NULL AND deleted_at IS NULL`)
    .get(parentId) as any;
  if (!parent) return null;
  const res = await dialog.showOpenDialog({
    title: mt('audio.pickTitle'),
    properties: ['openFile'],
    filters: [
      { name: mt('audio.filter.audio'), extensions: EXT.map((e) => e.slice(1)) },
      { name: mt('audio.filter.all'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const file = res.filePaths[0];
  const info = probeAudioInfo(readHead(file), fileSizeOf(file));
  const fileHash = await hashFile(file).catch(() => null);
  return saveRecording(ctx, {
    trackId: parent.track_id,
    parentId: parent.id,
    filePath: file,
    fileHash,
    durationMs: info?.durationMs ?? null,
    format: info?.format ?? null,
    sampleRate: info?.sampleRate ?? null,
    channels: info?.channels ?? null,
    bits: info?.bits ?? null,
  });
}

/**
 * 把一条已有的演奏版本并到另一条下面，当作「同版音质」。
 *
 * 只接受**没有自己音质子项**的顶层版本：否则就会造出三层（版本 → 版本 → 文件），
 * 而播放/删除的推导只认一层。合并后它的演奏字段留在库里但不再显示 ——
 * 演奏信息以目标版本为准（UI 上也会写清楚）。
 */
export function mergeRecordingInto(ctx: Ctx, id: string, parentId: string): Recording | null {
  if (!id || !parentId || id === parentId) return null;
  const child = ctx.db.prepare(`SELECT * FROM recording WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
  if (!child || child.parent_id) return null;
  const parent = ctx.db
    .prepare(`SELECT * FROM recording WHERE id = ? AND track_id = ? AND parent_id IS NULL AND deleted_at IS NULL`)
    .get(parentId, child.track_id) as any;
  if (!parent) return null;
  const hasKids = ctx.db
    .prepare(`SELECT 1 FROM recording WHERE parent_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(child.id);
  if (hasKids) return null;
  const maxOrder = (
    ctx.db
      .prepare(
        `SELECT MAX(seq_order) m FROM recording
          WHERE track_id = ? AND parent_id = ? AND deleted_at IS NULL`
      )
      .get(child.track_id, parent.id) as any
  )?.m;
  const nextOrder = (typeof maxOrder === 'number' ? maxOrder : -1) + 1;
  ctx.db
    .prepare(`UPDATE recording SET parent_id = ?, seq_order = ?, updated_at = ? WHERE id = ?`)
    .run(parent.id, nextOrder, Date.now(), child.id);
  normalizeOrder(ctx, child.track_id);
  return getRecording(ctx, child.id);
}

/**
 * 从作品的文件头兜底建一条录音。
 * 老档案只有 track.file_path、没有录音记录时用这个补一条，
 * 这样详情面板不会「明明有音频却一个版本都不列」。
 */
export function ensureRecordingForTrack(ctx: Ctx, trackId: string): Recording | null {
  const info = resolveAudio(ctx, trackId);
  if (!info.exists) return null;
  const existing = listRecordings(ctx, trackId);
  if (existing.length) return defaultRecording(ctx, trackId);
  /**
   * 第一条录音继承导入时写在 analysis 上的原点偏移。
   *
   * 导入器（seed / tools/import.mjs）仍然把 JSON 里的 timeline.audioOffsetMs 写进
   * analysis —— 那是单版本的年代留下的位置。在这里抄一次到录音上，
   * 新导入的档案就不必另外跑一遍迁移，而 analysis 那一列从此只当「初始值」。
   */
  const inherited = (
    ctx.db
      .prepare(`SELECT audio_offset_ms AS o FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(trackId) as any
  )?.o;
  return saveRecording(ctx, {
    trackId,
    filePath: info.path,
    durationMs: info.durationMs,
    format: info.format,
    sampleRate: info.sampleRate,
    channels: info.channels,
    bits: info.bits,
    audioOffsetMs: typeof inherited === 'number' ? inherited : 0,
    isDefault: true,
  });
}

/**
 * 某作品「当前生效」的原点偏移 = 主录音（顺序里的第一首）那一份。
 * 一个录音版本都没有时返回 null，调用方退回 analysis.audio_offset_ms。
 */
export function primaryOffset(ctx: DbCtx, trackId: string): number | null {
  const rec = defaultRecording(ctx, trackId);
  return rec ? rec.audioOffsetMs : null;
}

/**
 * 写某个录音版本的原点偏移。
 *
 * `recId` 为空 = 写「顺序里的第一首」，和播放、`track.file_path` 同一个口径 ——
 * 这样播放条上的 ±10ms 与「以播放头为原点」在不开录音管理窗口时也能改对版本。
 *
 * 一个版本都还没有的作品退回写 analysis：那是唯一还留着值的地方，
 * 等它生成第一条录音时 ensureRecordingForTrack 会把它抄过去。
 */
export function setRecordingOffset(
  ctx: DbCtx,
  trackId: string,
  recId: string | null,
  ms: number
): number {
  const v = Math.round(Number(ms) || 0);
  if (!Number.isFinite(v)) return 0;
  const now = Date.now();
  const target = recId ? getRecording(ctx, recId) : defaultRecording(ctx, trackId);

  if (target && target.trackId === trackId) {
    // 偏移属于「演奏版本」而不是某个音质文件：指到子记录时写回它的父版本
    const rootId = target.parentId ?? target.id;
    ctx.db
      .prepare(`UPDATE recording SET audio_offset_ms = ?, updated_at = ? WHERE id = ?`)
      .run(v, now, rootId);
    return v;
  }
  ctx.db
    .prepare(`UPDATE analysis SET audio_offset_ms = ?, updated_at = ? WHERE track_id = ? AND deleted_at IS NULL`)
    .run(v, now, trackId);
  return v;
}