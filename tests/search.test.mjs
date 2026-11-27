import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  expandQuery,
  isTimelineNoteLane,
  keyModeLabel,
  periodLabel,
  splitTerms,
  termTable,
  TIMELINE_NOTE_LANE_SQL,
} from '../src/shared/search.js';

/**
 * 流派与情绪的词表是 data/vocab/*.json，不在代码里。
 * 测试直接读真实文件 —— 顺带守住「词表里每一条都能被中文搜到」这件事：
 * 以前情绪靠词典推导，词表改成 JSON 后就必须换成这份真数据来验。
 */
function loadDim(dim) {
  const doc = JSON.parse(fs.readFileSync(new URL(`../data/vocab/${dim}.json`, import.meta.url), 'utf8'));
  const rows = [];
  const walk = (list) => {
    for (const n of list ?? []) {
      rows.push({ id: n.id, name: n.name, display: n.display, value: n.name, aliases: n.aliases ?? [] });
      walk(n.children);
    }
  };
  walk(doc.roots);
  return rows;
}

/** 库里存 id（情绪 / 体裁 / 曲式）/ 存 name（流派）——这个差异只在 termTable 的 value 上 */
const byId = (rows) => rows.map((r) => ({ ...r, value: r.id }));
const MOODS = termTable(byId(loadDim('mood')));
const GENRES = termTable(loadDim('genre'));
const COMPOSITION_TYPES = termTable(byId(loadDim('composition_type')));
const FORMS = termTable(byId(loadDim('form')));
const TABLES = { moods: MOODS, genres: GENRES, compositionTypes: COMPOSITION_TYPES, forms: FORMS };

test('时期：中文「古典主义」→ 规范值 classical', () => {
  assert.deepEqual(expandQuery('古典主义').periods, ['classical']);
  assert.deepEqual(expandQuery('巴洛克').periods, ['baroque']);
  assert.deepEqual(expandQuery('浪漫').periods, ['romantic']);
});

test('时期：直接敲英文也认得，大小写无所谓', () => {
  assert.deepEqual(expandQuery('Baroque').periods, ['baroque']);
  assert.deepEqual(expandQuery('CONTEMPORARY').periods, ['contemporary']);
});

test('时期只收历史分期：爵士 / 民族 / 民谣 / 流行都不算时期', () => {
  // 这几个是流派，混进时间轴会让「浪漫主义 爵士」这种搜索分不清限定的是哪个字段
  for (const word of ['爵士', '民族', '民谣', '流行', 'jazz', 'folk', 'pop']) {
    assert.deepEqual(expandQuery(word, TABLES).periods, [], `${word} 不该是时期`);
  }
  // 但它们仍然能被流派表认出来
  assert.ok(expandQuery('爵士', TABLES).genres.includes('Jazz'));
});

test('调性：中文调式名 → 规范值（库里存 c natural minor）', () => {
  assert.deepEqual(expandQuery('自然小调').keyModes, ['natural minor', 'minor']);
  assert.deepEqual(expandQuery('多利亚').keyModes, ['dorian']);
  assert.deepEqual(expandQuery('大调').keyModes, ['major']);
});

test('混着敲：一句里同时有时期与调性，两边都要抽出来', () => {
  const r = expandQuery('浪漫主义 自然小调');
  assert.ok(r.periods.includes('romantic'));
  assert.ok(r.keyModes.includes('natural minor'));
});

test('不相干的词不产生误伤', () => {
  assert.deepEqual(expandQuery('神鹿谣'), { periods: [], keyModes: [], moods: [], genres: [], compositionTypes: [], forms: [] });
  assert.deepEqual(expandQuery(''), { periods: [], keyModes: [], moods: [], genres: [], compositionTypes: [], forms: [] });
});

