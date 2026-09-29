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
 *   texto del Worker.
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

/** La parte de `getCloudflareContext()` que se usa aquí. */
type CloudflareRequestContext = {
  readonly env?: CloudflareBindings;
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

/** De dónde ha salido el valor que se está usando. */
export type RuntimeEnvSource = "binding" | "process";

export type RuntimeEnvLookup = {
  /** El valor, o `undefined` si no está en ninguna de las dos capas. */
  value: string | undefined;
  /** La capa de la que sale, o `null` si no está en ninguna. */
  source: RuntimeEnvSource | null;
};

function cloudflareBindings(): CloudflareBindings | undefined {
  const context = (globalThis as unknown as GlobalWithCloudflareContext)[CLOUDFLARE_CONTEXT_SYMBOL];
  const env = context?.env;

  return typeof env === "object" && env !== null ? env : undefined;
}

/**
 * Un binding vacío equivale a "no configurado": se cae a `process.env` en vez de
 * tapar con una cadena vacía lo que haya debajo. Los *bindings* no-texto (KV, R2,
 * Durable Objects…) tampoco sirven aquí, y se ignoran por el mismo `typeof`.
 */
function bindingValue(name: string): string | undefined {
  const value = cloudflareBindings()?.[name];

  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Resuelve una variable y dice de qué capa sale. Pensado para diagnóstico
 * (`/api/debug-env`), donde hace falta distinguir "está en el panel" de "llega".
 */
export function lookupRuntimeEnv(name: string): RuntimeEnvLookup {
  const fromBinding = bindingValue(name);

  if (fromBinding !== undefined) {
    return { value: fromBinding, source: "binding" };
  }

  const fromProcess: string | undefined = process.env[name];

  if (fromProcess !== undefined) {
    return { value: fromProcess, source: "process" };
  }

  return { value: undefined, source: null };
}

/**
 * Valor de una variable de runtime, con los bindings de Cloudflare por delante y
 * `process.env` como reserva. Es la lectura que debe usar todo el servidor.
 */
export function readRuntimeEnv(name: string): string | undefined {
  return bindingValue(name) ?? process.env[name];
}

/**
 * Nombres de los *bindings* presentes en el contexto de Cloudflare. Solo para
 * diagnóstico: devuelve claves, nunca valores.
 */
export function listRuntimeBindings(): string[] {
  return Object.keys(cloudflareBindings() ?? {}).sort();
}
