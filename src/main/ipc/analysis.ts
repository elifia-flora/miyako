import type Database from 'better-sqlite3';
import type { AnalysisDoc, AnalysisEvent, Confidence, Marker, MarkerKind } from '../../shared/types';
import { computeStartBars, tickToBarBeat } from '../../shared/barbeat.js';
import { parseChord, CHORD_LANES } from '../../shared/chord.js';
import { romanFromSposobin } from '../../shared/sposobin.js';
import { primaryOffset, setRecordingOffset } from './recording';

export interface RangePayload {
  analysisId: string;
  /** 目标泳道；框选跨行时可以一次写多条 */
  lanes: string[];
  startTick: number;
  endTick: number;
}

export interface RangeResult {
  inserted: number;
  removed: number;
  trimmed: number;
}


interface Ctx {
  db: Database.Database;
}

export function getAnalysis({ db }: Ctx, trackId: string): AnalysisDoc | null {
  const a = db
    .prepare(`SELECT * FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(trackId) as any;
  if (!a) return null;

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
    /**
     * 偏移属于**录音版本**，不属于作品。这里报的是「主录音那一份」，
     * 好让网格 / 导出 / 播放条这些只关心「当前这一版」的调用方不用各自再查一次。
     * 正在试听某个具体版本时，渲染层会用它自己的那份覆盖这个值。
     */
    audioOffsetMs: primaryOffset({ db }, a.track_id) ?? a.audio_offset_ms,
    viewId: a.view_id,
    markers: markers.map(toMarker),
    events: events.map(toEvent),
  };
}

function toMarker(m: any): Marker {
  return {
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
  };
}

function toEvent(e: any): AnalysisEvent {
  return {
    id: e.id,
    lane: e.lane,
    tick: e.tick,
    durTicks: e.dur_ticks,
    text: e.text,
    confidence: e.confidence,
    parsed: e.parsed ? safeJson(e.parsed) : null,
  };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 该 tick 生效的调性（罗马数字要靠它算根音） */
function keyAtTick(db: Database.Database, analysisId: string, tick: number): string | null {
  const row = db
    .prepare(
      `SELECT key_name FROM analysis_marker
        WHERE analysis_id = ? AND kind = 'key' AND tick <= ?
        ORDER BY tick DESC LIMIT 1`
    )
    .get(analysisId, tick) as any;
  return row?.key_name ?? null;
}

/**
 * 解析结果落库：`parsed` 是 JSON 文本，`ok:false` 也照存（界面要标黄提示）。
 * 非和弦泳道一律 NULL，免得把备注当和弦解析。
 *
 * **斯波索宾泳道要先翻译**：`D7` 直接喂 `parseChord` 会被当成「D 属七」——
 * 音名全错、还不报错。所以先用 `romanFromSposobin` 译成 `V7` 再解析；
 * 译不出来（自由文本 / 生造符号）就返回 NULL，**不留 `ok:false`**：
 * 那一栏本来就允许写注释，不该让它点亮工具栏的「解析失败」。
 */
export function parsedFor(lane: string, text: string, key: string | null): string | null {
  if (!text) return null;
  if (lane === 'sposobin') {
    const roman = romanFromSposobin(text, key);
    if (!roman) return null;
    const parsed = parseChord(roman, { key });
    // `raw` 换回用户写的那个符号，`roman` 留一份翻译结果便于排查
    return JSON.stringify({ ...parsed, raw: text, roman });
  }
  if (!CHORD_LANES.has(lane)) return null;
  return JSON.stringify(parseChord(text, { key }));
}

/**
 * 和弦解析器版本。
 *
 * `parsed` 是**派生数据**（不写进 `data/tracks/*.json`，seed 时才重算），所以只要
 * `chord.js` 的语义变了，库里存的就全是旧结果 —— 而界面读的正是库里的值，
 * 看不到任何报错，只会「明明修好了 III，界面上还是 G B D」。
 * 改解析逻辑时把这个数字 +1，下次启动会自动重算。
 *
 * v11（2026-11-08）：`parsed.omits` 只留「真的删掉了东西」的；`C69` 也认（字母泳道的六九写法）。
 * v10（2026-11-08）：13 隐含九音（maj13(♯11) 要带 9）；新增省略音 no5 / omit3。
 * v9（2026-11-05）：斯波索宾泳道开始解析（先译罗马数字再走同一个解析器），
 * 已有事件要补 `parsed` —— 不升版本的话它们会一直是 NULL，界面上看起来「没生效」。
 */
export const CHORD_PARSER_VERSION = 11;

/**
 * 按当前解析器重算全库 `analysis_event.parsed`。
 *
 * 只在版本不一致时执行：版本号存在 `meta` 表（迁移 007），没有这张表之前
 * 只能「每次启动都重算」或者「永远不重算」，前者每次启动写库，后者静默错误。
 * 只 UPDATE 值真的变了的行 —— 整表重写会把 `updated_at` 之外的统计搅乱。
 */
export function backfillParsed({ db }: Ctx): number {
  const cur = Number(
    (db.prepare(`SELECT value FROM meta WHERE key = 'chord_parser_version'`).get() as any)?.value ?? 0
  );
  if (cur === CHORD_PARSER_VERSION) return 0;

  const rows = db
    .prepare(`SELECT id, analysis_id, lane, text, tick, parsed FROM analysis_event`)
    .all() as any[];
  const upd = db.prepare(`UPDATE analysis_event SET parsed = ? WHERE id = ?`);
  let changed = 0;

  db.transaction(() => {
    for (const r of rows) {
      const next = parsedFor(r.lane, r.text, keyAtTick(db, r.analysis_id, r.tick));
      if (next === r.parsed) continue;
      upd.run(next, r.id);
      changed++;
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('chord_parser_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(CHORD_PARSER_VERSION));
  })();

  if (changed) console.log(`[chord] 解析器 v${CHORD_PARSER_VERSION}：重算 ${changed} 条 parsed`);
  return changed;
}

/** 整组替换某一类标记：拍号/速度/段落/调性都走这里 */
export function setMarkers({ db }: Ctx, analysisId: string, kind: MarkerKind, markers: Marker[]): void {
  const ppq = (db.prepare(`SELECT ppq FROM analysis WHERE id = ?`).get(analysisId) as any)?.ppq ?? 480;

  const meterRows = db
    .prepare(`SELECT tick, num, den FROM analysis_marker WHERE analysis_id = ? AND kind = 'meter' ORDER BY tick`)
    .all(analysisId) as any[];
  const meters = computeStartBars(
    meterRows.length ? meterRows : [{ tick: 0, num: 4, den: 4 }],
    ppq
  );

  const ins = db.prepare(`
    INSERT INTO analysis_marker (id, analysis_id, tick, kind, label, num, den, bpm, key_name, start_bar, confidence, note, sort_order)
    VALUES (@id, @analysisId, @tick, @kind, @label, @num, @den, @bpm, @keyName, @startBar, @confidence, @note, @sortOrder)
  `);

  const run = db.transaction(() => {
    db.prepare(`DELETE FROM analysis_marker WHERE analysis_id = ? AND kind = ?`).run(analysisId, kind);

    // 整组写拍号时要一次性算 startBar，逐条算会丢掉累加
    const newMeters =
      kind === 'meter'
        ? computeStartBars(
            markers.map((m) => ({ tick: m.tick, num: m.num ?? 4, den: m.den ?? 4 })),
            ppq
          )
        : null;

    markers.forEach((m, i) => {
      ins.run({
        id: m.id || `${analysisId}:${kind}:${m.tick}`,
        analysisId,
        tick: m.tick,
        kind,
        label: m.label ?? null,
        num: m.num ?? null,
        den: m.den ?? null,
        bpm: m.bpm ?? null,
        keyName: m.keyName ?? null,
        startBar: newMeters ? newMeters[i].startBar : tickToBarBeat(meters, m.tick, ppq).bar,
        confidence: m.confidence ?? 'confirmed',
        note: m.note ?? null,
        sortOrder: i,
      });
    });
    db.prepare(`UPDATE analysis SET updated_at = ? WHERE id = ?`).run(Date.now(), analysisId);
  });
  run();
}

/**
 * 确定性 id：同一条泳道的同一个 tick 反复写只会更新同一行。
 * 但一个 tick 上可能出现两条（比如跨区间的「右半段」），所以冲突时加 ~n。
 */
function idFor(db: Database.Database, analysisId: string, lane: string, tick: number): string {
  const base = `${analysisId}:${lane}:${tick}`;
  let id = base;
  let n = 1;
  while (db.prepare(`SELECT 1 FROM analysis_event WHERE id = ?`).get(id)) id = `${base}~${n++}`;
  return id;
}

/** 与区间相交的事件（右端开：紧贴不算） */
function overlapping(db: Database.Database, p: RangePayload, lane: string): any[] {
  return db
    .prepare(
      `SELECT * FROM analysis_event
        WHERE analysis_id = ? AND lane = ? AND tick < ? AND tick + dur_ticks > ?
        ORDER BY tick`
    )
    .all(p.analysisId, lane, p.endTick, p.startTick) as any[];
}

/**
 * 区间写入：把 [startTick, endTick) 这一格/几格交给 text。
 *
 * 关键不是「插一条」，而是**非破坏性覆盖**：
 *   已有事件完全落在区间内 → 删掉；
 *   只在左边多出来 → 截短；
 *   只在右边多出来 → 把右半段另存一条；
 *   两头都多 → 拆成两条。
 * 这样在 3/4 里给「第三拍」单独填 V7，不会把跨三拍的 I 整条抹掉。
 */
export function writeRange(
  { db }: Ctx,
  p: RangePayload & { text: string; confidence?: Confidence }
): RangeResult {
  const text = p.text.trim();
  const lanes = [...new Set(p.lanes)].filter(Boolean);
  if (!text || p.endTick <= p.startTick || !lanes.length) return { inserted: 0, removed: 0, trimmed: 0 };

  const now = Date.now();
  const result: RangeResult = { inserted: 0, removed: 0, trimmed: 0 };
  const del = db.prepare(`DELETE FROM analysis_event WHERE id = ?`);
  const setDur = db.prepare(`UPDATE analysis_event SET dur_ticks = ?, updated_at = ? WHERE id = ?`);
  const ins = db.prepare(`
    INSERT INTO analysis_event (id, analysis_id, lane, tick, dur_ticks, text, confidence, parsed, updated_at)
    VALUES (@id, @analysisId, @lane, @tick, @durTicks, @text, @confidence, @parsed, @now)
  `);
  const put = (lane: string, tick: number, dur: number, value: string, confidence: string, keepParsed?: string | null) =>
    ins.run({
      id: idFor(db, p.analysisId, lane, tick),
      analysisId: p.analysisId,
      lane,
      tick,
      durTicks: Math.round(dur),
      text: value,
      confidence,
      parsed: keepParsed === undefined ? parsedFor(lane, value, keyAtTick(db, p.analysisId, tick)) : keepParsed,
      now,
    });

  const tx = db.transaction(() => {
    for (const lane of lanes) {
      for (const r of overlapping(db, p, lane)) {
        const rowEnd = r.tick + r.dur_ticks;
        const keepLeft = r.tick < p.startTick;
        const keepRight = rowEnd > p.endTick;

        if (!keepLeft && !keepRight) {
          del.run(r.id);
          result.removed++;
          continue;
        }
        if (keepLeft && !keepRight) {
          setDur.run(p.startTick - r.tick, now, r.id);
          result.trimmed++;
          continue;
        }

        // 右侧要留：原行让位，右半段另起一条
        del.run(r.id);
        result.removed++;
        put(lane, p.endTick, rowEnd - p.endTick, r.text, r.confidence, r.parsed ?? null);
        result.trimmed++;
        if (keepLeft) {
          put(lane, r.tick, p.startTick - r.tick, r.text, r.confidence, r.parsed ?? null);
          result.trimmed++;
        }
      }
      put(lane, p.startTick, p.endTick - p.startTick, text, p.confidence ?? 'confirmed');
      result.inserted++;
    }
    db.prepare(`UPDATE analysis SET updated_at = ? WHERE id = ?`).run(now, p.analysisId);
  });
  tx();
  return result;
}

/**
 * 拖边缘改范围：先按新区间写，再把**原区间露在新区间之外**的那一段剪掉。
 *
 * 只调 writeRange 会「切成两份」：writeRange 的语义是「用新内容覆盖这一段」，
 * 原事件多出来的那半截会按规则另存一条 —— 扩宽时正好，缩窄时就变成
 * 新块 + 一条同名的旧尾巴。所以收缩必须额外清掉原区间里不再属于这条事件的部分。
 *
 * 左右各清一条（扩宽时两条都为空，行为与 writeRange 完全一致）。
 */
export function resizeRange(
  ctx: Ctx,
  p: RangePayload & { text: string; fromTick: number; toTick: number; confidence?: Confidence }
): RangeResult {
  const result = writeRange(ctx, p);

  const from = Math.min(p.fromTick, p.toTick);
  const to = Math.max(p.fromTick, p.toTick);
  const strips: [number, number][] = [];
  if (from < p.startTick) strips.push([from, Math.min(p.startTick, to)]);
  if (to > p.endTick) strips.push([Math.max(p.endTick, from), to]);

  for (const [startTick, endTick] of strips) {
    if (endTick <= startTick) continue;
    const cut = clearRange(ctx, {
      analysisId: p.analysisId,
      lanes: p.lanes,
      startTick,
      endTick,
    });
    result.removed += cut.removed;
    result.trimmed += cut.trimmed;
  }
  return result;
}

/** 区间删除（裁剪而不是整条抹掉，语义同 writeRange，只是不写新内容） */
export function clearRange({ db }: Ctx, p: RangePayload): RangeResult {
  const lanes = [...new Set(p.lanes)].filter(Boolean);
  const result: RangeResult = { inserted: 0, removed: 0, trimmed: 0 };
  if (p.endTick <= p.startTick || !lanes.length) return result;

  const now = Date.now();
  const del = db.prepare(`DELETE FROM analysis_event WHERE id = ?`);
  const setDur = db.prepare(`UPDATE analysis_event SET dur_ticks = ?, updated_at = ? WHERE id = ?`);
  const ins = db.prepare(`
    INSERT INTO analysis_event (id, analysis_id, lane, tick, dur_ticks, text, confidence, parsed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const lane of lanes) {
      for (const r of overlapping(db, p, lane)) {
        const rowEnd = r.tick + r.dur_ticks;
        const keepLeft = r.tick < p.startTick;
        const keepRight = rowEnd > p.endTick;
        if (!keepLeft && !keepRight) {
          del.run(r.id);
          result.removed++;
        } else if (keepLeft && !keepRight) {
          setDur.run(p.startTick - r.tick, now, r.id);
          result.trimmed++;
        } else {
          del.run(r.id);
          result.removed++;
          ins.run(
            idFor(db, p.analysisId, lane, p.endTick),
            p.analysisId,
            lane,
            p.endTick,
            rowEnd - p.endTick,
            r.text,
            r.confidence,
            r.parsed ?? null,
            now
          );
          if (keepLeft) {
            ins.run(
              idFor(db, p.analysisId, lane, r.tick),
              p.analysisId,
              lane,
              r.tick,
              p.startTick - r.tick,
              r.text,
              r.confidence,
              r.parsed ?? null,
              now
            );
          }
          result.trimmed++;
        }
      }
    }
    db.prepare(`UPDATE analysis SET updated_at = ? WHERE id = ?`).run(now, p.analysisId);
  });
  tx();
  return result;
}

export function upsertEvent(
  { db }: Ctx,
  e: Partial<AnalysisEvent> & { analysisId: string; lane: string; tick: number; text: string }
): AnalysisEvent {
  const id = e.id || idFor(db, e.analysisId, e.lane, e.tick);
  db.prepare(`
    INSERT INTO analysis_event (id, analysis_id, lane, tick, dur_ticks, text, confidence, parsed, updated_at)
    VALUES (@id, @analysisId, @lane, @tick, @durTicks, @text, @confidence, @parsed, @now)
    ON CONFLICT(id) DO UPDATE SET
      lane = excluded.lane, tick = excluded.tick, dur_ticks = excluded.dur_ticks,
      text = excluded.text, confidence = excluded.confidence,
      parsed = excluded.parsed, updated_at = excluded.updated_at
  `).run({
    id,
    analysisId: e.analysisId,
    lane: e.lane,
    tick: e.tick,
    durTicks: e.durTicks ?? 480,
    text: e.text,
    confidence: e.confidence ?? 'confirmed',
    parsed: parsedFor(e.lane, e.text, keyAtTick(db, e.analysisId, e.tick)),
    now: Date.now(),
  });
  const row = db.prepare(`SELECT * FROM analysis_event WHERE id = ?`).get(id);
  return toEvent(row);
}

export function deleteEvent({ db }: Ctx, id: string) {
  db.prepare(`DELETE FROM analysis_event WHERE id = ?`).run(id);
}

export function deleteEvents({ db }: Ctx, ids: string[]): number {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return 0;
  const del = db.prepare(`DELETE FROM analysis_event WHERE id = ?`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const id of list) n += del.run(id).changes;
    return n;
  });
  return tx();
}

/**
 * 整份事件快照替换 —— 撤销专用。
 * 区间写入会截短/拆分既有事件，逐条反做不可靠；直接恢复快照最诚实。
 */
export function replaceEvents({ db }: Ctx, analysisId: string, events: AnalysisEvent[]): number {
  const now = Date.now();
  const ins = db.prepare(`
    INSERT INTO analysis_event (id, analysis_id, lane, tick, dur_ticks, text, confidence, parsed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM analysis_event WHERE analysis_id = ?`).run(analysisId);
    let n = 0;
    for (const e of events) {
      if (!e?.lane || e.text == null) continue;
      ins.run(
        e.id || idFor(db, analysisId, e.lane, e.tick),
        analysisId,
        e.lane,
        Math.round(e.tick),
        Math.round(e.durTicks ?? 480),
        String(e.text),
        e.confidence ?? 'confirmed',
        parsedFor(e.lane, String(e.text), keyAtTick(db, analysisId, e.tick)),
        now
      );
      n++;
    }
    db.prepare(`UPDATE analysis SET updated_at = ? WHERE id = ?`).run(now, analysisId);
    return n;
  });
  return tx();
}

export interface MoveItem {
  id: string;
  tick: number;
  lane: string;
}

export interface MoveResult {
  moved: number;
  removed: number;
  trimmed: number;
}

/**
 * 给一整段 [startTick, endTick) 让路：删掉完全落入的，截短左/右超出的，两头都超出的拆成两条。
 * skip 里的 id 不动（正在拖的那几条不能被自己清掉）。
 */
function trimAt(
  db: Database.Database,
  analysisId: string,
  lane: string,
  startTick: number,
  endTick: number,
  skip: Set<string>,
  now: number
): { removed: number; trimmed: number } {
  const stat = { removed: 0, trimmed: 0 };
  const del = db.prepare(`DELETE FROM analysis_event WHERE id = ?`);
  const setDur = db.prepare(`UPDATE analysis_event SET dur_ticks = ?, updated_at = ? WHERE id = ?`);
  const ins = db.prepare(`
    INSERT INTO analysis_event (id, analysis_id, lane, tick, dur_ticks, text, confidence, parsed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows = db
    .prepare(
      `SELECT * FROM analysis_event
        WHERE analysis_id = ? AND lane = ? AND tick < ? AND tick + dur_ticks > ?
        ORDER BY tick`
    )
    .all(analysisId, lane, endTick, startTick) as any[];

  for (const r of rows) {
    if (skip.has(r.id)) continue;
    const rowEnd = r.tick + r.dur_ticks;
    const keepLeft = r.tick < startTick;
    const keepRight = rowEnd > endTick;
    if (!keepLeft && !keepRight) {
      del.run(r.id);
      stat.removed++;
    } else if (keepLeft && !keepRight) {
      setDur.run(startTick - r.tick, now, r.id);
      stat.trimmed++;
    } else {
      del.run(r.id);
      stat.removed++;
      ins.run(
        idFor(db, analysisId, lane, endTick),
        analysisId,
        lane,
        endTick,
        rowEnd - endTick,
        r.text,
        r.confidence,
        r.parsed ?? null,
        now
      );
      if (keepLeft) {
        ins.run(
          idFor(db, analysisId, lane, r.tick),
          analysisId,
          lane,
          r.tick,
          startTick - r.tick,
          r.text,
          r.confidence,
          r.parsed ?? null,
          now
        );
      }
      stat.trimmed++;
    }
  }
  return stat;
}

/**
 * 拖动移动事件：一次可以移一组（框选后整体拖），也可以顺便换泳道。
 *
 * 两个语义要点：
 *   1) 时值不变 —— 拖的是位置，不是长度；要改长度去框格重写。
 *   2) 落到别人身上是**覆盖**：用和区间写入一样的裁剪规则，不把对方整条抹掉，
 *      否则「把 V7 挪过去」会顺手吃掉半条 I。
 * 撤销仍走整份快照（replaceEvents），这里不维护逐步反操作。
 */
export function moveEvents({ db }: Ctx, p: { analysisId: string; moves: MoveItem[] }): MoveResult {
  const list = (p.moves ?? []).filter(
    (m) => m && typeof m.id === 'string' && m.lane && Number.isFinite(m.tick) && m.tick >= 0
  );
  const result: MoveResult = { moved: 0, removed: 0, trimmed: 0 };
  if (!list.length) return result;

  const now = Date.now();
  const upd = db.prepare(`UPDATE analysis_event SET lane = ?, tick = ?, parsed = ?, updated_at = ? WHERE id = ?`);

  const tx = db.transaction(() => {
    const moving = new Set(list.map((m) => m.id));
    for (const m of list) {
      const row = db.prepare(`SELECT * FROM analysis_event WHERE id = ?`).get(m.id) as any;
      if (!row) continue;
      const tick = Math.round(m.tick);
      const trimmed = trimAt(db, p.analysisId, m.lane, tick, tick + row.dur_ticks, moving, now);
      result.removed += trimmed.removed;
      result.trimmed += trimmed.trimmed;
      upd.run(m.lane, tick, parsedFor(m.lane, row.text, keyAtTick(db, p.analysisId, tick)), now, m.id);
      result.moved++;
    }
    db.prepare(`UPDATE analysis SET updated_at = ? WHERE id = ?`).run(now, p.analysisId);
  });
  tx();
  return result;
}

/**
 * 兼容壳：以前按 analysisId 改「作品级偏移」，现在偏移归录音版本。
 *
 * 保留这个名字是因为调用方（冒烟脚本、旧按钮）都按它写；语义改成
 * 「写这部作品主录音的偏移」，与播放条走同一个口径。
 * 新代码请直接用 `recording.setOffset(trackId, recId, ms)`。
 */
export function setAudioOffset({ db }: Ctx, analysisId: string, ms: number) {
  const a = db.prepare(`SELECT track_id FROM analysis WHERE id = ?`).get(analysisId) as any;
  if (!a) return;
  setRecordingOffset({ db }, a.track_id, null, Math.round(ms));
}

export function setView({ db }: Ctx, analysisId: string, viewId: string) {
  db.prepare(`UPDATE analysis SET view_id = ?, updated_at = ? WHERE id = ?`).run(viewId, Date.now(), analysisId);
}
