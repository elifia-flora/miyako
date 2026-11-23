#!/usr/bin/env node
/**
 * validate.mjs — 词表与视图的结构校验
 *
 * 你以后会直接手改 data/vocab/*.json，所以必须有东西在启动前拦住错误：
 *   环、重复 id、别名冲突、非法 kind、缺字段。
 *
 * 运行：node tools/validate.mjs
 * 退出码 0 = 全部通过；1 = 有 FAIL。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const fail = (msg) => results.push({ ok: false, msg });
const pass = (msg) => results.push({ ok: true, msg });

const LANE_KINDS = new Set(['text', 'note']);
const ALIGNS = new Set(['left', 'center', 'right']);

/* ---------------- 词表 ---------------- */

const vocabDir = path.join(ROOT, 'data', 'vocab');
const vocabFiles = fs.existsSync(vocabDir)
  ? fs.readdirSync(vocabDir).filter((f) => f.endsWith('.json'))
  : [];

const allIds = new Map();     // id -> {dim, name}
const aliasOwner = new Map(); // "dim|alias" -> id
const childSeen = new Set();  // "parent|child"，防止同一父下重复挂载
/** 非标签维度的补全素材：不进 tag 表，结构也不同，不能按 dim/roots 校验 */
const NON_TAG_FILES = new Set(['chord-symbols.json', 'tempo_marking.json']);

for (const file of vocabFiles) {
  const full = path.join(vocabDir, file);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    fail(`${file}: JSON 解析失败 — ${e.message}`);
    continue;
  }

  if (typeof doc.schemaVersion !== 'number') {
    fail(`${file}: 缺少 schemaVersion`);
  }

  if (NON_TAG_FILES.has(file)) {
    if (file === 'tempo_marking.json') {
      const terms = Array.isArray(doc.terms) ? doc.terms : null;
      if (!terms) fail(`${file}: 缺少 terms 数组`);
      else {
        const seen = new Set();
        for (const t of terms) {
          if (!t?.id) fail(`${file}: 有术语缺少 id（${t?.name ?? '?'}）`);
          else if (seen.has(t.id)) fail(`${file}: 术语 id 重复 "${t.id}"`);
          else seen.add(t.id);
          if (!t?.name) fail(`${file}: ${t?.id ?? '?'} 缺少 name`);
          if (t?.kind && !['tempo', 'character'].includes(t.kind)) {
            fail(`${file}: ${t.id} 的 kind="${t.kind}" 不在 tempo/character 里`);
          }
        }
        pass(`${file}: ${terms.length} 条速度 / 表情术语，id 唯一，kind 合法`);
      }
    } else {
      pass(`${file}: 非标签维度，跳过树校验`);
    }
    continue;
  }

  const dimFromName = path.basename(file, '.json');
  if (doc.dim !== dimFromName) {
    fail(`${file}: dim="${doc.dim}" 与文件名不符（应为 ${dimFromName}）`);
  }

  const nodes = [];
  const edges = [];
  const multiMount = [];
  const walk = (list, parentId) => {
    for (const n of list ?? []) {
      if (!n.id) { fail(`${file}: 有节点缺少 id（${n.name ?? '?'}）`); continue; }
      if (!n.name) fail(`${file}: ${n.id} 缺少 name`);

      const prev = allIds.get(n.id);
      if (prev) {
        // 同一 id 出现在多个根下是合法的（如 modulation 同时属于旋律与和声），
        // 但两处定义必须完全一致——不一致才是真错。
        if (prev.dim !== doc.dim) {
          fail(`${file}: id "${n.id}" 与 ${prev.dim} 维度冲突`);
        } else if (prev.name !== n.name) {
          fail(`${file}: id "${n.id}" 两处定义不一致（"${prev.name}" vs "${n.name}"）`);
        } else {
          multiMount.push(n.id);
        }
      } else {
        allIds.set(n.id, { dim: doc.dim, name: n.name });
      }

      nodes.push(n);

      if (parentId) {
        const key = `${parentId}|${n.id}`;
        if (childSeen.has(key)) {
          fail(`${file}: ${parentId} 下重复挂载 ${n.id}`);
        } else {
          childSeen.add(key);
          edges.push([n.id, parentId]);
        }
      }

      for (const a of n.aliases ?? []) {
        const key = `${doc.dim}|${a.toLowerCase()}`;
        const owner = aliasOwner.get(key);
        if (owner && owner !== n.id) {
          fail(`${file}: 别名 "${a}" 同时指向 ${owner} 与 ${n.id}`);
        } else {
          aliasOwner.set(key, n.id);
        }
      }
      if (n.children?.length) walk(n.children, n.id);
    }
  };
  walk(doc.roots, null);

  // 环检测（DAG 必须无环）
  const adj = new Map();
  for (const [c, p] of edges) {
    if (!adj.has(c)) adj.set(c, []);
    adj.get(c).push(p);
  }
  const state = new Map(); // 0=未访问 1=在栈 2=完成
  let cycle = null;
  const dfs = (node, stack) => {
    if (cycle) return;
    const s = state.get(node) ?? 0;
    if (s === 1) { cycle = [...stack, node]; return; }
    if (s === 2) return;
    state.set(node, 1);
    for (const next of adj.get(node) ?? []) dfs(next, [...stack, node]);
    state.set(node, 2);
  };
  for (const n of nodes) dfs(n.id, []);
  if (cycle) fail(`${file}: 父子关系成环 ${cycle.join(' → ')}`);

  const mm = [...new Set(multiMount)];
  pass(
    `${file}: ${nodes.length} 个节点，${edges.length} 条边，无环` +
      (mm.length ? `（多根挂载：${mm.join(', ')}）` : '')
  );
}

