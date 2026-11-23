#!/usr/bin/env node
/**
 * 检查 / 修复工作区的 **Low Mandatory Level**（低完整性标签）。
 *
 * ## 为什么需要这个工具
 *
 * DSH 的 `workspace-write` 沙箱会把工作区目录打上 Low 完整性标签，并给受限进程发一个
 * Low 令牌。Electron 32 能忍，Electron 44 / Chromium 152 的浏览器进程沙箱**不接受**这种
 * 目录 —— 表现是双击后窗口秒退、退出码 `0x80000003`（`STATUS_BREAKPOINT`），
 * `logs/boot.log` 一条都没有（崩在 JS 之前，看起来像「应用坏了」）。
 *
 * 更麻烦的是：**切回完全权限并不会把已经打上的 Low 标签去掉**。必须显式把
 * 根目录 / `node_modules/electron` / `out` 设回 Medium。这个脚本就是那三行 `icacls`
 * 的可重复执行版本：
 *
 *   node tools/fix-integrity.mjs            # 检查 + 需要时修复（人读的输出）
 *   node tools/fix-integrity.mjs --quiet    # 只在修复/失败时说话（启动器用）
 *   node tools/fix-integrity.mjs --path D:\some\dir
 *
 * 双击入口是 `tools/fix-integrity.cmd`。
 *
 * ## 设计上的两个约束
 *
 * 1. **幂等**：全都是 Medium 时只检查、不写 ACL，正常启动不会每次改权限。
 * 2. **失败要人话**：受限令牌下可能没有 `WRITE_DAC`，修复会失败；这时必须明确说
 *    「在 DSH 之外双击 fix-integrity.cmd」，而不是让 Electron 继续秒退。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

/**
 * `icacls` 在中文 Windows 上按 OEM/ANSI 代码页输出。先按 UTF-8 解，出现替换字符
 * 再用 GBK 兜底 —— 否则「低强制级别」会变成乱码，`Low` 也匹配不上。
 */
function decode(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * 跑一次 `icacls` 并把输出收进临时文件，而不是走 stdout 管道。
 *
 * 为什么不用默认的 `stdio: 'pipe'`：DSH 的受限进程打不开命名管道，
 * `spawnSync(..., { stdio: 'pipe' })` 会直接 EPERM —— 而我们要修的
 * **正是** workspace-write 留下的标签，不能在最需要它的场景里失效。
 * 文件句柄（`stdio: [..., fd, fd]`）不受这条限制。
 */
function runIcacls(args) {
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-icacls-'));
    const out = path.join(dir, 'out.txt');
    const fd = fs.openSync(out, 'w');
    let r;
    try {
      r = spawnSync('icacls', args, { windowsHide: true, stdio: ['ignore', fd, fd] });
    } finally {
      fs.closeSync(fd);
    }
    if (r.error) return { ok: false, status: -1, text: String(r.error) };
    let text = '';
    try {
      text = decode(fs.readFileSync(out));
    } catch {
      /* 输出文件没写成：下面按失败处理 */
    }
    return { ok: r.status === 0, status: r.status ?? -1, text };
  } catch (e) {
    return { ok: false, status: -1, text: String(e) };
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 临时目录清不掉也不影响结果 */
      }
    }
  }
}

/**
 * 读一个路径的完整性标签。
 * @returns {{ level: 'low'|'medium'|'other'|'missing'|'unknown'|'unsupported', line: string, error?: string }}
 */
export function readIntegrity(target) {
  if (process.platform !== 'win32') return { level: 'unsupported', line: '' };
  if (!fs.existsSync(target)) return { level: 'missing', line: '' };

  const r = runIcacls([target]);
  if (!r.ok) return { level: 'unknown', line: r.text.trim(), error: r.text.trim() };

  // 只认带 Mandatory 的那一行：普通 ACE 行里也可能出现 Low/Medium 之类的英文单词。
  const line =
    r.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /Mandatory|强制|完整性标签/i.test(l)) ?? '';

  if (!line) return { level: 'unknown', line: '' };
  if (/\bLow\b|低/.test(line)) return { level: 'low', line };
  if (/\bMedium\b|中/.test(line)) return { level: 'medium', line };
  return { level: 'other', line };
}

/**
 * 把目录/文件设回 Medium。
 * - 目录用 `(OI)(CI)Medium`，新生成的文件继续继承；
 * - `recursive` 给 `out/` 这种**已经存在**的构建产物用（`/T`）；
 * - 文件直接 `Medium`（没有继承标志）。
 */
