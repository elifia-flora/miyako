<script setup lang="ts">
/**
 * TransportBar — 播放条（Cubase 式分段读数）
 *
 * 从左到右：播放/暂停 · 回到开头 · 当前音频时间(ms) · 进度 · 总时长 ·
 * 主/次时间显示（小节.拍 / 时间码，可点图标换格式，Alt+点击互换）· 帧速率 ·
 * 当前速度 · 拍号 · Tap · 节拍器及设置 · 原点/播放头设置 · 跟随 · 主输出。
 *
 * 音频文件名和「选择音频」已经从这条上拿掉：播放条只负责播放与时间，
 * 换音频走录音版本管理。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  barBeatToTick,
  computeStartBars,
  formatBarBeatSub,
  formatMs,
  formatTimecode,
  parseMsText,
  parseTimecode,
  tickToBarBeatSub,
} from '@shared/barbeat.js';
import { bpmFromTapTimes, TEMPO_MAX, TEMPO_MIN } from '@shared/tempo.js';
import { audioMsOfTick, temposOf, tickOfAudioMs } from '../audio/time.js';
import {
  audioHost,
  gainToDb,
  onFrame,
  pause,
  seek,
  setGain,
  setTimelineDuration,
  state,
  stop,
  toggle,
} from '../audio/store.js';
import {
  metroState,
  metronomeTick,
  setMetronomeAccent,
  setMetronomeOn,
  setMetronomeVolume,
} from '../audio/metronome.js';
import { t } from '../i18n';
import ConfirmDialog from './ConfirmDialog.vue';
import BarBeatText from './BarBeatText.vue';
import TimeFormatIcon from './TimeFormatIcon.vue';

/**
 * `analysis` 收的是「已经按当前版本替换过偏移」的那份（App 里的 viewAnalysis），
 * 显示读它；写库要落到具体版本上，所以另外要 trackId / recId 两个身份。
 * recId 为空 = 写主录音（顺序里的第一首），和「点作品播放播哪一版」同一个口径。
 */
const props = defineProps<{ analysis: any | null; trackId?: string | null; recId?: string | null }>();
const emit = defineEmits<{ changed: [] }>();

const api = (window as any).api;
const offsetInput = ref(0);
const saving = ref(false);

const ppq = computed(() => props.analysis?.ppq ?? 480);
const tempos = computed(() => temposOf(props.analysis));
const meters = computed(() => {
  const raw = (props.analysis?.markers ?? []).filter((m: any) => m.kind === 'meter');
  return computeStartBars((raw.length ? raw : [{ tick: 0, num: 4, den: 4 }]) as any, ppq.value);
});

const durationMs = computed(() => state.durationMs || state.info?.durationMs || 0);
const timeText = computed(() => formatMs(state.currentMs || 0));
const durText = computed(() => (durationMs.value ? formatMs(durationMs.value) : '—:—'));

/** 仅时间线的总长可以改：外部播放 / 录屏的时长和档案推算值对不上时，靠它把进度条拉成真实长度 */
const durEdit = ref<string | null>(null);
const durInputEl = ref<HTMLInputElement | null>(null);
function startDurEdit() {
  if (state.sourceMode !== 'timeline') return;
  durEdit.value = formatMs(state.durationMs || 0);
  nextTick(() => durInputEl.value?.focus());
}
function commitDurEdit() {
  if (durEdit.value === null) return;
  const ms = parseMsText(durEdit.value);
  durEdit.value = null;
  if (ms != null && state.sourceMode === 'timeline') setTimelineDuration(ms);
}

/** 播放头所在的 tick（可能是负数：音频早于第 1 小节时） */
const currentTick = computed(() =>
  props.analysis ? tickOfAudioMs(props.analysis, tempos.value, state.currentMs || 0) : 0
);

/* ---------------- 主 / 次时间显示 ---------------- */

type TimeFormat = 'bars' | 'timecode' | 'ms';
const TIME_FORMATS: TimeFormat[] = ['bars', 'timecode', 'ms'];
const FRAME_RATES = [24, 25, 30, 50, 60];

function storedFormat(key: string, fallback: TimeFormat): TimeFormat {
  try {
    const v = localStorage.getItem(key);
    if (v === 'bars' || v === 'timecode' || v === 'ms') return v;
  } catch {
    /* 隐私模式读不了 */
  }
  return fallback;
}

const primaryFormat = ref<TimeFormat>(storedFormat('ma-time-primary', 'bars'));
const secondaryFormat = ref<TimeFormat>(storedFormat('ma-time-secondary', 'timecode'));
/** 帧速率默认 30fps；设置里可选 24 / 25 / 30 / 50 / 60 */
const fps = ref<number>(30);
try {
  const storedFps = Number(localStorage.getItem('ma-fps'));
  if (FRAME_RATES.includes(storedFps)) fps.value = storedFps;
} catch {
  /* ignore */
}

