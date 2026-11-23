import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { trackFileCandidates } from '../../shared/trackfile.js';
import { normalizeLang } from '../../shared/lang.js';

/**
 * 曲目 JSON 的**写回器**（数据库 → `data/tracks/*.json`）。
 *
 * 为什么必须有它：`data/tracks` 是这套档案的**源**（可 diff、可手改、可版本控制），
 * SQLite 只是「能重建的索引」（见 docs/开发计划.md 第 15 行）。以前只有
 * `seedFromTracks()` 这一条单向路（JSON → 库），于是界面上登记的作品只活在库里 ——
 * 换台机器、删掉 atlas.db、或者只是想看一份能进 git 的档案，就全没了。
 *
 * 三条约定：
 * 1. **只写作品层**。演奏家 / 乐团 / 指挥 / 混音母带 / 发行年属于录音版本
 *    （`recording` 表），不进 JSON —— 同一部作品有 N 个录音，写进去就得先定「哪一个算数」，
 *    而这个信息在 schema v2 里本来就没有位置。
 * 2. **uuid 就是库里 `track.id`**。不带它的话，`seed` 只能按标题算哈希 id，
 *    下次启动会为同一首曲子再插一行（标题一样、id 不一样）。老档案没有 uuid，
 *    写回时**认领**同名文件，而不是另建一份。
 * 3. **写文件失败不许影响业务**。写不进去最多是「档案少了这一份」，记日志即可；
 *    让一次磁盘错误把登记/编辑操作回滚成失败，是更糟的交换。
 */

export interface JsonCtx {
  db: Database.Database;
  dataDir: string;
}

/** 归档目录：与 `*.json` 平级但独立，`seedFromTracks` 只扫一层，不会把归档读回来 */
export const ARCHIVE_DIR = '.archive';

function tracksDir(dataDir: string): string {
  return path.join(dataDir, 'tracks');
}

function archiveDir(dataDir: string): string {
  return path.join(tracksDir(dataDir), ARCHIVE_DIR);
}

