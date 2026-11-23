import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHORD_SYMBOLS,
  loadChordSymbols,
  saveChordSymbols,
} from '../src/main/ipc/chords.ts';

const clone = (x) => JSON.parse(JSON.stringify(x));
const fresh = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-chords-'));
  return dir;
};

test('默认词表与 data/vocab/chord-symbols.json 的后缀顺序一致', () => {
  const file = JSON.parse(fs.readFileSync(new URL('../data/vocab/chord-symbols.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    file.qualities.map((q) => q.suffix),
    DEFAULT_CHORD_SYMBOLS.qualities.map((q) => q.suffix)
  );
});

test('保存：新增性质 / 变音记号能落盘，note 不丢', () => {
  const dir = fresh();
  try {
    const doc = clone(DEFAULT_CHORD_SYMBOLS);
    doc.note = '测试说明';
    doc.qualities.push({ suffix: '7♯9', label: '属七升九', aliases: ['7#9'] });
    doc.accidentals.push({ sign: '♮', label: '还原' });
    const res = saveChordSymbols(dir, doc);
    assert.equal(res.ok, true, res.error);
    const round = loadChordSymbols(dir);
    assert.equal(round.note, '测试说明');
    assert.ok(round.qualities.some((q) => q.suffix === '7♯9'));
    assert.ok(round.accidentals.some((a) => a.sign === '♮'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('新增的空白行不挡住保存：完全空白的性质 / 变音记号按跳过处理', () => {
  const dir = fresh();
  try {
    const doc = clone(DEFAULT_CHORD_SYMBOLS);
    const qCount = doc.qualities.length;
    const aCount = doc.accidentals.length;
    doc.qualities.push({ suffix: '', label: '', primary: false, aliases: [] });
    doc.accidentals.push({ sign: '', label: '' });
    const res = saveChordSymbols(dir, doc);
    assert.equal(res.ok, true, res.error);
    const round = loadChordSymbols(dir);
    assert.equal(round.qualities.length, qCount);
    assert.equal(round.accidentals.length, aCount);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('只填一半的行仍然报错，并带行号', () => {
  const dir = fresh();
  try {
    const doc = clone(DEFAULT_CHORD_SYMBOLS);
    doc.qualities.push({ suffix: 'x9', label: '', primary: false, aliases: [] });
    const res = saveChordSymbols(dir, doc);
    assert.equal(res.ok, false);
    assert.match(res.error, /第 \d+ 行性质缺少说明文字/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('性质顺序原样保存 / 读回（补全顺序就是数组顺序）', () => {
  const dir = fresh();
  try {
    const doc = clone(DEFAULT_CHORD_SYMBOLS);
    const i = doc.qualities.findIndex((q) => q.suffix === '7sus4');
    const j = doc.qualities.findIndex((q) => q.suffix === '7♭9');
    [doc.qualities[i], doc.qualities[j]] = [doc.qualities[j], doc.qualities[i]];
    const res = saveChordSymbols(dir, doc);
    assert.equal(res.ok, true, res.error);
    const round = loadChordSymbols(dir);
    assert.deepEqual(round.qualities.map((q) => q.suffix), doc.qualities.map((q) => q.suffix));
    assert.ok(round.qualities.findIndex((q) => q.suffix === '7♭9') < round.qualities.findIndex((q) => q.suffix === '7sus4'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('别名撞上任何性质后缀时拒绝保存（不静默产生两种矛盾写法）', () => {
  const dir = fresh();
  try {
    const doc = clone(DEFAULT_CHORD_SYMBOLS);
    doc.qualities.push({ suffix: 'foo', label: 'foo', aliases: ['bar'] });
    doc.qualities.push({ suffix: 'bar', label: 'bar' });
    const res = saveChordSymbols(dir, doc);
    assert.equal(res.ok, false);
    assert.match(res.error, /别名和性质后缀重名/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('调用方没给 note 时沿用旧文件里的说明，不擦掉', () => {
  const dir = fresh();
  try {
    const first = clone(DEFAULT_CHORD_SYMBOLS);
    first.note = '保留我';
    assert.equal(saveChordSymbols(dir, first).ok, true);
    const second = clone(DEFAULT_CHORD_SYMBOLS);
    delete second.note;
    assert.equal(saveChordSymbols(dir, second).ok, true);
    assert.equal(loadChordSymbols(dir).note, '保留我');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
