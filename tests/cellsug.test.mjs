import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseChord } from '../src/shared/chord.js';
import {
  chordRoots,
  degreeCandidates,
  letterCandidates,
  normalizeRootText,
  omitWordSuggestions,
} from '../src/shared/cellsug.js';

const doc = JSON.parse(fs.readFileSync(new URL('../data/vocab/chord-symbols.json', import.meta.url), 'utf8'));
const values = (list) => list.map((x) => x.value);

test('词表结构：七个音名 + 五个变音记号（含本位音）', () => {
  assert.deepEqual(doc.letters, ['C', 'D', 'E', 'F', 'G', 'A', 'B']);
  const signs = doc.accidentals.map((a) => a.sign);
  assert.deepEqual(signs, ['', '♯', '♭', '𝄪', '𝄫']);
  // 候选根音 = 7 × 5 = 35，且第一个是干净的 C
  const roots = chordRoots(doc);
  assert.equal(roots.length, 35);
  assert.equal(roots[0], 'C');
  assert.ok(roots.includes('C𝄪'));
  assert.ok(roots.includes('B𝄫'));
});

test('紧凑写法归一：Eb → E♭，C# → C♯，Cx / C## → C𝄪', () => {
  assert.equal(normalizeRootText('Eb'), 'E♭');
  assert.equal(normalizeRootText('eb'), 'E♭');
  assert.equal(normalizeRootText('E'), 'E');
  // 单个 B 是音名本身，不能被当成降号
  assert.equal(normalizeRootText('B'), 'B');
  assert.equal(normalizeRootText('C#'), 'C♯');
  assert.equal(normalizeRootText('Cx'), 'C𝄪');
  assert.equal(normalizeRootText('C##'), 'C𝄪');
  assert.equal(normalizeRootText('Cbb'), 'C𝄫');
  // 还原号等于本位音
  assert.equal(normalizeRootText('C♮'), 'C');
  // 后缀里的 b 是「降五音」，不是变音记号 —— 一个字符都不能动
  assert.equal(normalizeRootText('Cm7b5'), 'Cm7b5');
});

test('只打根音：常用性质先出，最多 8 条，顺序跟词表', () => {
  const list = letterCandidates(doc, 'C');
  assert.equal(list.length, 8);
  assert.equal(list[0].value, 'C'); // 精确命中排第一
  assert.equal(list[1].value, 'Cm');
  assert.ok(list.some((x) => x.value === 'C7sus4'), '用户点名要的 7sus4 必须在候选里');
  // 字母泳道写 C69（没有数字低音歧义），级数泳道才是 C(6/9)
  assert.ok(list.some((x) => x.value === 'C69'));
  assert.ok(list.every((x) => x.value.startsWith('C')));
});

test('继续打前缀：只剩匹配项，精确命中排第一', () => {
  assert.deepEqual(values(letterCandidates(doc, 'C7')).slice(0, 4), ['C7', 'C7sus4', 'C7♭9', 'C7sub6']);
  const m7 = values(letterCandidates(doc, 'Cm7'));
  assert.equal(m7[0], 'Cm7');
  assert.ok(m7.includes('Cm7b5'));
  // 别名参与匹配，显示值仍是词表里的规范写法
  assert.deepEqual(values(letterCandidates(doc, 'C7b9')), ['C7♭9']);
});

test('别名只进候选说明，不额外复制候选行', () => {
  const hd = letterCandidates(doc, 'Cm7b5');
  assert.equal(hd.length, 1);
  assert.equal(hd[0].value, 'Cm7b5');
  assert.match(hd[0].hint, /ø/);
  assert.match(hd[0].hint, /min7b5/);
});

test('升号根音不会被拆成 C + #（打 ASCII 也出 Unicode 候选）', () => {
  const list = letterCandidates(doc, 'C#7');
  assert.equal(list[0].value, 'C♯7');
  assert.ok(list.every((x) => x.value.startsWith('C♯')));
});

test('降号根音与大小写都不敏感', () => {
  assert.equal(letterCandidates(doc, 'Ebm')[0].value, 'E♭m');
  assert.equal(letterCandidates(doc, 'eb7')[0].value, 'E♭7');
});

test('重升 / 重降：Unicode 与 ASCII 两种打法都出同一个候选', () => {
  for (const typed of ['C𝄪', 'Cx', 'C##']) {
    assert.equal(letterCandidates(doc, typed)[0].value, 'C𝄪', `打 ${typed} 应出 C𝄪`);
    assert.equal(letterCandidates(doc, typed + '7')[0].value, 'C𝄪7', `打 ${typed}7 应出 C𝄪7`);
  }
  assert.equal(letterCandidates(doc, 'Cbb')[0].value, 'C𝄫');
});

