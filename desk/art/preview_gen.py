#!/usr/bin/env python3
"""The Desk — art preview generator.

Draws 40x40 pixel-art desk scenes in the exact technical dialect of BrokerRenderer
(40x40 grid, crispEdges, row-RLE <rect> spans) so the on-chain port is mechanical.
Outputs one SVG per variant; the preview page embeds them.
"""
import json
import sys

W = H = 40


class Canvas:
    def __init__(self, bg):
        self.px = [[bg] * W for _ in range(H)]

    def put(self, x, y, c):
        if 0 <= x < W and 0 <= y < H:
            self.px[y][x] = c

    def rect(self, x0, y0, x1, y1, c):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.put(x, y, c)

    def svg(self):
        # row RLE, same shape the Solidity renderer emits
        parts = [
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" shape-rendering="crispEdges">'
        ]
        base = self.px[0][0]
        parts.append(f'<rect width="{W}" height="{H}" fill="{base}"/>')
        for y in range(H):
            x = 0
            while x < W:
                c = self.px[y][x]
                run = 1
                while x + run < W and self.px[y][x + run] == c:
                    run += 1
                if c != base:
                    parts.append(f'<rect x="{x}" y="{y}" width="{run}" height="1" fill="{c}"/>')
                x += run
        parts.append("</svg>")
        return "".join(parts)


# ---------- furniture ----------

def room(c, wall, floor, base):
    c.rect(0, 0, 39, 26, wall)
    c.rect(0, 26, 39, 26, base)     # baseboard
    c.rect(0, 27, 39, 39, floor)


def desk(c, wood):
    lite, mid, dark = wood
    c.rect(1, 22, 38, 22, lite)      # top edge highlight
    c.rect(1, 23, 38, 23, mid)       # tabletop
    c.rect(2, 24, 37, 31, mid)       # front panel
    c.rect(2, 24, 37, 24, dark)      # shadow under top
    c.rect(2, 28, 37, 28, dark)      # drawer split
    c.rect(8, 26, 9, 26, dark)       # drawer handles
    c.rect(30, 26, 31, 26, dark)
    c.rect(8, 30, 9, 30, dark)
    c.rect(30, 30, 31, 30, dark)
    c.rect(2, 31, 37, 31, dark)      # base shadow
    c.rect(3, 32, 5, 34, dark)       # feet
    c.rect(34, 32, 36, 34, dark)


def monitor(c, x, top, w, screen_h, up=True, screen="#0d1b2e", frame="#2b2f36"):
    """Monitor whose base sits on the tabletop (y=21)."""
    c.rect(x, top, x + w - 1, top + screen_h + 1, frame)
    c.rect(x + 1, top + 1, x + w - 2, top + screen_h, screen)
    # chart: little pixel polyline
    ch = "#43d17c" if up else "#e0564f"
    n = w - 4
    for i in range(n):
        frac = i / max(n - 1, 1)
        rise = int(frac * (screen_h - 3))
        y = (top + screen_h - 1 - rise) if up else (top + 2 + rise)
        c.put(x + 2 + i, y, ch)
        if i and abs(1) and i % 3 == 0:  # thicken occasional steps
            c.put(x + 2 + i, y + (1 if up else -1), ch)
    cx = x + w // 2
    c.rect(cx - 1, top + screen_h + 2, cx, 20, frame)   # stand
    c.rect(x + 2, 21, x + w - 3, 21, frame)             # base


def calculator(c, x, gold=False):
    body = "#f2c53d" if gold else "#b9bdc4"
    edge = "#a67c1a" if gold else "#7e838b"
    scr = "#1c2620"
    dig = "#43d17c"
    c.rect(x, 15, x + 6, 21, body)
    c.rect(x, 21, x + 6, 21, edge)
    c.rect(x + 1, 16, x + 5, 17, scr)
    c.rect(x + 2, 16, x + 2, 16, dig)
    c.rect(x + 4, 16, x + 5, 16, dig)
    for by in (19, 21):
        for bx in (x + 1, x + 3, x + 5):
            if by < 21:
                c.put(bx, by, edge)
    c.put(x + 1, 19, edge); c.put(x + 3, 19, edge); c.put(x + 5, 19, edge)
    c.put(x + 1, 20, body); c.put(x + 3, 20, body)
    if gold:
        c.put(x, 15, "#ffe98a")            # glint
        c.put(x + 6, 15, "#ffe98a")


