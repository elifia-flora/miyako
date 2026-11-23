/**
 * config.json — 启动配置（外置文件）。
 *
 * 为什么放在 userData 而不是 data/：
 *   - 它描述「这台机器怎么启动」，不是作品内容；换机器 / 重装不该把别人的窗口习惯带过去；
 *   - data/ 在打包后是只读资源，配置文件必须可写。
 *
 * 文件不存在时立刻生成一份默认值，用户可以从「选项 → 启动配置」直接打开手改。
 * 语法坏了也不拦启动：用默认值运行，并把错误原样报给界面。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, AppConfigPatch, AppConfigSnapshot, LayoutPatch } from '../shared/types';
// 归一与深合并是纯函数，放在 shared 下：`node --test` 能直接测（主进程的 TS 不行）
import { emptyLayout, mergeLayout, normalizeLayout } from '../shared/layout.js';
export { normalizeLayout };

const DEFAULTS: AppConfig = {
  version: 1,
  safeMode: false,
  startup: { lyrics: true, help: true },
  layout: emptyLayout(),
};

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

function plainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export class ConfigStore {
  readonly file: string;
  private config: AppConfig = { ...DEFAULTS, startup: { ...DEFAULTS.startup } };
  /** 原文件里本程序不认识的键：界面改选项时原样带回去，不悄悄删掉 */
  private raw: Record<string, any> = {};
  /** 本次启动才创建的文件（渲染层据此做一次 localStorage 旧偏好迁移） */
  private fresh = false;
  private parseError: string | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, 'config.json');
    this.load();
  }

  get(): AppConfig {
    return { ...this.config, startup: { ...this.config.startup }, layout: normalizeLayout(this.config.layout) };
  }

  snapshot(): AppConfigSnapshot {
    return {
      ...this.get(),
      path: this.file,
      fresh: this.fresh,
      parseError: this.parseError,
    };
  }

  update(patch: AppConfigPatch): AppConfigSnapshot {
    const before = this.get();
    if (typeof patch?.safeMode === 'boolean') this.config.safeMode = patch.safeMode;
    if (plainObject(patch?.startup)) {
      if (typeof patch.startup.lyrics === 'boolean') this.config.startup.lyrics = patch.startup.lyrics;
      if (typeof patch.startup.help === 'boolean') this.config.startup.help = patch.startup.help;
    }
    if (patch?.layout) this.config.layout = mergeLayout(this.config.layout, patch.layout);
    if (!this.write()) {
      // 写盘失败就不装作成功：界面要能告诉用户「这次没存进去」
      this.config = before;
      throw new Error(`无法写入 ${this.file}`);
    }
    this.fresh = false;
    return this.snapshot();
  }

  /**
   * 只写布局。窗口拖动 / 面板拖宽的调用点很密（松手一次写一遍），
   * 走这条就不必构造 `AppConfigPatch` 的其它字段，也不会误碰 safeMode / startup。
   */
  setLayout(patch: LayoutPatch): AppConfigSnapshot {
    return this.update({ layout: patch });
  }

  private load() {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        this.fresh = true;
        // 先生成一份可读的默认文件：用户不需要先打开选项才知道它在哪
        this.write();
      } else {
        this.parseError = e instanceof Error ? e.message : String(e);
        console.warn(`[config] 读取 ${this.file} 失败，使用默认值：${this.parseError}`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(text);
      if (!plainObject(parsed)) throw new Error('顶层必须是 JSON 对象');
      this.raw = parsed;
      const startup = plainObject(parsed.startup) ? parsed.startup : {};
      this.config = {
        version: 1,
        safeMode: bool(parsed.safeMode, DEFAULTS.safeMode),
        startup: {
          lyrics: bool(startup.lyrics, DEFAULTS.startup.lyrics),
          help: bool(startup.help, DEFAULTS.startup.help),
        },
        layout: normalizeLayout(parsed.layout),
      };
      this.parseError = null;
    } catch (e: any) {
      // 手改坏 JSON 是常态：不覆盖原文件，等用户自己改回来；界面会显示这条错误
      this.parseError = e instanceof Error ? e.message : String(e);
      console.warn(`[config] ${this.file} 不是合法配置，使用默认值：${this.parseError}`);
    }
  }

  private write(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 用户在坏文件上又点了选项：先留一份原件，别让一次点击把他的手改吃掉
      if (this.parseError && fs.existsSync(this.file)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${this.file}.bad-${stamp}`;
        fs.copyFileSync(this.file, backup);
        console.warn(`[config] 原文件有语法错误，已备份到 ${backup}`);
      }
      const rawStartup = plainObject(this.raw.startup) ? this.raw.startup : {};
      const out = {
        ...this.raw,
        version: 1,
        safeMode: this.config.safeMode,
        startup: { ...rawStartup, ...this.config.startup },
        layout: normalizeLayout(this.config.layout),
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, this.file);
      this.raw = out;
      this.parseError = null;
      return true;
    } catch (e) {
      console.error('[config] 写盘失败', e);
      return false;
    }
  }
}
