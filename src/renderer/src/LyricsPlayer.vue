<script setup lang="ts">
/**
 * LyricsPlayer.vue — 歌词播报器
 *
 * 给普通听众用的子窗口：左边封面、右边滚动歌词、下方播放控件。
 * 纯音乐时显示制作信息与「纯音乐，请欣赏」。
 *
 * 路由：#lyrics（main.ts 里按 hash 切换根组件）
 * 数据来源：主窗口通过 player:state 广播播放状态；歌词走 lyrics:resolve IPC。
 *
 * 三件必须对齐主窗口的事：
 *  1) 配色走 tokens.css 的 CSS 变量，跟着 data-theme 走（深浅两套都不能瞎）；
 *  2) 播放控件的视觉与**顺序**照抄 TransportBar（播放在前、回到开头在后）；
 *  3) 控制指令一律发给主窗口 —— 音频宿主只有它一个，这里绝不放第二个 <audio>。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { activeLineIndex, formatLrcStamp, parseLrcStamp } from '@shared/lrc.js';
import { t } from './i18n';

const api = (window as any).api;

/* ---- 主题：主窗口是唯一来源，切了会广播过来 ---- */
function applyTheme(v: string) {
  document.documentElement.dataset.theme = v === 'light' ? 'light' : 'dark';
}

/* ---- 播放状态（主窗口推过来的） ---- */
const player = ref({
  trackId: null as string | null,
  title: null as string | null,
  playing: false,
  currentMs: 0,
  durationMs: 0,
  ready: false,
  recId: null as string | null,
});

/* ---- 歌词 ---- */
interface LyricLine { ms: number; endMs?: number; text: string }
const lyrics = ref<LyricLine[]>([]);
const lyricMeta = ref<any>(null);
const lyricHow = ref<'manual' | 'auto' | 'none' | 'instrumental' | 'version'>('none');
const lyricEditable = ref(true);
const lyricFormat = ref<'lrc' | 'elrc' | 'srt' | 'none'>('none');
const instrumental = ref(false);
/** 时间戳默认开着：听众要照着唱/对照，没这个没法用 */
const showTimestamps = ref(localStorage.getItem('ma-lyrics-ts') !== '0');
/** 封面显示开关（有人喜欢纯歌词窗口） */
const showCover = ref(localStorage.getItem('ma-lyrics-cover') !== '0');

/* ---- 封面 ---- */
const coverUrl = ref<string | null>(null);
const coverBroken = ref(false);

/* ---- 详情（用于显示制作信息等） ---- */
const detail = ref<any>(null);

/* ---- 翻译 ---- */
const translation = ref<{ ms: number; text: string }[]>([]);
const translationFile = ref<string | null>(null);
const showTranslation = ref(localStorage.getItem('ma-lyrics-trans') === '1');

/* ---- 音量 ---- */
/** 与主窗口共用 ma-gain 这个 key（线性幅度 0~1） */
const gainPct = ref(Math.round(Number(localStorage.getItem('ma-gain') ?? 1) * 100));

/* ---- 滚动 ---- */
const scrollContainer = ref<HTMLElement | null>(null);
let scrollToIdx = -1;
/** 当前句落在可视区顶部 38% 处（偏上，符合主流播放器做法） */
const ACTIVE_TOP_PCT = 38;

function currentTime(): number {
  return player.value.currentMs ?? 0;
}

/**
 * 找到当前时间该高亮的行。
 *
 * 算出来存进 ref，而不是在模板里当函数调 —— 模板每帧重渲染都调一次的话，
 * N 行歌词就是每帧 N 次二分查找，白烧 CPU。
 */
const activeIdx = computed(() => activeLineIndex(lyrics.value, currentTime()));
const editTitle = computed(() => {
  if (lyricFormat.value === 'elrc' || lyricFormat.value === 'srt') return t('lyrics.readonlyTimed');
  if (!lyricEditable.value) return t('lyrics.readonly');
  return t('lyrics.editText');
});

/** 翻译按 ms 对齐原句；差 50ms 内算同一句，对不上就退回按行序 */
function translationOf(idx: number, ms: number): string {
  if (!showTranslation.value || !translation.value.length) return '';
  const near = translation.value.find((x) => Math.abs(x.ms - ms) <= 50);
  if (near) return near.text;
  return translation.value[idx]?.text ?? '';
}

