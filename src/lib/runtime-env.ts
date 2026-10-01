/**
 * Configuración de runtime, en dos capas: los **bindings** de Cloudflare primero
 * y `process.env` como reserva.
 *
 * Por qué hace falta. En un Worker `process.env` no es el entorno del proceso, es
 * un objeto mutable, global para el isolate, que se puebla de dos maneras y
 * ninguna es fiada:
 *
 * - `workerd`, con el flag `nodejs_compat_populate_process_env` (activo por
 *   defecto desde `compatibility_date` 2025-04-01), vuelca ahí los bindings de
 *   texto del Worker. Este repo va con `2025-03-25`, así que hoy ese camino
 *   **no** existe; por eso leer el binding primero no es una medida de
 *   robustez, es lo único que funciona. Ver `docs/DESPLIEGUE.md`.
 * - `@opennextjs/cloudflare`, en `populateProcessEnv()` (la ejecuta el entrypoint
 *   del Worker en la primera petición del isolate), copia a `process.env` las
 *   entradas de texto del `env` que le llega a `fetch`.
 *
 *   ([OpenNext, `init.js`](https://github.com/opennextjs/opennextjs-cloudflare/blob/main/packages/cloudflare/src/cli/templates/init.ts) ·
 *   [Cloudflare, `process.env`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/#processenv))
 *
 * Si ese camino no ocurre, `process.env` sale sin la variable y la app cree que
 * no está configurada, aunque esté en el panel. Leer el binding primero quita esa
 * dependencia; `process.env` queda como reserva, de modo que en local (Node y
 * `.env`), en los scripts de `scripts/` y en cualquier otro hosting sigue
 * funcionando sin condicionales por entorno.
 *
 * El módulo **no importa nada**: ni `@opennextjs/cloudflare`, ni `server-only`.
 * Lee el mismo símbolo global que `getCloudflareContext()` (`Symbol.for("__cloudflare-context__")`,
 * el que publica el entrypoint del Worker), que es literalmente lo que esa función
 * devuelve. Importar el paquete oficial obligaría a declarar una dependencia de
 * producción con *peer dependencies* sobre `wrangler` y `next`, que es lo que se
 * quiere evitar: cambiar lo que Cloudflare instala y construye es justo el riesgo
 * que este arreglo no debe añadir. Así el módulo es inocuo en un Client Component
 * (allí no hay bindings y `process.env` es el shim vacío de Next).
 *
 * **Las variables `NEXT_PUBLIC_*` no se leen aquí.** Next las sustituye por un
 * literal al compilar, y esa sustitución solo ocurre con la forma estática
 * `process.env.NEXT_PUBLIC_ALGO`: un acceso por nombre dinámico no se sustituye y
 * en el cliente valdría `undefined`
 * ([docs de Next](https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser),
 * "dynamic lookups will _not_ be inlined"). Se siguen leyendo como estaban, y lo
 * que hace falta para ellas es definirlas también en *Build variables and secrets*
 * ([OpenNext, env vars](https://opennext.js.org/cloudflare/howtos/env-vars#workers-builds)).
 */

const CLOUDFLARE_CONTEXT_SYMBOL: unique symbol = Symbol.for("__cloudflare-context__");

/** Los *bindings* del Worker: texto, JSON y objetos de la plataforma (KV, R2, D1…). */
type CloudflareBindings = Record<string, unknown>;

/**
 * La parte de `ctx` (el `ExecutionContext` del Worker) que se usa aquí.
 *
 * Existe porque `ctx.waitUntil` es la primitiva que alarga la invocación: lo que
 * se le pasa se ejecuta antes de que el runtime dé por terminada la petición. Es
 * lo que permite cerrar el *pool* de Postgres al final de la invocación sin
 * depender de Next.
 */
type CloudflareExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/** La parte de `getCloudflareContext()` que se usa aquí. */
export type CloudflareRequestContext = {
  readonly env?: CloudflareBindings;
  readonly ctx?: CloudflareExecutionContext;
};

