/**
 * Carga del WASM del compilador de Prisma **en Node**, para los scripts de
 * `scripts/`.
 *
 *   node --import ./scripts/prisma-wasm-node.mjs ...
 *
 * (En los scripts de `package.json` viene detrás de `tsx`.)
 *
 * Este fichero es solo el **arranque**: comprueba la versión de Node y registra
 * los ganchos de carga, que viven en `prisma-wasm-node-hooks.mjs` porque
 * `module.register()` exige que estén en otro módulo (ver "La solución").
 *
 * ## El problema
 *
 * `prisma/schema.prisma` genera el cliente con `runtime = "workerd"` porque el
 * despliegue es un Worker de Cloudflare (OpenNext). Con el runtime por defecto
 * (`nodejs`) Prisma mete el compilador de consultas como WASM en base64 y lo
 * compila en runtime con `new WebAssembly.Module(...)`, que `workerd` prohíbe
 * por ser generación de código (prisma/prisma#28657). Con `workerd`, en cambio,
 * el `.wasm` se importa como módulo y lo enlaza el empaquetador:
 *
 * ```js
 * const { default: module } = await import("./query_compiler_fast_bg.wasm?module")
 * ```
 *
 * Los scripts de `scripts/` no pasan por ningún empaquetador: son Node con tsx.
 * Ahí hay dos cosas a la vez, y las dos hay que arreglarlas:
 *
 * 1. `?module` es una convención de empaquetadores. En Node forma parte del
 *    nombre de fichero, así que la importación apunta a un fichero que no existe.
 * 2. Aunque se arreglara lo anterior, la importación nativa de `.wasm` que hace
 *    Node devuelve el espacio de nombres de **exports** del módulo, sin `default`.
 *    Prisma hace `const { default: module } = ...` y recibe `undefined`.
 *
 * Con las dos cosas, la primera consulta falla con:
 *
 * ```
 * The loaded wasm module was unexpectedly `undefined` or `null` once loaded
 * ```
 *
 * que no dice nada de la causa real.
 *
 * ## La solución
 *
 * Ganchos de carga de módulos que sustituyen `"./x.wasm?module"` por un módulo
 * CommonJS que lee el `.wasm` del disco y lo compila, y lo publica como
 * `default`. Es el mismo `WebAssembly.Module` que recibe `workerd`, así que
 * Prisma no necesita enterarse de nada más.
 *
 * Se registran con **`module.register()`**, los ganchos asíncronos, y por eso
 * van en `prisma-wasm-node-hooks.mjs`: esa API exige un módulo aparte al que se
 * le pasa el `specifier` y el `parentURL`, y corre en su propio hilo. Es
 * también lo que usa tsx por su cuenta, así que el shim se apoya en la misma
 * vía y no se pelean.
 *
 * ## Por qué no `module.registerHooks()`
 *
 * Se usó `registerHooks()` (los síncronos, en el hilo principal) porque
 * atienden a la vez a `import()` de ESM y a `require()` de CommonJS. Con Node
 * 22.22 eso ya no compensa: **no llega a ejecutarse nada**.
 *
 * El primer módulo que carga cualquiera de estos scripts es el propio script,
 * que tsx resuelve como `"commonjs"` (el `package.json` no es de tipo `module`).
 * Al delegar en `nextLoad(url, context)` con ese formato, Node entra en su
 * camino nativo de carga CommonJS, que **no devuelve `source`**, y la
 * validación del gancho revienta:
 *
 * ```
 * TypeError [ERR_INVALID_RETURN_PROPERTY_VALUE]: Expected a string, an
 * ArrayBuffer, or a TypedArray to be returned for the "source" from the "load"
 * hook but got undefined
 * ```
 *
 * No es culpa de los ganchos de aquí: se reproduce igual con un
 * `registerHooks()` de tres líneas que solo devuelve `next(url, ctx)`, y con
 * cualquier gancho síncrono junto a tsx. Ni lo resuelve devolver el `source` de
 * uno mismo: para un módulo CommonJS eso significa entregar un módulo vacío, y
 * el script se ejecutaría sin hacer nada (código 0), que es peor que fallar.
 *
 * ## Por qué los asíncronos no pierden el `require()`
 *
 * La premisa que justificaba los síncronos —que atienden también a
 * `require()`— ya no aplica: el `import()` del cliente generado **sobrevive** a
 * la compilación de tsx (esbuild lo deja como `import()` porque el destino es
 * Node), así que la importación del `.wasm` siempre entra por el cargador de
 * ESM, que es lo que atienden los ganchos asíncronos. Y como el módulo que
 * devuelve el shim es CommonJS, el valor llega igual de bien por las tres vías
 * de consumo que leen `default` (`import()`, `require()` y el envoltorio de
 * interoperabilidad de esbuild).
 *
 * ## Por qué no tocar el cliente generado ni `src/lib/db.ts`
 *
 * - El cliente generado dice "do not edit directly".
 * - `src/lib/db.ts` lo usa también el despliegue de Cloudflare, donde leer un
 *   fichero con `node:fs` no existe y el empaquetador no puede resolverlo.
 * - La diferencia real entre los dos entornos es **cómo se importa un módulo**,
 *   no cómo se construye el cliente, así que el arreglo va en esa capa.
 *
 * ## El Worker no se ve afectado
 *
 * Este fichero solo se importa desde Node con `--import`. En el bundle del
 * Worker no está, el empaquetador sigue viendo el `?module` de siempre y
 * `runtime = "workerd"` sigue haciendo su trabajo. Lo mismo con `next dev` y
 * `next build`, que también empaquetan.
 *
 * @see prisma/schema.prisma (bloque `generator`, y por qué `runtime = "workerd"`)
 */

import { register } from "node:module";

// `module.register()` es de Node 20.6 en adelante, la misma versión que
// `--import`, con el que se carga este fichero. El mínimo baja desde 22.15
// (que era el de `registerHooks`) porque la API síncrona ya no es la que se usa.
if (typeof register !== "function") {
  throw new Error(
    "scripts/prisma-wasm-node.mjs necesita Node >= 20.6 (module.register). " +
      `Se está usando Node ${process.versions.node}.`,
  );
}

register("./prisma-wasm-node-hooks.mjs", import.meta.url);