test('情绪：中文 / 英文 / 别名 → extra.moods 里的英文枚举', () => {
  // 「怀旧」「亲密」是「おとなの掟」的 moods（nostalgic / intimate）。
  assert.deepEqual(expandQuery('怀旧', TABLES).moods, ['nostalgic']);
  assert.deepEqual(expandQuery('亲密', TABLES).moods, ['intimate']);
  assert.deepEqual(expandQuery('未来感', TABLES).moods, ['future']);
  // 直接敲英文枚举 / 英文界面的写法也要认
  assert.deepEqual(expandQuery('nostalgic', TABLES).moods, ['nostalgic']);
  assert.deepEqual(expandQuery('futuristic', TABLES).moods, ['future']);
  // 乐器不该被当成情绪
  assert.deepEqual(expandQuery('钢琴', TABLES).moods, []);
});

test('词表里每一条情绪的中文名都能搜到（词表是唯一源）', () => {
  assert.ok(MOODS.length >= 15, `情绪太少：${MOODS.length}`);
  for (const m of MOODS) {
    assert.ok(m.display, `${m.value} 缺中文标签`);
    assert.deepEqual(expandQuery(m.display, TABLES).moods, [m.value], `「${m.display}」→ ${m.value}`);
  }
});

test('流派：中文 / 英文 / 别名 → track.genre 里存的 name', () => {
  assert.deepEqual(expandQuery('爵士', TABLES).genres, ['Jazz']);
  assert.deepEqual(expandQuery('民族', TABLES).genres, ['Folk']);
  assert.deepEqual(expandQuery('民谣', TABLES).genres, ['Folk']);
  assert.deepEqual(expandQuery('影视配乐', TABLES).genres, ['OST']);
  assert.deepEqual(expandQuery('ost', TABLES).genres, ['OST']);
});

test('体裁：中文 / 英文 → track.composition_type 里的词表 id', () => {
  // 2026-11-04 从 genre 拆出来的那一批：它们说的是作品形制，不是写法
  assert.deepEqual(expandQuery('室内乐', TABLES).compositionTypes, ['chamber-music']);
  assert.deepEqual(expandQuery('弦乐四重奏', TABLES).compositionTypes, ['string-quartet']);
  assert.deepEqual(expandQuery('交响曲', TABLES).compositionTypes, ['symphony']);
  assert.deepEqual(expandQuery('前奏曲', TABLES).compositionTypes, ['prelude']);
  assert.deepEqual(expandQuery('Chamber Music', TABLES).compositionTypes, ['chamber-music']);
  // 体裁不能再从流派里冒出来，否则同一首会被两条路各命中一次
  assert.deepEqual(expandQuery('室内乐', TABLES).genres, []);
});

test('赋格：体裁与曲式两边都收，但不再是作曲技法', () => {
  // 说「这是一首赋格」是体裁，说「用赋格曲式写成」是曲式 —— 两种说法都成立
  assert.deepEqual(expandQuery('赋格', TABLES).compositionTypes, ['fugue']);
  assert.ok(expandQuery('赋格', TABLES).forms.includes('fugue-form'));
  // 2026-11-04 从对位技法里删掉了（它不是「怎么写」的手法，而是作品形制）
  const compositionIds = loadDim('composition').map((r) => r.id);
  assert.ok(compositionIds.includes('imitation') && compositionIds.includes('canon'));
  assert.ok(!compositionIds.includes('fugue'), 'fugue 不该再出现在作曲技法里');
});

test('曲式：中文 → track.form 里的词表 id，且不串到体裁', () => {
  assert.deepEqual(expandQuery('奏鸣曲式', TABLES).forms, ['sonata-form']);
  assert.deepEqual(expandQuery('回旋曲式', TABLES).forms, ['rondo']);
  // 「复三部曲式」里含「三部曲式」，所以单三部也会一起带出来（宁可多捞一层）
  assert.ok(expandQuery('复三部曲式', TABLES).forms.includes('compound-ternary'));
  // 中文按子串命中：「奏鸣曲式」里含「奏鸣」，所以体裁那边也会带出 sonata ——
  // 这是刻意的（宁可多捞一层），不是 bug。这里只锁住曲式这一侧。
  assert.ok(expandQuery('奏鸣曲式', TABLES).forms.includes('sonata-form'));
});

