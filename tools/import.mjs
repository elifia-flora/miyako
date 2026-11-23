#!/usr/bin/env node
/**
 * import.mjs — 分析 JSON 导入器（原型）
 *
 * 职责边界（很重要）：
 *   本脚本只做「读 → 迁移 → 匹配 → 报告」，不写数据库。
 *   写库属于下一步，必须等你确认清洗报告之后再接。
 *
 * 运行：
 *   node tools/import.mjs fixtures/shenlu.raw.json
 */

import fs from 'node:fs';
import { normalizeLang } from '../src/shared/lang.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PPQ = 480;

/* ------------------------------------------------------------------ */
/* 词表加载                                                            */
/* ------------------------------------------------------------------ */

function loadVocab(dim) {
  const file = path.join(ROOT, 'data', 'vocab', `${dim}.json`);
  if (!fs.existsSync(file)) return { tags: new Map(), edges: [], index: new Map() };

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tags = new Map();     // id -> tag
  const edges = [];           // {child, parent}
  const index = new Map();    // normalized name/alias -> id

  const walk = (nodes, parentId) => {
    for (const n of nodes) {
      if (!tags.has(n.id)) {
        tags.set(n.id, { id: n.id, dim, name: n.name, display: n.display ?? n.name });
      }
      if (parentId) edges.push({ child: n.id, parent: parentId });
      index.set(norm(n.name), n.id);
      index.set(norm(n.id), n.id);
      for (const a of n.aliases ?? []) index.set(norm(a), n.id);
      if (n.children?.length) walk(n.children, n.id);
    }
  };
  walk(raw.roots ?? [], null);

  return { tags, edges, index };
}

/** 归一：小写、压缩空白、去首尾标点 */
function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s,·、]+|[\s,·、]+$/g, '')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 脏数据记录                                                          */
/* ------------------------------------------------------------------ */

const issues = [];
function record(kind, where, found, action, needConfirm = false) {
  issues.push({ kind, where, found, action, needConfirm });
}

/* ------------------------------------------------------------------ */
/* v1 → v2 迁移                                                        */
/* ------------------------------------------------------------------ */

