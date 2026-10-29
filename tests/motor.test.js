"use strict";

/**
 * Pruebas del motor de clics (content.js) ejecutado en un DOM de jsdom.
 *
 * Uso:  npm test   (o  node tests/motor.test.js)
 *
 * No necesita Firefox: simulamos el objeto `browser` de WebExtensions,
 * el `elementFromPoint` (que jsdom no implementa) y los eventos de puntero
 * y teclado que dispararía un usuario real.
 */

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const CODIGO = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

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

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

/** Stub mínimo de la API de WebExtensions usado por content.js. */
function crearApi() {
  const estado = { ajustes: null, sitios: {} };
  const oyentesCambio = [];
  const oyentesMensaje = [];
  const enviados = [];

  const api = {
    storage: {
      local: {
        get: async (claves) => {
          const salida = {};
          if (Array.isArray(claves)) {
            for (const clave of claves) salida[clave] = estado[clave];
          } else if (claves && typeof claves === "object") {
            for (const [clave, defecto] of Object.entries(claves)) {
              salida[clave] = estado[clave] != null ? estado[clave] : defecto;
            }
          } else {
            Object.assign(salida, estado);
          }
          return salida;
        },
        set: async (valores) => {
          const cambios = {};
          for (const [clave, valor] of Object.entries(valores)) {
            cambios[clave] = { oldValue: estado[clave], newValue: valor };
            estado[clave] = valor;
          }
          for (const oyente of oyentesCambio) oyente(cambios, "local");
        },
      },
      onChanged: { addListener: (fn) => oyentesCambio.push(fn) },
    },
    runtime: {
      sendMessage: async (mensaje) => {
        enviados.push(mensaje);
        return { ok: true };
      },
      onMessage: { addListener: (fn) => oyentesMensaje.push(fn) },
    },
    i18n: { getMessage: (clave) => `i18n:${clave}` },
  };

  return { api, estado, oyentesMensaje, enviados };
}

