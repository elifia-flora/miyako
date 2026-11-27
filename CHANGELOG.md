# 更新记录

## 0.99.3（2026-11-27）

- Windows CI 上 `powershell.exe` 没有 `Cert:` 驱动器，自签名证书造不出来，安装包因此没有打出来。改为调用 Windows PowerShell 5.1，并在缺少驱动器时载入 PKI。

## 0.99.2（2026-11-27）

界面没有改动。这一版只修三平台安装包打不开，以及 Windows 的签名。

- macOS：`identity: "-"`，打 ad-hoc 签名。Apple Silicon 的内核因此肯运行；没有 Apple 公证，从浏览器下载后第一次仍可能要右键打开。同时打 arm64 与 x64。
- Windows：安装包和免安装版用自签名证书签上 `CN=elifia-flora`，并加 DigiCert 时间戳。证书不在公共信任链上，SmartScreen 仍会提示未知发布者。
- macOS / Linux：安装包必须带上对应的 `better-sqlite3` 预编译包，缺了就让这次构建失败，不再放出一点就退的包。
- Linux：仍是 x64、glibc 的 AppImage，没有 GPG 签名。

## 0.99.1（2026-11-23）

界面没有任何改动（渲染层 CSS 与 0.99.0 逐条一致），这一版只修数据安全、打包和工程问题。

### 数据安全
- **曲目档案 / 词表 / 和弦符号 / 歌词改为原子写盘**（`src/main/atomic-write.js`）。以前直接 `writeFileSync`，
  写到一半断电或崩溃会留下半截 JSON，下次启动这首曲目就从库里消失。现在的顺序是：
  1. 在同一目录写临时文件，名字含进程号 + 随机串，并以独占方式（`wx`）创建，不会和别的写入撞名；
  2. 对临时文件 `fsync`，确认内容真的落盘后才改名；
  3. `rename` 原子替换。Windows 上目标被杀毒 / 索引 / 同步盘短暂占用（EPERM / EBUSY / EACCES）时
     按递增间隔重试约 1 秒；**仍失败就报错、原文件保持原样**，不会退回非原子的直接覆盖；
  4. macOS / Linux 上再对所在目录 `fsync`，让改名本身也落盘（Windows 由 NTFS 日志负责，跳过）。
  不保留原文件的权限位 / ACL（这些文件本来就是默认权限）。

### 修复
- 「编辑」菜单的撤销 / 重做 / 全局撤销 / 全局重做**一直是灰的**：菜单里读的是 `histMenu.undo`
  （Ref 本身）而不是 `histMenu.value.undo`，永远是 `undefined`。快捷键不受影响，只是菜单点不了。
- 0.99.0 的打包配置把 macOS / Linux 的 better-sqlite3 预编译包和 `build/` 都排除了，这两个平台的安装包里
  应该没有能加载的数据库模块（按配置推断，没有在 macOS 上实测）。现在每个平台只带自己那一份预编译包。

### 安全
- 所有窗口的渲染进程开启沙箱（`sandbox: true`），七份重复的 webPreferences 合成一个 `securePrefs()`。
  DevTools、`npm run app:debug` 的 CDP、冒烟里的 `executeJavaScript` / `capturePage` 都不受影响；
  开发时如需排查「是不是沙箱导致的」，可用 `MA_RENDERER_SANDBOX=0 npm run dev` 临时关掉（打包后的应用忽略这个变量）。
- 新窗口 / 页面跳转统一拦截（规则在 `src/main/nav-policy.js`，有单测）：只有 http(s) 与网易云（`orpheus:`）
  会交给系统打开；`file:`、`javascript:`、自定义协议一律不开；渲染层不能跳出应用自己的页面
  （包括把文件拖进窗口时 Chromium 默认的「导航到这个文件」）。
  网易云「唤起客户端播放」走的是 IPC（`netease:open`），本来就不经过这两条拦截。已在 Electron 里实测：
  点详情里的 ▶ 和「网易云 · 打开」，交给系统的 `orpheus://` 地址与 0.99.0 完全一致（客户端本身是否被唤起需在装了网易云的电脑上确认）。
- `vocab:open-file` / `vocab:doc` / `vocab:save` 校验维度名，挡住 `../` 越出 `data/vocab/` 的路径。

### 安装包
- 只带应用支持的 4 种 Chromium 界面语言包（原来 55 种，约 49MB）。
- 不再打包运行时用不到的东西：`node_modules/vue`（已打进渲染层 bundle）、`node-addon-api`（编译期头文件）、
  better-sqlite3 的 `deps/`（sqlite3.c 源码）与 `src/`、其它平台的预编译包。
- 冒烟测试代码不再进入安装包（见下）。

### 工程
- `src/main/index.ts` 从 15193 行减到约 2700 行：一万两千多行的冒烟测试搬到 `src/main/smoke.ts`，
  只在 `--smoke` 下动态加载。主进程状态通过 `SmokeHost`（全是 getter，读实时值）传进去。
- 新增 `tsconfig.node.json` / `tsconfig.web.json` 与 `npm run typecheck`，CI 在单测之后跑类型检查；
  修掉了主进程 18 处、渲染层 61 处类型错误（除上面那个菜单 bug 外都是纯类型标注，不改运行时行为）。
- 冒烟：第一次调用渲染层钩子 `window.__app` 之前先等它挂好（最多 10 秒）。以前机器一忙就会抢在
  `onMounted` 之前调用，整轮语言没切成中文，后面一串假失败。
- `vue` 移到 devDependencies；新增 devDependencies：`vue-tsc`、`@types/better-sqlite3`。
