import test from 'node:test';
import assert from 'node:assert/strict';
import { planSeedIds, stableId } from '../src/shared/seedid.js';

/**
 * 这些用例盯的是「同名作品的第二份会不会被悄悄吞掉」。
 *
 * 老档案（无 uuid）原来按标题算哈希当 id，同名必撞；撞了的处理是 `skipped` ——
 * 列表里少一首，日志里也只有「已存在跳过 N 首」。这类失败不会报错，只会丢数据。
 */

/** 确定性 mint：测试要能预料到分到哪个 id */
function seqMint(prefix = 'new') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

test('有 uuid 的档案：id 照它说的算，不改也不 heal', () => {
  const plan = planSeedIds([{ file: 'a.json', uuid: 'tr-1', title: '月光' }], { mint: seqMint() });
  assert.deepEqual(plan, [{ file: 'a.json', id: 'tr-1', heal: false }]);
});

test('两份同名老档案：后来者换新 id 并标记 heal', () => {
  const plan = planSeedIds(
    [
      { file: '月光.json', uuid: null, title: '月光' },
      { file: '月光 (2).json', uuid: null, title: '月光' },
    ],
    { mint: seqMint() }
  );
  const candidate = stableId('trk', '月光');
  // 「谁保留候选 id」由文件名排序决定，不写死是哪一份；只要求：一份留下、一份改号
  const keep = plan.filter((p) => !p.heal);
  const healed = plan.filter((p) => p.heal);
  assert.equal(keep.length, 1);
  assert.equal(keep[0].id, candidate);
  assert.equal(healed.length, 1);
  assert.notEqual(healed[0].id, candidate, '改号的那份不能还拿着撞车的 id');
});

test('同名老档案 vs 已有 uuid 的档案：老档案让路', () => {
  const taken = stableId('trk', '前奏曲');
  const plan = planSeedIds(
    [
      { file: '前奏曲（新）.json', uuid: null, title: '前奏曲' },
      { file: '前奏曲.json', uuid: taken, title: '前奏曲' },
    ],
    { mint: seqMint() }
  );
  const fresh = plan.find((p) => p.file === '前奏曲（新）.json');
  const old = plan.find((p) => p.file === '前奏曲.json');
  assert.equal(old.id, taken);
  assert.equal(old.heal, false);
  assert.notEqual(fresh.id, taken);
  assert.equal(fresh.heal, true);
});

test('三份同名：只有第一份留候选 id，后两份各拿新 id', () => {
  const plan = planSeedIds(
    [
      { file: 'a.json', uuid: null, title: '无词歌' },
      { file: 'b.json', uuid: null, title: '无词歌' },
      { file: 'c.json', uuid: null, title: '无词歌' },
    ],
    { mint: seqMint() }
  );
  const ids = plan.map((p) => p.id);
  assert.equal(new Set(ids).size, 3, '三份同名必须三个 id');
  assert.deepEqual(
    plan.map((p) => p.heal),
    [false, true, true]
  );
});

test('分配结果与文件返回顺序无关（按文件名排序）', () => {
  const entries = [
    { file: 'b.json', uuid: null, title: '练习曲' },
    { file: 'a.json', uuid: null, title: '练习曲' },
  ];
  const forward = planSeedIds(entries, { mint: seqMint() });
  const reversed = planSeedIds([...entries].reverse(), { mint: seqMint() });
  // 顺序按入参返回，但「谁保留候选 id」必须只由文件名决定
  assert.equal(forward.find((p) => p.file === 'a.json').id, stableId('trk', '练习曲'));
  assert.equal(reversed.find((p) => p.file === 'a.json').id, stableId('trk', '练习曲'));
  assert.deepEqual(
    forward.map((p) => p.file),
    ['b.json', 'a.json']
  );
});

test('标题不同：各用各的哈希，谁都不用 heal', () => {
  const plan = planSeedIds(
    [
      { file: 'x.json', uuid: null, title: '月光' },
      { file: 'y.json', uuid: null, title: '月光（德彪西）' },
    ],
    { mint: seqMint() }
  );
  assert.equal(plan.every((p) => p.heal === false), true);
  assert.notEqual(plan[0].id, plan[1].id);
});

test('mint 自己撞上已有 id 时会重试，不会产出重复', () => {
  const taken = stableId('trk', '夜曲');
  let n = 0;
  const mint = () => (n++ === 0 ? taken : `fixed-1`);
  const plan = planSeedIds(
    [
      { file: '夜曲.json', uuid: taken, title: '夜曲' },
      { file: '夜曲（二）.json', uuid: null, title: '夜曲' },
    ],
    { mint }
  );
  const healed = plan.find((p) => p.heal);
  assert.equal(healed.id, 'fixed-1');
});
