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
| `RATE_LIMIT_MAX_ATTEMPTS` | Envíos de inscripción permitidos por IP y ventana (5) |
| `RATE_LIMIT_WINDOW_SECONDS` | Longitud de la ventana del límite, en segundos (3600) |
| `RATE_LIMIT_STALE_SECONDS` | Antigüedad a partir de la cual se purga una fila de contador, en segundos (86400) |
| `RATE_LIMIT_SALT` | Secreto del HMAC-SHA-256 con el que se hashea la IP. Sin él se usa `CRON_SECRET`, y si tampoco hay, una sal fija en el código |
| `REGISTRATION_PROFILE_TIMEOUT_MS` | Presupuesto de la comprobación del perfil al inscribirse, en ms (8000) |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Site key pública de Cloudflare Turnstile, la que monta el widget de `/participar`. Sin ella no se pinta el captcha |
| `TURNSTILE_SECRET_KEY` | Secret key de Cloudflare Turnstile (solo servidor). **Si no está definida el captcha queda desactivado**: el formulario sigue funcionando sin comprobación. En producción hay que definirla |
| `TURNSTILE_TIMEOUT_MS` | Presupuesto de la llamada a `siteverify`, en ms (5000) |

## Despliegue en Cloudflare Workers

El despliegue es un **Worker** construido con **OpenNext** (`@opennextjs/cloudflare`): `next build` produce `.next/`, OpenNext lo convierte en `.open-next/` y de ahí sale el Worker. La configuración la genera Cloudflare, así que **el repo no tiene `wrangler.jsonc` ni `open-next.config.ts` y no hay que añadirlos**: ambos los crea `@opennextjs/cloudflare` durante el build si no existen. El `wrangler.jsonc` que genera trae `main: ".open-next/worker.js"`, `assets.directory`, el *service binding* `WORKER_SELF_REFERENCE`, el binding `IMAGES` y los *compatibility flags*; escribir uno a mano sin esos campos no "simplifica" nada, cambia cómo Cloudflare detecta y construye el proyecto y rompe el despliegue.

### `pg-cloudflare` es dependencia de producción explícita

`pg` comprueba en runtime si está dentro de un Worker y, si lo está, usa un socket de TCP (`cloudflare:sockets`) en lugar de `net`/`tls` de Node. Para hacerlo hace un `require('pg-cloudflare')` **estático** en `pg/lib/stream.js`, dentro de la rama de Cloudflare: el empaquetador tiene que resolver ese módulo aunque en local la rama no se ejecute nunca. `pg` lo declara como `optionalDependency`, y una dependencia opcional no es una garantía para el empaquetado. El build de Cloudflare falló exactamente por eso:

```
.open-next/server-functions/default/node_modules/pg/lib/stream.js:41:41: ERROR: Could not resolve "pg-cloudflare"
```

Por eso `pg-cloudflare` está en `dependencies` de `package.json` y no solo colgada de `pg`. Es el mismo patrón que siguen las librerías con código específico de `workerd`: el paquete publica un *conditional export* bajo la condición `workerd` y un fichero **vacío** en el resto de condiciones, así que si el empaquetador no aplica esa condición el bundle compila sin quejarse pero el socket llega `undefined` en runtime. `wrangler` sí la aplica, y conviene comprobarlo en el bundle si alguna vez se ve un `CloudflareSocket is not a constructor`.

### La base de datos en el Worker: Hyperdrive

En un Worker una conexión TCP solo vive durante la invocación que la abre. Sin nada por medio, cada petición paga el establecimiento completo de la conexión contra la base de datos (handshake TCP, negociación TLS y autenticación: 7 viajes de ida y vuelta antes de poder ejecutar la primera consulta) y la base ve una conexión nueva por petición. **Hyperdrive** es la pieza que Cloudflare pone delante de la base de datos para resolverlo: hace el establecimiento en el edge, junto al Worker, y mantiene un *pool* de conexiones reales cerca de la base de datos, además de cachear lecturas. Es la vía documentada y recomendada para Postgres desde un Worker, y la que usan los ejemplos de Cloudflare con `pg`.

**Crear el Hyperdrive** (Workers & Pages → Hyperdrive → *Create configuration*):

