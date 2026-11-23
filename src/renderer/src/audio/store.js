/**
 * store.js — 音频播放的单一实例（模块级单例）
 *
 * 为什么是单例而不是每个组件各持一个：
 *   播放头在网格里、播放控制在下方的 transport、独立窗口里也有一套。
 *   三处必须是同一个 currentTime，否则「暂停时拖动播放头」会互相打架。
 *
 * 分工：
 *   HTMLAudioElement 负责解码与播放（seek 靠它，稳）；
 *   AudioContext 只用来 decodeAudioData 抽波形，不参与发声。
 *   每帧播放头位置走 onFrame 回调直接改 DOM，不进 Vue 响应式 —— 60fps 触发渲染会拖慢网格。
 */
import { markRaw, reactive } from 'vue';
import { getCached, putCached } from './wavecache.js';
import { createPeaks } from './peaks.js';
import { createTimelineClock } from '@shared/timeline-clock.js';

const api = () => window.api;

/**
 * 播放头允许停在离文件末尾多远的地方（毫秒）。
 *
 * 停在**正好等于 duration** 的位置会踩到一个坑：Chromium 会去请求 `bytes=<文件长度>-`
 * （起点正好越界），协议层按规范回 416，媒体栈仍会派发一次 error ——
 * 播放条上就挂出橙色的「无法播放：曲名」，可下一拍按播放又能正常播。
 * 留 60ms 的空隙，请求就永远落在文件内部，这条错误从源头不会发生。
 */
const EOF_GUARD_MS = 60;

/**
 * 音频宿主 = **主窗口**。
 *
 * 独立网格窗口也要 import 这个 store（它要画波形、要播放头），但它绝不能自己再持有一个
 * `<audio>`：两个元素就是两个播放器 —— 能错开播放、还能同时出声（用户实测到了）。
 * 所以子窗口一律「发指令 + 收状态」，和歌词窗口同一套机制，只是它还需要波形数据。
 */
const isHost = !/^#?(grid|lyrics|overlay|image)/.test(location.hash || '');
/** 给播放条/节拍器用：子窗口不要自己发声、也不要改主窗口的播放状态 */
export const audioHost = isHost;

export const state = reactive({
  trackId: null,
  /**
   * 当前在播的录音版本 id（null = 作品的主录音，也就是顺序里的第一首）。
   * 双击某个演奏版本试听时会临时变成那条的 id —— **不改顺序、不写库**。
   */
  recId: null,
  /**
   * 'audio' = 本地音频在播；'timeline' = 没有可播音频，只有一条独立走的时间线；
   * 'none' = 还没加载。时间线模式**不会发声、也不与网易云同步**，只负责让播放头可对轨。
   */
  sourceMode: 'none',
  /** 时间线总长被手动改过：重拉同一首时不要再用档案推算值盖掉它 */
  timelineDurationManual: false,
  info: null,
  loading: false,
  ready: false,
  decoding: false,
  /**
   * 错误存的是「词典键 + 变量」而不是拼好的句子：
   * 错误可能停留在界面上很久，中途切了语言也要跟着变，
   * 而且这里不该知道当前是什么语言。真正拼文本的是显示它的组件。
   */
  error: null,
  /** 音频总长（毫秒）。优先用文件头探测值，解码后用解码结果校正 */
  durationMs: 0,
  /**
   * 编码器预热（毫秒）：这个文件解码后开头多出来的那一段。
   *
   * 定义见 `shared/audiofile.js` 的 `codecLeadSamples`。有 gapless 信息的文件是 0，
   * 没有的（老 mp3 / 没 edit list 的 aac）按标准值补 25 / 23 ms。
   * **本模块对外的时间一律是「扣掉它之后」的音乐时间**：播放、波形、偏移量都走这条。
   */
  leadMs: 0,
  /** 原生采样率（文件头），和解码后的 sampleRate 可能不同 */
  nativeSampleRate: 0,
  /** 播放位置，约 12fps 推送，用于文字读数 */
  currentMs: 0,
  playing: false,
  follow: true,
  /**
   * 主输出增益，**线性幅度**（0~1），不是 dB。
   * 推子位置直接当幅度用：位置 1 = 0 dB，位置 0.5 ≈ -6 dB，位置 0 = -∞。
   * 这样"拉满就是 0dB"是字面成立的最大值，而不是某个需要校准的参考点。
   */
  gain: 1,
  peaks: null,
  /**
   * 「回到开头」的次数。纯计数器，不存位置：
   * 播放头归零可能是 Home、也可能是拖到 0，但只有显式按 Home/■ 才需要
   * 把视窗也拉回开头（这是用户意图，不该由「位置恰好为 0」来猜）。
   * 网格 watch 这个数，不去 watch currentMs —— 后者每帧都在变。
   */
  rewindSeq: 0,
});

