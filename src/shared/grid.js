/**
 * grid.js — 网格「格」的数学
 *
 * 格的定义：**拍号分母单位 ÷ 细分**。
 *   3/4 div=1 → 每小节 3 格（四分音符），正好一拍一格；
 *   3/4 div=2 → 每小节 6 格（八分音符），和弦可以在半拍上换；
 *   6/8 div=1 → 每小节 6 格（八分音符；需要按附点四分算「大拍」时用 div=3）。
 *
 * 与 barbeat.js 一样是纯 JS + 纯函数：主进程、渲染进程、node --test 都能直接用。
 * 所有 tick 一律取整——数据库里存的是 INTEGER，带小数的 tick 迟早会出现差一。
 */
import { barToTick, tickToBarBeat } from './barbeat.js';

/** 第 bar 小节生效的拍号段（startBar 由 computeStartBars 预先算好） */
export function meterForBar(meters, bar) {
  let hit = meters[0];
  for (const m of meters) if (m.startBar <= bar) hit = m;
  return hit;
}

/**
 * 某一小节的格子布局。
 * div = 0 是「一小节一格」的哨兵值：小节长度本身随拍号变，不能折算成一个常数细分。
 * @returns {{bar:number, meter:any, div:number, cells:number, cellTicks:number, barTick:number}}
 */
export function gridAt(meters, ppq, bar, div = 1) {
  const meter = meterForBar(meters, bar);
  const num = meter?.num ?? 4;
  const den = meter?.den ?? 4;
  const barTick = barToTick(meters, bar, ppq);
  const barTicks = (4 * ppq * num) / den;

  if (!(div > 0)) {
    return { bar, meter, div: 0, cells: 1, cellTicks: barTicks, barTick };
  }
  const cells = Math.max(1, Math.round(num * div));
  return {
    bar,
    meter,
    div,
    cells,
    cellTicks: barTicks / cells,
    barTick,
  };
}

/** tick 落在该小节的第几格（0 起，越界夹住） */
export function cellIndexAt(grid, tick) {
  const raw = Math.floor((tick - grid.barTick) / grid.cellTicks);
  return Math.max(0, Math.min(grid.cells - 1, raw));
}

/** 第 cell 格的起始 tick */
export function cellStart(grid, cell) {
  return Math.round(grid.barTick + cell * grid.cellTicks);
}

/** tick → { bar, cell, start, end, grid } */
export function cellAtTick(meters, ppq, tick, div = 1) {
  const bar = Math.max(1, tickToBarBeat(meters, tick, ppq).bar);
  const grid = gridAt(meters, ppq, bar, div);
  const cell = cellIndexAt(grid, tick);
  const start = cellStart(grid, cell);
  return { bar, cell, start, end: Math.round(start + grid.cellTicks), grid };
}

/**
 * 任意两个 tick → 对齐到格边界的小节区间（左闭右开）。
 *
 * 语义按「指针落在哪一格就框到哪一格」（和表格软件一致）：
 * 起头取所在格左边界，结尾取结束指针**所在格**的右边界。
 * 所以从第 1 格起手、拖到第 2 格左边缘，框住的是第 1–2 格，不是只剩第 1 格。
 */
export function snapRange(meters, ppq, a, b, div = 1) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const ca = cellAtTick(meters, ppq, lo, div);
  const cb = cellAtTick(meters, ppq, hi, div);
  const startTick = ca.start;
  const endTick = Math.round(cb.start + cb.grid.cellTicks);
  return {
    startTick,
    endTick: Math.max(startTick + Math.round(ca.grid.cellTicks), endTick),
  };
}

/** 区间内一共几格（跨拍号变化时逐小节累加，不能用「总 tick ÷ 格宽」） */
export function countCells(meters, ppq, startTick, endTick, div = 1) {
  if (endTick <= startTick) return 0;
  const s = cellAtTick(meters, ppq, startTick, div);
  const e = cellAtTick(meters, ppq, endTick - 1, div);
  let n = 0;
  for (let bar = s.bar; bar <= e.bar; bar++) {
    const g = gridAt(meters, ppq, bar, div);
    const from = bar === s.bar ? s.cell : 0;
    const to = bar === e.bar ? e.cell : g.cells - 1;
    n += Math.max(0, to - from + 1);
  }
  return n;
}

/**
 * 选区的人话描述，直接显示在工具栏上。
 * 选区标签必须能让人一眼核对「我框的到底是不是这三拍」。
 */
export function describeRange(meters, ppq, startTick, endTick, div = 1) {
  const s = cellAtTick(meters, ppq, startTick, div);
  const e = cellAtTick(meters, ppq, Math.max(startTick, endTick - 1), div);
  const cells = countCells(meters, ppq, startTick, endTick, div);
  const meter = s.grid.meter;
  // 一小节一格时不该说「第 1 格」—— 格就是小节本身
  const byBar = s.grid.cells === 1;
  const text = byBar
    ? s.bar === e.bar
      ? `第 ${s.bar} 小节`
      : `第 ${s.bar} 小节 → 第 ${e.bar} 小节`
    : s.bar === e.bar
      ? `第 ${s.bar} 小节 · 第 ${s.cell + 1}${e.cell === s.cell ? '' : '–' + (e.cell + 1)} 格`
      : `第 ${s.bar} 小节 第 ${s.cell + 1} 格 → 第 ${e.bar} 小节 第 ${e.cell + 1} 格`;
  return {
    bar: s.bar,
    barTo: e.bar,
    cellFrom: s.cell,
    cellTo: e.cell,
    cells,
    meter: `${meter?.num ?? 4}/${meter?.den ?? 4}`,
    text,
  };
}

/** 两个 tick 区间是否相交（右端开区间，紧贴不算重叠） */
export function overlaps(aTick, aDur, bStart, bEnd) {
  return aTick < bEnd && aTick + aDur > bStart;
}
