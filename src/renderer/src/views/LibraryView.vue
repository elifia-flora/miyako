<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { formatMsShort } from '@shared/barbeat.js';
import { periodLabel } from '@shared/search.js';
import { applyMovementTerm, movementFragment, movementMatchToken } from '@shared/movement.js';
import { templateSegments } from '@shared/titleTemplate.js';
import { applyVariable, suggestVariables } from '@shared/templateSuggest.js';
import { displayTitleOf, movementOrdinalOf } from '../titleTemplate';
import { matchPresets, type TitlePreset } from '../titlePresets';
import { genreLabel } from '../vocabLabels';
import { loadMovementLabels, movementTerms } from '../movementLabels';
import { locale, t } from '../i18n';
import { isComposing } from '../ime';
import { pickTitleTranslation } from '@shared/lang.js';


const props = defineProps<{
  rows: any[];
  selectedId: string | null;
  loading: boolean;
  /** 哪一行的曲名正在行内编辑（登记作品后自动进这态，右键曲名也能进） */
  editingId?: string | null;
  /** 进入改名态时全选（普通改名）还是把光标放到末尾（新乐章要接着补术语） */
  editCaretEnd?: boolean;
  /** 新乐章的默认前缀：补全只看它后面那一段，不用整串标题去匹配 */
  editPrefix?: string | null;
  /**
   * 当前「在看 / 在听」的录音版本 id。
   *
   * 和 `isDefault` 是两件事：isDefault 是「点作品播放先播哪一版」（顺序推导出来的），
   * 这个是「现在波形上画的是哪一版」。单击子行只改后者，不动顺序。
   */
  activeRecId?: string | null;
}>();
const emit = defineEmits<{
  select: [id: string];
  play: [row: any];
  /** 双击某个录音版本：只听这一版 */
  'play-version': [payload: { row: any; rec: any }];
  /** 单击某个录音版本：把它设成当前版本，波形与播放条的原点都跟着它 */
  'select-version': [payload: { row: any; rec: any }];
  rename: [payload: { id: string; title: string }];
  'cancel-rename': [];
  /** 右键曲名：带上行数据和鼠标坐标，菜单由 App 那边统一摆（它才知道播放列表有哪些） */
  'context-track': [payload: { row: any; x: number; y: number }];
  /** 右键录音版本子行：元数据属于文件，所以要带上具体是哪一条 */
  'context-version': [payload: { row: any; rec: any; x: number; y: number }];
}>();

/**
 * 扁平化成「曲目行 + 版本子行」。
 *
 * 挂了录音就铺子行（哪怕只有一条）——列表形态统一，一眼能看出「这首有音源」。
 * 收起状态按曲目记在 localStorage：用户收起过就一直是收起的，
 * 搜索、切换、重启都不该把它撑开。
 */
type DisplayRow =
  | { kind: 'track'; row: any }
  | { kind: 'movement'; row: any; mov: any; last: boolean }
  | { kind: 'rec'; row: any; rec: any; last: boolean };

const STORE_KEY = 'ma-tree-collapsed';

/** 读坏掉就当没收起过：这是个锦上添花的状态，不能因为它让列表崩掉 */
function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
const collapsed = ref<Set<string>>(readCollapsed());

function hasKids(row: any): boolean {
  return (row.recordingVersions?.length ?? 0) >= 1 || (row.movements?.length ?? 0) >= 1;
}

/** 改名要在「顶层作品 + 嵌套乐章」里都找得到行（登记乐章后直接进输入态） */
function findRow(id: string): any | null {
  for (const r of props.rows) {
    if (r.id === id) return r;
    const m = (Array.isArray(r.movements) ? r.movements : []).find((x: any) => x.id === id);
    if (m) return m;
  }
  return null;
}

/**
 * 乐章标题补全：**两张表合并** —— 速度 / 表情（tempo_marking.json）+ 体裁树
 * （composition_type.json）。专业上没有「乐章术语」这个类目，主进程合并后一次下发。
 *
 * 只在编辑「乐章子行」时启用：普通曲名没有「序数前缀 + 演奏标记」这套格式，
 * 硬塞一个术语下拉只会挡路。候选按「前缀之后 / 最后一个 ` - ` 之后」那一段匹配，
 * 中英文界面各自补 display / name（见 applyMovementTerm）。
 */
// 术语缓存放在 movementLabels.ts：详情、标题模板、这里的补全共用一份
void loadMovementLabels();
const sugOpen = ref(false);
/** -1 = 只展示候选、没有高亮；按 ↑↓ 才真正选中。这样「打完术语直接回车提交」不会被补全抢走 */
const sugIdx = ref(-1);
/** 下拉是 Teleport 到 body 的 fixed 层：位置按输入框的屏幕矩形现算 */
const sugPos = ref({ left: 0, top: 0, width: 280 });

