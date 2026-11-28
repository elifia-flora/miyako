# 细则（RULES）

> 开工入口是根目录 [`AGENTS.md`](../AGENTS.md)。本文件是细则：不看就会踩的细节。
> 新窗口：`AGENTS.md` → 本文件里**相关的节** → 手感还没定时再看 [`PENDING.md`](../PENDING.md)。
> **不要通读，也不要把本文件抄进 `AGENTS.md`。** 节号是历史编号，中间有插号，用下面的目录跳。

## 目录

1. 红线补充
2. 数据模型 / 档案
3. 拍号类型的界面
4. 和弦解析（最易「静默旧结果」）
5. 低音行：从级数填充（v0.35）
6. 时间线标记（调性 / 段落）
7. 曲目列表（⑤）
8. 网格：选区与手势
9. 网格：视觉 / 时间码 / 绘制
10. 详情栏 / 跟随播放头
11. 曲名 / 译名
12. 补全
12.5 音频时间轴：编码器预热（v0.86）
13. 音频宿主 vs 从属窗口
14. 操作历史 / 工作区（v0.37）
15. 帮助窗（`#help` / ActionHelp.vue）
16. 子窗口：主题 / 缩放 / 尺寸
17. 偏好开关（渲染层 localStorage）
18. 清理 / 冒烟 / 启动
19. Electron 44 / 自定义协议（2026-10-26）
20. 播放性能（2026-10-26）
21. 播放条 / 日志（2026-10-27）
22. 字体：变音记号必须自带（v0.66）
23. 侧栏（Obsidian 式，v0.67）
24. 曲目列表：右键菜单 / 树箭头（v0.77）
25. 侧栏宽度 / 整体收起（v0.84）
26. 注释密度（2026-11-08 用户提出）
27. 音频元数据（v0.87）
28. 网格多选与方向键（v0.88）
29. 方向键 = 光标（v0.89）
30. 元数据填档案：先确认再写（v0.89）
31. 标题模板（2026-11-15）
32. 启动配置外置 config.json（2026-11-15）
33. 网易云外链播放（2026-11-15）
34. 无本地音频：仅时间线播放（2026-11-16）
35. 加一门界面语言（v0.90 · 日语）
36. 窗口与面板几何：config.json 自动记忆（v0.92）
37. 繁體中文：一份源码 + 一份生成物（v0.93）
38. 下方面板：分栏而不是浮层；细滚动条自绘（v0.93）
39. 播放头步长、扫过发声、模板字体（v0.95）
40. 模板字体统一、候选只有一份、模态叠层（v0.96）
41. 模板变量补全（v0.98）
42. 光标对齐、乐章尾段补全、术语回写（v0.99）

---

## 1. 红线补充（编号接着 HANDOFF §2）

- **有不清楚的地方先问用户，不要猜着继续做**。用户表达不强不是替他猜的理由；
  先复述自己的理解 / 给出二选一，再动手。尤其是「样式像什么」「哪个数据更准」这类
  没有唯一答案的要求 —— 猜错会白烧一轮上下文和测试。
- **用户手工改过的数据比自动结果更准**：见 §2「JSON 是源」下面那条；该提交就提交。

17. **新开任何窗口都要接进「缩放同步」**：创建时 `matchMainZoom(w)`，主窗口改缩放时靠
    `applyZoomToChildren()`（`ui:setZoom` 里调）。以前只有歌词窗跟，帮助/历史/独立时间线全是原尺寸。
    **桌面歌词例外**：它 `height:100vh` 贴满屏幕，缩放后只占屏幕一半、位置和拖动都对不上。

18. **帮助窗是唯一「窗口边界也跟着缩放」的窗口**（`fitHelpWindow()`）。
    `setZoomFactor(1.25)` 只放大内容，物理尺寸不变 → CSS 视口从 520 缩到 416 →
    文字全换行 → 内容比窗口高 → 底部被裁（用户报的「放大后有些内容看不到」）。
    正解：物理尺寸 = **CSS 尺寸 × z**（宽也要乘！只加高度会让排版变窄）。
    这样 CSS 视口恒为 520×内容高，排版与 100% 时一模一样。
    其他窗口暂不接（列表本来就窗内滚动）。

19. **弹层（补全 / 下拉 / 气泡 / 菜单）一律 Teleport 到 body + `position: fixed`**，
    坐标按锚点的**屏幕**位置现算，**优先向下**；向下装不下就翻到上方；
    两侧都不够时取空间大的一侧并把 `max-height` 收到剩余空间（内部自己滚）。
    **别用 `position: absolute` 留在面板里**：面板下方还有详情条/播放条，它们是后置同级元素，
    有底色 → 直接把浮层盖掉半截；窗口边缘还会把它切掉。
    冒烟验收要用 `elementFromPoint` 打一次命中测试（量坐标不够，被盖住的元素坐标也是对的）。

20. **`ⓘ` 这类「点一下钉住」的浮层**：鼠标离开延迟 **0.6s** 关（给人挪进气泡的时间），
    这 0.6s 内 `mouseenter` 到气泡上要取消定时器、在气泡里操作也不许收；
    点图标切换钉住，点页面别处 / Esc 关。气泡必须 `pointer-events: auto`（否则永远收不到 mouseenter）。
    图形用 **SVG** 画，别用「小方块 + 1px 描边 + border-radius」——那个圆环在 125% 缩放下
    落在半像素上，一圈全是锯齿。

26. **转位序号的写法是全局偏好**（v0.76）。
    - `shared/numeral.js`：模块级 `style = 'han' | 'arabic'` + `numeral(n, locale)`。
      中文默认汉字（第一转位），可切阿拉伯（第1转位）；英文固定 `1st / 2nd / 3rd`，与偏好无关。
    - i18n 一律写成 `{n}` 模板：`chord.inversion.1/2/3`、`grid.sug.fig.inv`、`grid.sug.romanInv6`。
      **不要再把「第一转位」写死在字符串里**，否则这个开关会漏掉一半地方。
    - `describeChord()` 这类 shared 函数拿不到偏好，所以它是全局可变状态；
      界面用 `renderer/numeralStyle.ts` 的 ref 建依赖（`void numeralStyle.value`），
      `applyNumeralStyle()` 同时改 ref / shared / localStorage，并广播 `ma:prefs`。
    - 选项**只在中文界面显示**（英文下选了也没效果，不给这种开关）。

25. **设置面板是「左 tab + 右滚动」**（v0.76）。
    - 15 个 `.s-sec`，**每个都必须带 `data-group`**（look / edit / play / win）：
      tab 跳转靠它找锚点，scroll spy 靠它数分组。漏一个就会跳空。
    - 跳转**不要用 `scrollIntoView`**：它会连带滚动所有祖先（整个页面跟着跑）。
      改成 `el.offsetTop` + `panes.scrollTo({ top, behavior: 'smooth' })`。
    - 点击后 **700ms 内 spy 不接管高亮**，否则平滑滚动途中会一路闪过去。
    - 滚到底时**强制高亮最后一组**，否则最后那一两个矮块永远选不中。
    - 面板 600px = 104(tab) + 12(gap) + 约 460(内容) —— 内容区宽度与加 tab 之前一致，
      不要为了塞 tab 把内容挤窄。

24. **新要求与已定规矩冲突时，先问一句，别自己拍**（2026-11-07，用户点名要记的）。
    - 触发条件：新要求与 `RULES` / 已有测试 / 之前确认过的口径**正面矛盾**时。
    - 正确动作：**复述那条旧规矩 + 指出冲突在哪 + 给两个选项**，等用户答复再动手。
      只有用户明确说「就按新的来」，才覆盖；覆盖时在旧规则处标注「已废弃（日期 + 原因）」。
    - 反例（真实踩过）：用户说「打 t 第一条要 tsVI」，这直接顶掉「完全相等永远第一」。
      当时我判成「用户明确要的」，实现了还写注释「别再改回去」；结果用户是记错了，
      第二天又要改回来 —— 一来一回，代码里还多了一段自相矛盾的注释。
    - 例外：纯外观微调（颜色 / 间距 / 圆角 / 文案措辞）不算冲突，直接改。

23. **所有浮层都必须「点别处就关」**，不能只有 Esc（2026-11-05）。
    - 侧栏播放列表的右键菜单也照这条办（`App.vue` 的 `onDocPointerDownPl`）：label 整行
      和每个列表项都能唤出来，`position: fixed` + 开之前夹进视口。
    - 菜单 / 下拉 / 气泡统一挂 **document 冒泡阶段** 的 `pointerdown`：
      浮层自己 `@pointerdown.stop` 把内部按下吞掉，外面的监听就天然只处理「外面」。
      **别用 capture 阶段** —— 它先于 target 触发，`stopPropagation` 拦不住，点菜单里的按钮会把菜单关掉。
    - 判据：右键开菜单 → 点详情面板 / 侧栏 / 播放条，菜单必须消失，而且那一下点击要生效（不是只关菜单）。
    - 踩过的样子：三个「从…获取…」的右键菜单只有 Esc 能关，去点别处它一直挂着，还挡住底下的格子。
    - 浮层里的文字用空格分段（`从 级数标记 获取 低音填充`）时，按钮要 `white-space: nowrap`，
      否则窄窗口下会折成两行、菜单高度乱跳。

22. **每个可编辑字段都必须有「未填写」的灰字占位**（2026-11-04）。
    **新增任何字段都要执行这一条**，不是只给这个字段做完就算。

    - 值元素挂 `:class="{ empty: !值 }"`（或容器挂 `.empty`），占位文案用 `t('detail.none')`。
      CSS 已有两条：`.empty .editable` 与 `.editable.empty`，都落到 `--text-faint`。
    - **`.d-row > .v` 与 `.editable.empty` 权重相同（0,2,0）**，谁写在后面谁赢 ——
      挪一下样式文件里的顺序就静默失效。所以 `.d-row > .v.empty` 另写了一条显式规则；
      以后新增值容器要么复用这条，要么自己写一条显式规则，**别靠源码顺序**。
    - 判据：空值必须让人一眼看出「这是没填」，不是「填了一个很淡的词」；
      同时它仍然要能双击进入编辑 —— 灰的是状态，不是禁用。
    - 新字段的完整验收清单：① 空值灰字 ② 悬停显可编辑 ③ 双击进输入 ④ Enter / Esc 与别的字段一致
      ⑤ 写库后 JSON 有镜像 ⑥ 搜索能按词表展开命中 ⑦ 冒烟有一条断言。
    - 同一类「空态」还有 `<p class="faint tiny">`（整块没内容时的说明句）——
      那是「这一块没有数据」，与「这一行没填」不是一回事，别混用。

21. **删除白名单已开（2026-10-26）**：AI 可以直接删冒烟垃圾
    （`.smoke-data-*` / `.smoke-profile-*` / `.theme-probe*` / `.verify-profile` / 根目录 `*.log` /
    `shots/inspect-*.png`），删前先 `ls` 确认、删后 `git status` 确认没动到源文件。
    **绝对不碰**：`data/`、`assets/`、`.git/`、`node_modules/`、`out/`、最新 `smoke-*.png`。

---

## 2. 数据模型 / 档案

- 标签维度 `instrument` / `instrument_technique` / `composition`，
  外加三个"词表驱动的单值字段" `genre` / `composition_type` / `form`。
  `tag.id` **全局主键，不可跨维复用**（`fugue` 只能属于一个维度；曲式里用 `fugue-form` 避让）。
- **流派 ≠ 体裁 ≠ 曲式**：流派答「哪一路写法」，体裁答「什么作品」，曲式答「什么骨架」。
  `genre` 存词条 **name**（`Jazz`），`composition_type` / `form` 存 **id**（`symphony` / `sonata-form`），
  情绪存 id（`nostalgic`）。**时期 ≠ 流派**。
- 赋格是体裁也是曲式，两处都能填；它**不是**作曲技法（2026-11-04 已从 `composition.json` 删除）。
- **级数与字母和弦是两条泳道**（迁移 010）：`degree` = 罗马数字级数，`chord` = 绝对和弦
  （`Cmaj7`）。四个视图不再共用一行 —— 同一小节可以各存一条，互不覆盖。
  判断「这一行是不是和弦行」用 `CHORD_LANES`（`shared/chord.js`），**不要写死 `'chord'`**：
  以前 `followSelectAt` / `selectUnitAt` 写死了，拆分之后会在级数视图里永远选不中。
  补全语境也跟着分：`degree` → 级数候选，`chord` → 字母和弦候选（见 `GridEditor.cellContext`）。
- **作品层 vs 录音层**（迁移 004）：作曲家/时期/调式在 `track`；演奏家/乐团/指挥/混音/母带/发行年在
  `recording`（刻意没有 composer）。`syncTrackFromRecording` 必须**保留** `track.file_path`
  （否则切版本把能播的歌弄哑）。
- **当前版本 ≠ 默认版本**：`is_default`（点作品播它）vs `audioState.recId`（波形画哪版）。
- **顺序即播放优先级**：`seq_order` 是唯一真相；新增用 `MAX(seq_order)+1`；
  `is_default` 必须**先全清零再置 1**并包事务。
- **原点偏移属于录音版本**（迁移 006）：写只走 `recording.setOffset()`；
  读：主录音 → 试听版本 → 退 `analysis.audio_offset_ms`。
- 删曲目必须**同时软删 analysis**（查询按 `deleted_at IS NULL`）。
- **JSON 是源**：每次写库都要镜像回 `data/tracks/<曲名>.json`（`syncTrackJson`/`syncByAnalysis`），
  新增写入口必须顺手加 —— 漏掉不报错。`uuid` = `track.id`；**录音层不进 JSON**。
- **「未标注」是真实状态**（决定 56）：`analysis.tempo_value` / `meter_num/den` 可以为 NULL，
  新建作品、缺字段的 JSON 导入都**不补假默认**，JSON 里写 `meter: null` / `bpm: null`。
  4/4 · 120 只是 GridEditor / TransportBar / barbeat 在没有 marker 时的**渲染兜底**，
  不许回写档案；详情页显式显示「未标注」，编辑框留空 = 清除回未标注。
- **播放列表只存 JSON**（`data/playlists.json`，见 `main/ipc/playlists.ts`）：它是「人的组织方式」，
  不是档案属性。放进 SQLite 就会变成「删库就没了」的第二种真相。
  「全部曲目」是虚拟 id `__all__`，**不写进文件**；写入走 `.tmp` + rename 的原子替换。
- **用户手改过的数据是更准确的数据**：`data/tracks/*.json`、`data/vocab/*.json` 里的手工改动
  不要用旧快照/自动结果覆盖；测试或改功能前后看到 `data/` 有 diff，先确认是不是用户改的，
  是就随本轮一起提交，别把它留在工作区当“噪音”。
- **删除 = 归档**（`.archive` + `archivedAt`）；彻底删除走 `purgeArchived`（库行 + 文件）。
  脚本物理删库必须同时按 uuid 删 JSON。
- 响应式对象过桥报 `An object could not be cloned.` → 先 `JSON.parse(JSON.stringify(x))`。

### schema v4（2026-10-25）：能算出来的东西不存

- `title.lang` 只存**短代码**（`en`/`ja`/`zh`），读写都过 `shared/lang.js` 的 `normalizeLang`；
  迁移 008 归一老行；`zh` 不挂语言 chip。
- **没有 `sections[].bar`**：段落只记 `tick`。`seed` 只认 tick（写 bar 只 warning），
  `tests/trackjson.test.mjs` 扫 `data/tracks` 判红（bar / 缺 tick / meterType / 非短码 lang / uuid 重复）。
- **没有 `meterType`**（JSON 与 `analysis.meter_type` 都没了）：由 `shared/meter.js` 现算，
  体系跟界面语言走 —— 中文 → 中/苏/德奥（**4/4 = 复拍子**，两个 2/4）；英文 → 英美
  （**4/4 = simple meter**，一拍分两份）。结论相反（分子 4）时 `ambiguous`。
  **别把这两个词当一对一翻译**。
- 规则边界（见 PENDING）：分子 ≤3 单拍子；3 的倍数 ≥6 复拍子；4 分岔；其余混合/不规则。
  不看速度、不看分母。

---

## 3. 拍号类型的界面

- 详情「拍号 / 速度」= `4/4 · 130 BPM · 复拍子 (i)`。标签单独一层 `.mt-kind`
  （断言读它，别读 `.mt-type` 的 textContent）。
- 圆圈 i **紧贴文字右边**（13px 的盒子、圆环 r5.4/stroke1.45、`vertical-align: -2px`、5px 间隙）—— **不是上标**。
  `inline-flex` 的基线取内部最后一个行内盒的基线（SVG 取底边），`vertical-align: 0` 会让它沉到
  基线以下（「掉下来」）；中心 = 基线上方 1+6 = 7px 才和 10px 字号的中线齐平。
  图形是 SVG（`shape-rendering: geometricPrecision`），见红线 20。
- 气泡 `.mt-pop` 是 **Teleport 到 body 的 `position: fixed` 元素**，坐标由 `openMeterTip()` 现算：
  `.detail` 是 `overflow:auto`，268px 的气泡比右栏还宽，留在里面必被裁掉半截（还会被曲目树的层叠压住）。
- 开合用 `v-if`，**零过渡**（`transition` 必须是 `0s`），不用原生 `title`（~1s 延迟）；
  字体走 `var(--font-ui)`，**不用等宽**（中文说明读着累）。
- 交互三态（v0.43）：悬停看 / 点住（`tipPinned`）/ 关；0.6s 延迟（`TIP_CLOSE_DELAY`）由 `scheduleTipClose()` 管，
  换曲切语言改拍号时 `watch(meterKind)` 直接收。

---

## 4. 和弦解析（最易「静默旧结果」）

- **挂留 / 附加音 / 延伸音按「绝对半音数」搭叠再排序**（`EXT_TOKENS` + `stack`）：
  `add2` = 2 个半音（C–D–E–G，夹在三音下）、`add9` = 14（C–E–G–D，最上面）、
  `sus4` 换掉三音、`6` = 9 个半音。**音名靠 `letterSteps`**：`b9` 永远 D♭，不能就近写成 C♯。
- **`V6/9` 会撞「V6 = 第一转位」** → 六九和弦一律 `V(6/9)`（全角括号也认）；
  `V6/9` 返回 ok:false + 一句「要打括号」，不静默按转位算。括号组只认**末尾**。
- **字母和弦与罗马数字共用 `buildTones()`**（v0.42）。`C6` = **加六音**（C–E–G–A），不是大七；
  `Am6` = A–C–E–F♯；`C6/9` 的斜杠不是低音；`C7b5`/`C7#5` 改的是**三和弦性质**（不进 extensions）。
- 级数泳道打 `V` 就出候选（`V / V7 / Vsus4 / V7sus4 / V(6/9)…`），**裸级数排第一且默认选中**。
- `analysis_event.parsed` 是**派生数据**。**改 `chord.js` 必须 `CHORD_PARSER_VERSION` +1**，
  否则读库修好了还是旧结果；`backfillParsed()` 必须晚于 seed。
