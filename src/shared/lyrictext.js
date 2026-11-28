/**
 * lyrictext.js — 歌词文件按字节解码。
 *
 * 只认三种常见无歧义的写法：UTF-8、UTF-8 BOM、UTF-16 BOM（小端 / 大端）。
 * 不猜 GBK。猜错的编码比「看起来是乱码」更糟，因为会把歌词写进档案里。
 *
 * @param {Uint8Array | Buffer} buf
 * @returns {string}
 */
export function decodeLyricBytes(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf ?? []);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(b.subarray(3));
  }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(b.subarray(2)).replace(/^\uFEFF/, '');
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const even = b.length - (b.length % 2);
    const swapped = new Uint8Array(even - 2);
    for (let i = 2; i < even; i += 2) {
      swapped[i - 2] = b[i + 1];
      swapped[i - 1] = b[i];
    }
    return new TextDecoder('utf-16le').decode(swapped).replace(/^\uFEFF/, '');
  }
  return new TextDecoder('utf-8').decode(b).replace(/^\uFEFF/, '');
}