function saveTimePrefs() {
  try {
    localStorage.setItem('ma-time-primary', primaryFormat.value);
    localStorage.setItem('ma-time-secondary', secondaryFormat.value);
    localStorage.setItem('ma-fps', String(fps.value));
  } catch {
    /* 隐私模式写不了就算了 */
  }
}

const barText = computed(() => {
  if (!props.analysis) return '—';
  const tick = currentTick.value;
  if (tick < 0) return t('transport.beforeBar1');
  return formatBarBeatSub(meters.value, tick, ppq.value);
});
const barPos = computed(() => {
  if (!props.analysis || currentTick.value < 0) return null;
  return tickToBarBeatSub(meters.value, currentTick.value, ppq.value);
});
const timecodeText = computed(() => formatTimecode(state.currentMs || 0, fps.value));

function textFor(format: TimeFormat): string {
  if (format === 'bars') return barText.value;
  if (format === 'timecode') return timecodeText.value;
  return timeText.value;
}

const primaryText = computed(() => textFor(primaryFormat.value));
const secondaryText = computed(() => textFor(secondaryFormat.value));

const timeMenu = ref<null | 'primary' | 'secondary' | 'fps'>(null);

function formatLabel(format: TimeFormat): string {
  return t(`transport.format.${format}`);
}
function timeTitle(which: 'primary' | 'secondary'): string {
  const name = which === 'primary' ? primaryFormat.value : secondaryFormat.value;
  return t('transport.timeTitle', { name: formatLabel(name) });
}
/* ---- 读数可直接编辑：点数字 = 改位置；点前面那个格式图标 = 换显示格式 ---- */

/**
 * 正在编辑的读数。
 *
 * 为什么要分开两块：同一个按钮既负责「换格式」又负责「改位置」，
 * 用户永远不知道点下去会发生哪件。现在**图标只管格式、数字只管位置**。
 * 输入框里接受当前格式的写法（`11.2.3.45` / `00:01:23:15` / `1:23.456`），
 * 写坏了就什么都不做（保持原位，不弹错 —— 播放条上没有地方放错误提示）。
 */
const timeEdit = ref<null | { which: 'primary' | 'secondary'; text: string }>(null);
const timeInputEl = ref<HTMLInputElement | null>(null);

/**
 * 点中的是第几个字符。
 *
 * 读数里的字段（小节 / 拍 / 十六分 / tick）在 DOM 里是**多个元素**，
 * 所以不能直接用 `range.startOffset`（那是节点内偏移）—— 要把前面所有文本的长度加回来。
 */
function caretTextOffset(container: HTMLElement, x: number, y: number): number | null {
  const doc: any = document as any;
  let range: Range | null = null;
  if (typeof doc.caretRangeFromPoint === 'function') {
    range = doc.caretRangeFromPoint(x, y) as Range | null;
  } else if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range || !container.contains(range.startContainer)) return null;
  const target = range.startContainer;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  let node: Node | null = walker.nextNode();
  while (node) {
    if (node === target) return total + range.startOffset;
    total += (node.textContent ?? '').length;
    node = walker.nextNode();
  }
  return null;
}

/** 冒号 / 点 / 空格分隔出来的一小段（用户在改哪一段就选哪一段） */
function segmentRange(text: string, offset: number | null): [number, number] | null {
  if (!text || offset == null || offset < 0 || offset > text.length) return null;
  const isSep = (c: string) => c === '.' || c === ':' || c === ' ';
  let at = offset;
  // 正好点在分隔符上：优先选后面那一段
  if (isSep(text[at] ?? '') && at < text.length) at += 1;
  let a = at;
  while (a > 0 && !isSep(text[a - 1])) a--;
  let b = at;
  while (b < text.length && !isSep(text[b])) b++;
  return b > a ? [a, b] : null;
}

function startTimeEdit(which: 'primary' | 'secondary', ev?: MouseEvent) {
  const fmt = which === 'primary' ? primaryFormat.value : secondaryFormat.value;
  timeMenu.value = null;
  const text = textFor(fmt);
  // 先量：下一帧这个按钮就被输入框顶掉了
  const caret =
    ev && ev.currentTarget
      ? caretTextOffset(ev.currentTarget as HTMLElement, ev.clientX, ev.clientY)
      : null;
  timeEdit.value = { which, text };
  void nextTick(() => {
    const el = timeInputEl.value;
    if (!el) return;
    el.focus({ preventScroll: true });
    const seg = segmentRange(text, caret);
    if (seg) el.setSelectionRange(seg[0], seg[1]);
    else el.select();
  });
}

function cancelTimeEdit() {
  timeEdit.value = null;
}

