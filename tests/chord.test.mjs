import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHORD_LANES,
  chordPcs,
  describeChord,
  degreeName,
  harmonicFunction,
  noteToPc,
  parseChord,
  parseKeyName,
  pcName,
} from '../src/shared/chord.js';

const pcs = (s, key = 'c major') => chordPcs(parseChord(s, { key }));

test('调性名解析：c natural minor / c-sharp / g dorian', () => {
  assert.deepEqual(parseKeyName('c natural minor'), { pc: 0, mode: 'natural minor', letter: 'c', acc: 0 });
  assert.deepEqual(parseKeyName('c-sharp natural minor'), { pc: 1, mode: 'natural minor', letter: 'c', acc: 1 });
  assert.deepEqual(parseKeyName('g dorian'), { pc: 7, mode: 'dorian', letter: 'g', acc: 0 });
  // 紧凑写法：eb = E♭；单个 b 仍是字母本身（B 大调）
  assert.equal(parseKeyName('eb minor').pc, 3);
  assert.equal(parseKeyName('bb minor').pc, 10);
  assert.deepEqual(parseKeyName('b minor'), { pc: 11, mode: 'minor', letter: 'b', acc: 0 });
  assert.equal(parseKeyName(''), null);
});

test('小调级数按自然小调取根音：III / VI / VII 不被升七级污染', () => {
  // 用户报的那个：Eb 和声小调 III 应该是关系大调主和弦 G♭–B♭–D♭
  const III = parseChord('III', { key: 'e-flat harmonic minor' });
  assert.deepEqual(III.pcs, [6, 10, 1]);
  assert.deepEqual(III.toneNames, ['G♭', 'B♭', 'D♭']);
  assert.equal(III.rootName, 'G♭');

  // c 小调：III = E♭ G B♭（以前是 E G♯ B）
  assert.deepEqual(parseChord('III', { key: 'c natural minor' }).toneNames, ['E♭', 'G', 'B♭']);
  // VI / VII 同理，VII 是下主音而不是导音
  assert.deepEqual(parseChord('VI', { key: 'c natural minor' }).toneNames, ['A♭', 'C', 'E♭']);
  assert.deepEqual(parseChord('VII', { key: 'c natural minor' }).toneNames, ['B♭', 'D', 'F']);
  // iv 的拼写也要走降号（以前显示 F–G♯–C）
  assert.deepEqual(parseChord('iv', { key: 'c natural minor' }).toneNames, ['F', 'A♭', 'C']);
});

test('小调的导音只给属功能：V / vii° 升七级，III 不升', () => {
  assert.deepEqual(parseChord('V', { key: 'a harmonic minor' }).pcs, [4, 8, 11]);      // E G♯ B
  assert.deepEqual(parseChord('V7', { key: 'a harmonic minor' }).toneNames, ['E', 'G♯', 'B', 'D']);
  assert.deepEqual(parseChord('vii°7', { key: 'a harmonic minor' }).toneNames, ['G♯', 'B', 'D', 'F']);
  // 同一调性里 III 仍是自然七级下的关系大调
  assert.deepEqual(parseChord('III', { key: 'a harmonic minor' }).toneNames, ['C', 'E', 'G']);
  // 小写 vii 视为导音三和弦（哪怕调式写的是自然小调）
  assert.deepEqual(parseChord('vii°', { key: 'c natural minor' }).toneNames, ['B', 'D', 'F']);
});

test('教会调式仍按自己的音阶：d 多利亚的大六度要保留', () => {
  assert.deepEqual(parseChord('III', { key: 'd dorian' }).toneNames, ['F', 'A', 'C']);
  assert.deepEqual(parseChord('vi', { key: 'd dorian' }).toneNames, ['B', 'D', 'F♯']);
  assert.deepEqual(parseChord('VII', { key: 'd dorian' }).toneNames, ['C', 'E', 'G']);
});

test('绝对音名沿用用户写的升降号拼写', () => {
  assert.deepEqual(parseChord('Bb').toneNames, ['B♭', 'D', 'F']);
  assert.deepEqual(parseChord('F#m7b5').toneNames, ['F♯', 'A', 'C', 'E']);
  assert.deepEqual(parseChord('C/E').toneNames, ['E', 'G', 'C']);
});