function scrollToActive() {
  const idx = activeIdx.value;
  if (idx < 0 || !scrollContainer.value) return;
  if (idx === scrollToIdx) return; // 同一行不重复滚
  scrollToIdx = idx;
  const el = scrollContainer.value.querySelector(`.l-line[data-idx="${idx}"]`) as HTMLElement | null;
  if (!el) return;
  const container = scrollContainer.value;
  const target = el.offsetTop - (container.clientHeight * ACTIVE_TOP_PCT) / 100 + el.offsetHeight / 2;
  container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

/* ---- 加载歌词与详情 ---- */
let loadToken = 0;
let loadedKey = '';
async function loadForTrack(trackId: string, recId?: string | null) {
  if (!trackId) {
    lyrics.value = [];
    lyricMeta.value = null;
    coverUrl.value = null;
    coverBroken.value = false;
    detail.value = null;
    lyricHow.value = 'none';
    lyricEditable.value = false;
    lyricFormat.value = 'none';
    instrumental.value = false;
    translation.value = [];
    translationFile.value = null;
    return;
  }
  // 快速切歌时旧请求可能后到，用 token 丢弃过期结果（否则 A 的歌词会盖在 B 上）
  const my = ++loadToken;
  try {
    const [doc, det, trans] = await Promise.all([
      api.lyrics.resolve(trackId, recId ?? null),
      api.tracks.get(trackId),
      // 翻译可能没有，不是错误
      api.lyrics.translation(trackId).catch(() => ({ found: false, file: null, lines: [] })),
    ]);
    if (my !== loadToken) return;
    lyrics.value = doc.lines ?? [];
    lyricMeta.value = doc.meta ?? null;
    instrumental.value = !!doc.instrumental;
    lyricHow.value = doc.instrumental ? 'instrumental' : doc.how;
    lyricEditable.value = !!doc.editable;
    lyricFormat.value = doc.format ?? 'lrc';
    loadedKey = `${trackId}|${recId || ''}`;
    const rec = recId ? (det?.recordings ?? []).find((r: any) => r.id === recId) : det?.currentRecording;
    const versionCover = rec?.coverRel
      ? `ma-art://cover/${encodeURIComponent(trackId)}/version/${encodeURIComponent(rec.id)}?v=${encodeURIComponent(rec.coverRel)}`
      : null;
    coverUrl.value = versionCover ?? det?.covers?.url ?? null;
    coverBroken.value = false;
    detail.value = det ?? null;
    translation.value = trans?.lines ?? [];
    translationFile.value = trans?.file ?? null;
    scrollToIdx = -1;
    requestAnimationFrame(() => scrollToActive());
  } catch (e) {
    if (my !== loadToken) return;
    lyrics.value = [];
    detail.value = null;
    coverUrl.value = null;
    console.error('[lyrics] 加载失败', e);
  }
}

/* ---- 定时器：每 200ms 对齐一次歌词位置（比音频帧率低，省 CPU） ---- */
let timer: ReturnType<typeof setInterval> | null = null;
function startTicker() {
  stopTicker();
  timer = setInterval(() => {
    scrollToActive();
  }, 200);
}
function stopTicker() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* ---- 播放控制：只发指令给主窗口，这里不持有 <audio> ----
   两个窗口各放一个 audio 会双声道重音，而且两边进度会漂。 */
const canPlay = computed(() => !!player.value.trackId && player.value.ready && player.value.durationMs > 0);

function togglePlay() {
  if (!canPlay.value) return;
  void api.player.command({ type: 'toggle' });
}
function rewind() {
  if (!player.value.trackId) return;
  void api.player.command({ type: 'rewind' });
}
function seek(ms: number) {
  if (!canPlay.value) return;
  void api.player.command({ type: 'seek', ms });
}

/**
 * 音量：主窗口的音频元素是唯一发声源，所以这里不能改自己的 <audio>。
 * 写成 localStorage 不行 —— 那是主窗口启动时读的，得让它自己存。
 *
 * 改完之后主窗口会把新值随 `player:state` 推回来。拖动的这几百毫秒里
 * 还有可能在途的旧值（rAF 循环每 70ms 推一次），照单全收会让滑块来回跳一格，
 * 所以本地刚动过的这段时间内忽略回显。
 */
let gainEchoUntil = 0;
function setGain(pct: number) {
  const v = Math.max(0, Math.min(100, Math.round(pct))) / 100;
  gainPct.value = Math.round(v * 100);
  gainEchoUntil = Date.now() + 500;
  void api.player.setGain?.(v);
}

/* ---- 歌词就地编辑：双击时间戳 / 歌词文字 ---- */
type EditKind = 'ms' | 'text';
const editing = ref<{ idx: number; kind: EditKind; draft: string } | null>(null);
const editInput = ref<HTMLInputElement | null>(null);
/**
 * v-for 里的字符串 ref（`ref="editInput"`）拿到的**是数组**，`?.focus()` 只挡 null
 * 不挡「没有这个方法」—— 于是双击进编辑态后光标根本没进输入框，
 * 用户以为点坏了；连带「正在输入」的上报也永远不成立（哪来的焦点）。
 * 函数 ref 才能拿到真正渲染出来的那一个。
 */
function setEditInput(el: any) {
  if (el) editInput.value = el as HTMLInputElement;
}
const saveHint = ref<string | null>(null);
let hintTimer: ReturnType<typeof setTimeout> | null = null;

function flash(msg: string) {
  saveHint.value = msg;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    saveHint.value = null;
    hintTimer = null;
  }, 2600);
}