- **派生拼写用 𝄪 / 𝄫，不写 `♯♯` / `♭♭`**（`accidentalMark()`）：跟词表和用户手打的写法保持一致，
  否则同一个音在格子里是 `C𝄪`、详情栏却是 `C♯♯`。三升这种极端情况写成 `𝄪♯`（记谱里也这么叠）。
- **𝄪 / 𝄫 在 UTF-16 里是代理对**（各占 2 个 code unit）。踩过的两处：
  ① `String.split(/[𝄪𝄫]/)` 会把记号劈成两个孤立代理 → 每个都画成 .notdef（带问号的菱形）；
  字符类只能按 code unit 匹配，要写成**择一** `(𝄪|𝄫)`。
  ② `{0,2}` 这种量词数的是 code unit，`C𝄪7` 会吃掉两个单位 —— 放宽到 `{0,4}`/`{0,6}`。
  （`for (const ch of str)` 是按 code point 迭代的，所以那些循环反而是对的，别一起改。）
- **DOM 那一份走 `ChordText.vue`**（选区条的解析说明）：这两个字的墨迹只占 em 框**上半截**
  （照五线谱的临时记号设计的），所以光放大字号会变成「一个字上标」—— 要放大到 2em
  再 `translateY(2.5px)` 压下来、`line-height: 0` 保证不撑高选区条的 26px。canvas 那边不需要这步。
- **画的时候这两个记号放大 25%**（`paintChordText`）：12.5px 下它们的墨迹只有 3px 宽，
  跟字母放一起像一根细线；放大 10% 等于 0.3px、肉眼看不出，1.4 以上又会撞 cap height。
  只有文本里**真的出现**这两个记号才走分段绘制，普通格子仍是单次 `fillText`（性能）。
- **小调级数按自然小调取根音**：`MODE_STEPS` 里 harmonic/melodic 与 natural minor 共用
  `[0,2,3,5,7,8,10]`；升七级只给属功能（否则 III = G♭ B♭ **D**）。
- **音名拼写不能用 `pcName`**（只有升号表）→ `spellPc(pc, letter)`；
  叠七音 `letterSteps` 显式给 **6**（9 半音也可能是减七）。
- **苏俄数字低音**（56/34/46/2）按规范值（65/43/64/42）解析，只记 `figure:{found,standard}`、
  **不进 errors**。
- 副属：根音与**字母**都按调式走；分子在临时主音**自己的音阶**里数（`appliedMode` 由右侧大小写定，
  `appliedAlter` 来自 b/#）；详情栏副属不能挤掉性质（`chord.applied` 另占一段）。
- **级数的说法必须带升降号**：`♭II` 以前被念成「2 级」，和 `II` 长得一模一样 —— 音高对、说法错，
  比解析失败更误导。现在统一「♭2 级 / ♯4 级」（`describeChord` 里把 `alter` 拼进 `chord.degree`）。
- **那不勒斯 = ♭II 上的大三和弦**，最常用第一转位（`N6`）。`N` / `N6` 只是记号：
  `parseChord` 里把它们**翻成 `bII` / `bII6`** 再走罗马数字那条路（`isNeapolitanSymbol`），
  这样两种写法在库里是同一份 parsed；`raw` 仍记用户实际写的字样。
  名字按**和弦本身**判定（degree 2 + alter -1 + 大三），不是按记号 —— 写 `♭II6` 也叫那不勒斯。
- **终止四六** `Cad64/K46/К46` = 属功能 + 双外音：根音第 5 级、`inversion=0`、
  低到高 = 属–主–中音（C 大调 G–C–E）；不能按三度叠置。`looksRoman` 必须先认它。

---

## 5. 低音行：从级数填充（v0.35）

- roman 泳道 `['chord','bass','note']`。值取 `parsed.bassName`；刚敲完未回库的文本走
  `parseChord + keyNameAt(tick)`；写用 `upsertEvent`（同 tick 改长度）。
- **只在 roman 视图**；手动填充整曲扫、**覆盖**；自动模式与和弦写入**共用一次 mutate**
  （一次 Ctrl+Z 两条一起回），和弦改了低音跟着改。
- 开关 `ma-bass-autofill` **默认关**（右键菜单与首选项同键，靠 `ma:prefs` 同步）。
  右键**覆盖整行**，只按 y 判断落哪行。

---

### 5.1 字母和弦：从级数翻译（v0.59）

- 转换器在 `shared/chordletter.js`（**故意不写进 `chord.js`**：那个文件一改就要
  `CHORD_PARSER_VERSION + 1`，全库重算；翻译不影响解析，不该连累它）。
- 两条硬规矩：**只翻译不猜**（查不到「性质 + 七音」组合返回 null）、**写完回头验**
  （拼出的字母和弦重新解析，音级集合与低音必须和级数一致，否则丢弃）。
  这条兜住了 `Cad64`（rootName 是 V、实际是 I 6/4）和等音拼写这类边角。
- 目标泳道是 `chord`；自动模式**不要求那一行可见**（写级数多半在罗马数字视图，
  那里没有 `chord` 行，要求可见等于开关永不生效）。
- 手点菜单 = 覆盖已有；自动模式 = 只跟新写的级数走。所有写入包在一个 `mutate` 里。

### 5.2 斯波索宾标记：从级数 / 字母和弦翻译（v0.60）

- 转换器 `shared/sposobin.js`。两条入口分开：**从级数**（可靠，自动模式只跟这条）、
  **从字母和弦**（先按该 tick 的调性反推级数，反推可能出错，只做手点菜单）。
- 写法约定（改之前先读这里，一个字母差一个意思）：
  - **原位三和弦不带数字**：`T` / `S` / `D` / `SII` / `DTIII`。
  - **苏俄先读小数字**：三和弦第二转位写 `46`（不是 `64`）；七和弦四转位 `7 / 56 / 34 / 2`
    （**不是** 65 / 43 —— 同一批和弦的两种写法，这里跟随中译本「先读小数字」的习惯）。
  - **大小写跟和弦性质**：大调里的借用小下属写 `s`；小调的和声属和弦（大三）写 `D`，
    自然小调的 v（小三）写 `d`。
  - **副和弦级数永远大写**：`SII` / `DTIII` / `TSVI` / `DVII`；
    小调里 `tsVI` / `dtIII`（自然三级）/ `DtIII`（和声小调增三）/ `dtVII`（自然七级）/ `DVII`（升导音）。
- **离调（副属）用斜杠写法**（姜之国《音乐考研复习精要·和声学》的记法）：
  `斜杠前 = 应用和弦在临时主音调里的名字`、`斜杠后 = 目标和弦在本调里的名字`。
  例：e♭ 小调的 `iii6/III` → `DTIII6/dtIII`（目标自然三级是大三和弦，临时主音调按大调算，
  所以 `iii6` 写成 `DTIII6`；本调是小调、目标又是自然三级 → `dtIII`）。
  临时主音调的大小调取解析器的 `appliedMode`，不要自己猜目标和弦性质。
- **仍然不猜**：那不勒斯、借用（`♭II`）、延伸音、挂留、六音替五音、目标带变化音
  （`V7/♭III`）一律返回 null。另外有一层**调内性质表**：`D7` 在 C 大调会被反推成 II 级，
  若不管性质就会拼出像模像样的 `SII7` —— 那是个属七和弦，根本不是 SII。性质对不上就跳过。
- **反解（v0.67）**：`romanFromSposobin(text, key)` 把斯波索宾标记译成罗马数字
  （`T→I`、`D56→V65`、`sII7→iiø7`、`DD7→V7/V`、`K46→Cad64`），再交给同一个 `parseChord`。
  **不能直接把 `D7` 喂给解析器**：那会被读成「D 属七」，音名全错且不报错。
  `parsedFor()` 里对 `sposobin` 走这条支路；译不出来返回 NULL（不留 `ok:false`，
  那一栏允许写注释，不该点亮「解析失败」）。改动要 `CHORD_PARSER_VERSION + 1` 才会补算旧行。
- **大小写完全服从输入（v0.74）**：候选池是 `BASES_MAJOR ∪ BASES_MINOR`（两套并集），
  打 `S` 只给 `S / SII…`，打 `s` 只给 `s / sII…`；打 `d` 只给 `d`，打 `D` 只给 `D`；
  六级同理（`t/ts/v/vi` → `tsVI`，`T/TS/V/VI` → `TSVI`，另一套在过滤阶段就剔掉）。
  **以前是「大小写打反也算命中」**（小调里打 `S` 补出 `s`），用户想借同主音大调的大下属时
  会被静默改成小写 —— 这条改掉是硬要求，不要再「优化」回去。
  配套：常用表也按候选大小写分两张（`COMMON_MAJOR` / `COMMON_MINOR`），
  否则只有一张表时会有一整套退化成字母序（`S` 后面跟 `SII` 而不是 `S6`）。
- **大小写越界的附注（v0.74）**：只影响右侧说明的**文字颜色**，不加框。
  - 小调（不含 Dorian）里的大下属 `S / SII` → `--warn` 橙黄，
    文案「**共晓小调**少见的大下属 · {转位}」（「共晓小调」是共晓时期的小调体系，
    用户确认语义正确，必须保留，不要当成错别字改掉）。
  - 大调里的小下属 `s / sII` → `--accent` 绿，文案「和声大调的小下属 · {转位}」。
  - Dorian 里的大 `S` 不提示（它的 IV 本来是大三和弦，是默认写法）。
  - 判断在 `sposobinCaseNote()`，界面通过 `CellSug.tone = 'warn' | 'ok'` 上色；
    颜色一律取现有变量，**不新造色值**。
- **输入补全（v0.72 重写）**：
  - **匹配是子序列**（不分大小写、不必连续）。原来是「前缀 base 开头 + 转位数字开头」，
    于是敲 `i` / `v` **一个候选都不出** —— 可这两个字母正是 `tsVI`、`dtIII`、`DVII` 里出现的位置。
    现在 `i` → `sII…`（两个 I）、`tsVI`；`ii` → 只剩有两个 I 的（`tsVI` 自动出局）；
    `v` / `vi` → `tsVI…`；`s5` → `s56` 与 `sII56`（中间隔着 II 也过得去）。
  - **功能首字母过滤**：敲 `s`/`t`/`d`/`k` 时只留同功能开头的族，
    否则 `s5` 会顺带拖出 `TSVI56`（`tsVI` 里也有 s，但那是主-下属功能，不是 S 族）。
    `t/ts/v/vi` 走下面的六级特例，**关掉**过滤，否则打 `v` 会把 `tsVI` 整族筛掉。
  - **六级特例**：敲 `ts / tsv / tsvi / v / vi` 时 `tsVI` 整族在前，
    族内顺序 **`''/6/7/56/34/2/46`**（和别的族不同：三和弦四六沉到最后）。
  - **只打 `t` / `T` 时是例外**：源族自己的三和弦先（`t / t6 / t46`），六级居中，
    源族七和弦（`t7 / t56 / t34 / t2`）收尾，其余垫后。**「完全相等永远第一」照旧成立** ——
    v0.72 曾为了「打 t 先给 tsVI」破坏过它，v0.75 已改回（见 RULES 第 24 条）。
  - **只打 `i` / `ii` 时**按 `I_MODE_ORDER` 排：`sII6 → sII56 → sII → tsVI → 二级其余 → 六级其余`。
    大写输入走同一张表（表按小写键查），大调池里只有大写写法，自然出 `SII6 / SII56 / SII / TSVI`。
  - 其余排序闸门：完全相等 → 大小写打反的等值 → **常用表**（排在「字面以输入开头」之前，
    这样 `s5` 时 `sII56` 才压得过 `s56`）→ 字面开头 → 同族 → 首字母位置 → 短 → 字母序。
  - 带斜杠时**只补斜杠后**的目标，前半截原样保留。
- **右边说明**：v0.75 起**只写「原位 / 第1转位 / 第2转位 / 第3转位」**。
  罗马数字和「六 / 五六 / 三四 / 四六」这些词全删了 —— 符号本身已经说明几和弦几转位，
  再说一遍是冗余（用户明确要求）。转位档位映射：
  `'' → 原位`、`6 → 第1转位`、`46 → 第2转位`、`7 → 原位`、`56 → 第1转位`、
  `34 → 第2转位`、`2 → 第3转位`。
  越界附注保留「 · 」分隔：`共晓小调少见的大下属 · 第1转位`。
  `sposobinHint()` 里的 `roman` 仍可用（单测与调试在用），只是界面不展示。
  `K46` 单独给「终止四六」的说明。
- **补全排序四道闸门**：① 完全相等永远第一（打 `S7` 先给 `S7`、打 `S34` 先给 `S34`）
  ② `COMMON_*` 常用表里的排前面（S 组：`S6 / S46 / SII6 / SII46 / SII7 / SII56 / SII34 / SII2`）
  ③ 大小写也对上的其次 ④ 短 → 长 → 字母序。
  S 组为什么特殊：这套体系里 `S6 / S46 / SII6 / SII7` 比 `S7` 的转位常用得多，
  打 `S` 时先把常用的推出来。要给别的族加常用项，只改 `sposobin.js` 里那张表。
- 调式判定用 `MINORISH` 正则（`harmonic minor` / `natural minor` / `dorian`…）：
  直接和 `'minor'` 比会把和声小调判成大调。五声调式按大调近似处理（性质表会挡掉不合调的）。

## 6. 时间线标记（调性 / 段落）

- `setMarkers` 是**整组替换**：先按 tick 去重 + 排序（`UNIQUE(analysis_id,kind,tick)` 一抛错整事务回滚，
  界面像「刚编辑的没了」）；移动后 id 按新 tick 重算；成功后 `emit('changed')`，**不要在组件里改 props**。
- **双击不要自己数毫秒**：`ev.detail >= 2`；合成事件才用 900ms/8px；**拖动阈值 ≥5px**；
  双击判定必须在 **pointerup**（pointerdown 早于 blur）。
- 吸附：调性 ≥ 拍，段落 = 小节（Shift = 拍、Alt = 不吸附）。
- 段落手势：双击块 = 改名、拖分界线 = 改起点、右键 = 分段/删除、清空 = 删除；
  落点语义：本段那格 = 改名，更靠后 = 新建。
- 输入框一律 `@keydown.stop`；全局热键先 `isEditableTarget`，`if (inField) return` 排最前；
  异步提交后只关自己那个。

---

## 7. 曲目列表（⑤）

- v0.41 起 **7 列**：`曲名 / 拍号 / BPM / 时期 / 流派 / 调性`。曲名旁**不标语言**，
  没有时长 / 段落数 / 标签数（用户嫌噪音）。`.thead, .row` 的 `grid-template-columns`
  **列数必须等于子元素个数**，删列时两处一起改。
- 录音版本子行（`recMeta`）仍显示「演奏者 · 年份 · 版本时长」—— 那是版本属性，不是曲目字段。

---

## 8. 网格：选区与手势

- **选区只认「当前视图看得见的泳道」**（`viewEvents`/`viewLaneIds`），否则抢详情栏、连带删除、
  「N 项」算多（Sibyl 第 11 小节同 tick 压着 `function='t'` 与 `chord='i'`）。
- 选区归属按**视图泳道顺序**（`exactSelEvents`）；`selParsed` 取第一条、没 parsed 退和弦类；
  **`CHORD_LANES` 只定义一份**（`shared/chord.js`）。
- **单击 = 选中，双击 = 进输入，框选 ≥2 格直接进输入**；`cellClick`/`bandClick` 两套双击状态，
  换交互必须清掉。
- **框选到块 ≠ 进输入**：框里有块就吸附成整块，纯空白才开输入框；按在块上拖仍是移动。
- **多选 = 矩形 + 离散集合并存**：Ctrl+点加减、Shift+点取「锚点到这块」同泳道整段；
  按边缘没拖也要立锚点；带修饰键一律不抢（交 `pointerup`）。
  多选画成一个大框，`inSel()` 按 `pickedIds`/矩形判定。
- **内部剪贴板**（不碰系统）：存「文本 + 相对 tick + 相对泳道」，以选区起点为锚走 `writeRange`；
  会覆盖先弹 `pasteAsk`。
- **出界自动滚动** `armEdgeScroll()`（36px 带、18px/帧）：每帧用**同一个 clientX** 重算文档坐标；
  **松手必须 `stopEdgeScroll()`**。
- **键盘（v0.52）**：`←` / `→` = 在同一条泳道里选前一块 / 后一块（到头**停住**，不跨泳道；
  没有选区时选**视口里**最左 / 最右那一块）。这两个键以前没绑定，会落到滚动容器上把视图左右滚。
  「一格」的宽度 = **当前显示单位**的格宽（`cellAtTick(…, div.value).grid.cellTicks`：
  小节 1440 / 拍 480 / 半拍 240），不是写死一拍。
  **Alt + 方向键：不按 Shift 只动右端**（`Alt+←` 从右边收 / `Alt+→` 向右扩）；
  **按住 Shift 只动左端**（`Alt+Shift+←` 向左扩 / `Alt+Shift+→` 从左边收）。改这块先看 `nudgeSpan()` 的注释。
  踩过一次：用户说的「缩小」= **右边界往左收**，我第一版做成了「左边界右移」（从左边收）——
  同一个词收的是不同那一侧，他还得回头澄清「从右边收才对」。**改范围类操作先问清收哪一头**。
- **输入态里 `Alt + 方向键` 也能改范围**（v0.54）：语义跟非输入态完全一样，改完**留在输入框里**
  （字和光标都不动）。两种情形分开：选区正好等于一条事件 → 走 `nudgeSpan()`（事件真的被改长改短、
  记一步撤销）；空格子 → 走 `resizeSelection()` 只改选区跨度，回车时 `fill()` 按当前选区写。
  改完要重摆输入框（`watch(selection)` → `positionOf()`），否则框还钉在旧位置，看起来像换了块。
- **输入框故意不压在选区上**（`positionOf()` 里的 `EDIT_DX/EDIT_DY` = 14/8）：以前正好盖住，
  一进输入态就看不见自己选到哪儿、左右边界全被吃掉。挪开之后左上角和左边那条边露着。
  **别改成「整体挪到选区下方」**：泳道只有 22px 高（`LANE_ROW_MAX`），18px 的框挪下去必然压住下一行。
- ⚠️ **`focus()` 会顺手滚动它所在的滚动容器 —— 必须写 `focus({ preventScroll: true })`。**
  输入框是绝对定位在 `.scroll` 里的，`focus()` 的默认行为会把它滚进可视区，于是**悄悄改
  `scrollLeft/scrollTop`**。输入框原来正好压着格子、离边界远，这个副作用看不见；一往右下偏移，
  靠边那格就出界，focus 当场把视口顶走 → 之后所有按文档坐标算的点击全部偏掉。
  冒烟里表现为「拖右边缘 / Ctrl+点 / Shift+点 / 拖播放头 / 选中动画」五组十条一起红，
  **看起来跟输入框毫无关系**（定位花了两轮冒烟 + 一次 `git stash` 对照）。
  视口该由 `revealRange()` 显式管，别交给浏览器默认行为。
