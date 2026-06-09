"""Render the Duckle "D." logo to a high-res PNG for `tauri icon`.

Reproduces docs/assets/duckle-logo-dark.svg (a slate disc with the brand-yellow
"D" half-disc and dot) as a 1024x1024 source image with a transparent
background. Shapes are drawn at 4x and downscaled with LANCZOS for smooth,
anti-aliased edges. Run from the repo root, then regenerate the icon set:

    python scripts/render_icon.py
    cargo tauri icon apps/desktop/icons/icon-source.png   # from apps/desktop
"""

from PIL import Image, ImageDraw

S = 1024            # output size
SS = 4              # supersample factor
W = S * SS          # working size
VB = 256            # SVG viewBox units
K = W / VB          # working-units per viewBox-unit

DISC = (0x1B, 0x1F, 0x2A, 255)   # slate disc
GLYPH = (0xFF, 0xD0, 0x00, 255)  # brand yellow
RING = (255, 255, 255, 31)       # ~0.12 white edge


def main():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Disc: cx=128 cy=128 r=120, with a faint ring so the edge reads on any bg.
    cx, cy, r = 128 * K, 128 * K, 120 * K
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=DISC)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING, width=round(1.5 * K))

    # "D": a half-disc (right semicircle) with the flat edge on x=56, r=74.
    dcx, dcy, dr = 56 * K, 128 * K, 74 * K
    draw.pieslice([dcx - dr, dcy - dr, dcx + dr, dcy + dr], start=-90, end=90, fill=GLYPH)

    # The dot: cx=173 cy=128 r=27.
    ox, oy, orr = 173 * K, 128 * K, 27 * K
    draw.ellipse([ox - orr, oy - orr, ox + orr, oy + orr], fill=GLYPH)

    img = img.resize((S, S), Image.LANCZOS)
    out = "apps/desktop/icons/icon-source.png"
    img.save(out)
    print("wrote", out, img.size)


if __name__ == "__main__":
    main()