export function setIntegrity(target, { recursive = false, file = false } = {}) {
  if (process.platform !== 'win32') return { ok: true, text: '' };
  const level = file ? 'Medium' : '(OI)(CI)Medium';
  const args = [target, '/setintegritylevel', level];
  if (recursive) args.push('/T');
  return runIcacls(args);
}

function targetsFor(root) {
  return [
    { key: 'root', label: '仓库根目录', path: root, recursive: false, file: false, required: true },
    {
      key: 'electron',
      label: 'node_modules/electron',
      path: path.join(root, 'node_modules', 'electron'),
      recursive: false,
      file: false,
      required: false,
    },
    {
      key: 'exe',
      label: 'electron.exe',
      path: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      recursive: false,
      file: true,
      required: false,
    },
    {
      key: 'out',
      label: 'out',
      path: path.join(root, 'out'),
      recursive: true,
      file: false,
      required: false,
    },
  ];
}

/**
 * 检查 +（可选）自动修复。
 *
 * @param {{ root?: string, quiet?: boolean, autoFix?: boolean }} opts
 * @returns {{ ok: boolean, repaired: string[], remaining: string[], targets: Array<Record<string, unknown>> }}
 */
export function ensureIntegrity({ root = DEFAULT_ROOT, quiet = false, autoFix = true } = {}) {
  if (process.platform !== 'win32') {
    return { ok: true, repaired: [], remaining: [], targets: [] };
  }

  const targets = targetsFor(root).filter((t) => fs.existsSync(t.path) || t.required);
  if (!fs.existsSync(root)) {
    const msg = `[integrity] 找不到工作区：${root}`;
    if (quiet) console.error('[integrity] workspace not found: ' + root);
    else console.error(msg);
    return { ok: false, repaired: [], remaining: ['root'], targets: [] };
  }

  const readAll = () => targets.map((t) => ({ ...t, state: readIntegrity(t.path) }));
  let rows = readAll();
  const low = rows.filter((r) => r.state.level === 'low');

  if (low.length === 0) {
    if (!quiet) {
      const summary = rows
        .map((r) => `${r.label}=${r.state.level}`)
        .join(' · ');
      console.log(`[integrity] 全部正常（${summary}）`);
    }
    return { ok: true, repaired: [], remaining: [], targets: rows };
  }

  const names = low.map((r) => r.label).join('、');
  if (quiet) console.log(`[integrity] Low Mandatory Level found: ${names}; repairing...`);
  else console.warn(`[integrity] 发现 Low 完整性标签：${names} —— Electron 44 会秒退，开始修复…`);

  const repaired = [];
  if (autoFix) {
    for (const r of low) {
      const res = setIntegrity(r.path, { recursive: r.recursive, file: r.file });
      if (res.ok) repaired.push(r.label);
      else if (!quiet) {
        console.error(`[integrity] 修复 ${r.label} 失败：${res.text.trim().slice(0, 500)}`);
      }
    }
    // 给 icacls 一点落盘时间；紧接着再读一次才是真实结果。
    rows = readAll();
  }

  const remaining = rows.filter((r) => r.state.level === 'low').map((r) => r.label);
  const ok = remaining.length === 0;

  if (ok) {
    if (quiet) console.log(`[integrity] repaired: ${repaired.join(', ') || 'ok'}`);
    else console.log(`[integrity] 已修复为 Medium：${repaired.join('、') || '（无需改动）'}`);
  } else {
    if (quiet) {
      console.error(`[integrity] Low label REMAINS on: ${remaining.join(', ')}`);
      console.error('[integrity] run tools\\fix-integrity.cmd outside DSH (or from a full-access session)');
    } else {
      console.error(`[integrity] 仍为 Low：${remaining.join('、')}`);
      console.error('[integrity] 请在 DSH 之外双击 tools\\fix-integrity.cmd（或用完全权限会话）再试。');
    }
  }

  return { ok, repaired, remaining, targets: rows };
}

/* ------------------------------ CLI ------------------------------ */

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  const quiet = argv.includes('--quiet') || argv.includes('--auto');
  const pi = argv.indexOf('--path');
  const root = pi >= 0 && argv[pi + 1] ? path.resolve(argv[pi + 1]) : DEFAULT_ROOT;
  const result = ensureIntegrity({ root, quiet });
  process.exitCode = result.ok ? 0 : 1;
}
