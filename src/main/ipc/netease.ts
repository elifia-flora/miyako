import { shell } from 'electron';
import { neteaseSongId, parseWebLink, songDeepLink } from '../../shared/netease.js';
import { mt } from '../locale';

export interface OpenMusicLinkResult {
  ok: boolean;
  via: 'orpheus' | 'browser' | 'failed';
  url: string;
  note?: string;
  noteKey?: string;
  noteVars?: Record<string, unknown>;
}

function result(
  base: { ok: boolean; via: 'orpheus' | 'browser' | 'failed'; url: string },
  key: string,
  vars?: Record<string, unknown>
): OpenMusicLinkResult {
  return { ...base, note: mt(key, vars), noteKey: key, noteVars: vars };
}

export async function openMusicLink(rawUrl: string): Promise<OpenMusicLinkResult> {
  const parsed = parseWebLink(rawUrl);
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!parsed) return result({ ok: false, via: 'failed', url }, 'netease.invalidLink');

  const id = neteaseSongId(url);
  const deepLink = id ? songDeepLink(id) : null;

  if (process.argv.includes('--smoke')) {
    return result({ ok: false, via: 'failed', url }, 'netease.smoke', { link: deepLink ?? url });
  }

  if (deepLink) {
    try {
      await shell.openExternal(deepLink);
      return result({ ok: true, via: 'orpheus', url: deepLink }, 'netease.byId');
    } catch (e) {
      console.warn('[netease] 客户端唤起失败，改用浏览器：', e);
    }
  }

  try {
    await shell.openExternal(url);
    return result({ ok: true, via: 'browser', url }, 'netease.browser');
  } catch (e) {
    return { ok: false, via: 'failed', url, note: String(e) };
  }
}
