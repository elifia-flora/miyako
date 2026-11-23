# 更新记录

## 0.99.1（2026-11-23）

界面没有任何改动（渲染层 CSS 与 0.99.0 逐条一致），这一版只修数据安全、打包和工程问题。

### 数据安全
- **曲目档案 / 词表 / 和弦符号 / 歌词改为原子写盘**（`src/main/atomic-write.js`）：先写同目录临时文件、
  fsync，再 rename 覆盖。以前直接 `writeFileSync`，写到一半断电或崩溃会留下半截 JSON，
  下次启动这首曲目就从库里消失。Windows 上目标文件被短暂占用时会重试，仍不行才退回直接覆盖。

### 修复
- 「编辑」菜单的撤销 / 重做 / 全局撤销 / 全局重做**一直是灰的**：菜单里读的是 `histMenu.undo`
  （Ref 本身）而不是 `histMenu.value.undo`，永远是 `undefined`。快捷键不受影响，只是菜单点不了。
- macOS / Linux 安装包里没有能用的 better-sqlite3 原生模块（预编译包被全局排除、`build/` 也被排除），
  现在每个平台只带自己那一份预编译包。

### 安全
- 所有窗口的渲染进程开启沙箱（`sandbox: true`），七份重复的 webPreferences 合成一个 `securePrefs()`。
- 新窗口 / 外链统一拦截：只有 http(s) 链接会交给系统浏览器；渲染层不能跳转到应用页面以外
  （包括把文件拖进窗口时 Chromium 默认的「导航到这个文件」）。
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
- `vue` 移到 devDependencies；新增 devDependencies：`vue-tsc`、`@types/better-sqlite3`。
