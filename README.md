# Mi Autoclicker

**Código fuente:** <https://github.com/adrianoaquesada/mi-autoclicker>

Extensión de Firefox (**Manifest V3**) que hace clics automáticos a la velocidad que tú eliges:
tocas una tecla y el ratón hace clic por ti, con código limpio, permisos mínimos y todas las
comodidades actuales (control por sitio, panel, opciones e indicador en la página).

## Características

- **Clics por segundo** ajustables de 1 a 100.
- **Tipo de clic**: izquierdo, derecho (abre menú contextual) o central.
- **Dos modos**:
  - *Continuo*: el sitio activado hace clic sin parar; la tecla rápida pausa y reanuda.
  - *Mantener tecla*: solo hace clic mientras mantienes pulsada la tecla.
- **Tecla rápida configurable** (por defecto `F8`), con modificadores opcionales
  (`Ctrl`, `Mayús`, `Alt`, `Meta`) y captura directa desde el panel.
- **Control por sitio**: la extensión solo pide acceso al sitio que activas, uno a la vez.
  Al desactivarlo se revoca el permiso.
- **Indicador en la página** (Shadow DOM, aislado de los estilos del sitio) y **badge `ON`**
  en el icono de la barra.
- **Contador de clics** en vivo en el panel.
- **Panel (popup) + página de opciones** con lista de sitios activos y revocación masiva.
- **Internacionalización** completa: español (idioma por defecto) e inglés.
- Imágenes de icono generadas reproduciblemente con `tools/generar_iconos.py`.

## Permisos (y por qué)

| Permiso | Motivo |
| --- | --- |
| `storage` | Guardar tus ajustes y la lista de sitios activos **en tu navegador**. |
| `activeTab` | Leer la URL de la pestaña abierta al abrir el panel. |
| `scripting` | Inyectar el motor de clics **solo** en los sitios que activas. |
| `optional_host_permissions: <all_urls>` | Base legal para pedir acceso *un sitio concreto* en el momento en que pulsas «Activar en este sitio». Nunca se pide acceso global. |

La extensión **no recopila ni transmite ningún dato**: `data_collection_permissions` está
declarado como `["none"]`, que es obligatorio en AMO desde el 3 de noviembre de 2025.

## Arquitectura

```
manifest.json      MV3, permisos opcionales, i18n, data_collection_permissions
background.js      Event page: inyección pestaña a pestaña, badge, activar/desactivar
content.js         Motor de clics: puntero → secuencia pointer/mouse/click real
popup/             Panel rápido (permiso, ajustes, contador)
options/           Opciones completas + gestión de sitios activos
_locales/          es (por defecto) y en
tools/             Generador de iconos
tests/             Pruebas: motor, fondo y panel (jsdom/vm) + E2E en Firefox real
```

Decisiones de diseño:

- **Sin `content_scripts` estático**: el script se inyecta por programa con
  `browser.scripting.executeScript` solo donde hay permiso concedido, así el sitio no
  recibe código mientras la extensión esté desactivada.
- **Inyección idempotente**: guard de una sola vez + comprobación `ping`, por lo que
  recargas de pestaña e iframes dinámicos no duplican temporizadores.
- **Sin `innerHTML` dinámico** y sin `eval`: requisito de revisión de AMO.
- **MV3 con `background.scripts`** (Firefox no soporta `background.service_worker`,
  bug 1573659) y `strict_min_version: 142.0`, la primera versión en la que el aviso de
  consentimiento de datos de Firefox acepta `data_collection_permissions`.

## Licencia

MPL-2.0. Ver [`LICENSE`](LICENSE).
