/**
 * 文本归一化：**补全/判等的唯一口径**。
 *
 * 主进程（词表 alias 索引、`tags:suggest`）与渲染层（判断「采纳候选会不会改变文本」）
 * 必须用同一份实现 —— 各写一份的话，「输入等于候选」这个判断会在全角括号、首尾顿号
 * 这些边角上忽真忽假，而两边都不会报错，只会偶发地「回车把字换掉了」。
 *
 * 注意：`src/main/ipc/search.ts` 与 `src/renderer/src/vocabLabels.ts` 里各有一份
 * 更宽松的局部 norm，它们服务于搜索 / 标签反查，规则不同是有意的，**不要合并**。
 */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,·、:：]+|[\s,·、:：]+$/g, '')
    .trim();
}

/** 归一化后是否同一个词。空串永远不相等（「没输入」不能算「匹配到了空标签」）。 */
export function sameText(a, b) {
  const x = norm(a);
  return x !== '' && x === norm(b);
}
