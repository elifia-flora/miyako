<script setup lang="ts">
/**
 * 动态操作帮助窗口（`#help`）。
 *
 * 它接替网格底部那条说明栏：一行里塞十来个手势既读不完、又白占 26px 高度。
 * 这里分两段 ——「现在」（曲目 / 视图 / 选区 / 解析 / 正在输入）和「能做什么手势」。
 *
 * 内容全部来自主窗口 GridEditor 推上来的摘要（`api.help.push`）：
 * 这个窗口自己不读库、不持有网格状态，只负责显示。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { t } from './i18n';

const api = (window as any).api;

const summary = ref<any>(null);
const alwaysOnTop = ref(true);

/** 手势清单：分组只是为了好扫，键都在 i18n 里（中英各一份） */
const GESTURES = [
  { key: 'help.g.select', items: ['help.a.click', 'help.a.edit', 'help.a.band', 'help.a.multi'] },
  { key: 'help.g.edit', items: ['help.a.input', 'help.a.clip', 'help.a.undo', 'help.a.del'] },
  { key: 'help.g.move', items: ['help.a.move', 'help.a.edge', 'help.a.scrub'] },
  { key: 'help.g.time', items: ['help.a.section', 'help.a.sectionMenu', 'help.a.bass', 'help.a.space'] },
];

const hasSel = computed(() => !!summary.value?.sel);

/**
 * 上下文提示：**跟鼠标停的地方、以及有没有选中东西**走。
 *
 * 早期版本只有上半「现在」是动态的，下半是一整块静态说明书 ——
 * 用户在网格里选中和弦，看到的还是「单击=选中」这种早就会了的话。
 *
 * 优先级（用户定的）：输入框 > 选中记号 > 鼠标所在区域 > 通用。
 * 也就是「做事的时候不被鼠标带跑」，只有什么都没选时才跟着鼠标走。
 */
const CTX: Record<string, string[]> = {
  general: ['help.ctx.general.1', 'help.ctx.general.2', 'help.ctx.general.3'],
  sidebar: [
    'help.ctx.sidebar.1',
    'help.ctx.sidebar.2',
    'help.ctx.sidebar.3',
    'help.ctx.sidebar.4',
  ],
  library: [
    'help.ctx.library.1',
    'help.ctx.library.2',
    'help.ctx.library.3',
    'help.ctx.library.4',
  ],
  detail: ['help.ctx.detail.1', 'help.ctx.detail.2', 'help.ctx.detail.3', 'help.ctx.detail.4'],
  transport: [
    'help.ctx.transport.1',
    'help.ctx.transport.2',
    'help.ctx.transport.3',
    'help.ctx.transport.4',
    'help.ctx.transport.5',
  ],
  grid: ['help.ctx.grid.1', 'help.ctx.grid.2', 'help.ctx.grid.3', 'help.ctx.grid.4', 'help.ctx.grid.5'],
  chord: ['help.ctx.chord.1', 'help.ctx.chord.2', 'help.ctx.chord.3', 'help.ctx.chord.4', 'help.ctx.chord.5'],
  input: ['help.ctx.input.1', 'help.ctx.input.2', 'help.ctx.input.3', 'help.ctx.input.4'],
};

const ctxKey = computed(() => {
  const s = summary.value;
  if (!s) return 'general';
  // 输入框开着最优先：这时候用户最需要「Enter/Esc 是什么」
  if (s.editing !== null && s.editing !== undefined) return 'input';
  if (s.sel) return 'chord';
  const hover = typeof s.hover === 'string' ? s.hover : '';
  return hover && CTX[hover] ? hover : 'general';
});

/** 「此刻正好用得上的一招」的键：排在第一条并高亮（见模板里的 `ah-hint`） */
const HINT_HALFDIM = 'help.ctx.input.halfdim';

const ctxItems = computed(() => {
  const base = CTX[ctxKey.value] ?? CTX.general;
  // 级数行里 `h` 是半减七的缩写（iih42 → iiø42）；字母和弦没有这个约定，所以只在这一行提示。
  // **放第一条**：用户正卡在「这个和弦怎么打」上，这条比「Enter 保存」更急。
  if (ctxKey.value === 'input' && summary.value?.editLane === 'degree') {
    return [HINT_HALFDIM, ...base];
  }
  return base;
});

/** 完整手势清单默认收起：它很长，而 90% 的时候「相关的那几条」就够了 */
const showAll = ref(false);

async function toggleTop() {
  try {
    const st = await api.help.setAlwaysOnTop(!alwaysOnTop.value);
    alwaysOnTop.value = !!st?.alwaysOnTop;
  } catch (e) {
    console.error('[help] 切换置顶失败', e);
  }
}

function applyTheme(v: string) {
  document.documentElement.dataset.theme = v === 'light' ? 'light' : 'dark';
}

