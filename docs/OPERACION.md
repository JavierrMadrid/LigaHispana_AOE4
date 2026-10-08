# Operación

Lo que hay que hacer y mirar con el proyecto en marcha: quién dispara la sincronización, cómo
comprobar que sigue viva, sus límites y cómo se prueban las simulaciones. El despliegue está en
[`docs/DESPLIEGUE.md`](./DESPLIEGUE.md), el esquema en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md)
y las reglas en [`docs/PUNTUACION.md`](./PUNTUACION.md).

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
  descarta un POST de formulario ajeno) y un candado **global** de 5 minutos. Si se pide antes de
  tiempo responde `200` con `{"status":"cooldown"}`; si el candado no se puede comprobar, **no** lanza
  la pasada y responde `503`.

La llamada manual la hace un admin desde `/admin` con la Server Action `syncNow`
(`src/app/admin/actions.ts`), que comparte el mismo candado (`public/manual-sync`, en
`src/lib/manual-sync.ts`) para que el admin y el cron no se pisen. No escribe en `AdminAction`: ya
deja el rastro en `Setting["sync.lastRun"]`.

```bash
npm run sync                        # desde la terminal, sin levantar el servidor
npm run sync -- 4635035 8139502     # solo esos profileId
curl -X POST localhost:3000/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"
curl -X POST localhost:3000/api/sync -H "content-type: application/json" -d '{}'
```

**Cadencia: cada 5 minutos.** La API ya ha devuelto 429; por debajo de 3 minutos se disparan
demasiadas peticiones. Con más jugadores, sube `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` antes que la
frecuencia. Para las partidas en directo, 5 minutos basta: se detectan en la siguiente pasada.

Hay **dos relojes**, y el primario no es GitHub:

| Reloj | Qué es | Frecuencia real |
|---|---|---|
| **Supabase Cron** (primario) | Job de `pg_cron` que llama por HTTP a `POST /api/sync` con `pg_net` | 5 minutos (alguna vuelta se salta: ver abajo) |
| [Workflow de GitHub](../.github/workflows/cron-sync.yml) (red de seguridad) | `POST /api/cron/sync` con `Bearer $CRON_SECRET` | GitHub lo retrasa a una cada 4-6 h |

## El reloj: Supabase Cron

```bash
npm run db:cron              # aplica extensiones + job de 5 min (idempotente)
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
  '*/5 * * * *',
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
  global, **compartido con la llamada manual de admin**. Consecuencia real: el cron llega a veces unos
  segundos antes de que expire el candado de la pasada anterior y esa vuelta se salta sola (medido: 1
  de cada 5). No es un fallo; la cadencia queda entre 5 y 10 minutos.
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

## El límite de CPU del plan Free

En el plan **Free**, Cloudflare da **10 ms de CPU por invocación**, igual para una petición HTTP que
para un Cron Trigger. Una pasada del sync gasta del orden de **500 ms** (Prisma con su *query
compiler* en WASM, el parseo del JSON y el recálculo): unas **50 veces** el presupuesto. Un *isolate*
tolera pasarse de forma esporádica; de forma consistente lo mata con `Worker exceeded CPU time limit`
(error 1102).

- Un Cron Trigger nativo cada 5 minutos se probó y se retiró (commit `459ed27`): el *isolate* aguantó
  una hora y luego mató todas las pasadas (44 errores en una hora). Con GitHub, que retrasa a cada
  4-6 h, el exceso es esporádico y pasa.
- **Supabase Cron no cambia el presupuesto, cambia la cuenta**: con un disparo HTTP externo hay una
  sola invocación por evento, sin *self-fetch* sobre el mismo *isolate*. La hipótesis va respaldada
  (trece pasadas con `200` y cero 1102 en la primera hora de prueba), pero **no es una garantía**:
  merece la pena mirar Workers Logs de vez en cuando.
- Si vuelve a morir con 1102, la conclusión es que hace falta el **plan Workers Paid** ($5/mes):
  30 s por Cron Trigger y 5 min por petición. El mecanismo ya está andado (un `scheduled` sobre un
  *custom worker* de OpenNext funcionó); lo que no cabía era la CPU.
- Mientras se siga en Free, la llamada manual de un admin está sujeta a lo mismo. Por eso su candado
  es de **5 minutos** y comparte el del cron: insistir es lo único que garantiza que Cloudflare
  empiece a matar pasadas.

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

La inscripción está **cerrada por defecto**: el estado vive en `Setting["registration.open"]` y lo
abre o cierra la organización desde el panel.

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
| `DISCORD_REDIRECT_URI` | URI registrada en Discord. Si falta, se deriva del origen + `/api/discord/oauth/callback` | No, pero conviene fijarla |
| `DISCORD_INVITE_URL` | Invitación de respaldo si el auto-unión falla | No |
| `DISCORD_API_BASE`, `DISCORD_TIMEOUT_MS`, `DISCORD_USER_AGENT` | Cliente de Discord | No (valores por defecto) |
| `DISCORD_CHECK_MAX_PER_RUN` | Tope de cuentas comprobadas por pasada (10) | No |
| `DISCORD_ROSTER_MAX_PAGES`, `DISCORD_ROSTER_TTL_HOURS` | Páginas de la lista de miembros por refresco (20) y horas de caché (12) | No |

Van en el panel del Worker **y además** en *Build variables and secrets* del trigger
([los dos sitios](./DESPLIEGUE.md#variables-los-dos-sitios-del-panel)). Los secretos, como secretos.

### Pasos manuales, una sola vez

1. Crear la **aplicación** en el portal de Discord (client id y secret; el secret **solo se muestra
   una vez**).
2. **OAuth2 → Redirects**: `https://laligahispana.es/api/discord/oauth/callback` (y el del
   `workers.dev` del Preview si se prueba ahí).
