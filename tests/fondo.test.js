"use strict";

/**
 * Pruebas del script de fondo (background.js) con un objeto `browser` falso.
 *
 * Uso:  npm test   (o  node tests/fondo.test.js)
 *
 * Verifican el camino que el panel usa al activar un sitio:
 * guardar el sitio, inyectar el content script y devolver un estado real
 * (no un «ok» optimista) para que el panel no muestre «Activo» mentiroso.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CODIGO = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

let fallos = 0;
let comprobaciones = 0;

function ok(condicion, texto) {
  comprobaciones += 1;
  if (condicion) {
    console.log(`  ok   ${texto}`);
  } else {
    fallos += 1;
    console.error(`  FALLO ${texto}`);
  }
}

/** Stub mínimo de las APIs de WebExtensions que usa background.js. */
function crearApi() {
  const estado = { sitios: {}, ajustes: {} };
  const permisos = new Set(); // patrones «https://x/*»
  const pestañas = new Map(); // id -> { id, url, active }
  const avisos = [];
  const avisosConsola = [];
  const oyentes = {
    mensaje: [],
    actualizada: [],
    activada: [],
    eliminada: [],
    quitados: [],
    anadidos: [],
    instalado: [],
    cambiados: [],
    arranque: [],
  };
  const badges = new Map();
  // Llamadas a las APIs: sirven para comprobar el coste de un evento
  // (cada una es una IPC real en Firefox).
  const contadores = {
    lecturasStorage: 0,
    escriturasStorage: 0,
    consultaPestanas: 0,
    consultaPestana: 0,
    badge: 0,
    inyecciones: 0,
  };
  const estadoApi = {
    fallarInyeccion: false,
    inyecciones: [],
    inyectadas: new Set(), // pestañas con el content script presente
  };

  const api = {
    storage: {
      local: {
        get: async (claves) => {
          contadores.lecturasStorage += 1;
          if (claves && typeof claves === "object" && !Array.isArray(claves)) {
            const salida = {};
            for (const [clave, defecto] of Object.entries(claves)) {
              salida[clave] = estado[clave] != null ? estado[clave] : defecto;
            }
            return salida;
          }
          return { ...estado };
        },
        set: async (valores) => {
          contadores.escriturasStorage += 1;
          const cambios = {};
          for (const [clave, valor] of Object.entries(valores)) {
            cambios[clave] = { oldValue: estado[clave], newValue: valor };
          }
          Object.assign(estado, valores);
          for (const fn of oyentes.cambiados) fn(cambios, "local");
        },
      },
      onChanged: { addListener: (fn) => oyentes.cambiados.push(fn) },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((p) => permisos.has(p)),
      remove: async ({ origins }) => {
        for (const p of origins) permisos.delete(p);
        for (const fn of oyentes.quitados) fn({ origins });
      },
      onRemoved: { addListener: (fn) => oyentes.quitados.push(fn) },
      onAdded: { addListener: (fn) => oyentes.anadidos.push(fn) },
    },
    tabs: {
      get: async (id) => {
        contadores.consultaPestana += 1;
        const pestana = pestañas.get(id);
        if (!pestana) throw new Error("pestaña inexistente");
        return { ...pestana };
      },
      query: async (consulta = {}) => {
        contadores.consultaPestanas += 1;
        let salida = [...pestañas.values()];
        if (consulta.active) salida = salida.filter((p) => p.active);
        return salida.map((p) => ({ ...p }));
      },
      sendMessage: async (id, mensaje) => {
        if (mensaje && mensaje.tipo === "ping" && !estadoApi.inyectadas.has(id)) {
          throw new Error("content script no presente");
        }
        return { ok: true };
      },
      onUpdated: { addListener: (fn) => oyentes.actualizada.push(fn) },
      onActivated: { addListener: (fn) => oyentes.activada.push(fn) },
      onRemoved: { addListener: (fn) => oyentes.eliminada.push(fn) },
    },
    scripting: {
      executeScript: async (operacion) => {
        if (estadoApi.fallarInyeccion) throw new Error("inyección rechazada");
        contadores.inyecciones += 1;
        estadoApi.inyecciones.push(operacion);
        estadoApi.inyectadas.add(operacion.target.tabId);
      },
    },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        contadores.badge += 1;
        badges.set(tabId, text);
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => oyentes.mensaje.push(fn) },
      onInstalled: { addListener: (fn) => oyentes.instalado.push(fn) },
      onStartup: { addListener: (fn) => oyentes.arranque.push(fn) },
    },
    i18n: { getMessage: (clave) => `i18n:${clave}` },
  };

  return {
    api,
    estado,
    permisos,
    pestañas,
    badges,
    oyentes,
    contadores,
    estadoApi,
    avisos,
    avisosConsola,
  };
}