function startEdit(idx: number, kind: EditKind) {
  const line = lyrics.value[idx];
  if (!line) return;
  if (lyricFormat.value === 'elrc' || lyricFormat.value === 'srt' || !lyricEditable.value) {
    flash(lyricFormat.value === 'elrc' || lyricFormat.value === 'srt' ? t('lyrics.readonlyTimed') : t('lyrics.readonly'));
    return;
  }
  editing.value = { idx, kind, draft: kind === 'ms' ? formatLrcStamp(line.ms) : line.text };
  // 等 input 真的渲染出来再聚焦（nextTick 是 Vue 的 DOM 更新完成信号）
  void nextTick(() => {
    editInput.value?.focus();
    editInput.value?.select?.();
  });
}
function cancelEdit() {
  editing.value = null;
}

async function commitEdit() {
  const e = editing.value;
  if (!e || !player.value.trackId) {
    editing.value = null;
    return;
  }
  editing.value = null;
  const draft = e.draft.trim();

  const patch: any = { index: e.idx };
  if (e.kind === 'ms') {
    const ms = parseLrcStamp(draft);
    if (ms === null) {
      flash(t('lyrics.badStamp'));
      return;
    }
    patch.ms = ms;
  } else {
    if (!draft) return; // 空歌词没有意义
    patch.text = draft;
  }

  try {
    const res = await api.lyrics.saveLine(player.value.trackId, { ...patch, recId: player.value.recId });
    if (res?.code === 'readonly') {
      flash(t('lyrics.readonly'));
      return;
    }
    if (res?.code) return;
    lyrics.value = res.lines ?? [];
    lyricMeta.value = res.meta ?? null;
    scrollToIdx = -1;
    flash(t('lyrics.saved'));
  } catch (e) {
    console.error('[lyrics] 保存失败', e);
  }
}

/* ---- 歌词文件操作 ---- */
async function pickLyrics() {
  if (!player.value.trackId) return;
  const doc = await api.lyrics.pick(player.value.trackId);
  if (doc) await loadForTrack(player.value.trackId, player.value.recId);
}
async function clearLyrics() {
  if (!player.value.trackId) return;
  if (lyricHow.value === 'version' && player.value.recId) {
    await api.lyrics.clearVersion(player.value.trackId, player.value.recId);
  } else {
    await api.lyrics.clear(player.value.trackId);
  }
  await loadForTrack(player.value.trackId, player.value.recId);
}
async function toggleInstrumental() {
  if (!player.value.trackId) return;
  const on = !instrumental.value;
  const doc = await api.lyrics.setInstrumental(player.value.trackId, on);
  if (doc) {
    lyrics.value = doc.lines ?? [];
    lyricHow.value = doc.instrumental ? 'instrumental' : doc.how;
    instrumental.value = !!doc.instrumental;
  }
}

/* ---- 翻译操作 ---- */
async function pickTranslation() {
  if (!player.value.trackId) return;
  const ok = await api.lyrics.pickTranslation(player.value.trackId);
  if (ok) {
    const trans = await api.lyrics.translation(player.value.trackId);
    translation.value = trans?.lines ?? [];
    translationFile.value = trans?.file ?? null;
    showTranslation.value = translation.value.length > 0;
  }
}
async function clearTranslation() {
  if (!player.value.trackId) return;
  await api.lyrics.clearTranslation(player.value.trackId);
  translation.value = [];
  translationFile.value = null;
  showTranslation.value = false;
}

/* ---- 菜单（⋯ 按钮 / 右键空白处） ---- */
const showMenu = ref(false);
const menuPos = ref({ x: 0, y: 0 });

function openMenu(x: number, y: number) {
  menuPos.value = { x, y };
  showMenu.value = true;
}
function closeMenu() {
  showMenu.value = false;
  editing.value = null;
}

/**
 * 右键空白处 → 视图菜单。
 * 点在歌词行 / 按钮 / 封面上不弹 —— 那些地方有各自的上下文
 * （歌词行双击是编辑，右键就该让位给文本菜单）。
 */
