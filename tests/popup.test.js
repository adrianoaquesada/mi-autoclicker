"use strict";

/**
 * Pruebas del panel (popup/popup.html + popup/popup.js) en jsdom.
 *
 * Uso:  npm test   (o  node tests/popup.test.js)
 *
 * Cubren el camino completo de activación que ve el usuario:
 *   cargar → mostrar estado → pulsar «Activar» → pedir permiso →
 *   avisar al fondo → reflejar el resultado real (nunca «Activo» mentiroso).
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const RAIZ = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(RAIZ, "popup", "popup.html"), "utf8");
const CODIGO = fs.readFileSync(path.join(RAIZ, "popup", "popup.js"), "utf8");

const ORIGEN = "http://127.0.0.1:8765";
const PATRON = `${ORIGEN}/*`;
const URL_PESTANA = `${ORIGEN}/pagina-prueba.html`;

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

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stub de las APIs que usa el panel. */
function crearApi(opciones = {}) {
  const {
    permisoYaConcedido = false,
    solicitud = "concedida", // concedida | denegada
    respuestaActivar = { ok: true, inyectado: true },
    sitiosIniciales = {},
    // "corriendo": el content script está vivo y corre (tras su carga
    // inicial);  "ausente": no hay content script en la pestaña (la
    // mensajería falla, como en Firefox cuando la inyección no ocurrió).
    pestana = "ausente",
  } = opciones;

  const registro = { pedidosPermiso: [], mensajes: [], escrituras: [], eventos: [] };
  const estadoStorage = {};

  const api = {
    i18n: { getMessage: (clave) => `t:${clave}` },
    tabs: {
      query: async () => [{ id: 7, url: URL_PESTANA }],
      sendMessage: async () => {
        if (pestana === "ausente") throw new Error("Could not establish connection");
        return { ok: true, armado: true, corriendo: pestana === "corriendo", contador: 0 };
      },
    },
    permissions: {
      contains: async () => permisoYaConcedido,
      request: async (p) => {
        registro.pedidosPermiso.push(p);
        registro.eventos.push("request");
        return solicitud === "concedida";
      },
    },
    storage: {
      local: {
        get: async (claves) => {
          const salida = {};
          for (const [clave, defecto] of Object.entries(claves)) salida[clave] = defecto;
          if (Object.keys(sitiosIniciales).length) salida.sitios = sitiosIniciales;
          return { ...salida, ...estadoStorage };
        },
        set: async (valores) => {
          Object.assign(estadoStorage, valores);
          registro.escrituras.push({ ...valores });
          registro.eventos.push(`set:${Object.keys(valores).join(",")}`);
        },
      },
    },
    runtime: {
      sendMessage: async (mensaje) => {
        registro.mensajes.push(mensaje);
        return respuestaActivar;
      },
      openOptionsPage: async () => {},
    },
  };

  return { api, registro };
}

