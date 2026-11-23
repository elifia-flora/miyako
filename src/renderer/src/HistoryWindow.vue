<script setup lang="ts">
/**
 * 操作历史窗口（`#history`）。
 *
 * 一条条列出「什么时候 · 哪首曲子 · 做了什么」，点哪条就把那首曲子恢复到那一步。
 * 数据全在主进程（history.ts）：这里只读列表、发指令 —— 撤销要跨窗口和跨会话，
 * 状态放渲染层会各持一份、必然漂移。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { locale, t } from './i18n';

const api = (window as any).api;

interface Entry {
  seq: number;
  at: number;
  kind: 'base' | 'step';
  trackId: string;
  title: string;
  analysisId: string;
  label: { key: string; vars?: Record<string, unknown> } | null;
}

const items = ref<Entry[]>([]);
const cursors = ref<Record<string, number>>({});
const globalCursor = ref(0);
const busy = ref(false);

function hhmmss(at: number) {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function labelText(e: Entry) {
  if (e.kind === 'base') return t('history.base');
  return e.label ? t(e.label.key, e.label.vars) : t('history.step');
}

/** 当前这条是不是「这首曲子现在所处的状态」 */
function isCurrent(e: Entry) {
  return cursors.value[e.analysisId] === e.seq;
}

/**
 * 点一条 → 回到那一步。
 *
 * 主进程恢复完会广播 `history:changed`（列表刷新）和 `history:applied`
 * （主窗口据此切曲目 / 刷新网格），这个窗口不用自己改任何数据。
 */
async function jump(e: Entry) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api.history.jump(e.seq);
  } catch (err) {
    console.error('[history] 回退失败', err);
  } finally {
    busy.value = false;
  }
}

async function clearAll() {
  if (busy.value || !items.value.length) return;
  busy.value = true;
  try {
    await api.history.clear();
  } finally {
    busy.value = false;
  }
}

function applyTheme(v: string) {
  document.documentElement.dataset.theme = v === 'light' ? 'light' : 'dark';
}

let unsubChanged: any = null;
let unsubTheme: any = null;

onMounted(async () => {
  // 同上（帮助窗）：开窗时 data-theme 还没设，必须向主进程要现在生效的那一个
  try {
    const th = await api.app.theme();
    if (th) applyTheme(String(th));
  } catch {
    /* 拿不到就按默认（深色）显示 */
  }
  unsubTheme = api.app.onTheme((v: string) => applyTheme(v));
  unsubChanged = api.history.onChanged((st: any) => {
    if (!st) return;
    items.value = Array.isArray(st.items) ? st.items : [];
    cursors.value = st.cursors ?? {};
    globalCursor.value = Number(st.globalCursor) || 0;
  });
  try {
    const st = await api.history.list();
    if (st) {
      items.value = Array.isArray(st.items) ? st.items : [];
      cursors.value = st.cursors ?? {};
      globalCursor.value = Number(st.globalCursor) || 0;
    }
  } catch {
    /* 读不到就当空列表 */
  }
});

onBeforeUnmount(() => {
  unsubChanged?.();
  unsubTheme?.();
});
</script>

<template>
  <div class="hw-root">
    <header class="hw-head">
      <span class="hw-dot" />
      <span class="hw-title">{{ t('win.historyTitle') }}</span>
      <span class="hw-count">{{ t('history.count', { n: items.length }) }}</span>
      <span class="hw-grow" />
      <button class="hw-clear" :disabled="!items.length || busy" @click="clearAll">
        {{ t('history.clear') }}
      </button>
    </header>

    <div class="hw-body">
      <p v-if="!items.length" class="hw-empty">{{ t('history.empty') }}</p>
      <ul v-else class="hw-list">
        <li
          v-for="e in items"
          :key="e.seq"
          class="hw-item"
          :class="{ cur: isCurrent(e), base: e.kind === 'base', busy }"
          @click="jump(e)"
        >
          <span class="hw-time">{{ hhmmss(e.at) }}</span>
          <span class="hw-track" :title="e.title">{{ e.title || '—' }}</span>
          <span class="hw-act">{{ labelText(e) }}</span>
          <span v-if="isCurrent(e)" class="hw-now">{{ t('history.now') }}</span>
        </li>
      </ul>
    </div>

    <footer class="hw-foot">{{ t('history.hint') }}</footer>
  </div>
</template>

<style scoped>
.hw-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--surface);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 11.5px;
  overflow: hidden;
}

.hw-head {
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line);
  -webkit-app-region: drag;
  user-select: none;
}
.hw-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
.hw-title {
  color: var(--text-dim);
}
.hw-count {
  color: var(--text-faint);
  font-size: 10.5px;
}
.hw-grow {
  flex: 1;
}
.hw-clear {
  height: 18px;
  padding: 0 7px;
  font-size: 10.5px;
  color: var(--text-dim);
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: transparent;
  -webkit-app-region: no-drag;
  cursor: pointer;
}
.hw-clear:hover:not(:disabled) {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 50%, var(--line));
}
.hw-clear:disabled {
  opacity: 0.4;
  cursor: default;
}

.hw-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}
.hw-empty {
  margin: 14px 12px;
  color: var(--text-faint);
  line-height: 1.6;
}

.hw-list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.hw-item {
  display: grid;
  grid-template-columns: 60px minmax(0, 1fr) minmax(0, 1.2fr) auto;
  gap: 8px;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.hw-item:hover {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
/* 当前所处的那一步：左侧一道强调条 + 淡底，一眼能看出「现在在哪」 */
.hw-item.cur {
  border-left-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.hw-item.base .hw-act {
  color: var(--text-faint);
  font-style: italic;
}
.hw-item.busy {
  cursor: default;
}
.hw-time {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.hw-track {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hw-act {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hw-now {
  font-size: 10px;
  color: var(--accent);
  white-space: nowrap;
}

.hw-foot {
  flex: none;
  padding: 5px 12px;
  border-top: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 10.5px;
}
</style>
