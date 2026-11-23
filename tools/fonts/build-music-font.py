#!/usr/bin/env python3
"""从 Bravura 生成「只含变音记号」的 woff2 子集。

用法：
    pip install fonttools brotli
    python tools/fonts/build-music-font.py Bravura.woff2 \
        src/renderer/src/assets/fonts/AtlasMusic.woff2

为什么要改名：Bravura 的 OFL 带**保留字体名**（Reserved Font Name "Bravura"），
OFL 规定修改版不得继续使用该名字。子集属于修改，所以家族名换成 `Atlas Music`。
版权与许可证条目（name ID 0 / 13 / 14）原样保留，`OFL.txt` 随字体分发。

为什么要改行高度量：Bravura 的 hhea/OS/2 是 ±2.012em（按五线谱行距设计），
直接排文字会把行盒撑成四倍高。这里压成 800 / -350（文本量级）并置 USE_TYPO_METRICS。
"""

import os
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

# 变音记号：♭ ♮ ♯ 𝄪 𝄫（外加空格，免得 subset 顺手把 word-space 也丢掉）
UNICODES = [0x20, 0x266D, 0x266E, 0x266F, 0x1D12A, 0x1D12B]

FAMILY = "Atlas Music"
PSNAME = "AtlasMusic"
UNIQUE = "1.482;ATLAS;AtlasMusic-Subset"

ASCENT = 800
DESCENT = -350

# 逐字缩放 + 统一底线。
#
# **重升（U+1D12A）必须放大**：Bravura 在这个码位上给的是一个 0.25em 的小 ×
# （它按「五线谱上的音符级」设计），和 ♯ 的 0.70em 摆在一起只有三分之一高，
# `C𝄪7` 会变成「C × 7」。放 2.2 倍后 0.55em，和 ♭(0.61) / ♯(0.70) 成为一套。
#
# **还要整体上移**：Bravura 把变音记号画在「五线谱的行间」坐标系里，♭ 的墨迹是
# y ∈ [-0.175, 0.439] —— 将近 20% 沉在基线以下。排正文时它看起来像下标。
# `TARGET_BOTTOM` 把每个记号的底边对齐到基线下方 0.02em（留一点点视觉余量），
# 剩下的字（♮ / ♯）也就不再「半个身子在基线下面」。
TARGET_BOTTOM = -0.02  # em
GLYPH_SCALE = {
    0x266D: 1.06,  # ♭ 略带一点点放大（用户：原来「有那么一点点小」）
    0x266E: 1.06,  # ♮
    0x266F: 1.06,  # ♯
    0x1D12A: 2.2,  # 𝄪
    0x1D12B: 1.06,  # 𝄫
}


def tweak_glyphs(font: TTFont) -> None:
    """按 GLYPH_SCALE 缩放、并把底边对齐到 TARGET_BOTTOM（连同 advance 一起改）。"""
    if not GLYPH_SCALE:
        return
    upm = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    top = font["CFF "].cff.topDictIndex[0]
    charstrings = top.CharStrings
    # Type2 的 charstring 里，字宽是**相对 nominalWidthX 的差值**（Bravura 是 331）。
    # `T2CharStringPen` 会把这个数原样塞进程序，所以这里要先减掉 —— 否则字形没坏，
    # 只是宽了 0.33em（♭ 会占 0.57em，比原文还胖，看起来像没生效）。
    nominal = getattr(top.Private, "nominalWidthX", 0) or 0
    for cp, k in GLYPH_SCALE.items():
        name = cmap.get(cp)
        if not name:
            continue
        # 先量原始底边：缩放后的底边 = y0 * k，再据此算竖直位移
        bounds_pen = BoundsPen(glyph_set)
        glyph_set[name].draw(bounds_pen)
        y0 = (bounds_pen.bounds[1] if bounds_pen.bounds else 0) * k
        # TARGET_BOTTOM = None 表示只缩放、不上移（调参时用得到）
        dy = 0 if TARGET_BOTTOM is None else TARGET_BOTTOM * upm - y0

        advance = font["hmtx"][name][0]
        pen = T2CharStringPen(round(advance * k) - nominal, glyph_set)
        glyph_set[name].draw(TransformPen(pen, (k, 0, 0, k, 0, dy)))
        # private / globalSubrs 必须带上：新建的 CharString 没有这两个，存盘时会在
        # recalcFontBBox 里炸「'NoneType' object has no attribute 'nominalWidthX'」
        charstrings[name] = pen.getCharString(
            private=top.Private, globalSubrs=charstrings.globalSubrs
        )
        font["hmtx"][name] = (round(advance * k), 0)


def build(src: str, dst: str) -> None:
    font = TTFont(src)

    opts = Options()
    opts.layout_features = []
    opts.name_IDs = ["*"]          # 保留版权 / 许可证 / 商标条目（OFL 要求）
    opts.name_legacy = True
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.drop_tables += ["DSIG"]
    opts.desubroutinize = True
    opts.hinting = False
    subsetter = Subsetter(options=opts)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)

    name = font["name"]

    def rename(name_id: int, value: str) -> None:
        name.setName(value, name_id, 3, 1, 0x409)  # Windows / Unicode BMP / en-US
        name.setName(value, name_id, 1, 0, 0)      # Mac / Roman / English

    rename(1, FAMILY)   # Family
    rename(3, UNIQUE)   # Unique ID（原值里有 Bravura，必须换）
    rename(4, FAMILY)   # Full name
    rename(6, PSNAME)   # PostScript name
    rename(16, FAMILY)  # Typographic family
    rename(17, "Regular")

    tweak_glyphs(font)

    font["hhea"].ascent = ASCENT
    font["hhea"].descent = DESCENT
    font["hhea"].lineGap = 0
    os2 = font["OS/2"]
    os2.sTypoAscender = ASCENT
    os2.sTypoDescender = DESCENT
    os2.sTypoLineGap = 0
    os2.usWinAscent = ASCENT
    os2.usWinDescent = -DESCENT
    os2.fsSelection |= 1 << 7  # USE_TYPO_METRICS

    font.flavor = "woff2"
    font.save(dst)
    print(f"{dst}  {os.path.getsize(dst)} bytes  family={FAMILY}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    build(sys.argv[1], sys.argv[2])
