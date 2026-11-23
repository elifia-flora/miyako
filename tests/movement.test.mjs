import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMovementTerm,
  hanNumber,
  movementFragment,
  movementMatchToken,
  movementPrefix,
  movementTitlePrefix,
  nextMovementOrdinal,
  parseMovementOrdinal,
  romanNumber,
} from '../src/shared/movement.js';

test('汉字与罗马数字序数', () => {
  assert.equal(hanNumber(1), '一');
  assert.equal(hanNumber(9), '九');
  assert.equal(hanNumber(10), '十');
  assert.equal(hanNumber(11), '十一');
  assert.equal(hanNumber(20), '二十');
  assert.equal(hanNumber(21), '二十一');
  assert.equal(hanNumber(101), '一百零一');
  assert.equal(romanNumber(1), 'I');
  assert.equal(romanNumber(4), 'IV');
  assert.equal(romanNumber(9), 'IX');
  assert.equal(romanNumber(14), 'XIV');
});

test('默认前缀：中文「第三乐章」、英文「III.」', () => {
  assert.equal(movementPrefix(3, 'zh'), '第三乐章');
  assert.equal(movementPrefix(3, 'en'), 'III.');
  assert.equal(movementPrefix(12, 'zh'), '第十二乐章');
});

test('从已有标题认出序号：中文 / 阿拉伯 / 罗马 / Movement 都认', () => {
  assert.equal(parseMovementOrdinal('第三乐章'), 3);
  assert.equal(parseMovementOrdinal('第三乐章 行板'), 3);
  assert.equal(parseMovementOrdinal('第12乐章'), 12);
  assert.equal(parseMovementOrdinal('3. Menuetto'), 3);
  assert.equal(parseMovementOrdinal('III. Menuetto - Allegretto'), 3);
  assert.equal(parseMovementOrdinal('iv) Andante'), 4);
  assert.equal(parseMovementOrdinal('Movement 7'), 7);
  assert.equal(parseMovementOrdinal('行板'), null);
});

test('下一个序号 = 已有序号最大值 + 1（删过乐章也不重号）', () => {
  assert.equal(nextMovementOrdinal([]), 1);
  assert.equal(nextMovementOrdinal(['第一乐章', '第二乐章']), 3);
  assert.equal(nextMovementOrdinal(['第一乐章', '第三乐章']), 4);
  assert.equal(nextMovementOrdinal(['I.', 'III.']), 4);
  assert.equal(nextMovementOrdinal(['行板', '小快板']), 3);
});

test('补全片段只看前缀之后 / 最后一个分隔线之后', () => {
  assert.deepEqual(movementFragment('第三乐章 行板', '第三乐章'), { start: 5, fragment: '行板' });
  assert.deepEqual(movementFragment('第三乐章 ', '第三乐章'), { start: 5, fragment: '' });
  assert.equal(movementFragment('III. Menuetto - All', 'III.').fragment, 'All');
  assert.equal(movementFragment('III. Menuetto - Allegretto', 'III.').fragment, 'Allegretto');
  assert.equal(movementFragment('随便写的标题', '').fragment, '随便写的标题');
});

test('没有显式前缀（右键「更改标题」）时，从标题自己认前缀', () => {
  assert.equal(movementTitlePrefix('第一乐章 行板'), '第一乐章');
  assert.equal(movementTitlePrefix('III. Menuetto - Allegretto'), 'III.');
  assert.equal(movementTitlePrefix('3. Adagio'), '3.');
  assert.equal(movementTitlePrefix('iv) Andante'), 'iv)');
  assert.equal(movementTitlePrefix('行板'), '');
  assert.deepEqual(movementFragment('第一乐章 行'), { start: 5, fragment: '行' });
  assert.equal(movementFragment('III. Menuetto - All').fragment, 'All');
  assert.equal(applyMovementTerm('第一乐章 行', '', '行板'), '第一乐章 行板');
  assert.equal(applyMovementTerm('III. Menuetto', '', 'Allegretto'), 'III. Allegretto');
  assert.equal(applyMovementTerm('第一乐章', '', '行板'), '第一乐章 行板');
});

test('术语插入：只有前缀空格接、已有段用「 - 」、半截输入原地替换', () => {
  assert.equal(applyMovementTerm('第三乐章', '第三乐章', '行板'), '第三乐章 行板');
  assert.equal(applyMovementTerm('第三乐章 ', '第三乐章', '行板'), '第三乐章 行板');
  assert.equal(applyMovementTerm('第三乐章 行板', '第三乐章', '小快板'), '第三乐章 小快板');
  assert.equal(applyMovementTerm('III.', 'III.', 'Menuetto'), 'III. Menuetto');
  assert.equal(applyMovementTerm('III. Menuetto', 'III.', 'Allegretto'), 'III. Allegretto');
  assert.equal(applyMovementTerm('III. Menuetto - All', 'III.', 'Allegretto'), 'III. Menuetto - Allegretto');
  assert.equal(applyMovementTerm('', '', '行板'), '行板');
});

test('movementMatchToken：拼接/带变量时也取到「正在打的那一段」', () => {
  assert.equal(movementMatchToken('Al'), 'Al');
  assert.equal(movementMatchToken('柔板Al'), 'Al');
  assert.equal(movementMatchToken('柔板 - All'), 'All');
  assert.equal(movementMatchToken('%Tempo Term}Al'), 'Al');
  assert.equal(movementMatchToken('小步舞曲'), '小步舞曲');
  assert.equal(movementMatchToken(''), '');
});
