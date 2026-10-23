/**
 * Mi Autoclicker — lógica del panel (popup).
 *
 * El popup es quien pide el permiso del sitio (permissions.request debe
 * producirse dentro de un gesto del usuario) y quien guarda los ajustes;
 * el content script se entera a través de browser.storage.onChanged.
 */

"use strict";

const AJUSTES_POR_DEFECTO = {
  cps: 10,
  tipoClic: "izquierdo",
  modo: "continuo",
  tecla: "F8",
  mostrarIndicador: true,
};

const MODIFICADORES = ["Control", "Shift", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock"];

let ajustes = { ...AJUSTES_POR_DEFECTO };
let pestana = null;
let origen = null;
let patron = null;
let armado = false;
let permiso = false;
let corriendo = false;
let avisoPendiente = null; // { texto, error }
let guardadoTemporizador = null;

const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Localización                                                        */
/* ------------------------------------------------------------------ */

function traducir() {
  document.querySelectorAll("[data-i18n]").forEach((nodo) => {
    const texto = browser.i18n.getMessage(nodo.getAttribute("data-i18n"));
    if (texto) nodo.textContent = texto;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((nodo) => {
    const texto = browser.i18n.getMessage(nodo.getAttribute("data-i18n-placeholder"));
    if (texto) nodo.setAttribute("placeholder", texto);
  });
  const titulo = browser.i18n.getMessage("nombre");
  if (titulo) document.title = titulo;
}

function mensaje(clave) {
  return browser.i18n.getMessage(clave) || clave;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function origenDe(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function nombreTecla(evento) {
  const tecla = evento.key;
  if (tecla === " ") return "Space";
  if (tecla.length === 1) return tecla.toUpperCase();
  return tecla;
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

/* ------------------------------------------------------------------ */
/* Carga inicial                                                       */
/* ------------------------------------------------------------------ */

async function cargarAjustes() {
  try {
    const datos = await browser.storage.local.get({ ajustes: null });
    if (datos.ajustes) {
      ajustes = { ...AJUSTES_POR_DEFECTO, ...datos.ajustes };
    }
  } catch {
    ajustes = { ...AJUSTES_POR_DEFECTO };
  }
  aplicarAjustesEnUI();
}

async function detectarPestana() {
  try {
    const pestañas = await browser.tabs.query({ active: true, currentWindow: true });
    pestana = pestañas[0] || null;
  } catch {
    pestana = null;
  }

  origen = pestana ? origenDe(pestana.url) : null;
  patron = origen ? `${origen}/*` : null;
  armado = false;
  permiso = false;

  if (origen) {
    permiso = await browser.permissions
      .contains({ origins: [patron] })
      .catch(() => false);
    const datos = await browser.storage.local.get({ sitios: {} }).catch(() => ({ sitios: {} }));
    armado = Boolean(datos.sitios && datos.sitios[origen] && permiso);
  }

  // Estado optimista: si acabamos de activar, el content script aún no ha
  // respondido y el chip no debe parpadear a "Inactivo".
  corriendo = armado && ajustes.modo === "continuo";
}

/* ------------------------------------------------------------------ */
/* Interfaz                                                            */
/* ------------------------------------------------------------------ */

function mostrarAviso(clave, esError) {
  const nodo = el("aviso");
  if (!clave) {
    nodo.hidden = true;
    nodo.textContent = "";
    nodo.classList.remove("nota");
    return;
  }
  nodo.hidden = false;
  nodo.textContent = mensaje(clave);
  nodo.classList.toggle("nota", !esError);
}

function refrescarUI() {
  const host = origen ? new URL(origen).host : "—";
  el("host").textContent = host;

  const boton = el("alternar");
  boton.disabled = !origen;
  boton.classList.toggle("encendido", armado);
  boton.textContent = armado ? mensaje("desactivarSitio") : mensaje("activarSitio");

  if (avisoPendiente) {
    mostrarAviso(avisoPendiente.clave, avisoPendiente.error);
  } else if (!pestana) {
    mostrarAviso("sinPestana", true);
  } else if (!origen) {
    mostrarAviso("noCompatible", true);
  } else if (!armado && !permiso) {
    mostrarAviso("sitioSinPermiso", false);
  } else {
    mostrarAviso(null);
  }

  refrescarChip();
}

function refrescarChip() {
  const chip = el("chip");
  const activo = armado && corriendo;
  chip.textContent = activo ? mensaje("estadoActivo") : mensaje("estadoInactivo");
  chip.classList.toggle("activo", activo);
}

function actualizarAyudaModo() {
  el("ayuda-modo").textContent = mensaje(ajustes.modo === "mantener" ? "ayudaMantener" : "ayudaContinuo");
}

function aplicarAjustesEnUI() {
  el("cps").value = String(ajustes.cps);
  el("cps-valor").textContent = String(ajustes.cps);
  const radioTipo = document.querySelector(`input[name="tipo"][value="${ajustes.tipoClic}"]`);
  if (radioTipo) radioTipo.checked = true;
  const radioModo = document.querySelector(`input[name="modo"][value="${ajustes.modo}"]`);
  if (radioModo) radioModo.checked = true;
  el("tecla").value = ajustes.tecla;
  el("indicador").checked = Boolean(ajustes.mostrarIndicador);
  actualizarAyudaModo();
}

/* ------------------------------------------------------------------ */
/* Guardado de ajustes                                                 */
/* ------------------------------------------------------------------ */

function guardar(parciales, inmediato) {
  ajustes = { ...ajustes, ...parciales };
  if (guardadoTemporizador) {
    window.clearTimeout(guardadoTemporizador);
    guardadoTemporizador = null;
  }
  const escribir = () => browser.storage.local.set({ ajustes }).catch(() => {});
  if (inmediato) {
    escribir();
  } else {
    guardadoTemporizador = window.setTimeout(escribir, 250);
  }
}

/* ------------------------------------------------------------------ */
/* Activar / desactivar el sitio                                       */
/* ------------------------------------------------------------------ */

async function alternarSitio() {
  if (!pestana || !origen) return;

  const boton = el("alternar");
  boton.disabled = true;
  avisoPendiente = null;

  try {
    if (!armado) {
      // La petición de permiso debe ocurrir dentro de este gesto de usuario.
      let concedido = permiso;
      if (!concedido) {
        concedido = await browser.permissions.request({ origins: [patron] });
      }
      if (!concedido) {
        avisoPendiente = { clave: "permisoDenegado", error: true };
        return;
      }
      const respuesta = await browser.runtime.sendMessage({
        tipo: "activar",
        tabId: pestana.id,
        origen,
      });
      if (!respuesta || respuesta.ok === false) {
        avisoPendiente = {
          clave: respuesta && respuesta.motivo === "sinPermiso" ? "permisoDenegado" : "errorGenerico",
          error: true,
        };
        return;
      }
      armado = true;
      permiso = true;
      if (respuesta.inyectado === false) {
        // El sitio queda activo, pero el content script no corrió en la
        // pestaña: avisamos en lugar de enseñar «Activo» mentiroso.
        corriendo = false;
        avisoPendiente = { clave: "noInyectado", error: true };
      } else {
        corriendo = ajustes.modo === "continuo";
      }
    } else {
      await browser.runtime.sendMessage({ tipo: "desactivar", tabId: pestana.id, origen });
      armado = false;
      permiso = false;
      corriendo = false;
    }
  } catch {
    avisoPendiente = { clave: "errorGenerico", error: true };
  } finally {
    boton.disabled = false;
    refrescarUI();
    consultarEstado();
  }
}

/* ------------------------------------------------------------------ */
/* Estado en vivo                                                      */
/* ------------------------------------------------------------------ */

async function consultarEstado() {
  if (!pestana) return;
  try {
    const respuesta = await browser.tabs.sendMessage(pestana.id, { tipo: "consulta" });
    if (respuesta && respuesta.ok) {
      corriendo = Boolean(respuesta.corriendo);
      el("contador").textContent = Number(respuesta.contador || 0).toLocaleString();
    }
  } catch {
    // Sin content script inyectado en esta pestaña.
    if (!armado) corriendo = false;
  }
  refrescarChip();
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

function conectarEventos() {
  el("alternar").addEventListener("click", alternarSitio);

  el("cps").addEventListener("input", (evento) => {
    const valor = Number(evento.target.value);
    el("cps-valor").textContent = String(valor);
    guardar({ cps: valor });
  });

  document.querySelectorAll('input[name="tipo"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) guardar({ tipoClic: radio.value }, true);
    });
  });

  document.querySelectorAll('input[name="modo"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        guardar({ modo: radio.value }, true);
        actualizarAyudaModo();
        corriendo = radio.value === "continuo" && armado;
        refrescarChip();
      }
    });
  });

  el("indicador").addEventListener("change", (evento) => {
    guardar({ mostrarIndicador: evento.target.checked }, true);
  });

  // Captura de la tecla rápida.
  el("tecla").addEventListener("keydown", (evento) => {
    evento.preventDefault();
    if (MODIFICADORES.includes(evento.key)) return;
    if (evento.key === "Escape") {
      evento.target.blur();
      return;
    }
    const combo = comboDeEvento(evento);
    evento.target.value = combo;
    guardar({ tecla: combo }, true);
  });

  el("restablecer-tecla").addEventListener("click", () => {
    el("tecla").value = AJUSTES_POR_DEFECTO.tecla;
    guardar({ tecla: AJUSTES_POR_DEFECTO.tecla }, true);
  });

  el("opciones").addEventListener("click", () => {
    browser.runtime.openOptionsPage().finally(() => window.close());
  });
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function iniciar() {
  traducir();
  await cargarAjustes();
  await detectarPestana();
  refrescarUI();
  conectarEventos();
  await consultarEstado();
  window.setInterval(consultarEstado, 1000);
}

iniciar();
