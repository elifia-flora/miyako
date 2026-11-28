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
import { pathToFileURL } from 'node:url';
import { isAllowedExternal, isAppPage } from './nav-policy.js';
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
import {
  commitDetailAudio,
  commitDetailImages,
  commitDetailLyrics,
  commitLibraryDrop,
  importDroppedAudio,
  previewDrop,
} from './ipc/dropaudio';
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

/**
 * 开发模式沿用改名前的用户目录。
 *
 * `package.json` 里有 `productName: miyako`（打包后的 exe / 安装目录都叫这个），
 * 而 Electron 用 productName 决定 userData —— 于是 dev 会从 `%APPDATA%\music-atlas`
 * 换到 `%APPDATA%\miyako`，看起来像「曲库空了、设置没了」。这里只把**未打包**的情况
 * 按回老目录，打包版仍然是 miyako（升级不会互相打架）。
 */
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'music-atlas'));
}

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
  recId: null,
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

/* ==================== 渲染层安全设置 ==================== */

/**
 * 渲染进程沙箱。默认开：preload 只用了 `contextBridge` + `ipcRenderer`（见 src/preload/index.ts），
 * 在沙箱里完全够用；关掉沙箱等于让每个渲染进程都带着完整的 Node 能力跑。
 *
 * 对开发 / 调试的影响：DevTools、`npm run app:debug` 的 CDP 端口、冒烟里的
 * `webContents.executeJavaScript` / `capturePage` 都不受沙箱影响（整套冒烟在沙箱下跑过，结果与关沙箱时一致）。
 * 受影响的只有「在 preload 里直接用 Node 模块」—— 这类需求请走 IPC 交给主进程。
 *
 * 逃生阀：**仅开发模式**（未打包）下 `MA_RENDERER_SANDBOX=0` 可以临时关掉，用来排查
 * 「是不是沙箱导致的」这类问题；打包后的应用忽略这个变量，永远开着。
 * 注意它不是 `--no-sandbox`：那个会关掉整个 Chromium 的进程沙箱，见 docs/ELECTRON-UPGRADE.md。
 */
const RENDERER_SANDBOX = app.isPackaged || process.env.MA_RENDERER_SANDBOX !== '0';
if (!RENDERER_SANDBOX) console.warn('[security] MA_RENDERER_SANDBOX=0：开发模式下临时关闭渲染进程沙箱');

/**
 * 所有窗口共用的 webPreferences。以前七个窗口各抄一份，改一处漏一处；
 * 现在只有这一份，窗口自己的差异（如 `backgroundThrottling`）作为 `extra` 传进来。
 */
function securePrefs(extra: Electron.WebPreferences = {}): Electron.WebPreferences {
  return {
    ...extra,
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: RENDERER_SANDBOX,
    nodeIntegration: false,
    webSecurity: true,
  };
}

/** 渲染层自己的页面（dev server 或打包后的 index.html） */
function appPageInfo() {
  return {
    devUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    pageUrl: pathToFileURL(path.join(__dirname, '../renderer/index.html')).href,
  };
}

/**
 * 对**每一个** webContents（含子窗口）生效：
 * - `window.open` / 新窗口：http(s) 与网易云（orpheus:）交给系统打开，应用内一律不开新窗口；
 * - 页面跳转：只允许留在应用自己的页面上。允许外开的地址照样交给系统打开；其余（如把文件拖进窗口时
 *   Chromium 默认的「导航到这个文件」，整个界面会被替换掉）直接拦下。
 *
 * 网易云「打开 / 唤起客户端播放」走的是 IPC（netease:open → openMusicLink），不经过这里。
 * 规则本身在 nav-policy.js，有单测。
 */
