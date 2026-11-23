<script setup lang="ts">
/**
 * 音频元数据面板（右键曲目 → 音频元数据）。
 *
 * 只读展示：文件里实际写了什么，就显示什么 —— 跨容器归并成「标准字段」，
 * 同时把各容器自己的原始字段原封不动留在下面（`bext` / `iXML` / `ID3v2.3.0` /
 * `VORBIS_COMMENT`），因为「标准字段」是**别人对文件的解读**，
 * 原始字段才是文件本身。
 *
 * 唯一的写操作是「从 iXML 填入档案」：Cubase 导出的 wav 里，
 * iXML 带着工程的 `MusicalTempo` 与 `MusicalSignature`，手抄一遍很容易抄错。
 * 这里只把值提出来交给上层（`applied`），真正写库走 `tracks:update` ——
 * 面板自己不碰数据库，保持单一写入口。
 */
import { computed, onMounted, ref } from 'vue';
import { t } from '../i18n';

const api = (window as any).api;
const props = defineProps<{
  trackId: string;
  /** 哪一条录音版本（省略 = 作品的主录音）。元数据属于文件，同一作品的两版可能完全不同 */
  recId?: string | null;
  /** 档案里现在的值，用来在确认窗口里比对 */
  current?: { title?: string | null; album?: string | null; bpm?: number | null; meter?: string | null };
}>();
const emit = defineEmits<{
  close: [];
  /** 请求填档案：只把「文件里有什么」交上去，弹确认窗口、写库都在上层 */
  apply: [
    {
      rows: Array<{ key: string; label: string; fileValue: string; trackValue: string; writable: boolean }>;
      fileName: string;
    },
  ];
}>();

const data = ref<any>(null);
const loading = ref(true);
const error = ref('');
/** 哪些原始分组是展开的（默认全收起：iXML 能有 70 项，一进来全铺开会把人淹了） */
const expanded = ref<Record<string, boolean>>({});

