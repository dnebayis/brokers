#!/usr/bin/env python3
"""The Desk — axis-driven scene composer.

preview_gen.py holds the furniture primitives and nine hand-composed showcase scenes;
THIS file is the real renderer: it reads a row from traits-2000.json (7 axis indices)
and composes the scene deterministically. The Solidity DeskRenderer is a mechanical
port of compose() below, so every layout rule lives here once, in the reference.

Layout contract (mirrors the on-chain port):
  - monitors centered by screen axis; nothing may end past x=36 (edge rule from War Room)
  - gadget slot at x=24, companion slot at x=31; a cat with no gadget moves to x=24
  - accent colors the small items only: mug glaze, plant pot, pen, drawer handles
"""
import json
import sys

from preview_gen import (
    Canvas, room, desk, monitor, calculator, papers, coffee, plant, lamp, cat, WOODS,
)

# wall option -> (wall, floor); hexes lifted from the approved showcase variants
WALLS = {
    "navy": ("#33506b", "#26374a"),
    "teal": ("#2f6360", "#234a48"),
    "sage": ("#5d7a4d", "#485e3b"),
    "cream": ("#c9b58f", "#a5906c"),
    "lavender": ("#6b5a7d", "#524561"),
    "grey": ("#7d838c", "#5f646c"),
    "sand": ("#a3814a", "#7f6438"),
    "burgundy": ("#6e3a3f", "#532b2f"),
    "midnight": ("#23262d", "#191c22"),
}

# accent option -> item color (mug glaze / plant pot / pen / drawer handles)
ACCENTS = {
    "crimson": "#c94a42",
    "forest": "#3f9d5a",
    "azure": "#4a7fc9",
    "amber": "#d9a83f",
    "violet": "#8a6fc0",
    "mono": "#8b9099",
}

AXES = None  # loaded from traits-2000.json so names stay single-sourced


def load_table(path):
    global AXES
    with open(path) as f:
        table = json.load(f)
    AXES = table["axes"]
    return table


def axis_option(axis_index, option_index):
    return AXES[axis_index]["options"][option_index]


def compose(traits):
    """traits: 7 axis indices in table order (wall, wood, screens, chart, gadget,
    companion, accent). Returns the finished Canvas."""
    wall_o = axis_option(0, traits[0])
    wood_o = axis_option(1, traits[1])
    screens_o = axis_option(2, traits[2])
    chart_o = axis_option(3, traits[3])
    gadget_o = axis_option(4, traits[4])
    comp_o = axis_option(5, traits[5])
    accent_o = axis_option(6, traits[6])

    wall, floor = WALLS[wall_o]
    accent = ACCENTS[accent_o]
    up = chart_o == "green-up"

    c = Canvas(wall)
    room(c, wall, floor, "#1b1d22")
    desk(c, WOODS[wood_o])
    # accent drawer handles over the wood-dark defaults
    for hx in (8, 30):
        c.rect(hx, 26, hx + 1, 26, accent)
        c.rect(hx, 30, hx + 1, 30, accent)

    # screens (centered; dual pairs a big and a small like Corner Office)
    if screens_o == "single-large":
        monitor(c, 5, 8, 14, 10, up=up)
    elif screens_o == "dual":
        monitor(c, 4, 9, 12, 9, up=up)
        monitor(c, 17, 12, 9, 6, up=up)
    else:  # single-small
        monitor(c, 8, 11, 10, 7, up=up)

    # gadget slot
    if gadget_o == "calculator":
        calculator(c, 24)
    elif gadget_o == "gold-calculator":
        calculator(c, 24, gold=True)
    elif gadget_o == "papers":
        papers(c, 24, pen=accent)

    # companion slot (cat claims the gadget slot when it is free — it needs the room)
    if comp_o == "coffee":
        coffee(c, 32, mug=accent)
    elif comp_o == "plant":
        plant(c, 31, pot=accent)
    elif comp_o == "lamp":
        lamp(c, 32, on=True)
    elif comp_o == "cat":
        cat(c, 24 if gadget_o == "none" else 31)

    return c


def render_ids(table, ids):
    out = []
    for i in ids:
        traits = table["assignments"][str(i)]
        c = compose(traits)
        names = [axis_option(a, v) for a, v in enumerate(traits)]
        out.append({"id": i, "traits": names, "svg": c.svg()})
    return out


if __name__ == "__main__":
    table = load_table(sys.argv[1] if len(sys.argv) > 1 else "traits-2000.json")
    ids = [int(x) for x in sys.argv[2:]] or list(range(1, 17))
    json.dump(render_ids(table, ids), sys.stdout)