test('苏俄数字低音：照常解析，只记一条规范写法提示', () => {
  const v56 = parseChord('V56', { key: 'a harmonic minor' });
  assert.equal(v56.ok, true);
  assert.equal(v56.inversion, 1);
  assert.deepEqual(v56.pcs, [8, 11, 2, 4]);       // 与 V65 完全一致
  assert.deepEqual(v56.figure, { found: '56', standard: '65' });

  assert.deepEqual(parseChord('iii34').figure, { found: '34', standard: '43' });
  assert.deepEqual(parseChord('V46').figure, { found: '46', standard: '64' });
  assert.deepEqual(parseChord('V2').figure, { found: '2', standard: '42' });
  // 规范写法不该被提示
  assert.equal(parseChord('V65').figure, null);
  assert.equal(parseChord('V64').figure, null);
});

test('音名与 pitch class', () => {
  assert.equal(noteToPc('C'), 0);
  assert.equal(noteToPc('Bb'), 10);
  assert.equal(noteToPc('F#'), 6);
  assert.equal(noteToPc('H'), null);
  assert.equal(pcName(10), 'A#');
  assert.equal(pcName(10, true), 'Bb');
});

test('罗马数字：大三和弦与转位', () => {
  const I = parseChord('I');
  assert.equal(I.ok, true);
  assert.equal(I.kind, 'roman');
  assert.equal(I.degree, 1);
  assert.equal(I.quality, 'major');
  assert.equal(I.inversion, 0);
  assert.deepEqual(I.pcs, [0, 4, 7]);

  const ii6 = parseChord('ii6');
  assert.equal(ii6.quality, 'minor');
  assert.equal(ii6.inversion, 1);
  assert.deepEqual(ii6.pcs, [5, 9, 2]); // F–A–D，低音 F
  assert.equal(ii6.bassPc, 5);
});

test('七和弦与数字低音：V7 / V65 / V43 / V42', () => {
  const v7 = parseChord('V7');
  assert.equal(v7.seventh, 'minor');
  assert.deepEqual(v7.pcs, [7, 11, 2, 5]);

  const v65 = parseChord('V65');
  assert.equal(v65.inversion, 1);
  assert.deepEqual(v65.pcs, [11, 2, 5, 7]);

  const v43 = parseChord('V43');
  assert.equal(v43.inversion, 2);
  assert.deepEqual(v43.pcs, [2, 5, 7, 11]);

  const v42 = parseChord('V42');
  assert.equal(v42.inversion, 3);
  assert.deepEqual(v42.pcs, [5, 7, 11, 2]);
});

test('减三 / 减七 / 半减七', () => {
  const vii = parseChord('viio7');
  assert.equal(vii.quality, 'dim');
  assert.equal(vii.seventh, 'dim');
  assert.deepEqual(vii.pcs, [11, 2, 5, 8]);

  const hd = parseChord('iiø7');
  assert.equal(hd.quality, 'dim');
  assert.equal(hd.seventh, 'half-dim');
  assert.deepEqual(hd.pcs, [2, 5, 8, 0]);
});

test('半减七的常见写法都能解析；dim7 不会被误判成半减', () => {
  // 半减七 = 减三 + 小七：C–E♭–G♭–B♭
  for (const symbol of ['Cm7b5', 'Cmin7b5', 'Cm7♭5', 'Cø', 'Cø7']) {
    const p = parseChord(symbol);
    assert.equal(p.ok, true, `${symbol} 应能解析`);
    assert.equal(p.seventh, 'half-dim', `${symbol} 应是半减七`);
    assert.deepEqual(p.pcs, [0, 3, 6, 10], `${symbol} 的音`);
  }
  // 减七 = 减三 + 减七：C–E♭–G♭–B𝄫（B𝄫 = A 的琴键）
  for (const symbol of ['Cdim7', 'C°7', 'Co7']) {
    const p = parseChord(symbol);
    assert.equal(p.ok, true, `${symbol} 应能解析`);
    assert.equal(p.seventh, 'dim', `${symbol} 应是减七，不是半减`);
    assert.deepEqual(p.pcs, [0, 3, 6, 9], `${symbol} 的音`);
  }
});