onMounted(async () => {
  try {
    data.value = await api.audio.tags(props.trackId, props.recId ?? null);
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
});

/** 标准字段的显示顺序：先「人」，再「音乐」，最后「工程」 */
const STD_ORDER = ['title', 'artist', 'album', 'date', 'bpm', 'meter', 'encoder', 'encodedBy', 'comment', 'timeReference', 'loudness'];

const stdRows = computed(() => {
  const std = data.value?.standard ?? {};
  return STD_ORDER.filter((k) => std[k]).map((k) => ({ key: k, label: t(`audioMeta.f.${k}`), value: String(std[k]) }));
});

/** timeReference 是**采样数**，换算成时分秒才看得懂 */
function timeRefText(v: string): string {
  const sr = Number(data.value?.sampleRate) || 0;
  const n = Number(v);
  if (!sr || !Number.isFinite(n)) return '';
  const s = n / sr;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const hh = h ? `${h}:` : '';
  return `${hh}${String(m).padStart(h ? 2 : 1, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

function rowValue(row: { key: string; value: string }): string {
  if (row.key === 'timeReference') {
    const s = timeRefText(row.value);
    return s ? `${row.value} · ${s}` : row.value;
  }
  return row.value;
}

/**
 * 能搬进档案的字段 —— **档案支持写哪些，这里才能列哪些**。
 * `date` 只读：`tracks:update` 没有日期这一项，列出来是为了「看一眼核对」，
 * 勾选框会给成禁用态，而不是让人勾了却没效果。
 */
const CANDIDATES: Array<{ key: string; writable: boolean }> = [
  { key: 'title', writable: true },
  { key: 'album', writable: true },
  { key: 'bpm', writable: true },
  { key: 'meter', writable: true },
  { key: 'date', writable: false },
];

const applyRows = computed(() => {
  const std = data.value?.standard ?? {};
  const cur: any = props.current ?? {};
  return CANDIDATES.filter((c) => std[c.key])
    .map((c) => ({
      key: c.key,
      label: t(`audioMeta.f.${c.key}`),
      fileValue: String(std[c.key]),
      trackValue: cur[c.key] === null || cur[c.key] === undefined || cur[c.key] === '' ? '' : String(cur[c.key]),
      writable: c.writable,
    }))
    .filter((r) => r.writable || r.fileValue);
});

/** 至少有一个可写字段、且和档案不一样，才有「填」的意义 */
const anyWritable = computed(() => applyRows.value.some((r) => r.writable && r.fileValue !== r.trackValue));

function toggle(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
}
</script>

<template>
  <div class="am-mask" @pointerdown.self="emit('close')">
    <div class="am-panel" role="dialog" aria-modal="true" tabindex="-1" @keydown.esc="emit('close')">
      <header class="am-head">
        <div class="am-title-row">
          <h3>{{ t('audioMeta.title') }}</h3>
          <button class="am-x" :title="t('btn.close')" @click="emit('close')">×</button>
        </div>
        <p class="am-file num" :title="data?.path ?? ''">{{ data?.name || '—' }}</p>
        <p v-if="data?.exists" class="am-sub faint num">
          {{ String(data.format ?? '').toUpperCase() }}
          <template v-if="data.bytes"> · {{ (data.bytes / 1048576).toFixed(1) }} MB</template>
        </p>
      </header>

      <div class="am-body">
        <p v-if="loading" class="faint tiny">{{ t('audioMeta.loading') }}</p>
        <p v-else-if="error" class="am-warn tiny">{{ error }}</p>
        <p v-else-if="!data?.exists" class="am-warn tiny">{{ t('audioMeta.noFile') }}</p>

        <template v-else>
          <section v-if="stdRows.length" class="am-sec">
            <h4>{{ t('audioMeta.standard') }}</h4>
            <dl class="am-kv">
              <template v-for="row in stdRows" :key="row.key">
                <dt>{{ row.label }}</dt>
                <dd class="num">{{ rowValue(row) }}</dd>
              </template>
            </dl>
          </section>
          <p v-else class="faint tiny">{{ t('audioMeta.empty') }}</p>

          <div v-if="applyRows.length" class="am-apply">
            <button class="chip" :disabled="!anyWritable" @click="emit('apply', { rows: applyRows, fileName: data?.name ?? '' })">
              {{ t('audioMeta.apply', { n: applyRows.length }) }}
            </button>
            <span v-if="!anyWritable" class="faint tiny">{{ t('audioMeta.sameAnyway') }}</span>
          </div>

          <section v-if="data.groups.length" class="am-sec">
            <h4>{{ t('audioMeta.raw') }}</h4>
            <div v-for="g in data.groups" :key="g.id" class="am-group">
              <button class="am-group-head" @click="toggle(g.id)">
                <span class="am-caret" :class="{ open: expanded[g.id] }">▸</span>
                <span class="am-gid num">{{ g.id }}</span>
                <span class="faint tiny num">{{ g.items.length }}</span>
              </button>
              <dl v-if="expanded[g.id]" class="am-kv am-kv-raw">
                <template v-for="(it, i) in g.items" :key="g.id + i">
                  <dt class="num">{{ it.key }}</dt>
                  <dd>{{ it.value === '' ? '—' : it.value }}</dd>
                </template>
              </dl>
            </div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 前缀 `am-`：App.vue 的 `.modal-mask` 是 scoped 的，跨组件复用不到，另起一套专名 */
.am-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.am-panel {
  width: 620px;
  max-width: calc(100vw - 40px);
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  box-shadow: var(--shadow);
  padding: 12px 16px 10px;
  outline: none;
}
.am-head { flex: 0 0 auto; }
.am-title-row { display: flex; align-items: center; justify-content: space-between; }
.am-title-row h3 { margin: 0; font-size: 13px; font-weight: 500; }
.am-x {
  border: 0;
  background: transparent;
  color: var(--dim);
  font-size: 16px;
  line-height: 1;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}
.am-x:hover { color: var(--text); background: var(--hover); }
.am-file {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-sub { margin: 1px 0 0; font-size: 11px; }

.am-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin-top: 10px;
  padding-right: 4px;
}
.am-sec { margin-bottom: 12px; }
.am-sec h4 {
  margin: 0 0 5px;
  font-size: 11px;
  font-weight: 500;
  color: var(--dim);
  letter-spacing: 0.02em;
}
.am-kv {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 3px 10px;
  margin: 0;
  font-size: 12px;
}
.am-kv dt { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.am-kv dd { margin: 0; word-break: break-all; }
.am-kv-raw dt { font-size: 11px; }
.am-kv-raw dd { font-size: 11px; }

.am-group { border-top: 1px solid var(--line); }
.am-group-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 2px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}
.am-group-head:hover { background: var(--hover); }
.am-caret { display: inline-block; transition: transform 0.12s; color: var(--dim); }
.am-caret.open { transform: rotate(90deg); }
.am-gid { flex: 1 1 auto; }

.am-apply { display: flex; align-items: center; gap: 8px; margin: 2px 0 12px; flex-wrap: wrap; }
.am-warn { color: var(--danger); }
</style>