- La cadena que se le da a Hyperdrive es la de la conexión **directa** de Supabase (`db.<ref>.supabase.co`, puerto `5432`), **no** la del *Session pooler*: el *pooling* lo pone Hyperdrive. Ojo, que esto es justo al revés de lo que se usa en el `.env` local, donde hace falta el *Session pooler* porque la directa es solo IPv6.
- Las credenciales pueden ser las del usuario `postgres` del proyecto, pero mejor un rol propio con los permisos justos (Cloudflare propone crear en el SQL Editor un `CREATE ROLE hyperdrive_user LOGIN PASSWORD '...'` y darle el rol que necesite) en lugar de privilege escalation con el superusuario.
- No hace falta `?sslmode=require` en esa cadena: es Hyperdrive quien termina el TLS contra la base de datos.
- Al crearlo, Hyperdrive prueba la conexión para verificar las credenciales, así que si falla el error es de la cadena o del firewall, no del Worker.

El proyecto ya está en el plan **Free**, que incluye **100.000 consultas al día** a Hyperdrive (contadas a las 00:00 UTC: cualquier `SELECT`, `INSERT`, `UPDATE`, `DELETE` o cambio de esquema, cacheada o no). El *pooling* y la caché no se cobran aparte.

**Aviso importante sobre cómo se lee la cadena.** La cadena de conexión de Hyperdrive **no** es una URL que se pueda copiar y pegar en una variable de entorno: solo existe en tiempo de ejecución, en `env.HYPERDRIVE.connectionString`, y se obtiene del *binding* Hyperdrive. Por eso **no hay ningún valor correcto para `DATABASE_URL` en Cloudflare**: la cadena directa de Supabase funciona desde un Worker (el socket TCP no está bloqueado; solo lo están el puerto 25 y las IPs privadas o de Cloudflare), pero paga el establecimiento completo en cada petición, y la de Hyperdrive no existe hasta que hay un binding. `src/lib/db.ts` sigue leyendo `process.env.DATABASE_URL` y **aún no está cableado** para leer el binding: ese es el paso que queda pendiente, y no se puede resolver solo desde el panel.

El resto de variables (`NEXT_PUBLIC_SUPABASE_*`, `TURNSTILE_SECRET_KEY`, `CRON_SECRET`, …) se define en el panel del Worker (Settings → Variables and Secrets), o como *build variables and secrets* si el build las necesita. OpenNext recomienda desplegar con `--keep-vars` para que un despliegue no borre las variables que están en el panel.

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

Hay un único punto de entrada, `POST /api/cron/sync` (y `GET`, porque Vercel Cron solo emite `GET`). Acepta dos formas de autenticación:

- sesión de un admin de Supabase (misma protección que el resto de `/admin`), o
- `Authorization: Bearer $CRON_SECRET` (imprescindible para un cron externo, que no manda cookies).

```bash
# Desde la terminal, sin levantar el servidor
npm run sync
npm run sync -- 4635035 8139502     # solo esos profileId

# Como route handler (mismo trabajo)
curl -X POST http://localhost:3000/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"
```

Devuelve un resumen en JSON con el detalle por jugador (partidas vistas, nuevas, actualizadas, descartadas, resueltas por refetch y abandonadas) y los contadores de la API (peticiones, reintentos, pausas por *rate limit*).

### Cadencia recomendada

**Cada 5 minutos**. La API pide uso responsable y ya ha devuelto 429; por debajo de 3 minutos el worker dispara demasiadas peticiones por minuto solo con un puñado de jugadores. Con más jugadores, sube `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` antes que la frecuencia. Para F4 ("en directo") 5 minutos es suficiente: una partida en directo se detecta en la siguiente pasada y se marca con `finishedAt = null`.

El disparo lo hace un **cron externo** (cron-job.org, EasyCron, o un workflow programado de GitHub Actions): una petición a `https://<dominio>/api/cron/sync` con `Authorization: Bearer $CRON_SECRET`, cada 5 minutos. El endpoint acepta `GET` y `POST`, así que vale cualquier servicio que sepa mandar una cabecera. El proyecto solo necesita `CRON_SECRET` definido en las variables de entorno del hosting.

El repo trae un workflow listo en [`.github/workflows/cron-sync.yml`](.github/workflows/cron-sync.yml). Para usarlo, define en el repositorio la variable `SITE_URL` y el secreto `CRON_SECRET` (Settings > Secrets and variables > Actions). Aviso: los workflows programados de GitHub pueden retrasarse unos minutos y se desactivan tras 60 días sin actividad del repositorio.

Se evita el cron nativo del hosting a propósito: en Vercel el plan Hobby lo limita a **una vez al día**, y en Cloudflare el plan Free da **10 ms de CPU por disparo**, que no llegan para una pasada del worker. Un cron externo no depende de ninguna de las dos cosas.

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

