<script setup lang="ts">
import { isHant, toHant } from '@shared/hant.js';
import {
  applyTplFont,
  effectiveFps,
  frameStepMs,
  saveStepPrefs,
  setTplFont,
  stepPrefs,
  tplFont,
} from './playbackPrefs';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import LibraryView from './views/LibraryView.vue';
import GridEditor from './views/GridEditor.vue';
import TagPicker from './components/TagPicker.vue';
import TransportBar from './components/TransportBar.vue';
import BarBeatText from './components/BarBeatText.vue';
import MenuBar from './components/MenuBar.vue';
import VocabEditor from './components/VocabEditor.vue';
import ChordSymbolsEditor from './components/ChordSymbolsEditor.vue';
import { applyNumeralStyle, initNumeralStyle, numeralStyle } from './numeralStyle';
import RecordingManager from './components/RecordingManager.vue';
import AudioMetaDialog from './components/AudioMetaDialog.vue';
import MetaApplyDialog from './components/MetaApplyDialog.vue';
import { computeStartBars, formatMs, formatMsShort, tickToBarBeatSub, tickToMs } from '@shared/barbeat.js';
import { movementPrefix, nextMovementOrdinal } from '@shared/movement.js';
import { TEMPLATE_VARIABLES, templateSegments } from '@shared/titleTemplate.js';
import { applyVariable, suggestVariables } from '@shared/templateSuggest.js';
import { LOCALES } from '@shared/i18n.js';
import { PERIODS, periodLabel } from '@shared/search.js';
import { insertText, pickMode } from '@shared/suggest.js';
import { meterInfo, meterSystemForLocale } from '@shared/meter.js';
import { timelineDurationMs } from '@shared/timeline-clock.js';
import { entryIdOf, entryLabel, genreLabel, genreNameOf, loadVocabLabels, moodDisplay, moodIdOf, moodLabel } from './vocabLabels';
import { loadMovementLabels, tempoLabel, termsFromMovementTitle } from './movementLabels';
import { displayTitleOf, movementOrdinalOf } from './titleTemplate';
import TemplateEditor from './components/TemplateEditor.vue';
import {
  BUILTIN_PRESETS,
  allPresets,
  deleteUserPreset,
  isPresetNameTaken,
  matchPresets,
  saveUserPreset,
  type TemplateScope,
  type TitlePreset,
} from './titlePresets';
import { applyLocaleToDom, locale, setLocale, t, tn } from './i18n';
import { isComposing, isEditableTarget } from './ime';
import { publishHelpNow, setHoverRegion } from './helpctx';
import {
  loadTrack,
  pause as pauseAudio,
  play as playAudio,
  seek as seekAudio,
  state as audioState,
  syncTimelineDuration,
  unload as unloadAudio,
} from './audio/store.js';
import {
  clearAll as clearWaveCache,
  initWaveCache,
  readLimitMb,
  setLimitMb as saveWaveLimit,
  stats as waveStats,
} from './audio/wavecache.js';

const api = (window as any).api;

const meta = ref<any>(null);
const rows = ref<any[]>([]);
const selectedId = ref<string | null>(null);
const detail = ref<any>(null);
/** 当前曲目的歌词解析结果（详情面板显示匹配状态用） */
const lyricDoc = ref<any>({ found: false, file: null, lines: [], instrumental: false, how: 'none' });
const loading = ref(false);
/* ---------------- 播放列表 ----------------
 *
 * 「全部曲目」是虚拟的一条（`__all__`），永远等于当前曲库 ——
 * 不把它写成记录，就不用维护一条永远同步不过来的列表。
 * 真正的列表存在 `data/playlists.json`（源），按 trackIds 引用曲目。
 */
const ALL_PLAYLIST = '__all__';
const playlists = ref<{ id: string; name: string; trackIds: string[] }[]>([]);
const activeList = ref<string>(ALL_PLAYLIST);

async function loadPlaylists() {
  try {
    const doc = await api.playlists.list();
    playlists.value = Array.isArray(doc?.lists) ? doc.lists : [];
  } catch (e) {
    console.error('[playlist] 读取失败', e);
    playlists.value = [];
  }
}

function pickPlaylist(id: string) {
  activeList.value = id;
}

/**
 * 进入就地改名：聚焦 + **全选**。
 *
 * 全选是有意的：新建列表时名字是「播放列表 3」，用户想改名就直接打第一个字，
 * 那一个字会把原名整体替换掉；光标落在末尾的话只会变成「播放列表 3我的歌」。
 * 曲目行的改名也是这套（`startRename`）。
 */
function beginPlRename(id: string) {
  const pl = playlists.value.find((x) => x.id === id);
  if (!pl) return;
  plRename.value = { id: pl.id, text: pl.name };
  void nextTick(() => {
    plRenameInput.value?.focus({ preventScroll: true });
    plRenameInput.value?.select();
  });
}

async function newPlaylist() {
  try {
    const doc = await api.playlists.create();
    playlists.value = Array.isArray(doc?.lists) ? doc.lists : playlists.value;
    const last = playlists.value[playlists.value.length - 1];
    if (last) {
      activeList.value = last.id;
      // 建完直接进改名态（2026-11-13 用户要求）：想改就直接打字，不想改按 Enter / 点别处走人
      beginPlRename(last.id);
    }
  } catch (e) {
    console.error('[playlist] 新建失败', e);
  }
}

/* ---------------- 播放列表的右键菜单 ----------------
 *
 * label 那一整行 + 每个列表项都唤得出来。菜单里必有「新建播放列表」，
 * 在具体列表上右键才有改名 / 删除。
 *
 * 位置用 `position: fixed`（侧栏是滚动容器，绝对定位会跟着滚），
 * 开之前先夹进视口 —— 否则贴着右边缘右键，菜单会有一半在窗口外面。
 */
const plMenu = ref<null | { x: number; y: number; listId: string | null; section: SideSection }>(null);
type SideSection = 'library' | 'views' | 'vocab';
/** 侧栏三块的内联搜索：右键标题 → 「搜索…」才出现，Esc / × 收起 */
const sideSearchOn = ref<Record<SideSection, boolean>>({ library: false, views: false, vocab: false });
const sideQuery = ref<Record<SideSection, string>>({ library: '', views: '', vocab: '' });
const sideSearchEls: Record<SideSection, HTMLInputElement | null> = { library: null, views: null, vocab: null };
/** 正在就地改名的那一条（`null` = 没有在改名） */
const plRename = ref<null | { id: string; text: string }>(null);
const plRenameInput = ref<HTMLInputElement | null>(null);

/** v-for 里的 ref 会被收成数组，用函数 ref 稳定拿单个元素 */
function setRenameInput(el: any) {
  plRenameInput.value = (el as HTMLInputElement) ?? null;
}
function setSideSearchEl(section: SideSection, el: any) {
  sideSearchEls[section] = (el as HTMLInputElement) ?? null;
}

/** 标题关键词匹配：空查询 = 全显示；大小写不敏感，不做分词（用户要的就是「标题里有没有这几个字」） */
function sideHit(section: SideSection, text: unknown): boolean {
  const q = sideQuery.value[section].trim().toLowerCase();
  return !q || String(text ?? '').toLowerCase().includes(q);
}

const filteredPlaylists = computed(() => playlists.value.filter((pl) => sideHit('library', pl.name)));
const filteredViews = computed(() => (meta.value?.views ?? []).filter((v: any) => sideHit('views', v.name)));
const playlistVisibleCount = computed(
  () => filteredPlaylists.value.length + (sideHit('library', t('sidebar.allTracks')) ? 1 : 0)
);
const vocabVisibleCount = computed(() => {
  const dims = (meta.value?.vocabs ?? []).filter((v: any) => sideHit('vocab', dimLabel(v.dim))).length;
  const fixed = [t('sidebar.chordSymbols'), t('sidebar.tempoMarkings')].filter((s) => sideHit('vocab', s)).length;
  return dims + fixed;
});

function openSideSearch(section: SideSection) {
  // 搜索框在组里：先展开，再把焦点放进去
  sideCollapsed.value = { ...sideCollapsed.value, [section]: false };
  sideSearchOn.value = { ...sideSearchOn.value, [section]: true };
  sideQuery.value = { ...sideQuery.value, [section]: '' };
  void nextTick(() => {
    sideSearchEls[section]?.focus();
    sideSearchEls[section]?.select();
  });
}

function closeSideSearch(section: SideSection) {
  sideSearchOn.value = { ...sideSearchOn.value, [section]: false };
  sideQuery.value = { ...sideQuery.value, [section]: '' };
}

function openPlMenu(ev: MouseEvent, listId: string | null, section: SideSection = 'library') {
  ev.preventDefault();
  ev.stopPropagation();
  const w = 190;
  // 播放列表：新建 + （列表项上）改名 / 删除 + 搜索；另外两块只有一项「搜索…」
  const h = section !== 'library' ? 34 : listId ? 142 : 76;
  const x = Math.max(4, Math.min(ev.clientX, window.innerWidth - w - 4));
  const y = Math.max(4, Math.min(ev.clientY, window.innerHeight - h - 4));
  plMenu.value = { x, y, listId, section };
}

function closePlMenu() {
  plMenu.value = null;
}

function plMenuSearch() {
  const m = plMenu.value;
  closePlMenu();
  if (m) openSideSearch(m.section);
}

/**
 * 点菜单外面就关（菜单自己 `@pointerdown.stop`，这里天然只处理外面）。
 * 侧栏的播放列表菜单和曲目行的菜单共用这一个监听 —— 别为每种菜单再挂一条 window 监听，
 * 那样关一个漏一个的 bug 迟早出现（RULES 第 23 条）。
 */
function onDocPointerDownMenus(ev: PointerEvent) {
  if (!plMenu.value && !trackMenu.value && !recMenu.value) return;
  if ((ev.target as HTMLElement | null)?.closest?.('.ctxmenu')) return;
  plMenu.value = null;
  trackMenu.value = null;
  recMenu.value = null;
}

function onPlMenuKey(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return;
  if (plMenu.value) closePlMenu();
  if (trackMenu.value) closeTrackMenu();
  if (recMenu.value) closeRecMenu();
  if (plRename.value) plRename.value = null;
}

function plMenuNew() {
  closePlMenu();
  void newPlaylist();
}

function plMenuRename() {
  const m = plMenu.value;
  closePlMenu();
  const pl = m?.listId ? playlists.value.find((x) => x.id === m.listId) : null;
  if (!pl) return;
  beginPlRename(pl.id);
}

/** Enter / 失焦都会走到这里；`plRename` 先清空，所以第二次进来什么都不做 */
async function commitRename() {
  const r = plRename.value;
  if (!r) return;
  plRename.value = null;
  const name = String(r.text ?? '').trim();
  const cur = playlists.value.find((x) => x.id === r.id);
  if (!name || !cur || cur.name === name) return;
  try {
    const doc = await api.playlists.rename(r.id, name);
    if (Array.isArray(doc?.lists)) playlists.value = doc.lists;
  } catch (e) {
    console.error('[playlist] 改名失败', e);
  }
}

async function plMenuDelete() {
  const m = plMenu.value;
  closePlMenu();
  const pl = m?.listId ? playlists.value.find((x) => x.id === m.listId) : null;
  if (!pl) return;
  // 删列表是「不可撤销」的那一类（歌曲本身不动，但列表关系没了），先问一句
  const ok = await confirmDialog(
    t('sidebar.deletePlaylist'),
    t('sidebar.deletePlaylistAsk', { name: pl.name })
  );
  if (!ok) return;
  try {
    const doc = await api.playlists.remove(pl.id);
    if (Array.isArray(doc?.lists)) playlists.value = doc.lists;
    if (activeList.value === pl.id) activeList.value = ALL_PLAYLIST;
  } catch (e) {
    console.error('[playlist] 删除失败', e);
  }
}

/* ---------------- 曲目行的右键菜单 ----------------
 *
 * 右键曲名以前直接进改名：「一个右键只干一件事」，其余动作（放进播放列表、删掉）
 * 根本没地方放，只能先选中再从菜单栏里翻。现在右键出菜单，改名只是第一项。
 *
 * 规矩和侧栏那条一样（RULES 第 23 条）：点别处关、Esc 关、位置夹进视口。
 * `row` 存整行而不是 id：菜单里的「播放」用的就是列表里那一行的数据。
 */
const trackMenu = ref<null | { x: number; y: number; row: any }>(null);

function openTrackMenu(payload: { row: any; x: number; y: number }) {
  const w = 196;
  // 五项 + 一条分隔（登记乐章只在母作品上出现），够摆；比实际高一点留着空隙
  const h = 180;
  trackMenu.value = {
    x: Math.max(4, Math.min(payload.x, window.innerWidth - w - 4)),
    y: Math.max(4, Math.min(payload.y, window.innerHeight - h - 4)),
    row: payload.row,
  };
}

function closeTrackMenu() {
  trackMenu.value = null;
}

function trackMenuPlay() {
  const row = trackMenu.value?.row;
  closeTrackMenu();
  if (row) void playRow(row);
}

function trackMenuRename() {
  const row = trackMenu.value?.row;
  closeTrackMenu();
  if (row) startRename(row.id);
}

/** 登记乐章：在母作品下建一个子曲目 → 选中 → 曲名进输入态（接着默认前缀往后打） */
async function trackMenuAddMovement() {
  const row = trackMenu.value?.row;
  closeTrackMenu();
  if (!row) return;
  // 只有母作品能挂乐章：乐章子项自己不能再往下登记（决定 54：只做一层）
  if (row.parentId) return;
  const n = nextMovementOrdinal((Array.isArray(row.movements) ? row.movements : []).map((m: any) => m.title));
  const title = movementPrefix(n, locale.value);
  const r = await api.tracks.create({ title, parentId: row.id });
  await loadRows();
  await select(r.id);
  editRowId.value = r.id;
  editCaretEnd.value = true;
  editPrefix.value = title;
  message.value = { key: 'msg.registeredMovement' };
}

/* ---- 「添加到播放列表」的选列表窗口 ---- */

/**
 * 哪个曲目正在选列表（`null` = 窗口没开）。
 *
 * 为什么是弹窗而不是二级菜单：列表数量不固定，二级菜单一多就得滚，
 * 而且在文件树旁边再叠一层浮层更容易点错。弹窗里一行一个列表，点一下就进。
 */
const plPick = ref<null | { trackId: string; title: string }>(null);

function trackMenuAdd() {
  const row = trackMenu.value?.row;
  closeTrackMenu();
  if (row) plPick.value = { trackId: row.id, title: shownTitleOf(row) };
}

/** 这个曲目在不在某个列表里（弹窗里给「已在其中」用） */
function inList(pl: { trackIds: string[] }, id: string): boolean {
  return pl.trackIds.includes(id);
}

/** 点一个列表就放进去，然后关窗 —— 不设「确定」，选哪个就是哪个 */
async function pickListFor(plId: string) {
  const p = plPick.value;
  if (!p) return;
  const pl = playlists.value.find((x) => x.id === plId);
  if (!pl || inList(pl, p.trackId)) return;
  try {
    const doc = await api.playlists.setTracks(plId, [...pl.trackIds, p.trackId]);
    if (Array.isArray(doc?.lists)) playlists.value = doc.lists;
    plPick.value = null;
    message.value = { key: 'msg.addedToPlaylist', vars: { name: pl.name } };
  } catch (e) {
    console.error('[playlist] 加入失败', e);
    message.value = { key: 'msg.saveFailed', vars: { note: String(e) } };
  }
}

/** 一个列表都没有时也别把人卡住：建一个并把这首直接放进去 */
async function newListForPick() {
  const p = plPick.value;
  try {
    const doc = await api.playlists.create();
    playlists.value = Array.isArray(doc?.lists) ? doc.lists : playlists.value;
    const last = playlists.value[playlists.value.length - 1];
    if (p && last) {
      const doc2 = await api.playlists.setTracks(last.id, [p.trackId]);
      if (Array.isArray(doc2?.lists)) playlists.value = doc2.lists;
      message.value = { key: 'msg.addedToPlaylist', vars: { name: last.name } };
    }
    plPick.value = null;
  } catch (e) {
    console.error('[playlist] 新建失败', e);
  }
}

/** 从「当前正在看的那个列表」里移出（只在具体列表里才有这一项） */
async function trackMenuRemoveFrom() {
  const row = trackMenu.value?.row;
  const pl = activePlaylist.value;
  closeTrackMenu();
  if (!row || !pl || !inList(pl, row.id)) return;
  try {
    const doc = await api.playlists.setTracks(
      pl.id,
      pl.trackIds.filter((x) => x !== row.id)
    );
    if (Array.isArray(doc?.lists)) playlists.value = doc.lists;
    message.value = { key: 'msg.removedFromPlaylist', vars: { name: pl.name } };
  } catch (e) {
    console.error('[playlist] 移出失败', e);
  }
}

function trackMenuDelete() {
  const row = trackMenu.value?.row;
  closeTrackMenu();
  if (row) void removeSelectedTrack(row.id);
}

/* ---- 「音频元数据」面板 ----
 *
 * 入口挂在**录音行**上（详情栏 + 列表里的版本子行），不是曲目行：
 * 元数据属于**文件**，同一个作品的两个版本可能是两个 DAW 工程导的 ——
 * 作者、时间码、速度都可能不一样，右键哪一条就看哪一条。
 *
 * 面板自己不发写请求，只把值 emit 上来，由这里统一走 `tracks:update`，
 * 和改名/改标签同一条写路径。
 */
const metaTarget = ref<null | { trackId: string; recId: string | null; title: string }>(null);

function openMeta(trackId: string, recId: string | null, title: string) {
  metaTarget.value = { trackId, recId, title };
}

/**
 * 面板里提示「档案里已经是这个值了」要拿当前档案比对。
 * 右键的不一定是选中那首 —— 不是同一首就没法比对，退回「都不知道」。
 */
const metaCurrent = computed(() => {
  const m = metaTarget.value;
  if (!m || m.trackId !== selectedId.value) return { title: null, album: null, bpm: null, meter: null };
  return {
    title: detail.value?.title ?? null,
    album: detail.value?.album ?? null,
    bpm: detail.value?.bpm ?? null,
    meter: detail.value?.meter ?? null,
  };
});

/**
 * 填档案前的确认窗口。文件标签不一定可信（转码器会把上游工程的信息原样带过来），
 * 所以每个字段摊开让人逐个勾 —— 看到「专辑」写着别人的名字，取消那一行就行。
 */
const metaApply = ref<null | { rows: any[]; fileName: string }>(null);

function onMetaApplyRequest(payload: { rows: any[]; fileName?: string }) {
  metaApply.value = { rows: payload.rows ?? [], fileName: payload.fileName ?? '' };
}

async function onMetaConfirm(picked: Record<string, string>) {
  const m = metaTarget.value;
  if (!m) return;
  const patch: any = {};
  for (const [k, v] of Object.entries(picked)) {
    if (k === 'bpm') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0 && n < 1000) patch.bpm = n;
    } else if (k === 'meter') {
      const mm = /^(\d+)\/(\d+)$/.exec(String(v));
      if (mm && Number(mm[1]) > 0 && Number(mm[2]) > 0) patch.meter = { num: Number(mm[1]), den: Number(mm[2]) };
    } else {
      patch[k] = String(v);
    }
  }
  metaApply.value = null;
  if (!Object.keys(patch).length) return;
  try {
    await api.tracks.update(m.trackId, patch);
    metaTarget.value = null;
    // 当前正在看这首就重拉详情（时间轴的 bpm/拍号都从 analysis 读，不刷新不生效）
    if (selectedId.value === m.trackId) detail.value = await api.tracks.get(m.trackId);
    else await loadRows({ autoSelect: false });
    message.value = { key: 'msg.metaFilled' };
  } catch (e) {
    console.error('[audio-meta] 填入失败', e);
    message.value = { key: 'msg.saveFailed', vars: { note: String(e) } };
  }
}

/* ---- 录音行的右键菜单 ----
 *
 * 和曲目行同一套规矩：点别处关、Esc 关、位置夹进视口、`@pointerdown.stop`。
 * 目前只有「音频元数据」一项 —— 切版本/管理都已经有单击与双击的手势了，
 * 再往菜单里塞一份等于同一件事有两条路，只会让人犹豫。
 */
const recMenu = ref<null | { x: number; y: number; row: any; rec: any }>(null);

function openRecMenu(payload: { row: any; rec: any; x: number; y: number }) {
  const w = 180;
  const h = 40;
  recMenu.value = {
    x: Math.max(4, Math.min(payload.x, window.innerWidth - w - 4)),
    y: Math.max(4, Math.min(payload.y, window.innerHeight - h - 4)),
    row: payload.row,
    rec: payload.rec,
  };
}

function closeRecMenu() {
  recMenu.value = null;
}

function recMenuMeta() {
  const m = recMenu.value;
  closeRecMenu();
  if (m) openMeta(m.row.id, m.rec?.id ?? null, shownTitleOf(m.row));
}

