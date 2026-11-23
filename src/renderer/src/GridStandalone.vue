<script setup lang="ts">
/**
 * 网格独立窗口的根组件。
 * 同一个渲染层，靠 hash（#grid?track=…&view=…）路由进来 —— 不为一个窗口单独打包一份。
 *
 * 布局：顶栏（品牌/标题/缩放）+ 左侧栏（泳道方案，可隐藏可拖宽）+ 网格 + 播放条。
 *
 * 顶栏以前把**所有视图**平铺成胶囊，视图一多就顶出右边边界（全屏更明显）——
 * 视图切换本来就是「选一个方案」，属于侧栏内容，挪进去之后顶栏只剩固定几件东西，
 * 永远不会溢出。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import GridEditor from './views/GridEditor.vue';
import TransportBar from './components/TransportBar.vue';
import { loadTrack } from './audio/store.js';
import { timelineDurationMs } from '@shared/timeline-clock.js';
import { applyLocaleToDom, locale, t } from './i18n';

const api = (window as any).api;
const params = new URLSearchParams(location.hash.replace(/^#/, '').split('?')[1] ?? '');
const trackId = params.get('track') ?? '';

const meta = ref<any>(null);
const detail = ref<any>(null);
const viewId = ref(params.get('view') ?? '');
const zoom = ref(1);
const error = ref('');

const currentView = computed(() => meta.value?.views.find((v: any) => v.id === viewId.value) ?? null);

/* ---------------- 格单位：本窗口没有单位菜单，跟随主窗口 ---------------- */

/**
 * 主窗口和这个窗口是**两个渲染进程**，共享同一个 origin 的 localStorage。
 * 主窗口切单位时写 `ma-grid-unit`，这里靠 `storage` 事件跟过去。
 *
 * 为什么必须有这个：`nudgeSpan()`（Alt+方向键）的「一格」= 当前单位的格宽。
 * 以前这个窗口没接 `:unit`，恒为一拍 —— 在主窗口切到「小节」后过来按 Alt+←，
 * 仍然只收 480，看起来就是「步长写死了一拍」。
 */
const UNIT_KEY = 'ma-grid-unit';
const unit = ref<'bar' | 'beat' | 'half'>(readUnit());

function readUnit(): 'bar' | 'beat' | 'half' {
  try {
    const raw = localStorage.getItem(UNIT_KEY);
    if (raw === 'bar' || raw === 'beat' || raw === 'half') return raw;
  } catch {
    /* 隐私模式读不到 */
  }
  return 'beat';
}

function onUnitChange(u: 'bar' | 'beat' | 'half') {
  unit.value = u;
  try {
    localStorage.setItem(UNIT_KEY, u);
  } catch {
    /* 存不下就只在本次会话生效 */
  }
}

/** `storage` 事件只在**别的窗口**改 localStorage 时触发，正好是主窗口切单位那一刻 */
function onStorage(e: StorageEvent) {
  if (e.key === UNIT_KEY) unit.value = readUnit();
}

/* ---------------- 左侧栏：显示开关 + 可拖宽 ---------------- */

const SIDE_MIN = 140;
const SIDE_MAX = 380;

function readNum(key: string, dflt: number, lo: number, hi: number) {
  try {
    const raw = Number(localStorage.getItem(key));
    if (Number.isFinite(raw) && raw > 0) return Math.max(lo, Math.min(hi, Math.round(raw)));
  } catch {
    /* 隐私模式读不到 */
  }
  return dflt;
}

const sideOpen = ref(localStorage.getItem('ma-gwin-side') !== '0');
const sideW = ref(readNum('ma-gwin-side-w', 190, SIDE_MIN, SIDE_MAX));

/**
 * 泳道侧栏的宽度与开合也记进 config.json（用户 2026-11-22：子窗口里能拖的都要记）。
 * localStorage 仍然写一份：主进程没起来 / IPC 失败时，至少本机还能记住。
 */
let sidePushTimer: number | null = null;
function pushSideState() {
  if (sidePushTimer) window.clearTimeout(sidePushTimer);
  sidePushTimer = window.setTimeout(() => {
    sidePushTimer = null;
    void api?.config
      ?.setLayout?.({ grid: { sideW: sideW.value, sideOpen: sideOpen.value } })
      ?.catch?.(() => undefined);
  }, 300);
}

/** 启动时从 config.json 读回来；没有就沿用 localStorage 的值 */
async function loadSideState() {
  try {
    const snap: any = await api?.config?.get?.();
    const g = snap?.layout?.grid ?? {};
    if (typeof g.sideW === 'number') sideW.value = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(g.sideW)));
    if (typeof g.sideOpen === 'boolean') sideOpen.value = g.sideOpen;
  } catch {
    /* 读不到就按本地存的值 */
  }
}

