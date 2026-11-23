import test from 'node:test';
import assert from 'node:assert/strict';
import { readAudioTags } from '../src/shared/audiotags.js';

/* ------------------------------------------------------------------ *
 * 造数据的小工具（一律手写字节，不引第三方库）
 * ------------------------------------------------------------------ */

const asciiBytes = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
const utf8 = (s) => new TextEncoder().encode(s);

function u32le(v) {
  return Uint8Array.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
}
function u32be(v) {
  return Uint8Array.from([(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
}
const cat = (...arrs) => {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

/** 拼一个 RIFF/WAVE 容器：`chunks` 是 [id, bytes] 数组 */
function riff(chunks) {
  const body = cat(...chunks.map(([id, b]) => cat(asciiBytes(id), u32le(b.length), b, b.length & 1 ? new Uint8Array(1) : new Uint8Array(0))));
  return cat(asciiBytes('RIFF'), u32le(4 + body.length), asciiBytes('WAVE'), body);
}

/** bext：602 字节定长 + codingHistory */
function bext({ description = '', originator = '', codingHistory = '' }) {
  const d = new Uint8Array(602);
  const put = (off, len, s) => d.set(utf8(s).subarray(0, len), off);
  put(0, 256, description);
  put(256, 32, originator);
  put(320, 10, '2026-11-13');
  put(330, 8, '04:15:50');
  return cat(d, utf8(codingHistory), new Uint8Array(1));
}

const find = (tags, group, key) => tags.groups.find((g) => g.id === group)?.items.find((i) => i.key === key)?.value;

/* ---------------- WAV / bext ---------------- */

test('bext：中文 originator 按 UTF-8 解出来（不是乱码）', () => {
  const wav = riff([
    ['bext', bext({ description: 'Cubase', originator: '青令韵 马儿', codingHistory: 'A=PCM,F=48000,W=24,M=stereo,T=Cubase\r\n' })],
    ['data', new Uint8Array(16)],
  ]);
  const tags = readAudioTags([wav], 'wav');
  assert.equal(find(tags, 'bext', 'originator'), '青令韵 马儿');
  assert.equal(find(tags, 'bext', 'date'), '2026-11-13');
  assert.equal(find(tags, 'bext', 'time'), '04:15:50');
  // codingHistory 里的 CRLF 要压成一行，否则表格里会被撑开
  assert.equal(find(tags, 'bext', 'codingHistory'), 'A=PCM,F=48000,W=24,M=stereo,T=Cubase');
  // 归一化：wav 的「作者」就是 BWF 的 originator
  assert.equal(tags.standard.artist, '青令韵 马儿');
  assert.equal(tags.standard.comment, 'Cubase');
});

test('bext：非 UTF-8 的字节退回 latin1，不吐替换字符', () => {
  const d = new Uint8Array(602);
  d[256] = 0xe9; // 单独一个 0xe9 不是合法 UTF-8 序列
  d[257] = 0x74;
  const wav = riff([
    ['bext', cat(d, new Uint8Array(1))],
    ['data', new Uint8Array(16)],
  ]);
  const tags = readAudioTags([wav], 'wav');
  assert.equal(find(tags, 'bext', 'originator'), 'ét');
  assert.ok(!find(tags, 'bext', 'originator').includes('\uFFFD'));
});

/* ---------------- iXML ---------------- */

const IXML = `<?xml version="1.0" encoding="UTF-8"?>
<BWFXML>
  <BEXT>
    <BWF_ORIGINATOR>青令韵 马儿</BWF_ORIGINATOR>
    <BWF_ORIGINATION_DATE>2026-11-13</BWF_ORIGINATION_DATE>
  </BEXT>
  <PROJECT>L1</PROJECT>
  <STEINBERG>
    <ATTR_LIST>
      <ATTR><NAME>MediaCompany</NAME><TYPE>string</TYPE><VALUE>彩云追乐 &amp; 朋友</VALUE></ATTR>
      <ATTR><NAME>MusicalTempo</NAME><TYPE>float</TYPE><VALUE>72</VALUE></ATTR>
      <ATTR><NAME>MusicalSignature</NAME><TYPE>rational</TYPE><NUMERATOR>4</NUMERATOR><DENOMINATOR>4</DENOMINATOR></ATTR>
      <ATTR><NAME>TempoSync</NAME><TYPE>int</TYPE><VALUE>0</VALUE></ATTR>
    </ATTR_LIST>
  </STEINBERG>
</BWFXML>`;

test('iXML：同名 ATTR 要按序号区分，NAME/VALUE 才能一一配对', () => {
  const wav = riff([
    ['data', new Uint8Array(16)],
    ['iXML', utf8(IXML)],
  ]);
  // iXML 在文件尾 → 头部拿不到，得把尾部也传进来
  const tags = readAudioTags([wav.subarray(0, 40), wav], 'wav');
  const items = tags.groups.find((g) => g.id === 'iXML')?.items ?? [];
  const attrs = items.filter((i) => i.key.startsWith('ATTR · ')).map((i) => `${i.key}=${i.value}`);
  // 4 个 ATTR：前三个有 VALUE 要合并，第四个（rational）没有 VALUE 保持原样
  assert.deepEqual(attrs, ['ATTR · MediaCompany=彩云追乐 & 朋友', 'ATTR · MusicalTempo=72', 'ATTR · TempoSync=0']);
  // XML 实体要解开
  assert.ok(!attrs[0].includes('&amp;'));
});

test('iXML：bpm 与拍号能被归一化出来（拍号是 rational，没有 VALUE）', () => {
  const wav = riff([
    ['data', new Uint8Array(16)],
    ['iXML', utf8(IXML)],
  ]);
  const tags = readAudioTags([wav], 'wav');
  assert.equal(tags.standard.bpm, '72');
  assert.equal(tags.standard.meter, '4/4');
  assert.equal(tags.standard.album, '彩云追乐 & 朋友');
});

test('iXML 只在尾部时也能读到（头部是音频数据，不能当块头解析）', () => {
  const audio = new Uint8Array(200).fill(0xff); // 故意全是 0xFF，容易被误认成块头
  const wav = riff([
    ['data', audio],
    ['iXML', utf8(IXML)],
  ]);
  const head = wav.subarray(0, 64);
  // 注意 tail 起点要夹住：wav 比 1024 短时 `length - 1024` 是负数，
  // `subarray(负数)` 是从**末尾**算的，只取到最后 96 字节，iXML 的开头就丢了
  const tail = wav.subarray(Math.max(0, wav.length - 1024));
  const tags = readAudioTags([head, tail], 'wav');
  assert.ok(tags.groups.some((g) => g.id === 'iXML'));
});

/* ---------------- MP3 / ID3 ---------------- */

/** ID3v2.3：帧长是普通大端（v2.4 才是 synchsafe） */
function id3v23(frames) {
  const body = cat(...frames.map(([id, payload]) => cat(asciiBytes(id), u32be(payload.length), new Uint8Array([0, 0]), payload)));
  const size = body.length;
  const ss = Uint8Array.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return cat(asciiBytes('ID3'), new Uint8Array([3, 0, 0]), ss, body);
}

const utf16leWithBom = (s) => {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = (c >> 8) & 0xff;
  }
  return out;
};

test('ID3：UTF-16 带 BOM 的中文要按字节序正确读出来', () => {
  const mp3 = cat(
    id3v23([
      ['TIT2', cat(new Uint8Array([1]), utf16leWithBom('第5题'))],
      ['TENC', cat(new Uint8Array([1]), utf16leWithBom('青令韵 马儿'))],
      ['TSSE', cat(new Uint8Array([0]), utf8('Lavf58.29.100'))],
    ]),
    new Uint8Array(64)
  );
  const tags = readAudioTags([mp3], 'mp3');
  assert.equal(find(tags, 'ID3v2.3.0', 'TIT2 · title'), '第5题');
  assert.equal(find(tags, 'ID3v2.3.0', 'TENC · encodedBy'), '青令韵 马儿');
  assert.equal(tags.standard.title, '第5题');
  assert.equal(tags.standard.encodedBy, '青令韵 马儿');
  assert.equal(tags.standard.encoder, 'Lavf58.29.100');
});

test('ID3：TXXX 的自定义键名与值要拆开（格式工厂把 BWF 塞这里）', () => {
  const payload = cat(new Uint8Array([0]), utf8('originator_reference'), new Uint8Array([0]), utf8('CCOOONNNN041550'));
  const mp3 = cat(id3v23([['TXXX', payload]]), new Uint8Array(32));
  const tags = readAudioTags([mp3], 'mp3');
  assert.equal(find(tags, 'ID3v2.3.0', 'TXXX · originator_reference'), 'CCOOONNNN041550');
});

test('没有标签的 mp3：返回空的 groups，不抛错也不瞎猜', () => {
  const raw = cat(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), new Uint8Array(64));
  const tags = readAudioTags([raw], 'mp3');
  assert.deepEqual(tags.groups, []);
  assert.deepEqual(tags.standard, {});
});

/* ---------------- FLAC / Vorbis comment ---------------- */

function flacWithComments(pairs) {
  const list = pairs.map(([k, v]) => {
    const line = utf8(`${k}=${v}`);
    return cat(u32le(line.length), line);
  });
  const comments = cat(u32le(pairs.length), ...list);
  // STREAMINFO 34 字节：offset 18 起是 md5，给个非零值才看得出「读到了」
  const md5 = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const streaminfo = cat(Uint8Array.from([0]), Uint8Array.from([0, 0, 34]), new Uint8Array(18), md5);
  const block = cat(Uint8Array.from([0x84]), Uint8Array.from([(comments.length >> 16) & 0xff, (comments.length >> 8) & 0xff, comments.length & 0xff]), comments);
  return cat(asciiBytes('fLaC'), streaminfo, block);
}

test('FLAC：VORBIS_COMMENT 是 UTF-8 的 KEY=value', () => {
  const flac = flacWithComments([
    ['TITLE', '第5题'],
    ['ARTIST', '青令韵 马儿'],
    ['ALBUM', '彩云追乐'],
    ['DATE', '2026-11-13'],
  ]);
  const tags = readAudioTags([flac], 'flac');
  assert.equal(tags.standard.title, '第5题');
  assert.equal(tags.standard.artist, '青令韵 马儿');
  assert.equal(tags.standard.album, '彩云追乐');
  assert.equal(tags.standard.date, '2026-11-13');
  assert.ok(tags.groups.some((g) => g.id === 'STREAMINFO'));
});

test('认不出的格式 / 空输入：给空结果，绝不抛异常', () => {
  for (const [chunks, fmt] of [
    [null, 'wav'],
    [[], 'mp3'],
    [[new Uint8Array(4)], null],
    [[new TextEncoder().encode('nothing')], 'flac'],
    [[new Uint8Array(64)], 'mp4'], // mp4 这一版故意不解析
  ]) {
    const tags = readAudioTags(chunks, fmt);
    assert.deepEqual(tags.groups, [], String(fmt));
    assert.deepEqual(tags.standard, {}, String(fmt));
  }
});
