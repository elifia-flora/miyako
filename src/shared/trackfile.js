/**
 * 曲目 JSON 的文件名规则（纯函数，主进程与 `node --test` 共用）。
 *
 * 为什么文件名跟曲名走：`data/tracks` 是给人看的档案目录，
 * 打开文件夹就能找到「神鹿谣.json」。代价是改名要搬文件，所以候选名必须**可重现**：
 * 同一首曲目（同一个 id）在任何时候都能算出同一串候选名，搬丢了也能找回来。
 *
 * 冲突用 id 尾段兜底：两条都叫「未命名作品」时，第一条占 `未命名作品.json`，
 * 第二条落到 `未命名作品 (mvesswr3inr).json` —— 不覆盖、不静默合并。
 */

/** Windows 不允许出现在文件名里的字符，外加控制字符 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Windows 的保留设备名，撞上就永远删不掉/建不出 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 单个路径段留出余量：Windows 上限 255，这里连同后缀 ≤ 130 */
const MAX_BASE = 120;

export function sanitizeTrackFileBase(title) {
  let s = String(title ?? '')
    .replace(ILLEGAL, '_')
    // 结尾的点和空格在 Windows 上会被悄悄吃掉，导致「写进去读不回来」
    .replace(/[.\s]+$/, '')
    .trim();

  if (!s) s = '未命名作品';
  if (s.length > MAX_BASE) s = s.slice(0, MAX_BASE).trim();
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/**
 * 候选文件名，按优先级排序。
 * 第一个永远是「纯净的曲名」；后面的带 id 尾段，用于同名冲突。
 */
export function trackFileCandidates(title, trackId) {
  const base = sanitizeTrackFileBase(title);
  const tail = String(trackId ?? '').replace(/^[a-z]+-/, '');
  const out = [`${base}.json`];
  if (!tail) return out;

  out.push(`${base} (${tail}).json`);
  for (let i = 2; i <= 9; i++) out.push(`${base} (${tail}-${i}).json`);
  return out;
}
