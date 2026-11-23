# 更新记录

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
- macOS / Linux 安装包里没有能用的 better-sqlite3 原生模块（预编译包被全局排除、`build/` 也被排除），
  现在每个平台只带自己那一份预编译包。

### 安全
- 所有窗口的渲染进程开启沙箱（`sandbox: true`），七份重复的 webPreferences 合成一个 `securePrefs()`。
  DevTools、`npm run app:debug` 的 CDP、冒烟里的 `executeJavaScript` / `capturePage` 都不受影响；
  开发时如需排查「是不是沙箱导致的」，可用 `MA_RENDERER_SANDBOX=0 npm run dev` 临时关掉（打包后的应用忽略这个变量）。
- 新窗口 / 页面跳转统一拦截（规则在 `src/main/nav-policy.js`，有单测）：只有 http(s) 与网易云（`orpheus:`）
  会交给系统打开；`file:`、`javascript:`、自定义协议一律不开；渲染层不能跳出应用自己的页面
  （包括把文件拖进窗口时 Chromium 默认的「导航到这个文件」）。
  网易云「唤起客户端播放」走的是 IPC（`netease:open`），本来就不经过这两条拦截，已在 Electron 里实测仍能正常唤起。
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
