#!/usr/bin/env python3
"""Genera los iconos de Mi Autoclicker (PNG, fondo redondeado + cursor).

Uso:  python3 tools/generar_iconos.py
Salida: icons/icono-{16,32,48,96,128}.png
"""

import os
from PIL import Image, ImageDraw

TAMANOS = [16, 32, 48, 96, 128]
SUPUESTAS = 8  # factor de súper-muestreo para bordes suaves

# Paleta
CIMA = (0, 96, 223)       # azul Firefox
BASE = (0, 55, 140)       # azul profundo
BLANCO = (255, 255, 255)
VERDE = (55, 214, 122)    # verde de "clic activo"
SOMBRA = (0, 20, 60, 70)

# Cursor normalizado (punta en 0,0), ancho de referencia 0.52
CURSOR = [
    (0.00, 0.00),
    (0.00, 0.72),
    (0.20, 0.52),
    (0.31, 0.77),
    (0.42, 0.72),
    (0.31, 0.47),
    (0.52, 0.47),
]


def degradado(ancho: int, alto: int) -> Image.Image:
    """Degradado vertical simple entre CIMA y BASE."""
    imagen = Image.new("RGB", (1, alto))
    pixeles = imagen.load()
    for y in range(alto):
        t = y / max(1, alto - 1)
        rgb = tuple(round(CIMA[i] + (BASE[i] - CIMA[i]) * t) for i in range(3))
        pixeles[0, y] = rgb
    return imagen.resize((ancho, alto), Image.BILINEAR)


def generar(tamanio: int, destino: str) -> None:
    s = tamanio * SUPUESTAS

    fondo = degradado(s, s).convert("RGBA")
    capa = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    dibujo = ImageDraw.Draw(capa)

    # Mascota de esquinas (rectángulo redondeado)
    mascara = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mascara).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    fondo.putalpha(mascara)

    # Coordenadas del cursor
    punta = (s * 0.335, s * 0.30)
    escala = s * 0.66
    puntos = [(punta[0] + x * escala, punta[1] + y * escala) for x, y in CURSOR]

    # Anillo de "clic" detrás de la punta
    radio = s * 0.135
    centro = (punta[0] + s * 0.015, punta[1] + s * 0.015)
    grosor = max(2, int(s * 0.035))
    dibujo.ellipse(
        [centro[0] - radio, centro[1] - radio, centro[0] + radio, centro[1] + radio],
        outline=VERDE + (255,),
        width=grosor,
    )

    # Sombra suave del cursor
    sombra = [(x + s * 0.012, y + s * 0.016) for x, y in puntos]
    capa_sombra = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(capa_sombra).polygon(sombra, fill=SOMBRA)
    capa = Image.alpha_composite(capa, capa_sombra)
    dibujo = ImageDraw.Draw(capa)

    # Cursor blanco
    dibujo.polygon(puntos, fill=BLANCO + (255,))

    composicion = Image.alpha_composite(fondo, capa)
    salida = composicion.resize((tamanio, tamanio), Image.LANCZOS)
    salida.save(destino, "PNG", optimize=True)


def main() -> None:
    raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    carpeta = os.path.join(raiz, "icons")
    os.makedirs(carpeta, exist_ok=True)
    for tamanio in TAMANOS:
        destino = os.path.join(carpeta, f"icono-{tamanio}.png")
        generar(tamanio, destino)
        print(f"generado: {destino}")


if __name__ == "__main__":
    main()
