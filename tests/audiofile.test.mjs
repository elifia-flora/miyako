import test from 'node:test';
import assert from 'node:assert/strict';
import { AAC_LEAD_SAMPLES, MP3_LEAD_SAMPLES, codecLeadSamples, formatSampleRate, probeAudioInfo, probeMp4SampleRate, probeOggDuration } from '../src/shared/audiofile.js';

function wavHeader({ rate = 44100, channels = 2, bits = 16, frames = 441000 } = {}) {
  const blockAlign = channels * (bits / 8);
  const dataBytes = frames * blockAlign;
  const b = new Uint8Array(44);
  const put = (off, text) => [...text].forEach((ch, i) => (b[off + i] = ch.charCodeAt(0)));
  const u32 = (off, v) => {
    b[off] = v & 0xff;
    b[off + 1] = (v >> 8) & 0xff;
    b[off + 2] = (v >> 16) & 0xff;
    b[off + 3] = (v >> 24) & 0xff;
  };
  const u16 = (off, v) => {
    b[off] = v & 0xff;
    b[off + 1] = (v >> 8) & 0xff;
  };
  put(0, 'RIFF');
  u32(4, 36 + dataBytes);
  put(8, 'WAVE');
  put(12, 'fmt ');
  u32(16, 16);
  u16(20, 1);
  u16(22, channels);
  u32(24, rate);
  u32(28, rate * blockAlign);
  u16(32, blockAlign);
  u16(34, bits);
  put(36, 'data');
  u32(40, dataBytes);
  return b;
}

function flacHeader({ rate = 44100, channels = 2, bits = 16, samples = 8202600 } = {}) {
  const b = new Uint8Array(34);
  const put = (off, text) => [...text].forEach((ch, i) => (b[off + i] = ch.charCodeAt(0)));
  put(0, 'fLaC');
  b[4] = 0x00; // STREAMINFO，last-block
  b[7] = 34;
  // 8..17：min/max block size、min/max frame size、MD5 前一半，全 0 不影响读数
  const b18 = (rate >> 12) & 0xff;
  const b19 = (rate >> 4) & 0xff;
  const b20 = ((rate & 0x0f) << 4) | ((channels - 1) << 1) | (((bits - 1) >> 4) & 0x01);
  const b21 = (((bits - 1) & 0x0f) << 4) | ((samples / 4294967296) & 0x0f);
  b[18] = b18;
  b[19] = b19;
  b[20] = b20;
  b[21] = b21;
  b[22] = (samples >>> 24) & 0xff;
  b[23] = (samples >>> 16) & 0xff;
  b[24] = (samples >>> 8) & 0xff;
  b[25] = samples & 0xff;
  return b;
}

test('WAV 头：44.1kHz 立体声 16bit，10 秒', () => {
  const info = probeAudioInfo(wavHeader());
  assert.deepEqual(
    { format: info.format, sampleRate: info.sampleRate, channels: info.channels, bits: info.bits },
    { format: 'wav', sampleRate: 44100, channels: 2, bits: 16 }
  );
  assert.equal(info.totalSamples, 441000);
  assert.equal(info.durationMs, 10000);
});

test('FLAC 头：STREAMINFO 读到 3:06 全长（与神鹿谣一致）', () => {
  const info = probeAudioInfo(flacHeader());
  assert.equal(info.format, 'flac');
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  assert.equal(info.bits, 16);
  assert.equal(info.totalSamples, 8202600);
  assert.equal(info.durationMs, 186000);
});

test('未知格式 / 太短的字节返回 null', () => {
  assert.equal(probeAudioInfo(new Uint8Array(4)), null);
  assert.equal(probeAudioInfo(null), null);
  const junk = new Uint8Array(64); // 全 0
  assert.equal(probeAudioInfo(junk), null);
  assert.equal(probeAudioInfo(new TextEncoder().encode('ID3\u0004not-really-mp3')).format, 'mp3');
});

test('formatSampleRate', () => {
  assert.equal(formatSampleRate(44100), '44.1 kHz');
  assert.equal(formatSampleRate(48000), '48 kHz');
  assert.equal(formatSampleRate(0), '—');
});

/* ---------------- 编码器延迟（对轨要对得齐，全靠这一项） ---------------- */

/** 造一个 MPEG-1 Layer III 立体声帧头 + 侧信息，再按需塞 Xing/Info */
function mp3Frame({ tag = null, id3 = 0 } = {}) {
  const side = 32;                       // MPEG-1 立体声的侧信息长度
  const b = new Uint8Array(id3 + 4 + side + 16);
  if (id3) {
    b[0] = 0x49; b[1] = 0x44; b[2] = 0x33;   // "ID3"
    b[3] = 4; b[4] = 0; b[5] = 0;
    // synchsafe：只放 10 字节头，标签体长度 0
    b[6] = 0; b[7] = 0; b[8] = 0; b[9] = 0;
  }
  const p = id3;
  b[p] = 0xff;
  b[p + 1] = 0xfb;                       // MPEG-1 / Layer III / 无 CRC
  b[p + 2] = 0x90;
  b[p + 3] = 0x00;                       // 立体声（侧信息 32 字节）
  if (tag) {
    const at = p + 4 + side;
    [...tag].forEach((ch, i) => (b[at + i] = ch.charCodeAt(0)));
  }
  return b;
}

