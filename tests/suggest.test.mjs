import test from 'node:test';
import assert from 'node:assert/strict';
import { insertText, pickMode } from '../src/shared/suggest.js';
import { norm, sameText } from '../src/shared/text.js';

const MYSTERIOUS = { id: 'mysterious', name: 'mysterious', display: '神秘' };

test('insertText：中文插 display，英文插 name', () => {
  assert.equal(insertText(MYSTERIOUS, 'zh'), '神秘');
  assert.equal(insertText(MYSTERIOUS, 'en'), 'mysterious');
  // 没有 display 的条目（只登记了规范名）两种语言都退回 name
  assert.equal(insertText({ name: 'rauchprobe' }, 'zh'), 'rauchprobe');
  assert.equal(insertText({ name: 'rauchprobe' }, 'en'), 'rauchprobe');
});

test('pickMode：输入与候选完全一致 → 一次回车就保存', () => {
  // 这就是用户报的那个 bug：打「神秘」时不该再要求按第二次回车
  assert.equal(pickMode('神秘', MYSTERIOUS, 'zh'), 'save');
  assert.equal(pickMode(' 神秘 ', MYSTERIOUS, 'zh'), 'save');
  assert.equal(pickMode('mysterious', MYSTERIOUS, 'en'), 'save');
});

test('pickMode：英文界面下敲中文 → 采纳会改文本，先采纳再保存', () => {
  assert.equal(pickMode('神秘', MYSTERIOUS, 'en'), 'adopt');
  assert.equal(pickMode('mysterious', MYSTERIOUS, 'zh'), 'adopt');
});

test('pickMode：敲别名 / 缩写 → 采纳（文本会变成规范显示名）', () => {
  assert.equal(pickMode('mystery', MYSTERIOUS, 'zh'), 'adopt');
  assert.equal(pickMode('神', MYSTERIOUS, 'zh'), 'adopt');
  assert.equal(pickMode('神秘感', MYSTERIOUS, 'zh'), 'adopt');
});

test('pickMode：没有候选就是保存（直接提交原文）', () => {
  assert.equal(pickMode('神秘', null, 'zh'), 'save');
  assert.equal(pickMode('随便写的', undefined, 'zh'), 'save');
});

test('归一化：全角括号必须和半角算同一个词（这条不过说明 shared/text.js 没被真正用上）', () => {
  assert.equal(pickMode('（神秘）', { display: '(神秘)' }, 'zh'), 'save');
  assert.equal(norm('（神秘）'), '(神秘)');
  assert.equal(norm('  神秘  '), '神秘');
  // 首尾的顿号 / 冒号属于输入噪音，不该算成「改了字」
  assert.equal(norm('、神秘：'), '神秘');
});

test('sameText：空串永远不相等（否则「没输入」会被当成「匹配到空标签」）', () => {
  assert.equal(sameText('', ''), false);
  assert.equal(sameText('  ', ''), false);
  assert.equal(sameText('', '神秘'), false);
  assert.equal(sameText('神 秘', '神 秘'), true);
});
