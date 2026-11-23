<script setup lang="ts">
/**
 * MenuBar — 窗口顶部的标题行 + 应用内菜单栏
 *
 * 为什么不用 Electron 的原生 Menu：
 *   原生菜单在 Windows 上会另起一条系统样式菜单栏（或藏进标题栏），
 *   和这套深/浅色主题、字号、间距都对不上；而且我们要在菜单里显示
 *   「当前格单位」「面板是否打开」这类带勾选状态的应用内状态。
 *
 * 版式对齐 Everything 这类 Windows 软件：上面一条标题行（标记 + 项目名），
 * 下面一条菜单行。标题行高度 = titleBarOverlay 的高度，系统原生的
 * 最小化/最大化/关闭正好落在这一行里，不会压到菜单。
 *
 * 交互与桌面软件一致：点开、悬停切换、点外部关闭、Esc 关闭。
 * 带 action 的顶级项（如「选项」）点一下直接执行，不展开下拉。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { isEditableTarget } from '../ime';

export interface MenuItem {
  label?: string;
  accel?: string;
  action?: string;
  separator?: boolean;
  checked?: boolean;
  disabled?: boolean;
}
export interface MenuGroup {
  label: string;
  /** 单字母助记符：中文渲染成「文件(F)」，日文渲染成「ファイル(F)」，英文不显示 —— 西文菜单没有这个习惯 */
  mnemonic?: string;
  /** 有 action 就没有下拉：点顶层直接执行 */
  action?: string;
  items?: MenuItem[];
}

const props = withDefaults(
  defineProps<{
    menus: MenuGroup[];
    /** 只有英文不拼括号助记符（西文菜单不写 `File(F)`）；中文与日语都拼 */
    lang?: string;
    appName?: string;
  }>(),
  { lang: 'zh', appName: 'music·atlas' }
);
const emit = defineEmits<{ action: [name: string] }>();

const open = ref<number | null>(null);

/**
 * 顶级菜单要不要画括号助记符。
 *
 * 中文与日语都画（用户 2026-11-22 要求日语与中文一致），英文不画 ——
 * `File(F)` 在西文界面里是多余的信息，而在 CJK 界面里它是「Alt 键能用」的唯一提示。
 * 注意这只是**显示**：`onAltKey` 在三种语言里都能用，英文只是不把字母写出来。
 */
function topLabel(m: MenuGroup) {
  return props.lang !== 'en' && m.mnemonic ? `${m.label}(${m.mnemonic})` : m.label;
}

function toggle(i: number) {
  const m = props.menus[i];
  if (!m.items?.length) return;
  open.value = open.value === i ? null : i;
}

/** 已经有一个菜单开着时，鼠标划过别的菜单要跟着切过去 */
function hover(i: number) {
  if (open.value === null) return;
  open.value = props.menus[i].items?.length ? i : null;
}

/** 顶级点击：有 action 就直接执行（「选项」不展开下拉） */
function onTop(i: number) {
  const m = props.menus[i];
  if (m.action) {
    open.value = null;
    emit('action', m.action);
    return;
  }
  toggle(i);
}

function run(item: MenuItem) {
  if (item.disabled || !item.action) return;
  open.value = null;
  emit('action', item.action);
}

function onDocPointerDown(ev: PointerEvent) {
  if (!(ev.target as HTMLElement)?.closest?.('.chrome')) open.value = null;
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && open.value !== null) {
    open.value = null;
    ev.stopPropagation();
  }
}

/**
 * Alt+字母 直接展开对应菜单 —— Windows 用户的第一反应。
 * 括号在中日界面显示、英文界面隐藏，但**快捷键三种语言都能用**：
 * 英文里 Alt+F 一样是 File，藏起来只是不画那层括号，不是取消功能。
 */