function safeJson(text: unknown): any {
  if (typeof text !== 'string' || !text) return {};
  try {
    return JSON.parse(text) ?? {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

/** 空数组 / 空对象 / null 都不写 —— 与「没记录」区分开，JSON 才不会到处是壳 */
function put<T>(value: T): T | null {
  if (value == null) return null;
  if (Array.isArray(value) && !value.length) return null;
  if (typeof value === 'object' && !Array.isArray(value) && value && !Object.keys(value).length) return null;
  return value;
}

/* ------------------------------------------------------------------ */
/* 数据库 → 文档                                                       */
/* ------------------------------------------------------------------ */

export function buildTrackDoc(db: Database.Database, trackId: string): any | null {
  const t = db.prepare(`SELECT * FROM track WHERE id = ? AND deleted_at IS NULL`).get(trackId) as any;
  if (!t) return null;

  const a = db
    .prepare(`SELECT * FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(trackId) as any;
  const extra = safeJson(t.extra);

  const markers = a
    ? (db
        .prepare(`SELECT * FROM analysis_marker WHERE analysis_id = ? ORDER BY tick, sort_order`)
        .all(a.id) as any[])
    : [];
  const byKind = (kind: string) => markers.filter((m) => m.kind === kind);

  const events = a
    ? (db.prepare(`SELECT * FROM analysis_event WHERE analysis_id = ? ORDER BY tick`).all(a.id) as any[])
    : [];

  /**
   * 标签按维度分流：乐器进 `instrumentIds`，作曲技法与演奏技法都进 `techniques`
   * （每条带 `root` = 词表里的父级，seed 只认 id、`root` 是给人看的）。
   * 流派 / 情绪不走 track_tag：前者是 `track.genre`，后者在 `extra.moods`。
   */
  const tags = db
    .prepare(
      `SELECT g.id, g.dim, g.name, e.parent_id
         FROM track_tag tt
         JOIN tag g ON g.id = tt.tag_id
    LEFT JOIN tag_edge e ON e.child_id = g.id
        WHERE tt.track_id = ?
        ORDER BY g.dim, g.id`
    )
    .all(trackId) as any[];

  const instrumentIds = tags.filter((g) => g.dim === 'instrument').map((g) => g.id);
  const techniques = tags
    .filter((g) => g.dim === 'composition' || g.dim === 'instrument_technique')
    .map((g) => ({ id: g.id, root: g.parent_id ?? '' }));

  // 声部（violin-1）在词表里是子标签：单独列出来，手工看档案时才知道它挂在谁下面。
  // 判据是「id 以父 id- 开头」—— 只按 parent 判断会把所有乐器都算进来
  // （horn 的父级是 brass，那只是分类，不是声部）。
  const derivedTags = tags
    .filter((g) => g.dim === 'instrument' && g.parent_id && String(g.id).startsWith(`${g.parent_id}-`))
    .map((g) => ({ id: g.id, parent: g.parent_id, name: g.name }));

  // 未标注就写 null：JSON 是源，补一个 4/4 会把「没量过」洗成「量过是 4/4」
  const meterNum = a?.meter_num ?? null;
  const meterDen = a?.meter_den ?? null;

  /** 原点偏移逐版本存；JSON 只有一个位置，取主录音那一份（与 getTrack 同口径） */
  const defaultRec = db
    .prepare(
      `SELECT audio_offset_ms FROM recording
        WHERE track_id = ? AND deleted_at IS NULL AND is_default = 1 LIMIT 1`
    )
    .get(trackId) as any;
  const offsetMs = defaultRec?.audio_offset_ms ?? a?.audio_offset_ms ?? 0;

  const doc = {
    schemaVersion: 3,
    /** = track.id。seed 优先用它，保证「同一首」不会因为改名而变成两条 */
    uuid: t.id,
    /** 乐章子项指向母作品；独立作品 / 母作品自身为 null（纯加法，老档案无此键即 null） */
    parentId: t.parent_id ?? null,
    title: {
      original: t.title,
      /**
       * 短代码（`en` / `ja` / `zh`），schema v4 起不再写 "English" 这种全名：
       * 全名是文案不是值，中文界面里没法翻、也没法接系统语言。
       * 库里若是老的全名，`normalizeLang` 会在写出去的这一刻归一。
       */
      lang: normalizeLang(t.title_lang),
      subtitle: str(extra.subtitle),
      aliases: Array.isArray(extra.aliases) ? extra.aliases : [],
    },
    basic: {
      meter: meterNum && meterDen ? `${meterNum}/${meterDen}` : null,
      // 这里**没有** meterType：单/复/混合拍子是规则算出来的（shared/meter.js），
      // 写进档案就会在改拍号之后变成过期结论
      meterNote: str(a?.meter_note) ?? str(extra.meterNote),
      bpm: a?.tempo_value ?? null,
      tempoUnit: str(a?.tempo_unit),
      tempoChange: hasTempoChange(byKind('tempo')),
      description: str(t.notes),
      /**
       * 标题模板的数据项（schema 扩展，老档案没这四个键）。
       * 作品编号 / 作品号属于作品层；子体裁 / 速度术语只在乐章上有意义，
       * 但共用一个位置（extra）比再加四列更接近「JSON 是源」的现状。
       */
      formNumber: str(extra.formNumber),
      opusNumber: str(extra.opusNumber),
      subType: str(extra.subType) ?? str(extra.subForm),
      tempoTerm: str(extra.tempoTerm),
    },
    period: str(t.period),
    genre: str(t.genre),
    /**
     * 体裁 / 曲式：写的是**词表 id**，不是显示名。
     * 显示名跟着界面语言走（交响曲 / Symphony），写进档案就变成了「某一刻的中文」，
     * 换语言、改译名之后都不再成立。
     */
    compositionType: str(t.composition_type),
    form: str(t.form),
    album: str(t.album),
    credits: put(extra.credits ?? null),
    links: put(extra.links ?? null),
    moods: Array.isArray(extra.moods) ? extra.moods : [],
    instrumentation: str(extra.instrumentationAbstract)
      ? { abstract: str(extra.instrumentationAbstract) }
      : null,
    covers: put(extra.covers ?? null),
    lyrics: str(extra.lyrics),
    instrumental: extra.instrumental === true ? true : null,
    instrumentIds,
    derivedTags,
    techniques,
    timeline: {
      ppq: Number(a?.ppq) || 480,
      audioOffsetMs: Number(offsetMs) || 0,
      /** 主录音的绝对路径。没绑音频就是 null（不猜 data/audio 里的同名文件） */
      audioPath: str(t.file_path),
      /**
       * 段落只有 `tick` 和名字。**不写小节数**（`bar`）：
       * 它由 tick + 拍号链算出来，改拍号之后必然过期 —— 位置只有一个真相。
       */
      sections: byKind('section').map((m) => ({
        tick: m.tick,
        label: m.label,
      })),
      keys: byKind('key').map((m) => ({
        tick: m.tick,
        keyName: m.key_name,
        confidence: m.confidence ?? 'confirmed',
        note: m.note ?? null,
      })),
    },
    events: events.map((e) => ({
      lane: e.lane,
      tick: e.tick,
      durTicks: e.dur_ticks,
      text: e.text,
      confidence: e.confidence ?? 'confirmed',
    })),
    extra: {},
  };

  return doc;
}

/** 中途变速：除了 tick 0 那条，还有别的 tempo marker 就算有变速 */
function hasTempoChange(tempos: any[]): boolean {
  return tempos.some((m) => (m.tick ?? 0) > 0);
}

export function stringifyTrackDoc(doc: any): string {
  // 2 空格缩进、UTF-8 无 BOM、结尾带换行 —— 与词表写回一致，git diff 才只显示变化那几行
  return JSON.stringify(doc, null, 2) + '\n';
}

/* ------------------------------------------------------------------ */
/* uuid → 文件名索引                                                    */
/* ------------------------------------------------------------------ */

interface FileIndex {
  dir: string;
  byId: Map<string, string>;
  byFile: Map<string, string>;
}

let cache: FileIndex | null = null;

function readDocFile(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 目录里已有的 uuid → 文件名。
 * 只扫一层：`.archive` 是子目录，不在 `readdirSync` 的 json 里。
 * 没有 uuid 的老档案不进索引 —— 它们由 `resolveName` 按「标题相同」认领。
 */
function indexOf(dir: string): FileIndex {
  if (cache && cache.dir === dir) return cache;

  const byId = new Map<string, string>();
  const byFile = new Map<string, string>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    /* 目录还不存在：第一次写的时候会 mkdir */
  }
  for (const f of files) {
    const doc = readDocFile(path.join(dir, f));
    const uuid = typeof doc?.uuid === 'string' ? doc.uuid : null;
    if (!uuid) continue;
    byId.set(uuid, f);
    byFile.set(f, uuid);
  }
  cache = { dir, byId, byFile };
  return cache;
}

/**
 * 选一个落在本曲目身上的文件名。
 *
 * 规则（顺序即优先级）：
 * 1. 候选名已经被**自己**占了 → 用它（改名后搬过去也是同一个逻辑）；
 * 2. 候选名被别人占了 → 下一个；
 * 3. 候选名不存在 → 用它；
 * 4. 候选名存在但**没有 uuid**、标题又对得上 → 认领它（老档案，不另建重复文件）。
 */
function resolveName(dir: string, trackId: string, title: string): string {
  const idx = indexOf(dir);
  for (const name of trackFileCandidates(title, trackId)) {
    const owner = idx.byFile.get(name);
    if (owner === trackId) return name;
    if (owner) {
      /**
       * 索引里记着「这个文件名是别人的」，但文件可能已经被外部删掉了
       * （手动清理 data 目录、冒烟的物理删库）。文件不在就当它是空的 ——
       * 否则一次外部删除会让后面所有同名曲目都多出一个没必要的尾号。
       */
      if (fs.existsSync(path.join(dir, name))) continue;
      idx.byFile.delete(name);
      idx.byId.delete(owner);
    }

    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) return name;

    const doc = readDocFile(abs);
    const legacyTitle = String(doc?.title?.original ?? '');
    if (doc && !doc.uuid && legacyTitle === title) return name;
  }
  // 理论上走不到这里（候选里已经有 9 个带尾段的名字）
  return `${trackId}.json`;
}

/* ------------------------------------------------------------------ */
/* 写 / 归档 / 彻底删除                                                 */
/* ------------------------------------------------------------------ */

export interface WriteResult {
  file: string;
  /** true = 这一次新建了文件（用于「补齐」统计） */
  created: boolean;
}

/**
 * 把一首曲目写回 JSON。曲名变了会把旧文件**搬**过去（不是再写一份）。
 * 返回 null 表示这首曲目不存在（已删 / id 不对）。
 */
export function writeTrackJson(ctx: JsonCtx, trackId: string): WriteResult | null {
  const doc = buildTrackDoc(ctx.db, trackId);
  if (!doc) return null;

  const dir = tracksDir(ctx.dataDir);
  fs.mkdirSync(dir, { recursive: true });

  const idx = indexOf(dir);
  const name = resolveName(dir, trackId, doc.title.original);
  const current = idx.byId.get(trackId);
  let created = !fs.existsSync(path.join(dir, name));

  if (current && current !== name) {
    try {
      fs.renameSync(path.join(dir, current), path.join(dir, name));
      idx.byFile.delete(current);
      created = false;
    } catch {
      /**
       * 搬不动（被别的程序占着 / 跨卷）：退回原文件名继续写。
       * 文件名叫什么不影响数据正确性 —— JSON 里的 `title` 才是权威。
       */
      fs.writeFileSync(path.join(dir, current), stringifyTrackDoc(doc), 'utf8');
      idx.byId.set(trackId, current);
      idx.byFile.set(current, trackId);
      return { file: current, created: false };
    }
  }

  fs.writeFileSync(path.join(dir, name), stringifyTrackDoc(doc), 'utf8');
  idx.byId.set(trackId, name);
  idx.byFile.set(name, trackId);
  return { file: name, created };
}

/**
 * 启动补齐：库里有、JSON 里没有的曲目补一份。
 *
 * 为什么每次启动都扫而不是「只补一次」：手改库、导入脚本、崩溃重启都会留下缺口，
 * 而缺口本身**不会报错** —— 只会在下次重建库时悄悄少几首。十几条曲目扫一遍可以忽略。
 */
export function syncMissingTrackJson(ctx: JsonCtx): string[] {
  const dir = tracksDir(ctx.dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const idx = indexOf(dir);

  const rows = ctx.db
    .prepare(`SELECT id, title FROM track WHERE deleted_at IS NULL ORDER BY title_sort`)
    .all() as any[];

  const filled: string[] = [];
  for (const r of rows) {
    if (idx.byId.has(r.id)) continue;
    // 老档案（无 uuid）同名会被认领，所以这里不看文件名，只看「这一首有没有落盘」
    // 老档案（无 uuid）会被认领而不是重建，此时 created=false，不该算进「补齐」
    const res = writeTrackJson(ctx, r.id);
    if (res?.created) filled.push(`${r.title} → ${res.file}`);
  }
  return filled;
}

/** 软删时把 JSON 移进 `.archive`。返回归档后的文件名（没找到文件就返回 null） */
export function archiveTrackJson(ctx: JsonCtx, trackId: string): string | null {
  const dir = tracksDir(ctx.dataDir);
  const idx = indexOf(dir);
  const current = idx.byId.get(trackId);
  if (!current) return null;

  const src = path.join(dir, current);
  if (!fs.existsSync(src)) {
    idx.byId.delete(trackId);
    idx.byFile.delete(current);
    return null;
  }

  /*
   * 归档件带一行 `archivedAt`：`.archive` 里的文件不会再被 seed 读，
   * 多一个字段是安全的，而「什么时候删的」是彻底删除前唯一有用的信息。
   */
  const doc = readDocFile(src) ?? {};
  const stamped = { ...doc, archivedAt: Date.now() };

  const outDir = archiveDir(ctx.dataDir);
  fs.mkdirSync(outDir, { recursive: true });
  let outName = current;
  if (fs.existsSync(path.join(outDir, outName))) {
    outName = current.replace(/\.json$/, ` (${Date.now().toString(36)}).json`);
  }
  fs.writeFileSync(path.join(outDir, outName), stringifyTrackDoc(stamped), 'utf8');
  fs.unlinkSync(src);

  idx.byId.delete(trackId);
  idx.byFile.delete(current);
  return outName;
}

export interface ArchivedTrack {
  uuid: string | null;
  title: string;
  /** 归档时间（毫秒） */
  archivedAt: number;
  file: string;
}

export function listArchived(dataDir: string): ArchivedTrack[] {
  const dir = archiveDir(dataDir);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const out: ArchivedTrack[] = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    const doc = readDocFile(abs);
    let archivedAt = Number(doc?.archivedAt) || 0;
    if (!archivedAt) {
      try {
        archivedAt = Math.round(fs.statSync(abs).mtimeMs);
      } catch {
        archivedAt = 0;
      }
    }
    out.push({
      uuid: typeof doc?.uuid === 'string' ? doc.uuid : null,
      // 老档案没有 uuid 时，文件名就是唯一能显示的东西
      title: String(doc?.title?.original ?? f.replace(/\.json$/, '')),
      archivedAt,
      file: f,
    });
  }
  return out.sort((a, b) => b.archivedAt - a.archivedAt);
}

/**
 * 彻底删除：库里的行 + `.archive` 里的文件。
 *
 * 「彻底」的含义必须两头都清：只删文件，库里那行会永远占着一个标题，
 * 而且下次启动 `syncMissingTrackJson` 还会把它写回来；只删行，归档目录里那份
 * 就成了谁也认不出的垃圾。
 */
export function purgeArchived(ctx: JsonCtx, uuid: string | null): { track: boolean; files: number } {
  let track = false;
  // 级联彻底删除乐章子项（与软删一致），否则归档里会留下认不出的孤儿
  let childFiles = 0;
  if (uuid) {
    const kids = ctx.db.prepare(`SELECT id FROM track WHERE parent_id = ?`).all(uuid) as any[];
    for (const k of kids) childFiles += purgeArchived(ctx, k.id).files;
  }
  if (uuid) {
    const exists = ctx.db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(uuid);
    if (exists) {
      const analysisIds = (
        ctx.db.prepare(`SELECT id FROM analysis WHERE track_id = ?`).all(uuid) as any[]
      ).map((r) => r.id);
      ctx.db.transaction(() => {
        for (const aid of analysisIds) {
          ctx.db.prepare(`DELETE FROM analysis_event WHERE analysis_id = ?`).run(aid);
          ctx.db.prepare(`DELETE FROM analysis_marker WHERE analysis_id = ?`).run(aid);
        }
        ctx.db.prepare(`DELETE FROM analysis WHERE track_id = ?`).run(uuid);
        ctx.db.prepare(`DELETE FROM recording WHERE track_id = ?`).run(uuid);
        ctx.db.prepare(`DELETE FROM track_tag WHERE track_id = ?`).run(uuid);
        ctx.db.prepare(`DELETE FROM track WHERE id = ?`).run(uuid);
      })();
      track = true;
    }
  }

  const dir = archiveDir(ctx.dataDir);
  let files = 0;
  for (const f of listArchived(ctx.dataDir)) {
    // uuid 为 null 的老归档只删「同样没有 uuid」的文件：
    // 否则按一条老记录点一下「彻底删除」，会把整个归档目录清空。
    const match = uuid ? f.uuid === uuid : f.uuid === null;
    if (!match) continue;
    try {
      fs.unlinkSync(path.join(dir, f.file));
      files++;
    } catch {
      /* 已经被删掉了 */
    }
  }
  return { track, files: files + childFiles };
}

/** 清空归档目录（只删文件；库里对应的行早已是软删状态） */
export function purgeAllArchived(ctx: JsonCtx): number {
  const dir = archiveDir(ctx.dataDir);
  let n = 0;
  for (const f of listArchived(ctx.dataDir)) {
    try {
      fs.unlinkSync(path.join(dir, f.file));
      n++;
    } catch {
      /* 已经被删掉了 */
    }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* 反查：分析档案 / 事件 → 曲目                                            */
/* ------------------------------------------------------------------ */

export function trackIdOfAnalysis(db: Database.Database, analysisId: string): string | null {
  const row = db.prepare(`SELECT track_id FROM analysis WHERE id = ?`).get(analysisId) as any;
  return row?.track_id ?? null;
}

export function trackIdOfEvent(db: Database.Database, eventId: string): string | null {
  const row = db
    .prepare(
      `SELECT a.track_id FROM analysis_event e JOIN analysis a ON a.id = e.analysis_id WHERE e.id = ?`
    )
    .get(eventId) as any;
  return row?.track_id ?? null;
}

export function trackIdOfRecording(db: Database.Database, recId: string): string | null {
  const row = db.prepare(`SELECT track_id FROM recording WHERE id = ?`).get(recId) as any;
  return row?.track_id ?? null;
}

/** 测试 / 换数据目录时要能让索引失效，否则会一直认着旧目录的文件名 */
export function resetJsonIndex(): void {
  cache = null;
}