test('字母和弦：6/9 写成 C69（三种输入都认，但候选只给 C69）', () => {
  // 字母泳道没有数字低音歧义，括号是多余的；级数泳道仍然要 V(6/9)
  assert.deepEqual(values(letterCandidates(doc, 'C6/9')), ['C69']);
  assert.deepEqual(values(letterCandidates(doc, 'C(6/9)')), ['C69']);
  assert.deepEqual(values(letterCandidates(doc, 'C69')), ['C69']);
  assert.deepEqual(values(letterCandidates(doc, 'C6')).slice(0, 2), ['C6', 'C69']);
  assert.ok(values(letterCandidates(doc, 'C6')).includes('C7sub6'));
  assert.deepEqual(values(letterCandidates(doc, 'Cadd6')), ['Cadd6']);
});

test('级数：裸 ii / vii 永远第一，半减七只在显式 h/b 时出现', () => {
  const iiMinor = values(degreeCandidates(doc, 'ii', 'c natural minor'));
  assert.equal(iiMinor[0], 'ii');
  assert.ok(!iiMinor.some((x) => x.includes('ø')), '裸 ii 不该自动塞半减七');
  assert.equal(degreeCandidates(doc, 'vii', 'c major')[0].value, 'vii');
  assert.equal(degreeCandidates(doc, 'ii', 'c major')[0].value, 'ii');

  // 显式触发才出半减七
  assert.deepEqual(values(degreeCandidates(doc, 'iih', 'c natural minor')).slice(0, 5), [
    'iiø7',
    'iiø65',
    'iiø43',
    'iiø42',
    'iim7b5',
  ]);
});

test('级数：h / b / half 后面带转位数字，出对应的 ø 转位', () => {
  assert.deepEqual(values(degreeCandidates(doc, 'iih42', 'c major')), ['iiø42']);
  assert.deepEqual(values(degreeCandidates(doc, 'iib42', 'c major')), ['iiø42']);
  assert.deepEqual(values(degreeCandidates(doc, 'iihalf42', 'c major')), ['iiø42']);
  assert.deepEqual(values(degreeCandidates(doc, 'iiban65', 'c major')), ['iiø65']);
  assert.deepEqual(values(degreeCandidates(doc, 'iih7', 'c major')), ['iiø7', 'iim7b5']);
  assert.deepEqual(values(degreeCandidates(doc, 'iih4', 'c major')), ['iiø43', 'iiø42']);
});

test('级数：h / half / b / ban / bj 都能触发半减七', () => {
  for (const typed of ['iih', 'iihalf', 'iib', 'iiban', 'iibj']) {
    assert.deepEqual(values(degreeCandidates(doc, typed, 'c major')).slice(0, 4), [
      'iiø7',
      'iiø65',
      'iiø43',
      'iiø42',
    ], `打 ${typed} 应出半减七`);
  }
});

test('级数：s 出 sus2 / sus4 / sub6，7 的顺序是 7 → 7sus4 → 7♭9', () => {
  assert.deepEqual(values(degreeCandidates(doc, 'iis', 'c major')), ['iisus2', 'iisus4', 'iisub6']);
  assert.deepEqual(values(degreeCandidates(doc, 'V7', 'c major')).slice(0, 4), [
    'V7',
    'V7sus4',
    'V7♭9',
    'V7sub6',
  ]);
});

test('级数：不连续/乱序的字符也能命中（V76 / V67 / V6 → V7sub6）', () => {
  assert.equal(degreeCandidates(doc, 'V76', 'c major')[0]?.value, 'V7sub6');
  assert.equal(degreeCandidates(doc, 'V67', 'c major')[0]?.value, 'V7sub6');
  const v6 = values(degreeCandidates(doc, 'V6', 'c major'));
  assert.equal(v6[0], 'V6'); // 精确转位仍第一
  assert.ok(v6.includes('V7sub6'), 'V6 也要能带出 V7sub6');
  // Vs6：短的 sub6 排第一，7sub6 排第二（首字符就对上的优先）
  assert.deepEqual(values(degreeCandidates(doc, 'Vs6', 'c major')), ['Vsub6', 'V7sub6']);
  // 字母和弦同一套模糊匹配
  assert.equal(letterCandidates(doc, 'C76')[0]?.value, 'C7sub6');
  assert.equal(letterCandidates(doc, 'C67')[0]?.value, 'C7sub6');
  assert.ok(values(letterCandidates(doc, 'C6')).includes('C7sub6'));
});

