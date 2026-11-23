/**
 * 应用级快捷键的白名单（纯函数，主进程与 `node --test` 共用）。
 *
 * 为什么要有这一层：
 *
 * 主窗口的快捷键是渲染层 `window.addEventListener('keydown')` 挂上的，
 * 而歌词播报器 / 网格窗口 / 图片窗口各自是独立的渲染进程 —— 焦点落在它们身上时，
 * 主窗口那个 keydown 监听**根本收不到事件**，于是「登记作品 Ctrl+R」「搜索 Ctrl+F」
 * 全都像失灵一样。
 *
 * 解法是主进程用 `webContents.on('before-input-event')` 统一抓按键再转给主窗口
 * （见 index.ts 的 `attachHotkeyForwarding`）。但主进程一旦开始 preventDefault，
 * 就会把子窗口自己需要的按键一起吃掉，所以必须有一份**明确的白名单**：
 * 只拦「主窗口才有的那几个动作」，其余（打字、方向键、Delete、Ctrl+Z）一律放行。
 *
 * 这份白名单的另一个用途是区分「要不要把主窗口抬到前台」：
 * 按空格暂停播放不该把主窗口抢到前面，按 Ctrl+R 登记作品则必须 —— 用户想操作它。
 */

/** 动作名只是给主进程做「要不要抬窗」的分流用，真正的执行仍由主窗口的原有监听完成 */
export const HOTKEY = {
  REGISTER: 'register',
  SEARCH: 'search',
  SEARCH_CLEAR: 'search-clear',
  PREFS: 'prefs',
  PANEL: 'panel',
  ZOOM_IN: 'zoom-in',
  ZOOM_OUT: 'zoom-out',
  ZOOM_RESET: 'zoom-reset',
  HELP: 'help',
  MENU: 'menu',
  PLAY_TOGGLE: 'play-toggle',
  STOP: 'stop',
};

/**
 * 会改变主窗口界面的动作：命中后把主窗口抬到前台，否则用户按完看不到任何反应。
 *
 * 播放类（空格 / Home）刻意**不在**这里 —— 一边盯歌词一边按空格暂停，
 * 主窗口突然跳到最前面是最讨厌的一种交互。
 */
export const HOTKEY_SURFACE = new Set([
  HOTKEY.REGISTER,
  HOTKEY.SEARCH,
  HOTKEY.SEARCH_CLEAR,
  HOTKEY.PREFS,
  HOTKEY.PANEL,
  HOTKEY.ZOOM_IN,
  HOTKEY.ZOOM_OUT,
  HOTKEY.ZOOM_RESET,
  HOTKEY.HELP,
  HOTKEY.MENU,
]);

/**
 * 判定一个按键该不该转发给主窗口。
 *
 * `input` 用 Electron `before-input-event` 的字段名（control / meta / shift / alt），
 * 但 `ctrl` 也认 —— 单测和渲染层写起来更顺。
 *
 * `opts.zoom === false`：子窗口自己有缩放（网格窗口的 Ctrl+= 改的是网格尺寸），
 * 这时不能再把缩放键转给主窗口，否则两边同时缩放、字号乱跳。
 */
export function matchHotkey(input, opts = {}) {
  if (!input) return null;
  const key = String(input.key ?? '');
  const code = String(input.code ?? '');
  const mod = !!(input.ctrl || input.control || input.meta);
  const shift = !!input.shift;
  const alt = !!input.alt;
  const zoom = opts.zoom !== false;

  /* Alt+字母 = 展开菜单。必须排在 Ctrl 组合之前判：
     Alt 只在没有 Ctrl 时才算，Ctrl+Alt+X 之类交给系统。 */
  if (alt && !mod && /^[a-z]$/i.test(key)) return HOTKEY.MENU;

  /* F1：帮助。带修饰键的 F1 不认 —— Shift+F1 在不少程序里另有含义，别抢。 */
  if (!mod && !shift && !alt && key === 'F1') return HOTKEY.HELP;

  /* Ctrl+Alt 组合不能当 Ctrl 用：AltGr 在欧洲键盘布局上就是这个组合，
     按 AltGr+E 打出 € 时不该顺手弹出搜索框。 */
  if (mod && !alt) {
    const k = key.toLowerCase();
    if (k === 'r' && !shift) return HOTKEY.REGISTER;
    if (k === 'f') return shift ? HOTKEY.SEARCH_CLEAR : HOTKEY.SEARCH;
    if (key === ',') return HOTKEY.PREFS;
    if (k === 'j') return HOTKEY.PANEL;
    if (zoom && (key === '=' || key === '+')) return HOTKEY.ZOOM_IN;
    if (zoom && key === '-') return HOTKEY.ZOOM_OUT;
    if (zoom && key === '0') return HOTKEY.ZOOM_RESET;
    return null;
  }

  /* 无修饰键：只有这两个「不会在输入框里被误用」的键。
     字母键、方向键、Delete、Backspace 全部不碰 —— 子窗口要拿它们做事。
     Shift+空格 是往上翻页、Alt+空格 是系统菜单，都不能抢。 */
  if (!shift && !alt && (key === ' ' || key === 'Space' || code === 'Space')) return HOTKEY.PLAY_TOGGLE;
  if (!shift && !alt && key === 'Home') return HOTKEY.STOP;

  return null;
}

/** 命中某个动作时要不要把主窗口抬到前台 */
export function needsSurface(action) {
  return HOTKEY_SURFACE.has(action);
}
