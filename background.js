/**
 * Mi Autoclicker — script de fondo (Manifest V3, evento).
 *
 * Responsabilidades:
 *  - Inyectar content.js en las pestañas cuyo sitio está activado y tiene permiso.
 *  - Mantener el indicador (badge) del icono de la barra.
 *  - Atender peticiones del popup (activar/desactivar) y del content (estado).
 *  - Retomar activaciones que el panel dejó a medias (Firefox cierra el panel
 *    al mostrar el diálogo de permiso, justo antes de poder activar).
 *
 * El estado crítico vive en browser.storage.local, porque una página de evento
 * puede descargarse en cualquier momento. En memoria solo se mantiene una copia
 * de conveniencia de `sitios` (caché rehidratada al despertar y sincronizada
 * con browser.storage.onChanged), para no leer storage ni despertar la página
 * de evento en cada cambio de pestaña.
 */

"use strict";

const ARCHIVO_CONTENIDO = "content.js";
const CLAVE_SITIOS = "sitios";
// Intención de activación escrita por el panel justo antes de pedir el
// permiso: si Firefox cierra el panel al mostrar el diálogo, el fondo
// completa la activación cuando el permiso llega.
const CLAVE_ACTIVACION_PENDIENTE = "activacionPendiente";

/** Cuánto tiempo se respeta una intención de activación pendiente. */
const CADUCIDAD_PENDIENTE_MS = 60 * 1000;

/** Último estado de "corriendo" informado por cada pestaña (badge). */
const estadoCorriendo = new Map();

/** Último texto escrito en el badge de cada pestaña (evita repetir la escritura). */
const badgeGuardado = new Map();

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

/** Devuelve el origen (https://ejemplo.com) o null si no es soportado. */
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

/** Patrón de permiso equivalente a un origen. */
function patronDe(origen) {
  return origen ? `${origen}/*` : null;
}

/**
 * Caché de sitios activados.
 *
 * Se hidrata en la primera lectura y se vuelve a hidratar si Firefox descarga
 * la página de evento, así que nunca sustituye a storage: solo evita una
 * llamada IPC por evento del navegador. Cada escritura propia y cada cambio
 * externo (el panel y la página de opciones escriben `sitios` directamente)
 * la mantienen al día.
 */
let sitiosCache = null;
let hidratacion = null;

function leerSitios() {
  if (sitiosCache) return Promise.resolve(sitiosCache);
  if (!hidratacion) {
    hidratacion = browser.storage.local
      .get({ [CLAVE_SITIOS]: {} })
      .then((datos) => {
        hidratacion = null;
        // Si mientras se leía hubo una escritura propia, manda esa.
        if (!sitiosCache) sitiosCache = datos[CLAVE_SITIOS] || {};
        return sitiosCache;
      })
      .catch((error) => {
        hidratacion = null;
        throw error;
      });
  }
  return hidratacion;
}

/** Escribe los sitios y deja la caché al día sin esperar a onChanged. */
async function guardarSitios(mapa) {
  await leerSitios().catch(() => null); // que la hidratación no pise esta escritura
  sitiosCache = mapa;
  await browser.storage.local.set({ [CLAVE_SITIOS]: mapa });
}

/** true si hay algún sitio activado; nunca rechaza (un fallo de lectura no bloquea). */
function haySitios() {
  return leerSitios().then(
    (mapa) => Object.keys(mapa).length > 0,
    () => false
  );
}