/* ---------- 高度跟着内容走 ----------
 * 窗口宽度固定 520，高度由这里量出来告诉主进程：
 * 内容有多少就多高（不再手定一个 350 然后靠滚动看剩下的手势）。
 * 屏幕矮的时候主进程会封顶到工作区 85%，那时才轮到窗口内滚动。
 *
 * **量的是 `.ah-inner` 而不是 `.ah-body`**。
 * `.ah-body` 是 flex:1 撑满窗口的盒子，内容比它矮时它的 `scrollHeight` 就等于它自己
 * 的 clientHeight（= 当前窗口高）—— 量它等于「用窗口高算出更高的窗口高」：
 * 每推一次摘要就长 20px（padding），一路长到屏幕 85% 才停，
 * 用户看到的就是「点一下网格，帮助窗口莫名其妙长出一大截空白」。
 * `.ah-inner` 是普通块，高度只取决于内容，跟窗口多高无关。
 */
const HEAD_H = 26;
const BODY_PAD = 20; // .ah-body 的 padding: 8 上 + 12 下
/** 最近一次发出去的内容高：避免 ResizeObserver 和 resize 之间的来回抖动 */
let lastSentH = -1;
let ro: ResizeObserver | null = null;

function syncHeight() {
  const inner = document.querySelector('.ah-inner') as HTMLElement | null;
  if (!inner) return;
  const h = Math.ceil(inner.getBoundingClientRect().height);
  if (!(h > 0)) return;
  if (Math.abs(h - lastSentH) < 2) return;
  lastSentH = h;
  try {
    void api.help?.resize?.(HEAD_H + BODY_PAD + h);
  } catch {
    /* 锦上添花：resize 失败不该影响窗口里的内容 */
  }
}

let unsubSummary: any = null;
let unsubState: any = null;
let unsubTheme: any = null;

onMounted(async () => {
  /**
   * 先向主进程**要**当前主题，别读 `document.documentElement.dataset.theme`。
   *
   * 那个属性是各窗口自己设的：这个窗口刚创建时它是 undefined → 落到默认深色。
   * 而主窗口的 `app:theme` 广播早就发过了（它排在开窗之前），这里订阅也收不到 ——
   * 结果就是浅色模式下开出来的帮助窗自己画成深色，只有系统画的标题栏是浅的。
   */
  try {
    const th = await api.app.theme();
    if (th) applyTheme(String(th));
  } catch {
    /* 拿不到就按默认（深色）显示 */
  }
  unsubTheme = api.app.onTheme((v: string) => applyTheme(v));
  unsubSummary = api.help.onSummary((s: any) => {
    summary.value = s ?? null;
  });
  unsubState = api.help.onState((st: any) => {
    if (st && typeof st.alwaysOnTop === 'boolean') alwaysOnTop.value = st.alwaysOnTop;
  });
  // 主动拉一次：窗口开得比主窗口慢时，第一条广播可能已经过去了
  try {
    const st = await api.help.state();
    if (st) alwaysOnTop.value = !!st.alwaysOnTop;
  } catch {
    /* 拿不到就按默认（置顶）显示 */
  }
  /**
   * 内容一变就重量（摘要行数会变：有选区时多「解析 / 正在输入」两行），
   * 语言切换、字体回退导致的换行也算 —— ResizeObserver 一次覆盖，
   * 不用到处 watch 那些「可能影响高度」的东西。
   */
  await nextTick();
  const inner = document.querySelector('.ah-inner');
  if (inner && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => syncHeight());
    ro.observe(inner);
  }
  // 首帧之后再补一次：字体/换行要等布局稳定，早一帧量出来会偏小
  setTimeout(syncHeight, 30);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
  unsubSummary?.();
  unsubState?.();
  unsubTheme?.();
});
</script>

