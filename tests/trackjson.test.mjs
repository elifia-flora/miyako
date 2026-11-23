import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 档案格式的硬约束（schema v4）。
 *
 * 这几条不是「风格建议」，而是**数据正确性**：
 *   - 段落写 `bar`（小节数）= 存了一份会过期的投影，改拍号之后它就错，且没人会来同步；
 *   - `meterType` 是规则算出来的，而规则本身随术语体系变（4/4 在中/苏/德奥是复拍子、
 *     在英美是 simple meter）—— 一个字符串装不下这个前提；
 *   - `title.lang` 存全名（"English"）是文案混进数据，中文界面没法翻成「英语」。
 *
 * 直接扫 `data/tracks/*.json`：任何人手改文件写回这些字段，`npm test` 立刻红。
 * （`writeTrackJson` / `tools/import.mjs` 已经不会写它们了，这里是最后一道闸。）
 */

const DIR = path.resolve(import.meta.dirname, '..', 'data', 'tracks');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json')) : [];
const docs = files.map((f) => ({
  file: f,
  doc: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')),
}));

/*
 * 公开仓库里**没有** data/tracks（作者自己的曲库属于个人数据，不随仓库分发），
 * 所以这些断言在 clone 下来的环境里没有对象可查 —— 跳过，而不是报红。
 * 本地开发时曲库在，断言照常跑。
 */
const SKIP_NO_TRACKS = docs.length === 0 ? 'data/tracks 为空（公开仓库不含个人曲库）' : false;


test('data/tracks 里确实有档案（否则下面的断言等于没跑）', { skip: SKIP_NO_TRACKS }, () => {
  assert.ok(docs.length > 0, 'data/tracks 是空的？');
});

test('段落只记 tick：没有任何 sections[].bar（小节数）', { skip: SKIP_NO_TRACKS }, () => {
  const bad = [];
  for (const { file, doc } of docs) {
    for (const s of doc?.timeline?.sections ?? []) {
      if (Object.prototype.hasOwnProperty.call(s, 'bar')) bad.push(`${file} @tick=${s.tick}`);
    }
  }
  assert.deepEqual(bad, [], `这些段落还在写小节数：${bad.join(', ')}`);
});

test('段落必须有数字 tick（没有 tick 的段落等于没有位置）', { skip: SKIP_NO_TRACKS }, () => {
  const bad = [];
  for (const { file, doc } of docs) {
    for (const s of doc?.timeline?.sections ?? []) {
      if (typeof s.tick !== 'number' || !Number.isFinite(s.tick)) bad.push(`${file} label=${s.label}`);
    }
  }
  assert.deepEqual(bad, [], `这些段落缺 tick：${bad.join(', ')}`);
});

test('basic 里没有 meterType（单/复拍子是派生值）', { skip: SKIP_NO_TRACKS }, () => {
  const bad = docs.filter(({ doc }) => doc?.basic && 'meterType' in doc.basic).map((d) => d.file);
  assert.deepEqual(bad, [], `这些档案还写着 meterType：${bad.join(', ')}`);
});

test('title.lang 是短代码（en / ja / zh…）或 null', { skip: SKIP_NO_TRACKS }, () => {
  const bad = [];
  for (const { file, doc } of docs) {
    const lang = doc?.title?.lang;
    if (lang == null) continue;
    if (typeof lang !== 'string' || !/^[a-z]{2,3}$/.test(lang)) bad.push(`${file}: ${JSON.stringify(lang)}`);
  }
  assert.deepEqual(bad, [], `这些语言不是短代码：${bad.join(', ')}`);
});

test('uuid 唯一（同一首曲子两份文件会让 seed 互相覆盖）', { skip: SKIP_NO_TRACKS }, () => {
  const seen = new Map();
  const bad = [];
  for (const { file, doc } of docs) {
    const id = doc?.uuid;
    if (!id) continue; // 老档案（v2）没有 uuid，由 seed 现场分配
    if (seen.has(id)) bad.push(`${id}: ${seen.get(id)} + ${file}`);
    seen.set(id, file);
  }
  assert.deepEqual(bad, [], `uuid 重复：${bad.join(', ')}`);
});