function onAltKey(ev: KeyboardEvent) {
  if (!ev.altKey || ev.ctrlKey || ev.metaKey) return;
  // 焦点在输入框里时 Alt+字母 是用户的正常输入（部分输入法 / 组合键），不该被菜单吃掉
  if (isEditableTarget(ev.target)) return;
  const k = ev.key.toUpperCase();
  if (k.length !== 1) return;
  const i = props.menus.findIndex((m) => m.mnemonic === k);
  if (i < 0) return;
  ev.preventDefault();
  const m = props.menus[i];
  if (m.action) {
    open.value = null;
    emit('action', m.action);
  } else {
    open.value = i;
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown, true);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('keydown', onAltKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('keydown', onAltKey);
});
</script>

<template>
  <header class="chrome">
    <!-- 标题行：和 Everything 一样，上面一条写项目名，右边留给系统窗口按钮 -->
    <div class="titlebar">
      <svg class="mark" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" />
        <path d="M8 1.8v2.2M8 12v2.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      <span class="appname">{{ appName }}</span>
    </div>

    <nav class="menubar">
      <div
        v-for="(m, i) in props.menus"
        :key="m.label"
        class="menu"
        :class="{ on: open === i }"
      >
        <button class="top" @click="onTop(i)" @pointerenter="hover(i)">
          {{ topLabel(m) }}
        </button>

        <div v-if="open === i && m.items?.length" class="drop" @pointerdown.stop>
          <template v-for="(it, k) in m.items" :key="k">
            <div v-if="it.separator" class="hr" />
            <button
              v-else
              class="item"
              :class="{ disabled: it.disabled }"
              :disabled="it.disabled"
              @click="run(it)"
            >
              <span class="tick">{{ it.checked ? '✓' : '' }}</span>
              <span class="text">{{ it.label }}</span>
              <span v-if="it.accel" class="accel">{{ it.accel }}</span>
            </button>
          </template>
        </div>
      </div>
      <div class="sysgap" />
    </nav>
  </header>
</template>

<style scoped>
.chrome {
  -webkit-app-region: drag;
  user-select: none;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

/* 高度必须等于主进程 titleBarOverlay.height，系统按钮才正好落在这条里。
   和菜单行之间不画分隔线：两行是同一块顶栏，分开画会有"两条工具栏"的错觉。
   26px：字号 12 上下各 7，是还能容下系统按钮的最小值。再矮按钮会被裁 */
.titlebar {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  /* 左边距 = 菜单项的 padding-left：项目标记与「文件」的文字起点对齐成一条竖线 */
  padding: 4px 12px 0 9px;
}
.mark {
  width: 13px;
  height: 13px;
  color: var(--accent);
  flex: none;
}
.appname {
  font-size: 12px;
  /* 行高收到 1：默认行盒比字号高 4~5px，那半截空白也算在「项目名和菜单之间」，
     光调行高不动版式就能把这 2px 收回来 */
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--text-dim);
}

.menubar {
  display: flex;
  align-items: stretch;
  height: 24px;
  /* 不留左内边距：第一项自己的 padding 已经够，再加一层会让「文件(F)」离窗口边太远 */
  padding-left: 0;
}

.menu {
  position: relative;
  display: flex;
  -webkit-app-region: no-drag;
}

.top {
  padding: 0 9px;
  height: 100%;
  font-size: 12px;
  color: var(--text-dim);
  border-radius: 3px;
}
.top:hover,
.menu.on .top {
  color: var(--text);
  background: var(--surface-2);
}

.drop {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 60;
  min-width: 200px;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  box-shadow: var(--shadow);
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 24px;
  padding: 0 6px;
  font-size: 11.5px;
  color: var(--text);
  text-align: left;
  border-radius: 3px;
}
.item:hover:not(.disabled) {
  background: var(--sel-bg);
  color: var(--text);
}
.item.disabled {
  color: var(--text-faint);
  cursor: default;
}
.tick {
  flex: none;
  width: 10px;
  color: var(--accent);
  font-size: 10px;
}
.text {
  flex: 1;
  white-space: nowrap;
}
.accel {
  flex: none;
  padding-left: 18px;
  color: var(--text-faint);
  font-size: 10.5px;
}
.hr {
  height: 1px;
  margin: 4px 2px;
  background: var(--line);
}

.sysgap {
  flex: 1;
}
</style>
