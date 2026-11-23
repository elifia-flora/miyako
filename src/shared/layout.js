/**
 * layout.js — config.json 里 `layout` 段的归一与深合并。
 *
 * 为什么单独一个纯 JS 模块（而不是留在 `main/config.ts`）：
 *   ① 外部文件可以被手改，归一逻辑必须**严密到能单测** —— 主进程的 TS 文件
 *      在 `node --test` 里加载不了（本项目测试只吃 shared 下的 JS）；
 *   ② 归一规则只有一份：主进程读、写、合补丁都走它，不会出现「读的时候夹取了、
 *      写的时候又原样写回去」这种两套标准。
 */

/** 空布局：文件里没有 `layout` 时就是它，各窗口按默认位置开 */
export function emptyLayout() {
  return { main: {}, panels: {}, grid: {}, lyrics: {}, help: {}, history: {}, overlay: {} };
}

/** 四个数都在、且宽高为正才算一个能用的矩形 —— 0 宽的窗口没法用 */
function narrowBounds(v) {
  if (!v || typeof v !== 'object') return undefined;
  if (![v.x, v.y, v.width, v.height].every((n) => typeof n === 'number' && isFinite(n))) return undefined;
  if (v.width <= 0 || v.height <= 0) return undefined;
  return { x: Math.round(v.x), y: Math.round(v.y), width: Math.round(v.width), height: Math.round(v.height) };
}

function narrowBox(raw, extra) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const bounds = narrowBounds(raw.bounds);
  if (bounds) out.bounds = bounds;
  if (typeof raw.maximized === 'boolean') out.maximized = raw.maximized;
  if (typeof extra === 'function') extra(out, raw);
  return out;
}

/**
 * 归一一段布局：坏字段当没记，好字段照用。
 *
 * 数值**不做业务上下文的夹取**（栏宽上限跟窗口大小有关），留给用的那一侧；
 * 这里只管「类型对不对、能不能用」。
 */
export function normalizeLayout(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const panels = src.panels && typeof src.panels === 'object' ? src.panels : {};
  const out = {
    main: narrowBox(src.main),
    panels: {
      leftW: num(panels.leftW),
      rightW: num(panels.rightW),
      panelH: num(panels.panelH),
      leftCollapsed: bool(panels.leftCollapsed),
      rightCollapsed: bool(panels.rightCollapsed),
      panelOpen: bool(panels.panelOpen),
    },
    grid: narrowBox(src.grid, (o, s) => {
      o.sideW = num(s.sideW);
      o.sideOpen = bool(s.sideOpen);
    }),
    lyrics: narrowBox(src.lyrics),
    help: narrowBox(src.help),
    history: narrowBox(src.history),
    overlay: narrowBox(src.overlay),
  };
  return out;
}

/**
 * 深合并一份布局补丁：只覆盖带值的字段，其余保留。
 *
 * 只在「这一层」合并（`panels.leftW` 这种两段深度），因为布局结构就两层；
 * 写成通用递归会让人误以为支持任意深，实际上没有那种数据。
 */
export function mergeLayout(base, patch) {
  const out = normalizeLayout(base);
  if (!patch || typeof patch !== 'object') return out;
  for (const key of Object.keys(out)) {
    const inc = patch[key];
    if (!inc || typeof inc !== 'object') continue;
    out[key] = { ...out[key] };
    for (const [k, v] of Object.entries(inc)) {
      if (v === undefined || v === null) continue;
      out[key][k] = v;
    }
  }
  return normalizeLayout(out);
}
