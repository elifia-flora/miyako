import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChord } from '../src/shared/chord.js';
import { letterFromRoman, letterFromDegreeText } from '../src/shared/chordletter.js';

/**
 * 级数 → 字母和弦的**反向拼写**。
 *
 * 这里是「从级数标记获取字母和弦」的底座：界面上按一次菜单，就是把这套翻译跑一遍整首。
 * 所以每条断言都在守同一件事：**拼出来的和弦，音级集合必须和级数解析出来的一模一样**。
 * 拼不出宁可返回 null（界面会跳过并报数），也不能给一个「看着像」的错和弦。
 */

const KEY = { key: 'c major' };

test('大三 / 小三 / 七和弦：V7 → G7、vi → Am、ii7 → Dm7', () => {
  assert.equal(letterFromDegreeText('V7', KEY), 'G7');
  assert.equal(letterFromDegreeText('V', KEY), 'G');
  assert.equal(letterFromDegreeText('vi', KEY), 'Am');
  assert.equal(letterFromDegreeText('ii7', KEY), 'Dm7');
  assert.equal(letterFromDegreeText('Imaj7', KEY), 'Cmaj7');
});

test('转位写成斜杠低音：I6 → C/E、V42 → G7/F', () => {
  assert.equal(letterFromDegreeText('I6', KEY), 'C/E');
  assert.equal(letterFromDegreeText('V42', KEY), 'G7/F');
  assert.equal(letterFromDegreeText('iiø42', KEY), 'Dm7♭5/C');
});

test('那不勒斯与副属：N6 → D♭/F、V6/iv → C/E', () => {
  assert.equal(letterFromDegreeText('N6', KEY), 'D♭/F');
  assert.equal(letterFromDegreeText('V6/iv', KEY), 'C/E');
  // 分子按临时主音的音阶拼写，根音不能落到「听起来对、写出来错」的音上
  assert.equal(letterFromDegreeText('iii6/III', { key: 'e♭ minor' }), 'B♭m/D♭');
});

test('挂留与延伸音：V7sus4 → G7sus4、V9sus4 → G9sus4、V9 → G9', () => {
  assert.equal(letterFromDegreeText('V7sus4', KEY), 'G7sus4');
  assert.equal(letterFromDegreeText('V9sus4', KEY), 'G9sus4');
  assert.equal(letterFromDegreeText('V9', KEY), 'G9');
  assert.equal(letterFromDegreeText('Vadd9', KEY), 'Gadd9');
});

test('六音替五音：V7sub6 → G7sub6', () => {
  assert.equal(letterFromDegreeText('V7sub6', KEY), 'G7sub6');
});

test('终止四六算不出来 → null（rootName 是 V、实际和弦是 I 6/4，拼 G 会得到 G–B–D）', () => {
  assert.equal(letterFromDegreeText('Cad64', KEY), null);
});

test('不是级数 / 解析失败 → null（字母和弦本身不该被「翻译」）', () => {
  assert.equal(letterFromDegreeText('G7', KEY), null);
  assert.equal(letterFromDegreeText('乱写', KEY), null);
  assert.equal(letterFromRoman(null), null);
});

test('每一条能翻译的，回头解析出来的音级集合与低音都必须和原级数一致', () => {
  const list = ['V7', 'V', 'vi', 'iiø42', 'I6', 'V42', 'N6', 'V6/iv', 'V7sus4', 'V9sus4', 'V9', 'V7sub6', 'iii7', '♭II'];
  for (const text of list) {
    const src = parseChord(text, KEY);
    const out = letterFromRoman(src);
    assert.ok(out, `${text} 应该能翻译`);
    const back = parseChord(out);
    assert.equal(back.kind, 'absolute', `${text} → ${out} 应解析成绝对和弦`);
    const set = (p) => [...new Set(p.pcs.map((n) => ((n % 12) + 12) % 12))].sort((a, b) => a - b).join(',');
    assert.equal(set(back), set(src), `${text} → ${out} 音级集合不一致`);
    assert.equal(((back.bassPc ?? 0) % 12), ((src.bassPc ?? 0) % 12), `${text} → ${out} 低音不一致`);
  }
});

test('极端变音按调性拼写，且音级守恒：♭II 在 e♭ 小调是 F♭ 大三，不是 F', () => {
  const out = letterFromDegreeText('♭II', { key: 'e♭ minor' });
  // 拼写跟着调走（F♭ 而不是 E），所以这里只锁「不是 F」和音级守恒，不锁具体那个音名
  assert.equal(out, 'F♭');
  const back = parseChord(out);
  assert.equal(back.ok, true);
  const src = parseChord('♭II', { key: 'e♭ minor' });
  const set = (p) => [...new Set(p.pcs.map((n) => ((n % 12) + 12) % 12))].sort((a, b) => a - b).join(',');
  assert.equal(set(back), set(src));
});
