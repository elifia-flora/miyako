/**
 * 原子写盘：先写同目录下的临时文件、刷到磁盘，再一次 rename 盖过去。
 *
 * 为什么需要它：`data/tracks/*.json`、`data/vocab/*.json` 这些是**源**，数据库只是缓存。
 * 直接 `writeFileSync` 写到一半时断电 / 崩溃 / 被杀进程，留下的是半截 JSON ——
 * 下次启动 seed 读不出来，这首曲目就从库里消失了。rename 在同一个卷上是原子的：
 * 读者要么看到旧文件，要么看到新文件，看不到中间状态。
 *
 * Windows 上目标文件被别的程序（杀毒、编辑器预览、同步盘）短暂占用时 rename 会报
 * EPERM / EBUSY / EACCES：先重试几次；还不行就退回直接覆盖写 —— 宁可失去原子性，
 * 也不能让用户的这次修改丢掉。临时文件在任何分支都会被清理。
 *
 * 纯 Node 实现、不依赖 Electron，`node --test` 可以直接跑（见 tests/atomic-write.test.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRIES = 3;

let seq = 0;

/** 同步睡一小会儿（只在 rename 被占用时用，最多几十毫秒） */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 没有 SharedArrayBuffer 的环境：不等了，直接重试 */
  }
}

/**
 * @param {string} file 目标文件（绝对路径）
 * @param {string | Uint8Array} data 内容；字符串按 utf8 写
 */
export function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${(seq++).toString(36)}.tmp`);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    // 先落盘再 rename：否则断电后可能 rename 生效了、内容却还在页缓存里没写下去
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件清不掉也不影响原文件 */
    }
    throw err;
  }
  fs.closeSync(fd);

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (RETRY_CODES.has(code) && attempt < RETRIES) {
        pause(15 * (attempt + 1));
        continue;
      }
      if (RETRY_CODES.has(code)) {
        // 被占着改不了名：退回直接覆盖（失去原子性，但不丢这次修改）
        try {
          fs.writeFileSync(file, bytes);
          return;
        } finally {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* ignore */
          }
        }
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}
