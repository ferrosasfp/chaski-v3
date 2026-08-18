"""Genera los iconos de la app componiendo `public/marca-chaski.png` sobre el cuadrado de tinta.

🔴 POR QUE CAMBIO ESTE SCRIPT (HU-066), Y ES LO PRIMERO QUE HAY QUE LEER. Hasta esta HU el archivo
dibujaba la marca A MANO: una copia literal de la geometria del `<svg>` de `ChaskiMark` (un camino
escalonado blanco y un circulo de cochinilla). Esa ya NO es la marca de Chaski. Dejarlo como estaba
no era un comentario viejo: era un script ARMADO Y CARGADO, porque correrlo habria pisado los iconos
nuevos de `public/` con el logo viejo, en silencio y con exit 0. Un generador que se quedo atras del
recurso que genera es peor que no tener generador.

La fuente de verdad sigue siendo un archivo del repo revisable, no un binario sin procedencia: ahora
es `public/marca-chaski.png` (el mensajero solo, sin la palabra), que es EL MISMO archivo que pinta
`ChaskiMark` en la app. Si la marca cambia, se reemplaza ese PNG y se vuelve a correr esto.

    python3 scripts/generate-icons.py

Requiere Pillow. Escribe en public/: favicon.ico, icon-192.png, icon-512.png, apple-touch-icon.png.

⛔ EL CUADRADO DE TINTA SE QUEDA ACA Y SOLO ACA. La marca dentro de la APP perdio ese fondo en HU-066
(el PNG es transparente y se apoya sobre el papel claro de la pantalla). Un ICONO es otro problema: se
recorta contra un escritorio de cualquier color, y sin superficie propia el mensajero se pierde. Por eso
el fondo vive en este script, que es el unico sitio que produce iconos, y no en el componente.
"""

from pathlib import Path

from PIL import Image, ImageDraw

RAIZ = Path(__file__).resolve().parent.parent
OUT = RAIZ / "public"
# ⛔ LA FUENTE NO ES `public/marca-chaski.png`, Y ESO ES EL ARREGLO. Ese archivo es el asset WEB:
# se sirve en el header de la app dentro de una caja de 32px, asi que esta reexportado a 128px de
# ancho para no mandar medio mega al telefono. Un icono de 512 sacado de ahi sale escalado 2,88x
# hacia arriba — borroso, con exit 0 y sin aviso. Medido el 2026-08-18, y el acoplamiento lo
# introdujo la optimizacion de peso de HU-066: los dos usos compartian archivo y optimizar uno
# degradaba al otro en silencio.
# La fuente de marca vive aparte, a resolucion completa, y NO se sirve al navegador.
FUENTE = RAIZ / "assets" / "marca" / "logo-chaski-fuente.png"
CORTE_LOGOTIPO = 880  # y a partir del cual empieza la palabra CHASKI en la fuente (medido sobre el
                      # perfil de tinta por fila: el mensajero termina en ~878 y debajo solo queda
                      # la "K" en x>=1156. Cortar en 900 dejaba un fragmento naranja en el icono.)

BG = "#17130F"  # tinta. El MISMO valor que `colors.ink` en tailwind.config.ts y que el fondo del splash.

# Los dos numeros de composicion NO SE ELIGIERON A OJO: son los que MINIMIZAN la diferencia contra el
# icono que el founder trajo con la marca nueva. Punto de partida medido sobre `icon-512.png` (primer
# pixel opaco de la fila y=0 en x=102 => radio 0,199; bbox de la tinta 350 de 512 => ancho 0,684) y
# despues barrido de 8 combinaciones comparando pixel a pixel contra ese archivo:
#     radio 0,20 / ancho 0,684 -> diferencia media 4,83 de 255
#     radio 0,22 / ancho 0,70  -> diferencia media 2,78 de 255   <- el que quedo
# ⚠️ NO llega a cero y no puede: el resto es el antialiasing de OTRA herramienta. Lo que este script
# garantiza es que los iconos salgan de la marca NUEVA, no que sean byte-identicos a los del founder.
RADIO = 0.22   # del lado del icono
ANCHO_MARCA = 0.70  # del lado del icono

SS = 8  # supersampling: se dibuja grande y se reduce. Es el antialiasing del pobre y alcanza.
        # Medido: entre SS=4 y SS=8 la diferencia contra el icono de referencia cambia 0,04 de 255.


def render(lado: int) -> Image.Image:
    n = lado * SS
    fondo = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(fondo).rounded_rectangle([0, 0, n - 1, n - 1], radius=RADIO * n, fill=BG)

    fuente = Image.open(FUENTE).convert("RGBA")
    marca = fuente.crop((0, 0, fuente.width, CORTE_LOGOTIPO))
    marca = marca.crop(marca.getchannel("A").getbbox())
    ancho = int(n * ANCHO_MARCA)
    alto = round(ancho * marca.height / marca.width)  # se respeta la proporcion; nunca se deforma
    marca = marca.resize((ancho, alto), Image.LANCZOS)
    fondo.alpha_composite(marca, ((n - ancho) // 2, (n - alto) // 2))
    return fondo.resize((lado, lado), Image.LANCZOS)


def main() -> None:
    if not FUENTE.exists():
        raise SystemExit(f"falta {FUENTE}: es la fuente de marca a resolucion completa, no un adorno")
    OUT.mkdir(parents=True, exist_ok=True)
    for lado, nombre in ((192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")):
        render(lado).save(OUT / nombre, "PNG")
        print(f"escrito {nombre} ({lado}x{lado})")
    render(64).save(OUT / "favicon.ico", "ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    print("escrito favicon.ico (16/32/48/64)")


if __name__ == "__main__":
    main()