const editingRow = computed(() => (props.editingId ? findRow(props.editingId) : null));
const isMovementEdit = computed(() => !!editingRow.value?.parentId);
const editPrefix = computed(() => String(props.editPrefix ?? ''));

/** 列表显示的是**展开后的标题**；编辑框里拿到的仍是 JSON 里的模板原文 */
function rowTitle(row: any): string {
  return displayTitleOf(row, locale.value);
}
function movTitle(parent: any, mov: any): string {
  const list: any[] = Array.isArray(parent?.movements) ? parent.movements : [];
  const idx = list.findIndex((m) => m.id === mov?.id);
  return displayTitleOf(
    {
      ...mov,
      composer: mov.composer ?? parent?.composer,
      compositionType: mov.compositionType ?? parent?.compositionType,
    },
    locale.value,
    movementOrdinalOf(mov, idx >= 0 ? idx : 0)
  );
}

type Sug =
  | { kind: 'term'; term: any }
  | { kind: 'preset'; preset: TitlePreset }
  | { kind: 'var'; item: any };

function inputFragment(): string {
  return isMovementEdit.value
    ? movementFragment(draft.value, editPrefix.value).fragment
    : draft.value;
}

function normTerm(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .trim();
}

/** 按关键词给术语打分排序：完全相等 0 → 前缀 1 → 包含 2 */
function scoreTerms(query: string): any[] {
  const q = normTerm(query);
  if (!q) return [];
  const scored: { score: number; order: number; term: any }[] = [];
  movementTerms.forEach((term, order) => {
    const keys = [term.name, term.display, term.id, ...(term.aliases ?? [])].map(normTerm).filter(Boolean);
    let best = 99;
    for (const key of keys) {
      if (key === q) best = Math.min(best, 0);
      else if (key.startsWith(q)) best = Math.min(best, 1);
      else if (key.includes(q)) best = Math.min(best, 2);
    }
    if (best < 99) scored.push({ score: best, order, term });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((x) => x.term);
}

/** 光标处的模板变量候选（`c` / `%c` / `Cp` → `%Composer}`）；`n` 是还能放几条 */
function variableSugs(n: number): Sug[] {
  if (n <= 0) return [];
  return suggestVariables(draft.value, draftCaret.value, n).map((item) => ({ kind: 'var' as const, item }));
}

/** 候选的稳定 key：三种来源各自的 id */
function sugKey(s: Sug): string {
  if (s.kind === 'preset') return `p:${s.preset.id}`;
  if (s.kind === 'var') return `v:${s.item.key}`;
  return `t:${s.term.id}`;
}

const suggestions = computed<Sug[]>(() => {
  if (!editingRow.value) return [];
  const frag = normTerm(inputFragment());
  // 顺序 = 用户最可能要的那个：预设（整条标题）→ 乐章术语 → 模板变量。
  // 变量放最后：它在标题里是「偶尔插一个」，不该把术语候选顶下去。
  const out: Sug[] = [];
  if (frag) {
    out.push(
      ...matchPresets(frag, isMovementEdit.value ? 'movement' : 'title').map((preset) => ({
        kind: 'preset' as const,
        preset,
      }))
    );
  }
  if (!isMovementEdit.value) {
    out.push(...variableSugs(8 - out.length));
    return out.slice(0, 8);
  }

  const terms = movementTerms;
  if (!frag) {
    out.push(...(sugOpen.value ? terms.slice(0, 8).map((term) => ({ kind: 'term' as const, term })) : []));
    out.push(...variableSugs(8 - out.length));
    return out.slice(0, 8);
  }
  /*
   * 先按**整段**匹配（多词术语 `Allegro moderato` 靠它），
   * 一条都没有时退回「光标前那一小段」：`第二乐章 柔板Al` / `%Tempo Term}Al`
   * 这种拼接，整段永远匹配不上 —— 之前的表现就是「加了字反而不弹候选」。
   */
  let hits = scoreTerms(frag);
  if (!hits.length) {
    const token = movementMatchToken(frag);
    if (token && token !== frag) hits = scoreTerms(token);
  }
  out.push(...hits.map((term) => ({ kind: 'term' as const, term })));
  out.push(...variableSugs(8 - out.length));
  return out.slice(0, 8);
});

function closeSuggest() {
  sugOpen.value = false;
  sugIdx.value = -1;
}

/**
 * 按输入框的屏幕位置摆下拉：优先向下，下面装不下且上面更宽裕就翻上去。
 * 调层一律 fixed 到 body（RULES 第 19 条）：表格 `.tbody` 是滚动容器，
 * absolute 留在行里会被裁掉半截，后面的行还会盖住它。
 */
function placeSuggest() {
  const el = inputEl;
  if (!el) return;
  const r = el.getBoundingClientRect();
  // 曲目行的输入框几乎占满整列：宽度跟输入框，但封在 420 —— 预设模板再长也不用一条通栏
  const width = Math.min(Math.max(Math.min(r.width, 420), 280), window.innerWidth - 8);
  const left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4));
  const maxH = 228;
  const est = Math.min(maxH, Math.max(32, suggestions.value.length * 27 + 6));
  const below = window.innerHeight - r.bottom;
  const openUp = below < est + 8 && r.top > below;
  const top = openUp
    ? Math.max(4, r.top - est - 3)
    : Math.min(window.innerHeight - 40, r.bottom + 3);
  sugPos.value = { left, top, width };
}