/** 侧栏四块的展开 / 收起（默认全展开，状态记在本地） */const sideCollapsed = ref<Record<string, boolean>>(readSideCollapsed());
function readSideCollapsed(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem('ma-side-collapsed') || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function toggleSide(key: string) {
  const next = { ...sideCollapsed.value, [key]: !sideCollapsed.value[key] };
  sideCollapsed.value = next;
  try {
    localStorage.setItem('ma-side-collapsed', JSON.stringify(next));
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
  // 展开后多出一批文案，最小宽度要重算（折叠时只许变大，见 measureSideMinW）
  void nextTick(measureSideMinW);
}

/* 底部网格面板（DAW 的 lower zone）：可拖高度、可关、可弹独立窗口 */
const panelOpen = ref(localStorage.getItem('ma-panel-open') !== '0');
const panelH = ref(Number(localStorage.getItem('ma-panel-h')) || 320);
/**
 * 动态操作帮助窗口是否开着 —— 菜单里那两条要看勾选状态。
 * 它有自己的关闭按钮，所以真值以主进程广播为准，不靠本地乐观值。
 */
const helpOpen = ref(false);
/** 历史记录窗口是否开着（菜单勾选 + 快捷键共用） */
const historyOpen = ref(false);
/**
 * 撤销 / 重做能不能点（菜单里那四条用）。
 *
 * 和网格里的按钮是同一份状态，只是这里跨曲目：`undo/redo` 看当前曲目，
 * `gUndo/gRedo` 看全局游标。**不缓存成业务状态** —— 每次都由主进程的历史算给你。
 */
const histMenu = ref({ undo: false, redo: false, gUndo: false, gRedo: false });

/** 从一份历史快照里摘出「对当前曲目 + 全局」的可用性 */
function readHistMenu(st: any) {
  const aid = detail.value?.analysis?.id ?? null;
  const cur = aid ? st?.cursors?.[aid] : undefined;
  const mine = (st?.items ?? []).filter((i: any) => aid && i.analysisId === aid);
  histMenu.value = {
    undo: cur != null && mine.some((i: any) => i.seq < cur),
    redo: cur != null && mine.some((i: any) => i.seq > cur),
    gUndo: !!st?.can?.undo,
    gRedo: !!st?.can?.redo,
  };
}

async function syncHistMenu() {
  try {
    readHistMenu(await api.history?.list?.());
  } catch {
    histMenu.value = { undo: false, redo: false, gUndo: false, gRedo: false };
  }
}
/** 主题在下面 toggleTheme 那一段声明：mode（用户选的）与 theme（实际生效的）要分开 */
const text = ref('');
const viewId = ref<string>('roman');
/**
 * 网格的格单位：菜单里要显示勾选状态，所以放在 App 层由 GridEditor 同步。
 *
 * 初值从 localStorage 读：**独立时间线窗口是另一个渲染进程**，它没有单位菜单，
 * 只能靠同一个 origin 的 localStorage 跟着走（以前它恒为一拍 —— 用户在那边按 Alt+←
 * 永远只收一拍，而主窗口里是按单位走的）。
 */
const GRID_UNIT_KEY = 'ma-grid-unit';
function readGridUnit(): 'bar' | 'beat' | 'half' {
  try {
    const raw = localStorage.getItem(GRID_UNIT_KEY);
    if (raw === 'bar' || raw === 'beat' || raw === 'half') return raw;
  } catch {
    /* 隐私模式读不到 */
  }
  return 'beat';
}
const gridUnit = ref<'bar' | 'beat' | 'half'>(readGridUnit());
watch(gridUnit, (u) => {
  try {
    localStorage.setItem(GRID_UNIT_KEY, u);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
});
const filterTags = ref<string[]>([]);

/* ---------------- 侧栏宽度（可拖拽）+ 展开 / 收起 ---------------- */

/** 夹在合理区间里：太窄按钮会换行，太宽编辑区就没了 */
const clampW = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

function readWidth(key: string, dflt: number, lo: number, hi: number) {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw > 0) return clampW(raw, lo, hi);
  } catch {
    /* 隐私模式读不到，用默认值 */
  }
  return dflt;
}

const LEFT_MAX = 420;
const RIGHT_MIN = 280;
const RIGHT_MAX = 620;
/** 量出真实下限之前的地板值：只用来夹首帧，量完就被 `sideMinW` 取代 */
const LEFT_FLOOR = 150;

/**
 * 左侧栏的最小宽度 —— **量出来的，不是写死的常量**（用户 2026-11-08）。
 *
 * 为什么不用魔数：最小值取决于「当前语言里最长的那条侧栏文案」× 「当前字号」×
 * 「当前字体」。三个都是会变的东西（切英文、改字号、换字体），写死一套数就迟早对不上，
 * 而且错得很安静 —— 只是「又能把字挤扁了」，没人会想到是常量过期。
 *
 * 算法（`measureSideMinW`）：把每条侧栏文案用 canvas 按**它自己的 computed font**
 * 量出完整宽度，再加上这条文案到侧栏左右边缘的实际占位，取最大值，最后 + 2 个全角
 * （= 2em）当余量。那个余量**加在右侧**，所以右留白 `--side-inset-r` 调大时，
 * 下限会自己跟着长，不会出现「留白越大、字越挤」的怪事。
 *
 * 初值是地板值：首帧 DOM 还没布局，量不出来；量完立刻抬到真值。
 */
const sideMinW = ref(LEFT_FLOOR);

const leftW = ref(readWidth('ma-left-w', 196, LEFT_FLOOR, LEFT_MAX));
const rightW = ref(readWidth('ma-right-w', 344, RIGHT_MIN, RIGHT_MAX));

/**
 * 左栏**实际**用的宽度 = max(用户存的宽度, 量出来的下限)。
 *
 * 为什么不把下限直接写进 `leftW`：字体是异步到的 —— 回退字体比真字体宽，
 * 先量到的是偏大的下限，把 `leftW` 抬上去之后就再也降不回来了
 * （`clampW` 只会升），于是侧栏永远比用户上次调好的宽一截。
 * 现在 `leftW` 只存**用户意图**，下限只在显示层生效，字体稳定后自动回落。
 */
const leftShown = computed(() => Math.max(leftW.value, sideMinW.value));

/**
 * 侧栏 / 详情栏是否**整体**收起。
 * 和上面 `sideCollapsed`（四块标题各自折叠）是两件不同的事，别混：
 * 那个折的是内容，这个折的是整根栏。
 */
const leftCollapsed = ref(false);
const rightCollapsed = ref(false);
try {
  leftCollapsed.value = localStorage.getItem('ma-left-collapsed') === '1';
  rightCollapsed.value = localStorage.getItem('ma-right-collapsed') === '1';
} catch {
  /* 隐私模式：本次会话默认展开 */
}

function persistCollapsed() {
  try {
    localStorage.setItem('ma-left-collapsed', leftCollapsed.value ? '1' : '0');
    localStorage.setItem('ma-right-collapsed', rightCollapsed.value ? '1' : '0');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

/**
 * 把「主窗口里被鼠标拖出来的东西」写进 config.json。
 *
 * 为什么不全交给 localStorage（以前就是那样）：用户要求窗口与面板的尺寸
 * **写在外挂 config.json 里**，换机器 / 重装后仍能照着摆；而且主进程那边
 * 窗口几何本来就只有它读得到，统一到一份文件里才不会两处各说各的。
 *
 * 300ms 防抖：拖动结束时也只写一次，但折叠连点时不会写成一串。
 */
let panelPushTimer: number | null = null;
function pushPanelSizes() {
  if (panelPushTimer) window.clearTimeout(panelPushTimer);
  panelPushTimer = window.setTimeout(() => {
    panelPushTimer = null;
    void api.config
      ?.setLayout?.({
        panels: {
          leftW: leftW.value,
          rightW: rightW.value,
          panelH: panelH.value,
          leftCollapsed: leftCollapsed.value,
          rightCollapsed: rightCollapsed.value,
          panelOpen: panelOpen.value,
        },
      })
      ?.catch?.(() => undefined);
  }, 300);
}

/**
 * 启动时读 config.json 里的面板尺寸。
 *
 * 优先级：config.json > localStorage。第一次升级上来时 config 里还没有这几个数，
 * 那就把当前 localStorage 的值写进去（`seeded`），之后一律以 config 为准 ——
 * 否则「改了宽度但只在 localStorage 里」和「config 里的旧值」会来回打架。
 */
async function loadPanelLayout(): Promise<boolean> {
  let panels: any = null;
  try {
    const snap: any = await api.config.get();
    panels = snap?.layout?.panels ?? null;
  } catch {
    return false;
  }
  if (!panels) return false;
  let seeded = false;
  if (typeof panels.leftW === 'number') leftW.value = clampW(panels.leftW, LEFT_FLOOR, LEFT_MAX);
  else seeded = true;
  if (typeof panels.rightW === 'number') rightW.value = clampW(panels.rightW, RIGHT_MIN, RIGHT_MAX);
  else seeded = true;
  if (typeof panels.panelH === 'number') panelH.value = Math.min(panels.panelH, maxPanelH());
  else seeded = true;
  if (typeof panels.leftCollapsed === 'boolean') leftCollapsed.value = panels.leftCollapsed;
  else seeded = true;
  if (typeof panels.rightCollapsed === 'boolean') rightCollapsed.value = panels.rightCollapsed;
  else seeded = true;
  if (typeof panels.panelOpen === 'boolean') panelOpen.value = panels.panelOpen;
  else seeded = true;
  if (seeded) pushPanelSizes();
  return true;
}

function toggleLeftSide() {
  leftCollapsed.value = !leftCollapsed.value;
  persistCollapsed();
  pushPanelSizes();
}

function toggleRightSide() {
  rightCollapsed.value = !rightCollapsed.value;
  persistCollapsed();
  pushPanelSizes();
}

/**
 * 把一条侧栏文案拆成「若干段文字 + 各自的字体」。
 *
 * 为什么不能直接 `el.textContent`：`.side-title` 里嵌着一个 `.faint` 小字
 * （「词表 （JSON 是源）」），字号比主标题小一圈。整段用主标题的字体量，
 * 英文那半句会被明显高估 —— 最小宽度虚胖，侧栏白白变宽。
 */
function textRuns(el: HTMLElement) {
  const runs: { text: string; font: string; spacing: string }[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ');
    if (!text.trim()) continue;
    const host = n.parentElement ?? el;
    const cs = getComputedStyle(host);
    runs.push({
      text,
      font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
      spacing: cs.letterSpacing,
    });
  }
  return runs;
}

/**
 * 量左侧栏最小宽度（公式见 `sideMinW` 上面那段）。
 *
 * 只量 `.side-label` / `.side-title` —— **不量 `.side-name`**：那是用户起的
 * 播放列表名，可以任意长，算进去会让侧栏被一个名字顶到半屏（用户明确不要）。
 */
function measureSideMinW() {
  const side = document.querySelector<HTMLElement>('.sidebar');
  if (!side) return;
  const box = side.getBoundingClientRect();
  // 收起着 / 还没布局的时候量不到东西，直接跳过（展开时会再量一次）
  if (box.width < 2) return;
  const em = parseFloat(getComputedStyle(side).fontSize) || 11.5;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return;

  let widest = 0;
  const rows: { text: string; left: number; textW: number; right: number; total: number }[] = [];
  for (const el of side.querySelectorAll<HTMLElement>('.side-label, .side-title')) {
    const runs = textRuns(el);
    if (!runs.length) continue;
    let textW = 0;
    for (const run of runs) {
      ctx.font = run.font;
      // 小标题带 0.08em 字距；canvas 支持就设，不支持就少算一点点（宁可偏窄一点点也别虚胖）
      try {
        (ctx as unknown as { letterSpacing: string }).letterSpacing = run.spacing;
      } catch {
        /* 老 Chromium 没有这个属性 */
      }
      textW += ctx.measureText(run.text).width;
    }
    /*
     * 文字左右两侧的「实际占位」。
     *
     * 元素是 flex 撑满的（`.side-label` 是 flex:1），所以它的 rect 左缘/右缘**不随文字
     * 长短变化**，量出来的就是容器给的固定留白：左边含树状缩进 + chevron 槽，
     * 右边含 `--side-inset-r`。文字宽单独用 canvas 量（不受 ellipsis 裁剪影响）。
     */
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const leftRoom = r.left - box.left + (parseFloat(cs.paddingLeft) || 0);
    const rightRoom = box.right - r.right + (parseFloat(cs.paddingRight) || 0);
    const total = leftRoom + textW + rightRoom;
    rows.push({ text: runs.map((x) => x.text).join('').trim(), left: Math.round(leftRoom), textW: Math.round(textW), right: Math.round(rightRoom), total: Math.round(total) });
    widest = Math.max(widest, total);
  }
  // 诊断用：哪条文案撑起了下限（`__app.sideMeasure()` 读它，也方便以后调数值）
  (window as unknown as { __sideMeasure?: unknown }).__sideMeasure = {
    em,
    widest: Math.round(widest),
    rows: rows.sort((a, b) => b.total - a.total).slice(0, 5),
  };
  if (widest <= 0) return;

  const next = Math.ceil(widest + em * 2);
  /*
   * 四块里有折叠的，量到的文案就不全（那些行压根没渲染）—— 这时只许把下限**调大**。
   * 否则「全部折叠 → 量出来很窄 → 下限被调小 → 展开后又挤字」，
   * 而且看不出是谁干的。全部展开时才可以双向更新（切语言会走到这里）。
   */
  const allOpen = !Object.values(sideCollapsed.value).some(Boolean);
  if ((allOpen || next > sideMinW.value) && Math.abs(next - sideMinW.value) >= 1) {
    sideMinW.value = next;
  }
  // 注意：**不写 leftW**。下限只在 `leftShown` 里生效，用户的宽度原样留着（见 leftShown 注释）。
}

/** 拖动到最小宽度之后再往内拖多少像素，就认定「要收起」 */
const COLLAPSE_PULL = 32;
/** 边缘块上按下后，位移小于这个值就算「点击」而不是「拖动」 */
const EDGE_TAP_SLOP = 4;

let splitSide: 'left' | 'right' | null = null;
let splitX = 0;
let splitStartW = 0;
/** 拖到下限之后还继续挤了多少（松手时据此决定收不收） */
let splitOverpull = 0;
/** 这一次拖动是从「已收起」开始的：往外拖要能把它拉出来 */
let splitFromCollapsed = false;

function startSplit(side: 'left' | 'right', ev: PointerEvent, x0?: number) {
  splitSide = side;
  splitX = x0 ?? ev.clientX;
  splitOverpull = 0;
  const collapsed = side === 'left' ? leftCollapsed.value : rightCollapsed.value;
  splitFromCollapsed = collapsed;
  /*
   * 起点必须是**屏幕上看到的那个宽度**（`leftShown`），不是 `leftW`（用户意图）。
   * 两者在下限高于用户宽度时会差一截 —— 用 leftW 当起点，鼠标拖 60px 而边界只走 30px，
   * 手感是「跟不上手」。
   */
  splitStartW = collapsed ? 0 : side === 'left' ? leftShown.value : rightW.value;
  // 指针捕获：拖出 7px 手柄也不会断（否则手一快就丢事件）
  try {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有指针可捕获 */
  }
  document.body.classList.add('resizing');
  ev.preventDefault();
}

function moveSplit(ev: PointerEvent) {
  if (!splitSide) return;
  const dx = ev.clientX - splitX;
  const min = splitSide === 'left' ? sideMinW.value : RIGHT_MIN;
  const max = splitSide === 'left' ? LEFT_MAX : RIGHT_MAX;

  // ① 从收起状态往外拖：先要拖出 COLLAPSE_PULL 才真的展开，避免一碰就弹出来
  if (splitFromCollapsed) {
    const out = splitSide === 'left' ? dx : -dx;
    if (out > COLLAPSE_PULL) {
      if (splitSide === 'left') {
        leftCollapsed.value = false;
        leftW.value = clampW(out, min, max);
      } else {
        rightCollapsed.value = false;
        rightW.value = clampW(out, min, max);
      }
    }
    return;
  }

  // ② 正常拖动：超过下限就「钉在下限」，把多出来的距离记进 overpull
  const raw = splitSide === 'left' ? splitStartW + dx : splitStartW - dx;
  if (raw < min) {
    splitOverpull = min - raw;
    if (splitSide === 'left') leftW.value = min;
    else rightW.value = min;
    return;
  }
  splitOverpull = 0;
  if (splitSide === 'left') leftW.value = clampW(raw, min, max);
  else rightW.value = clampW(raw, min, max);
}

function endSplit() {
  if (!splitSide) return;
  const side = splitSide;
  // 松手才落盘：拖动过程中每帧写 localStorage 会拖慢（同步 IO）
  try {
    localStorage.setItem('ma-left-w', String(leftW.value));
    localStorage.setItem('ma-right-w', String(rightW.value));
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  /*
   * 拖过头了 → 收起。
   *
   * `leftW` 在 overpull 阶段被钉成了下限，这里要**还原成拖动前的值**：
   * 收起状态下它不参与显示，但下次展开要回到原来的宽度（用户的要求），
   * 而不是回到一个「被夹过的」下限。
   */
  if (splitOverpull >= COLLAPSE_PULL) {
    if (side === 'left') {
      leftCollapsed.value = true;
      if (splitStartW > 0) leftW.value = splitStartW;
    } else {
      rightCollapsed.value = true;
      if (splitStartW > 0) rightW.value = splitStartW;
    }
    persistCollapsed();
  }
  splitSide = null;
  splitOverpull = 0;
  splitFromCollapsed = false;
  document.body.classList.remove('resizing');
  pushPanelSizes();
}

/* ---------- 边缘悬停块：点一下收起 / 展开，按住拖就变成调宽 ---------- */

let edgeSide: 'left' | 'right' | null = null;
let edgeX0 = 0;
let edgeDragging = false;

function onEdgeDown(side: 'left' | 'right', ev: PointerEvent) {
  edgeSide = side;
  edgeX0 = ev.clientX;
  edgeDragging = false;
  try {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件 */
  }
}

function onEdgeMove(ev: PointerEvent) {
  if (!edgeSide) return;
  if (!edgeDragging) {
    // 还在「点击」的容差里：不动，免得手抖就把点击变成拖动
    if (Math.abs(ev.clientX - edgeX0) < EDGE_TAP_SLOP) return;
    edgeDragging = true;
    // 交给正常的拖宽流程，起点用**按下时**的 x（不是越过容差那一刻的）
    startSplit(edgeSide, ev, edgeX0);
  }
  moveSplit(ev);
}

function onEdgeUp(ev: PointerEvent) {
  if (!edgeSide) return;
  const side = edgeSide;
  if (edgeDragging) {
    endSplit();
  } else if (ev.type !== 'pointercancel') {
    if (side === 'left') toggleLeftSide();
    else toggleRightSide();
  }
  edgeSide = null;
  edgeDragging = false;
}
/**
 * 状态栏那句提示。存「词典键 + 变量」而不是拼好的句子：
 * 一句提示可能在状态栏挂很久，中途切了语言也不该变成外语夹中文。
 * 变量值允许再嵌一层 `{ key, vars }`（比如「唤起失败：<原因>」里的原因），
 * 渲染时才一起翻 —— 否则就会出现「Could not open: 客户端未安装」这种半句英文半句中文。
 */
const message = ref<{ key: string; vars?: Record<string, unknown> } | null>(null);
const messageText = computed(() => {
  const m = message.value;
  if (!m) return '';
  const vars: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m.vars ?? {})) {
    const nested = v as { key?: string; vars?: Record<string, unknown> } | null;
    vars[k] = nested && typeof nested === 'object' && typeof nested.key === 'string' ? t(nested.key, nested.vars) : v;
  }
  return t(m.key, vars);
});

/** 主进程回来的原因：优先用可重翻的键，没有键就用原文 */
function noteVar(res: any): unknown {
  return res?.noteKey ? { key: res.noteKey, vars: res.noteVars } : res?.note ?? '';
}
const orphans = ref<any[]>([]);
/** 已归档作品（软删的曲目）：删除只是移进 data/tracks/.archive，彻底删除才真清 */
const showArchive = ref(false);
const archived = ref<{ uuid: string | null; title: string; archivedAt: number; file: string }[]>([]);
const showOrphans = ref(false);
/** 词表编辑器：侧栏点哪个维度就打开哪一张（null = 关闭） */
const vocabDim = ref<string | null>(null);
/** 和弦符号补全词表（只服务字母和弦泳道，和标签词表分开） */
const showChordSymbols = ref(false);
/**
 * 侧栏「和弦符号」那一行右边的数字 = **性质条数**。
 *
 * 以前是个占位的 `×`（它既不是维度也没有 count 字段）。现在跟其它五行一样给个数字：
 * 那是这张表里真正「有多少条」的东西；音名 × 变音只是候选的组合数（7×5×16=560），
 * 显示出来一眼看不出词表规模。
 * 改完词表会派 `ma:prefs{key:'chordSymbols'}`，这里跟着重读。
 */
const chordQualityCount = ref<number | null>(null);

/** 速度术语表（tempo_marking.json）：侧栏数字 = 速度 / 表情术语条数（不含体裁） */
const tempoMarkCount = ref<number | null>(null);

async function loadTempoMarkCount() {
  try {
    const doc = await api.movement?.doc?.();
    tempoMarkCount.value = Number.isFinite(doc?.tempoCount) ? doc.tempoCount : null;
  } catch {
    tempoMarkCount.value = null;
  }
}

async function loadChordQualityCount() {
  try {
    const doc = await api.chords?.doc?.();
    chordQualityCount.value = Array.isArray(doc?.qualities) ? doc.qualities.length : null;
  } catch {
    chordQualityCount.value = null;
  }
}

/**
 * 状态栏的音频信息（采样率 / 位深 / 文件大小）。
 *
 * 取的是**当前在听的那一版**：试听第 3 版就显示第 3 版的 48k/24bit，
 * 跟波形、原点偏移是同一个口径（都来自 `activeRecording`）。
 * 有损格式（mp3/m4a）没有「位深」这个概念，那里写「有损」而不是「—」。
 */
const audioMeta = ref<any>(null);

async function loadAudioMeta() {
  const d = detail.value;
  if (!d?.id) {
    audioMeta.value = null;
    return;
  }
  try {
    const rec = activeRecording.value;
    audioMeta.value = rec?.id
      ? await api.audio.resolveRecording(d.id, rec.id)
      : await api.audio.resolve(d.id);
  } catch {
    audioMeta.value = null;
  }
}

/** 没有位深这回事的容器/编码 */
const LOSSY_FORMATS = new Set(['mp3', 'mp4', 'ogg', 'opus', 'aac', 'm4a']);

const audioLine = computed(() => {
  const m = audioMeta.value;
  if (!m?.exists) return '';
  const parts: string[] = [];
  const fmt = String(m.format ?? '').toLowerCase();
  if (fmt) parts.push(fmt.toUpperCase());
  if (m.sampleRate > 0) {
    const khz = m.sampleRate / 1000;
    parts.push(`${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`);
  }
  if (LOSSY_FORMATS.has(fmt)) parts.push(t('status.audioLossy'));
  else if (m.bits > 0) parts.push(`${m.bits} bit`);
  else parts.push(t('status.audioUnknown'));
  if (m.size > 0) {
    parts.push(m.size >= 1048576 ? `${(m.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(m.size / 1024))} KB`);
  }
  /**
   * Broadcast Wave 标记：wav 头里有 `bext` 块才显示。
   *
   * 只标来源，不标能力 —— 它对我们**没有任何解析依赖**（元数据块全在 data 前后，
   * 不插在采样流中间，实测与纯 wav 的互相关是 0 采样位移）。
   * 放这里是因为「同样是 .wav，一个是 DAW 直出、一个被转码器洗过」这件事，
   * 光看扩展名分不出来，而它会影响你对「这段音频可不可信」的判断。
   */
  if (m.bwf) parts.push(t('status.bwf'));
  /**
   * 编码器预热补偿：这个文件开头多出来多少毫秒（mp3 无 Xing ≈ 25ms / aac 无 edit list ≈ 23ms）。
   * 有补偿才显示 —— 无损和带 gapless 信息的文件这里是 0，不该在状态栏占位置。
   * 显示它是为了让「同一偏移量能对齐所有格式」这件事**看得见**：
   * 换了版本发现数字变了，就知道是文件本身的差异，而不是软件算错了。
   */
  const leadMs = m.sampleRate > 0 ? Math.round(((Number(m.leadSamples) || 0) / m.sampleRate) * 1000) : 0;
  if (leadMs >= 1) parts.push(t('status.audioLead', { ms: leadMs }));
  return parts.join(' · ');
});

/** 当前曲目的音频载入 promise：双击播放要等它 resolve 才有 src */
let audioLoad: Promise<unknown> = Promise.resolve();

/**
 * 当前在听的录音版本。
 *
 * 试听某个具体版本时 `audioState.recId` 指向它；否则就是主录音（顺序里的第一首）——
 * 由主进程的 `currentRecording` 给出，和播放、`track.file_path` 同一个口径，
 * 免得渲染层再自己实现一遍「哪条算主录音」。
 */
const activeRecording = computed<any>(() => {
  const d = detail.value;
  if (!d) return null;
  const list: any[] = d.recordings ?? [];
  const hit = audioState.recId ? list.find((r) => r.id === audioState.recId) : null;
  return hit ?? d.currentRecording ?? null;
});

// 换曲、换版本都要重量一次（这两件事都会让「当前在听的是哪个文件」改变）。
// 必须在 activeRecording 声明**之后**注册：watch 注册时就会跑一次 getter 收集依赖，
// 放在前面会撞 TDZ（`Cannot access 'activeRecording' before initialization`），
// 而且这个错误发生在 smoke 的 console-message 监听装好之前，冒烟看不见。
watch([() => detail.value?.id, () => activeRecording.value?.id], () => void loadAudioMeta());

/**
 * 原点偏移是**逐版本**的。
 * 同一部作品，磁带转录那版前面有三秒走带声，CD 抓轨那版第 1 小节就压在 0.2 秒 ——
 * 拿同一个偏移套两个版本，换一版听播放头就整体偏掉，越到后面偏得越离谱。
 * 一个录音版本都没有的老档案才退回作品级那个值。
 */
const activeOffset = computed(() => {
  const r = activeRecording.value;
  if (r) return Number(r.audioOffsetMs) || 0;
  return Number(detail.value?.analysis?.audioOffsetMs) || 0;
});

/** 喂给网格 / 播放条的 analysis：只把偏移换成当前版本那一份，其余原样 */
const viewAnalysis = computed(() => {
  const a = detail.value?.analysis;
  if (!a) return null;
  const off = activeOffset.value;
  return off === (a.audioOffsetMs ?? 0) ? a : { ...a, audioOffsetMs: off };
});

/* ---- 首选项：界面缩放 / 字体 / 深浅色 / 语言（原设置弹窗，主题切换也搬进来了） ---- */
const showPrefs = ref(false);

/* ---------------- 设置面板的左侧 tab ----------------
 *
 * 面板有 15 个 `.s-sec`，一屏看不下。左边一条 tab 负责「跳到哪一组」，
 * 右边是滚动容器；滚动时高亮跟着走（scroll spy）。
 *
 * 两条容易踩的：
 *   ① `scrollIntoView` 会连带滚动**所有祖先**（整个页面），这里改成自己算 offsetTop 后
 *      `panes.scrollTo({ behavior: 'smooth' })`。
 *   ② 平滑滚动途中会一路经过别的组，spy 会跟着闪 —— 点击后 700ms 内不接管高亮。
 */
const PREF_TABS = [
  { id: 'look', label: 'prefs.tabLook' },
  { id: 'edit', label: 'prefs.tabEdit' },
  { id: 'play', label: 'prefs.tabPlay' },
  { id: 'win', label: 'prefs.tabWin' },
];
const prefsPanes = ref<HTMLElement | null>(null);
const prefsTab = ref('look');
let prefsTabLock = 0;

/* ---- 标题模板预设：官方预设只读，用户预设可增删改 ----
 *
 * 预设存在 localStorage（和跟随 / 增益 / 侧栏留白同一层）：它只影响输入时的候选，
 * 不影响曲库语义，不跨窗口共享，也不该让 data/tracks 多出一份「设置」。
 */
const tplPresetEditingId = ref<string | null>(null);
const tplPresetName = ref('');
const tplPresetScope = ref<TemplateScope>('title');
const tplPresetDraft = ref('');
/**
 * 标题模板变量的图例文字。
 *
 * 日语有独立的一列（`v.ja`）；繁体没有独立列 —— 它跟简中只差字形，
 * 逐字转繁就够，不值得为八个变量再维护一列。
 */
function legendText(v: { zh: string; en: string; ja?: string }) {
  if (locale.value === 'ja') return v.ja ?? v.en;
  if (locale.value === 'en') return v.en;
  if (isHant(locale.value)) return toHant(v.zh);
  return v.zh;
}

/* ---------------- 播放头步长与扫过发声（v0.95） ---------------- */
const FRAME_MODES = [
  { id: 'follow', key: 'prefs.stepFrame.follow' },
  { id: 'auto', key: 'prefs.stepFrame.auto' },
  { id: '30', key: 'prefs.stepFrame.30' },
  { id: '25', key: 'prefs.stepFrame.25' },
] as const;

const SCRUB_SCOPES = [
  { id: 'all', key: 'prefs.scrubScope.all' },
  { id: 'keys', key: 'prefs.scrubScope.keys' },
] as const;

const SCRUB_PRIOS = [
  { id: 'ms', key: 'prefs.scrubPri.ms' },
  { id: 'frames', key: 'prefs.scrubPri.frames' },
] as const;

/** 粗步长按秒展示（内部存毫秒），3 秒显示成 `3.0` */
const coarseSec = () => (stepPrefs.value.coarseMs / 1000).toFixed(1);
const fineMsText = () => String(Math.round(frameStepMs() * 10) / 10);

function setCoarseSec(raw: unknown) {
  const sec = Number(raw);
  if (!Number.isFinite(sec)) return;
  // 下限 0.1 秒：再小就是「一帧」那个键该干的事
  saveStepPrefs({ coarseMs: Math.round(Math.min(60, Math.max(0.1, sec)) * 1000) });
}

function setScrubNum(key: 'scrubMs' | 'scrubFps' | 'scrubFrames', raw: unknown) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  const lim: Record<typeof key, [number, number]> = {
    scrubMs: [0, 2000],
    scrubFps: [1, 240],
    scrubFrames: [1, 240],
  } as never;
  const [lo, hi] = lim[key];
  saveStepPrefs({ [key]: Math.round(Math.min(hi, Math.max(lo, n))) } as never);
}

const tplFontNoteKey = 'prefs.tplFontNote';

const tplPresetMsg = ref('');
const tplPresetBad = ref(false);
/**
 * 模板编辑器里有没有**用户动过、还没保存**的内容。
 *
 * 只由输入事件置真（`@input` / `@change` / TemplateEditor 的 update），
 * 不在 watch 里推断：`editTplPreset` / `resetTplForm` 是程序化赋值，
 * watch 会在它们之后又把它置回真，那个时序很难在代码里一眼看出来。
 */
const tplDirty = ref(false);

function tplMsg(text: string, bad = false) {
  tplPresetMsg.value = text;
  tplPresetBad.value = bad;
}

function resetTplForm() {
  tplPresetEditingId.value = null;
  tplPresetName.value = '';
  tplPresetScope.value = 'title';
  tplPresetDraft.value = '';
  tplDirty.value = false;
  tplMsg('');
}

function editTplPreset(p: TitlePreset) {
  tplPresetEditingId.value = p.builtin ? null : p.id;
  tplPresetName.value = p.builtin ? `${p.name}_custom` : p.name;
  tplPresetScope.value = p.scope;
  tplPresetDraft.value = p.template;
  tplDirty.value = false;
  tplMsg('');
}

function newTplPreset() {
  resetTplForm();
  tplPresetScope.value = 'title';
}

/** 复制预设时的名字：`xxx_copy`，重名就 `xxx_copy_2`（名字是标识符，不进 i18n） */
function copyPresetName(base: string): string {
  const taken = (n: string) => allPresets.value.some((p) => p.name.toLowerCase() === n.toLowerCase());
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i += 1) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now().toString(36)}`;
}

/** 官方预设不改原样，复制一份到编辑器里改名再存 */
function copyTplPreset(p: TitlePreset) {
  editTplPreset(p);
  /*
   * 复制**必须落成新预设**：`editTplPreset` 对用户预设会把 editingId 指回原条目，
   * 那样「复制 → 改名 → 保存」会把原预设改名 / 覆盖掉（用户 2026-11-23 报的隐患）。
   * 名字也顺手换成副本名（官方 `_custom`、用户 `_copy`），否则不改名直接保存会被重名挡住。
   */
  tplPresetEditingId.value = null;
  tplPresetName.value = copyPresetName(p.builtin ? `${p.name}_custom` : `${p.name}_copy`);
  tplMsg(t('prefs.templateCopied'));
}

function saveTplPreset() {
  const name = tplPresetName.value.trim();
  if (!name) return tplMsg(t('prefs.templateNameRequired'), true);
  if (/\s/.test(name)) return tplMsg(t('prefs.templateNameSpace'), true);
  if (isPresetNameTaken(name, tplPresetEditingId.value)) {
    return tplMsg(t('prefs.templateNameTaken'), true);
  }
  if (!tplPresetDraft.value.trim()) return tplMsg(t('prefs.templateEmpty'), true);
  const saved = saveUserPreset({
    id: tplPresetEditingId.value,
    name,
    scope: tplPresetScope.value,
    template: tplPresetDraft.value,
  });
  tplPresetEditingId.value = saved.id;
  tplDirty.value = false;
  tplMsg(t('prefs.templateSaved'));
}

function removeTplPreset(p: TitlePreset) {
  if (p.builtin) return;
  deleteUserPreset(p.id);
  if (tplPresetEditingId.value === p.id) resetTplForm();
  tplMsg(t('prefs.templateDeleted'));
}

/**
 * 关掉选项面板。
 *
 * 其它设置都是即时保存的，只有模板编辑器里可能有「打了字没点保存」的内容。
 * 那种时候先问一句（用户 2026-11-22 的要求：Esc 直接关，但别默默丢掉文本）。
 */
async function closePrefs() {
  if (tplDirty.value) {
    const ok = await confirmDialog(t('prefs.tplDiscardTitle'), t('prefs.tplDiscardBody'));
    if (!ok) return;
    // 「放弃」就真的清空：否则下次打开面板，那段没保存的文字还在编辑器里，
    // 而脏标记已经复位 —— 再关一次不会再问，用户会以为「刚才问过就保住了」。
    resetTplForm();
  }
  showPrefs.value = false;
}

function scrollPrefsTo(id: string) {
  const panes = prefsPanes.value;
  if (!panes) return;
  const el = panes.querySelector<HTMLElement>(`[data-group="${id}"]`);
  if (!el) return;
  prefsTab.value = id;
  prefsTabLock = Date.now() + 700;
  panes.scrollTo({ top: Math.max(0, el.offsetTop - 2), behavior: 'smooth' });
}

function onPrefsScroll() {
  const panes = prefsPanes.value;
  if (!panes || Date.now() < prefsTabLock) return;
  const secs = [...panes.querySelectorAll<HTMLElement>('[data-group]')];
  if (!secs.length) return;
  const y = panes.scrollTop + 6;
  let cur = secs[0].dataset.group ?? 'look';
  for (const sec of secs) if (sec.offsetTop <= y) cur = sec.dataset.group ?? cur;
  // 滚到底时锁定最后一组：不然最后那一两个矮块永远高亮不到
  if (panes.scrollTop + panes.clientHeight >= panes.scrollHeight - 4) {
    cur = secs[secs.length - 1].dataset.group ?? cur;
  }
  prefsTab.value = cur;
}

/**
 * 波形缓存：上限（MB）与当前占用。
 *
 * 上限是**每一层各自**的预算（内存、磁盘），因为两层的成本不同：
 * 内存贵在占用、磁盘贵在容量，合成一个池子反而说不清「关掉到底省了什么」。
 */
const WAVE_LIMITS = [0, 32, 64, 128, 256];
const waveLimit = ref<number>(readLimitMb());
const waveUse = ref<any>({ memItems: 0, memBytes: 0, diskFiles: 0, diskBytes: 0 });

function fmtMB(bytes: number) {
  const mb = (Number(bytes) || 0) / 1024 / 1024;
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1);
}
const waveUseText = computed(() =>
  t('prefs.waveUse', {
    mem: fmtMB(waveUse.value.memBytes),
    disk: fmtMB(waveUse.value.diskBytes),
    limit: waveLimit.value,
  })
);

async function refreshWaveUse() {
  try {
    waveUse.value = await waveStats();
  } catch {
    /* 统计失败不该挡住设置面板 */
  }
}
function applyWaveLimit(mb: number) {
  waveLimit.value = mb;
  saveWaveLimit(mb);
  void refreshWaveUse();
}
async function clearWave() {
  const n = await clearWaveCache();
  message.value = { key: 'msg.waveCleared', vars: { n } };
  void refreshWaveUse();
}
/* 打开选项面板时刷新一次占用：数字必须是「现在的」，不能是上次关面板时的 */
watch(showPrefs, (v) => {
  if (v) void refreshWaveUse();
});

/**
 * 播放中单击录音版本，要怎么办。
 *
 * 「单击 = 切到这一版」在不播放时没有歧义；一旦正在播放，四种做法各有各的道理，
 * 没有哪一种是普适的：语义统一（暂停）会打断听感，无缝换版（接着播）会突然从头响，
 * 延后切换不打断但界面短暂自相矛盾，禁止切换最安全但「点不动」。
 * 所以做成首选项让用户自己定一次，默认选语义最一致的那个（暂停并切）。
 */
type ClickVersionMode = 'pause' | 'play' | 'defer' | 'ignore';
const CLICK_VERSION_MODES: { id: ClickVersionMode; key: string }[] = [
  { id: 'pause', key: 'prefs.vcPause' },
  { id: 'play', key: 'prefs.vcPlay' },
  { id: 'defer', key: 'prefs.vcDefer' },
  { id: 'ignore', key: 'prefs.vcIgnore' },
];

function readClickVersionMode(): ClickVersionMode {
  try {
    const v = localStorage.getItem('ma-version-click');
    if (v === 'play' || v === 'defer' || v === 'ignore') return v;
  } catch {
    /* 隐私模式读不到，用默认值 */
  }
  return 'pause';
}
const clickVersionMode = ref<ClickVersionMode>(readClickVersionMode());
/** defer 模式：播放中点了哪一版，等暂停/播完再真正切过去 */
const pendingRecId = ref<string | null>(null);

function setClickVersionMode(m: ClickVersionMode) {
  clickVersionMode.value = m;
  try {
    localStorage.setItem('ma-version-click', m);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  // 换模式之后，攒着的「待切换版本」不该再默默生效
  pendingRecId.value = null;
}

/**
 * 两个纯显示层的首选项：网格自己读 localStorage，改动靠自定义事件通知。
 *
 * 为什么不放进主进程 / 库：它们不影响解析结果，也不跨窗口共享语义 ——
 * 写进库反而会引出「切开关要不要重算 parsed」这种本不存在的麻烦。
 */
type FollowSelMode = 'on' | 'quiet' | 'off';
const FOLLOW_SEL_MODES: { id: FollowSelMode; key: string }[] = [
  { id: 'on', key: 'prefs.fsOn' },
  { id: 'quiet', key: 'prefs.fsQuiet' },
  { id: 'off', key: 'prefs.fsOff' },
];

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

/** 布尔偏好：'1' / '0'，读不到就用默认（隐私模式下 localStorage 会抛） */
function readBool(key: string, dflt: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch {
    /* 读不到就用默认 */
  }
  return dflt;
}
/** 拖动播放头时选中所在和弦（独立于「播放时跟随」那三档） */
const scrubPick = ref(readBool('ma-scrub-pick', true));
/** 选区动画：低配机器可以关 */
const selAnim = ref(readBool('ma-sel-anim', true));
/** 粘贴会覆盖内容时先确认 */
const pasteWarn = ref(readBool('ma-paste-warn', true));
/**
 * 每次退出级数标记的输入态就自动补低音。
 *
 * 默认**关** —— 它会改写已有低音（和弦一改旧低音就跟着变），自动改数据不该替用户点头。
 * 和网格里「低音行标签右键菜单」的勾选项是同一个键，两边都能开关。
 */
const bassAutofill = ref(readBool('ma-bass-autofill', false));
/** 级数写完顺手生成字母和弦（V7 → G7）：与低音填充同一套开关，默认关 */
const chordAutofill = ref(readBool('ma-chord-autofill', false));
/** 级数写完顺手生成斯波索宾标记：自动只跟级数（字母和弦反推级数不可靠） */
const sposobinAutofill = ref(readBool('ma-sposobin-autofill', false));
/**
 * 启动时自动打开「动态操作帮助」窗口（和歌词播报器同一时机：主窗口完全启动之后）。
 * 默认开 —— 这窗口就是给新手看手势的，藏着不如打开；嫌挡可以在窗口里关掉置顶或直接关窗。
 */
const helpAutoOpen = ref(readBool('ma-help-auto', true));

/**
 * 撤销历史的两个数字：
 *   limit   = 运行期最多保留多少步（0 = 无限）
 *   persist = 关软件时写盘最近多少条（全局算）
 * 真相在主进程，这里只是设置界面 + 把它们推过去。
 */
/** 已保存的工作区名字（菜单里直接列出来，点一下即应用） */
const wsNames = ref<string[]>([]);
const wsSaveOpen = ref(false);
const wsSaveName = ref('');

/** 当前布局里「渲染层负责」的那一半（窗口位置由主进程自己抓） */
async function currentUi() {
  const ma = (window as any).__ma;
  let uiZoom = 1;
  try {
    uiZoom = Number(await api.ui.getZoom()) || 1;
  } catch {
    /* 拿不到就按 1 记 */
  }
  return {
    panelOpen: panelOpen.value,
    panelH: panelH.value,
    leftW: leftW.value,
    rightW: rightW.value,
    // 整体收起也记：只记宽度的话，下次恢复会把「收起来的栏」又展开
    leftCollapsed: leftCollapsed.value,
    rightCollapsed: rightCollapsed.value,
    uiZoom,
    themeMode: themeMode.value,
    viewId: viewId.value,
    gridZoom: Number(ma?.zoom?.() ?? 1) || 1,
    gridUnit: gridUnit.value,
  };
}

function refreshWsList() {
  void api.ws
    ?.list?.()
    .then((st: any) => {
      wsNames.value = Array.isArray(st?.names) ? st.names : [];
    })
    .catch(() => {
      wsNames.value = [];
    });
}

function openWsSave() {
  wsSaveName.value = '';
  wsSaveOpen.value = true;
  void nextTick(() => document.querySelector<HTMLInputElement>('.ws-name-input')?.focus());
}

async function confirmWsSave() {
  const name = wsSaveName.value.trim();
  if (!name) return;
  try {
    const ui = await currentUi();
    await api.ws.save({ name, ui });
    wsSaveOpen.value = false;
    refreshWsList();
  } catch (e) {
    console.error('[ws] 保存工作区失败', e);
  }
}

/**
 * 把一份布局的「窗口内部」应用回来。
 *
 * 窗口位置/大小/最大化由主进程负责（只有它读得到），这里只管面板、栏宽、缩放、
 * 主题、泳道方案、网格缩放 —— 每一样都要顺手写回 localStorage，
 * 否则下次冷启动又变回旧值（工作区只在内存里生效了）。
 */
async function applyUiFields(ui: any, opts?: { theme?: boolean; geometry?: boolean }) {
  if (!ui) return;
  /**
   * `geometry: false` = 只回来「显示方式」（泳道方案 / 格单位 / 网格缩放），
   * 面板宽高与界面缩放**不碰**。
   *
   * 启动时就是这么调的：几何的唯一真相是 config.json 的 `layout`（用户 2026-11-22 的要求），
   * 工作区只是「手动套用」时才连几何一起改。否则每次启动都会被上次存的工作区把手拖的宽度盖掉，
   * 而且那句 `setZoom(1)` 还会在启动后延迟几十毫秒才执行，看起来像「缩放自己跳回去了」。
   */
  const geo = opts?.geometry !== false;
  if (geo) {
    panelOpen.value = ui.panelOpen !== false;
    // 夹到当前窗口允许的上限：工作区可能是在大屏（或最大化的窗口）里存的，
    // 换到小窗直接套用会让面板把表格挤没
    panelH.value = Math.min(Number(ui.panelH) || panelH.value, maxPanelH());
    leftW.value = clampW(Number(ui.leftW) || leftW.value, LEFT_FLOOR, LEFT_MAX);
    rightW.value = clampW(Number(ui.rightW) || rightW.value, RIGHT_MIN, RIGHT_MAX);
    if (typeof ui.leftCollapsed === 'boolean') leftCollapsed.value = ui.leftCollapsed;
    if (typeof ui.rightCollapsed === 'boolean') rightCollapsed.value = ui.rightCollapsed;
    persistCollapsed();
    try {
      localStorage.setItem('ma-panel-open', panelOpen.value ? '1' : '0');
      localStorage.setItem('ma-panel-h', String(panelH.value));
      localStorage.setItem('ma-left-w', String(leftW.value));
      localStorage.setItem('ma-right-w', String(rightW.value));
    } catch {
      /* 隐私模式写不了，本次会话生效即可 */
    }
  }
  gridUnit.value = (['bar', 'beat', 'half'] as const).includes(ui.gridUnit) ? ui.gridUnit : gridUnit.value;
  if (typeof ui.viewId === 'string' && ui.viewId) viewId.value = ui.viewId;
  /**
   * 主题只在**显式切换工作区**时跟着换。
   *
   * 启动时「还原上次布局」刻意不碰它：主题模式已经是用户偏好（`ma-theme-mode`），
   * 而 `last` 里的那份可能差 2.5 秒（写盘防抖）—— 改了主题立刻关软件，
   * 下次启动就会被旧值顶回去。布局归布局，偏好归偏好。
   */
  if (opts?.theme !== false && ui.themeMode) await setThemeMode(ui.themeMode);
  if (geo && Number(ui.uiZoom) > 0) void api.ui.setZoom(Number(ui.uiZoom));
  applyGridZoomWhenReady(Number(ui.gridZoom));
  // 工作区套用之后的面板尺寸同样要落进 config.json，否则下次启动又回旧值
  if (geo) pushPanelSizes();
}

/**
 * 网格自己的缩放只有 GridEditor 挂载后才有 `__ma`。
 *
 * 启动时「还原上次布局」跑在首帧之前，那会儿它还不存在 —— 短轮询几次，
 * 而不是把这个值丢掉（丢掉就是「工作区记了缩放，重启后没生效」）。
 */
function applyGridZoomWhenReady(z: number, tries = 12) {
  if (!(z > 0)) return;
  const ma = (window as any).__ma;
  if (ma?.setZoom) {
    ma.setZoom(z);
    return;
  }
  if (tries <= 0) return;
  setTimeout(() => applyGridZoomWhenReady(z, tries - 1), 80);
}

async function applyWorkspace(name?: string) {
  try {
    const r = await api.ws.apply(name);
    if (r?.ok) await applyUiFields(r.ui);
  } catch (e) {
    console.error('[ws] 应用工作区失败', e);
  }
}

/** 字段变了就把「上次布局」更新一份（防抖 2.5s，写盘不频繁） */
let wsLastTimer: any = null;
function touchLastLayout() {
  clearTimeout(wsLastTimer);
  wsLastTimer = setTimeout(async () => {
    try {
      const ui = await currentUi();
      await api.ws.save({ ui });
    } catch {
      /* 记不住就记不住，不影响使用 */
    }
  }, 2500);
}

/** 「为作者提供经济支持」弹窗：收款码由主进程从 assets 里按文件名找出来 */
/**
 * 「鼠标停在哪个区域」→ 帮助窗口据此换提示。
 *
 * 用 document 级的 `pointerover`（它会冒泡）而不是给每块挂 enter/leave：
 * 嵌套区域（搜索行在列表里、工具栏在面板里）用 enter/leave 会互相打架 ——
 * 从子元素退回父元素时子元素发 leave，父元素却不会再发 enter，hover 就卡住了。
 * `closest` 一劳永逸，而且天然支持以后往模板里加新的 `data-help-region`。
 */
function regionAt(el: EventTarget | null): string | null {
  const node = (el as Element | null)?.closest?.('[data-help-region]') as HTMLElement | null;
  return node?.dataset?.helpRegion ?? null;
}

function onHelpPointerOver(ev: PointerEvent) {
  setHoverRegion(regionAt(ev.target));
}

/** 指针离开整个窗口才算「不在任何区域」（窗口内部元素之间移动时 relatedTarget 不为空） */
function onHelpPointerOut(ev: PointerEvent) {
  if (!ev.relatedTarget) setHoverRegion(null);
}

const supportOpen = ref(false);
const supportQrs = ref<{ key: string; label: string; file: string; width: number; height: number; dataUrl: string }[]>([]);

async function openSupport() {
  supportOpen.value = true;
  try {
    supportQrs.value = (await api.support?.qrs?.()) ?? [];
  } catch {
    supportQrs.value = [];
  }
}

const undoLimit = ref(Number(localStorage.getItem('ma-undo-limit')) || 0);
const undoPersist = ref(Number(localStorage.getItem('ma-undo-persist')) || 50);
function applyUndoConfig() {
  const limit = Math.max(0, Math.floor(Number(undoLimit.value) || 0));
  const persist = Math.max(1, Math.floor(Number(undoPersist.value) || 50));
  undoLimit.value = limit;
  undoPersist.value = persist;
  try {
    localStorage.setItem('ma-undo-limit', String(limit));
    localStorage.setItem('ma-undo-persist', String(persist));
  } catch {
    /* 隐私模式写不了就只在本次会话生效 */
  }
  void api.history?.config?.({ limit, persist });
}
/** 拖播放头划过空格子时清空选区（默认开）。只在「拖动播放头时选中所在和弦」打开时有意义 */
const scrubClearEmpty = ref(readBool('ma-scrub-empty', true));

function saveBool(key: string, val: boolean, prefsKey: string) {
  try {
    localStorage.setItem(key, val ? '1' : '0');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: prefsKey } }));
}

function setFollowSel(m: FollowSelMode) {
  followSel.value = m;
  try {
    localStorage.setItem('ma-follow-sel', m);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'followSel' } }));
}

type FigureStyle = 'lenient' | 'strict' | 'ignore';
const FIGURE_STYLES: { id: FigureStyle; key: string }[] = [
  { id: 'lenient', key: 'prefs.figLenient' },
  { id: 'strict', key: 'prefs.figStrict' },
  { id: 'ignore', key: 'prefs.figIgnore' },
];

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

function setFigureStyle(m: FigureStyle) {
  figureStyle.value = m;
  try {
    localStorage.setItem('ma-figure-style', m);
  } catch {
    /* 同上 */
  }
  window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'figureStyle' } }));
}
/**
 * 界面语言在 i18n.ts 里统一管理（localStorage['ma-lang'] + <html lang> + 通知主进程）。
 * 组件里只要调 t()，切语言时所有用过它的地方会一起重渲染。
 */
const showHelp = ref(false);
const searchEl = ref<HTMLInputElement | null>(null);
/** 曲名行内编辑中的曲目 id（登记作品后自动进这态，右键曲名也能进） */
const editRowId = ref<string | null>(null);
/**
 * 进入改名态时怎么处理已有文字：全选（普通改名）/ 光标落到末尾（新乐章）。
 * 新乐章默认标题是「第三乐章」/「III.」，用户要接着往后补术语，不能一进输入框就全选覆盖。
 */
const editCaretEnd = ref(false);
/** 新乐章的默认前缀（只给补全逻辑判断「前缀之后才是要补的段」，不限制用户编辑） */
const editPrefix = ref<string | null>(null);
const uiZoom = ref(1);
/* 默认无衬线：等宽做整界面在中文与长备注里太挤；等宽仍可在设置里切回。
   老版本把 mono 写进过 localStorage，这里做一次迁移，否则用户看不到默认变了。 */
const FONT_VER = '2';
if (localStorage.getItem('ma-font-ver') !== FONT_VER) {
  localStorage.setItem('ma-font', 'ui');
  localStorage.setItem('ma-font-ver', FONT_VER);
}
const uiFont = ref<'mono' | 'ui'>((localStorage.getItem('ma-font') as any) ?? 'ui');
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/* ---- 歌词播报器 / 桌面歌词选项 ---- */
const lyricsAutoOpen = ref(localStorage.getItem('ma-lyrics-auto') !== '0');
/* ---- 启动配置（userData/config.json） ----
 * 歌词 / 帮助的自动打开、安全模式都以文件为准；localStorage 只用于旧版本迁移。
 */
const safeMode = ref(false);
const configPath = ref('');
const configParseError = ref<string | null>(null);
const configError = ref<string | null>(null);
const configBusy = ref(false);
const desktopEnable = ref(localStorage.getItem('ma-desktop') === '1');
const desktopStyle = ref({ size: 34, opacity: 0.95, color: 'white' as 'white' | 'accent' | 'warm', next: true });
const desktopOpacityPct = ref(Math.round(desktopStyle.value.opacity * 100));
const desktopColors = [
  { id: 'white', label: t('prefs.colorWhite') },
  { id: 'accent', label: t('prefs.colorAccent') },
  { id: 'warm', label: t('prefs.colorWarm') },
];
/** 桌面歌词样式：从主进程读一次，之后本地改 + 推 */
async function loadDesktopStyle() {
  try { desktopStyle.value = await api.lyrics.style(); } catch { /* 默认 */ }
  desktopOpacityPct.value = Math.round(desktopStyle.value.opacity * 100);
}
function syncDesktopStyle() {
  void api.lyrics.setStyle(desktopStyle.value);
}
function onDesktopOpacity() {
  desktopStyle.value.opacity = desktopOpacityPct.value / 100;
  syncDesktopStyle();
}
function setDesktopColor(c: string) {
  desktopStyle.value.color = c as any;
  syncDesktopStyle();
}
function syncDesktopEnable() {
  localStorage.setItem('ma-desktop', desktopEnable.value ? '1' : '0');
  if (desktopEnable.value) void api.win.openOverlay();
  else void api.win.closeOverlay();
}

/**
 * 启动配置：读一次 config.json。
 * 文件是这次启动才生成的（fresh）时，把旧版 localStorage 里的自动打开偏好搬进去 ——
 * 老版本把「帮助自动打开」存在渲染层，直接忽略会让用户的设置悄悄回到默认值。
 */
async function loadAppConfig() {
  try {
    let cfg = await api.config.get();
    if (cfg.fresh) {
      const oldLyrics = localStorage.getItem('ma-lyrics-auto');
      const oldHelp = localStorage.getItem('ma-help-auto');
      if (oldLyrics !== null || oldHelp !== null) {
        cfg = await api.config.update({
          startup: {
            lyrics: oldLyrics !== null ? oldLyrics !== '0' : cfg.startup.lyrics,
            help: oldHelp !== null ? oldHelp !== '0' : cfg.startup.help,
          },
        });
        // 写盘成功才删旧键：失败时留着，下次启动还能再迁一次
        localStorage.removeItem('ma-lyrics-auto');
        localStorage.removeItem('ma-help-auto');
      }
    }
    lyricsAutoOpen.value = cfg.startup.lyrics;
    helpAutoOpen.value = cfg.startup.help;
    safeMode.value = cfg.safeMode;
    configPath.value = cfg.path;
    configParseError.value = cfg.parseError;
  } catch (e) {
    console.error('[config] 读取启动配置失败', e);
    configError.value = e instanceof Error ? e.message : String(e);
  }
}

async function saveStartupConfig(patch: any) {
  configBusy.value = true;
  try {
    const cfg = await api.config.update(patch);
    lyricsAutoOpen.value = cfg.startup.lyrics;
    helpAutoOpen.value = cfg.startup.help;
    safeMode.value = cfg.safeMode;
    configPath.value = cfg.path;
    configParseError.value = cfg.parseError;
    configError.value = null;
  } catch (e) {
    configError.value = e instanceof Error ? e.message : String(e);
    // 写盘失败：把界面上的开关拉回文件里的真实值，别让用户以为已经存上了
    void loadAppConfig();
  } finally {
    configBusy.value = false;
  }
}
function saveLyricsAuto() {
  void saveStartupConfig({ startup: { lyrics: lyricsAutoOpen.value } });
}
function saveHelpAuto() {
  void saveStartupConfig({ startup: { help: helpAutoOpen.value } });
}
function saveSafeMode() {
  void saveStartupConfig({ safeMode: safeMode.value });
}
function openConfigFile() {
  void api.config.openFile();
}

async function applyZoom(z: number) {
  // 用 Chromium 原生缩放：文字与 canvas 一起变大且保持清晰，不是位图拉伸
  const v = Math.min(2, Math.max(0.8, Math.round(z * 100) / 100));
  uiZoom.value = await api.ui.setZoom(v);
  localStorage.setItem('ma-zoom', String(uiZoom.value));
}

function applyFont(f: 'mono' | 'ui') {
  uiFont.value = f;
  // 两种都显式写 data-font：tokens.css 里 mono 才覆盖，其余按默认（无衬线）
  document.documentElement.dataset.font = f;
  localStorage.setItem('ma-font', f);
  // 换了字族，字宽就变了 —— 侧栏下限要跟着重算（见 measureSideMinW）
  void nextTick(measureSideMinW);
}

function onZoomKey(ev: KeyboardEvent) {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  if (ev.key.toLowerCase() === 'j') {
    ev.preventDefault();
    togglePanel();
    return;
  }
  if (ev.key === '=' || ev.key === '+') {
    ev.preventDefault();
    applyZoom(uiZoom.value + 0.1);
  } else if (ev.key === '-') {
    ev.preventDefault();
    applyZoom(uiZoom.value - 0.1);
  } else if (ev.key === '0') {
    ev.preventDefault();
    applyZoom(1);
  }
}

const currentView = computed(() => meta.value?.views.find((v: any) => v.id === viewId.value) ?? null);

/** 全局快捷键：菜单上的加速键是真的绑定，不只是写给人看的标签 */
function onGlobalKey(ev: KeyboardEvent) {
  const mod = ev.ctrlKey || ev.metaKey;
  /**
   * 选项面板是整屏遮罩，Esc 先收它（用户 2026-11-22 的要求）。
   * 模板编辑器有未保存文本时 `closePrefs` 会先弹确认框；
   * 那个框自己吃掉 Esc（`onConfirmKey`），所以这里的 Esc 不会再传下去。
   */
  if (ev.key === 'Escape' && showPrefs.value && !confirmBox.value) {
    ev.preventDefault();
    void closePrefs();
    return;
  }
  if (ev.key === 'Escape' && ctxMenu.value) {
    ev.preventDefault();
    ctxMenu.value = null;
    return;
  }
  // 确认窗口比元数据面板更靠上：Esc 先收它，再收面板
  if (ev.key === 'Escape' && metaApply.value) {
    ev.preventDefault();
    metaApply.value = null;
    return;
  }
  // 元数据面板也归「Esc 关掉最上面那层」——它盖住了整个界面，只靠点遮罩太窄
  if (ev.key === 'Escape' && metaTarget.value) {
    ev.preventDefault();
    metaTarget.value = null;
    return;
  }
  // Esc 也收掉钉住的 ⓘ 气泡：它是个浮层，用户的预期就是「Esc 关掉最上面那层」
  if (ev.key === 'Escape' && meterTip.value) {
    ev.preventDefault();
    closeMeterTip();
    return;
  }
  /**
   * 焦点在输入框里时，这几个「会改变界面/数据」的组合键一律让路。
   * Ctrl+R 尤其危险：它会新建一个空作品并把选中项切走 —— 正在编辑的输入框随组件卸载，
   * 敲的字全丢，而且用户完全不知道刚才发生了什么。Ctrl+F / Ctrl+J 同理（焦点被抢走）。
   * 纯 UI 类的（F1 / Ctrl+, / 缩放）不用放行，它们不打断输入。
   */
  if (isEditableTarget(ev.target)) {
    const k = ev.key.toLowerCase();
    if (mod && (k === 'r' || k === 'f' || k === 'j' || k === 'n' || k === 'b' || k === 'd')) return;
  }
  // Ctrl+B / Ctrl+D：左侧栏 / 详情栏展开收起（和视图菜单同一个开关，见 RULES 第 25 条）
  if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'b') {
    ev.preventDefault();
    toggleLeftSide();
    return;
  }
  if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'd') {
    ev.preventDefault();
    toggleRightSide();
    return;
  }
  if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'n') {
    ev.preventDefault();
    void newPlaylist();
    return;
  }
  if (mod && !ev.shiftKey && ev.key.toLowerCase() === 'r') {
    ev.preventDefault();
    void registerWork();
    return;
  }
  if (mod && ev.shiftKey && ev.key.toLowerCase() === 'h') {
    // Ctrl+Shift+H = 历史记录窗口（视图菜单里那条的加速键）
    ev.preventDefault();
    void api.history?.toggle?.();
    return;
  }
  if (mod && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    if (ev.shiftKey) clearSearch();
    else focusSearch();
    return;
  }
  if (mod && ev.key === ',') {
    ev.preventDefault();
    showPrefs.value = true;
    return;
  }
  if (ev.key === 'F1') {
    ev.preventDefault();
    showHelp.value = true;
    return;
  }
  onZoomKey(ev);
}

/** 子窗口转来的快捷键的退订函数（onMounted 挂、卸载时退，否则反复挂载会叠出多个监听） */
let offHotkey: (() => void) | null = null;

/* ---------------- 菜单栏 ---------------- */

/** 网格内部的能力（撤销/删除/格单位）由 GridEditor 挂到 window.__ma 上，菜单直接调 */
function ma(): any {
  return (window as any).__ma ?? null;
}

const menus = computed<any[]>(() => {
  const hasAnalysis = !!detail.value?.analysis;
  return [
    {
      label: t('menu.file'),
      mnemonic: 'F',
      items: [
        { label: t('menu.file.register'), accel: 'Ctrl+R', action: 'register' },
        /* 删除只是「归档」（文件进 data/tracks/.archive），彻底删除在「维护」里。
           放在文件菜单、紧接登记下面：它作用的对象是「这份作品」，跟「新建」同一族；
           刻意不给加速键 —— 会毁东西的动作不该和 Ctrl+Z 一样顺手。 */
        {
          label: t('menu.file.removeTrack'),
          action: 'remove-track',
          disabled: !selectedId.value,
        },
        { label: t('menu.file.newPlaylist'), accel: 'Ctrl+N', action: 'new-playlist' },
        { separator: true },
        { label: t('menu.file.quit'), accel: 'Alt+F4', action: 'quit' },
      ],
    },
    {
      label: t('menu.edit'),
      mnemonic: 'E',
      items: [
        { label: t('menu.edit.undo'), accel: 'Ctrl+Z', action: 'undo', disabled: !hasAnalysis || !histMenu.value.undo },
        { label: t('menu.edit.redo'), accel: 'Ctrl+Y', action: 'redo', disabled: !hasAnalysis || !histMenu.value.redo },
        { separator: true },
        // 全局那两个不看当前曲目：它撤的是「全局最后一步」，可能落在别的曲子上
        { label: t('menu.edit.undoGlobal'), accel: 'Ctrl+Shift+Z', action: 'undo-global', disabled: !histMenu.value.gUndo },
        { label: t('menu.edit.redoGlobal'), accel: 'Ctrl+Shift+Y', action: 'redo-global', disabled: !histMenu.value.gRedo },
        { separator: true },
        { label: t('menu.edit.deleteSel'), accel: 'Delete', action: 'delete-sel', disabled: !hasAnalysis },
        { label: t('menu.edit.clearSel'), accel: 'Esc', action: 'clear-sel', disabled: !hasAnalysis },
        { separator: true },
        {
          label: t('menu.edit.rename'),
          accel: t('menu.edit.renameAccel'),
          action: 'rename-current',
          disabled: !selectedId.value,
        },
      ],
    },
    {
      label: t('menu.view'),
      mnemonic: 'V',
      items: [
        { label: t('menu.view.panel'), accel: 'Ctrl+J', action: 'toggle-panel', checked: panelOpen.value },
        /* 两根侧栏的展开收起。Ctrl+D 取 Detail 的首字母 —— 用户嫌 Ctrl+Alt+B 单手按着难受 */
        {
          label: t('menu.view.leftSidebar'),
          accel: 'Ctrl+B',
          action: 'toggle-left-sidebar',
          checked: !leftCollapsed.value,
        },
        {
          label: t('menu.view.rightSidebar'),
          accel: 'Ctrl+D',
          action: 'toggle-right-sidebar',
          checked: !rightCollapsed.value,
        },
        { separator: true },
        { label: t('menu.view.popout'), action: 'popout', disabled: !selectedId.value },
        { separator: true },
        { label: t('menu.view.lyrics'), action: 'open-lyrics' },
        { label: t('menu.view.desktopLyrics'), action: 'open-overlay' },
        // 网格底部那条说明栏已经删掉：手势说明搬进这个独立窗口（默认置顶，可关）
        { label: t('menu.view.actionHelp'), action: 'action-help', checked: helpOpen.value },
        { label: t('menu.view.history'), accel: 'Ctrl+Shift+H', action: 'history', checked: historyOpen.value },
        { separator: true },
        {
          label: t('menu.view.unitBar'),
          action: 'unit-bar',
          checked: gridUnit.value === 'bar',
          disabled: !hasAnalysis,
        },
        {
          label: t('menu.view.unitBeat'),
          action: 'unit-beat',
          checked: gridUnit.value === 'beat',
          disabled: !hasAnalysis,
        },
        {
          label: t('menu.view.unitHalf'),
          action: 'unit-half',
          checked: gridUnit.value === 'half',
          disabled: !hasAnalysis,
        },
        { separator: true },
        { label: t('menu.view.zoomIn'), accel: 'Ctrl+=', action: 'zoom-in' },
        { label: t('menu.view.zoomOut'), accel: 'Ctrl+-', action: 'zoom-out' },
        { label: t('menu.view.zoomReset'), accel: 'Ctrl+0', action: 'zoom-reset' },
      ],
    },
    {
      label: t('menu.search'),
      mnemonic: 'S',
      items: [
        { label: t('menu.search.focus'), accel: 'Ctrl+F', action: 'focus-search' },
        { label: t('menu.search.clear'), accel: 'Ctrl+Shift+F', action: 'clear-search' },
      ],
    },
    {
      // 独立顶级菜单（用户要求排在「选项」左边）：保存/切换布局
      label: t('menu.ws'),
      mnemonic: 'W',
      items: [
        { label: t('menu.ws.save'), action: 'ws-save' },
        ...(wsNames.value.length ? [{ separator: true }] : []),
        ...wsNames.value.map((n) => ({ label: n, action: `ws-apply:${n}` })),
        ...(wsNames.value.length ? [{ separator: true }] : []),
        { label: t('menu.ws.last'), action: 'ws-last' },
      ],
    },
    {
      // 没有 items：点一下直接进选项界面，不再多一层「首选项…」子菜单
      label: t('menu.options'),
      mnemonic: 'O',
      action: 'prefs',
    },
    {
      label: t('menu.maintenance'),
      mnemonic: 'M',
      items: [
        { label: t('menu.maintenance.orphans'), action: 'orphans' },
        { label: t('menu.maintenance.archive'), action: 'archive' },
        { separator: true },
        { label: t('menu.maintenance.openData'), action: 'open-data' },
        { label: t('menu.support'), action: 'support' },
      ],
    },
    {
      label: t('menu.help'),
      mnemonic: 'H',
      items: [
        // 和「视图」菜单里那条是同一个开关，两处都能开
        { label: t('menu.help.actionHelp'), action: 'action-help', checked: helpOpen.value },
        { label: t('menu.help.shortcuts'), accel: 'F1', action: 'shortcuts' },
        { label: t('menu.support'), action: 'support' },
        { label: t('menu.help.about'), action: 'about' },
      ],
    },
  ];
});

function focusSearch() {
  searchEl.value?.focus();
  searchEl.value?.select();
}

function clearSearch() {
  text.value = '';
  filterTags.value = [];
  closeSuggest();
  loadRows();
}

/* ---------------- 搜索补全 ----------------
 *
 * 补的是**正在敲的那个词**，不是整句：搜索是「词之间 AND」，
 * 用户敲到一半的永远是最后一个片段，把整句替换掉反而是灾难。
 * 候选来自词表（乐器 / 演奏技法 / 作曲技法）+ 情绪 + 时期 ——
 * 这几类都是「想不起来叫什么」的时候最需要的，而曲名/作曲家直接敲就行。
 */
const suggestions = ref<any[]>([]);
const sugOpen = ref(false);
const sugIndex = ref(-1);
let sugTimer: any = null;

/** 末尾那个还没写完的词；已经敲了空格就说明该说下一个词了 */
function tailToken(s: string) {
  const m = /(?:^|\s)(\S+)$/.exec(s);
  return m ? m[1] : '';
}

function closeSuggest() {
  sugOpen.value = false;
  sugIndex.value = -1;
  suggestions.value = [];
}

function sugLabel(s: any) {
  return locale.value === 'en' ? (s.en || s.label) : s.label;
}

function sugHint(s: any) {
  if (s.kind === 'tag') return dimLabel(s.dim);
  // 流派 / 情绪 / 时期：告诉用户这条候选能限定哪个字段，不然「爵士」看着像标签
  if (s.kind === 'genre' || s.kind === 'mood' || s.kind === 'period') return t(`dim.${s.kind}`);
  return '';
}

watch(text, (v) => {
  clearTimeout(sugTimer);
  sugIndex.value = -1;
  const token = tailToken(v);
  if (!token) {
    closeSuggest();
    return;
  }
  sugTimer = setTimeout(async () => {
    const list = await api.search.suggest(token);
    // 回来时用户可能已经接着敲了：词对不上就丢掉，别把旧候选贴到新输入上
    if (tailToken(text.value) !== token) return;
    // 搜索词也可能是别处设的（菜单清除 / 冒烟钩子）：没在输入框里就不弹
    if (document.activeElement !== searchEl.value) return;
    suggestions.value = Array.isArray(list) ? list : [];
    sugOpen.value = suggestions.value.length > 0;
  }, 110);
});

function applySuggestion(s: any) {
  const v = text.value;
  const m = /(?:^|\s)(\S+)$/.exec(v);
  const head = m ? v.slice(0, v.length - m[1].length) : v;
  // 补完跟一个空格：搜索是按空格分词的，用户接着敲下一个词就很顺
  text.value = `${head}${s.insert} `;
  closeSuggest();
  void nextTick(() => searchEl.value?.focus());
}

function onSearchKey(ev: KeyboardEvent) {
  // 组合期：↑↓ 是输入法翻页、Enter 是确认候选词，一个都不能拦
  if (isComposing(ev)) return;
  if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && suggestions.value.length) {
    ev.preventDefault();
    sugOpen.value = true;
    const n = suggestions.value.length;
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    sugIndex.value = (sugIndex.value + step + n) % n;
    return;
  }
  if (ev.key === 'Enter' && sugOpen.value && sugIndex.value >= 0) {
    ev.preventDefault();
    const hit = suggestions.value[sugIndex.value];
    if (hit) applySuggestion(hit);
    return;
  }
  if (ev.key === 'Escape' && sugOpen.value) {
    ev.preventDefault();
    ev.stopPropagation();
    closeSuggest();
  }
}

function onSearchFocus() {
  if (suggestions.value.length) sugOpen.value = true;
}

/** 别在 mousedown 之前收：下拉项自己就是 mousedown 触发的 */
function onSearchBlur() {
  setTimeout(() => (sugOpen.value = false), 120);
}

/** 登记作品：建空曲目 → 选中 → 曲名直接进输入态 */
async function registerWork() {
  // 默认曲名跟着界面语言走：它只是占位，用户马上就会改
  const r = await api.tracks.create({ title: t('track.untitled') });
  await loadRows();
  void loadPlaylists();
  await select(r.id);
  editRowId.value = r.id;
  editCaretEnd.value = false;
  editPrefix.value = null;
  message.value = { key: 'msg.registered' };
}

async function renameRow(payload: { id: string; title: string }) {
  const r = await api.tracks.rename(payload.id, payload.title);
  editRowId.value = null;
  editCaretEnd.value = false;
  editPrefix.value = null;
  if (!r) return;
  await loadRows();
  // `renameTrack` 只回 `{ id, title }`：是不是乐章、字段现在是什么，都要整行
  const cur = await api.tracks.get(r.id);
  if (selectedId.value === r.id) detail.value = cur;
  if (!cur?.parentId) return;

  /*
   * 乐章标题里写下的**真正的术语**要同步回字段（用户 2026-11-23）：
   * 在列表树里打「第二乐章 小步舞曲 - 小快板」，详情页的 Sub-Type / Tempo term
   * 不该还是空的 —— 标题是模板，字段才是数据。带 `%` 的段（还是变量）不动。
   */
  await loadMovementLabels(); // 术语表可能还在路上，等它到再认
  const fields = termsFromMovementTitle(payload.title);
  if (!fields.subType && !fields.tempoTerm) return;
  const patch: { subType?: string; tempoTerm?: string } = {};
  if (fields.subType && fields.subType !== cur?.subType) patch.subType = fields.subType;
  if (fields.tempoTerm && fields.tempoTerm !== cur?.tempoTerm) patch.tempoTerm = fields.tempoTerm;
  if (!Object.keys(patch).length) return;
  await api.tracks.update(r.id, patch);
  await loadRows();
  if (selectedId.value === r.id) detail.value = await api.tracks.get(r.id);
  message.value = { key: 'msg.movementFieldsSynced' };
}

function startRename(id: string) {
  editRowId.value = id;
  editCaretEnd.value = false;
  editPrefix.value = null;
}
function cancelRename() {
  editRowId.value = null;
  editCaretEnd.value = false;
  editPrefix.value = null;
}

async function onMenuAction(name: string) {
  // 工作区列表是动态的：action 里带名字，这里先拦一道
  if (name.startsWith('ws-apply:')) return void applyWorkspace(name.slice('ws-apply:'.length));
  switch (name) {
    case 'ws-save':
      return openWsSave();
    case 'ws-last':
      return void applyWorkspace();
    case 'new-playlist':
      return newPlaylist();
    case 'register':
      return registerWork();
    case 'open-data':
      return api.openDataDir();
    case 'quit':
      return api.win.close();
    case 'undo':
      return ma()?.undo();
    case 'redo':
      return ma()?.redo();
    case 'undo-global':
      return ma()?.undoGlobal();
    case 'redo-global':
      return ma()?.redoGlobal();
    case 'delete-sel':
      return ma()?.del();
    case 'clear-sel':
      return ma()?.clear();
    case 'rename-current':
      return selectedId.value ? startRename(selectedId.value) : undefined;
    case 'remove-track':
      return removeSelectedTrack();
    case 'toggle-panel':
      return togglePanel();
    case 'toggle-left-sidebar':
      return toggleLeftSide();
    case 'toggle-right-sidebar':
      return toggleRightSide();
    case 'zoom-in':
      return applyZoom(uiZoom.value + 0.1);
    case 'zoom-out':
      return applyZoom(uiZoom.value - 0.1);
    case 'zoom-reset':
      return applyZoom(1);
    case 'open-lyrics':
      return void api.win.openLyrics();
    case 'open-overlay':
      return void api.win.openOverlay();
    case 'action-help':
      // 开/关都由主进程决定（窗口有它自己的关闭按钮），状态会广播回来
      return void api.help?.toggle?.();
    case 'history':
      return void api.history?.toggle?.();
    case 'support':
      return void openSupport();
    case 'unit-bar':
    case 'unit-beat':
    case 'unit-half':
      gridUnit.value = name.slice(5) as 'bar' | 'beat' | 'half';
      return;
    case 'popout':
      return popOut();
    case 'focus-search':
      return focusSearch();
    case 'clear-search':
      return clearSearch();
    case 'prefs':
      showPrefs.value = true;
      return;
    case 'orphans':
      return checkOrphans();
    case 'archive':
      return openArchive();
    case 'shortcuts':
    case 'about':
      showHelp.value = true;
      return;
  }
}

/** 制作名单的字段名：只收库里约定的几个键，别的键原样显示 */
/**
 * 制作名单的键。跟词典里的 `credit.*` 一一对应 ——
 * 列表里排在前面的先显示，不认识的键仍然原样显示（见 creditRows 末尾的 extra 分支）。
 * 加一个键要同时改这里和 i18n.js，缺一就会出现「英文 key 直接显示」。
 */
const CREDIT_KEYS = [
  'composer', 'musicBy', 'lyricist', 'lyricsBy', 'arranger', 'conductor', 'soloist',
  'performer', 'orchestra', 'chorus',
  'soprano', 'mezzoSoprano', 'tenor', 'baritone', 'bass',
  'violinist', 'violist', 'cellist', 'doubleBassist', 'pianist', 'organist',
  'harpsichordist', 'harper', 'trumpeter', 'hornist', 'trombonist', 'tubist',
  'flutist', 'oboist', 'clarinetist', 'bassoonist', 'percussionist', 'timpanist',
  'instrumentation', 'librettist', 'translator',
  'producer', 'executiveProducer', 'recordingEngineer', 'mixingEngineer', 'masteringEngineer',
  'label', 'catalogue', 'releaseDate', 'publisher', 'copyist',
  'opening', 'dedication', 'originalTitle', 'language',
];

/** 制作名单：只显示有值的项，null 不占版面（原始资料里作词作曲常常留空） */
/**
 * 拍号类型（单/复/混合）—— **派生值**，不在数据里。
 *
 * 体系跟着界面语言走：中文 → 中/苏/德奥（4/4 = 复拍子），英文 → 英美（4/4 = simple）。
 * 两套结论相反时 `noteKey` 非空，界面挂 ⓘ 说明「同一个词不是同一个意思」。
 */
const meterKind = computed(() => {
  const text = detail.value?.meter;
  if (!text) return null;
  return meterInfo(text, meterSystemForLocale(locale.value));
});

/**
 * ⓘ 的说明气泡。
 *
 * 它是 **Teleport 到 body 的 fixed 元素**，不在 `.detail` 里：
 * 右侧栏默认只有 340px 宽，而这段说明要 268px —— 右对齐到图标时左半截一定出界，
 * 而 `.detail` 是 `overflow: auto`，出界部分直接被裁掉（用户看到的就是「文字被吞了一块」）。
 * 挂到 body 上没有任何祖先能裁它，也不会被左侧曲目树的层叠上下文压住。
 *
 * 位置在 `mouseenter` 里现算：横向夹在视口里，纵向下边放不下就翻到图标上方。
 * 开合只看这组 handler（v-if 直接增删节点），不依赖 CSS 过渡 —— 悬停要立刻看到。
 */
const TIP_W = 268;
const meterTip = ref<{ left: number; top: number } | null>(null);

/**
 * 气泡的三种状态：悬停看 / 点住（钉住）/ 关着。
 *
 * - **悬停**：移进图标立刻出；移出**延迟 0.6s** 才收 —— 图标和气泡之间有缝，
 *   鼠标穿过去的那一瞬间不该闪一下。这 0.6s 内把鼠标挪进气泡里就不收（`mouseenter` 取消了定时器），
 *   在气泡里选字、拖滚动条同理；离开气泡同样再等 0.6s。
 *   （原来是 1s：实测「读一句说明」用不到那么久，1s 反而像是关不掉。）
 *   延迟和「能不能挪进气泡」是两回事：延迟只要大于 0，手就有时间过去。
 * - **点住**：点一下图标钉住（不用一直悬着），再点一下 / 点页面别处 / Esc 才收。
 *   钉住后鼠标怎么移都不收 —— 这正是「点开想边看边操作」的场景。
 */
const tipPinned = ref(false);
const TIP_CLOSE_DELAY = 600;
let tipTimer: number | null = null;

function cancelTipClose() {
  if (tipTimer != null) {
    clearTimeout(tipTimer);
    tipTimer = null;
  }
}

/** 鼠标离开图标/气泡之后：等 0.6s 再收（钉住时压根不收） */
function scheduleTipClose() {
  cancelTipClose();
  tipTimer = window.setTimeout(() => {
    tipTimer = null;
    if (!tipPinned.value) meterTip.value = null;
  }, TIP_CLOSE_DELAY);
}

function closeMeterTip() {
  cancelTipClose();
  tipPinned.value = false;
  meterTip.value = null;
}

function openMeterTip(ev: Event) {
  cancelTipClose();
  const el = ev.currentTarget as HTMLElement | null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 横向：尽量让图标落在气泡中间，但整块必须留在视口内
  const left = Math.round(Math.min(Math.max(8, r.left + r.width / 2 - TIP_W / 2), vw - TIP_W - 8));
  const top = Math.round(r.bottom + 6);
  meterTip.value = { left, top };
  // 先按「下方」渲染一帧，量到真实高度再决定要不要翻到上面
  void nextTick(() => {
    const pop = document.querySelector('.mt-pop') as HTMLElement | null;
    if (!pop || !meterTip.value) return;
    const h = pop.getBoundingClientRect().height;
    if (top + h > vh - 8 && r.top - h - 6 > 8) {
      meterTip.value = { left, top: Math.round(r.top - h - 6) };
    }
  });
}

/** 点图标：开着就钉住；已钉住则关掉（再点一下收起，符合「开关」的直觉） */
function toggleMeterPin(ev: Event) {
  if (meterTip.value && tipPinned.value) {
    closeMeterTip();
    return;
  }
  tipPinned.value = true;
  if (!meterTip.value) openMeterTip(ev);
  cancelTipClose();
}

/** 换曲 / 切语言 / 改拍号：气泡里的旧结论立刻过期，直接收掉 */
watch(meterKind, () => closeMeterTip());

onBeforeUnmount(() => cancelTipClose());

const creditRows = computed(() => {
  const c = detail.value?.credits;
  if (!c) return [];
  const known = CREDIT_KEYS.filter((k) => c[k]).map((k) => ({
    key: k,
    label: t(`credit.${k}`),
    value: c[k],
  }));
  // 档案里出现没见过的键也照显示，不做丢弃
  const extra = Object.keys(c)
    .filter((k) => !CREDIT_KEYS.includes(k) && c[k])
    .map((k) => ({ key: k, label: k, value: c[k] }));
  return [...known, ...extra];
});

/**
 * 情绪词是档案里的英文枚举（mysterious / epic…），中文界面才加一层对照，
 * 英文界面直接显示原值 —— 它本来就是英文，别再翻一遍。
 * 标签从 data/vocab/mood.json 来（vocabLabels），不在词典里抄第二份：
 * 加一个情绪只要改词表，详情、搜索、补全同时认得。
 */

const neteaseUrl = computed<string | null>(
  () => detail.value?.links?.netease ?? detail.value?.neteaseUrl ?? null
);

/**
 * 标签维度的显示名。文案在词典里，键是 `dim.<维度>`；
 * 库里出现词典没收录的新维度就原样显示，不做丢弃。
 */
const DIM_KEYS = new Set(['instrument', 'instrument_technique', 'composition', 'genre', 'period', 'mood', 'form', 'composition_type']);

function dimLabel(dim: string) {
  return DIM_KEYS.has(dim) ? t(`dim.${dim}`) : dim;
}

/**
 * 标签按维度分好，模板里按模块取（作曲技法一块、乐器组合里再分乐器/演奏技法）。
 * 以前是一个「标签」大块按 dim 顺序平铺 —— 结果作曲技法和乐器混在一处，
 * 和详情面板的语义顺序对不上。
 */
const tagsByDim = computed<Record<string, any[]>>(() => {
  const map: Record<string, any[]> = {};
  for (const tag of detail.value?.tags ?? []) (map[tag.dim] ??= []).push(tag);
  return map;
});

const periodText = computed(() => (detail.value?.period ? periodLabel(detail.value.period, locale.value) : ''));

/** 流派：库里存的是词条 name，显示时按 genre.json 翻成中文 */
const genreText = computed(() => genreLabel(detail.value?.genre, locale.value));

/** 体裁 / 曲式：库里存词条 id，显示时按 composition_type.json / form.json 翻 */
const compositionTypeText = computed(() => entryLabel('composition_type', detail.value?.compositionType, locale.value));
const formText = computed(() => entryLabel('form', detail.value?.form, locale.value));
/** 标题模板的数据项（作品编号 / 作品号 / 子体裁 / 速度术语） */
const formNumberText = computed(() => detail.value?.formNumber ?? '');
const opusNumberText = computed(() => {
  const v = String(detail.value?.opusNumber ?? '').trim();
  if (!v) return '';
  if (/^n\/?a$/i.test(v)) return locale.value === 'en' ? 'N/A' : t('detail.notApplicable');
  return v;
});
const subTypeText = computed(() => entryLabel('composition_type', detail.value?.subType, locale.value));
const tempoTermText = computed(() => tempoLabel(detail.value?.tempoTerm, locale.value));

/**
 * 乐章序号：标题里自己写了「第三乐章」就用它；标题已经是模板（认不出前缀）时
 * 退回它在母作品下的位置。模板展开、详情标题都走这一份。
 */
const detailMovementNo = computed(() => {
  const d = detail.value;
  if (!d?.parentId) return null;
  const parent = rows.value.find((r) => r.id === d.parentId);
  const list: any[] = Array.isArray(parent?.movements) ? parent.movements : [];
  const idx = list.findIndex((m) => m.id === d.id);
  return idx >= 0 ? movementOrdinalOf(list[idx], idx) : null;
});
const detailTitleText = computed(() =>
  detail.value ? displayTitleOf(detail.value, locale.value, detailMovementNo.value) : ''
);

/** 列表行 / 菜单 / 状态消息里显示展开后的标题；乐章缺的序号按它在母作品下的位置补 */
function shownTitleOf(row: any): string {
  if (!row) return '';
  if (!row.parentId) return displayTitleOf(row, locale.value);
  const parent = rows.value.find((r) => r.id === row.parentId);
  const list: any[] = Array.isArray(parent?.movements) ? parent.movements : [];
  const idx = list.findIndex((m) => m.id === row.id);
  return displayTitleOf(
    {
      ...row,
      composer: row.composer ?? parent?.composer,
      compositionType: row.compositionType ?? parent?.compositionType,
    },
    locale.value,
    idx >= 0 ? movementOrdinalOf(list[idx], idx) : null
  );
}

/* ---- 详情面板的模块显隐（右键空白处开关） ----
 *
 * 为什么不做「统一结构」：档案的详略本来就不一样 —— 神鹿谣有五段调性、三个段落标签，
 * 灰ト祈リ 一个调性都没写。硬撑成同一套骨架只会到处是「—」。
 * 所以结构固定成一套**模块清单**，但每一首可以自己决定显示哪几块；
 * 状态按 trackId 记在 localStorage，换曲目各记各的，不动数据库。
 */
const DETAIL_MODULES: { id: string; labelKey: string }[] = [
  { id: 'subtitle', labelKey: 'detail.subtitle' },
  { id: 'aliases', labelKey: 'detail.alias' },
  { id: 'moods', labelKey: 'dim.mood' },
  { id: 'meter', labelKey: 'detail.meterBpm' },
  { id: 'key', labelKey: 'detail.key' },
  { id: 'credits', labelKey: 'detail.credits' },
  { id: 'composition', labelKey: 'dim.composition' },
  { id: 'instrumentation', labelKey: 'detail.instrumentation' },
  /** 体裁与结构：夹在「谁在演奏」和「时间轴」之间 —— 先说作品是什么、怎么长，再看逐段 */
  { id: 'structure', labelKey: 'detail.structure' },
  { id: 'timeline', labelKey: 'detail.timeline' },
  { id: 'sources', labelKey: 'detail.sources' },
];

const HIDDEN_KEY = 'ma-detail-hidden';

function readHidden(): Record<string, string[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    /* 存坏了就当没设置过，别让详情面板打不开 */
    return {};
  }
}

const hiddenModules = ref<Record<string, string[]>>(readHidden());

function writeHidden(next: Record<string, string[]>) {
  hiddenModules.value = next;
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式写不进去，本次会话内仍然生效 */
  }
}

const hiddenSet = computed(() => new Set(hiddenModules.value[selectedId.value ?? ''] ?? []));
/** 模块默认可见；只有被明确关掉的才隐藏 */
const showSection = (id: string) => !hiddenSet.value.has(id);

function toggleSection(id: string) {
  const key = selectedId.value ?? '';
  const cur = new Set(hiddenModules.value[key] ?? []);
  if (cur.has(id)) cur.delete(id);
  else cur.add(id);
  writeHidden({ ...hiddenModules.value, [key]: [...cur] });
}

function resetSections() {
  const key = selectedId.value ?? '';
  const next = { ...hiddenModules.value };
  delete next[key];
  writeHidden(next);
}

/** 右键菜单只记坐标；打开时按当时的数据渲染，不缓一份快照 */
const ctxMenu = ref<null | { x: number; y: number }>(null);

function onDetailContextMenu(e: MouseEvent) {
  // 只认「空白处」：按钮 / 输入框 / 标签 / 表格 / 标题都有自己的右键语义，
  // 在这些地方弹模块菜单会挡掉（比如将来给标签留的右键）
  const el = e.target as HTMLElement | null;
  if (el?.closest('button, input, select, textarea, a, .tag, table, .d-head h2')) return;
  // 菜单高约 320px、宽 190px：贴着窗口边右键时往里收，别被裁掉
  ctxMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - 200),
    y: Math.min(e.clientY, window.innerHeight - 340),
  };
}

function closeCtxMenu() {
  ctxMenu.value = null;
}

/** 点别处关掉（菜单内部 stopPropagation，不会误关） */
function onDocPointerDown(ev?: PointerEvent) {
  if (ctxMenu.value) ctxMenu.value = null;
  /**
   * 钉住的 ⓘ 气泡：点页面别的地方就收。
   * 图标自己和气泡里的操作要放过 —— 点图标是「开关」的另一次点击（交给 @click），
   * 在气泡里拖选文字更不该把它收掉。
   */
  if (meterTip.value) {
    const t = ev?.target as HTMLElement | null;
    if (!(t?.closest?.('.mt-i') || t?.closest?.('.mt-pop'))) closeMeterTip();
  }
}

const tempos = computed(() => {
  const a = detail.value?.analysis;
  if (!a) return [];
  const list = a.markers.filter((m: any) => m.kind === 'tempo').map((m: any) => ({ tick: m.tick, bpm: m.bpm }));
  return list.length ? list.sort((x: any, y: any) => x.tick - y.tick) : [{ tick: 0, bpm: a.tempoValue ?? 120 }];
});

/** 拍号链（表格里的「小节.拍」要按变拍号算，不能一律当 4/4） */
const meters = computed(() => {
  const a = detail.value?.analysis;
  if (!a) return [];
  const raw = a.markers.filter((m: any) => m.kind === 'meter');
  const list = raw.length ? raw : [{ tick: 0, num: 4, den: 4 }];
  return computeStartBars(list as any, a.ppq ?? 480);
});

const sectionRows = computed(() => {
  const a = detail.value?.analysis;
  if (!a) return [];
  const ppq = a.ppq ?? 480;
  return a.markers
    .filter((m: any) => m.kind === 'section')
    .map((m: any) => ({
      ...m,
      bar: m.startBar,
      // 毫秒仍然算着（悬停提示用），显示换成「小节.拍.十六分.tick」
      time: tickToMs(tempos.value, m.tick, ppq),
      pos: tickToBarBeatSub(meters.value, m.tick, ppq),
      key: a.markers.filter((k: any) => k.kind === 'key' && k.tick <= m.tick).pop() ?? null,
    }));
});

/**
 * 双击「时间轴 · 段落」一行：播放头跳到该段起点、网格横向翻页过去、并选中起点那一格。
 *
 * 先对一下 trackId：详情面板跟的是列表里选中的曲子，网格可能还开着另一首 ——
 * 不比对就会把 B 的时间跳到 A 的网格上，看起来像「跳错地方」。
 */
function seekToSection(s: any) {
  const g = ma() as any;
  if (!g?.focusTick) return;
  const gridTrack = typeof g.trackId === 'function' ? g.trackId() : null;
  const here = detail.value?.analysis?.trackId ?? null;
  if (gridTrack && here && gridTrack !== here) {
    message.value = { key: 'msg.seekOtherTrack' };
    return;
  }
  g.focusTick(s.tick, { margin: 96 });
}

/**
 * 重拉列表。
 *
 * `autoSelect: false` 是给「删除」用的：默认在没有任何选中时自动选第一行，
 * 而删除那一刻选中必然是空的 —— 于是删掉第 15 首会被甩到列表最顶上，
 * 时间线面板换成一首完全不相干的曲子（还是首没分析过的，看着就像渲染坏了）。
 * 删除路径自己决定停在哪儿（原位置的邻居），这里就别抢。
 */
async function loadRows(opts: { autoSelect?: boolean } = {}) {
  loading.value = true;
  rows.value = await api.tracks.list({ text: text.value, tags: filterTags.value.map((id) => ({ dim: '', id })) });
  loading.value = false;
  if (opts.autoSelect !== false && !selectedId.value && rows.value.length) select(rows.value[0].id);
}

/**
 * 当前列表里的曲目。
 *
 * 「全部曲目」直接给 rows；具体列表按 trackIds 过滤 —— 搜索词仍然生效（先搜再筛）。
 * 列表里可能有已被删除的 id，过滤时自然掉出去，不用另外清理。
 */
const activePlaylist = computed(() => playlists.value.find((p) => p.id === activeList.value) ?? null);
const listRows = computed(() => {
  const pl = activePlaylist.value;
  if (!pl) return rows.value;
  const keep = new Set(pl.trackIds);
  return rows.value.filter((r) => keep.has(r.id));
});

async function select(id: string) {
  selectedId.value = id;
  detail.value = await api.tracks.get(id);
  if (detail.value?.analysis?.viewId) viewId.value = detail.value.analysis.viewId;
  // 歌词状态（详情面板里显示匹配情况）
  try { lyricDoc.value = await api.lyrics.resolve(id); } catch { lyricDoc.value = { found: false, file: null, lines: [], instrumental: false, how: 'none' }; }
  // 音频跟着选中项走：不 await，播放条自己会显示载入中。
  // 但要把 promise 留一手：双击播放要求「src 已经挂上」才真的出声。
  //
  // **同一首重拉详情时要保留当前版本**：改标签、设原点之后都会走 select()，
  // 不保留的话界面会自己跳回主录音 —— 改的是第 2 版，看到的是第 1 版，最容易改错。
  const keepRec = audioState.trackId === id ? audioState.recId : null;
  // 没有可播音频时，时间线按「当前版本 offset + 档案终点」走；
  // 解析到音频的话 loadTrack 不会看这个值。
  audioLoad = loadTrack(id, keepRec, { timelineMs: timelineDurationMs(viewAnalysis.value) });
  void audioLoad.then(() => syncTimelineDuration(timelineDurationMs(viewAnalysis.value)));
  // 换了作品，上一首攒下的「待切换版本」就不属于这里了
  if (!keepRec) pendingRecId.value = null;
}

async function playRow(row: any) {
  await select(row.id);
  await audioLoad;
  const shownTitle = shownTitleOf(row);

  if (row.hasAudio) {
    /**
     * 点作品播放 = 从**主录音**开始（顺序里的第一首）。
     *
     * `select()` 现在会保留「正在看的那一版」（改偏移后不该跳版本），
     * 所以这里必须显式切回主录音 —— 否则试听完第 3 版再点作品，播的还是第 3 版，
     * 而界面上「哪个是默认版本」的绿点还在第一版，两边对不上。
     */
    audioLoad = loadTrack(row.id, null);
    await audioLoad;
    playAudio();
    message.value = { key: 'msg.playing', vars: { title: shownTitle } };
    return;
  }
  const url = detail.value?.recordings[0]?.link || row.neteaseUrl || detail.value?.neteaseUrl || detail.value?.links?.netease;
  if (url) {
    await openLink(url, shownTitle, { startTimeline: true });
    return;
  }
  // 连外链都没有，但档案还能推算时长：让双击也能启动静音时间线，便于先看标记走向
  if (audioState.sourceMode === 'timeline' && audioState.ready) {
    seekAudio(0);
    playAudio();
    message.value = { key: 'msg.timelineStarted', vars: { title: shownTitle } };
    return;
  }
  message.value = { key: 'msg.noSource', vars: { title: shownTitle } };
}

/**
 * 切到某条录音版本，并把「这一版自己的原点」作为时间线总长的输入。
 * 外链版本双击后必须先走这里：否则播放头/原点还停在上一个版本上，对轨会整体偏。
 */
async function loadRecVersion(trackId: string, recId: string) {
  const full = (detail.value?.recordings ?? []).find((r: any) => r.id === recId);
  const analysis = detail.value?.analysis;
  const timelineMs = analysis
    ? timelineDurationMs({ ...analysis, audioOffsetMs: Number(full?.audioOffsetMs) || 0 })
    : 0;
  await loadTrack(trackId, recId, { timelineMs });
}

/**
 * 双击列表里的某个录音版本 → **只听这一版，仅此一次**。
 *
 * 播放优先级由顺序决定（点作品播放 = 播第一首），所以试听别的版本时
 * 直接把那一条的地址喂给播放器（ma-audio://rec/<trackId>/<recId>），
 * **一行数据库都不写**：既不挪顺序，也不改 track.file_path。
 * 想真的换掉「先播哪一版」，去管理窗口调顺序 —— 那是唯一入口。
 *
 * 外部播放不改录音顺序，网易云歌曲交给客户端，其余链接交给浏览器。
 */
async function playVersion(payload: { row: any; rec: any }) {
  const { row, rec } = payload;
  const shownTitle = shownTitleOf(row);
  await select(row.id);
  await audioLoad;

  if (!rec.filePath || rec.fileExists === false) {
    await loadRecVersion(row.id, rec.id);
    if (rec.link) {
      await openLink(rec.link, shownTitle, { startTimeline: true });
      return;
    }
    message.value = { key: 'msg.versionTimeline', vars: { name: recName(rec) } };
    return;
  }

  await loadRecVersion(row.id, rec.id);
  playAudio();
  message.value = { key: 'msg.playing', vars: { title: shownTitle } };
}

/**
 * 单击列表里的录音版本子行 → 只是把「当前版本」切过去，**不写库、不挪顺序**。
 *
 * 三件事必须一起发生，否则界面会自相矛盾：
 *   - 波形按这一版重画（`loadTrack(id, recId)` → `ma-audio://rec/<trackId>/<recId>`）；
 *   - 播放条的「以播放头为原点」写的是这一版（TransportBar 的 recId 来自 activeRecording）；
 *   - 网格的时间轴原点用这一版的 audio_offset_ms（viewAnalysis 已按版本取）。
 *
 * 正在播的时候切版本，切完接着播：单击一下就静音，比「波形没换」更让人意外。
 * 换「点作品播放先播哪一版」仍然只能在「管理录音版本」里调顺序 —— 那是唯一入口。
 */
