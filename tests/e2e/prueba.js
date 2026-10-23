"use strict";

/**
 * Prueba E2E: ejecuta la extensión en un Firefox REAL (headless, perfil
 * aparte, sin tocar el Firefox del usuario) y comprueba que los clics se
 * producen de verdad en una página servida por http.
 *
 * Prepara la variante de prueba antes de lanzarse (ver preparar.py).
 *
 * Fases:
 *   1. Sin haber movido el ratón  → debe clicar en el centro de la ventana.
 *   2. Moviendo el ratón al botón → debe clicar justo ahí.
 *   3. Pulsar F8                  → debe pausar; otra vez F8 → reanudar.
 *
 * Uso:  npm run test:e2e   (o  node tests/e2e/prueba.js tras preparar.py)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Builder, By, Key } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

const PAGINA = path.join(__dirname, "..", "pagina-prueba.html");
const XPI = path.join(__dirname, "ext.xpi");

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

/** Puerto libre empezando en 8765 (no pisa un servidor ya en marcha). */
async function puertoLibre(inicio) {
  for (let puerto = inicio; puerto < inicio + 20; puerto++) {
    const libre = await new Promise((resolver) => {
      const s = http.createServer();
      s.once("error", () => resolver(false));
      s.listen(puerto, "127.0.0.1", () => s.close(() => resolver(true)));
    });
    if (libre) return puerto;
  }
  throw new Error("no hay puertos libres");
}

async function leerEstado(driver) {
  return driver.executeScript(`
    const host = [...document.querySelectorAll("div")].find(
      (d) => d.shadowRoot && d.shadowRoot.querySelector("[data-cps]")
    );
    return {
      clics: window.__clics || 0,
      boton: window.__boton || 0,
      ultimo: window.__ultimo,
      raton: window.__raton,
      errores: window.__errores || [],
      indicador: Boolean(host),
      indicadorVisible: Boolean(host) && host.style.display !== "none",
      cps: host ? host.shadowRoot.querySelector("[data-cps]").textContent : null,
    };
  `);
}

async function main() {
  const puerto = await puertoLibre(8765);
  const urlPrueba = `http://127.0.0.1:${puerto}/`;

  console.log("\nPreparando la variante de prueba…");
  execFileSync("python3", [path.join(__dirname, "preparar.py")], {
    stdio: "inherit",
    env: { ...process.env, PUERTO_E2E: String(puerto) },
  });

  const html = fs.readFileSync(PAGINA);
  const servidor = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise((r) => servidor.listen(puerto, "127.0.0.1", r));

  const opciones = new firefox.Options();
  opciones.addArguments("--headless");
  opciones.setPreference("browser.shell.checkDefaultBrowser", false);

  console.log("\nArrancando Firefox (headless, perfil temporal)…");
  const driver = await new Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(opciones)
    .build();

  try {
    await driver.installAddon(XPI, true);
    ok(true, "extensión instalada temporalmente en un Firefox real");

    console.log("\n1. Sin haber movido el ratón (fallback al centro)");
    await driver.get(urlPrueba);
    await esperar(2500);
    let e = await leerEstado(driver);
    ok(e.indicadorVisible, "el indicador del autoclicker aparece en la página");
    ok(e.cps === "10", `el indicador muestra los CPS (cps=${e.cps})`);
    ok(e.clics > 0, `hace clics sin que el ratón haya entrado en la página (${e.clics})`);
    ok(e.boton > 0, `los clics caen en el botón del centro (${e.boton})`);
    ok(e.errores.length === 0, `sin errores en la página: ${JSON.stringify(e.errores)}`);

    console.log("\n2. Moviendo el ratón hasta el botón");
    const boton = await driver.findElement(By.id("b"));
    await driver.actions().move({ origin: boton }).perform();
    const corte2 = e.clics;
    await esperar(1200);
    e = await leerEstado(driver);
    ok(e.clics > corte2, `sigue clicando tras mover el ratón (+${e.clics - corte2})`);
    ok(e.ultimo && e.ultimo.trusted === false, "el clic lo emite el motor (isTrusted: false, esperado)");
    ok(
      e.ultimo && e.raton && Math.abs(e.ultimo.x - e.raton.x) < 40,
      `el clic cae donde está el ratón (${e.ultimo && e.ultimo.x},${e.ultimo && e.ultimo.y} / ratón ${
        e.raton && e.raton.x
      },${e.raton && e.raton.y})`
    );

    console.log("\n3. Tecla rápida F8 (pausa / reanuda)");
    const corte3 = e.clics;
    await driver.actions().sendKeys(Key.F8).perform();
    await esperar(900);
    e = await leerEstado(driver);
    ok(e.clics === corte3, `F8 pausa los clics (${e.clics - corte3} clics durante la pausa)`);
    ok(!e.indicadorVisible, "en pausa el indicador se oculta");

    await driver.actions().sendKeys(Key.F8).perform();
    await esperar(900);
    e = await leerEstado(driver);
    ok(e.clics > corte3, `otra vez F8 reanuda (+${e.clics - corte3})`);
  } finally {
    await driver.quit().catch(() => {});
    servidor.close();
  }

  console.log(`\n${comprobaciones - fallos}/${comprobaciones} comprobaciones correctas`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Error en la prueba E2E:", error);
  process.exit(1);
});