test('大七与变音级数：Imaj7 / bVII / #iv', () => {
  const maj7 = parseChord('Imaj7');
  assert.equal(maj7.seventh, 'major');
  assert.deepEqual(maj7.pcs, [0, 4, 7, 11]);

  const flat7 = parseChord('bVII');
  assert.equal(flat7.alter, -1);
  assert.equal(flat7.rootPc, 10);
  assert.deepEqual(flat7.pcs, [10, 2, 5]);

  const sharp4 = parseChord('#iv');
  assert.equal(sharp4.rootPc, 6);
});

test('副属和弦：V7/V 在 C 里是 D7', () => {
  const cand = parseChord('V7/V');
  assert.equal(cand.appliedTo, 5);
  assert.equal(cand.rootPc, 2);
  assert.deepEqual(cand.pcs, [2, 6, 9, 0]);
  assert.equal(cand.ok, true);
});

/**
 * 副属的**分子级数要在临时主音自己的音阶里数**，不是在本调音阶里数。
 *
 * Eb 和声小调的 III = G♭（大三和弦），它的 iii 是 G♭ 上方 4 个半音的 B♭。
 * 若按本调（小调）3 级取 3 个半音，会得到 A，写成 B♭♭ —— 整组多降一次
 * （B♭♭–D♭♭–F♭），这正是 The deepest nightmare of Sibyl 里那条 `iii6/III`。
 */
test('副属和弦：分子走临时主音的音阶（iii/III 不再是多降一次）', () => {
  const r = parseChord('iii6/III', { key: 'e-flat harmonic minor' });
  assert.equal(r.appliedTo, 3);
  assert.equal(r.rootPc, 10);
  assert.equal(r.rootName, 'B♭');
  assert.equal(r.inversion, 1);
  // 从低音列起：D♭–F–B♭
  assert.deepEqual(r.toneNames, ['D♭', 'F', 'B♭']);

  // 三级的五级 = 本调还原七级（D♭），不是和声小调的升七级（D）
  assert.deepEqual(parseChord('V/III', { key: 'e-flat harmonic minor' }).toneNames, ['D♭', 'F', 'A♭']);
  assert.deepEqual(parseChord('V7/III', { key: 'e-flat harmonic minor' }).toneNames, ['D♭', 'F', 'A♭', 'C♭']);
  // 小写临时主音 → 自然小调：V6/iv 仍是 G–B♭–E♭（iv = A♭ 小调）
  assert.deepEqual(parseChord('V6/iv', { key: 'e-flat harmonic minor' }).toneNames, ['G', 'B♭', 'E♭']);

  // 大调里同理：C 的 III = E 大三和弦，它的 iii 是 G♯ 小三和弦（不是 G）
  assert.deepEqual(parseChord('iii/III', { key: 'c major' }).toneNames, ['G♯', 'B', 'D♯']);
  // C 的 ii = D 小三和弦，它的 iii 是 F 大三和弦（不是 F♯）
  assert.deepEqual(parseChord('iii/ii', { key: 'c major' }).toneNames, ['F', 'A♭', 'C']);

  // 斜杠右侧自带升降号也要算进临时主音：♭II = D♭，它的 V 是 A♭
  const neap = parseChord('V/bII', { key: 'c major' });
  assert.equal(neap.appliedAlter, -1);
  assert.deepEqual(neap.toneNames, ['A♭', 'C', 'E♭']);

  // 详情栏不再把小三和弦念成「属和弦」
  const text = describeChord(parseChord('iii6/III', { key: 'e-flat harmonic minor' }), 'zh');
  assert.match(text, /小三和弦/);
  assert.match(text, /离调至 3 级/);
});

