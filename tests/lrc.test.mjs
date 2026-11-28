import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeLineIndex,
  formatLrcStamp,
  parseLrc,
  parseLrcStamp,
  serializeLrc,
} from '../src/shared/lrc.js';

test('标准行：分:秒.毫秒，按时间排序', () => {
  const { lines } = parseLrc(
    ['[00:12.500]第二句', '[00:10.838]第一句', '[01:02.050]第三句'].join('\n')
  );
  assert.deepEqual(
    lines.map((l) => [l.ms, l.text]),
    [
      [10838, '第一句'],
      [12500, '第二句'],
      [62050, '第三句'],
    ]
  );
});

test('毫秒位数 1~3 位都按十进制补齐：.8 → 800ms，.83 → 830ms', () => {
  const { lines } = parseLrc('[00:01.8]a\n[00:02.83]b\n[00:03.838]c');
  assert.deepEqual(lines.map((l) => l.ms), [1800, 2830, 3838]);
});

test('没有毫秒的 [mm:ss] 也算', () => {
  const { lines } = parseLrc('[02:05]整句');
  assert.equal(lines[0].ms, 125000);
});

test('一行多个时间戳会展开成多句', () => {
  const { lines } = parseLrc('[00:10.00][00:20.00]副歌');
  assert.deepEqual(lines.map((l) => l.ms), [10000, 20000]);
  assert.ok(lines.every((l) => l.text === '副歌'));
});

test('元数据与 offset：偏移直接加到句子时间上（负值 = 提前）', () => {
  const lrc = ['[ti:灰ト祈リ]', '[ar:GEMS COMPANY]', '[al:灰与祈愿]', '[by:test]', '[offset:-200]', '[00:10.000]x'].join('\n');
  const { lines, meta } = parseLrc(lrc);
  assert.equal(meta.ti, '灰ト祈リ');
  assert.equal(meta.ar, 'GEMS COMPANY');
  assert.equal(meta.al, '灰与祈愿');
  assert.equal(meta.by, 'test');
  assert.equal(meta.offset, -200);
  assert.equal(lines[0].ms, 9800);
});

test('offset 为正值时句子往后推；负到 0 以下夹到 0，不会出现负数', () => {
  assert.equal(parseLrc('[offset:500]\n[00:01.000]开头').lines[0].ms, 1500);
  assert.equal(parseLrc('[offset:-500]\n[00:00.100]开头').lines[0].ms, 0);
});

test('空文本行被丢掉（LRC 常拿空行当段落间隔）', () => {
  const { lines } = parseLrc('[00:01.00]\n[00:02.00]有词\n[00:03.00]   ');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '有词');
});

test('GEMS 那种 JSON 逐字行进 credits，不进歌词', () => {
  const lrc = [
    '{"t":0,"c":[{"tx":"作词: "},{"tx":"ヨコオタロウ"}]}',
    '{"t":1000,"c":[{"tx":"作曲: "},{"tx":"岡部啓一・MONACA"}]}',
    '[00:10.838]嗚呼 あの暗闇が',
  ].join('\n');
  const { lines, meta } = parseLrc(lrc);
  assert.deepEqual(meta.credits, ['作词: ヨコオタロウ', '作曲: 岡部啓一・MONACA']);
  assert.deepEqual(lines.map((l) => l.text), ['嗚呼 あの暗闇が']);
});

test('BOM 与 CRLF 不影响解析', () => {
  const { lines } = parseLrc('\uFEFF[00:01.00]a\r\n[00:02.00]b\r\n');
  assert.deepEqual(lines.map((l) => l.text), ['a', 'b']);
});

test('activeLineIndex：返回最后一个已到达的句子', () => {
  const lines = [{ ms: 0 }, { ms: 1000 }, { ms: 2000 }].map((x, i) => ({ ...x, text: String(i) }));
  assert.equal(activeLineIndex(lines, 0), 0);
  assert.equal(activeLineIndex(lines, 999), 0);
  assert.equal(activeLineIndex(lines, 1000), 1);
  assert.equal(activeLineIndex(lines, 2500), 2);
});

test('增强 LRC：行级文本去掉逐字标记，逐字时间单独留下', () => {
  const { lines } = parseLrc('[00:12.34]<00:12.34>你<00:13.00>好');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ms, 12340);
  assert.equal(lines[0].text, '你好');
  assert.deepEqual(lines[0].words, [
    { ms: 12340, text: '你' },
    { ms: 13000, text: '好' },
  ]);
});

