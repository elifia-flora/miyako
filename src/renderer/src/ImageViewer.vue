<script setup lang="ts">
/**
 * ImageViewer.vue — 图片查看窗口（封面大图）
 *
 * 路由：#image（main.ts 里按 hash 切换根组件）
 *
 * 为什么要有这个窗口：详情面板只有 260px 宽，塞一张彩色封面的缩略图既挤又抢眼，
 * 所以那里只给一个可点的文件名，点开才在这里看原图。
 *
 * 图片走 ma-art:// 自定义协议 —— 渲染层拿不到任意文件读取的能力，
 * 协议处理器里已经做了「只允许 dataDir / assetsDir 内」的校验。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const api = (window as any).api;

const url = ref<string>('');
const title = ref<string>('');
const failed = ref(false);
/** 图片加载完的真实尺寸，用来把窗口撑到刚好（主进程加一点边距） */
const natural = ref<{ w: number; h: number } | null>(null);

function applyTheme(v: string) {
  document.documentElement.dataset.theme = v === 'light' ? 'light' : 'dark';
}

function apply(p: { url: string; title: string }) {
  url.value = p.url ?? '';
  title.value = p.title ?? '';
  failed.value = false;
  natural.value = null;
}

let unsubImage: (() => void) | null = null;
let unsubTheme: (() => void) | null = null;

onMounted(() => {
  unsubTheme = api.app.onTheme(applyTheme);
  void api.app.theme().then((t: string) => applyTheme(t)).catch(() => { /* 用默认深色 */ });
  unsubImage = api.win.onImage(apply);
});

onBeforeUnmount(() => {
  unsubImage?.();
  unsubTheme?.();
});

function onLoad(ev: Event) {
  const el = ev.target as HTMLImageElement;
  failed.value = false;
  natural.value = { w: el.naturalWidth, h: el.naturalHeight };
  void api.win.resizeImage(el.naturalWidth, el.naturalHeight);
}

function onError() {
  failed.value = true;
  natural.value = null;
}

/** 空白处 / 双击：关闭。查看大图时关窗是最常用的动作 */
function maybeClose(ev: MouseEvent) {
  if (ev.target === ev.currentTarget) api.win.close();
}

watch(url, () => {
  failed.value = false;
});
</script>

<template>
  <div class="iv-shell" @click="maybeClose" @dblclick="api.win.close()">
    <header class="iv-header">
      <span class="iv-title">{{ title }}</span>
      <button class="iv-close" title="Close" @click="api.win.close()">✕</button>
    </header>
    <div class="iv-body">
      <p v-if="failed" class="iv-error">无法显示这张图片</p>
      <img v-else-if="url" class="iv-img" :src="url" alt="" @load="onLoad" @error="onError" />
      <p v-else class="iv-error">没有图片</p>
    </div>
    <footer v-if="natural" class="iv-foot">
      {{ natural.w }} × {{ natural.h }}
    </footer>
  </div>
</template>

<style scoped>
/* 配色全部走 tokens.css 变量，深浅两套自动正确 */
.iv-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.iv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 8px 0 12px;
  height: 24px;
  flex: none;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
}
.iv-title {
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.iv-close {
  flex: none;
  -webkit-app-region: no-drag;
  width: 22px; height: 20px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 11px;
}
.iv-close:hover { color: var(--text); border-color: var(--line-strong); }

.iv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 棋盘格：图片与背景同色时也能看出边界 */
  background:
    repeating-conic-gradient(var(--surface-2) 0% 25%, var(--surface) 0% 50%) 50% / 16px 16px;
  padding: 16px;
}
.iv-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.3);
}
.iv-error { color: var(--text-faint); font-size: 12px; }
.iv-foot {
  flex: none;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  border-top: 1px solid var(--line);
  background: var(--surface);
}
</style>