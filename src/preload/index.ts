import { contextBridge, ipcRenderer, webUtils } from 'electron';

const invoke = ipcRenderer.invoke.bind(ipcRenderer);

const api = {
  meta: () => invoke('app:meta'),
  search: {
    suggest: (input: string) => invoke('search:suggest', input),
  },
  openDataDir: () => invoke('app:open-data-dir'),
  reloadVocab: () => invoke('app:reload-vocab'),
  /** 启动配置：外置 userData/config.json。选项里改会立刻写盘，手改则重启生效 */
  config: {
    get: () => invoke('config:get'),
    update: (patch: unknown) => invoke('config:update', patch),
    openFile: () => invoke('config:open'),
    /** 只写布局那一段：面板宽高、开合状态（窗口几何由主进程自己记） */
    setLayout: (patch: unknown) => invoke('config:set-layout', patch),
  },
  app: {
    /** 界面语言：主进程要用它拼窗口标题、文件对话框、网易云提示 */
    setLocale: (locale: string) => invoke('app:set-locale', locale),
    /** 界面主题：主进程存一份，好让子窗口开窗时就用对的配色（避免闪白） */
    setTheme: (theme: string) => invoke('app:theme-set', theme),
    theme: () => invoke('app:theme-get'),
    onTheme: (cb: (t: string) => void) => {
      const h = (_e: unknown, t: string) => cb(t);
      ipcRenderer.on('app:theme', h as any);
      return () => ipcRenderer.removeListener('app:theme', h as any);
    },
    /** 主题模式：dark / light / system / timed */
    setThemeMode: (m: string) => invoke('app:theme-mode-set', m),
    themeMode: () => invoke('app:theme-mode-get'),
    /** 系统当前是深色还是浅色（nativeTheme 只有主进程能读） */
    systemTheme: () => invoke('app:system-theme'),
    onSystemTheme: (cb: (t: string) => void) => {
      const h = (_e: unknown, t: string) => cb(t);
      ipcRenderer.on('app:system-theme', h as any);
      return () => ipcRenderer.removeListener('app:system-theme', h as any);
    },
  },
  tracks: {
    list: (q: unknown) => invoke('tracks:list', q),
    get: (id: string) => invoke('tracks:get', id),
    upsert: (p: unknown) => invoke('tracks:upsert', p),
    create: (p: unknown) => invoke('tracks:create', p),
    /**
     * 拖入音频后登记。mode = versions（多录音版本）/ variants（多音质）/ tracks（每文件一份作品）。
     * 路径由 pathForFile 从系统拖放的 File 上取，资源管理器、Everything、访达走的是同一条。
     */
    importAudio: (input: unknown) => invoke('tracks:import-audio', input),
    pathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    rename: (id: string, title: string) => invoke('tracks:rename', id, title),
    update: (id: string, patch: unknown) => invoke('tracks:update', id, patch),
    remove: (id: string) => invoke('tracks:remove', id),
  },
  /** 分区拖放：预览不写库；确认时再登记。路径必须是普通字符串，不能把 Vue 的响应式数组直接送过来。 */
  drop: {
    preview: (paths: unknown) => invoke('drop:preview', paths),
    commitLibrary: (input: unknown) => invoke('drop:commit-library', input),
    commitDetailAudio: (input: unknown) => invoke('drop:commit-detail-audio', input),
    commitDetailImage: (input: unknown) => invoke('drop:commit-detail-image', input),
    commitDetailLyric: (input: unknown) => invoke('drop:commit-detail-lyric', input),
  },
  /**
   * 归档：删除曲目只是把它移进 `data/tracks/.archive`，
   * 「彻底删除」才真的清掉库里的行 + 归档里的 JSON 文件。
   */
  archive: {
    list: () => invoke('archive:list'),
    purge: (uuid: string | null) => invoke('archive:purge', uuid),
    purgeAll: () => invoke('archive:purge-all'),
  },
  tags: {
    suggest: (dim: string, input: string) => invoke('tags:suggest', dim, input),
    ensure: (dim: string, name: string) => invoke('tags:ensure', dim, name),
    merge: (a: string, b: string) => invoke('tags:merge', a, b),
    orphans: () => invoke('tags:orphans'),
    tree: (dim: string) => invoke('tags:tree', dim),
    attach: (trackId: string, tagId: string) => invoke('tags:attach', trackId, tagId),
    detach: (trackId: string, tagId: string) => invoke('tags:detach', trackId, tagId),
  },
  /**
   * 词表编辑器。传的是整棵 roots 树（不是增量补丁）：
   * 结构校验、规范化、引用检查都在主进程一次做完，界面不需要知道写库细节。
   */
  vocab: {
    doc: (dim: string) => invoke('vocab:doc', dim),
    save: (dim: string, roots: unknown) => invoke('vocab:save', dim, roots),
    openFile: (dim: string) => invoke('vocab:open-file', dim),
  },
  /** 字母和弦的补全词表（data/vocab/chord-symbols.json），结构与标签词表无关 */
  chords: {
    doc: () => invoke('chords:doc'),
    save: (doc: unknown) => invoke('chords:save', doc),
    openFile: () => invoke('chords:open-file'),
  },
  /** 乐章标题补全：tempo_marking.json + composition_type.json 合并；openFile 打开速度表 */
  movement: {
    doc: () => invoke('movement:doc'),
    openFile: () => invoke('movement:open-file'),
  },
  analysis: {
    get: (trackId: string) => invoke('analysis:get', trackId),
    setMarkers: (id: string, kind: string, ms: unknown[]) => invoke('analysis:setMarkers', id, kind, ms),
    upsertEvent: (e: unknown) => invoke('analysis:upsertEvent', e),
    deleteEvent: (id: string) => invoke('analysis:deleteEvent', id),
    writeRange: (p: unknown) => invoke('analysis:writeRange', p),
    resize: (p: unknown) => invoke('analysis:resize', p),
    clearRange: (p: unknown) => invoke('analysis:clearRange', p),
    deleteEvents: (ids: string[]) => invoke('analysis:deleteEvents', ids),
    moveEvents: (id: string, moves: unknown[]) => invoke('analysis:moveEvents', id, moves),
    replaceEvents: (id: string, events: unknown[]) => invoke('analysis:replaceEvents', id, events),
    setAudioOffset: (id: string, ms: number) => invoke('analysis:setAudioOffset', id, ms),
    setView: (id: string, viewId: string) => invoke('analysis:setView', id, viewId),
  },
  ui: {
    setZoom: (factor: number) => invoke('ui:setZoom', factor),
    getZoom: () => invoke('ui:getZoom'),
  },
  /** 「为作者提供经济支持」：收款码由主进程从 assets 里按文件名找出来 */
  support: {
    qrs: () => invoke('support:qrs'),
  },
  netease: {
    open: (url: string) => invoke('netease:open', url),
  },
  link: {
    open: (url: string) => invoke('link:open', url),
  },
  art: {
    pick: (trackId: string, kind: string) => invoke('art:pick', trackId, kind),
    clear: (trackId: string, kind: string) => invoke('art:clear', trackId, kind),
    clearVersion: (trackId: string, recId: string) => invoke('art:clear-version', trackId, recId),
  },
  /** 播放列表：`{ schemaVersion, lists: [{ id, name, trackIds }] }`，源在 data/playlists.json */
  playlists: {
    list: () => invoke('playlists:list'),
    create: (name?: string) => invoke('playlists:create', name),
    rename: (id: string, name: string) => invoke('playlists:rename', id, name),
    remove: (id: string) => invoke('playlists:remove', id),
    setTracks: (id: string, trackIds: string[]) => invoke('playlists:set-tracks', id, trackIds),
  },
  lyrics: {
    resolve: (trackId: string, recId?: string | null) => invoke('lyrics:resolve', trackId, recId ?? null),
    pick: (trackId: string) => invoke('lyrics:pick', trackId),
    clear: (trackId: string) => invoke('lyrics:clear', trackId),
    clearVersion: (trackId: string, recId: string) => invoke('lyrics:clear-version', trackId, recId),
    setInstrumental: (trackId: string, on: boolean) => invoke('lyrics:instrumental', trackId, on),
    /** 改某一句：ms 改时间戳、text 改内容，写回 lrc 文件 */
    saveLine: (trackId: string, patch: unknown) => invoke('lyrics:save-line', trackId, patch),
    /** 翻译：同目录同名 .trans.lrc / .中文.lrc / .json 都认 */
    translation: (trackId: string) => invoke('lyrics:translation', trackId),
    pickTranslation: (trackId: string) => invoke('lyrics:trans-pick', trackId),
    clearTranslation: (trackId: string) => invoke('lyrics:trans-clear', trackId),
    style: () => invoke('lyrics:style-get'),
    setStyle: (st: unknown) => invoke('lyrics:style-set', st),
    onStyle: (cb: (st: unknown) => void) => {
      const h = (_e: unknown, st: unknown) => cb(st);
      ipcRenderer.on('lyrics:style', h as any);
      return () => ipcRenderer.removeListener('lyrics:style', h as any);
    },
  },
  /**
   * 播放中枢：主窗口 publish，其他窗口 onState；
   * 其他窗口 command，主窗口 onCommand。
   * on* 返回退订函数 —— 组件卸载时必须退，否则窗口里反复挂载会叠出多个监听。
   */
  player: {
    publish: (s: unknown) => invoke('player:publish', s),
    state: () => invoke('player:state'),
    command: (c: unknown) => invoke('player:command', c),
    /** 音量：主窗口是唯一持有 <audio> 的地方，所以子窗口的滑块走指令过来 */
    setGain: (gain: number) => invoke('player:command', { type: 'gain', gain }),
    onState: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('player:state', h as any);
      return () => ipcRenderer.removeListener('player:state', h as any);
    },
    onCommand: (cb: (c: unknown) => void) => {
      const h = (_e: unknown, c: unknown) => cb(c);
      ipcRenderer.on('player:command', h as any);
      return () => ipcRenderer.removeListener('player:command', h as any);
    },
  },
  audio: {
    resolve: (trackId: string) => invoke('audio:resolve', trackId),
    /** 按录音版本解析：双击子行播它，不写库、不动顺序 */
    resolveRecording: (trackId: string, recId: string) => invoke('audio:resolveRecording', trackId, recId),
    pick: (trackId: string) => invoke('audio:pick', trackId),
    setPath: (trackId: string, filePath: string) => invoke('audio:setPath', trackId, filePath),
    /** 某一条音频文件里写的元数据（bext / iXML / ID3 / Vorbis comment），只读。recId 省略 = 主录音 */
    tags: (trackId: string, recId?: string | null) => invoke('audio:tags', trackId, recId ?? null),
  },
  /**
   * 波形缓存（磁盘层）：键是「路径 + 字节数 + 修改时间」，值是一段二进制峰值金字塔。
   * 渲染层解码完写一份、下次先来问它 —— 省的是 fetch 整段音频 + decodeAudioData 的那 1–2 秒。
   */
  wave: {
    get: (meta: unknown) => invoke('wave:get', meta),
    put: (meta: unknown, bytes: Uint8Array, limitBytes: number) => invoke('wave:put', meta, bytes, limitBytes),
    forget: (meta: unknown) => invoke('wave:forget', meta),
    prune: (limitBytes: number) => invoke('wave:prune', limitBytes),
    stats: () => invoke('wave:stats'),
    clear: () => invoke('wave:clear'),
  },
  /**
   * 录音制品：同一部作品的不同录音版本。
   * 演奏家 / 乐团 / 指挥 / 混音 / 母带 / 发行年都在这一层，
   * 因为它们逐版本不同；作曲家、时期、编制留在作品层。
   */
  recording: {
    list: (trackId: string) => invoke('recording:list', trackId),
    get: (id: string) => invoke('recording:get', id),
    save: (patch: unknown) => invoke('recording:save', patch),
    remove: (id: string) => invoke('recording:remove', id),
    setDefault: (trackId: string, recId?: string) => invoke('recording:setDefault', trackId, recId),
    /** 调整顺序 = 决定「点作品播放先播哪一版」。ids 是从前往后的完整清单 */
    reorder: (trackId: string, ids: string[]) => invoke('recording:reorder', trackId, ids),
    /** 原点偏移逐版本存。recId 传 null 表示写主录音（顺序里的第一首） */
    setOffset: (trackId: string, recId: string | null, ms: number) =>
      invoke('recording:setOffset', trackId, recId, ms),
    pick: (trackId: string, recId?: string) => invoke('recording:pick', trackId, recId),
    /** 同一演奏版本追加一个音质 / 转码文件（父版本 id） */
    pickVariant: (parentId: string) => invoke('recording:pickVariant', parentId),
    /** 把一条已有版本并到另一条下面，当作同版音质 */
    mergeInto: (id: string, parentId: string) => invoke('recording:mergeInto', id, parentId),
    ensure: (trackId: string) => invoke('recording:ensure', trackId),
  },
  /**
   * 快捷键跨窗口转发。
   *
   * 焦点在歌词播报器 / 网格窗口时，主窗口的 keydown 监听收不到事件 ——
   * 主进程在子窗口上截键并转给主窗口，主窗口再用 onHotkey 收到。
   * `editing` 是子窗口告诉主进程「我正在输入，别拦」的口子。
   */
  hotkey: {
    editing: (on: boolean) => ipcRenderer.send('hotkey:editing', !!on),
    onHotkey: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on('app:hotkey', h as any);
      return () => ipcRenderer.removeListener('app:hotkey', h as any);
    },
  },
  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
    overlay: (o: { color?: string; symbolColor?: string }) => invoke('win:overlay', o),
    openGrid: (trackId: string, viewId?: string) => invoke('win:open-grid', trackId, viewId),
    openLyrics: () => invoke('win:open-lyrics'),
    /**
     * 主窗口「完全启动」信号。渲染层加载完曲库、首帧画完之后报一次，
     * 主进程收到才去开歌词播报器 —— 用固定 setTimeout 猜时机一定会有人抢跑。
     */
    appReady: (opts?: { autoLyrics?: boolean; autoHelp?: boolean }) => invoke('win:app-ready', opts),
    closeLyrics: () => invoke('win:close-lyrics'),
    lyricsOpen: () => invoke('win:lyrics-open'),
    /** 歌词播报器置顶。传 true/false 设，不传取反（菜单勾选走取反） */
    lyricsAlwaysOnTop: (v?: boolean) => invoke('win:lyrics-always-on-top', v),
    getLyricsAlwaysOnTop: () => invoke('win:lyrics-always-on-top-get'),
    /** 打开图片查看窗口（封面大图）。url 是 ma-art:// 之类，不传本地路径 */
    openImage: (url: string, title?: string) => invoke('win:open-image', url, title),
    /** 图片加载完按真实尺寸把窗口撑到刚好 */
    resizeImage: (w: number, h: number) => invoke('win:resize-image', w, h),
    /** 已经开着窗口时换图（不重开） */
    onImage: (cb: (p: { url: string; title: string }) => void) => {
      const h = (_e: unknown, p: { url: string; title: string }) => cb(p);
      ipcRenderer.on('image:set', h as any);
      return () => ipcRenderer.removeListener('image:set', h as any);
    },
    openOverlay: () => invoke('win:open-overlay'),
    closeOverlay: () => invoke('win:close-overlay'),
    moveOverlay: (dx: number, dy: number) => invoke('win:move-overlay', dx, dy),
    overlayOpen: () => invoke('win:overlay-open'),
    onLyricsState: (cb: (open: boolean) => void) => {
      const h = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on('lyrics:state', h as any);
      return () => ipcRenderer.removeListener('lyrics:state', h as any);
    },
    onOverlayState: (cb: (open: boolean) => void) => {
      const h = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on('overlay:state', h as any);
      return () => ipcRenderer.removeListener('overlay:state', h as any);
    },
  },
  /**
   * 工作区（窗口布局）。窗口位置只能主进程读，所以快照在那边抓；
   * 渲染层负责「窗口内部」那半（面板/栏宽/缩放/主题/泳道），保存时一起传过去。
   */
  ws: {
    list: () => invoke('ws:list'),
    save: (p: { name?: string; ui: unknown }) => invoke('ws:save', p),
    apply: (name?: string) => invoke('ws:apply', name),
    remove: (name: string) => invoke('ws:delete', name),
    rename: (from: string, to: string) => invoke('ws:rename', from, to),
    lastUi: () => invoke('ws:last-ui'),
    onChanged: (cb: (st: { names: string[]; lastAt: number | null }) => void) => {
      const h = (_e: unknown, st: any) => cb(st);
      ipcRenderer.on('ws:changed', h as any);
      return () => ipcRenderer.removeListener('ws:changed', h as any);
    },
    /** 主进程让我们把独立时间线窗口拉起来（工作区恢复时） */
    onOpenGrid: (cb: (trackId: string) => void) => {
      const h = (_e: unknown, trackId: string) => cb(trackId);
      ipcRenderer.on('ws:open-grid', h as any);
      return () => ipcRenderer.removeListener('ws:open-grid', h as any);
    },
    /** 工作区恢复时把泳道侧栏的宽度 / 开合推给独立时间线窗口 */
    onGridSide: (cb: (st: { sideW: number; sideOpen: boolean }) => void) => {
      const h = (_e: unknown, st: { sideW: number; sideOpen: boolean }) => cb(st);
      ipcRenderer.on('grid:side', h as any);
      return () => ipcRenderer.removeListener('grid:side', h as any);
    },
  },
  /**
   * 操作历史（撤销 / 重做）。状态在主进程，渲染层只发指令、读列表。
   * `onChanged` 在每次追加/撤销/重做/清空后广播，历史窗口与网格按钮状态都靠它。
   */
  history: {
    list: () => invoke('history:list'),
    append: (p: unknown) => invoke('history:append', p),
    undo: (analysisId: string) => invoke('history:undo', analysisId),
    redo: (analysisId: string) => invoke('history:redo', analysisId),
    undoGlobal: () => invoke('history:undoGlobal'),
    redoGlobal: () => invoke('history:redoGlobal'),
    jump: (seq: number) => invoke('history:jump', seq),
    clear: (analysisId?: string) => invoke('history:clear', analysisId),
    can: (analysisId: string) => invoke('history:can', analysisId),
    config: (p: { limit: number; persist: number }) => invoke('history:config', p),
    toggle: () => invoke('history:toggle'),
    state: () => invoke('history:state'),
    onChanged: (cb: (st: unknown) => void) => {
      const h = (_e: unknown, st: unknown) => cb(st);
      ipcRenderer.on('history:changed', h as any);
      return () => ipcRenderer.removeListener('history:changed', h as any);
    },
    onApplied: (cb: (p: unknown) => void) => {
      const h = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on('history:applied', h as any);
      return () => ipcRenderer.removeListener('history:applied', h as any);
    },
    onState: (cb: (open: boolean) => void) => {
      const h = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on('history:state', h as any);
      return () => ipcRenderer.removeListener('history:state', h as any);
    },
  },
  /**
   * 动态操作帮助窗口。
   *
   * `push` 由主窗口的网格调用（选区/视图/编辑态变了就推一份摘要），
   * 主进程存一份再转给帮助窗口 —— 它读不到主窗口的组件状态，只能靠这条线。
   */
  help: {
    toggle: () => invoke('help:toggle'),
    state: () => invoke('help:state'),
    setAlwaysOnTop: (v: boolean) => invoke('help:top', v),
    push: (summary: unknown) => invoke('help:push', summary),
    /** 内容高变了：让主进程把窗口调成刚好装下（宽度固定 520） */
    resize: (contentH: number) => invoke('help:resize', contentH),
    onState: (cb: (st: { open: boolean; alwaysOnTop: boolean }) => void) => {
      const h = (_e: unknown, st: { open: boolean; alwaysOnTop: boolean }) => cb(st);
      ipcRenderer.on('help:state', h as any);
      return () => ipcRenderer.removeListener('help:state', h as any);
    },
    onSummary: (cb: (summary: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('help:summary', h as any);
      return () => ipcRenderer.removeListener('help:summary', h as any);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);
