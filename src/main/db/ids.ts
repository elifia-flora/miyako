import { randomBytes } from 'node:crypto';

/**
 * id 生成器（曲目 / 分析档案 / 录音版本）。
 *
 * ## 为什么不再是「时间戳 + 3 位随机」
 *
 * 原来登记作品是 `tr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`，
 * 随机段只有 3 位 base36（≈46656 种）。手工点鼠标几乎撞不上，但批量导入 / 脚本调用
 * 会落在同一毫秒里 —— 而 `track.id` 是 `UNIQUE`，撞上就是「登记失败」。
 *
 * 现在固定三段：`<前缀>-<8 位 base36 时间>-<10 位 base36 随机>`，
 * 随机段用 `crypto.randomBytes` 而不是 `Math.random`（后者是可预测的 PRNG）。
 * 36^10 ≈ 3.6e15，配上毫秒时间与插入前查重，撞车概率可以当作不存在。
 *
 * ## 为什么还留可读前缀
 *
 * id 会出现在 `data/tracks/*.json` 的 `uuid` 字段里，也会出现在 `ma-audio://rec/<track>/<rec>`。
 * 一眼能看出「这是曲目还是录音」，比一串裸 UUID 好排查；文件名冲突时取尾部一段也够短。
 */

/** 每 4 字节取一个 32 位无符号数转 base36（最多 7 位），拼够长度再截断 */
export function randomBase36(len: number): string {
  let out = '';
  while (out.length < len) out += randomBytes(4).readUInt32BE(0).toString(36);
  return out.slice(0, len);
}

/** `<prefix>-<8 位时间>-<10 位随机>`，例：`tr-mf3k2x4a-9d0k2m1xzp` */
export function newId(prefix: string, now = Date.now()): string {
  // 8 位 base36 能写到公元 5000 年以后，补零是为了让长度恒定（排序 / 肉眼比较都省事）
  return `${prefix}-${now.toString(36).padStart(8, '0')}-${randomBase36(10)}`;
}

export const newTrackId = (now = Date.now()): string => newId('tr', now);

/**
 * 分析档案 id 与曲目成对：`tr-mf3k2x4a-9d0k2m1xzp` ↔ `an-mf3k2x4a-9d0k2m1xzp`。
 *
 * 这条推导规则 `seed.ts` 也依赖（JSON 里只有曲目 uuid，档案 id 得算出来），
 * 所以只在这里定义一次 —— 两边各写一份，哪天改前缀就会对不上。
 */
export function analysisIdFor(trackId: string): string {
  return `an-${String(trackId).replace(/^[a-z]+-/, '')}`;
}
