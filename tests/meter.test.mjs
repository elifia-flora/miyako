import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMeter,
  meterInfo,
  meterSystemForLocale,
  readMeter,
} from '../src/shared/meter.js';
import { normalizeLang } from '../src/shared/lang.js';

/* ---------------- 体系选择 ---------------- */

test('界面语言决定术语体系：中文 → 中/苏/德奥，其余 → 英美', () => {
  assert.equal(meterSystemForLocale('zh'), 'cn');
  assert.equal(meterSystemForLocale('zh-CN'), 'cn');
  assert.equal(meterSystemForLocale('en'), 'us');
  assert.equal(meterSystemForLocale('en-US'), 'us');
  assert.equal(meterSystemForLocale(''), 'us');
});

/* ---------------- 两套体系一致的部分 ---------------- */

test('2/4、3/4 两套都算单拍子', () => {
  for (const sys of ['cn', 'us']) {
    for (const n of [2, 3]) {
      const c = classifyMeter(n, 4, sys);
      assert.equal(c.kind, 'simple', `${n}/4 @ ${sys}`);
      assert.equal(c.ambiguous, false);
    }
  }
});

test('6/8、9/8、12/8 两套都算复拍子', () => {
  for (const sys of ['cn', 'us']) {
    for (const [n, d] of [[6, 8], [9, 8], [12, 8], [6, 4]]) {
      const c = classifyMeter(n, d, sys);
      assert.equal(c.kind, 'compound', `${n}/${d} @ ${sys}`);
      assert.equal(c.ambiguous, false, '两套结论一样，不该挂 ⓘ');
    }
  }
});

test('5/8、7/8 两套都算混合（不规则）拍子，5/4 同理', () => {
  for (const sys of ['cn', 'us']) {
    for (const [n, d] of [[5, 8], [7, 8], [5, 4], [8, 8], [11, 8]]) {
      const c = classifyMeter(n, d, sys);
      assert.equal(c.kind, 'mixed', `${n}/${d} @ ${sys}`);
      assert.equal(c.ambiguous, false);
    }
  }
});

/* ---------------- 分岔点：分子 4 ---------------- */

test('4/4：中文体系 = 复拍子，英美体系 = 单拍子（同一串数字，两个答案）', () => {
  const cn = classifyMeter(4, 4, 'cn');
  const us = classifyMeter(4, 4, 'us');
  assert.equal(cn.kind, 'compound');
  assert.equal(us.kind, 'simple');
  // 两个方向都要报「有歧义」并说清另一套怎么叫
  assert.equal(cn.ambiguous, true);
  assert.deepEqual(cn.alt, { system: 'us', kind: 'simple' });
  assert.equal(us.ambiguous, true);
  assert.deepEqual(us.alt, { system: 'cn', kind: 'compound' });
});

test('4/2、4/8 与 4/4 同结论（判据只看分子）', () => {
  assert.equal(classifyMeter(4, 2, 'cn').kind, 'compound');
  assert.equal(classifyMeter(4, 8, 'us').kind, 'simple');
  assert.equal(classifyMeter(4, 8, 'cn').ambiguous, true);
});

/* ---------------- 展示层要的三个键 ---------------- */

test('meterInfo：标签键随类型走，ⓘ 说明只在有歧义时出现', () => {
  const cn44 = meterInfo('4/4', 'cn');
  assert.equal(cn44.kindKey, 'meter.kind.compound');
  assert.equal(cn44.noteKey, 'meter.note.4');
  assert.equal(cn44.num, 4);

  const us44 = meterInfo('4/4', 'us');
  assert.equal(us44.kindKey, 'meter.kind.simple');
  assert.equal(us44.noteKey, 'meter.note.4');

  const cn34 = meterInfo('3/4', 'cn');
  assert.equal(cn34.kindKey, 'meter.kind.simple');
  assert.equal(cn34.noteKey, null);

  assert.equal(meterInfo('', 'cn'), null);
  assert.equal(meterInfo('C', 'cn'), null, 'C / cut time 这类记号不属于这里的规则');
});

test('readMeter 容忍空白，拒绝非法值', () => {
  assert.deepEqual(readMeter(' 3 / 4 '), { num: 3, den: 4 });
  assert.equal(readMeter('4/0'), null);
  assert.equal(readMeter('4/4/4'), null);
});

/* ---------------- 语言代码 ---------------- */

test('normalizeLang：全名 / 代码 / 带地区后缀都归一到主语言', () => {
  assert.equal(normalizeLang('English'), 'en');
  assert.equal(normalizeLang('English '), 'en');
  assert.equal(normalizeLang('ja'), 'ja');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('zh-Hant'), 'zh');
  assert.equal(normalizeLang('Japanese'), 'ja');
  assert.equal(normalizeLang('Chinese'), 'zh');
  assert.equal(normalizeLang('Cantonese'), 'yue');
  assert.equal(normalizeLang(''), null);
  assert.equal(normalizeLang(null), null);
  assert.equal(normalizeLang('Klingon'), null, '认不出的名字不猜，返回 null');
});
