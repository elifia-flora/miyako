# Schema 变更日志

> 规则：每次改动格式，写一行「为什么」。不改这里 = 三个月后你又忘了当初的设计意图。

## 2026-10-18 · schema v1 初始落地

**为什么有这张表**：JSON 里已有 `schemaVersion`，但版本号只说明"改过"，不说明"为什么改"。这份日志补上后半句。

---

### 决定 1：拍号 / 速度 / 段落 / 调性共用一张 `analysis_marker`

**为什么**：样本 `Structure[5] = { section 5: "A2", tonality: "g natural minor", start_position_musical: 56 }` —— 段落名、调性、起始位置是同一个时间点上的三个属性。若拆成两张表，就得靠"小节号相等"猜关联，很脆。

**代价**：读某种 kind 时必须永远带 `WHERE kind = ?`，否则字段互相污染。

---

### 决定 2：`tag_edge(child, parent)` 用关系表而不是 `parent_id` 字段

**为什么**：样本里 `{"parent": ["imitation","canon"]}`，一个技法挂两个父类；`modulation` 同时属于旋律技法与和声技法。单字段装不下。

**代价**：递归"含子类"查询必须 `DISTINCT`，且可能有多条路径。

---

### 决定 3：新增 `confidence`（confirmed / uncertain / guess）

**为什么**：样本里 `"tonality": "not sure, is f natural minor?"`。这是真实的、有价值的分析状态。如果格式只允许确定值，你就会被逼着把猜测写成事实。

**约定**：界面上不用红色警示，只用灰色 + `?`。

---

### 决定 4：`analysis.audio_offset_ms`

**为什么**：导出音频前后有留白，网格第 1 小节 ≠ 音频 0 秒。不建模则播放头永远差一两秒。

---

### 决定 5：`analysis_event.parsed`（JSON 文本）

**为什么**：罗马数字、字母和弦、黎曼功能是同一件事的三种写法。存原文（`text`）+ 解析结果（`parsed`），才能在不改变用户输入的前提下做换算与校验。

**现状**：字段已留，解析器未实现。第一版只存原文，不阻塞。

---

### 决定 6：泳道定义放 `data/views/*.json`，`lane` 在库里是无约束字符串

**为什么**：不同分析体系需要不同泳道组合。`needsContext: "key"` 表达"这条泳道依赖当前调性"——罗马数字与黎曼功能都依赖它。

**代价**：删除 view 不会删除事件数据；事件可能变成"孤儿泳道"，需要在界面里提示。

---

### 决定 7：声部（Violins 1/2）派生为子标签，不并回父乐器

**为什么**：第一/第二小提琴在配器分析里是两个编制单位。导入时遇到「乐器 + 编号」自动生成 `violin-1`（parent=`violin`），并写回词表。

**代价**：词表会随使用逐渐长出子标签，属预期行为。

---

### 决定 8：连续相同调性只生成一条 marker

**为什么**：样本里 A1 / Transition 1 / B1 都是 c natural minor，若每段都生成 marker，网格上会出现三条无意义的分隔线。

**结果**：9 个段落 → 5 条调性标记。

---

### 决定 9（v2 / 002 迁移）：FTS 改为 external content + 触发器

**为什么**：v1 的 `track_fts` 是 `content=''` 的无内容表，任何写入/删除都得手工把旧值再喂一遍，漏一次就永久脏索引；而索引脏了不会报错，只会让搜索结果莫名其妙。external content 模式让 FTS 跟着 `track` 自动增删改，代价只是多一个 002 迁移文件。

**结果**：`001_init.sql` 原封不动，新增 `002_fts_external_content.sql`（DROP + 重建 + 三个触发器 + rebuild）。

---

### 决定 10（v0.2）：`data/atlas.db` 在开发期直接放项目 `data/` 下

**为什么**：开发时能直接看到 JSON 与 .db 并排放着，导入/校验/查库都方便。打包后再换成 `userData`，那一步现在不做。

**代价**：`.db` / `-wal` / `-shm` 不应进版本库（见 `.gitignore`）。

---

### 决定 11（v0.3）：区间写入是「裁剪」，撤销是「整份快照」

**要解决的问题**：3/4 里一小节三拍，前两拍 I、第三拍 V7。用户框住第三拍填 V7 时，
原来那条跨三拍的 I 必须被**截短**，而不是整条消失（否则前两拍的标注就丢了）；
反过来，把某格内容清空时，也只该摘掉那一格。

**做法**（`writeRange` / `clearRange`）：
逐条取与区间相交的事件，按四种情况处理——全在区间内→删；只左边多→截短；
只右边多→右半段另存一条；两头都多→拆成两条。新内容再作为一条事件写进区间。

**为什么撤销不用「反向操作」**：一次写入可能同时产生截短 + 拆分 + 新增，
逐条反做需要保存「每条事件在操作前的完整形态」，本质上就是快照，还更容易漏。
所以撤销直接回写操作前的整份事件数组（`replaceEvents`），事件量级只有几百条，代价可以忽略。

**代价**：撤销栈只对当前分析档案有效，切曲目必须清空（已在 watch 里做）。

---

### 决定 12（v0.3）：网格的「格」= 拍号分母单位 ÷ 细分

**为什么不用固定四分音符**：6/8 的八分音符才是律动单位，套四分音符会出现半格；
用「分母单位」则 3/4→四分、6/8→八分，和乐谱上的拍一致。
需要「大拍」（附点四分）时用 `div=3`，需要半拍换和弦时用 `div=2`。

**框选语义**：按表格软件的习惯——**结束指针落在哪一格，就框到哪一格**。
指针压在格线上时算右边那格；这条规则同时决定了「拖到第 2 格左边缘 = 框住 1–2 格」。

---

### 决定 13（v0.3）：网格是下方面板 + 独立窗口，共用一个渲染层

**布局**：面板绝对定位在表格之上（不是把表格压小），高度可拖、可收起，
状态存 localStorage。这样表格的滚动位置不会因为开合面板而跳。

**独立窗口**：不为它单独打包一份页面，同一个 `index.html` 用 `#grid?track=…&view=…` 路由到
`GridStandalone.vue`。代价是两个窗口之间没有实时推送，改完要各自刷新。

---

### 决定 14（v0.4）：`div = 0` = 一小节一格，而不是再加一个参数

**为什么**：格的粒度现在有三种——半拍、一拍、一小节。前两种是「分母单位 ÷ n」，n 是常数；
一小节不是任何常数细分（小节长度随拍号变：3/4 = 1440 tick，5/8 = 1200 tick）。
给 `gridAt` 加第四个参数（`unit: 'bar' | 'beat'`）会让所有调用点都得改，
而 `0` 本身不可能是有意义的细分，拿它当哨兵最省事：
`div <= 0` 时 `cells = 1`、`cellTicks = barTicks`，其余函数（`cellAtTick` / `snapRange` / `countCells`）一行都不用改。

**代价**：`div` 的类型从「正整数」变成「正整数或 0」，得在注释里写清楚。已经写在这里了。

---

### 决定 15（v0.4）：Enter 顺延按**格数**走，不按 tick 走

**为什么**：选区宽度是 tick，但在变拍号的小节里同样多的 tick 不等于同样多的格。
用户框了 3 格，回车后想要的也是 3 格，不是「1440 tick」。
所以 `advance()` 先 `countCells` 数出格数，再一格一格调用 `cellAtTick` 往前走——
跨小节、变拍号都自动正确。Backspace 回退同理，用 `cellAtTick(tick - 1)` 找回上一格，
指针压在格线上时 `-1` 正好落进前一格，就是要的语义。

**没有做的**：顺延到曲子末尾就停住，不折行到开头（折行会让人以为写错了位置）。

---

### 决定 16（v0.4）：切主题要显式通知 canvas

**症状**：切深/浅色时，表格立刻变，网格要等下一次交互（移动鼠标、点一下）才变色。

**根因**：网格是 canvas，颜色是 `draw()` 时用 `getComputedStyle` 读出来的**快照**。
CSS 变量换了不会重绘画面，而之前的 `watch` 只盯着 `analysis / view / zoom / div`，主题不在其中。

**做法**：`MutationObserver` 监听 `<html>` 的 `data-theme` / `data-font`，变化即 `scheduleDraw()`。
比「把 theme 当 prop 一路传下来」更省：主题本来就是全局状态，独立窗口也一样生效。

**附带修改**：canvas 里两处写死的 `rgba(224,164,94,…)`（琥珀色）换成 `--accent-rgb`，
否则换主题时只有 HTML 变绿、网格还是旧配色。

---

### 决定 17（v0.4）：中文时期/调性必须**翻译**，不能只 LIKE

**为什么**：`track.period` 存 `contemporary`，`analysis_marker.key_name` 存 `c natural minor`。
用户敲「当代」「自然小调」，`LIKE '%当代%'` 永远匹配不到。

**做法**：`shared/search.js` 里维护两张映射表（时期 11 条、调式 15 条，含常见别译），
`expandQuery()` 把中文词翻成规范值，SQL 里再 `IN (...)` / `LIKE '%minor%'`。
纯函数、无 IO，主进程和 `node --test` 共用一份。

**坑（踩过）**：时期/调性的命中条件**必须**塞进那组 `OR` 里。
一开始写成独立的 `WHERE ... AND t.period IN (...)`，结果搜「古典主义」时，
曲名不含这四个字 → 整个 AND 失败 → 一条都不返回。搜索框里的多个字段永远是「并集」。

**限制**：映射表是写死的，新词得手动加。等到时期真正变成标签维度再换表。

---

### 决定 18（v0.5）：音频走自定义协议 `ma-audio://`，Range 必须自己实现

**为什么不用 `file://`**：渲染页开着 `contextIsolation`，`file://` 一旦放行就是「页面能读整块硬盘」。
自定义协议只认 **trackId**，真实路径由主进程查库决定（`audioPathFor`），
协议本身不提供「传个路径进来」的入口，天然不能变成任意文件读取。

**为什么必须自己写 206**：`<audio>` 的 seek 和「点波形定位」全靠 Range 分片。
一次性返回整段 18MB FLAC，`currentTime = x` 会变成「等两秒再跳」。
`serveAudio()` 里手写了 `bytes=a-b` / `bytes=-N` 两种形态，返回 206 + `Content-Range`。

**坑（踩过）**：协议注册完还是播不出声，控制台是
`Fetch API cannot load ma-audio://…` / `The element has no supported sources`。
不是协议的问题，是 **CSP**：`index.html` 的 `media-src` 与 `connect-src` 都要显式加 `ma-audio:`。
`connect-src` 那一行是漏得最隐蔽的——`fetch()` 取整段做波形解码走的是它，不是 `media-src`。

**采时长不信 `decodeAudioData`**：它会把音频重采样到 `AudioContext` 的采样率（44.1k 的 FLAC 解出来是 48k）。
所以时长与采样率走 `shared/audiofile.js` 直接读文件头（WAV/RIFF、AIFF 80-bit 扩展精度、FLAC STREAMINFO 20bit），
解码只用来算波形。

---

### 决定 19（v0.5）：`audio_offset_ms` 要有反函数，播放头才认得格子

**问题**：网格的原点是「第 1 小节第 1 拍」，音频的 0 秒常常不是那里（导出前后有留白）。
正着算 `tickToAudioMs = audio_offset_ms + tickToMs` 早就有了，
但播放头要反向问「现在这 1.8 秒在哪个 tick」，缺 `msToTick`。

**做法**：`shared/barbeat.js` 补 `msToTick(tempos, ms, ppq)`：先在变速度段表里二分定位，
再在段内线性反解；允许负数（音频还没到原点时，播放头应该贴着 0 而不是跳到曲子开头）。

**验证**：`offset=1500` 时第 1 小节首拍 = 音频 1.5s、播放头像素 0；
107BPM 下第 12 小节首拍 = 20005ms 且像素与 `xOfTick(15840)` 完全一致（616 = 616）。

**性能**：播放头每帧直接改 DOM transform，**不进 Vue 响应式**。
60fps 触发一次响应式更新，整张网格会重算，卡到不能用。

---

### 决定 20（v0.5）：拖动移动 = 时值不变 + 吸附格边界 + 落点按裁剪覆盖

**语义**：拖事件只改 `tick` / `lane`，`dur_ticks` 不变（用户拖的是「这一块」，不是「拉长」）。

**吸附**：位移量用连续 tick 算（`tickAtXExact`），落点再 `cellAtTick(...).start` 吸附。
这样从任何像素起手，放下去都正好压住格线。

**落到别人身上**：复用区间写入的裁剪规则（`trimAt`），不是「不许放」也不是「整条删除」。
被压到的那条会被截短或拆成两半，语义和「在这格里写入新和弦」完全一致。

**撤销**：仍然是整份事件快照（`replaceEvents`）。
逐条反做不可靠——裁剪会把一条拆成两条，反做要还原 id 与顺序，不如存快照。

**坑（踩过）**：冒烟里拖不动，原因是「拖动的命中检测读 `props.analysis.events`」，
而 `fill()` 之后 `emit('changed')` 的刷新是异步的。断言得等界面真的拿到那条事件再起手，
否则会被判成「按在空白处」→ 变成框选 → 事件当然不动。

---

### 决定 21（v0.5）：和弦解析失败**不猜**

**为什么**：解析器是给人看分析结果的。猜错一个 `V7/V` 比「标黄待修」的危害大得多——
前者会悄悄污染和声统计，后者只是一个待办。

**做法**：`parseChord()` 失败时返回 `ok:false` + `errors[]`，文本原样入库（`text` 列不变），
`parsed` 列存这份失败结果；界面上 `.warn-chip` 数出「待修」条数，选区条显示「无法解析「@@」」。

**两个已修正的坑**：
- 副属和弦的根音要**叠在被属化的那一级**上：`V7/V` 在 C 里是 D7（rootPc=2），不是 G7。
  一开始把 `appliedTo` 当装饰丢了，于是所有副属和弦都算成了本调属和弦。
- `m7b5` 的 `b5` 在数字**之后**才读到：先看到 `m` 记了减三，读到 `b5` 才补 `dim`，
  此时七度已记成 minor；不补正就会把半减七当成「减三 + 小七」。

**音高顺序**：转位后 `pcs` 从**低音往上堆**（`C/E` → E–G–C = `[4,7,0]`），
不是「低音塞到原顺序前面」。这是 `describeChord()` 显示的音序，也是人读和声时的实际音高顺序。

---

### 决定 22（v0.5）：没有本地音频时，用无头浏览器唤起网易云客户端