let el = null;
let ctx = null;
let raf = 0;
let lastPublish = 0;
/** 加载序号：异步解析 / 波形解码回来时用来判断「这次结果还算数吗」 */
let loadSeq = 0;
const frameFns = new Set();
const timelineClock = createTimelineClock();
/** 档案推算的时间线总长（opts.timelineMs），没有手动改过时用它 */
let timelineHintMs = 0;

/** 向歌词窗口 / 桌面歌词广播播放状态（主窗口是唯一音频宿主） */
function publishPlayerState() {
  // 从属窗口不广播：它一广播就会把主窗口的状态覆盖成自己的（错开的时间点）
  if (!isHost) return;
  try {
    const apiFn = window.api;
    if (apiFn?.player?.publish) {
      void apiFn.player.publish({
        trackId: state.trackId,
        sourceMode: state.sourceMode,
        title: state.info?.name ?? null,
        playing: state.playing,
        currentMs: Math.round(state.currentMs),
        durationMs: state.durationMs,
        ready: state.ready,
        gain: state.gain,
      });
    }
  } catch { /* 窗口还没就绪 */ }
}

function ensureEl() {
  if (!isHost) return null;   // 从属窗口没有 <audio>，播放靠指令发给主窗口
  if (el) return el;
  el = new Audio();
  el.preload = 'auto';
  // 新元素默认 volume=1；用户之前拉过推子就得按当前增益起步
  el.volume = state.gain;
  el.addEventListener('play', () => {
    if (state.sourceMode !== 'audio') return;
    state.playing = true;
    startLoop();
    publishPlayerState();
  });
  /**
   * 暂停 / 播完 / 出错：**必须主动广播一次**。
   *
   * 播放状态是靠 rAF 循环每 70ms 推的，循环一停就再没人推 ——
   * 于是暂停之后，歌词窗口那边一直停在「播放中」：它显示 ❚❚ 加绿框，
   * 而主窗口已经是 ▶。在**歌词窗口**里按暂停时最刺眼：
   * 按的是它自己的键，它自己反而不知道已经停了。
   */
  el.addEventListener('pause', () => {
    if (state.sourceMode !== 'audio') return;
    state.playing = false;
    stopLoop();
    state.currentMs = Math.max(0, elMsNow());
    publishPlayerState();
  });
  el.addEventListener('ended', () => {
    if (state.sourceMode !== 'audio') return;
    state.playing = false;
    stopLoop();
    state.currentMs = Math.max(0, elMsNow()) || state.durationMs;
    publishPlayerState();
  });
  el.addEventListener('loadedmetadata', () => {
    if (state.sourceMode !== 'audio') return;
    if (isFinite(el.duration) && el.duration > 0) {
      // 元素给的是「文件时长」，减掉编码器预热才是音乐时长（见 elMsNow 的说明）
      state.durationMs = Math.max(0, Math.round(el.duration * 1000 - state.leadMs));
      // 时长是「总时长」读数的来源，改了就推一次，别让歌词窗口显示旧的总长
      publishPlayerState();
    }
  });
  el.addEventListener('seeked', () => {
    if (state.sourceMode !== 'audio') return;
    state.currentMs = Math.max(0, elMsNow());
    emitFrame(state.currentMs);
  });
  el.addEventListener('error', () => {
    if (state.sourceMode !== 'audio') return;
    /**
     * 曲末那一帧会派发一次 error，但它不是「播不了」：位置已经在末尾附近，
     * 说明是「播完了 / 拖到结尾了」，此时 media 元素的 error 只是内部请求越界的余波。
     * 挂一条橙字会让用户以为文件坏了（他按播放又能正常播），所以这里只更新状态、不设错误。
     * 真正在曲子中间出错（文件损坏 / 协议取不到）位置离末尾很远，照旧报。
     */
    const dur = state.durationMs || 0;
    const atEof = dur > 0 && state.currentMs >= dur - EOF_GUARD_MS * 2;
    state.playing = false;
    stopLoop();
    if (atEof) {
      publishPlayerState();
      return;
    }
    state.error = state.info?.name
      ? { key: 'audio.failed', vars: { name: state.info.name } }
      : { key: 'audio.failedNoName' };
    publishPlayerState();
  });
  return el;
}

/**
 * 播放元素的时间 ↔ 本模块的时间。
 *
 * 两者差一个**编码器预热**（`state.leadMs`）：元素从文件的第一个字节开始计时，
 * 而文件开头那 1000 来个采样是编码器塞进来的空白/预热，不是音乐。
 * 于是：
 *   - 读：`currentMs = el.currentTime*1000 - leadMs`
 *   - 写：`el.currentTime = (currentMs + leadMs)/1000`
 * 波形（`peaks`）在 `createPeaks` 里也按同一个 leadMs 裁过，三边口径一致 ——
 * 这就是「同一个偏移量能把 wav / flac / mp3 / ogg 全对齐」的实现方式。
 */
function elMsNow() {
  return el ? el.currentTime * 1000 - state.leadMs : 0;
}

