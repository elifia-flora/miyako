/**
 * audiodrop.js — 把拖进来的路径分成「能登记的音频」和「其余」。
 *
 * 纯函数：渲染层用来决定要不要弹出「三种挂法」，主进程用来真正登记。
 * 资源管理器、Everything、访达交给 Chromium 的都是同一份文件列表，这里不区分来源。
 *
 * 扩展名与 `src/main/ipc/audio.ts` 的 AUDIO_EXT 保持一致。那边要读文件头，
 * 这边只看名字，所以不把 electron 模块引进来。
 */

export const AUDIO_EXTS = ['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.aif'];

export const DROP_MODES = ['versions', 'variants', 'tracks'];

function baseName(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 用来判「是不是同一个路径」。Windows 大小写不敏感，调用方把 foldCase 打开。 */
export function pathKey(p, { foldCase = false } = {}) {
  let s = String(p ?? '').trim().replace(/\\/g, '/');
  s = s.replace(/\/{2,}/g, '/');
  if (foldCase) s = s.toLowerCase();
  return s;
}

export function audioExt(p) {
  const base = baseName(p);
  const i = base.lastIndexOf('.');
  if (i <= 0) return '';
  return base.slice(i).toLowerCase();
}

export function isAudioPath(p) {
  return AUDIO_EXTS.includes(audioExt(p));
}

/** 封面已经接受的图片。拖进来的图片和「选封面」用同一张表。 */
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'];

/** 歌词只认这两种。`.txt` 太容易和说明文件混在一起，不收。 */
export const LYRIC_EXTS = ['.lrc', '.srt'];

/**
 * 把一次拖放分成音频 / 图片 / 歌词 / 其余。
 * 同一路径只留第一次。扩展名看文件名，不看 MIME —— 资源管理器经常给空类型。
 *
 * @param {unknown[]} paths
 * @param {{ foldCase?: boolean }} [opt]
 */
export function classifyDroppedPaths(paths, opt = {}) {
  const audio = [];
  const image = [];
  const lyric = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of paths ?? []) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    const key = pathKey(p, opt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ext = audioExt(p);
    if (AUDIO_EXTS.includes(ext)) audio.push(p);
    else if (IMAGE_EXTS.includes(ext)) image.push(p);
    else if (LYRIC_EXTS.includes(ext)) lyric.push(p);
    else rejected.push(p);
  }
  return { audio, image, lyric, rejected };
}

/** 曲名：去掉扩展名。`.flac` 这种没有主名的，整段留下，免得变成空标题。 */
export function titleFromAudioPath(p, fallback = '') {
  const base = baseName(p);
  const i = base.lastIndexOf('.');
  const name = (i > 0 ? base.slice(0, i) : base).trim();
  return name || String(fallback ?? '').trim();
}

/**
 * @param {unknown[]} paths
 * @param {{ foldCase?: boolean }} [opt]
 * @returns {{ audio: string[], rejected: string[] }}
 */
export function splitDroppedPaths(paths, opt = {}) {
  const audio = [];
  const rejected = [];
  const seen = new Set();
  for (const raw of paths ?? []) {
    const p = String(raw ?? '').trim();
    if (!p) continue;
    const key = pathKey(p, opt);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (isAudioPath(p)) audio.push(p);
    else rejected.push(p);
  }
  return { audio, rejected };
}

/**
 * 决定每个文件建成演奏版本还是音质，以及要建几份作品。
 *
 * `dupTitle` 非空 = 库里已经有同一哈希或同一路径，整份跳过。
 * 同一批里哈希相同的，只留第一份。
 *
 * @param {Array<{ path: string, hash?: string | null, title?: string, dupTitle?: string | null }>} items
 * @param {'versions' | 'variants' | 'tracks'} mode
 */
