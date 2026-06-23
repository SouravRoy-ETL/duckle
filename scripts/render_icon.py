"""Render the Duckle app icon: the three-dots pipeline mark, maximised on a black tile.

Draws the mark directly with Pillow (3 rounded-square nodes + 2 connecting edges) -
NO Chrome/HTML, so there is never a baked-in scrollbar artifact. Run from repo root:

    python scripts/render_icon.py
    cargo tauri icon apps/desktop/icons/icon-source.png   # from apps/desktop
"""

from PIL import Image, ImageDraw

S = 1024                              # output size
SS = 2                                # supersample for smooth edges
W = S * SS
TILE = (0x0A, 0x0B, 0x0F, 255)        # full black ground
OUT = "apps/desktop/icons/icon-source.png"

# Mark geometry in a 64-unit box (matches DuckleLogo.tsx + the SVG mark).
NODES = [(5, 7, (0xF6, 0xBA, 0x78)), (23, 23, (0xEA, 0x7E, 0x42)), (41, 39, (0xD9, 0x74, 0x2F))]
EDGES = [(14, 16, 32, 32), (32, 32, 50, 48)]


def render_mark(px):
    """The three-dots mark, drawn in a px-box and trimmed to its ink."""
    k = px / 64.0
    m = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    for x1, y1, x2, y2 in EDGES:
        d.line([x1 * k, y1 * k, x2 * k, y2 * k], fill=(0xEA, 0x7E, 0x42, 255), width=int(3.4 * k))
    for x, y, c in NODES:
        d.rounded_rectangle([x * k, y * k, (x + 18) * k, (y + 18) * k], radius=5.5 * k, fill=c + (255,))
    return m.crop(m.getbbox())


def main():
    tile = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(0.18 * W), fill=TILE)

    mark = render_mark(W)
    target = int(0.88 * W)            # maximise: fill the icon, minimal padding
    scale = target / max(mark.size)
    mark = mark.resize((round(mark.width * scale), round(mark.height * scale)), Image.LANCZOS)
    tile.alpha_composite(mark, ((W - mark.width) // 2, (W - mark.height) // 2))

    tile = tile.resize((S, S), Image.LANCZOS)
    tile.save(OUT)
    print("wrote", OUT, tile.size)

    # Also refresh the standalone transparent mark assets (kept clean, no Chrome).
    flat = render_mark(2048).resize((1024, 1024), Image.LANCZOS)
    flat = flat.crop(flat.getbbox())
    for f in ("docs/assets/duckle-mark.png", "website/assets/img/duckle-mark.png",
              "frontend/src/workflow-ui/duckle-mark.png", "apps/desktop/icons/icon-mark.png"):
        flat.save(f)
    print("refreshed mark assets", flat.size)


if __name__ == "__main__":
    main()