async function permisoConcedido(origen) {
  const patron = patronDe(origen);
  if (!patron) return false;
  try {
    return await browser.permissions.contains({ origins: [patron] });
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Badge (indicador del icono)                                         */
/* ------------------------------------------------------------------ */

async function ponerBadge(tabId, texto) {
  // El badge solo lo escribe esta extensión: si el valor es el mismo, ahorramos
  // una llamada IPC (Firefox no avisa de que nada ha cambiado).
  if (badgeGuardado.get(tabId) === texto) return;
  try {
    await browser.action.setBadgeText({ tabId, text: texto });
    badgeGuardado.set(tabId, texto);
  } catch {
    // Pestaña cerrada o API no disponible: no es crítico.
  }
}

async function refrescarBadge(tabId) {
  const sitios = await leerSitios().catch(() => null);
  if (!sitios) return; // sin lectura fiable no tocamos el badge

  // Sin sitios activados el badge no puede estar en «ON»/«II»: si ya lo
  // dejamos vacío, no hace falta ni preguntar por la pestaña.
  if (!Object.keys(sitios).length && badgeGuardado.get(tabId) === "") return;

  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return;
  }
  const origen = origenDe(tab.url);
  const activo = Boolean(origen && sitios[origen] && (await permisoConcedido(origen)));
  const corriendo = estadoCorriendo.get(tabId) !== false;
  await ponerBadge(tabId, activo ? (corriendo ? "ON" : "II") : "");
}

/** Refresca el badge de la pestaña activa de la ventana actual (si la hay). */
async function refrescarBadgeActiva() {
  try {
    const [pestana] = await browser.tabs.query({ active: true, currentWindow: true });
    if (pestana?.id != null) await refrescarBadge(pestana.id);
  } catch {
    // Sin pestaña activa o API no disponible: no es crítico.
  }
}

/* ------------------------------------------------------------------ */
/* Inyección del content script                                        */
/* ------------------------------------------------------------------ */

/** true si el content script ya está vivo en la pestaña. */
async function yaInyectado(tabId) {
  try {
    const respuesta = await browser.tabs.sendMessage(tabId, { tipo: "ping" });
    return Boolean(respuesta && respuesta.ok);
  } catch {
    return false;
  }
}

async function inyectar(tabId, allFrames) {
  const destino = { tabId };
  if (allFrames) destino.allFrames = true;
  await browser.scripting.executeScript({ target: destino, files: [ARCHIVO_CONTENIDO] });
}

/**
 * Garantiza que la pestaña tenga el content script si su sitio está activado.
 * Si el permiso del sitio desapareció, lo limpia del almacenamiento.
 * Devuelve true si el content script está vivo en la pestaña.
 */
async function asegurarPestana(tabId) {
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    return false;
  }

  const origen = origenDe(tab.url);
  if (!origen) return false;

  const sitios = await leerSitios();
  if (!sitios[origen]) return false;

  if (!(await permisoConcedido(origen))) {
    delete sitios[origen];
    await guardarSitios(sitios);
    estadoCorriendo.delete(tabId);
    await ponerBadge(tabId, "");
    return false;
  }

  if (await yaInyectado(tabId)) {
    await refrescarBadge(tabId);
    return true;
  }

  try {
    // Primero intentamos todos los marcos; si Firefox rechaza alguna
    // ventana cruzada, al menos inyectamos en el marco principal.
    await inyectar(tabId, true);
  } catch {
    try {
      await inyectar(tabId, false);
    } catch (error) {
      console.warn("Mi Autoclicker: no se pudo inyectar en la pestaña", error?.message);
      return false;
    }
  }
  await refrescarBadge(tabId);
  return true;
}

/* ------------------------------------------------------------------ */
/* Mensajes                                                            */
/* ------------------------------------------------------------------ */

browser.runtime.onMessage.addListener((mensaje, remitente) => {
  const tipo = mensaje && mensaje.tipo;

  switch (tipo) {
    case "ping":
      // Lo manda el popup o el content script para comprobar vida.
      return Promise.resolve({ ok: true });

    case "marcoAniadido": {
      // Apareció un iframe dinámico: reinyectamos (idempotente).
      const tabId = remitente?.tab?.id;
      if (tabId == null) return Promise.resolve({ ok: false });
      return asegurarPestana(tabId).then(() => ({ ok: true }));
    }

    case "estado": {
      const tabId = remitente?.tab?.id;
      if (tabId == null) return Promise.resolve({ ok: true });
      estadoCorriendo.set(tabId, mensaje.corriendo !== false);
      // refrescarBadge comprueba sitio activo + permiso: si el sitio acaba de
      // desactivarse, el badge queda vacío en lugar de «II».
      return refrescarBadge(tabId).then(() => ({ ok: true }));
    }

    case "activar": {
      return activarSitio(mensaje.tabId, mensaje.origen);
    }

    case "desactivar": {
      return desactivarSitio(mensaje.tabId, mensaje.origen).then(() => ({ ok: true }));
    }

    default:
      return undefined;
  }
});

/* ------------------------------------------------------------------ */
/* Activar / desactivar un sitio                                       */
/* ------------------------------------------------------------------ */

async function activarSitio(tabId, origen) {
  if (!origen) return { ok: false, motivo: "sinOrigen" };
  if (!(await permisoConcedido(origen))) return { ok: false, motivo: "sinPermiso" };

  const sitios = await leerSitios();
  sitios[origen] = true;
  await guardarSitios(sitios);

  if (tabId == null) return { ok: true, inyectado: null };
  // El panel necesita saber si el content script quedó realmente vivo:
  // un «ok» optimista aquí es lo que hace que parezca que no funciona.
  const inyectado = await asegurarPestana(tabId);
  return { ok: true, inyectado };
}

/**
 * Completa una activación que el panel quedó a medias: cuando Firefox cierra
 * el popup al mostrar el diálogo de permiso, el código que sigue a la petición
 * no se ejecuta. El panel deja la intención en storage y aquí la retomamos en
 * cuanto el permiso aparece.
 */
