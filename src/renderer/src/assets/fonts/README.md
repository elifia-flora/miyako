# 变音记号字体（`AtlasMusic.woff2`）

5 KB，只含五个码位：

| 码位 | 字符 | 名称 |
|---|---|---|
| U+266D | ♭ | MUSIC FLAT SIGN（降号） |
| U+266E | ♮ | MUSIC NATURAL SIGN（还原号） |
| U+266F | ♯ | MUSIC SHARP SIGN（升号） |
| U+1D12A | 𝄪 | MUSICAL SYMBOL DOUBLE SHARP（重升） |
| U+1D12B | 𝄫 | MUSICAL SYMBOL DOUBLE FLAT（重降） |

## 它从哪来

子集自 **Bravura**（Steinberg Media Technologies GmbH 的 SMuFL 参考字体），
`redist/woff/Bravura.woff2`，版本 1.482，**SIL Open Font License 1.1**（全文见 `OFL.txt`）。

**为什么不用系统字体**：这几个字符在中文字体（微软雅黑 / Noto Sans SC / 苹方）里是按
**全角**画的——降号宽近 1em、又胖又圆，跟 `Cmaj7` 排在一起像换了个字号。而「谁先命中」
取决于用户浏览器的默认字体设置（Chrome 装 Noto Sans SC、Vivaldi 装微软雅黑，
同一段 CSS 出来的降号就不是一个样子）。捆一个自己的字体，跨平台才一致。

## 为什么家族名不叫 Bravura

Bravura 的 OFL 带**保留字体名（Reserved Font Name）**：

> Copyright © 2026, Steinberg Media Technologies GmbH, with Reserved Font Name "Bravura".

OFL 规定：**修改版**（子集也算修改）不得继续使用保留名，必须改名。所以这里的家族名是
`Atlas Music`，PostScript 名 `AtlasMusic`，UniqueID 也换过了。
版权声明与许可证（name ID 0 / 13 / 14）原样保留，`OFL.txt` 随字体一起分发。

这不影响商用：OFL 1.1 允许随软件一起分发、允许修改，只要求改名 + 保留许可证。

## 还改了什么

- **行高度量**：Bravura 的 `hhea`/`OS/2` 是 ±2.012em（按五线谱行距设计）。
  直接拿来排文字，一行 `Cmaj7♭9` 的行盒会变成四倍高。子集里改成
  ascent 800 / descent -350 / lineGap 0，并置 `USE_TYPO_METRICS`。
- **重升 𝄪 放大 2.2 倍**：Bravura 在 U+1D12A 上给的是 0.25em 的小 ×（按「五线谱上的
  音符级」设计的），和 ♯ 的 0.70em 放一起只有三分之一高，`C𝄪7` 会读成「C × 7」。
  放大后 0.55em，和 ♭(0.65) / ♯(0.74) 成为一套。
- **底边对齐基线**：Bravura 的变音记号是按「五线谱行间」画的，♭ 的墨迹从 -0.175em
  一直到 0.439em —— 近 20% 沉在基线以下，排正文像下标。现在统一上移到
  `TARGET_BOTTOM = -0.02em`，五个记号的底边都落在基线附近。
- **字宽要减 `nominalWidthX`（331）**：Type2 charstring 里存的是相对值，
  `T2CharStringPen` 会原样写出你给的数。不减的话 ♭ 会变成 0.57em 宽（字形对、位置对，
  就是莫名变胖），而且**不会报错**。
- 去掉 hinting、desubroutinize、只留 `.notdef` + 5 个字形 + 空格。

最终五个记号的量（单位 em）：

| 码位 | 高 (em) | 宽 (em) | 备注 |
|---|---|---|---|
| ♭ U+266D | 0.65 | 0.24 | 中文全角约 1.0 |
| ♮ U+266E | 0.72 | 0.18 | |
| ♯ U+266F | 0.74 | 0.26 | |
| 𝄪 U+1D12A | 0.55 | 0.54 | 已放大 2.2× |
| 𝄫 U+1D12B | 0.65 | 0.44 | |

五个的底边都在 y = -0.02em。

## 怎么重新生成

```bash
python tools/fonts/build-music-font.py Bravura.woff2 src/renderer/src/assets/fonts/AtlasMusic.woff2
```

需要 `pip install fonttools brotli`。改字符集就改脚本里的 `UNICODES`。

## 用法

`styles/tokens.css` 里 `@font-face` 声明了 `unicode-range: U+266D-266F, U+1D12A-1D12B`，
并把它排在 `--font-ui` / `--font-mono` 的**第一位**：它只认这五个码位，
其余字符自动往后面的字体栈落。canvas 画和弦（`GridEditor.chordFont`）读的是
`body` 的计算字体，所以也自动带上。