function openSuggest() {
  if (!editingRow.value) return;
  placeSuggest();
  sugOpen.value = true;
  sugIdx.value = -1;
}

/** 滚动 / 改窗口大小就收起：下拉是 fixed 的，不跟着表格一起滚 */
function onViewportChange() {
  if (sugOpen.value) closeSuggest();
}

watch(sugOpen, (v) => {
  const fn = onViewportChange;
  if (v) {
    window.addEventListener('scroll', fn, true);
    window.addEventListener('resize', fn);
  } else {
    window.removeEventListener('scroll', fn, true);
    window.removeEventListener('resize', fn);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});

function moveSuggestion(dir: -1 | 1) {
  const n = suggestions.value.length;
  if (!n) return;
  if (sugIdx.value < 0) sugIdx.value = dir > 0 ? 0 : n - 1;
  else sugIdx.value = (sugIdx.value + dir + n) % n;
}

/**
 * 术语插进标题：英文补 name（总谱写法），中文补 display。
 *
 * 打字打到一半时只替换**光标前那一小段**（`柔板Al` → `柔板 - Allegretto`）；
 * 还没打（刚按 ↓ 打开候选）才走 `applyMovementTerm` 的整段规则 ——
 * 它负责「前缀后接空格」「已有术语后用 ` - ` 接上」这些排版。
 */
function pickTerm(term: any) {
  const text = locale.value === 'en' ? term.name : term.display || term.name;
  const token = movementMatchToken(inputFragment());
  const caret = draftCaret.value;
  const at = caret - token.length;
  if (token && at >= 0 && draft.value.slice(at, caret) === token) {
    // 紧贴在汉字/字母后面（`柔板Al`）时补一个 ` - `，别把两段术语黏成一个词
    const sep = at > 0 && /[\u3400-\u9fffA-Za-z]/.test(draft.value[at - 1]) ? ' - ' : '';
    draft.value = draft.value.slice(0, at) + sep + text + draft.value.slice(caret);
    draftCaret.value = at + sep.length + text.length;
  } else {
    draft.value = applyMovementTerm(draft.value, editPrefix.value, text);
    draftCaret.value = draft.value.length;
  }
  closeSuggest();
  void nextTick(() => {
    inputEl?.focus();
    inputEl?.setSelectionRange(draftCaret.value, draftCaret.value);
  });
}

/**
 * 预设 → 整条换掉。模板里自带 `%Movement Number}`，原来那个「第N乐章」前缀
 * 不该留在模板前面，否则展开时会变成「第三乐章 第三乐章 …」。
 */
function pickSuggestion(s: Sug) {
  if (s.kind === 'preset') {
    draft.value = s.preset.template;
    closeSuggest();
    void nextTick(() => {
      inputEl?.focus();
      const n = draft.value.length;
      inputEl?.setSelectionRange(n, n);
    });
    return;
  }
  if (s.kind === 'var') {
    // 变量是**插进光标处**，不是整条替换：标题里可能已经有别的东西
    const next = applyVariable(draft.value, s.item);
    draft.value = next.text;
    draftCaret.value = next.caret;
    closeSuggest();
    void nextTick(() => {
      inputEl?.focus();
      inputEl?.setSelectionRange(next.caret, next.caret);
    });
    return;
  }
  pickTerm(s.term);
}

function kindLabel(kind: string): string {
  const key = `movement.kind.${kind}`;
  const v = t(key);
  return v === key ? kind : v;
}

function onDraftInput(ev: Event) {
  const el = ev.target as HTMLInputElement | null;
  if (el) {
    draft.value = el.value;
    draftCaret.value = el.selectionStart ?? el.value.length;
  }
  if (isComposing(ev)) return;
  const frag = inputFragment().trim();
  if (!frag) {
    closeSuggest();
    return;
  }
  placeSuggest();
  sugOpen.value = true;
  // 预设会整条替换标题，和「打错一个字就换掉整首」只差一次回车；
  // 所以不默认高亮第一条 —— 要按 ↓ 选中（或鼠标点）才交给补全。
  sugIdx.value = -1;
}

/** 点/按键挪了光标：变量补全按新位置重算（Esc 收起后不会再自己弹回来） */
function onDraftCaret(ev: Event) {
  const el = ev.target as HTMLInputElement | null;
  if (el) draftCaret.value = el.selectionStart ?? el.value.length;
}

/**
 * 外文曲名旁边那句**灰色括号译名**。
 *
 * 只在「档案写了原语言、且它跟界面语言不同」时出现；译名从 `aliases` 里按字符集挑
 * （判据与取舍见 `shared/lang.js` 的 `pickTitleTranslation`）。
 * 挑不到就返回 null —— 空着比猜错好，用户会以为那是官方译名。
 */
function titleTr(row: any): string | null {
  return pickTitleTranslation(
    { original: rowTitle(row), lang: row.titleLang, aliases: row.aliases },
    locale.value
  );
}
function isCollapsed(id: string): boolean {
  return collapsed.value.has(id);
}
function toggleCollapsed(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...next]));
  } catch {
    /* 存不进去就只是这次会话不记忆，不影响列表 */
  }
}