function seekEl(ms) {
  if (!el) return;
  el.currentTime = Math.max(0, Number(ms) + state.leadMs) / 1000;
}

function emitFrame(ms) {
  for (const fn of frameFns) {
    try {
      fn(ms);
    } catch {
      /* 单个订阅者出错不该影响播放 */
    }
  }
}

/** 从属窗口：把控制指令发给主窗口（音频宿主） */
function sendCmd(cmd) {
  try {
    void api()?.player?.command?.(cmd);
  } catch {
    /* 窗口还没就绪 */
  }
}

/** 只停本地，不动主窗口 —— 换曲 / 卸载时用（从属窗口换曲不该把主窗口暂停掉） */
function localPause() {
  if (el && !el.paused) el.pause();
  state.playing = false;
  stopLoop();
}

/** 远端播放时钟：收到状态时记下「那一毫秒 + 收到它的时刻」，之后本地插值 */
let remoteBaseMs = 0;
let remoteBaseAt = 0;
let remotePlaying = false;
/** 主窗口正在播哪一首 —— 和本窗口不是同一首时不镜像它的位置（否则播放头会跑到别的曲子上） */
let remoteTrackId = null;

function currentMsNow() {
  if (isHost) {
    if (state.sourceMode === 'timeline') return timelineClock.position();
    return el ? Math.max(0, elMsNow()) : 0;
  }
  return remoteBaseMs + (remotePlaying ? performance.now() - remoteBaseAt : 0);
}

function startLoop() {
  if (raf) return;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (isHost && state.sourceMode === 'audio' && !el) return;
    const ms = currentMsNow();
    if (isHost && state.sourceMode === 'timeline' && state.playing && ms >= state.durationMs) {
      state.playing = false;
      timelineClock.pause();
      timelineClock.seek(state.durationMs);
      state.currentMs = state.durationMs;
      emitFrame(state.currentMs);
      stopLoop();
      publishPlayerState();
      return;
    }
    emitFrame(ms);
    // 文字读数不必 60fps：省下来的渲染时间留给网格
    if (ms - lastPublish > 70 || ms < lastPublish) {
      lastPublish = ms;
      state.currentMs = ms;
      publishPlayerState();
    }
  };
  raf = requestAnimationFrame(tick);
}

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

/** 每帧回调（毫秒）。返回取消订阅函数 */
export function onFrame(fn) {
  frameFns.add(fn);
  return () => frameFns.delete(fn);
}

/**
 * 没有可播音频时进入「仅时间线」：一条自己的时钟，用来让播放头扫过标记。
 *
 * **它不是网易云进度同步**（2026-11-15 实测 GSMTC 只给曲名和播放态，Position/EndTime 恒为 0），
 * 所以这里只保证暂停 / 跳转 / 原点偏移与本地音频同一套语义，不冒充「和音频对齐了」。
 */
function enterTimelineMode() {
  const duration = state.timelineDurationManual && state.durationMs > 0 ? state.durationMs : timelineHintMs;
  state.sourceMode = 'timeline';
  state.leadMs = 0;
  state.nativeSampleRate = 0;
  state.peaks = null;
  state.decoding = false;
  state.error = null;
  state.currentMs = 0;
  state.playing = false;
  state.durationMs = Math.max(0, duration);
  timelineClock.setDuration(state.durationMs);
  timelineClock.seek(0);
  state.ready = state.durationMs > 0;
  publishPlayerState();
}

/**
 * 时间线模式下手动改总长（导出视频与音乐时长对不上时用）。
 * 只影响本次会话；不改档案、不改 JSON —— 它不是作品的属性。
 */
export function setTimelineDuration(ms) {
  if (state.sourceMode !== 'timeline') return 0;
  const v = Math.max(0, Math.round(Number(ms) || 0));
  state.timelineDurationManual = true;
  state.durationMs = v;
  state.ready = v > 0;
  timelineClock.setDuration(v);
  const at = timelineClock.position();
  state.currentMs = at;
  if (state.playing && at >= v) {
    state.playing = false;
    stopLoop();
  }
  emitFrame(at);
  if (!isHost) sendCmd({ type: 'duration', ms: v });
  publishPlayerState();
  return v;
}

/**
 * 档案侧的时间线总长变了（例如改了当前版本的原点偏移）：
 * 只更新「刚刚算出来的档案值」，不覆盖用户手动改过的总长。
 */
export function syncTimelineDuration(ms) {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  timelineHintMs = v;
  if (state.sourceMode !== 'timeline' || state.timelineDurationManual) return;
  state.durationMs = v;
  timelineClock.setDuration(v);
  state.currentMs = timelineClock.position();
  state.ready = v > 0;
  emitFrame(state.currentMs);
  publishPlayerState();
}

