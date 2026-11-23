import test from 'node:test';
import assert from 'node:assert/strict';
import { getNumeralStyle, numeral, setNumeralStyle } from '../src/shared/numeral.js';

/**
 * 转位编号的写法：中文两套（汉字 / 阿拉伯），英文固定序数词。
 * **它是模块级全局状态**，所以每个用例前后都要复位 —— 漏了会污染同文件的其它用例。
 */
test('numeral：中文默认汉字，可切阿拉伯', () => {
  setNumeralStyle('han');
  assert.equal(numeral(1, 'zh'), '一');
  assert.equal(numeral(2, 'zh'), '二');
  assert.equal(numeral(3, 'zh'), '三');

  setNumeralStyle('arabic');
  assert.equal(numeral(1, 'zh'), '1');
  assert.equal(numeral(2, 'zh'), '2');
  assert.equal(numeral(3, 'zh'), '3');

  setNumeralStyle('han');
});

test('numeral：英文永远是序数词，跟偏好无关', () => {
  setNumeralStyle('han');
  assert.equal(numeral(1, 'en'), '1st');
  assert.equal(numeral(2, 'en'), '2nd');
  assert.equal(numeral(3, 'en'), '3rd');
  // 切到阿拉伯也不变（英文没有「汉字/阿拉伯」这回事）
  setNumeralStyle('arabic');
  assert.equal(numeral(2, 'en'), '2nd');
  setNumeralStyle('han');
});

test('numeral：越界与脏值都夹到 1..9，不抛', () => {
  setNumeralStyle('han');
  assert.equal(numeral(0, 'zh'), '一');
  assert.equal(numeral(-3, 'zh'), '一');
  assert.equal(numeral(99, 'zh'), '九');
  assert.equal(numeral('2', 'zh'), '二');
  assert.equal(numeral(undefined, 'zh'), '一');
});

test('setNumeralStyle：只认 arabic，其它一律回退 han', () => {
  setNumeralStyle('arabic');
  assert.equal(getNumeralStyle(), 'arabic');
  setNumeralStyle('whatever');
  assert.equal(getNumeralStyle(), 'han');
  setNumeralStyle('han');
});