async function selectVersion(payload: { row: any; rec: any }) {
  const { row, rec } = payload;
  const shownTitle = shownTitleOf(row);
  if (row.id !== selectedId.value) await select(row.id);

  /* 播放中怎么办：交给首选项（默认「暂停并切过去」） */
  if (audioState.playing) {
    const mode = clickVersionMode.value;
    if (mode === 'ignore') {
      // 双击仍然是「只听这一版」，所以这里只提一句，不偷偷改任何东西
      message.value = { key: 'msg.versionLocked' };
      return;
    }
    if (mode === 'defer') {
      pendingRecId.value = rec.id;
      message.value = { key: 'msg.versionPending', vars: { name: recName(rec) } };
      return;
    }
    if (mode === 'play') {
      // 切过去并从 0 接着播：A/B 对比同一部作品的两版录音最顺手。
      // 没有本地文件时 loadTrack 会落到仅时间线，playAudio() 走的是那条静音时钟。
      await loadRecVersion(row.id, rec.id);
      playAudio();
      message.value = rec.filePath
        ? { key: 'msg.versionSelected', vars: { name: recName(rec) } }
        : { key: 'msg.versionTimeline', vars: { name: recName(rec) } };
      return;
    }
    // pause：先把声音停下，再换波形 —— 绝不出现「波形是 A、声音还是 B」
    pauseAudio();
  }

  pendingRecId.value = null;

  // 外链版本没有本地文件：波形画不出来，但版本照样选中（原点、发行信息都属于它）；
  // 播放键此时走的是「仅时间线」，不是没有音源。
  if (!rec.filePath) {
    await loadRecVersion(row.id, rec.id);
    message.value = { key: 'msg.versionTimeline', vars: { name: recName(rec) } };
    return;
  }

  await loadRecVersion(row.id, rec.id);
  message.value = { key: 'msg.versionSelected', vars: { name: recName(rec) } };
}

