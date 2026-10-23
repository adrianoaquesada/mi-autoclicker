/**
 * Configuración de web-ext (CommonJS).
 * Documentación: https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/
 *
 * Ignora todo lo que no forma parte del paquete que se envía a AMO.
 */
module.exports = {
  ignoreFiles: [
    "tools/**",
    "tests/**",
    "dist/**",
    "web-ext-artifacts/**",
    "node_modules/**",
    "package.json",
    "package-lock.json",
    "web-ext-config.cjs",
    ".gitignore",
    "**/*.md",
  ],
};