/**
 * 换曲目（或换同一曲目的某个录音版本）：先静音旧音频，再解析、解码波形。
 *
 * `recId` 为空 = 播作品的主录音（顺序里的第一首，走 track.file_path）；
 * 给了 recId = 播那一条录音，走 `ma-audio://rec/...`，不碰数据库。
 *
 * `opts.timelineMs`：解析不到音频时，时间线按这个总长走（App 用 analysis 的
 * 终点 + 当前版本 offset 算好）；解析到音频则完全不看它。
 *
 * `opts.force`：录音版本 / 音质文件刚被改过时要强制重解析。同 id 早退的前提是
 * 「解析结果还没过期」—— 换文件之后这个前提不成立，继续拿旧 info 会让 `<audio>`
 * 带着旧文件的字节范围去请求新文件，表现就是偶发「播放失败」、拖一下播放头又好了。
 */
export async function loadTrack(trackId, recId = null, opts = {}) {
  if (!trackId) return;
  const force = opts?.force === true;
  // 同一个 trackId 但换了版本也必须重载，否则双击第 3 版后再点作品播放会继续播第 3 版
  if (!force && state.trackId === trackId && state.recId === recId && state.info) return;

  const changed = state.trackId !== trackId || state.recId !== recId;
  if (changed) {
    state.timelineDurationManual = false;
  }
  // 时间线总长由 App 按「当前版本 offset + 档案终点」算好传进来；手动改过就保留
  if (opts.timelineMs !== undefined) timelineHintMs = Math.max(0, Number(opts.timelineMs) || 0);

  state.sourceMode = 'none';
  localPause();
  timelineClock.pause();
  timelineClock.setDuration(0);
  // 旧元素的 src 必须摘掉：时间线模式下不发声，按空格也不能让上一个文件突然响
  if (el) {
    el.removeAttribute('src');
    el.load();
  }
  state.trackId = trackId;
  state.recId = recId;
  state.info = null;
  state.peaks = null;
  state.ready = false;
  state.error = null;
  state.currentMs = 0;
  state.durationMs = 0;
  /**
   * 必须在这里清掉「解码中」：上一条的波形解码可能还在飞，
   * 它的 finally 看到 loadSeq 变了就不会再复位这个标志 ——
   * 而这次如果一开始就失败（文件缺失 / 协议 404），走的是提前 return，
   * 屏幕上就永远停在「波形解码中…」。
   */
  state.decoding = false;
  state.loading = true;

  // 每次加载发一个序号：波形解码是异步的，回来时只认最后一次
  const seq = ++loadSeq;

  let info = null;
  try {
    info = recId ? await api().audio.resolveRecording(trackId, recId) : await api().audio.resolve(trackId);
  } catch (e) {
    state.error = { key: 'audio.loadFailed', vars: { msg: String(e?.message ?? e) } };
    state.loading = false;
    return;
  }
  if (seq !== loadSeq) return; // 期间又换了，这次结果作废
  state.info = info;
  if (!info?.exists) {
    enterTimelineMode();
    state.loading = false;
    return;
  }
  /**
   * 编码器预热换算成毫秒：`leadSamples` 是**按文件采样率**数的采样数，
   * 所以要用 `info.sampleRate` 换算（48k 的 mp3 1105 采样 ≈ 23ms，44.1k 的 ≈ 25ms）。
   * 没有采样率就没法换算 —— 宁可当 0，也别拿错的比例把整轨推偏。
   */
  const leadSamples = Number(info.leadSamples) || 0;
  state.leadMs = leadSamples > 0 && info.sampleRate > 0 ? (leadSamples / info.sampleRate) * 1000 : 0;
  state.durationMs = Math.max(0, (info.durationMs || 0) - state.leadMs);
  state.nativeSampleRate = info.sampleRate || 0;

  // 从属窗口没有 <audio>：时长来自文件头、波形来自缓存，够画了
  state.sourceMode = 'audio';
  const a = ensureEl();
  if (a) {
    a.src = info.url;
    a.load();
  }
  state.ready = true;
  state.loading = false;
  publishPlayerState();

  /**
   * 波形：先问缓存（内存 → 磁盘）。
   *
   * 解码一首 18MB 的 FLAC 要 1–2 秒，而峰值只有几 MB —— 切回刚听过的那首时，
   * 命中缓存就是**立刻**出波形，不再闪一次「波形解码中…」。
   * 读盘也是异步的，回来时仍要判 seq：这期间用户可能已经切走了。
   */
  const cached = await getCached(info);
  if (seq !== loadSeq) return;
  if (cached) {
    state.peaks = markRaw(cached);
    // 峰值里存的是「已经裁掉预热」的长度，用它校正时长，别让缓存命中和解码出来的差几毫秒
    if (cached.duration > 0) state.durationMs = Math.round(cached.duration * 1000);
    state.decoding = false;
    return;
  }

  // 没命中才解码（比较重，单独走，不挡播放）
  void decodePeaks(info, seq);
}

