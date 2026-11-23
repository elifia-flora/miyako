import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStartBars } from '../src/shared/barbeat.js';
import {
  cellAtTick,
  cellIndexAt,
  countCells,
  describeRange,
  gridAt,
  meterForBar,
  overlaps,
  snapRange,
} from '../src/shared/grid.js';

const PPQ = 480;
const waltz = computeStartBars([{ tick: 0, num: 3, den: 4 }], PPQ);

test('3/4：每小节 3 格，一格 = 四分音符 = 480 tick', () => {
  const g = gridAt(waltz, PPQ, 12, 1);
  assert.equal(g.cells, 3);
  assert.equal(g.cellTicks, 480);
  assert.equal(g.barTick, 15840); // 第 12 小节首拍
  assert.equal(g.bar, 12);
});

test('3/4 细分 2×：6 格，一格 = 八分音符', () => {
  const g = gridAt(waltz, PPQ, 1, 2);
  assert.equal(g.cells, 6);
  assert.equal(g.cellTicks, 240);
});

test('用户举的例子：3/4 里前两拍主和弦、第三拍属和弦', () => {
  // 第 12 小节：I 占第 1–2 格（15840..16800），V7 落在第 3 格（16800）
  const first = cellAtTick(waltz, PPQ, 15840, 1);
  assert.deepEqual([first.bar, first.cell, first.start], [12, 0, 15840]);

  const third = cellAtTick(waltz, PPQ, 16800, 1);
  assert.deepEqual([third.bar, third.cell, third.start], [12, 2, 16800]);
  assert.equal(third.end, 17280);

  // 从第 1 格拖到第 2 格 → 右端开区间停在 16800，正好是 I 的长度
  assert.deepEqual(snapRange(waltz, PPQ, 15840, 16320, 1), {
    startTick: 15840,
    endTick: 16800,
  });
  assert.equal(countCells(waltz, PPQ, 15840, 16800, 1), 2);
  assert.equal(describeRange(waltz, PPQ, 15840, 17280, 1).text, '第 12 小节 · 第 1–3 格');
});

test('拖到半格：起头向下取整、结尾向上取整', () => {
  const r = snapRange(waltz, PPQ, 15840 + 120, 16320 + 240, 1);
  assert.equal(r.startTick, 15840);
  assert.equal(r.endTick, 16800);
});

test('指针落在下一格起点：框架包含那一格（表格软件的框选语义）', () => {
  const r = snapRange(waltz, PPQ, 15840, 16800, 1);
  assert.deepEqual(r, { startTick: 15840, endTick: 17280 });
  assert.equal(countCells(waltz, PPQ, r.startTick, r.endTick, 1), 3);
});

test('反着拖（从右往左）也得到同一区间', () => {
  const a = snapRange(waltz, PPQ, 15840, 17280, 1);
  const b = snapRange(waltz, PPQ, 17280, 15840, 1);
  assert.deepEqual(a, b);
});

test('单格选区至少有一格宽，不会塌成 0', () => {
  const r = snapRange(waltz, PPQ, 15840, 15840, 1);
  assert.deepEqual(r, { startTick: 15840, endTick: 16320 });
});

test('跨小节选区：从第 12 小节第 3 格到第 13 小节第 1 格 = 2 格', () => {
  const r = snapRange(waltz, PPQ, 16800, 17280, 1);
  assert.deepEqual(r, { startTick: 16800, endTick: 17760 });
  assert.equal(countCells(waltz, PPQ, 16800, 17760, 1), 2);
  assert.equal(describeRange(waltz, PPQ, 16800, 17760, 1).text, '第 12 小节 第 3 格 → 第 13 小节 第 1 格');
});

test('6/8 的格是八分音符（240 tick），大拍要用 3 格 = 720 tick', () => {
  const sixEight = computeStartBars([{ tick: 0, num: 6, den: 8 }], PPQ);
  const g = gridAt(sixEight, PPQ, 1, 1);
  assert.equal(g.cells, 6);
  assert.equal(g.cellTicks, 240);
  assert.equal(countCells(sixEight, PPQ, 0, 720, 1), 3);
  assert.equal(describeRange(sixEight, PPQ, 0, 720, 1).meter, '6/8');
});

test('中途变拍：两种拍号的小节各自算格，不能拿同一格宽套到底', () => {
  const m = computeStartBars(
    [
      { tick: 0, num: 3, den: 4 },
      { tick: 8 * 1440, num: 6, den: 8 },
    ],
    PPQ
  );
  assert.equal(meterForBar(m, 8).num, 3);
  assert.equal(meterForBar(m, 9).num, 6);

  // 3/4 的第 8 小节 = 3 格 + 6/8 的第 9 小节 = 6 格
  const start = 7 * 1440;
  const end = 8 * 1440 + 6 * 240;
  assert.equal(countCells(m, PPQ, start, end, 1), 9);

  const g9 = gridAt(m, PPQ, 9, 1);
  assert.equal(g9.cellTicks, 240);
  assert.equal(g9.barTick, 8 * 1440);
});

test('cellIndexAt 越界会夹住，不会产生 -1 或越界下标', () => {
  const g = gridAt(waltz, PPQ, 1, 1);
  assert.equal(cellIndexAt(g, -100), 0);
  assert.equal(cellIndexAt(g, 10 * 1440), 2);
});

test('overlaps 是右端开区间：紧贴不算重叠', () => {
  assert.equal(overlaps(15840, 960, 16800, 17280), false); // I 结束正好接上 V7
  assert.equal(overlaps(15840, 960, 16320, 17280), true);
  assert.equal(overlaps(16800, 480, 15840, 16800), false);
});

test('单位 = 小节（div=0）：3/4 一小节就是一格，格宽随拍号变', () => {
  const g = gridAt(waltz, PPQ, 12, 0);
  assert.equal(g.cells, 1);
  assert.equal(g.cellTicks, 1440);
  assert.equal(cellAtTick(waltz, PPQ, 15840, 0).start, 15840);
  assert.equal(cellAtTick(waltz, PPQ, 17000, 0).end, 17280);
  assert.deepEqual(snapRange(waltz, PPQ, 15840, 16000, 0), { startTick: 15840, endTick: 17280 });
  assert.equal(describeRange(waltz, PPQ, 15840, 17280, 0).text, '第 12 小节');
});

test('单位 = 小节跨拍号：6/8 的一格是 1440 tick（不是 3/4 的 1440 巧合）', () => {
  const m = computeStartBars(
    [
      { tick: 0, num: 3, den: 4 },
      { tick: 8 * 1440, num: 6, den: 8 },
    ],
    PPQ
  );
  // 3/4 小节 = 1440 tick，6/8 小节 = 6×240 = 1440 tick 也成立，但格边界必须跟着走
  assert.equal(gridAt(m, PPQ, 8, 0).cellTicks, 1440);
  assert.equal(gridAt(m, PPQ, 9, 0).cellTicks, 1440);
  // 换成 5/8：一小节 = 5×240 = 1200，说明格宽不是常数
  const odd = computeStartBars([{ tick: 0, num: 5, den: 8 }], PPQ);
  assert.equal(gridAt(odd, PPQ, 1, 0).cellTicks, 1200);
  assert.equal(countCells(odd, PPQ, 0, 2400, 0), 2);
});