const displayRows = computed<DisplayRow[]>(() => {
  const out: DisplayRow[] = [];
  for (const r of props.rows) {
    out.push({ kind: 'track', row: r });
    if (collapsed.value.has(r.id)) continue;
    const movs: any[] = Array.isArray(r.movements) ? r.movements : [];
    const vers: any[] = Array.isArray(r.recordingVersions) ? r.recordingVersions : [];
    movs.forEach((mov, i) =>
      out.push({ kind: 'movement', row: r, mov, last: i === movs.length - 1 && vers.length === 0 })
    );
    vers.forEach((rec, i) => out.push({ kind: 'rec', row: r, rec, last: i === vers.length - 1 }));
  }
  return out;
});

function keyLabel(k: string) {
  return k?.replace(/\s+/g, ' ');
}

/** 这一行的「双击会发生什么」，鼠标悬停就能看见，不用先猜 */
function playHint(r: any) {
  if (r.hasAudio) return t('table.hint.play');
  if (r.neteaseUrl || r.recordingVersions?.[0]?.link) return t('table.hint.cloud');
  return t('table.hint.none');
}

/* ---- 录音版本子行 ---- */

/** 版本名：厂牌 + 编号 → 指挥 → 文件名 */
function recName(r: any): string {
  if (r.label && r.catalogNo) return `${r.label} · ${r.catalogNo}`;
  if (r.label) return r.label;
  if (r.conductor) return r.conductor;
  if (r.filePath) return String(r.filePath).split(/[\\/]/).pop() || '';
  return t('rec.title');
}

/** 子行里只放「换个版本要看的差别」：谁演的、哪年、多长 */
function recMeta(r: any): string {
  const bits: string[] = [];
  const perf = (Array.isArray(r.performers) ? r.performers : []).join(' / ') || r.conductor || '';
  if (perf) bits.push(perf);
  const year = r.releaseYear ?? r.recordedYear;
  if (year) bits.push(String(year));
  if (r.filePath && r.durationMs) bits.push(formatMsShort(r.durationMs));
  if (r.variantCount) bits.push(t('rec.qualityBadge', { n: r.variantCount }));
  return bits.join(' · ');
}

/** 来源：本地文件 / 外链 / 空 */
function recSource(r: any): 'local' | 'link' | 'none' {
  if (r.filePath) return 'local';
  if (r.link) return 'link';
  return 'none';
}
function recSourceText(r: any): string {
  const k = recSource(r);
  if (k === 'local') return t('rec.sourceLocal');
  if (k === 'link') return t('rec.sourceExternal');
  return t('rec.sourceNone');
}
function recHint(r: any): string {
  if (r.filePath) return t('table.recording.play');
  if (r.link) return t('table.recording.link');
  return t('table.recording.none');
}

/* ---- 曲名行内编辑 ---- */
const draft = ref('');
/** 输入框里的光标位置：变量补全要按光标前的那个词来匹配，而不是整条标题 */
const draftCaret = ref(0);
let inputEl: HTMLInputElement | null = null as HTMLInputElement | null;
/** Esc 取消后 blur 还会来一次，别让它把空输入又提交一遍 */
let cancelling = false;

watch(
  () => props.editingId,
  async (id) => {
    if (!id) return;
    cancelling = false;
    closeSuggest();
    draft.value = findRow(id)?.title ?? '';
    draftCaret.value = draft.value.length;
    await nextTick();
    inputEl?.focus();
    if (props.editCaretEnd) {
      // 新乐章：默认前缀保留，光标落在末尾 —— 用户直接打「行板」就是接着写
      const n = draft.value.length;
      inputEl?.setSelectionRange(n, n);
    } else {
      inputEl?.select();
    }
  },
  { immediate: true }
);

function commitRename() {
  const id = props.editingId;
  if (!id || cancelling) return;
  closeSuggest();
  const title = draft.value.trim();
  if (!title) return emit('cancel-rename');
  if (title === findRow(id)?.title) return emit('cancel-rename');
  emit('rename', { id, title });
}

