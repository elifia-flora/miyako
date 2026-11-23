/**
 * history.ts — 操作历史（撤销 / 重做）的**唯一真相**，跑在主进程。
 *
 * 为什么不在渲染层：
 *   1) 撤销要跨窗口（主窗口网格 + 独立时间线窗口是两个 GridEditor 实例）；
 *   2) 还要跨会话（关掉软件再打开，最近 50 步还得能撤）。
 * 两处各持一份栈必然漂移，所以状态放这里，渲染层只发指令 + 读列表。
 *
 * 存的是什么：
 *   每一步**做完之后**那首曲子的**全部事件**（以及该曲第一次被改之前的 base）。
 *   不存 diff —— 区间写入会截短/拆分既有事件，逐条反做不可靠（analysis.ts 的注释里写过），
 *   而一份快照也就几 KB，50 步几百 KB，不值得为省这点空间冒数据错的风险。
 *
 * 游标：
 *   `cursors[analysisId]` = 这首曲子当前数据对应的是哪一步（seq）。
 *   `globalCursor` = 全局最后应用的那一步（跨曲目撤销/重做用它）。
 *   新操作发生时，**该曲游标之后的项全部丢弃**（经典 undo 语义：改了就没有「将来」了）。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface HistLabel {
  key: string;
  vars?: Record<string, unknown>;
}

export type HistKind = 'base' | 'step';

export interface HistItem {
  seq: number;
  at: number;
  kind: HistKind;
  trackId: string;
  title: string;
  analysisId: string;
  label: HistLabel | null;
  /** 这一步之后（base 是「第一次改之前」）那首曲子的全部事件 */
  events: any[];
}

/** 给列表用的轻量视图：不带 events（动辄几百条，过桥没必要） */
export type HistEntry = Omit<HistItem, 'events'>;

export interface HistSnapshot {
  nextSeq: number;
  items: HistItem[];
  cursors: Record<string, number>;
  globalCursor: number;
}

interface HistFile extends HistSnapshot {
  version: 1;
}

export interface HistoryDeps {
  /** 用户数据目录（写 undo-history.json 的地方） */
  dir: string;
  /** 把某首曲子恢复成这份事件（主进程调 analysisIpc.replaceEvents + JSON 镜像） */
  apply: (analysisId: string, events: any[]) => void;
}

const FILE_NAME = 'undo-history.json';
const SAVE_DEBOUNCE_MS = 900;
const DEFAULTS = { limit: 0, persist: 50 };

