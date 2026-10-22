#!/usr/bin/env python3
"""Genera le icone di Quetza (serve Pillow): uno Quetzalcoatlus in volo in
pixel art 8 bit su fondo bianco, nello stesso stile dell'icona di MIMUS.
Scrive backend/public/icons/*.png e il simbolo SVG usato nell'app.
Uso: python3 docs/make-icon.py"""
import os
from PIL import Image, ImageDraw, ImageFilter

# Quetzalcoatlus che vola verso destra: ala alzata, cresta, becco lungo (X = pixel)
QUETZA = """
.XX...........................................
..XXX.........................................
...XXX........................................
....XXXXX.....................XX..............
.....XXXXX....................XXX.............
.......XXXXXX..................XXXX...........
........XXXXXXX.................XXXXXX........
.........XXXXXXXX...............XXXXXXX.......
..........XXXXXXXX..............XX.XXXXXXXXXXX
...........XXXXXXXXX............XXXXXXXXXXX...
............XXXXXXXXX..........XXXXXX.........
.............XXXXXXXXX........XXX.............
.............XXXXXXXXXX......XXX..............
..............XXXXXXXXXX....XXX...............
..............XXXXXXXXXXX..XXX................
.............XXXXXXXXXXXXXXXX.................
...........XXXXXXXXXXXXXXXXX..................
............XXXXXXXXXXXXXX....................
..........XX...XXXXXXXX.......................
........XXX...XX..............................
......XXX...XXX...............................
"""

ROWS = QUETZA.strip("\n").split("\n")
W, H = max(len(r) for r in ROWS), len(ROWS)
INK = (29, 29, 31, 255)
LINE = (29, 29, 31, 110)
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "backend", "public", "icons")


def draw_sprite(d, ox, oy, px):
    for y, r in enumerate(ROWS):
        for x, c in enumerate(r):
            if c == "X":
                d.rectangle((ox + x * px, oy + y * px, ox + (x + 1) * px - 1, oy + (y + 1) * px - 1), fill=INK)
    # riga tratteggiata, come il terreno di MIMUS: qui è la riga del quaderno
    gy = oy + (H + 3) * px
    for x in range(0, W, 3):
        d.rectangle((ox + x * px, gy, ox + (x + 2) * px - 1, gy + px // 2 - 1), fill=LINE)


def sprite_box(px):
    return W * px, (H + 4) * px


def icon(S=1024, rounded=True, px=16):
    """rounded=True: tessera con angoli arrotondati e ombra (icona "any").
    rounded=False: quadrato pieno (maskable / apple-touch, li ritaglia il sistema)."""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0) if rounded else (255, 255, 255, 255))
    d = ImageDraw.Draw(img)
    if rounded:
        k = S / 1024
        sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle((100 * k, 116 * k, 924 * k, 940 * k), 185 * k, fill=(0, 0, 0, 70))
        img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(16 * k)))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((100 * k, 100 * k, 924 * k, 924 * k), 185 * k, fill=(255, 255, 255, 255),
                            outline=(222, 222, 226, 255), width=max(1, round(3 * k)))
    w, h = sprite_box(px)
    draw_sprite(d, (S - w) // 2, (S - h) // 2, px)
    return img


def svg_symbol():
    """Lo stesso disegno in SVG, colore = currentColor (segue il tema dell'app)."""
    rects = []
    for y, r in enumerate(ROWS):
        x = 0
        while x < len(r):
            if r[x] == "X":
                s = x
                while x < len(r) and r[x] == "X":
                    x += 1
                rects.append(f"M{s} {y}h{x - s}v1h-{x - s}z")
            else:
                x += 1
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">'
            f'<path fill="currentColor" d="{"".join(rects)}"/></svg>')


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(HERE, "img"), exist_ok=True)
    big = icon()
    big.save(os.path.join(HERE, "img", "icon.png"))
    big.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon-512.png"))
    big.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))
    big.resize((64, 64), Image.LANCZOS).save(os.path.join(OUT, "favicon.png"))
    # maskable: il disegno deve stare nell'80% centrale
    icon(512, rounded=False, px=7).save(os.path.join(OUT, "icon-maskable-512.png"))
    icon(180, rounded=False, px=3).convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"))
    open(os.path.join(OUT, "quetza.svg"), "w").write(svg_symbol() + "\n")
    print("ok")
