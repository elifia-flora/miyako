/**
 * audiotags.js — 把「文件里写的元数据」读成统一形状，不管它藏在哪个容器里。
 *
 * 为什么单独开一个文件：`audiofile.js` 只关心「能不能播、多长、偏多少」，
 * 这里关心的是「作者是谁、在哪个工程里导的、第几小节」。两件事的失败模式完全不同 ——
 * 元数据读不出来**不该让播放坏掉**，所以这里全部做成「读不到就当没有」，永不抛错。
 *
 * 三类容器三种藏法：
 *   wav  → `bext`（固定偏移的定长字段）+ `iXML`（XML，通常在文件**尾部**）
 *   mp3  → ID3v2 帧（开头，可能有 synchsafe 长度）
 *   flac → VORBIS_COMMENT 块（`KEY=value` 的 UTF-8 文本）
 *   ogg  → 第二个包里的 vorbis comment / opus tags（同样是 `KEY=value`）
 *   mp4  → `ilst`，atom 套得太深，这一版**故意不解析**（返回空，界面显示「不支持」）
 *
 * 纯函数、只吃 Uint8Array，主进程与 node --test 共用。
 */

const ascii = (b, off, len) => {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[off + i] || 0);
  return s;
};
const u16le = (b, o) => (b[o] | (b[o + 1] << 8)) & 0xffff;
const u32le = (b, o) => ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
const i16le = (b, o) => {
  const v = u16le(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
};

/** 去掉尾部的 \0 之后按严格 UTF-8 解；不是合法 UTF-8 就退回 latin1（不替换成 U+FFFD） */
function decodeText(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const body = bytes.subarray(0, end);
  if (!body.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    let s = '';
    for (let i = 0; i < body.length; i++) s += String.fromCharCode(body[i]);
    return s;
  }
}

/**
 * ID3 的 UTF-16 文本：**必须看 BOM**。
 * `ff fe` = 小端，`fe ff` = 大端；没有 BOM 时规范说按小端，但很多写入器写的是大端，
 * 所以先按小端试，出现大量替换字符再换大端 —— 比拍脑袋猜一种可靠。
 */
function decodeUtf16(bytes) {
  if (bytes.length < 2) return '';
  let be = false;
  let start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) start = 2;
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    be = true;
    start = 2;
  }
  const body = bytes.subarray(start);
  const even = body.length & ~1;
  let s = '';
  /**
   * 别在这里"先把字节序翻过来再按小端读"—— 那是两步抵消，看着对称，
   * 实际等价于把 LE 读成 BE（踩过：`52 97` 该是「青」，翻一圈变成「劗」）。
   * 直接按 lo/hi 取。
   */
  for (let i = 0; i < even; i += 2) {
    const lo = be ? body[i + 1] : body[i];
    const hi = be ? body[i] : body[i + 1];
    s += String.fromCharCode(lo | (hi << 8));
  }
  return s.replace(/\0+$/, '').replace(/^\uFEFF/, '');
}

/* ------------------------------------------------------------------ *
 * WAV：bext（定长字段）+ iXML（XML，通常在文件尾部）
 * ------------------------------------------------------------------ */

/** bext 固定布局的字段表：[id, 偏移, 长度] */
const BEXT_TEXT = [
  ['description', 0, 256],
  ['originator', 256, 32],
  ['originatorRef', 288, 32],
  ['date', 320, 10],
  ['time', 330, 8],
];

function parseBext(d) {
  const items = [];
  if (d.length < 602) return items;
  for (const [key, off, len] of BEXT_TEXT) {
    const v = decodeText(d.subarray(off, off + len));
    if (v) items.push({ key, value: v });
  }
  const lo = u32le(d, 338);
  const hi = u32le(d, 342);
  const timeRef = hi * 4294967296 + lo;
  if (timeRef) items.push({ key: 'timeReference', value: String(timeRef) });
  const version = u16le(d, 346);
  if (version) items.push({ key: 'version', value: String(version) });
  if (d.length >= 422) {
    // 响度四个字段是 int16、单位 0.01 dB（只有 version >= 1 才有意义）
    const loud = [
      ['loudness', 412],
      ['loudnessRange', 414],
      ['maxTruePeak', 416],
      ['maxMomentary', 418],
      ['maxShortTerm', 420],
    ];
    for (const [key, off] of loud) {
      const raw = i16le(d, off);
      if (raw !== 0 && raw !== -32768) items.push({ key, value: (raw / 100).toFixed(2) });
    }
  }
  const umid = d.subarray(348, 412);
  if (umid.some((x) => x !== 0)) {
    let hex = '';
    for (const x of umid) hex += x.toString(16).padStart(2, '0');
    items.push({ key: 'umid', value: hex.toUpperCase().replace(/(00)+$/, '') });
  }
  const hist = decodeText(d.subarray(602));
  if (hist) items.push({ key: 'codingHistory', value: hist.replace(/\r\n/g, ' ').trim() });
  return items;
}

