#!/usr/bin/env python3
"""Genera los iconos de la app desde la MISMA geometría que `ChaskiMark` (src/presentation/ui.tsx).

Por qué un script y no unos PNG sueltos: los binarios sin procedencia no se pueden revisar ni
regenerar. Acá la fuente de verdad es la geometría de abajo, que es copia literal del `<svg>` de la
marca. Si la marca cambia, se cambia acá y se vuelve a correr.

    python3 scripts/generate-icons.py

Requiere Pillow. Escribe en public/: favicon.ico, icon-192.png, icon-512.png, apple-touch-icon.png.
"""

from pathlib import Path

from PIL import Image, ImageDraw

# ── Geometría de ChaskiMark, viewBox 0 0 40 40 ────────────────────────────────────────────────
VB = 40.0
BG = "#17130F"  # tinta
PATH_COLOR = "#FBFAF7"  # papel
KNOT_COLOR = "#CB2A54"  # cochinilla
CORNER_R = 10.0
STROKE_W = 2.2
# Qhapaq Ñan: camino escalonado andino.
PATH_PTS = [(7, 27), (7, 23), (11, 23), (11, 19), (15, 19), (15, 15), (19, 15)]
KNOT_C = (27.0, 15.0)
KNOT_R = 5.2
KNOT_HOLE_R = 1.8

SS = 8  # supersampling: dibujamos grande y reducimos, que es el antialiasing del pobre y alcanza.
OUT = Path(__file__).resolve().parent.parent / "public"


def render(size: int) -> Image.Image:
    n = size * SS
    k = n / VB  # escala viewBox -> pixeles
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=CORNER_R * k, fill=BG)

    # Cada segmento es axis-aligned, así que un rectángulo extendido w/2 en las dos puntas
    # reproduce a la vez el `strokeLinecap="square"` y el miter join de las esquinas.
    half = (STROKE_W * k) / 2
    for (x0, y0), (x1, y1) in zip(PATH_PTS, PATH_PTS[1:]):
        ax, ay, bx, by = x0 * k, y0 * k, x1 * k, y1 * k
        d.rectangle(
            [min(ax, bx) - half, min(ay, by) - half, max(ax, bx) + half, max(ay, by) + half],
            fill=PATH_COLOR,
        )

    cx, cy = KNOT_C[0] * k, KNOT_C[1] * k
    for r, color in ((KNOT_R * k, KNOT_COLOR), (KNOT_HOLE_R * k, BG)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in ((192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")):
        render(size).save(OUT / name, "PNG")
        print(f"escrito {name} ({size}x{size})")
    # .ico multi-tamaño: el favicon lo consumen navegadores viejos y algunos crawlers.
    render(64).save(OUT / "favicon.ico", "ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("escrito favicon.ico (16/32/48/64)")


if __name__ == "__main__":
    main()
