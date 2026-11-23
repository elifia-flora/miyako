<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { barToTick, computeStartBars, tickToBarBeat } from '@shared/barbeat.js';
import {
  cellAtTick,
  cellStart,
  countCells,
  describeRange,
  gridAt,
  snapRange,
} from '@shared/grid.js';
import { degreeOfChord, describeChord, CHORD_LANES, parseChord, isDominantSeventh } from '@shared/chord.js';
import { letterFromRoman } from '@shared/chordletter.js';
import { sposobinCandidates, sposobinCaseNote, sposobinHint, sposobinOf } from '@shared/sposobin.js';
import { matchProgression } from '@shared/progression.js';
import { degreeCandidates, letterCandidates, omitWordSuggestions } from '@shared/cellsug.js';
import ChordText from '../components/ChordText.vue';
import { suggestKeyNames } from '@shared/keyname.js';
import { pickMode } from '@shared/suggest.js';
import { locale, t, tn } from '../i18n';
import { numeral } from '@shared/numeral.js';
import { numeralStyle } from '../numeralStyle';

/**
 * `describeChord` 的包：只为建立对 `numeralStyle` 的依赖。
 * 那是全局可变状态（`shared/numeral.js`），Vue 追踪不到它；
 * 读一下 ref 就能让用到的地方在切换偏好后重新求值。
 */
function describeWithNumeral(p: any, loc: string) {
  void numeralStyle.value;
  return describeChord(p, loc);
}
import { isComposing } from '../ime';
import { setGridSummary } from '../helpctx';
import {
  state as audio,
  debugClock,
  onFrame,
  pause as pauseAudio,
  play as playAudio,
  scrubPulse,
  seek as seekAudio,
  setFollow,
} from '../audio/store.js';
import {
  coarseStepMs,
  frameStepMs,
  scrubDurationMs,
  shouldScrub,
  stepPrefs,
  saveStepPrefs,
} from '../playbackPrefs';
import { audioMsOfTick, relMsOfTick, temposOf, tickOfAudioMs } from '../audio/time.js';
import { peakRange, pickLevel } from '../audio/peaks.js';

const props = defineProps<{
  analysis: any | null;
  view: any | null;
  title: string;
  /** 格单位由外层菜单驱动：双向同步，菜单里的勾选和工具栏的高亮必须是同一个值 */
  unit?: 'bar' | 'beat' | 'half';
}>();
const emit = defineEmits<{ changed: []; 'unit-change': ['bar' | 'beat' | 'half'] }>();

const WAVE_H = 30;
const RULER_H = 20;
const SECTION_H = 18;
const KEY_H = 18;
/** 调性竖线 / 段落分界线的命中半宽：比 1px 的线宽得多，否则永远抓不到 */
const KEY_HIT = 6;
/**
 * 双击兜底窗口。**只在合成事件上生效**（真实鼠标用 ev.detail，见 isDoubleAt）：
 * 以前这里写 400ms，比 Windows 默认的 500ms 还紧，手慢一点就永远凑不成双击 ——
 * 用户看到的就是「双击没反应，要试好几次」。
 * 现在放宽到 900ms：真实鼠标根本走不到这个分支（detail 一定有值），
 * 它只服务于脚本 / 无障碍工具那种 detail 恒为 0 的合成事件，宽一点没有副作用。
 * 600ms 曾经也能过，但冒烟里两次点击之间还夹着 IPC 往返，实测会卡在 600–700ms 之间。
 */
const KEY_DBL_MS = 900;
const KEY_DBL_PX = 8;
/** 拖动阈值：真实鼠标点一下常带 3–5px 抖动，太小会把「点一下」判成拖动 */
const DRAG_MIN_PX = 5;
/** 左侧泳道标签列的宽度：画布钉在它右边 */
const LANE_W = 64;

/** 和弦标记字号：10.5 在高 DPI 屏上偏小，读谱和瞄准边缘都得先看得清 */
const CHORD_FONT_SIZE = 12.5;
/**
 * 和弦标记用**界面无衬线字体**，不再用等宽。
 *
 * 等宽下 `iii6/III` 这种长符号每个字符都占一格全宽，实际比字形宽近一倍：
 * 缩到 0.6 倍时它最先撞到格子右边界，看起来就是「长和弦总溢出」。
 * 小节号（RULER_FONT）仍然用等宽 —— 数字位数对齐比字形紧凑更重要。
 *
 * canvas 读不了 CSS 变量，字体族从 body 的计算样式里取（会跟着设置里的
 * 「无衬线 / 等宽」开关走，`data-font` 变化时 colorCache 作废）。
 */
function chordFont(c: any, size = CHORD_FONT_SIZE) {
  return `${size}px ${c?.fontFamily || 'system-ui, sans-serif'}`;
}
/**
 * 双变音记号（𝄪 / 𝄫）画的时候放大 10%。
 *
 * 这两个字在 12.5px 下「高但窄」：跟旁边的 `C` 放一起像一根细线，读谱时最容易看漏。
 * 放大只作用于记号本身 —— 字母一个像素都不动，所以「C𝄪7」读起来仍是一个整体。
 *
 * 只在文本里**真的出现**这两个字时才走分段绘制：绝大多数格子是一整串 fillText，
 * 每帧几千次 fillText 的性能不能因为一个冷门写法下降。
 */
/**
 * 注意：**不能写成字符类 `[𝄪𝄫]`**。
 * 𝄪/𝄫 在 UTF-16 里是**代理对**（两个 code unit），字符类是按 code unit 匹配的，
 * 于是 `split` 会把记号劈成两个孤立代理 → 每个都渲染成 .notdef（一个带问号的菱形）。
 * 用「择一」`(𝄪|𝄫)` 才是按 code point 匹配。
 */
const BIG_ACCIDENTAL = /(𝄪|𝄫)/;

function paintChordText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  if (!BIG_ACCIDENTAL.test(text)) {
    ctx.fillText(text, x, y);
    return;
  }
  const base = ctx.font;
  const size = parseFloat(base) || CHORD_FONT_SIZE;
  // 1.25 而不是 1.1：12.5px 下 𝄪 的墨迹只有 3px 宽，放大 10% 等于 0.3px —— 肉眼看不出来。
  // 再大（1.4 以上）就会和字母的 cap height 打架，1.25 是「看得出来但不抢戏」的位置。
  const big = base.replace(/^[\d.]+px/, `${(size * 1.25).toFixed(2)}px`);
  let cx = x;
  for (const part of text.split(BIG_ACCIDENTAL)) {
    if (!part) continue;
    ctx.font = part === '𝄪' || part === '𝄫' ? big : base;
    ctx.fillText(part, cx, y);
    cx += ctx.measureText(part).width;
  }
  ctx.font = base;
}

/** 刻度、段落、调性这些小字比和弦正文小一号，别抢注意力 */
const RULER_FONT = '10px "Cascadia Mono", Consolas, monospace';
/**
 * 泳道行高 = 和弦字号 × 1.75（12.5 → 22）。
 *
 * 所有泳道方案的行高在 JSON 里都写成同一个值 → `lanesGeom` 按比例缩放后**全部等高 22px**
 * （用户要求：低音 / 备注 与级数一样高；以前次要行被压到 16，三条一行比一行矮）。
 * 上限仍然跟着字号走，而不是让泳道把面板撑满 —— 后者会让内容永远比容器高一点，
 * 右边常驻一条消不掉的滚动条。
 */
const LANE_ROW_MAX = Math.round(CHORD_FONT_SIZE * 1.75);
/** 有音频才画波形带；波形还在解码时先留一条细的占位，避免版式跳一下 */
const waveH = computed(() => (audio.peaks ? WAVE_H : audio.ready ? 14 : 0));
const headH = computed(() => waveH.value + RULER_H + SECTION_H + KEY_H);

/**
 * 调性条的上缘（文档坐标）。绘制与命中**必须**共用这一个值：
 * 以前 draw 里写的是局部 `kY`，一旦有人改了头带高度，命中区会和看到的条错开，
 * 表现成「点调性条没反应 / 点到了播放头」，且完全不报错。
 */
const keyY = computed(() => waveH.value + RULER_H + SECTION_H);

/** 段落条的上缘。同样：绘制与命中必须共用这一点 */
const sectionY = computed(() => waveH.value + RULER_H);

const host = ref<HTMLDivElement | null>(null);
const scroller = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const playheadEl = ref<HTMLDivElement | null>(null);
const zoom = ref(1);
/** 格的分母：小节 / 拍 / 半拍。div 是给 grid.js 的数值，0 = 一小节一格（哨兵） */
const unit = ref<'bar' | 'beat' | 'half'>(props.unit ?? 'beat');

/** 改格单位：内部状态与外层（菜单）一起变，否则两边显示会打架 */
function setUnit(u: 'bar' | 'beat' | 'half') {
  if (unit.value === u) return;
  unit.value = u;
  emit('unit-change', u);
  scheduleDraw();
}

watch(
  () => props.unit,
  (u) => {
    if (u && u !== unit.value) {
      unit.value = u;
      scheduleDraw();
    }
  }
);
const div = computed(() => (unit.value === 'bar' ? 0 : unit.value === 'half' ? 2 : 1));
const hostH = ref(0);
const hostW = ref(0);

/**
 * 视口架构（对齐 TallyDeck 的验证结论）：
 * canvas 只有视口大小，用 position:sticky 钉在可视区；滚动范围由 spacer 撑出来。
 * 文档坐标（全曲像素）只在计算层使用，画进画布前统一减掉 viewLeft/viewTop。
 * 于是缩放/滚动的重绘量与缩放级别彻底脱钩 —— 以前 canvas 是全曲宽，
 * zoom=4 时后备缓冲区逼近 Chromium 的 32767px 上限，每帧重画几万条线，卡的就是这个。
 */
const viewLeft = ref(0);
const viewTop = ref(0);
const viewW = computed(() => Math.max(1, hostW.value - LANE_W));
/**
 * 横向滚动条本身要吃掉 10px 高度。不扣掉的话，spacer 高度 = 容器高度，
 * 一出现横向滚动条，竖直方向就正好差 10px —— 于是右边那条竖直滚动条
 * 无论窗口拖多大都消不掉，右下角还会多出个滚动条交汇的方块。
 */
const viewH = computed(() => Math.max(1, hostH.value));

const editing = ref<null | { x: number; y: number; width: number; text: string }>(null);

/**
 * 单元格输入补全。
 *
 * **按泳道方案给不同的候选**，不能混：
 * - 级数类（roman / riemann）：后缀来自 `chord-symbols.json` 的 `qualities`；
 *   裸 `ii` / `vii` 永远第一，半减七由 `h / b`（可带转位数字）显式触发；`C` / `K` 仍特判成 `Cad64`。
 *   这里绝不该冒出 `C7sus4`，级数泳道的符号是相对的，摆一个绝对和弦进去只会被当成错误解析。
 * - 字母和弦（letter）：音名 × 变音 × 性质，同一份词表。
 * - 斯波索宾（sposobin）：C / K → `K46`（本套体系自己的写法）。
 *
 * 候选项形如 `{ value, label, hint }`：label 是左边要写进格子的东西，
 * hint 是右边那句说明（比如「K46 在本套体系的标注方法」）。
 */
/**
 * `tone` 只影响右侧说明的文字颜色，不加框（用户明确要求）：
 *   `warn` —— 橙黄（`--warn`）：少见写法，提醒一句
 *   `ok`   —— 品牌绿（`--accent`）：与「常用 / 正确」相关的提示
 * 颜色都从现有变量里取，不新造色值。
 */
type CellSug = { value: string; label: string; hint?: string; tone?: 'warn' | 'ok' };
const cellSug = ref<{ items: CellSug[]; active: number; open: boolean }>({ items: [], active: 0, open: false });
/**
 * 和弦符号词表原样留着：`letterCandidates` / `degreeCandidates` 都吃这一份。
 * 以前这里写的是 `doc.roots`（v1 字段），v2 拆成 letters + accidentals 之后条件永远为假，
 * 字母和弦泳道就再也没有候选了。
 */
const chordTable = ref<any>(null);

async function loadChordTable() {
  try {
    const doc = await (window as any).api?.chords?.doc?.();
    if (doc?.qualities?.length) chordTable.value = doc;
  } catch {
    /* 词表读不到只是没有候选，不能影响输入 */
  }
}

function closeCellSug() {
  cellSug.value = { items: [], active: 0, open: false };
}

/**
 * 当前正在编辑的行属于哪种「和弦符号」语境。
 *
 * **级数与绝对和弦是两条泳道**（2026-11-04，迁移 010）：
 *   `degree` —— 级数（罗马数字视图的「级数」行）
 *   `chord`  —— 绝对和弦（字母和弦视图的「和弦」行、黎曼视图的「实际和弦」行）
 * 以前两个视图共用 `chord`，结果字母和弦视图里躺着一串 `I / IV / V7`，
 * 在那边敲 `Cmaj7` 又会把级数覆盖掉。
 */
function cellContext(): 'degree' | 'letter' | 'sposobin' | null {
  const laneId = selection.value?.lanes?.[0] ?? '';
  const viewId = String(props.view?.id ?? '');
  if (laneId === 'sposobin') return 'sposobin';
  // 级数行只在 roman 里存在（riemann 的级数语义在 function 行，仍无候选）
  if (laneId === 'degree') return viewId === 'roman' ? 'degree' : null;
  // 绝对和弦行：字母和弦视图，以及黎曼视图的「实际和弦」行（占位符就是 G7）
  if (laneId === 'chord') return viewId === 'letter' || viewId === 'riemann' ? 'letter' : null;
  return null;
}

/**
 * 级数候选全部交给 `shared/cellsug.js`：后缀、顺序、别名匹配、半减七转位、模糊匹配都在那边。
 * 组件这里只负责「当前是哪种泳道 / 格所在 tick 是什么调性」。
 */
function buildCellSug(token: string): CellSug[] {
  const ctx = cellContext();
  if (!ctx) return [];
  const t0 = token.trim();
  if (!t0) return [];
  /**
   * 省略音关键字：`C13o` → `C13omit` / `C13no`（`C13n` → 只给 `no`）。
   * 只在和弦符号的两条泳道里给 —— 斯波索宾没有这套写法。
   * 判断放在最前面：`V13o` 的 `o` 不能被当成减三和弦的别名吃掉。
   */
  if (ctx === 'degree' || ctx === 'letter') {
    const om = omitWordSuggestions(t0);
    if (om.length) {
      return om.map((value) => ({ value, label: value, hint: t('grid.sug.omitWord') }));
    }
  }
  const wantsCadential = /^(c|k)/i.test(t0);
  if (ctx === 'degree') {
    if (wantsCadential) {
      if (!'cad64'.startsWith(t0.toLowerCase()) && !'k46'.startsWith(t0.toLowerCase())) return [];
      return [{ value: 'Cad64', label: 'Cad64', hint: t('grid.sug.cadential') }];
    }
    /**
     * 那不勒斯：`N` / `N6`。它和 `♭II` / `♭II6` 是同一个和弦的两种写法，
     * 两种都支持（用户按习惯写哪种都行），候选只在打 N 开头时才出。
     */
    if (/^n/i.test(t0)) {
      const low = t0.toLowerCase();
      return [
        { value: 'N', label: 'N', hint: t('grid.sug.neapolitan') },
        { value: 'N6', label: 'N6', hint: t('grid.sug.neapolitan6') },
      ]
        .filter((x) => x.value.toLowerCase().startsWith(low))
        .sort((a, b) => (a.value.toLowerCase() === low ? -1 : b.value.toLowerCase() === low ? 1 : 0));
    }
    return degreeCandidates(chordTable.value, t0);
  }
  if (ctx === 'sposobin') {
    // 候选按该 tick 的调式给（大调 T/S/D、小调 t/s/d）；带斜杠时只补目标
    const tick = selection.value?.startTick ?? 0;
    const key = keyNameAt(tick);
    /**
     * 右边那行灰字：**罗马数字 + 转位**（与级数泳道的「小三 · 第一转位」同一个用意）。
     * 打 `D56` 时最想知道的就是「这是 V65」—— 一眼对上心里那套写法，
     * 不用在脑子里做 56→65、D→V 两道换算。
     */
    const hintOf = (value: string): { hint: string; tone?: 'warn' | 'ok' } => {
      if (value === 'K46') return { hint: t('grid.sug.k46') };
      const h = sposobinHint(value, key);
      /**
       * 「原位 / 第N转位」：N 的写法跟偏好（汉字 / 阿拉伯），由 numeral.js 决定。
       * `void numeralStyle.value` 是为了让候选在切换偏好后**重算**（它是全局状态，不是 reactive）。
       */
      void numeralStyle.value;
      const fig =
        h?.inv == null
          ? ''
          : h.inv === 0
            ? t('grid.sug.fig.root')
            : t('grid.sug.fig.inv', { n: numeral(h.inv, locale.value) });
      /**
       * 大小写「越界」时，说明换成来历 + 上色（只改文字色，不加框）：
       *   小调里的大下属 → 橙黄（少见）；大调里的小下属 → 绿（和声大调的常客）。
       */
      const note = sposobinCaseNote(value, key);
      if (note) {
        return {
          hint: t(note === 'rare' ? 'grid.sug.sRare' : 'grid.sug.sBorrowed', { fig }),
          tone: note === 'rare' ? 'warn' : 'ok',
        };
      }
      // 普通候选只留转位（「第一转位」/「原位」）：罗马数字与 6/56/34 那些词和弦本身已经说了，
      // 再说一遍只是冗余（用户 2026-11-07 明确要求删掉）。
      return { hint: fig };
    };
    /**
     * 给到 20 条，而不是 8：候选框本身 `max-height: 264px; overflow: auto` 可滚动，
     * 而六级那一串（`tsVI` 七项 + 导七四项 + 重导五项）一共 16 条 ——
     * 卡在 8 的话，用户按 `v` 永远看不到后面给他排好的导七与重导。
     */
    const list: CellSug[] = sposobinCandidates(t0, key)
      .slice(0, 20)
      .map((value) => ({ value, label: value, ...hintOf(value) }));
    /**
     * **小重属（小属的小属）**：`dd` 开头（两个小写 d）。用户 2026-11-08 的要求。
     *
     * 这东西在本体系里几乎不出现，候选池里也没有这一族；硬猜一个调式内的小属链
     * 只会制造假候选。所以第一项直接给**用户打的那串字面**（警告色，说明它多罕见），
     * 让他能回车写进去。
     *
     * 后面的补全要**用大写 DD 再算一遍**：候选池里的功能首字母过滤是按大小写分家的
     * （`dd` 这一族不存在，所以小写算出来是空的），而用户要的正是「dd 之后接正常 DD 的补全」。
     * 大写 `DD` 本身是正常重属，判据必须区分大小写 —— 不能让它也走这条分支。
     */
    if (/^dd/.test(t0)) {
      const upper = sposobinCandidates('DD' + t0.slice(2), key)
        .slice(0, 20)
        .map((value) => ({ value, label: value, ...hintOf(value) }));
      const seen = new Set([t0]);
      const merged: CellSug[] = [];
      for (const x of [...list, ...upper]) {
        if (seen.has(x.value)) continue;
        seen.add(x.value);
        merged.push(x);
      }
      return [
        { value: t0, label: t0, hint: t('grid.sug.ddMinor'), tone: 'warn' as const },
        ...merged,
      ];
    }
    return list;
  }
  return letterCandidates(chordTable.value, t0);
}

function onCellInput(ev?: Event) {
  const el = ev?.target as HTMLInputElement | null;
  if (el && typeof el.value === 'string' && editing.value) editing.value.text = el.value;
  const token = editing.value?.text ?? '';
  const items = buildCellSug(token);
  cellSug.value = { items, active: 0, open: items.length > 0 };
}

function applyCellSug(c: CellSug) {
  if (!editing.value) return;
  editing.value.text = c.value;
  closeCellSug();
  void nextTick(() => {
    const el = document.querySelector('.cell-input') as HTMLInputElement | null;
    // preventScroll：见 openEditor 里那段说明（focus 会顺手滚容器，把视口顶偏）
    el?.focus({ preventScroll: true });
    el?.setSelectionRange?.(editing.value?.text.length ?? 0, editing.value?.text.length ?? 0);
  });
}

/**
 * 头带两条标记带（段落 / 调性）共用一套编辑态。
 *
 * 为什么合成一份而不是各做一份：这两条带的输入框、定位、输入法组合态判断、blur 提交
 * 完全同构，各写一份就一定会出现「一条带记得判 IME、另一条忘了」——这个项目已经在这类
 * 重复上踩过两次（补全框、单元格输入）。差异只有：调性有候选、段落没有；两条带的 y 与高度不同。
 *
 * 数据都落在 `analysis_marker`，写入走 `api.analysis.setMarkers` ——
 * 那是**整组替换**（先清空该 kind 再逐条插入），所以每次改动都要把该 kind 的全部行一起送回去。
 * 详情面板读的是同一批行，写完 `emit('changed')` 由父层重拉即可同步，不在这里改 props。
 */
type BandKind = 'section' | 'key';
const bandEdit = ref<null | { kind: BandKind; tick: number; text: string; isNew: boolean }>(null);
const bandSug = ref<{ items: { value: string; label: string }[]; active: number; open: boolean }>({
  items: [],
  active: 0,
  open: false,
});
const bandSaving = ref(false);
const bandInputEl = ref<HTMLInputElement | null>(null);
/**
 * 头带上的拖动态（段落拖分界线 / 调性拖竖线共用）。
 * 位移超过 5px 才算「真的在拖」：真实鼠标点一下常带 3–5px 抖动，
 * 阈值太小会让「只想点一下」被判成拖动，**静默把标记挪走并写库**。
 */
let bandDrag: null | {
  kind: BandKind;
  id: string;
  tick: number;
  text: string;
  confidence: any;
  note: string | null;
  label: any;
  x0: number;
  moved: boolean;
  previewTick: number;
} = null;
/** 头带上一次点击（只有合成事件才用得上，真实鼠标靠 ev.detail） */
let bandClick: null | { at: number; x: number } = null;
/**
 * 网格里上一次单击的位置。双击判定与头带用同一套规则（`isDoubleAt`），
 * 单击只选、双击才进输入态。
 */
let cellClick: null | { at: number; x: number } = null;
let bandCancel = false;
/** 段落条右键菜单。x/y 是相对 `.canvas-host` 的像素 */
const bandMenu = ref<null | { x: number; y: number; tick: number; has: boolean; canSplit: boolean }>(null);
/**
 * 低音行标签的右键菜单。x/y 同样相对 `.canvas-host`。
 *
 * 样式直接复用 `.band-menu`（`band-menu` 是"浮在网格上的竖排小菜单"的通用形态），
 * 不新造 class —— 这个仓库因为撞类名塌过两次排版。
 */
const bassMenu = ref<null | { x: number; y: number }>(null);
/** 「从级数生成字母和弦」的右键菜单（开在 `chord` 行上；字母 / 黎曼 / 组成音视图都有这一行） */
const chordMenu = ref<null | { x: number; y: number }>(null);
/** 「从级数 / 字母和弦生成斯波索宾标记」的右键菜单 */
const sposobinMenu = ref<null | { x: number; y: number }>(null);

/** 选区：一律以 tick 表达（左闭右开），像素只是渲染结果 */
const selection = ref<null | { lanes: string[]; startTick: number; endTick: number }>(null);
/**
 * 离散多选：Ctrl+点 / Shift+点 收进来的一批事件 id，和矩形选区**并存**。
 *
 * 矩形负责「一整片格子」，离散集合负责「挑几个不连续的块」；普通单击和框选一按下就清空它
 * （文件管理器那套语义）。高亮、复制、删除都取两者的并集。
 */
const pickedIds = ref<string[]>([]);
/**
 * 最近一帧画出来的选区框（给冒烟读，不参与渲染）。
 * 普通变量而不是 ref：draw 每帧都写，做成响应式等于每帧触发一次更新。
 */
let lastSelBoxes: Array<{ x0: number; x1: number; y: number; h: number }> = [];
/** Shift+点 的锚点：上一次点中的事件，决定「中间这一片」是哪一段 */
let pickAnchor: null | { tick: number; lane: string } = null;
const hover = ref<null | { lane: string; tick: number }>(null);
/**
 * 图例上那行「刚做了什么」。存的是**词典键 + 变量**而不是拼好的句子：
 * 撤栈里压着的标签要能跟着语言变，拼死的字符串切了语言就成外语夹中文了。
 */
type ActionLabel = { key: string; vars?: Record<string, unknown> };
/**
 * 当前曲目能不能撤销 / 重做（按钮灰不灰）。
 * 真相在主进程（history.ts）—— 撤销要跨窗口、跨会话，不能再在组件里留一份栈。
 */
const histCan = ref({ undo: false, redo: false });
const lastAction = ref<ActionLabel | null>(null);

function actionText(label: ActionLabel | null | undefined): string {
  return label ? t(label.key, label.vars) : '';
}

/**
 * 工具栏上那条错误提示 —— 只有 `grid.err.*` 会显示。
 *
 * 底部说明栏整条删掉之后，成功动作不再需要一块常驻区域显示；
 * 但「已经有段落了」「这个位置已经有调性了」这类**没生效**的提示必须看得见，
 * 否则用户会以为是自己点漏了。
 */
const actionError = computed(() => {
  const l = lastAction.value;
  return l && String(l.key).startsWith('grid.err.') ? actionText(l) : '';
});

const ppq = computed(() => props.analysis?.ppq ?? 480);

const meters = computed(() => {
  const raw = (props.analysis?.markers ?? []).filter((m: any) => m.kind === 'meter');
  const list = raw.length ? raw : [{ tick: 0, num: 4, den: 4 }];
  return computeStartBars(list as any, ppq.value);
});

const tempos = computed(() => {
  const a = props.analysis;
  if (!a) return [];
  const list = (a.markers ?? [])
    .filter((m: any) => m.kind === 'tempo')
    .map((m: any) => ({ tick: m.tick, bpm: m.bpm }));
  if (!list.length) return [{ tick: 0, bpm: a.tempoValue ?? 120 }];
  return list.sort((x: any, y: any) => x.tick - y.tick);
});

const sections = computed(() => {
  const list = (props.analysis?.markers ?? []).filter((m: any) => m.kind === 'section');
  return list.length ? list : [{ tick: 0, label: '—', confidence: 'confirmed' }];
});

/**
 * 真实段落行 —— **编辑只认这个**。
 * `sections` 在上面会造一条假段落（tick 0 / label `—`）好让段落条有东西可画，
 * 拿它去写库就会凭空多出一段。
 */
const sectionMarkers = computed(() => (props.analysis?.markers ?? []).filter((m: any) => m.kind === 'section'));

const keys = computed(() => (props.analysis?.markers ?? []).filter((m: any) => m.kind === 'key'));

const lanes = computed(() => props.view?.lanes ?? []);

/**
 * 当前视图里真实存在的泳道 id（顺序 = 视图顺序）。
 *
 * 数据是**跨视图共享**的：同一首曲子既有罗马数字的 `chord`，也可能在黎曼视图里
 * 登记过 `function`。切到罗马数字视图时 `function` 那条不画、也点不到，但它仍在
 * `analysis.events` 里 —— 只要让它参与选区，就会抢走详情栏、被连带删除、把「N 项」算多。
 * The deepest nightmare of Sibyl 第 11 小节（tick 19200）就是这样：
 * 同一区间压着 `function='t'` 和 `chord='i'`，而 `ORDER BY tick` 让前者排在前面。
 */
const viewLaneIds = computed(() => {
  const ids = (props.view?.lanes ?? []).map((l: any) => l.id);
  return ids.length ? ids : null;   // 没有视图时（理论上不会）不做过滤
});

/** 只保留当前视图看得见的事件 —— 选区、计数、删除、解析一律以它为准 */
const viewEvents = computed(() => {
  const evs = props.analysis?.events ?? [];
  const ids = viewLaneIds.value;
  return ids ? evs.filter((e: any) => ids.includes(e.lane)) : evs;
});

/** 离散选中的事件（只认当前视图里存在的那些 id） */
const pickedEvents = computed(() => {
  if (!pickedIds.value.length) return [] as any[];
  const keep = new Set(pickedIds.value);
  return viewEvents.value.filter((e: any) => keep.has(e.id));
});

/**
 * 文档总长（小节）。四个来源取最远：
 *   最后的段落 + 10 小节（段落之后要留出可写白）、所有标记 / 事件的终点、**音频时长**。
 *
 * 音频这条不能省：档案里没登记段落（或录音比谱面多一段尾巴）时，
 * 网格会短于音频 —— 播放最后几秒波形在半截处被切断，播放头也跟着跑出右边界，
 * 看着像「波形坏了」，其实是没有格子可画。
 */
const totalBars = computed(() => {
  const P = ppq.value;
  const barOf = (tick: number) => tickToBarBeat(meters.value, Math.max(0, tick), P).bar;

  const last = sections.value[sections.value.length - 1];
  let bars = Math.max(48, (last ? barOf(last.tick) : 32) + 10);

  let endTick = 0;
  for (const m of props.analysis?.markers ?? []) endTick = Math.max(endTick, Number(m.tick) || 0);
  for (const e of props.analysis?.events ?? []) {
    endTick = Math.max(endTick, (Number(e.tick) || 0) + (Number(e.durTicks) || 0));
  }
  if (endTick > 0) bars = Math.max(bars, barOf(endTick) + 1);

  // 音频时长 →（按当前速度表）tick → 小节，再留一小节尾巴
  const audioMs = Math.max(audio.durationMs || 0, (audio.peaks?.duration ?? 0) * 1000);
  if (audioMs > 0) {
    const tick = tickOfAudioMs(props.analysis, tempos.value, audioMs);
    bars = Math.max(bars, Math.ceil(barOf(tick)) + 1);
  }

  return bars;
});

const pxPerBar = computed(() => 56 * zoom.value);
const totalWidth = computed(() => totalBars.value * pxPerBar.value);

/**
 * 泳道几何：行高有上限（和弦字号 × 1.75 = 22），不会被"撑满可视高度"这个念头拉着无限长高。
 * JSON 里的 height 只当相对权重用；现在五套方案的每一行都写成同一个值 → 结果就是**全部等高 22px**
 * （用户要求：低音 / 备注不能比级数矮）。将来若某套方案要强调主行，改回不同值即可，比例逻辑还在。
 * 面板够高时下方留空白（canvas 照常铺底色），而不是把每条泳道拉成柱子。
 */
const lanesGeom = computed(() => {
  const list = lanes.value;
  if (!list.length) return [] as { lane: any; y: number; h: number }[];
  const base = list.map((l: any) => (Number(l.height) > 0 ? Number(l.height) : LANE_ROW_MAX));
  // 最矮的一条压到上限，其它按同一比例缩 —— 相对关系保留，绝对高度受控
  const k = Math.min(1, LANE_ROW_MAX / Math.min(...base));
  let y = headH.value;
  return list.map((l: any, i: number) => {
    const h = Math.max(1, Math.round(base[i] * k));
    const item = { lane: l, y, h };
    y += h;
    return item;
  });
});

const totalHeight = computed(() =>
  Math.max(viewH.value, headH.value + lanesGeom.value.reduce((s, g) => s + g.h, 0))
);

/** 内容实际占的高度（头带 + 全部泳道），文档坐标 */
const contentDocH = computed(() => headH.value + lanesGeom.value.reduce((s, g) => s + g.h, 0));

/**
 * canvas 的**位图高度**：内容有多高就多高，最多到视口高。
 *
 * 以前它铺满整个视口 —— 独立窗口最大化后是 3176×1250 的位图，每帧重画 + 上传约 4M 像素，
 * 拖滚动条等于每秒喂 60 张 16MB 纹理，核显直接跪。下面是空白而已（面板背景色），
 * 把它也画一遍纯属浪费：内容只有 152px 高时位图直接降到 1/8。
 *
 * 不按 `viewTop` 扣减：竖向滚动很少（内容通常比视口矮），扣了会让高度随滚动抖动、
 * 每帧触发缓冲区重分配，反而更慢。
 */
const canvasH = computed(() => Math.min(viewH.value, contentDocH.value));

const selInfo = computed(() => {
  const s = selection.value;
  if (!s) return null;
  return describeRange(meters.value, ppq.value, s.startTick, s.endTick, div.value);
});

/**
 * 某个 tick 生效的调性名（最后一根调性竖线）。字母和弦反算级数要用它 ——
 * 没有它「F–G–Em–Am 是不是王道进行」就答不出来（同样的音在不同调里级数不同）。
 */
function keyNameAt(tick: number): string | null {
  let hit: any = null;
  for (const k of keys.value) {
    if (k.tick <= tick) hit = k;
    else break;
  }
  return hit?.keyName ?? null;
}

/**
 * 选中和弦的**进行**识别（王道进行 / 万能和弦进行 / 丸之内进行）。
 *
 * 只看级数序列：转位、低音、大小写都不参与比对（用户明确要求）。
 * 罗马数字泳道直接用 `parsed.degree`；字母和弦用「该 tick 的调性」反算级数，
 * 所以两套泳道都能识别。
 *
 * `dominant7` 必须是**严格属七**（大三 + 小七）：丸之内进行靠它区分
 * `III7`（借来的属七）与调内的 `iii7`，不能用 `chordType === 'dominant'`
 * （那个只看七音，小三 + 小七也会返回 dominant）。
 */
function progressionItemsOf(events: any[]): any[] {
  return events
    .filter((e: any) => CHORD_LANES.has(e.lane) && e.parsed)
    .slice()
    .sort((a: any, b: any) => a.tick - b.tick)
    .map((e: any) => {
      const d = degreeOfChord(e.parsed, keyNameAt(e.tick));
      return d ? { degree: d.degree, dominant7: isDominantSeventh(e.parsed) } : null;
    });
}

const progression = computed(() => {
  const chords = selEvents.value.filter((e: any) => CHORD_LANES.has(e.lane) && e.parsed);
  if (chords.length < 4) return null;
  const items = progressionItemsOf(chords);
  if (items.some((x) => !x)) return null;
  return matchProgression(items as any[]);
});

/**
 * 内部剪贴板（不碰系统剪贴板）。
 *
 * 存「文本 + 相对 tick / 相对泳道」而不是绝对位置：粘到别处、别的泳道都能按相对关系落位。
 */
const clip = ref<null | {
  items: { lane: string; tick: number; durTicks: number; text: string }[];
  baseTick: number;
  baseLane: string;
}>(null);

/** 粘贴会覆盖内容时的确认框（`placed` 先算好，确认后直接写） */
const pasteAsk = ref<null | { count: number; placed: any[] }>(null);

/**
 * 选区命中的**可见**事件 = 矩形命中的 ∪ 离散选中的（去重、按 tick 排）。
 * 删除计数、撤销提示、单选、复制都读它。
 */
