import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChord } from '../src/shared/chord.js';
import {
  romanFromSposobin,
  sposobinCaseNote,
  sposobinHint,
  sposobinCandidates,
  sposobinOf,
  sposobinOfText,
} from '../src/shared/sposobin.js';

/**
 * 级数 / 绝对和弦 → 斯波索宾（苏俄）体系标记。
 *
 * 写法是与用户逐条对过的（见 `shared/sposobin.js` 顶部注释）：
 * 原位三和弦不带数字、四六写作 46、大小写跟和弦性质、副和弦级数永远大写。
 * 这些断言的价值在于「以后谁改一个字都会被抓到」—— 尤其是大小写：
 * `dtVII` 与 `DVII` 差一个字母，含义完全不同。
 */

const C = 'c major';
const A = 'a minor';
const EB = 'e-flat minor';

test('原位三和弦不带数字；第一转位 6、第二转位 46（苏俄先读小数字）', () => {
  assert.equal(sposobinOfText('I', C), 'T');
  assert.equal(sposobinOfText('I6', C), 'T6');
  assert.equal(sposobinOfText('I64', C), 'T46');
  assert.equal(sposobinOfText('V', C), 'D');
  assert.equal(sposobinOfText('V64', C), 'D46');
});

test('七和弦四转位：7 / 56 / 34 / 2（苏俄「先读小数字」，不是 65 / 43）', () => {
  assert.equal(sposobinOfText('V7', C), 'D7');
  assert.equal(sposobinOfText('V65', C), 'D56');
  assert.equal(sposobinOfText('V43', C), 'D34');
  assert.equal(sposobinOfText('V42', C), 'D2');
});

test('大调副和弦：SII / DTIII / TSVI / DVII（级数大写）', () => {
  assert.equal(sposobinOfText('ii7', C), 'SII7');
  assert.equal(sposobinOfText('iii', C), 'DTIII');
  assert.equal(sposobinOfText('vi', C), 'TSVI');
  assert.equal(sposobinOfText('vii°', C), 'DVII');
  assert.equal(sposobinOfText('vii°7', C), 'DVII7');
});

test('大调借用小下属：小写 s（自然大调「和声大调化」）', () => {
  assert.equal(sposobinOfText('iv', C), 's');
  assert.equal(sposobinOfText('iv6', C), 's6');
});

test('小调：主与下属小写，和声属和弦大写 D', () => {
  assert.equal(sposobinOfText('i', A), 't');
  assert.equal(sposobinOfText('i6', A), 't6');
  assert.equal(sposobinOfText('iv', A), 's');
  assert.equal(sposobinOfText('V7', A), 'D7');
  // 自然小调的 v 是小三和弦 → 小写 d
  assert.equal(sposobinOfText('v7', A), 'd7');
});

test('小调副和弦：tsVI / dtIII / DtIII / dtVII / DVII', () => {
  assert.equal(sposobinOfText('VI', A), 'tsVI');
  // 自然三级（大三和弦，没有升导音）
  assert.equal(sposobinOfText('III', A), 'dtIII');
  // 和声小调的增三：D 大写、t 保留小写
  assert.equal(sposobinOfText('III+', A), 'DtIII');
  // 自然七级（大三和弦，没有升导音）→ d、t 都小写
  assert.equal(sposobinOfText('VII', A), 'dtVII');
  assert.equal(sposobinOfText('VII7', A), 'dtVII7');
  // 升导音的七级 → DVII
  assert.equal(sposobinOfText('vii°', A), 'DVII');
  assert.equal(sposobinOfText('iiø7', A), 'sII7');
});

test('调名带限定词也算小调：和声小调 / 自然小调 / 多利亚', () => {
  // parseKeyName 返回的是原始尾巴（harmonic minor），只比 'minor' 会把它们判成大调
  assert.equal(sposobinOfText('i', 'a harmonic minor'), 't');
  assert.equal(sposobinOfText('iiø7', 'e-flat harmonic minor'), 'sII7');
  assert.equal(sposobinOfText('VII', 'a natural minor'), 'dtVII');
  assert.equal(sposobinOfText('i', 'd dorian'), 't');
});