/**
 * 右键曲名 = 打开这一行的菜单（改名只是其中一项）。
 *
 * 以前右键直接进改名：看着快，实际把「这首歌还能干什么」堵死了 —— 想放进播放列表、
 * 想删掉，都得先选中再从菜单栏里翻。现在统一出菜单，「更改标题」再落到原来那个输入框。
 *
 * 正在改名时不弹菜单：输入框自己的右键还有「复制 / 粘贴 / 全选」要用。
 */
function onTitleContext(ev: MouseEvent, row: any) {
  if (props.editingId === row.id) return;
  emit('context-track', { row, x: ev.clientX, y: ev.clientY });
}

function onEditKey(ev: KeyboardEvent) {
  // 中文输入法按 Enter 是「确认候选」，此刻 v-model 还没同步组合文本，
  // 放过去提交会把标题存成组合前的旧值（表现为「回车保存不上」）。
  const composing = isComposing(ev);

  // 术语补全的键盘操作：↑↓ 选、Enter / Tab 接受、Esc 只收下拉（不退出改名）
  if (sugOpen.value && suggestions.value.length) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      ev.stopPropagation();
      moveSuggestion(ev.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (!composing && (ev.key === 'Enter' || ev.key === 'Tab') && sugIdx.value >= 0) {
      ev.preventDefault();
      ev.stopPropagation();
      pickSuggestion(suggestions.value[sugIdx.value]);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeSuggest();
      return;
    }
  }
  if (ev.key === 'ArrowDown' && !sugOpen.value) {
    ev.preventDefault();
    ev.stopPropagation();
    openSuggest();
    return;
  }

  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (!composing) {
      const el = ev.target as HTMLInputElement | null;
      if (el) draft.value = el.value; // 双保险：以输入框真实值为准
      commitRename();
    }
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    cancelling = true;
    emit('cancel-rename');
  }
  ev.stopPropagation();
}
</script>

