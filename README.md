# LigaHispana_AOE4

Web para el seguimiento de la Liga Hispana de Age of Empires IV: torneo individual con la
clasificación calculada a partir de las partidas de los participantes, obtenidas de la API de
[AoE4World](https://aoe4world.com/api). La web publica la clasificación, las partidas en directo, los
streams de los participantes y un panel de administración.

> **Puntuación**: los puntos se suman por **cualquier partida clasificatoria**, no solo por las
> partidas de la ladder *ranked* 1v1. El motor de puntuación (F3) decide qué cuenta como
> clasificatoria; por eso cada partida guarda su `leaderboard` y el JSON crudo de la API, para poder
> filtrar y recalcular sin volver a historicarlo. Las reglas están en
> [`docs/PUNTUACION.md`](docs/PUNTUACION.md).

## Stack

- **Next.js 16** (App Router, `src/app`) + **TypeScript** + **TailwindCSS v4** (tokens en
  `src/app/globals.css`)
- **Prisma 7** (`prisma-client`) + **PostgreSQL** en Supabase; cliente y *driver adapter* en
  `src/lib/db.ts`
- **Supabase Auth** solo para el panel de administración (todo usuario autenticado es admin)
- Despliegue en **Cloudflare Workers** con **OpenNext** (`@opennextjs/cloudflare`); en local, Node

## Puesta en marcha

Requisitos: **Node.js 20+** (probado con 24) y una **base de datos PostgreSQL** (ver [Base de
datos](#base-de-datos)).

```bash
npm install          # instala dependencias + genera el cliente Prisma (postinstall)
cp .env.example .env # crea tu .env local y rellena DATABASE_URL
npm run db:push      # crea las tablas en la base de datos (Supabase)
npm run dev          # arranca en http://localhost:3000
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo. |
| `npm run build` | Build de producción (`next build`). |
| `npm run start` | Sirve el build con `next start`. |
| `npm run lint` | ESLint. |
| `npm run generate` | Regenera el cliente Prisma en `src/generated/prisma`. |
| `npm run postinstall` | Lo que `npm install` ejecuta al final: `prisma generate`. |
| `npm run studio` | Abre Prisma Studio. |
| `npm run migrate` | `prisma migrate dev`. **No se usa**: Supabase no permite *shadow database* (ver `db:push`). |
| `npm run db:push` | Sincroniza el schema con la base de datos. |
| `npm run db:security` | Aplica la postura de RLS sin políticas y sin permisos para los roles de cliente. Con `-- --check` solo comprueba; con `-- --solo-rls` aplica la postura alternativa. |
| `npm run db:cron` | Programa el job de `pg_cron` que dispara el sync cada 5 minutos. Con `-- --check` comprueba, con `-- --remove` lo desprograma. |
| `npm run db:window` | Publica la ventana de fechas del torneo en `Setting["scoring.ruleset"]` sin desplegar. Con `-- --check` no escribe. |
| `npm run countries:seed` | Publica en `Setting` la lista de países que admite el torneo, sembrada desde `paises.txt`. Con `-- --show` la enseña, con `-- --dry-run` no escribe. |
| `npm run sync` | Sincroniza las partidas de AoE4World desde la terminal. Acepta `profileId` sueltos. |
| `npm run score` | Recalcula la clasificación y la imprime (lo que hace el worker al final de cada pasada). |
| `npm run backfill:model` | Rellena `mode` y `civRandomized` de las partidas anteriores. |
| `npm run verify:sync` | Comprobaciones de normalización, DAL, streams y guardado. Con `-- --db` añade las que van contra la base de datos (y borra lo que crea). |
| `npm run verify:alerts` | 53 comprobaciones puras del motor de alertas. **Sin base de datos.** |
| `npm run alerts:check` | Evalúa las alertas de todo el torneo y las imprime. Idempotente. |
| `npm run alerts:cutoffs` | Deriva o refresca los cortes de división que necesita la regla R5. Con `-- --show` enseña los cacheados. |
| `npm run mock:tournament` | Simula el torneo completo contra la API falsa. |
| `npm run mock:clean` | Retira exactamente lo que crea la simulación con fixtures. |
| `npm run simulate:tournament` | Torneo simulado con jugadores **reales** de AoE4World. Con `-- --select-only` solo elige e informa. |
| `npm run simulate:clean` | Deshace esa simulación, comprobando antes cada fila. Con `-- --dry-run` no borra. |
| `npm run brand:assets` | Deriva los recursos de marca de `public/imagenes/logos/` a las rutas donde los espera Next. |
| `npm run preview` | `opennextjs-cloudflare build` + `preview`: levanta el Worker en local. |
| `npm run deploy` | `opennextjs-cloudflare build` + `deploy --keep-vars`. Ver [Despliegue](#despliegue-en-cloudflare-workers). |

## Configuración

Copia `.env.example` a `.env`. Las descripciones son de una línea; los valores por defecto van entre
paréntesis. En producción, en el Worker, hay **dos listas distintas** en el panel: los secretos del
Worker (Settings → Variables and Secrets) y las *Build variables and secrets* del trigger, que son
las que ve el proceso de build. Las dos se llenan, y en la segunda también los secretos que lee el
código de servidor: ver [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md).

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Conexión PostgreSQL para Prisma |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase (auth/API) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable de Supabase (auth/API) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Alternativa antigua a la clave publicable |
| `NEXT_PUBLIC_SITE_URL` | Dominio público del sitio, con protocolo: de él salen los canónicos y las rutas absolutas de las imágenes. Variable de **build**, no de runtime, así que va en *Build variables and secrets*, en las **dos** configuraciones de build (hoy `https://laligahispana.es`) |
| `AOE4WORLD_API_BASE` | Base de la API de AoE4World (`https://aoe4world.com`) |
| `AOE4WORLD_API_KEY` | Opcional, para partidas privadas; viaja en la query y nunca se escribe en los logs |
| `AOE4WORLD_USER_AGENT` | Cómo se identifica el worker ante la API (`LigaHispanaAOE4/0.1 (sync AoE4World)`) |
| `AOE4WORLD_TIMEOUT_MS` | Timeout por petición (15000) |
| `AOE4WORLD_MAX_RETRIES` | Reintentos por petición, además del intento inicial (3) |
| `AOE4WORLD_RETRY_BASE_MS` / `AOE4WORLD_RETRY_MAX_MS` | Base y techo del *backoff* (500 / 15000) |
| `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` | Separación mínima entre peticiones (300) |
| `AOE4WORLD_SYNC_PAGE_SIZE` | Partidas por página en el histórico (50, el máximo real de la API) |
| `AOE4WORLD_SYNC_MAX_PAGES` | Páginas máximas por pasada y jugador (10 → 500 partidas) |
| `AOE4WORLD_SYNC_CONCURRENCY` | Jugadores a la vez (3) |
| `AOE4WORLD_SYNC_DEADLINE_MS` | Plazo global de una pasada (240000) |
| `AOE4WORLD_MOCK` | `1` responde con las fixtures de `src/lib/aoe4world/mock/` en vez de salir a la red (`0`; imposible con `NODE_ENV=production`) |
| `CRON_SECRET` | Secreto para llamar a `POST /api/cron/sync` sin sesión |
| `SITE_URL` | URL pública del Worker de la que parte el job de Supabase Cron. Solo la lee `scripts/db-cron.ts`, y es **otra** distinta de la variable `SITE_URL` del workflow de GitHub |
| `RATE_LIMIT_MAX_ATTEMPTS` | Envíos de inscripción permitidos por IP y ventana (5) |
| `RATE_LIMIT_WINDOW_SECONDS` | Longitud de la ventana del límite, en segundos (3600) |
| `RATE_LIMIT_STALE_SECONDS` | Antigüedad a partir de la cual se purga una fila de contador, en segundos (86400) |
| `RATE_LIMIT_SALT` | Secreto del HMAC-SHA-256 con el que se hashea la IP. Sin él se usa `CRON_SECRET`, y si tampoco hay, una sal fija en el código |
| `REGISTRATION_PROFILE_TIMEOUT_MS` | Presupuesto de la comprobación del perfil al inscribirse, en ms (8000) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Site key pública de Turnstile, la que monta el widget de `/participar`. Sin ella no se pinta el captcha |
| `TURNSTILE_SECRET_KEY` | Secret key de Turnstile (solo servidor). **Si no está definida el captcha queda desactivado** y el formulario sigue funcionando sin comprobación. En producción hay que definirla |
| `TURNSTILE_TIMEOUT_MS` | Presupuesto de la llamada a `siteverify`, en ms (5000) |
| `YOUTUBE_API_KEY` | Clave de la Data API v3 de YouTube. **Opcional**: sin ella no se comprueba si un canal de YouTube está en directo (no sale ninguna petición) y el estado se queda en `false` con un aviso en el rastro de la pasada |
| `STREAMS_TIMEOUT_MS` | Presupuesto por petición a YouTube o Kick, en ms (5000). Corto a propósito: va al final de una pasada que ya ha hecho su trabajo |
| `STREAMS_MIN_REQUEST_INTERVAL_MS` | Separación mínima entre peticiones a esas dos APIs, en ms (200) |
| `STREAMS_MAX_RETRIES` / `STREAMS_RETRY_BASE_MS` / `STREAMS_RETRY_MAX_MS` | Reintentos y *backoff* del módulo de directos (2 / 400 / 8000) |
| `STREAMS_MAX_CHECKS_PER_RUN` | Tope de comprobaciones de directo por pasada (24 = 12 participantes con las dos plataformas) |

## Cómo funciona

```
        Supabase Cron  (pg_cron + pg_net, cada 5 minutos)
                    │  POST /api/sync
                    ▼
            Cloudflare Worker ── syncApprovedPlayers() ──► API de AoE4World
                    │                                       (partidas y ladder)
                    ├──► YouTube / Kick: directos, una vez por pasada
                    ▼
            PostgreSQL (Supabase)
              Setting: cursores, rulesets, umbrales, cachés y rastros
                    │
                    ▼
            DAL (src/lib) ──► web: clasificación · en directo · objetivos · canales
                    ▲
                    └── Panel /admin (Supabase Auth, solo admins)
```

- La **sincronización** descarga las partidas de todos los participantes aprobados, con deduplicación
  por `(playerId, gameId)`, y trae **todas** las ladders. Cada partida guarda su `leaderboard` y el
  JSON crudo de la API, para que el motor de puntuación pueda filtrar y recalcular sin volver a
  historicarlo.
- El **reloj** es un job de `pg_cron` en la propia base de datos que llama por HTTP con `pg_net`. El
  workflow de GitHub queda como red de seguridad. No es un Cron Trigger del Worker: ver [El límite
  de CPU del plan Free](#el-límite-de-cpu-del-plan-free).
- El **motor de puntuación** (`src/lib/scoring.ts`) lee `Match`, aplica el ruleset activo y escribe
  `PlayerScore` y los objetivos cumplidos. **Escribe en `Setting`**: `scoring.ruleset` es la
  configuración de las reglas (puntos por victoria, objetivos, ventana de fechas) y se cambia sin
  desplegar, y `scoring.lastRun` es su rastro.
- El **motor de alertas** (`src/lib/alerts/`) vigila comportamientos anómalos sobre las mismas
  clasificatorias. También usa `Setting` como memoria: `alerts.ruleset` (umbrales), `alerts.divisionCutoffs`
  y `alerts.tournamentClose`.
- La **detección de directos** de YouTube y Kick cuelga del worker, no de la web: va una vez por
  pasada y solo para los participantes aprobados que tengan canal. El `channelId` de YouTube se
  resuelve una vez y se cachea en `Setting`.
- **Supabase Auth** solo protege `/admin`; el resto del sitio es público.
- La web nunca devuelve un 500 por un corte de la base: las lecturas del DAL devuelven un
  discriminante (`PublicRead<T>`) y quien pinta distingue "no hay datos" de "no se ha podido leer".
  Ver [Cuando la base de datos no responde](#cuando-la-base-de-datos-no-responde).

## Base de datos

Se usa **Supabase** (Postgres cloud). La conexión se define en `.env` (`DATABASE_URL`).

> **Importante**: en local usa el *Session pooler* (host `...pooler.supabase.com`, puerto `5432`).
> La conexión *direct* (`db.<ref>.supabase.co`) es solo IPv6 y suele fallar en redes IPv4. En el
> Worker es al revés: la cadena de Hyperdrive es la **directa**, porque el *pooling* lo pone
> Cloudflare.

Tres cosas que hay que tener delante:

- **`prisma db push`, no `prisma migrate`**: con Supabase no se puede usar `migrate dev` (requiere
  una *shadow database*, que Supabase no permite).
- **La base de datos es la de producción y no hay *staging***. Un cambio de datos va con copia de
  seguridad previa y una forma de volver atrás; `pg_dump` no viene con el proyecto (se usó el de
  los binarios de PostgreSQL 17 de EDB, descargados fuera del repo).
- **`db:security` después de cada `db:push` que añada tablas**: `prisma db push` no gestiona RLS ni
  GRANTs, y una tabla nueva nace con los permisos por defecto de Supabase en `public`. Se comprueba
  con `npm run db:security -- --check` (ver [`docs/MODELO-DATOS.md`](docs/MODELO-DATOS.md) §7).

### Las claves de `Setting`

`Setting` no es solo configuración: es también la memoria de los procesos. Estas son las claves que
hay hoy; el detalle de cada una está en [`docs/MODELO-DATOS.md`](docs/MODELO-DATOS.md) §1.4.

| Clave | Qué es |
|---|---|
| `scoring.ruleset` | Reglas de puntuación vivas: puntos por victoria, objetivos, mínimos y ventana de fechas. Se cambia sin desplegar. |
| `alerts.ruleset` | Umbrales de las ocho reglas de alerta (versión 1), configurables sin desplegar. |
| `alerts.divisionCutoffs` | Cortes rating → subdivisión que necesita la regla R5, cacheados con `npm run alerts:cutoffs`. |
| `alerts.tournamentClose` | Marca de que ya se hizo la evaluación completa de cierre, con la ventana usada. |
| `registration.countries` | Lista de países que admite el formulario de inscripción, sembrada desde `paises.txt` con `npm run countries:seed`. |
| `streams.youtube.channel.<handle>` | `channelId` de un canal de YouTube ya resuelto, con su fecha. Evita gastar cuota en cada pasada. |
| `scoring.lastRun` | Rastro del último recálculo, escrito dentro de su transacción. |
| `sync.lastRun` | Rastro de la última pasada del sincronizador: contadores, errores y los jugadores que fallaron. Es lo que enseña el aviso de `/admin`. |
| `simulation.roster` | Manifiesto de a quién dio de alta `simulate:tournament` y con qué identidad. Es lo único que permite deshacerla. |
| `aoe4world.sync.player.<profileId>` | Cursor de sincronización de un jugador: `since`, `maxStartedAt`, `lastSyncedAt`, `historyTruncated` y las partidas abandonadas. |

### Cuando la base de datos no responde

Un corte puntual (límite de conexiones, reinicio, pico de red) no puede ser un 500 con una traza en
el log: la web tiene que seguir contestando y decir que no ha podido leer. Por eso las lecturas del DAL
devuelven `type PublicRead<T> = { status: "ok"; data: T } | { status: "degraded"; data: null }`, y un
`degraded` **nunca** se pinta como lista vacía: un vacío se leería como "no hay participantes", que es
una afirmación falsa. El motivo del fallo no viaja en el objeto (se serializa al navegador dentro del
*payload* de RSC): se queda en el log del servidor con el prefijo `[db]` y el `scope` de la lectura,
saneado para quitar usuario, clave y `password=` y conservar el *host*. Los scripts usan
`unwrapRead()` de `@/lib/db-errors`, que **aborta** en vez de devolver vacío: una comprobación que se
traga un corte de la base y sale con "todo correcto" es peor que no comprobar nada.

## Despliegue en Cloudflare Workers

El Worker se construye con **OpenNext** (`@opennextjs/cloudflare`): `next build` produce `.next/`,
OpenNext lo convierte en `.open-next/` y de ahí sale el Worker. **Producción despliega solo**: el
repositorio está conectado a Workers Builds y el trigger de `main` ejecuta `npx wrangler deploy`.
`npm run deploy` es el camino manual, para una máquina con el repositorio.

- **`wrangler.jsonc` y `open-next.config.ts` están versionados a propósito.** Si no existen, OpenNext
  los genera en cada build y su contenido se pierde en cada despliegue: las variables del panel dejan
  de viajar al Worker, porque `wrangler deploy` reconstruye el Worker solo con lo que trae el archivo.
- `npm run deploy` = `opennextjs-cloudflare build` y luego `deploy --keep-vars`. El envoltorio es
  [`scripts/deploy-worker.mjs`](scripts/deploy-worker.mjs).
- Los **secretos** (`DATABASE_URL`, `CRON_SECRET`, `RATE_LIMIT_SALT`, `TURNSTILE_SECRET_KEY`,
  `YOUTUBE_API_KEY`…) se ponen en el panel del Worker, en **Settings → Variables and Secrets**; **no**
  van en `wrangler.jsonc`. `--keep-vars` es lo que evita que un despliegue los borre.
- **Build variables and secrets** (del *trigger* de Workers Builds) es **otra lista distinta**, y no
  es heredable: ahí es donde vive lo que ve el proceso de build, que es lo único que existe durante
  el `next build` y el `npx wrangler deploy` del pipeline. Tienen que estar **también** las
  `NEXT_PUBLIC_*` (Next las sustituye por literales al compilar y en runtime un binding no puede
  llegar al bundle del navegador), los secretos que lee el código de servidor (`YOUTUBE_API_KEY`,
  `CRON_SECRET`…) y la cadena local de Hyperdrive
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`, que es la que aborta el paso de deploy
  si falta. Hay **dos** configuraciones de build —la del *trigger* de `main` y la de *Previews Base*—,
  no heredan nada entre ellas, y lo que va en una tiene que ir también en la otra. Detalle en
  `docs/DESPLIEGUE.md`, "Los dos sitios del panel".
- **El dominio propio `laligahispana.es` es la URL pública del sitio**, en producción como Custom
  Domain desde que la zona pasó a `active` (4 de octubre de 2026), con certificado de Let's Encrypt
  emitido y `always_use_https` activado: entrar por `http` salta a `https` y `www` salta al apex. **No**
  está declarado en `wrangler.jsonc`, a propósito, porque los Custom Domains son un objeto aparte de
  `routes` y no hace falta declararlos. Estado, certificados y qué hacer si un visitante no entra por
  la caché DNS antigua, en `docs/DESPLIEGUE.md`, "El dominio propio, y por qué no está en el archivo".
- La conexión a la base va por el **binding de Hyperdrive**: `src/lib/db.ts` lee
  `env.HYPERDRIVE.connectionString` y, si no está, cae a `DATABASE_URL`. Ese paso, que no se puede
  saltar, en local lo hace `scripts/deploy-worker.mjs`, que exporta desde `.dev.vars` la cadena local
  antes de lanzar el CLI; en CI lo hace la build variable de arriba.

Todo el desarrollo que hay detrás de esto —`pg-cloudflare` y su rama `workerd`,
`outputFileTracingIncludes`, `runtime = "workerd"`, la lectura de la configuración, Hyperdrive y el
cliente de Prisma por invocación— está en [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md).

## Operación

Lo que hay que hacer y mirar con el proyecto en marcha está en
[`docs/OPERACION.md`](docs/OPERACION.md). Resumen:

### Sincronización

El worker descarga las partidas de todos los participantes aprobados y guarda el rastro de cada
pasada en `Setting["sync.lastRun"]`, que `/admin` enseña como aviso: contadores, errores y los
jugadores que no se pudieron sincronizar con el motivo literal de la API. Hay dos puntos de entrada y
los dos hacen el mismo trabajo: **`POST /api/cron/sync`** (sesión de admin o
`Authorization: Bearer $CRON_SECRET`, devuelve el detalle por jugador) y **`POST /api/sync`** (público,
sin secreto, exige `content-type: application/json` y lleva el candado global de 5 minutos; es donde
dispara el job de `pg_cron`). La llamada manual la hace un admin desde `/admin` con la Server Action
`syncNow`, que comparte ese mismo candado para que el admin y el cron no se pisen. Los tres estados
del rastro —sin rastro, pasada a medias, pasada vieja— se distinguen a propósito, y `lastSuccessAt`
contesta «¿desde cuándo está roto?». Detalle en
[`docs/OPERACION.md`](docs/OPERACION.md#sincronización).

### El límite de CPU del plan Free

En el plan **Free**, Cloudflare da **10 ms de CPU por invocación** y una pasada del sync gasta del
orden de **500 ms**: unas 50 veces el presupuesto. El *isolate* tolera pasarse de forma esporádica,
pero uno consistente lo mata con `Worker exceeded CPU time limit.` (error 1102). Por eso el reloj es
**Supabase Cron** y no un Cron Trigger del Worker: un cron nativo cada 5 minutos se probó y se retiró
(commit `459ed27`). Supabase Cron no cambia el presupuesto, cambia la cuenta: con un disparo HTTP
externo hay una sola invocación por evento, con nada que la comparta. La otra consecuencia es que el
candado de las pasadas a mano es de **5 minutos**, no de uno. Detalle medido en
[`docs/OPERACION.md`](docs/OPERACION.md#el-límite-de-cpu-del-plan-free).

### Alertas de comportamiento

```bash
npm run verify:alerts    # 53 comprobaciones puras, sin base de datos
npm run alerts:check     # evaluación completa + resumen por consola
npm run alerts:cutoffs   # deriva o refresca los cortes de división que necesita R5
```

El motor vigila ocho comportamientos anómalos sobre las partidas clasificatorias ya guardadas y deja
una fila por alerta en `Alert`; los umbrales se tocan en `Setting["alerts.ruleset"]` sin desplegar. Se
evalúa cada 5 minutos con el sync (solo sobre los jugadores tocados en la pasada), al revertir o
restaurar una partida, al cerrar el torneo y a mano. Las ocho reglas, sus umbrales y las decisiones,
con sus costes, están en [`docs/PLAN.md`](docs/PLAN.md#f9--motor-de-alertas-de-comportamiento-).

### Inscripción pública

`/participar` es público y sin autenticación, así que la Server Action `registerPlayer` tiene cinco
capas, en este orden:

1. **Campo trampa** (`website`): no escribe nada y devuelve la misma confirmación que un alta bueno.
2. **Límite de frecuencia por IP**: contado en Postgres con la IP hasheada (HMAC-SHA-256, nunca en
   claro), en una ventana fija. Por defecto, 5 envíos por hora.
3. **Captcha** de Cloudflare Turnstile: **falla cerrado** y se desactiva solo si no hay secret key.
4. **Validadores de los campos**, compartidos con el alta de admin, y comprobación de la fila
   existente: no gasta API. El correo es obligatorio.
5. **Comprobación del perfil** contra `GET /players/:id`, con un presupuesto de 8 s.

El resultado siempre se deja en `PENDING`: aprobar o rechazar es decisión de la organización. Lo único
que se **reescribe** es un envío de un perfil que estaba `REJECTED`, que vuelve a `PENDING` en vez de
crear una segunda solicitud.

### Simulación

`npm run mock:tournament` (y `mock:clean`) levanta un torneo simulado contra las **fixtures** locales
de `src/lib/aoe4world/mock/`, sin salir a la red ni gastar cuota: 10 participantes `APPROVED` con
`profileId` en el rango reservado `90000001`–`90000010`, 127 filas de partida y 10 puntuaciones
distintas. Los parsers, el worker y el motor de puntos son los de verdad, así que la simulación
ejercita el código real. Detalle en
[`docs/OPERACION.md`](docs/OPERACION.md#simulación-con-fixtures-mock-de-aoe4world).

#### Torneo simulado con jugadores reales (API de verdad)

`npm run simulate:tournament` mete en la base de datos **gente real** de la ladder de AoE4World, con
sus partidas reales, para probar la web con datos de verdad sin esperar al torneo real. Elige un
jugador por división con más de 20 partidas de ladder en los últimos 14 días, lo da de alta `APPROVED`,
siembra el cursor de sincronización en el arranque del torneo e importa la ventana; y recalcula. Cuesta
~90 llamadas y ~40 s. Como los jugadores son reales **no hay rango de `profileId` reservado** que
marque sus filas: lo que las marca es el manifiesto `Setting["simulation.roster"]`, y
`npm run simulate:clean` **verifica la identidad de cada fila contra el manifiesto antes de borrar** y
aborta si algo no cuadra. Detalle en
[`docs/OPERACION.md`](docs/OPERACION.md#torneo-simulado-con-jugadores-reales-api-de-verdad).

### Panel de administración

Acceso en `/admin`, protegido con **Supabase Auth** (cookies SSR vía `@supabase/ssr` +
`src/proxy.ts`). Cualquier usuario autenticado es admin, así que **desactiva los registros públicos**
en Supabase (Authentication → Sign In / Providers) y crea las cuentas a mano. Cuatro pestañas:
`/admin` (participantes, contadores y cola de aprobación), `/admin/historial` (partidas
clasificatorias y objetivos cumplidos, con filtro y orden en la URL), `/admin/alertas` (comportamientos
anómalos, con informe CSV) y `/admin/acciones` (bitácora de lo que hizo la organización).
`/admin/jugadores` redirecta a `/admin`.

### Alta de admins por invitación

Las cuentas no se crean desde la web, sino por invitación desde el panel de Supabase. El correo que
manda Supabase no lo consume la web tal cual: por defecto deja la sesión en el **fragmento** de la
URL, que el navegador nunca envía al servidor, así que sin una ruta intermedia la sesión se quedaba
sin usar. La app lo resuelve con dos piezas y **un paso manual en el panel de Supabase**: `GET
/auth/confirm` recibe `token_hash`, `type` y `next`, verifica el token en servidor con
`supabase.auth.verifyOtp()` y guarda la sesión en cookies antes de redirigir (admitiendo invitación y
recuperación, con todo fallo yendo a `/login?error=enlace`); y `/login/establecer-contrasena` deja al
invitado fijar su contraseña con esa sesión. Flujo: invitación → correo → `/auth/confirm` verifica y
crea la sesión → el usuario fija su contraseña → entra a `/admin`. El paso manual: **Site URL** y
**Redirect URLs** en *URL Configuration* (el dominio de producción y `http://localhost:3000`), y la
plantilla **"Invite user"** con el enlace propio en HTML en vez de `{{ .ConfirmationURL }}`:
`<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/login/establecer-contrasena">Aceptar la invitación</a>`.
Sin ese cambio el enlace entra, no verifica nada y la web no abre sesión.

## Documentación del proyecto

| Documento | Qué hay |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | Estado de las fases (F0–F10), arquitectura, roadmap, decisiones de stack y decisiones pendientes. **Léelo antes de tocar nada.** |
| [`docs/PUNTUACION.md`](docs/PUNTUACION.md) | Las reglas de puntuación v2: qué cuenta como clasificatoria, puntos por partida, los 38 objetivos, desempates, calendario y ruleset versionado. |
| [`docs/MODELO-DATOS.md`](docs/MODELO-DATOS.md) | El modelo de datos tabla por tabla, los índices, las consultas calientes, RLS y privilegios, y el orden de aplicación. |
| [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md) | El Worker de Cloudflare: OpenNext, `pg-cloudflare`, Prisma con `runtime = "workerd"`, lectura de la configuración, las dos listas de variables del panel y el build de Workers Builds, Hyperdrive y el cliente de Prisma. |
| [`docs/OPERACION.md`](docs/OPERACION.md) | Lo que hay que hacer y mirar con el proyecto en marcha: sincronización y sus relojes, salud del sincronizador, límite de CPU, inscripción, alertas, simulaciones y requisitos de un despliegue. |

## Agentes y skills

`AGENTS.md` es la guía del **orquestador**: contexto del proyecto y reglas de enrutado. El trabajo se
delega a dos subagentes, cada uno con su propio md y las skills que elige en su paso 0:
`@design-ux` (`.opencode/agent/design-ux.md`, UI y copy) y `@logic-data`
(`.opencode/agent/logic-data.md`, lógica, datos, auth y API de AoE4World). Las skills viven en
`.opencode/skills/` (scope del proyecto, versionadas) y se actualizan con `npx skills update`.
