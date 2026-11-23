<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { templateSegments } from '@shared/titleTemplate.js';
import { applyVariable, suggestVariables } from '@shared/templateSuggest.js';

/**
 * 模板编辑器：textarea **透明文字** 盖在一层高亮镜像上。
 *
 * 不使用 contenteditable 的原因：输入法、选区、撤销栈全都要自己重做一遍；
 * 而这里只要求「变量变绿」，镜像层用同一套字体度量就能做到，caret 仍是原生行为。
 *
 * 变量补全（2026-11-23 加）也建立在这个结构上：只往 textarea 里**写字**，
 * 不接管 caret，所以输入法、撤销栈照旧。候选走 Teleport 到 body 的 fixed 层。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    rows?: number;
  }>(),
  { placeholder: '', rows: 3 }
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const taEl = ref<HTMLTextAreaElement | null>(null);
const mirrorEl = ref<HTMLElement | null>(null);

/** 打开中的候选：`active = -1` 表示只展示、没选中（此时 Enter 仍是换行） */
const sug = ref<{ items: any[]; active: number } | null>(null);
const sugPos = ref({ left: 0, top: 0, width: 240 });

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
  refreshSug();
}

function syncScroll() {
  const ta = taEl.value;
  const mirror = mirrorEl.value;
  if (!ta || !mirror) return;
  mirror.scrollTop = ta.scrollTop;
  mirror.scrollLeft = ta.scrollLeft;
}

/** 按 textarea 的屏幕位置摆候选：贴着下沿，装不下就往上翻 */
function placeSug() {
  const ta = taEl.value;
  if (!ta) return;
  const r = ta.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 200), 320);
  const left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4));
  const est = Math.min(200, (sug.value?.items.length ?? 0) * 26 + 8);
  const below = window.innerHeight - r.bottom;
  const top =
    below < est + 8 && r.top > below
      ? Math.max(4, r.top - est - 4)
      : Math.min(window.innerHeight - 40, r.bottom + 3);
  sugPos.value = { left, top, width };
}

function refreshSug() {
  const ta = taEl.value;
  if (!ta) return;
  const items = suggestVariables(ta.value, ta.selectionStart ?? ta.value.length);
  sug.value = items.length ? { items, active: -1 } : null;
  if (items.length) placeSug();
}

function closeSug() {
  sug.value = null;
}

function acceptSug(i: number) {
  const ta = taEl.value;
  const item = sug.value?.items[i];
  if (!ta || !item) return;
  const next = applyVariable(ta.value, item);
  emit('update:modelValue', next.text);
  closeSug();
  void nextTick(() => {
    ta.focus();
    ta.setSelectionRange(next.caret, next.caret);
    syncScroll();
  });
}

function onKeydown(ev: KeyboardEvent) {
  const state = sug.value;
  if (!state?.items.length) return;
  const n = state.items.length;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    closeSug();
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    state.active = state.active < 0 ? (step > 0 ? 0 : n - 1) : (state.active + step + n) % n;
    return;
  }
  // Tab / Enter 只在**真的选中了**某一项时采纳；否则 Enter 照常换行
  if ((ev.key === 'Tab' || ev.key === 'Enter') && state.active >= 0) {
    ev.preventDefault();
    acceptSug(state.active);
  }
}

watch(
  () => props.modelValue,
  () =>
    void nextTick(() => {
      syncScroll();
    })
);
</script>