/**
 * 卸载当前音频：没有「下一首」可载的时候用。
 *
 * `loadTrack(null)` 会在这行之前就 `if (!trackId) return`，什么都清不掉 ——
 * 删除作品之后就是这种情形：删掉的那首还在 `state.trackId` / `peaks` / `durationMs` 里，
 * 网格按旧音频时长铺文档长度、按新档案画小节，看起来就是「时间线渲染错乱」。
 */
export function unload() {
  state.sourceMode = 'none';
  localPause();
  timelineClock.pause();
  timelineClock.setDuration(0);
  // 让还在飞的解码结果作废：它回来时 loadSeq 已经变了
  loadSeq++;
  state.trackId = null;
  state.recId = null;
  state.timelineDurationManual = false;
  state.info = null;
  state.peaks = null;
  state.ready = false;
  state.loading = false;
  state.decoding = false;
  state.error = null;
  state.currentMs = 0;
  state.durationMs = 0;
  state.leadMs = 0;
  state.nativeSampleRate = 0;
  if (el) {
    // 光清 state 不够：元素上还挂着旧 src，按空格会重新播已删的那首
    el.removeAttribute('src');
    el.load();
  }
  // 不经过 rAF 循环的动作必须自己推一次，否则歌词窗口还停在上一首
  publishPlayerState();
}