def wall_frame(c, x, y, kind):
    """Framed art on the back wall. 9x9 gilded frame, 7x7 canvas."""
    gold_f, dark = "#c9a84e", "#141a24"
    c.rect(x, y, x + 8, y + 8, gold_f)
    c.rect(x + 1, y + 1, x + 7, y + 7, dark)
    if kind == "stonks":
        pts = [(1, 6), (2, 5), (3, 5), (4, 4), (5, 3), (6, 2)]
        for dx, dy in pts:
            c.put(x + dx, y + dy, "#43d17c")
        c.put(x + 6, y + 1, "#43d17c")     # arrowhead
        c.put(x + 5, y + 2, "#43d17c")
    elif kind == "ape":
        fur, face = "#6b4a33", "#c9a17c"
        c.rect(x + 2, y + 2, x + 6, y + 6, fur)       # head
        c.rect(x + 3, y + 4, x + 5, y + 6, face)      # muzzle
        c.put(x + 3, y + 3, face); c.put(x + 5, y + 3, face)  # brow shading
        c.put(x + 3, y + 3, "#1d232b"); c.put(x + 5, y + 3, "#1d232b")  # eyes
        c.rect(x + 3, y + 6, x + 5, y + 6, "#8a6a4d")  # mouth line
    c.rect(x + 1, y + 7, x + 7, y + 7, "#0e131b")      # inner shadow


def coffee(c, x, mug="#d9dee5"):
    c.rect(x, 18, x + 2, 21, mug)
    c.put(x + 3, 19, mug)
    c.put(x + 1, 18, "#5d4634")            # brew line
    c.put(x + 1, 16, "#c9cfd8")            # steam
    c.put(x + 2, 15, "#c9cfd8")


def plant(c, x, leaf="#3f9d5a", pot="#b0603c"):
    c.rect(x, 19, x + 3, 21, pot)
    c.rect(x, 19, x + 3, 19, "#8a4527")
    c.put(x + 1, 18, leaf); c.put(x + 2, 18, leaf)
    c.rect(x, 16, x + 1, 17, leaf)
    c.rect(x + 2, 15, x + 3, 17, leaf)
    c.put(x + 1, 14, "#57c274")
    c.put(x + 3, 14, "#2e7a44")


def lamp(c, x, shade="#caa84a", on=True):
    c.rect(x, 21, x + 2, 21, "#3a3d44")            # base
    c.rect(x + 1, 14, x + 1, 20, "#3a3d44")        # pole
    c.rect(x + 1, 13, x + 4, 13, shade)            # arm/shade
    c.rect(x + 2, 14, x + 4, 14, shade)
    if on:
        c.put(x + 3, 15, "#f5e6a8")
        c.put(x + 4, 15, "#f5e6a8")


def papers(c, x, pen="#e0564f"):
    c.rect(x, 20, x + 4, 21, "#e9ecef")
    c.rect(x, 20, x + 3, 20, "#f6f8fa")
    c.put(x + 1, 21, "#a9b0b8")
    c.put(x + 5, 21, pen)


def cat(c, x, fur="#e8933a", dark="#b56b21"):
    c.rect(x, 18, x + 4, 21, fur)                   # body
    c.rect(x + 3, 15, x + 4, 17, fur)               # head (slim)
    c.put(x + 3, 14, dark); c.put(x + 5, 14, dark)  # ears
    c.put(x + 5, 15, fur)                           # ear-side cheek
    c.put(x + 4, 16, "#1d232b")                     # eye
    c.put(x + 5, 17, "#e9ecef")                     # muzzle
    c.rect(x - 1, 17, x - 1, 21, dark)              # tail up
    c.put(x - 2, 16, dark)                          # tail tip
    c.rect(x, 21, x + 4, 21, dark)                  # paws shadow


