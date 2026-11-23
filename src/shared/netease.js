import { Buffer } from 'node:buffer';

export function parseWebLink(raw) {
  if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw.trim())) return null;
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function neteaseSongId(raw) {
  const url = parseWebLink(raw);
  if (!url || (url.hostname !== 'music.163.com' && !url.hostname.endsWith('.music.163.com'))) return null;
  if (url.hash.startsWith('#/') && !/^#\/(?:m\/)?song(?:[/?]|$)/.test(url.hash)) return null;
  const route = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
  const match = route.pathname.match(/^\/(?:m\/)?song(?:\/(\d+))?\/?$/);
  if (!match) return null;
  const id = match[1] ?? route.searchParams.get('id');
  return id && /^[1-9]\d*$/.test(id) ? id : null;
}

export function songDeepLink(id) {
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw new TypeError('Invalid NetEase song id');
  // 客户端按官网协议读取 Base64 JSON，而不是 song/<id> 路径。
  const command = { type: 'song', id, cmd: 'play' };
  return `orpheus://${Buffer.from(JSON.stringify(command), 'utf8').toString('base64')}`;
}