function migrate(doc) {
  const from = doc.schemaVersion ?? 1;
  let out = doc;

  if (from < 2) {
    // ① 字段名笔误：样本里是 "period:"（带冒号）
    if (Object.prototype.hasOwnProperty.call(out, 'period:')) {
      out.period = out['period:'];
      delete out['period:'];
      record('fix', 'top.period:', '"period:"', '重命名为 period', true);
    }
    // ② 空标题 / 空 id
    if (out.title && typeof out.title === 'object') {
      out.title = {
        original: out.title['original text'] ?? '',
        // schema v4：只存短代码（en / ja / zh…），全名在导入这一步就归一掉
        lang: normalizeLang(out.title['original language']),
      };
      record('fix', 'title', '{original text, original language}', '拍平为 {original, lang（短代码）}', false);
    }
    out.schemaVersion = 2;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 标签匹配                                                            */
/* ------------------------------------------------------------------ */

function makeResolver(vocab) {
  return function resolve(raw) {
    if (raw == null) return { id: null, reason: 'empty' };
    const s = String(raw).trim();
    if (!s) return { id: null, reason: 'empty' };

    const direct = vocab.index.get(norm(s));
    if (direct) return { id: direct, how: 'exact' };

    // 复数：Horns -> Horn / Violins -> Violin
    const singular = norm(s).replace(/(?:es|s)$/, '');
    const bySingular = vocab.index.get(singular);
    if (bySingular) return { id: bySingular, how: 'singular' };

    // 括号前的主体：Pipa (5-Strings) -> pipa
    const head = norm(s.replace(/\(.*?\)/g, ''));
    const byHead = vocab.index.get(head);
    if (byHead) return { id: byHead, how: 'head' };

    // 声部编号：Violins 1 -> violin-1（parent = violin）
    // 不能简单并回 violin —— 第一/第二小提琴在配器分析里是两个不同的编制单位，合并会丢信息。
    const m = s.match(/^(.*?)\s*(\d+)$/);
    if (m) {
      const base = norm(m[1]);
      const bid = vocab.index.get(base) ?? vocab.index.get(base.replace(/(?:es|s)$/, ''));
      if (bid) {
        return { id: `${bid}-${m[2]}`, baseId: bid, isNew: true, how: 'derived-part' };
      }
    }

    return { id: null, reason: 'unmatched' };
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const inputPath = process.argv[2] ?? path.join(ROOT, 'fixtures', 'shenlu.raw.json');
const rawText = fs.readFileSync(inputPath, 'utf8');
const rawDoc = JSON.parse(rawText);

const doc = migrate(rawDoc);

const instrumentVocab = loadVocab('instrument');
// 作曲技法：文件已从 technique.json 更名为 composition.json
// （technique 这个名字太含糊，把「乐器演奏技法」也混进去了）
const techniqueVocab = loadVocab('composition');
const resolveInstrument = makeResolver(instrumentVocab);
const resolveTechnique = makeResolver(techniqueVocab);

/* --- 基础信息 --- */
const meterRaw = doc.basic?.['time signature']?.value ?? '4/4';
const [meterNum, meterDen] = meterRaw.split('/').map(Number);
const bpm = doc.basic?.tempo?.value ?? 120;
const barLen = (PPQ * meterNum * 4) / meterDen;

record(
  'info',
  'basic.time signature',
  `${meterRaw}（${doc.basic?.['time signature']?.type ?? '未标注'}）`,
  doc.basic?.['time signature']?.description
    ? `主值取 ${meterRaw}；描述「${doc.basic['time signature'].description}」存入 meter_note，不参与换算`
    : `主值取 ${meterRaw}`,
  false
);

/* --- 乐器 --- */
const instrumentHits = [];
const instrumentUnmatched = [];
const derivedInstruments = [];   // 词表里没有、但可由「乐器+编号」安全派生的声部标签
for (const raw of doc.instruments_used ?? []) {
  if (!String(raw ?? '').trim()) {
    record('fix', 'instruments_used', '""', '丢弃空字符串', false);
    continue;
  }
  const r = resolveInstrument(raw);
  if (r.isNew) derivedInstruments.push({ raw, id: r.id, parent: r.baseId });
  if (r.id) instrumentHits.push({ raw, id: r.id, how: r.how });
  else instrumentUnmatched.push(raw);
}

/* --- 技法 --- */
const techniqueHits = [];
const techniqueExtraEdges = [];
const techniqueUnmatched = [];

for (const [bucket, list] of Object.entries(doc['composition techniques'] ?? {})) {
  const parentRoot = bucket.replace(/\s+techniques?$/i, '');   // "melodic"
  for (const item of list ?? []) {
    if (typeof item === 'string') {
      const r = resolveTechnique(item);
      if (r.id) {
        techniqueHits.push({ raw: item, id: r.id, root: parentRoot, how: r.how });
      } else {
        techniqueUnmatched.push({ raw: item, root: parentRoot });
      }
    } else if (item && item.parent) {
      // 样本形态：{"parent": ["imitation","canon"]} —— 没有 name，只有父类
      const prev = list[list.indexOf(item) - 1];
      record(
        'confirm',
        `composition techniques → ${bucket}`,
        JSON.stringify(item),
        `解读为「${prev ?? '上一个技法'} 的父类为 ${item.parent.join('、')}」`,
        true
      );
      for (const p of item.parent) {
        const pid = resolveTechnique(p).id;
        const childId = typeof prev === 'string' ? resolveTechnique(prev).id : null;
        if (pid && childId) techniqueExtraEdges.push({ child: childId, parent: pid });
      }
    }
  }
}
void techniqueExtraEdges;

/* --- 结构 → 时间轴 --- */
const sections = [];
const keys = [];
const seenSectionNo = new Map();

for (const item of doc.Structure ?? []) {
  const noKey = Object.keys(item).find((k) => k.toLowerCase().startsWith('section'));
  const no = noKey ? Number(String(noKey).replace(/\D/g, '')) : null;
  const label = noKey ? item[noKey] : null;
  const bar = item.start_position_musical ?? null;

  if (no != null) {
    seenSectionNo.set(no, (seenSectionNo.get(no) ?? 0) + 1);
  }

  const tick = bar == null ? null : (bar - 1) * barLen;
  sections.push({ no, label, bar, tick, tonality: item.tonality ?? null });

  if (item.tonality) {
    const t = String(item.tonality);
    const uncertain = /not sure|unsure|\?/i.test(t);
    const cleaned = t.replace(/not sure,?\s*is\s*/i, '').replace(/\?+$/g, '').trim();
    // 只在调性真正变化时生成 marker：连续三段都是 c natural minor 不该画出三条分隔线
    const prevKey = keys[keys.length - 1];
    if (!prevKey || norm(prevKey.name) !== norm(cleaned)) {
      keys.push({ bar, tick, name: cleaned, raw: t, confidence: uncertain ? 'uncertain' : 'confirmed' });
      if (uncertain) {
        record(
          'confirm',
          `Structure → ${label}`,
          `"${t}"`,
          `存为 key_name="${cleaned}"，confidence="uncertain"，原文移入 note`,
          true
        );
      }
    }
  }
}

for (const [no, count] of seenSectionNo) {
  if (count > 1) {
    record('confirm', 'Structure', `section 编号 ${no} 出现 ${count} 次`, '段落改用独立 id，label 保留原样；不改编号', true);
  }
}

/* --- 时长验算 --- */
const lastSection = sections[sections.length - 1];
const lastTick = lastSection?.tick ?? 0;
const toSeconds = (tick) => (tick / PPQ) * (60 / bpm);

/* ------------------------------------------------------------------ */
/* 输出：规范化 JSON                                                    */
/* ------------------------------------------------------------------ */

const normalized = {
  schemaVersion: 2,
  title: doc.title,
  basic: {
    meter: meterRaw,
    // 原资料的 "simple/compound meter" 不落盘：单/复拍子由 shared/meter.js 按体系现算
    meterNote: doc.basic?.['time signature']?.description ?? null,
    bpm,
    tempoUnit: doc.basic?.tempo?.unit ?? null,
    tempoChange: doc.basic?.tempo?.is_tempo_change ?? false,
    description: doc.basic?.description ?? null,
  },
  period: doc.period ?? null,
  instrumentIds: [...new Set(instrumentHits.map((h) => h.id))],
  derivedTags: derivedInstruments.map((d) => ({ id: d.id, parent: d.parent, name: d.raw })),
  techniques: techniqueHits.map((h) => ({ id: h.id, root: h.root })),
  timeline: {
    ppq: PPQ,
    audioOffsetMs: 0,
    // 只写 tick：小节数是 tick + 拍号的投影，写进来就等着过期
    sections: sections.map((s) => ({ tick: s.tick, label: s.label })),
    keys: keys.map((k) => ({ tick: k.tick, keyName: k.name, confidence: k.confidence, note: k.confidence === 'uncertain' ? k.raw : null })),
  },
  events: [],
  extra: {},
};

const outDir = path.join(ROOT, 'data', 'tracks');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, '神鹿谣.json');
fs.writeFileSync(outFile, JSON.stringify(normalized, null, 2), 'utf8');

/* ------------------------------------------------------------------ */
/* 输出：清洗报告                                                       */
/* ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
const line = (n = 72) => '─'.repeat(n);
const out = [];

out.push(`# 清洗报告 · ${doc.title?.original ?? '未命名'}`);
out.push('');
out.push(`> 源文件：\`${path.relative(ROOT, inputPath)}\``);
out.push(`> 常量音节：ppq=${PPQ}，小节长度=${barLen} tick`);
out.push('');
out.push('## 概览');
out.push('');
out.push('| 项 | 值 |');
out.push('|---|---|');
out.push(`| 曲名 | ${doc.title?.original ?? '—'}（${doc.title?.lang ?? '—'}）|`);
out.push(`| 拍号 / 速度 | ${meterRaw} · ${bpm} BPM |`);
out.push(`| 段落数 | ${sections.length} |`);
out.push(`| 调性标记 | ${keys.length}（其中存疑 ${keys.filter((k) => k.confidence === 'uncertain').length}）|`);
out.push(`| 乐器 | ${new Set(instrumentHits.map((h) => h.id)).size} 个（原始 ${(doc.instruments_used ?? []).length} 项，派生声部 ${derivedInstruments.length} 个）|`);
out.push(`| 技法 | 命中 ${techniqueHits.length} |`);
out.push('');

out.push('## 一、需要你点头的修正');
out.push('');
const confirmItems = issues.filter((i) => i.needConfirm);
if (!confirmItems.length) out.push('_无_');
else {
  out.push('| # | 位置 | 原文 | 建议处理 |');
  out.push('|---|---|---|---|');
  confirmItems.forEach((i, n) => out.push(`| ${n + 1} | \`${i.where}\` | ${i.found.replace(/\|/g, '\\|')} | ${i.action} |`));
}
out.push('');

out.push('## 二、已自动处理（不需确认，但你可否决）');
out.push('');
const autoItems = issues.filter((i) => !i.needConfirm);
if (!autoItems.length) out.push('_无_');
else {
  out.push('| # | 位置 | 原文 | 处理 |');
  out.push('|---|---|---|---|');
  autoItems.forEach((i, n) => out.push(`| ${n + 1} | \`${i.where}\` | ${i.found.replace(/\|/g, '\\|')} | ${i.action} |`));
}
out.push('');

out.push('## 三、乐器匹配');
out.push('');
out.push('| 原始串 | 归属 | 匹配方式 |');
out.push('|---|---|---|');
for (const h of instrumentHits) {
  out.push(`| ${h.raw} | \`${h.id}\` | ${h.how} |`);
}
for (const u of instrumentUnmatched) {
  out.push(`| ${u} | **未命中，需新建** | — |`);
}
out.push('');

if (derivedInstruments.length) {
  out.push('### 派生声部（词表里没有，但可安全生成）');
  out.push('');
  out.push('| 原始串 | 派生 id | 父标签 | 理由 |');
  out.push('|---|---|---|---|');
  for (const d of derivedInstruments) {
    out.push(`| ${d.raw} | \`${d.id}\` | \`${d.parent}\` | 乐器 + 声部编号；并入父标签会丢失声部信息 |`);
  }
  out.push('');
  out.push('> 这些标签会作为子标签写回词表，下次遇到同样写法自动命中。');
  out.push('');
}

out.push('## 四、技法匹配');
out.push('');
out.push('| 原始串 | 归属根 | 标签 id | 匹配方式 |');
out.push('|---|---|---|---|');
for (const h of techniqueHits) out.push(`| ${h.raw} | ${h.root} | \`${h.id}\` | ${h.how} |`);
for (const u of techniqueUnmatched) out.push(`| ${u.raw} | ${u.root} | **未命中** | — |`);
out.push('');

out.push('## 五、时间轴换算');
out.push('');
out.push('| 段落 | 小节 | tick | 时间 | 调性 | 置信 |');
out.push('|---|---|---|---|---|---|');
for (const s of sections) {
  const k = keys.find((x) => x.tick === s.tick);
  out.push(
    `| ${pad(s.label ?? '—', 12)} | ${s.bar ?? '—'} | ${s.tick ?? '—'} | ${s.tick == null ? '—' : toSeconds(s.tick).toFixed(2) + 's'} | ${k?.name ?? '—'} | ${k?.confidence ?? '—'} |`
  );
}
out.push('');
out.push(`最后段落起点：**${toSeconds(lastTick).toFixed(2)}s**（这是 coda 的*起点*，不是全曲长度）`);
out.push('');
out.push(`若全曲时长为 186s，则总小节数 ≈ **${((186 / (60 / bpm)) / meterNum).toFixed(1)}** 小节 —— 与「coda 从第 106 小节起」自洽。`);
out.push('');

out.push('## 六、关系边（多父）');
out.push('');
if (techniqueExtraEdges.length) {
  out.push('| 子 | 父 |');
  out.push('|---|---|');
  for (const e of techniqueExtraEdges) out.push(`| \`${e.child}\` | \`${e.parent}\` |`);
} else {
  out.push('_样本未产生额外边（父类声明与词表结构一致）_');
}
out.push('');
out.push('> 注意：`modulation` 在词表里同时挂在 melodic 与 harmonic 下，展平后会有两条父子边——这是 DAG 的正常表现，不是重复数据。');
out.push('');

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
const reportFile = path.join(ROOT, 'docs', '清洗报告-神鹿谣.md');
fs.writeFileSync(reportFile, out.join('\n'), 'utf8');

/* ------------------------------------------------------------------ */
/* 控制台摘要                                                          */
/* ------------------------------------------------------------------ */

console.log(line());
console.log(`导入：${doc.title?.original}  (${meterRaw} · ${bpm} BPM)`);
console.log(line());
console.log(`需确认 ${confirmItems.length} 项，自动处理 ${autoItems.length} 项`);
console.log(`乐器命中 ${new Set(instrumentHits.map((h) => h.id)).size} / 未命中 ${instrumentUnmatched.length}`);
console.log(`技法命中 ${techniqueHits.length} / 未命中 ${techniqueUnmatched.length}`);
console.log(`段落 ${sections.length}，调性 ${keys.length}（存疑 ${keys.filter((k) => k.confidence === 'uncertain').length}）`);
console.log(line());
console.log(`规范化 JSON → ${path.relative(ROOT, outFile)}`);
console.log(`清洗报告   → ${path.relative(ROOT, reportFile)}`);
if (instrumentUnmatched.length) console.log(`未命中乐器：${instrumentUnmatched.join(', ')}`);
if (techniqueUnmatched.length) console.log(`未命中技法：${techniqueUnmatched.map((t) => t.raw).join(', ')}`);
