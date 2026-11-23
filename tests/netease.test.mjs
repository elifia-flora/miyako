import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as links from '../src/shared/netease.js';

const id = '458725738';
const songUrl = `https://music.163.com/song?id=${id}`;

for (const url of [
  songUrl,
  ` https://music.163.com/song?id=${id}&userid=123456789 `,
  `https://music.163.com/#/song?id=${id}`,
  `https://music.163.com/?userid=123456789#/song?id=${id}`,
  `https://y.music.163.com/m/song?id=${id}&app_version=9`,
  `https://music.163.com/song/${id}/`,
  `https://music.163.com/#/song/${id}`,
  `http://music.163.com/m/song?id=${id}`,
]) {
  test(`提取网易云歌曲编号：${url}`, () => assert.equal(links.neteaseSongId(url), id));
}

for (const url of [
  `https://music.163.com/album?id=${id}`,
  `https://music.163.com/playlist?id=${id}`,
  `https://music.163.com/artist?id=${id}`,
  `https://music.163.com/song?userid=${id}`,
  `https://music.163.com/song?id=${id}oops`,
  `https://music.163.com/#//example.com/song?id=${id}`,
  'https://music.163.com/#//[',
  `https://example.com/song?id=${id}`,
  `https://music.163.com.example.com/song?id=${id}`,
  `https://music.163.com@example.com/song?id=${id}`,
  `https://example.com/?url=${encodeURIComponent(songUrl)}`,
  `https://music.163.com/song?id=0`,
  `https://music.163.com/song?id=-1`,
  id,
]) {
  test(`非歌曲链接不猜编号：${url}`, () => assert.equal(links.neteaseSongId(url), null));
}

for (const value of [null, undefined, {}, 123, '', 'not a url', 'file:///C:/test', 'javascript:alert(1)', 'orpheus://anything', 'https://', 'https://user:pass@music.163.com/song?id=1']) {
  test(`拒绝不安全或非法网页链接：${String(value)}`, () => assert.equal(links.parseWebLink(value), null));
}

test('客户端链接解码后是官网的歌曲播放指令，编号保持字符串精度', () => {
  for (const songId of [id, '2603027640', '9007199254740993']) {
    const link = links.songDeepLink(songId);
    assert.ok(link.startsWith('orpheus://'));
    assert.deepEqual(JSON.parse(Buffer.from(link.slice('orpheus://'.length), 'base64').toString('utf8')), {
      type: 'song', id: songId, cmd: 'play',
    });
  }
});

test('播放指令不接受其他协议或注入内容', () => {
  for (const value of ['', '0', '-1', '1&cmd=download', '";calc.exe', null, 123]) {
    assert.throws(() => links.songDeepLink(value), TypeError);
  }
});

const moduleCode = ts.transpileModule(
  readFileSync(new URL('../src/main/ipc/netease.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function opener(openExternal, argv = []) {
  const exports = {};
  const require = (name) => {
    if (name === 'electron') return { shell: { openExternal } };
    if (name === '../../shared/netease.js') return links;
    if (name === '../locale') return { mt: (key, vars) => `${key} ${JSON.stringify(vars ?? {})}` };
    throw new Error(`Unexpected dependency: ${name}`);
  };
  new Function('require', 'exports', 'process', 'console', moduleCode)(require, exports, { argv }, { warn() {} });
  return exports.openMusicLink;
}

test('网易云链接只发一次客户端播放指令', async () => {
  const calls = [];
  const open = opener(async (url) => calls.push(url));
  const result = await open(songUrl);
  assert.deepEqual(calls, [links.songDeepLink(id)]);
  assert.equal(result.ok, true);
  assert.equal(result.via, 'orpheus');
});

test('客户端协议失败则用浏览器打开原链接', async () => {
  const calls = [];
  const open = opener(async (url) => {
    calls.push(url);
    if (url.startsWith('orpheus:')) throw new Error('No protocol handler');
  });
  const result = await open(songUrl);
  assert.deepEqual(calls, [links.songDeepLink(id), songUrl]);
  assert.equal(result.via, 'browser');
  assert.equal(result.ok, true);
});

test('非网易云链接与专辑链接只交给浏览器', async () => {
  const calls = [];
  const open = opener(async (url) => calls.push(url));
  for (const url of ['https://example.com/?id=458725738', 'https://music.163.com/album?id=458725738']) {
    assert.equal((await open(url)).via, 'browser');
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => url.startsWith('https:')));
});

test('非法输入不调用系统外链接口', async () => {
  const calls = [];
  const open = opener(async (url) => calls.push(url));
  assert.equal((await open('file:///C:/test')).ok, false);
  assert.equal((await open(null)).ok, false);
  assert.deepEqual(calls, []);
});

test('系统调用全部失败时返回原始错误，不误报成功', async () => {
  const open = opener(async () => { throw new Error('Blocked by OS'); });
  const result = await open(songUrl);
  assert.equal(result.ok, false);
  assert.equal(result.via, 'failed');
  assert.match(result.note, /Blocked by OS/);
});

test('冒烟模式同时拦截网易云客户端与通用浏览器外呼', async () => {
  const calls = [];
  const open = opener(async (url) => calls.push(url), ['--smoke']);
  const result = await open(songUrl);
  assert.equal(result.noteVars.link, links.songDeepLink(id));
  assert.equal((await open('https://example.com/')).ok, false);
  assert.deepEqual(calls, []);
});