/* ---------------- 视图 ---------------- */

const viewDir = path.join(ROOT, 'data', 'views');
const viewFiles = fs.existsSync(viewDir)
  ? fs.readdirSync(viewDir).filter((f) => f.endsWith('.json'))
  : [];

const viewIds = new Set();
for (const file of viewFiles) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(viewDir, file), 'utf8'));
  } catch (e) {
    fail(`${file}: JSON 解析失败 — ${e.message}`);
    continue;
  }

  if (!doc.id) { fail(`${file}: 缺少 id`); continue; }
  if (viewIds.has(doc.id)) fail(`${file}: view id "${doc.id}" 重复`);
  viewIds.add(doc.id);

  if (!Array.isArray(doc.lanes) || !doc.lanes.length) {
    fail(`${file}: lanes 为空`);
    continue;
  }

  const laneIds = new Set();
  for (const lane of doc.lanes) {
    if (!lane.id) fail(`${file}: 有泳道缺少 id`);
    if (laneIds.has(lane.id)) fail(`${file}: 泳道 id "${lane.id}" 重复`);
    laneIds.add(lane.id);
    if (!LANE_KINDS.has(lane.kind)) {
      fail(`${file}: 泳道 "${lane.id}" 的 kind="${lane.kind}" 非法（应为 ${[...LANE_KINDS].join('/')}）`);
    }
    if (!(typeof lane.height === 'number' && lane.height > 0)) {
      fail(`${file}: 泳道 "${lane.id}" 的 height 必须是正数`);
    }
    if (lane.align && !ALIGNS.has(lane.align)) {
      fail(`${file}: 泳道 "${lane.id}" 的 align="${lane.align}" 非法`);
    }
  }
  if (doc.needsContext != null && doc.needsContext !== 'key') {
    fail(`${file}: needsContext 目前只支持 null 或 "key"`);
  }

  const needKey = doc.needsContext === 'key';
  pass(`${file}: ${doc.lanes.length} 条泳道${needKey ? '（依赖调性）' : ''}`);
}

/* ---------------- 输出 ---------------- */

console.log('─'.repeat(64));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log('─'.repeat(64));
console.log(failed ? `✗ ${failed} 项失败` : `✓ 全部通过（${results.length} 项）`);
process.exit(failed ? 1 : 0);
