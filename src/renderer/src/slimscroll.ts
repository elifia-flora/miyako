/**
 * 全应用的细滚动条（自绘）。
 *
 * 为什么不用系统的 `::-webkit-scrollbar`：Chromium **不对滚动条伪元素做 transition**，
 * `width` 一改就是硬跳，做不出「细细的一条，鼠标靠近平滑变粗」的手感。
 * 所以这里把原生条的**视觉**藏起来（只留它占的 10px 槽位，布局一点不动），
 * 在上面用 fixed 层画自己的条：
 *
 *   常态   视觉 4px（细），热区 12px（= 3 倍，够瞄准）
 *   hover  视觉展开到 12px，transition 200ms
 *
 * 懒挂载：不在启动时遍历整棵树，而是鼠标**第一次进入**某个可滚动容器时挂上去。
 * 滚轮必然伴随指针移动，所以不会有「滚了但没条」的情况；而弹窗、词表编辑器
 * 这些按需渲染出来的容器也能自动覆盖，不用维护一张选择器清单。
 */
import { scrollForThumbDelta, thumbMetrics, thumbOffset } from '@shared/scrollbar.js';

/**
 * 热区宽度（也是 hover 展开后的视觉宽度）。常态的 4px 写在 CSS 里。
 *
 * 4 → 20 是 **5 倍**：试过 12px（3 倍），用户反馈「还是差一点」——
 * 4px 的细条要瞄准 12px 内的窄缝，手一抖就滑出去了。
 * 代价是热区向内容侧多盖 10px（原生滚动条槽只有 10px 宽），
 * 点那里会落到滚动条而不是内容上；表格文字不会贴到那么右，实测没有误触。
 */
const HOT = 20;
/** 轨道两端留白：滑块到头时不贴死在圆角上 */
const PAD = 4;

type Axis = 'y' | 'x';

interface Bar {
  track: HTMLDivElement;
  thumb: HTMLDivElement;
  /** 轨道可用长度 */
  len: number;
  /** 滑块长度 */
  size: number;
  /** 滑块可走的距离 */
  maxOffset: number;
}

interface Inst {
  el: HTMLElement;
  v: Bar;
  h: Bar;
}

const insts = new Map<HTMLElement, Inst>();
let layer: HTMLDivElement | null = null;

function makeBar(): Bar {
  const track = document.createElement('div');
  track.className = 'slim-track';
  const thumb = document.createElement('div');
  thumb.className = 'slim-thumb';
  track.appendChild(thumb);
  return { track, thumb, len: 0, size: 0, maxOffset: 0 };
}

function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.id = 'slim-layer';
  document.body.appendChild(layer);
  return layer;
}

/**
 * 全屏遮罩（弹窗 / 选项面板）开着的时候，背景那些条要藏起来 ——
 * 它们在最上层，会像浮在弹窗边上，看着像没关干净。
 */
function underModal(el: HTMLElement): boolean {
  const mask = document.querySelector('.modal-mask');
  if (!mask) return false;
  return mask.contains(el);
}

function updateThumb(inst: Inst, axis: Axis) {
  const bar = axis === 'y' ? inst.v : inst.h;
  if (bar.track.style.display === 'none') return;
  const el = inst.el;
  const vertical = axis === 'y';
  const view = vertical ? el.clientHeight : el.clientWidth;
  const content = vertical ? el.scrollHeight : el.scrollWidth;
  const pos = thumbOffset(vertical ? el.scrollTop : el.scrollLeft, content - view, bar.maxOffset);
  if (vertical) bar.thumb.style.top = `${pos}px`;
  else bar.thumb.style.left = `${pos}px`;
}

/**
 * 量一遍容器，把条摆到它的右缘 / 下缘。
 *
 * 条是 `position: fixed` 的，所以每次都按**视口坐标**重算：容器滚动不影响它的位置
 * （滚动只改滑块偏移），但窗口缩放、面板拖动、侧栏收起都会让它移动。
 */
function layoutBar(inst: Inst, axis: Axis) {
  const el = inst.el;
  const bar = axis === 'y' ? inst.v : inst.h;
  const vertical = axis === 'y';

  if (!el.isConnected || underModal(el)) {
    bar.track.style.display = 'none';
    return;
  }

  const rect = el.getBoundingClientRect();
  const view = vertical ? el.clientHeight : el.clientWidth;
  const content = vertical ? el.scrollHeight : el.scrollWidth;
  // 容器被隐藏 / 还没布局时量出来是 0，直接不画（display:none 的元素也走这条）
  if (!rect.width || !rect.height || (el as any).checkVisibility?.() === false) {
    bar.track.style.display = 'none';
    return;
  }

  const trackLen = Math.max(0, (vertical ? rect.height : rect.width) - PAD * 2);
  const m = thumbMetrics({ trackLen, viewLen: view, contentLen: content });
  if (!m) {
    bar.track.style.display = 'none';
    return;
  }

  bar.len = trackLen;
  bar.size = m.len;
  bar.maxOffset = m.maxOffset;
  bar.track.style.display = '';

  const t = bar.track.style;
  if (vertical) {
    t.top = `${Math.round(rect.top + PAD)}px`;
    t.left = `${Math.round(rect.right - HOT)}px`;
    t.height = `${trackLen}px`;
    t.width = `${HOT}px`;
    bar.thumb.style.height = `${m.len}px`;
  } else {
    t.top = `${Math.round(rect.bottom - HOT)}px`;
    t.left = `${Math.round(rect.left + PAD)}px`;
    t.width = `${trackLen}px`;
    t.height = `${HOT}px`;
    bar.thumb.style.width = `${m.len}px`;
  }
  updateThumb(inst, axis);
}

