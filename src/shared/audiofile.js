/**
 * audiofile.js — 从文件头读音频元信息（采样率 / 声道 / 位深 / 总帧数）
 *
 * 为什么不用 decodeAudioData 的返回值：它会**把音频重采样到 AudioContext 的采样率**，
 * 于是「采样数」永远按 48k 算，跟文件本身对不上。无损容器的头部里写得很准，直接读。
 *
 * 纯函数、只吃 Uint8Array，主进程（fs 读前 64KB）和 node --test 共用。
 */

const ascii = (b, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i] || 0);
  return s;
};

const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);

/** 80 位 IEEE 扩展精度（AIFF 的采样率就是这种写法） */
function extended80(b, o) {
  const exp = u16be(b, o);
  const hi = u32be(b, o + 2);
  const lo = u32be(b, o + 6);
  if (!exp && !hi && !lo) return 0;
  return (hi * 4294967296 + lo) * Math.pow(2, (exp & 0x7fff) - 16383 - 63);
}

function probeWav(b) {
  let p = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let blockAlign = 0;
  let frames = 0;
  /**
   * 顺便记下块清单：`bext` 在不在，决定这是不是一个 Broadcast Wave。
   * 只收**头部 64KB 以内**能看到的块 —— iXML 通常被放在 data 之后（文件尾），
   * 这里注定看不到，别拿「chunks 里没有 iXML」当成「文件没有 iXML」。
   */
  const chunks = [];
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    chunks.push(id.trim());
    if (id === 'fmt ') {
      channels = u16le(b, p + 10);
      sampleRate = u32le(b, p + 12);
      bits = u16le(b, p + 22);
      blockAlign = u16le(b, p + 20) || channels * Math.max(1, Math.floor(bits / 8));
    } else if (id === 'data') {
      frames = blockAlign ? Math.floor(size / blockAlign) : 0;
    }
    if (size <= 0) break;
    p += 8 + size + (size & 1);
  }
  return { format: 'wav', sampleRate, channels, bits, totalSamples: frames, chunks };
}

function probeAiff(b) {
  let p = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let frames = 0;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = u32be(b, p + 4);
    if (id === 'COMM') {
      channels = u16be(b, p + 8);
      frames = u32be(b, p + 10);
      bits = u16be(b, p + 14);
      sampleRate = Math.round(extended80(b, p + 16));
    }
    if (size <= 0) break;
    p += 8 + size + (size & 1);
  }
  return { format: 'aiff', sampleRate, channels, bits, totalSamples: frames };
}

function probeFlac(b) {
  if (b.length < 26) return { format: 'flac', sampleRate: 0, channels: 0, bits: 0, totalSamples: 0 };
  const sampleRate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  const channels = ((b[20] >> 1) & 0x07) + 1;
  const bits = (((b[20] & 1) << 4) | (b[21] >> 4)) + 1;
  const totalSamples = ((b[21] & 0x0f) * 4294967296) + (b[22] << 24) + (b[23] << 16) + (b[24] << 8) + b[25];
  return { format: 'flac', sampleRate, channels, bits, totalSamples };
}

/**
 * MP3：帧头里的比特率 + 采样率都是「现成的一小段」，
 * 但时长要拿总字节数去除 —— 文件头只有 64KB，得靠调用方把 fileSize 传进来。
 *
 * 只支持 CBR 近似（(字节数 - ID3) * 8 / 比特率）。VBR 会偏，
 * 但 mp3 时长本来就是「大概多长」，列表里显示 3:12 和 3:14 没人在意；
 * 返回 0 才是真的没法用（界面上显示「—」）。
 */