function onBlankContext(ev: MouseEvent) {
  const hit = (ev.target as HTMLElement).closest(
    'button, a, input, .l-line, .l-art, .lp-progress, .lp-menu, .l-text, .l-ts'
  );
  if (hit) return;
  ev.preventDefault();
  openMenu(ev.clientX, ev.clientY);
}

/* ---- 置于顶层 ---- */
const alwaysOnTop = ref(true);
async function toggleAlwaysOnTop() {
  try {
    alwaysOnTop.value = await api.win.lyricsAlwaysOnTop();
  } catch (e) {
    console.error('[lyrics] 切换置顶失败', e);
  }
}

/* ---- 订阅主窗口广播 ---- */
let unsubState: (() => void) | null = null;
let unsubTheme: (() => void) | null = null;

onMounted(() => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  unsubTheme = api.app.onTheme((v: string) => applyTheme(v));

  unsubState = api.player.onState((st: any) => {
    player.value = { ...st };
    // 音量只有主窗口那边能真的生效，值跟着状态回来（本地刚拖过的 500ms 内不听回显）
    if (typeof st?.gain === 'number' && Date.now() > gainEchoUntil) {
      gainPct.value = Math.round(st.gain * 100);
    }
    const key = `${st.trackId || ''}|${st.recId || ''}`;
    if (st.trackId && key !== loadedKey) void loadForTrack(st.trackId, st.recId ?? null);
    if (!st.trackId) loadedKey = '';
  });

  /**
   * 主动拉一次当前状态 + 主题。
   * 主窗口只在「播放中」每 70ms 广播，暂停时可能一条都不发 ——
   * 只靠订阅的话，窗口开在暂停状态下会永远停在「未在播放」，封面也不加载。
   */
  void Promise.all([
    api.player.state().catch(() => null),
    api.app.theme().catch(() => null),
    api.win.getLyricsAlwaysOnTop().catch(() => true),
  ]).then(([st, th, aot]) => {
    if (th) applyTheme(th);
    if (typeof aot === 'boolean') alwaysOnTop.value = aot;
    if (st) {
      player.value = { ...st };
      if (typeof st.gain === 'number') gainPct.value = Math.round(st.gain * 100);
      if (st.trackId) void loadForTrack(st.trackId, st.recId ?? null);
    }
  });

  startTicker();
});

onBeforeUnmount(() => {
  unsubState?.();
  unsubTheme?.();
  stopTicker();
  if (hintTimer) clearTimeout(hintTimer);
});

watch(showTimestamps, (v) => localStorage.setItem('ma-lyrics-ts', v ? '1' : '0'));
watch(showCover, (v) => localStorage.setItem('ma-lyrics-cover', v ? '1' : '0'));
watch(showTranslation, (v) => localStorage.setItem('ma-lyrics-trans', v ? '1' : '0'));