async function abrirPanel(opciones) {
  const ext = crearApi(opciones);
  const dom = new JSDOM(HTML, {
    url: "about:blank",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  dom.window.browser = ext.api;
  dom.window.eval(CODIGO);
  await esperar(40); // iniciar() es asíncrono
  return { dom, ...ext };
}

const texto = (ventana, id) => {
  const nodo = ventana.document.getElementById(id);
  return nodo ? nodo.textContent : null;
};

async function main() {
  console.log("\n1. El panel carga y refleja el sitio");
  let { dom, registro } = await abrirPanel();
  let v = dom.window;
  ok(texto(v, "host") === new URL(URL_PESTANA).host, `muestra el host del sitio (${texto(v, "host")})`);
  const boton = v.document.getElementById("alternar");
  ok(boton && boton.disabled === false, "el botón de activar está habilitado");
  ok(texto(v, "alternar") === "t:activarSitio", `el botón dice «Activar» (${texto(v, "alternar")})`);
  ok(texto(v, "aviso") === "t:sitioSinPermiso", "avisa de que el sitio aún no tiene permiso");
  dom.window.close();

  console.log("\n2. Pulsar «Activar» pide permiso y activa el sitio");
  ({ dom, registro } = await abrirPanel({ pestana: "corriendo" }));
  v = dom.window;
  v.document
    .getElementById("alternar")
    .dispatchEvent(new v.MouseEvent("click", { bubbles: true }));
  await esperar(60);
  ok(registro.pedidosPermiso.length === 1, "pidió el permiso del origen");
  ok(
    registro.pedidosPermiso[0] && registro.pedidosPermiso[0].origins[0] === PATRON,
    `el patrón pedido es ${PATRON}`
  );
  ok(registro.mensajes.length === 1 && registro.mensajes[0].tipo === "activar", "avisó al fondo (activar)");
  ok(
    registro.mensajes[0].origen === ORIGEN && registro.mensajes[0].tabId === 7,
    "envía el origen y la pestaña correctos"
  );
  ok(texto(v, "alternar") === "t:desactivarSitio", "el botón pasa a «Desactivar»");
  ok(texto(v, "chip") === "t:estadoActivo", "el chip pasa a «Activo»");
  ok(texto(v, "aviso") === "", "sin avisos: la activación fue limpia");
  dom.window.close();

  console.log("\n3. Si el usuario deniega el permiso");
  ({ dom, registro } = await abrirPanel({ solicitud: "denegada" }));
  v = dom.window;
  v.document
    .getElementById("alternar")
    .dispatchEvent(new v.MouseEvent("click", { bubbles: true }));
  await esperar(60);
  ok(registro.mensajes.length === 0, "NO activa el sitio si no hay permiso");
  ok(texto(v, "aviso") === "t:permisoDenegado", "muestra el aviso de permiso denegado");
  ok(texto(v, "alternar") === "t:activarSitio", "el botón sigue en «Activar»");
  dom.window.close();

  console.log("\n4. Si la inyección falla, el panel no miente");
  ({ dom, registro } = await abrirPanel({ respuestaActivar: { ok: true, inyectado: false } }));
  v = dom.window;
  v.document
    .getElementById("alternar")
    .dispatchEvent(new v.MouseEvent("click", { bubbles: true }));
  await esperar(60);
  ok(texto(v, "aviso") === "t:noInyectado", "muestra el aviso de inyección fallida");
  ok(texto(v, "chip") === "t:estadoInactivo", "el chip NO se pone en «Activo»");
  dom.window.close();

  console.log("\n5. Sitio ya activo y con permiso");
  ({ dom, registro } = await abrirPanel({
    permisoYaConcedido: true,
    sitiosIniciales: { [ORIGEN]: true },
    pestana: "corriendo",
  }));
  v = dom.window;
  ok(texto(v, "alternar") === "t:desactivarSitio", "arranca en «Desactivar» (el sitio ya está activo)");
  ok(texto(v, "aviso") === "", "sin avisos");
  v.document
    .getElementById("alternar")
    .dispatchEvent(new v.MouseEvent("click", { bubbles: true }));
  await esperar(60);
  ok(
    registro.mensajes.length === 1 && registro.mensajes[0].tipo === "desactivar",
    "al pulsar de nuevo desactiva el sitio"
  );
  ok(registro.pedidosPermiso.length === 0, "no vuelve a pedir permiso");
  dom.window.close();

  console.log("\n6. El panel deja la intención de activación antes de pedir el permiso");
  // Firefox cierra el panel al mostrar el diálogo de permiso: sin esta
  // intención guardada el usuario tendría que volver a pulsar «Activar».
  ({ dom, registro } = await abrirPanel({ pestana: "corriendo" }));
  v = dom.window;
  v.document
    .getElementById("alternar")
    .dispatchEvent(new v.MouseEvent("click", { bubbles: true }));
  await esperar(60);
  ok(
    registro.eventos[0] === "set:activacionPendiente" && registro.eventos[1] === "request",
    `guarda la intención ANTES de pedir el permiso (${registro.eventos.join(" → ")})`
  );
  const pendiente = registro.escrituras[0] && registro.escrituras[0].activacionPendiente;
  ok(
    pendiente && pendiente.origen === ORIGEN && pendiente.tabId === 7,
    "la intención guarda el origen y la pestaña correctos"
  );
  ok(
    registro.escrituras.some((w) => w.activacionPendiente === null),
    "limpia la intención cuando el panel sobrevive (la completará él mismo)"
  );
  dom.window.close();

  console.log(`\n${comprobaciones - fallos}/${comprobaciones} comprobaciones correctas`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Error inesperado en las pruebas del panel:", error);
  process.exit(1);
});