- **`mutate()` 判断「这次到底改没改库」只允许用「宽判据」**：返回对象里**任何数值字段 > 0**。
  以前写死 `inserted || removed || trimmed`，而 `moveEvents()` 返回的是 `{ moved, removed, trimmed }`
  —— 拖到空位（没压住邻居）三个字段全 0 → **一步历史都不记**，于是 Ctrl+Z 撤的是上一步
  （用户报的「删除和拖动被合并成一个动作」）。新增写接口时不要再回来改这个判定。
- **块的命中只认内部**：`eventAt()` 左右都不外扩；
  块内部离边 7px 内的拉伸判定仍由 `edgeAt()` 负责。右边多出来的像素已经属于下一格，
  点下一格时不能被上一块的「拉宽」抢走。判定区大是**块内大**，不是块外大。

---

## 9. 网格：视觉 / 时间码 / 绘制

- **选中 = 实色底 + 1.5px 圆角外框**；绘制顺序：底色**在事件之前**、外框**在事件之后**（事件块不透明）。
- **事件块先铺不透明底**再叠 16% 淡色，否则小节线透出来像被切成几格。
- **和弦字体跟 body 字体族**（`chordFont(c)`，随 `data-font` 作废 `colorCache`），按宽度收字号（≥9px）；
  小节号固定等宽。
- 时间码 `12.1.1.0` = 小节.拍.十六分.tick（`shared/barbeat.js`），**不补零**；
  对齐交给 `.tc` 的 `f-bar/f-beat/f-16/f-tick` + `tabular-nums`。
- **sticky 头带标签要给右边真标签让路**（`stickyChipPlan`：上限 = `nextBandLabelX() − 6px`，
  挤不出就整条不画）；`__ma.stickyBand` 验它。
- **canvas 尺寸缓存跟元素身份走**（`ensureCanvasEl(el)` 在 `draw()` 开头置 -1 并重建波形层）；
  **`draw()` 开头 `clearRect` 会清掉波形带** → 末尾必须 `paintBand(sx)`。
- 只画视口（sticky + spacer，ctx 用文档坐标）；**canvas 位图高 = min(视口高, 头带+泳道总高)**；
  `__ma.perf().reallocs` 缩放/滚动必须 0；`.js` 文件不写类型标注。
- **canvas 位图与 CSS 尺寸必须严格 1:1**（v0.55）：位图 = `round(viewW × dpr)`，
  CSS 尺寸反算成 **`位图 / dpr`**（不是 `viewW`）。以前位图 `floor(viewW × dpr)`、CSS 宽度直接用
  `viewW`，两者最多差 1 个设备像素 —— 但只要有差，浏览器就得把整张画布**双线性重采样**，
  每个像素都被抹一下。实测（`.tools` 探针，同一串字）：差 0.5px，边缘对比度掉 **6%**。
  差多少取决于 `viewW × dpr` 的小数部分 → 表现成**「只有特定缩放倍率看着糊」**
  （125% 显示 + 页面缩放 1.25 / 1.35 / 1.45 各不相同）。冒烟有一条「1.35 倍时 1:1」守着。
- **canvas 文字本来就比 DOM 文字软 ~8%**（同字号同字体实测 `iiø42 V7 Cad64`）：
  DOM 走 Chromium 的文本栈（字形按设备像素微调），canvas 2D 是亚像素定位。
  **别为这个改画法** —— 试过整像素落位 / 整数设备字号 / 逐字符落位 / 2× 超采样 / `textRendering`，
  锐度差异全在 3% 以内（`textRendering` 在这个 Chromium 版本直接被忽略）。
  真要「和 DOM 一样锐」只有一条路：把和弦标记改成 DOM 叠加层（矢量文本），那是一次结构性改动。
- 波形缓存是**峰值金字塔**，键 = 路径 + 字节数 + mtime（只按路径会在转码后显示旧波形）。
- 侧栏 `--left-w/--right-w`，两个 `.vsplit` 是 **absolute**（绝不占 grid 列）；松手才写 localStorage。
- `.scroll` 必须 `scrollbar-gutter: stable`；**视口尺寸必须量 `.scroll`**
  （量 `.canvas-host` 会让画布压住竖条 →「看得见但拉不动」）。
- 高亮 Vue 绿（深 `#42b883` / 浅 `#2f9e6b`）；主题两层 `themeMode`/`theme`，子窗口只收 `app:theme`；
  `titleBarOverlay.height` = 顶栏 26，切主题刷新**所有** overlay。
- **播放控件只许 `▶ ❚❚ ■`**（Windows 会把 `⏸ ⏮ ⏹` 画成表情；断言字形白名单）。
- 顶栏两行 26+24；必须 `Menu.setApplicationMenu(null)`（否则 Ctrl+R 抢「登记作品」）；
  `.shell = 50px 1fr 40px 24px`；定高面板行 `minmax(0,1fr)` + 子项 `min-height:0`；
  `grid-template-columns` 列数必须覆盖所有子元素。

---

## 10. 详情栏 / 跟随播放头

- **`draw()` 绝不能驱动选区**（结尾调 `updatePlayhead()` 会让选区被旧 `currentMs` 推回去 → 详情栏闪）。
  跟随只认帧循环的 `ms`。
- **详情栏常驻**：`v-if="selection"` 让画布跳 26px；两条内容叠在同一格（绝对定位 + opacity），
  **不要 v-if 切换**。
- 跟随三档：`canFollow()` **必须要求 `audio.playing`**，只看交互态；`quiet` 不画高亮框；
  `pickedIds` 非空时让路。
- 选区必须用**和弦自己的精确区间**（只认完全重合那条；取 min/max 会让详情条永远空）。
- `__ma.focusTick(tick,{margin:96})` = 换播放头 + 翻页 + 选中整个和弦。
- 空值占位要**淡**：父级 `.empty` 或元素 `class="editable empty"`（`.editable.empty → --text-faint`）。

---

## 11. 曲名 / 译名

- 曲目树里，**档案写了原语言、且它跟界面语言不同**时，曲名右边加一句灰色括号译名
  （`おとなの掟（成人法则）`）。判定与挑词只有一份：`shared/lang.js` 的
  `pickTitleTranslation` + `scriptOf`。
- 译名**从 `aliases` 里按字符集挑**（不新增 `title.translations` 字段）：别名本来就混着
  译名（成人法则）、罗马字转写（Otona no Okite）和乐队名（Doughnuts Hole），
  按「读起来是哪种文字」能把它们分开（假名→ja、汉字→zh、拉丁→en）。
- **挑不到就什么都不显示**：在 UI 上猜一个译名的代价是用户以为那是官方译名。
  原语言未知、原语言就是界面语言、别名里没有对应文字的 —— 一律不显示。

## 12. 补全

- **改补全之前先读 `docs/INPUT-FEEL.md`**（2026-11-08）：里面是「输入手感」的现行规则、
  冲突登记表（`a` / `j` / `m` / `s` / `b` / `6` / `t` / `v` 这些同一个键的两个意思）和每条改动的理由 + 代价。
  **关键字冲突先问用户**，改完在那份文档里补一条决策记录 —— 这份 RULES 只留结论。

- **完全相等的候选必须留着**并默认高亮第一条（裸 `ii` / `vii` 永远第一，不再被半减七抢位）。
  判定只有一份：`shared/suggest.js` 的 `pickMode`
  → `save`/`adopt`；判等走 `shared/text.js` 的 `norm`/`sameText`；
  分层 exact 100 > alias 96 > 前缀 80 > 子串 60 > 模糊；请求必有 stale 守卫（`++seq`）。
- **和弦候选按泳道**：roman/riemann 的 `chord` 出**级数候选**，letter 出**音名 × 变音 × 性质**，
  `sposobin` 出 `K46`；**级数泳道绝不能出绝对和弦**（`C7` 这类），字母泳道也不能出 `V7`。
  `chord-symbols.json` 要让 `loadVocab` 跳过；输入法统一 `ime.ts`。
- **级数候选也来自同一份 `chord-symbols.json`**：`shared/cellsug.js` 的 `degreeCandidates` 取
  `qualities` 的后缀；`primary` 只决定「只打根音 / 级数时出不出现」，**数组顺序就是补全顺序**，
  编辑器里用 `↑ / ↓` 调整。不要再写死 `ROMAN_SUFFIXES` —— 加一个后缀必须只改词表。
  `m` / `m7` / `m9` / `6` 是字母写法（级数用大小写、`add6` 表达），级数分支会跳过；
  `m7b5` 例外：解析器专门认 `iim7b5`，半减七候选里保留它。
- **级数补全不做调式推断**：小调 ii / 大调 vii 不再自动把半减七顶到第一位（用户实际用下来觉得碍事）；
  裸 `ii` / `vii` 永远先出，半减七只在显式触发时出现。
- **双拼 / 拼音前缀只用于级数前**：降 `b / j / jiang / jl`，升 `s / sheng / u / ug`；
  例如 `bII → ♭II`。字母和弦根音仍用 `C# / Cb`，因为 `b` 会和音名 B 打架。
- **半减七触发词**：级数后 `h / half / b / ban / bj`（`b` 在级数后是「半」，不是降号）。
  后面可以带转位数字：`iih42` / `iib42` / `iihalf42` → `iiø42`；`h4` → `ø43 / ø42`，`h6` → `ø65`，`h7` → `ø7 / m7b5`。
- **模糊匹配（不连续、可乱序）**：`V76` / `V67` / `V6` 都要能出 `V7sub6`。分级
  exact > 前缀 > 连续子串 > 顺序子序列 > 字符都在（乱序），模糊项永远排在 exact / 前缀 / 转位之后。
  同一档里**首字符就对上的优先**：`Vs6` 必须先出 `Vsub6`，再出 `V7sub6`。
  单字符只对**数字**且候选里至少有两个数字时启用（否则 `iis` 会被 `7sus4` 的 s 拉出噪音）。
- **`s` / `7`**：`s` 是 `sus2 / sus4 / sub6`，`7` 的前四条是 `7 → 7sus4 → 7♭9 → 7sub6`。
- **单字母缩写只认 `j` / `a`**（v0.79，`shared/cellsug.js` 的 `SINGLE_ABBREV`）：
  `Cj` → `Cmaj7 / Cmaj9 / Cmaj13 / Cmaj♯11 / Cmaj13(♯11) / Cmaj11`（**词表顺序**，不写死）；
  `Ca` → `Caug` 排第一，后面接同一串。`j` 是 `maj` 里的那个 j、`a` 是 `aug` 的首字母。
  **别推广成「任意单字母都模糊匹配」**：`Cd` 会一次蹦出 dim / dim7 / add6 / add9，
  `Cs` 会把 `7sus4` 顶到 `sus2` 前面。别的前缀（`Cm` / `Cs` / `Cd`）继续走前缀匹配。
  `SINGLE_ABBREV.family` 用正则 `^maj` 而不是列六条后缀 —— 词表里加 `maj…` 时候选自己跟上。
- **前缀命中里「查询后面紧跟数字」的排在前面**：`Cm` 要先给 `m7b5 / m7 / m9`，再给 `maj7…`。
  `m` 后面跟数字是同一个词的延续（m7），跟字母往往是另一个词（maj）；不做这一步，
  maj 家族（六条）会把 `m7 / m9` 挤到 8 条上限之外 —— 这个坑是加 maj9…maj11 时踩出来的。
- **`maj13(♯11)` 不带空格**：词表规定后缀里不许有空格（`chords.ts` 保存时校验），
  `Cmaj13 (♯11)` 是谱面上的印法，格子里不塞空格。解析器两边都认
  （`parseAbsolute` 会把空格和括号一起抹平，所以 `C7(b9)` / `C 7` 也能解析）。
- **`maj` 后面跟 9 / 11 / 13 时七音是大七**（v0.79）：`Imaj9` = I–3–5–7–9。
  以前 `parseRoman` 在数字分支里一刀切 `seventh = minor`，于是 `Imaj9` 得到的是
  I–♭3–5–♭7–9 —— 一个既不是大九也不是属九的东西。字母那边本来就是对的，只有级数错。
- **11 / 13 隐含九音**（v0.80、v0.82）：`C11` = C–E–G–B♭–D–F、`Cmaj13(♯11)` = C–E–G–B–D–F♯–A。
  要**单独**的十一音写 `add11`（那是另一个音响）。隐含的 9 进 `extensions` 但不占「重复延伸音」
  的名额（`pushExt(tok, implied)`），否则 `C11(9)` 会被判笔误。
- **省略音**（v0.82）：`no5` / `omit3`，按**几音**删（`C7♯9no9` 去掉的是升九，不是三音）。
  只写关键字不给数字 = 不省略（补全插进来的半成品不该立刻变红）。级数泳道同一套，括号里也认。
  补全 `C13o` → `omit` / `no`：**关键字前面必须是数字或括号**，否则 `Co`（减三别名）会被抢走。
  `parsed.omits` 只记**真的删掉了东西**的（`C13no11` 是空的），详情栏照着它念「省略十一音」。
- **详情栏的说法**（v0.83）：有七音时**按最高的自然延伸音给和弦起名**
  （`Cmaj13(♯11)` → 「大十三和弦 · 升十一 · 原位」），名字里已含的 9/13 不再单念；
  变化音念「升十一 / 降九」。**别再用 `numeral()` 念 11/13** —— 它只管 1–9 的转位序号，
  超过会夹成「九」，用 `chord.js` 里的 `extNumeral()`。
- **六九和弦按泳道换写法**：字母泳道给 `C69`（没有数字低音歧义），级数泳道仍给 `V(6/9)`
  （`6` 是转位记号）。词表里只存 `(6/9)`，字母泳道的改写见 `cellsug.js` 的 `LETTER_SUFFIX_OVERRIDE`；
  解析器三种都认（`C69` / `C6/9` / `C(6/9)`）。
- **`sub6` 是六音替五音**：解析器在级数与字母两边都认 `sub6` / `7sub6`，把三和弦的五音换成
  大六度（`sub♭6` / `subb6` 用小六度），七音保留；`V7sub6 = G–B–E–F`。
  `describeChord` 必须单独说「六音替五音」，不能只念「小七」。
- **字母和弦词表分成三张表**（schemaVersion 2）：`letters`（只有 C D E F G A B，不带升降号）、
  `accidentals`（`''` 本位 + ♯ ♭ 𝄪 𝄫，各带中文名）、`qualities`。候选 = 7×5×性质。
  为什么不直接列 12 个根音：`C♯` 和 `D♭` 会变成两条、加一种变音要在十几条里挑着改，
  而「重升」这种冷门写法根本没人会去补全表里加。
  **`accidentals` 里必须留一条 `sign:''` 的本位音**，否则 `C` 这种最常用的写法永远出不来（保存会报错）。
  `ø65 / ø43 / ø42` 是级数专用（`iiø42` 这类）；字母泳道用 `Cø7` / `Cø7/E♭` 表达低音，
  不要让候选生成 `Cø65` 这种解析器不认的写法。
- **性质可带 `aliases`**（半减七：`ø` / `min7b5`；减七：`°7` / `o7`；小三：`min`…）。
  别名只进候选说明，**不复制候选行**；但别名参与输入匹配（`C7b9 → C7♭9`）。
  解析器内置常见别名，词表只负责记录/展示。给空后缀加 placeholder 时别写某个具体后缀
  （以前写 `7sus4`，大三行看着像 7sus4），用「空 = 大三」。
- **所有补全共用一套行样式**：`tokens.css` 里的
  `:is(.key-sug, .sug, .field-sug) li:nth-child(even)` 是斑马纹唯一来源，`.on` 用 `--sel-bg`。
  新增补全列表（搜索 / 调性 / 和弦 / 以后任何地方）**把类名加进这个 `:is(...)`**，
  不要在组件里单独写 li 背景，否则有的列表有条纹、有的没有。
  和弦补全宽度由 `sugBox(..., 320, 460)` 给足，行 `white-space: nowrap`，超长说明省略而不是折行 ——
  折行会让列表行高忽高忽低，视觉上更容易看串。
- **输入侧一律宽容**：`C#` / `Cb` / `Cx` / `C##` / `C♮` 都归一成词表写法（`♯ ♭ 𝄪 𝄫`），
  归一在 `shared/cellsug.js` 的 `normalizeRootText`（只动开头那一个音名后面的记号，
  `m7b5` 里的 `b` 一个字符都不许改）。
- **解析器必须认得词表能给出的每一个字**：词表能出 `C𝄪`，`chord.js` 的 `noteToPc` /
  `parseAbsolute` 就得认 𝄪 𝄫 ♮（`ACCIDENTAL_SEMIS`）；级数候选里的 `ø65` / `7sub6` /
  `(6/9)` 也要能解析。单测直接遍历词表，两个泳道各跑一遍，别只验一两条。
  这条是「候选里明明有、敲进去却报无法解析」的根因。
  派生拼写仍是 `♯♯`/`♭♭`（`spellPc` 的老约定），所以详情栏会写 `C♯♯` 而格子里是 `C𝄪` —— 同一个音。
- 改词表字段名/结构 = 改 schema，`loadChordSymbols` 要能读老文件（`roots` → letters+accidentals
  的迁移已经写在里面了），否则用户手改过的 JSON 会静默退回内置表。
- **词表编辑器的增删改查**：`+ 性质 / + 变音记号` 先插一条空行；保存时**完全空白**的行跳过，
  否则「添加」本身就会让整张表保存失败。只填一半的行仍报错，错误必须带行号。保存成功后用
  主进程回写的 `res.doc` 重置界面（空白行、首尾空格、顺序都以磁盘为准），别继续拿旧数组算 dirty。
  `note` 不在表单里，但它是 JSON 的一部分：界面没提交时必须沿用旧文件的，不许擦掉。
  顺序用 `↑ / ↓` 改数组，数组顺序就是补全顺序。
- **送给 IPC 的必须是纯 JSON**：Vue 的 `ref` / `reactive` 数组是 Proxy，Electron 的 structured
  clone 克隆不了，`invoke` 会直接抛 `An object could not be cloned.`。词表保存前深拷贝一次
  （`JSON.parse(JSON.stringify(...))`），这就是「保存失败」的根因。
- 候选框定位见红线 19（`sugBox()`）—— **改定位必须同时看格子候选和调性条候选**。

---

## 12.5 音频时间轴：编码器预热（v0.86）

- **对外的时间一律是「音乐时间」= 文件时间 − 编码器预热**（`store.js` 的 `state.leadMs`）。
  播放元素、波形峰值、对外报的时长**三处必须同时扣**，漏一处就是「波形比播放头早 20ms」——
  界面上看不出来，只会表现为「对轨怎么都对不准」。
- 有损编码器会在文件开头塞一段预热：mp3 = 1105 采样（LAME 编码 576 + 解码 529），
  AAC = 1024 采样。**只要容器带 gapless 信息，Chromium 解码器自己裁**：
  - mp3：第一帧的 `Xing` / `Info` 头（位置 = 帧头 4 + 侧信息 32/17/9，**别整帧乱搜**）
  - mp4/aac：`elst` 编辑列表或 `iTunSMPB`（`moov` 可能在文件尾部，要连尾巴一起找）
  - ogg（vorbis / opus）：granulepos / pre-skip，本来就准
  - wav / flac / aiff：无损，没有预热
