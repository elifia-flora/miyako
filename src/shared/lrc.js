/**
 * lrc.js — LRC 歌词解析（纯 JS，主进程与测试共用）
 *
 * 只做两件事：把文件读成「按时间排好的句子」，以及回答「这一刻该亮哪一句」。
 * 排版、滚动、时间戳显示都在渲染层，这里不碰 DOM，也不猜语言。
 *
 * 支持的写法：
 *   [00:10.838]嗚呼 あの暗闇が        标准行（.838 = 838ms）
 *   [00:10]整句                         没有毫秒
 *   [00:10.00][00:20.00]重复句          一行多个时间戳
 *   [ti:标题] [ar:歌手] [al:专辑] [by:作者] [offset:-500]
 *   {"t":0,"c":[{"tx":"作词: "},{"tx":"ヨコオタロウ"}]}
 *       —— 卡拉OK 工具导出的逐字文件里混进来的 JSON 行。
 *       这类行**不是歌词**（是制作名单），转成 meta.credits，否则开播前十秒
 *       屏幕上会一直挂着「作词: xxx」，像卡住了。
 *
 * 约定：
 *   - 返回的 lines 按 ms 升序；同一毫秒的多句保持文件里的先后顺序。
 *   - 空文本行丢掉（LRC 里常拿空行当段落间隔，留着只会让高亮停在一片空白上）。
 *   - `offset` 是 LRC 自己的全局偏移：**直接加到每句的时间上**（正值 = 推迟）。
 *     解析时已经算进去了，调用方不用再管；负到 0 以下的句子夹到 0。
 */