<template>
  <div class="ah-root">
    <!-- 顶栏和歌词窗口同高（26px）：系统的最小化/关闭叠在右端，不压标题 -->
    <header class="ah-head">
      <span class="ah-dot" />
      <span class="ah-title">{{ t('win.helpTitle') }}</span>
      <span class="ah-grow" />
      <label class="ah-top">
        <input type="checkbox" :checked="alwaysOnTop" @change="toggleTop" />
        {{ t('help.top') }}
      </label>
    </header>

    <div class="ah-body">
      <!-- 这一层是「内容容器」：高度只跟内容走，量它才知道窗口该多高 -->
      <div class="ah-inner">
        <section class="ah-sec">
          <div class="ah-h">{{ t('help.now') }}</div>
          <p v-if="!summary" class="ah-empty">{{ t('help.empty') }}</p>
          <dl v-else class="ah-facts">
            <dt>{{ t('help.track') }}</dt>
            <dd>{{ summary.title || '—' }}</dd>
            <dt>{{ t('help.view') }}</dt>
            <dd>{{ summary.view || '—' }}</dd>
            <dt>{{ t('help.sel') }}</dt>
            <dd :class="{ 'ah-dim': !hasSel }">{{ summary.sel || t('help.none') }}</dd>
            <template v-if="summary.parsed">
              <dt>{{ t('help.parsed') }}</dt>
              <dd>{{ summary.parsed }}</dd>
            </template>
            <template v-if="summary.editing !== null && summary.editing !== undefined">
              <dt>{{ t('help.editing') }}</dt>
              <dd class="ah-mono">{{ summary.editing || '—' }}</dd>
            </template>
          </dl>
        </section>

        <!-- 跟当前上下文有关的那几条（鼠标停在哪 / 选中了什么 / 在输入什么） -->
        <section class="ah-sec">
          <div class="ah-h">
            {{ t('help.ctxTitle') }}<span class="ah-where"> · {{ t('help.region.' + ctxKey) }}</span>
          </div>
          <ul class="ah-list">
            <li v-for="k in ctxItems" :key="k" :class="{ 'ah-hint': k === HINT_HALFDIM }">{{ t(k) }}</li>
          </ul>
        </section>

        <!-- 完整清单：默认收起，点一下展开（窗口会跟着长高） -->
        <section class="ah-sec">
          <button class="ah-more" @click="showAll = !showAll">
            <span class="ah-caret">{{ showAll ? '▾' : '▸' }}</span>{{ t('help.all') }}
          </button>
          <template v-if="showAll">
            <div v-for="g in GESTURES" :key="g.key" class="ah-group">
              <div class="ah-h">{{ t(g.key) }}</div>
              <ul class="ah-list">
                <li v-for="k in g.items" :key="k">{{ t(k) }}</li>
              </ul>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ah-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--surface);
  color: var(--text);
  font-family: var(--font-ui);
  font-size: 11.5px;
  overflow: hidden;
}

.ah-head {
  /* 与主窗口标题行 / 歌词窗口同高，两个窗口并排时顶边是一条线 */
  height: 26px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
  -webkit-app-region: drag;
  user-select: none;
}
.ah-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
}
.ah-title {
  font-size: 11.5px;
  color: var(--text-dim);
  white-space: nowrap;
}
.ah-grow {
  flex: 1;
}
/* 置顶开关：在 26px 的行里要压字号，否则会把行撑高 */
.ah-top {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--text-dim);
  -webkit-app-region: no-drag;
  cursor: pointer;
}
.ah-top input {
  margin: 0;
  accent-color: var(--accent);
}

.ah-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px 12px;
  scrollbar-gutter: stable;
}

.ah-sec + .ah-sec {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.ah-h {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  margin-bottom: 5px;
}

.ah-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 8px;
  margin: 0;
}
.ah-facts dt {
  color: var(--text-faint);
  font-size: 10.5px;
  white-space: nowrap;
}
.ah-facts dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ah-dim {
  color: var(--text-faint);
}
.ah-mono {
  font-family: var(--font-mono);
  font-size: 11px;
}
/* 「· 时间线面板」这种地名跟在标题后面，小一号、更淡 */
.ah-where { color: var(--text-dim); }
/* 展开按钮：看起来像一行标题，但有可点的反馈 */
.ah-more {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 2px 0;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  text-align: left;
  cursor: pointer;
}
.ah-more:hover { color: var(--text); }
.ah-caret { font-size: 9px; line-height: 1; }
.ah-group + .ah-group { margin-top: 10px; }

.ah-empty {
  margin: 2px 0 0;
  color: var(--text-faint);
  line-height: 1.5;
}

.ah-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ah-list li {
  position: relative;
  padding: 2px 0 2px 11px;
  line-height: 1.5;
  color: var(--text-dim);
}
/*
 * 「此刻正好用得上的一招」（目前只有：级数行打 h 出半减七）。
 *
 * 用品牌绿 + 左侧竖线 + 极淡绿底 —— 一眼能从一列灰字里跳出来，
 * 又不至于像报错红条那样打断阅读。绿色取 `--accent`，深浅两套主题自动跟着变，
 * 不另写死一个「好看的绿」（那样换主题就崩）。
 */
/*
 * 「此刻正好用得上的一招」。两套皮肤，留一套、注释一套 —— 用户审阅后定。
 *
 * 方案 A（绿块 + 左侧竖线）：块状更抓眼，但和列表的其它行气质不同。
 *   对齐要点：2px 边框靠 `margin-left: -2px` 抵掉、padding 保持 11px →
 *   文字仍落在 11px，圆点仍落在 2px（`::before` 的 left 相对 padding box）。
 *
 * .ah-list li.ah-hint {
 *   color: var(--accent);
 *   background: color-mix(in srgb, var(--accent) 12%, transparent);
 *   border-left: 2px solid var(--accent);
 *   border-radius: 2px;
 *   margin: 1px 0 3px -2px;
 *   padding: 3px 6px 3px 11px;
 * }
 * .ah-list li.ah-hint::before {
 *   background: var(--accent);
 * }
 */

/* 方案 B（当前生效）：**只把字变成品牌绿**，不加块、不动竖线、不动圆点。 */
.ah-list li.ah-hint {
  color: var(--accent);
}
/* 用一个小圆点代替 li 标记：默认圆点在全角标点旁边会飘 */
.ah-list li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 0.72em;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--line-strong);
}
</style>