- **实测**（`.tools` 探针，同一段 12s 音频转各式，与 wav 做互相关）：

  | 文件 | 多出来的采样 | 与 wav 的位移 |
  |---|---|---|
  | mp3（Info 齐全）/ ogg / m4a（有 edts）/ flac / wav | 0 | 0 |
  | mp3 `-write_xing 0` | 1872 | 1105 采样（44.1k 25.1ms / 48k 23.0ms / 22.05k 50.1ms） |
  | m4a `-use_editlist 0` | 1024 | 1024 采样（44.1k 23.2ms / 48k 21.3ms） |

  位移**恒等于「预热采样数 ÷ 文件采样率」**——所以换算必须用**文件**采样率，不是解码后的。
- 判据是 `shared/audiofile.js` 的 `codecLeadSamples()`（纯函数，`tests/audiofile.test.mjs` 覆盖）。
  **读不出来就返回 0**（三态里的 null）：补错会把整轨推偏 20+ms，比不补更糟。
- mp4 的采样率头里读不到，要单独从 `mp4a` 样本条目读（`probeMp4SampleRate`，采样率在 `+28`，
  16.16 定点）。没有采样率就**不补** —— 宁可保持现状。
- 解码后的采样率可能被 AudioContext 重采样过 → 裁峰值时 `skip` 要按比例换算
  （`leadFile × decodedRate / fileRate`），否则 48k 文件在 44.1k 上下文里会少裁 90 来个采样。
- **改了峰值算法就要给 `PEAKS_VERSION` +1**（`wavecache.js` 与 `main/ipc/wave.ts` 的键）
  否则旧磁盘缓存还是老口径：波形比时长多一个预热，界面上看不出来。
- 状态栏在有补偿时显示「补偿 25 ms」，让「换格式要重调偏移」这件事有据可查。

## 13. 音频宿主 vs 从属窗口

- **整个应用只有一个 `<audio>`，在主窗口**（`isHost = !/^#?(grid|lyrics|overlay|image|help|history)/`）；
  子窗口「发指令 + 收状态」并**本地插值时钟**（`{baseMs,baseAt}`）。
- **换曲/卸载走 `localPause()`**，不是 `pause()`（从属窗口的 pause 会停掉主窗口音乐）；
  `onBeforeUnmount` 不许 pause。
- `player:command` 只转发主窗口，`player:state` 广播其它窗口；`querySelectorAll('audio')`
  **数不到** `new Audio()`（用 `__maAudio.hasEl()`）。
- 曲末：`seek()` 夹在 `duration-60ms`（`EOF_GUARD_MS`），末尾附近的 media error 当 EOF 不报；
  离开末尾就清旧错。
- **解析与取流必须共用 `recordingFamily()`**：同版音质是「父版本没文件就用子文件」，
  只让 `resolveRecordingAudio` 认识音质、协议处理器却只查 `recording.file_path`，
  会出现「解析说能播、请求 404」的断续故障。`ma-audio://rec/...` 不许自己写查询。
- **录音文件变更后必须失效重载**：`loadTrack(trackId, recId)` 的同 id 早退只在
  「解析结果没过期」时成立。管理窗改了文件后走 `loadTrack(...,{force:true})`，
  否则 `<audio>` 拿着旧文件的字节范围去请求新文件，表现是偶发「播放失败、拖一下又好了」。
  重载前比文件指纹，只改厂牌 / 演奏者不重载；重载后接回原位置与播放状态。

---

## 14. 操作历史 / 工作区（v0.37）

- **撤销的唯一真相在主进程** `src/main/history.ts`；每步存**整份事件快照**（不存 diff），带 `base` 项；
  游标 `cursors[analysisId]` + `globalCursor`，新操作丢弃该曲游标之后的项。
- 键位：`Ctrl+Z` 撤当前曲 · `Ctrl+Shift+Z` 全局撤 · `Ctrl+Y` 重做 · `Ctrl+Shift+Y` 全局重做 ·
  `Ctrl+Shift+H` 历史窗口（`#history`）。这四条**编辑菜单**里也有一份（灰显 `__app.histMenu()` 可断言）。
- 状态刷新两条腿：**自己动手后 `refreshHistCan()`**（mutate/undo/redo 末尾）+ **别的窗口动手靠广播**
  `history:changed`。
- 落盘 `userData/undo-history.json`，只写最近 `persist`(50)；运行期 `limit` 默认 0 = 无限。
- **工作区** `src/main/workspaces.ts` + `userData/workspaces.json`，顶级菜单「工作区(W)」；
  记主窗口/面板/栏宽/缩放/主题/泳道/三子窗口，**刻意不记当前选中曲目**；`last` 由字段变化防抖 2.5s 写回。
  启动时的加载在 `App.vue` 的 `onMounted`（`refreshWsList` + `ws.lastUi`，**排在 appReady 之前**）；
  「还原上次布局」只还原布局，**不覆盖主题偏好**（`applyUiFields(ui,{theme:false})`）——
  显式切换工作区才连带换主题。

---

## 15. 帮助窗（`#help` / ActionHelp.vue）

- 宽固定 520 **CSS 像素**、**高度由渲染层量 `.ah-inner` 后 `help:resize`**（主进程乘缩放、封顶工作区 85%）；
  默认置顶可关；默认自启（`appReady` 后 280ms，和歌词窗 120ms 错开）。
- **独立时间线窗口的「格单位」靠 localStorage 跟随主窗口**（`ma-grid-unit` + `storage` 事件）：
  它没有单位菜单，以前也没接 `:unit` → 恒为一拍，那边按 Alt+← 永远只收 480。
  以后主窗口再增加「影响网格行为」的偏好，记得同步给这个窗口一份。
- **别量 `.ah-body`**（flex:1 撑满窗口 → 内容更矮时 `scrollHeight === clientHeight`，
  等于「用窗口高算出更高的窗口高」→ 每变一次 +20px 一路长到屏幕 85%）。量 `.ah-inner` + `ResizeObserver`。
- `help:resize` 的去重比的是**上次量到的内容高**（`helpCssH`），**不能比 `getContentSize()`**：
  窗口没 show 时它返回 `[0,0]`，也可能已经是「设过但渲染层没采纳」的尺寸 → 会吞掉真实请求。
- 摘要由 GridEditor **节流 120ms** 推 `api.help.push()` → 主进程存一份再转给窗口（重开补发）。
- 上下文提示：**`src/renderer/src/helpctx.js` 是唯一写入口**（GridEditor 报「网格里是什么」、
  App 报「鼠标在哪」，合并成一份 payload）。两边各推各的会互相覆盖。
  区域靠模板上的 `data-help-region` + **document 级 `pointerover`**（不是 enter/leave：嵌套区域会打架）。
  优先级：**输入框 > 选中记号 > 悬停区域 > 通用**。
- **「此刻才成立的那一招」放第一条并上色**：目前只有「级数行打 h 出半减七」
  （`HINT_HALFDIM`）。它回答的是「我这个和弦怎么打」，比「Enter 落库」更急，所以排第一。
  **颜色取 `--accent`，不写死色值** —— 深浅主题 / 换配色都跟着走；
  冒烟断言比的是「计算色 === --accent 的计算色」，不是十六进制。
  皮肤有两套（`ActionHelp.vue` 里一套生效一套注释）：
  - **B（当前）**：只把字变绿，别的都不动 —— 和列表其它行完全同构。
  - A：`.ah-hint` 绿底 + 左侧 2px 竖线。**对齐要点**：2px 边框要靠 `margin-left: -2px`
    抵掉、padding 保持 11px，圆点才不会跟着往左歪（之前 margin -3 / padding 10 就歪了）。

---

## 16. 子窗口：主题 / 缩放 / 尺寸

- **子窗口开窗时必须 `await api.app.theme()`**：`data-theme` 是各窗口自己设的（未设 = 默认深色），
  而 `app:theme` 只在切换时广播 —— 晚开的窗口收不到那条。主进程另有 `primeChildTheme()`
  （did-finish-load 补发）和 `refreshAllOverlays()`（`app:theme-set` 时重刷所有窗口的系统按钮）。
- 缩放：新窗口创建 `matchMainZoom(w)`；主窗口改缩放 → `applyZoomToChildren()`
  （帮助窗再走 `fitHelpWindow()`）。桌面歌词故意不跟。
- `getContentSize()` 在窗口没 show 时返回 `[0,0]`，别拿它当「已生效」的判据。
- 窗口变大/缩放变大后要 `keepInsideWorkArea()`：只在越界时推回工作区，不强行归位（用户可能手动拖过）。
- **主窗口销毁必须级联关闭所有子窗口**（2026-11-13）：`createWindow` 的 `closed` 里先 `win = null`
  再 `closeChildWindows()`；开子窗口的入口统一用 `hasMainWindow()` 挡住。只打日志不关窗的后果是
  「歌词播报器还在、但点哪儿都没反应」，而且 `window-all-closed` 不触发、进程不退。

---

## 17. 偏好开关（渲染层 localStorage）

`ma-follow-sel` · `ma-scrub-pick` · `ma-sel-anim` · `ma-paste-warn` · `ma-bass-autofill`(**关**) ·
`ma-help-auto`(开) · `ma-undo-limit`(0=无限) / `ma-undo-persist`(50) · `ma-version-click` · `ma-font` ·
`ma-theme` / `ma-theme-mode`。
改动靠 `CustomEvent('ma:prefs',{detail:{key}})`（跨窗口 storage 不可靠）。
「完全启动」握手：曲库加载完 + 双 rAF 后调 `api.win.appReady({autoLyrics, autoHelp})`。

---

## 18. 清理 / 冒烟 / 启动

- **视图是按曲目记住的**（`analysis.view_id`）：冒烟里凡是依赖「当前是哪个视图」的断言，
  必须先显式点侧栏切过去。否则上一次调试停在 `sposobin` 就会让一批跟随 / 详情断言一起红
  （2026-11-04 真踩到：Sibyl 的 view_id 被留在了斯波索宾体系）。

- 冒烟副本**每种最多留 3 份**（2026-11-08 用户定的）：`tools/smoke.mjs` 的 `freeDir()` 在分配
  编号前先按修改时间把最旧的那份删掉，所以 `.smoke-data*` / `.smoke-profile*` 不会无限长。
  `clean-junk.ps1` 也默认只清「第 4 份及更早」，`-All` 才连最新那 3 份一起清。
  **别改回「只加不删」** —— 那样跑几十轮就堆出 77 份 / 1.5GB，找文档要滚一屏垃圾。
  清理走 `clean-junk.cmd`（非交互会话里回收站 API 不可用，要加 `-HardDelete`）。
- 起窗口 `npm run app`（detached）；别用后台任务 / `nohup` 跑 GUI。
- `npm run smoke` 前台约 3 分钟；`npm test` 是纯函数单测。数值查库断言，截图只看版式；
  读 DOM 前 `wait(90)`，面板类用 `until(fn,2500)`；`safe()` 钩子回 **JSON 字符串**，先 `JSON.parse`。
  `__ma` / `__app` 是唯一交互入口（别靠点击坐标猜）。
- 断言里**别用字符串子串猜文案**（文案里没有那个词，断言永远 -1，白查半小时）。
- **`js()` 里传的是字符串，不是 TS**：模板字符串里写 `(x: any) => ...` 会在渲染层变成
  SyntaxError（`Script failed to execute`），而主进程那一半照样编译通过 ——
  报错只说「check the renderer console」，看不出是哪一行。写 `js()` 时把类型注解全去掉。
  （2026-11-13 踩到：一条新断言因此让整轮冒烟在第 500 多条处断掉。）
- **冒烟被打断时报告文件不会被覆盖**：所以「报告还是上一次的时间戳 / 条数」= 这轮崩了，
  先看 stdout 末尾那段堆栈，别去读旧报告下结论。
- **冒烟窗口被别的窗口完全遮住时，Chromium 会停掉 rAF** → 「重绘 / 播放 / 动画」类断言一次红 20 多条。
  判据：查库与几何类全绿、红的全是帧相关 → 关掉自己开着的窗口重跑，别当回归去改代码。
- 图标 / 亚像素这类「看着不对」的问题，别靠反复跑冒烟试：`.tools/icon-probe.js` 能起一个 hidden 窗口
  把几个候选画法渲染成 PNG（`capturePage`），再用 `.tools/venv` 的 PIL 放大看像素矩阵，几秒钟一轮。
- **冒烟窗口本身要「隐形」**（`quietWindow()`，只在 `--smoke` 生效）：
  `setIgnoreMouseEvents(true)` 鼠标穿透 + `setFocusable(false)` 不抢焦点 + `setSkipTaskbar(true)` 不进任务栏
  + `setOpacity(0)` 完全透明（看不见）。
  这些不是为了好看 —— 用户手一抖点进窗口，就会改掉选中格 / 展开菜单，测试随即判红，
  而这种红**查代码永远查不出来**。同理：你在别的窗口打字时，字不能跑进测试窗口。
  顺带治了「真人鼠标 `pointerover` 盖掉合成事件」的 flake（成了穿透之后真鼠标根本进不来）。
- **`opacity = 0` 必须配 `--disable-features=CalculateNativeWinOcclusion`**。
  全透明窗口 DWM 不合成，Chromium 的 Windows 遮挡计算会把它判成 occluded，于是
  `setTimeout/setInterval` 降频（拖到边缘自动滚动 700ms 一点没动）、依赖合成帧的 pointer 命中失效
  （拖动播放头选不中）、`sendInputEvent` 投不进去（歌词窗快捷键转发）。
  2026-10-26 实测：只加 opacity 稳定红 4 条，加上这个开关剩 2 条，再把「等编辑态标志」改成
  `until()` 轮询就全绿。**别删这个开关**，也别换成 `win.hide()`（那是真的停帧）或挪到屏幕外
  （窗口会被系统钳回来，位置断言还会集体红）。
  坐标不受影响：`.tools/coord-probe.js` 对比过 opacity 1 / 0 两档，DPR、视口、元素 rect、
  `elementFromPoint` 完全一致 —— 所以「顺手归因于坐标」这个方向是错的。
- **不可见窗口里 `focusin` 可能不派发**，只能等 `hotkeyshield` 那 1s 兜底轮询。
  所以测试里「进/出编辑态之后立刻按快捷键」必须 `until(() => editingWcIds.has(...))` 等状态，
  不能 `wait(600)` 赌时间 —— 赌输的后果是**真的往曲库里登记了一首**（这条红过一次）。
- **调试时想肉眼看画面**：`MA_SMOKE_VISIBLE=1 npm run smoke`（不透明，但穿透仍在，照样点不进去）。
- **一堆看似无关的断言同时红时，先做对照**：`git stash` 跑一遍旧代码，确认是不是自己改出来的
  （这次就是靠它证明「不是我改坏的」是错觉 —— 确实是，但根因离现场很远）。
  然后用「把可疑常量改成 0 / 关掉某段」逐个排除，比读代码猜快得多。
- **它还在跑吗**：`npm run smoke:status` 读 `.smoke-run.json`（主进程每 400ms 落一次），
  报 pid / 已跑时长 / 通过数 / 最近一条断言；进程没了但状态停在「进行中」会单独报（崩溃）。
- **`quietWindow` 故意不碰 `setAlwaysOnTop`**。帮助窗默认置顶、歌词窗可切置顶是**被测行为**
  （有断言直接查 `isAlwaysOnTop()`）；用改窗口层级来「降低打扰」等于把测试对象改了。
  要减打扰只能用上面三条 + 冒烟时窗口本来就静音。
- **沙箱的代价是「用户点不动窗口」** → 必须有死线：主进程 `SMOKE_HARD_TIMEOUT_MS`（8 分钟，
  到点 `app.exit(1)`）+ `tools/smoke.mjs` 外层 `child.kill()`。改沙箱时别把这两条删了。
- 窗口刚 `new BrowserWindow()` 时 Windows 上还没有原生句柄，`setIgnoreMouseEvents` 会**静默落空**
  （不报错、不生效）。所以 `quietWindow` 在 `show` 之后还要再调一次（`browser-window-created` 里
  `w.once('show', ...)`，主窗口在 `ready-to-show` 里）。

---

## 19. Electron 44 / 自定义协议（2026-10-26）

- **`console-message` 从 Electron 35 起是事件对象**：`e.level` 是字符串（`'error'` / `'warning'` / …），
  旧的 `(_e, level, msg) => level >= 2` 会**静默变成永远 false**。主进程的 `onConsoleMessage()`
  两种签名都认；新增窗口 / 新冒烟区块别自己再绑一份旧签名。
- **自定义协议跨源必须同时满足**：`registerSchemesAsPrivileged` 里 `corsEnabled: true`
  + 响应 `Access-Control-Allow-Origin`（并用 `Expose-Headers` 暴露 `Content-Range` 等）。
  只写 `supportFetchAPI` 在 Electron 44 / Chromium 152 下会直接 CORS 拒绝；
  播放 `<audio>` 可能正常，但 `fetch` 的波形 / 时长 / 导出全挂 —— 别只看播放。
- **Electron 42+ 的 npm 包不带 postinstall**：`node_modules/electron/dist` 可能不存在，
  第一次运行才下载。启动器统一走 `tools/electron-path.mjs`，别再硬编码 `dist/electron.exe`。
- **低完整性目录会让 Electron 44 秒退**：退出码 `0x80000003`、`logs/boot.log` 一条都没有；
  `icacls . | findstr Mandatory` 看到 Low 就按 `docs/ELECTRON-UPGRADE.md` §3 设回 Medium。
  **别用 `--no-sandbox` 绕过**。
- **直接 `electron . --smoke` 会写真实库**：必须 `MA_DATA_DIR` + 独立 profile；正常走 `npm run smoke`。
- **冒烟末尾的用例不许假设「还是那首曲子 / 库里还有事件」**：测试中途会切曲目（波形缓存那几段），
  也会把某些曲目撤空。查库前用 `__ma.analysisId()` 取**当前网格**的 analysis id；
  找 tick 用 `select()` 的**返回值**，别自己拿「小节号 × 1440」算（`gridOfBar()` 的编号起点
  没写进接口，算错就差一整小节，表现是「明明写进去了却查不到」）。
  「到头停住」这类断言也要先**站到最后一块**（`__ma.selectEvent(tick)`）再按键 —— 这一行后面
  往往还有测试早期写进去的块，按两下 → 当然会跳过去。

---

## 20. 播放性能（2026-10-26）

- **主网格 canvas 绝不能声明 `willReadFrequently: true`**。Chromium 在**第一次**
  `getContext` 时就按这个属性把整张画布定到 CPU 后端；之后播放中每帧的 `draw()` 和波形
  `paintBand()` 全在软件光栅上跑。帧率看着还是 60，但画面发黏、窗口拖动/滚动不跟手。
  `bandDiff()` 是冒烟专用调试钩子，它改用独立的 `probeCanvas`（CPU 小画布）一次
  `getImageData`，别让整个应用陪跑。