const selEvents = computed(() => {
  const s = selection.value;
  const rectHits = !s
    ? []
    : viewEvents.value.filter(
        (e: any) => s.lanes.includes(e.lane) && e.tick < s.endTick && e.tick + e.durTicks > s.startTick
      );
  const picked = pickedEvents.value;
  if (!picked.length) return rectHits;
  const seen = new Set(rectHits.map((e: any) => e.id));
  return [...rectHits, ...picked.filter((e: any) => !seen.has(e.id))]
    .slice()
    .sort((a: any, b: any) => a.tick - b.tick || a.lane.localeCompare(b.lane));
});

/**
 * 与选区**完全重合**的可见事件，按「当前视图的泳道顺序」排好。
 *
 * 顺序不能靠 `analysis.events` 的库序（那是 `ORDER BY tick`，同 tick 谁先谁后
 * 取决于插入顺序）：决定「这条选区属于哪个格子」的应该是**视图**，
 * 罗马数字视图里第一条是「级数」，黎曼视图里第一条是「功能」。
 */
const exactSelEvents = computed(() => {
  const s = selection.value;
  // 没有矩形、只有离散选中时，「完全重合」就等于「选中的那几块」本身
  const hits = !s
    ? pickedEvents.value.slice()
    : selEvents.value.filter((e: any) => e.tick === s.startTick && e.tick + e.durTicks === s.endTick);
  const order = viewLaneIds.value;
  if (!order) return hits;
  return hits.slice().sort((a: any, b: any) => order.indexOf(a.lane) - order.indexOf(b.lane));
});

const selRect = computed(() => {
  const s = selection.value;
  if (!s) return null;
  const geoms = lanesGeom.value.filter((g) => s.lanes.includes(g.lane.id));
  if (!geoms.length) return null;
  const y0 = Math.min(...geoms.map((g) => g.y));
  const y1 = Math.max(...geoms.map((g) => g.y + g.h));
  const x0 = xOfTick(s.startTick);
  const x1 = xOfTick(s.endTick);
  return { x0, y0, x1, y1: Math.min(y1, totalHeight.value) };
});

/**
 * 选区里那一条和弦符号的解析结果（内容与选区完全重合时才算）。
 *
 * 取值规则：**按当前视图的泳道顺序取第一条**；如果那条不是和弦类泳道
 * （功能 `t`、转位 `6`、备注文字本来就没有 `parsed`），再退到同一区间里
 * 第一条和弦类泳道的解析 —— 否则黎曼视图里详情栏永远是空的，
 * 那是「换个视图就看不见和弦音」，同样说不通。
 */
const selParsed = computed(() => {
  const hits = exactSelEvents.value;
  if (!hits.length) return null;
  if (hits[0].parsed) return hits[0].parsed;
  return hits.find((e: any) => CHORD_LANES.has(e.lane))?.parsed ?? null;
});

/**
 * 整首曲子里解析失败的符号数量：不是错误，是待办。
 * **不含**数字低音的「不规范写法」—— 那个照常解析成功，算进来会让工具栏的
 * 「N 个和弦符号解析失败」说谎（用户看到 V56 明明有和弦音，却被告知解析失败）。
 */
const parseWarnCount = computed(
  () => (props.analysis?.events ?? []).filter((e: any) => e.parsed && e.parsed.ok === false).length
);

/* ---------- 动态操作帮助窗口：把「现在」推给它 ---------- */

/**
 * 「现在选中什么」的摘要。
 *
 * 那个窗口自己不读库、不持有网格状态 —— 菜单里那两条只是开关，
 * 内容全靠主窗口推过去的这一份（主进程负责中转，跨窗口拿不到组件状态）。
 */
function helpSummaryNow() {
  const s = selection.value;
  const parsed = selParsed.value;
  return {
    title: props.title ?? '',
    view: props.view?.name ?? '',
    sel: s ? String(selInfo.value?.text ?? '') : '',
    parsed: parsed
      ? parsed.ok
        ? describeWithNumeral(parsed, locale.value)
        : t('grid.unparsable', { why: parsed.errors?.[0] ?? '' })
      : '',
    /** null = 没在输入；空串 = 输入框开着但空着（窗口里这两种写法不一样） */
    editing: editing.value ? editing.value.text : null,
    // 正在编辑哪条泳道：帮助窗据此决定要不要提示「级数行打 h 出半减七」
    editLane: editing.value ? selection.value?.lanes?.[0] ?? null : null,
  };
}

/**
 * 帮助上下文：网格这一半交给 `helpctx` 统一发（它会和「鼠标所在区域」合并成一份 payload）。
 * 以前这里自己 setTimeout 120ms 直接 push，App 那边的区域信息就插不进来了。
 */
/**
 * 历史广播的退订句柄。
 *
 * **必须留好、且只在卸载时调用**：曾经把 `unsubHist?.()` 误写进 `pushHelpSummary()`，
 * 于是每次选区/编辑变化都悄悄退订一次 —— 表现就是「删掉和弦之后重做按钮再也不亮」。
 * 这类「退订放错地方」不会报错，只是功能静静消失，所以句柄的声明和调用点要挨着看。
 */
let unsubHist: (() => void) | null = null;
/** 诊断：广播到过几次、最后一次长什么样（冒烟要它来定位「按钮不亮」） */
let histCalls = 0;
let histLast: any = null;
function pushHelpSummary() {
  // 节流在 helpctx 里做（它还要把「鼠标所在区域」合并进同一份 payload）
  setGridSummary(helpSummaryNow());
}

/* ---------- 数字低音写法：只决定「提不提示」，不决定「解析成什么」 ----------
 *
 * 苏俄体系（斯波索宾）里的「属五六」写成 V56，规范记法是 V65。
 * 解析器永远按规范值算（所以音高、转位都对），这里只控制提示的强弱：
 *   lenient（默认）—— 灰字提示一句
 *   strict        —— 同一个提示改成警示色，并计入工具栏的待办数
 *   ignore        —— 不提
 * 三档都不写库：切开关不需要重算 parsed，也就不会出现「库里是旧的、界面是新的」。
 */
type FigureStyle = 'lenient' | 'strict' | 'ignore';

function readFigureStyle(): FigureStyle {
  try {
    const v = localStorage.getItem('ma-figure-style');
    if (v === 'strict' || v === 'ignore') return v;
  } catch {
    /* 隐私模式读不到，用默认值 */
  }
  return 'lenient';
}
const figureStyle = ref<FigureStyle>(readFigureStyle());

const figureHint = computed(() => {
  if (figureStyle.value === 'ignore') return '';
  const f: any = selParsed.value?.figure;
  if (!f?.found) return '';
  return t('grid.figure.hint', { found: f.found, standard: f.standard });
});

/* ---------- 播放头自动选中 ----------
 *
 * 听的时候不想一直点：播放头进到哪个和弦，就把那一格选中，详情条跟着变。
 * 三档（设置里可切）：
 *   on    —— 选中 + 高亮框
 *   quiet —— 选中但**不画**高亮框（只看详情条，画面不闪）
 *   off   —— 完全不动选区
 *
 * 两条边界（都很容易写错）：
 * 1. 跟随**不需要「手动锁定」**。以前手动动过网格就置一个布尔锁，只有重新起播才解，
 *    于是播放中随手点一下空白，之后就再也不跟着播放头选了 —— 用户看到的
 *    「碰了别处，指针扫过去也不选」就是这个锁。
 *    现在靠既有的交互态（`drag` / `editing` / `bandDrag` / `scrubbing` / `edgeDrag`）判断：
 *    点一下会开输入框，输入框一关掉，下一帧就自动跟回来。**没有需要手动解除的状态**。
 * 2. 选区必须用**和弦事件自己的精确区间**，不能把各泳道事件取 min/max：
 *    `selParsed` 只认「与选区完全重合」的那一条，区间一宽就永远是 null，详情条反而空。
 */
type FollowSelMode = 'on' | 'quiet' | 'off';

function readFollowSel(): FollowSelMode {
  try {
    const v = localStorage.getItem('ma-follow-sel');
    if (v === 'quiet' || v === 'off') return v;
  } catch {
    /* 隐私模式读不到，用默认值 */
  }
  return 'on';
}
const followSel = ref<FollowSelMode>(readFollowSel());

/** 布尔开关的读法：只认 '0' / '1'，读不到就用默认值（隐私模式下 localStorage 会抛） */
function readFlag(key: string, dflt: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    /* 读不到就用默认 */
  }
  return dflt;
}
/** 拖动播放头时顺手选中所在和弦（**独立**于上面那三档：那三档管的是「播放时」） */
const scrubPick = ref(readFlag('ma-scrub-pick', true));
/**
 * 拖播放头划过**没有和弦的格子**时怎么办。
 *
 *   true（默认）= 清空选区：立刻看出「这里没标」，详情栏回到占位
 *   false      = 保持原选区：停在最后命中的那条和弦上，拖过空段时画面不闪
 *
 * 只在「拖动播放头时选中所在和弦」打开时有意义（那一项关掉就根本不会选）。
 */
const scrubClearEmpty = ref(readFlag('ma-scrub-empty', true));
/** 选中动画（低配机器可以关） */
const selAnim = ref(readFlag('ma-sel-anim', true));
/** 粘贴会覆盖内容时先问一句 */
const pasteWarn = ref(readFlag('ma-paste-warn', true));
/**
 * 退出级数标记的输入态时，自动把解析出的低音写进「低音」行。
 *
 * 默认**关**：它会改写已有数据（和弦一改，旧低音就跟着变），这种事不该替用户默认点头。
 * 右键低音行标签或首选项里都能开，同一个 localStorage 键。
 */
const bassAutofill = ref(readFlag('ma-bass-autofill', false));
/**
 * 级数写完后，顺手把**字母和弦**（`G7`）也写进 `chord` 行。
 *
 * 默认关，理由同低音：它会生成用户没敲过的数据。开了以后在罗马数字视图里打级数，
 * 切到字母和弦视图就已经有对应写法了 —— 这是「两份数据」拆分之后唯一省事的补偿办法。
 */
const chordAutofill = ref(readFlag('ma-chord-autofill', false));
/**
 * 级数写完后顺手生成本套体系的斯波索宾标记。
 * 自动只跟**级数**（它是唯一能可靠判断功能的来源）；字母和弦那条走手点菜单。
 */
const sposobinAutofill = ref(readFlag('ma-sposobin-autofill', false));
/**
 * 选中动画：只做「淡入」，140ms，easeOutCubic。
 *
 * 三个边界：
 *   - 只画这一小段时间，静止后不再重绘（播放时不额外吃性能）；
 *   - 播放头自己换和弦（followOwned）不闪 —— 那是跟随，不是用户操作；
 *   - 设置里能关（低配机器 / 不喜欢闪烁）。
 */
const SEL_ANIM_MS = 140;
let selFade = 1;
let selFadeAt = 0;
let selFadeRaf = 0;
function kickSelFade() {
  if (!selAnim.value || followOwned.value) {
    selFade = 1;
    return;
  }
  selFade = 0;
  selFadeAt = performance.now();
  if (selFadeRaf) return;
  const step = () => {
    const p = Math.min(1, (performance.now() - selFadeAt) / SEL_ANIM_MS);
    selFade = 1 - Math.pow(1 - p, 3);
    scheduleDraw();
    if (p < 1) selFadeRaf = requestAnimationFrame(step);
    else {
      selFadeRaf = 0;
      selFade = 1;
    }
  };
  selFadeRaf = requestAnimationFrame(step);
}

/** 当前选区是「播放头给的」：quiet 模式下据此决定画不画高亮框 */
const followOwned = ref(false);

function followSelectAt(tick: number) {
  const a = props.analysis;
  if (!a) return;
  // 只跟随「当前视图看得见」的事件：隐藏泳道里的区间不该把选区拉到自己身上
  const evs: any[] = viewEvents.value;
  const covers = (e: any) => e.tick <= tick && tick < e.tick + e.durTicks;
  // 「和弦行」不写死泳道名：级数是 degree、绝对和弦是 chord，且随视图变
  const anchor = evs.find((e) => CHORD_LANES.has(e.lane) && covers(e)) ?? evs.find(covers);
  if (!anchor) {
    if (selection.value) {
      selection.value = null;
      followOwned.value = true;
      scheduleDraw();
    }
    return;
  }
  const startTick = anchor.tick;
  const endTick = anchor.tick + anchor.durTicks;
  const lanes = [
    ...new Set(evs.filter((e: any) => e.tick < endTick && e.tick + e.durTicks > startTick).map((e: any) => e.lane)),
  ];
  const cur = selection.value;
  const same =
    cur &&
    cur.startTick === startTick &&
    cur.endTick === endTick &&
    cur.lanes.length === lanes.length &&
    cur.lanes.every((l, i) => l === lanes[i]);
  if (same) return;
  selection.value = { lanes, startTick, endTick };
  // 播放头接管 = 用户没在挑块，离散选中跟着作废（否则 Ctrl+点过的块会一直亮着）
  if (pickedIds.value.length) pickedIds.value = [];
  followOwned.value = true;
  scheduleDraw();
}

/**
 * 跟随的前提：**正在播放**、也没在拖 / 选 / 编辑。
 *
 * `audio.playing` 这一条不能省：暂停时播放头不动，可 rAF 还在跑，
 * 每帧都「按播放头重选一遍」会让任何手动选区（含键盘扩选）在一个帧之后被顶掉 ——
 * 表现就是「选区怎么也框不住 / 一闪就没了」。
 *
 * 交互态这几条也是**唯一的**让路机制：点击会开输入框（`editing`），框一关就自动恢复。
 * 不要再加「手动锁定」的布尔量 —— 那会变成「碰一下要重新起播才恢复」。
 */
function canFollow() {
  return (
    followSel.value !== 'off' &&
    audio.playing &&
    // 有离散选中（Ctrl+点挑的块）时跟随让路：那是用户明确挑的，不能被播放头冲掉
    !pickedIds.value.length &&
    !drag &&
    !bandDrag &&
    !scrubbing &&
    !edgeDrag &&
    !editing.value &&
    !bandEdit.value
  );
}

/** quiet 模式只是不画框，选区本身仍然存在（详情条靠它） */
const highlightVisible = computed(() => !(followSel.value === 'quiet' && followOwned.value));

/** 设置里的开关变化：同窗口靠自定义事件，不依赖跨窗口 storage（那个不可靠） */
function onPrefsEvent(ev: Event) {
  const key = (ev as CustomEvent)?.detail?.key;
  if (key === 'followSel') followSel.value = readFollowSel();
  if (key === 'figureStyle') figureStyle.value = readFigureStyle();
  if (key === 'scrubPick') scrubPick.value = readFlag('ma-scrub-pick', true);
  if (key === 'selAnim') selAnim.value = readFlag('ma-sel-anim', true);
  if (key === 'pasteWarn') pasteWarn.value = readFlag('ma-paste-warn', true);
  if (key === 'bassAutofill') bassAutofill.value = readFlag('ma-bass-autofill', false);
  if (key === 'chordAutofill') chordAutofill.value = readFlag('ma-chord-autofill', false);
  if (key === 'sposobinAutofill') sposobinAutofill.value = readFlag('ma-sposobin-autofill', false);
  if (key === 'scrubEmpty') scrubClearEmpty.value = readFlag('ma-scrub-empty', true);
  // 词表在别处被编辑并保存了：重读一次，否则候选要到重启才更新
  if (key === 'chordSymbols') void loadChordTable();
}

/** 编辑框的屏幕坐标：editing 存文档坐标，滚动/缩放时自动跟上 */
const editingView = computed(() => {
  const e = editing.value;
  if (!e) return null;
  return {
    left: LANE_W + e.x - viewLeft.value + 'px',
    top: e.y - viewTop.value + 'px',
    width: e.width + 'px',
  };
});

/**
 * 补全下拉的定位：**优先向下展开**，并且一定留在窗口里、不被别人盖住。
 *
 * 以前是「输入框正下方 20px、position:absolute」——两个坑同时存在：
 * 1. **被裁**：候选框落在 `.canvas-host` 里，而它下方还有详情条/播放条；
 *    那些是同级的后置元素，DOM 顺序靠后 → 有底色 → 直接把候选框盖掉半截。
 *    窗口不够高时又会直接伸出窗口外，那部分根本画不出来。
 * 2. **翻不上去也不行**：只往下摆，最后一行泳道的输入框下面几乎没有空间。
 *
 * 现在：`position: fixed` + Teleport 到 body（没有祖先能裁它、也没有同级的层叠能压它），
 * 坐标按输入框的**屏幕**位置现算，向下装不下就翻到上方，
 * 上下都不够时取空间大的一侧并把 max-height 收到剩余空间（列表自己滚）。
 */
const SUG_MAX_H = 264; // 与 .key-sug 的 max-height 一致；11 条候选（Ca 缩写）要一屏装下
const SUG_ROW_H = 22; // 一行 li 的高度（padding 3+3 + 行高 ≈ 16）
const SUG_PAD_H = 8; // .key-sug 的 padding 3 上 3 下 + 边框
const SUG_MIN_H = 66; // 再挤也留三行，否则只剩一条缝
const SUG_GAP = 2; // 输入框与候选框之间的缝

function sugBox(v: any, anchorH: number, rows: number, minW = 148, maxW = 260): any {
  if (!v) return null;
  // 显式「用一下」面板尺寸：只读 getBoundingClientRect 不会被追踪，
  // 窗口缩放/拖动改变面板位置时这个 computed 就不会重算（候选框停在空中）
  void hostW.value;
  void hostH.value;
  const hostEl = host.value;
  const hr = hostEl ? hostEl.getBoundingClientRect() : ({ left: 0, top: 0 } as DOMRect);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const requested = parseFloat(v.width);
  let w = Math.max(minW, Math.min(maxW, Number.isFinite(requested) ? requested : minW));
  // 窄窗口里别让候选框比窗口还宽（左边缘会贴到 4px，右边被切掉）
  w = Math.min(w, Math.max(200, vw - 8));
  const ax = hr.left + parseFloat(v.left);
  const ay = hr.top + parseFloat(v.top);
  const need = Math.min(SUG_MAX_H, rows * SUG_ROW_H + SUG_PAD_H);
  // 下面按「窗口底边」算而不是面板底边：候选框本来就可以压过详情条/播放条（它是浮层），
  // 真正的硬边界只有窗口
  const roomBelow = vh - 4 - (ay + anchorH + SUG_GAP);
  const roomAbove = ay - SUG_GAP - 4;
  let top: number;
  let maxH: number;
  if (need <= roomBelow) {
    top = ay + anchorH + SUG_GAP;
    maxH = need;
  } else if (roomAbove > roomBelow) {
    maxH = Math.min(need, roomAbove);
    top = ay - SUG_GAP - maxH;
  } else {
    top = ay + anchorH + SUG_GAP;
    maxH = Math.max(SUG_MIN_H, Math.min(need, roomBelow));
  }
  const left = Math.round(Math.min(Math.max(4, ax), Math.max(4, vw - w - 4)));
  return {
    left: left + 'px',
    top: Math.round(top) + 'px',
    width: w + 'px',
    maxHeight: Math.round(maxH) + 'px',
  };
}

/** 补全下拉贴在输入框正下方（放不下会翻到上方，见 sugBox）；比输入框宽一点，长符号才不会被截断 */
const cellSugView = computed(() => {
  const v = editingView.value;
  if (!v) return null;
  // 和弦补全比调性补全宽：一行放得下「符号 + 说明 + 别名」，不让它换行
  return sugBox(v, 20, cellSug.value.items.length || 4, 320, 460);
});

/**
 * 「锚定」：把选区起点对到播放头现在的位置。
 * 这是对轨最常用的一步 —— 听到真正的第一拍，点一下，offset 就定下来了。
 */
async function alignSelectionToPlayhead() {
  const s = selection.value;
  const a = props.analysis;
  if (!s || !a || !audio.ready) return;
  const offset = Math.round((audio.currentMs || 0) - relMsOfTick(a, tempos.value, s.startTick));
  /**
   * 偏移逐版本：对的是「现在在听的那一版」，写库也必须落到那一版上。
   * 写成作品级（analysis.audio_offset_ms）就会在试听别的版本时把主版本的原点改掉。
   * 独立窗口里没有音频宿主（recId 为空），那就写主录音，和它显示的口径一致。
   */
  await (window as any).api.recording.setOffset(a.trackId, audio.recId || null, offset);
  lastAction.value = { key: 'grid.act.origin', vars: { ms: offset } };
  emit('changed');
}

function toggleFollow() {
  setFollow(!audio.follow);
}

// computeStartBars 来自 shared/barbeat.js（主进程与 node --test 用的是同一份）

function barToX(bar: number) {
  return (bar - 1) * pxPerBar.value;
}

function gridOfBar(bar: number) {
  return gridAt(meters.value, ppq.value, bar, div.value);
}

/** tick → 横坐标：小节起点 + 小节内线性比例（变拍号时每小节宽度相同） */
function xOfTick(tick: number) {
  const bb = tickToBarBeat(meters.value, tick, ppq.value);
  const bar = Math.max(1, bb.bar);
  const g = gridOfBar(bar);
  const barLen = g.meter?.barLen ?? ppq.value * 4;
  return barToX(bar) + ((tick - g.barTick) / barLen) * pxPerBar.value;
}

function tickAtX(x: number) {
  const bar = Math.max(1, Math.min(totalBars.value, Math.floor(x / pxPerBar.value) + 1));
  const g = gridOfBar(bar);
  const cw = pxPerBar.value / g.cells;
  const cell = Math.max(0, Math.min(g.cells - 1, Math.floor((x - barToX(bar)) / cw)));
  return { bar, cell, tick: cellStart(g, cell), grid: g };
}

function laneIndexAtY(y: number) {
  return lanesGeom.value.findIndex((g) => y >= g.y && y < g.y + g.h);
}

function laneIdsBetween(a: number, b: number) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lanes.value.slice(lo, hi + 1).map((l: any) => l.id);
}

function laneIndexOf(id: string) {
  return lanes.value.findIndex((l: any) => l.id === id);
}

/** 连续的 x → tick（不吸附到格）：波形与播放头需要「像素级」的连续映射 */
function tickAtXExact(x: number) {
  const bar = Math.max(1, Math.min(totalBars.value, Math.floor(x / pxPerBar.value) + 1));
  const g = gridOfBar(bar);
  const barLen = g.meter?.barLen ?? ppq.value * 4;
  return g.barTick + ((x - barToX(bar)) / pxPerBar.value) * barLen;
}

/** 视口内可见的小节区间（闭区间）：重绘只画这些，zoom 多大都不多画 */
function visibleBars() {
  const from = Math.max(1, Math.floor(viewLeft.value / pxPerBar.value) + 1);
  const to = Math.min(
    totalBars.value,
    Math.ceil((viewLeft.value + viewW.value) / pxPerBar.value) + 1
  );
  return { from, to };
}

/* ---------- 波形带：双层位图（TallyDeck 式） ----------
 * 底/热两张离屏位图只在「视图 / 尺寸 / 主题 / 波形数据」变化时重建；
 * 播放中每帧只做 clearRect + drawImage(底) + clip + drawImage(热)，
 * 已播放部分是波形本身颜色加深，不是盖一块半透明色块。
 */
let layerBase: HTMLCanvasElement | null = null;
let layerHot: HTMLCanvasElement | null = null;
/**
 * `bandDiff()` 专用的小离屏画布（CPU 后端）。
 * 主画布必须留在 GPU 上；调试钩子把要采样的一块 drawImage 过来，
 * 再在这张 `willReadFrequently: true` 的画布上 getImageData —— 警告和回读都只发生在这里。
 */
let probeCanvas: HTMLCanvasElement | null = null;
let bandBuilt = false;
let waveDirty = true;
let waveKey = '';
let themeVer = 0;
let peaksVer = 0;

