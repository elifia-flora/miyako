/**
 * workspaces.ts — 窗口布局的保存与恢复。
 *
 * 记的是「窗口怎么摆」：主窗口位置大小、面板、左右栏、界面缩放、主题、泳道方案、网格缩放，
 * 以及三个子窗口（独立时间线 / 动态操作帮助 / 歌词播报器）是否开着、摆在哪。
 *
 * **刻意不记**「当前选中哪首曲子」：换个工作区就跳曲，会打断手上的活。
 * 也不记播放位置 —— 那是音频状态，不是布局。
 *
 * 为什么存在主进程：窗口的位置和大小只有主进程读得到（`win.getBounds()`），
 * 渲染层那份 localStorage 管不了窗口本身。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 渲染层负责的那部分布局（窗口内部：面板、栏宽、缩放、主题、泳道） */
export interface UiState {
  panelOpen: boolean;
  panelH: number;
  leftW: number;
  rightW: number;
  /** 左右栏是否整体收起（和各自内容块的折叠是两件事） */
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  uiZoom: number;
  themeMode: string;
  viewId: string;
  gridZoom: number;
  gridUnit: string;
}

export interface ChildState {
  open: boolean;
  bounds: Rect | null;
}

/** 独立时间线窗口：除几何，还有它内部那条泳道侧栏的宽度与开合 */
export interface GridState extends ChildState {
  sideW: number;
  sideOpen: boolean;
}

/** 动态帮助窗口：高度由内容决定，但仍记「是否置顶」 */
export interface HelpState extends ChildState {
  alwaysOnTop: boolean;
}

export interface Layout {
  v: 1;
  at: number;
  win: { bounds: Rect; maximized: boolean };
  ui: UiState;
  grid: GridState;
  help: HelpState;
  /** 历史记录窗口（v0.92 补：以前漏了，存了也恢复不回来） */
  history: ChildState;
  lyrics: ChildState & { alwaysOnTop: boolean };
  /** 桌面歌词浮窗（位置固定大小，只要 bounds） */
  overlay: ChildState;
}

interface FileShape {
  version: 1;
  last: Layout | null;
  named: Record<string, Layout>;
}

const FILE_NAME = 'workspaces.json';
/** 名字长度上限：菜单里要放得下 */
export const WS_NAME_MAX = 24;

function isRect(r: any): r is Rect {
  return (
    !!r &&
    typeof r === 'object' &&
    [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && isFinite(n)) &&
    r.width > 0 &&
    r.height > 0
  );
}

/** 容错读：外部文件可能被手改过，坏字段就当没记 */
function normalize(raw: any): Layout | null {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
  if (!raw.win || !isRect(raw.win.bounds)) return null;
  const ui = raw.ui ?? {};
  const child = (c: any): ChildState => ({
    open: !!c?.open,
    bounds: isRect(c?.bounds) ? c.bounds : null,
  });
  return {
    v: 1,
    at: Number(raw.at) || 0,
    win: { bounds: raw.win.bounds, maximized: !!raw.win.maximized },
    ui: {
      panelOpen: ui.panelOpen !== false,
      panelH: Number(ui.panelH) || 320,
      leftW: Number(ui.leftW) || 196,
      rightW: Number(ui.rightW) || 344,
      // 老文件没有这两项：默认「都展开」—— 那时候还不存在整体收起
      leftCollapsed: ui.leftCollapsed === true,
      rightCollapsed: ui.rightCollapsed === true,
      uiZoom: Number(ui.uiZoom) || 1,
      themeMode: typeof ui.themeMode === 'string' ? ui.themeMode : 'dark',
      viewId: typeof ui.viewId === 'string' ? ui.viewId : 'roman',
      gridZoom: Number(ui.gridZoom) || 1,
      gridUnit: typeof ui.gridUnit === 'string' ? ui.gridUnit : 'beat',
    },
    grid: {
      ...child(raw.grid),
      sideW: Number(raw.grid?.sideW) || 190,
      sideOpen: raw.grid?.sideOpen !== false,
    },
    help: { ...child(raw.help), alwaysOnTop: raw.help?.alwaysOnTop !== false },
    // 老文件里没有这两个窗口的记录：当成「没开」
    history: child(raw.history),
    lyrics: { ...child(raw.lyrics), alwaysOnTop: raw.lyrics?.alwaysOnTop !== false },
    overlay: child(raw.overlay),
  };
}

export class WorkspaceStore {
  private file: string;
  private data: FileShape = { version: 1, last: null, named: {} };

  constructor(dir: string) {
    this.file = path.join(dir, FILE_NAME);
    this.load();
  }

  private load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as any;
      if (!parsed || parsed.version !== 1) return;
      this.data = {
        version: 1,
        last: normalize(parsed.last),
        named: {},
      };
      for (const [name, layout] of Object.entries(parsed.named ?? {})) {
        const n = normalize(layout);
        if (n) this.data.named[name] = n;
      }
    } catch {
      /* 没文件 / 坏了：从空开始，别让启动失败 */
    }
  }

  private write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 0), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[ws] 写盘失败', e);
    }
  }

  /** 已保存的工作区名字（按名字排序，菜单里顺序稳定） */
  names(): string[] {
    return Object.keys(this.data.named).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  get(name: string): Layout | null {
    return this.data.named[name] ?? null;
  }

  getLast(): Layout | null {
    return this.data.last;
  }

  /** name 传空 = 只更新「上次布局」 */
  save(name: string, layout: Layout): boolean {
    const n = String(name ?? '').trim().slice(0, WS_NAME_MAX);
    if (!n) {
      this.data.last = layout;
      this.write();
      return true;
    }
    this.data.named[n] = layout;
    this.data.last = layout;
    this.write();
    return true;
  }

  remove(name: string): boolean {
    if (!this.data.named[name]) return false;
    delete this.data.named[name];
    this.write();
    return true;
  }

  rename(from: string, to: string): boolean {
    const n = String(to ?? '').trim().slice(0, WS_NAME_MAX);
    const src = this.data.named[from];
    if (!src || !n || this.data.named[n]) return false;
    delete this.data.named[from];
    this.data.named[n] = src;
    this.write();
    return true;
  }
}