3. **Crear el bot** y copiar su token.
4. **Invitar el bot al servidor** con el permiso `CREATE_INSTANT_INVITE`. Sin él, el `PUT …/members`
   responde 403 y **la inscripción no se bloquea**: se acepta con `joined: false` y se enseña el
   `DISCORD_INVITE_URL`.
5. **Activar el intent privilegiado `GUILD_MEMBERS`** (Bot → Privileged Gateway Intents → SERVER
   MEMBERS INTENT). Es manual y no se puede pedir por API; es lo que permite leer la **lista de
   miembros** del servidor, que comprueba a todos de una vez y **enlaza la cuenta de las altas de
   admin** por su `@usuario`. Sin él, el sistema funciona por el camino corto (ver abajo).
6. Copiar el **id del servidor** a `DISCORD_GUILD_ID`.

Los scopes `identify` y `guilds.join` no se configuran en el portal: los pone el código al construir
la URL de autorización.

### Dónde mirar si falla

- Log del Worker con prefijo `[discord]`. El motivo **nunca** va en la URL: el callback solo redirige a
  `/participar?discord=ok|cancel|error|no-config`.
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

`npm run db:push` añade las columnas de Discord, el valor `DISCORD_NOT_IN_GUILD` de `AlertRule` y el
**`@unique` de `discordUsername`**. No hace falta `db:security`: no se crea ninguna tabla.

Si el `db push` falla por unicidad en `discordUsername`, dos filas comparten nombre sin discriminador
(`pepito#1234` y `pepito#5678`). Hay que decidir cuál se queda con el `@usuario` y corregir o vaciar
el de la otra **con el panel cerrado**, y repetir. Para verlo antes:

```sql
select lower(split_part(discordUsername, '#', 1)) as canonico, count(*)
from "Player" where discordUsername is not null group by 1 having count(*) > 1;
```

## Alertas de comportamiento

El motor vigila **11 reglas** sobre las clasificatorias: **8 de patrón** (partidas cortas, rival o
compañero repetido, brecha de elo con un compañero y equipo por debajo de la división) y **3 de
estado** (historial no público, partidas de ladder que no llegan, y Discord fuera del servidor).

```bash
npm test                       # el motor, con secuencias sintéticas y SIN base de datos
npm run alerts:check           # evaluación completa + resumen por consola
npm run alerts:check -- 6000037
npm run alerts:cutoffs         # deriva o refresca los cortes de división
npm run alerts:cutoffs -- --ladder=rm_team
npm run alerts:cutoffs -- --show
```

- La parte pura está en `tests/unit/lib/alerts/`: `compute.test.ts` (reglas sobre secuencias),
  `rules.test.ts` (umbrales, frases y claves de dedupe) y `division-cutoffs.test.ts`.
- **Umbrales** en `Setting["alerts.ruleset"]` (versión 1, con `DEFAULT_ALERTS_RULESET` de respaldo):
  partidas cortas < 180 s, rachas de 2 y 3, acumulados cada 5/10, compañero repetido 7, brecha de elo
  500 y 3 escalones de división. `window` y `modes` **no** se duplican: se leen del ruleset de
  puntuación, con el mismo `rankedMatchWhere()` y el corte de inscripción.
- **Cuándo se evalúa**: en `syncApprovedPlayers()`, después de `recomputeScores()`, **solo los
  jugadores tocados**; y también al revertir o restaurar una partida, al cerrar el torneo
  (`Setting["alerts.tournamentClose"]` lo marca) y a mano.
- **Informe**: `GET /admin/alertas/reporte` (detrás de `requireAdmin()`) es un CSV para Excel con
  alertas disparadas y rachas abiertas, y llama a `evaluateAlerts({ full: true })` antes.
- **Idempotente**: `createMany({ skipDuplicates: true })` sobre `dedupeKey`; repetirlo no crea nada.
- **Cortes de división (R5)**: se cachean en `Setting["alerts.divisionCutoffs"]` y se derivan a mano
  con `alerts:cutoffs` (~150 peticiones por ladder) porque la API ignora `rating_min`/`rank_level`. Sin
  ellos, R5 se omite con un aviso y las otras diez reglas siguen.