test('MP3：有 Xing / Info 就算「自带 gapless」，解码器会自己裁，不用补', () => {
  assert.equal(codecLeadSamples([mp3Frame({ tag: 'Xing' })], 'mp3'), 0);
  assert.equal(codecLeadSamples([mp3Frame({ tag: 'Info' })], 'mp3'), 0);
  // 前面挂 ID3v2 标签也一样认得出
  assert.equal(codecLeadSamples([mp3Frame({ tag: 'Xing', id3: 10 })], 'mp3'), 0);
});

test('MP3：没有 Xing / Info → 补 1105 采样（LAME 576 + 解码器 529）', () => {
  // 这条对应实测：`ffmpeg -write_xing 0` 转出来的 mp3，解码后比 wav 多 1872 采样、
  // 音乐本体晚 1105 采样（44.1k 下 25.1 ms）。不补的话同一偏移量必然对不齐。
  assert.equal(codecLeadSamples([mp3Frame()], 'mp3'), MP3_LEAD_SAMPLES);
  assert.equal(MP3_LEAD_SAMPLES, 1105);
  // 认不出帧头（被截断 / 不是 mp3）就老实返回 0，别乱补
  assert.equal(codecLeadSamples([new Uint8Array(8)], 'mp3'), 0);
});

test('AAC / MP4：有 edit list（elst）或 iTunSMPB 就不补，否则补 1024', () => {
  const withElst = new TextEncoder().encode('....moov....elst....mdat');
  const withSmpb = new TextEncoder().encode('....iTunSMPB....');
  const bare = new TextEncoder().encode('....moov....mdat........');
  assert.equal(codecLeadSamples([bare], 'mp4'), AAC_LEAD_SAMPLES);
  assert.equal(AAC_LEAD_SAMPLES, 1024);
  assert.equal(codecLeadSamples([withElst], 'mp4'), 0);
  assert.equal(codecLeadSamples([withSmpb], 'mp4'), 0);
  // moov 在文件尾部：头和尾一起给，照样认得出
  assert.equal(codecLeadSamples([bare, withElst], 'mp4'), 0);
});

test('无损与 ogg：一律不用补', () => {
  for (const fmt of ['wav', 'aiff', 'flac', '', null]) {
    assert.equal(codecLeadSamples([new Uint8Array(64)], fmt), 0, String(fmt));
  }
  // ogg 的 Vorbis / Opus 用 granulepos / pre-skip 自己裁，不归我们管
  assert.equal(codecLeadSamples([new TextEncoder().encode('OggS....')], 'ogg'), 0);
});

test('MP4：从 mp4a 样本条目里读出采样率（换算预热要用它）', () => {
  const mk = (rate) => {
    const b = new Uint8Array(64);
    const tag = 'mp4a';
    [...tag].forEach((ch, i) => (b[8 + i] = ch.charCodeAt(0)));   // 'mp4a' 从偏移 8 开始
    const at = 8 + 28;                                            // 采样率在 +28
    b[at] = (rate >> 8) & 0xff;
    b[at + 1] = rate & 0xff;
    b[at + 2] = 0;
    b[at + 3] = 0;
    return b;
  };
  assert.equal(probeMp4SampleRate([mk(44100)]), 44100);
  assert.equal(probeMp4SampleRate([mk(48000)]), 48000);
  // 认不出来就给 0 —— 调用方据此「不补」，别拿错的比例把整轨推偏
  assert.equal(probeMp4SampleRate([new TextEncoder().encode('no-such-box-here')]), 0);
});

/* ------------------------------------------------------------------ *
 * Ogg：时长藏在最后一页的 granulepos 里
 * ------------------------------------------------------------------ */

/** 造一个 Ogg 页：27 字节头 + 1 个段长度字节 + payload */
function oggPage({ payload, granule = 0n, flags = 0, serial = 1, seq = 0 }) {
  const b = new Uint8Array(27 + 1 + payload.length);
  const put = (off, text) => [...text].forEach((ch, i) => (b[off + i] = ch.charCodeAt(0)));
  put(0, 'OggS');
  b[4] = 0;
  b[5] = flags;
  let g = BigInt(granule);
  for (let i = 0; i < 8; i++) b[6 + i] = Number((g >> BigInt(8 * i)) & 0xffn);
  const u32 = (off, v) => {
    b[off] = v & 0xff;
    b[off + 1] = (v >> 8) & 0xff;
    b[off + 2] = (v >> 16) & 0xff;
    b[off + 3] = (v >> 24) & 0xff;
  };
  u32(14, serial);
  u32(18, seq);
  u32(22, 0); // crc 不校验
  b[26] = 1; // 1 个段
  b[27] = payload.length;
  b.set(payload, 28);
  return b;
}

