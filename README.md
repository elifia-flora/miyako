# miyako（原名 music-atlas）

本地音乐标签库 + 和声分析网格。Electron 44（Chromium 152 / Node 24）+ Vue 3 + Vite + better-sqlite3，手写 CSS。

> **内部开发版本，仍在改进中。** 当前 **v0.99**，界面、数据结构、快捷键都还可能变；
> 现在放出来是把「一个能读、能跑、能改的仓库」先交出来，不是「可以拿来用的成品」。
>
> **随时可能有破坏性更新。** 词表结构、JSON schema、数据目录、快捷键、甚至本地存储的键名，
> 都可能在某个版本里不兼容地改掉，而且不保证提供迁移工具。升级前先备份 `data/` 与
> `<userData>/config.json`；要长期用就往 fork 自己的仓库里改。每次不兼容的改动都会在
> `docs/schema-log.md` 里留一条决定记录，但「记录过」不等于「帮你迁好」。

## 下载

| 平台 | 怎么拿 |
|---|---|
| **Windows** | [Releases](https://github.com/elifia-flora/miyako/releases) 里下 `miyako-*-setup.exe`（安装）或 `miyako-*-portable.exe`（免安装，解压即用）。没有代码签名，Windows 可能拦一下 →「更多信息 → 仍要运行」 |
| **macOS** | [Releases](https://github.com/elifia-flora/miyako/releases) 里有 `miyako-*-arm64.dmg` / `.zip`（Apple Silicon）。没签名没公证，第一次打开要「右键 → 打开」 |
| **Linux** | 同一页有 `miyako-*-x86_64.AppImage`，双击即用（没权限就 `chmod +x`） |

自己打：`npm run dist:win` / `dist:mac` / `dist:linux`。**macOS 版必须在 macOS 上打**
（dmg 依赖 hdiutil、签名依赖 codesign，交叉编译不被支持）——所以才配了 Actions。

装好之后数据在 `%APPDATA%\miyako\data`（Windows），
第一次启动会从安装目录复制一份种子过去：**词表 + 泳道方案 + 27 条曲库档案**
（`data/tracks/*.json`，不含 `.archive/` 里的归档条目）。

## 这个项目是干什么的

传统音乐库靠**树状分类**活：作曲家 → 体裁 → 作品 → 乐章。古典那套还撑得住，一旦碰上
「融合 / 跨界 / 说不清是什么」的音乐就崩 —— 一首曲子同时是爵士、电子、游戏配乐，中间还
带一段赋格，而树里只能给它一个父亲；硬塞进去，以后就再也找不到它。

`miyako` 换成**标签 + 多维度词表**：作曲家、体裁、时期、调性、自定义标签各算各的维度，
一首曲子可以同时挂很多个，筛选与搜索按维度组合，不需要先决定「它属于哪一类」。

第二个功能是**和弦进行的记录与查看**：在时间线上按真实拍号画网格（小节 / 拍 / 半拍），
框住一格直接输和弦，Enter 往后顺延；网格能跟音频对齐，播放头扫过时可以听一小段。
不用再去 Excel / WPS 里手动画表格、调列宽、对不齐还得挪一下午。

面向**音乐学习者与研究者**：手里有一堆曲目要整理、有和声要标注、有「听起来是这样」的
判断要写成能复查的记录 —— 这个工具就是为这三件事做的。

## 许可与走向

- **Apache License 2.0**（见 [`LICENSE`](LICENSE)）。本仓库自己写的东西 —— 源码、文档、
  词表、schema —— 全部在这个协议下，**以后也保持**：后续版本、修 bug、重构都继续以
  Apache-2.0 发布，不会出现「先开源、后闭源」的转向。
- 作者**可能会做收费的在线服务**（云端曲库、同步、协作、音频分析之类）。收费的是**服务**，
  不是这份代码：你仍然可以按 Apache-2.0 自行部署、修改、分发，包括商用。
  仓库里的代码不会因为有了在线服务而收回授权。
- **不在协议范围内**的只有第三方素材：他人作品的封面、歌词、示例音频等，
  版权归各自权利人，**不随本仓库分发**（详见下面的「仓库里不放什么」）。

## 讨论、Issue 与 PR

- **Issue / 讨论是开放的**：用得不顺手、发现有 bug、觉得某个决定不对，都欢迎开 Issue 说。
  这个项目还在改，反馈很可能是下一版的方向。
- **但请不要直接推 PR**（受邀请的维护者除外）：现在没有接受外部补丁的流程，
  代码风格、数据结构、交互决定都在快速变，review 一个 PR 的成本比我自己写还高。
- 想改的话：**fork 一份，按你的想法改，放到你自己的仓库里**。Apache-2.0 允许你这么做，
  不需要问、也不需要保留我的署名之外的东西（LICENSE 和版权声明要保留）。
  改好了愿意分享，开个 Issue 贴链接就行，我可以看看、但不会合并。

## 仓库里不放什么

几类东西刻意不进仓库，clone 下来是干净的代码 + 词表，没有别人的作品：

| 不放 | 原因 |
|---|---|
| 音频母带（`*.flac` / `*.wav` / `*.mp3` …） | 几十 MB 起步，且没有版权 |
| `data/covers/`、`data/lyrics/`、`assets/` 里的专辑封面与歌词 | 他人作品，仅在本机调试时使用 |
| `data/tracks/` 里**后来新登记**的曲目、`data/playlists.json` | 默认被 git 忽略（`.gitignore` 里逐个放行了要发布的那几条）。仓库与安装包只带那 27 条，不带 `.archive/` 里的归档条目 |
| `logs/`、`shots/`、`.smoke-*`、`.workbuddy/`、`HANDOFF.md`、`JUNK.md` | 运行产物与本机笔记 |

保留下来的是**词表**（`data/vocab/`）和**泳道方案**（`data/views/`）—— 它们是这个项目
真正的内容，也是「词表是源、数据库是缓存」这条规则的对象。想灌自己的库就把
`data/tracks/*.json` 按 `fixtures/` 里的 schema 放进去，启动时会被 seed 进 SQLite。

`assets/` 里另有**三份作者自己写的歌曲笔记**（`.md`）与**两张收款码**（微信 / 支付宝），
都是作者自己的内容，随后以 Apache-2.0（笔记）或作为项目素材一起放在仓库里。
支持弹窗是按文件名去 `assets/` 里找图的（`support:qrs`），所以换图只要改文件名里的关键字。

当前功能：曲库表格 + 可拖拽的底部网格面板（DAW 那种 lower zone）+ 独立网格窗口；
网格按「格」编辑（小节 / 拍 / 半拍），框完即输入、Enter 顺延、Backspace 回退；
Vue 绿高亮 + 深/浅双主题即时切换；搜索能认中文的时期与调式名。

## 跑起来

```bash
./start.cmd                  # Windows 双击/命令行都可以；缺 out/ 时会自动先 build
npm run app                  # 打开窗口后命令立刻退出（脚本里用这个，不会挂在终端上）
npm run dev                  # 开发模式（vite dev server + electron，带热更新）
npm run build                # 只构建到 out/
npm test                     # 纯函数单测：换算内核 / 网格数学 / 搜索 / 文件名 / 快捷键（401 项，含和弦解析 / 进行识别 / 小节时间码 / Tap / 时间码）
npm run check                # 校验词表/视图 JSON（无环、别名冲突、泳道字段）
npm run import               # 跑导入器，重出清洗报告 + data/tracks/神鹿谣.json
npm run smoke                # 构建后跑 602 项集成断言 + 截图到 shots/
                             # （窗口全透明、鼠标穿透、不进任务栏、全程静音，跑的时候电脑照常用）
npm run smoke:quiet          # 同上，但只打 FAIL + 汇总；完整清单写 shots/smoke-report.txt
npm run smoke:status         # 它还在跑吗？跑到第几条了
npm run fix:integrity        # 检查/修复工作区 Low 完整性标签（Electron 44 秒退时先跑它）
npm run app:debug            # 启动窗口并开 CDP（http://127.0.0.1:9222/json）
```

**跑冒烟不用关窗口**：它会把 `data/` 复制到 `.smoke-data/`、再用独立的 `.smoke-profile/`，
单实例锁按 profile 分、数据各一份，所以可以和你正在用的窗口并存。测试里登记的临时曲目、
改掉的偏移、被改写的词表 JSON 全留在副本里，真实档案不受影响（唯一共享的是 `shots/` 截图目录）。

冒烟窗口在这之上还有一层「隐形」：**全透明、鼠标穿透、不抢焦点、不进任务栏** —— 看不见也点不到，
所以不会挡你的屏幕、也不会被误点（误点会让断言莫名判红）。看不见又想知道进度就用
`npm run smoke:status`；想肉眼看画面用 `MA_SMOKE_VISIBLE=1 npm run smoke`（能看，但仍然点不进去）。

## 目录

| 路径 | 是什么 |
|---|---|
| `data/vocab/*.json` | **词表源**（可手改）。启动时展平进 `tag` / `tag_edge` / `tag_alias` 缓存 |
| `data/views/*.json` | 泳道方案（罗马数字 / 字母 / 黎曼功能 / 组成音） |
| `data/tracks/*.json` | **档案源**：启动时 seed 进库；界面上的改动会实时写回（登记作品也会落一份） |
| `data/tracks/.archive/` | 删除的曲目挪到这里（带 `archivedAt`），「维护 → 已归档作品」可彻底删除 |
| `data/atlas.db` | SQLite（开发期直接放这儿，方便和 JSON 并排看） |
| `logs/` | 运行日志（`boot.log` 等；`start.cmd` / `start.py` 也读这里，已 gitignore） |
| `src/shared/barbeat.js` | tick / 小节 / 拍 / 毫秒 换算内核，纯函数，`node --test` 直接跑 |
| `src/shared/grid.js` | 「格」的数学：每格 tick、框选对齐、选区描述；同样是纯函数 |
| `src/shared/search.js` | 搜索词的语义展开：古典主义 → classical、自然小调 → natural minor |
| `src/main/` | 主进程：db、词表、导入、IPC |
| `src/renderer/` | Vue 界面：曲库表格、canvas 网格、详情栏、设置 |
| `fixtures/` | 各版 schema 的样本，做回归 |
| `reference/` | 原始素材：`神鹿谣分析.json`（真样本源）＋ `tallydeck/`（播放器那边验证过的时间码/波形实现，供接音频时改造） |
| `docs/` | 开发计划、schema-log、清洗报告、**界面结构与指代对照（`UI-STRUCTURE.md`）**、**tick 换算说明（`TICK.md`）**、**输入手感（`INPUT-FEEL.md`）** |
| `.obsidian/` | 拿 Obsidian 打开仓库根目录就能看 `docs/`。这里**只有界面配置**（`app.json` / `appearance.json` / `core-plugins.json` / `workspace.json`）和 `snippets/` 里的标题配色 CSS，**不带任何插件** —— 插件的代码在各个库里自己的 `plugins/` 下，不在这儿 |
| `<userData>/config.json` | **启动配置**：歌词 / 动态操作帮助是否自动打开、安全模式。文件不存在时启动生成；选项 → 窗口里可直接打开手改 |
| `<userData>/wave-cache/` | 波形峰值缓存（可随时删；上限与清空在「选项 → 波形缓存」） |

## 界面里现在能做什么

### 布局：表格 + 底部网格面板

- 网格不是「切页面」，而是**浮在表格之上的下方面板**（DAW 的 lower zone）：
  上边缘的横条可以拖高度，双击收起/展开，`Ctrl+J` 开关，右侧 `×` 关闭。
- 面板右上角 `↗ 独立窗口`：用同一个渲染层、靠 `#grid?track=…&view=…` 路由，
  新开一个**最大化**的浏览器窗口专门放网格（主窗口继续用来看曲库/详情）。
- 面板高度、开关状态都写 localStorage，下次启动保持原样。

### 网格

- **格有三种粒度**：`小节` / `拍`（分母单位）/ `半拍`。3/4 一拍一格是 3 格，切到 `半拍` 变 6 格，
  切到 `小节` 整小节只有 1 格；变拍号时格宽跟着小节长度走，不是常数。
- **拖动框选，松手就开输**：拖出的矩形和单击一格松手后的表现一致，不用再补一次点击。
- **Enter 顺延**：输完按一次回车，写入当前选区，然后**选中后移同样格数**并继续输入。
  框了 3 格，回车后就是下 3 格；跨小节、变拍号都按格数走，不会错位。
- **Backspace 回退**：不在输入框里时按 `Backspace`，退回一格并直接进入输入状态（默认就是一拍）。
- **删除**：选一条事件按 `Delete`，或菜单「编辑 → 删除选中事件」；把已有事件的内容清空再回车 = 删掉它。
- **非破坏覆盖**：在跨 3 格的和弦上只改第 3 格，前两格会被**截短**而不是整条消失。
- **块边缘**：块内离边 7px 内可以拉宽/缩窄；块外不再向外扩，点下一格时不会被上一块抢走。
- **横向缩放**：`Ctrl/⌘ + 滚轮`只缩放网格的横向比例（不动整窗缩放），并且**锚定指针下的那一格**——
  缩放前后你盯着的那拍不会跑走。
- **撤销**：`Ctrl+Z` 或详情栏右侧「撤销」。撤销用整份事件快照回写——区间写入会截短/拆分，
  逐条反做不可靠（详见 `docs/schema-log.md` 决定 11）。
- **和弦解析**：`N` / `N6`（♭II 大三）念「那不勒斯」；`♭II7` / `♭II9` / `♭II7sus4` 这类属功能
  念「三全音替代」。进行识别除王道 / 万能和弦外，还认**丸之内进行**
  （IVM7–III7–VIm7–I7；要求 III 是属七，调内 iii7 不冒名）。
- **和弦补全**：宽框、单行不换行、斑马纹；打 `V6` / `V69` / `V6/9` 会同时递上 `V(6/9)`。
  字母和弦与级数候选共用 `data/vocab/chord-symbols.json` 的「性质」表，**数组顺序就是补全顺序**
  （编辑器里 `↑ / ↓` 调整）；裸 `ii` / `vii` 永远第一，半减七只在显式触发时出现。
  级数后 `h / half / b / ban / bj` 触发半减七，`h42` / `b42` 直接出 `iiø42`；`s` 出
  `sus2 / sus4 / sub6`，`7` 的前四条是 `7 → 7sus4 → 7♭9 → 7sub6`；级数前支持
  `b / j / jiang / jl`（降）与 `s / sheng / u / ug`（升）。`sub6` = 六音替五音，
  `V7sub6 = G–B–E–F`。模糊匹配不要求连续：`V76` / `V67` / `V6` 都能出 `V7sub6`；
  `Vs6` 的第一条是 `Vsub6`，第二条才是 `V7sub6`（同一档里首字符对上优先）。
  性质的「别名」只进说明（半减七 `ø` / `min7b5`），但参与输入匹配（`C7b9 → C7♭9`）。
- **播放条（Cubase 式）**：播放 / 回到开头 / 当前毫秒 / 进度 / 总时长 / 主时间（默认小节.拍）/
  次时间（默认时间码）/ 帧速率 / 当前速度 / 拍号 / Tap / 节拍器 / 原点 / 跟随 / 主输出。
  点时间读数可换格式，Alt+点击交换主/次；小节位置和详情「时间轴 · 段落」共用
  `BarBeatText`（4/2/2/3ch 固定，数字不补 0）；格式图标 `♩` / `TC` / 时钟，
  节拍器图标是镂空的竖长等腰梯形；主/次时间块不带 `▾`，空出的宽度让给进度条。
  节拍器设置跟随 Vue 绿。Tap 结果会弹窗确认（也可手动输入）。
  音频文件名和「选择音频」不再出现在播放条上（换音频走录音版本管理）。

### 其他

- **表格**：曲名 / 拍号 / BPM / 时长 / 时期 / 调性 / 段落数 / 标签数；左侧 2px 竖线表示选中（不整行反白）。
- **搜索**：一个框搜曲名、作曲家、**时期**、**调性**、标签（含别名）。
  中文两字走 `LIKE`，≥3 字符同时并上 FTS5；但时期与调性在库里是英文规范值，
  所以先经 `shared/search.js` 把「古典主义 / 自然小调 / 多利亚」翻成 `classical` / `natural minor` / `dorian` 再匹配。
  时期与调性的命中条件必须和曲名放在**同一组 OR** 里，拆成独立 AND 会让中文时期搜索全空。
- **详情栏**：标签按维度分组、可增删；标签输入支持别名 / 前缀 / 编辑距离 ≤2；段落表带换算时间与当时调性；`audio_offset_ms` 可改并持久化。
- **孤儿报告**：库里仍被引用、但词表 JSON 里已删除的标签 —— 只报告，**绝不静默删**。
- **设置（⚙）**：界面缩放 80%–200%（Chromium 原生缩放，`Ctrl + = / − / 0`），
  界面字体可在「无衬线 / 等宽」间切；网格 canvas 始终等宽。
- 深/浅双主题，高亮色用 **Vue 绿**（`#42b883`，浅色主题压暗到 `#2f9e6b` 保证白底可读），
  数字 `tabular-nums`。切主题时 canvas 靠 `MutationObserver` 监听 `<html data-theme>` 立刻重绘。

### 外链播放（2026-11-15 修正）

- 双击作品仍优先播放本地音频；没有可用本地音频时，先取第一录音版本的外链，再回退到作品的网易云链接。
- 双击录音版本只打开该版本的音源，不修改默认版本或排序；网易云歌曲链接优先唤起客户端，其他网页链接交给浏览器。
- Windows 客户端使用 **`orpheus://` + Base64 编码的歌曲播放指令**，不是 `song/<id>/?autoplay=1`；系统接受链接不等于歌曲已经播放，界面只提示「已发送播放请求」。
- 客户端唤起抛错时回退到原网页；短链接、专辑和歌单目前不转换为歌曲播放指令，打开网页不保证自动播放。
- 排障与验收见 [RULES §33](docs/RULES.md#netease-playback)，历史纠正见 [决定 65](docs/schema-log.md#netease-playback-20261115)；协议回归可运行 `node --test tests/netease.test.mjs`，不会真的打开客户端或浏览器。
- 修改主进程后要重新构建并重启应用；已经打开的旧窗口不会因为 `npm run build` 自动更新。

### 无本地音频：仅时间线播放（2026-11-16）

- 选中没有本地音频的作品，或切到只有外链的录音版本时，播放条进入 **「仅时间线」**：
  播放 / 暂停 / 回到开头 / 拖进度 / 读数跳转都能用，播放头按墙钟前进；
  **不发声，也没有和网易云客户端同步**。
- 双击外链作品或外链录音版本：先向网易云发送播放请求，成功唤起时从 0 启动这条时间线；
  状态栏会写明「未与客户端同步」。外链录音版本会先切为该版本，后续原点落在这**一版自己的** `audio_offset_ms` 上。
  连外链都没有的作品，双击会直接启动静音时间线（只走指针，不发声）。
- 对轨：用播放条原点的 ±10ms / 直接输入 / 「以播放头为原点」；网格的 tick ↔ 音频毫秒
  与本地音频共用同一套换算，所以指针扫过标记的位置和真实音频一致（差别只剩外部播放启动延迟）。
  总长按「档案终点 + 当前版本 offset」推算；点总时长可手改，**只影响本次会话**，不写 JSON / 数据库。
- 为什么不做自动同步：Windows 公开媒体接口只返回网易云曲名与播放 / 暂停，
  `Position` / `EndTime` / `CanSeek` 都是 0；本机也没有可读的进度控件。不注入进程、不解析私有数据。
  需要帧级精确时，录屏后到剪辑软件按波形对齐仍是可靠兜底。详见 [RULES §34](docs/RULES.md#timeline-only)
  和 [决定 66](docs/schema-log.md#timeline-only-20261116)。
- `node --test tests/timeline-clock.test.mjs` 覆盖时钟、暂停 / 跳转 / 末尾与总长计算；
  冒烟覆盖「无本地音频时播放键可用 + 指针前进后能停住」。

### 字体

- 界面默认 **无衬线**：`Segoe UI / Microsoft YaHei UI / system-ui`（`--font-ui`）。
  老版本把 mono 写进过 localStorage，启动时按 `ma-font-ver` 做一次迁移，否则用户看不到默认变了。
- 设置里可以切回等宽：`JetBrains Mono → Cascadia Mono → Consolas → Sarasa Mono SC → monospace`
  （`--font-mono`，本机实际命中 Cascadia Mono）。
- 网格 canvas 里的和弦、tick、调性名**始终等宽**，避免数字宽度变化导致对齐抖动。
- **变音记号（♭ ♮ ♯ 𝄪 𝄫）用自带的字体**，不走系统字体：中文字体把它们画成全角，
  降号又宽又胖，而且随「浏览器 / 系统默认字体」变来变去。现在捆了一份 5 KB 的
  `AtlasMusic.woff2`（子集自 Steinberg 的 Bravura，SIL OFL 1.1，依保留字体名条款改名为
  `Atlas Music`），通过 `unicode-range` 只接管这五个码位。见 `src/renderer/src/assets/fonts/README.md`。

## 两条硬规则

1. **词表是源，数据库是缓存**。`DELETE FROM tag; DELETE FROM tag_edge;` 后重启必须能由 `data/vocab/*.json` 完整重建。
2. **改表结构一律新增 migration 文件**，不动 `001_init.sql`。

## 踩过的坑（别再踩）

1. **`better-sqlite3` 13 用 N-API 预编译**：`npm install` 后普通 `node` 也能直接读 `data/atlas.db`
   （本机实测）。`postinstall` 仍会跑 `electron-rebuild`；如果你手动重建、把
   `build/Release` 覆盖成了 Electron ABI 的版本，普通 node 可能打不开，改用 Electron 的 Node：
   ```bash
   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe your-script.js
   ```
   注意 Electron 42+ 的二进制是**第一次运行才下载**的；没跑过 `npm run app` 时先跑
   `node node_modules/electron/install.js`。
2. **`ELECTRON_RUN_AS_NODE=1` 会污染启动**。命令行直接 `electron .` 会退化成纯 Node，报 `whenReady of undefined`。`start.cmd` / `start.py` / `launch.mjs` / `smoke.mjs` 里都已经清掉了；要在终端里手动跑探针，用 `node tools/launch.mjs …`，别直接调 `electron.exe`。
3. **`start.cmd` 保持纯 ASCII**。cmd.exe 按 OEM 936 读 .cmd，文件里的中文注释有编码风险；参数写 `"%~dp0."`（结尾点号），写成 `"%~dp0"` 会把引号吃掉。
4. **FTS 是 external content + 触发器**（002 迁移）。别再改回 `content=''` 手工维护，那种表删一条漏一条，脏了还不报错。
5. **Vue 的 reactive 值过不了 contextBridge**。`executeJavaScript` 返回 proxy、把 `selection.value.lanes` 直接塞进 IPC 参数，
   都会得到 `An object could not be cloned.`；过桥前一律 `JSON.parse(JSON.stringify(x))` 或展开成新数组。
6. **同一份 userData 不能起第二个实例**。旧窗口没关就再跑 `--smoke`，第二个进程会静默退出（看起来像「冒烟卡住」）。
7. **主网格 canvas 不要为了 `getImageData` 开 `willReadFrequently`**：Chromium 会把整张画布定到 CPU 后端，
   播放中每帧 `draw()` / `paintBand()` 全在软件光栅上跑，表现是「帧率 60 但画面发黏、窗口不跟手」。
   调试取样用独立的小画布（见 `docs/RULES.md` §20）。

## Electron 44（2026-10-26）

- 当前 **Electron 44.9.3**（Chromium 152.0.7977.167 / Node 24.22.0）。为什么选 44 而不是 45、
  Node 24.22.1 的安全修复何时跟进、升级时改了什么，见 [`docs/ELECTRON-UPGRADE.md`](docs/ELECTRON-UPGRADE.md)。
- **双击后窗口不出现、进程秒退（退出码 `0x80000003`）**：先查目录完整性标签
  `icacls . | findstr Mandatory`。DSH 的 workspace-write 会把工作区打成 Low，Electron 44 的沙箱不接受。
  **双击 `tools/fix-integrity.cmd`**（或 `npm run fix:integrity`）即可修复；`npm run app` /
  `npm run smoke` / `start.cmd` 启动前也会自动检查。等价命令：
  ```powershell
  icacls . /setintegritylevel (OI)(CI)Medium
  icacls .\node_modules\electron /setintegritylevel (OI)(CI)Medium
  icacls .\out /setintegritylevel (OI)(CI)Medium /T
  ```
- **别直接 `electron . --smoke`**：会写真实库；用 `npm run smoke`。

## 帧率 / 高刷

播放头、波形和界面动画都走 `requestAnimationFrame`，**跟显示器的当前刷新率走，代码里没有
“锁 60”的开关**：

- 60Hz → 约 16.7ms/帧；75Hz → 约 13.3ms/帧；90 / 120 / 144Hz 同理，切到高刷模式后自动生效。
- 本机实测显示器当前为 **3440×1440 @ 59Hz**；在 Windows 显示设置里切到 75Hz 模式，
  播放头会跟着变快、变顺，不需要改任何代码或加启动参数。
- **不要**用 `--disable-frame-rate-limit` 强行解除上限：显示器本身只有 59/75Hz 时，
  多出来的帧不会显示出来，只会撕裂、发热、拖慢其它窗口。
- 想自己验证：播放 5 秒看 `__ma.perf().hotBlits` 的增量，60Hz 约 300、75Hz 约 375；
  或在 DevTools 里量 `requestAnimationFrame` 的间隔。

## 还没做

- 音频播放与波形（`TransportBar` 目前是占位；对齐工具只做了偏移输入）
- 段落 / 调性 / 拍号 / 速度的可视化编辑（现在只能在详情栏看，写库接口已就绪）
- 时期/调性做成可点的筛选胶囊（现在只能敲到搜索框里）
- 拖动移动事件、复制/粘贴、多轨同时编辑
- 两个窗口之间的实时同步（现在各自改完刷新才看得到对方的变化）
- 标签合并的界面入口（`tags.merge` IPC 已实现，没有按钮）
- 打包分发（`electron-builder`）、打包后的数据目录切到 `userData`
- 和弦符号解析（`analysis_event.parsed` 字段已留，解析器未写）

## 下一步建议

先接音频播放（`reference/tallydeck/` 里的时间码与波形实现已经验证过），
用 `audio_offset_ms` + 播放头把网格对齐；再做拖动移动事件与和弦符号解析——
有了时值精确的事件，解析器才有东西可解析。

- `data/playlists.json` —— 播放列表（`{ schemaVersion, lists: [{ id, name, trackIds }] }`）。
  「全部曲目」不在文件里，它是界面上的虚拟一条。
