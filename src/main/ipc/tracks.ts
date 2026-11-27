import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Marker, MarkerKind, MovementRow, RecordingSummary, TrackDetail, TrackPatch, TrackQuery, TrackRow } from '../../shared/types';
import { formatMs } from '../../shared/barbeat.js';
import { expandQuery, splitTerms, TIMELINE_NOTE_LANE_SQL } from '../../shared/search.js';
import { searchTermTables } from '../vocab/terms';
import { coversOf } from './media';
import { setMarkers } from './analysis';
import { defaultRecording, ensureRecordingForTrack, listRecordings, primaryOffset, type Recording } from './recording';
import { archiveTrackJson, writeTrackJson, ARCHIVE_DIR } from '../import/trackjson';
import { analysisIdFor, newTrackId } from '../db/ids';

interface ListCtx {
  db: Database.Database;
  /** 列表要判断「有没有音频」，需要知道 data/audio 在哪；不给就只看 file_path */
  dataDir?: string;
}

const AUDIO_EXT = ['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.aif'];

/**
 * 判断一首曲目能不能直接播。
 *
 * 这里刻意**不**复用 resolveAudio：那个会读 64KB 文件头算时长，
 * 一屏 300 行就是 300 次开文件。列表只要一个是/否。
 */
function hasPlayableAudio(dataDir: string | undefined, title: string, filePath: string | null): boolean {
  try {
    if (filePath && fs.existsSync(filePath)) return true;
    if (!dataDir) return false;
    const safe = String(title ?? '').replace(/[\\/:*?"<>|]/g, '_');
    for (const ext of AUDIO_EXT) {
      if (fs.existsSync(path.join(dataDir, 'audio', safe + ext))) return true;
    }
  } catch {
    /* 路径非法 / 没权限，都当作没有音频 */
  }
  return false;
}

/** 录音那点文件判断，和 hasPlayableAudio 同源但更窄：只看这一个路径 */
function fileUsable(p: string): boolean {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 演奏者列存的是 JSON 数组，也兼容历史上直接写的一个名字 */
function parseNameList(v: unknown): string[] {
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

const BASE_SELECT = `
  SELECT t.id, t.parent_id, t.title, t.title_lang, t.composer, t.performer, t.album, t.album_track_no,
         t.genre, t.period, t.composition_type, t.duration_ms, t.file_path, t.extra, t.updated_at,
         a.meter_num, a.meter_den, a.tempo_value, a.id AS analysis_id
    FROM track t
    LEFT JOIN analysis a ON a.track_id = t.id AND a.deleted_at IS NULL
`;

/**
 * 一批母作品的乐章子项，按 parent_id 分组。
 * 列表与详情共用：详情里也要有 movements，否则 TrackDetail 与 TrackRow 的字段对不上。
 */
function movementRowsOf(
  db: Database.Database,
  dataDir: string | undefined,
  parentIds: string[]
): Map<string, MovementRow[]> {
  const out = new Map<string, MovementRow[]>();
  if (!parentIds.length) return out;
  const keyList = db.prepare(
    `SELECT key_name FROM analysis_marker WHERE analysis_id = ? AND kind = 'key' ORDER BY tick`
  );
  const rows = db
    .prepare(
      `SELECT t.id, t.parent_id, t.title, t.title_lang, t.genre, t.period, t.composition_type,
              t.file_path, t.extra,
              a.meter_num, a.meter_den, a.tempo_value, a.id AS analysis_id
         FROM track t
         LEFT JOIN analysis a ON a.track_id = t.id AND a.deleted_at IS NULL
        WHERE t.parent_id IN (${parentIds.map(() => '?').join(',')}) AND t.deleted_at IS NULL
        ORDER BY t.added_at, t.seq`
    )
    .all(...parentIds) as any[];
  for (const m of rows) {
    let mex: any = {};
    try {
      mex = m.extra ? JSON.parse(m.extra) : {};
    } catch {
      mex = {};
    }
    const keys = m.analysis_id ? (keyList.all(m.analysis_id) as any[]).map((k) => k.key_name) : [];
    const list = out.get(m.parent_id) ?? [];
    list.push({
      id: m.id,
      parentId: m.parent_id ?? null,
      title: m.title,
      titleLang: m.title_lang,
      aliases: Array.isArray(mex?.aliases) ? mex.aliases : [],
      meter: m.meter_num ? `${m.meter_num}/${m.meter_den}` : null,
      bpm: m.tempo_value,
      keys,
      hasAudio: hasPlayableAudio(dataDir, m.title, m.file_path),
      neteaseUrl: mex?.links?.netease ?? null,
      period: m.period,
      genre: m.genre,
      compositionType: m.composition_type ?? null,
      // subForm 是旧键：迁移前写下的档案也认，读出来统一成 subType
      subType: mex?.subType ?? mex?.subForm ?? null,
      tempoTerm: mex?.tempoTerm ?? null,
    });
    out.set(m.parent_id, list);
  }
  return out;
}

export function listTracks({ db, dataDir }: ListCtx, q: TrackQuery = {}): TrackRow[] {
  // 顶层只列作品与独立曲目；乐章子项（parent_id 非空）挂在母作品的 movements 里做嵌套子行
  const where: string[] = ['t.deleted_at IS NULL', 't.parent_id IS NULL'];
  const params: Record<string, unknown> = {};

  const text = (q.text ?? '').trim();
  /**
   * 流派 / 情绪的词表要先取出来：中文「爵士」「怀旧」要翻成库里的值才比得上，
   * 而且分词时「Chamber Music」这种带空格的流派名不能被拆开。
   */
  const tables = searchTermTables(db);
  const terms = splitTerms(text, tables);
  if (terms.length) {
    /**
     * 每个词一组条件，组内 OR（命中任意字段就算），组间 AND（每个词都得有着落）。
     * 「钢片琴 低音提琴」因此能搜到同时带这两个乐器的曲目；
     * 「神 低音」也能命中「神鹿谣」（曲名）+「低音提琴」（标签）。
     */
    const groups = terms.map((term, i) => {
      const clauses: string[] = [];
      params[`like${i}`] = `%${term}%`;
      clauses.push(
        `t.title LIKE @like${i}`,
        `IFNULL(t.composer, '') LIKE @like${i}`,
        `IFNULL(t.performer, '') LIKE @like${i}`,
        `IFNULL(t.album, '') LIKE @like${i}`,
        `IFNULL(t.notes, '') LIKE @like${i}`,
        // 时期是 track 的一列，但存的是英文规范值；中文要靠下面的 expandQuery 翻
        `IFNULL(t.period, '') LIKE @like${i}`,
        `IFNULL(t.genre, '') LIKE @like${i}`,
        // 标签本身也算命中：乐器、技法、调性、时期标签名与别名
        `t.id IN (
           SELECT tt.track_id FROM track_tag tt
             JOIN tag g ON g.id = tt.tag_id
             LEFT JOIN tag_alias al ON al.tag_id = g.id
            WHERE g.name LIKE @like${i}
               OR IFNULL(g.display, '') LIKE @like${i}
               OR IFNULL(al.alias, '') LIKE @like${i})`,
        // 调性存在 analysis_marker（key_name = "c natural minor"），不在 track 表上
        `t.id IN (
           SELECT a.track_id FROM analysis a
             JOIN analysis_marker m ON m.analysis_id = a.id
            WHERE a.deleted_at IS NULL AND m.kind = 'key' AND m.key_name LIKE @like${i})`,
        // extra 是个 JSON（别名 / 副标题 / 制作名单 / 情绪 / 备注）。
        // 用 json_tree 只取 type='text' 的值：这样「成人法则」这类别名能搜到，
        // 而 "moods"、"source" 这些**键名**不会变成命中词（否则搜 source 会全中）。
        `EXISTS (SELECT 1 FROM json_tree(t.extra) jt
                  WHERE jt.type = 'text' AND jt.value LIKE @like${i})`
      );
      /**
       * 时间线面板的「备注」行（lane = note / *-note）。
       * 存在 analysis_event 里，不在 track 表上，所以曲名那几列的 LIKE 够不着。
       * 乐章是子曲目：备注写在乐章时间线上时，命中算到母作品（列表只列母作品）。
       * 低音行不在这里 —— 见 isTimelineNoteLane。取消勾选时整段不加入。
       */
      if (q.includeTimelineNotes !== false) {
        clauses.push(
          `EXISTS (
             SELECT 1
               FROM track owner
               JOIN analysis a ON a.track_id = owner.id AND a.deleted_at IS NULL
               JOIN analysis_event e ON e.analysis_id = a.id
              WHERE owner.deleted_at IS NULL
                AND (owner.id = t.id OR owner.parent_id = t.id)
                AND ${TIMELINE_NOTE_LANE_SQL}
                AND IFNULL(e.text, '') LIKE @like${i})`
        );
      }

      // 西文长词走 FTS（中文两字词 LIKE 才是正解，所以两条并存取并集）
      if (term.length >= 3) {
        params[`fts${i}`] = `"${term.replace(/"/g, '""')}"*`;
        clauses.push(`t.seq IN (SELECT rowid FROM track_fts WHERE track_fts MATCH @fts${i})`);
      }

      // 中文 → 规范值：古典主义 → classical，自然小调 → natural minor，
      // 怀旧 → nostalgic，爵士 → Jazz。
      // 必须**按词**展开并放进本组：整句展开再 OR 到最外层的话，
      // 「浪漫 钢琴」会把所有浪漫主义曲目都捞进来，钢琴这个条件等于失效。
      const { periods, keyModes, moods, genres, compositionTypes, forms } = expandQuery(term, tables) as {
        periods: string[];
        keyModes: string[];
        moods: string[];
        genres: string[];
        compositionTypes: string[];
        forms: string[];
      };
      if (periods.length) {
        const marks = periods.map((_, k) => `@pd${i}_${k}`).join(',');
        periods.forEach((id, k) => (params[`pd${i}_${k}`] = id));
        clauses.push(`t.period IN (${marks})`);
      }
      if (keyModes.length) {
        const ors = keyModes.map((_, k) => `m2.key_name LIKE @km${i}_${k}`).join(' OR ');
        keyModes.forEach((mode, k) => (params[`km${i}_${k}`] = `%${mode}%`));
        clauses.push(
          `t.id IN (SELECT a2.track_id FROM analysis a2
                      JOIN analysis_marker m2 ON m2.analysis_id = a2.id
                     WHERE a2.deleted_at IS NULL AND m2.kind = 'key' AND (${ors}))`
        );
      }
      // 情绪是 extra.moods 数组里的英文枚举：中文词（怀旧）必须先翻成
      // nostalgic 才比得上。用 json_each 只比数组元素，不碰别的字段。
      if (moods.length) {
        const marks = moods.map((_, k) => `@md${i}_${k}`).join(',');
        moods.forEach((id, k) => (params[`md${i}_${k}`] = id));
        clauses.push(
          `EXISTS (SELECT 1 FROM json_each(t.extra, '$.moods') je WHERE je.value IN (${marks}))`
        );
      }
      // 流派存的是一条条词条的 name（Jazz / Folk / Chamber Music）：
      // 中文「爵士」翻成 Jazz 之后要按值比，不能再 LIKE（会顺带命中作曲家的自述）。
      if (genres.length) {
        const marks = genres.map((_, k) => `@gn${i}_${k}`).join(',');
        genres.forEach((name, k) => (params[`gn${i}_${k}`] = String(name).toLowerCase()));
        clauses.push(`LOWER(IFNULL(t.genre, '')) IN (${marks})`);
      }
      // 体裁 / 曲式同理，但存的是词表 id（symphony / sonata），
      // 所以「室内乐」「弦乐四重奏」这些中文要靠展开后的 id 去比。
      if (compositionTypes.length) {
        const marks = compositionTypes.map((_, k) => `@ct${i}_${k}`).join(',');
        compositionTypes.forEach((id, k) => (params[`ct${i}_${k}`] = String(id).toLowerCase()));
        clauses.push(`LOWER(IFNULL(t.composition_type, '')) IN (${marks})`);
      }
      if (forms.length) {
        const marks = forms.map((_, k) => `@fm${i}_${k}`).join(',');
        forms.forEach((id, k) => (params[`fm${i}_${k}`] = String(id).toLowerCase()));
        clauses.push(`LOWER(IFNULL(t.form, '')) IN (${marks})`);
      }

      return `(${clauses.join(' OR ')})`;
    });

    where.push(`(${groups.join(' AND ')})`);
  }

  const tagIds = (q.tags ?? []).map((t) => t.id).filter(Boolean);
  if (tagIds.length) {
    const marks = tagIds.map((_, i) => `@tag${i}`).join(',');
    tagIds.forEach((id, i) => (params[`tag${i}`] = id));
    where.push(
      `t.id IN (SELECT track_id FROM track_tag WHERE tag_id IN (${marks})
               GROUP BY track_id HAVING COUNT(DISTINCT tag_id) = ${tagIds.length})`
    );
  }

  const limit = Math.min(q.limit ?? 300, 1000);
  const rows = db
    .prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.title_sort LIMIT ${limit} OFFSET ${q.offset ?? 0}`)
    .all(params) as any[];

  const countSection = db.prepare(
    `SELECT COUNT(*) AS c FROM analysis_marker WHERE analysis_id = ? AND kind = 'section'`
  );
  const countTags = db.prepare(`SELECT COUNT(*) AS c FROM track_tag WHERE track_id = ?`);
  const keyList = db.prepare(
    `SELECT key_name FROM analysis_marker WHERE analysis_id = ? AND kind = 'key' ORDER BY tick`
  );

  /**
   * 录音版本：一次查完本页所有曲目的版本，再在内存里按 track_id 分组。
   * 逐行查是 N+1（列表一次 300 行就是 300 次查询），而这种数据量一次 IN 完全够。
   */
  const recByTrack = new Map<string, RecordingSummary[]>();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const recRows = db
      .prepare(
        `SELECT r.id, r.track_id, r.label, r.catalog_no, r.conductor, r.performers, r.file_path, r.link,
                r.is_default, r.duration_ms, r.format,
                (SELECT COUNT(*) FROM recording c
                  WHERE c.parent_id = r.id AND c.deleted_at IS NULL) AS variant_count,
                (SELECT c.file_path FROM recording c
                  WHERE c.parent_id = r.id AND c.deleted_at IS NULL AND c.file_path IS NOT NULL
                  ORDER BY c.seq_order, c.seq LIMIT 1) AS variant_path,
                (SELECT c.format FROM recording c
                  WHERE c.parent_id = r.id AND c.deleted_at IS NULL AND c.file_path IS NOT NULL
                  ORDER BY c.seq_order, c.seq LIMIT 1) AS variant_format,
                (SELECT c.duration_ms FROM recording c
                  WHERE c.parent_id = r.id AND c.deleted_at IS NULL AND c.file_path IS NOT NULL
                  ORDER BY c.seq_order, c.seq LIMIT 1) AS variant_duration
           FROM recording r
          WHERE r.track_id IN (${ids.map(() => '?').join(',')}) AND r.deleted_at IS NULL
                AND r.parent_id IS NULL
          ORDER BY r.seq_order, r.seq`
      )
      .all(...ids) as any[];
    for (const r of recRows) {
      const list = recByTrack.get(r.track_id) ?? [];
      const filePath = r.file_path || r.variant_path || '';
      list.push({
        id: r.id,
        label: r.label ?? '',
        catalogNo: r.catalog_no ?? '',
        conductor: r.conductor ?? '',
        performers: parseNameList(r.performers),
        filePath,
        link: r.link ?? '',
        isDefault: r.is_default === 1,
        durationMs: r.duration_ms || r.variant_duration || 0,
        format: r.format ?? r.variant_format ?? null,
        fileExists: !!filePath && fileUsable(filePath),
        variantCount: Number(r.variant_count) || 0,
      });
      recByTrack.set(r.track_id, list);
    }
  }

  /**
   * 乐章子项：一次查完本页所有作品的乐章，按 parent_id 分组挂回去（与录音版本同一套批量思路）。
   * 轻量行只取列表显示要的字段；选中后渲染层走 getTrack 取全量。
   */
  const movByParent = movementRowsOf(db, dataDir, rows.map((r) => r.id));

  return rows.map((r) => {
    const keys = r.analysis_id ? (keyList.all(r.analysis_id) as any[]).map((k) => k.key_name) : [];
    let extra: any = {};
    try {
      extra = r.extra ? JSON.parse(r.extra) : {};
    } catch {
      extra = {};
    }
    const netease = extra?.links?.netease ?? null;
    return {
      id: r.id,
      parentId: r.parent_id ?? null,
      title: r.title,
      titleLang: r.title_lang,
      // 列表也要别名：外文曲名旁边那句灰色译名是从这里挑的（见 shared/lang.js）
      aliases: Array.isArray(extra?.aliases) ? extra.aliases : [],
      composer: r.composer,
      performer: r.performer,
      album: r.album,
      albumTrackNo: r.album_track_no ?? null,
      genre: r.genre,
      period: r.period,
      compositionType: r.composition_type ?? null,
      formNumber: extra?.formNumber ?? null,
      opusNumber: extra?.opusNumber ?? null,
      subType: extra?.subType ?? extra?.subForm ?? null,
      tempoTerm: extra?.tempoTerm ?? null,
      durationMs: r.duration_ms,
      filePath: r.file_path,
      meter: r.meter_num ? `${r.meter_num}/${r.meter_den}` : null,
      bpm: r.tempo_value,
      sectionCount: r.analysis_id ? (countSection.get(r.analysis_id) as any).c : 0,
      tagCount: (countTags.get(r.id) as any).c,
      keys,
      hasAudio: hasPlayableAudio(dataDir, r.title, r.file_path),
      neteaseUrl: netease,
      recordingVersions: recByTrack.get(r.id) ?? [],
      movements: movByParent.get(r.id) ?? [],
      updatedAt: r.updated_at,
    } satisfies TrackRow;
  });
}

export function getTrack({ db, dataDir }: ListCtx, id: string): TrackDetail | null {
  const row = db.prepare(`SELECT * FROM track WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
  if (!row) return null;

  /**
   * 录音制品：老档案只有 track.file_path 时按文件头补一条，
   * 否则「明明绑了音频、详情面板却一个版本都不列」。
   * ensure 是写操作，所以只在真的需要补时才落库。
   */
  let recCtx: { db: Database.Database; dataDir: string };
  let recordings: Recording[] = [];
  if (dataDir) {
    recCtx = { db, dataDir };
    recordings = listRecordings(recCtx, id);
    if (!recordings.length && row.file_path) {
      const made = ensureRecordingForTrack(recCtx, id);
      if (made) recordings = listRecordings(recCtx, id);
    }
  }
  const current = recordings.length ? defaultRecording(recCtx!, id) : null;
  // 录音清单里每条都要能直接播：把协议地址填上（主录音那条仍用作品级地址）
  recordings = recordings.map((r) => ({ ...r, url: r.isDefault ? `ma-audio://audio/${encodeURIComponent(id)}` : r.recUrl }));

  const tags = db
    .prepare(
      `SELECT g.id, g.dim, COALESCE(g.display, g.name) AS display, g.name, tt.weight
         FROM track_tag tt JOIN tag g ON g.id = tt.tag_id
        WHERE tt.track_id = ? ORDER BY g.dim, g.name`
    )
    .all(id) as any[];

  const analysisRow = db
    .prepare(`SELECT * FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(id) as any;

  const extra = row.extra ? JSON.parse(row.extra) : {};

  return {
    id: row.id,
    parentId: row.parent_id ?? null,
    title: row.title,
    titleLang: row.title_lang,
    composer: row.composer,
    performer: row.performer,
    album: row.album,
    albumTrackNo: row.album_track_no ?? null,
    genre: row.genre,
    /** 体裁 / 曲式：词表 id。显示名由渲染层按 data/vocab 翻 */
    compositionType: row.composition_type ?? null,
    formNumber: extra.formNumber ?? null,
    opusNumber: extra.opusNumber ?? null,
    subType: extra.subType ?? extra.subForm ?? null,
    tempoTerm: extra.tempoTerm ?? null,
    form: row.form ?? null,
    period: row.period,
    durationMs: row.duration_ms,
    filePath: row.file_path,
    meter: analysisRow?.meter_num && analysisRow?.meter_den
      ? `${analysisRow.meter_num}/${analysisRow.meter_den}`
      : null,
    bpm: analysisRow?.tempo_value ?? null,
    sectionCount: analysisRow
      ? (db.prepare(`SELECT COUNT(*) AS c FROM analysis_marker WHERE analysis_id = ? AND kind='section'`).get(analysisRow.id) as any).c
      : 0,
    tagCount: tags.length,
    keys: analysisRow
      ? (db.prepare(`SELECT key_name FROM analysis_marker WHERE analysis_id=? AND kind='key' ORDER BY tick`).all(analysisRow.id) as any[]).map((k) => k.key_name)
      : [],
    hasAudio: hasPlayableAudio(dataDir, row.title, row.file_path),
    neteaseUrl: extra?.links?.netease ?? null,
    recordingVersions: recordings.map((r) => {
      const variants = Array.isArray(r.variants) ? r.variants : [];
      const withFile = [r, ...variants].find((x) => x.fileExists);
      return {
        id: r.id,
        label: r.label,
        catalogNo: r.catalogNo,
        conductor: r.conductor,
        performers: r.performers,
        filePath: withFile?.filePath ?? r.filePath,
        link: r.link,
        isDefault: r.isDefault,
        durationMs: withFile?.durationMs || r.durationMs,
        format: withFile?.format ?? r.format,
        fileExists: !!withFile,
        variantCount: variants.length,
      };
    }),
    movements: movementRowsOf(db, dataDir, [row.id]).get(row.id) ?? [],
    updatedAt: row.updated_at,
    notes: row.notes,
    description: extra.description ?? null,
    subtitle: extra.subtitle ?? null,
    aliases: extra.aliases ?? [],
    instrumentationAbstract: extra.instrumentationAbstract ?? null,
    credits: extra.credits ?? null,
    links: extra.links ?? null,
    moods: extra.moods ?? [],
    covers: coversOf({ db, dataDir: dataDir ?? '' }, id),
    /** 同一部作品的所有录音版本（默认版本排最前） */
    recordings,
    /** 当前实际播放的那条录音：演奏家、乐团、指挥、混音母带都在这儿 */
    currentRecording: current,
    lyricsFile: extra.lyrics ?? null,
    instrumental: extra.instrumental === true,
    tags: tags.map((t) => ({ id: t.id, dim: t.dim, name: t.name, display: t.display, weight: t.weight })),
    analysis: analysisRow ? readAnalysis(db, analysisRow) : null,
  };
}

function readAnalysis(db: Database.Database, a: any): TrackDetail['analysis'] {
  const markers = db
    .prepare(`SELECT * FROM analysis_marker WHERE analysis_id = ? ORDER BY tick, sort_order`)
    .all(a.id) as any[];
  const events = db
    .prepare(`SELECT * FROM analysis_event WHERE analysis_id = ? ORDER BY tick`)
    .all(a.id) as any[];

  return {
    id: a.id,
    trackId: a.track_id,
    title: a.title,
    ppq: a.ppq,
    tempoValue: a.tempo_value,
    tempoUnit: a.tempo_unit,
    meterNum: a.meter_num,
    meterDen: a.meter_den,
    meterNote: a.meter_note,
    /** 同 getAnalysis：报主录音那一份偏移，试听别的版本时由渲染层覆盖 */
    audioOffsetMs: primaryOffset({ db }, a.track_id) ?? a.audio_offset_ms,
    viewId: a.view_id,
    markers: markers.map((m) => ({
      id: m.id,
      kind: m.kind,
      tick: m.tick,
      label: m.label,
      num: m.num,
      den: m.den,
      bpm: m.bpm,
      keyName: m.key_name,
      startBar: m.start_bar,
      confidence: m.confidence,
      note: m.note,
    })),
    events: events.map((e) => ({
      id: e.id,
      lane: e.lane,
      tick: e.tick,
      durTicks: e.dur_ticks,
      text: e.text,
      confidence: e.confidence,
      parsed: e.parsed ? JSON.parse(e.parsed) : null,
    })),
  };
}

export function upsertTrack({ db }: ListCtx, patch: Record<string, unknown>): string {
  const id = (patch.id as string) || newTrackId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO track (id, title, title_lang, title_sort, composer, performer, album, genre, period,
                       duration_ms, file_path, file_hash, notes, extra, added_at, updated_at)
    VALUES (@id, @title, @titleLang, @titleSort, @composer, @performer, @album, @genre, @period,
            @durationMs, @filePath, NULL, @notes, @extra, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, title_lang = excluded.title_lang, title_sort = excluded.title_sort,
      composer = excluded.composer, performer = excluded.performer, album = excluded.album,
      genre = excluded.genre, period = excluded.period, duration_ms = excluded.duration_ms,
      file_path = excluded.file_path, notes = excluded.notes, updated_at = excluded.updated_at
  `).run({
    id,
    title: patch.title ?? '未命名',
    titleLang: patch.titleLang ?? null,
    titleSort: String(patch.title ?? '').toLowerCase(),
    composer: patch.composer ?? null,
    performer: patch.performer ?? null,
    album: patch.album ?? null,
    genre: patch.genre ?? null,
    period: patch.period ?? null,
    durationMs: patch.durationMs ?? null,
    filePath: patch.filePath ?? null,
    notes: patch.notes ?? null,
    extra: JSON.stringify({}),
    now,
  });
  return id;
}

/**
 * 登记作品：建一条空曲目 + 一份空分析档案。
 *
 * 分析档案必须一起建 —— 网格编辑器是挂在 analysis 上的，只有 track 没有档案时，
 * 下方面板会一直显示「这首曲目还没有分析档案」。4/4 与一条 tick 0 的拍号 marker
 * 是换算的锚（`tickToBarBeat` 没有拍号就没办法算小节），所以先给个默认值。
 */
export function createTrack(
  { db }: ListCtx,
  patch: { title?: string; parentId?: string } = {}
): { id: string; analysisId: string; title: string } {
  const now = Date.now();
  /**
   * 曲目 id = JSON 里的 `uuid` = `track` 的主键，撞了这条登记就直接失败。
   *
   * 生成器本身已经是「毫秒时间 + 10 位强随机」，理论上撞不上；这里再查一次库，
   * 是因为批量导入 / 并发登记真的会在同一毫秒里排队，而失败的表现是用户点完没反应。
   * 重试 8 次足够 —— 真撞 8 次说明随机源坏了，抛错比悄悄复用别人的 id 好。
   */
  let id = '';
  for (let i = 0; i < 8 && !id; i++) {
    const cand = newTrackId();
    if (!db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(cand)) id = cand;
  }
  if (!id) throw new Error('无法生成唯一的曲目 id（随机源异常？）');
  // 档案 id 由曲目 id 推导（`tr-a-b` ↔ `an-a-b`），seed 与这里必须同一套规则
  const analysisId = analysisIdFor(id);
  const title = String(patch.title ?? '').trim() || '未命名作品';
  // 乐章子项：母作品必须真实存在、且自己不是乐章（只做一层），否则当独立作品（防悬空 / 嵌套）
  const parentRow =
    patch.parentId &&
    (db.prepare(`SELECT parent_id FROM track WHERE id = ? AND deleted_at IS NULL`).get(patch.parentId) as any);
  const parentId = patch.parentId && parentRow && parentRow.parent_id == null ? patch.parentId : null;

  db.transaction(() => {
    db.prepare(`
      INSERT INTO track (id, parent_id, title, title_lang, title_sort, composer, performer, album, genre, period,
                         duration_ms, file_path, file_hash, notes, extra, added_at, updated_at)
      VALUES (@id, @parentId, @title, NULL, @titleSort, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL, @extra, @now, @now)
    `).run({ id, parentId, title, titleSort: title.toLowerCase(), extra: JSON.stringify({ source: 'manual' }), now });

    /**
     * 拍号 / 速度一律留空：新建 = 还没量过，不是「4/4 · 120」。
     * 渲染层在没有 marker 时本来就会按 4/4 · 120 画网格、给播放条读数，
     * 所以空值不影响使用；写死默认值反而会让「没标注」永远不可见。
     */
    db.prepare(`
      INSERT INTO analysis (id, track_id, title, ppq, tempo_value, tempo_unit, meter_num, meter_den,
                            meter_note, audio_offset_ms, view_id, author, created_at, updated_at)
      VALUES (@id, @trackId, @title, 480, NULL, NULL, NULL, NULL, NULL, 0, 'roman', 'manual', @now, @now)
    `).run({ id: analysisId, trackId: id, title, now });
  })();

  return { id, analysisId, title };
}

/** 改曲名（右键曲名区域用）。title_sort 跟着变，否则列表排序会和显示对不上 */
export function renameTrack({ db }: ListCtx, id: string, title: string): { id: string; title: string } | null {
  const next = String(title ?? '').trim();
  if (!next) return null;
  const now = Date.now();
  const row = db.prepare(`SELECT id FROM track WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
  if (!row) return null;
  db.prepare(`UPDATE track SET title = ?, title_sort = ?, updated_at = ? WHERE id = ?`).run(
    next,
    next.toLowerCase(),
    now,
    id
  );
  // analysis.title 只是冗余副本，不同步就会在别处显示旧名字
  db.prepare(`UPDATE analysis SET title = ?, updated_at = ? WHERE track_id = ?`).run(next, now, id);
  return { id, title: next };
}

/** 详情面板就地编辑：只碰 track / extra / tick 0 的拍号与速度 / 整条调性链 */

/** 去空、去重（忽略大小写），顺序保留 */
function cleanList(v: unknown, lower = false): string[] {
  const arr = Array.isArray(v) ? v : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    const key = lower ? s.toLowerCase() : s;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function readMarkers(db: Database.Database, analysisId: string, kind: MarkerKind): Marker[] {
  return (
    db
      .prepare(`SELECT * FROM analysis_marker WHERE analysis_id = ? AND kind = ? ORDER BY tick, sort_order`)
      .all(analysisId, kind) as any[]
  ).map((m) => ({
    id: m.id,
    kind: m.kind,
    tick: m.tick,
    label: m.label,
    num: m.num,
    den: m.den,
    bpm: m.bpm,
    keyName: m.key_name,
    startBar: m.start_bar,
    confidence: m.confidence,
    note: m.note,
  }));
}

export function updateTrack({ db, dataDir }: ListCtx, id: string, patch: TrackPatch): TrackDetail | null {
  const row = db.prepare(`SELECT * FROM track WHERE id = ? AND deleted_at IS NULL`).get(id) as any;
  if (!row) return null;
  const analysisRow = db
    .prepare(`SELECT * FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(id) as any;
  const now = Date.now();
  const p = patch ?? {};

  const run = db.transaction(() => {
    /* ---- 曲名：title_sort 与 analysis.title 都是冗余副本，必须一起改 ---- */
    if (typeof p.title === 'string') {
      const next = p.title.trim();
      if (next && next !== row.title) {
        db.prepare(`UPDATE track SET title = ?, title_sort = ?, updated_at = ? WHERE id = ?`).run(
          next,
          next.toLowerCase(),
          now,
          id
        );
        if (analysisRow) {
          db.prepare(`UPDATE analysis SET title = ?, updated_at = ? WHERE id = ?`).run(next, now, analysisRow.id);
        }
      }
    }

    /* ---- 专辑：track 的一列，自由文本（不进词表：专辑名是作品，不是分类） ---- */
    if (p.album !== undefined) {
      const next = String(p.album ?? '').trim() || null;
      if (next !== row.album) {
        db.prepare(`UPDATE track SET album = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
      }
    }

    /* ---- 专辑序号：这张专辑里第几首。非正数一律按「没写」处理 ---- */
    if (p.albumTrackNo !== undefined) {
      const raw = p.albumTrackNo === null || p.albumTrackNo === undefined ? NaN : Number(p.albumTrackNo);
      const next = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
      if (next !== (row.album_track_no ?? null)) {
        db.prepare(`UPDATE track SET album_track_no = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
      }
    }

    /* ---- period 是 track 的一列，存的必须是规范值 ---- */
    if (p.period !== undefined) {
      const next = String(p.period ?? '').trim() || null;
      if (next !== row.period) {
        db.prepare(`UPDATE track SET period = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
      }
    }

    /* ---- genre 也是 track 的一列，但存的是词条的 name（Jazz / Chamber Music）----
     * 与 period 存 id 不同：流派是一张会长大的词表，历史档案里本来写的就是英文名，
     * 存 name 才不会让「Jazz」这类已有数据在迁移后对不上。 */
    if (p.genre !== undefined) {
      const next = String(p.genre ?? '').trim() || null;
      if (next !== row.genre) {
        db.prepare(`UPDATE track SET genre = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
      }
    }

    /* ---- 体裁 / 曲式：存词表 id（symphony / sonata），不是显示名 ----
     * 与 genre 存 name 不同：这两张表是新立的，没有历史包袱，
     * 存 id 才能让显示名跟着界面语言走。 */
    if (p.compositionType !== undefined) {
      const next = String(p.compositionType ?? '').trim() || null;
      if (next !== (row.composition_type ?? null)) {
        db.prepare(`UPDATE track SET composition_type = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
      }
    }
    if (p.form !== undefined) {
      const next = String(p.form ?? '').trim() || null;
      if (next !== (row.form ?? null)) {
        db.prepare(`UPDATE track SET form = ?, updated_at = ? WHERE id = ?`).run(next, now, id);
      }
    }

    /* ---- extra：副标题 / 别名 / 情绪 / 制作名单 / 编制摘要 ----
     * 整份 JSON 读出来改再写回。空值删键而不是留 null ——
     * 搜索用 json_tree 遍历文本值，留一堆空串只会让它多做无用功。 */
    let extra: any = {};
    try {
      extra = row.extra ? JSON.parse(row.extra) : {};
    } catch {
      extra = {};
    }
    let extraTouched = false;
    const put = (key: string, value: unknown) => {
      const empty =
        value == null ||
        (typeof value === 'string' && !value.trim()) ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && !Array.isArray(value) && value && !Object.keys(value).length);
      if (empty) {
        if (key in extra) {
          delete extra[key];
          extraTouched = true;
        }
      } else {
        extra[key] = value;
        extraTouched = true;
      }
    };

    if (p.subtitle !== undefined) put('subtitle', String(p.subtitle ?? '').trim());
    if (p.formNumber !== undefined) put('formNumber', String(p.formNumber ?? '').trim());
    if (p.opusNumber !== undefined) put('opusNumber', String(p.opusNumber ?? '').trim());
    if (p.subType !== undefined) {
      put('subType', String(p.subType ?? '').trim());
      // 旧键在迁移前的档案里可能还在；写新值就顺手清掉，避免两份真相
      if ('subForm' in extra) {
        delete extra.subForm;
        extraTouched = true;
      }
    }
    if (p.tempoTerm !== undefined) put('tempoTerm', String(p.tempoTerm ?? '').trim());
    if (p.instrumentationAbstract !== undefined) {
      put('instrumentationAbstract', String(p.instrumentationAbstract ?? '').trim());
    }
    if (p.aliases !== undefined) put('aliases', cleanList(p.aliases));
    // 情绪是英文枚举：统一小写，中文写得先由渲染层翻好（MOODS）
    if (p.moods !== undefined) put('moods', cleanList(p.moods, true));
    if (p.credits !== undefined) {
      const credits: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.credits ?? {})) {
        const s = String(v ?? '').trim();
        if (s) credits[k] = s;
      }
      put('credits', credits);
      // composer 同时是 track 的一列（列表排序 / 搜索 / 标题模板都直接读它）。
      // 详情里改的是 credits.composer，只在**这次确实提交了 composer** 时同步，
      // 改作词 / 编曲不能把导入时那一列顺手清空。
      if (Object.prototype.hasOwnProperty.call(p.credits ?? {}, 'composer')) {
        const composer = String((p.credits as any)?.composer ?? '').trim() || null;
        if (composer !== row.composer) {
          db.prepare(`UPDATE track SET composer = ?, updated_at = ? WHERE id = ?`).run(composer, now, id);
        }
      }
    }
    if (extraTouched) {
      db.prepare(`UPDATE track SET extra = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(extra), now, id);
    }

    /* ---- 拍号 / 速度 / 调性：都落在 analysis_marker 上 ----
     * 详情里改的是「这首曲子的主拍号 / 主速度」，也就是 tick 0 那一条；
     * 中途变拍、变速仍然属于网格编辑的范畴，不在这里动。
     * 复用 setMarkers 而不是手写 UPDATE：它负责重算 start_bar，
     * 只改 num/den 而不管 start_bar 会让时间轴错位。 */
    if (!analysisRow) {
      db.prepare(`UPDATE track SET updated_at = ? WHERE id = ?`).run(now, id);
      return;
    }

    const ppq = Number(analysisRow.ppq) || 480;
    const meterNum = Number(analysisRow.meter_num) || 4;
    const meterDen = Number(analysisRow.meter_den) || 4;

    if (p.meter !== undefined) {
      if (p.meter === null) {
        // 清除 = 回到「未标注」。只撤 tick 0 那条主拍号，中途变拍仍留在网格上。
        db.prepare(`UPDATE analysis SET meter_num = NULL, meter_den = NULL, updated_at = ? WHERE id = ?`).run(
          now,
          analysisRow.id
        );
        const marks = readMarkers(db, analysisRow.id, 'meter').filter((m) => m.tick !== 0);
        setMarkers({ db }, analysisRow.id, 'meter', marks);
      } else {
        const num = Math.round(Number(p.meter.num));
        const den = Math.round(Number(p.meter.den));
        if (num > 0 && num <= 64 && den > 0 && den <= 64) {
          db.prepare(`UPDATE analysis SET meter_num = ?, meter_den = ?, updated_at = ? WHERE id = ?`).run(
            num,
            den,
            now,
            analysisRow.id
          );
          const marks = readMarkers(db, analysisRow.id, 'meter');
          const at0 = marks.find((m) => m.tick === 0);
          if (at0) {
            at0.num = num;
            at0.den = den;
            at0.label = `${num}/${den}`;
          } else {
            marks.unshift({
              id: `${analysisRow.id}:meter:0`,
              kind: 'meter',
              tick: 0,
              label: `${num}/${den}`,
              num,
              den,
              bpm: null,
              keyName: null,
              startBar: null,
              confidence: 'confirmed',
              note: null,
            });
          }
          setMarkers({ db }, analysisRow.id, 'meter', marks);
        }
      }
    }

    if (p.bpm !== undefined) {
      if (p.bpm === null) {
        // 同拍号：清掉全局速度与 tick 0 那条；中途变速保留
        db.prepare(`UPDATE analysis SET tempo_value = NULL, updated_at = ? WHERE id = ?`).run(now, analysisRow.id);
        const marks = readMarkers(db, analysisRow.id, 'tempo').filter((m) => m.tick !== 0);
        setMarkers({ db }, analysisRow.id, 'tempo', marks);
      } else {
        const bpm = Number(p.bpm);
        if (Number.isFinite(bpm) && bpm > 0 && bpm < 1000) {
          db.prepare(`UPDATE analysis SET tempo_value = ?, updated_at = ? WHERE id = ?`).run(bpm, now, analysisRow.id);
          const marks = readMarkers(db, analysisRow.id, 'tempo');
          const at0 = marks.find((m) => m.tick === 0);
          if (at0) at0.bpm = bpm;
          else {
            marks.unshift({
              id: `${analysisRow.id}:tempo:0`,
              kind: 'tempo',
              tick: 0,
              label: null,
              num: null,
              den: null,
              bpm,
              keyName: null,
              startBar: null,
              confidence: 'confirmed',
              note: null,
            });
          }
          setMarkers({ db }, analysisRow.id, 'tempo', marks);
        }
      }
    }

    /* 调性链：逐个写回已有的 key marker —— **tick 不动**。
     * 详情里改调性是「这条写错了」，不是「这里换调了」，
     * 跟着改 tick 会把时间轴上的转调位置也挪走。
     * 条数变多时按小节往后追加，变少时截掉尾巴。 */
    if (p.keys !== undefined) {
      const names = cleanList(p.keys);
      const marks = readMarkers(db, analysisRow.id, 'key');
      const barTicks = Math.max(1, Math.round((ppq * 4 * meterNum) / meterDen));
      const next: Marker[] = names.map((name, i) => {
        if (i < marks.length) return { ...marks[i], keyName: name };
        const lastTick = marks.length ? marks[marks.length - 1].tick : 0;
        const tick = lastTick + barTicks * (i - marks.length + 1);
        return {
          id: `${analysisRow.id}:key:${tick}`,
          kind: 'key',
          tick,
          label: null,
          num: null,
          den: null,
          bpm: null,
          keyName: name,
          startBar: null,
          confidence: 'confirmed',
          note: null,
        };
      });
      setMarkers({ db }, analysisRow.id, 'key', next);
    }

    db.prepare(`UPDATE track SET updated_at = ? WHERE id = ?`).run(now, id);
  });
  run();

  return getTrack({ db, dataDir }, id);
}

export function softDeleteTrack({ db, dataDir }: ListCtx, id: string) {
  // 级联：母作品被删，它的乐章子项一起归档（先子后父）。递归以兼容嵌套乐章。
  const kids = db.prepare(`SELECT id FROM track WHERE parent_id = ? AND deleted_at IS NULL`).all(id) as any[];
  for (const k of kids) softDeleteTrack({ db, dataDir }, k.id);

  const now = Date.now();
  /**
   * 归档前先确认它的 JSON 在盘上。
   *
   * `data/tracks` 是源，删掉的曲目如果只留在库里，就变成「谁也看不见、也重建不出来」的状态；
   * 先写一份再搬进 `.archive`，至少还能在「已归档作品」里被找到、被彻底删除。
   * 写失败不拦删除 —— 删是用户明确要求的动作。
   */
  if (dataDir) {
    try {
      writeTrackJson({ db, dataDir }, id);
    } catch (err) {
      console.error('[json] 归档前写回失败：', id, err);
    }
  }

  // 分析档案跟着一起标记删除：库里所有查询都按 `analysis.deleted_at IS NULL` 过滤，
  // 只删 track 会让这份档案的调性 / 段落继续被「自然小调」「dorian」这类搜索数进去。
  db.transaction(() => {
    db.prepare(`UPDATE track SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    db.prepare(`UPDATE analysis SET deleted_at = ?, updated_at = ? WHERE track_id = ? AND deleted_at IS NULL`).run(
      now,
      now,
      id
    );
  })();

  if (dataDir) {
    try {
      const moved = archiveTrackJson({ db, dataDir }, id);
      if (moved) console.log(`[json] 已归档 ${id} → tracks/${ARCHIVE_DIR}/${moved}`);
    } catch (err) {
      console.error('[json] 归档失败：', id, err);
    }
  }
}

export { readAnalysis, formatMs };
