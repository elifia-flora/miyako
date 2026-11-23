import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKeyName } from '../src/shared/chord.js';
import { parseKeyRoot, suggestKeyNames } from '../src/shared/keyname.js';

const values = (input, locale = 'zh', limit = 8) => suggestKeyNames(input, locale, limit).map((x) => x.value);

test('只敲音名：先给大调与自然小调', () => {
  const list = suggestKeyNames('c');
  assert.equal(list[0].value, 'c major');
  assert.ok(list.some((x) => x.value === 'c natural minor'));
  assert.equal(suggestKeyNames('')[0], undefined);
});

test('音名 + 调式前缀', () => {
  assert.deepEqual(values('c dor'), ['c dorian']);
  assert.deepEqual(values('c 多利'), ['c dorian']);
  assert.equal(values('c natural min')[0], 'c natural minor');
  assert.equal(values('c harm')[0], 'c harmonic minor');
});

test('升降号：库里的写法是 c-sharp / e-flat，不能输出 c# / eb', () => {
  assert.equal(values('c#')[0], 'c-sharp major');
  assert.equal(values('C# 自然小调')[0], 'c-sharp natural minor');
  assert.equal(values('db')[0], 'd-flat major');
  assert.equal(values('bb')[0], 'b-flat major');
  assert.equal(values('e-flat harm')[0], 'e-flat harmonic minor');
  // 中文升降号写在前面也要认
  assert.equal(values('降e')[0], 'e-flat major');
  assert.equal(values('升c 小调')[0], 'c-sharp minor');
});

test('认不出的输入返回空数组（自由输入照存，不猜）', () => {
  assert.deepEqual(values('h'), []);
  assert.deepEqual(values('#'), []);
  assert.deepEqual(values('随便写的'), []);
  // 调式对不上也返回空，而不是硬塞一个默认调式
  assert.deepEqual(values('c zzz'), []);
});

test('大小写与多余空格不影响结果', () => {
  assert.equal(values('C DORIAN')[0], 'c dorian');
  assert.equal(values('  c   dor  ')[0], 'c dorian');
});

test('limit 生效', () => {
  assert.equal(suggestKeyNames('c', 'zh', 3).length, 3);
  assert.equal(suggestKeyNames('c', 'zh', 1).length, 1);
});

test('label 跟着语言走，且英文 label 不含汉字', () => {
  const zh = suggestKeyNames('c dorian', 'zh')[0];
  const en = suggestKeyNames('c dorian', 'en')[0];
  assert.equal(zh.value, en.value);
  assert.match(zh.label, /多利亚/);
  assert.match(en.label, /Dorian/);
  assert.ok(!/[\u4e00-\u9fa5]/.test(en.label));
});

test('root 解析：字母 + 可选升降号，剩余部分是调式查询', () => {
  assert.deepEqual(parseKeyRoot('c'), { letter: 'c', acc: '', rest: '' });
  assert.deepEqual(parseKeyRoot('c-sharp natural minor'), { letter: 'c', acc: 'sharp', rest: 'natural minor' });
  assert.deepEqual(parseKeyRoot('bb'), { letter: 'b', acc: 'flat', rest: '' });
  assert.deepEqual(parseKeyRoot('b major'), { letter: 'b', acc: '', rest: 'major' });
  assert.equal(parseKeyRoot('h'), null);
});

test('round-trip：每个候选的 value 喂回 parseKeyName 必须解析成同一个音与调式', () => {
  const inputs = ['c', 'c dor', 'c# 自然小调', '降e', 'bb', 'f-sharp lyd', 'a 小调'];
  for (const input of inputs) {
    for (const item of suggestKeyNames(input, 'zh', 8)) {
      const parsed = parseKeyName(item.value);
      assert.ok(parsed, `解析不了：${item.value}`);
      assert.equal(parsed.mode, item.mode, `调式对不上：${item.value}`);
      // 主音写法必须与 root 一致（parseKeyName 只认 sharp / flat 两种词）
      assert.ok(item.value.startsWith(`${item.root} `), `主音对不上：${item.value}`);
      const rootPc = parseKeyName(`${item.root} major`).pc;
      assert.equal(parsed.pc, rootPc, `音高对不上：${item.value}`);
    }
  }
});