async function decodePeaks(info, seq) {
  state.decoding = true;
  try {
    const res = await fetch(info.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    ctx ||= new AudioContext();
    // decodeAudioData 会重采样到 AudioContext 的采样率，波形按解码后的采样率算即可
    const decoded = await ctx.decodeAudioData(buf);
    // 同一作品换版本时 trackId 没变，只能用加载序号判断是不是过期结果
    if (seq !== loadSeq) return;
    /**
     * 解码后的采样率可能和文件不同（AudioContext 会重采样），
     * 所以预热采样数要按比例换算，否则 48k 文件在 44.1k 上下文里会少裁 90 来个采样。
     */
    const fileRate = Number(info.sampleRate) || decoded.sampleRate;
    const leadFile = Number(info.leadSamples) || 0;
    const skip = leadFile > 0 ? Math.round((leadFile * decoded.sampleRate) / fileRate) : 0;
    // markRaw：峰值金字塔里有上百万个采样，绝不能被 Vue 深代理
    state.peaks = markRaw(createPeaks(decoded, skip));
    if (decoded.duration > 0) {
      state.durationMs = Math.max(0, Math.round(decoded.duration * 1000 - state.leadMs));
    }
    // 写回缓存两层（失败只意味着「下次再解码」）
    putCached(info, state.peaks);
  } catch (e) {
    if (seq === loadSeq) state.error = { key: 'audio.decodeFailed', vars: { msg: String(e?.message ?? e) } };
  } finally {
    if (seq === loadSeq) state.decoding = false;
  }
}

export function play() {
  if (!isHost) {
    // 主窗口若正在放另一首，就别指挥它 —— 那会变成「在 B 的时间线里按播放，A 开始响」
    if (remoteTrackId && state.trackId && remoteTrackId !== state.trackId) {
      state.error = { key: 'audio.hostOtherTrack' };
      return;
    }
    state.error = null;
    sendCmd({ type: 'play' });
    state.playing = true;   // 乐观：主窗口下一次广播会把它校准
    startLoop();
    return;
  }
  if (state.sourceMode === 'timeline') {
    if (!state.durationMs) {
      state.error ??= { key: 'audio.noTimeline' };
      return;
    }
    state.error = null;
    state.currentMs = timelineClock.position();
    if (state.currentMs >= state.durationMs) state.currentMs = 0;
    timelineClock.play();
    state.playing = true;
    startLoop();
    publishPlayerState();
    return;
  }
  // 静默 return 会让「点了没反应」，而原因（文件不存在 / 协议取不到）只在控制台里
  if (!state.ready || !el || !el.src) {
    state.error ??= { key: 'audio.failedNoName' };
    return;
  }
  /**
   * 元素已经进入 error 状态（越界 Range / 解码中断 / 源被换掉）时，**play() 永远不会成功**，
   * 只有 load() 能把它救回来。用户报的「播到结尾拖回来再按播放，橙字一直挂着、怎么点都不响」
   * 就是这种：画面停在结尾，元素却已经死了。
   *
   * 记住当前位置再 load，`loadedmetadata` 回来后跳回去再播 —— 不能让它从头开始播放。
   */
  if (el.error) {
    const at = Math.max(0, Number(state.currentMs) || 0);
    state.error = null;
    const resume = () => {
      try {
        const dur = isFinite(el.duration) ? el.duration : 0;
        const target = (at + state.leadMs) / 1000;
        el.currentTime = dur > 0 ? Math.min(target, dur - 0.02) : target;
      } catch {
        /* 时长还没就绪就先不跳，从头播也比彻底不响强 */
      }
      void el.play().catch((e) => {
        state.error = { key: 'audio.playFailed', vars: { msg: String(e?.message ?? e) } };
      });
    };
    el.addEventListener('loadedmetadata', resume, { once: true });
    el.load();
    return;
  }
  void el.play().catch((e) => {
    state.error = { key: 'audio.playFailed', vars: { msg: String(e?.message ?? e) } };
  });
}

export function pause() {
  if (!isHost) {
    sendCmd({ type: 'pause' });
    localPause();
    return;
  }
  if (state.sourceMode === 'timeline') {
    timelineClock.pause();
    state.currentMs = timelineClock.position();
    state.playing = false;
    stopLoop();
    publishPlayerState();
    return;
  }
  // 正在播时 el.pause() 会触发 pause 事件（那边已经广播过一次）；已暂停时不会
  if (el && !el.paused) el.pause();
  state.playing = false;
  stopLoop();
  publishPlayerState();
}

export function toggle() {
  if (state.playing) pause();
  else play();
}

export function stop() {
  pause();
  if (!isHost) sendCmd({ type: 'rewind' });
  if (isHost && state.sourceMode === 'timeline') {
    timelineClock.seek(0);
    state.currentMs = 0;
    emitFrame(0);
  } else if (el) {
    // 归零 = 回到「音乐的第 0 毫秒」，不是文件的第 0 个字节
    seekEl(0);
  }
  if (!isHost || el || state.sourceMode === 'timeline') {
    remoteBaseMs = 0;
    remoteBaseAt = performance.now();
    state.currentMs = 0;
    emitFrame(0);
  }
  // 位置归零和「视图也该回去」是两件事：这里只发信号，由网格决定怎么滚
  state.rewindSeq++;
  /**
   * 暂停状态下按「回到开头」时，rAF 循环是停的，没人推这个新位置 ——
   * 歌词窗口那边时间会一直停在按之前的地方。
   */
  publishPlayerState();
}

/** 跳到音频的某个毫秒位置（越界自动夹住） */
export function seek(ms) {
  if (!isHost) {
    if (!state.ready) return;
    // 主窗口是唯一音频宿主：位置得让它去动，本地只跟着挪（否则一松手就回弹）
    const dur = state.durationMs || 0;
    const v = Math.max(0, Math.min(dur || 0, Number(ms) || 0));
    sendCmd({ type: 'seek', ms: v });
    remoteBaseMs = v;
    remoteBaseAt = performance.now();
    state.currentMs = v;
    emitFrame(v);
    return;
  }
  if (state.sourceMode === 'timeline') {
    if (!state.ready) return;
    timelineClock.seek(Number(ms) || 0);
    state.currentMs = timelineClock.position();
    emitFrame(state.currentMs);
    publishPlayerState();
    return;
  }
  if (!el || !state.ready) return;
  const dur = state.durationMs || (isFinite(el.duration) ? el.duration * 1000 : 0);
  // 不让自己停在 EOF 上（见 EOF_GUARD_MS）；这样「拖到最右」永远落在一个文件内部的位置
  const limit = dur > EOF_GUARD_MS ? dur - EOF_GUARD_MS : dur;
  const v = Math.max(0, Math.min(limit || 0, Number(ms) || 0));
  seekEl(v);   // 元素时间是「文件时间」，要补回 leadMs（见 elMsNow）
  // 位置已经离开越界区，上一次因为拖到末尾留下的错误提示也该收起来
  if (state.error?.key === 'audio.failed') state.error = null;
  state.currentMs = v;
  emitFrame(v);
  /**
   * 暂停时也要广播：位置不是只有 rAF 循环在推 —— 循环停着的时候
   * 在主窗口拖一下进度条，歌词窗口那条进度条会一直停在老位置。
   */
  publishPlayerState();
}

/**
 * 「扫过发声」：跳到某个位置，播一小段就停（Premiere 里拖播放头的那种声音）。
 *
 * 用户 2026-11-23 要的功能，价值在**音画对齐**：光看波形对不上「这一下是不是
 * 正好落在鼓点上」，听一小口就立刻知道。
 *
 * 三条硬限制，别想着绕过：
 *   1. 只有**音频宿主**（主窗口）能发声 —— 独立时间线窗口里扫，声音得由主窗口播，
 *      跨进程几十毫秒的延迟会让声音「慢半拍」，不如不做；
 *   2. `sourceMode === 'timeline'`（仅时间线，用于对齐外部播放/录屏）**没有音频源**，
 *      这时静默跳过，不报错；
 *   3. 正在播放时不打断 —— 那是用户在听整首，不是在对轨。
 *
 * 连续触发（拖播放头）时每次都重新 seek + play，并用 token 保证只有最后一次
 * 到点会 pause：否则先后两个定时器会把后一次的声音掐掉。
 */
let scrubTimer = 0;
/**
 * 扫过发声用**独立**的 Audio 元素。
 *
 * 曾经借用主 `<audio>`（seek + play + 42ms 后 pause），代价是：
 * `play()` 会触发主元素的 play 监听把 `state.playing` 置 true、启动 rAF，
 * 而 42ms 的 pause 又把它按回去 —— 表现就是「点了一下位置，界面自己播了一下」；
 * 更糟的是用户紧接着按播放时，那一下正好落在借用窗口里被当成 scrub 吞掉。
 * 用第二个元素播同一份 src 就完全没有这些纠缠：主元素的位置、播放状态都不动。
 */
let scrubEl = null;

/**
 * 只在**当前位置**放一小段就停（不 seek）。
 *
 * 调用点通常已经 `seek()` 过了（拖动播放头、快捷键），再 seek 一次是多余的，
 * 而且会把「连续拖动」变成「每次回到同一个点重放」。
 */
export function scrubPulse(durMs) {
  if (!isHost || !state.ready) return;
  if (state.sourceMode !== 'audio') return;   // 仅时间线模式没有音频源
  if (state.playing) return;                  // 别和正常播放叠在一起
  const src = el?.currentSrc || el?.src;
  if (!src) return;
  const dur = Math.max(30, Math.min(2000, Number(durMs) || 42));

  if (!scrubEl) {
    scrubEl = new Audio();
    scrubEl.preload = 'auto';
  }
  const s2 = scrubEl;
  if (s2.src !== src) s2.src = src;
  s2.volume = state.gain;
  try {
    s2.currentTime = Math.max(0, (Number(state.currentMs) || 0) / 1000);
  } catch {
    /* 元数据还没到就先从当前位置播，下一次再跳准 */
  }
  if (scrubTimer) window.clearTimeout(scrubTimer);
  void s2.play().catch(() => {
    /* 自动播放策略 / 解码未就绪：静默失败，别在界面上弹错误 */
  });
  scrubTimer = window.setTimeout(() => {
    scrubTimer = 0;
    try {
      s2.pause();
    } catch {
      /* 元素可能已经被换掉 */
    }
  }, dur);
}

/** 跳到某处并放一小段（没有单独 seek 需求的调用点用这个） */
export function scrubAt(ms, durMs) {
  seek(ms);
  scrubPulse(durMs);
}

export function setFollow(v) {
  state.follow = !!v;
  try {
    localStorage.setItem('ma-follow', state.follow ? '1' : '0');
  } catch {
    /* 隐私模式下写不了就算了 */
  }
}

export function restoreFollow() {
  state.follow = localStorage.getItem('ma-follow') !== '0';
}

/**
 * 线性幅度 → dB。DAW 的推子读数就是这么来的：
 * 幅度 1 = 0 dB（满刻度），0.5 ≈ -6.02 dB，0.1 = -20 dB，0 = -∞。
 */
export function gainToDb(gain) {
  const g = Number(gain);
  if (!Number.isFinite(g) || g <= 0) return -Infinity;
  return 20 * Math.log10(g);
}

/** 设置主输出增益（0~1 的线性幅度）。持久化，换曲不丢 */
export function setGain(p) {
  const n = Number(p);
  if (!isHost) {
    const v0 = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : state.gain;
    state.gain = v0;
    try {
      localStorage.setItem('ma-gain', String(v0));
    } catch {
      /* 隐私模式写不了就算了 */
    }
    sendCmd({ type: 'gain', gain: v0 });
    return v0;
  }
  const v = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : state.gain;
  state.gain = v;
  if (el) el.volume = v;
  try {
    localStorage.setItem('ma-gain', String(v));
  } catch {
    /* 隐私模式下写不了就算了 */
  }
  /**
   * 音量只有这个窗口能真的生效（唯一的 `<audio>` 在这儿），
   * 所以改完必须把值推出去 —— 否则在主窗口拉推子，
   * 歌词窗口那个滑块和百分比会一直停在旧读数。
   */
  publishPlayerState();
  return v;
}

export function restoreGain() {
  const stored = localStorage.getItem('ma-gain');
  // 别直接 Number(null)：它等于 0，全新配置会被静音
  if (stored === null) return;
  const raw = Number(stored);
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) state.gain = raw;
}

