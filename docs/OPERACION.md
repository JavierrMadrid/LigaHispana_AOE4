# Operación

Lo que hay que hacer y mirar con el proyecto en marcha: quién dispara la sincronización, cómo
comprobar que sigue viva, sus límites y cómo se prueban las simulaciones. El despliegue está en
[`docs/DESPLIEGUE.md`](./DESPLIEGUE.md), el esquema en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md)
y las reglas en [`docs/PUNTUACION.md`](./PUNTUACION.md).

## Entornos

| Entorno | Base de datos | Auth | Quién lo usa |
|---|---|---|---|
| Producción | Proyecto Supabase de producción | Supabase Auth de producción | Worker de `main` y operaciones deliberadas. |
| Desarrollo | Proyecto Supabase de desarrollo | Supabase Auth de desarrollo | `next dev`, scripts locales y todos los Previews. |

- `.env.local` apunta a desarrollo. `npm run db:push`, `db:security`, los seeds y las simulaciones se
  ejecutan contra desarrollo sin tocar producción.
- Producción se opera solo de forma explícita: URL de producción en el comando o desde el panel de
  Supabase. No se hereda del entorno local.
- `npm run db:cron` es **solo de producción**. Con la base de desarrollo y sin `SITE_URL`, programa un
  job que llama a `https://laligahispana.es/api/sync`.
- Los datos de desarrollo son desechables: `npm run mock:tournament` los crea y `npm run mock:clean`
  los borra. No copiar datos personales de producción a desarrollo.
- Los Previews comparten la base de desarrollo. Un Preview antiguo creado antes del cambio de
  Hyperdrive puede seguir apuntando a producción: hay que redesplegarlo o borrarlo.
- El plan Free de Supabase pausa el proyecto de desarrollo tras una semana sin actividad. Si un Preview
  da 500, lo primero es mirar si está pausado y reanudarlo. El workflow `dev-keepalive.yml` hace una
  consulta diaria para evitarlo; necesita el secreto `DEV_DATABASE_URL` en el repositorio.

### Acceso de lectura a producción

- El rol `liga_readonly` sirve para consultas de inspección: solo `SELECT`, con `bypassrls` para leer
  las tablas aunque RLS esté cerrada y `default_transaction_read_only = on`. No tiene `INSERT`,
  `UPDATE`, `DELETE`, `TRUNCATE` ni `CREATE`.
- Su URL vive en `~/.config/ligahispana-aoe4/prod-readonly.env` (permisos 600), fuera del repositorio.
- La URL de **escritura** de producción no se guarda en el entorno de desarrollo ni se usa en los
  scripts diarios. Para un cambio de schema en producción se ejecuta de forma deliberada y manual.

## Sincronización

El worker descarga las partidas de **todos** los participantes aprobados y las guarda con
deduplicación por `(playerId, gameId)`. Trae **todas** las ladders (no solo `rm_solo`): cada partida
guarda su `leaderboard` y el JSON crudo de la API para que el motor pueda filtrar y recalcular sin
volver a pedir el histórico.

Dos puntos de entrada, el mismo trabajo (`syncApprovedPlayers()`):

| Endpoint | Autenticación | Devuelve |
|---|---|---|
| `POST`/`GET` `/api/cron/sync` | Sesión de admin **o** `Authorization: Bearer $CRON_SECRET` | Detalle por jugador y contadores de la API |
| `POST /api/sync` | Público, sin secreto | Solo los contadores |

- `/api/cron/sync` acepta `GET` porque Vercel Cron solo emite `GET`.
- `/api/sync` es el que dispara el cron de Supabase. Exige `content-type: application/json` (lo que
  descarta un POST de formulario ajeno) y un candado **global** de ventana variable (1-3 minutos). Si se pide antes de
  tiempo responde `200` con `{"status":"cooldown"}`; si el candado no se puede comprobar, **no** lanza
  la pasada y responde `503`.

La llamada manual la hace un admin desde `/admin` con la Server Action `syncNow`
(`src/app/admin/actions.ts`), que comparte el mismo candado (`public/manual-sync`, en
`src/lib/manual-sync.ts`) para que el admin y el cron no se pisen. No escribe en `AdminAction`: ya
deja el rastro en `Setting["sync.lastRun"]`.