- **判断 GPU 状态别在 `whenReady` 当场读**：那时 `app.getGPUFeatureStatus()` 还是
  `disabled_software` 的默认值，窗口开始合成后才会变成 `enabled`。用
  `electron . --gpu-info`（5 秒后把 `gpu-late` / `gpu-info` 写进 logs/boot.log）。
- **性能抓手**：`__ma.perf()` 的 `draws / hotBlits / sumMs / lastMs / maxMs`；
  `__maAudio.currentMs() / paused() / readyState() / bufferedMs()`。播放中 rAF 应约 16.7ms，
  `currentTime` 每帧递增（0 次 stall），IPC 往返 <1ms。
- **播放头 transform 不要 `Math.round(sx)`**：0.50× 网格缩放时每秒只走十几像素，
  取整会变成「三四帧才跳 1px」的阶梯（0.5× 测到 72% 的帧 x 不变），看起来就是抖。
  用 `translate3d(${sx.toFixed(2)}px, …)` 亚像素；0.5× 时每帧约 0.30px 的连续位移，
  60fps 下才是匀的。**别用 `left` 或整数 x 去“修”**，那只是把阶梯变粗。
- **跟随滚动和播放头必须同一帧提交**：`updatePlayhead` 先 layout、再 `followIfNeeded`
  改 `scrollLeft` 的话，这一帧播放头还停在旧 viewLeft 算出的 x，下一帧才补 → 翻页瞬间闪/抖。
  滚动后立刻 `layoutPlayhead(ms)` 重摆；`followIfNeeded` 到 `scrollWidth - clientWidth`
  就返回 false，别每帧 `setScrollLeft` 空转（否则结尾每帧整网重绘）。
- **帧率跟着显示器刷新率走，应用里没有“锁 60”的开关**：`requestAnimationFrame` 按当前
  刷新率跑，60 / 75 / 90 / 120 / 144Hz 都会自动适配，代码不用改。本机当前
  3440×1440@59Hz；Windows 显示设置切到 75Hz 模式后，rAF 会自动变成约 13.3ms/帧。
  **不要**用 `--disable-frame-rate-limit` 强行解限——显示器只有 59/75Hz 时只会撕裂、
  发热，也不会多出可显示的画面。0.5× 的顺滑靠亚像素，不靠超频。
- **验证高刷**：`__ma.perf().hotBlits` 在播放 5 秒内约等于实际帧数（60Hz≈300、
  75Hz≈375）；要更直接就在 DevTools 里量 `requestAnimationFrame` 间隔。
- **冒烟窗口的 `setIgnoreMouseEvents(true)` 不要加 `{forward:true}`**：真鼠标的
  `pointerover` 会盖掉合成事件，悬停断言会随机读到「曲目列表」。冒烟里的悬停全部走
  `executeJavaScript` 合成事件，不需要真光标。

---

## 21. 播放条 / 日志（2026-10-27）

- **播放条顺序固定**：播放/暂停 → 回到开头 → 当前音频毫秒 → 进度 → 总时长 →
  主时间（默认小节.拍）→ 次时间（默认时间码）→ 帧速率 → 速度 → 拍号 → Tap →
  节拍器及设置 → 原点/播放头设置 → 跟随 → 主输出。**音频文件名和「选择音频」不再出现**；
  换音频走录音版本管理。新增控件不要插到播放/回到开头前面（冒烟和歌词窗都按前两颗按钮定位）。
- **主/次时间格式**：`bars` / `timecode` / `ms`，存在 localStorage（`ma-time-primary` /
  `ma-time-secondary`）；Alt+点击任一时间读数交换主/次。帧速率 `24/25/30/50/60`，
  默认 30，存 `ma-fps`；时间码用 `formatTimecode(ms, fps)`，帧号向下取整。
- **格式图标语义固定**：小节.拍 = `♩`，时间码 = `TC`，毫秒 = SVG 时钟；
  **节拍器 = 镂空的竖起来的长条等腰梯形**（SVG polygon 描边，`fill="none"` /
  `stroke="currentColor"`），不要拿 `♩` 当节拍器，也不要退回实心 `clip-path`
  （背景色一变就露馅）。不要用 emoji（Windows 会画成蓝色方块）。
- **主/次时间块要紧凑**：块后面不要 `▾` 小三角；图标-数字间距 3px、右内边距 4px、
  读数槽 80px（够放 4 位小节 / 时间码）。播放条的弹性空间优先给进度条：
  `.grow` 只留 14px 固定间隙，不许再写 `flex:1` 跟进度条抢空白。
- **小节位置必须和详情面板「时间轴 · 段落」同一份**：用 `components/BarBeatText.vue`，
  小节 4ch / 拍 2ch / 十六分 2ch / tick 3ch，右对齐、点号固定、数字不补 0。
  播放条不许自己拼 `formatBarBeatSub` 的裸字符串 —— 数字一长一短会晃眼。
- **节拍器设置面板跟随 Vue 绿**：`input[type=range]` / `checkbox` 用 `accent-color: var(--accent)`，
  开关 `.on` 用 `--accent` / `--sel-bg`；不要留浏览器默认蓝。
- **Tap**：`shared/tempo.js` 的 `bpmFromTapTimes` 只算最近 8 次、间隔 >2s 重新开始、
  结果限制 20–300。停手 900ms 弹确认框；点速度读数也能手动输入。应用时写当前
  tempo 段（单速档案走 `tracks.update`，多段走 `analysis.setMarkers`）。
- **节拍器**：`audio/metronome.js` 用 Web Audio 合成点击声，**只在音频宿主窗口发声**；
  节拍判定来自 `onFrame` 的毫秒 → tick → 小节/拍，不要用 `setInterval`（会漂）。
  `setMetronomeOn(on, {unlock:true})` 只在真实点击时创建 AudioContext；冒烟/调试钩子
  只改状态，否则 Chromium 会记 autoplay warning，冒烟的「零异常」守卫会红。
- **日志统一在 `logs/`**：`logs/boot.log` 由主进程追加写；`start.cmd` / `start.py`
  的健康检查也读它。`logs/` 已进 `.gitignore`，`clean-junk.ps1` 默认清理；根目录不要再写 `*.log`。
- **「跟随」不放在播放条上**（v0.86，用户要求删掉）：它本质是**时间线面板的翻页事件**
  （播放时把播放头滚进视野），归面板管就够了 —— 面板顶栏那个按钮是同一个 `setFollow`。
  放在播放条上会被读成「播放属性」，位置是错的。删了之后 `transport.follow` 两条文案键
  一起删掉，别留孤儿。

## 22. 字体：变音记号必须自带（v0.66）

- **`♭ ♮ ♯ 𝄪 𝄫` 不要交给系统字体**。中文字体（微软雅黑 / Noto Sans SC / 苹方）把这几个字符
  按**全角**画：降号宽近 1em、笔画又粗，跟 `Cmaj7` 排一起像换了个字号；而且「谁先命中」
  取决于用户的**浏览器默认字体设置**（Chrome 装 Noto Sans SC、Vivaldi 装微软雅黑，
  同一段 CSS 出来两个样子）→ 跨平台必然不统一。
- 现在捆一份 5 KB 子集 `assets/fonts/AtlasMusic.woff2`，家族名 **`Atlas Music`**，
  `@font-face` 里 `unicode-range: U+266D-266F, U+1D12A-1D12B`，并排在 `--font-ui` / `--font-mono`
  的**第一位**：只认这五个码位，别的字自动往后面的栈落。canvas 画和弦读 body 的计算字体，自动带上。
- **法律边界**：微软雅黑是 Windows 的系统字体，**只能"点名"，不能"打包"**
  （`font-family: "Microsoft YaHei"` 合法，把它转成 woff2 塞进安装包不合法，
  更不能随 App 发到 macOS）。Bravura 是 SIL OFL 1.1，可以随软件分发、可以改，**只要求改名**。
  子集**必须叫别的名字**（现在是 `Atlas Music`），因为 Bravura 的 OFL 带保留字体名；
  `OFL.txt` 与版权条目原样保留。
- 重新生成：`python tools/fonts/build-music-font.py <Bravura.woff2> <输出>`，
  逻辑（子集 / 改名 / 行高度量 / 重升放大 2.2×）全在脚本里，细节见 `assets/fonts/README.md`。
- **行高度量要改**：Bravura 的 hhea/OS2 是 ±2.012em（按五线谱行距设计），
  不改的话一行 `Cmaj7♭9` 的行盒会变四倍高。子集里压成 800 / -350 + `USE_TYPO_METRICS`。
- **改字形时字宽要减 `nominalWidthX`**（Bravura 是 331）：Type2 charstring 里存的是
  「相对 nominalWidthX 的差值」，而 `T2CharStringPen` 会把你给的数**原样**写进去。
  直接传 240 会让实际字宽变成 240+331=571 —— 字形没错，但 ♭ 占 0.57em，
  比原文还胖，看起来像「字体没生效」。这个坑不报错，只会让字莫名变宽。
- **底边对齐基线**：Bravura 把变音记号画在五线谱的行间坐标系里，♭ 的墨迹是
  y ∈ [-0.175, 0.439]（近 20% 沉在基线以下，排正文像下标）。子集里按
  `TARGET_BOTTOM = -0.02em` 统一上移，五个记号现在都落在基线上。
- 验收看**宽度**不看肉眼：`measureText` 在 100px 下应分别是
  ♭ 24 / ♮ 17.9 / ♯ 26.4 / 𝄪 55.2 / 𝄫 43.5。**五个都要量** ——
  v0.66 只量了 ♭，于是 𝄪 悄悄回退到系统字体（88.3）一直没被发现。
  `document.fonts.check()` 靠不住：字体坏了它照样返回 true。

## 23. 侧栏（Obsidian 式，v0.67）

- 四块（播放列表 / 泳道方案 / 词表 / 维护）的标题**整行可点**折叠，默认全展开，
  状态记在 `ma-side-collapsed`。
- **折叠标记是 chevron，不是实心三角**：一个 `<svg>` + 一条 `M4.5 2.5 L8 6 L4.5 9.5` 的 path，
  `stroke: currentColor`，收起时不转（角尖朝右）、展开时 `rotate(90deg)`（朝下）。
  实心 `▼` 在 10px 标题旁又重又丑（用户原话「大得有点吓人」），别再换回去。
- **chevron 在文字左侧**（Obsidian 的排法）。冒烟用几何量校验：`chev.left < title.left`。
- **侧栏的尺寸全是变量**（`.sidebar` 上的 `--side-*`，用户要能自己调）：
  `--side-inset-l`（**左**留白 36px）/ `--side-inset-r`（**右**留白 12px，两个数故意不联动，
  见第 25 节）/ `--side-rail`（树线横坐标 = 左留白 + 6）/
  `--side-gap`（树线→文字）/ `--side-pill`（选中条左缘 = 左留白 - 8，必须 < rail）/
  `--side-radius`（圆角）/ `--side-sel` / `--side-hover`（底色，**半透明**）/
  `--side-extend`（由前几个推导，选中条向左探出的距离）。改宽度就只动这几个。
- **子项缩进 + 树线**：`.side-group` = `margin-left: var(--side-rail)` +
  `padding-left: var(--side-gap)` + `border-left: 1px solid var(--line)`。
  线要挂在 chevron **角尖稍右、且不跑出这个符号**（用户原话：线跑到标题下面等于「偏到十万八千里」）。
- **选中条必须从树线左边起铺**：组内行 `margin-left: -var(--side-extend)` +
  `padding-left: var(--side-extend)`（文字起点不变）+ `width: calc(100% + var(--side-extend))`。
  只铺到「线的位置」是不行的 —— 那是「卡在线上切一刀」，用户明确否掉过两次。
- **树线用伪元素画在罩子「上面」，不用 border-left**（v0.73）。这是被反复折腾出来的结论：
  只要线在底色下面，就只能靠调底色透明度来保色 —— 底色实一点线「换颜色」，淡一点又
  露原色，两头都试过，没有一个能同时满足「位置对」和「颜色一致」。
  ```css
  .side-group { position: relative; padding-left: calc(var(--side-gap) + 1px); }
  .side-group::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0;
    width: 1px; background: var(--line); z-index: 1; pointer-events: none;
  }
  ```
  **两个前提**：① 行不能是定位元素（`position: static`），否则它自己开层叠上下文，
  把线压回下面 —— **唯一的例外是选中行**，它按方案 E 故意抬到 `z-index: 2`（见第 24 节）；
  ② 原来 border 占的 1px 要补进 padding，否则文字整体左移一像素。
- **因此底色可以随便调**：`--side-sel`（accent 18%）/ `--side-hover`（`--surface-2` 70%，
  与界面别处的 hover 同浓度）—— 不用再为了「让线透出来」牺牲一致性。
- **验证靠真实像素**，不是靠 z-index 对不对：冒烟里真的 hover 一行、截图、读像素，
  线所在 x 的 RGB 必须等于 `--line` 的原色（±2），且罩子内部那一点必须**不等于**线色
  （证明罩子确实在，只是没盖住线）。`z-index` 写对了不等于画对了。
- 折叠用的是 `v-if`，所以**收起再展开后 DOM 会被重建**：冒烟里量尺寸前要重新取元素，
  抱着的旧引用已经脱离文档，`getBoundingClientRect()` 全是 0（踩过）。
- **新建播放列表 = 立刻进入改名态**（v0.86）：`newPlaylist()` 建完直接调 `beginPlRename(last.id)`，
  聚焦并**全选**。全选是关键 —— 光标落在末尾的话，第一个字会追加成「播放列表 3我的歌」。
  Enter / 失焦提交，Esc 取消改名（**列表保留**，取消的只是改名）。
  改名态那一行渲染成 `.side-i.side-rename` + `<input>`，**没有 `.on` 类** ——
  所以冒烟不能再靠 `.side-i.on` 找「刚新建的那条」，要直接找 `.side-rename input`。
- **三块标题右键可搜索**（2026-11-14，决定 58）：播放列表 / 泳道方案 / 词表标题的右键菜单里
  都有「搜索…」；点开自动展开该块并在标题下出现内联输入框（`.side-search`），
  输入即按**标题关键词**过滤，Esc / × 收起并清空。只匹配标题、不做分词 / 拼音、
  不搜词表条目。新增侧栏分组时记得同时接 `openPlMenu($event, null, section)` 与
  `filtered*` 列表，否则会出现「右键有菜单、搜索框过滤不到自己」的半截功能。

## 24. 曲目列表：右键菜单 / 树箭头（v0.77）

- **右键曲名 = 打开这一行的菜单，不是直接改名。** 菜单顺序固定：
  播放 / 更改标题 / ─ / 添加到播放列表… / 从「某某列表」移出 / ─ / 删除这首曲目…。
  `从播放列表移出` 只在 `activeList` 是**具体列表**时出现 —— 在「全部曲目」里给这一项
  等于给一个「按了没反应」的按钮。
- **规矩跟侧栏菜单同一条**（§23 那套）：`position: fixed` + 开之前夹进视口；
  点别处关、Esc 关。两条菜单共用**同一个** `pointerdown` 监听（`onDocPointerDownMenus`）——
  别给新菜单再挂一条 window 监听，否则迟早出现「关一个漏一个」。
- **改名入口没变**：菜单里的「更改标题」仍然落到 `editRowId` 那个行内输入框，
  走同一套 Enter / Esc / 失焦逻辑。改的是入口，不是机制。
- **两个改名入口的乐章补全必须一致**：`editPrefix` 只是「新建乐章时的默认前缀」，
  不能当成补全的开关。右键「更改标题」没有这个值，`movementFragment()` 会从标题
  自己认 `第三乐章 / 3. / III. / Movement 3` 前缀（`movementTitlePrefix()`）；
  否则整串标题拿去匹配，表现是「新建时能补、右键改名怎么打都不出候选」。
- **添加到播放列表 = 弹窗选一条**，点哪条就进哪条、立刻落盘（`playlists:set-tracks`）并关窗。
  已在其中的那条**禁用**并写「已在其中」（不隐藏：用户要能看见「这首已经在哪儿」）。
  一条列表都没有时给「新建并加入」，别让人先去侧栏建一个再回来。
  弹窗关掉后状态栏给一句 `已添加到「X」` —— 否则点完什么都没变，像没点着。
- **删除曲目走 `removeSelectedTrack(id)`**：进去先把那一首 `select()` 过来再删。
  确认框、音频清理、删完选邻居都按「当前曲目」算，不先切会删掉上一次选中的那首。
- **树的展开箭头用 chevron，不用 `▾`**：和侧栏 `.side-chev` 同一份
  `viewBox="0 0 12 12"` + `M4.5 2.5 L8 6 L4.5 9.5` + `stroke-width: 1.5`。
  收起 0°（角尖朝右）、展开 90°（朝下）。**旧写法（`▾`）在模板里以注释保留**，
  回滚就取消注释、删掉 `<svg>` —— 请求明确要求「先留着，方便回滚」。
  验收量 `getComputedStyle(el).transform` 的角度：方向写错时两边都是「一个 V」，看截图分不出来。
- **鼠标点过的按钮不画焦点环**（v0.78）。现象：点一下展开箭头、再按空格播放，
  箭头旁边冒出一个绿色方框。根因**不是箭头**，而是「空格是全局播放键」：鼠标点完焦点留在按钮上，
  随手按任意键，Chromium 就按协议把元素提升成 `:focus-visible`。
  修法是记 `data-input` 在 `<html>` 上：`pointerdown → pointer`、**只有 Tab → keyboard**，
  样式里 `:root[data-input="pointer"] button:focus-visible { outline: none }`。
  别改成「按键就切 keyboard」（空格一按环又回来），也别整段删掉 `:focus-visible`
  （键盘用户 Tab 过去就看不见焦点在哪了）。监听要用捕获阶段，子组件的 `.stop` 拦不住它。
- **树线方案定稿 E**（2026-11-08）：选中的那条 `.side-i.on` 抬到 `z-index: 2`，压在树线之上，
  高亮块是完整一块；hover 仍在线之下（扫过时线连贯）。六个候选（a / b / c / c2 / e）的对照图
  已经删掉，不留「以后重拍」的实验代码 —— 结论就在样式注释里，改之前先读它。
  验收改成读像素：hover 行线色 `== --line`，选中行线色 `≠ --line` 且绿通道明显高于红通道。

## 25. 侧栏宽度 / 整体收起（v0.84）

- **左右留白是两个变量，故意不联动**：`--side-inset-l: 36px` / `--side-inset-r: 12px`。
  共用过一个 36px，结果是「左边顺眼、右边空得晃」（用户 2026-11-08 要求解耦）。
  `--side-rail` / `--side-pill` 仍从**左**边推；标题行 padding、组右 margin、行的
  `padding-right` 都改用 `-r`。旧的 `--side-inset` **已删除** —— 它只要还活着，
  左右就又被捆在一起了。冒烟里有一条断言专门读它（读到非空即红）。
