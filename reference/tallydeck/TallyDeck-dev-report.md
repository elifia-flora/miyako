# TallyDeck 开发疑难报告（dev-report）

> 项目：TallyDeck — Electron 本地音乐播放器（时间码 / 波形 / 标记）
> 周期：2026-10-18　版本：0.1.0
> 范围：记录本次开发中**除启动脚本引号问题之外**的疑难事项。启动脚本那一类问题已单独提炼为 skill `win-electron-gotchas`，此处只留指引。

---

## 0. 摘要

本次一共踩到 11 个非平凡问题，按性质分四类：

| 类别 | 数量 | 共同特征 |
|---|---|---|
| 环境/运行时 | 3 | 报错信息指向错误的位置，真实原因在环境或版本变更 |
| 数据正确性 | 2 | 不报错，只是悄悄给出错误的数值 |
| UI/渲染 | 4 | 视觉结果看着"像 bug"，实际是叠加层或样式优先级 |
| 验证方法 | 2 | 用错验证手段导致自我误导（最危险） |

单一结论：**Electron 里最贵的 bug 不是崩溃，而是"安静地算错"**——崩溃有堆栈，算错只有一张看着挺正常的截图。

---

## 1. 环境与运行时

### 1.1 `ELECTRON_RUN_AS_NODE=1` 让 Electron 退化成纯 Node

**现象**：`electron .` 直接抛 `Cannot read properties of undefined (reading 'whenReady')`，堆栈落在 `main.js` 第一行 `app.whenReady()`。

**根因**：宿主 shell / IDE 环境里已注入 `ELECTRON_RUN_AS_NODE=1`。该变量会让 `electron.exe` 以纯 Node 模式启动，不加载 Chromium，于是 `require('electron')` 返回的是路径字符串而不是 API 对象，`app` 为 `undefined`。堆栈指向的是受害者，不是凶手。

**解法**：启动前清空变量。

```bat
set "ELECTRON_RUN_AS_NODE="
```

终端里跑则 `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .`（bash）或 `set ELECTRON_RUN_AS_NODE=`（cmd）。

**复用要点**：Electron 报"某个内置对象是 undefined"且代码明明没错时，先查环境变量，再怀疑代码。

### 1.2 Electron 32 移除 `File.path`

**现象**：拖拽音频进窗口，路径取不到，`file.path` 为 `undefined`。

**根因**：Electron 32 起为安全模型移除了 `File.path`（配合 `contextIsolation` 默认开启后的路径泄漏治理）。

**解法**：在 **preload** 层用 `webUtils.getPathForFile(file)`，通过 contextBridge 暴露：

```js
// preload.js
let webUtils = null;
try { webUtils = require('electron').webUtils; } catch {}
// ...
pathForFile: (file) => (webUtils ? webUtils.getPathForFile(file) : ''),
```

**复用要点**：渲染层拿不到的真实路径，一律在 preload 里用 `webUtils` 换，主进程再做存在性校验。

### 1.3 CSP 把本地音频拦了

**现象**：`<audio src="file:///D:/x.wav">` 无声，DevTools 报 CSP 违规。

**根因**：`default-src 'self'` 会接管 `media-src`，而 `file:` 与 `self`（`file://` 页面）不同源。

**解法**：

```
media-src 'self' file: blob:;
img-src 'self' data:;
```

**复用要点**：本地媒体播放必须显式放行 `media-src file: blob:`；同时给 `object-src 'none'`、`base-uri 'none'` 收紧边界。

---

## 2. 数据正确性（最隐蔽的一类）

### 2.1 "采样率"读数永远显示 48000

**现象**：显示 48.0 kHz，但文件本身是 44.1 kHz。不报错，读数看起来完全合理。

**根因**：`AudioContext.decodeAudioData()` 会把音频**重采样到上下文自身的采样率**（通常是 48000），于是 `decoded.sampleRate` 恒等于上下文的采样率，反映不了文件真实采样率。

**解法**：两步。

1. 自己探容器头拿到原生采样率（`WaveEngine.probeSampleRate`）：
   - WAV：找 `RIFF/WAVE`，`fmt ` 块偏移 24 处 uint32 LE；
   - AIFF：找 `COMM` 块；
   - FLAC：解析 STREAMINFO（20 bit 采样率）。
