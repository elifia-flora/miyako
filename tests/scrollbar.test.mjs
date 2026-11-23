import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_THUMB,
  scrollForThumbDelta,
  thumbMetrics,
  thumbOffset,
} from '../src/shared/scrollbar.js';

test('内容比视口短：不画条（1px 容差内也算短）', () => {
  assert.equal(thumbMetrics({ trackLen: 400, viewLen: 400, contentLen: 400 }), null);
  // 子像素布局常让 scrollHeight 大一点点，差 1px 就冒出一条不能动的条最恼人
  assert.equal(thumbMetrics({ trackLen: 400, viewLen: 400, contentLen: 401 }), null);
  // 差 2px 就该画条了，但滑块几乎撑满轨道（这才是「只多一点点」该有的样子）
  assert.equal(thumbMetrics({ trackLen: 400, viewLen: 400, contentLen: 402 })?.len, 398);
});

test('滑块长度按视口 / 内容比例，且不短于最小可拖长度', () => {
  const m = thumbMetrics({ trackLen: 400, viewLen: 200, contentLen: 400 });
  assert.equal(m?.len, 200);
  assert.equal(m?.maxOffset, 200);

  // 内容很长时按比例算出来的会非常短，夹到 24px 才抓得住
  const tiny = thumbMetrics({ trackLen: 400, viewLen: 100, contentLen: 10000 });
  assert.equal(tiny?.len, MIN_THUMB);
  assert.equal(tiny?.maxOffset, 400 - MIN_THUMB);
});

test('滑块永远不会比轨道长', () => {
  const m = thumbMetrics({ trackLen: 10, viewLen: 1000, contentLen: 2000 });
  assert.equal(m?.len, 10);
  assert.equal(m?.maxOffset, 0);
});

test('滚动位置换算：滚到底时滑块底边正好贴住轨道底边', () => {
  const m = thumbMetrics({ trackLen: 400, viewLen: 200, contentLen: 1000 });
  assert.ok(m);
  const maxScroll = 1000 - 200;
  assert.equal(thumbOffset(0, maxScroll, m.maxOffset), 0);
  assert.equal(thumbOffset(maxScroll, maxScroll, m.maxOffset), m.maxOffset);
  assert.equal(thumbOffset(maxScroll * 2, maxScroll, m.maxOffset), m.maxOffset, '越界要夹住');
  assert.equal(thumbOffset(-50, maxScroll, m.maxOffset), 0);
});

test('拖动换算：拖满整段滑块距离 = 滚满整段内容', () => {
  const m = thumbMetrics({ trackLen: 400, viewLen: 200, contentLen: 1000 });
  assert.ok(m);
  const maxScroll = 1000 - 200;
  // 拖到滑块可走距离的尽头，内容正好滚到底 —— 这两个量本来就不是 1:1
  assert.equal(scrollForThumbDelta(m.maxOffset, maxScroll, m.maxOffset), maxScroll);
  assert.equal(scrollForThumbDelta(0, maxScroll, m.maxOffset), 0);
  // 滑块不可动（内容刚好一屏）时，怎么拖都不滚
  assert.equal(scrollForThumbDelta(30, 500, 0), 0);
});

test('偏移与拖动互为逆运算（同一位置来回换算不漂移）', () => {
  const m = thumbMetrics({ trackLen: 300, viewLen: 120, contentLen: 900 });
  assert.ok(m);
  const maxScroll = 900 - 120;
  for (const p of [0, 0.13, 0.5, 0.87, 1]) {
    const off = thumbOffset(maxScroll * p, maxScroll, m.maxOffset);
    // 允许 1px：thumbOffset 取整过
    assert.ok(Math.abs(scrollForThumbDelta(off, maxScroll, m.maxOffset) - maxScroll * p) <= 2);
  }
});
