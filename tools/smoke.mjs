#!/usr/bin/env node
/**
 * 冒烟启动器：清掉 ELECTRON_RUN_AS_NODE 后启动 Electron，等主进程自行截图退出。
 * Windows 上终端/编辑器常注入 ELECTRON_RUN_AS_NODE=1，那会让 electron.exe 变成纯 Node。
 *
 * ## 为什么不再 taskkill 日常窗口
 *
 * 以前跑冒烟会先 `taskkill /F /IM electron.exe`，跑完还得你自己再双击一次 ——
 * 「测试」变成一件会打断你手头事情的动作。现在**彻底隔离**，两边互不打扰：
 *
 * | 维度 | 冒烟实例 | 你的窗口 |
 * |---|---|---|
 * | userData（单实例锁/主题/选项） | `.smoke-profile/` | 默认 userData |
 * | 数据目录（库 / tracks / vocab） | `.smoke-data/`（`data/` 的副本） | `data/` |
 *
 * 单实例锁是按 userData 分的，profile 不同就能并存；数据各一份，
 * 冒烟里登记的临时曲目、被改掉的偏移、被改写的词表 JSON 全都留在副本里。
 * 代价只有一次 `data/` 复制（1.6MB，几十毫秒）。
 *
 * 复制时把 `atlas.db` 和它的 `-wal` / `-shm` 一起带上：日常窗口可能正开着库，
 * 只拷主文件会漏掉 WAL 里还没 checkpoint 的改动。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { electronExe } from './electron-path.mjs';

const root = path.resolve(import.meta.dirname, '..');

// 同 launch.mjs：Electron 42+ 的二进制按需下载，别硬编码 dist 路径
const exe = electronExe(root);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// 同上：环境里的 fs 安全删除 shim 不该进到被测应用里
delete env.NODE_OPTIONS;

/**
 * `--quiet` = 只打 FAIL 和汇总（主进程读 `MA_SMOKE_QUIET`）。
 * 为什么用启动器开关而不是让用户手敲环境变量：Windows 的 cmd / PowerShell
 * 没有 `MA_SMOKE_QUIET=1 npm run smoke` 这种写法，跨两个 shell 都是坑。
 * 完整 PASS/FAIL 清单仍会写 `shots/smoke-report.txt`，要查随时能查。
 */
const QUIET = process.argv.includes('--quiet') || process.env.MA_SMOKE_QUIET === '1';
if (QUIET) env.MA_SMOKE_QUIET = '1';

/**
 * 可选 CDP：`node tools/smoke.mjs --debug` 或 `MA_DEBUG_PORT=9333`。
 * 冒烟窗口默认全透明，配合 `MA_SMOKE_VISIBLE=1` 才能肉眼看画面。
 */
const debugPort = String(
  process.env.MA_DEBUG_PORT || (process.argv.includes('--debug') ? '9222' : '')
).trim();
if (debugPort && !/^\d+$/.test(debugPort)) {
  console.error(`[smoke] MA_DEBUG_PORT 不是数字：${debugPort}`);
  process.exit(1);
}

/* ---- 1) 准备一份数据副本（**一个文件都不删**） ---- */
const realData = path.join(root, 'data');

/**
 * 给冒烟分配一份**编号副本**：`.smoke-data`、`.smoke-data-2`、`.smoke-data-3`…
 *
 * 历史：一开始是「先递归删掉旧的，再拷一份」—— 这个受控环境里 `fs.rmSync` 每次都要
 * 弹授权框，跑一轮弹三五次，比测试本身还烦；于是改成「只加不删」。结果是跑几十轮之后
 * 根目录里堆了 77 份 `.smoke-data-*` + 77 份 `.smoke-profile-*`（约 1.5GB），
 * 找文档都得先滚过一屏垃圾（用户 2026-11-08 的原话）。
 *
 * 现在的规矩：**每种最多留 3 份**（用户定的）。超出就把最旧的那份删掉，用它腾出来的
 * 编号。删除只发生在 `.smoke-data*` / `.smoke-profile*` 里，且永远是「最旧的一份」——
 * 不认外部路径、不碰别的任何东西。
 */
const KEEP_COPIES = 3;

/** 按修改时间从旧到新列出某一族的副本（`base` 与 `base-N`） */
function copiesOf(base) {
  const dir = path.dirname(base);
  const stem = path.basename(base);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (d.name === stem || d.name.startsWith(`${stem}-`)))
    .map((d) => {
      const p = path.join(dir, d.name);
      return { name: d.name, path: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime);
}

/**
 * 找一个能用的编号目录，并把总量压在 `KEEP_COPIES` 份以内。
 * 删不掉（被占用 / 权限）就退化成「往后加数字」—— 测试照跑，只是这份留着下次清。
 */
function freeDir(base) {
  let copies = copiesOf(base);
  while (copies.length >= KEEP_COPIES) {
    const oldest = copies[0];
    try {
      fs.rmSync(oldest.path, { recursive: true, force: true });
      console.log(`[smoke] 轮转：删掉最旧的 ${oldest.name}`);
      copies = copiesOf(base);
    } catch (e) {
      console.warn(`[smoke] 轮转失败（${oldest.name} 删不掉，继续往后加编号）：${e.message}`);
      break;
    }
  }
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const p = `${base}-${i}`;
    if (!fs.existsSync(p)) return p;
  }
  throw new Error(`[smoke] ${base}-N 都被占满了，先跑一次 clean-junk.cmd 再试`);
}