test('终止四六 → K46（小调同样是大写 K，与调性无关）', () => {
  assert.equal(sposobinOfText('Cad64', C), 'K46');
  assert.equal(sposobinOfText('Cad64', A), 'K46');
});

test('离调（副属）用斜杠写法：前=应用和弦在临时主调的名字，后=目标在本调的名字', () => {
  // 用户给的例子：e♭ 小调的 iii6/III —— 目标是自然三级（大三），临时主音调按大调算
  assert.equal(sposobinOfText('iii6/III', 'e-flat minor'), 'DTIII6/dtIII');
  // C 大调 V7/ii：目标是 ii（小三），临时主调是小调 → 属七写 D7，目标写 SII
  assert.equal(sposobinOfText('V7/ii', C), 'D7/SII');
  // 目标和弦本身的性质大小写也要对：iv 在本调是小三 → s
  assert.equal(sposobinOfText('V6/iv', 'e-flat harmonic minor'), 'D6/s');
  // 目标不是 V（重属走 DD 系列，见下一条用例）
  assert.equal(sposobinOfText('V65/ii', C), 'D56/SII');
  assert.equal(sposobinOfText('V7/vi', C), 'D7/TSVI');
});

test('重属（属之属）用 DD 系列，不用斜杠', () => {
  assert.equal(sposobinOfText('V/V', C), 'DD');
  assert.equal(sposobinOfText('V7/V', C), 'DD7');
  assert.equal(sposobinOfText('V65/V', C), 'DD56');
  assert.equal(sposobinOfText('V43/V', C), 'DD34');
  assert.equal(sposobinOfText('V42/V', C), 'DD2');
  assert.equal(sposobinOfText('vii°7/V', C), 'DDVII7');
  // 小调的重属也是大写 DD（变化和弦）
  assert.equal(sposobinOfText('V7/V', A), 'DD7');
  // 目标不是 V 的仍走斜杠
  assert.equal(sposobinOfText('V7/ii', C), 'D7/SII');
});

test('非调内 / 延伸音一律不猜', () => {
  assert.equal(sposobinOfText('♭II', C), null); // 那不勒斯式借用
  assert.equal(sposobinOfText('N6', C), null);
  assert.equal(sposobinOfText('V9', C), null); // 延伸音
  assert.equal(sposobinOfText('V7sus4', C), null); // 挂留
  assert.equal(sposobinOfText('V7sub6', C), null); // 六音替五音
  assert.equal(sposobinOfText('乱写', C), null);
  assert.equal(sposobinOf(null, C), null);
});

test('字母和弦也能转：先按该 tick 的调性反推级数', () => {
  assert.equal(sposobinOfText('C', C), 'T');
  assert.equal(sposobinOfText('C/E', C), 'T6');
  assert.equal(sposobinOfText('G7', C), 'D7');
  assert.equal(sposobinOfText('Dm7', C), 'SII7');
  assert.equal(sposobinOfText('Am', C), 'TSVI');
  assert.equal(sposobinOfText('Em', A), 'd'); // 小调自然属和弦：小写 d
  assert.equal(sposobinOfText('E7', A), 'D7'); // 和声小调的属七
  assert.equal(sposobinOfText('G7', A), 'dtVII7'); // 自然七级上的属七 = 下属-主功能（小写）
  // 调外和弦反推出来带变化音 → 不猜
  assert.equal(sposobinOfText('D7', C), null);
  // 根音在调内、但性质不对（II 级是大三的属七）→ 也不猜：拼 `SII7` 会是像模像样的错标记
  assert.equal(sposobinOfText('D7', C), null);
  assert.equal(sposobinOfText('B7', C), null);
});

test('补全：大小写严格服从输入 —— 打 d 只给 d 族，打 D 只给 D 族', () => {
  const major = sposobinCandidates('T', C);
  assert.ok(major.includes('T') && major.includes('T6') && major.includes('T46') && major.includes('T7'));
  const minor = sposobinCandidates('d', A);
  // 小调里两个属都合法，但**一次只给用户敲的那一套**：d 就是 d，D 要自己打
  assert.ok(minor.includes('d') && minor.includes('d7') && minor.includes('dtIII'));
  assert.equal(minor.includes('D7'), false);
  assert.equal(sposobinCandidates('D', A).includes('d7'), false);
  assert.ok(sposobinCandidates('K', C).includes('K46'));
  assert.deepEqual(sposobinCandidates('', C), []);
});