function buildWaveLayers(c: any) {
  const w = Math.max(1, Math.floor(viewW.value));
  const bandH = waveH.value;
  const dpr = window.devicePixelRatio || 1;
  if (!layerBase) layerBase = document.createElement('canvas');
  if (!layerHot) layerHot = document.createElement('canvas');
  for (const L of [layerBase, layerHot]) {
    L!.width = Math.floor(w * dpr);
    L!.height = Math.floor(bandH * dpr);
  }
  const bctx = layerBase.getContext('2d')!;
  const hctx = layerHot.getContext('2d')!;
  for (const ctx of [bctx, hctx]) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = c.surface;
    ctx.fillRect(0, 0, w, bandH);
  ctx.font = RULER_FONT;
    ctx.textBaseline = 'middle';
  }
  const paintText = (t: string) => {
    for (const ctx of [bctx, hctx]) {
      ctx.fillStyle = c.faint;
      ctx.fillText(t, 8, bandH / 2);
    }
  };

  const pk = audio.peaks;
  if (!pk) {
    paintText(audio.decoding ? t('grid.decoding') : t('grid.audioNotReady'));
  } else {
    const analysis = props.analysis;
    const tem = tempos.value;
    const mid = bandH / 2;
    const amp = (mid - 2) / (pk.peaksAbsMax || 1);
    // 视口像素 → 毫秒：x 先换成文档坐标再走 tick 换算
    const msAt = (vx: number) => audioMsOfTick(analysis, tem, tickAtXExact(viewLeft.value + vx));
    const totalMs = pk.duration * 1000;
    // 选层：按「可见区间的平均每像素采样数」挑，缩放时不会越画越慢
    const spanMs = Math.max(1, msAt(w) - msAt(0));
    const level = pickLevel(pk, (pk.sampleRate * spanMs) / 1000 / Math.max(1, w));
    if (level) {
      const path = new Path2D();
      let any = false;
      for (let vx = 0; vx < w; vx++) {
        const ms0 = msAt(vx);
        const ms1 = msAt(vx + 1);
        if (ms1 < 0 || ms0 > totalMs) continue;
        const s0 = Math.max(0, Math.floor((ms0 / 1000) * pk.sampleRate));
        const s1 = Math.max(s0 + 1, Math.ceil((ms1 / 1000) * pk.sampleRate));
        const r = peakRange(pk, level, s0, s1);
        if (!r) continue;
        const y0 = mid - Math.max(0.5, r.max * amp);
        const y1 = mid + Math.max(0.5, -r.min * amp);
        path.rect(vx, y0, 1, Math.max(1, y1 - y0));
        any = true;
      }
      if (!any) {
        paintText(t('grid.noOverlap'));
      } else {
        // 底 = 半透明浅色；热 = 实心深色 —— 「变深」就是这两层的差
        bctx.fillStyle = `rgba(${c.accentRgb}, 0.4)`;
        bctx.fill(path);
        hctx.fillStyle = `rgba(${c.accentRgb}, 0.95)`;
        hctx.fill(path);
      }
      // 中线：热层更实，扫过去的时候中线也跟着沉下去
      for (const [ctx, alpha] of [[bctx, 0.22], [hctx, 0.55]] as const) {
        ctx.strokeStyle = `rgba(${c.accentRgb}, ${alpha})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid + 0.5);
        ctx.lineTo(w, mid + 0.5);
        ctx.stroke();
      }
    }
  }

  // 波形带里的小节竖线画淡一点，别盖住波峰（两层都画，免得热层扫过时竖线消失）
  const { from, to } = visibleBars();
  const step = pxPerBar.value >= 40 ? 1 : pxPerBar.value >= 24 ? 2 : 4;
  for (const ctx of [bctx, hctx]) {
    ctx.strokeStyle = 'rgba(128,128,128,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let bar = from; bar <= to; bar++) {
      if ((bar - 1) % step !== 0) continue;
      const x = Math.round(barToX(bar) - viewLeft.value) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, bandH);
    }
    ctx.stroke();
    // 底边线
    ctx.strokeStyle = c.lineStrong;
    ctx.beginPath();
    ctx.moveTo(0, bandH - 0.5);
    ctx.lineTo(w, bandH - 0.5);
    ctx.stroke();
  }
}

/** 播放头在视口内的 x（CSS 像素）；不在视口/未就绪时为负 */
function playheadSx(ms?: number) {
  if (!audio.ready || !props.analysis) return -1;
  const tick = playheadTick(ms);
  const docX = tick <= 0 ? 0 : xOfTick(tick);
  return docX - viewLeft.value;
}

/** 每帧（播放/seek 时）：重画波形带这一条。两次 drawImage + 一次裁剪，零点几毫秒 */
function paintBand(sxCss?: number) {
  const el = canvas.value;
  if (!el || !bandBuilt || waveH.value <= 0 || !layerBase || !layerHot) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = el.getContext('2d')!;
  const bandPxH = layerBase.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.width, bandPxH);
  ctx.drawImage(layerBase, 0, 0);
  const sx = sxCss ?? playheadSx();
  const px = Math.max(0, Math.min(el.width, sx * dpr));
  if (px > 0.5) {
    ctx.beginPath();
    ctx.rect(0, 0, px, bandPxH);
    ctx.clip();
    ctx.drawImage(layerHot, 0, 0);
  }
  ctx.restore();
  perf.hotBlits++;
}

/* ---------- 事件方块 ---------- */

function drawEvent(
  ctx: CanvasRenderingContext2D,
  c: any,
  e: any,
  x0: number,
  x1: number,
  y: number,
  lh: number,
  alpha = 1,
  ghost = false,
  /** 落在这块选区里：底色已经是浅绿了，不要再叠一层 16% 底，字改成深墨色 */
  onSel = false
) {
  const ew = Math.max(3, x1 - x0);
  // 行高收到 16 之后上下只留 1px：再多就把字挤出泳道
  const top = y + 1;
  const bh = lh - 2;
  // 解析失败只是「待修」，不阻断录入：标黄提醒，文本照旧
  const bad = e.parsed && e.parsed.ok === false;

  ctx.save();
  /**
   * 字宽按可用宽度收一档。
   *
   * `iii6/III` 这类长符号在一拍宽（zoom=1 时 14px）的格子里必然放不下，
   * 缩小时最先看起来「溢出格子」。不做省略号（和弦符号截半截更看不懂），
   * 而是把字号往下压，最小 9px —— 缩得动就还能读，缩不动才交给右边的 clip 裁。
   */
  const text = String(e.text ?? '');
  let fsz = CHORD_FONT_SIZE;
  ctx.font = chordFont(c, fsz);
  const avail = Math.max(0, ew - 7);
  const tw0 = text ? ctx.measureText(text).width : 0;
  // 带 𝄪/𝄫 的文本实际会再宽一点（那两个记号放大 25%，各约 +1px），量宽时按 1.08 倍预留
  const tw = BIG_ACCIDENTAL.test(text) ? tw0 * 1.08 : tw0;
  if (avail > 4 && tw > avail) fsz = Math.max(9, Math.floor((fsz * avail) / tw));
  ctx.font = chordFont(c, fsz);
  if (!onSel) {
    /**
     * 先铺一层**不透明**的底。
     *
     * 只铺 16% 的淡色时，底下的小节线 / 拍线会从块里透出来，一条和弦看着像被切成几格。
     * 实心底 + 淡色罩 = 「这一格被内容占住了」，格线在块内自然消失（选区里的块不铺，
     * 否则会把选区的整块底色盖掉）。拖动中的幽灵/淡出预览保持半透明，不然就看不出是预览。
     */
    if (alpha === 1 && !ghost) {
      ctx.fillStyle = c.surface;
      ctx.fillRect(x0 + 0.5, top, ew - 1, bh);
    }
    ctx.globalAlpha = alpha * 0.16;
    ctx.fillStyle = bad ? c.warn : c.accent2;
    ctx.fillRect(x0 + 0.5, top, ew - 1, bh);
  }
  ctx.globalAlpha = alpha;

  // 左侧立标：同一条和弦跨几格，一眼看出起点
  ctx.fillStyle = ghost ? c.accent : bad ? c.warn : e.confidence === 'confirmed' ? c.accent2 : c.faint;
  ctx.fillRect(x0 + 0.5, top, 1.5, bh);

  if (ghost) {
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 1, top + 0.5, Math.max(1, ew - 2), bh - 1);
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.rect(x0 + 3, y, Math.max(0, ew - 5), lh);
  ctx.clip();
  ctx.fillStyle = onSel
    ? c.selInk
    : ghost ? c.accent : bad ? c.warn : e.confidence === 'confirmed' ? c.text : c.dim;
  paintChordText(ctx, text, x0 + 5, y + lh / 2);
  ctx.restore();
}

/**
 * 圆角矩形路径。
 *
 * 不用 `ctx.roundRect` 是为了行为在旧 Chromium 上也一致（它是后来才有的 API），
 * 而且这里只要一个半径，自己画 4 段二次曲线比到处判断兼容性省事。
 */
function roundRectPath(ctx: any, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/**
 * 选区圆角半径（px）。行高只有 16px，4 是「明显圆角但还没变胶囊」的上限；
 * 再大在 14px 宽的单格里就会把两条竖边吃掉，看起来像药丸。
 */
const SEL_RADIUS = 4;

/**
 * 头带左缘的「我还在哪一段 / 哪个调上」提示。
 *
 * 段落条和调性条都是「一个点 + 延续到下一个标记」：横向翻页之后，那根起点线连同
 * 它的文字一起跑到视口左边外面，画面就只剩一条没头没尾的色带 —— 播放到一半
 * 完全不知道自己现在在哪一段。这里在视口左缘补一个**灰字、带括号**的副本。
 *
 * 只在「这一段的起点确实在视口左边之外」时才画，所以正常视窗里不会多出任何东西。
 */
/**
 * 视口左缘落在哪一条标记里（起点已经滚出左边时才返回，否则 null）。
 * 抽成纯函数是为了能被断言 —— canvas 上画了什么没法直接查。
 */
function stickyBandMarker(kind: BandKind, vl: number) {
  const rows = bandRows(kind);
  let cur: any = null;
  for (const m of rows) {
    // +5 是标签文字相对竖线的缩进：连文字都还没露头才算「看不见」
    if (xOfTick(m.tick) + 5 < vl) cur = m;
    else break;
  }
  return cur;
}

/**
 * 右边第一条**真标签文字**的起点（文档坐标），没有就是 +∞。
 *
 * 这是 sticky 标签的硬边界：它绝不能压到这条标签上。
 * 注意列的是「实际会画出来的那份列表」（段落用 `sections`、调性用 `keys`），
 * 不是 `bandRows` —— 段落条在没有真段落时会画一条假段落 `—`，那是真的要占位的。
 */
function nextBandLabelX(kind: BandKind, vl: number) {
  const rows: any[] = kind === 'section' ? sections.value : keys.value;
  const inset = kind === 'section' ? 5 : 4;
  for (const m of rows) {
    const x = xOfTick(m.tick) + inset;
    if (x >= vl) return x;
  }
  return Infinity;
}

/** sticky 标签：最大宽度、与真标签之间的最小空隙、再窄就不画了的阈值 */
const STICKY_MAX_W = 220;
const STICKY_GAP = 6;
const STICKY_MIN_W = 40;

/** 把一段文字裁到 maxW 以内（结尾补省略号）。canvas 没有 text-overflow，只能自己量 */
function fitStickyText(text: string, maxW: number, measure: (s: string) => number) {
  if (measure(text) <= maxW) return text;
  for (let n = text.length - 1; n > 0; n--) {
    const cand = text.slice(0, n).trimEnd() + '…';
    if (measure(cand) <= maxW) return cand;
  }
  return '…';
}

/**
 * 算一条 sticky 标签该怎么画（宽度、要不要截断、或者干脆不画）。
 *
 * 返回 `skipped: true` 表示「这一格实在放不下」：宁可什么都不画，也不能压住右边的真标签 ——
 * 那正是用户报的「A1 被（Intro）完全盖住」。此时真标签就在旁边，信息并不缺。
 */
function stickyChipPlan(kind: BandKind, vl: number, measure: (s: string) => number) {
  const cur = stickyBandMarker(kind, vl);
  if (!cur) return null;
  const text = bandText(cur, kind);
  if (!text) return null;

  const nextX = nextBandLabelX(kind, vl);
  const avail = Math.min(STICKY_MAX_W, nextX - vl - STICKY_GAP);
  const base = { marker: cur, text, nextLabelX: nextX };
  if (!(avail >= STICKY_MIN_W)) return { ...base, skipped: true, label: '', width: 0 };

  const open = String(t('grid.band.open'));
  const close = String(t('grid.band.close'));
  const innerW = Math.max(0, avail - 8 - measure(open) - measure(close));
  const label = open + fitStickyText(text, innerW, measure) + close;
  // 兜底：万一连括号都放不下（极端窄），退回只显示内容
  const shown = measure(label) <= avail - 8 ? label : fitStickyText(label, avail - 8, measure);
  return { ...base, skipped: false, label: shown, width: Math.min(avail, Math.max(24, measure(shown) + 8)) };
}

/**
 * 头带左缘的「我还在哪一段 / 哪个调上」提示。
 *
 * 段落条和调性条都是「一个点 + 延续到下一个标记」：横向翻页之后，那根起点线连同
 * 它的文字一起跑到视口左边外面，画面就只剩一条没头没尾的色带 —— 播放到一半
 * 完全不知道自己现在在哪一段。这里在视口左缘补一个**灰字、带括号**的副本。
 *
 * 只在「这一段的起点确实在视口左边之外」时才画，所以正常视窗里不会多出任何东西。
 */
function drawStickyChip(ctx: any, c: any, kind: BandKind, vl: number, plan: any) {
  if (!plan || plan.skipped) return;
  const y0 = bandStripY(kind);
  const h = bandStripH(kind);
  ctx.save();
  ctx.font = RULER_FONT;
  // 垫一层底色：底下是段落色带 / 调性线，不垫会读不清
  ctx.fillStyle = kind === 'key' ? c.bg : c.surface;
  ctx.fillRect(vl, y0 + 1, plan.width, h - 2);
  ctx.fillStyle = c.faint;
  ctx.fillText(plan.label, vl + 4, y0 + h / 2);
  ctx.restore();
}

/* ---------- 播放头 ---------- */

/**
 * 帧循环里最后一次已知的音频时间（毫秒）。
 *
 * 为什么必须有它：`audio.currentMs` 是**每 70ms** 才写一次的（store.js 的 startLoop 为了省渲染），
 * 而 draw() 结尾要摆一次播放头。如果那里回退到 `currentMs`，播放中每次重绘都会把播放头
 * （以及跟随选区）推回 70ms 之前 —— 表现就是「换和弦时详情栏闪一下旧内容再变回来」。
 */
let lastFrameMs: number | null = null;

function playheadTick(ms?: number) {
  const a = props.analysis;
  if (!a) return 0;
  return tickOfAudioMs(a, tempos.value, ms ?? lastFrameMs ?? audio.currentMs ?? 0);
}

/**
 * 只摆位置：draw() 结尾、主题/尺寸变化时调它。
 * **绝不在这里改选区** —— draw() 会被「选区变了」这件事本身触发，让它反推选区就成了
 * 「选区变 → 重绘 → 选区变回去 → 下一帧再变回来」的循环，也就是用户看到的闪烁。
 */
function layoutPlayhead(ms?: number): number | null {
  const el = playheadEl.value;
  if (!el) return null;
  if (!audio.ready || !props.analysis) {
    el.style.opacity = '0';
    return null;
  }
  const sx = playheadSx(ms);
  el.style.opacity = sx >= -2 && sx <= viewW.value + 2 ? '1' : '0';
  /**
   * **不要 `Math.round`。** 0.50× 网格缩放时播放头每秒只走十几像素，取整会变成
   * 「三四帧才跳 1px」的阶梯，看起来就是抖动/闪烁；0.5× 越窄越明显。
   * 亚像素 transform 让合成器每帧都能插值（1px 线在高 DPR 下仍然清晰）。
   */
  el.style.transform = `translate3d(${sx.toFixed(2)}px,0,0)`;
  return sx;
}

/**
 * 每帧调用（带 ms）/ 显式定位。
 *
 * 只有**帧循环传来的 ms** 才允许驱动跟随选中：其它调用点（watch、resize、主题重绘）
 * 手上没有当帧时间，用任何回退值都会落后于真实播放位置。
 */
function updatePlayhead(ms?: number) {
  const sx = layoutPlayhead(ms);
  if (sx == null) return;
  const beforeLeft = viewLeft.value;
  const docX = sx + beforeLeft;
  if (ms != null && canFollow()) followSelectAt(playheadTick(ms));
  if (ms != null) revealOnExternalSeek(ms, sx);
  /**
   * 跟随滚动必须和播放头位置**同一帧**提交。
   *
   * 以前先 layout（用旧 viewLeft 算 x）再 followIfNeeded（改 scrollLeft），
   * 这一帧播放头还停在旧 x，下一帧才补 —— 翻页那一瞬间就是「闪一下/抖一下」。
   * 现在滚动后立刻用新 viewLeft 重摆一次，再交给 scheduleDraw 重画。
   */
  const scrolled = followIfNeeded(docX);
  if (scrolled || viewLeft.value !== beforeLeft) {
    layoutPlayhead(ms);
    return;
  }
  paintBand(sx);
}

/** 上一次「外部 seek 探测」看到的位置：用来认出「位置突然跳变」 */
let lastProbeMs = -1;

/**
 * 外部 seek 的翻页（v0.37）。
 *
 * 网格里自己拖播放头走 `scrubbing` 分支（边拖边滚）；但**播放条上的进度条**是另一个组件，
 * 它只调 `seekAudio()`，网格这边唯一的线索就是「位置突然跳变」——
 * 正常播放一帧才几十毫秒，跳超过 600ms 一定是 seek。
 *
 * 余量固定 96px，和详情面板双击跳转、播放跟随同一套视觉约定：
 * 光标一出视窗就把它捞回来，但不会每帧抢滚动条。
 */
function revealOnExternalSeek(ms: number, sx: number) {
  const prev = lastProbeMs;
  lastProbeMs = ms;
  if (!props.analysis) return;
  if (scrubbing || drag || bandDrag || edgeDrag) return;
  if (prev >= 0 && Math.abs(ms - prev) < 600) return;
  const margin = 96;
  if (sx < 0) setScrollLeft(sx + viewLeft.value - margin);
  else if (sx > viewW.value - margin) setScrollLeft(sx + viewLeft.value - viewW.value + margin);
}

/** 播放头跑出视野才滚，别每帧都抢滚动条。返回是否真的滚了。 */
function followIfNeeded(docX: number): boolean {
  if (!audio.follow || !audio.playing) return false;
  const from = viewLeft.value;
  const to = from + viewW.value;
  // 已经在最左端就不要「往左追」：scrollLeft 已经在 0，再调一次只会空转，
  // 却让每帧都 fallback 到整网重绘（起播那半秒的掉帧就出在这儿）。
  if (docX < from + 16 && from > 0) {
    const target = Math.max(0, docX - 72);
    if (target >= from - 0.5) return false;
    setScrollLeft(target);
    return true;
  }
  if (docX > to - 48) {
    /**
     * 已经滚到最右就别再每帧调 setScrollLeft：`scrollLeft` 会被浏览器钳在 max，
     * 但 target 还在涨 → 每帧都「位置变了」→ 每帧整网重绘，结尾会抖且费 CPU。
     */
    const box = scroller.value;
    const max = box ? Math.max(0, box.scrollWidth - box.clientWidth) : 0;
    if (from >= max - 0.5) return false;
    const target = Math.min(max, docX - 72);
    if (target <= from + 0.5) return false;
    setScrollLeft(target);
    return true;
  }
  return false;
}

/**
 * 移动播放头，并在设置允许时放一小段声音（用户 2026-11-23）。
 *
 * `fromKeys`：这次移动是不是来自 `Ctrl+Alt` 快捷键 —— 「仅在快捷键上响」
 * 那个范围设置靠它分派。其余位置（点网格、拖播放头）一律传 false。
 */
/** 顶栏那个「扫过发声」开关：只翻开关，时长与范围留在选项里 */
function toggleScrubAudio() {
  saveStepPrefs({ scrubOn: !stepPrefs.value.scrubOn });
}

function seekWithScrub(ms: number, fromKeys: boolean) {
  seekAudio(ms);
  if (shouldScrub(fromKeys)) scrubPulse(scrubDurationMs());
}

function seekAtX(x: number) {
  if (!props.analysis || !audio.ready) return;
  const tick = Math.max(0, tickAtXExact(x));
  seekWithScrub(audioMsOfTick(props.analysis, tempos.value, tick), false);
  if (scrubPick.value) scrubPickAt(tick);
}

/**
 * 拖动播放头时，把指针所在的和弦块选中（没有和弦就选中那一格）。
 *
 * 这是**独立的**一个开关：上面那三档（启用 / 不高亮 / 禁用）管的是「播放时跟随」，
 * 这里管的是「手动拖播放头」。拖动期间 `canFollow()` 恒为 false（它有 scrubbing 条件），
 * 所以拖出来的选区不会被跟随逻辑立刻顶掉。
 */
/**
 * 选中某个 tick 处的「单元」：**优先整块和弦**，没有和弦才退到那一格。
 *
 * 双击段落跳转和「拖播放头选中」共用这一份 —— 两处对「到底选中什么」必须是同一个答案
 * （用户明确要求跳转要选中整个和弦，而不是只框住第一格）。
 */
function selectUnitAt(tick: number, opts: { requireEvent?: boolean } = {}) {
  const evs = viewEvents.value;
  const hit =
    evs.find((e: any) => CHORD_LANES.has(e.lane) && e.tick <= tick && tick < e.tick + e.durTicks) ??
    evs.find((e: any) => e.tick <= tick && tick < e.tick + e.durTicks);
  pickedIds.value = [];
  if (hit) {
    selection.value = { lanes: [hit.lane], startTick: hit.tick, endTick: hit.tick + hit.durTicks };
    return true;
  }
  // 空格子：拖播放头时不选（保持原来的选区），跳段落时仍然选一格
  if (opts.requireEvent) return false;
  const laneId = lanes.value[0]?.id;
  if (!laneId) return false;
  const cell = cellAtTick(meters.value, ppq.value, tick, div.value);
  selection.value = { lanes: [laneId], startTick: cell.start, endTick: Math.round(cell.start + cell.grid.cellTicks) };
  return true;
}

/**
 * 拖播放头时顺手选中所在和弦（开关见 scrubPick）。
 *
 * 划过**没有和弦的格子**时什么都不做：选区停在最后命中的那一条上。
 * 以前会退而选「那一格」，于是拖过空段时选区一直闪、详情栏一会儿有一会儿空。
 */
function scrubPickAt(tick: number) {
  if (selectUnitAt(tick, { requireEvent: true })) {
    followOwned.value = false;
    return;
  }
  // 空格子（没有和弦）：默认清空；关掉就保持原选区
  if (!scrubClearEmpty.value) return;
  if (!selection.value && !pickedIds.value.length) return; // 本来就是空的，别白重绘
  selection.value = null;
  pickedIds.value = [];
  pickAnchor = null;
  followOwned.value = false;
  scheduleDraw();
}

/* ---------- 拖到视口边缘时自动滚动 ---------- */

/** 边缘感应带（px）与每帧最大位移 */
const EDGE_BAND = 36;
const EDGE_MAX_V = 18;
let edgeScrollRaf = 0;
/**
 * 拖动中指针出界时的做法：**指针没动，但视图滚了**，所以文档坐标变了 ——
 * 每帧都要用同一个 clientX/Y 重算一次落点。`apply` 就是那一步（拖播放头 = seek，
 * 框选 = 重算矩形）。
 */
let lastEdge: null | { clientX: number; clientY: number; apply: (docX: number, docY: number) => void } = null;

/** 指针离左右边缘多近 → 每帧往那个方向推多少像素（越靠外越快） */
function edgeScrollVelocity(clientX: number) {
  const cv = canvas.value;
  if (!cv) return 0;
  const r = cv.getBoundingClientRect();
  const left = r.left + LANE_W;
  if (clientX < left + EDGE_BAND) {
    return -Math.min(EDGE_MAX_V, Math.ceil((left + EDGE_BAND - clientX) / 2));
  }
  if (clientX > r.right - EDGE_BAND) {
    return Math.min(EDGE_MAX_V, Math.ceil((clientX - (r.right - EDGE_BAND)) / 2));
  }
  return 0;
}

/**
 * 拖播放头出界时持续滚动。
 * 指针本身没动，但视图滚了 → 文档坐标变了，所以每帧要**用同一个 clientX 重算**一次定位。
 */
function armEdgeScroll(clientX: number, clientY: number, apply: (docX: number, docY: number) => void) {
  lastEdge = { clientX, clientY, apply };
  // 指针回到界内：停 rAF（但保留 lastEdge，下一次出界能接着用）
  if (!edgeScrollVelocity(clientX)) {
    if (edgeScrollRaf) cancelAnimationFrame(edgeScrollRaf);
    edgeScrollRaf = 0;
    return;
  }
  if (edgeScrollRaf) return;
  const step = () => {
    edgeScrollRaf = 0;
    if (!lastEdge) return;
    const v = edgeScrollVelocity(lastEdge.clientX);
    if (!v) return;
    const box = scroller.value;
    if (!box) return;
    const before = box.scrollLeft;
    box.scrollLeft = Math.max(0, before + v);
    if (box.scrollLeft === before) return;   // 已经顶到头，别空转 rAF
    viewLeft.value = box.scrollLeft;
    const rect = canvas.value!.getBoundingClientRect();
    lastEdge.apply(
      Math.max(0, lastEdge.clientX - rect.left + viewLeft.value),
      lastEdge.clientY - rect.top + viewTop.value
    );
    scheduleDraw();
    edgeScrollRaf = requestAnimationFrame(step);
  };
  edgeScrollRaf = requestAnimationFrame(step);
}

function stopEdgeScroll() {
  if (edgeScrollRaf) cancelAnimationFrame(edgeScrollRaf);
  edgeScrollRaf = 0;
  lastEdge = null;
}

/* ---------- 滚动 ---------- */

function onScroll() {
  const box = scroller.value;
  if (!box) return;
  if (box.scrollLeft === viewLeft.value && box.scrollTop === viewTop.value) return;
  viewLeft.value = box.scrollLeft;
  viewTop.value = box.scrollTop;
  scheduleDraw();
}

/** 写滚动位置并立即同步视图状态（不等 scroll 事件回来，避免这一帧用旧视图画） */
function setScrollLeft(v: number) {
  const box = scroller.value;
  if (!box) return;
  const next = Math.max(0, v);
  // 位置没变就别排重绘：播放头每帧都会调到这里，空转一次就是一次整网重绘
  if (next === viewLeft.value && box.scrollLeft === next) return;
  box.scrollLeft = next;
  if (box.scrollLeft !== viewLeft.value) {
    viewLeft.value = box.scrollLeft;
  }
  scheduleDraw();
}

/* ---------- 拖动移动 ---------- */

interface MoveItem {
  id: string;
  lane: string;
  tick: number;
  durTicks: number;
  text: string;
  confidence?: string;
  parsed?: any;
}

let moveDrag: null | {
  items: MoveItem[];
  /** 按下时指针所在的 tick 与泳道下标 */
  anchorTick: number;
  anchorLane: number;
  dTick: number;
  dLane: number;
  active: boolean;
  /** 按住 Alt 起手：松手写一份新的，原来那条不动 */
  copy: boolean;
} = null;

/**
 * canvas 的 width/height 属性一旦赋值，浏览器就要重新分配整块后备缓冲区。
 * 视口化之后缓冲区只有视口大小（~1700×600），且缩放/滚动完全不改变它 ——
 * 只有窗口尺寸或 DPR 真的变了才重分配。
 */
let canvasPxW = 0;
let canvasPxH = 0;
let cssW = 0;
let cssH = 0;
/**
 * 上面这几个缓存属于**哪一个 canvas 元素**。
 *
 * 模板里的 canvas 在 `v-if="analysis"` 里。一旦中途出现过「没有分析档案」
 * （删除作品、或者点开一首还没分析的曲子），Vue 会把整个 canvas 换掉：
 * 新元素的 width/height 是浏览器默认的 300×150，而缓存里记的还是老尺寸 ——
 * `syncCanvasSize()` 一比「没变化」就返回，于是新画布永远停在 300×150：
 * 网格被挤在左上角一小块、刻度和泳道拉花，看起来就是「时间线渲染异常」。
 *
 * 缓存必须跟着元素身份走：换了元素就全部作废，让下面重新算一遍。
 */
let sizeEl: HTMLCanvasElement | null = null;

/**
 * 换元素就作废全部尺寸缓存。
 *
 * **必须在「后备缓冲区要不要重分配」那次判断之前调用** —— 否则新元素的
 * `width/height` 还是浏览器默认的 300×150，而缓存里是老尺寸，判断为「没变化」，
 * 位图就永远停在 300×150（CSS 尺寸却是对的，于是画面被拉伸）。
 */
function ensureCanvasEl(el: HTMLCanvasElement) {
  if (el === sizeEl) return;
  sizeEl = el;
  cssW = -1;
  cssH = -1;
  canvasPxW = -1;
  canvasPxH = -1;
  // 波形层是按「视口位图」建的，换元素后必须重建，否则贴上去的是别人尺寸的图
  waveKey = '';
  waveDirty = true;
  bandBuilt = false;
}

/** 只同步 CSS 尺寸（布局用），不碰后备缓冲区 */
function syncCanvasSize() {
  const el = canvas.value;
  if (!el) return;
  ensureCanvasEl(el);
  /**
   * CSS 尺寸要跟**位图**严格对应，不能直接用 `viewW`。
   *
   * 位图是 `round(viewW × dpr)` 个设备像素；如果 style 仍写 `viewW` px，
   * 浏览器要把这张位图铺到 `viewW × dpr` 个设备像素上 —— 两者差不到 1 个设备像素，
   * 但只要有差，整块画布就得**重采样**（双线性），文字立刻蒙一层灰。
   * 125% 显示 + 1.35 倍页面缩放（dpr = 1.6875）时这个差最明显。
   * 反过来用「位图 / dpr」当 CSS 尺寸，就是 1:1 映射，一点重采样都没有。
   */
  const dpr = window.devicePixelRatio || 1;
  const w = canvasPxW / dpr;
  const h = canvasPxH / dpr;
  if (w === cssW && h === cssH) return;
  cssW = w;
  cssH = h;
  el.style.width = w + 'px';
  el.style.height = h + 'px';
}

/* 重绘开销观测：卡顿时先看这几个数，别凭手感猜 */
const perf = {
  draws: 0,
  reallocs: 0,
  hotBlits: 0,
  lastMs: 0,
  maxMs: 0,
  /** 累计绘制时间：冒烟要算「平均一帧多少毫秒」，只看 lastMs 会被单帧抖动骗 */
  sumMs: 0,
  /** 自最近一次 perfResetMax() 起的峰值：专门看「拖滚动条那几帧」最慢的一帧 */
  winMaxMs: 0,
  lastW: 0,
  lastH: 0,
};

/** 主题色缓存：draw() 一次要读 10 个自定义属性，每帧都读会反复逼样式重算 */
let colorCache: any = null;
function themeColors() {
  if (colorCache) return colorCache;
  const css = getComputedStyle(document.documentElement);
  colorCache = {
    bg: css.getPropertyValue('--bg').trim(),
    surface: css.getPropertyValue('--surface').trim(),
    line: css.getPropertyValue('--line').trim(),
    lineStrong: css.getPropertyValue('--line-strong').trim(),
    text: css.getPropertyValue('--text').trim(),
    dim: css.getPropertyValue('--text-dim').trim(),
    faint: css.getPropertyValue('--text-faint').trim(),
    accent: css.getPropertyValue('--accent').trim(),
    accent2: css.getPropertyValue('--accent-2').trim(),
    warn: css.getPropertyValue('--warn').trim() || '#e0a45e',
    // canvas 画不了 color-mix，半透明填充只能自己拼 rgba
    accentRgb: css.getPropertyValue('--accent-rgb').trim() || '66,184,131',
    /** 选中块的整块底色（两个主题都是 #C3E0D3）+ 铺在它上面的字色 */
    selFill: css.getPropertyValue('--sel-fill').trim() || '#c3e0d3',
    selInk: css.getPropertyValue('--sel-ink').trim() || '#17211c',
    /** 和弦字符用的字体族：跟着设置里的「无衬线 / 等宽」走 */
    fontFamily: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
  };
  return colorCache;
}

/** Ctrl+滚轮的锚点：缩放后指针下面还是原来那一格。在 draw 的 rAF 里应用（DOM 已刷新） */
let pendingAnchor: null | { tick: number; relX: number } = null;

function draw() {
  const el = canvas.value;
  const box = host.value;
  if (!el || !box) return;
  // 先按元素身份作废尺寸缓存：下面第一件事就是「位图要不要重分配」
  ensureCanvasEl(el);

  const t0 = performance.now();

  // 缩放锚定：Vue 已经 flush，spacer 是新宽度，这时设 scrollLeft 才不会被旧宽度钳掉
  if (pendingAnchor && scroller.value) {
    const a = pendingAnchor;
    pendingAnchor = null;
    const docX = xOfTick(a.tick);
    const target = LANE_W + docX - a.relX;
    scroller.value.scrollLeft = Math.max(0, target);
    if (scroller.value.scrollLeft !== viewLeft.value) viewLeft.value = scroller.value.scrollLeft;
  }

  const dpr = window.devicePixelRatio || 1;
  const vw = viewW.value;
  const vh = canvasH.value;
  const vl = viewLeft.value;
  const vt = viewTop.value;
  // round 而不是 floor：合成器把画布层按**整数设备像素**摆放，
  // 位图比层小 1px 就会触发重采样（见 syncCanvasSize 的说明）
  const pxW = Math.round(vw * dpr);
  const pxH = Math.round(vh * dpr);
  if (pxW !== canvasPxW || pxH !== canvasPxH) {
    el.width = pxW;
    el.height = pxH;
    canvasPxW = pxW;
    canvasPxH = pxH;
    perf.reallocs++;
  }
  syncCanvasSize();

  /**
   * 主画布**绝不能**声明 `willReadFrequently: true`。
   *
   * 这个属性是给 `bandDiff()` 调试钩子省 GPU→CPU 回读用的，但 Chromium 会在**第一次**
   * `getContext` 时把整个画布定到 CPU 后端 —— 之后播放中每帧的 `draw()` 和波形
   * `paintBand()` 全在软件光栅上跑。Electron 44 / Chromium 152 下尤其明显：
   * 帧率看着还是 60，但画面发黏、窗口拖动/滚动不跟手。
   * 调试钩子只在冒烟里调用，让它自己付一次回读的代价，别让整个应用陪跑。
   */
  const ctx = el.getContext('2d')!;
  // 主题色只随 <html data-theme|data-font> 变，缓存起来别每帧逼一次样式计算
  const c = themeColors();

  // 波形带的双层位图：视图/主题/波形数据变了才重建
  if (waveH.value > 0) {
    const key = [
      Math.round(vl * 4) / 4,
      vw,
      waveH.value,
      zoom.value,
      dpr,
      themeVer,
      peaksVer,
      props.analysis?.id ?? '',
      props.analysis?.audioOffsetMs ?? 0,
    ].join('|');
    if (waveDirty || key !== waveKey) {
      buildWaveLayers(c);
      waveKey = key;
      waveDirty = false;
      bandBuilt = true;
    }
  } else {
    bandBuilt = false;
  }

  // 画布整体平移：后面的绘制全部继续用文档坐标，canvas 自己裁剪
  ctx.setTransform(dpr, 0, 0, dpr, -vl * dpr, -vt * dpr);
  ctx.clearRect(vl, vt, vw, vh);

  ctx.fillStyle = c.bg;
  ctx.fillRect(vl, vt, vw, vh);
  ctx.font = RULER_FONT;
  ctx.textBaseline = 'middle';

  const wave = waveH.value;
  const rY = wave;                 // 小节刻度
  const sY = sectionY.value;       // 段落条：绘制与命中共用（同 keyY 的理由）
  const kY = keyY.value;           // 调性条：绘制与命中共用（见 keyY 的注释）
  const docR = vl + vw;            // 视口右缘（文档坐标）
  const docB = vt + vh;            // 视口下缘

  // 波形带本身由 paintBand 用位图画；这里只负责它下面的部分

  // 小节线 / 格线 / 刻度：只画可见的小节
  const { from: barFrom, to: barTo } = visibleBars();
  for (let bar = barFrom; bar <= barTo; bar++) {
    const x = Math.round(barToX(bar)) + 0.5;
    const g = gridOfBar(bar);
    const cw = pxPerBar.value / g.cells;

    // 小节线：比格线更显眼（用户明确要求）
    ctx.strokeStyle = c.lineStrong;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, headH.value);
    ctx.lineTo(x, docB);
    ctx.stroke();

    // 格线：太密就不画，别把画面糊成灰板；始终比小节线淡
    if (cw >= 5) {
      ctx.strokeStyle = 'rgba(128,128,128,0.10)';
      ctx.lineWidth = 1;
      for (let i = 1; i < g.cells; i++) {
        const bx = Math.round(barToX(bar) + i * cw) + 0.5;
        ctx.beginPath();
        ctx.moveTo(bx, headH.value);
        ctx.lineTo(bx, docB);
        ctx.stroke();
      }
    }

    const step = pxPerBar.value >= 40 ? 1 : pxPerBar.value >= 24 ? 2 : 4;
    if ((bar - 1) % step === 0) {
      ctx.fillStyle = c.faint;
      ctx.fillText(String(bar), x + 3, rY + RULER_H / 2 + 2);
    }
  }

  // 段落条
  ctx.fillStyle = c.surface;
  ctx.fillRect(vl, sY, vw, SECTION_H);
  sections.value.forEach((s: any, i: number) => {
    const next = sections.value[i + 1];
    /**
     * 用 xOfTick 而不是 barToX(bar)：段落 tick 现在会被吸附到小节线，但库里的老数据
     * 可能落在小节中段，`barToX` 会把它「吸」到小节头 —— 画出来的块与点中的位置差一节，
     * 命中判定永远对不上。两套坐标混用是这类 bug 的温床。
     */
    const x0 = xOfTick(s.tick);
    const x1 = next ? xOfTick(next.tick) : totalWidth.value;
    if (x1 < vl || x0 > docR) return;
    if (i % 2 === 0) {
      ctx.fillStyle = `rgba(${c.accentRgb}, 0.08)`;
      ctx.fillRect(x0, sY, Math.max(0, x1 - x0), SECTION_H);
    }
    ctx.strokeStyle = c.lineStrong;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, sY);
    ctx.lineTo(Math.round(x0) + 0.5, sY + SECTION_H);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(x0, vl), sY, Math.max(0, Math.min(x1, docR) - Math.max(x0, vl) - 4), SECTION_H);
    ctx.clip();
    ctx.fillStyle = i % 2 === 0 ? c.text : c.dim;
    ctx.fillText(String(s.label ?? ''), x0 + 5, sY + SECTION_H / 2);
    ctx.restore();
  });

  // 调性条
  ctx.fillStyle = c.bg;
  ctx.fillRect(vl, kY, vw, KEY_H);
  keys.value.forEach((k: any) => {
    const x = xOfTick(k.tick);
    if (x < vl - 40 || x > docR + 40) return;
    ctx.strokeStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, kY);
    ctx.lineTo(Math.round(x) + 0.5, kY + KEY_H);
    ctx.stroke();
    /**
     * 调性标签没有「到下一根竖线为止」的裁剪，所以一根刚好滚到左缘外的竖线会把
     * 半截字留在视口里，再被 sticky 一盖就成了「断字」。这里按视口裁掉。
     */
    ctx.save();
    ctx.beginPath();
    ctx.rect(vl, kY, vw, KEY_H);
    ctx.clip();
    ctx.fillStyle = k.confidence === 'confirmed' ? c.accent : c.dim;
    // 存疑用 "?"，不用红色
    ctx.fillText(`${k.keyName ?? '?'}${k.confidence === 'confirmed' ? '' : ' ?'}`, x + 4, kY + KEY_H / 2);
    ctx.restore();
  });

  /**
   * 横向翻页之后，当前所在段落 / 调性的起点已经滚出左边 → 在左缘补一个灰字副本。
   *
   * 宽度不是定死的：上限 = 右边第一条真标签的起点 − 空隙，所以它永远不会压住 A1 那种
   * 「刚好露头」的标签；实在挤不下（< STICKY_MIN_W）就整条不画 —— 此时真标签就在旁边，
   * 信息并不缺，比起压住别人宁可什么也不说。
   */
  ctx.save();
  ctx.font = RULER_FONT;
  const measureW = (str: string) => ctx.measureText(str).width;
  const stickySection = stickyChipPlan('section', vl, measureW);
  const stickyKey = stickyChipPlan('key', vl, measureW);
  ctx.restore();
  drawStickyChip(ctx, c, 'section', vl, stickySection);
  drawStickyChip(ctx, c, 'key', vl, stickyKey);

  // 拖动标记的幽灵：原位保留，目标位置画一条粗线 + 同一个名字，松手前就能看清会落到哪
  if (bandDrag?.moved && bandDrag.previewTick !== bandDrag.tick) {
    const y0 = bandStripY(bandDrag.kind);
    const h = bandStripH(bandDrag.kind);
    const x0 = xOfTick(bandDrag.tick);
    const x1 = xOfTick(bandDrag.previewTick);
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = c.accent;
    ctx.fillRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, y0);
    ctx.lineTo(Math.round(x1) + 0.5, y0 + h);
    ctx.stroke();
    ctx.lineWidth = 1;   // 不复位的话后面所有线条都变 2px，看着像「网格线突然变粗」
    ctx.fillStyle = c.text;
    ctx.fillText(bandDrag.text, x1 + 4, y0 + h / 2);
  }

  /**
   * 选中的整块：**只染色，不描边、不画格线**。
   *
   * 以前是 13% 透明填充 + 1.5px 外框 + 框内加深每一格竖线，结果一块和弦被几条线切成
   * 好几个小方块，看着像「分了格子」而不是「选中了这一整块」。现在直接铺一块实色，
   * 必须画在事件**之前**，否则实色会把和弦字盖掉。
   */
  const rect = selRect.value;
  const selRange = rect && highlightVisible.value ? selection.value : null;

  /**
   * 选中区域画成**若干个框**，而不是一个外接大框。
   *
   * 以前是所有块取并集画一个大框：Ctrl+点第 11 小节、再 Ctrl+点第 13 小节，
   * 大框从 11 一端拉到 13 另一端 —— **第 12 小节明明没被选中，却被框在里面**，
   * 看着就像「Ctrl+点选成了 Shift 那种整段选」。用户报的正是这个。
   *
   * 现在按「泳道 + 连续」分组：挨着的块合成一个框（多选一串时不会碎成一排小框），
   * 中间有断开就各画各的。12 那一格什么都不画。
   */
  const pickedList = pickedEvents.value;
  const boxes: { x0: number; x1: number; y: number; h: number }[] = [];
  if (!pickedList.length) {
    // 没有离散选中时才用矩形框（否则矩形和 picks 会各画一份，叠出重复的边）
    if (rect && selRange) boxes.push({ x0: rect.x0, x1: rect.x1, y: rect.y0, h: rect.y1 - rect.y0 });
  } else {
    const byLane = new Map<string, any[]>();
    for (const e of pickedList) {
      const arr = byLane.get(e.lane) ?? [];
      arr.push(e);
      byLane.set(e.lane, arr);
    }
    for (const list of byLane.values()) {
      list.sort((a, b) => a.tick - b.tick);
      const runs: { tick: number; endTick: number; lane: string }[] = [];
      for (const e of list) {
        const last = runs[runs.length - 1];
        if (last && e.tick <= last.endTick) last.endTick = Math.max(last.endTick, e.tick + e.durTicks);
        else runs.push({ tick: e.tick, endTick: e.tick + e.durTicks, lane: e.lane });
      }
      for (const r of runs) {
        const g = lanesGeom.value.find((x: any) => x.lane.id === r.lane);
        if (!g) continue;
        const x0 = xOfTick(r.tick);
        const x1 = xOfTick(r.endTick);
        if (x1 < vl - 2 || x0 > docR + 2) continue;
        boxes.push({ x0, x1, y: g.y, h: g.h });
      }
    }
  }

  // 选区整体乘上淡入系数（140ms，静止后恒为 1，不再额外重绘）
  /**
   * 记一份给冒烟读：**画了几个框、各自的 x 范围**。
   * 「Ctrl+点两块不相邻的块」时这里必须是 2 个、且中间有缺口 ——
   * 以前合成一个大框，这里只有一个从 11 到 13 的宽框，12 被框在里面。
   */
  lastSelBoxes = boxes;
  ctx.globalAlpha = selFade;
  for (const b of boxes) {
    roundRectPath(ctx, b.x0, b.y, Math.max(0, b.x1 - b.x0), Math.max(0, b.h), SEL_RADIUS);
    ctx.fillStyle = c.selFill;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  /** 这一条事件是否整条落在选区里（决定它的字用深墨还是常规色） */
  const pickedSet = new Set(pickedIds.value);
  const inSel = (e: any) =>
    pickedSet.has(e.id) ||
    (!!selRange &&
      selRange.lanes.includes(e.lane) &&
      e.tick >= selRange.startTick &&
      e.tick + e.durTicks <= selRange.endTick);

  // 泳道背景 + 事件
  for (const geom of lanesGeom.value) {
    const lane = geom.lane;
    const y = geom.y;
    const lh = geom.h;
    if (y + lh < vt || y > docB) continue;
    ctx.fillStyle = 'rgba(128,128,128,0.04)';
    ctx.fillRect(vl, y, vw, lh);
    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(vl, Math.round(y) + 0.5);
    ctx.lineTo(docR, Math.round(y) + 0.5);
    ctx.stroke();

    const evs = (props.analysis?.events ?? []).filter((e: any) => e.lane === lane.id);
    for (const e of evs) {
      const ex0 = xOfTick(e.tick);
      const ex1 = xOfTick(e.tick + e.durTicks);
      if (ex1 < vl - 2 || ex0 > docR + 2) continue;
      drawEvent(ctx, c, e, ex0, ex1, y, lh, 1, false, inSel(e));
    }
  }

  // 拖动中的幽灵：原位先变淡，目标位置再画一份，松手前就知道会落到哪
  if (moveDrag?.active) {
    for (const item of moveDrag.items) {
      const li = laneIndexOf(item.lane) + moveDrag.dLane;
      const geom = lanesGeom.value[Math.max(0, Math.min(lanesGeom.value.length - 1, li))];
      if (!geom) continue;
      const tick = item.tick + moveDrag.dTick;
      drawEvent(ctx, c, item, xOfTick(tick), xOfTick(tick + item.durTicks), geom.y, geom.h, 0.55, true);
    }
  }

  // 拖边缘的预览：半透明覆盖区 + 一条端点线，松手才写库
  if (edgeDrag) {
    const ed = edgeDrag;
    const g = lanesGeom.value.find((x) => x.lane.id === ed.lane);
    if (g) {
      const x0 = xOfTick(ed.startTick);
      const x1 = xOfTick(ed.endTick);
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = c.accent;
      ctx.fillRect(x0, g.y + 1, Math.max(1, x1 - x0), g.h - 2);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2;
      const hx = ed.side === 'right' ? x1 : x0;
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, g.y);
      ctx.lineTo(Math.round(hx) + 0.5, g.y + g.h);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  // 悬停格
  if (hover.value && !selection.value) {
    const geoms = lanesGeom.value.filter((g) => g.lane.id === hover.value!.lane);
    if (geoms.length) {
      const g0 = geoms[0];
      const cell = cellAtTick(meters.value, ppq.value, hover.value.tick, div.value);
      const x0 = xOfTick(cell.start);
      const x1 = xOfTick(cell.end);
      ctx.strokeStyle = c.accent;
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(g0.y) + 0.5, Math.round(x1 - x0), Math.round(g0.h) - 1);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 选区的外框：**必须画在事件之后**。
   * 事件块现在是不透明的实心底，先画框会被后画的块盖掉一截（尤其多格选区）。
   * 圆角和底色同一个半径，看起来才是「一块被框住的区域」而不是贴上去的边框。
   * 和填充共用同一份 `boxes`：离散选中时是几个分开的框，不是一个把中间也包住的大框。
   */
  if (boxes.length) {
    ctx.globalAlpha = selFade;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1.5;
    for (const b of boxes) {
      const w = Math.max(0, b.x1 - b.x0);
      const h = Math.max(0, b.h);
      roundRectPath(ctx, b.x0 + 0.75, b.y + 0.75, Math.max(0, w - 1.5), Math.max(0, h - 1.5), SEL_RADIUS);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  }

  // 视口边框
  ctx.strokeStyle = c.line;
  ctx.strokeRect(vl + 0.5, vt + 0.5, vw - 1, vh - 1);

  // 缩放/换主题后播放头也要跟着换位置，否则它会停在上一次的像素上。
  // 只摆位置，**不**跟随选中：这个函数就是被「选区变了」触发的。
  const sx = layoutPlayhead();
  /**
   * 波形带必须在这里补画一次。
   *
   * 它是两张位图叠在画布顶部，而上面第 1107 行的 `clearRect` 会连它一起清掉 ——
   * 以前是靠 `updatePlayhead()` 在末尾顺手 `paintBand`，拆分「摆位置 / 跟随选中」时
   * 把这个副作用一起删了，于是每次重绘（滚动、缩放、换和弦）波形都会空一帧：
   * 播放中每换一个和弦闪一下，暂停时甚至一直空到下一次 seek —— 就是「波形闪烁」。
   * 这里用布局算出来的 sx，和播放头同一份坐标，不会再出现两套时间源。
   */
  if (sx != null) paintBand(sx);
  // 没音频时 updatePlayhead 早退，波形带（占位提示）也要画上
  if (!audio.ready || !props.analysis) paintBand(-1);

  perf.draws++;
  perf.lastMs = Math.round((performance.now() - t0) * 10) / 10;
  perf.sumMs += perf.lastMs;
  if (perf.lastMs > perf.winMaxMs) perf.winMaxMs = perf.lastMs;
  perf.lastW = vw;
  perf.lastH = vh;
  if (perf.lastMs > perf.maxMs) perf.maxMs = perf.lastMs;
}

// ---------- 交互 ----------

let drag: null | {
  clientX: number;
  clientY: number;
  tick0: number;
  lane0: number;
  moved: boolean;
  hit: any;
  /** 按下时的连续 tick（不吸附），拖动位移用它做基准 */
  tickExact: number;
  /** 按住 Alt 拖 = 复制一份走，原事件留在原地 */
  alt: boolean;
} = null;

/**
 * 拖边缘改「覆盖范围」。
 * 起点和原值都记在按下那一刻，拖动过程中只算绝对值 —— 否则鼠标来回蹭会累积取整误差，
 * 越拖越偏。
 */
let edgeDrag: null | {
  id: string;
  lane: string;
  text: string;
  side: 'left' | 'right';
  /** 按下时的原始区间 */
  from: number;
  to: number;
  /** 预览区间（还没落库） */
  startTick: number;
  endTick: number;
} = null;
/** 在波形/刻度带上按住拖动 = 试听定位，不是框选 */
let scrubbing = false;
let raf = 0;
/* 提交是异步的：写库期间 blur 会再触发一次，靠这两个标志挡住重复写入与 Esc 的误提交 */
let committing = false;
let cancelEdit = false;

/** 把播放头（以及音频）挪到某个 tick。钩子和 focusTick 共用一份，别各写一遍 */
function seekToTick(tick: number) {
  seekWithScrub(audioMsOfTick(props.analysis, tempos.value, tick), false);
  return Math.round(audio.currentMs);
}

function scheduleDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

/** 事件坐标 → 文档坐标：canvas 钉在视口里，要加回滚动偏移 */
function pos(ev: PointerEvent | MouseEvent) {
  const rect = canvas.value!.getBoundingClientRect();
  return { x: ev.clientX - rect.left + viewLeft.value, y: ev.clientY - rect.top + viewTop.value };
}

/**
 * 命中的事件。只认块内部（左右都不外扩）：
 * 右边多出去的像素已经属于下一格，点下一格时不能被上一块的拖拽抢走。
 * 块内部离边 7px 内的拉伸判定由 `edgeAt` 负责，和这里无关。
 */
function eventAt(x: number, laneIdx: number) {
  const laneId = lanes.value[laneIdx]?.id;
  if (!laneId) return null;
  let best: any = null;
  let bestW = Infinity;
  for (const e of props.analysis?.events ?? []) {
    if (e.lane !== laneId) continue;
    const a = xOfTick(e.tick);
    const b = xOfTick(e.tick + e.durTicks);
    if (x >= a && x <= b) {
      const wpx = b - a;
      if (wpx < bestW) {
        best = e;
        bestW = wpx;
      }
    }
  }
  return best;
}

/**
 * 边缘判定：往两侧各放宽 7px。
 * 一格十几像素宽的时候，边缘只有 1px 的命中区基本等于抓不到 —— 那才是地狱体验。
 *
 * 这 7px 只用于**块内部**（指针已经落在块里，离边 7px 内算拉伸）。
 * 块外侧不再用同样大的 pad：右边多出来的 7px 已经属于下一格，
 * 点那一格时不该被上一块的「拉宽」抢走。外侧只保留 eventAt 自带的 1px 抗锯齿余量。
 */
const EDGE_HIT = 7;

function edgeAt(x: number, hit: any): 'left' | 'right' | null {
  const a = xOfTick(hit.tick);
  const b = xOfTick(hit.tick + hit.durTicks);
  // 判定区随块宽收窄。一拍在 zoom=1 时只有 14px，固定 7px 的话左右各占一半，
  // 中间没有「可抓起来移动」的地方 —— 想拖动永远被判成想拉伸。给中间至少留一半。
  const tol = Math.min(EDGE_HIT, Math.max(3, (b - a) * 0.28));
  const dl = Math.abs(x - a);
  const dr = Math.abs(x - b);
  const nearL = dl <= tol;
  const nearR = dr <= tol;
  if (!nearL && !nearR) return null;
  // 窄块两端都在阈值内：按指针落在中心哪一侧决定拉哪头
  if (nearL && nearR) return x < (a + b) / 2 ? 'left' : 'right';
  return nearL ? 'left' : 'right';
}

/**
 * canvas 之外的手势事件转发。
 *
 * canvas 现在只覆盖「头带 + 泳道」那一条（位图小了 8 倍），所以拖到泳道下方空白、
 * 或从右边缘滑出 canvas 时，事件目标是 `.canvas-host` 而不是 canvas ——
 * 不转发的话拖动会在那一刻静默中断（「拖到边界外自动滚动」就是这么坏掉的）。
 *
 * 从 canvas 冒泡上来的（target 就是 canvas）已经处理过，跳过，否则一次移动算两遍。
 * `pointerleave` 不冒泡，所以 canvas 上不再监听它：canvas 变矮之后
 * 「离开 canvas」不再等于「离开面板」，真正的离开由 host 这一层判断。
 */
function onHostPointer(ev: PointerEvent) {
  if (ev.target === canvas.value) return;
  switch (ev.type) {
    case 'pointermove':
      onPointerMove(ev);
      break;
    case 'pointerup':
      onPointerUp(ev);
      break;
    case 'pointercancel':
      onPointerCancel(ev);
      break;
    default:
      onPointerLeave(ev);
  }
}

/**
 * 左缘 64px 标签列的右键。
 *
 * 这一列**根本不经过 canvas**：`.scroll` 的 `padding-left: 64px` 把 canvas 推到了 x=64，
 * 而标签层是 `pointer-events: none` —— 所以「右键『低音』这两个字」落在 `.scroll` 上
 * （它的 padding 区），再冒泡到这块 `.canvas-host`。v0.36 只转发了 move/up/leave，
 * 右键漏了，于是标签上右键什么都不弹（网格正文里是好的）。
 *
 * 只接标签列：泳道下方空白、右侧空白保持「右键什么都不发生」（那里没有语义）。
 */
function onHostContextMenu(ev: MouseEvent) {
  if (ev.target === canvas.value) return; // 从 canvas 冒泡上来的，它自己处理过了
  const box = host.value?.getBoundingClientRect();
  const rect = canvas.value?.getBoundingClientRect();
  if (!box || !rect) return;
  if (ev.clientX - box.left >= LANE_W) return;
  // 文档 y：canvas 被 sticky 钉在视口上，它的 rect.top 就是「视口顶」，加滚动量即文档坐标
  const docY = ev.clientY - rect.top + viewTop.value;
  if (openBassMenuAt(ev, docY)) return;
  if (openChordMenuAt(ev, docY)) return;
  openSposobinMenuAt(ev, docY);
}

/**
 * 点别处就关菜单。
 *
 * 以前只有 Esc 能关：右键开一个菜单、再去点详情面板或侧栏，菜单会一直挂在网格上，
 * 而且它盖住的地方点不到（很烦）。这里挂 document 的**冒泡阶段**：
 * 菜单自己的 `@pointerdown.stop` 已经把菜单内按下吞掉了，所以这个监听天然只处理「菜单外面」。
 */
function onDocPointerDown(ev: PointerEvent) {
  if (!bandMenu.value && !bassMenu.value && !chordMenu.value && !sposobinMenu.value) return;
  const el = ev.target as HTMLElement | null;
  if (el?.closest?.('.band-menu')) return;
  bandMenu.value = null;
  bassMenu.value = null;
  chordMenu.value = null;
  sposobinMenu.value = null;
}

function onPointerDown(ev: PointerEvent) {
  if (!props.analysis || ev.button !== 0) return;
  // 任何一次左键按下都先把右键菜单收起（菜单自己的 pointerdown 已经 stop 了）
  bandMenu.value = null;
  bassMenu.value = null;
  const { x, y } = pos(ev);

  // 波形 + 小节刻度：点一下就定位，按住可以来回蹭着听
  if (y < waveH.value + RULER_H) {
    if (!audio.ready) return;
    scrubbing = true;
    editing.value = null;
    seekAtX(x);
    try {
      canvas.value?.setPointerCapture(ev.pointerId);
    } catch {
      /* 合成事件没有指针可捕获 */
    }
    return;
  }

  /**
   * 到这儿就是「在网格 / 头带里动手」了：给跟随一个短冷却，否则播放中永远按不住一个格子。
   * **不能放在函数最上面** —— 点波形定位也是 pointerdown，那一下不该冷却跟随，
   * 否则「点一下跳到某处，再看那里是什么和弦」这个最自然的动作会失效。
   */
  followOwned.value = false;

  // 头带两条标记带（段落 / 调性）：命中竖线/分界线 → 可能拖动；空白处 → 什么也不做。
  // 这里**不**去清 bandEdit：正在输入时点到画布会先触发 blur 提交，抢在前面清掉就把用户敲的字丢了。
  //
  // 双击也**不在这里**开编辑框：pointerdown 先于 blur，先在按下时换掉 bandEdit，
  // 紧接着的 blur 就会拿着新对象去提交（把上一处没保存的字按新的 tick 存一遍，或者干脆丢掉）。
  // 统一放到 pointerup（那时 blur 已经跑完）。
  if (inBandStrip('key', y) || inBandStrip('section', y)) {
    const kind: BandKind = inBandStrip('key', y) ? 'key' : 'section';
    const hit = bandAtX(kind, x);
    if (hit) {
      bandDrag = {
        kind,
        id: hit.id,
        tick: hit.tick,
        text: bandText(hit, kind),
        confidence: hit.confidence,
        note: hit.note ?? null,
        label: hit.label ?? null,
        x0: x,
        moved: false,
        previewTick: hit.tick,
      };
      if (canvas.value) canvas.value.style.cursor = 'ew-resize';
      scheduleDraw();
      try {
        canvas.value?.setPointerCapture(ev.pointerId);
      } catch {
        /* 合成事件没有指针可捕获 */
      }
      return;
    }
    // 空白处（只有「第一段之前」那块）没有可拖的东西
    selection.value = null;
    scheduleDraw();
    return;
  }

  if (y < headH.value) {
    selection.value = null;
    scheduleDraw();
    return;
  }
  const laneIdx = laneIndexAtY(y);
  if (laneIdx < 0) return;

  // 1) 站在已有标记的边缘上 = 想拉时值。这一条要排在「抓起来移动」前面，
  //    否则边缘永远被移动手势吃掉，等于没法改范围。
  //    **按住 Ctrl / Shift 时不算**：那是「多选」手势，在块边上 Ctrl+点不该变成拉伸。
  const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  const near = additive ? null : eventAt(x, laneIdx);
  const side = near ? edgeAt(x, near) : null;
  if (near && side) {
    edgeDrag = {
      id: near.id,
      lane: near.lane,
      text: String(near.text ?? ''),
      side,
      from: near.tick,
      to: near.tick + near.durTicks,
      startTick: near.tick,
      endTick: near.tick + near.durTicks,
    };
    selection.value = { lanes: [near.lane], startTick: near.tick, endTick: near.tick + near.durTicks };
    editing.value = null;
    if (canvas.value) canvas.value.style.cursor = 'col-resize';
    scheduleDraw();
    try {
      canvas.value?.setPointerCapture(ev.pointerId);
    } catch {
      /* 合成事件没有指针可捕获 */
    }
    return;
  }

  const t = tickAtX(x);
  const hit = eventAt(x, laneIdx);
  // 普通按下 = 重新开始选：先把上一批离散选中清掉（Ctrl/Shift 按下是为了「加选」，不能清）
  if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) pickedIds.value = [];
  drag = {
    clientX: ev.clientX,
    clientY: ev.clientY,
    tick0: t.tick,
    lane0: laneIdx,
    moved: false,
    hit,
    tickExact: tickAtXExact(x),
    alt: ev.altKey,
  };

  // 按在有内容的地方：先把这块选起来（拖动时整块一起走）。
  // **带 Ctrl/Shift 时不抢**：那是「加选」手势，选中目标由 pointerup 决定；
  // 抢了就会把已经选好的那一块顶掉，表现成「Ctrl+点没有多选效果」。
  if (hit && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
    const s = selection.value;
    const inside =
      s &&
      s.lanes.includes(hit.lane) &&
      hit.tick >= s.startTick &&
      hit.tick + hit.durTicks <= s.endTick;
    if (!inside) selection.value = { lanes: [hit.lane], startTick: hit.tick, endTick: hit.tick + hit.durTicks };
    editing.value = null;
    // Alt + 拖动 = 复制一份：立即进入拖动态，原块留在这里当参照
    if (drag.alt) startMoveDrag(hit, true);
    scheduleDraw();
  }

  try {
    canvas.value?.setPointerCapture(ev.pointerId);
  } catch {
    /* 捕获失败不影响点击，只影响拖出画布 */
  }
}

/**
 * 拖边缘：只更新预览，松手才落库。
 * 吸附到格边界，单位就是用户当前选的格尺度（小节 / 拍 / 半拍）。
 */
function updateEdgeDrag(x: number) {
  const d = edgeDrag;
  if (!d) return;
  const t = tickAtX(x);
  const cell = cellAtTick(meters.value, ppq.value, t.tick, div.value);
  const unit = Math.max(1, Math.round(cell.grid.cellTicks));
  // 最短不能短于原位置那一格 —— 否则会被压成 0 长度，事件直接消失
  const minLen = Math.max(1, Math.round(cellAtTick(meters.value, ppq.value, d.from, div.value).grid.cellTicks));
  if (d.side === 'right') {
    d.endTick = Math.max(d.from + minLen, cell.start + unit);
  } else {
    d.startTick = Math.max(0, Math.min(d.to - minLen, cell.start));
  }
  scheduleDraw();
}

function onPointerMove(ev: PointerEvent) {
  if (!props.analysis) return;
  const { x, y } = pos(ev);

  // 拖标记（段落分界线 / 调性竖线）：位移超过 DRAG_MIN_PX 才算真的在拖，
  // 否则只是点了一下（可能要凑双击）。阈值太小会把「点一下」判成拖动。
  if (bandDrag) {
    if (!bandDrag.moved && Math.abs(x - bandDrag.x0) > DRAG_MIN_PX) bandDrag.moved = true;
    if (bandDrag.moved) {
      bandDrag.previewTick = snapBandTick(bandDrag.kind, x, ev);
      scheduleDraw();
    }
    return;
  }

  if (scrubbing) {
    seekAtX(x);
    armEdgeScroll(ev.clientX, ev.clientY, (docX) => seekAtX(docX));
    return;
  }

  if (edgeDrag) {
    updateEdgeDrag(x);
    return;
  }

  if (!drag) {
    // 头带上不该出现泳道的 crosshair：线/分界上是「左右拖」，空白处是「双击」
    if (inBandStrip('key', y) || inBandStrip('section', y)) {
      if (hover.value) {
        hover.value = null;
        scheduleDraw();
      }
      const kind: BandKind = inBandStrip('key', y) ? 'key' : 'section';
      const want = bandAtX(kind, x) ? 'ew-resize' : 'text';
      if (canvas.value && canvas.value.style.cursor !== want) canvas.value.style.cursor = want;
      return;
    }
    const laneIdx = laneIndexAtY(y);
    if (laneIdx < 0) {
      if (hover.value) {
        hover.value = null;
        scheduleDraw();
      }
      if (canvas.value && canvas.value.style.cursor !== 'crosshair') {
        canvas.value.style.cursor = 'crosshair';
      }
      return;
    }
    const t = tickAtX(x);
    const next = { lane: lanes.value[laneIdx].id, tick: t.tick };
    const hit = eventAt(x, laneIdx);
    // 边缘优先显示「拉宽」光标：7px 的判定区比视觉边缘宽，但用户不用知道这件事
    const near = hit ?? eventAt(x, laneIdx);
    const edge = near ? edgeAt(x, near) : null;
    const want = edge ? 'col-resize' : hit ? 'grab' : 'crosshair';
    if (canvas.value && canvas.value.style.cursor !== want) canvas.value.style.cursor = want;
    if (!hover.value || hover.value.tick !== next.tick || hover.value.lane !== next.lane) {
      hover.value = next;
      scheduleDraw();
    }
    return;
  }

  if (!drag.moved && Math.abs(ev.clientX - drag.clientX) + Math.abs(ev.clientY - drag.clientY) > 4) {
    drag.moved = true;
  }
  if (!drag.moved) return;

  // 按在事件上拖动 = 移动事件（按住 Alt 是复制）；按在空白处拖动 = 框选
  if (drag.hit) {
    if (!moveDrag) startMoveDrag(drag.hit, drag.alt);
    updateMoveDrag(x, y, drag);
    if (canvas.value) canvas.value.style.cursor = drag.alt ? 'copy' : 'grabbing';
    scheduleDraw();
    return;
  }

  applyFrameSelect(x, y);
  // 框选同样支持「拖出边界自动滚」：停在边界外继续拖，视口会跟着走
  armEdgeScroll(ev.clientX, ev.clientY, (docX, docY) => applyFrameSelect(docX, docY));
}

/**
 * 框选：按文档坐标把选区吸附到格。
 *
 * 抽出来是为了让「出界自动滚动」每帧能重算一次 —— 指针不动但视图滚了，
 * 文档坐标已经变了，必须在新的坐标上重新吸附。
 */
function applyFrameSelect(x: number, y: number) {
  const d = drag;
  if (!d) return;
  const laneRaw = laneIndexAtY(y);
  const laneIdx = Math.max(
    0,
    Math.min(lanes.value.length - 1, laneRaw < 0 ? (y < headH.value ? 0 : lanes.value.length - 1) : laneRaw)
  );
  const t = tickAtX(x);
  const r = snapRange(meters.value, ppq.value, d.tick0, t.tick, div.value);
  selection.value = { lanes: laneIdsBetween(d.lane0, laneIdx), ...r };
  editing.value = null;
  scheduleDraw();
}

/** 拖动的候选集：按住的这条若已在选区里，整块选区一起走 */
function startMoveDrag(hit: any, copy = false) {
  const s = selection.value;
  const inSel =
    s && s.lanes.includes(hit.lane) && hit.tick >= s.startTick && hit.tick + hit.durTicks <= s.endTick;
  const source = inSel && selEvents.value.length ? selEvents.value : [hit];
  moveDrag = {
    items: source.map((e: any) => ({
      id: e.id,
      lane: e.lane,
      tick: e.tick,
      durTicks: e.durTicks,
      text: e.text,
      confidence: e.confidence,
      parsed: e.parsed,
    })),
    anchorTick: hit.tick,
    anchorLane: laneIndexOf(hit.lane),
    dTick: 0,
    dLane: 0,
    active: true,
    copy,
  };
}

function updateMoveDrag(x: number, y: number, d: { clientX: number; tick0: number }) {
  const m = moveDrag;
  if (!m) return;
  // 位移量用「连续 tick」算，再吸附到格边界：从任何像素起手都能对齐格子
  const delta = tickAtXExact(x) - d.tickExact;
  const raw = Math.max(0, m.anchorTick + delta);
  const snapped = cellAtTick(meters.value, ppq.value, raw, div.value).start;
  m.dTick = snapped - m.anchorTick;

  const laneRaw = laneIndexAtY(y);
  const lanesLen = lanes.value.length;
  const idxs = m.items.map((it) => laneIndexOf(it.lane));
  const minIdx = Math.min(...idxs);
  const maxIdx = Math.max(...idxs);
  let dLane = laneRaw < 0 ? 0 : laneRaw - m.anchorLane;
  dLane = Math.max(-minIdx, Math.min(lanesLen - 1 - maxIdx, dLane));
  m.dLane = dLane;
}

async function commitMove() {
  const m = moveDrag;
  moveDrag = null;
  const a = props.analysis;
  if (!m || !a) return;
  if (!m.dTick && !m.dLane) return;

  const lanesLen = lanes.value.length;
  const placed = m.items.map((it) => {
    const li = Math.max(0, Math.min(lanesLen - 1, laneIndexOf(it.lane) + m.dLane));
    return {
      id: it.id,
      lane: lanes.value[li]?.id ?? it.lane,
      tick: it.tick + m.dTick,
      durTicks: it.durTicks,
      text: String(it.text ?? ''),
    };
  });

  // Alt 拖动 = 复制：原地那条不动，新位置各写一份。
  // 走 writeRange 而不是 upsert：被压住的邻居会被自动裁短/拆开，不会留下重叠。
  if (m.copy) {
    const stat = await mutate({ key: 'grid.act.copy' }, async () => {
      let n = 0;
      for (const p of placed) {
        const r = await (window as any).api.analysis.writeRange({
          analysisId: a.id,
          lanes: [p.lane],
          startTick: p.tick,
          endTick: p.tick + p.durTicks,
          text: p.text,
        });
        n += r?.inserted ?? 0;
      }
      return n;
    });
    if (stat) {
      selection.value = {
        lanes: [...new Set(placed.map((p) => p.lane))],
        startTick: Math.min(...placed.map((p) => p.tick)),
        endTick: Math.max(...placed.map((p) => p.tick + p.durTicks)),
      };
    }
    scheduleDraw();
    return;
  }

  const moves = placed.map(({ id, tick, lane }) => ({ id, tick, lane }));
  const stat = await mutate(m.dLane ? { key: 'grid.act.moveLane' } : { key: 'grid.act.move' }, () =>
    (window as any).api.analysis.moveEvents(a.id, moves)
  );

  // 选区跟着走，才能接着按住继续拖
  const s = selection.value;
  if (s && stat) {
    selection.value = {
      lanes: [...s.lanes],
      startTick: s.startTick + m.dTick,
      endTick: s.endTick + m.dTick,
    };
  }
  scheduleDraw();
}

async function onPointerUp(ev: PointerEvent) {
  if (bandDrag) {
    const d = bandDrag;
    bandDrag = null;
    cellClick = null;
    if (canvas.value) canvas.value.style.cursor = 'crosshair';
    try {
      canvas.value?.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    if (d.moved) {
      // 拖完不算点击：不清掉的话，松手后那一下「手抖」会被凑成双击，直接弹输入框
      bandClick = null;
      if (d.previewTick !== d.tick) await moveBand(d, d.previewTick);
      scheduleDraw();
      return;
    }
    // 没移动：记一次点击；第二次落在系统双击窗口内就开编辑框
    const { x } = pos(ev);
    const dbl = isDoubleAt(ev, x, bandClick);
    bandClick = dbl ? null : { at: performance.now(), x };
    if (dbl) openBandEditor(d.kind, d.tick);
    scheduleDraw();
    return;
  }

  // 头带两条带的双击：都在这里判（pointerdown 里不能判，见上面的说明）。
  // 具体落点按 kind 分流，见下面 section 那段。
  if (!scrubbing && !edgeDrag && !drag) {
    const at = pos(ev);
    if (inBandStrip('key', at.y) || inBandStrip('section', at.y)) {
      const kind: BandKind = inBandStrip('key', at.y) ? 'key' : 'section';
      if (canvas.value) canvas.value.style.cursor = bandAtX(kind, at.x) ? 'ew-resize' : 'text';
      cellClick = null;   // 头带上的点击不该和网格里的点击凑成双击
      const dbl = isDoubleAt(ev, at.x, bandClick);
      bandClick = dbl ? null : { at: performance.now(), x: at.x };
      if (dbl) {
        /**
         * 段落双击的落点规则（与调性带对齐）：
         *
         * 段落本身是「一个点 + 延续到下一个标记」，所以双击落在**这一段自己的那一格**里
         * （格尺度就是工具栏的小节 / 拍 / 半拍）= 想改它；落到更靠后的格子 = 想在那里
         * 新起一段。以前不管点哪都只是改名，同一个双击手势在段落带和调性带上含义不同，
         * 用到一半会突然愣一下。
         */
        if (kind === 'section') {
          const tick = tickAtXExact(at.x);
          const cell = cellAtTick(meters.value, ppq.value, tick, div.value);
          const sec = sectionAt(tick);
          const secCell = sec ? cellAtTick(meters.value, ppq.value, sec.tick, div.value) : null;
          const sameCell = !!(sec && secCell && secCell.start === cell.start);
          openBandEditor('section', sameCell ? sec.tick : snapBandTick(kind, at.x, ev));
        } else {
          openBandEditor(kind, snapBandTick(kind, at.x, ev));
        }
      }
      scheduleDraw();
      return;
    }
  }

  if (scrubbing) {
    scrubbing = false;
    stopEdgeScroll();
    cellClick = null;
    try {
      canvas.value?.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    return;
  }

  // 拖边缘松手：范围真的变了才写库（原地松手不该污染撤销栈）
  if (edgeDrag) {
    const e = edgeDrag;
    edgeDrag = null;
    drag = null;
    cellClick = null;
    if (canvas.value) canvas.value.style.cursor = 'crosshair';
    try {
      canvas.value?.releasePointerCapture(ev.pointerId);
    } catch {
      /* 元素可能已重建 */
    }
    const a = props.analysis;
    if (!a) return;
    if (e.startTick !== e.from || e.endTick !== e.to) {
      // 传原区间：收缩时主进程会把旧尾巴一起剪掉，不会留下同名的半截
      await mutate({ key: 'grid.act.resize' }, () =>
        (window as any).api.analysis.resize({
          analysisId: a.id,
          lanes: [e.lane],
          fromTick: e.from,
          toTick: e.to,
          startTick: e.startTick,
          endTick: e.endTick,
          text: e.text,
        })
      );
      selection.value = { lanes: [e.lane], startTick: e.startTick, endTick: e.endTick };
    } else {
      /**
       * 按在块边缘但**没拖** = 其实就是点了一下这个块。
       * 这里必须补上「立锚点 + 清离散选中」，否则 Shift+点 会拿上一次的锚点去算范围
       * （表现：明明点的是第 1 块，Shift 到第 4 块只选中了 2 块）。
       */
      pickAnchor = { tick: e.from, lane: e.lane };
      pickedIds.value = [];
    }
    scheduleDraw();
    return;
  }

  const d = drag;
  drag = null;
  if (canvas.value) canvas.value.style.cursor = 'crosshair';
  if (!props.analysis) return;
  try {
    canvas.value?.releasePointerCapture(ev.pointerId);
  } catch {
    /* 元素可能已重建 */
  }

  if (moveDrag) {
    cellClick = null;
    if (moveDrag.active && (moveDrag.dTick || moveDrag.dLane)) {
      await commitMove();
      return;
    }
    moveDrag = null;
    scheduleDraw();
    return;
  }
  if (!d) return;

  if (d.moved) {
    cellClick = null;
    /**
     * 框选的两种结局：
     *   框到的范围里**有标记块** → 吸附成「这些块」并保持选中（不再弹输入框）
     *   纯粹是空白格且 ≥2 格 → 直接进输入态（原来那条）
     * 吸附用「事件的真实区间」而不是鼠标轨迹：半截被框住的块也算整块选中，和 DAW 一致。
     */
    const touched = selEvents.value;
    if (touched.length) {
      selection.value = {
        lanes: [...new Set(touched.map((e: any) => e.lane))],
        startTick: Math.min(...touched.map((e: any) => e.tick)),
        endTick: Math.max(...touched.map((e: any) => e.tick + e.durTicks)),
      };
      kickSelFade();
      scheduleDraw();
      return;
    }
    if ((selInfo.value?.cells ?? 0) >= 2) openEditor(textOfSelection(), { reveal: false });
    return;
  }

  const { x, y } = pos(ev);
  const laneIdx = laneIndexAtY(y);
  if (laneIdx < 0) return;
  const t = tickAtX(x);
  const hit = eventAt(x, laneIdx);

  /**
   * 单击 = 只选中，进输入态要**双击**。
   *
   * 以前单击就直接弹出输入框：想「看一眼这个和弦是什么」也会被推进编辑态，
   * 而且和头带两条标记带（双击才编辑）手势不一致。现在分工是
   *   单击 → 选中（详情栏给解析结果，Enter 也能进编辑）
   *   双击 → 编辑
   *   拖动 → 框选，两格以上直接进编辑
   */
  // Ctrl+点：把这一块加进/移出离散选中（再点一次取消）
  if (hit && (ev.ctrlKey || ev.metaKey)) {
    const id = String(hit.id);
    /**
     * 第一次 Ctrl+点时，要先把「矩形里已经选中的块」**冻结**进 picks。
     *
     * 以前 picks 从空开始，只有被 Ctrl+点到的那块进去 —— 于是「普通点 A → Ctrl+点 B」
     * 之后 picks = [B]，A 只活在矩形里。接着再 Ctrl+点 B（取消它），picks 变空，
     * 而 B 也不在矩形里 → **A 和 B 一起消失**，看着像「点了两下全没了」。
     * 现在 picks 永远等于「当前全部离散选中」，取消哪块就只少哪块。
     *
     * 矩形本身不动（扩成外接范围会把中间那块也框进来，那就不是离散选中了）。
     */
    const base = pickedIds.value.length || !selection.value ? pickedIds.value : selEvents.value.map((e: any) => String(e.id));
    pickedIds.value = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    pickAnchor = { tick: hit.tick, lane: hit.lane };
    // 还没有矩形时补一个，详情栏才有东西可以描述
    if (!selection.value) selection.value = { lanes: [hit.lane], startTick: hit.tick, endTick: hit.tick + hit.durTicks };
    editing.value = null;
    cellClick = null;
    kickSelFade();
    scheduleDraw();
    return;
  }

  // Shift+点：把「锚点 → 这一块」之间的整段事件都加进来（整段替换，不是追加）
  if (hit && ev.shiftKey && pickAnchor) {
    const lo = Math.min(pickAnchor.tick, hit.tick);
    const hi = Math.max(pickAnchor.tick, hit.tick) + hit.durTicks;
    const ids = viewEvents.value
      .filter((e: any) => e.lane === hit.lane && e.tick >= lo && e.tick < hi)
      .map((e: any) => String(e.id));
    ids.push(String(hit.id));
    pickedIds.value = [...new Set(ids)];
    pickAnchor = { tick: hit.tick, lane: hit.lane };
    if (!selection.value) selection.value = { lanes: [hit.lane], startTick: hit.tick, endTick: hit.tick + hit.durTicks };
    editing.value = null;
    cellClick = null;
    kickSelFade();
    scheduleDraw();
    return;
  }

  if (hit) {
    selection.value = { lanes: [hit.lane], startTick: hit.tick, endTick: hit.tick + hit.durTicks };
    pickAnchor = { tick: hit.tick, lane: hit.lane };
    pickedIds.value = [];
  } else {
    selection.value = {
      lanes: [lanes.value[laneIdx].id],
      startTick: t.tick,
      endTick: Math.round(t.tick + t.grid.cellTicks),
    };
    pickAnchor = null;
    pickedIds.value = [];
  }
  const dbl = isDoubleAt(ev, x, cellClick);
  cellClick = dbl ? null : { at: performance.now(), x };
  if (dbl) openEditor(hit ? String(hit.text ?? '') : '');
  scheduleDraw();
}

function onPointerLeave() {
  if (!drag && !scrubbing && hover.value) {
    hover.value = null;
    scheduleDraw();
  }
}

/**
 * 手势被系统收走（Alt+Tab、右键菜单、触控板手势）：必须把拖动态清干净，
 * 否则回来之后画布上会一直挂着一条「还在拖」的幽灵线，而且下一次 pointerup 会用旧状态写库。
 */
function onPointerCancel() {
  bandDrag = null;
  bandClick = null;
  cellClick = null;
  stopEdgeScroll();
  bandMenu.value = null;
  scrubbing = false;
  edgeDrag = null;
  drag = null;
  if (canvas.value) canvas.value.style.cursor = 'crosshair';
  scheduleDraw();
}

/* ---------- 头带的两条标记带：段落 / 调性 ----------
 *
 * 已知遗留：改段落 / 调性**不重算** analysis_event.parsed。
 * parsed 只在 writeRange / upsertEvent 时由 parsedFor(lane, text, keyAtTick(...)) 生成，
 * 所以改动调性之后，已有和弦的「级数 / 功能 / 音名」仍是旧调性下的结果，
 * 直到那一条和弦被重新输入或移动。批量重算会牵动撤销栈与全量写库，本次明确不做。
 *
 * 另一个边界：删掉 tick 0 的调性后，它到下一个调性之间没有生效调性，
 * keyAtTick 返回 null，罗马数字解析会退化成 C 大调。允许删除（清空就是删除），
 * 但用 grid.act.keyDeleteFirst 专门提示一句。
 */

/**
 * 双击判定。
 *
 * 真实鼠标：第二次 pointerdown 的 `ev.detail` 就是 2 —— Windows 的「双击速度」设置由系统算好，
 * 我们不该自己数毫秒。以前这里写死 400ms，比系统默认的 500ms 还紧，手慢一点就永远凑不中，
 * 表现就是「双击没反应，要试好几次」。
 * 合成事件（冒烟 / 自动化）的 detail 恒为 0，所以保留一个更宽松的时间窗兜底。
 */
function isDoubleAt(ev: PointerEvent | MouseEvent, x: number, last: { at: number; x: number } | null) {
  if ((ev as any).detail >= 2) return true;
  if (!last) return false;
  return performance.now() - last.at <= KEY_DBL_MS && Math.abs(x - last.x) <= KEY_DBL_PX;
}

function bandStripY(kind: BandKind) {
  return kind === 'key' ? keyY.value : sectionY.value;
}

function bandStripH(kind: BandKind) {
  return kind === 'key' ? KEY_H : SECTION_H;
}

function inBandStrip(kind: BandKind, y: number) {
  const y0 = bandStripY(kind);
  return y >= y0 && y < y0 + bandStripH(kind);
}

function inKeyStrip(y: number) {
  return inBandStrip('key', y);
}

/** 某一类标记行（按 tick 升序）。编辑只认真实行，不碰 `sections` 那个假段落 */
function bandRows(kind: BandKind) {
  return (props.analysis?.markers ?? [])
    .filter((m: any) => m.kind === kind)
    .slice()
    .sort((a: any, b: any) => a.tick - b.tick);
}

/** 段落显示的是 label，调性显示的是 keyName —— 只有这一处差异 */
function bandText(m: any, kind: BandKind) {
  return kind === 'key' ? String(m?.keyName ?? '') : String(m?.label ?? '');
}

/** ±KEY_HIT 内最近的竖线 / 分界线；没有就 null */
function bandAtX(kind: BandKind, x: number) {
  let best: any = null;
  let bestD = Infinity;
  for (const m of bandRows(kind)) {
    const d = Math.abs(xOfTick(m.tick) - x);
    if (d <= KEY_HIT && d < bestD) {
      best = m;
      bestD = d;
    }
  }
  return best;
}

/** 兼容旧调用点 */
function keyAtX(x: number) {
  return bandAtX('key', x);
}

/** 某 tick 所在的段落（区间 = 本段起点到下一条分界） */
function sectionAt(tick: number) {
  let hit: any = null;
  for (const s of bandRows('section')) {
    if (s.tick <= tick) hit = s;
    else break;
  }
  return hit;
}

/**
 * 调性吸附：默认跟当前格单位走，但**至少到拍**。
 * div = 0 是「一小节一格」，只吸附小节会把 4/4 里落在拍上的转调点一拖就吞掉整小节；
 * 真实数据里第一条调性就可能落在拍上（神鹿谣是 3/4，tick 1440 是小节线，但别的曲子未必）。
 * Shift = 只吸附小节；Alt = 不吸附（对着音频对位置时用）。
 */
function snapKeyTick(x: number, ev?: { shiftKey?: boolean; altKey?: boolean }) {
  const raw = tickAtXExact(x);
  if (ev?.altKey) return Math.max(0, Math.round(raw));
  const d = ev?.shiftKey ? 0 : Math.max(1, div.value);
  return Math.max(0, Math.round(cellAtTick(meters.value, ppq.value, raw, d).start));
}

/**
 * 段落吸附：段落是结构单位，默认吸**小节**；Shift = 拍；Alt = 不吸附。
 * 和调性相反（调性可以落在拍上，段落基本不会）。
 */
function snapSectionTick(x: number, ev?: { shiftKey?: boolean; altKey?: boolean }) {
  const raw = tickAtXExact(x);
  if (ev?.altKey) return Math.max(0, Math.round(raw));
  const d = ev?.shiftKey ? 1 : 0;
  return Math.max(0, Math.round(cellAtTick(meters.value, ppq.value, raw, d).start));
}

function snapBandTick(kind: BandKind, x: number, ev?: { shiftKey?: boolean; altKey?: boolean }) {
  return kind === 'key' ? snapKeyTick(x, ev) : snapSectionTick(x, ev);
}

/**
 * 一行的完整形状。
 * setMarkers 是「先删整组再逐条插入」，缺字段会写成 null、confidence 会被重置成 confirmed ——
 * 所以必须把原来的 note / label 一起带上，不能只传 {tick, keyName}。
 */
function fullBandMarker(m: any, kind: BandKind) {
  return {
    id: m.id,
    kind,
    tick: m.tick,
    label: m.label ?? null,
    num: m.num ?? null,
    den: m.den ?? null,
    bpm: m.bpm ?? null,
    keyName: m.keyName ?? null,
    startBar: m.startBar ?? null,
    confidence: m.confidence ?? 'confirmed',
    note: m.note ?? null,
  };
}

/**
 * 写整组标记（段落 / 调性共用）。
 *
 * 去重与排序在这里做，不是在调用方：`UNIQUE (analysis_id, kind, tick)` 一抛错，
 * 整个事务回滚 —— 界面上看起来就是「刚编辑的那条没了」，而且没有任何提示。
 */
async function writeMarkers(kind: BandKind, list: any[], label: ActionLabel): Promise<boolean> {
  const a = props.analysis;
  if (!a || bandSaving.value) return false;
  const byTick = new Map<number, any>();
  for (const m of list) byTick.set(Number(m.tick), m);   // 后写的赢 = 落在同一位置就替换
  const next = JSON.parse(JSON.stringify([...byTick.values()].sort((x, y) => x.tick - y.tick)));
  bandSaving.value = true;
  try {
    await (window as any).api.analysis.setMarkers(a.id, kind, next);
    lastAction.value = label;
    // 由父层重拉：详情面板读的是同一批 marker 行，别在这里改 props
    emit('changed');
    scheduleDraw();
    return true;
  } catch (err: any) {
    lastAction.value = {
      key: kind === 'key' ? 'grid.err.keySave' : 'grid.err.secSave',
      vars: { note: String(err?.message ?? err) },
    };
    console.error('[grid] 写标记失败:', kind, err);
    return false;   // 输入框不关：用户敲的字不能丢
  } finally {
    bandSaving.value = false;
  }
}

function openBandEditor(kind: BandKind, tick: number) {
  const t0 = Math.max(0, Math.round(Number(tick) || 0));
  const hit = bandRows(kind).find((m: any) => m.tick === t0);
  bandCancel = false;
  bandMenu.value = null;
  // 头带在文档最上面：纵向滚过之后它就看不见了，直接定位会让输入框落在可视区外
  if (viewTop.value > 0 && scroller.value) {
    scroller.value.scrollTop = 0;
    viewTop.value = 0;
  }
  revealRange({ startTick: t0, endTick: t0 + 1 });
  bandEdit.value = { kind, tick: t0, text: hit ? bandText(hit, kind) : '', isNew: !hit };
  bandSug.value = { items: [], active: 0, open: false };
  void nextTick(() => {
    bandInputEl.value?.focus({ preventScroll: true });
    bandInputEl.value?.select();
  });
  scheduleDraw();
}

/** 输入框的屏幕坐标：editingView 那套换算（LANE_W + 文档 x − 滚动量） */
const bandEditView = computed(() => {
  const e = bandEdit.value;
  if (!e) return null;
  const y0 = bandStripY(e.kind);
  const h = bandStripH(e.kind);
  const x = xOfTick(e.tick);
  const next = bandRows(e.kind).find((m: any) => m.tick > e.tick);
  // 宽度到「下一条分界线」为止：转调 / 分段密集时不会盖住下一条，稀疏时也不会长得离谱
  const w = Math.max(92, Math.min(240, (next ? xOfTick(next.tick) : x + 160) - x - 4));
  return {
    left: `${LANE_W + Math.max(x, viewLeft.value + 2) - viewLeft.value}px`,
    top: `${y0 - viewTop.value + 1}px`,
    width: `${w}px`,
    height: `${h - 2}px`,
  };
});

const bandSugView = computed(() => {
  const v = bandEditView.value;
  const e = bandEdit.value;
  if (!v || !e) return null;
  // 与单元格候选同一套：向下优先，装不下翻上去，永远留在窗口里
  return sugBox(v, bandStripH(e.kind), bandSug.value.items.length || 4);
});

/**
 * 候选是同步纯函数算出来的，天然没有「旧响应盖新输入」的问题。
 * 只有调性有候选：段落名是自由的（intro / A1 / coda…），猜不出什么有意义的东西。
 */
function onBandInputChanged(ev?: Event) {
  // 以输入框真实值为准：v-model 的 input 监听与这里谁先跑没有保证，
  // 读 bandEdit.text 可能拿到上一帧的值（候选就跟不上刚敲的字）
  const el = ev?.target as HTMLInputElement | null;
  const raw = typeof el?.value === 'string' ? el.value : bandEdit.value?.text ?? '';
  if (bandEdit.value) bandEdit.value.text = raw;
  if (bandEdit.value?.kind !== 'key') return;

  const token = raw.trim();
  if (!token) {
    bandSug.value = { items: [], active: 0, open: false };
    return;
  }
  const items = suggestKeyNames(token, locale.value, 8);
  bandSug.value = { items, active: 0, open: items.length > 0 };
}

function applyBandSug(c: { value: string }) {
  if (!bandEdit.value) return;
  bandEdit.value.text = c.value;
  bandSug.value = { items: [], active: 0, open: false };
  void nextTick(() => bandInputEl.value?.focus({ preventScroll: true }));
}

/** Enter：采纳会不会改文本由 pickMode 决定 —— 没改就直接落库，改了先采纳再落库 */
async function commitOrAdoptBand() {
  const e = bandEdit.value;
  if (!e) return;
  // 同样以输入框真实值为准（v-model 可能还差一帧），否则会把上一次的字存进去
  const el = bandInputEl.value;
  if (el && typeof el.value === 'string') e.text = el.value;
  if (e.kind === 'key') {
    const token = e.text.trim();
    const hit = bandSug.value.open ? bandSug.value.items[bandSug.value.active] : null;
    if (hit && pickMode(token, { name: hit.value, display: hit.value }, locale.value) === 'adopt') {
      applyBandSug(hit);
      return;
    }
  }
  await commitBandEdit();
}

async function commitBandEdit(): Promise<boolean> {
  const e = bandEdit.value;
  const a = props.analysis;
  if (!e || !a) return false;
  const kind = e.kind;
  // 段名写 label，调性写 keyName —— 全项目只有这一处字段差异
  const field = kind === 'key' ? 'keyName' : 'label';
  const list = bandRows(kind).map((m: any) => fullBandMarker(m, kind));
  const at = list.find((m: any) => m.tick === e.tick);
  const text = e.text.trim();
  let next: any[];
  let label: ActionLabel;

  if (!text) {
    // 清空 = 删除（与单元格「清空文本=清空这几格」一致）
    if (!at) {
      bandEdit.value = null;
      return false;
    }
    next = list.filter((m: any) => m.tick !== e.tick);
    label =
      kind === 'key'
        ? !next.length || e.tick === 0
          ? { key: 'grid.act.keyDeleteFirst' }
          : { key: 'grid.act.keyDelete', vars: { value: at.keyName ?? '' } }
        : { key: 'grid.act.secDelete', vars: { value: at.label ?? '' } };
  } else if (at) {
    if (bandText(at, kind) === text) {
      bandEdit.value = null;   // 没改就不写库：整组替换会刷新 updated_at 并写回 JSON
      return false;
    }
    // 用户亲手输入过 → confidence 升为 confirmed；note 是手写资料，原样保留
    next = list.map((m: any) => (m.tick === e.tick ? { ...m, [field]: text, confidence: 'confirmed' } : m));
    label = { key: kind === 'key' ? 'grid.act.keyEdit' : 'grid.act.secEdit', vars: { value: text } };
  } else {
    const fresh: any = {
      id: `${a.id}:${kind}:${e.tick}`,
      kind,
      tick: e.tick,
      label: null,
      num: null,
      den: null,
      bpm: null,
      keyName: null,
      startBar: null,
      confidence: 'confirmed',
      note: null,
    };
    fresh[field] = text;
    next = [...list, fresh];
    label = { key: kind === 'key' ? 'grid.act.keyAdd' : 'grid.act.secAdd', vars: { value: text } };
  }

  const ok = await writeMarkers(kind, next, label);
  /**
   * 只关「自己那一个」编辑器。
   * 写入是异步的，期间用户可能已经双击开了另一处（blur 提交 → 立刻点下一个位置）；
   * 无条件 `bandEdit = null` 会把刚打开的那个框也一起关掉，用户看到的是「双击了但框一闪就没了」。
   */
  if (ok && bandEdit.value === e) bandEdit.value = null;
  return ok;
}

/**
 * 拖动标记：调性拖竖线、段落拖分界线，都是「改这一条的 tick」。
 * 目标位置已有同 kind 的标记时**拒绝**：整组替换会按 tick 去重（后写的赢），
 * 那样被盖住的那一条会静默消失 —— 用户只会发现「莫名少了一段」。
 */
async function moveBand(d: { kind: BandKind; id: string; tick: number }, toTick: number) {
  const a = props.analysis;
  if (!a || !d) return;
  const rows = bandRows(d.kind);
  const src = rows.find((m: any) => m.id === d.id);
  if (!src) return;
  if (rows.some((m: any) => m.id !== d.id && m.tick === toTick)) {
    lastAction.value = {
      key: 'grid.err.markerDup',
      vars: { name: t(d.kind === 'key' ? 'grid.band.key' : 'grid.band.section') },
    };
    return;
  }
  const rest = rows.filter((m: any) => m.id !== d.id).map((m: any) => fullBandMarker(m, d.kind));
  // id 跟着新 tick 走：库里与 tracks.ts 都按 `${analysisId}:${kind}:${tick}` 约定，
  // 保留旧 id 会让 id 与 tick 脱钩，按 id 反查 / 排错全对不上
  const marker = { ...fullBandMarker(src, d.kind), id: `${a.id}:${d.kind}:${toTick}`, tick: toTick };
  await writeMarkers(d.kind, [...rest, marker], {
    key: d.kind === 'key' ? 'grid.act.keyMove' : 'grid.act.secMove',
    vars: { bar: tickToBarBeat(meters.value, toTick, ppq.value).bar },
  });
}

function cancelBandEdit() {
  bandCancel = true;
  bandEdit.value = null;
  bandSug.value = { items: [], active: 0, open: false };
  scheduleDraw();
}

function onBandBlur() {
  if (bandCancel) {
    bandCancel = false;
    return;
  }
  if (bandSaving.value) return;
  void commitBandEdit();
}

function onBandInputKey(ev: KeyboardEvent) {
  // 组合期：↑↓ 是输入法翻页、Enter 是确认候选词，一个都不能拦
  if (isComposing(ev)) return;
  if (bandSug.value.open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    ev.preventDefault();
    const n = bandSug.value.items.length;
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    bandSug.value.active = (bandSug.value.active + step + n) % n;
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    cancelBandEdit();
    return;
  }
  if (ev.key === 'Enter' || ev.key === 'Tab') {
    ev.preventDefault();
    void commitOrAdoptBand();
  }
}

/* ---- 段落条专有的两件事：右键分段 / 删除本段 ---- */

/**
 * 在 tick 处分段。新段名用「新段落」而不是空串：
 * 空串在这个项目里的语义是「删除」（清空即删），新段一落地就是空名会让人分不清。
 */
async function splitSectionAt(tick: number) {
  const a = props.analysis;
  if (!a || bandSaving.value) return;
  const t0 = Math.max(0, Math.round(tick));
  const rows = bandRows('section');
  if (rows.some((m: any) => m.tick === t0)) {
    lastAction.value = { key: 'grid.err.markerDup', vars: { name: t('grid.band.section') } };
    return;
  }
  const name = t('grid.section.new');
  const fresh: any = {
    id: `${a.id}:section:${t0}`,
    kind: 'section',
    tick: t0,
    label: name,
    num: null,
    den: null,
    bpm: null,
    keyName: null,
    startBar: null,
    confidence: 'confirmed',
    note: null,
  };
  await writeMarkers('section', [...rows.map((m: any) => fullBandMarker(m, 'section')), fresh], {
    key: 'grid.act.secAdd',
    vars: { value: name },
  });
}

async function deleteSectionAt(tick: number) {
  if (bandSaving.value) return;
  const rows = bandRows('section');
  const at = rows.find((m: any) => m.tick === tick);
  if (!at) return;
  await writeMarkers(
    'section',
    rows.filter((m: any) => m.tick !== tick).map((m: any) => fullBandMarker(m, 'section')),
    { key: 'grid.act.secDelete', vars: { value: String(at.label ?? '') } }
  );
}

/**
 * 右键：段落条 → 分段/删除；左缘「低音」行标签 → 低音填充菜单；别处什么都不做。
 *
 * 菜单做成第二套工具栏，就没人会去记双击和拖动了 —— 所以两处都只放最必要的几条。
 */
function onCanvasContextMenu(ev: MouseEvent) {
  if (!props.analysis) return;
  const { x, y } = pos(ev);
  if (!inBandStrip('section', y)) {
    bassMenu.value = null;
    chordMenu.value = null;
    sposobinMenu.value = null;
    // 低音 / 和弦 / 斯波索宾行：**标签和网格正文**都能唤出同一个菜单（左缘标签层 pointer-events:none，
    // 两种点击都会落到 canvas 上，所以这里只按 y 判断落在哪一行）
    if (openBassMenuAt(ev, y)) return;
    if (openChordMenuAt(ev, y)) return;
    if (openSposobinMenuAt(ev, y)) return;
    bandMenu.value = null;
    return;
  }
  bassMenu.value = null;
  chordMenu.value = null;
  sposobinMenu.value = null;
  ev.preventDefault();
  const tick = snapSectionTick(x, ev);
  const box = host.value?.getBoundingClientRect();
  bandMenu.value = {
    x: Math.round(ev.clientX - (box?.left ?? 0)),
    y: Math.round(ev.clientY - (box?.top ?? 0)),
    tick,
    has: !!sectionAt(tick),
    // 这一小节已经是一段的起点 → 不能再分段（会撞 UNIQUE）
    canSplit: !bandRows('section').some((m: any) => m.tick === tick),
  };
}

function closeBandMenu() {
  if (bandMenu.value) bandMenu.value = null;
}

async function runBandMenu(act: 'split' | 'delete') {
  const m = bandMenu.value;
  if (!m) return;
  bandMenu.value = null;
  if (act === 'split') {
    await splitSectionAt(m.tick);
    return;
  }
  const hit = sectionAt(m.tick);
  if (hit) await deleteSectionAt(hit.tick);
}

/* ---------- 低音：从级数标记推导 ---------- */

/**
 * 这套功能只服务**罗马数字视图**的「级数」行。
 *
 * 为什么卡视图：同一批事件换个视图含义就变了（字母和弦是绝对音名、黎曼是功能符号），
 * 而且只有 roman 既有 chord 行又有 bass 行。硬套到别的视图会生成用户没要的数据。
 */
const bassFillable = computed(
  () =>
    props.view?.id === 'roman' &&
    lanes.value.some((l: any) => l.id === 'degree') &&
    lanes.value.some((l: any) => l.id === 'bass')
);

/**
 * 一条级数标记的低音音名。
 *
 * 优先用库里已经算好的 `parsed.bassName` —— 它是主进程按**该 tick 的调性**算的，
 * 和详情栏同一个来源；刚敲完还没回库的文本才走 parseChord + keyNameAt，
 * 否则「回车之后立刻填」会拿到旧值或 null。
 */
function bassNameOf(text: string, tick: number, parsed?: any): string | null {
  const p = parsed && parsed.ok ? parsed : parseChord(text, { key: keyNameAt(tick) });
  const name = p && p.ok && p.bassName ? String(p.bassName).trim() : '';
  return name || null;
}

/** 某个 tick 上已有的低音事件（同 lane 同 tick 正常只有一条） */
function bassEventAt(tick: number): any | null {
  return (props.analysis?.events ?? []).find((e: any) => e.lane === 'bass' && e.tick === tick) ?? null;
}

/**
 * 把一条低音写进 [tick, tick+dur)。
 *
 * 同起点已经有低音就走 upsert：**长度跟着和弦改**，不会留下旧的半截尾巴
 * （writeRange 在缩窄时会保留右半段，那是它的既有语义，这里不该被它咬）。
 * 没有才 writeRange —— 跨过这个区间的旧低音会被裁短，正好。
 *
 * 返回是否真的写了库：内容与长度都一样就跳过，免得白压一次撤销栈。
 */
async function writeBassAt(tick: number, dur: number, name: string): Promise<boolean> {
  const a = props.analysis;
  if (!a || !(dur > 0)) return false;
  const old = bassEventAt(tick);
  if (old && String(old.text ?? '') === name && Number(old.durTicks) === dur) return false;
  const api = (window as any).api;
  if (old?.id) {
    await api.analysis.upsertEvent({
      id: old.id,
      analysisId: a.id,
      lane: 'bass',
      tick,
      durTicks: dur,
      text: name,
    });
  } else {
    await api.analysis.writeRange({
      analysisId: a.id,
      lanes: ['bass'],
      startTick: tick,
      endTick: tick + dur,
      text: name,
    });
  }
  return true;
}

/**
 * 「从级数标记获取低音填充」：扫**整首曲子**的级数标记，把能算的低音都写进低音行。
 *
 * 这是用户手点的入口 → **覆盖**已有低音（他就是要这一下）；自动模式才只跟着和弦更新。
 * 所有写入包在同一个 mutate 里：一次 Ctrl+Z 全回退，而不是按条数撤 N 次。
 */
async function fillBassFromDegrees() {
  // 冒烟探针：这条路径只该由用户点一次菜单触发一次，跑两次就说明有别的入口在替它跑
  (window as any).__bassFillCalls = ((window as any).__bassFillCalls || 0) + 1;
  bassMenu.value = null;
  const a = props.analysis;
  if (!a || !bassFillable.value) return;
  const rows = (a.events ?? []).filter((e: any) => e.lane === 'degree');
  if (!rows.length) {
    lastAction.value = { key: 'grid.bassFill.empty' };
    return;
  }
  let filled = 0;
  let skipped = 0;
  await mutate({ key: 'grid.act.bassFill' }, async () => {
    for (const e of rows) {
      const name = bassNameOf(e.text, e.tick, e.parsed);
      if (!name) {
        skipped++;
        continue;
      }
      if (await writeBassAt(e.tick, Number(e.durTicks) || ppq.value, name)) filled++;
    }
    return filled;
  });
  lastAction.value = filled
    ? { key: skipped ? 'grid.act.bassFillSkip' : 'grid.act.bassFill', vars: { n: filled, skipped } }
    : { key: 'grid.bassFill.empty' };
}

/**
 * 在「低音」行上右键 → 打开菜单（标签那一格和网格正文都算）。
 *
 * 标签层是 `pointer-events: none`（鼠标事件全透给 canvas，这是刻意的：标签列不能吃掉
 * 拖动和框选的起手），所以这里**不挂 DOM contextmenu**，由 canvas 的右键统一收口，
 * 只用「这一下是否落在低音行」判断。
 *
 * 返回是否真的开了菜单（没开就别 preventDefault，保持「右键网格什么都不发生」）。
 */
function openBassMenuAt(ev: MouseEvent, docY: number): boolean {
  if (!props.analysis || !bassFillable.value) return false;
  const g = lanesGeom.value.find((it: any) => it.lane?.id === 'bass');
  if (!g || docY < g.y || docY >= g.y + g.h) return false;
  ev.preventDefault();
  ev.stopPropagation();
  bandMenu.value = null;
  const box = host.value?.getBoundingClientRect();
  const x = Math.round(ev.clientX - (box?.left ?? 0));
  const y = Math.round(ev.clientY - (box?.top ?? 0));
  // 兜住底边/右边：菜单贴到视口外就点不到了
  const maxX = Math.max(0, (host.value?.clientWidth ?? 0) - 196);
  const maxY = Math.max(0, (host.value?.clientHeight ?? 0) - 62);
  bassMenu.value = { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  return true;
}

/** 菜单里的勾选项：开/关「每次都自动填」 */
function toggleBassAutofill() {
  const next = !bassAutofill.value;
  bassAutofill.value = next;
  try {
    localStorage.setItem('ma-bass-autofill', next ? '1' : '0');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'bassAutofill' } }));
  bassMenu.value = null;
  lastAction.value = { key: next ? 'grid.bassFill.autoOn' : 'grid.bassFill.autoOff' };
}

/* ---------- 字母和弦：从级数标记推导 ----------
 *
 * 与「从级数取低音」同一套用法：右键 `chord` 行 → 整曲填一次 / 勾上「每次都自动」。
 * 区别只有一个：低音是**同一个和弦的另一个声部**，字母和弦是**同一个和弦的另一种写法**，
 * 所以「算不出来就跳过」比「猜一个差不多的」重要得多 —— 转换为 null 时宁可留空。
 */

/** 目标行 `chord`：字母和弦视图的「和弦」、黎曼的「实际和弦」、和弦组成音的「和弦」 */
const chordLaneVisible = computed(() => lanes.value.some((l: any) => l.id === 'chord'));

/**
 * 一条级数标记对应的字母和弦写法。
 *
 * 优先用库里算好的 `parsed`（主进程按该 tick 的调性拼的根音）；刚敲完还没回库的文本
 * 才现解析 —— 否则「回车后立刻填」会拿到旧调性下的音名。
 */
function letterNameOf(text: string, tick: number, parsed?: any): string | null {
  const p = parsed && parsed.ok ? parsed : parseChord(text, { key: keyNameAt(tick) });
  return letterFromRoman(p);
}

/** 某个 tick 上已有的字母和弦事件（同 lane 同 tick 正常只有一条） */
function chordEventAt(tick: number): any | null {
  return (props.analysis?.events ?? []).find((e: any) => e.lane === 'chord' && e.tick === tick) ?? null;
}

/** 把一条字母和弦写进 [tick, tick+dur)：同起点走 upsert，长度跟着级数走 */
async function writeChordAt(tick: number, dur: number, name: string): Promise<boolean> {
  const a = props.analysis;
  if (!a || !(dur > 0)) return false;
  const old = chordEventAt(tick);
  if (old && String(old.text ?? '') === name && Number(old.durTicks) === dur) return false;
  const api = (window as any).api;
  if (old?.id) {
    await api.analysis.upsertEvent({
      id: old.id,
      analysisId: a.id,
      lane: 'chord',
      tick,
      durTicks: dur,
      text: name,
    });
  } else {
    await api.analysis.writeRange({
      analysisId: a.id,
      lanes: ['chord'],
      startTick: tick,
      endTick: tick + dur,
      text: name,
    });
  }
  return true;
}

/**
 * 「从级数标记获取字母和弦」：扫整首的级数，能翻译的都写进 `chord` 行。
 *
 * 手点入口 = **覆盖**已有字母和弦（用户就是要这一下）；自动模式才只跟着新写的级数走。
 * 所有写入包在同一个 mutate 里：一次 Ctrl+Z 全回退。
 */
async function fillChordsFromDegrees() {
  // 冒烟探针：只该由用户点一次菜单触发一次
  (window as any).__chordFillCalls = ((window as any).__chordFillCalls || 0) + 1;
  chordMenu.value = null;
  const a = props.analysis;
  if (!a || !chordLaneVisible.value) return;
  const rows = (a.events ?? []).filter((e: any) => e.lane === 'degree');
  if (!rows.length) {
    lastAction.value = { key: 'grid.chordFill.empty' };
    return;
  }
  let filled = 0;
  let skipped = 0;
  await mutate({ key: 'grid.act.chordFill' }, async () => {
    for (const e of rows) {
      const name = letterNameOf(e.text, e.tick, e.parsed);
      if (!name) {
        skipped++;
        continue;
      }
      if (await writeChordAt(e.tick, Number(e.durTicks) || ppq.value, name)) filled++;
    }
    return filled;
  });
  lastAction.value = filled
    ? { key: skipped ? 'grid.act.chordFillSkip' : 'grid.act.chordFill', vars: { n: filled, skipped } }
    : { key: 'grid.chordFill.empty' };
}

/** 在 `chord` 行上右键 → 开菜单（标签那一格和网格正文都算，理由同低音行） */
function openChordMenuAt(ev: MouseEvent, docY: number): boolean {
  if (!props.analysis || !chordLaneVisible.value) return false;
  const g = lanesGeom.value.find((it: any) => it.lane?.id === 'chord');
  if (!g || docY < g.y || docY >= g.y + g.h) return false;
  ev.preventDefault();
  ev.stopPropagation();
  bandMenu.value = null;
  bassMenu.value = null;
  const box = host.value?.getBoundingClientRect();
  const x = Math.round(ev.clientX - (box?.left ?? 0));
  const y = Math.round(ev.clientY - (box?.top ?? 0));
  const maxX = Math.max(0, (host.value?.clientWidth ?? 0) - 210);
  const maxY = Math.max(0, (host.value?.clientHeight ?? 0) - 62);
  chordMenu.value = { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  return true;
}

/** 菜单里的勾选项：开/关「每次都自动生成字母和弦」 */
function toggleChordAutofill() {
  const next = !chordAutofill.value;
  chordAutofill.value = next;
  try {
    localStorage.setItem('ma-chord-autofill', next ? '1' : '0');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'chordAutofill' } }));
  chordMenu.value = null;
  lastAction.value = { key: next ? 'grid.chordFill.autoOn' : 'grid.chordFill.autoOff' };
}

/* ---------- 斯波索宾体系：从级数 / 字母和弦推导 ----------
 *
 * 两条独立入口（用户明确要的）：
 *   ① 从级数标记 —— 可靠。级数本身就带功能信息（V 是属、vii° 是导音）
 *   ② 从字母和弦 —— 要先按该 tick 的调性反推级数，反推可能出错，所以单独一个菜单项
 * 自动模式只跟 ①：字母和弦反推级数这一步不该偷偷跑。
 *
 * 写法规则全在 `shared/sposobin.js`（大小写跟和弦性质、四六写作 46、副和弦级数大写）。
 */

/** 目标行 `sposobin`：只有「斯波索宾体系」这一套泳道方案里有 */
const sposobinLaneVisible = computed(() => lanes.value.some((l: any) => l.id === 'sposobin'));

/**
 * 级数 → 斯波索宾标记。用库里算好的 `parsed`（含该 tick 的调性与功能信息），
 * 刚敲完还没回库的文本才现解析。
 */
function sposobinOfDegree(text: string, tick: number, parsed?: any): string | null {
  const key = keyNameAt(tick);
  if (!key) return null;
  const p = parsed && parsed.ok ? parsed : parseChord(text, { key });
  return p ? sposobinOf(p, key) : null;
}

/**
 * 字母和弦 → 斯波索宾标记（反推级数）。
 *
 * 绝对和弦本身不含调性，所以必须有该 tick 的调名；反推出来的级数若带变化音
 * （调外和弦），转换器会返回 null —— 那种情况本来就没有唯一的斯波索宾写法。
 */
function sposobinOfLetter(text: string, tick: number): string | null {
  const key = keyNameAt(tick);
  if (!key) return null;
  const p = parseChord(String(text ?? ''));
  return p ? sposobinOf(p, key) : null;
}

function sposobinEventAt(tick: number): any | null {
  return (props.analysis?.events ?? []).find((e: any) => e.lane === 'sposobin' && e.tick === tick) ?? null;
}

async function writeSposobinAt(tick: number, dur: number, name: string): Promise<boolean> {
  const a = props.analysis;
  if (!a || !(dur > 0)) return false;
  const old = sposobinEventAt(tick);
  if (old && String(old.text ?? '') === name && Number(old.durTicks) === dur) return false;
  const api = (window as any).api;
  if (old?.id) {
    await api.analysis.upsertEvent({
      id: old.id,
      analysisId: a.id,
      lane: 'sposobin',
      tick,
      durTicks: dur,
      text: name,
    });
  } else {
    await api.analysis.writeRange({
      analysisId: a.id,
      lanes: ['sposobin'],
      startTick: tick,
      endTick: tick + dur,
      text: name,
    });
  }
  return true;
}

/**
 * 整曲生成。
 * @param from 'degree' 从级数标记 / 'chord' 从字母和弦标记
 */
async function fillSposobin(from: 'degree' | 'chord') {
  (window as any)[from === 'degree' ? '__sposobinFillCalls' : '__sposobinFillChordCalls'] =
    ((window as any)[from === 'degree' ? '__sposobinFillCalls' : '__sposobinFillChordCalls'] || 0) + 1;
  sposobinMenu.value = null;
  const a = props.analysis;
  if (!a || !sposobinLaneVisible.value) return;
  const rows = (a.events ?? []).filter((e: any) => e.lane === from);
  if (!rows.length) {
    lastAction.value = { key: 'grid.sposobinFill.empty' };
    return;
  }
  let filled = 0;
  let skipped = 0;
  await mutate({ key: 'grid.act.sposobinFill' }, async () => {
    for (const e of rows) {
      const name = from === 'degree' ? sposobinOfDegree(e.text, e.tick, e.parsed) : sposobinOfLetter(e.text, e.tick);
      if (!name) {
        skipped++;
        continue;
      }
      if (await writeSposobinAt(e.tick, Number(e.durTicks) || ppq.value, name)) filled++;
    }
    return filled;
  });
  lastAction.value = filled
    ? { key: skipped ? 'grid.act.sposobinFillSkip' : 'grid.act.sposobinFill', vars: { n: filled, skipped } }
    : { key: 'grid.sposobinFill.empty' };
}

/** 在 `sposobin` 行上右键 → 开菜单（标签那一格和网格正文都算） */
function openSposobinMenuAt(ev: MouseEvent, docY: number): boolean {
  if (!props.analysis || !sposobinLaneVisible.value) return false;
  const g = lanesGeom.value.find((it: any) => it.lane?.id === 'sposobin');
  if (!g || docY < g.y || docY >= g.y + g.h) return false;
  ev.preventDefault();
  ev.stopPropagation();
  bandMenu.value = null;
  bassMenu.value = null;
  chordMenu.value = null;
  const box = host.value?.getBoundingClientRect();
  const x = Math.round(ev.clientX - (box?.left ?? 0));
  const y = Math.round(ev.clientY - (box?.top ?? 0));
  const maxX = Math.max(0, (host.value?.clientWidth ?? 0) - 246);
  const maxY = Math.max(0, (host.value?.clientHeight ?? 0) - 86);
  sposobinMenu.value = { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  return true;
}

function toggleSposobinAutofill() {
  const next = !sposobinAutofill.value;
  sposobinAutofill.value = next;
  try {
    localStorage.setItem('ma-sposobin-autofill', next ? '1' : '0');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'sposobinAutofill' } }));
  sposobinMenu.value = null;
  lastAction.value = { key: next ? 'grid.sposobinFill.autoOn' : 'grid.sposobinFill.autoOff' };
}

/** 选区 → 输入框落点（文档坐标）：openEditor 与缩放后重定位共用 */
/**
 * 输入框相对选区左上角的偏移：**往右下挪一点**。
 *
 * 以前输入框正好压在选区上（`x = 起点 + 3`、纵向居中）—— 一进输入态，选区高亮、
 * 左右两条边界全被盖住，用户看不出自己选到哪儿（本次报的就是这个）。
 * 挪开之后选区的左上角和左边那条边露在外面，一眼能确认起点。
 *
 * 为什么不是「整个挪到选区下方」：泳道只有 22px 高（`LANE_ROW_MAX`），18px 的输入框
 * 挪到下方一定会压住下一行，视线还得来回跳。现在这样仍在同一行附近，
 * 纵向也不超过半个泳道，不会看起来像「跑到下一条泳道去了」。
 */
const EDIT_DX = 6;
const EDIT_DY = 6;

function positionOf(s: { lanes: string[]; startTick: number; endTick: number }) {
  const geoms = lanesGeom.value.filter((g) => s.lanes.includes(g.lane.id));
  if (!geoms.length) return null;
  const top = Math.min(...geoms.map((g) => g.y));
  const lh = Math.max(...geoms.map((g) => g.h));
  const left = xOfTick(s.startTick);
  const width = Math.max(86, Math.min(280, xOfTick(s.endTick) - left - 6));
  // 输入框 18px，泳道最矮 16px —— 用 max(0) 兜住，别让它往上顶出格子
  return {
    x: left + 3 + EDIT_DX,
    y: top + Math.max(0, Math.round((lh - 18) / 2)) + EDIT_DY,
    width,
  };
}

function openEditor(text: string, opts: { reveal?: boolean } = {}) {
  const s = selection.value;
  if (!s) return;
  cancelEdit = false;
  if (opts.reveal) revealRange(s);
  const p = positionOf(s);
  if (!p) return;
  editing.value = { ...p, text };
  // 打开时按已有文本先给一次候选：双击一条「K46」再改，比清空重打省事
  closeCellSug();
  nextTick(() => {
    const el = document.querySelector('.cell-input') as HTMLInputElement | null;
    /**
     * **`preventScroll: true` 是必须的。**
     *
     * `focus()` 的默认行为会把「聚焦的元素」滚进可视区 —— 输入框是绝对定位在
     * `.scroll` 这个滚动容器里的，于是它会**顺手改 scrollLeft / scrollTop**。
     * 以前输入框正好盖在格子上，离容器边缘远，这个副作用看不出来；
     * 一往右下偏移（+14/+8），靠边那一格就压到边界外，focus 当场把视口顶走 ——
     * 紧接着的点击坐标全部偏掉（冒烟里「拖右边缘」「Ctrl+点」「拖播放头」一起红，
     * 而且看起来完全不像同一个问题）。
     *
     * 视口该由 `revealRange()` 显式管，不能交给浏览器的默认行为。
     */
    el?.focus({ preventScroll: true });
    el?.select();
  });
}

/** 把区间滚进可视区（Enter 一路往下写时会跑到屏幕外） */
function revealRange(r: { startTick: number; endTick: number }) {
  const from = viewLeft.value;
  const to = from + viewW.value;
  const x0 = xOfTick(r.startTick);
  const x1 = xOfTick(r.endTick);
  if (x0 < from) setScrollLeft(x0 - 24);
  else if (x1 > to) setScrollLeft(x1 - viewW.value + 24);
}

/**
 * 按格前后跳：dir=1 走下一格右边界，dir=-1 回到上一格起点。
 * 用 cellAtTick 而不是加减常数，变拍号时也不会算错。
 */
function stepTick(from: number, n: number, dir: 1 | -1) {
  let tick = from;
  for (let i = 0; i < n; i++) {
    if (dir > 0) {
      const c = cellAtTick(meters.value, ppq.value, tick, div.value);
      tick = Math.round(c.start + c.grid.cellTicks);
    } else {
      // 点在格线上时 -1 会落进前一格，这正是「退回一格」想要的
      const c = cellAtTick(meters.value, ppq.value, Math.max(0, tick - 1), div.value);
      tick = c.start;
    }
  }
  return tick;
}

/** Enter 之后：选区整体后移同样格数，并继续输入（表格软件的手感） */
function advance() {
  const s = selection.value;
  if (!s) return;
  const n = Math.max(1, countCells(meters.value, ppq.value, s.startTick, s.endTick, div.value));
  const limit = barToTick(meters.value, totalBars.value + 1, ppq.value);
  const startTick = s.endTick;
  if (startTick >= limit) return;
  const endTick = Math.min(stepTick(startTick, n, 1), limit);
  selection.value = { lanes: [...s.lanes], startTick, endTick };
  openEditor(textOfSelection(), { reveal: true });
  scheduleDraw();
}

/**
 * Backspace：退回**一格**并进入输入。
 *
 * 「一格」是**当前网格单位**（小节 / 拍 / 半拍，`div`），不是固定的一拍 ——
 * 用户 2026-11-23 的要求：「根据网格选定的」。
 * 以前写死 `stepTick(startTick, 1, -1)`（一拍），网格设成小节时按一下只退 1/4 格，
 * 和光标看得见的格子对不上。
 */
function goBack() {
  const s = selection.value;
  if (!s) return;
  // 退一格：落在「起点前 1 tick」所在的格子上，宽度取那一格自己的宽度
  const c = cellAtTick(meters.value, ppq.value, Math.max(0, s.startTick - 1), div.value);
  selection.value = {
    lanes: [...s.lanes],
    startTick: Math.round(c.start),
    endTick: Math.round(c.start + c.grid.cellTicks),
  };
  openEditor(textOfSelection(), { reveal: true });
  scheduleDraw();
}

function textOfSelection() {
  // 只认「与选区完全重合」的那条：选区落在一个大块中间时文本是空的（那是新格子，不是改这条块）。
  // 没有矩形、只有离散选中时，`exactSelEvents` 就是那几块本身。
  const first = exactSelEvents.value[0];
  return first ? String(first.text ?? '') : '';
}

// ---------- 写库 ----------

/**
 * 「这一次到底有没有改动库？」
 *
 * **别只盯几个字段名。** v0.51 之前这里写的是
 * `stat.inserted || stat.removed || stat.trimmed`，而 `moveEvents()` 返回的是
 * `{ moved, removed, trimmed }` —— 纯移动（拖到空位、没有压住邻居）时三个字段全 0，
 * 于是**一步历史都不记**。后果：用户删一块、再拖一块，Ctrl+Z 只撤一步就回到了「删除之前」，
 * 看起来像「删除和拖动被合并成一个动作」。
 *
 * 现在改成：返回对象里**任何数值字段 > 0** 都算动过。以后新增写接口不会再被漏掉
 * （老写法是黑名单式的，加一个接口就要记得来改这里，而漏改不报错）。
 */
function didTouch(stat: any): boolean {
  if (typeof stat === 'number') return stat > 0;
  if (!stat || typeof stat !== 'object') return false;
  return Object.values(stat).some((v) => typeof v === 'number' && v > 0);
}

async function mutate(label: ActionLabel, fn: () => Promise<any>) {
  const a = props.analysis;
  if (!a) return null;
  // 撤销用整份快照：区间写入会截短/拆分既有事件，逐条反做不可靠
  const snapshot = JSON.parse(JSON.stringify(a.events ?? []));
  const stat = await fn();
  const touched = didTouch(stat);
  if (touched) {
    lastAction.value = label;
    /**
     * 记一步到主进程的历史里。
     * before 用组件刚才抓的那份（写库之前的模样）；after 由主进程自己从库里读 ——
     * 这一刻 props 还是旧的，不能拿它当「做完之后」。
     */
    try {
      await (window as any).api?.history?.append?.({
        trackId: a.trackId,
        title: props.title,
        analysisId: a.id,
        label,
        before: snapshot,
      });
    } catch (e) {
      // 记不上历史不该影响这次编辑本身（数据已经落库了）
      console.error('[grid] 记录历史失败', e);
    }
    // 自己动的手，自己刷一次按钮状态 —— 不要指望广播一定到（跨窗口才靠它）
    refreshHistCan();
  }
  emit('changed');
  scheduleDraw();
  return stat;
}

function payload() {
  const s = selection.value!;
  return { analysisId: props.analysis.id, lanes: [...s.lanes], startTick: s.startTick, endTick: s.endTick };
}

async function fill(text: string) {
  const s = selection.value;
  if (!s || !props.analysis) return null;
  const value = String(text ?? '').trim();
  if (!value) return null;
  /**
   * 写的是级数行 = 这一块级数刚被用户确认 → 自动模式下顺手把低音跟上。
   *
   * 与和弦写入**共用一次 mutate**：同一个撤销快照，一次 Ctrl+Z 两条一起回。
   * 选区里显式带了 `bass` 行时不接管 —— 那是用户当着低音行写的文本，别再改他的。
   */
  const autoBass =
    bassAutofill.value && bassFillable.value && s.lanes.includes('degree') && !s.lanes.includes('bass')
      ? bassNameOf(value, s.startTick)
      : null;
  /**
   * 字母和弦同理，但**不要求那一行当前可见**：写级数最常见的地方就是罗马数字视图，
   * 那里根本没有 `chord` 行 —— 要求可见等于让这个开关永远不生效。
   * 写进去的是同一份分析的另一条泳道，切到字母和弦视图就能看见。
   */
  const autoChord =
    chordAutofill.value && s.lanes.includes('degree') && !s.lanes.includes('chord')
      ? letterNameOf(value, s.startTick)
      : null;
  /** 斯波索宾同理：目标行在别的视图里，不要求可见 */
  const autoSposobin =
    sposobinAutofill.value && s.lanes.includes('degree') && !s.lanes.includes('sposobin')
      ? sposobinOfDegree(value, s.startTick)
      : null;
  return mutate({ key: 'grid.act.write', vars: { value } }, async () => {
    const r = await (window as any).api.analysis.writeRange({ ...payload(), text: value });
    if (autoBass) await writeBassAt(s.startTick, s.endTick - s.startTick, autoBass);
    if (autoChord) await writeChordAt(s.startTick, s.endTick - s.startTick, autoChord);
    if (autoSposobin) await writeSposobinAt(s.startTick, s.endTick - s.startTick, autoSposobin);
    return r;
  });
}

async function commitCore(): Promise<boolean> {
  const ed = editing.value;
  if (!ed || committing) return false;
  const s = selection.value;
  committing = true;
  editing.value = null;
  try {
    if (!s || !props.analysis) return false;
    const text = ed.text.trim();
    if (!text) {
      // 清空文本 = 清空这几格
      if (selEvents.value.length) {
        await deleteSelection();
        return true;
      }
      scheduleDraw();
      return false;
    }
    // 内容没改就不写库：框完松手会打开输入框，随后一点别处就 blur，
    // 不设这一道每次都会白写一遍同样的值（还会污染撤销栈）
    if (text === textOfSelection()) return false;
    const stat = await fill(text);
    return !!stat;
  } finally {
    committing = false;
  }
}

/** Enter：有候选先采纳，否则先写库、再把选区整体后移同样格数继续输入 */
async function onEnterKey(ev?: KeyboardEvent) {
  // 组合期：Enter 是「确认候选词」。
  // 模板上不能写 .prevent —— 它在这里也会执行，会把输入法的候选词上屏打断。
  if (ev && isComposing(ev)) return;
  ev?.preventDefault();
  if (!editing.value) return;
  /**
   * 与 TagPicker / 调性框同一套 pickMode：采纳会改文本时才停一步。
   * 所以「打全了 Cad64 再回车」是一次落库，不会卡在「按了没反应」。
   */
  const hit = cellSug.value.open ? cellSug.value.items[cellSug.value.active] : null;
  if (hit && pickMode(editing.value.text.trim(), { name: hit.value, display: hit.value }, locale.value) === 'adopt') {
    applyCellSug(hit);
    return;
  }
  closeCellSug();
  await commitCore();
  advance();
}

/** 失焦（点到别处）只提交，不动选区 */
async function onBlurEdit() {
  if (cancelEdit) {
    cancelEdit = false;
    return;
  }
  if (committing) return;
  closeCellSug();
  await commitCore();
}

/**
 * 输入框里的退格 / 删除：**框里没字时**当成网格操作。
 * 框选松手就开输，所以「框一段 → 想删掉」时按 Delete 不能什么都不发生。
 */
function onInputKey(ev: KeyboardEvent) {
  if (isComposing(ev)) return;   // 组合期 Backspace 是在改拼音，不是删格；↑↓ 是输入法翻页
  // 候选开着时 ↑↓ 选、Esc 关列表（不退出编辑）
  if (cellSug.value.open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
    ev.preventDefault();
    const n = cellSug.value.items.length;
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    cellSug.value.active = (cellSug.value.active + step + n) % n;
    return;
  }
  /**
   * 输入态里的 Alt+←/→：也改选区大小（v0.54）。
   *
   * 语义与非输入态**完全一致**（不按 Shift 只动右端、按住 Shift 只动左端，
   * 一格 = 当前显示单位），区别只是改完**留在输入框里**：字和光标都不动，
   * 选区在背后变宽变窄，`editingView` 靠 `watch(selection)` 跟着挪。
   *
   * 必须 preventDefault：Alt+← 在很多环境里是「后退」，冒泡出去会整页导航。
   *
   * 两种情形分开处理：
   *  - 选区正好等于**一条已有事件** → 走 `nudgeSpan()`，那条事件真的被改长改短，
   *    画布上立刻能看到（也记一步撤销）；
   *  - 空格子（还没写东西）→ 没有事件可改，直接改**选区跨度**；
   *    回车提交时 `fill()` 按当前选区写，所以「先拉到两拍再打字」是成立的。
   */
  if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    ev.preventDefault();
    const side = ev.shiftKey ? 'left' : 'right';
    const dir = ev.key === 'ArrowLeft' ? -1 : 1;
    const s = selection.value;
    const exact = s
      ? selEvents.value.filter((e: any) => e.tick === s.startTick && e.tick + e.durTicks === s.endTick)
      : [];
    if (exact.length === 1) void nudgeSpan(side, dir);
    else resizeSelection(side, dir);
    return;
  }
  /**
   * Esc **不再**只关候选列表。
   *
   * 以前这里会 `stopImmediatePropagation()` 把 Esc 吃掉、只收起候选 —— 当时级数泳道
   * 几乎没有候选，所以没人察觉。现在打一个 `V` 就会弹出一排候选，
   * 于是「按 Esc 退出输入」变成要按两次（第一次只关列表），和这个应用里所有其它 Esc
   * （取消段落编辑、关弹窗、关菜单）都不一致。
   * 统一成「Esc = 取消这次输入」：候选由 `onEscEdit` 里的 closeCellSug 一并收掉。
   */
  if (ev.key !== 'Backspace' && ev.key !== 'Delete') return;
  if ((editing.value?.text ?? '') !== '') return; // 有字就是正常删字
  ev.preventDefault();
  cancelEdit = true;
  editing.value = null;
  if (ev.key === 'Backspace') goBack();
  else void deleteSelection();
}

/** Esc：放弃这次输入（不能顺手把内容写进去） */
function onEscEdit(ev?: KeyboardEvent) {
  ev?.preventDefault();
  cancelEdit = true;
  editing.value = null;
  closeCellSug();
  scheduleDraw();
}

/** 复制选区（矩形命中的 ∪ 离散选中的）到内部剪贴板 */
function copySelection() {
  const evs = selEvents.value;
  if (!evs.length) return 0;
  const items = evs.map((e: any) => ({
    lane: e.lane,
    tick: e.tick,
    durTicks: e.durTicks,
    text: String(e.text ?? ''),
  }));
  // 基准泳道取「最靠上的一条」，粘到别的泳道时按行号差落位
  const baseLane = items.slice().sort((a, b) => laneIndexOf(a.lane) - laneIndexOf(b.lane))[0].lane;
  clip.value = { items, baseTick: Math.min(...items.map((i) => i.tick)), baseLane };
  lastAction.value = { key: 'grid.act.copy', vars: { n: items.length } };
  return items.length;
}

/**
 * 算「粘贴会落到哪」：以当前选区起点为锚，保持各条的相对 tick 与相对泳道。
 * 同时数一下目标位置已经有多少条事件会被裁短/替换 —— 那是确认框要说的数字。
 */
function planPaste() {
  const c = clip.value;
  const s = selection.value;
  if (!c || !s || !props.analysis || !lanes.value.length) return null;
  const targetTick = s.startTick;
  const targetIdx = Math.max(0, laneIndexOf(s.lanes[0] ?? c.baseLane));
  const baseIdx = Math.max(0, laneIndexOf(c.baseLane));
  const placed = c.items.map((it) => {
    const li = Math.max(0, Math.min(lanes.value.length - 1, targetIdx + (laneIndexOf(it.lane) - baseIdx)));
    return {
      lane: lanes.value[li]?.id ?? s.lanes[0],
      tick: Math.max(0, targetTick + (it.tick - c.baseTick)),
      durTicks: it.durTicks,
      text: it.text,
    };
  });
  const conflicts = viewEvents.value.filter((e: any) =>
    placed.some((p) => p.lane === e.lane && e.tick < p.tick + p.durTicks && e.tick + e.durTicks > p.tick)
  ).length;
  return { placed, conflicts };
}

async function doPaste(placed: any[]) {
  const a = props.analysis;
  if (!a) return null;
  pasteAsk.value = null;
  const stat = await mutate({ key: 'grid.act.paste', vars: { n: placed.length } }, async () => {
    let n = 0;
    for (const p of placed) {
      // 走 writeRange：落点上已有的内容会被裁短/拆开（和 Alt 拖动复制同一套规则）
      const r = await (window as any).api.analysis.writeRange({
        analysisId: a.id,
        lanes: [p.lane],
        startTick: p.tick,
        endTick: p.tick + p.durTicks,
        text: p.text,
      });
      n += r?.inserted ?? 0;
    }
    return n;
  });
  if (stat) {
    selection.value = {
      lanes: [...new Set(placed.map((p) => p.lane))],
      startTick: Math.min(...placed.map((p) => p.tick)),
      endTick: Math.max(...placed.map((p) => p.tick + p.durTicks)),
    };
    pickedIds.value = [];
    kickSelFade();
  }
  scheduleDraw();
  return stat;
}

async function pasteClipboard() {
  const plan = planPaste();
  if (!plan) return null;
  if (plan.conflicts > 0 && pasteWarn.value) {
    pasteAsk.value = { count: plan.conflicts, placed: plan.placed };
    return null;
  }
  return doPaste(plan.placed);
}

/** 确认框里点了「仍然粘贴」 */
function confirmPaste() {
  const p = pasteAsk.value;
  if (p) return doPaste(p.placed);
  return null;
}

/** 确认框里勾了「不再提醒」 */
function mutePasteWarn() {
  pasteWarn.value = false;
  try {
    localStorage.setItem('ma-paste-warn', '0');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'pasteWarn' } }));
}

async function deleteSelection() {
  const s = selection.value;
  if (!s || !props.analysis || !selEvents.value.length) return null;
  editing.value = null;
  // 有离散选中时只能按 id 删（clearRange 只认矩形）；删完把离散集合清掉
  if (pickedIds.value.length) {
    const ids = selEvents.value.map((e: any) => e.id);
    const stat = await mutate({ key: 'grid.act.deleteSel' }, () => (window as any).api.analysis.deleteEvents(ids));
    pickedIds.value = [];
    return stat;
  }
  return mutate({ key: 'grid.act.deleteSel' }, () => (window as any).api.analysis.clearRange(payload()));
}

async function deleteIds(ids: string[]) {
  if (!ids.length) return null;
  editing.value = null;
  return mutate({ key: 'grid.act.deleteIds' }, () => (window as any).api.analysis.deleteEvents(ids));
}

/** 问一次主进程「当前曲目还能不能撤/重做」（切曲、撤销完都要刷） */
function refreshHistCan() {
  const a = props.analysis;
  if (!a) {
    histCan.value = { undo: false, redo: false };
    return;
  }
  void (window as any).api?.history
    ?.can?.(a.id)
    .then((c: any) => {
      if (c) histCan.value = { undo: !!c.undo, redo: !!c.redo };
    })
    .catch(() => {
      /* 历史模块没起来就当作不能撤 */
    });
}

/** 历史变了的统一入口：主进程广播 = 别的窗口/别处动了手（含本窗口，重复算一次无害） */
function onHistChanged(st: any) {
  histCalls++;
  histLast = st;
  const aid = props.analysis?.id;
  if (!aid || !st) return;
  const cur = st.cursors?.[aid];
  const mine = (st.items ?? []).filter((i: any) => i.analysisId === aid);
  histCan.value = {
    undo: cur != null && mine.some((i: any) => i.seq < cur),
    redo: cur != null && mine.some((i: any) => i.seq > cur),
  };
}

/** 撤销 / 重做都走主进程的历史：这里只发指令、等它把数据写回去 */
async function undo() {
  const a = props.analysis;
  if (!a) return false;
  const r = await (window as any).api?.history?.undo?.(a.id);
  if (!r?.ok) return false;
  lastAction.value = { key: 'grid.act.undo', vars: { label: labelText(r.label) } };
  emit('changed');
  scheduleDraw();
  refreshHistCan();
  return true;
}

async function redo() {
  const a = props.analysis;
  if (!a) return false;
  const r = await (window as any).api?.history?.redo?.(a.id);
  if (!r?.ok) return false;
  lastAction.value = { key: 'grid.act.redo', vars: { label: labelText(r.label) } };
  emit('changed');
  scheduleDraw();
  refreshHistCan();
  return true;
}

/**
 * 全局撤销/重做：不看当前曲目，直接动全局游标那一步。
 * 落在别的曲子上时由主进程广播 `history:applied`，App 负责把界面切过去。
 */
async function undoGlobal() {
  const r = await (window as any).api?.history?.undoGlobal?.();
  if (!r?.ok) return false;
  lastAction.value = { key: 'grid.act.undoGlobal', vars: { title: r.title ?? '' } };
  emit('changed');
  scheduleDraw();
  refreshHistCan();
  return true;
}

async function redoGlobal() {
  const r = await (window as any).api?.history?.redoGlobal?.();
  if (!r?.ok) return false;
  lastAction.value = { key: 'grid.act.redoGlobal', vars: { title: r.title ?? '' } };
  emit('changed');
  scheduleDraw();
  refreshHistCan();
  return true;
}

/** 历史标签在返回值里是「键 + 变量」，这里负责按当前语言拼出来 */
function labelText(label: any): string {
  return label?.key ? t(label.key, label.vars) : '';
}

function clearSelection() {
  selection.value = null;
  pickedIds.value = [];
  pickAnchor = null;
  editing.value = null;
  followOwned.value = false;
  scheduleDraw();
}

/**
 * Alt + 方向键：改覆盖范围，一步一格（格尺度 = 用户当前选的单位：小节 / 拍 / 半拍）。
 *
 * 两端分工（用户 2026-10-31 澄清后定的）：
 *   **无 Shift = 只动右端**：Alt+← 从右边收（end 左移，选区变短）、Alt+→ 向右扩（end 右移）
 *   **有 Shift = 只动左端**：Alt+Shift+← 向左扩（start 左移）、Alt+Shift+→ 从左边收（start 右移）
 *
 * 记一笔踩过的坑：第一版我把「缩小」做成了「左边界右移」（从左边收），
 * 而用户说的「缩小」是「右边界往左收」—— 同一个词，收的是不同那一侧。
 * 现在四个键不重复：不按 Shift 摸右端，按 Shift 摸左端。
 *
 * 只处理「选区正好等于一条事件」的情况 —— 多条一起改范围的语义不明确，宁可不做。
 */
async function nudgeSpan(side: 'left' | 'right', dir: 1 | -1) {
  const s = selection.value;
  const a = props.analysis;
  if (!s || !a) return;
  const exact = selEvents.value.filter(
    (e: any) => e.tick === s.startTick && e.tick + e.durTicks === s.endTick
  );
  if (exact.length !== 1) return;
  const e = exact[0];
  const unit = Math.max(
    1,
    Math.round(cellAtTick(meters.value, ppq.value, e.tick, div.value).grid.cellTicks)
  );
  let start = e.tick;
  let end = e.tick + e.durTicks;
  if (side === 'right') end += dir * unit;
  else start += dir * unit;
  if (end - start < unit) return; // 不许缩成 0 长度，那等于删掉
  if (start < 0) start = 0;
  if (start === e.tick && end === e.tick + e.durTicks) return;

  const stat = await mutate({ key: 'grid.act.resize' }, () =>
    (window as any).api.analysis.resize({
      analysisId: a.id,
      lanes: [e.lane],
      fromTick: e.tick,
      toTick: e.tick + e.durTicks,
      startTick: start,
      endTick: end,
      text: String(e.text ?? ''),
    })
  );
  if (stat) selection.value = { lanes: [e.lane], startTick: start, endTick: end };
}

/**
 * 只改**选区跨度**，不碰库（没有事件可改的时候用它）。
 *
 * 场景是「空格子进输入态后按 Alt+方向键」：那里一条事件都还没有，`nudgeSpan()` 无从下手。
 * 现在先把选区拉宽，回车提交时 `fill()` 按当前选区写 —— 于是「先拉到两拍再打字」成立。
 *
 * 边界规则跟 `nudgeSpan()` 对齐：不许缩到一格以下、起点不许小于 0。
 */
function resizeSelection(side: 'left' | 'right', dir: 1 | -1) {
  const s = selection.value;
  if (!s) return;
  const unit = Math.max(
    1,
    Math.round(cellAtTick(meters.value, ppq.value, s.startTick, div.value).grid.cellTicks)
  );
  let start = s.startTick;
  let end = s.endTick;
  if (side === 'right') end += dir * unit;
  else start += dir * unit;
  if (end - start < unit) return;
  if (start < 0) start = 0;
  if (start === s.startTick && end === s.endTick) return;
  selection.value = { lanes: [...s.lanes], startTick: start, endTick: end };
  scheduleDraw();
}

/**
 * 左右方向键：**同一条泳道里**选上一块 / 下一块。
 *
 * 两条规则（用户 2026-10-31 定的）：
 *  - 有选区：以选区起点为基准，同泳道里找 tick 严格更小 / 更大的**最近**一块；
 *    到这一行的头尾就**停住**，不跳去别的泳道 —— 跨行会让人失去方位感（那是上下键的事）。
 *  - 没有选区：选**视口里**最靠左 / 最右的一块，跟滚动位置走。
 *    （不选"整首第一块"：按一下就把人带到曲首，来回翻太跳。）
 *
 * 只认 `viewEvents`（当前视图可见的泳道）：数据跨视图共享，别的泳道的事件既不该被选中、
 * 也不该出现在「下一个」里 —— 红线：UI 的选中/高亮只认当前可见泳道。
 */
/** 光标/选区所在的格子宽度（tick）。所有平移都按它走，**不加常数**（变拍号会错格） */
function cellWidthAt(tick: number) {
  return Math.max(1, Math.round(cellAtTick(meters.value, ppq.value, Math.max(0, tick), div.value).grid.cellTicks));
}

/** 某一格 `[from, to)` 里**起点**落在其中的块 —— 「光标停在和弦上」的判据 */
function blockStartingIn(laneIds: string[], from: number, to: number) {
  return (
    (viewEvents.value as any[])
      .filter((e) => laneIds.includes(e.lane) && e.tick >= from && e.tick < to)
      .sort((a, b) => a.tick - b.tick)[0] ?? null
  );
}

/**
 * 保证选区整格可见。
 *
 * 水平沿用 `revealRange`；**垂直这一段是新加的** —— 有了 ↑/↓ 换泳道，
 * 光标会跑到视口上下之外，只滚水平等于「选中了一个看不见的东西」。
 */
function revealSelection() {
  const s = selection.value;
  if (!s) return;
  revealRange({ startTick: s.startTick, endTick: s.endTick });
  const box = scroller.value;
  if (!box) return;
  const geoms = lanesGeom.value.filter((g: any) => s.lanes.includes(g.lane.id));
  if (!geoms.length) return;
  const y0 = Math.min(...geoms.map((g: any) => g.y));
  const y1 = Math.max(...geoms.map((g: any) => g.y + g.h));
  const head = headH.value;
  const top = box.scrollTop;
  if (y0 < top + head) box.scrollTop = Math.max(0, y0 - head - 8);
  else if (y1 > top + hostH.value) box.scrollTop = y1 - hostH.value + 8;
}

/** 落一个选区：清离散选中、保证可见、重绘 */
function placeSelection(next: { lanes: string[]; startTick: number; endTick: number }) {
  selection.value = next;
  pickedIds.value = [];
  pickAnchor = null;
  revealSelection();
  scheduleDraw();
}

/**
 * `←` / `→`：**移动一格**（宽度保持不变）。
 *
 * 光标态（宽度正好一格）时，新位置这一格里若有块的**起点**就吸附成整块 ——
 * 按 → 的意图就是「下一个和弦」，框了半格反而像没选中。
 * 宽度 > 1 格时**只平移不吸附**：那是「把这块区域整体挪一格」，吸到某一个块上会毁掉范围。
 */
function moveCursor(dir: -1 | 1) {
  const s = selection.value;
  const P = ppq.value;
  if (!s) {
    const lane = lanes.value[0]?.id;
    if (!lane) return;
    const c = cellAtTick(meters.value, P, Math.max(0, tickAtX(viewLeft.value).tick), div.value);
    placeSelection({ lanes: [lane], startTick: Math.round(c.start), endTick: Math.round(c.start + c.grid.cellTicks) });
    return;
  }
  const width = s.endTick - s.startTick;
  const cell = cellWidthAt(s.startTick);
  const isCursor = width <= cell + 0.5;
  let start: number;
  /*
   * **左右必须用同一套步长**：步长 = 选区宽度（用户 2026-11-23 的要求）。
   *
   * 右移取「右端所在格的起点」，天然等于「起点 + 宽度」（宽度是格宽的整数倍时）；
   * 左移早先是「起点 - 1 tick 所在格的起点」，那只有**一格** ——
   * 框选三格时右键走三格、左键走一格，手感差得很明显。
   * 现在两边都按宽度退，再用 cellAtTick 对齐到格边界（变拍号时不会错格）。
   */
  if (dir > 0) start = Math.round(cellAtTick(meters.value, P, s.endTick, div.value).start);
  else {
    start = Math.round(cellAtTick(meters.value, P, Math.max(0, s.startTick - width), div.value).start);
    if (start === s.startTick) return; // 已经贴到 0
  }
  let end = start + width;
  if (isCursor) {
    const hit = blockStartingIn(s.lanes, start, start + cell);
    if (hit) {
      start = hit.tick;
      end = hit.tick + hit.durTicks;
    }
  }
  placeSelection({ lanes: s.lanes, startTick: start, endTick: end });
}

/** `Ctrl+←/→`：当前泳道跳到上一块 / 下一块（**不跨泳道**，跨泳道交给 ↑/↓） */
function jumpBlock(dir: -1 | 1) {
  const s = selection.value;
  const lane = s?.lanes[0] ?? lanes.value[0]?.id;
  if (!lane) return;
  const from = s ? s.startTick : Number.NEGATIVE_INFINITY;
  const cands = (viewEvents.value as any[]).filter((e) => e.lane === lane && (dir < 0 ? e.tick < from : e.tick > from));
  if (!cands.length) return; // 到头了：停住
  const pick = cands.reduce((best, e) => (dir < 0 ? (e.tick > best.tick ? e : best) : e.tick < best.tick ? e : best));
  placeSelection({ lanes: [pick.lane], startTick: pick.tick, endTick: pick.tick + pick.durTicks });
}

/** `Ctrl+Shift+←/→`：把选区扩到上一块 / 下一块的边界 */
function extendToBlock(dir: -1 | 1) {
  const s = selection.value;
  if (!s) {
    jumpBlock(dir);
    return;
  }
  const lane = s.lanes[0];
  const cands = (viewEvents.value as any[]).filter(
    (e) => e.lane === lane && (dir < 0 ? e.tick + e.durTicks <= s.startTick : e.tick >= s.endTick)
  );
  if (!cands.length) return;
  const pick = cands.reduce((best, e) => (dir < 0 ? (e.tick > best.tick ? e : best) : e.tick < best.tick ? e : best));
  placeSelection({
    lanes: [lane],
    startTick: dir < 0 ? pick.tick : s.startTick,
    endTick: dir < 0 ? s.endTick : pick.tick + pick.durTicks,
  });
}

/**
 * `Shift+←/→`：扩 / 缩一格。
 *
 * `→` 把右端扩一格；`←` 先把右端收一格，**收不动了**（只剩一格）才改成向左扩一格 ——
 * 和文本编辑器里「Shift+反向键 = 收缩」的肌肉记忆一致。
 */
function extendByCell(dir: -1 | 1) {
  const s = selection.value;
  const P = ppq.value;
  if (!s) {
    moveCursor(dir);
    return;
  }
  const cell = cellWidthAt(s.startTick);
  const width = s.endTick - s.startTick;
  if (dir > 0) {
    const nextEnd = Math.round(cellAtTick(meters.value, P, s.endTick, div.value).start + cell);
    placeSelection({ lanes: s.lanes, startTick: s.startTick, endTick: nextEnd });
    return;
  }
  if (width > cell) {
    const prevEnd = Math.round(cellAtTick(meters.value, P, s.endTick - 1, div.value).start);
    placeSelection({ lanes: s.lanes, startTick: s.startTick, endTick: Math.max(s.startTick + cell, prevEnd) });
  } else {
    const prevStart = Math.round(cellAtTick(meters.value, P, Math.max(0, s.startTick - 1), div.value).start);
    if (prevStart === s.startTick) return;
    placeSelection({ lanes: s.lanes, startTick: prevStart, endTick: s.endTick });
  }
}

/** `↑` / `↓`：换泳道。tick 范围不变；换过去正好落在块上就吸附整块 */
function moveLane(dir: -1 | 1) {
  const ids = lanes.value.map((l: any) => l.id);
  if (!ids.length) return;
  const s = selection.value;
  const cur = s?.lanes[0] ?? ids[0];
  const i = ids.indexOf(cur);
  const next = ids[i + (s ? dir : 0)];
  if (!next) return; // 已经在最上 / 最下
  const anchor = s ? s.startTick : Math.round(cellAtTick(meters.value, ppq.value, Math.max(0, tickAtX(viewLeft.value).tick), div.value).start);
  const cell = cellWidthAt(anchor);
  const width = s ? s.endTick - s.startTick : cell;
  let end = anchor + width;
  if (width <= cell + 0.5) {
    const hit = blockStartingIn([next], anchor, anchor + cell);
    if (hit) end = hit.tick + hit.durTicks;
  }
  placeSelection({ lanes: [next], startTick: anchor, endTick: end });
}

function onKeydown(ev: KeyboardEvent) {
  const tag = (ev.target as HTMLElement | null)?.tagName;
  const inField = tag === 'INPUT' || tag === 'TEXTAREA';

  // 输入框里的按键一律先放行 —— Ctrl+Z 也包括在内。
  // 以前这条排在 inField 之前，于是在格子里敲错字按 Ctrl+Z，撤掉的是**上一笔网格操作**
  // （replaceEvents 直接写库），原生文本撤销还被 preventDefault 掉了。
  if (inField) return;

  // 右键菜单开着时 Esc 先关菜单（比「清选区」优先）
  if (bandMenu.value && ev.key === 'Escape') {
    ev.preventDefault();
    bandMenu.value = null;
    return;
  }
  if (bassMenu.value && ev.key === 'Escape') {
    ev.preventDefault();
    bassMenu.value = null;
    return;
  }
  if (chordMenu.value && ev.key === 'Escape') {
    ev.preventDefault();
    chordMenu.value = null;
    return;
  }
  if (sposobinMenu.value && ev.key === 'Escape') {
    ev.preventDefault();
    sposobinMenu.value = null;
    return;
  }

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    ev.preventDefault();
    // Shift = 全局（不看当前曲目）；不按 Shift 只撤这首
    void (ev.shiftKey ? undoGlobal() : undo());
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
    ev.preventDefault();
    void (ev.shiftKey ? redoGlobal() : redo());
    return;
  }

  // 复制 / 粘贴：内部剪贴板，不碰系统剪贴板（避免把外部粘进来的东西写进库里）
  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'c') {
    ev.preventDefault();
    copySelection();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === 'v') {
    ev.preventDefault();
    void pasteClipboard();
    return;
  }

  /**
   * `Ctrl+Alt+←/→`       移动播放头「粗步长」（默认 3 秒，选项里可改）
   * `Ctrl+Alt+Shift+←/→` 移动「细步长」（一帧，帧率口径见 playbackPrefs）
   *
   * **必须排在下面的 `Alt+←/→` 之前**：Ctrl+Alt 同样满足 `altKey`，
   * 顺序反了就会被当成「改选区范围」，播放头一动不动。
   */
  if ((ev.ctrlKey || ev.metaKey) && ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    ev.preventDefault();
    const dir = ev.key === 'ArrowLeft' ? -1 : 1;
    const step = ev.shiftKey ? frameStepMs() : coarseStepMs();
    const next = Math.max(0, Number(audio.currentMs || 0) + dir * step);
    seekWithScrub(next, true);
    return;
  }

  // Alt + 方向键：一步一格地改范围。
  // preventDefault 要在「有没有选区」之前 —— 否则没有选区时按键会落到浏览器，
  // 触发后退导航（Electron 里表现为整页回退，输入全丢）。
  if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
    ev.preventDefault();
    if (selection.value) {
      /**
       * 不按 Shift：只动**右端**（← 从右边收、→ 向右扩）。
       * 按住 Shift：只动**左端**（← 向左扩、→ 从左边收）。
       * 用户要的「缩小」= 右边界往左收，所以 Alt+← 落在 `right, -1` 上。
       *
       * 单选**一个块**时这是改块的真实时值（写库）；多格选区 / 空格子没有可改的事件，
       * 退成「只改选区跨度」—— 否则 Alt 在选区上完全没反应，看着像键坏了。
       */
      const side = ev.shiftKey ? ('left' as const) : ('right' as const);
      const dir = ev.key === 'ArrowLeft' ? (-1 as const) : (1 as const);
      const s = selection.value;
      const exact = selEvents.value.filter((e: any) => e.tick === s.startTick && e.tick + e.durTicks === s.endTick);
      if (exact.length === 1) void nudgeSpan(side, dir);
      else resizeSelection(side, dir);
    }
    return;
  }

  /**
   * 方向键 = **光标**（v0.89）。
   *
   * 以前 ←/→ 是「跳到同泳道的上一块 / 下一块」，一按就飞过整片空格，
   * 想停在某个空格上做不到（而且空泳道会变成死路）。现在分四层：
   *
   *   ←/→              移动一格（宽度保持）；光标态落到块上吸附整块
   *   Ctrl+←/→         跳到当前泳道的上一块 / 下一块（跳过空格，**不跨泳道**）
   *   Ctrl+Shift+←/→   把选区扩到上一块 / 下一块的边界
   *   Shift+←/→        扩 / 缩一格
   *   ↑/↓              换泳道（tick 范围不变，落到块上吸附）
   *
   * 位置一律走 `cellAtTick`，**不加常数** —— 变拍号时加减常数会错格。
   */
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    const back = ev.key === 'ArrowLeft' || ev.key === 'ArrowUp';
    const dir: -1 | 1 = back ? -1 : 1;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') moveLane(dir);
    else if (ev.ctrlKey || ev.metaKey) {
      if (ev.shiftKey) extendToBlock(dir);
      else jumpBlock(dir);
    } else if (ev.shiftKey) extendByCell(dir);
    else moveCursor(dir);
    return;
  }

  if (!selection.value) return;

  if (ev.key === 'Delete') {
    ev.preventDefault();
    void deleteSelection();
  } else if (ev.key === 'Backspace') {
    // Backspace 是「退回去改上一步」，不是删除：退回一格并开输
    ev.preventDefault();
    goBack();
  } else if (ev.key === 'Escape') {
    clearSelection();
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    if (!editing.value) openEditor(textOfSelection());
  }
}

/**
 * 量视口尺寸。
 *
 * **必须量 `.scroll`（滚动容器）而不是外层 `.canvas-host`**：
 * clientWidth/clientHeight 天然不含滚动条，而外层不含滚动条的位置。
 * 以前用外层宽度算 `viewW`，于是画布比内容区宽 10px —— 正好压住竖滚动条
 * （`scrollbar-gutter: stable` 让它常驻），表现就是「滚动条看得见但拉不动」。
 */
function onResize() {
  const sc = scroller.value;
  if (sc) {
    hostH.value = sc.clientHeight;
    hostW.value = sc.clientWidth;
  } else if (host.value) {
    hostH.value = host.value.clientHeight;
    hostW.value = host.value.clientWidth;
  }
  scheduleDraw();
}

/**
 * Ctrl/Cmd + 滚轮 = 只缩放网格的横向比例（不改整窗缩放）。
 * 关键是**锚定指针**：缩放后指针下面还是原来那一格，否则一滚就不知道跑哪去了。
 * 视口化之后缩放不再改变 canvas 尺寸，所以这里只需改 zoom + 记锚点，
 * 滚动位置在 draw 的 rAF 里统一应用（一次突发的多个滚轮事件只生效最后一帧）。
 */
function onWheel(ev: WheelEvent) {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  const box = scroller.value;
  const cv = canvas.value;
  if (!box || !cv) return;
  ev.preventDefault();
  ev.stopPropagation();

  const boxRect = box.getBoundingClientRect();
  const cvRect = cv.getBoundingClientRect();
  // 视口内坐标 → 文档坐标（用连续 tick，反复缩放才不会被一格一格地吸偏）
  const anchorTick = Math.max(0, tickAtXExact(viewLeft.value + (ev.clientX - cvRect.left)));

  const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  const next = Math.min(4, Math.max(0.5, Math.round(zoom.value * factor * 100) / 100));
  if (next === zoom.value) return;

  zoom.value = next;
  pendingAnchor = { tick: anchorTick, relX: ev.clientX - boxRect.left };
  scheduleDraw();
}

let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;
let offFrame: null | (() => void) = null;

/** 观察「会改变视口尺寸」的元素：外层（面板伸缩）+ 滚动容器（滚动条出现/消失） */
function bindResizeObserver() {
  if (!ro) return;
  ro.disconnect();
  if (host.value) ro.observe(host.value);
  // 滚动容器的 clientWidth 会随滚动条出现/消失变化 —— 不盯它，viewW 就是旧值，
  // 画布会一直比内容区宽 10px 并压住竖滚动条（「看得见但拉不动」）
  if (scroller.value) ro.observe(scroller.value);
  onResize();
}

onMounted(() => {
  onResize();
  ro = new ResizeObserver(onResize);
  if (host.value) ro.observe(host.value);
  if (scroller.value) ro.observe(scroller.value);
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerdown', onDocPointerDown);
  // 首选项里的「自动选中 / 数字低音写法」改了要立刻生效（同窗口自定义事件，不走 storage）
  window.addEventListener('ma:prefs', onPrefsEvent);
  // 必须 passive:false —— 否则 preventDefault 无效，会连带触发整窗缩放
  host.value?.addEventListener('wheel', onWheel, { passive: false });

  // 主题/字体是在 <html data-theme> 上切的，canvas 不会自己知道；
  // 不监听就只能等下一次交互才变色（这就是「切主题延迟生效」的根因）
  mo = new MutationObserver(() => {
    colorCache = null; // 主题色变了，缓存作废
    themeVer++;
    waveDirty = true;
    scheduleDraw();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-font'] });

  // 播放头每帧直接改 DOM + 波形带位图 blit：走 Vue 响应式的话，60fps 会让整个网格重算一遍
  offFrame = onFrame((ms) => {
    // 记住当帧时间：draw() 只摆位置时用它，别回退到 70ms 才更新一次的 currentMs
    lastFrameMs = ms;
    updatePlayhead(ms);
  });
  // 补全词表：读不到就只是没有候选，绝不能影响网格本身
  void loadChordTable();
  draw();
  updatePlayhead();
  // 动态操作帮助窗口：开窗时它自己也会拉一次状态，这里补一次「当前」摘要
  pushHelpSummary();
  // 撤销/重做按钮的可用状态：初始查一次，之后「自己动手后刷一次」+「别人动手靠广播」
  refreshHistCan();
  /**
   * 订阅历史广播（跨窗口用：主窗口改了一步，独立时间线窗口的按钮也要跟着亮）。
   * 退订句柄只交给 `onBeforeUnmount` —— 别在别处 `unsubHist?.()`（见它的声明处）。
   */
  unsubHist = (window as any).api?.history?.onChanged?.(onHistChanged) ?? null;

  // 调试/验收钩子：冒烟测试靠它驱动真实交互，而不是靠截图猜
  const safe = async (fn: () => Promise<any>) => {
    try {
      return JSON.stringify((await fn()) ?? null);
    } catch (e: any) {
      return JSON.stringify({ error: String(e?.message ?? e) });
    }
  };

  (window as any).__ma = {
    select(bar: number, cellFrom = 0, cellTo = cellFrom, laneIds?: string[]) {
      const g = gridOfBar(bar);
      const from = Math.max(0, Math.min(g.cells - 1, cellFrom));
      const to = Math.max(from, Math.min(g.cells - 1, cellTo));
      selection.value = {
        lanes: laneIds ?? [lanes.value[0]?.id].filter(Boolean),
        startTick: cellStart(g, from),
        endTick: Math.round(cellStart(g, to) + g.cellTicks),
      };
      // 脚本框选等于「人为介入」：给短冷却，否则播放中下一帧就被自动选中顶掉
      followOwned.value = false;
      scheduleDraw();
      // 必须返回纯对象：Vue 的 reactive proxy 过不了 IPC 的结构化克隆
      return JSON.parse(JSON.stringify(selection.value));
    },
    // contextBridge 回来的对象是代理，直接返回会在 IPC 克隆时炸掉；
    // 所有写操作统一返回 JSON 字符串，冒烟脚本自己解析。
    fill: (t: string) => safe(() => fill(t)),
    del: () => safe(() => deleteSelection()),
    deleteIds: (ids: string[]) => safe(() => deleteIds(ids)),
    undo: () => safe(() => undo()),
    redo: () => safe(() => redo()),
    undoGlobal: () => safe(() => undoGlobal()),
    redoGlobal: () => safe(() => redoGlobal()),
    /** 当前曲目的历史可用性（冒烟验按钮状态） */
    histCan: () => ({ ...histCan.value }),
    histProbe: () => ({
      api: typeof (window as any).api?.history,
      onChanged: typeof (window as any).api?.history?.onChanged,
      onApplied: typeof (window as any).api?.history?.onApplied,
      sub: !!unsubHist,
      calls: histCalls,
      aid: props.analysis?.id ?? null,
      can: { ...histCan.value },
      last: histLast
        ? {
            n: histLast.items?.length ?? -1,
            keys: Object.keys(histLast.cursors ?? {}),
            g: histLast.globalCursor,
            can: histLast.can,
          }
        : null,
    }),
    clear: clearSelection,
    unit: (u: string) => {
      setUnit(u as any);
      return div.value;
    },
    // 模拟「框 → 输入 → 回车」，冒烟用它验证顺延
    type: (t: string) =>
      safe(async () => {
        openEditor(t);
        await onEnterKey();
        return JSON.parse(JSON.stringify(selection.value));
      }),
    /** 只打开输入框、不提交：冒烟要用它验证「组合期的 Enter 不该提交」 */
    openEdit: (t: string) => {
      openEditor(t);
      return editing.value ? { ...editing.value } : null;
    },
    back: () => {
      goBack();
      return JSON.parse(JSON.stringify(selection.value));
    },
    editing: () => (editing.value ? editing.value.text : null),
    /**
     * 只打开输入框、**不提交**（`type` 会顺手回车落库，验「输入框开着时」的状态用它不合适）。
     * @param text 初始文本；不传就用当前选区的内容
     */
    openInput: (text?: string) => {
      openEditor(typeof text === 'string' ? text : textOfSelection());
      return editing.value ? editing.value.text : null;
    },
    zoom: () => zoom.value,
    /**
     * 重绘开销：reallocs 是「真的重分配了 canvas 缓冲区」的次数。
     * 视口化之后缩放/滚动完全不该让它涨 —— 涨了就说明又踩回缓冲区重建的坑。
     * hotBlits 是「已播放热层 blit」的次数，播放中它应该每帧涨。
     */
    perf: () => ({ ...perf }),
    /** 清掉「区间峰值」：量拖动滚动条那几帧最慢的一帧，别被启动时的长帧污染 */
    perfResetMax: () => {
      perf.winMaxMs = 0;
      return true;
    },
    /**
     * 画布尺寸自检：CSS 尺寸、位图尺寸、容器尺寸三者必须对得上。
     *
     * 任一项对不上就是「拉伸变形」：位图按新高度画、CSS 还留着旧高度，
     * 于是行高被抻长、刻度下移、底部被裁 —— 看着像渲染错乱，其实是尺寸没同步。
     */
    box: () => {
      const el = canvas.value;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        cssW: el.style.width,
        cssH: el.style.height,
        pxW: el.width,
        pxH: el.height,
        rectW: Math.round(r.width),
        rectH: Math.round(r.height),
        dpr: window.devicePixelRatio,
        hostW: hostW.value,
        hostH: hostH.value,
        viewW: viewW.value,
        viewH: viewH.value,
        laneW: LANE_W,
      };
    },
    /** 强制同尺寸重绘：用来验证「重绘不再重分配缓冲区」 */
    redraw: () => {
      draw();
      return { ...perf };
    },
    setZoom: (z: number) => {
      zoom.value = Math.min(4, Math.max(0.5, Number(z) || 1));
      scheduleDraw();
      return zoom.value;
    },
    /**
     * 视口左缘当前的「上下文」标记（段落 / 调性）。null = 这一段的起点还看得见。
     * 头带左缘那行灰字括号就是它的显示结果，用状态断言而不是去数像素。
     */
    stickyBand: (kind: string) => {
      const k: BandKind = kind === 'section' ? 'section' : 'key';
      const g = canvas.value?.getContext('2d');
      if (!g) return null;
      g.save();
      g.font = RULER_FONT;
      const plan = stickyChipPlan(k, viewLeft.value, (str) => g.measureText(str).width);
      g.restore();
      if (!plan || plan.skipped) {
        // skipped 时也把边界交出去：冒烟要能断言「没画，所以不会压住谁」
        return plan ? { skipped: true, tick: plan.marker.tick, text: plan.text, width: 0, vl: viewLeft.value, nextLabelX: plan.nextLabelX } : null;
      }
      return {
        skipped: false,
        tick: plan.marker.tick,
        text: plan.text,
        label: plan.label,
        width: Math.round(plan.width),
        vl: viewLeft.value,
        nextLabelX: plan.nextLabelX,
      };
    },
    /**
     * 滚动溢出的像素数。竖直方向为 0 才说明「内容没超容器」，
     * 也就是右边那条滚动条真的该消失了 —— 用数字断言，别靠看图。
     */
    overflow: () => {
      const box = scroller.value;
      if (!box) return null;
      return {
        v: box.scrollHeight - box.clientHeight,
        h: box.scrollWidth - box.clientWidth,
        rowH: LANE_ROW_MAX,
        /** 每条泳道实际用到的高度：等高是要求，冒烟要能逐行核对 */
        lanes: lanesGeom.value.map((g: any) => g.h),
        contentH: totalHeight.value,
        hostH: hostH.value,
      };
    },
    /**
     * 边缘命中探测：给冒烟用。返回 'left' / 'right' / null，
     * 让测试去验证「离边缘 7px 也算边缘」，而不是猜像素。
     */
    edgeAtTick: (tick: number, laneId: string) => {
      const li = lanes.value.findIndex((l: any) => l.id === laneId);
      if (li < 0) return null;
      const x = xOfTick(Number(tick));
      const hit = eventAt(x, li);
      return hit ? edgeAt(x, hit) : null;
    },
    /** Alt+方向键的等价入口（测试不用合成带 Alt 的方向键也能验逻辑） */
    nudge: (side: 'left' | 'right', dir: 1 | -1) => nudgeSpan(side, dir),
    /** 当前拖动态（edge / move / copy），测试用它确认手势进了哪个分支 */
    gesture: () => ({
      edge: edgeDrag ? { side: edgeDrag.side, from: edgeDrag.from, to: edgeDrag.to } : null,
      move: moveDrag ? { copy: moveDrag.copy, dTick: moveDrag.dTick, dLane: moveDrag.dLane } : null,
    }),
    cursor: () => canvas.value?.style.cursor ?? '',
    scrollLeft: () => scroller.value?.scrollLeft ?? 0,
    viewLeft: () => viewLeft.value,
    scrollTo: (x: number) => {
      setScrollLeft(Number(x) || 0);
      return viewLeft.value;
    },
    /** canvas 左缘相对滚动容器的偏移：sticky 钉住时恒为 LANE_W */
    pinnedDx: () => {
      const cv = canvas.value;
      const box = scroller.value;
      if (!cv || !box) return -1;
      return Math.round(cv.getBoundingClientRect().left - box.getBoundingClientRect().left);
    },
    /**
     * 播放头两侧波形带的颜色对比：已播放侧应是「加深」的热层色。
     * 采样多个点取平均，避开波峰间隙造成的误判。
     */
    bandDiff: () => {
      const el = canvas.value;
      if (!el || waveH.value <= 0) return null;
      const sx = playheadSx();
      if (sx < 48 || sx > viewW.value - 48) return { skip: true, sx: Math.round(sx) };
      /**
       * 只回读**一块**像素。以前每个采样点单独 `getImageData(…,1,1)`，一次 21×3×2 次；
       * 主画布在 GPU 上时每次回读都会同步整条管线，冒烟自己就成了掉帧源。
       * 这里最后一次读一块矩形，再在内存里取样。
       */
      const dpr = window.devicePixelRatio || 1;
      const rows = [0.28, 0.5, 0.72].map((f) => Math.floor(waveH.value * f * dpr));
      const xs: number[] = [];
      for (const base of [sx - 24, sx + 24]) {
        for (let dx = -10; dx <= 10; dx += 4) xs.push(Math.round((base + dx) * dpr));
      }
      const x0 = Math.max(0, Math.min(...xs));
      const x1 = Math.min(el.width - 1, Math.max(...xs));
      const y0 = Math.max(0, Math.min(...rows));
      const y1 = Math.min(el.height - 1, Math.max(...rows));
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      if (!probeCanvas) probeCanvas = document.createElement('canvas');
      if (probeCanvas.width !== w || probeCanvas.height !== h) {
        probeCanvas.width = w;
        probeCanvas.height = h;
      }
      const pctx = probeCanvas.getContext('2d', { willReadFrequently: true })!;
      pctx.clearRect(0, 0, w, h);
      pctx.drawImage(el, x0, y0, w, h, 0, 0, w, h);
      const img = pctx.getImageData(0, 0, w, h);
      const px = (x: number, y: number) => {
        const i = ((y - y0) * img.width + (x - x0)) * 4;
        return [img.data[i], img.data[i + 1], img.data[i + 2]];
      };
      const avg = (base: number) => {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dx = -10; dx <= 10; dx += 4) {
          const x = Math.min(el.width - 1, Math.max(0, Math.round((base + dx) * dpr)));
          for (const yy of rows) {
            const d = px(x, Math.min(el.height - 1, yy));
            r += d[0]; g += d[1]; b += d[2]; n++;
          }
        }
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      };
      const left = avg(sx - 24);
      const right = avg(sx + 24);
      const differ =
        Math.abs(left[0] - right[0]) > 15 ||
        Math.abs(left[1] - right[1]) > 15 ||
        Math.abs(left[2] - right[2]) > 15;
      return { left, right, differ, sx: Math.round(sx) };
    },
    xOfTick: (t: number) => xOfTick(t),
    /**
     * 文档画到哪一毫秒（最后一小节末）与总小节数。
     * 冒烟用它守「曲末画得下」：docEndMs < 音频时长 就说明最后几秒没有格子可画，
     * 波形会在半截处被切断、播放头也会跑出右边界。
     */
    docEndMs: () =>
      Math.round(
        audioMsOfTick(
          props.analysis,
          tempos.value,
          barToTick(meters.value, totalBars.value + 1, ppq.value)
        )
      ),
    docBars: () => totalBars.value,
    selection: () => JSON.parse(JSON.stringify(selection.value)),
    events: () => JSON.parse(JSON.stringify(props.analysis?.events ?? [])),
    /**
     * 当前网格显示的 analysis id。
     * 冒烟查库必须用它，而不是脚本开头记下的那个 —— 测试中途会切曲目（波形缓存那几段），
     * 拿旧 id 查 SQL 会一条都查不到，看起来像「什么都没写进去」。
     */
    analysisId: () => props.analysis?.id ?? null,
    /**
     * 按 tick 选中那一条事件（只认当前视图可见的泳道）。
     * 冒烟测方向键要「从某一块出发」：`select(bar,…)` 只能按小节对格，
     * 遇到 dur 不是整小节的块就会差一点；这里直接拿事件的真实区间。
     */
    selectEvent: (tick: number) => {
      const e = (viewEvents.value as any[]).find((x) => Number(x.tick) === Number(tick));
      if (!e) return null;
      selection.value = { lanes: [e.lane], startTick: e.tick, endTick: e.tick + e.durTicks };
      pickedIds.value = [];
      scheduleDraw();
      return JSON.parse(JSON.stringify(selection.value));
    },
    grid: () => ({ div: div.value, ppq: ppq.value, meters: meters.value, view: props.view?.id ?? null, lanes: lanes.value.map((l: any) => l.id) }),

    /* ---- 音频 / 播放头：冒烟靠它们核对「声音位置 ↔ 格子」对没对上 ---- */
    audioState: () =>
      safe(async () => ({
        ready: audio.ready,
        peaks: !!audio.peaks,
        peaksLevels: audio.peaks?.levels?.length ?? 0,
        durationMs: audio.durationMs,
        currentMs: Math.round(audio.currentMs),
        playing: audio.playing,
        name: audio.info?.name ?? null,
        sampleRate: audio.info?.sampleRate ?? 0,
        decoding: audio.decoding,
        error: audio.error || null,
        offset: props.analysis?.audioOffsetMs ?? null,
        /* ---- 编码器预热补偿（见 shared/audiofile.js 的 codecLeadSamples） ---- */
        leadSamples: audio.info?.leadSamples ?? 0,
        leadMs: debugClock().leadMs,
        elMs: debugClock().elMs,
        peaksMs: audio.peaks ? Math.round(audio.peaks.duration * 1000) : null,
      })),
    seekMs: (ms: number) => {
      seekAudio(ms);
      return Math.round(audio.currentMs);
    },
    seekTick: (tick: number) => seekToTick(tick),
    /**
     * 详情面板「时间轴 · 段落」双击：把播放头挪过去 + 横向翻页 + 选中起点那一格。
     *
     * `margin` 是落点左侧留白：96px 比 sticky 标签的最大宽（220）小，但足够露出
     * 「这一段自己的标签」和左边上一段的尾巴 —— 用户选的就是这个手感。
     * 而且因为 sticky 会按空隙避让（挤不下就不画），留白再小也不会压住段名。
     */
    focusTick: (tick: number, opts?: { margin?: number }) => {
      const t = Math.max(0, Math.round(Number(tick) || 0));
      const margin = Math.max(0, Math.round(Number(opts?.margin ?? 96)));
      seekToTick(t);
      setScrollLeft(Math.max(0, xOfTick(t) - margin));
      // 选中**整个和弦**（段落起点常常落在和弦中间，选一格会看着像「只选了一半」）
      editing.value = null;
      selectUnitAt(t);
      followOwned.value = false;
      scheduleDraw();
      return { tick: t, scrollLeft: scroller.value?.scrollLeft ?? 0 };
    },
    /** 网格现在挂的是哪首曲子：详情面板要拿它和自己那首对一下，别把 B 的时间跳到 A 上 */
    trackId: () => props.analysis?.trackId ?? null,
    /* ---- 多选 / 剪贴板 / 进行识别：冒烟用这些代替真实鼠标与快捷键 ---- */
    /**
     * 冒烟用：把选区落到**指定泳道的某个格子**上（空格子也行）。
     * 存在的理由只有一个 —— 「空泳道上按方向键要能走到别的泳道」这条，
     * 没有它就只能靠真鼠标去点一条空泳道的像素位置，等于在测试里赌坐标。
     */
    selectCellAt: (laneId: string, tick: number) => {
      if (!lanes.value.some((l: any) => l.id === laneId)) return null;
      const c = cellAtTick(meters.value, ppq.value, Math.max(0, Math.round(Number(tick) || 0)), div.value);
      const next = { lanes: [laneId], startTick: c.start, endTick: c.start + c.grid.cellTicks };
      // 走和键盘同一条路径（含 revealSelection）：否则「选中即跟随」这条在测试里验不到
      placeSelection(next);
      return next;
    },
    picks: () => pickedIds.value.slice(),
    /** 冒烟用：最近一帧的选区框。Ctrl+选两块不相邻的块必须是 2 个框、中间留缺口 */
    selBoxes: () => lastSelBoxes.map((b) => ({ x0: Math.round(b.x0), x1: Math.round(b.x1), y: Math.round(b.y) })),
    pickToggle: (id: string) => {
      pickedIds.value = pickedIds.value.includes(id)
        ? pickedIds.value.filter((x) => x !== id)
        : [...pickedIds.value, String(id)];
      return pickedIds.value.slice();
    },
    progression: () => (progression.value ? { id: progression.value.id, key: progression.value.key } : null),
    /**
     * 冒烟用：直接给一串和弦符号，按同一个映射算出进行。
     * 走的是 `parseChord → degreeOfChord → isDominantSeventh → matchProgression`，
     * 不碰库、也不依赖选区恰好等于事件区间。
     */
    progressionOf: (symbols: string[], key?: string) => {
      const keyName = key ?? keyNameAt(0);
      const items = (symbols ?? []).map((s) => {
        const p = parseChord(String(s ?? ''), { key: keyName });
        const d = degreeOfChord(p, keyName);
        return d ? { degree: d.degree, dominant7: isDominantSeventh(p) } : null;
      });
      if (!items.length || items.some((x) => !x)) return null;
      const hit = matchProgression(items as any[]);
      return hit ? { id: hit.id, key: hit.key } : null;
    },
    copySel: () => copySelection(),
    clipState: () => (clip.value ? { n: clip.value.items.length, baseTick: clip.value.baseTick } : null),
    paste: () => pasteClipboard(),
    pasteAskState: () => (pasteAsk.value ? { count: pasteAsk.value.count } : null),
    confirmPaste: () => confirmPaste(),
    prefFlags: () => ({
      scrubPick: scrubPick.value,
      selAnim: selAnim.value,
      pasteWarn: pasteWarn.value,
      scrubClearEmpty: scrubClearEmpty.value,
    }),
    selFade: () => Math.round(selFade * 100) / 100,
    /** 播放头现在画在哪一像素（文档坐标） */
    playheadPx: () => Math.round(xOfTick(Math.max(0, playheadTick()))),
    play: () => {
      playAudio();
      return true;
    },
    pause: () => {
      pauseAudio();
      return true;
    },
    headH: () => headH.value,
    waveH: () => waveH.value,
    yOfLane: (i: number) => {
      const list = lanesGeom.value;
      const g = list[Math.max(0, Math.min(list.length - 1, i))];
      return g ? Math.round(g.y + g.h / 2) : 0;
    },
    /** 第 i 条泳道在**左缘标签列**上的屏幕坐标（右键测试用：clientX 落在 64px 里） */
    laneClientXY: (i: number) => {
      const r = canvas.value!.getBoundingClientRect();
      const list = lanesGeom.value;
      const g = list[Math.max(0, Math.min(list.length - 1, i))];
      if (!g) return null;
      return { x: Math.round(r.left + 20), y: Math.round(r.top + g.y - viewTop.value + g.h / 2) };
    },
    /**
     * 第 i 条泳道在**左缘标签列**里的屏幕坐标（x 落在 0..64 那一格）。
     * 和 `laneClientXY` 不是一回事：那个给的是网格内容区（canvas 起点右边 20px），
     * 拿它去测「标签上右键」永远测不到真实的落点 —— 事件会打在 canvas 上，而真实鼠标打在 host 上。
     */
    laneLabelXY: (i: number) => {
      const box = host.value!.getBoundingClientRect();
      const list = lanesGeom.value;
      const g = list[Math.max(0, Math.min(list.length - 1, i))];
      if (!g) return null;
      return { x: Math.round(box.left + 20), y: Math.round(box.top + g.y - viewTop.value + g.h / 2) };
    },
    canvasBox: () => {
      const r = canvas.value!.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top) };
    },
    /**
     * 选区在**屏幕上**的矩形（文档坐标 → 屏幕：+canvas 左缘 − 滚动量）。
     * 冒烟量「输入框有没有把选区盖住」用它 —— 只比 DOM 之间的相对位置是不够的，
     * 选框和输入框都在同一层，必须换算到同一次坐标里。
     */
    selRect: () => {
      const s = selection.value;
      if (!s) return null;
      const geoms = lanesGeom.value.filter((g) => s.lanes.includes(g.lane.id));
      if (!geoms.length) return null;
      const r = canvas.value!.getBoundingClientRect();
      return {
        left: Math.round(r.left + xOfTick(s.startTick) - viewLeft.value),
        right: Math.round(r.left + xOfTick(s.endTick) - viewLeft.value),
        top: Math.round(r.top + Math.min(...geoms.map((g) => g.y)) - viewTop.value),
        bottom: Math.round(r.top + Math.max(...geoms.map((g) => g.y + g.h)) - viewTop.value),
      };
    },

    /* ---- 头带标记带：canvas 里没有可选择的 DOM，冒烟只能靠这些几何钩子点准 ---- */
    bandStrip: (kind: string) => {
      const k = kind === 'section' ? 'section' : 'key';
      const y0 = bandStripY(k);
      return { y0, y1: y0 + bandStripH(k), y: Math.round(y0 + bandStripH(k) / 2) };
    },
    keyStrip: () => ({ y0: keyY.value, y1: keyY.value + KEY_H, y: Math.round(keyY.value + KEY_H / 2) }),
    sectionStrip: () => ({
      y0: sectionY.value,
      y1: sectionY.value + SECTION_H,
      y: Math.round(sectionY.value + SECTION_H / 2),
    }),
    keyMarkers: () =>
      JSON.parse(
        JSON.stringify(
          keys.value.map((k: any) => ({ id: k.id, tick: k.tick, keyName: k.keyName, confidence: k.confidence, note: k.note }))
        )
      ),
    sectionMarkers: () =>
      JSON.parse(JSON.stringify(sectionMarkers.value.map((m: any) => ({ id: m.id, tick: m.tick, label: m.label })))),
    /** 某个 tick 在头带某条带上的屏幕坐标（clientX/clientY） */
    bandClientXY: (kind: string, tick: number) => {
      const cv = canvas.value;
      if (!cv) return null;
      const k = kind === 'section' ? 'section' : 'key';
      const r = cv.getBoundingClientRect();
      return {
        x: Math.round(r.left + xOfTick(Number(tick)) - viewLeft.value),
        y: Math.round(r.top + bandStripY(k) - viewTop.value + bandStripH(k) / 2),
      };
    },
    keyClientXY: (tick: number) => (window as any).__ma.bandClientXY('key', tick),
    sectionClientXY: (tick: number) => (window as any).__ma.bandClientXY('section', tick),
    bandEditState: () => {
      const e = bandEdit.value;
      if (!e) return null;
      return {
        ...JSON.parse(JSON.stringify(e)),
        sug: bandSug.value.items.map((i) => i.value),
        active: bandSug.value.active,
        open: bandSug.value.open,
      };
    },
    /** 旧名字保留：只报「调性」那一条编辑器，免得老断言含义变味 */
    keyEditState: () => (bandEdit.value?.kind === 'key' ? (window as any).__ma.bandEditState() : null),
    bandDragState: () =>
      bandDrag
        ? { kind: bandDrag.kind, tick: bandDrag.tick, preview: bandDrag.previewTick, moved: bandDrag.moved }
        : null,
    keyDragState: () =>
      bandDrag?.kind === 'key'
        ? { tick: bandDrag.tick, preview: bandDrag.previewTick, moved: bandDrag.moved }
        : null,
    /** 段落条右键菜单的开合与可选项 */
    bandMenuState: () => (bandMenu.value ? { ...bandMenu.value } : null),
    /** 最近一次动作（说明栏删掉后，冒烟不能再去读 `.legend` 的文本） */
    lastAction: () =>
      lastAction.value ? { key: lastAction.value.key, text: actionText(lastAction.value) } : null,
    /** 直接执行菜单项（冒烟不必依赖点击 DOM 菜单） */
    bandMenuRun: (act: 'split' | 'delete') => safe(() => runBandMenu(act)),

    /* ---- 低音填充：菜单开合 / 开关状态 / 库里的低音行 ---- */
    /** 低音行标签右键菜单的状态（没开就是 null） */
    bassMenuState: () => (bassMenu.value ? { ...bassMenu.value } : null),
    /**
     * 直接开低音菜单：等价于在「低音」行标签中点上右键。
     * 走的是真实入口 openBassMenuAt()，所以坐标命中逻辑也一起被验到。
     */
    bassMenuOpen: () => {
      const g = lanesGeom.value.find((it: any) => it.lane?.id === 'bass');
      const box = host.value?.getBoundingClientRect();
      if (!g || !box) return null;
      openBassMenuAt(
        {
          clientX: box.left + 8,
          clientY: box.top + (g.y - viewTop.value) + Math.round(g.h / 2),
          preventDefault() {},
          stopPropagation() {},
        } as any,
        g.y + Math.round(g.h / 2)
      );
      return bassMenu.value ? { ...bassMenu.value } : null;
    },
    /** 跑某个菜单项：fill = 整曲填充，auto = 切换「每次都自动」 */
    bassMenuRun: (act: 'fill' | 'auto') =>
      safe(() => (act === 'fill' ? fillBassFromDegrees() : Promise.resolve(toggleBassAutofill()))),
    bassAuto: () => bassAutofill.value,

    /* ---- 字母和弦填充：与低音同一套探针 ---- */
    chordMenuState: () => (chordMenu.value ? { ...chordMenu.value } : null),
    chordMenuOpen: () => {
      const g = lanesGeom.value.find((it: any) => it.lane?.id === 'chord');
      const box = host.value?.getBoundingClientRect();
      if (!g || !box) return null;
      openChordMenuAt(
        {
          clientX: box.left + 8,
          clientY: box.top + (g.y - viewTop.value) + Math.round(g.h / 2),
          preventDefault() {},
          stopPropagation() {},
        } as any,
        g.y + Math.round(g.h / 2)
      );
      return chordMenu.value ? { ...chordMenu.value } : null;
    },
    chordMenuRun: (act: 'fill' | 'auto') =>
      safe(() => (act === 'fill' ? fillChordsFromDegrees() : Promise.resolve(toggleChordAutofill()))),
    chordAuto: () => chordAutofill.value,
    chordBars: () =>
      (props.analysis?.events ?? [])
        .filter((e: any) => e.lane === 'chord')
        .map((e: any) => ({ tick: e.tick, text: e.text, dur: e.durTicks })),

    /* ---- 斯波索宾：与上面同一套探针 ---- */
    sposobinMenuState: () => (sposobinMenu.value ? { ...sposobinMenu.value } : null),
    sposobinMenuOpen: () => {
      const g = lanesGeom.value.find((it: any) => it.lane?.id === 'sposobin');
      const box = host.value?.getBoundingClientRect();
      if (!g || !box) return null;
      openSposobinMenuAt(
        {
          clientX: box.left + 8,
          clientY: box.top + (g.y - viewTop.value) + Math.round(g.h / 2),
          preventDefault() {},
          stopPropagation() {},
        } as any,
        g.y + Math.round(g.h / 2)
      );
      return sposobinMenu.value ? { ...sposobinMenu.value } : null;
    },
    sposobinMenuRun: (act: 'degree' | 'chord' | 'auto') =>
      safe(() =>
        act === 'auto' ? Promise.resolve(toggleSposobinAutofill()) : fillSposobin(act)
      ),
    sposobinAuto: () => sposobinAutofill.value,
    sposobinBars: () =>
      (props.analysis?.events ?? [])
        .filter((e: any) => e.lane === 'sposobin')
        .map((e: any) => ({ tick: e.tick, text: e.text, dur: e.durTicks })),
    /** 库里现有的低音行（冒烟断言用；父层刷新之前先看库） */
    bassBars: () =>
      (props.analysis?.events ?? [])
        .filter((e: any) => e.lane === 'bass')
        .map((e: any) => ({ tick: e.tick, text: e.text, dur: e.durTicks })),
    /** 头带两行标签的文字与几何：核对「标签和那条带对得上」 */
    bandLabelBox: () =>
      [...document.querySelectorAll('.lane-labels .band-label')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: el.textContent?.trim() ?? '',
          top: Math.round(r.top),
          height: Math.round(r.height),
          left: Math.round(r.left),
          right: Math.round(r.right),
        };
      }),
    alignPlayhead: () => safe(() => alignSelectionToPlayhead()),
    /* ---- 自动选中：canvas 里没有可选中的 DOM，冒烟只能通过这些钩子驱动 ---- */
    followSel: () => ({
      mode: followSel.value,
      owned: followOwned.value,
      highlight: highlightVisible.value,
    }),
    followSelectAt: (tick: number) =>
      safe(async () => {
        followSelectAt(Number(tick));
        return JSON.parse(JSON.stringify(selection.value));
      }),
    selState: () =>
      JSON.parse(
        JSON.stringify({
          selection: selection.value,
          parsed: selParsed.value,
          info: selInfo.value,
          /** 选区命中的可见事件数与「会被编辑的那条」文本：验证隐藏泳道不参与 */
          items: selEvents.value.length,
          exact: exactSelEvents.value.map((e: any) => ({ lane: e.lane, tick: e.tick, text: e.text })),
          editingText: textOfSelection(),
          follow: {
            mode: followSel.value,
            owned: followOwned.value,
            highlight: highlightVisible.value,
          },
          figureHint: figureHint.value,
        })
      ),
    /**
     * 「这段符号解析出来是什么、怎么念」—— 不看选区，也不碰 DOM。
     *
     * 冒烟里验描述文案用它：走选区读 `.selbar .parsed` 要等父组件重拉详情，
     * 而选区还得**恰好等于**那条事件的区间（多一格就取不到 parsed），
     * 一有异步就变成竞态。
     */
    describe: (text: string, key?: string) => {
      const p = parseChord(String(text ?? ''), { key: key ?? null });
      if (!p?.ok) return { ok: false, errors: p?.errors ?? [] };
      return { ok: true, text: describeWithNumeral(p, locale.value), degree: p.degree ?? null, alter: p.alter ?? null, neapolitan: !!p.neapolitan };
    },
    /* ---- 单元格输入补全：冒烟要能确认「哪个泳道给哪些候选」 ---- */
    cellSugState: () =>
      JSON.parse(
        JSON.stringify({
          open: cellSug.value.open,
          active: cellSug.value.active,
          items: cellSug.value.items,
          text: editing.value?.text ?? null,
        })
      ),
  };
});

onBeforeUnmount(() => {
  ro?.disconnect();
  mo?.disconnect();
  offFrame?.();
  unsubHist?.();
  unsubHist = null;
  host.value?.removeEventListener('wheel', onWheel);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('pointerdown', onDocPointerDown);
  window.removeEventListener('ma:prefs', onPrefsEvent);
  delete (window as any).__ma;
});

/**
 * 只监听「换了一份数据」，不做 deep。
 * deep 会递归遍历 analysis 里几百条事件去建依赖，滚动缩放时白白多跑一趟；
 * 而事件真正的改动都经过写库 → emit('changed') → refreshDetail，引用必换。
 */
watch([() => props.analysis, () => props.view, () => div.value], () => {
  waveDirty = true;
  scheduleDraw();
});
/**
 * canvas 被 `v-if` 重建时补一次绘制。
 *
 * 尺寸缓存已经按元素身份作废（见 syncCanvasSize），但「ref 从 null 变成新元素」
 * 不会触发 props 的 watcher；如果恰好在旧的 rAF 里 canvas 还是 null（draw 直接 return 了），
 * 新画布就再也没有人画。这里显式排一次。
 */
watch(canvas, (el) => {
  if (!el) return;
  waveDirty = true;
  scheduleDraw();
});
watch(zoom, () => {
  // 缩放后文档坐标全变：编辑框若开着，按选区重新定位
  if (editing.value && selection.value) {
    const p = positionOf(selection.value);
    if (p) editing.value = { ...editing.value, ...p };
  }
  scheduleDraw();
});

/**
 * 输入框开着时，选区一变就跟着挪（v0.54）。
 *
 * 触发者主要是「输入态里按 Alt+方向键改范围」：选区起点/长度变了，输入框却还钉在
 * `openEditor()` 那一刻的坐标上 —— 看起来像「改的是别的一块」。
 * 顺带覆盖 Enter 往下走一格（`advance()` 自己会重开编辑框，这里只是兜底）。
 * 只挪位置，**不动 `text`**：那是用户正在打的字。
 */
watch(selection, () => {
  if (editing.value && selection.value) {
    const p = positionOf(selection.value);
    if (p) editing.value = { ...editing.value, ...p };
  }
});


/* 画布里也有一句话（波形未就绪 / 音频与网格未重叠）。
   canvas 不会因为 Vue 重渲染而重绘，切语言得自己叫一次重绘。 */
watch(locale, () => scheduleDraw());

/**
 * 「现在选中什么」变了就推给动态操作帮助窗口。
 *
 * 监听的东西很少（选区 / 正在输入的文本 / 视图 / 曲名 / 最近动作）：
 * 事件数组本身变了不影响摘要 —— 摘要只描述**用户此刻指着的格子**。
 */
watch(
  [() => selection.value, () => editing.value?.text, () => props.view?.id, () => props.title, () => lastAction.value],
  () => pushHelpSummary()
);

/**
 * 选区变了就淡入一次。
 *
 * 放在 watch 里而不是每个点击分支各写一遍：单击 / Ctrl+点 / Shift+点 / 框选吸附 / 粘贴
 * 五条路径都会改 selection，漏一条就是「有的操作有动画、有的没有」。
 * `kickSelFade()` 内部会跳过「播放头跟随」引起的切换，所以播放时不会每帧闪。
 */
watch(
  () => [
    selection.value?.startTick ?? -1,
    selection.value?.endTick ?? -1,
    (selection.value?.lanes ?? []).join(','),
  ].join('|'),
  () => kickSelFade()
);

// 换曲：`.scroll`（在 v-if="analysis" 里面）会重新挂载，观察目标要跟着换
watch(
  () => props.analysis?.id,
  () => {
    void nextTick(bindResizeObserver);
  }
);

// 换曲目就把选区/撤销栈/视图位置清掉：撤销栈只对当前分析档案有效
watch(
  () => props.analysis?.id,
  () => {
    refreshHistCan();
    selection.value = null;
    editing.value = null;
    hover.value = null;
    lastAction.value = null;
    waveDirty = true;
    viewTop.value = 0;
    setScrollLeft(0);
    if (scroller.value) scroller.value.scrollTop = 0;
    scheduleDraw();
  }
);

/**
 * Home / |◀：播放头归零时，视图也回到开头。
 *
 * 播放头归零后如果视图还停在两分钟处，「回到开头」看着就像没反应 ——
 * 播放头确实回去了，只是不在视野里。这里和跟随共用同一套目标（播放头必须在视野内），
 * 但不看 follow 开关：按 Home 是明确要看开头，不该被一个显示偏好挡住。
 * 只按计数变化触发，不 watch currentMs（那个每帧都在动）。
 */
watch(
  () => audio.rewindSeq,
  () => {
    setScrollLeft(0);
    updatePlayhead();
  }
);

// 音频状态变化（波形解码完成 / 换曲 / 换设备）→ 波形层要重建，头一条高度也可能变。
// durationMs 也看：文档长度按音频时长撑开，时长到位就得重算可画范围。
watch(
  () => [audio.peaks, audio.ready, audio.info?.trackId, audio.durationMs],
  () => {
    peaksVer++;
    waveDirty = true;
    scheduleDraw();
    updatePlayhead();
  }
);

// 换曲：上一首的选区与冷却都不该带过来
watch(
  () => props.analysis?.id,
  () => {
    followOwned.value = false;
  }
);
</script>

<template>
  <div class="grid-wrap">
    <div class="toolbar">
      <span class="dim">{{ title }}</span>
      <span class="sep">/</span>
      <span class="dim">{{ view?.name ?? t('grid.noView') }}</span>

      <span class="grow" />

      <!-- 只有**出错**类提示还留在工具栏上（「已经有段落了」这种不看到就会以为没生效）。
           成功动作的反馈交给选区条和动态操作帮助窗口，不占这块地方。 -->
      <span v-if="actionError" class="act-err" :title="actionText(lastAction)">⚠ {{ actionError }}</span>

      <span class="faint">{{ t('grid.unit', { name: t(`grid.unit.${unit}`) }) }}</span>
      <div class="seg mini">
        <button :class="{ on: unit === 'bar' }" :title="t('grid.unit.barTitle')" @click="setUnit('bar')">{{ t('grid.unit.bar.btn') }}</button>
        <button :class="{ on: unit === 'beat' }" :title="t('grid.unit.beatTitle')" @click="setUnit('beat')">{{ t('grid.unit.beat.btn') }}</button>
        <button :class="{ on: unit === 'half' }" :title="t('grid.unit.halfTitle')" @click="setUnit('half')">{{ t('grid.unit.half.btn') }}</button>
      </div>

      <span class="faint">{{ t('grid.origin', { ms: analysis?.audioOffsetMs ?? 0 }) }}</span>
      <button
        v-if="parseWarnCount"
        class="chip warn-chip"
        :title="t('grid.parseWarn', { n: parseWarnCount })"
      >
        ⚠ {{ parseWarnCount }}
      </button>
      <button
        class="chip"
        :class="{ on: audio.follow }"
        :title="t('grid.followTitle')"
        @click="toggleFollow"
      >
        ⇥ {{ t('grid.follow') }}
      </button>
      <!-- 扫过发声：对轨时听一小口。完整设置（时长 / 范围 / 帧率口径）在选项 → 播放 -->
      <button
        class="chip"
        :class="{ on: stepPrefs.scrubOn }"
        :title="t('grid.scrubTitle')"
        @click="toggleScrubAudio"
      >
        ◉ {{ t('grid.scrub') }}
      </button>
      <button class="chip" @click="zoom = Math.max(0.5, zoom - 0.25)">−</button>
      <span class="num faint" style="width: 34px; text-align: center">{{ zoom.toFixed(2) }}×</span>
      <button class="chip" @click="zoom = Math.min(4, zoom + 0.25)">＋</button>
      <slot name="actions" />
    </div>

    <!-- 详情条**常驻**：以前 v-if="selection"，一旦框选/取消，下面整块画布会上下跳 26px，
         想点和弦或调性条时手一抖就点偏。没有选区时显示一句说明，高度不变。
         两条内容叠在同一个格子里（绝对定位 + opacity 过渡），切换时不会把右侧按钮挤来挤去。 -->
    <div class="selbar" :class="{ idle: !selection }">
      <span class="sel-dot" />
      <div class="info">
        <div class="info-line sel" :style="{ opacity: selection ? 1 : 0 }">
          <template v-if="selection">
            <b class="num">{{ selInfo?.meter }}</b>
            <span class="num">{{ selInfo?.text }}</span>
            <span class="faint">{{ tn('grid.cell', selInfo?.cells ?? 0) }} · {{ tn('grid.item', selEvents.length) }}</span>
            <span
              v-if="selParsed"
              class="parsed"
              :class="{ bad: !selParsed.ok }"
              :title="selParsed.errors?.length ? selParsed.errors.join(t('grid.errorSep')) : t('grid.parseTip')"
            >
              <!-- 𝄪/𝄫 在 11px 下只剩 3px 宽，单独放大一点点（别的字不动） -->
              <ChordText
                :text="selParsed.ok ? describeWithNumeral(selParsed, locale) : t('grid.unparsable', { why: selParsed.errors?.[0] ?? '' })"
              />
            </span>
            <!-- 苏俄数字低音（V56 / iii34 / V46 / V2）：解析照旧成功，只在规范写法上提一句 -->
            <span v-if="figureHint" class="figure-hint" :class="{ bad: figureStyle === 'strict' }" :title="figureHint">
              ⚠ {{ figureHint }}
            </span>
            <!-- 和弦进行识别：只看级数序列（转位/低音/大小写都不参与） -->
            <span v-if="progression" class="prog" :title="t('grid.prog.hint')">
              {{ t('grid.prog.label') }} · {{ t(progression.key) }}
            </span>
          </template>
        </div>
        <div class="info-line idle-line" :style="{ opacity: selection ? 0 : 1 }">
          {{ t('grid.selbar.idle') }}
        </div>
      </div>
      <!-- 这里只留撤销 / 重做：锚定、输入、删除、Esc 都已从这条详情栏拿掉。
           两个胶囊按文字自身宽度排（不要沿用「输入 ↵」那种更宽的基准）。 -->
      <button class="chip hist" :disabled="!histCan.undo" title="Ctrl+Z" @mousedown.prevent="undo()">{{ t('grid.undo') }}</button>
      <button class="chip hist" :disabled="!histCan.redo" title="Ctrl+Y" @mousedown.prevent="redo()">{{ t('grid.redo') }}</button>
    </div>

    <!-- canvas 只覆盖「头带 + 泳道」那一条（位图只有 1/8），拖动/松手必须能在整个面板里继续：
         指针滑进泳道下方空白或从右边缘滑出 canvas 时，事件目标是这块 host，
         由它转发给同一套手势处理（canvas 冒泡上来的跳过，避免一次移动算两遍）。
         canvas 自己不再绑 leave/cancel —— canvas 变矮之后「离开 canvas」不再等于「离开面板」。 -->
    <div
      ref="host"
      class="canvas-host"
      @pointermove="onHostPointer"
      @pointerup="onHostPointer"
      @pointercancel="onHostPointer"
      @pointerleave="onHostPointer"
      @contextmenu.prevent="onHostContextMenu"
    >
      <template v-if="analysis">
        <!-- 滚动容器：spacer 撑出全曲范围，canvas 用 sticky 钉在视口里。
             滚动条/触控板/惯性全是原生手感，但绘制量只跟视口大小有关。
             注意：sticky 的包含块是 spacer（全曲宽），所以钉住在整个滚动区间都有效；
             若把 sticky 元素直接放在 .scroll 下，滚过一个视口宽后就会被包含块裁走 -->
        <div ref="scroller" class="scroll" @scroll.passive="onScroll">
          <div class="spacer" :style="{ width: totalWidth + 'px', height: totalHeight + 'px' }">
            <div class="sticky-wrap">
              <canvas
                ref="canvas"
                @pointerdown="onPointerDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @contextmenu.prevent="onCanvasContextMenu"
              />
            </div>
          </div>
        </div>

        <!-- 播放头是 DOM 而不是画进 canvas：每帧只改一个 transform，不重绘网格 -->
        <div ref="playheadEl" class="playhead" />

        <input
          v-if="editing && editingView"
          class="cell-input"
          :style="editingView"
          v-model="editing.text"
          @input="onCellInput"
          @keydown.stop="onInputKey"
          @keydown.enter="onEnterKey"
          @keydown.esc="onEscEdit"
          @blur="onBlurEdit"
        />
        <!-- 输入补全：Teleport 到 body + position:fixed（坐标由 sugBox 现算）。
             留在这里的话，下面的详情条/播放条会把它盖掉、窗口边缘会把它切掉 ——
             候选框是浮层，不该被任何同级元素压住。 -->
        <Teleport to="body">
          <ul
            v-if="editing && cellSug.open && cellSugView"
            class="key-sug cell-sug"
            :style="cellSugView"
          >
            <li
              v-for="(c, i) in cellSug.items"
              :key="c.value"
              :class="{ on: i === cellSug.active }"
              @mousemove="cellSug.active = i"
              @mousedown.prevent="applyCellSug(c)"
            >
              <span>{{ c.label }}</span>
              <em :class="c.tone ? 'tone-' + c.tone : ''">{{ c.hint }}</em>
            </li>
          </ul>
        </Teleport>

        <!-- 段落条 / 调性条的就地编辑：canvas 里画不了 DOM，输入框与候选只能这样贴上去 -->
        <input
          v-if="analysis && bandEdit && bandEditView"
          ref="bandInputEl"
          class="key-input"
          :style="bandEditView"
          v-model="bandEdit.text"
          :placeholder="bandEdit.kind === 'section' ? t('grid.section.ph') : t('grid.key.placeholder')"
          :title="bandEdit.kind === 'section' ? t('grid.section.hint') : t('grid.key.hint')"
          @input="onBandInputChanged"
          @keydown.stop="onBandInputKey"
          @blur="onBandBlur"
        />
        <Teleport to="body">
          <ul v-if="bandEdit && bandEdit.kind === 'key' && bandSugView && bandSug.open" class="key-sug" :style="bandSugView">
            <li
              v-for="(c, i) in bandSug.items"
              :key="c.value"
              :class="{ on: i === bandSug.active }"
              @mousemove="bandSug.active = i"
              @mousedown.prevent="applyBandSug(c)"
            >
              <span>{{ c.label }}</span>
              <em>{{ c.value }}</em>
            </li>
          </ul>
        </Teleport>

        <!-- 段落条右键菜单：只有「在此处分段」和「删除本段」 -->
        <div
          v-if="bandMenu"
          class="band-menu"
          :style="{ left: bandMenu.x + 'px', top: bandMenu.y + 'px' }"
          @pointerdown.stop
        >
          <button :disabled="!bandMenu.canSplit" @click="runBandMenu('split')">
            {{ t('grid.ctx.splitSection') }}
          </button>
          <button :disabled="!bandMenu.has" @click="runBandMenu('delete')">
            {{ t('grid.ctx.deleteSection') }}
          </button>
        </div>

        <!-- 低音行标签的右键菜单：复用 band-menu 的样式（零新 CSS，少一次撞类名机会） -->
        <div
          v-if="bassMenu"
          class="band-menu"
          :style="{ left: bassMenu.x + 'px', top: bassMenu.y + 'px' }"
          @pointerdown.stop
        >
          <button @click="fillBassFromDegrees()">{{ t('grid.ctx.bassFill') }}</button>
          <!-- 勾选态用文本前缀表示：不新增 class，也不依赖 input 的原生样式 -->
          <button @click="toggleBassAutofill()">
            {{ bassAutofill ? '✓ ' : '　' }}{{ t('grid.ctx.bassAuto') }}
          </button>
        </div>

        <!-- 和弦行标签的右键菜单：从级数翻译出字母和弦（与低音填充同一套用法） -->
        <div
          v-if="chordMenu"
          class="band-menu"
          :style="{ left: chordMenu.x + 'px', top: chordMenu.y + 'px' }"
          @pointerdown.stop
        >
          <button @click="fillChordsFromDegrees()">{{ t('grid.ctx.chordFill') }}</button>
          <button @click="toggleChordAutofill()">
            {{ chordAutofill ? '✓ ' : '　' }}{{ t('grid.ctx.chordAuto') }}
          </button>
        </div>

        <!-- 斯波索宾行标签的右键菜单：两条来源分开（级数可靠 / 字母和弦要先反推级数） -->
        <div
          v-if="sposobinMenu"
          class="band-menu"
          :style="{ left: sposobinMenu.x + 'px', top: sposobinMenu.y + 'px' }"
          @pointerdown.stop
        >
          <button @click="fillSposobin('degree')">{{ t('grid.ctx.sposobinFill') }}</button>
          <button @click="fillSposobin('chord')">{{ t('grid.ctx.sposobinFillChord') }}</button>
          <button @click="toggleSposobinAutofill()">
            {{ sposobinAutofill ? '✓ ' : '　' }}{{ t('grid.ctx.sposobinAuto') }}
          </button>
        </div>

        <!-- 粘贴会覆盖内容时的确认框。默认弹，设置里可以关（关掉后直接覆盖） -->
        <div v-if="pasteAsk" class="modal-mask" @pointerdown.stop @click.self="pasteAsk = null">
          <div class="modal">
            <div class="modal-h">{{ t('grid.paste.title') }}</div>
            <p class="modal-b">{{ t('grid.paste.body', { n: pasteAsk.count }) }}</p>
            <label class="modal-mute">
              <input type="checkbox" :checked="!pasteWarn" @change="mutePasteWarn()" />
              {{ t('grid.paste.mute') }}
            </label>
            <div class="modal-actions">
              <button class="chip" @click="pasteAsk = null">{{ t('grid.paste.cancel') }}</button>
              <button class="chip on" @click="confirmPaste()">{{ t('grid.paste.ok') }}</button>
            </div>
          </div>
        </div>

        <div class="lane-labels">
          <!-- 头带两行的行名：和下面「级数 / 转位」同一列，用户才知道那两条带是什么 -->
          <div
            class="lane-label band-label"
            :style="{ top: sectionY - viewTop + 'px', height: SECTION_H + 'px' }"
          >
            {{ t('grid.band.section') }}
          </div>
          <div
            class="lane-label band-label"
            :style="{ top: keyY - viewTop + 'px', height: KEY_H + 'px' }"
          >
            {{ t('grid.band.key') }}
          </div>
          <div
            v-for="g in lanesGeom"
            :key="g.lane.id"
            class="lane-label"
            :style="{ top: g.y - viewTop + 'px', height: g.h + 'px' }"
          >
            {{ g.lane.label }}
          </div>
        </div>
      </template>

      <div v-else class="empty">
        <p class="dim">{{ t('grid.emptyTitle') }}</p>
        <p class="faint">{{ t('grid.emptyHint') }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }

.toolbar {
  display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 12px;
  border-bottom: 1px solid var(--line);
  font-size: 11.5px;
}
.sep { color: var(--text-faint); }
.grow { flex: 1; }
.seg.mini { display: flex; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
.seg.mini button { padding: 1px 6px; font-size: 10.5px; color: var(--text-dim); }
.seg.mini button.on { background: var(--sel-bg); color: var(--text); }

.selbar {
  display: flex; align-items: center; gap: 8px;
  height: 26px; min-height: 26px; padding: 0 12px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--sel-bg) 70%, var(--surface));
  font-size: 11px;
}
/* 没选区时高度不变（否则每次框选取消画布都会跳），但底色退回普通面板色 */
.selbar.idle { background: var(--surface); }
.selbar.idle .sel-dot { background: var(--line-strong); }
/* 两条内容叠在同一格里：切换只改 opacity，不重建 DOM、也不推挤右侧按钮 */
.selbar .info { position: relative; flex: 1; min-width: 0; height: 100%; }
.selbar .info-line {
  position: absolute; inset: 0;
  display: flex; align-items: center; gap: 8px;
  white-space: nowrap; overflow: hidden;
  transition: opacity 140ms ease;
}
.selbar .idle-line { color: var(--text-faint); pointer-events: none; }
/* 撤销 / 重做胶囊按**文字本身**定宽。
   以前这里对所有 chip 设 min-width:46px，是按「输入 ↵」那个更宽的文字基准，
   于是只有两个字的撤销/重做两边多出一截空白。 */
.selbar .chip.hist { padding: 0 8px; }
.figure-hint { font-size: 10.5px; color: var(--text-faint); white-space: nowrap; }
/* 和弦进行标签：绿色小胶囊，和解析结果并排 */
.prog {
  font-size: 10.5px; padding: 0 5px; border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent); white-space: nowrap;
}
/* 粘贴确认框：盖在网格面板上，不抢焦点（点遮罩 = 取消） */
.modal-mask {
  position: absolute; inset: 0; z-index: 20;
  background: rgba(0, 0, 0, 0.38);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: 300px; padding: 14px 16px;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 6px; box-shadow: var(--shadow);
}
.modal-h { font-size: 12.5px; margin-bottom: 6px; }
.modal-b { margin: 0 0 10px; font-size: 11.5px; color: var(--text-dim); line-height: 1.5; }
.modal-mute { display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--text-faint); margin-bottom: 12px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.figure-hint.bad { color: var(--warn); }
.sel-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--accent);
}
.chip.danger:not(:disabled) { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
.chip:disabled { opacity: 0.4; cursor: default; }

.canvas-host {
  flex: 1;
  min-height: 0;
  position: relative;
  user-select: none;
  /* canvas 只覆盖头带 + 泳道，下方空白靠这块底色（以前是 canvas 自己铺满视口画的） */
  background: var(--surface);
}

.lane-labels {
  position: absolute; left: 0; top: 0; bottom: 0; width: 64px;
  pointer-events: none; z-index: 3;
  /* 头带滚出视口时（viewTop > headH）标签会跑到负坐标，不裁的话会盖到工具栏上 */
  overflow: hidden;
}
/* 头带两行的行名：高度就是那两条带的实际高度，文字垂直居中 */
.lane-label.band-label {
  align-items: center;
  padding: 0 8px;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}
.lane-label {
  position: absolute; left: 0; right: 0;
  display: flex; align-items: flex-start;
  padding: 6px 0 0 8px;
  font-size: 10.5px; color: var(--text-faint);
  border-bottom: 1px solid var(--line);
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg) 92%, transparent);
}

/* 滚动容器：原生滚动条保留；canvas 不随内容滚动，由 sticky 钉在泳道标签右边 */
/*
 * scrollbar-gutter: stable —— 滚动条槽位**常驻**。
 * 不加的话，独立窗口里内容宽度刚好卡在临界值时会出现经典抖动：
 * 横条出现 → 占掉高度 → 竖条消失 → 宽度回来 → 横条又消失……
 * 用户看到的就是「滚动条一直在出现又消失，交替闪烁」。
 */
.scroll {
  height: 100%;
  overflow: auto;
  padding-left: 64px;
  scrollbar-gutter: stable;
  /* 拖滚动条时不要做滚动锚定：内容高度没变，锚定只会在每帧多算一次布局 */
  overflow-anchor: none;
}
.spacer { position: relative; pointer-events: none; }
.sticky-wrap {
  position: sticky;
  /* left 相对的是 .scroll 的内容盒（padding-left:64 已经把内容盒推到 64），
     再写 64 会变成 64+64=128 的双份偏移 */
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 1;
  pointer-events: none;
}
.sticky-wrap canvas { pointer-events: auto; }
canvas { display: block; cursor: crosshair; touch-action: none; }

/* 播放头：DOM + transform，60fps 更新也不重绘网格 */
.playhead {
  position: absolute;
  top: 0; bottom: 0; left: 64px;
  width: 1px;
  background: var(--accent);
  box-shadow: 0 0 6px color-mix(in srgb, var(--accent) 55%, transparent);
  pointer-events: none;
  z-index: 4;
  opacity: 0;
  will-change: transform;
}
.playhead::before {
  content: '';
  position: absolute;
  top: 0; left: -4px;
  border: 5px solid transparent;
  border-top-color: var(--accent);
}

.parsed {
  padding: 0 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--text-dim);
  max-width: 320px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.parsed.bad {
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--warn);
}
.chip.on { border-color: var(--accent); color: var(--text); background: var(--sel-bg); }
.chip.warn-chip { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--line)); }

.cell-input {
  position: absolute; z-index: 5; height: 18px;
  /* 跟画布上的和弦文字同一个字号，否则一进输入态字就跳一下 */
  font-size: 12.5px; padding: 0 4px;
  border: 1px solid var(--accent); border-radius: 2px;
  background: var(--surface);
}

/* 调性条输入：比和弦字小一号，跟条里的小字同尺度；配色一律走 token，浅色主题才不会糊 */
.key-input {
  position: absolute; z-index: 6; height: 16px;
  font-size: 11px; padding: 0 4px;
  border: 1px solid var(--accent); border-radius: 2px;
  background: var(--surface); color: var(--text);
}
/* 补全候选：**fixed + Teleport 到 body**（坐标由 sugBox 现算）。
   z-index 要高于详情条/播放条/弹窗（40~50），否则会被后置同级元素盖住；
   但仍低于「为作者提供支持」那种 80 的全屏遮罩。 */
.key-sug {
  position: fixed; z-index: 60;
  margin: 0; padding: 3px; list-style: none;
  max-height: 264px; overflow: auto;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 4px; box-shadow: var(--shadow);
}
.key-sug li {
  display: flex; justify-content: space-between; gap: 10px;
  padding: 3px 6px; border-radius: 3px; cursor: pointer; font-size: 11.5px;
}
/* 所有补全的斑马纹在 tokens.css 统一（.key-sug / .sug / .field-sug）。
   这里只保留选中行：局部背景与全局规则同色，避免 Vue scoped 覆盖后闪一下。 */
.key-sug li.on { background: var(--sel-bg); }
.key-sug em { color: var(--text-faint); font-style: normal; font-size: 10px; }
/* 和弦补全：宽度由 sugBox(..., 320, 460) 给足，整行不换行；
   真遇到超长说明就省略，宁可截断也不折成两行（折了就会有的高有的矮）。 */
.cell-sug li { white-space: nowrap; }
/* 说明的两种语气色（只改字色，不加框）：警告橙黄 / 提示品牌绿，都取现有变量 */
.key-sug li em.tone-warn { color: var(--warn); }
.key-sug li em.tone-ok { color: var(--accent); }
.cell-sug span, .cell-sug em { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* 段落条右键菜单 */
.band-menu {
  position: absolute; z-index: 8;
  display: flex; flex-direction: column; min-width: 132px;
  padding: 3px;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 4px; box-shadow: var(--shadow);
}
.band-menu button {
  text-align: left; padding: 4px 8px; border-radius: 3px;
  font-size: 11.5px; color: var(--text);
  /* 文案里用空格分了段（「从 级数标记 获取 低音填充」）：不许折行，让它横向长 */
  white-space: nowrap;
}
.band-menu button:hover:not(:disabled) { background: var(--sel-bg); }
.band-menu button:disabled { color: var(--text-faint); cursor: default; }

.empty { padding: 40px; text-align: center; }
.empty p { margin: 4px 0; font-size: 11.5px; }

.act-err { color: var(--warn); font-size: 10.5px; white-space: nowrap; }
</style>
