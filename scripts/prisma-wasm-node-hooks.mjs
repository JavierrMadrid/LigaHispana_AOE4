/**
 * Ganchos de carga de módulos para el WASM del compilador de Prisma en Node.
 *
 * Vive en su propio fichero porque `module.register()` —la API con la que se
 * registran, y que es la que funciona con tsx en Node 22.22— exige que los
 * ganchos estén en un módulo distinto del que se importa con `--import`. La
 * razón de fondo está en `scripts/prisma-wasm-node.mjs`, que es el punto de
 * entrada y donde se cuenta el problema entero.
 */

import { fileURLToPath } from "node:url";

/** Sufijo con el que los empaquetadores importan WASM. */
const WASM_MODULE_SUFFIX = "?module";

/**
 * Marca que se añade a la URL resuelta.
 *
 * Hace falta porque el gancho `load` solo recibe la URL final: con el `?module`
 * ya quitado, una URL de fichero `foo.wasm` sería indistinguible de cualquier
 * otra importación de WASM legítima de Node.
 */
const MARKER = "prisma-wasm-module";

/**
 * `"./query_compiler_fast_bg.wasm?module"` → la URL del `.wasm` con la marca
 * puesta. Se decide en `resolve` (y no en `load`) para que Node sepa desde el
 * principio que es CommonJS con fuente propia, y para que la ruta final no se
 * lea dos veces del disco.
 */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith(`.wasm${WASM_MODULE_SUFFIX}`)) {
    return nextResolve(specifier, context);
  }

  const url = new URL(specifier.slice(0, -WASM_MODULE_SUFFIX.length), context.parentURL);

  return { url: `${url.href}?${MARKER}`, format: "commonjs", shortCircuit: true };
}

/**
 * El módulo que Prisma recibe en lugar del WASM.
 *
 * Leer y compilar los bytes va dentro del `source` que se devuelve, no aquí en
 * el gancho: el gancho solo **describe** el módulo, y el trabajo ocurre cuando
 * Node lo evalúa, que es un paso perezoso (solo si alguien importa el WASM) y
 * cacheado por URL. Es justo lo que espera Prisma: `loadQueryCompiler` ya
 * memoiza por proveedor, así que el WASM se compila una vez por proceso.
 *
 * Se exporta el módulo **y** una autorreferencia en `default`, más
 * `__esModule`, porque las tres formas de consumo dan cosas distintas y
 * Prisma solo necesita una:
 *
 * - `require(...)` tal cual → el `WebAssembly.Module`.
 * - El envoltorio de interoperabilidad de esbuild/tsx, que copia `module.exports`
 *   a `default` salvo que `__esModule` lo diga → el `WebAssembly.Module`.
 * - `import(...)` de ESM sobre un módulo CommonJS → `default` es
 *   `module.exports` → el `WebAssembly.Module`.
 *
 * Con las tres, `const { default: module } = ...` recibe el módulo sea cual sea
 * el formato en que tsx haya compilado el cliente.
 */
export async function load(url, context, nextLoad) {
  const marker = `?${MARKER}`;

  if (!url.endsWith(marker)) {
    return nextLoad(url, context);
  }

  const path = fileURLToPath(url.slice(0, url.length - marker.length));

  return {
    shortCircuit: true,
    format: "commonjs",
    source: [
      'const { readFileSync } = require("node:fs");',
      `const wasm = new WebAssembly.Module(readFileSync(${JSON.stringify(path)}));`,
      "module.exports = wasm;",
      "module.exports.default = wasm;",
      "module.exports.__esModule = true;",
    ].join("\n"),
  };
}