/** 回车 / 失焦都会走到这里；第一次已经把 timeEdit 清空，第二次自然什么都不做 */
function commitTimeEdit() {
  const ed = timeEdit.value;
  if (!ed) return;
  const fmt = ed.which === 'primary' ? primaryFormat.value : secondaryFormat.value;
  const raw = String(ed.text ?? '').trim();
  timeEdit.value = null;
  if (!raw) return;
  let ms: number | null = null;
  if (fmt === 'bars') {
    const tick = barBeatToTick(meters.value, raw, ppq.value);
    if (tick == null) return;
    if (!props.analysis) return;
    ms = audioMsOfTick(props.analysis, tempos.value, Math.max(0, tick));
  } else if (fmt === 'timecode') {
    ms = parseTimecode(raw, fps.value);
  } else {
    ms = parseMsText(raw);
  }
  if (ms == null || !Number.isFinite(ms)) return;
  seek(Math.max(0, ms));
}

function onTimeClick(which: 'primary' | 'secondary', ev: MouseEvent) {
  // Alt+点击 = 交换主/次格式（Cubase 的手感）
  if (ev.altKey) {
    swapFormats();
    return;
  }
  timeMenu.value = timeMenu.value === which ? null : which;
}
function swapFormats() {
  const a = primaryFormat.value;
  primaryFormat.value = secondaryFormat.value;
  secondaryFormat.value = a;
  timeMenu.value = null;
  saveTimePrefs();
}
function setFormat(which: 'primary' | 'secondary', format: TimeFormat) {
  if (which === 'primary') primaryFormat.value = format;
  else secondaryFormat.value = format;
  timeMenu.value = null;
  saveTimePrefs();
}
function setFps(rate: number) {
  fps.value = rate;
  timeMenu.value = null;
  saveTimePrefs();
}
function onFpsClick() {
  timeMenu.value = timeMenu.value === 'fps' ? null : 'fps';
}

/* ---------------- 当前速度 / 拍号 ---------------- */

const currentTempo = computed(() => {
  const list = tempos.value;
  let bpm = Number(list[0]?.bpm ?? props.analysis?.tempoValue ?? 120);
  const tick = Math.max(0, currentTick.value);
  for (const x of list) if (x.tick <= tick) bpm = Number(x.bpm);
  return Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
});
const tempoText = computed(() => (props.analysis ? currentTempo.value.toFixed(3) : '—'));
const meterText = computed(() => {
  const list = meters.value;
  let m: any = list[0] ?? { num: 4, den: 4 };
  const tick = Math.max(0, currentTick.value);
  for (const x of list) if (x.tick <= tick) m = x;
  return `${m.num ?? 4}/${m.den ?? 4}`;
});

/* ---------------- Tap 速度 ---------------- */

const tapLive = ref<number | null>(null);
const tapDlg = ref<null | { bpm: number }>(null);
const tapError = ref(false);
const tapTimes: number[] = [];
let tapTimer = 0;

function onTap() {
  if (!props.analysis) return;
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) tapTimes.length = 0;
  tapTimes.push(now);
  if (tapTimes.length > 8) tapTimes.shift();
  tapLive.value = bpmFromTapTimes(tapTimes)?.bpm ?? null;
  clearTimeout(tapTimer);
  tapTimer = window.setTimeout(() => {
    const bpm = tapLive.value;
    tapTimes.length = 0;
    tapLive.value = null;
    if (bpm != null) openTempoDialog(bpm);
  }, 900);
}

function openTempoDialog(bpm: number) {
  timeMenu.value = null;
  tapError.value = false;
  tapDlg.value = { bpm: Math.round(Math.max(1, Number(bpm) || 120) * 1000) / 1000 };
}

async function applyTapTempo() {
  const bpm = Number(tapDlg.value?.bpm);
  if (!(bpm >= TEMPO_MIN && bpm <= TEMPO_MAX)) {
    tapError.value = true;
    return;
  }
  tapDlg.value = null;
  await applyTempo(bpm);
}

/**
 * 把速度写到「播放头当前所处的 tempo 段」。
 * 没有 tempo marker（单速档案）时走 tracks.update 更新全局速度；
 * 有 marker 时改当前那条，并在 tick 0 时同步 analysis.tempo_value。
 */
async function applyTempo(bpm: number) {
  const a = props.analysis;
  if (!a?.id) return;
  const trackId = props.trackId ?? a.trackId ?? state.trackId;
  const list = (a.markers ?? [])
    .filter((m: any) => m.kind === 'tempo')
    .map((m: any) => ({ ...m, bpm: Number(m.bpm ?? a.tempoValue ?? 120) }))
    .sort((x: any, y: any) => x.tick - y.tick);

  if (!list.length) {
    if (trackId) await api.tracks.update(trackId, { bpm });
  } else {
    const tick = Math.max(0, Math.round(currentTick.value));
    let idx = 0;
    for (let i = 0; i < list.length; i++) if (list[i].tick <= tick) idx = i;
    const next = list.map((m: any, i: number) => (i === idx ? { ...m, bpm } : { ...m }));
    await api.analysis.setMarkers(a.id, 'tempo', next);
    if (trackId && Number(next[0]?.tick) === 0) {
      await api.tracks.update(trackId, { bpm: Number(next[0].bpm) });
    }
  }
  emit('changed');
}

/* ---------------- 节拍器 ---------------- */

