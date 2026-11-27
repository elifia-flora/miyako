/**
 * 原子写盘：先写同目录下的临时文件并刷到磁盘，再一次 rename 盖过去，最后把目录也刷盘。
 *
 * 为什么需要它：`data/tracks/*.json`、`data/vocab/*.json` 这些是**源**，数据库只是缓存。
 * 直接 `writeFileSync` 写到一半时断电 / 崩溃 / 被杀进程，留下的是半截 JSON ——
 * 下次启动 seed 读不出来，这首曲目就从库里消失了。
 *
 * 保证（按顺序）：
 * 1. **临时文件名唯一**：`.<原名>.<pid>.<12 位随机十六进制>.tmp`，并用 `wx`（独占创建）打开 ——
 *    万一撞名直接报错重来，不会两次写入共用一个临时文件。不以 `.json` 结尾，seed / 索引不会把它当档案。
 * 2. **内容落盘**：写完对临时文件 `fsync`，再 rename。否则断电后可能「改名生效了、内容还在页缓存里」，
 *    得到一个长度对但全是 0 的文件。
 * 3. **替换是原子的**：同一卷上的 rename，读者只会看到旧文件或新文件。Windows 上 Node 用
 *    `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`，目标存在也能替换；但目标被杀毒 / 索引 / 同步盘短暂占用时
 *    会报 EPERM / EBUSY / EACCES —— 这里按递增间隔重试（合计约 1 秒）。
 *    **仍然失败就抛错，绝不退回「直接覆盖原文件」**：那样会把原子性丢掉，正好重新引入要防的半截文件。
 *    原文件保持原样、临时文件清掉；调用方都会记日志 / 把错误报给界面，曲目 JSON 下一次写回时会从库里整份重建。
 * 4. **改名本身落盘**（POSIX）：rename 后对所在目录 `fsync`，否则断电后目录项可能还指向旧文件。
 *    Windows 不支持打开目录做 fsync（NTFS 的元数据日志负责这件事），这一步在 Windows 上跳过；
 *    某些文件系统（网络盘等）不支持目录 fsync，同样静默跳过 —— 此时新内容已经在磁盘上，只是目录项的持久性靠文件系统自己。
 *
 * 不保证：保留原文件的权限位 / 所有者 / ACL（新文件按默认权限创建）；跨卷（临时文件与目标永远在同一目录，不会跨卷）。
 *
 * 纯 Node 实现、不依赖 Electron，`node --test` 可以直接跑（见 tests/atomic-write.test.mjs）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Windows 上「文件被别的进程短暂占用」的几种错误码 */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** 每次重试前等多久（毫秒），合计约 1 秒 */
const RETRY_DELAYS = [10, 30, 60, 100, 200, 300, 300];

/** 同步睡一小会儿：主进程的写盘都是同步调用，只在 rename 被占用时才会走到 */
function pause(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 没有 SharedArrayBuffer 的环境：不等了，直接重试 */
  }
}

function tmpNameFor(file) {
  const rand = crypto.randomBytes(6).toString('hex');
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${rand}.tmp`);
}

function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* 已经不在了 / 删不掉：不影响原文件 */
  }
}

/** rename 之后把目录项刷盘（POSIX）。失败不影响结果：内容已经在磁盘上了 */
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  let fd = -1;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* EINVAL / ENOTSUP / EISDIR：这个文件系统不支持目录 fsync */
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 写临时文件并 fsync；撞名（EEXIST）换个名字再来，最多 3 次 */
function writeTemp(file, bytes) {
  for (let attempt = 0; ; attempt++) {
    const tmp = tmpNameFor(file);
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx');
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'EEXIST' && attempt < 2) continue;
      throw err;
    }
    try {
      let off = 0;
      while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
      fs.fsyncSync(fd);
    } catch (err) {
      fs.closeSync(fd);
      unlinkQuiet(tmp);
      throw err;
    }
    fs.closeSync(fd);
    return tmp;
  }
}

/**
 * @param {string} file 目标文件（绝对路径）
 * @param {string | Uint8Array} data 内容；字符串按 utf8 写
 * @throws 写临时文件失败，或 rename 在重试之后仍然失败。抛错时原文件保持原样。
 */
export function writeFileAtomic(file, data) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const tmp = writeTemp(file, bytes);

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      break;
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (BUSY_CODES.has(code) && attempt < RETRY_DELAYS.length) {
        pause(RETRY_DELAYS[attempt]);
        continue;
      }
      unlinkQuiet(tmp);
      throw err;
    }
  }

  fsyncDir(path.dirname(file));
}