**Aprobar o dar de alta no lanza una pasada.** Tanto el aprobado de una solicitud (`approvePlayer`)
como el alta de admin (`createPlayer`) **escriben sin lanzar una pasada**: el estado (o el jugador,
en el alta), con su línea en `AdminAction`, y el jugador entra en la clasificación en la siguiente
pasada del cron (1-3 minutos) o con la llamada manual (`syncNow`). Tampoco lanza una pasada el
privado de verificación del alta: se manda **después del commit** de la fila y son dos llamadas de red
(abrir el canal y publicar), no una pasada de sincronización. No es un olvido, es lo que
permite que el botón no se cuelgue: una pasada gasta ~500 ms de CPU y el plan Free de Cloudflare da
10 ms por invocación, así que lanzarla dentro de la petición
del botón mataba el *isolate* con `Worker exceeded CPU time limit` (1102) en cuanto se apilaban dos
clics (ver [El límite de CPU del plan Free](#el-límite-de-cpu-del-plan-free)). En cuanto pase esa
pasada, un `APPROVED` aparece **siempre** en la clasificación: si aún no tiene ninguna partida
clasificatoria, sale con 0 puntos y 0 partidas, con su puesto por el desempate de siempre. Un
`PENDING` o un `REJECTED` no tiene fila y no aparece.

```bash
npm run sync                        # desde la terminal, sin levantar el servidor
npm run sync -- 4635035 8139502     # solo esos profileId
curl -X POST localhost:3000/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"
curl -X POST localhost:3000/api/sync -H "content-type: application/json" -d '{}'
```

**Cadencia: variable entre 1 y 3 minutos.** El reloj de `pg_cron` dispara cada minuto
(`scripts/db-cron.ts`), pero no cada disparo es una pasada: el candado global (`public/manual-sync`)
deja pasar una según `nextSyncIntervalSeconds()` (`src/lib/sync-cadence.ts`), que sale del rastro de
la última pasada. La fórmula coge el mayor de estos frenos y lo acota entre 60 y 180 segundos:

- **15 jugadores por minuto**: `ceil(jugadores / 15) × 60`. Un torneo de 50-60 jugadores ya pide
  3 minutos por sí solo.
- **45 peticiones por minuto**: `ceil(peticiones / 45) × 60`. Es el presupuesto con el que se vieron
  los `429` con ~136 jugadores a 3 minutos.
- **3× la duración de la pasada**: deja margen para que no se apilen dos.
- Si la última pasada comió un `429`, se fuerza el máximo.

El minuto solo sale en torneos pequeños o al arrancar; con 50-60 jugadores la cadencia es de
3 minutos. El plazo de la pasada es la ventana menos 10 s, así que siempre termina o se cancela antes
del siguiente disparo, y lo que quede a medias lo recoge la pasada siguiente. El botón manual
(`syncNow`) comparte candado y ventana, y el cron de GitHub (`/api/cron/sync`) sigue sin candado como
red de seguridad.

Los **300 ms** entre peticiones y el presupuesto de la cadencia son empíricos: AoE4World no publica
un contrato de rate limit ni devuelve cabeceras `X-RateLimit-*`. Se han visto 429 por debajo de 3
minutos con el torneo grande, así que la cadencia no sustituye la medición: si aparecen 429, la
pasada siguiente se va sola a 3 minutos; si aun así aparecen, sube `AOE4WORLD_MIN_REQUEST_INTERVAL_MS`
y habla con AoE4World. La detección de directo tiene su **propio reloj** de 10 minutos
(`STREAMS_MIN_INTERVAL_MINUTES`) para no gastar la cuota de YouTube con el sync más rápido.

### Cursor global y relleno (F2)

El incremental ya no pide el histórico jugador a jugador. El cursor es **global**
(`Setting["sync.gamesCursor"]`, por `updated_at`) y cada pasada hace:

1. **Ladder y reconciliación global**: la ladder sella el perfil; la reconciliación resuelve las
   partidas pendientes.
2. **Masivo**: todos los aprobados en lotes estables de 50, `order=updated_at`, desde el cursor.
3. **Relleno**: hasta `AOE4WORLD_SYNC_BACKFILL_MAX_PLAYERS` jugadores, **primero** los que tienen
   `windowComplete=false` y **detrás** las ventanas completas cuyo último recorrido venció (F2b),
   desde `max(window.from, registeredAt)`, `BULK` páginas cada uno.
4. **Perfil**: solo los que no estén frescos por la ladder o por la caché de 1 h.
5. **Cursor y resto**: scoring (solo si hay algo que recalcular, ver **Salto del recálculo**),
   alertas, historial, Discord y streams.

| Variable | Defecto | Qué limita |
|---|---:|---|
| `AOE4WORLD_SYNC_BULK_MAX_PAGES` | 10 | Páginas por lote del masivo. Se recorta al tope de la API, 19 |
| `AOE4WORLD_SYNC_BACKFILL_MAX_PLAYERS` | 20 | Jugadores que atiende el relleno por pasada |
| `AOE4WORLD_SYNC_BACKFILL_PAGES_PER_PLAYER` | 3 | Páginas por jugador del relleno |
| `AOE4WORLD_SYNC_RECHECK_MAX_AGE_DAYS` | 30 | Días desde el último recorrido completo a partir de los cuales la ventana se vuelve a leer. `0` desactiva la revisión |
| `AOE4WORLD_SYNC_MAX_PAGES` | 10 | Tope **duro** de páginas por jugador: el relleno usa `min(BACKFILL_PAGES_PER_PLAYER, SYNC_MAX_PAGES)` |
| `AOE4WORLD_SYNC_SEED_MAX_AGE_MINUTES` | 360 | Solo la **siembra inicial** del cursor; un cursor vivo no se recupera por esta cota |

**Volumen por pasada**, sin contar summaries ni Discord: cuenta cada `GET` a `/api/v0`.

| Paso | Peticiones |
|---|---|
| Masivo | `ceil(N/50)` lotes; hasta `BULK_MAX_PAGES` páginas por lote |
| Ladder | `ceil(N/50)` lotes |
| Perfil | Solo los ausentes de la ladder o con `profileCheckedAt` caducado (TTL 1 h); 0 en el caso estable |
| Relleno | Hasta `BACKFILL_MAX_PLAYERS × min(BACKFILL_PAGES_PER_PLAYER, SYNC_MAX_PAGES)` mientras haya ventanas pendientes o completas con el sello vencido (F2b) |
| Detalle | 0–2 para reconciliar partidas sin resolver |

Con N=50-60 y todos en la ladder: **2-4 peticiones** (2 lotes de masivo + 2 de ladder) y 0–2 de
detalle; el perfil es 0 y el relleno solo aparece con ventanas pendientes. El presupuesto del masivo
es **por lote** (`BULK_MAX_PAGES`); el del relleno es **por jugador** (`BACKFILL_PAGES_PER_PLAYER`,
limitado por `SYNC_MAX_PAGES`). Si el cursor supera los 30 días, la página viene vacía con
`_important_notice_`; no significa "sin partidas" (ver **Aviso de la API**).

**Cesión y fallos**:

- Un lote **truncado** agota `BULK_MAX_PAGES` con `next_page` no nulo. No bloquea: el cursor avanza,
  el lote cuenta en `gamesBatchesIncomplete` y sus jugadores se encolan. `keepPage` conserva la
  página de quien ya iba a medias; `rewind` vuelve a 1 a quien estaba completo o sin fila.
- Un lote que **falla** (5xx, 429 agotado, red) se apunta en `gamesBatchErrors` con su número y su
  rango de `profileId`, sus jugadores quedan `failed` y el cursor **no avanza**: la ventana se
  reintenta entera en la pasada siguiente.
- Un fallo de **guardado** deja al jugador `failed` y lo encola; no bloquea el cursor.
- Una truncación no rebobina a quien iba por la mitad y el relleno se reanuda por `backfillPage`.

**Revisión de ventanas completas (F2b)**:

- Una ventana que se marca completa no se volvía a mirar nunca, así que una partida que se escapó
  antes del sello (publicada tarde, o que la API no devolvía entonces) se perdía para siempre. F2b
  vuelve a leerla cuando `windowCheckedAt` tiene **30 días** o más, con el mismo since y el mismo
  presupuesto, y desde la **página 1**.
- **Prioridad**: los pendientes van primero (`windowComplete=false`, luego `backfillPage`) y los
  rechecks detrás; el `take` corta, así que un recheck nunca le quita el turno a una ventana a medias.
- `AOE4WORLD_SYNC_RECHECK_MAX_AGE_DAYS=0` desactiva la revisión: solo se atienden pendientes.
- **Coste**: con 60 jugadores son 3 pasadas al mes (20 por pasada), ~70–100 páginas; con 13, una
  pasada al mes.
- Un recheck **truncado** vuelve a la cola normal como pendiente (`windowComplete=false`,
  `backfillPage=nextPage`); uno que **falla** deja el sello como estaba y se reintenta en la pasada
  siguiente.
- **No borra** partidas que AoE4World elimine después: solo recupera las que faltan. La paridad
  manual (`verify:aoe4world -- --all`) sigue siendo la prueba completa.

**Atascos**: `sync.gamesCursor` guarda `bulkIncompleteStreak` (pasadas seguidas con truncación) y
`pendingBestCount`/`pendingBestAt` (el mínimo de `backfillPending` visto y cuándo). El panel deriva
`backfillStalled` al leer: racha ≥ 7 o mínimo con 24 h sin bajar, y `null` si el rastro está viejo o
no hay cursor. Con `backfillPending = 0` nunca hay atasco.

**Aviso de la API**: si `updated_since` tiene 30 días o más, AoE4World devuelve
`filters._important_notice_` y una página vacía. La pasada vuelve a sembrar con `catch-up`, reencola
al roster y escribe el aviso en `apiNotice`. La recuperación por edad de un cursor existente usa esa
misma edad de 30 días, no la cota de 6 h de la semilla.

**Lo que esto no demuestra**: `ladder.ahead` solo compara la **cabeza** de la ladder con la partida
más reciente; no detecta un hueco en medio del historial. La paridad de `verify:aoe4world` es una
**muestra**, no una prueba de exhaustividad.

### Caché de perfil (F3)

El perfil (`GET /players/:profile_id`) solo sirve para refrescar `aoe4WorldName` y `avatarUrl`. Desde
F3 se pide con una caché de **1 h** (`PROFILE_CACHE_TTL_HOURS`), sellada en `Player.profileCheckedAt`.

- **Dos escritores sellan**: la ladder, que ya trae `name` y `avatars.full` en su entrada, y el perfil
  cuando de verdad se pide. La ladder sella antes de `refreshProfiles`, así que un jugador que aparece
  en ella no pasa por `getPlayer` en la primera pasada tras el despliegue.
- **Solo se piden** perfiles ausentes de la ladder o con el sello nulo/caducado. Si la caché está
  fresca, no hay petición y el resultado queda como está.
- **Con N=13**, tras la primera pasada el coste estable baja a **2 peticiones de API** (1 masiva + 1
  ladder) si todos están en la ladder; el perfil es 0. La fórmula general es:
  `ceil(N/50)` de ladder + `ceil(N/50)` de masivo + 0 de perfil si todos están frescos.
- **Si el perfil falla** (404, 5xx, red), el jugador queda `failed` y **no se sella** la columna: se
  reintenta en la siguiente pasada. Un fallo de perfil no borra los contadores de partidas ya
  importadas.
- **Nombre y avatar**: la ladder también puede escribir `aoe4WorldName` y `avatarUrl`; el perfil
  compara antes de escribir y solo los actualiza si cambiaron. La paridad nombre/avatar entre ladder y
  perfil se deja para una comprobación manual, fuera de este bloque.

### Salto del recálculo (F3b)

`recomputeScores()` es la parte más cara de una pasada y, cuando no ha cambiado nada, escribía
exactamente lo mismo. Desde F3b el worker se lo salta y deja `scoringSkipped = true` en el resumen y
en `Setting["sync.lastRun"]`.

**La lista cerrada** (`shouldRecomputeScores()` en `src/lib/aoe4world/sync.ts`) — se recalcula si
cualquiera se cumple:

| Señal | De dónde sale |
|---|---|
| No hay `scoring.lastRun` legible | `readScoringLastRun()` |
| `cacheVersion` distinta de la del código | `SCORING_CACHE_VERSION` |
| `ruleSetVersion` distinta de la del código | `RULESET_VERSION` |
| La pasada anterior falló al recalcular | `scoringError` del rastro anterior |
| Partidas tocadas | `inserted + updated + resolvedByRefetch + abandoned > 0` |
| Summaries rellenados | `summaries.fetched > 0` (cambian APM, edad y aldeanos) |
| Pool de mapas nuevo | `mapPool.status === "updated"` (`por-tierra-y-agua`) |
| Metadatos de jugador cambiados | `ladder.playersChanged + perfiles cambiados` |
| Cambio en el número de aprobados | `playersRanked` de `scoring.lastRun` frente al roster |

- **La primera pasada tras desplegar F3b siempre recalcula**: el rastro anterior no lleva
  `cacheVersion` (o lleva otra) y eso es `true` por la segunda fila de la tabla. Subir
  `SCORING_CACHE_VERSION` es lo que hay que hacer si un cambio del motor añade una dependencia que no
  esté en la tabla.
- **`playersChanged` cuenta solo lo que lee la vista de objetivos**: `aoe4WorldName`, `avatarUrl` y
  `rankLevel`. No cuentan los sellos de caché (`ladderUpdatedAt`, `profileCheckedAt`), que se escriben
  en cada pasada, ni elo, racha, partidas de la ladder o Twitch, que cambian demasiado.
- **El número de aprobados entra en la lista** porque aprobar y rechazar **no** recalculan en su
  propia petición (no cabe en el presupuesto de CPU): antes lo arreglaba la pasada siguiente y, sin
  esta señal, un rechazo dejaría al jugador en la clasificación hasta la siguiente partida.
- **La configuración la recalculan sus escritores**, no el worker: el ruleset (panel y
  `npm run db:window`), los cortes de división (`npm run alerts:cutoffs`), los eventos puntuales y las
  actuaciones que anulan o revierten partidas. El pool de mapas es la excepción y se detecta por
  `mapPool.status === "updated"`.
- **Saltárselo no es un fallo**: `scoring = null`, `scoringError = null` y `scoring.lastRun` no se
  toca. La clasificación publicada sigue siendo la última que se calculó.

**Medición en la preview** (seis pasadas ociosas, 0 partidas nuevas, 2 peticiones de API cada una):
CPU del Worker con mediana **658 ms** (media 727, p95/máx 1.028) y `scoring.durationMs` de 228–589 ms
con mediana ~351 ms. F3b quita esa parte en las pasadas sin novedades; el resto (Prisma, masivo y
ladder) sigue ahí y es lo que hay que medir en la siguiente ronda.

### Progreso de objetivos para el overlay

`recomputeScores()` escribe las dos tablas del progreso **en la misma transacción** que la
clasificación y después de calcular los objetivos, con el mismo cerrojo:

| Tabla | Papel |
|---|---|
| `ObjectiveProgressState` | Estado interno: una fila por jugador, objetivo y edición. Es la memoria con la que la pasada siguiente sabe qué cambió. |
| `ObjectiveProgressEvent` | Feed *append-only*: lo que lee la API del overlay y no se reescribe nunca. |

- **Siembra de la primera pasada de una edición**: `CUMPLIDO` para lo que ya está completo y
  `PROGRESADO` para el avance parcial. No hay `PERDIDO` en la siembra: no había nada que perder.
- **`at`**: el instante del pase, salvo la siembra de un logro con la ventana ya cerrada, que usa
  `window.to` (es cuando el torneo lo dio por cumplido).
- **Solo se escribe lo que difiere**: una pasada sin cambios no toca ninguna de las dos tablas.
- **`PERDIDO` solo se emite en competiciones**: un logro revertido no genera evento.
- **`SCORING_CACHE_VERSION` sube a 2** para forzar ese primer pase tras el despliegue: sin el salto,
  el worker podría saltarse el recálculo y el feed no se sembraría hasta la siguiente partida.
- **La API del overlay lee `ObjectiveProgressEvent`**: polling recomendado de 30 s. El dato cambia al
  ritmo del recálculo (10 min), así que pedir más a menudo no adelanta nada.
- **El feed se escribe en cada recálculo**: los logros y las competiciones aparecen **en vivo**, con
  el retraso del pase (10 min), no solo al cierre de la edición. El contrato publicado está en
  [`API-OVERLAY.md`](./API-OVERLAY.md).
- **Una bajada de progreso** (revertir una partida) actualiza el estado pero no emite evento: el feed
  cuenta avances y `PERDIDO` es solo de competiciones. La siguiente subida vuelve a anotarse.
- **Despliegue**: el esquema necesita `db:push` y, después, `npm run db:security -- --check` (las dos
  tablas ya están en la lista del script).

Hay **dos relojes**, y el primario no es GitHub:

| Reloj | Qué es | Frecuencia real |
|---|---|---|
| **Supabase Cron** (primario) | Job de `pg_cron` que llama por HTTP a `POST /api/sync` con `pg_net` | Cada minuto; el candado deja una pasada cada 1-3 minutos |
| [Workflow de GitHub](../.github/workflows/cron-sync.yml) (red de seguridad) | `POST /api/cron/sync` con `Bearer $CRON_SECRET` | GitHub lo retrasa a una cada 4-6 h |

## El reloj: Supabase Cron

```bash
npm run db:cron              # aplica extensiones + job de 10 min (idempotente)
npm run db:cron -- --check   # comprueba y no escribe; sale con 1 si no cuadra
npm run db:cron -- --remove  # desprograma el job
```

[`scripts/db-cron.ts`](../scripts/db-cron.ts), con SQL crudo sobre `DATABASE_URL`, como
`db-security`. Existe porque **`prisma db push` no gestiona ni las extensiones ni `cron.job`**: un
job hecho a mano en el panel de Supabase no quedaría en el repositorio. Aplica:

```sql
create schema if not exists extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'ligahispana-sync',
  '* * * * *',
  $$select net.http_post(
       url := 'https://laligahispana.es/api/sync',
       body := '{}'::jsonb,
       headers := '{"Content-Type": "application/json"}'::jsonb,
       timeout_milliseconds := 240000
     );$$
);
```

Cuatro decisiones que no son obvias:

- **Apunta a `/api/sync` (público), no a `/api/cron/sync`.** `cron.job.command` es texto plano y
  `cron.job_run_details` guarda una copia de cada ejecución, así que un secreto allí quedaría escrito
  en la base. El endpoint público no es una puerta abierta: lo cierran el `content-type` y el candado
  global, **compartido con la llamada manual de admin**. Con el reloj cada minuto y la ventana
  adaptativa, el cron solo pierde la vuelta si una pasada manual cae dentro de la ventana; en el día a
  día la cadencia es la que marca `sync-cadence.ts` (1-3 minutos).
- **El nombre del job es fijo** (`ligahispana-sync`): `cron.schedule(nombre, …)` hace *upsert* sobre
  `jobname_username_uniq`, así que repetir el script actualiza en vez de crear un segundo job.
- **`timeout_milliseconds` a 240 s**: el valor por defecto de `net.http_post` son 2-5 s y una pasada
  tarda ~15 s; con el defecto se cortaría antes de terminar.
- **`pg_net` en el esquema `extensions`**, no en `public`: es donde lo pone Supabase y evita el aviso
  del Security Advisor.

### Cambio de dominio

El job apunta a `https://laligahispana.es/api/sync` (valor por defecto de `scripts/db-cron.ts`).
`SITE_URL` sale del entorno y, si no está, se usa ese valor. Para apuntarlo a otro dominio, con la
zona ya activa y `curl -I` contestando:

```bash
set -a && . ./.env.local && set +a
SITE_URL=https://laligahispana.es npm run db:cron
SITE_URL=https://laligahispana.es npm run db:cron -- --check
```

- Es un *upsert*: reprograma el job, no crea otro.
- **Pasa `SITE_URL` también al `--check`**: compara el comando guardado con el que genera el
  `SITE_URL` del entorno y, si no se lo pasas, avisa aunque el job sea correcto.
- **Exporta antes las variables** (`. ./.env.local`): los scripts arrancan con `dotenv/config`, que
  lee `.env`, y en este equipo los valores están en `.env.local`.
- Hay **dos** `SITE_URL`: el del script (arriba) y la *variable* del repositorio para el workflow de
  GitHub. Este segundo **sigue apuntando a `workers.dev` a propósito**: es la red de seguridad y
  conviene que no dependa de la zona del dominio.

**Comprobar que dispara**: `db:cron -- --check` imprime las extensiones, el `jobid`, el `schedule`, el
comando grabado, el resto de jobs y las **tres últimas respuestas de `pg_net`** (se guardan 6 h). El
cuerpo separa los dos casos que comparten `200`: `"status":"ok"` es una pasada real y
`"status":"cooldown"` que alguien usó el candado dentro de la ventana. Un `error` o `sin respuesta
(timeout)` significa que la petición no salió de la base. También se puede mirar
`cron.job_run_details` desde el panel y `net._http_response` en el SQL Editor.

`cron.use_background_workers` está en `off` (lo que trae Supabase), así que cada ejecución abre una
conexión nueva a `cron.host` (`localhost`); si algún día no pudiera, el job se programaría igual sin
error y solo se vería en `job_run_details`. `--check` imprime ese ajuste.

Vuelta atrás: `npm run db:cron -- --remove` desprograma el job y deja las extensiones, que son inertes.

## Salud del sincronizador

Que el cron dispare **no** es lo mismo que el sincronizador funcione: `net.http_post` encola y
devuelve, sin esperar al Worker. Un Worker caído, una base que no responde o un `profileId` mal
escrito dan el mismo `200`. Por eso el rastro va aparte: cada pasada escribe
`Setting["sync.lastRun"]` (contadores, reintentos, pausas por límite, el error de cada paso y **los
jugadores que fallaron con el motivo literal de la API**), lo hacen todas las vías por igual.

Se lee con `getSyncHealth()` y se enseña como aviso en **`/admin`** (no en `/admin/alertas`: esa
pestaña es para comportamientos de jugadores, no para salud de procesos). Tres estados:

| Estado | Qué significa |
|---|---|
| Sin rastro | Nunca se ha escrito una pasada. No es "todo bien". |
| `degraded` (a medias) | Algo falló; la web puede estar enseñando una clasificación vieja. |
| `stale` (vieja) | No se escribe ninguna desde hace más de `SYNC_STALE_MINUTES` (20). |

El rastro lleva `lastSuccessAt`, que **no avanza si la pasada sale a medias**: responde "¿desde cuándo
está roto?". No hay histórico de pasadas: solo la última y el marcador de la última buena.

Bajo el titular, la tarjeta de `/admin` añade el detalle del relleno (`backfillPending` con
`backfillStalled`: completo, en curso, atascado o sin medir), los **errores de lote** por encima de
los fallos por jugador —un lote caído explica hasta 50 de ellos— y, al pie, el `apiNotice` de
AoE4World como nota. El `gamesCursor` se guarda en el rastro pero no se pinta.

Los contadores del rastro son del **torneo**, no de filas tocadas. `newMatches` cuenta las partidas que
**entran a contar** para el torneo en la pasada: las que se importan ya resueltas y cumplen la regla
única (`countsAsRanked()`, con la condición de equipo incluida), más las que estaban **en curso**
(`finishedAt = null`) y han quedado resueltas cumpliéndola. Una partida importada fuera de la ventana
o del corte de inscripción, de un modo que no puntúa, de un equipo desequilibrado, o que sigue en
curso, **no** suma ahí aunque se haya guardado: eso lo dicen `updatedMatches` y el detalle por jugador.
Es la diferencia entre "499 partidas nuevas" y "partidas nuevas que cuentan para el torneo".

La portada pinta **«Actualizado a las …»** con `getLastSyncFinishedAt()` (`src/lib/public.ts`), que
publica el `finishedAt` de la última pasada **registrada, aunque haya salido a medias** —no
`lastSuccessAt`—: la frase mide cuándo se tocaron los datos por última vez, no si esa pasada salió
bien. Es una lectura ligera de `Setting["sync.lastRun"]`, sin el rastro de salud de `/admin`.

## El límite de CPU del plan Free

En el plan **Free**, Cloudflare da **10 ms de CPU por invocación**, igual para una petición HTTP que
para un Cron Trigger. Una pasada del sync gasta del orden de **500 ms** (Prisma con su *query
compiler* en WASM, el parseo del JSON y el recálculo): unas **50 veces** el presupuesto. Un *isolate*
tolera pasarse de forma esporádica; de forma consistente lo mata con `Worker exceeded CPU time limit`
(error 1102).

No hay cambio de plan a la vista, así que se mitiga **recortando el trabajo**, en tres frentes:

- **Menos pasadas, pero medidas**: el reloj de `pg_cron` dispara cada minuto y el candado deja pasar
  una pasada cada **1-3 minutos** según lo que costó la anterior (`src/lib/sync-cadence.ts`). Un torneo
  de 50-60 jugadores va a 3 minutos; uno pequeño puede ir a 1. No es una cadencia fija: el presupuesto
  se controla por coste medido (jugadores, peticiones, duración y 429), no por un número elegido a ojo.
- **Menos trabajo por visita**: `/objetivos` y la ficha de participante ya **no** barren todas las
  clasificatorias ni recomputan el catálogo en JS. `recomputeScores()` publica la vista de objetivos
  entera (objetivos, rankings, pool y ventana) en `Setting["scoring.objectives"]`, en la misma
  transacción y **solo si la huella del contenido cambió**; las páginas leen esa clave. Si falta, no
  valida o es de otra versión de las reglas, caen al cómputo en vivo de siempre, de modo que la
  degradación es segura.
- **Menos sondeos del navegador**: el refresco automático de `/` y `/partidas` (`LiveRefresh`) pasa de
  75 s a **150 s**. La frescura real la marca el sync (cada 1-3 minutos), así que la mitad de sondeos
  apenas se nota en pantalla y recorta a la mitad las renders dinámicas de las pestañas abiertas.

Cómo se llegó aquí:

- Un Cron Trigger nativo cada 5 minutos se probó y se retiró (commit `459ed27`): el *isolate* aguantó
  una hora y luego mató todas las pasadas (44 errores en una hora). Con GitHub, que retrasa a cada
  4-6 h, el exceso es esporádico y pasa.
- **Supabase Cron no cambia el presupuesto, cambia la cuenta**: con un disparo HTTP externo hay una
  sola invocación por evento, sin *self-fetch* sobre el mismo *isolate*. La hipótesis va respaldada
  (trece pasadas con `200` y cero 1102 en la primera hora de prueba), pero **no es una garantía**:
  merece la pena mirar Workers Logs de vez en cuando.
- Las dos mitigaciones de arriba recortan el gasto, pero **no cambian el presupuesto**: si vuelve a
  morir con 1102, la conclusión es que hace falta el **plan Workers Paid** ($5/mes): 30 s por Cron
  Trigger y 5 min por petición. El mecanismo ya está andado (un `scheduled` sobre un *custom worker* de
  OpenNext funcionó); lo que no cabía era la CPU.
- Mientras se siga en Free, la llamada manual de un admin está sujeta a lo mismo. Por eso comparte
  candado y ventana con el cron (`src/lib/sync-cadence.ts`): insistir es lo único que garantiza que
  Cloudflare empiece a matar pasadas, y la ventana adaptativa ya deja 3 minutos cuando el torneo es
  grande. Un fallo de 1102 en los logs se investiga como siempre: es la señal de que el coste real ha
  crecido y hay que subir el freno o pasar a Paid.

## Inscripción pública

`/participar` es público, así que `registerPlayer` (`src/app/(public)/participar/actions.ts`) tiene
cinco capas y un requisito, en este orden:

1. **Campo trampa** (`website`): no escribe y devuelve la misma confirmación que un alta buena.
2. **Límite por IP** (`src/lib/rate-limit.ts`): cuenta en Postgres con la IP **hasheada**
   (HMAC-SHA-256 con `RATE_LIMIT_SALT`), en ventana fija y con un `INSERT ... ON CONFLICT` de una
   sentencia, que serializa dos envíos simultáneos. Sin IP, cae al cubo `global`. Por defecto, 5 por
   hora y IP.
3. **Captcha** (Turnstile, `src/lib/turnstile.ts`): **falla cerrado** y **se desactiva solo si no hay
   `TURNSTILE_SECRET_KEY`**. La site key es `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
4. **Validadores de campos** (compartidos con el alta de admin, `src/lib/player-input.ts`) y
   comprobación de la fila existente. El **correo es obligatorio**.
5. **Comprobación del perfil** (`src/lib/registration.ts`): `GET /players/:id` con presupuesto de 8 s.
   Un 404 es error de `profileId`; cualquier otro fallo no crea nada y es reintentable.

Entre la 3 y la 4, el **paso de Discord** (requisito, no defensa): si el OAuth está configurado se
verifica la cookie `discord_link` y, sin ella, sale un error de campo. Ver [Discord](#discord).

El resultado se deja **siempre en `PENDING`**: aprobar o rechazar es de la organización. Lo único que
se reescribe es un envío de un perfil `REJECTED`: actualiza esa misma fila y la devuelve a `PENDING`.
Un perfil `APPROVED` o `PENDING` bloquea el envío.

La inscripción está **cerrada por defecto**: el estado vive en `Setting`. El interruptor
`registration.open` la abre o cierra, y `registration.closesAt` es una **fecha de cierre**: si está
puesta, a esa hora las inscripciones se cierran **solas**. El estado efectivo es la conjunción
—abiertas ⇔ interruptor encendido **y** (sin fecha o `now < closesAt`)—, así que el interruptor sigue
pudiendo cerrar antes, y para **reabrir** después de la fecha el superadministrador quita o mueve la
fecha. Sin fecha configurada todo funciona como antes.

## Administración del panel

El panel (`/admin`) ya no lo abre cualquier usuario de Supabase Auth: hace falta estar en la **lista
de admins**. Hay dos papeles, con una regla cada uno.

| Papel | Quién | Qué puede |
|---|---|---|
| Superadministrador | El correo de `SUPERADMIN_EMAIL`, y solo ese | Todo lo de un admin, más la configuración de la edición y las opciones de inscripción y donaciones, invitar, dar de baja y reactivar admins, deshacer sus acciones, **revertir actuaciones administrativas** y mandar el aviso de prueba del bot |
| Admin | Una fila **activa** de la tabla `Admin` | El panel entero salvo la gestión de admins, la reversión de actuaciones, la configuración de la edición y las opciones de inscripción y donaciones. Puede **crear expulsiones y anulaciones** |

- El superadministrador **no tiene fila**: se reconoce por la variable de entorno. Sin
  `SUPERADMIN_EMAIL`, **nadie** lo es (la app arranca igual y avisa una vez en el log), y la gestión
  de admins queda inaccesible hasta que se defina.
- Un usuario autenticado **sin acceso** no va a `/login` —el Proxy lo devolvería a `/admin`—: va a
  `/sin-acceso`, que explica la situación y ofrece cerrar sesión.
- La comprobación se hace en **cada petición** leyendo la fila (`requireAdmin()` en
  `src/lib/auth.ts`), así que una baja surte efecto en la siguiente navegación, sin esperar a que
  caduque ningún token.

### Variables

| Variable | Para qué | ¿Obligatoria? |
|---|---|---|
| `SUPERADMIN_EMAIL` | Correo del superadministrador único. Se compara en minúsculas y sin espacios | Sí, para gestionar admins |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de servicio de Supabase Auth: invitar por correo, buscar cuentas y banear/desbanear | Sí, para invitar |

Las dos van en el panel del Worker **y además** en *Build variables and secrets* ([los dos
sitios](./DESPLIEGUE.md#variables-los-dos-sitios-del-panel)); la segunda, como secreto, y **nunca** en
el cliente ni en un log. Sin `SUPABASE_SERVICE_ROLE_KEY`, invitar responde "no configurado", pero dar
de baja y reactivar siguen funcionando (el ban de Auth se salta con un aviso en el mensaje).

### Alta por invitación

1. El superadministrador escribe el correo en el panel.
2. Si la cuenta **no existe** en Supabase Auth, se crea con `inviteUserByEmail`: la persona recibe un
   correo, el enlace pasa por `/auth/confirm`, fija su contraseña en `/login/establecer-contrasena` y
   entra.
3. Si la cuenta **ya existe** (los admins anteriores), no se manda correo: se vincula su
   `authUserId` y se le da acceso; entra con su contraseña de siempre.

- **El destino del correo lo decide el proyecto de Supabase**, no la app. Hacen falta **dos** cosas en
  Authentication, y sin ellas el enlace no llega a `/auth/confirm`:
  - **URL Configuration**: *Site URL* = el dominio actual, y `https://laligahispana.es/**` en
    *Redirect URLs* ([paso del cambio de dominio](./DESPLIEGUE.md#pasos-del-cambio-de-dominio)).
  - **Email Templates**: las plantillas de *invite* y *recovery* enlazan a la ruta de la app, no a
    `{{ .ConfirmationURL }}`:
    `<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite">Aceptar la invitación</a>`
    (en la de recuperación, `type=recovery`). El `{{ .ConfirmationURL }}` de serie verifica en
    `supabase.co` y deja la sesión en el fragmento, que la web no consume: la cuenta se crea pero
    nadie fija la contraseña.
  - Las plantillas exigen **SMTP propio**: desde el 3 de junio de 2026, los proyectos Free nuevos con
    el correo de Supabase no dejan editarlas, y ese servicio además solo entrega a direcciones que
    sean miembro del equipo de la organización (2 correos/hora, sin garantía). Configurar Resend (u
    otro SMTP) en Authentication → SMTP Settings desbloquea las plantillas y el envío a cualquier
    dirección, que es lo que necesitan las invitaciones de admin. El remitente tiene que colgar del
    dominio verificado en el proveedor (DNS: DKIM `resend._domainkey.<dominio>` y MX/SPF de `send.<dominio>`)
    y el host va **sin esquema** (`smtp.resend.com`, no `http://smtp.resend.com`): con el esquema el
    envío falla con un 500 genérico en `/auth/v1/recover` y sin rastro en el proveedor.
- Si el enlace aterrizó en un host viejo o la cuenta se creó sin que nadie fijara contraseña, a esa
  persona hay que mandarle un correo de **recuperación** desde Authentication → Users: pasa por el
  mismo `/auth/confirm`.
- **Configuración actual del correo**: SMTP propio por Resend (`smtp.resend.com:465`, usuario
  `resend`), remitente `no-reply@laligahispana.es` (dominio verificado `laligahispana.es`), *Site
  URL* `https://laligahispana.es` y las plantillas de *invite* y *recovery* enlazando a
  `/auth/confirm`.

Dar de baja es `active = false` (no se borra la fila) y corta la sesión viva en Auth (best-effort);
reactivar lo deshace. Todo queda registrado en `/admin/acciones`.

### Transición

La tabla `Admin` **arranca vacía**: al desplegar esto solo entra el superadministrador, y él invita
al resto. Los admins actuales pierden el acceso hasta que los añada —por el camino 3, sin correo—.

### Participantes

Qué se puede hacer con un participante y **dónde** se ofrece cada acción:

| Acción | Dónde | Qué hace |
|---|---|---|
| **Aprobar** / **rechazar** una solicitud | En la **cola de solicitudes pendientes** de `/admin` y en el listado | Cambia el estado; aprobar mete al jugador en la clasificación y rechazar lo deja fuera |
| **Editar** los datos | Listado de participantes («Todos los jugadores») | Corrige nombre, país, correo, canales y `@usuario`; no toca el estado |
| **Expulsar** a un aprobado | Actuaciones (`BAN`); el listado enlaza a la actuación ya prefijada | Deja `BANNED`, reversible y sin perder datos |
| **Anular** partidas | Actuaciones (`MATCH_ANNULMENT`) | La victoria deja de puntuar sin borrarse |

- **No hay baja destructiva desde el panel**: retirar a alguien aprobado es una expulsión, que conserva
  los datos y se puede revertir. La única forma de que desaparezca una fila es deshacer su alta desde
  `/admin/acciones`, y eso es irreversible.

### Deshacer una acción

El superadministrador puede **deshacer** desde `/admin/acciones` lo que hicieron los admins regulares.
La reversión es **compensatoria**, no un borrado: se deshace el cambio, se marca la acción original
(`AdminAction.revertedAt` / `revertedByEmail`) y se escribe una fila nueva `ACTION_REVERTED` con el
resumen de la original. Las tres cosas van en la **misma transacción**; el recálculo de la clasificación
va después y, si falla, se avisa (la siguiente pasada lo pone al día). El rastro nunca se borra: la
marca dice que la acción ya no está vigente.

| Tipo | Qué hace deshacerlo | ¿Se puede rehacer? |
|---|---|---|
| `PLAYER_APPROVED` / `PLAYER_REJECTED` | Devuelve al jugador el estado que tenía antes | Sí, aprobando o rechazando otra vez |
| `PLAYER_EDITED` | Devuelve a cada campo el valor anterior, validado otra vez | Sí, editando otra vez |
| `MATCH_POINTS_REVERTED` / `MATCH_POINTS_RESTORED` | Quita o vuelve a poner la marca de la partida. Son **legado**: el panel ya no ofrece revertir/restaurar una partida suelta; las anulaciones se hacen con una actuación | Solo desde el historial de acciones, para deshacer lo antiguo |
| `PLAYER_CREATED` | **Borra al jugador** y todo lo suyo, con su cursor de sincronización. Se rechaza si está `BANNED` o tiene actuaciones vigentes: primero se revierten | **No**: es irreversible |

- **Solo los tipos revertibles** (`isRevertibleActionType()`, `src/lib/admin-revert.ts`) y **una acción
  ya revertida no se revierte dos veces**. `PLAYER_REMOVED` es un tipo **histórico** —la baja
  destructiva ya no existe— y no está: el dato ya no existe. Tampoco
  `ADMIN_*` (la baja de un admin se deshace reactivándolo), `ACTION_REVERTED` ni `CONFIG_CHANGED` (la
  configuración se cambia publicando otra).
- **Si algo ha cambiado después, se dice y no se escribe nada.** Deshacer una aprobación cuando el
  jugador ya está en otro estado —o una edición cuyos valores ya volvieron— pisaría ese cambio
  posterior: el panel lo explica en vez de deshacer "todo lo que vino detrás".
- **Al deshacer una edición se valida otra vez el valor anterior**, con los mismos parsers del
  formulario. Un `@usuario` que entonces estaba libre y hoy es de otra fila da un error claro y no
  escribe nada: la reversión es todo o nada.
- **Deshacer un alta es la excepción irreversible**: borra al jugador, sus partidas y su cursor de
  sincronización, con la misma operación que hacía la baja destructiva del panel (retirada en la issue
  167). La interfaz pide confirmación.
- **Los cambios de puntos de una partida sueltos son legado**: `revertMatchPoints` y `restoreMatchPoints`
  ya no existen. Las anulaciones de ahora son actuaciones (`AdminAct`) con razón pública, y se revierten
  desde Actuaciones, no desde el historial de acciones. Las filas antiguas de
  `MATCH_POINTS_REVERTED`/`MATCH_POINTS_RESTORED` se conservan para poder consultarlas y deshacerlas.

## Actuaciones administrativas

Una **actuación** es el expediente con el que la organización sanciona o corrige el torneo. Tiene una
sola acción, una razón pública y, opcionalmente, información privada; se aplica al guardar y se anuncia
en Discord. Vive en `AdminAct` (`/admin/actuaciones`) y es un historial **aparte** de `AdminAction`.

| Tipo | Qué hace | Quién puede crearla | Al revertirla |
|---|---|---|---|
| **Expulsión** (`BAN`) | Pone `Player.status = BANNED`. Conserva todos los datos; es la forma de **retirar** a un participante aprobado, porque el panel ya no tiene baja destructiva | Cualquier admin | Restaura el estado que tenía antes (`statusBefore`) |
| **Anulación de partidas** (`MATCH_ANNULMENT`) | Marca `Match.revertedAt` en victorias que hoy puntúan. La fila sigue en el historial | Cualquier admin | Quita la marca de esas partidas |
| **Reversión** (`REVERSAL`) | Deshace una o varias actuaciones vigentes del mismo jugador | **Solo el superadministrador** | **No se revierte**: es final |

- **Una acción por actuación.** Una expulsión y una anulación del mismo jugador son dos actuaciones. La
  reversión es la única que selecciona varias filas, siempre del mismo participante y nunca una
  `REVERSAL`.
- **Qué partidas se pueden anular.** Solo **victorias** (`WIN`) que **hoy puntúan**: no revertidas, dentro
  de la ventana y del corte de inscripción, con el ruleset actual y con el equipo equilibrado. Las
  derrotas no se anulan.
- **La expulsión requiere un `APPROVED`** y no admite una segunda expulsión vigente. El estado `BANNED`
  bloquea aprobar y rechazar —y no hay borrado que ofrecer—: la única salida es revertir la expulsión.
- **Se aplica al guardar.** El cambio y la actuación van en la misma transacción, con guardas
  condicionales para que dos admins no se pisen. Después se recalcula la clasificación y se reevalúan las
  alertas del jugador.
- **Si el recálculo falla, no se compensa.** La actuación queda aplicada y la respuesta avisa de que la
  clasificación se pondrá al día en la próxima pasada del sincronizador. Es el mismo criterio que
  deshacer una acción.
- **La razón pública es obligatoria** (máx. 600 caracteres). **La información privada es opcional** (máx.
  4000) y **nunca** sale del panel: ni al canal, ni al DM, ni al log. El aviso recibe un tipo que no la
  admite.
- **Sin token, canal o cuenta de Discord, la actuación se aplica igual**: el aviso es *best-effort* y no
  bloquea ni puede hacer fallar la operación.

### Avisos de las actuaciones

Cada actuación se anuncia **siempre** que se aplica, con la razón pública y sin información privada:

| Qué | Cómo |
|---|---|
| Canal | `DISCORD_ANNOUNCE_CHANNEL_ID`, con `postChannelMessage()` |
| Privado | `POST /users/@me/channels` + publicar. Necesita cuenta resoluble (`discordUserId`, o el `@usuario` contra el roster cacheado) |
| Texto | `adminActChannelText()` / `adminActDmText()` (`src/lib/admin-acts.ts`), con el nombre de la edición y el enlace público si existe; truncado a 2000 caracteres |
| Dónde mirar | Errores en el log con el prefijo `[admin-act-notice]` |

- El envío va **después** del commit y de intentar el recálculo, con `ctx.waitUntil()` en el Worker (o se
  deja correr fuera). Un fallo de Discord no cambia lo que ve el administrador ni el estado del torneo.
- El **DM solo lleva la razón pública**, igual que el canal. La información privada se queda en el panel.

## Configurar la edición

La configuración de una edición vive en `Setting` y la cambia **solo el superadministrador** desde el
panel (`/admin/administracion`): los documentos que describen la edición, sus reglas y a quién admite.
La sección se organiza en subpestañas —Administradores, Edición, Puntuación, Inscripciones,
Donaciones y Avisos—, y la **inscripción** y las **donaciones** son opciones solo del
superadministrador que viven en sus subpestañas (`/admin/administracion/inscripciones` y
`/admin/administracion/donaciones`), no en ninguna pantalla que vean los admins regulares.

| Clave | Qué toca | Acción |
|---|---|---|
| `edition.config` | Nombre de la edición, premio base (importe y nota), retransmisión obligatoria y marca (emblema y color de acento) | `saveEditionConfig` |
| `scoring.ruleset` | Ventana, familias de ladder, puntos por victoria, civ aleatoria, puntos de objetivos y objetivos desactivados | `saveScoringRuleset` |
| `registration.countries` | Países admitidos en la inscripción, en el orden del catálogo | `saveCountries` |
| `registration.open` | El interruptor: si la inscripción está abierta | `setRegistrationOpen` |
| `registration.closesAt` | La fecha de cierre: pasada, cierra sola la inscripción (ISO-8601 UTC, o quitada) | `setRegistrationClosesAt` |
| `donations.matcherino` | Campaña de donaciones de Matcherino (banner y URL) | `setMatcherinoDonations` |

- **La validación es del servidor y va antes de escribir**: un nombre vacío, un importe que no es un
  entero de euros, un emblema que no es `http(s)` ni una ruta del sitio, un color que no es `#rrggbb` o
  una ventana mal formada se rechazan con su mensaje y no se escribe nada. Las dos funciones de
  escritura vuelven a validar por su cuenta: un documento que el sistema descartaría al leerlo no se
  publica.
- **La ventana del torneo se escribe en hora local de Madrid.** El campo del panel es un
  `datetime-local`; el servidor lo interpreta en `Europe/Madrid` y guarda el instante ISO-8601 UTC que
  lee el motor (`parseMadridLocalInstant()` en `src/lib/ranked-match.ts`). Un instante ISO con zona
  escrito a mano también vale. Ver [`PUNTUACION.md`](./PUNTUACION.md#la-ventana).
- **La fecha de cierre de inscripciones se escribe como la ventana, y la interpreta el servidor.** El
  campo `closesAt` de `setRegistrationClosesAt` acepta las dos formas de un formulario: un
  `datetime-local` (**sin zona**), que el servidor interpreta en `Europe/Madrid` con
  `parseMadridLocalInstant()` —la misma función que la ventana—, o un instante ISO-8601 **con zona**.
  En los dos casos se guarda en ISO-8601 UTC. Vacío **quita** la fecha, que es como se reabre después
  del cierre. La subpestaña la prefila en hora de Madrid y enseña el **estado efectivo** del plazo
  —abierto, cerrado por el interruptor o cerrado por la fecha— con el motivo al lado, para que con la
  fecha ya pasada no se lea "abiertas" porque el interruptor siga encendido.
- **Todo queda en `/admin/acciones`** como `CONFIG_CHANGED`, con qué campos cambiaron y sus dos valores,
  en la misma transacción que el cambio.
- **Los países admitidos** solo pueden ser los del catálogo del código (`DEFAULT_COUNTRIES`): la lista no
  se amplía más allá sin tocar código, porque los ISO de AoE4World que resuelven el país de un perfil
  viven en `countries.ts`. La selección se guarda en el **orden del catálogo**, no en el del formulario.
- **Un cambio de reglas que mueva puntos recalcula la clasificación al guardar.** Si el recálculo falla,
  las reglas **sí** están guardadas y el mensaje lo dice: la clasificación se pone al día en la
  siguiente pasada del sincronizador.
- **Con la edición empezada, los puntos quedan congelados.** Desde `window.from` (`editionStarted()`),
  `saveScoringRuleset` rechaza la fecha de inicio, las familias de ladder, los puntos por victoria, el
  recuento de civs aleatorias, los puntos de objetivos y los objetivos desactivados: moverlos
  reescribiría una clasificación ya publicada. Lo único que se puede fijar o cambiar es el **fin de la
  ventana** (`window.to`), que es cómo se cierra la edición. El bloqueo está en el servidor; la
  pantalla esconde los campos congelados y solo deja fijar el fin.
- **La retransmisión obligatoria** enciende la alerta `NO_STREAM_CHANNEL` (ver
  [Alertas de comportamiento](#alertas-de-comportamiento)). Apagarla **no** borra las alertas ya
  escritas: `Alert` es *append-only*.
- **Los objetivos desactivados** (`scoring.ruleset.disabledObjectives`) dejan de computarse, de
  publicarse y de dar puntos, y sus eventos se borran (ver
  [`OBJETIVOS.md`](./OBJETIVOS.md#desactivar-un-objetivo)).
- **El premio base** (`amount` a `null` = sin premio anunciado) y la marca son contenido de la web: los
  pinta la interfaz, y el color de acento se aplica como variable CSS del layout, que no se reescribe
  desde aquí.
- **Todo tiene documento por defecto**: sin `edition.config` la edición usa el nombre del sitio, sin
  premio y sin retransmisión obligatoria, así que la web funciona sin que nadie configure nada.

## Discord

La inscripción **exige** conectar Discord cuando el OAuth está configurado. No hay campo de texto: un
botón lleva a la pantalla de permisos y vuelve con la identidad en una cookie firmada. **Sin las
credenciales el paso no existe** (no falla): el formulario no pinta el botón y deja un aviso
`[discord]` en el log. En producción son obligatorias.

| Variable | Para qué | ¿Obligatoria? |
|---|---|---|
| `DISCORD_CLIENT_ID` | Client ID de la aplicación OAuth2 | Sí, en producción |
| `DISCORD_CLIENT_SECRET` | Canje del `code` por un token. **Nunca** en el cliente ni en un log | Sí, en producción |
| `DISCORD_BOT_TOKEN` | Auto-unión al servidor y comprobación de pertenencia | Sí, en producción |
| `DISCORD_GUILD_ID` | Servidor del torneo | Sí, en producción |
| `DISCORD_OAUTH_SECRET` | Firma de la cookie `discord_link` (20 min). Sin ella se usa `CRON_SECRET`; no hay respaldo en el código | Sí, en producción |
| `DISCORD_PUBLIC_KEY` | Clave pública Ed25519 (hex, 64 caracteres) con la que se verifica la firma de las **interacciones** del botón del privado de verificación. **No es un secreto** | Sí, en producción |
| `DISCORD_REDIRECT_URI` | URI registrada en Discord. Si falta, se deriva del origen + `/api/discord/oauth/callback` | No, pero conviene fijarla |
| `DISCORD_INVITE_URL` | Invitación de respaldo si el auto-unión falla | No |
| `DISCORD_API_BASE`, `DISCORD_TIMEOUT_MS`, `DISCORD_USER_AGENT` | Cliente de Discord; el `User-Agent` debe ser **ASCII** (sin tildes) | No (valores por defecto) |
| `DISCORD_CHECK_MAX_PER_RUN` | Tope de cuentas comprobadas por pasada (10) | No |
| `DISCORD_ROSTER_MAX_PAGES`, `DISCORD_ROSTER_TTL_HOURS` | Páginas de la lista de miembros por refresco (20) y horas de caché (12) | No |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Canal donde el bot avisa de los **hitos de la edición** (comienzo, final, recordatorios y cierre de inscripciones), de los **eventos puntuales** (recordatorios, inicio y fin) y manda el **informe diario de clasificación** | Sí, para avisar |
| `DISCORD_PARTICIPANT_ROLE_ID` | Rol que el bot pone a los **participantes aprobados** y quita a quien deja de estarlo | Sí, para el rol |
| `DISCORD_ROLE_MAX_PER_RUN` | Tope de operaciones con el rol por pasada (10) | No |

Van en el panel del Worker **y además** en *Build variables and secrets* del trigger
([los dos sitios](./DESPLIEGUE.md#variables-los-dos-sitios-del-panel)). Los secretos, como secretos.

### Pasos manuales, una sola vez

1. Crear la **aplicación** en el portal de Discord (client id y secret; el secret **solo se muestra
   una vez**).
2. **OAuth2 → Redirects**: `https://laligahispana.es/api/discord/oauth/callback` (y el del
   `workers.dev` del Preview si se prueba ahí).
3. **Crear el bot** y copiar su token.
4. **Invitar el bot al servidor** con **solo estos cuatro permisos** (no usa ningún otro):

   | Permiso | Para qué |
   |---|---|
   | `View Channels` (`VIEW_CHANNEL`) | Ver el canal de avisos |
   | `Send Messages` (`SEND_MESSAGES`) | Hitos, informe diario y avisos globales |
   | `Create Instant Invite` (`CREATE_INSTANT_INVITE`) | Auto-unión al inscribirse (`PUT …/members`) |
   | `Manage Roles` (`MANAGE_ROLES`) | Poner y quitar el rol de participante |

   Los **privados no necesitan permiso** (`POST /users/@me/channels` no pide ninguno). No hacen falta
   `Read Message History`, `Manage Messages`, `Embed Links`, `Mention Everyone` ni nada de moderación.
   La invitación con esos cuatro es
   `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot&permissions=268438529`.

   **Sin `CREATE_INSTANT_INVITE`**, el `PUT …/members` responde 403 y **la inscripción no se bloquea**:
   se acepta con `joined: false` y se enseña el `DISCORD_INVITE_URL`. **Sin `MANAGE_ROLES`, o con el rol
   del bot por debajo** del de participante, el paso del rol responde 403 y el rastro lo dice
   ([ver abajo](#rol-de-participante-en-discord)). La jerarquía **no la salta `ADMINISTRATOR`**: hay que
   subir el rol del bot (Configuración del servidor → Roles).
5. **Activar el intent privilegiado `GUILD_MEMBERS`** (Bot → Privileged Gateway Intents → SERVER
   MEMBERS INTENT). Es manual y no se puede pedir por API; es lo que permite leer la **lista de
   miembros** del servidor, que comprueba a todos de una vez y **enlaza la cuenta de las altas de
   admin** por su `@usuario`. Sin él, el sistema funciona por el camino corto (ver abajo).
6. Copiar el **id del servidor** a `DISCORD_GUILD_ID` y el **id del rol de participante** a
   `DISCORD_PARTICIPANT_ROLE_ID`.
7. **Copiar la clave pública** de la aplicación (General Information → Public Key) a
   `DISCORD_PUBLIC_KEY` y configurar **Interactions Endpoint URL** en la misma página:
   `https://laligahispana.es/api/discord/interactions`. Discord manda un `PING` al guardar; si el
   endpoint no está desplegado o la clave no coincide, el portal **no guarda** la URL. Es el paso que
   activa la confirmación de altas: sin él, el botón del privado no existe y el alta de admin aprueba
   directamente (ver [Verificación del alta de admin](#verificación-del-alta-de-admin)).

Los scopes `identify` y `guilds.join` no se configuran en el portal: los pone el código al construir
la URL de autorización.

### Verificación del alta de admin

Dar de alta a alguien desde el panel lo dejaba dentro sin que la persona hiciera nada. Desde la issue
119, si la verificación está configurada, el bot le manda un **privado con dos botones** y la fila **no
queda aprobada** hasta que confirma desde su cuenta. No hay campo nuevo en el formulario: se dispara
solo, con el `@usuario` que ya se escribe.

**Cuándo está activa.** Solo con las cuatro credenciales: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_CLIENT_ID` y `DISCORD_PUBLIC_KEY` (`isDiscordVerificationConfigured()`). Sin ellas la
funcionalidad se apaga y el alta se comporta como siempre; el endpoint de interacciones contesta `503`.
En producción es obligatoria.

**El aviso del panel.** El panel de participantes comprueba la configuración con
`missingDiscordVerificationEnv()` y, si falta alguna, muestra un aviso con los **nombres** de las que
faltan (`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CLIENT_ID`, `DISCORD_PUBLIC_KEY`, en ese
orden). Mientras se vea ese aviso, la verificación está apagada: dar de alta a alguien como
`APPROVED` lo deja `APPROVED` directamente, **sin privado y sin confirmación**, porque
`planApproval()` devuelve `approve` en cuanto la configuración falta. Es la degradación documentada
—el alta sigue funcionando—, pero no es lo que se quiere en producción: si el aviso aparece, hay que
configurar la variable que nombre antes de dar de alta a nadie. La lista de variables es la misma que
usa el guard (`missingVerificationEnv()`), así que el aviso no puede contradecirlo.

**Qué pasa al dar de alta** (`createPlayer`):

| Estado pedido | Qué se crea | Privado |
|---|---|---|
| `APPROVED` | `PENDING`, con `discordVerificationRequestedAt` | Se manda tras el commit; el mensaje del panel dice si salió o por qué no |
| `PENDING` | `PENDING`, con `discordVerificationRequestedAt` | No; se manda al aprobar |
| `REJECTED` | `REJECTED`, con `discordVerificationRequestedAt` | No; se manda si luego se aprueba |

**Estados y la puerta.** Una fila con `discordVerificationRequestedAt` informado y `discordVerifiedAt`
a `null` **no puede quedar `APPROVED`**. Se comprueba en las acciones, no en las consultas de
puntuación: un `PENDING` ya queda fuera de la clasificación, de la web y del rol.

| Acción | Qué hace |
|---|---|
| Aprobar sin privado enviado | Manda el privado y deja el alta en `PENDING`; si estaba `REJECTED`, vuelve a la cola de revisión |
| Aprobar con el privado ya enviado | No lo duplica; dice que se espera la confirmación |
| Aprobar sin poder resolver la cuenta o si el envío falla | **No cambia el estado** y devuelve el motivo |
| Rechazar | `REJECTED`; limpia token y cuenta destinataria; conserva `requestedAt` y `sentAt` |
| «Enviar verificación» / «Reenviar verificación» | Solo en `PENDING` sujeta y sin confirmar. La primera vez manda el privado (la fila aún no tiene `sentAt`); después lo reenvía y **rota el token**, con lo que los botones del privado anterior dejan de valer |
| «Aprobar sin verificación» | **Solo el superadministrador.** Pasa a `APPROVED`, limpia `requestedAt`, token y cuenta, y deja `PLAYER_APPROVED` con `details.withoutVerification = true` («Aprobación sin verificación de …») |
| Corregir el `@usuario` de un alta pendiente | Invalida token, cuenta destinataria y `sentAt`; conserva `requestedAt`. Al aprobar se manda uno nuevo |

**El privado.** Texto en español con el nombre de la edición, el nombre del jugador y su `profileId`, y
dos botones: «Sí, participo» (`pv:c:<token>`, verde) y «No, no participo» (`pv:d:<token>`, rojo). Las
menciones van desactivadas para que un nombre con `@` no pingue a nadie. La cuenta se resuelve con
`discordUserId` o, si no, con el `@usuario` contra el roster cacheado. Si esa cuenta ya está vinculada a
**otro** participante, no se manda y se dice con quién choca.

**El botón** (`POST /api/discord/interactions`). Público, sin sesión: la autenticación es la firma
Ed25519 de Discord (clave pública + cuerpo crudo + ventana de 5 minutos) y el `application_id` tiene que
ser el `DISCORD_CLIENT_ID`. Sí → `APPROVED` + `discordVerifiedAt`, y escribe `discordUserId` si la fila
no lo tenía; no → `REJECTED` + `discordDeclinedAt`. Las dos van con `updateMany` condicionado al token y
al estado: un reintento de Discord o dos pulsaciones no cuentan dos veces. Después edita el privado en el
sitio y le quita los botones. Si el botón ya no vale, la cuenta no es la destinataria o la fila ya no
está `PENDING`, contesta un texto genérico sin revelar datos. **No** calcula puntuación ni roles: eso lo
hace el worker en la siguiente pasada.

**Filas antiguas y `/participar`.** No se re-verifica a nadie: las filas anteriores no tienen
`requestedAt` y no se bloquean. La inscripción pública ya prueba la cuenta por OAuth, así que escribe
`discordVerifiedAt` al crear o reutilizar la fila y **no** manda privado.

**Reversiones.** Deshacer un rechazo devolvería la fila a `APPROVED`, y si la verificación está
pendiente la reversión **se bloquea** con un mensaje que remite a aprobar desde el panel o a «Aprobar
sin verificación»: una reversión no puede ser una puerta de atrás sin rastro.

**Dónde mirar si falla.** Log del Worker con `[discord-verification]` (envío y resolución) y
`[discord-interactions]` (firma). Nunca se registra el token. Si el portal de Discord no guarda la URL
de interacciones, el `PING` no ha recibido `{"type":1}`: revisa que el endpoint esté desplegado y que
`DISCORD_PUBLIC_KEY` sea la de esa aplicación.

**Prueba real.** Dar de alta a una cuenta de prueba con estado «Aprobado»: debe quedar `Pendiente` con
el aviso de que se ha enviado el privado; al pulsar «Sí» en Discord, la fila pasa a `Aprobado` y el DM
se edita sin botones. Con «No», a `Rechazado`.

### Por qué parece que el bot necesita `ADMINISTRATOR`

`ADMINISTRATOR` no añade ninguna acción que el bot use: concede todos los permisos **y salta las
sobrescrituras de canal**. Si el bot solo funciona con él, lo que falta es un permiso al que los
permisos del servidor no llegan:

1. **Sobrescrituras del canal de avisos.** Si el canal es privado, el bot necesita `VIEW_CHANNEL` y
   `SEND_MESSAGES` **en ese canal** (Editar canal → Permisos → rol del bot). `ADMINISTRATOR` las salta;
   los permisos del servidor, no. Un `403` con «Missing Access» es esto.
2. **Los permisos están en un rol que el bot no lleva.** El bot usa su propio rol (el que se crea con su
   nombre al invitarlo) y los que se le asignen; un rol nuevo con permisos que nadie le ha puesto al bot
   no hace nada.
3. **Falta `MANAGE_ROLES` o el rol del bot está por debajo** del de participante. Un `403` con «Missing
   Permissions» al publicar suele ser falta de `SEND_MESSAGES` en el canal; al poner el rol, falta
   `MANAGE_ROLES` o sobra altura del rol de participante.

`ADMINISTRATOR` **no** salta la jerarquía de roles: si lo que falla es poner el rol de participante y el
rol del bot está por debajo, seguirá fallando con él.

### Dónde mirar si falla

- Log del Worker con prefijo `[discord]`. El motivo **nunca** va en la URL: el callback solo redirige a
  `/participar?discord=ok|cancel|error|no-config`.
- Log del Worker con prefijo `[discord-verification]` (privado de verificación y resolución de sus
  botones) y `[discord-interactions]` (firma del endpoint). **Nunca** aparece el token del botón.
- `?discord=error` casi siempre es el `state` (cookie caducada u otro navegador) o un canje rechazado
  (`invalid_grant`: el `code` ya se usó o el `redirect_uri` no coincide).
- `?discord=ok` con el formulario pidiendo la cuenta otra vez es una cookie caducada (20 min) o falta
  `DISCORD_INVITE_URL`.
- Un `P2002` de `discordUsername` al inscribirse suele ser un `@usuario` que se le escribió mal a otro
  participante: hay que corregir la fila del otro.

### Sin lista de miembros

Es el estado normal **mientras no se active `GUILD_MEMBERS`**, y no es un fallo. Discord contesta
`200` con la lista vacía, y el worker lo trata como "no se ha podido comprobar":

| | Qué hace |
|---|---|
| Columnas | No escribe `discordInGuild` ni `discordCheckedAt` por la lista, ni ninguna alerta |
| Comprobación | Cae a la consulta por cuenta para quien tenga `discordUserId`. Quien solo tenga `@usuario` (altas de admin) **no se comprueba** |
| Rastro | `discordError` lo dice con el motivo y cuántos quedaron sin comprobar |
| `lastSuccessAt` | **No** se mueve: no saber si alguien sigue en el servidor no ha parado nada |

Un roster viejo **no se usa como reserva**: si la lectura falla, se vuelve a la consulta por cuenta.

### Requisito operativo

`npm run db:push` añade las columnas de Discord, el valor `DISCORD_NOT_IN_GUILD` de `AlertRule`, el
**`@unique` de `discordUsername`** y, desde la issue 119, las seis columnas de la verificación del alta
más el **`@unique` de `discordVerificationToken`**. No hace falta `db:security`: no se crea ninguna
tabla, y las filas existentes quedan con las columnas nuevas a `null` (no se re-verifica a nadie). Que
estén aplicadas lo dice `npm run db:check` con el `DATABASE_URL` de esa base (sale con 2 si falta).

El push **avisa de pérdida de datos** por el `@unique` de `discordVerificationToken` («There might be
data loss…»). El aviso es genérico: la columna nace vacía (todo `NULL`), así que no hay duplicados ni
nada que perder. Tras comprobarlo, se aplica con `npm run db:push -- --accept-data-loss`.

Si el `db push` falla por unicidad en `discordUsername`, dos filas comparten nombre sin discriminador
(`pepito#1234` y `pepito#5678`). Hay que decidir cuál se queda con el `@usuario` y corregir o vaciar
el de la otra **con el panel cerrado**, y repetir. Para verlo antes:

```sql
select lower(split_part(discordUsername, '#', 1)) as canonico, count(*)
from "Player" where discordUsername is not null group by 1 having count(*) > 1;
```

## Alertas de comportamiento

El motor vigila **14 reglas**: **6 de patrón** sobre las clasificatorias (partidas cortas, rival
repetido y compañero repetido, cada uno en racha y en total), **4 de estado** (historial no público,
partidas de ladder que no llegan, Discord fuera del servidor y partidas sin resumen que revisar), **3 de
partida desde el resumen** (sin aldeanos en el arranque, sin crecimiento militar y sin obtener recursos)
y **1 condicional** (participante sin canal de directo, solo si la edición exige retransmisión).

```bash
npm test                       # el motor, con secuencias sintéticas y SIN base de datos
npm run alerts:check           # evaluación completa + resumen por consola
npm run alerts:check -- 6000037
npm run alerts:cutoffs         # deriva o refresca los cortes de división
npm run alerts:cutoffs -- --ladder=rm_team
npm run alerts:cutoffs -- --show
```

- La parte pura está en `tests/unit/lib/alerts/`: `compute.test.ts` (reglas sobre secuencias),
  `rules.test.ts` (umbrales, frases y claves de dedupe), `division-cutoffs.test.ts`,
  `report-archive.test.ts` (los CSV y su entrecomillado) y `zip.test.ts` (estructura del ZIP).
- **Umbrales** en `Setting["alerts.ruleset"]` (versión 1, con `DEFAULT_ALERTS_RULESET` de respaldo):
  partidas cortas < 180 s, rachas de 2 y 3, acumulados cada 5/10 y compañero repetido 7. Los cuatro del
  resumen: primer aldeano antes de **300 s**, **300 s** de gracia militar, **300 s** seguidos sin máximo
  militar después de la gracia y **120 s** seguidos sin recolectar. `window` y `modes` **no** se
  duplican: se leen del ruleset de puntuación, con el mismo `rankedMatchWhere()` y el corte de
  inscripción.
- **Un documento antiguo del ruleset sigue valiendo**: las cuatro claves nuevas no suben la versión, así
  que el documento que ya está en producción (versión 1, siete claves) se completa con los valores por
  defecto en vez de descartarse.
- **Qué partidas mira**: exactamente las que puntúan. Además del filtro de `rankedMatchWhere()` aplica
  en memoria la condición de equipo del motor de puntos, porque no cabe en un `where` de Prisma.
- **Cuándo se evalúa**: en `syncApprovedPlayers()`, después de `recomputeScores()`, **solo los
  jugadores tocados** —los que han cambiado partidas **y** los que han tenido un summary leído o una
  partida sin revisar, porque un resumen rellenado para una partida vieja también mueve sus alertas—; y
  también al aplicar una actuación que anula o revierte partidas o cambia el estado del jugador, al
  cerrar el torneo (`Setting["alerts.tournamentClose"]` lo marca) y a mano.
- **Las tres reglas del resumen son una alerta por partida y regla** (`MATCH_DETECTED`, anclada al
  `gameId`): el jugador que no hizo aldeanos en tres partidas tiene tres alertas, no una. Se evalúan
  solo con `summaryAnomalies` legible; si el `buildOrder` no se pudo leer, la de aldeanos **no se
  evalúa**, porque "no lo sé" no es "no hizo ninguno"; y **solo si la partida duró al menos la ventana
  de aldeanos** (300 s), porque una partida más corta no llegó a jugar esos primeros minutos y no se
  puede decir que no los hiciera. El tramo militar descuenta la gracia inicial (el explorador arranca la
  puntuación en 13 y no hacer un máximo nuevo al principio es normal).
- **`SUMMARY_NOT_REVIEWED` es de estado y una por jugador**: cuenta las partidas que pasaron la ventana
  de revisión del resumen sin respuesta concluyente, tras haberse intentado, y lleva en `details` sus
  `gameId` (hasta 20) y el último intento. Reevaluarla cada pasada no inserta nada nuevo. Distingue dos
  casos que conviene no confundir: `HISTORY_NOT_PUBLIC` afirma que el historial está **cerrado** porque
  el sondeo lo confirmó; `SUMMARY_NOT_REVIEWED` dice que **no se pudo confirmar** nada.
- **`NO_STREAM_CHANNEL`** es la única **condicional**: se evalúa solo si
  `Setting["edition.config"].streamingRequired` está activo, y avisa de los participantes aprobados
  **sin ningún canal** (`twitchChannel`, `youtubeChannel`, `kickChannel` y `twitchUrl` vacíos). No mira
  partidas, así que va sin ancla ni ventana —como la de Discord—, y su clave es de estado: reevaluarla
  cada pasada no inserta nada. Apagar el interruptor no borra las alertas ya escritas. Al **encenderlo**,
  los avisos aparecen en la siguiente evaluación que cubra a cada jugador: una pasada sin partidas
  nuevas evalúa a todos los aprobados, y el informe de alertas fuerza una completa.
- **Solo se publica la edición activa**: la pestaña y el informe filtran
  `Alert.createdAt >= window.from` de la ventana del ruleset de puntos, sin cota superior. Las filas
  anteriores se conservan en `Alert` (*append-only*) pero dejan de mostrarse al avanzar la ventana, así
  que la vista se reinicia con cada torneo sin borrar nada. No hay tope superior porque las alertas
  de cierre (`STREAK_AT_TOURNAMENT_END`) se escriben **después** de `window.to` y un
  `createdAt <= window.to` las ocultaría.
- **Informe**: `GET /admin/alertas/reporte` (detrás de `requireAdmin()`) devuelve un ZIP con tres
  CSV estándar (coma, RFC 4180, BOM UTF-8 y CRLF): `resumen.csv` con la cabecera de la tanda en dos
  columnas `Campo,Valor`, `alertas-disparadas.csv` y `rachas-abiertas.csv`, las dos con la misma
  cabecera de doce columnas. Un bloque sin filas sale con su cabecera y nada más. Antes llama a
  `evaluateAlerts({ full: true })`.
- **Idempotente**: `createMany({ skipDuplicates: true })` sobre `dedupeKey`; repetirlo no crea nada.
- **Dos reglas retiradas**: `TEAMMATE_ELO_GAP` (brecha de elo) y `LOW_DIVISION_TEAM_GAME` (equipo en
  una división muy distinta) **ya no se calculan**: su caso pasó a ser la condición de equipo de la
  puntuación (una partida con un compañero a dos escalones o más no cuenta, ver
  [`PUNTUACION.md`](./PUNTUACION.md)). Sus valores del enum, sus etiquetas y sus frases se quedan
  porque hay filas históricas de `Alert` en la tabla, y las que caen en la edición activa se siguen
  pintando.
- Un fallo del motor **no** mueve `lastSuccessAt`.

## Cortes de división

Los cortes rating → subdivisión que necesita la **condición de equipo** de la puntuación, y que el
motor de alertas lee para filtrar con esa misma regla las partidas que evalúa. Se cachean en
`Setting["alerts.divisionCutoffs"]` y se derivan a mano con `alerts:cutoffs` (~150 peticiones) porque
la API ignora `rating_min`/`rank_level`: hay que recorrer la ladder y quedarse con el rating más bajo
de cada bloque.

| Qué | Cuánto |
|---|---|
| Familias | Solo `rm_team`, la única que compara compañeros. El `rm_solo` que se derivaba antes se poda al reescribir la caché |
| Coste | ~130-150 peticiones por familia, con la separación mínima entre peticiones |
| Cadencia | A mano, cuando cambie el reparto de la temporada. El motor **nunca** los deriva: el sincronizador corre cada 1-3 minutos |

- **Sin cortes, la condición no se aplica**: las partidas de equipo cuentan (no se puede demostrar la
  infracción), y el aviso sale en el rastro del recálculo —`Setting["scoring.lastRun"]`, campo
  `warnings`— y en el log con el prefijo `[scoring]`. Es un hueco de configuración de todo el torneo,
  no de una partida.
- `npm run alerts:cutoffs -- --show` enseña lo cacheado con su fecha y su coste, para que nadie los
  tome por un dato que se recalcula solo.
- Unos cortes nuevos **no cambian la clasificación por sí solos**: hay que recalcular (`npm run score`,
  o la siguiente pasada del cron), que es cuando el motor los aplica.

## Directos (YouTube y Kick)

La detección de YouTube y Kick **cuelga del worker**, no de la web: se ejecuta como mucho **una vez
cada 10 minutos** (`STREAMS_MIN_INTERVAL_MINUTES`), para los aprobados con canal, aunque el sync de
partidas corra cada 1-3 minutos. Preguntar a dos plataformas en cada visita gastaría la cuota de
YouTube y ataría la web a dos APIs externas. El DAL solo lee lo que el worker escribió. Twitch no se
comprueba: su `twitchIsLive` sale de la ladder.

| Variable | Uso |
|---|---|
| `YOUTUBE_API_KEY` | Clave de la Data API v3. **Opcional**: sin ella la detección de YouTube no se hace (ni una petición) y el estado queda en `false` con un aviso |
| `STREAMS_MIN_INTERVAL_MINUTES` | Minutos mínimos entre dos comprobaciones del estado de directo (**10**). Es el reloj propio del paso, independiente del sync |
| `STREAMS_MAX_CHECKS_PER_RUN` | Tope de comprobaciones por pasada (24 = 12 participantes con las dos plataformas) |
| `STREAMS_TIMEOUT_MS`, `STREAMS_MIN_REQUEST_INTERVAL_MS`, `STREAMS_MAX_RETRIES`, `STREAMS_RETRY_BASE_MS`, `STREAMS_RETRY_MAX_MS` | Presupuesto, ritmo y *backoff* del cliente (5000 / 200 / 2 / 400 / 8000) |
| `STREAMS_USER_AGENT`, `YOUTUBE_API_BASE`, `KICK_API_BASE` | Cliente (valores por defecto) |

- Kick **no necesita clave**; si su endpoint no responde, el estado se queda en `false` con un aviso.
- Solo se escribe lo que cambia, y **lo que no se ha podido comprobar no se escribe**: un `false` por
  un fallo publicaría "no está en directo", que no se sabe.
- **YouTube no usa `search.list`**: ese endpoint tiene su **propia cuota de 100 llamadas al día**, aparte
  del fondo de 10 000 unidades/día del resto de la API, y con una pasada cada 10 minutos se agotaba
  **todos los días**. Desde que se agotaba hasta la medianoche del Pacífico (07:00 UTC) cada
  comprobación fallaba con un `429` de "Search Queries per day" y, como no saber no escribe nada, el
  estado del directo quedaba congelado horas. La comprobación va por tres endpoints del fondo común, en
  este orden: `channels.list?part=contentDetails&forHandle=@handle` (1 unidad, **una vez** por canal),
  `playlistItems.list?part=contentDetails&playlistId=<uploads>&maxResults=5` (1 unidad) y
  `videos.list?part=snippet,liveStreamingDetails&id=<ids separados por comas>` (1 unidad para todos los
  ids; este endpoint cobra por llamada, no por id). En directo = el `snippet` dice `live` **y** no hay
  `actualEndTime`: hacen falta las dos señales, porque al terminar el `snippet` puede seguir diciendo
  `live` unos minutos y hay emisiones viejas con `actualStartTime` sin `actualEndTime` que YouTube sigue
  marcando como `upcoming`.
- La resolución del canal se cachea: `channelId` **y** playlist de subidas en
  `Setting["streams.youtube.channel.<handle>"]` (ninguno de los dos cambia, y `channels.list` es el
  endpoint con el límite por minuto más estricto). Un documento de la versión anterior, sin la playlist,
  se vuelve a resolver una sola vez.
- Un fallo **no** mueve `lastSuccessAt`; sale en `streamsError`.

## Pool de mapas

El objetivo `por-tierra-y-agua` se resuelve contra `Setting["scoring.mapPool"]`. El worker lo refresca
**como mucho una vez al día** desde el **homepage de AoE4World**, no desde su API: la API pública no
expone el pool (`/stats/rm_solo/maps` es el catálogo con estadísticas, no la rotación en curso). El
estado inicial va incrustado en el HTML de `https://aoe4world.com/`, en el atributo `:initial-state`
de `<home-leaderboard>` con el JSON escapado.

| Qué | Cuánto |
|---|---|
| Petición | Una a `https://aoe4world.com/`, HTML, mismo `User-Agent` y plazo que el cliente de AoE4World |
| Cadencia | Una vez cada **24 h** (`MAP_POOL_REFRESH_INTERVAL_HOURS`); la rotación es mensual y el worker corre en cada pasada |
| Claves | `scoring.mapPool` (lo que lee el motor) y `scoring.mapPoolSync` (fecha y metadatos) |

- **Parseo frágil, fallo contenido**: `parseMapPoolHomepage()` es puro y **nunca lanza**; si el HTML no
  cuadra devuelve `null` y `Setting` **no se toca**. El motor sigue con el último pool bueno (o con el
  valor por defecto de `src/lib/map-pool.ts`, los 9 mapas reales) — un cambio de formato en el homepage
  no deja el objetivo sin mapas ni con la lista vacía.
- Con `AOE4WORLD_MOCK=1` **no sale a la red** (no hay fixture para el homepage): se conserva el último
  valor y no cuenta como fallo.
- La organización puede seguir reescribiendo `scoring.mapPool` a mano; el worker lo reemplazará en el
  siguiente refresco.
- Dónde mirar: `mapPoolError` en el rastro (`[sync] No se ha podido refrescar el pool de mapas: …`).
  **No** mueve `lastSuccessAt`.

## Resumen de partida

Cinco objetivos —`ansioso`, los tres `avance-relampago-*` y `defensor-del-pueblo`— se cobran con datos
que **no están en el listado de partidas**: los APM, el minuto al que se pasó de edad y cuántos aldeanos
se perdieron. Eso solo lo publica el **resumen** de cada partida, una ruta del **sitio** de AoE4World
(no de su API), y lo rellena el worker en su pasada (`backfillMatchSummaries()`,
`src/lib/sync-summaries.ts`). Del mismo resumen salen las **tres alertas por partida** de
[Alertas de comportamiento](#alertas-de-comportamiento).

| Qué | Cuánto |
|---|---|
| Petición | Una por partida a `…/players/{profileId}/games/{gameId}/summary?camelize=true`, con el `User-Agent` del proyecto |
| Partidas por pasada | **10** (`SUMMARY_MAX_PER_RUN`; `AOE4WORLD_SUMMARY_MAX_PER_RUN`) |
| Ritmo | **2 s** entre peticiones (`AOE4WORLD_SUMMARY_MIN_INTERVAL_MS`) |
| Orden | De la partida **más nueva a la más vieja**, con el histórico rellenándose por detrás |
| Reintento | Un fallo se reintenta pasada **1 h** (`AOE4WORLD_SUMMARY_RETRY_DELAY_MS`) |
| Ventana de revisión | **24 h** (`AOE4WORLD_SUMMARY_REVIEW_WINDOW_HOURS`): pasada esa edad sin respuesta concluyente, la partida deja de pedirse y se avisa de que quedó **sin revisar** |
| Columnas | Las ocho métricas del resumen (`apm` … `mountedVillagersLost`), `summaryAnomalies` y las dos marcas de control (ver [`MODELO-DATOS.md`](./MODELO-DATOS.md)) |

- **Qué partidas**: exactamente las que puntúan (el mismo `rankedMatchSql()` que la clasificación) y de
  un jugador que no tenga el historial cerrado. El filtro `historyPublic is distinct from false` deja
  pasar el "sin comprobar" y descarta a quien consta que no publica partidas.
- **Dos marcas, dos significados**: `summaryCheckedAt` es una respuesta **concluyente** (200 o 404) y
  saca la partida de la cola para siempre; `summaryLastAttemptAt` es **cualquier intento** (200, 404,
  fallo o 429) y es lo que sostiene el reintento de una hora y la detección de lo no revisado. `null` en
  la primera = nunca se resolvió; `null` en la segunda = nunca se intentó.
- **Un `404` es concluyente**: la partida no tiene resumen, se apunta en las dos marcas y no se vuelve a
  preguntar. Un fallo de red, un `5xx` o un `200` ilegible **no escriben métricas** —solo
  `summaryLastAttemptAt`—, así que la partida vuelve a la cola pasada la hora: no saber no es "no hay".
- **Un `429` corta la pasada.** No es un bache: es AoE4World pidiendo bajar el ritmo, así que se apunta
  el intento, se deja el resto de la cola para la pasada siguiente y se avisa en el rastro
  (`summariesError`). Seguir pidiendo sería la peor respuesta posible.
- **Aviso de no revisadas**: una partida que se intentó y pasó la ventana de 24 h sin resolución se
  descarta de la cola, pero no se olvida: se cuenta por jugador y el motor escribe
  `SUMMARY_NOT_REVIEWED`, una alerta de estado con las partidas y el último intento en `details`. El
  caso de **perfil privado confirmado** sigue siendo `HISTORY_NOT_PUBLIC`; este es el respaldo de lo que
  no se pudo confirmar.
- `apm` es la **marca de "hubo resumen"**, y `null` en cualquiera de las ocho métricas significa "no hay
  resumen", nunca "cero". Una partida sin resumen no cumple ninguna hazaña y **corta** la racha de
  `ansioso` (ver [`OBJETIVOS.md`](./OBJETIVOS.md#logros-cobra-quien-cumple)).
- **`summaryAnomalies`** guarda la evidencia compacta para las alertas (si el `buildOrder` se pudo leer,
  el primer aldeano y los dos tramos sin progreso). No sustituye a las métricas ni se escribe nunca sin
  un 200: es un resumen de cuatro datos, no el payload.
- Con `AOE4WORLD_MOCK=1` **no sale a la red**: se sirve una fixture determinista por partida, con la
  misma forma que el resumen de verdad (series incluidas), para que los lectores, los objetivos y las
  alertas se ejerciten en las simulaciones.
- Dónde mirar: `summariesError` en el rastro (`[sync] Summaries de partida: …`), con cuántos se han
  guardado, cuántos no tienen resumen, **cuántos quedaron sin revisar** y cuántos esperan a la pasada
  siguiente. **No** mueve `lastSuccessAt`: un resumen que no llega solo deja unos objetivos a medias.

## Transparencia del historial

Las dos reglas `HISTORY_NOT_PUBLIC` y `MISSING_LADDER_MATCHES` se comprueban en
`syncApprovedPlayers()`, después de las alertas y antes de los directos. Cuestan muy poco:

| Qué | Cuánto |
|---|---|
| Peticiones al sitio de AoE4World | Un `HEAD` de 0 bytes por partida, **3 partidas** como mucho |
| Cadencia por jugador | Una vez cada **12 h** (`HISTORY_CHECK_TTL_HOURS`, en `Player.historyCheckedAt`) |
| Jugadores por pasada | **6** (`HISTORY_CHECK_MAX_PER_RUN`); el resto, a la siguiente |
| Regla de la ladder | Cero peticiones: lee `Player.ladderGamesCount` y `ladderLastGameAt` |

- El tope existe por el despliegue: al activarlo todas las filas vencen a la vez; con 6 se escalona en
  cinco pasadas (~50 min) y luego el ritmo es de uno por jugador cada 12 h.
- **No hay permiso ni rate limit declarados en esa ruta.** Si el volumen creciera, lo correcto es
  avisar a AoE4World por su Discord, no subir el ritmo.
- Un `unknown` (timeout, `5xx`, red) **no escribe nada**: el jugador vuelve a la cola.
- Con `AOE4WORLD_MOCK=1` este paso no sale a la red (`syncApprovedPlayers({ history: false })`).
- Dónde mirar: `historyError` en el rastro (y `[sync] Historial de partidas: …`). **No** mueve
  `lastSuccessAt`.

## Pertenencia al servidor de Discord

La regla `DISCORD_NOT_IN_GUILD` se comprueba en `syncApprovedPlayers()`, después del historial y antes
de los directos.

| Qué | Cuánto |
|---|---|
| Con lista de miembros | `ceil(miembros / 1000)` cada **12 h** (`discord.roster`); cero si el roster está al día |
| Sin lista, y para confirmar una ausencia | Una por cuenta, `GET /guilds/{id}/members/{user}` |
| Cadencia por jugador | Una vez cada **12 h** (`Player.discordCheckedAt`) |
| Jugadores por pasada | **10** (`DISCORD_CHECK_MAX_PER_RUN`) |

- Se comprueba a quien tiene `discordUserId` **o** `discordUsername` y está `APPROVED`. A quien no
  tenga ninguno no se le pregunta ni se le avisa.
- **Sin credenciales no se comprueba, y no es un fallo**: si falta `DISCORD_BOT_TOKEN` o
  `DISCORD_GUILD_ID`, no lee ni una fila y deja un aviso permanente en `discordError`.
- La lista de miembros **solo afirma presencias**: es una foto de cuándo se leyó, así que quien entró
  al servidor después de esa lectura no aparece en ella (con la inscripción abierta, pasa cada hora).
  Una cuenta **con id** que no sale en la lista se confirma por cuenta —`404` fuera, `200` dentro—; un
  **`@usuario`** que no aparece (o aparece dos veces) solo se concluye si la lista se leyó en esta
  misma pasada, y si no el jugador vuelve a la cola.
- Un `unknown` (timeout, `5xx`, `401`, lista vacía) **no escribe nada**. Afirma una ausencia solo un
  `404`; una lista **leída en esta pasada** donde el `@usuario` no aparece también, pero una lista
  cacheada nunca.
- El resumen de `discordError` dice cuántas ausencias del roster se confirmaron por cuenta.
- Dónde mirar: `discordError` (`[sync] Discord: …`). **No** mueve `lastSuccessAt`.

## Rol de participante en Discord

El bot pone el **rol de participante** (`DISCORD_PARTICIPANT_ROLE_ID`) a los participantes aprobados con
cuenta de Discord y se lo quita a quien deja de estarlo (rechazado o eliminado). La fuente de verdad de
**quiénes son** es `Player.status`; el rol no sustituye a nada, acompaña. Lo hace el worker en su pasada
(`syncParticipantRole()`), justo después de la comprobación de pertenencia y con su **misma resolución de
cuentas**: `discordUserId`, o el `@usuario` resuelto por la lista de miembros.

| Qué | Cuánto |
|---|---|
| Poner el rol | `PUT /guilds/{id}/members/{user}/roles/{role}`, uno por cuenta nueva |
| Quitar el rol | `DELETE` de la misma ruta |
| Memoria | `Setting["discord.participantRole"]` (ids con el rol puesto por el bot) |
| Operaciones por pasada | **10** (`DISCORD_ROLE_MAX_PER_RUN`); el resto, a la siguiente |

- **Sin `DISCORD_PARTICIPANT_ROLE_ID` (o sin token o sin servidor) el paso no existe y no es un fallo**:
  no lee ni una fila y deja el motivo en `discordError`.
- **La memoria es la del que puso el rol**: sirve para saber a quién quitárselo, porque una fila
  **borrada** ya no tiene `discordUserId`. Si alguien se quita o se pone el rol a mano desde Discord, el
  worker no lo corrige.
- **No se toca a quien consta fuera del servidor** (`discordInGuild = false`): no se le puede poner un rol
  y, al caerse de la lista, se le vuelve a poner cuando regrese.
- **Un `403` o un timeout no tumban la pasada**: se resumen en `discordError` y se reintentan. Un `403`
  suele ser que al bot le falta `MANAGE_ROLES` o su rol no está por encima del de participante.
- Dónde mirar: `discordError` (`[sync] Rol de participante: …`). **No** mueve `lastSuccessAt`.

## Avisos del torneo en Discord

El bot manda mensajes a un canal (`DISCORD_ANNOUNCE_CHANNEL_ID`). Son de cinco clases: los **hitos de
la edición** (esta sección), los **avisos de los eventos puntuales** (recordatorios, inicio y fin; ver
[Eventos puntuales](#eventos-puntuales)), el **informe diario de clasificación**, los **avisos de las
acciones de administración** (las dos subsecciones de abajo) y los **avisos de las actuaciones
administrativas** (ver [Actuaciones administrativas](#avisos-de-las-actuaciones)). Los hitos los manda el
worker en su pasada (`announceEditionWindow()`): mira la ventana del ruleset
(`Setting["scoring.ruleset"].window`) y la fecha de cierre de inscripciones
(`Setting["registration.closesAt"]`).

| Hito | Cuándo |
|---|---|
| Comienzo / final | al cruzar `window.from` / `window.to` |
| Recordatorios 7/3/1 días | antes del inicio, antes del final y antes del cierre de inscripciones |
| Inscripciones cerradas | cuando el plazo pasa a cerrado (por la fecha o por el interruptor), si antes estuvo abierto |

| Qué | Dónde |
|---|---|
| Canal | `DISCORD_ANNOUNCE_CHANNEL_ID` (y el token del bot) |
| Memoria | `Setting["edition.announcements"]` (`startedAt`/`finishedAt`, el mapa `sent` y `registrationWasOpen`) |
| Texto | `announcementText()`: nombre de la edición, periodo y fecha de cierre publicados |
| Dónde mirar | `announceError` en `Setting["sync.lastRun"]` (`[sync] …`) |

- **Un hito, un mensaje, y nunca se repite**: la marca de un aviso dado no se quita, aunque la ventana
  se mueva. Con la ventana **abierta** (`to: null`) el aviso de final no existe.
- **Nada de ráfagas**: un recordatorio solo sale dentro de **su tramo** (el de 7 días, entre «faltan 7»
  y «faltan 3»; el de 1, entre «falta 1» y el cierre). Configurar el sistema a mitad de edición no
  dispara los hitos cuyo momento ya pasó: solo sale el del tramo en el que estamos y los siguientes
  cuando lleguen.
- **El cierre de inscripciones no se anuncia si el plazo nunca abrió**: la memoria guarda que estuvo
  abierto (`registrationWasOpen`) y solo avisa del paso a cerrado cuando eso fue verdad.
- **Sin `DISCORD_BOT_TOKEN` o sin canal no se envía, y el aviso queda pendiente** (no se anota), así que
  configurar el canal más tarde sigue dando el aviso que faltaba. El motivo va en `announceError`, que
  **no** mueve `lastSuccessAt`.
- Sin nada que anunciar, la pasada solo lee la ventana, la fecha, la memoria y el estado del plazo: es
  una comparación de fechas, sin leer el nombre de la edición ni crear ningún cliente HTTP.
- **Aviso de prueba**: el superadministrador puede mandar el texto real con el prefijo `(Prueba)` desde
  el panel (`sendTestAnnouncement`). No toca la memoria.

### Informe diario de clasificación

Además de los hitos, el bot publica **una vez al día** la clasificación entera y un enlace a la web. Lo
hace el worker en su pasada (`announceDailyStandings()`, en `src/lib/standings-report.ts`): en la
**primera pasada a partir de las 21:00 de Madrid** manda el informe del día.

| Qué | Dónde |
|---|---|
| Canal | `DISCORD_ANNOUNCE_CHANNEL_ID` (y el token del bot) |
| Fuente | `getStandings()` (`src/lib/public.ts`), la misma que ve la web |
| Enlace | `readPublicOrigin()` (`src/lib/site-url.ts`), el mismo dominio que el layout; apunta a la portada (`/`), que es donde está la clasificación. Sin dominio, sin enlace |
| Memoria | `Setting["discord.standingsReport"]` (`lastDay`, `pendingDay`, `sentChunks`) |
| Dónde mirar | `announceError` en `Setting["sync.lastRun"]` (`[sync] …`) |

- **Una vez por día de Madrid, y nada de ráfagas**: si la pasada de las 21:00 no ocurre (caída,
  despliegue), el informe de ese día **no se manda atrasado**; se salta y se informa del siguiente cuando
  llegue su hora.
- **La clasificación puede no caber en un mensaje**: se parte en varios de **2000 caracteres** como
  máximo, **por líneas** (sin cortar ninguna por la mitad). Si un trozo falla, la pasada siguiente retoma
  desde donde se quedó **sin repetir** lo ya enviado, y el día queda cerrado cuando sale el último.
- **Sin filas clasificadas no hay informe** (ni un mensaje diciendo que no hay nada), y no es un fallo.
- **Sin `DISCORD_BOT_TOKEN` o sin canal no se envía nada** y tampoco es un fallo: el aviso lo da el paso
  de los hitos. El motivo de un fallo va en `announceError`, que **no** mueve `lastSuccessAt`.

### Avisos de las acciones de administración

Desde la issue 167 el bot **no anuncia acciones sobre participantes**: solo anuncia las **actuaciones
administrativas** (expulsiones, anulaciones y reversiones), que llevan razón pública y sin información
privada; ver [la sección de actuaciones](#avisos-de-las-actuaciones).

- **Retirar a un participante aprobado es una expulsión**, no una baja: se anuncia como actuación y
  conserva sus datos.
- La **baja destructiva** del panel ya no existe y con ella se retiró su aviso (`[admin-notice]`,
  `src/lib/admin-notice-send.ts`). `AdminActionType.PLAYER_REMOVED` se queda solo para leer las filas
  históricas del historial de acciones.
- No avisan **deshacer** una acción ni aprobar o rechazar: no quitan nada ni son noticia.

## Eventos puntuales

Una **ventana con multiplicador**: durante el evento, cada victoria clasificatoria paga
`pointsPerWin × (multiplier − 1)` puntos de bono (x2, x3…). Las reglas de qué cuenta y cómo se
suma están en `docs/PUNTUACION.md`; aquí solo está la operativa. El catálogo se edita en el
panel (`/admin/administracion/eventos`) y se **bloquea** cuando empieza la ventana del torneo
(`window.from`): a partir de ahí, mover un evento cambiaría puntos ya publicados.

| Qué | Dónde |
|---|---|
| Eventos | `Setting["edition.events"]` (nombre, descripción, `from`/`to`, multiplicador y `discordRequired`) |
| Snapshot de elegibilidad | `Setting["edition.events.state"]` (`checkedAt`, `checkedPlayerIds`, `eligiblePlayerIds` por evento) |
| Memoria de avisos | `Setting["edition.events.announcements"]` (`sent`: `${eventId}:24h`/`12h`/`1h`/`start`/`end` → instante) |
| Dónde mirar | `announceError` (avisos) y `discordError` (elegibilidad) en `Setting["sync.lastRun"]`. Ninguno mueve `lastSuccessAt` |

### Avisos

El worker manda **cinco avisos** por evento: tres recordatorios antes de que empiece y
los dos de su ciclo de vida.

| Aviso | Cuándo (`now`) | ¿Atrasado? |
|---|---|---|
| 24 h | `[inicio − 24 h, inicio − 12 h)` | No: un tramo saltado no se recupera |
| 12 h | `[inicio − 12 h, inicio − 1 h)` | No |
| 1 h | `[inicio − 1 h, inicio)` | No |
| Inicio | `[inicio, fin)` | Sí: si el evento sigue en curso, sale igual |
| Fin | `[fin, ∞)` | Sí: el cierre se manda igual |

- **Los recordatorios son de tramo**: si la pasada de las 24 h no ocurre, no se manda al día
  siguiente; sale el tramo en el que estemos. Un aviso ya anotado no se repite.
- **El inicio y el fin toleran la tardanza**: el inicio sale en la primera pasada con el evento
  en curso (`inicio <= now < fin`), aunque lleve horas en marcha —el texto dice «ya está en
  marcha», no «empieza ahora»— y el fin sale en la primera pasada con `now >= fin`, aunque el
  cierre llegue tarde por una caída o un despliegue.
- **Un evento terminado no manda el inicio atrasado**: con `now >= fin` solo sale el fin. Un
  evento que se perdió entero se cierra sin anunciar su comienzo.
- **Como mucho un aviso por evento y pasada**, en orden de inicio del evento.
- El texto del recordatorio y del inicio lleva el nombre, la ventana en hora de Madrid, el
  multiplicador, la descripción si la hay y, si el evento lo pide, que solo cobran quienes estén
  en el servidor de Discord. El del fin cierra con el nombre y la ventana, sin repetir lo que ya
  no es accionable.
- Se menciona al rol de participante (`DISCORD_PARTICIPANT_ROLE_ID`) con
  `allowed_mentions` restringido a ese rol: no se pinguea a todo el mundo. **Sin ese rol no se
  manda nada** y el aviso queda pendiente; el motivo va en `announceError`.
- **El aviso de comienzo del torneo incluye un resumen de los eventos** (nombre, ventana,
  multiplicador y requisito de Discord). Si no cabe en un mensaje de 2000 caracteres, el aviso
  de inicio sale entero y el resumen en un segundo mensaje; la marca del comienzo se pone solo
  cuando han salido los dos. Sin eventos, el mensaje de inicio no cambia. Los dos mensajes salen
  con `allowed_mentions` vacío (`suppressMentions`): el nombre de un evento lo escribe el panel y
  un `@everyone` dentro de él no puede pingear al servidor.

### Snapshot de Discord

Si un evento tiene `discordRequired`, el bono solo lo cobran quienes estén en el servidor, y
quiénes son se decide **al empezar el evento** (`syncEditionEventEligibility()`, antes del
recálculo de la clasificación).

- **La primera pasada dentro del evento comprueba a todos los aprobados** y fuerza la lectura
  de la lista de miembros, ignorando su caché de 12 h: el snapshot es la foto del momento de
  empezar.
- **Las pasadas siguientes solo comprueban a los aprobados que faltan** (altas a mitad de
  evento). A quien ya se comprobó no se le vuelve a preguntar, y **nadie sale de
  `eligiblePlayerIds`**: la elegibilidad crece, no se revisa.
- El roster resuelve presencias sin una petición por jugador; una ausencia se confirma con
  `GET /guilds/{id}/members/{user_id}`. Las confirmaciones por cuenta se acotan con
  `DISCORD_CHECK_MAX_PER_RUN` y lo que queda se reintenta en la pasada siguiente.
- **Sin `discordUserId`** el jugador se cuenta como comprobado y **no elegible**: sin cuenta
  enlazada no hay manera de probar que es quien está en el servidor.
- Un veredicto **`unknown`** (timeout, `401`, `5xx`, roster ilegible) **no se marca**: se
  reintenta. No saber no es "no está", y aquí además sería "no cobra".
- Esta comprobación **no crea alertas** `DISCORD_NOT_IN_GUILD`: de eso se encarga la
  comprobación de pertenencia. Solo decide quién cobra.
- **Sin snapshot no hay bono**: si el evento empieza y termina entre dos pasadas del cron, no
  hay comprobación retroactiva y sus victorias no pagan extra. Es una limitación conocida del
  cron de 1-3 minutos.
- Sin `DISCORD_BOT_TOKEN` o `DISCORD_GUILD_ID` no se escribe nada y el motivo va en
  `discordError`: el evento que exige Discord no repartirá bono hasta que se configure.

## Simulaciones

### Con fixtures (mock de AoE4World)

`AOE4WORLD_MOCK=1` intercepta el punto de salida HTTP de la API (`performRequest()`) y responde con las
fixtures de `src/lib/aoe4world/mock/`. El **resumen** de partida, que vive en el sitio y no en la API,
tiene la suya (`mock/summary.ts`), resuelta por `fetchGameSummary()` sin salir a la red. Los parsers, el
worker y el motor son los de verdad. Con
`NODE_ENV=production` el arranque falla: el mock no puede estar activo en producción.

```bash
npm run mock:tournament   # crea o actualiza el torneo simulado y sincroniza
npm run mock:clean        # retira exactamente lo que crea
```

- 10 participantes `APPROVED` con `profileId` en el rango reservado `90000001`–`90000010`.
- Sincroniza **solo esos perfiles** y al final recalcula la clasificación.
- Incluye rivales externos (`92000001`–`92000010`), que **no** se convierten en `Player`: solo salen
  como `opponentProfileId`/`opponentName`, como en la base real.
- Idempotente. El histórico está anclado a una epoch fija y las partidas en vivo recalculan su
  `started_at` ("hace 10-20 min") en cada petición, así que no se pudre.
- `mock:clean` borra esos 10 jugadores, sus cursores y comprueba antes que las filas son las del mock.

> El cron `POST /api/cron/sync` también respeta el flag: con el mock activo y jugadores reales
> aprobados, esos perfiles recibirían 404. Por eso el script acota la pasada a los del mock.

### Con jugadores reales (API de verdad)

```bash
npm run simulate:tournament                    # elige, da de alta, importa la ventana y recalcula
npm run simulate:tournament -- --select-only   # solo elige e informa, sin tocar la base
npm run simulate:tournament -- --max-candidates=30 --max-pages=6
npm run simulate:clean                         # deshace lo que creó
npm run simulate:clean -- --dry-run
```

- **Quién entra**: un jugador por división con más de 20 partidas de `rm_solo` en los últimos 14 días.
- **Búsqueda**: la API ignora `rating_min`/`rank_level`, así que el script recorre la ladder con
  **búsqueda binaria** sobre la monotonía de las divisiones (~49 llamadas en vez de 461).
- **Ventana**: siembra el cursor de sincronización en el arranque del torneo (4 semanas, 3 pasadas) en
  vez de importar el histórico entero; a partir de ahí crece con el cron.
- **Coste**: ~90 llamadas y ~40 s de selección, más ~17 llamadas y ~6 s de importación.
- **Idempotente**.

**Cómo se deshace.** No hay rango de `profileId` reservado (son jugadores reales): lo que las marca es
el **manifiesto** `Setting["simulation.roster"]`. `simulate:clean` lee el manifiesto, **comprueba la
identidad de cada fila** (número, `profileId` y nombre) antes de tocar nada, avisa de los jugadores
que quedaron de una ejecución anterior y de las partidas fuera de la ventana, y **aborta sin borrar**
si algo no cuadra. Si el manifiesto se pierde, el borrado es a mano (preferible a borrar participantes
reales).

## Verificación

```bash
npm run verify:sync          # normalización con datos de ejemplo (no necesita BBDD)
npm run verify:sync -- --db  # además comprueba el guardado y restaura el estado de producción
```

`--db` usa dos jugadores de prueba (`profileId` 9000001 y 9000020) y un ruleset de prueba con una
ventana que cubre el presente. Antes de tocar nada guarda `sync.gamesCursor`, `sync.lastRun`, las
columnas `windowComplete`/`backfillPage`/`windowCheckedAt`/`profileCheckedAt` de **todos** los
aprobados y el ruleset; en un `finally` borra los jugadores de prueba (con sus partidas, puntuaciones
y claves de `Setting`) y restaura todo, incluso si una comprobación falla. Cubre también F2b: ventana
caducada recheckada, ventana reciente no recheckada, `0` que la desactiva y prioridad del pendiente
con `BACKFILL_MAX_PLAYERS=1`. Solo se niega a arrancar si alguno de esos
`profileId` ya existía de una ejecución anterior.

### API del overlay

```bash
npm run verify:overlay-api   # solo lectura, contra DATABASE_URL
```

Comprueba que los lectores de `src/lib/overlay-api.ts` —los mismos que sirven `/api/v0`— coinciden
con la base: participantes aprobados y su orden, catálogo activo con puntos y `max_progreso`, vecinos
de la clasificación, reparto de puntos, `rango`, `racha`, el feed de `ObjectiveProgressEvent` con y
sin `desde`, y la coherencia entre `ObjectiveProgressState` y su último evento. **No escribe ni borra
nada.**

### Medidas de AoE4World

```bash
npm run verify:aoe4world -- --sample 10   # muestra de 10 para páginas y paridad
npm run verify:aoe4world -- --all         # mide todos los aprobados
npm run verify:aoe4world -- --sample 5 --no-parity
```

Mide el roster y la ladder, recorre el histórico dentro de la ventana del ruleset, compara la paridad
con `Match`, mide la semántica de `updated_at`, comprueba el envelope masivo de `/games` y publica el
rastro del sincronizador. **Solo lee**; `--recalc` es la excepción: ejecuta `recomputeScores()`
(idempotente) y avisa antes de escribir.

## Cuando la base de datos no responde

Un corte puntual no puede ser un 500: la web tiene que seguir contestando. Las lecturas del DAL
devuelven un discriminante:

```ts
type PublicRead<T> = { status: "ok"; data: T } | { status: "degraded"; data: null };
```

- `degraded` devuelve **`null`**, nunca una lista vacía: un vacío se leería como "no hay
  participantes", que es falso.
- El motivo **no** viaja al navegador: se queda en el log del servidor con prefijo `[db]` y el `scope`,
  saneado (sin usuario, clave ni `password=`, conservando el *host*).
- Los scripts usan `unwrapRead()` (`@/lib/db-errors`), que **aborta** en vez de devolver vacío.

## Requisitos operativos de un despliegue

En orden, sobre la base de datos que usa el Worker:

```bash
npm run db:check                 # dice si a la base le falta el schema; sale con 2 si hay deriva
npm run db:push                  # sincroniza el schema
npm run db:security -- --check   # comprueba RLS; aplica con db:security si sale mal
npm run countries:seed           # publica la lista de países del formulario
npm run db:window                # publica la ventana de fechas del torneo (recomendado)
npm run alerts:cutoffs           # deriva los cortes de división de la condición de equipo
npm run backfill:objective-leads # reconstruye el historial de liderazgos de la edición
npm run db:cron                  # programa el reloj cada minuto
```

- `db:check` es de solo lectura y va antes del `db:push`: **0** = la base tiene el schema, **2** = le
  falta, **1** = error. **Cualquier** cambio de esquema obliga al `db:push`, también una **columna
  nueva** y no solo una tabla nueva: Prisma pide todas las columnas del modelo y la ausente tumba toda
  lectura y escritura de esa tabla. El porqué está en
  [`MODELO-DATOS.md`](./MODELO-DATOS.md#cambios-de-esquema).
- `db:security` es obligatorio **después de cada `db:push` que añada tablas**: una tabla nueva nace
  accesible para los roles de cliente. Si el `--check` falla, `npm run db:security`.
- `countries:seed` siembra `Setting["registration.countries"]` desde `paises.txt`; sin ella el
  formulario no tiene lista de países.
- `db:window` publica `window` en `scoring.ruleset`. Sin ella la clasificación puntúa con las fechas
  de prueba del código y puede congelarse en silencio al llegar la fecha `to`.
- `alerts:cutoffs` deriva los cortes de división de la condición de equipo. Sin ellos la condición no
  se aplica (las partidas de equipo cuentan) y el rastro del recálculo lo avisa: no rompe nada, pero
  el torneo puntuaría de más.
- `backfill:objective-leads` solo hace falta al desplegar el registro de liderazgos (`ObjectiveLeadEvent`)
  con una edición ya jugada: reconstruye la secuencia de pérdidas y ganancias desde las partidas
  contadas, con el `finishedAt` de cada partida. Es idempotente, toma el cerrojo del recálculo y
  `-- --dry-run` lo enseña sin escribir. Si la edición empieza después del despliegue, no hace falta.
- Variables del panel: las `NEXT_PUBLIC_*` y los secretos de servidor en las dos listas de build, y
  `YOUTUBE_API_KEY` y las de Discord en los dos sitios (Worker y build). Detalle en
  [`docs/DESPLIEGUE.md`](./DESPLIEGUE.md#variables-los-dos-sitios-del-panel).
- `SUPERADMIN_EMAIL` y `SUPABASE_SERVICE_ROLE_KEY`: sin la primera nadie administra a los admins, y
  sin la segunda no se puede invitar a ninguno. Ver
  [Administración del panel](#administración-del-panel).
- **Configuración de la edición**: no hay que sembrar nada. `edition.config` no existe hasta que el
  superadministrador guarda por primera vez, y hasta entonces la web usa el documento por defecto.
- **La versión 4 del ruleset** (`RULESET_VERSION`) deja la clasificación sin recalcular hasta la
  primera pasada: el `db:push` añade el valor `NO_STREAM_CHANNEL` al enum de `AlertRule`, la
  migración del documento la hace `ensureRuleset()` al leer, y la pasada del sincronizador (o
  `npm run score`) vuelve a escribir `PlayerScore`. La web **no** se queda vacía mientras tanto:
  publica la última clasificación calculada —la de la versión anterior más alta con filas— y quien
  pinte recibe `pendingRuleSetVersion` para avisar de que la tabla es de otra versión: la home lo dice
  en una nota sobre la tabla, sin prometer ningún recálculo automático. Si se despliega
  en medio de un torneo, conviene lanzar el recálculo a mano en cuanto termine el despliegue.
