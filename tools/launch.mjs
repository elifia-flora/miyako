#!/usr/bin/env node
/**
 * 分离启动：把窗口开出去，命令自己立刻退出。
 *
 * 为什么要单独一个脚本：
 *   「跑一个命令把 GUI 打开」如果用普通的前台子进程，命令的父进程一结束
 *   （或被任务管理器收尾），窗口会跟着一起没 —— 表现就是「应用刚开就关了」。
 *   `detached` + `unref()` 让 Electron 落到自己的进程组里，与这个脚本彻底脱钩，
 *   脚本退出后窗口继续活着。
 *
 * 用法：
 *   npm run app          # 推荐
 *   node tools/launch.mjs
 * 日常双击 `start.cmd` / `music·atlas.lnk` 也一样（那条路走的是 start.py）。
 *
 * 注意：Windows 上终端常注入 `ELECTRON_RUN_AS_NODE=1`，它会把 electron.exe
 * 变成纯 Node 进程（窗口永远不出现），所以启动前必须删掉。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { electronExe } from './electron-path.mjs';

const root = path.resolve(import.meta.dirname, '..');

/**
 * 别再硬编码 `node_modules/electron/dist/electron.exe`：
 * Electron 42 起二进制是**按需下载**的，全新 clone 上那个文件一开始并不存在。
 * 统一走 `electron-path.mjs`（没有就当场下）。
 */
const exe = electronExe(root);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
/**
 * 编辑器 / AI 终端常通过 NODE_OPTIONS 注入 `--require ...shim`（把 fs 删除改成回收站）。
 * 那是给命令行用的，不该进到应用里：应用自己就在删/移 JSON 与归档文件，
 * 被那层 shim 接管会变慢甚至超时。启动脚本里摘掉，行为才和用户双击一致。
 */
delete env.NODE_OPTIONS;

/**
 * 可选的 CDP 调试端口。
 *
 *   npm run app:debug                 # = --debug，端口 9222
 *   $env:MA_DEBUG_PORT=9333; npm run app
 *
 * 为什么**不默认开**：9222 上的 CDP 能读页面、发命令；日常只该在需要量
 * 「播放头闪/抖、帧间隔、transform」时打开。`--remote-allow-origins=*`
 * 是 Chromium 对非浏览器 WebSocket 客户端的硬要求，不加连不上。
 */
const passthrough = process.argv.slice(2).filter((a) => a !== '--debug');
const argv = ['.', ...passthrough];
const debugPort = String(
  process.env.MA_DEBUG_PORT || (process.argv.includes('--debug') ? '9222' : '')
).trim();
if (debugPort) {
  if (!/^\d+$/.test(debugPort)) {
    console.error(`[launch] MA_DEBUG_PORT 不是数字：${debugPort}`);
    process.exit(1);
  }
  argv.push(`--remote-debugging-port=${debugPort}`, '--remote-allow-origins=*');
}

const child = spawn(exe, argv, {
  cwd: root,
  detached: true,
  stdio: 'ignore',
  env,
});
child.unref();

console.log(`music·atlas 已启动（pid ${child.pid}），这个命令已经退出，窗口会自己留着。`);
if (debugPort) {
  console.log(`[launch] CDP 已开：http://127.0.0.1:${debugPort}/json`);
  console.log('[launch] 例：npm run smoke:status 的同类探针可直接连这个端口量帧/transform。');
}