/* ---- 格式化 ---- */
function fmt(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function progressPct(): number {
  const d = player.value.durationMs;
  if (!d) return 0;
  return Math.min(100, Math.max(0, (player.value.currentMs / d) * 100));
}

function onProgressClick(ev: MouseEvent) {
  if (!canPlay.value) return;
  const bar = ev.currentTarget as HTMLElement;
  const rect = bar.getBoundingClientRect();
  if (rect.width <= 0) return;
  const pct = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  seek(Math.round(pct * player.value.durationMs));
}

const hasLyrics = computed(() => lyrics.value.length > 0);
const idle = computed(() => !player.value.trackId);
/** 有封面链接、但图没加载出来（协议失败 / 文件被挪走）→ 退回占位而不是留白 */
const showArt = computed(() => showCover.value && !!coverUrl.value && !coverBroken.value);
const hasTranslation = computed(() => translation.value.length > 0);

/** 制作信息：键名走词典翻译；词典里没有的原样显示 */
const creditRows = computed(() => {
  const d = detail.value;
  if (!d) return [] as { k: string; v: string }[];
  const rows: { k: string; v: string }[] = [];
  const push = (k: string, v: any) => {
    if (v === null || v === undefined || String(v).trim() === '') return;
    const key = `credit.${k}`;
    const label = t(key);
    rows.push({ k: label === key ? k : label, v: String(v) });
  };
  push('composer', d.composer);
  push('conductor', d.credits?.conductor);
  push('soloist', d.credits?.soloist);
  push('orchestra', d.credits?.orchestra);
  push('performer', d.performer);
  push('arranger', d.credits?.arranger);
  push('label', d.credits?.label);
  push('catalogue', d.credits?.catalogue);
  if (d.album) rows.push({ k: t('lyrics.album'), v: String(d.album) });
  for (const [k, v] of Object.entries(d.credits ?? {})) {
    if (['conductor', 'soloist', 'orchestra', 'arranger', 'label', 'catalogue'].includes(k)) continue;
    push(k, v);
  }
  return rows;
});
</script>

<template>
  <div class="lp-shell" @contextmenu="onBlankContext">
    <!-- 顶栏：跟着主题走；图标抄主界面标题行。
         系统的最小化/最大化/关闭 叠在这一条的右端（主进程 titleBarOverlay），
         所以这里不再画自己的 ✕ —— 两个叉叠在一起谁也点不准。 -->
    <header class="lp-header">
      <div class="lp-head-l">
        <svg class="mark" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" />
          <path d="M8 1.8v2.2M8 12v2.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        </svg>
        <span class="lp-title">{{ player.title ?? t('win.lyricsTitle') }}</span>
      </div>
    </header>

    <div class="lp-body" :class="{ 'no-cover': !showCover }">
      <!-- 左侧：封面 / 纯音乐信息 -->
      <aside v-if="showCover" class="lp-cover">
        <template v-if="idle">
          <div class="lp-idle">
            <p class="lp-idle-title">{{ t('lyrics.idleTitle') }}</p>
            <p class="faint tiny">{{ t('lyrics.idleHint') }}</p>
          </div>
        </template>
        <template v-else-if="showArt">
          <img class="lp-art" :src="coverUrl!" alt="" @error="coverBroken = true" />
        </template>
        <template v-else-if="instrumental">
          <div class="lp-inst">
            <div class="lp-inst-icon">♪</div>
            <p>{{ t('lyrics.instrumental') }}</p>
          </div>
        </template>
        <template v-else>
          <div class="lp-noart">♪</div>
        </template>

        <!-- 制作信息：纯音乐或没有歌词时才占这块地方 -->
        <div v-if="detail && (instrumental || !hasLyrics) && creditRows.length" class="lp-credits">
          <h4>{{ t('lyrics.credits') }}</h4>
          <p v-for="(r, i) in creditRows" :key="i">
            <span class="lp-credit-k">{{ r.k }}</span><span class="lp-credit-v">{{ r.v }}</span>
          </p>
        </div>
      </aside>

      <!-- 右侧：歌词区域 -->
      <main class="lp-lyrics">
        <div class="lp-toolbar">
          <button
            class="chip"
            :class="{ on: showTimestamps }"
            :aria-pressed="showTimestamps"
            :title="t('lyrics.timestamps')"
            @click="showTimestamps = !showTimestamps"
          >
            {{ t('lyrics.timestamps') }}
          </button>
          <button
            v-if="hasTranslation"
            class="chip"
            :class="{ on: showTranslation }"
            :aria-pressed="showTranslation"
            :title="t('lyrics.transShow')"
            @click="showTranslation = !showTranslation"
          >
            {{ t('lyrics.trans') }}
          </button>
          <button
            class="chip"
            :class="{ on: showCover }"
            :aria-pressed="showCover"
            :title="t('lyrics.showCover')"
            @click="showCover = !showCover"
          >
            {{ t('lyrics.showCover') }}
          </button>
          <span class="grow" />
          <span v-if="saveHint" class="lp-hint">{{ saveHint }}</span>
          <span v-else-if="lyricHow === 'auto'" class="tiny faint">{{ t('lyrics.autoMatched') }}</span>
          <span v-else-if="lyricHow === 'manual'" class="tiny faint">{{ t('lyrics.manual') }}</span>
          <span v-else-if="lyricHow === 'version'" class="tiny faint">{{ t('lyrics.sourceVersion') }}</span>
          <span v-else-if="lyricHow === 'instrumental'" class="tiny faint">{{ t('lyrics.instrumental') }}</span>
        </div>

        <template v-if="idle">
          <div class="lp-idle-center">
            <p>{{ t('lyrics.idleTitle') }}</p>
            <p class="faint tiny">{{ t('lyrics.idleHint') }}</p>
          </div>
        </template>
        <template v-else-if="instrumental">
          <div class="lp-inst-center">
            <p class="lp-pure-note">{{ t('lyrics.pureMusicNote') }}</p>
            <p class="faint tiny">{{ t('lyrics.instrumentalHint') }}</p>
          </div>
        </template>
        <template v-else-if="!hasLyrics">
          <div class="lp-no-lyrics">
            <p>{{ t('lyrics.noLyrics') }}</p>
            <p class="faint tiny">{{ t('lyrics.noLyricsHint') }}</p>
            <div class="lp-actions">
              <button class="chip" @click="pickLyrics">{{ t('lyrics.pick') }}</button>
              <button class="chip" @click="toggleInstrumental">{{ t('lyrics.markInstrumental') }}</button>
            </div>
          </div>
        </template>
        <template v-else>
          <div ref="scrollContainer" class="lp-scroll">
            <div
              v-for="(line, i) in lyrics"
              :key="i"
              class="l-line"
              :class="{ on: i === activeIdx }"
              :data-idx="i"
            >
              <!-- 时间戳：LRC 原本的写法 [00:14.671]，双击可改 -->
              <span
                v-if="showTimestamps"
                class="l-ts"
                :title="editTitle"
                @dblclick.stop="startEdit(i, 'ms')"
              >
                <input
                  v-if="editing?.idx === i && editing.kind === 'ms'"
                  :ref="setEditInput"
                  v-model="editing.draft"
                  class="l-edit mono"
                  :title="t('lyrics.timeHint')"
                  @click.stop
                  @keydown.enter.prevent="commitEdit"
                  @keydown.esc.prevent="cancelEdit"
                  @blur="commitEdit"
                />
                <template v-else>{{ formatLrcStamp(line.ms) }}</template>
              </span>
              <!-- 歌词正文：双击可改 -->
              <span class="l-text" :title="editTitle" @dblclick.stop="startEdit(i, 'text')">
                <input
                  v-if="editing?.idx === i && editing.kind === 'text'"
                  :ref="setEditInput"
                  v-model="editing.draft"
                  class="l-edit"
                  @click.stop
                  @keydown.enter.prevent="commitEdit"
                  @keydown.esc.prevent="cancelEdit"
                  @blur="commitEdit"
                />
                <template v-else>{{ line.text }}</template>
                <em v-if="translationOf(i, line.ms)" class="l-tr">{{ translationOf(i, line.ms) }}</em>
              </span>
            </div>
          </div>
          <p class="lp-edit-hint faint tiny">{{ t('lyrics.editHint') }}</p>
        </template>
      </main>
    </div>

    <!-- 底部播放控件：按钮与主界面 TransportBar 逐字一致，顺序也一样
         （播放在前、回到开头在后）。
         ⏸ / ⏮ 这类字符在 Windows 上会被 Segoe UI Emoji 接走，画成蓝色的系统表情方块，
         和主窗口的 ❚❚ / |◀ 完全是两套东西 —— 所以这里只用纯几何字符。 -->
    <footer class="lp-transport">
      <button
        class="tp play"
        :class="{ on: player.playing }"
        :disabled="!canPlay"
        :title="t('lyrics.playPause')"
        @click="togglePlay"
      >
        {{ player.playing ? '❚❚' : '▶' }}
      </button>
      <button class="tp" :disabled="!player.trackId" :title="t('lyrics.rewind')" @click="rewind">|◀</button>

      <span class="tc">{{ fmt(player.currentMs) }}</span>
      <div class="bar" :class="{ disabled: !canPlay }" @click="onProgressClick">
        <div class="bar-fill" :style="{ width: progressPct() + '%' }" />
        <div class="bar-knob" :style="{ left: progressPct() + '%' }" />
      </div>
      <span class="bb">{{ fmt(player.durationMs) }}</span>

      <!-- 音量：推子语义，位置就是线性幅度，显示换算成百分比 -->
      <span class="lp-vol" :title="t('lyrics.volume')">
        <svg class="lp-vol-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 6.5h2.2L8 4v8L5.2 9.5H3z" fill="currentColor" />
          <path
            v-if="gainPct > 0"
            d="M10 5.6a3.4 3.4 0 010 4.8M11.9 3.7a6.2 6.2 0 010 8.6"
            fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"
          />
        </svg>
        <input
          class="lp-vol-range"
          type="range"
          min="0"
          max="100"
          :value="gainPct"
          :aria-label="t('lyrics.volume')"
          @input="setGain(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="lp-vol-num num">{{ gainPct }}%</span>
      </span>

      <!-- 置顶：图钉。放在控件栏而不是顶栏，顶栏只留关闭 -->
      <button
        class="tp"
        :class="{ on: alwaysOnTop }"
        :title="alwaysOnTop ? t('lyrics.pinOn') : t('lyrics.pinOff')"
        :aria-pressed="alwaysOnTop"
        @click="toggleAlwaysOnTop"
      >
        <svg class="lp-pin" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M9.6 1.4 14.6 6.4l-1.5 1.5-1.2-.4-2.4 2.4.3 2.2-1.1 1.1-2.6-2.6-3.4 3.4-.7-.7 3.4-3.4-2.6-2.6 1.1-1.1 2.2.3 2.4-2.4-.4-1.2z"
            fill="currentColor"
          />
        </svg>
      </button>
      <button class="tp" :title="t('lyrics.menu')" @click="openMenu(0, 0)">⋯</button>
    </footer>

    <!-- 菜单：⋯ 按钮与右键空白处共用 -->
    <div v-if="showMenu" class="lp-menu-mask" @click.self="closeMenu" @contextmenu.prevent="closeMenu">
      <div class="lp-menu" :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }">
        <button class="lp-menu-item" @click="toggleAlwaysOnTop(); closeMenu()">
          <span class="tick">{{ alwaysOnTop ? '✓' : '' }}</span>{{ t('lyrics.alwaysOnTop') }}
        </button>
        <div class="lp-menu-sep" />
        <button class="lp-menu-item" @click="pickLyrics(); closeMenu()">
          <span class="tick" />{{ t('lyrics.pick') }}
        </button>
        <button
          v-if="hasLyrics || lyricHow === 'manual' || lyricHow === 'version'"
          class="lp-menu-item"
          @click="clearLyrics(); closeMenu()"
        >
          <span class="tick" />{{ t('lyrics.clear') }}
        </button>
        <button class="lp-menu-item" @click="toggleInstrumental(); closeMenu()">
          <span class="tick" />{{ instrumental ? t('lyrics.unmarkInstrumental') : t('lyrics.markInstrumental') }}
        </button>
        <div class="lp-menu-sep" />
        <button class="lp-menu-item" @click="pickTranslation(); closeMenu()">
          <span class="tick" />{{ t('lyrics.transPick') }}
        </button>
        <button v-if="hasTranslation" class="lp-menu-item" @click="clearTranslation(); closeMenu()">
          <span class="tick" />{{ t('lyrics.transClear') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/**
 * 配色全部走 tokens.css 的变量（--surface / --text / --line / --accent…），
 * 深浅两套由 :root[data-theme] 提供，本组件不写死任何颜色。
 */
.lp-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

.lp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  /* 右端 138px 留给系统的三个窗口按钮（46px × 3），标题再长也不会钻到按钮底下。
     高度必须等于主进程 titleBarOverlay.height —— 系统按钮是按这个高度居中画的，
     差一像素按钮就比顶栏高出一截。 */
  padding: 0 138px 0 9px;
  /* 与主窗口标题行同高（26px）：两个窗口顶边并排时是一条线 */
  height: 26px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  -webkit-app-region: drag;
  user-select: none;
  flex: none;
}
.lp-head-l { display: flex; align-items: center; gap: 7px; min-width: 0; }
/* 项目标记：与主界面标题行 MenuBar.vue 里那个 SVG 完全一致 */
.mark { width: 12px; height: 12px; color: var(--accent); flex: none; }
.lp-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lp-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 关掉封面后歌词区铺满，不留一条 240px 的空栏 */
.lp-body.no-cover .lp-lyrics { width: 100%; }

.lp-cover {
  width: 240px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 18px 14px;
  gap: 14px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  overflow-y: auto;
}
.lp-art {
  width: 200px;
  height: 200px;
  object-fit: cover;
  border-radius: 4px;
  /* 浅色下投影要淡，不然像贴了张黑纸 */
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
}
.lp-noart {
  width: 160px;
  height: 160px;
  border-radius: 4px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 40px;
  color: var(--text-faint);
}
.lp-idle, .lp-inst {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 180px;
  color: var(--text-faint);
  text-align: center;
}
.lp-inst-icon { font-size: 32px; color: var(--accent); }
.lp-idle-title { font-size: 13px; font-weight: 600; }

.lp-credits {
  width: 100%;
  text-align: left;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.lp-credits h4 { margin: 0 0 6px; font-size: 11px; color: var(--text-dim); }
.lp-credits p {
  margin: 0 0 3px;
  font-size: 11px;
  line-height: 1.6;
  display: flex;
  gap: 6px;
}
.lp-credit-k { color: var(--text-faint); flex: none; }
.lp-credit-v { color: var(--text-dim); word-break: break-word; }

.lp-lyrics {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.lp-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.lp-hint { color: var(--accent); font-size: 10.5px; }
.lp-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 20px 18px 8px;
}

.l-line {
  display: flex;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 3px;
  transition: color .18s, background .18s;
  line-height: 1.7;
  font-size: 14.5px;
  cursor: default;
}
.l-line:not(.on) { color: var(--text-faint); }
.l-line.on { color: var(--accent); font-weight: 600; background: var(--sel-bg); }
/* 时间戳用 LRC 原本的写法，可双击改 */
.l-ts {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  min-width: 78px;
  text-align: left;
  cursor: text;
  border-radius: 2px;
}
.l-ts:hover { color: var(--accent); text-decoration: underline dotted currentColor; }
.l-text { word-break: break-word; cursor: text; border-radius: 2px; }
.l-text:hover { text-decoration: underline dotted var(--line-strong); }
/* 翻译挂在原句下面，比原句小一号、颜色更淡 */
.l-tr {
  display: block;
  font-size: 12.5px;
  font-style: normal;
  font-weight: 400;
  color: var(--text-dim);
  opacity: .8;
  margin-top: 1px;
}
.l-edit {
  font: inherit;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--accent);
  border-radius: 2px;
  padding: 0 4px;
  width: 100%;
  min-width: 120px;
}
.l-edit.mono { font-family: var(--font-mono); font-size: 10.5px; }
.lp-edit-hint { padding: 4px 18px 8px; flex: none; }

.lp-idle-center, .lp-no-lyrics, .lp-inst-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-faint);
  text-align: center;
  padding: 0 24px;
}
.lp-pure-note { font-size: 15px; font-weight: 500; color: var(--text-dim); }
.lp-actions { display: flex; gap: 8px; margin-top: 10px; }