> **已替代（2026-11-15）**：以下仅记录历史实现，不再作为现行规则；隐藏网页抓取和任意数字串兜底
> 均已移除，改用经域名/歌曲路由校验后生成的 Base64 播放指令，见[决定 65](#netease-playback-20261115)。
> 网页回退也不保证能播放，不能沿用下文「任何一步失败都还能听到歌」的承诺。

**需求**：双击曲名要「能听」。有本地文件就播；没有但有网易云链接，就打开客户端播这一首。

**为什么不直接在渲染层拼 `orpheus://song/<id>`**：
1. 渲染层被 `contextIsolation` 关着，也不该有「打开外部程序」的能力；
2. 网易云网页版自己带「在客户端打开」的入口，页面结构会变，硬编码按钮位置不如让页面告诉我们。

**做法**（`main/ipc/netease.ts`）：
`show:false` 的 `BrowserWindow` 载入歌曲页 → `executeJavaScript` 找 `orpheus://` 链接
（或文本匹配「在客户端打开 / 打开客户端 / 客户端播放」）→ 用找到的 deep link 交给 `shell.openExternal`。
找不到就按歌曲 id 拼 `orpheus://song/<id>`；客户端没装（`openExternal` 抛错）则退回默认浏览器。

**兜底顺序**：页面上的链接 → 按 id 拼 → 浏览器打开。任何一步失败都还能听到歌，只是多一次跳转。

**找 id**：`?id=2603027640`、`/song/2603027640`、hash 里的 song id 三种形态都认，最后才退回「抓最长数字串」。

**测试**：冒烟会拦下真实唤起（`process.argv.includes('--smoke')` 时只把准备打开的 deep link 回给断言），
自动测试不该在用户机器上弹客户端或浏览器。

---

### 决定 23（v0.6）：canvas 只在尺寸真的变了时才重设 `width/height`

**症状**：Ctrl+滚轮缩放卡顿，播放头「过好久才动一下」。

**根因**：`draw()` 每次都写 `el.width = w * dpr`。给 canvas 的 width/height 赋值会让浏览器
**重新分配整块后备缓冲区**。这张网格宽 6496 CSS px、DPR=2 → 12992×534 物理像素 ≈ 27MB，
每画一帧就重建一次。再加上 `onWheel` 里同步 `draw()`（一次滚轮连来 6 个事件 = 6 次重建），
主线程被占满，rAF 里的播放头自然只能排队。

**做法**：
1. `canvasPxW/canvasPxH` 记住上次的像素尺寸，相同就跳过赋值（`perf.reallocs` 涨不涨一眼能看出来）；
2. 滚轮只 `syncCanvasSize()`（改 CSS 宽度，让滚动范围立刻对）+ `scheduleDraw()`，
   重绘交给 rAF 合并；
3. `watch(..., { deep: true })` 去掉 deep —— 它要递归遍历几百条事件建依赖，而事件改动本来就会换对象引用；
4. 主题色 `getComputedStyle` 缓存，由 `MutationObserver` 在 `data-theme/data-font` 变化时作废。

**验证**：同尺寸连画 3 次 → `reallocs` 增量 0；同帧派发 6 个 wheel 事件 → 只重绘 1 次；
单帧重绘 4.7–11ms。

**顺带**：`__ma.perf()` / `__ma.redraw()` 留在调试钩子里，下次再卡先看这两个数，别凭手感猜。

---

### 决定 24（v0.6）：随时间变化的东西一律不进 canvas

「已播放的波形亮一档」以前是画在 canvas 里的，而 canvas 只在状态变化时重绘。
结果播放时它一动不动，暂停或缩放一下才「突然追上来」——看起来就是「渲染不及时」。

现在是一个 `.wave-played` 的 DOM 层：宽度撑满全曲，每帧只改 `transform: scaleX(x / totalWidth)`。
只走合成，不触发布局，60fps 也不掉帧；播放期间 canvas 一次都不用重绘。

**同一个原则**：播放头本身也是 DOM（`translate3d`），不是画出来的。

> **修订（v0.6.3）**：`.wave-played` 这个全曲宽的 DOM 层已经删掉了。
> 它虽然解决了「不及时」，但它本身是一个**文档宽度的合成层**，播放时每帧 `scaleX`
> 要和视口 canvas 抢光栅线程 —— 两个需求叠加反而更卡。现在改用双层位图热层，
> 见决定 29。

---

### 决定 25（v0.6）：菜单栏自己画，但窗口按钮交给系统

**菜单为什么不用 Electron 原生 Menu**：原生菜单在 Windows 上是另一套系统样式，
和深/浅色主题、字号、间距都对不上，也没法显示「当前格单位」「面板是否打开」这类应用内勾选状态。
所以 `components/MenuBar.vue` 自己画下拉，交互对齐桌面软件：点开、悬停切换、点外部关闭、Esc 关闭。

**窗口按钮为什么反过来交给系统**：自绘的 `– □ ✕` 再像也不是真的 —— 高 DPI、贴边、颜色、
hover 效果都得自己模拟。改回 `titleBarStyle: 'hidden'` + `titleBarOverlay`，
Windows 会把原生的最小化/最大化/关闭叠到右上角，行为与系统完全一致。
代价：右上角约 138px 被占，菜单栏用 `.sysgap` 留出这块空位。
overlay 是系统画的，CSS 改不动它 —— 切主题时必须走 `win:overlay` IPC 调 `setTitleBarOverlay`。

**踩过的坑（会直接毁数据）**：Electron 默认应用菜单把 **Ctrl+R 绑成了重新加载页面**。
我们要用 Ctrl+R 登记作品，不摘掉默认菜单的话，一按就整页刷新，没保存的输入当场没了。
`Menu.setApplicationMenu(null)` 之后快捷键才真正落到渲染层。

---

### 决定 26（v0.6）：标签从两维拆成三维

**问题**：原来的 `technique` 一维装的全是**作曲技法**（模进、转调、模仿、配器），
而乐器的**演奏技法**（拨奏、花舌、弱音器、泛音）根本没地方放 —— 塞进 instrument 会把「乐器」和「怎么演奏」混为一谈，
塞进 technique 又和「怎么写曲子」混为一谈。

**现在**：

| dim | 中文 | 例子 |
|---|---|---|
| `instrument` | 乐器 | 长笛、大提琴、琵琶 |
| `instrument_technique` | 乐器演奏技法 | pizzicato 拨奏、flutter tongue 花舌、con sordino 加弱音器 |
| `composition` | 作曲技法 | sequence 模进、modulation 转调、imitation 模仿 |

`technique.json` → `composition.json`（dim 一起改），新增 `instrument_technique.json`（按乐器族分六个根）。
迁移走 `003_dim_split.sql`：`tag.dim` 直接改名，`tag_alias` 先搬后删（它的主键是 `(alias, dim)`，直接 UPDATE 会撞键）。

**为什么不是「乐器下面挂子技法」**：同一技法会跨乐器（滑音在小提琴是 glissando、在键盘是刮奏），
做成树会逼你复制条目；做成平级维度 + 各自别名反而干净。

---

### 决定 27（v0.6）：网易云的 deep link 必须带 `autoplay=1`

> **结论已纠正（2026-11-15）**：本次 Windows 客户端实测，`song/<id>/?autoplay=1` 能唤起应用，
> 却没有切歌或开始播放；原冒烟只验证了准备打开的字符串，不能证明第三方客户端支持该格式。
> 当前采用官网的 Base64 JSON `cmd: "play"` 指令，见[决定 65](#netease-playback-20261115)；以下保留为踩坑记录。

只发 `orpheus://song/<id>` 时，客户端只会跳到这首歌的详情页，**不会开始播放** ——
这正是「双击了，界面也跳了，就是没声音」的原因。

社区（NFC 一键播歌那套方案）验证过的形态是 `orpheus://song/<id>/?autoplay=1`。
所以现在有 id 就直接拼这个，不再优先从网页上扒链接（网页版「在客户端打开」给的往往不带 autoplay）；
页面发现只作为「没抠出 id」时的兜底，捡到的链接也统一补上 autoplay 参数。

**冒烟**：`--smoke` 时不真的唤起外部程序，把准备打开的 deep link 放进 note 供断言核对。

---

### 决定 28（v0.6.1）：单实例 + 启动日志，让「双击没反应」变成可诊断

**症状**：双击 `start.cmd` 没有窗口，也没有任何报错。进程表里却堆了 35 个 `electron.exe`。

**查出三件事，每一件单独都能造成「看起来没启动」**：

1. **没有单实例锁**。点 7 次 = 7 个实例、7 个窗口，全都开在同一个位置叠在一起，
   每个还各握一份 SQLite 连接。点哪都不是当前那个，自然像「点了没反应」。
   → `app.requestSingleInstanceLock()`，后来者直接退出并把已有窗口 `restore/show/focus`。
   注意必须在 `whenReady` 之前拿，且 `whenReady` 回调里要有 `if (!gotLock) return`，
   否则第二实例虽然 quit 了，回调照样会执行并开窗。

2. **`start` 把进程甩到后台，失败信息没人接**。`start ""` 一返回，脚本就结束，
   cmd 窗口随即关闭 —— stderr 写到一个已经不存在的控制台里。这就是「没有报错」的由来。
   → 主进程写 `logs/boot.log`（追加、带 pid），记录 `lock / createWindow / did-finish-load /
   ready-to-show / show / bounds`；`uncaughtException` 与 `unhandledRejection` 也落盘。

3. **`ready-to-show` 不来，窗口就永远是 `show:false`**。页面加载失败时这个事件不触发，
   于是进程活着、界面永远藏着 —— 最像「没启动」的一种失败。
   → 加 2.5 秒兜底：还没显示就强制 `show()`，并记一行 `fallback show`。

**start.cmd 也跟着改**：
- 启动前有旧实例就只负责「抬到前台」，不删日志、不做健康检查；
- 冷启动时先删 `logs/boot.log`，`start` 之后等约 3 秒，用 `findstr` 找 `shown visible=true`；
  找不到就 `type logs/boot.log` 再 `pause`，让错误停在一个不会自动关闭的窗口里。

**坑（真实踩到）**：脚本里原本写 `tasklist | find /i "electron.exe"`。
从 Git Bash / 编辑器终端启动时，PATH 里的 MSYS 工具排在 System32 前面，
`find` 解析成 **GNU find**，报 `find: '/i/System Volume Information': Permission denied`，
脚本于是把「窗口已经正常显示」误判成启动失败。
→ 所有系统工具都写绝对路径：`%SystemRoot%\System32\{findstr,tasklist,ping}.exe`。

**冒烟也跟着修**：`tools/smoke.mjs` 启动前先 `taskkill /F /IM electron.exe`。
否则已有实例时，冒烟进程拿不到锁会立刻退出 —— 看起来「一秒跑完、全绿」，其实一条断言都没执行。

### 决定 29（v0.6.3）：canvas 只画视口，尺寸与文档长度彻底脱钩

**背景**：缩放卡顿 + 播放卡顿，用户判断是「两个需求叠加互相影响」。查下来确实如此，
但根因只有一个：canvas 宽度等于**文档总宽**（`totalBars × 56 × zoom`）。
zoom=4、两百小节时是 4 万多 CSS px，DPR=2 下近 9 万 px —— 既逼近 Chromium 32767px
单边上限，又让「缩放」变成「重画全曲几万条线」。再加上全曲宽的 `.wave-played` 合成层，
播放时两个超大对象一起抢光栅线程。

**做法**（对齐 TallyDeck 的架构）：
- canvas 只有**视口大小**（约 1700×600），用 `position: sticky` 钉在可视区；
  滚动范围交给 spacer div 撑出。绘制量只跟「视口里能看到多少」有关，与文档总长无关。
- 绘制时 `ctx.setTransform(dpr, 0, 0, dpr, -viewLeft*dpr, -viewTop*dpr)`，
  之后全部用**文档坐标**画，canvas 自己裁掉视口外部分。
- 「已播放变深」改成**双层离屏位图**（底 = 低透明度波形，热 = 高不透明度波形）。
  两层只在「视图/尺寸/主题/波形数据」变化时重建（用一个字符串 key 比对），
  播放中每帧只做 `clearRect + drawImage(底) + clip + drawImage(热)`。
  这是波形**本身**变深，不是盖一块半透明色块 —— 色块会把峰值尖端糊掉。
- 播放头仍是 DOM `translate3d`；帧回调只碰 DOM/canvas，**不改响应式状态**
  （否则 60fps 会让整个网格组件 diff 一遍）。

**坑（sticky 三个必踩）**：
1. `sticky` 的约束范围是**最近的滚动祖先的内容盒**。sticky 元素若直接放在 `.scroll` 下，
   滚过一个视口宽就被带走 —— 必须放进 spacer **里面**。
2. `.scroll` 已有 `padding-left: 64px`（给固定泳道标签留位）时，sticky 的 `left` 是相对
   内容盒的，再写 `left: 64px` 会变成 128px 双份偏移 → 写 `left: 0`。
3. canvas 钉住后 `getBoundingClientRect()` 不再随内容移动，指针坐标换算必须手动加回
   `scrollLeft`；反之，冒烟里算「某 tick 在屏幕上的 x」要减掉 `viewLeft`。

**验收**（全部是计数器/像素断言，不看体感）：
- 同尺寸连画 3 次，`reallocs` 增量 = 0；
- 同帧连发 6 个 wheel，`draws` 增量 = 1；
- 播放 500ms，`hotBlits` > 20 且 `draws` ≤ 3（播放不驱动整网重绘）；
- 播放头两侧采样比色，确认是**加深**而非色块，且 `.wave-played` 已不存在；
- 滚动前后 `canvas.left - scroller.left` 恒为 64（钉住）。

冒烟 **53 → 56 条**全绿。经验沉淀为独立 skill `canvas-perf`（与 `win-electron-gotchas`
分家：那个管启动，这个管渲染性能）。

### 决定 30（v0.7）：菜单学 Windows 软件，网格行高跟字号走

**菜单栏的结构**：以前只有一条 32px 的菜单行，现在拆成「标题行 + 菜单行」两层，
对齐 Everything / VS Code 这类 Windows 软件：上面写项目名（左侧一个小标记），
下面才是菜单。标题行高度定成 **32px**，正好等于主进程 `titleBarOverlay.height` ——
系统原生的最小化/最大化/关闭就落在这一行里，不会压到菜单。

**助记符**：中文 Windows 软件写「文件(F)」，西文不写。所以 `MenuGroup` 加 `mnemonic`，
由 `MenuBar` 按 `lang` 决定要不要拼括号；同时支持 `Alt+字母` 直接展开对应菜单。
语言开关留在 `App.uiLang`，界面文案暂时只发中文，但括号这一层已经按语言分叉了。

**菜单项调整**：
- 「网格」整项去掉 —— 格单位（小节/拍/半拍）和「独立窗口打开」都是视图行为，并进「视图」。
- 新增「维护(M)」：孤儿报告、打开 data 目录。这类低频但危险的动作不该混在「文件」里。
- 「选项(O)」不再是下拉：点一下直接进选项面板（原来的「首选项…」子菜单是多余的一层），
  面板标题也一并改叫「选项」。

**网格行高**：行高不再「按比例撑满可视高度」，而是 **和弦字号 × 1.3**（12.5 → 16px），
JSON 里的 `height` 只当相对权重（和弦行比备注行高一点）。两个原因：
1. 撑满会让内容永远比容器高一点，右边那条竖直滚动条拖多大都消不掉；
2. 字号是读谱的基本单位，行高跟字号走，缩放/换字体才不会错位。

**滚动条消不掉的两个真因**（都不是猜的，是量出来的）：
- `target = min(hostH - headH, baseSum*2.8)` 之后逐条 `Math.round`，取整误差累计几像素，
  内容就永远比容器高一点 → 改成固定行高，不再对齐 hostH，误差源消失。
- **横向滚动条会吃掉 10px 高度**。spacer 高度按 `hostH` 撑，一出现横向滚动条，
  竖直方向正好差 10px，于是竖直滚动条又被触发 —— 两个滚动条互相喂。
  改成 `viewH = hostH - (有横向滚动条 ? 10 : 0)`，竖直溢出归零。
- 深色模式右下角那个「方形小白点」是 `::-webkit-scrollbar-corner`，没设背景就用它自己的
  白色。补 `background: transparent`。

**交互**：
- **拖边缘改时值**：命中阈值 7px，且随块宽收窄（`min(7, max(3, w*0.28))`）——
  一拍在 zoom=1 时只有 14px 宽，固定 7px 会把中间全吃掉，结果「想移动」永远判成「想拉伸」。
  光标 `col-resize`，拖动时画半透明预览，松手才 `writeRange`（自动裁掉被压住的邻居）。
- **Alt+←→ 改一格**：无 Shift 往外扩、有 Shift 往回缩，单位跟当前格尺度走（小节 1440 / 拍 480）。
  `preventDefault` 必须在「有没有选区」之前，否则没有选区时 Alt+← 会触发浏览器后退。
- **Alt+拖动 = 复制**：`writeRange` 在落点写一份，原事件不动；被压住的邻居照样被裁。

冒烟 **56 → 67 条**。新增：菜单 7 项与助记符、标题行高度、选项直开、维护子项、
英文模式不带括号、行高 16 与竖直溢出为 0、边缘判定三点、拖边缘 +480、Alt+←→ ±480、
Alt 拖动复制后原事件仍在。

**顺带修掉的稳定性问题（冒烟偶发全红）**：有一轮冒烟突然 5 条渲染/播放断言一起失败
（`draws: 0`、`hotBlits: 0`、切主题像素不变、播放不推进），重跑又好。原因是
`backgroundThrottling` 默认 `true`：窗口一旦被别的窗口压住，Chromium 会把 rAF 降到 1fps
甚至掐掉，整条渲染链静默停摆。播放器在后台本来就该继续出声、继续推进播放头，
所以两个窗口都改成 `backgroundThrottling: false`。这条也解释了「为什么有时看着像代码坏了」。

---

### 决定 31（v0.8）：增益按真实 dB 映射，搜索框下放进中间列

**音量推子不是装饰刻度，是真 dB**。用户要的是「拉满是 0dB，往下是负增益，拉到底是 -inf」，
这正是调音台的增益刻度。实现上把**推子位置直接当线性幅度**用：

| 位置 | 幅度 | 读数 |
| --- | --- | --- |
| 1.00 | 1.0 | `0.0 dB` |
| 0.50 | 0.5 | `-6.0 dB` |
| 0.10 | 0.1 | `-20.0 dB` |
| 0.00 | 0 | `-∞ dB` |

`HTMLAudioElement.volume` 吃的就是 0~1 的线性幅度，所以位置可以直接喂给 `el.volume`，
中间不需要任何换算层 —— 读数用 `20·log10(gain)` 算出来只为显示。
`gainToDb()` 对 `gain <= 0` 返回 `-Infinity`，UI 侧再翻译成 `-∞ dB`（`Number.isFinite` 判断）。
双击推子回满格（0 dB），这是调音台的惯例；增益写 `localStorage['ma-gain']`，
下次启动 `restoreGain()` 读回。

> 为什么不用「对数量刻度 + 再反算线性」那种写法：多一层反算就多一个能被写成
> `log` 底数错/钳位错的地方，而且拖动手感和读数会各错一处，排查时很难看出来。
> 位置即幅度，只有一个真值。

**顶栏与菜单栏不再有分隔线**：`.titlebar` 去掉 `border-bottom`，`.menubar` 的
`padding-left` 从 6px 改成 0 —— 第一项菜单的左缘直接贴齐，不再有一段说不清来历的空白。
两行的区分靠背景深浅和字号，不靠线。

**侧边栏做出「凸起」**：要跟网格面板的层叠关系对上，靠三件套而不是一条粗边：
- `border-right: 1px solid var(--line-strong)` —— 硬边界；
- `box-shadow: inset -1px 0 0 var(--raise-hi)` —— 右缘一道高光，像被光打到；
- `box-shadow: ..., var(--raise-shadow)` —— 向外贴边投影（深色 `3px 0 10px -6px rgba(0,0,0,.6)`，
  浅色 `3px 0 8px -5px rgba(0,0,0,.14)`）；
- `z-index: 2` —— 投影必须压在中间内容之上，否则投到自己底下等于没有。

**搜索框从通栏改成中间列顶部**：以前 `.shell` 是五行栅格
（标题 / 菜单 / 搜索 / 内容 / 状态），搜索横贯整个宽度。现在把它移进 `.main` 内部开头，
和表格、网格同宽，侧边栏因此从顶栏一直贯通到状态栏 —— 这样「侧边栏是一层板、中间是另一层」
的视觉关系才成立。`.shell` 变四行：`62px 1fr 40px 24px`。
`maxPanelH()` 扣除的高度不变（搜索行还在中间列里占 34px，只是换了父元素）。

冒烟 **67 → 74 条**。新增：标题/菜单行无分隔线且首项贴左、搜索框与 `.main` 等宽且左缘紧接侧栏、
侧边栏有投影+右边界+z-index≥2、推子满格 `0.0 dB`、一半 `-6.0 dB`、到底 `-∞ dB`、双击回 `0.0 dB`。

**两个坑（都是断言先红才发现的）**：
- 增益是持久化的，跑断言时初始值不一定是满格 —— 断言前先双击归零再拖。
- 改响应式 `state.gain` 后立刻读 `.gain-db` 的 `textContent` 读到的是**上一帧**；
  Vue 下一个 tick 才更新 DOM。`dragFader` 必须 `await wait(90)` 之后才读。

---

### 决定 32（v0.9）：i18n 自己写，词典是唯一来源

**为什么不引 vue-i18n**：这里需要的只有三件事 —— 按 key 取字符串、`{占位符}`、切语言后重渲染。
vue-i18n 带进 40+ KB 和一套 SFC/插件装配，而主进程（窗口标题、文件对话框、网易云提示）
也要发同一批文案，那边还得另外配一份实例。自己写一个纯 JS 模块反而两边都能 import，
测试也能用 `node --test` 跑。

**结构**
- `src/shared/i18n.js` —— 平铺点分键（`menu.file.register`）的两张表 + `t(locale, key, vars)`。
  不开嵌套对象：查找 O(1)，漏键时报出来是一行能直接 grep 的字符串。
- `src/renderer/src/i18n.ts` —— `locale` ref（`localStorage['ma-lang']`，首次按
  `navigator.languages` 猜）、`t()`、`tn()`（带数量的写法）、`setLocale()`。
  组件里 `import { t }` 就能用：`t` 在模板里被调用时会读 `locale.value`，
  Vue 自动把它记成依赖，语言一变所有用过它的地方一起重渲染 —— 不用给每处文案套 computed。
- `src/main/locale.ts` —— 主进程这一侧的当前语言。渲染层读不到主进程状态，
  主进程也读不到渲染层的 localStorage，所以由界面在启动/切语言时通过
  `app:set-locale` 推一次，主进程只记住，不猜第二遍。

**三条硬约束（都由 `tests/i18n.test.mjs` 保证）**
1. 两个语言的**键集必须一致**（`.one/.other` 折回基键比较）；
2. **英文词典里不许出现汉字** —— 漏翻的中文不能静默混进英文界面；
3. 缺键回落到中文，再缺就返回键名本身：宁可露出中文或 key，也不要露出空白。

**单复数**：英文 `{key}.one` / `{key}.other`，`t()` 收到数字 `n` 时先试变体、没有就退回基键。
中文没有复数，只写基键即可（所以键集比较要折叠这两个后缀）。

**哪些字符串不能存「拼好的句子」**：状态栏提示、音频错误、网格撤销栈的动作名，
全部改成 `{ key, vars }`，渲染时才翻。原因是它们会在界面上停留很久（撤销栈甚至一直留着），
拼接时定格的语言，切完语言就变成「外语夹中文」。
变量值允许再嵌一层 `{ key, vars }`（`唤起失败：<原因>` 里的原因），渲染时逐层解开；
主进程的网易云结果因此同时返回 `note`（给人读的句子，日志/冒烟用）和 `noteKey`/`noteVars`（给界面重翻）。

**内容不翻，界面才翻**：曲名、标签名（中钢琴/拨奏/模进）、情绪枚举、段落名都是**数据**。
情绪词在中文界面才加一层对照（`神秘 mysterious`），英文界面直接显示原值 —— 它本来就是英文。
和弦解析器的 `errors` 是写进 `analysis_event.parsed` 的**数据**，也不跟语言走；
跟语言走的只有 `describeChord()` 这种纯展示描述。

**其它**
- 菜单助记符：括号只在中文界面显示（`文件(F)` vs `File`），但 **Alt+字母两种语言都能用** ——
  以前 `onAltKey` 里有一句 `lang !== 'zh' 就 return`，那是把「不显示」错当成了「不生效」，已去掉。
- `<html lang>` 跟着切（`zh-CN` / `en`），字体回退与断行规则都吃这个。
- 画布里也有字（波形未就绪 / 音频与网格未重叠）：canvas 不会因为 Vue 重渲染而重绘，
  所以 `watch(locale, () => scheduleDraw())`。
- 词表页面的时期/调式：`periodLabel(id, locale)` 走表里的 `labelEn`，默认仍是中文（老调用点与测试不用改）。

冒烟 **74 → 78 条**。新增：选项面板里的语言按钮真的能点（点 English → 菜单/面板标题/说明都变英文，
点中文 → 还原）、英文菜单是 File/Edit/…、侧栏/表头/详情标题/搜索框一起换且**不含任何汉字**、
状态栏单复数与 `<html lang>`、切回中文全部还原。
单元测试 **48 → 63 条**（词典键集、英文无汉字、回落、单复数、语言识别、时期/调式的英文标签、
和弦描述的英文整句）。冒烟开始时强制 `lang('zh')`：语言是持久化的，上一轮崩在英文会让中文断言全红。

---

### 决定 33（v0.9.1）：多词搜索按「词间 AND、字段间 OR」

**原来的错法**：整句当成一个 LIKE —— `%钢片琴 低音提琴%`。
这等于要求两个词在**同一个字段里连续出现**。而「钢片琴」「低音提琴」是曲目的两个
不同标签行，永远不可能出现在同一行，于是越精确的搜索越搜不到。
`神 低音` 同理：`神` 在曲名、`低音` 在标签，整句匹配必然空。

**现在的结构**：`splitTerms()` 按空格切词，每个词生成一组条件：

- 组内 **OR** —— 曲名 / 作曲 / 演奏 / 专辑 / 备注 / 时期 / 体裁 / 标签名与别名 / 调性 marker / FTS 任一命中；
- 组间 **AND** —— 每个词都必须有着落。

这套语义和用户的直觉一致：多写一个词是**收窄**，不是换一个搜索。

**为什么时期/调性也要按词展开**：`expandQuery()` 如果对整句展开，再 OR 到最外层，
`浪漫 钢琴` 会把所有浪漫主义曲目都捞回来（钢琴那个条件等于失效）。
现在展开放在**本词的条件组里**，`浪漫` 组带 `period IN ('romantic')`，`钢琴` 组只认文本。

**带空格的调式名不拆**：`natural minor` / `whole tone` / `middle ages` 在分词时按整词保留。
否则 `natural` `minor` 各成一组，`minor` 会命中所有小调 —— 比不拆还糟。
（当前词表里的短语最长两个词，所以只做相邻两词合并。）

**验收**（`npm run smoke`，81 条）：
- `钢片琴 低音提琴` → 只有「神鹿谣」（两个乐器标签分别命中）；
- `神 低音` → 含「神鹿谣」（`神` 走曲名、`低音` 走标签）。这条会带出「灰ト祈リ」，
  因为它的简介里有「神秘」——文本命中就是命中，不做二次打分；
- `钢片琴 大号` → 空（AND 语义成立）。

### 另外两处（v0.9.1）

**顶栏更紧凑**：标题行 32 → 28、菜单行 30 → 26（`titleBarOverlay.height` 同步 28，
否则系统按钮会跑到标题行下面）。项目名与菜单文字之间的空白 19px → 11px。
`App.vue` 的 `.shell` 四行栅格 62 → 54，`maxPanelH()` 同步扣 54。
新增断言直接量**文字墨迹盒**（`Range.getBoundingClientRect()`）之间的距离，
不量按钮盒 —— 按钮是满行高的，量它会得出「间距 5px」这种没意义的值。

**Home / ■ 也把视窗带回开头**：以前只把 `currentMs` 归零，视图停在两分钟处，
播放头确实回去了但人看不见，看着就像按钮没反应。
音频层加了一个 `rewindSeq` 计数器（`stop()` 里自增），网格 watch 它 → `setScrollLeft(0)`。
刻意不 watch `currentMs`（每帧都变），也不看 `follow` 开关：
按 Home 是明确要看开头，不该被一个显示偏好挡住。
只滚横向，纵向不动 —— 时间轴是横向的，泳道位置没必要跟着跳。

---

### 决定 34（v0.9.2）：情绪也参与搜索，顶栏再收 4px

**为什么「怀旧」「亲密」搜不到**

这两个词是「おとなの掟」的情绪标签，存在 `track.extra.moods` 里，值是**英文枚举**
`["nostalgic","intimate"]`。而搜索只查了 `title / composer / performer / album / notes /
period / genre` + 标签表 + 调性 marker + FTS，`extra` 一个字都没碰。
所以搜中文「怀旧」必然空；**搜英文 `nostalgic` 一样空**（FTS 只索引 title/composer/
performer/album/notes，不含 extra）。界面上却写着「怀旧 nostalgic」，看起来就像数据丢了。

**两层修法**

1. **中文 → 枚举**：`search.js` 新增 `MOODS`，但**不另抄一份对照表**——
   直接从 `DICT.zh` 里筛 `mood.*` 的键推导（`id / label / labelEn / terms`）。
   词典里已经有 `mood.nostalgic: 怀旧`，界面显示用它，搜索也用它，二者不可能再漂移。
   以后加一个情绪只改 i18n，搜索自动认中文。
2. **SQL 只比数组元素**：`json_each(t.extra, '$.moods')` 里 `je.value IN (...)`，
   而不是对整坨 JSON 做 LIKE —— 后者会被 `"moods"` 这个**键名**命中，
   也会把别处的巧合字符串算进来。

顺带把 `extra` 整体接进搜索，但用 `json_tree(t.extra)` 且只取 `type='text'`：
别名（成人法则 / Otona no Okite）、副标题、制作名单、备注都能搜到，
而 `moods`、`source`、`credits` 这些**键名**不会变成命中词
（否则搜 "source" 会把每条曲目都捞出来）。别名的搜法因此也一起修好了 ——
之前「成人法则」同样是搜不到的。

**顶栏再收紧**

标题行 26（`padding-top: 4px`，让项目名与菜单成为一组、而不是贴着窗口按钮）、
菜单行 24，合计 50px（上一版 52、再上一版 62）。项目名与菜单之间的**墨迹空白 13 → 7px**。

这里踩到一个断言口径的坑：老断言量的是 `.appname` 的**行盒**底边与菜单的**墨迹**顶边。
给 `.appname` 加 `line-height: 1` 会把行盒压到贴着墨迹，读数反而变大 —— 也就是说
这条断言能被「改行高」骗过，而眼睛看到的一点没变。现在**两边都用 `Range` 量墨迹**，
再去调版式，数字才有意义。

**验收**：`npm test` 68（+2 条情绪用例：中文标签 → 枚举、词典里每个 `mood.*` 都可搜）；
`npm run smoke` 84（+3 条：怀旧/亲密/nostalgic 各自命中「おとなの掟」且不误伤、
情绪参与 AND、别名可搜），并留 `shots/smoke-search-mood.png`。

---

### 决定 35（v0.10）：详情面板改成「固定模块清单 + 按曲目显隐」

**为什么不统一成一套结构**

神鹿谣有五段调性、九条段落、十件乐器；灰ト祈リ 一个调性都没写。强行套同一副骨架只会到处是「—」，
而每首曲目真正需要看的块本来就不一样。所以：**模块清单固定**（顺序、样式统一），
**每首曲目自己决定显示哪些块**。

- 右键详情面板的**空白处** → 弹出模块菜单（11 项，勾选状态），点一项即开关；底部「全部显示」一键复原。
- 状态按 `trackId` 存 `localStorage['ma-detail-hidden'] = { [trackId]: string[] }`。
  不写库：这是**看图偏好**，不是档案内容；换机器/换人看同一份档案不该被别人的偏好影响。
- 只认「空白处」：按钮 / 输入框 / 标签 / 表格 / 标题处不抢右键（以后标签右键要留位置）。

**版式**

- 所有行改成 `标签：值` 的左对齐（原来是 label 左、值右对齐的 space-between）。
  右对齐时长值会把 label 挤到换行；值自己又是逐字可断，于是 `f natural minor` 被拆成
  `f` / `natural minor`。现在 label `white-space: nowrap`、值紧跟其后。
- **冒号由 CSS 生成**（`.k::after`），中文全角 `：`、英文半角 `: `，词典里不必为标点维护两套文案。
- 调性是一串 `c dorian → c natural minor → …`：每个调名 `.key-item { white-space: nowrap }`，
  容器 `flex-wrap` —— 放不下就**整组**换行，绝不从调名中间断开。
- 标题下不再标源语言（`titleLang` 只用于列表的语言角标）；时期单独一行、显示中文规范名。

**结构顺序**（自上而下）

标题 → 附注 → 时期 → 别名 → 情绪 → 拍号/速度 → 调性 → 制作/发行 →
**作曲技法 → 乐器组合** → 时间轴 → 音源 → 音频对齐

- 删掉「段落 / 标签」行（段落数/标签数没有决策价值，表格里已有实际段落）。
- 作曲技法上移到乐器之前：先说怎么写，再说谁在演奏。
- 音源（本地音频绑定 / 网易云）下移到底部，乐器与技法才是档案主体。
- 乐器组合（Instrumentation）分三层：**摘要**（`extra.instrumentationAbstract`，
  一句话说编制，如 `Orchestra + Soprano Solo`）+ **乐器** + **演奏技法**。
  摘要单独成字段，因为标签答不了「整体听起来是什么编制」。
- 拍号英文改为 `Time signature / tempo`。

**新曲目 + 词表**

按 `assets/夜莺唱片／十音 - The deepest nightmare of Sibyl（希贝尔最深的梦魇）.md` 登记
`data/tracks/The deepest nightmare of Sibyl.json`，音频沿用 `timeline.audioPath` → assets 的 flac
（与灰ト祈リ 同一套做法）。词表补 4 条演奏法：`general` 根下连奏 / 断奏 / 滚奏，
`voice` 根下舌尖颤音（alveolar trill）。`legato` 这个名字已被弦乐的连弓（legato bowing）占用，
所以通用连奏的 id 取 `legato-art`、name 写 `legato (articulation)`，避免别名索引互相覆盖。
情绪补 nervous / tragic / heroic（i18n 的 `mood.*`，`MOODS` 表由词典推导，搜索自动认得中文）。

**验收**：`npm test` 68、`npm run smoke` **92**（+8：结构顺序、调性左对齐/不拆词、
标题不标源语言、右键菜单、按曲目记忆、全部显示、新曲目入库、乐器组合渲染）。

---

### 决定 36（v0.11）：详情字段双击就地编辑 + Tonicization 改译「主音化」

**为什么双击**

详情面板首先是**读**的地方。常驻输入框能把 15px 的标题、五段调性链、六项制作名单
压成一张表单，视觉重心全跑到框线上。「双击某个值」是明确的「我要改这一项」，
改完就回到只读，版式不跳。空值显示淡色的「未标注」，双击即可录入 ——
新登记的曲目没有副标题 / 别名 / 制作名单时，也有地方填。

**能改哪些**（`TrackPatch`，见 `shared/types.ts`）

标题 / 附注 / 时期 / 别名 / 情绪 / 拍号 / 速度 / 调性链 / 乐器组合摘要 / 制作名单。

分析标记、事件、标签绑定各有自己的接口与撤销语义，不从这里过。

**写库语义**

- 标题：`title_sort` 与 `analysis.title` 是冗余副本，一起改。
- `period` 存规范值（`romantic`），中文写法由渲染层先用 `PERIODS` 翻回 id；
  认不出就拒绝并提示，不把「浪漫主义」原样塞进列里 —— 那会让 `periodLabel` 和搜索都失效。
- 情绪统一小写英文枚举，中文由 `MOODS` 翻（和搜索用的是同一张表）。
- 拍号 / 速度只动 **tick 0** 那条；复用 `setMarkers` 整组重写而不是手写 UPDATE，
  因为它负责重算 `start_bar` —— 只改 num/den 不管 start_bar，时间轴会错位。
- 调性链按顺序写回已有的 key marker，**tick 不动**：详情里改调性是「这条写错了」，
  不是「这里换调了」；跟着挪 tick 会把时间轴上的转调位置也搬走。
  条数变多时按小节往后追加、变少时截掉尾巴。
- 空值**删 extra 键**而不是留 `null` / 空串：搜索用 `json_tree` 遍历文本值，
  一堆空串只会让它多做无用功。

**顺手修掉的一个真 bug**

`softDeleteTrack` 原来只软删 `track`，不动 `analysis`。库里所有查询都按
`analysis.deleted_at IS NULL` 过滤，于是删掉的曲目，它的调性还会被
「自然小调」「dorian」之类搜索数进期望值里（冒烟里表现为 5 ≠ 3）。
现在两行一起标记删除。

**译名**

`tonicization` 的 display 由「副属化」改为 **「主音化」**；
「副属化 / 副属和弦 / 离调」作为旧译与别名保留，搜索仍然认。
`data/tracks/The deepest nightmare of Sibyl.json` 的 description 同步改。

**验收**：`npm test` 68、`npm run smoke` **96**（+4：双击编辑全字段落库、Esc 取消不写库、拍号/速度同步 marker、Tonicization 译名）。

---

### 决定 37（v0.11.1）：文档长度按音频时长撑开

**症状**：Sibyl 播到最后，波形在半截处断掉、播放头也不见了。

**根因**：`GridEditor` 的 `totalBars` 只由「最后一个段落 + 10 小节」推出，下限 48。
Sibyl 的档案里**没有登记段落**，于是网格恒为 48 小节 = 88.6s（130 BPM、4/4），
而这段录音有 95s —— 最后 6 秒根本没有格子可画：
- 波形只能画到 48 小节那一列，右边直接空白，看着像断了；
- 播放头 `xOfTick` 落到文档宽度之外，`followIfNeeded` 又被 `scrollLeft` 上限卡住，
  于是播放头跑出右边界、`opacity` 归 0。

神鹿谣更夸张：录音 3:06，网格只有 48 小节（约 80s），一直只画了前 2/3 的波形，
只是它段落密集、平时没人拉到最右边，所以没被注意到。

**改法**：`totalBars` 取四个来源的最大值 ——

1. 最后一个段落 + 10 小节（段落之后要留可写白，行为不变）；
2. 所有 marker 的最远 tick（调性/拍号/速度标记本身也要看得见）；
3. 所有事件的最远 `tick + durTicks`；
4. **音频时长** →（按当前速度表）tick → 小节，再留 1 小节尾巴。

音频这条用 `tickOfAudioMs()` 走速度表反算，不是拿平均 BPM 除 —— 变速度的曲子
在曲末会差出好几秒。`durationMs` 同时加进波形 watch 的依赖里，解码校正后重算可画范围。

**顺带**：`__ma.docEndMs()` / `__ma.docBars()` 暴露给冒烟，
用于断言「文档画到的那一毫秒 ≥ 音频总长」。这条比看截图可靠 ——
截图上「波形没了」和「音乐本来就没声」长得一样。

**验收**：`npm test` 68、`npm run smoke` **98**（+2：曲末可画、曲末播放头仍在视野内）。

---

### 决定 38（v0.12）：补全的键盘语义、搜索补全走词表、原点改动先确认

**顶栏：项目标记与菜单文字同一条竖线**

`.titlebar` 的左内边距从 12px 收到 **9px**，正好等于菜单项自己的 `padding-left`。
两边都是「文字/图形从哪里开始」的同一个数，标记和「文件(F)」才落在一根竖线上；
继续用 12px 的话，两行各自看起来都对，凑在一起就是错开 3px。

**「清除」常亮**

删掉 `:disabled="!text && !filterTags.length"` 与 `.sr-btn:disabled { opacity: .4 }`。
一个常驻动作只在有内容时才亮，等于给按钮加了一层「现在能不能按」的猜谜；
而且空着按下去也无害（本来就是空表）。少一个状态，少一条样式分支。

**「以播放头为原点」先确认**

这个键紧挨着 ±10ms，点歪就会把整条对齐整体平移，而 `audio_offset_ms` 没有撤销。
现在点它先弹 `ConfirmDialog`：标题说明后果，正文给出 `from → to` 的具体位置，
默认焦点在确认键上。Esc / 点遮罩 = 取消，**库里一个字节都不动**；
框开着时空格也被挡住（模态不该让背景快捷键偷偷生效）。

**补全：两处统一「↑↓ 选 / Enter 确认 / Esc 收起」**

- 详情里的标签输入（`TagPicker`）：候选 + 「新建」共 N+1 行，↑↓ 循环移动，Enter 取光标那一行。
  默认停在第一项 —— 敲完直接回车 = 就选它，方向键才是去挑别的。
- 搜索框：新增 IPC `search:suggest`，候选来自**词表**（乐器 / 演奏技法 / 作曲技法）+ 情绪 + 时期。
  补的是**正在敲的那个词**（最后一个空格之后），不是整句：搜索是词之间 AND，
  整句替换会把前面写好的条件一起毁掉。回填后自动补一个空格，接着敲下一个词很顺。
- `insert` 用**实际命中的那个写法**（中文 display / 英文 name / 别名），
  不是一律回填 display —— 否则英文界面里会塞进一串汉字。
- 候选只在输入框真的持有焦点时弹（`document.activeElement !== input` 就不弹），
  菜单「清除」或程序设值不会在表格上莫名浮出一层。
- 同一个词在多个词根下各有一条（转调 → melodic / harmonic），按 `kind + label` 去重。

**冒烟**（+5）：标记与菜单文字对齐、清除按钮常亮、补全候选与键盘选中回填、
下拉不压「清除」、原点确认（弹框 / Esc 不改库 / 确认才写库）。
顺手修了两处测试卫生：临时曲目物理删掉后补一次 `refresh()`（否则截图里留着幽灵行）；
Ctrl+R 登记的那条草稿在**创建时就记下 id**，改名失败也能清掉，不再往真实曲库里丢「未命名作品」。

**验收**：`npm test` 68、`npm run smoke` **107**。

---

### 决定 39（v0.13）：词表图形编辑器、虚构测试数据、拖边缘收缩不再切开

**词表编辑器：JSON 是源，界面只改内容**

侧栏「词表」那一块原来是三个只读计数行。现在每一行都是入口，点开是
`VocabEditor`：左边分组、中间条目表、右边表单（显示名 / 原名 / id / 所属分组 /
别名 / 外语翻译 / 引用数）。右上角「打开 JSON 文件」用系统默认程序打开源文件，
留给维护人员；普通用户不需要知道文件在哪。

写回路径只有一条：界面把**整棵 roots 树**发给 `vocab:save`，主进程

1. 逐节点校验（id 形如 `^[a-z0-9][a-z0-9._-]*$`、name 非空、aliases 必须是字符串数组、
   translations 必须是「语言 → 译名」、嵌套 ≤ 4 层）；
2. 规范化（只留认识的键，别名去重，译名统一成映射）；
3. 检查删除项是否还有曲目引用 —— **有引用就整次拒绝**，不写文件也不动库；
4. 写 JSON → 清掉未被引用的 tag → `loadVocab` 重载 → `syncVocab`。

失败时一个字节都不落盘。这样「用户把中文贴进 id」「把 aliases 写成字符串」
最多是保存被拒并给出具体条目，不会把文件写坏。

**DAG 是设计，不是重复**

词表里 `modulation` 同时挂在旋律技法与和声技法下，是刻意的。
所以 `dupId` 只在**同一 id 的两份定义不一致**时才报 —— 早期版本会把合法的
`modulation` 判成重复，整次保存失败。

**外语翻译**

节点新增可选 `translations: { de: 'Querflöte', ja: 'フルート' }`，
读的时候也接受 `[{ lang, text }]`。译名和别名一样进 `aliasIndex` / `tag_alias`，
所以搜索框里敲德语原文也能命中；`tags:suggest` 自动就有了。

**虚构测试数据：10 首**

`data/tracks/虚构测试数据 · *.json`，标题前缀固定，覆盖 11 种乐器标签组合、
演奏技法 / 作曲技法各若干、12 种情绪、10 个时期、6 种拍号（3/4、4/4、2/4、6/8、5/4 等）。
每首带一条 4 小节的和弦进行，可以直接在网格里打开看。

约束（冒烟里有几条是「恰好 1 条」的断言，测试数据不能撞）：
- 不同时出现「钢片琴 + 低音提琴」（否则 `钢片琴 低音提琴` 会变 2 条）；
- 不出现 `nostalgic` / `intimate`（「怀旧」「亲密」要恰好命中「おとなの掟」）；
- 不出现 `dorian`、不出现琵琶（这两条也是恰好 1）。

**拖边缘收缩：不再切成两份**

`writeRange` 的语义是「用新内容覆盖这段」：原事件多出来的半段会另存一条。
扩宽时正好，**缩窄时就成了「新块 + 同名的旧尾巴」** —— 用户看到的就是切成两份。

新增 `analysis:resize`（`resizeRange`）：先按新区间 `writeRange`，
再把**原区间露在新区间之外的部分**用 `clearRange` 剪掉。
左右各一条，扩宽时两条都为空，行为与 `writeRange` 完全一致。
`GridEditor` 的拖边缘与 `Alt+←/→` 都改走它。

**顺带修掉的逐帧重绘**

`followIfNeeded` 在 `scrollLeft === 0` 时仍然每帧「往左追」，
`setScrollLeft` 又无条件 `scheduleDraw()` —— 起播那半秒播放头离左边界不到 16px，
于是整网重绘 60 次/秒，热层 blit 一次都没跑。现在两头都加了「没变就别动」：
`from > 0` 才需要往左追，位置没变不排重绘。

**验收**：`npm test` 68、`npm run smoke` **115**（+7：收缩只剩一条、词表面板三栏齐全、
编辑器里改别名落库再撤回、保存含译名、有引用拒绝删除、无引用连库一起清、虚构数据组合命中；
另 +1 把「其他时期不误伤」改成按库里的条数比）。截图 `shots/smoke-vocab-editor.png`。

**词表编辑器：长词表在面板内滚动（40）**

面板高度写死 `min(640px, 84vh)`，但 `.ve-body` 的栅格只有列定义、行是隐式 `auto`：
行高按内容算，词表一多（乐器 61 条 / 1304px）整行就撑到面板外面，
三栏各自的 `overflow: auto` 全部失效 —— 它们根本没被限高，没有可滚的空间。

三处一起补（缺一不可）：
- `.ve-body` 显式 `grid-template-rows: minmax(0, 1fr)` + `overflow: hidden`；
- `.ve-list` 加 `min-height: 0`（grid item 的 min-height 默认是 auto，会被内容顶住）；
- `.ve-modal` 加 `overflow: hidden`，兜住圆角外的溢出。

表格自己滚（`.ve-table-wrap` 原本就有 `overflow: auto` + sticky 表头），
分组栏与右侧表单同理。验收不看感觉看几何量：面板四边在窗口内、
`scrollHeight > clientHeight`、最后一行底边落在可视区外、`documentElement` 不滚 ——
冒烟从 115 加到 **117**（+2：长词表滚动的几何断言、长词表面板可关），
被测词表用 61 条的「乐器」而不是 26 条的「作曲技法」—— 阈值要留余量。
截图 `shots/smoke-vocab-editor-long.png`。

**流派单列 + 情绪/流派进词表（41）**

**时期只收历史分期。** `PERIODS` 里原本混着爵士 / 民族·民谣 / 流行，它们不是时间轴上的位置，
而是「写法与来源」。把两种语义塞进一个字段的结果是搜索没法定向：
「浪漫主义 爵士」到底限定的是时期还是流派？现在 `PERIODS` 只剩
medieval → contemporary 八个，jazz / folk / pop 一律归流派。
`data/tracks` 里两首 period 为 jazz / folk 的虚构数据已清空时期（genre 原本就对）。

**流派是一个独立字段。** `track.genre` 这一列建库时就有、一直空着（档案里其实是自由文本），
现在接上词表：`data/vocab/genre.json`，一级流派做根（Classical / Jazz / Folk / Pop / Rock /
Electronic / OST / Vocal），子类挂在下面（Chamber Music / String Quartet / Etude / Latin Jazz…）。
**存的是词条 name 而不是 id** —— 历史档案写的就是 `Jazz` / `Chamber Music`，
存 name 才能让九首已有数据零迁移；`display` 才是中文（爵士 / 室内乐）。
代价是「改 name 会让已存的值失去对应」，JSON 的 note 里写明了。

**情绪也搬进词表。** `data/vocab/mood.json`（20 条，平铺：分组根不是情绪，标上去没意义）。
id 就是 `extra.moods` 里存的英文枚举，`display` 是中文，别名与译名一起进搜索。
词典里的 `mood.*` 键随之删除 —— 之前情绪标签是「从 DICT 的键推导」，等于把词表藏在 i18n 里；
现在渲染层启动时读一次 `vocab.doc('mood' | 'genre')`（`vocabLabels.ts`），
详情显示、编辑时的中文→值翻译、列表列都走这同一份。

**搜索怎么认这些词。** `expandQuery(text, extra)` 新增两个可注入的表：
`moods`（值取 id）、`genres`（值取 name）。主进程用 `searchTermTables(db)` 从
tag / tag_alias 现造 —— 词表是唯一源，改 JSON 即刻生效，不用重启也不用另抄一份常量。
`splitTerms(text, extra)` 同步接收，`Chamber Music` 这种带空格的流派名不会被拆成两个词。

一个坑值得记：英文术语必须**整词**命中。流派里有 `OST`、`Pop`、`Rock`，
用子串匹配会让 `nostalgic` 命中所有原声带（n-o-s-t-a-l-g-i-c 里有个 ost），
测试里 `nostalgic` 一度多出一首 Sibyl —— 就是这么来的。中文仍按子串（融合爵士要能命中爵士）。

**补全。** 搜索框候选不再单独维护一份情绪表：tag 表里本来就有 dim=mood / genre，
同一个循环按 dim 决定 kind，提示文案写「流派」「情绪」。详情里双击流派 / 情绪，
编辑框带词表下拉：↑↓ 选、Enter 采纳、**再按一次 Enter 才保存**
（有候选时 Enter 是补全，没候选时才是提交 —— 和 TagPicker 一致）。

**顺手修的：** `instrument_technique.json` 的分组根 id 与乐器维度撞名
（strings / brass / keyboard / percussion / mallet / voice），`tag.id` 是全局主键，
两个维度共用一个 id 会让库里的 dim 互相覆盖 —— `npm run check` 之前红了 6 项，
现在根 id 加了 `tech-` 前缀，9 项全绿。

**验收**：`npm test` **73**（+5：时期不含爵士、流派中文→name、词表每条都能搜到、
英文整词不误伤、带空格流派名不被拆）；`npm run smoke` **121**（+4：五套词表、
流派/情绪词表与时期分离、流派搜索三写法 + AND、补全里的维度提示；
详情字段断言扩到流派与情绪补全流程）。截图 `shots/smoke-detail-suggest.png`。

---

### 决定 42（v0.14）：专辑字段 + 封面/歌词资源的主进程支持

**专辑字段（album）**

`track` 表原本就有 `album` 列但从未接到界面。现在详情面板流派行下方新增专辑行，
双击可编辑（自由文本，不进词表）。`TrackPatch` 新增 `album`，`updateTrack` 支持写入。
搜索不覆盖专辑 —— 它是「属于哪张」的归属信息，不是检索维度。

**封面：ma-art 协议 + 双封面**

新增自定义协议 `ma-art://`（类似已有的 `ma-audio://`），只认 `trackId + single|album`：
- 路径由数据库 `extra.covers` 决定（`{ single: 'covers/trk-x-single.jpg', album: '...' }`）
- URL 带 `?v=updated_at` 破缓存
- 存储相对 dataDir，选图时复制进 `data/covers/`

详情面板在流派行后面显示：有图时出缩略图+清除按钮；无图时两个 "+" 占位
（独立封面 / 专辑封面各一）。

**歌词：完整生命周期**

主进程 `media.ts` 新增：
- `resolveLyrics(trackId)` → 手动指定 > 自动匹配（data/lyrics + assets 按曲名归一化模糊匹配）> 纯音乐标记
- `pickLyrics / clearLyrics / setInstrumental` → 用户操作
- 自动匹配优先查 `extra.lyrics`，再查 `data/lyrics/` 与 `assets/` 目录里的 .lrc

**类型全覆盖**

`types.ts` 新增：`CoverSet`、`LyricsStyle`、`LyricLine`、`LyricDoc`、
`PlayerState`、`PlayerCommand`；`TrackDetail` 扩展 `covers`/`lyricsFile`/`instrumental`；
`Api` 扩展 `art.*`、`lyrics.*`、`player.*`、`win.openLyrics/closeLyrics/openOverlay/closeOverlay`。

---

### 决定 43（v0.14）：歌词播报器子窗口 + 桌面歌词浮窗

**多窗口架构**

同一个 `index.html` + `main.ts` 通过 `location.hash` 路由切换根组件：
- 默认 → `App`（主界面）
- `#grid` → `GridStandalone`（已有）
- `#lyrics` → **`LyricsPlayer`**（新建）
- `#overlay` → **`OverlayLyrics`**（新建）

**歌词播报器（#lyrics）**

1040×700 独立窗口，三栏布局：
- 左：封面图（260px）
- 右：滚动歌词（当前句高亮，smooth scroll 到可视区 38% 处）
- 下：播放控件（进度条可点击 seek）

纯音乐时显示制作信息 + 「纯音乐，请欣赏」。时间戳开关存 localStorage。
操作菜单：pick / clear / markInstrumental。

**桌面歌词浮窗（#overlay）**

980×190 透明置顶无边框窗口（`frameless`, `transparent`, `alwaysOnTop 'screen-saver'`）：
- 只显示当前句（+ 可选下一句）
- CSS 变量驱动样式：`--ol-size/--ol-op/--ol-fg/--ol-shadow`
- 三色方案：white / accent / warm（各带 text-shadow 发光效果）
- 可拖动（底部拖动条），位置持久化到 `<userData>/overlay-bounds.json`
- 选项面板调：字号(16-64px) / 不透明度(20-100%) / 颜色 / 是否显示下一句

**跨窗口播放同步**

主窗口作为唯一音频宿主，帧循环里调用 `api.player.publish(state)` 广播 `PlayerState`
（trackId / title / playing / currentMs / durationMs / ready）。
歌词窗口/桌面歌词只读状态、发指令（toggle / rewind / seek）。
IPC 用 `broadcast(channel, payload, except)` 向除发送者外的所有窗口广播。

**桌面歌词样式 IPC**

不走 localStorage（Electron 跨窗口 storage event 不可靠），而是主进程持有一个
`lyricStyle` 对象，渲染层 `get`/`set` + `onStyle` 广播。

---

### 决定 44（v0.14）：网格小节线加强 + 冒烟钩子提前

**小节线比格线更显眼**

原来小节线和拍子/半拍的格子线用同一淡色 `c.line`。现在：
- 小节线用 `c.lineStrong`（更粗更深）
- 格线反而更淡 `rgba(128,128,128,0.10)`
- 显式设 `ctx.lineWidth = 1`

视觉层次：小节线 > 拍子线 > 半拍线。

**冒烟钩子必须早于副作用**

`window.__app` 原来在 `loadDesktopStyle()` 和 `api.openLyrics()` 之后才设置。
如果这两个调用（或它们触发的后续代码）抛出未捕获异常，整个 onMounted 会中断，
smoke 测试调 `window.__app.lang()` 就会拿到 "Script failed to execute"。

修复：把 `__app` 设置移到 `loadVocabLabels()` 之后、任何可能出错的 IPC 调用之前。
这样即使后续代码崩溃，smoke 的语言切换/选曲/主题等基础能力仍然可用。

**验收**：`npm test` **85**（+12：LRC 解析标准行/毫秒/多时间戳/offset/空行/JSON credits/BOM CRLF/
activeLineIndex/同毫秒有序 + 搜索流派/情绪/整词命中/带空格不拆）；
`npm run smoke` **121**（全部通过，无回归）。


---

### 决定 45（v0.14.1）：修 v0.14 的空壳事故 —— 冒烟必须能看见渲染层异常

**事故现象**

交付后主界面变成空壳：侧边栏「全部曲目 15」，表格区却是「没有匹配的曲目」，
状态栏「0 条结果」，右侧详情面板整个消失，网格显示「没有分析档案」。
看起来像数据全丢了，数据库其实完好（15 首 `deleted_at IS NULL`，直接跑 SQL 也返回 15 条）。

**根因：preload 的命名空间与调用方不一致**

`preload/index.ts` 把窗口管理放在 `api.win` 下：

    win: { openLyrics, closeLyrics, openOverlay, closeOverlay, ... }

而 `App.vue` / `LyricsPlayer.vue` / `OverlayLyrics.vue` 当成顶层 API 调：
`api.openLyrics()` → `TypeError: api.openLyrics is not a function`。

**为什么整个界面垮了**

那行在 `onMounted` 里（首次启动自动开歌词播报器）。`onMounted` 是 async，
抛错就**中断后面的 `await loadRows()`** —— 于是列表没填、没选中任何曲目、
详情与网格自然全空。用户看到的是「数据没了」，真因只在开发者控制台里。

这个模式要记住：**onMounted / 事件回调里的可选增强功能必须 try/catch**，
否则一个锦上添花的调用能把主流程整个掐断。

顺带发现 `api.moveOverlay` 在主进程、preload、类型里**根本不存在** ——
桌面歌词拖动是个空壳。三处同时补齐（IPC `win:move-overlay` + preload + `Api` 类型）。

**为什么 121 项断言全绿**

因为每条断言要么查数据库、要么量 DOM 几何，**没有一条看渲染层有没有抛异常**。
「功能压根没被测过」和「功能测过且通过」在报告里长得一模一样。

**补的守卫（冒烟开头装、末尾断言）**

1. `smoke()` 开头挂 `console-message` / `render-process-gone` / `preload-error`
   收集器，末尾一条断言：**渲染层零未捕获异常**。
2. 歌词播报器：能打开 + 按 hash 认对窗口 + `lyrics.resolve` 真解析出行数
   （灰ト祈リ 的 .lrc → 66 行）。
3. 桌面歌词：`openOverlay` + `moveOverlay(40, 25)` 位移必须正好是 (40, 25)。
4. 窗口识别改成**按 URL hash 找**，不再用 `find(w => w !== win)` ——
   歌词窗口也是 BrowserWindow，那写法会抓到错的窗口（截图存的是错的界面）。

顺带修掉守卫抓出的 `Canvas2D willReadFrequently` 警告：
`getContext('2d', { willReadFrequently: true })` 必须写在**第一次** getContext 上，
上下文属性那时就锁死，之后再传参数一律被忽略（同一 canvas 永远返回同一个 ctx）。

**约定**

- preload 的 API 一律带命名空间；渲染层只调 `api.<已定义命名空间>.*`。
  改 preload 时用差集命令核对（渲染层用到的 `api.x` ⊆ preload 定义的顶层 key）。
- 新增窗口类功能，冒烟必须按 hash 认窗口 + 验一条真实 IPC 往返，不能只看「没抛错」。

**验收**：`npm test` **85**；`npm run smoke` **125**（+4：歌词窗口可开、
歌词解析出行数、浮窗可开且可拖、渲染层零异常；「网格可在独立窗口」改为按 hash 识别）。


---

### 决定 46（v0.14.2）：歌词播报器 —— 主题同步、控制回路、封面协议、置于顶层

**封面一直不显示的真正原因：CSP 漏了自定义协议**

`ma-art://`（封面）注册得没问题、数据库里有路径、文件也在 `data/covers/`，
但 `renderer/index.html` 的 CSP 写着：

    img-src 'self' data: blob:;      ← 放行了 ma-audio:，忘了 ma-art:

浏览器**静默拦掉**图片请求，只在控制台留一行 `Refused to load the image ... because it
violates the following Content Security Policy directive`。表现就是「点了封面、路径也对、
就是不出来」，而且不报错。

修法：`img-src` 与 `connect-src` 都补上 `ma-art:`。
**教训：加自定义协议时，`registerSchemesAsPrivileged` 和 CSP 白名单是成对的，
只做前者必然静默失败。** 这条 bug 能活过 125 条断言，是因为守卫那会儿还没上线。

**播放控件按了没反应：主窗口是宿主，却从不订阅指令**

`player:command` 的链路是：子窗口 → 主进程 → **主窗口**。
主进程转发了（`win?.webContents.send('player:command', cmd)`），
但 `audio/store.js` 从来没调过 `api.player.onCommand`，指令发出去没人接。

修在 store 里而不是 App.vue：音频是模块级单例，谁先 import 谁负责监听，
放组件里就依赖挂载顺序。用 `window.__maCmdWired` 做幂等 ——
重复订阅会让一次点击变成两次 toggle（又停又播）。
同时补上 `play` / `pause` 两个指令，`rewind` 映射到 `stop()`。

**窗口打开时不知道在播什么**

主窗口只在**播放中**每 70ms 广播，暂停时一条都不发。
歌词窗口若只靠订阅，开在暂停状态就永远停在「未在播放」，封面与歌词都不加载。
双保险：主进程在 `did-finish-load` 时推一次 `playerState`，
渲染层 `onMounted` 也主动 `player.state()` 拉一次。

**主题同步走主进程广播，不走 localStorage**

子窗口各有独立的 `<html>`，localStorage 不共享、storage 事件跨窗口不可靠。
`app:theme-set` / `app:theme-get` / `app:onTheme` 三件套：
主进程持一份 `appTheme`，切主题时 `broadcast('app:theme', ...)`。
`backgroundColor` 也跟着走 —— 窗口在 `show` 之前颜色错了会闪一下白。

**视觉：控件照抄 TransportBar**

`.tp` / `.bar` / `.bar-fill` / `.bar-knob` / `.tc` / `.bb` 的尺寸、配色、hover
全部按主窗口播放条复刻（26×22 的按钮、4px 进度条、7px 旋钮、`--line` 描边）。
TransportBar 的样式是 `scoped` 的不会穿透，所以在 LyricsPlayer 里重写一份**同尺寸**的。
配色全部走 tokens.css 变量，之前写死的 `rgba(0,0,0,.25)` 遮罩在浅色下是一块脏灰。

顺带修掉两个真 bug：模板里 `<header class lp-header>` 少一个 `=`；
`showLyricsMenu` 在模板里用了 6 次但脚本里**从未声明**，点「⋯」必崩。
`activeIndex()` 原来在模板里每帧调 N 次，改成 computed。

**窗口位置：旁边，且不重叠**

`placeLyricsWindow()`：右边放得下就右边 → 左边 → 下方 → 居中，
并且**按可用宽度收窄**（这台 3440×1400、主窗口 1800 宽，右侧只剩 ~800px，
硬挤就压上去了）。首次启动延迟 700ms 开，两个窗口同时冒出来像闪屏。

**置于顶层**

默认开（这窗口存在的意义就是被看着）。`win:lyrics-always-on-top` 传 true/false 设、
不传取反；`setAlwaysOnTop(on, 'floating')` + `setVisibleOnAllWorkspaces`。
状态只存主进程（不落盘）：这是看播的临时偏好，下次启动重新置顶更符合直觉。
标题栏有五角星按钮，**空白处右键**也弹同一个菜单，`✓置于顶层` 可勾选 / 取消。

**验收**：`npm test` **85**；`npm run smoke` **132**（+7：窗口不重叠、
拿到播放状态、封面 URL 正确、播放键 toggle 回路、浅色主题、置顶开关真作用到窗口、
右键菜单带勾）。截图 `shots/smoke-lyrics-light.png` 是浅色下的样子。


---

### 决定 47（v0.15）：选项面板的复选框自绘成 Vue 绿

**原来的样子**：选项面板里三个复选框（自动打开歌词播报器 / 启用桌面歌词 / 显示下一句）
**完全没有 CSS**，是 Chromium 原生外观 —— 深色底上那个系统蓝方块特别扎眼，
而且它跟 `--accent` 没有任何关系，等于这个界面里唯一的颜色不来自设计系统。

**为什么不用 `accent-color`**：它只改「勾」的颜色，边框、圆角、底色仍由系统绘制，
细边框在深色下依旧发灰。要跟 `.chip.on` 用同一套高亮语言，就得整套自己画。

**为什么方框画在 `::before` 上、`input` 本体留空**

Chromium 对 `appearance: none` 的 checkbox 仍会套一层内部最小尺寸。
加上 `tokens.css` 给所有 `input` 设的 `padding: 4px 7px`（那是给文本框用的），
`width: 13px` 实测被顶到 **16px**，连 `min-width` 都压不住。
最终做法：input 只当事件靶（透明、无边框、`padding: 0`、13×13），
方框与勾全交给伪元素，`::before` 用 `inset: 0` 自适应 —— 尺寸不再受浏览器摆布。

```
.pref-row input[type=checkbox]        /* 透明靶子，13×13 */
  ::before   inset:0                  /* 方框：--surface-2 底 + --line-strong 描边 */
  :checked::before                    /* 选中：--accent 底 + --accent 描边 */
  :checked::after                     /* 白勾：两条边 rotate(43deg) */
  :focus-visible::before              /* 焦点环：rgba(--accent-rgb,.35)，键盘 Tab 要看得见 */
```

勾用 `border` + `transform` 画而不是内嵌 SVG：任意 DPR 下都锐利，零额外请求。

**深浅两套自动正确**：底色与描边全走 `--surface-2` / `--line-strong` / `--accent`。
浅色下 `--accent` 自动换成压暗一档的 `#2f9e6b`（白底上 `#42b883` 做底只有 2.4:1），
白勾对比度依旧够。

**验收**：`npm test` **85**；`npm run smoke` **134**（+2：深色下 appearance/底色/勾/尺寸，
浅色下换成压暗档的绿）。断言量的是**同一个框**的选中态与未选中态 ——
第一个框默认就是勾上的，分别去找「第一个」「第二个」会量错；
读颜色前要等 200ms，否则拿到的是 `transition` 的渐变中间帧。
---

### 决定 48（v0.16）：区分「作品」与「录音制品」两层 + 封面改文件名 + 网格改称时间线

**为什么要分两层**

古典音乐里同一部作品有很多录音。索菲圣母有 1930 年 EMI、1961 年 DG、2010 年的
Harnoncourt 现场版 —— 作曲家、时代、调式、乐器编制**全都一样**，
但演奏家、乐团、指挥、录音地点、混音与母带、发行年、时长**全都不一样**。

这些差异如果挂在 `track` 上，等于要给同一部作品建 N 条档案：
「作曲家是谁」「这是哪个时期」这些作品级的问题要复制 N 遍，
搜索里还会出现 N 条同名结果。

分法：

| 层 | 表 | 装什么 |
|---|---|---|
| 作品 | `track` | 标题、作曲家、时期、流派、调性、乐器编制、标签 |
| 录音制品 | `recording`（004 迁移新增） | 演奏者、乐团、指挥、独奏、混音师、母带师、厂牌、catalog、录制/发行年、录音地点、文件路径、格式 |

`recording` 表**没有 composer 列** —— 冒烟里专门断言了这一点（`pragma_table_info`）。
把「哪个属性属于哪一层」钉死在 schema 上，而不是靠约定。

**不做破坏性迁移**

`track.file_path` / `track.duration_ms` 保留为「主录音」的快捷方式。
绝大多数作品只有一个录音，列表、播放、波形都直接用它 —— 行为跟以前一模一样。
`getTrack` 里只在「一条录音都没有但 track 有文件」时按文件头补一条
（`ensureRecordingForTrack`），否则老档案会显示「明明绑了音频却零版本」。

**主录音唯一性用 partial unique index**

```sql
CREATE UNIQUE INDEX ux_rec_default ON recording(track_id)
  WHERE deleted_at IS NULL AND is_default = 1;
```

应用层漏一处检查就会冒出两条「默认」，播放时行为不确定。
SQLite 支持 partial index，交给数据库兜住。

**踩到并修掉的真 bug：切默认会把歌弄成播不出来**

`setDefault` 原来无条件 `syncTrackFromRecording`，而后者把 `file_path` 为空的
录音也写进 `track` —— 等于**清空了作品原有的音频指针**。
「先登记版本信息、音频后补」是很常见的状态，用户切一下版本，一首能播的歌就没声了。

现在约定：**默认版本只从「有文件」的录音里挑**。
允许把 `is_default` 设到没文件的录音上（用户可能就想先标记），
但 `track.file_path` 不动。`removeRecording` 同理 ——
只有「一条录音都不剩」才把作品退回「没有音频」。
这两条都有冒烟断言（正好用「登记了信息但没绑文件」的场景覆盖）。

**录音层专属的 IPC**

`recording:list/get/save/remove/setDefault/pick/ensure`。
音频协议加第二种地址 `ma-audio://rec/<trackId>/<recId>`，
播放指定版本时用它；主录音仍用 `ma-audio://audio/<trackId>`。

**顺手修的：窗口销毁后发消息会崩主进程**

`win?.webContents.send(...)` 里的 `?.` **只挡 null，不挡「对象已销毁」**。
窗口关了但模块级引用还在时抛 `TypeError: Object has been destroyed`，
而且是在 IPC 回调里抛的 → `uncaughtException` 把主进程带崩。
主窗口关掉的瞬间正好有歌词窗口在加载，必踩。
抽出 `sendTo(w, channel, payload)`：先 `isDestroyed()` 再 try/catch，全部调用点改用它。

**模板少一个引号 = 整包编译失败**

写录音字段时手打了 11 组 `<label>`，其中一处 `t('rec.catalogNo' }}` 少了引号，
`vite:vue` 直接报 `Error parsing JavaScript expression`。
44 行重复标记里漏一个符号是迟早的事 —— 改成 `REC_FIELDS` 数组 + `v-for`，
加字段只改一行数据，模板与样式都不用动。

**另一个：`recEdit` 为 null 时模板不能直接取属性**

`v-if="recEdit.recordingId === r.id && ..."` 在 `recEdit` 是 null 时**照样先读属性**
（求值顺序是先算左边再判断），抛 `Cannot read properties of null`，
整棵组件树渲染失败 → 主界面空壳。必须写 `recEdit?.recordingId`。

**界面调整**

- 封面从流派下方**移到音频连接下面**（封面是这件录音制品的附属品）。
- 不再显示 72px 缩略图，改成**绿色文件名 + 可点**：
  详情面板只有 ~300px 宽，彩色封面比一整列文字都抢眼。
  点击开 `#image` 独立窗口看原图（自动按图片真实尺寸撑窗口 + 棋盘格背景 + 尺寸读数）。
- 「网格」全部改称「时间线」：`menu.view.panel` / `detail.offset` / `standalone.*` /
  `win.gridTitle` / `help.*` / `prefs.grid`，英文 Grid → Timeline。
  「格 = 一小节」这类描述画布上格子的说法保留。
- 移除时间线面板的 `box-shadow: 0 -10px 26px` ——
  向上投影会在面板**左右两侧各留一条竖向暗带**，面板占满主区宽度时特别明显。

**验收**：`npm test` **85**；`npm run smoke` **143**（+9：录音多版本独立、
录音层无 composer 列、默认版本唯一、切默认主文件指针跟随、
默认版本无音频时不清掉原有音频、删版本后回到原状、
封面是绿色文件名而非缩略图、颜色 = --accent、点击开查看窗口且图加载出来）。
截图 `shots/smoke-image-viewer.png`。---

### 决定 49（v0.17）：主题加跟随系统 / 按时段；歌词播报器改造成能编辑的窗口

**主题：从「二选一」到「四种模式 + 一个生效值」**

原来 `theme` 一个变量既是用户的选择也是实际生效的颜色。
现在拆成两个概念：

| mode | 含义 |
|---|---|
| `dark` / `light` | 用户直接指定 |
| `system` | 跟随操作系统（`nativeTheme.shouldUseDarkColors`） |
| `timed` | 按时段：7:00–18:00 浅色，其余深色（阈值集中在 `DAY_FROM` / `DAY_TO`） |

`theme` 变成 `resolveTheme()` 算出来的**实际生效值**。分开的好处：
子窗口只关心「现在该用哪个颜色」，不用管这颜色是被谁决定的 ——
广播 `app:theme` 时传的是 `theme` 而不是 `mode`。

`system` 只能实现在主进程：`nativeTheme` 是 Electron API，渲染层读不到。
主进程订阅 `nativeTheme.on('updated')` 广播 `app:system-theme`，
外加一个 `app:system-theme` 的 get 型 IPC 供首次调用。
`timed` 由渲染层自己按小时算，起一个 20 秒的定时器重算 ——
跨过 7 点 / 18 点会自己变色（最小化时 Chromium 会把定时器压到 1 分钟，最多晚一分钟）。

**手动切换按钮在自动模式下要先退出到固定模式**：否则用户按了没反应，
因为 `resolveTheme` 每次都把值改回去。

**语言选项「中文」→「简体中文」**：将来会有繁体，笼统叫「中文」说不清指哪一种。
这一改名连带改了冒烟断言里写死的 `'中文'` —— 改完那次跑挂了一屏，
全是因为切不回中文导致后续 7 条断言全在英文界面里找中文文案。

**歌词播报器：控件顺序与视觉照主界面**

播放控件改成「播放/暂停在前、回到开头在后」（原来反过来），按钮样式直接复刻
TransportBar 的 `.tp` / `.bar` / `.bar-fill` / `.bar-knob` / `.tc` / `.bb`（26×22 按钮、
4px 进度条、7px 旋钮、`--line` 描边）。置顶按钮从顶栏挪到控件栏，图标从五角星换成图钉 ——
顶栏按要求只留一个关闭按钮。

顶栏的图标抄主界面标题行 `MenuBar.vue` 里那个唱片 SVG，一模一样（12px、`--accent` 描边）。
顶栏高度仍是 24px，与主窗口菜单行齐平。

**时间戳用 LRC 原本的写法**：`[00:14.671]` 而不是自己拼的 `14.7`。
`formatLrcStamp()` 把毫秒补齐到三位 —— LRC 规范就是三位（毫秒），补齐不引入偏差。
`parseLrcStamp()` 宽容一点收：`[00:14.671]` / `00:14,671`（逗号）/ `14.671`（无冒号按 0 分算）都认。

**双击改歌词：写回 .lrc 文件**

`serializeLrc(lines, meta)` 重新序列化整份 —— LRC 没有「行号」概念，
我们拿到的只是解析后的数组；重新序列化保证输出的一定是合法 LRC，
原文件的 `ti` / `ar` / `offset` 等元数据保留。

**只允许写「我们自己管理的文件」**：手动指定的（`extra.lyrics`）或导入到 `data/lyrics` 的。
`assets/` 里的原始素材是只读的 —— 那是用户放进来的源文件，改坏了要重新去别处找。
自动匹配到 assets 的歌词返回 `code:'readonly'`，界面提示「改之前请先指定一份」。

**歌词翻译**：同目录同名 `.trans.lrc` / `.zh.lrc` / `.中文.lrc` / `.json` 都认。
按 ms 对齐原句（差 50ms 内算同一句），对不上就按行序兜底。
翻译挂在原句下面，小一号、颜色更淡。

**音量滑块**：主窗口是唯一持有 `<audio>` 的地方，所以子窗口的滑块**不能**改自己的音频，
只能发 `{type:'gain'}` 指令过去，由主窗口的 `setGain()` 落到 `el.volume` 上。
走指令而不是直接改 localStorage —— 那是主窗口启动时读的，而且 `setGain` 顺手会落盘。

**封面开关**：关掉之后左侧 240px 的整栏消失，歌词铺满（`.lp-body.no-cover`）。

**制作信息中文翻译**：`credit.*` 从 6 个键扩到 47 个，覆盖古典录音里常见的一批
（指挥 / 独奏 / 乐团 / 各声部与乐器演奏者 / 混音 / 母带 / 厂牌 / 题献 / 首次演出…）。
之前遇到 `conductor` / `masteringEngineer` 这类就原样显示英文 key，中文界面里很突兀。
`CREDIT_KEYS` 同步扩充 —— 词典里有但列表不认，那个键照样还是英文。

**顺带修的：一条可选路径把整轮冒烟掀翻了**

`以播放头为原点` 那个按钮是 `:disabled="!state.ready || !analysis"`，
某轮跑测时音频恰好没 ready，`find(...)` 返回 undefined，
`undefined.click()` 抛异常 → 整轮冒烟中断。
改成 `?.click()` —— **可选路径不该有能力掀桌子**。

**验收**：`npm test` **90**（+5：时间戳格式化 / 宽容解析 / 往返一致 / 写回保持合法 LRC /
改时间戳后回读位置真的变了）；`npm run smoke` **151**（+8：主题四模式都能切、
按时段按当前小时挑色、顶栏只留一个按钮、控件顺序、图钉置顶、音量百分比、
LRC 原始时间戳、封面开关、双击进编辑态）。
截图 `shots/smoke-lyrics-window.png`（深色）、`shots/smoke-lyrics-light.png`（浅色）。

---

### 决定 50（v0.18）：JSON 从「只读的源」变成「真正的源」—— 登记即落盘 + 软删归档

**症状**：用「登记作品」建的曲目只活在 `atlas.db` 里，`data/tracks` 里一份文件都没有。
库重启一次、换台机器、或者想拿 git 看档案，这些作品就消失了。

**根因不是漏了一行写文件，而是整条路只有一半**：

| 方向 | 有没有 |
|---|---|
| `data/tracks/*.json` → 库（`seedFromTracks`） | 有，每次启动跑 |
| 库 → `data/tracks/*.json` | **没有**，一行代码都不存在（`tools/import.mjs` 是原型脚本，输出路径还写死成 `神鹿谣.json`） |

而 `docs/开发计划.md` 第 15 行写的是「JSON 是**源**，SQLite 是**索引**（可重建）」。
索引能重建的前提是源跟着变；源不跟着变，那 SQLite 才是唯一的真相 —— 只是没人这么说过。

**做法**

1. **新增写回器** `src/main/import/trackjson.ts`：`buildTrackDoc()` 把 track + analysis + marker + event + tag 拼成
   v3 文档，`writeTrackJson()` 落盘（2 空格缩进、UTF-8 无 BOM、固定 key 顺序，与词表写回一致）。
2. **挂在 IPC 层**，不挂在业务函数里：写入口有十几条（详情编辑 / 标签 / 时间线 / 录音 / 封面 / 歌词），
   逐个在业务函数里调一定会漏，而漏掉的那条**不报错**，只会在重建库时少一段数据。
3. **失败不影响业务**：写不进去只记日志。JSON 是镜像，磁盘满 / 权限不足不该让用户的操作失败。
4. **启动补齐**：每次启动扫一遍「库里有、JSON 里没有」的曲目补一份。
   缺口本身不会报错，只会在下次重建时悄悄少几首 —— 十几条曲目的代价可以忽略。

**schemaVersion 3：加 `uuid`**

`seed` 原来按标题算哈希当 id（`stableId('trk', title)`），于是：

- 改名 → 哈希变了 → 下次启动把同一首当新曲目再插一行（两条并存）；
- 两首同名作品 → 被算成同一个 id（合并成一条）。

`uuid` 就是 `track.id`。`seed` 优先用它，老档案（v2，无 uuid）仍走哈希 —— 现有 14 份文件的 id 不变。
**顺带解决了「认领」问题**：写回时若发现同名文件没有 uuid 且标题一致，直接认领并补上 uuid，
而不是另建一份 `神鹿谣 (1d1ss57).json`。冒烟里专门断言「神鹿谣只有一份 JSON」。

**文件名 = 曲名，而不是 id**

`data/tracks` 是给人看的目录，打开文件夹要能直接找到「神鹿谣.json」。代价是改名要搬文件，所以：

- 候选名可重现：`<曲名>.json` → `<曲名> (<id 尾段>).json` → 加序号；
- 改名是 `renameSync`（搬家），不是另写一份 —— 同一 uuid 多于一份文件就是 bug，冒烟按 uuid 数文件；
- Windows 的三件事必须在纯函数里处理掉（`src/shared/trackfile.js`，8 条单测）：
  非法字符 `\/:*?"<>|` → `_`、**结尾的点和空格必须去掉**（Windows 会悄悄吃掉，导致写进去读不回来）、
  保留设备名（CON / LPT1…）加前缀。

**录音层不进 JSON**

演奏家 / 乐团 / 指挥 / 混音母带 / 发行年是**逐版本**的（`recording` 表），
而 schema v2 的 `timeline` 只有一个 `audioPath`。写进去就得先回答「N 个录音哪个算数」，
而这个答案并不存在。所以 v3 仍然只有作品层；`timeline.audioPath` 取主录音的文件路径，
`audioOffsetMs` 取主录音的偏移（与 `getTrack` 同口径）。

代价：**用 JSON 重建库会丢录音版本**。这是明确的取舍 —— 要补的话是 schema v4 的事，
需要先定义「多版本怎么表达」。

**删除 = 归档；彻底删除才清库**

- `tracks.remove`：先确保 JSON 在盘上（没有就先写一份），再软删 `track` + `analysis`，
  最后把文件 `move` 进 `data/tracks/.archive/`，并补一行 `archivedAt`。
- `.archive` 是**子目录**：`seedFromTracks` 只扫一层，归档件不会被读回来。
- 「维护 → 已归档作品…」列出归档件，「彻底删除」把**库里的行 + 归档文件**一起清。
  只删文件，库里那行会一直占着标题，下次启动 `syncMissingTrackJson` 还会把文件写回来；
  只删行，归档里那份就成了谁也认不出的垃圾。

**踩到的坑（写完才发现）**

1. `purgeArchived(ctx, null)` 最初写成 `if (!uuid || f.uuid === uuid)` —— 传 null 时等于「删光整个归档」。
   老档案（没有 uuid）恰好就是 null，点一条老记录的「彻底删除」会连累全部。
   现在改成 `uuid ? f.uuid === uuid : f.uuid === null`。
2. 冒烟里那些「物理删库」的清理点（`smoke-edit*`、草稿）必须**同时删 JSON**，
   否则下一轮 `seedFromTracks` 会把孤儿 JSON 当新曲目导回来 —— 表现是「删掉的测试曲目自己回来了」。
   冒烟里加了 `dropTrackJson()`，按 uuid 找文件删。

**验收**：`npm test` **98**（+8：非法字符 / 结尾点与空格 / 空标题兜底 / 保留设备名 / 超长截断 /
候选名顺序 / 同名冲突尾段 / 无 id 只一个候选）；`npm run smoke` 新增 7 条 ——
库里每首都有 uuid 对得上的 JSON、神鹿谣只有一份（老档案被认领）、
登记即生成同名 JSON（改名是搬家）、v3 结构字段齐全、详情改动回写、删除移进 `.archive` 且库里是软删、
彻底删除后文件与行都消失；归档面板能列出曲名与归档时间。


---

### 决定 51（v0.21）：id 不再靠「时间 + 3 位随机」，同名老档案自动自愈

**起因**：问「标题一样的音乐很多，会不会撞 uuid」。查完发现两处，一处虚、一处真：

| 路径 | 原生成方式 | 风险 |
|---|---|---|
| 登记作品 `createTrack` | `tr-` + `Date.now().toString(36)` + `Math.random().toString(36).slice(2,5)` | 随机段只有 36³ ≈ 4.7 万种。手工点几乎不会撞，但批量 / 脚本 / 并发登记会落在同一毫秒 |
| 老档案（JSON 无 `uuid`） | `stableId('trk', 标题)` = **只对标题做 FNV 哈希** | **同标题 100% 撞**，而且 `seed` 撞了之后是 `skipped` + `continue` —— 第二首静默不导入 |

`track.id` 是 `NOT NULL UNIQUE`，所以第一处的表现是「这次登记失败」；第二处更糟：
列表里少一首，日志里只有一句「已存在跳过 N 首」，没有任何线索。

**做法**

1. **生成器统一**：`src/main/db/ids.ts`
   - `newId(prefix)` = `<前缀>-<8 位 base36 时间>-<10 位 base36 随机>`，随机段走
     `crypto.randomBytes`（`Math.random` 是可预测 PRNG，不该用来发身份）。36¹⁰ ≈ 3.6e15。
   - `newTrackId()` / `analysisIdFor(trackId)`：档案 id 由曲目 id 推导（`tr-a-b` ↔ `an-a-b`），
     `seed` 与 `createTrack` 共用同一个函数 —— 两边各写一份，改前缀那天必然对不上。
   - `createTrack` 插入前查重，最多重试 8 次；8 次都撞说明随机源坏了，抛错比复用别人的 id 好。
   - 录音版本 `rec-<8位时间>-<10位随机>` 同源（原来是 8 位 `Math.random` + 时间尾 4 位）。
2. **同名自愈**：`src/shared/seedid.js` 的 `planSeedIds(entries, { mint })`（纯函数，7 条单测）。
   - 有 `uuid` 的档案照它说的算，绝不自作主张。
   - 无 `uuid` 的先按标题算候选 id（保持「同一份文件反复启动不会越导越多」）。
   - 候选已被**别的文件**占了（显式 uuid 或同批先到者）→ 换新 id，标 `heal`，
     `seed` 立刻把新 uuid **写回那份 JSON**（只加 `uuid`，不重建文档 —— 外部档案可能有我们不认识的键）。
   - **刻意不看数据库**：库里已有这个 id 恰恰是「这份文件早就导入过」的证据，那是正常跳过。
3. **坏 JSON 不再掐断启动**：单份解析失败只 warn，其余档案照常导入（以前的处理是整轮抛错）。

**验证**：`npm test` **116**（新增 7 条 id 规划）；冒烟新增 —— 启动前注入两份同名、无 uuid 的档案，
断言「两份都进库、id 不同、后来那份把新 uuid 写回了自己的 JSON」，验完立刻清掉（后续断言仍面对真实曲库）；
再断言登记的 id 形态 `/^tr-[0-9a-z]{8}-[0-9a-z]{10}$/`。

**顺带**：`tools/launch.mjs` / `tools/smoke.mjs` 给子进程摘掉 `NODE_OPTIONS` ——
开发环境会用 `--require ...node-language-shim` 把 fs 删除改道回收站，对大目录会超时，
而应用自己就在删/移归档文件，不该被这层 shim 接管。


---

### 决定 52（v0.23）：波形缓存 —— 内存 + 磁盘，按 MB 严格淘汰

**起因**：每切一次曲目就 `fetch 整段音频 → decodeAudioData → 建 min/max 金字塔`。
一首 18MB 的 FLAC 要 1–2 秒，期间面板写着「波形解码中…」；来回 A/B 两首曲子，这 1–2 秒要付很多次。

**缓存的不是音频，是峰值金字塔**（`peaks.js` 的 min/max 多级数组）：一首 3 分钟的曲子约 **8.7MB**，
读盘毫秒级；缓存音频文件本身没意义（`<audio>` 有自己的实现，况且解码才是瓶颈）。

| 层 | 位置 | 命中耗时 | 生命周期 |
|---|---|---|---|
| 内存 | `ByteLru`（Float32Array 直接复用） | ~0 | 本次运行 |
| 磁盘 | `<userData>/wave-cache/<sha1>.wave` | 几毫秒 | 跨启动 |

**键 = 路径 + 字节数 + 修改时间**。只按路径的话，同名文件被覆盖 / 重新转码之后
会一直显示**旧文件的波形** —— 而且看起来完全正常，属于最难发现的那类错。

**上限按 MB，插入后总量严格小于上限**（用户明确要求：「9 首没超、10 首 65MB 就淘汰最早那首，
让占用严格少于设定值」）。两层的预算各自独立：内存贵在占用、磁盘贵在容量，
合成一个池子反而说不清「关掉到底省了什么」。默认 **64MB**，选项里可关闭。

**LRU 的「最近使用」怎么记**：磁盘层不维护索引文件，命中时 `utimes` 一下文件，
`mtime` 就是使用时间。索引文件本身才是缓存最容易腐坏的部分（写一半、和实际文件对不上）。

**二进制格式**（`src/shared/wavecodec.js`）：`u32 magic + u32 headerLen + JSON header + 各级 Float32`。
JSON 里存 250 万个浮点数体积翻三倍还慢；二进制只贵一个「4 字节对齐」的坑 ——
`new Float32Array(buffer, offset, len)` 要求 offset 是 4 的倍数，所以 header 用空格补齐。

**失败一律降级**：读不到 / 解不开 / 写不进去，都只是「下次再解码一次」，不影响播放；
解码失败时用 `wave:forget` 删掉那一条，避免「读得到但用不了」的僵尸条目永远占着预算。

**验证**：`npm test` **124**（+8：编码往返 / 对齐 / 坏数据 / 字节估算 / LRU 严格预算 / 命中刷新 / 超预算拒收 / 上限归零）；
冒烟 +4 —— 清空后首次解码并落盘（memItems≥1、diskFiles≥1）、切回听过的曲目 **8ms** 命中且不进解码态、
上限设 0 两层立即清空、选项面板里确有档位与清空按钮。

---

## 2026-10-25 · schema v4：把「能算出来的东西」从档案里拿掉

三条都是同一个毛病：**规则的输出被冻成了数据**。规则一改、体系一换，旧值立刻自相矛盾，
而且没人知道该信哪个 —— 这种错不报错、不崩溃，只是慢慢变成胡说。

### 决定 1：`title.lang` 存短代码（`en` / `ja` / `zh`），不存 "English"

**为什么**：全名是**文案**不是值。中文界面里出现 "Japanese" 只能原样显示，想写「日语」
就得先认全名 —— 等于维护两套词表并祈愿它们同步。短代码是 BCP-47 的主标签，
接系统语言、歌词翻译、语言筛选都能直接用。

**兼容**：老档案全是全名，读的时候一律过 `shared/lang.js` 的 `normalizeLang`
（`English` → `en`，`en-US` → `en`）。迁移 008 把库里的老行就地归一。

### 决定 2：删掉 `timeline.sections[].bar`（小节数）

**为什么**：小节号 = f(tick, 拍号链)。写进档案，改一次拍号它就过期，
而「谁去同步段落的小节号」这个问题没有好的答案 —— 所以干脆不存。

**约束**（不是建议，是测试）：`seed` 只认 `tick`，没有 `tick` 的段落直接跳过并在控制台
点名文件；写着 `bar` 会多打一条警告。`tests/trackjson.test.mjs` 扫 `data/tracks/*.json`，
出现 `bar` / 缺 `tick` 都判红。写回器（`writeTrackJson`）与导入器都不会再产生它。

### 决定 3：删掉 `basic.meterType` / `analysis.meter_type`（单拍子 / 复拍子）

**为什么**：这是**分类结论**，而且**依赖术语体系**：

| | 判据 | 4/4 |
|---|---|---|
| 中 / 苏 / 德奥 | 一小节由几个重音组组成（两个 → 复拍子） | **复拍子**（2/4 + 2/4） |
| 英美 | 一拍内能否均分成两份（能 → simple） | **simple meter**（字面「单拍子」） |

一个 TEXT 列装不下「在哪个体系下」这个前提，存进去必然半真半假。
现在由 `shared/meter.js` 现算：`classifyMeter(num, den, system)`，体系跟界面语言走
（中文 → 中/苏/德奥，其它 → 英美）；两套结论不同时返回 `ambiguous`，界面在拍号类型后
挂一个圆圈 ⓘ，鼠标一悬停立刻出说明（不用 `title`，它有 ~1s 延迟）。

**代价**：`analysis` 表少一列（迁移 008 `DROP COLUMN`）。任何外部脚本读 `meter_type`
需要自己按规则算 —— 这是刻意的：宁可少一个能读错的字段。

---

## 2026-11-04 · schema v5：体裁（composition_type）与曲式（form）

### 决定 1：把「体裁」从 genre 里拆出来

**原来的错法**：`genre.json` 的古典根下面挂着 `Chamber Music 室内乐 / String Quartet 弦乐四重奏 /
Symphony 交响曲 / Concerto 协奏曲 / Etude 练习曲 / Fanfare 号角曲`。这些不是流派 ——
流派答「用了哪一路写法」（古典 / 爵士 / 民谣 / 配乐），体裁答「这是一部什么作品」。
混在一列里的直接后果：同一首曲子既有「流派 = 交响曲」，又想标「体裁 = 交响曲」时，
两处只能填一处，另一处永远缺。

**怎么分**：
- `genre`（流派）—— 写法与来源。存词条 **name**（`Jazz`），历史档案里原本就是英文名。
- `composition_type`（体裁）—— 作品形制。存词条 **id**（`symphony`）。
- `form`（曲式）—— 整曲的骨架。存词条 **id**（`sonata-form`）。

三者可以同时成立：古典（流派）交响曲（体裁）用奏鸣曲式（曲式）写成。

**为什么体裁 / 曲式存 id、流派存 name**：流派有历史包袱（老档案写的就是 `Jazz`），
改存 id 会让所有已有数据在迁移后对不上；体裁 / 曲式是新立的两列，没有包袱，
存 id 才能让显示名跟着界面语言走（中文「交响曲」/ 英文「Symphony」），
也不会因为改了中文译名就认不出旧档案。

**迁移 009**：加两列；把 6 个古典子项从 genre 搬到 composition_type，
`genre` 回落成父类 `Classical`（不丢「这是古典」这个信息，搜索「古典」仍然命中）。
打击乐（Percussion）**留在流派表** —— 它说的是编制，不是形制。

### 决定 2：`tag.id` 是**跨维度全局主键**，词表 id 不能跨维度重名

写这两份词表时踩到的：`fugue` 同时出现在 `composition.json`（作曲技法·赋格）与新建的
`composition_type.json` / `form.json` 里，`sonata` 同时是体裁（奏鸣曲）与曲式（奏鸣曲式），
`vocal / art-song / choral / aria` 同时是 `genre.json` 的声乐枝与体裁。

表现不是报错，而是**静默串味**：`tag` 表 `id TEXT PRIMARY KEY`，后来者覆盖先来者；
词表编辑器保存时才会以 `takenId` 拒绝整次保存（一次挂掉四条冒烟）。

**现在遵守的命名规则**：
- 曲式里带「式」的概念加后缀：`sonata-form` / `fugue-form`（不与体裁 / 作曲技法撞）。
- **赋格（fugue）是个例外，两边都收**（2026-11-04 同日修正）：说「这是一首赋格」是**体裁**，
  说「用赋格曲式写成」是**曲式** —— 两种说法都成立，所以体裁用 `fugue`、曲式用 `fugue-form`。
  同时它**从作曲技法（对位）里删掉了**：它描述的是作品形制，不是「怎么写」的手法。
  删之前确认过库里没有任何 `track_tag` 引用它，不用迁移绑定。
- **声乐那一枝整体没搬**：`genre.vocal` 已经占了 `vocal / art-song / choral / aria`。
  要搬必须整枝一起迁（见 PENDING），不能只把子项复制过去。

### 决定 3：曲式只做「整曲一条」，不做逐段标注

段落（`analysis_marker.kind='section'`）已经是一条完整的时间轴。如果同时在每个段落上挂
「这一段是呈示部 / 展开部」，就出现两份需要互相同步的真相：改了段落边界，曲式标注静默过期。
所以 `track.form` 只存一个抽象结论（奏鸣曲式 / 复三部曲式），逐段结构交给时间轴。

**代价**：问不出「展开部在第几小节」。真要问，那是段落标签该回答的事（`label` 是自由文本）。

### 附带改动

- 搜索：新增两组展开（体裁 / 曲式）。中文「室内乐」→ `chamber-music`、「奏鸣曲式」→ `sonata-form`；
  带空格的词条（`Chamber Music`）在分词时按整词保留。中文按子串命中是刻意的：
  「复三部曲式」会连带命中「单三部曲式」—— 宁可多捞一层。
- 详情面板新增第 11 个模块「体裁与结构」（乐器组合之后、时间轴之前），两行双击可编辑，
  候选来自词表。空值是「未标注」，**且必须是灰字占位**（`.d-row > .v.empty`）——
  这条已经升级成通用规则，写进 `RULES.md` 第 22 条，以后新增字段一律照办。
- 冒烟 447 条（新增 4 条：模块顺序 / 迁移结果 / 体裁·曲式落库 / 词表命中）。

**没做的事**：`work_type`（作品类别：music / image / sfx / video）与 `file_type` 还**没有**进 schema，
讨论结论记在 `PENDING.md`「多媒体」一节，等登记图片 / 音效的需求真正落地再动。

---

## 2026-11-04 · 迁移 010：级数与字母和弦拆成两条泳道

**原来的错法**：`roman` / `letter` / `riemann` / `voicing` 四个视图共用 `lane = 'chord'` 一行数据。
于是「字母和弦」视图里看到的是一串 `I / IV / V7`（那是级数），在那边敲 `Cmaj7`
又会把级数行覆盖掉 —— 两套完全不同的符号被绑成了一份数据。

**现在**：

| lane | 是什么 | 谁写 |
|---|---|---|
| `degree` | 级数（`V7` / `iiø42` / `N6`） | 罗马数字视图的「级数」行 |
| `chord` | 绝对和弦（`Cmaj7` / `G7♭9`） | 字母和弦视图的「和弦」行、黎曼视图的「实际和弦」行、和弦组成音视图 |

两者是**两份数据**：同一小节可以同时有一条级数和一条字母和弦，互不覆盖、互不清除。
一个 tick 上有两条不同 lane 的事件本来就是允许的（`analysis_event` 没有 `(analysis_id, lane, tick)` 唯一约束）。

**为什么 riemann 的「实际和弦」算 `chord` 而不是 `degree`**：它的字段说明写的是
「实际和弦」、占位符是 `G7` —— 那是绝对和弦。级数语义在 `function` 行（`T / S / D`），
那行目前没有补全候选。

**迁移**：`UPDATE analysis_event SET lane = 'degree' WHERE lane = 'chord' AND ...`，
判据用 `parsed.kind`（`absolute` 才留在 chord），不靠文字正则 —— `V7` 与 `G7` 用正则区分早晚出错。
`data/tracks/*.json` 的 102 条事件同步改了泳道名（只动 `lane` 一行，别的一个字没改）。

**代价（记在 PENDING）**：同一小节想同时有级数和字母和弦，要**输两遍**。
以前「一次输入、两个视图各解释一遍」的便利没有了 —— 但那个便利是假的：
两套符号本来就该各自记录，否则字母视图里永远躺着一堆看不懂的罗马数字。

---

### 决定 53（2026-11-13）：多乐章作品 —— 母作品挂乐章子项，分文件 + 可空 parent_id

**起因**：多乐章作品（安魂曲 / 交响曲 / 奏鸣曲）每个乐章的曲式、调性、速度都不同，
需要「作品当一条、下面挂乐章子项」。讨论中一度想扩成通用多媒体模型
（`work_type` = music / image / sfx / video），核实需求后**塌缩**：image 就是封面（已在 `extra.covers`）、
sfx 本质也是音频、video（配乐拉片）将来是「参照物」而非作品类别 —— 都不需要现在动作品/录音骨架。
拉片的地基（tick + 时间码 + fps + 原点偏移 + 可扩展的 marker kind）已经就位，推迟它零代价。

**四个拍板的决定**：

1. **JSON 分文件**：每个乐章一份 `data/tracks/*.json`，用可选 `parentId` 挂回母作品。
   **不嵌套进同一份文件** —— `buildTrackDoc` / `seedFromTracks` / `writeTrackJson` 全建立在
   「一份文件 = 一个 track = 一份 analysis」上；嵌套会掀翻这个不变量（uuid 不再 1:1、镜像/归档要重写成树）。
   分文件是纯加法，那套 machinery 一行不改。这正是「结构怎么变都不炸」的活例子。
2. **已有单曲上登记乐章**：母作品原有音频/分析不动，新乐章作为子项另挂（最省代码、无数据搬迁）。
3. **列表嵌套子行**：顶层只列 `parent_id IS NULL` 的作品，乐章像录音子行一样挂在母作品下（复用树机制）。
4. **命名**：默认「第N乐章」顺延 + 进输入态但**序数前缀不被覆盖**，直接补「行板 / Menuetto - Allegretto」
   这类术语；英文同格式（`III. Menuetto - Allegretto`）。术语补全需新建词表（现有 8 个词表无速度/乐章术语，
   仿 `chord-symbols.json` 做「只供补全、不当标签挂」的 `movement_marking.json`）。

**迁移 011**：`track` 加可空 `parent_id TEXT REFERENCES track(id)` + 部分索引 `ix_track_parent`。
老曲目 `parent_id = null`，一行不受影响。seed 在**全部 track 落库后**再设 parent_id
（避免「子文件先于母文件」触发外键；母作品缺失则不挂，宁可为独立作品）。软删 / 彻底删除都级联子乐章。

**验证**：迁移在内存库验过（列存在 / 母子链接 / 按母查子 / 悬空外键拦截 / 部分索引）；
`npm test` 298 绿；构建绿；冒烟基线运行中，多乐章专属断言待补（片 1 收尾）。

**没做 / 推迟**：术语词表 + 前缀保护输入框 + 自动补全 + 序数双语渲染（片 2）；
`work_type` 多媒体模型整体推迟（封面照用 `extra`，sfx / video 等真需求落地再说）。

**片 2 已补（同日）**：见下面的「决定 54」。词表 / 命名 / 光标落尾 / 中英格式都已落地，
`npm test` 新增 `tests/movement.test.mjs`，冒烟新增「默认第一乐章 + 光标落尾 + 输入行出现术语补全 →
↓ 选行板 → 回车落库」。

---

### 决定 54（2026-11-13）：乐章命名 = 序数顺延 + 前缀保护 + 独立术语词表

**起因**：登记乐章时若直接给空标题或让用户从零输入，要么丢掉「第几乐章」这个结构信息，
要么一进输入框就全选，把用户刚看到的「第三乐章」整段覆盖掉。用户要的是：
默认 `第一乐章 / 第二乐章 / 第三乐章…` 往下顺延，同时**光标落在末尾**，直接补
`行板` / `Menuetto - Allegretto` 这类术语。

**四条拍板**：

1. **默认序数用「已有序号最大值 + 1」，不是「条数 + 1」**：
   删掉第二乐章后再登记，若按条数会又生出一个「第二乐章」；按 max 则得到「第四乐章」（或补回第三），
   至少不会与现存标题重号。认不出任何序数（用户把标题全改成术语了）才退回条数 + 1。
2. **中英两套前缀**：中文 `第三乐章`；英文 `III.`（罗马数字 + 点）。
   英文再按 `III. Menuetto - Allegretto` 的通行格式往下接；中文补术语的中文显示。
   序数只在**默认值**里出现，之后用户改成什么都行 —— 不做不可编辑的固定前缀。
3. **一进输入框就「光标落尾」而不是全选**：普通改名（登记作品 / 右键更改标题）仍全选；
   新乐章走单独的 `editCaretEnd`。这样用户看到的默认标题还在，第一个字直接接在后面。
4. **术语放独立词表 `data/vocab/movement_marking.json`，不进标签维度**：
   它只服务输入补全，不挂到曲目上、没有父子关系，塞进标签词表只会多出一个假维度。
   与 `chord-symbols.json` 同一类（`vocab/load.ts` 的 `NON_TAG_FILES`）。
   结构是扁平 `terms[]`：`{ id, name(总谱写法/英文), display(中文), kind(tempo/dance/form/character), aliases }`。
   补全只看「默认前缀之后 / 最后一个 ` - ` 之后」那一段；英文插 `name`，中文插 `display`；
   已有一段术语时用 ` - ` 接第二段。`↑↓` 选、`Enter/Tab` 接受、`Esc` 只收下拉；
   普通回车（没有高亮候选）直接提交，不抢补全。

**只做一层**：乐章子项自己不能再挂乐章。右键菜单在 `parentId` 非空的行上不出现「登记乐章」，
`createTrack` 也拒绝把父级指向乐章子项（防嵌套与删不干净的树）。

**验证**：`tests/movement.test.mjs` 6 条（汉字/罗马序数、识别、max+1、补全片段、术语插入）；
`npm run check` 认识非标签词表并校验 80 条术语；冒烟 550 条里包含真实 UI 回路。

**代价 / 没做**：术语表目前没有编辑窗口（侧栏「乐章术语」直接打开 JSON，改完重启生效）；
乐章检索还没做（列表顶层只列母作品，搜索命中乐章标题暂不会把母作品带出来）——
`parentId` 的拆文件设计就是为以后做这一步留的。

**后续（2026-11-14）**：「乐章术语」这个类目已拆掉（决定 57）：速度 / 表情进
`tempo_marking.json`，舞曲 / 曲式 / 体裁并进 `composition_type.json`，补全合并两张表。

---

### 决定 55（2026-11-13）：录音版本内再分「同版音质」——`recording.parent_id`

**原来的错法**：`recording` 一行 = 一次演奏 + 一个文件。于是同一版录音的 flac / mp3 / ogg
会变成三条互不相干的「版本」，演奏家、厂牌、录音年份要抄三遍；而不同演奏家的两版录音
又和转码混在同一层，列表顺序里看不出谁是谁的派生。用户原话：
「有些是同一个版本的不同转码音质，但有些是出自不同演奏家之手的」。

**怎么做**：迁移 012 给 `recording` 加可空 `parent_id REFERENCES recording(id)`：
- `parent_id = null` → **演奏版本**：谁演的、哪个厂牌、哪年录的、原点偏移都在这一行；
- `parent_id = 父 id` → **同版音质**：只贡献 `file_path / format / 采样率 / 声道 / 位深`。

**为什么不做第二张表**：文件表会把播放、偏移、协议、导入器全部改成两跳查询；
而「一个版本最多挂几个文件」的规模很小，自引用一层就够。纯加法，老录音 `parent_id = null`
行为完全不变，不搬迁任何数据。

**播放与顺序的口径**：
- 点作品播放 / 双击试听仍然只认**演奏版本**；`recording.list` 只返回父版本，文件挂在 `variants` 里。
- 播父版本时：自己的文件优先；没绑（或文件被挪走）就用它名下**第一个还在磁盘上的音质文件**。
  `track.file_path` 与 `is_default` 由「第一条有可播文件的演奏版本」推导，子文件永远不拿 `is_default`，
  也不参与「点作品先播哪一版」的 `seq_order` 排序。
- 原点偏移属于演奏版本：即使渲染层误传子记录 id，`setRecordingOffset` 也写回父版本。
- 删除演奏版本级联软删它的音质文件；单独删一个音质只动那一行。

**界面**：管理窗左列每个版本显示 `+N`；右栏「音源」下新增「同版音质」列表（格式 · 时长 ·
采样率 / 位深、换文件、移除），按钮「添加同版音质」只登记文件；「添加录音版本」仍是新演奏版本。
不同演奏家必须另建版本 —— 这是这次分层的核心语义。已经存在的两条版本若是同一次演奏的不同转码，
可以在管理窗用「并入同版音质」选另一版（只接受没有子项的一层，避免造出三层）。

**没做 / 代价**：录音层本来就不进 JSON（决定 004 / schema v3 只存作品层），所以音质文件也只在库里；
从 JSON 重建库时 `ensureRecordingForTrack` 只会按 `timeline.audioPath` 补回一条主录音。
这是既有架构的取舍，不是这次新增的丢失 —— 真要持久化版本树，得先把录音层整体写进 JSON，
那是另一轮的事（见 PENDING「录音层持久化与乐章检索」）。

**验证**：冒烟新增「同版音质挂在演奏版本下、不占独立版本行、summary.variantCount、已有版本并入、
删父版本级联软删」；迁移 012 在启动日志里显示 `migrated → v12`。

---

### 决定 56（2026-11-14）：拍号 / 速度允许「未标注」——4/4 · 120 只是渲染默认

**原来的错法**：`createTrack` 给每个新作品预写 `tempo_value = 120`、`meter_num/den = 4/4`，
还插一条 tick 0 的 meter marker；JSON 导入缺字段时也补 4/4。于是「没量过」和「量过就是
4/4 · 120」在库里长得一模一样 —— 详情页只能显示 4/4 · 120，用户没有任何办法看出（或恢复）
「未标注」。默认值是猜测，写进库就会被以后的检索 / 统计当成事实。

**怎么做**：
- `analysis.tempo_value / meter_num / meter_den` 允许 NULL；新建作品、缺字段的 JSON 导入都留空，
  不再插 tick 0 的假 marker（之后由详情或网格按需写入）。
- 详情页拍号 / 速度显示「未标注」（淡色斜体），双击可填写；**留空 = 清除标注**，回到未标注。
  清除只撤 tick 0 那条主拍号 / 主速度，中途变拍 / 变速保留。
- JSON 的 `basic.meter` / `basic.bpm` 未标注时写 `null`（不再洗成 4/4 / 120），导出再导入仍是未标注。
- **渲染与播放口径不变**：GridEditor / TransportBar / barbeat 在没有 marker 时本来就按
  4/4 · 120 BPM 兜底，所以未标注时网格按 4/4 画、播放条读 4/4 · 120，只是这些值不回写档案。

**为什么这样分**：显示层需要「能不能播 / 能不能画」的确定值，档案层需要「用户到底标没标」的诚实值。
两者混在一起就再也分不开；分开之后，默认值只活在渲染层，档案保持干净。

**验证**：冒烟新增「新建作品库里为空且有零条拍号 / 速度标记」「详情显示未标注 + 播放条读 4/4 · 120」
「JSON 写 null」「3/4 · 96 → 留空清除 → 标记撤掉、播放条回默认」；既有 JSON 断言改为未标注写 null。

---

### 决定 57（2026-11-14）：拆掉「乐章术语」——速度 / 表情表 + 体裁树，补全读两张表

**问题**：决定 54 把 80 条术语都塞进 `movement_marking.json`，侧栏还挂了一行「乐章术语」。
但专业上没有这个类目：行板 / 快板是**速度术语**，小步舞曲 / 谐谑曲 / 回旋曲是**体裁**。
一个自造的大杂烩词表会让「这个词该去哪儿找」永远说不清，也让体裁的编辑入口分裂成两处。

**怎么拆**：
- 新建 `data/vocab/tempo_marking.json`：原表里 `tempo` + `character` 共 **38 条**
  （行板、快板、如歌地、热情地…）。它是非标签维度，和 `chord-symbols.json` 同一种地位
  （`NON_TAG_FILES`），侧栏「速度术语」一行，点开直接编辑 JSON。
- 原表里 `dance` + `form` 共 **42 条**并进 `composition_type.json`：
  - 舞曲 19 条挂到 `dance` 下（Menuetto / Scherzo / Valse…），`marcia` 并成 `march` 的别名；
  - 特性小品 7 条挂到 `character-piece` 下（夜曲 / 摇篮曲 / 船歌…）；
  - 回旋曲 / 变奏曲 / 托卡塔 / 幻想曲 / 帕萨卡利亚 / 恰空 / 主题 / 终曲 / 引子 挂到 `instrumental`；
  - 咏叹调 / 宣叙调 / 卡瓦蒂娜 / 众赞歌 挂到新根 `vocal-music`（`vocal` 已被 `genre.json` 占用，
    沿用「全局 id 不可跨维复用」的规矩）；
  - `preludio` → `prelude`、`fuga` → `fugue` 并成别名；`rondo` / `passacaglia` / `aria`
    与 `form.json` / `genre.json` 撞 id，条目分别用 `rondo-piece` / `passacaglia-piece` / `aria-piece`。
- **补全在 main 合并两张表**：`movement:doc` 返回
  `{ terms: [...tempo, ...composition], tempoCount }`。渲染层拿到的仍是一个扁平数组，
  匹配 / 补全逻辑不变；`kind` 为 `tempo / character / composition`，候选右侧照旧显示类别。
  「速度术语」那一行的数字只算 tempo 表（38），不把体裁混进计数。

**验证**：`npm run check` 校验 38 条术语的 id / kind；`composition_type.json` 55 节点无环。
冒烟断言 `tempoCount === 38`、同时含 Andante / Menuetto、且不再出现 `dance` / `form` 两个旧 kind；
真实 UI 打「行」仍能选行板落库。

---

### 决定 58（2026-11-14）：侧栏三块标题右键可搜索——只匹配标题关键词

**问题**：播放列表 / 泳道方案 / 词表都会越来越多，侧栏是一个纵向长列表，找一项只能滚。
右键标题原本只有播放列表有菜单，泳道方案和词表连入口都没有。

**怎么做**：右键三块标题都出菜单，里面有「搜索播放列表 / 搜索泳道方案 / 搜索词表」；
点开在标题下出现一行内联搜索框（自动展开该块并聚焦），输入即按**标题关键词**过滤：
- 播放列表按列表名，「全部曲目」也参与匹配；
- 泳道方案按方案名；
- 词表按行标题（体裁 / 曲式 / 和弦符号 / 速度术语…）。
Esc 或 × 收起并清空，恢复全部条目；没有匹配时显示一行「没有匹配项」。
不做分词、不做拼音、不搜词表**条目**——用户要的是「标题里有没有这几个字」。

**验证**：冒烟走真实 UI：三块标题右键 → 菜单项 → 输入关键词 → 断言只剩匹配行
（词表搜「体」只剩体裁；泳道搜「罗」只剩罗马数字级数；播放列表搜「改名测试」只剩那条，
且「全部曲目」一起收起）；Esc 后词表恢复 9 行。

---

### 决定 59（2026-11-14）：录音音质变更后失效重载音频；取流与解析共用同一套音质回退

**症状**：改过录音版本 / 同版音质之后，偶尔按播放报「播放失败」；有时有提示，
拖一下播放头又能正常播。看起来像偶发，实际是两处确定的不一致：

1. **解析与取流两套逻辑**：`resolveRecordingAudio()` 知道「父版本没绑文件就用第一个音质」，
   但 `ma-audio://rec/...` 的协议处理器只查**被请求那一行**的 `recording.file_path`。
   父版本没文件、文件在音质子项上时，解析说「能播」，真正取流却 404。
2. **同 id 早退导致音频源过期**：`loadTrack()` 以 `trackId + recId` 不变为由直接返回，
   可音质文件已经换了；`<audio>` 继续持有旧文件的字节范围。拖动播放头会发新的 Range 请求
   （协议按新文件回），所以出现「动一下指针又好了」的假象。

**怎么做**：
- 抽出 `recordingFamily()`：父版本自己的文件优先，否则同族第一个还在磁盘上的音质。
  **解析（resolveRecordingAudio）和取流（serveAudio）都只走它**，不许再各写一份。
- `loadTrack(trackId, recId, { force })`：录音文件变更后允许同 id 强制重解析。
- `onRecManagerChanged` 先比较**文件指纹**（作品 filePath + 每个版本的 id/filePath + 音质
  id/filePath）。指纹没变（只改厂牌 / 演奏者）就直接返回，不打断正在播的音频；
  变了才强制重载，并接回原位置与播放状态；当前版本被删则退回主录音。

**验证**：冒烟新建「父版本无文件 + 音质子项绑定真实 FLAC」，调用
`audio.resolveRecording` 后对 `info.url` 发 Range 请求，断言 206 且 Content-Length=16
（修复前这里 404）；既有「播到结尾 / 拖回中间 / 再播」「切版本」断言全部保持通过。

---

### 决定 60（2026-11-14）：右键「更改标题」也能补全——前缀从标题自己认

**症状**：刚登记乐章时（光标在前缀末尾）输入「行」立刻出行板候选；但先离开、
再从右键菜单点「更改标题」，同样的输入却不出候选，非要手打 ` - ` 才开始补。

**根因**：`editPrefix` 只在「登记乐章」时写入（新建时的默认前缀）。右键改名走
`startRename()` 把它清成 null，`movementFragment(text, '')` 于是把整条
`第一乐章 行板` 当成一个待补片段去匹配 —— 当然匹配不到任何术语；
打了 ` - ` 之后片段变成后半段，才「碰巧」恢复。

**怎么做**：`shared/movement.js` 新增 `movementTitlePrefix()`，从标题原文认
`第三乐章` / `3.` / `III.` / `Movement 3` 四种前缀；`movementFragment()` 与
`applyMovementTerm()` 在显式前缀为空时自动使用它。两条改名路径（新建 / 右键）
从此共用同一套「前缀之后才是补全片段」的规则，插入位置也一致：
`第一乐章` + 行板 → `第一乐章 行板`，而不是 `第一乐章 - 行板`。

**验证**：单测新增无显式前缀的识别与插入（305 条全绿）；冒烟走真实 UI：
右键乐章行 → 更改标题 → 把标题设为 `第一乐章 小步` → 候选出现「小步舞曲」。

---

### 决定 61（2026-11-15）：标题 / 乐章名用模板描述，补数据字段不补假值

> 命名更新：本条里写作 `subForm` / `%sub-form}` 的字段，已在决定 64 中更名为
> `subType` / `%Sub-Type}`；旧写法仍作为兼容别名读取。后续以决定 64 为准。

**问题**：古典作品的标题是「作曲家 + 体裁 + 编号 + 调性 + 作品号」拼出来的
（`Beethoven - Piano Sonata No.1 in F Minor, Op.2, No.1`），但档案只是一条自由文本。
改一个字段就得手动改整条标题，列表、详情、乐章行各显示各的。
用户要的是「Sibelius 式」的显示格式：模板变量 + 字面文字，存成预设，输入时按名字补全。

**语法**：`%变量名}`。`%` 起点、`}` 终点；变量名可以带空格。
官方预设：
- `for_Classical_Opus` = `%Composer} - %form} %Number of the form} in %Key}, %Opus Number}`
- `default_movement` = `%Movement Number} %sub-form} - %Tempo Term}`

**缺失变量整段消失**，不是留空串、不是写 N/A：第二乐章没有 sub-form 时，
`%Movement Number} %sub-form} - %Tempo Term}` 显示成「第二乐章 - 柔板」。
展开后收空格、标点前空格和悬空分隔符；一个值都没有时退回模板原文，标题不能变空。
认不出的变量名原样保留，避免手误被静默吃掉。

**JSON schema（加法，不升 schemaVersion）**：`basic` 新增四个可选键：

| 键 | 含义 | 例子 |
|---|---|---|
| `formNumber` | 同类作品里的编号 | `No.1` |
| `opusNumber` | 作品号；没有的流行作品写 `N/A` | `Op.2, No.1` |
| `subForm` | 乐章的子体裁（体裁词表 id） | `menuett` |
| `tempoTerm` | 乐章的速度术语 | `小快板` / `Allegretto` |

四个键在 DB 里暂存 `track.extra`，`seedFromTracks` / `buildTrackDoc` 两头读写；
老档案没这几个键就是没数据，不需要迁移。`N/A` 是真实值：中文界面显示「不适用」，
英文界面保持 `N/A`，标题模板里也跟着这条规则走。

**取哪个字段**：`%Composer}` → `credits.composer`（退 `track.composer`）；
`%form}` / `%sub-form}` → `composition_type`（词表里没有的原文照显示，不另造词表）；
`%Key}` → 第一条调性；`%Movement Number}` → 标题里自带的序号，认不出就按母作品下的位置；
`%Opus Number}` / `%Tempo Term}` → 上表。详情「体裁与结构」里新增四项编辑入口，
`subForm` 的候选直接来自 `composition_type.json`，不改词表。

**显示 vs 存档**：`title.original` / `track.title` 保存**模板原文**，展开只发生在显示层
（`shared/titleTemplate.js` + `renderer/src/titleTemplate.ts`）。
代价：JSON 文件名、标题搜索仍按模板原文走；要改得先定义「文件名用哪一列」，
不在写回器里临时拼。

**预设存哪**：内置预设写死在 `renderer/src/titlePresets.ts`；用户预设存
localStorage `ma-title-presets`，带作用域（标题 / 乐章）。它只影响输入候选，
不进曲库、不写 `data/tracks`。标题输入与乐章行内改名都按预设名匹配，
选中后用**整段模板**替换当前标题；按 Enter 不是直接提交标题。

**验证**：`shared/titleTemplate.js` 单测 7 条（变量名归一 / 切段 / 展开 / 缺省 / 清理 / fallback）；
冒烟 +7：古典标题在详情与列表同时展开为
`Beethoven - Piano Sonata No.1 in F Minor, Op.2, No.1`；标题输入敲 `for_Classical_Opus`
→ Enter 填入整段 → 再 Enter 落库；`N/A` 显示「不适用」；乐章模板有 / 无 sub-form
分别得到「第一乐章 小步舞曲 - 小快板」「第二乐章 - 柔板」；乐章行内改名也能补预设；
选项列出官方预设且变量是主题绿色；自定义预设能保存 / 删除且不碰 data/tracks。
`npm test` **312**、`npm run check` 14/14、`npm run smoke` **568/568**。

---

### 决定 62（2026-11-15）：启动配置外置到 `userData/config.json`

**症状**：选项里取消「启动应用时自动打开歌词播报器」，下次启动它还是开。
根因不是写入失败，而是**根本没写**：`lyricsAutoOpen` 初始化时读
`localStorage['ma-lyrics-auto']`，复选框只 `v-model`，从来没有落盘；
主进程拿到的只有渲染层启动时通过 `win:app-ready` 传的一次性值。

**怎么做**：启动相关偏好统一移到外部 `userData/config.json`：

```json
{
  "version": 1,
  "safeMode": false,
  "startup": { "lyrics": true, "help": true }
}
```

- 主进程 `ConfigStore`（`src/main/config.ts`）是唯一读写方；文件不存在时启动
  自动生成默认值。选项里的开关通过 `config:get/update` 立刻写盘；
  `appReady` 以**配置文件**为准，渲染层传来的值只在文件读不到时兜底 ——
  这样手改文件后重启一定生效，安全模式也挡得住自动开窗。
- 语法坏了不拦启动：JSON 解析失败就用默认值跑，选项里显示具体错误；
  用户在坏文件上再点选项时，先把原件备份成 `config.json.bad-<时间>` 再写。
  不认识的键原样保留（`...raw`），不因为界面保存一次就被删掉。
  写盘失败会抛回 IPC，界面把开关拉回文件里的真实值并显示错误 —— 不装作保存成功。
- **安全模式**：当前版本还没有插件系统，这个开关先接管「不自动打开歌词 /
  帮助窗口」，将来接插件加载时必须先读 `safeMode`。勾选后两个自动打开开关
  在界面上禁用，但保留原值 —— 关掉安全模式就恢复原偏好。
- **迁移**：只有 `config.json` 是这次启动才生成（`fresh`）时，才读一次
  `ma-help-auto` / `ma-lyrics-auto`（旧版只有帮助真的写过），写进配置成功后才删旧键。
- 配置在 `userData` 而不是 `data/`：它是机器本地的启动行为，不是作品内容；
  打包后 `data/` 只读，配置文件必须可写。选项 → 窗口里显示完整路径，
  「打开 config.json」直接交给系统默认编辑器。

**验证**：冒烟打开选项，取消歌词自动打开 → `config:get` 返回 false 且
磁盘上的 `config.json` 同步变成 false；勾安全模式 → 写盘为 true 且歌词 /
帮助开关同时禁用；再恢复两项，磁盘回到默认值。当前版本没有插件，
安全模式的「禁止插件」是给未来加载器留的硬条件，已在代码注释里写明。

---

### 决定 63（2026-11-15）：标题里的连续空格原样保留

**症状**：在标题里手打多个空格，详情和列表只显示一个；改写成 `&nbsp;`
又会被当普通文字原样显示（Vue 的文本插值不做 HTML 实体解码）。

**根因**：输入框和数据库都保留了空格，折叠发生在展示层 ——
`.title-text` / `.c-title .t` / `.mov-title` 原来都是 `white-space: nowrap`，
HTML 会把连续空格压成一个。模板展开里还有一道全局 `.replace(/\s+/g, ' ')`，
把模板字面的连续空格也一起压掉了。

**怎么做**：

- 三处标题展示改成 `white-space: pre`：保留空格、不换行，`text-overflow: ellipsis`
  照常截断。输入框不需要特殊处理（原本就保留空格），保存只在首尾 `trim()`。
- 模板清理改成「只收拾空变量留下的空位」：缺值变量先替换成哨兵 `\u0000`，
  再只塌缩哨兵两侧的空白；字面的 `A   B` 仍是三格。缺 sub-form 的
  `第二乐章 %sub-form} - 柔板` 仍然得到「第二乐章 - 柔板」。

**对齐的边界**：空格现在能存、能看见，但用空格在比例字体里做列对齐**不保证**
不同长度的前缀能精确对齐（空格宽度固定，汉字 / 拉丁字母宽度不一致），
换 UI 字体也可能变。真要稳定对齐，得另加「按段落分列」或每首标题的
偏移量，不应继续往空格上堆语义；取舍记在 `PENDING.md`。

**验证**：`shared/titleTemplate.js` 新增「字面连续空格不被吞、只塌缩空变量」
单测；冒烟把标题改成 `甲  乙`，查库里仍是两格、详情与列表 `textContent`
原样、三处 `white-space === 'pre'`（乐章标题单独验一次）。

**本轮验证**：`npm test` **313** 通过、`npm run check` 14/14、`npm run smoke` **572/572**
（新增 4 条：歌词开关写盘、安全模式写盘并禁用两个自动打开开关、恢复默认、
标题连续空格在详情与列表原样显示）。

---

### 决定 64（2026-11-15）：Sub-form 全量更名 Sub-Type；速度术语按词表本地化

**改名**：`Sub-form` 这个名字和上面的 `Type`（compositionType）对不上，英文界面
统一成 **Sub-Type**；模板变量从 `%sub-form}` 改为 `%Sub-Type}`，档案字段从
`basic.subForm` / `track.extra.subForm` 改为 `basic.subType` / `track.extra.subType`。
中文界面标签仍是「子体裁」（和「体裁」对应），不跟着改成「子类型」。

- 解析层同时认旧写法：`%sub-form}` / `%sub form}` / `%subform}` 都归一成 `subType`，
  用户自定义预设不会因为改名突然失效；新预设、官方 `default_movement`、
  写回器一律输出 `%Sub-Type}`。
- `titlePresets` 读 localStorage 时把旧预设里的变量名规范成新写法（不丢预设）；
  编辑自定义预设保存时也走同一规范化。

**数据迁移**：这次直接迁了现有档案，不靠运行时猜：

- `data/tracks` 下 2 个活动模板 + `.archive` 下 1 个归档模板：
  `title.original` 的 `%sub-form}` → `%Sub-Type}`，`basic.subForm` → `basic.subType`，
  文件本身也改名成 `%Sub-Type}`（备份留在 `.tools/subtype-backup-<时间>/`，不进仓库）；
  其余档案里跟着写出的 `basic.subForm: null` 也一并改成了 `basic.subType: null`。
- `atlas.db` 里 3 条相关曲目（含 1 条已归档）同步更新 `track.title` / `analysis.title` /
  `extra.subType`；旧 `extra.subForm` 删掉，避免两份真相。
- seed / 写回器 / 列表 / 详情都保留旧键回退：外部旧 JSON 仍能导入，下一次写回自动变新键。
- `schemaVersion` 仍是 3：这是可选键的重命名，主程序已迁移并兼容旧键；
  等到真正弃用旧键时再升版本。

---

<a id="netease-playback-20261115"></a>

### 决定 65（2026-11-15）：网易云外链使用官网播放指令，验收必须到真实客户端

**症状**：双击有网易云链接、无本地音频的《おとなの掟》（成人法则），music-atlas 提示已打开，
网易云也确实出现了，但仍停留在上次的歌曲。这不是「客户端没安装」：只读检查发现 `orpheus`
协议已注册，错误在于**系统能分发协议，不代表客户端认识后面的业务指令**。

**五个坑与对应修正**：

| 坑 | 解决方案 |
|---|---|
| 把 `orpheus://song/<id>/?autoplay=1` 当成已验证的 PC 播放协议 | 改用官网格式：`orpheus://` + `{ "type": "song", "id": "458725738", "cmd": "play" }` 的 UTF-8 Base64；保留字符串编号，移除隐藏网页抓入口的旧路径 |
| 作品走 `netease:open`，录音版本走只开网页的 `link:open` | 两个 IPC 统一到 `openMusicLink()`；无本地音频时，作品也检查第一录音版本的链接，指定版本双击仍只播放该版本且不改排序 |
| 任意 URL 的 `id` 或长数字串都被当成歌曲编号 | 只识别网易云域名及歌曲路由，支持 query/hash/path；不把专辑、歌单、userid 或伪装域名当歌曲；入口拒绝非 HTTP(S) 及带账号密码的 URL |
| `shell.openExternal()` 没抛错就显示已播放，失败就猜客户端未安装 | 成功仅显示「已发送播放请求」；客户端系统调用失败才回退原网页，全部失败保留实际错误，不推断安装或账号状态 |
| 实现和冒烟都写死同一条错误链接，测试通过却不能用 | 解码指令并核对语义、模拟系统失败分支，再到真实客户端核对曲名和播放状态；不以窗口出现或本应用的提示作为终点 |

**协议依据**：2026-11-15 检查[官网歌曲页](https://music.163.com/song?id=458725738)引用的
[当日 core 脚本](https://s3.music.126.net/web/s/core_d6d4797f1d4a94aa615ceca52518c8a3.js?d6d4797f1d4a94aa615ceca52518c8a3)，
「打开客户端播放」分支使用 `orpheus://` 加 `{type:"song", id:songId, cmd:"play"}` 的 Base64；
编码函数调用 `window.btoa`。随后通过本机 Electron `shell.openExternal` 实测切歌并进入播放状态。
脚本哈希会随官网发布变化，这里记录的是当日证据，**不是保证未来所有客户端版本永久兼容**。

**落点**：协议解析/生成在 [src/shared/netease.js](../src/shared/netease.js)，外呼与回退在
[src/main/ipc/netease.ts](../src/main/ipc/netease.ts)，界面入口在
[src/renderer/src/App.vue](../src/renderer/src/App.vue)，回归在 [tests/netease.test.mjs](../tests/netease.test.mjs)。
本次没有改 JSON schema、数据库迁移或系统协议关联。

**实际验证（本机 Windows，Electron 44.10.1）**：

- 新增 **41 项**外链单元测试；完整单元测试 **354/354** 通过，`npm run build` 通过。
- 独立数据副本中，实际双击作品链接播放《成人法则》；仅录音层登记链接时，
  双击作品播放第一版本对应的《The deepest nightmare of Sibyl》，双击第二版本再切回《成人法则》；
  客户端显示目标曲名，播放控件进入暂停按钮状态，默认版本和排序保持不变。
- 本地音频回归读取播放时钟：采样间隔 800ms 内由 0 前进至约 330ms，`paused=false`、媒体错误为空，
  验证后暂停；无音源作品显示明确提示，非法协议由 IPC 拒绝。
- 测试实例使用独立 `MA_DATA_DIR` 与 `--user-data-dir`，操作前核对 `api.meta().dataDir`；
  27 份原始曲目 JSON 的 SHA-256 前后相同。测试后暂停网易云并正常关闭测试实例，保留用户原窗口。
- 主进程修改已构建，但原窗口仍运行旧代码；保存编辑并重启 music-atlas 后生效。

**后续（2026-11-16）**：完整冒烟已补跑并通过，**577/577**；
未安装客户端的回退仅用模拟系统调用失败验证，未卸载真实客户端测试；跨平台、其他客户端版本、
完整冷启动及登录/播放权限受限场景尚未实测。短链、专辑和歌单当前仅打开原网页，没有自动播放保证。
后续边界记在 [PENDING](../PENDING.md#netease-playback-limits)，长期排障与验收约束见 [RULES §33](RULES.md#netease-playback)。

**速度术语本地化**：`tempo_marking.json` 的每条有 `name`（意大利语 / 英语）和
`display`（中文）。新增 `renderer/src/movementLabels.ts` 缓存术语，`tempoLabel()` 按
id / name / display / 别名四种写法匹配：

- 详情「Tempo term」显示、双击进入编辑时的初值、标题模板的 `%Tempo Term}` 都走它；
- 英文界面显示 `name`（Allegretto / Menuetto），中文显示 `display`（小快板 / 小步舞曲）；
- 词表里没有的自由文本原样返回，不吞用户输入。
- 术语缓存只读一次，由 App 启动时加载；标题展开是 computed，术语加载完会自动重算。

**验证**：`npm test` 313、`npm run check` 14/14、`npm run build`、
`npm run smoke` **573/573**。新增冒烟断言：切英文后详情标签为 `Sub-Type` /
`Tempo term`，值为 `Menuetto` / `Allegretto`，详情标题与乐章行同时变成
`I. Menuetto - Allegretto`；迁移后的模板仍显示「第二乐章 - 柔板」。

---

<a id="timeline-only-20261116"></a>

### 决定 66（2026-11-16）：放弃不可得的网易云自动同步，先做显眼的「仅时间线」播放

**目标**：让没有本地音频的作品也能出现在时间线上的播放头，配合逐版本原点偏移，
最终让指针扫过和弦标记；如果可能，再直接读取本地网易云客户端的播放进度做同步。

**先验证「能不能同步」**：Windows 10.0.19045 上用官方 WinRT
`GlobalSystemMediaTransportControlsSessionManager` 读取 `cloudmusic.exe`：
曲名、作者、`Playing/Paused` 都正确，但 `Position`、`StartTime`、`EndTime`、
`MinSeekTime`、`MaxSeekTime` 全部为 0，`LastUpdatedTime` 是未初始化值，`CanSeek=false`；
播放中和暂停时采样结果相同。展开播放页后，无障碍树里也没有进度控件或可读数值。
微软文档只说明 `Position` 是「截至 LastUpdatedTime 的位置」，不保证客户端会填。
因此**公开、可审计的接口拿不到播放时钟**，自动同步不做；也不采用读内存、注入进程、
私开客户端内部接口等方式。若将来官方接口提供时间，再在 `sourceMode` 契约下补。

**降级实现**：没有本地音频时进入 `timeline` 模式——一条独立的墙钟时间线：

- 新纯函数 `shared/timeline-clock.js`：位置 = 起点 + `performance.now()` 差值，
  暂停冻结、跳转重锚、到末尾停止、改时长保留位置；不按 rAF 帧数累加，掉帧不会变慢。
- `audio/store.js` 增加 `sourceMode`（`audio` / `timeline` / `none`）：
  `audio` 分支保持原有 `<audio>`、编码器预热、波形、EOF 保护和错误处理；
  `timeline` 分支不创建/不播放 `<audio>`，进入前摘掉旧 `src`，避免「没音频却突然响旧文件」。
- `state.ready` 在时间线总长 > 0 时为真，播放键、回退、进度拖动、读数跳转和
  「以播放头为原点」都能用；播放条显示「仅时间线」徽标，总时长可点开手改。
- 总长由 `timelineDurationMs(analysis)` 计算：档案终点（最后段落 +10 小节 / 最后事件 /
  最少 48 小节，按拍号与速度换算）+ **当前版本自己的** `audio_offset_ms`。
  手动总长只活本次会话，不写 JSON / 数据库；切曲目或版本会重置。
- 外链录音版本先 `loadTrack(trackId, recId)` 成为当前版本，再打开外链：
  直接双击版本行也走 `loadRecVersion()`，否则原点还停在上一个版本，对轨会整体偏。
- 双击外链作品 / 版本时，客户端唤起成功则从 0 启动时间线，状态栏明确写
  「未与客户端同步」；启动延迟不补偿，需要帧级精确时用录屏 + 剪辑软件按波形对齐。
  没有外链、只有档案的项目，双击也回落到静音时间线，避免「点了完全没反应」。
- `PlayerState` 增加 `sourceMode`；独立窗口同步徽标、总长和 `ready`，改总长发
  `{type:'duration', ms}` 指令给主窗口执行。仍遵守「主窗口唯一音频宿主」和
  「主窗口在放另一首时不给它发播放指令」的既有规则。

**卡点证据**：Sibyl（130 BPM，4/4）把当前外链版本原点设为 5000ms 后，
`seekMs(5000)` → `seekMs(5000 + 4拍)` 的播放头位移 56px，
`xOfTick(1920) - xOfTick(0)` 也是 56px；原点输入框显示 5000，标题读「第 1 小节的音频位置：0:05.000」。
这说明时间线与本地音频共用 `msToTick(tempos, ms - audioOffsetMs)` 同一条映射。

**顺带修复**：全新 `userData` 没有 `ma-gain` 时，`restoreGain()` 里
`Number(localStorage.getItem('ma-gain'))` 把 `null` 变成 0，导致首次启动主输出静音。
现在先判断 `=== null`，没有存值保持默认 0 dB；存过 0 的用户仍保持静音。

**验证**：`npm test` **363** 通过（新增 `tests/timeline-clock.test.mjs` 9 条）；
`npm run build` 通过。隔离数据 + 隔离 profile 实测：
时间线播放 500ms 内前进约 500ms，暂停后 300ms 不动；拖到 10000ms 生效；
手动总长 10s 后从 9.7s 播放 0.7s 会停在 10s；独立窗口按播放/暂停能驱动主窗口时钟；
主窗口把总长改为 20s 后独立窗口显示 0:20.000；切回本地 FLAC 后
`sourceMode=audio`、播放时钟正常前进且无媒体错误。最终构建的隔离实例中，
双击只有外链的录音版本会先切到该版本（`audioRecId` 等于点的行）、再发客户端播放请求并启动
仅时间线，状态栏显示「未与客户端同步」；全新 profile 的 `gain=1` 且没有写入 `ma-gain`。
最终构建再验「连外链都没有」：双击作品行启动静音时间线，350ms 采样内指针前进 350.8ms，
提示「没有外部音源，已启动仅时间线」。
冒烟 **577/577** 全绿（连续两轮），包含新增的两条「仅时间线」断言。

**已知边界**：自动同步目前无解；外链启动延迟会让指针先于客户端声音；
手动总长不持久化；短链 / 专辑 / 歌单仍只打开网页；独立窗口播放仍要求主窗口在同一首，
且它仍按作品级 offset 画网格、不带当前录音版本 id，逐版本对轨请以主窗口为准；
时间线不发声，因此不能替代「听音频判断卡点」，只能配合外部播放或录屏使用。
后续取舍记在 [PENDING](../PENDING.md#timeline-sync)，操作约束见 [RULES §34](RULES.md#timeline-only)。