function toggleSide() {
  sideOpen.value = !sideOpen.value;
  try {
    localStorage.setItem('ma-gwin-side', sideOpen.value ? '1' : '0');
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  pushSideState();
}

let splitX = 0;
let splitStartW = 0;
let splitting = false;

function startSplit(ev: PointerEvent) {
  splitting = true;
  splitX = ev.clientX;
  splitStartW = sideW.value;
  try {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有指针可捕获 */
  }
  document.body.classList.add('resizing');
  ev.preventDefault();
}

function moveSplit(ev: PointerEvent) {
  if (!splitting) return;
  sideW.value = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(splitStartW + (ev.clientX - splitX))));
}

function endSplit() {
  if (!splitting) return;
  splitting = false;
  try {
    localStorage.setItem('ma-gwin-side-w', String(sideW.value));
  } catch {
    /* 存不下就只在本次会话生效 */
  }
  pushSideState();
  document.body.classList.remove('resizing');
}

async function load() {
  meta.value = await api.meta();
  detail.value = await api.tracks.get(trackId);
  if (!viewId.value) viewId.value = detail.value?.analysis?.viewId ?? meta.value?.views?.[0]?.id ?? '';
  applyTitle();
  void loadTrack(trackId, null, { timelineMs: timelineDurationMs(detail.value?.analysis) });
}

/** 窗口标题也走词典：切语言时这个窗口的标题要一起换 */
function applyTitle() {
  document.title = t('standalone.docTitle', { title: detail.value?.title ?? 'music-atlas' });
}

watch(locale, applyTitle);

async function setView(id: string) {
  viewId.value = id;
  const a = detail.value?.analysis;
  if (a) await api.analysis.setView(a.id, id);
}

async function refresh() {
  detail.value = await api.tracks.get(trackId);
}

async function setZoom(z: number) {
  zoom.value = await api.ui.setZoom(z);
  localStorage.setItem('ma-zoom', String(zoom.value));
}

function onKey(ev: KeyboardEvent) {
  if (!(ev.ctrlKey || ev.metaKey)) return;
  if (ev.key === '=' || ev.key === '+') {
    ev.preventDefault();
    setZoom(Math.min(2, zoom.value + 0.1));
  } else if (ev.key === '-') {
    ev.preventDefault();
    setZoom(Math.max(0.8, zoom.value - 0.1));
  } else if (ev.key === '0') {
    ev.preventDefault();
    setZoom(1);
  }
}

/** 工作区恢复：主进程把侧栏宽度 / 开合推过来时套上（只改界面，不再回写） */
let offGridSide: (() => void) | null = null;

onMounted(async () => {
  document.documentElement.dataset.theme = localStorage.getItem('ma-theme') ?? 'dark';
  if (localStorage.getItem('ma-font') === 'ui') document.documentElement.dataset.font = 'ui';
  applyLocaleToDom();
  window.addEventListener('keydown', onKey);
  window.addEventListener('storage', onStorage);
  offGridSide =
    api?.ws?.onGridSide?.((st: any) => {
      if (!st) return;
      if (typeof st.sideW === 'number') sideW.value = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(st.sideW)));
      if (typeof st.sideOpen === 'boolean') sideOpen.value = st.sideOpen;
    }) ?? null;
  await loadSideState();
  try {
    await load();
    await setZoom(Number(localStorage.getItem('ma-zoom')) || 1);
  } catch (e: any) {
    error.value = String(e?.message ?? e);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('storage', onStorage);
  offGridSide?.();
  offGridSide = null;
  /**
   * **不要 pause**：这个窗口不是音频宿主。
   * 以前这里调 pause()，关掉弹出窗口会把主窗口正在放的音乐一起停掉
   * （以前它是第二个播放器，停的是自己；现在 pause 会变成一条「暂停」指令发过去）。
   */
});
</script>