test('绝对音名：C / Am7 / F#m7b5 / Bbsus4 / C/E', () => {
  assert.deepEqual(pcs('C'), [0, 4, 7]);
  assert.equal(parseChord('Am7').kind, 'absolute');
  assert.deepEqual(pcs('Am7'), [9, 0, 4, 7]);

  const hd = parseChord('F#m7b5');
  assert.equal(hd.rootPc, 6);
  assert.equal(hd.seventh, 'half-dim');
  assert.deepEqual(hd.pcs, [6, 9, 0, 4]);

  const sus = parseChord('Bbsus4');
  assert.equal(sus.quality, 'sus4');
  assert.deepEqual(sus.pcs, [10, 3, 5]); // Bb–Eb–F

  const slash = parseChord('C/E');
  assert.equal(slash.inversion, 1);
  assert.equal(slash.bassPc, 4);
  // 转位后从低音往上堆：E–G–C，而不是把低音塞到原顺序前面
  assert.deepEqual(slash.pcs, [4, 7, 0]);
});

test('调性影响根音：c-sharp natural minor 的 V', () => {
  const v = parseChord('V', { key: 'c-sharp natural minor' });
  assert.equal(v.rootPc, 8); // G# 大三和弦
  assert.deepEqual(v.pcs, [8, 0, 3]);
});

test('解析失败不猜：返回 ok:false 与原因', () => {
  for (const bad of ['@@', 'XYZ', 'V7%', 'I#9#9']) {
    const r = parseChord(bad);
    assert.equal(r.ok, false, `${bad} 不该被当成合法和弦`);
    assert.ok(r.errors.length > 0);
  }
  assert.equal(parseChord('V7/').ok, false);
});

test('describeChord / harmonicFunction 供界面直接显示', () => {
  assert.match(describeChord(parseChord('V7')), /5 级/);
  assert.match(describeChord(parseChord('V7')), /属七和弦/);
  assert.match(describeChord(parseChord('V7')), /原位/);
  assert.match(describeChord(parseChord('ii6')), /第一转位/);
  assert.match(describeChord(parseChord('F#m7b5')), /半减七/);
  assert.match(describeChord(parseChord('@@')), /无法解析/);

  assert.equal(harmonicFunction(parseChord('I')), 'tonic');
  assert.equal(harmonicFunction(parseChord('V7')), 'dominant');
  assert.equal(harmonicFunction(parseChord('IV')), 'subdominant');
  assert.equal(degreeName(5), '属');
});

test('终止四六 Cad64 / K46：属功能、原位、音从低到高', () => {
  for (const sym of ['Cad64', 'K46', 'K6/4', 'К46']) {
    const r = parseChord(sym, { key: 'c major' });
    assert.equal(r.ok, true, `${sym} 应该能解析`);
    assert.equal(r.cadential, true);
    assert.equal(r.degree, 5);            // 功能上是属，不是「3 级」
    assert.equal(r.inversion, 0);         // 属音就在低音 → 原位
    assert.deepEqual(r.pcs, [7, 0, 4]);
    assert.deepEqual(r.toneNames, ['G', 'C', 'E']);
  }

  // 小调要好：A 小调的 K46 是 E–A–C（不是 E–A–C♯）
  assert.deepEqual(parseChord('K46', { key: 'a harmonic minor' }).toneNames, ['E', 'A', 'C']);
  // 降号调按调号拼
  assert.deepEqual(parseChord('Cad64', { key: 'e-flat major' }).toneNames, ['B♭', 'E♭', 'G']);

  // 详情栏说法：终止四六 · 属功能（双外音） · 原位（G–C–E）
  const text = describeChord(parseChord('K46', { key: 'c major' }));
  assert.match(text, /终止四六/);
  assert.match(text, /属功能/);
  assert.match(text, /原位/);
  assert.match(text, /G–C–E/);
  assert.equal(harmonicFunction(parseChord('K46')), 'dominant');

  // 不能顺手把普通字母和弦带坏
  assert.equal(parseChord('C').cadential, undefined);
  assert.deepEqual(parseChord('C').toneNames, ['C', 'E', 'G']);
});

/**
 * 泳道分类只留一份（主进程算 parsed / 渲染层挑详情栏共用）。
 *
 * 这条守的是「两边各写一份就漂移」：一旦有人把 `function` 加进来，
 * 主进程就会去解析 `t` 这种功能符号，而渲染层会把它当和弦符号显示。
 */