const metroMenu = ref(false);
function toggleMetro() {
  if (!audioHost) return;
  setMetronomeOn(!metroState.on, { unlock: true });
}
function onMetroVolume(ev: Event) {
  setMetronomeVolume(Number((ev.target as HTMLInputElement).value) / 100);
}
function onMetroAccent(ev: Event) {
  setMetronomeAccent((ev.target as HTMLInputElement).checked);
}

/* ---------------- 原点偏移 / 主输出（原功能） ---------------- */

const originText = computed(() => {
  if (!props.analysis) return '—';
  return formatMs(audioMsOfTick(props.analysis, tempos.value, 0));
});

const progress = computed(() => {
  if (!durationMs.value) return 0;
  return Math.max(0, Math.min(1, (state.currentMs || 0) / durationMs.value));
});

const faderEl = ref<HTMLElement | null>(null);
let faderDrag = false;

/** 推子位置 0~100%：位置即线性幅度，满格 = 0 dB */
const gainPct = computed(() => Math.max(0, Math.min(1, state.gain)) * 100);
const dbText = computed(() => {
  const db = gainToDb(state.gain);
  if (!Number.isFinite(db)) return '-∞ dB';
  if (db > -0.05) return '0.0 dB';
  return `${db.toFixed(1)} dB`;
});
const errorText = computed(() => (state.error ? t(state.error.key, state.error.vars) : ''));

function gainFromX(clientX: number) {
  const el = faderEl.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  setGain((clientX - r.left) / Math.max(1, r.width));
}

