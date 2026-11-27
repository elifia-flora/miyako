#!/usr/bin/env node
/**
 * `npm run dev` / `npm run start` 的启动器。
 *
 * 为什么不直接 `electron-vite dev|preview`：
 * 编辑器 / 终端（VS Code、WorkBuddy 之类）经常往环境里塞 `ELECTRON_RUN_AS_NODE=1`。
 * 那个变量会让 electron.exe **退化成纯 Node**，于是主进程一行 `app.whenReady()` 都跑不到，
 * 进程立刻退出；VS Code 看到任务结束就显示「终端将被任务重用，已关闭」。
 *
 * 用法：
 *   node tools/dev.mjs            # electron-vite dev
 *   node tools/dev.mjs preview    # electron-vite preview（npm start）
 * 其余参数原样转给 electron-vite。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureIntegrity } from './fix-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const command = argv[0] === 'preview' || argv[0] === 'dev' ? argv[0] : 'dev';
const extra = argv[0] === command ? argv.slice(1) : argv;

const env = { ...process.env };
if (env.ELECTRON_RUN_AS_NODE !== undefined) {
  console.log('[dev] 清掉继承来的 ELECTRON_RUN_AS_NODE（否则 electron 会退化成纯 Node，窗口不会出现）');
  delete env.ELECTRON_RUN_AS_NODE;
}
/**
 * 编辑器常通过 NODE_OPTIONS 注入 `--require ...shim`。那是给命令行用的，
 * 不该进应用：应用自己在写 JSON，被 shim 接管会变慢甚至超时。
 */
if (env.NODE_OPTIONS) {
  console.log('[dev] 清掉继承来的 NODE_OPTIONS（不把编辑器的 require shim 带进应用）');
  delete env.NODE_OPTIONS;
}

/*
 * 整个仓库被打上 Low 完整性标签时，Electron 44 的沙箱不接受 —— 窗口秒退、退出码
 * 0x80000003、日志里一条都没有。修不掉就停在这里，别再去启动一个马上消失的窗口。
 */
const integrity = ensureIntegrity({ root, quiet: true });
if (!integrity.ok) {
  console.error('[dev] 工作区完整性仍是 Low，Electron 起不来。请双击 tools\\fix-integrity.cmd 后再试。');
  process.exit(1);
}

// 直接跑 JS 入口，不要经 .cmd + shell：否则 Node 会警告参数未转义，
// VS Code 的终端里多一行 DeprecationWarning，看着像又失败了。
const cli = path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const child = spawn(process.execPath, [cli, command, ...extra], {
  cwd: root,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