/**
 * `globalThis` con el contexto de Cloudflare colgado en el símbolo. El índice de
 * símbolo (`[key: symbol]`) es lo que permite escribirlo sin `any`: fuera de una
 * petición, de un `next build` o de un Client Component, el acceso da `undefined`
 * y no hay nada que slander.
 */
type GlobalWithCloudflareContext = {
  [key: symbol]: CloudflareRequestContext | undefined;
};

function cloudflareBindings(): CloudflareBindings | undefined {
  const context = (globalThis as unknown as GlobalWithCloudflareContext)[CLOUDFLARE_CONTEXT_SYMBOL];
  const env = context?.env;

  return typeof env === "object" && env !== null ? env : undefined;
}

/**
 * Contexto de la invocación de Cloudflare en curso, o `undefined` si no estamos
 * dentro de un Worker.
 *
 * Es la lectura del **mismo** símbolo global que usa `getCloudflareContext()`,
 * hecha sin importarlo, y por eso devuelve `undefined` en lugar de lanzar:
 * `getCloudflareContext()` lanza cuando no hay contexto, y aquí `undefined` es
 * justo la respuesta que se necesita para distinguir "Worker" de "Node".
 *
 * Sirve además de **identidad de la invocación**: el *entrypoint* del Worker
 * crea un objeto de contexto nuevo en cada petición
 * (`runWithCloudflareRequestContext`), así que la identidad del objeto es la de
 * la petición, y `src/lib/db.ts` la usa como clave de un `WeakMap` para tener un
 * cliente de Prisma por petición sin retener nada entre invocaciones.
 */
export function readCloudflareContext(): CloudflareRequestContext | undefined {
  return (globalThis as unknown as GlobalWithCloudflareContext)[CLOUDFLARE_CONTEXT_SYMBOL];
}

/**
 * Un binding de texto no vacío, o `undefined`.
 *
 * Un binding vacío equivale a "no configurado": se cae a `process.env` en vez de
 * tapar con una cadena vacía lo que haya debajo. Los *bindings* no-texto (KV, R2,
 * Hyperdrive, Durable Objects…) tampoco sirven aquí, y se ignoran por el mismo
 * `typeof`.
 */
function bindingValue(name: string): string | undefined {
  const value = cloudflareBindings()?.[name];

  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * El binding de Hyperdrive, que no es un binding de texto.
 *
 * `env.HYPERDRIVE` es un **objeto** con la cadena de conexión ya montada, y esa
 * cadena solo existe en runtime: no se puede copiar en una variable de entorno
 * ni en el panel, sale del propio binding. Por eso no se lee con
 * `readRuntimeEnv`, que descarta lo que no sea texto a propósito, y por eso
 * tiene su propia función.
 */
type HyperdriveBinding = { readonly connectionString?: unknown };

/**
 * Cadena de conexión del binding de Hyperdrive, o `undefined` si el Worker no lo
 * tiene. Es la ruta de configuración progresiva: sin el binding se sigue usando
 * `DATABASE_URL`, que es lo que necesitan `next dev` y los scripts de `scripts/`.
 */
export function readHyperdriveConnectionString(): string | undefined {
  const hyperdrive = cloudflareBindings()?.HYPERDRIVE as HyperdriveBinding | undefined;

  if (typeof hyperdrive !== "object" || hyperdrive === null) {
    return undefined;
  }

  const { connectionString } = hyperdrive;

  return typeof connectionString === "string" && connectionString !== "" ? connectionString : undefined;
}

/**
 * Valor de una variable de runtime, con los bindings de Cloudflare por delante y
 * `process.env` como reserva. Es la lectura que debe usar todo el servidor.
 */
export function readRuntimeEnv(name: string): string | undefined {
  return bindingValue(name) ?? process.env[name];
}