/** 时间戳：mm:ss、mm:ss.x、mm:ss.xx、mm:ss.xxx；分钟允许超过 99（长音频） */
const STAMP = /^\[(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

/** 元数据标签：[ti:…]，值里允许出现冒号（[by:A:B]） */
const META = /^\[([a-zA-Z]+):(.*)\]$/;

const META_KEYS = new Set(['ti', 'ar', 'al', 'by', 'offset', 'length', 're', 've']);

function toMs(min, sec, frac) {
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return Number(min) * 60000 + Number(sec) * 1000 + ms;
}

function tryJson(line) {
  if (!line.startsWith('{') || !line.endsWith('}')) return null;
  try {
    const j = JSON.parse(line);
    if (!j || typeof j.t !== 'number' || !Array.isArray(j.c)) return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * @param {string} text LRC 文件内容
 * @returns {{
 *   lines: { ms: number, endMs?: number, text: string, words?: { ms: number, text: string }[] }[],
 *   meta: { ti: string, ar: string, al: string, by: string, offset: number, credits: string[] },
 * }}
 */
export function parseLrc(text) {
  const lines = [];
  const meta = { ti: '', ar: '', al: '', by: '', offset: 0, credits: [] };
  const raw = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);

  // offset 可能写在文件末尾：先整体扫一遍，最后统一加
  for (const row of raw) {
    const t = row.trim();
    if (!t) continue;
    const m = META.exec(t);
    if (m && m[1].toLowerCase() === 'offset') {
      const v = Number(m[2].trim());
      if (Number.isFinite(v)) meta.offset = v;
    }
  }

  for (const row of raw) {
    const rawLine = row.trim();
    if (!rawLine) continue;

    // 逐字 JSON：只收制作名单，不当歌词
    const j = tryJson(rawLine);
    if (j) {
      const s = j.c
        .map((seg) => (seg && typeof seg.tx === 'string' ? seg.tx : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (s && !meta.credits.includes(s)) meta.credits.push(s);
      continue;
    }

    // 一行可能挂多个时间戳：[00:01.00][00:05.00]同一句
    const stamps = [];
    let rest = rawLine;
    let m;
    while ((m = STAMP.exec(rest))) {
      stamps.push(toMs(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }

    if (!stamps.length) {
      // 纯元数据行
      const mm = META.exec(rawLine);
      if (mm) {
        const k = mm[1].toLowerCase();
        const v = mm[2].trim();
        if (META_KEYS.has(k) && k !== 'offset' && v) meta[k] = v;
      }
      continue;
    }

    const body = rest.trim();
    if (!body) continue;
    // 增强 LRC：`<00:12.34>字` 留在 words 里。显示用的 text 只是去掉时间标记后的原文，
    // 不在字与字之间另加空格（中文会多出空隙）。
    const enhanced = splitEnhanced(body);
    const text = enhanced ? enhanced.text : body;
    if (!text) continue;
    for (const ms of stamps) {
      const line = { ms, text };
      if (enhanced) line.words = enhanced.words.map((w) => ({ ms: w.ms, text: w.text }));
      lines.push(line);
    }
  }

  // 稳定排序：同一毫秒保持文件顺序（Array#sort 在现代 V8 里是稳定的）
  lines.sort((a, b) => a.ms - b.ms);

  if (meta.offset) {
    const d = meta.offset;
    for (const l of lines) {
      l.ms = Math.max(0, l.ms + d);
      if (l.words) for (const w of l.words) w.ms = Math.max(0, w.ms + d);
    }
  }

  return { lines, meta };
}

/**
 * 这一刻该亮第几句：最后一个 ms <= 当前位置的行；都在未来时返回 -1。
 * 二分查找 —— 每帧都会问一次（60fps），线性扫 100 句也不是不行，但没必要。
 */
export function activeLineIndex(lines, ms) {
  const arr = lines ?? [];
  let lo = 0;
  let hi = arr.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ms <= ms) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (hit < 0) return -1;
  // SRT 有结束时间：句子已经结束、下一句还没开始时，不高亮任何一行。
  // 普通 LRC 没有 endMs，高亮一直留到下一句，和以前一样。
  const end = arr[hit].endMs;
  if (typeof end === 'number' && Number.isFinite(end) && ms >= end) return -1;
  return hit;
}

const WORD_TAG = /<(\d{1,4}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/** 没有逐字标记就返回 null，调用方按普通句子处理。 */
function splitEnhanced(body) {
  WORD_TAG.lastIndex = 0;
  if (!WORD_TAG.test(body)) return null;
  WORD_TAG.lastIndex = 0;
  const words = [];
  let m;
  const marks = [];
  while ((m = WORD_TAG.exec(body))) {
    marks.push({ index: m.index, len: m[0].length, ms: toMs(m[1], m[2], m[3]) });
  }
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i].len;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const text = body.slice(start, end).replace(/\s+/g, ' ').trim();
    if (text) words.push({ ms: marks[i].ms, text });
  }
  WORD_TAG.lastIndex = 0;
  const text = body.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
  if (!text || !words.length) return null;
  return { text, words };
}

/**
 * 毫秒 → LRC 的 `[mm:ss.xxx]`。
 *
 * 显示为什么要用这个而不是自己拼：`[00:14.671]` 里的 `.671` 是**三位**，
 * 很多播放器写成 `.67` 或 `.7`，跟原文件对不上就很难手动核对。
 * 而 LRC 规范就是三位（毫秒），补齐到三位不会引入偏差。
 */
export function formatLrcStamp(ms) {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  const m = Math.floor(v / 60000);
  const s = Math.floor((v % 60000) / 1000);
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(v % 1000).padStart(3, '0')}]`;
}

/**
 * 解析用户敲进来的时间戳 → 毫秒。宽容一点，两种写法都收：
 *   `00:14.671` / `[00:14.671]` / `0:14.671` / `14.671`（当作 0 分）
 *   `00:14,671`（逗号也认，有些播放器导出成这个）
 * 解析不了返回 null，调用方决定是拒绝还是忽略。
 */
export function parseLrcStamp(input) {
  const s = String(input ?? '').trim().replace(/^\[|\]$/g, '').replace(',', '.');
  if (!s) return null;
  const m = /^(\d{1,3}):([0-5]?\d)(?:\.(\d{1,3}))?$/.exec(s);
  if (m) {
    const frac = (m[3] ?? '').padEnd(3, '0');
    return Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(frac || 0);
  }
  // 没有冒号：只有「14.671」这种，算 0 分
  const only = /^(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (only) {
    const frac = only[2].padEnd(3, '0');
    return Number(only[1]) * 1000 + Number(frac);
  }
  return null;
}

/**
 * 把改过的行写回 LRC 文本。
 *
 * 为什么整份重写而不是原地替换一行：LRC 没有「行号」这个概念，
 * 我们拿到的只是解析后的数组；重新序列化能保证输出的一定是合法 LRC。
 * 保留原文件的元数据（ti / ar / al / offset…），其余不认识的行丢掉 ——
 * 那是我们自己不认识的行，保着反而可能写出解析器读不回来的东西。
 */
export function serializeLrc(lines, meta = {}) {
  const out = [];
  const keys = [
    ['ti', 'title'], ['ar', 'artist'], ['al', 'album'], ['au', 'author'],
    ['by', 'by'], ['offset', 'offset'], ['length', 'length'], ['re', 'editor'],
    ['ve', 'version'],
  ];
  for (const [k, label] of keys) {
    const v = meta[label] ?? meta[k];
    if (v !== undefined && v !== null && String(v).trim()) out.push(`[${k}:${v}]`);
  }
  const sorted = [...(lines ?? [])].sort((a, b) => a.ms - b.ms);
  for (const l of sorted) out.push(`${formatLrcStamp(l.ms)}${l.text ?? ''}`);
  return out.join('\r\n') + '\r\n';
}