- Un fallo del motor **no** mueve `lastSuccessAt`.

## Directos (YouTube y Kick)

La detección de YouTube y Kick **cuelga del worker**, no de la web (una vez por pasada, para los
aprobados con canal): preguntar a dos plataformas en cada visita gastaría la cuota de YouTube y ataría
la web a dos APIs externas. El DAL solo lee lo que el worker escribió. Twitch no se comprueba: su
`twitchIsLive` sale de la ladder.

| Variable | Uso |
|---|---|
| `YOUTUBE_API_KEY` | Clave de la Data API v3. **Opcional**: sin ella la detección de YouTube no se hace (ni una petición) y el estado queda en `false` con un aviso |
| `STREAMS_MAX_CHECKS_PER_RUN` | Tope de comprobaciones por pasada (24 = 12 participantes con las dos plataformas) |
| `STREAMS_TIMEOUT_MS`, `STREAMS_MIN_REQUEST_INTERVAL_MS`, `STREAMS_MAX_RETRIES`, `STREAMS_RETRY_BASE_MS`, `STREAMS_RETRY_MAX_MS` | Presupuesto, ritmo y *backoff* del cliente (5000 / 200 / 2 / 400 / 8000) |
| `STREAMS_USER_AGENT`, `YOUTUBE_API_BASE`, `KICK_API_BASE` | Cliente (valores por defecto) |

- Kick **no necesita clave**; si su endpoint no responde, el estado se queda en `false` con un aviso.
- Solo se escribe lo que cambia, y **lo que no se ha podido comprobar no se escribe**: un `false` por
  un fallo publicaría "no está en directo", que no se sabe.
- Los `channelId` de YouTube resueltos se cachean en `Setting["streams.youtube.channel.<handle>"]`.
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
| Cadencia | Una vez cada **24 h** (`MAP_POOL_REFRESH_INTERVAL_HOURS`); la rotación es mensual y el worker corre cada 5 min |
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
  cinco pasadas (~25 min) y luego el ritmo es de uno por jugador cada 12 h.
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
| Sin lista de miembros | Una por cuenta, `GET /guilds/{id}/members/{user}` |
| Cadencia por jugador | Una vez cada **12 h** (`Player.discordCheckedAt`) |
| Jugadores por pasada | **10** (`DISCORD_CHECK_MAX_PER_RUN`) |

- Se comprueba a quien tiene `discordUserId` **o** `discordUsername` y está `APPROVED`. A quien no
  tenga ninguno no se le pregunta ni se le avisa.
- **Sin credenciales no se comprueba, y no es un fallo**: si falta `DISCORD_BOT_TOKEN` o
  `DISCORD_GUILD_ID`, no lee ni una fila y deja un aviso permanente en `discordError`.
- Un `unknown` (timeout, `5xx`, `401`, lista vacía) **no escribe nada**. Solo un `404` (o una lista
  real donde el id no aparece) afirma algo.
- Dónde mirar: `discordError` (`[sync] Discord: …`). **No** mueve `lastSuccessAt`.

## Simulaciones

### Con fixtures (mock de AoE4World)

`AOE4WORLD_MOCK=1` intercepta el único punto de salida HTTP (`performRequest()`) y responde con las
fixtures de `src/lib/aoe4world/mock/`. Los parsers, el worker y el motor son los de verdad. Con
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
npm run verify:sync -- --db  # además comprueba el guardado y borra lo que crea
```

`--db` usa un jugador de prueba (`profileId` 9000001) que **borra al terminar siempre**, incluso si
una comprobación falla. Solo se niega a arrancar si ese jugador ya existía de una ejecución anterior
que murió sin limpiar; entonces hay que borrarlo desde el panel o a mano por su `profileId`.

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
npm run db:push                  # sincroniza el schema
npm run db:security -- --check   # comprueba RLS; aplica con db:security si sale mal
npm run countries:seed           # publica la lista de países del formulario
npm run db:window                # publica la ventana de fechas del torneo (recomendado)
npm run db:cron                  # programa el reloj cada 5 minutos
```

- `db:security` es obligatorio **después de cada `db:push` que añada tablas**: una tabla nueva nace
  accesible para los roles de cliente. Si el `--check` falla, `npm run db:security`.
- `countries:seed` siembra `Setting["registration.countries"]` desde `paises.txt`; sin ella el
  formulario no tiene lista de países.
- `db:window` publica `window` en `scoring.ruleset`. Sin ella la clasificación puntúa con las fechas
  de prueba del código y puede congelarse en silencio al llegar la fecha `to`.
- Variables del panel: las `NEXT_PUBLIC_*` y los secretos de servidor en las dos listas de build, y
  `YOUTUBE_API_KEY` y las de Discord en los dos sitios (Worker y build). Detalle en
  [`docs/DESPLIEGUE.md`](./DESPLIEGUE.md#variables-los-dos-sitios-del-panel).