function onFaderDown(ev: PointerEvent) {
  faderDrag = true;
  try {
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有指针可捕获 */
  }
  gainFromX(ev.clientX);
}
function onFaderMove(ev: PointerEvent) {
  if (!faderDrag) return;
  gainFromX(ev.clientX);
}
function onFaderUp(ev: PointerEvent) {
  faderDrag = false;
  try {
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
}

watch(
  () => props.analysis?.audioOffsetMs,
  (v) => (offsetInput.value = Number(v) || 0),
  { immediate: true }
);

let scrubbing = false;
function ratioToMs(clientX: number, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
  return ratio * durationMs.value;
}
function onBarDown(ev: PointerEvent) {
  if (!durationMs.value) return;
  scrubbing = true;
  const el = ev.currentTarget as HTMLElement;
  try {
    el.setPointerCapture(ev.pointerId);
  } catch {
    /* 合成事件没有指针可捕获 */
  }
  seek(ratioToMs(ev.clientX, el));
}
function onBarMove(ev: PointerEvent) {
  if (!scrubbing) return;
  seek(ratioToMs(ev.clientX, ev.currentTarget as HTMLElement));
}
function onBarUp(ev: PointerEvent) {
  scrubbing = false;
  try {
    (ev.currentTarget as HTMLElement).releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
}

async function saveOffset(ms: number) {
  const trackId = props.trackId ?? state.trackId;
  if (!trackId) return;
  saving.value = true;
  try {
    // 只改「当前在听的这一版」：换版本听，原点跟着那一版自己的走
    await api.recording.setOffset(trackId, props.recId ?? null, Math.round(ms));
    offsetInput.value = Math.round(ms);
    emit('changed');
  } finally {
    saving.value = false;
  }
}

/**
 * 「以播放头为原点」先问一句再动手。
 * 这个键紧挨着 ±10ms，点歪一下就会把整条已经对齐好的时间轴整体平移 ——
 * 而「对齐」往往是花了好几分钟一点点试出来的，没有撤销。所以先确认。
 */
const askOrigin = ref(false);
const playheadText = computed(() => formatMs(Math.round(state.currentMs || 0)));
function setOriginAtPlayhead() {
  if (!durationMs.value) return;
  askOrigin.value = true;
}
async function applyOriginAtPlayhead() {
  askOrigin.value = false;
  if (!durationMs.value) return;
  await saveOffset(state.currentMs || 0);
}

/* ---------------- 窗口级监听 / 节拍器 tick ---------------- */

let offFrame: (() => void) | null = null;

function onDocDown(ev: PointerEvent) {
  const el = ev.target as Element | null;
  if (el?.closest?.('.time-cell, .metro-wrap, .tp-pop')) return;
  timeMenu.value = null;
  metroMenu.value = false;
}

function onKey(ev: KeyboardEvent) {
  const tag = (ev.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    toggle();
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    stop();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDocDown, true);
  offFrame = onFrame((ms) => {
    metronomeTick(ms, props.analysis, tempos.value, meters.value, ppq.value, state.playing);
  });
  // 冒烟用：增益、时间格式、Tap、节拍器都能从 window 上直接验
  (window as any).__transport = {
    gain: () => state.gain,
    db: () => dbText.value,
    formats: () => ({ primary: primaryFormat.value, secondary: secondaryFormat.value, fps: fps.value }),
    primaryText: () => primaryText.value,
    secondaryText: () => secondaryText.value,
    setFormat,
    swapFormats,
    setFps,
    tempo: () => currentTempo.value,
    meter: () => meterText.value,
    tap: () => onTap(),
    tapState: () => ({ live: tapLive.value, dialog: tapDlg.value ? { ...tapDlg.value } : null }),
    openTempo: (bpm: number) => openTempoDialog(bpm),
    applyTempo: (bpm: number) => applyTempo(bpm),
    metronome: () => ({ ...metroState, host: audioHost }),
    setMetronome: (on: boolean) => setMetronomeOn(on),
  };
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  document.removeEventListener('pointerdown', onDocDown, true);
  offFrame?.();
  offFrame = null;
  clearTimeout(tapTimer);
  pause();
});
</script>

<template>
  <footer class="transport">
    <button
      class="tp play"
      :class="{ on: state.playing }"
      :disabled="!state.ready"
      :title="state.playing ? t('transport.pause') : t('transport.play')"
      @click="toggle()"
    >
      {{ state.playing ? '❚❚' : '▶' }}
    </button>
    <button class="tp" :disabled="!state.ready" :title="t('transport.rewind')" @click="stop()">|◀</button>

    <span class="tc num" :title="t('transport.currentTime')">{{ timeText }}</span>

    <div class="bar" :class="{ disabled: !durationMs }" @pointerdown="onBarDown" @pointermove="onBarMove" @pointerup="onBarUp">
      <div class="bar-fill" :style="{ width: progress * 100 + '%' }" />
      <span class="bar-knob" :style="{ left: progress * 100 + '%' }" />
    </div>

    <input
      v-if="durEdit !== null"
      ref="durInputEl"
      v-model="durEdit"
      class="tc num dur-input"
      :title="t('transport.timelineDurationTitle')"
      @keydown.enter.prevent="commitDurEdit"
      @keydown.esc.prevent="durEdit = null"
      @blur="commitDurEdit"
    />
    <button
      v-else-if="state.sourceMode === 'timeline'"
      class="tc num dim dur-btn"
      :title="t('transport.timelineDurationTitle')"
      @click="startDurEdit"
    >{{ durText }}</button>
    <span v-else class="tc num dim" :title="t('transport.totalTime')">{{ durText }}</span>

    <span class="tp-sep" />

    <!-- 主时间（默认小节.拍）/ 次时间（默认时间码） -->
    <span class="time-cell">
      <span class="time-btn">
        <!-- 图标只管「换显示格式」，数字只管「改位置」—— 两件事分开，点下去不会有歧义 -->
        <button class="fmt-btn" :title="timeTitle('primary')" @click="onTimeClick('primary', $event)">
          <TimeFormatIcon :format="primaryFormat" />
        </button>
        <input
          v-if="timeEdit?.which === 'primary'"
          ref="timeInputEl"
          v-model="timeEdit.text"
          class="time-input num"
          :title="t('transport.timeEditHint')"
          @dblclick.stop
          @keydown.enter.prevent="commitTimeEdit"
          @keydown.esc.prevent="cancelTimeEdit"
          @blur="commitTimeEdit"
        />
        <button
          v-else
          class="time-val num"
          :title="t('transport.timeEditHint')"
          @click="startTimeEdit('primary', $event)"
        >
          <BarBeatText v-if="primaryFormat === 'bars' && barPos" :pos="barPos" />
          <template v-else>{{ primaryText }}</template>
        </button>
      </span>
      <div v-if="timeMenu === 'primary'" class="tp-pop time-pop" @pointerdown.stop>
        <button
          v-for="f in TIME_FORMATS"
          :key="'pf-' + f"
          :class="{ on: primaryFormat === f }"
          @click="setFormat('primary', f)"
        >
          <TimeFormatIcon :format="f" />
          <span>{{ formatLabel(f) }}</span>
        </button>
      </div>
    </span>

    <span class="time-cell">
      <span class="time-btn">
        <button class="fmt-btn" :title="timeTitle('secondary')" @click="onTimeClick('secondary', $event)">
          <TimeFormatIcon :format="secondaryFormat" />
        </button>
        <input
          v-if="timeEdit?.which === 'secondary'"
          ref="timeInputEl"
          v-model="timeEdit.text"
          class="time-input num"
          :title="t('transport.timeEditHint')"
          @dblclick.stop
          @keydown.enter.prevent="commitTimeEdit"
          @keydown.esc.prevent="cancelTimeEdit"
          @blur="commitTimeEdit"
        />
        <button
          v-else
          class="time-val num"
          :title="t('transport.timeEditHint')"
          @click="startTimeEdit('secondary', $event)"
        >
          <BarBeatText v-if="secondaryFormat === 'bars' && barPos" :pos="barPos" />
          <template v-else>{{ secondaryText }}</template>
        </button>
      </span>
      <div v-if="timeMenu === 'secondary'" class="tp-pop time-pop" @pointerdown.stop>
        <button
          v-for="f in TIME_FORMATS"
          :key="'sf-' + f"
          :class="{ on: secondaryFormat === f }"
          @click="setFormat('secondary', f)"
        >
          <TimeFormatIcon :format="f" />
          <span>{{ formatLabel(f) }}</span>
        </button>
      </div>
    </span>

    <span class="time-cell">
      <button class="chip fps" :class="{ on: timeMenu === 'fps' }" :title="t('transport.fpsTitle')" @click="onFpsClick">
        {{ t('transport.fps', { fps }) }}
      </button>
      <div v-if="timeMenu === 'fps'" class="tp-pop time-pop" @pointerdown.stop>
        <button v-for="n in FRAME_RATES" :key="'fps-' + n" :class="{ on: fps === n }" @click="setFps(n)">
          {{ t('transport.fps', { fps: n }) }}
        </button>
      </div>
    </span>

    <span class="tp-sep" />

    <span class="tempo-cell" :title="t('transport.tempoTitle')" @click="openTempoDialog(currentTempo)">
      <span class="mini-label">{{ t('transport.tempo') }}</span>
      <span class="num tempo-val">{{ tempoText }}</span>
    </span>
    <span class="meter-cell" :title="t('transport.meter')">
      <span class="mini-label">{{ t('transport.meter') }}</span>
      <span class="num">{{ meterText }}</span>
    </span>
    <span
      v-if="state.sourceMode === 'timeline'"
      class="chip timeline"
      :title="t('transport.timelineModeTitle')"
    >{{ t('transport.timelineMode') }}</span>

    <button class="chip tap" :disabled="!analysis" :title="t('transport.tapTitle')" @click="onTap">
      {{ t('transport.tap') }}
    </button>

    <span class="metro-wrap">
      <button
        class="chip metro"
        :class="{ on: metroState.on }"
        :disabled="!audioHost"
        :title="audioHost ? t('transport.metronomeTitle') : t('transport.metroHostOnly')"
        @click="toggleMetro"
      >
        <!-- 镂空节拍器：只描边、不填充；SVG 比 clip-path 掏洞稳，背景色变了也不会露馅 -->
        <svg class="metro-shape" viewBox="0 0 10 14" aria-hidden="true">
          <polygon
            points="3.2 0.8 6.8 0.8 8.2 13.2 1.8 13.2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
          />
        </svg>
      </button>
      <button class="mini metro-gear" :disabled="!audioHost" :title="t('transport.metroSettings')" @click="metroMenu = !metroMenu">
        ⚙
      </button>
      <div v-if="metroMenu" class="tp-pop metro-pop" @pointerdown.stop>
        <label class="metro-row">
          <span>{{ t('transport.metroVolume') }}</span>
          <input
            type="range"
            min="0"
            max="100"
            :value="Math.round(metroState.volume * 100)"
            @input="onMetroVolume"
          />
        </label>
        <label class="metro-row">
          <input type="checkbox" :checked="metroState.accent" @change="onMetroAccent" />
          {{ t('transport.metroAccent') }}
        </label>
      </div>
    </span>

    <span class="grow" />

    <span v-if="state.error" class="warn tiny" :title="errorText">⚠ {{ errorText }}</span>
    <span v-else-if="state.decoding" class="faint tiny">{{ t('transport.decoding') }}</span>

    <!-- 原点偏移（逐版本）：导出留白全靠它 -->
    <span class="offset" :title="t('transport.originTitle', { pos: originText })">
      <span class="faint">{{ t('transport.origin') }}</span>
      <button class="mini" :disabled="!analysis || saving" :title="t('transport.earlier')" @click="saveOffset(offsetInput - 10)">−</button>
      <input
        v-model.number="offsetInput"
        class="num"
        type="number"
        step="1"
        :disabled="!analysis"
        @change="saveOffset(Number(offsetInput) || 0)"
      />
      <span class="faint">ms</span>
      <button class="mini" :disabled="!analysis || saving" :title="t('transport.later')" @click="saveOffset(offsetInput + 10)">＋</button>
      <button class="mini wide" :disabled="!state.ready || !analysis" :title="t('transport.originFromPlayheadTitle')" @click="setOriginAtPlayhead">
        {{ t('transport.originFromPlayhead') }}
      </button>
    </span>

    <!--
      「跟随」按钮已经从这里删掉（2026-11-13 用户要求）：
      跟随本质上是**时间线面板的翻页事件**（播放时把播放头滚进视野），
      归面板管就够了 —— 面板顶栏里那个按钮就是同一个 `setFollow` 开关。
      一个状态两个入口，在播放条上反而像是「播放属性」，位置是错的。
    -->

    <!-- 主输出增益：满格 0dB，往下负增益，拉到最低 -∞（双击回 0dB） -->
    <span class="gain" :title="t('transport.masterTitle', { db: dbText })">
      <span class="faint gain-tag">{{ t('transport.master') }}</span>
      <div
        ref="faderEl"
        class="fader"
        role="slider"
        :aria-valuenow="Math.round(gainPct)"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuetext="dbText"
        @pointerdown="onFaderDown"
        @pointermove="onFaderMove"
        @pointerup="onFaderUp"
        @dblclick="setGain(1)"
      >
        <span class="fader-fill" :style="{ width: gainPct + '%' }" />
        <span class="fader-knob" :style="{ left: gainPct + '%' }" />
      </div>
      <span class="gain-db num" :class="{ unity: state.gain >= 0.999 }">{{ dbText }}</span>
    </span>

    <!-- 覆盖已对齐的原点是不可撤销的，先确认再写 -->
    <ConfirmDialog
      v-if="askOrigin"
      :title="t('confirm.origin.title')"
      :body="t('confirm.origin.body', { from: originText, to: playheadText })"
      :detail="t('confirm.origin.detail', { ms: Math.round(state.currentMs || 0) })"
      :ok="t('confirm.origin.ok')"
      @confirm="applyOriginAtPlayhead"
      @cancel="askOrigin = false"
    />

    <!-- Tap 结果 / 手动输入速度 -->
    <Teleport to="body">
      <div v-if="tapDlg" class="tp-mask" @click.self="tapDlg = null" @pointerdown.stop @keydown.stop @keydown.esc="tapDlg = null">
        <div class="tp-dialog" role="dialog" aria-modal="true">
          <h3>{{ t('transport.tempoDialogTitle') }}</h3>
          <p class="tp-body">{{ t('transport.tempoDialogBody', { bpm: tapDlg.bpm.toFixed(3) }) }}</p>
          <label class="tp-input-row">
            <span>{{ t('transport.tempoInput') }}</span>
            <input
              v-model.number="tapDlg.bpm"
              class="num"
              type="number"
              min="20"
              max="300"
              step="0.001"
              @input="tapError = false"
              @keydown.enter="applyTapTempo"
            />
          </label>
          <p v-if="tapError" class="tp-err">{{ t('transport.tempoInvalid') }}</p>
          <div class="tp-actions">
            <button class="chip" @click="tapDlg = null">{{ t('common.cancel') }}</button>
            <button class="chip on" @click="applyTapTempo">{{ t('transport.tempoApply') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </footer>
</template>

<style scoped>
.transport {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 10px;
  border-top: 1px solid var(--line);
  background: var(--surface);
  font-size: 11px;
  min-width: 0;
  white-space: nowrap;
}
.tp {
  width: 26px; height: 22px;
  border: 1px solid var(--line); border-radius: 3px;
  color: var(--text-dim);
}
.tp:hover:not(:disabled) { color: var(--text); border-color: var(--line-strong); }
.tp:disabled { opacity: 0.4; cursor: default; }
.tp.play.on { color: var(--accent); border-color: var(--accent); }
.tc { color: var(--text); min-width: 62px; }
.tc.dim { color: var(--text-dim); }
/* 仅时间线：总长可点开手改；按钮形态与只读读数同宽，不撑动播放条 */
.dur-btn { padding: 0; text-align: left; font-size: 11px; }
.dur-btn:hover { color: var(--text); text-decoration: underline dotted; }
.dur-input {
  width: 70px; height: 20px; padding: 0 3px;
  font-size: 11px; background: var(--surface); color: var(--text);
  border: 1px solid var(--accent); border-radius: 2px;
}
/* 不是错误也不是警告：只是说明这条时间线不发声、没有和外部播放同步 */
.timeline { flex: none; border-color: var(--line-strong); color: var(--text-dim); }
.tp-sep { width: 1px; height: 16px; background: var(--line); margin: 0 2px; flex: none; }

.bar {
  position: relative;
  flex: 1 1 160px;
  min-width: 60px;
  height: 4px;
  background: var(--surface-2);
  border-radius: 2px;
  cursor: pointer;
}
.bar.disabled { opacity: 0.4; cursor: default; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 2px; }
.bar-knob {
  position: absolute; top: 50%;
  width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px;
  border-radius: 50%;
  background: var(--accent);
}

/* ---- 主 / 次时间显示 ---- */
.time-cell { position: relative; display: inline-flex; align-items: center; flex: none; }
.time-btn {
  display: inline-flex; align-items: center; gap: 2px;
  height: 22px; min-width: 0; padding: 0 3px 0 2px;
  border: 1px solid var(--line); border-radius: 3px;
  background: var(--surface-2); color: var(--text);
  font-size: 11px;
}
.time-btn:hover { border-color: var(--line-strong); }
/* 格式图标：点它换格式。做小、做淡，别和读数抢注意力 */
.fmt-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 18px; border-radius: 2px; color: var(--text-dim);
}
.fmt-btn:hover { background: var(--sel-bg); color: var(--text); }
/* 读数槽压到 80px：够放满 4 位小节 / 时间码，又不让块本身虚胖 */
.time-val {
  min-width: 80px; height: 18px; text-align: center;
  display: inline-flex; justify-content: center; align-items: center;
  border-radius: 2px; color: var(--text);
}
.time-val:hover { background: var(--sel-bg); }
/* 行内编辑：和读数同宽同字号，落点不跳 */
.time-input {
  width: 84px; height: 18px; padding: 0 3px;
  font-size: 11px; text-align: center;
  color: var(--text); background: var(--surface);
  border: 1px solid var(--accent); border-radius: 2px;
}
.fps { height: 20px; padding: 0 6px; font-size: 10.5px; min-width: 0; }
.fps.on, .metro.on { border-color: var(--accent); color: var(--accent); background: var(--sel-bg); }

/* ---- 速度 / 拍号 / Tap / 节拍器 ---- */
.tempo-cell, .meter-cell {
  display: inline-flex; align-items: center; gap: 5px;
  height: 22px; padding: 0 5px;
  border-radius: 3px;
}
.tempo-cell { cursor: pointer; }
.tempo-cell:hover { background: var(--sel-bg); }
.mini-label { font-size: 9px; color: var(--text-faint); }
.tempo-val { min-width: 48px; text-align: right; }
.meter-cell .num { min-width: 32px; text-align: center; }
.tap { height: 22px; padding: 0 8px; min-width: 0; }
.metro-wrap { position: relative; display: inline-flex; align-items: center; gap: 2px; flex: none; }
.metro { height: 22px; padding: 0 7px; min-width: 0; }
/* 竖起来的长条等腰梯形（Cubase 的节拍器图标），不用 ♩ —— ♩ 留给「小节.拍」格式。
   镂空：polygon 只描边、fill:none，背景色换了也不会露出实心块。 */
.metro-shape {
  display: block;
  width: 10px; height: 14px;
  flex: none;
  overflow: visible;
}
.metro-gear { height: 20px; min-width: 20px; padding: 0 4px; }

.tp-pop {
  position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 70;
  display: flex; flex-direction: column; min-width: 138px;
  padding: 3px;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 4px; box-shadow: var(--shadow);
}
.tp-pop button {
  display: flex; align-items: center; gap: 6px;
  text-align: left; padding: 4px 8px; border-radius: 3px;
  color: var(--text); font-size: 11px; white-space: nowrap;
}
.tp-pop button:hover { background: var(--sel-bg); }
.tp-pop button.on { color: var(--accent); }
.metro-pop { min-width: 188px; padding: 8px; gap: 8px; }
.metro-pop .metro-row { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-dim); }
.metro-pop .metro-row input[type='range'] {
  flex: 1; min-width: 0;
  accent-color: var(--accent);
}
.metro-pop .metro-row input[type='checkbox'] {
  margin: 0;
  accent-color: var(--accent);
}
/* 节拍器设置也走 Vue 绿：滑块/勾选/当前值都用 --accent，而不是浏览器默认蓝 */
.metro-pop .metro-row:hover { color: var(--text); }

/* ---- 原点 / 跟随 / 主输出（原功能） ---- */
.offset { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.offset input { width: 58px; height: 20px; padding: 0 4px; font-size: 11px; }
.mini {
  height: 20px; min-width: 20px; padding: 0 5px;
  border: 1px solid var(--line); border-radius: 3px;
  color: var(--text-dim); background: var(--surface-2);
  font-size: 10.5px;
}
.mini:hover:not(:disabled) { color: var(--text); border-color: var(--line-strong); }
.mini:disabled { opacity: 0.4; cursor: default; }
.mini.wide { padding: 0 8px; }
.grow { flex: 0 1 14px; }
.warn { color: var(--warn); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tiny { font-size: 10.5px; }

.chip.on { border-color: var(--accent); color: var(--text); background: var(--sel-bg); }

/* ---- 主输出推子 ---- */
.gain { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.gain-tag { font-size: 10px; letter-spacing: 0.04em; }
.fader {
  position: relative;
  width: 76px; height: 14px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  touch-action: none;
}
.fader:hover { border-color: var(--line-strong); }
.fader-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  background: linear-gradient(to right, rgba(var(--accent-rgb), 0.28), rgba(var(--accent-rgb), 0.62));
  border-radius: 2px 0 0 2px;
  pointer-events: none;
}
.fader-knob {
  position: absolute; top: 50%;
  width: 7px; height: 18px; margin: -9px 0 0 -3.5px;
  border-radius: 2px;
  background: var(--text-dim);
  border: 1px solid var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.fader:hover .fader-knob { background: var(--text); }
.fader:active .fader-knob { background: var(--accent); }
.gain-db { min-width: 52px; text-align: right; color: var(--text-dim); }
.gain-db.unity { color: var(--accent); }

/* ---- Tap / 手动速度弹窗 ---- */
.tp-mask {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.tp-dialog {
  width: 300px; padding: 14px 16px;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 6px; box-shadow: var(--shadow);
  color: var(--text);
}
.tp-dialog h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.tp-body { margin: 0 0 10px; font-size: 11.5px; color: var(--text-dim); line-height: 1.5; }
.tp-input-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
.tp-input-row input { flex: 1; height: 24px; padding: 0 6px; font-size: 12px; }
.tp-err { margin: 6px 0 0; color: var(--warn); font-size: 11px; }
.tp-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
