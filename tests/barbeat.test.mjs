import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barBeatToTick,
  barToTick,
  computeStartBars,
  formatBarBeatSub,
  formatMs,
  formatTimecode,
  parseMsText,
  parseTimecode,
  tickToBarBeatSub,
  markerAt,
  msToTick,
  parseMeter,
  tickToAudioMs,
  tickToBarBeat,
  tickToMs,
} from '../src/shared/barbeat.js';

const PPQ = 480;
const meters = computeStartBars([{ tick: 0, num: 3, den: 4 }], PPQ);
const tempos = [{ tick: 0, bpm: 107 }];

const close = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('3/4 下第 12 小节首拍 = 15840 tick', () => {
  assert.equal(barToTick(meters, 12, PPQ), 15840);
  assert.deepEqual(tickToBarBeat(meters, 15840, PPQ), { bar: 12, beat: 1, off: 0 });
});

test('3/4 下第 106 小节首拍 = 151200 tick', () => {
  assert.equal(barToTick(meters, 106, PPQ), 151200);
  assert.equal(tickToBarBeat(meters, 151200, PPQ).bar, 106);
});

test('107 BPM 下 106 小节起点 ≈ 176.61s（这是 coda 起点，不是全长）', () => {
  assert.ok(close(tickToMs(tempos, 151200, PPQ) / 1000, 176.64, 0.02));
});

test('186s 全长 ≈ 110.6 小节，与「coda 从 106 起」自洽', () => {
  const barSec = (3 * 480 * 60) / (107 * 480);
  assert.ok(close(186 / barSec, 110.6, 0.1));
});

test('audio_offset_ms=1500 时，第 1 小节首拍落在音频 1.5s', () => {
  assert.equal(tickToAudioMs(tempos, 0, 1500, PPQ), 1500);
  assert.equal(tickToAudioMs(tempos, 151200, 0, PPQ), tickToMs(tempos, 151200, PPQ));
});

test('变拍：3/4 走 8 小节后转 6/8，startBar 继续累加', () => {
  const m = computeStartBars(
    [
      { tick: 0, num: 3, den: 4 },
      { tick: 8 * 1440, num: 6, den: 8 },
    ],
    PPQ
  );
  assert.equal(m[1].startBar, 9);
  assert.equal(m[1].barLen, 6 * 480 * 4 / 8);
  // 6/8 的"拍"是八分音符（240 tick），第 1 拍与第 4 拍是重音位
  assert.equal(tickToBarBeat(m, 8 * 1440, PPQ).beat, 1);
  assert.equal(tickToBarBeat(m, 8 * 1440 + 3 * 240, PPQ).beat, 4);
});

test('tickToBarBeat 的 off 是拍内 tick 偏移', () => {
  assert.deepEqual(tickToBarBeat(meters, 1440 + 480 + 240, PPQ), { bar: 2, beat: 2, off: 240 });
});

test('markerAt 取最后一个 tick <= 目标', () => {
  const list = [{ tick: 0 }, { tick: 100 }, { tick: 200 }];
  assert.equal(markerAt(list, 0).tick, 0);
  assert.equal(markerAt(list, 150).tick, 100);
  assert.equal(markerAt(list, 999).tick, 200);
});

test('parseMeter 容错', () => {
  assert.deepEqual(parseMeter('3/4'), { num: 3, den: 4 });
  assert.deepEqual(parseMeter('听起来像 6/8'), { num: 6, den: 8 });
  assert.deepEqual(parseMeter(undefined), { num: 4, den: 4 });
});

test('formatMs 保留毫秒', () => {
  assert.equal(formatMs(176635), '2:56.635');
  assert.equal(formatMs(0), '0:00.000');
  assert.equal(formatMs(1005), '0:01.005');
});

test('formatTimecode：HH:MM:SS:FF，按帧向下取整', () => {
  assert.equal(formatTimecode(0, 30), '00:00:00:00');
  assert.equal(formatTimecode(1000, 30), '00:00:01:00');
  assert.equal(formatTimecode(1033, 30), '00:00:01:00');
  assert.equal(formatTimecode(1034, 30), '00:00:01:01');
  assert.equal(formatTimecode(60_000, 25), '00:01:00:00');
  assert.equal(formatTimecode(3_661_000, 30), '01:01:01:00');
  // 负位置按 0 处理（播放头不会显示成负时间码）
  assert.equal(formatTimecode(-500, 30), '00:00:00:00');
  // 除了每秒帧数，还要能换帧率
  assert.equal(formatTimecode(1040, 25), '00:00:01:01');
  assert.equal(formatTimecode(1000, 60), '00:00:01:00');
});

test('msToTick 是 tickToMs 的反函数（含变速度）', () => {
  const tempos = [
    { tick: 0, bpm: 107 },
    { tick: 14400, bpm: 90 }, // 第 11 小节换速度
  ];
  for (const tick of [0, 480, 1440, 14399, 14400, 15840, 36000, 79200]) {
    const ms = tickToMs(tempos, tick, PPQ);
    assert.ok(Math.abs(msToTick(tempos, ms, PPQ) - tick) <= 1, `tick ${tick}`);
  }
});