/**
 * defer 模式落地：播放停下（暂停 / 播完）的那一刻，把攒下的版本切过去。
 *
 * 只认 `true → false` 这一跳：`select()` 之后重新加载时长状态也会变，
 * 那时候切过去会把用户刚选的曲目又拉回上一首。
 */
watch(
  () => audioState.playing,
  (now, before) => {
    if (!before || now) return;
    const recId = pendingRecId.value;
    if (!recId || !detail.value) return;
    pendingRecId.value = null;
    const rec = (detail.value.recordings ?? []).find((r: any) => r.id === recId);
    if (!rec) return;
    void loadRecVersion(detail.value.id, rec.id).then(() => {
      message.value = rec.filePath
        ? { key: 'msg.versionSelected', vars: { name: recName(rec) } }
        : { key: 'msg.versionTimeline', vars: { name: recName(rec) } };
    });
  }
);

async function openLink(
  url: string,
  title = detail.value ? shownTitleOf(detail.value) : '',
  opts: { startTimeline?: boolean } = {}
) {
  message.value = { key: 'msg.openingLink' };
  const res = await api.link.open(url);
  const started = opts.startTimeline === true && res.ok && res.via === 'orpheus' && audioState.sourceMode === 'timeline' && audioState.ready;
  if (started) {
    seekAudio(0);
    playAudio();
  }
  message.value = started
    ? { key: 'msg.neteaseTimelineStarted', vars: { title } }
    : res.ok
      ? res.via === 'orpheus'
        ? { key: 'msg.neteaseOpened', vars: { title } }
        : { key: 'msg.linkOpened' }
      : { key: 'msg.linkFailed', vars: { note: noteVar(res) } };
  return res;
}

async function refreshDetail() {
  if (selectedId.value) await select(selectedId.value);
  await loadRows();
  if (meta.value) meta.value = await api.meta();
  // 每次重拉详情都顺手刷一次「撤销/重做能不能点」：编辑、撤销、重做都会走到这里，
  // 比等广播稳（广播只服务**别的窗口**改数据那一半）
  void syncHistMenu();
}

/* ---- 录音制品（作品 vs 录音） ----
 *
 * 分层的理由：同一部作品的不同录音，作曲家、时期、调式、乐器编制完全相同，
 * 但演奏家、乐团、指挥、混音、母带、发行年全都不一样。
 * 前者挂作品层（track），后者挂录音层（recording）。
 *
 * track.file_path 保留为「主录音」的快捷方式，所以绝大多数作品（只一个录音）
 * 的播放、波形、列表显示都跟以前一模一样，不需要先查录音表。
 */
const recordings = computed<any[]>(() => detail.value?.recordings ?? []);

/**
 * 录音版本上可编辑的字段（都是逐版本不同、且不属于作品层的东西）。
 *
 * 这 11 个字段现在住在「管理录音版本」窗口里（`components/RecordingManager.vue`），
 * 面板里只留一行摘要 —— 详情面板窄，N 个版本 × 11 个字段铺下来根本没法看。
 */

/** 某字段当前该显示什么（演奏者数组要先拼成字符串） */


/**
 * 一个极简的确认框。
 * 删录音会连带改 track.file_path（切到另一条顶上），不可撤销 ——
 * 没有确认就按一下 ✕ 太过危险。
 * 用 Promise 而不是 v-model 开关：调用点写起来像同步代码，不用在模板里塞一堆状态。
 */
const confirmBox = ref<{ title: string; body: string } | null>(null);
const confirmEl = ref<HTMLElement | null>(null);
let confirmResolver: ((v: boolean) => void) | null = null;
function confirmDialog(title: string, body: string): Promise<boolean> {
  /*
   * 已经有一个在问：先把它按「取消」结掉。
   * 直接覆盖 resolver 会让上一个调用方（如 `closePrefs`）永远 await 在那里 ——
   * 表现和「点了关闭没反应」一模一样，而这次连弹窗都看不见。
   */
  confirmResolver?.(false);
  confirmResolver = null;
  confirmBox.value = { title, body };
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}
function settleConfirm(v: boolean) {
  confirmBox.value = null;
  confirmResolver?.(v);
  confirmResolver = null;
}

/**
 * 确认框的键盘约定（专门防误删）：
 *
 * - **回车什么都不做**。焦点落在弹窗容器（`tabindex="-1"`，不是按钮）上，
 *   所以 Enter 既不会确认也不会取消 —— 想删必须真的点一下，或者 Tab 到按钮再按。
 *   原来的实现虽然没有绑 Enter，但若给「确定」加了 autofocus，手快一敲就删了。
 * - **Esc 取消**。取消永远安全，给它一个顺手的出口。
 * - **空格吃掉**。播放条的监听挂在 window 上，不挡住的话，弹着确认框按空格会开始播放。
 */
function onConfirmKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    settleConfirm(false);
    return;
  }
  // Tab 到按钮上再按 Enter / 空格是**刻意操作**，照常放行；焦点在容器上时全部吃掉
  const onButton = (ev.target as HTMLElement | null)?.tagName === 'BUTTON';
  if (!onButton && (ev.code === 'Space' || ev.key === 'Enter')) {
    ev.preventDefault();
    ev.stopPropagation();
  }
}

/* 打开时把焦点放进弹窗：读屏软件才会念标题，Tab 也能进到按钮上 */
watch(confirmBox, (v) => {
  if (v) void nextTick(() => confirmEl.value?.focus());
});

/** 这个演奏版本实际会播的文件：自己的文件优先，其次第一个存在的同版音质 */
function recFileOf(r: any): any | null {
  if (!r) return null;
  if (r.filePath && r.fileExists) return r;
  const list: any[] = Array.isArray(r.variants) ? r.variants : [];
  return list.find((v) => v.fileExists) ?? null;
}

/** 版本显示名：优先厂牌 + 编号，其次指挥，再次文件名，最后「录音版本」 */
function recName(r: any): string {
  if (r.label && r.catalogNo) return `${r.label} · ${r.catalogNo}`;
  if (r.label) return r.label;
  if (r.conductor) return r.conductor;
  const file = recFileOf(r) ?? r;
  if (file.filePath) return String(file.filePath).split(/[\\/]/).pop() || '';
  return t('rec.title');
}
function recPerformersText(r: any): string {
  const list: string[] = Array.isArray(r.performers) ? r.performers : [];
  return list.join(' / ');
}

/**
 * 面板里那一行摘要：谁演的 · 哪年 · 多长。
 * 逐版本的 11 个字段在管理窗口里改，这里只给「一眼认得出是哪一版」的线索。
 */
function recMeta(r: any): string {
  const bits: string[] = [];
  const perf = recPerformersText(r) || r.conductor || r.orchestra || '';
  if (perf) bits.push(perf);
  const year = r.releaseYear ?? r.recordedYear;
  if (year) bits.push(String(year));
  const file = recFileOf(r);
  if (file?.durationMs) bits.push(formatMsShort(file.durationMs));
  if (Array.isArray(r.variants) && r.variants.length) bits.push(t('rec.qualityBadge', { n: r.variants.length }));
  return bits.join(' · ');
}

/** 来源标记：有本地文件算本地（哪怕也填了链接），只有链接算外链，都没有算空 */
function recSourceKind(r: any): 'local' | 'link' | 'none' {
  if (r.filePath || (Array.isArray(r.variants) && r.variants.some((v: any) => v.filePath))) return 'local';
  if (r.link) return 'link';
  return 'none';
}
function recSourceLabel(r: any): string {
  const k = recSourceKind(r);
  if (k === 'local') return t('rec.sourceLocal');
  if (k === 'link') return t('rec.sourceExternal');
  return t('rec.sourceNone');
}

/* ---- 管理录音版本：面板里只留一个入口，逐版本编辑全在模态窗口里 ---- */
const showRecManager = ref(false);
const recManagerInitial = ref<string | null>(null);

function openRecManager(recId?: string) {
  if (!detail.value?.id) return;
  // 不传就是「管理整张清单」：默认停在第一条（顺序第一 = 点播放先播的那条）
  recManagerInitial.value = recId ?? recordings.value[0]?.id ?? null;
  showRecManager.value = true;
}
async function onRecManagerChanged(payload?: { files?: boolean }) {
  /**
   * 版本 / 音质文件刚被增删换过：当前这条的音频解析结果**必须作废重来**。
   *
   * 以前这里只重拉详情，`loadTrack` 看到 trackId + recId 没变就直接早退，
   * `<audio>` 还挂在旧文件上；之后拖播放头会用旧文件的字节范围去请求新文件，
   * Chromium 偶发解码/区间错误 —— 就是用户报的「偶尔播放失败，动一下指针又好了」。
   * 重载时把原位置和播放状态接回去，别让编辑录音顺带把正在听的东西打断。
   *
   * 管理窗在「选文件 / 加删音质 / 并入 / 删版本」时显式带 `files: true`（同路径覆盖也能识别）；
   * 其余改动再用文件指纹兜底。只改厂牌 / 演奏者 / 偏移时不重载。
   */
  const audioFingerprint = (d: any) =>
    JSON.stringify({
      file: d?.filePath ?? null,
      recs: (d?.recordings ?? []).map((r: any) => [
        r.id,
        r.filePath ?? null,
        (r.variants ?? []).map((v: any) => [v.id, v.filePath ?? null]),
      ]),
    });
  const beforeFiles = audioFingerprint(detail.value);
  const wasPlaying = audioState.playing;
  const at = Math.max(0, Number(audioState.currentMs) || 0);
  const tid = audioState.trackId;
  const rid = audioState.recId;

  await refreshDetail();
  const filesChanged = payload?.files === true || audioFingerprint(detail.value) !== beforeFiles;
  if (!filesChanged) return;
  if (!tid || tid !== selectedId.value) return;

  // 当前版本被删掉了就退回主录音；同版音质（子行）还在也算这条版本还在
  const stillThere = rid
    ? (detail.value?.recordings ?? []).some(
        (r: any) => r.id === rid || (r.variants ?? []).some((v: any) => v.id === rid)
      )
    : true;
  const nextRec = stillThere ? rid : null;
  await loadTrack(tid, nextRec, { force: true });
  if (at > 0 && nextRec === rid) seekAudio(at);
  if (wasPlaying) playAudio();
}

/* 封面：只给一个绿色文件名，点开才看图 —— 详情面板窄，缩略图会喧宾夺主 */
const coverName = computed(() => {
  const c = detail.value?.covers;
  if (!c?.url) return '';
  const src: string = c.source === 'album' ? c.album : c.single;
  const base = String(src ?? '').split(/[\\/]/).pop() ?? '';
  return base || t('detail.cover');
});
function viewCover() {
  const url = detail.value?.covers?.url;
  if (url) void api.win.openImage?.(url, detailTitleText.value);
}

/* ---- 详情面板的就地编辑（双击值 → 输入框 → Enter/失焦保存） ----
 *
 * 为什么双击而不是常驻输入框：详情面板首先是「读」的地方，
 * 满屏 input 会把 15px 的标题、调性链、制作名单压成一张表单。
 * 双击是明确的「我要改这一项」，改完立刻回到只读，版式不跳。
 *
 * 哪些字段可改，由 TrackPatch 决定（见 shared/types.ts）：
 * 标题 / 附注 / 别名 / 情绪 / 时期 / 拍号 / 速度 / 调性链 / 制作名单 / 编制摘要。
 */
type EditField =
  | 'title'
  | 'subtitle'
  | 'aliases'
  | 'moods'
  | 'period'
  | 'genre'
  | 'compositionType'
  | 'form'
  | 'formNumber'
  | 'opusNumber'
  | 'subType'
  | 'tempoTerm'
  | 'album'
  | 'albumNo'
  | 'meter'
  | 'bpm'
  | 'keys'
  | 'instrumentationAbstract'
  | `credit:${string}`;

const editField = ref<EditField | null>(null);
const editDraft = ref('');
const editSaving = ref(false);
const editInputEl = ref<HTMLInputElement | null>(null);
/**
 * 详情里所有可编辑字段共用一个 ref 名。Vue 在**多个同名 ref** 同时存在于模板时
 * 会把它收成数组（新增作品编号 / 子体裁四行之后冒烟撞到了 `focus is not a function`）。
 * 这里统一取「第一个还活着的元素」，调用处不再关心它是单个还是数组。
 */
function editInput(): HTMLInputElement | null {
  const v = editInputEl.value as unknown;
  if (Array.isArray(v)) return (v.find(Boolean) as HTMLInputElement) ?? null;
  return (v as HTMLInputElement) ?? null;
}
/** Esc 取消后 input 还会 blur 一次，别让那次 blur 把原值又提交一遍 */
let editCancelled = false;

/** 进入编辑态时的初始文本：界面看到什么就编辑什么，不做隐藏格式 */
function fieldValue(field: EditField): string {
  const d = detail.value;
  if (!d) return '';
  switch (field) {
    case 'title':
      return d.title ?? '';
    case 'subtitle':
      return d.subtitle ?? '';
    case 'aliases':
      return (d.aliases ?? []).join(' / ');
    case 'moods':
      // 编辑的是中文标签（怀旧 / 神秘），保存时再按词表翻回英文枚举
      return (d.moods ?? []).map((m: string) => moodDisplay(m, locale.value)).join(', ');
    case 'period':
      // 编辑的是「浪漫主义」这种显示名，保存时再翻回 romantic
      return d.period ? periodLabel(d.period, locale.value) : '';
    case 'genre':
      // 编辑的是「爵士」这种显示名，保存时再翻回词条 name（Jazz）
      return genreLabel(d.genre, locale.value);
    case 'compositionType':
      // 同上：编辑显示名，保存时翻回词条 id（symphony）
      return entryLabel('composition_type', d.compositionType, locale.value);
    case 'form':
      return entryLabel('form', d.form, locale.value);
    case 'formNumber':
      return d.formNumber ?? '';
    case 'opusNumber':
      // 编辑时显示档案里的原值（N/A 就是 N/A），「不适用」只是中文界面的读法
      return d.opusNumber ?? '';
    case 'subType':
      return entryLabel('composition_type', d.subType, locale.value);
    case 'tempoTerm':
      return tempoLabel(d.tempoTerm, locale.value);
    case 'album':
      return d.album ?? '';
    case 'albumNo':
      return d.albumTrackNo == null ? '' : String(d.albumTrackNo);
    case 'meter':
      // 未标注 = 空串，编辑框里是空的；placeholder 仍提示「如 4/4」
      return d.meter ?? '';
    case 'bpm':
      return d.bpm == null ? '' : String(d.bpm);
    case 'keys':
      return (d.keys ?? []).join(' → ');
    case 'instrumentationAbstract':
      return d.instrumentationAbstract ?? '';
    default:
      return d.credits?.[field.slice('credit:'.length)] ?? '';
  }
}

async function startEdit(field: EditField) {
  if (!detail.value || editSaving.value) return;
  editCancelled = false;
  closeFieldSug();
  editDraft.value = fieldValue(field);
  editField.value = field;
  await nextTick();
  const el = editInput();
  el?.focus();
  el?.select();
}

function cancelEdit() {
  editCancelled = true;
  editField.value = null;
  closeFieldSug();
}

/* ---- 字段补全：流派 / 情绪 ----
 *
 * 这两个字段是「从词表里挑」，不是自由输入，所以编辑框要带下拉：
 * 来源是 api.tags.suggest（词表 → tag 缓存），中文名、英文名、别名、译名都认。
 *
 * 键盘语义：**完全相等的候选照样留着**（它就是用户此刻想要的那一条），
 * 采纳之后文本没变 → 那一次回车直接落库；采纳会改文本（敲的是别名 / 缩写 / 另一种语言）
 * → 那一次回车只采纳，再回车才保存。判断在 shared/suggest.js 的 pickMode 里，
 * 不要在这里再写一套 toLowerCase 比较：两套归一化规则会在全角括号这类边角上打架。
 */
const fieldSug = ref<any[]>([]);
const fieldSugActive = ref(0);
const fieldSugOpen = ref(false);
/** 编辑框里的光标位置：变量补全按光标前的词匹配（预设仍看整条输入） */
const fieldCaret = ref(0);
let fieldSugTimer: any = null;

/** 哪个编辑字段有词表可补；其余字段（曲名、拍号…）返回 null */
function suggestDim(field: EditField | null): string | null {
  if (field === 'title') return 'template';
  if (field === 'moods') return 'mood';
  if (field === 'genre') return 'genre';
  if (field === 'compositionType') return 'composition_type';
  if (field === 'form') return 'form';
  // 乐章的子体裁（Menuetto / 小步舞曲）也是从体裁树里挑，不另立词表
  if (field === 'subType') return 'composition_type';
  return null;
}

/** 光标所在的那一段：情绪是逗号分隔的多值，流派是单值 */
function fieldTailToken(s: string) {
  const m = /(?:^|[,，;；])\s*([^,，;；]*)$/.exec(s);
  return (m ? m[1] : s).trim();
}

/** 标题模板补全看整条输入；其它词表字段只看光标所在的那一段 */
function fieldToken(field: EditField | null, value: string): string {
  return field === 'title' ? String(value ?? '').trim() : fieldTailToken(value);
}

function closeFieldSug() {
  clearTimeout(fieldSugTimer);
  fieldSugOpen.value = false;
  fieldSug.value = [];
  fieldSugActive.value = 0;
}

async function refreshFieldSug() {
  const dim = suggestDim(editField.value);
  if (!dim) {
    closeFieldSug();
    return;
  }
  const token = fieldToken(editField.value, editDraft.value);
  if (!token) {
    closeFieldSug();
    return;
  }
  if (dim === 'template') {
    /*
     * 标题补全有两类，顺序就是优先级：
     *   1. 预设（`for_Classical_Opus`）—— 整条替换，用户敲的就是它的名字；
     *   2. 模板变量（`c` / `%c` / `Cp` → `%Composer}`）—— 插在光标处。
     */
    const vars = suggestVariables(editDraft.value, fieldCaret.value, 6).map((item) => ({
      id: `var:${item.key}`,
      name: item.label,
      desc: item.desc,
      variable: true,
      item,
    }));
    const list = matchPresets(token, 'title').map((preset) => ({
      id: preset.id,
      name: preset.name,
      template: preset.template,
      preset,
    }));
    // 回来时用户可能已经接着敲了：对不上就丢掉
    if (fieldToken(editField.value, editDraft.value) !== token) return;
    fieldSug.value = [...list, ...vars].slice(0, 8);
    // 预设会整条替换标题：默认不高亮，必须 ↓ / 鼠标选中才采纳
    fieldSugActive.value = -1;
    fieldSugOpen.value = fieldSug.value.length > 0;
    return;
  }
  const list = await api.tags.suggest(dim, token);
  // 回来时用户可能已经接着敲了：词对不上就丢掉，别把旧候选贴到新输入上
  if (suggestDim(editField.value) !== dim || fieldToken(editField.value, editDraft.value) !== token) return;
  // 不筛掉「和输入完全一样」的那条！以前这里 filter 掉它，剩下的全是编辑距离≤2 的近似项，
  // 下拉默认高亮第一条 → 打「神秘」按回车会被换成「悲伤」。
  // 后端已按 exact(100) > alias(96) > 前缀(80) > 子串(60) > 模糊 排序，正主永远在第一条。
  fieldSug.value = (list ?? []).slice(0, 8);
  fieldSugActive.value = 0;
  fieldSugOpen.value = fieldSug.value.length > 0;
}

/* 只在用户真的敲键时才去查：startEdit 填初值、采纳候选都改 editDraft，
   那两次不该把下拉又弹出来（否则刚打开编辑框就会闪一层候选） */
/** 点/拖到别的字符上：变量补全按新的 caret 算 */
function onFieldCaret() {
  const el = editInput();
  if (el) fieldCaret.value = el.selectionStart ?? editDraft.value.length;
}

function onFieldInput() {
  // 变量补全认的是「光标前那个词」，所以每次输入都记一下 caret
  const el = editInput();
  if (el) fieldCaret.value = el.selectionStart ?? editDraft.value.length;
  clearTimeout(fieldSugTimer);
  if (!suggestDim(editField.value)) return;
  fieldSugTimer = setTimeout(() => void refreshFieldSug(), 110);
}

/** 采纳候选：把光标所在那一段换成词条名（中文界面用中文显示名，英文界面用规范名） */
function applyFieldSug(s: any) {
  // 组合刚结束那一帧 v-model 可能还没跟上，先以输入框真实值为准
  const el = editInput();
  if (el && typeof el.value === 'string') editDraft.value = el.value;
  // 模板变量：插在光标处（`%c` / `Cp` 那一段被替换掉），不碰标题其余部分
  if (s?.variable) {
    const next = applyVariable(editDraft.value, s.item);
    editDraft.value = next.text;
    fieldCaret.value = next.caret;
    closeFieldSug();
    void nextTick(() => {
      const el2 = editInput();
      el2?.focus();
      el2?.setSelectionRange?.(next.caret, next.caret);
    });
    return;
  }
  // 预设名补全：整条标题换成模板原文，不是把名字塞进某个词的位置
  if (s?.preset) {
    editDraft.value = String(s.preset.template ?? '');
    closeFieldSug();
    void nextTick(() => {
      const el2 = editInput();
      el2?.setSelectionRange?.(editDraft.value.length, editDraft.value.length);
    });
    return;
  }
  const raw = editDraft.value;
  const m = /(?:^|[,，;；])(\s*)([^,，;；]*)$/.exec(raw);
  const head = m ? raw.slice(0, raw.length - m[2].length) : '';
  const text = insertText(s, locale.value);
  editDraft.value = `${head}${text}`;
  closeFieldSug();
  void nextTick(() => {
    const el2 = editInput();
    el2?.setSelectionRange?.(editDraft.value.length, editDraft.value.length);
  });
}

/**
 * 流派 / 情绪编辑框的键盘：↑↓ 选、Enter 采纳或保存、Esc 取消。
 *
 * 「采纳」还是「保存」由 pickMode 决定：采纳后文本不变（敲的就是候选本身）→ 直接保存，
 * 免得用户觉得第一下回车什么都没发生；会改文本才两段式。
 */
function onFieldKey(ev: KeyboardEvent) {
  // 组合期：↑↓ 是输入法翻页、Enter 是确认候选词，全都不能拦
  if (isComposing(ev)) return;

  if (fieldSugOpen.value && fieldSug.value.length) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = fieldSug.value.length;
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      fieldSugActive.value = (fieldSugActive.value + step + n) % n;
      return;
    }
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    // 先取真实值再算 token：组合刚结束时 editDraft 还是旧的，会比错对象（静默换字）
    const el = ev.target as HTMLInputElement | null;
    if (el && typeof el.value === 'string') editDraft.value = el.value;
    const hit = fieldSugOpen.value && fieldSug.value.length ? fieldSug.value[fieldSugActive.value] : null;
    if (hit?.variable || hit?.preset) {
      applyFieldSug(hit);
      return;
    }
    if (hit && pickMode(fieldToken(editField.value, editDraft.value), hit, locale.value) === 'adopt') {
      applyFieldSug(hit);
      return;
    }
    void commitEdit();
    return;
  }
  if (ev.key === 'Escape') {
    ev.preventDefault();
    cancelEdit();
  }
}

/** 中文时期写成规范值；认不出就是错输入（时期是定死的枚举，不收新词） */
function toPeriodId(s: string) {
  const k = s.trim().toLowerCase();
  return PERIODS.find((p: any) => p.terms.some((x: string) => x.toLowerCase() === k))?.id ?? null;
}

const splitList = (v: string, re: RegExp) =>
  v
    .split(re)
    .map((s) => s.trim())
    .filter(Boolean);

async function commitEdit() {
  if (editCancelled) {
    editCancelled = false;
    return;
  }
  const field = editField.value;
  if (!field) return;
  // 先退出编辑态：blur 与 Enter 可能都会走到这里，第二次必须什么都不做
  editField.value = null;
  closeFieldSug();
  await saveEdit(field, editDraft.value);
}

/**
 * 回车提交。**必须走这里，不能直接 @keydown.enter="commitEdit"。**
 *
 * 用中文输入法时，按 Enter「确认候选词」那一下也会派发 keydown（isComposing=true），
 * 而此刻 Vue 的 vModelText 还没把组合文本同步进 editDraft（组合期内的 input 事件被它丢掉）。
 * 直接提交就会拿组合前的旧值去存：原值为空 → 走「清空」分支，用户看到的就是「回车保存不上」。
 * 所以：组合期内的 Enter 一律当作「确认候选」放过去，不提交。
 */
function commitOnEnter(e: KeyboardEvent) {
  if (isComposing(e)) return;
  // 双保险：v-model 若因任何原因滞后，以输入框里的真实值为准
  const el = e.target as HTMLInputElement | null;
  if (el && typeof el.value === 'string') editDraft.value = el.value;
  void commitEdit();
}

/** 失焦提交：同样以输入框真实值为准（点走的那一刻可能刚好撞上组合结束） */
function commitOnBlur(e: FocusEvent) {
  const el = e.target as HTMLInputElement | null;
  if (el && typeof el.value === 'string') editDraft.value = el.value;
  void commitEdit();
}

async function saveEdit(field: EditField, raw: string) {
  const d = detail.value;
  const id = selectedId.value;
  if (!d || !id) return;
  const v = raw.trim();
  const patch: Record<string, unknown> = {};
  let invalid: string | null = null;

  if (field === 'title') {
    if (!v) return;
    if (v !== d.title) patch.title = v;
  } else if (field === 'subtitle') {
    if (v === (d.subtitle ?? '')) return;
    patch.subtitle = v || null;
  } else if (field === 'aliases') {
    patch.aliases = splitList(v, /[/,，;；]/);
  } else if (field === 'moods') {
    // 中文标签 / 别名 → 词表里的 id；认不出的按小写原样存（不吞输入，搜索仍能按字面命中）
    patch.moods = splitList(v, /[,，;；]/).map(moodIdOf);
  } else if (field === 'period') {
    if (!v) patch.period = null;
    else {
      const pid = toPeriodId(v);
      if (!pid) invalid = 'msg.badPeriod';
      else if (pid !== d.period) patch.period = pid;
    }
  } else if (field === 'genre') {
    // 流派是单值：中文 / 别名 → 词条 name；词表外的写法原样存
    if (!v) patch.genre = null;
    else {
      const name = genreNameOf(v);
      if (name && name !== (d.genre ?? '')) patch.genre = name;
    }
  } else if (field === 'compositionType') {
    // 体裁：单值，中文 / 别名 → 词条 id；词表外的写法原样存（不吞输入）
    if (!v) patch.compositionType = null;
    else {
      const next = entryIdOf('composition_type', v);
      if (next !== (d.compositionType ?? '')) patch.compositionType = next;
    }
  } else if (field === 'form') {
    if (!v) patch.form = null;
    else {
      const next = entryIdOf('form', v);
      if (next !== (d.form ?? '')) patch.form = next;
    }
  } else if (field === 'formNumber') {
    if (v !== (d.formNumber ?? '')) patch.formNumber = v || null;
  } else if (field === 'opusNumber') {
    if (v !== (d.opusNumber ?? '')) patch.opusNumber = v || null;
  } else if (field === 'subType') {
    if (!v) patch.subType = null;
    else {
      const next = entryIdOf('composition_type', v);
      if (next !== (d.subType ?? '')) patch.subType = next;
    }
  } else if (field === 'tempoTerm') {
    if (v !== (d.tempoTerm ?? '')) patch.tempoTerm = v || null;
  } else if (field === 'album') {
    // 专辑是自由文本，不进词表
    if (!v) patch.album = null;
    else if (v !== (d.album ?? '')) patch.album = v.trim();
  } else if (field === 'albumNo') {
    // 专辑内序号：只收正整数。0 / 负数 / 非数字都当作「清空」，
    // 而不是报错拦下来 —— 用户想擦掉一个填错的序号时不该被卡住。
    const n = Number(v);
    const next = v && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
    if (next !== (d.albumTrackNo ?? null)) patch.albumTrackNo = next;
  } else if (field === 'meter') {
    // 留空 = 清除标注，回到「未标注」；网格与播放仍按 4/4 兜底
    if (!v.trim()) {
      if (d.meter != null) patch.meter = null;
    } else {
      // 只收 num/den 两个整数，剩下的（C、cut time）交给网格的拍号标记
      const m = v.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!m) invalid = 'msg.badMeter';
      else patch.meter = { num: Number(m[1]), den: Number(m[2]) };
    }
  } else if (field === 'bpm') {
    // 留空 = 清除标注，播放按 120 BPM 兜底
    if (!v.trim()) {
      if (d.bpm != null) patch.bpm = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) invalid = 'msg.badBpm';
      else patch.bpm = n;
    }
  } else if (field === 'keys') {
    patch.keys = splitList(v, /[→>\/,，;；]/);
  } else if (field === 'instrumentationAbstract') {
    if (v === (d.instrumentationAbstract ?? '')) return;
    patch.instrumentationAbstract = v || null;
  } else if (field.startsWith('credit:')) {
    const key = field.slice('credit:'.length);
    const next = { ...(d.credits ?? {}), [key]: v || null };
    patch.credits = next;
  }

  if (invalid) {
    message.value = { key: invalid };
    return;
  }
  if (!Object.keys(patch).length) return;

  editSaving.value = true;
  try {
    const next = await api.tracks.update(id, patch);
    if (!next) {
      message.value = { key: 'msg.saveFailed', vars: { note: t('msg.unknown') } };
      return;
    }
    // 主进程回的是改完的完整详情：直接替换，避免再 get 一次把音频也重载一遍
    detail.value = next;
    message.value = { key: 'msg.saved' };
    // 列表里的曲名 / 拍号 / 调性 / 时期都是详情里改的，得同步
    await loadRows();
  } catch (err: any) {
    message.value = { key: 'msg.saveFailed', vars: { note: String(err?.message ?? err) } };
  } finally {
    editSaving.value = false;
  }
}

// 换曲目时收起编辑框：否则上一首的草稿会贴在新曲目上，看着像已经改过去了
watch(selectedId, () => {
  editField.value = null;
  editCancelled = false;
  closeFieldSug();
  /**
   * 换曲目就把录音管理窗口关掉。
   * 它是按 trackId 取数的，换一首之后留着一份「上一首的版本列表」，
   * 接着往里填就是在给别人的作品录信息。
   */
  showRecManager.value = false;
});

let timer: any = null;
watch(text, () => {
  clearTimeout(timer);
  timer = setTimeout(loadRows, 160);
});

/**
 * 主题：拆成「模式」与「实际生效值」两件事。
 *
 *   mode = 'dark' | 'light'    用户直接指定
 *   mode = 'system'            跟随操作系统（nativeTheme.shouldUseDarkColors）
 *   mode = 'timed'             按时段：夜里深色、白天浅色
 *
 * theme 是**实际生效的颜色**，模式变化会重算它。
 * 分开的好处：子窗口只关心「现在该用哪个颜色」，
 * 不用管这个颜色是被谁决定的 —— 广播 app:theme 时传的是 theme，不是 mode。
 */
type ThemeMode = 'dark' | 'light' | 'system' | 'timed';
const themeMode = ref<ThemeMode>(
  ((localStorage.getItem('ma-theme-mode') as any) ?? 'dark') as ThemeMode
);
const theme = ref<'dark' | 'light'>('dark');

/* ---------------- 侧栏留白：浅色 / 深色各存一份 ----------------
 *
 * 用户 2026-11-08：36px 在深色下看着特别舒服，浅色下就觉得宽得难受。
 * 同一个数在两种底色上的观感本来就不一样（浅底会把留白读成「空」），
 * 所以不再共用一个值 —— 现在跟着**当前实际生效的 theme** 取。
 */
type SideInset = { l: number; r: number };
type SideInsetSet = { light: SideInset; dark: SideInset };
const DEFAULT_SIDE_INSET: SideInsetSet = { light: { l: 36, r: 12 }, dark: { l: 36, r: 12 } };
const sideInset = ref<SideInsetSet>({ ...DEFAULT_SIDE_INSET, light: { ...DEFAULT_SIDE_INSET.light }, dark: { ...DEFAULT_SIDE_INSET.dark } });
try {
  const raw = JSON.parse(localStorage.getItem('ma-side-inset') || 'null') as Partial<SideInsetSet> | null;
  const num = (v: unknown, dflt: number) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(80, Math.round(Number(v)))) : dflt);
  if (raw && typeof raw === 'object') {
    for (const m of ['light', 'dark'] as const) {
      const src = raw[m];
      if (src && typeof src === 'object') {
        sideInset.value[m] = { l: num(src.l, DEFAULT_SIDE_INSET[m].l), r: num(src.r, DEFAULT_SIDE_INSET[m].r) };
      }
    }
  }
} catch {
  /* 存的天书就退回默认 */
}
/** 当前生效的那一份（浅色 / 深色各一套） */
const sideInsetNow = computed<SideInset>(() => (theme.value === 'light' ? sideInset.value.light : sideInset.value.dark));

