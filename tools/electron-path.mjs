#!/usr/bin/env node
/**
 * 找 Electron 可执行文件 —— 一条规则，三个启动器（`launch.mjs` / `smoke.mjs` / `start.py`）共用。
 *
 * ## 为什么不能硬编码 `node_modules/electron/dist/electron.exe`
 *
 * Electron 42 起，npm 包**不再在 postinstall 里下载二进制**：`npm install` 之后
 * `node_modules/electron/` 里只有 `index.js` / `install.js` / `checksums.json`，
 * `dist/` 目录要到**第一次真正运行**时才由 `electron` 包现下（约 100MB）。
 *
 * 于是"硬编码路径"在**别人的机器上/全新 clone 上**必然 ENOENT —— 而我们自己这台机器
 * 因为早就在用，`dist/` 一直在，看不出问题。这类"只在我这儿能跑"的坑最难查。
 *
 * 这里的做法很直白：有就用，没有就**当场把它下下来**（一次性的），下不来给一句人话错误。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureIntegrity } from './fix-integrity.mjs';

/**
 * 每次启动前检查一次工作区完整性标签。
 *
 * 为什么放在这里：`launch.mjs` / `smoke.mjs` 都会经过 `electronExe()`，而
 * **Low Mandatory Level 下 Electron 44 会崩在 JS 之前**（没有 logs/boot.log，
 * 看起来像「应用本身坏了」）。检查一次约几十毫秒，修完整个会话都安全。
 * `start.cmd` 走的是自己的路径，所以那边也有一份同样的预检。
 */
let integrityChecked = false;
function preflightIntegrity(root) {
  if (integrityChecked || process.platform !== 'win32') return;
  integrityChecked = true;
  const r = ensureIntegrity({ root, quiet: true });
  if (!r.ok) {
    console.error(
      '[electron] 工作区仍是 Low Mandatory Level：Electron 44 会秒退。' +
        ' 请双击 tools\\fix-integrity.cmd（在 DSH 之外）后再试。'
    );
  }
}

/**
 * @param {string} root 仓库根目录
 * @returns {string} electron 可执行文件的绝对路径
 */
export function electronExe(root) {
  preflightIntegrity(root);

  const pkgDir = path.join(root, 'node_modules', 'electron');
  const exe = path.join(pkgDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

  if (fs.existsSync(exe)) return exe;

  const installer = path.join(pkgDir, 'install.js');
  if (!fs.existsSync(installer)) {
    throw new Error(
      `[electron] 找不到 ${path.relative(root, exe)}，也没找到 install.js —— 先跑一次 npm install`
    );
  }

  console.log('[electron] 二进制还没下载（Electron 42+ 改成按需下载），现在下（一次性，约 100MB）…');
  const r = spawnSync(process.execPath, [installer], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(exe)) {
    throw new Error(
      '[electron] 下载失败。检查网络 / 代理，或手动跑 `node node_modules/electron/install.js` 再试。'
    );
  }
  return exe;
}