test('msToTick 允许负值：音频早于第 1 小节时播放头落在原点左侧', () => {
  const tempos = [{ tick: 0, bpm: 120 }];
  assert.equal(msToTick(tempos, -500, PPQ), -480); // 120BPM：一拍 500ms
});

test('audio_offset_ms：tick 0 落在 offset 处，反解回 tick 0', () => {
  const tempos = [{ tick: 0, bpm: 107 }];
  const offset = 1500;
  const ms = tickToAudioMs(tempos, 0, offset, PPQ);
  assert.equal(ms, 1500);
  assert.equal(msToTick(tempos, ms - offset, PPQ), 0);
  // 第 12 小节首拍 = 18.5s 左右（计划文档里的换算）
  const a1 = tickToAudioMs(tempos, 15840, offset, PPQ);
  assert.equal(msToTick(tempos, a1 - offset, PPQ), 15840);
});

/**
 * 「小节.拍.十六分.tick」：前三段 1 起，最后一段是十六分内部的 120 进制 tick。
 * 这条同时守着「不补零」—— 补零是界面的活（固定宽度格子），不是格式化函数的活。
 */
test('小节.拍.十六分.tick：1 起 / 末位 0 起 / 不补零', () => {
  const m = computeStartBars([{ tick: 0, num: 4, den: 4 }], 480);
  assert.equal(formatBarBeatSub(m, 0, 480), '1.1.1.0');
  assert.equal(formatBarBeatSub(m, 480, 480), '1.2.1.0');       // 一拍 = 480
  assert.equal(formatBarBeatSub(m, 1920, 480), '2.1.1.0');      // 一小节 = 1920
  assert.equal(formatBarBeatSub(m, 19200, 480), '11.1.1.0');    // Sibyl 的 A1
  assert.equal(formatBarBeatSub(m, 1439, 480), '1.3.4.119');    // 拍内最后一个 tick
  assert.equal(formatBarBeatSub(m, 120, 480), '1.1.2.0');       // 一个十六分 = 120

  // 1500 = 第 4 拍（1440）之后的第 60 tick，还在这一拍的第 1 个十六分里
  const p = tickToBarBeatSub(m, 1500, 480);
  assert.deepEqual(p, { bar: 1, beat: 4, sixteenth: 1, sub: 60 });

  // 3/4：一小节只有 3 拍，第 4 拍属于下一小节
  const m3 = computeStartBars([{ tick: 0, num: 3, den: 4 }], 480);
  assert.equal(formatBarBeatSub(m3, 1440, 480), '2.1.1.0');

  // 末位不能出现 120（越界要进位，否则读起来像「第 5 拍第 120 tick」）
  for (let t = 0; t < 4000; t += 7) {
    const q = tickToBarBeatSub(m, t, 480);
    assert.ok(q.sub >= 0 && q.sub < 120, `sub=${q.sub} @${t}`);
    assert.ok(q.sixteenth >= 1 && q.sixteenth <= 4, `sixteenth=${q.sixteenth} @${t}`);
  }
});

/* ---- 播放条读数反解（v0.62：点数字改位置） ---- */

test('读数反解：小节.拍.十六分.tick → tick，缺段按 1/0 补', () => {
  const meters = computeStartBars([{ tick: 0, num: 4, den: 4 }], 480);
  // 第 11 小节第 2 拍第 3 个十六分的第 45 tick
  assert.equal(barBeatToTick(meters, '11.2.3.45', 480), 10 * 1920 + 1 * 480 + 2 * 120 + 45);
  assert.equal(barBeatToTick(meters, '1', 480), 0);
  assert.equal(barBeatToTick(meters, '1.2', 480), 480);
  // 越界不夹：4/4 里写第 5 拍 = 下一小节第 1 拍
  assert.equal(barBeatToTick(meters, '1.5', 480), 1920);
  // 写坏了返回 null，界面保持原位
  assert.equal(barBeatToTick(meters, 'abc', 480), null);
  assert.equal(barBeatToTick(meters, '1.2.3.4.5', 480), null);
});

test('读数反解：时间码 HH:MM:SS:FF → 毫秒（帧率可配）', () => {
  assert.equal(parseTimecode('00:01:23:15', 30), 83500); // 15 帧 = 0.5 秒
  assert.equal(parseTimecode('00:00:10:00', 25), 10000);
  assert.equal(parseTimecode('1:02:03', 30), 3723000); // 三段写法，帧按 0
  assert.equal(parseTimecode('00:01:83:00', 30), null); // 秒越界
  assert.equal(parseTimecode('00:00:01:30', 30), null); // 帧号 = 帧率，越界
});

test('读数反解：m:ss.mmm 与纯秒数都认', () => {
  assert.equal(parseMsText('1:23.456'), 83456);
  assert.equal(parseMsText('1:23'), 83000);
  assert.equal(parseMsText('83.5'), 83500); // 纯秒数
  assert.equal(parseMsText('1:75'), null); // 秒越界
  assert.equal(parseMsText(''), null);
});
