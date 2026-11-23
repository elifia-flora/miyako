/**
 * 阶段 0 冻结的 IPC 契约。
 * 渲染层只认这里的类型；数据库字段怎么变，都被挡在 main 里。
 */

export type Confidence = 'confirmed' | 'uncertain' | 'guess';
export type MarkerKind = 'meter' | 'tempo' | 'section' | 'key' | 'rehearsal';

export interface TrackRow {
  id: string;
  /** 母作品 id：乐章子项指向所属作品；独立作品 / 母作品自身为 null */
  parentId: string | null;
  title: string;
  titleLang: string | null;
  /**
   * 别名（用户手填的「这首还能叫什么」）。列表里用它挑一条**用户语言的译名**：
   * 外文曲名旁边显示灰色括号（成人法则）。挑法与判据见 `shared/lang.js` 的
   * `pickTitleTranslation` —— 不在 main 里挑，因为「用户语言」只有渲染层知道。
   */
  aliases: string[];
  composer: string | null;
  performer: string | null;
  /** 所属专辑。数据库里一直有这一列，之前没接到界面上 */
  album: string | null;
  /** 在这张专辑里是第几首（1 起）。专辑名是自由文本，序号是它内部的顺序 */
  albumTrackNo: number | null;
  genre: string | null;
  period: string | null;
  /** 体裁：词表 id（symphony）。列表里的标题模板要用，所以轻量行也带上 */
  compositionType: string | null;
  /** 作品编号（No.1）。古典标题模板 `%Number of the form}` */
  formNumber: string | null;
  /** 作品号（Op.2, No.1；流行作品可写 N/A）。模板 `%Opus Number}` */
  opusNumber: string | null;
  /** 乐章的子体裁（Menuetto / 舞曲）。模板 `%Sub-Type}` */
  subType: string | null;
  /** 乐章的速度术语（Allegretto / 小快板）。模板 `%Tempo Term}` */
  tempoTerm: string | null;
  durationMs: number | null;
  filePath: string | null;
  meter: string | null;
  bpm: number | null;
  sectionCount: number;
  tagCount: number;
  keys: string[];
  /**
   * 有没有可播的本地音频（档案 file_path 指向的文件存在，或 data/audio 里有同名文件）。
   * 列表里要显示「双击会发生什么」，所以这个判断放在 main 做（渲染层碰不到文件系统）。
   */
  hasAudio: boolean;
  /** 档案里的网易云链接；没有本地音频时双击曲名走它 */
  neteaseUrl: string | null;
  /**
   * 录音版本摘要，给列表的树状子行用。
   * 名字不叫 recordings：TrackDetail 上已经有一个同名的完整 Recording[]，
   * 两个不同类型撞在一条继承链上，TypeScript 会直接报不可赋值。
   * 只有**两条以上**时才在列表里展开子行 —— 单版本的曲目铺一层子行纯属噪音。
   */
  recordingVersions: RecordingSummary[];
  /** 乐章子项（parent_id 指向本作品）；独立作品为空数组。列表里做嵌套子行 */
  movements: MovementRow[];
  updatedAt: number;
}

/** 乐章子行：列表嵌套显示用的轻量曲目行（不带录音/标签统计，选中后走 getTrack 取全量） */
export interface MovementRow {
  id: string;
  parentId: string | null;
  title: string;
  titleLang: string | null;
  aliases: string[];
  meter: string | null;
  bpm: number | null;
  keys: string[];
  hasAudio: boolean;
  neteaseUrl: string | null;
  period: string | null;
  genre: string | null;
  compositionType: string | null;
  subType: string | null;
  tempoTerm: string | null;
}

export interface TagRef {
  id: string;
  dim: string;
  name: string;
  display: string | null;
  weight: number;
}

export interface Marker {
  id: string;
  kind: MarkerKind;
  tick: number;
  label: string | null;
  num: number | null;
  den: number | null;
  bpm: number | null;
  keyName: string | null;
  startBar: number | null;
  confidence: Confidence;
  note: string | null;
}