test('补全：带斜杠时只补目标，前半截原样保留', () => {
  const list = sposobinCandidates('D7/', C);
  assert.ok(list.includes('D7/T') && list.includes('D7/SII'));
  assert.ok(list.every((v) => v.startsWith('D7/')));
});

test('补全排序：S 组里 S6 / S46 / SII6 / SII7 及其转位排在 S7 前面', () => {
  const list = sposobinCandidates('S', C);
  assert.equal(list[0], 'S'); // 完全相等的永远第一
  assert.deepEqual(list.slice(1, 9), ['S6', 'S46', 'SII6', 'SII46', 'SII7', 'SII56', 'SII34', 'SII2']);
  // S7 那一族排在常用项之后
  assert.ok(list.indexOf('S7') > list.indexOf('SII2'));
  // 小调同理（小写一套）
  const minor = sposobinCandidates('s', A);
  assert.equal(minor[0], 's');
  assert.deepEqual(minor.slice(1, 9), ['s6', 's46', 'sII6', 'sII46', 'sII7', 'sII56', 'sII34', 'sII2']);
});

test('补全排序：完全相等的候选永远第一（S7 / S34 / sII56）', () => {
  assert.equal(sposobinCandidates('S7', C)[0], 'S7');
  assert.equal(sposobinCandidates('S34', C)[0], 'S34');
  assert.equal(sposobinCandidates('sII56', A)[0], 'sII56');
  // 前缀但不等：SII 本身是精确的，跟在后头的才是常用表
  assert.equal(sposobinCandidates('SII', C)[0], 'SII');
});

test('大小写不再互相顶替：小调敲 S 给大写族，大调敲 s 给小写族（v0.74）', () => {
  // 以前这里会「打 S 却补出 s」——用户想借同主音大调的大下属时被改掉，很抓狂
  const upperInMinor = sposobinCandidates('S', A);
  assert.equal(upperInMinor[0], 'S');
  assert.equal(upperInMinor.includes('s'), false);
  assert.ok(upperInMinor.includes('SII'));
  assert.equal(upperInMinor.includes('sII'), false);

  const lowerInMajor = sposobinCandidates('s', C);
  assert.equal(lowerInMajor[0], 's');
  assert.equal(lowerInMajor.includes('S'), false);
  assert.ok(lowerInMajor.includes('sII'));
  assert.equal(lowerInMajor.includes('SII'), false);

  // 转位 / 二级那些也一样，逐条跟着大小写走
  // 转位那层也跟着：`S5` / `s5` 都是「II 族更常用」，所以 SII56 在前
  assert.deepEqual(sposobinCandidates('S5', A).slice(0, 2), ['SII56', 'S56']);
  assert.deepEqual(sposobinCandidates('s5', C).slice(0, 2), ['sII56', 's56']);
});

test('大小写越界的附注：小调大下属 → rare（橙黄），大调小下属 → borrowed（绿），Dorian 正常', () => {
  assert.equal(sposobinCaseNote('S', A), 'rare');
  assert.equal(sposobinCaseNote('SII7', A), 'rare');
  assert.equal(sposobinCaseNote('S', 'a harmonic minor'), 'rare');
  assert.equal(sposobinCaseNote('s', A), null); // 小调里小下属是常态
  assert.equal(sposobinCaseNote('s', C), 'borrowed');
  assert.equal(sposobinCaseNote('sII6', C), 'borrowed');
  assert.equal(sposobinCaseNote('S', C), null); // 大调里大下属是常态
  // 多利亚的 IV 本来就大三，大 S 是默认写法，不提示
  assert.equal(sposobinCaseNote('S', 'd dorian'), null);
  assert.equal(sposobinCaseNote('s', 'd dorian'), null);
  // 只认 S 族：T / D 的大小写没有「越界」可言
  assert.equal(sposobinCaseNote('D', A), null);
  assert.equal(sposobinCaseNote('T', A), null);
});

test('补全里有 DD / DDVII 一族', () => {
  const major = sposobinCandidates('DD', C);
  assert.ok(major.includes('DD') && major.includes('DD7') && major.includes('DDVII7'));
  assert.equal(major[0], 'DD');
});