<template>
  <div class="wrap">
    <div class="thead">
      <span class="c-play"></span>
      <span class="c-title">{{ t('table.title') }}</span>
      <span class="c-meter">{{ t('table.meter') }}</span>
      <span class="c-bpm num">BPM</span>
      <span class="c-period">{{ t('table.period') }}</span>
      <span class="c-genre">{{ t('table.genre') }}</span>
      <span class="c-key">{{ t('table.key') }}</span>
    </div>

    <div class="tbody">
      <template v-for="d in displayRows" :key="d.kind === 'track' ? d.row.id : d.kind === 'movement' ? d.mov.id : d.rec.id">
        <!-- 曲目行 -->
        <div
          v-if="d.kind === 'track'"
          class="row"
          :class="{ on: d.row.id === selectedId, 'has-tree': hasKids(d.row) }"
          :data-track-id="d.row.id"
          @click="$emit('select', d.row.id)"
        >
        <span class="c-play" :title="playHint(d.row)">
          <span v-if="d.row.hasAudio" class="src file">♪</span>
          <span v-else-if="d.row.neteaseUrl || d.row.recordingVersions?.[0]?.link" class="src cloud">{{ t('table.source.cloud') }}</span>
          <span v-else class="faint">—</span>
        </span>
        <span
          class="c-title"
          :title="editingId === d.row.id ? t('table.rename.hint') : playHint(d.row)"
          @dblclick.stop="editingId === d.row.id ? undefined : emit('play', d.row)"
          @contextmenu.prevent="onTitleContext($event, d.row)"
        >
          <!-- 展开 / 收起箭头。没有子行的行留一个等宽空槽，
               否则有树的曲名会整体右移 20px，整列标题参差不齐。 -->
          <button
            v-if="hasKids(d.row)"
            class="tw"
            :class="{ collapsed: isCollapsed(d.row.id) }"
            :title="t(isCollapsed(d.row.id) ? 'table.tree.expand' : 'table.tree.collapse')"
            @click.stop="toggleCollapsed(d.row.id)"
          >
            <!--
              旧写法（实心三角）先留着，回滚时把这一行取消注释、删掉下面的 <svg> 即可：
              ▾
              换掉的原因：侧栏的折叠标记早就改成「两条边构成的直角」了，列表里还留着
              实心 ▾ 是两套语言。chevron 用同一份 path、同样 1.5 的 stroke，才像一个软件。
            -->
            <svg
              class="tw-chev"
              :class="{ open: !isCollapsed(d.row.id) }"
              viewBox="0 0 12 12"
              aria-hidden="true"
            >
              <path d="M4.5 2.5 L8 6 L4.5 9.5" />
            </svg>
          </button>
          <span v-else class="tw-ph" />
          <template v-if="editingId === d.row.id">
            <input
              :ref="(el) => { if (el) inputEl = el as HTMLInputElement; }"
              v-model="draft"
              class="title-edit"
              :placeholder="t('table.rename.placeholder')"
              @input="onDraftInput"
              @keydown="onEditKey"
              @click="onDraftCaret"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <span class="t">{{ rowTitle(d.row) }}</span>
            <!-- 译名：灰色、括号、不参与搜索高亮；太长时跟着整块省略号截断 -->
            <span v-if="titleTr(d.row)" class="t-tr">（{{ titleTr(d.row) }}）</span>
          </template>
        </span>
        <span class="c-meter num">{{ d.row.meter ?? '—' }}</span>
        <span class="c-bpm num">{{ d.row.bpm ?? '—' }}</span>
        <span class="c-period" :title="d.row.period ?? ''">{{ periodLabel(d.row.period, locale) }}</span>
        <span class="c-genre" :title="d.row.genre ?? ''">{{ genreLabel(d.row.genre, locale) }}</span>
        <span class="c-key">
          <template v-if="d.row.keys.length">
            {{ keyLabel(d.row.keys[d.row.keys.length - 1]) }}
            <span v-if="d.row.keys.length > 1" class="faint">+{{ d.row.keys.length - 1 }}</span>
          </template>
          <span v-else class="faint">—</span>
        </span>
        </div>

        <!-- 乐章子行：母作品下的子曲目，缩进 + 树线表示从属；单击选中、双击播放、右键出菜单 -->
        <div
          v-else-if="d.kind === 'movement'"
          class="row mov-row"
          :class="{ on: d.mov.id === selectedId, last: d.last }"
          :data-track-id="d.mov.id"
          @click="$emit('select', d.mov.id)"
        >
          <span class="c-play" :title="playHint(d.mov)">
            <span v-if="d.mov.hasAudio" class="src file">♪</span>
            <span v-else-if="d.mov.neteaseUrl" class="src cloud">{{ t('table.source.cloud') }}</span>
            <span v-else class="faint">—</span>
          </span>
          <span
            class="c-mov"
            :class="{ editing: editingId === d.mov.id }"
            :title="editingId === d.mov.id ? t('table.rename.hint') : playHint(d.mov)"
            @dblclick.stop="editingId === d.mov.id ? undefined : emit('play', d.mov)"
            @contextmenu.prevent="onTitleContext($event, d.mov)"
          >
            <template v-if="editingId === d.mov.id">
              <input
                :ref="(el) => { if (el) inputEl = el as HTMLInputElement; }"
                v-model="draft"
                class="title-edit"
                :placeholder="t('movement.placeholder')"
                @input="onDraftInput"
                @keydown="onEditKey"
                @click="onDraftCaret"
                @blur="commitRename"
              />
            </template>
            <template v-else>
              <span class="mov-title">{{ movTitle(d.row, d.mov) }}</span>
              <span class="mov-meta">
                <template v-if="d.mov.meter">{{ d.mov.meter }}</template>
                <template v-if="d.mov.keys.length"> · {{ keyLabel(d.mov.keys[d.mov.keys.length - 1]) }}</template>
              </span>
            </template>
          </span>
        </div>

        <!-- 录音版本子行：比曲目行缩进一格，靠树状连接线表示从属关系 -->
        <div
          v-else
          class="row rec-row"
          :class="{ on: d.row.id === selectedId && d.rec.id === activeRecId, last: d.last }"
          :data-rec-id="d.rec.id"
          :title="recHint(d.rec)"
          @click="emit('select-version', { row: d.row, rec: d.rec })"
          @dblclick.stop="emit('play-version', { row: d.row, rec: d.rec })"
          @contextmenu.prevent="emit('context-version', { row: d.row, rec: d.rec, x: $event.clientX, y: $event.clientY })"
        >
          <span class="c-play">
            <span v-if="d.rec.isDefault" class="src file">♪</span>
            <span v-else class="faint">·</span>
          </span>
          <span class="c-rec">
            <span class="rec-dot" :class="{ on: d.rec.isDefault }" />
            <span class="rec-title">{{ recName(d.rec) }}</span>
            <span class="rec-meta">{{ recMeta(d.rec) }}</span>
          </span>
          <span class="rec-src" :class="recSource(d.rec)">{{ recSourceText(d.rec) }}</span>
        </div>
      </template>

      <div v-if="!rows.length" class="empty">
        <p class="dim">{{ loading ? t('table.loading') : t('table.empty') }}</p>
        <p class="faint">{{ t('table.emptyHint') }}</p>
      </div>
    </div>

    <!--
      行内改名的候选列表：**全表只有这一份**，曲目行与乐章行共用。

      曾经把它写在乐章行的 `<template v-if>` 里，结果只有乐章能补全 ——
      曲目行（最常用的那条路径）敲预设名什么都不弹，用户 2026-11-23 报成「补全挂掉了」。
      位置走 Teleport 到 body + fixed：表格是滚动容器，留在行里会被裁切（RULES 第 19 条）；
      `@mousedown.prevent` 保住输入焦点，否则 blur 先把改名提交掉。
    -->
    <Teleport to="body">
      <ul
        v-if="sugOpen && suggestions.length"
        class="mov-sug"
        :style="{ left: sugPos.left + 'px', top: sugPos.top + 'px', width: sugPos.width + 'px' }"
      >
        <li
          v-for="(s, i) in suggestions"
          :key="sugKey(s)"
          :class="{ on: i === sugIdx }"
          @mousemove="sugIdx = i"
          @mousedown.prevent="pickSuggestion(s)"
        >
          <template v-if="s.kind === 'preset'">
            <span class="ms-name ms-preset">{{ s.preset.name }}</span>
            <em class="ms-display ms-tpl"><span
              v-for="(seg, j) in templateSegments(s.preset.template)"
              :key="j"
              :class="{ v: seg.variable }"
            >{{ seg.text }}</span></em>
            <span class="ms-kind">{{ t('prefs.templatePresetKind') }}</span>
          </template>
          <template v-else-if="s.kind === 'var'">
            <span class="ms-name ms-preset">{{ s.item.label }}</span>
            <em class="ms-display">{{ s.item.desc }}</em>
            <span class="ms-kind">{{ t('prefs.templateVarKind') }}</span>
          </template>
          <template v-else>
            <span class="ms-name">{{ s.term.name }}</span>
            <em v-if="s.term.display && s.term.display !== s.term.name" class="ms-display">{{ s.term.display }}</em>
            <span class="ms-kind">{{ kindLabel(s.term.kind) }}</span>
          </template>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }

