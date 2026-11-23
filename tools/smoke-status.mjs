#!/usr/bin/env node
/**
 * 「冒烟还在跑吗？跑到哪了？」—— 一条命令回答。
 *
 * ## 为什么需要它
 *
 * 冒烟窗口在 `--smoke` 下是**完全透明 + 鼠标穿透 + 不进任务栏**的（主进程 `quietWindow()`）：
 * 看不见、点不到、Alt-Tab 里也没有。用户的原话是「像听不到声音一样，也看不到」——
 * 那总得留一个出口，否则测试在不在跑、跑到哪一步，全靠猜。
 *
 * 出口就是仓库根的 `.smoke-run.json`：主进程每 400ms 落一次
 * （`publishSmokeProgress()`），外加一笔「done」收尾。这里读它，再确认那个 pid 还活着
 * —— 文件说在跑、进程却没了的组合是真实存在的（崩溃 / 被任务管理器杀掉），必须分开报。
 *
 *     npm run smoke:status
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const file = path.join(root, '.smoke-run.json');

const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
};
const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

/** 进程还在不在。EPERM = 在，只是没权限给它发信号（Windows 上偶尔如此） */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

let st = null;
try {
  st = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  /* 没跑过，或者文件正在被写（极端情况） */
}

if (!st) {
  console.log('[smoke] 还没跑过（没有 .smoke-run.json）。');
  console.log('[smoke] 起一轮：npm run smoke');
  process.exit(0);
}

const running = !st.done && alive(st.pid);
const ran = (st.passed ?? 0) + (st.failed ?? 0);
const failLine = (st.failed ?? 0) > 0 ? `，失败 ${st.failed}` : '';

if (running) {
  const elapsed = Date.now() - (st.startedAt ?? st.updatedAt ?? Date.now());
  console.log('[smoke] 正在跑 ✓');
  console.log(`  pid ${st.pid} · 已跑 ${dur(elapsed)}`);
  console.log(`  已过 ${ran} 条（通过 ${st.passed ?? 0}${failLine}）`);
  if (st.last) {
    console.log(`  最近一条：${st.lastOk === false ? '❌ ' : ''}${st.last}`);
  }
  console.log('');
  console.log('  窗口是透明的（看不见、点不到），最多 8 分钟会自己退出。');
  console.log('  想肉眼看画面：先停掉这一轮，再跑 MA_SMOKE_VISIBLE=1 npm run smoke');
  process.exit(0);
}

if (!st.done) {
  // 文件说「还在跑」，但进程没了 —— 被中断 / 崩溃 / 死线之外的方式被杀
  console.log('[smoke] 没在跑，但状态文件停在「进行中」：pid ' + st.pid + ' 已经不在了。');
  console.log(`  最后更新 ${clock(st.updatedAt ?? Date.now())} · 停在 ${ran} 条（通过 ${st.passed ?? 0}${failLine}）`);
  if (st.last) console.log(`  最后一条：${st.lastOk === false ? '❌ ' : ''}${st.last}`);
  console.log('  多半是崩溃或被强制结束 —— 看 logs/boot.log，或直接重跑：npm run smoke');
  process.exit(0);
}

// 已经跑完
const used = st.endedAt && st.startedAt ? dur(st.endedAt - st.startedAt) : null;
const total = st.total ?? ran;
const ok = (st.failed ?? 0) === 0 && !st.aborted;
console.log(`[smoke] 没在跑。上一次：${ok ? '全部通过 ✓' : st.aborted ? '异常中止 ✗' : '有失败 ✗'}`);
console.log(`  ${st.passed ?? 0}/${total} 条${failLine}${used ? ` · 用时 ${used}` : ''}${st.endedAt ? ` · ${clock(st.endedAt)} 结束` : ''}`);
if (st.last) console.log(`  收尾：${st.last}`);
console.log('');
console.log('  再跑一轮：npm run smoke');
