import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimelineClock, timelineDurationMs } from '../src/shared/timeline-clock.js';
import { msToTick, tickToMs } from '../src/shared/barbeat.js';

const analysis = { ppq: 480, tempoValue: 120, audioOffsetMs: 0, markers: [], events: [] };

test('仅时间线使用单调时钟，不累计帧数；掉帧后直接到正确位置', () => {
  let now = 100;
  const clock = createTimelineClock(() => now);
  clock.setDuration(10000);
  clock.play();
  now += 1234;
  assert.equal(clock.position(), 1234);
  now += 4000;
  assert.equal(clock.position(), 5234);
});

test('暂停冻结，续播/重复播放不重置时间', () => {
  let now = 0;
  const clock = createTimelineClock(() => now);
  clock.setDuration(10000);
  clock.play();
  now = 500;
  clock.play();
  assert.equal(clock.pause(), 500);
  now = 9000;
  assert.equal(clock.position(), 500);
  clock.play();
  now += 250;
  assert.equal(clock.position(), 750);
});

test('暂停/播放中跳转，末尾夹取与重播', () => {
  let now = 0;
  const clock = createTimelineClock(() => now);
  clock.setDuration(1000);
  assert.equal(clock.seek(-1), 0);
  clock.seek(100);
  clock.play();
  now = 200;
  clock.seek(600);
  now += 100;
  assert.equal(clock.position(), 700);
  now += 10000;
  assert.equal(clock.position(), 1000);
  clock.pause();
  clock.play();
  assert.equal(clock.position(), 0);
  assert.equal(clock.seek(Infinity), 0);
});

test('改变时长保留当前位置，缩短到播放头之前则停在新终点', () => {
  let now = 0;
  const clock = createTimelineClock(() => now);
  clock.setDuration(1000);
  clock.play();
  now = 700;
  clock.setDuration(2000);
  now += 50;
  assert.equal(clock.position(), 750);
  clock.setDuration(500);
  now += 100;
  assert.equal(clock.position(), 500);
});

test('空分析不可播放，空白档案按48小节/120 BPM计算', () => {
  assert.equal(timelineDurationMs(null), 0);
  assert.equal(timelineDurationMs(analysis), 96000);
  assert.equal(timelineDurationMs(analysis, 95000), 95000);
});

test('时长随拍号、速度和原点变化，覆盖远处事件终点', () => {
  assert.equal(timelineDurationMs({ ...analysis, meterNum: 3, meterDen: 4, tempoValue: 60, audioOffsetMs: 500 }), 144500);
  const long = { ...analysis, events: [{ tick: 480 * 4 * 80, durTicks: 960 }] };
  assert.ok(timelineDurationMs(long) > tickToMs([{ tick: 0, bpm: 120 }], long.events[0].tick + 960));
});

test('变拍变速的默认时长可计算，输入标注保持不变', () => {
  const doc = { ...analysis, markers: [{kind:'meter',tick:0,num:4,den:4}, {kind:'meter',tick:7680,num:3,den:4}, {kind:'tempo',tick:0,bpm:120}, {kind:'tempo',tick:7680,bpm:60}] };
  const before = JSON.stringify(doc);
  assert.equal(timelineDurationMs(doc), 8000 + 44 * 3000);
  assert.equal(JSON.stringify(doc), before);
});

for (const bpm of [130, 107]) {
  test(`手动偏移对齐：${bpm} BPM 的和弦起点映射往返`, () => {
    const tempos = [{ tick: 0, bpm }];
    const offset = 1250;
    for (const tick of [0, 480, 1440, 1920, 480 * 100]) {
      const ms = tickToMs(tempos, tick, 480) + offset;
      assert.ok(Math.abs(msToTick(tempos, ms - offset, 480) - tick) < 1e-8);
    }
  });
}