/** vorbis identification packet：\x01vorbis + 版本 + 声道 + 采样率 */
function vorbisHead({ rate = 44100, channels = 2 } = {}) {
  const p = new Uint8Array(30);
  p[0] = 0x01;
  [...'vorbis'].forEach((ch, i) => (p[1 + i] = ch.charCodeAt(0)));
  p[11] = channels;
  const u32 = (off, v) => {
    p[off] = v & 0xff;
    p[off + 1] = (v >> 8) & 0xff;
    p[off + 2] = (v >> 16) & 0xff;
    p[off + 3] = (v >> 24) & 0xff;
  };
  u32(12, rate);
  return p;
}

function opusHead({ channels = 2, preSkip = 312 } = {}) {
  const p = new Uint8Array(19);
  [...'OpusHead'].forEach((ch, i) => (p[i] = ch.charCodeAt(0)));
  p[8] = 1;
  p[9] = channels;
  p[10] = preSkip & 0xff;
  p[11] = (preSkip >> 8) & 0xff;
  return p;
}

const concat = (...arrs) => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

test('Ogg vorbis：从第一个页里读出采样率与声道', () => {
  const head = concat(oggPage({ payload: vorbisHead({ rate: 44100, channels: 2 }), flags: 0x02 }));
  const info = probeAudioInfo(head);
  assert.equal(info.format, 'ogg');
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  // 头里没有总采样数 → 时长先给 0，等 probeFile 去尾页补
  assert.equal(info.durationMs, 0);
});

test('Ogg opus：granulepos 按 48kHz 计，采样率就该报 48000', () => {
  const head = concat(oggPage({ payload: opusHead(), flags: 0x02 }));
  const info = probeAudioInfo(head);
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.channels, 2);
});

test('Ogg 总采样数：从最后一个页的 granulepos 取', () => {
  const tail = concat(
    oggPage({ payload: new Uint8Array(8), granule: 1000000n, seq: 8 }),
    oggPage({ payload: new Uint8Array(8), granule: 1176000n, seq: 9, flags: 0x04 }) // EOS
  );
  assert.equal(probeOggDuration(tail), 1176000);
});

test('Ogg 尾页 granulepos 是 -1 时要继续往前翻，别当成 0', () => {
  const tail = concat(
    oggPage({ payload: new Uint8Array(8), granule: 882000n, seq: 3 }),
    oggPage({ payload: new Uint8Array(8), granule: -1n, seq: 4, flags: 0x04 }) // 没有结束 packet
  );
  assert.equal(probeOggDuration(tail), 882000);
});

test('Ogg opus 时长要减掉 pre-skip', () => {
  const tail = concat(
    oggPage({ payload: opusHead({ preSkip: 312 }), flags: 0x02 }),
    oggPage({ payload: new Uint8Array(8), granule: 1000000n, seq: 9, flags: 0x04 })
  );
  assert.equal(probeOggDuration(tail), 1000000 - 312);
});

test('Ogg 认不出来时返回 0，别瞎猜', () => {
  assert.equal(probeOggDuration(null), 0);
  assert.equal(probeOggDuration(new Uint8Array(10)), 0);
  assert.equal(probeOggDuration(new TextEncoder().encode('nothing-here-at-all-just-text')), 0);
});

test('WAV：从头里的块清单认出 Broadcast Wave（bext）', () => {
  const plain = wavHeader();
  assert.equal(probeAudioInfo(plain).chunks.includes('bext'), false);
  assert.ok(probeAudioInfo(plain).chunks.includes('data'));

  // 在 fmt 之前插一个 602 字节的 bext（Cubase / Pro Tools 的典型布局，偶数长度不用补 padding）
  const bext = new Uint8Array(8 + 602);
  [...'bext'].forEach((ch, i) => (bext[i] = ch.charCodeAt(0)));
  bext[4] = 602 & 0xff;
  bext[5] = (602 >> 8) & 0xff;
  const withBext = new Uint8Array(plain.length + bext.length);
  withBext.set(plain.subarray(0, 12), 0);
  withBext.set(bext, 12);
  withBext.set(plain.subarray(12), 12 + bext.length);

  const info = probeAudioInfo(withBext);
  assert.equal(info.format, 'wav');
  assert.ok(info.chunks.includes('bext'));
  // 插了块也要照常读出 fmt 里的参数（别把块遍历写死成「fmt 一定在 +20」）
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.channels, 2);
  assert.equal(info.bits, 16);
  assert.equal(info.totalSamples, 441000);
});