test('同族第二条：完全相等第一，紧接着是「同转位的同族写法」', () => {
  // 用户口径（2026-11-05）：DD56 第一条 DD56，第二条要能顺手给出 DDVII56
  assert.deepEqual(sposobinCandidates('DD56', C).slice(0, 2), ['DD56', 'DDVII56']);
  assert.deepEqual(sposobinCandidates('DD34', C).slice(0, 2), ['DD34', 'DDVII34']);
  // D7 ↔ DVII7（属七 / 导七），S56 ↔ SII56（下属 / 下属二级）
  assert.deepEqual(sposobinCandidates('D7', C).slice(0, 2), ['D7', 'DVII7']);
  assert.deepEqual(sposobinCandidates('S56', C).slice(0, 2), ['S56', 'SII56']);
  // 完全匹配永远第一：S56 不许把 SII56 顶上去
  assert.equal(sposobinCandidates('S56', C)[0], 'S56');
  // 转位数字还没敲完也认：打 D5 第一条 D56，第二条 DVII56
  assert.deepEqual(sposobinCandidates('D5', C).slice(0, 2), ['D56', 'DVII56']);
  // 小写一套
  assert.deepEqual(sposobinCandidates('s56', A).slice(0, 2), ['s56', 'sII56']);
});

test('原位（不写数字）不会被同族塞满：DD 之后先给 DD，再 DDVII，然后才是 DD2 / DD6', () => {
  const list = sposobinCandidates('DD', C);
  assert.deepEqual(list.slice(0, 3), ['DD', 'DDVII', 'DD2']);
  // S 组原位仍按常用表走，SII 不许插到 S6 前面
  assert.deepEqual(sposobinCandidates('S', C).slice(1, 4), ['S6', 'S46', 'SII6']);
});

/* ---- 反解：斯波索宾标记 → 罗马数字（为了让这一栏也能解析出和弦音） ---- */

test('反解：正三和弦 / 副三和弦 → 罗马数字，大小写跟着性质走', () => {
  assert.equal(romanFromSposobin('T', C), 'I');
  assert.equal(romanFromSposobin('t6', A), 'i6');
  assert.equal(romanFromSposobin('S', C), 'IV');
  assert.equal(romanFromSposobin('s', A), 'iv');
  assert.equal(romanFromSposobin('SII', C), 'ii');
  assert.equal(romanFromSposobin('SII7', C), 'ii7');
  // 小调：二级是减三，写成七和弦是半减七
  assert.equal(romanFromSposobin('sII', A), 'ii°');
  assert.equal(romanFromSposobin('sII7', A), 'iiø7');
  assert.equal(romanFromSposobin('TSVI', C), 'vi');
  assert.equal(romanFromSposobin('tsVI', A), 'VI');
});

test('反解：转位数字要换成国际写法（56/34/46/2 → 65/43/64/42）', () => {
  assert.equal(romanFromSposobin('D7', C), 'V7');
  assert.equal(romanFromSposobin('D56', C), 'V65');
  assert.equal(romanFromSposobin('D34', C), 'V43');
  assert.equal(romanFromSposobin('D2', C), 'V42');
  assert.equal(romanFromSposobin('T46', C), 'I64');
  // 终止四六走解析器自己的写法
  assert.equal(romanFromSposobin('K46', C), 'Cad64');
});

test('反解：导音七 / 自然七 / 增三，三种「七级与三级」不能混', () => {
  assert.equal(romanFromSposobin('DVII7', C), 'vii°7');
  assert.equal(romanFromSposobin('DVII', C), 'vii°');
  assert.equal(romanFromSposobin('dtVII', A), 'VII');
  assert.equal(romanFromSposobin('dtVII7', A), 'VII7');
  assert.equal(romanFromSposobin('dtIII', EB), 'III');
  assert.equal(romanFromSposobin('DtIII', EB), 'III+');
});

test('反解：重属与离调保留斜杠', () => {
  assert.equal(romanFromSposobin('DD7', C), 'V7/V');
  assert.equal(romanFromSposobin('DD56', C), 'V65/V');
  assert.equal(romanFromSposobin('DDVII7', C), 'vii°7/V');
  assert.equal(romanFromSposobin('DTIII6/dtIII', EB), 'III6/III');
  assert.equal(romanFromSposobin('D7/SII', C), 'V7/ii');
});

