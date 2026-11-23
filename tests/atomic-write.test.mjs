import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/main/atomic-write.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-atomic-'));
}

/** 临时替换 fs 上的某个同步函数，跑完还原 */
function withPatched(name, impl, fn) {
  const orig = fs[name];
  fs[name] = (...args) => impl(orig, ...args);
  try {
    return fn();
  } finally {
    fs[name] = orig;
  }
}

function busy(code = 'EPERM') {
  const e = new Error(code);
  e.code = code;
  return e;
}

test('原子写：新建文件，内容按 utf8 写入', () => {
  const dir = tmpDir();
  const f = path.join(dir, '神鹿谣.json');
  writeFileAtomic(f, '{"title":"神鹿谣"}\n');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"title":"神鹿谣"}\n');
});

test('原子写：覆盖旧文件，不留临时文件', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.json');
  fs.writeFileSync(f, 'old');
  writeFileAtomic(f, 'new');
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['a.json']);
});

test('原子写：rename 之前临时文件已经 fsync（断电后不会出现「改名生效、内容没落盘」）', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'sync.json');
  const order = [];
  withPatched('fsyncSync', (orig, fd) => (order.push('fsync'), orig(fd)), () =>
    withPatched('renameSync', (orig, a, b) => (order.push('rename'), orig(a, b)), () => writeFileAtomic(f, 'x'))
  );
  assert.ok(order.indexOf('fsync') >= 0 && order.indexOf('fsync') < order.indexOf('rename'), order.join(','));
  if (process.platform !== 'win32') {
    // POSIX：rename 之后还要把目录刷一次
    assert.equal(order.at(-1), 'fsync', order.join(','));
  }
});

test('原子写：临时文件名唯一、独占创建，且不以 .json 结尾（不会被 seed / 索引当成档案）', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'b.json');
  const tmps = [];
  const flags = [];
  withPatched('openSync', (orig, p, flag, ...rest) => {
    if (String(p).endsWith('.tmp')) flags.push(flag);
    return orig(p, flag, ...rest);
  }, () =>
    withPatched('renameSync', (orig, from, to) => (tmps.push(String(from)), orig(from, to)), () => {
      for (let i = 0; i < 20; i++) writeFileAtomic(f, String(i));
    })
  );
  assert.equal(new Set(tmps).size, 20);
  for (const t of tmps) {
    assert.ok(t.endsWith('.tmp'));
    assert.equal(path.dirname(t), dir);
    assert.ok(path.basename(t).includes(`.${process.pid}.`));
  }
  assert.ok(flags.every((fl) => fl === 'wx'), flags.join(','));
  assert.equal(fs.readFileSync(f, 'utf8'), '19');
});

test('原子写：目录不存在时抛错，且不影响任何文件', () => {
  const dir = tmpDir();
  assert.throws(() => writeFileAtomic(path.join(dir, 'nope', 'c.json'), 'x'));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('原子写：rename 短暂被占用（EPERM / EBUSY）时重试，成功后内容正确', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'retry.json');
  fs.writeFileSync(f, 'old');
  let calls = 0;
  withPatched('renameSync', (orig, a, b) => {
    calls++;
    if (calls === 1) throw busy('EPERM');
    if (calls === 2) throw busy('EBUSY');
    return orig(a, b);
  }, () => writeFileAtomic(f, 'new'));
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['retry.json']);
});

test('原子写：rename 一直被占用时抛错 —— 原文件保持原样（不退回非原子覆盖），临时文件清掉', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'd.json');
  fs.writeFileSync(f, 'old');
  let writesToTarget = 0;
  assert.throws(
    () =>
      withPatched('writeFileSync', (orig, p, ...rest) => {
        if (p === f) writesToTarget++;
        return orig(p, ...rest);
      }, () =>
        withPatched('renameSync', () => {
          throw busy('EPERM');
        }, () => writeFileAtomic(f, 'new'))
      ),
    /EPERM/
  );
  assert.equal(writesToTarget, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['d.json']);
});

test('原子写：非「占用」类的 rename 错误不重试，直接抛', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'e.json');
  let calls = 0;
  assert.throws(
    () =>
      withPatched('renameSync', () => {
        calls++;
        throw busy('EXDEV');
      }, () => writeFileAtomic(f, 'x')),
    /EXDEV/
  );
  assert.equal(calls, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('原子写：写临时文件中途失败（如磁盘满）时抛错，原文件不动、临时文件清掉', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'g.json');
  fs.writeFileSync(f, 'old');
  assert.throws(
    () =>
      withPatched('writeSync', () => {
        throw busy('ENOSPC');
      }, () => writeFileAtomic(f, 'new')),
    /ENOSPC/
  );
  assert.equal(fs.readFileSync(f, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['g.json']);
});
