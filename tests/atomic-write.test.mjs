import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from '../src/main/atomic-write.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miyako-atomic-'));
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

test('原子写：临时文件不以 .json 结尾（不会被 seed / 索引当成档案）', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'b.json');
  const origRename = fs.renameSync;
  let seenTmp = '';
  fs.renameSync = (from, to) => {
    seenTmp = String(from);
    return origRename(from, to);
  };
  try {
    writeFileAtomic(f, 'x');
  } finally {
    fs.renameSync = origRename;
  }
  assert.ok(seenTmp.endsWith('.tmp'));
  assert.equal(path.dirname(seenTmp), dir);
});

test('原子写：目录不存在时抛错，且不影响任何文件', () => {
  const dir = tmpDir();
  assert.throws(() => writeFileAtomic(path.join(dir, 'nope', 'c.json'), 'x'));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('原子写：rename 一直被占用（EPERM）时退回直接覆盖，修改不丢、临时文件清掉', () => {
  const dir = tmpDir();
  const f = path.join(dir, 'd.json');
  fs.writeFileSync(f, 'old');
  const origRename = fs.renameSync;
  fs.renameSync = () => {
    const e = new Error('busy');
    e.code = 'EPERM';
    throw e;
  };
  try {
    writeFileAtomic(f, 'new');
  } finally {
    fs.renameSync = origRename;
  }
  assert.equal(fs.readFileSync(f, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['d.json']);
});
