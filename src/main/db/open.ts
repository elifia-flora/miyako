import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import sql001 from './migrations/001_init.sql?raw';
import sql002 from './migrations/002_fts_external_content.sql?raw';
import sql003 from './migrations/003_dim_split.sql?raw';
import sql004 from './migrations/004_recording.sql?raw';
import sql005 from './migrations/005_recording_link.sql?raw';
import sql006 from './migrations/006_recording_offset.sql?raw';
import sql007 from './migrations/007_meta.sql?raw';
import sql008 from './migrations/008_derived_fields.sql?raw';
import sql009 from './migrations/009_composition.sql?raw';
import sql010 from './migrations/010_chord_lane_split.sql?raw';
import sql011 from './migrations/011_movement_parent.sql?raw';
import sql012 from './migrations/012_recording_variant.sql?raw';

const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: '001_init', sql: sql001 },
  { version: 2, name: '002_fts_external_content', sql: sql002 },
  { version: 3, name: '003_dim_split', sql: sql003 },
  { version: 4, name: '004_recording', sql: sql004 },
  { version: 5, name: '005_recording_link', sql: sql005 },
  { version: 6, name: '006_recording_offset', sql: sql006 },
  { version: 7, name: '007_meta', sql: sql007 },
  { version: 8, name: '008_derived_fields', sql: sql008 },
  { version: 9, name: '009_composition', sql: sql009 },
  { version: 10, name: '010_chord_lane_split', sql: sql010 },
  { version: 11, name: '011_movement_parent', sql: sql011 },
  { version: 12, name: '012_recording_variant', sql: sql012 },
];

export interface DbHandle {
  db: Database.Database;
  dbPath: string;
  dataDir: string;
}

/**
 * 数据目录：开发时就是项目根下的 data/，方便你直接看 JSON 和 .db。
 * 打包后再换成 resources/data（只读） + userData（可写），这一步等真打包再做。
 */
export function resolveDataDir(): string {
  /**
   * 冒烟专用：`MA_DATA_DIR` 指向一份 `data/` 的副本，测试怎么折腾都不碰真实档案
   * （`data/` 只有 1.6MB，复制是秒级）。用环境变量而不是命令行开关 ——
   * Chromium 会把未知开关解析掉，环境变量不会。
   */
  const override = process.env.MA_DATA_DIR;
  if (override) return path.resolve(override);
  /*
   * 装好之后数据不能写进安装目录：`resources\data` 在 Program Files 下是只读的，
   * 而且升级一次就会被覆盖。所以第一次启动把随包的**种子**（只有 vocab / views）
   * 复制到 `userData/data`，之后一直读写那一份 —— 和 config.json 同一个家。
   */
  if (app.isPackaged) {
    const target = path.join(app.getPath('userData'), 'data');
    const seed = path.join(process.resourcesPath, 'data');
    try {
      if (!fs.existsSync(target)) fs.cpSync(seed, target, { recursive: true });
      return target;
    } catch (err) {
      // 复制失败（权限 / 磁盘）：退回只读的种子目录，至少能起来；写盘会在别处报错
      console.error('[data] 种子复制失败，暂用只读目录：', err);
      return seed;
    }
  }
  return path.join(app.getAppPath(), 'data');
}

function migrate(db: Database.Database) {
  const current = db.pragma('user_version', { simple: true }) as number;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    });
    run();
    console.log(`[db] migrated → v${m.version} ${m.name}`);
  }
}

export function openDb(): DbHandle {
  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'atlas.db');

  const db = new Database(dbPath);
  // 同步 API 会阻塞主进程，靠 WAL + NORMAL 把写延迟压到最低
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  return { db, dbPath, dataDir };
}