export interface AnalysisEvent {
  id: string;
  lane: string;
  tick: number;
  durTicks: number;
  text: string;
  confidence: Confidence;
  /** 和弦符号的解析结果（shared/chord.js 输出）；非和弦泳道为 null，解析失败也照存 ok:false */
  parsed?: any | null;
}

/** 一首曲目绑定的音频（协议地址 + 文件头里读到的真实参数） */
export interface AudioInfo {
  trackId: string;
  path: string;
  name: string;
  exists: boolean;
  /** ma-audio://audio/<trackId>，渲染层直接交给 <audio src> */
  url: string;
  size: number;
  /**
   * 文件修改时间（毫秒）。波形缓存的键要带上它：
   * 只按路径做键的话，同名文件被覆盖 / 重新转码之后会一直显示旧波形。
   */
  mtimeMs: number;
  format: string | null;
  sampleRate: number;
  channels: number;
  bits: number;
  durationMs: number;
  source: 'db' | 'folder' | 'none';
}

/** 波形缓存的键：路径 + 字节数 + 修改时间（文件一改就换键） */
export interface WaveMeta {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WaveStats {
  files: number;
  bytes: number;
  dir: string;
}

/** 网格区间操作：一次可以覆盖多条泳道 */
export interface RangePayload {
  analysisId: string;
  lanes: string[];
  startTick: number;
  endTick: number;
}

export interface RangeResult {
  inserted: number;
  removed: number;
  trimmed: number;
}

export interface AnalysisDoc {
  id: string;
  trackId: string;
  title: string | null;
  ppq: number;
  tempoValue: number | null;
  tempoUnit: string | null;
  meterNum: number | null;
  meterDen: number | null;
  /**
   * 拍号的「单/复/混合」**不在数据里** —— 它是规则算出来的（`shared/meter.js`），
   * 而且结论随术语体系（中/苏/德奥 vs 英美）变化。schema v4 起
   * `analysis.meter_type` 与 JSON 的 `basic.meterType` 都已删除。
   */
  meterNote: string | null;
  audioOffsetMs: number;
  viewId: string | null;
  markers: Marker[];
  events: AnalysisEvent[];
}

/** 封面：独立音乐封面优先于专辑封面（单曲常常另有封面） */
export interface CoverSet {
  /** 相对 data 目录的路径；null = 没设 */
  single: string | null;
  album: string | null;
  singleUrl: string | null;
  albumUrl: string | null;
  /** 实际显示的那一张 */
  url: string | null;
  source: 'single' | 'album' | null;
}

/**
 * 录音制品：同一部作品的一次录音。
 *
 * 作品层（track）回答「这是什么」—— 标题、作曲家、时期、调式、乐器编制。
 * 这一层回答「这是哪一次录音」—— 谁演的、哪个乐团、谁指挥、哪年录的、
 * 谁做的混音与母带。同一部作品的不同录音，前者完全相同、后者逐条不同。
 */
/** 列表树状子行用的录音摘要（不需要详情面板那一整套字段） */
export interface RecordingSummary {
  id: string;
  label: string;
  catalogNo: string;
  conductor: string;
  performers: string[];
  filePath: string;
  /** 外部网络链接（网易云 / QQ 音乐 / B 站…） */
  link: string;
  isDefault: boolean;
  durationMs: number;
  format: string | null;
  /** 文件是否真的还在磁盘上（列表里要能标「文件不在了」） */
  fileExists: boolean;
  /** 同一演奏版本下另存的音质 / 转码文件数（不占独立版本行） */
  variantCount: number;
}

export interface Recording {
  id: string;
  trackId: string;
  /** null = 演奏版本；非空 = 它只是某个演奏版本下的音质 / 转码文件 */
  parentId: string | null;
  /** 只在演奏版本上出现：它名下的音质文件（按播放优先级排序） */
  variants: Recording[];
  /** 演奏者（独奏 / 主角，JSON 数组） */
  performers: string[];
  orchestra: string;
  conductor: string;
  soloist: string;
  /** 其它人名（制作人、录音师…） */
  credits: Record<string, string>;
  recordingPlace: string;
  /** 录制年份 */
  recordedYear: number | null;
  mixEngineer: string;
  masteringEngineer: string;
  label: string;
  catalogNo: string;
  /** 发行年份（发行 ≠ 录制，所以分开两个字段） */
  releaseYear: number | null;
  filePath: string;
  durationMs: number;
  format: string | null;
  sampleRate: number;
  channels: number;
  bits: number;
  /** 是否是当前播放的版本（一个作品最多一条） */
  isDefault: boolean;
  note: string;
  /**
   * 这个版本自己的时间线原点偏移（毫秒）= 第 1 小节落在音频里的位置。
   * 逐版本存：同一部作品的磁带转录版与 CD 抓轨版开头留白可以差好几秒。
   */
  audioOffsetMs: number;
  fileExists: boolean;
  /**
   * 外部网络链接。有些版本只在网易云 / QQ 音乐 / B 站上有，本地没有文件 ——
   * 链接归到具体版本，才说得清「哪个版本对应哪个链接」（作品层的 extra.links
   * 只说明「这部作品在网上有」，分不到版本）。
   */
  link: string;
  /** 靠外链播放：没有本地文件但有链接。播放时走浏览器而不是 <audio> */
  isExternal: boolean;
  /** 直接喂 <audio> 的地址 */
  url: string;
  /** 按录音取的协议地址 ma-audio://rec/<trackId>/<recId> */
  recUrl: string;
}

export interface RecordingPatch {
  id?: string;
  trackId: string;
  /** 把新录音登记为某个演奏版本的音质文件（内部/未来用） */
  parentId?: string;
  performers?: string[];
  orchestra?: string;
  conductor?: string;
  soloist?: string;
  credits?: Record<string, string>;
  recordingPlace?: string;
  recordedYear?: number | null;
  mixEngineer?: string;
  masteringEngineer?: string;
  label?: string;
  catalogNo?: string;
  releaseYear?: number | null;
  filePath?: string;
  durationMs?: number | null;
  format?: string | null;
  sampleRate?: number | null;
  channels?: number | null;
  bits?: number | null;
  isDefault?: boolean;
  note?: string;
  /** 外部网络链接；传空串表示清掉 */
  link?: string;
}

export interface TrackDetail extends TrackRow {
  description: string | null;
  /** 曲式（奏鸣曲式 / 回旋曲式…），整曲一条抽象结论，不做逐段标注 */
  form: string | null;
  /** 档案里的副标题（如「TV动画 … 片尾曲」） */
  subtitle: string | null;
  /** 别名，搜索以外主要给详情页看 */
  aliases: string[];
  /**
   * 乐器组合摘要：一句话说明这一首的编制（「Orchestra + Soprano Solo」）。
   * 乐器标签答不了「整体听起来是什么编制」，所以单独留一个字段。
   */
  instrumentationAbstract: string | null;
  /** 制作名单（作曲 / 作词 / 演奏 / 发行日期） */
  credits: Record<string, string | null> | null;
  /** 外链：目前用 netease，没有音频文件时双击曲名走它 */
  links: { netease?: string | null; qq?: string | null } | null;
  moods: string[];
  /** 封面（独立 / 专辑）与各自协议地址 */
  covers: CoverSet;
  /** 同一部作品的所有录音版本（默认版本排最前） */
  recordings: Recording[];
  /** 当前实际播放的那条录音：演奏家、乐团、指挥、混音母带都在这儿 */
  currentRecording: Recording | null;
  /** 手动指定的歌词文件名（相对 data 目录）；自动匹配的不写在这里 */
  lyricsFile: string | null;
  /** 被标记为纯音乐：没有歌词是正常状态 */
  instrumental: boolean;
  tags: TagRef[];
  analysis: AnalysisDoc | null;
}

/**
 * 详情面板就地编辑允许改动的字段。
 *
 * 只收这几种 —— 它们是「档案元信息」，改错的代价只是显示不对；
 * 分析标记、事件、标签绑定各有自己的接口与撤销语义，不从这里过。
 * `undefined` 表示「这次不动」，`null` / 空数组表示「清空」。
 */
export interface TrackPatch {
  title?: string;
  /** 所属专辑 */
  album?: string | null;
  /** 在这张专辑里是第几首（1 起）；null 表示清空 */
  albumTrackNo?: number | null;
  subtitle?: string | null;
  aliases?: string[];
  moods?: string[];
  credits?: Record<string, string | null>;
  instrumentationAbstract?: string | null;
  /** 规范值（medieval / romantic…），中文写法由渲染层先用 PERIODS 翻好 */
  period?: string | null;
  /**
   * 流派（genre）：存词条的 name，如 `Jazz` / `Chamber Music`。
   * 中文写法由渲染层先按 data/vocab/genre.json 翻好；词表里没有的写法原样存，
   * 不因为「不认识」就把用户输入吞掉。
   */
  genre?: string | null;
  /** 体裁：词表 id（`symphony`）；null 表示清空 */
  compositionType?: string | null;
  /** 曲式：词表 id（`sonata`）；null 表示清空 */
  form?: string | null;
  /** 作品编号（No.1）。标题模板的 `%Number of the form}` */
  formNumber?: string | null;
  /** 作品号（Op.2, No.1；N/A = 不适用）。标题模板的 `%Opus Number}` */
  opusNumber?: string | null;
  /** 乐章子体裁：词表 id（menuett）；标题模板的 `%Sub-Type}` */
  subType?: string | null;
  /** 乐章速度术语（Allegretto / 小快板）；标题模板的 `%Tempo Term}` */
  tempoTerm?: string | null;
  /** 只改 tick 0 那条拍号；其它位置的拍号变化仍走网格 */
  meter?: { num: number; den: number } | null;
  /** 只改 tick 0 那条速度 */
  bpm?: number | null;
  /** 整条调性链（按顺序写进已有的 key marker，tick 保持不变） */
  keys?: string[];
}

export interface TrackQuery {
  text?: string;
  tags?: { dim: string; id: string }[];
  limit?: number;
  offset?: number;
}

export interface TagSuggestion {
  id: string;
  dim: string;
  name: string;
  display: string | null;
  /*
   * exact = 规范名 / 显示名完全相等；alias = 别名完全相等；
   * prefix = 前缀或子串命中；fuzzy = 编辑距离 ≤2。
   */
  how: 'exact' | 'alias' | 'prefix' | 'fuzzy' | 'new';
  score: number;
  /**
   * 归一化后与 name / display / 任一别名完全相等。
   * 后端判定，渲染层不要再自己 `toLowerCase()` 比一遍 —— 两套归一化规则会在
   * 全角括号、首尾顿号这类边角上不一致，表现为「候选明明在，回车却没选中它」。
   */
  exact?: boolean;
}

/**
 * 搜索框补全的一条候选。
 * `insert` 是「真正要写进搜索框的字面」—— 用户敲中文就回填中文，
 * 敲英文就回填命中的那个英文写法，不能一律回填 display（英文界面会塞进一串汉字）。
 */
export interface SearchSuggestion {
  /** tag = 可挂到曲目上的标签；genre / mood / period 是曲目上的单值/多值字段 */
  kind: 'tag' | 'mood' | 'period' | 'genre';
  id: string;
  /** 标签才有：instrument / instrument_technique / composition */
  dim: string | null;
  /** 中文显示名 */
  label: string;
  /** 英文显示名（标签为规范名） */
  en: string;
  insert: string;
  score: number;
}

export interface OrphanReport {
  tagId: string;
  dim: string;
  name: string;
  refCount: number;
  trackIds: string[];
}

/**
 * 词表里的一棵树。字段与 data/vocab/*.json 一一对应 —— 界面拿到的就是文件里的样子，
 * 保存时整棵发回，主进程规范化后原样落盘。
 */
export interface VocabTreeNode {
  id: string;
  name: string;
  display?: string | null;
  aliases?: string[];
  /** 其它语言译名：`{ de: 'Querflöte', ja: 'フルート' }`，与别名一起进搜索 */
  translations?: Record<string, string>;
  note?: string;
  children?: VocabTreeNode[];
}

export type VocabIssue = {
  code: 'badShape' | 'badId' | 'dupId' | 'takenId' | 'noName' | 'badAliases' | 'badTranslations' | 'tooDeep';
  id?: string;
};

export type VocabSaveResult =
  | { ok: true; dim: string; removed: string[]; tags?: number; aliases?: number }
  | {
      ok: false;
      code: 'unknownDim' | 'badShape' | 'invalid' | 'referenced' | 'io';
      issues?: VocabIssue[];
      refs?: { id: string; count: number }[];
      detail?: string;
    };

export interface LaneDef {
  id: string;
  label: string;
  kind: 'text' | 'note' | 'bar';
  height: number;
  align?: 'left' | 'center' | 'right';
  placeholder?: string;
}

export interface ViewDef {
  schemaVersion: number;
  id: string;
  name: string;
  group: string;
  needsContext?: string;
  note?: string;
  lanes: LaneDef[];
}

export interface VocabDim {
  dim: string;
  count: number;
  roots: number;
}

export interface AppMeta {
  dataDir: string;
  dbPath: string;
  trackCount: number;
  tagCount: number;
  views: ViewDef[];
  vocabs: VocabDim[];
  electron: string;
  chrome: string;
}

export interface LyricsStyle {
  /** 桌面歌词字号（px） */
  size: number;
  opacity: number;
  color: 'white' | 'accent' | 'warm';
  /** 显示下一句 */
  next: boolean;
}

export interface LyricLine {
  ms: number;
  text: string;
}

export interface LyricDoc {
  trackId: string;
  found: boolean;
  file: string | null;
  path: string | null;
  lines: LyricLine[];
  meta: { ti: string; ar: string; al: string; by: string; offset: number; credits: string[] };
  /** 纯音乐：没有歌词是正常的 */
  instrumental: boolean;
  how: 'manual' | 'auto' | 'none';
}

export interface PlayerState {
  trackId: string | null;
  title: string | null;
  /** 本地音频 / 仅时间线（无音频、独立时钟）/ 未加载 */
  sourceMode: 'audio' | 'timeline' | 'none';
  playing: boolean;
  currentMs: number;
  durationMs: number;
  ready: boolean;
  /**
   * 主输出增益（线性幅度 0~1）。
   *
   * 必须跟着状态一起走：主窗口是唯一持有 `<audio>` 的地方，
   * 音量只在它那儿生效 —— 不带这个字段，主窗口拉完推子，
   * 歌词窗口的滑块还停在旧位置，看着像「音量没同步」。
   */
  gain: number;
}

export type PlayerCommand =
  | { type: 'toggle' }
  | { type: 'rewind' }
  | { type: 'seek'; ms: number }
  /** 仅时间线模式下改总长；由主窗口统一执行，独立窗口只是发指令 */
  | { type: 'duration'; ms: number };

/** 归档目录（`data/tracks/.archive`）里的一条记录 */
export interface ArchivedTrack {
  /** = 库里那条 track.id；老档案没有就是 null（只能删文件，动不了库里的行） */
  uuid: string | null;
  title: string;
  /** 归档时间（毫秒时间戳） */
  archivedAt: number;
  /** 归档目录里的文件名 */
  file: string;
}

/** 窗口的位置与大小（与 workspaces.json 的 Rect 同形） */
export interface WinBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一个窗口记下来的几何：位置大小 + 是否最大化（子窗口一般没有最大化） */
export interface WinBox {
  bounds?: WinBounds;
  maximized?: boolean;
}

/**
 * 主窗口里能用鼠标拖的那几块。
 *
 * `leftW` / `rightW` 是左右栏宽度，`panelH` 是下方时间线面板的高度；
 * 三个 `*Collapsed` / `panelOpen` 是「有没有被收起来」—— 宽度记了 0 的话
 * 展开回来没地方知道原来多宽，所以要分开记。
 */
export interface PanelSizes {
  leftW?: number;
  rightW?: number;
  panelH?: number;
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  panelOpen?: boolean;
}

/** 独立时间线窗口里那条泳道侧栏（宽度与开合） */
export interface GridSideState {
  sideW?: number;
  sideOpen?: boolean;
}

/**
 * 自动记忆的布局（config.json 的 `layout`）。
 *
 * 与 workspaces.json 的区别：那份是**用户手动存的多套布局**，这份是
 * 「上次关软件时窗口长什么样」—— 两者共存，启动时先按这份摆，用户点工作区才临时覆盖。
 * 刻意**不记**开不开窗（那是 `startup` 的事），只记几何。
 */
export interface LayoutConfig {
  main: WinBox;
  panels: PanelSizes;
  grid: WinBox & GridSideState;
  lyrics: WinBox;
  help: WinBox;
  history: WinBox;
  overlay: WinBox;
}

/** 只改其中几项：渲染层上报面板尺寸时只带 panels，主进程改窗口时只带那一个窗口 */
export type LayoutPatch = {
  [K in keyof LayoutConfig]?: Partial<LayoutConfig[K]>;
};

/**
 * 启动配置（userData/config.json）。只放「这台机器怎么启动」：
 * 开哪些子窗口、要不要安全模式、窗口与面板摆在哪。作品内容不进来。
 */
export interface AppConfig {
  version: 1;
  safeMode: boolean;
  startup: {
    lyrics: boolean;
    help: boolean;
  };
  /** 自动记忆的布局；文件里没有这一段就是空对象（各窗口按默认位置开） */
  layout: LayoutConfig;
}

export interface AppConfigSnapshot extends AppConfig {
  /** config.json 的绝对路径（选项里显示，方便手改） */
  path: string;
  /** 这次启动才创建的文件：渲染层借机迁移一次旧的 localStorage 偏好 */
  fresh: boolean;
  /** 文件不是合法 JSON / 顶层不是对象时的错误；此时按默认值运行 */
  parseError: string | null;
}

export interface AppConfigPatch {
  safeMode?: boolean;
  startup?: Partial<AppConfig['startup']>;
  layout?: LayoutPatch;
}

export interface Api {
  meta(): Promise<AppMeta>;
  /** 启动配置：外置 config.json，选项里可打开手改；改完重启生效 */
  config: {
    get(): Promise<AppConfigSnapshot>;
    update(patch: AppConfigPatch): Promise<AppConfigSnapshot>;
    openFile(): Promise<string>;
    /** 只写布局那一段（面板拖动结束、折叠切换时调用；主进程自己改窗口时不走这里） */
    setLayout(patch: LayoutPatch): Promise<AppConfigSnapshot>;
  };
  app: {
    /** 界面语言：主进程要用它拼窗口标题、文件对话框、网易云提示 */
    setLocale(locale: string): Promise<void>;
    /** 主进程存一份实际生效的主题，好让子窗口开窗时就用对的 backgroundColor */
    setTheme(theme: string): Promise<'dark' | 'light'>;
    theme(): Promise<'dark' | 'light'>;
    onTheme(cb: (t: string) => void): () => void;
    /** 主题模式：dark / light / system（跟随系统）/ timed（按时段） */
    setThemeMode(mode: string): Promise<string>;
    themeMode(): Promise<string>;
    /** 系统当前是深色还是浅色。nativeTheme 只有主进程能读，渲染层只能问它 */
    systemTheme(): Promise<'dark' | 'light'>;
    onSystemTheme(cb: (t: string) => void): () => void;
  };
  /**
   * 快捷键跨窗口转发：焦点在子窗口时，主进程截键后转给主窗口。
   * 主窗口订阅 onHotkey 把按键还原成 KeyboardEvent 派发回自己的 window。
   */
  hotkey: {
    /** 子窗口专用：输入框拿到/失去焦点时上报，主进程据此放行按键 */
    editing(on: boolean): void;
    onHotkey(cb: (p: { action: string; key: string; code: string; ctrl: boolean; shift: boolean; alt: boolean }) => void): () => void;
  };
  search: {
    /** 搜索框补全：只按「正在敲的那个词」给候选 */
    suggest(input: string): Promise<SearchSuggestion[]>;
  };
  tracks: {
    list(q: TrackQuery): Promise<TrackRow[]>;
    get(id: string): Promise<TrackDetail | null>;
    upsert(patch: Record<string, unknown>): Promise<string>;
    /** 登记作品：建空曲目 + 空分析档案。parentId 非空时登记为某作品的乐章子项 */
    create(patch?: { title?: string; parentId?: string }): Promise<{ id: string; analysisId: string; title: string }>;
    rename(id: string, title: string): Promise<{ id: string; title: string } | null>;
    /** 详情面板双击编辑：返回改完的整条详情，渲染层直接替换，不必再 get 一次 */
    update(id: string, patch: TrackPatch): Promise<TrackDetail | null>;
    remove(id: string): Promise<void>;
  };
  /**
   * 归档：`remove` 只是把曲目移进 `data/tracks/.archive`，
   * 彻底删除才清库里的行 + 归档里的 JSON。
   */
  archive: {
    list(): Promise<ArchivedTrack[]>;
    purge(uuid: string | null): Promise<{ track: boolean; files: number }>;
    purgeAll(): Promise<number>;
  };
  tags: {
    suggest(dim: string, input: string): Promise<TagSuggestion[]>;
    ensure(dim: string, name: string): Promise<string>;
    merge(from: string, to: string): Promise<void>;
    orphans(): Promise<OrphanReport[]>;
    tree(dim: string): Promise<{ id: string; name: string; display: string | null; parent: string | null }[]>;
    attach(trackId: string, tagId: string): Promise<void>;
    detach(trackId: string, tagId: string): Promise<void>;
  };
  /** 词表编辑器：整棵树读 / 整棵树写（主进程校验并规范化，失败时一个字节都不落盘） */
  vocab: {
    doc(dim: string): Promise<{
      dim: string;
      file: string;
      note: string;
      schemaVersion: number;
      roots: VocabTreeNode[];
      refs: Record<string, number>;
    }>;
    save(dim: string, roots: VocabTreeNode[]): Promise<VocabSaveResult>;
    /** 用系统默认程序打开 data/vocab/<dim>.json（维护人员用） */
    openFile(dim: string): Promise<string>;
  };
  analysis: {
    get(trackId: string): Promise<AnalysisDoc | null>;
    setMarkers(analysisId: string, kind: MarkerKind, ms: Marker[]): Promise<void>;
    upsertEvent(e: Partial<AnalysisEvent> & { analysisId: string; lane: string; tick: number; text: string }): Promise<AnalysisEvent>;
    deleteEvent(id: string): Promise<void>;
    /** 把 [startTick, endTick) 的格子写成 text；跨边界的事件会被截短/拆分，不整条销毁 */
    writeRange(p: RangePayload & { text: string; confidence?: Confidence }): Promise<RangeResult>;
    /**
     * 拖边缘改范围。与 writeRange 的区别：传原区间 fromTick/toTick，
     * 收缩时会把原区间露在新区间外的残余一起剪掉（否则会留下同名的半截）。
     */
    resize(
      p: RangePayload & { text: string; fromTick: number; toTick: number; confidence?: Confidence }
    ): Promise<RangeResult>;
    /** 区间删除：同样是裁剪，不是整条抹掉 */
    clearRange(p: RangePayload): Promise<RangeResult>;
    deleteEvents(ids: string[]): Promise<number>;
    /** 拖动移动：只改位置（时值不变）；落到别人身上按裁剪规则覆盖 */
    moveEvents(
      analysisId: string,
      moves: { id: string; tick: number; lane: string }[]
    ): Promise<{ moved: number; removed: number; trimmed: number }>;
    /** 撤销：整份事件快照回写 */
    replaceEvents(analysisId: string, events: AnalysisEvent[]): Promise<number>;
    setAudioOffset(analysisId: string, ms: number): Promise<void>;
    setView(analysisId: string, viewId: string): Promise<void>;
  };
  netease: {
    open(url: string): Promise<{ ok: boolean; via: 'orpheus' | 'browser' | 'failed'; url: string; note?: string }>;
  };
  /**
   * 通用外链：录音版本可能挂在 QQ 音乐 / B 站 / 厂牌官网，
   * 不该为每个站点都塞一条专用通道。只放行 http(s)。
   */
  link: {
    open(url: string): Promise<{ ok: boolean; via: 'orpheus' | 'browser' | 'failed'; url: string; note?: string }>;
  };
  /** 封面：选图会复制进 data/covers，返回新的封面集合 */
  art: {
    pick(trackId: string, kind: 'single' | 'album'): Promise<CoverSet | null>;
    clear(trackId: string, kind: 'single' | 'album'): Promise<CoverSet | null>;
  };
  /** 歌词：解析好的行 + 元信息 */
  lyrics: {
    resolve(trackId: string): Promise<LyricDoc>;
    pick(trackId: string): Promise<LyricDoc | null>;
    clear(trackId: string): Promise<LyricDoc | null>;
    setInstrumental(trackId: string, on: boolean): Promise<LyricDoc | null>;
    /** 桌面歌词样式：主窗口写、浮窗收广播 */
    style(): Promise<LyricsStyle>;
    setStyle(style: LyricsStyle): Promise<LyricsStyle>;
    onStyle(cb: (style: LyricsStyle) => void): () => void;
  };
  /**
   * 播放中枢。主窗口是唯一的音频宿主；歌词窗口 / 桌面歌词只发指令、收状态，
   * 否则两个 <audio> 同时播就是双声道重音。
   */
  player: {
    publish(state: PlayerState): Promise<void>;
    state(): Promise<PlayerState>;
    command(cmd: PlayerCommand): Promise<void>;
    onState(cb: (s: PlayerState) => void): () => void;
    onCommand(cb: (c: PlayerCommand) => void): () => void;
  };
  audio: {
    resolve(trackId: string): Promise<AudioInfo>;
    /**
     * 按「某条录音版本」解析：双击演奏版本时播它，**不改数据库**。
     * url 是 ma-audio://rec/<trackId>/<recId>，与作品级地址同一个协议处理器。
     */
    resolveRecording(trackId: string, recId: string): Promise<AudioInfo>;
    pick(trackId: string): Promise<AudioInfo | null>;
    /** 直接指定路径（拖放 / 脚本用），不弹对话框 */
    setPath(trackId: string, filePath: string): Promise<AudioInfo>;
  };
  /** 波形缓存（磁盘层，只存解码后的峰值金字塔） */
  wave: {
    get(meta: WaveMeta): Promise<Uint8Array | null>;
    put(meta: WaveMeta, bytes: Uint8Array, limitBytes: number): Promise<WaveStats>;
    forget(meta: WaveMeta): Promise<boolean>;
    prune(limitBytes: number): Promise<number>;
    stats(): Promise<WaveStats>;
    clear(): Promise<number>;
  };
  ui: {
    /** Electron 原生缩放（webFrame.setZoomFactor），高分屏下比 CSS zoom 清晰 */
    setZoom(factor: number): Promise<number>;
    getZoom(): Promise<number>;
  };
  win: {
    /** 歌词播报器（子窗口） */
    openLyrics(): Promise<boolean>;
    closeLyrics(): Promise<boolean>;
    lyricsOpen(): Promise<boolean>;
    /** 歌词播报器置顶。传 true/false 设，不传取反（菜单勾选走取反） */
    lyricsAlwaysOnTop(v?: boolean): Promise<boolean>;
    getLyricsAlwaysOnTop(): Promise<boolean>;
    /** 打开图片查看窗口（封面大图）。url 走 ma-art:// 协议，不传本地路径 */
    openImage(url: string, title?: string): Promise<boolean>;
    /** 图片加载完按真实尺寸把窗口撑到刚好 */
    resizeImage(w: number, h: number): Promise<boolean>;
    onImage(cb: (p: { url: string; title: string }) => void): () => void;
    onLyricsState(cb: (open: boolean) => void): () => void;
    /** 桌面歌词浮窗 */
    openOverlay(): Promise<boolean>;
    closeOverlay(): Promise<boolean>;
    /** 无边框浮窗没有标题栏可拖，渲染层报像素增量，主进程移动窗口 */
    moveOverlay(dx: number, dy: number): Promise<boolean>;
    overlayOpen(): Promise<boolean>;
    onOverlayState(cb: (open: boolean) => void): () => void;
    minimize(): Promise<void>;
    maximize(): Promise<void>;
    close(): Promise<void>;
    /** 原生窗口按钮配色（titleBarOverlay），深/浅色切换时要同步 */
    overlay(opts: { color?: string; symbolColor?: string }): Promise<void>;
    /** 在独立窗口里打开网格（新窗口默认最大化） */
    openGrid(trackId: string, viewId?: string): Promise<boolean>;
  };
}
