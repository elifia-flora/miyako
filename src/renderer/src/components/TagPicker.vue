<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { t } from '../i18n';
import { isComposing } from '../ime';

const props = defineProps<{ trackId: string; dim: string; label: string }>();
const emit = defineEmits<{ changed: [] }>();

const text = ref('');
const open = ref(false);
const items = ref<any[]>([]);
let timer: any = null;

/**
 * 候选框往哪开、能开多高。
 *
 * 这排标签在**详情面板下半截**，而 `.detail` 是 `overflow: auto` —— 候选框 220px 高，
 * 往下开一定被面板底边裁掉（用户看到的就是「候选被切了一半」）。所以打开前先量：
 * 下面放不下、上面更宽裕 → 改成向上开（`bottom: 26px`），并且按剩余空间收 `max-height`。
 * 「还有多少地方」要按**最近的滚动容器**算，不能按视口 —— 裁它的是 `.detail`，不是窗口。
 */
const dropUp = ref(false);
const maxH = ref(220);
const pickerEl = ref<HTMLElement | null>(null);

function place() {
  const el = pickerEl.value;
  if (!el) return;
  const ir = el.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  let p = el.parentElement;
  while (p) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY)) {
      const pr = p.getBoundingClientRect();
      top = pr.top;
      bottom = pr.bottom;
      break;
    }
    p = p.parentElement;
  }
  const below = bottom - ir.bottom - 4;
  const above = ir.top - 4 - top;
  const want = 220;
  dropUp.value = below < Math.min(want, 140) && above > below;
  maxH.value = Math.max(76, Math.min(want, dropUp.value ? above : below));
}

/** 聚焦时：先量位置再决定要不要开（`place()` 不依赖候选框 DOM，不需要等渲染） */
function onFocus() {
  place();
  open.value = !!items.value.length;
}

/** 打开就量一次；打开期间滚动/改窗口大小也要重量（否则翻页之后又跑到框外） */
watch(open, (v) => {
  if (v) {
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    void nextTick(place);
  } else {
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
  }
});
/**
 * 请求序号：晚到的响应一律丢弃。
 * 120ms 防抖不等于串行 —— 快打字时先发的请求可能后到，旧候选会盖掉新候选；
 * 此刻用户按回车，挂上去的是**另一条**标签（直接写库，没有撤销）。
 */
let seq = 0;

watch(text, (v) => {
  // ++seq 必须放在最前面（包括「清空」分支）：否则清空之后，上一次请求回来会把空输入的下拉又弹出来
  const my = ++seq;
  if (!v.trim()) {
    items.value = [];
    open.value = false;
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(async () => {
    let list: any[] = [];
    try {
      list = (await (window as any).api.tags.suggest(props.dim, v)) ?? [];
    } catch (err) {
      // 补全失败不该让输入框变成砖头：清空候选，用户还能靠「新建」那条继续
      console.error('[picker] 补全失败:', err);
      list = [];
    }
    if (my !== seq) return;          // 已经有更晚的输入发出去了
    if (text.value !== v) return;    // 双保险：值已经变了
    // 不筛掉「与输入完全一样」的那条：它就是用户要的，回车应当选中它而不是新建同名标签
    items.value = list;
    if (!open.value) place();
    open.value = true;
  }, 120);
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
});

async function pick(id: string) {
  await (window as any).api.tags.attach(props.trackId, id);
  text.value = '';
  open.value = false;
  emit('changed');
}

async function create() {
  const name = text.value.trim();
  if (!name) return;
  const id = await (window as any).api.tags.ensure(props.dim, name);
  await (window as any).api.tags.attach(props.trackId, id);
  text.value = '';
  open.value = false;
  emit('changed');
}

function onBlur() {
  setTimeout(() => (open.value = false), 150);
}

/**
 * 候选里的「光标」。列表最后还有一条「新建」，所以行数 = items + 1。
 * 默认停在第一项：敲完直接回车是「就选它」，方向键才是去挑别的。
 */
const active = ref(0);

watch(items, () => (active.value = 0));

function rowCount() {
  return items.value.length + 1;
}

function onKey(ev: KeyboardEvent) {
  // 组合期：↑↓ 是输入法翻页、Enter 是确认候选词。拦下来就会把刚上屏的字换成高亮的那条
  if (isComposing(ev)) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (!items.value.length) return;
    ev.preventDefault();
    if (!open.value) place();
    open.value = true;
    const n = rowCount();
    const step = ev.key === 'ArrowDown' ? 1 : -1;
    active.value = (active.value + step + n) % n;
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    // 这里「选中即落库」（attach 完就结束），所以不需要两段式：
    // 打全了就直接选中既有标签，不会新建一条同名的
    if (!items.value.length) {
      void create();
      return;
    }
    const it = items.value[active.value];
    if (it) void pick(it.id);
    else void create();
    return;
  }
  if (ev.key === 'Escape') open.value = false;
}
</script>

<template>
  <div ref="pickerEl" class="picker">
    <input
      v-model="text"
      :placeholder="props.label"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKey"
    />
    <ul
      v-if="open && items.length"
      class="pop"
      :class="{ up: dropUp }"
      :style="{ maxHeight: maxH + 'px' }"
    >
      <li
        v-for="(it, i) in items"
        :key="it.id"
        :class="{ on: i === active }"
        @mousemove="active = i"
        @mousedown.prevent="pick(it.id)"
      >
        <span>{{ it.display ?? it.name }}</span>
        <em>{{ t('sug.how.' + it.how) }}</em>
      </li>
      <li class="new" :class="{ on: active === items.length }" @mousedown.prevent="create()">
        {{ t('tag.create', { name: text }) }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.picker { position: relative; }
.picker input { width: 100%; height: 24px; font-size: 11.5px; }
.pop {
  position: absolute; z-index: 30; top: 26px; left: 0; right: 0;
  margin: 0; padding: 3px; list-style: none;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 4px; box-shadow: var(--shadow); max-height: 220px; overflow: auto;
}
/* 下面放不下：贴着输入框上沿往上开（见 place()） */
.pop.up { top: auto; bottom: 26px; }
.pop li {
  display: flex; justify-content: space-between; gap: 8px;
  padding: 3px 6px; border-radius: 3px; cursor: pointer; font-size: 11.5px;
}
.pop li:hover,
.pop li.on { background: var(--sel-bg); }
.pop em { color: var(--text-faint); font-style: normal; font-size: 10px; }
.pop .new { color: var(--accent); border-top: 1px solid var(--line); margin-top: 3px; padding-top: 5px; }
</style>
