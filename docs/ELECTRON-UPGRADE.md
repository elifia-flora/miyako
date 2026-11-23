# Electron 升级记录：32.3.3 → 44.9.3 → 44.10.1（2026-10-26 / 11-01）

> 这份文档只记「为什么是 44 不是 45」「改了什么」「环境上踩到的坑」。
> 操作细节见 `HANDOFF.md`，代码坑见 `docs/RULES.md` 第 19 节。

## 1. 版本选择：为什么不是 45

查到的硬事实（2026-10-26）：

| 版本 | 发布日 | Chromium | Node.js | 说明 |
|---|---|---|---|---|
| **44.9.3** | 2026-10-21 | 152.0.7977.167 | 24.22.0 | 44 分支最新；release notes 明确写了 backport ANGLE / Chromium / PDFium / Skia / V8 的上游修复 → **安全补丁版** |
| **44.10.1** | 2026-10-30 | 152.0.7977.169 | **24.22.1** | 44 分支最新；带 Node **24.22.1** 的安全修复 —— 正是当时等的「44.9.4 / 45.0.1」那一版（2026-11-01 升上来） |
| 45.0.0 | 2026-10-21 | 156.0.8078.48 | 24.22.0 | 最新稳定大版本；到 10-26 仍只有 `.0.0`，没有 45.0.1 |
| 43.8.3 | 2026-10-21 | 150.0.7871.250 | 24.22.0 | 43 分支最新；43 仍受支持，2027-01 EOL |

- Electron 的支持策略是**最近三个大版本**：45 / 44 / 43。42 随 45 发布 EOL。
- **45.0.0 不是「没有安全补丁」**：它自带 Chromium 156 的当时最新修复；但 45 分支确实**还没有发过补丁版**，
  而 44.9.3 是同日发布、带明确 backport 的安全补丁版。按「45 没补丁就用 44」的规则选 **44.9.3**。
- **两个版本都没有带上 2026-10-21 的 Node.js 安全修复**：Node 当天发的是 24.22.1（[安全公告](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)），
  而 44.9.3 / 45.0.0 都是 24.22.0。也就是说这批 Node CVE（Brotli RCE、TLS/DNS 校验等）在 44 和 45 上都还在。
  这不是选 44 造成的差异；**2026-11-01 已升到 44.10.1**（Node 24.22.1），Node 侧这批 CVE 随之修掉。

当前项目还没有联网功能（音频/封面只读本地，走自定义协议），上述 Node 网络栈问题的实际暴露面很低；
真正接后端前，**必须**再确认一次 Electron 的 Node 版本 ≥ 当时的安全补丁版。

### 什么时候升 45

