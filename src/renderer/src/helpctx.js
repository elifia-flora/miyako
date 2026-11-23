/**
 * 帮助窗口的上下文（主窗口 → 主进程 → 帮助窗）。
 *
 * 只有**一个**写入口，因为两边都会改它：
 *   - GridEditor 报「网格里现在是什么」（曲目 / 视图 / 选区 / 解析 / 是否在输入）
 *   - App 报「鼠标停在哪个区域」（侧边栏 / 曲目列表 / 详情 / 播放条 / 时间线）
 * 各推各的就会互相覆盖（先到的被后到的冲掉），所以合并成一份 payload、
 * 节流 120ms 后统一走 `help:push`。拖播放头时选区每帧都在变，不节流就是每帧一次 IPC。
 */
let grid = null;
let hover = null;
let timer = null;

/** 网格那边报上来的「现在」（字段见 GridEditor 的 helpSummaryNow） */
export function setGridSummary(summary) {
  grid = summary ?? null;
  schedule();
}

/** 鼠标所在的区域（没有就是 null） */
export function setHoverRegion(region) {
  const next = region || null;
  if (hover === next) return;
  hover = next;
  schedule();
}

export function getHoverRegion() {
  return hover;
}

/** 立即发一份（开窗 / 挂载时用，别等节流） */
export function publishHelpNow() {
  clearTimeout(timer);
  publish();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(publish, 120);
}

function publish() {
  try {
    // 注意：.js 文件不能写 TS 语法（`as any` 会让 rollup 直接 ParseError）
    window.api?.help?.push?.({ ...(grid ?? {}), hover });
  } catch {
    /* 锦上添花：帮助窗没开也不该影响主流程 */
  }
}
