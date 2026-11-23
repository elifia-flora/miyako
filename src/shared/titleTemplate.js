/**
 * 标题 / 乐章名的模板（纯函数，主进程、渲染层、node --test 共用）。
 *
 * 语法沿用 Sibelius 的写法：`%变量名}`。`%` 是起点、`}` 是终点 ——
 * 变量名里可以带空格（`%Number of the form}`），比 `{变量}` 更适合曲名这种
 * 中英混排、前后本来就可能有百分号的自由文本。
 *
 * 取值规则：
 *   - 有值 → 原样替换；
 *   - 没有值 → **整段消失**（不是留空串、不是写 N/A）。`第二乐章 %Sub-Type} - %柔板}`
 *     缺 sub-type 时应当得到 `第二乐章 - 柔板`，而不是两个空格；
 *   - 认不出的变量名 → 原样保留，避免手误被静默吃掉。
 */

/** 变量名归一：大小写、下划线、连字符、连续空格都不敏感 */
function normVarName(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[_\-\s]+/g, ' ')
    .trim();
}

const VAR_KEYS = new Map([
  ['composer', 'composer'],
  ['form', 'form'],
  ['number of the form', 'formNumber'],
  ['form number', 'formNumber'],
  ['formnumber', 'formNumber'],
  ['key', 'key'],
  ['opus number', 'opusNumber'],
  ['opus', 'opusNumber'],
  ['opusnumber', 'opusNumber'],
  ['movement number', 'movementNumber'],
  ['movement', 'movementNumber'],
  ['movementnumber', 'movementNumber'],
  ['sub type', 'subType'],
  ['subtype', 'subType'],
  // 旧名字保留为别名：用户自定义预设里可能还写着 %sub-form}，迁移期不能直接失效
  ['sub form', 'subType'],
  ['subform', 'subType'],
  ['tempo term', 'tempoTerm'],
  ['tempo', 'tempoTerm'],
  ['tempoterm', 'tempoTerm'],
]);

/** 变量积木：选项面板的图例、补全提示都从这里取，别再抄一份中文名 */
export const TEMPLATE_VARIABLES = [
  { key: 'composer', name: 'Composer', zh: '作曲家', en: 'Composer', ja: '作曲家' },
  { key: 'form', name: 'form', zh: '体裁', en: 'Form', ja: '楽種' },
  { key: 'formNumber', name: 'Number of the form', zh: '作品编号', en: 'No. of the form', ja: '番号' },
  { key: 'key', name: 'Key', zh: '调性', en: 'Key', ja: '調性' },
  { key: 'opusNumber', name: 'Opus Number', zh: '作品号', en: 'Opus number', ja: '作品番号' },
  { key: 'movementNumber', name: 'Movement Number', zh: '乐章序号', en: 'Movement number', ja: '楽章番号' },
  { key: 'subType', name: 'Sub-Type', zh: '子体裁', en: 'Sub-Type', ja: '細分類' },
  { key: 'tempoTerm', name: 'Tempo Term', zh: '速度术语', en: 'Tempo term', ja: '速度用語' },
];

export function templateVarKey(raw) {
  return VAR_KEYS.get(normVarName(raw)) ?? null;
}

/**
 * 切成「变量 / 普通文字」片段，供语法高亮直接渲染。
 * 变量片段带 `key`：认不出的 key 是 null，但仍然是变量样式 ——
 * 用户要能看见自己刚写了一个没被识别的名字。
 */
export function templateSegments(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /%([^%}\n]+)}/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), variable: false, key: null });
    out.push({ text: m[0], variable: true, key: templateVarKey(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last), variable: false, key: null });
  return out;
}

export function templateHasVars(text) {
  return /%([^%}\n]+)}/.test(String(text ?? ''));
}

/**
 * 变量消失后收拾残局：
 *   1. 只收「空变量留下的空位」，**不碰模板里字面的连续空格**
 *      （`第二乐章 \0 - 柔板` → `第二乐章 - 柔板`，而 `A   B` 仍是三格）；
 *   2. 标点前不留空格（`No.1 in , Op.2` → `No.1 in, Op.2`）；
 *   3. 被掏空之后悬在首尾的分隔符去掉（`第三乐章 小步舞曲 -` → `第三乐章 小步舞曲`）。
 *
 * 以前直接 `.replace(/\s+/g, ' ')`，用户想用空格在标题里对齐时会被吞掉；
 * 现在空变量先替换成哨兵字符，只塌缩哨兵两侧的空白。
 */
function tidy(s) {
  return String(s ?? '')
    .replace(/(?:\s*\u0000)+\s*/g, ' ')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .replace(/^[\s\-–—·]+/, '')
    .replace(/[\s,;:，；：\-–—·]+$/, '')
    .trim();
}

/**
 * 展开模板。`data` 的键是 `templateVarKey` 的返回值。
 * `fallback` 在整段都被省略时使用 —— 标题不能变成空串。
 */
export function expandTitleTemplate(text, data = {}, opts = {}) {
  const src = String(text ?? '');
  let touched = false;
  let hadValue = false;
  const out = src.replace(/%([^%}\n]+)}/g, (whole, raw) => {
    const key = templateVarKey(raw);
    if (!key) return whole;
    touched = true;
    const v = data?.[key];
    if (v == null || v === '') return '\u0000';
    hadValue = true;
    return String(v);
  });
  if (!touched) return src;
  // 一个值都没有：留下来的只可能是模板里的字面文字（`in` / 逗号 / 分隔符），
  // 拼出来像半句话。整段退回原文，至少用户能看出这是模板、去补数据。
  if (!hadValue) return String(opts?.fallback ?? src);
  const clean = tidy(out);
  return clean || String(opts?.fallback ?? src);
}