2. 用同采样率的离线上下文解码，避免重采样：

```js
const octx = new OfflineAudioContext(1, 1, clamp(nativeRate, 8000, 192000));
decoded = await octx.decodeAudioData(buffer);
```

解码失败再回落到常规 `AudioContext`（容错路径）。

**复用要点**：凡是"读出来的数值和文件对不上"的元数据，先怀疑浏览器做了隐式转换，而不是怀疑解析代码。

### 2.2 丢帧时间码的语义

**现象**：60 秒整显示 `00:01:00;02`，10 分钟整显示 `00:10:00;00`。第一反应是"算错了"。

**根因 / 事实**：

- **NDF（非丢帧）**按真实帧计数。29.97 下单帧时长 33.367 ms，不是 33.333 ms，所以时间码会相对钟表**缓慢漂移**——这是 NDF 的真实行为，专业剪辑师认这个，不是 bug。
- **DF（丢帧）**不丢真实画面帧，只丢**帧号**：每到整分钟跳过 `;00` `;01` 两个编号（每 10 分钟不跳），使时间码与钟表对齐。所以 60 秒整必须落在 `;02`。

**解法**：把"整分钟的第一秒"均分成 `round(fps) - round(fps * 0.066666)` 个槽位，标签自然落在 `;02 … ;29`，不会溢出。落成纯函数后写了 30 项断言（含 1 分钟、10 分钟、23.976、59.94 等边界）。

**复用要点**：涉及行业标准（时间码、SMPTE、MIDI tick）时，先确认"看起来错"的行为是不是标准本身的规定；写断言前先查标准，否则会把正确实现改坏。

---

## 3. UI 与渲染

### 3.1 `[hidden]` 被 `display:flex` 覆盖

**现象**：自定义帧率的输入框在"没选自定义"时仍然显示。

**根因**：`[hidden]` 只是 UA 样式表里的 `display: none`，特异性极低。同一份 CSS 里后写的 `.field { display: flex }` 直接把它盖掉。

**解法**：全局兜底。

```css
[hidden] { display: none !important; }
```

**复用要点**：只要项目里有 `display` 的自定义规则，就必须有这条兜底，否则 `hidden` 属性形同虚设。

### 3.2 波形"变成一整块实心"的假警报

**现象**：某个 1 kHz 校准音的波形渲染出来是整块实心矩形，怀疑峰值算法把 min/max 算错。

**排查过程**：没有直接改代码，而是把包络计算抽成独立方法，打印前 20 个采样列的上/下包络坐标。数据是 `absMax 0.451`、`0.32s` 处上包络 `y=94.6`（画布半高 96），与按振幅比例手算的结果完全吻合——**算法是对的**。真正原因是：我在缩略视图里把每 110px 一个的提示音看成了连续波形。

**同时发现的真实问题**：之前为了"压暗顶部让标记更清楚"，在波形容器上叠了一层高度 20px 的半透明渐变（`.wave-body::after`）。它会**吃掉峰值尖端**，让波形看起来被削平——这才是"看起来不对"的视觉来源。已移除（标记旗帜本身有不透明底色，不需要遮罩）。

**复用要点**：

1. "看着不对"≠"算错了"。先把关键计算抽成可打印的方法，比改代码便宜一个数量级。
2. 不要为了视觉美化在数据可视化上叠加半透明遮罩——它会篡改数据的视觉呈现。

### 3.3 指针捕获的两个坑

**现象**：拖动播放头/标记，指针移出元素后拖动中断；偶尔在 `pointerup` 抛异常。

**根因与解法**：

- `setPointerCapture` / `releasePointerCapture` 必须作用在**同一个**元素上，且该元素在捕获期间不能被销毁；
- 释放要用 try/catch 兜底（元素可能已因重渲染被移除）；
- 标记旗帜的拖动把捕获放在容器 `body` 上，而监听挂在旗帜上，两者要一致，否则移动事件收不到。

**复用要点**：Pointer Events 的捕获是"元素级"的，写拖拽时先明确"捕获对象＝监听对象"。

### 3.4 波形性能的分层策略

**做法**（从踩坑中定下来的架构）：多级 min/max 峰值金字塔（bucket 从 16 起逐级倍增）× 已播/未播两张离屏位图 × 每帧仅 2 次 `drawImage` + 1 次 `clip`；播放头与标记用 DOM `transform` 移动，**不进 canvas 重绘**。