/** XML 实体解码（iXML 里的文件名偶尔带 &amp;） */
const unxml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * 把 iXML 拍平成 `路径 → 文本`。
 *
 * 不做完整 XML 解析（没必要，iXML 只有元素和文本），但**保留层级路径**：
 * `BWFXML/STEINBERG/ATTR_LIST/ATTR/NAME` 这种同名标签在很多层里都出现，
 * 只留标签名会让「哪个 NAME 是 MediaCompany 的」完全看不出来。
 */
function parseIXml(text) {
  const src = text.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  const stack = [];
  /**
   * 同名的兄弟元素要编号（`ATTR`、`ATTR#1`、`ATTR#2`…）。
   * 不加编号的话，20 个 `<ATTR>` 拍平后路径**全都一样**，
   * 后面配对 NAME/VALUE 时会互相覆盖，最后只剩一条（踩过）。
   */
  const ord = new Map();
  let pending = '';
  const re = /<([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<\/([A-Za-z_][\w.:-]*)\s*>|([^<]+)/g;
  let m;
  let guard = 0;
  while ((m = re.exec(src)) && guard++ < 50000) {
    if (m[1]) {
      const parent = stack.join('/');
      const k = `${parent}\u0000${m[1]}`;
      const n = ord.get(k) ?? 0;
      ord.set(k, n + 1);
      stack.push(n === 0 ? m[1] : `${m[1]}#${n}`);
      pending = '';
      if (m[3] === '/') {
        out.push({ key: stack.join('/'), value: '' });
        stack.pop();
      }
    } else if (m[4]) {
      const v = pending.trim();
      if (v) out.push({ key: stack.join('/'), value: unxml(v) });
      stack.pop();
      pending = '';
    } else if (m[5] !== undefined) {
      pending = m[5];
    }
  }
  /**
   * Cubase 把「自定义键值」塞在 `<STEINBERG><ATTR_LIST><ATTR><NAME>…</NAME>
   * <VALUE>…</VALUE></ATTR>` 里。拍平成路径后 NAME 和 VALUE 会变成两条毫不相干的
   * 记录（`…/ATTR/NAME` = "MusicalTempo"、`…/ATTR/VALUE` = "72"），
   * 配对关系全丢了 —— 所以这里把同一个 ATTR 下的两条合成一条 `ATTR · MusicalTempo = 72`。
   *
   * 注意 ATTR 是**同名兄弟**，路径带 `#1`/`#2` 编号（见上面的 ord），
   * 匹配时不能写死 `/ATTR/`（踩过：只有第一个 ATTR 被合并）。
   */
  const ATTR_RE = /\/(ATTR(?:#\d+)?)\/(NAME|VALUE)$/;
  const attrs = new Map();
  for (const it of out) {
    const m = ATTR_RE.exec(it.key);
    if (!m) continue;
    const parent = it.key.slice(0, it.key.length - m[0].length) + '/' + m[1];
    const a = attrs.get(parent) ?? {};
    if (m[2] === 'NAME') a.name = it.value;
    else a.value = it.value;
    attrs.set(parent, a);
  }
  const merged = [];
  const used = new Set();
  for (const it of out) {
    const m = ATTR_RE.exec(it.key);
    if (m) {
      const parent = it.key.slice(0, it.key.length - m[0].length) + '/' + m[1];
      const a = attrs.get(parent);
      if (a?.name && a.value !== undefined && !used.has(parent)) {
        used.add(parent);
        merged.push({ key: `ATTR · ${a.name}`, value: a.value });
      }
      if (used.has(parent)) continue; // 配对成功的那两条都不再单独出现
    }
    merged.push(it);
  }
  return merged;
}

/** 在字节里找 ASCII 标记，返回位置（找不到 -1） */
function findTag(b, tag, from = 0) {
  const n = tag.length;
  for (let i = from; i + n <= b.length; i++) {
    let hit = true;
    for (let k = 0; k < n; k++) {
      if (b[i + k] !== tag.charCodeAt(k)) {
        hit = false;
        break;
      }
    }
    if (hit) return i;
  }
  return -1;
}

/**
 * WAV 的元数据。**头和尾要分开处理**：
 * 头是块头遍历（`bext` 在 fmt 之前，能正常扫到）；
 * 尾不能从偏移 12 开始扫 —— 那里是音频数据的中间，会被当成块头读出垃圾。
 * 所以尾部只做「按标记定位」，且 `iXML` 的长度就在标记后 4 字节，够验证。
 */
function readWavTags(head, tail) {
  const groups = [];
  let bext = null;
  let ixmlText = null;
  let infoItems = null;

  const takeBext = (b, p, size) => {
    if (!bext) bext = b.subarray(p + 8, Math.min(p + 8 + size, b.length));
  };
  const takeIxml = (b, p, size) => {
    if (!ixmlText) {
      const raw = decodeText(b.subarray(p + 8, Math.min(p + 8 + size, b.length)));
      if (raw.trim().startsWith('<')) ixmlText = raw;
    }
  };
  const takeInfo = (b, p, size) => {
    if (!infoItems) {
      const sub = b.subarray(p + 8, Math.min(p + 8 + size, b.length));
      if (ascii(sub, 0, 4) === 'INFO') infoItems = parseListInfo(sub);
    }
  };

  // ① 头部：正经的块遍历
  let p = 12;
  while (p + 8 <= head.length) {
    const id = ascii(head, p, 4);
    const size = u32le(head, p + 4);
    if (id === 'bext') takeBext(head, p, size);
    else if (id === 'iXML') takeIxml(head, p, size);
    else if (id === 'LIST') takeInfo(head, p, size);
    if (size <= 0) break;
    /**
     * `data` 之后**不一定**没有东西 —— iXML 通常就在它后面。
     * 但 data 动辄几十 MB，块遍历跨不过去，所以判据是「跳过 data 之后
     * 还读得到下一个块头吗」：读得到就继续（小文件），读不到就交给尾部按标记找。
     */
    if (id === 'data' && p + 8 + size + 8 > head.length) break;
    p += 8 + size + (size & 1);
  }

  // ② 尾部：按标记找（iXML 几乎总在 data 之后）
  if (tail && tail !== head) {
    for (const [tag, take] of [
      ['iXML', takeIxml],
      ['bext', takeBext],
      ['LIST', takeInfo],
    ]) {
      let at = findTag(tail, tag);
      let guard = 0;
      while (at >= 0 && guard++ < 8) {
        if (at + 8 <= tail.length) {
          const size = u32le(tail, at + 4);
          if (size > 0 && at + 8 + size <= tail.length) take(tail, at, size);
        }
        at = findTag(tail, tag, at + 4);
      }
    }
  }

  if (infoItems?.length) groups.push({ id: 'INFO', items: infoItems });
  if (bext) {
    const items = parseBext(bext);
    if (items.length) groups.push({ id: 'bext', items });
  }
  if (ixmlText) {
    const items = parseIXml(ixmlText);
    if (items.length) groups.push({ id: 'iXML', items });
  }
  return groups;
}

/** LIST/INFO 子块：4 字节 id + 4 字节长度 + 文本（NUL 结尾） */
function parseListInfo(b) {
  const NAMES = {
    INAM: 'title',
    IART: 'artist',
    IPRD: 'product',
    ICRD: 'date',
    ICMT: 'comment',
    ISFT: 'software',
    IGNR: 'genre',
    ITCH: 'engineer',
    ISBJ: 'subject',
    ICOP: 'copyright',
  };
  const out = [];
  let p = 4;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4);
    const size = u32le(b, p + 4);
    if (!size || p + 8 + size > b.length) break;
    const v = decodeText(b.subarray(p + 8, p + 8 + size));
    if (v) out.push({ key: NAMES[id] ? `${id} · ${NAMES[id]}` : id, value: v });
    p += 8 + size + (size & 1);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * MP3：ID3v2 帧
 * ------------------------------------------------------------------ */

const ID3_NAME = {
  TIT2: 'title',
  TPE1: 'artist',
  TPE2: 'albumArtist',
  TALB: 'album',
  TYER: 'date',
  TDRC: 'date',
  TCON: 'genre',
  TRCK: 'track',
  TSSE: 'encoder',
  TENC: 'encodedBy',
  TCOM: 'composer',
  TPUB: 'publisher',
  TCOP: 'copyright',
  TBPM: 'bpm',
  TKEY: 'key',
  TIT1: 'grouping',
  TIT3: 'subtitle',
  COMM: 'comment',
  USLT: 'lyrics',
};

/** ID3v2.4 的帧长度是 synchsafe（每字节只用低 7 位），v2.3 是普通大端 */
const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const u32be = (b, o) => (((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);

function decodeId3Text(enc, raw) {
  if (enc === 1) return decodeUtf16(raw);
  if (enc === 2) return decodeUtf16(Uint8Array.from([0xfe, 0xff, ...raw]));
  if (enc === 3) return decodeText(raw);
  return decodeText(raw); // 0 = ISO-8859-1，用 latin1 兜底
}

function readId3Tags(head) {
  if (ascii(head, 0, 3) !== 'ID3' || head.length < 10) return null;
  const major = head[3];
  const flags = head[5];
  const size = synchsafe(head, 6);
  const end = Math.min(head.length, 10 + size);
  const items = [];
  let p = 10;
  // 扩展头（v2.3/v2.4 的 flag 0x40）：跳过去，不然第一帧会被读成乱码
  if (flags & 0x40 && p + 4 <= end) {
    const ext = major === 4 ? synchsafe(head, p) : u32be(head, p);
    p += ext + (major === 4 ? 0 : 4);
  }
  const idLen = major === 2 ? 3 : 4;
  while (p + 10 <= end) {
    const id = ascii(head, p, idLen);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const fsz = major === 2 ? (head[p + 3] << 16) | (head[p + 4] << 8) | head[p + 5] : major === 4 ? synchsafe(head, p + 4) : u32be(head, p + 4);
    const hdr = major === 2 ? 6 : 10;
    const bodyStart = p + hdr;
    if (fsz <= 0 || bodyStart + fsz > end) break;
    const body = head.subarray(bodyStart, bodyStart + fsz);
    if (id === 'APIC' || id === 'PIC') {
      const mime = major === 2 ? ascii(body, 1, 3) : ascii(body, 1, Math.min(20, body.length)).replace(/\0.*$/, '');
      items.push({ key: 'APIC · 内嵌图片', value: `${body.length} 字节${mime ? ' · ' + mime : ''}` });
    } else if (id === 'TXXX' || id === 'WXXX') {
      const enc = body[0];
      let i = 1;
      let descBytes = body.subarray(i);
      let cut = descBytes.indexOf(0);
      if (enc === 1 || enc === 2) {
        // UTF-16 的结束符是两个 0 字节，且要从偶数位开始找
        let k = 0;
        while (k + 1 < descBytes.length && !(descBytes[k] === 0 && descBytes[k + 1] === 0)) k += 2;
        cut = k;
      }
      const desc = decodeId3Text(enc, descBytes.subarray(0, Math.max(0, cut)));
      const val = decodeId3Text(enc, descBytes.subarray(cut + (enc === 1 || enc === 2 ? 2 : 1)));
      items.push({ key: `${id} · ${desc || '?'}`, value: val });
    } else if (id === 'COMM' || id === 'USLT') {
      const enc = body[0];
      // 语言 3 字节，然后是以 0 结尾的描述，剩下是正文
      const rest = body.subarray(4);
      let cut = 0;
      if (enc === 1 || enc === 2) {
        let k = 0;
        while (k + 1 < rest.length && !(rest[k] === 0 && rest[k + 1] === 0)) k += 2;
        cut = k;
      } else {
        cut = rest.indexOf(0);
        if (cut < 0) cut = 0;
      }
      const val = decodeId3Text(enc, rest.subarray(cut + (enc === 1 || enc === 2 ? 2 : 1)));
      items.push({ key: id === 'COMM' ? 'comment' : 'lyrics', value: val });
    } else {
      const enc = body[0];
      const val = decodeId3Text(enc, body.subarray(1));
      if (val) items.push({ key: ID3_NAME[id] ? `${id} · ${ID3_NAME[id]}` : id, value: val });
    }
    p = bodyStart + fsz;
  }
  return { version: `ID3v2.${major}.${head[4]}`, items };
}

/* ------------------------------------------------------------------ *
 * FLAC / Ogg：`KEY=value` 的注释块
 * ------------------------------------------------------------------ */

function parseComments(buf, start, end) {
  if (start + 4 > end) return [];
  const count = u32le(buf, start);
  let p = start + 4;
  const items = [];
  for (let i = 0; i < count && p + 4 <= end; i++) {
    const len = u32le(buf, p);
    p += 4;
    if (len <= 0 || p + len > end) break;
    const line = decodeText(buf.subarray(p, p + len));
    p += len;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    items.push({ key: line.slice(0, eq), value: line.slice(eq + 1) });
  }
  return items;
}

function readFlacTags(head) {
  if (ascii(head, 0, 4) !== 'fLaC') return null;
  const stream = [];
  const comments = [];
  let p = 4;
  while (p + 4 <= head.length) {
    const type = head[p] & 0x7f;
    const last = (head[p] & 0x80) !== 0;
    const size = (head[p + 1] << 16) | (head[p + 2] << 8) | head[p + 3];
    const body = p + 4;
    if (body + size > head.length) break;
    if (type === 4) comments.push(...parseComments(head, body, body + size));
    else if (type === 6) {
      const pic = head.subarray(body, body + size);
      const mime = ascii(pic, 4, Math.min(40, pic.length)).replace(/\0.*$/, '');
      comments.push({ key: 'PICTURE · 内嵌图片', value: `${size} 字节${mime ? ' · ' + mime : ''}` });
    } else if (type === 0 && size >= 34) {
      // STREAMINFO 的 md5：能一眼看出「解码后是不是同一份东西」
      let md5 = '';
      for (const x of head.subarray(body + 18, body + 34)) md5 += x.toString(16).padStart(2, '0');
      if (md5 !== '0'.repeat(32)) stream.push({ key: 'md5', value: md5 });
    }
    p = body + size;
    if (last) break;
  }
  return { stream, comments };
}

/**
 * Ogg：vorbis comment 是**第二个包**（第一个是 identification）。
 * 做法是顺着页找连续的 `\x03vorbis` 或 `OpusTags`，不依赖页边界 ——
 * 注释块可能跨页，按页解析反而要把 segtable 拼起来，没必要。
 */
function readOggTags(head) {
  const items = [];
  for (let i = 0; i + 16 < head.length; i++) {
    let bodyStart = -1;
    if (head[i] === 0x03 && ascii(head, i + 1, 6) === 'vorbis') bodyStart = i + 7;
    else if (ascii(head, i, 8) === 'OpusTags') bodyStart = i + 8;
    if (bodyStart < 0) continue;
    // vorbis 的注释块：`\x03vorbis` 之后紧跟 vendor 长度 + vendor + count + 条目
    const vendorLen = u32le(head, bodyStart);
    const afterVendor = bodyStart + 4 + vendorLen;
    const vendor = vendorLen > 0 && vendorLen < 4096 ? decodeText(head.subarray(bodyStart + 4, afterVendor)) : '';
    const list = parseComments(head, afterVendor, Math.min(head.length, afterVendor + 65536));
    if (vendor) items.push({ key: 'vendor', value: vendor });
    items.push(...list);
    break;
  }
  return items;
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/**
 * 标准字段的取值顺序：**前面的赢**。
 *
 * 「作者」这件事上，`bext.originator` 是 DAW 写的人名，比 ID3 的 `TPE1`
 * 更接近「这是谁做的」；但反过来，音乐文件的 `ARTIST` 才是听众认的那个。
 * 所以按容器各取所长 —— 见下面 buildStandard 里的分支。
 */
function buildStandard(groups, format) {
  const pick = (groupId, key) => {
    const g = groups.find((x) => x.id === groupId);
    const hit = g?.items.find((it) => it.key === key || it.key.startsWith(key + ' ·') || it.key.endsWith(' · ' + key));
    return hit?.value ?? '';
  };
  const findBy = (pred) => {
    for (const g of groups) for (const it of g.items) if (pred(it.key)) return it.value;
    return '';
  };

  const out = {};
  const set = (k, v) => {
    if (v && !out[k]) out[k] = v;
  };

  // 标题：ID3/vorbis 的 TITLE 优先，其次 wav LIST 的 INAM
  set('title', findBy((k) => /^(TIT2|title)$/i.test(k) || /^(TIT2|INAM) ·/.test(k)));
  set('title', pick('INFO', 'INAM'));

  if (format === 'wav') {
    // wav 里没有「歌手」概念，BWF 的 originator 就是作者
    set('artist', pick('bext', 'originator'));
    set('artist', findBy((k) => /^BWF_ORIGINATOR$/i.test(k.replace(/^.*\//, ''))));
    set('album', findBy((k) => /MediaCompany$/i.test(k)));
    set('date', pick('bext', 'date'));
    set('date', findBy((k) => /BWF_ORIGINATION_DATE$/.test(k)));
    set('encoder', pick('bext', 'codingHistory'));
    set('comment', pick('bext', 'description'));
  } else {
    set('artist', findBy((k) => /^(TPE1|ARTIST|artist)$/i.test(k) || /^(TPE1|IART) ·/.test(k)));
    set('album', findBy((k) => /^(TALB|ALBUM|album)$/i.test(k)));
    set('date', findBy((k) => /^(TYER|TDRC|DATE|date)$/i.test(k)));
    set('encoder', findBy((k) => /^(TSSE|ENCODER|encoder)$/i.test(k) || /^TSSE ·/.test(k)));
    set('comment', findBy((k) => /^(comment|COMMENT)$/i.test(k) || /^COMM ·/.test(k)));
  }
  set('encodedBy', findBy((k) => /^TENC ·/.test(k)));
  const allItems = groups.flatMap((g) => g.items);
  set('bpm', allItems.find((i) => /MusicalTempo$/.test(i.key))?.value ?? findBy((k) => /^(TBPM|BPM)$/i.test(k)));
  /**
   * 拍号在 iXML 里是 `rational` 类型：`<ATTR><NAME>MusicalSignature</NAME>
   * <NUMERATOR>4</NUMERATOR><DENOMINATOR>4</DENOMINATOR></ATTR>` —— **没有 VALUE**，
   * 所以上面那套「NAME/VALUE 配对」合不出它，得顺着 NAME 所在的 ATTR 前缀去拿分子分母。
   */
  const sig = allItems.find((i) => /\/NAME$/.test(i.key) && i.value === 'MusicalSignature');
  if (sig) {
    const base = sig.key.replace(/\/NAME$/, '');
    const num = allItems.find((i) => i.key === `${base}/NUMERATOR`)?.value;
    const den = allItems.find((i) => i.key === `${base}/DENOMINATOR`)?.value;
    if (num && den) set('meter', `${num}/${den}`);
  }
  const tref = pick('bext', 'timeReference');
  if (tref) set('timeReference', tref);
  const loud = pick('bext', 'loudness');
  if (loud) set('loudness', loud);
  return out;
}

/**
 * 读一个文件的全部元数据。
 *
 * @param {Uint8Array[]} chunks 文件开头；wav 建议再把尾部也放进来（iXML 常在文件尾）
 * @param {string|null} format `probeAudioInfo` 判出来的格式
 * @returns {{format:string, groups:Array<{id:string,items:Array<{key:string,value:string}>}>, standard:Record<string,string>}}
 */
export function readAudioTags(chunks, format) {
  const list = (Array.isArray(chunks) ? chunks : [chunks]).filter((c) => c && c.length);
  const fmt = String(format ?? '');
  const groups = [];
  const head = list[0];
  if (!head) return { format: fmt, groups, standard: {} };

  if (fmt === 'wav' || fmt === 'aiff') {
    groups.push(...readWavTags(head, list[1] ?? null));
    // aiff 的注释块（NAME/AUTH/ANNO）暂时不解析，返回空组不影响界面
  } else if (fmt === 'mp3') {
    const id3 = readId3Tags(head);
    if (id3?.items.length) groups.push({ id: id3.version, items: id3.items });
  } else if (fmt === 'flac') {
    const t = readFlacTags(head);
    if (t?.stream.length) groups.push({ id: 'STREAMINFO', items: t.stream });
    if (t?.comments.length) groups.push({ id: 'VORBIS_COMMENT', items: t.comments });
  } else if (fmt === 'ogg') {
    const items = readOggTags(head);
    if (items.length) groups.push({ id: 'VORBIS_COMMENT', items });
  }

  return { format: fmt, groups, standard: buildStandard(groups, fmt) };
}
