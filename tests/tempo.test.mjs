import test from 'node:test';
import assert from 'node:assert/strict';
import { bpmFromTapTimes, TEMPO_MAX, TEMPO_MIN } from '../src/shared/tempo.js';

test('Tap：按 500ms 间隔 = 120 BPM', () => {
  const r = bpmFromTapTimes([0, 500, 1000, 1500]);
  assert.ok(r);
  assert.equal(r.bpm, 120);
  assert.equal(r.taps, 4);
  assert.equal(r.intervals, 3);
});

test('Tap：至少两次；停超过 2 秒从下一次重新算', () => {
  assert.equal(bpmFromTapTimes([0]), null);
  assert.equal(bpmFromTapTimes([]), null);
  // 前两下 500ms，停 2.5s，再两下 400ms → 只算后两下 = 150 BPM
  const r = bpmFromTapTimes([0, 500, 3000, 3400]);
  assert.ok(r);
  assert.equal(r.bpm, 150);
  assert.equal(r.taps, 2);
});

test('Tap：只保留最近 8 次，手抖用平均而不是最后一下', () => {
  const times = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500];
  const r = bpmFromTapTimes(times);
  assert.ok(r);
  assert.equal(r.taps, 8);
  assert.equal(r.bpm, 120);
});

test('Tap：速度超出 20–300 或间隔非法时返回 null', () => {
  assert.equal(bpmFromTapTimes([0, 100]), null);       // 600 BPM
  assert.equal(bpmFromTapTimes([0, 4000]), null);      // 15 BPM / 超时
  assert.equal(bpmFromTapTimes([0, 0]), null);
  // 非数字项被过滤掉，剩下的 [0,500] 仍按 120 计算
  assert.equal(bpmFromTapTimes([0, NaN, 500]).bpm, 120);
  assert.equal(bpmFromTapTimes([0, 300, 600]).bpm, 200);
  assert.equal(TEMPO_MIN, 20);
  assert.equal(TEMPO_MAX, 300);
});
