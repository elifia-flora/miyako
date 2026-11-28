import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dropNotice,
  isAudioPath,
  pathKey,
  planAudioImport,
  classifyDroppedPaths,
  splitDroppedPaths,
  titleFromAudioPath,
} from '../src/shared/audiodrop.js';

test('只认音频扩展名，大小写无所谓', () => {
  for (const ext of ['.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.aif']) {
    assert.equal(isAudioPath(`C:/music/a${ext}`), true);
    assert.equal(isAudioPath(`C:/music/a${ext.toUpperCase()}`), true);
  }
  assert.equal(isAudioPath('C:/music/notes.txt'), false);
  assert.equal(isAudioPath('C:/music/cover.jpg'), false);
  assert.equal(isAudioPath('C:/music/track.json'), false);
  assert.equal(isAudioPath('C:/music/noext'), false);
  assert.equal(isAudioPath(''), false);
});

test('拖放按后缀分成音频、图片、歌词和其余', () => {
  const got = classifyDroppedPaths([
    'C:/a.mp3',
    'C:/b.JPG',
    'C:/c.lrc',
    'C:/d.srt',
    'C:/e.txt',
    'C:/a.mp3',
  ]);
  assert.deepEqual(got.audio, ['C:/a.mp3']);
  assert.deepEqual(got.image, ['C:/b.JPG']);
  assert.deepEqual(got.lyric, ['C:/c.lrc', 'C:/d.srt']);
  assert.deepEqual(got.rejected, ['C:/e.txt']);
});

test('曲名去掉扩展名，空名才用后备', () => {
  assert.equal(titleFromAudioPath('D:\\唱片\\神鹿谣.flac'), '神鹿谣');
  assert.equal(titleFromAudioPath('/Users/me/Music/One of These Nights.mp3'), 'One of These Nights');
  assert.equal(titleFromAudioPath('.flac', '未命名作品'), '.flac');
  assert.equal(titleFromAudioPath('', '未命名作品'), '未命名作品');
});

test('拖入列表：非音频分开，同一路径只留一份', () => {
  const { audio, rejected } = splitDroppedPaths(
    ['C:/a/one.flac', 'C:/a/cover.png', 'c:/a/one.FLAC', 'C:/a/two.mp3', 'C:/b/note.txt'],
    { foldCase: true }
  );
  assert.deepEqual(audio, ['C:/a/one.flac', 'C:/a/two.mp3']);
  assert.deepEqual(rejected, ['C:/a/cover.png', 'C:/b/note.txt']);
  assert.equal(pathKey('C:\\A\\One.flac', { foldCase: true }), pathKey('c:/a/one.flac', { foldCase: true }));
});

test('多个文件的三种挂法', () => {
  const items = [
    { path: 'a.flac', hash: 'h1', title: '甲' },
    { path: 'b.mp3', hash: 'h2', title: '乙' },
    { path: 'c.wav', hash: 'h1', title: '甲的复制' },
    { path: 'd.ogg', hash: 'h3', title: '丙', dupTitle: '已经在库里' },
  ];
  const versions = planAudioImport(items, 'versions');
  assert.equal(versions.groups.length, 1);
  assert.equal(versions.groups[0].title, '甲');
  assert.deepEqual(
    versions.groups[0].files.map((f) => f.role),
    ['version', 'version']
  );
  assert.equal(versions.skip.length, 2);

  const variants = planAudioImport(items, 'variants');
  assert.deepEqual(
    variants.groups[0].files.map((f) => [f.path, f.role]),
    [
      ['a.flac', 'version'],
      ['b.mp3', 'variant'],
    ]
  );

  const tracks = planAudioImport(items, 'tracks');
  assert.deepEqual(
    tracks.groups.map((g) => g.title),
    ['甲', '乙']
  );
  assert.ok(tracks.groups.every((g) => g.files.length === 1 && g.files[0].role === 'version'));
});

test('状态栏文案按结果挑键，不把句子提前拼死', () => {
  assert.deepEqual(dropNotice({ tracks: [{ title: '甲' }], versions: 1, variants: 0 }), [
    { key: 'drop.okOne', vars: { title: '甲' } },
  ]);
  assert.equal(dropNotice({ tracks: [{ title: '甲' }], versions: 3, variants: 0 })[0].key, 'drop.okVersions');
  assert.equal(dropNotice({ tracks: [{ title: '甲' }], versions: 1, variants: 2 })[0].key, 'drop.okVariants');
  assert.equal(dropNotice({ tracks: [{ title: '甲' }, { title: '乙' }], versions: 2 })[0].key, 'drop.okTracks');
  const mixed = dropNotice({ tracks: [], skipped: 2, rejected: 1, failed: 0 });
  assert.deepEqual(
    mixed.map((p) => p.key),
    ['drop.skipped', 'drop.rejected']
  );
  assert.equal(dropNotice({})[0].key, 'drop.none');
});