function cargarFondo(ext) {
  const sandbox = {
    browser: ext.api,
    URL,
    Map,
    Set,
    Promise,
    Date,
    Math,
    Boolean,
    Number,
    String,
    Object,
    Array,
    console: {
      log: () => {},
      warn: (...args) => ext.avisosConsola.push(args.join(" ")),
      error: (...args) => ext.avisosConsola.push(args.join(" ")),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODIGO, sandbox);
  return sandbox;
}

async function main() {
  const ext = crearApi();
  const ORIGEN = "https://ejemplo.com";
  const PATRON = `${ORIGEN}/*`;

  ext.pestañas.set(1, { id: 1, url: `${ORIGEN}/juego`, active: true });
  ext.permisos.add(PATRON); // el usuario acaba de conceder el permiso

  cargarFondo(ext);
  ok(ext.oyentes.mensaje.length === 1, "listener de runtime.onMessage registrado");
  const enviar = (mensaje, remitente = null) => ext.oyentes.mensaje[0](mensaje, remitente);

  console.log("\n1. Activar un sitio con permiso");
  const activar = await enviar({ tipo: "activar", tabId: 1, origen: ORIGEN });
  ok(activar && activar.ok === true, "responde ok");
  ok(activar && activar.inyectado === true, "informa que la inyección se completó");
  ok(ext.estado.sitios[ORIGEN] === true, "el sitio queda guardado en storage");
  ok(ext.estadoApi.inyecciones.length === 1, "se inyectó content.js exactamente una vez");
  ok(ext.badges.get(1) === "ON", "el badge de la pestaña queda en «ON»");

  console.log("\n2. Consulta de estado (lo que lee el panel)");
  const estado = await enviar({ tipo: "estado", corriendo: true }, { tab: { id: 1 } });
  ok(estado && estado.ok === true, "acepta el estado del content script");
  ok(ext.badges.get(1) === "ON", "el badge sigue en «ON» con el sitio activo");

  console.log("\n3. Desactivar el sitio (tabId de la pestaña)");
  const desactivar = await enviar({ tipo: "desactivar", tabId: 1, origen: ORIGEN });
  ok(desactivar && desactivar.ok === true, "responde ok");
  ok(!ext.estado.sitios[ORIGEN], "el sitio desaparece del storage");
  ok(ext.badges.get(1) === "", "el badge se borra");
  ok(ext.permisos.has(PATRON) === false, "el permiso del origen se revoca");

  console.log("\n4. Activar sin permiso concedido");
  const sinPermiso = await enviar({ tipo: "activar", tabId: 1, origen: "https://sin-permiso.org" });
  ok(sinPermiso && sinPermiso.ok === false, "rechaza con ok: false");
  ok(sinPermiso && sinPermiso.motivo === "sinPermiso", "el motivo es «sinPermiso»");
  ok(!ext.estado.sitios["https://sin-permiso.org"], "no guarda nada sin permiso");

  console.log("\n5. Activar cuando la inyección falla");
  ext.permisos.add("https://roto.org/*");
  ext.pestañas.set(2, { id: 2, url: "https://roto.org/", active: false });
  ext.estadoApi.fallarInyeccion = true;
  const roto = await enviar({ tipo: "activar", tabId: 2, origen: "https://roto.org" });
  ok(roto && roto.ok === true, "el sitio sí queda activo");
  ok(roto && roto.inyectado === false, "pero avisa de que NO se inyectó (no miente)");
  ok(
    ext.avisosConsola.some((t) => t.includes("no se pudo inyectar")),
    "deja constancia del error en la consola"
  );
  ext.estadoApi.fallarInyeccion = false;

  console.log("\n6. Desactivar desde la página de opciones (tabId null)");
  ext.permisos.add(PATRON);
  const reactivar = await enviar({ tipo: "activar", tabId: 1, origen: ORIGEN });
  ok(reactivar && reactivar.ok === true, "se reactiva el sitio");
  ok(ext.badges.get(1) === "ON", "el badge vuelve a «ON»");
  const opciones = await enviar({ tipo: "desactivar", tabId: null, origen: ORIGEN });
  ok(opciones && opciones.ok === true, "responde ok");
  ok(ext.badges.get(1) === "", "refresca la pestaña activa («ON» → vacío)");

  console.log("\n7. Revocación de permisos desde about:addons");
  ext.permisos.add(PATRON);
  // Se escribe por la API (como hace la página de opciones) para que la caché
  // del fondo se entere vía storage.onChanged.
  await ext.api.storage.local.set({ sitios: { [ORIGEN]: true } });
  await ext.api.permissions.remove({ origins: [PATRON] });
  await new Promise((resolver) => setTimeout(resolver, 50));
  ok(!ext.estado.sitios[ORIGEN], "limpia el sitio cuyo permiso desapareció");

  console.log("\n8. El panel se cierra con el diálogo de permiso (activación pendiente)");
  // Firefox muestra el diálogo de permiso robando el foco y cierra el panel,
  // por lo que el panel no puede enviar «activar»: deja la intención guardada
  // y el fondo la retoma cuando el permiso llega.
  ext.permisos.add(PATRON); // el usuario acaba de concederlo en el diálogo
  ext.estado.activacionPendiente = { origen: ORIGEN, tabId: 1, ts: Date.now() };
  await ext.oyentes.anadidos[0]({ origins: [PATRON] });
  await new Promise((resolver) => setTimeout(resolver, 50));
  ok(ext.estado.sitios[ORIGEN] === true, "completa la activación pendiente tras conceder el permiso");
  ok(ext.badges.get(1) === "ON", "el badge pasa a «ON» sin volver a pulsar el botón");
  ok(ext.estado.activacionPendiente === null, "la intención pendiente queda consumida");

  console.log("\n9. Un permiso de otro sitio no completa la activación");
  await ext.api.storage.local.set({ sitios: {} });
  ext.estado.activacionPendiente = { origen: "https://otro.org", tabId: 1, ts: Date.now() };
  await ext.oyentes.anadidos[0]({ origins: ["https://ajeno.org/*"] });
  await new Promise((resolver) => setTimeout(resolver, 50));
  ok(!ext.estado.sitios["https://otro.org"], "no activa un sitio cuyo permiso no se concedió");
  ok(Boolean(ext.estado.activacionPendiente), "la intención sigue pendiente para su permiso");

  console.log("\n10. Una intención vieja se ignora y se limpia");
  ext.estado.activacionPendiente = { origen: "https://viejo.org", tabId: 999, ts: Date.now() - 5 * 60 * 1000 };
  ext.permisos.add("https://viejo.org/*");
  await ext.oyentes.anadidos[0]({ origins: ["https://viejo.org/*"] });
  await new Promise((resolver) => setTimeout(resolver, 50));
  ok(!ext.estado.sitios["https://viejo.org"], "no activa un sitio con una intención caducada");
  ok(ext.estado.activacionPendiente === null, "limpia la intención caducada");

  console.log("\n11. Atajo: con cero sitios activos, los eventos no cuestan IPC");
  await ext.api.storage.local.set({ sitios: {} });
  // Primer evento: si el badge quedó en «ON» de las pruebas anteriores, lo
  // limpia (una escritura) y desde ahí lo recuerda en memoria.
  ext.oyentes.activada[0]({ tabId: 1 });
  await new Promise((resolver) => setTimeout(resolver, 30));
  ok(ext.badges.get(1) === "", "el badge de la pestaña queda vacío");

  const base = { ...ext.contadores };
  ext.oyentes.activada[0]({ tabId: 1 }); // conmutar de pestaña
  ext.oyentes.actualizada[0](1, { status: "complete" }, { id: 1, url: `${ORIGEN}/juego` }); // cargar página
  ext.oyentes.arranque[0](); // arrancar el navegador
  await new Promise((resolver) => setTimeout(resolver, 50));

  ok(
    ext.contadores.consultaPestana === base.consultaPestana,
    "conmutar de pestaña no consulta la pestaña"
  );
  ok(
    ext.contadores.consultaPestanas === base.consultaPestanas,
    "arrancar no enumera las pestañas abiertas"
  );
  ok(ext.contadores.badge === base.badge, "no vuelve a escribir un badge ya vacío");
  ok(
    ext.contadores.lecturasStorage === base.lecturasStorage,
    "lee los sitios de la caché, no de storage"
  );
  ok(ext.contadores.inyecciones === base.inyecciones, "no inyecta nada");

  console.log(`\n${comprobaciones - fallos}/${comprobaciones} comprobaciones correctas`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Error inesperado en las pruebas:", error);
  process.exit(1);
});
