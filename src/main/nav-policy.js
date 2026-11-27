/**
 * 外链 / 页面跳转的放行规则（纯函数，`node --test` 直接测，见 tests/nav-policy.test.mjs）。
 *
 * 只管两条「渲染层自己发起」的路：`window.open` / 新窗口、页面跳转（will-navigate）。
 * **网易云唤起不走这里**：渲染层调 `window.api.netease.open(url)` → 主进程 IPC
 * `netease:open` → `openMusicLink()` 里直接 `shell.openExternal('orpheus://…')`，
 * 与这两条拦截无关。这里仍把 `orpheus:` 放进白名单，是为了以后哪怕有人在界面上
 * 写成普通链接 / `window.open`，网易云唤起也照样能用，而不是被静默拦掉。
 */

/** 允许交给系统去打开的协议：网页 + 网易云音乐客户端 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'orpheus:']);

/**
 * 这个地址能不能交给 `shell.openExternal`。
 * `file:`、`javascript:`、自定义协议（ma-audio: / ma-art:）、其它任意 scheme 一律不行。
 * @param {unknown} url
 * @returns {boolean}
 */
export function isAllowedExternal(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (!EXTERNAL_PROTOCOLS.has(u.protocol)) return false;
    // http(s) 里带账号密码的地址（https://user:pass@host）多半是钓鱼写法，不开
    if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.username || u.password)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 是不是渲染层自己的页面（忽略 hash / query）。
 * @param {unknown} url 要去的地址
 * @param {{ devUrl?: string | null, pageUrl: string }} app
 *   devUrl：开发模式的 dev server 地址；pageUrl：打包后 index.html 的 file:// 地址
 * @returns {boolean}
 */
export function isAppPage(url, app) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (app.devUrl) return u.origin === new URL(app.devUrl).origin;
    const page = new URL(app.pageUrl);
    return u.protocol === 'file:' && u.pathname === page.pathname;
  } catch {
    return false;
  }
}
