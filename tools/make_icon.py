"""One-off icon generator for music-atlas. Renders a .ico (multi-size) + a preview PNG.

Kept in the repo because the icon is a build input, not a runtime dependency:
nothing in src/ imports PIL, and start.py only reads the finished assets/app.ico.
"""
import math
import os
import sys

from PIL import Image, ImageDraw

DESIGN = 1000          # design-space units; everything below is authored in this grid
SS = 4                 # supersample factor before the final downscale
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'assets')

GREEN_TOP = (66, 184, 131)     # Vue 绿 #42b883
GREEN_BOTTOM = (34, 122, 86)   # 压深一档，做成竖向渐变


def bez(p0, p1, p2, n=72):
    """Quadratic bezier sampled into a polyline."""
    out = []
    for i in range(n):
        t = i / (n - 1)
        u = 1 - t
        out.append((u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]))
    return out


def rotated_ellipse(cx, cy, rx, ry, deg):
    """Ellipse as a polygon so it can be rotated before rasterising."""
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    pts = []
    for i in range(160):
        th = 2 * math.pi * i / 160
        x, y = rx * math.cos(th), ry * math.sin(th)
        pts.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
    return pts


def note_polygon():
    """An eighth note: head + stem + flag, as a single filled path."""
    # stem (right edge at x=520 so the flag can land on it)
    stem = [(452, 268), (520, 268), (520, 762), (452, 762)]
    head = rotated_ellipse(352, 742, 186, 132, -18)
    # flag: out along the outer curve, back along the inner one
    outer = bez((520, 268), (812, 316), (660, 556))
    inner = bez((660, 556), (700, 348), (520, 486))
    return [head, stem, outer + inner]


def render(size):
    S = size * SS
    k = S / DESIGN
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # background: rounded square with a vertical gradient, drawn mask-then-fill
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(196 * k), fill=255)
    grad = Image.new('RGBA', (S, S))
    gp = grad.load()
    for y in range(S):
        t = y / max(1, S - 1)
        col = tuple(round(GREEN_TOP[i] + (GREEN_BOTTOM[i] - GREEN_TOP[i]) * t) for i in range(3))
        for x in range(S):
            gp[x, y] = col + (255,)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # faint grid hint (the app is an analysis grid, after all)
    for i in range(1, 4):
        x = S * i / 4
        y = S * i / 4
        d.line([(x, 0), (x, S)], fill=(255, 255, 255, 26), width=max(1, int(2 * k)))
        d.line([(0, y), (S, y)], fill=(255, 255, 255, 26), width=max(1, int(2 * k)))

    # the note
    for poly in note_polygon():
        d.polygon([(x * k, y * k) for x, y in poly], fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [render(s) for s in sizes]
    os.makedirs(OUT_DIR, exist_ok=True)
    ico = os.path.join(OUT_DIR, 'app.ico')
    frames[-1].save(ico, format='ICO', sizes=[(s, s) for s in sizes])
    frames[-1].save(os.path.join(OUT_DIR, 'app-icon-preview.png'), format='PNG')

    # contact sheet so every size can be eyeballed at once
    sheet = Image.new('RGBA', (640, 300), (24, 24, 23, 255))
    x = 16
    for s, f in zip(sizes, frames):
        sheet.alpha_composite(f, (x, 24))
        x += s + 22
    sheet.alpha_composite(frames[-1].resize((128, 128), Image.LANCZOS), (16, 150))
    sheet.save(os.path.join(OUT_DIR, 'app-icon-sizes.png'), format='PNG')
    print('wrote', ico, os.path.getsize(ico), 'bytes')


if __name__ == '__main__':
    sys.exit(main())