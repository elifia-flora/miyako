import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLang, pickTitleTranslation, scriptOf } from '../src/shared/lang.js';

test('语言代码归一：全名 / 大小写 / en-US 都落到主标签', () => {
  assert.equal(normalizeLang('Japanese'), 'ja');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang(''), null);
});

test('字符集判据：假名算日文、汉字算中文、拉丁算英文', () => {
  assert.equal(scriptOf('おとなの掟'), 'ja');
  assert.equal(scriptOf('成人法则'), 'zh');
  assert.equal(scriptOf('Otona no Okite'), 'en');
  // 日文里夹汉字：只要有假名就是 ja
  assert.equal(scriptOf('灰ト祈リ'), 'ja');
  assert.equal(scriptOf('123 !!!'), null);
});

test('中文界面看日文曲：括号里给中文译名（别名里的罗马字和乐队名不算）', () => {
  const t = {
    original: 'おとなの掟',
    lang: 'ja',
    aliases: ['成人法则', 'Otona no Okite', 'Doughnuts Hole'],
  };
  assert.equal(pickTitleTranslation(t, 'zh-CN'), '成人法则');
  // 英文界面里退到拉丁写法那次（转写也是「能读的名字」）
  assert.equal(pickTitleTranslation(t, 'en'), 'Otona no Okite');
  // 日文界面：本来就是日文，不需要译名
  assert.equal(pickTitleTranslation(t, 'ja'), null);
});

test('中文界面看英文曲：别名里只有一条中文，就取它', () => {
  const t = { original: 'The deepest nightmare of Sibyl', lang: 'en', aliases: ['希贝尔最深的梦魇'] };
  assert.equal(pickTitleTranslation(t, 'zh'), '希贝尔最深的梦魇');
});

test('不猜的几种情况：没写原语言 / 别名空 / 别名就是原名 / 已本地化', () => {
  assert.equal(pickTitleTranslation({ original: '测试 A', lang: null, aliases: ['试验 A'] }, 'zh'), null);
  assert.equal(pickTitleTranslation({ original: 'Foo', lang: 'en', aliases: [] }, 'zh'), null);
  // 别名等于原名（大小写/空白不同也算一样）时不能当译名
  assert.equal(pickTitleTranslation({ original: 'Foo', lang: 'en', aliases: ['foo'] }, 'zh'), null);
  // 中文曲目在中文界面：不显示
  assert.equal(pickTitleTranslation({ original: '神鹿谣', lang: 'zh', aliases: ['神鹿'] }, 'zh'), null);
  // 认不出的语言代码：不显示（宁可空着）
  assert.equal(pickTitleTranslation({ original: 'Foo', lang: 'klingon', aliases: ['福'] }, 'zh'), null);
});