test('反解：认不出来就返回 null（不制造「解析失败」的假告警）', () => {
  assert.equal(romanFromSposobin('见第 3 小节', C), null);
  assert.equal(romanFromSposobin('Z7', C), null);
  assert.equal(romanFromSposobin('', C), null);
  assert.equal(romanFromSposobin('V7/ii/x', C), null);
});

test('反解 + 解析：拼出来的和弦音与理论一致', () => {
  const tones = (t, k) => parseChord(romanFromSposobin(t, k), { key: k }).toneNames;
  assert.deepEqual(tones('D7', C), ['G', 'B', 'D', 'F']);
  assert.deepEqual(tones('sII7', A), ['B', 'D', 'F', 'A']);   // iiø7
  assert.deepEqual(tones('dtIII', EB), ['G♭', 'B♭', 'D♭']);   // 自然三级：大三
  assert.deepEqual(tones('DtIII', EB), ['G♭', 'B♭', 'D']);    // 和声小调：增三
  assert.deepEqual(tones('DD7', C), ['D', 'F♯', 'A', 'C']);
  assert.deepEqual(tones('DTIII6/dtIII', EB), ['D', 'F', 'B♭']);
});

/* ---- 补全：子序列匹配 + 六级特例（2026-11-07 用户逐条给的次序） ---- */

test('补全：s5 → sII56 第一、s56 第二（II 族更常用，压过「字面开头」）', () => {
  assert.deepEqual(sposobinCandidates('s5', A).slice(0, 2), ['sII56', 's56']);
  assert.deepEqual(sposobinCandidates('S5', C).slice(0, 2), ['SII56', 'S56']);
  // 同族混进来的 TSVI56 要被「功能首字母」过滤掉：它在找的是 S 族，不是主-下属
  assert.equal(sposobinCandidates('s5', A).includes('tsVI56'), false);
  assert.equal(sposobinCandidates('S5', C).includes('TSVI56'), false);
});

test('补全：打 i / I → 先给同大小写的一组，另一组排在后面', () => {
  assert.deepEqual(sposobinCandidates('i', A).slice(0, 4), ['sII6', 'sII56', 'sII', 'tsVI']);
  assert.deepEqual(sposobinCandidates('I', A).slice(0, 4), ['SII6', 'SII56', 'SII', 'TSVI']);
  // 大调池里两套写法现在都在（v0.74 的并集），所以 i 也给得出小写族
  assert.deepEqual(sposobinCandidates('i', C).slice(0, 4), ['sII6', 'sII56', 'sII', 'tsVI']);
  assert.deepEqual(sposobinCandidates('I', C).slice(0, 4), ['SII6', 'SII56', 'SII', 'TSVI']);
  // 小写那一组排完之后，大写那一组接着按同样次序来
  const minorList = sposobinCandidates('i', A);
  assert.ok(minorList.indexOf('sII6') < minorList.indexOf('SII6'));
});

test('补全：ii / Ii 时 tsVI 不匹配（它只有一个 I），自己消失', () => {
  for (const key of [A, C]) {
    for (const token of ['ii', 'Ii']) {
      const list = sposobinCandidates(token, key);
      assert.ok(list.length > 0, `${token} @ ${key} 不该是空的`);
      assert.equal(list.some((v) => /tsvi/i.test(v)), false, `${token} @ ${key} 不该有 tsVI`);
      assert.ok(list.includes(key === A ? 'sII' : 'SII'));
    }
  }
});

test('补全：ts / v / vi → 六级整族在前，族内按 6 → 7 → 56 → 34 → 2 → 46', () => {
  const upper = ['TSVI', 'TSVI6', 'TSVI7', 'TSVI56', 'TSVI34', 'TSVI2', 'TSVI46'];
  const lower = ['tsVI', 'tsVI6', 'tsVI7', 'tsVI56', 'tsVI34', 'tsVI2', 'tsVI46'];
  // 大小写跟输入走：小写键给小写族，大写键给大写族（v0.74）
  for (const token of ['ts', 'v', 'vi']) {
    assert.deepEqual(sposobinCandidates(token, C).slice(0, 7), lower, token);
    assert.deepEqual(sposobinCandidates(token, A).slice(0, 7), lower, token);
  }
  for (const token of ['TS', 'V', 'VI']) {
    assert.deepEqual(sposobinCandidates(token, C).slice(0, 7), upper, token);
    assert.deepEqual(sposobinCandidates(token, A).slice(0, 7), upper, token);
  }
});

