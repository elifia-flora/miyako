import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  shell,
  type WebContents,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, resolveDataDir, type DbHandle } from './db/open';
import { loadVocab, syncVocab, type VocabSet } from './vocab/load';
import { seedFromTracks } from './import/seed';
import {
  listArchived,
  purgeAllArchived,
  purgeArchived,
  syncMissingTrackJson,
  trackIdOfAnalysis,
  trackIdOfEvent,
  trackIdOfRecording,
  writeTrackJson,
} from './import/trackjson';
import * as tracks from './ipc/tracks';
import * as tagsIpc from './ipc/tags';
import * as vocabIpc from './ipc/vocab';
import * as chordSymbols from './ipc/chords';
import * as movementMarkings from './ipc/movement';
import * as analysisIpc from './ipc/analysis';
import { HistoryStore, type HistEntry } from './history';
import { WorkspaceStore, type Layout, type Rect, type UiState } from './workspaces';
import type { LayoutConfig, LayoutPatch, WinBox } from '../shared/types';
import { ConfigStore } from './config';
import * as audioIpc from './ipc/audio';
import * as waveIpc from './ipc/wave';
import * as searchIpc from './ipc/search';
import * as neteaseIpc from './ipc/netease';
import * as mediaIpc from './ipc/media';
import * as recordingIpc from './ipc/recording';
import * as playlistsIpc from './ipc/playlists';
import { currentLocale, mt, onLocaleChange, setCurrentLocale } from './locale';
import { matchHotkey, needsSurface } from '../shared/hotkeys.js';
import { computeStartBars, formatBarBeatSub } from '../shared/barbeat.js';
import { letterFromRoman } from '../shared/chordletter.js';
import { sposobinOf } from '../shared/sposobin.js';
import { parseChord } from '../shared/chord.js';
import type { AppMeta, PlayerCommand, PlayerState, ViewDef } from '../shared/types';

/**
 * 音频走自定义协议而不是 file://：
 *   1) 渲染进程没有 nodeIntegration，也拿不到任意文件（协议只认 trackId）；
 *   2) 顺带能实现 Range，seek 才跟得上；
 *   3) 音频 URL 里不暴露真实磁盘路径。
 * 必须在 app ready 之前登记权限。
 */
protocol.registerSchemesAsPrivileged([
  /**
   * `corsEnabled` 不能省（Electron 44 / Chromium 152 起变成硬要求）。
   *
   * 渲染层是 `file://`，音频/封面是 `ma-audio://` / `ma-art://` —— 跨源。
   * 以前只写 `supportFetchAPI`，Chromium 还愿意放行；现在 fetch 会直接报
   * 「Cross origin requests are only supported for protocol schemes: …」，
   * 波形、音频时长、导出全挂。`corsEnabled` 让这个 scheme 进入 CORS 白名单，
   * 响应头再由 `audio.ts` / `media.ts` 补 `Access-Control-Allow-Origin`。
   */
  {
    scheme: 'ma-audio',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
  // 封面：只认 trackId + single/album，真实路径由数据库决定（渲染层拿不到任意文件）
  {
    scheme: 'ma-art',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/**
 * 刻意**不**调 app.setAppUserModelId()。
 *
 * 任务栏的归组规则是「先比 AUMID，再比可执行文件路径」，两端必须一致：
 * 一旦这里声明了 AUMID，而固定到任务栏的 .lnk 没有（写它得走 COM 互操作），
 * 两边身份就对不上 —— 任务栏上会出现两个图标：固定的那个和弹出来的那个。
 * start.py 的快捷方式直接指向 electron.exe，路径天然一致，让 Windows 自己归组最省事。
 * 真要自定义 AUMID，得同时改 start.py 让 .lnk 带上同名 System.AppUserModel.ID。
 */

let win: BrowserWindow | null = null;
/** 歌词播报器（普通听众的窗口）与桌面歌词浮窗 */
let lyricsWin: BrowserWindow | null = null;
let overlayWin: BrowserWindow | null = null;
/** 图片查看窗口（封面大图）。同一时刻只开一个 */
let imageWin: BrowserWindow | null = null;
/** 歌词播报器是否置顶。默认开 —— 这窗口就是给听众盯着看的，压住了就没意义 */
let lyricsAlwaysOnTop = true;
/**
 * 动态操作帮助窗口（选区摘要 + 手势清单）。
 *
 * 它替代了网格底部那一条说明栏：说明栏既占高度、又要在一行里塞十来个手势，
 * 现在挪进独立窗口，主窗口切回操作时也能看（默认置顶）。
 * 尺寸 = 歌词播报器的 1/4 面积（1040×700 → 520×350）。
 */
/**
 * 帮助窗口的宽度（**CSS 像素**，不是屏幕像素）。
 *
 * 渲染层按这个宽度排版，主进程再乘上缩放因子设物理尺寸 —— 见 `fitHelpWindow()`。
 */
const HELP_W = 520;
let helpWin: BrowserWindow | null = null;
/**
 * 渲染层报上来的**内容高度（CSS 像素）**。
 *
 * 换算成物理尺寸要乘缩放因子：`setZoomFactor(1.25)` 之后 CSS 视口只有
 * 物理尺寸的 1/1.25，所以「内容 300 CSS 高」必须给 375 的物理高 ——
 * 直接 `setContentSize(520, 300)` 会让 300 的物理高只剩 240 CSS，内容被裁掉一截，
 * 这正是「放大之后有些内容看不到了」的原因。
 */
let helpCssH: number | null = null;
/**
 * 上一次**真正下发**的物理尺寸（宽, 高）。
 *
 * 去重不能拿 `helpWin.getContentSize()` 比：窗口还没 show 的时候它可能返回 `[0,0]`，
 * 也可能已经反映出「设了但渲染层没采纳」的尺寸 —— 两种都会让去重判断失真：
 * 前者每次都重设（无害），后者直接**吞掉**一次真实请求，而渲染层那边记着「我已经报过了」，
 * 于是窗口永远停在旧高度（表现就是「内容变高了，窗口没长」）。窗口新建时置空。
 */
let helpApplied: { w: number; h: number; z: number } | null = null;
let helpAlwaysOnTop = true;
/** 最近一次推送来的上下文摘要：窗口重开时补发一份，不必等下一次选区变化 */
let helpSummary: any = null;
let handle: DbHandle;
let vocab: VocabSet;
let dataDir = '';
let assetsDir = '';
/** 启动配置：userData/config.json。窗口自动打开策略以它为准，渲染层的偏好只是界面副本 */
let configStore: ConfigStore | null = null;
/**
 * 播放中枢的当前状态。
 * 主窗口是**唯一**的音频宿主，其他窗口只读这里的状态、只发指令 ——
 * 各自持一个 <audio> 同时播就是双声道重音，而且两边进度会漂。
 */
/** 主窗口是否已经「完全启动」（渲染层报过 win:app-ready）。歌词窗口等它 */
let mainAppReady = false;

let playerState: PlayerState = {
  trackId: null,
  title: null,
  sourceMode: 'none',
  playing: false,
  currentMs: 0,
  durationMs: 0,
  ready: false,
  gain: 1,
};

/** 操作历史（撤销/重做）的唯一真相，等 data 目录确定后再构造 */
let historyStore: HistoryStore | null = null;

/** 工作区（窗口布局快照）与独立网格窗口的引用 */
let wsStore: WorkspaceStore | null = null;
let gridWin: BrowserWindow | null = null;
/**
 * 独立时间线窗口里那条泳道侧栏的宽度与开合。
 *
 * 主进程读不到另一个渲染进程的状态，而「保存工作区」是在主进程抓的 ——
 * 所以由那个窗口在上报 config.json 时顺手报一份，这里缓存着。
 */
let lastGridSide = { sideW: 190, sideOpen: true };
/** 独立窗口上次打开的曲目：工作区要把它重新拉起来，但布局里不记「当前选中」 */
let lastGridTrackId: string | null = null;

/** 历史窗口（列表 + 点条目跳回去） */
const HIST_W = 520;
let historyWin: BrowserWindow | null = null;

/** 给渲染层的历史快照（不带 events） */
function historyStateNow() {
  return historyStore
    ? {
        items: historyStore.list(),
        cursors: historyStore.cursors,
        globalCursor: historyStore.globalCursor,
        can: historyStore.canGlobal(),
      }
    : { items: [], cursors: {}, globalCursor: 0, can: { undo: false, redo: false } };
}

/** 历史变了：通知所有窗口刷新列表与按钮状态（不带 events，过桥省事） */
function broadcastHistory() {
  if (!historyStore) return;
  broadcast('history:changed', historyStateNow());
}

/**
 * 把「历史应用」的结果告诉渲染层：
 *   - 数据变了 → 主窗口刷新（网格重拉事件、详情面板跟着变）
 *   - 落在别的曲子上 → 主窗口切过去（否则改了数据用户也看不见）
 */
function announceApplied(item: HistEntry | null) {
  if (!item) return;
  broadcastHistory();
  sendTo(win, 'history:applied', { analysisId: item.analysisId, trackId: item.trackId, seq: item.seq });
}

/** 桌面歌词样式（渲染层持久化在 localStorage，这里只做跨窗口中转） */
let lyricStyle = { size: 34, opacity: 0.95, color: 'white', next: true };

/**
 * 单实例锁：必须在 whenReady 之前拿。
 *
 * 没有它的时候，双击几次 start.cmd 就会起几个实例 —— 每个都开窗口、每个都握一份 SQLite 连接。
 * 后来者直接退出，并把已有窗口抬到前台。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
bootLog(`lock=${gotSingleInstanceLock} argv=${process.argv.slice(1).join(' ')}`);
if (!gotSingleInstanceLock) app.quit();

/* ==================== 冒烟模式（--smoke） ==================== */

/**
 * 是否在跑冒烟。**必须放在文件最前面**：
 *  - `app.commandLine` 的开关要在 ready 之前加（越早越算数）；
 *  - `createWindow()` / `openOverlayWindow()` 里的窗口设置要读它，
 *    而 `const` 的 TDZ 是按**执行顺序**算的 —— 定义在文件末尾、
 *    函数在 ready 里调用虽然也能跑，但读代码的人会以为拿不到值。
 */
const SMOKE_MODE = process.argv.includes('--smoke');
/**
 * 调试用的逃生阀：`MA_SMOKE_VISIBLE=1 npm run smoke` 时不把窗口弄成透明。
 * 用环境变量而不是命令行开关 —— Chromium 会把不认识的开关解析掉（这个坑踩过）。
 * 穿透仍然保留：能看，但点不进去，测试照旧不会被误触。
 */
const SMOKE_VISIBLE = process.env.MA_SMOKE_VISIBLE === '1';
/**
 * 安静模式：只打 FAIL 和汇总，不把 386 条 PASS 连同 JSON payload 全倒出来。
 * 一轮完整输出约 10 万字符 —— 查回归时真正有用的只有失败项和「N/N 通过」。
 * 完整清单仍写 `shots/smoke-report.txt`，要翻证据随时能翻。
 * 入口：`npm run smoke:quiet`（`tools/smoke.mjs --quiet`）。
 */
const SMOKE_QUIET = process.env.MA_SMOKE_QUIET === '1';
if (SMOKE_MODE) {
  /**
   * 冒烟会真的播放音频（播放头、波形、跟随选中都要靠它），声音会从系统默认设备出来 ——
   * 跑一次测试就把人从正在听的东西上打断。`mute-audio` 只关输出，播放/时钟照常走，
   * 所以断言完全不受影响。
   */
  app.commandLine.appendSwitch('mute-audio');
  /**
   * **被别的窗口遮住也不许停帧。**
   *
   * Chromium 对「完全被遮挡的窗口」会停掉 requestAnimationFrame 来省电。用户自己那份
   * `npm run app` 窗口盖在冒烟窗口上时，就会看到一整片假回归：重绘次数 0、`playing` 一直是 false、
   * 选区动画 `fadeMid/fadeEnd = 0`、浅色切换后像素没变……（2026-10-26 一次红了 22 条，20 分钟前刚全绿）。
   * 这两个开关让渲染进程不因遮挡/后台而降频 —— 测试的正确性不该取决于窗口谁在上面。
   */
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  /**
   * **Windows 上别算「这个窗口被挡住了」。**
   *
   * 冒烟窗口现在 `opacity=0`，DWM 不合成它 —— Chromium 的原生遮挡计算就会把它
   * 判成 occluded，于是：`setTimeout/setInterval` 降频（拖到边缘自动滚动 700ms 一点没动）、
   * 依赖合成帧的 pointer 命中（拖动播放头选不中）、`sendInputEvent` 投不进去
   * （歌词窗的快捷键转发两条）。
   * 2026-10-26 实测：加 opacity 之后这 4 条稳定红，退回不透明就全绿 —— 根因是遮挡判定，
   * 不是坐标（`.tools/coord-probe.js` 对比过：DPR / 视口 / 元素坐标 / elementFromPoint 两档完全一致）。
   * 关掉遮挡计算，窗口「看不见」但 Chromium 认定它一直可见。
   */
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  /** 定时器也别降频（上面那条治的是「判定遮挡」，这条治「后台」这条腿） */
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

/**
 * 冒烟窗口不许打扰用户，也不许被用户误碰。
 *
 * 三件事，缺一不可：
 *  1. `setIgnoreMouseEvents(true, { forward: true })` —— **鼠标整个穿透**。
 *     人手的任何点击都会落到下面那个窗口，冒烟窗口一个事件都收不到。
 *     冒烟里要鼠标的地方走 `executeJavaScript` 合成事件和 `elementFromPoint`，
 *     那是 DOM 层的事，不需要真光标在窗口里。
 *     （顺带治了一个老 flake：真人鼠标的 `pointerover` 会盖掉合成的那次，
 *     于是「悬停侧边栏 → 提示换成侧边栏」偶尔读到「播放条」。）
 *  2. `setFocusable(false)` —— **不抢键盘焦点**。冒烟跑着的时候你在别的窗口打字，
 *     字不会跑进测试窗口；测试也不会因为窗口意外获得/失去焦点而改状态。
 *  3. `setSkipTaskbar(true)` —— 不进任务栏、不进 Alt-Tab，切窗口时不会手滑点到它。
 *
 * **故意不碰 `setAlwaysOnTop`**：帮助窗默认置顶、歌词窗可切置顶，这些是**被测行为本身**
 * （冒烟里有断言直接 `helpWindow.isAlwaysOnTop() === true`）。用改层级来「不打扰」，
 * 等于把测试的对象改掉了 —— 那样测试再绿也没有意义。
 */
function quietWindow(w: BrowserWindow | null | undefined) {
  if (!SMOKE_MODE || !w || w.isDestroyed()) return;
  try {
    w.setSkipTaskbar(true);
    w.setFocusable(false);
    // 不加 forward：冒烟的悬停全部是 executeJavaScript 合成事件；forward 会把
    // 真鼠标的移动继续喂给页面，反而让 pointerover 盖掉合成的那次（老 flake 的根因）。
    w.setIgnoreMouseEvents(true);
    /**
     * **连看都看不见**（用户的原话是「像听不到声音一样，也看不到」）。
     *
     * `opacity = 0` 是唯一两头都占的做法：窗口仍然「可见」（`isVisible()` 为真、不进
     * 「隐藏窗口」那条路径），所以 rAF 不停、`capturePage` 照常出图 —— 截图类断言一条都不受影响。
     * 实测：opacity 0 / 0.01 / 1 三档的帧数（700ms 内 42 帧）和截图像素量完全一致
     * （`.tools/opacity-probe.js`）。换成 `win.hide()` 或挪到屏幕外就完全不同了：
     * 前者 Chromium 会真的停帧，后者的窗口会被系统钳回来。
     *
     * Windows 上 `setOpacity` 对**还没显示**的窗口无效（静默），所以这里之外，
     * 主窗口在 `ready-to-show` 里还会在 `show()` 之前再设一次，免得闪一下才透明。
     */
    if (!SMOKE_VISIBLE) w.setOpacity(0);
  } catch {
    /* 窗口正在销毁，或平台不支持：沙箱是「让测试更好跑」，不该因为它的异常把测试搞挂 */
  }
}

/**
 * 冒烟窗口是鼠标穿透的、任务栏里也没有 —— 所以万一卡住，**用户点不动它**，只能开任务管理器。
 * 给它一条自尽的死线（正常一轮约 3 分钟，8 分钟已经是异常）。
 * 实际执行在 `tools/smoke.mjs`（那里才拿得到子进程句柄），这里只放常量。
 */
const SMOKE_HARD_TIMEOUT_MS = 8 * 60 * 1000;

function loadViews(dir: string): ViewDef[] {
  const viewsDir = path.join(dir, 'views');
  if (!fs.existsSync(viewsDir)) return [];
  return fs
    .readdirSync(viewsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(viewsDir, f), 'utf8')) as ViewDef)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function buildMeta(): AppMeta {
  const { db } = handle;
  const trackCount = (db.prepare(`SELECT COUNT(*) c FROM track WHERE deleted_at IS NULL`).get() as any).c;
  const tagCount = (db.prepare(`SELECT COUNT(*) c FROM tag`).get() as any).c;
  return {
    dataDir,
    dbPath: handle.dbPath,
    trackCount,
    tagCount,
    views: loadViews(dataDir),
    vocabs: vocab.dims.map((dim) => {
      const nodes = vocab.byDim.get(dim) ?? [];
      return { dim, count: nodes.length, roots: nodes.filter((n) => !n.parentId).length };
    }),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };
}

function boot() {
  dataDir = resolveDataDir();
  // 素材目录（歌词 .lrc 与示例封面）：开发时就在仓库根，打包后跟着资源走
  assetsDir = path.join(app.getAppPath(), 'assets');
  handle = openDb();
  vocab = loadVocab(dataDir);

  const sync = syncVocab(handle.db, vocab);
  console.log(`[vocab] ${sync.tags} 标签 / ${sync.edges} 边 / ${sync.aliases} 别名`);

  const seeded = seedFromTracks(handle.db, dataDir, vocab);
  if (seeded.imported.length) console.log(`[seed] 导入 ${seeded.imported.join(', ')}`);
  if (seeded.skipped.length) console.log(`[seed] 已存在跳过 ${seeded.skipped.length} 首`);
  // 同名老档案撞车：后来那份换了新 id 并写回文件。这条日志很重要 ——
  // 撞车本身没有任何界面提示，只在「库里多出一首同名曲目」时才看得见。
  if (seeded.healed.length) {
    console.log(`[seed] 同名撞车，已换新 uuid 并写回：${seeded.healed.join(', ')}`);
  }

  /**
   * 重算派生数据：解析器版本变了就把库里所有 `parsed` 重算一遍。
   * **必须晚于 seed** —— seed 按当前解析器写新行，先重算等于白算。
   * 失败不能拦住启动（和弦详情是锦上添花），但要在日志里留名。
   */
  try {
    const n = analysisIpc.backfillParsed({ db: handle.db });
    if (n) console.log(`[chord] 旧解析结果已回填 ${n} 条`);
  } catch (err) {
    console.error('[chord] 解析结果回填失败：', err);
  }

  /**
   * 补齐缺口：库里有、`data/tracks` 里没有的曲目补一份 JSON。
   *
   * 以前只有「登记作品」不落盘这一条缺口，现在是「任何绕过 IPC 的写库」都不落盘
   * （手工 SQL、导入脚本、崩溃后重启）。缺口不会报错，只会在下次重建库时少几首 ——
   * 所以每次启动都扫一遍，十几条曲目的代价可以忽略。
   */
  try {
    const filled = syncMissingTrackJson({ db: handle.db, dataDir });
    if (filled.length) console.log(`[json] 补齐 ${filled.length} 份曲目 JSON：${filled.join(' / ')}`);
  } catch (err) {
    console.error('[json] 启动补齐失败：', err);
  }
}

/* ==================== 子窗口：歌词播报器 / 桌面歌词 ==================== */

/** 同一个渲染层，靠 hash 路由：#lyrics / #overlay / #grid */
function loadHash(w: BrowserWindow, hash: string) {
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    void w.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
  }
}

/**
 * 界面主题（dark / light）。主窗口是唯一来源，切主题时广播给所有子窗口 ——
 * 子窗口各有独立的 <html>，localStorage 不同步、storage 事件跨窗口也不可靠。
 */
let appTheme: 'dark' | 'light' = 'dark';
/** 主题模式：dark / light / system / timed */
let appThemeMode = 'dark';

/**
 * 安全地往某个窗口发消息。
 *
 * `win?.webContents.send(...)` 里的 `?.` 只挡 null，**不挡「对象已销毁」** ——
 * 窗口关了但模块级引用还在，webContents.send 会抛 TypeError: Object has been destroyed，
 * 而且是在 IPC 回调里抛的，会变成 uncaughtException 把主进程带崩。
 * 主窗口关掉的瞬间正好有歌词窗口在加载，必踩。
 */
function sendTo(w: BrowserWindow | null | undefined, channel: string, payload?: unknown): void {
  if (!w || w.isDestroyed()) return;
  try {
    if (payload === undefined) w.webContents.send(channel);
    else w.webContents.send(channel, payload);
  } catch {
    /* 窗口正在销毁 */
  }
}

/** 给除自己以外的所有窗口发消息（主窗口不订阅 player:state，多发一份没有副作用） */
function broadcast(channel: string, payload: unknown, except?: BrowserWindow | null) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === except || w.isDestroyed()) continue;
    try {
      w.webContents.send(channel, payload);
    } catch {
      /* 窗口正在销毁 */
    }
  }
}

/**
 * 主窗口没了，子窗口必须跟着走。
 *
 * 以前主窗口 `closed` 只打一条日志：歌词播报器 / 桌面歌词 / 帮助 / 历史 / 独立网格
 * 都还挂着，界面在、但所有 IPC 的另一端（音频宿主、选中状态）已经没了 ——
 * 看起来就是「窗口还在，点哪儿都没反应」。而且 `window-all-closed` 永远不触发，
 * 进程也不会退。所以这里统一级联关闭，并且**只关主窗口之外的窗口**：
 * 未来万一再加子窗口，也不用记得逐个补。
 */
function closeChildWindows() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === win || w.isDestroyed()) continue;
    try {
      w.close();
    } catch {
      /* 正在销毁的窗口 close() 会抛，忽略即可 */
    }
  }
}

/** 主窗口销毁之后，任何「再开一个子窗口」的入口都该拒绝：没有宿主，开了也是死的 */
function hasMainWindow(): boolean {
  return !!win && !win.isDestroyed();
}

/* ==================== 快捷键跨窗口转发 ==================== */

/**
 * 主窗口的快捷键是渲染层挂在 `window` 上的 keydown 监听。
 * 焦点在歌词播报器 / 网格窗口 / 图片窗口时，那些监听**根本收不到事件** ——
 * 「Ctrl+R 登记作品在歌词窗口里没反应」就是这么来的，不是键位失灵。
 *
 * 做法：主进程用 `before-input-event` 在所有**子窗口**上截按键，命中白名单
 * （shared/hotkeys.js）就 preventDefault 再转给主窗口。主窗口收到后还原成
 * 一个真的 KeyboardEvent 派发回自己的 window —— 于是登记 / 搜索 / 缩放 / Alt 菜单
 * 全都走原来那一套实现，一条都不需要重写。
 *
 * 三个必须守住的边界：
 *  1. 主窗口自己不挂 —— 它已经处理过了，再转一次就是双触发（Ctrl+R 弹两次）。
 *  2. 子窗口正在输入时要放行（下面的 editingWcIds）：preventDefault 是把按键**吃掉**，
 *     编辑歌词那一行时按空格打不出空格，比快捷键失灵更让人火大。
 *  3. 只有「会改主窗口界面」的动作才把主窗口抬到前台。按空格暂停播放时
 *     主窗口突然蹦到最前面，是最讨厌的一种交互。
 */
const editingWcIds = new Set<number>();

function raiseMain() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * @param opts.zoom 子窗口自己有缩放时传 false。
 *   网格窗口的 Ctrl+= 改的是网格尺寸，转给主窗口会两边同时缩放、字号乱跳。
 */
function attachHotkeyForwarding(w: BrowserWindow, opts: { zoom?: boolean } = {}) {
  const wc = w.webContents;
  wc.once('destroyed', () => editingWcIds.delete(wc.id));
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (editingWcIds.has(wc.id)) return;
    const action = matchHotkey(
      { key: input.key, code: input.code, control: input.control, meta: input.meta, shift: input.shift, alt: input.alt },
      { zoom: opts.zoom }
    );
    if (!action) return;
    event.preventDefault();
    if (needsSurface(action)) raiseMain();
    sendTo(win, 'app:hotkey', {
      action,
      key: input.key,
      code: input.code,
      ctrl: !!(input.control || input.meta),
      shift: !!input.shift,
      alt: !!input.alt,
    });
  });
}

function refreshLyricsTitle() {
  if (!lyricsWin || lyricsWin.isDestroyed()) return;
  lyricsWin.setTitle(playerState.title ? mt('win.lyricsTitleWith', { title: playerState.title }) : mt('win.lyricsTitle'));
}

/**
 * 歌词窗口顶栏的高度（= `.lp-header` 的 CSS 高度）。
 *
 * 必须和 `titleBarOverlay.height` 一模一样：系统的最小化/最大化/关闭 是按这个高度
 * 居中画的，差几像素按钮就会比顶栏高出一截，看着像贴错了位置。
 */
const LP_TITLE_H = 26;

/**
 * 主窗口标题行的高度 = `.titlebar` 的 CSS 高度（26）。
 *
 * `titleBarOverlay.height` 决定系统按钮画多高：比这一行高，按钮会溢出到菜单行上；
 * 比它矮则有空隙。以前创建时写 26、切主题时写 32，于是「换一次主题按钮就长高一截」。
 */
const MAIN_TITLE_H = 26;

/**
 * 系统窗口按钮的配色（主窗口由渲染层推过来，子窗口创建时得先自己算一份）。
 *
 * 和 App.vue 里 `OVERLAY_COLORS` 保持同一组值：两边不一致的话，切主题时
 * 主窗口按钮已经变浅、歌词窗口那三个还是深的，两个窗口并排一眼就看出来。
 */
function overlayChrome() {
  return appTheme === 'light'
    ? { color: '#ffffff', symbolColor: '#3a3a37' }
    : { color: '#1c1c1a', symbolColor: '#c9c9c4' };
}

/**
 * 把所有窗口的「系统按钮」重刷一遍。
 *
 * 窗口各自在创建时拿一份 `overlayChrome()`，之后主题再变、再开新窗，就没人管旧窗口了 ——
 * 表现是深色窗口右上角留一块浅色按钮底（或者反过来，浅色窗口上是浅色按钮，几乎看不见）。
 * 所以主题一变就从这里统一刷，而不是等各个渲染层记得调 `win:overlay`。
 */
function refreshAllOverlays() {
  const chrome = overlayChrome();
  const paint = (w: BrowserWindow | null | undefined, h: number) => {
    if (!w || w.isDestroyed()) return;
    try {
      w.setTitleBarOverlay({ ...chrome, height: h });
    } catch {
      /* 非 Windows / 不是 overlay 窗口 */
    }
  };
  paint(win, MAIN_TITLE_H);
  paint(lyricsWin, LP_TITLE_H);
  paint(helpWin, LP_TITLE_H);
  paint(historyWin, LP_TITLE_H);
}

/**
 * 子窗口加载完，先把「现在生效的主题」告诉它。
 *
 * `app:theme` 只在**切换**时广播；子窗口比主窗口晚开，那条早就发过了 ——
 * 只订阅不主动问，窗口就会用自己那份默认色（深色）画一遍。
 * 渲染层各自也会 `api.app.theme()` 拉一次，这里是兜底。
 */
function primeChildTheme(w: BrowserWindow | null | undefined) {
  sendTo(w, 'app:theme', appTheme);
}

/** 主窗口当前的界面缩放（Ctrl+= / − 改的就是它） */
function mainZoomFactor(): number {
  try {
    return win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1;
  } catch {
    return 1;
  }
}

/**
 * 子窗口照抄主窗口的缩放。
 *
 * 不抄的话：主窗口放大到 150%，歌词窗口还是 100%，两个窗口的字号差一大截 ——
 * 而这两个窗口本来就是要并排看的。
 */
function matchMainZoom(w: BrowserWindow | null, z = mainZoomFactor()) {
  if (!w || w.isDestroyed()) return;
  try {
    w.webContents.setZoomFactor(z);
  } catch {
    /* 窗口正在销毁 */
  }
}

/**
 * 主窗口缩放变了之后，把所有「读内容」的子窗口一起改。
 *
 * 以前只在开窗那一刻抄一次，而且改缩放时只通知了歌词窗口 ——
 * 于是主窗口按 Ctrl+= 放大后，帮助窗、历史窗、独立时间线窗全是原尺寸。
 * **以后新开任何窗口都要接进来**：新窗口创建时 `matchMainZoom(w)`，缩放变化时靠这里。
 *
 * 桌面歌词（`#overlay`）故意不跟：它 `height: 100vh` 贴满整块屏幕，
 * 缩放会让它只占屏幕的一半，位置和拖动都对不上。
 */
function applyZoomToChildren(z = mainZoomFactor()) {
  for (const w of [lyricsWin, helpWin, historyWin, gridWin]) matchMainZoom(w, z);
  // 帮助窗是**唯一**「窗口边界也跟缩放走」的窗口（见 fitHelpWindow）：
  // 缩放变了它得重新算物理尺寸，否则内容会被裁掉一截。
  // 把 z 直接传进去：`setZoomFactor` 之后立刻 `getZoomFactor()` 不保证已经是新值。
  fitHelpWindow(false, z);
}

/**
 * 帮助窗当前的缩放因子（拿不到就当 1）。
 *
 * 单独抽出来是为了跟 `mainZoomFactor()` 分开：别的窗口只跟「字号」，
 * 帮助窗还要按它算**物理边界**，两个值在窗口刚建/正在销毁时可能短暂不一致。
 */
function helpZoom(): number {
  if (!helpWin || helpWin.isDestroyed()) return 1;
  try {
    const z = helpWin.webContents.getZoomFactor();
    return Number.isFinite(z) && z > 0 ? z : 1;
  } catch {
    return 1;
  }
}

/**
 * 把窗口整体推回显示器工作区（只移动，不改尺寸）。
 *
 * 用户定的是「不锚定，但必须留在屏幕内」：手动拖过窗口的人不该被强行归位，
 * 但内容变高/缩放变大之后窗口长出屏幕就没意义了 —— 那时才动手。
 */
function keepInsideWorkArea(w: BrowserWindow) {
  try {
    const b = w.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    let x = b.x;
    let y = b.y;
    if (b.x + b.width > area.x + area.width) x = area.x + area.width - b.width;
    if (b.y + b.height > area.y + area.height) y = area.y + area.height - b.height;
    if (b.x < area.x) x = area.x;
    if (b.y < area.y) y = area.y;
    if (x !== b.x || y !== b.y) w.setPosition(Math.round(x), Math.round(y));
  } catch {
    /* 窗口正在销毁 */
  }
}

/**
 * 按「渲染层量出来的内容高 × 缩放因子」设窗口物理尺寸 —— **帮助窗专有**。
 *
 * 为什么只有这个窗口要改物理尺寸：
 * - 独立时间线 / 历史窗里是可滚动列表，放大后内容窄一点、长一点无所谓，窗内滚就行；
 * - 帮助窗是「装下全部内容」的告示板（高度跟着内容走），窗口不变大就等于内容被裁掉。
 *
 * 关键点：**宽度也要乘缩放**（`HELP_W * z`）。
 * 这样 CSS 视口始终是 520×内容高 —— 排版跟 100% 时一模一样，只是整体变大。
 * 只加高度不乘宽度的话，CSS 视口会变成 520/z 宽，文字全被挤成两行、越放大越糟。
 */
function fitHelpWindow(force = false, zOverride?: number) {
  if (!helpWin || helpWin.isDestroyed()) return false;
  const z = typeof zOverride === 'number' && zOverride > 0 ? zOverride : helpZoom();
  const cssH = helpCssH;
  if (cssH == null) return false; // 渲染层还没量过，先别乱动
  let area: Electron.Rectangle;
  try {
    area = screen.getDisplayMatching(helpWin.getBounds()).workArea;
  } catch {
    return false;
  }
  // 封顶 85% 工作区：屏幕矮的时候装不下就在窗内滚动，别把窗口顶出屏幕。
  // 下限 240 CSS 高（×z 换成物理高）：内容极短时窗口也别缩成一个条
  const maxH = Math.max(240, Math.round(area.height * 0.85));
  const wantH = Math.max(Math.round(240 * z), Math.min(maxH, Math.round(cssH * z)));
  const wantW = Math.round(HELP_W * z);
  if (
    !force &&
    helpApplied &&
    Math.abs(helpApplied.h - wantH) <= 2 &&
    Math.abs(helpApplied.w - wantW) <= 2 &&
    Math.abs(helpApplied.z - z) < 0.001
  ) {
    return false;
  }
  helpApplied = { w: wantW, h: wantH, z };
  try {
    helpWin.setContentSize(wantW, wantH);
  } catch {
    return false;
  }
  keepInsideWorkArea(helpWin);
  return true;
}


/**
 * 歌词播报器该出现在哪：主窗口**旁边**，绝不压住它。
 *
 * 为什么不能简单「主窗口右边 + 间距」：超宽屏上主窗口往往已经贴着右边，
 * 右边放不下就只能退到左边；两边都放不下（主窗口很宽）就只能压上去 ——
 * 那还不如让窗口窄一点。这台机器 3440×1400、主窗口 1800 宽，
 * 右侧只剩约 800px，所以这里会按可用宽度收窄窗口，而不是硬挤或重叠。
 */
function placeLyricsWindow(w: BrowserWindow) {
  const main = win && !win.isDestroyed() ? win.getBounds() : null;
  const area = screen.getDisplayMatching(main ?? screen.getPrimaryDisplay().bounds).workArea;
  const gap = 12;
  const maxH = area.height - 40;
  const height = Math.min(700, maxH);

  /** 尽量按请求宽度开，但不许越过工作区 */
  const fit = (want: number) => Math.max(640, Math.min(want, area.width - 40));

  if (main) {
    const rightSpace = area.x + area.width - (main.x + main.width) - gap;
    const leftSpace = main.x - area.x - gap;
    const width = fit(Math.min(1040, Math.max(rightSpace, leftSpace)));

    if (rightSpace >= width) {
      const y = Math.max(area.y, Math.min(area.y + area.height - height, main.y));
      w.setBounds({ x: main.x + main.width + gap, y, width, height });
      return;
    }
    if (leftSpace >= width) {
      const y = Math.max(area.y, Math.min(area.y + area.height - height, main.y));
      w.setBounds({ x: main.x - width - gap, y, width, height });
      return;
    }
    // 两边都放不下：退到主窗口下方，仍然不重叠
    const below = main.y + main.height + gap;
    if (below + height <= area.y + area.height) {
      w.setBounds({ x: main.x, y: below, width: fit(1040), height });
      return;
    }
    const w2 = fit(1040);
    w.setBounds({
      x: Math.round(area.x + (area.width - w2) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width: w2,
      height,
    });
    return;
  }
  const w2 = fit(1040);
  w.setBounds({
    x: Math.round(area.x + (area.width - w2) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width: w2,
    height,
  });
}

function openLyricsWindow(): boolean {
  if (!hasMainWindow()) return false;
  if (lyricsWin && !lyricsWin.isDestroyed()) {
    if (lyricsWin.isMinimized()) lyricsWin.restore();
    lyricsWin.show();
    lyricsWin.focus();
    return true;
  }
  lyricsWin = new BrowserWindow({
    width: 1040,
    height: 700,
    // 780 而不是 840：placeLyricsWindow 可能算出一个比 840 窄的宽度（两侧各 808 时），
    // 被 minWidth 顶回去就会越界、进而被系统往左推 → 压住主窗口 20px
    minWidth: 780,
    minHeight: 540,
    show: false,
    /**
     * 不再用 frame:true。
     *
     * frame:true 会在自绘的浅色顶栏上方再叠一条系统的深色标题栏 ——
     * 于是窗口顶部有两条栏，上面那条永远跟着系统深浅色走，压不住也改不了。
     * 改成 hidden + overlay：系统的最小化/最大化/关闭 直接叠在自绘顶栏右端，
     * 和主窗口用的是同一套做法，并排放时顶边是一条线、按钮是一套样子。
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlayChrome(), height: LP_TITLE_H },
    autoHideMenuBar: true,
    // 默认置顶：这窗口存在的意义就是被看着
    alwaysOnTop: lyricsAlwaysOnTop,
    // 跟着主题走：窗口在 show 之前是藏着的，颜色错了会闪一下白
    backgroundColor: appTheme === 'light' ? '#fbfbfa' : '#141413',
    title: playerState.title ? mt('win.lyricsTitleWith', { title: playerState.title }) : mt('win.lyricsTitle'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // 歌词滚动与播放头一样，被遮挡时不能停
      backgroundThrottling: false,
    },
  });
  // 主窗口放大过就照着放大，别让两个窗口的字号差一截
  matchMainZoom(lyricsWin);
  attachHotkeyForwarding(lyricsWin);
  loadHash(lyricsWin, 'lyrics');
  /**
   * 窗口一开就把当前播放状态推过去。
   * 不推的话：主窗口只在播放中每 70ms 广播一次，暂停 / 从没播过的时候
   * 歌词窗口永远收不到 state，界面停在「未在播放」，封面与歌词也不会加载。
   */
  lyricsWin.webContents.on('did-finish-load', () => {
    sendTo(win, 'lyrics:state', true);
    sendTo(lyricsWin, 'player:state', playerState);
    primeChildTheme(lyricsWin);
  });
  // 记过位置就用记过的（用户可能把它拖到另一块屏上）；没记过才按主窗口旁边摆
  rememberWindow('lyrics', lyricsWin);
  lyricsWin.once('ready-to-show', () => {
    if (!lyricsWin || lyricsWin.isDestroyed()) return;
    // 必须在 show 之前定位：show 之后窗口会闪一下再跳位
    if (!applySavedBounds(lyricsWin, 'lyrics')) placeLyricsWindow(lyricsWin);
    lyricsWin.show();
  });
  lyricsWin.on('closed', () => {
    lyricsWin = null;
    sendTo(win, 'lyrics:state', false);
  });
  sendTo(win, 'lyrics:state', true);
  return true;
}

function closeLyricsWindow(): boolean {
  if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.close();
  return false;
}

/**
 * 打开「动态操作帮助」窗口（选区摘要 + 手势清单）。
 *
 * 它接替了网格底部那条说明栏：一行里塞十来个手势，既占高度又读不完。
 * 位置摆在主窗口右下角内侧（和歌词窗口左右分开，不叠在一起）；默认置顶，
 * 但窗口里能关掉置顶 —— 它压在主窗口一角，有人会嫌挡。
 */
function openHelpWindow(): boolean {
  if (!hasMainWindow()) return false;
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.show();
    helpWin.focus();
    return true;
  }
  bootLog(`openHelpWindow theme=${appTheme} overlay=${JSON.stringify(overlayChrome())}`);
  /**
   * 初始尺寸照样要乘缩放：`setZoomFactor` 之后 CSS 视口 = 物理尺寸 / z，
   * 按 520×350 建窗再放大，一开窗内容就是被裁的（要等渲染层重量一次才修好，闪一下）。
   */
  const z0 = mainZoomFactor();
  helpWin = new BrowserWindow({
    // 宽度 = 歌词播报器（1040）的一半；高度先给个够放摘要的初值，
    // 渲染层量完内容会立刻通知 help:resize 调成刚好装下全部内容
    width: Math.round(HELP_W * z0),
    height: Math.round(350 * z0),
    minWidth: Math.round(380 * z0),
    minHeight: Math.round(240 * z0),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlayChrome(), height: LP_TITLE_H },
    autoHideMenuBar: true,
    alwaysOnTop: helpAlwaysOnTop,
    backgroundColor: appTheme === 'light' ? '#fbfbfa' : '#141413',
    title: mt('win.helpTitle'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  matchMainZoom(helpWin);
  attachHotkeyForwarding(helpWin);
  loadHash(helpWin, 'help');
  helpWin.webContents.on('did-finish-load', () => {
    // 先把最近一份摘要补上：否则窗口刚开的一瞬间是空的，要等用户动一下才有内容
    sendTo(helpWin, 'help:summary', helpSummary);
    sendTo(helpWin, 'help:state', { open: true, alwaysOnTop: helpAlwaysOnTop });
    // 主题同上：广播只在切换时发，这个窗口比那条晚开
    primeChildTheme(helpWin);
  });
  helpApplied = null;
  helpCssH = null;
  rememberWindow('help', helpWin);
  helpWin.once('ready-to-show', () => {
    if (!helpWin || helpWin.isDestroyed()) return;
    helpWin.show();
    /**
     * 先按缩放把物理尺寸定下来，再摆位置 —— 顺序反了的话，
     * 位置是按构造函数里那个（可能偏小的）尺寸算的，定完尺寸就贴不住右下角了。
     * 开窗之前渲染层可能已经报过一次高度，而 `setContentSize` 在**没 show 的窗口**上
     * 不保证生效（实测会停在构造函数里的 350），所以 show 之后补一次。
     */
    fitHelpWindow(true);
    /**
     * 位置：记过就用记过的（用户可能把它拖到别处）；没记过才贴主窗口右下角。
     * **只恢复位置不恢复尺寸** —— 它的高度由内容算出来（`fitHelpWindow`），
     * 硬套记下来的高度会把刚变多的手势裁掉。
     */
    let placed = false;
    try {
      placed = applySavedBounds(helpWin, 'help', { size: false });
    } catch {
      /* 拿不到旧位置就当没记过 */
    }
    if (!placed) {
      try {
        const host = win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().workArea;
        const b = helpWin.getBounds();
        helpWin.setPosition(
          Math.max(0, Math.round(host.x + host.width - b.width - 24)),
          Math.max(0, Math.round(host.y + host.height - b.height - 24))
        );
      } catch {
        /* 取不到主窗口就让系统按默认位置开 */
      }
    }
    keepInsideWorkArea(helpWin);
  });
  helpWin.on('closed', () => {
    helpWin = null;
    helpApplied = null;
    helpCssH = null;
    sendTo(win, 'help:state', { open: false, alwaysOnTop: helpAlwaysOnTop });
  });
  sendTo(win, 'help:state', { open: true, alwaysOnTop: helpAlwaysOnTop });
  return true;
}

function closeHelpWindow(): void {
  if (helpWin && !helpWin.isDestroyed()) helpWin.close();
}

/**
 * 历史窗口：一条条列出操作，点哪条回到哪一步。
 *
 * 高度固定（不做自适应）—— 列表可能很长，内部滚动比「窗口跟着列表长高」稳。
 * 不置顶：它是参考面板，需要时点开看一眼，不该一直压在主窗口上。
 */
function openHistoryWindow(): boolean {
  if (!hasMainWindow()) return false;
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.show();
    historyWin.focus();
    return true;
  }
  historyWin = new BrowserWindow({
    width: HIST_W,
    height: 620,
    minWidth: 420,
    minHeight: 320,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...overlayChrome(), height: LP_TITLE_H },
    autoHideMenuBar: true,
    backgroundColor: appTheme === 'light' ? '#fbfbfa' : '#141413',
    title: mt('win.historyTitle'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  matchMainZoom(historyWin);
  attachHotkeyForwarding(historyWin);
  loadHash(historyWin, 'history');
  historyWin.webContents.on('did-finish-load', () => {
    // 窗口开得比主窗口慢时，列表广播可能已经过过去了 —— 主动补一份
    sendTo(historyWin, 'history:changed', historyStateNow());
    primeChildTheme(historyWin);
  });
  rememberWindow('history', historyWin);
  historyWin.once('ready-to-show', () => {
    if (!historyWin || historyWin.isDestroyed()) return;
    if (!applySavedBounds(historyWin, 'history')) {
      try {
        const host = win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().workArea;
        const b = historyWin.getBounds();
        // 优先摆在主窗口左边（和歌词窗的右边对称）；左边放不下就贴右边
        const leftX = Math.round(host.x - b.width - 24);
        const x = leftX > 0 ? leftX : Math.round(host.x + host.width - b.width - 24);
        const y = Math.round(host.y + Math.max(0, (host.height - b.height) / 2));
        historyWin.setPosition(Math.max(0, x), Math.max(0, y));
      } catch {
        /* 取不到主窗口就让系统摆 */
      }
    }
    historyWin.show();
  });
  historyWin.on('closed', () => {
    historyWin = null;
    sendTo(win, 'history:state', false);
  });
  sendTo(win, 'history:state', true);
  return true;
}

function closeHistoryWindow(): void {
  if (historyWin && !historyWin.isDestroyed()) historyWin.close();
}

function toggleHistoryWindow(): boolean {
  if (historyWin && !historyWin.isDestroyed()) {
    closeHistoryWindow();
    return false;
  }
  return openHistoryWindow();
}

/** 菜单那条是 toggle：开着就关、关着就开 */
function toggleHelpWindow(): boolean {
  if (helpWin && !helpWin.isDestroyed()) {
    closeHelpWindow();
    return false;
  }
  return openHelpWindow();
}

/**
 * 图片查看窗口：封面这类图不适合缩略图（详情面板窄，一张彩色图喧宾夺主），
 * 所以详情里只给一个文件名，点开才在这里看原图。
 *
 * 图片走 ma-art:// 而不是传本地路径 —— 渲染层拿不到任意文件读取的能力，
 * 协议处理器里已经做了「只允许 dataDir / assetsDir 内」的校验。
 */
function openImageWindow(url: string, title: string): boolean {
  if (!hasMainWindow()) return false;
  if (imageWin && !imageWin.isDestroyed()) {
    sendTo(imageWin, 'image:set', { url, title });
    imageWin.show();
    imageWin.focus();
    return true;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1000, area.width - 200);
  const height = Math.min(860, area.height - 160);
  imageWin = new BrowserWindow({
    width,
    height,
    minWidth: 320,
    minHeight: 240,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    // 窗口按图片比例撑：先给一个方形默认值，did-finish-load 后再按真实尺寸调
    backgroundColor: appTheme === 'light' ? '#fbfbfa' : '#141413',
    title: title || mt('detail.coverView'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  loadHash(imageWin, 'image');
  attachHotkeyForwarding(imageWin);
  imageWin.webContents.on('did-finish-load', () => {
    sendTo(imageWin, 'image:set', { url, title });
  });
  imageWin.once('ready-to-show', () => imageWin?.show());
  imageWin.on('closed', () => {
    imageWin = null;
  });
  return true;
}

/**
 * 桌面歌词的位置：现在记在 config.json 的 `layout.overlay` 里
 * （用户 2026-11-22 要求所有子窗口统一到那一份）。
 *
 * 旧的 `overlay-bounds.json` 只读不写：升级上来的第一次还能用旧位置，
 * 之后就都归 config.json 管 —— 两处都写会变成两份真相。
 */
function legacyOverlayPosFile() {
  return path.join(app.getPath('userData'), 'overlay-bounds.json');
}

function readOverlayPos(): { x: number; y: number } | null {
  const box = savedBox('overlay');
  if (box.bounds) return { x: Math.round(box.bounds.x), y: Math.round(box.bounds.y) };
  try {
    const p = legacyOverlayPosFile();
    if (!fs.existsSync(p)) return null;
    const b = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Number.isFinite(b?.x) && Number.isFinite(b?.y)) return { x: Math.round(b.x), y: Math.round(b.y) };
  } catch {
    /* 文件坏了就当没存过 */
  }
  return null;
}

let overlaySaveTimer: NodeJS.Timeout | null = null;
function saveOverlayPos() {
  if (overlaySaveTimer) clearTimeout(overlaySaveTimer);
  overlaySaveTimer = setTimeout(() => {
    overlaySaveTimer = null;
    if (!overlayWin || overlayWin.isDestroyed()) return;
    try {
      saveBox('overlay', { bounds: overlayWin.getBounds() });
    } catch {
      /* 写不了就算了，不影响歌词显示 */
    }
  }, 250);
}

function openOverlayWindow(): boolean {
  if (!hasMainWindow()) return false;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.showInactive();
    return true;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const width = 980;
  const height = 190;
  const pos = readOverlayPos();
  // 存的点可能落在已经拔掉的显示器上：夹回主屏，否则窗口开到看不见的地方
  const x = Math.max(area.x, Math.min(area.x + area.width - width, pos?.x ?? Math.round(area.x + (area.width - width) / 2)));
  const y = Math.max(area.y, Math.min(area.y + area.height - height, pos?.y ?? Math.round(area.y + area.height - height - 90)));

  overlayWin = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    title: mt('win.overlayTitle'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // screen-saver 层：全屏播放器之上也看得见
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  try {
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* 非 Windows/macOS 忽略 */
  }
  loadHash(overlayWin, 'overlay');
  attachHotkeyForwarding(overlayWin);
  // showInactive：不要从主窗口手里抢走键盘焦点，否则打字会跑
  overlayWin.once('ready-to-show', () => overlayWin?.showInactive());
  overlayWin.on('moved', saveOverlayPos);
  overlayWin.on('closed', () => {
    overlayWin = null;
    sendTo(win, 'overlay:state', false);
  });
  sendTo(win, 'overlay:state', true);
  return true;
}

function closeOverlayWindow(): boolean {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
  return false;
}

/**
 * 浮窗拖动：无边框窗口没有系统标题栏可拖，渲染层只能报增量。
 * 这里用 setPosition 移动并立刻存盘 —— 拖动过程中每个 pointermove 都存会写爆磁盘，
 * 但 moved 事件在拖动结束才发，所以存盘交给它（见 openOverlayWindow 里的 moved 监听）。
 */
function moveOverlayWindow(dx: number, dy: number): boolean {
  if (!overlayWin || overlayWin.isDestroyed()) return false;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  const [x, y] = overlayWin.getPosition();
  overlayWin.setPosition(Math.round(x + dx), Math.round(y + dy));
  return true;
}

function registerIpc() {
  const ctx = () => ({ db: handle.db, vocab, dataDir, assetsDir });

  /**
   * 操作历史：状态落 userData（不是 data/ —— 那是「作品内容」，撤销记录属于机器本地状态，
   * 跟着冒烟的副本一起被复制反而会串味）。
   */
  wsStore = new WorkspaceStore(app.getPath('userData'));

  /**
   * 启动配置：外置 JSON，位置与 workspaces.json 同一层。
   * 文件不存在会立刻生成默认值 —— 用户不打开选项也能直接手改。
   */
  configStore = new ConfigStore(app.getPath('userData'));
  const cfg0 = configStore.snapshot();
  console.log(`[config] ${cfg0.path}${cfg0.fresh ? '（已生成默认配置）' : ''}`);
  if (cfg0.safeMode) console.log('[config] 安全模式：跳过插件加载与自动子窗口');

  historyStore = new HistoryStore({
    dir: app.getPath('userData'),
    apply: (analysisId, events) => {
      // 注意签名是 ({db}, ...)：传 ctx() 整个对象，不是 ctx().db
      analysisIpc.replaceEvents(ctx(), analysisId, events);
      syncByAnalysis(analysisId);
    },
  });

  /**
   * 每次写操作之后，把这首曲目镜像回 `data/tracks/<曲名>.json`。
   *
   * 为什么挂在 IPC 这一层而不是业务函数里：写入口有十几条
   * （详情编辑 / 标签 / 时间线 / 录音 / 封面 / 歌词），逐个在业务函数里调一定会漏，
   * 而漏掉的那条**不会报错** —— 只会在下次用 JSON 重建库时悄悄少一段数据。
   * 这里是所有变更的必经之路，漏不掉。
   *
   * 失败只记日志：JSON 是「源的镜像」，磁盘满 / 权限不足不该让用户的操作失败。
   */
  const syncTrackJson = (trackId?: string | null) => {
    if (!trackId) return;
    try {
      writeTrackJson({ db: handle.db, dataDir }, trackId);
    } catch (err) {
      console.error('[json] 写回失败：', trackId, err);
    }
  };
  const syncByAnalysis = (analysisId?: string | null) =>
    syncTrackJson(analysisId ? trackIdOfAnalysis(handle.db, analysisId) : null);

  ipcMain.handle('app:meta', () => buildMeta());
  ipcMain.handle('app:open-data-dir', () => shell.openPath(dataDir));
  ipcMain.handle('config:get', () => configStore!.snapshot());
  ipcMain.handle('config:update', (_e, patch) => configStore!.update(patch ?? {}));
  /**
   * 只写布局：面板拖宽结束、侧栏折叠切换、独立窗口的泳道侧栏拖宽都走这条。
   * 渲染层用它上报「主窗口内部」那一半，窗口几何由主进程自己记（见 rememberWindow）。
   */
  ipcMain.handle('config:set-layout', (_e, patch) => {
    const g = patch?.grid;
    if (g && (typeof g.sideW === 'number' || typeof g.sideOpen === 'boolean')) {
      lastGridSide = {
        sideW: typeof g.sideW === 'number' ? g.sideW : lastGridSide.sideW,
        sideOpen: typeof g.sideOpen === 'boolean' ? g.sideOpen : lastGridSide.sideOpen,
      };
    }
    return configStore!.setLayout(patch ?? {});
  });
  ipcMain.handle('config:open', () => shell.openPath(configStore!.file));
  ipcMain.handle('app:reload-vocab', () => {
    vocab = loadVocab(dataDir);
    return syncVocab(handle.db, vocab);
  });

  /* 词表编辑器：读整棵树 / 保存整棵树 / 给维护人员打开 JSON。
     保存成功后必须重载 vocab 再 sync —— 只写文件不重载，界面上的标签还是旧的。 */
  ipcMain.handle('vocab:doc', (_e, dim) => vocabIpc.readDoc(ctx(), dim));
  ipcMain.handle('vocab:save', (_e, dim, roots) => {
    const res = vocabIpc.saveDoc(ctx(), dim, roots);
    if (!res.ok) return res;
    vocab = loadVocab(dataDir);
    const sync = syncVocab(handle.db, vocab);
    return { ...res, tags: sync.tags, aliases: sync.aliases };
  });
  ipcMain.handle('vocab:open-file', (_e, dim) => shell.openPath(path.join(dataDir, 'vocab', `${dim}.json`)));

  /**
   * 和弦符号词表：只服务「字母和弦泳道」的输入补全。
   * 与标签词表分开：结构不同（根音 × 性质），也不进 tag 表。
   */
  ipcMain.handle('chords:doc', () => chordSymbols.loadChordSymbols(dataDir));
  ipcMain.handle('chords:save', (_e, doc) => chordSymbols.saveChordSymbols(dataDir, doc));
  ipcMain.handle('chords:open-file', () => shell.openPath(chordSymbols.chordSymbolsPath(dataDir)));

  /**
   * 乐章标题补全：速度 / 表情表 + 体裁树，两张表合并后一次交给渲染层。
   * 「速度术语」那一行点开的是速度表本身（体裁走侧栏的词表编辑器）。
   */
  ipcMain.handle('movement:doc', () => movementMarkings.loadMovementTerms(dataDir));
  ipcMain.handle('movement:open-file', () => shell.openPath(movementMarkings.tempoMarkingPath(dataDir)));

  /* ---- 播放列表：文件在 data/playlists.json，不走数据库（见 ipc/playlists.ts 顶部） ---- */
  ipcMain.handle('playlists:list', () => playlistsIpc.loadPlaylists(ctx().dataDir));
  ipcMain.handle('playlists:create', (_e, name) => playlistsIpc.createPlaylist(ctx().dataDir, name));
  ipcMain.handle('playlists:rename', (_e, id, name) => playlistsIpc.renamePlaylist(ctx().dataDir, id, name));
  ipcMain.handle('playlists:remove', (_e, id) => playlistsIpc.removePlaylist(ctx().dataDir, id));
  ipcMain.handle('playlists:set-tracks', (_e, id, ids) => playlistsIpc.setPlaylistTracks(ctx().dataDir, id, ids ?? []));

  ipcMain.handle('tracks:list', (_e, q) => tracks.listTracks(ctx(), q ?? {}));
  ipcMain.handle('tracks:get', (_e, id) => tracks.getTrack(ctx(), id));
  ipcMain.handle('tracks:upsert', (_e, patch) => {
    const id = tracks.upsertTrack(ctx(), patch);
    syncTrackJson(id);
    return id;
  });
  // 登记作品：库里的行 + data/tracks 里的 JSON 必须同时存在（JSON 才是源）
  ipcMain.handle('tracks:create', (_e, patch) => {
    const r = tracks.createTrack(ctx(), patch ?? {});
    syncTrackJson(r.id);
    return r;
  });
  ipcMain.handle('tracks:rename', (_e, id, title) => {
    const r = tracks.renameTrack(ctx(), id, title);
    if (r) syncTrackJson(r.id);
    return r;
  });
  ipcMain.handle('tracks:update', (_e, id, patch) => {
    const r = tracks.updateTrack(ctx(), id, patch ?? {});
    syncTrackJson(id);
    return r;
  });
  // 删除在 softDeleteTrack 内部完成「写一份 → 搬进 .archive」
  ipcMain.handle('tracks:remove', (_e, id) => tracks.softDeleteTrack(ctx(), id));

  ipcMain.handle('tags:suggest', (_e, dim, input) => tagsIpc.suggestTags(ctx(), dim, input));
  ipcMain.handle('tags:ensure', (_e, dim, name) => tagsIpc.ensureTag(ctx(), dim, name));
  ipcMain.handle('tags:merge', (_e, from, to) => {
    tagsIpc.mergeTags(ctx(), from, to);
    // 合并只影响挂在 to 上的曲目（from 的行已经被搬过去了）
    for (const r of handle.db.prepare(`SELECT track_id FROM track_tag WHERE tag_id = ?`).all(to) as any[]) {
      syncTrackJson(r.track_id);
    }
  });
  ipcMain.handle('tags:orphans', () => tagsIpc.orphans(ctx()));
  ipcMain.handle('tags:tree', (_e, dim) => tagsIpc.tagTree(ctx(), dim));
  ipcMain.handle('tags:attach', (_e, trackId, tagId) => {
    tagsIpc.attachTag(ctx(), trackId, tagId);
    syncTrackJson(trackId);
  });
  ipcMain.handle('tags:detach', (_e, trackId, tagId) => {
    tagsIpc.detachTag(ctx(), trackId, tagId);
    syncTrackJson(trackId);
  });

  ipcMain.handle('search:suggest', (_e, input) => searchIpc.suggestSearch(ctx(), input));

  ipcMain.handle('analysis:get', (_e, trackId) => analysisIpc.getAnalysis(ctx(), trackId));
  ipcMain.handle('analysis:setMarkers', (_e, id, kind, ms) => {
    analysisIpc.setMarkers(ctx(), id, kind, ms);
    syncByAnalysis(id);
  });
  ipcMain.handle('analysis:upsertEvent', (_e, e) => {
    const r = analysisIpc.upsertEvent(ctx(), e);
    syncByAnalysis(e?.analysisId);
    return r;
  });
  ipcMain.handle('analysis:deleteEvent', (_e, id) => {
    // 先反查再删：删掉之后事件行没了，就找不到它属于哪首曲目了
    const trackId = trackIdOfEvent(handle.db, id);
    analysisIpc.deleteEvent(ctx(), id);
    syncTrackJson(trackId);
  });
  ipcMain.handle('analysis:writeRange', (_e, p) => {
    const r = analysisIpc.writeRange(ctx(), p);
    syncByAnalysis(p?.analysisId);
    return r;
  });
  ipcMain.handle('analysis:resize', (_e, p) => {
    const r = analysisIpc.resizeRange(ctx(), p);
    syncByAnalysis(p?.analysisId);
    return r;
  });
  ipcMain.handle('analysis:clearRange', (_e, p) => {
    const r = analysisIpc.clearRange(ctx(), p);
    syncByAnalysis(p?.analysisId);
    return r;
  });
  ipcMain.handle('analysis:deleteEvents', (_e, ids) => {
    const trackIds = new Set(
      (ids ?? []).map((id: string) => trackIdOfEvent(handle.db, id)).filter(Boolean) as string[]
    );
    const n = analysisIpc.deleteEvents(ctx(), ids);
    for (const t of trackIds) syncTrackJson(t);
    return n;
  });
  ipcMain.handle('analysis:moveEvents', (_e, id, moves) => {
    const r = analysisIpc.moveEvents(ctx(), { analysisId: id, moves });
    syncByAnalysis(id);
    return r;
  });

  ipcMain.handle('audio:resolve', (_e, trackId) => audioIpc.resolveAudio(ctx(), trackId));
  // 双击某个演奏版本：解析那一条录音的文件地址（不写库）
  ipcMain.handle('audio:resolveRecording', (_e, trackId, recId) => audioIpc.resolveRecordingAudio(ctx(), trackId, recId));
  ipcMain.handle('audio:pick', (e, trackId) => {
    const r = audioIpc.pickAudio(ctx(), trackId);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('audio:setPath', (_e, trackId, filePath) => {
    const r = audioIpc.setAudioPath(ctx(), trackId, filePath);
    syncTrackJson(trackId);
    return r;
  });
  // 元数据面板：只读，不写库（「填入档案」走 tracks:update，保持单一写入口）
  // recId 有值 = 读那条录音版本自己的文件（元数据属于文件，不属于作品）
  ipcMain.handle('audio:tags', (_e, trackId, recId) => audioIpc.readTags(ctx(), trackId, recId ?? null));

  /* ---- 波形缓存（磁盘层）：只存解码后的峰值金字塔，不是音频 ---- */
  ipcMain.handle('wave:get', (_e, meta) => waveIpc.waveGet(meta));
  ipcMain.handle('wave:put', (_e, meta, bytes, limitBytes) => waveIpc.wavePut(meta, bytes, limitBytes));
  ipcMain.handle('wave:forget', (_e, meta) => waveIpc.waveForget(meta));
  ipcMain.handle('wave:prune', (_e, limitBytes) => waveIpc.wavePrune(limitBytes));
  ipcMain.handle('wave:stats', () => waveIpc.waveStats());
  ipcMain.handle('wave:clear', () => waveIpc.waveClear());

  /* ---- 录音制品：同一部作品的不同录音版本 ----
   *
   * 录音层**不进 JSON**（schema v3 只存作品层）。但录音会改 `track.file_path`
   * 与默认版本的偏移，而这两个值在 JSON 的 `timeline.audioPath / audioOffsetMs` 里 ——
   * 所以库里说完之后仍要同步一次，否则重建库时音频就丢了。
   */
  ipcMain.handle('recording:list', (_e, trackId) => recordingIpc.listRecordings(ctx(), trackId));
  ipcMain.handle('recording:get', (_e, id) => recordingIpc.getRecording(ctx(), id));
  ipcMain.handle('recording:save', (_e, patch) => {
    const r = recordingIpc.saveRecording(ctx(), patch);
    syncTrackJson(r?.trackId);
    return r;
  });
  ipcMain.handle('recording:remove', (_e, id) => {
    const trackId = trackIdOfRecording(handle.db, id);
    recordingIpc.removeRecording(ctx(), id);
    syncTrackJson(trackId);
  });
  ipcMain.handle('recording:setDefault', (_e, trackId, recId) => {
    const r = recordingIpc.setDefault(ctx(), trackId, recId);
    syncTrackJson(trackId);
    return r;
  });
  // 顺序就是播放优先级：传完整清单（从前往后），主播放位由顺序推导
  ipcMain.handle('recording:reorder', (_e, trackId, ids) => {
    const r = recordingIpc.reorderRecordings(ctx(), trackId, ids);
    syncTrackJson(trackId);
    return r;
  });
  // 原点偏移是**逐版本**的：recId 为空写主录音（顺序里的第一首）
  ipcMain.handle('recording:setOffset', (_e, trackId, recId, ms) => {
    const r = recordingIpc.setRecordingOffset(ctx(), trackId, recId ?? null, ms);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('recording:pick', (_e, trackId, recId) => {
    const r = recordingIpc.pickRecordingAudio(ctx(), trackId, recId);
    syncTrackJson(trackId);
    return r;
  });
  // 同一演奏版本追加一个音质 / 转码文件：子记录只带文件信息，演奏信息留在父版本
  ipcMain.handle('recording:pickVariant', (_e, parentId) =>
    recordingIpc.pickRecordingVariant(ctx(), String(parentId)).then((r) => {
      if (r) syncTrackJson(r.trackId);
      return r;
    })
  );
  // 把一条已有演奏版本并到另一条下面，当作同版音质（只允许无子项的一层）
  ipcMain.handle('recording:mergeInto', (_e, id, parentId) => {
    const trackId = trackIdOfRecording(handle.db, String(id));
    const r = recordingIpc.mergeRecordingInto(ctx(), String(id), String(parentId));
    if (r) syncTrackJson(r.trackId);
    else if (trackId) syncTrackJson(trackId);
    return r;
  });
  // 老档案只有 track.file_path、没有录音记录时补一条，详情面板才不会出现「有音频但零版本」
  ipcMain.handle('recording:ensure', (_e, trackId) => {
    const r = recordingIpc.ensureRecordingForTrack(ctx(), trackId);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('netease:open', (_e, url) => neteaseIpc.openMusicLink(url));
  ipcMain.handle('link:open', (_e, url) => neteaseIpc.openMusicLink(url));

  /* ---- 封面 / 歌词：都是「跟着曲目走的外部文件」，路径存在 extra 里 ----
   * 这两类都落在 JSON 的 `covers` / `lyrics` / `instrumental` 上，所以同样要同步。
   */
  ipcMain.handle('art:pick', (_e, trackId, kind) => {
    const r = mediaIpc.pickCover(ctx(), trackId, kind);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('art:clear', (_e, trackId, kind) => {
    const r = mediaIpc.clearCover(ctx(), trackId, kind);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('lyrics:resolve', (_e, trackId) => mediaIpc.resolveLyrics(ctx(), trackId));
  ipcMain.handle('lyrics:pick', (_e, trackId) => {
    const r = mediaIpc.pickLyrics(ctx(), trackId);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('lyrics:clear', (_e, trackId) => {
    const r = mediaIpc.clearLyrics(ctx(), trackId);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('lyrics:instrumental', (_e, trackId, on) => {
    const r = mediaIpc.setInstrumental(ctx(), trackId, !!on);
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('lyrics:save-line', (_e, trackId, patch) => mediaIpc.saveLyricLine(ctx(), trackId, patch));
  ipcMain.handle('lyrics:translation', (_e, trackId) => mediaIpc.loadLyricsTranslation(ctx(), trackId));
  ipcMain.handle('lyrics:trans-pick', (_e, trackId) => mediaIpc.pickLyricsTranslation(ctx(), trackId));
  ipcMain.handle('lyrics:trans-clear', (_e, trackId) => mediaIpc.clearLyricsTranslation(ctx(), trackId));

  /* ---- 归档：软删的曲目进 `data/tracks/.archive`，这里负责列出来与彻底删除 ----
   *
   * 「彻底删除」必须两头都清：只删文件，库里那行会一直占着标题，下次启动
   * `syncMissingTrackJson` 还会把它写回来；只删行，归档里那份就成了谁也认不出的垃圾。
   */
  ipcMain.handle('archive:list', () => listArchived(dataDir));
  ipcMain.handle('archive:purge', (_e, uuid) => purgeArchived({ db: handle.db, dataDir }, uuid ?? null));
  ipcMain.handle('archive:purge-all', () => purgeAllArchived({ db: handle.db, dataDir }));

  /* 桌面歌词的样式：主窗口是唯一写入方，浮窗只收广播。
     走 IPC 而不是共享 localStorage —— 同一个 origin 下 storage 事件在 Electron
     里并不总是跨窗口触发，不能把「调了字号浮窗没变」押在它身上。 */
  ipcMain.handle('lyrics:style-get', () => lyricStyle);
  ipcMain.handle('lyrics:style-set', (_e, st) => {
    lyricStyle = {
      size: Math.max(16, Math.min(64, Number(st?.size) || lyricStyle.size)),
      opacity: Math.max(0.2, Math.min(1, Number(st?.opacity) || lyricStyle.opacity)),
      color: ['white', 'accent', 'warm'].includes(st?.color) ? st.color : lyricStyle.color,
      next: st?.next !== false,
    };
    broadcast('lyrics:style', lyricStyle);
    return lyricStyle;
  });

  /* ---- 界面主题：主窗口是唯一来源，切了要广播给所有子窗口 ---- */
  ipcMain.handle('app:theme-set', (e, th) => {
    appTheme = th === 'light' ? 'light' : 'dark';
    bootLog(`app:theme-set ${appTheme}`);
    refreshAllOverlays();
    broadcast('app:theme', appTheme, BrowserWindow.fromWebContents(e.sender));
    return appTheme;
  });
  ipcMain.handle('app:theme-get', () => appTheme);

  /* ---- 主题模式：dark / light / system / timed ----
   *
   * system 只能在这里实现：nativeTheme 是 Electron 的 API，渲染层拿不到。
   * 主进程订阅 'updated'，系统切换深浅时广播给所有窗口。
   * timed（按时段）由渲染层自己按小时算，这里只存模式供子窗口开窗时知道。
   */
  ipcMain.handle('app:theme-mode-set', (_e, m) => {
    appThemeMode = ['dark', 'light', 'system', 'timed'].includes(m) ? m : 'dark';
    return appThemeMode;
  });
  ipcMain.handle('app:theme-mode-get', () => appThemeMode);
  ipcMain.handle('app:system-theme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));

  /* ---- 歌词播报器「置于顶层」 ----
   * 默认开：这是给听众用的窗口，被主窗口压住就等于看不见。
   * 状态记在主进程（跟窗口活不活同生命周期），不落盘 —— 这是看播的临时偏好，
   * 下次启动重新置顶更符合直觉。 */
  ipcMain.handle('win:lyrics-always-on-top', (_e, v?: boolean) => {
    if (!lyricsWin || lyricsWin.isDestroyed()) return false;
    const on = typeof v === 'boolean' ? v : !lyricsAlwaysOnTop;
    lyricsAlwaysOnTop = on;
    lyricsWin.setAlwaysOnTop(on, 'floating');
    lyricsWin.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: true });
    return on;
  });
  ipcMain.handle('win:lyrics-always-on-top-get', () => lyricsAlwaysOnTop);

  /* ---- 图片查看窗口 ---- */
  ipcMain.handle('win:open-image', (_e, url, title) => openImageWindow(String(url ?? ''), String(title ?? '')));
  ipcMain.handle('win:resize-image', (e, w, h) => {
    const w2 = imageWin;
    if (!w2 || w2.isDestroyed()) return false;
    const nw = Math.max(320, Math.min(1400, Math.round(Number(w) || 0) + 40));
    const nh = Math.max(240, Math.min(1200, Math.round(Number(h) || 0) + 64));
    // 跟着主窗口走，别飘到看不见的地方
    const p = w2.getPosition();
    const area = screen.getDisplayMatching({ x: p[0], y: p[1], width: w2.getBounds().width, height: w2.getBounds().height }).workArea;
    const x = Math.max(area.x, Math.min(p[0], area.x + area.width - nw));
    const y = Math.max(area.y, Math.min(p[1], area.y + area.height - nh));
    w2.setBounds({ x, y, width: nw, height: nh });
    return true;
  });

  /* ---- 播放中枢 ----
   * 主窗口独占音频，歌词窗口 / 桌面歌词只发指令；这里只做转发与广播。
   * 不做节流：主窗口那边已经按 250ms 推，一层节流只会让歌词慢半拍。 */
  ipcMain.handle('player:publish', (e, st) => {
    const next: PlayerState = {
      trackId: st?.trackId ?? null,
      title: st?.title ?? null,
      sourceMode: st?.sourceMode === 'audio' || st?.sourceMode === 'timeline' ? st.sourceMode : 'none',
      playing: !!st?.playing,
      currentMs: Number(st?.currentMs) || 0,
      durationMs: Number(st?.durationMs) || 0,
      ready: !!st?.ready,
      // 0 是合法的（静音），不能写成 `|| 1`；缺字段时才退回 1
      gain: typeof st?.gain === 'number' ? Math.max(0, Math.min(1, st.gain)) : 1,
    };
    const titleChanged = next.title !== playerState.title;
    playerState = next;
    broadcast('player:state', playerState, BrowserWindow.fromWebContents(e.sender));
    if (titleChanged) refreshLyricsTitle();
  });
  ipcMain.handle('player:state', () => playerState);
  ipcMain.handle('player:command', (_e, cmd: PlayerCommand) => {
    sendTo(win, 'player:command', cmd);
  });

  /* ---- 子窗口 ---- */
  ipcMain.handle('win:open-lyrics', () => openLyricsWindow());

  /**
   * 主窗口「完全启动」：渲染层在曲库加载完 + 首帧画完之后主动报一次。
   *
   * 歌词播报器必须在**这之后**才开。以前用 `setTimeout(700)` 猜时机 —— 冷启动慢一点
   * 就抢跑了（歌词窗先冒出来、或者主窗口还没定位，摆位算错）。
   * 这里再等一小会儿让首帧真正上屏（120ms），并且窗口没显示时挂到 'show' 上。
   */
  ipcMain.handle('win:app-ready', (_e, opts?: { autoLyrics?: boolean; autoHelp?: boolean }) => {
    mainAppReady = true;
    if (!win || win.isDestroyed()) return false;
    /**
     * 子窗口一律等主窗口**真的显示出来**之后再开：
     * 一起冒出来像闪屏，而且冷启动时主窗口还没定位好，子窗口会先跳到错位置。
     */
    const afterShown = (fn: () => void, delay: number) => {
      const run = () => {
        try {
          fn();
        } catch (err) {
          console.error('[win] 自动打开子窗口失败', err);
        }
      };
      if (win!.isVisible()) setTimeout(run, delay);
      else win!.once('show', () => setTimeout(run, delay));
    };
    /**
     * 以 config.json 为准，不信渲染层传上来的值：
     * 手改文件后重启要能生效；安全模式也必须真的挡住自动开窗。
     * opts 只在配置文件读不到时当兜底（正常路径 configStore 一定在）。
     * 目前还没有插件系统；以后接插件加载时，必须先读 safeMode。
     */
    const cfg = configStore?.get();
    const safe = cfg?.safeMode === true;
    const autoLyrics = cfg ? cfg.startup.lyrics : !!opts?.autoLyrics;
    const autoHelp = cfg ? cfg.startup.help : !!opts?.autoHelp;
    if (!safe && autoLyrics) afterShown(() => openLyricsWindow(), 120);
    // 错开 160ms：两个窗口同一帧一起 show，会互相抢焦点
    if (!safe && autoHelp) afterShown(() => openHelpWindow(), 280);
    return true;
  });
  ipcMain.handle('win:close-lyrics', () => closeLyricsWindow());
  ipcMain.handle('win:lyrics-open', () => !!lyricsWin && !lyricsWin.isDestroyed());
  ipcMain.handle('win:open-overlay', () => openOverlayWindow());
  ipcMain.handle('win:close-overlay', () => closeOverlayWindow());
  ipcMain.handle('win:move-overlay', (_e, dx, dy) => moveOverlayWindow(Number(dx), Number(dy)));
  ipcMain.handle('win:overlay-open', () => !!overlayWin && !overlayWin.isDestroyed());
  ipcMain.handle('analysis:replaceEvents', (_e, id, events) => {
    const r = analysisIpc.replaceEvents(ctx(), id, events);
    syncByAnalysis(id);
    return r;
  });
  ipcMain.handle('analysis:setAudioOffset', (_e, id, ms) => {
    const r = analysisIpc.setAudioOffset(ctx(), id, ms);
    // 偏移在 JSON 里是 `timeline.audioOffsetMs`（取主录音那份），所以也要落盘
    syncByAnalysis(id);
    return r;
  });
  ipcMain.handle('analysis:setView', (_e, id, viewId) => analysisIpc.setView(ctx(), id, viewId));

  /* ---------------- 操作历史（撤销 / 重做 / 持久化） ----------------
   * 状态在 history.ts 里；这里只负责「把库读出来给它、把它的决定写回库」。
   */
  /** 读某份分析的全部事件（after 快照要从库里读：渲染层手里的 props 还是旧的） */
  const readEvents = (analysisId: string) => {
    const rows = ctx()
      .db.prepare(`SELECT * FROM analysis_event WHERE analysis_id = ? ORDER BY tick, lane`)
      .all(analysisId) as any[];
    return rows.map((e) => ({
      id: e.id,
      lane: e.lane,
      tick: e.tick,
      durTicks: e.dur_ticks,
      text: e.text,
      confidence: e.confidence,
      parsed: (() => {
        try {
          return e.parsed ? JSON.parse(e.parsed) : null;
        } catch {
          return null;
        }
      })(),
    }));
  };

  ipcMain.handle('history:list', () => historyStateNow());
  ipcMain.handle('history:config', (_e, p?: { limit?: number; persist?: number }) => {
    if (!historyStore) return null;
    const r = historyStore.config(Number(p?.limit ?? 0), Number(p?.persist ?? 50));
    broadcastHistory();
    return r;
  });
  ipcMain.handle('history:can', (_e, aid: string) => (historyStore ? historyStore.can(String(aid)) : { undo: false, redo: false }));
  ipcMain.handle('history:append', (_e, input: any) => {
    if (!historyStore || !input?.analysisId) return null;
    const item = historyStore.append({
      trackId: String(input.trackId ?? ''),
      title: String(input.title ?? ''),
      analysisId: String(input.analysisId),
      label: input.label ?? null,
      before: Array.isArray(input.before) ? input.before : [],
      after: readEvents(String(input.analysisId)),
    });
    broadcastHistory();
    return { seq: item.seq };
  });
  const runHist = (kind: 'undo' | 'redo' | 'undoGlobal' | 'redoGlobal' | 'jump', arg?: any) => {
    if (!historyStore) return { ok: false };
    const item =
      kind === 'jump'
        ? historyStore.jump(Number(arg))
        : kind === 'undo'
          ? historyStore.undo(String(arg))
          : kind === 'redo'
            ? historyStore.redo(String(arg))
            : kind === 'undoGlobal'
              ? historyStore.undoGlobal()
              : historyStore.redoGlobal();
    announceApplied(item);
    return item
      ? {
          ok: true,
          seq: item.seq,
          analysisId: item.analysisId,
          trackId: item.trackId,
          title: item.title,
          kind: item.kind,
          label: item.label,
        }
      : { ok: false };
  };
  ipcMain.handle('history:undo', (_e, aid: string) => runHist('undo', aid));
  ipcMain.handle('history:redo', (_e, aid: string) => runHist('redo', aid));
  ipcMain.handle('history:undoGlobal', () => runHist('undoGlobal'));
  ipcMain.handle('history:redoGlobal', () => runHist('redoGlobal'));
  ipcMain.handle('history:jump', (_e, seq: number) => runHist('jump', seq));
  /* ---------------- 工作区 IPC ---------------- */
  ipcMain.handle('ws:list', () => ({
    names: wsStore?.names() ?? [],
    lastAt: wsStore?.getLast()?.at ?? null,
  }));
  ipcMain.handle('ws:save', (_e, p?: { name?: string; ui?: UiState }) => {
    if (!wsStore || !p?.ui) return { ok: false };
    wsStore.save(String(p.name ?? ''), captureLayout(p.ui));
    broadcast('ws:changed', { names: wsStore.names(), lastAt: wsStore.getLast()?.at ?? null });
    return { ok: true, names: wsStore.names() };
  });
  ipcMain.handle('ws:apply', (_e, name?: string) => {
    if (!wsStore) return { ok: false };
    const layout = name ? wsStore.get(String(name)) : wsStore.getLast();
    if (!layout) return { ok: false };
    applyLayout(layout);
    return { ok: true, ui: layout.ui };
  });
  ipcMain.handle('ws:delete', (_e, name: string) => {
    const ok = wsStore?.remove(String(name)) ?? false;
    if (ok && wsStore) broadcast('ws:changed', { names: wsStore.names(), lastAt: wsStore.getLast()?.at ?? null });
    return ok;
  });
  ipcMain.handle('ws:rename', (_e, from: string, to: string) => {
    const ok = wsStore?.rename(String(from), String(to)) ?? false;
    if (ok && wsStore) broadcast('ws:changed', { names: wsStore.names(), lastAt: wsStore.getLast()?.at ?? null });
    return ok;
  });
  /** 启动时渲染层来问：上次那套布局的「窗口内部」部分（面板/栏宽/缩放/主题/泳道） */
  ipcMain.handle('ws:last-ui', () => wsStore?.getLast()?.ui ?? null);

  ipcMain.handle('history:clear', (_e, aid?: string) => {
    if (!historyStore) return 0;
    const n = historyStore.clear(aid ? String(aid) : undefined);
    broadcastHistory();
    return n;
  });

  // 界面缩放：用 Chromium 自己的缩放，文字与 canvas 一起放大且保持清晰；
  // 用 CSS transform 放大只会把已有位图糊掉。
  const senderWin = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender) ?? win;
  ipcMain.handle('ui:setZoom', (e, factor) => {
    const z = Math.min(3, Math.max(0.6, Number(factor) || 1));
    const target = senderWin(e);
    target?.webContents.setZoomFactor(z);
    // 主窗口改缩放 → 所有子窗口跟着改（并排看的时候字号必须一致）
    if (target === win || !target) applyZoomToChildren(z);
    return z;
  });
  ipcMain.handle('ui:getZoom', (e) => senderWin(e)?.webContents.getZoomFactor() ?? 1);

  /**
   * 界面语言由渲染层决定（它读 localStorage，主进程读不到），
   * 推过来之后主进程才拼得出「网格 — music·atlas」、文件对话框标题、网易云提示。
   */
  ipcMain.handle('app:set-locale', (_e, v) => setCurrentLocale(v));

  /**
   * 子窗口的「正在输入」信号。
   *
   * 快捷键转发会 preventDefault —— 一旦拦下，子窗口就收不到那个键了。
   * 所以编辑歌词某一行的输入框拿到焦点时必须提前说一声，否则空格打不出来。
   */
  ipcMain.on('hotkey:editing', (e, on: boolean) => {
    const id = e.sender.id;
    if (on) editingWcIds.add(id);
    else editingWcIds.delete(id);
  });
  // 已经开着的子窗口，标题要跟着语言一起换
  onLocaleChange(() => {
    refreshLyricsTitle();
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setTitle(mt('win.overlayTitle'));
    for (const w of BrowserWindow.getAllWindows()) {
      if (w === win || w === lyricsWin || w === overlayWin || w.isDestroyed()) continue;
      try {
        w.setTitle(mt('win.gridTitle'));
      } catch {
        /* 窗口正在销毁时忽略 */
      }
    }
  });

  // 网格独立窗口：同一个渲染层，靠 hash 路由到「只有网格」的界面
  ipcMain.handle('win:open-grid', (_e, trackId, viewId) => {
    if (!hasMainWindow()) return false;
    const hash = `grid?track=${encodeURIComponent(trackId)}${
      viewId ? '&view=' + encodeURIComponent(viewId) : ''
    }`;
    lastGridTrackId = String(trackId);
    const g = new BrowserWindow({
      width: 1280,
      height: 840,
      minWidth: 880,
      minHeight: 480,
      show: false,
      frame: true,
      // 跟着主题：硬编码深色会在浅色模式下先闪一块黑
      backgroundColor: appTheme === 'light' ? '#fbfbfa' : '#141413',
      title: mt('win.gridTitle'),
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        // 独立网格窗口同上：被遮挡时也不能把 rAF 掐掉
        backgroundThrottling: false,
      },
    });
    gridWin = g;
    g.on('closed', () => {
      if (gridWin === g) gridWin = null;
    });
    g.once('ready-to-show', () => {
      /**
       * 默认「一开就最大化」（这个窗口是拿来干活的，越大越好）；
       * 但记过尺寸就照记的来 —— 用户把它拉成半屏并排看，下次不该又被撑满。
       */
      const box = savedBox('grid');
      if (box.bounds) {
        try {
          g.setBounds(clampRect(box.bounds));
        } catch {
          /* 旧坐标落在屏幕外，clamp 之后仍失败就按最大化开 */
        }
        if (box.maximized) g.maximize();
      } else {
        g.maximize();
      }
      g.show();
    });
    rememberWindow('grid', g);
    // 界面缩放跟主窗口一致（Ctrl+= 在这个窗口里改的是**网格尺寸**，不是界面缩放）
    matchMainZoom(g);
    attachHotkeyForwarding(g, { zoom: false });
    if (process.env.ELECTRON_RENDERER_URL) {
      g.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
    } else {
      g.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
    }
    return true;
  });

  ipcMain.handle('win:minimize', () => win?.minimize());
  /**
   * 动态操作帮助窗口：开合 / 状态 / 置顶 / 摘要。
   * 摘要是主窗口的 GridEditor 推上来的（选区、视图、编辑态），这里只做中转 ——
   * 帮助窗口拿不到主窗口的组件状态，跨窗口只能靠这一条线。
   */
  ipcMain.handle('history:toggle', () => toggleHistoryWindow());
  ipcMain.handle('history:state', () => !!historyWin && !historyWin.isDestroyed());
  ipcMain.handle('help:toggle', () => toggleHelpWindow());
  ipcMain.handle('help:state', () => ({
    open: !!helpWin && !helpWin.isDestroyed(),
    alwaysOnTop: helpAlwaysOnTop,
  }));
  ipcMain.handle('help:top', (_e, v: boolean) => {
    helpAlwaysOnTop = !!v;
    try {
      if (helpWin && !helpWin.isDestroyed()) helpWin.setAlwaysOnTop(helpAlwaysOnTop);
    } catch {
      /* 窗口已销毁 */
    }
    const st = { open: !!helpWin && !helpWin.isDestroyed(), alwaysOnTop: helpAlwaysOnTop };
    sendTo(win, 'help:state', st);
    sendTo(helpWin, 'help:state', st);
    return st;
  });
  /**
   * 渲染层量出来的**内容高（CSS 像素）**。这里只记下来，真正的尺寸交给 fitHelpWindow：
   * 它要乘缩放因子，还要封顶工作区 85%、把窗口推回屏幕内。
   */
  ipcMain.handle('help:resize', (_e, h: number) => {
    if (!helpWin || helpWin.isDestroyed()) return false;
    const cssH = Math.max(1, Math.round(Number(h) || 0));
    if (cssH <= 1) return false;
    // 差 2px 以内不动：ResizeObserver → setContentSize → 再触发 observer，会抖。
    // 比的是「上次量到的值」而不是 getContentSize()（见 helpApplied 的说明）
    if (helpCssH != null && Math.abs(helpCssH - cssH) <= 2) return false;
    helpCssH = cssH;
    return fitHelpWindow();
  });
  /**
   * 收款码：给「为作者提供经济支持」那个弹窗用。
   *
   * 按**文件名关键字**找，不写死路径 —— 收款码是会换的（现在叫「马儿的微信收款码 2026-10-26.png」，
   * 下次换了新码、日期变了也照样能用）。找不到就返回空数组，界面显示一句说明。
   * 图缩到 300px 宽再转 data URL：原图 130KB+，弹窗里根本用不到那个分辨率。
   */
  ipcMain.handle('support:qrs', () => {
    const pick = (kw: string) => {
      try {
        const dir = assetsDir;
        if (!fs.existsSync(dir)) return null;
        const file = fs
          .readdirSync(dir)
          .filter((n) => /收款码|二维码|^qr/i.test(n) && /\.[a-z]{3,4}$/i.test(n))
          .find((n) => n.includes(kw));
        if (!file) return null;
        const img = nativeImage.createFromPath(path.join(dir, file));
        if (img.isEmpty()) return null;
        const { width, height } = img.getSize();
        const small = width > 300 ? img.resize({ width: 300, quality: 'good' }) : img;
        return {
          key: kw === '微信' ? 'wechat' : 'alipay',
          label: kw,
          file,
          width: small.getSize().width,
          height: small.getSize().height,
          dataUrl: small.toDataURL(),
        };
      } catch {
        return null;
      }
    };
    // 微信在左、支付宝在右（用户要求的顺序）
    return [pick('微信'), pick('支付宝')].filter(Boolean);
  });
  ipcMain.handle('help:push', (_e, summary: unknown) => {
    helpSummary = summary ?? null;
    sendTo(helpWin, 'help:summary', helpSummary);
    return true;
  });
  ipcMain.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.handle('win:close', () => win?.close());
  /**
   * 原生窗口按钮的颜色要跟着主题走：titleBarOverlay 是系统画的，
   * 页面里改 CSS 对它无效，必须从主进程 setTitleBarOverlay。
   */
  ipcMain.handle('win:overlay', (_e, opts: { color?: string; symbolColor?: string }) => {
    try {
      win?.setTitleBarOverlay({ height: MAIN_TITLE_H, ...(opts ?? {}) });
    } catch {
      /* 非 Windows 或不支持 overlay 的平台忽略即可 */
    }
    /**
     * 歌词窗口也有一套系统按钮，颜色必须跟着一起换 ——
     * 它创建时拿的是「那一刻」的主题色，之后再切主题就没人管它了。
     * 高度要单独给：它的顶栏比主窗口标题行矮，用统一高度按钮会溢出来。
     */
    try {
      if (lyricsWin && !lyricsWin.isDestroyed()) {
        lyricsWin.setTitleBarOverlay({ ...(opts ?? {}), height: LP_TITLE_H });
      }
      // 帮助窗口也是自绘顶栏 + 系统按钮，颜色得跟着一起换
      if (helpWin && !helpWin.isDestroyed()) {
        helpWin.setTitleBarOverlay({ ...(opts ?? {}), height: LP_TITLE_H });
      }
    } catch {
      /* 同上 */
    }
  });
}

/* ---------------- config.json：自动记忆窗口与面板几何 ---------------- */
/*
 * 与 workspaces.json 分工（用户 2026-11-22 定）：
 *   - workspaces.json = 用户**手动存的多套布局**（编辑用 / 混音用…），点一下临时套用；
 *   - config.json 的 layout = **上次关软件时的样子**，启动时先按它摆。
 * 两者共存：应用工作区会改窗口几何，那些几何随后也会被记进 config.json ——
 * 结果就是「最后一次长什么样，下次就从什么样开始」，这正是自动记忆该有的语义。
 *
 * 为什么不塞进 localStorage：窗口位置只有主进程读得到；而且换机器时
 * 这份「这台机器怎么摆」不该跟着仓库 / 数据目录走。
 */

/** 取一段记过的几何；没有就空对象 */
function savedBox(key: keyof LayoutConfig): WinBox & { sideW?: number; sideOpen?: boolean } {
  try {
    return (configStore?.get().layout?.[key] as any) ?? {};
  } catch {
    return {};
  }
}

/** 写一段几何；写不进去只记日志，绝不让窗口操作跟着失败 */
function saveBox(key: keyof LayoutConfig, patch: Record<string, unknown>) {
  try {
    configStore?.setLayout({ [key]: patch } as LayoutPatch);
  } catch (e) {
    console.error(`[config] 记住 ${key} 的几何失败`, e);
  }
}

/**
 * 把记过的位置套到这个窗口上。
 *
 * `size=false` 只恢复位置（帮助窗口的高度由内容决定，硬套会把内容裁掉）；
 * 返回值表示「有没有记过」—— 没记过时调用方走原来的摆放逻辑（主窗口旁边 / 屏幕中央）。
 */
function applySavedBounds(w: BrowserWindow, key: keyof LayoutConfig, opts?: { size?: boolean }): boolean {
  const box = savedBox(key);
  if (!box.bounds) return false;
  try {
    const r = clampRect(box.bounds);
    const size = opts?.size !== false;
    w.setBounds(size ? r : { ...w.getBounds(), x: r.x, y: r.y, width: Math.min(w.getBounds().width, r.width), height: Math.min(w.getBounds().height, r.height) });
  } catch {
    return false;
  }
  return true;
}

/** 防抖句柄：拖动窗口时 resize/move 每帧都来，不能每帧写盘 */
const boxTimers = new Map<string, NodeJS.Timeout>();

/**
 * 让这个窗口的几何自动落进 config.json。
 *
 * 最大化时 `getBounds()` 给的是铺满屏幕后的尺寸，记下来就成了「还原也没用」——
 * 所以记 `getNormalBounds()` + `maximized`，下次启动先还原大小再决定要不要最大化。
 * 关窗前同步冲一次：正常退出时 400ms 防抖可能还没到点。
 */
function rememberWindow(key: keyof LayoutConfig, w: BrowserWindow) {
  const flush = () => {
    if (!w || w.isDestroyed()) return;
    try {
      const maximized = w.isMaximized();
      const bounds = maximized ? w.getNormalBounds() : w.getBounds();
      saveBox(key, { bounds, maximized });
    } catch {
      /* 窗口正在销毁：这一帧的几何不要也罢 */
    }
  };
  const later = () => {
    const t = boxTimers.get(key);
    if (t) clearTimeout(t);
    boxTimers.set(key, setTimeout(() => {
      boxTimers.delete(key);
      flush();
    }, 400));
  };
  w.on('resize', later);
  w.on('move', later);
  w.on('maximize', flush);
  w.on('unmaximize', flush);
  w.on('close', () => {
    const t = boxTimers.get(key);
    if (t) {
      clearTimeout(t);
      boxTimers.delete(key);
    }
    flush();
  });
}

/* ---------------- 工作区：抓取 / 应用窗口布局 ---------------- */

/** 把窗口位置夹进某块屏幕的工作区：换显示器 / 改分辨率之后，旧坐标可能落在屏幕外 */
function clampRect(r: Rect): Rect {
  try {
    const area = screen.getDisplayMatching({ x: r.x, y: r.y, width: r.width, height: r.height }).workArea;
    const width = Math.min(r.width, area.width);
    const height = Math.min(r.height, area.height);
    return {
      x: Math.max(area.x, Math.min(r.x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(r.y, area.y + area.height - height)),
      width,
      height,
    };
  } catch {
    return r;
  }
}

function childState(w: BrowserWindow | null) {
  try {
    if (!w || w.isDestroyed()) return { open: false, bounds: null };
    return { open: true, bounds: w.getBounds() };
  } catch {
    return { open: false, bounds: null };
  }
}

/** 当前布局（ui 那部分只有渲染层知道，由调用方传进来） */
function captureLayout(ui: UiState): Layout {
  const bounds = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 1440, height: 900 };
  return {
    v: 1,
    at: Date.now(),
    win: { bounds, maximized: !!win && !win.isDestroyed() && win.isMaximized() },
    ui,
    grid: { ...childState(gridWin), ...lastGridSide },
    help: { ...childState(helpWin), alwaysOnTop: helpAlwaysOnTop },
    history: childState(historyWin),
    lyrics: { ...childState(lyricsWin), alwaysOnTop: lyricsAlwaysOnTop },
    overlay: childState(overlayWin),
  };
}

/**
 * 应用一份布局。
 *
 * 子窗口「新开」时不能立刻 setBounds —— 那时候窗口还没 ready-to-show，
 * 位置会被随后的第一次 show 冲掉，所以要等它真的出来再摆（450ms 足够）。
 */
function applyLayout(layout: Layout) {
  if (!win || win.isDestroyed()) return false;
  try {
    if (layout.win.maximized) win.maximize();
    else {
      win.unmaximize();
      win.setBounds(clampRect(layout.win.bounds));
    }
  } catch (e) {
    console.error('[ws] 恢复主窗口位置失败', e);
  }
  const syncChild = (
    want: { open: boolean; bounds: Rect | null },
    current: () => BrowserWindow | null,
    openFn: () => void,
    closeFn: () => void
  ) => {
    const cur = current();
    if (!want.open) {
      if (cur) closeFn();
      return;
    }
    if (!cur) {
      try {
        openFn();
      } catch (e) {
        console.error('[ws] 打开子窗口失败', e);
        return;
      }
      if (want.bounds) {
        setTimeout(() => {
          const w = current();
          if (!w || w.isDestroyed()) return;
          try {
            w.setBounds(clampRect(want.bounds!));
          } catch {
            /* 窗口已经关了就算了 */
          }
        }, 450);
      }
      return;
    }
    if (want.bounds) {
      try {
        cur.setBounds(clampRect(want.bounds));
      } catch {
        /* 同上 */
      }
    }
  };
  // 独立时间线：需要一首曲子；用它上次打开那首（布局里刻意不记「当前选中」）
  syncChild(
    layout.grid,
    () => gridWin,
    () => {
      if (lastGridTrackId) win?.webContents.send('ws:open-grid', lastGridTrackId);
    },
    () => gridWin?.close()
  );
  /**
   * 泳道侧栏的宽度 / 开合只有那个窗口自己改得了：发一条消息让它套上。
   * 新开的窗口还要等它加载完（450ms 和 syncChild 里摆位置同一个节拍）。
   */
  const pushGridSide = () => {
    const w = gridWin;
    if (!w || w.isDestroyed()) return;
    sendTo(w, 'grid:side', { sideW: layout.grid.sideW, sideOpen: layout.grid.sideOpen });
    lastGridSide = { sideW: layout.grid.sideW, sideOpen: layout.grid.sideOpen };
  };
  pushGridSide();
  if (layout.grid.open) setTimeout(pushGridSide, 500);
  syncChild(layout.help, () => helpWin, () => openHelpWindow(), () => closeHelpWindow());
  try {
    helpAlwaysOnTop = layout.help.alwaysOnTop !== false;
    if (helpWin && !helpWin.isDestroyed()) helpWin.setAlwaysOnTop(helpAlwaysOnTop);
  } catch {
    /* 窗口可能刚关 */
  }
  syncChild(layout.history, () => historyWin, () => openHistoryWindow(), () => closeHistoryWindow());
  // 桌面歌词开着才恢复；它是 overlay 路由的浮窗，位置由 applyLayout 里的 bounds 摆
  syncChild(layout.overlay, () => overlayWin, () => openOverlayWindow(), () => closeOverlayWindow());
  syncChild(
    layout.lyrics,
    () => lyricsWin,
    () => openLyricsWindow(),
    () => closeLyricsWindow()
  );
  try {
    lyricsAlwaysOnTop = layout.lyrics.alwaysOnTop !== false;
    if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.setAlwaysOnTop(lyricsAlwaysOnTop);
  } catch {
    /* 窗口可能刚关 */
  }
  return true;
}

function createWindow() {
  // 高分屏/带鱼屏上，固定 1440×900 会显得很小；按工作区比例给尺寸，但设上限
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(1080, Math.min(1800, Math.round(area.width * 0.82)));
  const height = Math.max(620, Math.min(1150, Math.round(area.height * 0.82)));
  bootLog(`createWindow area=${area.width}x${area.height} win=${width}x${height}`);

  /**
   * 摆在哪：**config.json 记的「上次长什么样」优先**，其次才是手动存的工作区，
   * 最后按屏幕比例算一个默认值（用户 2026-11-22 定的优先级）。
   * 三种都过 clamp：换显示器 / 改分辨率后旧坐标可能落在屏幕外。
   */
  const cfgMain = savedBox('main');
  const lastWin = wsStore?.getLast()?.win ?? null;
  const startRect = cfgMain.bounds
    ? clampRect(cfgMain.bounds)
    : lastWin
      ? clampRect(lastWin.bounds)
      : null;
  win = new BrowserWindow({
    ...(startRect
      ? { x: startRect.x, y: startRect.y, width: startRect.width, height: startRect.height }
      : { width, height, center: true }),
    minWidth: 1080,
    minHeight: 620,
    show: false,
    /**
     * 不用 frame:false 自己画窗口按钮了：Windows 的 titleBarOverlay 直接把系统原生的
     * 最小化/最大化/关闭 叠到网页右上角，鼠标悬停、贴边、高 DPI 缩放全跟着系统走。
     * 代价是右上角约 138px 被占，菜单栏要给窗口按钮留出这块空位。
     */
    titleBarStyle: 'hidden',
    // height 必须和 .titlebar 的高度一致，系统按钮才会正好落在标题行里
    titleBarOverlay: { ...overlayChrome(), height: MAIN_TITLE_H },
    backgroundColor: '#141413',
    // 任务栏 / Alt-Tab 图标。开发模式下 electron.exe 自带的是 Electron 默认图标，
    // 不给的话固定到任务栏也是那个蓝原子；子窗口共用（省略时继承主窗口图标）。
    icon: path.join(app.getAppPath(), 'assets', 'app.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      /**
       * 默认 true：窗口被遮挡/最小化时 Chromium 会把 rAF 降到 1fps 甚至停掉。
       * 播放器在后台本来就该继续出声、继续推进播放头，波形也别冻在那儿。
       * 顺带治一个坑：冒烟窗口被别的窗口压住时，整条渲染链会静默停摆，
       * 表现为「绘制次数 0 / 播放不推进」，看着像代码坏了。
       */
      backgroundThrottling: false,
    },
  });
  bootLog('BrowserWindow created');

  win.once('ready-to-show', () => {
    bootLog('ready-to-show');
    // 上次是最大化状态就照着最大化（位置已经在构造函数里给了）；
    // 最大化这件事以 config.json 为准，它记的是「最后一眼」的样子
    const wantMax = typeof cfgMain.maximized === 'boolean' ? cfgMain.maximized : lastWin?.maximized;
    if (wantMax) win?.maximize();
    // 冒烟：先透明再显示 —— `show()` 之后再设会闪一下（人眼能看见）
    if (SMOKE_MODE && !SMOKE_VISIBLE) win?.setOpacity(0);
    win?.show();
    // 冒烟：窗口真的出现之后再上沙箱（原生句柄这时才存在，鼠标穿透才生效）
    quietWindow(win);
  });
  win.once('show', () => bootLog(`shown visible=${win?.isVisible()} bounds=${JSON.stringify(win?.getBounds())}`));
  /**
   * 先级联再置空：`closed` 里主窗口已经销毁，子窗口若还留着就再也没有宿主。
   * 置空 `win` 之后，子窗口的 `closed` 回调里那些 `sendTo(win, …)` 都会安全地落空。
   */
  // 窗口一建就开始记：拖动、最大化、关窗前各存一次（防抖 400ms）
  rememberWindow('main', win);
  win.once('closed', () => {
    bootLog('closed');
    if (win && !win.isDestroyed()) return;
    win = null;
    closeChildWindows();
  });
  win.webContents.on('did-finish-load', () => bootLog('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    bootLog(`did-fail-load code=${code} desc=${desc} url=${url}`)
  );
  win.webContents.on('render-process-gone', (_e, d) => bootLog(`render-process-gone ${JSON.stringify(d)}`));
  win.webContents.on('preload-error', (_e, p, err) => bootLog(`preload-error ${p} ${String(err)}`));
  onConsoleMessage(win.webContents, (level, msg) => {
    if (level === 'error' || level === 'warning') bootLog(`renderer console ${level}: ${msg}`);
  });

  // 兜底：ready-to-show 迟迟不来（渲染层加载失败时不会触发）就先把窗口亮出来，
  // 否则用户看到的是「双击了没反应」——进程在跑、界面永远藏在 show:false 里。
  const showTimer = setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      bootLog('fallback show (ready-to-show never fired)');
      win.show();
      quietWindow(win);
    }
  }, 2500);
  win.once('show', () => clearTimeout(showTimer));

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL).catch((e) => bootLog(`loadURL failed: ${String(e)}`));
  } else {
    const page = path.join(__dirname, '../renderer/index.html');
    bootLog(`loadFile ${page} exists=${fs.existsSync(page)}`);
    win.loadFile(page).catch((e) => bootLog(`loadFile failed: ${String(e)}`));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * 启动日志。
 *
 * 双击 start.cmd 时控制台是脱离的，stdout 没人看得到 ——
 * 「窗口没出来」这类问题只能靠落盘日志定位。
 * 追加写、带 pid：多实例时才能看出到底是哪一个在说话。
 */
function bootLog(msg: string) {
  try {
    const dir = path.join(app.getAppPath(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'boot.log'),
      `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`
    );
  } catch {
    /* 写不了日志不能挡住启动 */
  }
}

/**
 * 冒烟进度落盘（仓库根的 `.smoke-run.json`），给 `npm run smoke:status` 读。
 *
 * 冒烟窗口现在是**完全透明 + 鼠标穿透 + 不进任务栏**的 —— 看不见、点不到、任务栏里也没有，
 * 所以必须有一个「它还在跑吗、跑到第几条、最近一条是什么」的出口。状态文件就是这个出口。
 *
 * 每 400ms 最多写一次：386 条断言逐条同步写盘，比断言本身还贵。
 * `done: true` 时强制写 —— 那一笔不能丢（用户看到的就是「上一次跑完的结果」）。
 */
let smokeRunPatch: Record<string, unknown> = {};
let smokeRunWriteAt = 0;

function publishSmokeProgress(patch: Record<string, unknown>) {
  if (!SMOKE_MODE) return;
  smokeRunPatch = { ...smokeRunPatch, ...patch, pid: process.pid, updatedAt: Date.now() };
  const must = patch.done === true;
  if (!must && Date.now() - smokeRunWriteAt < 400) return;
  smokeRunWriteAt = Date.now();
  try {
    fs.writeFileSync(path.join(app.getAppPath(), '.smoke-run.json'), JSON.stringify(smokeRunPatch, null, 2));
  } catch {
    /* 写不了状态文件不该影响测试 */
  }
}

/**
 * `console-message` 的两种签名都认。
 *
 * Electron 35 起回调改成了**事件对象**（`e.level` 是 'info' / 'warning' / 'error' / 'debug'），
 * 老的 `(_e, level, message)` 里那个 `level` 会变成字符串 —— 于是 `level >= 2` 静默变成 false。
 * 这不是「少记一条日志」：冒烟末尾那条「渲染层零未捕获异常」的硬断言就是靠它收集的，
 * 守卫自己失灵比没有守卫更危险（HANDOFF 红线第 2 条：静默拦截最可怕）。
 * 两种形态都认，以后升级 / 回退都不用再碰这里。
 */
function onConsoleMessage(
  wc: WebContents,
  fn: (level: 'error' | 'warning' | 'info' | 'debug', message: string) => void
) {
  wc.on('console-message', ((...args: unknown[]) => {
    const first = args[0] as any;
    if (first && typeof first === 'object' && 'level' in first && 'message' in first) {
      fn(String(first.level) as any, String(first.message ?? ''));
      return;
    }
    // 旧签名：数字 0=verbose 1=info 2=warning 3=error
    const n = Number(args[1]);
    fn(n >= 3 ? 'error' : n === 2 ? 'warning' : 'info', String(args[2] ?? ''));
  }) as any);
}

async function smoke() {
  // 冒烟：先跑真实区间的读写断言，再截图人工核对外观。
  // 断言直接查数据库，不看 DOM —— 截图只能证明「没崩」，不能证明数值对。
  const outDir = path.join(app.getAppPath(), 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  publishSmokeProgress({ startedAt: Date.now(), done: false, passed: 0, failed: 0, last: '启动完成，准备跑第一条' });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * 轮询等一个条件成立，最多约 `budget` 毫秒。
   * 给「窗口状态类」断言用：setAlwaysOnTop 走的是系统调用，
   * 落到 isAlwaysOnTop() 的可见延迟并不固定（实测偶尔超过 400ms），
   * 固定 sleep 就会变成偶发假失败 —— 这类抖动不该记在功能账上。
   */
  const until = async (fn: () => boolean, budget = 2500, step = 60): Promise<boolean> => {
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
      if (fn()) return true;
      await wait(step);
    }
    return fn();
  };
  const shot = async (name: string) => {
    const img = await win!.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    console.log(`[smoke] shots/${name}`);
  };
  /** 子窗口截图（`shot` 只拍主窗口） */
  const shotOf = async (w: BrowserWindow | null, name: string) => {
    if (!w || w.isDestroyed()) return;
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), img.toPNG());
    console.log(`[smoke] shots/${name}`);
  };
  const js = async (code: string) => {
    try {
      return await win!.webContents.executeJavaScript(code);
    } catch (e) {
      console.error('[smoke] js 失败：', code.slice(0, 90), e);
      throw e;
    }
  };


  /**
   * 渲染层未捕获异常收集器。
   *
   * 为什么非要有它：v0.14 交付时 `api.openLyrics()` 拼错了命名空间（实际在 api.win 下），
   * 在 onMounted 里抛 TypeError，把后面的 loadRows() 整个中断掉 ——
   * 界面停在「没有匹配的曲目 / 0 条结果 / 没有分析档案」，像数据全丢了。
   * 而当时 121 项断言**全绿**：查库的查库、量几何的量几何，没有一条看异常。
   * 所以这条守卫必须在**最开头**装，末尾统一断言：一条 TypeError 也不许有。
   */
  const rendererErrors: string[] = [];
  /**
   * Chromium 的**性能建议**不是异常，不能算进「零未捕获异常」。
   *
   * `bandDiff()`（只在冒烟里用）会把主画布的一块 drawImage 到 CPU 小画布再 getImageData，
   * 浏览器因此打一条「建议给 willReadFrequently」的警告。主画布必须留在 GPU 上
   * （见 GridEditor 的 draw()），所以这条警告是调试钩子的固定代价，不是应用错误。
   */
  const IGNORED_RENDERER_WARNINGS = [/^Canvas2D: Multiple readback operations using getImageData/];
  onConsoleMessage(win!.webContents, (level, msg) => {
    // 这里必须照旧收 warning 及以上：冒烟末尾那条「零异常」断言全靠它
    if (level !== 'error' && level !== 'warning') return;
    if (IGNORED_RENDERER_WARNINGS.some((re) => re.test(msg))) return;
    rendererErrors.push(msg);
  });
  win!.webContents.on('render-process-gone', (_e, d) =>
    rendererErrors.push(`render-process-gone ${JSON.stringify(d)}`)
  );
  win!.webContents.on('preload-error', (_e, p, err) => rendererErrors.push(`preload-error ${p} ${String(err)}`));

  const rows = (sql: string, ...params: any[]) => handle.db.prepare(sql).all(...params) as any[];
  /**
   * 物理删掉一首曲目时，连它的 JSON 一起删。
   *
   * 只删库不删文件的话，下次启动 `seedFromTracks` 会把这份孤儿 JSON 当新曲目再导进来 ——
   * 表现就是「删掉的测试曲目自己回来了」，而且带着一个没人认识的 uuid。
   */
  const dropTrackJson = (id: string) => {
    const dir = path.join(dataDir, 'tracks');
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      const abs = path.join(dir, f);
      try {
        const doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (doc?.uuid === id) fs.unlinkSync(abs);
      } catch {
        /* 坏文件留给启动补齐去处理 */
      }
    }
  };
  const results: string[] = [];
  let passCount = 0;
  let failCount = 0;
  const check = (name: string, ok: boolean, detail: unknown) => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(detail)}`);
    // 失败当场落一行：中途抛异常 / 被死线打断时，最后的汇总永远打不出来，
    // 只有计数没有名字的冒烟等于没跑（这次 Electron 44 的 CORS 回归就踩到了）。
    if (!ok) console.error(`[smoke] FAIL  ${name}  ${JSON.stringify(detail)}`);
    if (ok) passCount++;
    else failCount++;
    publishSmokeProgress({ passed: passCount, failed: failCount, last: name, lastOk: ok });
  };
  const chord = () =>
    rows(
      `SELECT tick, dur_ticks, text FROM analysis_event
        WHERE analysis_id = ? AND lane = 'degree' AND tick BETWEEN 15000 AND 18000 ORDER BY tick`,
      analysisId
    );

  /**
   * 冒烟固定测「神鹿谣」：它有音频、107 BPM、**全程 3/4**（一小节 1440 tick），
   * 第 12 小节只是 A1 段的起点（15840 = 11×1440），不是变拍号的地方。
   * 不能用 LIMIT 1 —— 库里现在有三首，rowid 顺序和 UI 的 title_sort 顺序不一致，
   * 断言查 A 首、界面显示 B 首，会得到一堆「数据没动」的假失败。
   */
  const targetTitle = '神鹿谣';  const target = handle.db
    .prepare(
      `SELECT t.id AS trackId, a.id AS analysisId
         FROM track t JOIN analysis a ON a.track_id = t.id AND a.deleted_at IS NULL
        WHERE t.title = ?`
    )
    .get(targetTitle) as any;
  if (!target) throw new Error(`冒烟需要「${targetTitle}」这首，data/tracks 里没导入`);
  const analysisId = target.analysisId as string;
  const trackId = target.trackId as string;

  /**
   * 清掉历代冒烟留下的临时曲目（`smoke-edit*`、改了名的「草稿 A」）。
   *
   * 两个原因都必须清：
   * 1. 分析档案留着，它的调性会被「自然小调」这类搜索数进去，期望值就对不上；
   * 2. 以前删除只做软删、也不进归档，于是十几轮跑下来库里攒了上百条
   *    `deleted_at IS NOT NULL` 的「草稿 A」—— 列表看不见，但 COUNT 一查就露馅，
   *    而且永远没人能清掉它们。现在走 `purgeArchived`：行、档案、录音、归档文件一起清。
   */
  const stale = handle.db
    .prepare(`SELECT id FROM track WHERE title LIKE 'smoke-edit%' OR title = '草稿 A'`)
    .all() as any[];
  for (const s of stale) {
    purgeArchived({ db: handle.db, dataDir }, s.id);
    dropTrackJson(s.id);
  }
  if (stale.length) console.log(`[smoke] 清理历代残留的临时曲目 ${stale.length} 条`);

  /**
   * 「JSON 是源」的第一条断言：库里每一首在册曲目都必须有一份 uuid 对得上的 JSON。
   *
   * 这条能抓住两类回归：
   * 1. 启动补齐没跑 / 抛了异常 —— 老库里的 manual 曲目会一直缺档案；
   * 2. 写回时算错了文件名 —— 会多出一份空壳或另一份同名副本（下面按曲名再数一次）。
   */
  const jsonDir = path.join(dataDir, 'tracks');

  /**
   * 同名老档案自愈（`tools/smoke.mjs` 启动前塞了两份同名、无 uuid 的档案）。
   *
   * 旧逻辑按标题算哈希当 id：两份同名 → 同一个 id → 第二份 `skipped`，
   * 也就是列表里少一首、日志里只是一句「已存在跳过 N 首」。这条断言就是钉住这个行为。
   *
   * 注意只认这两份文件：启动补齐会另外给「没有 uuid 的那条记录」写一份新 JSON，
   * 那是补齐的正常行为，不在这条断言的范围里。
   */
  const pairTitle = '冒烟同名·秋';
  const pairFiles = ['冒烟同名 1.json', '冒烟同名 2.json'].map((f) => {
    try {
      return { f, doc: JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8')) };
    } catch {
      return { f, doc: null as any };
    }
  });
  const pairRows = rows(`SELECT id FROM track WHERE title = ? AND deleted_at IS NULL`, pairTitle);
  const pairUuidFiles = pairFiles.filter((p) => p.doc?.uuid);
  check(
    '同名老档案（都无 uuid）：两份都进库、id 不同，后来那份把新 uuid 写回了自己的 JSON',
    pairRows.length === 2 &&
      new Set(pairRows.map((r: any) => r.id)).size === 2 &&
      pairUuidFiles.length === 1 &&
      pairRows.some((r: any) => r.id === pairUuidFiles[0]?.doc?.uuid),
    { rows: pairRows, files: pairFiles.map((p) => ({ f: p.f, uuid: p.doc?.uuid ?? null })) }
  );
  // 这两首是冒烟自己注入的：断言完就清掉，后面所有断言看到的仍是用户的真实曲库
  for (const r of pairRows) {
    purgeArchived({ db: handle.db, dataDir }, r.id);
    dropTrackJson(r.id);
  }
  for (const p of pairFiles) fs.rmSync(path.join(jsonDir, p.f), { force: true });

  const jsonDocs = (() => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(jsonDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [] as { file: string; doc: any }[];
    }
    const out: { file: string; doc: any }[] = [];
    for (const f of files) {
      try {
        out.push({ file: f, doc: JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8')) });
      } catch {
        /* 坏文件由下面的「缺失」断言兜住 */
      }
    }
    return out;
  })();
  const jsonUuids = new Set(jsonDocs.map((j) => j.doc?.uuid).filter(Boolean));
  const missingJson = rows(`SELECT id, title FROM track WHERE deleted_at IS NULL`).filter(
    (r) => !jsonUuids.has(r.id)
  );
  check(
    '库里每首曲目都有 uuid 对得上的 JSON（启动补齐生效）',
    missingJson.length === 0,
    missingJson.map((r) => r.title)
  );
  const shenluFiles = jsonDocs.filter((j) => j.doc?.uuid === trackId).map((j) => j.file);
  check(
    '老档案被认领：神鹿谣只有一份 JSON，没有因为补 uuid 多出副本',
    shenluFiles.length === 1 && shenluFiles[0] === '神鹿谣.json',
    shenluFiles
  );

  // 冒烟会写真实数据，所以先存快照，结束时原样还回去
  const before = rows(
    `SELECT id, lane, tick, dur_ticks AS durTicks, text, confidence FROM analysis_event WHERE analysis_id = ?`,
    analysisId
  );

  // 早期手工调试留下的三个假事件（文本固定为 as / aaa / dsda），只清这三条
  const junk = handle.db
    .prepare(`DELETE FROM analysis_event WHERE text IN ('as','aaa','dsda')`)
    .run();
  if (junk.changes) console.log(`[smoke] 清理调试事件 ${junk.changes} 条`);

  // 让断言从确定状态开始：被测区间（第 12 小节起，往后 8 小节）整段清空，结束时整体还原。
  // 上次跑到一半崩了会留下 I / ii / vi 这些同名事件，只清一小段的话，
  // 「按 text 查一行」会挑到旧的那条，断言就假失败（甚至报 undefined）。
  const cleared = handle.db
    .prepare(`DELETE FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' AND tick >= 15000 AND tick < 30000`)
    .run(analysisId);
  if (cleared.changes) console.log(`[smoke] 清空被测小节 ${cleared.changes} 条（结束后还原）`);

  // 缩放：设 1.15 再读回，确认原生缩放生效后归位
  const z = await js(`window.api.ui.setZoom(1.15)`);
  const zBack = await js(`window.api.ui.getZoom()`);
  check('ui zoom 1.15 生效', Math.abs(zBack - 1.15) < 0.01, { set: z, read: zBack });
  await js(`window.api.ui.setZoom(1)`);

  // 界面切到被测曲目，并强制深色：主题存在 localStorage 里，
  // 上一轮如果停在浅色，「切浅色」这条断言就会拿浅色当基准，永远不可能通过。
  // 语言同理：上一轮若停在英文（或跑一半崩在英文），后面所有中文文案断言都会假失败。
  await js(`window.__app.lang('zh')`);
  // 面板开合也是持久化状态（localStorage）。上一轮若崩在「面板关掉」之后，
  // 这一轮下面那条 DOM 高度断言会拿到 0 —— 跟功能没关系，纯粹是没归位。
  await js(`window.__app.panel(true)`);
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await js(`window.__app.setTheme('dark')`);
  await wait(1200);
  await shot('smoke-table.png');

  // 底部面板：默认打开、能拖高度（真实状态 → DOM 高度）
  const openedPanel = await js(`!!document.querySelector('.dock')`);
  const hState = await js(`window.__app.setPanelHeight(300)`);
  await wait(150);
  const hDom = await js(`Math.round(document.querySelector('.dock').getBoundingClientRect().height)`);
  check('底部网格面板可拖到 300px', openedPanel === true && hState === 300 && Math.abs(hDom - 300) <= 1, {
    openedPanel,
    hState,
    hDom,
  });

  await js(`window.__app.panel(false)`);
  await wait(160);
  const collapsed = await js(`!document.querySelector('.dock')?.checkVisibility()`);
  check('面板可收起', collapsed === true, collapsed);
  await js(`window.__app.panel(true)`);
  await js(`window.__app.setPanelHeight(330)`);
  await wait(200);

  /* ---- 下方面板与表格是上下分栏（不再浮在表格上）----
   * 以前 `.dock` 是 absolute，表格的纵向滚动条下半截被盖住、点不到；
   * 这里量的是「表格底边 + 滚动条底边」都在面板上边之上。
   */
  const splitGeo = (await js(`(() => {
    const dock = document.querySelector('.dock');
    const pane = document.querySelector('.table-pane');
    const tbody = document.querySelector('.tbody');
    const d = dock.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    return {
      dockPos: getComputedStyle(dock).position,
      dockTop: Math.round(d.top),
      paneBottom: Math.round(p.bottom),
      tbodyBottom: Math.round(tbody.getBoundingClientRect().bottom),
    };
  })()`)) as any;
  check(
    '下方面板与表格上下分栏：表格（含滚动条）完整露在面板之上，不再被覆盖',
    splitGeo?.dockPos !== 'absolute' &&
      splitGeo?.paneBottom <= splitGeo?.dockTop + 1 &&
      splitGeo?.tbodyBottom <= splitGeo?.dockTop + 1,
    splitGeo
  );

  /* ---- 细滚动条：常态 4px、hover 12px、200ms 过渡，并且拖得动 ---- */
  const barInit = (await js(`(async () => {
    const t = document.querySelector('.tbody');
    const over = t.scrollHeight > t.clientHeight + 1;
    // 数据不够长时临时把可视高度压小，造出溢出（测完还原，不影响后面的断言）
    if (!over) {
      t.dataset.tmpShrink = '1';
      t.style.maxHeight = Math.max(80, Math.floor(t.clientHeight / 2)) + 'px';
    }
    t.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const rect = t.getBoundingClientRect();
    return {
      over,
      scrollable: t.scrollHeight > t.clientHeight + 1,
      right: Math.round(rect.right),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
    };
  })()`)) as any;
  await wait(120);
  const barGeo = (await js(`(() => {
    const bars = [...document.querySelectorAll('.slim-track-v')]
      .map((b) => {
        const r = b.getBoundingClientRect();
        const th = b.querySelector('.slim-thumb');
        const cs = getComputedStyle(th);
        return {
          left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom),
          w: Math.round(r.width),
          thumbW: Math.round(th.getBoundingClientRect().width),
          ease: cs.transitionDuration,
        };
      })
      .filter((b) => b.w > 0);
    // 取贴在表格右缘、纵向范围与表格一致的那一条
    const hit = bars
      .filter((b) => Math.abs(b.left + b.w - ${barInit?.right ?? 0}) <= 2)
      .sort((a, b) => Math.abs(a.top - ${barInit?.top ?? 0}) - Math.abs(b.top - ${barInit?.top ?? 0}))[0];
    return { bars, hit };
  })()`)) as any;
  check(
    '细滚动条：默认视觉 4px，热区 20px（5 倍），过渡 200ms（Chromium 原生滚动条做不到这个过渡）',
    barGeo?.hit?.w === 20 && barGeo?.hit?.thumbW === 4 && /^0\.2s/.test(String(barGeo?.hit?.ease ?? '')),
    { barInit, hit: barGeo?.hit }
  );

  // 真 hover：鼠标移到条上，滑块应展开到 12px（= 3 倍）
  let barHover: any = null;
  if (barGeo?.hit) {
    win!.webContents.sendInputEvent({
      type: 'mouseMove',
      x: barGeo.hit.left + 10,
      y: Math.round((barGeo.hit.top + barGeo.hit.bottom) / 2),
    });
    await wait(360);
    barHover = await js(`(() => {
      const bars = [...document.querySelectorAll('.slim-track-v')].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && Math.abs(r.left + r.width - ${barInit?.right ?? 0}) <= 2;
      });
      const hit = bars[0];
      const probe = document.elementFromPoint(${barGeo.hit.left + 10}, ${Math.round((barGeo.hit.top + barGeo.hit.bottom) / 2)});
      return {
        w: hit ? Math.round(hit.querySelector('.slim-thumb').getBoundingClientRect().width) : null,
        at: probe ? (probe.className || probe.tagName) : null,
        hovered: [...document.querySelectorAll(':hover')].map((e) => e.className || e.tagName).slice(-4),
      };
    })()`);
    await shot('smoke-slim-scroll.png');
    win!.webContents.sendInputEvent({ type: 'mouseMove', x: 700, y: 300 });
    await wait(300);
  }
  check('鼠标靠近滚动条：滑块从 4px 平滑展开到 20px（5 倍），离开再缩回', (barHover as any)?.w === 20, { barHover });

  // 拖动滑块 → 内容跟着滚（拖到底时滑块底边贴住轨道底边，不差一截）
  const barDrag = (await js(`(async () => {
    const t = document.querySelector('.tbody');
    const bar = [...document.querySelectorAll('.slim-track-v')].find((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && Math.abs(r.left + r.width - ${barInit?.right ?? 0}) <= 2;
    });
    if (!bar) return { noBar: true };
    const th = bar.querySelector('.slim-thumb');
    const before = t.scrollTop;
    const tr = bar.getBoundingClientRect();
    // 直接把滑块拖到轨道底部（等价于“拖到底”）
    const x = tr.left + 10;
    const y0 = th.getBoundingClientRect().top + th.getBoundingClientRect().height / 2;
    const y1 = tr.bottom - 2;
    th.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y0 }));
    await new Promise((r) => setTimeout(r, 30));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x, clientY: y1 }));
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: x, clientY: y1 }));
    await new Promise((r) => setTimeout(r, 120));
    const after = t.scrollTop;
    const max = t.scrollHeight - t.clientHeight;
    const thumbBottom = th.getBoundingClientRect().bottom;
    return {
      before, after, max,
      atBottom: after >= max - 2,
      thumbFlush: Math.abs(thumbBottom - tr.bottom) <= 2,
    };
  })()`)) as any;
  check(
    '拖细滚动条：能一直拖到底（滑块底边贴住轨道底边，内容滚到最末）',
    barDrag?.before === 0 && barDrag?.atBottom === true && barDrag?.thumbFlush === true,
    barDrag
  );
  // 还原临时压小的可视高度与滚动位置
  await js(`(() => {
    const t = document.querySelector('.tbody');
    if (t?.dataset?.tmpShrink) { t.style.maxHeight = ''; delete t.dataset.tmpShrink; }
    t.scrollTop = 0;
  })()`);
  await wait(160);

  // 第 12 小节是 A1 起点（全程 3/4，一小节 1440）：15840 = 第 1 格，16320 / 16800 依次后推
  await js(`window.__ma.select(12, 0, 1)`);
  await js(`window.__ma.fill('I')`);
  await wait(220);
  check('区间写入 2 格 → 一条 960 tick 的 I', JSON.stringify(chord()) === JSON.stringify([{ tick: 15840, dur_ticks: 960, text: 'I' }]), chord());

  // 只改第 2 格：I 必须截短成 1 格，而不是整条消失
  await js(`window.__ma.select(12, 1, 1)`);
  await js(`window.__ma.fill('vi')`);
  await wait(220);
  check(
    '覆盖第 2 格 → I 截短为 480，新增 vi',
    JSON.stringify(chord()) ===
      JSON.stringify([
        { tick: 15840, dur_ticks: 480, text: 'I' },
        { tick: 16320, dur_ticks: 480, text: 'vi' },
      ]),
    chord()
  );

  // 删除第 2 格：vi 消失，I 不自动长回去（裁剪语义，恢复交给撤销）
  await js(`window.__ma.del()`);
  await wait(220);
  check('删除第 2 格 → 只剩 480 的 I', JSON.stringify(chord()) === JSON.stringify([{ tick: 15840, dur_ticks: 480, text: 'I' }]), chord());

  await js(`window.__ma.undo()`);
  await wait(240);
  const undo1 = chord();
  check('撤销一次 → vi 回来（快照恢复，不是猜）', undo1.length === 2 && undo1[1]?.text === 'vi', undo1);

  await js(`window.__ma.undo()`);
  await wait(240);
  const undo2 = chord();
  check('撤销两次 → I 恢复成 960', undo2.length === 1 && undo2[0]?.dur_ticks === 960, undo2);

  // 用户说的场景：3/4 前两拍主和弦、第三拍属和弦
  await js(`window.__ma.select(12, 2, 2)`);
  await js(`window.__ma.fill('V7')`);
  await wait(220);
  check(
    '3/4：前两拍 I + 第三拍 V7',
    JSON.stringify(chord()) ===
      JSON.stringify([
        { tick: 15840, dur_ticks: 960, text: 'I' },
        { tick: 16800, dur_ticks: 480, text: 'V7' },
      ]),
    chord()
  );

  // 单选一条 + 按 id 删除（工具栏删除按钮走的就是这条路）
  const v7row = rows(`SELECT id FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='V7'`, analysisId)[0];
  if (v7row) {
    await js(`window.__ma.deleteIds(${JSON.stringify([v7row.id])})`);
    await wait(200);
    check('按 id 删除单条事件', chord().every((r: any) => r.text !== 'V7'), chord());
    await js(`window.__ma.undo()`);
    await wait(240);
    check('撤销恢复被删的 V7', chord().some((r: any) => r.text === 'V7'), chord());

    /* ---- 删除 → 撤销：重做按钮必须亮，且点了真的能再删一次（用户报的 bug） ---- */
    await wait(260); // 等界面把「重拉详情 → 同步按钮状态」走完
    const canAfterUndo = (await js(`window.api.history.can(${JSON.stringify(analysisId)})`)) as any;
    const uiCanAfterUndo = (await js(`window.__ma.histCan()`)) as any;
    const menuAfterUndo = (await js(`window.__app.histMenu()`)) as any;
    const histProbe = (await js(`window.__ma.histProbe()`)) as any;
    console.log('[smoke] 历史订阅诊断', JSON.stringify(histProbe));
    check(
      '删除 → 撤销之后：网格的重做按钮与菜单的重做都亮起（三处状态一致）',
      canAfterUndo?.redo === true &&
        uiCanAfterUndo?.redo === true &&
        menuAfterUndo?.redo === true &&
        chord().some((r: any) => r.text === 'V7'),
      { can: canAfterUndo, uiCan: uiCanAfterUndo, menu: menuAfterUndo, probe: histProbe, chord: chord() }
    );

    const redoRes = (await js(`window.__ma.redo()`)) as any;
    await wait(240);
    check(
      '点重做确实把 V7 再删掉（按钮不是只好看）',
      redoRes === 'true' && chord().every((r: any) => r.text !== 'V7'),
      { redoRes, chord: chord() }
    );
    await js(`window.__ma.undo()`);
    await wait(240);
  }

  // ---- 格单位 = 小节 ----
  const divBar = await js(`window.__ma.unit('bar')`);
  await js(`window.__ma.select(12, 0, 0)`);
  const selBar = await js(`window.__ma.selection()`);
  check(
    '单位=小节：一格就是整小节（1440 tick）',
    divBar === 0 && selBar.endTick - selBar.startTick === 1440,
    { divBar, selBar }
  );

  // ---- Enter 顺延：框 2 格 → 写入 → 回车 → 后移 2 格并继续开输 ----
  await js(`window.__ma.unit('beat')`);
  await js(`window.__ma.select(14, 0, 1)`);
  const advRaw = await js(`window.__ma.type('IV')`);
  const adv = typeof advRaw === 'string' ? JSON.parse(advRaw) : advRaw;
  await wait(260);
  const iv = rows(
    `SELECT tick, dur_ticks, text FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='IV'`,
    analysisId
  );
  check(
    'Enter 后选区后移同样格数（2 格），并已打开输入框',
    adv?.startTick === 19680 && adv?.endTick === 20640 && (await js(`window.__ma.editing()`)) === '',
    { adv, editing: await js(`window.__ma.editing()`) }
  );
  check('Enter 写入的是原来的 2 格', JSON.stringify(iv) === JSON.stringify([{ tick: 18720, dur_ticks: 960, text: 'IV' }]), iv);

  // ---- Backspace：退回一格并开输 ----
  const back = await js(`window.__ma.back()`);
  const backEditing = await js(`window.__ma.editing()`);
  check(
    'Backspace 退回一格（19200–19680）并进入输入',
    back?.startTick === 19200 && back?.endTick === 19680 && backEditing === '',
    { back, backEditing }
  );
  await js(`window.__ma.clear()`);
  await wait(120);

  /* ---- 终止四六 K46：写库 → 解析 → 详情栏说法（属功能、原位、音从低到高） ---- */
  await js(`window.__ma.clear()`);
  await js(`window.__ma.select(20, 0, 0)`);
  await js(`window.__ma.type('K46')`);
  await wait(240);
  const cadRow = rows(
    `SELECT tick, text, parsed FROM analysis_event WHERE analysis_id = ? AND text = 'K46'`,
    analysisId
  )[0] as any;
  const cad = cadRow?.parsed ? JSON.parse(cadRow.parsed) : null;
  check(
    'K46 落库并被解析为终止四六：属功能、原位、三个音从低到高',
    cad?.ok === true &&
      cad?.cadential === true &&
      cad?.degree === 5 &&
      cad?.inversion === 0 &&
      cad?.toneNames?.length === 3 &&
      cad?.rootName === 'G',
    { tick: cadRow?.tick, root: cad?.rootName, tones: cad?.toneNames, inv: cad?.inversion }
  );
  await js(`window.__ma.undo()`);
  await wait(200);

  /* ---- 级数泳道的补全：输入 K 给 Cad64，并点明 K46 是另一套体系的写法 ---- */
  await js(`window.__ma.clear()`);
  await js(`window.__ma.select(20, 0, 0)`);
  await js(`window.__ma.openEdit('')`);
  await wait(90);
  await js(`(() => {
    const el = document.querySelector('.cell-input');
    if (!el) return false;
    el.value = 'K';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(140);
  const cadSug = await js(`window.__ma.cellSugState()`);
  check(
    '级数泳道输入 K：候选第一条是 Cad64，并提示 K46 是本套体系写法',
    cadSug?.open === true && cadSug?.items?.[0]?.value === 'Cad64' && /K46/.test(cadSug.items[0]?.hint ?? ''),
    cadSug
  );
  await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await wait(140);
  check('候选采纳：输入框变成 Cad64（再回车才落库，不是一次回车换字）', (await js(`window.__ma.editing()`)) === 'Cad64', {
    text: await js(`window.__ma.editing()`),
  });
  await js(`window.__ma.clear()`);

  /* ---- 补全框溢出边界（v0.43）：面板矮的时候不能把候选框裁掉，也不能被别人盖住 ---- */
  await js(`window.__app.setPanelHeight(140)`);
  await wait(280);
  await js(`window.__ma.select(20, 0, 0)`);
  await js(`window.__ma.openEdit('')`);
  await wait(140);
  await js(`(() => {
    const el = document.querySelector('.cell-input');
    if (!el) return false;
    el.value = 'V';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(200);
  const sugBoxUI = (await js(`(() => {
    const ul = document.querySelector('.key-sug');
    if (!ul) return null;
    const r = ul.getBoundingClientRect();
    const cs = getComputedStyle(ul);
    // 取框内靠上的一个点做命中测试：落在它上面的元素必须还是候选框自己
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + 10));
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      vw: innerWidth, vh: innerHeight,
      items: ul.querySelectorAll('li').length,
      pos: cs.position, z: cs.zIndex,
      parent: ul.parentElement ? ul.parentElement.tagName : '',
      hitInside: !!hit && (hit === ul || ul.contains(hit)),
      hitWhat: hit ? String(hit.className || hit.tagName).slice(0, 40) : '',
    };
  })()`)) as any;
  check(
    '补全框永远留在窗口里（下面装不下就翻到输入框上方），一列候选都不被切掉',
    !!sugBoxUI &&
      sugBoxUI.items >= 6 &&
      sugBoxUI.top >= 0 &&
      sugBoxUI.bottom <= sugBoxUI.vh &&
      sugBoxUI.left >= 0 &&
      sugBoxUI.right <= sugBoxUI.vw,
    sugBoxUI
  );
  check(
    '补全框不会被详情条/播放条盖住：命中测试落在候选框自己身上（fixed + 高 z-index）',
    !!sugBoxUI && sugBoxUI.hitInside === true && sugBoxUI.pos === 'fixed' && Number(sugBoxUI.z) >= 50,
    { hit: sugBoxUI?.hitWhat, pos: sugBoxUI?.pos, z: sugBoxUI?.z, parent: sugBoxUI?.parent }
  );
  await js(`window.__ma.clear()`);
  await js(`window.__app.setPanelHeight(320)`);
  await wait(220);

  /* ---- 重升 / 重降：库里能写 C𝄪7、解析器认得、派生拼写也用 𝄪 ---- */
  /**
   * 这一段**不走界面输入**，直接写库：
   * 走输入框要走「聚焦 → 改值 → blur → 提交 → 父组件重拉详情」整条异步链，
   * 中间任何一环慢一拍读到的就是空的（这条断言前两版都栽在这儿）。
   * 输入路径本身已经由上面几十条断言覆盖，这里要验的是**解析 + 绘制**。
   */
  await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(180);
  await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('字母和弦'))?.click()`);
  await wait(420);
  /* ---- 字母和弦泳道：v2 词表只有 letters + accidentals，候选必须真的出得来 ---- */
  await js(`window.__ma.clear()`);
  await js(`window.__ma.select(21, 0, 0)`);
  await js(`window.__ma.openEdit('')`);
  await js(`(() => {
    const el = document.querySelector('.cell-input');
    if (!el) return;
    el.value = 'C';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(220);
  const letterSug = (await js(`window.__ma.cellSugState()`)) as any;
  check(
    '字母和弦泳道打 C → 候选第一条是 C，且 7sus4 / 69 都在（v2 词表不再失效）',
    letterSug?.open === true &&
      letterSug.items?.[0]?.value === 'C' &&
      letterSug.items.some((x: any) => x.value === 'C7sus4') &&
      // 字母泳道写 C69（没有数字低音歧义）；级数泳道仍要 V(6/9)，见下面那条
      letterSug.items.some((x: any) => x.value === 'C69'),
    letterSug
  );
  await js(`(() => {
    const el = document.querySelector('.cell-input');
    if (!el) return;
    el.value = 'C7b9';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(200);
  const letterFlat = (await js(`window.__ma.cellSugState()`)) as any;
  check(
    '字母和弦打 C7b9 → 候选用词表里的规范写法 C7♭9（别名参与匹配）',
    letterFlat?.items?.[0]?.value === 'C7♭9',
    letterFlat
  );
  /* ---- 单字母缩写（v0.79）：`Cj` 出整串大和弦、`Ca` 先给增和弦 ---- */
  const sugFor = async (text: string) => {
    await js(`(() => {
      const el = document.querySelector('.cell-input');
      if (!el) return;
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(200);
    return (await js(`window.__ma.cellSugState()`)) as any;
  };
  const wantMaj = ['Cmaj7', 'Cmaj9', 'Cmaj13', 'Cmaj♯11', 'Cmaj13(♯11)', 'Cmaj11'];
  const sugJ = await sugFor('Cj');
  check(
    '字母和弦打 Cj → 大和弦家族六条，顺序 = 词表顺序（七 / 九 / 十三 / 升十一 / 十三升十一 / 十一）',
    JSON.stringify(sugJ?.items?.map((x: any) => x.value)) === JSON.stringify(wantMaj),
    sugJ?.items?.map((x: any) => x.value)
  );
  const sugA = await sugFor('Ca');
  await shot('smoke-chord-maj.png');
  check(
    '字母和弦打 Ca → add 族（add2/add4/add6/add9）在前、aug 次之、再是 maj 族',
    JSON.stringify(sugA?.items?.map((x: any) => x.value)) ===
      JSON.stringify(['Cadd2', 'Cadd4', 'Cadd6', 'Cadd9', 'Caug', ...wantMaj]),
    sugA?.items?.map((x: any) => x.value)
  );
  // 升号根音也认（「音名 + 辅助补全的升降号」再 j）
  const sugSharp = await sugFor('C#j');
  check(
    '打 C#j 也能出 C♯maj7…（根音带升降号时照样按同一个缩写补）',
    sugSharp?.items?.[0]?.value === 'C♯maj7' &&
      sugSharp?.items?.length === wantMaj.length,
    sugSharp?.items?.map((x: any) => x.value)
  );
  // 缩写只认 j / a：`Cm` 前缀仍然先给小三这一家，不被六条 maj 挤掉
  const sugM = await sugFor('Cm');
  check(
    '单字母缩写不外溢：打 Cm 仍先给 m7b5 / m7 / m9（maj 家族不许把它们挤出候选）',
    ['Cm7b5', 'Cm7', 'Cm9'].every((v) => sugM?.items?.some((x: any) => x.value === v)) &&
      sugM?.items?.[0]?.value === 'Cm',
    sugM?.items?.map((x: any) => x.value)
  );
  /* add 系列：`a` 被 augment 占走后，数字后缀仍要能落到 add（v0.80） */
  const sugA2 = await sugFor('Ca2');
  const sugA6 = await sugFor('Ca6');
  check(
    '打 Ca2 / Ca6 → Cadd2 / Cadd6（解析器早就支持 add2，是词表漏了这一条）',
    sugA2?.items?.[0]?.value === 'Cadd2' && sugA6?.items?.[0]?.value === 'Cadd6',
    { a2: sugA2?.items?.map((x: any) => x.value), a6: sugA6?.items?.map((x: any) => x.value) }
  );
  /* 省略音关键字：`C13o` → omit / no；`C13n` → 只有 no（v0.82） */
  const sugOmitO = await sugFor('C13o');
  const sugOmitN = await sugFor('C13n');
  check(
    '打 C13o → 候选 C13omit / C13no；打 C13n → 只给 C13no（省略音关键字）',
    JSON.stringify(sugOmitO?.items?.map((x: any) => x.value)) === JSON.stringify(['C13omit', 'C13no']) &&
      JSON.stringify(sugOmitN?.items?.map((x: any) => x.value)) === JSON.stringify(['C13no']),
    { o: sugOmitO?.items?.map((x: any) => x.value), n: sugOmitN?.items?.map((x: any) => x.value) }
  );
  await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(160);
  await js(`window.__ma.clear()`);
  await js(`window.__ma.select(21, 0, 0)`);
  const daRange = (await js(`window.__ma.selState().selection`)) as any;
  const daTick = typeof daRange?.startTick === 'number' ? daRange.startTick : null;
  const daDur = Math.max(1, Number(daRange?.endTick ?? 0) - Number(daRange?.startTick ?? 0));
  const daAid = (handle.db
    .prepare(`SELECT id FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(trackId) as any)?.id;
  const daIns =
    daAid && typeof daTick === 'number'
      ? analysisIpc.upsertEvent({ db: handle.db, vocab, dataDir, assetsDir } as any, {
          analysisId: String(daAid),
          lane: 'chord',
          tick: Number(daTick),
          // 长度与选中那一格一致，否则选区与事件区间不等，`parsed` 取不出来
          durTicks: daDur,
          text: 'C𝄪7',
        })
      : null;
  // 让画布重画这一格（后面那张截图就是给「记号放大 10%」留的证据）
  await js(`window.__app.refresh()`);
  await wait(620);
  // `upsertEvent` 回的是**对象**（库里存的才是 JSON 字符串），两种都认
  const daRaw = daIns ? (daIns as any).parsed : null;
  const daParsed = typeof daRaw === 'string' ? JSON.parse(daRaw) : daRaw;
  check(
    '库里写 C𝄪7：解析成 C𝄪 上的属七（C𝄪–E𝄪–G𝄪–B♯），派生拼写也用 𝄪 而不是 ♯♯',
    !!daIns &&
      daParsed?.ok === true &&
      daParsed?.rootName === 'C𝄪' &&
      daParsed?.toneNames?.[0] === 'C𝄪' &&
      daParsed?.toneNames?.[1] === 'E𝄪' &&
      daParsed?.toneNames?.[3] === 'B♯',
    { tick: daTick, text: (daIns as any)?.text ?? null, root: daParsed?.rootName ?? null, tones: daParsed?.toneNames ?? null }
  );
  // 选区条里的解析说明：𝄪 要走 ChordText 单独放大（`.acc2` span），不能和其他字一样大
  await js(`window.__ma.select(21, 0, 0)`);
  await wait(280);
  const daUI = (await js(`(() => {
    const el = document.querySelector('.selbar .parsed');
    const big = el ? el.querySelector('.acc2') : null;
    return {
      text: el ? el.textContent.trim() : null,
      big: el ? el.querySelectorAll('.acc2').length : 0,
      bigSize: big ? parseFloat(getComputedStyle(big).fontSize) : 0,
      parentSize: el ? parseFloat(getComputedStyle(el).fontSize) : 0,
    };
  })()`)) as any;
  check(
    '选区条的解析说明里 𝄪 被单独放大（ChordText：记号字号 > 整行字号）',
    !!daUI && /𝄪/.test(String(daUI.text)) && daUI.big >= 1 && daUI.bigSize > daUI.parentSize,
    daUI
  );
  // 把这一格滚进视口再截图（只滚视图，不动播放头）
  await js(`window.__ma.scrollTo(Math.max(0, window.__ma.xOfTick(${Number(daTick)}) - 220))`);
  await wait(260);
  await shot('smoke-chord-double-accidental.png');
  // 收拾干净：这条测试事件不留给后面的断言
  if (daIns) handle.db.prepare(`DELETE FROM analysis_event WHERE id = ?`).run((daIns as any).id);
  await js(`window.__ma.clear()`);
  await js(`window.__app.refresh()`);
  await wait(240);
  // 回到罗马数字泳道，后面的断言都按这个视图来
  await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('罗马数字'))?.click()`);
  await wait(320);

  /* ---- 那不勒斯：N / N6 = ♭II / ♭II6（降二级大三），说法必须是「♭2 级 · 那不勒斯」 ---- */
  // ① 打 N 出候选（N 在前、N6 在后）
  await js(`window.__ma.clear()`);
  await js(`window.__ma.select(23, 0, 0)`);
  await js(`window.__ma.openEdit('')`);
  await wait(140);
  // 候选是「输入」事件算出来的：openEdit 只负责把输入框摆好
  await js(`(() => {
    const el = document.querySelector('.cell-input');
    if (!el) return false;
    el.value = 'N';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(180);
  const neoSug = (await js(`window.__ma.cellSugState()`)) as any;
  check(
    '级数泳道打 N → 候选是 N / N6（那不勒斯和弦与它的六和弦）',
    neoSug?.open === true &&
      neoSug?.items?.[0]?.value === 'N' &&
      neoSug.items.some((x: any) => x.value === 'N6') &&
      neoSug.items.length === 2,
    neoSug
  );
  await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(160);

  // ② 写进库：N6 必须和 ♭II6 解析成同一个和弦
  await js(`window.__ma.clear()`);
  await js(`window.__ma.select(22, 0, 0)`);
  const neoRange = (await js(`window.__ma.selState().selection`)) as any;
  const neoTick = typeof neoRange?.startTick === 'number' ? neoRange.startTick : null;
  const neoDur = Math.max(1, Number(neoRange?.endTick ?? 0) - Number(neoRange?.startTick ?? 0));
  const neoAid = (handle.db
    .prepare(`SELECT id FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`)
    .get(trackId) as any)?.id;
  const neoIns =
    neoAid && typeof neoTick === 'number'
      ? analysisIpc.upsertEvent({ db: handle.db, vocab, dataDir, assetsDir } as any, {
          analysisId: String(neoAid),
          lane: 'degree',
          tick: Number(neoTick),
          // 长度必须**和当前选中那一格一样**：选区与事件区间只要差一格，
          // `selParsed` 就取不到（那是「只认完全重合」的老规矩），详情栏会空着
          durTicks: neoDur,
          text: 'N6',
        })
      : null;
  // 只读**主体**（parsed 在库里存的是 JSON 字符串）
  const neoParsed = neoIns
    ? (() => {
        const raw = (neoIns as any).parsed;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      })()
    : null;
  check(
    'N6 落库：降二级大三的第一转位（F–A♭–D♭），级数是降 2 而不是 2',
    !!neoIns &&
      neoParsed?.ok === true &&
      neoParsed?.degree === 2 &&
      neoParsed?.alter === -1 &&
      neoParsed?.inversion === 1 &&
      neoParsed?.neapolitan === true &&
      neoParsed?.toneNames?.[0] === 'F',
    {
      degree: neoParsed?.degree,
      alter: neoParsed?.alter,
      inv: neoParsed?.inversion,
      tones: neoParsed?.toneNames,
    }
  );
  // ③ 界面上怎么念：级数带降号、认出那不勒斯（以前只会说「2 级 · 大三和弦」）
  const neoDesc = (await js(`window.__ma.describe('N6', 'c major')`)) as any;
  check(
    'N6 的说法是「♭2 级 · 那不勒斯 · 大三和弦 · 第一转位」，bII6 走同一套',
    neoDesc?.ok === true &&
      /♭2 级/.test(String(neoDesc.text)) &&
      /那不勒斯/.test(String(neoDesc.text)) &&
      /第一转位/.test(String(neoDesc.text)) &&
      (await js(`window.__ma.describe('bII6', 'c major')?.text`)) === neoDesc.text,
    neoDesc
  );
  // 界面上真的画出来了：选区条里的 𝄪/𝄫 走 ChordText，放大成独立的 span
  await js(`window.__app.refresh()`);
  await wait(620);
  await js(`window.__ma.select(22, 0, 0)`);
  await wait(280);
  const neoUI = (await js(`(() => {
    const el = document.querySelector('.selbar .parsed');
    return el ? { text: el.textContent.trim(), big: el.querySelectorAll('.acc2').length } : null;
  })()`)) as any;
  check(
    '选区条的解析说明真的写「♭2 级 · 那不勒斯」（不只是库里解析对）',
    !!neoUI && /♭2 级/.test(neoUI.text) && /那不勒斯/.test(neoUI.text),
    neoUI
  );
  // 同为 ♭II，带小七度就是代 V7 的三全音替代，不能继续叫那不勒斯
  const triDesc = (await js(`window.__ma.describe('bII7', 'c major')`)) as any;
  const triSus = (await js(`window.__ma.describe('bII7sus4', 'c major')`)) as any;
  const neoStill = (await js(`window.__ma.describe('bII6', 'c major')`)) as any;
  const maj7FlatTwo = (await js(`window.__ma.describe('bIImaj7', 'c major')`)) as any;
  check(
    '♭II7 / ♭II7sus4 = 三全音替代；♭II6 仍是那不勒斯；♭IImaj7 两者都不是',
    triDesc?.ok === true &&
      /三全音替代/.test(String(triDesc.text)) &&
      !/那不勒斯/.test(String(triDesc.text)) &&
      triSus?.ok === true &&
      /三全音替代/.test(String(triSus.text)) &&
      neoStill?.ok === true &&
      /那不勒斯/.test(String(neoStill.text)) &&
      !/三全音替代/.test(String(neoStill.text)) &&
      maj7FlatTwo?.ok === true &&
      !/三全音替代|那不勒斯/.test(String(maj7FlatTwo.text)),
    { bII7: triDesc?.text, bII7sus4: triSus?.text, bII6: neoStill?.text, bIImaj7: maj7FlatTwo?.text }
  );
  await shot('smoke-neapolitan.png');
  if (neoIns) handle.db.prepare(`DELETE FROM analysis_event WHERE id = ?`).run((neoIns as any).id);
  await js(`window.__ma.clear()`);
  await js(`window.__app.refresh()`);
  await wait(240);

  /* ---- 字母和弦词表 + 斯波索宾泳道方案 ---- */
  const chordDoc = await js(`window.api.chords.doc()`);
  const chordSigns = (chordDoc?.accidentals ?? []).map((a: any) => a.sign);
  check(
    '和弦符号词表：音名只用七个 + 变音记号表（还原/♯/♭/𝄪/𝄫），性质另存一张',
    Array.isArray(chordDoc?.letters) &&
      chordDoc.letters.length === 7 &&
      chordDoc.letters.join('') === 'CDEFGAB' &&
      chordSigns.join('|') === '|♯|♭|𝄪|𝄫' &&
      Array.isArray(chordDoc?.qualities) &&
      chordDoc.qualities.length >= 10,
    { letters: chordDoc?.letters?.length, signs: chordSigns, qualities: chordDoc?.qualities?.length }
  );
  const metaNow = await js(`window.api.meta()`);
  const spView = (metaNow?.views ?? []).find((v: any) => v.id === 'sposobin');
  check(
    '新增「斯波索宾体系」泳道方案：和弦标记 + 备注两行，独立 lane（不与 chord 共用）',
    spView?.lanes?.length === 2 && spView.lanes[0]?.id === 'sposobin' && spView.lanes[1]?.id === 'note',
    spView ? { id: spView.id, lanes: spView.lanes.map((l: any) => l.id) } : null
  );

  /* ---- 侧边栏「和弦符号」入口：能打开编辑器，且真的读到了词表 ---- */
  const csClicked = await js(`(() => {
    const btn = [...document.querySelectorAll('.sidebar .side-row')].find((b) => b.textContent.includes('和弦符号'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await wait(220);
  const csBox = await js(`(() => {
    const m = document.querySelector('.cs-modal');
    if (!m) return null;
    const wrap = m.querySelector('.cs-tablewrap');
    const table = m.querySelector('.cs-table');
    const mr = m.getBoundingClientRect();
    const tr = table ? table.getBoundingClientRect() : null;
    return {
      title: m.querySelector('h3')?.textContent?.trim() ?? '',
      letters: m.querySelectorAll('.cs-letter').length,
      accidentals: m.querySelectorAll('.cs-acc').length,
      quals: m.querySelectorAll('.cs-table tbody tr').length,
      aliases: m.querySelectorAll('.cs-alias').length,
      orders: m.querySelectorAll('.cs-order').length,
      moves: m.querySelectorAll('.cs-move').length,
      firstSuffixPh: m.querySelector('.cs-table tbody tr input')?.getAttribute('placeholder') ?? '',
      // 「性质」那一列必须整块落在弹窗里：以前左列按内容撑宽，把整张表推到窗外
      tableRight: tr ? Math.round(tr.right) : null,
      modalRight: Math.round(mr.right),
      wrapScrollW: wrap ? wrap.scrollWidth : 0,
      wrapClientW: wrap ? wrap.clientWidth : 0,
    };
  })()`);
  check(
    '侧边栏「和弦符号」能打开词表编辑器：音名 7、变音 5、性质一张表，顺序按钮齐全',
    csClicked === true &&
      csBox &&
      csBox.letters === 7 &&
      csBox.accidentals === 5 &&
      csBox.quals >= 10 &&
      csBox.orders === csBox.quals &&
      csBox.moves >= csBox.quals * 2,
    { clicked: csClicked, box: csBox }
  );
  check(
    '词表编辑器的「性质」整块在弹窗里（不再被左列挤出窗外、看不到）',
    !!csBox &&
      csBox.tableRight <= csBox.modalRight &&
      csBox.wrapScrollW <= csBox.wrapClientW + 1,
    { tableRight: csBox?.tableRight, modalRight: csBox?.modalRight, scrollW: csBox?.wrapScrollW, clientW: csBox?.wrapClientW }
  );
  const hdQuality = (chordDoc?.qualities ?? []).find((q: any) => q.suffix === 'm7b5');
  const hdInversions = (chordDoc?.qualities ?? []).filter((q: any) => /^ø/.test(q.suffix));
  check(
    '半减七在词表里带别名（ø / min7b5）并单列 ø7/ø65/ø43/ø42 四个转位；编辑器为每种性质显示别名列',
    hdQuality?.aliases?.includes('ø') &&
      hdQuality.aliases.includes('min7b5') &&
      hdInversions.map((q: any) => q.suffix).join(',') === 'ø7,ø65,ø43,ø42' &&
      !!csBox &&
      csBox.aliases === csBox.quals,
    { aliases: hdQuality?.aliases, inversions: hdInversions.map((q: any) => q.suffix), aliasInputs: csBox?.aliases, rows: csBox?.quals }
  );
  check(
    '空后缀不再用 7sus4 当 placeholder（改为「空 = 大三」，避免把大三行看成 7sus4）',
    !!csBox && csBox.firstSuffixPh !== '7sus4' && /大三/.test(csBox.firstSuffixPh),
    { placeholder: csBox?.firstSuffixPh }
  );

  /* ---- 词表增删改查：空白新行不挡保存；填好能新增；删除能恢复 ---- */
  const qCountBefore = (chordDoc?.qualities ?? []).length;
  await js(`document.querySelector('.cs-grow > .chip')?.click()`);
  await wait(120);
  await js(`document.querySelector('.cs-foot .chip.danger.solid')?.click()`);
  await wait(520);
  const blankSaveDoc = (await js(`window.api.chords.doc()`)) as any;
  const blankSaveErr = await js(`document.querySelector('.cs-foot .cs-err')?.textContent ?? ''`);
  check(
    '词表：点「+ 性质」留下空白行也能保存（不再是「添加就失败」）',
    blankSaveDoc?.qualities?.length === qCountBefore && !String(blankSaveErr).trim(),
    { before: qCountBefore, after: blankSaveDoc?.qualities?.length, error: blankSaveErr }
  );

  await js(`document.querySelector('.cs-grow > .chip')?.click()`);
  await wait(160);
  await js(`(() => {
    const tr = [...document.querySelectorAll('.cs-table tbody tr')].pop();
    if (!tr) return;
    const set = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const ins = tr.querySelectorAll('input');
    set(ins[0], '7♯9');
    set(ins[1], '7#9');
    set(ins[2], '属七升九');
  })()`);
  await wait(160);
  await js(`document.querySelector('.cs-foot .chip.danger.solid')?.click()`);
  await wait(620);
  const addedDoc = (await js(`window.api.chords.doc()`)) as any;
  check(
    '词表：填好「7♯9 / 属七升九」后能保存，读回顺序里真的有这条',
    addedDoc?.qualities?.length === qCountBefore + 1 &&
      addedDoc?.qualities?.some((q: any) => q.suffix === '7♯9' && q.label === '属七升九'),
    addedDoc?.qualities?.slice(-3)
  );

  await js(`(() => {
    const tr = [...document.querySelectorAll('.cs-table tbody tr')].find((r) => r.querySelector('input')?.value === '7♯9');
    tr?.querySelector('.cs-x')?.click();
  })()`);
  await wait(160);
  await js(`document.querySelector('.cs-foot .chip.danger.solid')?.click()`);
  await wait(620);
  const removedDoc = (await js(`window.api.chords.doc()`)) as any;
  check(
    '词表：删除「7♯9」后保存，读回不再有这条（增 / 删都落盘）',
    removedDoc?.qualities?.length === qCountBefore &&
      !removedDoc.qualities.some((q: any) => q.suffix === '7♯9'),
    { count: removedDoc?.qualities?.length, last: removedDoc?.qualities?.slice(-3) }
  );

  // 留一张证据：左列音名 7 + 变音 5、右列性质整张表都在窗内
  await shot('smoke-chord-symbols.png');
  await js(`document.querySelector('.cs-head .chip:last-child')?.click()`);
  await wait(160);

  // ---- 切主题：canvas 必须立刻换色（以前要等下一次交互）----
  const themeBefore = await js(`document.documentElement.dataset.theme`);
  const px = () =>
    js(
      `(() => { const c = document.querySelector('canvas'); const g = c.getContext('2d');
        const d = g.getImageData(3, c.height - 3, 1, 1).data; return [d[0], d[1], d[2]]; })()`
    );
  const darkPx = await px();
  // 主题切换搬进首选项了，冒烟直接走状态，不再依赖顶栏上有没有那个按钮
  await js(`window.__app.setTheme('light')`);
  await wait(140);
  const lightPx = await px();
  const themeAfter = await js(`document.documentElement.dataset.theme`);
  check(
    '切浅色后网格立即重绘（不等下一次交互）',
    lightPx[0] > 200 && lightPx[1] > 200 && darkPx[0] < 80,
    { darkPx, lightPx, themeBefore, themeAfter }
  );
  await shot('smoke-light.png');

  // ---- Ctrl+滚轮：只放大网格横向比例，且指针下的那一格不许跑 ----
  // 视口化之后 canvas 钉在视口里（sticky），screen = (c.left - b.left) + docX - viewLeft
  const anchorScreen = (tick: number) =>
    js(`(() => {
      const box = document.querySelector('.scroll');
      const cv = document.querySelector('canvas');
      const b = box.getBoundingClientRect(), c = cv.getBoundingClientRect();
      return Math.round((c.left - b.left) + window.__ma.xOfTick(${tick}) - window.__ma.viewLeft());
    })()`);
  const anchorTick = 15840; // 第 12 小节首拍
  const z0 = await js(`window.__ma.zoom()`);
  const uiZ0 = await js(`window.api.ui.getZoom()`);
  const a0 = await anchorScreen(anchorTick);
  const boxLeft = await js(`Math.round(document.querySelector('.scroll').getBoundingClientRect().left)`);
  await js(
    `document.querySelector('.canvas-host').dispatchEvent(
       new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true,
         clientX: ${boxLeft} + ${a0}, clientY: 560 }))`
  );
  await wait(160);
  const z1 = await js(`window.__ma.zoom()`);
  const uiZ1 = await js(`window.api.ui.getZoom()`);
  const a1 = await anchorScreen(anchorTick);
  check(
    'Ctrl+滚轮放大网格，且指针下那一格不跑、整窗缩放不变',
    z1 > z0 && Math.abs(uiZ1 - uiZ0) < 0.001 && Math.abs(a1 - a0) <= 2,
    { z0, z1, uiZ0, uiZ1, a0, a1 }
  );
  await js(`window.__ma.setZoom(1)`);
  await wait(120);

  /* ---- canvas 位图必须和 CSS 尺寸严格 1:1（否则整张画布被重采样，字立刻发虚） ---- */
  /**
   * 现象（用户报）：「缩放设到 125% 之后再放大一下或两下，时间线面板里的和弦字变模糊」。
   *
   * 根因不是字体，是**整块画布被重采样**：位图按 `viewW × dpr` 取整，而 CSS 宽度用的是
   * 没取整的 `viewW` —— 两者差不到 1 个设备像素，但只要有差，浏览器就得把这张位图
   * 双线性拉伸到目标尺寸，于是**每一个像素都被抹了一下**。
   * 差多少取决于 `viewW × dpr` 的小数部分，所以只有「特定倍率」看着糊。
   * 实测（`.tools` 探针，同一串字）：差 0.5px 时边缘对比度掉 6%。
   *
   * 现在位图用 `round`，CSS 尺寸反算成 `位图 / dpr`，差恒为 0。
   */
  const zoomForFit = await js(`window.api.ui.getZoom()`);
  await js(`window.api.ui.setZoom(1.35)`);
  await wait(460);
  const bitmapFit = (await js(`(() => {
    const cv = document.querySelector('.canvas-host canvas');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const round2 = (v) => Math.round(v * 100) / 100;
    return {
      dpr: round2(dpr),
      wDev: cv.width,
      wCss: round2(r.width),
      wDelta: round2(cv.width - r.width * dpr),
      hDelta: round2(cv.height - r.height * dpr),
    };
  })()`)) as any;
  check(
    '页面缩放到 1.35（dpr 非整数）时，canvas 位图与 CSS 尺寸仍严格 1:1 —— 差一点整块就被重采样，字会发虚',
    !!bitmapFit && Math.abs(bitmapFit.wDelta) <= 0.51 && Math.abs(bitmapFit.hDelta) <= 0.51,
    bitmapFit
  );
  await js(`window.api.ui.setZoom(${Number(zoomForFit) || 1})`);
  await wait(360);

  // ---- 重绘开销：尺寸没变时不该重新分配 canvas 缓冲区（卡顿的根因就在这） ----
  const perfA = await js(`window.__ma.perf()`);
  await js(`window.__ma.setZoom(1.25)`);
  await wait(140);
  await js(`window.__ma.setZoom(1)`);
  await wait(140);
  const perfB = await js(`window.__ma.perf()`);
  const dDraw = perfB.draws - perfA.draws;
  const dRealloc = perfB.reallocs - perfA.reallocs;
  check(
    '重绘次数远多于缓冲区重分配（不再每帧重建 canvas）',
    dDraw >= 2 && dRealloc <= 2,
    { dDraw, dRealloc, lastMs: perfB.lastMs, maxMs: perfB.maxMs, w: perfB.lastW, h: perfB.lastH }
  );

  // 同尺寸连画三次：一次都不该重新分配（这是缩放手感的关键）
  const same0 = await js(`window.__ma.perf()`);
  await js(`window.__ma.redraw(); window.__ma.redraw(); window.__ma.redraw();`);
  const same1 = await js(`window.__ma.perf()`);
  check(
    '同尺寸连续重绘不重分配 canvas 缓冲区',
    same1.draws - same0.draws === 3 && same1.reallocs === same0.reallocs,
    { draws: same1.draws - same0.draws, reallocs: same1.reallocs - same0.reallocs }
  );

  // 一次物理滚轮会连着来好几个 wheel 事件：必须被 rAF 合成一次重绘。
  // 在同一个任务里同步派发 6 个，模拟「一帧内收到一串事件」的最坏情况。
  const burst0 = await js(`window.__ma.perf()`);
  await js(`(() => {
    const host = document.querySelector('.canvas-host');
    const x = Math.round(document.querySelector('.scroll').getBoundingClientRect().left) + 220;
    for (let i = 0; i < 6; i++) {
      host.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true, clientX: x, clientY: 560,
      }));
    }
  })()`);
  await wait(240);
  const burst1 = await js(`window.__ma.perf()`);
  check(
    '连续滚轮事件被合并成重绘（6 个事件最多 3 次，不再每事件同步画一遍）',
    // 1 次给缩放本身；另外最多 2 次是「横滚动条出现/消失 → 视口高度真的变了」——
    // 那是真实的尺寸变化，必须重画，不是没合并
    burst1.draws - burst0.draws <= 3,
    { wheelEvents: 6, draws: burst1.draws - burst0.draws }
  );
  await js(`window.__ma.setZoom(1)`);
  await wait(140);

  // ---- 视口架构：canvas 钉在视口里（sticky），滚动时相对位置不变 ----
  await js(`window.__ma.scrollTo(400)`);
  await wait(140);
  const pinScrolled = await js(`window.__ma.pinnedDx()`);
  await js(`window.__ma.scrollTo(0)`);
  await wait(140);
  const pinHome = await js(`window.__ma.pinnedDx()`);
  check(
    '滚动时 canvas 钉在泳道标签右侧（sticky，64px 不漂移）',
    Math.abs(pinScrolled - 64) <= 1 && Math.abs(pinHome - 64) <= 1,
    { pinScrolled, pinHome }
  );

  // ---- 泳道行高与滚动条 ----
  // 行高不再"撑满可视高度"，而是跟和弦字号走（字高 × 1.75 = 22）。
  // 五套泳道方案的 height 都写成同一个值 → 所有行等高（低音 / 备注不比级数矮）。
  const ov = await js(`window.__ma.overflow()`);
  check(
    '泳道行高 = 和弦字号 × 1.75（22px），且三行等高；面板够高时竖直方向不溢出',
    ov?.rowH === 22 && ov?.v === 0 && ov?.lanes?.length > 0 && ov.lanes.every((h: number) => h === 22),
    ov
  );

  // ---- 播放头随 seek 移动（DOM transform）；整块的 .wave-played 色块层已移除 ----
  const ph0 = await js(`(() => {
    const el = document.querySelector('.playhead');
    return { exists: !!el, t: el ? el.style.transform : null };
  })()`);
  await js(`window.__ma.seekTick(9600)`);
  await wait(160);
  const ph1 = await js(`document.querySelector('.playhead')?.style.transform ?? null`);
  const overlayGone = await js(`!!document.querySelector('.wave-played')`);
  check(
    '播放头随 seek 移动（DOM transform），且无整块色块层',
    ph0.exists === true && ph1 !== ph0.t && overlayGone === false,
    { ph0, ph1, overlayGone }
  );
  await js(`window.__ma.seekTick(0)`);
  await wait(120);

  await js(`window.__app.setTheme('dark')`);
  await wait(140);

  // ---- 搜索：中文时期 / 中文调式要能命中英文规范值 ----
  // 期望条数从库里数出来，不写死：曲库是会长的，写死 1 只会在加曲目时变成假失败。
  const cnt = async (t: string) => js(`window.api.tracks.list({ text: ${JSON.stringify(t)} }).then((r) => r.length)`);
  const expPeriod = (
    handle.db.prepare(`SELECT COUNT(*) AS c FROM track WHERE deleted_at IS NULL AND period = 'contemporary'`).get() as any
  ).c;
  const expKeyMode = (
    handle.db
      .prepare(
        // 「自然小调」会被扩成 ['natural minor', 'minor']：中文说法含糊时宁可多收，
        // 所以 melodic minor / harmonic minor 也算命中，这里按同一条规则数期望值
        `SELECT COUNT(DISTINCT a.track_id) AS c FROM analysis a
           JOIN analysis_marker m ON m.analysis_id = a.id
          WHERE a.deleted_at IS NULL AND m.kind = 'key'
            AND (m.key_name LIKE '%natural minor%' OR m.key_name LIKE '%minor%')`
      )
      .get() as any
  ).c;
  const hitPeriod = await cnt('当代');
  const hitKey = await cnt('自然小调');
  const hitMode = await cnt('dorian');
  const hitTag = await cnt('琵琶');
  const hitTitle = await cnt('神鹿谣');
  const missPeriod = await cnt('古典主义');
  // 别的时期的期望值也从库里数：曲库会长，写死 0 只会在加入古典曲目时变成假失败。
  // 2026-11-04 起「古典」两条路都算命中：period = classical（历史分期），
  // 以及 genre = Classical（体裁搬走后，那批曲目的流派回落到父类 Classical）。
  const expClassical = (
    handle.db
      .prepare(
        `SELECT COUNT(*) AS c FROM track
          WHERE deleted_at IS NULL
            AND (period = 'classical' OR LOWER(IFNULL(genre, '')) = 'classical')`
      )
      .get() as any
  ).c;
  check(
    '搜索命中时期/调式/标签（当代、自然小调、dorian、琵琶），且不误伤别的时期',
    hitPeriod === expPeriod &&
      hitPeriod >= 1 &&
      hitKey === expKeyMode &&
      hitKey >= 1 &&
      hitMode === 1 &&
      hitTag === 1 &&
      hitTitle === 1 &&
      missPeriod === expClassical,
    { hitPeriod, expPeriod, hitKey, expKeyMode, hitMode, hitTag, hitTitle, missPeriod, expClassical }
  );

  // ---- 音频：绑定 / 波形 / 播放头 ↔ 格子 ----
  const audioState = async () => {
    const raw = await js(`window.__ma.audioState()`);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };
  // 偏移存在**录音版本**上（逐版本），所以这里要读「生效值」——
  // 直接查 analysis.audio_offset_ms 读到的是迁移前的历史值，
  // 拿它当 before 去恢复，会把真正的偏移覆盖掉。
  const offsetBefore =
    (await js(`window.api.analysis.get(${JSON.stringify(trackId)})`))?.audioOffsetMs ?? 0;
  const audioInfo = await js(`window.api.audio.resolve(${JSON.stringify(trackId)})`);
  check(
    '音频已绑定：FLAC / 44.1kHz / 3:06（文件头读的，不是估的）',
    audioInfo?.exists === true && audioInfo?.format === 'flac' && audioInfo?.sampleRate === 44100 && audioInfo?.durationMs === 186000,
    { name: audioInfo?.name, format: audioInfo?.format, rate: audioInfo?.sampleRate, dur: audioInfo?.durationMs }
  );

  let st = await audioState();
  for (let i = 0; i < 48 && !st.peaks; i++) {
    await wait(250);
    st = await audioState();
  }
  check('波形峰值金字塔就绪（多级 min/max）', st.peaks === true && st.peaksLevels >= 2 && st.error === null, st);

  /* ---- 编码器预热补偿：无损不补，且波形 / 播放 / 时长三边口径一致 ---- */
  /**
   * 用户报过「同一个偏移量，换个格式就对不齐」。根因是有损编码器会在文件开头塞一段预热
   * （mp3 没 Xing 头 1105 采样 ≈ 25ms、aac 没 edit list 1024 采样 ≈ 23ms），
   * 解码后它就变成实打实多出来的采样。修法是把这段从三条时间轴里一起裁掉：
   * 播放元素、波形峰值、以及对外报的时长。这段断言守两件事：
   *
   *  1) **无损文件不许被误补** —— 这条用的是 FLAC，`leadSamples` 必须还是 0
   *     （误补会把整轨推偏 20+ ms，比不补更糟）；
   *  2) **波形时长 ≈ 音频时长** —— 一个来自解码采样、一个来自元素/文件头，
   *     口径错了就是「波形比播放头早一点」，正是对轨对不齐的观感。
   */
  const clockA = await audioState();
  check(
    '编码器预热：FLAC 不补（leadSamples = 0），波形时长与音频时长一致',
    clockA.leadSamples === 0 &&
      clockA.leadMs === 0 &&
      Number.isFinite(clockA.peaksMs) &&
      Math.abs(clockA.peaksMs - clockA.durationMs) <= 30,
    clockA
  );
  await js(`window.__ma.seekMs(1234)`);
  await wait(260);
  const clockB = await audioState();
  check(
    '文件时间 ↔ 音乐时间只差一个预热（elMs − currentMs = leadMs），播放头才不会比波形早/晚',
    clockB.elMs === null || Math.abs(clockB.elMs - clockB.currentMs - clockB.leadMs) <= 30,
    clockB
  );

  // ---- 已播放波形：颜色加深（双层位图裁剪），不是整块色块覆盖 ----
  await js(`window.__ma.scrollTo(0)`);
  await js(`window.__ma.seekTick(9600)`);
  await wait(180);
  const band = await js(`window.__ma.bandDiff()`);
  check(
    '已播放波形颜色变深（播放头两侧异色，双层位图而非色块）',
    !!band && (band as any).differ === true,
    band
  );

  /**
   * 重绘不能把波形带清掉。
   *
   * 波形是位图叠在画布顶部，而 draw() 开头 clearRect 会连它一起清；补画这一步一旦漏掉，
   * 播放中每换一个和弦（选区变化 → 重绘）波形就空一帧，看起来就是「波形闪烁」。
   * 这里在**暂停**状态强制重绘一次：暂停没有帧循环，没人替 draw 兜底，最能暴露问题。
   */
  await js(`window.__ma.seekTick(9600)`);
  await wait(140);
  const bandBefore = await js(`window.__ma.bandDiff()`);
  await js(`window.__ma.redraw()`);
  await wait(60);
  const bandAfter = await js(`window.__ma.bandDiff()`);
  check(
    '重绘后波形带仍在（draw() 末尾补画 band，不再闪成空白）',
    !!bandAfter &&
      (bandAfter as any).differ === true &&
      (bandBefore as any)?.differ === true,
    { before: bandBefore, after: bandAfter }
  );
  await js(`window.__ma.seekTick(0)`);
  await wait(120);

  /**
   * 「回到开头」不只是把播放头数值清零：视图如果还停在两分钟处，
   * 播放头确实回去了，但人看不见 —— 看上去就像按钮没反应。
   * 所以按 ■ / Home 时视窗也要跟着回到开头（和跟随同一套目标）。
   */
  await js(`window.__ma.seekMs(60000)`);
  const farPx = await js(`window.__ma.xOfTick(23040)`);
  await js(`window.__ma.scrollTo(${Math.round(Number(farPx) / 2)})`);
  await wait(140);
  const rewindBefore = await js(`(async () => ({
    left: window.__ma.scrollLeft(),
    ms: JSON.parse(await window.__ma.audioState()).currentMs,
  }))()`);
  await js(`[...document.querySelectorAll('.transport .tp')][1].click()`);
  await wait(220);
  const rewindAfter = await js(`(async () => ({
    left: window.__ma.scrollLeft(),
    viewLeft: window.__ma.viewLeft(),
    ms: JSON.parse(await window.__ma.audioState()).currentMs,
  }))()`);
  check(
    '按「回到开头」：播放头归零，视窗也一起滚回开头（不在视野外空转）',
    rewindBefore.left > 400 && rewindAfter.left === 0 && rewindAfter.viewLeft === 0 && rewindAfter.ms === 0,
    { rewindBefore, rewindAfter }
  );

  // ---- 播放中的帧开销：热层 blit 每帧进行，整网重绘不被播放驱动 ----
  const perfP0 = await js(`window.__ma.perf()`);
  await js(`window.__ma.play()`);
  await wait(500);
  const perfP1 = await js(`window.__ma.perf()`);
  await js(`window.__ma.pause()`);
  check(
    '播放 500ms：热层 blit >20 次（逐帧加深），整网重绘 ≤3 次（播放不驱动重绘）',
    perfP1.hotBlits - perfP0.hotBlits > 20 && perfP1.draws - perfP0.draws <= 3,
    { hotBlits: perfP1.hotBlits - perfP0.hotBlits, draws: perfP1.draws - perfP0.draws }
  );

  /**
   * 跟随选中**不能回跳**。
   *
   * 旧实现里 draw() 结尾调 updatePlayhead() 且不带 ms，于是回退到每 70ms 才更新一次的
   * audio.currentMs：换和弦那一帧先把选区推回上一个和弦，下一帧再推回来 ——
   * 详情栏看起来就是「更新 → 变回旧的 → 再更新」。这里连采 1.6 秒，选区起点只许增。
   */
  await js(`window.__ma.seekTick(15840)`);
  await js(`window.__ma.play()`);
  const followSeq: (number | null)[] = [];
  for (let i = 0; i < 24; i++) {
    await wait(70);
    const st = await js(`window.__ma.selState()`);
    followSeq.push(st?.selection?.startTick ?? null);
  }
  await js(`window.__ma.pause()`);
  const seen = followSeq.filter((v) => v != null) as number[];
  const monotonic = seen.every((v, i) => i === 0 || v >= seen[i - 1]);
  check(
    '跟随选中不回跳：播放中选区起点只增不减（详情栏闪烁的根因）',
    monotonic && seen.length >= 2,
    { seq: followSeq }
  );

  // seek 全靠 Range：一次性给整段 18MB，拖播放头会明显卡
  const rangeProbe = await js(
    `fetch(${JSON.stringify(audioInfo?.url ?? '')}, { headers: { Range: 'bytes=0-1023' } })
       .then(async (r) => r.status + '/' + (await r.arrayBuffer()).byteLength)
       .catch((e) => 'ERR ' + e)`
  );
  check('自定义音频协议支持 Range（206 分片）', rangeProbe === '206/1024', rangeProbe);

  // offset = 1500：第 1 小节首拍应落在音频 1.5s
  await js(`window.api.analysis.setAudioOffset(${JSON.stringify(analysisId)}, 1500)`);
  await js(`window.__app.refresh()`);
  await wait(400);
  const msAtOrigin = await js(`window.__ma.seekTick(0)`);
  const pxOrigin = await js(`window.__ma.playheadPx()`);
  check(
    'offset=1500 → 第 1 小节首拍落在音频 1.5s，播放头在 0px',
    Math.abs(msAtOrigin - 1500) <= 2 && pxOrigin === 0,
    { msAtOrigin, pxOrigin }
  );

  // 107 BPM 下第 12 小节首拍 = 1500 + 33×560.75 ≈ 20005ms
  const msAtA1 = await js(`window.__ma.seekTick(15840)`);
  const pxA1 = await js(`window.__ma.playheadPx()`);
  const xA1 = await js(`window.__ma.xOfTick(15840)`);
  check(
    '播放头像素 = 第 12 小节首拍像素（107BPM + offset 一起算）',
    Math.abs(msAtA1 - 20005) <= 4 && Math.abs(pxA1 - xA1) <= 1,
    { msAtA1, pxA1, xA1 }
  );

  // 真放音：播放中 currentMs 必须往前走
  const playStart = await audioState();
  await js(`window.__ma.play()`);
  await wait(800);
  const playDuring = await audioState();
  await js(`window.__ma.pause()`);
  check(
    '播放推进（800ms 内前进 > 400ms）',
    playDuring.playing === true && playDuring.currentMs - playStart.currentMs > 400,
    { from: playStart.currentMs, to: playDuring.currentMs, playing: playDuring.playing, error: playDuring.error }
  );

  /* ---- EOF 陷阱：播到结尾 → 拖到最右 → 拉回中间 → 再播 ----
   * 用户报的复现：播放头走到曲子末尾（触底）后拖回来，按播放没反应，
   * 播放条上挂着橙色的「播放失败」。这条断言同时是回归保护。 */
  const durMs = Number((await audioState())?.durationMs ?? 0);
  await js(`window.__ma.seekMs(${Math.max(0, durMs - 500)})`);
  await js(`window.__ma.play()`);
  let atEnd: any = null;
  for (let i = 0; i < 24; i++) {
    await wait(150);
    atEnd = await audioState();
    if (atEnd && atEnd.playing === false) break;
  }
  await js(`window.__ma.seekMs(${durMs + 8000})`);
  await wait(280);
  const atBottom: any = await audioState();
  await js(`window.__ma.seekMs(${Math.round(durMs / 2)})`);
  await wait(340);
  const midState: any = await audioState();
  await js(`window.__ma.play()`);
  await wait(800);
  const replayState: any = await audioState();
  await js(`window.__ma.pause()`);
  check(
    '播到结尾 → 拖到最右 → 拉回中间 → 再播：能继续播，全程不留「无法播放 / 播放失败」',
    replayState?.playing === true &&
      !replayState?.error &&
      !atBottom?.error &&
      replayState.currentMs > durMs / 2,
    {
      durMs,
      atEnd: atEnd && { playing: atEnd.playing, ms: atEnd.currentMs, err: atEnd.error },
      atBottom: { ms: atBottom?.currentMs, err: atBottom?.error },
      mid: { ms: midState?.currentMs, err: midState?.error },
      replay: { playing: replayState?.playing, ms: replayState?.currentMs, err: replayState?.error },
    }
  );
  // 单独再验一次「停在曲末」本身：播放头会被夹在 duration - 60ms，且不产生错误
  const eofSeek = (await js(`window.__ma.seekMs(${durMs + 5000})`)) as number;
  await wait(260);
  const eofState: any = await audioState();
  check(
    '拖到最右（越界）后播放头夹在离末尾 60ms 内，且没有任何错误提示',
    !eofState?.error && eofSeek <= durMs - 55 && eofSeek >= durMs - 65,
    { durMs, eofSeek, err: eofState?.error, ms: eofState?.currentMs }
  );

  // 收尾必须把位置与视口都复位：后面「点刻度条 / 拖动」都假设 tick 0 在视口里，
  // 停在曲子中间会让它们点空（第一次加这条断言时就是这么把后面 5 条全带崩的）
  await js(`window.__ma.pause()`);
  await js(`window.__ma.seekTick(0)`);
  await js(`window.__ma.scrollTo(0)`);
  await wait(220);

  // ---- 主输出增益：满格 0 dB，往下负增益，拉到底 -∞（DAW 的推子读数） ----
  // 增益是持久化的（下次启动还记得推子位置），所以不能假设开局就是满格 —— 先归零。
  await js(`document.querySelector('.fader').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await wait(120);
  const gainInit = await js(`(() => ({
    db: document.querySelector('.gain-db')?.textContent?.trim() ?? null,
    gain: window.__transport?.gain?.(),
    exists: !!document.querySelector('.fader'),
  }))()`);
  check(
    '主输出推子满格 = 0.0 dB（线性幅度 1）',
    gainInit.exists === true && gainInit.db === '0.0 dB' && Math.abs((gainInit.gain ?? 0) - 1) < 1e-6,
    gainInit
  );

  /**
   * 把推子拖到某个比例（0~1）上，越界由 setGain 自己夹住。
   * 拖完必须等一轮渲染再读读数：改的是响应式状态，DOM 要下一个 tick 才更新，
   * 立刻读会拿到上一帧的值（这个坑在冒烟里表现为「读数永远慢一拍」）。
   */
  const dragFader = async (ratio: number) => {
    await js(`(() => {
      const f = document.querySelector('.fader');
      const r = f.getBoundingClientRect();
      const fire = (type, x, buttons) => f.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: r.top + r.height / 2, button: 0, buttons, pointerId: 31,
        bubbles: true, cancelable: true }));
      const x = r.left + r.width * ${ratio};
      fire('pointerdown', x, 1);
      fire('pointerup', x, 0);
    })()`);
    await wait(90);
    return js(`document.querySelector('.gain-db')?.textContent?.trim() ?? null`);
  };

  const gainHalf = await dragFader(0.5);
  check('推子一半 ≈ -6.0 dB（幅度 0.5 = 20·log10(0.5)）', gainHalf === '-6.0 dB', {
    gainHalf,
    gain: await js(`window.__transport?.gain?.()`),
  });

  const gainZero = await dragFader(-0.5); // 超出左端，应被夹到 0
  check('推子拉到最低 = -∞ dB（不是 0 dB，也不是某个小数）', gainZero === '-∞ dB', {
    gainZero,
    gain: await js(`window.__transport?.gain?.()`),
  });

  await js(`document.querySelector('.fader').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await wait(120);
  const gainBack = await js(`(() => ({
    db: document.querySelector('.gain-db')?.textContent?.trim() ?? null,
    gain: window.__transport?.gain?.(),
  }))()`);
  check('双击推子回到 0.0 dB（满格）', gainBack.db === '0.0 dB' && Math.abs(gainBack.gain - 1) < 1e-6, gainBack);

  /* ---- 播放条 v0.49：Cubase 式主/次时间、Tap、节拍器、日志目录 ---- */
  const tpSnapshot = (await js(`(() => {
    const t = document.querySelector('.transport');
    return {
      exists: !!t,
      audioBtn: !!document.querySelector('.audio-btn'),
      text: t?.textContent ?? '',
      timeBtns: document.querySelectorAll('.time-btn').length,
      timeCells: document.querySelectorAll('.time-cell').length,
      icons: [...document.querySelectorAll('.time-btn .tfi')].map((el) => el.textContent.trim()),
      barFields: [...document.querySelectorAll('.time-btn .bb-tc i')].slice(0, 4).map((el) => Math.round(el.getBoundingClientRect().width)),
      barAlign: [...document.querySelectorAll('.time-btn .bb-tc i')].slice(0, 4).map((el) => getComputedStyle(el).textAlign),
      metroShape: !!document.querySelector('.metro-shape'),
      primary: window.__transport.primaryText(),
      secondary: window.__transport.secondaryText(),
      formats: window.__transport.formats(),
      tempo: document.querySelector('.tempo-val')?.textContent?.trim() ?? '',
      meter: document.querySelector('.meter-cell .num')?.textContent?.trim() ?? '',
      overflow: t ? t.scrollWidth - t.clientWidth : -1,
    };
  })()`)) as any;
  check(
    '播放条：不再显示音频文件名/选择音频；主时间=小节.拍、次时间=时间码、30fps',
    tpSnapshot?.exists === true &&
      tpSnapshot.audioBtn === false &&
      !/选择音频|Choose audio/.test(String(tpSnapshot.text)) &&
      tpSnapshot.timeBtns === 2 &&
      tpSnapshot.timeCells === 3 &&
      JSON.stringify(tpSnapshot.icons) === JSON.stringify(['♩', 'TC']) &&
      tpSnapshot.barFields?.length === 4 &&
      tpSnapshot.barFields[0] >= tpSnapshot.barFields[1] * 1.8 &&
      tpSnapshot.barFields[1] === tpSnapshot.barFields[2] &&
      tpSnapshot.barFields[3] > tpSnapshot.barFields[1] &&
      tpSnapshot.barAlign?.every((x: string) => x === 'right') &&
      tpSnapshot.metroShape === true &&
      /^\d+\.\d+\.\d+\.\d+$/.test(String(tpSnapshot.primary)) &&
      /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(String(tpSnapshot.secondary)) &&
      tpSnapshot.formats?.primary === 'bars' &&
      tpSnapshot.formats?.secondary === 'timecode' &&
      tpSnapshot.formats?.fps === 30 &&
      tpSnapshot.tempo === '107.000' &&
      tpSnapshot.meter === '3/4' &&
      tpSnapshot.overflow <= 1,
    tpSnapshot
  );

  const tpCompact = (await js(`(() => {
    const btns = [...document.querySelectorAll('.time-btn')];
    const bar = document.querySelector('.bar');
    const metro = document.querySelector('.metro-shape');
    const metroPoly = metro?.querySelector('polygon');
    const grow = document.querySelector('.transport .grow');
    return {
      chevrons: document.querySelectorAll('.time-ico').length,
      widths: btns.map((el) => Math.round(el.getBoundingClientRect().width * 10) / 10),
      gap: btns[0] ? getComputedStyle(btns[0]).gap : null,
      valMin: [...document.querySelectorAll('.time-val')].map((el) => getComputedStyle(el).minWidth),
      vw: document.documentElement.clientWidth,
      barW: Math.round(bar?.getBoundingClientRect().width ?? 0),
      barFlex: bar ? getComputedStyle(bar).flexGrow : null,
      growFlex: grow ? getComputedStyle(grow).flexGrow : null,
      metroTag: metro?.tagName.toLowerCase() ?? null,
      metroFill: metroPoly?.getAttribute('fill') ?? null,
      metroStroke: metroPoly?.getAttribute('stroke') ?? null,
      metroBg: metro ? getComputedStyle(metro).backgroundColor : null,
    };
  })()`)) as any;
  check(
    '时间块去掉 ▾ 并收紧（图标-数字 2px / 读数槽 80px）；进度条独占剩余空间；节拍器图标镂空',
    tpCompact?.chevrons === 0 &&
      tpCompact.widths?.length === 2 &&
      tpCompact.widths.every((w: number) => w > 80 && w < 120) &&
      tpCompact.gap === '2px' &&
      tpCompact.valMin?.every((w: string) => w === '80px') &&
      tpCompact.barW >= tpCompact.vw * 0.28 &&
      tpCompact.barFlex === '1' &&
      tpCompact.growFlex === '0' &&
      tpCompact.metroTag === 'svg' &&
      tpCompact.metroFill === 'none' &&
      tpCompact.metroStroke === 'currentColor' &&
      tpCompact.metroBg === 'rgba(0, 0, 0, 0)',
    tpCompact
  );

  const tpFmt = (await js(`(async () => {
    const before = window.__transport.formats();
    // 换格式的入口是**图标**（数字那块留给「改位置」）
    const icons = [...document.querySelectorAll('.time-btn .fmt-btn')];
    icons[0].click();
    await new Promise((r) => setTimeout(r, 60));
    const menu = !!document.querySelector('.time-pop');
    const options = [...document.querySelectorAll('.time-pop button')].map((b) => b.textContent.trim());
    // Alt+点图标：交换主/次格式（真实 DOM 事件，不走调试钩子）
    icons[0].dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    await new Promise((r) => setTimeout(r, 60));
    const after = window.__transport.formats();
    window.__transport.setFormat('primary', 'bars');
    window.__transport.setFormat('secondary', 'timecode');
    window.__transport.setFps(30);
    return { before, menu, options, after };
  })()`)) as any;
  check(
    '时间格式菜单有 3 种；Alt+点击交换主/次时间格式',
    tpFmt?.menu === true &&
      tpFmt.options?.length === 3 &&
      tpFmt.options.some((x: string) => x.includes('时间码')) &&
      tpFmt.before?.primary === 'bars' &&
      tpFmt.after?.primary === 'timecode' &&
      tpFmt.after?.secondary === 'bars',
    tpFmt
  );

  /* ---- 点数字 = 改位置（以前整块只能换格式） ---- */
  const tpEdit = (await js(`(async () => {
    const val = document.querySelectorAll('.time-cell .time-val')[0];
    const beforeText = val?.textContent?.trim() ?? '';
    val?.click();
    await new Promise((r) => setTimeout(r, 90));
    const input = document.querySelector('.time-cell .time-input');
    if (!input) return { hadInput: false, beforeText };
    input.value = '5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 360));
    return {
      hadInput: true,
      beforeText,
      stillEditing: !!document.querySelector('.time-cell .time-input'),
      primary: window.__transport.primaryText(),
    };
  })()`)) as any;
  check(
    '点读数进入编辑态；输入「5」回车 → 播放头跳到第 5 小节，读数变成 5.x',
    tpEdit?.hadInput === true &&
      tpEdit?.stillEditing === false &&
      /^5\./.test(String(tpEdit?.primary ?? '')),
    tpEdit
  );

  const tpFps = (await js(`(async () => {
    document.querySelector('.fps')?.click();
    await new Promise((r) => setTimeout(r, 60));
    const options = [...document.querySelectorAll('.time-pop button')].map((b) => b.textContent.trim());
    [...document.querySelectorAll('.time-pop button')].find((b) => b.textContent.includes('25'))?.click();
    await new Promise((r) => setTimeout(r, 60));
    const after = window.__transport.formats();
    window.__transport.setFps(30);
    return { options, after, reset: window.__transport.formats() };
  })()`)) as any;
  check(
    '帧速率设置菜单含 24/25/30/50/60；选 25 后生效',
    tpFps?.options?.includes('25 fps') === true &&
      tpFps.after?.fps === 25 &&
      tpFps.reset?.fps === 30,
    tpFps
  );

  const tpTempoDlg = (await js(`(async () => {
    document.querySelector('.tempo-cell')?.click();
    await new Promise((r) => setTimeout(r, 60));
    const input = document.querySelector('.tp-dialog input');
    const value = input ? Number(input.value) : null;
    document.querySelector('.tp-dialog .chip')?.click();
    await new Promise((r) => setTimeout(r, 60));
    return { open: !!input, value };
  })()`)) as any;
  check(
    '点击速度读数打开手动输入框，预填当前速度',
    tpTempoDlg?.open === true && Math.abs(Number(tpTempoDlg.value) - 107) < 0.01,
    tpTempoDlg
  );

  const tempoBefore = Number(
    (rows(`SELECT bpm FROM analysis_marker WHERE analysis_id = ? AND kind = 'tempo' AND tick = 0`, analysisId)[0] as any)
      ?.bpm ?? 107
  );
  await js(`window.__transport.applyTempo(120)`);
  await wait(320);
  const tempoAfter = Number(
    (rows(`SELECT bpm FROM analysis_marker WHERE analysis_id = ? AND kind = 'tempo' AND tick = 0`, analysisId)[0] as any)
      ?.bpm ?? 0
  );
  await js(`window.api.tracks.update(${JSON.stringify(trackId)}, { bpm: ${tempoBefore} })`);
  await js(`window.__app.refresh()`);
  await wait(320);
  const tempoRestored = Number(
    (rows(`SELECT bpm FROM analysis_marker WHERE analysis_id = ? AND kind = 'tempo' AND tick = 0`, analysisId)[0] as any)
      ?.bpm ?? 0
  );
  check(
    'Tap/手动应用速度：写回当前 tempo 段，恢复后回到原值',
    tempoAfter === 120 && tempoRestored === tempoBefore,
    { before: tempoBefore, after: tempoAfter, restored: tempoRestored }
  );

  const tpTap = (await js(`(async () => {
    window.__transport.tap();
    await new Promise((r) => setTimeout(r, 360));
    window.__transport.tap();
    await new Promise((r) => setTimeout(r, 360));
    window.__transport.tap();
    await new Promise((r) => setTimeout(r, 1150));
    const st = window.__transport.tapState();
    const input = document.querySelector('.tp-dialog input');
    const value = input ? Number(input.value) : null;
    document.querySelector('.tp-dialog .chip')?.click();
    await new Promise((r) => setTimeout(r, 60));
    return { st, value };
  })()`)) as any;
  check(
    'Tap 连点计算速度，停手后弹确认框（数值可手动改）',
    !!tpTap?.st?.dialog &&
      Number(tpTap.st.dialog.bpm) > 100 &&
      Number(tpTap.st.dialog.bpm) < 220 &&
      Number(tpTap.value) === Number(tpTap.st.dialog.bpm),
    tpTap
  );

  const tpMetro = (await js(`(async () => {
    const before = window.__transport.metronome();
    window.__transport.setMetronome(true);
    await new Promise((r) => setTimeout(r, 100));
    const on = window.__transport.metronome();
    document.querySelector('.metro-gear')?.click();
    await new Promise((r) => setTimeout(r, 60));
    const pop = !!document.querySelector('.metro-pop');
    const hasVolume = !!document.querySelector('.metro-pop input[type=range]');
    const hasAccent = !!document.querySelector('.metro-pop input[type=checkbox]');
    const range = document.querySelector('.metro-pop input[type=range]');
    const check = document.querySelector('.metro-pop input[type=checkbox]');
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const themeAccent = getComputedStyle(probe).color;
    probe.remove();
    const accent = range ? getComputedStyle(range).accentColor : null;
    const checkAccent = check ? getComputedStyle(check).accentColor : null;
    document.querySelector('.metro-gear')?.click();
    window.__transport.setMetronome(false);
    return { before, on, pop, hasVolume, hasAccent, accent, checkAccent, themeAccent, off: window.__transport.metronome() };
  })()`)) as any;
  check(
    '节拍器开关 + 设置弹层（音量 / 重拍）',
    tpMetro?.before?.on === false &&
      tpMetro?.on?.on === true &&
      tpMetro?.pop === true &&
      tpMetro?.hasVolume === true &&
      tpMetro?.hasAccent === true &&
      !!tpMetro?.themeAccent &&
      tpMetro?.accent === tpMetro?.themeAccent &&
      tpMetro?.checkAccent === tpMetro?.themeAccent &&
      tpMetro?.off?.on === false,
    tpMetro
  );

  const logPath = path.join(app.getAppPath(), 'logs', 'boot.log');
  const oldLogPath = path.join(app.getAppPath(), 'boot.log');
  check(
    '启动日志统一写到 logs/boot.log（仓库根不再有 boot.log）',
    fs.existsSync(logPath) && !fs.existsSync(oldLogPath),
    { log: logPath, exists: fs.existsSync(logPath), oldExists: fs.existsSync(oldLogPath) }
  );

  // 点波形/刻度带 = 定位到那一格
  const box = await js(`window.__ma.canvasBox()`);
  const bandY = await js(`Math.round(window.__ma.waveH() / 2)`);
  const xBar2 = await js(`window.__ma.xOfTick(1440)`);
  await js(
    `(() => {
       const cv = document.querySelector('canvas');
       const fire = (type, buttons) => cv.dispatchEvent(new PointerEvent(type, {
         clientX: ${box.left} + ${xBar2} + 2, clientY: ${box.top} + ${bandY},
         button: 0, buttons, pointerId: 9, bubbles: true, cancelable: true }));
       fire('pointerdown', 1);
       fire('pointermove', 1);
       fire('pointerup', 0);
     })()`
  );
  await wait(300);
  const scrubMs = (await audioState()).currentMs;
  check(
    '点刻度条定位：第 2 小节 ≈ 1.5s + 1.682s（±1 格）',
    Math.abs(scrubMs - 3182) <= 60,
    { scrubMs }
  );

  /* ---- 拖播放条进度条 → 播放光标跑出视窗也要翻页（v0.37） ---- */
  await js(`window.__ma.scrollTo(0)`);
  await js(`window.__ma.seekMs(1500)`);
  await wait(200);
  await js(`window.__ma.seekMs(60000)`);
  await wait(320);
  const reveal = (await js(`({
    sl: window.__ma.scrollLeft(),
    px: window.__ma.playheadPx(),
    vw: window.__ma.box()?.rectW ?? 0,
  })`)) as any;
  check(
    '拖进度条跳到远处 → 视图自动翻页，播放头停在离右边缘 96px 处',
    reveal.px - reveal.sl > 0 &&
      reveal.px - reveal.sl < reveal.vw &&
      Math.abs(reveal.px - reveal.sl - (reveal.vw - 96)) <= 3,
    reveal
  );
  await js(`window.__ma.scrollTo(0)`);
  await wait(160);

  // ---- 拖动移动：框住的 I 从第 12 小节拖到第 13 小节，顺手换一条泳道 ----
  await js(`window.__ma.unit('beat')`);
  await js(`window.__ma.select(12, 0, 2)`);
  await js(`window.__ma.fill('I')`);
  // 拖动的命中检测读 props.analysis.events（不是数据库），等它刷新完再起手，
  // 否则会当成「按在空白处」→ 变成框选，事件当然不动
  let dragReady = false;
  for (let i = 0; i < 25 && !dragReady; i++) {
    dragReady = await js(`window.__ma.events().some((e) => e.text === 'I' && e.tick === 15840)`);
    if (!dragReady) await wait(120);
  }
  check('拖动前：网格已拿到刚落库的 I', dragReady === true, dragReady);

  const box2 = await js(`window.__ma.canvasBox()`);
  const yLane0 = await js(`window.__ma.yOfLane(0)`);
  const yLane2 = await js(`window.__ma.yOfLane(2)`);
  // 第 3 条泳道是谁不要写死：roman 视图删掉「转位」之后，这里从 bass 变成了 note。
  // 断言要跟着视图定义走，否则以后再加/删一条泳道就要来改一次测试。
  const lane2Id = ((await js(`window.__ma.grid()`)) as any)?.lanes?.[2] ?? null;
  const xFrom = await js(`window.__ma.xOfTick(15840)`);
  const xTo = await js(`window.__ma.xOfTick(17280)`);
  // 从**块中心**起手：贴边 7px 现在是「拉宽」手势，从边缘起手会（正确地）变成改时值
  const xMid = Math.round((xFrom + xTo) / 2);
  await js(`(() => {
    const cv = document.querySelector('canvas');
    const fire = (type, x, y, buttons) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0, buttons, pointerId: 7, bubbles: true, cancelable: true }));
    fire('pointerdown', ${box2.left} + ${xMid}, ${box2.top} + ${yLane0}, 1);
    fire('pointermove', ${box2.left} + ${xMid + 8}, ${box2.top} + ${yLane0}, 1);
    fire('pointermove', ${box2.left} + ${xTo} + ${xMid - xFrom}, ${box2.top} + ${yLane2}, 1);
    fire('pointerup', ${box2.left} + ${xTo} + ${xMid - xFrom}, ${box2.top} + ${yLane2}, 0);
  })()`);
  await wait(420);
  const movedRow = rows(
    `SELECT lane, tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND text = 'I'`,
    analysisId
  )[0];
  check(
    '拖动移动：I 落在第 13 小节（17280）且换到第 3 条泳道，时值不变（1440）',
    movedRow?.tick === 17280 && movedRow?.lane === lane2Id && movedRow?.dur_ticks === 1440,
    { ...movedRow, lane2Id }
  );

  await js(`window.__ma.undo()`);
  await wait(300);
  const movedBack = rows(
    `SELECT lane, tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND text = 'I'`,
    analysisId
  )[0];
  check(
    '撤销拖动：回到第 12 小节原泳道',
    movedBack?.tick === 15840 && movedBack?.lane === 'degree',
    movedBack
  );

  // ---- 边缘判定 + 拖边缘改范围 ----
  // 用一条孤立事件测：I 的右端和 V7 的右端重合，站在那儿「想拉谁」本身就有歧义，
  // 拿它当用例只会测出边界情况，看不出手势对不对。
  await js(`window.__ma.unit('beat')`);
  await js(`window.__ma.select(20, 0, 1)`);
  await js(`window.__ma.type('vi')`);
  await wait(360);
  const iso = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='vi' ORDER BY rowid DESC`,
    analysisId
  )[0];
  const edgeL = await js(`window.__ma.edgeAtTick(${iso.tick}, 'degree')`);
  const edgeR = await js(`window.__ma.edgeAtTick(${iso.tick + iso.dur_ticks}, 'degree')`);
  const edgeMid = await js(`window.__ma.edgeAtTick(${iso.tick + Math.round(iso.dur_ticks / 2)}, 'degree')`);
  check(
    '边缘判定：左端算 left、右端算 right、中间返回 null（中间要留给拖动移动）',
    edgeL === 'left' && edgeR === 'right' && edgeMid === null,
    { edgeL, edgeR, edgeMid, iso }
  );

  const xRight = await js(`window.__ma.xOfTick(${iso.tick + iso.dur_ticks})`);
  // 落在「多出来那一格的中间」：终点吸附到该格末尾，正好多一拍。
  // 拖到格边界上会落到下一格，那是另一回事（也有用，但不是这条要验的）
  const xGrow = await js(`window.__ma.xOfTick(${iso.tick + iso.dur_ticks + 240})`);
  await js(`(() => {
    const cv = document.querySelector('canvas');
    const fire = (type, x, y, buttons) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0, buttons, pointerId: 11, bubbles: true, cancelable: true }));
    fire('pointerdown', ${box2.left} + ${xRight} - 2, ${box2.top} + ${yLane0}, 1);
    fire('pointermove', ${box2.left} + ${xGrow}, ${box2.top} + ${yLane0}, 1);
    fire('pointerup', ${box2.left} + ${xGrow}, ${box2.top} + ${yLane0}, 0);
  })()`);
  await wait(420);
  const resized = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='vi' ORDER BY rowid DESC`,
    analysisId
  )[0];
  check(
    '拖右边缘：覆盖范围多一拍（一拍 480 tick），起点不动',
    resized?.tick === iso.tick && resized?.dur_ticks === iso.dur_ticks + 480,
    { before: iso, after: resized }
  );
  await js(`window.__ma.undo()`);
  await wait(300);
  const resizedBack = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='vi' ORDER BY rowid DESC`,
    analysisId
  )[0];
  check('撤销拖边缘：时值回到原样', resizedBack?.dur_ticks === iso.dur_ticks, resizedBack);

  // 块外 3px 已经是下一格：单击必须选下一格，不能变成上一块的「拉宽」
  const xOut = xRight + 3;
  await js(`(() => {
    const cv = document.querySelector('canvas');
    const fire = (type, x, y, buttons) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0, buttons, pointerId: 12, bubbles: true, cancelable: true }));
    fire('pointerdown', ${box2.left} + ${xOut}, ${box2.top} + ${yLane0}, 1);
    fire('pointerup', ${box2.left} + ${xOut}, ${box2.top} + ${yLane0}, 0);
  })()`);
  await wait(220);
  const selOut = (await js(`window.__ma.selState()`)) as any;
  const gestureOut = (await js(`window.__ma.gesture()`)) as any;
  check(
    '块外 3px 不再判给上一块：单击落到下一格（选区从下一格起点开始）',
    selOut?.selection?.startTick === iso.tick + iso.dur_ticks && gestureOut?.edge == null,
    { startTick: selOut?.selection?.startTick, want: iso.tick + iso.dur_ticks, gesture: gestureOut }
  );

  /**
   * 缩回去：这是「切成两份」那个 bug 的现场。
   * 拉宽时 writeRange 会把原事件多出来的半截另存一条（正确）；
   * 缩窄时同样会留一条旧尾巴（错误）—— 所以收缩走 analysis.resize，
   * 它会把原区间露在新区间之外的部分一起剪掉。
   */
  const dragEdge = async (fromTick: number, toTick: number, pointerId: number) => {
    const x0 = await js(`window.__ma.xOfTick(${fromTick})`);
    const x1 = await js(`window.__ma.xOfTick(${toTick})`);
    await js(`(() => {
      const cv = document.querySelector('canvas');
      const fire = (type, x, y, buttons) => cv.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, button: 0, buttons, pointerId: ${pointerId}, bubbles: true, cancelable: true }));
      fire('pointerdown', ${box2.left} + ${x0} - 2, ${box2.top} + ${yLane0}, 1);
      fire('pointermove', ${box2.left} + ${x1}, ${box2.top} + ${yLane0}, 1);
      fire('pointerup', ${box2.left} + ${x1}, ${box2.top} + ${yLane0}, 0);
    })()`);
    await wait(420);
  };

  await dragEdge(iso.tick + iso.dur_ticks, iso.tick + iso.dur_ticks + 240, 21);
  const grownAgain = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='vi' ORDER BY rowid DESC`,
    analysisId
  )[0];
  await dragEdge(iso.tick + iso.dur_ticks + 480, iso.tick + iso.dur_ticks - 240, 22);
  const shrunk = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='vi' ORDER BY rowid DESC`,
    analysisId
  );
  check(
    '拖右边缘缩回去：只剩一条，不留同名的旧尾巴（不再是「切成两份」）',
    grownAgain?.dur_ticks === iso.dur_ticks + 480 &&
      shrunk.length === 1 &&
      shrunk[0].tick === iso.tick &&
      shrunk[0].dur_ticks === iso.dur_ticks,
    { grownAgain, shrunk }
  );

  // ---- Alt + 方向键：一步一格地改范围（单位=拍时一格 480 tick） ----
  await js(`window.__ma.unit('beat')`);
  await js(`window.__ma.select(16, 0, 1)`);
  const selBeforeType = await js(`window.__ma.selection()`);
  await js(`window.__ma.type('ii')`);
  await wait(360);
  await js(`window.__ma.select(16, 0, 1)`); // type 之后选区已后移，重新框住这条事件
  const ii0 = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='ii' ORDER BY rowid DESC`,
    analysisId
  )[0];
  const iiSel = await js(`window.__ma.selection()`);
  await js(`window.__ma.nudge('right', 1)`);
  await wait(360);
  const ii1 = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='ii' ORDER BY rowid DESC`,
    analysisId
  )[0];
  check(
    'Alt+→ 右端扩一格（+480 一拍），起点不动',
    !!ii0 && !!ii1 && ii1.tick === ii0.tick && ii1.dur_ticks === ii0.dur_ticks + 480,
    { ii0, ii1, iiSel }
  );
  await js(`window.__ma.nudge('right', -1)`);
  await wait(360);
  const ii2 = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='ii' ORDER BY rowid DESC`,
    analysisId
  )[0];
  check('Alt+← 收回来（回到原时值）', ii2?.dur_ticks === ii0?.dur_ticks, { ii0, ii2 });

  // ---- Alt + 拖动：复制一份到落点，原事件原地不动 ----
  const iiNow = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='ii' ORDER BY rowid DESC`,
    analysisId
  )[0];
  if (!iiNow) {
    check('Alt+拖动复制需要先有 ii 事件（缺了说明前面的输入没落库）', false, { ii0, ii2 });
  }
  const iiX = iiNow ? ((await js(`window.__ma.xOfTick(${iiNow.tick})`)) as number) : 0;
  const iiW = iiNow
    ? ((await js(`window.__ma.xOfTick(${iiNow.tick + iiNow.dur_ticks}) - window.__ma.xOfTick(${iiNow.tick})`)) as number)
    : 40;
  const iiMid = Math.round(iiX + iiW / 2);
  await js(`(() => {
    const cv = document.querySelector('canvas');
    const fire = (type, x, y, buttons, alt) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0, buttons, pointerId: 12, altKey: alt, bubbles: true, cancelable: true }));
    const x0 = ${box2.left} + ${iiMid};
    const x1 = ${box2.left} + ${iiMid} + ${iiW};
    fire('pointerdown', x0, ${box2.top} + ${yLane0}, 1, true);
    fire('pointermove', x0 + 10, ${box2.top} + ${yLane0}, 1, true);
    fire('pointermove', x1, ${box2.top} + ${yLane0}, 1, true);
    fire('pointerup', x1, ${box2.top} + ${yLane0}, 0, true);
  })()`);
  await wait(450);
  const iiAll = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? AND lane='degree' AND text='ii' ORDER BY tick`,
    analysisId
  );
  check(
    'Alt 拖动 = 复制：落点多出一条同样时值，原事件仍在原位',
    iiAll.length === 2 &&
      iiAll[0].tick === iiNow.tick &&
      iiAll[1].tick === iiNow.tick + iiNow.dur_ticks &&
      iiAll[1].dur_ticks === iiNow.dur_ticks,
    { before: iiNow, after: iiAll }
  );
  await js(`window.__ma.undo()`);
  await wait(300);


  // ---- 和弦符号解析：落库 + 选区条显示 ----
  await js(`window.__ma.select(12, 0, 0)`);
  await js(`window.__ma.fill('V7/V')`);
  await wait(280);
  const goodRow = rows(
    `SELECT text, parsed FROM analysis_event WHERE analysis_id = ? AND text = 'V7/V'`,
    analysisId
  )[0];
  const goodParsed = goodRow?.parsed ? JSON.parse(goodRow.parsed) : null;
  check(
    '和弦符号落库并解析：V7/V → D7（rootPc 2 / 小七 / 副属）',
    !!goodParsed && goodParsed.ok === true && goodParsed.rootPc === 2 && goodParsed.seventh === 'minor' && goodParsed.appliedTo === 5,
    goodParsed
  );
  const parsedText = await js(`document.querySelector('.selbar .parsed')?.textContent?.trim() ?? ''`);
  check('选区条显示解析结果（级数 / 性质 / 转位）', /5 级/.test(parsedText) && /原位/.test(parsedText), parsedText);

  await js(`window.__ma.select(12, 1, 1)`);
  await js(`window.__ma.fill('@@')`);
  await wait(280);
  const badRow = rows(
    `SELECT text, parsed FROM analysis_event WHERE analysis_id = ? AND text = '@@'`,
    analysisId
  )[0];
  const badParsed = badRow?.parsed ? JSON.parse(badRow.parsed) : null;
  check(
    '无法解析的符号不猜：文本照存，parsed.ok=false',
    badRow?.text === '@@' && badParsed?.ok === false && badParsed.errors.length > 0,
    badParsed
  );
  const warnChip = await js(`document.querySelector('.warn-chip')?.textContent?.trim() ?? ''`);
  check('工具栏提示待修符号数量', warnChip.includes('1'), warnChip);

  // 复原：这条偏移不能留给后面的断言。
  // setAudioOffset 现在写的是「主录音的那一份」，和上面写 1500 落到同一个地方。
  await js(`window.api.analysis.setAudioOffset(${JSON.stringify(analysisId)}, ${offsetBefore})`);
  await js(`window.__app.refresh()`);
  await wait(200);

  // 截图：把整小节框起来，核对选区高亮与「3 格」的读数
  await js(`window.__ma.unit('beat')`);
  await js(`window.__ma.select(12, 0, 2)`);
  await wait(300);
  await shot('smoke-grid.png');
  await js(`window.__ma.clear()`);
  await wait(150);
  await shot('smoke-grid-clean.png');

  /* ---- 输入法：组合期的 Enter 不能当成「写库并跳下一格」 ----
   * 不判组合态时，用中文输入法按 Enter 确认候选词会被当成提交，
   * 写进库的是组合前的旧内容（模板上的 `.prevent` 还会把候选词上屏打断）。
   */
  await js(`window.__ma.select(12, 0, 0)`);
  await wait(90);
  await js(`window.__ma.openEdit('')`);
  await wait(140);
  await js(`(() => {
    const i = document.querySelector('.cell-input');
    if (!i) return;
    i.focus();
    i.value = 'IV';
    i.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
  })()`);
  await wait(240);
  const cellImeOpen = await js(`!!document.querySelector('.cell-input')`);
  // 收尾：Esc 放弃这次输入，别把半截内容写进库
  await js(`document.querySelector('.cell-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(180);
  const cellImeClosed = await js(`!document.querySelector('.cell-input')`);
  check(
    '网格单元格：输入法组合期的 Enter 不提交（输入框还在，Esc 才退出）',
    cellImeOpen === true && cellImeClosed === true,
    { cellImeOpen, cellImeClosed }
  );

  /* ---- 网格手势：单击 = 只选中，双击 = 进输入（与头带的两条标记带一致） ---- */
  const gridMeta = (await js(`window.__ma.grid()`)) as any;
  const m0 = gridMeta?.meters?.[0] ?? { num: 4, den: 4 };
  const barTicks = Math.max(1, Math.round(((gridMeta?.ppq ?? 480) * 4 * (m0.num ?? 4)) / (m0.den ?? 4)));
  await js(`window.__ma.scrollTo(0)`);
  await wait(150);
  const gridBox = (await js(`window.__ma.canvasBox()`)) as any;
  const gy0 = (await js(`window.__ma.yOfLane(0)`)) as number;

  /** 在网格第 0 条泳道上点一次（合成 pointerdown/up，detail 由参数给） */
  const clickGridAt = async (tick: number, detail = 0, offset = 6) => {
    const x = (await js(`window.__ma.xOfTick(${tick})`)) as number;
    await js(`(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return;
      const fire = (type) => cv.dispatchEvent(new PointerEvent(type, {
        clientX: ${gridBox.left} + ${x} + ${offset}, clientY: ${gridBox.top} + ${gy0}, button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        pointerId: 31, bubbles: true, cancelable: true, detail: ${detail},
      }));
      fire('pointerdown'); fire('pointerup');
    })()`);
    await wait(200);
  };

  const firstChord = rows(
    `SELECT tick, dur_ticks, text FROM analysis_event
      WHERE analysis_id = ? AND lane = 'degree' ORDER BY tick LIMIT 1`,
    analysisId
  )[0] as any;

  await clickGridAt(firstChord.tick);
  const clickSel = await js(`window.__ma.selection()`);
  const clickEditing = await js(`window.__ma.editing()`);
  // 第二轮（系统双击窗口内）= 双击 → 进入输入态，且带着原符号
  await clickGridAt(firstChord.tick);
  const dblEditing = await js(`window.__ma.editing()`);
  check(
    '单击已有和弦 = 只选中（不弹输入框）；再点一下才进编辑态',
    clickSel?.startTick === firstChord.tick && clickEditing === null && dblEditing === firstChord.text,
    { clickSel, clickEditing, dblEditing, firstChord }
  );
  await js(`document.querySelector('.cell-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(180);

  // 框选两格以上 → 直接进输入态（这条是保留的旧行为）
  // 先停播 + 清选区：这条用例验的是「纯框选」，
  // 播放中的跟随会在松手后改选区，上一轮残留的 Esc 也可能把刚开的输入框关掉
  await js(`window.__ma.pause()`);
  await js(`window.__ma.clear()`);
  await wait(150);
  const dragTick0 = barTicks;
  const dragTick1 = barTicks * 3;
  const dx0 = (await js(`window.__ma.xOfTick(${dragTick0})`)) as number;
  const dx1 = (await js(`window.__ma.xOfTick(${dragTick1})`)) as number;
  await js(`(() => {
    const cv = document.querySelector('canvas');
    if (!cv) return;
    const fire = (type, x, buttons) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: ${gridBox.left} + x, clientY: ${gridBox.top} + ${gy0}, button: 0, buttons,
      pointerId: 32, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', ${dx0 + 6}, 1);
    fire('pointermove', ${dx0 + 18}, 1);
    fire('pointermove', ${dx1}, 1);
    fire('pointerup', ${dx1}, 0);
  })()`);
  await wait(240);
  const dragEditing = await js(`window.__ma.editing()`);
  const dragSel = await js(`window.__ma.selection()`);
  const dragSelInfo = (await js(`window.__ma.selState()`)) as any;
  check(
    '框选两格以上 → 直接进输入态（空白格框选仍然开框）',
    dragEditing === '' && dragSel?.startTick < dragSel?.endTick,
    {
      dragEditing,
      dragSel,
      dragTick0,
      dragTick1,
      cells: dragSelInfo?.info?.cells ?? null,
      items: dragSelInfo?.items ?? null,
    }
  );
  await js(`document.querySelector('.cell-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(160);
  /* ---- 多选：框到块不进输入态 / Ctrl+点 / Shift+点 / 进行识别 / 复制粘贴 ----
   * 样本统一铺在 40~43 小节（IV–V–iii–vi，正好是王道进行），跑完删掉。
   */
  const fixture: { tick: number; endTick: number; text: string; id?: string }[] = [];
  for (const bar of [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]) {
    await js(`window.__ma.select(${bar}, 0, 3)`);
    await js(`window.__ma.del()`);
    await wait(60);
  }
  for (const [bar, text] of [[40, 'IV'], [41, 'V'], [42, 'iii'], [43, 'vi']] as [number, string][]) {
    await js(`window.__ma.select(${bar}, 0, 0)`);
    const sel = (await js(`window.__ma.selection()`)) as any;
    await js(`window.__ma.fill(${JSON.stringify(text)})`);
    await wait(150);
    fixture.push({ tick: sel.startTick, endTick: sel.endTick, text });
  }
  for (const f of fixture) {
    const r = rows(
      `SELECT id FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' AND tick = ?`,
      analysisId,
      f.tick
    )[0] as any;
    f.id = r?.id;
  }
  check('fixture：40~43 小节铺出 IV–V–iii–vi', fixture.every((f) => !!f.id), fixture.map((f) => f.text));

  // 让样本滚进视口，后面要用真实指针点它
  const fBox = (await js(`window.__ma.canvasBox()`)) as any;
  const fY = (await js(`window.__ma.yOfLane(0)`)) as number;
  const centerOn = async (tick: number) => {
    const x = (await js(`window.__ma.xOfTick(${tick})`)) as number;
    await js(`window.__ma.scrollTo(${Math.max(0, x - 240)})`);
    await wait(140);
  };
  /** 在网格第 0 条泳道上点一次（可带 Ctrl / Shift） */
  const clickChordAt = async (tick: number, mods: { ctrl?: boolean; shift?: boolean } = {}) => {
    const x = (await js(`window.__ma.xOfTick(${tick})`)) as number;
    const vl = (await js(`window.__ma.viewLeft()`)) as number;
    await js(`(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return;
      const fire = (type) => cv.dispatchEvent(new PointerEvent(type, {
        clientX: ${fBox.left} + ${x} - ${vl} + 7, clientY: ${fBox.top} + ${fY}, button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        pointerId: 51, bubbles: true, cancelable: true,
        ctrlKey: ${mods.ctrl === true}, shiftKey: ${mods.shift === true},
      }));
      fire('pointerdown'); fire('pointerup');
    })()`);
    await wait(160);
  };

  // A) 框到标记块 → 吸附成这些块，且**不**弹输入框
  // 注意：必须从「块前面的空白格」起手 —— 按在块上拖是「移动」手势，不是框选
  await centerOn(fixture[0].tick - barTicks);
  const xa = (await js(`window.__ma.xOfTick(${fixture[0].tick - barTicks})`)) as number;
  const xb = (await js(`window.__ma.xOfTick(${fixture[1].endTick})`)) as number;
  const vlA = (await js(`window.__ma.viewLeft()`)) as number;
  await js(`(() => {
    const cv = document.querySelector('canvas');
    if (!cv) return;
    const fire = (type, x, buttons) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: ${fBox.left} + x - ${vlA}, clientY: ${fBox.top} + ${fY}, button: 0, buttons,
      pointerId: 52, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', ${xa + 2}, 1);
    fire('pointermove', ${xa + 12}, 1);
    fire('pointermove', ${xb - 2}, 1);
    fire('pointerup', ${xb - 2}, 0);
  })()`);
  await wait(240);
  const blockSel = (await js(`window.__ma.selState()`)) as any;
  const blockEditing = await js(`window.__ma.editing()`);
  check(
    '框选范围内有标记块 → 选中这些块（吸附到块的真实区间，不弹输入框）',
    blockEditing === null &&
      blockSel?.selection?.startTick === fixture[0].tick &&
      blockSel?.selection?.endTick === fixture[1].endTick &&
      blockSel?.items === 2,
    { editing: blockEditing, sel: blockSel?.selection, items: blockSel?.items }
  );

  /**
   * B) Ctrl+点：用户场景是「先选中一个和弦（这时还没按 Ctrl），再按住 Ctrl 点另一个」。
   * 之前 pointerdown 会先把 selection 抢成被点的那一块 —— 于是「加选」看着像没生效
   * （旧断言只看 picks，抓不到这种「选中被顶掉」的错）。
   */
  await clickChordAt(fixture[0].tick);                       // 普通点击：选中第 1 块
  const selBeforeCtrl = (await js(`window.__ma.selection()`)) as any;
  await clickChordAt(fixture[2].tick, { ctrl: true });        // Ctrl+点 第 3 块
  const afterCtrl = (await js(`window.__ma.picks()`)) as string[];
  const selAfterCtrl = (await js(`window.__ma.selection()`)) as any;
  const itemsAfterCtrl = (await js(`window.__ma.selState()`)) as any;
  await clickChordAt(fixture[2].tick, { ctrl: true });        // 再点一次 = 取消这一块
  const afterCtrl2 = (await js(`window.__ma.picks()`)) as string[];
  const stateCtrl2 = (await js(`window.__ma.selState()`)) as any;
  check(
    'Ctrl+点 = 在已有选中之上加选一块（原选区不被顶掉）；再点一次只取消这一块，原来那块还在',
    selBeforeCtrl?.startTick === fixture[0].tick &&
      selAfterCtrl?.startTick === fixture[0].tick &&
      afterCtrl.length === 2 &&
      afterCtrl.includes(fixture[0].id) &&
      afterCtrl.includes(fixture[2].id) &&
      itemsAfterCtrl?.items === 2 &&
      // 取消 13 之后应该**剩 11**：以前 picks 从空起算，取消会把没冻结进 picks 的 11 一起抹掉
      afterCtrl2.length === 1 &&
      afterCtrl2[0] === fixture[0].id &&
      stateCtrl2?.items === 1,
    { selBeforeCtrl, selAfterCtrl, afterCtrl, items: itemsAfterCtrl?.items, afterCtrl2, itemsAfterCancel: stateCtrl2?.items }
  );

  /**
   * B2) **全程按住 Ctrl**：点第 1 块 → 点第 3 块（中途不松）。
   * 和上面那条是两种不同的手势历史：上面第一次是「普通点击」（selection 已就位、
   * picks 是空的），这里是「从头就按着 Ctrl」（selection 由第一次 Ctrl+点 建立）。
   * 用户报的就是这一种，以前没有断言盯着。
   */
  await js(`window.__ma.clear()`);
  await wait(140);
  await clickChordAt(fixture[0].tick, { ctrl: true });
  const seq1 = (await js(`window.__ma.picks()`)) as string[];
  await clickChordAt(fixture[2].tick, { ctrl: true });
  const seq2 = (await js(`window.__ma.picks()`)) as string[];
  const seqState = (await js(`window.__ma.selState()`)) as any;
  check(
    '全程按住 Ctrl 连点第 1、3 块：只有这两块算选中，中间那块不算',
    seq1.length === 1 &&
      seq2.length === 2 &&
      seq2.includes(fixture[0].id) &&
      seq2.includes(fixture[2].id) &&
      !seq2.includes(fixture[1].id) &&
      seqState?.items === 2,
    { seq1, seq2, items: seqState?.items }
  );
  /**
   * 视觉核对：**两个分开的框**，不是一个从第 1 块拉到第 3 块的大框。
   * 以前所有选中块取外接并集，12 明明没选中却被框在里面 —— 看着像 Shift 整段选。
   */
  const ctrlBoxes = (await js(`window.__ma.selBoxes()`)) as any[];
  check(
    'Ctrl+选两块不相邻的块 → 画两个框，中间那块留空（不是一个通吃的大框）',
    ctrlBoxes.length === 2 && ctrlBoxes[1].x0 > ctrlBoxes[0].x1,
    { boxes: ctrlBoxes }
  );
  // 截图人工核对：两块各自一个框，中间那块什么都不该有
  await shot('smoke-ctrl-multi.png');

  // C) Shift+点：从锚点到这一块整段选中
  await clickChordAt(fixture[0].tick);                       // 普通点击立锚点
  await clickChordAt(fixture[3].tick, { shift: true });       // Shift 点到第 4 块
  const afterShift = (await js(`window.__ma.picks()`)) as string[];
  const prog = (await js(`window.__ma.progression()`)) as any;
  check(
    'Shift+点 = 覆盖中间整段（4 块），并识别成「王道进行」',
    afterShift.length === 4 && prog?.id === 'oudo',
    { picks: afterShift.length, prog }
  );

  const maru = (await js(`window.__ma.progressionOf(['IVmaj7','III7','vi7','I7'], 'c major')`)) as any;
  const maruFull = (await js(`window.__ma.progressionOf(['IVmaj7','III7','vi7','v7','I7'], 'c major')`)) as any;
  const maruDiatonic = (await js(`window.__ma.progressionOf(['IVmaj7','iii7','vi7','I7'], 'c major')`)) as any;
  check(
    '丸之内进行：IVM7–III7–VIm7–I7 / 加 Vm7 的完整版；调内 iii7 不冒名',
    maru?.id === 'marunouchi' &&
      maruFull?.id === 'marunouchiFull' &&
      maruDiatonic === null,
    { maru, maruFull, maruDiatonic }
  );

  // D) 复制 → 选目标格 → 粘贴（目标为空，不弹确认）
  const copied = await js(`window.__ma.copySel()`);
  await js(`window.__ma.select(46, 0, 0)`);
  const targetSel = (await js(`window.__ma.selection()`)) as any;
  await js(`window.__ma.paste()`);
  await wait(420);
  const pasted = rows(
    `SELECT tick, text FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' AND tick >= ? AND tick < ? ORDER BY tick`,
    analysisId,
    targetSel.startTick,
    targetSel.startTick + (fixture[3].endTick - fixture[0].tick)
  ) as any[];
  check(
    'Ctrl+C / Ctrl+V：以选中的格子为起点，按相对位置粘回 4 条',
    copied === 4 && pasted.length === 4 && pasted.map((r: any) => r.text).join(',') === 'IV,V,iii,vi',
    { copied, pasted }
  );

  // E) 往已有内容上粘 → 先弹确认框，不写库；确认后才覆盖
  await js(`window.__ma.select(46, 0, 0)`);
  const targetTick2 = (await js(`window.__ma.selection()`)) as any;
  await js(`window.__ma.paste()`);
  await wait(200);
  const ask = (await js(`window.__ma.pasteAskState()`)) as any;
  // 注意统计的是**整段粘贴范围**，不是那一个格子：第一次粘贴的 4 条都在这段里
  const rowsDuring = rows(
    `SELECT COUNT(*) AS c FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' AND tick >= ? AND tick < ?`,
    analysisId,
    targetTick2.startTick,
    targetSel.startTick + (fixture[3].endTick - fixture[0].tick)
  )[0] as any;
  check(
    '覆盖前先弹确认框（没确认就不写库）',
    ask?.count === copied && rowsDuring.c === pasted.length,
    { ask, rowsDuring, copied, pasted: pasted.length }
  );
  await js(`window.__ma.confirmPaste()`);
  await wait(420);
  const rowsAfter = rows(
    `SELECT text FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' AND tick >= ? AND tick < ? ORDER BY tick`,
    analysisId,
    targetSel.startTick,
    targetSel.startTick + (fixture[3].endTick - fixture[0].tick)
  ) as any[];
  check('确认后照样覆盖（还是那 4 条）', rowsAfter.length === 4, rowsAfter);

  // 收尾：把这 10 小节的样本清掉，别污染后面的断言
  for (const bar of [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]) {
    await js(`window.__ma.select(${bar}, 0, 3)`);
    await js(`window.__ma.del()`);
    await wait(60);
  }
  await js(`window.__ma.clear()`);
  await wait(120);

  /* ---- 拖播放头：选中所在和弦 + 拖出右边界自动滚动 ---- */
  const gridFlags = (await js(`window.__ma.prefFlags()`)) as any;
  const firstChordTick = (
    rows(`SELECT tick FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' ORDER BY tick LIMIT 1`, analysisId)[0] as any
  ).tick;
  await centerOn(firstChordTick);
  const fvl = (await js(`window.__ma.viewLeft()`)) as number;
  const fcx = (await js(`window.__ma.xOfTick(${firstChordTick})`)) as number;
  // 按在波形带上（scrubbing），松手前不动
  await js(`(() => {
    const cv = document.querySelector('canvas');
    if (!cv) return;
    cv.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: ${fBox.left} + ${fcx} - ${fvl} + 2, clientY: ${fBox.top} + 6,
      button: 0, buttons: 1, pointerId: 61, bubbles: true, cancelable: true,
    }));
  })()`);
  await wait(200);
  const scrubSel = (await js(`window.__ma.selState()`)) as any;
  const scrollBefore = (await js(`window.__ma.scrollLeft()`)) as number;
  // 指针推到右边缘 → 自动滚动应该开始
  await js(`(() => {
    const cv = document.querySelector('canvas');
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new PointerEvent('pointermove', {
      clientX: r.right - 5, clientY: ${fBox.top} + 6,
      button: 0, buttons: 1, pointerId: 61, bubbles: true, cancelable: true,
    }));
  })()`);
  await wait(700);
  const scrollAfter = (await js(`window.__ma.scrollLeft()`)) as number;
  await js(`document.querySelector('canvas')?.dispatchEvent(new PointerEvent('pointerup', {
    clientX: 0, clientY: 0, button: 0, buttons: 0, pointerId: 61, bubbles: true }))`);
  await wait(140);
  check('拖动播放头 → 选中所在和弦（默认开，独立于播放时的三档）', scrubSel?.selection?.startTick === firstChordTick, {
    sel: scrubSel?.selection,
    firstChordTick,
  });
  check('拖到右边界外 → 视图自动滚动，内容进入视口', scrollAfter > scrollBefore + 20, { scrollBefore, scrollAfter });
  check(
    '四个新开关默认都开（拖动选中 / 空格清空 / 选中动画 / 粘贴提醒）',
    gridFlags.scrubPick === true &&
      gridFlags.scrubClearEmpty === true &&
      gridFlags.selAnim === true &&
      gridFlags.pasteWarn === true,
    gridFlags
  );

  /* ---- 拖播放头划过空格子：默认清空，设置里可改成「保持原选区」 ---- */
  await js(`window.__ma.focusTick(${firstChordTick})`);
  await wait(200);
  const selBeforeEmpty = (await js(`window.__ma.selection()`)) as any;
  await centerOn(fixture[0].tick); // 38~49 小节前面已清空 → bar 40 就是「没有和弦的格子」
  /** 在波形带上按一下（= 拖播放头的起点）+ 读选区 + 松手 */
  const scrubTap = async (tick: number, pid: number) => {
    const x = (await js(`window.__ma.xOfTick(${tick})`)) as number;
    const vl = (await js(`window.__ma.viewLeft()`)) as number;
    await js(`(() => {
      const cv = document.querySelector('canvas');
      if (!cv) return;
      cv.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: ${fBox.left} + ${x} - ${vl} + 2, clientY: ${fBox.top} + 6,
        button: 0, buttons: 1, pointerId: ${pid}, bubbles: true, cancelable: true }));
    })()`);
    await wait(170);
    const st = (await js(`window.__ma.selState()`)) as any;
    await js(`document.querySelector('canvas')?.dispatchEvent(new PointerEvent('pointerup', {
      clientX: 0, clientY: 0, button: 0, buttons: 0, pointerId: ${pid}, bubbles: true }))`);
    await wait(120);
    return st;
  };
  const emptyAfter = await scrubTap(fixture[0].tick, 91);
  check(
    '拖播放头划过空格子 → 默认清空选区',
    !!selBeforeEmpty && emptyAfter?.selection === null,
    { before: selBeforeEmpty?.startTick ?? null, after: emptyAfter?.selection }
  );

  const keptSel = (await js(`(async () => {
    localStorage.setItem('ma-scrub-empty', '0');
    window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'scrubEmpty' } }));
    window.__ma.focusTick(${firstChordTick});
    await new Promise((r) => setTimeout(r, 60));
    return window.__ma.selection();
  })()`)) as any;
  const emptyKept = await scrubTap(fixture[0].tick, 92);
  check(
    '设置里关掉「空格清空」→ 划过空格子保持原选区',
    !!keptSel && emptyKept?.selection?.startTick === keptSel.startTick,
    { keep: keptSel?.startTick ?? null, after: emptyKept?.selection }
  );
  // 复原成默认，别影响后面的用例
  await js(`(() => {
    localStorage.setItem('ma-scrub-empty', '1');
    window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'scrubEmpty' } }));
  })()`);
  await wait(120);

  /* ---- 选中动画：只在 140ms 内淡入，之后恒为 1 ---- */
  // 换**另一条**和弦来点：上一步「拖播放头选中」已经把 firstChordTick 选住了，
  // 再点同一块时选区没变化，watch 不会触发淡入（那是正确行为，不是 bug）
  const secondChordTick = (
    rows(
      `SELECT tick FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' AND tick > ? ORDER BY tick LIMIT 1`,
      analysisId,
      firstChordTick
    )[0] as any
  )?.tick ?? firstChordTick;
  await centerOn(secondChordTick);
  const fadeMid = (await js(`(async () => {
    const cv = document.querySelector('canvas');
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    const x = window.__ma.xOfTick(${secondChordTick}) - window.__ma.viewLeft() + 7;
    const y = window.__ma.yOfLane(0);
    cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${fBox.left} + x, clientY: ${fBox.top} + y,
      button: 0, buttons: 1, pointerId: 62, bubbles: true, cancelable: true }));
    cv.dispatchEvent(new PointerEvent('pointerup', { clientX: ${fBox.left} + x, clientY: ${fBox.top} + y,
      button: 0, buttons: 0, pointerId: 62, bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 30));
    return window.__ma.selFade();
  })()`)) as number;
  await wait(320);
  const fadeEnd = (await js(`window.__ma.selFade()`)) as number;
  check('选中动画：刚选中时还在淡入（<1），140ms 后回到 1', typeof fadeMid === 'number' && fadeMid < 0.99 && fadeEnd === 1, {
    fadeMid,
    fadeEnd,
  });

  /* ---- 详情面板：表头「小节位置」，时间列不再溢出（那个冒号是 text-overflow 的省略号） ---- */
  const thTime = await js(`document.querySelector('.detail .sections th.w-time')?.textContent?.trim() ?? ''`);
  const tcFit = (await js(`(() => {
    const td = document.querySelector('.detail .sections .sec-row td:nth-child(3)');
    if (!td) return null;
    return { sw: td.scrollWidth, cw: td.clientWidth, text: td.textContent.trim() };
  })()`)) as any;
  check(
    '表头改成「小节位置」，时间列不再溢出（末尾那个奇怪冒号随之消失）',
    /小节位置|Position/.test(String(thTime)) && !!tcFit && tcFit.sw <= tcFit.cw + 1,
    { thTime, tcFit }
  );

  /* ---- 头带左缘的上下文提示：翻页之后还知道自己在哪一段 / 哪个调上 ---- */

  // 前面的用例把视口滚远了，先回左边：stickyAt0 验的就是「没滚 = 不该有提示」
  await js(`window.__ma.scrollTo(0)`);
  await wait(160);
  const stickyAt0 = await js(`window.__ma.stickyBand('key')`);
  // 滚到 A1 之后的位置：段落 / 调性的起点都跑到视口左边
  const secForScroll = rows(
    `SELECT tick, label FROM analysis_marker WHERE analysis_id = ? AND kind = 'section' ORDER BY tick`,
    analysisId
  ) as any[];
  const midSec = secForScroll[Math.min(2, secForScroll.length - 1)];
  const midX = (await js(`window.__ma.xOfTick(${midSec.tick + 2000})`)) as number;
  await js(`window.__ma.scrollTo(${Math.max(0, midX - 20)})`);
  await wait(200);
  const stickySec = await js(`window.__ma.stickyBand('section')`);
  const stickyKey = await js(`window.__ma.stickyBand('key')`);
  check(
    '翻页后头带左缘给出段落 / 调性的上下文（起点已滚出左边才有值）',
    stickyAt0 === null && !!stickySec?.text && !!stickyKey?.text && stickySec.tick < midSec.tick + 2000,
    { stickyAt0, stickySec, stickyKey, midSec }
  );
  await js(`window.__ma.scrollTo(0)`);
  await wait(150);

  /* ---- sticky 避让：任何滚动位置下都不能压住右边第一条真标签 ----
   * 用户报的正是「A1 被（Intro）完全盖住」。这里把视口停在几个「真标签刚好露头」的位置，
   * 逐个断言 `vl + 画出来的宽度` 不越过 `nextLabelX`（挤不下时允许 skipped，即干脆不画）。
   */
  const stickyProbes: any[] = [];
  // back = 视口左缘离「下一条真标签」多远。avail ≈ back − 1：
  //   80 / 50 → 放得下但不完整（应截断）  ·  12 / 2 → 连 40px 都不到（应整条不画）
  for (const sec of [secForScroll[1], secForScroll[2]].filter(Boolean)) {
    for (const back of [80, 50, 12, 2]) {
      const x = (await js(`window.__ma.xOfTick(${sec.tick})`)) as number;
      await js(`window.__ma.scrollTo(${Math.max(0, x - back)})`);
      await wait(110);
      stickyProbes.push({
        sec: sec.label,
        back,
        section: await js(`window.__ma.stickyBand('section')`),
        key: await js(`window.__ma.stickyBand('key')`),
      });
    }
  }
  const stickyClean = stickyProbes.every((p) =>
    [p.section, p.key].every((chip: any) => {
      if (!chip || chip.skipped) return true;
      const next = Number(chip.nextLabelX);
      return !Number.isFinite(next) || chip.vl + chip.width + 2 <= next;
    })
  );
  const stickyTruncated = stickyProbes.some((p) =>
    // 截断的省略号在括号**里面**（`（in…）`），所以判 includes 而不是 endsWith
    [p.section, p.key].some((chip: any) => chip && !chip.skipped && String(chip.label).includes('…'))
  );
  const stickySkipped = stickyProbes.some((p) =>
    [p.section, p.key].some((chip: any) => chip && chip.skipped)
  );
  check(
    'sticky 标签按右边真标签的空隙截断，挤不下就不画（永不压住 A1）',
    stickyClean &&
      stickyProbes.length === 8 &&
      stickyTruncated &&
      stickySkipped,
    stickyProbes.map((p) => ({ sec: p.sec, back: p.back, s: p.section, k: p.key }))
  );
  await js(`window.__ma.scrollTo(0)`);
  await wait(120);

  /* ---- 调性条：双击就地编辑 / 拖动竖线 / 清空即删除 ----
   *
   * canvas 里没有可以点中的 DOM，「第 N 条竖线」只能靠 __ma.keyClientXY 换算成 client 坐标。
   * 断言一律查数据库；截图只看版式。
   * 结束时必须把 key marker 还原**并** syncTrackJson —— 只还原库不还原 JSON，
   * 下次启动 seed 会把改动从 JSON 带回库里（本项目最典型的静默失败）。
   */
  const keyBefore = rows(
    `SELECT tick, key_name AS keyName, confidence, note FROM analysis_marker
      WHERE analysis_id = ? AND kind = 'key' ORDER BY tick`,
    analysisId
  ) as any[];
  const keyDb = () =>
    rows(
      `SELECT tick, key_name AS keyName FROM analysis_marker
        WHERE analysis_id = ? AND kind = 'key' ORDER BY tick`,
      analysisId
    ) as any[];

  /** 在调性条上连点两下（第一次记点击、第二次判定双击） */
  const dblKeyAt = async (tick: number) => {
    await js(`(() => {
      const p = window.__ma.keyClientXY(${tick});
      const cv = document.querySelector('.canvas-host canvas');
      if (!p || !cv) return;
      const fire = (type) => cv.dispatchEvent(new PointerEvent(type, {
        clientX: p.x, clientY: p.y, button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        pointerId: 11, bubbles: true, cancelable: true,
      }));
      fire('pointerdown'); fire('pointerup');
      fire('pointerdown'); fire('pointerup');
    })()`);
    await wait(200);
  };

  /** 在已打开的调性输入框里敲字（走真实 input 事件，从而触发候选） */
  const typeKey = async (value: string) => {
    await js(`(() => {
      const i = document.querySelector('.key-input');
      if (!i) return;
      i.focus();
      i.value = ${JSON.stringify(value)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(140);
  };

  const enterKey = async () => {
    await js(`document.querySelector('.key-input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await wait(420);
  };

  // 1) 双击已有竖线：输入框带着原值进来，不是「新增」
  const firstKey = keyBefore[0];
  await dblKeyAt(firstKey.tick);
  const keyEditA = await js(`window.__ma.keyEditState()`);
  check(
    '调性条：双击已有竖线 → 就地编辑框带着原调性',
    keyEditA?.isNew === false && keyEditA?.text === firstKey.keyName,
    { keyEditA, firstKey }
  );

  // 2) 候选 + 两段式：敲的是前缀 → 第一次回车只采纳，第二次才落库
  const lastKey = keyBefore[keyBefore.length - 1];
  await dblKeyAt(lastKey.tick);
  await typeKey('g dor');
  const keySugB = await js(`window.__ma.keyEditState()`);
  await enterKey();
  const keyAdoptB = await js(`window.__ma.keyEditState()`);
  await enterKey();
  const keyDbB = keyDb();
  const keyLastB = keyDbB.find((k) => k.tick === lastKey.tick);
  check(
    '调性补全：敲「g dor」首条是 g dorian → 回车采纳（仍在编辑）→ 再回车落库',
    keySugB?.sug?.[0] === 'g dorian' &&
      keyAdoptB?.text === 'g dorian' &&
      keyLastB?.keyName === 'g dorian' &&
      keyDbB.length === keyBefore.length,
    { keySugB, keyAdoptB, keyLastB, n: keyDbB.length }
  );

  // 3) 详情面板同步：调性链读的是同一批 marker 行
  const detailKeys = await js(`document.querySelector('.detail .keys')?.textContent?.trim() ?? ''`);
  const apiKeys = (await js(`window.api.tracks.get(${JSON.stringify(trackId)}).then((d) => d.keys)`)) as string[];
  check(
    '调性改动同步到详情面板（.keys 文本与 tracks.get().keys 都变了）',
    /g dorian/.test(detailKeys) && Array.isArray(apiKeys) && apiKeys.includes('g dorian'),
    { detailKeys, apiKeys }
  );

  // 4) 双击空白处新增，敲的是完整写法 → **一次**回车就落库
  const freeTick = 28800; // 第 21 小节（3/4），库里没有调性
  await dblKeyAt(freeTick);
  await typeKey('c dorian');
  const keySugC = await js(`window.__ma.keyEditState()`);
  await enterKey();
  const keyDbC = keyDb();
  const added = keyDbC.find((k) => k.tick === freeTick);
  check(
    '调性条：双击空白 → 完全相等的候选 → 一次回车新增并落库（编辑框收起）',
    keySugC?.isNew === true &&
      keySugC?.sug?.[0] === 'c dorian' &&
      added?.keyName === 'c dorian' &&
      keyDbC.length === keyBefore.length + 1 &&
      !(await js(`!!document.querySelector('.key-input')`)),
    { keySugC, added, n: keyDbC.length }
  );

  // 5) 清空 = 删除
  await dblKeyAt(freeTick);
  await typeKey('');
  await enterKey();
  const keyDbD = keyDb();
  check(
    '调性条：清空输入 → 删除该调性点（条数回到原值）',
    keyDbD.length === keyBefore.length && !keyDbD.some((k) => k.tick === freeTick),
    { n: keyDbD.length, keyDbD }
  );

  // 6) 拖竖线：先滚到它旁边，再按/拖/松
  const dragFrom = lastKey.tick;
  const dragX = (await js(`window.__ma.xOfTick(${dragFrom})`)) as number;
  await js(`window.__ma.scrollTo(${Math.max(0, dragX - 200)})`);
  await wait(120);
  await js(`(() => {
    const p = window.__ma.keyClientXY(${dragFrom});
    const cv = document.querySelector('.canvas-host canvas');
    if (!p || !cv) return;
    const fire = (type, x, y) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 12, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', p.x, p.y);
    fire('pointermove', p.x + 12, p.y);
    fire('pointermove', p.x + 40, p.y);
    fire('pointerup', p.x + 40, p.y);
  })()`);
  await wait(520);
  const keyDbE = keyDb();
  const movedTo = keyDbE.find((k) => k.keyName === 'g dorian');
  check(
    '调性条：拖动竖线 → tick 向右移动、调名不变、条数不变',
    keyDbE.length === keyBefore.length &&
      !keyDbE.some((k) => k.tick === dragFrom) &&
      !!movedTo &&
      movedTo.tick > dragFrom,
    { dragFrom, movedTo, n: keyDbE.length }
  );

  // 还原调性链：走渲染层那条 IPC，而不是直接调 analysisIpc ——
  // handler 里带 syncByAnalysis（把 JSON 镜像写回盘）。只还原库不还原 JSON，
  // 下次启动 seed 会把改动从 JSON 带回库里。
  const restoreKeys = keyBefore.map((k: any) => ({
    id: `${analysisId}:key:${k.tick}`,
    kind: 'key',
    tick: k.tick,
    label: null,
    num: null,
    den: null,
    bpm: null,
    keyName: k.keyName,
    startBar: null,
    confidence: k.confidence,
    note: k.note,
  }));
  await js(
    `window.api.analysis.setMarkers(${JSON.stringify(analysisId)}, 'key', ${JSON.stringify(restoreKeys)})`
  );
  await js(`window.__app.refresh()`);
  await wait(320);
  const keyRestored = keyDb();
  check(
    '调性恢复：每条 (tick, 调名) 与快照完全一致',
    JSON.stringify(keyRestored) ===
      JSON.stringify(keyBefore.map((k: any) => ({ tick: k.tick, keyName: k.keyName }))),
    { keyRestored, keyBefore }
  );

  /* ---- 双击判定：改走系统的点击计数（ev.detail），不再自己数 400ms ---- */

  const closeBandEdit = async () => {
    await js(`document.querySelector('.key-input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(160);
  };

  /** 在头带上点一次；detail 传给 PointerEvent —— 真实鼠标第 2 下是 2 */
  const clickBandOnce = async (kind: string, tick: number, detail: number) => {
    await js(`(() => {
      const p = window.__ma.bandClientXY(${JSON.stringify(kind)}, ${tick});
      const cv = document.querySelector('.canvas-host canvas');
      if (!p || !cv) return;
      const fire = (type) => cv.dispatchEvent(new PointerEvent(type, {
        clientX: p.x, clientY: p.y, button: 0,
        buttons: type === 'pointerdown' ? 1 : 0,
        pointerId: 21, bubbles: true, cancelable: true, detail: ${detail},
      }));
      fire('pointerdown'); fire('pointerup');
    })()`);
  };

  const dblBandAt = async (kind: string, tick: number) => {
    await clickBandOnce(kind, tick, 0);
    await clickBandOnce(kind, tick, 0);
    await wait(220);
  };

  await clickBandOnce('key', firstKey.tick, 1);
  await wait(820); // 超过旧代码的 400ms 死线一大截
  await clickBandOnce('key', firstKey.tick, 2);
  await wait(240);
  const dblDetail = await js(`window.__ma.bandEditState()`);
  check(
    '双击按系统点击计数判定：间隔 820ms 仍打开（不再自己数 400ms 死线）',
    dblDetail?.kind === 'key' && dblDetail?.tick === firstKey.tick,
    dblDetail
  );
  await closeBandEdit();

  // 合成事件（detail 恒为 0）走兜底窗口：500ms 间隔仍算双击 —— 旧代码 400ms 会漏
  await clickBandOnce('key', firstKey.tick, 0);
  await wait(500);
  await clickBandOnce('key', firstKey.tick, 0);
  await wait(240);
  const dblFallback = await js(`window.__ma.bandEditState()`);
  check('合成事件兜底：500ms 间隔也算双击（兜底窗口 900ms，留出 IPC 往返余量）', dblFallback?.kind === 'key', dblFallback);
  await closeBandEdit();

  /* ---- 头带左侧的两行标签 ---- */

  const labelBox = (await js(`window.__ma.bandLabelBox()`)) as any[];
  const cvBox = (await js(`window.__ma.canvasBox()`)) as any;
  check(
    '头带左侧有「段落 / 调性」两行标签：等高、紧贴、不越过画布左缘',
    labelBox.length === 2 &&
      labelBox[0].text === '段落' &&
      labelBox[1].text === '调性' &&
      labelBox[0].height >= 17 &&
      labelBox[0].height <= 20 &&
      labelBox[0].height === labelBox[1].height &&
      // 两条带的 y 相差 SECTION_H(18)，标签必须跟着错开同样的距离
      labelBox[1].top - labelBox[0].top === 18 &&
      labelBox[1].right <= cvBox.left + 1,
    { labelBox, cvLeft: cvBox.left }
  );

  /* ---- 段落条：改名 / 拖分界 / 右键分段 / 两种删除 ----
   * 改的是「神鹿谣」的真实结构，收尾必须还原（库 + JSON，见最后的 setMarkers）。
   */
  const secBefore = rows(
    `SELECT tick, label, confidence, note FROM analysis_marker
      WHERE analysis_id = ? AND kind = 'section' ORDER BY tick`,
    analysisId
  ) as any[];
  const secDb = () =>
    rows(
      `SELECT tick, label FROM analysis_marker WHERE analysis_id = ? AND kind = 'section' ORDER BY tick`,
      analysisId
    ) as any[];

  const b1 = secBefore.find((s: any) => s.label === 'B1');

  // 1) 双击**这一段自己的那一格**（不是分界线，但也还在它自己的格内）→ 改的是「这一段」
  await dblBandAt('section', b1.tick);
  const secEditA = await js(`window.__ma.bandEditState()`);
  check(
    '段落条：双击本段自己的格子 → 打开的是该段段名（不是新建一段）',
    secEditA?.kind === 'section' && secEditA?.tick === b1.tick && secEditA?.isNew === false && secEditA?.text === 'B1',
    { secEditA, b1 }
  );
  await js(`(() => {
    const i = document.querySelector('.key-input');
    i.value = 'B1x';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(130);
  await js(`document.querySelector('.key-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(460);
  const secAfterRename = secDb();
  check(
    '段落改名：一次回车落库（段落没有候选，不存在两段式），段数不变',
    secAfterRename.length === secBefore.length &&
      secAfterRename.find((s: any) => s.tick === b1.tick)?.label === 'B1x',
    { n: secAfterRename.length, row: secAfterRename.find((s: any) => s.tick === b1.tick) }
  );
  const detailSecText = await js(
    `[...document.querySelectorAll('.detail .sections tbody tr td')].map((td) => td.textContent.trim()).join('|')`
  );
  check('段落改名同步到详情面板「时间轴 · 段落」', /B1x/.test(detailSecText), String(detailSecText).slice(0, 140));

  /* ---- 时间轴 · 段落：时间列改成 小节.拍.十六分.tick + 整行双击跳转 ---- */
  const ppqRow = rows(`SELECT ppq FROM analysis WHERE id = ?`, analysisId)[0] as any;
  const ppqVal = ppqRow?.ppq ?? 480;
  const meterRows = rows(
    `SELECT tick, num, den FROM analysis_marker WHERE analysis_id = ? AND kind = 'meter' ORDER BY tick`,
    analysisId
  ) as any[];
  const meters = computeStartBars(meterRows.length ? meterRows : [{ tick: 0, num: 4, den: 4 }], ppqVal);
  const secCells = (await js(`(() => {
    return [...document.querySelectorAll('.detail .sections .sec-row')].map((tr) => {
      const tds = tr.querySelectorAll('td');
      const dots = [...tds[2].querySelectorAll('em')].map((e) => Math.round(e.getBoundingClientRect().left * 10) / 10);
      return {
        label: tds[1].textContent.trim(),
        time: (tds[2].querySelector('.bb-tc')?.textContent ?? '').trim(),
        dots,
        ms: tds[2].getAttribute('title'),
      };
    });
  })()`)) as any[];
  const secRowsNow = secDb();
  const expectTimes = secRowsNow.map((r: any) => formatBarBeatSub(meters, r.tick, ppqVal));
  check(
    '时间轴段落的时间列 = 小节.拍.十六分.tick（与库里 tick 一一对上，毫秒退到悬停提示）',
    secCells.length === expectTimes.length &&
      secCells.every((row: any, i: number) => row.time === expectTimes[i] && /^\d+\.\d+\.\d+\.\d+$/.test(row.time)) &&
      secCells.every((row: any) => /\d+:\d+/.test(String(row.ms ?? ''))),
    { got: secCells.map((r: any) => r.time), want: expectTimes, ms: secCells[0]?.ms }
  );
  // 点号位置必须固定：不同位数的小节号（2 / 12 / 106）不能让点左右跳
  check(
    '时间列的点号位置固定（不补零也不跳）',
    secCells.length > 2 &&
      secCells.every(
        (row: any) =>
          row.dots.length === 3 && row.dots.every((d: number, j: number) => Math.abs(d - secCells[0].dots[j]) <= 0.6)
      ),
    secCells.map((r: any) => ({ t: r.time, dots: r.dots }))
  );

  // 双击整行 → 播放头跳到该段起点 + 横向翻页（留 96px）+ 选中起点那一格
  const jumpIdx = Math.max(0, secRowsNow.findIndex((r: any) => r.label === 'A1'));
  const jumpTarget = secRowsNow[jumpIdx];
  await js(`(() => {
    const tr = [...document.querySelectorAll('.detail .sections .sec-row')][${jumpIdx}];
    tr?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  })()`);
  await wait(380);
  const jump = (await js(`({
    sel: window.__ma.selection(),
    px: window.__ma.playheadPx(),
    sl: window.__ma.scrollLeft(),
    want: window.__ma.xOfTick(${jumpTarget.tick}),
    track: window.__ma.trackId(),
  })`)) as any;
  // 段落起点常常落在某个和弦中间：跳过去应当选中**整个和弦**，而不是只框住第一格
  const chordAtSec = rows(
    `SELECT tick, dur_ticks FROM analysis_event
      WHERE analysis_id = ? AND lane = 'degree' AND tick <= ? AND tick + dur_ticks > ?
      ORDER BY tick LIMIT 1`,
    analysisId,
    jumpTarget.tick,
    jumpTarget.tick
  )[0] as any;
  const wantStart = chordAtSec ? chordAtSec.tick : jumpTarget.tick;
  const wantEnd = chordAtSec ? chordAtSec.tick + chordAtSec.dur_ticks : jumpTarget.tick;
  check(
    '双击时间轴段落 → 播放头跳到该段起点、翻页留 96px、并选中**整个和弦**',
    Math.abs(jump.px - jump.want) <= 2 &&
      Math.abs(jump.sl - Math.max(0, jump.want - 96)) <= 2 &&
      jump.sel?.startTick === wantStart &&
      jump.sel?.endTick === wantEnd,
    { ...jump, target: jumpTarget.tick, wantStart, wantEnd, chordAtSec }
  );
  // 收尾：滚回左边并把选区清掉，后面的调性条用例依赖「tick 0 在视口里」
  await js(`window.__ma.scrollTo(0)`);
  await js(`window.__ma.clear()`);
  await wait(140);

  /* 1b) 双击落在**更靠后的格子**里 → 与调性带一致：在那一格新起一段。
   * 以前段落带不管点哪都只是改名，同一个双击手势在两条带上含义不同。 */
  const secCountBeforeNew = secDb().length;
  await dblBandAt('section', b1.tick + 4000);
  const secEditNew = await js(`window.__ma.bandEditState()`);
  check(
    '段落条：双击更靠后的格子 → 在那里新建一段（与调性带同一套手势）',
    secEditNew?.kind === 'section' && secEditNew?.isNew === true && secEditNew?.tick !== b1.tick,
    { secEditNew, b1, n: secCountBeforeNew }
  );
  await closeBandEdit();   // Esc 取消，不落库

  // 2) 拖分界线 → 改该段起点
  const secDragX = (await js(`window.__ma.xOfTick(${b1.tick})`)) as number;
  await js(`window.__ma.scrollTo(${Math.max(0, secDragX - 200)})`);
  await wait(160);
  await js(`(() => {
    const p = window.__ma.sectionClientXY(${b1.tick});
    const cv = document.querySelector('.canvas-host canvas');
    if (!p || !cv) return;
    const fire = (type, x) => cv.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: p.y, button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 23, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', p.x);
    fire('pointermove', p.x + 20);
    fire('pointermove', p.x + 120);
    fire('pointerup', p.x + 120);
  })()`);
  await wait(600);
  const secAfterDrag = secDb();
  const movedSec = secAfterDrag.find((s: any) => s.label === 'B1x');
  check(
    '段落拖分界线：起点右移、段名不变、段数不变',
    secAfterDrag.length === secBefore.length &&
      !!movedSec &&
      movedSec.tick > b1.tick &&
      !secAfterDrag.some((s: any) => s.tick === b1.tick),
    { before: b1.tick, movedTo: movedSec?.tick, n: secAfterDrag.length }
  );

  // 3) 右键「在此处分段」
  const openSecMenu = async (tick: number) => {
    await js(`(() => {
      const p = window.__ma.sectionClientXY(${tick});
      const cv = document.querySelector('.canvas-host canvas');
      if (!p || !cv) return;
      cv.dispatchEvent(new MouseEvent('contextmenu', {
        clientX: p.x, clientY: p.y, button: 2, bubbles: true, cancelable: true }));
    })()`);
    await wait(170);
    return js(`window.__ma.bandMenuState()`);
  };

  const menuSplit = await openSecMenu(62000);
  await js(`window.__ma.bandMenuRun('split')`);
  await wait(560);
  const secAfterSplit = secDb();
  const freshSec = secAfterSplit.find((s: any) => s.label === '新段落');
  check(
    '右键「在此处分段」：段数 +1，新段叫「新段落」并落在吸好的小节上',
    (menuSplit as any)?.canSplit === true &&
      secAfterSplit.length === secBefore.length + 1 &&
      !!freshSec &&
      freshSec.tick === (menuSplit as any).tick,
    { menuSplit, n: secAfterSplit.length, fresh: freshSec }
  );

  // 4) 同一小节不能重复分段
  const secA1 = secBefore.find((s: any) => s.label === 'A1');
  const menuDup = await openSecMenu(secA1.tick);
  await js(`window.__ma.bandMenuRun('split')`);
  await wait(460);
  // 底部说明栏整条删了：出错提示改在工具栏上（`.act-err`），状态从 __ma 读
  const dupHint = await js(`(() => ({
    err: document.querySelector('.grid-wrap .toolbar .act-err')?.textContent?.trim() ?? '',
    last: window.__ma.lastAction?.() ?? null,
  }))()`);
  const secDup = secDb();
  check(
    '同一小节不能重复分段：菜单项禁用 + 工具栏给出「已经有段落了」',
    (menuDup as any)?.canSplit === false &&
      secDup.length === secAfterSplit.length &&
      /已经有段落/.test(String((dupHint as any)?.err ?? '')) &&
      /已经有段落/.test(String((dupHint as any)?.last?.text ?? '')),
    { canSplit: (menuDup as any)?.canSplit, n: secDup.length, dupHint }
  );

  // 5) 清空段名 = 删除（双击点在本段自己那一格里，才会打开「改这一段」而不是「新建」）
  await dblBandAt('section', freshSec.tick);
  const secEditB = await js(`window.__ma.bandEditState()`);
  await js(`(() => {
    const i = document.querySelector('.key-input');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(130);
  await js(`document.querySelector('.key-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(500);
  const secAfterClear = secDb();
  check(
    '清空段名 = 删除该段',
    secEditB?.tick === freshSec.tick &&
      secAfterClear.length === secAfterSplit.length - 1 &&
      !secAfterClear.some((s: any) => s.tick === freshSec.tick),
    { edit: secEditB?.tick, n: secAfterClear.length }
  );

  // 6) 右键「删除本段」
  const t2 = secBefore.find((s: any) => s.label === 'Transition 2');
  const menuDel = await openSecMenu(t2.tick + 3000);
  await js(`window.__ma.bandMenuRun('delete')`);
  await wait(520);
  const secAfterDel = secDb();
  check(
    '右键「删除本段」：段数 -1，目标段不在',
    (menuDel as any)?.has === true &&
      secAfterDel.length === secAfterClear.length - 1 &&
      !secAfterDel.some((s: any) => s.tick === t2.tick),
    { has: (menuDel as any)?.has, n: secAfterDel.length, t2: t2.tick }
  );

  // 7) 还原段落（同样走 IPC，让 JSON 镜像一起写回）
  await js(
    `window.api.analysis.setMarkers(${JSON.stringify(analysisId)}, 'section', ${JSON.stringify(
      secBefore.map((s: any) => ({
        id: `${analysisId}:section:${s.tick}`,
        kind: 'section',
        tick: s.tick,
        label: s.label,
        num: null,
        den: null,
        bpm: null,
        keyName: null,
        startBar: null,
        confidence: s.confidence,
        note: s.note,
      }))
    )})`
  );
  await js(`window.__app.refresh()`);
  await wait(360);
  const secRestored = secDb();
  check(
    '段落恢复：每条 (tick, label) 与快照完全一致',
    JSON.stringify(secRestored) === JSON.stringify(secBefore.map((s: any) => ({ tick: s.tick, label: s.label }))),
    { secRestored }
  );

  /* ---- 低音行：从级数标记填充（标签右键菜单 + 自动跟随） ----
   * 这一段只在**空小节**里写测试数据，结束时按 id 删干净，不影响后面的用例。 */
  const bassRowsNow = () =>
    rows(
      `SELECT id, tick, dur_ticks, text FROM analysis_event
        WHERE analysis_id = ? AND lane = 'bass' ORDER BY tick`,
      analysisId
    ) as any[];
  const chordRowsNow = () =>
    rows(
      `SELECT id, tick, dur_ticks, text, parsed FROM analysis_event
        WHERE analysis_id = ? AND lane = 'degree' ORDER BY tick`,
      analysisId
    ) as any[];
  /**
   * 测试开始前库里**已有**的低音（真实数据里用户可能已经填过）。
   * 收尾只能回到这份快照，不能要求「全库没有低音」—— 那是拿用户的数据当实验台。
   */
  const bassBaseline = rows(
    `SELECT analysis_id, COUNT(*) AS c FROM analysis_event WHERE lane = 'bass' GROUP BY analysis_id ORDER BY analysis_id`
  ) as any[];

  const gridAfterBass = (await js(`window.__ma.grid()`)) as any;
  const gridTrackNow = await js(`window.__ma.trackId()`);
  check(
    '低音用例跑在「当前网格显示的曲目」上（否则填充会写到另一首、断言却查这一首）',
    gridTrackNow === trackId,
    { gridTrackNow, trackId }
  );
  check(
    '罗马数字视图只剩 3 条泳道：级数 / 低音 / 备注（「转位」行已删，低音顶到第二行）',
    gridAfterBass?.view === 'roman' &&
      JSON.stringify(gridAfterBass?.lanes) === JSON.stringify(['degree', 'bass', 'note']),
    { view: gridAfterBass?.view, lanes: gridAfterBass?.lanes }
  );

  /**
   * 在第 idx 条泳道的**左缘标签**上右键。
   *
   * 关键是「派发到真实落点那个元素上」：标签列（0..64）**不在 canvas 里** ——
   * 真实鼠标的 contextmenu 打在 `.canvas-host` 上。以前这里直接往 canvas 上扔一个
   * clientX=label 的合成事件，看着像测了标签，其实测的是「canvas 左边 20px 的网格正文」，
   * 所以「标签上右键没反应」这个 bug 一路漏到用户手上。
   */
  const rightClickLane = async (idx: number) => {
    const hit = (await js(`(() => {
      const p = window.__ma.laneLabelXY(${idx});
      if (!p) return null;
      const el = document.elementFromPoint(p.x, p.y);
      if (!el) return null;
      el.dispatchEvent(new MouseEvent('contextmenu', {
        clientX: p.x, clientY: p.y, button: 2, bubbles: true, cancelable: true }));
      return { cls: el.className, tag: el.tagName };
    })()`)) as any;
    await wait(200);
    const menu = await js(`window.__ma.bassMenuState()`);
    return { menu, hit };
  };
  const closeBassMenu = async () => {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(140);
  };

  const rcBass = await rightClickLane(1);   // 第 2 行 = 低音
  check(
    '「低音」两个字上右键 → 弹出低音填充菜单（事件真的落在标签列上，不是网格正文）',
    !!rcBass.menu &&
      typeof (rcBass.menu as any).x === 'number' &&
      typeof (rcBass.menu as any).y === 'number' &&
      // 真实落点是 .scroll（canvas 从 x=64 才开始），关键证据是**不是 canvas**
      rcBass.hit?.tag !== 'CANVAS',
    rcBass
  );
  await closeBassMenu();
  const menuClosed = await js(`window.__ma.bassMenuState()`);
  check('Esc 关掉低音菜单', menuClosed === null, menuClosed);

  const rcChord = await rightClickLane(0);   // 第 1 行 = 级数
  check('「级数」行标签右键不弹低音菜单（只有低音行有）', rcChord.menu === null, rcChord);
  await closeBassMenu();

  // 网格正文里右键低音行也要弹（两条路都要通）
  await js(`(() => {
    const p = window.__ma.laneClientXY(1);
    const el = document.elementFromPoint(p.x, p.y);
    el?.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: p.x, clientY: p.y, button: 2, bubbles: true, cancelable: true }));
  })()`);
  await wait(200);
  const menuOnGrid = (await js(`window.__ma.bassMenuState()`)) as any;
  check('低音行网格正文里右键 → 同样弹出低音填充菜单', !!menuOnGrid && typeof menuOnGrid.x === 'number', menuOnGrid);
  await closeBassMenu();

  // 整曲填充：能解析的级数都写出一条同 tick / 同时值的低音，解析不出的跳过
  const chordsBeforeFill = chordRowsNow();
  const wantBassFill = chordsBeforeFill
    .map((c: any) => {
      let p: any = null;
      try {
        p = c.parsed ? JSON.parse(c.parsed) : null;
      } catch {
        p = null;
      }
      return p?.ok && p?.bassName ? { tick: c.tick, dur: c.dur_ticks, text: String(p.bassName) } : null;
    })
    .filter(Boolean) as any[];
  await js(`window.__ma.bassMenuRun('fill')`);
  await wait(900);
  const bassFilled = bassRowsNow();
  check(
    '「从级数标记获取低音填充」：每条能解析的级数都得到同 tick / 同时值的低音，解析不出的跳过',
    wantBassFill.length > 0 &&
      bassFilled.length === wantBassFill.length &&
      wantBassFill.every((w: any) =>
        bassFilled.some((b: any) => b.tick === w.tick && b.dur_ticks === w.dur && b.text === w.text)
      ),
    {
      nWant: wantBassFill.length,
      nGot: bassFilled.length,
      want: wantBassFill.slice(0, 4),
      got: bassFilled.slice(0, 4),
    }
  );

  // 整批低音共用一份撤销快照：一次 Ctrl+Z 全回去
  await js(`window.__ma.undo()`);
  await wait(460);
  check('一次撤销把整批低音全部回退（不是按条数撤 N 次）', bassRowsNow().length === 0, {
    n: bassRowsNow().length,
  });

  // 自动模式：找两个连续的空小节，往里面写级数
  const usedBarSet = new Set<number>();
  for (const c of chordRowsNow()) usedBarSet.add(Math.floor(c.tick / barTicks));
  let freeBar = 1;
  while ((usedBarSet.has(freeBar - 1) || usedBarSet.has(freeBar)) && freeBar < 200) freeBar++;
  const tickFree1 = (freeBar - 1) * barTicks;
  const tickFree2 = freeBar * barTicks;
  const escCell = async () => {
    await js(`document.querySelector('.cell-input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(120);
  };

  await js(`window.__ma.select(${freeBar}, 0, 0)`);
  // 自动填充**默认关**（自动改数据不该默认点头），这里先显式打开再验行为
  const autoDefault = await js(`window.__ma.bassAuto()`);
  if (autoDefault !== true) await js(`window.__ma.bassMenuRun('auto')`);
  await wait(200);
  const autoOn = await js(`window.__ma.bassAuto()`);
  check('自动填充默认关，菜单勾选项能打开', autoDefault === false && autoOn === true, {
    before: autoDefault,
    after: autoOn,
  });

  await js(`window.__ma.select(${freeBar}, 0, 0)`);
  await js(`window.__ma.type('V7')`);
  await wait(520);
  await escCell();
  const autoBass1 = bassRowsNow().find((b: any) => b.tick === tickFree1);
  check(
    '自动模式：级数写完（回车提交、切到下一格）立刻把低音写进低音行（V7 → G，1 拍）',
    autoBass1?.text === 'G' && autoBass1?.dur_ticks === barTicks / 3,
    { bar: freeBar, tick: tickFree1, got: autoBass1 }
  );

  // 和弦改了 → 低音跟着改（Q3 B：不能留下过期值）
  await js(`window.__ma.select(${freeBar}, 0, 0)`);
  await js(`window.__ma.type('ii6')`);
  await wait(520);
  await escCell();
  const autoBass2 = bassRowsNow().find((b: any) => b.tick === tickFree1);
  check(
    '自动模式跟着和弦走：V7 → ii6 后低音从 G 变成 F（第一转位的低音，不是旧值）',
    autoBass2?.text === 'F' && autoBass2?.dur_ticks === autoBass1?.dur_ticks,
    { before: autoBass1, after: autoBass2 }
  );

  // 关掉开关 → 改级数不再动低音
  await js(`window.__ma.bassMenuRun('auto')`);
  await wait(200);
  const autoOff = await js(`window.__ma.bassAuto()`);
  await js(`window.__ma.select(${freeBar}, 0, 0)`);
  await js(`window.__ma.type('V')`);
  await wait(520);
  await escCell();
  const bassStay = bassRowsNow().find((b: any) => b.tick === tickFree1);
  check(
    '关掉「每次都自动」后：改级数不再动低音',
    autoOff === false && bassStay?.text === 'F',
    { autoOff, got: bassStay }
  );

  // 再开：和弦与自动低音共用一次撤销
  await js(`window.__ma.bassMenuRun('auto')`);
  await wait(200);
  await js(`window.__ma.select(${freeBar + 1}, 0, 0)`);
  await js(`window.__ma.type('iii')`);
  await wait(520);
  await escCell();
  const pairBefore = {
    chord: chordRowsNow().filter((c: any) => c.tick === tickFree2).length,
    bass: bassRowsNow().filter((b: any) => b.tick === tickFree2).length,
    bassText: bassRowsNow().find((b: any) => b.tick === tickFree2)?.text ?? null,
  };
  await js(`window.__ma.undo()`);
  await wait(460);
  const pairAfter = {
    chord: chordRowsNow().filter((c: any) => c.tick === tickFree2).length,
    bass: bassRowsNow().filter((b: any) => b.tick === tickFree2).length,
  };
  check(
    '自动填的低音与和弦共用一次撤销：一次 Ctrl+Z 两条一起回去',
    pairBefore.chord === 1 && pairBefore.bass === 1 && pairAfter.chord === 0 && pairAfter.bass === 0,
    { before: pairBefore, after: pairAfter }
  );
  // iii 在 c 多利亚 = E♭ 大三（低音 E♭）—— 顺带确认拼写走的是调内音级，不是升号表
  check('自动低音用调内拼写（c 多利亚 iii → E♭，不是 D♯）', pairBefore.bassText === 'E♭', {
    got: pairBefore.bassText,
  });

  // 收尾：清掉临时写入的级数/低音，开关复位（默认关）
  const junkIds = rows(
    `SELECT id FROM analysis_event WHERE analysis_id = ? AND tick IN (?, ?)`,
    analysisId,
    tickFree1,
    tickFree2
  ).map((r: any) => r.id);
  if (junkIds.length) {
    await js(`window.api.analysis.deleteEvents(${JSON.stringify(junkIds)})`);
  }
  await js(`localStorage.setItem('ma-bass-autofill', '0');
    window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'bassAutofill' } }))`);
  await js(`window.__app.refresh()`);
  await wait(420);
  const leftover = rows(
    `SELECT COUNT(*) AS c FROM analysis_event WHERE analysis_id = ? AND tick IN (?, ?)`,
    analysisId,
    tickFree1,
    tickFree2
  )[0] as any;
  // 全库低音数必须回到**测试前**的样子：只查本曲会漏掉「填充写到别的曲目上」这种更糟的情况
  const allBassNow = rows(
    `SELECT analysis_id, COUNT(*) AS c FROM analysis_event WHERE lane = 'bass' GROUP BY analysis_id ORDER BY analysis_id`
  ) as any[];
  const fillCalls = await js(`window.__bassFillCalls ?? 0`);
  check(
    '低音用例收尾：临时写入的级数/低音清干净、整曲填充只跑过一次',
    leftover.c === 0 &&
      bassRowsNow().length === 0 &&
      JSON.stringify(allBassNow) === JSON.stringify(bassBaseline) &&
      fillCalls === 1,
    { leftover: leftover?.c, allBass: allBassNow, baseline: bassBaseline, fillCalls }
  );

  /* ---- 操作历史：撤销 / 重做 / 写盘（v0.37） ---- */
  const histBefore = (await js(`window.api.history.list()`)) as any;
  await js(`window.__ma.select(20, 0, 0)`);
  await js(`window.__ma.fill('V')`);
  await wait(460);
  const histAfter = (await js(`window.api.history.list()`)) as any;
  check(
    '每次写库都记一条历史（带曲名与动作文案）',
    // 不比较「总条数 +1」：撤销之后再编辑会丢弃重做分支（经典 undo 语义），
    // 条数可能不变甚至变少。真正的信号是「多了一条更新的 step」。
    (histAfter?.items?.[0]?.seq ?? 0) > (histBefore?.items?.[0]?.seq ?? 0) &&
      histAfter?.items?.[0]?.kind === 'step' &&
      histAfter?.items?.[0]?.title === '神鹿谣' &&
      !!histAfter?.items?.[0]?.label?.key,
    {
      before: histBefore?.items?.length,
      after: histAfter?.items?.length,
      beforeTop: histBefore?.items?.[0]?.seq,
      afterTop: histAfter?.items?.[0]?.seq,
      beforeBottom: histBefore?.items?.[histBefore?.items?.length - 1]?.seq,
      top: histAfter?.items?.[0],
    }
  );

  const seqTop = histAfter.items[0].seq;
  const seqPrev = histAfter.items[1]?.seq;
  await js(`window.__ma.undo()`);
  await wait(420);
  const afterUndo = (await js(`window.api.history.list()`)) as any;
  check(
    'Ctrl+Z 只退当前曲目的游标（历史条目不删，还能前进）',
    afterUndo?.cursors?.[analysisId] === seqPrev && afterUndo.items.length === histAfter.items.length,
    { cursor: afterUndo?.cursors?.[analysisId], want: seqPrev, n: afterUndo?.items?.length }
  );

  await js(`window.__ma.redo()`);
  await wait(420);
  const afterRedo = (await js(`window.api.history.list()`)) as any;
  // 直接问主进程要真值：组件里的 histCan 靠广播刷新，断言读它容易抢跑
  const canNow = await js(`window.api.history.can(${JSON.stringify(analysisId)})`);
  check(
    'Ctrl+Y 重做回到刚才那一步（按钮可用状态跟着走）',
    afterRedo?.cursors?.[analysisId] === seqTop && (canNow as any)?.undo === true,
    { cursor: afterRedo?.cursors?.[analysisId], want: seqTop, can: canNow }
  );

  // 写盘：flush 之后另开一个 store 读同一个文件，条数必须对得上（跨会话撤销的基础）
  const persisted = (() => {
    historyStore?.flush();
    const again = new HistoryStore({ dir: app.getPath('userData'), apply: () => {} });
    return { mem: historyStore?.list().length ?? 0, disk: again.list().length };
  })();
  check(
    '关软件前 flush：磁盘里能读回这份历史（下次启动还能接着撤）',
    persisted.mem > 0 && persisted.disk === Math.min(persisted.mem, 50),
    persisted
  );

  const histToggled = await js(`window.api.history.toggle()`);
  await wait(700);
  const histWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#history')) ?? null;
  const histRows = histWin
    ? await histWin.webContents.executeJavaScript(`document.querySelectorAll('.hw-item').length`)
    : 0;
  if (histWin) histWin.close();
  await wait(320);
  check('历史记录窗口能打开并列出步骤（视图菜单 / Ctrl+Shift+H 同一个开关）', histToggled === true && !!histWin && histRows > 0, {
    histToggled,
    win: !!histWin,
    rows: histRows,
  });

  // 收尾：把刚才那条 'V' 撤掉，别给后面的用例留数据
  await js(`window.__ma.undo()`);
  await wait(320);

  /* ---- 工作区：启动时就要把磁盘上已有的预设列进菜单 ---- */
  // 这里不能用 menuItemsOf/closeMenus：它俩定义在后面（const 有 TDZ），提前调会直接崩
  const wsStartupList = (await js(`window.api.ws.list()`)) as any;
  await js(`(() => {
    const b = [...document.querySelectorAll('.menubar .menu .top')]
      .find((x) => (x.textContent || '').startsWith('工作区'));
    b?.click();
  })()`);
  await wait(200);
  const wsMenuNames = (await js(
    `[...document.querySelectorAll('.menubar .drop .item .text')].map((x) => x.textContent.trim())`
  )) as any[];
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await wait(160);
  check(
    '启动时工作区菜单就列出磁盘上已保存的预设（持久化 + 启动加载，缺一个都看不到）',
    (wsStartupList?.names ?? []).includes('启动预设') && (wsMenuNames ?? []).includes('启动预设'),
    { list: wsStartupList, menu: wsMenuNames }
  );

  /* ---- 工作区：保存 / 应用 / 删除（v0.37） ---- */
  const wsUi = {
    panelOpen: true,
    panelH: 300,
    leftW: 210,
    rightW: 340,
    uiZoom: 1,
    themeMode: 'dark',
    viewId: 'roman',
    gridZoom: 1.25,
    gridUnit: 'bar',
  };
  const wsSaved = await js(`window.api.ws.save({ name: '冒烟布局', ui: ${JSON.stringify(wsUi)} })`);
  const wsListed = (await js(`window.api.ws.list()`)) as any;
  check(
    '保存工作区：名字进列表，同时更新「上次布局」',
    (wsSaved as any)?.ok === true && wsListed?.names?.includes('冒烟布局') && !!wsListed?.lastAt,
    { saved: wsSaved, listed: wsListed }
  );

  const wsApplied = (await js(`window.api.ws.apply('冒烟布局')`)) as any;
  await wait(700);
  check(
    '应用工作区：返回的「窗口内部」字段与保存时一致（面板高/栏宽/缩放/泳道/格单位）',
    wsApplied?.ok === true &&
      wsApplied.ui?.panelH === 300 &&
      wsApplied.ui?.leftW === 210 &&
      wsApplied.ui?.gridZoom === 1.25 &&
      wsApplied.ui?.gridUnit === 'bar',
    wsApplied
  );

  const wsBounds = (() => {
    const l = wsStore?.get('冒烟布局');
    const b = win!.getBounds();
    return { saved: l?.win?.bounds ?? null, now: b };
  })();
  check(
    '工作区记下了主窗口位置与大小（应用后窗口还是那个矩形）',
    !!wsBounds.saved && Math.abs(wsBounds.saved.width - wsBounds.now.width) <= 2 && Math.abs(wsBounds.saved.height - wsBounds.now.height) <= 2,
    wsBounds
  );

  // preload 里这个方法叫 remove（delete 是保留字，别在 interface 上抖机灵）
  await js(`window.api.ws.remove('冒烟布局')`);
  const wsAfterDel = (await js(`window.api.ws.list()`)) as any;
  check('删除工作区：名字从列表消失', !wsAfterDel?.names?.includes('冒烟布局'), wsAfterDel);

  /* ---- 动态操作帮助窗口：接替被删的底部说明栏，视图 / 帮助两个入口 ---- */
  /* ---- 动态操作帮助窗：默认自启（排在主窗口显示之后）+ 高度按内容自适应 ---- */
  // 自动打开排在 280ms，冷启动还会更晚 —— 轮询等它真的出现，别用固定 sleep 赌
  // （这里不能借 byHash：它定义在后面的独立窗口段，提前用会踩 TDZ）
  const findHelp = () =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('#help')) ?? null;
  let helpAutoWin = findHelp();
  for (let i = 0; i < 24 && !helpAutoWin; i++) {
    await wait(150);
    helpAutoWin = findHelp();
  }
  /**
   * 量的是「内容容器」`.ah-inner`，不是 `.ah-body`。
   * `.ah-body` 是 flex:1 撑满窗口的盒子：内容比它矮时 `scrollHeight === clientHeight`，
   * 于是「装下了」和「多出一大截空白」测出来一样 —— 上一版就是这么漏掉
   * 「点一下网格帮助窗就长高一截」的。
   */
  const readHelpFit = async (w: BrowserWindow) =>
    (await w.webContents.executeJavaScript(`(() => {
      const inner = document.querySelector('.ah-inner');
      const body = document.querySelector('.ah-body');
      if (!inner || !body) return null;
      return {
        innerH: Math.ceil(inner.getBoundingClientRect().height),
        bodyH: body.clientHeight,          // 含 padding（border-box）
        bodyScroll: body.scrollHeight,
        winH: window.innerHeight,
        winW: window.innerWidth,
      };
    })()`)) as any;
  // 尺寸以**渲染层看到的**为准：`getContentSize()` 在窗口还没 show 时会返回 [0,0]，
  // 拿它断言等于赌「此刻已经 show 了」（实测会飘）
  const helpAutoSize = helpAutoWin ? helpAutoWin.getContentSize() : null;
  const helpFit = helpAutoWin ? await readHelpFit(helpAutoWin) : null;
  check(
    '启动时自动打开动态操作帮助窗（主窗口显示之后才开）+ 宽度 520、高度=内容高+头带（不留空白）',
    !!helpAutoWin &&
      (helpFit as any)?.winW === 520 &&
      // 完整手势清单默认收起，窗口只装「现在 + 相关提示」，比展开时矮得多
      ((helpFit as any)?.winH ?? 0) > 200 &&
      !!helpFit &&
      // .ah-body 只能比内容高出一个 padding（8+12），多出来就是「空白」
      Math.abs((helpFit as any).bodyH - ((helpFit as any).innerH + 20)) <= 2 &&
      Math.abs((helpFit as any).winH - ((helpFit as any).innerH + 46)) <= 3,
    { size: helpAutoSize, fit: helpFit }
  );

  /**
   * 回归：**选一个网格**之后窗口不许「多长出一截空白」。
   *
   * 旧实现量 `.ah-body.scrollHeight`（撑满窗口那个盒子）→ 每推一次摘要就 +20px，
   * 一路长到屏幕 85%，用户看到的就是点一次网格长一截。
   */
  // 连选三处：旧实现是「每推一次摘要就 +20」，三次之后 body 会比内容高 80
  for (const bar of [12, 14, 16]) {
    await js(`window.__ma.select(${bar}, 0, 1)`);
    await wait(300);
  }
  await wait(220);
  const helpFit2 = helpAutoWin ? await readHelpFit(helpAutoWin) : null;
  await js(`window.__ma.clear()`);
  await wait(200);
  check(
    '反复选网格：帮助窗始终 body 高 = 内容高 + padding（不会一次 +20 地往上涨空白）',
    !!helpFit2 &&
      Math.abs((helpFit2 as any).bodyH - ((helpFit2 as any).innerH + 20)) <= 2 &&
      Math.abs((helpFit2 as any).winH - ((helpFit2 as any).innerH + 46)) <= 3,
    { before: helpFit, after: helpFit2 }
  );

  // 取消选中后再量一次：内容回缩，窗口也要跟着缩（不能只涨不落）
  await wait(420);
  const helpFit3 = helpAutoWin ? await readHelpFit(helpAutoWin) : null;
  check(
    '取消选中后帮助窗跟着缩回去（不是只涨不落）',
    // 提示条数本身会随上下文变（和弦 5 条 / 通用 3 条），所以只看两件事：
    // 高度对得上内容（不变式），且没有比选中时更高
    !!helpFit3 &&
      Math.abs((helpFit3 as any).bodyH - ((helpFit3 as any).innerH + 20)) <= 2 &&
      Math.abs((helpFit3 as any).winH - ((helpFit3 as any).innerH + 46)) <= 3 &&
      (helpFit3 as any).winH < ((helpFit2 as any)?.winH ?? 0),
    { before: helpFit?.winH, selected: helpFit2?.winH, after: helpFit3?.winH }
  );
  // 后面还有「菜单开合」的用例，从「关着」开始；这里先把它关掉并等勾选状态复位
  helpAutoWin?.close();
  for (let i = 0; i < 16; i++) {
    const st: any = await js(`window.api.help.state()`);
    if (!st?.open) break;
    await wait(120);
  }
  await wait(320);

  const menuItemsOf = async (label: string) => {
    await js(`(() => {
      const b = [...document.querySelectorAll('.menubar .menu .top')]
        .find((x) => (x.textContent || '').startsWith(${JSON.stringify(label)}));
      b?.click();
    })()`);
    await wait(180);
    return (await js(`[...document.querySelectorAll('.menubar .drop .item')].map((b) => ({
      text: b.querySelector('.text')?.textContent?.trim() ?? '',
      tick: b.querySelector('.tick')?.textContent?.trim() ?? '',
      accel: b.querySelector('.accel')?.textContent?.trim() ?? '',
      disabled: b.classList.contains('disabled'),
    }))`)) as any[];
  };
  const closeMenus = async () => {
    await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await wait(140);
  };

  const editMenuItems = await menuItemsOf('编辑');
  const editMenuText = editMenuItems.map((i: any) => String(i.text));
  const editAccel = (name: string) => editMenuItems.find((i: any) => i.text === name)?.accel ?? '';
  check(
    '「编辑」菜单里有撤销 / 重做 / 全局撤销 / 全局重做（都带加速键）',
    ['撤销', '重做', '全局撤销', '全局重做'].every((n) => editMenuText.includes(n)) &&
      editAccel('撤销') === 'Ctrl+Z' &&
      editAccel('重做') === 'Ctrl+Y' &&
      editAccel('全局撤销') === 'Ctrl+Shift+Z' &&
      editAccel('全局重做') === 'Ctrl+Shift+Y',
    { items: editMenuItems.map((i: any) => `${i.text}${i.accel ? ' / ' + i.accel : ''}`) }
  );

  const viewItems = await menuItemsOf('视图');
  const helpEntryInView = viewItems.find((i: any) => /动态操作帮助/.test(i.text));
  check('「视图」菜单里有「动态操作帮助」，默认未勾选', !!helpEntryInView && helpEntryInView.tick === '', {
    helpEntryInView,
    items: viewItems.map((i: any) => i.text),
  });
  await js(`(() => {
    const b = [...document.querySelectorAll('.menubar .drop .item')]
      .find((x) => (x.querySelector('.text')?.textContent || '').includes('动态操作帮助'));
    b?.click();
  })()`);
  await wait(800);
  const helpStateOpen = await js(`window.api.help.state()`);
  const helpWindow = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#help')) ?? null;
  const helpBounds = helpWindow ? helpWindow.getBounds() : null;
  check(
    '点「视图 → 动态操作帮助」打开窗（宽 520、高度按内容自适应），默认置顶',
    !!helpWindow &&
      !!helpBounds &&
      helpBounds.width === 520 &&
      helpBounds.height > 200 &&
      helpWindow.isAlwaysOnTop() === true &&
      (helpStateOpen as any)?.open === true,
    { open: (helpStateOpen as any)?.open, bounds: helpBounds, top: helpWindow?.isAlwaysOnTop() }
  );

  // 主窗口选区一变，帮助窗口的摘要跟着变（跨窗口只走这一条线）
  await js(`window.__ma.select(12, 0, 1)`);
  await wait(500);
  const helpText = helpWindow
    ? await helpWindow.webContents.executeJavaScript(`document.querySelector('.ah-body')?.innerText ?? ''`)
    : '';
  check(
    '帮助窗口跟着主窗口的选区变：摘要里有小节位置，下面的提示也换成「选中的记号」',
    /第 12 小节|12\.\d/.test(String(helpText)) && /选中的记号/.test(String(helpText)),
    { sample: String(helpText).replace(/\s+/g, ' ').slice(0, 180) }
  );

  /* ---- 动态帮助：提示跟着「选区 / 输入框 / 鼠标所在区域」走（v0.42） ---- */
  /** 读「这里能做什么」那一段（第 2 个 .ah-sec） */
  const readCtx = async () =>
    helpWindow
      ? await helpWindow.webContents.executeJavaScript(`(() => {
          const secs = [...document.querySelectorAll('.ah-sec')];
          const sec = secs[1] ?? null;
          return {
            where: document.querySelector('.ah-where')?.textContent?.trim() ?? '',
            items: sec ? [...sec.querySelectorAll('.ah-list li')].map((x) => x.textContent.trim()) : [],
            groups: document.querySelectorAll('.ah-group').length,
          };
        })()`)
      : null;
  const hoverRegion = async (sel: string) => {
    await js(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (el) el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    })()`);
    await wait(420);
  };

  const ctxSel = await readCtx();
  await hoverRegion('.sidebar');
  const ctxHoverSidebar = await readCtx();
  check(
    '选中优先、悬停不抢：选着和弦时把鼠标移到侧边栏，提示仍然是「选中的记号」',
    !!ctxSel && /选中的记号/.test((ctxSel as any).where) && (ctxSel as any).items.length >= 3 &&
      /选中的记号/.test((ctxHoverSidebar as any)?.where ?? ''),
    { sel: ctxSel, hover: ctxHoverSidebar }
  );

  // 取消选区之后才跟着鼠标走
  await js(`window.__ma.clear()`);
  await wait(260);
  await hoverRegion('.sidebar');
  const ctxSidebar = await readCtx();
  check(
    '没有选区时跟着鼠标走：悬停侧边栏 → 提示换成侧边栏（不再是那套通用说明）',
    /侧边栏/.test((ctxSidebar as any)?.where ?? '') && ((ctxSidebar as any)?.items?.length ?? 0) >= 3,
    ctxSidebar
  );

  await hoverRegion('.detail');
  const ctxDetail = await readCtx();
  check(
    '悬停详情面板 → 提示换成详情面板（双击编辑 / 右键选模块 / 圆圈 i）',
    /详情面板/.test((ctxDetail as any)?.where ?? '') && ((ctxDetail as any)?.items ?? []).some((x: string) => /圆圈 i/.test(x)),
    ctxDetail
  );

  await hoverRegion('.dock');
  const ctxGrid = await readCtx();
  check(
    '悬停时间线面板 → 提示换成时间线（框选 / 拖播放头 / 头带 / 低音右键）',
    /时间线面板/.test((ctxGrid as any)?.where ?? '') && ((ctxGrid as any)?.items ?? []).some((x: string) => /框选/.test(x)),
    ctxGrid
  );

  // 输入框：优先级最高（正打着字的时候最需要 Enter/Esc）
  await js(`window.__ma.select(12, 0, 1)`);
  await wait(200);
  await js(`window.__ma.openInput('V')`);
  await wait(420);
  const ctxInput = await readCtx();
  check(
    '输入框开着 → 提示换成输入框（Enter 落库 / ↑↓ 选候选），压过鼠标所在区域',
    /输入框/.test((ctxInput as any)?.where ?? '') && ((ctxInput as any)?.items ?? []).some((x: string) => /Enter/.test(x)),
    ctxInput
  );

  /* ---- 「级数行打 h」这条提示：必须排在第一条，且用品牌绿强调（v0.66） ----
   * 它回答的是「我现在这个和弦怎么打」，比「Enter 落库」更急 —— 所以放第一条。
   * 颜色不写死 #42b883：取 `--accent` 的实际计算值来比，换主题 / 换配色这条断言仍然成立。
   */
  const hintBlock = helpWindow
    ? await helpWindow.webContents.executeJavaScript(`(() => {
        const sec = document.querySelectorAll('.ah-sec')[1] ?? null;
        const items = sec ? [...sec.querySelectorAll('.ah-list li')] : [];
        const first = items[0] ?? null;
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return {
          where: document.querySelector('.ah-where')?.textContent?.trim() ?? '',
          first: first ? first.textContent.trim() : null,
          hinted: first ? first.classList.contains('ah-hint') : false,
          color: first ? getComputedStyle(first).color : null,
          accent,
          total: items.length,
        };
      })()`)
    : null;
  check(
    '「级数行打 h 出半减七」排在「这里能做什么」第一条，并用 Vue 绿强调',
    !!hintBlock &&
      /输入框/.test((hintBlock as any).where) &&
      /h/.test(String((hintBlock as any).first ?? '')) &&
      /半减七/.test(String((hintBlock as any).first ?? '')) &&
      (hintBlock as any).hinted === true &&
      (hintBlock as any).color === (hintBlock as any).accent &&
      (hintBlock as any).total >= 5,
    hintBlock
  );
  await shotOf(helpWindow, 'smoke-help-hint.png');

  await shotOf(helpWindow, 'smoke-help-ctx.png');

  /* ---- 级数泳道的补全候选：打 V 就出常用组合，第一条是干净写法且默认选中 ---- */
  await js(`(() => {
    const el = document.querySelector('.cell-input');
    if (!el) return;
    el.value = 'V';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(220);
  const romanSug = (await js(`[...document.querySelectorAll('.cell-sug li')].map((li) => ({
    label: li.querySelector('span')?.textContent?.trim() ?? '',
    hint: li.querySelector('em')?.textContent?.trim() ?? '',
    active: li.classList.contains('on'),
  }))`)) as any[];
  check(
    '级数泳道打 V → 候选是 V / V7 / Vsus4 / V7sus4 / V(6/9)…，第一条就是干净的 V 且默认选中',
    romanSug.length >= 5 &&
      romanSug[0]?.label === 'V' &&
      romanSug[0]?.active === true &&
      romanSug.some((x) => x.label === 'V7sus4') &&
      romanSug.some((x) => x.label === 'V(6/9)'),
    romanSug
  );
  const sugLayout = (await js(`(() => {
    const ul = document.querySelector('.cell-sug');
    if (!ul) return null;
    const lis = [...ul.querySelectorAll('li')];
    return {
      width: ul.getBoundingClientRect().width,
      rows: lis.map((li) => ({
        h: li.getBoundingClientRect().height,
        ws: getComputedStyle(li).whiteSpace,
        bg: getComputedStyle(li).backgroundColor,
        cls: li.className,
      })),
    };
  })()`)) as any;
  check(
    '和弦补全框足够宽（≥300px），候选行不换行（不会有的高有的矮）',
    !!sugLayout &&
      sugLayout.width >= 300 &&
      sugLayout.rows.length >= 5 &&
      sugLayout.rows.every((r: any) => r.ws === 'nowrap' && r.h <= 26),
    sugLayout
  );
  check(
    '补全候选一行本色一行灰（斑马纹），选中行仍用选中色',
    !!sugLayout &&
      sugLayout.rows.length >= 3 &&
      sugLayout.rows[1].bg !== sugLayout.rows[2].bg &&
      sugLayout.rows[1].bg !== 'rgba(0, 0, 0, 0)' &&
      /on/.test(sugLayout.rows[0].cls),
    sugLayout?.rows?.slice(0, 3)
  );

  // 打 6 / 69 / 6/9：除了数字低音转位，也要递上六九和弦（必须带括号）
  for (const typed of ['V6', 'V69', 'V6/9']) {
    await js(`(() => {
      const el = document.querySelector('.cell-input');
      if (!el) return;
      el.value = ${JSON.stringify(typed)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(200);
    const labels = (await js(`[...document.querySelectorAll('.cell-sug li span')].map((x) => x.textContent.trim())`)) as string[];
    check(
      `打 ${typed} → 补全里同时有六九和弦 V(6/9)${typed === 'V6' ? '，以及模糊命中的 V7sub6' : ''}`,
      labels.includes('V(6/9)') && (typed !== 'V6' || labels.includes('V7sub6')),
      labels
    );
  }

  // 继续打字符就按前缀过滤
  await js(`(() => {
    const el = document.querySelector('.cell-input');
    if (!el) return;
    el.value = 'V7s';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(200);
  const romanSug2 = (await js(`[...document.querySelectorAll('.cell-sug li span')].map((x) => x.textContent.trim())`)) as string[];
  check(
    '继续打 V7s → V7sus4 / V7sub6（前缀过滤）',
    JSON.stringify(romanSug2) === JSON.stringify(['V7sus4', 'V7sub6']),
    romanSug2
  );

  /* ---- 级数补全的推断 / 双拼 / 顺序：从真实输入框走，不直接调纯函数 ---- */
  const typeCell = async (text: string) => {
    await js(`(() => {
      const el = document.querySelector('.cell-input');
      if (!el) return;
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(180);
    return js(`[...document.querySelectorAll('.cell-sug li span')].map((x) => x.textContent.trim())`);
  };
  const v7Labels = await typeCell('V7');
  check(
    '打 V7 → 前四条是 V7 / V7sus4 / V7♭9 / V7sub6（模糊项排后面）',
    JSON.stringify(v7Labels.slice(0, 4)) === JSON.stringify(['V7', 'V7sus4', 'V7♭9', 'V7sub6']) &&
      v7Labels.includes('Vm7b5'),
    v7Labels
  );
  const sLabels = await typeCell('iis');
  check(
    '打 iis → sus2 / sus4 / sub6',
    JSON.stringify(sLabels) === JSON.stringify(['iisus2', 'iisus4', 'iisub6']),
    sLabels
  );
  const hLabels = await typeCell('iih');
  check(
    '打 iih → 半减七五个选项（ø7 / ø65 / ø43 / ø42 / m7b5）',
    JSON.stringify(hLabels) === JSON.stringify(['iiø7', 'iiø65', 'iiø43', 'iiø42', 'iim7b5']),
    hLabels
  );
  // 留一张候选框证据：半减七第一组、每行带说明
  await shot('smoke-chord-suggest.png');
  const bareII = await typeCell('ii');
  check(
    '裸 ii 第一位仍是 ii，半减七不会自动顶到第一',
    bareII[0] === 'ii' && !bareII.some((x: string) => x.includes('ø')),
    bareII
  );
  const h42 = await typeCell('iih42');
  check('打 iih42 → 直接补 iiø42', JSON.stringify(h42) === JSON.stringify(['iiø42']), h42);
  const v76 = await typeCell('V76');
  const v67 = await typeCell('V67');
  check(
    '打 V76 / V67 → 不连续、乱序也能补出 V7sub6',
    v76[0] === 'V7sub6' && v67[0] === 'V7sub6',
    { v76, v67 }
  );
  const vs6 = await typeCell('Vs6');
  check(
    '打 Vs6 → 第一条是 Vsub6，第二条才是 V7sub6',
    JSON.stringify(vs6.slice(0, 2)) === JSON.stringify(['Vsub6', 'V7sub6']),
    vs6
  );
  const flatLabels = await typeCell('bII');
  check(
    '打 bII → 第一条是 ♭II（双拼前缀 j / jiang / jl 同理，见单测）',
    Array.isArray(flatLabels) && flatLabels[0] === '♭II',
    flatLabels
  );

  // 收尾：Esc 退出输入（不写库）
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(240);
  const editAfterEsc = await js(`window.__ma.editing()`);
  check('Esc 退出输入框、未写库', editAfterEsc === null, { editing: editAfterEsc });

  /* ---- 完整手势清单：默认收起，点一下展开 ---- */
  const helpBeforeExpand = await readCtx();
  await helpWindow?.webContents.executeJavaScript(`document.querySelector('.ah-more')?.click()`);
  await wait(220);
  const helpAfterExpand = await readCtx();
  await helpWindow?.webContents.executeJavaScript(`document.querySelector('.ah-more')?.click()`);
  await wait(200);
  const helpAfterCollapse = await readCtx();
  check(
    '完整手势清单默认收起，点「全部手势」展开（窗口高度跟着长），再点收起',
    (helpBeforeExpand as any)?.groups === 0 &&
      ((helpAfterExpand as any)?.groups ?? 0) >= 4 &&
      (helpAfterCollapse as any)?.groups === 0,
    {
      before: (helpBeforeExpand as any)?.groups,
      after: (helpAfterExpand as any)?.groups,
      collapsed: (helpAfterCollapse as any)?.groups,
    }
  );

  const topOff = await js(`window.api.help.setAlwaysOnTop(false)`);
  await wait(240);
  check(
    '帮助窗口的「置顶」能关掉（关掉后窗口真的不置顶）',
    (topOff as any)?.alwaysOnTop === false && helpWindow?.isAlwaysOnTop() === false,
    { topOff, top: helpWindow?.isAlwaysOnTop() }
  );
  await js(`window.api.help.setAlwaysOnTop(true)`);
  await wait(160);

  /* ---- 浅色模式下，帮助窗自己也得是浅色（不只是系统画的标题栏） ---- */
  await js(`window.__app.setTheme('light')`);
  await wait(520);
  const appThemeNow = await js(`window.api.app.theme()`);
  const helpDomLight = helpWindow
    ? await helpWindow.webContents.executeJavaScript(
        `({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor })`
      )
    : null;
  check(
    '切到浅色：帮助窗自己是浅色（曾经它读不到 data-theme 就落默认深色，只有标题栏是浅的）',
    appThemeNow === 'light' && (helpDomLight as any)?.theme === 'light',
    { app: appThemeNow, help: helpDomLight }
  );

  await js(`window.__app.setTheme('dark')`);
  await wait(420);
  const helpDomDark = helpWindow
    ? await helpWindow.webContents.executeJavaScript(`document.documentElement.dataset.theme`)
    : null;
  check('切回深色：帮助窗跟着变深（两个方向都要跟，不能只跟一次）', helpDomDark === 'dark', { help: helpDomDark });

  const helpMenuItems = await menuItemsOf('帮助');
  const helpEntryInHelp = helpMenuItems.find((i: any) => /动态操作帮助/.test(i.text));
  check('「帮助」菜单里也有同一条，且打开时是勾选状态（两处同一个开关）', !!helpEntryInHelp && helpEntryInHelp.tick === '✓', {
    helpEntryInHelp,
    items: helpMenuItems.map((i: any) => i.text),
  });
  await closeMenus();

  if (helpWindow) helpWindow.close();
  await wait(600);
  const helpStateClosed = await js(`window.api.help.state()`);
  check('关掉帮助窗口后状态回 false（菜单勾选跟着取消）', (helpStateClosed as any)?.open === false, helpStateClosed);

  // 8) 抢键回归：输入框里的 Ctrl+R / Ctrl+Z 不能去动全局
  const evCount = () => (rows(`SELECT COUNT(*) AS c FROM analysis_event WHERE analysis_id = ?`, analysisId)[0] as any).c;  const tracksCount = () => (rows(`SELECT COUNT(*) AS c FROM track WHERE deleted_at IS NULL`)[0] as any).c;
  const evN0 = evCount();
  const trN0 = tracksCount();
  await dblBandAt('key', firstKey.tick);
  await js(`document.querySelector('.key-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }))`);
  await js(`document.querySelector('.key-input')?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))`);
  await wait(380);
  check(
    '输入框里按 Ctrl+R / Ctrl+Z 不新建作品、不撤销网格',
    tracksCount() === trN0 && evCount() === evN0,
    { tracks: [trN0, tracksCount()], events: [evN0, evCount()] }
  );
  await closeBandEdit();

  // 首选项（含深浅色 / 缩放 / 字体）
  await js(`window.__app.prefs(true)`);
  await wait(320);
  // 新开关确实长在设置界面上（默认勾选，且父项打开时可用）
  const prefRows = (await js(`(() => {
    const rows = [...document.querySelectorAll('.settings .pref-row')];
    return {
      n: rows.length,
      open: !!document.querySelector('.settings'),
      rows: rows.map((r) => {
        const cb = r.querySelector('input[type=checkbox]');
        return {
          text: (r.textContent || '').trim().slice(0, 30),
          checked: cb ? !!cb.checked : null,
          disabled: cb ? !!cb.disabled : null,
        };
      }),
    };
  })()`)) as any;
  const rowList: any[] = Array.isArray(prefRows?.rows) ? prefRows.rows : [];
  // 注意：文案是「拖到没有和弦的格子时**清空选区**」——里面**没有「空格」这个子串**
  // （是「清空」+「选区」），第一版用 /空格/ 匹配，永远是 -1
  const clearIdx = rowList.findIndex((r) => /没有和弦|empty cell/.test(String(r?.text ?? '')));
  const clearRow = clearIdx >= 0 ? rowList[clearIdx] : null;
  const clearOk = clearRow !== null && clearRow.checked === true && clearRow.disabled === false;
  check(
    '设置里有「拖到没有和弦的格子时清空选区」，默认勾选、父项开着时可用',
    clearOk,
    { clearOk, clearIdx, clearRow, rows: rowList.map((r) => r?.text ?? '') }
  );

  await shot('smoke-prefs.png');
  const prefHasTheme = await js(
    `[...document.querySelectorAll('.settings .chip')].map((b) => b.textContent.trim()).filter((t) => /深色|浅色/.test(t)).length`
  );
  check('首选项里有深色/浅色切换', prefHasTheme === 2, prefHasTheme);

  /**
   * 复选框是自绘的 Vue 绿，不是 Chromium 原生外观。
   * 原生那个系统蓝方块在深色底下特别扎眼，而且跟 --accent 没有任何关系。
   *
   * 量法：拿**同一个**框，先量选中、再点掉量未选 ——
   * 不能分别去找「第一个」和「第二个」框：第一个（自动打开歌词）默认就是勾上的，
   * 一开始量到的不是未选态。而且 checked 是响应式的，读完要等 Vue 下一个 tick 才刷。
   */
  const cbProbe = async () =>
    js(
      `(async () => {
         const c = document.querySelector('.settings .pref-row input[type=checkbox]');
         if (!c) return { found: false };
         // 背景色带 120ms 过渡，读太快拿到的是渐变中间帧（不是 --accent 的值）。
         const settle = () => new Promise(r => setTimeout(r, 360));
         const read = () => {
           const s = getComputedStyle(c);
           // 方框画在 ::before 上（input 本体透明，见 App.vue 里的注释）
           const b = getComputedStyle(c, '::before');
           const a = getComputedStyle(c, '::after');
           return { checked: c.checked, bg: b.backgroundColor, border: b.borderTopColor,
                    appearance: s.appearance || s.webkitAppearance,
                    w: parseFloat(s.width),
                    afterW: parseFloat(a.width) || 0, afterH: parseFloat(a.height) || 0 };
         };
         const was = c.checked;
         if (c.checked) { c.click(); await settle(); }
         const off = read();
         c.click(); await settle();
         const on = read();
         if (was !== c.checked) { c.click(); await settle(); }  // 还原
         return { found: true, off, on };
       })()`
    );
  const cb = await cbProbe();
  const accentNow = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  const accentRgbNow = await js(
    `getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()`
  );
  const hexToRgb = (hex: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.replace('#', ''));
    if (!m) return '';
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  };
  const accentAsRgb = (accentNow.startsWith('#') ? hexToRgb(accentNow) : accentRgbNow).replace(/\s+/g, '');
  const norm = (s: string) => (s ?? '').replace(/\s+/g, '');
  check(
    '选项复选框是自绘 Vue 绿（接管 appearance + 选中底色 = --accent + 勾画出来了 + 尺寸没被浏览器顶大）',
    cb.found === true &&
      String(cb.off.appearance).includes('none') &&
      norm(cb.on.bg) === `rgb(${accentAsRgb})` &&
      // 勾只在选中态出现：::after 有尺寸，未选中时为 0
      cb.on.afterW > 0 &&
      cb.off.afterW === 0 &&
      // 未选中不能是绿的（否则等于一直是开着的）
      norm(cb.off.bg) !== `rgb(${accentAsRgb})` &&
      // 13px 是设计尺寸；appearance:none 之后 Chromium 仍会给 form 控件
      // 套一层默认最小尺寸，只写 width 会被顶到 16px（min-width 才压得住）
      cb.on.w === 13,
    { accent: accentNow, ...cb }
  );

  // 浅色下也要对：accent 会换成压暗一档的绿（#2f9e6b），勾仍是白的
  await js(`window.__app.setTheme('light')`);
  await wait(500);
  const cbLight = await cbProbe();
  const accentLight = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  const accentLightRgb = await js(
    `getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()`
  );
  const lightAsRgb = (accentLight.startsWith('#') ? hexToRgb(accentLight) : accentLightRgb).replace(/\s+/g, '');
  check(
    '复选框在浅色主题下也是绿的（accent 换成压暗一档的 #2f9e6b）',
    cbLight.found === true && norm(cbLight.on.bg) === `rgb(${lightAsRgb})`,
    { accent: accentLight, on: cbLight.on }
  );
  await js(`window.__app.setTheme('dark')`);
  await wait(400);

  /**
   * 主题模式：深色 / 浅色 / 跟随系统 / 按时段。
   * system 只能问主进程要（nativeTheme 是 Electron API，渲染层读不到），
   * 所以这条同时验「模式记住了」与「实际生效的值与模式一致」。
   */
  const themeModes: Record<string, string> = {};
  for (const m of ['light', 'dark', 'system', 'timed']) {
    await js(`window.__app.setTheme(${JSON.stringify(m)})`);
    await wait(450);
    const st = await js(
      `({ mode: window.__app.themeMode(), now: window.__app.themeNow(),
          attr: document.documentElement.dataset.theme })`
    );
    themeModes[m] = `${st.mode}/${st.now}`;
    // 存进了 localStorage 吗（下次启动要靠它）
    const stored = await js(`localStorage.getItem('ma-theme-mode')`);
    if (stored !== m) {
      check(`主题模式 ${m} 能选中并落盘`, false, { stored, mode: st.mode, now: st.now });
    }
  }
  check(
    '主题四种模式都能切：浅色/深色/跟随系统/按时段',
    themeModes.light === 'light/light' &&
      themeModes.dark === 'dark/dark' &&
      themeModes.system?.startsWith('system/') &&
      themeModes.timed?.startsWith('timed/'),
    themeModes
  );
  // 按时段：7–18 点浅色，其余深色。当前几点决定落在哪一边
  const hour = new Date().getHours();
  const wantTimed = hour >= 7 && hour < 18 ? 'light' : 'dark';
  const timedNow = await js(`(window.__app.themeMode(), window.__app.themeNow())`);
  check(
    `按时段模式按当前时间（${hour} 点）挑了 ${wantTimed}`,
    timedNow === wantTimed,
    { hour, want: wantTimed, got: timedNow }
  );
  // 还原成深色，别把后面的断言留在自动模式上
  await js(`window.__app.setTheme('dark')`);
  await wait(400);

  /**
   * 语言是给人点按钮切的，不是只给冒烟钩子切的：
   * 这里真的点一下选项面板里的 English / 日本語，看界面有没有跟着换，再点回中文。
   */
  const langChips = await js(
    `[...document.querySelectorAll('.settings .chip')].map((b) => b.textContent.trim()).filter((t) => /中文|English|日本語/.test(t))`
  );
  const clickLang = (label: string) =>
    js(
      `[...document.querySelectorAll('.settings .chip')]
         .find((b) => b.textContent.trim() === ${JSON.stringify(label)})?.click()`
    );
  await clickLang('English');
  await wait(240);
  await shot('smoke-prefs-en.png');
  const enFromPanel = await js(`(() => ({
    menu: [...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim()),
    head: document.querySelector('.settings h3')?.textContent?.trim() ?? null,
    note: document.querySelector('.settings .s-sec p')?.textContent?.trim() ?? null,
  }))()`);
  // 日语：菜单、设置标题、说明都应该是日语；顺带看 <html lang> 有没有跟着换
  await clickLang('日本語');
  await wait(240);
  await shot('smoke-prefs-ja.png');
  const jaFromPanel = await js(`(() => ({
    menu: [...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim()),
    head: document.querySelector('.settings h3')?.textContent?.trim() ?? null,
    note: document.querySelector('.settings .s-sec p')?.textContent?.trim() ?? null,
    lang: document.documentElement.lang,
  }))()`);
  // 默认名是主进程拼的（`sidebar.playlistDefault`）：日语界面下不能冒出一串中文
  const jaPl = (await js(`(async () => {
    const doc = await window.api.playlists.create();
    const last = doc.lists[doc.lists.length - 1];
    // 建完就删，别给后面的断言留下一堆空列表
    await window.api.playlists.remove(last.id);
    return { name: last?.name ?? null, count: doc.lists.length };
  })()`)) as any;
  check(
    '新建播放列表的默认名跟界面语言走（日语下是「プレイリスト N」）',
    /^プレイリスト \d+$/.test(String(jaPl?.name ?? '')),
    jaPl
  );

  // 繁體台灣：菜单「檔案(F)」、html lang=zh-Hant-TW、设置标题「選項」
  await clickLang('繁體中文（台灣）');
  await wait(260);
  await shot('smoke-prefs-tw.png');
  const twFromPanel = await js(`(() => ({
    menu: [...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim()),
    head: document.querySelector('.settings h3')?.textContent?.trim() ?? null,
    lang: document.documentElement.lang,
  }))()`);
  // 繁體香港：同一套菜单，但用词按香港（軟件 / 裏）
  await clickLang('繁體中文（香港）');
  await wait(260);
  // 菜单与 <html lang> 就能说明「切到香港那份了」；具体用词（軟件 / 裏）由单测盯着
  const hkFromPanel = await js(`(() => ({
    menu: [...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim()),
    lang: document.documentElement.lang,
  }))()`);
  check(
    '繁体两份都能切：台灣「檔案(F)」+ zh-Hant-TW，香港 zh-Hant-HK（用词按香港）',
    twFromPanel?.menu?.[0] === '檔案(F)' &&
      twFromPanel?.head === '選項' &&
      twFromPanel?.lang === 'zh-Hant-TW' &&
      hkFromPanel?.menu?.[0] === '檔案(F)' &&
      hkFromPanel?.lang === 'zh-Hant-HK',
    { twFromPanel, hkFromPanel }
  );

  await clickLang('简体中文');  // 语言选项的名字是「简体中文」，不是笼统的「中文」
  await wait(240);
  const backFromPanel = await js(
    `[...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim())[0]`
  );
  check(
    '选项里的语言按钮真的能切：English / 日本語 / 繁體中文 × 2（<html lang> 也跟着走），简体中文 → 还原',
    JSON.stringify(langChips) === JSON.stringify(['简体中文', '繁體中文（台灣）', '繁體中文（香港）', 'English', '日本語']) &&
      enFromPanel.menu[0] === 'File' &&
      enFromPanel.head === 'Options' &&
      /^Switches the whole interface/.test(String(enFromPanel.note)) &&
      // 日语与中文一样带括号助记符：ファイル(F)
      jaFromPanel.menu[0] === 'ファイル(F)' &&
      jaFromPanel.head === 'オプション' &&
      /^切り替えるとインターフェース全体/.test(String(jaFromPanel.note)) &&
      jaFromPanel.lang === 'ja' &&
      backFromPanel === '文件(F)',
    { langChips, enFromPanel, jaFromPanel, backFromPanel }
  );

  /* ---- 选项面板：Esc 直接关；模板编辑器有未保存文本时先问一句 ---- */
  const escPlain = (await js(`(async () => {
    const panel = () => !!document.querySelector('.settings');
    const before = panel();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 260));
    return { before, open: panel() };
  })()`)) as any;
  check('选项面板按 Esc 直接关掉', escPlain?.before === true && escPlain?.open === false, escPlain);

  const escDirty = (await js(`(async () => {
    window.__app.prefs(true);
    await new Promise((r) => setTimeout(r, 200));
    // 在模板编辑器里打一个字（只改 value 不派 input 不会置脏，这里两件事都做）
    const name = document.querySelector('.settings .tpl-name');
    if (!name) return { noInput: true };
    name.value = 'smoke-template';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    const asked = !!document.querySelector('.modal.confirm');
    const stillOpen = !!document.querySelector('.settings');
    // 先点「取消」：面板应该还在
    [...document.querySelectorAll('.modal.confirm .confirm-actions .chip')]
      .find((b) => b.textContent.trim() === '取消')?.click();
    await new Promise((r) => setTimeout(r, 220));
    const afterCancel = !!document.querySelector('.settings');
    // 再来一次，这回点「确定」
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    [...document.querySelectorAll('.modal.confirm .confirm-actions .chip')]
      .find((b) => b.textContent.trim() === '确定')?.click();
    await new Promise((r) => setTimeout(r, 240));
    return { asked, stillOpen, afterCancel, closed: !document.querySelector('.settings') };
  })()`)) as any;
  check(
    '模板编辑器有未保存文本时，Esc 先问一句（取消留在面板，确定才关）',
    escDirty?.asked === true && escDirty?.stillOpen === true && escDirty?.afterCancel === true && escDirty?.closed === true,
    escDirty
  );

  /*
   * 改完模板字体（顺手动过编辑器）再点右上角关闭：确认框必须**可见且可点**。
   * 两个 `.modal-mask` 都是 z-index 50 时，DOM 里靠后的选项面板会盖住确认框 ——
   * 用户看到的就是「关闭按钮点了没反应」（2026-11-23 报的 bug）。
   * 这里量三件事：确认框存在、它顶端确实是命中它的元素、层级比面板高。
   */
  const closeOnTop = (await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__app.prefs(true);
    await sleep(240);
    const ta = document.querySelector('.settings .tpl-ed textarea');
    if (!ta) return { noEditor: true };
    ta.value = ta.value + 'x';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(90);
    [...document.querySelectorAll('.settings .s-head .chip')].pop()?.click();
    await sleep(280);
    const confirm = document.querySelector('.modal.confirm');
    const mask = confirm?.parentElement;
    const settingsMask = document.querySelector('.settings')?.parentElement;
    const r = confirm?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + 12) : null;
    return {
      asked: !!confirm,
      onTop: !!hit && !!hit.closest('.modal.confirm'),
      zConfirm: mask ? Number(getComputedStyle(mask).zIndex) : 0,
      zSettings: settingsMask ? Number(getComputedStyle(settingsMask).zIndex) : 0,
    };
  })()`)) as any;
  await js(`document.querySelector('.modal.confirm .confirm-actions .chip.danger')?.click()`);
  await wait(280);
  const closedAfterConfirm = await js(`!document.querySelector('.settings')`);
  check(
    '改完模板字体再点右上角关闭：确认框弹在面板之上（看得见、点得到），点确定后关掉面板',
    closeOnTop?.asked === true &&
      closeOnTop?.onTop === true &&
      closeOnTop?.zConfirm > closeOnTop?.zSettings &&
      closedAfterConfirm === true,
    { ...closeOnTop, closedAfterConfirm }
  );

  /* ---- 冒烟全程静音：测试会真播音频，不能从音箱里出来打断人 ---- */
  check(
    '冒烟窗口的音频已静音（播放与时钟照常，只是不出声）',
    win!.webContents.isAudioMuted() === true,
    { muted: win!.webContents.isAudioMuted() }
  );

  /* ---- 左右侧栏可拖拽调宽 ---- */
  const splitBefore = (await js(`(() => {
    const b = document.querySelector('.body');
    return {
      w: localStorage.getItem('ma-left-w'),
      cols: getComputedStyle(b).gridTemplateColumns,
      box: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
    };
  })()`)) as any;
  await js(`(() => {
    const h = document.querySelector('.vsplit.left');
    if (!h) return;
    const r = h.getBoundingClientRect();
    const fire = (type, x, buttons) =>
      h.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: r.top + 120, button: 0, buttons,
        pointerId: 71, bubbles: true, cancelable: true,
      }));
    fire('pointerdown', r.left + 3, 1);
    fire('pointermove', r.left + 33, 1);
    fire('pointermove', r.left + 63, 1);
    fire('pointerup', r.left + 63, 0);
  })()`);
  await wait(220);
  const splitAfter = (await js(`(() => ({
    w: localStorage.getItem('ma-left-w'),
    box: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
  }))()`)) as any;
  // 结构断言：详情面板必须和侧栏、主区在同一行 —— 一旦手柄变成 grid 子项，
  // 「详情」会被挤到第二行（整个排版塌掉，这是真发生过的回归）
  const rowCheck = (await js(`(() => {
    const b = document.querySelector('.body');
    const d = document.querySelector('.detail');
    const s2 = document.querySelector('.sidebar');
    if (!b || !d || !s2) return null;
    return {
      detailTop: Math.round(d.getBoundingClientRect().top),
      sideTop: Math.round(s2.getBoundingClientRect().top),
      cols: getComputedStyle(b).gridTemplateColumns.split(' ').length,
    };
  })()`)) as any;
  check(
    '排版没塌：详情面板与侧栏在同一行（手柄不占 grid 列）',
    !!rowCheck && rowCheck.detailTop === rowCheck.sideTop && rowCheck.cols === 3,
    rowCheck
  );

  check(
    '拖左栏边缘 → 侧栏变宽 60px 并落盘',
    splitAfter.box === splitBefore.box + 60 && Number(splitAfter.w) === splitAfter.box,
    { before: splitBefore, after: splitAfter }
  );

  /* ---- 面板尺寸：拖完要写进 config.json，下次启动能读回来 ---- */
  await wait(520); // 等 300ms 防抖到点
  await js(`window.__app.flushPanels()`);
  const cfgOnDisk = configStore!.file;
  const diskCfg = fs.existsSync(cfgOnDisk) ? JSON.parse(fs.readFileSync(cfgOnDisk, 'utf8')) : null;
  check(
    '拖完左栏宽度写进 config.json 的 layout.panels（不是只存在 localStorage）',
    !!diskCfg?.layout?.panels &&
      Math.abs(Number(diskCfg.layout.panels.leftW) - splitAfter.box) <= 2 &&
      typeof diskCfg.layout.panels.rightW === 'number' &&
      typeof diskCfg.layout.panels.panelH === 'number',
    { panels: diskCfg?.layout?.panels, want: splitAfter.box }
  );
  // 读路径：改 config 里的值 → 重新读一遍 → 侧栏宽度要跟着变（模拟下次启动）
  const panelRoundTrip = (await js(`(async () => {
    const before = Math.round(document.querySelector('.sidebar').getBoundingClientRect().width);
    await window.api.config.setLayout({ panels: { leftW: 250 } });
    await window.__app.reloadPanels();
    await new Promise((r) => setTimeout(r, 260));
    const after = Math.round(document.querySelector('.sidebar').getBoundingClientRect().width);
    await window.api.config.setLayout({ panels: { leftW: before } });
    await window.__app.reloadPanels();
    await new Promise((r) => setTimeout(r, 260));
    return { before, after, restored: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) };
  })()`)) as any;
  check(
    'config.json 里的面板宽度能读回来（下次启动的还原路径）',
    panelRoundTrip?.after === 250 && Math.abs(panelRoundTrip?.restored - panelRoundTrip?.before) <= 2,
    panelRoundTrip
  );
  // 拖回去，别把后面的布局断言带跑
  await js(`(() => {
    const h = document.querySelector('.vsplit.left');
    const r = h.getBoundingClientRect();
    const fire = (type, x, buttons) =>
      h.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: r.top + 120, button: 0, buttons,
        pointerId: 72, bubbles: true, cancelable: true,
      }));
    fire('pointerdown', r.left + 3, 1);
    fire('pointermove', r.left - 27, 1);
    fire('pointermove', r.left - 57, 1);
    fire('pointerup', r.left - 57, 0);
  })()`);
  await wait(200);

  /* ---- 播放按钮不该出现默认焦点框（空格是全局快捷键，一按就会让按钮进 :focus-visible） ---- */
  const playRing = (await js(`(() => {
    const b = document.querySelector('.transport .tp.play');
    if (!b) return null;
    b.focus();
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, focused: document.activeElement === b, w: Math.round(r.width) };
  })()`)) as any;
  check(
    '播放按钮获得焦点时不出现浏览器默认焦点框',
    !!playRing && playRing.focused === true && (playRing.outlineStyle === 'none' || parseFloat(playRing.outlineWidth || '0') === 0),
    playRing
  );
  await js(`document.querySelector('.transport .tp.play')?.blur()`);

  await js(`document.querySelector('.settings .s-head .chip')?.click()`);
  await wait(120);

  // 独立窗口：同一个渲染层，靠 hash 路由
  const opened = await js(`window.api.win.openGrid(${JSON.stringify(trackId)}, 'roman')`);
  await wait(1000);
  /**
   * 按 hash 认窗口，不要用「不是主窗口就是它」。
   * 歌词播报器 / 桌面歌词也是同一个 index.html 的 BrowserWindow，
   * 首次启动还会自动开一个 —— find(w => w !== win) 会抓到歌词窗口，
   * 截图存的是错的界面，断言也会因为「多了一个窗口」假失败。
   */
  const byHash = (h: string) =>
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(`#${h}`));
  const gridWin = byHash('grid');
  // 握手顺序：渲染层报 ready 之后主进程才去开歌词窗（用 setTimeout 猜时机会抢跑）
  check(
    '主窗口「完全启动」握手已完成（歌词窗在这之后才开）',
    mainAppReady === true && !!byHash('lyrics'),
    { mainAppReady, lyrics: !!byHash('lyrics') }
  );


  check('网格可在独立窗口打开', opened === true && !!gridWin, {
    opened,
    found: !!gridWin,
    urls: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL().split('/').pop()),
  });

  if (gridWin) {
    await wait(900);
    /**
     * ---- 格单位必须跟着主窗口走 ----
     *
     * 独立窗口没有单位菜单，以前也没接 `:unit` → 那边恒为一拍：主窗口切到「小节」后过去按
     * Alt+← 仍只收 480，看起来就是「步长写死了一拍」。现在靠同 origin 的 localStorage
     * （`ma-grid-unit`）+ `storage` 事件同步，这里验它真的跟过去了。
     */
    await js(`window.__ma.unit('half')`);
    await wait(460);
    const unitHalf = {
      main: await js(`window.__ma.grid()?.div`),
      grid: await gridWin.webContents.executeJavaScript(`window.__ma.grid()?.div`),
    };
    check(
      '主窗口切到「半拍」→ 独立窗口的格单位跟着变成 2（否则那边 Alt+← 永远收一拍）',
      unitHalf.main === 2 && unitHalf.grid === 2,
      unitHalf
    );
    await js(`window.__ma.unit('beat')`);
    await wait(320);

    /**
     * 独立窗口**不能有第二个播放器**。
     * 判据就是窗口里没有 `<audio>`：音频宿主只能是主窗口，子窗口发指令 + 收状态。
     * 这条以前是坏的 —— 两个窗口各持一个 <audio>，能错开播放、还能同时出声。
     */
    const gWinAudio = await gridWin.webContents.executeJavaScript(
      `({
        isHost: window.__maAudio?.isHost,
        hasEl: window.__maAudio?.hasEl?.(),
        gutter: getComputedStyle(document.querySelector('.scroll')).scrollbarGutter,
      })`
    );
    const mainHost = await js(`window.__maAudio?.isHost`);
    check(
      '独立网格窗口不是音频宿主（本窗口没有 <audio>，音频只在主窗口）',
      gWinAudio?.isHost === false && gWinAudio?.hasEl === false && mainHost === true,
      { grid: gWinAudio, main: mainHost }
    );
    // 在独立窗口里按播放：它只能发指令，绝不能自己造出一个播放器来
    await gridWin.webContents.executeJavaScript(`document.querySelector('.transport .tp.play')?.click()`);
    await wait(400);
    const gWinAfterPlay = await gridWin.webContents.executeJavaScript(`({ hasEl: window.__maAudio?.hasEl?.() })`);
    check('在独立窗口按播放也不会新建播放器（只是发指令给主窗口）', gWinAfterPlay?.hasEl === false, gWinAfterPlay);
    // 联动的前提是「状态真的流过来了」：窗口加载时会主动取一次主窗口状态
    const wireState = await gridWin.webContents.executeJavaScript(
      `({ remoteTrack: window.__maAudio?.remoteTrackId?.(), own: window.__maAudio?.trackId?.() })`
    );
    check(
      '独立窗口已经收到主窗口的播放状态（remoteTrack 与主进程记录一致）',
      (wireState?.remoteTrack ?? null) === (playerState.trackId ?? null),
      { wireState, published: playerState.trackId }
    );

    /* ---- 顶栏不再溢出：视图切换搬进左侧栏 ---- */
    const popHead = (await gridWin.webContents.executeJavaScript(`(() => {
      const h = document.querySelector('.gh');
      if (!h) return null;
      return {
        sw: h.scrollWidth,
        cw: h.clientWidth,
        side: !!document.querySelector('.gside'),
        viewBtns: document.querySelectorAll('.gside-i').length,
      };
    })()`)) as any;
    check(
      '独立窗口顶栏不溢出（视图切换已挪进左侧栏）',
      !!popHead && popHead.sw <= popHead.cw + 1 && popHead.side === true && popHead.viewBtns >= 4,
      popHead
    );

    /* ---- 最大化窗口下的滚动重绘开销（用户报「全屏拖滚动条卡」） ----
     * 这个窗口创建时就 maximize()，视口接近整屏 —— 正是用户报卡顿的场景。
     * 拖滚动条 = 每帧一次全视口重绘，所以量「平均一帧多少毫秒」。 */
    const gp0 = (await gridWin.webContents.executeJavaScript(`window.__ma.perf()`)) as any;
    await gridWin.webContents.executeJavaScript(`window.__ma.perfResetMax()`);
    for (let i = 0; i < 10; i++) {
      await gridWin.webContents.executeJavaScript(`window.__ma.scrollTo(${i * 160})`);
      await wait(45);
    }
    const gp1 = (await gridWin.webContents.executeJavaScript(`window.__ma.perf()`)) as any;
    const gDraws = Math.max(1, (gp1?.draws ?? 0) - (gp0?.draws ?? 0));
    const gAvg = Math.round((((gp1?.sumMs ?? 0) - (gp0?.sumMs ?? 0)) / gDraws) * 100) / 100;
    check(
      '最大化窗口拖滚动条：平均单帧 ≤ 12ms、最慢一帧 ≤ 20ms（60fps 还有余量）',
      gDraws >= 5 && gAvg > 0 && gAvg <= 12 && (gp1?.winMaxMs ?? 999) <= 20,
      { draws: gDraws, avgMs: gAvg, winMaxMs: gp1?.winMaxMs, allMaxMs: gp1?.maxMs, vw: gp1?.lastW, vh: gp1?.lastH }
    );

    /* ---- 左侧栏：可隐藏、可拖宽 ---- */
    const sideBefore = (await gridWin.webContents.executeJavaScript(`(() => {
      const s2 = document.querySelector('.gside');
      return s2 ? Math.round(s2.getBoundingClientRect().width) : 0;
    })()`)) as number;
    await gridWin.webContents.executeJavaScript(`(() => {
      const h = document.querySelector('.vsplit');
      if (!h) return;
      const r = h.getBoundingClientRect();
      const fire = (type, x, buttons) => h.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: r.top + 100, button: 0, buttons, pointerId: 81, bubbles: true, cancelable: true }));
      fire('pointerdown', r.left + 3, 1);
      fire('pointermove', r.left + 23, 1);
      fire('pointermove', r.left + 43, 1);
      fire('pointerup', r.left + 43, 0);
    })()`);
    await wait(200);
    const sideAfter = (await gridWin.webContents.executeJavaScript(`(() => {
      const s2 = document.querySelector('.gside');
      return s2 ? Math.round(s2.getBoundingClientRect().width) : 0;
    })()`)) as number;
    await gridWin.webContents.executeJavaScript(`document.querySelector('.gh .chip.icon')?.click()`);
    await wait(160);
    const sideHidden = (await gridWin.webContents.executeJavaScript(`!document.querySelector('.gside')`)) as boolean;
    await gridWin.webContents.executeJavaScript(`document.querySelector('.gh .chip.icon')?.click()`);
    await wait(160);
    check(
      '独立窗口左侧栏：可拖宽 40px、可隐藏可再打开',
      sideAfter === sideBefore + 40 && sideHidden === true,
      { sideBefore, sideAfter, sideHidden }
    );

    /* ---- 滚动范围：能滚到曲子末尾，放大后范围变大 ---- */
    const scrollMetrics = (await gridWin.webContents.executeJavaScript(`(async () => {
      const sc = document.querySelector('.scroll');
      const sp = document.querySelector('.spacer');
      if (!sc || !sp) return null;
      const read = () => ({
        clientW: sc.clientWidth,
        scrollW: sc.scrollWidth,
        spacerW: Math.round(sp.getBoundingClientRect().width),
      });
      const a = read();
      sc.scrollLeft = 9e6;
      const maxLeft = Math.round(sc.scrollLeft);
      sc.scrollLeft = 0;
      return { ...a, maxLeft };
    })()`)) as any;
    check(
      '独立窗口能滚到曲子末尾（scrollWidth 覆盖整个 spacer，能拖到底）',
      !!scrollMetrics && scrollMetrics.scrollW >= scrollMetrics.spacerW - 1 && (scrollMetrics.maxLeft || 0) > 0,
      scrollMetrics
    );
    const zoomedMetrics = (await gridWin.webContents.executeJavaScript(`(async () => {
      window.__ma.setZoom(3);
      await new Promise((r) => setTimeout(r, 260));
      const sc = document.querySelector('.scroll');
      const sp = document.querySelector('.spacer');
      const out = { scrollW: sc.scrollWidth, spacerW: Math.round(sp.getBoundingClientRect().width) };
      sc.scrollLeft = 9e6;
      out.maxLeft = Math.round(sc.scrollLeft);
      sc.scrollLeft = 0;
      window.__ma.setZoom(1);
      return out;
    })()`)) as any;
    check(
      '放大后滚动范围跟着变大（不会「越放大越滚不动」）',
      !!zoomedMetrics && zoomedMetrics.scrollW > (scrollMetrics?.scrollW ?? 0) + 100,
      { base: scrollMetrics?.scrollW, zoomed: zoomedMetrics }
    );
    check(
      '独立网格窗口的滚动条槽位常驻（不再「出现→消失」抖动）',
      String(gWinAudio?.gutter ?? '').includes('stable'),
      gWinAudio
    );

    /* ---- 画布宽度 = 滚动容器内容宽（不能压住竖滚动条） ---- */
    gridWin.unmaximize();
    await wait(200);
    gridWin.setSize(900, 620);
    await wait(450);
    const fitBox = (await gridWin.webContents.executeJavaScript(`(() => {
      const sc = document.querySelector('.scroll');
      const cv = document.querySelector('canvas');
      if (!sc || !cv) return null;
      return {
        cvW: Math.round(cv.getBoundingClientRect().width),
        contentW: sc.clientWidth - 64,
        gutter: getComputedStyle(sc).scrollbarGutter,
      };
    })()`)) as any;
    check(
      '小窗口下画布正好铺满内容区（不会盖住竖滚动条 → 滚动条能拖）',
      !!fitBox && Math.abs(fitBox.cvW - fitBox.contentW) <= 1,
      fitBox
    );

    /* ---- 跟随（翻页）：播放头跑到右缘外，弹窗视口跟着走 ---- */
    // 先暂停：播放中的跟随会立刻把 scrollTo(0) 的结果改回去（第一次跑就栽在这）
    await js(`window.__ma.pause()`);
    await wait(200);
    const followStart = (await gridWin.webContents.executeJavaScript(`(async () => {
      const ma = window.__ma;
      const sc = document.querySelector('.scroll');
      ma.scrollTo(0);
      await new Promise((r) => setTimeout(r, 180));
      // 目标：**视口坐标**接近右缘（scrollLeft 已归零，所以文档坐标 == 视口坐标）
      const targetX = sc.clientWidth - 40;
      let lo = 0;
      let hi = 400000;
      for (let i = 0; i < 44; i++) {
        const mid = Math.floor((lo + hi) / 2);
        if (ma.xOfTick(mid) < targetX) lo = mid;
        else hi = mid;
      }
      ma.seekTick(hi);
      // v0.37 起 seek 本身就会翻页（外部 seek 的余量是 96px），所以等它滚完再记基线
      await new Promise((r) => setTimeout(r, 260));
      const sl = Math.round(document.querySelector('.scroll').scrollLeft);
      return { tick: hi, before: sl, viewW: sc.clientWidth, targetX, rel: Math.round(ma.xOfTick(hi) - sl) };
    })()`)) as any;
    await js(`window.__ma.play()`);
    await wait(1000);
    const followAfter = (await gridWin.webContents.executeJavaScript(`Math.round(document.querySelector('.scroll').scrollLeft)`)) as number;
    await js(`window.__ma.pause()`);
    check(
      '独立窗口：跳到视口右缘外 → 视图自动把它捞回来（余量 96px），播放中也不回退',
      (followStart?.rel ?? -1) >= 0 &&
        (followStart?.rel ?? 0) <= (followStart?.viewW ?? 0) - 90 &&
        followAfter >= (followStart?.before ?? 0) - 4,
      { ...followStart, after: followAfter }
    );
    gridWin.maximize();
    await wait(400);

    const img = await gridWin.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-grid-window.png'), img.toPNG());
    console.log('[smoke] shots/smoke-grid-window.png');
    // 1:1 局部图：超宽屏整图缩小后看不清字，验收要看原尺寸
    const crop = await gridWin.webContents.capturePage({ x: 0, y: 0, width: 1200, height: 620 });
    fs.writeFileSync(path.join(outDir, 'smoke-grid-window-crop.png'), crop.toPNG());
  }
  // 只关网格窗口，别把用户在用的歌词播报器 / 桌面歌词一起关了
  gridWin?.close();
  await wait(300);

  /**
   * 歌词播报器 / 桌面歌词：v0.14 新增，之前一条断言都没有 ——
   * 所以「api.openLyrics is not a function」能一路绿灯交付。
   * 这里验三件事：能开、按 hash 认得出是哪个窗口、歌词/封面 IPC 通。
   */
  const lyricsOpened = await js(`window.api.win.openLyrics()`);
  await wait(1200);
  const lyricsWin = byHash('lyrics');
  check('歌词播报器可打开', lyricsOpened === true && !!lyricsWin, {
    lyricsOpened,
    found: !!lyricsWin,
  });
  // 位置：应该在主窗口旁边（右侧优先），而不是压在主窗口上
  if (lyricsWin) {
    const mb = win!.getBounds();
    const lb = lyricsWin.getBounds();
    check(
      '歌词窗口开在主窗口旁边（不重叠）',
      lb.x + lb.width <= mb.x + 2 || lb.x >= mb.x + mb.width - 2 || lb.y + lb.height <= mb.y + 2 || lb.y >= mb.y + mb.height - 2,
      { main: { x: mb.x, y: mb.y, w: mb.width, h: mb.height }, lyrics: { x: lb.x, y: lb.y, w: lb.width, h: lb.height } }
    );
  }
  if (lyricsWin) {
    // 灰ト祈リ 有 .lrc：解析必须真的出行数，否则窗口只是个空壳
    const haiId = (
      handle.db.prepare(`SELECT id FROM track WHERE title = ? AND deleted_at IS NULL`).get('灰ト祈リ') as any
    )?.id;
    let doc: any = null;
    if (haiId) doc = await js(`window.api.lyrics.resolve(${JSON.stringify(haiId)})`);
    check(
      '歌词能解析出句子（灰ト祈リ 的 .lrc）',
      !!doc && doc.found === true && Array.isArray(doc.lines) && doc.lines.length > 0,
      { trackId: haiId, found: doc?.found, how: doc?.how, lines: doc?.lines?.length, first: doc?.lines?.[0] }
    );

    /**
     * 窗口打开后必须已经知道「现在在播什么」。
     * 主窗口只在播放中每 70ms 广播，暂停时一条都不发 —— 之前只靠订阅，
     * 窗口开在暂停状态就永远停在「未在播放」，封面与歌词都不加载。
     */
    await js(`window.__app.select(${JSON.stringify(trackId)})`);
    await wait(1500);
    const st0 = await js(`window.api.player.state()`);
    const lpState: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const h = document.querySelector('.lp-title'); const im = document.querySelector('.lp-art');
         return { title: h ? h.textContent.trim() : null,
                  hasArt: !!im,
                  artSrc: im ? im.getAttribute('src') : null,
                  idle: !!document.querySelector('.lp-idle-center') }; })()`
    );
    check(
      '歌词窗口拿到了播放状态（暂停时也该有封面，不是「未在播放」）',
      !!st0?.trackId && !!lpState?.title && lpState.idle === false,
      { stateTrack: st0?.trackId, lpTitle: lpState?.title, idle: lpState?.idle }
    );
    check(
      '歌词窗口封面能显示（神鹿谣 有独立封面）',
      !!lpState?.hasArt && !!lpState?.artSrc?.startsWith('ma-art://'),
      { hasArt: lpState?.hasArt, artSrc: lpState?.artSrc }
    );

    /**
     * 播放控件：v0.14 的按钮按了没反应 —— 主窗口是唯一音频宿主，
     * 却从来没订阅 player:command。这里验完整回路：
     * 歌词窗口发指令 → 主进程转发 → 主窗口 store 执行 → 状态广播回来。
     */
    await js(`window.__app.select(${JSON.stringify(trackId)})`);
    await wait(1600);
    /** 歌词窗口自己那个播放键长什么样（字形 + 绿框），用来验两边是否同一步调 */
    const lpPlayBtn = () =>
      lyricsWin!.webContents.executeJavaScript(
        `(() => { const b = document.querySelector('.lp-transport .tp.play');
           return { text: b?.textContent.trim() ?? null, on: !!b?.classList.contains('on') }; })()`
      );
    // 从「暂停」起跑，否则下面「按一下变播放」的断言方向会反过来
    const stInit: any = await js(`window.api.player.state()`);
    if (stInit?.playing) {
      await lyricsWin.webContents.executeJavaScript(
        `document.querySelector('.lp-transport .tp.play').click()`
      );
      await wait(900);
    }
    const stBefore = await js(`window.api.player.state()`);
    // 直接从歌词窗口发，模拟真的按了它的播放键
    await lyricsWin.webContents.executeJavaScript(
      `document.querySelector('.lp-transport .tp.play').click()`
    );
    await wait(1400);
    const stAfter = await js(`window.api.player.state()`);
    check(
      '歌词窗口的播放键真的能控制主窗口（toggle 回路通）',
      !!stBefore && !!stAfter && typeof stAfter.playing === 'boolean' && stBefore.playing !== stAfter.playing,
      { beforePlaying: stBefore?.playing, afterPlaying: stAfter?.playing, track: stAfter?.trackId }
    );
    const btnPlaying: any = await lpPlayBtn();
    check(
      '播起来之后歌词窗口自己也变成 ❚❚ + 绿框',
      btnPlaying?.text === '❚❚' && btnPlaying?.on === true,
      btnPlaying
    );

    /**
     * 再按一次 = 暂停。**这就是用户报的那个 bug**：
     * 播放状态一直靠主窗口的 rAF 循环每 70ms 推一次，循环一停就再没人推，
     * 于是按了暂停之后主窗口是 ▶、歌词窗口还停在 ❚❚ + 绿框。
     * 在歌词窗口里按暂停最刺眼 —— 按的是它自己的键，它自己不知道已经停了。
     */
    await lyricsWin.webContents.executeJavaScript(
      `document.querySelector('.lp-transport .tp.play').click()`
    );
    await wait(900);
    const stPaused: any = await js(`window.api.player.state()`);
    const btnPaused: any = await lpPlayBtn();
    check(
      '在歌词窗口按暂停：主窗口停了，它自己也变回 ▶（不再停在 ❚❚ + 绿框）',
      stPaused?.playing === false && btnPaused?.text === '▶' && btnPaused?.on === false,
      { mainPlaying: stPaused?.playing, wasPlaying: btnPlaying, lyrics: btnPaused }
    );

    /**
     * 空格 = 播放/暂停。焦点在歌词窗口时同样要能用 ——
     * 这是听众最常按的一个键，而且**不该**把主窗口抬到前台（那样最烦）。
     * 走的是主进程 before-input-event → 主窗口合成事件 → TransportBar 的 onKey。
     */
    const space = () => {
      lyricsWin.webContents.focus();
      lyricsWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' } as any);
      lyricsWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' } as any);
    };
    space();
    await wait(1000);
    const stSpace: any = await js(`window.api.player.state()`);
    check(
      '焦点在歌词播报器时按空格能起播（播放键转给主窗口）',
      !!stSpace && stSpace.playing !== stPaused?.playing,
      { before: stPaused?.playing, after: stSpace?.playing }
    );
    space();
    await wait(800);
    const stSpaceBack: any = await js(`window.api.player.state()`);
    check('再按一次空格回到暂停', stSpaceBack?.playing === stPaused?.playing, {
      want: stPaused?.playing,
      got: stSpaceBack?.playing,
    });

    /**
     * 暂停状态下在主窗口拖进度条：位置也是靠 rAF 推的，循环停着就没人推，
     * 歌词窗口那条进度条和时间会一直停在拖动之前。
     */
    await js(`window.__ma.seekMs(1500)`);
    await wait(420);
    const lpPos: any = await lyricsWin.webContents.executeJavaScript(
      `(() => ({ tc: document.querySelector('.lp-transport .tc')?.textContent.trim() ?? null }))()`
    );
    check(
      '暂停时主窗口拖进度条，歌词窗口的时间跟着走',
      /^0:0[12]/.test(String(lpPos?.tc)),
      { pos: lpPos }
    );

    /**
     * 音量：只有主窗口持有 <audio>，值必须随状态推过去。
     * 以前 PlayerState 里根本没有 gain，主窗口拉完推子，歌词窗口的滑块纹丝不动。
     */
    const gainPrev = playerState.gain;
    win!.webContents.send('player:command', { type: 'gain', gain: 0.4 });
    await wait(450);
    const lpVol: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const i = document.querySelector('.lp-vol-range');
         return { pct: document.querySelector('.lp-vol-num')?.textContent.trim() ?? null,
                  val: i ? Number(i.value) : null }; })()`
    );
    check(
      '主窗口改音量，歌词窗口的滑块与百分比跟着变',
      lpVol?.pct === '40%' && lpVol?.val === 40,
      { lpVol, gainPrev }
    );
    win!.webContents.send('player:command', { type: 'gain', gain: gainPrev });
    await wait(320);

    /**
     * 主题同步：主窗口切深浅，子窗口要跟着换。
     * 之前子窗口写死深色，浅色下会是一块黑底插在白界面中间。
     */
    await js(`window.__app.setTheme('light')`);
    await wait(800);
    const lpTheme: any = await lyricsWin.webContents.executeJavaScript(
      `document.documentElement.dataset.theme`
    );
    check('歌词窗口跟随主窗口的浅色主题', lpTheme === 'light', { lpTheme });
    await wait(300);
    const lightShot = await lyricsWin.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-lyrics-light.png'), lightShot.toPNG());
    console.log('[smoke] shots/smoke-lyrics-light.png');
    await js(`window.__app.setTheme('dark')`);
    await wait(600);

    // 置于顶层：默认开，关掉再开回来，两次都要真的作用在窗口上
    const aot0 = await js(`window.api.win.getLyricsAlwaysOnTop()`);
    const aot1 = await js(`window.api.win.lyricsAlwaysOnTop(false)`);
    const flagOff = await until(() => lyricsWin.isAlwaysOnTop() === false);
    const aot2 = await js(`window.api.win.lyricsAlwaysOnTop(true)`);
    const flagOn = await until(() => lyricsWin.isAlwaysOnTop() === true);
    check(
      '歌词窗口「置于顶层」默认开启且可开关（真实作用到窗口）',
      aot0 === true && aot1 === false && flagOff && aot2 === true && flagOn,
      { aot0, aot1, flagOff, aot2, flagOn }
    );

    // 右键空白处弹出的菜单里有「置于顶层」且带勾
    await lyricsWin.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.lp-lyrics');
         const r = el.getBoundingClientRect();
         el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true,
           clientX: r.left + 40, clientY: r.top + 30 })); })()`
    );
    await wait(500);
    const menu: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const m = document.querySelector('.lp-menu');
         if (!m) return { open: false };
         const items = [...m.querySelectorAll('.lp-menu-item')].map(b => b.textContent.trim());
         const first = m.querySelector('.lp-menu-item');
         return { open: true, items, firstTicked: !!first?.textContent.includes('✓'),
                  firstText: first?.textContent.trim() }; })()`
    );
    check(
      '右键空白处弹菜单，「置于顶层」带勾',
      menu?.open === true && menu?.firstTicked === true,
      menu
    );
    await lyricsWin.webContents.executeJavaScript(
      `document.querySelector('.lp-menu-mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`
    );
    await wait(300);

    /* ---- v0.17：顶栏 / 控件顺序 / 原始时间戳 / 音量 / 封面开关 ---- */
    // 顶栏只留一个关闭按钮；置顶挪到了底部控件栏（且是图钉）
    const barUi: any = await lyricsWin.webContents.executeJavaScript(
      `(() => {
         const head = document.querySelector('.lp-header');
         const headBtns = head ? [...head.querySelectorAll('button')] : [];
         const transport = document.querySelector('.lp-transport');
         const tp = transport ? [...transport.querySelectorAll('.tp')] : [];
         return {
           headBtnCount: headBtns.length,
           headBtnText: headBtns.map(b => b.textContent.trim() || b.className),
           hasMark: !!head?.querySelector('svg.mark'),
           tpOrder: tp.map(b => b.className.includes('play') ? 'play' : (b.title || b.className)),
           hasPin: !!transport?.querySelector('.lp-pin'),
           hasVol: !!transport?.querySelector('.lp-vol-range'),
           volVal: transport?.querySelector('.lp-vol-range')?.value ?? null,
           volNum: transport?.querySelector('.lp-vol-num')?.textContent?.trim() ?? null,
         };
       })()`
    );
    check(
      '歌词窗口顶栏不画自己的关闭按钮（系统三个按钮叠在原地），只留项目标记',
      barUi?.headBtnCount === 0 && barUi?.hasMark === true,
      barUi
    );
    check(
      '播放控件顺序照主界面：播放 / 暂停在前、回到开头在后；置顶改成图钉并挪到控件栏',
      barUi?.tpOrder?.[0] === 'play' &&
        String(barUi?.tpOrder?.[1]).includes('回到开头') &&
        barUi?.hasPin === true,
      barUi?.tpOrder
    );
    check('音量滑块存在且按百分比显示', barUi?.hasVol === true && /^\d+%$/.test(String(barUi?.volNum)), {
      volVal: barUi?.volVal, volNum: barUi?.volNum,
    });

    /* ---- 与主窗口统一：去掉原生标题栏 / 跟随缩放 / 按钮同一套字符 ---- */
    /**
     * 有原生标题栏时 contentBounds 会比 bounds 矮一整条（Windows 上 31~39px），
     * 那一条就是「最上面那个黑黑的」。改成 titleBarStyle:'hidden' 之后内容区 = 整个窗口。
     */
    const wb = lyricsWin.getBounds();
    const wc = lyricsWin.getContentBounds();
    const hdrUi: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const h = document.querySelector('.lp-header');
         const r = h.getBoundingClientRect();
         return { top: r.top, h: Math.round(r.height), w: Math.round(r.width), winW: window.innerWidth }; })()`
    );
    check(
      '歌词窗口没有原生标题栏：内容区高度 == 窗口高度，自绘顶栏贴着顶边通栏',
      wb.height - wc.height <= 2 &&
        wb.width - wc.width <= 2 &&
        hdrUi?.top === 0 &&
        hdrUi?.h === 26 &&
        Math.abs(hdrUi?.w - hdrUi?.winW) <= 2,
      { win: { w: wb.width, h: wb.height }, content: { w: wc.width, h: wc.height }, hdrUi }
    );

    /**
     * ⏸ / ⏮ 这类字符在 Windows 上会被 Segoe UI Emoji 接走，画成蓝色的系统表情方块 ——
     * 所以断言「只许出现 ▶ / ❚❚ / ■」，并且尺寸和主窗口的 .tp 一样。
     * 只看截图的话，蓝色方块和绿描边几乎一样大，看不出是两套东西。
     */
    const lpTp: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const bs = [...document.querySelectorAll('.lp-transport .tp')].slice(0, 2);
         const r = bs[0]?.getBoundingClientRect();
         return { texts: bs.map((b) => b.textContent.trim()),
                  box: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null }; })()`
    );
    const mainTp: any = await js(
      `(() => { const bs = [...document.querySelectorAll('.transport .tp')].slice(0, 2);
         const r = bs[0]?.getBoundingClientRect();
         return { texts: bs.map((b) => b.textContent.trim()),
                  box: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null }; })()`
    );
    const okGlyph = (t: string) => t === '▶' || t === '❚❚' || t === '■' || t === '|◀';
    check(
      '歌词窗口播放按钮与主窗口同一套字符、同一尺寸（不再画蓝色表情方块）',
      lpTp?.texts?.length === 2 &&
        lpTp.texts.every(okGlyph) &&
        (mainTp?.texts ?? []).every(okGlyph) &&
        lpTp.box?.w === mainTp?.box?.w &&
        lpTp.box?.h === mainTp?.box?.h,
      { lyrics: lpTp, main: mainTp }
    );

    const zPrev = win!.webContents.getZoomFactor();
    await js(`window.api.ui.setZoom(1.25)`);
    await wait(260);
    const lz: number = lyricsWin.webContents.getZoomFactor();
    await js(`window.api.ui.setZoom(${zPrev})`);
    await wait(240);
    check(
      '歌词窗口跟随主窗口缩放（1.25 同步、还原也同步）',
      Math.abs(lz - 1.25) < 0.01 && Math.abs(lyricsWin.webContents.getZoomFactor() - zPrev) < 0.01,
      { lz, back: lyricsWin.webContents.getZoomFactor(), zPrev }
    );

    // 时间戳用 LRC 原本的写法 [00:14.671]
    const hai2 = handle.db
      .prepare(`SELECT id FROM track WHERE title = ? AND deleted_at IS NULL`)
      .get('灰ト祈リ') as any;
    await js(`window.__app.select(${JSON.stringify(hai2.id)})`);
    await wait(1600);
    const stampUi: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.lp-scroll .l-ts');
         return { text: el?.textContent?.trim() ?? null,
                  count: document.querySelectorAll('.lp-scroll .l-ts').length }; })()`
    );
    check(
      '时间戳显示 LRC 原本的格式 [mm:ss.xxx]',
      !!stampUi?.text && /^\[\d{2}:\d{2}\.\d{3}\]$/.test(stampUi.text),
      stampUi
    );

    // 封面开关：关掉之后左侧整栏消失，歌词铺满
    const coverToggle: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const before = !!document.querySelector('.lp-cover');
         const b = [...document.querySelectorAll('.lp-toolbar .chip')]
           .find(x => x.textContent.trim() === '显示封面');
         if (!b) return { found: false, before };
         b.click();
         return { found: true, before }; })()`
    );
    await wait(400);
    const coverAfter = await lyricsWin.webContents.executeJavaScript(
      `(() => ({ has: !!document.querySelector('.lp-cover'),
                 noCoverClass: !!document.querySelector('.lp-body.no-cover') }))()`
    );
    check(
      '封面显示可开关，关掉后左侧栏消失',
      coverToggle?.found === true && coverToggle.before === true &&
        coverAfter?.has === false && coverAfter?.noCoverClass === true,
      { coverToggle, coverAfter }
    );
    // 还原
    await lyricsWin.webContents.executeJavaScript(
      `[...document.querySelectorAll('.lp-toolbar .chip')].find(x => x.textContent.trim() === '显示封面')?.click()`
    );
    await wait(300);

    // 双击歌词 → 进编辑框（写回文件要走手动指定的歌词，自动匹配的那份是只读的）
    const editUi: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('.lp-scroll .l-text');
         if (!el) return { found: false };
         el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
         return { found: true }; })()`
    );
    await wait(300);
    const editBox: any = await lyricsWin.webContents.executeJavaScript(
      `(() => { const i = document.querySelector('.lp-scroll .l-edit');
         return { open: !!i, cls: i?.className ?? null }; })()`
    );
    check('双击歌词文字能进编辑态', editUi?.found === true && editBox?.open === true, { editUi, editBox });

    /**
     * ---- 焦点在歌词播报器时，快捷键必须照样生效 ----
     *
     * 主窗口的 keydown 监听挂在它自己的渲染进程上，别的窗口的按键根本到不了
     * ——「Ctrl+R 在歌词窗口里没反应」就是这么来的。现在由主进程
     * `before-input-event` 截下再转给主窗口。
     *
     * 测法：必须用 `sendInputEvent`（走浏览器输入管线，会真的触发 before-input-event）。
     * 从渲染层 `dispatchEvent(new KeyboardEvent(...))` 到歌词窗口是**测不到**的 ——
     * 那绕过了输入管线，等于自己给自己发奖状。
     */
    const panelShown = () =>
      js(`(() => { const d = document.querySelector('.dock'); return !!d && getComputedStyle(d).display !== 'none'; })()`);
    const lpKey = (keyCode: string, modifiers: string[] = []) => {
      lyricsWin.webContents.focus();
      lyricsWin.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers } as any);
      lyricsWin.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers } as any);
    };

    // 1) 进编辑态后光标必须真的在输入框里 —— 拿不到焦点的话「让路」无从谈起，
    //    用户也会觉得「双击没反应」（这一条曾经真的不成立：v-for 里的字符串 ref 是数组）
    const editFocus: any = await lyricsWin.webContents.executeJavaScript(
      `(() => ({ tag: document.activeElement?.tagName ?? null, cls: String(document.activeElement?.className ?? '') }))()`
    );
    check('双击进编辑态后光标落在输入框里', editFocus.tag === 'INPUT' && editFocus.cls.includes('l-edit'), editFocus);

    /**
     * 等「主进程也知道它在输入」再发键。
     *
     * `editingWcIds` 是靠渲染层 `hotkeyshield` 发 `hotkey:editing` 维护的：正常窗口里
     * focusin 一到就发；但冒烟窗口是 `opacity=0`（看不见），**focus 事件不一定派发**，
     * 只剩那 1s 的兜底轮询。测试原来固定 `wait(600)` 就发键，撞上「标志还没到」时
     * 快捷键让路失效 → 真的登记了一首作品（这条就是这么红的，不是功能坏了）。
     * 等状态而不是等时间：可见窗口下瞬间返回，不可见时最多补等一轮轮询。
     */
    await until(() => editingWcIds.has(lyricsWin!.webContents.id), 2500);

    // 2) 正在编辑：按键留给输入框，不能被主窗口抢走
    const beforeShield = await js(`window.api.tracks.list({}).then((r) => r.length)`);
    lpKey('R', ['control']);
    await wait(600);
    const afterShield = await js(`window.api.tracks.list({}).then((r) => r.length)`);
    check(
      '歌词窗口正在输入时快捷键让路（不抢输入框的键）',
      afterShield === beforeShield,
      { before: beforeShield, after: afterShield }
    );
    // 万一让路失效（真被登记了），也得把它清掉 —— 冒烟不许往用户曲库里丢东西
    if (afterShield > beforeShield) {
      const stray = await js(`window.__app.editingId()`);
      if (stray) {
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await js(`window.api.tracks.remove(${JSON.stringify(stray)})`);
        await js(`window.__app.purgeArchived(${JSON.stringify(stray)})`);
        await js(`window.__app.refresh()`);
        await wait(300);
      }
    }

    // Esc 取消编辑，不写文件
    await lyricsWin.webContents.executeJavaScript(
      `document.querySelector('.lp-scroll .l-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    // 同理：等「主进程确认已经退出编辑」，否则按键还会被当成「正在输入」让路
    await until(() => !editingWcIds.has(lyricsWin!.webContents.id), 2500);

    // 3) 退出编辑后：Ctrl+J 开关详情面板（无副作用，最能说明按键真的转过去了）
    const panel0 = await panelShown();
    lpKey('J', ['control']);
    await wait(420);
    const panel1 = await panelShown();
    check(
      '焦点在歌词播报器时 Ctrl+J 仍能开关详情面板（按键已转发到主窗口）',
      panel1 === !panel0,
      { before: panel0, after: panel1 }
    );
    // 还原用显式的 force，不靠「再按一次碰运气」—— 面板状态会写进 localStorage，
    // 留成关的会让后面依赖网格尺寸的断言整片倒掉。
    await js(`window.__app.panel(${panel0})`);
    await wait(320);
    const panel2 = await panelShown();
    check('快捷键测试后面板状态已还原', panel2 === panel0, { want: panel0, got: panel2 });

    // 4) 用户报的那一条：Ctrl+R 登记作品
    const beforeReg = await js(`window.api.tracks.list({}).then((r) => r.length)`);
    lpKey('R', ['control']);
    await wait(700);
    const afterReg = await js(`window.api.tracks.list({}).then((r) => r.length)`);
    const regId = await js(`window.__app.editingId()`);
    check(
      '焦点在歌词播报器时 Ctrl+R 仍能登记作品',
      afterReg === beforeReg + 1 && !!regId,
      { before: beforeReg, after: afterReg, editing: regId }
    );
    // 冒烟自己登记的空曲目不能留在用户曲库里：退出编辑 → 软删 → 彻底删（连 JSON）
    if (regId) {
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await js(`window.api.tracks.remove(${JSON.stringify(regId)})`);
      await js(`window.__app.purgeArchived(${JSON.stringify(regId)})`);
      await js(`window.__app.refresh()`);
      await wait(300);
      const left = rows(`SELECT COUNT(*) c FROM track WHERE id = ?`, regId)[0]?.c ?? 0;
      check('歌词窗口快捷键登记的临时曲目已清干净（库行与 JSON 都不留）', left === 0, { regId, left });
    }

    await wait(400);
    const img = await lyricsWin.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-lyrics-window.png'), img.toPNG());
    console.log('[smoke] shots/smoke-lyrics-window.png');
  }

  // 桌面歌词浮窗：无边框透明窗，只能靠 setPosition 移动，顺带验这条 IPC 真的在
  const overlayOpened = await js(`window.api.win.openOverlay()`);
  await wait(1000);
  const overlayWin2 = byHash('overlay');
  let moved = null;
  if (overlayWin2) {
    const p0 = overlayWin2.getPosition();
    await js(`window.api.win.moveOverlay(40, 25)`);
    await wait(400);
    const p1 = overlayWin2.getPosition();
    moved = { dx: p1[0] - p0[0], dy: p1[1] - p0[1] };
  }
  check(
    '桌面歌词浮窗可打开且能拖动',
    overlayOpened === true && !!overlayWin2 && moved?.dx === 40 && moved?.dy === 25,
    { overlayOpened, found: !!overlayWin2, moved }
  );
  if (overlayWin2) {
    await wait(300);
    const img = await overlayWin2.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-overlay-window.png'), img.toPNG());
    console.log('[smoke] shots/smoke-overlay-window.png');
  }
  // 收尾：把冒烟开的歌词 / 浮窗都关掉，别留在用户桌面上
  await js(`window.api.win.closeLyrics()`);
  await js(`window.api.win.closeOverlay()`);
  await wait(400);

  // 还原：冒烟不该把演示和弦留在库里
  analysisIpc.replaceEvents({ db: handle.db }, analysisId, before);
  const restored = rows(`SELECT COUNT(*) c FROM analysis_event WHERE analysis_id = ?`, analysisId)[0].c;
  check('冒烟后事件已还原', restored === before.length, { before: before.length, after: restored });

  // ---- 详情面板双击编辑：真实双击 → 输入 → Enter → 查库 ----
  // 先用有内容的神鹿谣截一张编辑态图：空曲目看不出输入框与已有值的关系
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await wait(320);
  await js(
    `document.querySelector('.detail .d-head h2 .title-text')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  );
  await wait(140);
  await shot('smoke-detail-edit.png');
  await js(
    `document.querySelector('.detail .edit-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  );
  await wait(140);
  const restoredTitle = await js(`document.querySelector('.detail .d-head h2 .title-text')?.textContent?.trim()`);
  check('Esc 取消编辑：曲名保持原样', restoredTitle === '神鹿谣', restoredTitle);

  // 再用一条临时曲目逐字段改；结束后物理删干净，不碰演示数据
  const tmp = (await js(`window.api.tracks.create({ title: 'smoke-edit' })`)) as any;
  await js(`window.__app.select(${JSON.stringify(tmp.id)})`);
  await wait(320);

  /** 双击 → 等编辑框出现 → 写值 → 回车（走的是和用户完全一样的路径） */
  const editAt = async (selector: string, value: string) => {
    // 把「点的那一块」记在 window 上，后面只在这块里找输入框 ——
    // 原来用「.detail 下有没有任意 .edit-input」判定，上一个字段没收干净就会假通过。
    await js(
      `(() => {
         const el = document.querySelector(${JSON.stringify(selector)});
         if (!el) return;
         window.__editHost = el.closest('.d-row, .d-album, .d-album-no') ?? el.parentElement ?? document.body;
         el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
       })()`
    );
    await wait(70);
    const opened = await js(`!!window.__editHost?.querySelector('.edit-input')`);
    await js(`(() => {
      const i = window.__editHost?.querySelector('.edit-input');
      if (!i) return;
      i.value = ${JSON.stringify(value)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await wait(320);
    return opened;
  };

  const titleOpened = await editAt('.detail .d-head h2 .title-text', 'smoke-edit-2');
  await editAt('.detail .subtitle .editable', 'TV size');

  /**
   * 情绪补全：词表里挑，不再手打英文枚举。
   * 键盘语义：**采纳会改变文本时**第一次 Enter 只采纳、再 Enter 保存；
   * 采纳后文本没变（敲的就是候选本身）则那一次 Enter 直接落库（见 shared/suggest.js 的 pickMode）。
   * 「悲」是前缀命中，采纳会变成「悲壮」→ 所以这里仍然是分两次按。
   */
  await js(
    `document.querySelector('.detail .moods')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  );
  await wait(80);
  await js(`(() => {
    const i = document.querySelector('.detail .moods .edit-input');
    if (!i) return;
    i.value = '悲';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(340);
  const moodSug = await js(`(() => ({
    open: !!document.querySelector('.detail .field-sug'),
    items: [...document.querySelectorAll('.detail .field-sug li span')].map((s) => s.textContent.trim()),
    active: document.querySelector('.detail .field-sug li.on span')?.textContent?.trim() ?? null,
  }))()`);
  // 版式实拍：编辑框 + 词表下拉同时在场，比断言更容易看出挤不挤
  await shot('smoke-detail-suggest.png');
  await js(`(() => {
    const i = document.querySelector('.detail .moods .edit-input');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  })()`);
  await wait(60);
  const moodSugDown = await js(
    `document.querySelector('.detail .field-sug li.on span')?.textContent?.trim() ?? null`
  );
  await js(`(() => {
    const i = document.querySelector('.detail .moods .edit-input');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(200);
  const moodAdopted = await js(`(() => ({
    value: document.querySelector('.detail .moods .edit-input')?.value ?? null,
    stillEditing: !!document.querySelector('.detail .moods .edit-input'),
    open: !!document.querySelector('.detail .field-sug'),
  }))()`);
  await js(`(() => {
    const i = document.querySelector('.detail .moods .edit-input');
    i?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(340);
  const sugMoods = ((await js(`window.api.tracks.get(${JSON.stringify(tmp.id)})`)) as any)?.moods ?? [];
  check(
    '情绪补全：按词表出候选 → ↓ 换行 → Enter 采纳（不保存）→ 再 Enter 才落库',
    moodSug.open === true &&
      moodSug.items.includes('悲伤') &&
      moodSug.items.includes('悲壮') &&
      moodSug.active === '悲伤' &&
      moodSugDown === '悲壮' &&
      moodAdopted.value === '悲壮' &&
      moodAdopted.stillEditing === true &&
      JSON.stringify(sugMoods) === JSON.stringify(['tragic']),
    { moodSug, moodSugDown, moodAdopted, sugMoods }
  );

  /**
   * 用户报的那个 bug：「打神秘没法输入神秘」。
   *
   * 原因不是「已经打全了所以不补全」，而是渲染层把「与输入完全一样」的候选筛掉了，
   * 下拉里剩下的全是编辑距离≤2 的近似项（悲伤 / 忧郁…），默认高亮第一条，
   * 一按回车就把「神秘」换成了别的情绪。
   * 现在：完全匹配项必须留在第一条并默认高亮，且**一次**回车就落库。
   */
  await js(
    `document.querySelector('.detail .moods')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  );
  await wait(90);
  await js(`(() => {
    const i = document.querySelector('.detail .moods .edit-input');
    if (!i) return;
    i.value = '神秘';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(360);
  const exactSug = await js(`(() => ({
    open: !!document.querySelector('.detail .field-sug'),
    first: document.querySelector('.detail .field-sug li span')?.textContent?.trim() ?? null,
    active: document.querySelector('.detail .field-sug li.on span')?.textContent?.trim() ?? null,
    how: document.querySelector('.detail .field-sug li em')?.textContent?.trim() ?? '',
  }))()`);
  await js(`(() => {
    const i = document.querySelector('.detail .moods .edit-input');
    i?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(360);
  const exactMoods = ((await js(`window.api.tracks.get(${JSON.stringify(tmp.id)})`)) as any)?.moods ?? [];
  check(
    '输入「神秘」：完全匹配项留在第一条并默认高亮，一次回车落库 mysterious',
    exactSug.open === true &&
      exactSug.first === '神秘' &&
      exactSug.active === '神秘' &&
      exactSug.how === '完全匹配' &&
      JSON.stringify(exactMoods) === JSON.stringify(['mysterious']) &&
      !(await js(`!!document.querySelector('.detail .moods .edit-input')`)),
    { exactSug, exactMoods }
  );

  await editAt('.detail .d-period .editable', '浪漫');
  // 流派：输入中文「影视配乐」，落库的是词条 name（OST —— 流派存 name，不是 id）
  await editAt('.detail .d-genre .editable', '影视配乐');
  // 体裁 / 曲式：与流派相反，落库的是词条 **id**（symphony / sonata）。
  // 存 id 才能让显示名跟界面语言变，也免得中文译名一改就对不上历史档案。
  await editAt('.detail [data-field="compositionType"] .editable', '交响曲');
  await editAt('.detail [data-field="form"] .editable', '奏鸣曲式');
  await editAt('.detail .alias-line .editable', 'alias-a / alias-b');
  await editAt('.detail .moods', '怀旧, 神秘');
  await editAt('.detail .meter-val', '3/4');
  await editAt('.detail .bpm-val', '96');
  await editAt('.detail .keys', 'c major → f minor');

  // 编制摘要与「拍号/速度」同为 .d-row，按标签找，不靠行序
  const abstractOpened = await js(`(() => {
    const row = [...document.querySelectorAll('.detail .d-row')]
      .find((r) => (r.querySelector('.k')?.textContent ?? '').includes('乐器组合摘要'));
    const el = row?.querySelector('.editable');
    el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return !!el;
  })()`);
  await wait(70);
  await js(`(() => {
    const i = document.querySelector('.detail .edit-input');
    if (!i) return;
    i.value = 'Chamber orchestra';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(320);
  // 本条曲目没有制作名单：占位行也要能双击录入
  await editAt('.detail .credit.v', 'Test Composer');

  const edited = (await js(`window.api.tracks.get(${JSON.stringify(tmp.id)})`)) as any;
  check(
    '双击详情字段可编辑：标题/附注/时期/流派/体裁/曲式/别名/情绪/拍号/速度/调性/摘要/制作名单全部落库',
    titleOpened === true &&
      abstractOpened === true &&
      edited?.title === 'smoke-edit-2' &&
      edited?.subtitle === 'TV size' &&
      edited?.period === 'romantic' &&
      edited?.genre === 'OST' &&
      edited?.compositionType === 'symphony' &&
      edited?.form === 'sonata-form' &&
      JSON.stringify(edited?.aliases) === JSON.stringify(['alias-a', 'alias-b']) &&
      JSON.stringify(edited?.moods) === JSON.stringify(['nostalgic', 'mysterious']) &&
      edited?.meter === '3/4' &&
      edited?.bpm === 96 &&
      JSON.stringify(edited?.keys) === JSON.stringify(['c major', 'f minor']) &&
      edited?.instrumentationAbstract === 'Chamber orchestra' &&
      edited?.credits?.composer === 'Test Composer',
    {
      titleOpened,
      abstractOpened,
      title: edited?.title,
      subtitle: edited?.subtitle,
      period: edited?.period,
      genre: edited?.genre,
      compositionType: edited?.compositionType,
      form: edited?.form,
      aliases: edited?.aliases,
      moods: edited?.moods,
      meter: edited?.meter,
      bpm: edited?.bpm,
      keys: edited?.keys,
      abstract: edited?.instrumentationAbstract,
      credits: edited?.credits,
    }
  );

  /* ---- 专辑：中文输入法确认候选的 Enter 不能当成「提交」 ----
     这条之前一次都没测过，结果「打完字回车存不上」一直没人发现。 */
  const albumOpened = await editAt('.detail .d-album .editable', '测试专辑·第一章');
  const albumDb = rows(`SELECT album FROM track WHERE id = ?`, tmp.id)[0]?.album;
  check('专辑回车能落库', albumOpened === true && albumDb === '测试专辑·第一章', { albumOpened, albumDb });

  await js(
    `document.querySelector('.detail .d-album .editable')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  );
  await wait(90);
  await js(`(() => {
    const i = document.querySelector('.detail .d-album .edit-input');
    if (!i) return;
    i.value = '组合中的草稿';
    i.dispatchEvent(new Event('compositionstart'));
    i.dispatchEvent(new Event('input', { bubbles: true }));
    // 这一下是「确认候选词」，不是提交
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
  })()`);
  await wait(240);
  const imeState = await js(`(() => ({
    editing: !!document.querySelector('.detail .d-album .edit-input'),
    value: document.querySelector('.detail .d-album .edit-input')?.value ?? null,
  }))()`);
  const albumAfterIme = rows(`SELECT album FROM track WHERE id = ?`, tmp.id)[0]?.album;
  check(
    '输入法确认候选的 Enter 不提交（不会把组合前的旧值存进去）',
    imeState.editing === true && albumAfterIme === '测试专辑·第一章',
    { imeState, albumAfterIme }
  );

  await js(`(() => {
    const i = document.querySelector('.detail .d-album .edit-input');
    if (!i) return;
    i.dispatchEvent(new Event('compositionend'));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(340);
  const albumAfterCommit = rows(`SELECT album FROM track WHERE id = ?`, tmp.id)[0]?.album;
  check('组合结束后的 Enter 正常提交中文专辑名', albumAfterCommit === '组合中的草稿', { albumAfterCommit });

  await editAt('.detail .d-album .editable', '');
  const albumCleared = rows(`SELECT album FROM track WHERE id = ?`, tmp.id)[0]?.album;
  check('专辑可以清空（存 NULL，不是空字符串）', albumCleared === null, { albumCleared });

  // 拍号/速度不只是显示改了：网格的换算锚（tick 0 的 marker）必须一起动
  const meterMark = rows(
    `SELECT label, num, den FROM analysis_marker WHERE analysis_id = ? AND kind = 'meter' AND tick = 0`,
    tmp.analysisId
  )[0];
  const tempoMark = rows(
    `SELECT bpm FROM analysis_marker WHERE analysis_id = ? AND kind = 'tempo' AND tick = 0`,
    tmp.analysisId
  )[0];
  check(
    '改拍号/速度会同步 tick 0 的 marker（网格不会和详情对不上）',
    meterMark?.label === '3/4' && meterMark?.num === 3 && meterMark?.den === 4 && tempoMark?.bpm === 96,
    { meterMark, tempoMark }
  );

  /* ---- 标题模板：数据字段 → 展开后的标题（详情 + 列表） ---- */
  await editAt('.detail [data-field="formNumber"] .editable', 'No.1');
  await editAt('.detail [data-field="opusNumber"] .editable', 'Op.2, No.1');
  await editAt('.detail [data-field="compositionType"] .editable', 'Piano Sonata');
  await editAt('.detail .credit.v', 'Beethoven');
  await editAt('.detail .keys', 'F Minor');
  const tplRaw = '%Composer} - %form} %Number of the form} in %Key}, %Opus Number}';
  await editAt('.detail .d-head h2 .title-text', tplRaw);
  const tplView = (await js(`(() => {
    const row = [...document.querySelectorAll('.row')]
      .find((r) => r.getAttribute('data-track-id') === ${JSON.stringify(tmp.id)});
    return {
      detail: document.querySelector('.detail .d-head h2 .title-text')?.textContent?.trim() ?? null,
      list: row?.querySelector('.t')?.textContent?.trim() ?? null,
    };
  })()`)) as any;
  check(
    '标题模板：作曲家 / 体裁 / 作品编号 / 调性 / 作品号按字段展开（详情与列表同一份）',
    tplView?.detail === 'Beethoven - Piano Sonata No.1 in F Minor, Op.2, No.1' &&
      tplView?.list === tplView.detail,
    tplView
  );

  /* 标题输入里的预设补全：敲预设名（不用敲模板）→ 候选 → Enter 填入整段 */
  await js(`document.querySelector('.detail .d-head h2 .title-text')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await wait(80);
  await js(`(() => {
    const i = document.querySelector('.detail .d-head h2 .edit-input.title');
    if (!i) return;
    i.value = 'for_Classical_Opus';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(320);
  const tplSug = (await js(`(() => ({
    open: !!document.querySelector('.title-sug'),
    names: [...document.querySelectorAll('.title-sug .sug-name')].map((x) => x.textContent.trim()),
    active: document.querySelector('.title-sug li.on .sug-name')?.textContent?.trim() ?? null,
  }))()`)) as any;
  await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await wait(100);
  const tplActive = await js(`document.querySelector('.title-sug li.on .sug-name')?.textContent?.trim() ?? null`);
  await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(140);
  const tplFilled = await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.value ?? null`);
  await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(340);
  const tplDb = rows(`SELECT title FROM track WHERE id = ?`, tmp.id)[0]?.title;
  check(
    '标题输入里补全预设名：候选出现（不默认高亮）→ ↓ 选中 → Enter 填入整个模板（不直接提交）→ 再 Enter 落库',
    tplSug.open === true &&
      tplSug.names.includes('for_Classical_Opus') &&
      tplSug.active === null &&
      tplActive === 'for_Classical_Opus' &&
      tplFilled === tplRaw &&
      tplDb === tplRaw,
    { ...tplSug, tplActive, tplFilled, tplDb }
  );

  /* 详情标题里的**变量**补全：打 `%c` 就够，插在光标处，不动前面的字 */
  await js(`document.querySelector('.detail .d-head h2 .title-text')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await wait(90);
  await js(`(() => {
    const i = document.querySelector('.detail .d-head h2 .edit-input.title');
    if (!i) return;
    i.value = '贝多芬 %c';
    i.setSelectionRange(i.value.length, i.value.length);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(280);
  const varSug = (await js(`(() => ({
    names: [...document.querySelectorAll('.title-sug .sug-name')].map((x) => x.textContent.trim()),
    active: document.querySelector('.title-sug li.on .sug-name')?.textContent?.trim() ?? null,
  }))()`)) as any;
  await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await wait(90);
  const varActive = await js(`document.querySelector('.title-sug li.on .sug-name')?.textContent?.trim() ?? null`);
  await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(140);
  const varFilled = await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.value ?? null`);
  await js(`document.querySelector('.detail .d-head h2 .edit-input.title')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(140);
  const titleAfterVar = rows(`SELECT title FROM track WHERE id = ?`, tmp.id)[0]?.title;
  check(
    '详情标题补全模板变量：打「%c」→ %Composer} 插在光标处（前面的字不动）→ ↓ 选中 → Enter 采纳 → Esc 不落库',
    varSug?.names?.includes('%Composer}') &&
      varSug.active === null &&
      varActive === '%Composer}' &&
      varFilled === '贝多芬 %Composer}' &&
      titleAfterVar === tplRaw,
    { ...varSug, varActive, varFilled, titleAfterVar }
  );

  /*
   * 列表里的曲目行改名也要出候选：候选列表是**全表共用一份**。
   * 早先它写在乐章行的 `v-if` 里，于是只有乐章能补全，曲目行（最常用的路径）
   * 敲预设名什么都不弹 —— 2026-11-23 用户报成「模板编辑器的补全挂掉了」。
   */
  await js(`window.__app.rename(${JSON.stringify(tmp.id)})`);
  await wait(240);
  await js(`(() => {
    const i = document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit');
    if (!i) return;
    i.value = 'for_Classical_Opus';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(340);
  const listSug = (await js(`(() => {
    const ul = document.querySelector('.mov-sug');
    const r = ul?.getBoundingClientRect();
    return {
      open: !!ul,
      names: [...(ul?.querySelectorAll('.ms-name') ?? [])].map((x) => x.textContent.trim()),
      // 下拉是 fixed 的：跑出视口就等于看不见，位置类断言必须量矩形（RULES 第 33 条）
      inside: !!r && r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0,
      presetFont: ul?.querySelector('.ms-preset') ? getComputedStyle(ul.querySelector('.ms-preset')).fontFamily : null,
    };
  })()`)) as any;
  await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await wait(120);
  const listSugActive = await js(`document.querySelector('.mov-sug li.on .ms-name')?.textContent?.trim() ?? null`);
  await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(160);
  const listSugFilled = await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.value ?? null`);
  await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(160);
  const listTitleAfter = rows(`SELECT title FROM track WHERE id = ?`, tmp.id)[0]?.title;
  check(
    '列表曲目行改名也补全预设名（候选全表一份）→ ↓ 选中 → Enter 填整段模板，Esc 不落库',
    listSug?.open === true &&
      listSug.names?.includes('for_Classical_Opus') &&
      listSug.inside === true &&
      listSugActive === 'for_Classical_Opus' &&
      listSugFilled === tplRaw &&
      listTitleAfter === tplRaw,
    { ...listSug, listSugActive, listSugFilled, listTitleAfter }
  );

  /* 列表行内改名同样认变量：打 `c`（不带 %）也要出 %Composer} */
  await js(`window.__app.rename(${JSON.stringify(tmp.id)})`);
  await wait(220);
  await js(`(() => {
    const i = document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit');
    if (!i) return;
    i.value = 'c';
    i.setSelectionRange(1, 1);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(300);
  const listVarSug = (await js(`(() => ({
    names: [...document.querySelectorAll('.mov-sug .ms-name')].map((x) => x.textContent.trim()),
    kind: document.querySelector('.mov-sug .ms-kind')?.textContent?.trim() ?? null,
  }))()`)) as any;
  await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await wait(90);
  const listVarActive = await js(`document.querySelector('.mov-sug li.on .ms-name')?.textContent?.trim() ?? null`);
  await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(150);
  const listVarFilled = await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.value ?? null`);
  await js(`document.querySelector('.row[data-track-id="${tmp.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(150);
  check(
    '列表行内改名补全模板变量：打「c」→ 候选 %Composer}（标着「变量」）→ ↓ 选中 → Enter 插入',
    listVarSug?.names?.includes('%Composer}') &&
      listVarSug.kind === '变量' &&
      listVarActive === '%Composer}' &&
      listVarFilled === '%Composer}',
    { ...listVarSug, listVarActive, listVarFilled }
  );

  /* N/A = 不适用（中文界面）；档案里保留 N/A 原值 */
  await editAt('.detail [data-field="opusNumber"] .editable', 'N/A');
  const opusShown = await js(`document.querySelector('.detail [data-field="opusNumber"] .editable')?.textContent?.trim() ?? null`);
  check('作品号填 N/A：中文界面显示「不适用」，档案仍存 N/A', opusShown === '不适用', { opusShown });

  /* 连续空格：input 里本来就能打，问题只在展示层被 HTML 折叠 */
  await editAt('.detail .d-head h2 .title-text', '甲  乙');
  const spaceView = (await js(`(() => {
    const row = [...document.querySelectorAll('.row')]
      .find((r) => r.getAttribute('data-track-id') === ${JSON.stringify(tmp.id)});
    const detailEl = document.querySelector('.detail .d-head h2 .title-text');
    const listEl = row?.querySelector('.c-title .t');
    return {
      detail: detailEl?.textContent ?? null,
      detailWs: detailEl ? getComputedStyle(detailEl).whiteSpace : null,
      list: listEl?.textContent ?? null,
      listWs: listEl ? getComputedStyle(listEl).whiteSpace : null,
    };
  })()`)) as any;
  const spaceDb = rows(`SELECT title FROM track WHERE id = ?`, tmp.id)[0]?.title;
  check(
    '标题里的连续空格原样保存 / 显示（white-space: pre，不折叠也不写字符实体）',
    spaceView?.detail === '甲  乙' &&
      spaceView?.list === '甲  乙' &&
      spaceView?.detailWs === 'pre' &&
      spaceView?.listWs === 'pre' &&
      spaceDb === '甲  乙',
    { ...spaceView, spaceDb }
  );

  /* 乐章：序号由位置推出；Sub-Type 为空时整段省略，不能留下「第二乐章  - 柔板」 */
  const movA = (await js(
    `window.api.tracks.create({ title: '%Movement Number} %Sub-Type} - %Tempo Term}', parentId: ${JSON.stringify(tmp.id)} })`
  )) as any;
  const movB = (await js(
    `window.api.tracks.create({ title: '%Movement Number} %Sub-Type} - %Tempo Term}', parentId: ${JSON.stringify(tmp.id)} })`
  )) as any;
  await js(`window.api.tracks.update(${JSON.stringify(movA.id)}, { subType: 'menuett', tempoTerm: '小快板' })`);
  await js(`window.api.tracks.update(${JSON.stringify(movB.id)}, { tempoTerm: '柔板' })`);
  await js(`window.__app.reloadRows()`);
  await wait(340);
  const movTitles = (await js(`(() => {
    const ids = ${JSON.stringify([movA.id, movB.id])};
    return ids.map((id) => document.querySelector('.mov-row[data-track-id="' + id + '"] .mov-title')?.textContent?.trim() ?? null);
  })()`)) as any;
  const movDb = rows(
    `SELECT title, extra FROM track WHERE id IN (?, ?) ORDER BY added_at, seq`,
    movA.id,
    movB.id
  ) as any[];
  const movWs = await js(`getComputedStyle(document.querySelector('.mov-row .mov-title')).whiteSpace`);
  check(
    '乐章模板：有子体裁显示「第一乐章 小步舞曲 - 小快板」，没有 Sub-Type 时变成「第二乐章 - 柔板」；标题不折叠空格',
    movTitles?.[0] === '第一乐章 小步舞曲 - 小快板' &&
      movTitles?.[1] === '第二乐章 - 柔板' &&
      movDb[0]?.title === '%Movement Number} %Sub-Type} - %Tempo Term}' &&
      JSON.parse(movDb[0]?.extra ?? '{}')?.subType === 'menuett' &&
      JSON.parse(movDb[1]?.extra ?? '{}')?.subType === undefined &&
      movWs === 'pre',
    { movTitles, movDb, movWs }
  );

  /* 乐章行内改名也认预设名：和标题输入是同一条补全规则 */
  await js(`window.__app.rename(${JSON.stringify(movB.id)})`);
  await wait(220);
  await js(`(() => {
    const i = document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit');
    if (!i) return;
    i.value = 'default_movement';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(320);
  const movPresetSug = (await js(`(() => ({
    open: !!document.querySelector('.mov-sug'),
    names: [...document.querySelectorAll('.mov-sug .ms-name')].map((x) => x.textContent.trim()),
    active: document.querySelector('.mov-sug li.on .ms-name')?.textContent?.trim() ?? null,
  }))()`)) as any;
  await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await wait(100);
  const movPresetActive = await js(`document.querySelector('.mov-sug li.on .ms-name')?.textContent?.trim() ?? null`);
  await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(140);
  const movFilled = await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.value ?? null`);
  await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(120);
  check(
    '乐章行内改名也补全预设名：候选出现 → ↓ 选中 → Enter 填入整段模板',
    movPresetSug.open === true &&
      movPresetSug.names.includes('default_movement') &&
      movPresetSug.active === null &&
      movPresetActive === 'default_movement' &&
      movFilled === '%Movement Number} %Sub-Type} - %Tempo Term}',
    { ...movPresetSug, movPresetActive, movFilled }
  );

  /*
   * 乐章「已经有一段内容」时继续打，仍要给候选（用户 2026-11-23：加了字反而不弹）。
   * 这一条比空标题那条更容易被写坏 —— `movementFragment` 要跨过前缀、跳过 ` - `，
   * 任何一步算错都会得到空片段，而界面只是「安静地没有候选」。
   */
  await js(`window.__app.rename(${JSON.stringify(movB.id)})`);
  await wait(220);
  await js(`(() => {
    const i = document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit');
    if (!i) return;
    i.value = '第二乐章 柔板Al';
    i.setSelectionRange(i.value.length, i.value.length);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(320);
  const movTypedSug = (await js(`(() => ({
    open: !!document.querySelector('.mov-sug'),
    names: [...document.querySelectorAll('.mov-sug .ms-name')].map((x) => x.textContent.trim()),
  }))()`)) as any;
  await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await wait(90);
  await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(160);
  const movTypedFilled = await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.value ?? null`);
  await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(150);
  check(
    '乐章已有一段内容时继续打仍给候选（`第二乐章 柔板Al` 也算），采纳后补 ` - ` 只替换 `Al` 那一段',
    movTypedSug?.open === true &&
      movTypedSug.names?.some((n: string) => /^Alleg/i.test(n)) &&
      /^第二乐章 柔板 - \S+$/.test(String(movTypedFilled)),
    { ...movTypedSug, movTypedFilled }
  );

  /*
   * 列表里写下的**真正的术语**要同步进档案字段：
   * 标题只是模板，详情页的 Sub-Type / 速度术语才是数据（用户 2026-11-23 的要求）。
   * 复用 movB（它本来就在清理名单里）：临时新建的子曲目会让收尾的 DELETE 撞外键。
   */
  await js(`window.__app.rename(${JSON.stringify(movB.id)})`);
  await wait(220);
  await js(`(() => {
    const i = document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit');
    if (!i) return;
    i.value = '第一乐章 小步舞曲 - 小快板';
    i.setSelectionRange(i.value.length, i.value.length);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(180);
  await js(`document.querySelector('.mov-row[data-track-id="${movB.id}"] .title-edit')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(800);
  const movSyncRow = rows(`SELECT title, extra FROM track WHERE id = ?`, movB.id)[0] as any;
  const movSyncFields = (await js(`window.api.tracks.get(${JSON.stringify(movB.id)})`)) as any;
  const movSyncExtra = JSON.parse(movSyncRow?.extra ?? '{}');
  check(
    '乐章标题里写真正的术语（小步舞曲 / 小快板）→ 自动写进 Sub-Type 与速度术语字段，标题原样保留',
    movSyncRow?.title === '第一乐章 小步舞曲 - 小快板' &&
      movSyncExtra?.subType === 'menuett' &&
      movSyncFields?.subType === 'menuett' &&
      !!movSyncFields?.tempoTerm,
    { title: movSyncRow?.title, extra: movSyncExtra, fields: { subType: movSyncFields?.subType, tempoTerm: movSyncFields?.tempoTerm } }
  );

  /* 选项里的模板编辑器：官方预设可见、变量绿色高亮、复制进编辑器后镜像层也有变量 */
  await js(`window.__app.prefs(true)`);
  await wait(360);
  const tplUi = (await js(`(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const names = [...document.querySelectorAll('.settings .tpl-preset-name')].map((x) => x.textContent.trim());
    const green = [...document.querySelectorAll('.settings .tpl-line .v')]
      .map((x) => getComputedStyle(x).color);
    const firstPreset = [...document.querySelectorAll('.settings .tpl-preset')]
      .find((p) => p.querySelector('.tpl-preset-name')?.textContent.trim() === 'for_Classical_Opus');
    firstPreset?.querySelector('button')?.click();
    return { names, accent, green, hasEditor: !!document.querySelector('.settings .tpl-ed') };
  })()`)) as any;
  await wait(160);
  const tplEditor = (await js(`(() => {
    const ta = document.querySelector('.settings .tpl-ed textarea');
    return {
      value: ta?.value ?? null,
      vars: [...document.querySelectorAll('.settings .tpl-ed .tpl-mirror .v')].length,
    };
  })()`)) as any;
  check(
    '选项 → 标题模板：官方预设列出、变量是主题绿色、复制后编辑器镜像层同步高亮',
    tplUi?.names?.includes('for_Classical_Opus') &&
      tplUi?.names?.includes('default_movement') &&
      tplUi?.green?.length > 0 &&
      tplUi.green.every((c: string) => c === tplUi.accent) &&
      tplUi.hasEditor === true &&
      tplEditor.value === tplRaw &&
      tplEditor.vars >= 5,
    { ...tplUi, editor: tplEditor }
  );

  /* 模板编辑器里的变量补全：打 `%c` → %Composer}；Enter 是**补齐**不是换行 */
  await js(`(() => {
    const ta = document.querySelector('.settings .tpl-ed textarea');
    if (!ta) return;
    ta.focus();
    ta.value = '%c';
    ta.setSelectionRange(2, 2);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(240);
  const edSug = (await js(`(() => {
    const ul = document.querySelector('.tpl-sug');
    const r = ul?.getBoundingClientRect();
    return {
      names: [...document.querySelectorAll('.tpl-sug .tpl-sug-name')].map((x) => x.textContent.trim()),
      inside: !!r && r.top >= 0 && r.bottom <= window.innerHeight + 1,
    };
  })()`)) as any;
  await js(`document.querySelector('.settings .tpl-ed textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await wait(90);
  await js(`document.querySelector('.settings .tpl-ed textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await wait(220);
  const edFilled = await js(`document.querySelector('.settings .tpl-ed textarea')?.value ?? null`);
  const edVars = await js(`document.querySelectorAll('.settings .tpl-ed .tpl-mirror .v').length`);
  check(
    '模板编辑器补全变量：打「%c」→ %Composer}（Enter 补齐而不是换行，镜像层同步变绿）',
    edSug?.names?.includes('%Composer}') === true &&
      edSug.inside === true &&
      edFilled === '%Composer}' &&
      edVars === 1,
    { ...edSug, edFilled, edVars }
  );
  // 复原草稿：下面的「保存预设」还要拿它存一条
  await js(`(() => {
    const ta = document.querySelector('.settings .tpl-ed textarea');
    if (!ta) return;
    ta.value = ${JSON.stringify(tplRaw)};
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(180);

  /*
   * 光标错位回归：可见文字是镜像层（pre）画的，光标是 textarea 画的。
   * 两者的字重 / 字距 / 换行一旦不同，光标就会停到别的字旁边 ——
   * 2026-11-23 的 bug 是变量那段写了 font-weight: 500（换无衬线后比 400 宽）。
   */
  const tplMetrics = (await js(`(() => {
    const ta = document.querySelector('.settings .tpl-ed textarea');
    const pre = document.querySelector('.settings .tpl-ed .tpl-mirror');
    const v = pre?.querySelector('.v');
    if (!ta || !pre) return { missing: true };
    const a = getComputedStyle(ta);
    const b = getComputedStyle(pre);
    return {
      taWeight: a.fontWeight, preWeight: b.fontWeight,
      taSpacing: a.letterSpacing, preSpacing: b.letterSpacing,
      vWeight: v ? getComputedStyle(v).fontWeight : null,
      taScroll: ta.scrollHeight, preScroll: pre.scrollHeight,
      taFont: a.fontFamily, preFont: b.fontFamily,
    };
  })()`)) as any;
  check(
    '模板编辑器镜像层与 textarea 的度量一致（字重 / 字距 / 字体 / 行高），光标不会错位',
    tplMetrics?.taWeight === '400' &&
      tplMetrics?.preWeight === '400' &&
      tplMetrics?.vWeight === '400' &&
      tplMetrics.taSpacing === tplMetrics.preSpacing &&
      tplMetrics.taFont === tplMetrics.preFont &&
      tplMetrics.taScroll === tplMetrics.preScroll,
    tplMetrics
  );

  /* 自定义预设：保存进 localStorage、列表立刻多一条；删掉后不残留 */
  await js(`document.querySelector('.settings .tpl-save')?.click()`);
  await wait(220);
  const tplSaved = (await js(`(() => ({
    listed: [...document.querySelectorAll('.settings .tpl-preset-name')].map((x) => x.textContent.trim())
      .includes('for_Classical_Opus_custom'),
    ls: (JSON.parse(localStorage.getItem('ma-title-presets') || '[]') || []).map((p) => p.name),
  }))()`)) as any;
  await js(`(() => {
    const row = [...document.querySelectorAll('.settings .tpl-preset')]
      .find((p) => p.querySelector('.tpl-preset-name')?.textContent.trim() === 'for_Classical_Opus_custom');
    row?.querySelector('.chip.danger')?.click();
  })()`);
  await wait(180);
  const tplDeleted = (await js(`(JSON.parse(localStorage.getItem('ma-title-presets') || '[]') || []).length`)) as number;
  check(
    '选项里能保存 / 删除自定义预设（存 localStorage，不碰 data/tracks）',
    tplSaved?.listed === true &&
      tplSaved?.ls?.includes('for_Classical_Opus_custom') &&
      tplDeleted === 0,
    { saved: tplSaved, afterDelete: tplDeleted }
  );

  /*
   * 模板字体：预设列表（标题模板那块）与模板编辑器共用 --tpl-font。
   * 用户 2026-11-23 的两条要求：两块统一；默认非等宽，且**与「界面字体」互不影响**。
   */
  const tplFontCheck = (await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fam = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).fontFamily : null;
    };
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    probe.style.fontFamily = 'var(--font-text)';
    const sansFam = getComputedStyle(probe).fontFamily;
    probe.style.fontFamily = 'var(--font-mono)';
    const monoFam = getComputedStyle(probe).fontFamily;
    probe.remove();
    const tplClick = (v) => document.querySelector('.settings [data-tpl-font="' + v + '"]')?.click();
    const uiClick = (v) => document.querySelector('.settings [data-ui-font="' + v + '"]')?.click();
    const surfaces = () => ({
      editor: fam('.settings .tpl-ed textarea'),
      line: fam('.settings .tpl-line'),
      preset: fam('.settings .tpl-preset-name'),
      name: fam('.settings .tpl-name'),
      stored: localStorage.getItem('ma-tpl-font'),
    });
    tplClick('sans');
    await sleep(140);
    const sans = {
      ...surfaces(),
      chip: !!document.querySelector('.settings [data-tpl-font="sans"].on'),
    };
    // 界面字体切成等宽：模板文本**不许**跟着变（两者独立）
    uiClick('mono');
    await sleep(140);
    const afterUiMono = { ...surfaces(), uiFont: document.documentElement.dataset.font };
    uiClick('ui');
    await sleep(140);
    tplClick('mono');
    await sleep(140);
    const mono = {
      ...surfaces(),
      chip: !!document.querySelector('.settings [data-tpl-font="mono"].on'),
    };
    tplClick('sans');
    await sleep(140);
    return { sansFam, monoFam, sans, afterUiMono, mono, uiBack: document.documentElement.dataset.font };
  })()`)) as any;
  check(
    '模板字体：预设列表 / 模板编辑器 / 预设名统一跟 --font-text（默认非等宽）；切等宽一起变；改界面字体不影响模板',
    !!tplFontCheck?.sansFam &&
      tplFontCheck.sansFam !== tplFontCheck.monoFam &&
      tplFontCheck.sans?.editor === tplFontCheck.sansFam &&
      tplFontCheck.sans?.line === tplFontCheck.sansFam &&
      tplFontCheck.sans?.preset === tplFontCheck.sansFam &&
      tplFontCheck.sans?.name === tplFontCheck.sansFam &&
      tplFontCheck.sans?.chip === true &&
      tplFontCheck.sans?.stored === 'sans' &&
      tplFontCheck.afterUiMono?.uiFont === 'mono' &&
      tplFontCheck.afterUiMono?.editor === tplFontCheck.sansFam &&
      tplFontCheck.afterUiMono?.line === tplFontCheck.sansFam &&
      tplFontCheck.afterUiMono?.stored === 'sans' &&
      tplFontCheck.mono?.editor === tplFontCheck.monoFam &&
      tplFontCheck.mono?.line === tplFontCheck.monoFam &&
      tplFontCheck.mono?.chip === true &&
      tplFontCheck.mono?.stored === 'mono' &&
      tplFontCheck.uiBack === 'ui',
    tplFontCheck
  );

  /* 启动配置：歌词自动打开 / 安全模式都是外部 config.json，勾一下要真的落盘 */
  const cfgFile = path.join(app.getPath('userData'), 'config.json');
  const readCfgFile = () => {
    try {
      return JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch {
      return null;
    }
  };
  const cfgBefore = (await js(`window.api.config.get()`)) as any;
  const cfgPathText = await js(`document.querySelector('.settings [data-config-path]')?.textContent?.trim() ?? null`);
  const lyricsToggled = (await js(`(async () => {
    const box = document.querySelector('.settings [data-field="lyricsAuto"]');
    if (!box) return null;
    box.click();
    await new Promise((r) => setTimeout(r, 240));
    return window.api.config.get();
  })()`)) as any;
  await wait(80);
  const cfgAfterLyrics = readCfgFile();
  check(
    '启动配置：取消「自动打开歌词播报器」立刻写进 config.json（修复只读不写）',
    cfgBefore?.startup?.lyrics === true &&
      lyricsToggled?.startup?.lyrics === false &&
      cfgAfterLyrics?.startup?.lyrics === false &&
      cfgPathText?.includes('config.json') &&
      cfgBefore?.path === cfgFile,
    { before: cfgBefore, toggled: lyricsToggled, disk: cfgAfterLyrics, cfgPathText, cfgFile }
  );
  // 还原，别把冒烟 profile 的默认值带走。
  // 收尾走 IPC 而不是再点一次：写入瞬间复选框可能因 configBusy 处于 disabled，
  // 合成 click 会静默失效，把「收尾」变成一条假失败。
  await js(`window.api.config.update({ startup: { lyrics: true } })`);
  await wait(160);

  const safeToggled = (await js(`(async () => {
    const box = document.querySelector('.settings [data-field="safeMode"]');
    if (!box) return null;
    box.click();
    await new Promise((r) => setTimeout(r, 240));
    const lyrics = document.querySelector('.settings [data-field="lyricsAuto"]');
    const help = document.querySelector('.settings [data-field="helpAuto"]');
    return {
      cfg: await window.api.config.get(),
      lyricsDisabled: lyrics?.disabled === true,
      helpDisabled: help?.disabled === true,
    };
  })()`)) as any;
  await wait(80);
  const cfgAfterSafe = readCfgFile();
  check(
    '安全模式：写进 config.json，且歌词 / 帮助的自动打开开关一起禁用',
    safeToggled?.cfg?.safeMode === true &&
      safeToggled?.lyricsDisabled === true &&
      safeToggled?.helpDisabled === true &&
      cfgAfterSafe?.safeMode === true,
    { toggled: safeToggled, disk: cfgAfterSafe }
  );
  await js(`window.api.config.update({ safeMode: false })`);
  await wait(160);
  const cfgRestored = readCfgFile();
  check(
    '启动配置收尾：安全模式恢复关闭，自动打开偏好回到 true',
    cfgRestored?.safeMode === false && cfgRestored?.startup?.lyrics === true && cfgRestored?.startup?.help === true,
    cfgRestored
  );

  await js(`window.__app.prefs(false)`);
  await wait(160);

  /* 英文界面：Sub-Type 标签 + 子体裁 / 速度术语都按词表翻（模板也吃同一份） */
  await js(`window.__app.select(${JSON.stringify(movA.id)})`);
  await wait(260);
  await js(`window.__app.lang('en')`);
  await wait(420);
  const enTerms = (await js(`(() => {
    const d = document.querySelector('.detail');
    const field = (n) => d?.querySelector('[data-field="' + n + '"]');
    return {
      subKey: field('subType')?.querySelector('.k')?.textContent?.trim() ?? null,
      subVal: field('subType')?.querySelector('.v')?.textContent?.trim() ?? null,
      tempoKey: field('tempoTerm')?.querySelector('.k')?.textContent?.trim() ?? null,
      tempoVal: field('tempoTerm')?.querySelector('.v')?.textContent?.trim() ?? null,
      title: d?.querySelector('.d-head h2 .title-text')?.textContent?.trim() ?? null,
      list: document.querySelector('.mov-row[data-track-id="${movA.id}"] .mov-title')?.textContent?.trim() ?? null,
    };
  })()`)) as any;
  check(
    '英文界面：Sub-Type / Tempo term 的标签与值按词表翻（Menuetto / Allegretto）',
    enTerms?.subKey === 'Sub-Type' &&
      enTerms?.subVal === 'Menuetto' &&
      enTerms?.tempoKey === 'Tempo term' &&
      enTerms?.tempoVal === 'Allegretto' &&
      enTerms?.title === 'I. Menuetto - Allegretto' &&
      enTerms?.list === 'I. Menuetto - Allegretto',
    enTerms
  );
  await js(`window.__app.lang('zh')`);
  await wait(320);

  // 清掉两条临时乐章（连分析档案 + JSON），再删临时母作品
  for (const id of [movA.id, movB.id]) {
    const aid = rows(`SELECT id FROM analysis WHERE track_id = ?`, id)[0]?.id;
    if (aid) {
      handle.db.prepare(`DELETE FROM analysis_event WHERE analysis_id = ?`).run(aid);
      handle.db.prepare(`DELETE FROM analysis_marker WHERE analysis_id = ?`).run(aid);
      handle.db.prepare(`DELETE FROM analysis WHERE id = ?`).run(aid);
    }
    handle.db.prepare(`DELETE FROM track WHERE id = ?`).run(id);
    dropTrackJson(id);
  }

  // 临时曲目只留在这一轮：连分析档案一起物理删干净。
  // 只软删 track 的话，analysis 还在，里面的 f minor 会被后续搜索断言数进去。
  handle.db.prepare(`DELETE FROM analysis_event WHERE analysis_id = ?`).run(tmp.analysisId);
  handle.db.prepare(`DELETE FROM analysis_marker WHERE analysis_id = ?`).run(tmp.analysisId);
  handle.db.prepare(`DELETE FROM analysis WHERE id = ?`).run(tmp.analysisId);
  handle.db.prepare(`DELETE FROM track WHERE id = ?`).run(tmp.id);
  dropTrackJson(tmp.id);
  // 列表还挂着刚删掉的那一行（没人触发重新拉取）：刷一下，别让截图里出现幽灵曲目
  await js(`window.__app.refresh()`);
  await wait(240);

  // 词表里的术语译名：tonicization = 主音化（副属化是旧译，留作别名）
  const tonic = rows(`SELECT display FROM tag WHERE id = 'tonicization'`)[0];
  check('Tonicization 显示为「主音化」', tonic?.display === '主音化', tonic);

  // ---- 新增曲目：音源标记 / 详情字段 / 双击分发 ----
  const otona = rows(`SELECT id FROM track WHERE title = 'おとなの掟'`)[0]?.id as string | undefined;
  const hai = rows(`SELECT id FROM track WHERE title = '灰ト祈リ'`)[0]?.id as string | undefined;
  const flags = (await js(
    `window.api.tracks.list({}).then((rs) => rs.map((r) => ({ title: r.title, hasAudio: r.hasAudio, netease: !!r.neteaseUrl })))`
  )) as any[];
  const byTitle = (t: string) => flags.find((f) => f.title === t) ?? {};
  // 只数「曲目行」的标记：录音子行自己也有 ♪，混在一起数会把结果翻倍
  const fileMarks = await js(`document.querySelectorAll('.row:not(.rec-row) .c-play .file').length`);
  const cloudMarks = await js(`document.querySelectorAll('.row:not(.rec-row) .c-play .cloud').length`);
  check(
    '列表标出音源：有文件的 ♪、只有网易云的 云、都没有的 —',
    byTitle('The deepest nightmare of Sibyl').hasAudio === true &&
      byTitle('神鹿谣').hasAudio === true &&
      byTitle('灰ト祈リ').hasAudio === true &&
      byTitle('おとなの掟').hasAudio === false &&
      byTitle('おとなの掟').netease === true &&
      // 标记数按数据算，不写死 3 —— 后来又给几首挂了试听素材
      fileMarks === flags.filter((f: any) => f.hasAudio).length &&
      cloudMarks === flags.filter((f: any) => !f.hasAudio && f.netease).length,
    { flags, fileMarks, cloudMarks }
  );

  // 详情面板要有档案里的副标题 / 制作名单 / 别名 / 情绪
  await js(`window.__app.select(${JSON.stringify(otona)})`);
  await wait(500);
  const dSub = await js(`document.querySelector('.detail .subtitle')?.textContent?.trim() ?? ''`);
  const dCredits = await js(`document.querySelectorAll('.detail .credit').length`);
  const dMoods = await js(`document.querySelectorAll('.detail .mood').length`);
  const dAlias = await js(`document.querySelector('.detail .alias-line')?.textContent?.trim() ?? ''`);
  // 冒号是 CSS ::after 生成的（中文全角 / 英文半角由 lang 决定），这里读渲染后的值
  const dAliasColon = await js(`(() => {
    const k = document.querySelector('.detail .alias-line .k');
    return k ? getComputedStyle(k, '::after').content : null;
  })()`);
  check(
    '详情渲染副标题 / 制作名单 / 别名（带冒号）/ 情绪',
    dSub.includes('四重奏') && dCredits >= 2 && dMoods === 2 &&
      dAlias.includes('成人法则') && dAliasColon === '"："',
    { dSub, dCredits, dMoods, dAlias, dAliasColon }
  );
  await shot('smoke-detail.png');

  // ---- 详情面板：模块顺序 / 左对齐 / 不拆词 / 右键模块菜单 ----
  const shenlu = rows(`SELECT id FROM track WHERE title = '神鹿谣'`)[0]?.id as string | undefined;
  await js(`window.__app.select(${JSON.stringify(shenlu)})`);
  await wait(600);
  const dLayout = await js(`(() => {
    const heads = [...document.querySelectorAll('.detail .d-h')].map((h) => h.textContent.trim());
    const labels = [...document.querySelectorAll('.detail .d-row > .k')].map((k) => k.textContent.trim());
    const keyRow = [...document.querySelectorAll('.detail .d-row')]
      .find((r) => r.querySelector('.k')?.textContent.trim() === '调性');
    const items = keyRow ? [...keyRow.querySelectorAll('.key-item')] : [];
    const headText = document.querySelector('.detail .d-head')?.textContent ?? '';
    // 体裁 / 曲式两行：空值必须是 class=empty 的灰字占位（不是普通亮度）。
    // 只取这两行 —— 下面新增的「作品编号 / 作品号」同样是 d-pick + 空值，
    // 一起数进来会把这条断言的语义从「体裁/曲式」偷换成「所有空字段」。
    const pickRows = ['compositionType', 'form'].map((field) => {
      const v = document.querySelector('.detail .d-pick[data-field="' + field + '"] .v');
      return {
        text: v?.textContent?.trim() ?? '',
        empty: !!v?.classList.contains('empty'),
      };
    });
    return {
      heads,
      labels,
      pickRows,
      keys: items.map((n) => n.textContent.trim()),
      keyAlign: keyRow ? getComputedStyle(keyRow.querySelector('.v')).textAlign : null,
      keyWhite: items[0] ? getComputedStyle(items[0]).whiteSpace : null,
      period: document.querySelector('.detail .d-period')?.textContent?.trim() ?? null,
      showsTitleLang: /Japanese|Chinese|English/.test(headText),
    };
  })()`);
  check(
    '详情结构：作曲技法排在乐器组合之前，旧的「段落 / 标签」已移除',
    dLayout.heads.includes('作曲技法') &&
      dLayout.heads.includes('乐器组合（Instrumentation）') &&
      dLayout.heads.indexOf('作曲技法') < dLayout.heads.indexOf('乐器组合（Instrumentation）') &&
      !dLayout.labels.some((l: string) => l.includes('段落') || l === '标签'),
    { heads: dLayout.heads, labels: dLayout.labels }
  );
  check(
    '体裁与结构夹在「乐器组合」与「时间轴 · 段落」之间，两行是体裁 / 曲式',
    dLayout.heads.indexOf('乐器组合（Instrumentation）') < dLayout.heads.indexOf('体裁与结构') &&
      dLayout.heads.indexOf('体裁与结构') < dLayout.heads.indexOf('时间轴 · 段落') &&
      dLayout.labels.includes('体裁') &&
      dLayout.labels.includes('曲式'),
    { heads: dLayout.heads, labels: dLayout.labels }
  );
  check(
    '空值字段是灰字占位（class=empty）：体裁 / 曲式没填时显示「未标注」，而不是普通亮度',
    dLayout.pickRows.length === 2 &&
      dLayout.pickRows.every((r: any) => r.text === '未标注' && r.empty === true),
    dLayout.pickRows
  );
  /**
   * 迁移 009：genre 里那批「体裁」搬进 composition_type，genre 回落成父类 Classical。
   * 只查 genre 有值的行 —— 新登记的作品可以只写体裁不写流派（genre = NULL），
   * 那不是迁移的产物，不该被这条旧数据断言误伤。
   */
  const ctRows = rows(
    `SELECT genre, composition_type FROM track WHERE composition_type IS NOT NULL AND genre IS NOT NULL`
  ) as any[];
  check(
    '迁移 009：体裁落到 composition_type，genre 回落成 Classical（不再与流派混存）',
    ctRows.length >= 1 && ctRows.every((r) => r.genre === 'Classical' && r.composition_type),
    ctRows
  );
  check(
    '调性左对齐，且每个调名整体不拆行（不会断成 f / natural minor）',
    dLayout.keyAlign === 'left' && dLayout.keyWhite === 'nowrap' && dLayout.keys.length === 5,
    { align: dLayout.keyAlign, white: dLayout.keyWhite, keys: dLayout.keys }
  );
  check(
    '标题下不标源语言，时期单独一行显示中文',
    dLayout.period === '当代' && dLayout.showsTitleLang === false,
    { period: dLayout.period, showsTitleLang: dLayout.showsTitleLang }
  );

  /* ---- 录音制品：作品层 vs 录音层 ----
   *
   * 古典音乐里同一部作品常有多个录音，演奏家 / 乐团 / 指挥 / 混音 / 母带 / 发行年
   * 逐版本不同，作曲家与时期则相同。这里跑完整回路：建两条 → 各填各的 →
   * 换默认 → 查库核对 → 删一条 → 确认作品与另一条没受影响。
   */
  const recBefore = rows(`SELECT COUNT(*) c FROM recording WHERE track_id = ? AND deleted_at IS NULL`, trackId)[0].c;
  const origPath = rows(`SELECT file_path FROM track WHERE id = ?`, trackId)[0].file_path;
  const recA = await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(trackId)},
       orchestra: '维也纳爱乐乐团', conductor: '卡拉扬', performers: ['石登忠'],
       mixEngineer: '施密特', masteringEngineer: '迈斯纳', releaseYear: 1964,
       label: 'Deutsche Grammophon', catalogNo: '138 754 SLPM', isDefault: false })`
  );
  const recB = await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(trackId)},
       orchestra: '柏林爱乐乐团', conductor: '哈农奇',
       mixEngineer: '威尔金斯', masteringEngineer: '鲁索', releaseYear: 2010,
       label: 'Warner Classics', catalogNo: '825 662-2' })`
  );
  const recList = await js(`window.api.recording.list(${JSON.stringify(trackId)})`);
  check(
    '一个作品可以挂多条录音，各版本信息互相独立',
    recList.length === recBefore + 2 &&
      recList.some((r: any) => r.conductor === '卡拉扬' && r.label === 'Deutsche Grammophon') &&
      recList.some((r: any) => r.conductor === '哈农奇' && r.releaseYear === 2010) &&
      // 卡拉扬那条的混音/母带不能被哈农奇那条覆盖
      (recList.find((r: any) => r.conductor === '卡拉扬')?.mixEngineer === '施密特'),
    { n: recList.length, before: recBefore, conductors: recList.map((r: any) => r.conductor) }
  );

  // 只有一个 is_default（partial unique index 也保证，但这里验应用层的结果）
  const defaults = recList.filter((r: any) => r.isDefault);
  check('默认播放版本唯一（一个作品最多一条）', defaults.length === 1, {
    defaults: defaults.map((r: any) => r.conductor || r.id),
  });

  // 先测「切到有文件的另一条」：主文件指针必须真的跟过去。
  // 给 recA 挂上与原录音同一个文件，模拟「同一部作品的两个版本共用同一份母带」
  const pathWithFile = await js(`(async () => {
      const r = await window.api.recording.get(${JSON.stringify(recA.id)});
      await window.api.recording.save({ id: r.id, trackId: r.trackId, filePath: ${JSON.stringify(origPath ?? '')} });
      return window.api.recording.get(r.id);
    })()`);
  await js(`window.api.recording.setDefault(${JSON.stringify(trackId)}, ${JSON.stringify(recA.id)})`);
  const pathAfterSwitch = rows(`SELECT file_path FROM track WHERE id = ?`, trackId)[0].file_path;
  check(
    '设为默认（有音频的那条）后，作品的主文件指针跟着切过去',
    pathWithFile?.filePath === origPath && pathAfterSwitch === origPath,
    { recAFile: pathWithFile?.filePath, trackPath: pathAfterSwitch, origPath }
  );

  /**
   * 关键约束：默认版本可以是「只登记了信息、还没绑音频」的那条，
   * 但作品的主文件指针绝不能因此被清空 ——
   * 否则一首本来能播的歌，切一下版本就播不出来了。
   */
  await js(`window.api.recording.setDefault(${JSON.stringify(trackId)}, ${JSON.stringify(recB.id)})`);
  const pathAfterEmptyDefault = rows(`SELECT file_path FROM track WHERE id = ?`, trackId)[0].file_path;
  check(
    '默认版本没绑音频时，作品原有音频不能被清掉',
    pathAfterEmptyDefault === origPath,
    { origPath, nowPath: pathAfterEmptyDefault }
  );

  /* ---- 顺序即播放：reorder 之后，主文件指针跟着第一首走 ---- */
  const mp3 = path.join(app.getAppPath(), 'assets', 'ringtone-accept.mp3');
  const recC = (await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(trackId)}, label: '铃声版', filePath: ${JSON.stringify(mp3)} })`
  )) as any;
  const orderIds = ((await js(`window.api.recording.list(${JSON.stringify(trackId)})`)) as any[]).map((r) => r.id);
  const reordered = (await js(
    `window.api.recording.reorder(${JSON.stringify(trackId)}, ${JSON.stringify([
      recC.id,
      ...orderIds.filter((x: string) => x !== recC.id),
    ])})`
  )) as any[];
  const dbOrder = rows(
    `SELECT id, seq_order, is_default FROM recording WHERE track_id = ? AND deleted_at IS NULL ORDER BY seq_order`,
    trackId
  );
  const ptrReorder = rows(`SELECT file_path FROM track WHERE id = ?`, trackId)[0].file_path;
  check(
    '调整顺序 = 换「先播哪一版」：seq_order 重排、主文件指针指向第一首、默认仍然唯一',
    reordered?.[0]?.id === recC.id &&
      dbOrder[0]?.id === recC.id &&
      dbOrder[0]?.seq_order === 0 &&
      ptrReorder === mp3 &&
      dbOrder.filter((d: any) => d.is_default === 1).length === 1 &&
      dbOrder.find((d: any) => d.is_default === 1)?.id === recC.id,
    { firstInList: reordered?.[0]?.id, dbOrder, ptrReorder, mp3 }
  );

  // 双击子行「试听」不属于顺序：播它，但一行数据库都不改
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await js(`window.__app.search('')`);
  await wait(300);
  const orderSnapshot = JSON.stringify(dbOrder);
  await js(`(() => {
    const p = document.querySelector('.row.on:not(.rec-row)');
    const kid = p?.nextElementSibling;
    if (kid?.classList.contains('rec-row')) kid.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await wait(420);
  const playState = (await js(`({ src: window.__app.audioSrc(), recId: window.__app.audioRecId() })`)) as any;
  const dbAfterPlay = JSON.stringify(
    rows(
      `SELECT id, seq_order, is_default FROM recording WHERE track_id = ? AND deleted_at IS NULL ORDER BY seq_order`,
      trackId
    )
  );
  check(
    '双击某个演奏版本：只听这一版，顺序与主播放位一条都没改',
    String(playState.src).includes('/rec/') && playState.recId === recC.id && dbAfterPlay === orderSnapshot,
    { playState, unchanged: dbAfterPlay === orderSnapshot }
  );

  /* ---- 这个地址必须真的能取到字节 ----
     只断言 src 里有没有 /rec/ 是不够的：协议路由写错时 src 一样、内容却是 404，
     表现就是「音频未就绪 / 一直解码中、没有波形」。 */
  const recFetch = (await js(
    `(async () => {
       const r = await fetch(window.__app.audioSrc(), { headers: { Range: 'bytes=0-1023' } });
       const b = await r.arrayBuffer();
       return { status: r.status, bytes: b.byteLength, type: r.headers.get('content-type') };
     })()`
  )) as any;
  check(
    '录音版本的音频地址能取到真实字节（不是 404 空壳）',
    (recFetch.status === 206 || recFetch.status === 200) && recFetch.bytes > 0,
    recFetch
  );

  // 就绪度轮询：波形解码是异步的，等它落地再断言，别用固定 sleep 赌时序
  let playStatus: any = null;
  for (let i = 0; i < 12; i++) {
    playStatus = await js(`window.__app.audioStatus()`);
    if (playStatus?.durationMs > 0 && !playStatus?.decoding) break;
    await wait(150);
  }
  check(
    '双击试听后播放器真的就绪：有长度、解出了波形、没有卡在解码',
    playStatus?.ready === true &&
      playStatus?.durationMs > 0 &&
      playStatus?.decoding === false &&
      playStatus?.peaks === true,
    playStatus
  );

  // 「点作品播放 = 播顺序第一首」：从「试听某版」点回来，必须切回主录音地址
  await js(`window.__app.playRow(${JSON.stringify(trackId)})`);
  await wait(420);
  const playRowState = (await js(`({ src: window.__app.audioSrc(), recId: window.__app.audioRecId() })`)) as any;
  check(
    '点作品播放会切回主录音（试听某个版本不会把播放器黏在那一版上）',
    playRowState.recId === null && String(playRowState.src).includes('/audio/'),
    playRowState
  );

  // 录音制品专属信息在录音层，作曲家仍在作品层 —— 这是分层的意义。
  // 验的是「列在哪张表」，不是「某首有没有填」：神鹿谣本来就没填作曲家，
  // 用「有值」判断会得到一个与分层无关的假失败。
  const recFieldsOnRecording = rows(
    `SELECT COUNT(*) c FROM recording
      WHERE track_id = ? AND deleted_at IS NULL
        AND (conductor IS NOT NULL OR mix_engineer IS NOT NULL OR mastering_engineer IS NOT NULL)`,
    trackId
  )[0].c;
  const composerCols = rows(`SELECT COUNT(*) c FROM pragma_table_info('track') WHERE name = 'composer'`)[0].c;
  const recHasComposerCol = rows(`SELECT COUNT(*) c FROM pragma_table_info('recording') WHERE name = 'composer'`)[0].c;
  check(
    '录音专属信息在录音层，作曲家留在作品层（recording 表根本没有 composer 列）',
    recFieldsOnRecording >= 2 && composerCols === 1 && recHasComposerCol === 0,
    { recFieldsOnRecording, trackHasComposerCol: composerCols, recordingHasComposerCol: recHasComposerCol }
  );

  /**
   * v0.19 的界面改造：音源绑定与录音版本合并成一块、
   * 每行只留摘要、「管理录音版本」右对齐、歌词挪到图片绑定下面。
   *
   * 断言全部量几何 / 查 DOM 结构，而不是「看一眼截图」——
   * 右对齐这种要求，截图里差 2px 和差 40px 看着都像对的。
   */
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await js(`window.__app.search('')`);
  await js(`window.__app.refresh()`);
  await wait(260);

  const panelRec = await js(
    `(() => {
       const sec = [...document.querySelectorAll('.d-sec')].find((s) => s.querySelector('.d-manage'));
       if (!sec) return { found: false };
       const manage = sec.querySelector('.d-manage');
       const items = [...sec.querySelectorAll('.rec-item')];
       const sr = sec.getBoundingClientRect();
       const mr = manage.getBoundingClientRect();
       // 「默认播放」胶囊已经删掉：顺序第一靠绿点 + 绿边表达，不再写字
       const tagCount = sec.querySelectorAll('.rec-tag').length;
       // 行高要压得住：一旦有元素被挤成竖排，行高会瞬间翻倍
       return {
         found: true,
         rows: items.length,
         // 行内不该再有任何按钮：默认 / 换音频 / 删除都收进了管理窗口
         strayButtons: items.reduce((n, it) => n + it.querySelectorAll('button').length, 0),
         rightGap: Math.round(sr.right - mr.right),
         headDisplay: getComputedStyle(sec.querySelector('.d-h')).display,
         headRightGap: Math.round(sr.right - sec.querySelector('.d-h').getBoundingClientRect().right),
         secPadRight: getComputedStyle(sec).paddingRight,
         // 合并后不该再有「本地音频 已绑定」那种独立行
         hasLegacyAudioRow: !!sec.querySelector('.d-row .k'),
         rowH: items[0] ? Math.round(items[0].getBoundingClientRect().height) : 0,
         tagCount,
         firstDotGreen: getComputedStyle(items[0].querySelector('.rec-dot')).backgroundColor,
       };
     })()`
  );
  check(
    '音源绑定与录音版本合成一块：行内只剩摘要，「管理录音版本」右对齐',
    panelRec.found &&
      panelRec.rows >= 3 &&
      panelRec.strayButtons === 0 &&
      panelRec.rightGap >= 0 &&
      panelRec.rightGap <= 16,
    panelRec
  );
  check(
    '「默认播放」文字标签已去掉：信号只在绿点与绿边上，行仍是单行',
    panelRec.rowH > 0 &&
      panelRec.rowH <= 28 &&
      panelRec.tagCount === 0 &&
      // 顺序第一那条的圆点是实心的（默认透明 = 没有主播放位）
      panelRec.firstDotGreen !== 'rgba(0, 0, 0, 0)',
    { rowH: panelRec.rowH, tagCount: panelRec.tagCount, firstDotGreen: panelRec.firstDotGreen }
  );

  const recManagerUi = await js(
    `(async () => {
       window.__app.recManager(true);
       await new Promise((r) => setTimeout(r, 160));
       const m = document.querySelector('.modal.rm');
       if (!m) return { open: false };
       const selId = m.querySelector('.rm-item.on')?.dataset?.id ?? null;
       const sel = selId ? await window.api.recording.get(selId) : null;
       const offIn = m.querySelector('.rm-offset input');
       const chips = [...m.querySelectorAll('.rm-offset .chip')];
       const plus = chips[chips.length - 1];
       const ir = offIn?.getBoundingClientRect();
       const pr = plus?.getBoundingClientRect();
       const out = {
         open: true,
         items: m.querySelectorAll('.rm-item').length,
         fields: m.querySelectorAll('.rm-grid label').length,
         hasLink: !!m.querySelector('.rm-link input'),
         hasAdd: !!m.querySelector('.rm-add'),
         // 表单只显示当前选中的一个版本
         forms: m.querySelectorAll('.rm-form').length,
         // 原点偏移：逐版本，输入框显示的就是当前选中那一版的值
         hasOffset: !!offIn,
         offsetVal: offIn ? Number(offIn.value) : null,
         selOffset: sel ? Number(sel.audioOffsetMs) || 0 : null,
         // 列数算错时 ＋ 会掉到下一行：量同一行的高度差就能抓到
         offsetRowDelta: ir && pr ? Math.round(Math.abs(ir.top - pr.top)) : -1,
         offsetOrder: !!(ir && pr) && ir.left > chips[0].getBoundingClientRect().left && ir.left < pr.left,
       };
       window.__app.recManager(false);
       return out;
     })()`
  );
  check(
    '点「管理录音版本」打开专窗：版本清单 + 11 个字段 + 外链输入都在',
    recManagerUi.open &&
      recManagerUi.items >= 3 &&
      recManagerUi.fields === 11 &&
      recManagerUi.hasLink &&
      recManagerUi.hasAdd,
    recManagerUi
  );
  check(
    '专窗里每个版本各有原点偏移：输入框显示当前选中那一版的值，控件在同一行',
    recManagerUi.hasOffset === true &&
      recManagerUi.offsetVal === recManagerUi.selOffset &&
      recManagerUi.offsetRowDelta >= 0 &&
      recManagerUi.offsetRowDelta <= 2 &&
      recManagerUi.offsetOrder === true,
    recManagerUi
  );

  // 专窗截图：数值靠断言，版式（两栏、行距、按钮位置）还得看一眼
  await js(`window.__app.recManager(true)`);
  await wait(300);
  fs.writeFileSync(path.join(outDir, 'smoke-rec-manager.png'), (await win.capturePage()).toPNG());
  console.log('[smoke] shots/smoke-rec-manager.png');
  await js(`window.__app.recManager(false)`);
  await wait(150);

  const orderUi = await js(
    `(() => {
       const covers = document.querySelector('.d-covers');
       const lyrics = document.querySelector('.d-lyrics');
       if (!covers || !lyrics) return { ok: false };
       // 歌词必须在图片绑定之后（DOM 顺序 = 视觉顺序，面板是单列流式）
       const after = !!(covers.compareDocumentPosition(lyrics) & Node.DOCUMENT_POSITION_FOLLOWING);
       return { ok: true, after };
     })()`
  );
  check('歌词选择挪到图片绑定下方（连接 / 绑定类动作聚在一处）', orderUi.ok && orderUi.after, orderUi);

  // 上一次跑可能把某几首收起了（状态存在 localStorage 里），先清干净再看全貌
  await js(`localStorage.removeItem('ma-tree-collapsed')`);
  await js(`window.__app.refresh()`);
  await wait(240);

  const treeUi = await js(
    `(() => {
       const parents = [...document.querySelectorAll('.row.has-tree')];
       const kids = [...document.querySelectorAll('.row.rec-row')];
       if (!parents.length || !kids.length) return { parents: parents.length, kids: kids.length };
       const parent = parents[0];
       const kidPad = parseFloat(getComputedStyle(kids[0]).paddingLeft) || 0;
       const parentPad = parseFloat(getComputedStyle(parent).paddingLeft) || 0;
       // 树线画在 ::after 上（border-left + border-bottom）
       const line = getComputedStyle(kids[0], '::after');
       // 子行文字应当略靠右于曲名，但别缩成一大截 —— 量出来才好定缩进
       const titleEl = parent.querySelector('.c-title .t');
       const kidTitle = kids[0].querySelector('.rec-title');
       return {
         parents: parents.length,
         kids: kids.length,
         titleX: titleEl ? Math.round(titleEl.getBoundingClientRect().left) : 0,
         kidX: kidTitle ? Math.round(kidTitle.getBoundingClientRect().left) : 0,
         // 每棵树的父行后面必须紧跟它自己的子行；乐章子行也算树的孩子
         paired: parents.every((p) => {
           const n = p.nextElementSibling;
           return n?.classList.contains('rec-row') || n?.classList.contains('mov-row');
         }),
         // 有子行就必须有箭头，否则收不起来
         hasToggle: parents.every((p) => !!p.querySelector('.tw')),
         /* 箭头是 chevron（svg + 一条 path），不是字符 ▾：
            侧栏早就换成「两条边构成的直角」了，列表里留着实心三角就是两套语言。
            两条都量：svg 在、且按钮里没有那个字符（旧实现是 textContent === '▾'）。 */
         chevron: parents.every((p) => {
           const b = p.querySelector('.tw');
           const svg = b?.querySelector('svg.tw-chev path');
           return !!svg && !/▾/.test(b?.textContent ?? '');
         }),
         indented: kidPad > parentPad + 20,
         kidPad,
         parentPad,
         hasLine: parseFloat(line.borderLeftWidth) > 0,
       };
     })()`
  );
  // 版本总数从接口取：子行数必须与之严格相等 —— 这同时证明了「只有一条也铺子行」
  const versNow = await js(
    `window.api.tracks.list({}).then((rs) => rs.reduce((n, r) => n + (r.recordingVersions?.length ?? 0), 0))`
  );
  check(
    '主列表用树状子行展示录音版本：每个版本一行（单版本也铺）+ 缩进 + 连接线 + 可收起',
    treeUi.paired === true &&
      treeUi.hasToggle === true &&
      treeUi.chevron === true &&
      treeUi.indented === true &&
      treeUi.hasLine === true &&
      treeUi.parents >= 1 &&
      treeUi.kids === versNow,
    { ...treeUi, versNow }
  );

  // 收起 / 展开：点箭头 → 子行减少；刷新后仍收起（localStorage 记着）；再点回来
  const kidsBefore = treeUi.kids;
  /* 折叠测试要挑一棵**有录音版本**的树：乐章-only 的树收起来减少的是 `.mov-row`，
     拿 `.rec-row` 计数会看起来「没反应」。 */
  const foldParent = () =>
    js(`(() => {
      const p = [...document.querySelectorAll('.row.has-tree')].find(
        (x) => x.nextElementSibling?.classList.contains('rec-row')
      );
      return p ? (p.dataset.trackId ?? '') : '';
    })()`);
  const foldId = await foldParent();
  const foldSel = foldId ? `.row.has-tree[data-track-id="${foldId}"]` : '.row.has-tree';
  /* chevron 到底转没转：展开 = rotate(90deg)（角尖朝下），收起 = 0（朝右）。
     用 computed transform 量，别靠肉眼看截图 —— 方向写错时两边都是「一个 V」，
     缩略图上根本分辨不出来。 */
  const chevDeg = async () =>
    (await js(`(() => {
      const p = document.querySelector(${JSON.stringify(foldSel)});
      const s = p?.querySelector('.tw svg.tw-chev');
      if (!s) return null;
      const m = getComputedStyle(s).transform;
      if (!m || m === 'none') return 0;
      const n = (m.match(/-?[\\d.]+/g) || []).map(Number);
      return Math.round((Math.atan2(n[1], n[0]) * 180) / Math.PI);
    })()`)) as any;
  const chevOpen = await chevDeg();
  const clickFold = () =>
    js(`document.querySelector(${JSON.stringify(foldSel)})?.querySelector('.tw')?.click()`);
  await clickFold();
  await wait(220);
  const chevClosed = await chevDeg();
  const afterCollapse = await js(`document.querySelectorAll('.row.rec-row').length`);
  const collapseStored = await js(`localStorage.getItem('ma-tree-collapsed')`);
  await js(`window.__app.refresh()`);
  await wait(240);
  const afterRefresh = await js(`document.querySelectorAll('.row.rec-row').length`);
  await shot('smoke-tree-collapsed.png');
  await clickFold();
  await wait(180);
  const afterExpand = await js(`document.querySelectorAll('.row.rec-row').length`);
  check(
    '树可以收起/展开，收起状态记在本地（刷新后仍然收起）',
    afterCollapse < kidsBefore && afterRefresh === afterCollapse && afterExpand === kidsBefore,
    { kidsBefore, afterCollapse, afterRefresh, afterExpand, collapseStored }
  );
  check(
    '列表的展开箭头会转：展开 90°（朝下）、收起 0°（朝右）—— 和侧栏的 chevron 同一套',
    chevOpen === 90 && chevClosed === 0,
    { chevOpen, chevClosed }
  );

  /* ---- 焦点环：点完箭头再按空格（全局播放）不该冒出绿框（v0.78）----
   * 根因不在箭头，而在「空格是全局播放键」：鼠标点完按钮焦点留在上面，
   * 随手按任意键 Chromium 就把它提升成 :focus-visible。修法是记一个 `data-input`，
   * 只有 Tab 才切到 keyboard。这里查三件事：标记会翻、鼠标态下没有描边、样式表里真有这条规则。
   */
  {
    const focusState = (await js(`(() => {
      const html = document.documentElement;
      const tw = document.querySelector('.row.has-tree .tw');
      if (!tw) return null;
      const press = (type) => tw.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
      const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      press('pointerdown');
      tw.focus();
      key('a'); // 任意非 Tab 键：不能把输入方式翻成 keyboard
      const afterKey = {
        input: html.dataset.input,
        outline: getComputedStyle(tw).outlineStyle,
        width: getComputedStyle(tw).outlineWidth,
      };
      key('Tab');
      const afterTab = html.dataset.input;
      press('pointerdown');
      // 样式表里必须真有那条规则（别只是 dataset 换了、CSS 忘了跟着改）
      let rule = false;
      for (const sheet of document.styleSheets) {
        let list = [];
        try { list = sheet.cssRules; } catch { continue; }
        for (const r of list) if (r.selectorText && r.selectorText.includes('[data-input="pointer"]')) rule = true;
      }
      tw.blur();
      return { afterKey, afterTab, rule, backToPointer: html.dataset.input };
    })()`)) as any;
    check(
      '点过按钮再按空格（全局播放）不画焦点环：鼠标态一律无描边，只有 Tab 才切回键盘态',
      focusState?.afterKey?.input === 'pointer' &&
        focusState.afterKey.outline === 'none' &&
        focusState.afterTab === 'keyboard' &&
        focusState.backToPointer === 'pointer' &&
        focusState.rule === true,
      focusState
    );
  }

  /* ---- 录音版本可以只挂外链（本地没有文件） ---- */
  const linkRec = await js(
    `(async () => {
       const r = await window.api.recording.save({
         trackId: ${JSON.stringify(trackId)},
         label: '外链版', link: 'https://music.163.com/song/1901371647',
       });
       const got = await window.api.recording.get(r.id);
       return { id: r.id, link: got.link, isExternal: got.isExternal, hasFile: !!got.filePath };
     })()`
  );
  const linkInDb = rows(`SELECT link FROM recording WHERE id = ?`, linkRec.id)[0]?.link;
  check(
    '录音版本可以用外部网络链接代替本地文件',
    linkRec.link === 'https://music.163.com/song/1901371647' &&
      linkRec.isExternal === true &&
      !linkRec.hasFile &&
      linkInDb === linkRec.link,
    { ui: linkRec, db: linkInDb }
  );
  await js(`window.api.recording.remove(${JSON.stringify(linkRec.id)})`);

  /* ---- 专辑序号：这张专辑里第几首 ---- */
  await js(`window.api.tracks.update(${JSON.stringify(trackId)}, { albumTrackNo: 7 })`);
  const albumNoDb = rows(`SELECT album_track_no FROM track WHERE id = ?`, trackId)[0]?.album_track_no;
  await js(`window.__app.refresh()`);
  await wait(120);
  const albumNoUi = await js(
    `(() => {
       const p = document.querySelector('.d-album-no .editable');
       return { text: p ? p.textContent.trim() : null };
     })()`
  );
  check(
    '专辑序号（第几首）能落库并显示成「第 N 首」',
    albumNoDb === 7 && /7/.test(albumNoUi.text ?? ''),
    { db: albumNoDb, ui: albumNoUi.text }
  );
  // 收尾：清回空，别把冒烟填的序号留在真实库里
  await js(`window.api.tracks.update(${JSON.stringify(trackId)}, { albumTrackNo: null })`);
  const albumNoBack = rows(`SELECT album_track_no FROM track WHERE id = ?`, trackId)[0]?.album_track_no;
  check('专辑序号可以清空（填错了要能擦掉）', albumNoBack === null, { db: albumNoBack });

  // 删掉刚建的三条，别把冒烟数据留在库里（软删，并清掉临时曲目时一起处理）
  await js(`window.api.recording.remove(${JSON.stringify(recA.id)})`);
  await js(`window.api.recording.remove(${JSON.stringify(recB.id)})`);
  await js(`window.api.recording.remove(${JSON.stringify(recC.id)})`);
  // 把顺序还原：冒烟动过 seq_order，不还原的话真实库里的序号会越跑越散
  await js(`window.api.recording.reorder(${JSON.stringify(trackId)}, ${JSON.stringify(orderIds)})`);
  const recAfter = await js(`window.api.recording.list(${JSON.stringify(trackId)})`);
  check('删掉录音版本后回到原状（作品与原有版本不受影响）', recAfter.length === recBefore, {
    before: recBefore,
    after: recAfter.length,
  });
  // 把铃声版删掉后，主文件指针必须退回原来那条 flac，而不是悬空
  const ptrAfterCleanup = rows(`SELECT file_path FROM track WHERE id = ?`, trackId)[0].file_path;
  check('删掉临时版本后，作品的主文件指针退回原来的那条', ptrAfterCleanup === origPath, {
    origPath,
    ptrAfterCleanup,
  });

  /* ---- 封面：绿色文件名 + 点击打开查看窗口 ---- */
  const coverUi = await js(
    `(() => {
       const b = document.querySelector('.cover-file');
       const add = document.querySelector('.cover-add');
       const img = document.querySelector('.d-cover-img');
       if (!b) return { hasFile: false, hasAdd: !!add, hasThumb: !!img };
       const cs = getComputedStyle(b);
       const r = b.getBoundingClientRect();
       return { hasFile: true, hasThumb: !!img, color: cs.color,
                fontSize: cs.fontSize, cursor: cs.cursor,
                text: b.textContent.trim(), w: Math.round(r.width) };
     })()`
  );
  check(
    '封面区：显示绿色文件名而不是缩略图，可点',
    coverUi.hasFile === true && coverUi.hasThumb === false && coverUi.cursor === 'pointer',
    coverUi
  );
  // 颜色要真的是 Vue 绿（不是默认链接蓝）
  const accentRgbHere = await js(`getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim()`);
  const coverColorRgb = (coverUi.color ?? '').replace(/\s+/g, '');
  check(
    '封面文件名用的是 Vue 绿（不是系统链接蓝）',
    coverColorRgb === `rgb(${accentRgbHere.replace(/\s+/g, '')})`,
    { color: coverUi.color, accentRgb: accentRgbHere }
  );

  // 点开 → 独立的图片查看窗口（#image）
  const coverOpened = await js(`(document.querySelector('.cover-file').click(), true)`);
  await wait(1200);
  const imageWin2 = byHash('image');
  let imgOk = null;
  if (imageWin2) {
    imgOk = await imageWin2.webContents.executeJavaScript(
      `(async () => { const im = document.querySelector('.iv-img');
         if (!im) return { found: false };
         if (!im.complete) await new Promise((res, rej) => { im.onload = res; im.onerror = rej; });
         return { found: true, src: im.getAttribute('src'), w: im.naturalWidth, h: im.naturalHeight }; })()`
    );
  }
  check(
    '点击封面文件名打开查看窗口，且图真的加载出来',
    coverOpened === true && !!imageWin2 && imgOk?.found === true && imgOk?.w > 0,
    { imageWin: !!imageWin2, img: imgOk }
  );
  if (imageWin2) {
    const img = await imageWin2.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'smoke-image-viewer.png'), img.toPNG());
    console.log('[smoke] shots/smoke-image-viewer.png');
    imageWin2.close();
    await wait(300);
  }

  await shot('smoke-detail-shenlu.png');

  /** 右键「空白处」：目标就是 .detail 本身，不落在按钮/标签/表格上 */
  const OPEN_MENU = `(() => {
    const el = document.querySelector('.detail');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 12), clientY: Math.round(r.bottom - 12),
    }));
    return new Promise((res) => setTimeout(() => {
      const menu = document.querySelector('.detail .ctxmenu');
      const items = menu ? [...menu.querySelectorAll('.ctx-item')] : [];
      res({
        open: !!menu,
        items: items.map((b) => b.textContent.trim()),
        // 最后一项是「全部显示」，不参与勾选计数
        ticked: items.slice(0, -1).filter((b) => b.querySelector('.ctx-tick')?.textContent.trim()).length,
      });
    }, 110));
  })()`;

  // 神鹿谣没有制作名单 —— 模块显隐拿它测会「先假后假」地假通过，所以换 おとなの掟
  await js(`window.__app.select(${JSON.stringify(otona)})`);
  await wait(420);
  const headsBefore = await js(`[...document.querySelectorAll('.detail .d-h')].map((h) => h.textContent.trim())`);
  const menuOpen = await js(OPEN_MENU);
  check(
    '详情空白处右键弹出模块菜单：11 个模块默认全部勾选 + 全部显示',
    menuOpen.open === true &&
      menuOpen.items.length === 12 &&
      menuOpen.items[0].includes('附注') &&
      menuOpen.ticked === 11 &&
      headsBefore.includes('制作 / 发行') &&
      // 「音频对齐」板块已下线：偏移只属于录音版本，改它去「管理录音版本」或播放条
      !headsBefore.includes('音频对齐'),
    { ...menuOpen, headsBefore }
  );
  await shot('smoke-detail-menu.png');

  const afterHide = await js(`(async () => {
    const item = [...document.querySelectorAll('.ctxmenu .ctx-item')]
      .find((b) => b.textContent.includes('制作 / 发行'));
    item?.click();
    await new Promise((r) => setTimeout(r, 160));
    return {
      heads: [...document.querySelectorAll('.detail .d-h')].map((h) => h.textContent.trim()),
      store: localStorage.getItem('ma-detail-hidden'),
    };
  })()`);

  // 切到别的曲目再切回来：显隐是按 trackId 记的，不该被重置
  await js(`window.__app.select(${JSON.stringify(shenlu)})`);
  await wait(260);
  await js(`window.__app.select(${JSON.stringify(otona)})`);
  await wait(420);
  const afterReselect = await js(`[...document.querySelectorAll('.detail .d-h')].map((h) => h.textContent.trim())`);
  check(
    '模块显隐按曲目记忆：关掉制作名单后切走再切回仍然不显示，其它模块不受影响',
    !afterHide.heads.includes('制作 / 发行') &&
      !afterReselect.includes('制作 / 发行') &&
      afterReselect.includes('乐器组合（Instrumentation）'),
    { afterHide, afterReselect }
  );

  const afterReset = await js(`(async () => {
    const el = document.querySelector('.detail');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 12), clientY: Math.round(r.bottom - 12),
    }));
    await new Promise((res) => setTimeout(res, 110));
    const all = [...document.querySelectorAll('.ctxmenu .ctx-item')]
      .find((b) => b.textContent.includes('全部显示'));
    all?.click();
    await new Promise((res) => setTimeout(res, 200));
    return {
      store: localStorage.getItem('ma-detail-hidden'),
      heads: [...document.querySelectorAll('.detail .d-h')].map((h) => h.textContent.trim()),
    };
  })()`);
  check(
    '「全部显示」把模块恢复回来，存盘也清掉',
    afterReset.heads.includes('制作 / 发行') && afterReset.store === '{}',
    afterReset
  );
  // 收起菜单再截图：它开着会压住下面两块内容
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(160);

  // ---- 新登记的曲目：The deepest nightmare of Sibyl ----
  const sibylId = rows(`SELECT id FROM track WHERE title = 'The deepest nightmare of Sibyl'`)[0]?.id;
  const sibylDetail = await js(`window.api.tracks.get(${JSON.stringify(sibylId)})`);
  const sibylAudio = await js(`window.api.audio.resolve(${JSON.stringify(sibylId)})`);
  // 编制摘要**是用户可编辑的文案**（他随时会改成中文），断言只认「写了、而且确实提到管弦/人声」，
  // 不认具体一行字 —— 以前写死 'Orchestra + Soprano Solo'，用户把简介改成中文这条就假失败。
  const absIsOrchestralVocal = /orchestra|管弦|soprano|女高音/i.test(
    String(sibylDetail?.instrumentationAbstract ?? '')
  );
  check(
    '新曲目已入库：编制摘要 / 4/4 / 130 BPM / 降 E 和声小调 / 三种情绪 / 音频可播',
    absIsOrchestralVocal &&
      sibylDetail?.meter === '4/4' &&
      sibylDetail?.bpm === 130 &&
      sibylDetail?.keys?.[0] === 'e-flat harmonic minor' &&
      sibylDetail?.moods?.length === 3 &&
      sibylDetail?.hasAudio === true &&
      sibylAudio?.exists === true &&
      sibylAudio?.format === 'flac',
    {
      abstract: sibylDetail?.instrumentationAbstract,
      meter: sibylDetail?.meter,
      bpm: sibylDetail?.bpm,
      keys: sibylDetail?.keys,
      moods: sibylDetail?.moods,
      audio: { format: sibylAudio?.format, exists: sibylAudio?.exists },
    }
  );

  await js(`window.__app.select(${JSON.stringify(sibylId)})`);
  await wait(520);
  const sibylUI = await js(`(() => {
    const rows = [...document.querySelectorAll('.detail .d-row')];
    const abs = rows.find((r) => r.querySelector('.k')?.textContent.trim() === '乐器组合摘要');
    return {
      abstract: abs?.querySelector('.v')?.textContent.trim() ?? null,
      subs: [...document.querySelectorAll('.detail .d-sub-h')].map((h) => h.textContent.trim()),
      tags: [...document.querySelectorAll('.detail .tag b')].map((b) => b.textContent.trim()),
      moods: [...document.querySelectorAll('.detail .mood')].map((m) => m.textContent.trim()),
    };
  })()`);
  check(
    '乐器组合渲染：摘要 + 乐器 + 演奏技法，新词条（女高音 / 主音化 / 连奏）都在',
    /orchestra|管弦|soprano|女高音/i.test(String(sibylUI.abstract ?? '')) &&
      sibylUI.subs.includes('乐器') &&
      sibylUI.subs.includes('演奏技法') &&
      ['女高音', '主音化', '连奏', '断奏', '滚奏', '齿龈颤音'].every((x) => sibylUI.tags.includes(x)) &&
      sibylUI.moods.length === 3,
    sibylUI
  );
  await shot('smoke-detail-sibyl.png');

  /* ---- 拍号类型（派生值）+ ⓘ 说明 + 语言短代码的显示 ---- */
  const readMeterUI = async () =>
    (await js(`(() => {
      const el = document.querySelector('.detail .mt-type');
      const kind = el ? el.querySelector('.mt-kind') : null;
      const icon = el ? el.querySelector('.mt-i') : null;
      const kr = kind ? kind.getBoundingClientRect() : null;
      const ir = icon ? icon.getBoundingClientRect() : null;
      const ics = icon ? getComputedStyle(icon) : null;
      return {
        text: kind ? kind.textContent.trim() : null,
        meter: document.querySelector('.detail .meter-val')?.textContent?.trim() ?? null,
        hasIcon: !!icon,
        // 气泡关着时**不在 DOM 里**（v-if）：这里读到 null 才是对的
        gap: kr && ir ? Math.round(ir.left - kr.right) : null,
        iconH: ir ? Math.round(ir.height) : null,
        iconTop: ir ? Math.round(ir.top) : null,
        iconMid: ir ? ir.top + ir.height / 2 : null,
        kindMid: kr ? kr.top + kr.height / 2 : null,
        iconVA: ics ? ics.verticalAlign : null,
        iconFamily: ics ? ics.fontFamily : null,
        kindFs: el ? getComputedStyle(el).fontSize : null,
        // 曲目树：曲名旁的语言标签（已删）、表头列名、行里的格子数
        langChips: [...document.querySelectorAll('.c-title .lang')].map((x) => x.textContent.trim()),
        headCols: [...document.querySelectorAll('.thead > *')].map((x) => x.textContent.trim()),
        rowCols: document.querySelector('.row') ? document.querySelector('.row').children.length : -1,
        headColCount: document.querySelectorAll('.thead > *').length,
      };
    })()`)) as any;

  /** 只派发悬停事件，不读 DOM（读要另起一次往返，快照才落在 DOM 更新之后） */
  const hoverTip = async (on: boolean) =>
    js(`(() => {
      const i = document.querySelector('.detail .mt-i');
      if (!i) return false;
      i.dispatchEvent(new MouseEvent(${JSON.stringify(on ? 'mouseenter' : 'mouseleave')}, { bubbles: false }));
      return true;
    })()`);

  /** 读气泡现状：**不在同一个同步块里读** —— Vue 的 DOM 更新在微任务里 */
  const readTip = async () =>
    (await js(`(() => {
      const p = document.querySelector('.mt-pop');
      if (!p) return null;
      const cs = getComputedStyle(p);
      const r = p.getBoundingClientRect();
      return {
        text: p.textContent.trim(),
        parentIsBody: p.parentElement === document.body,
        display: cs.display,
        opacity: cs.opacity,
        visibility: cs.visibility,
        transition: cs.transitionDuration,
        font: cs.fontFamily,
        left: Math.round(r.left), right: Math.round(r.right),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        vw: innerWidth, vh: innerHeight,
      };
    })()`)) as any;

  const meterUI = await readMeterUI();
  const meterText = String(meterUI?.text ?? '').replace(/\s+/g, ' ');
  check(
    '拍号类型是算出来的：中文界面把 4/4 显示成「复拍子」，并在文字右边挂圆圈 i',
    meterUI?.meter === '4/4' && /复拍子/.test(meterText) && meterUI?.hasIcon === true,
    meterUI
  );
  check(
    '圆圈 i 紧贴文字右边（3–8px 间隙）、高度与字号相当（不是上标）',
    (meterUI?.gap ?? -1) >= 3 &&
      (meterUI?.gap ?? 99) <= 8 &&
      (meterUI?.iconH ?? 0) >= 10 &&
      (meterUI?.iconH ?? 99) <= 13 &&
      meterUI?.iconVA !== 'super',
    { gap: meterUI?.gap, iconH: meterUI?.iconH, va: meterUI?.iconVA, fs: meterUI?.kindFs }
  );
  check(
    '圆圈 i 和文字在同一水平线上（中线偏差 ≤1.5px，不再「掉下来」）',
    typeof meterUI?.iconMid === 'number' &&
      typeof meterUI?.kindMid === 'number' &&
      Math.abs(meterUI.iconMid - meterUI.kindMid) <= 1.5,
    { iconMid: meterUI?.iconMid, kindMid: meterUI?.kindMid, va: meterUI?.iconVA }
  );

  const tipClosed = await readTip();      // 没悬停时气泡不在 DOM 里
  await hoverTip(true);
  const tipNow = await readTip();         // 紧接着读：中间没有 wait，有过渡/延迟就读不到
  check(
    '悬停圆圈 i 立刻出气泡（无过渡、无延迟），说明讲的是英美体系怎么看',
    tipClosed === null &&
      !!tipNow &&
      (tipNow as any).display === 'block' &&
      (tipNow as any).opacity === '1' &&
      /英美/.test(String((tipNow as any).text ?? '')),
    { closed: tipClosed, now: tipNow }
  );
  check(
    '气泡挂在 body 上 + 整块留在视口内（不再被 .detail 的 overflow 裁掉半截）',
    !!tipNow &&
      (tipNow as any).parentIsBody === true &&
      (tipNow as any).transition === '0s' &&
      (tipNow as any).left >= 0 &&
      (tipNow as any).top >= 0 &&
      (tipNow as any).right <= (tipNow as any).vw &&
      (tipNow as any).bottom <= (tipNow as any).vh,
    tipNow
  );
  check(
    '气泡用界面字体（不是等宽）：中文说明用等宽读起来累',
    !!tipNow && !/mono/i.test(String((tipNow as any).font ?? '')),
    { font: (tipNow as any)?.font }
  );
  // 气泡只在悬停时存在 —— 截图要趁现在（shut 前先把它留在屏幕上给用户看）
  await shot('smoke-meter-tip.png');

  /* ---- ⓘ 的三种状态：悬停延迟关 / 能挪进气泡 / 点一下钉住（v0.43） ---- */
  await hoverTip(false);
  await wait(300);
  const tipAt300 = await readTip();     // 300ms：还没到 600ms，必须还在
  await wait(600);
  const tipAt900 = await readTip();     // 900ms：过了 600ms，必须收了
  check(
    '鼠标离开 ⓘ 不是立刻收：留 0.6s 缓冲（够把鼠标挪进气泡），之后才收',
    tipAt300 !== null && tipAt900 === null,
    { at300: tipAt300 !== null, at900: tipAt900 !== null }
  );

  // 离开图标之后把鼠标移进气泡：定时器要被取消，在气泡里待多久都不收
  await hoverTip(true);
  await hoverTip(false);
  await js(
    `document.querySelector('.mt-pop')?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))`
  );
  await wait(1200);
  const tipHoverIn = await readTip();
  check('离开图标后把鼠标移进气泡 → 不收起（能一边看说明一边选字）', tipHoverIn !== null, {
    inTip: tipHoverIn !== null,
  });
  await js(
    `document.querySelector('.mt-pop')?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))`
  );
  await wait(1150);
  const tipLeaveTip = await readTip();
  check('离开气泡同样再等 0.6s 才收', tipLeaveTip === null, { after: tipLeaveTip !== null });

  // 点一下钉住：鼠标怎么移都不收
  await js(`document.querySelector('.detail .mt-i')?.click()`);
  await wait(140);
  const tipPinned = await readTip();
  await hoverTip(false);
  await wait(1250);
  const tipPinnedLater = await readTip();
  check(
    '点一下 ⓘ → 钉住：鼠标离开 0.6s 以上也不收（不用一直悬着才能看）',
    tipPinned !== null && tipPinnedLater !== null,
    { opened: tipPinned !== null, afterLeave: tipPinnedLater !== null }
  );
  const iconPinnedUI = (await js(`(() => {
    const i = document.querySelector('.detail .mt-i');
    return i ? { pinned: i.classList.contains('pinned'), svg: !!i.querySelector('svg') } : null;
  })()`)) as any;
  check(
    '钉住状态在图标上看得出来（pinned 类 + SVG 图形，不是伪装的 1px 圆环）',
    iconPinnedUI?.pinned === true && iconPinnedUI?.svg === true,
    iconPinnedUI
  );
  await js(`document.querySelector('.detail .mt-i')?.click()`);
  await wait(160);
  check('再点一下 ⓘ → 收起（开关式，不是只能点别处关）', (await readTip()) === null, {});

  // 钉住之后点页面别处也收
  await js(`document.querySelector('.detail .mt-i')?.click()`);
  await wait(140);
  const tipPinned2 = await readTip();
  await js(
    `document.querySelector('.detail')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`
  );
  await wait(160);
  const tipAfterOutside = await readTip();
  check(
    '钉住后点页面别处 → 收起',
    tipPinned2 !== null && tipAfterOutside === null,
    { pinned: tipPinned2 !== null, after: tipAfterOutside !== null }
  );
  check(
    '曲名旁边不再标语言（语言只存在档案里，列表不显示）',
    Array.isArray(meterUI?.langChips) && meterUI.langChips.length === 0,
    { langChips: meterUI?.langChips }
  );
  check(
    '曲目树表头收成 7 列：曲名 / 拍号 / BPM / 时期 / 流派 / 调性（时长、段落数、标签数都删了）',
    Array.isArray(meterUI?.headCols) &&
      meterUI.headCols.length === 7 &&
      meterUI.headCols[1] === '曲名' &&
      !meterUI.headCols.some((c: string) => /时长|段落|标签/.test(c)) &&
      meterUI?.rowCols === 7 &&
      meterUI?.headColCount === 7,
    { head: meterUI?.headCols, rowCols: meterUI?.rowCols }
  );

  /* ---- 外文曲名旁的灰色括号译名（中文界面看日文 / 英文曲） ---- */
  const readTitles = async () =>
    (await js(`(() => {
      const tr = (el) => (el ? el.textContent.trim() : null);
      const rows = [...document.querySelectorAll('.tbody .row')].map((r) => ({
        id: r.dataset.trackId,
        title: tr(r.querySelector('.c-title .t')),
        tr: tr(r.querySelector('.c-title .t-tr')),
      }));
      const hit = rows.find((x) => x.title === 'おとなの掟');
      const zhOnly = rows.find((x) => x.title === '神鹿谣');
      const csRow = [...document.querySelectorAll('.sidebar .side-row')]
        .find((b) => b.textContent.includes('和弦符号'));
      return {
        hit,
        zhOnly: zhOnly ? { title: zhOnly.title, tr: zhOnly.tr } : null,
        // 译名的样式：灰色、比曲名小
        trColor: (() => {
          const el = document.querySelector('.tbody .c-title .t-tr');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { color: cs.color, fontSize: cs.fontSize };
        })(),
        // 侧栏「和弦符号」那一行的数字（= 性质条数）
        csCount: csRow ? (csRow.lastElementChild?.textContent ?? '').trim() : null,
        statusText: document.querySelector('footer.status')?.textContent ?? '',
        dbPathInStatus: /atlas\.db/.test(document.querySelector('footer.status')?.textContent ?? ''),
      };
    })()`)) as any;

  const titles = await readTitles();
  check(
    '外文曲名旁显示灰色括号译名（おとなの掟 →（成人法则）），中文曲目不显示',
    titles?.hit?.title === 'おとなの掟' &&
      titles.hit.tr === '（成人法则）' &&
      !!titles?.zhOnly &&
      titles.zhOnly.tr === null,
    titles
  );
  check(
    '译名比曲名更淡更小（不是同一个强调级别）',
    !!titles?.trColor && /^rgba?\(/.test(String(titles.trColor.color)) && parseFloat(titles.trColor.fontSize) < 11.5,
    titles?.trColor
  );
  check(
    '侧栏「和弦符号」那一行显示性质条数，不再是占位的 ×',
    titles?.csCount === String(chordDoc?.qualities?.length ?? -1) && /^\d+$/.test(String(titles?.csCount)),
    { csCount: titles?.csCount, qualities: chordDoc?.qualities?.length }
  );
  check(
    '状态栏换成音频信息（格式 · 采样率 · 位深 · 文件大小），数据库路径不再出现',
    !titles?.dbPathInStatus &&
      /\b(FLAC|WAV|AIFF|MP3|MP4|OGG)\b/.test(String(titles?.statusText)) &&
      /\d+(\.\d)? kHz/.test(String(titles?.statusText)) &&
      /(\d+ bit|有损|lossy)/.test(String(titles?.statusText)) &&
      /[\d.]+ (MB|KB)/.test(String(titles?.statusText)),
    { status: titles?.statusText, dbPath: titles?.dbPathInStatus }
  );

  await js(`window.__app.lang('en')`);
  await wait(360);
  const meterEN = await readMeterUI();
  await hoverTip(true);
  const tipEN = await readTip();
  check(
    '英文界面按英美体系解析：同一个 4/4 变成 Simple meter，说明改讲「中文体系叫复拍子」',
    /Simple meter/i.test(String(meterEN?.text ?? '')) && /(compound|Chinese)/i.test(String((tipEN as any)?.text ?? '')),
    { meter: meterEN, tip: tipEN }
  );
  await hoverTip(false);
  await js(`window.__app.lang('zh')`);
  await wait(360);

  /* ---- 写回档案：派生值不许再落盘（schema v4） ---- */
  const writtenSibyl = writeTrackJson({ db: handle.db, dataDir }, sibylId);
  const sibylDoc = writtenSibyl
    ? JSON.parse(fs.readFileSync(path.join(dataDir, 'tracks', writtenSibyl.file), 'utf8'))
    : null;
  const secWithBar = (sibylDoc?.timeline?.sections ?? []).filter((x: any) => 'bar' in x);
  check(
    '写回 JSON：段落只有 tick（没有小节数）、没有 meterType、语言是短代码',
    !!sibylDoc &&
      secWithBar.length === 0 &&
      (sibylDoc.timeline?.sections ?? []).every((x: any) => typeof x.tick === 'number') &&
      !('meterType' in (sibylDoc.basic ?? {})) &&
      sibylDoc.title?.lang === 'en',
    {
      sections: sibylDoc?.timeline?.sections,
      basic: sibylDoc?.basic,
      lang: sibylDoc?.title?.lang,
    }
  );


  /* ---- 和弦解析：小调级数 + 拼写 + 旧 parsed 回填 ---- */
  // 这首是 e-flat harmonic minor，第三条和弦正是 III。
  // 以前按大调音阶算根音 → G B D；现在按自然小调 → G♭ B♭ D♭。
  // 光改 chord.js 不够：parsed 存在库里，必须靠启动回填才会变（见 backfillParsed）。
  const iiiRows = rows(
    `SELECT e.text, e.parsed FROM analysis_event e
       JOIN analysis a ON a.id = e.analysis_id
       JOIN track t ON t.id = a.track_id
      WHERE t.title = 'The deepest nightmare of Sibyl' AND e.text = 'III'`
  ) as any[];
  const iiiParsed = iiiRows[0]?.parsed ? JSON.parse(iiiRows[0].parsed) : null;
  check(
    'E♭ 和声小调 III = G♭–B♭–D♭（旧 parsed 已按新解析器回填）',
    iiiParsed?.ok === true &&
      JSON.stringify(iiiParsed.pcs) === JSON.stringify([6, 10, 1]) &&
      JSON.stringify(iiiParsed.toneNames) === JSON.stringify(['G♭', 'B♭', 'D♭']),
    { text: iiiRows[0]?.text, pcs: iiiParsed?.pcs, toneNames: iiiParsed?.toneNames }
  );

  /* ---- 挂留 / 延伸音：库里真实存在的 V7sus4 / V9sus4 必须解析成功（v0.41） ---- */
  const susRows = rows(
    `SELECT e.text, e.parsed FROM analysis_event e
       JOIN analysis a ON a.id = e.analysis_id
       JOIN track t ON t.id = a.track_id
      WHERE t.title LIKE '测试 A%' AND e.lane = 'degree'
        AND (e.text LIKE '%sus%' OR e.text LIKE '%add%' OR e.text LIKE '%(6/9)%')`
  ) as any[];
  const susParsed = susRows.map((r) => {
    let p: any = null;
    try {
      p = r.parsed ? JSON.parse(r.parsed) : null;
    } catch {
      p = null;
    }
    return { text: r.text, ok: p?.ok, tones: p?.toneNames, pcs: p?.pcs, quality: p?.quality, err: p?.errors };
  });
  const susOne = susParsed.find((x) => x.text === 'V7sus4');
  const susNine = susParsed.find((x) => x.text === 'V9sus4');
  /** 从根音往上数的半音数（不依赖这首曲子是什么调） */
  const ivOf = (x: any, i: number) =>
    x?.pcs?.[i] != null ? (((x.pcs[i] - x.pcs[0]) % 12) + 12) % 12 : null;
  check(
    '库里的 V7sus4 / V9sus4 解析成功：挂四（根音上方 5 个半音）+ 七音 + 九音都在（以前是「多余字符」直接红字）',
    susParsed.length >= 2 &&
      susParsed.every((x) => x.ok === true) &&
      ivOf(susOne, 1) === 5 &&
      susOne?.pcs?.length === 4 &&
      ivOf(susNine, 1) === 5 &&
      ivOf(susNine, 4) === 2 &&
      susNine?.pcs?.length === 5,
    susParsed
  );

  /* ---- 副属和弦：分子级数要走临时主音自己的音阶 ---- */
  // `iii6/III`：III 是 G♭ 大三和弦，它的 iii 是 G♭ 上方 4 个半音 → B♭ 小三和弦，
  // 第一转位从 D♭ 列起 → D♭–F–B♭。以前分子按本调小调 3 级（3 个半音）算，
  // 得到 A（写成 B♭♭），整组多降一次：B♭♭–D♭♭–F♭。
  const appliedRows = rows(
    `SELECT e.text, e.parsed FROM analysis_event e
       JOIN analysis a ON a.id = e.analysis_id
       JOIN track t ON t.id = a.track_id
      WHERE t.title = 'The deepest nightmare of Sibyl' AND e.text = 'iii6/III'`
  ) as any[];
  const appliedParsed = appliedRows[0]?.parsed ? JSON.parse(appliedRows[0].parsed) : null;
  check(
    'E♭ 和声小调 iii6/III = D♭–F–B♭（分子按临时主音 G♭ 的音阶取三度）',
    appliedParsed?.ok === true &&
      appliedParsed.rootName === 'B♭' &&
      JSON.stringify(appliedParsed.toneNames) === JSON.stringify(['D♭', 'F', 'B♭']),
    { text: appliedRows[0]?.text, root: appliedParsed?.rootName, toneNames: appliedParsed?.toneNames }
  );

  /* ---- 详情栏常驻：没有选区也不能消失（否则画布会跳 26px） ---- */
  await js(`window.__ma.clear()`);
  await wait(120);
  const idleBar = await js(`(() => {
    const bar = document.querySelector('.grid-wrap .selbar');
    return {
      exists: !!bar,
      idle: bar?.classList.contains('idle') ?? false,
      text: bar?.textContent?.trim() ?? '',
    };
  })()`);
  check(
    '详情栏常驻：无选区时仍在，并显示「和声分析详情」占位说明',
    idleBar.exists && idleBar.idle && idleBar.text.includes('和声分析详情'),
    idleBar
  );

  /* ---- 播放头自动选中：扫到哪个和弦就选中哪一格 ----
   * 先显式切到罗马数字视图：视图是**按曲目记住**的（analysis.view_id），
   * 上一次调试停在哪套符号都说得通。不切的话，这条会随「用户上次点了什么」红绿不定
   * —— 同一类坑见 HANDOFF 红线 16（别假设库里的状态）。
   */
  await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('罗马数字级数'))?.click()`);
  await wait(420);
  check(
    '跟随用例的前置：当前是罗马数字视图（级数行）',
    /罗马数字级数/.test(
      String(
        await js(
          `[...document.querySelectorAll('.grid-wrap .toolbar span')].map((s) => s.textContent.trim()).join('|')`
        )
      )
    ),
    {}
  );
  // safe() 包过的钩子回的是 JSON 字符串（跨 IPC 克隆），必须先解析
  const followRaw = await js(`window.__ma.followSelectAt(30720)`);
  const followHit = typeof followRaw === 'string' ? JSON.parse(followRaw) : followRaw;
  await wait(90);
  const followState = await js(`window.__ma.selState()`);
  check(
    '播放头自动选中：III 那一格被选中，详情条给出解析与音名',
    followHit?.startTick === 30720 &&
      followHit?.endTick === 32640 &&
      followState?.follow.owned === true &&
      followState?.follow.highlight === true &&
      followState?.parsed?.ok === true &&
      (followState?.figureHint ?? '') === '',
    { hit: followHit, follow: followState?.follow, parsed: followState?.parsed?.toneNames }
  );

  /* ---- 和弦详情栏只剩撤销 / 重做，胶囊按文字自身宽度 ---- */
  const selbarBar = (await js(`(() => {
    const bar = document.querySelector('.grid-wrap .selbar');
    if (!bar) return null;
    const chips = [...bar.querySelectorAll('button.chip')];
    return {
      labels: chips.map((b) => b.textContent.trim()),
      widths: chips.map((b) => Math.round(b.getBoundingClientRect().width * 10) / 10),
      text: bar.textContent.trim(),
    };
  })()`)) as any;
  check(
    '和弦详情栏只留撤销 / 重做（锚定、输入、删除、Esc 都已拿掉）',
    !!selbarBar &&
      selbarBar.labels.length === 2 &&
      selbarBar.labels[0] === '撤销' &&
      selbarBar.labels[1] === '重做' &&
      !/锚定|输入|删除|Esc/.test(selbarBar.text),
    selbarBar
  );
  check(
    '撤销 / 重做胶囊按文字自身宽度（不再沿用「输入 ↵」的 46px 基准）',
    !!selbarBar &&
      selbarBar.widths.every((w: number) => w > 28 && w < 46) &&
      Math.abs(selbarBar.widths[0] - selbarBar.widths[1]) <= 2,
    selbarBar?.widths
  );

  // quiet 档：选区仍在（详情条要跟着变），但不画高亮框
  await js(`localStorage.setItem('ma-follow-sel', 'quiet'); window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'followSel' } }))`);
  await wait(120);
  const quietState = await js(`window.__ma.selState()`);
  check(
    '自动选中「不高亮」档：选区保留、高亮关闭（详情条仍然可用）',
    quietState?.selection?.startTick === 30720 && quietState?.follow.highlight === false,
    quietState?.follow
  );
  /* ---- 隐藏泳道的标记不该抢走详情栏 ----
   * 第 11 小节（tick 19200）在库里同时压着两条：`function='t'`（黎曼功能泳道）与 `chord='i'`，
   * 而 `ORDER BY tick` 让 function 排在前面。以前选区跨全泳道、`selParsed` 取第一条命中，
   * 于是罗马数字视图里这一小节的详情栏是空的（看起来像「解析不出来」），
   * 双击还会因为「多于一条完全重合」而开出一个空编辑框。
   */
  await js(`window.__ma.followSelectAt(19200)`);
  await wait(140);
  const hiddenSel = await js(`window.__ma.selState()`);
  const gridHead = await js(
    `[...document.querySelectorAll('.grid-wrap .toolbar span')].map((s) => s.textContent.trim()).join('|')`
  );
  const isRomanView = /罗马数字级数/.test(String(gridHead));
  // 同一 tick 上除了 chord 还可能有**用户自己填的 bass**（那是可见泳道，本来就该被选中）。
  // 断言只针对「黎曼的 function 不能混进来」，不能要求「只有一条」—— 那是拿真实数据在做假设。
  const exactLanesNow = ((hiddenSel?.exact ?? []) as any[]).map((e: any) => e.lane);
  const hasChordI = ((hiddenSel?.exact ?? []) as any[]).some((e: any) => e.lane === 'degree' && e.text === 'i');
  const noHiddenFunction = !exactLanesNow.includes('function');
  check(
    '第 11 小节：黎曼功能标记不抢和弦解析（详情栏有音名，双击也不是空框）',
    hiddenSel?.parsed?.ok === true &&
      JSON.stringify(hiddenSel?.parsed?.toneNames) === JSON.stringify(['E♭', 'G♭', 'B♭']) &&
      !!hiddenSel?.editingText &&
      (!isRomanView || (hasChordI && noHiddenFunction && hiddenSel?.items === hiddenSel?.exact?.length)),
    {
      view: gridHead,
      parsed: hiddenSel?.parsed?.toneNames,
      items: hiddenSel?.items,
      exact: hiddenSel?.exact,
      editingText: hiddenSel?.editingText,
    }
  );
  await js(`window.__ma.clear()`);
  await wait(100);

  /* ---- quiet 档：点开别处只是暂时让路，编辑态一关就立刻回到播放头（没有锁） ---- */
  // 旧实现是布尔锁：播放中点过网格就一直不跟了，只有「停止再起播」才解开 ——
  // 用户看到的就是「碰一下别处，指针再扫过去也不选了」（像概率，其实取决于有没有重新起播）。
  await js(`window.__ma.seekTick(19200)`);
  await js(`window.__ma.play()`);
  await wait(260);
  // 「选中 + 开输入框」必须在**同一次 executeJavaScript** 里做完：
  // 分两次调用会中间漏进播放帧，跟随在那一刻把选区抢回播放头（偶发假失败，实测约 1/5）
  const manualSel = await js(`(() => {
    const s = window.__ma.select(20, 0, 0);
    window.__ma.openEdit('');
    return s;
  })()`);
  await wait(240);
  const whileEditing = await js(`window.__ma.selState()`);
  await js(`window.__ma.clear()`);        // 等同「点到别处 / 按 Esc」：编辑态关掉
  await wait(240);
  const afterClose = await js(`window.__ma.selState()`);
  await js(`window.__ma.pause()`);
  check(
    'quiet 档：编辑时跟随让路，关掉编辑态后立刻按播放头重选（没有锁，不用重新起播）',
    whileEditing?.selection?.startTick === manualSel?.startTick &&
      afterClose?.follow?.owned === true &&
      afterClose?.selection?.startTick !== manualSel?.startTick,
    {
      manual: manualSel?.startTick,
      whileEditing: whileEditing?.selection,
      after: afterClose?.selection,
      follow: afterClose?.follow,
    }
  );

  await js(`localStorage.setItem('ma-follow-sel', 'on'); window.dispatchEvent(new CustomEvent('ma:prefs', { detail: { key: 'followSel' } }))`);
  await js(`window.__ma.clear()`);
  await wait(90);

  /**
   * 用户报「波形闪烁」的那首：The deepest nightmare of Sibyl。
   * 它的和弦密（每小节换一次），播放中会频繁触发重绘，最能暴露「重绘把波形带清空」。
   * 分三种状态各验一次：暂停重绘前、暂停重绘后、播放中。
   */
  await js(`window.__ma.seekTick(11520)`);
  await wait(200);
  const sibylBandA = await js(`window.__ma.bandDiff()`);
  await js(`window.__ma.redraw()`);
  await wait(60);
  const sibylBandB = await js(`window.__ma.bandDiff()`);
  await js(`window.__ma.play()`);
  await wait(420);
  const sibylBandPlaying = await js(`window.__ma.bandDiff()`);
  await js(`window.__ma.pause()`);
  await wait(120);
  check(
    'Sibyl：暂停重绘前后与播放中，波形带都还在（不闪成空白）',
    sibylBandA?.differ === true && sibylBandB?.differ === true && sibylBandPlaying?.differ === true,
    { before: sibylBandA, after: sibylBandB, playing: sibylBandPlaying }
  );

  // ---- 曲末：文档长度必须盖住整段音频 ----
  // Sibyl 没登记段落。早先 totalBars 只看段落，48 小节（≈88.6s）就封顶，
  // 而这段录音有 95s —— 最后 6 秒没有格子可画，波形在半截处断掉、播放头跑出右边界。
  await wait(900);
  const sibylDur = (await audioState()).durationMs;
  const docEnd = await js(`window.__ma.docEndMs()`);
  const docBars = await js(`window.__ma.docBars()`);
  check(
    '曲末可画：网格长度覆盖整段音频（波形不在半截处断掉）',
    sibylDur > 0 && docEnd >= sibylDur,
    { docBars, docEndMs: docEnd, durationMs: sibylDur }
  );

  await js(`window.__ma.scrollTo(1e9)`);
  await js(`window.__ma.seekMs(${Math.max(0, sibylDur - 1500)})`);
  await wait(520);
  const endHead = await js(`(() => {
    const el = document.querySelector('.grid-wrap .playhead');
    const box = document.querySelector('.grid-wrap .scroll');
    if (!el || !box) return null;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      opacity: getComputedStyle(el).opacity,
      x: Math.round(r.left),
      boxLeft: Math.round(b.left),
      boxRight: Math.round(b.right),
    };
  })()`);
  check(
    '曲末播放头仍在视野里（没被右边界挤掉）',
    !!endHead &&
      endHead.opacity === '1' &&
      endHead.x > endHead.boxLeft &&
      endHead.x < endHead.boxRight,
    endHead
  );
  await shot('smoke-grid-end.png');
  await js(`window.__ma.pause()`);


  // 真实双击 DOM（不是直接调 store）：证明 LibraryView 的 @dblclick 真的接到了 playRow
  await js(`(() => {
    const row = [...document.querySelectorAll('.row')].find(
      (r) => r.querySelector('.c-title .t')?.textContent?.trim() === '神鹿谣'
    );
    row.querySelector('.c-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await wait(900);
  const dblPlaying = (await audioState()).playing;
  const dblTrack = (await audioState()).name;
  await js(`window.__ma.pause()`);
  check(
    '双击曲名（有音频）→ 选中这一首并直接播放',
    dblPlaying === true && /神鹿谣/.test(String(dblTrack)),
    { dblPlaying, dblTrack }
  );

  // ---- 「以播放头为原点」：先确认，再写库 ----
  // 这个键紧挨着 ±10ms，手滑一次就会把整条对齐整体平移，而偏移没有撤销。
  const originTrack = await js(`window.__app.currentId()`);
  const originAnalysis = await js(`window.api.analysis.get(${JSON.stringify(originTrack)})`);
  const offBefore = originAnalysis?.audioOffsetMs ?? 0;
  await js(`window.__ma.seekMs(2400)`);
  await wait(180);
  const originBtn = await js(`(() => {
    const b = [...document.querySelectorAll('.transport .mini.wide')].find((x) => x.textContent.includes('原点'));
    if (!b) return null;
    b.click();
    return { text: b.textContent.trim(), disabled: b.disabled };
  })()`);
  await wait(280);
  const dlg = await js(`(() => {
    const box = document.querySelector('.modal-mask .modal');
    if (!box) return null;
    const btn = [...box.querySelectorAll('.foot button')];
    const cs = btn[0] ? getComputedStyle(btn[0]) : null;
    return {
      title: box.querySelector('h3')?.textContent?.trim() ?? '',
      body: box.querySelector('.body')?.textContent?.trim() ?? '',
      labels: btn.map((b) => b.textContent.trim()),
      okBg: cs?.backgroundColor ?? '',
      focusTag: document.activeElement?.tagName ?? '',
      focusClass: document.activeElement?.className ?? '',
    };
  })()`);
  const offWhileAsking =
    (await js(`window.api.analysis.get(${JSON.stringify(originTrack)})`))?.audioOffsetMs ?? 0;
  await shot('smoke-confirm-origin.png');
  check(
    '以播放头为原点：先弹确认框并说明会覆盖，此时库里没动',
    !!originBtn &&
      dlg !== null &&
      /原点/.test(dlg.title) &&
      offWhileAsking === offBefore,
    { originBtn, dlg, offBefore, offWhileAsking }
  );

  check(
    '原点确认框同样是「确定在左、实心红、焦点在弹窗上」（与删除作品那套一致）',
    dlg?.labels?.[0] === '设为原点' &&
      dlg?.labels?.[1] === '取消' &&
      dlg?.okBg === 'rgb(201, 71, 63)' &&
      dlg?.focusTag === 'DIV',
    dlg
  );

  // 回车不该替人做决定：这个框里回车一次就会把整条对齐平移
  win!.webContents.focus();
  win!.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' } as any);
  win!.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' } as any);
  await wait(300);
  const offAfterEnter =
    (await js(`window.api.analysis.get(${JSON.stringify(originTrack)})`))?.audioOffsetMs ?? 0;
  const stillOpen = await js(`!!document.querySelector('.modal-mask .modal')`);
  check(
    '原点确认框里按回车不生效：对齐没被覆盖，框也没关',
    offAfterEnter === offBefore && stillOpen === true,
    { offAfterEnter, offBefore, stillOpen }
  );

  // 取消（Esc）：原点保持原样，框收起来
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(240);
  const dlgGone = await js(`!document.querySelector('.modal-mask .modal')`);
  const offAfterEsc =
    (await js(`window.api.analysis.get(${JSON.stringify(originTrack)})`))?.audioOffsetMs ?? 0;
  check(
    '确认框 Esc 取消：原点不变，框关掉',
    dlgGone === true && offAfterEsc === offBefore,
    { dlgGone, offAfterEsc, offBefore }
  );

  // 确认：这时才写库，原点 = 播放头位置。
  // 用 ?.click() 而不是 .click()：这个按钮是 :disabled="!state.ready || !analysis"，
  // 找不到时直接 .click() 会抛「Cannot read properties of undefined」，
  // 把整轮冒烟带崩 —— 一个可选路径不该有能力掀桌子。
  await js(
    `([...document.querySelectorAll('.transport .mini.wide')].find((x) => x.textContent.includes('原点')))?.click()`
  );
  await wait(260);
  // 确认键现在在**左**、实心红（`.chip.danger`）：按类名点，不按「primary」——
  // 危险动作的主按钮统一走危险色，别在测试里写死位置序号
  await js(`document.querySelector('.modal-mask .chip.danger')?.click()`);
  await wait(460);
  const offAfterOk =
    (await js(`window.api.analysis.get(${JSON.stringify(originTrack)})`))?.audioOffsetMs ?? 0;
  check('确认之后才写库：原点变成播放头所在的 2400ms', Math.abs(offAfterOk - 2400) <= 40, {
    offAfterOk,
  });

  // 复原：这条偏移不能留给后面的断言
  await js(
    `window.api.recording.setOffset(${JSON.stringify(originTrack)}, null, ${offBefore})`
  );
  await js(`window.__ma.seekMs(0)`);
  await wait(320);

  // ---- 原点偏移逐版本：改 A 版不能碰 B 版，界面跟着「在听的那一版」走 ----
  // 磁带转录版开头有走带声、CD 抓轨版没有，一个作品只存一份偏移必然有一版对不上。
  const offPair = rows(
    `SELECT track_id AS t, COUNT(*) AS n FROM recording WHERE deleted_at IS NULL
      GROUP BY track_id HAVING n >= 2 ORDER BY n DESC, track_id LIMIT 1`
  )[0];
  const offRecs: any[] = offPair?.t
    ? await js(`window.api.recording.list(${JSON.stringify(offPair.t)})`)
    : [];
  const offRecA = offRecs[0];
  const offRecB = offRecs[1];
  /** 主录音 = 顺序里第一条有文件的，和 defaultRecording 同一个口径 */
  const recPrimary = offRecs.find((r) => r.fileExists) ?? offRecA;
  const aOld = Number(offRecA?.audioOffsetMs) || 0;
  const bOld = Number(offRecB?.audioOffsetMs) || 0;

  let offA: any = null;
  let offB: any = null;
  let offEff = 0;
  if (offRecA && offRecB) {
    await js(`window.api.recording.setOffset(${JSON.stringify(offPair.t)}, ${JSON.stringify(offRecA.id)}, 700)`);
    offA = await js(`window.api.recording.get(${JSON.stringify(offRecA.id)})`);
    offB = await js(`window.api.recording.get(${JSON.stringify(offRecB.id)})`);
    offEff = (await js(`window.api.analysis.get(${JSON.stringify(offPair.t)})`))?.audioOffsetMs ?? 0;

    // 界面：选中这部作品，播放条上的原点输入框应该显示主录音那一份
    await js(`window.__app.select(${JSON.stringify(offPair.t)})`);
    await wait(360);
    const uiOff0 = Number(await js(`document.querySelector('.transport .offset input')?.value ?? ''`));
    // 再改主录音，刷新后输入框要跟着变（证明它读的是「这一版」而不是缓存的旧值）
    await js(`window.api.recording.setOffset(${JSON.stringify(offPair.t)}, null, 1234)`);
    await js(`window.__app.refresh()`);
    await wait(360);
    const uiOff1 = Number(await js(`document.querySelector('.transport .offset input')?.value ?? ''`));
    const wantFirst = recPrimary?.id === offRecA.id ? 700 : Number(recPrimary?.audioOffsetMs) || 0;
    check(
      '播放条原点跟着「在听的那一版」：主录音改了就跟着变',
      uiOff0 === wantFirst && uiOff1 === 1234,
      { uiOff0, uiOff1, wantFirst, primary: recPrimary?.id, a: offRecA.id }
    );
    check(
      'analysis.get 报的是主录音那份偏移（不是迁移前的作品级历史值）',
      offEff === (recPrimary?.id === offRecA.id ? 700 : wantFirst),
      { offEff, wantFirst }
    );
  }
  check(
    '原点偏移逐版本：改 A 版 700ms，B 版一个字没动',
    !!offRecA && !!offRecB && offA?.audioOffsetMs === 700 && offB?.audioOffsetMs === bOld,
    { aOld, bOld, offA: offA?.audioOffsetMs, offB: offB?.audioOffsetMs }
  );

  // 复原：两部作品都得回到原来的偏移与选中项
  if (offRecA && offRecB) {
    await js(`window.api.recording.setOffset(${JSON.stringify(offPair.t)}, ${JSON.stringify(offRecA.id)}, ${aOld})`);
    await js(`window.api.recording.setOffset(${JSON.stringify(offPair.t)}, null, ${Number(recPrimary?.audioOffsetMs) || 0})`);
    await js(`window.__app.select(${JSON.stringify(originTrack)})`);
    await wait(320);
  }

  /* ---- 单击录音版本子行：切到这一版，波形与播放条原点都跟着它 ---- */
  const withFile = (offRecs ?? []).filter((r) => r.fileExists);
  if (withFile.length >= 2) {
    const target = withFile[1];
    const other = withFile[0];
    await js(`window.__app.select(${JSON.stringify(offPair.t)})`);
    await wait(320);
    // 用户可能把这一首的版本树收起了 —— 收着的话子行根本不在 DOM 里
    await js(`(() => {
      const row = document.querySelector('[data-track-id="${offPair.t}"]');
      row?.querySelector('.tw.collapsed')?.click();
      return true;
    })()`);
    await wait(220);

    // 默认模式 = 「暂停并切过去」。先确保是停着的，再看单击的净效果。
    await js(`window.api.player.command({ type: 'pause' })`);
    await wait(400);
    const modeNow = await js(`window.__app.clickVersion()`);
    const clicked = await js(`window.__app.clickVersionRow(${JSON.stringify(target.id)})`);
    await wait(1600);
    const afterClick: any = {
      recId: await js(`window.__app.audioRecId()`),
      src: await js(`window.__app.audioSrc()`),
      status: await js(`window.__app.audioStatus()`),
      playing: (await js(`window.api.player.state()`))?.playing,
      onRow: await js(`document.querySelector('.row.rec-row.on')?.dataset.recId ?? null`),
      uiOff: Number(await js(`document.querySelector('.transport .offset input')?.value ?? ''`)),
    };
    check(
      '单击版本子行：这一版被选中、波形按它重画（不是只改高亮）',
      modeNow === 'pause' &&
        clicked === true &&
        afterClick.recId === target.id &&
        // 协议是 ma-audio://rec/<trackId>/<recId>：recId 在末尾，前面是 trackId 不是 'rec'
        decodeURIComponent(String(afterClick.src)).endsWith(`/${target.id}`) &&
        afterClick.status?.ready === true &&
        afterClick.status?.peaks === true &&
        afterClick.status?.durationMs > 0 &&
        afterClick.onRow === target.id,
      { target: target.id, clicked, modeNow, wantSrc: `…/${target.id}`, ...afterClick }
    );
    check(
      '单击切版本后，播放条的「以播放头为原点」写的是这一版（输入框显示它的偏移）',
      afterClick.uiOff === (Number(target.audioOffsetMs) || 0) && afterClick.playing === false,
      { uiOff: afterClick.uiOff, want: Number(target.audioOffsetMs) || 0, playing: afterClick.playing }
    );

    // 正在播放时单击：默认「暂停并切过去」—— 绝不允许「波形是 A、声音还是 B」
    // 起播走播放条上那颗按钮（和用户按的同一个），再轮询等状态真的落地：
    // 播放是异步的（play() 返回 Promise），固定 sleep 会偶发假失败。
    const startPlaying = async () => {
      await js(`document.querySelector('.transport .tp.play')?.click()`);
      for (let i = 0; i < 15; i++) {
        await wait(200);
        const st: any = await js(`window.api.player.state()`);
        if (st?.playing) return true;
      }
      return false;
    };
    const playingNow = await startPlaying();
    await js(`window.__app.clickVersionRow(${JSON.stringify(other.id)})`);
    await wait(1400);
    const afterPlayingClick: any = {
      playing: (await js(`window.api.player.state()`))?.playing,
      recId: await js(`window.__app.audioRecId()`),
      onRow: await js(`document.querySelector('.row.rec-row.on')?.dataset.recId ?? null`),
    };
    check(
      '播放中单击版本（默认「暂停并切过去」）：声音停下、波形换成点的那一版',
      playingNow === true &&
        afterPlayingClick.playing === false &&
        afterPlayingClick.recId === other.id &&
        afterPlayingClick.onRow === other.id,
      { playingNow, other: other.id, ...afterPlayingClick }
    );

    // 换成「播放中先不切」：同一个动作不该动任何东西，只留一句提示
    await js(`window.__app.clickVersion('ignore')`);
    const ignorePlaying = await startPlaying();
    const beforeIgnore: any = {
      recId: await js(`window.__app.audioRecId()`),
      playing: (await js(`window.api.player.state()`))?.playing,
    };
    await js(`window.__app.clickVersionRow(${JSON.stringify(target.id)})`);
    await wait(700);
    const afterIgnore: any = {
      recId: await js(`window.__app.audioRecId()`),
      playing: (await js(`window.api.player.state()`))?.playing,
      msg: await js(`document.querySelector('.status .dim')?.textContent?.trim() ?? ''`),
    };
    check(
      '首选项改成「播放中先不切」：单击只提示，不换版本也不打断播放',
      ignorePlaying === true &&
        beforeIgnore.playing === true &&
        afterIgnore.playing === true &&
        afterIgnore.recId === beforeIgnore.recId &&
        /暂停/.test(String(afterIgnore.msg)),
      { beforeIgnore, afterIgnore }
    );

    // 收尾：停播 + 模式还原成默认，别把用户的首选项改成测试用的值
    await js(`window.api.player.command({ type: 'pause' })`);
    await js(`window.__app.clickVersion('pause')`);
    await js(`window.__app.select(${JSON.stringify(offPair.t)})`);
    await wait(300);
  }

  // 双击「没音频但有网易云」的：走唤起分支（冒烟里被拦下，断言它打算打开的 deep link）
  await js(`window.__app.playRow(${JSON.stringify(otona)})`);
  await wait(500);
  const dblMsg = await js(`document.querySelector('.status .dim')?.textContent?.trim() ?? ''`);
  const expectedNeteaseLink = 'orpheus://' + Buffer.from(
    JSON.stringify({ type: 'song', id: '458725738', cmd: 'play' })
  ).toString('base64');
  check('双击网易云外链 → 发送官网格式的歌曲播放指令', dblMsg.includes(expectedNeteaseLink), dblMsg);
  const recordingLink = await js(`window.api.link.open('https://music.163.com/song?id=458725738')`);
  check('录音外链与作品外链使用同一播放协议', recordingLink.noteVars?.link === expectedNeteaseLink, recordingLink);
  const invalidLink = await js(`window.api.link.open('file:///C:/test')`);
  check('外链入口拒绝非网页协议', invalidLink.ok === false && invalidLink.noteKey === 'netease.invalidLink', invalidLink);

  // 没有本地音频也必须有可走的播放头：播放键驱动的是「仅时间线」，不是装死
  await js(`window.__ma.seekMs(0)`);
  await wait(150);
  const timelineMode = await js(`window.__maAudio.sourceMode()`);
  const timelineUi = await js(`({
    playDisabled: !!document.querySelector('.transport .tp.play')?.disabled,
    badge: document.querySelector('.transport .chip.timeline')?.textContent?.trim() ?? '',
    originDisabled: !!document.querySelector('.transport .offset .mini.wide')?.disabled
  })`);
  check(
    '无本地音频：播放键与「以播放头为原点」可用，且明确标成仅时间线',
    timelineMode === 'timeline' &&
      timelineUi.playDisabled === false &&
      timelineUi.originDisabled === false &&
      timelineUi.badge.length > 0,
    { timelineMode, ...timelineUi }
  );
  await js(`document.querySelector('.transport .tp.play')?.click()`);
  await wait(450);
  const tl1 = Number(await js(`window.__maAudio.currentMs()`));
  await wait(320);
  const tl2 = Number(await js(`window.__maAudio.currentMs()`));
  await js(`window.api.player.command({ type: 'pause' })`);
  await wait(180);
  const tlPaused = await js(`window.__maAudio.paused()`);
  check(
    '仅时间线播放：指针按墙钟前进，暂停后停住',
    tl2 > tl1 + 150 && tlPaused === true,
    { tl1, tl2, tlPaused }
  );
  await js(`window.__ma.seekMs(0)`);

  // ---- 菜单栏 / 常驻搜索行 / 登记作品 ----
  const labels = await js(
    `[...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim())`
  );
  check(
    '菜单栏 8 项（多了「工作区」），中文版带 (F) 式助记符，原「网格」项已并进视图',
    JSON.stringify(labels) ===
      JSON.stringify(['文件(F)', '编辑(E)', '视图(V)', '搜索(S)', '工作区(W)', '选项(O)', '维护(M)', '帮助(H)']),
    labels
  );
  const brand = await js(`document.querySelector('.titlebar .appname')?.textContent?.trim() ?? null`);
  const tbH = await js(`Math.round(document.querySelector('.titlebar').getBoundingClientRect().height)`);
  const menuH = await js(`Math.round(document.querySelector('.menubar').getBoundingClientRect().height)`);
  check(
    '标题行写项目名，高度 26px（= 系统窗口按钮区，按钮不会压到菜单）',
    brand === 'music·atlas' && tbH === 26,
    { brand, tbH, menuH }
  );

  // 项目名与菜单之间的实际垂直间距。
  // 两边都量**文字墨迹盒**（Range）：一边量行盒一边量墨迹，会把行距/下伸部
  // 算进去，读数跟眼睛看到的不是一回事（改 line-height 就能「骗」过断言）。
  const topGap = await js(`(() => {
    const ink = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect();
    };
    const name = ink(document.querySelector('.titlebar .appname'));
    const menu = ink(document.querySelector('.menubar .menu .top'));
    return {
      gap: Math.round(menu.top - name.bottom),
      nameBottom: Math.round(name.bottom),
      menuTextTop: Math.round(menu.top),
    };
  })()`);
  check('项目名与菜单行贴合：文字之间空白 5~9px', topGap.gap <= 9 && topGap.gap >= 5, topGap);

  // 标题行和菜单行是同一块顶栏：中间不该有分隔线；最左也不该再垫一层内边距
  const barStyle = await js(`(() => {
    const tb = document.querySelector('.titlebar');
    const mb = document.querySelector('.menubar');
    const first = document.querySelector('.menubar .menu .top');
    return {
      titleBorder: getComputedStyle(tb).borderBottomWidth,
      menuPadLeft: getComputedStyle(mb).paddingLeft,
      firstLeft: Math.round(first.getBoundingClientRect().left),
    };
  })()`);
  check(
    '标题行与菜单行之间无分隔线，菜单行最左无多余空隙',
    barStyle.titleBorder === '0px' && barStyle.menuPadLeft === '0px' && barStyle.firstLeft <= 10,
    barStyle
  );

  // 项目标记与菜单文字对成一条竖线：左边距 = 菜单项自己的 padding-left
  const brandAlign = await js(`(() => {
    const ink = (el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect();
    };
    const mark = document.querySelector('.titlebar .mark')?.getBoundingClientRect();
    const first = ink(document.querySelector('.menubar .menu .top'));
    return mark && first
      ? { markLeft: Math.round(mark.left), menuLeft: Math.round(first.left) }
      : null;
  })()`);
  check(
    '项目标记与「文件」文字左对齐（同一条竖线）',
    !!brandAlign && Math.abs(brandAlign.markLeft - brandAlign.menuLeft) <= 1,
    brandAlign
  );

  await js(`document.querySelector('.menubar .menu .top')?.click()`);
  await wait(260);
  const drop = await js(`(() => {
    const d = document.querySelector('.menubar .drop');
    return { shown: !!d, items: d ? [...d.querySelectorAll('.item')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()) : [] };
  })()`);
  check(
    '点「文件」展开下拉，首项是登记作品（Ctrl+R）',
    drop.shown === true && /登记作品/.test(drop.items[0] ?? '') && /Ctrl\+R/.test(drop.items[0] ?? ''),
    drop
  );
  check(
    '「删除作品…」紧跟登记作品下面（文件菜单第 2 项，且没有加速键）',
    /删除作品/.test(drop.items[1] ?? '') && !/Ctrl|Alt|Shift/.test(drop.items[1] ?? ''),
    drop.items
  );
  await shot('smoke-menu.png');
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await wait(120);

  // 编辑菜单里不该再有「删除作品」：同一个动作两个入口，用户会以为它们是两件事
  await js(
    `[...document.querySelectorAll('.menubar .menu .top')].find((b) => b.textContent.includes('编辑'))?.click()`
  );
  await wait(240);
  const editItems = await js(
    `[...document.querySelectorAll('.menubar .drop .item')].map((b) => b.textContent.replace(/\s+/g, ' ').trim())`
  );
  check(
    '编辑菜单里没有「删除作品」（已移到文件菜单）',
    Array.isArray(editItems) && editItems.length > 0 && !editItems.some((x: string) => x.includes('删除作品')),
    editItems
  );
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await wait(120);

  // 点「选项」不展开下拉，直接进选项界面（首选项不再是子菜单）
  await js(
    `[...document.querySelectorAll('.menubar .menu .top')].find((b) => b.textContent.includes('选项'))?.click()`
  );
  await wait(300);
  const optOpen = await js(`(() => ({
    drop: !!document.querySelector('.menubar .drop'),
    title: document.querySelector('.settings h3')?.textContent?.trim() ?? null,
  }))()`);
  check(
    '点「选项」直接打开选项界面：无下拉、面板标题是「选项」',
    optOpen.drop === false && optOpen.title === '选项',
    optOpen
  );
  await js(`window.__app.prefs(false)`);
  await wait(140);

  // 「维护」：孤儿报告、打开 data 目录都收在这一项里
  await js(
    `[...document.querySelectorAll('.menubar .menu .top')].find((b) => b.textContent.includes('维护'))?.click()`
  );
  await wait(240);
  const maintItems = await js(
    `[...document.querySelectorAll('.menubar .drop .item .text')].map((s) => s.textContent.trim())`
  );
  check(
    '「维护」里放孤儿报告和打开 data 目录',
    maintItems.includes('孤儿报告') && maintItems.includes('打开 data 目录'),
    maintItems
  );
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(120);

  /**
   * 英文界面：不只是菜单换词，侧栏 / 表头 / 状态栏 / 详情 / 搜索框 / <html lang> 都要一起换。
   * 只换一半是 i18n 最典型的翻车方式（界面英文、提示中文），所以这里一次全取出来。
   */
  await js(`window.__app.lang('en')`);
  await wait(260);
  const enUI = await js(`(() => ({
    menu: [...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim()),
    // 标题现在是折叠开关，前面多了 ▾ / ▸：断言里先剥掉
    side: [...document.querySelectorAll('.sidebar .side-h')].map((h) =>
      h.textContent.trim().replace(/[▶▼]/g, '').trim()
    ),
    cols: [...document.querySelectorAll('.thead > span')].map((s) => s.textContent.trim()),
    heads: [...document.querySelectorAll('.detail .d-h')].map((h) => h.textContent.trim()),
    status: document.querySelector('.status')?.textContent ?? '',
    clear: document.querySelector('.searchrow .sr-btn')?.textContent?.trim() ?? null,
    placeholder: document.querySelector('.searchrow input.search')?.placeholder ?? '',
    lang: document.documentElement.lang,
    title: document.title,
  }))()`);
  await shot('smoke-en.png');
  await js(`window.__app.lang('zh')`);
  await wait(240);
  const zhBack = await js(`(() => ({
    menu: [...document.querySelectorAll('.menubar .menu .top')].map((b) => b.textContent.trim()),
    side: (document.querySelector('.sidebar .side-h')?.textContent ?? '').replace(/[▶▼]/g, '').trim().trim() || null,
    lang: document.documentElement.lang,
  }))()`);

  check(
    '英文界面：菜单是真的英文（File/Edit/…），不写 (F) 式括号助记符',
    JSON.stringify(enUI.menu) ===
      JSON.stringify(['File', 'Edit', 'View', 'Search', 'Workspace', 'Options', 'Maintenance', 'Help']) &&
      !enUI.menu.some((l: string) => /\([A-Z]\)/.test(l)),
    enUI.menu
  );
  check(
    '英文界面：侧栏 / 表头 / 搜索框 / 详情标题一起换，不留中文',
    enUI.side.includes('Playlists') &&
      enUI.side.includes('Lane presets') &&
      enUI.cols.includes('Title') &&
      enUI.cols.includes('Period') &&
      enUI.heads.includes('Instrumentation') &&
      enUI.clear === 'Clear' &&
      /^Search title/.test(enUI.placeholder) &&
      !/[\u4e00-\u9fff]/.test([...enUI.side, ...enUI.cols, ...enUI.heads].join('|')),
    { side: enUI.side, cols: enUI.cols, heads: enUI.heads, clear: enUI.clear }
  );
  check(
    '英文界面：状态栏是「n results / n result」，<html lang> 也切成 en',
    /^\s*\d+ results?\s*\|/.test(enUI.status) && enUI.lang === 'en',
    { status: enUI.status.slice(0, 40), lang: enUI.lang }
  );
  check(
    '切回中文：菜单恢复 (F) 式助记符、侧栏恢复中文、html lang 回到 zh-CN',
    zhBack.menu[0] === '文件(F)' && zhBack.side === '播放列表' && zhBack.lang === 'zh-CN',
    zhBack
  );

  const searchUi = await js(`(() => {
    const row = document.querySelector('.searchrow');
    if (!row) return { row: false };
    const btns = [...row.querySelectorAll('button')].map((b) => b.textContent.trim());
    return { row: true, btns, hasInput: !!row.querySelector('input.search') };
  })()`);
  check(
    '搜索框常驻，旁边只有「清除」',
    searchUi.row === true && searchUi.hasInput === true &&
      searchUi.btns.length === 1 && searchUi.btns[0] === '清除',
    searchUi
  );

  /**
   * 多词搜索：词之间是 AND、字段之间是 OR。
   * 「钢片琴」「低音提琴」是两个**不同标签**，不可能同时出现在一行字段里，
   * 早先把整句当一个 LIKE 就永远搜不到 —— 越精确反而越空。
   */
  const searchHits = await js(`(async () => {
    const two = await window.__app.search('钢片琴 低音提琴');
    const short = await window.__app.search('神 低音');
    const impossible = await window.__app.search('钢片琴 大号');
    const single = await window.__app.search('钢片琴');
    /**
     * 情绪只存在 track.extra.moods（英文枚举），既不是标签列也不进 FTS。
     * 中文界面上写的是「怀旧」「亲密」，所以必须先把中文翻回枚举才搜得到。
     */
    const moodZh1 = await window.__app.search('怀旧');
    const moodZh2 = await window.__app.search('亲密');
    const moodEn = await window.__app.search('nostalgic');
    const moodMiss = await window.__app.search('怀旧 大号');
    // 别名也在 extra 里（json_tree 只取文本值，不匹配键名）
    const alias = await window.__app.search('成人法则');
    /**
     * 流派：track.genre 存的是词条 name（Jazz / Chamber Music），
     * 中文界面显示的是「爵士」「室内乐」—— 同样必须翻回值才搜得到。
     */
    const genreZh = await window.__app.search('爵士');
    const genreEn = await window.__app.search('Jazz');
    const genreSub = await window.__app.search('室内乐');
    const genreAnd = await window.__app.search('爵士 钢片琴');
    await window.__app.search('');
    return { two, short, impossible, single, moodZh1, moodZh2, moodEn, moodMiss, alias,
             genreZh, genreEn, genreSub, genreAnd };
  })()`);
  check(
    '多词搜索按 AND 匹配：两个标签分开写也能命中同一首，且不含无关曲目',
    Array.isArray(searchHits?.two) &&
      searchHits.two.length === 1 && searchHits.two[0] === '神鹿谣' &&
      // 「神 低音」允许带出别的命中（简介里含「神秘」的曲目本来就算命中「神」）
      searchHits.short.includes('神鹿谣') &&
      searchHits.impossible.length === 0 &&
      searchHits.single.includes('神鹿谣'),
    searchHits
  );

  /**
   * 情绪搜索：「おとなの掟」的 moods 是 ["nostalgic","intimate"]，
   * 中文界面把它显示成「怀旧」「亲密」—— 显示的词搜索必须是同一个词。
   */
  const MOOD_TARGET = 'おとなの掟';
  check(
    '情绪搜索：怀旧 / 亲密 / nostalgic 都命中「おとなの掟」，且不误伤别的曲目',
    [searchHits?.moodZh1, searchHits?.moodZh2, searchHits?.moodEn].every(
      (r: string[]) => Array.isArray(r) && r.length === 1 && r[0] === MOOD_TARGET
    ),
    { zh1: searchHits?.moodZh1, zh2: searchHits?.moodZh2, en: searchHits?.moodEn }
  );
  check(
    '情绪也能参与 AND：怀旧 + 不存在的标签 = 空',
    Array.isArray(searchHits?.moodMiss) && searchHits.moodMiss.length === 0,
    searchHits?.moodMiss
  );
  check(
    '别名（存在 extra 里）能搜到曲目',
    Array.isArray(searchHits?.alias) &&
      searchHits.alias.length === 1 && searchHits.alias[0] === MOOD_TARGET,
    searchHits?.alias
  );

  // 流派：中文 / 英文 / 子类都认，且能和别的词做 AND
  const GENRE_TARGET = '虚构测试数据 · 单簧管与钢琴';
  check(
    '流派搜索：爵士 / Jazz 命中同一首，室内乐命中室内乐作品，流派也能参与 AND',
    Array.isArray(searchHits?.genreZh) &&
      searchHits.genreZh.length === 1 && searchHits.genreZh[0] === GENRE_TARGET &&
      JSON.stringify(searchHits.genreEn) === JSON.stringify(searchHits.genreZh) &&
      Array.isArray(searchHits?.genreSub) &&
      searchHits.genreSub.length === 3 &&
      searchHits.genreSub.every((t: string) => t.startsWith('虚构测试数据')) &&
      Array.isArray(searchHits?.genreAnd) &&
      searchHits.genreAnd.length === 0,
    { zh: searchHits?.genreZh, en: searchHits?.genreEn, sub: searchHits?.genreSub, and: searchHits?.genreAnd }
  );

  // 留一张「搜中文情绪词」的截图：结果是 1 首，不是空表
  await js(`window.__app.search('怀旧')`);
  await wait(180);
  await shot('smoke-search-mood.png');
  await js(`window.__app.search('')`);
  await wait(120);

  // 搜索框不通栏：它筛的是中间这张表，就该只占中间这一列的宽度
  const srGeom = await js(`(() => {
    const row = document.querySelector('.searchrow');
    const main = document.querySelector('.main');
    const side = document.querySelector('.sidebar');
    const win = document.querySelector('.shell');
    if (!row || !main || !side) return null;
    const r = row.getBoundingClientRect(), m = main.getBoundingClientRect(), s = side.getBoundingClientRect();
    const w = win.getBoundingClientRect();
    return {
      parent: row.parentElement?.className ?? '',
      left: Math.round(r.left), right: Math.round(r.right),
      mainLeft: Math.round(m.left), mainRight: Math.round(m.right),
      sideRight: Math.round(s.right), winWidth: Math.round(w.width),
    };
  })()`);
  check(
    '搜索框在中间列顶部、不通栏：与主区等宽，左边紧接侧栏',
    srGeom &&
      srGeom.parent === 'main' &&
      Math.abs(srGeom.left - srGeom.mainLeft) <= 1 &&
      Math.abs(srGeom.right - srGeom.mainRight) <= 1 &&
      srGeom.left >= srGeom.sideRight - 1 &&
      srGeom.right < srGeom.winWidth - 10,
    srGeom
  );

  // 「清除」是常驻动作：空着也能按，不该因为没内容就变灰（那点透明度变化纯属噪音）
  const clearBtn = await js(`(() => {
    const b = document.querySelector('.searchrow .sr-btn');
    return b ? { disabled: b.disabled, opacity: getComputedStyle(b).opacity } : null;
  })()`);
  check(
    '「清除」按钮常亮：搜索框空着也不变灰',
    !!clearBtn && clearBtn.disabled === false && clearBtn.opacity === '1',
    clearBtn
  );

  /**
   * 搜索补全：候选来自词表（乐器 / 演奏技法 / 作曲技法）+ 情绪 + 时期。
   * 用真实 input 事件驱动，走的是和用户完全一样的路径（v-model → watch → 补全）。
   */
  await js(`(() => {
    const i = document.querySelector('.searchrow input.search');
    i.focus();
    i.value = '钢片';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(320);
  const sugList = await js(`[...document.querySelectorAll('.searchrow .sug li')].map((li) => ({
    main: li.querySelector('.s-main')?.textContent?.trim() ?? '',
    hint: li.querySelector('.s-hint')?.textContent?.trim() ?? '',
  }))`);
  await shot('smoke-search-suggest.png');
  // 下拉不能盖住「清除」：它只属于输入框那一块
  const sugGeom = await js(`(() => {
    const wrap = document.querySelector('.search-wrap').getBoundingClientRect();
    const btn = document.querySelector('.sr-btn').getBoundingClientRect();
    const box = document.querySelector('.sug')?.getBoundingClientRect();
    const inp = document.querySelector('.search-wrap input').getBoundingClientRect();
    return {
      wrapRight: Math.round(wrap.right),
      inpRight: Math.round(inp.right),
      btnLeft: Math.round(btn.left),
      boxRight: box ? Math.round(box.right) : null,
      boxTop: box ? Math.round(box.top) : null,
      inpBottom: Math.round(inp.bottom),
    };
  })()`);
  check(
    '补全下拉只盖住输入框那一块：不压「清除」，也不越过输入框下沿',
    !!sugGeom &&
      sugGeom.boxRight !== null &&
      sugGeom.boxRight <= sugGeom.btnLeft &&
      sugGeom.wrapRight <= sugGeom.btnLeft &&
      (sugGeom.boxTop ?? 0) >= sugGeom.inpBottom - 2,
    sugGeom
  );
  await js(
    `document.querySelector('.searchrow input.search').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`
  );
  await wait(100);
  const sugActive = await js(
    `[...document.querySelectorAll('.searchrow .sug li')].findIndex((li) => li.classList.contains('on'))`
  );
  await js(
    `document.querySelector('.searchrow input.search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`
  );
  await wait(460);
  const sugPicked = await js(`document.querySelector('.searchrow input.search').value`);
  const sugRows = await js(
    `[...document.querySelectorAll('.row .c-title .t')].map((x) => x.textContent.trim())`
  );
  check(
    '搜索补全：词表出候选（带维度提示）→ ↓ 选中 → Enter 回填并立即筛选',
    sugList.length > 0 &&
      sugList[0].main === '钢片琴' &&
      sugList[0].hint === '乐器' &&
      sugActive === 0 &&
      sugPicked === '钢片琴 ' &&
      sugRows.includes('神鹿谣'),
    { list: sugList.slice(0, 4), sugActive, sugPicked, sugRows }
  );

  // 流派与情绪也在补全里：提示要写明是哪个字段，不然「爵士」看着像个标签
  await js(`(() => {
    const i = document.querySelector('.searchrow input.search');
    i.focus();
    i.value = '爵';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(340);
  const kindSug = await js(`[...document.querySelectorAll('.searchrow .sug li')].map((li) => ({
    main: li.querySelector('.s-main')?.textContent?.trim() ?? '',
    hint: li.querySelector('.s-hint')?.textContent?.trim() ?? '',
  }))`);
  await js(`(() => {
    const i = document.querySelector('.searchrow input.search');
    i.value = '怀';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(340);
  const moodSugRow = await js(`[...document.querySelectorAll('.searchrow .sug li')].map((li) => ({
    main: li.querySelector('.s-main')?.textContent?.trim() ?? '',
    hint: li.querySelector('.s-hint')?.textContent?.trim() ?? '',
  }))`);
  check(
    '搜索补全里流派 / 情绪各有维度提示（「爵士 · 流派」「怀旧 · 情绪」）',
    kindSug.some((s: any) => s.main === '爵士' && s.hint === '流派') &&
      moodSugRow.some((s: any) => s.main === '怀旧' && s.hint === '情绪'),
    { genre: kindSug, mood: moodSugRow }
  );

  await js(`document.querySelector('.searchrow .sr-btn').click()`);
  await wait(380);
  const clearedVal = await js(`document.querySelector('.searchrow input.search').value`);
  const clearedRows = await js(`document.querySelectorAll('.row').length`);
  const sugGone = await js(`!document.querySelector('.searchrow .sug')`);
  check(
    '「清除」一次清空搜索词、收起补全、恢复全表',
    clearedVal === '' && sugGone === true && clearedRows >= 5,
    { clearedVal, sugGone, clearedRows }
  );

  /**
   * 详情里的标签输入框也用同一套键盘语义：↑↓ 选、Enter 确认。
   * 先显式选回「神鹿谣」—— 上一段双击网易云曲目把选中项换成了「おとなの掟」，
   * 不选回来就会把标签挂到别人身上（这里挂错是真的会改库）。
   */
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await wait(320);
  const compPickerAt = `[...document.querySelectorAll('.detail .picker input')]
    .findIndex((i) => i.placeholder.includes('作曲技法'))`;
  const compIdx = await js(compPickerAt);
  const attachedBefore = rows(
    `SELECT t.display AS d FROM track_tag tt JOIN tag t ON t.id = tt.tag_id WHERE tt.track_id = ?`,
    trackId
  ).map((r) => r.d);
  await js(`(() => {
    const i = document.querySelectorAll('.detail .picker input')[${compIdx}];
    i.focus();
    i.value = '模';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(340);
  const popItems = await js(
    `[...document.querySelectorAll('.detail .picker .pop li')].map((li) => li.textContent.trim())`
  );
  await js(
    `document.querySelectorAll('.detail .picker input')[${compIdx}].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`
  );
  await wait(110);
  const popActive = await js(
    `[...document.querySelectorAll('.detail .picker .pop li')].findIndex((li) => li.classList.contains('on'))`
  );
  const popActiveText = await js(
    `document.querySelector('.detail .picker .pop li.on span')?.textContent?.trim() ?? ''`
  );
  await js(
    `document.querySelectorAll('.detail .picker input')[${compIdx}].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`
  );
  await wait(480);
  const attachedAfter = rows(
    `SELECT t.display AS d FROM track_tag tt JOIN tag t ON t.id = tt.tag_id WHERE tt.track_id = ?`,
    trackId
  ).map((r) => r.d);
  check(
    '详情标签补全：↑↓ 移动光标、Enter 取中那一项并落库',
    compIdx >= 0 &&
      popItems.length >= 2 &&
      popActive === 1 &&
      !!popActiveText &&
      !attachedBefore.includes(popActiveText) &&
      attachedAfter.includes(popActiveText),
    { compIdx, popItems, popActive, popActiveText, attachedAfter }
  );

  /* ---- 标签候选框不许被详情面板裁掉（v0.43：下面放不下就向上开） ---- */
  const readPopBox = async () =>
    (await js(`(() => {
      const list = [...document.querySelectorAll('.detail .picker')];
      const p = list.map((x) => x.querySelector('.pop')).filter(Boolean).pop();
      const d = document.querySelector('.detail');
      if (!p || !d) return null;
      const pr = p.getBoundingClientRect();
      const dr = d.getBoundingClientRect();
      return {
        top: Math.round(pr.top), bottom: Math.round(pr.bottom), h: Math.round(pr.height),
        dTop: Math.round(dr.top), dBottom: Math.round(dr.bottom),
        up: p.classList.contains('up'),
        maxH: Math.round(parseFloat(getComputedStyle(p).maxHeight) || 0),
      };
    })()`)) as any;
  // 先把最后一个标签输入框顶到面板底边：这样它下面几乎没有空间，必须向上开
  await js(`(() => {
    const i = document.querySelectorAll('.detail .picker input')[${compIdx}];
    if (!i) return false;
    i.scrollIntoView({ block: 'end' });
    i.focus();
    i.value = '模';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(380);
  const popNearBottom = await readPopBox();
  check(
    '标签候选框整块落在详情面板里（放不下时 place() 向上开 + 按剩余空间收高，不再被 overflow 裁掉）',
    !!popNearBottom &&
      popNearBottom.top >= popNearBottom.dTop - 1 &&
      popNearBottom.bottom <= popNearBottom.dBottom + 1 &&
      popNearBottom.maxH <= 220,
    popNearBottom
  );
  await js(`(() => {
    const i = document.querySelectorAll('.detail .picker input')[${compIdx}];
    if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); }
    document.querySelector('.detail').scrollTop = 0;
  })()`);
  await wait(260);

  // 摘掉刚挂上的那条，别把「神鹿谣用了什么技法」改掉
  const pickedTag = handle.db.prepare(`SELECT id FROM tag WHERE display = ?`).get(popActiveText) as any;
  if (pickedTag) {
    handle.db.prepare(`DELETE FROM track_tag WHERE track_id = ? AND tag_id = ?`).run(trackId, pickedTag.id);
  }
  await js(`window.__app.refresh()`);
  await wait(200);

  /**
   * 打全一个已有的标签名 → 候选第一条就是它，回车挂的是**既有**标签，不新建同名词条。
   * 这条以前是「候选里没有完全相等的那条」→ 只剩「新建」那一行 → 一按就造出重复标签。
   *
   * 回车最多按两次：上一次用例回车之后详情会整块刷新，偶尔（实测约 1/10）
   * 合成事件落在刚被重建的 input 上就丢了。重试是**安全**的 —— 候选空时走
   * `create()`，而它先 `ensure` 再 attach，命中同名标签只挂不建。
   * 所以「按两次」不改变这条断言要验的东西，只是不让它偶发假失败。
   */
  const compCountBefore = rows(`SELECT COUNT(*) AS c FROM tag WHERE dim = 'composition'`)[0] as any;
  const seqCount = () =>
    (rows(`SELECT COUNT(*) AS c FROM track_tag WHERE track_id = ? AND tag_id = 'sequence'`, trackId)[0] as any).c;
  let compExact: any = null;
  for (let attempt = 0; attempt < 2 && seqCount() === 0; attempt++) {
    await js(`(() => {
      const i = document.querySelectorAll('.detail .picker input')[${compIdx}];
      if (!i) return;
      i.focus();
      i.value = '模进';
      i.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(360);
    if (!compExact) {
      compExact = await js(`(() => ({
        first: document.querySelector('.detail .picker .pop li span')?.textContent?.trim() ?? '',
        how: document.querySelector('.detail .picker .pop li em')?.textContent?.trim() ?? '',
      }))()`);
    }
    await js(`document.querySelectorAll('.detail .picker input')[${compIdx}]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await wait(480);
  }
  const compCountAfter = rows(`SELECT COUNT(*) AS c FROM tag WHERE dim = 'composition'`)[0] as any;
  const seqAttached = { c: seqCount() };
  check(
    '标签框：打全「模进」→ 候选第一条就是它（完全匹配），回车挂既有标签、不新建',
    compExact.first === '模进' &&
      compExact.how === '完全匹配' &&
      compCountAfter.c === compCountBefore.c &&
      seqAttached.c === 1,
    { compExact, before: compCountBefore.c, after: compCountAfter.c, seq: seqAttached.c }
  );
  // 摘干净，别把神鹿谣的技法组合改掉
  handle.db.prepare(`DELETE FROM track_tag WHERE track_id = ? AND tag_id = 'sequence'`).run(trackId);
  await js(`window.__app.refresh()`);
  await wait(200);

  // 侧边栏的「凸起」：右边框 + 一层阴影 + 抬高层级，三者缺一就没有层叠感
  const raise = await js(`(() => {
    const s = document.querySelector('.sidebar');
    const cs = getComputedStyle(s);
    return { shadow: cs.boxShadow, border: cs.borderRightWidth, z: cs.zIndex };
  })()`);
  check(
    '侧边栏做凸起：右边框 + 投影 + 层级抬升',
    raise.shadow !== 'none' && parseFloat(raise.border) >= 1 && Number(raise.z) >= 2,
    raise
  );

  const beforeCreate = await js(`window.api.tracks.list({}).then((r) => r.length)`);
  // 走真实快捷键，而不是直接调函数：验证 Ctrl+R 没被 Electron 默认菜单的「重新加载」抢走
  await js(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true, cancelable: true }))`
  );
  await wait(480);
  const afterCreate = await js(`window.api.tracks.list({}).then((r) => r.length)`);
  const inEdit = await js(`(() => {
    const id = window.__app.editingId();
    const input = id ? document.querySelector('.row .title-edit') : null;
    return { id, focused: document.activeElement === input, value: input?.value ?? null };
  })()`);
  check(
    'Ctrl+R 登记作品：列表多一条，曲名立刻进入输入状态（不触发页面重载）',
    afterCreate === beforeCreate + 1 && !!inEdit.id && inEdit.focused === true,
    { beforeCreate, afterCreate, inEdit }
  );

  // 登记那一刻就把 id 记下来：后面改名若失败，按标题「草稿 A」就找不回来了，
  // 会留一条「未命名作品」在真实曲库里（冒烟不该往用户的列表里丢东西）。
  const draftCreated = await js(`window.__app.editingId()`);

  // 输完回车改名 → 列表与库里都变（右键曲名可再改，走同一个 commitRename）
  await js(`(() => {
    const input = document.querySelector('.row .title-edit');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '草稿 A');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(420);
  const renamed = await js(`window.api.tracks.list({}).then((r) => r.some((x) => x.title === '草稿 A'))`);
  check('行内输入曲名后回车 → 落库', renamed === true, renamed);

  const draftId =
    (await js(`window.api.tracks.list({ text: '草稿 A' }).then((rs) => rs[0]?.id ?? null)`)) ??
    draftCreated;

  /**
   * id 形态：`tr-<8 位 base36 时间>-<10 位 base36 随机>`。
   *
   * 老格式是「时间 + 3 位随机」（36^3 ≈ 4.7 万），批量登记会在同一毫秒里排到同一条 id 上，
   * 而 id 是 `UNIQUE`，撞了这次登记就直接失败。断长度与字符集，不写死某个具体值。
   */
  check(
    '登记的曲目 id 是「前缀 + 8 位时间 + 10 位强随机」',
    /^tr-[0-9a-z]{8}-[0-9a-z]{10}$/.test(String(draftId)),
    draftId
  );

  /* ---- 登记作品必须落一份 JSON 到 data/tracks（这是「源」，库只是索引） ---- */
  await js(`window.api.tracks.update(${JSON.stringify(draftId)}, { subtitle: 'json 同步测试' })`);
  await wait(160);
  const readDraftJson = () => {
    const abs = path.join(jsonDir, '草稿 A.json');
    try {
      return { file: '草稿 A.json', doc: JSON.parse(fs.readFileSync(abs, 'utf8')) };
    } catch {
      return { file: null, doc: null as any };
    }
  };
  const draftJson = readDraftJson();
  // 同一个 uuid 只能有一份文件：多于一份说明「改名」被做成了「另存一份」
  const draftOwned = (() => {
    try {
      return fs
        .readdirSync(jsonDir)
        .filter((f) => f.endsWith('.json'))
        .filter((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8'))?.uuid === draftId;
          } catch {
            return false;
          }
        });
    } catch {
      return [] as string[];
    }
  })();
  check(
    '登记作品 → data/tracks 生成同名 JSON（改名是搬家，不是另存一份）',
    draftJson.doc !== null &&
      draftJson.doc.schemaVersion === 3 &&
      draftJson.doc.uuid === draftId &&
      draftJson.doc.title?.original === '草稿 A' &&
      draftOwned.length === 1 &&
      draftOwned[0] === '草稿 A.json',
    { file: draftJson.file, uuid: draftJson.doc?.uuid, draftId, draftOwned }
  );
  check(
    'JSON 结构合规：作品层字段齐全（basic / timeline / events / instrumentIds；未标注写 null）',
    draftJson.doc?.basic?.meter === null &&
      draftJson.doc?.basic?.bpm === null &&
      draftJson.doc?.timeline?.ppq === 480 &&
      Array.isArray(draftJson.doc?.timeline?.sections) &&
      Array.isArray(draftJson.doc?.timeline?.keys) &&
      Array.isArray(draftJson.doc?.events) &&
      Array.isArray(draftJson.doc?.instrumentIds),
    { basic: draftJson.doc?.basic, timeline: draftJson.doc?.timeline && Object.keys(draftJson.doc.timeline) }
  );
  check(
    '详情改动回写 JSON（文件不是登记那一刻的快照）',
    draftJson.doc?.title?.subtitle === 'json 同步测试',
    draftJson.doc?.title
  );

  /* ---- 删除 = 归档：JSON 移进 .archive，库里只是软删 ---- */
  /**
   * 删除走**真实 UI 路径**：选中 → 文件菜单 → 「删除作品…」 → 确认框 → 点红色确定。
   *
   * 这一段的重点不只是「删掉了」，还有「误删不可能发生」：
   * 确定键在左且实心红、焦点在弹窗上所以回车什么也不做、Esc 直接取消。
   */
  await js(`window.__app.select(${JSON.stringify(draftId)})`);
  await wait(320);
  // 删除前记下它在列表里的位置：删完该停在这个位置的邻居上，而不是被甩回第一行
  const listBeforeDel = (await js(`window.api.tracks.list({}).then((rs) => rs.map((r) => r.id))`)) as string[];
  const delIdx = listBeforeDel.indexOf(draftId as string);

  /** 主窗口的真实按键：走浏览器输入管线，才测得到焦点与默认按钮行为 */
  const winKey = (keyCode: string) => {
    win!.webContents.focus();
    win!.webContents.sendInputEvent({ type: 'keyDown', keyCode } as any);
    win!.webContents.sendInputEvent({ type: 'keyUp', keyCode } as any);
  };
  /** 打开「文件 → 删除作品…」，返回是否点到了那一项 */
  const openDeleteDialog = async () => {
    await js(`document.querySelector('.menubar .menu .top')?.click()`);
    await wait(240);
    const clicked = await js(`(() => {
      const item = [...document.querySelectorAll('.menubar .drop .item')].find((b) =>
        b.textContent.includes('删除作品')
      );
      if (!item) return false;
      item.click();
      return true;
    })()`);
    await wait(340);
    return clicked;
  };

  const openedDelete = await openDeleteDialog();
  const delDlg = await js(`(() => {
    const box = document.querySelector('.modal.confirm');
    if (!box) return null;
    const btn = [...box.querySelectorAll('.confirm-actions button')];
    const cs = btn[0] ? getComputedStyle(btn[0]) : null;
    const cancel = btn[1] ? getComputedStyle(btn[1]) : null;
    return {
      labels: btn.map((b) => b.textContent.trim()),
      okClass: btn[0]?.className ?? '',
      okBg: cs?.backgroundColor ?? '',
      okColor: cs?.color ?? '',
      okHeight: Math.round(btn[0]?.getBoundingClientRect().height ?? 0),
      cancelBg: cancel?.backgroundColor ?? '',
      focusTag: document.activeElement?.tagName ?? '',
      focusClass: document.activeElement?.className ?? '',
    };
  })()`);
  check(
    '删除确认框：确定在**左**且实心红、取消在右；焦点在弹窗容器（不在按钮）',
    openedDelete === true &&
      !!delDlg &&
      JSON.stringify(delDlg.labels) === JSON.stringify(['确定', '取消']) &&
      /danger/.test(delDlg.okClass) &&
      // 深色主题的 --danger = #c9473f；确定键比普通 chip 高一点，是弹窗里唯一的视觉重音
      delDlg.okBg === 'rgb(201, 71, 63)' &&
      delDlg.okColor === 'rgb(255, 255, 255)' &&
      delDlg.okHeight === 26 &&
      delDlg.cancelBg !== delDlg.okBg &&
      delDlg.focusTag === 'DIV' &&
      /confirm/.test(delDlg.focusClass),
    { openedDelete, delDlg }
  );

  // 回车不该替人做决定：既不删、也不取消
  winKey('Enter');
  await wait(320);
  const afterEnter = {
    dialog: await js(`!!document.querySelector('.modal.confirm')`),
    row: rows(`SELECT deleted_at FROM track WHERE id = ?`, draftId)[0] ?? null,
  };
  check(
    '确认框里按回车什么都不发生（不删除、也不关闭）',
    afterEnter.dialog === true && afterEnter.row?.deleted_at === null,
    afterEnter
  );

  // Esc = 取消（安全出口），曲目仍然在
  winKey('Escape');
  await wait(320);
  const afterEsc = {
    dialog: await js(`!!document.querySelector('.modal.confirm')`),
    row: rows(`SELECT deleted_at FROM track WHERE id = ?`, draftId)[0] ?? null,
  };
  check(
    'Esc 关掉确认框且不删除',
    afterEsc.dialog === false && afterEsc.row?.deleted_at === null,
    afterEsc
  );

  // 再来一次，真的点确定
  const reopened = await openDeleteDialog();
  await js(`document.querySelector('.modal.confirm .confirm-actions button')?.click()`);
  await wait(520);
  if (!reopened) console.log('[smoke] 第二次没能打开删除确认框');
  await wait(260);
  /** 按 uuid 认文件，不按文件名：归档重名时会带时间尾号，写死路径会读到别人的 */
  const scanDocs = (dir: string) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            return { file: f, doc: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) };
          } catch {
            return { file: f, doc: null as any };
          }
        });
    } catch {
      return [] as { file: string; doc: any }[];
    }
  };
  const afterRemove = {
    inTracks: scanDocs(jsonDir).filter((j) => j.doc?.uuid === draftId),
    archived: scanDocs(path.join(jsonDir, '.archive')).find((j) => j.doc?.uuid === draftId),
    row: rows(`SELECT deleted_at FROM track WHERE id = ?`, draftId)[0] ?? null,
  };
  check(
    '删除曲目 → JSON 移进 .archive（带 archivedAt），库里是软删不是物理删',
    afterRemove.inTracks.length === 0 &&
      afterRemove.archived?.doc?.uuid === draftId &&
      typeof afterRemove.archived?.doc?.archivedAt === 'number' &&
      typeof afterRemove.row?.deleted_at === 'number',
    {
      inTracks: afterRemove.inTracks.map((j) => j.file),
      archivedFile: afterRemove.archived?.file,
      archivedAt: afterRemove.archived?.doc?.archivedAt,
    }
  );

  /**
   * 删除之后最容易坏的不是数据，是**界面状态**：
   * 选中被 loadRows 自动甩回第一行、音频还挂着已删那首 ——
   * 网格拿「新档案 + 旧音频时长」铺文档，看上去就是时间线渲染错乱。
   */
  const afterDel = {
    sel: await js(`window.__app.currentId()`),
    list: (await js(`window.api.tracks.list({}).then((rs) => rs.map((r) => r.id))`)) as string[],
    audioTrack: await js(`window.__app.audioTrackId()`),
  };
  const neighbor = afterDel.list[Math.min(delIdx < 0 ? 0 : delIdx, afterDel.list.length - 1)] ?? null;
  check(
    '删除后停在原位置的邻居上（不会被甩回列表第一行）',
    afterDel.list.length > 0 && afterDel.sel === neighbor && afterDel.sel !== afterDel.list[0],
    { sel: afterDel.sel, neighbor, first: afterDel.list[0], delIdx }
  );
  check(
    '删除后播放器跟着切到新选中的曲目，不残留已删那首的音频/波形',
    afterDel.audioTrack === afterDel.sel,
    { audioTrack: afterDel.audioTrack, sel: afterDel.sel }
  );
  const gbox = await js(`window.__ma?.box?.() ?? null`);
  check(
    '删除后画布尺寸自洽：位图 / CSS / 容器三者对得上（不会拉伸变形）',
    !!gbox &&
      Math.abs(gbox.pxW / gbox.dpr - gbox.rectW) <= 1 &&
      Math.abs(gbox.pxH / gbox.dpr - gbox.rectH) <= 1 &&
      Math.abs(gbox.rectW - (gbox.hostW - gbox.laneW)) <= 1,
    gbox
  );
  await shot('smoke-after-delete.png');

  /* ---- 彻底删除：归档文件 + 库里的行一起清 ---- */
  const archivedList = (await js(`window.__app.archive(true)`)) as any[];
  const archHit = archivedList.find((a) => a.uuid === draftId);
  const archPanel = (await js(`(() => {
    const modal = [...document.querySelectorAll('.modal')].find((m) => m.querySelector('table.sections'));
    return {
      open: !!modal,
      head: modal?.querySelector('h3')?.textContent?.trim() ?? null,
      rows: modal ? [...modal.querySelectorAll('tbody tr')].map((r) => r.textContent.trim()).slice(0, 3) : [],
    };
  })()`)) as any;
  await js(`window.__app.closeArchive()`);
  check(
    '「已归档作品」面板列出刚删的那首（曲名 + 归档时间）',
    !!archHit &&
      archHit.title === '草稿 A' &&
      archHit.archivedAt > 0 &&
      archPanel.open === true &&
      archPanel.head === '已归档作品' &&
      archPanel.rows.some((r: string) => r.includes('草稿 A')),
    { archHit, archPanel }
  );
  if (archHit) await js(`window.__app.purgeArchived(${JSON.stringify(draftId)})`);
  await wait(220);
  const afterPurge = {
    archivedLeft: scanDocs(path.join(jsonDir, '.archive')).filter((j) => j.doc?.uuid === draftId).length,
    tracksLeft: scanDocs(jsonDir).filter((j) => j.doc?.uuid === draftId).length,
    row: rows(`SELECT COUNT(*) c FROM track WHERE id = ?`, draftId)[0]?.c ?? 0,
    // 软删的孤儿行也不许留：它们列表里看不见，但 COUNT 一查就露馅，而且再也删不掉
    anyDraft: rows(`SELECT COUNT(*) c FROM track WHERE title = '草稿 A'`)[0]?.c ?? 0,
  };
  check(
    '彻底删除 → 归档文件与库里的行都消失（不会下次启动又被 seed 导回来）',
    afterPurge.archivedLeft === 0 &&
      afterPurge.tracksLeft === 0 &&
      afterPurge.row === 0 &&
      afterPurge.anyDraft === 0,
    afterPurge
  );

  await js(`window.__app.refresh()`);
  await wait(260);
  // 草稿已删，select 还指着它 —— 切回被断言的这首，后面的右键/详情断言才有档可看
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await wait(260);

  /* ---- 右键曲名 → 这一行的菜单（v0.77）----
   * 以前一个右键直接进改名：看着快，实际把「这首歌还能干什么」堵死了。
   * 现在先出菜单，改名是第二项 —— 所以断言也拆成两步：菜单在、改名没在；点完才进输入态。
   */
  const openTrackCtx = () =>
    js(`(() => {
      const row = [...document.querySelectorAll('.row')].find(
        (r) => r.querySelector('.c-title .t')?.textContent?.trim() === '神鹿谣'
      );
      if (!row) return false;
      row.querySelector('.c-title').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 300 })
      );
      return true;
    })()`);
  await openTrackCtx();
  await wait(260);
  const ctxMenu = (await js(`(() => {
    const m = document.querySelector('.track-menu');
    return {
      items: [...(m?.querySelectorAll('.ctx-item') ?? [])].map((b) => b.textContent.trim()),
      // 菜单一开就进输入态 = 又变成「右键即改名」了
      editing: !!document.querySelector('.row .title-edit'),
      inViewport: m
        ? (() => {
            const r = m.getBoundingClientRect();
            return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
          })()
        : false,
    };
  })()`)) as any;
  check(
    '右键曲名 → 弹出这一行的菜单：播放 / 更改标题 / 添加到播放列表 / 删除（不再直接进改名）',
    ctxMenu?.items?.length >= 4 &&
      /播放/.test(String(ctxMenu.items[0] ?? '')) &&
      /更改标题/.test(String(ctxMenu.items[1] ?? '')) &&
      ctxMenu.items.some((x: string) => /添加到播放列表/.test(x)) &&
      /删除/.test(String(ctxMenu.items[ctxMenu.items.length - 1] ?? '')) &&
      ctxMenu.editing === false &&
      ctxMenu.inViewport === true,
    ctxMenu
  );
  await shot('smoke-track-menu.png');

  // 入口在**录音行**上，曲目行菜单不该再有这一项（用户明确纠正过：
  // 元数据属于文件，同一作品的两个版本可能是两份完全不同的导出）
  check(
    '曲目行菜单里没有「音频元数据…」（它在录音行上）',
    !ctxMenu.items.some((x: string) => /音频元数据/.test(x)),
    ctxMenu.items
  );
  check(
    '右键菜单第三项是「登记乐章」（紧跟更改标题）',
    /登记乐章/.test(String(ctxMenu.items[2] ?? '')),
    ctxMenu.items
  );

  /* ---- 多乐章作品：分文件 + parentId + 嵌套子行 + 级联删除（决定 53）----
   * 全程走 API（不动 UI 选中态，免得扰动后面的音频元数据用例）。
   * 临时母作品/乐章用 smoke-edit 前缀：万一中断，启动清理也会兜底删掉。 */
  const movParent = (await js(`window.api.tracks.create({ title: 'smoke-edit-mov-p' })`)) as any;
  const movChild = (await js(
    `window.api.tracks.create({ title: 'smoke-edit-mov-c', parentId: ${JSON.stringify(movParent.id)} })`
  )) as any;
  const movDetail = (await js(`window.api.tracks.get(${JSON.stringify(movChild.id)})`)) as any;
  const movList = (await js(`window.api.tracks.list({ limit: 1000 })`)) as any[];
  const movParentRow = movList.find((r) => r.id === movParent.id);
  const movJson = scanDocs(jsonDir).find((j) => j.doc?.uuid === movChild.id);
  check(
    '登记乐章：子项 parentId 指向母作品，库与 JSON 镜像一致',
    movDetail?.parentId === movParent.id && movJson?.doc?.parentId === movParent.id,
    { db: movDetail?.parentId, json: movJson?.doc?.parentId, parent: movParent.id }
  );
  check(
    '顶层列表只列母作品，乐章嵌套在 movements 里（不占顶层行）',
    !!movParentRow &&
      !movList.some((r) => r.id === movChild.id) &&
      (movParentRow.movements ?? []).some((m: any) => m.id === movChild.id),
    {
      parentInList: !!movParentRow,
      childTopLevel: movList.some((r) => r.id === movChild.id),
      movements: movParentRow?.movements?.length ?? 0,
    }
  );
  // 级联软删：删母作品 → 乐章一起软删 + 归档
  await js(`window.api.tracks.remove(${JSON.stringify(movParent.id)})`);
  await wait(120);
  const movAfterDel = {
    parent: rows(`SELECT deleted_at FROM track WHERE id = ?`, movParent.id)[0]?.deleted_at ?? null,
    child: rows(`SELECT deleted_at FROM track WHERE id = ?`, movChild.id)[0]?.deleted_at ?? null,
    childArchived: scanDocs(path.join(jsonDir, '.archive')).some((j) => j.doc?.uuid === movChild.id),
  };
  check(
    '删除母作品 → 乐章子项级联软删 + 归档',
    typeof movAfterDel.parent === 'number' && typeof movAfterDel.child === 'number' && movAfterDel.childArchived,
    movAfterDel
  );
  // 彻底删干净（purge 也级联），不碰演示数据
  await js(`window.__app.purgeArchived(${JSON.stringify(movParent.id)})`);
  await wait(120);
  const movLeft =
    (rows(`SELECT COUNT(*) c FROM track WHERE id = ?`, movParent.id)[0]?.c ?? 0) +
    (rows(`SELECT COUNT(*) c FROM track WHERE id = ?`, movChild.id)[0]?.c ?? 0);
  check('多乐章临时数据彻底删干净（母作品 + 乐章都不留）', movLeft === 0, { movLeft });

  /* ---- 乐章命名与术语补全（决定 54 片 2；术语表按决定 57 拆成速度 + 体裁两张）----
   * 走真实 UI：右键 → 登记乐章 → 默认「第一乐章」+ 光标落尾 →
   * 输入「行」出现术语补全 → ↓ 选「行板」→ 回车两次落库。
   * 临时母作品用 smoke-edit 前缀，结尾整棵删掉。 */
  const movTerms = (await js(`window.api.movement.doc()`)) as any;
  check(
    '乐章标题补全合并两张表：速度 / 表情来自 tempo_marking，舞曲 / 曲式 / 体裁来自 composition_type',
    Array.isArray(movTerms?.terms) &&
      movTerms.tempoCount === 38 &&
      movTerms.terms.length >= 80 &&
      ['tempo', 'character', 'composition'].every((k) => movTerms.terms.some((t: any) => t.kind === k)) &&
      movTerms.terms.some((t: any) => t.name === 'Andante') &&
      movTerms.terms.some((t: any) => t.name === 'Allegretto') &&
      movTerms.terms.some((t: any) => t.name === 'Menuetto') &&
      !movTerms.terms.some((t: any) => t.kind === 'dance' || t.kind === 'form'),
    { n: movTerms?.terms?.length, tempoCount: movTerms?.tempoCount }
  );

  const movUiParent = (await js(`window.api.tracks.create({ title: 'smoke-edit-mov-ui' })`)) as any;
  await js(`window.__app.search('')`);
  await js(`window.__app.refresh()`);
  await wait(300);
  const movUiCtxOpened = await js(`(() => {
    const row = document.querySelector('.row[data-track-id="${movUiParent.id}"]');
    if (!row) return false;
    row.querySelector('.c-title').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 340, clientY: 340 })
    );
    return true;
  })()`);
  await wait(180);
  await js(
    `[...document.querySelectorAll('.track-menu .ctx-item')].find((b) => /登记乐章/.test(b.textContent))?.click()`
  );
  await wait(420);
  const movEditStart = (await js(`(() => {
    const input = document.querySelector('.mov-row .title-edit');
    return input
      ? {
          value: input.value,
          start: input.selectionStart,
          end: input.selectionEnd,
          focused: document.activeElement === input,
        }
      : null;
  })()`)) as any;
  check(
    '登记乐章：默认「第一乐章」，光标落在末尾（前缀不被全选覆盖）',
    movUiCtxOpened === true &&
      movEditStart?.value === '第一乐章' &&
      movEditStart.start === '第一乐章'.length &&
      movEditStart.end === '第一乐章'.length &&
      movEditStart.focused === true,
    { opened: movUiCtxOpened, ...movEditStart }
  );

  // 在默认前缀后打一个「行」：候选应出现行板 / 小行板
  await js(`(() => {
    const input = document.querySelector('.mov-row .title-edit');
    if (!input) return;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, input.value + ' 行');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  })()`);
  await wait(260);
  const movSug = (await js(`[...document.querySelectorAll('.mov-sug li')].map((li) => li.textContent.trim())`)) as string[];
  check(
    '输入「行」→ 标题补全出现（行板 / 小行板，来自速度术语表）',
    movSug.some((s) => s.includes('行板')) && movSug.some((s) => s.includes('小行板')),
    { movSug }
  );
  // 浮层不许留在滚动容器里（RULES 第 19 条）：fixed + 挂 body，并打一次命中测试 ——
  // 量坐标不够，被详情条/表格盖住的元素坐标照样是对的。
  const movSugHit = (await js(`(() => {
    const ul = document.querySelector('.mov-sug');
    const li = ul?.querySelector('li');
    if (!ul || !li) return null;
    const r = li.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 8));
    return {
      pos: getComputedStyle(ul).position,
      inBody: ul.parentElement === document.body,
      inTable: !!ul.closest('.tbody'),
      hitInside: !!hit && ul.contains(hit),
    };
  })()`)) as any;
  check(
    '术语补全浮层：fixed + 挂到 body，点在候选上命中的是它自己（不被表格或详情条盖住）',
    movSugHit?.pos === 'fixed' && movSugHit.inBody && !movSugHit.inTable && movSugHit.hitInside,
    movSugHit ?? {}
  );
  // ↓ 选中第一候选（行板），Enter 接受术语，再 Enter 提交标题
  const keyInMovInput = (key: string) =>
    js(`(() => {
      const input = document.querySelector('.mov-row .title-edit');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
    })()`);
  await keyInMovInput('ArrowDown');
  await wait(100);
  await keyInMovInput('Enter');
  await wait(300);
  const movAfterPick = (await js(`document.querySelector('.mov-row .title-edit')?.value ?? null`)) as string | null;
  await keyInMovInput('Enter');
  await wait(420);
  const movUiChild = rows(
    `SELECT id, title FROM track WHERE parent_id = ? AND deleted_at IS NULL`,
    movUiParent.id
  )[0] as any;
  const movDbTitle = movUiChild?.title;
  check(
    '补全选中「行板」→ 标题变成「第一乐章 行板」，回车后落库',
    movAfterPick === '第一乐章 行板' && movDbTitle === '第一乐章 行板',
    { afterPick: movAfterPick, dbTitle: movDbTitle }
  );
  // 缩进按 2em 算（跟字号走），不是写死一个 px；L 形横臂同步加长，线不会停在空白里
  const movGeom = (await js(`(() => {
    const row = document.querySelector('.mov-row');
    if (!row) return null;
    const fs = parseFloat(getComputedStyle(row).fontSize);
    return {
      fs,
      pad: parseFloat(getComputedStyle(row).paddingLeft),
      arm: parseFloat(getComputedStyle(row, '::after').width),
      wantPad: 40 + 2 * fs,
      wantArm: 10 + 2 * fs,
    };
  })()`)) as any;
  check(
    '乐章子行缩进 = 40px + 两个全角字符（2em），L 形横臂同步延长',
    !!movGeom &&
      Math.abs(movGeom.pad - movGeom.wantPad) < 1.5 &&
      Math.abs(movGeom.arm - movGeom.wantArm) < 1.5,
    movGeom ?? {}
  );
  // 右键「更改标题」没有「刚登记的前缀」可传：要从标题本身认出「第一乐章」，
  // 否则整串拿去匹配、怎么打都不出候选（用户实际遇到的就是这条）。
  const movRenameSug = (await js(`(async () => {
    const row = document.querySelector('.mov-row[data-track-id="${movUiChild.id}"]');
    if (!row) return null;
    row.querySelector('.c-mov')?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 360, clientY: 360 })
    );
    await new Promise((r) => setTimeout(r, 120));
    [...document.querySelectorAll('.track-menu .ctx-item')]
      .find((b) => /更改标题/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 160));
    const input = document.querySelector('.mov-row .title-edit');
    if (!input) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    // 只保留前缀、把术语那一截换成「小步」：没有前缀识别时整串匹配不到任何词
    setter.call(input, '第一乐章 小步');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    await new Promise((r) => setTimeout(r, 220));
    return [...document.querySelectorAll('.mov-sug li')].map((li) => li.textContent.trim());
  })()`)) as string[] | null;
  check(
    '右键「更改标题」后补全也能触发：从标题里认出「第一乐章」前缀，输入「小步」出小步舞曲',
    Array.isArray(movRenameSug) && movRenameSug.some((s) => s.includes('小步舞曲')),
    { items: movRenameSug }
  );
  // 第一次 Esc 只收下拉，第二次才退出改名（标题保持「第一乐章 行板」）
  await js(`(() => {
    const input = document.querySelector('.mov-row .title-edit');
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  })()`);
  await wait(220);
  await js(`window.api.tracks.remove(${JSON.stringify(movUiParent.id)})`);
  await wait(140);
  await js(`window.__app.purgeArchived(${JSON.stringify(movUiParent.id)})`);
  await wait(140);
  await js(`window.__app.refresh()`);
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await wait(260);

  /* ---- 同版音质：同一演奏版本下的转码文件不占独立版本行 ---- */
  const rvTrack = (await js(`window.api.tracks.create({ title: 'smoke-edit-rec-variant' })`)) as any;
  const rvMaster = (await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(rvTrack.id)}, label: '甲版',
       filePath: 'C:/__smoke__/a.flac', format: 'flac', performers: ['甲'] })`
  )) as any;
  const rvChild = (await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(rvTrack.id)}, parentId: ${JSON.stringify(rvMaster.id)},
       filePath: 'C:/__smoke__/a.mp3', format: 'mp3' })`
  )) as any;
  const rvList = (await js(`window.api.recording.list(${JSON.stringify(rvTrack.id)})`)) as any[];
  const rvMasterRow = rvList.find((r) => r.id === rvMaster.id);
  const rvDetail = (await js(`window.api.tracks.get(${JSON.stringify(rvTrack.id)})`)) as any;
  check(
    '同版音质挂在演奏版本下：版本清单只剩父版本，转码在 variants 里',
    rvList.length === 1 &&
      rvMasterRow?.variants?.length === 1 &&
      rvMasterRow.variants[0].id === rvChild.id &&
      rvMasterRow.variants[0].parentId === rvMaster.id &&
      !rvList.some((r) => r.id === rvChild.id) &&
      rvDetail?.recordingVersions?.[0]?.variantCount === 1,
    {
      versions: rvList.length,
      variants: rvMasterRow?.variants?.length,
      summary: rvDetail?.recordingVersions?.[0],
    }
  );
  // 已有的另一条「版本」也可以并进来（避免用户只能删了重加）
  const rvMerge = (await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(rvTrack.id)}, label: '乙版',
       filePath: 'C:/__smoke__/b.ogg', format: 'ogg' })`
  )) as any;
  const rvMerged = (await js(
    `window.api.recording.mergeInto(${JSON.stringify(rvMerge.id)}, ${JSON.stringify(rvMaster.id)})`
  )) as any;
  const rvList2 = (await js(`window.api.recording.list(${JSON.stringify(rvTrack.id)})`)) as any[];
  check(
    '已有版本可并成同版音质：顶层仍是 1 条，variants 变 2 条',
    rvMerged?.parentId === rvMaster.id && rvList2.length === 1 && rvList2[0]?.variants?.length === 2,
    { merged: rvMerged?.parentId, versions: rvList2.length, variants: rvList2[0]?.variants?.length }
  );
  // 删父版本 → 同版音质一起软删（不是留下谁也看不见的孤儿）
  await js(`window.api.recording.remove(${JSON.stringify(rvMaster.id)})`);
  await wait(140);
  const rvAlive = rows(
    `SELECT COUNT(*) c FROM recording WHERE track_id = ? AND deleted_at IS NULL`,
    rvTrack.id
  )[0]?.c;
  check('删除演奏版本 → 同版音质级联软删', rvAlive === 0, { alive: rvAlive });

  /**
   * 取流层也要认同版音质：父版本没绑文件、文件在音质子项上时，
   * `ma-audio://rec/...` 必须回真正的文件（以前这里只查父行 file_path → 404，
   * 表现就是解析说能播、一按播放就「播放失败」）。
   */
  const realAudio = (await js(`window.api.audio.resolve(${JSON.stringify(trackId)})`)) as any;
  const rvNoFile = (await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(rvTrack.id)}, label: '无文件版' })`
  )) as any;
  await js(
    `window.api.recording.save({ trackId: ${JSON.stringify(rvTrack.id)}, parentId: ${JSON.stringify(rvNoFile.id)},
       filePath: ${JSON.stringify(realAudio.path)}, format: 'flac' })`
  );
  const rvPlay = (await js(`(async () => {
    const info = await window.api.audio.resolveRecording(${JSON.stringify(rvTrack.id)}, ${JSON.stringify(rvNoFile.id)});
    const res = await fetch(info.url, { headers: { Range: 'bytes=0-15' } });
    return { exists: info.exists, path: info.path, status: res.status, len: res.headers.get('content-length') };
  })()`)) as any;
  check(
    '音质回退贯穿取流：父版本没绑文件、音质文件在磁盘上时，播放地址不再 404',
    rvPlay?.exists === true &&
      rvPlay?.path === realAudio?.path &&
      rvPlay?.status === 206 &&
      Number(rvPlay?.len) === 16,
    rvPlay
  );
  await js(`window.api.tracks.remove(${JSON.stringify(rvTrack.id)})`);
  await wait(140);
  await js(`window.__app.purgeArchived(${JSON.stringify(rvTrack.id)})`);
  await wait(160);
  await js(`window.__app.refresh()`);
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await wait(260);

  /* ---- 未标注：详情页说「未标注」，网格 / 播放仍按 4/4 · 120 ----
   * 默认值不是标注值：新建 / 缺字段的档案在库里留 NULL，界面显示「未标注」；
   * 网格与播放条没有 marker 时按 4/4 · 120 兜底（GridEditor / TransportBar 本来就这么算）。 */
  const nuTrack = (await js(`window.api.tracks.create({ title: 'smoke-edit-untagged' })`)) as any;
  await js(`window.__app.refresh()`);
  await js(`window.__app.select(${JSON.stringify(nuTrack.id)})`);
  await wait(420);
  const nuDb0 = rows(
    `SELECT a.tempo_value, a.meter_num, a.meter_den,
            (SELECT COUNT(*) FROM analysis_marker m
              WHERE m.analysis_id = a.id AND m.kind IN ('meter','tempo')) AS marks
       FROM analysis a WHERE a.track_id = ? AND a.deleted_at IS NULL`,
    nuTrack.id
  )[0] as any;
  check(
    '新建作品默认「未标注」：库里没有拍号 / 速度，也没有伪造的 4/4 · 120 标记',
    nuDb0?.tempo_value == null &&
      nuDb0?.meter_num == null &&
      nuDb0?.meter_den == null &&
      Number(nuDb0?.marks) === 0,
    nuDb0
  );
  const nuUi0 = (await js(`(() => ({
    meter: document.querySelector('.detail .meter-val')?.textContent?.trim() ?? null,
    bpm: document.querySelector('.detail .bpm-val')?.textContent?.trim() ?? null,
    untagged: document.querySelectorAll('.detail .meter-val.untagged, .detail .bpm-val.untagged').length,
    transMeter: document.querySelector('.transport .meter-cell .num')?.textContent?.trim() ?? null,
    transTempo: document.querySelector('.transport .tempo-val')?.textContent?.trim() ?? null,
  }))()`)) as any;
  check(
    '详情页把空值显示成「未标注」；播放条照常读 4/4 · 120（默认值不写进档案）',
    nuUi0?.meter === '未标注' &&
      nuUi0?.bpm === '未标注' &&
      nuUi0?.untagged === 2 &&
      nuUi0?.transMeter === '4/4' &&
      Number(nuUi0?.transTempo) === 120,
    nuUi0
  );
  // JSON 也写 null：导出再导入不能把「没量过」洗成「量过是 4/4」
  let nuDoc: any = null;
  try {
    nuDoc = JSON.parse(fs.readFileSync(path.join(jsonDir, 'smoke-edit-untagged.json'), 'utf8'));
  } catch {
    nuDoc = null;
  }
  check(
    'JSON：未标注写成 meter / bpm = null（导出再导入仍是未标注）',
    nuDoc?.basic?.meter === null && nuDoc?.basic?.bpm === null,
    { basic: nuDoc?.basic ?? null }
  );

  // 标注 → 留空清除：回到未标注，tick 0 的标记一起撤掉，播放条退回默认
  await editAt('.detail .meter-val', '3/4');
  await editAt('.detail .bpm-val', '96');
  const nuTagged = (await js(`window.api.tracks.get(${JSON.stringify(nuTrack.id)})`)) as any;
  await editAt('.detail .meter-val', '');
  await editAt('.detail .bpm-val', '');
  await wait(260);
  const nuCleared = (await js(`window.api.tracks.get(${JSON.stringify(nuTrack.id)})`)) as any;
  const nuDb1 = rows(
    `SELECT a.tempo_value, a.meter_num,
            (SELECT COUNT(*) FROM analysis_marker m
              WHERE m.analysis_id = a.id AND m.kind IN ('meter','tempo') AND m.tick = 0) AS marks0
       FROM analysis a WHERE a.track_id = ? AND a.deleted_at IS NULL`,
    nuTrack.id
  )[0] as any;
  const nuUi1 = (await js(`(() => ({
    meter: document.querySelector('.detail .meter-val')?.textContent?.trim() ?? null,
    bpm: document.querySelector('.detail .bpm-val')?.textContent?.trim() ?? null,
    transMeter: document.querySelector('.transport .meter-cell .num')?.textContent?.trim() ?? null,
    transTempo: document.querySelector('.transport .tempo-val')?.textContent?.trim() ?? null,
  }))()`)) as any;
  check(
    '详情页留空可清除标注：回到「未标注」，播放条退回 4/4 · 120',
    nuTagged?.meter === '3/4' &&
      nuTagged?.bpm === 96 &&
      nuCleared?.meter === null &&
      nuCleared?.bpm === null &&
      nuDb1?.meter_num == null &&
      nuDb1?.tempo_value == null &&
      Number(nuDb1?.marks0) === 0 &&
      nuUi1?.meter === '未标注' &&
      nuUi1?.bpm === '未标注' &&
      nuUi1?.transMeter === '4/4' &&
      Number(nuUi1?.transTempo) === 120,
    {
      tagged: { meter: nuTagged?.meter, bpm: nuTagged?.bpm },
      cleared: { meter: nuCleared?.meter, bpm: nuCleared?.bpm },
      db: nuDb1,
      ui: nuUi1,
    }
  );
  await js(`window.api.tracks.remove(${JSON.stringify(nuTrack.id)})`);
  await wait(140);
  await js(`window.__app.purgeArchived(${JSON.stringify(nuTrack.id)})`);
  await wait(140);
  await js(`window.__app.refresh()`);
  await js(`window.__app.select(${JSON.stringify(trackId)})`);
  await wait(260);

  /* ---- 音频元数据面板（右键录音行 → 元数据）----
   * 只验「接线通了」：菜单出现、面板能开、标题对、内容区不是空的、Esc 能关。
   * **不**断言具体字段值 —— 那取决于这台机器上关联的音频文件在不在，
   * 冒烟不能因为别人换了一台机器就红。
   */
  const recMenuOpened = await js(`(() => {
    const el = document.querySelector('.rec-item') || document.querySelector('.rec-row');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 460, clientY: 460 }));
    return true;
  })()`);
  await wait(240);
  const recMenuInfo = (await js(`(() => {
    const m = document.querySelector('.rec-menu');
    return { open: !!m, items: [...(m?.querySelectorAll('.ctx-item') ?? [])].map((b) => b.textContent.trim()) };
  })()`)) as any;
  check(
    '右键录音行 → 弹出菜单，里面有「音频元数据…」',
    recMenuOpened === true && recMenuInfo?.open === true && /音频元数据/.test(String(recMenuInfo.items[0] ?? '')),
    { recMenuOpened, recMenuInfo }
  );

  await js(`[...document.querySelectorAll('.rec-menu .ctx-item')].find((b) => /音频元数据/.test(b.textContent))?.click()`);
  await wait(420);
  const metaPanel = (await js(`(() => {
    const p = document.querySelector('.am-panel');
    if (!p) return { open: false };
    const body = p.querySelector('.am-body');
    return {
      open: true,
      title: p.querySelector('h3')?.textContent?.trim() ?? '',
      file: p.querySelector('.am-file')?.textContent?.trim() ?? '',
      hasBody: !!body && (body.textContent ?? '').trim().length > 0,
      sections: [...p.querySelectorAll('.am-sec h4')].map((h) => h.textContent.trim()),
      groups: document.querySelectorAll('.am-group-head').length,
    };
  })()`)) as any;
  check(
    '元数据面板：标题、文件名、内容区都在',
    metaPanel?.open === true && /音频元数据/.test(String(metaPanel.title)) && metaPanel.hasBody === true,
    metaPanel
  );
  await shot('smoke-audio-meta.png');

  // 原始字段默认收起（iXML 能有 70 项）→ 点一下要能铺开
  await js(`document.querySelector('.am-group-head')?.click()`);
  await wait(180);
  const metaRawRows = Number(await js(`document.querySelectorAll('.am-kv-raw dt').length`));
  check(
    '元数据面板：原始分组默认收起，点开后列出字段',
    Number(metaPanel?.groups) === 0 || metaRawRows > 0,
    { groups: metaPanel?.groups, rowsAfterOpen: metaRawRows }
  );

  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await wait(220);
  const metaClosed = await js(`document.querySelector('.am-panel') === null`);
  check('元数据面板：Esc 能关掉（不用非得点遮罩）', metaClosed === true, { metaClosed });

  // 点别处也能关（不只 Esc）—— 这条规矩对两条菜单都成立（RULES 第 23 条）
  await openTrackCtx();
  await wait(200);
  await js(`document.querySelector('.detail')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await wait(160);
  const ctxClosedOutside = await js(`document.querySelector('.track-menu') === null`);

  // 点「更改标题」→ 才进输入态（带着原曲名、已聚焦）
  await openTrackCtx();
  await wait(200);
  await js(
    `[...document.querySelectorAll('.track-menu .ctx-item')].find((b) => /更改标题/.test(b.textContent))?.click()`
  );
  await wait(260);
  const ctxEdit = await js(`(() => {
    const input = document.querySelector('.row .title-edit');
    return { shown: !!input, value: input?.value ?? null, focused: document.activeElement === input };
  })()`);
  check(
    '右键菜单 → 「更改标题」：曲名重新进入输入状态（带着原曲名、已聚焦）；菜单点别处会关',
    ctxClosedOutside === true &&
      ctxEdit.shown === true &&
      ctxEdit.value === '神鹿谣' &&
      ctxEdit.focused === true,
    { ctxClosedOutside, ctxEdit }
  );
  // Esc 取消，曲名不能变
  await js(`(() => {
    const input = document.querySelector('.row .title-edit');
    if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await wait(220);
  const escOk = await js(
    `window.api.tracks.list({ text: '神鹿谣' }).then((r) => r[0]?.title ?? null)`
  );
  check('Esc 取消改名，曲名保持原样', escOk === '神鹿谣', escOk);

  /* ---- 右键 → 添加到播放列表：弹窗选列表，点哪个就进哪个 ---- */
  {
    const plFileNow = path.join(dataDir, 'playlists.json');
    const readDoc = () =>
      fs.existsSync(plFileNow) ? JSON.parse(fs.readFileSync(plFileNow, 'utf8')) : { lists: [] };
    const before = readDoc();
    // 至少得有一条列表可点：没有就先建一条（冒烟副本里建，不动用户的 data）
    if (!before.lists.length) await js(`window.api.playlists.create('冒烟加入测试')`);
    const lists = readDoc().lists;
    const target = lists[0];
    const hadIt = (target?.trackIds ?? []).includes(trackId);

    await openTrackCtx();
    await wait(200);
    await js(
      `[...document.querySelectorAll('.track-menu .ctx-item')].find((b) => /添加到播放列表/.test(b.textContent))?.click()`
    );
    await wait(240);
    const pick = (await js(`(() => {
      const rows = [...document.querySelectorAll('.pl-pick-row')];
      return {
        open: !!document.querySelector('.pl-pick'),
        rows: rows.map((r) => r.querySelector('.pl-pick-name')?.textContent?.trim() ?? ''),
        states: rows.map((r) => r.querySelector('.pl-pick-state')?.textContent?.trim() ?? ''),
        menuClosed: document.querySelector('.track-menu') === null,
      };
    })()`)) as any;
    await shot('smoke-track-plpick.png');
    // 点第一条 → 落盘，并把窗口关掉
    await js(`document.querySelector('.pl-pick-row')?.click()`);
    await wait(320);
    const after = readDoc();
    const hit = after.lists.find((l: any) => l.id === target?.id);
    const closedAfterPick = await js(`document.querySelector('.pl-pick') === null`);
    check(
      '右键 → 「添加到播放列表」弹窗：列出所有列表，点一条就写进 playlists.json 并关窗',
      pick?.open === true &&
        pick.menuClosed === true &&
        pick.rows.length === lists.length &&
        pick.rows[0] === target?.name &&
        !/已在其中/.test(String(pick.states?.[0] ?? '')) &&
        hadIt === false &&
        hit?.trackIds?.includes(trackId) === true &&
        closedAfterPick === true,
      { pick, target: target?.name, hit: hit?.trackIds?.length, hadIt }
    );
    // 收尾：把这一条从列表里拿回去，别影响后面「侧栏列表条数」那些断言
    if (target && !hadIt) {
      await js(
        `window.api.playlists.setTracks(${JSON.stringify(target.id)}, ${JSON.stringify(target.trackIds ?? [])})`
      );
      await js(`window.__app.refreshPlaylists?.()`);
    }
  }

  // ---- 标签维度：乐器 / 乐器演奏技法 / 作曲技法 必须是三套，不能混 ----
  const dims = await js(`window.api.meta().then((m) => m.vocabs.map((v) => v.dim))`);
  check(
    '词表是五套：乐器 / 演奏技法 / 作曲技法 / 流派 / 情绪，互相不混',
    dims.includes('instrument') &&
      dims.includes('instrument_technique') &&
      dims.includes('composition') &&
      dims.includes('genre') &&
      dims.includes('mood') &&
      !dims.includes('technique'),
    dims
  );

  /**
   * 流派与情绪是两张独立词表，且都和时期分开了：
   * 「爵士」必须是流派 Jazz，不是 period = jazz。
   */
  const genreHit = await js(`window.api.tags.suggest('genre', '爵').then((r) => r[0]?.name ?? null)`);
  // 「室内乐」2026-11-04 从流派搬到了体裁：现在要能在 composition_type 里命中 Chamber Music
  const ctHit = await js(`window.api.tags.suggest('composition_type', '室内乐').then((r) => r[0]?.name ?? null)`);
  const formHit = await js(`window.api.tags.suggest('form', '奏鸣曲式').then((r) => r[0]?.id ?? null)`);
  // 赋格两边都能填（体裁 fugue / 曲式 fugue-form），但作曲技法里必须已经删掉
  const fugueType = await js(`window.api.tags.suggest('composition_type', '赋格').then((r) => r[0]?.id ?? null)`);
  const fugueForm = await js(`window.api.tags.suggest('form', '赋格').then((r) => r[0]?.id ?? null)`);
  const fugueTech = (await js(`window.api.tags.suggest('composition', '赋格').then((r) => r.map((x) => x.id))`)) as string[];
  const moodHit = await js(`window.api.tags.suggest('mood', '怀旧').then((r) => r[0]?.id ?? null)`);
  /**
   * 完全相等的候选必须**排第一**且标成 exact。
   * 别名与规范名同分的话，`name.localeCompare` 兜底会让正主排到别人后面 ——
   * 表现就是用户敲完整词，第一个候选却不是他想写的那条。
   */
  const moodExactList = (await js(`window.api.tags.suggest('mood', '神秘')
    .then((r) => r.slice(0, 3).map((x) => ({ id: x.id, how: x.how, exact: x.exact, score: x.score })))`)) as any[];
  const moodPrefixHow = await js(`window.api.tags.suggest('mood', '悲').then((r) => r[0]?.how ?? null)`);
  const jazzPeriod = rows(
    `SELECT COUNT(*) AS c FROM track WHERE deleted_at IS NULL AND period IN ('jazz','folk','pop')`
  )[0] as any;
  check(
    '流派 / 体裁 / 曲式 / 情绪各有词表：「爵」→ Jazz、「室内乐」→ Chamber Music（体裁）、「奏鸣曲式」→ sonata-form、「怀旧」→ nostalgic',
    genreHit === 'Jazz' &&
      ctHit === 'Chamber Music' &&
      formHit === 'sonata-form' &&
      moodHit === 'nostalgic' &&
      jazzPeriod?.c === 0,
    { genreHit, ctHit, formHit, moodHit, jazzPeriod: jazzPeriod?.c }
  );
  check(
    '赋格能填进体裁（fugue）也能填进曲式（fugue-form），但作曲技法里已经没有它',
    fugueType === 'fugue' &&
      fugueForm === 'fugue-form' &&
      Array.isArray(fugueTech) &&
      !fugueTech.includes('fugue'),
    { fugueType, fugueForm, fugueTech }
  );
  check(
    'tags.suggest：完全匹配排第一且 how=exact（不再只返回近似项），前缀命中仍是 prefix',
    moodExactList[0]?.id === 'mysterious' &&
      moodExactList[0]?.how === 'exact' &&
      moodExactList[0]?.exact === true &&
      moodPrefixHow === 'prefix',
    { moodExactList, moodPrefixHow }
  );
  const techHit = await js(
    `window.api.tags.suggest('instrument_technique', 'pizz').then((r) => r[0]?.id ?? null)`
  );
  const compHit = await js(`window.api.tags.suggest('composition', '模进').then((r) => r[0]?.id ?? null)`);
  check(
    '演奏技法与作曲技法各自能检索到，互不串味',
    techHit === 'pizzicato' && compHit === 'sequence',
    { techHit, compHit }
  );

  // 灰ト祈リ 有 FLAC：确认 seed 把 audioPath 同步进了库（不是只有 神鹿谣 能用）
  const haiAudio = await js(`window.api.audio.resolve(${JSON.stringify(hai)})`);
  check(
    '灰ト祈リ 的 FLAC 已随 JSON 绑定进库',
    haiAudio?.exists === true && haiAudio?.format === 'flac',
    { name: haiAudio?.name, format: haiAudio?.format, dur: haiAudio?.durationMs }
  );

  /**
   * ---- 词表编辑器 ----
   * 用户侧路径：点侧栏那一行 → 面板出现（分组 / 列表 / 表单 / 打开 JSON）。
   * 数据侧路径：整棵树回传 → 主进程校验 → 写 JSON → 重载 + sync。
   * 这里两条都走一遍，临时条目最后删干净，不往真实词表里留东西。
   */
  await js(`[...document.querySelectorAll('.sidebar .side-row')].find((b) => b.textContent.includes('作曲技法'))?.click()`);
  await wait(460);
  const veUi = await js(`(() => {
    const m = document.querySelector('.ve-modal');
    if (!m) return { open: false };
    return {
      open: true,
      rows: m.querySelectorAll('.ve-table tbody tr').length,
      groups: m.querySelectorAll('.ve-group').length,
      hasJson: [...m.querySelectorAll('button')].some((b) => b.textContent.includes('JSON')),
      hasTranslation: m.textContent.includes('外语翻译'),
      file: m.querySelector('.ve-actions button')?.getAttribute('title') ?? '',
      formReady: !!m.querySelector('.ve-form input'),
    };
  })()`);
  check(
    '侧栏点词表条目打开编辑器：分组 / 列表 / 别名与外语翻译 / 打开 JSON 都在',
    veUi.open === true &&
      veUi.rows > 10 &&
      veUi.groups > 3 &&
      veUi.hasJson === true &&
      veUi.hasTranslation === true &&
      veUi.formReady === true &&
      /composition\.json$/.test(String(veUi.file)),
    veUi
  );
  // 版式实拍：分组 | 条目表 | 编辑表单 三栏，截图比断言更容易看出挤不挤
  await shot('smoke-vocab-editor.png');

  /**
   * 真实用户路径：选中一条 → 在「别名」里加一个词 → 保存 → 库里立刻能查到。
   * 只验接口不算数：输入框到保存按钮之间还有 dirty 判定和按钮禁用态。
   */
  await js(`(() => {
    const m = document.querySelector('.ve-modal');
    [...m.querySelectorAll('.ve-table tbody tr')].find((r) => r.textContent.includes('sequence'))?.click();
  })()`);
  await wait(200);
  const setAliases = async (value: string) => {
    await js(`(() => {
      const ta = document.querySelector('.ve-form textarea');
      ta.value = ${JSON.stringify(value)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(120);
    await js(`document.querySelector('.ve-save')?.click()`);
    await wait(700);
  };
  await setAliases('sequence, 模进, smoke-ui-alias');
  const uiAliasOn = rows(`SELECT alias FROM tag_alias WHERE tag_id = 'sequence'`).map((r) => r.alias);
  await setAliases('sequence, 模进');
  const uiAliasOff = rows(`SELECT alias FROM tag_alias WHERE tag_id = 'sequence'`).map((r) => r.alias);
  check(
    '词表编辑器里改别名 → 保存：库里多一条检索词；再删掉 → 又消失',
    uiAliasOn.includes('smoke-ui-alias') && !uiAliasOff.includes('smoke-ui-alias'),
    { uiAliasOn, uiAliasOff }
  );

  await js(`document.querySelector('.ve-modal .ve-actions button:last-child')?.click()`);
  await wait(240);
  const veClosed = await js(`!document.querySelector('.ve-modal')`);
  check('词表编辑器可关闭（没有未保存修改时直接关）', veClosed === true, veClosed);

  /**
   * 版式回归：用条目最多的「乐器」（61 条）开一次。
   * 判断标准是几何量而不是感觉：面板四边都在窗口内、表格容器真的产生了纵向可滚距离、
   * 最后一行的底边落在可视区之外（说明超出部分是滚出去的，不是把面板顶高的）。
   */
  await js(`(() => {
    const b = [...document.querySelectorAll('.sidebar .side-row')]
      .find((x) => x.textContent.trim().startsWith('乐器') && !x.textContent.includes('演奏技法'));
    b?.click();
  })()`);
  await wait(520);
  const veFit = await js(`(() => {
    const m = document.querySelector('.ve-modal');
    if (!m) return { open: false };
    const wrap = m.querySelector('.ve-table-wrap');
    const list = m.querySelector('.ve-list');
    const rows = [...wrap.querySelectorAll('.ve-table tbody tr')];
    const last = rows[rows.length - 1];
    const mr = m.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    return {
      open: true,
      rows: rows.length,
      inViewport:
        mr.top >= -0.5 && mr.left >= -0.5 &&
        mr.bottom <= innerHeight + 0.5 && mr.right <= innerWidth + 0.5,
      listBottom: Math.round(list.getBoundingClientRect().bottom),
      modalBottom: Math.round(mr.bottom),
      scrolls: wrap.scrollHeight > wrap.clientHeight + 1,
      lastOut: last ? last.getBoundingClientRect().bottom > wr.bottom + 1 : false,
      scrollH: wrap.scrollHeight,
      clientH: wrap.clientHeight,
      docOverflow: document.documentElement.scrollHeight > innerHeight + 1,
    };
  })()`);
  check(
    '词表条目多时表格在面板内滚动，不溢出窗口边界',
    veFit.open === true &&
      veFit.rows > 30 &&
      veFit.inViewport === true &&
      veFit.listBottom <= veFit.modalBottom &&
      veFit.scrolls === true &&
      veFit.lastOut === true &&
      veFit.docOverflow === false,
    veFit
  );
  await shot('smoke-vocab-editor-long.png');
  await js(`document.querySelector('.ve-modal .ve-actions button:last-child')?.click()`);
  await wait(240);
  const veClosed2 = await js(`!document.querySelector('.ve-modal')`);
  check('长词表面板同样可以关掉', veClosed2 === true, veClosed2);

  const compDoc = (await js(`window.api.vocab.doc('composition')`)) as any;
  const rootsPlus = JSON.parse(JSON.stringify(compDoc.roots));
  rootsPlus
    .find((r: any) => r.id === 'melodic')
    ?.children.push({
      id: 'smoke-temp-tag',
      name: 'smoke temp',
      display: '冒烟临时',
      aliases: ['冒烟别名', '临时标签'],
      translations: { de: 'Rauchprobe', ja: '煙テスト' },
    });
  const savedPlus = await js(`window.api.vocab.save('composition', ${JSON.stringify(rootsPlus)})`);
  await wait(220);
  const tempTag = rows(`SELECT display FROM tag WHERE id = 'smoke-temp-tag'`)[0];
  const tempAliases = rows(`SELECT alias FROM tag_alias WHERE tag_id = 'smoke-temp-tag'`).map((r) => r.alias);
  const compFileRaw = fs.readFileSync(path.join(dataDir, 'vocab', 'composition.json'), 'utf8');
  const deHit = await js(`window.api.tags.suggest('composition', 'Rauchprobe').then((r) => r[0]?.id ?? null)`);
  check(
    '词表保存：新条目 + 别名 + 外语译名写进 JSON，译名也能被检索到',
    savedPlus?.ok === true &&
      tempTag?.display === '冒烟临时' &&
      tempAliases.includes('冒烟别名') &&
      // tag_alias 里存的是 norm() 后的小写，断言也按小写比
      tempAliases.includes('rauchprobe') &&
      compFileRaw.includes('Rauchprobe') &&
      deHit === 'smoke-temp-tag',
    { savedPlus, tempTag, tempAliases, deHit }
  );

  // 删除必须整次拒绝：tooltip 里说明「还有曲目引用」比悄悄删掉安全得多
  const compIds = new Set<string>();
  const collectCompIds = (list: any[]) => {
    for (const n of list ?? []) {
      compIds.add(n.id);
      collectCompIds(n.children ?? []);
    }
  };
  collectCompIds(compDoc.roots);
  const refEntry = Object.entries(compDoc.refs ?? {})
    .filter(([id]) => compIds.has(id))
    .sort((a: any, b: any) => b[1] - a[1])[0];
  const prune = (list: any[], id: string): any[] =>
    list.filter((n) => n.id !== id).map((n) => ({ ...n, ...(n.children ? { children: prune(n.children, id) } : {}) }));
  const refBlocked = refEntry
    ? await js(`window.api.vocab.save('composition', ${JSON.stringify(prune(compDoc.roots, String(refEntry[0])))})`)
    : { ok: true, code: 'no-ref-entry' };
  const refStill = refEntry ? rows(`SELECT display FROM tag WHERE id = ?`, String(refEntry[0])) : [];
  check(
    '有曲目引用的条目不能删：整次保存被拒绝，库与 JSON 都不动',
    refEntry
      ? refBlocked?.ok === false && refBlocked?.code === 'referenced' && refStill.length === 1
      : false,
    { refEntry, refBlocked, refStill }
  );

  const savedBack = await js(`window.api.vocab.save('composition', ${JSON.stringify(compDoc.roots)})`);
  await wait(220);
  const tempGone = rows(`SELECT 1 AS x FROM tag WHERE id = 'smoke-temp-tag'`);
  const compFileBack = fs.readFileSync(path.join(dataDir, 'vocab', 'composition.json'), 'utf8');
  check(
    '删条目（没有引用）：JSON 与库里的 tag 一起清掉，不留孤儿',
    savedBack?.ok === true && tempGone.length === 0 && !compFileBack.includes('smoke-temp-tag'),
    { savedBack, tempGone }
  );

  // ---- 虚构测试数据：10 首，标签交叉组合能精确命中 ----
  const fictions = rows(
    `SELECT title FROM track WHERE deleted_at IS NULL AND title LIKE '虚构测试数据%' ORDER BY title`
  );
  const ficTag = await js(`window.__app.search('虚构测试数据 拨奏')`);
  const ficPeriod = await js(`window.__app.search('虚构测试数据 巴洛克')`);
  const ficTwo = await js(`window.__app.search('虚构测试数据 定音鼓 减值')`);
  check(
    '虚构测试数据：10 首入库，标题前缀 + 技法 / 时期 / 双标签都能组合命中',
    fictions.length === 10 &&
      ficTag.length === 1 &&
      String(ficTag[0]).includes('拨弦练习曲') &&
      ficPeriod.length === 1 &&
      String(ficPeriod[0]).includes('人声花舌') &&
      ficTwo.length === 1 &&
      String(ficTwo[0]).includes('定音鼓'),
    { n: fictions.length, ficTag, ficPeriod, ficTwo }
  );

  /* ---- 波形缓存：切回听过的曲子不再重新解码 ---- */
  const gray = rows(`SELECT id FROM track WHERE title = '灰ト祈リ'`)[0]?.id as string | undefined;
  if (gray) {
    /** 等波形就绪（解码 1–2s；缓存命中时几乎立刻） */
    const waitPeaks = async (budget = 12000) => {
      const t0 = Date.now();
      for (;;) {
        const st: any = await js(`window.__app.audioStatus()`);
        if (st?.peaks) return { ok: true, ms: Date.now() - t0, st };
        if (Date.now() - t0 > budget) return { ok: false, ms: Date.now() - t0, st };
        await wait(120);
      }
    };

    await js(`window.__app.setWaveLimit(64)`);
    // 先把当前曲目换成另一首，否则 select 同一首会短路，压根不走缓存
    await js(`window.__app.select(${JSON.stringify(gray)})`);
    await waitPeaks();
    await js(`window.__app.clearWaveCache()`);
    await wait(300);
    const waveCleared = await js(`window.__app.waveCache()`);

    // 1) 第一次：没有缓存 → 解码 → 写内存 + 落盘
    await js(`window.__app.select(${JSON.stringify(trackId)})`);
    const waveFirst = await waitPeaks();
    await wait(800); // 磁盘写入是异步的
    const waveAfterFirst = await js(`window.__app.waveCache()`);
    check(
      '波形缓存：清空后第一次载入会解码，并把峰值写进内存与磁盘',
      waveCleared.diskFiles === 0 &&
        waveFirst.ok &&
        waveAfterFirst.memItems >= 1 &&
        waveAfterFirst.diskFiles >= 1 &&
        waveAfterFirst.diskBytes > 0,
      { cleared: waveCleared, first: waveFirst, after: waveAfterFirst }
    );

    // 2) 切到别的曲子（这里会解码），再切回来：必须命中，且不进解码态
    await js(`window.__app.select(${JSON.stringify(gray)})`);
    await waitPeaks();
    const beforeBack = await js(`window.__app.waveCache()`);
    const backStart = Date.now();
    await js(`window.__app.select(${JSON.stringify(trackId)})`);
    const waveBack = await waitPeaks(4000);
    const backMs = Date.now() - backStart;
    const afterBack = await js(`window.__app.waveCache()`);
    check(
      '切回听过的曲目：命中缓存（波形立刻回来，命中数增加，不重新解码）',
      waveBack.ok &&
        backMs < 1200 &&
        afterBack.hits > beforeBack.hits &&
        waveBack.st?.decoding !== true,
      { backMs, hits: afterBack.hits, beforeHits: beforeBack.hits, back: waveBack }
    );

    // 3) 上限设成「关闭」：内存与磁盘都清空
    await js(`window.__app.setWaveLimit(0)`);
    await wait(600);
    const waveOff = await js(`window.__app.waveCache()`);
    check(
      '波形缓存设为「关闭」：内存与磁盘立即清空',
      waveOff.limitMb === 0 && waveOff.memItems === 0 && waveOff.diskFiles === 0,
      waveOff
    );
    // 还原成默认值，别把用户的首选项留成 0
    await js(`window.__app.setWaveLimit(64)`);

    // 4) 选项面板里真的有这一节（设置项不是只存在于代码里）
    await js(
      `[...document.querySelectorAll('.menubar .menu .top')].find((b) => b.textContent.includes('选项'))?.click()`
    );
    await wait(320);
    const wavePrefs = await js(`(() => {
      const box = document.querySelector('.settings');
      if (!box) return null;
      const heads = [...box.querySelectorAll('.s-h')].map((h) => h.textContent.trim());
      const sec = [...box.querySelectorAll('.s-sec')].find((s) => s.textContent.includes('波形缓存'));
      return {
        heads,
        chips: sec ? [...sec.querySelectorAll('.chip')].map((c) => c.textContent.trim()) : [],
        usage: sec?.querySelector('.faint.tiny:last-of-type')?.textContent?.trim() ?? '',
      };
    })()`);
    check(
      '选项里有「波形缓存」：上限档位 + 占用显示 + 清空按钮',
      !!wavePrefs &&
        wavePrefs.heads.some((h: string) => h.includes('波形缓存')) &&
        wavePrefs.chips.includes('关闭') &&
        wavePrefs.chips.includes('64 MB') &&
        wavePrefs.chips.includes('清空缓存'),
      wavePrefs
    );
    await js(`document.querySelector('.settings .s-head .chip')?.click()`);
    await wait(200);
  }

  /* ---- 为作者提供经济支持：侧边栏 + 维护/帮助两个菜单 + 收款码弹窗（v0.42） ---- */
  const supportSidebar = (await js(`[...document.querySelectorAll('.sidebar .side-i')]
    .map((b) => b.textContent.trim()).filter((x) => /经济支持/.test(x))`)) as string[];
  const supportMaint = await menuItemsOf('维护');
  const supportHelp = await menuItemsOf('帮助');
  check(
    '「为作者提供经济支持」在侧边栏维护区、维护菜单、帮助菜单三处都有',
    supportSidebar.length === 1 &&
      supportMaint.some((i: any) => String(i.text).includes('经济支持')) &&
      supportHelp.some((i: any) => String(i.text).includes('经济支持')),
    {
      sidebar: supportSidebar,
      maint: supportMaint.map((i: any) => i.text),
      help: supportHelp.map((i: any) => i.text),
    }
  );
  await closeMenus();

  // 点侧边栏那一项 → 弹窗里两张码，微信在左、支付宝在右
  await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => /经济支持/.test(b.textContent))?.click()`);
  await wait(420);
  const supportUI = (await js(`(() => {
    const m = document.querySelector('.support-modal');
    if (!m) return null;
    const figs = [...m.querySelectorAll('.support-qr')].map((f) => ({
      label: f.querySelector('figcaption')?.textContent?.trim() ?? '',
      src: (f.querySelector('img')?.getAttribute('src') ?? '').slice(0, 20),
      w: f.querySelector('img')?.getBoundingClientRect().width ?? 0,
    }));
    return { figs };
  })()`)) as any;
  check(
    '点开收款弹窗：两张码左右并排（微信在左、支付宝在右），图是从 assets 里读出来的 data URL',
    !!supportUI &&
      supportUI.figs.length === 2 &&
      supportUI.figs[0]?.label === '微信' &&
      supportUI.figs[1]?.label === '支付宝' &&
      supportUI.figs.every((f: any) => f.src.startsWith('data:image/') && f.w > 100),
    supportUI
  );
  await shot('smoke-support.png');
  await js(`document.querySelector('.support-modal button')?.click()`);
  await wait(200);
  check('收款弹窗能关掉', (await js(`!!document.querySelector('.support-modal')`)) === false, {});

  /* ---- 缩放：主窗口改缩放，子窗口一起跟；帮助窗连**边界**一起放大（v0.42 / v0.43） ---- */
  await js(`window.api.help.toggle()`); // 开一个帮助窗做对照
  await wait(900);
  const zoomWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('#help')) ?? null;
  const helpBoxAt = async () =>
    (zoomWin && !zoomWin.isDestroyed()
      ? await zoomWin.webContents.executeJavaScript(`(() => {
          const body = document.querySelector('.ah-body');
          const inner = document.querySelector('.ah-inner');
          return {
            // 这两个都是 CSS 像素：和缩放因子无关，用来判「内容有没有被裁」
            bodyH: body ? Math.round(body.clientHeight) : 0,
            bodyScrollH: body ? Math.round(body.scrollHeight) : 0,
            innerH: inner ? Math.round(inner.getBoundingClientRect().height) : 0,
            bodyW: body ? Math.round(body.clientWidth) : 0,
            vw: innerWidth, vh: innerHeight,
          };
        })()`)
      : null) as any;
  const boxAt1 = await helpBoxAt();
  const sizeAt1 = zoomWin && !zoomWin.isDestroyed() ? zoomWin.getContentSize() : null;
  await js(`window.api.ui.setZoom(1.25)`);
  await wait(520);
  const childZoom = zoomWin && !zoomWin.isDestroyed() ? zoomWin.webContents.getZoomFactor() : null;
  const mainZoomNow = win ? win.webContents.getZoomFactor() : null;
  check(
    '主窗口缩放 1.25 → 帮助窗跟着变 1.25（以前只有歌词窗口会跟）',
    Math.abs((mainZoomNow ?? 0) - 1.25) < 0.01 && Math.abs((childZoom ?? 0) - 1.25) < 0.01,
    { main: mainZoomNow, child: childZoom }
  );
  const sizeAt125 = zoomWin && !zoomWin.isDestroyed() ? zoomWin.getContentSize() : null;
  const boxAt125 = await helpBoxAt();
  /**
   * 窗口**边界**要一起放大，否则 1.25 倍的字挤在原来的 520 物理宽里：
   * CSS 视口只剩 416 宽 → 文字全换行 → 内容比窗口高 → 底部被裁掉、要滚动才看得见。
   * 现在物理尺寸 = CSS 尺寸 × 缩放：520×1.25 = 650（见 fitHelpWindow 的注释）。
   */
  check(
    '帮助窗的物理边界跟着缩放放大（520×1.25 = 650），不是只有字变大',
    !!sizeAt125 && Math.abs(sizeAt125[0] - 650) <= 3,
    { at1: sizeAt1, at125: sizeAt125 }
  );
  check(
    '放大后帮助窗的内容**没有被裁**：滚动高 ≤ 可视高、CSS 视口还是 520 宽（排版没被挤窄）',
    !!boxAt125 &&
      boxAt125.bodyScrollH <= boxAt125.bodyH + 2 &&
      Math.abs(boxAt125.vw - 520) <= 6 &&
      Math.abs(boxAt125.bodyW - 520) <= 20,
    { at1: boxAt1, at125: boxAt125 }
  );
  await js(`window.api.ui.setZoom(1)`);
  await wait(320);
  const childZoomBack = zoomWin && !zoomWin.isDestroyed() ? zoomWin.webContents.getZoomFactor() : null;
  check('缩放回到 1 → 帮助窗也跟着回 1', Math.abs((childZoomBack ?? 0) - 1) < 0.01, { child: childZoomBack });
  zoomWin?.close();
  await wait(320);

  /* ---- 拖到空位也必须单独记一步（v0.52 修：moveEvents 只回 moved，旧判定漏了它） ---- */
  /**
   * 用户报的现象：「删除和拖动被合并成一个动作，撤销一次两个一起回来」。
   *
   * 根因不在历史栈，而在 `mutate()` 那句「这次到底有没有改动库」：
   * 它当时只认 `inserted / removed / trimmed`，而 `moveEvents()` 返回的是
   * `{ moved, removed, trimmed }` —— **纯移动**（拖到空处、没压住邻居）三个字段全 0
   * → 一步历史都不记。于是 Ctrl+Z 撤的是上一步（比如刚才那次删除），
   * 看起来就像「删除和拖动被合并了」。
   *
   * 这段专挑「拖到空位」来测。两条纪律（都是第一版假红踩出来的）：
   *  1) 查库要用**当前网格显示的** analysis（`__ma.analysisId()`）—— 测试中途切过曲目，
   *     拿脚本开头的 id 查会一条都查不到，看起来像「什么都没写进去」；
   *  2) tick 一律取 `select()` 的**返回值**，别自己拿「小节号 × 1440」算 ——
   *     `gridOfBar()` 到底 0 起还是 1 起编号接口里没写，算错就差一整小节。
   */
  await js(`window.__ma.unit('beat')`);
  const curAid = ((await js(`window.__ma.analysisId()`)) as string | null) ?? analysisId;
  const occ = rows(
    `SELECT tick, dur_ticks FROM analysis_event WHERE analysis_id = ? ORDER BY tick`,
    curAid
  );
  const busyT = new Set<number>();
  for (const r of occ) {
    for (let t = Number(r.tick); t < Number(r.tick) + Number(r.dur_ticks); t += 240) busyT.add(t);
  }
  const maxEnd = occ.reduce((m: number, r: any) => Math.max(m, Number(r.tick) + Number(r.dur_ticks)), 0);
  const maxBar = Math.max(24, Math.ceil(maxEnd / 1440) + 2);
  let barA = -1;
  for (let bar = 2; bar + 1 <= maxBar; bar++) {
    // 先按 1-based 猜两小节；真正落在哪由下面 select() 的返回值说话
    const s1 = (bar - 1) * 1440;
    const s2 = bar * 1440;
    if ([s1, s2].every((t) => [0, 480, 960].every((d) => !busyT.has(t + d)))) {
      barA = bar;
      break;
    }
  }
  check('拖到空位的用例：找到连续两小节都没有事件的位置', barA > 0, {
    barA,
    maxBar,
    events: occ.length,
    curAid,
  });

  let tA = 0;
  let tB = 0;
  if (barA > 0) {
    const selA = (await js(`window.__ma.select(${barA}, 0, 2)`)) as any;
    const selB = (await js(`window.__ma.select(${barA + 1}, 0, 2)`)) as any;
    tA = Number(selA?.startTick);
    tB = Number(selB?.startTick);
  }
  const pairOk = barA > 0 && tB - tA === 1440;
  check('拖到空位的用例：两小节相邻且都是整小节（1440 tick）', pairOk, { barA, tA, tB });

  if (pairOk) {
    const at = (tick: number) =>
      (rows(
        `SELECT COUNT(*) c FROM analysis_event WHERE analysis_id = ? AND tick >= ? AND tick < ?`,
        curAid,
        tick,
        tick + 1440
      )[0] as any)?.c ?? 0;

    await js(`window.__ma.select(${barA}, 0, 2)`);
    await js(`window.__ma.fill('vi')`);
    let solo = false;
    for (let i = 0; i < 25 && !solo; i++) {
      solo = await js(`window.__ma.events().some((e) => e.tick === ${tA})`);
      if (!solo) await wait(110);
    }
    // 滚到那一带：拖动的 clientX = canvas 左缘 + (文档坐标 - 视口左缘)
    await js(`window.__ma.scrollTo(Math.max(0, window.__ma.xOfTick(${tA}) - 160))`);
    await wait(240);
    const dragOut = (await js(`(() => {
      const ma = window.__ma;
      const cb = ma.canvasBox();
      const vl = ma.viewLeft();
      const y = ma.yOfLane(0);
      const mid = (a, b) => (ma.xOfTick(a) + ma.xOfTick(b)) / 2 - vl;
      const xa = mid(${tA}, ${tA + 1440});
      const xb = mid(${tB}, ${tB + 1440});
      const cv = document.querySelector('canvas');
      if (!cv) return { ok: false };
      const fire = (type, x, buttons) => cv.dispatchEvent(new PointerEvent(type, {
        clientX: cb.left + x, clientY: cb.top + y, button: 0, buttons, pointerId: 23,
        bubbles: true, cancelable: true }));
      fire('pointerdown', xa, 1);
      fire('pointermove', xa + 12, 1);
      fire('pointermove', xb, 1);
      fire('pointerup', xb, 0);
      return { ok: true, xa: Math.round(xa), xb: Math.round(xb), vl };
    })()`)) as any;
    await wait(600);
    check(
      '拖到空位：块确实搬到下一小节（没压住邻居，只走 moved 分支）',
      solo === true && at(tB) === 1 && at(tA) === 0,
      { solo, atA: at(tA), atB: at(tB), drag: dragOut, tA, tB }
    );

    await js(`window.__ma.undo()`);
    await wait(360);
    check(
      '撤销一次只退回拖动：块回到原位、依然存在（修复前这里连块一起消失）',
      at(tA) === 1,
      { atA: at(tA) }
    );

    await js(`window.__ma.undo()`);
    await wait(360);
    check('再撤销一次才撤掉写入：块消失（两步各自独立）', at(tA) === 0, { atA: at(tA) });

    /* ---- 方向键：←/→ 选同泳道前后块；Alt+← 改成「从左边收」（v0.52） ---- */
    const keyDown = (k: string, extra = '') =>
      js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true ${extra} }))`);

    // 在这两小节各写一块，当作「同泳道相邻两块」的样本
    await js(`window.__ma.select(${barA}, 0, 2)`);
    await js(`window.__ma.fill('vi')`);
    await js(`window.__ma.select(${barA + 1}, 0, 2)`);
    await js(`window.__ma.fill('V')`);
    let pair = 0;
    for (let i = 0; i < 25 && pair < 2; i++) {
      pair = (await js(`window.__ma.events().filter((e) => e.tick === ${tA} || e.tick === ${tB}).length`)) as number;
      if (pair < 2) await wait(110);
    }
    check('方向键用例：两小节各写入一块，网格已拿到', pair === 2, { pair, tA, tB });

    /* ---- 方向键 = 光标（v0.89）：←/→ 挪一格，Ctrl+←/→ 才跳块 ---- */
    const selNow = () => js(`window.__ma.selection()`) as Promise<any>;

    // ① 光标化：→ 只挪一格，不是跳到下一块
    await js(`window.__ma.select(${barA}, 0, 1)`);
    await wait(160);
    const cur0 = await selNow();
    await keyDown('ArrowRight');
    await wait(220);
    const cur1 = await selNow();
    check(
      '→ 移动一格（光标化）：停在下一格，不再跳到下一块',
      !!cur0 && !!cur1 && Number(cur1.startTick) > Number(cur0.startTick) && Number(cur1.startTick) < tB,
      { before: cur0, after: cur1, nextBlockAt: tB }
    );

    // ② 光标挪到「有块的格子」上 → 吸附整块
    const beforeBlock = await js(`window.__ma.selectCellAt('degree', ${tB} - 1)`);
    await keyDown('ArrowRight');
    await wait(220);
    const snapped = await selNow();
    check(
      '→ 落到有块的格子 → 吸附成整块（不是只框一格）',
      snapped?.startTick === tB && snapped?.endTick === tB + 1440,
      { beforeBlock, snapped, expect: [tB, tB + 1440] }
    );

    // ③ Ctrl+→ 跳过空格，直接到当前泳道的下一块
    await js(`window.__ma.select(${barA}, 0, 1)`);
    await wait(140);
    await keyDown('ArrowRight', ', ctrlKey: true');
    await wait(240);
    const jumped = await selNow();
    check('Ctrl+→ 跳到当前泳道的下一块（跳过中间的空格）', jumped?.startTick === tB, { sel: jumped, expect: tB });

    /**
     * ④ 「到头停住」：**先站到最后一块**再按。
     * 不能用「连按两下 →」来测 —— 这一行后面还有别的块，第二下当然会过去。
     */
    const chordTicks = (
      rows(
        `SELECT tick FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' ORDER BY tick`,
        curAid
      ) as any[]
    ).map((r) => Number(r.tick));
    const lastTick = chordTicks[chordTicks.length - 1] ?? tB;
    const prevTick = chordTicks[chordTicks.length - 2] ?? tA;

    await js(`window.__ma.selectEvent(${lastTick})`);
    await wait(140);
    await keyDown('ArrowRight', ', ctrlKey: true');
    await wait(240);
    const atEnd = await selNow();
    check('Ctrl+→ 到这一行最后一块就停住（不跨泳道、不越界）', atEnd?.startTick === lastTick, {
      sel: atEnd,
      expect: lastTick,
    });

    await keyDown('ArrowLeft', ', ctrlKey: true');
    await wait(240);
    const leftSel = await selNow();
    check('Ctrl+← 回到同泳道的上一块', leftSel?.startTick === prevTick, { sel: leftSel, expect: prevTick });

    // ⑤ 空泳道里 Ctrl+←/→ 不动（不跨泳道），但光标按 → 照样能挪
    const noteEmpty = Number(
      (rows(`SELECT COUNT(*) c FROM analysis_event WHERE analysis_id = ? AND lane = 'note'`, curAid)[0] as any)?.c ?? 0
    );
    if (noteEmpty === 0) {
      const inNote = await js(`window.__ma.selectCellAt('note', ${tA})`);
      await wait(160);
      await keyDown('ArrowRight', ', ctrlKey: true');
      await wait(220);
      const stillNote = await selNow();
      check(
        '空泳道里 Ctrl+→ 不动（跳块只在当前泳道，跨泳道交给 ↑/↓）',
        stillNote?.lanes?.[0] === 'note' && stillNote?.startTick === (inNote as any)?.startTick,
        { inNote, stillNote }
      );
    }

    // ⑥ 没有选区时按 ← → 在视口左端建一个光标（不再乱跳块）
    await js(`window.__ma.clear()`);
    await wait(160);
    await keyDown('ArrowLeft');
    await wait(240);
    const noSelLeft = await selNow();
    const viewSpan = (await js(`({ vl: window.__ma.viewLeft(), vw: window.__ma.box()?.rectW ?? 0 })`)) as any;
    check(
      '没有选区时按 ← → 在视口左端建一个一格宽的光标',
      !!noSelLeft &&
        Number(noSelLeft.endTick) > Number(noSelLeft.startTick) &&
        Number(noSelLeft.startTick) < Number(viewSpan?.vl ?? 0) + Number(viewSpan?.vw ?? 0),
      { sel: noSelLeft, view: viewSpan }
    );

    // ⑦ Shift+→ 扩一格
    const baseCell = await js(`window.__ma.selectCellAt('degree', ${tA} - 1440)`);
    await wait(160);
    const w0 = Number((baseCell as any)?.endTick) - Number((baseCell as any)?.startTick);
    await keyDown('ArrowRight', ', shiftKey: true');
    await wait(220);
    const widened = await selNow();
    check(
      'Shift+→ 把选区向右扩一格（宽度翻倍）',
      w0 > 0 && Number(widened.endTick) - Number(widened.startTick) === w0 * 2,
      { base: baseCell, widened, w0 }
    );

    // ⑧ Alt 扩成多格之后，→ 只平移、宽度不变（用户明确要的「不改变范围」）
    await js(`window.__ma.selectCellAt('degree', ${tA} - 2880)`);
    await wait(160);
    await keyDown('ArrowRight', ', altKey: true');
    await keyDown('ArrowRight', ', altKey: true');
    await wait(240);
    const wideSel = await selNow();
    const wideW = Number(wideSel.endTick) - Number(wideSel.startTick);
    await keyDown('ArrowRight');
    await wait(240);
    const movedSel = await selNow();
    check(
      'Alt 扩成多格后按 →：整体平移一格，宽度不变',
      wideW > Number((baseCell as any)?.endTick) - Number((baseCell as any)?.startTick) &&
        Number(movedSel.endTick) - Number(movedSel.startTick) === wideW &&
        Number(movedSel.startTick) > Number(wideSel.startTick),
      { wideSel, wideW, movedSel }
    );

    // ⑧b 方向键左右对称：框 N 格，←/→ 各平移 N 格（用户 2026-11-23）
    await js(`window.__ma.select(${barA}, 0, 2)`);
    await wait(160);
    const sym0 = await selNow();
    const symW = Number(sym0.endTick) - Number(sym0.startTick);
    await keyDown('ArrowRight');
    await wait(220);
    const sym1 = await selNow();
    await keyDown('ArrowLeft');
    await wait(220);
    const sym2 = await selNow();
    await keyDown('ArrowLeft');
    await wait(220);
    const sym3 = await selNow();
    check(
      '方向键左右步长一致：框 3 格时 → 走 3 格、← 也走 3 格（不是左 1 右 3）',
      symW > 0 &&
        Number(sym1.startTick) - Number(sym0.startTick) === symW &&
        Number(sym2.startTick) === Number(sym0.startTick) &&
        Number(sym0.startTick) - Number(sym3.startTick) === symW &&
        Number(sym1.endTick) - Number(sym1.startTick) === symW,
      { sym0, sym1, sym2, sym3, symW }
    );

    // ⑧c Backspace 退「当前网格单位」的一格（不是固定一拍），并进入输入
    await js(`window.__ma.select(${barA}, 2, 2)`);
    await wait(160);
    const back0 = await selNow();
    await keyDown('Backspace');
    await wait(260);
    const back1 = await selNow();
    const backEditor = await js(`!!document.querySelector('.cell-input')`);
    const cellW = Number(back0.endTick) - Number(back0.startTick);
    check(
      'Backspace 退回一格（按当前网格单位，不是固定一拍），并进入输入',
      cellW > 0 &&
        Number(back1.startTick) === Number(back0.startTick) - cellW &&
        Number(back1.endTick) - Number(back1.startTick) === cellW &&
        backEditor === true,
      { back0, back1, cellW, backEditor }
    );
    // 收尾：关掉编辑器，免得影响后面的断言
    await js(
      `document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    await wait(200);
    await js(`window.__ma.clear()`);
    await wait(140);

    // ⑧d 播放头步长：Ctrl+Alt+→ 走 3 秒，加 Shift 走一帧（v0.95）
    //      没绑音频 / 音频还没解码完时 `seek` 是空操作，这时整段跳过（不留假失败）
    let audioReady = false;
    for (let i = 0; i < 40; i++) {
      const st = (await audioState()) as any;
      if (st?.ready && Number(st?.durationMs) > 0) {
        audioReady = true;
        break;
      }
      await wait(100);
    }
    if (!audioReady) {
      console.log('[smoke] 音频未就绪，跳过播放头步长与扫过发声的断言');
    }
    if (audioReady) {
    await js(`window.__ma.seekMs(10000)`);
    await wait(220);
    const step0 = Number(((await audioState()) as any)?.currentMs ?? 0);
    await keyDown('ArrowRight', ', ctrlKey: true, altKey: true');
    await wait(280);
    const step1 = Number(((await audioState()) as any)?.currentMs ?? 0);
    await keyDown('ArrowRight', ', ctrlKey: true, altKey: true, shiftKey: true');
    await wait(280);
    const step2 = Number(((await audioState()) as any)?.currentMs ?? 0);
    check(
      'Ctrl+Alt+→ 把播放头往前推 3 秒；再加 Shift 推一帧（30fps ≈ 33ms）',
      Math.abs(step1 - step0 - 3000) <= 2 && Math.abs(step2 - step1 - 1000 / 30) <= 2,
      { step0, step1, step2 }
    );

    // ⑧e 扫过发声：顶栏有开关、点了会落盘；选项里四个帧率口径都在
    const scrubUi = (await js(`(() => {
      const chip = [...document.querySelectorAll('.grid-wrap .toolbar .chip')].find((b) => /扫过发声/.test(b.textContent));
      const read = () => JSON.parse(localStorage.getItem('ma-playback-step') || '{}');
      const before = read().scrubOn;
      chip?.click();
      const mid = read().scrubOn;
      chip?.click();
      const back = read().scrubOn;
      return { has: !!chip, before, mid, back };
    })()`)) as any;
    check(
      '时间线工具栏的「扫过发声」开关能开能关，并且立刻落盘',
      // 默认是开；点一下变关、再点回开（`before` 可能是 undefined —— 文件还没写过）
      scrubUi?.has === true && scrubUi.mid === false && scrubUi.back === true,
      scrubUi
    );

    const frameUi = (await js(`(async () => {
      window.__app.prefs(true);
      await new Promise((r) => setTimeout(r, 300));
      const chips = [...document.querySelectorAll('.settings .chip')].map((b) => b.textContent.trim());
      const hit = [...document.querySelectorAll('.settings .chip')].find((b) => /固定 25/.test(b.textContent));
      hit?.click();
      await new Promise((r) => setTimeout(r, 160));
      const mode = JSON.parse(localStorage.getItem('ma-playback-step') || '{}').frameMode;
      return { chips, mode };
    })()`)) as any;
    await shot('smoke-prefs-step.png');
    check(
      '选项 → 播放里有「跟随 / 自动折半 / 固定 30 / 固定 25」四个帧率口径，选中会落盘',
      frameUi?.mode === '25' &&
        ['跟随播放条', '自动折半', '固定 30 fps', '固定 25 fps'].every((x) =>
          (frameUi?.chips ?? []).some((c: string) => c.includes(x))
        ),
      frameUi
    );

    // 固定 25 fps 之后，Shift 那一步应该是 40ms
    await js(`window.__app.prefs(false)`);
    await wait(220);
    await js(`window.__ma.seekMs(10000)`);
    await wait(200);
    const fms0 = Number(((await audioState()) as any)?.currentMs ?? 0);
    await keyDown('ArrowRight', ', ctrlKey: true, altKey: true, shiftKey: true');
    await wait(260);
    const fms1 = Number(((await audioState()) as any)?.currentMs ?? 0);
    check('把细步长口径改成「固定 25 fps」后，一步是 40ms', Math.abs(fms1 - fms0 - 40) <= 2, { fms0, fms1 });
    }

    // ⑨ 选中出界的格子 → 视图跟着滚（水平跟随）
    //    不能写死一个 tick 就以为它超界：缩放会影响 px/tick，只能让页面自己算出「明确在右边界外」的位置
    const beforeScroll = Number(await js(`window.__ma.viewLeft()`));
    const targetTick = Number(
      (await js(`(() => {
        const limit = window.__ma.viewLeft() + (window.__ma.box()?.rectW ?? 1000) + 500;
        let t = ${lastTick};
        for (let i = 0; i < 4000 && window.__ma.xOfTick(t) < limit; i++) t += 960;
        return t;
      })()`)) ?? 0
    );
    await js(`window.__ma.selectCellAt('degree', ${targetTick})`);
    await wait(300);
    const afterScroll = Number(await js(`window.__ma.viewLeft()`));
    const scrollDiag = await js(`(() => {
      const s = document.querySelector('.scroll');
      return {
        scrollWidth: s?.scrollWidth ?? 0,
        clientWidth: s?.clientWidth ?? 0,
        scrollLeft: s?.scrollLeft ?? 0,
        x1: window.__ma.xOfTick(${targetTick}),
        vw: window.__ma.box()?.viewW ?? 0,
      };
    })()`);
    check('选中视窗之外的格子 → 视图跟着滚过去（水平跟随）', afterScroll > beforeScroll, {
      beforeScroll,
      afterScroll,
      targetTick,
      scrollDiag,
    });

    /* ---- Alt+方向键：不按 Shift 动右端、按住 Shift 动左端（用户 2026-10-31 澄清） ---- */
    /**
     * 每条都先重置成「整小节一块」：`nudgeSpan()` 只在**选区正好等于一条事件**时才动手，
     * 上一条改完长度就变了，接着按会静默不动（第一版就是因为这个连红两条）。
     */
    const resetBlock = async () => {
      /**
       * 固定切回「拍」再选：格号是**当前单位**的格号，
       * 半拍单位下 0..2 只有两拍（960），小节单位下只有 1 格 —— 都会让「整小节一块」的前提不成立。
       */
      await js(`window.__ma.unit('beat')`);
      await js(`window.__ma.select(${barA}, 0, 2)`);
      await js(`window.__ma.fill('vi')`);
      for (let i = 0; i < 20; i++) {
        const ok = await js(
          `window.__ma.events().some((e) => e.tick === ${tA} && e.durTicks === 1440)`
        );
        if (ok) return true;
        await wait(90);
      }
      return false;
    };
    check('Alt+方向键用例：能把选区重置回「整小节一块」', await resetBlock(), { barA, tA });

    await keyDown('ArrowLeft', ', altKey: true');
    await wait(340);
    const trimRight = (await js(`window.__ma.selection()`)) as any;
    check(
      'Alt+← 从**右边**收一格（end 左移、选区变短），左边界不动',
      trimRight?.startTick === tA && trimRight?.endTick === tA + 960,
      { sel: trimRight, expect: [tA, tA + 960] }
    );

    await resetBlock();
    await keyDown('ArrowRight', ', altKey: true');
    await wait(340);
    const growRight = (await js(`window.__ma.selection()`)) as any;
    check(
      'Alt+→ 向右扩一格（end 右移）—— 与 Alt+← 同管右端，一收一放',
      growRight?.startTick === tA && growRight?.endTick === tA + 1920,
      { sel: growRight, expect: [tA, tA + 1920] }
    );

    await resetBlock();
    await keyDown('ArrowRight', ', altKey: true, shiftKey: true');
    await wait(340);
    const trimLeft = (await js(`window.__ma.selection()`)) as any;
    check(
      'Alt+Shift+→ 从左边收一格（start 右移、选区变短）',
      trimLeft?.startTick === tA + 480 && trimLeft?.endTick === tA + 1440,
      { sel: trimLeft, expect: [tA + 480, tA + 1440] }
    );

    await resetBlock();
    await keyDown('ArrowLeft', ', altKey: true, shiftKey: true');
    await wait(340);
    const growLeft = (await js(`window.__ma.selection()`)) as any;
    check(
      'Alt+Shift+← 向左扩一格（start 左移）',
      growLeft?.startTick === tA - 480 && growLeft?.endTick === tA + 1440,
      { sel: growLeft, expect: [tA - 480, tA + 1440] }
    );

    /* ---- 「一格」多宽 = 当前显示单位（小节 / 拍 / 半拍），不是固定一拍（v0.53） ---- */
    const trimAfter = async (u: 'bar' | 'beat' | 'half') => {
      await resetBlock();
      await js(`window.__ma.unit('${u}')`);
      await wait(120);
      await keyDown('ArrowLeft', ', altKey: true');
      await wait(340);
      return (await js(`window.__ma.selection()`)) as any;
    };

    const halfTrim = await trimAfter('half');
    check(
      '单位=半拍：Alt+← 收 240（跟随显示单位，不是固定一拍）',
      halfTrim?.startTick === tA && halfTrim?.endTick === tA + 1200,
      { sel: halfTrim, expect: [tA, tA + 1200] }
    );

    // 小节单位要先把块扩到 2 小节：一拍一格的 Alt+→ 按三次 = +1440
    await js(`window.__ma.unit('beat')`);
    await resetBlock();
    for (let i = 0; i < 3; i++) {
      await keyDown('ArrowRight', ', altKey: true');
      await wait(260);
    }
    const twoBars = (await js(`window.__ma.selection()`)) as any;
    check('单位=小节 的前置：块已扩到 2 小节（2880 tick）', twoBars?.endTick === tA + 2880, {
      sel: twoBars,
      expect: tA + 2880,
    });

    await js(`window.__ma.unit('bar')`);
    await wait(120);
    await keyDown('ArrowLeft', ', altKey: true');
    await wait(340);
    const barTrim = (await js(`window.__ma.selection()`)) as any;
    check(
      '单位=小节：Alt+← 收整整一小节（1440），不是一拍',
      barTrim?.startTick === tA && barTrim?.endTick === tA + 1440,
      { sel: barTrim, expect: [tA, tA + 1440] }
    );

    // 收尾切回拍，别把这个状态留给后面的断言/截图
    await js(`window.__ma.unit('beat')`);

    /* ---- 输入态：输入框往右下偏移、Alt+方向键也能改选区大小（v0.54） ---- */
    /**
     * 用户报的两件事：
     *  1) 一进输入态，输入框**正好压在选区上**，看不出自己选到哪儿；
     *  2) 想把块拉长/收短还得先退出输入 —— 输入态里 Alt+←/→ 没反应。
     *
     * 这里量的是 `selRect()`（选区在屏幕上的矩形）与 `.cell-input` 的矩形：
     * 只比 DOM 相对位置不够，两者都要换算到同一次屏幕坐标里。
     */
    await resetBlock();
    await js(`window.__ma.selectEvent(${tA})`);
    await wait(160);
    await js(`window.__ma.openEdit('vi')`);
    await wait(260);

    const editBox = (await js(`(() => {
      const el = document.querySelector('.cell-input');
      const r = el ? el.getBoundingClientRect() : null;
      const s = window.__ma.selRect();
      return r && s
        ? { inLeft: Math.round(r.left), inTop: Math.round(r.top), inRight: Math.round(r.right), sel: s }
        : null;
    })()`)) as any;
    check(
      '输入框落在选区的**右下角**（左边、上边都留出缝 —— 以前正好压在选区上，看不出选到哪）',
      // 偏移量本身是给人调的（`EDIT_DX/EDIT_DY`），断言只守「往右下、别盖住左上角、别跑远」
      !!editBox &&
        editBox.inLeft > editBox.sel.left + 1 &&
        editBox.inTop > editBox.sel.top &&
        // 别跑太远：纵向不超过选区底边一行
        editBox.inTop <= editBox.sel.bottom + 12,
      editBox
    );

    /**
     * 键要打在**输入框上**（`@keydown.stop="onInputKey"` 挂在它身上），
     * 打到 window 上是另一条路 —— 那条路测不到「输入态里也生效」。
     */
    const inputKey = (k: string, extra = '') =>
      js(`(() => {
        const el = document.querySelector('.cell-input');
        if (!el) return false;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true ${extra} }));
        return true;
      })()`);

    await inputKey('ArrowLeft', ', altKey: true');
    await wait(460);
    const inTrim = (await js(`window.__ma.selection()`)) as any;
    const inBox2 = (await js(`(() => {
      const el = document.querySelector('.cell-input');
      const r = el ? el.getBoundingClientRect() : null;
      const s = window.__ma.selRect();
      return r && s ? { inLeft: Math.round(r.left), inTop: Math.round(r.top), sel: s, value: el.value } : null;
    })()`)) as any;
    check(
      '输入态按 Alt+←：选区从右边收一格，输入框跟着变（还在、字没丢）',
      inTrim?.startTick === tA && inTrim?.endTick === tA + 960 && inBox2?.value === 'vi',
      { sel: inTrim, expect: [tA, tA + 960], box: inBox2 }
    );
    check(
      '输入框跟着选区一起收（右边界不再停在原来的位置）',
      !!inBox2 && inBox2.sel.right < editBox?.sel?.right,
      { before: editBox?.sel?.right, after: inBox2?.sel?.right }
    );

    /**
     * 起点移动时输入框必须跟着走 —— 这条才真正要求「选区变了就重摆输入框」。
     * 只改右端时宽度会被 `max(86, …)` 兜住、框几乎不动，看不太出来。
     */
    await inputKey('ArrowRight', ', altKey: true, shiftKey: true');
    await wait(460);
    const inTrimLeft = (await js(`window.__ma.selection()`)) as any;
    const inBox3 = (await js(`(() => {
      const el = document.querySelector('.cell-input');
      const r = el ? el.getBoundingClientRect() : null;
      return r ? { inLeft: Math.round(r.left), sel: window.__ma.selRect() } : null;
    })()`)) as any;
    const gapBefore = inBox2 ? inBox2.inLeft - inBox2.sel.left : null;
    const gapAfter = inBox3 ? inBox3.inLeft - inBox3.sel.left : null;
    check(
      '输入态按 Alt+Shift+→：从左边收，输入框跟着选区一起往右挪（间距保持不变）',
      inTrimLeft?.startTick === tA + 480 &&
        !!inBox3 &&
        inBox3.sel.left > inBox2?.sel?.left &&
        // 间距是 `positionOf()` 里的偏移，用户可能自己调 —— 只要求「前后一致」
        gapBefore !== null &&
        gapAfter !== null &&
        Math.abs(gapAfter - gapBefore) <= 2,
      { sel: inTrimLeft, box: inBox3, beforeLeft: inBox2?.sel?.left, gapBefore, gapAfter }
    );

    // Esc 放弃这次输入：块是上一段 resetBlock 写的，别真把它写坏
    await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    await wait(220);
    check('Esc 之后输入框收掉（这一路改的是选区，没有留下半截编辑态）', (await js(`!document.querySelector('.cell-input')`)) === true, {});
  }

  /* ---- 级数与字母和弦是两份数据（迁移 010）----
   *
   * 这一段刻意放在最后：它要切视图、还要在同一格里写两条事件，
   * 插在中间会把后面那些依赖「当前视图 / 当前选区」的断言全带偏（试过一次，五条一起红）。
   *
   * 以前四个视图共用 lane='chord'：字母和弦视图里躺着一串 I / IV / V7，
   * 在那边敲 Cmaj7 又会把级数覆盖掉。现在：
   *   degree → 级数（roman 视图）   chord → 绝对和弦（letter / riemann 实际和弦）
   */
  {
    const splitTrack = rows(`SELECT id FROM track WHERE title = '神鹿谣' AND deleted_at IS NULL`)[0]?.id;
    const splitAid = splitTrack
      ? (rows(`SELECT id FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`, splitTrack)[0] as any)?.id
      : null;
    if (splitTrack && splitAid) {
      await js(`window.__app.select(${JSON.stringify(splitTrack)})`);
      await wait(420);
      await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('字母和弦'))?.click()`);
      await wait(420);
      await js(`window.__ma.clear()`);
      await js(`window.__ma.select(3, 0, 0)`);
      const splitRange = (await js(`window.__ma.selState().selection`)) as any;
      const splitTick = Number(splitRange?.startTick ?? 0);
      await js(`window.__ma.type('G7')`);
      await wait(340);
      const chordRow = rows(
        `SELECT text FROM analysis_event WHERE analysis_id = ? AND tick = ? AND lane = 'chord'`,
        splitAid,
        splitTick
      )[0] as any;

      await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('罗马数字级数'))?.click()`);
      await wait(420);
      await js(`window.__ma.clear()`);
      await js(`window.__ma.select(3, 0, 0)`);
      await js(`window.__ma.type('V7')`);
      await wait(380);
      const bothRows = rows(
        `SELECT lane, text FROM analysis_event WHERE analysis_id = ? AND tick = ? ORDER BY lane`,
        splitAid,
        splitTick
      ) as any[];
      check(
        '级数与字母和弦分成两条泳道：同一格能同时存 V7（degree）与 G7（chord），互不覆盖',
        chordRow?.text === 'G7' &&
          bothRows.some((r) => r.lane === 'chord' && r.text === 'G7') &&
          bothRows.some((r) => r.lane === 'degree' && r.text === 'V7'),
        { splitTick, chordRow, bothRows }
      );
    }
  }

  /* ---- 从级数生成字母和弦（与低音填充同一套用法）----
   * 两种入口都验：① 自动模式（罗马数字视图打级数，chord 行自动跟上）
   *             ② 右键和弦行 → 整曲一次，且写出来的必须是**转换器认定的那个写法**
   * 也放在最后：它要切视图、要写库，插在中段会把依赖「当前视图 / 选区」的断言带偏。
   */
  {
    const ct = rows(`SELECT id FROM track WHERE title = '神鹿谣' AND deleted_at IS NULL`)[0]?.id;
    const caid = ct
      ? (rows(`SELECT id FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`, ct)[0] as any)?.id
      : null;
    if (ct && caid) {
      await js(`window.__app.select(${JSON.stringify(ct)})`);
      await wait(420);
      // ① 自动模式：在罗马数字视图里打一条级数
      await js(`window.__ma.chordMenuRun('auto')`);
      await wait(160);
      const autoOn = (await js(`window.__ma.chordAuto()`)) === true;
      await js(`window.__ma.clear()`);
      await js(`window.__ma.select(6, 0, 0)`);
      const autoRange = (await js(`window.__ma.selState().selection`)) as any;
      const autoTick = Number(autoRange?.startTick ?? 0);
      await js(`window.__ma.type('V7')`);
      await wait(520);
      const autoRow = rows(
        `SELECT text FROM analysis_event WHERE analysis_id = ? AND tick = ? AND lane = 'chord'`,
        caid,
        autoTick
      )[0] as any;
      await js(`window.__ma.chordMenuRun('auto')`);
      await wait(140);
      const autoOff = (await js(`window.__ma.chordAuto()`)) === false;
      check(
        '自动生成字母和弦：罗马数字视图里打完 V7，chord 行同时出现字母写法（不是把级数抄过去）',
        autoOn && !!autoRow && typeof autoRow.text === 'string' && /^[A-G]/.test(autoRow.text),
        { autoOn, autoOff, autoTick, autoRow }
      );
      check('自动生成字母和弦的开关能关回去（默认关）', autoOn && autoOff, { autoOn, autoOff });

      // ② 整曲填充：切到字母和弦视图，右键「和弦」行
      await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('字母和弦'))?.click()`);
      await wait(460);
      const cMenu = await js(`window.__ma.chordMenuOpen()`);
      await js(`window.__ma.chordMenuRun('fill')`);
      await wait(1200);
      const degRows = rows(
        `SELECT tick, text, parsed FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' ORDER BY tick`,
        caid
      ) as any[];
      const chRows = rows(
        `SELECT tick, text FROM analysis_event WHERE analysis_id = ? AND lane = 'chord' ORDER BY tick`,
        caid
      ) as any[];
      const expected = degRows
        .map((d) => {
          let parsed: any = null;
          try {
            parsed = d.parsed ? JSON.parse(d.parsed) : null;
          } catch {
            parsed = null;
          }
          return { tick: d.tick, text: letterFromRoman(parsed), from: d.text };
        })
        .filter((x) => !!x.text);
      const got = new Set(chRows.map((c) => `${c.tick}|${c.text}`));
      const missing = expected.filter((e) => !got.has(`${e.tick}|${e.text}`));
      check(
        '右键和弦行 → 从级数生成字母和弦：整曲每条可翻译的级数都写上了对应写法',
        !!cMenu && expected.length > 0 && missing.length === 0,
        { cMenu, expected: expected.length, chords: chRows.length, missing: missing.slice(0, 3) }
      );
      // 写出来的每一条都必须是绝对和弦（不能把 V7 原样抄进 chord 行）
      const notAbsolute = chRows.filter((c) => !/^[A-G][#♯b♭𝄪𝄫]?/.test(String(c.text ?? '')));
      check(
        '填充后的 chord 行全是绝对和弦写法（不会混进 V7 / ii 这类级数）',
        chRows.length > 0 && notAbsolute.length === 0,
        { chords: chRows.length, bad: notAbsolute.slice(0, 3) }
      );
    }
  }

  /* ---- 从级数 / 字母和弦生成斯波索宾标记 ----
   * 两条入口分开验；写法规则（大小写 / 四六写 46 / 原位不带数字）在这里做一次端到端核对。
   */
  {
    const st = rows(`SELECT id FROM track WHERE title = '神鹿谣' AND deleted_at IS NULL`)[0]?.id;
    const said = st
      ? (rows(`SELECT id FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`, st)[0] as any)?.id
      : null;
    if (st && said) {
      await js(`window.__app.select(${JSON.stringify(st)})`);
      await wait(420);
      await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('斯波索宾体系'))?.click()`);
      await wait(460);
      const sMenu = await js(`window.__ma.sposobinMenuOpen()`);
      await wait(80);
      const menuWasOpen = (await js(`!!window.__ma.sposobinMenuState()`)) === true;
      // 点菜单外面（详情面板）就该关掉 —— 以前只有 Esc 能关，菜单会一直挂着挡路
      await js(`document.querySelector('.detail')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
      await wait(120);
      const menuClosed = (await js(`window.__ma.sposobinMenuState()`)) === null;
      check(
        '右键菜单点别处自动关闭（以前只能按 Esc）',
        !!sMenu && menuWasOpen && menuClosed,
        { sMenu, menuWasOpen, menuClosed }
      );
      await js(`window.__ma.sposobinMenuRun('degree')`);
      await wait(1000);
      const spRows = rows(
        `SELECT tick, text FROM analysis_event WHERE analysis_id = ? AND lane = 'sposobin' ORDER BY tick`,
        said
      ) as any[];
      const degRows2 = rows(
        `SELECT tick, text, parsed FROM analysis_event WHERE analysis_id = ? AND lane = 'degree' ORDER BY tick`,
        said
      ) as any[];
      // 期望值用主进程同一份转换器算：界面写出来的必须和它一致
      const expectedSp = degRows2
        .map((d) => {
          let parsed: any = null;
          try {
            parsed = d.parsed ? JSON.parse(d.parsed) : null;
          } catch {
            parsed = null;
          }
          return { tick: d.tick, text: parsed?.keyName ? sposobinOf(parsed, parsed.keyName) : null, from: d.text };
        })
        .filter((x) => !!x.text);
      const gotSp = new Set(spRows.map((r) => `${r.tick}|${r.text}`));
      const missSp = expectedSp.filter((e) => !gotSp.has(`${e.tick}|${e.text}`));
      check(
        '右键「和弦标记」行 → 从级数生成斯波索宾标记：每条可转换的级数都写上了对应功能标记',
        !!sMenu && expectedSp.length > 0 && missSp.length === 0,
        { sMenu, expected: expectedSp.length, wrote: spRows.length, miss: missSp.slice(0, 3) }
      );
      // 写法约定：原位三和弦不带数字（不许出现 53），四六写 46
      const badFig = spRows.filter((r) => /53/.test(String(r.text ?? '')));
      check(
        '斯波索宾写法：原位三和弦不带数字（无 53），四六按苏俄习惯写作 46',
        spRows.length > 0 && badFig.length === 0,
        { texts: spRows.map((r) => r.text).slice(0, 12), bad: badFig.slice(0, 3) }
      );

      /* ---- 这一栏也要像级数标记那样「解析出和弦音」（v0.67）----
       * 斯波索宾标记不是和弦记号，`D7` 喂给解析器会被读成「D 属七」——
       * 所以先译成 `V7` 再解析（见 `romanFromSposobin`）。
       */
      const spParsed = rows(
        `SELECT tick, text, parsed FROM analysis_event WHERE analysis_id = ? AND lane = 'sposobin' AND parsed IS NOT NULL`,
        said
      ) as any[];
      const parsedObjs = spParsed.map((r) => {
        try {
          return JSON.parse(r.parsed);
        } catch {
          return null;
        }
      });
      check(
        '斯波索宾标记也解析：每一条都能给出罗马写法与和弦音（不是被当成「D 属七」）',
        spParsed.length > 0 &&
          parsedObjs.every((p: any) => p && p.ok === true && typeof p.roman === 'string' && p.toneNames?.length >= 3),
        { n: spParsed.length, sample: parsedObjs.slice(0, 3).map((p: any) => ({ r: p?.roman, t: p?.toneNames })) }
      );

      /* ---- 空泳道不是死路：方向键要能走到「有内容的泳道」----
       * 斯波索宾方案两条泳道：和弦标记(sposobin) + 备注(note)。备注常常一个字都没写，
       * 选区落上去以后方向键以前直接「到头停住」—— 右边三小节全是和弦块，却只能先去点一下和弦标记行。
       *
       * 这里先把**冒烟副本**里的 note 事件清空，保证「一条从没写过的泳道」这个前提成立
       * （不能假设用户库里的 note 一定是空的）。只动 .smoke-data，不碰 data/。
       */
      handle.db.prepare(`DELETE FROM analysis_event WHERE analysis_id = ? AND lane = 'note'`).run(said);
      await js(`window.__app.select(${JSON.stringify(st)})`);
      await wait(460);
      const noteLeft = Number(
        (rows(`SELECT COUNT(*) c FROM analysis_event WHERE analysis_id = ? AND lane = 'note'`, said)[0] as any)?.c ?? 0
      );
      const firstSpTick = Number(spRows[0]?.tick ?? 0);
      const placed = await js(`window.__ma.selectCellAt('note', ${firstSpTick})`);
      await wait(160);
      // Ctrl+→：只在**当前泳道**找块 —— 备注是空的，所以原地不动
      await js(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true, cancelable: true }))`
      );
      await wait(240);
      const afterCtrl = (await js(`window.__ma.selection()`)) as any;
      // ↑：换到上面那条泳道（和弦标记），落在块上就吸附整块
      await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`);
      await wait(260);
      const afterUp = (await js(`window.__ma.selection()`)) as any;
      check(
        '空泳道（备注）：Ctrl+→ 不动（跳块只看当前泳道），↑ 换到和弦标记并吸附整块',
        noteLeft === 0 &&
          (placed as any)?.lanes?.[0] === 'note' &&
          afterCtrl?.lanes?.[0] === 'note' &&
          afterCtrl?.startTick === (placed as any)?.startTick &&
          afterUp?.lanes?.[0] === 'sposobin' &&
          Number(afterUp.endTick) - Number(afterUp.startTick) > 0,
        { noteLeft, placed, afterCtrl, afterUp }
      );
      // 挑一条 `D…` 的看音名对不对：C 大调的 D7 必须是 D 属七（不是「D 音上叠的属七」）
      const dRow = spParsed
        .map((r, i) => ({ text: r.text, p: parsedObjs[i] }))
        .find((x) => x.text === 'D7');
      check(
        '斯波索宾 D7 在 C 大调解析成 V7（G B D F），不是「D 属七」',
        !dRow || (dRow.p?.degree === 5 && JSON.stringify(dRow.p?.toneNames) === JSON.stringify(['G', 'B', 'D', 'F'])),
        dRow
      );

      // 界面上要看得见：切到斯波索宾视图，选中有标记的格子，详情条出现解析结果
      let spShown = '';
      for (let bar = 1; bar <= 8 && !spShown; bar++) {
        await js(`window.__ma.select(${bar}, 0, 0, ['sposobin'])`);
        await wait(150);
        spShown = String((await js(`document.querySelector('.selbar .parsed')?.textContent?.trim() ?? ''`)) || '');
      }
      check(
        '选中斯波索宾格子时，详情条显示解析出的和弦（以前这一栏永远是空的）',
        spShown.length >= 3 && /[A-G]/.test(spShown),
        { shown: spShown }
      );
      await shot('smoke-sposobin-parsed.png');

      // 第二条入口：从字母和弦（前面几轮已经往 chord 行填过）
      await js(`window.__ma.sposobinMenuRun('chord')`);
      await wait(900);
      const spFromChord = rows(
        `SELECT tick, text FROM analysis_event WHERE analysis_id = ? AND lane = 'sposobin' ORDER BY tick`,
        said
      ) as any[];
      check(
        '右键「和弦标记」行 → 从字母和弦生成（先按该 tick 的调性反推级数）',
        spFromChord.length >= spRows.length && spFromChord.every((r) => /^[TtSsDdK]/.test(String(r.text ?? ''))),
        { before: spRows.length, after: spFromChord.length, sample: spFromChord.map((r) => r.text).slice(0, 8) }
      );

      /* ---- 补全：以前这条泳道只出 K46 一条候选 ---- */
      await js(`window.__ma.clear()`);
      await js(`window.__ma.select(2, 0, 0, ['sposobin'])`);
      await js(`window.__ma.openEdit('')`);
      await js(`(() => {
        const el = document.querySelector('.cell-input');
        if (!el) return;
        el.value = 'D';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(240);
      const spSug = (await js(`window.__ma.cellSugState()`)) as any;
      check(
        '斯波索宾泳道补全：打 D 出 D / DVII / D7…（不再只有 K46）',
        spSug?.open === true &&
          spSug.items?.[0]?.value?.toLowerCase() === 'd' &&
          spSug.items?.some((x: any) => x.value === 'D7') &&
          // 同族：D 之后紧跟 DVII（属七 / 导七是一对）
          spSug.items?.some((x: any) => x.value === 'DVII') &&
          spSug.items.length >= 4,
        spSug
      );
      // 转位数字按苏俄习惯：56 / 34（不是 65 / 43）
      await js(`(() => {
        const el = document.querySelector('.cell-input');
        if (!el) return;
        el.value = 'D5';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(200);
      const spD5 = (await js(`window.__ma.cellSugState()`)) as any;
      check(
        '斯波索宾转位：打 D5 第一个是 D56（不是 D65）',
        spD5?.items?.[0]?.value === 'D56',
        spD5
      );
      /* S 组：S6 / S46 / SII6 / SII7 及其转位要排在 S7 前面（用户 2026-11-05 的口径） */
      await js(`(() => {
        const el = document.querySelector('.cell-input');
        if (!el) return;
        el.value = 'S';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(240);
      const spS = (await js(`window.__ma.cellSugState()`)) as any;
      const sVals = (spS?.items ?? []).map((x: any) => String(x.value));
      // 大小写跟着该处调性走（大调 S / 小调 s），所以期望值按第一个候选的首字母推导
      const p0 = String(sVals[0] ?? '');
      const want = ['6', '46', 'II6', 'II46', 'II7', 'II56', 'II34', 'II2'].map((f) => p0 + f);
      check(
        '斯波索宾补全：打 S 先给 S/s（完全相等），再接 6 / 46 / II6 / II7 及其转位，S7 一族靠后',
        (p0 === 'S' || p0 === 's') &&
          // 候选现在一次给 20 条（框可滚动），只比前面这 8 个常用项
          JSON.stringify(sVals.slice(1, 9)) === JSON.stringify(want) &&
          // S7 那一族已经被挤出前 8 条（这正是要的）；万一还在，也必须排在 II7 之后
          (sVals.indexOf(p0 + '7') === -1 || sVals.indexOf(p0 + 'II7') < sVals.indexOf(p0 + '7')),
        sVals
      );
      await js(`(() => {
        const el = document.querySelector('.cell-input');
        if (!el) return;
        el.value = 'D7/';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(240);
      const spSug2 = (await js(`window.__ma.cellSugState()`)) as any;
      check(
        '斯波索宾补全：斜杠后只补目标（D7/T、D7/SII…）',
        spSug2?.open === true &&
          spSug2.items?.length > 0 &&
          spSug2.items.every((x: any) => String(x.value).startsWith('D7/')),
        spSug2
      );
      /* ---- 子序列匹配 + 六级特例（2026-11-07 用户逐条点的次序）----
       * 打 i / v 以前一个候选都不出，因为匹配要求「前缀以它开头」；现在按子序列匹配。
       * 断言统一比较小写形式：同一首曲子在不同小节可能是大调或小调，两套写法都得成立。
       */
      const sugOf = async (text: string) => {
        await js(`(() => {
          const el = document.querySelector('.cell-input');
          if (!el) return;
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await wait(220);
        const st = (await js(`window.__ma.cellSugState()`)) as any;
        return (st?.items ?? []).map((x: any) => String(x.value));
      };
      const low = (arr: string[]) => arr.map((v) => v.toLowerCase());

      const s5 = await sugOf('s5');
      check(
        '斯波索宾补全：打 s5 → sII56 第一、s56 第二（II 族压过「字面开头」），不混进 tsVI56',
        JSON.stringify(low(s5).slice(0, 2)) === JSON.stringify(['sii56', 's56']) &&
          !low(s5).includes('tsvi56'),
        s5
      );

      /* ---- 小重属 `dd`（v0.81）：第一项是字面 + 警告色，后面接正常的 DD 族 ---- */
      const ddTok = await sugOf('dd');
      const ddState = (await js(`window.__ma.cellSugState()`)) as any;
      check(
        '斯波索宾：打 dd（小重属）第一项就是打的字面、标警告色，后面接正常 DD 的补全',
        ddTok[0] === 'dd' &&
          ddState?.items?.[0]?.tone === 'warn' &&
          /小重属/.test(String(ddState?.items?.[0]?.hint ?? '')) &&
          low(ddTok.slice(1)).includes('dd'),
        { first: ddState?.items?.[0], head: ddTok.slice(0, 4) }
      );

      const iTok = await sugOf('i');
      check(
        '斯波索宾补全：打 i → sII6 / sII56 / sII / tsVI 依次在前（以前一个都不出）',
        JSON.stringify(low(iTok).slice(0, 4)) === JSON.stringify(['sii6', 'sii56', 'sii', 'tsvi']),
        iTok
      );

      const iiTok = await sugOf('ii');
      check(
        '斯波索宾补全：打 ii / Ii 时 tsVI 自己消失（它只有一个 I，凑不出两个）；dtIII 有三个 I，留着',
        iiTok.length > 0 &&
          !low(iiTok).some((v) => v.startsWith('tsvi')) &&
          low(iiTok).includes('dtiii'),
        iiTok
      );

      const vTok = await sugOf('v');
      check(
        '斯波索宾补全：打 v / vi → 六级整族最前，族内 6 → 7 → 56 → 34 → 2 → 46',
        JSON.stringify(low(vTok).slice(0, 7)) ===
          JSON.stringify(['tsvi', 'tsvi6', 'tsvi7', 'tsvi56', 'tsvi34', 'tsvi2', 'tsvi46']),
        vTok
      );

      const viTok = await sugOf('vi');
      check(
        '斯波索宾补全：打 vi 六级之后接 DVII7 / 56 / 34 / 2、DDVII、DDVII7 / 56 / 34 / 2',
        JSON.stringify(low(viTok).slice(0, 16)) ===
          JSON.stringify([
            'tsvi', 'tsvi6', 'tsvi7', 'tsvi56', 'tsvi34', 'tsvi2', 'tsvi46',
            'dvii7', 'dvii56', 'dvii34', 'dvii2',
            'ddvii', 'ddvii7', 'ddvii56', 'ddvii34', 'ddvii2',
          ]),
        viTok.slice(0, 16)
      );

      const tTok = await sugOf('t');
      check(
        '斯波索宾补全：只打 t → t / t6 / t46 先，然后六级七项，最后 t7 / t56 / t34 / t2',
        JSON.stringify(low(tTok).slice(0, 3)) === JSON.stringify(['t', 't6', 't46']) &&
          low(tTok)[3] === 'tsvi' &&
          JSON.stringify(low(tTok).slice(10, 14)) === JSON.stringify(['t7', 't56', 't34', 't2']),
        tTok.slice(0, 14)
      );

      /* ---- 候选右侧的说明：罗马数字 + 转位（与级数泳道的提示同一个用意）---- */
      await sugOf('D7');
      const dHint = (await js(`window.__ma.cellSugState()`)) as any;
      const dHintText = String(dHint?.items?.[0]?.hint ?? '');
      check(
        '斯波索宾候选带右边提示：D7 显示「原位」（罗马数字与「七和弦」这些词已去掉，只留第几转位）',
        dHint?.items?.[0]?.value === 'D7' && dHintText === '原位',
        { hint: dHintText, items: dHint?.items?.slice(0, 3) }
      );
      // 五六和弦那一档：显示「第1转位」，不再写「V65 · 五六和弦」
      await sugOf('D56');
      const d56Hint = (await js(`window.__ma.cellSugState()`)) as any;
      check(
        '转位档的提示写成「第一转位」：不重复 6/56/34 这些和弦名，也不带罗马数字',
        d56Hint?.items?.[0]?.value === 'D56' && d56Hint?.items?.[0]?.hint === '第一转位',
        d56Hint?.items?.[0]
      );
      await shot('smoke-sposobin-sug.png');

      await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(160);

      // 自动模式：写级数时顺手生成（默认关，验一次开/关）
      await js(`window.__ma.sposobinMenuRun('auto')`);
      await wait(140);
      const spAutoOn = (await js(`window.__ma.sposobinAuto()`)) === true;
      await js(`window.__ma.sposobinMenuRun('auto')`);
      await wait(140);
      const spAutoOff = (await js(`window.__ma.sposobinAuto()`)) === false;
      check('斯波索宾自动生成开关能开能关（默认关）', spAutoOn && spAutoOff, { spAutoOn, spAutoOff });

      /* ---- 大小写越界的附注：小调大下属橙黄、大调小下属绿、Dorian 不上色（v0.74）----
       * 逻辑本身有单测，这里只验「界面上真的按 tone 上色」，且颜色取自现有变量。
       */
      const caseProbe = async (trackTitle: string, token: string) => {
        const tid = rows(`SELECT id FROM track WHERE title = ? AND deleted_at IS NULL`, trackTitle)[0]?.id;
        if (!tid) return null;
        await js(`window.__app.select(${JSON.stringify(tid)})`);
        await wait(420);
        await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('斯波索宾体系'))?.click()`);
        await wait(420);
        await js(`window.__ma.clear()`);
        await js(`window.__ma.select(1, 0, 0, ['sposobin'])`);
        await js(`window.__ma.openEdit('')`);
        await wait(200);
        await js(`(() => {
          const el = document.querySelector('.cell-input');
          if (!el) return;
          el.value = ${JSON.stringify(token)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await wait(240);
        return (await js(`(() => {
          const items = [...document.querySelectorAll('.cell-sug li')];
          const first = items[0] ?? null;
          const em = first ? first.querySelector('em') : null;
          const probe = (v) => {
            const d = document.createElement('div');
            d.style.cssText = 'position:absolute;visibility:hidden;color:' + v;
            document.body.appendChild(d);
            const c = getComputedStyle(d).color;
            d.remove();
            return c;
          };
          return {
            value: first ? first.querySelector('span')?.textContent?.trim() ?? null : null,
            text: em ? em.textContent.trim() : null,
            cls: em ? em.className : null,
            color: em ? getComputedStyle(em).color : null,
            warn: probe('var(--warn)'),
            accent: probe('var(--accent)'),
          };
        })()`)) as any;
      };

      // ① 小调里的大下属：少见 → 橙黄
      const sibCase = await caseProbe('The deepest nightmare of Sibyl', 'S');
      check(
        '小调里打大 S：附注是橙黄警告（不等于品牌绿），并写明「少见的大下属」',
        !!sibCase &&
          sibCase.value === 'S' &&
          /tone-warn/.test(String(sibCase.cls ?? '')) &&
          sibCase.color === sibCase.warn &&
          sibCase.color !== sibCase.accent &&
          /少见/.test(String(sibCase.text ?? '')),
        sibCase
      );
      await shot('smoke-sposobin-s-case.png');

      // ② 大调里的小下属：和声大调的常客 → 绿
      const majCase = await caseProbe('虚构测试数据 · 晨雾中的长笛', 's');
      check(
        '大调里打小 s：附注是品牌绿（不等于警告色），并写明「和声大调的小下属」',
        !!majCase &&
          majCase.value === 's' &&
          /tone-ok/.test(String(majCase.cls ?? '')) &&
          majCase.color === majCase.accent &&
          majCase.color !== majCase.warn &&
          /和声大调/.test(String(majCase.text ?? '')),
        majCase
      );

      // ③ Dorian：IV 本来就是大三，大 S 是默认写法，不该有任何语气色
      const dorCase = await caseProbe('神鹿谣', 'S');
      check(
        'Dorian 里打大 S 不上色：不警告，附注就是普通的「原位」',
        !!dorCase && dorCase.value === 'S' && !dorCase.cls && dorCase.text === '原位',
        dorCase
      );

      await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(160);

      /* ---- 离调（副属）：真实数据里 iii6/III 这类必须用斜杠写法同步过去 ---- */
      const sib = rows(`SELECT id FROM track WHERE title = 'The deepest nightmare of Sibyl' AND deleted_at IS NULL`)[0]?.id;
      const sibAid = sib
        ? (rows(`SELECT id FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`, sib)[0] as any)?.id
        : null;
      if (sib && sibAid) {
        await js(`window.__app.select(${JSON.stringify(sib)})`);
        await wait(460);
        // 前面「跟随播放头」那一段把这首切到了罗马数字视图，必须显式切回来
        await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('斯波索宾体系'))?.click()`);
        await wait(460);
        await js(`window.__ma.sposobinMenuRun('degree')`);
        await wait(1200);
        const applied = rows(
          // parsed 必须一起取：离调判断靠的就是它（第一版漏了这一列，filter 永远为空）
          `SELECT tick, text, parsed FROM analysis_event WHERE analysis_id = ? AND lane = 'degree'`,
          sibAid
        ).filter((d: any) => {
          try {
            const p = JSON.parse(d.parsed ?? 'null');
            return p && p.appliedTo != null;
          } catch {
            return false;
          }
        }) as any[];
        const spApplied = rows(
          `SELECT tick, text FROM analysis_event WHERE analysis_id = ? AND lane = 'sposobin'`,
          sibAid
        ) as any[];
        const byTick = new Map(spApplied.map((r) => [r.tick, String(r.text ?? '')]));
        const slashOk = applied.every((d) => String(byTick.get(d.tick) ?? '').includes('/'));
        check(
          '离调（副属）同步成斜杠写法：iii6/III → DTIII6/dtIII 这类',
          applied.length > 0 && slashOk,
          {
            applied: applied.map((d) => ({ tick: d.tick, from: d.text, to: byTick.get(d.tick) })).slice(0, 4),
          }
        );
      }
    }
  }

  /* ---- 变音记号字体（v0.66）----
   * 中文/日文字体把 ♭ 当**全角**字符画：宽度约 1em、笔画又粗，跟 `Cmaj7` 摆一起像换了字号。
   * 现在换成子集自 Bravura 的 `Atlas Music`（0.226em 宽）。
   * 用 measureText 量宽度：Canvas 与 DOM 走同一条字体栈，量出来 ≈0.23em 才算真的生效。
   */
  {
    const music = (await js(`(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      const stack = getComputedStyle(document.body).fontFamily;
      const c = document.createElement('canvas').getContext('2d');
      c.font = '100px ' + stack;
      const w = (ch) => Math.round(c.measureText(ch).width * 10) / 10;
      // DOM 那一路：一个只有 ♭ 的 span，宽度同样应该 ≈0.24em
      const el = document.createElement('span');
      el.textContent = '♭';
      el.style.cssText = 'position:absolute;visibility:hidden;font:100px ' + stack;
      document.body.appendChild(el);
      const domW = el.getBoundingClientRect().width;
      el.remove();
      return {
        stack,
        // 五个记号逐个量：**任何一个**落回系统字体都会变成 50~100，一眼能看出来
        w: { flat: w('♭'), natural: w('♮'), sharp: w('♯'), dsharp: w('𝄪'), dflat: w('𝄫') },
        domW,
        loaded: document.fonts.check('12px "Atlas Music"'),
      };
    })()`)) as any;
    check(
      '变音记号全部由音乐字体渲染：♭/♮/♯/𝄪/𝄫 各约 0.24/0.18/0.26/0.55/0.44em（中文全角是 1em）',
      music?.loaded === true &&
        /Atlas Music/.test(String(music?.stack ?? '')) &&
        Number(music?.w?.flat) > 20 &&
        Number(music?.w?.flat) < 28 &&
        Number(music?.w?.natural) > 15 &&
        Number(music?.w?.natural) < 21 &&
        Number(music?.w?.sharp) > 23 &&
        Number(music?.w?.sharp) < 30 &&
        Number(music?.w?.dsharp) > 50 &&
        Number(music?.w?.dsharp) < 60 &&
        Number(music?.w?.dflat) > 39 &&
        Number(music?.w?.dflat) < 48 &&
        Number(music?.domW) > 20 &&
        Number(music?.domW) < 28,
      music
    );
  }

  /* ---- 播放列表（v0.64）：侧栏第一块改成播放列表，可折叠；Ctrl+N 新建 ---- */
  {
    const plSnap = (await js(`(async () => {
      const heads = [...document.querySelectorAll('.sidebar .side-h')].map((h) => h.textContent.trim());
      const items = () => [...document.querySelectorAll('.sidebar .side-i')].map((b) => b.textContent.trim());
      const chev = () => document.querySelectorAll('.sidebar .side-chev')[0];
      const head = document.querySelectorAll('.sidebar .side-h')[0];
      const titleEl = head?.querySelector('.side-title');
      const before = items();
      const chevOpen = chev()?.classList.contains('open') === true;
      const chevRect = chev()?.getBoundingClientRect();
      document.querySelectorAll('.sidebar .side-h')[0].click();
      await new Promise((r) => setTimeout(r, 170));
      const collapsed = items();
      const chevClosed = chev()?.classList.contains('open') === false;
      const chevRectClosed = chev()?.getBoundingClientRect();
      document.querySelectorAll('.sidebar .side-h')[0].click();
      await new Promise((r) => setTimeout(r, 170));
      const restored = items();
      const tRect = titleEl?.getBoundingClientRect();
      // 收起会把子树整块 v-if 掉：旧的 DOM 引用已经脱离文档，量出来全是 0，
      // 所以**重开之后重新取**一次（踩过：itemLeft 永远是 0）
      const group = document.querySelectorAll('.sidebar .side-h')[0]?.nextElementSibling;
      const itemEl = group?.querySelector('.side-i');
      // 方案 E 只让**选中**那一行压到线之上；其余行必须还是 static，
      // 否则它们会各自开层叠上下文，把线压回去（hover 就会闪）。
      const plainRow = [...(group?.querySelectorAll('.side-i') ?? [])].find(
        (r) => !r.classList.contains('on')
      );
      // 选中条会**向左探出**盖住树线，所以按钮框的左缘不能当作「缩进」用；
      // 量文字本身的左缘（Range 的包围盒）才是用户看到的位置。
      let textLeft = 0;
      if (itemEl) {
        const r = document.createRange();
        r.selectNodeContents(itemEl);
        textLeft = Math.round(r.getBoundingClientRect().left);
      }
      return {
        heads, before, collapsed, restored,
        chev: {
          tag: chev()?.tagName ?? null,
          paths: chev()?.querySelectorAll('path').length ?? 0,
          first: head?.firstElementChild?.tagName ?? null,
          open: chevOpen,
          closed: chevClosed,
          // 旋转 90° 之后包围盒宽高会互换 —— 用几何证明「真的转了」，不只看 class
          w: chevRect ? Math.round(chevRect.width) : 0,
          wClosed: chevRectClosed ? Math.round(chevRectClosed.width) : 0,
          left: chevRect ? Math.round(chevRect.left) : 0,
          titleLeft: tRect ? Math.round(tRect.left) : 0,
        },
        indent: {
          titleLeft: tRect ? Math.round(tRect.left) : 0,
          itemLeft: itemEl ? Math.round(itemEl.getBoundingClientRect().left) : 0,
          textLeft,
          // 树线的位置 = 子树容器的左缘（伪元素 left:0 就落在这儿）
          lineLeft: group ? Math.round(group.getBoundingClientRect().left) : 0,
          radius: itemEl ? getComputedStyle(itemEl).borderTopLeftRadius : '',
          pillLeft: itemEl ? Math.round(itemEl.getBoundingClientRect().left) : 0,
          // 树线是一条**伪元素**（不再是 border-left）：要画在选中 / 悬停的罩子之上
          line: group
            ? (() => {
                const cs = getComputedStyle(group, '::before');
                const row = getComputedStyle(itemEl ?? group);
                return {
                  borderLeft: getComputedStyle(group).borderLeftWidth,
                  position: cs.position,
                  zIndex: cs.zIndex,
                  width: cs.width,
                  bg: cs.backgroundColor,
                  // 行的定位：未选中的必须 static（否则它自己开层叠上下文把线压回去），
                  // 选中的按方案 E 是 relative + z-index 2（压在线之上）
                  rowPosition: plainRow ? getComputedStyle(plainRow).position : 'static',
                  onPosition: row.position,
                  onZIndex: row.zIndex,
                };
              })()
            : null,
        },
      };
    })()`)) as any;
    check(
      '侧栏第一块叫「播放列表」，默认展开且首项是「全部曲目」；点标题能收起、再点能展开',
      plSnap?.heads?.[0] === '播放列表' &&
        /全部曲目/.test(String(plSnap?.before?.[0] ?? '')) &&
        // 不写死「少 1 条」：真实用户的 data/playlists.json 里本来就有列表，
        // 收起时消失的是「全部曲目 + 他建的每一条」，条数由数据决定
        plSnap.collapsed.length < plSnap.before.length &&
        plSnap.restored.length === plSnap.before.length,
      plSnap
    );
    check(
      '折叠标记是 chevron（SVG 两条边）而不是实心三角，在标题左侧；展开朝下、收起朝右',
      plSnap?.chev?.tag === 'svg' &&
        plSnap.chev.paths === 1 &&
        plSnap.chev.first === 'svg' &&
        plSnap.chev.open === true &&
        plSnap.chev.closed === true &&
        Number(plSnap.chev.left) < Number(plSnap.chev.titleLeft),
      plSnap?.chev
    );
    check(
      '子项缩进 ≥8px、左侧 1px 树线，且树线挂在 chevron 角尖附近（不跑出那个符号）',
      Number(plSnap?.indent?.textLeft) - Number(plSnap?.indent?.titleLeft) >= 8 &&
        plSnap?.indent?.line?.width === '1px' &&
        // 线在 chevron 的 10px 宽度之内（chevron 左缘到线：0~10px）
        Number(plSnap?.indent?.lineLeft) - Number(plSnap?.chev?.left) >= 0 &&
        Number(plSnap?.indent?.lineLeft) - Number(plSnap?.chev?.left) <= 10,
      plSnap?.indent
    );
    check(
      '树线是伪元素画的（z-index:1，不用 border-left）：未选中的行一律 static，线不会被压下去',
      plSnap?.indent?.line?.position === 'absolute' &&
        Number(plSnap?.indent?.line?.zIndex) >= 1 &&
        // 不再用 border 画线：border 永远在内容之下，这正是之前怎么调都别扭的原因
        plSnap?.indent?.line?.borderLeft === '0px' &&
        // 未选中的行不能是定位元素
        plSnap?.indent?.line?.rowPosition === 'static' &&
        // 唯一的例外：选中行按方案 E 抬到线之上（块才是完整一块）
        plSnap?.indent?.line?.onPosition === 'relative' &&
        Number(plSnap?.indent?.line?.onZIndex) >= 2,
      plSnap?.indent?.line
    );
    check(
      '选中行是圆角条、并且从树线**左边**起铺（不再卡在线上切一刀）',
      Number.parseFloat(String(plSnap?.indent?.radius)) >= 6 &&
        // 色块左缘必须 < 树线，否则就是「切在临界点的方块」
        Number(plSnap?.indent?.pillLeft) < Number(plSnap?.indent?.lineLeft),
      plSnap?.indent
    );

    /* ---- 悬停底色必须够透：树线从块底下透出来时「不换颜色」（v0.71）----
     * 用户反馈：hover 底色太实，线被盖住那一段看着变了色，鼠标扫过去比选中还吵。
     * 这里按真实色值算一遍合成色 —— 不靠肉眼，也不靠「看起来差不多」：
     *   块内线 = α·surface-2 + (1-α)·line      块外线 = line
     * 两者的 8bit 通道差就是「线换了几档颜色」，卡在 8 以内。
     */
    const hoverMix = (await js(`(() => {
      const probes = {};
      // --side-* 定义在 .sidebar 上、不是 :root —— 探针必须挂进侧栏里才继承得到，
      // 挂 body 上会读到空值（rgba(0,0,0,0)，看着像「全透」）
      const host = document.querySelector('.sidebar') ?? document.body;
      const read = (expr) => {
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;visibility:hidden;width:0;height:0;background:' + expr;
        host.appendChild(el);
        const raw = getComputedStyle(el).backgroundColor;
        el.remove();
        const n = (raw.match(/[\\d.]+/g) || []).map(Number);
        // color-mix 算出来的结果是 color(srgb 0.137 0.137 0.125 / 0.45)（0~1），
        // 而 rgb() / rgba() 是 0~255 —— 两种都归一成 0~255 再比，否则差出 255 倍
        const k = raw.startsWith('color(') ? 255 : 1;
        return { r: n[0] * k, g: n[1] * k, b: n[2] * k, a: n.length > 3 ? n[3] : 1 };
      };
      probes.hover = read('var(--side-hover)');
      probes.surface = read('var(--surface)');
      probes.line = read('var(--line)');
      return probes;
    })()`)) as any;
    {
      const h = hoverMix?.hover ?? { r: 0, g: 0, b: 0, a: 1 };
      const surf = hoverMix?.surface ?? { r: 0, g: 0, b: 0, a: 1 };
      const line = hoverMix?.line ?? { r: 0, g: 0, b: 0, a: 1 };
      const mix = (over, under, a) => over * a + under * (1 - a);
      const CH = ['r', 'g', 'b'];
      // 线被盖住那一段 = 悬停底色压在线色上；它和原线色的差，就是「线换了几档」
      const lineShift = Math.max(...CH.map((k) => Math.abs(mix(h[k], line[k], h.a) - line[k])));
      // 块本身（压在背景上）相对背景的差，用来确保 hover 仍然看得出来
      const blockLift = Math.max(...CH.map((k) => Math.abs(mix(h[k], surf[k], h.a) - surf[k])));
      check(
        '悬停底色回到 70%（和界面别处同一个浓度）：线的颜色不再靠「透」来保全，靠层级',
        h.a > 0.6 &&
          h.a < 0.8 &&
          blockLift >= 2,
        { alpha: h.a, lineShift: Math.round(lineShift * 10) / 10, blockLift: Math.round(blockLift * 10) / 10, hoverMix }
      );
    }

    /* ---- 树线与选中 / 悬停罩子的层级（v0.73 → v0.78 定稿方案 E）----
     * 这条只能取色验证：z-index 对了不等于画对了（行的背景、伪元素、层叠顺序任何一环错了，
     * 计算样式都一样）。所以真的 hover 一行、真截图、真读像素。
     *
     * 现在的约定（2026-11-08 用户从六个候选里选定 E）：
     *   · **hover 行**：条子在线的下面 → 线上那一像素 = `--line` 原色（线连贯，不闪）
     *   · **选中行**：条子抬到线上面 → 线上那一像素**不等于** `--line`，而是被 18% 的绿罩过
     *     一层的颜色（绿通道明显高于红通道）。这正是「块是完整一块」的来源，不是 bug。
     */
    {
      const geo = (await js(`(() => {
        const g = document.querySelectorAll('.sidebar .side-group')[0];
        const rows = [...g.querySelectorAll('.side-i')];
        const gr = g.getBoundingClientRect();
        return {
          lineX: Math.round(gr.left),
          rows: rows.slice(0, 2).map((r) => {
            const rr = r.getBoundingClientRect();
            return {
              y: Math.round(rr.top + rr.height / 2),
              left: Math.round(rr.left),
              w: Math.round(rr.width),
              on: r.classList.contains('on'),
            };
          }),
        };
      })()`)) as any;
      const hoverRow = geo?.rows?.[1] ?? geo?.rows?.[0];
      if (hoverRow) {
        // 真 hover 第二行：CSS :hover 只认真实指针
        win!.webContents.sendInputEvent({
          type: 'mouseMove',
          x: hoverRow.left + Math.round(hoverRow.w / 2),
          y: hoverRow.y,
        });
        await wait(360);
        const im = await win!.webContents.capturePage();
        const size = im.getSize();
        const [cw] = win!.getContentSize();
        const ratio = size.width / cw;
        const buf = im.toBitmap();
        const at = (x: number, y: number) => {
          const i = (Math.round(y * ratio) * size.width + Math.round(x * ratio)) * 4;
          return { r: buf[i + 2], g: buf[i + 1], b: buf[i] }; // toBitmap 是 BGRA
        };
        const lineCss = (await js(`(() => {
          const el = document.createElement('div');
          el.style.cssText = 'position:absolute;visibility:hidden;background:var(--line)';
          document.querySelector('.sidebar').appendChild(el);
          const c = getComputedStyle(el).backgroundColor;
          el.remove();
          return c;
        })()`)) as string;
        const want = (String(lineCss).match(/\d+/g) ?? []).map(Number);
        const near = (p: any) =>
          Math.abs(p.r - want[0]) <= 2 && Math.abs(p.g - want[1]) <= 2 && Math.abs(p.b - want[2]) <= 2;

        const onLine = geo.rows.map((r: any) => at(geo.lineX, r.y));
        const inCover = geo.rows.map((r: any) => at(r.left + 12, r.y));
        const covered = inCover.every((p: any) => !near(p));
        const selIdx = geo.rows.findIndex((r: any) => r.on);
        const selPx = selIdx >= 0 ? onLine[selIdx] : null;
        const hovPx = onLine[hoverRow === geo.rows[1] ? 1 : 0];
        check(
          '树线层级（方案 E）：hover 行的线等于 --line；选中行的线被绿罩住（≠ --line、明显偏绿）',
          !!hoverRow &&
            want.length === 3 &&
            !!selPx &&
            near(hovPx) &&
            !near(selPx) &&
            selPx.g > selPx.r + 5 &&
            covered,
          { lineCss, onLine, inCover, selIdx, selPx, hovPx }
        );
        // 留一张 hover 态的侧栏图：这类「层级对了没有」只有眼睛能最终确认
        fs.writeFileSync(
          path.join(outDir, 'smoke-sidebar-hover.png'),
          im.crop({ x: 0, y: 0, width: 240, height: 430 }).resize({ width: 720 }).toPNG()
        );
        win!.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 });
        await wait(120);
      }
    }

    // 文件是「源」：按**这次新增了几条**判，而不是写死「总共 1 条」
    const plFile = path.join(dataDir, 'playlists.json');
    const plBefore = fs.existsSync(plFile)
      ? (JSON.parse(fs.readFileSync(plFile, 'utf8'))?.lists ?? []).length
      : 0;
    const plNew = (await js(`(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 460));
      const input = document.querySelector('.sidebar .side-rename input');
      return {
        editing: !!input,
        value: input?.value ?? null,
        focused: document.activeElement === input,
        // 全选：选区覆盖整段文本 —— 于是第一个字会替换原名，而不是追加
        allSelected: input
          ? input.selectionStart === 0 && input.selectionEnd === (input.value || '').length
          : false,
      };
    })()`)) as any;
    // 主进程那边真的落了盘才算数
    const plDoc = fs.existsSync(plFile) ? JSON.parse(fs.readFileSync(plFile, 'utf8')) : null;
    check(
      'Ctrl+N 新建播放列表：立刻进入改名态（名字全选、已聚焦），并写进 data/playlists.json',
      plNew?.editing === true &&
        /^播放列表 \d+$/.test(String(plNew?.value ?? '')) &&
        plNew?.focused === true &&
        plNew?.allSelected === true &&
        Array.isArray(plDoc?.lists) &&
        plDoc.lists.length === plBefore + 1,
      { ...plNew, before: plBefore, lists: plDoc?.lists?.map((l: any) => l.name) }
    );

    /* 改名态里打字 + Enter：名字落盘、编辑框关掉 */
    const plTyped = (await js(`(async () => {
      const input = document.querySelector('.sidebar .side-rename input');
      if (!input) return null;
      input.value = '播放列表 改名测试';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 140));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 460));
      const doc = await window.api.playlists.list();
      return {
        gone: document.querySelector('.sidebar .side-rename input') === null,
        names: doc?.lists?.map((l) => l.name) ?? [],
      };
    })()`)) as any;
    check(
      '改名态里打字 + Enter：名字落盘（回写 playlists.json），编辑框关闭',
      plTyped?.gone === true && plTyped?.names?.includes('播放列表 改名测试') === true,
      plTyped
    );
    /* ---- 侧栏三件事：左右留白解耦 / 量出来的最小宽度 / 展开收起（v0.84）----
     * 三件都是「看着没问题、参数却错了」的类型，只能读真值：
     *   留白  → computed padding / margin（左右必须挂在两个不同的变量上）
     *   最小宽 → __app.sides().min，以及「最长那条文案真的没被省略」
     *   收起  → 点边缘块后列宽归零；再点回来，宽度是收起前的原值
     */
    {
      const sideVars = (await js(`(() => {
        const side = document.querySelector('.sidebar');
        const cs = getComputedStyle(side);
        const h = getComputedStyle(document.querySelector('.sidebar .side-h'));
        const g = getComputedStyle(document.querySelector('.sidebar .side-group'));
        return {
          insetL: cs.getPropertyValue('--side-inset-l').trim(),
          insetR: cs.getPropertyValue('--side-inset-r').trim(),
          hPadLeft: h.paddingLeft,
          hPadRight: h.paddingRight,
          gMarginRight: g.marginRight,
          // 旧变量必须彻底没人用：它还活着就等于左右又被捆在一起
          legacy: cs.getPropertyValue('--side-inset').trim(),
        };
      })()`)) as any;
      check(
        '侧栏左右留白解耦：左 36 / 右 12，各走各的变量（右缘不再跟着左缘一起变宽）',
        sideVars?.insetL === '36px' &&
          sideVars?.insetR === '12px' &&
          sideVars?.hPadLeft === '36px' &&
          sideVars?.hPadRight === '12px' &&
          sideVars?.gMarginRight === '12px' &&
          sideVars?.legacy === '',
        sideVars
      );

      /* 超长播放列表名：不许换行 / 挤压，只许三个点 */
      const longName = (await js(`(() => {
        const el = document.querySelector('.sidebar .side-name');
        if (!el) return null;
        const old = el.textContent;
        el.textContent = '这是一个特别特别特别特别长的播放列表名字'.repeat(3);
        const row = el.closest('.side-i');
        const cs = getComputedStyle(el);
        const out = {
          rowH: Math.round(row.getBoundingClientRect().height),
          nowrap: cs.whiteSpace,
          ellipsis: cs.textOverflow,
          // 省略号出现的判据就是「内容比盒子宽」
          clipped: el.scrollWidth > el.clientWidth + 1,
        };
        el.textContent = old;
        return out;
      })()`)) as any;
      check(
        '超长播放列表名：一行到底、右边三个点（行高仍是 26px，不换行不挤压）',
        longName?.rowH === 26 &&
          longName?.nowrap === 'nowrap' &&
          longName?.ellipsis === 'ellipsis' &&
          longName?.clipped === true,
        longName
      );

      /* 最小宽度：量出来的，而且当前宽度确实不小于它 */
      const minInfo = (await js(`(() => {
        const s = window.__app.sides();
        // 最长的那条文案有没有被省略：scrollWidth > clientWidth 就是被省略了
        const clipped = [...document.querySelectorAll('.sidebar .side-label, .sidebar .side-title')]
          .filter((e) => e.scrollWidth > e.clientWidth + 1)
          .map((e) => (e.textContent || '').trim());
        return { ...s, clipped };
      })()`)) as any;
      const measureInfo = await js(`window.__app.sideMeasure()`);
      check(
        '左侧栏最小宽度是量出来的（>150px），当前宽度不低于它，且最长文案没被省略',
        minInfo?.left?.min > 150 &&
          minInfo?.left?.w >= minInfo?.left?.min &&
          Array.isArray(minInfo?.clipped) &&
          minInfo.clipped.length === 0,
        { ...minInfo, measure: measureInfo }
      );

      /* 点边缘块：收起 → 拍图 → 再点 → 回到原宽度 */
      const sideBefore = (await js(`window.__app.sides().left.w`)) as number;
      const collapseState = (await js(`(async () => {
        const cols = () => getComputedStyle(document.querySelector('.body')).gridTemplateColumns;
        const tab = () => document.querySelector('.edge-tab.left');
        const send = (type) =>
          tab().dispatchEvent(
            new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: 0, clientY: 300 })
          );
        send('pointerdown');
        send('pointerup');
        await new Promise((r) => setTimeout(r, 320));
        return {
          collapsed: window.__app.sides().left.collapsed,
          cols: cols(),
          sideW: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
          hot: tab().classList.contains('collapsed'),
        };
      })()`)) as any;
      // 收起态留一张：把手是不是「一眼能看出这里能拉开」，只能靠眼睛判断
      await shot('smoke-side-collapsed.png');
      const backState = (await js(`(async () => {
        const tab = document.querySelector('.edge-tab.left');
        const send = (type) =>
          tab.dispatchEvent(
            new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: 0, clientY: 300 })
          );
        send('pointerdown');
        send('pointerup');
        await new Promise((r) => setTimeout(r, 320));
        return {
          collapsed: window.__app.sides().left.collapsed,
          cols: getComputedStyle(document.querySelector('.body')).gridTemplateColumns,
          w: window.__app.sides().left.w,
        };
      })()`)) as any;
      check(
        '点边缘块 → 侧栏收起（列宽归零、把手常亮）；再点 → 展开并回到收起前的宽度',
        collapseState?.collapsed === true &&
          collapseState?.sideW === 0 &&
          /^0px/.test(String(collapseState?.cols ?? '')) &&
          collapseState?.hot === true &&
          backState?.collapsed === false &&
          backState?.w === sideBefore,
        { before: sideBefore, collapseState, backState }
      );

      /* 拖到下限之后继续往里挤 → 松手收起 */
      const pullCollapse = (await js(`(async () => {
        const split = document.querySelector('.vsplit.left');
        const x0 = Math.round(split.getBoundingClientRect().left);
        const send = (type, x) =>
          split.dispatchEvent(
            new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX: x, clientY: 300 })
          );
        send('pointerdown', x0);
        send('pointermove', x0 - 400);
        const s = window.__app.sides();
        const during = { w: s.left.w, min: s.left.min, collapsed: s.left.collapsed };
        send('pointerup', x0 - 400);
        await new Promise((r) => setTimeout(r, 300));
        const after = window.__app.sides().left.collapsed;
        // 收起来了，后面的断言还要用侧栏 → 立刻展开
        if (after) {
          window.__app.toggleLeftSide();
          await new Promise((r) => setTimeout(r, 300));
        }
        return { during, after, reopened: window.__app.sides().left.collapsed };
      })()`)) as any;
      check(
        '拖到最小宽度后继续往里挤 32px → 松手收起（拖动中宽度被夹在下限，不会更窄）',
        pullCollapse?.during?.w === pullCollapse?.during?.min &&
          pullCollapse?.during?.collapsed === false &&
          pullCollapse?.after === true &&
          pullCollapse?.reopened === false,
        pullCollapse
      );

      /* 视图菜单两项 + Ctrl+B / Ctrl+D */
      const viewItems = await menuItemsOf('视图');
      const leftEntry = viewItems.find((i: any) => i.text === '左侧栏');
      const rightEntry = viewItems.find((i: any) => i.text === '详情栏');
      await closeMenus();
      check(
        '视图菜单有「左侧栏 Ctrl+B」「详情栏 Ctrl+D」，展开态带勾选',
        leftEntry?.accel === 'Ctrl+B' &&
          rightEntry?.accel === 'Ctrl+D' &&
          leftEntry?.tick === '✓',
        { leftEntry, rightEntry }
      );

      const hotkeys = (await js(`(async () => {
        const key = async (k) => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }));
          await new Promise((r) => setTimeout(r, 260));
        };
        await key('b');
        const leftOff = window.__app.sides().left.collapsed;
        await key('d');
        const rightOff = window.__app.sides().right.collapsed;
        // 还原：后面还要用两根栏
        await key('b');
        await key('d');
        const s = window.__app.sides();
        return { leftOff, rightOff, backL: s.left.collapsed, backR: s.right.collapsed };
      })()`)) as any;
      check(
        'Ctrl+B / Ctrl+D 分别收起左侧栏与详情栏，再按一次回来',
        hotkeys?.leftOff === true &&
          hotkeys?.rightOff === true &&
          hotkeys?.backL === false &&
          hotkeys?.backR === false,
        hotkeys
      );

      /* 真 hover 到栏边界，拍下「把手浮出来」的样子 —— 这类东西只有眼睛能定 */
      const edgeAt = (await js(`(() => {
        const s = document.querySelector('.sidebar').getBoundingClientRect();
        return { x: Math.round(s.right - 1), y: Math.round(s.top + s.height / 2) };
      })()`)) as any;
      if (edgeAt) {
        win!.webContents.sendInputEvent({ type: 'mouseMove', x: edgeAt.x, y: edgeAt.y });
        await wait(360);
        const im = await win!.webContents.capturePage();
        const size = im.getSize();
        const [cw] = win!.getContentSize();
        const ratio = size.width / cw;
        fs.writeFileSync(
          path.join(outDir, 'smoke-side-edge.png'),
          im
            .crop({
              x: Math.max(0, Math.round((edgeAt.x - 90) * ratio)),
              y: Math.max(0, Math.round((edgeAt.y - 70) * ratio)),
              width: Math.round(180 * ratio),
              height: Math.round(140 * ratio),
            })
            .resize({ width: 540 })
            .toPNG()
        );
        win!.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 400 });
        await wait(140);
      }

      /* 把手的**位置**：必须贴在栏边界上。第一版写成 left:-4px，贴到了窗口最左边 */
      const edgeGeo = (await js(`(() => {
        const s = document.querySelector('.sidebar').getBoundingClientRect();
        const t = document.querySelector('.edge-tab.left').getBoundingClientRect();
        const knob = document.querySelector('.edge-tab.left .edge-tab-knob');
        const cs = getComputedStyle(knob);
        return {
          gap: Math.round(t.left - (s.right - 4)),
          knobW: cs.width,
          knobH: cs.height,
          radius: cs.borderRadius,
          bg: cs.backgroundColor,
          opacity: cs.opacity,
          chev: !!document.querySelector('.edge-tab.left .edge-tab-chev path'),
        };
      })()`)) as any;
      check(
        '边缘把手贴在栏边界（不是窗口最左边），形状是「灰色半透明圆角块 + 直角箭头」，不 hover 时不显示',
        Math.abs(edgeGeo?.gap ?? 99) <= 1 &&
          edgeGeo?.knobW === '14px' &&
          edgeGeo?.knobH === '38px' &&
          edgeGeo?.radius === '4px' &&
          edgeGeo?.chev === true &&
          edgeGeo?.opacity === '0' &&
          /0\.\d+\)/.test(String(edgeGeo?.bg ?? '')),
        edgeGeo
      );

      /* 省略号和右侧计数之间要有呼吸 */
      const numGap = (await js(`(() => {
        const el = document.querySelector('.sidebar .side-name');
        if (!el) return null;
        const num = el.parentElement.querySelector('.num');
        if (!num) return null;
        const cs = getComputedStyle(num);
        return {
          gap: Math.round(num.getBoundingClientRect().left - el.getBoundingClientRect().right),
          minW: cs.minWidth,
        };
      })()`)) as any;
      check(
        '省略号不顶到计数：文字与数字之间留 ≥8px，且数字锁成两位宽（一位数时也不左移）',
        // minWidth 读回来是**计算后**的 px（2ch ≈ 12.4px），不是 `2ch` 字面量 —— 别按字面量判
        numGap?.gap >= 8 && parseFloat(String(numGap?.minW ?? 0)) >= 10,
        numGap
      );

      /* 侧栏留白：浅色 / 深色各存一份，互不影响 */
      const insetCfg = (await js(`(async () => {
        const side = document.querySelector('.sidebar');
        const read = () => ({
          l: getComputedStyle(side).getPropertyValue('--side-inset-l').trim(),
          r: getComputedStyle(side).getPropertyValue('--side-inset-r').trim(),
        });
        const setNum = (rowIdx, numIdx, v) => {
          const row = [...document.querySelectorAll('.inset-row')][rowIdx];
          const inp = row?.querySelectorAll('.inset-num')[numIdx];
          if (!inp) return false;
          inp.value = String(v);
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        window.__app.prefs(true);
        await new Promise((r) => setTimeout(r, 300));
        await window.__app.setTheme('light');
        await new Promise((r) => setTimeout(r, 360));
        const lightBefore = read();
        const lightMinBefore = window.__app.sides().left.min;
        const okLight = setNum(0, 0, 20);
        await new Promise((r) => setTimeout(r, 360));
        const lightAfter = read();
        const lightMinAfter = window.__app.sides().left.min;
        // 切回深色：深色那一套应该是**原封不动**的 36
        await window.__app.setTheme('dark');
        await new Promise((r) => setTimeout(r, 360));
        const darkNow = read();
        // 还原（否则后面所有截图都变成浅色 / 20px）
        await window.__app.setTheme('light');
        await new Promise((r) => setTimeout(r, 300));
        setNum(0, 0, 36);
        await new Promise((r) => setTimeout(r, 300));
        await window.__app.setTheme('dark');
        await new Promise((r) => setTimeout(r, 300));
        window.__app.prefs(false);
        await new Promise((r) => setTimeout(r, 220));
        return { okLight, lightBefore, lightAfter, lightMinBefore, lightMinAfter, darkNow, back: read() };
      })()`)) as any;
      check(
        '侧栏留白按主题各存一份：改浅色的左留白 → 立刻生效、下限跟着变小；切到深色仍是原来的 36',
        insetCfg?.okLight === true &&
          insetCfg?.lightBefore?.l === '36px' &&
          insetCfg?.lightAfter?.l === '20px' &&
          insetCfg?.darkNow?.l === '36px' &&
          insetCfg?.lightMinAfter < insetCfg?.lightMinBefore &&
          insetCfg?.back?.l === '36px',
        insetCfg
      );
    }

    // 先留一张「菜单开着」的截图：排版这类事，断言只能证明结构，看不出好不好看
    await js(`(() => {
      const h = document.querySelectorAll('.sidebar .side-h')[0];
      h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 }));
    })()`);
    await wait(240);
    await shot('smoke-playlist-menu.png');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(140);

    /* ---- 右键菜单：label 整行与每个列表项都唤得出来 ---- */
    const plCtx = (await js(`(async () => {
      const menus = () => [...document.querySelectorAll('.pl-menu .ctx-item')].map((b) => b.textContent.trim());
      // ① label 那一整行（这里点标题的下半截，靠边也算这一行）
      const head = document.querySelectorAll('.sidebar .side-h')[0];
      head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 }));
      await new Promise((r) => setTimeout(r, 120));
      const onHead = menus();
      // ② 点别处就关
      document.querySelector('.detail')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const closedOutside = document.querySelector('.pl-menu') === null;
      // ③ 具体列表项上右键：多出改名 / 删除
      const row = [...document.querySelectorAll('.sidebar .side-i')].find((b) => /播放列表/.test(b.textContent));
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 150 }));
      await new Promise((r) => setTimeout(r, 120));
      const onRow = menus();
      // ④ Esc 也能关
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const closedEsc = document.querySelector('.pl-menu') === null;
      return { onHead, onRow, closedOutside, closedEsc };
    })()`)) as any;
    check(
      '右键播放列表 label 整行 → 菜单里有「新建播放列表」「搜索播放列表」；点别处 / Esc 都能关',
      plCtx?.onHead?.length === 2 &&
        /新建播放列表/.test(String(plCtx.onHead[0] ?? '')) &&
        /搜索播放列表/.test(String(plCtx.onHead[1] ?? '')) &&
        plCtx.closedOutside === true &&
        plCtx.closedEsc === true,
      plCtx
    );
    check(
      '右键某个播放列表项 → 额外给出「重命名」「删除播放列表」',
      plCtx?.onRow?.length === 4 &&
        /新建播放列表/.test(String(plCtx.onRow[0] ?? '')) &&
        /重命名/.test(String(plCtx.onRow[1] ?? '')) &&
        /删除播放列表/.test(String(plCtx.onRow[2] ?? '')) &&
        /搜索播放列表/.test(String(plCtx.onRow[3] ?? '')),
      plCtx?.onRow
    );

    /* ---- 侧栏搜索：右键标题 →「搜索…」→ 输入标题关键词过滤 ----
     * 三块同一套：播放列表 / 泳道方案 / 词表。只匹配标题，不做分词。 */
    const sideSearchUI = (await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const heads = document.querySelectorAll('.sidebar .side-h');
      const open = async (idx) => {
        heads[idx].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 120 }));
        await sleep(100);
        [...document.querySelectorAll('.pl-menu .ctx-item')].find((b) => /搜索/.test(b.textContent))?.click();
        await sleep(140);
        return document.querySelector('.side-search-input');
      };
      const setVal = (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      // 三块都是「标题 + 紧邻的 .side-group」：按标题取组，别把别组的行算进来
      const labelsIn = (idx, sel) =>
        [...heads[idx].nextElementSibling.querySelectorAll(sel)].map((x) => x.textContent.trim());

      // 词表：搜「体」→ 只剩体裁
      const vocabInput = await open(2);
      const focused = document.activeElement === vocabInput;
      setVal(vocabInput, '体');
      await sleep(140);
      const vocabRows = labelsIn(2, '.side-row .side-label');
      vocabInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(140);
      const vocabClosed = document.querySelector('.side-search-input') === null;

      // 泳道方案：搜「罗」→ 罗马数字级数
      const viewInput = await open(1);
      setVal(viewInput, '罗');
      await sleep(140);
      const viewRows = labelsIn(1, '.side-i .side-label');
      viewInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(140);

      // 播放列表：搜「改名测试」→ 只剩那条；「全部曲目」也不同时显示
      const plInput = await open(0);
      setVal(plInput, '改名测试');
      await sleep(140);
      const plRows = labelsIn(0, '.side-i .side-name');
      const plHasAll = labelsIn(0, '.side-i .side-label').includes('全部曲目');
      plInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(140);
      return {
        focused,
        vocabRows,
        vocabClosed,
        viewRows,
        plRows,
        plHasAll,
        restoredVocab: labelsIn(2, '.side-row .side-label').length,
      };
    })()`)) as any;
    check(
      '侧栏搜索：右键「词表」→ 搜索 → 输入「体」只剩体裁；Esc 收起后全部词表回来',
      sideSearchUI?.focused === true &&
        JSON.stringify(sideSearchUI?.vocabRows) === JSON.stringify(['体裁']) &&
        sideSearchUI?.vocabClosed === true &&
        Number(sideSearchUI?.restoredVocab) > 1,
      sideSearchUI
    );
    check(
      '泳道方案 / 播放列表也能右键搜索：标题关键词过滤，不匹配的「全部曲目」一起收起',
      JSON.stringify(sideSearchUI?.viewRows) === JSON.stringify(['罗马数字级数']) &&
        JSON.stringify(sideSearchUI?.plRows) === JSON.stringify(['播放列表 改名测试']) &&
        sideSearchUI?.plHasAll === false,
      sideSearchUI
    );

    /* ---- 在具体列表里：菜单多一项「从『X』移出」，走完整条回路 ----
     * 这里查的是**归属**这一层：加进去 → 列表里只剩它 → 移出 → 列表空。
     * 单测碰不到「右键菜单长什么样」，只能真点。
     */
    {
      // ① 切到刚才 Ctrl+N 建的那条空列表（取最后一条 —— 新建的永远在末尾，
      //    不依赖用户 data/playlists.json 里那几条是不是空的）
      const pickName = (await js(`(() => {
        const items = [...document.querySelectorAll('.sidebar .side-i')];
        const hit = items.filter((b) => /播放列表 \\d+/.test(b.textContent)).pop();
        hit?.click();
        return hit?.querySelector('.side-name')?.textContent?.trim() ?? null;
      })()`)) as string | null;
      await wait(320);
      const inEmptyList = await js(`document.querySelectorAll('.row[data-track-id]').length`);

      // ② 先把「全部曲目」里的一首加进来（用曲目菜单，和用户路径一致）
      await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('全部曲目'))?.click()`);
      await wait(280);
      const first = (await js(`(() => {
        const row = document.querySelector('.row[data-track-id]');
        return row ? { id: row.dataset.trackId, title: row.querySelector('.c-title .t')?.textContent?.trim() ?? '' } : null;
      })()`)) as any;
      await js(`(() => {
        const row = document.querySelector('.row[data-track-id]');
        row?.querySelector('.c-title')?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })
        );
        return true;
      })()`);
      await wait(220);
      await js(
        `[...document.querySelectorAll('.track-menu .ctx-item')].find((b) => /添加到播放列表/.test(b.textContent))?.click()`
      );
      await wait(240);
      // 按名字点那一条（列表名里有空格，用 trim 后全等比对，别用 includes）
      const picked = await js(`(() => {
        const name = ${JSON.stringify(pickName ?? '')};
        const hit = [...document.querySelectorAll('.pl-pick-row')].find(
          (r) => (r.querySelector('.pl-pick-name')?.textContent ?? '').trim() === name
        );
        hit?.click();
        return !!hit;
      })()`);
      await wait(360);

      // ③ 回到那条列表：里面应该只有这一首
      await js(
        `[...document.querySelectorAll('.sidebar .side-i')].find((b) => (b.querySelector('.side-name')?.textContent ?? '').trim() === ${JSON.stringify(pickName ?? '')})?.click()`
      );
      await wait(320);
      const inList = (await js(`(() => {
        const rows = [...document.querySelectorAll('.row[data-track-id]')];
        return { n: rows.length, title: rows[0]?.querySelector('.c-title .t')?.textContent?.trim() ?? null };
      })()`)) as any;

      // ④ 右键它 → 菜单里应该多出「从『X』移出」
      await js(`(() => {
        document.querySelector('.row[data-track-id] .c-title')?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })
        );
        return true;
      })()`);
      await wait(220);
      const rmLabel = (await js(`(() => {
        const b = [...document.querySelectorAll('.track-menu .ctx-item')].find((x) => /移出/.test(x.textContent));
        return b ? b.textContent.trim() : null;
      })()`)) as string | null;
      await shot('smoke-track-in-list.png');
      await js(`[...document.querySelectorAll('.track-menu .ctx-item')].find((x) => /移出/.test(x.textContent))?.click()`);
      await wait(360);
      const afterRemove = (await js(`(() => {
        return {
          rows: document.querySelectorAll('.row[data-track-id]').length,
          empty: !!document.querySelector('.empty'),
          msg: document.querySelector('.status .dim')?.textContent?.trim() ?? '',
        };
      })()`)) as any;
      const docAfter = fs.existsSync(plFile) ? JSON.parse(fs.readFileSync(plFile, 'utf8')) : null;
      const listed = (docAfter?.lists ?? []).find((l: any) => l.name === pickName);
      check(
        '曲目菜单能把这首加进指定列表、也能从列表里移出（菜单项只在具体列表里出现，状态栏报一句）',
        !!pickName &&
          inEmptyList === 0 &&
          !!first &&
          picked === true &&
          inList?.n === 1 &&
          inList?.title === first?.title &&
          /移出/.test(String(rmLabel ?? '')) &&
          String(rmLabel ?? '').includes(String(pickName)) &&
          afterRemove?.rows === 0 &&
          afterRemove?.empty === true &&
          /移出/.test(String(afterRemove?.msg ?? '')) &&
          Array.isArray(listed?.trackIds) &&
          listed.trackIds.length === 0,
        { pickName, inEmptyList, first, inList, rmLabel, afterRemove, listed }
      );
    }

    // 收尾：切回「全部曲目」，免得后面的守卫检查在空列表上跑
    await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('全部曲目'))?.click()`);
    await wait(160);
  }

  /* ---- 设置面板：左侧 tab 导航 + 转位数字偏好（v0.76）----
   * 面板有 15 个区块，一屏放不下：左边四个 tab 负责跳转，滚动时高亮跟随。
   */
  {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
    await wait(360);
    const nav = (await js(`(() => {
      const modal = document.querySelector('.modal.settings');
      if (!modal) return null;
      const panes = modal.querySelector('.s-panes');
      return {
        tabs: [...modal.querySelectorAll('.s-nav button')].map((b) => b.textContent.trim()),
        groups: [...new Set([...modal.querySelectorAll('[data-group]')].map((d) => d.dataset.group))],
        hasPanes: !!panes,
        scrollable: panes ? panes.scrollHeight > panes.clientHeight + 20 : false,
      };
    })()`)) as any;
    check(
      '设置面板：左侧四个 tab（外观 / 编辑 / 播放 / 窗口），右侧是可滚动的内容区',
      nav?.tabs?.length === 4 &&
        nav.tabs.join('/') === '外观/编辑/播放/窗口' &&
        nav.groups.length === 4 &&
        nav.hasPanes &&
        nav.scrollable,
      nav
    );

    await shot('smoke-prefs-tabs.png');

    // 点「播放」：滚过去 + 高亮跟手
    await js(`[...document.querySelectorAll('.modal.settings .s-nav button')].find((b) => b.textContent.trim() === '播放')?.click()`);
    await wait(900);
    const afterPlay = (await js(`(() => {
      const modal = document.querySelector('.modal.settings');
      const panes = modal.querySelector('.s-panes');
      return {
        scrollTop: Math.round(panes.scrollTop),
        on: [...modal.querySelectorAll('.s-nav button')].find((b) => b.classList.contains('on'))?.textContent.trim() ?? null,
      };
    })()`)) as any;
    check(
      '点「播放」：内容区平滑滚到该分组，tab 高亮切过去',
      Number(afterPlay?.scrollTop) > 40 && afterPlay?.on === '播放',
      afterPlay
    );

    // 点「窗口」（最后一组）：必须能滚到底并高亮，不能被前面的组永远压住
    await js(`[...document.querySelectorAll('.modal.settings .s-nav button')].find((b) => b.textContent.trim() === '窗口')?.click()`);
    await wait(900);
    const afterWin = (await js(`(() => {
      const modal = document.querySelector('.modal.settings');
      const panes = modal.querySelector('.s-panes');
      return {
        atBottom: panes.scrollTop + panes.clientHeight >= panes.scrollHeight - 6,
        on: [...modal.querySelectorAll('.s-nav button')].find((b) => b.classList.contains('on'))?.textContent.trim() ?? null,
      };
    })()`)) as any;
    check(
      '点最后一组「窗口」：滚到底并高亮它（scroll spy 的兜底）',
      afterWin?.atBottom === true && afterWin?.on === '窗口',
      afterWin
    );

    // 转位数字：切阿拉伯 → 落盘 → 补全提示跟着变
    await js(`[...document.querySelectorAll('.modal.settings .chip')].find((b) => b.textContent.includes('阿拉伯'))?.click()`);
    await wait(240);
    const lsNum = await js(`localStorage.getItem('ma-fig-numeral')`);
    check('切到「阿拉伯」后写进 localStorage（ma-fig-numeral）', lsNum === 'arabic', { lsNum });

    await js(`[...document.querySelectorAll('.modal.settings .s-head button')][0]?.click()`);
    await wait(240);

    const tidNum = rows(`SELECT id FROM track WHERE title = '神鹿谣' AND deleted_at IS NULL`)[0]?.id;
    if (tidNum) {
      await js(`window.__app.select(${JSON.stringify(tidNum)})`);
      await wait(420);
      await js(`[...document.querySelectorAll('.sidebar .side-i')].find((b) => b.textContent.includes('斯波索宾体系'))?.click()`);
      await wait(420);
      await js(`window.__ma.clear()`);
      await js(`window.__ma.select(2, 0, 0, ['sposobin'])`);
      await js(`window.__ma.openEdit('')`);
      await wait(180);
      await js(`(() => {
        const el = document.querySelector('.cell-input');
        if (!el) return;
        el.value = 'D56';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await wait(240);
      const arHint = (await js(`document.querySelector('.cell-sug li em')?.textContent?.trim() ?? ''`)) as string;
      check('切到阿拉伯后，补全提示变成「第1转位」', arHint === '第1转位', { arHint });
      await js(`document.querySelector('.cell-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(160);
    }

    // 恢复汉字：后面还有断言，别把全局状态留给别人
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
    await wait(320);
    await js(`[...document.querySelectorAll('.modal.settings .chip')].find((b) => b.textContent.includes('汉字'))?.click()`);
    await wait(200);
    const lsNum2 = await js(`localStorage.getItem('ma-fig-numeral')`);
    await js(`[...document.querySelectorAll('.modal.settings .s-head button')][0]?.click()`);
    await wait(200);
    check('切回「汉字」后同样落盘', lsNum2 === 'han', { lsNum2 });
  }

  /* ---- 元数据「填入档案」：确认窗口 + 逐字段勾选（v0.89）----
   *
   * 这里必须**自己造一个带 iXML 的 wav**：用户库里不一定有这种文件，
   * 而且冒烟不该依赖 H 盘上的 Cubase 工程。临时文件写进冒烟数据副本，
   * 关联到神鹿谣的第 3 条录音（非默认，改它不影响「点作品播放先播哪一版」）。
   */
  {
    const mkProbeWav = (bpm: number, album: string) => {
      const u32 = (v: number) => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(v);
        return b;
      };
      const u16 = (v: number) => {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(v);
        return b;
      };
      const ixml = Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><BWFXML><STEINBERG><ATTR_LIST>` +
          `<ATTR><NAME>MusicalTempo</NAME><TYPE>float</TYPE><VALUE>${bpm}</VALUE></ATTR>` +
          `<ATTR><NAME>MusicalSignature</NAME><TYPE>rational</TYPE><NUMERATOR>6</NUMERATOR><DENOMINATOR>8</DENOMINATOR></ATTR>` +
          `<ATTR><NAME>MediaCompany</NAME><TYPE>string</TYPE><VALUE>${album}</VALUE></ATTR>` +
          `</ATTR_LIST></STEINBERG></BWFXML>`,
        'utf8'
      );
      const fmt = Buffer.concat([
        Buffer.from('fmt '),
        u32(16),
        u16(1),
        u16(1),
        u32(48000),
        u32(96000),
        u16(2),
        u16(16),
      ]);
      const dataLen = 48000 * 2;
      const body = Buffer.concat([
        Buffer.from('WAVE'),
        fmt,
        Buffer.concat([Buffer.from('data'), u32(dataLen), Buffer.alloc(dataLen)]),
        Buffer.concat([Buffer.from('iXML'), u32(ixml.length), ixml]),
      ]);
      return Buffer.concat([Buffer.from('RIFF'), u32(body.length), body]);
    };

    const probeFile = path.join(dataDir, 'meta-probe.wav');
    fs.mkdirSync(path.dirname(probeFile), { recursive: true });
    fs.writeFileSync(probeFile, mkProbeWav(96, 'PROBE-ALBUM'));

    const st = rows(`SELECT id FROM track WHERE title = '神鹿谣' AND deleted_at IS NULL`)[0]?.id;
    const probeRec = (
      rows(`SELECT id, file_path FROM recording WHERE track_id = ? AND deleted_at IS NULL ORDER BY seq`, st) as any[]
    ).pop();
    const origRecPath = probeRec?.file_path ?? null;
    if (st && probeRec) {
      handle.db.prepare(`UPDATE recording SET file_path = ? WHERE id = ?`).run(probeFile, probeRec.id);
      await js(`window.__app.select(${JSON.stringify(st)})`);
      await wait(520);

      await js(`(() => {
        const el = document.querySelector('.rec-item[data-rec-id="${probeRec.id}"]');
        el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 460, clientY: 460 }));
        return !!el;
      })()`);
      await wait(240);
      await js(`[...document.querySelectorAll('.rec-menu .ctx-item')].find((b) => /音频元数据/.test(b.textContent))?.click()`);
      await wait(520);
      const hasApplyBtn = await js(
        `!![...document.querySelectorAll('.am-apply .chip')].find((b) => /填入档案/.test(b.textContent))`
      );
      await js(`[...document.querySelectorAll('.am-apply .chip')].find((b) => /填入档案/.test(b.textContent))?.click()`);
      await wait(340);

      const applyState = (await js(`(() => {
        const p = document.querySelector('.ma-panel');
        return {
          open: !!p,
          rows: [...(p?.querySelectorAll('.ma-row') ?? [])].map((r) => ({
            label: r.querySelector('.ma-label')?.textContent?.trim() ?? '',
            file: r.querySelector('.ma-file-val')?.textContent?.trim() ?? '',
            checked: !!r.querySelector('input')?.checked,
            disabled: !!r.querySelector('input')?.disabled,
          })),
        };
      })()`)) as any;
      const labels = (applyState?.rows ?? []).map((r: any) => r.label).join(' / ');
      check(
        '元数据「填入档案」→ 先弹确认窗口，逐字段列出「文件值 → 档案值」，默认全勾',
        hasApplyBtn === true &&
          applyState?.open === true &&
          applyState.rows.length >= 3 &&
          /速度/.test(labels) &&
          /专辑/.test(labels) &&
          applyState.rows.filter((r: any) => !r.disabled).every((r: any) => r.checked === true),
        applyState
      );

      // 取消「专辑」「拍号」两行的勾，只留「速度」：验证「取消勾选的内容不会被写进去」
      await js(`(() => {
        for (const re of [/专辑/, /拍号/]) {
          const row = [...document.querySelectorAll('.ma-row')].find((r) => re.test(r.querySelector('.ma-label')?.textContent ?? ''));
          row?.querySelector('input')?.click();
        }
      })()`);
      await wait(200);
      const beforeRow = rows(`SELECT album FROM track WHERE id = ?`, st)[0] as any;
      const beforeMeter = rows(
        `SELECT meter_num, meter_den FROM analysis WHERE track_id = ? AND deleted_at IS NULL LIMIT 1`,
        st
      )[0] as any;
      await js(`[...document.querySelectorAll('.ma-actions .chip')].find((b) => /填入/.test(b.textContent))?.click()`);
      await wait(700);
      const afterRow = rows(
        `SELECT t.album, a.tempo_value, a.meter_num, a.meter_den
           FROM track t LEFT JOIN analysis a ON a.track_id = t.id WHERE t.id = ?`,
        st
      )[0] as any;
      const winClosed = await js(`document.querySelector('.ma-panel') === null`);
      check(
        '确认窗口：只写勾选的「速度」，取消勾选的「专辑 / 拍号」一个字都没动',
        winClosed === true &&
          Number(afterRow?.tempo_value) === 96 &&
          String(afterRow?.album ?? '') === String(beforeRow?.album ?? '') &&
          Number(afterRow?.meter_num) === Number(beforeMeter?.meter_num) &&
          Number(afterRow?.meter_den) === Number(beforeMeter?.meter_den),
        { afterRow, beforeRow, beforeMeter, winClosed }
      );

      // 恢复：把探针文件的关联、被改的 bpm 都还原，别把副本状态留给后面的断言
      handle.db.prepare(`UPDATE recording SET file_path = ? WHERE id = ?`).run(origRecPath, probeRec.id);
      handle.db.prepare(`UPDATE analysis SET tempo_value = NULL WHERE track_id = ? AND tempo_value = 96`).run(st);
      try {
        fs.unlinkSync(probeFile);
      } catch {
        /* 副本里删不掉也无所谓 */
      }
    }
  }

  /**
   * 守卫放最后：前面 120 项断言查库、量几何，全都绕开了渲染层异常，
   * 于是一条 onMounted 里的 TypeError 能让主界面变成空壳而断言全绿。
   * 这条把「渲染层一条错误都不许有」变成硬指标。
   */
  check('渲染层零未捕获异常（onMounted 抛错会让主界面变空壳）', rendererErrors.length === 0, {
    count: rendererErrors.length,
    sample: rendererErrors.slice(0, 5),
  });

  if (SMOKE_QUIET) {
    /**
     * 安静模式不逐条回放：失败行在 check() 里已经即时打到 stderr，
     * 这里只落一份完整报告 + 一行汇总。文件放 shots/（已被 .gitignore 排除），
     * 每次覆盖，不会像编号副本那样堆积。
     */
    const reportPath = path.join(outDir, 'smoke-report.txt');
    // 带 BOM：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 读，
    // 没有 BOM 时中文会整片乱码；有 BOM 时编辑器 / Get-Content 都能认。
    fs.writeFileSync(reportPath, `\uFEFF${results.join('\n')}\n`, 'utf8');
    console.log('[smoke] 完整结果：shots/smoke-report.txt');
  } else {
    for (const line of results) console.log(`[smoke] ${line}`);
  }
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(
    `[smoke] ${results.length - failed}/${results.length} 断言通过${failed ? ` · ${failed} 条失败` : ''}`
  );
  publishSmokeProgress({
    done: true,
    aborted: false,
    total: results.length,
    passed: results.length - failed,
    failed,
    last: failed ? '有断言失败，见上面的 FAIL 行' : '全部通过',
    endedAt: Date.now(),
  });
}


app.whenReady().then(() => {
  // 第二个实例什么都不该做：不开数据库、不开窗口，直接退出
  if (!gotSingleInstanceLock) return;

  // 排查性能用：`electron . --gpu-info` 把 Chromium 的 GPU 特性写进 logs/boot.log。
  // 必须等窗口真的开始合成之后再读：whenReady 当场读到的还是默认值（全是 disabled_software）。
  if (process.argv.includes('--gpu-info')) {
    bootLog(`gpu-feature ${JSON.stringify(app.getGPUFeatureStatus())}`);
    setTimeout(() => {
      bootLog(`gpu-late ${JSON.stringify(app.getGPUFeatureStatus())}`);
      void app
        .getGPUInfo('complete')
        .then((info) => bootLog(`gpu-info ${JSON.stringify(info)}`))
        .catch((e) => bootLog(`gpu-info failed ${String(e)}`));
    }, 5000);
  }

  boot();
  registerIpc();

  /**
   * 「跟随系统」模式：系统切深浅时把新值广播给所有窗口。
   * nativeTheme 的 'updated' 在 Windows 上跟随「设置 → 个性化 → 颜色」，
   * macOS 上跟随「系统外观」（浅色 / 深色 / 自动）。
   * 这里只推送**系统当前是什么**，至于要不要用是渲染层 themeMode 的事 ——
   * 用户选固定深色时同样会收到推送，但 resolveTheme 会忽略它。
   */
  nativeTheme.on('updated', () => {
    broadcast('app:system-theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  /**
   * 关掉 Electron 的默认应用菜单。
   * 它把 Ctrl+R 绑成了「重新加载页面」—— 而我们要用 Ctrl+R 登记作品，
   * 不摘掉的话按下去会整页刷新，用户当场丢掉没保存的输入。
   * 菜单由渲染层自己画（MenuBar.vue），这里的原生菜单栏本来也看不见。
   */
  Menu.setApplicationMenu(null);

  // 封面协议：只接受 trackId + single/album，路径同样由数据库决定
  protocol.handle('ma-art', (req) => {
    try {
      return mediaIpc.serveArt({ db: handle.db, dataDir, assetsDir }, req);
    } catch (e) {
      console.error('[art] 处理失败', req.url, e);
      return new Response(`cover error: ${String(e)}`, { status: 500 });
    }
  });

  // 音频协议：只接受 trackId，真实路径由数据库决定
  protocol.handle('ma-audio', (req) => {
    try {
      return audioIpc.serveAudio(handle.db, dataDir, req);
    } catch (e) {
      console.error('[audio] 处理失败', req.url, e);
      return new Response(`audio error: ${String(e)}`, { status: 500 });
    }
  });

  createWindow();
  if (SMOKE_MODE) {
    // app.commandLine 的 mute-audio 有时被媒体内部播放路径绕过，这里逐窗口再关一次
    const muteAll = (w: BrowserWindow | null) => {
      try {
        w?.webContents.setAudioMuted(true);
      } catch {
        /* 窗口已销毁 */
      }
    };
    muteAll(win);
    app.on('browser-window-created', (_e, w) => {
      muteAll(w);
      /**
       * 子窗口（帮助 / 歌词 / 桌面歌词 / 网格 / 历史 / 图片）统一进沙箱。
       * 这里设一次，`show` 之后再补一次 —— 窗口刚创建时 Windows 上还没有原生句柄，
       * `setIgnoreMouseEvents` 会落空（不报错，就是不生效）。
       */
      quietWindow(w);
      w.once('show', () => quietWindow(w));
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (process.argv.includes('--smoke')) {
    /**
     * 冒烟的死线。窗口在冒烟模式下是**鼠标穿透 + 不进任务栏**的，
     * 万一某条断言卡死（等一个永远不来的条件），用户**点不动也关不掉** —— 只能开任务管理器。
     * 到点直接 `app.exit`，让 `npm run smoke` 拿到非零退出码，比留一个鬼窗口好。
     */
    const hardStop = setTimeout(() => {
      bootLog('smoke hard timeout');
      app.exit(1);
    }, SMOKE_HARD_TIMEOUT_MS);
    (hardStop as any).unref?.();

    win!.webContents.once('did-finish-load', () => {
      smoke()
        .catch((e) => console.error('[smoke] 失败：', e))
        .finally(() => {
          // 中途抛异常 / 被死线打断时，状态文件不能永远停在「在跑」
          if (smokeRunPatch.done !== true) {
            publishSmokeProgress({ done: true, aborted: true, last: '异常中止（见控制台）', endedAt: Date.now() });
          }
          setTimeout(() => app.quit(), 300);
        });
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/** 退出前把历史强制写盘（debounce 里可能还压着最近几步） */
app.on('before-quit', () => {
  try {
    historyStore?.flush();
  } catch (e) {
    console.error('[history] 退出前写盘失败', e);
  }
});

/**
 * 第二个实例被唤醒时：把已有窗口抬到前台，别看起来像「双击了没反应」。
 */
app.on('second-instance', () => {
  if (!gotSingleInstanceLock) return;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

/** 主进程兜底：未捕获异常也要留下痕迹，不能「双击了没反应也没有报错」 */
process.on('uncaughtException', (err) => {
  bootLog(`uncaughtException ${err?.stack ?? String(err)}`);
  console.error('[main] uncaughtException', err);
});
process.on('unhandledRejection', (err) => {
  bootLog(`unhandledRejection ${String(err)}`);
});
