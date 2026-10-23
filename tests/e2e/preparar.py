#!/usr/bin/env python3
"""
Construye la variante de prueba E2E de la extensión (tests/e2e/variante/)
y su archivo ext.xpi, a partir del código real del proyecto.

Solo cambia dos cosas respecto a la extensión que se publica:

  1. Añade `host_permissions` al manifest: el permiso de origen se concede
     al instalar, porque el gesto del usuario en el panel no lo puede hacer
     el WebDriver (eso sí lo prueba la instalación normal en Firefox).
  2. Un listener en background que llama a activarSitio() —la MISMA ruta
     real: permiso → storage → inyección → badge— al cargarse la página
     de prueba, porque pulsar el botón del panel requiere un gesto humano.

Todo lo demás (content.js, popup, options, _locales, iconos) es idéntico.

Uso:  python3 tests/e2e/preparar.py   (o  npm run test:e2e)
"""

import json
import os
import shutil
import zipfile

AQUI = os.path.dirname(os.path.abspath(__file__))
PROYECTO = os.path.dirname(os.path.dirname(AQUI))  # tests/e2e → raíz
VARIANTE = os.path.join(AQUI, "variante")
XPI = os.path.join(AQUI, "ext.xpi")

# Elige la prueba el puerto (evita chocar con un servidor ya en marcha).
PUERTO = int(os.environ.get("PUERTO_E2E", "8765"))
ORIGEN_PRUEBA = f"http://127.0.0.1:{PUERTO}"

EXCLUIR_DIRS = {"node_modules", "dist", "tests", "tools", ".git"}
EXCLUIR_ARCHIVOS = {
    "package.json",
    "package-lock.json",
    "web-ext-config.cjs",
    "README.md",
    ".gitignore",
}

GANCHO = f'''
/* ------------------------------------------------------------------ */
/* SOLO PARA LA PRUEBA E2E: activa el sitio con la MISMA ruta real      */
/* (activarSitio → inyección → badge), porque pulsar el botón del      */
/* panel requiere un gesto humano que el driver no puede hacer.        */
/* ------------------------------------------------------------------ */
const ORIGEN_PRUEBA = "{ORIGEN_PRUEBA}";

browser.tabs.onUpdated.addListener((tabId, cambio, tab) => {{
  if (cambio.status !== "complete") return;
  if (!tab.url || !tab.url.startsWith(ORIGEN_PRUEBA)) return;
  activarSitio(tabId, ORIGEN_PRUEBA).catch(() => {{}});
}});
'''


def copiar_codigo():
    """Copia el código fuente de la extensión a tests/e2e/variante/."""
    if os.path.exists(VARIANTE):
        shutil.rmtree(VARIANTE)
    os.makedirs(VARIANTE)

    for entrada in sorted(os.listdir(PROYECTO)):
        origen = os.path.join(PROYECTO, entrada)
        if os.path.isdir(origen):
            if entrada in EXCLUIR_DIRS:
                continue
            shutil.copytree(origen, os.path.join(VARIANTE, entrada))
        else:
            if entrada in EXCLUIR_ARCHIVOS:
                continue
            shutil.copy2(origen, os.path.join(VARIANTE, entrada))


def parchear_manifest():
    ruta = os.path.join(VARIANTE, "manifest.json")
    with open(ruta, encoding="utf-8") as f:
        manifest = json.load(f)
    manifest["host_permissions"] = ["<all_urls>"]
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")


def parchear_fondo():
    with open(os.path.join(VARIANTE, "background.js"), encoding="utf-8") as f:
        codigo = f.read()
    with open(os.path.join(VARIANTE, "background.js"), "w", encoding="utf-8") as f:
        f.write(codigo.rstrip() + "\n" + GANCHO)


def empaquetar():
    if os.path.exists(XPI):
        os.remove(XPI)
    with zipfile.ZipFile(XPI, "w", zipfile.ZIP_DEFLATED) as z:
        for raiz, dirs, archivos in os.walk(VARIANTE):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules"}]
            for nombre in archivos:
                if nombre == ".gitignore":
                    continue
                ruta = os.path.join(raiz, nombre)
                z.write(ruta, os.path.relpath(ruta, VARIANTE))


def main():
    copiar_codigo()
    parchear_manifest()
    parchear_fondo()
    empaquetar()
    with zipfile.ZipFile(XPI) as z:
        ficheros = len(z.namelist())
    print(f"variante lista: {XPI} ({ficheros} ficheros, {os.path.getsize(XPI)} bytes)")


if __name__ == "__main__":
    main()
