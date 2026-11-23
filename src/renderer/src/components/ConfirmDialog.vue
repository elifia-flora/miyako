<script setup lang="ts">
/**
 * ConfirmDialog — 一次性确认框（破坏性动作用）
 *
 * 用于「手滑一下就会毁掉已有内容」的动作：以播放头为原点覆盖对齐、丢弃未保存的词表。
 *
 * ## 两条刻意的约定
 *
 * 1. **焦点给容器，不给按钮**。旧实现在 `onMounted` 里 focus 了确认键 ——
 *    敲一下回车就把「以播放头为原点」写进去了。现在焦点落在 `tabindex="-1"` 的弹窗上，
 *    回车什么都不做；想确认必须点一下，或 Tab 到按钮上再按。
 * 2. **危险键在左、实心红**。位置调换是为了让视线先落到「要发生什么」，
 *    红底是为了让「这件事会毁东西」在不读文字时也能看出来。
 *
 * Esc 永远是取消；空格在容器上被吃掉（否则会穿透到播放条，弹着框开始播）。
 */
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from '../i18n';

const props = defineProps<{
  title: string;
  body: string;
  /** 额外一行等宽小字（比如具体的毫秒数） */
  detail?: string;
  ok?: string;
  cancel?: string;
  /** `danger`（默认）：确认键实心红；`normal`：普通主色，用于不毁数据的确认 */
  tone?: 'danger' | 'normal';
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();

const boxEl = ref<HTMLElement | null>(null);

function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    emit('cancel');
    return;
  }
  // 空格不能漏到 window（播放条在 window 上监听）：但焦点已经在按钮上时按空格是刻意点击
  const onButton = (ev.target as HTMLElement | null)?.tagName === 'BUTTON';
  if (!onButton && (ev.code === 'Space' || ev.key === 'Enter')) {
    ev.preventDefault();
    ev.stopPropagation();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey, true);
  void nextTick(() => boxEl.value?.focus());
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div class="modal-mask" @click.self="emit('cancel')">
    <div ref="boxEl" class="modal" role="alertdialog" aria-modal="true" tabindex="-1">
      <h3>{{ props.title }}</h3>
      <p class="body">{{ props.body }}</p>
      <p v-if="props.detail" class="detail num">{{ props.detail }}</p>
      <div class="foot">
        <button class="chip" :class="props.tone === 'normal' ? 'primary' : 'danger solid'" @click="emit('confirm')">
          {{ props.ok ?? t('confirm.ok') }}
        </button>
        <button class="chip" @click="emit('cancel')">{{ props.cancel ?? t('confirm.cancel') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.modal {
  width: 400px;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  box-shadow: var(--shadow);
}
.modal:focus { outline: none; }
.modal h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.body {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim);
}
.detail {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-faint);
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 14px;
}
.chip {
  height: 24px;
  padding: 0 12px;
  font-size: 11.5px;
  color: var(--text-dim);
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
}
.chip:hover { color: var(--text); border-color: var(--line-strong); }
.chip.primary {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}
/* 危险键：实心红、略高一点 —— 弹窗里只有它一个视觉重音 */
.chip.danger {
  height: 26px;
  padding: 0 16px;
  font-weight: 500;
  color: #fff;
  background: var(--danger);
  border-color: var(--danger);
}
.chip.danger:hover { background: var(--danger-hi); border-color: var(--danger-hi); color: #fff; }
</style>
