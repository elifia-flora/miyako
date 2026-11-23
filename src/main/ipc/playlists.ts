/**
 * playlists.ts — 播放列表（`data/playlists.json`）
 *
 * 为什么是 JSON 而不是数据库表：播放列表是**人的组织方式**，不是档案属性。
 * 它引用 track.id，但曲目本身仍以 `data/tracks/*.json` 为源；
 * 把列表放进 SQLite 就会变成「删库就没了」的第二种真相。
 *
 * 「全部曲目」不是一条记录：它是 `__all__` 这个虚拟 id，永远等于当前曲库。
 * 这样用户新建、删除列表时不必维护一条永远同步不过来的「全部」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { mt } from '../locale.js';

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
}

export interface PlaylistDoc {
  schemaVersion: number;
  lists: Playlist[];
}

export const ALL_PLAYLIST_ID = '__all__';

export function playlistsPath(dataDir: string): string {
  return path.join(dataDir, 'playlists.json');
}

const EMPTY: PlaylistDoc = { schemaVersion: 1, lists: [] };

function normalize(raw: any): PlaylistDoc {
  const lists = Array.isArray(raw?.lists) ? raw.lists : [];
  return {
    schemaVersion: 1,
    lists: lists
      .filter((l: any) => l && typeof l.id === 'string' && l.id)
      .map((l: any) => ({
        id: String(l.id),
        name: String(l.name ?? '').trim() || '未命名播放列表',
        trackIds: Array.isArray(l.trackIds) ? [...new Set(l.trackIds.filter((x: any) => typeof x === 'string'))] : [],
      }))
      // 保留文件里的顺序，用户自己排过的顺序就是顺序
      .filter((l: Playlist) => l.id !== ALL_PLAYLIST_ID),
  };
}

export function loadPlaylists(dataDir: string): PlaylistDoc {
  try {
    const p = playlistsPath(dataDir);
    if (!fs.existsSync(p)) return { ...EMPTY, lists: [] };
    return normalize(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    // 文件坏了不该让软件打不开：当空列表，下次保存会覆盖
    return { ...EMPTY, lists: [] };
  }
}

/** 原子写：先写 .tmp 再 rename，断电也不会留下半个 JSON */
export function savePlaylists(dataDir: string, doc: PlaylistDoc): PlaylistDoc {
  const next = normalize(doc);
  const target = playlistsPath(dataDir);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, target);
  return next;
}

function newId(existing: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const id = `pl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!existing.has(id)) return id;
  }
  return `pl-${Date.now().toString(36)}`;
}

export function createPlaylist(dataDir: string, name?: string): PlaylistDoc {
  const doc = loadPlaylists(dataDir);
  const id = newId(new Set(doc.lists.map((l) => l.id)));
  const base = String(name ?? '').trim();
  // 默认名跟界面语言走：日语界面下新建出来的是「プレイリスト 3」，不是一串中文
  doc.lists.push({ id, name: base || mt('sidebar.playlistDefault', { n: doc.lists.length + 1 }), trackIds: [] });
  return savePlaylists(dataDir, doc);
}

export function renamePlaylist(dataDir: string, id: string, name: string): PlaylistDoc {
  const doc = loadPlaylists(dataDir);
  const hit = doc.lists.find((l) => l.id === id);
  if (hit) {
    const next = String(name ?? '').trim();
    if (next) hit.name = next;
  }
  return savePlaylists(dataDir, doc);
}

export function removePlaylist(dataDir: string, id: string): PlaylistDoc {
  const doc = loadPlaylists(dataDir);
  doc.lists = doc.lists.filter((l) => l.id !== id);
  return savePlaylists(dataDir, doc);
}

/** 整组替换某个列表的曲目（去重、保留传入顺序） */
export function setPlaylistTracks(dataDir: string, id: string, trackIds: string[]): PlaylistDoc {
  const doc = loadPlaylists(dataDir);
  const hit = doc.lists.find((l) => l.id === id);
  if (hit) hit.trackIds = [...new Set((trackIds ?? []).filter((x) => typeof x === 'string'))];
  return savePlaylists(dataDir, doc);
}