**收益**：缩放时只选层聚合（常数级），播放时零重绘，60fps 稳定。

**复用要点**：长音频可视化一律"预聚合 + 离屏缓存 + 高频元素走 DOM"，不要每帧重画整条波形。

---

## 4. 验证方法（本次最值得记录的部分）

### 4.1 截图只能证明"没崩"

本次所有误判都发生在"看截图下结论"时（见 3.2）。截图能证明布局没塌、颜色没跑，**证明不了任何数值正确性**。

### 4.2 建立三层验证

| 层 | 手段 | 覆盖什么 |
|---|---|---|
| 纯算法 | `node test-media/format.test.js`（30 项断言，不依赖 Electron） | 时间码 / 丢帧 / 节拍 / 采样 / 英尺格 |
| 集成 | `electron . --smoke` + `capturePage()` + `executeJavaScript` 断言 | 播放推进、逐帧、持久化、切歌 |
| 人工 | 截图 9 张 | 视觉 / 排版 |

集成层实测数据（均来自 `--smoke` 的真实输出）：

- 播放 1.3 s，`currentTime` 推进 **1.246 s**（含解码起播延迟，合理）；
- 逐帧步进 1 帧实测 **0.0417 s** = 1/24 s，精确；
- 点击波形 26.4 s 处，落点 **26.404 s**；
- 滚轮缩放到 6×，视图从 48 s → **40.68 s**；
- 重载后 3 个标记的名称、时间码、类型完整恢复；
- 切歌后时长与标记数正确换轨，无串台。

### 4.3 给应用留调试钩子

渲染层挂 `window.__td = { state, wave, load, seek, addMarkerAt, ... }`，主进程用 `executeJavaScript` 直接驱动状态并取回结构化的 JSON。这是让"冒烟测试能断言"的前提。

**复用要点**：先设计可观测性，再写测试。没有钩子的应用，自动化验收只能退化成截图比对。

---

## 5. 工程约定（用户明确要求的部分）

- **不删用户文件**：整个开发过程没有删除任何测试素材，只做归档。
- **测试产物集中**：全部落在 `test-media/`（`audio/` 音频、`shots/` 截图、生成脚本与单测脚本），不散落在项目根目录。
- **可复现**：`make_test_audio.py`（纯标准库，无第三方依赖）能重新生成三个测试音频；`format.test.js` 能独立复跑。
- **不污染音频目录**：应用只写 `%APPDATA%/tallydeck/store.json`，不往音频所在目录写任何文件。

---

## 6. 技术栈说明

- 运行时/壳：**Electron 32**（自带 Chromium + Node）。
- 业务代码：**零框架**。原生 HTML + CSS + JavaScript（ES2020），无 React/Vue/Svelte，无 TypeScript。
- 构建：**无打包器**（无 Vite / webpack / esbuild），`src/` 直接跑，改完刷新即可。
- 依赖：`package.json` 只有一个 `devDependencies.electron`，**零运行时依赖**。`node_modules` 里 63 个顶层目录全部是 electron 自身安装链（`@electron/get`、`got`、`extract-zip` 等）的传递依赖，不参与应用运行。
- 可视化：Canvas 2D 手写波形（未用 Chart.js / D3）。
- 测试：手写断言（未用 Jest / Playwright）；测试音频由 Python 标准库生成（未用 numpy / pydub）。

---

## 7. 复现清单

```bash
# 时间格式单测（30 项）
node test-media/format.test.js

# 全流程冒烟（截图落 test-media/shots/）
cd music-player
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron.cmd . --smoke

# 正常启动
start.cmd        # 或在终端里 npm start（记得清 ELECTRON_RUN_AS_NODE）
```

---

## 8. 如果重做，会改的三件事

1. **先写断言再写 UI**：时间码与峰值算法属于"错一点点看不出来"的类型，应该先有纯函数与断言。
2. **可观测性前置**：`window.__td` 是后期补的，如果一开始就有，3.2 那次误判不会发生。
3. **不要在数据可视化上加装饰性遮罩**：任何覆盖在数据上的半透明层都在篡改读数，宁可改标记样式。

---

*启动脚本类问题（反斜杠+引号、cmd 代码页）见 skill：`win-electron-gotchas`。*
