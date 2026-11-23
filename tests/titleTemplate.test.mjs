import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expandTitleTemplate,
  templateHasVars,
  templateSegments,
  templateVarKey,
} from '../src/shared/titleTemplate.js';

const CLASSICAL = '%Composer} - %form} %Number of the form} in %Key}, %Opus Number}';
const MOVEMENT = '%Movement Number} %Sub-Type} - %Tempo Term}';

test('变量名：大小写 / 空格 / 连字符都不敏感', () => {
  assert.equal(templateVarKey('Composer'), 'composer');
  assert.equal(templateVarKey('Number of the form'), 'formNumber');
  assert.equal(templateVarKey('OPUS_NUMBER'), 'opusNumber');
  assert.equal(templateVarKey('Sub-Type'), 'subType');
  assert.equal(templateVarKey('sub_type'), 'subType');
  // 旧模板名仍认：用户自定义预设里可能还写着 %sub-form}
  assert.equal(templateVarKey('sub-form'), 'subType');
  assert.equal(
    expandTitleTemplate('%sub-form}', { subType: 'Menuetto' }),
    'Menuetto'
  );
  assert.equal(templateVarKey('Tempo Term'), 'tempoTerm');
  assert.equal(templateVarKey('nonsense'), null);
});

test('切段：变量整段（含 % 与 }）单独一片，其它字符照常', () => {
  const segs = templateSegments('a %Composer} - b');
  assert.deepEqual(
    segs.map((s) => [s.text, s.variable, s.key]),
    [
      ['a ', false, null],
      ['%Composer}', true, 'composer'],
      [' - b', false, null],
    ]
  );
  assert.equal(templateHasVars('no vars'), false);
  assert.equal(templateHasVars('%Key}'), true);
});

test('古典作品标题：变量按数据展开', () => {
  const title = expandTitleTemplate(CLASSICAL, {
    composer: 'Beethoven',
    form: 'Piano Sonata',
    formNumber: 'No.1',
    key: 'F Minor',
    opusNumber: 'Op.2, No.1',
  });
  assert.equal(title, 'Beethoven - Piano Sonata No.1 in F Minor, Op.2, No.1');
});

test('缺失的变量整段消失，空格收成一个', () => {
  assert.equal(
    expandTitleTemplate('%Movement Number} %Sub-Type} - %Tempo Term}', {
      movementNumber: '第二乐章',
      subType: '',
      tempoTerm: '柔板',
    }),
    '第二乐章 - 柔板'
  );
  assert.equal(
    expandTitleTemplate(MOVEMENT, {
      movementNumber: '第三乐章',
      subType: '小步舞曲',
      tempoTerm: '小快板',
    }),
    '第三乐章 小步舞曲 - 小快板'
  );
});

test('缺失后悬空的分隔符 / 标点空格会被收掉', () => {
  assert.equal(
    expandTitleTemplate(CLASSICAL, {
      composer: 'Beethoven',
      form: 'Sonata',
      formNumber: 'No.1',
      key: 'F Minor',
      opusNumber: '',
    }),
    'Beethoven - Sonata No.1 in F Minor'
  );
  assert.equal(
    expandTitleTemplate('%Movement Number} %Sub-Type} - %Tempo Term}', {
      movementNumber: '第二乐章',
      subType: '',
      tempoTerm: '',
    }),
    '第二乐章'
  );
});

test('模板里字面的连续空格不被吞；只塌缩空变量留下的空位', () => {
  assert.equal(
    expandTitleTemplate('A   B %Key}', { key: 'C' }),
    'A   B C'
  );
  assert.equal(
    expandTitleTemplate('%Movement Number}  %Sub-Type} - %Tempo Term}', {
      movementNumber: '第二乐章',
      subType: '',
      tempoTerm: '柔板',
    }),
    '第二乐章 - 柔板'
  );
});

test('未知变量原样保留；没有变量时一个字都不动', () => {
  assert.equal(expandTitleTemplate('A %Unknown} B', {}), 'A %Unknown} B');
  assert.equal(expandTitleTemplate('第三乐章 小步舞曲', {}), '第三乐章 小步舞曲');
});

test('全被省略时用 fallback，标题不会变空', () => {
  assert.equal(expandTitleTemplate(CLASSICAL, {}, { fallback: CLASSICAL }), CLASSICAL);
});
