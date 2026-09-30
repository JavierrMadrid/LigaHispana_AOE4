/**
 * Carga del WASM del compilador de Prisma **en Node**, para los scripts de
 * `scripts/`.
 *
 *   node --import ./scripts/prisma-wasm-node.mjs ...
 *
 * (En los scripts de `package.json` viene detrás de `tsx`.)
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
 * `module.registerHooks()` (síncronos, en el hilo principal) sustituyen
 * `"./x.wasm?module"` por un módulo CommonJS que lee el `.wasm` del disco y lo
 * compila, y lo publica como `default`. Es el mismo `WebAssembly.Module` que
 * recibe `workerd`, así que Prisma no necesita enterarse de nada más.
 *
 * Los síncronos y no `module.register()` a propósito: los síncronos atienden a
 * la vez a `import()` de ESM y a `require()` de CommonJS, y no dependen de si tsx
 * deja la instrucción dinámica como `import()` o la compila a `require`. Eso
 * importa porque el cliente generado es TypeScript y tsx decide el formato; con
 * la API asíncrona (que solo cubre ESM) el arreglo se rompía en cuanto tsx
 * compilaba a CommonJS.
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

import { registerHooks } from "node:module";
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

// `registerHooks` es de Node 22.15 en adelante. Es mejor esto que dejar que
// reviente con un "registerHooks is not a function" que no dice qué hacer.
if (typeof registerHooks !== "function") {
  throw new Error(
    "scripts/prisma-wasm-node.mjs necesita Node >= 22.15 (module.registerHooks). " +
      `Se está usando Node ${process.versions.node}.`,
  );
}

registerHooks({
  /**
   * `"./query_compiler_fast_bg.wasm?module"` → la URL del `.wasm` con la marca
   * puesta. Se decide en `resolve` (y no en `load`) para que Node sepa desde el
   * principio que es CommonJS con fuente propia, y para que la ruta final no se
   * lea dos veces del disco.
   */
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(`.wasm${WASM_MODULE_SUFFIX}`)) {
      return nextResolve(specifier, context);
    }

    const url = new URL(specifier.slice(0, -WASM_MODULE_SUFFIX.length), context.parentURL);

    return { url: `${url.href}?${MARKER}`, format: "commonjs", shortCircuit: true };
  },

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
  load(url, context, nextLoad) {
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
  },
});
