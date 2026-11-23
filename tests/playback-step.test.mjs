import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFps, frameStepMs, scrubDurationMs } from '../src/shared/playback-step.js';

test('帧率口径：跟随播放条时不折算', () => {
  assert.equal(effectiveFps(60, 'follow'), 60);
  assert.equal(effectiveFps(50, 'follow'), 50);
  assert.equal(effectiveFps(24, 'follow'), 24);
  // 读不到（0 / NaN）时按 30 兜底，不能除出 Infinity
  assert.equal(effectiveFps(0, 'follow'), 30);
  assert.equal(effectiveFps(undefined, 'follow'), 30);
});

test('帧率口径：自动折半 = 除以 2 直到 ≤30', () => {
  assert.equal(effectiveFps(60, 'auto'), 30);
  assert.equal(effectiveFps(120, 'auto'), 30);
  assert.equal(effectiveFps(50, 'auto'), 25);
  assert.equal(effectiveFps(30, 'auto'), 30);
  assert.equal(effectiveFps(25, 'auto'), 25);
  assert.equal(effectiveFps(24, 'auto'), 24);
});

test('帧率口径：固定 30 / 固定 25 无视播放条', () => {
  assert.equal(effectiveFps(24, '30'), 30);
  assert.equal(effectiveFps(60, '30'), 30);
  assert.equal(effectiveFps(60, '25'), 25);
  assert.equal(effectiveFps(24, '25'), 25);
});

test('一步多长：30fps ≈ 33.3ms、25fps = 40ms、60fps 跟随 ≈ 16.7ms', () => {
  assert.ok(Math.abs(frameStepMs(30, 'follow') - 1000 / 30) < 1e-6);
  assert.equal(frameStepMs(25, 'follow'), 40);
  assert.ok(Math.abs(frameStepMs(60, 'follow') - 1000 / 60) < 1e-6);
  // 60fps 自动折半 = 按 30 算
  assert.ok(Math.abs(frameStepMs(60, 'auto') - 1000 / 30) < 1e-6);
});

test('扫过发声时长：毫秒优先，毫秒为 0 时退回帧率换算', () => {
  assert.equal(scrubDurationMs({ ms: 42, fps: 24, frames: 1, priority: 'ms' }), 42);
  // 留空（0）= 退回「24 帧的 1 帧」≈ 41.67ms
  assert.ok(Math.abs(scrubDurationMs({ ms: 0, fps: 24, frames: 1, priority: 'ms' }) - 1000 / 24) < 1e-6);
  assert.equal(scrubDurationMs({ ms: 120, fps: 30, frames: 2, priority: 'ms' }), 120);
});

test('扫过发声时长：优先帧率时反过来，帧率项为 0 就没有可退的', () => {
  assert.ok(Math.abs(scrubDurationMs({ ms: 200, fps: 30, frames: 1, priority: 'frames' }) - 1000 / 30) < 1e-6);
  assert.equal(scrubDurationMs({ ms: 200, fps: 25, frames: 2, priority: 'frames' }), 80);
  // frames 至少按 1 帧算，不会算出 0
  assert.equal(scrubDurationMs({ ms: 15, fps: 1000, frames: 0, priority: 'frames' }), 1);
});

test('扫过发声时长：非法输入不会变成 NaN', () => {
  const v = scrubDurationMs({ ms: 'x', fps: 'y', frames: 'z', priority: 'ms' });
  assert.ok(Number.isFinite(v) && v > 0, String(v));
});