test('词表里每一条流派的英文名都能搜到', () => {
  assert.ok(GENRES.length >= 30, `流派太少：${GENRES.length}`);
  for (const g of GENRES) {
    assert.ok(expandQuery(g.name, TABLES).genres.includes(g.value), `${g.name} → ${g.value}`);
  }
});

test('英文按整词命中：nostalgic 不会被流派 OST / pop 误伤', () => {
  // n-o-s-t-a-l-g-i-c 里有个 ost，popular 里有 pop；子串匹配会让搜情绪捞回一堆原声带
  assert.deepEqual(expandQuery('nostalgic', TABLES).genres, []);
  assert.deepEqual(expandQuery('popular', TABLES).genres, []);
  assert.deepEqual(expandQuery('ost', TABLES).genres, ['OST']);
  // 复合流派会连带命中外层的根（Latin Jazz ⊃ Jazz）—— 宁可多捞一层，也不能漏
  assert.ok(expandQuery('latin jazz', TABLES).genres.includes('Latin Jazz'));
});

test('没有词表时只认时期与调式（不报错，也不误伤）', () => {
  const r = expandQuery('怀旧 爵士');
  assert.deepEqual(r.moods, []);
  assert.deepEqual(r.genres, []);
  assert.deepEqual(r.compositionTypes, []);
  assert.deepEqual(r.forms, []);
});

test('规范值 → 中文显示，未收录的原样返回', () => {
  assert.equal(periodLabel('contemporary'), '当代');
  assert.equal(periodLabel('classical'), '古典主义');
  assert.equal(periodLabel(null), '—');
  assert.equal(periodLabel('某个新词'), '某个新词');
  assert.equal(keyModeLabel('natural minor'), '自然小调');
});

test('分词：空格切成多个词，每个词都要命中', () => {
  assert.deepEqual(splitTerms('钢片琴 低音提琴'), ['钢片琴', '低音提琴']);
  assert.deepEqual(splitTerms('神 低音'), ['神', '低音']);
  // 连续空格、首尾空格、大小写都不要紧
  assert.deepEqual(splitTerms('  神   低音  '), ['神', '低音']);
  assert.deepEqual(splitTerms('Baroque  Piano'), ['baroque', 'piano']);
  assert.deepEqual(splitTerms(''), []);
});

test('分词：带空格的调式名与词条名不能被拆散', () => {
  assert.deepEqual(splitTerms('自然小调 natural minor'), ['自然小调', 'natural minor']);
  assert.deepEqual(splitTerms('c 自然小调'), ['c', '自然小调']);
  assert.deepEqual(splitTerms('whole tone'), ['whole tone']);
  // Chamber Music / String Quartet 是体裁（带空格的词条），拆开就变成两个更宽的词
  assert.deepEqual(splitTerms('Chamber Music', TABLES), ['chamber music']);
  assert.deepEqual(splitTerms('浪漫 弦乐四重奏', TABLES), ['浪漫', '弦乐四重奏']);
});

test('时间线备注泳道：note 与 *-note，低音行不算', () => {
  assert.equal(isTimelineNoteLane('note'), true);
  assert.equal(isTimelineNoteLane('voicing-note'), true);
  assert.equal(isTimelineNoteLane('bass'), false);
  assert.equal(isTimelineNoteLane('degree'), false);
  assert.equal(isTimelineNoteLane('chord'), false);
  assert.equal(isTimelineNoteLane('notes'), false);
  assert.equal(isTimelineNoteLane(''), false);
  assert.equal(isTimelineNoteLane(null), false);
  // SQL 片段必须表达同一条规则，不能只认 note、把排列备注漏掉
  assert.match(TIMELINE_NOTE_LANE_SQL, /e\.lane = 'note'/);
  assert.match(TIMELINE_NOTE_LANE_SQL, /GLOB '\*-note'/);
});

test('分词后逐词展开：整句里的时期不再污染其它词的条件', () => {
  // 逐词展开时，只有「浪漫」这一组会带 romantic，钢琴那组只认文本
  assert.deepEqual(expandQuery(splitTerms('浪漫 钢琴')[0]).periods, ['romantic']);
  assert.deepEqual(expandQuery(splitTerms('浪漫 钢琴')[1]).periods, []);
});
