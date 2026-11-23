import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { computeStartBars, parseMeter, tickToBarBeat } from '../../shared/barbeat.js';
import { normalizeLang } from '../../shared/lang.js';
import { planSeedIds } from '../../shared/seedid.js';
import type { VocabSet } from '../vocab/load';
import { setAudioPath } from '../ipc/audio';
import { parsedFor } from '../ipc/analysis';
import { analysisIdFor, newTrackId } from '../db/ids';
import { writeFileAtomic } from '../atomic-write.js';

export interface SeedResult {
  imported: string[];
  skipped: string[];
  /** 同标题撞车、被换了新 id 并写回的档案（文件名） */
  healed: string[];
}

/**
 * 把新分配的 id 写回档案。
 *
 * **只加 `uuid`，不重建整份文档** —— 这是外部来源的档案，可能有本程序不认识的键
 * （或者已经过时的 schema 字段）。这里要做的是「钉住身份」，不是「规范化内容」；
 * 规范化由 `writeTrackJson` 在用户真正编辑时做。
 */
function stampUuid(dir: string, file: string, doc: any, uuid: string) {
  const next = { ...doc, uuid };
  writeFileAtomic(path.join(dir, file), JSON.stringify(next, null, 2) + '\n');
}


/**
 * data/tracks/*.json → 数据库。
 * 规范化后的 JSON 是源；这里只负责映射成行，不做语义判断（判断都在 tools/import.mjs 里做完了）。
 */