/* ---- 底部播放控件：与主窗口 TransportBar 同一套视觉语言与顺序 ----
   .tp / .bar / .bar-fill / .bar-knob / .tc / .bb 的尺寸、配色、hover 全部对齐，
   两个窗口并排放时不该看起来像两个软件。 */
.lp-transport {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 34px;
  border-top: 1px solid var(--line);
  background: var(--surface);
  font-size: 11px;
  flex: none;
}

/* TransportBar 的样式是 scoped 的，不会穿透到本组件，
   所以这里按同一套尺寸复刻一遍（26×22 的 tp、4px 的 bar、7px 的 knob、
   --line 描边 / --text-dim 字色 / hover 转 --text）。 */
.tp {
  width: 26px;
  height: 22px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.tp:hover:not(:disabled) { color: var(--text); border-color: var(--line-strong); }
.tp:disabled { opacity: 0.4; cursor: default; }
.tp.play.on { color: var(--accent); border-color: var(--accent); }
.tp .lp-pin { width: 12px; height: 12px; }
.tp.on { color: var(--accent); border-color: var(--accent); background: var(--sel-bg); }

.bar {
  position: relative;
  flex: 1 1 120px;
  min-width: 60px;
  height: 4px;
  background: var(--surface-2);
  border-radius: 2px;
  cursor: pointer;
}
.bar.disabled { opacity: 0.4; cursor: default; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 2px; }
.bar-knob {
  position: absolute;
  top: 50%;
  width: 7px;
  height: 7px;
  margin: -3.5px 0 0 -3.5px;
  border-radius: 50%;
  background: var(--accent);
}
.tc { color: var(--text); min-width: 46px; font-variant-numeric: tabular-nums; }
.bb { color: var(--text-dim); min-width: 46px; font-variant-numeric: tabular-nums; }

/* ---- 音量：推子语义，位置就是线性幅度 ---- */
.lp-vol { display: inline-flex; align-items: center; gap: 5px; flex: none; }
.lp-vol-icon { width: 13px; height: 13px; color: var(--text-dim); flex: none; }
.lp-vol-range { width: 78px; accent-color: var(--accent); cursor: pointer; }
.lp-vol-num {
  color: var(--text-dim);
  font-size: 10.5px;
  width: 34px;
  text-align: right;
  flex: none;
}

.lp-menu-mask { position: fixed; inset: 0; z-index: 100; }
.lp-menu {
  position: fixed;
  /* ⋯ 按钮传的是 (0,0)：贴在它自己右下角 */
  margin: 26px 8px 0 0;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: var(--shadow);
  padding: 3px;
  min-width: 168px;
  max-height: 80vh;
  overflow-y: auto;
}
.lp-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  border-radius: 3px;
  cursor: pointer;
}
.lp-menu-item:hover { background: var(--sel-bg); }
/* 勾选列固定宽度：有无勾选时后面的文字要对齐 */
.tick { flex: none; width: 10px; color: var(--accent); }
.lp-menu-sep { height: 1px; background: var(--line); margin: 3px 6px; }

.grow { flex: 1; }
.tiny { font-size: 10.5px; }
.faint { opacity: .55; }
.chip {
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 10.5px;
  cursor: pointer;
  white-space: nowrap;
}
.chip:hover { border-color: var(--line-strong); color: var(--text); }
.chip.on { border-color: var(--accent); color: var(--accent); background: var(--sel-bg); }
</style>