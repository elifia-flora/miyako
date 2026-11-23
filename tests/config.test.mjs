import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLayout, mergeLayout, normalizeLayout } from '../src/shared/layout.js';

/* ---------------- 归一：坏字段当没记，好字段照用 ---------------- */

test('空对象 / 垃圾输入 → 一张空布局，不抛异常', () => {
  for (const v of [undefined, null, 0, 'x', [], true]) {
    const out = normalizeLayout(v);
    assert.deepEqual(out.main, {});
    // panels 的键总是存在（值可能是 undefined），逐项看
    for (const k of ['leftW', 'rightW', 'panelH', 'leftCollapsed', 'rightCollapsed', 'panelOpen']) {
      assert.equal(out.panels[k], undefined, `${String(v)} 的 panels.${k} 应为空`);
    }
  }
  // 空布局本身也要能被归一（到处都在拿它当默认值）
  assert.deepEqual(normalizeLayout(emptyLayout()).main, {});
});

test('窗口几何：四个数齐全且宽高为正才收，坐标取整', () => {
  const out = normalizeLayout({
    main: { bounds: { x: 10.4, y: -2.6, width: 1200.5, height: 800.2 }, maximized: true },
  });
  assert.deepEqual(out.main.bounds, { x: 10, y: -3, width: 1201, height: 800 });
  assert.equal(out.main.maximized, true);
});

test('窗口几何：缺字段 / 0 宽 / NaN / 字符串都当没记', () => {
  for (const bounds of [
    { x: 0, y: 0, width: 0, height: 500 },
    { x: 0, y: 0, width: 500, height: 0 },
    { x: 0, y: 0, width: 500 },
    { x: '0', y: 0, width: 500, height: 500 },
    { x: 0, y: 0, width: Number.NaN, height: 500 },
    null,
    'oops',
  ]) {
    assert.equal(normalizeLayout({ main: { bounds } }).main.bounds, undefined, JSON.stringify(bounds));
  }
});

test('面板尺寸：只认数字 / 布尔，未知键丢掉', () => {
  const out = normalizeLayout({
    panels: { leftW: 226, rightW: '344', panelH: 260, leftCollapsed: true, rightCollapsed: 0, panelOpen: false, junk: 1 },
  });
  assert.equal(out.panels.leftW, 226);
  assert.equal(out.panels.rightW, undefined);
  assert.equal(out.panels.panelH, 260);
  assert.equal(out.panels.leftCollapsed, true);
  assert.equal(out.panels.rightCollapsed, undefined);
  assert.equal(out.panels.panelOpen, false);
  assert.equal('junk' in out.panels, false);
});

test('独立时间线：几何之外还有泳道侧栏的宽度与开合', () => {
  const out = normalizeLayout({
    grid: { bounds: { x: 0, y: 0, width: 1280, height: 840 }, sideW: 240, sideOpen: false },
  });
  assert.deepEqual(out.grid.bounds, { x: 0, y: 0, width: 1280, height: 840 });
  assert.equal(out.grid.sideW, 240);
  assert.equal(out.grid.sideOpen, false);
});

test('每个子窗口都有自己的槽位（漏一个就等于存了也恢复不回来）', () => {
  const out = normalizeLayout({
    main: { bounds: { x: 0, y: 0, width: 1200, height: 800 } },
    lyrics: { bounds: { x: 1, y: 1, width: 1000, height: 700 } },
    help: { bounds: { x: 2, y: 2, width: 500, height: 350 } },
    history: { bounds: { x: 3, y: 3, width: 560, height: 620 } },
    overlay: { bounds: { x: 4, y: 4, width: 980, height: 190 } },
  });
  for (const k of ['main', 'lyrics', 'help', 'history', 'overlay']) {
    assert.ok(out[k].bounds, `${k} 的 bounds 没留下来`);
  }
});

/* ---------------- 深合并：只覆盖带值的字段 ---------------- */

test('合并补丁：只改带来的那一项，其余保持原样', () => {
  const base = normalizeLayout({
    main: { bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: false },
    panels: { leftW: 226, rightW: 344, panelH: 320 },
  });
  const next = mergeLayout(base, { panels: { leftW: 300 } });
  assert.equal(next.panels.leftW, 300);
  assert.equal(next.panels.rightW, 344);
  assert.equal(next.panels.panelH, 320);
  assert.deepEqual(next.main.bounds, base.main.bounds);
});

test('合并补丁：带 undefined / null 的字段不算「要改」', () => {
  const base = normalizeLayout({ panels: { leftW: 226 } });
  const next = mergeLayout(base, { panels: { leftW: undefined, panelH: null } });
  assert.equal(next.panels.leftW, 226);
  assert.equal(next.panels.panelH, undefined);
});

test('合并补丁：垃圾补丁不会清空已有布局', () => {
  const base = normalizeLayout({ panels: { leftW: 226 }, grid: { sideW: 210 } });
  for (const patch of [undefined, null, 5, 'x', []]) {
    const next = mergeLayout(base, patch);
    assert.equal(next.panels.leftW, 226);
    assert.equal(next.grid.sideW, 210);
  }
});

test('合并后仍然过一遍归一：手改出来的坏几何不会被合并带进内存', () => {
  const base = normalizeLayout({ panels: { leftW: 226 } });
  const next = mergeLayout(base, { main: { bounds: { x: 0, y: 0, width: 0, height: 800 } } });
  assert.equal(next.main.bounds, undefined);
  assert.equal(next.panels.leftW, 226);
});

test('窗口几何可以单独换掉（工作区 / 拖动窗口都走这条）', () => {
  const base = normalizeLayout({ main: { bounds: { x: 0, y: 0, width: 1200, height: 800 } } });
  const next = mergeLayout(base, { main: { bounds: { x: 100, y: 50, width: 1400, height: 900 } } });
  assert.deepEqual(next.main.bounds, { x: 100, y: 50, width: 1400, height: 900 });
});