/** 改一个数：夹到 0–80、落盘、并让最小宽度重算（留白变了，下限跟着变） */
function setSideInset(mode: 'light' | 'dark', side: 'l' | 'r', v: unknown) {
  const n = Math.max(0, Math.min(80, Math.round(Number(v) || 0)));
  sideInset.value = { ...sideInset.value, [mode]: { ...sideInset.value[mode], [side]: n } };
  try {
    localStorage.setItem('ma-side-inset', JSON.stringify(sideInset.value));
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  void nextTick(measureSideMinW);
}

/** 选项面板里那两行的顺序（浅色在上、深色在下） */
const SIDE_MODE_ROWS = [
  { id: 'light', label: 'prefs.lightMode' },
  { id: 'dark', label: 'prefs.darkMode' },
] as const;

/** 时段划分：7–18 点算白天，其余算夜里。阈值集中在这里，改一处即可 */
const DAY_FROM = 7;
const DAY_TO = 18;

/** 按时段算：现在是白天就用浅色，夜里用深色 */
function themeByClock(): 'dark' | 'light' {
  const h = new Date().getHours();
  return h >= DAY_FROM && h < DAY_TO ? 'light' : 'dark';
}

/**
 * 重算实际生效的主题。
 * system 走主进程问操作系统 —— 渲染层没有这个能力，
 * 所以主进程有个 200ms 的轮询把值推过来（见 main 里的 app:system-theme）。
 */
async function resolveTheme(): Promise<'dark' | 'light'> {
  switch (themeMode.value) {
    case 'light':
      return 'light';
    case 'timed':
      return themeByClock();
    case 'system': {
      try {
        return (await api.app.systemTheme()) === 'light' ? 'light' : 'dark';
      } catch {
        return 'dark';
      }
    }
    default:
      return 'dark';
  }
}

async function applyTheme() {
  const v = await resolveTheme();
  if (v === theme.value) return;
  theme.value = v;
  document.documentElement.dataset.theme = v;
  void api.win.overlay(OVERLAY_COLORS[v]);
  void api.app.setTheme?.(v);
}

/** 设模式（选项面板 / 菜单用）。顺手把实际值算出来落盘。 */
async function setThemeMode(m: ThemeMode) {
  themeMode.value = m;
  localStorage.setItem('ma-theme-mode', m);
  // 强制重算：即使 resolveTheme 结果和当前一样，也要把 mode 落进主进程
  const v = await resolveTheme();
  theme.value = v;
  document.documentElement.dataset.theme = v;
  void api.win.overlay(OVERLAY_COLORS[v]);
  void api.app.setTheme?.(v);
  void api.app.setThemeMode?.(m);
}

/**
 * 手动切一个色（在 system / timed 模式下按下时，先退出到固定模式）。
 * 没有这一步的话，用户在「跟随系统」时按切换按钮会毫无反应 ——
 * 因为 resolveTheme 每次都把值改回去了。
 */
function toggleTheme() {
  if (themeMode.value === 'system' || themeMode.value === 'timed') {
    void setThemeMode(theme.value === 'dark' ? 'light' : 'dark');
  } else {
    void setThemeMode(themeMode.value === 'dark' ? 'light' : 'dark');
  }
}

/* ---- 模式变化的响应式处理 ---- */
let unsubSystemTheme: (() => void) | null = null;
/** 动态操作帮助窗口的开合广播（菜单勾选状态靠它） */
let unsubHelpState: (() => void) | null = null;
let unsubHistState: (() => void) | null = null;
let unsubHistApplied: (() => void) | null = null;
let unsubHistChanged: (() => void) | null = null;
let unsubWsChanged: (() => void) | null = null;
let unsubOpenGrid: (() => void) | null = null;
let themeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * timed 模式要能在「跨过 7 点 / 18 点」时自己变色。
 * 不重算整分钟而是每 20 秒查一次 —— 代价可以忽略，但窗口最小化时
 * Chromium 会把定时器压到 1 分钟一次，所以最多晚一分钟变，不影响体验。
 */
function ensureThemeTimer() {
  if (themeTimer) clearInterval(themeTimer);
  themeTimer = null;
  if (themeMode.value !== 'timed') return;
  themeTimer = setInterval(() => {
    void applyTheme();
  }, 20_000);
}

// 切模式时：system 模式订阅主进程推送（nativeTheme 只有主进程能读），
// timed 模式起定时器，其它模式两样都不需要。
watch(themeMode, () => {
  unsubSystemTheme?.();
  unsubSystemTheme = null;
  if (themeMode.value === 'system') {
    unsubSystemTheme = api.app.onSystemTheme?.((t: string) => {
      theme.value = t === 'light' ? 'light' : 'dark';
    }) ?? null;
  }
  ensureThemeTimer();
}, { immediate: true });

/**
 * 原生窗口按钮（titleBarOverlay）是系统画的，CSS 管不到它，
 * 每次换主题都得从主进程重新配色，否则深色下会出现一块浅色的按钮底。
 */
const OVERLAY_COLORS = {
  dark: { color: '#1c1c1a', symbolColor: '#c9c9c4' },
  light: { color: '#ffffff', symbolColor: '#3a3a37' },
};

/**
 * 主题变化时的副作用：DOM 变量、窗口按钮配色、通知子窗口。
 * 实际生效值已经由 setThemeMode / applyTheme 算好了，这里只做「落地」。
 */
watch(theme, (v) => {
  document.documentElement.dataset.theme = v;
  localStorage.setItem('ma-theme', v);
  void api.win.overlay(OVERLAY_COLORS[v]);
  // 通知子窗口换配色：它们的 <html> 是各自分开的，收不到这里的 DOM 变化
  void api.app.setTheme?.(v);
});

async function checkOrphans() {
  orphans.value = await api.tags.orphans();
  showOrphans.value = true;
}

/**
 * 删除作品：只是「归档」。
 *
 * 为什么不一上来就物理删：曲目 JSON 是这套档案的源，用户点错一下就把文件删了，
 * 而它可能已经积累了几十条段落与和弦。移进 `data/tracks/.archive` 之后，
 * 「维护 → 已归档作品」里还能彻底删除 —— 危险动作分成两步，且都有名字。
 */
async function removeSelectedTrack(id?: string) {
  // 从列表右键进来时先切过去：确认框、音频清理、删完选下一首都按「当前曲目」算，
  // 不切的话删掉的会是上一次选中的那首。
  if (id && detail.value?.id !== id) await select(id);
  const d = detail.value;
  if (!d?.id) return;
  const ok = await confirmDialog(t('track.removeTitle'), t('track.removeBody'));
  if (!ok) return;

  const title = d.title;
  // 记住它在列表里的位置：删完停在这个位置的邻居上，而不是被甩回第一行
  const idx = rows.value.findIndex((r: any) => r.id === d.id);
  await api.tracks.remove(d.id);

  /**
   * 顺序很重要：**先把这个曲目的一切清干净，再选下一首**。
   *
   * 只把 selectedId / detail 置空是不够的 —— 音频状态（trackId / peaks / durationMs）
   * 还挂着已删那首，网格会拿「新档案 + 旧音频时长」去铺文档长度，
   * 表现就是小节只画到前几小节、波形飘在别处，看着像渲染错乱。
   */
  unloadAudio();
  pendingRecId.value = null;
  selectedId.value = null;
  detail.value = null;
  await loadRows({ autoSelect: false });

  // 删的如果是最后一行，就往上取一条；列表空了就停在「没有选中」的空态
  const next = rows.value.length ? rows.value[Math.min(idx < 0 ? 0 : idx, rows.value.length - 1)] : null;
  if (next) await select(next.id);
  message.value = { key: 'msg.archived', vars: { title } };
}

async function openArchive() {
  archived.value = await api.archive.list();
  showArchive.value = true;
}

function fmtWhen(ms: number) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function purgeArchivedOne(a: { uuid: string | null; title: string }) {
  const ok = await confirmDialog(t('archive.confirmTitle'), `${a.title}\n\n${t('archive.confirmBody')}`);
  if (!ok) return;
  const r = await api.archive.purge(a.uuid);
  archived.value = await api.archive.list();
  message.value = { key: 'archive.purged', vars: { n: (r?.track ? 1 : 0) + (r?.files ?? 0) } };
}

async function purgeArchiveAll() {
  const ok = await confirmDialog(t('archive.confirmAllTitle'), t('archive.confirmAllBody'));
  if (!ok) return;
  const n = await api.archive.purgeAll();
  archived.value = await api.archive.list();
  message.value = { key: 'archive.purged', vars: { n } };
}

/** 词表保存后：meta 里的条目数、以及当前曲目的标签显示都要跟着换 */
async function onVocabSaved() {
  meta.value = await api.meta();
  // 词表改了：流派 / 情绪的显示名与识别词要重新读一遍
  await loadVocabLabels();
  await loadRows();
  if (selectedId.value) await select(selectedId.value);
}

async function pickView(id: string) {
  viewId.value = id;
  const a = detail.value?.analysis;
  if (a) await api.analysis.setView(a.id, id);
}

async function removeTag(tagId: string) {
  if (!selectedId.value) return;
  await api.tags.detach(selectedId.value, tagId);
  await refreshDetail();
}

function keyText(k: any) {
  if (!k) return '—';
  return `${k.keyName}${k.confidence === 'confirmed' ? '' : ' ?'}`;
}

let resizing: null | { y: number; h: number } = null;

/**
 * 下方面板能拖到多高。
 *
 * 分栏之后不能再按「窗口多高减一串常数」估：那样一来面板一变高，表格就被压到
 * 只剩几十像素（以前是浮层，压不着表格，估错了也看不出来）。
 * 直接量主区：`main 高度 - 搜索行 - splitter - 表格至少留的高度`。
 */
const TABLE_FLOOR = 140;
function maxPanelH() {
  const mainEl = document.querySelector<HTMLElement>('.main');
  const mainH = mainEl?.clientHeight ?? window.innerHeight - 90;
  const searchH = document.querySelector<HTMLElement>('.searchrow')?.offsetHeight ?? 34;
  return Math.max(140, mainH - searchH - 7 - TABLE_FLOOR);
}

function startResize(ev: PointerEvent) {
  resizing = { y: ev.clientY, h: panelH.value };
  if (!panelOpen.value) panelOpen.value = true;
  try {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  } catch {
    /* 捕获失败也能靠 window 监听收尾 */
  }
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', endResize);
}

function onResizeMove(ev: PointerEvent) {
  if (!resizing) return;
  const next = resizing.h + (resizing.y - ev.clientY);
  panelH.value = Math.round(Math.max(140, Math.min(maxPanelH(), next)));
}

function endResize() {
  resizing = null;
  localStorage.setItem('ma-panel-h', String(panelH.value));
  pushPanelSizes();
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', endResize);
}

function togglePanel(force?: boolean) {
  panelOpen.value = typeof force === 'boolean' ? force : !panelOpen.value;
  localStorage.setItem('ma-panel-open', panelOpen.value ? '1' : '0');
  pushPanelSizes();
}

function popOut() {
  if (selectedId.value) api.win.openGrid(selectedId.value, viewId.value);
}

watch(panelH, (v) => {
  if (!resizing) localStorage.setItem('ma-panel-h', String(v));
});

onMounted(async () => {
  applyTplFont();
  /**
   * 界面缩放要**第一个**落位。
   *
   * 它只依赖 localStorage，没有理由排在主题、词表、config 读盘后面；
   * 而排在后面就会出事：任何新加的 `await`（比如读 config.json 的面板尺寸）
   * 都会把它推到「别的东西已经跑起来之后」，看上去就像「缩放自己跳回 100%」。
   */
  await applyZoom(Number(localStorage.getItem('ma-zoom')) || 1);
  // 转位数字写法（汉字 / 阿拉伯）：shared 层是全局状态，启动时灌一次
  initNumeralStyle();
  applyFont(uiFont.value);
  applyLocaleToDom();
  // 主题：先按模式算出实际生效值，再落地。必须排在最前面 ——
  // 界面要按配色画，子窗口也要在开窗时拿到同一个 backgroundColor。
  await applyTheme();
  void api.app.setThemeMode?.(themeMode.value);
  panelH.value = Math.min(panelH.value, maxPanelH());
  // 面板尺寸以 config.json 为准（localStorage 只是升级前的旧值 / 兜底）
  await loadPanelLayout();
  document.addEventListener('pointerover', onHelpPointerOver, { passive: true });
  document.addEventListener('pointerout', onHelpPointerOut, { passive: true });
  window.addEventListener('keydown', onGlobalKey);
  // 播放列表 / 曲目行右键菜单：点别处关、Esc 关（同一条规矩见 RULES 第 23 条）
  window.addEventListener('pointerdown', onDocPointerDownMenus);
  window.addEventListener('keydown', onPlMenuKey);
  window.addEventListener('pointerdown', onDocPointerDown);
  // 动态操作帮助窗口：菜单里那两条的勾选必须跟着真实窗口状态走（它有自己的关闭按钮）
  void api.help
    ?.state?.()
    .then((st: any) => {
      helpOpen.value = !!st?.open;
    })
    .catch(() => {});
  unsubHelpState =
    api.help?.onState?.((st: any) => {
      if (st) helpOpen.value = !!st.open;
    }) ?? null;
  // 历史记录窗口：同上，窗口自带关闭按钮，勾选跟真实状态走
  void api.history?.state?.().then((open: any) => {
    historyOpen.value = !!open;
  });
  unsubHistState =
    api.history?.onState?.((open: boolean) => {
      historyOpen.value = !!open;
    }) ?? null;
  /**
   * 历史回退把数据写回去之后：网格/详情要重拉；
   * 如果这一步落在**别的曲子**上，界面还得切过去，不然改了数据用户也看不见。
   */
  unsubHistApplied =
    api.history?.onApplied?.((p: any) => {
      if (!p?.analysisId) return;
      if (p.trackId && p.trackId !== selectedId.value) {
        void select(p.trackId);
      } else {
        // 主窗口只暴露了 refreshDetail（__app.refresh 就是它）
        void refreshDetail();
      }
    }) ?? null;
  // 菜单里「撤销 / 重做」的灰显：跟着主进程的广播走（每次追加/撤销/重做都会发一份）
  unsubHistChanged =
    api.history?.onChanged?.((st: any) => readHistMenu(st)) ?? null;
  void syncHistMenu();
  /**
   * 子窗口（歌词播报器 / 网格 / 图片）里按快捷键时，主进程把按键转过来。
   *
   * 这里把它**还原成真的 KeyboardEvent** 再派发到 window，而不是另写一套 switch：
   * 下面 onGlobalKey、TransportBar 的播放键、MenuBar 的 Alt+字母 都是 window 级监听，
   * 派发一次就全都命中，逻辑不会出现「主窗口能按、歌词窗口按了走另一条路」的漂移。
   */
  offHotkey = api.hotkey?.onHotkey?.((p: any) => {
    if (!p) return;
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: p.key,
        code: p.code,
        ctrlKey: !!p.ctrl,
        shiftKey: !!p.shift,
        altKey: !!p.alt,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  meta.value = await api.meta();
  // 侧栏「和弦符号」那一行的数字（性质条数）+ 状态栏的音频信息（采样率/位深/大小）
  void loadChordQualityCount();
  void loadTempoMarkCount();
  void loadAudioMeta();
  // 流派 / 情绪的中文标签来自词表 JSON，界面要用它显示与翻译输入
  await loadVocabLabels();
  // 速度 / 表情术语：详情与标题模板共用（英文界面按 name 显示）
  void loadMovementLabels();

  // 冒烟钩子必须尽早设置：smoke 在 did-finish-load 后立即调用 window.__app.lang()
  (window as any).__app = {
    panel: togglePanel,
    /* 两根侧栏的展开收起 + 量出来的最小宽度（冒烟要读这几个真值，不靠猜像素） */
    toggleLeftSide,
    toggleRightSide,
    sides: () => ({
      left: { collapsed: leftCollapsed.value, w: leftShown.value, min: sideMinW.value },
      right: { collapsed: rightCollapsed.value, w: rightW.value },
    }),
    measureSideMinW: () => {
      measureSideMinW();
      return sideMinW.value;
    },
    /** 冒烟用：重新从 config.json 读一遍面板尺寸（验证「下次启动会还原」的读路径） */
    reloadPanels: loadPanelLayout,
    /** 冒烟用：立刻把当前面板尺寸写进 config.json（不等 300ms 防抖） */
    flushPanels: () => {
      if (panelPushTimer) {
        window.clearTimeout(panelPushTimer);
        panelPushTimer = null;
      }
      return api.config.setLayout({
        panels: {
          leftW: leftW.value,
          rightW: rightW.value,
          panelH: panelH.value,
          leftCollapsed: leftCollapsed.value,
          rightCollapsed: rightCollapsed.value,
          panelOpen: panelOpen.value,
        },
      });
    },
    /** 测量明细：谁把侧栏下限撑到了这个值（调数值时看这个，别猜） */
    sideMeasure: () => (window as unknown as { __sideMeasure?: unknown }).__sideMeasure ?? null,
    /** 菜单里「撤销/重做」的可用性（冒烟验按钮灰显） */
    histMenu: () => ({ ...histMenu.value }),
    refresh: refreshDetail,
    /** 冒烟用：直接建/改数据之后把列表也拉一遍（refreshDetail 只刷新详情） */
    reloadRows: () => loadRows(),
    panelHeight: () => panelH.value,
    setPanelHeight: (h: number) => {
      panelH.value = Math.round(Math.max(140, Math.min(maxPanelH(), h)));
      return panelH.value;
    },
    popOut,
    /* 库里有好几首时，默认选中项是按曲名排序的第一个；
       冒烟要断言的是某一首的具体数据，所以得能显式切过去 */
    select: (id: string) => select(id),
    currentId: () => selectedId.value,
    /* 主题存在 localStorage 里，上一轮跑完可能留在浅色，断言就不成立了 */
    /* 主题：既能给固定色，也能给模式（system / timed）后读回实际生效的值 */
    setTheme: (t: string) => {
      void setThemeMode(t as ThemeMode);
      return theme.value;
    },
    themeMode: () => themeMode.value,
    themeNow: () => theme.value,
    playRow: (id: string) => {
      const row = rows.value.find((r) => r.id === id);
      return row ? playRow(row) : null;
    },
    /* 首选项：冒烟不再依赖顶栏上有没有齿轮按钮 */
    prefs: (v = true) => {
      showPrefs.value = !!v;
      return showPrefs.value;
    },
    /* 登记作品：菜单项 Ctrl+R 与冒烟走同一条路径 */
    register: () => registerWork(),
    /* 播放中单击录音版本的行为（首选项里那四个）。冒烟要验「换模式真的换行为」 */
    clickVersion: (m?: string) => {
      if (m) setClickVersionMode(m as ClickVersionMode);
      return clickVersionMode.value;
    },
    /* 点某个版本子行，等价于用户的单击（冒烟用它走真实 DOM 路径） */
    clickVersionRow: (recId: string) => {
      const el = document.querySelector(`.row.rec-row[data-rec-id="${recId}"]`) as HTMLElement | null;
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    },
    editingId: () => editRowId.value,
    /** 冒烟用：按 id 进入行内改名态（和右键「更改标题」同一条路径） */
    rename: (id: string) => startRename(id),
    /* 播放列表从磁盘重读：冒烟会绕过界面直接 setTracks，界面那份缓存得能自己对齐 */
    refreshPlaylists: async () => {
      await loadPlaylists();
      return playlists.value.map((p) => ({ id: p.id, name: p.name, n: p.trackIds.length }));
    },
    /* 归档：冒烟要验「删掉的作品进了 .archive、彻底删除后文件与库都没了」。
       archive(true) 会把「已归档作品」面板打开，closeArchive 负责收起来 ——
       模态开着会盖住后面的详情/右键断言。 */
    removeSelected: () => removeSelectedTrack(),
    archive: async (open = false) => {
      archived.value = await api.archive.list();
      if (open) showArchive.value = true;
      /* 过桥前必须还原成普通对象：Vue 的响应式 Proxy 不能 structuredClone，
         直接返回会得到 `An object could not be cloned.`（README 里记过这条） */
      return JSON.parse(JSON.stringify(archived.value));
    },
    purgeArchived: async (uuid: string | null) => {
      await api.archive.purge(uuid);
      archived.value = await api.archive.list();
      return JSON.parse(JSON.stringify(archived.value));
    },
    closeArchive: () => {
      showArchive.value = false;
    },
    menuLabels: () => menus.value.map((m: any) => m.label),
    /* 冒烟要验「多词搜索」，得能直接设搜索词并等结果落地 */
    search: async (v: string) => {
      text.value = v;
      await loadRows();
      return rows.value.map((r: any) => r.title);
    },
    /** 界面语言开关：中文菜单带 (F) 式助记符，英文不写 */
    lang: (v?: string) => {
      if (v) setLocale(v);
      return locale.value;
    },
    /** 录音版本管理窗口：冒烟要验「入口 → 窗口里有表单」这条回路 */
    recManager: (v = true) => {
      if (v) openRecManager();
      else showRecManager.value = false;
      return showRecManager.value;
    },
    /* 播放器此刻挂的地址 / 在播哪个录音版本：
       双击某版试听不改数据库，只能靠这两个值证明「播的确实是那一版」 */
    audioSrc: () => audioState.info?.url ?? '',
    audioRecId: () => audioState.recId,
    /* 播放器挂的是哪首曲目：删除之后必须换人，不能还留着已删那首 */
    audioTrackId: () => audioState.trackId,
    /* 波形缓存：命中数 / 占用 / 上限。冒烟用它验「切回去不再解码」 */
    waveCache: () => waveStats(),
    setWaveLimit: (mb: number) => applyWaveLimit(mb),
    clearWaveCache: () => clearWave(),
    /* 播放器就绪度：地址对但取不到字节时，src 看着一样，只能靠这几个值分辨 */
    audioStatus: () => ({
      ready: audioState.ready,
      decoding: audioState.decoding,
      durationMs: audioState.durationMs,
      peaks: !!audioState.peaks,
      error: audioState.error,
    }),
  };

  // 启动配置：先读 config.json，再做别的启动动作
  void loadAppConfig();

  // 桌面歌词样式从主进程读一次（之后改设置时推）
  void loadDesktopStyle();

  // 波形缓存：把上次设的上限落到内存 LRU，并让主进程按它剪一遍磁盘
  initWaveCache();

  await loadRows();
  /**
   * 播放列表要在**启动时**读一次。
   *
   * 之前只有 `registerWork()` 里读，于是「上次建的列表重启后不显示，一新建就全冒出来」——
   * 因为 `playlists.create()` 返回的是整份文档，界面顺手把老的一起刷出来了。
   * 同一类错误这条注释下面刚写过一遍（工作区列表也在犯），别再犯第三次。
   */
  void loadPlaylists();

  /**
   * 启动时的「用户偏好 → 主进程」与「工作区 → 界面」。
   *
   * 这几件事曾经被误放进 `registerWork()`（登记作品的函数里），
   * 于是**只有登记作品时才会执行**：工作区列表启动时是空的、撤销上限没推给主进程、
   * 「上次布局」的面板/栏宽/泳道也没还原 —— 表现就是「保存过的工作区重启后菜单里没有」。
   * 它们属于启动流程，只在这里做。
   */
  // 撤销的上限/保留条数存在渲染层（用户偏好），启动时推一份给主进程
  applyUndoConfig();
  // 工作区：先取列表（菜单里要列出来），再把「上次布局」的窗口内部部件还原
  refreshWsList();
  unsubWsChanged =
    api.ws?.onChanged?.((st: any) => {
      wsNames.value = Array.isArray(st?.names) ? st.names : [];
    }) ?? null;
  unsubOpenGrid =
    api.ws?.onOpenGrid?.((trackId: string) => {
      void api.win.openGrid(trackId);
    }) ?? null;
  try {
    const lastUi = await api.ws?.lastUi?.();
    // 启动还原：不覆盖主题，也不覆盖窗口 / 面板几何与界面缩放（那三样归 config.json）
    if (lastUi) await applyUiFields(lastUi, { theme: false, geometry: false });
  } catch (e) {
    // 布局恢复失败不该挡住启动（窗口位置主进程已经摆好了）
    console.error('[ws] 还原上次布局失败', e);
  }

  /**
   * 首次启动自动打开歌词播报器，**排在主窗口之后**。
   *
   * 两个原因：
   *  1) 用户要的是「主窗口 + 旁边一个歌词窗」，两个窗口同时冒出来会像闪屏；
   *  2) 主进程要拿主窗口的位置把歌词窗摆到右侧，主窗口得先就位。
   *
   * 这类「锦上添花」的动作必须 try/catch 包住：onMounted 里抛错会中断后面的
   * loadRows()，主界面就停在「没有匹配的曲目 / 没有选中 / 没有分析档案」的空壳上，
   * 而真正的原因（一条 TypeError）只在控制台里，看一眼就够人抓狂。
   */
  /**
   * 歌词播报器：**等主窗口完全启动之后**再开。
   *
   * 以前是 `setTimeout(700)` 猜时机 —— 冷启动慢一点就抢跑（歌词窗先冒出来，
   * 或者主窗口还没定位、摆位算错）。现在改成握手：曲库加载完、首帧画完之后
   * 主动告诉主进程「我好了」，由主进程去开，并顺手把「要不要自动开」一起带过去
   * （这个偏好存在渲染层的 localStorage 里，主进程读不到）。
   */
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      try {
        void api.win.appReady({ autoLyrics: lyricsAutoOpen.value, autoHelp: helpAutoOpen.value });
      } catch (e) {
        console.error('[app] appReady 上报失败', e);
      }
    });
  });
  window.addEventListener('resize', () => {
    panelH.value = Math.min(panelH.value, maxPanelH());
  });

  /*
   * 量侧栏最小宽度（见 `measureSideMinW`）。
   *
   * 量两次是有原因的：首帧时 `--font-ui` 第一家 Atlas Music 子集可能还没加载完，
   * 那时量到的是回退字体（Segoe UI / 雅黑）的宽度 —— 数字偏小、下限偏低，
   * 等字体一到，中文反而又挤了。`fonts.ready` 是唯一可靠的「字真的到了」信号。
   */
  void nextTick(() => {
    measureSideMinW();
    void document.fonts.ready.then(measureSideMinW).catch(() => undefined);
  });
});

/*
 * 最小宽度会随语言和「栏有没有展开」变：
 *   - 切语言 → 最长的那条文案换了（中英的最宽项根本不是同一条）
 *   - 从收起展开 → 收起时容器宽度是 0，量不出任何东西，只能等展开后再量
 */
watch(locale, () => void nextTick(measureSideMinW));
watch(leftCollapsed, (v) => {
  if (!v) void nextTick(measureSideMinW);
});
/*
 * 主题一变，侧栏用的是另一套留白（浅 / 深各存一份）→ 左右占位变了，下限要重算。
 * 浅色那套通常更小，所以这里多半是把下限**调小** —— 而 `measureSideMinW` 只在
 * 「四块全展开」时才允许调小，正好是这个场景（用户是在选项面板里改的）。
 */
watch(theme, () => void nextTick(measureSideMinW));

/**
 * 布局字段一变就把「上次布局」记一份（防抖在 touchLastLayout 里）。
 * 这样关窗口时不用抢时间写盘 —— 最后一次改动 2.5s 内就落好了。
 */
watch([panelOpen, panelH, leftW, rightW, gridUnit, viewId, themeMode], () => touchLastLayout());

/**
 * 换曲目时重算「撤销 / 重做」的可用性。
 * 广播只在**写历史**时发，切曲不写历史 —— 不主动问一次，菜单会一直显示上一首的状态。
 */
watch(() => detail.value?.analysis?.id ?? null, () => void syncHistMenu());

onBeforeUnmount(() => {
  document.removeEventListener('pointerover', onHelpPointerOver);
  document.removeEventListener('pointerout', onHelpPointerOut);
  window.removeEventListener('keydown', onGlobalKey);
  window.removeEventListener('pointerdown', onDocPointerDown);
  window.removeEventListener('pointerdown', onDocPointerDownMenus);
  window.removeEventListener('keydown', onPlMenuKey);
  offHotkey?.();
  pauseAudio();
  // 主题监听的退订与定时器必须在这里收掉，否则反复挂载会叠出多个 watcher
  unsubSystemTheme?.();
  unsubHelpState?.();
  unsubHelpState = null;
  unsubHistState?.();
  unsubHistState = null;
  unsubHistApplied?.();
  unsubHistApplied = null;
  unsubHistChanged?.();
  unsubHistChanged = null;
  unsubWsChanged?.();
  unsubWsChanged = null;
  unsubOpenGrid?.();
  unsubOpenGrid = null;
  clearTimeout(wsLastTimer);
  if (themeTimer) clearInterval(themeTimer);
});
</script>