- **最小宽度是量出来的，不是常量**（`measureSideMinW`）：
  `max(每条静态文案的「左侧占位 + 完整文字宽 + 右侧占位」) + 2em`。
  - 文字宽用 canvas `measureText` 按**它自己的 computed font** 量。不能拿 `textContent`
    配主字体一把量：`.side-title` 里嵌着 `.faint` 小字，整段按大字号量会明显虚胖。
  - 左右占位从元素 `getBoundingClientRect()` 取：flex 撑满的元素，其 rect 边缘
    **不随文字长短变化**，减一下就得到容器给的固定留白（含树状缩进、chevron 槽）。
  - 那 2em（= 两个全角）**加在右侧**，所以 `--side-inset-r` 调大时下限会自己跟着长，
    不会出现「留白越大、字越挤」。
  - **不量 `.side-name`**：那是用户起的播放列表名，算进去等于让一个名字把侧栏顶到半屏。
  - 重算时机：`onMounted` + `document.fonts.ready`（字体没到会量成回退字体的宽度）、
    切语言、换字体、四块标题折叠状态变化、从收起展开。
  - 四块里有折叠时**只许把下限调大**：那时有些行没渲染、量到的文案不全，
    双向更新会让下限越量越小。
- **超长名字一律省略号，不许挤压换行**（用户明确要求）：
  `.side-label` / `.side-name` = `min-width: 0` + `nowrap` + `overflow: hidden` +
  `text-overflow: ellipsis`，右端的 `.num` 加 `flex: none` 永不被压。
  `min-width: 0` 是必须的 —— flex 子项默认最小宽度是内容宽，少了它 `text-overflow`
  根本不触发（这类 bug 的唯一常见原因）。
- **两根栏都能整体收起**（`leftCollapsed` / `rightCollapsed`，记在 `ma-left-collapsed` /
  `ma-right-collapsed`）。和 §23 的「四块标题折叠」是两件事：那个折的是内容，这个折的是整根栏。
  收起 = grid 列宽设 0 + `overflow: hidden` + `min-width: 0` + 收掉边框
  （`min-width: 0` 不能省：grid 子项默认 `min-width: auto`，会按内容撑住不缩）。
- **三个入口共用一份状态**：边缘悬停块、视图菜单（带勾选）、`Ctrl+B` / `Ctrl+D`。
  `Ctrl+D` 取 Detail 的首字母；用户嫌 `Ctrl+Alt+B` 单手按着难受。
  输入框里这两个键**让路**（在 `isEditableTarget` 的放行列表里）。
  收起后再点一首曲目**不会自动弹开** —— 收起是用户意图，优先级高于「选中了就该看看」。
- **边缘把手和拖拽手柄共用一个手势**：识别区 22×96px，视觉是 14×38 的圆角块
  （灰色半透明 `--text-faint` 26% + 中间一个直角箭头，和标题 chevron 同一份 path）。
  在块上按下后位移 < 4px = 点击；超过就交给 `startSplit` 转成正常拖宽。
  别给「点」和「拖」各挂一套逻辑 —— 那样迟早出现「想点结果拖动了」或「想拖结果收起来了」。
- **把手位置必须跟着栏宽走**：`left: calc(var(--left-w) - 4px)`。
  第一版写成 `left: -4px`，结果它贴在**窗口**最左边 —— 用户圈的是栏边界，那里什么都没有，
  而冒烟当时照样通过（测试是往元素上 dispatch 事件，不关心它在屏幕哪儿）。
  **凡是「位置」类断言都要量几何，不能只 dispatch 事件。** 收起时 `--left-w` 是 0，
  calc 自然得 -4px，正好贴回窗口边，不需要特判。
- **箭头指方向**：展开态指「收起会往哪边去」（左栏朝左、右栏朝右），收起态反过来。
  收起时块常亮（栏宽 0 之后它是唯一线索），并且要整块收进窗口内，否则一半被裁掉。
- **留白按主题各存一份**（`ma-side-inset`，浅 / 深各 `{l, r}`）：
  同一个 36px，深色下顺眼、浅色下嫌宽 —— 两种底色对留白的观感本来就不一样。
  跟着**当前实际生效的 theme**（不是 mode）取，内联变量覆盖 CSS 默认值；
  `--side-rail` / `--side-pill` / `--side-extend` 都是从 `--side-inset-l` 派生的，自动跟随。
  改完要重算最小宽度，切主题也要（两套留白的左右占位不同）。
- **省略号和右侧计数之间留 10px，计数锁 `min-width: 2ch`**：
  不锁宽的话，一位数和两位数会让文字那侧被吃掉的空间不一样，省略号的终点就跟着跳。
- **拖到下限后再往里挤 32px（`COLLAPSE_PULL`）→ 松手才收起**。拖动过程中宽度被夹在下限；
  松手判定收起时要把 `leftW` **还原成拖动前的值**，否则下次展开回来的是那个被夹过的下限。
- **收起状态下往外拖也能展开**：拖出 32px 才真的展开（避免一碰就弹出来）。

## 26. 注释密度（2026-11-08 用户提出）

用户原话：「有些注释多了点有点脏」。他自己删了一批，并在侧栏样式上方留了一行
`/* 侧边栏外观配置 - 涉及 松紧、缩进、圆角*/` —— **那行是给搜索框定位用的，别删、别扩写。**

- **一条注释只回答一个问题**：这个值为什么是这个数 / 为什么不能那样写。
  不写「这里演示了……」「下面设置了……」这种把代码翻译一遍的东西。
- **只有踩过坑的地方值得长注释**（例：`left: -4px` 贴到了窗口边），
  推导写两三行就够，别写成复盘报告。
- **每个视觉模块顶部留一行锚点**：像索引，不像文章，用户靠它跳过来改数值。
- 数值旁边写「单位 + 为什么是这个数」，不写「这个值可以改」（那是显然的）。

## 27. 音频元数据（v0.87）

**入口挂在录音行上，不挂在曲目行上。** 元数据属于**文件**，不属于作品 ——
实测同一个作品挂 8 条录音（同一份音乐导成 wav/mp3/flac/ogg 各版本），
`readTags` 每条返回的东西都不一样：第一版 wav 有 `bext`+`iXML`（bpm 72 / 4:4），
格式工厂那条只有 ID3，flac 只有 STREAMINFO，ogg 只有 vendor，无标签的 wav 全空。
所以「右键哪条就看哪条」不是交互偏好，是**数据模型**决定的。
（用户第一版做在曲目行上，被明确指出要挪下来。）

四个容器四种藏法，`shared/audiotags.js` 负责抹平。下面每条都是踩过的、**不报错只出错**的。

- **`iXML` 在 `data` 之后**（文件尾）。只读头 64KB 永远看不到它 —— `probeFile` 里
  `readTail()` 必须一起传给 `readAudioTags`。反过来，**尾部不能从偏移 12 开始按块遍历**：
  那里是音频数据的中间，读出来的 id/长度全是垃圾，只能按标记（`iXML`/`bext`/`LIST`）定位。
- **同名兄弟元素必须编号**。Cubase 的 `iXML` 里 20 个 `<ATTR>` 路径完全相同，
  拍平后不编号 → `NAME`/`VALUE` 互相覆盖，**只剩最后一个**（表现：明明 15 个自定义字段，
  面板上只有 1 个）。现在拍平成 `ATTR`、`ATTR#1`…，配对正则写 `\/ATTR(?:#\d+)?\/`。
- **拍号是 `rational` 类型**：`<ATTR><NAME>MusicalSignature</NAME><NUMERATOR>4</NUMERATOR>
  <DENOMINATOR>4</DENOMINATOR></ATTR>` —— **没有 `<VALUE>`**，那套「NAME/VALUE 配对」
  合不出它，得顺着 NAME 所在的前缀单独取分子分母。
- **UTF-16 别写「先翻字节序再按小端读」**。两步抵消看着对称，实际等价于把 LE 读成 BE：
  `52 97`（青）会被读成「劗」。直接按 `lo/hi` 取向，别搬字节。
- **`subarray(负数)` 是从末尾算的**。`buf.subarray(buf.length - 65536)` 在文件比 64KB 还小时
  只取到最后一点点（不是全部），测试里因此漏掉了开头的 `iXML` 标记。要 `Math.max(0, …)`。
- **`bext` 的 `Originator`/`Description` 规范是 ASCII**（EBU Tech 3285，32/256 字节定长）。
  Cubase 往里写 **UTF-8**，Windows 资源管理器按系统 ANSI（GBK）读 → 「闈掍护闊�」。
  **不是我们的 bug**：同一份信息 Cubase 在 `iXML` 里也写了一份（UTF-8 XML），那边完全正常。
  要写中文就写 iXML，`bext` 那两栏只放英文/拼音。
- **`bext` 的 `TimeReference` 是采样数，不是毫秒**（换算要用文件采样率），而且它记的是
  「这段音频在工程时间线上的起点」，不是音频内容 —— 从 0 开始导就是 0，本次实测是
  17248000 采样 ≈ 359 秒，说明导出区间不在工程 0 点。
- **元数据块不影响偏移**。三个同内容的 wav（带 `bext`+`iXML` / 只有 `iXML` / 都没有）
  互相关全是 **lag 0**，`data` 长度一字节不差（7,680,000）。块只加在音频前后，不插进采样流。
- **ogg 的时长在最后一页的 `granulepos`**（64 位小端），头里根本没有。
  以前 `probeAudioInfo` 对 `OggS` 直接返回空壳 → 时长恒为 0 → 列表显示「—」。
  尾页的 granulepos 可能是全 F（该页没有完整 packet），要**继续往前翻**；
  opus 的 granulepos 恒按 48kHz 计，且要减掉 `preSkip`。
  另外 `setAudioPath` 必须走 `probeFile` 而不是裸的 `probeAudioInfo` ——
  `COALESCE(?, duration_ms)` 挡得住 NULL，挡不住 0。

## 28. 网格多选与方向键（v0.88）

- **选中框要按「连续段」画，不能取外接并集。** Ctrl+点第 11 小节、再点第 13 小节，
  外接大框会从 11 拉到 13 —— **第 12 小节什么都没选中，却被框在里面**，
  看起来就是「Ctrl 被当成了 Shift」。现在按「泳道 + 连续性」分组：挨着的合一个框，
  断开就各画各的。冒烟用 `__ma.selBoxes()` 数框的个数与缺口（比像素采样稳得多）。
- **`pickedIds` 必须始终等于「当前全部离散选中」。** 以前「普通点 A → Ctrl+点 B」只把 B 放进 picks，
  A 只活在矩形里；接着再 Ctrl+点 B 取消它，**A 和 B 一起消失**。
  现在第一次 Ctrl+点会先把矩形里已选中的块**冻结**进 picks。
  矩形本身不要扩成外接范围 —— 那会把中间那块也框进 `selEvents`，就不是离散选中了。
- **空泳道不能是死路。** 斯波索宾体系的「备注」(`note`) 常常整首一个字都没写：
  选区落上去以后，方向键以前直接「到头停住」，只能先去点一下和弦标记行。
  判据是**整条泳道为空**才跨泳道（优先同一起点，其次按距离，同距离按视图顺序取靠上的）；
  **有内容却走到最后一块，仍然停住不跨行** —— 否则方向键会莫名其妙跳到别的泳道。
- 冒烟要验这条，先把 `.smoke-data` 副本里的 `note` 事件清空（不能假设用户库里它是空的），
  再用 `__ma.selectCellAt(laneId, tick)` 把选区落到空格子上。这个接口就是为这一条存在的。

## 29. 方向键 = 光标（v0.89）

用户原话：「左右方向键选择的**光标化**……没有相邻的和弦块儿，那么按左右方向键，只挪动一格」。
这一版把 v0.88 的「空泳道自动跨泳道」**撤掉了** —— 跳块和切泳道是两个键的事，别让一个键干两件。

| 按键 | 行为 |
|---|---|
| `←/→` | **平移一个选区宽度**（宽度保持）。**光标态**（宽度正好一格）落到有块的格子才吸附整块；宽度 > 1 时只平移。左右步长必须对称 —— 早先左移写死「起点 − 1 tick 所在格」，框三格时右键走三格、左键只走一格 |
| `Ctrl+←/→` | 跳到**当前泳道**的上一块 / 下一块，到头停住（不跨泳道） |
| `Ctrl+Shift+←/→` | 把选区扩到上一块 / 下一块的边界 |
| `Shift+←/→` | 扩 / 缩一格（`←` 先把右端收一格，收不动了才向左扩） |
| `↑/↓` | 换泳道，tick 范围不变；落到块上吸附整块 |
| `Alt+←/→` | 单选一个块 → 改块真实时值（写库）；多格选区 / 空格 → 只改选区跨度 |
| `Backspace` | 退回**当前网格单位**的一格（小节 / 拍 / 半拍）并进入输入。不是固定一拍 —— 网格设成小节时按一下退 1/4 格，和看得见的格子对不上 |

- **「相邻」的判据是「这一格里有没有块的起点」**，不是「块和光标之间有没有缝隙」。
  后者会让隔半格的和弦永远走不进去。
- 位置一律走 `cellAtTick(meters, ppq, tick, div)`，**不许加减常数** —— 变拍号会错格。
- **`revealSelection()` 要管垂直**：有了 ↑/↓，光标会跑到视口上下之外，
  只滚水平等于「选中了一个看不见的东西」。垂直判定要减掉 `headH`（头带是 sticky 的，会盖住顶部）。
- `Alt` 在多格选区上以前**完全没反应**（`nudgeSpan` 只在「选区正好等于一条事件」时动手），
  看起来像键坏了；现在退成 `resizeSelection`（只改跨度、不写库）。
- 冒烟验这些要用 `__ma.selectCellAt(laneId, tick)` —— 它必须走 `placeSelection`
  （含 `revealSelection`），否则「选中即跟随」这条在测试里验不到。

## 30. 元数据填档案：先确认再写（v0.89）

文件的标签**不一定可信**（转码器会把上游工程的信息原样带过来）。所以「填入档案」不是一步写完，
而是弹一个逐字段的确认窗口：`☑ 字段：文件值 → 档案值`，默认全勾，可以取消脏数据。

- 只列**档案真能写的**字段（`tracks:update` 支持 title/album/bpm/meter）；
  `date` 也列出来但勾选框禁用 + 标「档案无此字段」——**勾了没效果比不能勾更糟**。
- 面板（`AudioMetaDialog`）只负责 emit `apply`，确认窗口（`MetaApplyDialog`）只负责收集勾选，
  **写库永远在 `App.vue` 一处**（`tracks:update`），保持单一写入口。
- 冒烟要验这条得**自己造一个带 iXML 的 wav** 并临时关联到一条非默认录音，
  用完恢复 `file_path` 与被改的 `bpm` —— 不能假设用户库里有带 iXML 的文件。

## 31. 标题模板（2026-11-15）

**标题 / 乐章名可以是一段模板，而不是死文字。** 语法借 Sibelius：`%变量名}`，
`%` 是起点、`}` 是终点（变量名里允许空格，如 `%Number of the form}`）。
解析与展开只有一份：`shared/titleTemplate.js`；列表、详情、状态栏都走
`renderer/src/titleTemplate.ts` 的 `displayTitleOf()`，不许各写一套。

- **缺失变量整段消失**，不是留空串、不是写 N/A：`%Movement Number} %Sub-Type} - %Tempo Term}`
  在 Sub-Type 为空时得到「第二乐章 - 柔板」。展开后只收**空变量留下的空位**、
  标点前空格和悬空分隔符；模板里字面的连续空格不动（用户可能拿它对标题），
  一个值都没有时退回模板原文（标题不能变空）。
- **标题展示必须是 `white-space: pre`**（详情 / 曲库列表 / 乐章行三处）：
  `nowrap` 会把连续空格折成一个，用户手打的空格就白打了。`pre` 同样不换行，
  继续用 `text-overflow: ellipsis` 截断；别改成 `pre-wrap`（会把单行标题折行）。
  输入框和存储不需要特殊处理，保存只 `trim()` 首尾。
- **数据项**：`basic.formNumber`（No.1）、`basic.opusNumber`（Op.2, No.1 / `N/A`）、
  `basic.subType`（体裁词表 id，如 `menuett`）、`basic.tempoTerm`（小快板 / Allegretto）。
  DB 里暂存在 `track.extra`，`seed` 与 `writeTrackDoc` 两头读写；JSON 仍是源。
  `N/A` 是真实值，中文界面显示「不适用」，英文界面保持 `N/A`。
- **变量取值**：`%Composer}` → `credits.composer`（没有就 `track.composer`）；
  `%form}` → 体裁（`composition_type`，词表没有的原文照显示）；`%Key}` → 第一条调性；
  `%Movement Number}` → 标题里自带的序号，认不出就按它在母作品下的位置；
  `%Sub-Type}` / `%Tempo Term}` → 上面两个乐章字段。**不为模板另造词表**：
  Sub-Type 走 `composition_type`，Tempo Term 走 `tempo_marking.json`；
  英文界面取 `name`（Menuetto / Allegretto），中文界面取 `display`（小步舞曲 / 小快板）。
  旧模板里的 `%sub-form}` 仍作为别名识别，但新预设和档案统一写 `%Sub-Type}`。
- **预设**：内置 `for_Classical_Opus` / `default_movement`；用户预设存
  localStorage `ma-title-presets`（只影响输入候选，不进曲库）。预设带作用域
  （title / movement），标题输入只提示 title 预设，乐章行只提示 movement 预设。
  选中候选 = **整条标题换成模板原文**，不是把预设名插进某个词的位置；
  标题和乐章行内改名两条路径共用同一套匹配。
- **模板编辑器**（选项 → 标题模板）是「透明 textarea 盖在绿色镜像层上」，不要改成
  contenteditable：输入法、撤销栈和选区全部要自己重做。变量整段（含 `%` 与 `}`）
  用 `--accent`，其余正文色；候选下拉里的模板预览也用同一套绿色。
- **不要存渲染后的标题**。`title.original` / `track.title` 保存模板原文；展开只发生在显示层。
  代价：JSON 文件名与标题搜索仍按模板原文走 —— 要改的话先设计「文件名用哪一列」，
  别在写回器里临时拼。

**未标注**（决定 56）的字体从这一版起不再斜体：颜色淡、字号与下方调性一致（11px），
它只是没填，不是另一种值。



想让树线「细一点」时试过 `width: 0.5px`：**和 1px 的截图逐字节相同**。
DPR = 1 时 Chromium 会把 0.5 铺成 1 个物理像素、满色，看起来并没有变细；
只有 DPR ≥ 2 时才是真正的半个物理像素。
在这个项目里，「更细」只有一条路：**降不透明度**（`color-mix(--line 60%)`）或渐变淡出。

## 32. 启动配置外置 config.json（2026-11-15）

