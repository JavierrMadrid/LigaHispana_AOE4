# LigaHispana_AOE4

Web para el seguimiento de la Liga Hispana de Age of Empires IV: torneo individual con clasificación calculada a partir de las partidas de los participantes (vía la API de [AoE4World](https://aoe4world.com/api)).

> **Puntuación**: los puntos se suman por **cualquier partida clasificatoria**, no solo por las partidas de la ladder *ranked* 1v1. El motor de puntuación (F3) decide qué cuenta como clasificatoria; por eso cada partida guarda su `leaderboard` y el JSON crudo de la API, para poder filtrar y recalcular sin volver a historicarlo.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **TailwindCSS**
- **Prisma 7** + **PostgreSQL**
- Despliegue en **Cloudflare Workers** con OpenNext (en local, Node)

## Requisitos

- Node.js 20+ (probado con 24)
- Una base de datos PostgreSQL (ver [Base de datos](#base-de-datos))

## Puesta en marcha

```bash
npm install          # instala dependencias + genera el cliente Prisma (postinstall)
cp .env.example .env # crea tu .env local y rellena DATABASE_URL
npm run db:push      # crea las tablas en la base de datos (Supabase)
npm run dev          # arranca en http://localhost:3000
```

Otros comandos:

```bash
npm run generate   # regenera el cliente Prisma
npm run db:push    # sincroniza el schema con la BBDD (sin shadow DB, apto para Supabase)
npm run studio     # abre Prisma Studio
npm run lint       # eslint
npm run build      # build de producción
npm run sync       # sincroniza las partidas de AoE4World (ver "Sincronización")
npm run verify:sync  # comprobaciones de normalización y guardado (ver más abajo)
npm run mock:tournament  # simula el torneo completo contra la API falsa (ver "Simulación local")
npm run mock:clean       # retira exactamente lo que crea la simulación
npm run simulate:tournament  # torneo simulado con jugadores REALES de AoE4World (ver "Torneo simulado con jugadores reales")
npm run simulate:clean        # deshace esa simulación, comprobando antes cada fila
```

## Base de datos

Se usa **Supabase** (Postgres cloud). La conexión se define en `.env` (`DATABASE_URL`).

> **Importante**: usa el *Session pooler* (host `...pooler.supabase.com`, puerto `5432`). La conexión *direct* (`db.<ref>.supabase.co`) es solo IPv6 y suele fallar en redes IPv4.

> Nota: con Supabase no se puede usar `prisma migrate dev` (requiere crear una *shadow database*, que Supabase no permite). Por eso usamos `prisma db push` para desarrollo.

### Variables de entorno (`.env`)

> En producción, en el Worker, la lectura es de dos capas (bindings y `process.env`): ver ["Cómo se lee la configuración en el Worker"](#cómo-se-leye-la-configuración-en-el-worker). Las `NEXT_PUBLIC_*` de esta tabla son la excepción y necesitan estar además en *Build variables and secrets*.

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Conexión PostgreSQL para Prisma |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase (auth/API) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable de Supabase (auth/API) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Alternativa antigua a la clave publicable |
| `AOE4WORLD_API_BASE` | Base de la API de AoE4World (por defecto `https://aoe4world.com`) |
| `AOE4WORLD_API_KEY` | Opcional, para partidas privadas de AoE4World |
| `AOE4WORLD_USER_AGENT` | Cómo se identifica el worker ante la API |
| `AOE4WORLD_TIMEOUT_MS` | Timeout por petición (15000) |
| `AOE4WORLD_MAX_RETRIES` | Reintentos por petición, además del intento inicial (3) |
| `AOE4WORLD_RETRY_BASE_MS` / `AOE4WORLD_RETRY_MAX_MS` | Base y techo del *backoff* (500 / 15000) |
| `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` | Separación mínima entre peticiones (300) |
| `AOE4WORLD_SYNC_PAGE_SIZE` | Partidas por página en el histórico (50, el máximo real de la API) |
| `AOE4WORLD_SYNC_MAX_PAGES` | Páginas máximas por pasada y jugador (10 → 500 partidas) |
| `AOE4WORLD_SYNC_CONCURRENCY` | Jugadores a la vez (3) |
| `AOE4WORLD_SYNC_DEADLINE_MS` | Plazo global de una pasada (240000) |
| `AOE4WORLD_MOCK` | `1` para responder con las fixtures locales de `src/lib/aoe4world/mock/` en vez de salir a la red (`0` por defecto; imposible con `NODE_ENV=production`) |
| `CRON_SECRET` | Secreto para llamar a `POST /api/cron/sync` sin sesión |
| `SITE_URL` | URL pública del Worker de la que parte el job de Supabase Cron. Solo la lee `scripts/db-cron.ts`; por defecto `https://ligahispana-aoe4.javierr-ma93.workers.dev`. Ver ["El disparo desde Supabase Cron"](#el-disparo-desde-supabase-cron-npm-run-dbcron) |
| `RATE_LIMIT_MAX_ATTEMPTS` | Envíos de inscripción permitidos por IP y ventana (5) |
| `RATE_LIMIT_WINDOW_SECONDS` | Longitud de la ventana del límite, en segundos (3600) |
| `RATE_LIMIT_STALE_SECONDS` | Antigüedad a partir de la cual se purga una fila de contador, en segundos (86400) |
| `RATE_LIMIT_SALT` | Secreto del HMAC-SHA-256 con el que se hashea la IP. Sin él se usa `CRON_SECRET`, y si tampoco hay, una sal fija en el código |
| `REGISTRATION_PROFILE_TIMEOUT_MS` | Presupuesto de la comprobación del perfil al inscribirse, en ms (8000) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Site key pública de Cloudflare Turnstile, la que monta el widget de `/participar`. Sin ella no se pinta el captcha |
| `TURNSTILE_SECRET_KEY` | Secret key de Cloudflare Turnstile (solo servidor). **Si no está definida el captcha queda desactivado**: el formulario sigue funcionando sin comprobación. En producción hay que definirla |
| `TURNSTILE_TIMEOUT_MS` | Presupuesto de la llamada a `siteverify`, en ms (5000) |

## Despliegue en Cloudflare Workers

El despliegue es un **Worker** construido con **OpenNext** (`@opennextjs/cloudflare`): `next build` produce `.next/`, OpenNext lo convierte en `.open-next/` y de ahí sale el Worker.

**`wrangler.jsonc` y `open-next.config.ts` están versionados a propósito.** `@opennextjs/cloudflare` los crea durante el build si no existen, pero entonces su contenido se pierde en cada despliegue: las variables y secretos que estén en el panel dejan de viajar al Worker, porque `wrangler deploy` reconstruye el Worker solo con lo que trae el archivo. Ver [Si los bindings no llegan al Worker](#si-los-bindings-no-llegan-al-worker-caso-2). El `wrangler.jsonc` versionado trae `main: ".open-next/worker.js"`, el `name` del Worker, `assets.directory`, el *service binding* `WORKER_SELF_REFERENCE`, el binding `IMAGES` y los *compatibility flags*; **los secretos no van ahí**, se siguen poniendo en el panel.

### `pg-cloudflare` es dependencia de producción explícita

`pg` comprueba en runtime si está dentro de un Worker y, si lo está, usa un socket de TCP (`cloudflare:sockets`) en lugar de `net`/`tls` de Node. Para hacerlo hace un `require('pg-cloudflare')` **estático** en `pg/lib/stream.js`, dentro de la rama de Cloudflare: el empaquetador tiene que resolver ese módulo aunque en local la rama no se ejecute nunca. `pg` lo declara como `optionalDependency`, y una dependencia opcional no es una garantía para el empaquetado. El build de Cloudflare falló exactamente por eso:

```
.open-next/server-functions/default/node_modules/pg/lib/stream.js:41:41: ERROR: Could not resolve "pg-cloudflare"
```

Por eso `pg-cloudflare` está en `dependencies` de `package.json` y no solo colgada de `pg`. Es el mismo patrón que siguen las librerías con código específico de `workerd`: el paquete publica un *conditional export* bajo la condición `workerd` y un fichero **vacío** en el resto de condiciones, así que si el empaquetador no aplica esa condición el bundle compila sin quejarse pero el socket llega `undefined` en runtime. `wrangler` sí la aplica, y conviene comprobarlo en el bundle si alguna vez se ve un `CloudflareSocket is not a constructor`.

### La rama `workerd` de `pg-cloudflare` tiene que entrar en el trace

Con la dependencia declarada el build **siguió fallando** con el mismo error, y esta vez por otra razón que no se arregla tocando dependencias: los dos pasos de OpenNext resuelven el paquete con **condiciones distintas**.

1. **El copiado** (`copyTracedFiles`, en `@opennextjs/aws`) copia, fichero a fichero, lo que aparece en los `.nft.json` que escribe `next build`. El trazador (`@vercel/nft`) resuelve con las condiciones de **Node**, y en `pg-cloudflare` la única de esas es `default`, que apunta a `dist/empty.js`: al `.open-next` solo van `package.json` y `dist/empty.js`.
2. **El empaquetado** (`bundleServer`, en `@opennextjs/cloudflare`) lanza esbuild con `platform: "node"` y `conditions: ["workerd"]`, así que el mismo `require('pg-cloudflare')` de `pg/lib/stream.js:41` resuelve a la rama `workerd` → `require` → **`dist/index.js`**, que no está en el directorio copiado.

De ahí el `The module "./dist/index.js" was not found on the file system`. El paquete estaba entero; lo que faltaba era en la carpeta del bundle. **El arreglo es `outputFileTracingIncludes` en `next.config.ts`**, que le dice a Next que meta en el trace, para todas las rutas, los ficheros de la rama `workerd`:

```ts
outputFileTracingIncludes: {
  "/*": ["node_modules/pg-cloudflare/dist/**/*", "node_modules/pg-cloudflare/esm/**/*"],
},
```

`dist` es la rama que se empaqueta (la `require`) y `esm` la `import`, que además importa `../dist/index.js`; sin las dos, el bundle compila pero el socket llega vacío. Con las dos, el `.nft.json` de cada ruta incluye `pg-cloudflare/dist/index.js`, OpenNext lo copia y esbuild lo encuentra con la condición `workerd`.

Por qué esta opción y no las otras:

- **No depende de la versión de `@opennextjs/cloudflare`.** Existe otra vía, la que documenta OpenNext (`serverExternalPackages` + `copyWorkerdPackages`, que copia el paquete entero y reescribe su `package.json` solo con la rama `workerd`), pero `copyWorkerdPackages` **solo** actúa sobre paquetes que estén en `serverExternalPackages` **y** tengan condición `workerd` reconocida ([`workerd.ts`](https://github.com/opennextjs/opennextjs-cloudflare/blob/main/packages/cloudflare/src/cli/build/utils/workerd.ts)). Con las versiones anteriores a [PR #1243](https://github.com/opennextjs/opennextjs-cloudflare/pull/1243) (fusionada el 2026-05-04) esa condición no se reconocía cuando su valor es un **objeto**, que es justo el caso de `pg-cloudflare` (`"workerd": { "import": ..., "require": ... }`). Es decir: la vía "oficial" depende de con qué versión se construya, y aquí la versión la elige el entorno de build de Cloudflare, no el repo.
- **No toca `node_modules`.** Normalizar el `package.json` de `pg-cloudflare` desde un `postinstall` (dejar `dist/index.js` alcanzable también por `default`) funciona, pero muta el árbol de dependencias, se pierde con cualquier reinstalación y un día `npm ci` lo deshace sin avisar.
- **No evita la rama estática de `pg`.** Habría que parchear `pg` o cambiar de driver, que es una decisión de stack, no un arreglo de build.
- **No necesita tocar `wrangler.jsonc` ni `open-next.config.ts`**: el arreglo va en `next.config.ts`, así que el Worker se sigue construyendo con el `name` y los bindings de siempre.

Comprobación de que el arreglo funciona. Los dos scripts viven **fuera del repo**, en `<temp>\pgcf-repro` (`repro.mjs` y `runtime-check.mjs`): `repro.mjs` copia a `.open-next/server-functions/default/node_modules/` los ficheros que el trace real de `next build` manda a standalone —el mismo origen que usa `copyTracedFiles`— y luego lanza esbuild con las mismas opciones que `bundleServer`.

```bash
# así es como construye OpenNext: fuerza el modo standalone
# (en PowerShell: $env:NEXT_PRIVATE_STANDALONE="true"; npm run build)
NEXT_PRIVATE_STANDALONE=true npm run build

node <temp>\pgcf-repro\repro.mjs broken
# -> Build failed with 1 error: .../pg/lib/stream.js:41:41: ERROR: Could not resolve "pg-cloudflare"
#    The module "./dist/index.js" was not found on the file system

node <temp>\pgcf-repro\repro.mjs traced
# -> ESBUILD OK; el metafile mete pg-cloudflare/dist/index.js y el bundle trae cloudflare:sockets

node <temp>\pgcf-repro\runtime-check.mjs <temp>\pgcf-repro\opennext-traced
# -> getStream(false) devuelve: CloudflareSocket
```

`broken` quita del trace la rama `workerd`, que es exactamente como se quedaba sin el arreglo; `traced` copia el trace tal cual. `runtime-check.mjs` falsea `navigator.userAgent = "Cloudflare-Workers"` para ejecutar la rama de Cloudflare fuera de `workerd` y comprobar que la clase del socket es la buena.

Dos avisos que quedan para cuando se cablee el binding de Hyperdrive:

- `pg` **no** tiene condición `workerd`: el socket se elige en runtime. Si el bundle saliera sin esa rama, el build pasaría y fallaría luego con `CloudflareSocket is not a constructor` (o `proxy request failed`, si lo que falta es el socket y no la clase). **Comprobado**: `.open-next/server-functions/default/handler.mjs` trae `cloudflare:sockets`, así que la rama de `workerd` sí está empaquetada.
- Cloudflare documenta crear un cliente nuevo **por petición** ("create a new `Client` instance for each request"), porque en un Worker una conexión no se puede reutilizar entre invocaciones. **Ya está arreglado**: `src/lib/db.ts` crea un cliente por invocación (ver [El cliente de Prisma](#el-cliente-de-prisma-por-petición-en-el-worker-y-uno-fuera-de-él)). Cachear el cliente entre invocaciones hacía que, en la siguiente petición, el *pool* sacara un socket que `workerd` ya había cerrado **sin emitir `error`**: el `write` se perdía, nada resolvía ni rechazaba la promesa, la consulta se quedaba colgada para siempre y Cloudflare mataba la invocación con el error 1101.

### Prisma 7 necesita `runtime = "workerd"`: sin esto no hay base de datos

Síntoma en el Worker desplegado: la web entera responde 500, y la primera consulta a la base muere con

```json
{ "ok": false, "name": "CompileError",
  "message": "WebAssembly.Module(): Wasm code generation disallowed by embedder" }
```

No es un problema de secretos ni de conexión. Prisma 7 no lleva el motor de consultas como binario, sino el *query compiler* como **WASM**, y con el runtime por defecto (`nodejs`) el cliente generado lo mete **en base64 dentro del propio JS** y lo compila en runtime (`src/generated/prisma/internal/class.ts`):

```ts
async function decodeBase64AsWasm(wasmBase64: string): Promise<WebAssembly.Module> {
  const wasmArray = Buffer.from(wasmBase64, "base64");
  return new WebAssembly.Module(wasmArray);   // <- prohibido en workerd
}
```

`workerd` prohíbe eso por completo, y no es un matiz: `WebAssembly.compile`, `WebAssembly.instantiate` y el constructor síncrono `new WebAssembly.Module` están bloqueados, porque construir un módulo desde *bytes* es **generación de código**, igual que `eval` o `new Function` (["el módulo tiene que venir ya compilado de fuera"](https://developers.cloudflare.com/workers/runtime-apis/webassembly/), [workerd#3345](https://github.com/cloudflare/workerd/issues/3345)). Es el bug abierto [prisma/prisma#28657](https://github.com/prisma/prisma/issues/28657) y ocurre con **cualquier** datasource, así que no se esquiva cambiando de base de datos ni de driver.

El arreglo es una línea en el bloque `generator` de [`prisma/schema.prisma`](prisma/schema.prisma):

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
  runtime  = "workerd"
}
```

Con `workerd`, el cliente generado **importa el `.wasm` como módulo** en vez de compilarlo desde un base64, y desaparece el `CompileError`. De ahí en adelante lo resuelve la cadena habitual: Turbopack emite el `.wasm` como *chunk* en `.next/server/chunks/`, `next build` lo mete en el trace (`.nft.json`) y OpenNext parchea los ayudantes de carga de Turbopack (`loadWebAssemblyModule`, `compileModule`, `instantiateStreaming`, que `workerd` tampoco tiene) para que pasen por su `loadWasmChunk`, un `switch` de `import()` estáticos que el empaquetador puede descubrir. Ese parche para Next 16.3+ está en `@opennextjs/cloudflare` 1.20.7, que es la versión fijada aquí.

**Después de tocar el schema hay que regenerar**, o el cambio no existe: `npx prisma generate` (lo hace el `postinstall` de `npm install`).

Dos cosas que **no** hay que confundir con esto:

- **Los secretos no tienen nada que ver.** Si `db` devuelve este error, el `DATABASE_URL` está bien resuelto; el fallo ocurre al *arrancar* el cliente, antes de abrir conexión. Un `DATABASE_URL no está definida` es un problema distinto, de configuración.
- **En local no se reproduce y no hay que tocar nada.** En Node `new WebAssembly.Module` es legal, así que `next dev` funciona con cualquiera de los dos runtimes. Los reportes de que `runtime = "workerd"` rompe el desarrollo local son de proyectos con Vite; con Turbopack y esta configuración no aparece ningún problema. Se puede comprobar en local levantando `npm run dev` y consultando la base; en el Worker se comprueba con la sonda de [Cómo comprobar que funciona](#cómo-comprobar-que-funciona).
- **`workerd` sí rompe los scripts de `scripts/`, que corren con `tsx`.** No es un problema de Turbopack sino del runtime elegido: Prisma emite el import `"./query_compiler_fast_bg.wasm?module"` **solo** en los runtimes edge (`workerd` y `vercel-edge`, [commit 9b8e186](https://github.com/prisma/prisma/commit/9b8e1867de8e34334d521c9e736ac87a4cbb797e)), y `?module` es una convención de empaquetador: ni Node ni `tsx` la entienden, así que el import resuelve a `undefined` y la consulta falla con `The loaded wasm module was unexpectedly undefined or null once loaded`. `cloudflare` es un alias de `workerd`, no una variante, así que no hay un valor del generator que valga para los dos lados a la vez.

  **No se arregla generando los dos clientes**, que es lo primero que parece: `src/lib` es compartido. `scripts/verify-sync.ts` importa `@/lib/scoring` y `@/lib/settings`, y con ellos `@/lib/aoe4world/sync`, `@/lib/aoe4world/ladder`, `@/lib/public`, `@/lib/rate-limit` y `@/lib/simulation/roster`; los siete importan `@/lib/db`. O sea, que `db` tendría que elegir el cliente en runtime, y entonces los dos clientes entran en el bundle del Worker: el de Node lleva el query compiler entero en base64 dentro del JS (~4,6 MB) **encima** del `.wasm` del de `workerd` (~3,4 MB). Separar los clientes obligaría a duplicar medio `src/lib` para los scripts, o a moverlos dentro del Worker.

  **Sí se arregla enseñándole a Node la convención del empaquetador**, que es lo que hace [`scripts/prisma-wasm-node.mjs`](scripts/prisma-wasm-node.mjs): una precarga con `--import` que registra ganchos de carga de módulos y sustituye `"./x.wasm?module"` por un módulo CommonJS que lee el `.wasm` del disco y lo publica como `default`. Es el mismo `WebAssembly.Module` que recibe `workerd`, así que Prisma no necesita enterarse de nada más y `runtime = "workerd"` se queda como está. Los ganchos van en el fichero de los scripts, no en `src/lib`, porque la diferencia real entre los dos entornos es **cómo se importa un módulo**: `src/lib/db.ts` lo usa también el Worker, donde `node:fs` no existe.

  Lo que había que arreglar son **dos** cosas, no una, y la segunda es la que más engaña:

  1. `?module` forma parte del nombre de fichero en Node, así que el import apunta a algo que no existe.
  2. Aunque se arreglara eso, la importación nativa de `.wasm` que hace Node devuelve el espacio de nombres de **exports** del módulo, **sin `default`**. Prisma hace `const { default: module } = ...` y seguiría recibiendo `undefined`. Los ganchos devuelven el módulo **y** una autorreferencia en `default` más `__esModule`, para que el valor llegue bien tanto si tsx deja la instrucción dinámica como `import()` de ESM como si la compila a `require()`.

  Por eso los ganchos son los **síncronos** (`module.registerHooks()`) y no `module.register()`: los síncronos atienden a ESM y a CommonJS por igual y no dependen de qué formato decida tsx para el cliente generado (que es TypeScript). Con la API asíncrona, que solo cubre ESM, el arreglo se rompía en cuanto tsx compilaba a CommonJS.

  Se aplica en `package.json` a los scripts que **consultan** la base (`sync`, `score`, `backfill:model`, `verify:sync`, `mock:tournament`, `mock:clean`, `simulate:tournament`, `simulate:clean`):

  ```json
  "verify:sync": "tsx --import ./scripts/prisma-wasm-node.mjs --conditions=react-server scripts/verify-sync.ts"
  ```

  Si aparece esa precarga en un script nuevo, es porque también va a tocar la base. Los que no la llevan o no usan Prisma (`db:security` y `db:cron`, que hablan con `pg` directamente; `verify:sync` sin `--db`; `brand:assets`) no la necesitan.

  **El Worker no se ve afectado**: este fichero solo se importa desde Node con `--import`, así que no entra en el bundle. En `next dev` y `next build` manda Turbopack, que ya entendía el `?module`. La sincronización y el recálculo de producción siguen yendo por `POST /api/cron/sync` (ver [Sincronización](#sincronización-con-aoe4world)), con el cliente de `workerd`.

**La excepción es `npm run db:security`, que sí se ha arreglado**: al no depender de nada de Prisma, se ha pasado a hablar con `pg` directamente. Ese script es el que aplica y comprueba la postura de RLS de la base de datos, así que perderlo habría sido perder el control de la seguridad del torneo. Sigue funcionando entero, con su comprobación previa y sus códigos de salida.

### Cómo se lee la configuración en el Worker

En un Worker `process.env` **no** es el entorno del proceso. Cloudflare lo dice sin rodeos: *"In the Workers implementation, there is no process-level environment, so by default `env` is an empty object"*, y solo se puebla con los bindings cuando está el flag `nodejs_compat_populate_process_env` (activo por defecto para `compatibility_date` de 2025-04-01 o posterior) — [docs de Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/#processenv). Por su parte, `@opennextjs/cloudflare` copia también a `process.env` las entradas de texto del `env` que recibe el `fetch`, en la primera invocación del isolate ([`populateProcessEnv`](https://github.com/opennextjs/opennextjs-cloudflare/blob/main/packages/cloudflare/src/cli/templates/init.ts)).

Ese doble camino es frágil: si no ocurre, la variable está en el panel y `process.env` sale sin ella, y la app cree que no está configurada. Ya pasó aquí: con `DATABASE_URL`, `CRON_SECRET`, `RATE_LIMIT_SALT` y `TURNSTILE_SECRET_KEY` definidos en el panel, el Worker desplegado no veía ninguna, y lo observable era `DATABASE_URL no está definida.`, el captcha desactivado en silencio y el cron sin poder autenticarse.

Por eso **toda lectura de configuración del servidor pasa por `src/lib/runtime-env.ts`**, que lee **los bindings de Cloudflare primero y `process.env` como reserva**:

```ts
import { readRuntimeEnv } from "@/lib/runtime-env";

const secret = readRuntimeEnv("CRON_SECRET");
```

- **Sin condicionales por entorno.** Donde no hay Worker no hay bindings y sale `process.env`: en local (Node y `.env`), en los scripts de `scripts/` y en cualquier otro hosting sigue funcionando igual que antes.
- **El módulo no importa nada**: ni `@opennextjs/cloudflare`, ni `server-only`. Lee el símbolo global `__cloudflare-context__` que publica el entrypoint del Worker, que es literalmente lo que devuelve `getCloudflareContext()`. Así no hace falta declarar `@opennextjs/cloudflare` como dependencia de producción —lleva `wrangler` y `next` como *peer dependencies* que `npm` instalaría, cambiando lo que Cloudflare construye— ni tocar `next.config.ts`, que es justo el fichero que decide cómo se detecta y se construye el proyecto.
- **`src/lib/db.ts` sigue siendo perezoso.** La lectura sigue estando en la primera llamada, no al importar, así que `next build` continúa sin necesitar `DATABASE_URL`.

**Lo que no pasa por ahí, y por qué:**

- **`NEXT_PUBLIC_*`** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_SITE_URL`). Next las sustituye por un literal al compilar, y solo lo hace con la forma **estática** `process.env.NEXT_PUBLIC_ALGO`: un acceso por nombre dinámico no se sustituye y en el cliente valdría `undefined` (*"dynamic lookups will not be inlined"*, [docs de Next](https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser)). Un binding del Worker no puede llegar al bundle del navegador de ninguna manera. Consecuencia práctica: definirlas **también en *Build variables and secrets***, que es lo que hace que existan cuando `next build` compila ([OpenNext, env vars](https://opennext.js.org/cloudflare/howtos/env-vars#workers-builds)); en runtime quedan de adorno para el servidor.
- **`NODE_ENV`.** No es configuración: Next lo sustituye por un literal (`production` en build) y no existe como binding.

#### Cómo comprobar que funciona

No queda ninguna sonda en el repo: la que se usó para cerrar este arreglo (`GET /api/debug-env`, que devolvía nombres y booleanos, nunca valores) se borró al terminar, porque una ruta de diagnóstico no debe quedarse en producción. Para volver a mirar el entorno del Worker hay que recrearla.

Lo que se miraba, y qué hacer con cada resultado:

| Señal | Qué dice |
|---|---|
| `bindings` trae `DATABASE_URL` | El arreglo funciona. Da igual que no esté en `process.env`: la app lee los bindings. |
| `bindings` vacío o sin las variables | El binding no ha llegado al Worker. Ningún cambio de código lo arregla; es configuración de despliegue (ver más abajo). |
| `bindings` las trae y también están en `process.env` | `populateProcessEnv` funcionó y todo va por el camino antiguo. También es correcto. |

Y una advertencia que costó entender: **`NEXT_PUBLIC_*` no aparecen en ninguna de esas señales, y no es que falten.** Next las sustituye por literales al compilar, así que nunca viajan como binding ni a `process.env`. Verlas ausentes en el Worker es lo esperado, no un síntoma.

#### Si los bindings no llegan al Worker (caso 2)

Ningún cambio de código lo arregla: es configuración de despliegue. La causa era que el `wrangler.jsonc` no estaba versionado, así que `@opennextjs/cloudflare` lo generaba en cada build y `wrangler deploy` reconstruía el Worker solo con lo que traía ese archivo, perdiendo las variables del panel. Ya está versionado (ver arriba); el que trae el repo sale de la plantilla de `@opennextjs/cloudflare` (`node_modules/@opennextjs/cloudflare/templates/wrangler.jsonc` una vez instalado el paquete):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "main": ".open-next/worker.js",
  "name": "<WORKER_NAME>",                  // el nombre exacto del Worker del panel
  "compatibility_date": "<COMPATIBILITY_DATE>",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
  "services": [
    { "binding": "WORKER_SELF_REFERENCE", "service": "<WORKER_NAME>" }
  ],
  "r2_buckets": [
    { "binding": "NEXT_INC_CACHE_R2_BUCKET", "bucket_name": "<WORKER_NAME>-opennext-cache" }
  ],
  "images": { "binding": "IMAGES" }
}
```

Lo que hay que tener delante al escribirlo:

- **`name` tiene que ser el Worker donde están las variables.** Si no coincide, se despliega a otro Worker, sin bindings, y todo lo anterior pasa desapercibido porque la app responde igual. Es la primera causa que hay que descartar.
- **`compatibility_date` de 2025-04-01 o posterior** activa `nodejs_compat_populate_process_env`. La que genera la CLI sale del último `workerd` de npm, así que hoy ya es moderna; bajarla a una anterior desactivaría el relleno de `process.env` y solo se vería en los bindings.
- **Los secretos no van aquí.** Se siguen poniendo en el panel (Settings → Variables and Secrets) y se despliega con `npx wrangler deploy --keep-vars`. Solo las *vars* de texto que Next u OpenNext necesitan en build (p. ej. `NEXTJS_ENV`) van en el archivo.
- Para **ver el `compatibility_date` y el `name` que se están usando hoy** sin desplegar: `npx wrangler deploy --dry-run` imprime a qué Worker y con qué configuración sube, y falla si el archivo no cuadra con lo que hay en `.open-next`.

### La base de datos en el Worker: Hyperdrive

En un Worker una conexión TCP solo vive durante la invocación que la abre. Sin nada por medio, cada petición paga el establecimiento completo de la conexión contra la base de datos (handshake TCP, negociación TLS y autenticación: 7 viajes de ida y vuelta antes de poder ejecutar la primera consulta) y la base ve una conexión nueva por petición. **Hyperdrive** es la pieza que Cloudflare pone delante de la base de datos para resolverlo: hace el establecimiento en el edge, junto al Worker, y mantiene un *pool* de conexiones reales cerca de la base de datos, además de cachear lecturas. Es la vía documentada y recomendada para Postgres desde un Worker, y la que usan los ejemplos de Cloudflare con `pg`.

**Crear el Hyperdrive** (Workers & Pages → Hyperdrive → *Create configuration*):

- La cadena que se le da a Hyperdrive es la de la conexión **directa** de Supabase (`db.<ref>.supabase.co`, puerto `5432`), **no** la del *Session pooler*: el *pooling* lo pone Hyperdrive. Ojo, que esto es justo al revés de lo que se usa en el `.env` local, donde hace falta el *Session pooler* porque la directa es solo IPv6.
- Las credenciales pueden ser las del usuario `postgres` del proyecto, pero mejor un rol propio con los permisos justos (Cloudflare propone crear en el SQL Editor un `CREATE ROLE hyperdrive_user LOGIN PASSWORD '...'` y darle el rol que necesite) en lugar de privilege escalation con el superusuario.
- No hace falta `?sslmode=require` en esa cadena: es Hyperdrive quien termina el TLS contra la base de datos.
- Al crearlo, Hyperdrive prueba la conexión para verificar las credenciales, así que si falla el error es de la cadena o del firewall, no del Worker.

El proyecto ya está en el plan **Free**, que incluye **100.000 consultas al día** a Hyperdrive (contadas a las 00:00 UTC: cualquier `SELECT`, `INSERT`, `UPDATE`, `DELETE` o cambio de esquema, cacheada o no). El *pooling* y la caché no se cobran aparte.

**Aviso importante sobre cómo se lee la cadena.** La cadena de conexión de Hyperdrive **no** es una URL que se pueda copiar y pegar en una variable de entorno: solo existe en tiempo de ejecución, en `env.HYPERDRIVE.connectionString`, y se obtiene del *binding* Hyperdrive. Por eso **no hay ningún valor correcto para `DATABASE_URL` en Cloudflare**: la cadena directa de Supabase funciona desde un Worker (el socket TCP no está bloqueado; solo lo están el puerto 25 y las IPs privadas o de Cloudflare), pero paga el establecimiento completo en cada petición, y la de Hyperdrive no existe hasta que hay un binding.

**El cableado ya está hecho, y el binding está activo desde septiembre de 2026.** `src/lib/db.ts` lee el binding con `readHyperdriveConnectionString()` de [`src/lib/runtime-env.ts`](src/lib/runtime-env.ts) y, si no está, cae a `DATABASE_URL` por [`readRuntimeEnv`](#cómo-se-leye-la-configuración-en-el-worker). No es un apaño: es lo que permite que `next dev` y los scripts de `scripts/` sigan funcionando sin el binding.

**Por qué se activó.** Con el binding comentado, el Worker resolvía la base por el `DATABASE_URL` del panel, que apuntaba al *Session pooler* de Supabase. Ahí se le caían las conexiones: el worker de sync terminaba con `Connection terminated unexpectedly` y `db/pool: Network connection lost`, y como los errores por jugador solo van a `console.error` (nada los persistía), **el torneo entero se quedó congelado sin que nada lo dijera** — la clasificación seguía sirviendo los últimos puntos guardados y ningún jugador nuevo aparecía. Con Hyperdrive el *pool* lo pone Cloudflare contra la conexión directa y el problema desaparece.

**Lo que exige el deploy.** `opennextjs-cloudflare deploy` llama a `getPlatformProxy()` de wrangler para leer el entorno, y esa emulación **exige** una cadena de conexión local para cualquier binding de Hyperdrive. Ojo con el detalle, que es la trampa: el `applyHyperdriveEnvVars` de wrangler lee `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` **exclusivamente de `process.env`**, sin mirar ningún fichero, así que **tenerla en `.dev.vars` no basta**. El valor se guarda ahí (no se versiona: lleva la contraseña) y [`scripts/deploy-worker.mjs`](scripts/deploy-worker.mjs) lo exporta antes de lanzar el CLI, que es el paso `deploy` de `npm run deploy`. (No vale hacerlo con `node --import`: `opennextjs-cloudflare` es un shim de `node_modules/.bin`, no un módulo, y `node` lo resuelve con `ERR_MODULE_NOT_FOUND`.) Si algún día el despliegue pasa a ser automático (Workers Builds), esa misma variable hay que ponerla en *Build variables and secrets* del Worker, o el build falla al ver el binding.

### El cliente de Prisma: uno por petición en el Worker, y uno fuera de él

Lo que obliga a esto no es Hyperdrive: es el runtime. En `workerd` un socket TCP creado con `connect()` **solo es válido durante la invocación que lo abre**, y al terminar la petición el runtime lo cierra **sin emitir `error`**. Con el cliente cacheado por proceso, la siguiente petición sacaba del *pool* ese socket ya muerto, el `write` se perdía y **nada resolvía ni rechazaba la promesa**: la consulta se quedaba colgada para siempre y Cloudflare mataba la invocación con el error 1101 ("your Worker's code had hung and would never generate a response"). Era intermitente y afectaba solo a las páginas que leen Postgres (`/`, `/partidas`, `/objetivos`, las tres con `force-dynamic`).

Lo que hace ahora `src/lib/db.ts`:

- **En el Worker, un cliente por invocación**, en un `WeakMap` indexado por el propio contexto de Cloudflare. El *entrypoint* de `@opennextjs/cloudflare` crea un objeto de contexto nuevo en cada petición, así que la identidad de la clave es la identidad de la invocación, y el `WeakMap` no retiene nada entre peticiones.
- **Fuera del Worker** (`next dev` y los scripts de `scripts/`, que son Node de proceso largo) **una sola instancia** guardada en `globalThis`, como antes, para que el hot reload no abra una conexión nueva en cada recarga.
- **La distinción no usa `process.env.NODE_ENV`**, porque en el bundle del Worker es un literal sustituido al compilar y siempre valdría `"production"`. Usa la existencia del contexto de Cloudflare, leído del símbolo global `Symbol.for("__cloudflare-context__")` — el mismo que devuelve `getCloudflareContext()`, pero sin importar `@opennextjs/cloudflare`, que es una dependencia de desarrollo con *peer dependencies* sobre `wrangler` y `next` (ver [`src/lib/runtime-env.ts`](src/lib/runtime-env.ts)).
- **Las conexiones se cierran al final de la petición** con `after()` de `next/server`, que en el Worker aterriza en `ctx.waitUntil`: la invocación sigue viva hasta que `pool.end()` resuelve, así que el cierre ocurre con el socket todavía válido. Se descarta `ctx.waitUntil` directamente porque su promesa **empieza en el momento de registrarla** y cerraría el *pool* mientras la página todavía está consultando; y se descarta un finalizador en `AsyncLocalStorage` porque `db.ts` no es la entrada de la petición, así que no hay ningún ámbito que abrir ni que cerrar.
- Los errores de un cliente **ocioso** del *pool* ya no se tragan: se registran con `onPoolError` de `PrismaPg`, que es justo la firma de un socket que el runtime ya cerró.

Cuando la base de datos falla (límite de conexiones de Supabase, reinicio, corte de red), las tres páginas públicas ya **no** devuelven un 500: `getStandings()`, `getLiveMatches()` y `getObjectives()` devuelven un `PublicRead<T>` con `status: "degraded"` y `data: null`, y el log lleva una línea con prefijo `[db]` y el motivo. Ver [Qué ve la web cuando la base de datos no responde](#qué-ve-la-web-cuando-la-base-de-datos-no-responde).

El resto de variables (`NEXT_PUBLIC_SUPABASE_*`, `TURNSTILE_SECRET_KEY`, `CRON_SECRET`, …) se define en el panel del Worker (Settings → Variables and Secrets), y además en *Build variables and secrets* las que sean `NEXT_PUBLIC_*`, porque Next las compila dentro del bundle. OpenNext recomienda desplegar con `--keep-vars` para que un despliegue no borre las variables que están en el panel.

## Qué ve la web cuando la base de datos no responde

Un corte puntual de la base (límite de conexiones de Supabase, un reinicio, un pico de red) no puede ser un 500 con una traza en el log: la web del torneo tiene que seguir contestando y decir que no ha podido leer. Las tres lecturas de `src/lib/public.ts` y `src/lib/scoring.ts` devuelven por eso un discriminante en vez del dato pelado:

```ts
type PublicRead<T> = { status: "ok"; data: T } | { status: "degraded"; data: null };
```

```ts
const { status, data } = await getStandings(); // StandingRow[] | LiveMatch[] | ObjectiveView
```

- `status: "ok"` → `data` es el valor de siempre y la pantalla se pinta como ahora.
- `status: "degraded"` → `data` es **`null`**, y a propósito **no** una lista vacía: un vacío se leería como "no hay participantes" o "no hay partidas en juego ahora mismo", que es una afirmación falsa. Quien pinte tiene que distinguir los dos casos y decir que no se ha podido leer.

El motivo del fallo **no** viaja en el objeto: esto se serializa al navegador dentro del *payload* de RSC. Se queda en el log del servidor, con el prefijo `[db]` y el `scope` de la lectura, por ejemplo:

```
[db] public/getStandings: PrismaClientKnownRequestError (P1001): Can't reach database server at db.abc.supabase.co
```

El mensaje va saneado: se elimina el usuario y la clave de cualquier URL de conexión y los parámetros `password=`, y se conserva el host, que es lo que hace falta para diagnosticar. Los scripts de `scripts/` y `verify:sync --db` usan `unwrapRead()` de `@/lib/db-errors`, que **aborta** en vez de devolver vacío: una comprobación que se traga un corte de la base y sale con "todo correcto" es peor que no comprobar nada.

## Inscripción pública

`/participar` es un endpoint público y sin autenticación, así que la Server Action `registerPlayer` (`src/app/(public)/participar/actions.ts`) tiene cinco capas, en este orden:

1. **Campo trampa** (`website`): no escribe nada y devuelve la misma confirmación que un alta bueno, para que un bot no pueda aprender a esquivarla.
2. **Límite de frecuencia por IP** (`src/lib/rate-limit.ts`): cuenta en Postgres, con la IP **hasheada** (HMAC-SHA-256 con `RATE_LIMIT_SALT`, nunca en claro), en una ventana fija. El incremento es un `INSERT ... ON CONFLICT DO UPDATE` de una sola sentencia, así que el despliegue serverless no lo evita y dos envíos simultáneos se serializan. Sin IP identificable (`x-forwarded-for` / `x-real-ip`) cae a un cubo compartido `global`. Por defecto, 5 envíos por hora y IP.
3. **Captcha** (Cloudflare Turnstile, `src/lib/turnstile.ts`): cierra el hueco que el límite no puede, que es rotar `x-forwarded-for` detrás de un proxy que la reenvía sin reescribir. Verifica el token del campo `cf-turnstile-response` contra `siteverify`, **falla cerrado** (si no se puede comprobar, el envío no pasa) y **se desactiva solo si no hay `TURNSTILE_SECRET_KEY`**, para que el proyecto funcione sin configurar nada. La site key (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) la usa el componente cliente; los dos nombres del contrato están en `src/lib/turnstile-contract.ts`.
4. **Validadores de los campos** compartidos con el alta de admin (`src/lib/player-input.ts`) y comprobación de la fila existente: lo sale gratis y no gasta API. El **correo es obligatorio** y se guarda en `Player.contactEmail`, para que la organización pueda responder dudas.
5. **Comprobación del perfil** (`src/lib/registration.ts`): `GET /players/:id` con un presupuesto de 8 s. Un 404 es un error de campo en `profileId`; cualquier otro fallo (red, 429, timeout) **no** crea nada y devuelve un mensaje reintentable. Si el perfil existe, se guarda el nombre oficial en `Player.aoe4WorldName` y `Player.name` conserva el de display que escribió la persona.

El resultado siempre se deja en `PENDING`: aprobar o rechazar es decisión de la organización. Lo único que se **reescribe** es un envío de un perfil que estaba `REJECTED`: actualiza esa misma fila (nombre, canal, correo, nombre oficial y retrato) y la devuelve a `PENDING`, en vez de crear una segunda solicitud. Un perfil `APPROVED` o `PENDING` sigue bloqueando el envío.

## Sincronización con AoE4World

El worker descarga las partidas de **todos** los participantes aprobados y las guarda con deduplicación por `(playerId, gameId)`. Trae **todas** las ladders (no solo `rm_solo`): cada partida guarda su `leaderboard` y el JSON crudo de la API para que el motor de puntuación pueda filtrar y recalcular sin volver a historicarlo.

Hay **dos** puntos de entrada, y los dos hacen el mismo trabajo (`syncApprovedPlayers()`):

- **`POST /api/cron/sync`** (y `GET`, porque Vercel Cron solo emite `GET`). Es el del cron. Acepta dos formas de autenticación:
  - sesión de un admin de Supabase (misma protección que el resto de `/admin`), o
  - `Authorization: Bearer $CRON_SECRET` (imprescindible para un cron externo, que no manda cookies).
- **`POST /api/sync`**, público, detrás del botón "Actualizar" de `/partidas`. Exige `content-type: application/json`, que es lo que descarta un POST de otro sitio (un formulario solo manda tipos "simples"), y lleva un candado **global** de un sync cada 5 min (300 s, no 60: ver ["El límite de CPU del plan Free"](#el-límite-de-cpu-del-plan-free-por-qué-el-cron-es-externo)) para que nadie pueda machacar la API de AoE4World desde el navegador. Si se pide antes de tiempo responde `{ "status": "cooldown" }` con 200, porque no es un error: la pasada se hizo hace nada. Si el candado no se puede comprobar, **no** lanza la pasada y responde 503.

```bash
# Desde la terminal, sin levantar el servidor
npm run sync
npm run sync -- 4635035 8139502     # solo esos profileId

# Como route handler (mismo trabajo)
curl -X POST http://localhost:3000/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"

# El disparo público del botón (necesita el content-type, por lo del CSRF)
curl -X POST http://localhost:3000/api/sync -H "content-type: application/json" -d '{}'
```

`/api/cron/sync` devuelve un resumen en JSON con el detalle por jugador (partidas vistas, nuevas, actualizadas, descartadas, resueltas por refetch y abandonadas) y los contadores de la API (peticiones, reintentos, pausas por *rate limit*). `/api/sync` devuelve solo los contadores: al navegador no le aporta nada el detalle.

### Cadencia recomendada

**Cada 5 minutos**. La API pide uso responsable y ya ha devuelto 429; por debajo de 3 minutos el worker dispara demasiadas peticiones por minuto solo con un puñado de jugadores. Con más jugadores, sube `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` antes que la frecuencia. Para F4 ("en directo") 5 minutos es suficiente: una partida en directo se detecta en la siguiente pasada y se marca con `finishedAt = null`.

Hay **dos relojes**, y el primario ya no es GitHub:

| Reloj | Qué es | Frecuencia real |
|---|---|---|
| **Supabase Cron** (primario) | Un job de `pg_cron` en la propia base de datos que llama por HTTP a `POST /api/sync` con `pg_net` | **5 minutos**, con alguna vuelta dentro del candado anterior (ver abajo) |
| [Workflow de GitHub](.github/workflows/cron-sync.yml) (red de seguridad) | Una petición a `POST /api/cron/sync` con `Authorization: Bearer $CRON_SECRET` | GitHub la retrasa a **una cada 4-6 h** |

Se pone el primario abajo; el de GitHub se queda como está, con su `SITE_URL` y su `CRON_SECRET` definidos en el repositorio (Settings > Secrets and variables > Actions), que es lo que necesita para poder seguir funcionando si el otro se cae.

### El disparo desde Supabase Cron (`npm run db:cron`)

```bash
npm run db:cron              # aplica: extensiones + job de 5 minutos (idempotente)
npm run db:cron -- --check   # solo comprueba, no escribe; sale con 1 si no cuadra
npm run db:cron -- --remove  # desprograma el job (vuelta atrás)
```

El script es [`scripts/db-cron.ts`](scripts/db-cron.ts), con el mismo patrón que `scripts/db-security.ts`: SQL crudo con `pg` y `DATABASE_URL`, idempotente, y un `--check` que no escribe. Existe por la misma razón que aquel: **`prisma db push` no gestiona ni las extensiones ni `cron.job`**, así que un job hecho a mano desde el panel de Supabase no estaría en ninguna parte del repositorio.

Aplica exactamente esto:

```sql
create schema if not exists extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'ligahispana-sync',
  '*/5 * * * *',
  $$select net.http_post(
       url := 'https://ligahispana-aoe4.javierr-ma93.workers.dev/api/sync',
       body := '{}'::jsonb,
       headers := '{"Content-Type": "application/json"}'::jsonb,
       timeout_milliseconds := 240000
     );$$
);
```

Cuatro decisiones que no son obvias:

- **Apunta a `/api/sync` (público), no a `/api/cron/sync` (con `CRON_SECRET`).** Para no escribir un secreto en la base de datos: `cron.job.command` es texto plano y `cron.job_run_details` guarda una copia del comando de cada ejecución. El endpoint público no necesita ninguno, y aun así no es una puerta abierta, porque `src/app/api/sync/route.ts` pone las dos condiciones que lo cierran: exige `content-type: application/json` (que es lo que `pg_net` manda siempre, y lo que descarta un POST de formulario de otro sitio) y lleva un **candado global de 5 minutos** (clave `public/manual-sync`). Con eso, ni este job ni quien descubra la URL pueden provocar más de una pasada por ventana. Si alguien pulsa "Actualizar" en `/partidas` dentro de la ventana, el cron recibe `{"status":"cooldown"}` con 200 y no duplica trabajo. Y le pasa también **sin nadie delante**: el job dispara en punto y el candado de la pasada anterior expira unos segundos después de su propio multiplo, así que de vez en cuando el cron llega demasiado pronto y esa vuelta se salta sola (medido: 1 de cada 5 pasadas). No es un fallo, es el precio de reutilizar el candado del botón en vez de llevar un secreto en la base de datos; la cadencia real queda entre 5 y 10 minutos.
- **El nombre del job es fijo** (`ligahispana-sync`) porque `cron.schedule(nombre, ...)` hace *upsert* sobre `jobname_username_uniq`: repetir el script actualiza el job existente en vez de crear un segundo.
- **`timeout_milliseconds` va explícito a 240 s** porque el valor por defecto de `net.http_post` son 2-5 s y una pasada tarda ~15 s: con el valor por defecto la petición se cortaría antes de que el Worker terminara.
- **`pg_net` se instala en `extensions`**, no en `public`: es donde lo pone Supabase y es lo que evita el aviso del *Security Advisor*.

`SITE_URL` sale del entorno y por defecto es `https://ligahispana-aoe4.javierr-ma93.workers.dev`; no hace falta definirlo mientras el dominio no cambie.

**Cómo se comprueba que está disparando.** `npm run db:cron -- --check` imprime las dos extensiones con su versión y esquema, el `jobid`, el `schedule` y el comando tal cual están grabados, el resto de jobs de la base, y las **tres últimas respuestas de `pg_net`** con su código, su hora y su cuerpo (se guardan 6 h). El cuerpo es lo que separa los dos casos que comparten `200`: `"status":"ok"` es una pasada de verdad y `"status":"cooldown"` quiere decir que alguien usó antes el botón "Actualizar" dentro de la ventana. Un `error` o un `sin respuesta (timeout)` en `net._http_response` significa que la petición no salió de la base de datos. También se puede mirar `cron.job_run_details` desde el panel de Supabase y `net._http_response` en el *SQL Editor*.

**Vuelta atrás**: `npm run db:cron -- --remove` desprograma el job y deja las extensiones, que son inertes. Es reversible y repetible: si el job no está, lo dice y no rompe.

Comprobado contra la base de datos real (septiembre de 2026): a través del *Session pooler* de Supabase funcionan `create schema`, `create extension`, `cron.schedule(nombre, ...)` y `cron.unschedule(nombre)`, y el job se crea, se lee y se borra. El pooler no da ningún problema aquí.

Lo único que queda por mirar en vivo es que `cron.use_background_workers` está en **`off`** en este proyecto (es lo que trae Supabase), así que cada ejecución del job **abre una conexión nueva a `cron.host`**, que es `localhost`. Debería funcionar, pero si algún día dejara de poder abrirse el job se programarían igual, no daría ningún error, y solo se vería en `cron.job_run_details`. Por eso `--check` imprime ese ajuste.

### El límite de CPU del plan Free: por qué el cron es externo

Esto no es una preferencia, es la restricción que manda, así que conviene tenerlo medido y escrito.

En el plan **Free**, Cloudflare da **10 ms de CPU por invocación**, y cuenta igual en una petición HTTP que en un Cron Trigger. Una pasada del sync gasta del orden de **500 ms de CPU** (Prisma con su *query compiler* en WASM, el parseo del JSON de la API y el recálculo de la puntuación): unas **50 veces** el presupuesto.

Cada *isolate* tolera que una invocación se pase del límite **de forma esporádica**; lo que no tolera es que se pase de forma consistente, y entonces la mata con `Worker exceeded CPU time limit.` (error 1102). Medido: con un Cron Trigger nativo cada 5 minutos (que se probó y se retiró, commit `459ed27`) el isolate aguantó una hora y a partir de ahí mató **todas** las pasadas — 44 errores en una hora, ni un solo sync terminado. Con el workflow de GitHub, que GitHub retrasa a cada 4-6 h, el exceso es esporádico y pasa. La falta de puntualidad de GitHub, que es lo que llevó a buscar el cron nativo, resulta ser también lo que mantiene el sync dentro de lo que el isolate tolera.

**Supabase Cron no cambia el presupuesto, cambia la cuenta.** La hipótesis detrás de `npm run db:cron` es que el fallo anterior no lo causaba el volumen sino el *self-fetch* del Cron Trigger nativo (dos invocaciones sobre el mismo isolate): con un disparo HTTP externo hay **una sola invocación por evento**, con nada que la comparta. La primera hora de prueba la respalda: entre las 16:05 y las 17:05 UTC del 29-sep-2026, trece pasadas disparadas por `pg_cron`, todas con `200` y **cero** `Worker exceeded CPU time limit`, con la CPU por pasada en 589 ms de media y 852 ms de máximo. **No es una garantía** —el Cron Trigger nativo también aguantó una hora antes de empezar a morir—, así que merece la pena mirar Workers Logs de vez en cuando: si el isolate vuelve a morir con 1102, la conclusión es que el límite no perdona ni así, y toca el plan Paid.

De ahí las dos consecuencias:

- **Un sync cada 5 minutos de verdad necesita el plan Workers Paid** ($5/mes): el presupuesto sube a 30 s por Cron Trigger y 5 min por petición, y el mismo código sobra. Si algún día se sube, el camino ya está andado: el *handler* `scheduled` sobre un *custom worker* de OpenNext (["Custom Worker"](https://opennext.js.org/cloudflare/howtos/custom-worker)) funcionó; lo que no cabía era el CPU, no el mecanismo.
- **Mientras se siga en Free**, el botón "Actualizar" de `/partidas` (`POST /api/sync`) dispara el mismo trabajo y está sujeto a lo mismo: pasa cuando es esporádico. Por eso su candado es de **5 minutos** y no de uno —y por eso el job de Supabase Cron reutiliza ese mismo candado en vez de tener el suyo—: en Free, insistir es lo único que garantiza que Cloudflare empiece a matar pasadas.

### Decisiones de la fase F2

- **"Partida en directo"**: la API solo publica partidas terminadas. Una partida se considera en directo si (`ongoing === true` o `state !== "processed"`) **y** empezó hace menos de `LIVE_GAME_WINDOW_MINUTES = 60`. Se persiste con `finishedAt` y `result` a `null`; en la pasada siguiente la API ya la devuelve procesada y se actualiza.
- **Cursor de sincronización**: por jugador, en `Setting`, clave `aoe4world.sync.player.<profileId>` → `{ since, maxStartedAt, lastSyncedAt, historyTruncated, abandonedCount, abandonedGameIds, lastAbandonedAt }`. `since` es el `startedAt` más nuevo visto menos 60 min de solape, para no perder partidas que la API publica con retraso. El cursor nunca retrocede.
- **Refetch de partidas en curso**: el cursor puede dejar una partida en curso fuera del listado para siempre (si `startedAt < since`). Antes de paginar, el worker busca las partidas propias con `finishedAt IS NULL` que caigan fuera de la ventana y las refresca con `GET /players/:id/games/:game_id`. Coste habitual: 0 a 2 llamadas por jugador y pasada.
- **Partida abandonada**: si la API nunca publica el desenlace, **esa partida no cuenta nunca** (regla del torneo, ver [`docs/PLAN.md`](docs/PLAN.md)). El worker borra la fila para que F3 no pueda colarla y deja rastro en `Setting`. Nunca se resuelve como `LOSS` automáticamente.
- **Tope de histórico**: 10 páginas × 50 partidas en la primera pasada (la API nunca devuelve más de 50 por página, aunque se pidan más). Como pagina de más reciente a más antigua, el tope recorta el pasado y nunca deja sin traer partidas nuevas; `historyTruncated` deja constancia de que quedó histórico por traer.
- **`result` es nullable**: en una partida en curso el resultado todavía no existe. F3 debe puntuar solo partidas con `result` y `finishedAt`.
- **`points` se deja a 0**: los calcula el motor de F3.
- **Rival guardado**: en modos por equipos (`rm_2v2` y superiores) se guarda el primer jugador del equipo contrario, porque el schema tiene un único par de campos de rival. El equipo completo queda en `rawJson`.

### Verificación

```bash
npm run verify:sync          # normalización con datos de ejemplo (no necesita BBDD)
npm run verify:sync -- --db  # además comprueba el guardado y borra lo que crea
```

`--db` necesita `DATABASE_URL` y trabaja con un jugador de prueba (`profileId` 9000001) que **borra al terminar siempre, incluso si una comprobación falla**, así que se puede repetir tantas veces como haga falta. Solo hay un caso en el que se niega a arrancar: que ese jugador ya exista porque una ejecución anterior murió antes de poder limpiarlo; entonces avisa y para para no pisar datos ajenos. Borrarlo con `npm run simulate:clean` no sirve (es de otra simulación), así que se borra desde `/admin/jugadores` o a mano por su `profileId`.

## Simulación local (mock de AoE4World)

Para ver `/` y `/partidas` poblados sin depender de la API real y sin gastar cuota de *rate limit* existe un modo mock, **opt-in** y solo para desarrollo:

- `AOE4WORLD_MOCK=1` intercepta el único punto de salida HTTP, `performRequest()` en `src/lib/aoe4world/http.ts`, y responde con las fixtures locales de `src/lib/aoe4world/mock/` en lugar de salir a la red. Los parsers, el worker y el motor de puntuación son exactamente los mismos, así que la simulación ejercita el código real: cualquier cambio futuro del worker se sigue probando contra el mismo flujo.
- Con el flag activo y `NODE_ENV=production`, la configuración falla al arrancar: el mock no puede estar activo en producción. Por defecto (`0`) no hay ningún cambio de comportamiento.

```bash
npm run mock:tournament  # crea o actualiza el torneo simulado y sincroniza
npm run mock:clean       # retira exactamente lo que crea la simulación
```

`npm run mock:tournament`:

- Crea o actualiza los **10 participantes** del torneo simulado como `APPROVED`, con `profileId` en el rango reservado `90000001`–`90000010` (no se solapa con perfiles reales ni con el jugador de prueba de `verify:sync --db`).
- Sincroniza **solo esos perfiles**: no toca ni le pide nada a ningún otro jugador aprobado que haya en la base, y al final recalcula la clasificación.
- Resultado: **127 filas de partida** (71 partidas distintas: 68 terminadas y 3 en directo), de las que **122 están resueltas** con resultado informado. Los 3 directos dejan **5 filas** con `finishedAt` a `null`: una sola en el cruce contra un rival externo y dos por cada cruce entre participantes. Además, **10 puntuaciones distintas** entre sí y **5 canales de Twitch** entre los participantes.
- **Rivales externos**: el calendario incluye partidas contra gente de la ladder que no juega la liga, con `profileId` en el rango reservado `92000001`–`92000010`: **20 terminadas** (dos por participante, una ganada y una perdida, que dejan los totales separados entre sí) y **1 de los 3 directos** (Serrano Hernández contra Brazo de Plata). Esos rivales **no** se convierten en filas `Player`: solo aparecen como `opponentProfileId` / `opponentName`, igual que en la base real.
- Es **idempotente**: se puede lanzar N veces seguidas sin duplicar partidas ni acumular basura.

`npm run mock:clean` borra exactamente esos 10 jugadores (la cascada del schema borra sus `Match` y `PlayerScore`) y sus cursores `Setting` (`aoe4world.sync.player.<profileId>`), sin tocar nada ni nadie más de la base de datos.

> **Aviso**: el cron `POST /api/cron/sync` también respeta el flag. Si activas el mock en local con jugadores reales aprobados, esos perfiles recibirán 404 del mock (no existen en las fixtures); por eso el script acota la pasada a los perfiles del torneo simulado.

Cómo se sostiene en el tiempo: el histórico de partidas terminadas está anclado a una **epoch fija**, así que no se mueve entre ejecuciones, y las **3 partidas en vivo** recalculan su `started_at` como "hace 10–20 minutos" en cada petición. De ese modo nunca salen de la ventana de 60 minutos que define "en directo" ni se borran por abandonadas, aunque la simulación repose días.

## Torneo simulado con jugadores reales (API de verdad)

`mock:tournament` usa fixtures. Esta otra simulación mete en la base de datos **gente real de la ladder de AoE4World**, con sus partidas reales, para probar la web con datos de verdad sin esperar al torneo real.

```bash
npm run simulate:tournament                    # elige, da de alta, importa la ventana y recalcula
npm run simulate:tournament -- --select-only   # solo elige y lo informa (no toca la base de datos)
npm run simulate:tournament -- --max-candidates=30 --max-pages=6   # más margen para divisiones difíciles
npm run simulate:clean                         # deshace lo que creó
npm run simulate:clean -- --dry-run            # comprueba qué borraría, sin borrar nada
```

- **Quién entra**: un jugador por división (`src/lib/divisions.ts`) con **más de 20 partidas de ladder (`rm_solo`) en los últimos 14 días**, contadas con el mismo criterio con el que se importan (`normalizeGame`), así que el número del informe es el número de filas que acaban en la tabla.
- **Cómo se los busca**: la API **ignora** `rating_min`/`rating_max` y `rank_level` (devuelven siempre la página 1), así que no hay forma de pedir "los bronces". El script recorre la ladder por páginas con **búsqueda binaria** sobre la monotonía de las divisiones (~49 llamadas en vez de las 461 que tiene `rm_solo`), lee las primeras páginas de cada bloque y valida candidatos de uno en uno. Se eligen por orden de ladder dentro de la división, así que el reparto es siempre el mismo mientras la ladder no se mueva.
- **Ventana**: el torneo simulado son 4 semanas de las que ya han pasado 3. El script **siembra el cursor de sincronización** de cada jugador en el arranque del torneo en vez de dejar que el worker recorra el histórico entero (miles de partidas que no cuentan), y a partir de ahí el cursor avanza con normalidad: la simulación **sigue creciendo** con cada pasada real del cron.
- **Elo, división, racha y avatar** no se rellenan en el alta: los deja `syncLadderSnapshot`, el mismo paso que usa el worker con todos los jugadores aprobados.
- **Coste**: ~90 llamadas a la API y unos 40 s (49 de búsqueda binaria + 18 de páginas + ~24 de conteo de partidas), más ~17 llamadas y ~6 s para importar la ventana.
- **Idempotente**: repetirlo no duplica jugadores ni partidas, no resetea el cursor hacia atrás y vuelve a imprimir la misma clasificación.

### Cómo se deshace (importante)

La base de datos es la de producción y dentro de un mes contendrá los participantes de verdad, así que **no hay ningún rango de `profileId` reservado** que marque las filas de esta simulación. Lo que la marca es el **manifiesto** que el script escribe en `Setting["simulation.roster"]`: la lista de jugadores que dio de alta, con la identidad usada en el momento (`profileId`, nombre, división, fecha de la ventana).

`npm run simulate:clean`:

1. Lee el manifiesto. Si no hay manifiesto, no borra nada y lo dice (no adivina).
2. **Comprueba la identidad de cada fila** contra el manifiesto antes de tocar nada: si el número de filas no cuadra, si algún `profileId` no está en el manifiesto o si **el nombre de la fila no es el que escribió la simulación** (por ejemplo, porque alguien lo editó en `/admin`), **aborta y no borra**.
3. Avisa (sin abortar) de los jugadores que quedaron de una ejecución anterior y de las partidas que caen fuera de la ventana del torneo, porque el borrado en cascada se las llevaría por delante.
4. Solo entonces borra: los 6 jugadores (y en cascada sus `Match` y `PlayerScore`), sus cursores `aoe4world.sync.player.<profileId>` y el propio manifiesto. Las partidas en las que esos jugadores eran **rivales** de otros no se tocan: son de otros.

Use `--dry-run` antes si quiere ver el plan sin ejecutar nada. Y si el manifiesto llegara a perderse, el borrado hay que hacerlo **a mano**: es preferible a borrar filas de participantes reales.

## Panel de administración

Acceso en `/admin`, protegido con **Supabase Auth** (cookies SSR vía `@supabase/ssr` + `src/proxy.ts`). Cualquier usuario autenticado es admin, así que **desactiva los registros públicos** en Supabase (Authentication → Sign In / Providers) y crea las cuentas a mano.

- `/login` — inicio de sesión.
- `/admin` — resumen (jugadores, aprobados, pendientes, partidas).
- `/admin/jugadores` — alta de jugadores por `profileId` de AoE4World, aprobación/rechazo y borrado.

## Modelo de datos (inicial)

- `Player`: participante (`profileId` de AoE4World, nombre, canal de Twitch opcional, estado PENDING/APPROVED/REJECTED).
- `Match`: partida de un jugador (`gameId`, `leaderboard`, resultado, civs, mapa, fechas, puntos y JSON crudo de la API). Se guardan **todas** las partidas, no solo las clasificatorias: el filtro es del motor de puntuación. La unicidad es por `(playerId, gameId)`: en un torneo individual dos participantes pueden jugar la misma partida y cada uno necesita su fila.
- `Setting`: configuración del torneo (fechas, reglas, etc.) y memoria del worker (`aoe4world.sync.player.<profileId>`).
- `RateLimitCounter`: contador de frecuencia de los endpoints públicos sin sesión, una fila por clave (`ip:<hmac>` o `global`). Nunca contiene una IP: solo su hash. La gestiona `src/lib/rate-limit.ts`.

## Estado y plan

- **Estado actual**: F0 completada (setup, Prisma, BBDD conectada y sincronizada), F1 completada (auth con Supabase + panel admin) y F2 completada (cliente de la API de AoE4World + worker de sincronización).
- **Plan completo** (roadmap, arquitectura, decisiones): ver [`docs/PLAN.md`](docs/PLAN.md).

## Agentes y skills

`AGENTS.md` es la guía del **orquestador**: contexto general del proyecto y reglas de enrutado. El trabajo se delega a dos subagentes, cada uno con su propio md y sus skills cargadas en el paso 0:

| Subagente | Ámbito | Skills |
|---|---|---|
| `@design-ux` (`.opencode/agent/design-ux.md`) | UI, componentes, Tailwind, copy | `design-taste-frontend`, `frontend-design` |
| `@logic-data` (`.opencode/agent/logic-data.md`) | Lógica, Prisma, Supabase, API de AoE4World, workers | `vercel-react-best-practices`, `supabase`, `supabase-postgres-best-practices` |

Las skills viven en `.opencode/skills/` (scope del proyecto, versionadas), no globalmente. Origen y actualización:

```bash
npx skills update                                  # actualiza las instaladas
npx skills add supabase/agent-skills --skill supabase -a opencode -y   # reinstallar o añadir
```

| Skill | Origen |
|---|---|
| `design-taste-frontend` | [leonxlnx/taste-skill](https://github.com/leonxlnx/taste-skill) |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) |
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) |
| `supabase` | [supabase/agent-skills](https://github.com/supabase/agent-skills) |
| `supabase-postgres-best-practices` | [supabase/agent-skills](https://github.com/supabase/agent-skills) |