<template>
  <div class="shell">
    <!-- 菜单栏：上面一条标题行，下面一条菜单行；右侧空出来给系统原生的窗口按钮 -->
    <MenuBar :menus="menus" :lang="locale" @action="onMenuAction" />

    <!--
      三栏的列宽全由 --left-w / --right-w 决定。收起时把对应列设 0 ——
      内容自动补位（1fr 那一列吃掉空间），不需要重排 DOM。
      边框在 `.collapsed` 里一起收掉，否则会剩一道 1px 的线挂在窗口边上。
    -->
    <div
      class="body"
      :class="{ 'left-collapsed': leftCollapsed, 'right-collapsed': rightCollapsed }"
      :style="{
        '--left-w': (leftCollapsed ? 0 : leftShown) + 'px',
        '--right-w': (rightCollapsed ? 0 : rightW) + 'px',
      }"
    >
      <!-- 侧栏 -->
      <!--
        侧栏。左右留白跟着当前主题走（浅色 / 深色各存一份，见 sideInset）：
        内联变量覆盖 CSS 里那份默认值，`--side-rail` / `--side-pill` / `--side-extend`
        都是从 `--side-inset-l` 派生的，改一个数它们自动跟着变。
      -->
      <aside
        class="sidebar"
        data-help-region="sidebar"
        :style="{ '--side-inset-l': sideInsetNow.l + 'px', '--side-inset-r': sideInsetNow.r + 'px' }"
      >
        <!-- 四块都能折叠：标题整行是开关，默认全展开。
             造型照 Obsidian 的侧栏：**chevron 在文字左边**（收起的角尖朝右、展开朝下），
             子项有明确缩进 + 左边一条竖线（树线），不用实心三角。 -->
        <button
          class="side-h side-toggle"
          :title="t('sidebar.toggle')"
          @click="toggleSide('library')"
          @contextmenu.prevent.stop="openPlMenu($event, null)"
        >
          <svg class="side-chev" :class="{ open: !sideCollapsed.library }" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5 L8 6 L4.5 9.5" />
        </svg>
          <span class="side-title">{{ t('sidebar.library') }}</span>
        </button>
        <div v-if="!sideCollapsed.library" class="side-group">
          <!-- 右键标题 →「搜索播放列表」才出现；输入即过滤标题，Esc / × 收起 -->
          <div v-if="sideSearchOn.library" class="side-search">
            <input
              :ref="(el) => setSideSearchEl('library', el)"
              v-model="sideQuery.library"
              class="side-search-input"
              :placeholder="t('sidebar.searchPlaylistsPh')"
              @dblclick.stop
              @keydown.esc.prevent="closeSideSearch('library')"
            />
            <button class="side-search-x" :title="t('sidebar.searchClose')" @click="closeSideSearch('library')">×</button>
          </div>
          <button
            v-if="sideHit('library', t('sidebar.allTracks'))"
            class="side-i"
            :class="{ on: activeList === ALL_PLAYLIST }"
            @click="pickPlaylist(ALL_PLAYLIST)"
            @contextmenu.prevent.stop="openPlMenu($event, null)"
          >
            <span class="side-label">{{ t('sidebar.allTracks') }}</span>
            <em class="num">{{ meta?.trackCount ?? 0 }}</em>
          </button>
          <template v-for="pl in filteredPlaylists" :key="pl.id">
            <!-- 改名就地改：不弹输入框，改完 Enter / 失焦即落盘 -->
            <span v-if="plRename?.id === pl.id" class="side-i side-rename">
              <input
                :ref="setRenameInput"
                v-model="plRename.text"
                class="rename-input"
                @dblclick.stop
                @keydown.enter.prevent="commitRename()"
                @keydown.esc.prevent="plRename = null"
                @blur="commitRename()"
              />
            </span>
            <button
              v-else
              class="side-i"
              :class="{ on: activeList === pl.id }"
              :title="pl.name"
              @click="pickPlaylist(pl.id)"
              @contextmenu.prevent.stop="openPlMenu($event, pl.id)"
            >
              <span class="side-name">{{ pl.name }}</span>
              <em class="num">{{ pl.trackIds.length }}</em>
            </button>
          </template>
          <div v-if="sideSearchOn.library && !playlistVisibleCount" class="side-empty">
            {{ t('sidebar.searchEmpty') }}
          </div>
        </div>

        <button
          class="side-h side-toggle"
          :title="t('sidebar.toggle')"
          @click="toggleSide('views')"
          @contextmenu.prevent.stop="openPlMenu($event, null, 'views')"
        >
          <svg class="side-chev" :class="{ open: !sideCollapsed.views }" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5 L8 6 L4.5 9.5" />
        </svg>
          <span class="side-title">{{ t('sidebar.views') }}</span>
        </button>
        <div v-if="!sideCollapsed.views" class="side-group">
          <div v-if="sideSearchOn.views" class="side-search">
            <input
              :ref="(el) => setSideSearchEl('views', el)"
              v-model="sideQuery.views"
              class="side-search-input"
              :placeholder="t('sidebar.searchViewsPh')"
              @dblclick.stop
              @keydown.esc.prevent="closeSideSearch('views')"
            />
            <button class="side-search-x" :title="t('sidebar.searchClose')" @click="closeSideSearch('views')">×</button>
          </div>
          <button
            v-for="v in filteredViews"
            :key="v.id"
            class="side-i"
            :class="{ on: viewId === v.id }"
            @click="pickView(v.id)"
          >
            <span class="side-label">{{ v.name }}</span>
            <em class="num">{{ v.lanes.length }}</em>
          </button>
          <div v-if="sideSearchOn.views && !filteredViews.length" class="side-empty">
            {{ t('sidebar.searchEmpty') }}
          </div>
        </div>

        <button
          class="side-h side-toggle"
          :title="t('sidebar.toggle')"
          @click="toggleSide('vocab')"
          @contextmenu.prevent.stop="openPlMenu($event, null, 'vocab')"
        >
          <svg class="side-chev" :class="{ open: !sideCollapsed.vocab }" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5 L8 6 L4.5 9.5" />
        </svg>
          <span class="side-title">
            {{ t('sidebar.vocab') }}
            <span class="faint">{{ t('sidebar.vocabSource') }}</span>
          </span>
        </button>
        <div v-if="!sideCollapsed.vocab" class="side-group">
          <div v-if="sideSearchOn.vocab" class="side-search">
            <input
              :ref="(el) => setSideSearchEl('vocab', el)"
              v-model="sideQuery.vocab"
              class="side-search-input"
              :placeholder="t('sidebar.searchVocabPh')"
              @dblclick.stop
              @keydown.esc.prevent="closeSideSearch('vocab')"
            />
            <button class="side-search-x" :title="t('sidebar.searchClose')" @click="closeSideSearch('vocab')">×</button>
          </div>
          <!-- 点一行就是打开这一维度的词表编辑器：普通用户不用碰 JSON -->
          <template v-for="v in meta?.vocabs ?? []" :key="v.dim">
            <button
              v-if="sideHit('vocab', dimLabel(v.dim))"
              class="side-row"
              :title="t('sidebar.vocabEdit')"
              @click="vocabDim = v.dim"
            >
              <span class="side-label">{{ dimLabel(v.dim) }}</span><span class="num faint">{{ v.count }}</span>
            </button>
          </template>
          <!-- 和弦符号补全词表：不是标签维度，所以不跟上面一批混在一起 -->
          <button
            v-if="sideHit('vocab', t('sidebar.chordSymbols'))"
            class="side-row"
            :title="t('sidebar.chordSymbolsEdit')"
            @click="showChordSymbols = true"
          >
            <span class="side-label">{{ t('sidebar.chordSymbols') }}</span
            ><span class="num faint">{{ chordQualityCount ?? '—' }}</span>
          </button>
          <!-- 速度术语：乐章标题补全的一半（另一半是体裁，走上面的词表编辑器） -->
          <button
            v-if="sideHit('vocab', t('sidebar.tempoMarkings'))"
            class="side-row"
            :title="t('sidebar.tempoMarkingsEdit')"
            @click="api.movement?.openFile?.()"
          >
            <span class="side-label">{{ t('sidebar.tempoMarkings') }}</span
            ><span class="num faint">{{ tempoMarkCount ?? '—' }}</span>
          </button>
          <div v-if="sideSearchOn.vocab && !vocabVisibleCount" class="side-empty">
            {{ t('sidebar.searchEmpty') }}
          </div>
        </div>

        <button class="side-h side-toggle" :title="t('sidebar.toggle')" @click="toggleSide('maintenance')">
          <svg class="side-chev" :class="{ open: !sideCollapsed.maintenance }" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4.5 2.5 L8 6 L4.5 9.5" />
        </svg>
          <span class="side-title">{{ t('menu.maintenance') }}</span>
        </button>
        <div v-if="!sideCollapsed.maintenance" class="side-group">
          <button class="side-i" @click="checkOrphans">
            <span class="side-label">{{ t('sidebar.orphans') }}</span>
            <em v-if="orphans.length" class="warn num">{{ orphans.length }}</em>
          </button>
          <button class="side-i" @click="api.openDataDir()">
            <span class="side-label">{{ t('sidebar.openData') }}</span>
          </button>
          <!-- 帮助作者也是帮助：完全自愿，不影响任何功能 -->
          <button class="side-i" @click="openSupport()">
            <span class="side-label">{{ t('sidebar.support') }}</span>
          </button>
        </div>
      </aside>

      <!-- 主区 -->
      <main class="main">
        <!-- 搜索框只占中间这一列的宽度（不通栏）：它筛的是这张表，不是整个窗口 -->
        <div class="searchrow" data-help-region="library">
          <div class="search-wrap">
            <input
              ref="searchEl"
              v-model="text"
              class="search"
              :placeholder="t('search.placeholder')"
              :title="t('search.hint')"
              @keydown="onSearchKey"
              @focus="onSearchFocus"
              @blur="onSearchBlur"
            />
            <!-- 候选取自词表：↑↓ 选、Enter 确认、Esc 收起。补的是「正在敲的那个词」 -->
            <ul v-if="sugOpen && suggestions.length" class="sug">
              <li
                v-for="(s, i) in suggestions"
                :key="s.kind + s.id"
                :class="{ on: i === sugIndex }"
                @mousemove="sugIndex = i"
                @mousedown.prevent="applySuggestion(s)"
              >
                <span class="s-main">{{ sugLabel(s) }}</span>
                <em v-if="sugHint(s)" class="s-hint">{{ sugHint(s) }}</em>
              </li>
            </ul>
          </div>
          <button class="sr-btn" :title="t('search.clearTitle')" @click="clearSearch">
            {{ t('search.clear') }}
          </button>
        </div>

        <div class="table-pane">
          <LibraryView
            data-help-region="library"
            :rows="listRows"
            :selected-id="selectedId"
            :loading="loading"
            :editing-id="editRowId"
            :edit-caret-end="editCaretEnd"
            :edit-prefix="editPrefix"
            :active-rec-id="activeRecording?.id ?? null"
            @select="select"
            @select-version="selectVersion"
            @play="playRow"
            @play-version="playVersion"
            @rename="renameRow"
            @cancel-rename="cancelRename"
            @context-track="openTrackMenu"
            @context-version="openRecMenu"
          />
        </div>

        <!--
          下方面板：像 DAW 的 lower zone，但**不覆盖**表格 —— 两者上下分栏，各占各的高度。
          早先是 absolute 浮在表格上，代价是表格的纵向滚动条下半截被盖住（点不到），
          用户 2026-11-23 要求改成真正的分栏。上边缘可拖，双击收起。
        -->
        <!-- data-help-region：鼠标停在这块时，帮助窗口换成这一块的提示 -->
        <div v-show="panelOpen" class="dock" data-help-region="grid" :style="{ height: panelH + 'px' }">
          <div
            class="splitter"
            :title="t('grid.splitterTitle')"
            @pointerdown.prevent="startResize"
            @dblclick="togglePanel()"
          >
            <span class="grip" />
          </div>

          <section class="bottom-panel">
            <GridEditor
              :analysis="viewAnalysis"
              :view="currentView"
              :title="detailTitleText"
              :unit="gridUnit"
              @unit-change="gridUnit = $event"
              @changed="refreshDetail"
            >
              <template #actions>
                <button class="chip" :title="t('menu.view.popout')" @click="popOut">
                  ↗ {{ t('grid.popout') }}
                </button>
                <button class="chip" :title="t('menu.view.panel') + ' (Ctrl+J)'" @click="togglePanel(false)">×</button>
              </template>
            </GridEditor>
          </section>
        </div>
      </main>

      <!-- 左右两个拖拽手柄：absolute 定位，绝不占 grid 列（少一列会让内容掉到下一行） -->
      <div
        class="vsplit left"
        :title="t('shell.resizeHint')"
        @pointerdown="startSplit('left', $event)"
        @pointermove="moveSplit"
        @pointerup="endSplit"
        @pointercancel="endSplit"
      />
      <div
        class="vsplit right"
        :title="t('shell.resizeHint')"
        @pointerdown="startSplit('right', $event)"
        @pointermove="moveSplit"
        @pointerup="endSplit"
        @pointercancel="endSplit"
      />

      <!--
        边缘悬停块：点一下收起 / 展开这根栏。
        识别区 22 × 96px，**朝曲目列表那一侧偏 18px**、往栏内只探 4px ——
        探进去就挡行尾的点击了，而内侧那 4px 正好是 `--side-inset-r` 的空白，安全。
        在这个块上按住横向拖超过 4px，会自动转成正常的拖宽（两种意图共用一个手势）。
      -->
      <div
        class="edge-tab left"
        :class="{ collapsed: leftCollapsed }"
        :title="t(leftCollapsed ? 'shell.expandLeft' : 'shell.collapseLeft')"
        @pointerdown="onEdgeDown('left', $event)"
        @pointermove="onEdgeMove"
        @pointerup="onEdgeUp"
        @pointercancel="onEdgeUp"
      >
        <span class="edge-tab-knob">
          <svg class="edge-tab-chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4.5 2.5 L8 6 L4.5 9.5" />
          </svg>
        </span>
      </div>
      <div
        class="edge-tab right"
        :class="{ collapsed: rightCollapsed }"
        :title="t(rightCollapsed ? 'shell.expandRight' : 'shell.collapseRight')"
        @pointerdown="onEdgeDown('right', $event)"
        @pointermove="onEdgeMove"
        @pointerup="onEdgeUp"
        @pointercancel="onEdgeUp"
      >
        <span class="edge-tab-knob">
          <svg class="edge-tab-chev" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4.5 2.5 L8 6 L4.5 9.5" />
          </svg>
        </span>
      </div>

      <!-- 详情：模块清单是固定的，但每首曲目可以右键决定显示哪几块 -->
      <aside class="detail" v-if="detail" data-help-region="detail" @contextmenu.prevent="onDetailContextMenu">
        <div class="d-head">
          <h2>
            <input
              v-if="editField === 'title'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input title"
              :placeholder="t('detail.editTitle')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown="onFieldKey"
              @input="onFieldInput"
              @click="onFieldCaret"
              @blur="commitOnBlur"
            />
            <span
              v-else
              class="editable title-text"
              :title="t('detail.dblclick')"
              @dblclick.stop="startEdit('title')"
              >{{ detailTitleText }}</span
            >
            <ul v-if="editField === 'title' && fieldSugOpen" class="field-sug title-sug">
              <li
                v-for="(s, i) in fieldSug"
                :key="s.id"
                :class="{ on: i === fieldSugActive }"
                @mousemove="fieldSugActive = i"
                @mousedown.prevent="applyFieldSug(s)"
              >
                <span class="sug-name">{{ s.name }}</span>
                <em class="sug-template">{{ s.template ?? s.desc }}</em>
              </li>
            </ul>
            <button
              class="play-btn"
              :title="detail.hasAudio ? t('detail.play.audio') : neteaseUrl ? t('detail.play.cloud') : t('detail.play.none')"
              :disabled="!detail.hasAudio && !neteaseUrl"
              @click="playRow(detail)"
            >
              ▶
            </button>
          </h2>
          <p v-if="showSection('subtitle')" class="subtitle" :class="{ empty: !detail.subtitle }">
            <input
              v-if="editField === 'subtitle'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editSubtitle')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <span
              v-else
              class="editable"
              :title="t('detail.editSubtitle')"
              @dblclick.stop="startEdit('subtitle')"
              >{{ detail.subtitle || t('detail.subtitle') }}</span
            >
          </p>
          <p class="d-period" :class="{ empty: !periodText }">
            <input
              v-if="editField === 'period'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editPeriod')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <span
              v-else
              class="editable"
              :title="t('detail.editPeriod')"
              @dblclick.stop="startEdit('period')"
              >{{ periodText || t('dim.period') }}</span
            >
          </p>
          <!-- 流派：与时期并列，但它是「写法与来源」，与历史分期不是一回事 -->
          <div class="d-genre" :class="{ empty: !genreText }">
            <input
              v-if="editField === 'genre'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editGenre')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown="onFieldKey"
              @input="onFieldInput"
              @blur="commitOnBlur"
            />
            <span
              v-else
              class="editable"
              :title="t('detail.editGenre')"
              @dblclick.stop="startEdit('genre')"
              >{{ genreText || t('dim.genre') }}</span
            >
            <ul v-if="editField === 'genre' && fieldSugOpen" class="field-sug">
              <li
                v-for="(s, i) in fieldSug"
                :key="s.id"
                :class="{ on: i === fieldSugActive }"
                @mousemove="fieldSugActive = i"
                @mousedown.prevent="applyFieldSug(s)"
              >
                <span>{{ locale === 'en' ? s.name : s.display || s.name }}</span>
                <em>{{ t('sug.how.' + s.how) }}</em>
              </li>
            </ul>
          </div>
          <!-- 专辑：自由文本，不进词表 -->
          <p class="d-album" :class="{ empty: !detail.album }">
            <input
              v-if="editField === 'album'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editAlbum')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <span
              v-else
              class="editable"
              :title="t('detail.editAlbum')"
              @dblclick.stop="startEdit('album')"
              >{{ detail.album || t('detail.album') }}</span
            >
          </p>
          <!-- 专辑序号：这张专辑里第几首。专辑是自由文本，序号是它内部的顺序 -->
          <p class="d-album-no" :class="{ empty: detail.albumTrackNo == null }">
            <span class="k">{{ t('detail.albumNo') }}</span>
            <input
              v-if="editField === 'albumNo'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input num"
              type="number"
              min="1"
              step="1"
              :placeholder="t('detail.editAlbumNo')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <span
              v-else
              class="editable"
              :title="t('detail.editAlbumNo')"
              @dblclick.stop="startEdit('albumNo')"
              >{{ detail.albumTrackNo == null ? t('detail.none') : t('detail.albumNoValue', { n: detail.albumTrackNo }) }}</span
            >
          </p>
          <!-- 歌词挪到「音源与录音版本」区块的图片绑定下方 ——
               连接、绑定这一类「把外部文件接进来」的动作集中在一处，
               不用在面板上下两头来回找。 -->
          <!-- 别名只加一个冒号，词与词之间维持原来的「/」分隔 -->
          <p v-if="showSection('aliases')" class="alias-line" :class="{ empty: !detail.aliases?.length }">
            <span class="k">{{ t('detail.alias') }}</span>
            <input
              v-if="editField === 'aliases'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editAliases')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <span
              v-else
              class="editable"
              :title="t('detail.editAliases')"
              @dblclick.stop="startEdit('aliases')"
              >{{ detail.aliases?.length ? detail.aliases.join(' / ') : t('detail.none') }}</span
            >
          </p>
          <div
            v-if="showSection('moods')"
            class="moods"
            :class="{ empty: !detail.moods?.length }"
            :title="t('detail.editMoods')"
            @dblclick.stop="startEdit('moods')"
          >
            <input
              v-if="editField === 'moods'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editMoods')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown="onFieldKey"
              @input="onFieldInput"
              @blur="commitOnBlur"
            />
            <ul v-if="editField === 'moods' && fieldSugOpen" class="field-sug">
              <li
                v-for="(s, i) in fieldSug"
                :key="s.id"
                :class="{ on: i === fieldSugActive }"
                @mousemove="fieldSugActive = i"
                @mousedown.prevent="applyFieldSug(s)"
              >
                <span>{{ locale === 'en' ? s.name : s.display || s.name }}</span>
                <em>{{ t('sug.how.' + s.how) }}</em>
              </li>
            </ul>
            <template v-if="editField !== 'moods'">
              <span v-for="m in detail.moods" :key="m" class="mood">{{ moodLabel(m, locale) }}</span>
              <span v-if="!detail.moods?.length" class="editable">{{ t('dim.mood') }}</span>
            </template>
          </div>
        </div>

        <!-- 拍号 / 速度 + 调性：值一律左对齐，冒号紧贴标签 -->
        <div class="d-sec" v-if="showSection('meter') || showSection('key')">
          <div v-if="showSection('meter')" class="d-row">
            <span class="k">{{ t('detail.meterBpm') }}</span>
            <b class="num v">
              <input
                v-if="editField === 'meter'"
                ref="editInputEl"
                v-model="editDraft"
                class="edit-input meter"
                :placeholder="t('detail.editMeter')"
                :disabled="editSaving"
                @dblclick.stop
                @keydown.stop
                @keydown.enter.prevent="commitOnEnter"
                @keydown.esc.prevent="cancelEdit"
                @blur="commitOnBlur"
              />
              <span
                v-else
                class="editable meter-val"
                :class="{ untagged: !detail.meter }"
                :title="detail.meter ? t('detail.editMeter') : t('detail.untaggedMeterHint')"
                @dblclick.stop="startEdit('meter')"
                >{{ detail.meter ?? t('detail.untagged') }}</span
              >
              <span class="dot"> · </span>
              <input
                v-if="editField === 'bpm'"
                ref="editInputEl"
                v-model="editDraft"
                class="edit-input bpm"
                :placeholder="t('detail.editBpm')"
                :disabled="editSaving"
                @dblclick.stop
                @keydown.stop
                @keydown.enter.prevent="commitOnEnter"
                @keydown.esc.prevent="cancelEdit"
                @blur="commitOnBlur"
              />
              <span
                v-else
                class="editable bpm-val"
                :class="{ untagged: detail.bpm == null }"
                :title="detail.bpm != null ? t('detail.editBpm') : t('detail.untaggedBpmHint')"
                @dblclick.stop="startEdit('bpm')"
                >{{ detail.bpm ?? t('detail.untagged') }}</span
              >
              <span class="dot"> BPM</span>
              <!-- 拍号类型是算出来的（单/复/混合）。两套体系结论相反时挂 ⓘ：
                   悬停立刻出说明，不走 title 的浏览器延迟 -->
              <template v-if="meterKind">
                <span class="dot"> · </span>
                <span class="mt-type" :class="{ amb: meterKind.ambiguous }">
                  <span class="mt-kind">{{ t(meterKind.kindKey) }}</span>
                  <!-- 圆圈 i 紧跟在文字右边（不是右上角的上标）。
                       悬停 / 聚焦 → 立刻出说明；鼠标移开 → 等 1s 再收（能挪进气泡里）；
                       点一下 → 钉住，再点 / 点别处 / Esc → 收起。
                       图形用 SVG 画而不是「border-radius 的 1px 圆环」：
                       11px 的 CSS 圆环在 125% 缩放下落在半像素上，边上一圈全是锯齿。 -->
                  <span
                    v-if="meterKind.ambiguous"
                    class="mt-i"
                    :class="{ pinned: tipPinned }"
                    role="button"
                    tabindex="0"
                    @mouseenter="openMeterTip"
                    @mouseleave="scheduleTipClose"
                    @focus="openMeterTip"
                    @blur="scheduleTipClose"
                    @click.stop="toggleMeterPin"
                  >
                    <svg viewBox="0 0 13 13" width="13" height="13" aria-hidden="true">
                      <circle cx="6.5" cy="6.5" r="5.4" fill="none" stroke="currentColor" stroke-width="1.45" />
                      <rect x="5.85" y="3.1" width="1.3" height="1.4" rx="0.5" fill="currentColor" />
                      <rect x="5.9" y="6.05" width="1.2" height="3.5" rx="0.6" fill="currentColor" />
                    </svg>
                  </span>
                </span>
              </template>
            </b>
          </div>
          <div v-if="showSection('key')" class="d-row">
            <span class="k">{{ t('detail.key') }}</span>
            <!-- 每个调名是一个整体：宁可整组换行，也不把 f natural minor 拆成 f / natural minor -->
            <b
              class="keys v"
              :class="{ empty: !detail.keys.length }"
              :title="t('detail.editKeys')"
              @dblclick.stop="startEdit('keys')"
            >
              <input
                v-if="editField === 'keys'"
                ref="editInputEl"
                v-model="editDraft"
                class="edit-input"
                :placeholder="t('detail.editKeys')"
                :disabled="editSaving"
                @dblclick.stop
                @keydown.stop
                @keydown.enter.prevent="commitOnEnter"
                @keydown.esc.prevent="cancelEdit"
                @blur="commitOnBlur"
              />
              <template v-else-if="detail.keys.length">
                <span v-for="(k, i) in detail.keys" :key="k + i" class="key-item">
                  <span v-if="i" class="arrow">→</span>{{ k }}
                </span>
              </template>
              <span v-else class="editable">{{ t('detail.none') }}</span>
            </b>
          </div>
        </div>

        <div class="d-sec" v-if="showSection('credits')">
          <div class="d-h">{{ t('detail.credits') }}</div>
          <div v-for="c in creditRows" :key="c.key" class="d-row">
            <span class="k">{{ c.label }}</span>
            <input
              v-if="editField === `credit:${c.key}`"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editCredit')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <b
              v-else
              class="credit v editable"
              :title="t('detail.editCredit')"
              @dblclick.stop="startEdit(`credit:${c.key}`)"
              >{{ c.value }}</b
            >
          </div>
          <!-- 一条都没有时留一个默认项：否则新登记的曲目没有地方加制作名单 -->
          <div v-if="!creditRows.length" class="d-row">
            <span class="k">{{ t('credit.composer') }}</span>
            <input
              v-if="editField === 'credit:composer'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editCredit')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <b
              v-else
              class="credit v editable empty"
              :title="t('detail.editCredit')"
              @dblclick.stop="startEdit('credit:composer')"
              >{{ t('detail.none') }}</b
            >
          </div>
        </div>

        <!-- 作曲技法在乐器之前：先说怎么写，再说谁在演奏 -->
        <div class="d-sec" v-if="showSection('composition')">
          <div class="d-h">{{ t('dim.composition') }}</div>
          <div v-if="tagsByDim.composition?.length" class="tag-list">
            <span v-for="tag in tagsByDim.composition" :key="tag.id" class="tag">
              <b>{{ tag.display }}</b>
              <button class="x" :title="t('detail.removeTag')" @click="removeTag(tag.id)">×</button>
            </span>
          </div>
          <p v-else class="faint tiny">{{ t('detail.none') }}</p>
          <div class="picker-row">
            <TagPicker
              v-if="selectedId"
              :track-id="selectedId"
              dim="composition"
              :label="t('detail.addComposition')"
              @changed="refreshDetail"
            />
          </div>
        </div>

        <!-- 乐器组合：摘要（这一首到底用了什么编制）+ 乐器 + 演奏技法 -->
        <div class="d-sec" v-if="showSection('instrumentation')">
          <div class="d-h plain">{{ t('detail.instrumentation') }}</div>
          <div class="d-row">
            <span class="k">{{ t('detail.instrumentationAbstract') }}</span>
            <input
              v-if="editField === 'instrumentationAbstract'"
              ref="editInputEl"
              v-model="editDraft"
              class="edit-input"
              :placeholder="t('detail.editAbstract')"
              :disabled="editSaving"
              @dblclick.stop
              @keydown.stop
              @keydown.enter.prevent="commitOnEnter"
              @keydown.esc.prevent="cancelEdit"
              @blur="commitOnBlur"
            />
            <b
              v-else
              class="v editable"
              :class="{ empty: !detail.instrumentationAbstract }"
              :title="t('detail.editAbstract')"
              @dblclick.stop="startEdit('instrumentationAbstract')"
              >{{ detail.instrumentationAbstract || t('detail.none') }}</b
            >
          </div>

          <div class="d-sub">
            <div class="d-sub-h">{{ t('detail.instruments') }}</div>
            <div v-if="tagsByDim.instrument?.length" class="tag-list">
              <span v-for="tag in tagsByDim.instrument" :key="tag.id" class="tag">
                <b>{{ tag.display }}</b>
                <button class="x" :title="t('detail.removeTag')" @click="removeTag(tag.id)">×</button>
              </span>
            </div>
            <p v-else class="faint tiny">{{ t('detail.none') }}</p>
            <div class="picker-row">
              <TagPicker
                v-if="selectedId"
                :track-id="selectedId"
                dim="instrument"
                :label="t('detail.addInstrument')"
                @changed="refreshDetail"
              />
            </div>
          </div>

          <div class="d-sub">
            <div class="d-sub-h">{{ t('detail.instrumentTech') }}</div>
            <div v-if="tagsByDim.instrument_technique?.length" class="tag-list">
              <span v-for="tag in tagsByDim.instrument_technique" :key="tag.id" class="tag">
                <b>{{ tag.display }}</b>
                <button class="x" :title="t('detail.removeTag')" @click="removeTag(tag.id)">×</button>
              </span>
            </div>
            <p v-else class="faint tiny">{{ t('detail.none') }}</p>
            <div class="picker-row">
              <TagPicker
                v-if="selectedId"
                :track-id="selectedId"
                dim="instrument_technique"
                :label="t('detail.addInstrumentTech')"
                @changed="refreshDetail"
              />
            </div>
          </div>
        </div>

        <!-- 体裁与结构：放在「谁在演奏」之后、「时间轴 · 段落」之前 ——
             先说这是一部什么作品、按什么骨架长成，再往下才是逐段的时间轴。
             只留**整曲一条**抽象结论（奏鸣曲式 / 复三部曲式），不做逐段曲式标注：
             分段已经有时间轴那一块了，两处都标就会变成两份需要同步的真相。 -->
        <div class="d-sec" v-if="showSection('structure')">
          <div class="d-h plain">{{ t('detail.structure') }}</div>

          <div class="d-pick" data-field="compositionType">
            <div class="d-row">
              <span class="k">{{ t('detail.compositionType') }}</span>
              <input
                v-if="editField === 'compositionType'"
                ref="editInputEl"
                v-model="editDraft"
                class="edit-input"
                :placeholder="t('detail.editCompositionType')"
                :disabled="editSaving"
                @dblclick.stop
                @keydown.stop
                @keydown="onFieldKey"
                @input="onFieldInput"
                @blur="commitOnBlur"
              />
              <b
                v-else
                class="v editable"
                :class="{ empty: !compositionTypeText }"
                :title="t('detail.editCompositionType')"
                @dblclick.stop="startEdit('compositionType')"
                >{{ compositionTypeText || t('detail.none') }}</b
              >
            </div>
            <ul v-if="editField === 'compositionType' && fieldSugOpen" class="field-sug">
              <li
                v-for="(s, i) in fieldSug"
                :key="s.id"
                :class="{ on: i === fieldSugActive }"
                @mousemove="fieldSugActive = i"
                @mousedown.prevent="applyFieldSug(s)"
              >
                <span>{{ locale === 'en' ? s.name : s.display || s.name }}</span>
                <em>{{ t('sug.how.' + s.how) }}</em>
              </li>
            </ul>
          </div>

          <div class="d-pick" data-field="form">
            <div class="d-row">
              <span class="k">{{ t('detail.form') }}</span>
              <input
                v-if="editField === 'form'"
                ref="editInputEl"
                v-model="editDraft"
                class="edit-input"
                :placeholder="t('detail.editForm')"
                :disabled="editSaving"
                @dblclick.stop
                @keydown.stop
                @keydown="onFieldKey"
                @input="onFieldInput"
                @blur="commitOnBlur"
              />
              <b
                v-else
                class="v editable"
                :class="{ empty: !formText }"
                :title="t('detail.editForm')"
                @dblclick.stop="startEdit('form')"
                >{{ formText || t('detail.none') }}</b
              >
            </div>
            <ul v-if="editField === 'form' && fieldSugOpen" class="field-sug">
              <li
                v-for="(s, i) in fieldSug"
                :key="s.id"
                :class="{ on: i === fieldSugActive }"
                @mousemove="fieldSugActive = i"
                @mousedown.prevent="applyFieldSug(s)"
              >
                <span>{{ locale === 'en' ? s.name : s.display || s.name }}</span>
                <em>{{ t('sug.how.' + s.how) }}</em>
              </li>
            </ul>
          </div>

          <!-- 作品编号 / 作品号：古典标题模板里的 No.1 与 Op.2, No.1。
               流行作品没有作品号时填 N/A，中文界面读作「不适用」。
               这两项只对母作品 / 独立作品有意义，乐章子项不重复显示。 -->
          <template v-if="!detail.parentId">
            <div class="d-pick" data-field="formNumber">
              <div class="d-row">
                <span class="k">{{ t('detail.formNumber') }}</span>
                <input
                  v-if="editField === 'formNumber'"
                  ref="editInputEl"
                  v-model="editDraft"
                  class="edit-input"
                  :placeholder="t('detail.editFormNumber')"
                  :disabled="editSaving"
                  @dblclick.stop
                  @keydown.stop
                  @keydown.enter.prevent="commitOnEnter"
                  @keydown.esc.prevent="cancelEdit"
                  @blur="commitOnBlur"
                />
                <b
                  v-else
                  class="v editable"
                  :class="{ empty: !formNumberText }"
                  :title="t('detail.editFormNumber')"
                  @dblclick.stop="startEdit('formNumber')"
                  >{{ formNumberText || t('detail.none') }}</b
                >
              </div>
            </div>

            <div class="d-pick" data-field="opusNumber">
              <div class="d-row">
                <span class="k">{{ t('detail.opusNumber') }}</span>
                <input
                  v-if="editField === 'opusNumber'"
                  ref="editInputEl"
                  v-model="editDraft"
                  class="edit-input"
                  :placeholder="t('detail.editOpusNumber')"
                  :disabled="editSaving"
                  @dblclick.stop
                  @keydown.stop
                  @keydown.enter.prevent="commitOnEnter"
                  @keydown.esc.prevent="cancelEdit"
                  @blur="commitOnBlur"
                />
                <b
                  v-else
                  class="v editable"
                  :class="{ empty: !opusNumberText }"
                  :title="t('detail.editOpusNumber')"
                  @dblclick.stop="startEdit('opusNumber')"
                  >{{ opusNumberText || t('detail.none') }}</b
                >
              </div>
            </div>
          </template>

          <!-- 乐章的两项：子体裁从体裁树补全，速度术语是自由文本。
               标题模板 `%Sub-Type}` / `%Tempo Term}` 就取这里，缺哪项就整段省略。 -->
          <template v-if="detail.parentId">
            <div class="d-pick" data-field="subType">
              <div class="d-row">
                <span class="k">{{ t('detail.subType') }}</span>
                <input
                  v-if="editField === 'subType'"
                  ref="editInputEl"
                  v-model="editDraft"
                  class="edit-input"
                  :placeholder="t('detail.editSubType')"
                  :disabled="editSaving"
                  @dblclick.stop
                  @keydown.stop
                  @keydown="onFieldKey"
                  @input="onFieldInput"
                  @blur="commitOnBlur"
                />
                <b
                  v-else
                  class="v editable"
                  :class="{ empty: !subTypeText }"
                  :title="t('detail.editSubType')"
                  @dblclick.stop="startEdit('subType')"
                  >{{ subTypeText || t('detail.none') }}</b
                >
              </div>
              <ul v-if="editField === 'subType' && fieldSugOpen" class="field-sug">
                <li
                  v-for="(s, i) in fieldSug"
                  :key="s.id"
                  :class="{ on: i === fieldSugActive }"
                  @mousemove="fieldSugActive = i"
                  @mousedown.prevent="applyFieldSug(s)"
                >
                  <span>{{ locale === 'en' ? s.name : s.display || s.name }}</span>
                  <em>{{ t('sug.how.' + s.how) }}</em>
                </li>
              </ul>
            </div>

            <div class="d-pick" data-field="tempoTerm">
              <div class="d-row">
                <span class="k">{{ t('detail.tempoTerm') }}</span>
                <input
                  v-if="editField === 'tempoTerm'"
                  ref="editInputEl"
                  v-model="editDraft"
                  class="edit-input"
                  :placeholder="t('detail.editTempoTerm')"
                  :disabled="editSaving"
                  @dblclick.stop
                  @keydown.stop
                  @keydown.enter.prevent="commitOnEnter"
                  @keydown.esc.prevent="cancelEdit"
                  @blur="commitOnBlur"
                />
                <b
                  v-else
                  class="v editable"
                  :class="{ empty: !tempoTermText }"
                  :title="t('detail.editTempoTerm')"
                  @dblclick.stop="startEdit('tempoTerm')"
                  >{{ tempoTermText || t('detail.none') }}</b
                >
              </div>
            </div>
          </template>
        </div>

        <div class="d-sec" v-if="showSection('timeline') && sectionRows.length">
          <div class="d-h">{{ t('detail.timeline') }}</div>
          <table class="sections">
            <thead>
              <tr><th class="num">#</th><th>{{ t('detail.colSection') }}</th><th class="num w-time">{{ t('detail.colTime') }}</th><th>{{ t('detail.key') }}</th></tr>
            </thead>
            <tbody>
              <tr
                v-for="(s, i) in sectionRows"
                :key="s.id"
                class="sec-row"
                :title="t('detail.seekHint')"
                @dblclick="seekToSection(s)"
              >
                <td class="num faint">{{ i + 1 }}</td>
                <td>{{ s.label }}</td>
                <!-- 时间：小节.拍.十六分.tick。不补 0，靠每段固定宽度的格子右对齐，
                     这样点号永远落在同一列（Cubase 的观感）；毫秒留在悬停提示里。
                     播放条主时间用同一个 BarBeatText，两处不许各写一套。 -->
                <td class="num dim" :title="formatMs(s.time)">
                  <BarBeatText :pos="s.pos" />
                </td>
                <td :class="{ dim: s.key && s.key.confidence !== 'confirmed' }">{{ keyText(s.key) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 音源与录音版本：合成一块。以前「本地音频已绑定」和「录音版本列表」
             说的是同一件事，分两处显示反而要人自己对。 -->
        <div class="d-sec" v-if="showSection('sources')">
          <div class="d-h d-h-act">
            <span>{{ t('detail.sources') }}</span>
            <span class="d-h-count">{{ t('rec.count', { n: recordings.length }) }}</span>
            <!-- 版本一多，逐版本的三四个按钮会把面板挤爆；统一收进管理窗口。
                 打开时定位到「当前在看的这一版」，而不是永远第一条。 -->
            <button class="chip tiny d-manage" @click="openRecManager(activeRecording?.id)">
              {{ t('rec.manage') }}
            </button>
          </div>

          <!-- 作品层的网易云链接仍单独一行：它属于「这部作品在网上有」，
               而不是某一个录音版本 -->
          <div class="d-row" v-if="neteaseUrl">
            <span class="k">{{ t('detail.netease') }}</span>
            <b class="v"><button class="chip" :title="t('detail.openTitle')" @click="openLink(neteaseUrl)">{{ t('detail.open') }}</button></b>
          </div>
          <p v-if="!detail.hasAudio && neteaseUrl" class="faint tiny">
            {{ t('detail.neteaseNote') }}
          </p>

          <!-- 录音版本：只给一行摘要（谁演的 · 哪年 · 多长 · 来源）。
               单击 = 切到这一版（波形、播放条的原点都跟着它）；双击 = 打开管理窗口。
               和中间列表的版本子行保持同一套手势，免得同一个动作在两处有两种含义。
               顺序第一的那条绿点常亮 —— 点作品播放会先播它，但不写任何文字标签。 -->
          <div class="rec-list">
            <button
              v-for="r in recordings"
              :key="r.id"
              class="rec-item"
              :class="{ on: activeRecording?.id === r.id }"
              :data-rec-id="r.id"
              :title="t('rec.rowHint')"
              @click="selectVersion({ row: detail, rec: r })"
              @dblclick="openRecManager(r.id)"
              @contextmenu.prevent="openRecMenu({ row: detail, rec: r, x: $event.clientX, y: $event.clientY })"
            >
              <span class="rec-dot" :class="{ on: r.isDefault }" />
              <span class="rec-name">{{ recName(r) }}</span>
              <span class="rec-meta">{{ recMeta(r) }}</span>
              <span class="rec-src" :class="recSourceKind(r)">{{ recSourceLabel(r) }}</span>
            </button>
            <p v-if="!recordings.length" class="faint tiny">{{ t('rec.empty') }}</p>
          </div>

          <!-- 封面：跟在音频下面。只显示绿色文件名（省地方、不抢戏），点开才看图 -->
          <div class="d-covers">
            <template v-if="detail.covers?.url">
              <button class="cover-file" :title="t('detail.coverView')" @click="viewCover">
                {{ coverName }}
              </button>
              <button class="chip tiny" :title="t('detail.coverClear')" @click="api.art.clear(detail.id, detail.covers.source)">{{ t('detail.coverClear') }}</button>
            </template>
            <template v-else>
              <button class="cover-add" :title="t('detail.coverPick')" @click="api.art.pick(detail.id, 'single')">+ {{ t('detail.coverSingle') }}</button>
              <button class="cover-add" :title="t('detail.coverPick')" @click="api.art.pick(detail.id, 'album')">+ {{ t('detail.coverAlbum') }}</button>
            </template>
          </div>

          <!-- 歌词：紧跟在图片绑定后面。两者都是「把外部文件接到这首作品上」 -->
          <div class="d-lyrics">
            <span class="k">{{ t('detail.lyrics') }}</span>
            <template v-if="detail.instrumental">
              <span class="inst-tag">{{ t('detail.instrumental') }}</span>
              <button class="chip tiny" @click="api.lyrics.setInstrumental(detail.id, false)">{{ t('lyrics.unmarkInstrumental') }}</button>
            </template>
            <template v-else-if="detail.lyricsFile || lyricDoc.found">
              <span class="lyric-how">{{ detail.lyricsFile ? t('lyrics.manual') : t('lyrics.autoMatched') }}</span>
              <span class="faint tiny">{{ detail.lyricsFile ?? lyricDoc.file }}</span>
              <button class="chip tiny" @click="api.lyrics.clear(detail.id)">{{ t('lyrics.clear') }}</button>
            </template>
            <template v-else>
              <span class="faint tiny">{{ t('detail.lyricsNone') }}</span>
              <button class="chip tiny" @click="api.lyrics.pick(detail.id)">{{ t('lyrics.pick') }}</button>
              <button class="chip tiny" @click="api.lyrics.setInstrumental(detail.id, true)">{{ t('lyrics.markInstrumental') }}</button>
            </template>
          </div>
        </div>

        <!--
          这里原本是「音频对齐」板块（一个 offset 输入框 + 保存）。
          现在偏移只归属**录音版本**，改它的地方有两处更合适：
            · 「管理录音版本」窗口：逐版本手输 / ±10ms 微调（还带「以播放头为原点」）；
            · 播放条：以播放头为原点（带确认，因为会覆盖已对齐的值）。
          详情面板再放一个输入框，等于同一个数有两个入口、还容易改错版本。
        -->

        <!-- 右键菜单：模块显隐。放 aside 里，跟着详情面板一起存在 -->
        <div
          v-if="ctxMenu"
          class="ctxmenu"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @contextmenu.prevent
          @pointerdown.stop
        >
          <div class="ctx-h">{{ t('detail.modules') }}</div>
          <button
            v-for="m in DETAIL_MODULES"
            :key="m.id"
            class="ctx-item"
            :class="{ off: !showSection(m.id) }"
            @click="toggleSection(m.id)"
          >
            <span class="ctx-tick">{{ showSection(m.id) ? '✓' : '' }}</span>{{ t(m.labelKey) }}
          </button>
          <div class="ctx-sep" />
          <button class="ctx-item" @click="resetSections">
            <span class="ctx-tick">↺</span>{{ t('detail.modulesAll') }}
          </button>
        </div>
      </aside>
    </div>

    <!-- 播放条：时间码 / 播放头 / audio_offset_ms 都在这里 -->
    <TransportBar
      data-help-region="transport"
      :analysis="viewAnalysis"
      :track-id="detail?.id ?? null"
      :rec-id="activeRecording?.id ?? null"
      @changed="refreshDetail"
    />

    <!-- 状态栏 -->
    <footer class="status">
      <span>{{ tn('status.results', rows.length) }}</span>
      <span class="sep">|</span>
      <span class="faint">{{ selectedId ? detailTitleText : t('status.noSelection') }}</span>
      <span class="grow" />
      <span v-if="messageText" class="dim">{{ messageText }}</span>
      <!-- 音频信息代替了原来的数据库路径：路径只有排错时有用，而这几项每天都想瞄一眼。
           悬停给完整文件名（同名的无损/有损版本靠它区分） -->
      <span v-if="audioLine" class="faint num" :title="audioMeta?.name ?? ''">{{ audioLine }}</span>
      <span v-if="audioLine" class="sep">|</span>
      <span class="faint">Electron {{ meta?.electron }}</span>
    </footer>

    <!-- 录音版本管理：面板里一行的入口，逐版本编辑全在这里 -->
    <RecordingManager
      v-if="showRecManager && detail"
      :track-id="detail.id"
      :recordings="recordings"
      :initial-id="recManagerInitial"
      @close="showRecManager = false"
      @changed="onRecManagerChanged"
    />

    <!-- 侧栏三块标题的右键菜单：播放列表还带新建 / 改名 / 删除；
         泳道方案和词表只有「搜索…」（它们的条目数不多，右键标题只干这一件事）。 -->
    <div
      v-if="plMenu"
      class="ctxmenu pl-menu"
      :style="{ left: plMenu.x + 'px', top: plMenu.y + 'px' }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <template v-if="plMenu.section === 'library'">
        <button class="ctx-item" @click="plMenuNew()">{{ t('menu.file.newPlaylist') }}</button>
        <template v-if="plMenu.listId">
          <div class="ctx-sep" />
          <button class="ctx-item" @click="plMenuRename()">{{ t('sidebar.renamePlaylist') }}</button>
          <button class="ctx-item danger" @click="plMenuDelete()">{{ t('sidebar.deletePlaylist') }}</button>
        </template>
        <div class="ctx-sep" />
        <button class="ctx-item" @click="plMenuSearch()">{{ t('sidebar.searchPlaylists') }}</button>
      </template>
      <button v-else-if="plMenu.section === 'views'" class="ctx-item" @click="plMenuSearch()">
        {{ t('sidebar.searchViews') }}
      </button>
      <button v-else class="ctx-item" @click="plMenuSearch()">{{ t('sidebar.searchVocab') }}</button>
    </div>

    <!-- 曲目行的右键菜单（右键曲名唤出）。同一套规矩：点别处关、Esc 关、夹进视口。
         「从播放列表移出」只在真的待在某个列表里时出现 —— 在「全部曲目」里给这一项
         等于提供一个「按了没反应」的按钮。 -->
    <div
      v-if="trackMenu"
      class="ctxmenu track-menu"
      :style="{ left: trackMenu.x + 'px', top: trackMenu.y + 'px' }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <button class="ctx-item" @click="trackMenuPlay()">{{ t('trackCtx.play') }}</button>
      <button class="ctx-item" @click="trackMenuRename()">{{ t('trackCtx.rename') }}</button>
      <!-- 只有母作品能挂乐章：乐章子项自己不再往下登记（决定 54：只做一层） -->
      <button v-if="!trackMenu.row?.parentId" class="ctx-item" @click="trackMenuAddMovement()">
        {{ t('trackCtx.addMovement') }}
      </button>
      <div class="ctx-sep" />
      <button class="ctx-item" @click="trackMenuAdd()">{{ t('trackCtx.addTo') }}</button>
      <button v-if="activePlaylist" class="ctx-item" @click="trackMenuRemoveFrom()">
        {{ t('trackCtx.removeFrom', { name: activePlaylist.name }) }}
      </button>
      <div class="ctx-sep" />
      <button class="ctx-item danger" @click="trackMenuDelete()">{{ t('trackCtx.delete') }}</button>
    </div>

    <!-- 录音行的右键菜单（详情栏的版本行 + 列表里的版本子行共用）。
         只有一项：切版本和管理都已经有单击/双击手势，塞进来反而让人犹豫。
         元数据属于**文件**，所以入口在这里而不是曲目行 —— 同一作品两版文件可能完全不同。 -->
    <div
      v-if="recMenu"
      class="ctxmenu rec-menu"
      :style="{ left: recMenu.x + 'px', top: recMenu.y + 'px' }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <button class="ctx-item" @click="recMenuMeta()">{{ t('recCtx.meta') }}</button>
    </div>

    <!-- 音频元数据：只读看文件里写了什么；「填入档案」会先弹确认窗口再写 -->
    <AudioMetaDialog
      v-if="metaTarget"
      :track-id="metaTarget.trackId"
      :rec-id="metaTarget.recId"
      :current="metaCurrent"
      @close="metaTarget = null"
      @apply="onMetaApplyRequest"
    />

    <!-- 填档案前的逐字段确认：默认全勾，可以取消脏数据 -->
    <MetaApplyDialog
      v-if="metaApply"
      :rows="metaApply.rows"
      :file-name="metaApply.fileName"
      @confirm="onMetaConfirm"
      @cancel="metaApply = null"
    />

    <!-- 选列表：点哪个就进哪个，没有「确定」这一步（多按一次回车只是多一个出错的机会） -->
    <div v-if="plPick" class="modal-mask" @pointerdown.stop @click.self="plPick = null">
      <div class="modal pl-pick" @keydown.esc="plPick = null">
        <h3>{{ t('plPick.title') }}</h3>
        <p class="dim tiny">{{ t('plPick.note', { title: plPick.title }) }}</p>
        <div v-if="playlists.length" class="pl-pick-list">
          <button
            v-for="pl in playlists"
            :key="pl.id"
            class="pl-pick-row"
            :class="{ in: inList(pl, plPick.trackId) }"
            :disabled="inList(pl, plPick.trackId)"
            @click="pickListFor(pl.id)"
          >
            <span class="pl-pick-name">{{ pl.name }}</span>
            <span class="pl-pick-n num">{{ pl.trackIds.length }}</span>
            <span class="pl-pick-state">
              {{ inList(pl, plPick.trackId) ? t('plPick.already') : t('plPick.add') }}
            </span>
          </button>
        </div>
        <p v-else class="faint tiny">{{ t('plPick.empty') }}</p>
        <div class="ws-actions">
          <button class="chip" @click="newListForPick()">{{ t('plPick.newAndAdd') }}</button>
          <button class="chip" @click="plPick = null">{{ t('btn.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 确认框：删录音这类不可撤销的动作先问一句。`above` 让它在选项面板之上 -->
    <div v-if="confirmBox" class="modal-mask above" @click.self="settleConfirm(false)">
      <!-- 确认键在**左**、实心红：破坏性动作放在视线第一个落点上，且一眼看出是红的。
           焦点给容器而不是按钮，回车就不会替你做决定（见 onConfirmKey）。 -->
      <div
        ref="confirmEl"
        class="modal confirm"
        role="alertdialog"
        aria-modal="true"
        tabindex="-1"
        @keydown="onConfirmKey"
      >
        <h3>{{ confirmBox.title }}</h3>
        <p class="confirm-body">{{ confirmBox.body }}</p>
        <div class="confirm-actions">
          <button class="chip danger solid" @click="settleConfirm(true)">{{ t('common.confirm') }}</button>
          <button class="chip" @click="settleConfirm(false)">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <!-- 首选项 -->
    <div v-if="showPrefs" class="modal-mask" @click.self="closePrefs">
      <div class="modal settings">
        <div class="s-head">
          <h3>{{ t('prefs.title') }}</h3>
          <button class="chip" @click="closePrefs">{{ t('prefs.close') }}</button>
        </div>

                <div class="s-body">
          <nav class="s-nav" aria-label="preferences sections">
            <button
              v-for="tb in PREF_TABS"
              :key="tb.id"
              :class="{ on: prefsTab === tb.id }"
              @click="scrollPrefsTo(tb.id)"
            >
              {{ t(tb.label) }}
            </button>
          </nav>
          <!-- 滚动容器：左侧 tab 点一下滚到对应分组；滚动时高亮跟着走（scroll spy） -->
          <div ref="prefsPanes" class="s-panes" @scroll.passive="onPrefsScroll">
        <div class="s-sec" data-group="look">
          <div class="s-h">{{ t('prefs.language') }}</div>
          <div class="zoom-row">
            <!-- 语言名永远用该语言自己的写法，否则看不懂自己在选什么 -->
            <button
              v-for="l in LOCALES"
              :key="l.id"
              class="chip lang-chip"
              :class="{ on: locale === l.id }"
              @click="setLocale(l.id)"
            >
              {{ l.label }}
            </button>
          </div>
          <p class="faint tiny">{{ t('prefs.languageNote') }}</p>
        </div>

        <div class="s-sec" data-group="look">
          <div class="s-h">{{ t('prefs.appearance') }}</div>
          <div class="zoom-row">
            <button class="chip" :class="{ on: themeMode === 'dark' }" @click="setThemeMode('dark')">{{ t('prefs.dark') }}</button>
            <button class="chip" :class="{ on: themeMode === 'light' }" @click="setThemeMode('light')">{{ t('prefs.light') }}</button>
            <button class="chip" :class="{ on: themeMode === 'system' }" @click="setThemeMode('system')">{{ t('prefs.themeSystem') }}</button>
            <button class="chip" :class="{ on: themeMode === 'timed' }" @click="setThemeMode('timed')">{{ t('prefs.themeTimed') }}</button>
          </div>
          <p class="faint tiny">{{ t('prefs.appearanceNote') }}</p>
          <p class="faint tiny">{{ t('prefs.themeNote') }}</p>
          <p v-if="themeMode === 'timed'" class="faint tiny">{{ t('prefs.themeTimedNote') }}</p>
          <!-- 自动模式下手动选的那一色不生效，得让人看见当前到底是哪一色 -->
          <p v-if="themeMode === 'system' || themeMode === 'timed'" class="faint tiny">
            {{ t('prefs.themeNow', { name: t(theme === 'dark' ? 'prefs.dark' : 'prefs.light') }) }}
          </p>

          <!--
            侧边栏留白：**浅色 / 深色各存一份**（用户 2026-11-08）。
            同一个 36px，深色下看着舒服、浅色下嫌宽 —— 两种底色对留白的观感本来就不一样。
            改完立刻生效（内联变量），并且会重算最小宽度。
          -->
          <div class="inset-block">
            <div class="s-sub">{{ t('prefs.sideInset') }}</div>
            <p class="faint tiny">{{ t('prefs.sideInsetNote') }}</p>
            <div v-for="row in SIDE_MODE_ROWS" :key="row.id" class="inset-row">
              <span class="inset-mode">{{ t(row.label) }} {{ t('prefs.sideInsetFor') }}</span>
              <span class="inset-k">{{ t('prefs.sideInsetLeft') }}：</span>
              <input
                class="inset-num"
                type="number"
                min="0"
                max="80"
                step="1"
                :value="sideInset[row.id].l"
                @change="setSideInset(row.id, 'l', ($event.target as HTMLInputElement).value)"
              />
              <span class="unit">px</span>
              <span class="inset-k">{{ t('prefs.sideInsetRight') }}：</span>
              <input
                class="inset-num"
                type="number"
                min="0"
                max="80"
                step="1"
                :value="sideInset[row.id].r"
                @change="setSideInset(row.id, 'r', ($event.target as HTMLInputElement).value)"
              />
              <span class="unit">px</span>
            </div>
          </div>
        </div>

        <div class="s-sec" data-group="look">
          <div class="s-h">{{ t('prefs.zoom') }} <span class="num faint">{{ Math.round(uiZoom * 100) }}%</span></div>
          <p class="faint tiny">{{ t('prefs.zoomNote') }}</p>
          <div class="zoom-row">
            <button
              v-for="z in ZOOMS"
              :key="z"
              class="chip"
              :class="{ on: Math.abs(uiZoom - z) < 0.001 }"
              @click="applyZoom(z)"
            >
              {{ Math.round(z * 100) }}%
            </button>
          </div>
        </div>

        <div class="s-sec" data-group="look">
          <div class="s-h">{{ t('prefs.font') }}</div>
          <div class="zoom-row">
            <button class="chip" data-ui-font="ui" :class="{ on: uiFont === 'ui' }" @click="applyFont('ui')">{{ t('prefs.fontUI') }}</button>
            <button class="chip" data-ui-font="mono" :class="{ on: uiFont === 'mono' }" @click="applyFont('mono')">{{ t('prefs.fontMono') }}</button>
          </div>
          <p class="faint tiny">{{ t('prefs.fontNote') }}</p>
        </div>

        <div class="s-sec" data-group="look">
          <div class="s-h">{{ t('prefs.fontFamily') }}</div>
          <p class="faint tiny mono-demo">
            {{ t('prefs.ui', { name: t(uiFont === 'ui' ? 'prefs.fontFamilyUI' : 'prefs.fontFamilyMono') }) }}<br />
            {{ t('prefs.grid', { name: t('prefs.fontFamilyGrid') }) }}
          </p>
        </div>

        <div class="s-sec" data-group="look">
          <div class="s-h">{{ t('prefs.tplFont') }}</div>
          <p class="faint tiny">{{ t(tplFontNoteKey) }}</p>
          <div class="zoom-row">
            <button class="chip" data-tpl-font="sans" :class="{ on: tplFont === 'sans' }" @click="setTplFont('sans')">
              {{ t('prefs.tplFontSans') }}
            </button>
            <button class="chip" data-tpl-font="mono" :class="{ on: tplFont === 'mono' }" @click="setTplFont('mono')">
              {{ t('prefs.tplFontMono') }}
            </button>
          </div>
        </div>

        <div v-if="locale !== 'en'" class="s-sec" data-group="look">
          <div class="s-h">{{ t('prefs.numeral') }}</div>
          <div class="zoom-row">
            <button class="chip" :class="{ on: numeralStyle === 'han' }" @click="applyNumeralStyle('han')">
              {{ t('prefs.numeralHan') }}
            </button>
            <button class="chip" :class="{ on: numeralStyle === 'arabic' }" @click="applyNumeralStyle('arabic')">
              {{ t('prefs.numeralArabic') }}
            </button>
          </div>
          <p class="faint tiny">{{ t('prefs.numeralNote') }}</p>
        </div>

        <div class="s-sec" data-group="edit">
          <div class="s-h">{{ t('prefs.followSel') }}</div>
          <p class="faint tiny">{{ t('prefs.followSelNote') }}</p>
          <div class="zoom-row">
            <button
              v-for="m in FOLLOW_SEL_MODES"
              :key="m.id"
              class="chip"
              :class="{ on: followSel === m.id }"
              @click="setFollowSel(m.id)"
            >
              {{ t(m.key) }}
            </button>
          </div>
        </div>

        <div class="s-sec" data-group="edit">
          <div class="s-h">{{ t('prefs.gridFeel') }}</div>
          <p class="faint tiny">{{ t('prefs.gridFeelNote') }}</p>
          <label class="pref-row">
            <input type="checkbox" v-model="scrubPick" @change="saveBool('ma-scrub-pick', scrubPick, 'scrubPick')" />
            {{ t('prefs.scrubPick') }}
          </label>
          <label class="pref-row" :class="{ faint: !scrubPick }">
            <input
              type="checkbox"
              v-model="scrubClearEmpty"
              :disabled="!scrubPick"
              @change="saveBool('ma-scrub-empty', scrubClearEmpty, 'scrubEmpty')"
            />
            {{ t('prefs.scrubClearEmpty') }}
          </label>
          <label class="pref-row">
            <input type="checkbox" v-model="selAnim" @change="saveBool('ma-sel-anim', selAnim, 'selAnim')" />
            {{ t('prefs.selAnim') }}
          </label>
          <label class="pref-row">
            <input type="checkbox" v-model="pasteWarn" @change="saveBool('ma-paste-warn', pasteWarn, 'pasteWarn')" />
            {{ t('prefs.pasteWarn') }}
          </label>
          <label class="pref-row">
            <input
              type="checkbox"
              v-model="bassAutofill"
              @change="saveBool('ma-bass-autofill', bassAutofill, 'bassAutofill')"
            />
            {{ t('prefs.bassAutofill') }}
          </label>
          <p class="faint tiny">{{ t('prefs.bassAutofillNote') }}</p>
          <label class="pref-row">
            <input
              type="checkbox"
              v-model="chordAutofill"
              @change="saveBool('ma-chord-autofill', chordAutofill, 'chordAutofill')"
            />
            {{ t('prefs.chordAutofill') }}
          </label>
          <p class="faint tiny">{{ t('prefs.chordAutofillNote') }}</p>
          <label class="pref-row">
            <input
              type="checkbox"
              v-model="sposobinAutofill"
              @change="saveBool('ma-sposobin-autofill', sposobinAutofill, 'sposobinAutofill')"
            />
            {{ t('prefs.sposobinAutofill') }}
          </label>
          <p class="faint tiny">{{ t('prefs.sposobinAutofillNote') }}</p>
        </div>

        <div class="s-sec" data-group="edit">
          <div class="s-h">{{ t('prefs.undo') }}</div>
          <label class="pref-row">
            <input
              v-model.number="undoLimit"
              class="pref-num"
              type="number"
              min="0"
              step="50"
              @change="applyUndoConfig()"
            />
            {{ t('prefs.undoLimit') }}
          </label>
          <label class="pref-row">
            <input
              v-model.number="undoPersist"
              class="pref-num"
              type="number"
              min="1"
              step="10"
              @change="applyUndoConfig()"
            />
            {{ t('prefs.undoPersist') }}
          </label>
          <p class="faint tiny">{{ t('prefs.undoNote') }}</p>
        </div>

        <div class="s-sec" data-group="edit">
          <div class="s-h">{{ t('prefs.figure') }}</div>
          <p class="faint tiny">{{ t('prefs.figureNote') }}</p>
          <div class="zoom-row">
            <button
              v-for="m in FIGURE_STYLES"
              :key="m.id"
              class="chip"
              :class="{ on: figureStyle === m.id }"
              @click="setFigureStyle(m.id)"
            >
              {{ t(m.key) }}
            </button>
          </div>
        </div>

        <div class="s-sec" data-group="edit">
          <div class="s-h">{{ t('prefs.templates') }}</div>
          <p class="faint tiny">{{ t('prefs.templatesNote') }}</p>

          <div class="tpl-list">
            <div v-for="p in allPresets" :key="p.id" class="tpl-preset">
              <div class="tpl-preset-head">
                <b class="tpl-preset-name">{{ p.name }}</b>
                <span class="chip tiny">{{
                  t(p.scope === 'movement' ? 'prefs.templateScopeMovement' : 'prefs.templateScopeTitle')
                }}</span>
                <span v-if="p.builtin" class="tpl-official">{{ t('prefs.templateBuiltin') }}</span>
                <span class="tpl-preset-actions">
                  <button class="chip tiny" @click="copyTplPreset(p)">{{ t('prefs.templateCopy') }}</button>
                  <button v-if="!p.builtin" class="chip tiny" @click="editTplPreset(p)">
                    {{ t('prefs.templateEdit') }}
                  </button>
                  <button v-if="!p.builtin" class="chip tiny danger" @click="removeTplPreset(p)">
                    {{ t('prefs.templateDelete') }}
                  </button>
                </span>
              </div>
              <div class="tpl-line">
                <span
                  v-for="(seg, i) in templateSegments(p.template)"
                  :key="i"
                  :class="{ v: seg.variable }"
                >{{ seg.text }}</span>
              </div>
            </div>
          </div>

          <div class="tpl-form">
            <div class="s-sub">{{ t('prefs.templateEditor') }}</div>
            <div class="tpl-form-row">
              <input
                v-model="tplPresetName"
                class="tpl-name"
                :placeholder="t('prefs.templateName')"
                spellcheck="false"
                @input="tplDirty = true"
              />
              <select v-model="tplPresetScope" class="tpl-scope" @change="tplDirty = true">
                <option value="title">{{ t('prefs.templateScopeTitle') }}</option>
                <option value="movement">{{ t('prefs.templateScopeMovement') }}</option>
              </select>
              <button class="chip" @click="newTplPreset">{{ t('prefs.templateNew') }}</button>
              <button class="chip tpl-save" @click="saveTplPreset">{{ t('prefs.templateSave') }}</button>
            </div>
            <TemplateEditor
              v-model="tplPresetDraft"
              :rows="3"
              :placeholder="t('prefs.templatePlaceholder')"
              @update:model-value="tplDirty = true"
            />
            <p v-if="tplPresetMsg" class="tpl-msg" :class="{ bad: tplPresetBad }">{{ tplPresetMsg }}</p>
            <div class="tpl-vars">
              <span class="faint tiny">{{ t('prefs.templateVars') }}</span>
              <span v-for="v in TEMPLATE_VARIABLES" :key="v.key" class="tpl-var">
                <b>%{{ v.name }}}</b>
                <em>{{ legendText(v) }}</em>
              </span>
            </div>
            <p class="faint tiny">{{ t('prefs.templateOmitNote') }}</p>
          </div>
        </div>

        <div class="s-sec" data-group="play">
          <div class="s-h">{{ t('prefs.step') }}</div>
          <p class="faint tiny">{{ t('prefs.stepNote') }}</p>
          <div class="inset-row">
            <span class="inset-k">{{ t('prefs.stepCoarse') }}：</span>
            <input
              class="inset-num"
              type="number"
              min="0.1"
              max="60"
              step="0.5"
              :value="coarseSec()"
              @change="setCoarseSec(($event.target as HTMLInputElement).value)"
            />
            <span class="unit">s</span>
          </div>

          <div class="s-sub" style="margin-top: 12px">{{ t('prefs.stepFine') }}</div>
          <p class="faint tiny">
            {{ t('prefs.stepFineNote', { fps: String(effectiveFps()), ms: fineMsText() }) }}
          </p>
          <div class="zoom-row">
            <button
              v-for="m in FRAME_MODES"
              :key="m.id"
              class="chip"
              :class="{ on: stepPrefs.frameMode === m.id }"
              @click="saveStepPrefs({ frameMode: m.id })"
            >
              {{ t(m.key) }}
            </button>
          </div>

          <div class="s-sub" style="margin-top: 14px">{{ t('prefs.scrub') }}</div>
          <p class="faint tiny">{{ t('prefs.scrubNote') }}</p>
          <label class="pref-row">
            <input
              type="checkbox"
              :checked="stepPrefs.scrubOn"
              @change="saveStepPrefs({ scrubOn: ($event.target as HTMLInputElement).checked })"
            />
            {{ t('prefs.scrubOn') }}
          </label>
          <div class="zoom-row" :class="{ faint: !stepPrefs.scrubOn }">
            <button
              v-for="sc in SCRUB_SCOPES"
              :key="sc.id"
              class="chip"
              :class="{ on: stepPrefs.scrubScope === sc.id }"
              @click="saveStepPrefs({ scrubScope: sc.id })"
            >
              {{ t(sc.key) }}
            </button>
          </div>
          <div class="inset-row" :class="{ faint: !stepPrefs.scrubOn }">
            <span class="inset-k">{{ t('prefs.scrubLen') }}：</span>
            <input
              class="inset-num"
              type="number"
              min="0"
              max="2000"
              step="5"
              :value="stepPrefs.scrubMs"
              @change="setScrubNum('scrubMs', ($event.target as HTMLInputElement).value)"
            />
            <span class="unit">ms</span>
            <span class="inset-k" style="margin-left: 8px">{{ t('prefs.scrubOr') }}</span>
            <input
              class="inset-num"
              type="number"
              min="1"
              max="240"
              step="1"
              :value="stepPrefs.scrubFps"
              @change="setScrubNum('scrubFps', ($event.target as HTMLInputElement).value)"
            />
            <span class="unit">fps ×</span>
            <input
              class="inset-num"
              type="number"
              min="1"
              max="240"
              step="1"
              :value="stepPrefs.scrubFrames"
              @change="setScrubNum('scrubFrames', ($event.target as HTMLInputElement).value)"
            />
            <span class="unit">{{ t('prefs.scrubFrameUnit') }}</span>
          </div>
          <div class="zoom-row" :class="{ faint: !stepPrefs.scrubOn }">
            <span class="faint tiny">{{ t('prefs.scrubPriority') }}</span>
            <button
              v-for="pz in SCRUB_PRIOS"
              :key="pz.id"
              class="chip"
              :class="{ on: stepPrefs.scrubPriority === pz.id }"
              @click="saveStepPrefs({ scrubPriority: pz.id })"
            >
              {{ t(pz.key) }}
            </button>
          </div>
          <p class="faint tiny">{{ t('prefs.scrubNoAudio') }}</p>
        </div>

        <div class="s-sec" data-group="play">
          <div class="s-h">{{ t('prefs.versionClick') }}</div>
          <p class="faint tiny">{{ t('prefs.versionClickNote') }}</p>
          <div class="zoom-row">
            <button
              v-for="m in CLICK_VERSION_MODES"
              :key="m.id"
              class="chip"
              :class="{ on: clickVersionMode === m.id }"
              @click="setClickVersionMode(m.id)"
            >
              {{ t(m.key) }}
            </button>
          </div>
        </div>

        <div class="s-sec" data-group="play">
          <div class="s-h">{{ t('prefs.waveCache') }}</div>
          <p class="faint tiny">{{ t('prefs.waveCacheNote') }}</p>
          <div class="zoom-row">
            <button
              v-for="mb in WAVE_LIMITS"
              :key="mb"
              class="chip"
              :class="{ on: waveLimit === mb }"
              @click="applyWaveLimit(mb)"
            >
              {{ mb === 0 ? t('prefs.waveOff') : mb + ' MB' }}
            </button>
          </div>
          <div class="pref-row-group" style="margin-top: 6px">
            <span class="faint tiny">{{ waveUseText }}</span>
            <span class="grow" />
            <button class="chip" :disabled="!waveUse.memItems && !waveUse.diskFiles" @click="clearWave()">
              {{ t('prefs.waveClear') }}
            </button>
          </div>
        </div>

        <div class="s-sec" data-group="play">
          <div class="s-h">{{ t('prefs.lyrics') }}</div>
          <p class="faint tiny">{{ t('prefs.lyricsNote') }}</p>
          <label class="pref-row">
            <input
              type="checkbox"
              v-model="lyricsAutoOpen"
              data-field="lyricsAuto"
              :disabled="safeMode || configBusy"
              @change="saveLyricsAuto"
            />
            {{ t('prefs.lyricsAuto') }}
          </label>
          <button class="chip" style="margin-top:6px" @click="api.win.openLyrics()">{{ t('prefs.lyricsOpen') }}</button>
        </div>

        <div class="s-sec" data-group="play">
          <div class="s-h">{{ t('prefs.desktopLyrics') }}</div>
          <p class="faint tiny">{{ t('prefs.desktopLyricsNote') }}</p>
          <label class="pref-row"><input type="checkbox" v-model="desktopEnable" @change="syncDesktopEnable" /> {{ t('prefs.desktopEnable') }}</label>
          <template v-if="desktopEnable">
            <div class="pref-row-group">
              <label>{{ t('prefs.desktopSize') }} {{ desktopStyle.size }}px</label>
              <input type="range" min="16" max="64" v-model.number="desktopStyle.size" @input="syncDesktopStyle" />
            </div>
            <div class="pref-row-group">
              <label>{{ t('prefs.desktopOpacity') }} {{ desktopOpacityPct }}%</label>
              <input type="range" min="20" max="100" v-model.number="desktopOpacityPct" @input="onDesktopOpacity" />
            </div>
            <div class="zoom-row" style="margin-top:6px">
              <button v-for="c in desktopColors" :key="c.id" class="chip small" :class="{ on: desktopStyle.color === c.id }" @click="setDesktopColor(c.id)">{{ c.label }}</button>
            </div>
            <label class="pref-row" style="margin-top:6px"><input type="checkbox" v-model="desktopStyle.next" @input="syncDesktopStyle" /> {{ t('prefs.desktopNext') }}</label>
          </template>
        </div>

        <div class="s-sec" data-group="win">
          <div class="s-h">{{ t('prefs.childWins') }}</div>
          <label class="pref-row">
            <input
              type="checkbox"
              v-model="helpAutoOpen"
              data-field="helpAuto"
              :disabled="safeMode || configBusy"
              @change="saveHelpAuto"
            />
            {{ t('prefs.helpAuto') }}
          </label>
          <p class="faint tiny">{{ t('prefs.helpAutoNote') }}</p>
        </div>

        <!-- 启动配置：外置 config.json。选项里改会立刻写盘；手改文件则重启生效。 -->
        <div class="s-sec" data-group="win" data-config="startup">
          <div class="s-h">{{ t('prefs.startupConfig') }}</div>
          <p class="faint tiny">{{ t('prefs.startupConfigNote') }}</p>
          <label class="pref-row">
            <input
              type="checkbox"
              v-model="safeMode"
              data-field="safeMode"
              :disabled="configBusy"
              @change="saveSafeMode"
            />
            {{ t('prefs.safeMode') }}
          </label>
          <p class="faint tiny">{{ t('prefs.safeModeNote') }}</p>
          <div class="pref-row-group" style="margin-top: 6px">
            <span class="faint tiny" data-config-path style="word-break: break-all">{{ configPath }}</span>
          </div>
          <button class="chip" style="margin-top: 6px" @click="openConfigFile">{{ t('prefs.openConfig') }}</button>
          <p v-if="configParseError" class="faint tiny" style="color: var(--warn)">
            {{ t('prefs.configParseError', { err: configParseError }) }}
          </p>
          <p v-else-if="configError" class="faint tiny" style="color: var(--warn)">{{ configError }}</p>
        </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 帮助：快捷键 / 关于 -->
    <div v-if="showHelp" class="modal-mask" @click.self="showHelp = false">
      <div class="modal">
        <h3>{{ t('help.title') }}</h3>
        <table class="sections">
          <tbody>
            <tr><td>{{ t('help.register') }}</td><td class="num">Ctrl+R</td></tr>
            <tr><td>{{ t('help.search') }}</td><td class="num">Ctrl+F</td></tr>
            <tr><td>{{ t('help.suggest') }}</td><td class="num">↑ ↓ / Enter</td></tr>
            <tr><td>{{ t('help.clearSearch') }}</td><td class="num">Ctrl+Shift+F</td></tr>
            <tr><td>{{ t('help.prefs') }}</td><td class="num">Ctrl+,</td></tr>
            <tr><td>{{ t('help.openMenu') }}</td><td class="num">{{ t('help.altLetter') }}</td></tr>
            <tr><td>{{ t('help.panel') }}</td><td class="num">Ctrl+J</td></tr>
            <tr><td>{{ t('help.zoom') }}</td><td class="num">Ctrl+= / − / 0</td></tr>
            <tr><td>{{ t('help.gridZoom') }}</td><td class="num">Ctrl+{{ t('help.wheel') }}</td></tr>
            <tr><td>{{ t('help.playPause') }}</td><td class="num">{{ t('help.space') }}</td></tr>
            <tr><td>{{ t('help.home') }}</td><td class="num">Home</td></tr>
            <tr><td>{{ t('help.enter') }}</td><td class="num">Enter</td></tr>
            <tr><td>{{ t('help.backspace') }}</td><td class="num">Backspace</td></tr>
            <tr><td>{{ t('help.delete') }}</td><td class="num">Delete</td></tr>
            <tr><td>{{ t('help.resize') }}</td><td class="num">Alt+← →</td></tr>
            <tr><td>{{ t('help.copy') }}</td><td class="num">Alt+{{ t('help.drag') }}</td></tr>
            <tr><td>{{ t('help.undo') }}</td><td class="num">Ctrl+Z</td></tr>
            <tr><td>{{ t('help.rename') }}</td><td class="num">{{ t('help.rightClickTitle') }}</td></tr>
            <tr><td>{{ t('help.detailModules') }}</td><td class="num">{{ t('help.rightClickBlank') }}</td></tr>
            <tr><td>{{ t('help.vocab') }}</td><td class="num">{{ t('help.clickVocab') }}</td></tr>
            <tr><td>{{ t('help.editDetail') }}</td><td class="num">{{ t('help.dblclickValue') }}</td></tr>
          </tbody>
        </table>
        <p class="faint tiny">{{ t('help.about') }}</p>
        <div class="modal-foot">
          <button class="chip" @click="showHelp = false">{{ t('prefs.close') }}</button>
        </div>
      </div>
    </div>

    <!-- 孤儿报告 -->
    <div v-if="showOrphans" class="modal-mask" @click.self="showOrphans = false">
      <div class="modal">
        <h3>{{ t('orphans.title') }}</h3>
        <p class="dim tiny">{{ t('orphans.note') }}</p>
        <table class="sections">
          <thead>
            <tr>
              <th>{{ t('orphans.colTag') }}</th>
              <th>{{ t('orphans.colDim') }}</th>
              <th class="num">{{ t('orphans.colRefs') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orphans" :key="o.tagId">
              <td>{{ o.tagId }}</td><td class="dim">{{ o.dim }}</td><td class="num">{{ o.refCount }}</td>
            </tr>
            <tr v-if="!orphans.length"><td colspan="3" class="faint">{{ t('orphans.empty') }}</td></tr>
          </tbody>
        </table>
        <div class="modal-foot">
          <button class="chip" @click="showOrphans = false">{{ t('prefs.close') }}</button>
        </div>
      </div>
    </div>

    <!-- 已归档作品：删除只是搬进 data/tracks/.archive，彻底删除才真的清掉 -->
    <div v-if="showArchive" class="modal-mask" @click.self="showArchive = false">
      <div class="modal">
        <h3>{{ t('archive.title') }}</h3>
        <p class="dim tiny">{{ t('archive.note') }}</p>
        <table class="sections">
          <thead>
            <tr>
              <th>{{ t('archive.colTitle') }}</th>
              <th>{{ t('archive.colWhen') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in archived" :key="a.file">
              <td>{{ a.title }}</td>
              <td class="dim num">{{ fmtWhen(a.archivedAt) }}</td>
              <td class="num">
                <button class="chip danger" @click="purgeArchivedOne(a)">{{ t('archive.purge') }}</button>
              </td>
            </tr>
            <tr v-if="!archived.length">
              <td colspan="3" class="faint">{{ t('archive.empty') }}</td>
            </tr>
          </tbody>
        </table>
        <div class="modal-foot">
          <button v-if="archived.length" class="chip danger" @click="purgeArchiveAll()">
            {{ t('archive.purgeAll') }}
          </button>
          <button class="chip" @click="showArchive = false">{{ t('prefs.close') }}</button>
        </div>
      </div>
    </div>

    <!-- 词表编辑器：结构校验在主进程，界面只改内容 -->
    <VocabEditor v-if="vocabDim" :dim="vocabDim" @close="vocabDim = null" @saved="onVocabSaved" />
    <ChordSymbolsEditor v-if="showChordSymbols" @close="showChordSymbols = false" />

    <!-- 为作者提供经济支持：两张收款码左右并排（微信在左、支付宝在右）。
         图由主进程从 assets 里按文件名找出来；找不到就说一句，不弹两个空框。 -->
    <div v-if="supportOpen" class="modal-mask" @pointerdown.stop @click.self="supportOpen = false">
      <div class="modal support-modal">
        <h3>{{ t('support.title') }}</h3>
        <p class="dim tiny">{{ t('support.intro') }}</p>
        <div v-if="supportQrs.length" class="support-qrs">
          <figure v-for="q in supportQrs" :key="q.key" class="support-qr">
            <img :src="q.dataUrl" :alt="q.label" :width="q.width" :height="q.height" />
            <figcaption>{{ q.label }}</figcaption>
          </figure>
        </div>
        <p v-else class="faint tiny">{{ t('support.missing') }}</p>
        <div class="ws-actions">
          <button class="chip" @click="supportOpen = false">{{ t('support.close') }}</button>
        </div>
      </div>
    </div>

    <!-- 保存工作区：起个名字。重名直接覆盖（同名的「保存」本来就该是这个意思） -->
    <div v-if="wsSaveOpen" class="modal-mask" @pointerdown.stop @click.self="wsSaveOpen = false">
      <div class="modal">
        <h3>{{ t('menu.ws.save') }}</h3>
        <p class="dim tiny">{{ t('menu.ws.saveNote') }}</p>
        <input
          v-model="wsSaveName"
          class="ws-name-input"
          :placeholder="t('menu.ws.ph')"
          @keydown.stop
          @keydown.enter.prevent="confirmWsSave()"
          @keydown.esc="wsSaveOpen = false"
        />
        <div class="ws-actions">
          <button class="chip solid" :disabled="!wsSaveName.trim()" @click="confirmWsSave()">{{ t('btn.ok') }}</button>
          <button class="chip" @click="wsSaveOpen = false">{{ t('btn.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ⓘ 的说明气泡：挂在 body 上，`.detail` 的 overflow 与左侧树的层叠都管不到它。
       位置由 openMeterTip 现算（fixed），开合由 v-if 控制 —— 没有过渡，悬停立刻出现。
       它能接鼠标（pointer-events:auto）：从图标挪进来就不该被收掉，里面的文字也能选中。 -->
  <Teleport to="body">
    <div
      v-if="meterTip && meterKind"
      class="mt-pop"
      :class="{ pinned: tipPinned }"
      :style="{ left: meterTip.left + 'px', top: meterTip.top + 'px' }"
      @mouseenter="cancelTipClose"
      @mouseleave="scheduleTipClose"
    >
      {{ t(meterKind.noteKey as string) }}
    </div>
  </Teleport>
</template>

<style scoped>
.shell {
  display: grid;
  /* 标题行 26 + 菜单行 24 + 主体（搜索框在主体中间列顶部）+ 播放条 40 + 状态栏 24 */
  grid-template-rows: 50px 1fr 40px 24px;
  height: 100%;
}

/* 搜索行：只横跨中间这一列（不通栏），贴着表格顶上 */
.searchrow {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.search-wrap { position: relative; flex: 1; min-width: 0; }
.search {
  width: 100%;
  height: 24px;
  font-size: 11.5px;
}
/* 补全下拉：贴着输入框下沿，宽度跟输入框一致 */
.sug {
  position: absolute;
  z-index: 40;
  top: 26px;
  left: 0;
  right: 0;
  margin: 0;
  padding: 3px;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: var(--shadow);
  max-height: 240px;
  overflow: auto;
}
.sug li {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 7px;
  border-radius: 3px;
  font-size: 11.5px;
  color: var(--text-dim);
  cursor: pointer;
}
.sug li.on { background: var(--sel-bg); color: var(--text); }
.s-main { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-hint { flex: none; font-style: normal; font-size: 10px; color: var(--text-faint); }
.sr-btn {
  flex: none;
  height: 24px;
  padding: 0 10px;
  font-size: 11.5px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: 3px;
}
.sr-btn:hover { color: var(--text); border-color: var(--line-strong); }

/* 主体 */
.body {
  position: relative;
  display: grid;
  grid-template-columns: var(--left-w, 196px) 1fr var(--right-w, 344px);
  min-height: 0;
  /* 收起 / 展开要有过渡；拖动时关掉（否则指针每帧改列宽，界面会追着手指跑） */
  transition: grid-template-columns 180ms ease;
}
body.resizing .body { transition: none; }

/*
 * 收起：列宽已经是 0，这里负责「别再露出半个字」。
 * `overflow: hidden` 不能少 —— 栏的宽度被压成 0 时内容会往外溢，
 * 溢出去的部分会画在主区上面（看起来像表格左边叠了一层鬼影）。
 * `min-width: 0` 同理：grid 子项默认 `min-width: auto`，会按内容撑住不缩。
 */
.body.left-collapsed .sidebar,
.body.right-collapsed .detail {
  min-width: 0;
  overflow: hidden;
  padding-left: 0;
  padding-right: 0;
}
.body.left-collapsed .sidebar { border-right-width: 0; box-shadow: none; }
.body.right-collapsed .detail { border-left-width: 0; }

/*
 * 侧栏拖拽手柄（竖的）。**类名不能叫 .splitter** —— 那是面板上下的横分隔条，
 * 同名会把这里的 position:absolute 覆盖成 relative，于是两个手柄变成 grid 子项，
 * 「详情」被挤到第二行，整个排版就塌了（真发生过）。
 */
.vsplit {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 7px;
  z-index: 4;
  cursor: col-resize;
  background: transparent;
}
.vsplit::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 1px;
  background: var(--accent);
  opacity: 0;
  transition: opacity 120ms ease;
}
.vsplit:hover::after { opacity: 0.55; }
/* 收起时列宽是 0，手柄要贴住窗口边 —— 别用负值跑到窗口外，抓不到了 */
.vsplit.left { left: max(0px, calc(var(--left-w, 196px) - 3px)); }
.vsplit.right { right: max(0px, calc(var(--right-w, 344px) - 3px)); }
/* 拖动中：整窗都是 col-resize，且不许选中文字（否则会拖出一片蓝色） */
body.resizing { cursor: col-resize; user-select: none; }
body.resizing .vsplit::after { opacity: 0.9; }

/*
 * 边缘把手 —— 鼠标靠近栏边界才浮出的小方块（用户 2026-11-08）。
 * 灰色半透明底 + 中间一个直角箭头（和侧栏标题的 chevron 是同一份 path）。
 *
 * **位置必须跟着栏宽走**（`left: calc(var(--left-w) - 4px)`）。
 * 第一版写成 `left: -4px`，结果它贴在**窗口**最左边 —— 用户圈的是栏边界，那里什么都没有。
 * 收起到 0 宽时 calc 自然得 -4px，正好贴回窗口边，不需要额外特判。
 *
 * 识别区 22×96（好悬停），视觉只有 14×38（不吵）。在识别区里按下后，
 * 位移 < 4px = 点击（收起 / 展开）；超过就交给 startSplit 转成正常拖宽。
 */
.edge-tab {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 22px;
  height: 96px;
  /* 压在 .vsplit 之上：这一小块里的按下先归它判断「是点还是拖」 */
  z-index: 6;
  touch-action: none;
}
.edge-tab.left { left: calc(var(--left-w, 196px) - 4px); }
.edge-tab.right { right: calc(var(--right-w, 344px) - 4px); }

/* 那个「灰色的半透明块」：跨在边界线上，一半在栏里、一半在主区，两边都不挡 */
.edge-tab-knob {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 38px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  background: color-mix(in srgb, var(--text-faint) 26%, transparent);
  opacity: 0;
  transition: opacity 120ms ease, background 120ms ease;
}
.edge-tab.left .edge-tab-knob { left: -2px; }
.edge-tab.right .edge-tab-knob { right: -2px; }

.edge-tab-chev {
  width: 9px;
  height: 9px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 140ms ease;
}
/* 展开态：箭头指「收起会往哪边去」—— 左栏朝左、右栏朝右 */
.edge-tab.left .edge-tab-chev { transform: rotate(180deg); }
.edge-tab.right .edge-tab-chev { transform: rotate(0deg); }
/* 收起态：反过来，指「拉开会往哪边去」 */
.edge-tab.left.collapsed .edge-tab-chev { transform: rotate(0deg); }
.edge-tab.right.collapsed .edge-tab-chev { transform: rotate(180deg); }

.edge-tab:hover .edge-tab-knob {
  opacity: 1;
  background: color-mix(in srgb, var(--text-faint) 40%, transparent);
}

/*
 * 收起：块常亮（栏宽为 0 之后它是唯一「这里能拉开」的线索），
 * 但整块要**收回窗口内** —— 4px 实测还不够，左半仍会连圆角一起被裁掉，所以给 8px。
 */
.edge-tab.collapsed .edge-tab-knob { opacity: 0.85; }
.edge-tab.left.collapsed .edge-tab-knob { left: 8px; }
.edge-tab.right.collapsed .edge-tab-knob { right: 8px; }

/* 侧边栏外观配置 - 涉及 松紧、缩进、圆角*/

.sidebar {
  /*
   *   --side-inset-l 内容距侧栏左缘（chevron 的起点也在这里）。嫌挤就加大。
   *   --side-inset-r 内容距侧栏右缘。和左边是两个数，故意不联动 ——
   *                  右边只要够放下 `em.num` 那个计数、和行内 padding 对齐就行，12px 正好。
   *   --side-rail    树线（配重线）的横坐标。默认 = 左留白 + 6：chevron 宽 10px，
   *                  旋转 90° 后角尖在 inset+5 附近，线落在角尖稍右、仍在这个符号之内。
   *   --side-gap     树线到子项文字的距离。
   *   --side-pill    选中条的左缘（= inset - 8）。必须 < rail，否则条子会卡在线上切一刀。
 *   --side-sel     选中条底色（半透明 accent，和界面别处的选中区分开）；
 *   --side-hover   悬停条底色（和别处的 hover 同浓度）。这两个随便调 ——
 *                  树线由 `.side-group::before` 画在它们**上面**，不受影响。
   *   --side-radius  选中条 / 悬停条的圆角。
   *   --side-extend  由上面几个推导：选中条要向左多探出的距离 = rail + gap + 1(边框) - pill。
   */
  --side-inset-l: 36px;
  --side-inset-r: 12px;
  --side-rail: calc(var(--side-inset-l) + 6px);
  --side-gap: 20px;
  --side-pill: calc(var(--side-inset-l) - 8px);
  --side-radius: 8px;
  /* 选中 / 悬停的底色要**半透明**：选中那条的树线在它**下面**（方案 E），
     不透明的话块里就是「没有线的一段」，块与线之间会出现一道硬边。
     用 accent 调出来而不是直接拿 --sel-bg —— 后者不透明。 */
  --side-sel: color-mix(in srgb, var(--accent) 18%, transparent);
  /*
   * 悬停底色：和界面别处的 hover 用同一个浓度（`--surface-2` 七成），不要再为「让线透出来」调淡。
   * 线由 `.side-group::before` 画在 z-index: 1，hover 条在它下面 —— 鼠标扫过时线是连贯的；
   * **只有选中那一条**反过来压在线之上（方案 E，见下面 `.side-i.on` 那条规则）。
   */
  --side-hover: color-mix(in srgb, var(--surface-2) 70%, transparent);
  --side-extend: calc(var(--side-rail) + var(--side-gap) + 1px - var(--side-pill));

  position: relative;
  z-index: 2; /* 凸起的投影要压在中间内容之上，才有"叠起来"的感觉 */
  border-right: 1px solid var(--line-strong);
  padding: 8px 0;
  overflow: auto;
  background: var(--surface);
  /* 右缘一道极淡高光 + 贴着边的一层浅投影 = 略微凸起 */
  box-shadow: inset -1px 0 0 var(--raise-hi), var(--raise-shadow);
}
.side-h {
  padding: 10px var(--side-inset-r) 4px var(--side-inset-l);
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-faint);
}
/* 标题整行是折叠开关。造型照 Obsidian：chevron 在文字左侧 */
.side-toggle {
  display: flex; align-items: center; gap: 5px;
  width: 100%; text-align: left;
  background: none; border: 0; cursor: pointer;
  font-family: inherit;
}
.side-toggle:hover { color: var(--text-dim); }
.side-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/*
 * 折叠 chevron：两条边构成的直角（⌄ / ›），不是实心三角。
 * 收起时角尖朝右（0°），展开时转 90° 朝下 —— 同一份 path，只转不换图。
 * 用 SVG 而不是 ▾：那个字形在中文字体里又小又胖，还随字体变。
 */
.side-chev {
  flex: none; width: 10px; height: 10px;
  color: var(--text-faint);
  transform: rotate(0deg);
  transition: transform 0.14s ease, color 0.14s ease;
}
.side-chev path {
  fill: none; stroke: currentColor;
  stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round;
}
.side-chev.open { transform: rotate(90deg); }
.side-toggle:hover .side-chev { color: var(--text-dim); }

/*
 * 子树：缩进 + 左边一条竖线（Obsidian 的树线）。
 *
 * 竖线的位置不是「标题文字左缘」，而是**chevron 角尖稍右一点**（17px）：
 * chevron 占 10–20px，旋转 90° 后角尖在 15px 附近。线跑到标题下面的话，
 * 视觉上就不再是「挂在那个角上」了（用户原话：偏到十万八千里）。
 */
.side-group {
  /* 伪元素要拿它当定位祖先：`left: 0` = padding box 左缘 = 树线该在的位置 */
  position: relative;
  margin: 1px var(--side-inset-r) 5px var(--side-rail);
  /* +1px 是给树线让出的位置（原来由 border-left 占着），文字起点保持不变 */
  padding-left: calc(var(--side-gap) + 1px);
}
/*
 * 树线用**伪元素**画，而不是 border-left。
 *
 * 为什么非改不可：线的颜色曾被身下的色块决定 —— 底色实一点就「换了颜色」，淡一点就
 * 露出原色，两头都试过，没有一个能同时满足「位置对」和「颜色一致」。
 * 把线抬到 `z-index: 1` 之后，它画在行的背景**之上**，hover 是密是疏、透与不透都无所谓，
 * 线的颜色永远等于 `--line`。唯一的例外是**选中那一条**：它按方案 E 抬到 2，压在线之上
 * （见 `.side-group > .side-i.on`）—— 那是刻意的，不是漏掉的。
 *
 * `left: 0` 落在 padding box 的左缘（border 已去掉），正是原来那条 border 的位置；
 * `pointer-events: none` 让它不吃点击（1px 宽，但没必要挡着行）。
 */
.side-group::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--line);
  z-index: 1;
  pointer-events: none;
}
/*
 * 组内的行向左探出，正好压住那条竖线的位置：
 * 平时背景透明；选中 / 悬停时是圆角条，**线从条子上方穿过去**（Obsidian 就是这样）。
 * 文字起点不变（-extend 的外边距 + extend 的内边距）。
 */
.side-group > .side-i,
.side-group > .side-row,
.side-group > .side-rename {
  /* 向左探出到 --side-pill；文字起点不变（-extend + extend） */
  margin-left: calc(-1 * var(--side-extend));
  padding-left: var(--side-extend);
  padding-right: var(--side-inset-r);
  width: calc(100% + var(--side-extend));
  border-radius: var(--side-radius);
}
.side-i {
  display: flex; justify-content: space-between; align-items: center;
  width: 100%; padding: 0 12px; height: 26px;
  font-size: 11.5px; color: var(--text-dim); text-align: left;
}
.side-i:hover { background: var(--surface-2); color: var(--text); }
.side-i.on { color: var(--text); background: var(--sel-bg); }
/* 组内：悬停 / 选中都用**半透明**底色，树线要从底下透出来 */
.side-group > .side-i:hover,
.side-group > .side-row:hover { background: var(--side-hover); }
.side-group > .side-i.on { background: var(--side-sel); }
/*
 * 选中的那一条**抬到树线之上**（方案 E，2026-11-08 定稿）。
 *
 * 六个候选都拍过对照图（a 原样 / b 线降不透明度 / c 0.5px / c2 两端淡出 / e 绿块压线）：
 * 用户看下来深浅两套主题里都是 E 最好看 —— 高亮块是**完整的一块**，线上不再从块里穿过去
 * 把它切成两半；hover 则保持在线之下（鼠标扫过时线照样连贯，不闪不跳）。
 *
 * 代价与取舍：块内的线会被 18% 的绿罩一层，颜色偏绿（深色 46,67,55 / 浅色 195,215,203）。
 * 这正是想要的效果 —— 线「属于」这一块，而不是浮在它上面。别把这个 z-index 去掉。
 */
.side-group > .side-i.on { position: relative; z-index: 2; }
.side-i em { font-style: normal; color: var(--text-faint); }
/* 列表名可能很长：让名字吃掉剩余宽度并省略，条数永远贴在右边 */
.side-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 就地改名：与条目同高，边框一亮就知道在编辑 */
.side-rename { cursor: default; }
.rename-input {
  width: 100%; height: 20px; padding: 0 6px;
  font-size: 11.5px; color: var(--text); background: var(--surface);
  border: 1px solid var(--accent); border-radius: 3px;
}
.side-row {
  display: flex; justify-content: space-between;
  width: 100%; padding: 0 12px; height: 22px; align-items: center;
  font-size: 11px; color: var(--text-dim); text-align: left;
  border-radius: 0;
}
/* 它是一个入口（打开词表编辑器），所以要有可点的反馈；右端数字留到最后 */
.side-row:hover { background: var(--surface-2); color: var(--text); }
.warn { color: var(--warn); }

/* 侧栏内联搜索（右键标题 →「搜索…」才出现）：占一行，只过滤标题关键词 */
.side-search {
  display: flex; align-items: center; gap: 4px;
  height: 24px;
  margin-left: calc(-1 * var(--side-extend));
  padding-left: var(--side-extend);
  padding-right: var(--side-inset-r);
  width: calc(100% + var(--side-extend));
}
.side-search-input {
  flex: 1; min-width: 0; height: 20px; padding: 0 6px;
  font: inherit; font-size: 11px; color: var(--text);
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 3px; outline: none;
}
.side-search-input:focus { border-color: var(--accent); }
.side-search-x {
  flex: none; width: 18px; height: 18px;
  border: 0; border-radius: 3px; background: transparent;
  color: var(--text-faint); font-size: 13px; line-height: 1;
  cursor: pointer;
}
.side-search-x:hover { background: var(--surface-2); color: var(--text); }
.side-empty { padding: 2px 12px 4px; font-size: 10.5px; color: var(--text-faint); }

/*
 * 侧栏行里的文字：**一行到底，长了就收成三个点**（用户 2026-11-08）。
 *
 * 起因：播放列表名可以起得很长，侧栏又有最小宽度 —— 以前那句文字会硬挤压换行，
 * 而 `.side-i` 的高度是写死的 26px，换来的是「字叠在一起」。
 * 现在文字自己负责省略，行高/行距永远不变形。
 *
 * `min-width: 0` 不能省：flex 子项的默认最小宽度是内容宽度，
 * 少了它 `text-overflow` 根本不会触发（这是这类 bug 的唯一常见原因）。
 *
 * `.side-label` = 固定文案（参与最小宽度测量）；`.side-name` = 用户数据（不参与，
 * 否则一个超长列表名能把侧栏顶到半屏）。两者的样式一样，只有测量的筛选条件不同。
 */
.side-label,
.side-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
/*
 * 计数/数字永远不许被压：它是 right 端的锚点，缩了就没有参照物。
 *
 * `margin-left: 10px` —— 省略号和数字之间必须留出呼吸（用户 2026-11-08：
 * 「省略号不要顶到后面的数字」）。`min-width: 2ch` 让一位数和两位数的数字
 * **左缘对齐**，于是不管计数是 8 还是 18，文字那侧被吃掉多少都一样，
 * 省略号的终点不会因为数字位数变来变去。
 */
.side-i > .num,
.side-row > .num {
  flex: none;
  margin-left: 10px;
  min-width: 2ch;
  text-align: right;
}

.main {
  position: relative;
  min-width: 0; min-height: 0;
  display: flex; flex-direction: column;
  background: var(--bg);
}
.table-pane { flex: 1; min-height: 0; overflow: hidden; }

/*
 * 下方面板：**上下分栏里的下半截**，不是浮层。
 *
 * 以前是 `position: absolute; bottom: 0`，靠 `--dock-inset` 给表格垫底 ——
 * 但表格自己的纵向滚动条仍贯穿整个高度，下半截被面板盖住，鼠标点不到。
 * 改成 flex 子项之后 `.table-pane` 自动让出这块高度，滚动条只到分界线为止。
 *
 * 不加投影：向上投影会在左右各留一条竖向暗带，面板占满主区时特别明显。
 * 分界靠 .splitter 自己的上下两条描边就够了。
 */
.dock {
  position: relative;
  flex: none;
  display: flex; flex-direction: column;
  min-height: 0;
  background: var(--bg);
}

.splitter {
  position: relative; flex: none;
  height: 7px; cursor: row-resize;
  background: color-mix(in srgb, var(--surface-2) 80%, var(--line-strong));
  border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line);
}
.splitter:hover, .splitter:active { background: var(--sel-bg); }
.splitter .grip {
  position: absolute; left: 50%; top: 2px;
  width: 46px; height: 3px; margin-left: -23px;
  border-radius: 2px;
  background: var(--text-faint);
  opacity: 0.7;
}
.splitter:hover .grip { background: var(--accent); }
.splitter.closed { border-bottom-color: var(--line); }

.bottom-panel { flex: 1; min-height: 0; overflow: hidden; }

.panel-btn { width: auto; padding: 0 8px; font-size: 11px; }
.panel-btn.on { color: var(--text); border-color: var(--accent); background: var(--sel-bg); }

/* 详情 */
.detail {
  border-left: 1px solid var(--line);
  overflow: auto;
  background: var(--surface);
  padding-bottom: 20px;
}
.d-head { padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
.d-head h2 {
  margin: 0 0 3px; font-size: 15px; font-weight: 500; letter-spacing: 0.02em;
  display: flex; align-items: center; gap: 8px;
  /* 预设补全的下拉贴着标题长出来；不给 h2 定位，它就会跑到整个 detail 的某个祖先上 */
  position: relative;
}
.d-head p { margin: 0; font-size: 11px; }
.d-head .subtitle {
  margin: 0 0 4px; font-size: 11px; color: var(--text-dim); line-height: 1.45;
}
.d-head .alias-line { color: var(--text-faint); margin-top: 2px; }
.d-head .alias-line .k { color: var(--text-dim); }
/* 时期单独一行：它不属于「标签：值」那套，别和别名挤在一句里 */
.d-period { color: var(--text-faint); margin-bottom: 2px; }
/* 流派同理：与时期并列，但一个是时间轴、一个是写法与来源 */
.d-genre { color: var(--text-faint); font-size: 11px; margin-bottom: 2px; position: relative; }
.d-album { color: var(--text-faint); font-size: 11px; margin-bottom: 2px; }
/* 专辑序号：跟专辑同一行的排版，只是值短、可以右对齐着看 */
.d-album-no { color: var(--text-faint); font-size: 11px; margin-bottom: 2px; display: flex; align-items: baseline; gap: 5px; }
.d-album-no .edit-input { width: 58px; height: 18px; padding: 0 4px; font-size: 11px; }

/* 封面：缩略图 + 占位 */
/* ---- 音源与录音版本 ----
   面板里每版一行：绿点 · 版本名 · 摘要 · 来源。整行是个按钮，
   点开「管理录音版本」窗口去改细节 —— 这里只负责「一眼认出是哪一版」。 */
/* 区块标题行：标题 · 计数 · 右侧动作。
   用栅格而不是 flex + margin-left:auto —— 第三列吃掉剩余空间，
   按钮 justify-self:end 就是**确定的**右对齐，不依赖 auto margin 被谁吃掉。 */
.d-h-act {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  column-gap: 7px;
}
.d-h-count { font-size: 9.5px; color: var(--text-faint); font-weight: 400; }
/* 「管理录音版本」右对齐：它管的是整张清单一类动作，不该跟区块标题挤在一起 */
.d-manage {
  justify-self: end;
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: transparent;
}
.d-manage:hover { background: var(--sel-bg); border-color: var(--accent); }

.rec-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
/* 圆点 · 名字 · 摘要 · 来源
   列数必须和子元素个数一致：多一列会在右边留一截死空隙，
   少一列则会把尾部元素挤到下一行第 1 列（8px 的圆点列）—— 一个字一行。 */
.rec-item {
  display: grid;
  grid-template-columns: 8px auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 7px;
  padding: 4px 6px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  color: var(--text-dim);
}
.rec-item:hover { background: var(--surface-2); border-color: var(--line); }
/* 默认播放的那条：绿边 + 浅底，跟列表选中态同一套语言 */
.rec-item.on { border-color: color-mix(in srgb, var(--accent) 50%, transparent); background: var(--sel-bg); }
.rec-dot {
  width: 8px; height: 8px; flex: none;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  background: transparent;
}
.rec-dot.on { background: var(--accent); border-color: var(--accent); }
.rec-name {
  font-size: 11.5px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}
/* 摘要会很长（几演奏者 + 年份 + 时长），窄面板里必须能自己截断 */
.rec-meta {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.rec-src {
  font-size: 9px;
  padding: 0 4px;
  border-radius: 2px;
  border: 1px solid var(--line);
  color: var(--text-faint);
  flex: none;
}
.rec-src.local { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.rec-src.none { opacity: 0.55; }

/* ---- 封面：绿色文件名 + 点击看图 ----
   详情面板只有 260px 宽，72px 的缩略图会把旁边的信息挤到换行，
   而且一张彩色封面比一整列文字都抢眼。所以只给一个可点的文件名。 */
.d-covers { display: flex; align-items: center; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.cover-file {
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 1px 5px;
  max-width: 74%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
/* 小图片图标：纯 CSS，不额外请求一张图 */
.cover-file::before {
  content: '';
  width: 9px; height: 11px; flex: none;
  border: 1px solid currentColor;
  border-radius: 1px;
  background: linear-gradient(135deg, transparent 48%, currentColor 49%, currentColor 53%, transparent 54%);
}
.cover-file:hover { border-color: var(--accent); background: var(--sel-bg); }
.cover-add {
  border: 1px dashed var(--line);
  border-radius: 3px;
  background: transparent;
  color: var(--text-faint);
  font-size: 10.5px;
  cursor: pointer;
  padding: 2px 7px;
}
.cover-add:hover { border-color: var(--accent); color: var(--accent); }

/* 确认框 */
.confirm { min-width: 320px; max-width: 420px; }
.confirm-body { margin: 6px 0 14px; font-size: 12px; line-height: 1.7; color: var(--text-dim); }
.confirm-actions { display: flex; justify-content: flex-end; gap: 6px; }
/* 焦点给容器（tabindex=-1）时不要画一圈虚线框，弹窗本身已经足够显眼 */
.modal.confirm:focus { outline: none; }

/**
 * 危险按钮两档：
 * - `.chip.danger`：描边红，用在列表行里（归档列表的「彻底删除」）—— 一排实心红太吵；
 * - `.chip.danger.solid`：实心红，用在确认框的主按钮上 —— 要的是「一眼看见、不会点错」。
 * 原先 `.chip.danger` 这个类一直在模板里用，但从来没写过样式，所以模板写 danger、
 * 界面上却是个普通灰按钮：名字骗了人，危险动作看着毫无危险。
 */
.chip.danger { color: var(--danger); border-color: var(--danger); background: transparent; }
.chip.danger:hover { color: #fff; background: var(--danger); border-color: var(--danger); }
.chip.danger.solid {
  height: 26px;
  padding: 0 16px;
  font-weight: 500;
  color: #fff;
  background: var(--danger);
  border-color: var(--danger);
}
.chip.danger.solid:hover { background: var(--danger-hi); border-color: var(--danger-hi); }

/* 歌词状态行 */
.d-lyrics { display: flex; align-items: center; gap: 6px; margin-top: 9px; flex-wrap: wrap; font-size: 11px; }
.d-lyrics .k { color: var(--text-dim); }
.inst-tag { padding: 1px 7px; border-radius: 8px; background: var(--surface-2); color: var(--text-faint); font-size: 10.5px; }
.lyric-how { color: var(--accent); font-size: 10.5px; }

.play-btn {
  margin-left: auto; flex: none;
  width: 22px; height: 22px; border-radius: 50%;
  border: 1px solid var(--line-strong); color: var(--text-dim);
  font-size: 9px; line-height: 1;
}
.play-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.play-btn:disabled { opacity: 0.35; cursor: not-allowed; }

.moods { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; position: relative; }

/* 字段补全下拉（流派 / 情绪）：贴着输入框下沿长出来，不挤动下面的模块 */
.field-sug {
  position: absolute; z-index: 40; top: 100%; left: 0;
  margin: 2px 0 0; padding: 3px; list-style: none;
  min-width: 168px; max-width: 260px; max-height: 208px; overflow: auto;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 4px; box-shadow: var(--shadow);
  cursor: default;
}
.field-sug li {
  display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
  padding: 3px 6px; border-radius: 3px; cursor: pointer;
  font-size: 11.5px; color: var(--text); line-height: 1.5;
}
.field-sug li.on { background: var(--sel-bg); }
.field-sug em { color: var(--text-faint); font-style: normal; font-size: 10px; }
/* 标题预设：名字长得像标识符、模板原文也是模板文本，都跟着 `--tpl-font` 走
   （默认仍是等宽，所以外观不变；改字体时和选项里那两块一起变） */
.title-sug { min-width: 320px; max-width: min(520px, 88vw); }
.title-sug li { display: block; }
.title-sug .sug-name { font-family: var(--tpl-font, var(--font-text)); color: var(--accent); font-size: 11.5px; }
.title-sug .sug-template {
  display: block;
  margin-top: 1px;
  color: var(--text-dim);
  font-family: var(--tpl-font, var(--font-text));
  font-size: 10px;
  line-height: 1.45;
  white-space: normal;
  overflow-wrap: anywhere;
}
.mood {
  font-size: 10px; color: var(--text-dim);
  border: 1px solid var(--line); border-radius: 9px;
  padding: 0 6px; line-height: 15px;
}
/* 体裁 / 曲式：每行一个可双击编辑的值，候选框贴着这一行长出来
   （position: relative 必须挂在**单行**的容器上；挂在整块上，
   第一行的候选会飘到第二行下面去） */
.d-pick { position: relative; }

.d-sec { padding: 10px 14px; border-bottom: 1px solid var(--line); }
.d-h {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-faint); margin-bottom: 7px;
}
/* 「乐器组合（Instrumentation）」是中英混排，不能被 uppercase 把英文拉成全大写 */
.d-h.plain { text-transform: none; letter-spacing: 0.03em; font-size: 10.5px; }
/*
 * 详情里的「标签：值」一律左对齐。
 * 原来是 label 左、值右对齐（space-between）：值一长就把 label 挤去换行，
 * 值自己又是右对齐 + 逐字可断，于是 f natural minor 被拆成 f / natural minor。
 * 现在改成定义列表式：label 不换行，值紧跟其后，只在词与词之间换行。
 */
.d-row {
  display: flex; align-items: baseline; gap: 4px;
  font-size: 11.5px; color: var(--text-dim); padding: 2px 0;
}
.d-row > .k { flex: none; white-space: nowrap; }
.d-row > .v {
  flex: 1; min-width: 0;
  font-weight: 500; color: var(--text); text-align: left;
  white-space: normal; overflow-wrap: break-word;
}
/* 空值（未标注）：灰。写一条显式规则，不靠 `.editable.empty` 与上面的先后顺序 —— 
   两条选择器权重相同（0,2,0），谁在后面谁赢，挪一下样式就静默失效。 */
.d-row > .v.empty { color: var(--text-faint); font-weight: 400; }
/* 冒号交给 CSS：中文全角、英文半角，词典里不用为标点维护两套文案 */
.k::after { content: '：'; color: var(--text-faint); }
html[lang='en'] .k::after { content: ': '; }

/*
 * 双击可编辑的值：平时就是一段文字，悬停才显出「这里能改」。
 * 不做常驻输入框 —— 详情面板首先是读的地方，满屏 input 会把标题、
 * 调性链、制作名单压成一张表单，视觉重心全跑到框线上。
 */
.editable { border-radius: 2px; cursor: text; }
.editable:hover {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  box-shadow: inset 0 -1px 0 var(--accent);
}
/* 空值占位（未标注）：淡，但和正常值一样能双击录入 */
.empty .editable,
.editable.empty { color: var(--text-faint); }
/* 拍号 / 速度的「未标注」：不斜体，字号与下方调性那一行一致（11px）；
   它只是没填，不是另一种值，不该看起来像另一类字段。 */
.editable.untagged { color: var(--text-faint); font-style: normal; font-size: 11px; }
/* pre：保留标题里手打的连续空格（nowrap 会把多空格折成一个）。
   仍然不换行、超出省略，和原来的单行行为一致。 */
.d-head h2 .title-text { overflow: hidden; text-overflow: ellipsis; white-space: pre; }
.edit-input {
  width: 100%; min-width: 0;
  font: inherit; font-size: 11.5px; line-height: 1.45;
  color: var(--text); background: var(--surface-2);
  border: 1px solid var(--accent); border-radius: 2px;
  padding: 1px 4px; outline: none;
}
.edit-input.title { font-size: 15px; font-weight: 500; letter-spacing: 0.02em; }
.d-head h2 .edit-input.title { flex: 1 1 auto; width: auto; }
/* 拍号类型（派生值）：跟在「130 BPM」后面，小一号、淡一点。
   有歧义的拍号（分子 4）颜色稍亮，提示这里有个 ⓘ 可看。 */
.mt-type { font-size: 10px; color: var(--text-faint); letter-spacing: 0.02em; }
.mt-type.amb { color: var(--text-dim); }
/* 圆圈 i：**紧挨在「复拍子」右边**，13px ≈ 这一行的字号高度，
   和文字**同一水平线**（不是上标，也不许往下掉）。
   和文字之间留 5px，别黏在一起。

   对齐这两个像素很讲究：`inline-flex` 的基线取内部**最后一个行内盒**的基线。
   以前里面是一个「i」字符 → 基线是**字的基线**（比盒子底边高约 3px），所以 `1.5px` 够；
   现在里面是 SVG（替换元素）→ 基线**就是它的下边缘**，同样的 `1.5px` 会把整圈抬高 3px
   （实测中线 237.94 vs 文字 240.94，冒烟当场判红）。所以这里是 `-2px`。
   换图标实现（SVG ↔ 字符）时**必须重跑那条中线断言**，别按旧值硬调。

   为什么画 SVG 而不是「11px 方块 + 1px 描边 + border-radius: 50%」：
   那个圆环在 125% 界面缩放下落在半像素上，Chromium 只能按 1.25 个设备像素去糊，
   用户看到的就是「锯齿感很重」。SVG 是矢量，同样面积下边缘采样更干净。

   尺寸为什么是 13 而不是 11/12：12px 里塞「1px 圆环 + 1px 的点 + 1px 的竖线」，
   三条线全是半覆盖，1x 屏上会糊成一根没有点的竖条（实测点那一行只有 65/255 的亮度）。
   13px 多一行像素之后：圆环最外圈能吃满整格（127/255）、点是一整格、点和竖线之间
   还留出一整行空 —— 这才是能认出来的 ⓘ。 */
.mt-i {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  margin-left: 5px;
  color: var(--accent);
  /* SVG 的下边缘就是 inline-flex 的基线，-2px 才和 10px 字号的中线齐平（见上面的说明） */
  vertical-align: -2px;
  cursor: help;
  outline: none;
  border-radius: 50%;
}
.mt-i svg {
  display: block;
  /* 几何精度：不要为了「清晰」把圆整成方块像素（那才是真正的锯齿） */
  shape-rendering: geometricPrecision;
}
/* 钉住时加一圈淡光晕：一眼能看出「这个气泡是点开的，不会自己消失」 */
.mt-i.pinned {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent);
}
/* 说明气泡：Teleport 到 body + position: fixed（坐标由 openMeterTip 算）。
   留在 `.detail` 里一定会被裁 —— 那是 overflow:auto，气泡比右栏还宽。
   字体用界面字体而不是等宽：这段是中文说明，等宽读起来累。
   接鼠标：从图标挪进气泡里不该被收掉（离开才 1s 后收），文字也能拖选。 */
.mt-pop {
  position: fixed;
  z-index: 45;
  width: 268px;
  padding: 9px 11px;
  font-family: var(--font-ui);
  font-size: 11.5px;
  font-weight: 400;
  line-height: 1.65;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: 0 8px 22px rgb(0 0 0 / 0.24);
  white-space: normal;
  text-align: left;
  pointer-events: auto;
  user-select: text;
  cursor: text;
}

/* 拍号与速度是短值，撑满一行会把「· 120 BPM」推走 */
.edit-input.meter { width: 46px; }
.edit-input.bpm { width: 54px; }
.keys > .edit-input { flex: 1 1 auto; width: auto; }
.moods > .edit-input { flex: 1 1 auto; width: auto; }
.moods.empty .editable { font-size: 10.5px; }
/* 调性是一串「c dorian → c natural minor → …」。每个调名是整体、不拆字，
   放不下时整组换到下一行 —— 断在 "f" 和 "natural minor" 之间是最难看的那种 */
.d-row > .keys { display: flex; flex-wrap: wrap; gap: 0 5px; line-height: 1.6; font-size: 11px; }
.keys .key-item { white-space: nowrap; }
.keys .arrow { color: var(--text-faint); margin-right: 5px; }
/* 制作名单里人名很长，允许换行，不要挤成一条 */
.d-row > .credit { font-size: 11px; line-height: 1.5; }
.inline { display: inline-flex; align-items: center; gap: 6px; }

.tag-group { margin-bottom: 8px; }
.tag-dim { font-size: 10px; color: var(--text-faint); margin-bottom: 4px; }
.tag-list { display: flex; flex-wrap: wrap; gap: 4px; }
.tag .x {
  color: var(--text-faint); font-size: 11px; line-height: 1;
  padding: 0 0 0 2px;
}
.tag:hover .x { color: var(--accent); }
.picker-row { margin-top: 6px; }

/* 乐器组合里的子块：摘要下面挂「乐器」「演奏技法」，靠一道竖线分层 */
.d-sub { margin-top: 10px; }
.d-sub-h {
  font-size: 10px; color: var(--text-faint); margin-bottom: 5px;
  padding-left: 6px; border-left: 2px solid var(--line);
}

/*
 * 详情空白处的右键菜单（模块显隐）。
 * position: fixed —— 详情面板自己是滚动容器，绝对定位会跟着滚。
 */
.ctxmenu {
  position: fixed; z-index: 80;
  min-width: 178px; padding: 4px;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 4px; box-shadow: var(--shadow);
}
.ctx-h {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-faint); padding: 4px 6px 6px;
}
.ctx-item {
  display: flex; align-items: center; gap: 6px;
  width: 100%; height: 22px; padding: 0 6px;
  font-size: 11.5px; color: var(--text); text-align: left;
  border-radius: 3px;
}
.ctx-item:hover { background: var(--sel-bg); }
/* 关掉的模块整行变淡，勾也留空位：一眼能看出哪些没显示 */
.ctx-item.off { color: var(--text-faint); }
/* 破坏性动作：红字，别和上面的普通项长得一样 */
.ctx-item.danger { color: var(--warn); }
.ctx-item.danger:hover { background: var(--surface-2); }
.ctx-tick { width: 10px; flex: none; color: var(--accent); font-size: 10px; }
.ctx-sep { height: 1px; margin: 4px 2px; background: var(--line); }

/* 曲目行菜单：比模块菜单宽一点，因为「从「某某列表」移出」会把列表名带进来 */
.track-menu { min-width: 196px; }
.rec-menu { min-width: 180px; }

/* ---- 「添加到播放列表」的选列表弹窗 ---- */
.pl-pick { width: 380px; }
.pl-pick-list {
  margin: 10px 0 0;
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: 4px;
}
.pl-pick-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; height: 28px; padding: 0 8px;
  font-size: 11.5px; color: var(--text); text-align: left;
  background: none; border: 0; border-radius: 0;
  font-family: inherit; cursor: pointer;
}
/* 行之间一条淡线：列表一长，点错行比看不清更常见 */
.pl-pick-row + .pl-pick-row { border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
.pl-pick-row:hover { background: var(--sel-bg); }
.pl-pick-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-pick-n { flex: none; color: var(--text-faint); }
/* 右侧那个词是「点下去会发生什么」：能加 = accent，已在其中 = 灰且不可点 */
.pl-pick-state { flex: none; width: 4.5em; text-align: right; font-size: 10.5px; color: var(--accent); }
.pl-pick-row.in { color: var(--text-faint); cursor: default; }
.pl-pick-row.in .pl-pick-state { color: var(--text-faint); }
.pl-pick-row.in:hover { background: none; }

.sections { width: 100%; border-collapse: collapse; font-size: 10.5px; table-layout: fixed; }
.sections th {
  text-align: left; font-weight: 400; color: var(--text-faint);
  padding: 3px 4px; border-bottom: 1px solid var(--line);
}
.sections th:nth-child(1) { width: 22px; }
.sections th:nth-child(2) { width: 92px; }
.sections th:nth-child(3) { width: 62px; }
.sections td {
  padding: 3px 4px; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 段落表的时间列：14ch ≈ 69px，留到 92px 够 4 位小节号 + 内边距 */
.sections th.w-time { width: 92px; }
/* 双击跳到该段：只加可点的光标提示，不做按钮样式（表格里加按钮太吵） */
.sections .sec-row:hover td { background: color-mix(in srgb, var(--sel-bg) 60%, transparent); }
/* 小节.拍.十六分.tick 的固定格子样式在 BarBeatText.vue（播放条与详情共用），
   这里不再留一份，免得两处宽度漂移。 */
.tiny { font-size: 10.5px; line-height: 1.5; margin: 6px 0 0; }

/* 状态栏 */
.status {
  display: flex; align-items: center; gap: 8px;
  padding: 0 14px; border-top: 1px solid var(--line);
  background: var(--surface-2); color: var(--text-dim); font-size: 10.5px;
}
.status .grow { flex: 1; }
.sep { color: var(--text-faint); }

/* 弹层 */
.modal-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 50;
}
/*
 * 叠在另一个模态**之上**的确认框。两个 `.modal-mask` 都是 50 时，
 * DOM 里后出现的那个赢：选项面板排在确认框后面，于是「放弃未保存的模板？」
 * 被面板整块盖住 —— 看不见、点不到，用户只看到关闭按钮没反应
 * （2026-11-23 实际踩到）。需要叠层的模态都挂这个 class，别单独写 magic number。
 * 取 75：高于音频元数据框（60）与元数据应用框（70），低于右键菜单（80）。
 */
.modal-mask.above { z-index: 75; }
.modal {
  width: 560px; max-height: 70vh; overflow: auto;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 5px; box-shadow: var(--shadow); padding: 14px 16px;
}
.modal h3 { margin: 0 0 6px; font-size: 13px; font-weight: 500; }
.modal-foot { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }

/* 设置面板：左边一条 tab + 右边滚动区。600px = 104(tab) + 12(gap) + 约 460(内容)，
   内容区宽度和以前一样，只是不再被整体滚动拖走。 */
.settings { width: 600px; overflow: hidden; }
/* ---- 标题模板预设：名字 + 作用域 + 一行高亮模板；编辑器在下方 ----
   字体只有一份：`--tpl-font`（选项 → 外观）。预设列表、模板编辑器、候选预览
   全都读它，换字体时三处一起变 —— 用户 2026-11-23 明确要求「两块统一」。 */
.tpl-list { display: flex; flex-direction: column; gap: 5px; margin: 8px 0 12px; }
.tpl-preset {
  padding: 5px 7px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
}
.tpl-preset-head { display: flex; align-items: center; gap: 6px; }
.tpl-preset-name {
  font-family: var(--tpl-font, var(--font-text));
  font-size: 11.5px;
  font-weight: 500;
  color: var(--accent);
}
.tpl-official {
  font-size: 9.5px;
  color: var(--text-faint);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0 5px;
}
.tpl-preset-actions { margin-left: auto; display: flex; gap: 4px; }
.tpl-line {
  margin-top: 3px;
  font-family: var(--tpl-font, var(--font-text));
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.tpl-line .v { color: var(--accent); }
.tpl-form { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--line); }
.tpl-form-row { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
.tpl-name {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  font-family: var(--tpl-font, var(--font-text));
  font-size: 11px;
}
.tpl-scope { height: 24px; padding: 0 6px; font-size: 11px; }
.tpl-save {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.tpl-msg { margin: 5px 0 0; font-size: 10.5px; color: var(--accent); }
.tpl-msg.bad { color: var(--warn); }
.tpl-vars { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 7px; }
.tpl-var {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  height: 18px;
  padding: 0 6px;
  border: 1px solid var(--line);
  border-radius: 9px;
  font-size: 10px;
  color: var(--text-faint);
}
.tpl-var b { font-family: var(--tpl-font, var(--font-text)); font-weight: 500; color: var(--accent); }
.tpl-var em { font-style: normal; }
.s-body { display: flex; gap: 12px; min-height: 0; }
.s-nav {
  flex: 0 0 104px;
  display: flex; flex-direction: column; gap: 1px;
  padding-top: 2px;
}
.s-nav button {
  text-align: left; padding: 5px 8px; border-radius: 4px;
  font-size: 11.5px; color: var(--text-dim);
  background: none; border: 0; font-family: inherit; cursor: pointer;
}
.s-nav button:hover { background: var(--surface-2); color: var(--text); }
.s-nav button.on { background: var(--sel-bg); color: var(--text); }
/* position: relative 是给 scroll spy 用的：子块 offsetTop 相对它算 */
.s-panes {
  position: relative;
  flex: 1 1 auto; min-width: 0;
  max-height: 62vh; overflow: auto;
  padding-right: 4px;
}
.s-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.s-head h3 { margin: 0; }
.s-sec { padding: 10px 0; border-top: 1px solid var(--line); }
.s-sec:first-of-type { border-top: 0; }
.s-h {
  display: flex; align-items: center; gap: 6px;
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-faint); margin-bottom: 6px;
}
.zoom-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.chip.on { background: var(--sel-bg); border-color: var(--accent); color: var(--text); }
.mono-demo { font-size: 10.5px; line-height: 1.7; }

/*
 * 侧栏留白那两行（浅色 / 深色各一份）。
 * 用等宽数字 + 固定输入框宽度，两行的「px」才会落在同一条竖线上 ——
 * 数字输入框默认会随内容伸缩，不锁宽的话两行永远对不齐。
 */
.inset-block { margin-top: 10px; }
.s-sub {
  font-size: 10px; letter-spacing: 0.06em;
  color: var(--text-dim); margin-bottom: 2px;
}
.inset-row {
  display: flex; align-items: center; gap: 6px;
  margin-top: 6px; font-size: 11.5px; color: var(--text-dim);
}
/* 这些一律 nowrap + flex:none：行是 flex，不锁住的话「专属左边距：」会被压成两行 */
.inset-mode { color: var(--text); min-width: 132px; flex: none; white-space: nowrap; }
.inset-k { color: var(--text-faint); flex: none; white-space: nowrap; }
.inset-num {
  width: 46px; padding: 2px 4px;
  font: inherit; font-size: 11.5px; font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--text); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: 4px;
}
.inset-num:focus { outline: none; border-color: var(--accent); }
.inset-row .unit { color: var(--text-faint); margin-right: 10px; flex: none; white-space: nowrap; }

/* 选项面板：行内开关与滑块 */
.pref-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text); margin-top: 6px; cursor: pointer; }
/* 收款码：左右并排，图本身白底（二维码要留白才扫得出来） */
.support-modal { width: 700px; max-width: calc(100vw - 80px); }
.support-qrs {
  display: flex;
  gap: 20px;
  justify-content: center;
  margin-top: 12px;
}
.support-qr { margin: 0; text-align: center; }
.support-qr img {
  display: block;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: #fff;
}
.support-qr figcaption { margin-top: 6px; font-size: 11px; color: var(--text-dim); }

/* 工作区的命名输入 + 两个按钮 */
.ws-name-input {
  width: 100%;
  height: 26px;
  margin-top: 4px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 3px;
}
.ws-name-input:focus {
  border-color: var(--accent);
  outline: none;
}
.ws-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

/* 设置里的数字输入（撤销上限 / 保留条数）：窄一点，别把整行推歪 */
.pref-num {
  width: 62px;
  height: 20px;
  padding: 0 5px;
  font-size: 11.5px;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: 3px;
}
.pref-num:focus {
  border-color: var(--accent);
  outline: none;
}
.pref-row-group { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 11px; color: var(--text-dim); }
.pref-row-group label { flex: none; min-width: 80px; }
.pref-row-group input[type="range"] { flex: 1; accent-color: var(--accent); }

/**
 * 复选框：自己画，走 Vue 绿。
 *
 * 原来完全没样式，是 Chromium 原生外观 —— 深色底下那个系统蓝方块特别扎眼，
 * 而且深浅两套主题里它都不属于任何一个（它跟 --accent 没关系）。
 *
 * 为什么用 appearance:none 而不是 accent-color：
 *   accent-color 只改「勾」的颜色，边框、圆角、底色还是系统画的，
 *   细边框在深色下依旧发灰。整套自己画才能跟 .chip.on 用同一个高亮语言。
 *
 * 为什么方框画在 ::before 上、input 本体留空：
 *   Chromium 对 appearance:none 的 checkbox 仍会套一层内部最小尺寸
 *   （实测只写 width:13px 会被顶到 16px，min-width 也压不住）。
 *   让 input 自己透明退到幕后当纯事件靶，方框完全交给伪元素，
 *   尺寸就再不受浏览器摆布。
 */
.pref-row input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
  /* tokens.css 给所有 input 设了 padding: 4px 7px（给文本框用的）。
     不清掉的话 13px 宽会被 padding 顶到 16px —— 方框画在 ::before 上，
     而 ::before 是 inset:0，会跟着一起变大。 */
  padding: 0;
  flex: none;
  width: 13px;
  height: 13px;
  background: transparent;
  border: 0;   /* 同理：边框也归 ::before 管 */
  cursor: pointer;
  position: relative;
}
.pref-row input[type="checkbox"]::before {
  content: '';
  position: absolute;
  inset: 0;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: var(--surface-2);
  transition: background .12s, border-color .12s;
}
.pref-row input[type="checkbox"]:hover::before { border-color: var(--accent); }
/* 选中：底色用主色，与 .chip.on 的 --sel-bg + --accent 描边同一套语言 */
.pref-row input[type="checkbox"]:checked::before {
  background: var(--accent);
  border-color: var(--accent);
}
/* 勾：两条边转 43° 拼成 */
.pref-row input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 3px;
  height: 6px;
  border: solid #fff;
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(43deg);
}
/* 焦点环不能去掉：键盘 Tab 过来要看得见在哪。
   用 accent 色的浅晕，深浅主题下都清楚。 */
.pref-row input[type="checkbox"]:focus-visible::before {
  box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.35);
}

</style>
