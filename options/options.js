/**
 * Mi Autoclicker — página de opciones.
 *
 * Repite los ajustes del panel y añade la gestión de sitios activos
 * (con revocación del permiso) y la información de privacidad.
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
  if (titulo) document.title = `${titulo} — ${browser.i18n.getMessage("tituloOpciones")}`;
}

function mensaje(clave) {
  return browser.i18n.getMessage(clave) || clave;
}

/* ------------------------------------------------------------------ */
/* Ajustes                                                             */
/* ------------------------------------------------------------------ */

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

function actualizarAyudaModo() {
  el("ayuda-modo").textContent = mensaje(
    ajustes.modo === "mantener" ? "ayudaMantener" : "ayudaContinuo"
  );
}

function avisoGuardado() {
  const nodo = el("guardado");
  nodo.hidden = false;
  window.clearTimeout(nodo._temporizador);
  nodo._temporizador = window.setTimeout(() => {
    nodo.hidden = true;
  }, 1800);
}

function guardar(parciales, inmediato) {
  ajustes = { ...ajustes, ...parciales };
  if (guardadoTemporizador) window.clearTimeout(guardadoTemporizador);

  const escribir = () => {
    browser.storage.local
      .set({ ajustes })
      .then(avisoGuardado)
      .catch(() => {});
  };

  if (inmediato) {
    escribir();
  } else {
    guardadoTemporizador = window.setTimeout(escribir, 250);
  }
}

/* ------------------------------------------------------------------ */
/* Sitios activos                                                      */
/* ------------------------------------------------------------------ */

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

async function leerSitios() {
  try {
    const datos = await browser.storage.local.get({ sitios: {} });
    return datos.sitios || {};
  } catch {
    return {};
  }
}

async function pintarSitios() {
  const sitios = await leerSitios();
  const origenes = Object.keys(sitios).sort();
  const lista = el("lista-sitios");
  lista.textContent = "";

  el("sin-sitios").hidden = origenes.length > 0;
  el("acciones-sitios").hidden = origenes.length === 0;

  for (const origen of origenes) {
    const item = document.createElement("li");

    const enlace = document.createElement("a");
    enlace.href = `${origen}/`;
    enlace.target = "_blank";
    enlace.rel = "noreferrer noopener";
    enlace.textContent = origen;
    enlace.style.color = "inherit";
    enlace.style.textDecoration = "none";

    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "quitar";
    boton.textContent = mensaje("quitarSitio");
    boton.addEventListener("click", () => desactivar([origen]));

    item.append(enlace, boton);
    lista.appendChild(item);
  }
}

async function desactivar(origenes) {
  for (const origen of origenes) {
    try {
      await browser.runtime.sendMessage({ tipo: "desactivar", tabId: null, origen });
    } catch {
      // El fondo puede no estar disponible: seguimos con el siguiente.
    }
  }
  // Limpieza extra: si el permiso ya no estaba concedido, borramos la entrada.
  const sitios = await leerSitios();
  const restantes = origenes.filter((o) => sitios[o]);
  if (restantes.length) {
    const copia = { ...sitios };
    for (const o of restantes) delete copia[o];
    await browser.storage.local.set({ sitios: copia }).catch(() => {});
  }
  await pintarSitios();
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

function conectarEventos() {
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
      }
    });
  });

  el("indicador").addEventListener("change", (evento) => {
    guardar({ mostrarIndicador: evento.target.checked }, true);
  });

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

  el("restablecer-ajustes").addEventListener("click", () => {
    ajustes = { ...AJUSTES_POR_DEFECTO };
    aplicarAjustesEnUI();
    guardar({}, true);
  });

  el("desactivar-todo").addEventListener("click", async () => {
    const sitios = await leerSitios();
    await desactivar(Object.keys(sitios));
  });

  // Si otro contexto cambia un ajuste, refrescamos la interfaz.
  browser.storage.onChanged.addListener((cambios, area) => {
    if (area !== "local") return;
    if (cambios.ajustes) {
      ajustes = { ...AJUSTES_POR_DEFECTO, ...(cambios.ajustes.newValue || {}) };
      aplicarAjustesEnUI();
    }
    if (cambios.sitios) {
      pintarSitios();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function iniciar() {
  traducir();

  try {
    const datos = await browser.storage.local.get({ ajustes: null });
    if (datos.ajustes) ajustes = { ...AJUSTES_POR_DEFECTO, ...datos.ajustes };
  } catch {
    ajustes = { ...AJUSTES_POR_DEFECTO };
  }

  el("version").textContent = browser.runtime.getManifest().version;

  aplicarAjustesEnUI();
  conectarEventos();
  await pintarSitios();
}

iniciar();
