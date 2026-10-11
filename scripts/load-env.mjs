/**
 * Carga de las variables de entorno locales, en **un solo sitio**.
 *
 *   import "./load-env.mjs";
 *
 * (En `prisma7.config.ts`, desde la raíz: `import "./scripts/load-env.mjs";`)
 *
 * Lo usan las dos rutas que Next.js no cubre: los comandos de la CLI de Prisma
 * (`generate`, `db:push`, `studio`…), que salen de `prisma7.config.ts`, y los
 * scripts de `scripts/`, que arrancan con `tsx`. Los dos se apoyaban en su propio
 * `import "dotenv/config"`, que es lo que Next hace por su cuenta pero no lo que
 * cubre a la CLI: **Next carga `.env` *y* `.env.local`**, y `dotenv/config` solo
 * mira `.env`.
 *
 * ## Orden y por qué
 *
 * - **`.env.local` antes que `.env`**, porque es el fichero local por excelencia
 *   y el que gana cuando los dos declaran lo mismo. Es además el criterio que
 *   usa Next, así que la CLI y la web coinciden en qué valor manda. `.env` queda
 *   como respaldo para los valores compartidos que no se quisieron pisar en
 *   local.
 * - **`override: false`**, explícito aunque sea el valor por defecto: una
 *   variable **ya presente en el entorno gana siempre**. Así un `DATABASE_URL`
 *   exportado a mano, o el que inyecte CI o el panel, sigue mandando, y los
 *   ficheros solo rellenan huecos. Es lo mismo que hace `scripts/deploy-worker.mjs`
 *   con las variables de `.dev.vars`.
 * - **Los ficheros se resuelven desde la ruta de este módulo**, no desde
 *   `process.cwd()`, para que el resultado no dependa de desde dónde se invoque
 *   el comando.
 *
 * ## Si no hay ficheros, no pasa nada
 *
 * `config()` **no lanza** si un fichero no existe: devuelve el error y sigue con
 * los que sí estén. En CI —donde no hay ni `.env.local` ni `.env`— esto es
 * inocuo: es exactamente lo que pasaba antes, porque `dotenv/config` tampoco
 * encuentra `.env` allí. Por eso `npm ci` puede seguir haciendo su `prisma
 * generate` sin `DATABASE_URL`.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));

config({
  path: [resolve(RAIZ, ".env.local"), resolve(RAIZ, ".env")],
  override: false,
  // `dotenv/config` calla salvo que se pida lo contrario con `DOTENV_QUIET` o
  // `DOTENV_CONFIG_QUIET`; aquí se conserva ese mismo criterio para no cambiar
  // el ruido de la salida de los scripts.
  quiet: process.env.DOTENV_QUIET ?? process.env.DOTENV_CONFIG_QUIET ?? true,
});