function installNavigationGuards() {
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternal(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (ev, url) => {
      if (isAppPage(url, appPageInfo())) return;
      ev.preventDefault();
      if (isAllowedExternal(url)) void shell.openExternal(url);
    });
  });
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
    webPreferences: securePrefs({
      // 歌词滚动与播放头一样，被遮挡时不能停
      backgroundThrottling: false,
    }),
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
    webPreferences: securePrefs(),
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
    webPreferences: securePrefs(),
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
    webPreferences: securePrefs(),
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
    webPreferences: securePrefs({
      backgroundThrottling: false,
    }),
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
  ipcMain.handle('vocab:open-file', (_e, dim) => {
    const file = vocabIpc.docPath(dataDir, dim);
    return file ? shell.openPath(file) : 'invalid vocab dim';
  });

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
  // 拖入音频：登记作品 + 录音版本。JSON 镜像仍走这里，和手工登记同一条出口
  ipcMain.handle('tracks:import-audio', async (_e, input) => {
    const r = await importDroppedAudio(ctx(), input ?? {});
    for (const t of r.tracks) syncTrackJson(t.id);
    return r;
  });
  const syncDrop = (r: { tracks?: { id: string }[] }) => {
    for (const t of r?.tracks ?? []) if (t?.id) syncTrackJson(t.id);
    return r;
  };
  ipcMain.handle('drop:preview', async (_e, paths) => previewDrop(ctx(), paths));
  ipcMain.handle('drop:commit-library', async (_e, input) => syncDrop(await commitLibraryDrop(ctx(), input ?? {})));
  ipcMain.handle('drop:commit-detail-audio', async (_e, input) => syncDrop(await commitDetailAudio(ctx(), input ?? {})));
  ipcMain.handle('drop:commit-detail-image', async (_e, input) => syncDrop(await commitDetailImages(ctx(), input ?? {})));
  ipcMain.handle('drop:commit-detail-lyric', async (_e, input) => syncDrop(await commitDetailLyrics(ctx(), input ?? {})));
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
  ipcMain.handle('art:clear-version', (_e, trackId, recId) => {
    const r = mediaIpc.clearVersionCover(ctx(), trackId, String(recId ?? ''));
    syncTrackJson(trackId);
    return r;
  });
  ipcMain.handle('lyrics:resolve', (_e, trackId, recId) => mediaIpc.resolveLyrics(ctx(), trackId, recId ?? null));
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
  ipcMain.handle('lyrics:clear-version', (_e, trackId, recId) => {
    const r = mediaIpc.clearVersionLyrics(ctx(), trackId, String(recId ?? ''));
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
      recId: st?.recId ? String(st.recId) : null,
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
      webPreferences: securePrefs({
        // 独立网格窗口同上：被遮挡时也不能把 rAF 掐掉
        backgroundThrottling: false,
      }),
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
    webPreferences: securePrefs({
      /**
       * 默认 true：窗口被遮挡/最小化时 Chromium 会把 rAF 降到 1fps 甚至停掉。
       * 播放器在后台本来就该继续出声、继续推进播放头，波形也别冻在那儿。
       * 顺带治一个坑：冒烟窗口被别的窗口压住时，整条渲染链会静默停摆，
       * 表现为「绘制次数 0 / 播放不推进」，看着像代码坏了。
       */
      backgroundThrottling: false,
    }),
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

  // 新窗口 / 外链 / 页面跳转的拦截统一在 installNavigationGuards() 里，对所有窗口生效
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


/**
 * 给冒烟测试的只读视图：全是 getter，每次读都是主进程此刻的值
 * （窗口会被关掉重开、mainAppReady 会翻转，不能传快照）。
 */
function smokeHost(): import('./smoke').SmokeHost {
  return {
    get win() {
      return win;
    },
    get gridWin() {
      return gridWin;
    },
    get lyricsWin() {
      return lyricsWin;
    },
    get handle() {
      return handle;
    },
    get vocab() {
      return vocab;
    },
    get dataDir() {
      return dataDir;
    },
    get assetsDir() {
      return assetsDir;
    },
    get configStore() {
      return configStore;
    },
    get historyStore() {
      return historyStore;
    },
    get wsStore() {
      return wsStore;
    },
    get mainAppReady() {
      return mainAppReady;
    },
    get playerState() {
      return playerState;
    },
    editingWcIds,
    SMOKE_QUIET,
    publishSmokeProgress,
    onConsoleMessage,
  };
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

  installNavigationGuards();
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
      // 冒烟代码在单独的 chunk 里，只有这里会加载它（见 src/main/smoke.ts）
      import('./smoke')
        .then(({ runSmoke }) => runSmoke(smokeHost()))
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