/** 重新解析当前曲目的音频（换文件后） */
export async function reload() {
  const id = state.trackId;
  state.trackId = null;
  state.info = null;
  if (id) await loadTrack(id);
}

restoreFollow();
restoreGain();

/**
 * 订阅来自其它窗口（歌词播报器 / 桌面歌词）的控制指令。
 *
 * 为什么放在 store 而不是 App.vue：音频是唯一宿主，但宿主是模块级单例，
 * 谁先加载谁负责监听。放这里能保证「主窗口的 audio 元素一定听得到指令」，
 * 不依赖组件的挂载顺序。
 *
 * 幂等：store 可能被多次 import，重复订阅会让一次点击变成两次 toggle（又停又播）。
 */
/**
 * 从属窗口：订阅主窗口广播的播放状态。
 *
 * 广播约 14Hz，直接拿来画播放头会一跳一跳 —— 所以只把它当「校准点」，
 * 位置在本地用 rAF 插值（`currentMsNow`），60fps 且不会自己往前跑。
 */
function applyRemoteState(s) {
  if (!s || typeof s !== 'object') return;
  remoteTrackId = s.trackId ?? null;
  // 主窗口可能在放另一首：那时不镜像它的位置，否则播放头会跑到别的曲子上
  const sameTrack = !state.trackId || !s.trackId || s.trackId === state.trackId;
  remotePlaying = !!s.playing && sameTrack;
  remoteBaseMs = sameTrack ? Number(s.currentMs) || 0 : 0;
  remoteBaseAt = performance.now();
  if (typeof s.gain === 'number') state.gain = s.gain;
  state.playing = remotePlaying;
  if (sameTrack) {
    if (s.sourceMode === 'audio' || s.sourceMode === 'timeline' || s.sourceMode === 'none') {
      state.sourceMode = s.sourceMode;
    }
    // 只有时间线要以主窗口为准（总长可能是手动改过的）；音频时长用本窗口解析到的文件值，
    // 否则主窗口在放另一版录音时，独立窗口会拿错版本的总长去画自己的波形。
    if (s.sourceMode === 'timeline' && Number(s.durationMs) > 0) state.durationMs = Number(s.durationMs);
    state.ready = !!s.ready;
    state.currentMs = remoteBaseMs;
    emitFrame(remoteBaseMs);
    // 换回同一首之后，之前那条「主窗口在放别的曲子」的提示要收掉
    if (state.error?.key === 'audio.hostOtherTrack') state.error = null;
  }
  if (remotePlaying) startLoop();
  else stopLoop();
}