export function seedFromTracks(db: Database.Database, dataDir: string, vocab: VocabSet, force = false): SeedResult {
  const dir = path.join(dataDir, 'tracks');
  const result: SeedResult = { imported: [], skipped: [], healed: [] };
  if (!fs.existsSync(dir)) return result;

  /** 档案格式问题（写了已经被删掉的字段、段落缺 tick…）：不拦导入，但启动时要看得见 */
  const warns: string[] = [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const now = Date.now();

  /**
   * 先整批读出来再分配 id：判断「有没有别人占了同一个 id」必须看得到这一批里的全部档案。
   * 老档案（v2，没有 uuid）以前是逐个 `stableId('trk', 标题)`，同名必然撞，
   * 而撞了的处理是**静默跳过** —— 第二首同名作品就再也不会出现在库里。
   * 现在由 `planSeedIds` 统一规划：撞车的后来者换新 id，并把 uuid 写回它自己的 JSON。
   */
  const entries: { file: string; doc: any; title: string; uuid: string | null }[] = [];
  for (const file of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      entries.push({
        file,
        doc,
        title: doc.title?.original ?? path.basename(file, '.json'),
        uuid: typeof doc.uuid === 'string' && doc.uuid ? doc.uuid : null,
      });
    } catch {
      // 坏 JSON 不该让整个启动挂掉：其余档案照常导入，这一份在日志里留名
      console.warn(`[seed] ${file} 不是合法 JSON，跳过`);
    }
  }
  const plan = new Map(
    planSeedIds(
      entries.map((e) => ({ file: e.file, uuid: e.uuid, title: e.title })),
      { mint: newTrackId }
    ).map((p) => [p.file, p])
  );

  for (const entry of entries) {
    const { file, doc, title } = entry;
    const { id: trackId, heal } = plan.get(file)!;
    const analysisId = analysisIdFor(trackId);
    if (heal) {
      // 同名撞车：这一份拿到了新身份，立刻写回文件，下次启动它就稳定了
      stampUuid(dir, file, doc, trackId);
      result.healed.push(file);
    }

    const exists = db.prepare(`SELECT 1 FROM track WHERE id = ?`).get(trackId);

    /**
     * 音频绑定也由 JSON 驱动：timeline.audioPath 变了就同步进库。
     * 只在文件真的存在时才写，避免把「换机器后的旧路径」当成有效绑定。
     */
    const audioPath = doc.timeline?.audioPath as string | undefined;
    const syncAudio = () => {
      if (!audioPath || !fs.existsSync(audioPath)) return;
      const cur = db.prepare(`SELECT file_path FROM track WHERE id = ?`).get(trackId) as any;
      if (cur?.file_path === audioPath) return;
      setAudioPath({ db, dataDir }, trackId, audioPath);
    };

    if (exists && !force) {
      syncAudio();
      result.skipped.push(file);
      continue;
    }

    const ppq = doc.timeline?.ppq ?? 480;
    /**
     * 档案里没写拍号 = 未标注，不再补一个假的 4/4：
     * 渲染层没有 marker 时本来就按 4/4 画网格，补进库里却会让「未标注」永远消失。
     */
    const meter = doc.basic?.meter ? parseMeter(doc.basic.meter) : null;
    const bpm = doc.basic?.bpm ?? null;

    const run = db.transaction(() => {
      if (exists) {
        db.prepare(`DELETE FROM analysis_marker WHERE analysis_id = ?`).run(analysisId);
        db.prepare(`DELETE FROM analysis_event WHERE analysis_id = ?`).run(analysisId);
        db.prepare(`DELETE FROM analysis WHERE id = ?`).run(analysisId);
        db.prepare(`DELETE FROM track_tag WHERE track_id = ?`).run(trackId);
        db.prepare(`DELETE FROM track WHERE id = ?`).run(trackId);
      }

      db.prepare(`
        INSERT INTO track (id, title, title_lang, title_sort, composer, performer, album, genre, period,
                           composition_type, form,
                           duration_ms, file_path, file_hash, notes, extra, added_at, updated_at)
        VALUES (@id, @title, @titleLang, @titleSort, @composer, @performer, @album, @genre, @period,
                @compositionType, @form,
                NULL, NULL, NULL, @notes, @extra, @now, @now)
      `).run({
        id: trackId,
        title,
        // 只收短代码（en / ja / zh…）。老档案写的是 "English" 这种全名，由 normalizeLang 认下来
        titleLang: normalizeLang(doc.title?.lang),
        titleSort: title.toLowerCase(),
        composer: doc.credits?.composer ?? null,
        performer: doc.credits?.performer ?? null,
        album: doc.album ?? null,
        genre: doc.genre ?? null,
        // 体裁 / 曲式：存词表 id（symphony / sonata），显示名随界面语言变
        compositionType: doc.compositionType ?? null,
        form: doc.form ?? null,
        period: doc.period ?? null,
        notes: doc.basic?.description ?? null,
        // extra 是「不配进列」的档案余量：副标题、别名、制作名单、外链、情绪标签
        extra: JSON.stringify({
          source: file,
          meterNote: doc.basic?.meterNote ?? null,
          // 标题模板的四个数据项：没有就不写，模板展开时会整段省略
          formNumber: doc.basic?.formNumber ?? null,
          opusNumber: doc.basic?.opusNumber ?? null,
          // subForm 是旧键：外部旧档案也认，读进来统一存成 subType
          subType: doc.basic?.subType ?? doc.basic?.subForm ?? null,
          tempoTerm: doc.basic?.tempoTerm ?? null,
          subtitle: doc.title?.subtitle ?? null,
          aliases: doc.title?.aliases ?? [],
          instrumentationAbstract: doc.instrumentation?.abstract ?? null,
          credits: doc.credits ?? null,
          links: doc.links ?? null,
          moods: doc.moods ?? [],
          // 封面 / 歌词：路径相对 data 目录，或者相对素材目录
          covers: doc.covers ?? null,
          lyrics: doc.lyrics ?? null,
          ...(doc.instrumental === true ? { instrumental: true } : {}),
        }),
        now,
      });

      db.prepare(`
        INSERT INTO analysis (id, track_id, title, ppq, tempo_value, tempo_unit, meter_num, meter_den,
                              meter_note, audio_offset_ms, view_id, author, created_at, updated_at)
        VALUES (@id, @trackId, @title, @ppq, @bpm, @tempoUnit, @num, @den, @meterNote, @offset, 'roman', 'import', @now, @now)
      `).run({
        id: analysisId,
        trackId,
        title,
        ppq,
        bpm,
        tempoUnit: doc.basic?.tempoUnit ?? null,
        num: meter?.num ?? null,
        den: meter?.den ?? null,
        // meterType 不再入库：单/复拍子是规则算出来的（shared/meter.js），不是档案内容
        meterNote: doc.basic?.meterNote ?? null,
        offset: doc.timeline?.audioOffsetMs ?? 0,
        now,
      });

      // 拍号 marker 只是换算的锚：未标注时就不写 —— 网格/播放会按 4/4 兜底。
      // 段落 startBar 仍按 4/4 折算（与界面在未标注时的表现一致）。
      const meterMarkers = computeStartBars(
        [{ tick: 0, num: meter?.num ?? 4, den: meter?.den ?? 4 }],
        ppq
      );
      const insMarker = db.prepare(`
        INSERT INTO analysis_marker (id, analysis_id, tick, kind, label, num, den, bpm, key_name, start_bar, confidence, note, sort_order)
        VALUES (@id, @analysisId, @tick, @kind, @label, @num, @den, @bpm, @keyName, @startBar, @confidence, @note, @sortOrder)
      `);
      if (meter) {
        insMarker.run({
          id: `${analysisId}:meter:0`, analysisId, tick: 0, kind: 'meter',
          label: doc.basic?.meter ?? null, num: meter.num, den: meter.den, bpm: null, keyName: null,
          startBar: 1, confidence: 'confirmed', note: doc.basic?.meterNote ?? null, sortOrder: 0,
        });
      }

      /**
       * 段落只认 `tick`（schema v4）。
       *
       * `bar`（第几小节）完全能从 tick + 拍号链推出来，写进档案就是第二份真相：
       * 改拍号之后它立刻过期，而没人会记得同步。所以这里**不再用 bar 兜底** ——
       * 没有 tick 的段落直接跳过（并在控制台点名文件），
       * 让「写了小节数」这件事第一次就暴露，而不是悄悄生效。
       */
      for (const s of doc.timeline?.sections ?? []) {
        if (s.bar != null) {
          warns.push(`${file}: 段落还在写 "bar"（小节数），已忽略 —— 只认 tick`);
        }
        if (typeof s.tick !== 'number' || !Number.isFinite(s.tick)) {
          warns.push(`${file}: 有段落缺少 tick，已跳过（label=${JSON.stringify(s.label ?? null)}）`);
          continue;
        }
        const tick = s.tick;
        insMarker.run({
          id: `${analysisId}:section:${tick}`, analysisId, tick, kind: 'section',
          label: s.label ?? null, num: null, den: null, bpm: null, keyName: null,
          startBar: tickToBarBeat(meterMarkers, tick, ppq).bar,
          confidence: 'confirmed', note: null, sortOrder: 0,
        });
      }

      for (const k of doc.timeline?.keys ?? []) {
        insMarker.run({
          id: `${analysisId}:key:${k.tick}`, analysisId, tick: k.tick, kind: 'key',
          label: null, num: null, den: null, bpm: null, keyName: k.keyName ?? null,
          startBar: tickToBarBeat(meterMarkers, k.tick, ppq).bar,
          confidence: k.confidence ?? 'confirmed', note: k.note ?? null, sortOrder: 0,
        });
      }

      // 事件：JSON 里带了和弦/织体就一起入库，parsed 按当时生效的调性算好
      const insEvent = db.prepare(`
        INSERT INTO analysis_event (id, analysis_id, lane, tick, dur_ticks, text, confidence, parsed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const keyList = (doc.timeline?.keys ?? [])
        .slice()
        .sort((a: any, b: any) => (a.tick ?? 0) - (b.tick ?? 0));
      const keyAt = (tick: number) => {
        let hit: string | null = null;
        for (const k of keyList) if ((k.tick ?? 0) <= tick) hit = k.keyName ?? null;
        return hit;
      };
      for (const ev of doc.events ?? []) {
        const tick = Math.round(ev.tick ?? 0);
        // 老档案里没写 lane 的事件：那时还没有字母和弦视图，按级数处理。
        // 字母和弦是后来才有的，且一定会自带 lane = 'chord'。
        const lane = ev.lane ?? 'degree';
        const text = String(ev.text ?? ev.chord ?? '');
        if (!text) continue;
        insEvent.run(
          `${analysisId}:${lane}:${tick}`,
          analysisId,
          lane,
          tick,
          Math.round(ev.durTicks ?? ev.dur_ticks ?? 480),
          text,
          ev.confidence ?? 'confirmed',
          parsedFor(lane, text, keyAt(tick)),
          now
        );
      }

      // 标签：先挂词表里能确认的，未命中的这里不猜
      const insTT = db.prepare(`INSERT OR IGNORE INTO track_tag (track_id, tag_id, weight) VALUES (?, ?, 1)`);
      for (const id of doc.instrumentIds ?? []) {
        if (vocab.byId.has(id)) insTT.run(trackId, id);
      }
      for (const t of doc.techniques ?? []) {
        if (vocab.byId.has(t.id)) insTT.run(trackId, t.id);
      }
    });
    run();
    syncAudio();

    result.imported.push(file);
  }

  /**
   * 乐章的 parent_id 在全部 track 落库后再设：避免「子文件先于母文件」触发外键，
   * 也兜住母作品缺失（坏 JSON 被跳过）的情况——父不在就不挂，宁可为独立作品。
   */
  const setParent = db.prepare(`UPDATE track SET parent_id = ? WHERE id = ?`);
  const parentExists = db.prepare(`SELECT 1 FROM track WHERE id = ? AND deleted_at IS NULL`);
  for (const entry of entries) {
    const pid = typeof entry.doc.parentId === 'string' && entry.doc.parentId ? entry.doc.parentId : null;
    if (!pid) continue;
    const { id: trackId } = plan.get(entry.file)!;
    if (parentExists.get(pid)) setParent.run(pid, trackId);
  }

  for (const w of warns) console.warn(`[seed] ${w}`);
  return result;
}