const smokeData = freeDir(path.join(root, '.smoke-data'));
const smokeProfile = freeDir(path.join(root, '.smoke-profile'));
fs.cpSync(realData, smokeData, { recursive: true });
env.MA_DATA_DIR = smokeData;
console.log(`[smoke] 本次使用 ${path.basename(smokeData)} / ${path.basename(smokeProfile)}`);

/**
 * 注入两份**同名、没有 uuid** 的老档案（schema v2）。
 *
 * 这是「标题一样的音乐很多」那个隐患的复现条件：老档案身份靠标题哈希，
 * 两份同名会算出同一个 id，第二份被 seed 静默跳过（列表里少一首）。
 * 主进程启动时会导入它们，冒烟在开头断言「两份都在、id 不同、后来那份拿到新 uuid」
 * 就立刻清掉 —— 后面的断言仍然面对用户的真实曲库。
 */
const legacyTitle = '冒烟同名·秋';
const tracksDir = path.join(smokeData, 'tracks');
for (const n of [1, 2]) {
  const doc = {
    schemaVersion: 2,
    title: { original: legacyTitle },
    basic: { meter: '4/4', bpm: 96 },
  };
  fs.writeFileSync(path.join(tracksDir, `冒烟同名 ${n}.json`), JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

/**
 * 预置一份**工作区预设**（`workspaces.json`），模拟「上次手动存过、这次重新启动」。
 *
 * 为什么在启动器里写而不是让冒烟自己 save：要验的是**启动路径**——
 * 磁盘上有 → 启动后菜单里就得能看到。如果只是会话内 save 再 list，
 * 那么「启动时根本没读列表」这种 bug 是查不出来的（而它真的发生过一次）。
 */
fs.mkdirSync(smokeProfile, { recursive: true });
fs.writeFileSync(
  path.join(smokeProfile, 'workspaces.json'),
  JSON.stringify({
    version: 1,
    last: null,
    named: {
      启动预设: {
        v: 1,
        at: Date.now(),
        win: { bounds: { x: 80, y: 60, width: 1200, height: 800 }, maximized: false },
        ui: {
          panelOpen: true,
          panelH: 300,
          leftW: 200,
          rightW: 340,
          uiZoom: 1,
          themeMode: 'dark',
          viewId: 'roman',
          gridZoom: 1,
          gridUnit: 'beat',
        },
        grid: { open: false, bounds: null },
        help: { open: false, bounds: null },
        lyrics: { open: false, bounds: null, alwaysOnTop: true },
      },
    },
  }),
  'utf8'
);

/* ---- 2) 跑冒烟（独立 profile + 独立 data） ---- */
/**
 * 硬超时：冒烟窗口在 `--smoke` 下是**鼠标穿透、不进任务栏**的（主进程 `quietWindow`），
 * 卡住的时候用户点不到关不掉。主进程里有自己的死线，这里再兜一层 ——
 * 主进程根本没起来（白屏、崩溃循环）时，只有启动器能收尸。
 */
const HARD_TIMEOUT_MS = 8 * 60 * 1000;
const args = ['.', '--smoke', `--user-data-dir=${smokeProfile}`];
if (debugPort) {
  args.push(`--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*');
  console.log(`[smoke] CDP：http://127.0.0.1:${debugPort}/json`);
}
if (QUIET) console.log('[smoke] 安静模式：只打 FAIL 和汇总（完整清单写 shots/smoke-report.txt）');
const code = await new Promise((resolve) => {
  const child = spawn(exe, args, {
    cwd: root,
    stdio: 'inherit',
    env,
  });
  const killer = setTimeout(() => {
    console.error(`[smoke] 超过 ${HARD_TIMEOUT_MS / 60000} 分钟还没结束，强制结束`);
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  }, HARD_TIMEOUT_MS);
  child.on('exit', (c) => {
    clearTimeout(killer);
    resolve(c ?? 0);
  });
  child.on('error', (e) => {
    // 以前这里静默 resolve(1)：Electron 根本没起来时，终端只剩一行 [exit code: 1]，
    // 看起来像「冒烟挂了」而不是「启动器没把它拉起来」。错误必须露出来。
    console.error('[smoke] 启动 Electron 失败：', e);
    clearTimeout(killer);
    resolve(1);
  });
});

if (code === 0) {
  const left = copiesOf(path.join(root, '.smoke-data')).length;
  console.log(
    `[smoke] 数据副本留在 ${path.basename(smokeData)}/（不影响 data/）；当前共 ${left} 份，下次跑会自动轮转掉最旧的一份`
  );
}

process.exit(code);
