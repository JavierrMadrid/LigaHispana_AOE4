# Despliegue — Liga Hispana AoE4

Desarrollo del Worker de Cloudflare: cómo se construye, por qué está configurado como está y
qué se comprobó al hacerlo. El resumen operativo (qué ejecutar para publicar) está en el
[README](../README.md#despliegue-en-cloudflare-workers); lo que hay que hacer en la base de
datos después de desplegar, en [`docs/OPERACION.md`](./OPERACION.md).

## Cómo se construye el Worker

El despliegue es un **Worker** construido con **OpenNext** (`@opennextjs/cloudflare`): `next build`
produce `.next/`, OpenNext lo convierte en `.open-next/` y de ahí sale el Worker. En local, la web
corre en Node; el mismo código se empaqueta para el runtime de `workerd`.

**`wrangler.jsonc` y `open-next.config.ts` están versionados a propósito.**
`@opennextjs/cloudflare` los crea durante el build si no existen, pero entonces su contenido se
pierde en cada despliegue: las variables y secretos que estén en el panel dejan de viajar al
Worker, porque `wrangler deploy` reconstruye el Worker solo con lo que trae el archivo. El
`wrangler.jsonc` versionado trae `main: ".open-next/worker.js"`, el `name` del Worker,
`assets.directory`, el *service binding* `WORKER_SELF_REFERENCE`, el binding `IMAGES`, el binding
`HYPERDRIVE`, el bloque de observabilidad y los *compatibility flags*; **los secretos no van ahí**,
se siguen poniendo en el panel.

La plantilla de la que sale el `wrangler.jsonc` del repo es
`node_modules/@opennextjs/cloudflare/templates/wrangler.jsonc` (una vez instalado el paquete):

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

- **`name` tiene que ser el Worker donde están las variables.** Si no coincide, se despliega a otro
  Worker, sin bindings, y todo lo de más pasa desapercibido porque la app responde igual. Es la
  primera causa que hay que descartar.
- **`compatibility_date`: el umbral es 2025-04-01 y el valor del repo es `2025-03-25`, por debajo.**
  `nodejs_compat_populate_process_env` (el flag que vuelca los *bindings* en `process.env`) está
  activo por defecto a partir de 2025-04-01, así que **hoy no lo está**. Una versión anterior de
  este documento decía que la fecha la generaba la CLI a partir del último `workerd` de npm y que
  por eso "ya era moderna": es falso. El valor real está en el `wrangler.jsonc` versionado y se
  puede confirmar en el panel (Settings → *Deployments*), que hoy enseña `2025-03-25`.
  **No rompe nada**, porque el proyecto no depende de ese relleno: toda lectura de configuración
  del servidor pasa por [`src/lib/runtime-env.ts`](../src/lib/runtime-env.ts), que lee **los
  bindings** y usa `process.env` solo como reserva (ver
  [Cómo se lee la configuración en el Worker](#cómo-se-lee-la-configuración-en-el-worker)).
- **Subir la fecha es una opción con riesgo, no un arreglo pendiente, y no se ha hecho.** Workers
  Builds avisa en cada build:

  ```txt
  WARN workerd compatibility_date: 2025-03-25, consider updating your wrangler
  config to a more recent date to benefit from the latest features and fixes.
  ```

  Ese aviso se puede ignorar mientras siga siendo eso. Lo que no es gratis es moverla:
  `compatibility_date` gobierna el comportamiento del runtime, así que subirla en un Worker de
  producción puede cambiar cómo se ejecutan cosas que hoy funcionan (parcheos de `workerd`
  activados por fecha), y el proyecto depende de ese runtime para lo más delicado que tiene: la
  conexión a Postgres y el cliente de Prisma por invocación. Si algún día se sube, es una decisión
  de la organización, y toca comprobar a mano las tres páginas que leen la base (`/`, `/partidas`,
  `/objetivos`).
- **Los secretos no van aquí.** Se siguen poniendo en el panel (Settings → Variables and Secrets) y
  se despliega con `npx wrangler deploy --keep-vars`. Solo las *vars* de texto que Next u OpenNext
  necesitan en build (p. ej. `NEXTJS_ENV`) van en el archivo. Y lo que el build necesita **además**,
  en *Build variables and secrets* del trigger, es **otra lista**: ver
  [Los dos sitios del panel](#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables).
- Para **ver el `name` y los bindings que se están usando hoy** sin desplegar:
  `npx wrangler deploy --dry-run` imprime a qué Worker y con qué bindings sube, y falla si el
  archivo no cuadra con lo que hay en `.open-next`. El `compatibility_date` no lo imprime: ese está
  en el `wrangler.jsonc` versionado y en el panel (Settings → *Deployments*).

### El bloque `triggers`

`"triggers": { "crons": [] }` está declarado a propósito y **no es decorativo**: `wrangler deploy`
solo reemplaza los Cron Triggers existentes por los del archivo, y con la clave `undefined` **los
deja como están**. Quitar la clave al retirar el cron nativo dejó el trigger vivo disparando cada
5 minutos contra un Worker sin *handler* `scheduled` hasta que se declaró el array vacío. Con
`"crons": []` el despliegue los borra. El motivo de no usar un cron nativo está en
[`docs/OPERACION.md`](./OPERACION.md#el-límite-de-cpu-del-plan-free).

### El bloque `observability`

Workers Logs está en `wrangler.jsonc` por el mismo motivo que el resto del archivo: `wrangler
deploy` reconstruye el Worker solo con lo que trae el archivo, así que si el bloque `observability`
no está ahí, el Worker se vuelve a desplegar sin trazas y el problema se repite en cada despliegue.
Sin él, `/`, `/partidas` y `/objetivos` fallan con frecuencia y no hay forma de saber por qué: son
las páginas que leen de Postgres, así que hace falta el error del servidor, no el del navegador.
`head_sampling_rate: 1` (el máximo) porque el tráfico del torneo es bajo: sin muestreo se guarda
cada petición y no queda ningún fallo fuera, que es justo lo que se necesita para diagnosticar. Si
algún día el tráfico sube, bajarlo es un número aquí y un redespliegue.

## `pg-cloudflare` es dependencia de producción explícita

`pg` comprueba en runtime si está dentro de un Worker y, si lo está, usa un socket de TCP
(`cloudflare:sockets`) en lugar de `net`/`tls` de Node. Para hacerlo hace un
`require('pg-cloudflare')` **estático** en `pg/lib/stream.js`, dentro de la rama de Cloudflare: el
empaquetador tiene que resolver ese módulo aunque en local la rama no se ejecute nunca. `pg` lo
declara como `optionalDependency`, y una dependencia opcional no es una garantía para el
empaquetado. El build de Cloudflare falló exactamente por eso:

```
.open-next/server-functions/default/node_modules/pg/lib/stream.js:41:41: ERROR: Could not resolve "pg-cloudflare"
```

Por eso `pg-cloudflare` está en `dependencies` de `package.json` y no solo colgada de `pg`. Es el
mismo patrón que siguen las librerías con código específico de `workerd`: el paquete publica un
*conditional export* bajo la condición `workerd` y un fichero **vacío** en el resto de condiciones,
así que si el empaquetador no aplica esa condición el bundle compila sin quejarse pero el socket
llega `undefined` en runtime. `wrangler` sí la aplica, y conviene comprobarlo en el bundle si
alguna vez se ve un `CloudflareSocket is not a constructor`.

## La rama `workerd` de `pg-cloudflare` tiene que entrar en el trace

Con la dependencia declarada el build **siguió fallando** con el mismo error, y esta vez por otra
razón que no se arregla tocando dependencias: los dos pasos de OpenNext resuelven el paquete con
**condiciones distintas**.

1. **El copiado** (`copyTracedFiles`, en `@opennextjs/aws`) copia, fichero a fichero, lo que
   aparece en los `.nft.json` que escribe `next build`. El trazador (`@vercel/nft`) resuelve con las
   condiciones de **Node**, y en `pg-cloudflare` la única de esas es `default`, que apunta a
   `dist/empty.js`: al `.open-next` solo van `package.json` y `dist/empty.js`.
2. **El empaquetado** (`bundleServer`, en `@opennextjs/cloudflare`) lanza esbuild con
   `platform: "node"` y `conditions: ["workerd"]`, así que el mismo
   `require('pg-cloudflare')` de `pg/lib/stream.js:41` resuelve a la rama `workerd` → `require` →
   **`dist/index.js`**, que no está en el directorio copiado.

De ahí el `The module "./dist/index.js" was not found on the file system`. El paquete estaba
entero; lo que faltaba era en la carpeta del bundle. **El arreglo es
`outputFileTracingIncludes` en `next.config.ts`**, que le dice a Next que meta en el trace, para
todas las rutas, los ficheros de la rama `workerd`:

```ts
outputFileTracingIncludes: {
  "/*": ["node_modules/pg-cloudflare/dist/**/*", "node_modules/pg-cloudflare/esm/**/*"],
},
```

`dist` es la rama que se empaqueta (la `require`) y `esm` la `import`, que además importa
`../dist/index.js`; sin las dos, el bundle compila pero el socket llega vacío. Con las dos, el
`.nft.json` de cada ruta incluye `pg-cloudflare/dist/index.js`, OpenNext lo copia y esbuild lo
encuentra con la condición `workerd`.

Por qué esta opción y no las otras:

- **No depende de la versión de `@opennextjs/cloudflare`.** Existe otra vía, la que documenta
  OpenNext (`serverExternalPackages` + `copyWorkerdPackages`, que copia el paquete entero y
  reescribe su `package.json` solo con la rama `workerd`), pero `copyWorkerdPackages` **solo**
  actúa sobre paquetes que estén en `serverExternalPackages` **y** tengan condición `workerd`
  reconocida
  ([`workerd.ts`](https://github.com/opennextjs/opennextjs-cloudflare/blob/main/packages/cloudflare/src/cli/build/utils/workerd.ts)).
  Con las versiones anteriores a [PR #1243](https://github.com/opennextjs/opennextjs-cloudflare/pull/1243)
  (fusionada el 2026-05-04) esa condición no se reconocía cuando su valor es un **objeto**, que es
  justo el caso de `pg-cloudflare` (`"workerd": { "import": ..., "require": ... }`). Es decir: la
  vía "oficial" depende de con qué versión se construya, y aquí la versión la elige el entorno de
  build de Cloudflare, no el repo.
- **No toca `node_modules`.** Normalizar el `package.json` de `pg-cloudflare` desde un `postinstall`
  (dejar `dist/index.js` alcanzable también por `default`) funciona, pero muta el árbol de
  dependencias, se pierde con cualquier reinstalación y un día `npm ci` lo deshace sin avisar.
- **No evita la rama estática de `pg`.** Habría que parchear `pg` o cambiar de driver, que es una
  decisión de stack, no un arreglo de build.
- **No necesita tocar `wrangler.jsonc` ni `open-next.config.ts`**: el arreglo va en
  `next.config.ts`, así que el Worker se sigue construyendo con el `name` y los bindings de siempre.

### Comprobación de que el arreglo funciona

Los dos scripts de reproducción viven **fuera del repo**, en `<temp>\pgcf-repro` (`repro.mjs` y
`runtime-check.mjs`): `repro.mjs` copia a `.open-next/server-functions/default/node_modules/` los
ficheros que el trace real de `next build` manda a standalone —el mismo origen que usa
`copyTracedFiles`— y luego lanza esbuild con las mismas opciones que `bundleServer`.

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

`broken` quita del trace la rama `workerd`, que es exactamente como se quedaba sin el arreglo;
`traced` copia el trace tal cual. `runtime-check.mjs` falsea `navigator.userAgent =
"Cloudflare-Workers"` para ejecutar la rama de Cloudflare fuera de `workerd` y comprobar que la
clase del socket es la buena.

Dos avisos que quedan para el runtime:

- `pg` **no** tiene condición `workerd`: el socket se elige en runtime. Si el bundle saliera sin
  esa rama, el build pasaría y fallaría luego con `CloudflareSocket is not a constructor` (o
  `proxy request failed`, si lo que falta es el socket y no la clase). **Comprobado**:
  `.open-next/server-functions/default/handler.mjs` trae `cloudflare:sockets`, así que la rama de
  `workerd` sí está empaquetada.
- Cloudflare documenta crear un cliente nuevo **por petición** ("create a new `Client` instance for
  each request"), porque en un Worker una conexión no se puede reutilizar entre invocaciones.
  **Ya está arreglado**: `src/lib/db.ts` crea un cliente por invocación (ver
  [El cliente de Prisma](#el-cliente-de-prisma-uno-por-invocación-en-el-worker-y-uno-fuera-de-él)).

## Prisma 7 necesita `runtime = "workerd"`: sin esto no hay base de datos

Síntoma en el Worker desplegado: la web entera responde 500, y la primera consulta a la base muere
con

```json
{ "ok": false, "name": "CompileError",
  "message": "WebAssembly.Module(): Wasm code generation disallowed by embedder" }
```

No es un problema de secretos ni de conexión. Prisma 7 no lleva el motor de consultas como binario,
sino el *query compiler* como **WASM**, y con el runtime por defecto (`nodejs`) el cliente
generado lo mete **en base64 dentro del propio JS** y lo compila en runtime
(`src/generated/prisma/internal/class.ts`):

```ts
async function decodeBase64AsWasm(wasmBase64: string): Promise<WebAssembly.Module> {
  const wasmArray = Buffer.from(wasmBase64, "base64");
  return new WebAssembly.Module(wasmArray);   // <- prohibido en workerd
}
```

`workerd` prohíbe eso por completo, y no es un matiz: `WebAssembly.compile`,
`WebAssembly.instantiate` y el constructor síncrono `new WebAssembly.Module` están bloqueados,
porque construir un módulo desde *bytes* es **generación de código**, igual que `eval` o
`new Function` (["el módulo tiene que venir ya compilado de
fuera"](https://developers.cloudflare.com/workers/runtime-apis/webassembly/),
[workerd#3345](https://github.com/cloudflare/workerd/issues/3345)). Es el bug abierto
[prisma/prisma#28657](https://github.com/prisma/prisma/issues/28657) y ocurre con **cualquier**
datasource, así que no se esquiva cambiando de base de datos ni de driver.

El arreglo es una línea en el bloque `generator` de [`prisma/schema.prisma`](../prisma/schema.prisma):

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
  runtime  = "workerd"
}
```

Con `workerd`, el cliente generado **importa el `.wasm` como módulo** en vez de compilarlo desde un
base64, y desaparece el `CompileError`. De ahí en adelante lo resuelve la cadena habitual: Turbopack
emite el `.wasm` como *chunk* en `.next/server/chunks/`, `next build` lo mete en el trace
(`.nft.json`) y OpenNext parchea los ayudantes de carga de Turbopack (`loadWebAssemblyModule`,
`compileModule`, `instantiateStreaming`, que `workerd` tampoco tiene) para que pasen por su
`loadWasmChunk`, un `switch` de `import()` estáticos que el empaquetador puede descubrir. Ese parche
para Next 16.3+ está en `@opennextjs/cloudflare` 1.20.7, que es la versión fijada aquí.

**Después de tocar el schema hay que regenerar**, o el cambio no existe: `npx prisma generate` (lo
hace el `postinstall` de `npm install`).

Dos cosas que **no** hay que confundir con esto:

- **Los secretos no tienen nada que ver.** Si `db` devuelve este error, el `DATABASE_URL` está bien
  resuelto; el fallo ocurre al *arrancar* el cliente, antes de abrir conexión. Un `DATABASE_URL no
  está definida` es un problema distinto, de configuración.
- **En local no se reproduce y no hay que tocar nada.** En Node `new WebAssembly.Module` es legal,
  así que `next dev` funciona con cualquiera de los dos runtimes. Los reportes de que
  `runtime = "workerd"` rompe el desarrollo local son de proyectos con Vite; con Turbopack y esta
  configuración no aparece ningún problema. En el Worker se comprueba con la sonda de
  [Cómo comprobar que funciona](#cómo-comprobar-que-la-configuración-se-lee).

### Lo que el runtime rompe: los scripts de `scripts/`

`workerd` **sí** rompe los scripts de `scripts/`, que corren con `tsx`. No es un problema de
Turbopack sino del runtime elegido: Prisma emite el import
`"./query_compiler_fast_bg.wasm?module"` **solo** en los runtimes edge (`workerd` y `vercel-edge`,
[commit 9b8e186](https://github.com/prisma/prisma/commit/9b8e1867de8e34334d521c9e736ac87a4cbb797e)),
y `?module` es una convención de empaquetador: ni Node ni `tsx` la entienden, así que el import
resuelve a `undefined` y la consulta falla con `The loaded wasm module was unexpectedly undefined
or null once loaded`. `cloudflare` es un alias de `workerd`, no una variante, así que no hay un
valor del generator que valga para los dos lados a la vez.

**No se arregla generando los dos clientes**, que es lo primero que parece: `src/lib` es
compartido. `scripts/verify-sync.ts` importa `@/lib/scoring` y `@/lib/settings`, y con ellos
`@/lib/aoe4world/sync`, `@/lib/aoe4world/ladder`, `@/lib/public`, `@/lib/rate-limit` y
`@/lib/simulation/roster`; los siete importan `@/lib/db`. O sea, que `db` tendría que elegir el
cliente en runtime, y entonces los dos clientes entran en el bundle del Worker: el de Node lleva el
query compiler entero en base64 dentro del JS (~4,6 MB) **encima** del `.wasm` del de `workerd`
(~3,4 MB). Separar los clientes obligaría a duplicar medio `src/lib` para los scripts, o a
moverlos dentro del Worker.

**Sí se arregla enseñándole a Node la convención del empaquetador**, que es lo que hace
[`scripts/prisma-wasm-node.mjs`](../scripts/prisma-wasm-node.mjs): una precarga con `--import` que
registra ganchos de carga de módulos y sustituye `"./x.wasm?module"` por un módulo CommonJS que lee
el `.wasm` del disco y lo publica como `default`. Los ganchos viven en
[`scripts/prisma-wasm-node-hooks.mjs`](../scripts/prisma-wasm-node-hooks.mjs) porque
`module.register()`, que es la API con la que se registran, los exige en otro módulo. Es el mismo
`WebAssembly.Module` que recibe `workerd`, así que Prisma no necesita enterarse de nada más y
`runtime = "workerd"` se queda como está. Los ganchos van en el fichero de los scripts, no en
`src/lib`, porque la diferencia real entre los dos entornos es **cómo se importa un módulo**:
`src/lib/db.ts` lo usa también el Worker, donde `node:fs` no existe.

Lo que había que arreglar son **dos** cosas, no una, y la segunda es la que más engaña:

1. `?module` forma parte del nombre de fichero en Node, así que el import apunta a algo que no
   existe.
2. Aunque se arreglara eso, la importación nativa de `.wasm` que hace Node devuelve el espacio de
   nombres de **exports** del módulo, **sin `default`**. Prisma hace `const { default: module } = ...`
   y seguiría recibiendo `undefined`. Los ganchos devuelven el módulo **y** una autorreferencia en
   `default` más `__esModule`, para que el valor llegue bien tanto si tsx deja la instrucción
   dinámica como `import()` de ESM como si la compila a `require()`.

Por eso los ganchos se registran con **`module.register()`** (los asíncronos, que corren en su
propio hilo) y no con `module.registerHooks()` (los síncronos). La razón de siempre —que los
síncronos atienden también a `require()`— ya no compensa, porque con Node 22.22 **no llega a
ejecutarse nada**: el primer módulo que carga cualquiera de estos scripts es el propio script, que
tsx resuelve como `"commonjs"`, y al delegar `nextLoad(url, context)` con ese formato Node entra en
su camino nativo de carga CommonJS, que no devuelve `source` y hace que la validación del gancho
reviente con `ERR_INVALID_RETURN_PROPERTY_VALUE` ("Expected a string, an ArrayBuffer, or a TypedArray
to be returned for the source from the load hook but got undefined"). No es culpa del shim: se
reproduce igual con un `registerHooks()` de tres líneas que solo devuelve `next(url, ctx)`, y con
cualquier gancho síncrono junto a tsx. Devolver un `source` propio tampoco vale, porque para un
módulo CommonJS eso significa entregar un módulo vacío y el script saldría con código 0 sin hacer
nada.

Los asíncronos no pierden el `require()`: el `import()` del cliente generado **sobrevive** a la
compilación de tsx (esbuild lo deja como `import()` porque el destino es Node), así que la
importación del `.wasm` siempre entra por el cargador de ESM. Es además la misma vía que usa tsx por
su cuenta, así que los dos se apoyan en ella.

Se aplica en `package.json` a los scripts que **consultan** la base (`sync`, `score`,
`backfill:model`, `verify:sync`, `verify:alerts`, `alerts:check`, `alerts:cutoffs`, `db:window`,
`countries:seed`, `mock:tournament`, `mock:clean`, `simulate:tournament`, `simulate:clean`):

```json
"verify:sync": "tsx --import ./scripts/prisma-wasm-node.mjs --conditions=react-server scripts/verify-sync.ts"
```

Si aparece esa precarga en un script nuevo, es porque también va a tocar la base. Los que no la
llevan o no usan Prisma (`db:security` y `db:cron`, que hablan con `pg` directamente; `verify:sync`
sin `--db`; `brand:assets`) no la necesitan.

**El Worker no se ve afectado**: este fichero solo se importa desde Node con `--import`, así que no
entra en el bundle. En `next dev` y `next build` manda Turbopack, que ya entendía el `?module`. La
sincronización y el recálculo de producción siguen yendo por `POST /api/cron/sync` (ver
[`docs/OPERACION.md`](./OPERACION.md#sincronización)), con el cliente de `workerd`.

**La excepción es `npm run db:security`, que sí se ha arreglado**: al no depender de nada de Prisma,
se ha pasado a hablar con `pg` directamente. Ese script es el que aplica y comprueba la postura de
RLS de la base de datos, así que perderlo habría sido perder el control de la seguridad del torneo.
Sigue funcionando entero, con su comprobación previa y sus códigos de salida.

## Cómo se lee la configuración en el Worker

En un Worker `process.env` **no** es el entorno del proceso. Cloudflare lo dice sin rodeos: *"In the
Workers implementation, there is no process-level environment, so by default `env` is an empty
object"*, y solo se puebla con los bindings cuando está el flag
`nodejs_compat_populate_process_env` (activo por defecto para `compatibility_date` de 2025-04-01 o
posterior) — [docs de
Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/nodejs/process/#processenv). **En
este proyecto ese flag no está activo**: el `compatibility_date` es `2025-03-25`, anterior al
umbral (ver [`compatibility_date`](#cómo-se-construye-el-worker)). Por
su parte, `@opennextjs/cloudflare` copia también a `process.env` las entradas de texto del `env` que
recibe el `fetch`, en la primera invocación del isolate
([`populateProcessEnv`](https://github.com/opennextjs/opennextjs-cloudflare/blob/main/packages/cloudflare/src/cli/templates/init.ts)).

Ese doble camino es frágil: si no ocurre, la variable está en el panel y `process.env` sale sin
ella, y la app cree que no está configurada. Ya pasó aquí: con `DATABASE_URL`, `CRON_SECRET`,
`RATE_LIMIT_SALT` y `TURNSTILE_SECRET_KEY` definidos en el panel, el Worker desplegado no veía
ninguna, y lo observable era `DATABASE_URL no está definida.`, el captcha desactivado en silencio y
el cron sin poder autenticarse.

Por eso **toda lectura de configuración del servidor pasa por
[`src/lib/runtime-env.ts`](../src/lib/runtime-env.ts)**, que lee **los bindings de Cloudflare
primero y `process.env` como reserva**:

```ts
import { readRuntimeEnv } from "@/lib/runtime-env";

const secret = readRuntimeEnv("CRON_SECRET");
```

- **Sin condicionales por entorno.** Donde no hay Worker no hay bindings y sale `process.env`: en
  local (Node y `.env`), en los scripts de `scripts/` y en cualquier otro hosting sigue
  funcionando igual que antes.
- **El módulo no importa nada**: ni `@opennextjs/cloudflare`, ni `server-only`. Lee el símbolo global
  `__cloudflare-context__` que publica el *entrypoint* del Worker, que es literalmente lo que
  devuelve `getCloudflareContext()`. Así no hace falta declarar `@opennextjs/cloudflare` como
  dependencia de producción —lleva `wrangler` y `next` como *peer dependencies* que `npm`
  instalaría, cambiando lo que Cloudflare construye— ni tocar `next.config.ts`, que es justo el
  fichero que decide cómo se detecta y se construye el proyecto.
- **`src/lib/db.ts` sigue siendo perezoso.** La lectura sigue estando en la primera llamada, no al
  importar, así que `next build` continúa sin necesitar `DATABASE_URL`.

**Lo que no pasa por ahí, y por qué:**

- **`NEXT_PUBLIC_*`** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_SITE_URL`). Next las sustituye por un literal al
  compilar, y solo lo hace con la forma **estática** `process.env.NEXT_PUBLIC_ALGO`: un acceso por
  nombre dinámico no se sustituye y en el cliente valdría `undefined` (*"dynamic lookups will not be
  inlined"*, [docs de
  Next](https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser)).
  Un binding del Worker no puede llegar al bundle del navegador de ninguna manera. Consecuencia
  práctica: definirlas **también en *Build variables and secrets*** del trigger, que es lo que hace
  que existan cuando `next build` compila ([OpenNext,
  env vars](https://opennext.js.org/cloudflare/howtos/env-vars#workers-builds)); en runtime quedan de
  adorno para el servidor.
- **`NODE_ENV`.** No es configuración: Next lo sustituye por un literal (`production` en build) y no
  existe como binding.

### Cómo comprobar que la configuración se lee

No queda ninguna sonda en el repo: la que se usó para cerrar este arreglo (`GET /api/debug-env`, que
devolvía nombres y booleanos, nunca valores) se borró al terminar, porque una ruta de diagnóstico no
debe quedarse en producción. Para volver a mirar el entorno del Worker hay que recrearla.

Lo que se miraba, y qué hacer con cada resultado:

| Señal | Qué dice |
|---|---|
| `bindings` trae `DATABASE_URL` | El arreglo funciona. Da igual que no esté en `process.env`: la app lee los bindings. |
| `bindings` vacío o sin las variables | El binding no ha llegado al Worker. Ningún cambio de código lo arregla; es configuración de despliegue (ver más abajo). |
| `bindings` las trae y también están en `process.env` | `populateProcessEnv` funcionó y todo va por el camino antiguo. También es correcto. |

Y una advertencia que costó entender: **`NEXT_PUBLIC_*` no aparecen en ninguna de esas señales, y
no es que falten.** Next las sustituye por literales al compilar, así que nunca viajan como binding
ni a `process.env`. Verlas ausentes en el Worker es lo esperado, no un síntoma.

### Si los bindings no llegan al Worker

Ningún cambio de código lo arregla: es configuración de despliegue. La causa era que el
`wrangler.jsonc` no estaba versionado, así que `@opennextjs/cloudflare` lo generaba en cada build y
`wrangler deploy` reconstruía el Worker solo con lo que traía ese archivo, perdiendo las variables
del panel. Ya está versionado (ver arriba).

La otra causa posible es de las dos listas del panel: un secreto está en *Build variables and secrets*
y no en los secretos del Worker, o al revés. Ver
[Los dos sitios del panel: secretos del Worker y build variables](#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables).

## La base de datos en el Worker: Hyperdrive

En un Worker una conexión TCP solo vive durante la invocación que la abre. Sin nada por medio, cada
petición paga el establecimiento completo de la conexión contra la base de datos (handshake TCP,
negociación TLS y autenticación: 7 viajes de ida y vuelta antes de poder ejecutar la primera
consulta) y la base ve una conexión nueva por petición. **Hyperdrive** es la pieza que Cloudflare
pone delante de la base de datos para resolverlo: hace el establecimiento en el *edge*, junto al
Worker, y mantiene un *pool* de conexiones reales cerca de la base de datos, además de cachear
lecturas. Es la vía documentada y recomendada para Postgres desde un Worker, y la que usan los
ejemplos de Cloudflare con `pg`.

**Crear el Hyperdrive** (Workers & Pages → Hyperdrive → *Create configuration*):

- La cadena que se le da a Hyperdrive es la de la conexión **directa** de Supabase
  (`db.<ref>.supabase.co`, puerto `5432`), **no** la del *Session pooler*: el *pooling* lo pone
  Hyperdrive. Ojo, que esto es justo al revés de lo que se usa en el `.env` local, donde hace falta
  el *Session pooler* porque la directa es solo IPv6.
- Las credenciales pueden ser las del usuario `postgres` del proyecto, pero mejor un rol propio con
  los permisos justos (Cloudflare propone crear en el SQL Editor un `CREATE ROLE hyperdrive_user
  LOGIN PASSWORD '...'` y darle el rol que necesite) en lugar de privilege escalation con el
  superusuario.
- No hace falta `?sslmode=require` en esa cadena: es Hyperdrive quien termina el TLS contra la base
  de datos.
- Al crearlo, Hyperdrive prueba la conexión para verificar las credenciales, así que si falla el
  error es de la cadena o del firewall, no del Worker.

El proyecto ya está en el plan **Free**, que incluye **100.000 consultas al día** a Hyperdrive
(contadas a las 00:00 UTC: cualquier `SELECT`, `INSERT`, `UPDATE`, `DELETE` o cambio de esquema,
cacheada o no). El *pooling* y la caché no se cobran aparte.

**Aviso importante sobre cómo se lee la cadena.** La cadena de conexión de Hyperdrive **no** es una
URL que se pueda copiar y pegar en una variable de entorno: solo existe en tiempo de ejecución, en
`env.HYPERDRIVE.connectionString`, y se obtiene del *binding* Hyperdrive. Por eso **no hay ningún
valor correcto para `DATABASE_URL` en Cloudflare**: la cadena directa de Supabase funciona desde un
Worker (el socket TCP no está bloqueado; solo lo están el puerto 25 y las IPs privadas o de
Cloudflare), pero paga el establecimiento completo en cada petición, y la de Hyperdrive no existe
hasta que hay un binding.

**El cableado ya está hecho, y el binding está activo desde septiembre de 2026.** `src/lib/db.ts`
lee el binding con `readHyperdriveConnectionString()` de
[`src/lib/runtime-env.ts`](../src/lib/runtime-env.ts) y, si no está, cae a `DATABASE_URL` por
`readRuntimeEnv`. No es un apaño: es lo que permite que `next dev` y los scripts de `scripts/`
sigan funcionando sin el binding.

**Por qué se activó.** Con el binding comentado, el Worker resolvía la base por el `DATABASE_URL`
del panel, que apuntaba al *Session pooler* de Supabase. Ahí se le caían las conexiones: el worker
de sync terminaba con `Connection terminated unexpectedly` y `db/pool: Network connection lost`, y
como los errores por jugador solo van a `console.error` (nada los persistía), **el torneo entero se
quedó congelado sin que nada lo dijera** — la clasificación seguía sirviendo los últimos puntos
guardados y ningún jugador nuevo aparecía. Con Hyperdrive el *pool* lo pone Cloudflare contra la
conexión directa y el problema desaparece.

**Lo que exige el deploy.** `opennextjs-cloudflare deploy` llama a `getPlatformProxy()` de wrangler
para leer el entorno, y esa emulación **exige** una cadena de conexión local para cualquier binding
de Hyperdrive. Ojo con el detalle, que es la trampa: el `applyHyperdriveEnvVars` de wrangler lee
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` **exclusivamente de `process.env`**, sin
mirar ningún fichero, así que **tenerla en `.dev.vars` no basta**. El valor se guarda ahí (no se
versiona: lleva la contraseña) y [`scripts/deploy-worker.mjs`](../scripts/deploy-worker.mjs) lo
exporta antes de lanzar el CLI, que es el paso `deploy` de `npm run deploy`. (No vale hacerlo con
`node --import`: `opennextjs-cloudflare` es un *shim* de `node_modules/.bin`, no un módulo, y `node`
lo resuelve con `ERR_MODULE_NOT_FOUND`.) Con Workers Builds ya conectado (ver
[Workers Builds: `main` despliega y las ramas hacen Preview](#workers-builds-main-despliega-y-las-ramas-hacen-preview)),
esa misma variable hay que ponerla en *Build variables and secrets* del trigger, o el build falla al
ver el binding. No es la única: ese sitio del panel tiene su propia lista y no es el mismo que el
de los secretos del Worker. Está en
[Los dos sitios del panel: secretos del Worker y build variables](#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables).

## Los dos sitios del panel: secretos del Worker y build variables

Son **dos listas distintas y no intercambiables**, y confundirlas es lo que hace que una variable
esté puesta y aun así falte:

| Sitio del panel | Quién la lee | Cuándo existe |
|---|---|---|
| **Settings → Variables and Secrets** (secretos y *vars* del Worker) | El **Worker en runtime**: son los *bindings* que llegan en `ctx.env`. | Mientras el Worker esté desplegado. |
| **Build variables and secrets** (de la configuración de build de Workers Builds) | El **proceso de build**: el `next build` y el `npx wrangler deploy` que ejecuta el pipeline. | Solo mientras dura el build de esa configuración. |

El síntoma de tenerla en el sitio equivocado es que **nada avisa hasta que algo la lee**. El build de
Next compila entero y bien, el Worker desplegado arranca, y el fallo aparece en el primer módulo que
la necesita, que puede ser el paso de deploy del pipeline o una petición de una sola página días
después.

Y hay un matiz que solo se ve cuando hay previews: **las build variables no llegan al runtime**, ni
siquiera en un Worker normal, y un Preview tampoco hereda los secretos del Worker. Las dos listas de
arriba son las de producción; un Preview tiene su propio par, en *Previews Base* (ver
[Workers Builds: `main` despliega y las ramas hacen Preview](#workers-builds-main-despliega-y-las-ramas-hacen-preview)).

### Qué tiene que estar en las build variables

- **`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`.** Obligatoria: sin ella, el paso
  `npx wrangler deploy` **aborta**. Es la variable que faltó cuatro pushes seguidos.
- **Las `NEXT_PUBLIC_*`** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_SITE_URL`). Obligatorias: Next las sustituye por un
  literal al compilar y en runtime ningún binding puede llegar al bundle del navegador. La de
  `NEXT_PUBLIC_SITE_URL` es además la que decide de qué dominio salen los canónicos y las tarjetas
  sociales, y vale `https://laligahispana.es`. Sin ella los canónicos caen a `http://localhost:3000`,
  que fue un fallo real en producción: las tarjetas al compartir el link salían rotas. Si algún día
  cambia el dominio, hay que cambiar el valor en **las dos** listas (ver
  [El dominio propio, y por qué no está en el archivo](#el-dominio-propio-y-por-qué-no-está-en-el-archivo)).
- **Los secretos que lee el código de servidor** (`YOUTUBE_API_KEY`, `CRON_SECRET`,
  `RATE_LIMIT_SALT`, `TURNSTILE_SECRET_KEY`): también están, y deben estarlo. Ojo con el matiz, que
  es lo que distingue este caso de los dos anteriores: hoy sus lecturas son **perezosas** (dentro
  del módulo que las usa, nunca al importar), así que el build no las necesita para pasar. La razón
  de tenerlas no es esa, sino que **el entorno del build no es el entorno del Worker**: en cuanto un
  módulo de servidor lea su configuración al importar, o se añada un paso de build que la lea, el
  fallo es el mismo que el de Hyperdrive y con el mismo mensaje engañoso. En el Worker en runtime lo
  que manda es el binding, y ese lo da el panel del Worker.

Las dos listas se revisaron y quedaron completas el **1 de octubre de 2026**, el mismo día que el
build dejó de fallar. En la de build variables faltaban la de Hyperdrive (la que rompía el
despliegue, cuatro pushes seguidos) y `YOUTUBE_API_KEY`. La de *Previews Base* se creó el **2 de
octubre de 2026** con esa misma lista, porque `npx wrangler preview` emula Hyperdrive igual que
`npx wrangler deploy` y sin esa variable el build de una rama moría en el paso de deploy.

### El mensaje que sale es engañoso

Cuando falta la variable de Hyperdrive, el build de Next **acaba bien**: `OpenNext build complete.`,
`Compiled successfully`, `Generating static pages (19/19)` y TypeScript sin errores. Unos 13
segundos después, ya en el paso `npx wrangler deploy`, muere con esto:

```txt
UserError: When developing locally, you should use a local Postgres connection
string to emulate Hyperdrive functionality. Please setup Postgres locally and
set the value of the 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
variable...
    at applyHyperdriveEnvVars (wrangler-dist/cli.js)
    at getPlatformProxy → getEnvFromPlatformProxy → deployCommand
```

Habla de *developing locally* y de montar un Postgres local, y no hay nada de eso: es una variable
de entorno que falta en CI. Leerlo como un problema de base de datos lleva a mirar el binding, el
firewall y las credenciales, que es donde no está la causa; el mensaje está escrito para el
`wrangler dev` local y en el pipeline describe otra cosa.

Lo caro no es el mensaje, es lo que pasa mientras el build falla: **`main` no despliega y producción
se queda sirviendo la versión anterior**. Pasó dos días así, con el repositorio en `main` y el
Worker en un número de versión anterior, sin que nada en la web lo dijera.

### Las build variables son por configuración de build, y no heredan de nada

Las *build variables and secrets* cuelgan de la **configuración de build**, no del Worker, y hay
**dos**: la del *trigger* de `main` y la de *Previews Base*. De ninguna a la otra se hereda nada, así
que lo que va en una hay que ponerlo también en la otra. Las dos tienen hoy la misma lista, que es la
que necesita el build (ver
[Workers Builds: `main` despliega y las ramas hacen Preview](#workers-builds-main-despliega-y-las-ramas-hacen-preview)).

Y hay una tercera lista que no es ninguna de las dos: **Variables and Secrets** del Worker, que es lo
único que llega a runtime, y de la que los previews no heredan nada. Esa es la que un Preview no
tiene. Las tres están en
[Los dos sitios del panel: secretos del Worker y build variables](#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables).

### Ruido conocido del log: `ERROR Failed to copy node_modules/...`

En el build salen, en rojo:

```txt
ERROR Failed to copy node_modules/{env-paths,grammex,graphmatch,robust-predicates,zeptomatch}
```

Son **ruido**. Los cinco son dependencias transitivas del **CLI de Prisma** (`prisma` →
`@prisma/dev` → `@prisma/studio-core`, `@prisma/streams-local`, `zeptomatch`), todo ello
`devDependencies`: nada de eso entra en el bundle del Worker, que usa el cliente generado en
`src/generated/prisma`, y el build **termina bien**. Salen porque `copyWorkerdPackages` de OpenNext
(`dist/cli/build/utils/workerd.js`) copia los paquetes externos que declaran condición `workerd` y
envuelve cada copia en un `try/catch` que solo registra el error y sigue; no son la causa de nada.

### Qué valor poner en la variable de Hyperdrive

El de la **Session pooler** de Supabase (`*.pooler.supabase.com`, puerto `5432`), que es el mismo
que va en el `.env` local. **No** el de la conexión directa: esa es solo IPv6, y el entorno de
build no llega a ella.

El valor de la **build variable** y el de la **configuración de Hyperdrive** son justo al revés, y
no es un descuido:

| Dónde | Cadena | Por qué |
|---|---|---|
| Configuración de Hyperdrive (runtime) | **directa** (`db.<ref>.supabase.co`) | El *pooling* lo pone Hyperdrive; él sí alcanza la directa |
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` (build) | **Session pooler** | Solo la emulación local de wrangler la mira, y solo llega a IPv4 |

La cadena de la build variable no conecta con nada: la emulación de wrangler solo comprueba que
exista.

## El cliente de Prisma: uno por invocación en el Worker, y uno fuera de él

Lo que obliga a esto no es Hyperdrive: es el runtime. En `workerd` un socket TCP creado con
`connect()` **solo es válido durante la invocación que lo abre**, y al terminar la petición el
runtime lo cierra **sin emitir `error`**. Con el cliente cacheado por proceso, la siguiente
petición sacaba del *pool* ese socket ya muerto, el `write` se perdía y **nada resolvía ni
rechazaba la promesa**: la consulta se quedaba colgada para siempre y Cloudflare mataba la
invocación con el error 1101 ("your Worker's code had hung and would never generate a response").
Era intermitente y afectaba solo a las páginas que leen Postgres (`/`, `/partidas`, `/objetivos`,
las tres con `force-dynamic`).

Lo que hace ahora `src/lib/db.ts`:

- **En el Worker, un cliente por invocación**, en un `WeakMap` indexado por el propio contexto de
  Cloudflare. El *entrypoint* de `@opennextjs/cloudflare` crea un objeto de contexto nuevo en cada
  petición, así que la identidad de la clave es la identidad de la invocación, y el `WeakMap` no
  retiene nada entre peticiones.
- **Fuera del Worker** (`next dev` y los scripts de `scripts/`, que son Node de proceso largo)
  **una sola instancia** guardada en `globalThis`, como antes, para que el hot reload no abra una
  conexión nueva en cada recarga.
- **La distinción no usa `process.env.NODE_ENV`**, porque en el bundle del Worker es un literal
  sustituido al compilar y siempre valdría `"production"`. Usa la existencia del contexto de
  Cloudflare, leído del símbolo global `Symbol.for("__cloudflare-context__")` — el mismo que
  devuelve `getCloudflareContext()`, pero sin importar `@opennextjs/cloudflare`, que es una
  dependencia de desarrollo con *peer dependencies* sobre `wrangler` y `next`.
- **Las conexiones se cierran al final de la petición** con `after()` de `next/server`, que en el
  Worker aterriza en `ctx.waitUntil`: la invocación sigue viva hasta que `pool.end()` resuelve, así
  que el cierre ocurre con el socket todavía válido. Se descarta `ctx.waitUntil` directamente porque
  su promesa **empieza en el momento de registrarla** y cerraría el *pool* mientras la página
  todavía está consultando; y se descarta un finalizador en `AsyncLocalStorage` porque `db.ts` no
  es la entrada de la petición, así que no hay ningún ámbito que abrir ni que cerrar.
- Los errores de un cliente **ocioso** del *pool* ya no se tragan: se registran con `onPoolError` de
  `PrismaPg`, que es justo la firma de un socket que el runtime ya cerró.

Cuando la base de datos falla (límite de conexiones de Supabase, reinicio, corte de red), las tres
páginas públicas ya **no** devuelven un 500: `getStandings()`, `getLiveMatches()` y
`getObjectives()` devuelven un `PublicRead<T>` con `status: "degraded"` y `data: null`, y el log
lleva una línea con prefijo `[db]` y el motivo. Ver [Qué ve la web cuando la base de datos no
responde](./OPERACION.md#cuando-la-base-de-datos-no-responde).

## El dominio propio, y por qué no está en el archivo

`laligahispana.es` es **la URL pública del torneo**, y está en producción **como Custom Domain** del
Worker sin estar declarado en [`wrangler.jsonc`](../wrangler.jsonc). Lo primero se comprobó el 4 de
octubre de 2026; lo segundo es una decisión.

### Qué hay montado

| Qué | Estado |
|---|---|
| Zona `laligahispana.es` | **`active`** desde el 4 de octubre de 2026, 22:12 UTC, sin `activation_failure_reason` |
| Custom Domain `laligahispana.es` → Worker `ligahispana-aoe4` | Creado y `enabled`. Lo creó el alta del dominio, que dejó el `AAAA 100::` proxied del apex; ese registro es de Cloudflare y sale `read_only` |
| `www.laligahispana.es` | `A 192.0.2.0` proxied, de relleno, más una regla *Single Redirect* al apex con 301. La redirección se resuelve en el edge, así que la IP de relleno nunca recibe una petición: es una dirección de documentación (RFC 5737) y no hace falta un origen real detrás |
| Ajustes de zona | `min_tls_version` de 1.0 a 1.2, y `always_use_https` activado |
| Certificados | Universal SSL emitido y `active`, Let's Encrypt, `CN=laligahispana.es` más `*.laligahispana.es`. Vence el **2 de enero de 2027** y Let's Encrypt lo renueva solo: no hay que hacer nada |
| `NEXT_PUBLIC_SITE_URL` | `https://laligahispana.es` en las **dos** configuraciones de build |
| Correo | **Sin MX**, y a propósito: se borraron los registros de correo que traía IONOS (`mx00`, `mx01`, el SPF, `autodiscover`, `_dmarc`, `_domainconnect`) después de confirmar con la organización que no hay ningún buzón con ese dominio. Si algún día se quiere correo, hay que configurarlo desde cero |

Comprobado sobre el dominio real: `https://laligahispana.es` contesta 200, y también `/partidas` y
`/objetivos`; `http://` responde 301 a https; `https://www.` responde 301 al apex.

### El apex no tiene registro `A`, y no lo necesita

El único registro del apex es el `AAAA 100::` proxied que creó el Custom Domain. **No hay ningún `A`,
y no hay que añadirlo**: Cloudflare sintetiza las direcciones de las dos familias a partir de ese
`100::`, así que un visitante que solo tenga IPv4 resuelve igual y llega al edge. Se comprobó en
`atlas-center.com`, que tiene la configuración idéntica: no registra ningún `A` para su apex y resuelve
en IPv4 y en IPv6.

`100::` es el *discard prefix* IPv6 (RFC 6666) y `192.0.2.0` el rango de documentación (RFC 5737):
direcciones que no corresponden a ningún servidor. Como el registro está proxied, Cloudflare intercepta
la petición en el edge y nunca sale hacia ellas.

Y no se puede añadir el `A` a mano: Workers responde `81062 A DNS record managed by Workers already
exists on that host`. No es un error que haya que arreglar.

### Por qué no está en `wrangler.jsonc`

Lo tentador es declarar la ruta, que es la forma documentada de tener un Custom Domain:

```jsonc
"routes": [{ "pattern": "laligahispana.es", "custom_domain": true }]
```

Mientras la zona estuvo `pending` el motivo era claro: `wrangler deploy` corre solo en cada push a
`main` y, con `routes` declarados, habría intentado recrear el Custom Domain sobre una zona sin
activar, con riesgo de abortar el build y dejar `main` sin publicar. **Ese motivo ya no aplica**, porque
la zona está activa. La decisión sí se mantiene, pero por otra razón:

- **Declararlo no aporta nada.** El Custom Domain ya existe en el panel, los Custom Domains son un
  objeto **distinto** de `routes` (cuelgan del Worker, no son una ruta que `wrangler deploy` reconstruya
  desde el archivo) y `wrangler deploy` no los borra ni los puede borrar por no estar declarados. Ese
  fue el motivo por el que el del panel sobrevivió a todos los despliegues.
- **Mantiene el despliegue con menos superficie.** Cada paso que puede abortar un build es un paso que
  puede dejar `main` sin publicar sin que nada en la web lo diga
  ([El mensaje que sale es engañoso](#el-mensaje-que-sale-es-enganoso)).

Si algún día se declara, hay que mirar dos cosas antes: que `routes` **no** sustituye a los Previews
(que viven en su propio `previews` block), y que un despliegue con la lista de `routes` declarada
puede dejar de publicar si esa llamada falla, así que conviene hacerlo en un push vigilado.

### Cambiar los nameservers, y por qué tardó horas

El dominio se añadió a la cuenta el 4 de octubre de 2026. **El cambio de nameservers lo hizo la
organización en el registrador** (IONOS), no desde el repositorio: los cuatro de IONOS
(`ns1039.ui-dns.de`, `ns1101.ui-dns.biz`, `ns1117.ui-dns.org`, `ns1126.ui-dns.com`) por
`lara.ns.cloudflare.com` y `odin.ns.cloudflare.com`.

 Tardó **horas** en reflejarse, y el motivo importa para la próxima vez: el registro `.es` tiene TTL
86400 (un día). Durante el camino intermedio los nameservers de IONOS ya devolvían los de Cloudflare
pero el TLD seguía delegando en los antiguos, así que Cloudflare no activaba la zona.

**Para comprobar si un dominio delega donde crees, `dig +trace` es lo único fiable.** Los resolvers
normales (1.1.1.1, 8.8.8.8) contestan desde su caché y dan la impresión contraria: durante horas dijeron
`lara`/`odin` cuando el registro `.es` aún tenía los cuatro de IONOS, y luego al revés. Sin
`+trace` es fácil dar por hecho que el cambio está publicado cuando no lo está.

### Si un visitante no puede entrar: la caché DNS

Un buen número de visitantes llegaron con el dominio cacheado de antes del cambio, y siguen
resolviéndolo a `217.160.0.224`, la IP de IONOS. Allí el TLS falla con `internal error (592)`, así que el
navegador no abre la web. **El sitio está bien**: contra las IPs de Cloudflare contesta 200.

No hay nada que arreglar en el servidor:

- Se resuelve **solo**, cuando caduque la caché del visitante (unas horas).
- **No afecta a quien entra por primera vez**: ese ve el certificado válido directamente.
- Para forzarlo: `ipconfig /flushdns` en Windows, `sudo dscacheutil -flushcache; sudo killall -HUP
  mDNSResponder` en macOS, o `chrome://net-internals/#dns` → *Clear host cache* en Chrome. Y cambiar de
  red (datos móviles en vez de wifi) suele bastar.

Lo único que evita el transtorno es no volver a difundir la URL antigua de `workers.dev`: desde que el
dominio está activo, la que se comparte es `https://laligahispana.es`.

### Lo que se hizo, y en qué orden

Los tres pasos dependían de que el dominio ya resolviera, y cada uno se rompe de una forma distinta,
así que el orden era el que hacía que un fallo se viera. Está **hecho**:

1. **`NEXT_PUBLIC_SITE_URL` = `https://laligahispana.es`** en *Build variables and secrets*, en las
   **dos** configuraciones de build: la del *trigger* de `main` y la de *Previews Base*. Va como *build
   variable* y no como secreto del Worker porque Next la sustituye por un literal al compilar, y en
   runtime ningún binding puede llegar al bundle del navegador (ver
   [Los dos sitios del panel](#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables)).
   Fue lo primero porque **solo afecta a los metadatos**: si el dominio fallara, las tarjetas saldrían
   mal y no se caería nada.
2. **El reloj del torneo**: `SITE_URL=https://laligahispana.es npm run db:cron`. Fue lo segundo, y no
   por capricho: `pg_net` no espera la respuesta, así que apuntarlo antes habría devuelto `200` igual y
   el único síntoma habría sido "pasada vieja" en `/admin` veinte minutos después. El fondo está en
   [`docs/OPERACION.md`](./OPERACION.md#el-reloj-del-torneo-y-el-cambio-de-domino).
3. **`routes` en `wrangler.jsonc`**, opcional, sin hacer (ver [Por qué no está en
   `wrangler.jsonc`](#por-qué-no-está-en-wranglerjsonc)).

El orden era **build variable primero, reloj después**, y no al revés: los metadatos no rompen nada si
fallan, el reloj sí. Los dos primeros se pueden deshacer igual de fácil.

## Publicar

```bash
npm run deploy     # opennextjs-cloudflare build y luego deploy --keep-vars
npm run preview    # build + preview local del Worker
```

Este camino es el de **una máquina con el repositorio**. En producción despliega el *trigger* de
Workers Builds (ver
[Workers Builds: `main` despliega y las ramas hacen Preview](#workers-builds-main-despliega-y-las-ramas-hacen-preview)),
y ahí el envoltorio no se ejecuta: es el *pipeline* el que pone la variable de Hyperdrive, desde
*Build variables and secrets*. El detalle de las dos listas del panel está en
[Los dos sitios del panel: secretos del Worker y build variables](#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables).

- `npm run deploy` es un envoltorio, no el CLI a pelo: `scripts/deploy-worker.mjs` exporta
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` desde `.dev.vars` y lanza el punto de
  entrada real de `@opennextjs/cloudflare` con `--keep-vars`.
- **`--keep-vars`** es lo que OpenNext recomienda para que un despliegue no borre las variables y
  secretos que están en el panel del Worker (Settings → Variables and Secrets). `DATABASE_URL` en el
  panel es el respaldo para cuando no hay binding de Hyperdrive.
- El resto de variables (`NEXT_PUBLIC_SUPABASE_*`, `TURNSTILE_SECRET_KEY`, `CRON_SECRET`,
  `RATE_LIMIT_SALT`, `YOUTUBE_API_KEY`, …) se define en el panel del Worker, y la lista completa está
  en el [README](../README.md#configuración). Las que el **build** puede necesitar van **además** en
  *Build variables and secrets* del trigger: las `NEXT_PUBLIC_*` porque Next las compila dentro del
  bundle, y los secretos que lee el código de servidor porque el entorno del build no es el del
  Worker.

Lo que hay que hacer en la base de datos antes o después de esto, en
[`docs/OPERACION.md`](./OPERACION.md#requisitos-operativos-de-un-despliegue).

## Workers Builds: `main` despliega y las ramas hacen Preview

El repositorio está conectado a **Workers Builds**, así que el despliegue es automático. Pero Workers
Builds no repite el mismo despliegue en todas las ramas: en la rama de producción (`main`) ejecuta
`npx opennextjs-cloudflare build` y a continuación `npx wrangler deploy`, y en **cualquier otra**
ejecuta `npx opennextjs-cloudflare build` y `npx wrangler preview`, que crea un *Preview*: un
entorno aislado del mismo Worker, con URL propia
(`<rama>-ligahispana-aoe4.javierr-ma93.workers.dev`, con `X-Robots-Tag: noindex`), con sus propios
logs y sus propios bindings.

De ahí sale el modelo completo, y no hace falta configurar nada más: **todo push a una rama que no sea
`main` reconstruye el Preview de esa rama**, así que un push nuevo dentro de una pull request
actualiza la URL que ya se estaba mirando, y un merge actualiza el Preview de la rama destino (o
despliega a producción si el destino es `main`). El nombre del Preview lo pone el nombre de la rama,
así que hay uno por rama y se acumulan: el límite es de 100 Previews por Worker en plan Free (y 100
despliegues por Preview), y Cloudflare va borrando los más antiguos cuando se llega.

### Los dos comandos, y por qué el build es el mismo

Un Preview no es un despliegue: es el mismo Worker en otro sitio. Lo que cambia es el paso de deploy,
`npx wrangler preview` en vez de `npx wrangler deploy`. El **build command tiene que ser el mismo que
en producción**, `npx opennextjs-cloudflare build`, porque `wrangler preview` sube `.open-next/worker.js`
y ese fichero solo lo genera OpenNext.

Ahí estuvo el error que hizo que los previews estuvieran **desactivados** entre el 28 y el 2 de octubre
de 2026: la configuración de previews traía `build_command: npm run build`, que es solo `next build`,
así que el `wrangler preview` que venía detrás moría en todas las pull requests con:

```txt
✘ [ERROR] The entry-point file at ".open-next/worker.js" was not found.
```

El mensaje apunta al síntoma y no a la causa: el build de Next acababa bien (`Compiled successfully`) y
que faltaba era el bundle de OpenNext. Arreglado, el 2 de octubre de 2026: `previews_enabled: true` y
`previews_base_config.build_command` con el comando de OpenNext.

### Las build variables de los previews, y lo que **no** llega a runtime

Workers Builds tiene **dos configuraciones de build** con listas propias, y no heredan nada entre
ellas: la del *trigger* de `main` y la de *Previews Base*. Las dos tienen hoy la misma lista, la que
necesita el build:

| Variable | Por qué la necesita el build |
|---|---|
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | `wrangler preview` emula Hyperdrive igual que `deploy`, y sin ella el build muere al ver el binding |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Next las sustituye por un literal al compilar, y en runtime ningún binding puede llegar al bundle del navegador |
| `NEXT_PUBLIC_SITE_URL` | Lo mismo, y además es lo que hace que un Preview anuncie el dominio de producción y no el suyo: es el mismo valor que en la del *trigger* de `main`, y por eso tiene que ir en las dos listas. Ver [El dominio propio](#el-dominio-propio-y-por-qué-no-está-en-el-archivo) |
| `CRON_SECRET`, `DATABASE_URL`, `RATE_LIMIT_SALT`, `TURNSTILE_SECRET_KEY`, `YOUTUBE_API_KEY` | No las necesita el build: están por si algún día un módulo de servidor las lee al importar. Ver [Los dos sitios del panel](#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables) |

**Las build variables no están en runtime**, solo en el proceso de build (eso dice la documentación de
Cloudflare, sin excepciones). Lo que un Preview tiene en runtime sale de su *Preview settings*, que en
el panel es **Workers → Previews → Base configuration → Variables and Secrets**, y está **vacío**. La
consecuencia es que un Preview funciona, pero sin dos cosas:

- **Sin `YOUTUBE_API_KEY`** no se comprueba el directo de YouTube: los canales salen como no
  estar en directo. Es la única degradación visible.
- **Sin `TURNSTILE_SECRET_KEY`** el captcha se desactiva solo, y **sin `CRON_SECRET`** (o
  `RATE_LIMIT_SALT`) el [`/api/cron/sync`](../src/app/api/cron/sync/route.ts) nunca se autoriza. Lo
  segundo es lo que conviene: un Preview no puede disparar el sync.

Las `NEXT_PUBLIC_*` sí llegan al navegador de un Preview, porque Next las compila dentro del bundle en
el build. Por eso **quien se autentique en un Preview escribe en la base de producción**: es el punto
que hay que tener presente al revisar una pull request en su URL.

### Lo que resuelve el bloque `previews` del [`wrangler.jsonc`](../wrangler.jsonc)

Es **obligatorio** para `npx wrangler preview`, y desde `wrangler` 4.135 es un error, no un aviso:

```txt
✘ [ERROR] Your Wrangler configuration is missing a `previews` block. Add the following to your configuration file:
```

El bloque apareció en `wrangler` 4.135 y el proyecto ya va por 4.143, así que salta sin avisar. En
local el prompt que wrangler ofrece para escribirlo (con los valores propuestos marcados como
`<REPLACE_ME>`) sí sirve; lo que no salva es depender de él desde un proceso no interactivo como el de
un build.

Y resuelve tres cosas:

- **Los bindings no se heredan del nivel superior.** Hay que declararlos dentro: `HYPERDRIVE` e
  `IMAGES`. Sin `HYPERDRIVE` el build pasa, pero el Preview sale entero en
  [modo degradado](../README.md#qué-ve-la-web-cuando-la-base-de-datos-no-responde), que en un sitio
  cuyas páginas leen de Postgres no sirve para mirar nada.
- **`assets`, `compatibility_*` y las migraciones se quedan arriba**, y los Cron Triggers **no se
  replican**: apuntan a producción, así que un Preview no puede disparar el sync.
- **Los secretos tampoco se heredan** (y no se pueden escribir en el fichero, que está versionado):
  van en *Preview settings*, como se ha visto arriba.

**Que el `HYPERDRIVE` del bloque `previews` apunte a la base de producción es una decisión, no un
descuido.** Es lo que hace que un Preview sirva para mirar la interfaz de verdad (streams,
clasificaciones): sin base no hay nada que ver. El riesgo está acotado, porque un Preview no dispara
los Cron Triggers y las rutas de sincronización piden `CRON_SECRET`, que un Preview no tiene, así que
ni siquiera llegan a autenticarse. Lo que sí conviene tener presente es que `WORKER_SELF_REFERENCE`
sigue llamando al **despliegue de producción**, y que quien se autentique en el Preview escribe en la
base de producción. Para aislarlo del todo: crear otro config de Hyperdrive sobre una base de pruebas
y cambiar el `id` de `previews.hyperdrive` (en plan Free no se cobra por config; el límite son las
mismas 100.000 consultas al día).

### Qué sigue haciendo GitHub Actions

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) sigue ahí, y no es un paso que
Workers Builds sustituya: un Preview **despliega**, y eso tarda bastante más que `npm ci && npm run
lint`. El workflow da el veredicto en un par de minutos y sin gastar un despliegue, y el Preview da
la URL. Los dos se disparan en el mismo push, y en un repositorio público ninguno de los dos cobra
minutos.

### Lo que hay que hacer en el panel

Solo si se quiere un Preview con la misma paridad que producción: **Workers → Previews → Base
configuration → Variables and Secrets**, y ahí `YOUTUBE_API_KEY` (el directo de YouTube),
`RATE_LIMIT_SALT` y `TURNSTILE_SECRET_KEY`. Se pueden poner a mano en el panel o con
`npx wrangler preview base-config secret put <NOMBRE>`, que las deja en la configuración base y las
copia a cada Preview nuevo. `CRON_SECRET` no está en la lista a propósito: autorizar el sync en un
Preview no aporta nada y quita una barrera.
