import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedExternal, isAppPage } from '../src/main/nav-policy.js';
import { songDeepLink, neteaseSongId } from '../src/shared/netease.js';

test('外链：http / https 网页可以交给系统浏览器', () => {
  assert.equal(isAllowedExternal('https://music.163.com/#/song?id=123'), true);
  assert.equal(isAllowedExternal('http://example.com/'), true);
});

test('外链：网易云唤起地址（orpheus://）不会被拦', () => {
  const id = neteaseSongId('https://music.163.com/#/song?id=1824045033');
  assert.ok(id);
  const deep = songDeepLink(id);
  assert.ok(deep.startsWith('orpheus://'));
  assert.equal(isAllowedExternal(deep), true);
});

test('外链：file / javascript / 自定义协议 / 乱写的地址一律不开', () => {
  for (const url of [
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'ma-audio://audio/trk-1',
    'ma-art://cover/trk-1/single',
    'ms-settings:privacy',
    'smb://host/share',
    'not a url',
    '',
    null,
    undefined,
    42,
  ]) {
    assert.equal(isAllowedExternal(url), false, String(url));
  }
});

test('外链：带账号密码的 http(s) 地址不开', () => {
  assert.equal(isAllowedExternal('https://user:pass@example.com/'), false);
});

test('页面跳转：打包后只认 index.html 本身（hash / query 不影响）', () => {
  const app = { devUrl: null, pageUrl: 'file:///opt/miyako/resources/app.asar/out/renderer/index.html' };
  assert.equal(isAppPage('file:///opt/miyako/resources/app.asar/out/renderer/index.html#lyrics', app), true);
  assert.equal(isAppPage('file:///opt/miyako/resources/app.asar/out/renderer/index.html?x=1', app), true);
  assert.equal(isAppPage('file:///home/me/Music/song.flac', app), false);
  assert.equal(isAppPage('https://music.163.com/', app), false);
});

test('页面跳转：开发模式认 dev server 同源', () => {
  const app = { devUrl: 'http://localhost:5173', pageUrl: 'file:///x/index.html' };
  assert.equal(isAppPage('http://localhost:5173/#grid', app), true);
  assert.equal(isAppPage('http://localhost:5174/', app), false);
  assert.equal(isAppPage('https://example.com/', app), false);
});