test('字母：单字母缩写 j / a（a → add 族 → aug → maj 族）', () => {
  const maj = ['Cmaj7', 'Cmaj9', 'Cmaj13', 'Cmaj♯11', 'Cmaj13(♯11)', 'Cmaj11'];
  assert.deepEqual(values(letterCandidates(doc, 'Cj')), maj);
  // 用户 2026-11-08 复盘：aug 不如 add 常用，所以 add 族第一、aug 第二、maj 第三
  assert.deepEqual(values(letterCandidates(doc, 'Ca')), [
    'Cadd2',
    'Cadd4',
    'Cadd6',
    'Cadd9',
    'Caug',
    ...maj,
  ]);
  // 缩写不受 8 条上限截断（11 条要整串给出来）
  assert.equal(letterCandidates(doc, 'Ca').length, 11);
  // 根音带升降号照样认（用户会先靠补全把 ♯ 打进去）
  assert.deepEqual(values(letterCandidates(doc, 'C#j')), maj.map((v) => 'C♯' + v.slice(1)));
  assert.equal(values(letterCandidates(doc, 'Cbj'))[0], 'C♭maj7');
  // 缩写不外溢：`Cm` 仍然先给小三这一家，maj 家族不许把 m7 / m9 挤掉
  const cm = values(letterCandidates(doc, 'Cm'));
  assert.equal(cm[0], 'Cm');
  for (const v of ['Cm7', 'Cm9', 'Cm7b5']) assert.ok(cm.includes(v), `Cm 候选里应有 ${v}`);
});

test('maj 家族：延伸音的音高与七音（maj9 / maj13 / maj♯11 / maj13(♯11) / maj11）', () => {
  const tones = (s) => parseChord(s).toneNames.join('–');
  assert.equal(tones('Cmaj7'), 'C–E–G–B');
  assert.equal(tones('Cmaj9'), 'C–E–G–B–D');
  assert.equal(tones('Cmaj13'), 'C–E–G–B–D–A');
  assert.equal(tones('Cmaj♯11'), 'C–E–G–B–F♯');
  assert.equal(tones('Cmaj13(♯11)'), 'C–E–G–B–D–F♯–A');
  /**
   * 11 隐含九音（用户 2026-11-08）：想要单独的十一音就写 add11。
   * 七音不用额外补 —— 数字分支本来就按大小调把七音定了。
   */
  assert.equal(tones('Cmaj11'), 'C–E–G–B–D–F');
  assert.equal(tones('C11'), 'C–E–G–B♭–D–F');
  assert.equal(tones('Cadd11'), 'C–E–G–F', 'add11 是单独的十一音，不带九音');
  // 谱面写法（带空格）也认；级数泳道同一套
  assert.equal(tones('Cmaj13 (♯11)'), 'C–E–G–B–D–F♯–A');
  assert.equal(parseChord('Imaj9', { key: 'c major' }).toneNames.join('–'), 'C–E–G–B–D');
  assert.equal(parseChord('Imaj11', { key: 'c major' }).toneNames.join('–'), 'C–E–G–B–D–F');
  assert.equal(
    parseChord('Imaj13 (♯11)', { key: 'c major' }).toneNames.join('–'),
    'C–E–G–B–D–F♯–A'
  );
});

test('add 系列：a2 / a4 / a6 / a9 都出候选，Cadd 按词表顺序列整族', () => {
  assert.deepEqual(values(letterCandidates(doc, 'Ca2')), ['Cadd2']);
  assert.deepEqual(values(letterCandidates(doc, 'Ca4')), ['Cadd4']);
  assert.equal(values(letterCandidates(doc, 'Ca6'))[0], 'Cadd6');
  // 打 a9 时 add9 先出（首字符就对上），maj9 随后 —— 两个都要在
  const a9 = values(letterCandidates(doc, 'Ca9'));
  assert.equal(a9[0], 'Cadd9');
  assert.ok(a9.includes('Cmaj9'));
  assert.deepEqual(values(letterCandidates(doc, 'Cadd')), [
    'Cadd2',
    'Cadd4',
    'Cadd6',
    'Cadd9',
  ]);
  // 加音的位置：add2 夹在三音下面，add4 夹在三音与五音之间（不是 add9 那种顶在上面）
  assert.equal(parseChord('Cadd2').toneNames.join('–'), 'C–D–E–G');
  assert.equal(parseChord('Cadd4').toneNames.join('–'), 'C–E–F–G');
  assert.equal(parseChord('Iadd2', { key: 'c major' }).toneNames.join('–'), 'C–D–E–G');
});

test('省略音：o 给 omit / no，n 只给 no；Co 是减三不是关键字', () => {
  assert.deepEqual(omitWordSuggestions('C13o'), ['C13omit', 'C13no']);
  assert.deepEqual(omitWordSuggestions('C13n'), ['C13no']);
  assert.deepEqual(omitWordSuggestions('C13om'), ['C13omit']);
  // 打全了就不再给候选（否则候选和输入一模一样）
  assert.deepEqual(omitWordSuggestions('C13omit'), []);
  assert.deepEqual(omitWordSuggestions('C13no'), []);
  // `Co` / `Vo` 的 o 是减三和弦的别名，不能被抢走
  assert.deepEqual(omitWordSuggestions('Co'), []);
  assert.deepEqual(omitWordSuggestions('Vo'), []);
  // 括号里也认
  assert.deepEqual(omitWordSuggestions('C13(no'), []);
  assert.deepEqual(omitWordSuggestions('C9(o'), ['C9(omit', 'C9(no']);
});