async function main() {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><button id="obj">Clic</button></body></html>',
    { url: "https://ejemplo.com/juego", pretendToBeVisual: true, runScripts: "outside-only" }
  );
  const { window } = dom;
  const { document } = window;

  // jsdom no implementa elementFromPoint: devolvemos el objetivo activo.
  let objetivo = null;
  document.elementFromPoint = () => objetivo;

  const ext = crearApi();
  window.browser = ext.api;

  console.log("\n1. Inyección");
  window.eval(CODIGO);
  ok(window.__MI_AUTOCLICKER_MOTOR__ === true, "guarda de idempotencia instalada");
  await esperar(30);

  const boton = document.getElementById("obj");
  objetivo = boton;

  // Registro de eventos recibidos por el botón, en orden.
  const recibidos = [];
  for (const tipo of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "auxclick",
    "contextmenu",
  ]) {
    boton.addEventListener(tipo, (evento) =>
      recibidos.push({ tipo, button: evento.button, x: evento.clientX })
    );
  }

  // El usuario mueve el ratón hasta el botón. En Firefox eso llega como
  // pointermove (y como mousemove solo si no hay PointerEvent, que es el
  // listener que content.js registra en ese caso).
  const hayPointer = typeof window.PointerEvent === "function";
  window.dispatchEvent(
    hayPointer
      ? new window.PointerEvent("pointermove", { clientX: 40, clientY: 40, bubbles: true })
      : new window.MouseEvent("mousemove", { clientX: 40, clientY: 40, bubbles: true })
  );

  console.log("\n2. Sitio desactivado");
  await esperar(300);
  ok(recibidos.length === 0, "no hace clics mientras el sitio está desactivado");

  console.log("\n3. Activar el sitio (modo continuo, 10 CPS)");
  await ext.api.storage.local.set({
    ajustes: { cps: 10, tipoClic: "izquierdo", modo: "continuo", tecla: "F8", mostrarIndicador: true },
  });
  await ext.api.storage.local.set({ sitios: { "https://ejemplo.com": true } });
  await esperar(400);
  const clics = recibidos.filter((r) => r.tipo === "click");
  ok(clics.length >= 2, `hace clics continuos (${clics.length} en 400 ms)`);

  const secuencia = recibidos
    .slice(0, 5)
    .map((r) => r.tipo)
    .join(" → ");
  ok(
    secuencia === "pointerdown → mousedown → pointerup → mouseup → click",
    `secuencia de eventos real: ${secuencia}`
  );
  ok(clics.every((c) => c.button === 0), "clic izquierdo con button === 0");

  console.log("\n4. Indicador en la página");
  const host = document.documentElement.querySelector("div");
  ok(Boolean(host && host.shadowRoot), "indicador creado con Shadow DOM");
  const numero = host?.shadowRoot?.querySelector("[data-cps]");
  ok(numero && numero.textContent === "10", "el indicador muestra los CPS configurados");

  console.log("\n5. Tecla rápida F8 (pausa / reanuda)");
  let corte = recibidos.length;
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  await esperar(300);
  ok(recibidos.length === corte, "F8 pausa los clics");
  ok(host.style.display === "none", "el indicador se oculta en pausa");

  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  await esperar(300);
  ok(recibidos.length > corte, "F8 reanuda los clics");

  console.log("\n6. Tipo de clic: derecho");
  await ext.api.storage.local.set({
    ajustes: { cps: 10, tipoClic: "derecho", modo: "continuo", tecla: "F8", mostrarIndicador: true },
  });
  corte = recibidos.length;
  await esperar(350);
  const tiposDerecho = new Set(recibidos.slice(corte).map((r) => r.tipo));
  ok(tiposDerecho.has("contextmenu"), "dispara contextmenu");
  ok(!tiposDerecho.has("click"), "no dispara click al pulsar derecho");
  const menu = recibidos.slice(corte).find((r) => r.tipo === "contextmenu");
  ok(menu && menu.button === 2, "contextmenu con button === 2");

  console.log("\n7. Tipo de clic: central");
  await ext.api.storage.local.set({
    ajustes: { cps: 10, tipoClic: "central", modo: "continuo", tecla: "F8", mostrarIndicador: true },
  });
  corte = recibidos.length;
  await esperar(350);
  const tiposCentral = new Set(recibidos.slice(corte).map((r) => r.tipo));
  ok(tiposCentral.has("auxclick"), "dispara auxclick");
  const central = recibidos.slice(corte).find((r) => r.tipo === "auxclick");
  ok(central && central.button === 1, "auxclick con button === 1");

  console.log("\n8. Modo «mantener tecla»");
  await ext.api.storage.local.set({
    ajustes: { cps: 10, tipoClic: "izquierdo", modo: "mantener", tecla: "F8", mostrarIndicador: true },
  });
  await esperar(250);
  corte = recibidos.length;
  await esperar(300);
  ok(recibidos.length === corte, "sin tecla pulsada no hace clics");

  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  await esperar(350);
  ok(recibidos.length > corte, "manteniendo F8 hace clics");

  corte = recibidos.length;
  window.dispatchEvent(new window.KeyboardEvent("keyup", { key: "F8", bubbles: true }));
  await esperar(300);
  ok(recibidos.length === corte, "al soltar F8 se detiene");

  console.log("\n9. Tecla dentro de un campo de texto");
  const entrada = document.createElement("input");
  document.body.appendChild(entrada);
  entrada.focus();
  corte = recibidos.length;
  entrada.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  await esperar(300);
  ok(recibidos.length === corte, "la tecla rápida se ignora escribiendo en un input");

  console.log("\n10. Desactivar el sitio");
  await ext.api.storage.local.set({ ajustes: { ...{ cps: 10, tipoClic: "izquierdo", modo: "continuo", tecla: "F8", mostrarIndicador: true } } });
  await ext.api.storage.local.set({ sitios: {} });
  corte = recibidos.length;
  await esperar(350);
  ok(recibidos.length === corte, "desactivar detiene los clics");
  ok(host.style.display === "none", "el indicador se oculta al desactivar");

  console.log("\n11. Idempotencia (doble inyección)");
  await ext.api.storage.local.set({ sitios: { "https://ejemplo.com": true } });
  await esperar(200);
  window.eval(CODIGO); // segunda inyección en el mismo marco
  ok(window.__MI_AUTOCLICKER_MOTOR__ === true, "la guard sigue activa tras reinyectar");
  corte = recibidos.length;
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  await esperar(350);
  ok(
    recibidos.length === corte,
    "con doble inyección F8 pausa una sola vez (no hay listeners duplicados)"
  );

  console.log("\n12. Mensajería con el fondo");
  const oyente = ext.oyentesMensaje[0];
  ok(typeof oyente === "function", "listener de runtime.onMessage registrado");
  const ping = await oyente({ tipo: "ping" });
  ok(ping && ping.ok === true, "responde al ping");
  const consulta = await oyente({ tipo: "consulta" });
  ok(
    consulta && consulta.ok === true && typeof consulta.contador === "number" && consulta.cpsReales >= 0,
    "responde a la consulta con contador y CPS reales"
  );
  ok(
    ext.enviados.some((m) => m.tipo === "estado" && typeof m.corriendo === "boolean"),
    "informa del estado al fondo para el badge"
  );
  const detener = await oyente({ tipo: "detener" });
  ok(detener && detener.ok === true, "acepta el mensaje «detener»");

  // Reactivamos con F8 para verificar que «detener» realmente lo para.
  window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "F8", bubbles: true }));
  await esperar(300);
  ok(recibidos.length > corte, "reactivado con F8 antes de probar «detener»");
  corte = recibidos.length;
  await oyente({ tipo: "detener" });
  await esperar(300);
  ok(recibidos.length === corte, "tras «detener» ya no hace clics");

  console.log("\n13. Sin posición de puntero (el ratón nunca entró en la página)");
  const dom2 = new JSDOM(
    '<!doctype html><html><head></head><body><button id="obj2">Clic</button></body></html>',
    { url: "https://otro-sitio.org/", pretendToBeVisual: true, runScripts: "outside-only" }
  );
  const win2 = dom2.window;
  const objetivo2 = win2.document.getElementById("obj2");
  win2.document.elementFromPoint = () => objetivo2;
  const ext2 = crearApi();
  win2.browser = ext2.api;
  const recibidos2 = [];
  objetivo2.addEventListener("click", () => recibidos2.push(1));
  win2.eval(CODIGO); // sin ningún mousemove previo
  await ext2.api.storage.local.set({
    ajustes: { cps: 10, tipoClic: "izquierdo", modo: "continuo", tecla: "F8", mostrarIndicador: true },
  });
  await ext2.api.storage.local.set({ sitios: { "https://otro-sitio.org": true } });
  await esperar(400);
  ok(
    recibidos2.length >= 2,
    `hace clics en el centro de la ventana aunque el puntero nunca se haya visto (${recibidos2.length})`
  );
  dom2.window.close();

  console.log("\n14. Observer de iframes: solo mientras el sitio está armado");
  // El sitio sigue activado (pruebas 11-12): un iframe dinámico debe avisar
  // al fondo para que reinyecte en él.
  ext.enviados.length = 0;
  document.body.appendChild(document.createElement("iframe"));
  await esperar(400); // el aviso se debounced 300 ms
  ok(
    ext.enviados.some((m) => m.tipo === "marcoAniadido"),
    "con el sitio armado, un iframe dinámico avisa al fondo"
  );

  // Al desactivar el sitio el observer se desconecta: en reposo no debe
  // despertar con cada mutación del DOM.
  await ext.api.storage.local.set({ sitios: {} });
  await esperar(50);
  ext.enviados.length = 0;
  document.body.appendChild(document.createElement("iframe"));
  await esperar(400);
  ok(
    !ext.enviados.some((m) => m.tipo === "marcoAniadido"),
    "con el sitio desactivado, los iframes ya no avisan"
  );

  console.log(`\n${comprobaciones - fallos}/${comprobaciones} comprobaciones correctas`);
  dom.window.close();
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Error inesperado en las pruebas:", error);
  process.exit(1);
});