- 45.0.1（或更高）发布，且 Node ≥ 24.22.1；
- 先读 [Electron 45 breaking changes](https://www.electronjs.org/docs/latest/breaking-changes)：
  - sandboxed preload 不再有 `Buffer` / `events` / `timers` / `url` / `setImmediate`；
    本项目的 preload 只用 `contextBridge` + `ipcRenderer`，理论上不受影响；
  - 屏幕捕获权限从 `media` 改成 `display-capture`（本项目没有屏幕捕获）；
  - `safeStorage` 同步方法在 46 移除（本项目没用）。
- 升级时仍然跑 `npm test` + `npm run smoke`，重点看 console 错误、自定义协议、窗口缩放。

参考：[Electron 44 发布说明](https://www.electronjs.org/blog/electron-44-0) ·
[Electron 45 发布说明](https://www.electronjs.org/blog/electron-45-0) ·
[44.9.3 release](https://releases.electronjs.org/release/v44.9.3) ·
[45.0.0 release](https://releases.electronjs.org/release/v45.0.0) ·
[版本支持时间线](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)

## 2. 改了什么

### 2.1 依赖

| 包 | 旧 | 新 | 原因 |
|---|---|---|---|
| `electron` | 32.3.3 | **44.9.3** | 安全更新 + 为联网功能做准备 |
| `better-sqlite3` | ^11.10.0 | **^13.0.3** | 13 要求 Node ≥ 22，Electron 44 是 Node 24；带 N-API 预编译，普通 node 也能读库 |
| `@electron/rebuild` | ^3.7.1 | **^4.2.1** | 支持新 Electron / Node 的 ABI |

`package-lock.json` 由 `npm install` 重新生成。`npm ls --depth=0` 无 invalid / extraneous。

### 2.2 `console-message` 的签名（静默失效类）

Electron 35 起 `webContents.on('console-message')` 回调变成**事件对象**：

```ts
// 旧：(_e, level: number, message) => level >= 2
// 新：e.level = 'error' | 'warning' | 'info' | 'debug'
```

旧写法 `level >= 2` 在新签名下永远 `false` —— 不报错，只是**再也不收集渲染层异常**。
主进程的「冒烟末尾零异常」守卫会因此变成永远为真，比没有守卫更危险。

`src/main/index.ts` 新增 `onConsoleMessage(wc, fn)`，两种签名都认，logs/boot.log 和冒烟守卫共用。

### 2.3 自定义协议的 CORS（Electron 44 硬要求）

渲染层是 `file://`，音频/封面走 `ma-audio://` / `ma-art://`，属于跨源。Electron 44 / Chromium 152 起：

- `protocol.registerSchemesAsPrivileged` 必须给这两个 scheme 加 `corsEnabled: true`；
- 响应必须带 `Access-Control-Allow-Origin`（`audio.ts` / `media.ts` 的 `CORS` 常量）；
- 暴露 `Content-Range` / `Content-Length` / `Accept-Ranges`，否则 JS 读这些头是 `null`；
- 统一处理 `OPTIONS`（204）。

不做的话：`fetch(ma-audio://…)` 直接
`Cross origin requests are only supported for protocol schemes: …`，
波形、时长、导出全挂，但播放 `<audio>` 可能看起来正常 —— 很容易误判成「只是波形坏了」。

### 2.4 Electron 二进制按需下载（42+）

Electron 42.0.0 的 npm 包**移除了 `postinstall`**（41.0.0 还有 `"postinstall": "node install.js"`）。
`npm install` 后 `node_modules/electron/dist/` 可能不存在，第一次真正启动时才下载（约 100MB）。

因此三个启动器统一走 `tools/electron-path.mjs`：

- `tools/launch.mjs`（`npm run app`）
- `tools/smoke.mjs`（`npm run smoke`）
- `start.py`（`ensure_electron()`，双击快捷方式时自动补下载）

别再把 `node_modules/electron/dist/electron.exe` 写死。

**国内直连 GitHub 会卡住**（2026-11-01 实测：7 分钟、`/tmp/edl.log` 一个字节都没有）。
换镜像，十几秒下完：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

装完用 `node_modules/electron/dist/electron.exe --version` 确认是目标版本再往下走。

### 2.5 顺手修的 TDZ

`App.vue` 里 `watch([... activeRecording.value ...])` 原先注册在 `const activeRecording`
声明**之前**。`watch` 注册时就会跑一次 getter 收集依赖，于是每次启动都报：

```
ReferenceError: Cannot access 'activeRecording' before initialization
```

这个错误发生在冒烟的 console-message 监听装好之前，所以冒烟一直是绿的 —— 但 logs/boot.log 里每次启动都有。
已把 watch 移到 `activeRecording` 声明之后，并在注释里写明原因。

## 3. 环境坑：Low Mandatory Level 会让 Electron 44 沙箱直接崩

### 症状

- 双击/`npm run app` 没窗口，进程秒退，退出码 `-2147483645`（`0x80000003`，STATUS_BREAKPOINT）；
- `logs/boot.log` 一条都没有（崩在 JS 之前）；
- `electron.exe --version` 也可能没输出；
- 加 `--no-sandbox` 就能启动。

### 原因

DSH 的 workspace-write 沙箱会给工作区打上 **Low Mandatory Level**（低完整性标签）。
Electron 32 能跑，Electron 44 / Chromium 152 的沙箱不接受这种目录，直接在浏览器进程初始化时 break。
把同一份 Electron 复制到普通临时目录（Medium），不加 `--no-sandbox` 就能正常启动；
再把临时目录改成 Low，立刻复现崩溃 —— 已做 A/B 验证。

### 修复（把应用目录恢复成 Medium）

**最快**：双击 `tools/fix-integrity.cmd`（或 `npm run fix:integrity`）。它会检查
根目录 / `node_modules/electron` / `electron.exe` / `out`，只对真正是 Low 的目标下手，
修完再读一遍确认。正常 Medium 时只检查、不写 ACL。

`launch.mjs` / `smoke.mjs` 在拿 Electron 路径前会调用同一个检查（`tools/electron-path.mjs`），
`start.cmd` 在启动前也跑一次 `--quiet` 版本 —— 所以「又跑了一轮 workspace-write」之后，
通常不需要你手动做任何事；受限令牌下修不动时才会明确报错，让你在 DSH 之外双击上面的 .cmd。

等价的原始命令：

```powershell
cd C:\Users\Administrator\WorkBuddy\dev\music-atlas
icacls . /setintegritylevel (OI)(CI)Medium
icacls .\node_modules\electron /setintegritylevel (OI)(CI)Medium
icacls .\out /setintegritylevel (OI)(CI)Medium /T
```

- 根目录设 `(OI)(CI)`，以后新生成的 `out/` / 数据文件会继承 Medium；
- `node_modules/electron` 设一次，`npm install` 重新解出的 `dist/` 也继承 Medium；
- `out/` 用 `/T` 处理**已经存在**的构建产物。

检查：

```powershell
icacls . | findstr Mandatory
# 期望：Medium Mandatory Level，而不是 Low
```

如果以后又跑过 `workspace-write` 的 DSH 会话，标签可能被重新打回 Low，应用会再次秒退 ——
双击 `tools/fix-integrity.cmd`（或让 `npm run app` 自动预检）即可。这是**环境/权限**问题，
不是应用代码 bug，别去改 `sandbox: false` 或加 `--no-sandbox` 来「绕过」：本项目以后要联网，
浏览器进程沙箱不能关。

## 4. 验证结果（2026-10-26）

- `npm test`：**188 通过**（在 DSH 的 workspace-write 下 `node --test` 会因 spawn EPERM 失败，
  用 `node --test --experimental-test-isolation=none tests/*.test.mjs` 或普通终端跑）。
- `npm run smoke`（干净数据）：**386 / 386 通过**，Electron 44.9.3 + Chromium 152 + Node 24.22.0，沙箱开启。
- 实机启动：窗口正常出现，logs/boot.log 无 `renderer console error`，`activeRecording` TDZ 已消失。
- 播放性能：主网格 canvas 已回到 GPU 后端（`--gpu-info` 5s 后显示 `gpu_compositing: enabled`）；
  1.3× 界面缩放下播放 5s 的 rAF 间隔 16.67ms（p95 16.8ms、0 次 >33ms），
  `currentTime` 每帧递增、0 次 stall；连续播放不占满主线程。
- 播放头：0.50× 网格缩放下不再取整 transform；逐帧位移约 0.30px（300 帧里 0 帧原地不动、
  0 次回退），跟随翻页与播放头同帧提交。
- 帧率：应用不写死 60，`requestAnimationFrame` 跟显示器刷新率；本机当前 59Hz，
  显示器切到 75Hz 模式后自动约 13.3ms/帧，90/120/144Hz 同理，代码无需改。
  `--disable-frame-rate-limit` 不建议使用（撕裂/发热，显示器本身不支持的帧不会多出来）。

## 5. 别再把冒烟跑进真实库

`npm run smoke` 会复制 `data/` 到 `.smoke-data-N`，用独立 profile，安全。
但直接 `electron . --smoke` **不会**自动复制，必须自己设：

```powershell
$env:MA_DATA_DIR = "<一份 data 的副本>"
electron . --smoke --user-data-dir=<独立 profile>
```

2026-10-26 就踩过一次：直接跑 `electron . --smoke` 把 `data/tracks/神鹿谣.json` 的
`audioPath` 改成了 768ms 的 ringtone，并写进真实 `atlas.db`，导致后续 22 条音频/播放头断言级联红。
已从 18:12 的 `.smoke-data-2` 快照恢复；污染版本备份在
`%TEMP%\ma-db-polluted-20261026-185051`（确认无误后可删）。

**判断数据是否干净的快捷方式**：`神鹿谣` 的主录音应该是
`C:/Users/Administrator/Music/王者荣耀 _ 曾怡 - 神鹿谣.flac`（3:06），
不是 `assets/ringtone-accept.mp3`（0.768s）。