test('补全：只打 t / T → 主和弦三和弦先（t t6 t46），六级居中，主和弦七和弦收尾', () => {
  // 用户 2026-11-07 纠正：t 的第一条必须是 t 本身，「完全相等永远第一」那条规矩是对的
  const lower = sposobinCandidates('t', C);
  assert.deepEqual(lower.slice(0, 3), ['t', 't6', 't46']);
  assert.deepEqual(lower.slice(3, 10), ['tsVI', 'tsVI6', 'tsVI7', 'tsVI56', 'tsVI34', 'tsVI2', 'tsVI46']);
  assert.deepEqual(lower.slice(10, 14), ['t7', 't56', 't34', 't2']);

  const upper = sposobinCandidates('T', C);
  assert.deepEqual(upper.slice(0, 3), ['T', 'T6', 'T46']);
  assert.deepEqual(upper.slice(3, 10), ['TSVI', 'TSVI6', 'TSVI7', 'TSVI56', 'TSVI34', 'TSVI2', 'TSVI46']);
  assert.deepEqual(upper.slice(10, 14), ['T7', 'T56', 'T34', 'T2']);
  // 小调同理（t 是小写族，T 是大写族）
  assert.deepEqual(sposobinCandidates('t', A).slice(0, 3), ['t', 't6', 't46']);
});

test('补全说明：罗马数字 + 转位序号（序号文案由界面拼，N 的写法跟偏好）', () => {
  // `inv` 是转位序号（0 = 原位），界面再用 numeral.js 拼成「第一转位 / 第1转位 / 1st inversion」
  assert.deepEqual(sposobinHint('D56', C), { roman: 'V65', inv: 1 });
  assert.deepEqual(sposobinHint('SII7', C), { roman: 'ii7', inv: 0 });
  assert.deepEqual(sposobinHint('sII7', A), { roman: 'iiø7', inv: 0 });
  assert.deepEqual(sposobinHint('T', C), { roman: 'I', inv: 0 });
  assert.deepEqual(sposobinHint('tsVI', A), { roman: 'VI', inv: 0 });
  assert.deepEqual(sposobinHint('D2', C), { roman: 'V42', inv: 3 });
  assert.deepEqual(sposobinHint('T46', C), { roman: 'I64', inv: 2 });
  // K46 没有「第几转位」这一说，交给界面单独给文案
  assert.deepEqual(sposobinHint('K46', C), { roman: 'Cad64', inv: null });
  // 七级的导七 / 重导也要译得出来
  assert.equal(sposobinHint('DDVII7', C).roman, 'vii°7/V');
});

test('补全：v / vi 在六级七项之后接「导七四转位 → 重导系列」', () => {
  const want = [
    'tsVI', 'tsVI6', 'tsVI7', 'tsVI56', 'tsVI34', 'tsVI2', 'tsVI46',
    'DVII7', 'DVII56', 'DVII34', 'DVII2',
    'DDVII', 'DDVII7', 'DDVII56', 'DDVII34', 'DDVII2',
  ];
  // 小写输入 → 小写六级 + 导七 / 重导（后者本来就只有大写写法）
  assert.deepEqual(sposobinCandidates('v', C).slice(0, 16), want);
  assert.deepEqual(sposobinCandidates('vi', C).slice(0, 16), want);
  assert.deepEqual(sposobinCandidates('vi', A).slice(0, 16), want);
  // 大写输入 → 大写六级，后半截不变
  assert.deepEqual(
    sposobinCandidates('VI', C).slice(0, 16),
    want.map((v) => v.replace('tsVI', 'TSVI'))
  );
  // `ts` 不接导七那一串（`t` 也不接，它接的是自己的三和弦 / 七和弦）
  assert.equal(sposobinCandidates('ts', C).includes('DVII7'), false);
  assert.equal(sposobinCandidates('t', C).includes('DVII7'), false);
});