test('省略音：no / omit 按「几音」删，13 带九音', () => {
  const tones = (s) => parseChord(s).toneNames.join('–');
  // 13 隐含九音（v0.82）：maj13(♯11) 也要有九音
  assert.equal(tones('Cmaj13(♯11)'), 'C–E–G–B–D–F♯–A');
  assert.equal(tones('Cmaj13'), 'C–E–G–B–D–A');
  assert.equal(tones('C13'), 'C–E–G–B♭–D–A');
  // 省略音
  assert.equal(tones('C13no11'), 'C–E–G–B♭–D–A'); // 本来就没有 11，等于没省
  assert.equal(tones('C9omit5'), 'C–E–B♭–D');
  assert.equal(tones('Cmaj7no3'), 'C–G–B');
  assert.equal(tones('C7♯9no9'), 'C–E–G–B♭', '去掉的是那个升九，不是三音');
  assert.equal(tones('Csus4no4'), 'C–G');
  assert.equal(tones('Cmaj13(♯11)no11'), 'C–E–G–B–D–A');
  // 只写关键字不给数字 = 不省略（补全插进来的半成品不该立刻变成解析失败）
  assert.equal(tones('C13omit'), 'C–E–G–B♭–D–A');
  // 级数泳道同一套（含括号写法）
  const rom = (s) => parseChord(s, { key: 'c major' }).toneNames.join('–');
  assert.equal(rom('V13no11'), 'G–B–D–F–A–E');
  assert.equal(rom('V9(omit5)'), 'G–B–F–A');
});

test('级数：b / j / jiang / jl 出降号，s / sheng / u / ug 出升号', () => {
  for (const typed of ['bII', 'jII', 'jiangII', 'jlII']) {
    assert.equal(degreeCandidates(doc, typed, 'c major')[0].value, '♭II', `打 ${typed} 应出 ♭II`);
  }
  for (const typed of ['sII', 'shengII', 'uII', 'ugII']) {
    assert.equal(degreeCandidates(doc, typed, 'c major')[0].value, '♯II', `打 ${typed} 应出 ♯II`);
  }
  assert.deepEqual(values(degreeCandidates(doc, 'b', 'c major')), [
    '♭I',
    '♭II',
    '♭III',
    '♭IV',
    '♭V',
    '♭VI',
    '♭VII',
  ]);
});

test('词表里每个性质在两个泳道给出的候选都能被解析器认出来', () => {
  for (const q of doc.qualities) {
    if (!/^ø(?:65|43|42)$/.test(q.suffix)) {
      const abs = parseChord('C' + q.suffix);
      assert.equal(abs.ok, true, `字母和弦 C${q.suffix}: ${abs.errors?.join('/')}`);
    }
    if ((!/^m(?!aj)/.test(q.suffix) && q.suffix !== '6') || q.suffix === 'm7b5') {
      const rom = parseChord('V' + q.suffix, { key: 'c major' });
      assert.equal(rom.ok, true, `级数和弦 V${q.suffix}: ${rom.errors?.join('/')}`);
    }
  }
  for (const typed of ['C', 'C7', 'C7b9', 'Cm7', 'C6/9', 'C6', 'C76', 'C67']) {
    for (const c of letterCandidates(doc, typed)) {
      assert.equal(parseChord(c.value).ok, true, `字母候选 ${c.value}`);
    }
  }
  for (const [typed, key] of [
    ['V', 'c major'],
    ['ii', 'c natural minor'],
    ['V6', 'c major'],
    ['V76', 'c major'],
    ['V67', 'c major'],
    ['V7', 'c major'],
    ['iis', 'c major'],
    ['iih', 'c major'],
    ['iih42', 'c major'],
    ['bII', 'c major'],
    ['sII', 'c major'],
  ]) {
    for (const c of degreeCandidates(doc, typed, key)) {
      assert.equal(parseChord(c.value, { key }).ok, true, `级数候选 ${c.value}`);
    }
  }
});

test('认不出就返回空（不猜）', () => {
  assert.deepEqual(letterCandidates(doc, 'H7'), []);
  assert.deepEqual(letterCandidates(doc, ''), []);
  assert.deepEqual(letterCandidates(null, 'C'), []);
  assert.deepEqual(degreeCandidates(doc, 'x', 'c major'), []);
  assert.deepEqual(degreeCandidates(null, 'V', 'c major'), []);
});