async function completarActivacionPendiente(origenesConcedidos) {
  if (!Array.isArray(origenesConcedidos) || !origenesConcedidos.length) return;

  const datos = await browser.storage.local.get({ [CLAVE_ACTIVACION_PENDIENTE]: null });
  const pendiente = datos[CLAVE_ACTIVACION_PENDIENTE];
  if (!pendiente || !pendiente.origen) return;

  const patron = patronDe(pendiente.origen);
  const coincide = origenesConcedidos.some((p) => p === patron || p === pendiente.origen);
  if (!coincide) return; // el permiso concedido es de otro sitio: nada que hacer

  // Consumimos la intención antes de actuar para no repetir el trabajo si el
  // panel sigue vivo y también llega a activar.
  await browser.storage.local.set({ [CLAVE_ACTIVACION_PENDIENTE]: null });

  const edad = Date.now() - (Number(pendiente.ts) || 0);
  if (edad > CADUCIDAD_PENDIENTE_MS || edad < 0) return; // demasiado vieja

  // La pestaña puede haberse cerrado: entonces activamos solo el sitio.
  await activarSitio(pendiente.tabId, pendiente.origen);
}

async function desactivarSitio(tabId, origen) {
  if (!origen) return;

  const sitios = await leerSitios();
  if (sitios[origen]) {
    delete sitios[origen];
    await guardarSitios(sitios);
  }

  // Menos privilegio: mientras el sitio esté desactivado no conservamos acceso.
  try {
    await browser.permissions.remove({ origins: [patronDe(origen)] });
  } catch {
    // Puede fallar si ya no estaba concedido.
  }

  if (tabId != null) {
    estadoCorriendo.delete(tabId);
    await ponerBadge(tabId, "");
    try {
      await browser.tabs.sendMessage(tabId, { tipo: "detener" });
    } catch {
      // La pestaña puede no tener el script inyectado.
    }
  } else {
    // Vino de la página de opciones (sin pestaña concreta): actualizamos
    // la pestaña activa para no dejar un badge «ON»/«II» obsoleto.
    await refrescarBadgeActiva();
  }
}

/* ------------------------------------------------------------------ */
/* Eventos del navegador                                               */
/* ------------------------------------------------------------------ */

browser.tabs.onUpdated.addListener((tabId, cambio) => {
  if (cambio.status !== "complete") return;
  // Con ningún sitio activado no hay nada que inyectar ni que comprobar:
  // ni consulta de la pestaña ni lectura de storage.
  haySitios()
    .then((hay) => (hay ? asegurarPestana(tabId) : null))
    .catch(() => {});
});

browser.tabs.onActivated.addListener(({ tabId }) => {
  // refrescarBadge sale gratis si el badge ya está vacío; inyectar solo si hay
  // sitio activado (ahora mismo, cambiar de pestaña no cuesta ni una IPC).
  refrescarBadge(tabId)
    .then(() => haySitios())
    .then((hay) => (hay ? asegurarPestana(tabId) : null))
    .catch(() => {});
});

browser.tabs.onRemoved.addListener((tabId) => {
  estadoCorriendo.delete(tabId);
  badgeGuardado.delete(tabId);
});

// El panel y la página de opciones escriben `sitios` sin pasar por aquí:
// la caché se pone al día con cualquier cambio, venga de donde venga.
browser.storage.onChanged.addListener((cambios, area) => {
  if (area !== "local" || !cambios[CLAVE_SITIOS]) return;
  hidratacion = null;
  sitiosCache = cambios[CLAVE_SITIOS].newValue || {};
});

// Si el panel quedó cerrado por el diálogo de permiso, la activación que
// pidió el usuario se completa aquí, en cuanto el navegador concede el permiso.
browser.permissions.onAdded.addListener((permisos) => {
  completarActivacionPendiente(permisos?.origins).catch(() => {});
});

// Si el usuario revoca el permiso desde about:addons, limpiamos el sitio.
browser.permissions.onRemoved.addListener(() => {
  leerSitios()
    .then(async (mapa) => {
      let borrado = false;
      for (const origen of Object.keys(mapa)) {
        if (!(await permisoConcedido(origen))) {
          delete mapa[origen];
          borrado = true;
        }
      }
      if (borrado) await guardarSitios(mapa);
      await refrescarBadgeActiva();
    })
    .catch(() => {});
});

// Al arrancar o reinstalar, garantizamos los valores por defecto.
browser.runtime.onInstalled.addListener(() => {
  browser.storage.local
    .get({ ajustes: null })
    .then((datos) => {
      if (!datos.ajustes) {
        return browser.storage.local.set({ ajustes: {} });
      }
      return null;
    })
    .catch(() => {});
});

// Pestañas ya abiertas al iniciar el navegador: solo hace falta revisarlas si
// hay algún sitio activado (con cero sitios, arrancar no cuesta ni una IPC).
browser.runtime.onStartup?.addListener(() => {
  haySitios()
    .then((hay) => (hay ? browser.tabs.query({}) : []))
    .then((tabs) => {
      for (const tab of tabs) {
        asegurarPestana(tab.id).catch(() => {});
      }
    })
    .catch(() => {});
});