const MP3_BITRATES = {
  // [versionGroup][layer] -> 码率表（kbps），index 从 1 开始
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  // MPEG2 / 2.5 的 Layer II 与 Layer III 共用同一张表（8–160 kbps）。
  // 少这一行就会命中不到表 → 比特率 0 → 时长 0，界面上显示「—」。
  v2l3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function probeMp3(b, fileSize) {
  const out = { format: 'mp3', sampleRate: 0, channels: 0, bits: 0, totalSamples: 0 };
  // 跳过 ID3v2 头（大小是 4 个 7 位字节的 synchsafe 整数）
  let p = 0;
  let tagSize = 0;
  if (ascii(b, 0, 3) === 'ID3' && b.length > 10) {
    tagSize = 10 + ((b[6] & 0x7f) << 21) + ((b[7] & 0x7f) << 14) + ((b[8] & 0x7f) << 7) + (b[9] & 0x7f);
    p = tagSize;
  }
  // 找同步字：11 个 1
  while (p + 4 < b.length && !(b[p] === 0xff && (b[p + 1] & 0xe0) === 0xe0)) p++;
  if (p + 4 >= b.length) return { ...out, durationMs: 0 };

  const h1 = b[p + 1];
  const h2 = b[p + 2];
  const h3 = b[p + 3];
  const verBits = (h1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (h1 >> 1) & 0x03; // 3=Layer I, 2=Layer II, 1=Layer III
  const brIdx = (h2 >> 4) & 0x0f;
  const srIdx = (h2 >> 2) & 0x03;
  const padding = (h2 >> 1) & 0x01;
  const chMode = (h3 >> 6) & 0x03;

  const rates = MP3_RATES[verBits];
  const sampleRate = rates ? rates[srIdx] : 0;
  const group = verBits === 3 ? 'v1' : 'v2';
  const layer = layerBits === 3 ? 'l1' : layerBits === 2 ? 'l2' : 'l3';
  const table = MP3_BITRATES[`${group}${layer}`] ?? MP3_BITRATES[`${group}l3`];
  const kbps = table && brIdx > 0 && brIdx < 15 ? table[brIdx] : 0;

  let durationMs = 0;
  if (sampleRate && kbps && fileSize > 0) {
    const bytes = Math.max(0, fileSize - tagSize);
    durationMs = Math.round((bytes * 8 * 1000) / (kbps * 1000));
  }
  // 帧长推 totalSamples 是为了让调用方口径统一（其他格式都用它算时长）
  const totalSamples = sampleRate && durationMs ? Math.round((durationMs / 1000) * sampleRate) : 0;
  return {
    format: 'mp3',
    sampleRate,
    channels: chMode === 3 ? 1 : 2,
    bits: 0,
    totalSamples,
    durationMs: totalSamples ? durationMs : 0,
    // 帧头里已知：填充位参与帧长计算，这里只留个痕迹便于排查
    framePadding: padding,
  };
}

/* ------------------------------------------------------------------ *
 * 编码器延迟（这一节是「同一个偏移量对不齐不同格式」的根因）
 * ------------------------------------------------------------------ */

/**
 * 有损编码器会在文件**开头**塞一段预热（编码器 + 解码器的固有延迟），
 * 解码之后这段会变成实打实多出来的采样 —— 于是同一个偏移量在 mp3 上刚好、
 * 换 flac 就早了 25 ms。
 *
 * 好消息是：只要容器里带了「无缝播放（gapless）」信息，Chromium 的解码器会
 * **自己裁掉**这段，各种格式就都对齐了。实测（`.tools` 探针，同一段 12s 音频）：
 *
 * | 文件 | 前导多出来的采样 | 解码后与 wav 的位移 |
 * |---|---|---|
 * | wav / flac | 0 | 0 |
 * | mp3（Info/Xing 齐全） | 0 | 0 |
 * | ogg vorbis | 0 | 0 |
 * | m4a（有 edts） | 0 | 0 |
 * | **mp3（`-write_xing 0`）** | **1872** | **1105 采样 = 25.1 ms** |
 * | **m4a（`-use_editlist 0`）** | **1024** | **1024 采样 = 23.2 ms** |
 *
 * 真实世界的第二个样本（网易云下载的 mp3，1.6MB / 48kHz / `Info` 头 + `Lavc58` 标签）：
 * 与同名 flac 做互相关，最佳 lag **0 采样**、相关系数 0.9955（lag 576 时掉到 0.13）。
 * 它的 delay/pad 是 576/784（**不是**这里写死的 1105），说明「不裁会偏多少」取决于
 * 编码器自己的字段 —— 所以判据只能是「有没有 gapless 信息」，不能拿 1105 去反推。
 * 探针留在 `.tools/lead-probe.mjs`（gitignore 内），换路径就能复测。
 *
 * 所以这里只需要判断「有没有 gapless 信息」；没有就按标准延迟补回来。
 * 延迟是**按文件采样率计的采样数**，换算成毫秒还得除以 `info.sampleRate`
 * （48k 的 mp3 实测 1105 采样 → 23.0 ms，22.05k 的 → 50.1 ms，都吻合）。
 */

/** MP3：LAME 的编码预热 576 + 解码器固有延迟 529（MPEG-1/2/2.5 Layer III 通用） */
export const MP3_LEAD_SAMPLES = 1105;
/**
 * 但**不是所有编码器都写这个值**。Cubase 直出的 mp3（Fraunhofer，连 Xing/Info 头都不写）
 * 实测跨采样率一致地偏 **1201 采样**（48k 的 25.02 ms / 44.1k 的 27.2 ms 换算回各自采样率
 * 都是 1201），比这里补的 1105 多 96 采样 ≈ 2 ms。
 *
 * 没有头就没法分辨是 LAME 还是 Fraunhofer，所以只能取最常见值 —— 2ms 的残差
 * 远小于「完全不补」的 25ms，真在意可以拿曲线框上的偏移量自己再推 2ms。
 */
/** AAC：一帧的预热（1024 采样） */
export const AAC_LEAD_SAMPLES = 1024;

/** 在字节里找一个 ASCII 标记（文件通常几百 KB，直接按字符串找足够快） */
function hasAscii(bytes, needle) {
  const n = needle.length;
  const last = bytes.length - n;
  for (let i = 0; i <= last; i++) {
    let hit = true;
    for (let k = 0; k < n; k++) {
      if (bytes[i + k] !== needle.charCodeAt(k)) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * MP3 第一帧里有没有 Xing / Info 头（FFmpeg 就是靠它拿 gapless 信息的）。
 *
 * 位置是**精确**的：帧头 4 字节 + 侧信息（MPEG-1 立体声 32 / 单声道 17，
 * MPEG-2 立体声 17 / 单声道 9）之后紧跟 'Xing' 或 'Info'。
 * 返回值是三态：true / false / **null（读不出来）**。
 * 不整帧乱搜 —— 音频数据里偶尔也会凑出这四个字母，误判会让本该补的延迟不补。
 */
function mp3HasGapless(b) {
  let p = 0;
  if (b.length > 10 && ascii(b, 0, 3) === 'ID3') {
    p = 10 + ((b[6] & 0x7f) << 21) + ((b[7] & 0x7f) << 14) + ((b[8] & 0x7f) << 7) + (b[9] & 0x7f);
  }
  while (p + 4 < b.length && !(b[p] === 0xff && (b[p + 1] & 0xe0) === 0xe0)) p++;
  // 连帧头都凑不齐（文件被截断 / 根本不是 mp3）→ 返回 null，调用方就**不补**
  if (p + 40 >= b.length) return null;
  const verBits = (b[p + 1] >> 3) & 0x03;      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const chMode = (b[p + 3] >> 6) & 0x03;        // 3=单声道
  const mono = chMode === 3;
  const sideInfo = verBits === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const at = p + 4 + sideInfo;
  if (at + 4 > b.length) return null;
  const tag = ascii(b, at, 4);
  return tag === 'Xing' || tag === 'Info';
}

/**
 * 从 MP4/M4A 的音频样本描述里取采样率。
 *
 * `probeAudioInfo` 对 mp4 只返回格式（atom 结构太深，只读前 64KB 也不一定读到 moov），
 * 但**换算预热必须知道采样率**（1024 采样在 44.1k 是 23.2ms、在 48k 是 21.3ms），
 * 所以这里补一条：找到 `mp4a` 样本条目，按 QuickTime 音频条目布局读 16.16 定点的采样率。
 *
 * @param {Uint8Array[]} chunks 文件开头（必要时加结尾 —— moov 可能被放在文件尾部）
 * @returns {number} 采样率；认不出来返回 0（调用方据此决定「不补」）
 */
export function probeMp4SampleRate(chunks) {
  const list = (Array.isArray(chunks) ? chunks : [chunks]).filter((c) => c && c.length);
  for (const b of list) {
    const n = b.length;
    for (let i = 4; i + 44 < n; i++) {
      // 'mp4a'
      if (b[i] !== 0x6d || b[i + 1] !== 0x70 || b[i + 2] !== 0x34 || b[i + 3] !== 0x61) continue;
      /**
       * QuickTime 音频样本条目的固定布局（'mp4a' 之后）：
       * 6 保留 + 2 dataRefIndex + 8 版本/厂商 + 2 声道 + 2 位深 + 2 预定义 + 2 保留 = 24，
       * 紧接着才是 16.16 定点的采样率 —— 也就是 **+28**。
       * （探针实测：44.1k 的文件在这里读到 `ac 44 00 00`。）
       */
      const at = i + 28;
      if (at + 4 > n) continue;
      const rate = ((b[at] << 8) | b[at + 1]) + ((b[at + 2] << 8) | b[at + 3]) / 65536;
      if (rate >= 8000 && rate <= 384000) return Math.round(rate);
    }
  }
  return 0;
}

/**
 * 这个文件解码后**开头会多出多少采样**（按文件采样率计）。
 *
 * 0 = 容器自带 gapless 信息（或本来就是无损/无预热格式），解码器已经裁干净了。
 * 目前只有两种「没人管」的情况需要补：MP3 没有 Xing/Info、AAC/MP4 没有 edit list。
 *
 * @param {Uint8Array[]} chunks 文件开头（必要时再加结尾 —— MP4 的 moov 有时在尾部）
 * @param {string|null} format `probeAudioInfo` 判出来的格式
 */
export function codecLeadSamples(chunks, format) {
  const list = (Array.isArray(chunks) ? chunks : [chunks]).filter((c) => c && c.length);
  if (!list.length) return 0;
  const fmt = String(format ?? '');
  if (fmt === 'mp3') {
    // null = 读不出来，宁可不补（补错了会把整轨推偏，比不补更糟）
    const has = mp3HasGapless(list[0]);
    if (has === null) return 0;
    return has ? 0 : MP3_LEAD_SAMPLES;
  }
  if (fmt === 'mp4') {
    for (const b of list) {
      if (hasAscii(b, 'elst') || hasAscii(b, 'iTunSMPB')) return 0;
    }
    return AAC_LEAD_SAMPLES;
  }
  // wav / aiff / flac：无损，没有预热；ogg（vorbis / opus）用 granulepos 自行裁剪
  return 0;
}

/**
 * Ogg 的头：从第一个页的 payload 里认出 vorbis / opus，取采样率与声道。
 *
 * 为什么不能像 FLAC 那样直接给时长：Ogg 是**分页**的，总采样数写在**最后一页**
 * 的 `granulepos` 里，只读前 64KB 拿不到（长曲子上百页）。所以这里只解决
 * 「采样率/声道」，时长交给 `probeOggDuration` 去读文件尾。
 *
 * 页头 27 字节固定：OggS + version + flags + granule(8) + serial(4) + seq(4)
 * + crc(4) + nsegs(1)，紧接着是 nsegs 个段的长度表，段长度之和 = payload 长度。
 */
function probeOggHead(b) {
  const out = { format: 'ogg', sampleRate: 0, channels: 0, bits: 0, totalSamples: 0, codec: null };
  let p = 0;
  while (p + 27 <= b.length && ascii(b, p, 4) !== 'OggS') p++;
  if (p + 27 > b.length) return out;
  const nseg = b[p + 26];
  let pay = p + 27 + nseg;
  if (pay + 16 > b.length) return out;
  // vorbis：\x01vorbis + 版本(4) + 声道(1) + 采样率(4)
  if (b[pay] === 0x01 && ascii(b, pay + 1, 6) === 'vorbis') {
    out.codec = 'vorbis';
    out.channels = b[pay + 11];
    out.sampleRate = u32le(b, pay + 12);
  } else if (ascii(b, pay, 8) === 'OpusHead') {
    out.codec = 'opus';
    out.channels = b[pay + 9];
    /**
     * opus 的 granulepos **恒按 48kHz 计**，跟 input_sample_rate 无关
     * （那个字段只是给混音器做参考）。所以这里报 48000，
     * 否则「总采样数 ÷ 采样率」算出来的时长会差几倍。
     */
    out.sampleRate = 48000;
    out.preSkip = u16le(b, pay + 10);
  }
  return out;
}

/**
 * Ogg 的总采样数：从**文件尾部**找最后一个有效页的 granulepos。
 *
 * `granulepos` 是 64 位无符号、小端；全 F（-1）表示「这一页里没有结束的 packet」，
 * 编码器收尾时常见，所以要继续往前翻，别拿到 -1 就当成 0。
 *
 * @param {Uint8Array} tail 文件末尾若干字节（建议 ≥64KB）
 * @returns {number} 总采样数（opus 已经减掉 pre-skip）；认不出返回 0
 */
export function probeOggDuration(tail) {
  if (!tail || tail.length < 27) return 0;
  let granule = 0;
  let preSkip = 0;
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] !== 0x4f || tail[i + 1] !== 0x67 || tail[i + 2] !== 0x67 || tail[i + 3] !== 0x53) continue;
    const lo = u32le(tail, i + 6);
    const hi = u32le(tail, i + 10);
    if (hi === 0xffffffff && lo === 0xffffffff) continue; // 该页没有结束 packet
    granule = hi * 4294967296 + lo;
    if (granule > 0) break;
  }
  if (!granule) return 0;
  // opus 的 pre-skip 记在 OpusHead 里，读不到就按 0 处理（宁可差 6.5ms 也别给 0）
  for (let i = 0; i + 19 <= tail.length; i++) {
    if (ascii(tail, i, 8) === 'OpusHead') {
      preSkip = u16le(tail, i + 10);
      break;
    }
  }
  return Math.max(0, granule - preSkip);
}

/**
 * @param {Uint8Array} bytes 文件开头即可（WAV 的 data 块大小在头里，不必读全文件）
 * @param {number} [fileSize] 整个文件的字节数 —— MP3 只能靠它算时长
 * @returns {{format:string,sampleRate:number,channels:number,bits:number,totalSamples:number,durationMs:number}|null}
 */
export function probeAudioInfo(bytes, fileSize = 0) {
  if (!bytes || bytes.length < 16) return null;
  const head = ascii(bytes, 0, 4);
  let info = null;

  if (head === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') info = probeWav(bytes);
  else if (head === 'FORM' && /AIFF|AIFC/.test(ascii(bytes, 8, 4))) info = probeAiff(bytes);
  else if (head === 'fLaC') info = probeFlac(bytes);
  /**
   * Ogg 以前直接返回一个空的 `{format:'ogg'}` —— 结果是 `durationMs` 恒为 0，
   * 曲目列表里 ogv/ogg 的时长永远显示「—」。现在至少把采样率/声道读出来，
   * 时长由 `probeFile`（主进程）补读文件尾的 granulepos。
   */
  else if (head === 'OggS') info = probeOggHead(bytes);
  else if (head.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    info = probeMp3(bytes, fileSize);
  else if (ascii(bytes, 4, 4) === 'ftyp') info = { format: 'mp4', sampleRate: 0, channels: 0, bits: 0, totalSamples: 0 };
  if (!info) return null;

  const durationMs = info.durationMs ?? (info.sampleRate ? Math.round((info.totalSamples / info.sampleRate) * 1000) : 0);
  return { ...info, durationMs };
}

/** 采样率显示成 "44.1 kHz" */
export function formatSampleRate(rate) {
  if (!rate) return '—';
  return `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz`;
}