<template>
  <div class="gwin" :style="{ '--side-w': sideOpen ? sideW + 'px' : '0px' }">
    <header class="gh">
      <button
        class="chip icon"
        :class="{ on: sideOpen }"
        :title="t('standalone.sidebar')"
        @click="toggleSide"
      >
        ☰
      </button>
      <span class="brand">music<span class="dot">·</span>atlas</span>
      <span class="sep">/</span>
      <b class="t" :title="detail?.title ?? ''">{{ detail?.title ?? '—' }}</b>
      <span class="view faint">{{ currentView?.name ?? '' }}</span>

      <span class="grow" />

      <button class="chip" @click="setZoom(Math.max(0.8, zoom - 0.1))">−</button>
      <span class="num faint pct">{{ Math.round(zoom * 100) }}%</span>
      <button class="chip" @click="setZoom(Math.min(2, zoom + 0.1))">＋</button>
    </header>

    <div class="gbody">
      <aside v-if="sideOpen" class="gside">
        <div class="gside-h">{{ t('standalone.views') }}</div>
        <button
          v-for="v in meta?.views ?? []"
          :key="v.id"
          class="gside-i"
          :class="{ on: v.id === viewId }"
          @click="setView(v.id)"
        >
          {{ v.name }}
        </button>
      </aside>
      <!-- 拖拽手柄：absolute 定位，绝不占布局（否则会把网格挤窄一截） -->
      <div
        v-if="sideOpen"
        class="vsplit"
        :title="t('shell.resizeHint')"
        @pointerdown="startSplit"
        @pointermove="moveSplit"
        @pointerup="endSplit"
        @pointercancel="endSplit"
      />

      <main class="gmain">
        <GridEditor
          v-if="detail?.analysis"
          :analysis="detail.analysis"
          :view="currentView"
          :title="detail.title"
          :unit="unit"
          @unit-change="onUnitChange"
          @changed="refresh"
        />
        <div v-else class="empty">
          <p class="dim">{{ error || t('standalone.loading') }}</p>
          <p v-if="!error" class="faint">{{ t('standalone.shared') }}</p>
        </div>
      </main>
    </div>

    <TransportBar :analysis="detail?.analysis ?? null" @changed="refresh" />
  </div>
</template>

<style scoped>
.gwin { display: grid; grid-template-rows: 38px 1fr auto; height: 100%; }

/*
 * 顶栏：**必须能压缩**。以前把全部视图胶囊平铺在这里，视图一多就顶出右边界
 * （全屏下也溢出）。现在视图挪进左侧栏，顶栏只剩固定几件东西，
 * 再给 min-width:0 + 省略号兜住极端窄窗。
 */
.gh {
  display: flex; align-items: center; gap: 8px;
  padding: 0 10px;
  min-width: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  font-size: 11.5px;
}
.gh .brand { font-size: 11.5px; color: var(--text-dim); letter-spacing: 0.04em; flex: none; }
.gh .dot { color: var(--accent); }
.gh .t {
  font-weight: 500; flex: 0 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gh .view { flex: 0 0 auto; }
.gh .sep { color: var(--text-faint); flex: none; }
.gh .grow { flex: 1; }
.gh .pct { width: 34px; text-align: center; flex: none; }
.gh .chip.icon { width: 22px; padding: 0; justify-content: center; flex: none; }
.chip.on { background: var(--sel-bg); border-color: var(--accent); color: var(--text); }

.gbody { position: relative; display: flex; min-height: 0; min-width: 0; }

.gside {
  width: var(--side-w, 190px);
  flex: none;
  display: flex; flex-direction: column; gap: 1px;
  padding: 8px 6px;
  overflow: auto;
  border-right: 1px solid var(--line);
  background: var(--surface);
}
.gside-h {
  padding: 4px 8px 6px;
  font-size: 10.5px; color: var(--text-faint);
}
.gside-i {
  display: flex; align-items: center;
  height: 24px; padding: 0 8px;
  border-radius: 4px;
  text-align: left;
  font-size: 11.5px; color: var(--text-dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.gside-i:hover { background: var(--surface-2); color: var(--text); }
.gside-i.on { background: var(--sel-bg); color: var(--text); }

/* 手柄压在侧栏右缘；类名用 .vsplit —— .splitter 在别处是「面板横分隔条」 */
.vsplit {
  position: absolute; top: 0; bottom: 0;
  left: calc(var(--side-w, 190px) - 3px);
  width: 7px; z-index: 4;
  cursor: col-resize;
}
.vsplit::after {
  content: '';
  position: absolute; top: 0; bottom: 0; left: 3px; width: 1px;
  background: var(--accent); opacity: 0;
  transition: opacity 120ms ease;
}
.vsplit:hover::after { opacity: 0.55; }
body.resizing { cursor: col-resize; user-select: none; }
body.resizing .vsplit::after { opacity: 0.9; }

.gmain { flex: 1; min-width: 0; min-height: 0; }
.empty { padding: 40px; text-align: center; }
.empty p { margin: 4px 0; font-size: 11.5px; }
</style>