export class HistoryStore {
  private data: HistSnapshot = { nextSeq: 1, items: [], cursors: {}, globalCursor: 0 };
  private file: string;
  private deps: HistoryDeps;
  /** 运行期最多保留多少步；0 = 无限（用户默认） */
  private limit = DEFAULTS.limit;
  /** 关闭软件时写盘最近多少条（全局算） */
  private persist = DEFAULTS.persist;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: HistoryDeps) {
    this.deps = deps;
    this.file = path.join(deps.dir, FILE_NAME);
    this.load();
  }

  /* ---------------- 读写盘 ---------------- */

  private load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as HistFile;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) return;
      this.data = {
        nextSeq: Math.max(1, Number(parsed.nextSeq) || 1),
        items: parsed.items.filter((i) => i && Array.isArray(i.events) && i.analysisId),
        cursors: parsed.cursors && typeof parsed.cursors === 'object' ? { ...parsed.cursors } : {},
        globalCursor: Number(parsed.globalCursor) || 0,
      };
    } catch {
      /* 没有文件 / JSON 坏了：从空历史开始，别让启动失败 */
    }
  }

  /** 真正落盘：**只写最近 persist 条**（内存里可以留更多） */
  private writeNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      const slice = this.persist > 0 ? this.data.items.slice(-this.persist) : this.data.items;
      const keep = new Set(slice.map((i) => i.seq));
      // 游标里指向已被丢掉的那些，修正成「该曲现存最小一步」，不然恢复后会指向不存在的项
      const cursors: Record<string, number> = {};
      for (const [aid, seq] of Object.entries(this.data.cursors)) {
        if (keep.has(seq)) cursors[aid] = seq;
        else {
          const first = slice.find((i) => i.analysisId === aid);
          if (first) cursors[aid] = first.seq;
        }
      }
      const out: HistFile = {
        version: 1,
        nextSeq: this.data.nextSeq,
        items: slice,
        cursors,
        globalCursor: keep.has(this.data.globalCursor) ? this.data.globalCursor : 0,
      };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[history] 写盘失败', e);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeNow(), SAVE_DEBOUNCE_MS);
  }

  /** 退出前强制落盘（主进程 before-quit 里调） */
  flush() {
    if (this.saveTimer) this.writeNow();
  }

  /* ---------------- 配置 ---------------- */

  config(limit: number, persist: number) {
    // 0 / 负数 = 无限；persist 至少要留 1 条，不然写了等于没写
    this.limit = Math.max(0, Math.floor(Number(limit) || 0));
    this.persist = Math.max(1, Math.floor(Number(persist) || DEFAULTS.persist));
    this.trim();
    this.scheduleSave();
    return { limit: this.limit, persist: this.persist };
  }

  /* ---------------- 查询 ---------------- */

  get cursors(): Record<string, number> {
    return { ...this.data.cursors };
  }

  get globalCursor(): number {
    return this.data.globalCursor;
  }

  /** 列表用：最新在前 */
  list(): HistEntry[] {
    return this.data.items
      .slice()
      .reverse()
      .map(({ events, ...rest }) => rest);
  }

  /** 某首曲子能不能撤 / 重做（渲染层按钮的灰色状态） */
  can(aid: string): { undo: boolean; redo: boolean } {
    const cur = this.data.cursors[aid];
    if (cur == null) return { undo: false, redo: false };
    const mine = this.data.items.filter((i) => i.analysisId === aid);
    return {
      undo: mine.some((i) => i.seq < cur),
      redo: mine.some((i) => i.seq > cur),
    };
  }

  canGlobal(): { undo: boolean; redo: boolean } {
    const cur = this.data.globalCursor;
    return {
      undo: this.data.items.some((i) => i.seq < cur),
      redo: this.data.items.some((i) => i.seq > cur),
    };
  }

  /* ---------------- 写入 ---------------- */

  /**
   * 记一步。`before` 由渲染层给（写库之前那一眼），`after` 由调用方从库里读
   * （渲染层手里的 props 还是旧的，不能拿来当 after）。
   */
  append(input: {
    trackId: string;
    title: string;
    analysisId: string;
    label: HistLabel | null;
    before: any[];
    after: any[];
  }): HistItem {
    const { analysisId } = input;
    const mine = this.data.items.filter((i) => i.analysisId === analysisId);

    // 1) 这首曲子第一次被改：先补一条 base（撤销到第一步之前要用它）
    if (!mine.length) {
      const base: HistItem = {
        seq: this.data.nextSeq++,
        at: Date.now(),
        kind: 'base',
        trackId: input.trackId,
        title: input.title,
        analysisId,
        label: null,
        events: input.before,
      };
      this.data.items.push(base);
      this.data.cursors[analysisId] = base.seq;
    }

    // 2) 该曲游标之后的项全部作废（用户又改了东西 = 原来的「将来」没了）
    const cur = this.data.cursors[analysisId] ?? -1;
    this.data.items = this.data.items.filter((i) => i.analysisId !== analysisId || i.seq <= cur);

    // 3) 追加这一步
    const item: HistItem = {
      seq: this.data.nextSeq++,
      at: Date.now(),
      kind: 'step',
      trackId: input.trackId,
      title: input.title,
      analysisId,
      label: input.label,
      events: input.after,
    };
    this.data.items.push(item);
    this.data.cursors[analysisId] = item.seq;
    this.data.globalCursor = item.seq;

    this.trim();
    this.scheduleSave();
    return item;
  }

  /* ---------------- 撤销 / 重做 ---------------- */

  private applyItem(item: HistItem) {
    this.deps.apply(item.analysisId, item.events);
    this.data.cursors[item.analysisId] = item.seq;
    this.data.globalCursor = item.seq;
    this.scheduleSave();
  }

  /** 只撤**这一首**：游标往回走一步 */
  undo(aid: string): HistItem | null {
    const cur = this.data.cursors[aid];
    if (cur == null) return null;
    const prev = this.data.items
      .filter((i) => i.analysisId === aid && i.seq < cur)
      .sort((a, b) => b.seq - a.seq)[0];
    if (!prev) return null;
    this.applyItem(prev);
    return prev;
  }

  redo(aid: string): HistItem | null {
    const cur = this.data.cursors[aid];
    if (cur == null) return null;
    const next = this.data.items
      .filter((i) => i.analysisId === aid && i.seq > cur)
      .sort((a, b) => a.seq - b.seq)[0];
    if (!next) return null;
    this.applyItem(next);
    return next;
  }

  /** 全局撤销一步：撤掉全局游标那条（可能是别的曲子，调用方负责切过去） */
  undoGlobal(): HistItem | null {
    const cur = this.data.globalCursor;
    const prev = this.data.items.filter((i) => i.seq < cur).sort((a, b) => b.seq - a.seq)[0];
    if (!prev) return null;
    this.applyItem(prev);
    return prev;
  }

  redoGlobal(): HistItem | null {
    const cur = this.data.globalCursor;
    const next = this.data.items.filter((i) => i.seq > cur).sort((a, b) => a.seq - b.seq)[0];
    if (!next) return null;
    this.applyItem(next);
    return next;
  }

  /**
   * 跳到某一步（历史窗口里点一条）。
   * 注意它**不改其它曲目的数据** —— 只把那一条所属的曲子恢复成它当时的样子。
   */
  jump(seq: number): HistItem | null {
    const item = this.data.items.find((i) => i.seq === seq);
    if (!item) return null;
    this.applyItem(item);
    return item;
  }

  /** 清空（按曲目清或全清）。清完就再也撤不回去了，调用方要先确认。 */
  clear(analysisId?: string): number {
    const before = this.data.items.length;
    if (analysisId) {
      this.data.items = this.data.items.filter((i) => i.analysisId !== analysisId);
      delete this.data.cursors[analysisId];
    } else {
      this.data.items = [];
      this.data.cursors = {};
      this.data.globalCursor = 0;
      this.data.nextSeq = 1;
    }
    // 全局游标可能指向被清掉的项
    if (!this.data.items.some((i) => i.seq === this.data.globalCursor)) {
      this.data.globalCursor = this.data.items.length ? this.data.items[this.data.items.length - 1].seq : 0;
    }
    this.writeNow();
    return before - this.data.items.length;
  }

  /* ---------------- 裁剪 ---------------- */

  private trim() {
    if (this.limit <= 0 || this.data.items.length <= this.limit) return;
    const drop = this.data.items.length - this.limit;
    this.data.items = this.data.items.slice(drop);
    const firstSeq = this.data.items[0]?.seq ?? 0;
    // 游标指向被裁掉的项 → 退到「该曲现存最小一步」，这样还能继续撤销剩下的部分
    for (const [aid, seq] of Object.entries(this.data.cursors)) {
      if (seq < firstSeq) {
        const first = this.data.items.find((i) => i.analysisId === aid);
        if (first) this.data.cursors[aid] = first.seq;
        else delete this.data.cursors[aid];
      }
    }
    if (this.data.globalCursor < firstSeq) this.data.globalCursor = firstSeq;
  }
}
