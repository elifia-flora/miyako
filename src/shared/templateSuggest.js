/**
 * 模板变量的输入补全（纯函数，渲染层与 node --test 共用）。
 *
 * 三处输入框共用这一套：选项里的模板编辑器、列表行内改名、详情栏标题。
 * 语义刻意**不侵入**：用户打的是自己想打的字，补全只是「↑↓ 选中、Enter / Tab 采纳」，
 * 不自动改字、不拦截正常回车（没选中任何候选项时，Enter 还是换行 / 提交）。
 *
 * 触发条件（缺一不可）：
 *   1. 光标前最后一个 `%` 之后还没写 `}`（`%c`、`%Num`、只有一个 `%`）；
 *   2. 没有 `%` 时，光标前是**一串连续字母 / 汉字**（`c`、`Cp`、`作`）——
 *      用户明确要求「打 c 或 %c 或 Cp 都能出 %Composer}」。
 *
 * 匹配口径（分数越小越靠前）：
 *   0 完全相等 / 1 前缀 / 2 词首缩写（`notf` → Number of the form）/ 3 子序列（`Cp` → Composer）。
 * 名字、中文名、英文名、日文名都参与匹配 —— 用中文界面的人打「作」也该能想到 `%Composer}`。
 */
import { TEMPLATE_VARIABLES } from './titleTemplate.js';

/** 归一：大小写、下划线、连字符、空格都不敏感 */
function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/** 词首缩写：`Number of the form` → `notf` */
function initials(s) {
  return String(s ?? '')
    .split(/[\s_-]+/)
    .map((w) => w[0] ?? '')
    .join('')
    .toLowerCase();
}

/** 子序列：`cp` 是 `composer` 的子序列（不要求连续） */
function isSubsequence(q, name) {
  let i = 0;
  for (const ch of name) {
    if (ch === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return false;
}

/**
 * 光标处正在输入的那个词。
 *
 * 返回 `{ start, end, query, percent }`：`start` 是要被替换的起点（`%` 含在内），
 * `end` 是光标位置；`percent` 表示这次要不要补上 `%`（用户已经打了 `%` 就不用）。
 * 没有可补的词时返回 null。
 */
export function caretToken(text, caret) {
  const s = String(text ?? '');
  const end = Math.min(s.length, Math.max(0, Number.isFinite(caret) ? caret : s.length));
  const before = s.slice(0, end);

  const lineStart = before.lastIndexOf('\n') + 1;
  const pct = before.lastIndexOf('%');
  /*
   * `50%` 里的 `%` 是百分号，不是变量开头：紧贴在字母 / 数字 / 汉字后面的一律不算。
   * 少了这一条，标题里写「前奏 50% 处」会立刻弹出全部 8 个变量。
   */
  const prev = pct > 0 ? before[pct - 1] : '';
  const pctUsable = pct >= lineStart && !(prev && /[0-9A-Za-z\u3400-\u9fff]/.test(prev));
  if (pctUsable) {
    const tail = before.slice(pct + 1);
    // `%` 后面还没写 `}`、也没再出现 `%`：这段就是变量名的草稿
    if (!/[%}]/.test(tail)) {
      return { start: pct, end, query: tail, percent: true };
    }
  }

  // 没在写变量：只认光标前那一串连续字母 / 汉字（不跨空格，否则整句标题都会参与匹配）
  const m = /([A-Za-z\u3400-\u9fff]{1,20})$/.exec(before);
  if (m) return { start: end - m[1].length, end, query: m[1], percent: false };
  return null;
}

/** 某条变量的匹配分（99 = 不匹配） */
function scoreOf(varDef, q) {
  const keys = [varDef.name, varDef.zh, varDef.en, varDef.ja].filter(Boolean).map(norm);
  let best = 99;
  for (const k of keys) {
    if (!k) continue;
    if (k === q) best = Math.min(best, 0);
    else if (k.startsWith(q)) best = Math.min(best, 1);
    else if (initials(k) === q || initials(k).startsWith(q)) best = Math.min(best, 2);
    else if (q.length >= 2 && isSubsequence(q, k)) best = Math.min(best, 3);
  }
  return best;
}

/**
 * 光标处能给的变量候选。
 *
 * 打开状态（只打了个 `%`）给全部；否则按匹配分排序，最多 `limit` 条。
 * `insert` 是采纳后要写进去的整段（`%Composer}`），由调用方负责替换 `[start, end)`。
 */
export function suggestVariables(text, caret, limit = 6) {
  const tok = caretToken(text, caret);
  if (!tok) return [];
  const q = norm(tok.query);
  const out = [];
  TEMPLATE_VARIABLES.forEach((v, order) => {
    const score = q ? scoreOf(v, q) : 0;
    if (score >= 99) return;
    out.push({
      kind: 'variable',
      key: v.key,
      // 列表里写 `%Composer}`，副标题写中文名，和选项里的变量图例一致
      label: `%${v.name}}`,
      desc: v.zh,
      insert: `%${v.name}}`,
      score,
      order,
    });
  });
  return out
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map(({ score, order, ...rest }) => ({ ...rest, start: tok.start, end: tok.end, percent: tok.percent }));
}

/** 采纳一条候选：返回新文本与新光标位置（不碰 DOM，方便单测） */
export function applyVariable(text, item) {
  const s = String(text ?? '');
  const start = Math.max(0, Math.min(s.length, item?.start ?? 0));
  const end = Math.max(start, Math.min(s.length, item?.end ?? start));
  const insert = String(item?.insert ?? '');
  const next = `${s.slice(0, start)}${insert}${s.slice(end)}`;
  return { text: next, caret: start + insert.length };
}
