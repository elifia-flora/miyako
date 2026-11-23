/**
 * seedid.js — 导入队列的 id 规划（纯函数，不碰数据库、不碰文件）。
 *
 * ## 为什么需要「规划」这一步
 *
 * `data/tracks/*.json` 是源。新档案（schema v3）顶层带 `uuid`，身份是显式的；
 * 老档案（v2）没有 uuid，原来 `seed` 只能**按标题算哈希**当 id：
 *
 *     stableId('trk', '月光')  →  trk-1d1ss57
 *
 * 于是「同名的两首不同作品」必然算出同一个 id。更糟的是 `seed` 撞到已存在的 id
 * 时是 `skipped` 然后 `continue` —— **第二首悄悄不导入**，界面上什么也看不出来。
 * 而古典音乐里同名作品多得很（各种《无词歌》《前奏曲》），这不是理论风险。
 *
 * ## 规则
 *
 * 1. 有 `uuid` 的档案：**照它说的算**，绝不自作主张改。
 * 2. 没有 uuid 的：先按标题算候选 id（保持老档案重复导入的稳定性）。
 * 3. 候选 id 已被**别的文件**（带 uuid 的）占了，或这一批里前一份没有 uuid 的文件先占了它
 *    → 说明这是另一首同名作品 → 换一个新 id，并标记 `heal: true`（调用方把这个新 id
 *    写回那份 JSON，下次启动它就变成「有 uuid 的新档案」，从此稳定）。
 *
 * 只按「文件之间」比较，**不看数据库**：库里已有这个 id 恰恰是「这份文件早就导入过」的证据，
 * 那是正常的跳过（同一份文件反复启动不该越导越多）。
 */

/** 稳定短 id（FNV-1a）：同一份 JSON 反复导入不会产生新行。老档案仍在用 */
export function stableId(prefix, seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

/**
 * @param {{ file: string, uuid?: string | null, title: string }[]} entries 待导入的档案
 * @param {{ mint: () => string }} opts `mint` 生成新 id（注入进来才好单测）
 * @returns {{ file: string, id: string, heal: boolean }[]} 顺序与入参一致
 */
export function planSeedIds(entries, { mint } = {}) {
  if (typeof mint !== 'function') throw new Error('planSeedIds 需要 mint() 来生成新 id');

  // 文件名的字典序是确定的：同一批数据无论文件系统怎么返回，分到的 id 都一样
  const sorted = [...entries].sort((a, b) => String(a.file).localeCompare(String(b.file)));

  // 显式 uuid 是「已经声明过的身份」，先全部占位
  const claimed = new Set();
  for (const e of sorted) if (e.uuid) claimed.add(e.uuid);

  const plan = new Map();
  for (const e of sorted) {
    if (e.uuid) {
      plan.set(e.file, { file: e.file, id: e.uuid, heal: false });
      continue;
    }
    const candidate = stableId('trk', e.title);
    if (claimed.has(candidate)) {
      let id = mint();
      // mint 自己也不该撞，但既然这里已经有全集，多挡一次成本为零
      while (claimed.has(id)) id = mint();
      claimed.add(id);
      plan.set(e.file, { file: e.file, id, heal: true });
    } else {
      claimed.add(candidate);
      plan.set(e.file, { file: e.file, id: candidate, heal: false });
    }
  }

  return entries.map((e) => plan.get(e.file));
}