**凡是「怎么启动」的偏好，不进 localStorage、不进作品库，统一进
`userData/config.json`。** 当前字段：`safeMode`、`startup.lyrics`、`startup.help`。
主进程 `ConfigStore` 是唯一读写方；选项里的开关走 `config:get/update` 立刻写盘，
`win:app-ready` **以配置文件为准**，渲染层传来的值只在文件读不到时兜底。

- 文件不存在时启动自动生成；语法错了不拦启动，按默认值跑，选项里报错。
  用户在坏文件上再点选项时，先备份成 `config.json.bad-<时间>` 再写。
  写盘失败要抛回界面并把开关拉回文件值，不能只打日志还让界面显示「已保存」。
- 认识的键写回，不认识的键原样保留；不要让一次界面保存把用户手加的字段吃掉。
- **安全模式**：当前没有插件系统，先接管「不自动打开歌词 / 帮助窗口」；
  以后接插件加载必须先读 `safeMode`。勾上安全模式时两个自动开窗开关在界面上禁用，
  但保留原值，关掉安全模式后恢复。
- 旧版只有 `ma-help-auto` 真的写过（歌词那个复选框从来没落盘）。只在配置文件
  `fresh` 时迁移一次，写盘成功后才删旧键。
- 冒烟要验**磁盘**：勾选后读 `config.json`，不能只看界面 ref 或 IPC 返回值；
  收尾把两项恢复默认，别把冒烟 profile 的偏好带进下一轮。

<a id="netease-playback"></a>

## 33. 网易云外链播放（2026-11-15）

### 协议格式：客户端打开不等于指令被执行

- 本机 Windows 网易云 PC 客户端收到 `orpheus://song/<id>/?autoplay=1` 时，能被唤起，
  但仍停留在上次的歌曲；**增加 autoplay 参数并没有打通播放**。
- 当前使用官网「打开客户端播放」的指令：`orpheus://` 后接下列 JSON 的 UTF-8 Base64，
  由主进程 `shell.openExternal` 交给系统；`id` 保持数字字符串，不转成 JavaScript Number。

  ```json
  { "type": "song", "id": "458725738", "cmd": "play" }
  ```

- 格式生成只在 [src/shared/netease.js](../src/shared/netease.js) 的 `songDeepLink()` 中维护；
  不要给编码结果再补 `/` 或 `?autoplay=1`，也不要让各个界面分别拼协议。
- `shell.openExternal()` 成功只代表系统接受了打开请求，**不能证明客户端切歌、开始播放或拥有播放权限**。
  成功提示使用「已向网易云客户端发送播放请求」，不能写「已播放」；异常也不能一律解释为「客户端未安装」。

### 入口统一，保留作品与录音版本的区别

- `netease:open` 与 `link:open` 两个 IPC 都调用
  [src/main/ipc/netease.ts](../src/main/ipc/netease.ts) 的 `openMusicLink()`；
  作品、详情链接、录音版本及版本管理窗不再各走一套外呼逻辑。
- 双击作品：本地音频优先；无本地音频时，第一录音版本的 `link` 优先，再回退作品的网易云链接。
  **只在录音版本登记了链接也必须能播**，不能只检查作品层的 `neteaseUrl`。
- 双击指定录音版本：只用该版本的音源；未绑定本地文件或文件已不存在时才使用它的 `link`，
  不改默认版本、不改排序。来源提示也要考虑录音链接，不能显示成「没有音源」。

### 外部输入与回退

- 只接受合法 HTTP(S) 网页链接，拒绝携带用户名/密码的 URL，以及 `file:`、`javascript:`、
  用户直接传入的 `orpheus:` 等协议；自定义协议只能由经过校验的歌曲编号生成。
- 只有 `music.163.com` 及其子域名的歌曲路由才提取编号：支持 `/song?id=…`、`/#/song?id=…`、
  `/m/song?id=…`、`/song/<id>` 等形态；编号必须为非零开头的正整数字符串。
  专辑、歌单、歌手、`userid`、其他站点的 `id` 或伪装域名不能当成歌曲编号，**禁止抓任意长数字串兜底**。
- 网易云歌曲先发客户端指令，系统调用抛错再用浏览器打开**原链接**；其他网页链接直接交给浏览器。
  两次系统调用均失败时返回失败和错误原因；不替换成代理站，也不承诺浏览器一定能播。
- 已移除隐藏 `BrowserWindow` 抓取网页入口的路径：不再依赖页面等待时间、按钮文案或执行网页脚本，
  也不把页面里捡到的任意外部协议直接交给系统；当前未识别的短链仅打开原网页。

### 验收分三层，不能用自证式断言代替实播

1. **纯函数 / 模拟系统调用**：`node --test tests/netease.test.mjs`。
   将 deep link 解码，核对 `type / id / cmd`；覆盖 query/hash/path、非歌曲链接、伪装域名、非法协议、
   客户端失败后浏览器回退、全部失败以及冒烟模式不外呼，而不是只比较实现自己拼出来的旧字符串。
2. **IPC / 界面入口**：两个 IPC 都应生成同一条歌曲播放指令；`--smoke` 必须同时拦截客户端和
   通用浏览器外呼。冒烟通过只能证明内部路由正确，不能证明第三方客户端执行成功。
3. **真实客户端**：在非冒烟实例双击作品，再双击两个不同录音版本；检查客户端的实际曲名与
   播放/暂停状态，而不是只看窗口出现或本应用成功提示；同时验本地音频时钟前进、无音源提示、默认版本与排序不变。

### 排障与测试隔离

- 先只读检查系统的 `orpheus` 协议关联；关联存在但只开首页时，先核对指令格式，
  不要先重装客户端或改注册表。本次修复没有修改协议关联、系统设置或真实曲库。
- 手工实播测试同时使用**独立数据目录**（`MA_DATA_DIR`）和**独立用户配置目录**（`--user-data-dir`）；
  仅换一个目录仍可能污染数据或撞单实例锁。测试曲目和录音只在副本创建；从 JSON 建的新库
  不含完整录音版本树，不能拿它覆盖真实 `atlas.db`（见 PENDING「录音层持久化」）。
- 启动测试 Electron 前清掉 `ELECTRON_RUN_AS_NODE`；非冒烟实播不能带 `--smoke`，否则外呼本来就被拦截。
  开发服务器换端口时以启动日志为准，先核对实例的 `api.meta().dataDir` 再操作，避免把原窗口当测试窗口。
- 桌面自动化遇到最小化或遮挡，先激活目标窗口并重新观察，再用新截图/控件定位；
  不复用过期坐标，也不在结果不明时重复双击。测试结束暂停播放，只关闭测试实例，保留用户原窗口。
- 修改主进程后的 `npm run build` 只更新磁盘产物；旧进程仍运行旧逻辑，需保存编辑后重启。
  不为测试强杀所有 Electron 进程；安装/卸载客户端、修改协议关联或系统设置前先说明影响并征求确认。

