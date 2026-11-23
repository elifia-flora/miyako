/**
 * progression.js — 和弦进行识别（纯函数：主进程、渲染层、单测都能直接用）
 *
 * 默认只看**级数序列**：转位、低音、大小写、七音都不参与比对 ——
 * 用户要的是「4-5-3-6 不管写成 IV V iii vi 还是 4 5 3 6 都算王道进行」。
 * 需要区分的模式可以加 `dominant7At`（丸之内要求 III 是属七，调内 iii7 不算）。
 *
 * 名字（王道进行 / 万能和弦进行 / 丸之内进行）不写在这里：这里是数据，翻译交给 i18n，
 * 返回的 `key` 就是词典键，界面自己 t() 一下。
 */

/** 从短到长排好；`lastDominant7` 表示「最后一条必须是 1 级属七（大小七）和弦」 */
export const PROGRESSIONS = [
  { id: 'oudo', degrees: [4, 5, 3, 6] },
  { id: 'omni', degrees: [4, 5, 3, 6, 2, 5, 1] },
  { id: 'omniMinorVariant', degrees: [4, 5, 3, 6, 2, 5, 1, 1], lastDominant7: true },
  /**
   * 丸之内进行（丸サ進行 / Marunouchi progression）：
   *   IVM7 – III7 – VIm7 – I7        （《丸の内サディスティック》的四和弦版）
   *   IVM7 – III7 – VIm7 – Vm7 – I7  （Just the Two of Us / 完整版）
   *
   * `dominant7At` 是这条进行与普通「4-3-6-1」的分水岭：III 必须是**属七**（大三 + 小七），
   * 而不是调内的 iii7（小三 + 小七）。只看级数会把 `IVm7 – iii7 – vi7 – I7` 也误认成丸之内。
   */
  { id: 'marunouchi', degrees: [4, 3, 6, 1], dominant7At: [1] },
  { id: 'marunouchiFull', degrees: [4, 3, 6, 5, 1], dominant7At: [1] },
];

/**
 * @param {{degree:number, dominant7?:boolean}[]} items 按 tick 升序的级数序列
 * @returns {null | {id:string, key:string, degrees:number[]}}
 */
export function matchProgression(items) {
  const list = (items ?? []).filter((x) => x && Number(x.degree) >= 1 && Number(x.degree) <= 7);
  if (list.length < 4) return null;

  // 长模式优先：45362511 的前七条正好也是 4536251，长度不等就能分开，这里再保险一次
  const byLen = [...PROGRESSIONS].sort((a, b) => b.degrees.length - a.degrees.length);
  for (const p of byLen) {
    if (list.length !== p.degrees.length) continue;
    if (!p.degrees.every((d, i) => Number(list[i].degree) === d)) continue;
    if (p.lastDominant7 && list[list.length - 1].dominant7 !== true) continue;
    if (p.dominant7At && !p.dominant7At.every((i) => list[i]?.dominant7 === true)) continue;
    return { id: p.id, key: `prog.${p.id}`, degrees: [...p.degrees] };
  }
  return null;
}
