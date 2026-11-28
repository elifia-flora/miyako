<script setup lang="ts">
/**
 * OverlayLyrics.vue — 桌面歌词浮窗
 *
 * 透明置顶无边框窗口，只显示当前句（+ 可选下一句）。
 * 可拖动（按住底部拖动条），位置由主进程落盘。
 *
 * 路由：#overlay
 * 样式来自主进程 IPC 广播（跨窗口 localStorage 不可靠）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { activeLineIndex } from '@shared/lrc.js';
import { t } from './i18n';

const api = (window as any).api;

/* ---- 播放状态 ---- */
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
const lines = ref<LyricLine[]>([]);
const instrumental = ref(false);

/* ---- 样式（主进程写、这里收广播） ---- */
const style = ref({ size: 34, opacity: 0.95, color: 'white' as 'white' | 'accent' | 'warm', next: true });

/* ---- 当前句索引 ---- */
function activeIndex(): number {
  return activeLineIndex(lines.value, player.value.currentMs);
}

const curLine = computed(() => {
  const idx = activeIndex();
  return idx >= 0 ? lines.value[idx]?.text ?? '' : '';
});
const nextLine = computed(() => {
  const idx = activeIndex();
  return idx >= 0 && idx + 1 < lines.value.length ? lines.value[idx + 1]?.text ?? '' : '';
});

const isIdle = computed(() => !player.value.trackId);
const showNext = computed(() => style.value.next && nextLine.value && !isIdle.value);

/* ---- 文字颜色映射 ---- */
const colorMap: Record<string, { fg: string; shadow?: string }> = {
  white: { fg: '#ffffff', shadow: 'rgba(0,0,0,.6)' },
  accent: { fg: '#42b883', shadow: 'rgba(0,0,0,.6)' },
  warm: { fg: '#f5d5a8', shadow: 'rgba(0,0,0,.65)' },
};
const colors = computed(() => colorMap[style.value.color] ?? colorMap.white);

/* ---- 加载歌词 ---- */
let loadedKey = '';
async function loadForTrack(trackId: string, recId?: string | null) {
  if (!trackId) { lines.value = []; loadedKey = ''; return; }
  try {
    const doc = await api.lyrics.resolve(trackId, recId ?? null);
    lines.value = doc.lines ?? [];
    instrumental.value = !!doc.instrumental;
    loadedKey = `${trackId}|${recId || ''}`;
  } catch {
    lines.value = [];
  }
}

/* ---- 拖动 ---- */
let dragging = false;
let dragStartX = 0, dragStartY = 0;

function onDragStart(ev: PointerEvent) {
  dragging = true;
  dragStartX = ev.screenX;
  dragStartY = ev.screenY;
  (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
}
function onDragMove(ev: PointerEvent) {
  if (!dragging) return;
  const dx = ev.screenX - dragStartX;
  const dy = ev.screenY - dragStartY;
  dragStartX = ev.screenX;
  dragStartY = ev.screenY;
  void api.win.moveOverlay(dx, dy);
}
function onDragEnd() {
  dragging = false;
}

/* ---- 关闭 ---- */
function closeOverlay() {
  void api.win.closeOverlay();
}

/* ---- 订阅 ---- */
let unsubState: (() => void) | null = null;
let unsubStyle: (() => void) | null = null;

onMounted(async () => {
  unsubState = api.player.onState((st: any) => {
    player.value = { ...player.value, ...st };
    const key = `${st.trackId || ''}|${st.recId || ''}`;
    if (key !== loadedKey) void loadForTrack(st.trackId, st.recId ?? null);
  });
  // 读当前样式
  try { style.value = await api.lyrics.style(); } catch { /* 用默认 */ }
  unsubStyle = api.lyrics.onStyle((st: any) => {
    if (st) style.value = { ...st };
  });
  try {
    const st = await api.player.state();
    if (st?.trackId) {
      player.value = { ...player.value, ...st };
      void loadForTrack(st.trackId, st.recId ?? null);
    }
  } catch { /* 窗口刚开，主窗口可能还没播 */ }
});

onBeforeUnmount(() => {
  unsubState?.();
  unsubStyle?.();
});
</script>

<template>
  <div class="ol-shell" :style="{ '--ol-size': style.size + 'px', '--ol-op': style.opacity, '--ol-fg': colors.fg, '--ol-shadow': colors.shadow }">
    <!-- 当前句 -->
    <div class="ol-main">
      <template v-if="isIdle">
        <span class="ol-line ol-idle">{{ t('overlay.idle') }}</span>
      </template>
      <template v-else-if="instrumental">
        <span class="ol-line ol-idle">{{ t('overlay.noLyrics') }}</span>
      </template>
      <template v-else-if="curLine">
        <span class="ol-line ol-cur">{{ curLine }}</span>
      </template>
      <template v-else>
        <span class="ol-line ol-idle">{{ t('overlay.noLyrics') }}</span>
      </template>
      <span v-if="showNext" class="ol-line ol-next">{{ nextLine }}</span>
    </div>

    <!-- 下一句提示 / 关闭按钮 -->
    <div class="ol-bar" @pointerdown="onDragStart" @pointermove="onDragMove" @pointerup="onDragEnd" @pointercancel="onDragEnd">
      <span class="ol-hint">{{ t('overlay.hint') }}</span>
      <button class="ol-close" :title="t('overlay.close')" @click="closeOverlay">✕</button>
    </div>
  </div>
</template>

<style scoped>
.ol-shell {
  --ol-size: 34px;
  --ol-op: 0.95;
  --ol-fg: #fff;
  --ol-shadow: rgba(0,0,0,.6);

  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 10px 16px 8px;
  user-select: none;
  cursor: default;
  /* 透明背景：让后面的东西透出来 */
  background: transparent;
  overflow: hidden;
}

.ol-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 4px;
  min-height: 0;
}

.ol-line {
  text-align: center;
  max-width: 90vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.35;
  font-weight: 500;
  letter-spacing: .02em;
  color: var(--ol-fg);
  opacity: var(--ol-op);
  text-shadow:
    0 1px 4px var(--ol-shadow),
    0 0 20px var(--ol-shadow),
    0 0 40px rgba(0,0,0,.3);
}
.ol-cur {
  font-size: var(--ol-size);
}
.ol-next {
  font-size: calc(var(--ol-size) * .62);
  opacity: calc(var(--ol-op) * .55);
}
.ol-idle {
  font-size: calc(var(--ol-size) * .75);
  opacity: calc(var(--ol-op) * .45);
}

/* 拖动条 */
.ol-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 6px;
  cursor: grab;
  flex: none;
}
.ol-bar:active { cursor: grabbing; }
.ol-hint {
  font-size: 10px;
  opacity: .25;
  color: var(--ol-fg);
  flex: 1;
  text-align: center;
}
.ol-close {
  flex: none;
  width: 22px;
  height: 22px;
  border: none;
  background: rgba(255,255,255,.12);
  color: var(--ol-fg);
  border-radius: 50%;
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: .4;
  transition: opacity .15s;
}
.ol-close:hover { opacity: .85; background: rgba(255,255,255,.22); }
</style>