function bindBar(inst: Inst, axis: Axis) {
  const bar = axis === 'y' ? inst.v : inst.h;
  const el = inst.el;
  const vertical = axis === 'y';

  // 拖滑块
  bar.thumb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startPos = vertical ? e.clientY : e.clientX;
    const startScroll = vertical ? el.scrollTop : el.scrollLeft;
    const maxScroll = (vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth) || 0;
    const maxOffset = bar.maxOffset;

    bar.thumb.classList.add('on');
    try {
      bar.thumb.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件没有指针可捕获，靠下面的 window 监听兜底 */
    }

    const onMove = (ev: PointerEvent) => {
      const d = (vertical ? ev.clientY : ev.clientX) - startPos;
      const next = startScroll + scrollForThumbDelta(d, maxScroll, maxOffset);
      if (vertical) el.scrollTop = next;
      else el.scrollLeft = next;
    };
    const onUp = () => {
      bar.thumb.classList.remove('on');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // 点轨道空白 → 跳页（滑块自己会先吃掉事件，到这里的一定是空白处）
  bar.track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target !== bar.track) return;
    e.preventDefault();
    const r = bar.track.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, vertical ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width));
    const maxScroll = (vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth) || 0;
    if (vertical) el.scrollTop = p * maxScroll;
    else el.scrollLeft = p * maxScroll;
  });
}

function attach(el: HTMLElement): Inst | null {
  const hit = insts.get(el);
  if (hit) return hit;

  const host = ensureLayer();
  const v = makeBar();
  const h = makeBar();
  v.track.classList.add('slim-track-v');
  h.track.classList.add('slim-track-h');
  host.append(v.track, h.track);

  const inst: Inst = { el, v, h };
  insts.set(el, inst);
  /*
   * 宽度/高度**不要**写成内联样式：内联的优先级高于 `:hover` 规则，
   * 一写死就永远展不开（踩过：`:hover` 命中了、滑块还是 4px）。
   * 常态尺寸在 CSS 里（`.slim-track-v .slim-thumb { width: 4px }`），
   * 这里只负责「长度」这一半（滑块长度随内容比例变，必须内联）。
   */
  layoutBar(inst, 'y');
  layoutBar(inst, 'x');
  bindBar(inst, 'y');
  bindBar(inst, 'x');

  el.addEventListener('scroll', () => {
    updateThumb(inst, 'y');
    updateThumb(inst, 'x');
  }, { passive: true });

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      layoutBar(inst, 'y');
      layoutBar(inst, 'x');
    });
    ro.observe(el);
  }

  // 滚动条能不能拖，只看这一条：内容比视口长才需要
  return inst;
}

/** 从事件目标向上找最近的可滚动容器 */
function scrollerOf(node: EventTarget | null): HTMLElement | null {
  let el: Element | null = node instanceof Element ? node : null;
  while (el && el !== document.body) {
    if (el instanceof HTMLElement) {
      // 自己画出来的条不参与判断（否则会挂到条上）
      if (el.classList.contains('slim-track') || el.id === 'slim-layer') return null;
      const cs = getComputedStyle(el);
      const oy = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
      const ox = cs.overflowX === 'auto' || cs.overflowX === 'scroll';
      // 判定用「有没有真的溢出」，内容短就不挂（免得每个 div 都多两条隐藏的条）
      if (
        (oy && el.scrollHeight > el.clientHeight + 1) ||
        (ox && el.scrollWidth > el.clientWidth + 1)
      ) {
        return el;
      }
    }
    el = el.parentElement;
  }
  return null;
}

let lateTarget: EventTarget | null = null;
let tickTimer = 0;

export function installSlimScroll() {
  if (typeof window === 'undefined') return () => undefined;
  ensureLayer();

  // 懒挂载：目标变了才向上找，否则每次 pointerover 都要算样式
  document.addEventListener(
    'pointerover',
    (e) => {
      if (e.target === lateTarget) return;
      lateTarget = e.target;
      const el = scrollerOf(e.target);
      if (el) attach(el);
    },
    { passive: true }
  );

  /**
   * 定时兜底（400ms）：容器**位移**（拖面板、收起侧栏、改窗口大小）不会触发
   * ResizeObserver（尺寸没变），而条是按视口坐标 fixed 的，不重算就会停在原地。
   * 顺带清理已经被移出文档的实例 —— 列表换视图时容器会整块重建。
   */
  tickTimer = window.setInterval(() => {
    for (const [el, inst] of insts) {
      if (!el.isConnected) {
        inst.v.track.remove();
        inst.h.track.remove();
        insts.delete(el);
        continue;
      }
      layoutBar(inst, 'y');
      layoutBar(inst, 'x');
    }
  }, 400);

  window.addEventListener('resize', () => {
    for (const inst of insts.values()) {
      layoutBar(inst, 'y');
      layoutBar(inst, 'x');
    }
  }, { passive: true });

  return () => {
    if (tickTimer) window.clearInterval(tickTimer);
    for (const inst of insts.values()) {
      inst.v.track.remove();
      inst.h.track.remove();
    }
    insts.clear();
    layer?.remove();
    layer = null;
  };
}

/** 冒烟 / 调试用：当前挂了几个容器 */
export function slimScrollCount(): number {
  return insts.size;
}