<template>
  <div class="tpl-ed" :style="{ height: `${rows * 20 + 16}px` }">
    <pre ref="mirrorEl" class="tpl-mirror" aria-hidden="true"><span
      v-for="(seg, i) in templateSegments(modelValue)"
      :key="i"
      :class="{ v: seg.variable }"
    >{{ seg.text }}</span><span>​</span></pre>
    <textarea
      ref="taEl"
      class="tpl-input"
      :value="modelValue"
      :placeholder="placeholder"
      :rows="rows"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @click="refreshSug"
      @scroll="syncScroll"
      @blur="closeSug"
    />
    <!-- 变量候选：fixed 到 body，避免被「可用变量」那块挤动；mousedown.prevent 保住输入焦点 -->
    <Teleport to="body">
      <ul
        v-if="sug && sug.items.length"
        class="tpl-sug"
        :style="{ left: sugPos.left + 'px', top: sugPos.top + 'px', width: sugPos.width + 'px' }"
      >
        <li
          v-for="(s, i) in sug.items"
          :key="s.key"
          :class="{ on: i === sug.active }"
          @mousemove="sug && (sug.active = i)"
          @mousedown.prevent="acceptSug(i)"
        >
          <span class="tpl-sug-name">{{ s.label }}</span>
          <em class="tpl-sug-desc">{{ s.desc }}</em>
        </li>
      </ul>
    </Teleport>
  </div>
</template>

<style scoped>
.tpl-ed {
  position: relative;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--surface-2);
  overflow: hidden;
}
.tpl-ed:focus-within { border-color: var(--accent); }
/*
 * 镜像层与 textarea 必须**逐项**同度量：可见的字是 pre 画的，光标是 textarea 画的。
 * 任何一项不同（字重、字距、滚动条槽宽）都会让「看上去的光标」和它真正插字的位置错开。
 * 2026-11-23 的 bug：变量那段曾经是 font-weight: 500，换成无衬线字体后 500 比 400 宽，
 * 于是变量之后的文字整体右移，光标停在错位的地方 —— 变量只能用颜色区分，不许改字重。
 */
.tpl-mirror,
.tpl-input {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: 7px 9px;
  border: 0;
  border-radius: 0;
  /* 字体由选项 → 外观的「模板字体」决定（默认无衬线，可换等宽）；镜像层与 textarea 共用一个变量 */
  font-family: var(--tpl-font, var(--font-text));
  font-size: 12px;
  font-weight: 400;
  font-style: normal;
  line-height: 20px;
  letter-spacing: normal;
  word-spacing: normal;
  text-indent: 0;
  text-transform: none;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  box-sizing: border-box;
}
.tpl-mirror {
  overflow: hidden;
  color: var(--text);
  background: transparent;
  pointer-events: none;
  user-select: none;
}
/* 变量整段（含 % 与 }）只换颜色：字重 / 字距一改，光标就对不上（见上面那段注释） */
.tpl-mirror .v { color: var(--accent); }
.tpl-input {
  resize: none;
  outline: none;
  color: transparent;
  caret-color: var(--text);
  background: transparent;
  /* 原生滚动条会吃掉 ~10px 行宽：textarea 比 pre 早换行，字符位置就分家了。
     隐藏条面（仍可滚动），滚动位置由 syncScroll 灌给镜像层。 */
  scrollbar-width: none;
}
.tpl-input::-webkit-scrollbar { width: 0; height: 0; }
/* 选区的底色半透明，镜像层的绿色文字能透出来；否则一选中整段就「消失」 */
.tpl-input::selection { background: color-mix(in srgb, var(--accent) 32%, transparent); }
.tpl-input::placeholder {
  color: var(--text-faint);
  -webkit-text-fill-color: var(--text-faint);
}
</style>

<style>
/* 候选列表 teleport 到 body，scoped 样式够不着；类名带前缀避免撞上别处 */
.tpl-sug {
  position: fixed;
  z-index: 78;
  margin: 0;
  padding: 3px;
  list-style: none;
  max-height: 200px;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: var(--shadow);
}
.tpl-sug li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 7px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text);
}
.tpl-sug li.on { background: var(--sel-bg); }
.tpl-sug-name {
  font-family: var(--tpl-font, var(--font-text));
  color: var(--accent);
}
.tpl-sug-desc { font-style: normal; font-size: 10px; color: var(--text-faint); margin-left: auto; }
</style>
