import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePeaks, encodePeaks, peaksBytes } from '../src/shared/wavecodec.js';
import { ByteLru } from '../src/shared/wavelru.js';

/**
 * 缓存这两块都不能只看「大概能跑」：
 * 编码器错一个字节，波形就整体错位；LRU 差一个等号，占用就永远卡在上限上。
 */

function fakePeaks() {
  const l0 = 40;
  const l1 = 20;
  return {
    duration: 12.5,
    sampleRate: 44100,
    channels: 2,
    peaksAbsMax: 0.82,
    levels: [
      {
        bucket: 16,
        min: Float32Array.from({ length: l0 }, (_, i) => -((i % 7) / 10)),
        max: Float32Array.from({ length: l0 }, (_, i) => (i % 5) / 8),
      },
      {
        bucket: 32,
        min: Float32Array.from({ length: l1 }, (_, i) => -((i % 3) / 4)),
        max: Float32Array.from({ length: l1 }, (_, i) => (i % 4) / 6),
      },
    ],
  };
}

test('编码 → 解码：元数据与两级峰值都原样回来', () => {
  const src = fakePeaks();
  const back = decodePeaks(encodePeaks(src));
  assert.ok(back);
  assert.equal(back.duration, src.duration);
  assert.equal(back.sampleRate, 44100);
  assert.equal(back.channels, 2);
  assert.ok(Math.abs(back.peaksAbsMax - 0.82) < 1e-6);
  assert.equal(back.levels.length, 2);
  for (let i = 0; i < src.levels.length; i++) {
    assert.equal(back.levels[i].bucket, src.levels[i].bucket);
    assert.deepEqual([...back.levels[i].min], [...src.levels[i].min]);
    assert.deepEqual([...back.levels[i].max], [...src.levels[i].max]);
  }
});

test('header 不是 4 的倍数时靠补齐对齐（否则 Float32Array 直接抛 RangeError）', () => {
  // 让 JSON 长度落在各种余数上，逐个过一遍
  for (const duration of [1, 12.25, 123.456, 1234.5678, 99999.125]) {
    const src = fakePeaks();
    src.duration = duration;
    const bytes = encodePeaks(src);
    assert.equal(bytes.byteOffset % 4, 0);
    assert.ok(decodePeaks(bytes), `duration=${duration} 应该能解出来`);
  }
});

test('坏数据一律返回 null，不抛错（缓存坏了只该多解码一次）', () => {
  assert.equal(decodePeaks(null), null);
  assert.equal(decodePeaks(new Uint8Array(0)), null);
  assert.equal(decodePeaks(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  // 头部声称 1000 字节，实际只有 20
  const bad = new Uint8Array(20);
  new DataView(bad.buffer).setUint32(0, 0x57415631, true);
  new DataView(bad.buffer).setUint32(4, 1000, true);
  assert.equal(decodePeaks(bad), null);
});

test('peaksBytes：与两级实际字节数一致（用来估预算）', () => {
  const src = fakePeaks();
  const want = (40 + 20) * 2 * 4;
  assert.ok(peaksBytes(src) >= want && peaksBytes(src) < want + 1024);
});

test('LRU：插入后总量严格小于上限（不是 ≤）', () => {
  const lru = new ByteLru(100);
  assert.equal(lru.set('a', 'A', 30), true);
  assert.equal(lru.set('b', 'B', 30), true);
  assert.equal(lru.set('c', 'C', 30), true);
  assert.equal(lru.bytes, 90);
  // 90 + 30 = 120 ≥ 100 → 先淘汰最旧的，塞进新的一条
  assert.equal(lru.set('d', 'D', 30), true);
  assert.equal(lru.bytes, 90);
  assert.equal(lru.size, 3);
  assert.deepEqual(
    lru.entries().map((e) => e.key),
    ['b', 'c', 'd']
  );
});

test('LRU：命中会刷新顺序，淘汰的是真正最久没用过的那条', () => {
  const lru = new ByteLru(100);
  lru.set('a', 'A', 30);
  lru.set('b', 'B', 30);
  lru.set('c', 'C', 30);
  assert.equal(lru.get('a'), 'A'); // a 变成「最近用过」
  lru.set('d', 'D', 30); // 该淘汰 b
  assert.deepEqual(
    lru.entries().map((e) => e.key),
    ['c', 'a', 'd']
  );
});

test('LRU：单份就超预算时不收（否则它立刻把自己挤掉，白忙一场）', () => {
  const lru = new ByteLru(100);
  assert.equal(lru.set('big', 'X', 100), false);
  assert.equal(lru.size, 0);
  assert.equal(lru.set('ok', 'Y', 40), true);
  assert.equal(lru.set('big', 'X', 100), false);
  assert.equal(lru.size, 1, '已有条目不该被一次失败的插入影响');
});

test('LRU：上限改成 0 立即清空；调小立即按新预算淘汰', () => {
  const lru = new ByteLru(200);
  lru.set('a', 1, 60);
  lru.set('b', 2, 60);
  lru.set('c', 3, 60);
  lru.setLimit(100);
  assert.ok(lru.bytes < 100, `调小后应该严格小于 100，实际 ${lru.bytes}`);
  lru.setLimit(0);
  assert.equal(lru.size, 0);
  assert.equal(lru.bytes, 0);
  assert.equal(lru.set('a', 1, 10), false);
});