.thead, .row {
  display: grid;
  grid-template-columns: 18px minmax(200px, 1fr) 52px 54px 72px 72px minmax(100px, 170px);
  align-items: center;
  gap: 10px;
  padding: 0 12px 0 14px;
}

.thead {
  height: 26px;
  border-bottom: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  position: sticky; top: 0; background: var(--bg); z-index: 2;
}

.tbody {
  overflow: auto; flex: 1;
  /* 下方面板改成上下分栏后不再压住表格，这段垫底空白随之取消 */
}

.row {
  height: var(--row-h);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
  cursor: default;
  position: relative;
  color: var(--text);
}
.row:hover { background: var(--surface-2); }
.row.on { background: var(--sel-bg); }
.row.on::before {
  content: '';
  position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
  background: var(--accent);
}

.c-title { display: flex; align-items: baseline; gap: 7px; overflow: hidden; cursor: pointer; }
/* pre：标题里的连续空格原样显示（模板里用来对齐时不能被 HTML 折叠） */
.c-title .t { overflow: hidden; text-overflow: ellipsis; white-space: pre; }
/* 译名：灰、细、不抢曲名的注意力。可以单独被截断（长译名不该把曲名挤没） */
.c-title .t-tr {
  flex: 0 1 auto; min-width: 0;
  color: var(--text-faint);
  font-size: 10.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.c-title:hover .t { color: var(--accent); text-decoration: underline dotted; }

/* 树状展开箭头。恒占 13px：没有子行的行用 .tw-ph 占位，
   这样整列曲名的起点一致，一半缩进一半不缩进的问题就没了。
   造型跟侧栏的折叠标记**同一份**：chevron（两条边构成的直角），不是实心三角。 */
.tw {
  flex: none;
  width: 13px;
  height: 13px;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}
.tw:hover { color: var(--accent); }
/* 箭头本体：收起时角尖朝右（0°），展开时转 90° 朝下 —— 只转不换图，
   和侧栏 `.side-chev` 完全一样（同一份 viewBox / path / stroke 宽度）。 */
.tw-chev {
  width: 10px;
  height: 10px;
  color: var(--text-faint);
  transform: rotate(0deg);
  transform-origin: 50% 50%;
  transition: transform 0.12s ease, color 0.12s ease;
}
.tw-chev path {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tw-chev.open { transform: rotate(90deg); }
.tw:hover .tw-chev { color: var(--accent); }
/* .collapsed 留在按钮上：它是「这一行收起来了」的状态标记（冒烟和本地存储按它查），
   视觉全交给 .tw-chev.open。 */
.tw-ph { flex: none; width: 13px; }

/* 行内改名：贴着原来的位置长出来，不弹窗、不跳版 */
.title-edit {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  height: 20px;
  padding: 0 4px;
  font-size: 12px;
  border: 1px solid var(--accent);
  border-radius: 2px;
  background: var(--surface);
}

/* 音频来源：♪ = 本地文件，云 = 只有网易云链接，— = 都没有 */
.c-play { display: flex; align-items: center; justify-content: center; font-size: 10px; }
.c-play .src { color: var(--text-faint); }
.c-play .file { color: var(--accent); font-size: 11.5px; }
.c-play .cloud { color: var(--text-dim); }
.num { text-align: right; }
.c-key { color: var(--text-dim); font-size: 11.5px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.c-period { color: var(--text-dim); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.c-genre { color: var(--text-dim); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.empty { padding: 28px; text-align: center; }
.empty p { margin: 4px 0; font-size: 11.5px; }

/* ---- 录音版本子行 ----
   不套表格栅格：子行是树的一层，跟着曲名走，缩进 + 连接线比「对齐到列」更像从属关系。
   缩进 40px ≈ 曲名文字的起点（14 内边距 + 18 ♪ 列 + 10 间隙 + 13 箭头 + 7 间隙），
   子行内容再靠自身 12px 的 ♪ 列 + 10 间隙接到 62px，和曲名严格对齐。 */
.row.rec-row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: calc(var(--row-h) - 2px);
  padding-left: 40px;
  padding-right: 12px;
  color: var(--text-dim);
  font-size: 11px;
  cursor: default;
}
/* 树线：一段竖线 + 一段横线（├），最后一个版本用 └ */
.row.rec-row::after {
  content: '';
  position: absolute;
  left: 28px;
  top: 0;
  bottom: 50%;
  width: 10px;
  border-left: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong);
  pointer-events: none;
}
.row.rec-row.last::after { bottom: 50%; border-bottom-left-radius: 3px; }
.row.rec-row.last::before { content: none; }
.row.rec-row:hover { background: var(--surface-2); }
.row.rec-row.on { background: var(--sel-bg); }

.rec-row .c-play { width: 12px; flex: none; }
.rec-row .c-rec {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  flex: 1;
}
.rec-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  align-self: center;
}
.rec-dot.on { background: var(--accent); border-color: var(--accent); }
.rec-title {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}
.row.rec-row.on .rec-title { color: var(--text); }
.rec-meta {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.rec-src {
  flex: none;
  font-size: 9px;
  padding: 0 4px;
  border-radius: 2px;
  border: 1px solid var(--line);
  color: var(--text-faint);
}
.rec-src.local { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.rec-src.none { opacity: 0.55; }

/* ---- 乐章子行 ---- 与录音子行同一套树线，但缩进再深两个全角字符：
   乐章是「另一首子曲目」，录音只是同一首的版本；缩进差一档，扫一眼就能分开 */
.row.mov-row {
  --mov-extra: 2em;
  display: flex;
  align-items: center;
  gap: 10px;
  height: calc(var(--row-h) - 2px);
  padding-left: calc(40px + var(--mov-extra));
  padding-right: 12px;
  color: var(--text-dim);
  font-size: 11.5px;
  cursor: default;
}
.row.mov-row::after {
  content: '';
  position: absolute;
  left: 28px;
  top: 0;
  bottom: 50%;
  width: calc(10px + var(--mov-extra));
  border-left: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong);
  pointer-events: none;
}
.row.mov-row.last::after { bottom: 50%; border-bottom-left-radius: 3px; }
.row.mov-row:hover { background: var(--surface-2); }
.row.mov-row.on { background: var(--sel-bg); }
.mov-row .c-play { width: 12px; flex: none; }
.mov-row .c-mov {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  flex: 1;
  cursor: pointer;
  position: relative;
}
.mov-title {
  color: var(--text);
  /* pre：乐章标题里的连续空格要能看见（模板变量缺省后手动补的对齐空格） */
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mov-row:hover .mov-title { color: var(--accent); }
.mov-meta {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.mov-row .title-edit { flex: 1 1 auto; }

/* 术语补全：Teleport 到 body 的 fixed 浮层，位置由 placeSuggest() 按输入框矩形现算。
   行本身是 22px 左右，下拉必须溢出到下一行之上；列表最多 8 条，内部滚动。 */
.mov-sug {
  position: fixed;
  z-index: 40;
  max-height: 228px;
  overflow: auto;
  margin: 0;
  padding: 3px;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: var(--shadow);
}
.mov-sug li {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 3px;
  color: var(--text-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
.mov-sug li.on { background: var(--sel-bg); color: var(--text); }
.ms-name { color: var(--text); }
/* 预设名 / 模板原文是模板文本，跟选项里的模板字体一起变；术语候选保持界面字体 */
.ms-preset,
.ms-tpl { font-family: var(--tpl-font, var(--font-text)); }
.ms-display { font-size: 10.5px; color: var(--text-faint); font-style: normal; }
/* 预设候选把模板原文摊开：变量绿色，和选项里的模板编辑器同一套读法 */
.ms-tpl {
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.ms-tpl .v { color: var(--accent); }
.ms-kind {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--text-faint);
  border: 1px solid var(--line);
  border-radius: 2px;
  padding: 0 4px;
}
</style>