本次实际验证结果、官网依据及未验证范围见 [决定 65](schema-log.md#netease-playback-20261115)，
后续边界见 [PENDING：网易云外链](../PENDING.md#netease-playback-limits)。

<a id="timeline-only"></a>

## 34. 无本地音频：仅时间线播放（2026-11-16）

### 自动同步先证伪，再降级

- 目标本来是「读网易云客户端的播放进度，让播放头与客户端同步」。本机（Windows 10.0.19045）
  通过官方 WinRT `GlobalSystemMediaTransportControlsSessionManager` 能读到 `cloudmusic.exe`
  的曲名、作者和 `Playing/Paused`，但 `Position`、`StartTime`、`EndTime`、`Min/MaxSeekTime`
  全部是 0，`LastUpdatedTime` 是未初始化的哨兵值，`CanSeek=false`；展开播放页的无障碍树
  也没有进度数值。**公开接口拿不到可用的播放时钟**，所以本轮不做自动同步。
- 不为了「看起来能同步」去读进程内存、注入客户端、私开内部接口或把「从 0 一起启动」
  说成已对齐。界面必须把「仅时间线」标出来，并在外链启动时间线时写明「未与客户端同步」。
- 启动延迟（客户端起播比指针晚）本轮**不补偿**；需要帧级精确时用录屏 + 剪辑软件按波形对齐。
  将来若官方或公开接口提供位置，再按同一套 `sourceMode` 契约接入，不改现在的界面语义。

### 模式不变量

- `state.sourceMode` 三态：`audio`（本地文件）/ `timeline`（静音墙钟）/ `none`。只有主窗口
  （`audioHost`）持有真实时钟或本地 `<audio>`；独立窗口仍只发指令、收 `player:state`。
- 时间线时钟是纯函数 `shared/timeline-clock.js`：位置 = 起点 + 单调 `performance.now()` 差值，
  **不按 rAF 帧数累加**；掉帧不改变速度。暂停冻结、播放中跳转重新锚定、到末尾自动停。
- 本地音频分支一行不改语义：编码器预热、`leadMs`、波形、EOF 保护、错误提示都仍只作用于
  `audio` 模式；时间线模式不创建/不播放 `<audio>`，进入前清掉旧 `src`。
- 没有音频不再等于「播放键不可用」：`ready` 在时间线总长 > 0 时为真，播放键、回到开头、
  拖进度、读数跳转和「以播放头为原点」都可用。没有总长时播放键给出 `audio.noTimeline` 提示。
- 双击回落顺序：本地音频 → 外链（成功唤起时顺带启动时间线）→ 静音时间线；
  只有时间线总长也为 0 才提示「没有可用音源」。外链失败时不会假装时间线已和客户端对齐。

### 总长、原点与「卡点」

- 总长 = 档案终点（最后段落 + 10 小节 / 最后事件 / 最少 48 小节，按拍号与速度换算）
  **+ 当前录音版本自己的 `audio_offset_ms`**，由 `timelineDurationMs(analysis)` 计算；
  解析到本地音频时完全忽略它，避免拿推算值覆盖文件真实时长。
- 外链录音版本必须先 `loadTrack(trackId, recId)` 把它设为当前版本，再打开外链。
  直接双击版本行也要走 `loadRecVersion()`：否则时间线的原点还停在上一个版本，整体会偏。
- 原点偏移仍写 `recording.audio_offset_ms`（没有录音版本时退回 `analysis`）。
  「以播放头为原点」在时间线模式下可用，写库前仍要确认；改完重新按
  `timelineDurationMs` 更新总长，但**不覆盖用户手动改过的总长**。
- 卡点换算只有一条：`tickOfAudioMs = msToTick(tempos, ms - audioOffsetMs)`。
  本机实测：Sibyl（130 BPM）把原点设为 5000ms 后，`seekMs(5000)` 与
  `seekMs(5000 + 一拍×4)` 的播放头位移 = 56px，`xOfTick(1920) - xOfTick(0)` 也是 56px；
  时间线与本地音频共用这条映射，不需要第二套逻辑。
- 手动总长只活在本次会话（`timelineDurationManual`），切曲目/版本会重置；不写 JSON、
  不改数据库。要持久化必须先定义它属于作品还是录音版本，见 PENDING。

### 跨窗口与状态广播

- `PlayerState` 增加 `sourceMode`，广播仍由主窗口负责；独立窗口收到后同步徽标、总长与
  `ready`，位置继续用本地插值。独立窗口改总长发 `{type:'duration', ms}` 指令，
  由主窗口执行后广播回来，避免两个窗口各算一套。
- 独立窗口按播放仍要求主窗口也在同一首（原有约束）；不同曲目时仍按
  `audio.hostOtherTrack` 提示，不把时间线时钟偷偷跑在从属窗口里。

### 验收

- `tests/timeline-clock.test.mjs`：单调时钟、暂停/续播、跳转夹取、末尾重播、时长变更、
  变拍变速的总长、130/107 BPM 与偏移的往返映射。
- 冒烟新增两条并全量通过（**577/577**）：无本地音频时播放键与「以播放头为原点」可用且标出仅时间线；
  播放后指针按墙钟前进、暂停后停住。
- 隔离实例实测：时间线 500ms 内前进 ~500ms；暂停后 300ms 位置不变；手动总长 10s 后
  9.7s 起播 0.7s 会停在 10s；在独立窗口按播放/暂停能驱动主窗口时钟；主窗口把总长改成 20s
  后独立窗口同步为 0:20.000；切回本地 FLAC 后 `sourceMode=audio`、播放时钟正常前进。
- 本轮顺带修复：全新 `userData` 下 `restoreGain()` 用 `Number(null)` 把主输出读成 0（静音）。
  现在先判 `localStorage.getItem('ma-gain') === null`，没有存值就保持默认 0 dB
  （全新隔离 profile 实测 `gain=1`，`ma-gain` 仍为空）。
- 独立窗口仍按作品级 offset 画网格、播放命令仍要求主窗口在同一首：这是**既有约束**，
  本轮只同步了 `sourceMode` / 总长。用逐版本 offset 对轨请以主窗口为准；
  何时把 recId / offset 带进 `#grid` 路由，记在 PENDING。

## 35. 加一门界面语言（v0.90 · 日语）

日语是第一个「后加」的语言，流程固定下来，下次加韩语照走：

1. **词典单独一个文件**：`src/shared/i18n.ja.js` 只导出 `JA`。`i18n.js` 已经三千行，
   再塞一份进去，改一句日文要滚过两千行中文。中文与英文仍在 `i18n.js` 里（历史原因，
   不动它们，免得一次改动碰三千行）。
2. **四处登记**：`LOCALES`（label 用**该语言自己的写法**）、`DICT`、`normalizeLocale()`
   （`ja-*` / `ja_*`，另外收常见的误写 `jp`）、`htmlLang`。`isLocale()` 现在是看
   `DICT` 有没有这个键，不用再改。
3. **键集必须一条不差**：`tests/i18n.test.mjs` 现在对 `LOCALES` 里每种语言都跑
   `keyDiff('zh', id)`。少一条就红，别用「缺了会回落」当借口 —— 回落是给运行期兜底的，
   不是给提交兜底的。
4. **不只词典**：这几处也有语言分支，加语言时一起看
   - `shared/search.js` 的 `PERIODS` / `KEY_MODES`：三套标签 `label` / `labelEn` / `labelJa`，
     统一走 `pickLabel(hit, locale)`。**缺日语时退到英文、再退到 id，不退中文** ——
     日文界面里冒出「巴洛克」比冒出 `Baroque` 更糟。
   - `shared/meter.js` 的 `meterSystemForLocale()`：日语按英米体系（4/4 = 単純拍子），
     已由「非 zh 即 us」覆盖，不用特判。
   - `shared/movement.js` 的乐章前缀：日语 `第3楽章`（阿拉伯数字），中文 `第三乐章`。
   - `renderer/src/numeralStyle.ts`：日语乐典通写「第1転回」，**首次**进日语界面默认阿拉伯；
     用户选过就以存的为准。
   - `shared/titleTemplate.js` 的变量图例：每条三套（`zh` / `en` / `ja`）。
5. **字体**：`tokens.css` 里 `:root[lang^="ja"]` 把 Yu Gothic UI / Hiragino 提到最前。
   中日共用汉字字形不同（「直」「骨」「次」），拿微软雅黑渲染日文会得到「中文字形的日文」。
   只在 `lang="ja"` 生效，中文界面一个字都不变。
6. **冒烟**：选项面板里真的点一遍 `English` → `日本語` → `简体中文`，断言菜单首项、
   设置标题、说明首句、`<html lang>`。只测 `t()` 不测点击，会漏掉「语言按钮没接上」。
7. **日语别照抄中文**：短术语（「作曲」「楽器」）同形很正常，但长句必须重写。
   `tests/i18n.test.mjs` 有一条兜底：长度 ≥6 的条目里 80% 以上必须与中文不同，且全文必须有假名。

## 36. 窗口与面板几何：config.json 自动记忆（v0.92）

用户 2026-11-22 的要求：**窗口拉成多大、每个面板拖成多宽，下次启动要一模一样**，
而且必须写在**外挂 config.json** 里（不是 localStorage、不是仓库里的 data/）。

### 两份文件的分工（别混）

| 文件 | 是什么 | 谁写 |
|---|---|---|
| `userData/config.json` 的 `layout` | **上次关软件时的样子**，启动时先按它摆 | 程序自动（拖动松手 / 关窗前） |
| `userData/workspaces.json` | 用户**手动存的多套布局**（编辑用 / 混音用…），点菜单才套用 | 用户点「保存当前布局为…」 |

共存规则：启动时 `config.layout` 优先，其次 `workspaces.last`，最后按屏幕比例算默认值。
用户应用工作区会改窗口几何 → 那些几何随后也会被记进 `config.layout`，
语义就是「最后一次长什么样，下次就从什么样开始」。**不要**为了「工作区专用」去禁止自动记忆。

### 结构

```json
"layout": {
  "main":    { "bounds": { "x": 0, "y": 0, "width": 1600, "height": 1000 }, "maximized": false },
  "panels":  { "leftW": 226, "rightW": 344, "panelH": 320,
               "leftCollapsed": false, "rightCollapsed": false, "panelOpen": true },
  "grid":    { "bounds": {...}, "maximized": true, "sideW": 190, "sideOpen": true },
  "lyrics":  { "bounds": {...} },
  "help":    { "bounds": {...} },
  "history": { "bounds": {...} },
  "overlay": { "bounds": {...} }
}
```

- **只记几何，不记「开没开窗」** —— 那个是 `startup.lyrics` / `startup.help` 的事。
- 归一与深合并是 `src/shared/layout.js` 里的纯函数（`normalizeLayout` / `mergeLayout`），
  主进程读、写、合补丁都走它。坏字段当没记，0 宽 / 0 高的矩形直接丢。
- 数值**不在归一时夹取**（栏宽上限跟窗口大小有关），留给用它的那一侧。

### 落盘时机

- 主进程：`rememberWindow()` 挂在每个窗口的 `resize` / `move` / `maximize` / `unmaximize` / `close`，
  防抖 **400ms**；关窗时同步冲一次（正常退出时防抖可能还没到点）。
- **最大化要记 `getNormalBounds()` + `maximized: true`** —— 记 `getBounds()` 会把铺满屏幕的尺寸
  当成「还原后的大小」，下次点还原等于没还原。
- 渲染层：面板拖宽结束 / 折叠切换 / 面板开合 → `api.config.setLayout({panels})`，防抖 **300ms**。
  第一次升级上来 config 里没有这几个数时，把 localStorage 的旧值写进去（seed），之后以 config 为准。
- 独立时间线窗口的泳道侧栏（`sideW` / `sideOpen`）由**那个窗口自己**上报；
  主进程顺手缓存一份 `lastGridSide`，否则「保存工作区」时抓不到另一个渲染进程的状态。

### 恢复时的几个坑

- 所有旧坐标都过 `clampRect()`：换显示器 / 改分辨率后，记下来的点可能落在不存在的屏幕上。
- **帮助窗口只恢复位置不恢复尺寸**：它的高度是内容算出来的（`fitHelpWindow`），
  硬套旧高度会把刚变多的手势裁掉。
- 独立时间线窗口的默认行为是「一开就最大化」；只有记过尺寸（`layout.grid.bounds`）才按记的来，
  否则用户把它拉成半屏并排看，下次又被撑满。
- 桌面歌词的位置从旧的 `overlay-bounds.json` **只读不写**：升级上来第一次还能用旧位置，
  之后统一归 `layout.overlay` —— 两处都写就成了两份真相。

### workspaces 补全（同一天做）

旧版 `workspaces.json` 漏了几项，存了也恢复不回来：

- `ui.leftCollapsed` / `ui.rightCollapsed`（左右栏整体收起 —— 只记宽度的话，恢复时会把收起的栏又展开）
- `grid.sideW` / `grid.sideOpen`（泳道侧栏），恢复时由主进程发 `grid:side` 给那个窗口
- `history` / `overlay` 两个子窗口的开关与位置
- `help.alwaysOnTop`

老文件读进来时缺的字段取默认值（栏都展开、侧栏 190px、历史/桌面歌词当成没开），不要因为
多了一个字段就让旧工作区整体失效。

### 选项面板 Esc（v0.92）

- Esc 关选项面板；**模板编辑器里有未保存文本时先弹确认框**（其它设置都是即时保存的）。
- 脏标记只由输入事件置真（`@input` / `@change` / `TemplateEditor` 的 update），
  不要在 watch 里推断：`editTplPreset()` / `resetTplForm()` 是程序化赋值，
  watch 会在它们之后又把标记置回真。
- `onGlobalKey` 里那条 Esc 要加 `!confirmBox.value`：确认框开着时 Esc 归它自己
  （它自己 `stopPropagation`，但焦点不在框上时事件仍会到 window，会再弹一次确认框）。

## 37. 繁體中文：一份源码 + 一份生成物（v0.93）

用户要「一个台湾的、一个香港的」。看起来是两份词典，实际港台在这套界面文案里
**重合度极高**（檔案 / 預設 / 設定 / 搜尋 / 資料 / 資訊 两边一样），真正的差异只有
軟體/軟件、檔名/文件名、裡/裏 这几处。

### 结论：台湾那份是源码，香港那份是产物

| 文件 | 谁维护 | 说明 |
|---|---|---|
| `src/shared/i18n.zh-TW.js` | **人** | 1078 条完整词典。要改繁中文案改这里 |
| `src/shared/i18n.zh-HK.patch.js` | **人** | 只列与台湾**不同**的条目（完整值，不是 diff 片段） |
| `src/shared/i18n.zh-HK.js` | **脚本** | 由 `tools/i18n-hant.mjs` 合成，**不要手改** |

运行时两份都是**完整对象**，`DICT` 里直接查得到，**不走缺键回落** ——
用户最初担心的「客户端 fallback 兼容性 Bug」就是这么消掉的：
香港界面永远不会在某一刻冒出一句台湾词，也不会因为漏一条而显示空白。

### 字形与用词是两层，别混

1. **用词**（翻译）：文件→檔案、设置→設定、播放列表→播放清單、软件→軟體。在词典里。
2. **字形**（正体化）：删→刪、编→編、为→為。这是 `src/shared/hant.js` 的 `HANT_CHARS`。

`tools/i18n-hant.mjs` 生成台湾词典时两层都用（先词后字）。运行期只有第二层有用：
**非词典来源**的短语（时期 / 调式标签、标题模板图例、乐章前缀 `第3乐章`→`第3樂章`）
走 `toHant()` 逐字转繁 —— 它们来自 shared 模块的常量表，进不了 i18n 词典。

### 几个必须记住的坑

- **`normalizeLocale` 里繁体必须排在笼统的 `zh-` 之前**。原来那行是
  `if (s.startsWith('zh-')) return 'zh'`，`zh-TW` 会被它吃掉、落到简体上 ——
  系统是繁体的人第一次打开就被判成简中。顺序：具体地区 → `zh-Hant-*` → `zh-*`。
- **`zh-Hant-HK` 要先于 `zh-Hant`**，否则「繁体+香港」会掉到台湾。
- **字体**：`:root[lang^="zh-Hant"]` 把微軟正黑體 / PingFang TC 提到最前。
  微软雅黑只有简体字形，「為」「直」「骨」都会写成简体那套，一眼能看出来。
- **生成物会过期**：改了台湾词典或差异表却忘了跑脚本，界面用的是旧香港版。
  `tests/i18n.test.mjs` 有一条专门盯这个：按「台湾 + 差异表」重算一遍，
  与 `i18n.zh-HK.js` 逐条比对，不一致就红，并提示去跑 `tools/i18n-hant.mjs`。
- **改完台湾词典别手改香港文件**：下次生成会盖掉。要港式说法就进差异表。

### 加繁体的完整清单（照做）

1. `tools/i18n-hant.mjs --init-tw` 生成台湾词典（**只初始化一次**，之后手改）。
2. 写 `i18n.zh-HK.patch.js`（只写有差异的条目），跑 `node tools/i18n-hant.mjs`。
3. `i18n.js`：`LOCALES` 加两条（`label` 用该语言自己的写法）、`DICT` 加两个键、
   `normalizeLocale` 加分派（注意上面那条顺序坑）。
4. `tokens.css`：加 `:root[lang^="zh-Hant"]` 字体栈。
5. 冒烟：语言按钮点一遍两份繁体，断言菜单首项 `檔案(F)` 与 `<html lang>`。

## 38. 下方面板：分栏而不是浮层；细滚动条自绘（v0.93）

### 下方面板不再覆盖列表

`.dock` 从 `position: absolute; bottom: 0` 改成 `.main` 里的 flex 子项。
动机不是审美：浮层把列表的**纵向滚动条下半截**盖住了，鼠标点不到、拖不动。
改成上下分栏后 `.table-pane` 自动让出高度，滚动条只到分界线为止。

两个连带改动，别忘：
- `--dock-inset` / `.tbody { padding-bottom: ... }` 一起删掉 —— 那是给浮层垫底用的，
  分栏之后反而会留一截空白。
- `maxPanelH()` 改成**量主区**（`main.clientHeight - 搜索行 - splitter - 140`）。
  以前按「窗口高减一串常数」估，浮层压不着列表所以估错也看不出来；
  分栏之后估大了会把表格挤没。

### 细滚动条：为什么自研

用户要「常态细、鼠标靠近变宽到 3 倍、200ms 平滑」。
Chromium **不给滚动条伪元素做 transition**：`::-webkit-scrollbar-thumb { border-width }`
一改就是硬跳，`::-webkit-scrollbar:hover` 的选择器支持也不完整。所以：

- 原生条**留 10px 槽位、藏视觉**（`background: transparent`）：布局一点不挪，原生拖拽还能用。
- 真正的条画在 `#slim-layer`（`position: fixed`，`pointer-events: none`，子元素 `auto`）：
  热区 20px，视觉 4px，`:hover` 时 `width: 20px`（5 倍），`transition: width 200ms`。
  12px（3 倍）试过，用户反馈「还是差一点」—— 4px 的细条在 12px 里也是窄缝。
- 懒挂载：`pointerover` 时向上找最近的可滚动容器再挂，不遍历整棵树。
  弹窗、词表编辑器这些按需渲染的容器自动覆盖，不用维护选择器清单。
- **400ms tick**：容器**位移**（拖面板、收侧栏）不会触发 `ResizeObserver`，而条是
  fixed 按视口坐标定位的，不重算就会停在原地。tick 里顺便清理已脱离文档的实例。
- 几何计算抽在 `src/shared/scrollbar.js`（`thumbMetrics` / `thumbOffset` /
  `scrollForThumbDelta`），单测盯两件最容易错的事：
  **滚到底时滑块底边是否贴住轨道底边**、**拖满滑块距离是否刚好滚满内容**。
  这两个量不是 1:1，直接拿像素当偏移会在底部差出几十像素。
- 拖动时给滑块加 `.on`（与 `:hover` 同一档宽度）：鼠标拖快了会滑出 12px，
  不能让它拖到一半缩回 4px。

## 39. 播放头步长、扫过发声、模板字体（v0.95）

用户 2026-11-23 的四件小事，正好凑成一组「对轨手感」：

| 键 | 行为 |
|---|---|
| `Ctrl+Alt+←/→` | 播放头走**粗步长**，默认 3 秒（选项 → 播放，0.1–60 秒） |
| `Ctrl+Alt+Shift+←/→` | 播放头走**细步长** = 一帧 |

### 快捷键的插入位置是个坑

`Ctrl+Alt+←/→` **同时满足** `ev.altKey`，而网格里原来 `Alt+←/→` 是「改选区范围」。
新分支必须写在那一支**之前**，否则按下去改的是选区、播放头一动不动，
而且界面上看不出是谁吃掉了这个键（没有报错、没有提示）。

### 帧率只有一个来源

细步长的帧率**不新存一份**，直接读播放条那颗 `30 fps`（`localStorage['ma-fps']`，
24/25/30/50/60）。存两份必然会出现「播放条改了、步长还是老帧率」。

选项里给四选一，默认「自动折半」：

| 口径 | 60fps | 50fps | 30fps | 24fps |
|---|---|---|---|---|
| 跟随播放条 | 16.7ms | 20ms | 33.3ms | 41.7ms |
| 自动折半（默认） | 33.3ms | 40ms | 33.3ms | 41.7ms |
| 固定 30 | 33.3ms | 33.3ms | 33.3ms | 33.3ms |
| 固定 25 | 40ms | 40ms | 40ms | 40ms |

「自动折半」的规则是「除以 2 直到 ≤30」：60→30、50→25，24/25/30 原样。
存在这个折算是因为**高帧率下一帧太短、对不了轨**，而人手动对齐用的基准档就是 30/25。

### 扫过发声（scrub audio）

播放头跳转时放一小段，模仿 Premiere 拖播放头的声音。实现分两半：

- `audio/store.js` 的 `scrubPulse(dur)` 用**独立的 Audio 元素**播同一份 src：
  `currentTime = 当前毫秒` → `play()` → 定时 `pause()`。
  调用点（`seekAtX` / `seekToTick` / 快捷键）自己先 seek 主元素，再决定要不要响。
- 连续触发时用 `scrubTimer` 覆盖：只有最后一次到点会 pause，
  否则前后两个定时器会把后一声掐掉。

**为什么必须是第二个元素**（踩了两轮才定）：借主 `<audio>` 播 42ms 的写法看着更省事，
但 `el.play()` 会触发 store 的 play 监听，把 `state.playing` 置 true 并启动 rAF ——
于是「听一耳朵」变成「真的开始播」，播放头自己往前跑；42ms 后的 pause 又把它按回去。
更隐蔽的问题在交互上：用户点完位置**紧接着**按播放，那一下正好落在借用窗口里，
被 `if (scrubbing) return` 当成 scrub 吞掉，表现是「按播放没反应」。
第二个元素把主元素的位置、播放状态完全隔离，这些纠缠一次性消失。

三条硬限制（**别想着绕过**）：

1. 只有**音频宿主**（主窗口）发声。独立时间线窗口里扫，声音得由主窗口播，
   跨进程几十毫秒延迟会「慢半拍」，不如不做。
2. `sourceMode === 'timeline'`（仅时间线，用于对齐外部播放/录屏）**没有音频源**，
   静默跳过、不报错。
3. 正在播放时不打断。

时长有两个输入：毫秒数（主）+「帧率 × 帧数」（换算项），优先级可选。
默认 42ms（= 24fps 的一帧，显示取整）。被选中的那个为 0 时退回另一个 ——
否则「毫秒留空」就直接静音，用户会以为功能坏了。

触发范围默认「任何方式移动播放头」，可收窄成「只用 Ctrl+Alt 快捷键」。
顶栏 `◉ 扫过发声` 是快捷开关，完整设置（时长 / 范围 / 优先级）在选项 → 播放。

## 40. 模板字体统一、候选只有一份、模态叠层（v0.96）

用户 2026-11-23 的第二轮返工：字体要「两块统一」、补全要修、关闭按钮要能关。
三条其实是同一类问题 —— **同一个东西在两个地方各写了一套**。

### 候选列表只有一份

行内改名的候选 `ul.mov-sug` 原来写在乐章行的 `<template v-if>` 里，
所以只有乐章能补全；曲目行（最常用）敲 `for_Classical_Opus` 什么都不弹。
现在全表只有一份，放在 `.wrap` 末尾、Teleport 到 body，曲目行与乐章行共用。
判断「补全在不在」别只查 DOM 有没有那个 `ul`，要按**正在编辑的行**去敲字再查。

### 模板字体（一块设置，所有模板文本生效）

默认是**非等宽**（`--font-text` 那套无衬线），选项 → 外观可换成等宽。
变量只有一份：`--tpl-font`。**所有模板文本都读它**，不要哪一处另写 `font-family`：

| 位置 | 选择器 |
| --- | --- |
| 模板编辑器（镜像层 + textarea） | `.tpl-ed .tpl-mirror` / `.tpl-input` |
| 标题模板预设列表（名字 + 一行模板 + 变量图例） | `.tpl-preset-name` / `.tpl-line` / `.tpl-var b` |
| 预设名输入框 | `.tpl-name` |
| 候选预览（列表 / 详情） | `.ms-preset` / `.ms-tpl`（LibraryView）、`.title-sug`（App） |

**和「界面字体」是两个开关，不许互相影响**（用户 2026-11-23 明确要求）。
所以模板的「非等宽」指向 `--font-text`，而不是 `--font-ui`：后者将来随界面字体一起变，
模板文本就会被顺手改掉。`--font-text` 只看界面语言（ja / zh-Hant 换字形），
和 `[data-font]` 那个等宽开关无关。旧存档里 `ma-tpl-font = 'ui'` 一律按 `sans` 读。

### 模态叠模态：层级写在 `.modal-mask.above`

两个 `.modal-mask` 都是 `z-index: 50`，后进 DOM 的那个赢。选项面板排在确认框之后，
于是「放弃未保存的模板？」被面板整块盖住 —— **看不见、点不到，用户只看到关闭按钮没反应**
（2026-11-23 实际踩到）。要叠在另一个模态之上的弹层挂 `.modal-mask.above`（75）：
高于音频元数据框（60）与元数据应用框（70），低于右键菜单（80）。
冒烟用 `document.elementFromPoint` 断言「弹窗顶端命中的是它自己」，光看 DOM 还在不算数。

### 顺手查出来的两个（同一片代码）

- **复制用户预设会覆盖原件**：`copyTplPreset` 复用 `editTplPreset`，后者对用户预设把
  `tplPresetEditingId` 指回原条目 —— 「复制 → 改名 → 保存」实际改的是原件。
  现在复制一律 `editingId = null`，名字自动取 `_copy` / `_custom`（重名再加序号）。
- **「放弃未保存的模板」没清空编辑器**：确认放弃后只复位了脏标记，文字还留在编辑器里；
  下次打开面板看到它，再关一次却不再问。现在确认放弃就 `resetTplForm()`，看到的 = 存下的。

## 41. 模板变量补全（v0.98）

用户 2026-11-23 的要求：**打 `c`、`%c`、`Cp` 都能想到 `%Composer}`**，而且三处输入框
（选项里的模板编辑器 / 列表行内改名 / 详情标题）表现要一致；方式是「照常打字，
↑↓ 选、Enter 或 Tab 采纳」，不抢输入。

### 一份实现，三处接线

匹配逻辑全在 `src/shared/templateSuggest.js`（纯函数，8 条单测）：

| 函数 | 干什么 |
| --- | --- |
| `caretToken(text, caret)` | 光标处「正在输入的词」：`%` 之后未闭合的一段；没有 `%` 就是末尾那串字母 / 汉字 |
| `suggestVariables(text, caret, limit)` | 打分排序：完全相等 0 → 前缀 1 → 词首缩写 2（`notf`）→ 子序列 3（`Cp`） |
| `applyVariable(text, item)` | 把 `[start, end)` 换成 `%Composer}`，返回新文本与新光标 |

接线：`TemplateEditor.vue` 自己算（textarea 走 `selectionStart`）；
`LibraryView` 与 `App.vue` 把变量**混进已有的候选列表**，顺序固定为
**预设 → 乐章术语 → 变量** —— 变量在标题里是「偶尔插一个」，不该把术语候选顶下去。

### 别踩的几个点

- **`50%` 不是变量开头**：紧贴在字母 / 数字 / 汉字后的 `%` 一律当百分号，
  否则标题里写「前奏 50% 处」会立刻弹出全部 8 个变量。
- **没选中候选项时 Enter 不能被吃**：模板编辑器里 Enter 是换行、列表/详情里 Enter 是提交，
  只有 `active >= 0`（真的按过 ↓）才拦。`active = -1` 是「只展示」。
- **冒烟里 set value 之后必须 `setSelectionRange`**：程序化赋值后 caret 在 0，
  `caretToken` 什么都拿不到，会误判成「补全坏了」。这是本次唯一一次调试成本。
- 候选列表仍走 Teleport + fixed（RULES 第 19 条），模板编辑器那份用了独立类名 `.tpl-sug`
  （z-index 78，压在选项面板 50 之上）。

## 42. 光标对齐、乐章尾段补全、术语回写（v0.99）

### 镜像层的字必须**逐项**等于 textarea

模板编辑器里「看到的字」是 `<pre>` 画的、「光标」是 `<textarea>` 画的，两者只有 CSS 度量
完全一致时才对得上。2026-11-23 的错位就是变量那段写了 `font-weight: 500`：
等宽字体下 500 和 400 同宽，换成无衬线之后 500 更宽，变量之后的字整体右移，
光标却停在 textarea 的位置 —— 看起来像「点哪儿都不对」。

规则：**变量只改颜色**，字重 / 字距 / 字体 / 行高 / `tab-size` 两边显式写同一组值；
textarea 的原生滚动条要隐藏（`scrollbar-width: none` + `::-webkit-scrollbar`），
否则条槽吃掉约 10px，两边的换行点就不在一处。冒烟用 computed style 逐项比对兜底。

### 乐章补全：整段匹配不上，就退回「光标前那一小段」

`movementFragment` 会给「前缀之后、最后一个 ` - ` 之后」的整段。用户在已有内容后面直接
接着打（`第二乐章 柔板` + `Al`，没有 ` - `）时，整段是 `柔板Al`，一条术语都对不上，
界面表现为「加了字反而不弹候选」。

所以：先按整段匹配（多词术语 `Allegro moderato` 需要它），一条都没有再用
`movementMatchToken`（去掉未闭合的 `%变量}`、取最后一串汉字 / 拉丁字母）重试一次。
采纳时只替换光标前那一段；紧贴在汉字后面时补 ` - `，别把两段术语粘成一个词。

### 标题里写下的真术语要回写字段

`第二乐章 小步舞曲 - 小快板` 打的是**显示文本**，但详情页的 Sub-Type / 速度术语是数据。
`termsFromMovementTitle` 在改名落库后按词表认这两段，写回 `subType` / `tempoTerm`；
带 `%` 的段（还是变量）跳过。`renameTrack` 只返回 `{ id, title }`，判断「是不是乐章」
要重新 `tracks.get` 一次 —— 这里踩过一次（字段一直是 null）。
