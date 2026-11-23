import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * 泳道方案（data/views/*.json）决定「一行数据落在哪个 lane」。
 *
 * 这里守住 2026-11-04 那条拆分（迁移 010）：
 *   级数 → `degree`；绝对和弦 → `chord`。
 * 一旦有人把某个视图的 lane id 改回去，两套符号又会绑成一份数据 ——
 * 界面上表现为「字母和弦视图里躺着一串 I / IV / V7」，而且不报错。
 */
const load = (id) => JSON.parse(fs.readFileSync(new URL(`../data/views/${id}.json`, import.meta.url), 'utf8'));
const laneIds = (id) => load(id).lanes.map((l) => l.id);

test('罗马数字视图写 degree，不再占用 chord', () => {
  assert.ok(laneIds('roman').includes('degree'));
  assert.ok(!laneIds('roman').includes('chord'), 'roman 不该再有 chord 行（那是绝对和弦）');
});

test('字母和弦视图写 chord，且没有 degree 行', () => {
  assert.ok(laneIds('letter').includes('chord'));
  assert.ok(!laneIds('letter').includes('degree'));
});

test('黎曼视图的「实际和弦」是绝对和弦（与 letter 共用 chord），功能行进 function 行', () => {
  assert.ok(laneIds('riemann').includes('function'));
  assert.ok(laneIds('riemann').includes('chord'));
  // 与 roman 共享调性上下文，但级数语义在 function 行
  assert.equal(load('riemann').needsContext, 'key');
});

test('和弦组成音是绝对音名（不依赖调性），因此也用 chord', () => {
  assert.equal(load('voicing').needsContext, null);
  assert.ok(laneIds('voicing').includes('chord'));
});