/**
 * 排查/冒烟用：宿主判定与「本窗口有没有 <audio>」。
 * 独立窗口必须是 `isHost: false` + `hasEl: false` —— 那就是「只有一个播放器」的判据。
 */
if (typeof window !== 'undefined') {
  window.__maAudio = {
    isHost,
    hasEl: () => !!el,
    remoteTrackId: () => remoteTrackId,
    remotePlaying: () => remotePlaying,
    trackId: () => state.trackId,
    /** 排查卡顿/爆音用：直接读播放元素的时钟与缓冲，不要只看 state.currentMs（70ms 才更新一次） */
    currentMs: () => currentMsNow(),
    sourceMode: () => state.sourceMode,
    paused: () => (state.sourceMode === 'timeline' ? !state.playing : el ? el.paused : true),
    readyState: () => (el ? el.readyState : -1),
    networkState: () => (el ? el.networkState : -1),
    bufferedMs: () => {
      if (!el || !el.buffered || !el.buffered.length) return 0;
      return el.buffered.end(el.buffered.length - 1) * 1000;
    },
    mediaError: () =>
      el?.error ? { code: el.error.code, message: el.error.message } : null,
  };
}


if (!isHost && api()?.player?.onState) {
  api().player.onState((s) => applyRemoteState(s));
  // 打开窗口时先把当前状态取一次，别等下一次广播（可能是暂停状态，一直不来）
  void api()
    .player.state?.()
    .then((s) => applyRemoteState(s))
    .catch(() => {});
}

if (isHost && !window.__maCmdWired && window.api?.player?.onCommand) {
  window.__maCmdWired = true;
  window.api.player.onCommand((cmd) => {
    try {
      if (!cmd || typeof cmd !== 'object') return;
      if (cmd.type === 'toggle') toggle();
      else if (cmd.type === 'play') play();
      else if (cmd.type === 'pause') pause();
      else if (cmd.type === 'rewind') stop();
      else if (cmd.type === 'seek') seek(Number(cmd.ms));
      else if (cmd.type === 'duration') setTimelineDuration(Number(cmd.ms));
      // 音量：主窗口是唯一持有 <audio> 的地方，所以子窗口的滑块必须走指令过来。
      // 走 setGain 而不是直接改 localStorage —— 那是这里启动时读的，
      // 而且 setGain 顺手会把值落到 el.volume 上。
      else if (cmd.type === 'gain') setGain(Number(cmd.gain));
    } catch (e) {
      console.error('[audio] 播放指令处理失败', cmd, e);
    }
  });
}

/**
 * 排查 / 冒烟用：编码器预热，以及「文件时间」与「音乐时间」的对应关系。
 *
 * 不变量：`elMs - currentMs === leadMs`（播放元素比本模块晚一个预热）。
 * 冒烟就靠它盯着 —— 这条一旦错，波形、播放头、偏移量会同时偏，而且只看界面看不出来。
 */
export function debugClock() {
  return {
    leadMs: Math.round(state.leadMs * 1000) / 1000,
    // 文件时间（元素口径）；从属窗口没有元素，给 null
    elMs: el ? Math.round(el.currentTime * 1000) : null,
    // 音乐时间（本模块对外口径）
    sourceMode: state.sourceMode,
    currentMs: Math.round(state.currentMs),
    durationMs: state.durationMs,
    peaksMs: state.peaks ? Math.round(state.peaks.duration * 1000) : null,
  };
}
