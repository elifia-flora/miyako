import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeTrackFileBase, trackFileCandidates } from '../src/shared/trackfile.js';

/**
 * 文件名规则的用例都盯着真实的 Windows 行为：
 * 这些字符在资源管理器里根本建不出来，而「写进去了但读不回来」比直接报错更难查。
 */

test('非法字符替换成下划线', () => {
  assert.equal(sanitizeTrackFileBase('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
});

test('结尾的点和空格会被 Windows 吃掉，必须提前去掉', () => {
  assert.equal(sanitizeTrackFileBase('结尾有点...'), '结尾有点');
  assert.equal(sanitizeTrackFileBase('  带空格的曲名  '), '带空格的曲名');
});

test('空标题有兜底名字，不会变成 ".json"', () => {
  assert.equal(sanitizeTrackFileBase(''), '未命名作品');
  assert.equal(sanitizeTrackFileBase('   '), '未命名作品');
  assert.equal(sanitizeTrackFileBase(null), '未命名作品');
});

test('Windows 保留设备名要加前缀', () => {
  assert.equal(sanitizeTrackFileBase('CON'), '_CON');
  assert.equal(sanitizeTrackFileBase('lpt1'), '_lpt1');
  // 只是包含保留词不算
  assert.equal(sanitizeTrackFileBase('console'), 'console');
});

test('超长标题截断，避免整个路径超限', () => {
  const long = '长'.repeat(400);
  assert.equal(sanitizeTrackFileBase(long).length, 120);
});

test('候选名的第一个永远是纯曲名', () => {
  const names = trackFileCandidates('神鹿谣', 'tr-mvddivatpwe');
  assert.equal(names[0], '神鹿谣.json');
});

test('同名冲突用 id 尾段区分，且与曲名前缀无关', () => {
  assert.deepEqual(trackFileCandidates('未命名作品', 'tr-abc123').slice(0, 2), [
    '未命名作品.json',
    '未命名作品 (abc123).json',
  ]);
  // trk- 也是同一个尾段规则
  assert.equal(trackFileCandidates('神鹿谣', 'trk-1d1ss57')[1], '神鹿谣 (1d1ss57).json');
});

test('没有 id 时只有纯曲名一个候选', () => {
  assert.deepEqual(trackFileCandidates('神鹿谣', ''), ['神鹿谣.json']);
});
