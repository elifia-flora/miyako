#!/usr/bin/env node
/**
 * 打 Windows 包，并签上 CN=elifia-flora。
 *
 * 已设置 WIN_CSC_LINK（正式证书或自己的 pfx）时沿用，不再造自签名。
 * 没设置时跑 tools/win-sign-cert.ps1，把 pfx 交给 electron-builder 的 WIN_CSC_LINK。
 * 不用 CSC_LINK：那条是 macOS 证书的通道，塞进 Windows 签名会签错。
 *
 * electron-vite 的编译由 package.json 的 dist:win 先做完。额外参数会传给
 * electron-builder，例如 `node tools/dist-win.mjs --dir`。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function runInherit(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const env = { ...process.env };

if (!env.WIN_CSC_LINK) {
  const ps = path.join(root, 'tools', 'win-sign-cert.ps1');
  const minted = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], env);
  if (minted.code !== 0) {
    process.exit(minted.code);
  }
  const pfx = minted.stdout.match(/^PFX=(.+)$/m)?.[1]?.trim();
  const password = minted.stdout.match(/^PASSWORD=(.+)$/m)?.[1]?.trim();
  if (!pfx || !password) {
    console.error('win-sign-cert.ps1 没有给出 PFX 路径');
    process.exit(1);
  }
  env.WIN_CSC_LINK = pfx;
  env.CSC_KEY_PASSWORD = password;
}

const code = await runInherit(
  process.execPath,
  [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--publish', 'never', ...process.argv.slice(2)],
  env,
);
process.exit(code);
