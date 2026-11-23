import test from 'node:test';
import assert from 'node:assert/strict';
import { degreeOfChord, parseChord, isDominantSeventh } from '../src/shared/chord.js';
import { matchProgression } from '../src/shared/progression.js';

const deg = (sym, key) => degreeOfChord(parseChord(sym, { key }), key);
const seq = (list, key) => list.map((s) => deg(s, key));
/** 进行识别要的不仅是级数，还要严格的属七标记（丸之内靠它区分 III7 / iii7） */
const progSeq = (list, key) =>
  list.map((s) => {
    const p = parseChord(s, { key });
    const d = degreeOfChord(p, key);
    return { ...d, dominant7: isDominantSeventh(p) };
  });

test('级数反算：罗马数字直接用 degree，字母和弦按调性算', () => {
  assert.deepEqual(deg('IV', 'c major'), { degree: 4, alter: 0 });
  assert.deepEqual(deg('bVII', 'c major'), { degree: 7, alter: -1 });
  // F–G–Em–Am 在 C 里就是 4-5-3-6
  assert.deepEqual(seq(['F', 'G', 'Em', 'Am'], 'c major').map((d) => d.degree), [4, 5, 3, 6]);
  // 移调后同样是 4-5-3-6
  assert.deepEqual(seq(['Ab', 'Bb', 'Gm', 'Cm'], 'e-flat major').map((d) => d.degree), [4, 5, 3, 6]);
  // 小调里 viio 的根（导音）是 7 级
  assert.deepEqual(deg('viio', 'a harmonic minor'), { degree: 7, alter: 0 });
});

test('王道进行 / 万能和弦进行 / 小变体：只比级数，不管转位与大小写', () => {
  // 4-5-3-6（原位）
  assert.equal(matchProgression(seq(['IV', 'V', 'iii', 'vi'], 'c major'))?.id, 'oudo');
  // 同一条进行，全部换成转位写法也照样命中
  assert.equal(matchProgression(seq(['IV6', 'V65', 'iii6', 'vi64'], 'c major'))?.id, 'oudo');
  // 大小写混着写也算（用户要求「不管有没有转位」，性质也不卡）
  assert.equal(matchProgression(seq(['iv', 'v', 'III', 'VI'], 'c major'))?.id, 'oudo');

  // 4536251
  const omni = seq(['F', 'G', 'Em', 'Am', 'Dm', 'G', 'C'], 'c major');
  assert.equal(matchProgression(omni)?.id, 'omni');

  // 4536251 后面再挂一个「1 级属七」→ 小变体
  assert.equal(matchProgression([...omni, { degree: 1, dominant7: true }])?.id, 'omniMinorVariant');
  // 同样八个级数，但最后那条不是属七 → 不算小变体
  assert.equal(matchProgression([...omni, { degree: 1, dominant7: false }]), null);

  // 长度不对就不认
  assert.equal(matchProgression(seq(['IV', 'V', 'iii'], 'c major')), null);
  assert.equal(matchProgression(seq(['IV', 'V', 'iii', 'vi', 'ii'], 'c major')), null);
});

test('丸之内进行：IVM7–III7–VIm7–I7（以及带 Vm7 的完整版）', () => {
  // 四和弦版（《丸の内サディスティック》）
  const short = progSeq(['IVmaj7', 'III7', 'vi7', 'I7'], 'c major');
  assert.equal(matchProgression(short)?.id, 'marunouchi');
  // 完整版（Just the Two of Us）：IVM7–III7–VIm7–Vm7–I7
  const full = progSeq(['IVmaj7', 'III7', 'vi7', 'v7', 'I7'], 'c major');
  assert.equal(matchProgression(full)?.id, 'marunouchiFull');
});

test('丸之内进行要求 III 是属七：调内的 iii7 不能冒名', () => {
  const diatonic = progSeq(['IVmaj7', 'iii7', 'vi7', 'I7'], 'c major');
  assert.equal(matchProgression(diatonic), null);
  // 同样的级数，单把 III 换成属七就命中
  const borrowed = progSeq(['IVmaj7', 'III7', 'vi7', 'I7'], 'c major');
  assert.equal(matchProgression(borrowed)?.id, 'marunouchi');
});

test('sanity：3 条以内永远返回 null（不够四次和弦的最小长度）', () => {
  assert.equal(matchProgression([]), null);
  assert.equal(matchProgression([{ degree: 4 }, { degree: 5 }]), null);
});
