/**
 * Mi Autoclicker — content script (motor de clics).
 *
 * Se inyecta por programa solo en los sitios que el usuario ha activado.
 * Lee sus ajustes de browser.storage.local y se mantiene sincronizado
 * mediante browser.storage.onChanged, sin necesidad de mensajería extra.
 *
 * Secuencia de clic real que imita el navegador:
 *   pointerdown → mousedown → pointerup → mouseup → click | auxclick | contextmenu
 */

(() => {
  "use strict";

  // Guarda de idempotencia: la inyección puede repetirse (recarga de
  // pestaña, iframe dinámico) y no debe duplicar listeners ni temporizadores.
  if (globalThis.__MI_AUTOCLICKER_MOTOR__) {
    return;
  }
  globalThis.__MI_AUTOCLICKER_MOTOR__ = true;

  const AJUSTES_POR_DEFECTO = {
    cps: 10,
    tipoClic: "izquierdo", // izquierdo | derecho | central
    modo: "mantener", // continuo | mantener
    tecla: "F8",
    mostrarIndicador: true,
  };

  const BOTONES = {
    izquierdo: { button: 0, buttons: 1, final: "click" },
    central: { button: 1, buttons: 4, final: "auxclick" },
    derecho: { button: 2, buttons: 2, final: "contextmenu" },
  };

  let ajustes = { ...AJUSTES_POR_DEFECTO };
  let armado = false;
  let alternando = false; // modo continuo: ¿está encendido?
  let teclaSostenida = false; // modo mantener: ¿tecla pulsada?
  let temporizador = null;
  let intervaloMs = null; // ritmo actual del temporizador (para detectar cambios)
  let corriendo = false;
  let contadorTotal = 0;
  let marcasClics = []; // marcas de tiempo de los últimos clics (para CPS reales)

  let punteroX = null;
  let punteroY = null;

  let indicadorHost = null;
  let indicadorRaiz = null;

  // Promesa de la carga inicial: la consulta del panel puede llegar mientras
  // storage se está leyendo; responder sin esperarla enseñaría «Inactivo»
  // justo después de activar (falsa alarma).
  let cargaInicial = Promise.resolve();

  // Si storage cambia mientras se lee el estado inicial, esa lectura llega
  // obsoleta: sin estos indicadores pisaría el valor más reciente y el motor
  // podría quedarse muerto (activación ganada por la lectura inicial).
  let ajustesRecibidos = false;
  let sitiosRecibidos = false;

  /* ---------------------------------------------------------------- */
  /* Utilidades                                                        */
  /* ---------------------------------------------------------------- */

  function miOrigen() {
    try {
      const origen = location.origin;
      if (origen && origen !== "null") {
        return origen;
      }
    } catch {
      // location no accesible (marcos raros)
    }
    try {
      // about:blank y marcos heredados: usamos el origen del documento padre.
      return window.top.location.origin;
    } catch {
      return null; // origen cruzado sin permiso → fuera
    }
  }

  function cpsSeguros(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return AJUSTES_POR_DEFECTO.cps;
    return Math.min(100, Math.max(1, Math.round(n)));
  }

  function comboNormalizado(combo) {
    return String(combo || "")
      .trim()
      .toLowerCase();
  }

  function nombreTecla(evento) {
    const tecla = evento.key;
    if (tecla === " ") return "Space";
    if (tecla.length === 1) return tecla.toUpperCase();
    return tecla; // F8, Escape, ArrowUp, Enter…
  }

  function comboDeEvento(evento) {
    const partes = [];
    if (evento.ctrlKey) partes.push("Ctrl");
    if (evento.metaKey) partes.push("Meta");
    if (evento.altKey) partes.push("Alt");
    if (evento.shiftKey) partes.push("Shift");
    partes.push(nombreTecla(evento));
    return partes.join("+");
  }

  function teclaDeCombo(combo) {
    const texto = String(combo || "");
    const cortes = texto.split("+");
    return cortes[cortes.length - 1] || "";
  }

  function enCampoEditable(objetivo) {
    if (!objetivo || typeof objetivo !== "object") return false;
    if (objetivo.isContentEditable) return true;
    const etiqueta = objetivo.tagName;
    return etiqueta === "INPUT" || etiqueta === "TEXTAREA" || etiqueta === "SELECT";
  }

  /** true si este script corre en el marco principal de la pestaña. */
  function esMarcoPrincipal() {
    try {
      return window.top === window;
    } catch {
      return false; // marco con origen distinto (sin acceso a window.top)
    }
  }

  /**
   * Posición a la que hay que hacer clic, o null si toca no hacerlo.
   *  - Puntero conocido: se respeta donde esté (si salió del marco, no clicamos
   *    en este marco: relevante para iframes).
   *  - Puntero nunca visto (el ratón no ha pasado por la página desde la
   *    inyección): en el marco principal usamos el centro de la ventana para
   *    no quedarnos en silencio; los iframes siguen esperando al puntero.
   */
  function posicionDeClic() {
    if (punteroX === null || punteroY === null) {
      if (!esMarcoPrincipal()) return null;
      return {
        x: Math.round(window.innerWidth / 2),
        y: Math.round(window.innerHeight / 2),
      };
    }
    if (punteroX < 0 || punteroY < 0 || punteroX > window.innerWidth || punteroY > window.innerHeight) {
      return null; // el puntero está fuera de este marco (iframes)
    }
    return { x: punteroX, y: punteroY };
  }

  /* ---------------------------------------------------------------- */
  /* Motor de clics                                                    */
  /* ---------------------------------------------------------------- */

  function unClic() {
    const posicion = posicionDeClic();
    if (!posicion) return;

    const destino = document.elementFromPoint(posicion.x, posicion.y);
    if (!destino) return;

    const tipo = BOTONES[ajustes.tipoClic] || BOTONES.izquierdo;
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: posicion.x,
      clientY: posicion.y,
      screenX: Math.round(posicion.x + (window.screenX || 0)),
      screenY: Math.round(posicion.y + (window.screenY || 0)),
      button: tipo.button,
      buttons: tipo.buttons,
      detail: 1,
    };

    const emitir = (nombre, extra) => {
      const esPuntero = nombre.startsWith("pointer");
      const UsaPointer = esPuntero && typeof PointerEvent === "function";
      const Ctor = UsaPointer ? PointerEvent : MouseEvent;
      const init = UsaPointer
        ? {
            ...base,
            ...extra,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
            width: 1,
            height: 1,
            pressure: 0.5,
          }
        : { ...base, ...extra };
      try {
        destino.dispatchEvent(new Ctor(nombre, init));
      } catch {
        // Un constructor puede fallar en documentos extraños: se ignora.
      }
    };

    emitir("pointerdown");
    emitir("mousedown");
    emitir("pointerup");
    emitir("mouseup");
    emitir(tipo.final);

    contadorTotal += 1;
    const ahora = Date.now();
    marcasClics.push(ahora);
    if (marcasClics.length > 400) marcasClics = marcasClics.slice(-200);
  }

  function cpsReales() {
    const limite = Date.now() - 1000;
    marcasClics = marcasClics.filter((m) => m >= limite);
    return marcasClics.length;
  }

  /* ---------------------------------------------------------------- */
  /* Estado: armar / correr                                            */
  /* ---------------------------------------------------------------- */

  function debeCorrer() {
    if (!armado) return false;
    return ajustes.modo === "mantener" ? teclaSostenida : alternando;
  }

  function informarEstado() {
    browser.runtime
      .sendMessage({ tipo: "estado", corriendo })
      .catch(() => {}); // el fondo puede estar dormido o la pestaña cerrada
  }

  function pararTemporizador() {
    if (temporizador) {
      window.clearInterval(temporizador);
      temporizador = null;
    }
  }

  function sincronizar() {
    const debe = debeCorrer();
    const ritmo = Math.max(10, Math.round(1000 / cpsSeguros(ajustes.cps)));
    const ritmoActual = temporizador ? intervaloMs : null;

    if (!debe) {
      pararTemporizador();
    } else if (!temporizador || ritmoActual !== ritmo) {
      // Arrancamos, o reiniciamos si el usuario cambió los clics por segundo.
      pararTemporizador();
      intervaloMs = ritmo;
      temporizador = window.setInterval(unClic, ritmo);
    }

    const antes = corriendo;
    corriendo = Boolean(temporizador);
    refrescarIndicador();
    if (antes !== corriendo) informarEstado();
  }

  /* ---------------------------------------------------------------- */
  /* Indicador en la página (Shadow DOM, aislado de los estilos)        */
  /* ---------------------------------------------------------------- */

  function crearIndicador() {
    if (indicadorHost && indicadorHost.isConnected) return;

    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:2147483647;pointer-events:none;";
    const raiz = host.attachShadow({ mode: "open" });
    // Plantilla fija (sin interpolación): el texto dinámico se asigna después,
    // para no introducir asignaciones a innerHTML con valores variables.
    raiz.innerHTML = `
      <style>
        .caja {
          display: flex; align-items: center; gap: 7px;
          font: 600 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
          color: #fff; background: rgba(22, 24, 28, .93);
          border: 1px solid rgba(255, 255, 255, .16);
          padding: 6px 11px; border-radius: 999px;
          box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
        }
        .punto {
          width: 8px; height: 8px; border-radius: 50%;
          background: #37d67a; box-shadow: 0 0 0 0 rgba(55, 214, 122, .55);
          animation: latir 1.2s ease-out infinite;
        }
        @keyframes latir {
          50% { box-shadow: 0 0 0 7px rgba(55, 214, 122, 0); }
        }
      </style>
      <div class="caja" role="status">
        <span class="punto"></span><span data-cps>0</span>&nbsp;CPS
      </div>`;

    const caja = raiz.querySelector(".caja");
    const etiqueta = browser.i18n.getMessage("indicadorAccesible");
    if (caja && etiqueta) caja.setAttribute("aria-label", etiqueta);

    const contenedor = document.documentElement || document.body;
    if (!contenedor) return;
    contenedor.appendChild(host);

    indicadorHost = host;
    indicadorRaiz = raiz;
  }

  function refrescarIndicador() {
    const visible = armado && corriendo && ajustes.mostrarIndicador;
    if (!visible) {
      if (indicadorHost) indicadorHost.style.display = "none";
      return;
    }
    crearIndicador();
    if (!indicadorHost) return;
    indicadorHost.style.display = "";
    const numero = indicadorRaiz?.querySelector("[data-cps]");
    if (numero) numero.textContent = String(cpsSeguros(ajustes.cps));
  }

  /* ---------------------------------------------------------------- */
  /* Tecla rápida                                                       */
  /* ---------------------------------------------------------------- */

  function alPulsar(evento) {
    if (evento.isComposing) return;

    const combo = comboDeEvento(evento);
    if (comboNormalizado(combo) !== comboNormalizado(ajustes.tecla)) return;

    const usaModificador = /(ctrl|meta|alt)\+/i.test(combo);
    if (!usaModificador && enCampoEditable(evento.target)) return;

    if (!armado) return;

    evento.preventDefault();
    evento.stopPropagation();

    if (ajustes.modo === "mantener") {
      teclaSostenida = true;
    } else {
      if (evento.repeat) return;
      alternando = !alternando;
    }
    sincronizar();
  }

  function alSoltar(evento) {
    if (ajustes.modo !== "mantener" || !teclaSostenida) return;
    // Comparamos solo la tecla: los modificadores pueden soltarse antes.
    if (comboNormalizado(nombreTecla(evento)) !== comboNormalizado(teclaDeCombo(ajustes.tecla))) {
      return;
    }
    teclaSostenida = false;
    sincronizar();
  }

  /* ---------------------------------------------------------------- */
  /* Iframes dinámicos                                                 */
  /* ---------------------------------------------------------------- */

  let avisoMarco = null;
  function avisarMarcoNuevo() {
    if (avisoMarco) return;
    avisoMarco = window.setTimeout(() => {
      avisoMarco = null;
      browser.runtime.sendMessage({ tipo: "marcoAniadido" }).catch(() => {});
    }, 300);
  }

  function vigilarMarcos() {
    if (!document.documentElement) return;
    const observador = new MutationObserver((mutaciones) => {
      for (const mutacion of mutaciones) {
        for (const nodo of mutacion.addedNodes) {
          if (nodo.nodeType !== 1) continue;
          if (nodo.tagName === "IFRAME" || nodo.querySelector?.("iframe")) {
            avisarMarcoNuevo();
            return;
          }
        }
      }
    });
    observador.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------------------------------------------------------------- */
  /* Almacenamiento y mensajes                                         */
  /* ---------------------------------------------------------------- */

  function aplicarSitios(sitios) {
    const estaba = armado;
    armado = Boolean(sitios && sitios[miOrigen()]);
    if (armado && !estaba && ajustes.modo === "continuo") {
      alternando = true; // activar el sitio enciende el clic continuo
    }
    if (!armado) {
      alternando = false;
      teclaSostenida = false;
    }
  }

  async function cargarEstado() {
    try {
      const datos = await browser.storage.local.get({ ajustes: null, sitios: {} });
      if (datos.ajustes && !ajustesRecibidos) {
        ajustes = { ...AJUSTES_POR_DEFECTO, ...datos.ajustes };
      }
      if (!sitiosRecibidos) aplicarSitios(datos.sitios || {});
    } catch {
      // storage no disponible: seguimos con los valores por defecto.
    }
    sincronizar();
    informarEstado();
  }

  browser.storage.onChanged.addListener((cambios, area) => {
    if (area !== "local") return;

    if (cambios.ajustes) {
      ajustesRecibidos = true;
      ajustes = { ...AJUSTES_POR_DEFECTO, ...(cambios.ajustes.newValue || {}) };
    }
    if (cambios.sitios) {
      sitiosRecibidos = true;
      aplicarSitios(cambios.sitios.newValue || {});
    }
    sincronizar();
    refrescarIndicador();
  });

  browser.runtime.onMessage.addListener((mensaje) => {
    switch (mensaje?.tipo) {
      case "ping":
        return Promise.resolve({ ok: true, corriendo });

      case "consulta":
        // Esperamos a que la carga inicial termine: antes de leer storage no
        // sabemos si el sitio está armado ni si debe estar corriendo.
        return cargaInicial.then(() => ({
          ok: true,
          armado,
          corriendo,
          modo: ajustes.modo,
          contador: contadorTotal,
          cpsReales: cpsReales(),
        }));

      case "detener":
        return cargaInicial.then(() => {
          alternando = false;
          teclaSostenida = false;
          sincronizar();
          return { ok: true };
        });

      default:
        return undefined;
    }
  });

  /* ---------------------------------------------------------------- */
  /* Arranque                                                          */
  /* ---------------------------------------------------------------- */

  function rastrearPuntero(evento) {
    punteroX = evento.clientX;
    punteroY = evento.clientY;
  }

  window.addEventListener("pointermove", rastrearPuntero, true);
  window.addEventListener("mousemove", rastrearPuntero, true);
  // Si el usuario aún no ha movido el ratón, usamos su último clic real.
  window.addEventListener(
    "click",
    (evento) => {
      if (punteroX === null || punteroY === null) {
        punteroX = evento.clientX;
        punteroY = evento.clientY;
      }
    },
    true
  );

  window.addEventListener("keydown", alPulsar, true);
  window.addEventListener("keyup", alSoltar, true);

  cargaInicial = cargarEstado();
  vigilarMarcos();
})();