test('和弦泳道集合：只含和弦符号泳道，不含功能 / 备注 / 转位', () => {
  assert.equal(CHORD_LANES.has('chord'), true);
  assert.equal(CHORD_LANES.has('degree'), true);
  for (const lane of ['function', 'note', 'inversion', 'bass', 'sposobin', 'tones']) {
    assert.equal(CHORD_LANES.has(lane), false, lane);
  }
});

/**
 * 挂留 / 附加音 / 延伸音（v0.41）。
 *
 * 这批记号以前是「收下了但不出音」或直接报错：
 *   - `V7sus4` / `C7sus4` → 多余字符（候选词表里还在推荐 C7sus4，点了就报错）
 *   - `Vadd9` / `V9` → ok:true 但和弦音里没有 9 音（最糟：错得很有道理）
 * 现在统一按「从根音往上数的绝对半音数」搭叠、按音高排序，
 * 于是 add2 与 add9 的区别只剩**排列位置**（同一组音，顺序不同）。
 */
test('挂留：sus 写在数字前后都认（V7sus4 / V9sus4 / Vsus4add9）', () => {
  const v7sus4 = parseChord('V7sus4', { key: 'c major' });
  assert.equal(v7sus4.ok, true, v7sus4.errors.join('/'));
  assert.equal(v7sus4.quality, 'sus4');
  assert.equal(v7sus4.seventh, 'minor');
  assert.deepEqual(v7sus4.toneNames, ['G', 'C', 'D', 'F']);

  const v7sus2 = parseChord('V7sus2', { key: 'c major' });
  assert.deepEqual(v7sus2.toneNames, ['G', 'A', 'D', 'F']);

  // 延伸音 + 挂四：9 音在最上面
  const v9sus4 = parseChord('V9sus4', { key: 'c major' });
  assert.equal(v9sus4.ok, true, v9sus4.errors.join('/'));
  assert.deepEqual(v9sus4.toneNames, ['G', 'C', 'D', 'F', 'A']);

  // 挂四 + 附加九音（两种写法都该成立，顺序无关）
  assert.deepEqual(parseChord('Vsus4add9', { key: 'c major' }).toneNames, ['G', 'C', 'D', 'A']);
  assert.deepEqual(parseChord('Vadd9sus4', { key: 'c major' }).toneNames, ['G', 'C', 'D', 'A']);

  // 字母和弦这边只放开了 sus（add/9 的发音仍留给罗马数字）
  const c7sus4 = parseChord('C7sus4');
  assert.equal(c7sus4.ok, true, c7sus4.errors.join('/'));
  assert.deepEqual(c7sus4.toneNames, ['C', 'F', 'G', 'B♭']);
  // 降号调 / 升号调都要按根音的写法拼
  assert.deepEqual(parseChord('Bb7sus4').toneNames, ['B♭', 'E♭', 'F', 'A♭']);
  assert.deepEqual(parseChord('G#7sus4').toneNames, ['G♯', 'C♯', 'D♯', 'F♯']);
});

test('六音替五音：V7sub6 = G–B–E–F，保留小七度、五音被换掉', () => {
  const v7sub6 = parseChord('V7sub6', { key: 'c major' });
  assert.equal(v7sub6.ok, true, v7sub6.errors.join('/'));
  assert.equal(v7sub6.sub6, true);
  assert.equal(v7sub6.seventh, 'minor');
  assert.deepEqual(v7sub6.toneNames, ['G', 'B', 'E', 'F']);

  const c7sub6 = parseChord('C7sub6');
  assert.equal(c7sub6.ok, true, c7sub6.errors.join('/'));
  assert.deepEqual(c7sub6.toneNames, ['C', 'E', 'A', 'B♭']);

  // 三和弦也能用；加 ♭ 则用八度内的♭6（8 个半音）
  assert.deepEqual(parseChord('Csub6').toneNames, ['C', 'E', 'A']);
  assert.deepEqual(parseChord('C7sub♭6').toneNames, ['C', 'E', 'A♭', 'B♭']);

  // 描述里必须说出来，不能只显示「小七」把换掉五音这件事吞掉
  assert.match(describeChord(v7sub6), /六音替五音/);
});

