import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt } from '../src/shared/srt.js';
import { activeLineIndex } from '../src/shared/lrc.js';
import { decodeLyricBytes } from '../src/shared/lyrictext.js';

test('SRT：序号、逗号毫秒、多行文本', () => {
  const text = ['1', '00:00:01,000 --> 00:00:04,200', '第一行', '第二行', '', '2', '00:00:05.000 --> 00:00:06.000', '下一句'].join('\n');
  const { lines } = parseSrt(text);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ms, 1000);
  assert.equal(lines[0].endMs, 4200);
  assert.equal(lines[0].text, '第一行\n第二行');
  assert.equal(lines[1].ms, 5000);
  assert.equal(activeLineIndex(lines, 1000), 0);
  assert.equal(activeLineIndex(lines, 4200), -1);
  assert.equal(activeLineIndex(lines, 4500), -1);
});

test('歌词字节：UTF-8 BOM 与 UTF-16 LE BOM', () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
  assert.equal(decodeLyricBytes(utf8), 'a');
  const le = new Uint8Array([0xff, 0xfe, 0x61, 0x00]);
  assert.equal(decodeLyricBytes(le), 'a');
  const be = new Uint8Array([0xfe, 0xff, 0x00, 0x61]);
  assert.equal(decodeLyricBytes(be), 'a');
});
