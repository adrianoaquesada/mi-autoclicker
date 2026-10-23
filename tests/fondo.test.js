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
  const oyentes = { mensaje: [], actualizada: [], activada: [], eliminada: [], quitados: [], instalado: [] };
  const badges = new Map();
  const estadoApi = {
    fallarInyeccion: false,
    inyecciones: [],
    inyectadas: new Set(), // pestañas con el content script presente
  };

  const api = {
    storage: {
      local: {
        get: async (claves) => {
          if (claves && typeof claves === "object" && !Array.isArray(claves)) {
            const salida = {};
            for (const [clave, defecto] of Object.entries(claves)) {
              salida[clave] = estado[clave] != null ? estado[clave] : defecto;
            }
            return salida;
          }
          return { ...estado };
        },
        set: async (valores) => Object.assign(estado, valores),
      },
    },
    permissions: {
      contains: async ({ origins }) => origins.every((p) => permisos.has(p)),
      remove: async ({ origins }) => {
        for (const p of origins) permisos.delete(p);
        for (const fn of oyentes.quitados) fn({ origins });
      },
      onRemoved: { addListener: (fn) => oyentes.quitados.push(fn) },
    },
    tabs: {
      get: async (id) => {
        const pestana = pestañas.get(id);
        if (!pestana) throw new Error("pestaña inexistente");
        return { ...pestana };
      },
      query: async (consulta = {}) => {
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
        estadoApi.inyecciones.push(operacion);
        estadoApi.inyectadas.add(operacion.target.tabId);
      },
    },
    action: {
      setBadgeText: async ({ tabId, text }) => {
        badges.set(tabId, text);
      },
    },
    runtime: {
      onMessage: { addListener: (fn) => oyentes.mensaje.push(fn) },
      onInstalled: { addListener: (fn) => oyentes.instalado.push(fn) },
    },
    i18n: { getMessage: (clave) => `i18n:${clave}` },
  };

  return { api, estado, permisos, pestañas, badges, oyentes, estadoApi, avisos, avisosConsola };
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
  ext.estado.sitios[ORIGEN] = true;
  await ext.api.permissions.remove({ origins: [PATRON] });
  await new Promise((resolver) => setTimeout(resolver, 50));
  ok(!ext.estado.sitios[ORIGEN], "limpia el sitio cuyo permiso desapareció");

  console.log(`\n${comprobaciones - fallos}/${comprobaciones} comprobaciones correctas`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Error inesperado en las pruebas:", error);
  process.exit(1);
});
