/**
 * wavelru.js — 按字节预算淘汰的 LRU
 *
 * 波形峰值金字塔一份 6–10MB，按「份数」算上限很虚（一首 12 分钟的曲子顶三首短的），
 * 所以预算是**字节**。两条规则都是刻意的：
 *
 * 1. **插入后总量必须严格小于上限**（不是 ≤）：用户说的是「10 首 65MB 就淘汰最早那首、
 *    让占用严格少于设定值」。显存/内存这类预算，卡在等号上等于「永远刚好占满」，
 *    再加一份就得先挤掉两份，反而更容易抖。
 * 2. **单份就超预算时不缓存**：否则它会立刻把自己挤掉，白写一次磁盘还污染 LRU 顺序。
 *
 * 纯函数式（不碰 DOM、不碰 fs、不碰 IPC），可以直接 `node --test`。
 */
export class ByteLru {
  constructor(limitBytes = 0) {
    this.limit = Math.max(0, Math.round(Number(limitBytes) || 0));
    /** Map 的插入顺序就是 LRU 顺序：命中时删了再插，队尾是最近用过的 */
    this.map = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.map.size;
  }

  /** 改预算：立刻按新预算淘汰（把上限调小，占用要马上降下来） */
  setLimit(limitBytes) {
    this.limit = Math.max(0, Math.round(Number(limitBytes) || 0));
    this.trim();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    this.map.delete(key);
    this.map.set(key, hit); // 刷新到队尾
    return hit.value;
  }

  /** @returns {boolean} 是否真的放进了缓存（超预算 / 单份太大 → false） */
  set(key, value, bytes) {
    const b = Math.max(0, Math.round(Number(bytes) || 0));
    if (this.limit <= 0) return false;
    if (b >= this.limit) return false;

    const prev = this.map.get(key);
    if (prev) {
      this.map.delete(key);
      this.bytes -= prev.bytes;
    }
    while (this.bytes + b >= this.limit && this.map.size) this.evictOldest();
    this.map.set(key, { value, bytes: b });
    this.bytes += b;
    return true;
  }

  trim() {
    if (this.limit <= 0) {
      this.clear();
      return;
    }
    while (this.bytes >= this.limit && this.map.size) this.evictOldest();
  }

  evictOldest() {
    const key = this.map.keys().next().value;
    if (key === undefined) return;
    const hit = this.map.get(key);
    this.map.delete(key);
    this.bytes -= hit?.bytes ?? 0;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  /** 调试 / 冒烟用：当前驻留的 key 与各自字节数，按 LRU 顺序（旧→新） */
  entries() {
    return [...this.map.entries()].map(([key, v]) => ({ key, bytes: v.bytes }));
  }
}