test('add2/add4 与 add9/add11：同一组音，排列不同（按实际音高）', () => {
  // 二度音夹在根音与三音之间
  assert.deepEqual(parseChord('Iadd2', { key: 'c major' }).toneNames, ['C', 'D', 'E', 'G']);
  // 九度音在三音五音之上
  assert.deepEqual(parseChord('Iadd9', { key: 'c major' }).toneNames, ['C', 'E', 'G', 'D']);
  // 四度音夹在三音与五音之间
  assert.deepEqual(parseChord('Iadd4', { key: 'c major' }).toneNames, ['C', 'E', 'F', 'G']);
  // 十一度音在最上面
  assert.deepEqual(parseChord('Iadd11', { key: 'c major' }).toneNames, ['C', 'E', 'G', 'F']);

  // 两者 pitch class 完全一样 —— 区别只在顺序，这正是「不归一」的理由
  assert.deepEqual(
    [...parseChord('Iadd2', { key: 'c major' }).pcs].sort((a, b) => a - b),
    [...parseChord('Iadd9', { key: 'c major' }).pcs].sort((a, b) => a - b)
  );

  // 不改变七音：add 只是加一个音
  const vadd9 = parseChord('Vadd9', { key: 'c major' });
  assert.equal(vadd9.seventh, 'none');
  assert.deepEqual(vadd9.toneNames, ['G', 'B', 'D', 'A']);

  // 变化延伸音要按音级拼写（b9 永远写成 D♭ 一类，不能就近写成 C♯）
  assert.deepEqual(parseChord('V7b9', { key: 'c major' }).toneNames, ['G', 'B', 'D', 'F', 'A♭']);
  assert.deepEqual(parseChord('V7#11', { key: 'c major' }).toneNames, ['G', 'B', 'D', 'F', 'C♯']);
});

