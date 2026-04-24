#!/usr/bin/env python3
"""Regenerate the Remote Typer icons (16/48/128 px).

Icon concept: classic "two stacked documents" copy-paste metaphor, on a
rounded blue square background that matches the popup accent color.

Run with: python3 icons/build_icons.py
"""
from PIL import Image, ImageDraw
from pathlib import Path

ACCENT = (79, 140, 255, 255)       # #4f8cff
WHITE  = (255, 255, 255, 255)
LINE   = (79, 140, 255, 255)       # text lines on front doc (match accent)

OUT = Path(__file__).resolve().parent


def rounded_rect(draw, box, radius, fill=None, outline=None, width=1):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius,
                           fill=fill, outline=outline, width=width)


def render(size: int) -> Image.Image:
    # Render at 4x supersampling then downscale for crisp edges.
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background rounded square
    bg_radius = int(S * 0.22)
    rounded_rect(d, (0, 0, S - 1, S - 1), bg_radius, fill=ACCENT)

    # Back document: outlined only, offset up-right
    doc_w = int(S * 0.46)
    doc_h = int(S * 0.58)
    back_x = int(S * 0.32)
    back_y = int(S * 0.14)
    stroke = max(2, int(S * 0.035))
    doc_radius = int(S * 0.06)
    rounded_rect(
        d,
        (back_x, back_y, back_x + doc_w, back_y + doc_h),
        doc_radius,
        fill=None,
        outline=WHITE,
        width=stroke,
    )

    # Front document: filled, offset down-left — overlaps the back one.
    front_x = int(S * 0.18)
    front_y = int(S * 0.26)
    rounded_rect(
        d,
        (front_x, front_y, front_x + doc_w, front_y + doc_h),
        doc_radius,
        fill=WHITE,
    )

    # Text lines on the front document
    line_margin = int(S * 0.04)
    line_h = max(1, int(S * 0.04))
    line_gap = int(S * 0.08)
    lx0 = front_x + line_margin + int(S * 0.04)
    lx1 = front_x + doc_w - line_margin - int(S * 0.04)
    ly = front_y + int(S * 0.14)
    line_widths = [1.0, 0.7, 0.85]  # varied widths = "text"
    for w in line_widths:
        end = lx0 + int((lx1 - lx0) * w)
        rounded_rect(
            d,
            (lx0, ly, end, ly + line_h),
            line_h // 2,
            fill=LINE,
        )
        ly += line_gap

    # Downscale with LANCZOS for crispness
    return img.resize((size, size), Image.LANCZOS)


def main():
    for size in (16, 48, 128):
        img = render(size)
        path = OUT / f"icon{size}.png"
        img.save(path, "PNG")
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