export function planAudioImport(items, mode) {
  const use = DROP_MODES.includes(mode) ? mode : 'tracks';
  const skip = [];
  const fresh = [];
  const seenHash = new Set();
  for (const it of items ?? []) {
    if (!it?.path) continue;
    if (it.dupTitle) {
      skip.push({ path: it.path, title: String(it.dupTitle), reason: 'library' });
      continue;
    }
    const hash = it.hash ? String(it.hash) : '';
    if (hash && seenHash.has(hash)) {
      skip.push({ path: it.path, title: '', reason: 'batch' });
      continue;
    }
    if (hash) seenHash.add(hash);
    fresh.push(it);
  }

  if (!fresh.length) return { mode: use, groups: [], skip };

  const asFile = (it, role) => ({
    path: it.path,
    hash: it.hash ? String(it.hash) : null,
    role,
  });

  if (use === 'tracks') {
    return {
      mode: use,
      skip,
      groups: fresh.map((it) => ({
        title: String(it.title || titleFromAudioPath(it.path)),
        files: [asFile(it, 'version')],
      })),
    };
  }

  const [first, ...rest] = fresh;
  const title = String(first.title || titleFromAudioPath(first.path));
  if (use === 'variants') {
    return {
      mode: use,
      skip,
      groups: [
        {
          title,
          files: [asFile(first, 'version'), ...rest.map((it) => asFile(it, 'variant'))],
        },
      ],
    };
  }

  return {
    mode: 'versions',
    skip,
    groups: [{ title, files: fresh.map((it) => asFile(it, 'version')) }],
  };
}

/**
 * 状态栏要显示的几句。存词典键，不存已经翻好的句子，切语言还能跟着变。
 *
 * @param {{
 *   tracks?: { title?: string }[],
 *   versions?: number,
 *   variants?: number,
 *   skipped?: number,
 *   rejected?: number,
 *   failed?: number,
 * }} result
 * @returns {{ key: string, vars?: Record<string, unknown> }[]}
 */
export function dropNotice(result) {
  const tracks = Array.isArray(result?.tracks) ? result.tracks : [];
  const versions = Number(result?.versions) || 0;
  const variants = Number(result?.variants) || 0;
  const skipped = Number(result?.skipped) || 0;
  const rejected = Number(result?.rejected) || 0;
  const failed = Number(result?.failed) || 0;
  const parts = [];
  const title = tracks[0]?.title || '';
  if (result?.attached) {
    if (versions > 0) parts.push({ key: 'drop.okDetailVersions', vars: { title, n: versions } });
    else if (variants > 0) parts.push({ key: 'drop.okDetailVariants', vars: { title, n: variants } });
  } else if (tracks.length === 1 && versions <= 1 && variants === 0) {
    parts.push({ key: 'drop.okOne', vars: { title: tracks[0]?.title || '' } });
  } else if (tracks.length === 1 && variants > 0) {
    parts.push({ key: 'drop.okVariants', vars: { title: tracks[0]?.title || '', n: variants } });
  } else if (tracks.length === 1 && versions > 1) {
    parts.push({ key: 'drop.okVersions', vars: { title: tracks[0]?.title || '', n: versions } });
  } else if (tracks.length > 1) {
    parts.push({ key: 'drop.okTracks', vars: { n: tracks.length } });
  }
  const coversBound = Number(result?.coversBound) || 0;
  const lyricsBound = Number(result?.lyricsBound) || 0;
  const lyricUnbound = Number(result?.lyricUnbound) || 0;
  const mediaSkipped = Number(result?.mediaSkipped) || 0;
  if (coversBound) parts.push({ key: 'drop.coverBound', vars: { n: coversBound } });
  if (lyricsBound) parts.push({ key: 'drop.lyricBound', vars: { n: lyricsBound } });
  if (lyricUnbound) parts.push({ key: 'drop.lyricUnbound', vars: { n: lyricUnbound } });
  if (mediaSkipped) parts.push({ key: 'drop.mediaSkipped', vars: { n: mediaSkipped } });
  if (skipped) parts.push({ key: 'drop.skipped', vars: { n: skipped } });
  if (rejected) parts.push({ key: 'drop.rejected', vars: { n: rejected } });
  if (failed) parts.push({ key: 'drop.failedN', vars: { n: failed } });
  if (!parts.length) parts.push({ key: 'drop.none' });
  return parts;
}