test('增强 LRC 的 offset 同时推进行级和逐字时间', () => {
  const { lines } = parseLrc('[offset:500]\n[00:01.000]<00:01.000>A <00:01.200>B');
  assert.equal(lines[0].ms, 1500);
  assert.equal(lines[0].text, 'A B');
  assert.deepEqual(lines[0].words.map((w) => w.ms), [1500, 1700]);
});

test('activeLineIndex：有结束时间时，空白段不高亮', () => {
  const lines = [
    { ms: 0, endMs: 1000, text: 'a' },
    { ms: 2000, endMs: 3000, text: 'b' },
  ];
  assert.equal(activeLineIndex(lines, 500), 0);
  assert.equal(activeLineIndex(lines, 1000), -1);
  assert.equal(activeLineIndex(lines, 1500), -1);
  assert.equal(activeLineIndex(lines, 2500), 1);
});

test('activeLineIndex：还没到第一句时是 -1，空数组也是 -1', () => {
  assert.equal(activeLineIndex([{ ms: 5000, text: 'x' }], 0), -1);
  assert.equal(activeLineIndex([], 0), -1);
  assert.equal(activeLineIndex(null, 0), -1);
});

test('同一毫秒的多句保持文件顺序', () => {
  const { lines } = parseLrc('[00:01.00]一\n[00:01.00]二');
  assert.deepEqual(lines.map((l) => l.text), ['一', '二']);
});

/* ---------------- 时间戳格式化与写回（v0.17） ---------------- */

test('毫秒 → LRC 时间戳：毫秒补齐三位，跟原文件对得上', () => {
  assert.equal(formatLrcStamp(14671), '[00:14.671]');
  assert.equal(formatLrcStamp(0), '[00:00.000]');
  assert.equal(formatLrcStamp(838), '[00:00.838]');
  assert.equal(formatLrcStamp(61_000), '[01:01.000]');
  assert.equal(formatLrcStamp(605_500), '[10:05.500]');
  // 负数夹到 0，不出 [00:00.-50] 这种
  assert.equal(formatLrcStamp(-5), '[00:00.000]');
});

test('解析时间戳：带方括号 / 逗号 / 缺分都认，认不出返回 null', () => {
  assert.equal(parseLrcStamp('[00:14.671]'), 14671);
  assert.equal(parseLrcStamp('00:14.671'), 14671);
  assert.equal(parseLrcStamp('0:14.671'), 14671);
  assert.equal(parseLrcStamp('00:14,671'), 14671, '逗号也算小数点');
  assert.equal(parseLrcStamp('14.671'), 14671, '没有冒号按 0 分算');
  assert.equal(parseLrcStamp('00:14.67'), 14670, '两位小数补成 670ms');
  assert.equal(parseLrcStamp('abc'), null);
  assert.equal(parseLrcStamp(''), null);
});

test('往返：格式化再解析，毫秒不变', () => {
  for (const ms of [0, 838, 14671, 605_500, 3_600_000]) {
    assert.equal(parseLrcStamp(formatLrcStamp(ms)), ms);
  }
});

test('写回 LRC：按时间排序 + 保留元数据，输出仍是合法 LRC', () => {
  const src = parseLrc(`[ti:歌名]\n[ar:歌手]\n[00:14.671]第二句\n[00:00.000]第一句\n`);
  const text = serializeLrc(src.lines, src.meta);
  // 排序：第一句在前
  assert.ok(text.indexOf('[00:00.000]第一句') < text.indexOf('[00:14.671]第二句'));
  // 元数据保留
  assert.ok(text.includes('[ti:歌名]'));
  assert.ok(text.includes('[ar:歌手]'));
  // 回读能拿回同样的两句
  const back = parseLrc(text);
  assert.equal(back.lines.length, 2);
  assert.equal(back.lines[0].text, '第一句');
  assert.equal(back.lines[1].ms, 14671);
});

test('写回 LRC：改了时间戳再解析，位置真的变了（这是歌词编辑的底层）', () => {
  const src = parseLrc('[00:14.671]A\n[00:20.000]B\n');
  const lines = src.lines.map((l) => ({ ...l }));
  lines[0].ms = parseLrcStamp('[00:15.500]');
  const back = parseLrc(serializeLrc(lines, src.meta));
  assert.equal(back.lines[0].ms, 15500);
  assert.equal(back.lines[1].ms, 20000);
});
