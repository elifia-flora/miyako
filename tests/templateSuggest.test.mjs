import test from 'node:test';
import assert from 'node:assert/strict';
import { applyVariable, caretToken, suggestVariables } from '../src/shared/templateSuggest.js';

test('caretToken：% 之后就是变量名草稿，替换范围从 % 起', () => {
  assert.deepEqual(caretToken('%c', 2), { start: 0, end: 2, query: 'c', percent: true });
  assert.deepEqual(caretToken('第二乐章 %Sub', 9), { start: 5, end: 9, query: 'Sub', percent: true });
  // 变量名里允许空格（`%Number of the form}`）
  assert.deepEqual(caretToken('x %Number of', 12), { start: 2, end: 12, query: 'Number of', percent: true });
});

test('caretToken：没有 % 时只认光标前那一串字母 / 汉字', () => {
  assert.deepEqual(caretToken('Cp', 2), { start: 0, end: 2, query: 'Cp', percent: false });
  assert.deepEqual(caretToken('前奏 c', 4), { start: 3, end: 4, query: 'c', percent: false });
  // 汉字也算「词」：打「作」要能想到 `%Composer}`（详见下一条）
  assert.deepEqual(caretToken('第二乐章 - 柔板', 9), { start: 7, end: 9, query: '柔板', percent: false });
  assert.equal(caretToken('', 0), null);
});

test('caretToken：`}` 收尾后不再补；百分号紧贴数字时不当变量', () => {
  assert.equal(caretToken('%Composer}', 10), null);
  assert.equal(caretToken('前奏 50%', 7), null);
  assert.equal(caretToken('%', 1)?.query, '');
});

test('suggestVariables：`c` / `Cp` / `%c` 都能想到 %Composer}', () => {
  for (const s of ['c', 'Cp', '%c', '%Cp', 'composer', '作']) {
    const list = suggestVariables(s, s.length);
    assert.ok(
      list.some((x) => x.insert === '%Composer}'),
      `${s} → ${JSON.stringify(list.map((x) => x.insert))}`
    );
  }
});

test('suggestVariables：词首缩写与子序列各自成立，且前缀排在子序列之前', () => {
  assert.equal(suggestVariables('notf', 4)[0].insert, '%Number of the form}');
  const list = suggestVariables('c', 1);
  assert.equal(list[0].insert, '%Composer}');
  assert.ok(list.length <= 6);
});

test('suggestVariables：只打了个 % 时列出全部变量', () => {
  const list = suggestVariables('%', 1, 20);
  assert.equal(list.length, 8);
  assert.equal(list[0].insert, '%Composer}');
  assert.ok(list.every((x) => x.start === 0 && x.end === 1 && x.percent === true));
});

test('suggestVariables：认不出的词一个都不给（不瞎猜）', () => {
  assert.deepEqual(suggestVariables('zzz', 3), []);
  assert.deepEqual(suggestVariables('Cmaj7', 5), []);
});

test('applyVariable：替换草稿段并给出新光标，已打的 % 不会重复', () => {
  const hit = suggestVariables('%c', 2).find((x) => x.insert === '%Composer}');
  assert.deepEqual(applyVariable('%c', hit), { text: '%Composer}', caret: 10 });
  const bare = suggestVariables('a c', 3).find((x) => x.insert === '%Composer}');
  assert.deepEqual(applyVariable('a c', bare), { text: 'a %Composer}', caret: 12 });
});
