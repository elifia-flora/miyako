/**
 * srt.js — SubRip 字幕收成和 LRC 一样的行。
 *
 * 一行是 { ms, endMs, text }。endMs 是高亮结束（不含）。
 * 两句之间的空白不该继续亮着上一句 —— 调用方用 endMs 判断。
 * 多行字幕保留换行。序号行可有可无。
 */

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function partMs(h, m, s, frac) {
  const ms = Number(String(frac).padEnd(3, '0').slice(0, 3));
  return Number(h) * 3600000 + Number(m) * 60000 + Number(s) * 1000 + ms;
}

/**
 * @param {string} text
 * @returns {{ lines: { ms: number, endMs: number, text: string }[] }}
 */
export function parseSrt(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  for (const block of raw.split(/\n{2,}/)) {
    const rows = block.split('\n');
    const ti = rows.findIndex((row) => TIME.test(row.trim()));
    if (ti < 0) continue;
    const m = TIME.exec(rows[ti].trim());
    if (!m) continue;
    const body = rows
      .slice(ti + 1)
      .join('\n')
      .replace(/\s+$/g, '')
      .replace(/^\n+/, '')
      .trim();
    if (!body) continue;
    const ms = partMs(m[1], m[2], m[3], m[4]);
    const endMs = partMs(m[5], m[6], m[7], m[8]);
    if (endMs < ms) continue;
    lines.push({ ms, endMs, text: body });
  }
  lines.sort((a, b) => a.ms - b.ms || a.endMs - b.endMs);
  return { lines };
}