test('六九和弦必须打括号：V(6/9) 认，V6/9 明确报错（V6 仍是第一转位）', () => {
  const sixNine = parseChord('V(6/9)', { key: 'c major' });
  assert.equal(sixNine.ok, true, sixNine.errors.join('/'));
  assert.deepEqual(sixNine.toneNames, ['G', 'B', 'D', 'E', 'A']);
  // 全角括号（中文输入法）同样认
  assert.deepEqual(parseChord('V（6/9）', { key: 'c major' }).toneNames, ['G', 'B', 'D', 'E', 'A']);

  // 不打括号会撞上「V6 = 第一转位」，这里必须报错并给出改法，而不是静默按转位算
  const bad = parseChord('V6/9', { key: 'c major' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /括号/);

  // V6 本人不受影响
  const v6 = parseChord('V6', { key: 'c major' });
  assert.equal(v6.inversion, 1);
  assert.deepEqual(v6.toneNames, ['B', 'D', 'G']);
});

test('延伸音真的进和弦音：V9 有 9 音，且写进详情描述', () => {
  const v9 = parseChord('V9', { key: 'c major' });
  assert.deepEqual(v9.toneNames, ['G', 'B', 'D', 'F', 'A']);

  // 描述要说出「挂四 / 加 9 音」，否则解析出来等于白算
  const d1 = describeChord(parseChord('V7sus4', { key: 'c major' }), 'zh');
  assert.match(d1, /挂四/);
  assert.match(d1, /G–C–D–F/);
  const d2 = describeChord(parseChord('Vadd9', { key: 'c major' }), 'zh');
  assert.match(d2, /加 9 音/);
  const d3 = describeChord(parseChord('Vadd2', { key: 'c major' }), 'zh');
  assert.match(d3, /加 2 音/);
  const d4 = describeChord(parseChord('V9sus4', { key: 'c major' }), 'en');
  assert.match(d4, /sus4/);
  assert.match(d4, /add 9/);

  // 笔误仍然要报错（别把重复的延伸音静默吞掉）
  assert.equal(parseChord('I#9#9', { key: 'c major' }).ok, false);
  assert.equal(parseChord('I(add14)', { key: 'c major' }).ok, false);
});

test('字母和弦也吃同一套延伸音（v0.42）：C6 是加六音，不是大七', () => {
  // C6 = C–E–G–A。以前把 6 当成大七，得到 C E G B（听起来是另一个和弦）
  assert.deepEqual(parseChord('C6').toneNames, ['C', 'E', 'G', 'A']);
  assert.equal(parseChord('C6').seventh, 'none');
  // 小六和弦的六音要按调号拼：Am6 = A C E F♯（不是 G）
  assert.deepEqual(parseChord('Am6').toneNames, ['A', 'C', 'E', 'F♯']);

  // 延伸音真的发音（以前 ok:true 却只有四个音）
  assert.deepEqual(parseChord('C9').toneNames, ['C', 'E', 'G', 'B♭', 'D']);
  assert.deepEqual(parseChord('Cmaj9').toneNames, ['C', 'E', 'G', 'B', 'D']);
  // 13 隐含九音（v0.82，用户 2026-11-08）：C13 = C–E–G–B♭–D–A
  assert.deepEqual(parseChord('C13').toneNames, ['C', 'E', 'G', 'B♭', 'D', 'A']);

  // add：不改变七音，顺序按实际音高
  assert.deepEqual(parseChord('Cadd2').toneNames, ['C', 'D', 'E', 'G']);
  assert.deepEqual(parseChord('Cadd9').toneNames, ['C', 'E', 'G', 'D']);

  // 6/9 在字母和弦里是常规写法（斜杠不是低音）
  assert.deepEqual(parseChord('C6/9').toneNames, ['C', 'E', 'G', 'A', 'D']);

  // 与罗马数字同一套规则：同一个记号不能两个泳道拼出不同顺序
  assert.deepEqual(
    parseChord('Cadd2').toneNames.map((n) => n),
    parseChord('Iadd2', { key: 'c major' }).toneNames
  );

  // b5 / #5 改的是三和弦性质，不是「多一个音」
  assert.deepEqual(parseChord('C7b5').toneNames, ['C', 'E♭', 'G♭', 'B♭']);
  assert.deepEqual(parseChord('F#m7b5').toneNames, ['F♯', 'A', 'C', 'E']);
  assert.deepEqual(parseChord('C7#5').toneNames, ['C', 'E', 'G♯', 'B♭']);
});

test('重升 / 重降 / 还原：词表能给出 C𝄪，解析就不能说它无法识别', () => {
  // Unicode 双记号、ASCII 的 x 与 ## 都要认，且落在同一个音上
  for (const s of ['C𝄪', 'Cx', 'C##']) {
    const p = parseChord(s);
    assert.equal(p.ok, true, `${s} 应能解析`);
    assert.equal(p.rootPc, 2, `${s} 的根音是 D 那个琴键`);
    // 拼写跟着用户写的根音走：同一个音不写成 D
    assert.equal(p.rootName, 'C𝄪');
  }
  // 三音也跟着根音往上升两个：C𝄪 三和弦 = D 大三和弦，写成 C𝄪–E𝄪–G𝄪
  // （同一个音不写 D–F♯–A：字母必须跟着根音走，不然「C𝄪 → D」这件事就丢了）
  assert.deepEqual(parseChord('C𝄪').toneNames, ['C𝄪', 'E𝄪', 'G𝄪']);

  for (const s of ['C𝄫', 'Cbb']) {
    const p = parseChord(s);
    assert.equal(p.rootPc, 10, `${s} 的根音是 B♭ 那个琴键`);
    assert.equal(p.rootName, 'C𝄫');
  }

  // 还原号 = 本位音（写字时用不上，但别人粘进来不能报错）
  assert.equal(parseChord('C♮m').rootPc, 0);
  assert.equal(parseChord('C♮m').ok, true);

  // 重降同理
  assert.equal(parseChord('C𝄪7').ok, true);
  // 小七度也是「字母 + 6」：C𝄪 上方的小七度写 B♯（= C 那个琴键），不是 B
  assert.deepEqual(parseChord('C𝄪7').toneNames, ['C𝄪', 'E𝄪', 'G𝄪', 'B♯']);
});

test('那不勒斯：♭II / N 与 ♭II6 / N6 必须是同一个和弦，且说法带降号', () => {
  for (const [six, plain] of [
    ['N6', 'bII6'],
    ['N', 'bII'],
  ]) {
    const a = parseChord(six, { key: 'c major' });
    const b = parseChord(plain, { key: 'c major' });
    assert.equal(a.ok, true, `${six} 应能解析`);
    assert.equal(a.neapolitan, true);
    // 同一个和弦：音、级数、转位、低音全都一致
    assert.deepEqual(a.toneNames, b.toneNames, `${six} 的音应与 ${plain} 相同`);
    assert.equal(a.degree, 2);
    assert.equal(a.alter, -1, '♭II 是**降**二级');
    assert.equal(a.inversion, b.inversion);
    // raw 记用户实际写的字样，不会被改写成 bII
    assert.equal(a.raw, six);
  }

  // 降二级大三 = 那不勒斯（D♭–F–A♭）；六和弦低音是四级音
  assert.deepEqual(parseChord('N', { key: 'c major' }).toneNames, ['D♭', 'F', 'A♭']);
  assert.deepEqual(parseChord('N6', { key: 'c major' }).toneNames, ['F', 'A♭', 'D♭']);

  // 界面上必须说「降 2 级 · 那不勒斯」，不能只说「2 级 · 大三和弦」
  const zh = describeChord(parseChord('N6', { key: 'c major' }), 'zh');
  assert.match(zh, /♭2 级/);
  assert.match(zh, /那不勒斯/);
  const en = describeChord(parseChord('N6', { key: 'c major' }), 'en');
  assert.match(en, /♭2/);
  assert.match(en, /Neapolitan/);
});

test('♭II 属功能 = 三全音替代；♭II 大三 = 那不勒斯', () => {
  // D♭7 在 C 里是代 G7 的三全音替代（D♭–F–A♭–C♭）
  const tri = parseChord('bII7', { key: 'c major' });
  assert.equal(tri.ok, true);
  const zh = describeChord(tri, 'zh');
  assert.match(zh, /三全音替代/);
  assert.doesNotMatch(zh, /那不勒斯/);
  assert.match(zh, /♭2 级/);

  // 属九 / 属七挂四也是属功能
  assert.match(describeChord(parseChord('bII9', { key: 'c major' }), 'zh'), /三全音替代/);
  assert.match(describeChord(parseChord('bII7sus4', { key: 'c major' }), 'zh'), /三全音替代/);
  assert.match(describeChord(parseChord('bII7', { key: 'c major' }), 'en'), /tritone substitution/i);

  // 没有小七度的大三和弦仍是那不勒斯；N6 / bII6 走同一套
  assert.match(describeChord(parseChord('bII6', { key: 'c major' }), 'zh'), /那不勒斯/);
  assert.match(describeChord(parseChord('N6', { key: 'c major' }), 'zh'), /那不勒斯/);
  assert.doesNotMatch(describeChord(parseChord('bII6', { key: 'c major' }), 'zh'), /三全音替代/);

  // 大七不是属功能，也不该借那不勒斯的名字
  const maj7 = describeChord(parseChord('bIImaj7', { key: 'c major' }), 'zh');
  assert.doesNotMatch(maj7, /三全音替代/);
  assert.doesNotMatch(maj7, /那不勒斯/);
});

test('其它变化级数的说法也带升降号（以前一律只说「n 级」）', () => {
  assert.match(describeChord(parseChord('bVI', { key: 'c major' }), 'zh'), /♭6 级/);
  assert.match(describeChord(parseChord('#iv', { key: 'c major' }), 'zh'), /♯4 级/);
  assert.match(describeChord(parseChord('bVII', { key: 'c major' }), 'zh'), /♭7 级/);
  // 没有升降号的仍是一个干净的「5 级」，也不该被误认成那不勒斯
  const v = parseChord('V', { key: 'c major' });
  assert.match(describeChord(v, 'zh'), /^5 级 · 大三和弦/);
  assert.doesNotMatch(describeChord(v, 'zh'), /那不勒斯/);
  // 终止四六照旧：不说级数、不说那不勒斯
  assert.match(describeChord(parseChord('Cad64', { key: 'c major' }), 'zh'), /终止四六/);
});
