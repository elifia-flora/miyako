<script setup lang="ts">
/**
 * 「从音频元数据填入档案」的确认窗口。
 *
 * 为什么要多一步：文件的标签**不一定可信** —— 转码器会把上游工程的信息原样带过来，
 * 也可能带上别人的标题。所以这里把每个字段摊开成「文件写的是什么 → 档案现在是什么」，
 * 逐行勾选，默认全勾但**允许取消**。用户看到「专辑」那行写着别的东西，取消它就行，
 * 不用为了填一个速度去手抄另外三个字段。
 *
 * 只读字段（日期）也会列出来：档案里没有对应列，但「看一眼对不对」本身有价值，
 * 勾选框给禁用态而不是假装能勾 —— 勾了没效果比不能勾更糟。
 */
import { computed, ref } from 'vue';
import { t } from '../i18n';

const props = defineProps<{
  /** 每个字段：文件值 / 档案值 / 能不能写 */
  rows: Array<{ key: string; label: string; fileValue: string; trackValue: string; writable: boolean }>;
  /** 哪条音频（显示用，让人知道自己在填哪个文件的值） */
  fileName?: string;
}>();
const emit = defineEmits<{ confirm: [picked: Record<string, string>]; cancel: [] }>();

/** 默认全勾「可写」的；只读行不参与 */
const checked = ref<Record<string, boolean>>(
  Object.fromEntries(props.rows.filter((r) => r.writable).map((r) => [r.key, true]))
);

const pickedCount = computed(() => props.rows.filter((r) => r.writable && checked.value[r.key]).length);

function toggle(key: string, writable: boolean) {
  if (!writable) return;
  checked.value = { ...checked.value, [key]: !checked.value[key] };
}

function confirm() {
  const out: Record<string, string> = {};
  for (const r of props.rows) if (r.writable && checked.value[r.key]) out[r.key] = r.fileValue;
  if (!Object.keys(out).length) return;
  emit('confirm', out);
}
</script>

<template>
  <div class="ma-mask" @pointerdown.self="emit('cancel')">
    <div class="ma-panel" role="dialog" aria-modal="true" tabindex="-1" @keydown.esc="emit('cancel')">
      <h3>{{ t('metaApply.title') }}</h3>
      <p class="ma-note faint tiny">{{ t('metaApply.note') }}</p>
      <p v-if="fileName" class="ma-file num faint" :title="fileName">{{ fileName }}</p>

      <ul class="ma-rows">
        <li v-for="r in rows" :key="r.key" class="ma-row" :class="{ off: !r.writable }">
          <label class="ma-check">
            <input
              type="checkbox"
              :checked="r.writable && !!checked[r.key]"
              :disabled="!r.writable"
              @change="toggle(r.key, r.writable)"
            />
          </label>
          <span class="ma-label">{{ r.label }}</span>
          <span class="ma-file-val" :title="r.fileValue">{{ r.fileValue || '—' }}</span>
          <span class="ma-arrow">→</span>
          <span class="ma-track-val" :class="{ empty: !r.trackValue, over: r.trackValue && r.trackValue !== r.fileValue }">
            {{ r.trackValue || t('metaApply.empty') }}
          </span>
          <span v-if="!r.writable" class="ma-tag faint">{{ t('metaApply.readOnly') }}</span>
          <span v-else-if="r.trackValue && r.trackValue !== r.fileValue" class="ma-tag warn">
            {{ t('metaApply.overwrite') }}
          </span>
        </li>
      </ul>

      <div class="ma-actions">
        <button class="chip" @click="emit('cancel')">{{ t('btn.cancel') }}</button>
        <button class="chip solid" :disabled="pickedCount === 0" @click="confirm()">
          {{ t('metaApply.confirm', { n: pickedCount }) }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ma-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
}
.ma-panel {
  width: 560px;
  max-width: calc(100vw - 40px);
  max-height: 74vh;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  box-shadow: var(--shadow);
  padding: 14px 16px 12px;
  outline: none;
}
.ma-panel h3 { margin: 0 0 4px; font-size: 13px; font-weight: 500; }
.ma-note { margin: 0 0 6px; line-height: 1.5; }
.ma-file { margin: 0 0 8px; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.ma-rows { list-style: none; margin: 0; padding: 0; }
.ma-row {
  display: grid;
  grid-template-columns: 20px 76px minmax(0, 1fr) 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 5px 2px;
  border-top: 1px solid var(--line);
  font-size: 12px;
}
.ma-row.off { opacity: 0.55; }
.ma-check { display: flex; align-items: center; }
.ma-check input { margin: 0; }
.ma-label { color: var(--dim); }
.ma-file-val, .ma-track-val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ma-track-val.empty { color: var(--dim); font-style: italic; }
.ma-track-val.over { color: var(--danger); }
.ma-arrow { color: var(--dim); text-align: center; }
.ma-tag { font-size: 11px; white-space: nowrap; }
.ma-tag.warn { color: var(--danger); }

.ma-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 12px; }
.ma-actions .chip.solid { background: var(--accent); color: #fff; border-color: var(--accent); }
.ma-actions .chip.solid:disabled { opacity: 0.5; }
</style>