# ---------- variants ----------

WOODS = {
    "walnut": ("#9a6b45", "#7d5334", "#5d3c24"),
    "oak": ("#c99a62", "#a87c4a", "#835d34"),
    "birch": ("#e0c9a2", "#c4ab82", "#9b845f"),
    "dark": ("#6b5140", "#4f3a2c", "#38281d"),
    "mahogany": ("#8a4a3a", "#6e372b", "#51261d"),
}

VARIANTS = []


def variant(name, wall, floor, wood, note):
    def deco(fn):
        VARIANTS.append((name, wall, floor, wood, note, fn))
        return fn
    return deco


@variant("Corner Office", "#33506b", "#26374a", "walnut", "çift ekran + kahve; klasik açılış")
def v1(c):
    monitor(c, 5, 9, 12, 9)
    monitor(c, 19, 12, 9, 6)
    coffee(c, 32)


@variant("The Analyst", "#2f6360", "#234a48", "oak", "tek büyük ekran + hesap makinesi + evrak")
def v2(c):
    monitor(c, 6, 8, 14, 10)
    calculator(c, 24)
    papers(c, 31, pen="#43d17c")
    wall_frame(c, 24, 4, "stonks")


@variant("Night Shift", "#23262d", "#191c22", "dark", "kırmızı grafik + yanan lamba; tek koyu tema")
def v3(c):
    monitor(c, 8, 9, 12, 9, up=False)
    monitor(c, 22, 12, 8, 6, up=False)
    lamp(c, 32, on=True)


@variant("Greenhouse", "#5d7a4d", "#485e3b", "oak", "bitki ağırlıklı; en yumuşak duvar")
def v4(c):
    monitor(c, 12, 10, 11, 8)
    plant(c, 5, leaf="#3f9d5a")
    plant(c, 30, leaf="#57c274", pot="#8f8f96")
    coffee(c, 25)


@variant("Old School", "#c9b58f", "#a5906c", "mahogany", "açık duvar + büyük hesap makinesi")
def v5(c):
    monitor(c, 6, 11, 10, 7)
    calculator(c, 20)
    papers(c, 29)
    coffee(c, 34, mug="#8a4a3a")
    wall_frame(c, 22, 2, "stonks")


@variant("Cat Desk", "#6b5a7d", "#524561", "walnut", "masa kedisi; topluluk favorisi adayı")
def v6(c):
    monitor(c, 5, 9, 12, 9)
    cat(c, 24)
    coffee(c, 33)
    wall_frame(c, 21, 4, "ape")


@variant("Gold Rush", "#a3814a", "#7f6438", "oak", "altın hesap makinesi; nadir trait adayı")
def v7(c):
    monitor(c, 6, 9, 12, 9)
    calculator(c, 23, gold=True)
    coffee(c, 33)
    wall_frame(c, 24, 3, "ape")


@variant("Minimal", "#7d838c", "#5f646c", "birch", "tek ekran + kahve; en sade kompozisyon")
def v8(c):
    monitor(c, 12, 10, 12, 8)
    coffee(c, 28)


@variant("War Room", "#6e3a3f", "#532b2f", "dark", "çift ekran + hesap makinesi + lamba; maksimalist")
def v9(c):
    # centering rule: no item may end past x=36 or hug the desk edge
    monitor(c, 3, 9, 11, 9)
    monitor(c, 15, 12, 8, 6)
    calculator(c, 24)
    lamp(c, 32, on=True)


def build():
    out = []
    for name, wall, floor, wood, note, fn in VARIANTS:
        c = Canvas(wall)
        room(c, wall, floor, "#1b1d22")
        desk(c, WOODS[wood])
        fn(c)
        out.append({"name": name, "note": note, "wood": wood, "svg": c.svg()})
    return out


if __name__ == "__main__":
    json.dump(build(), sys.stdout)
