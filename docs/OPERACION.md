# Operación — Liga Hispana AoE4

Lo que hay que hacer y mirar cuando el proyecto está en marcha: quién dispara la sincronización, cómo
comprobar que sigue viva, qué límites tiene el plan Free y cómo se rehacen las simulaciones. El
desarrollo del Worker está en [`docs/DESPLIEGUE.md`](./DESPLIEGUE.md) y el estado de las fases, en
[`docs/PLAN.md`](./PLAN.md).

## Sincronización

El worker descarga las partidas de **todos** los participantes aprobados y las guarda con
deduplicación por `(playerId, gameId)`. Trae **todas** las ladders (no solo `rm_solo`): cada partida
guarda su `leaderboard` y el JSON crudo de la API para que el motor de puntuación pueda filtrar y
recalcular sin volver a historicarlo. Las decisiones de qué es una partida en directo, del cursor, del
*refetch* y de las abandonadas están en [`docs/PLAN.md`](./PLAN.md#f2--integración-aoe4world--worker-de-polling-).

Hay **dos** puntos de entrada, y los dos hacen el mismo trabajo (`syncApprovedPlayers()`):

- **`POST /api/cron/sync`** (y `GET`, porque Vercel Cron solo emite `GET`). Acepta dos formas de
  autenticación: sesión de un admin de Supabase (misma protección que el resto de `/admin`), o
  `Authorization: Bearer $CRON_SECRET` (imprescindible para un cron externo, que no manda cookies).
  Devuelve un resumen en JSON con el detalle por jugador (partidas vistas, nuevas, actualizadas,
  descartadas, resueltas por refetch y abandonadas) y los contadores de la API (peticiones,
  reintentos, pausas por *rate limit*).
- **`POST /api/sync`**, público, **sin secreto**, que es donde dispara el job de `pg_cron`. Exige
  `content-type: application/json`, que es lo que descarta un POST de otro sitio (un formulario solo
  manda tipos "simples"), y lleva un candado **global** de un sync cada 5 min (300 s, no 60: ver [El
  límite de CPU del plan Free](#el-límite-de-cpu-del-plan-free)) para que ni el job ni quien
  descubra la URL puedan provocar más de una pasada por ventana. Si se pide antes de tiempo responde
  `{ "status": "cooldown" }` con 200, porque no es un error: la pasada se hizo hace nada. Si el
  candado no se puede comprobar, **no** lanza la pasada y responde 503. Devuelve solo los
  contadores: al cron no le aporta nada el detalle.

```bash
# Desde la terminal, sin levantar el servidor
npm run sync
npm run sync -- 4635035 8139502     # solo esos profileId

# Como route handler (mismo trabajo)
curl -X POST http://localhost:3000/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"

# El disparo del cron (necesita el content-type, por lo del CSRF)
curl -X POST http://localhost:3000/api/sync -H "content-type: application/json" -d '{}'
```

La llamada manual ya **no** es un botón público: la hace un admin desde `/admin` con la Server
Action `syncNow` (`src/app/admin/actions.ts`), que comparte el mismo candado global (clave
`public/manual-sync`, en [`src/lib/manual-sync.ts`](../src/lib/manual-sync.ts)) para que el admin y
el cron no se pisen. Por eso la acción manual no registra nada en `AdminAction`: ya deja el rastro en
`Setting["sync.lastRun"]`, que es más completo.

### Cadencia recomendada

**Cada 5 minutos**. La API pide uso responsable y ya ha devuelto 429; por debajo de 3 minutos el
worker dispara demasiadas peticiones por minuto solo con un puñado de jugadores. Con más jugadores,
sube `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` antes que la frecuencia. Para F4 ("en directo") 5 minutos es
suficiente: una partida en directo se detecta en la siguiente pasada y se marca con
`finishedAt = null`.

Hay **dos relojes**, y el primario ya no es GitHub:

| Reloj | Qué es | Frecuencia real |
|---|---|---|
| **Supabase Cron** (primario) | Un job de `pg_cron` en la propia base de datos que llama por HTTP a `POST /api/sync` con `pg_net` | **5 minutos**, con alguna vuelta dentro del candado compartido con la llamada manual de admin (ver abajo) |
| [Workflow de GitHub](../.github/workflows/cron-sync.yml) (red de seguridad) | Una petición a `POST /api/cron/sync` con `Authorization: Bearer $CRON_SECRET` | GitHub la retrasa a **una cada 4-6 h** |

Se pone el primario abajo; el de GitHub se queda como está, con su `SITE_URL` y su `CRON_SECRET`
definidos en el repositorio (Settings > Secrets and variables > Actions), que es lo que necesita
para poder seguir funcionando si el otro se cae.

### El disparo desde Supabase Cron (`npm run db:cron`)

```bash
npm run db:cron              # aplica: extensiones + job de 5 minutos (idempotente)
npm run db:cron -- --check   # solo comprueba, no escribe; sale con 1 si no cuadra
npm run db:cron -- --remove  # desprograma el job (vuelta atrás)
```

El script es [`scripts/db-cron.ts`](../scripts/db-cron.ts), con el mismo patrón que
`scripts/db-security.ts`: SQL crudo con `pg` y `DATABASE_URL`, idempotente, y un `--check` que no
escribe. Existe por la misma razón que aquel: **`prisma db push` no gestiona ni las extensiones ni
`cron.job`**, así que un job hecho a mano desde el panel de Supabase no estaría en ninguna parte
del repositorio.

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

- **Apunta a `/api/sync` (público), no a `/api/cron/sync` (con `CRON_SECRET`).** Para no escribir un
  secreto en la base de datos: `cron.job.command` es texto plano y `cron.job_run_details` guarda una
  copia del comando de cada ejecución. El endpoint público no necesita ninguno, y aun así no es una
  puerta abierta, porque `src/app/api/sync/route.ts` pone las dos condiciones que lo cierran: exige
  `content-type: application/json` (que es lo que `pg_net` manda siempre, y lo que descarta un POST
  de formulario de otro sitio) y lleva un **candado global de 5 minutos** (clave
  `public/manual-sync`, definido en
  [`src/lib/manual-sync.ts`](../src/lib/manual-sync.ts)). Con eso, ni este job ni quien descubra la
  URL pueden provocar más de una pasada por ventana. Y el candado es **compartido con la llamada
  manual de `/admin`**: si un admin sincroniza dentro de la ventana, el cron recibe
  `{"status":"cooldown"}` con 200 y no duplica trabajo, y al revés. Y le pasa también **sin nadie
  delante**: el job dispara en punto y el candado de la pasada anterior expira unos segundos después
  de su propio multiplo, así que de vez en cuando el cron llega demasiado pronto y esa vuelta se
  salta sola (medido: 1 de cada 5 pasadas). No es un fallo, es el precio de reutilizar el candado
  en vez de llevar un secreto en la base de datos; la cadencia real queda entre 5 y 10 minutos.
- **El nombre del job es fijo** (`ligahispana-sync`) porque `cron.schedule(nombre, ...)` hace *upsert*
  sobre `jobname_username_uniq`: repetir el script actualiza el job existente en vez de crear un
  segundo.
- **`timeout_milliseconds` va explícito a 240 s** porque el valor por defecto de `net.http_post` son
  2-5 s y una pasada tarda ~15 s: con el valor por defecto la petición se cortaría antes de que el
  Worker terminara.
- **`pg_net` se instala en `extensions`**, no en `public`: es donde lo pone Supabase y es lo que
  evita el aviso del *Security Advisor*.

`SITE_URL` sale del entorno y por defecto es
`https://ligahispana-aoe4.javierr-ma93.workers.dev`; no hace falta definirlo mientras el dominio no
cambie.

**Cómo se comprueba que está disparando.** `npm run db:cron -- --check` imprime las dos extensiones
con su versión y esquema, el `jobid`, el `schedule` y el comando tal cual están grabados, el resto
de jobs de la base, y las **tres últimas respuestas de `pg_net`** con su código, su hora y su cuerpo
(se guardan 6 h). El cuerpo es lo que separa los dos casos que comparten `200`: `"status":"ok"` es
una pasada de verdad y `"status":"cooldown"` quiere decir que alguien —el cron anterior o la llamada
manual de un admin— usó antes el candado dentro de la ventana. Un `error` o un `sin respuesta
(timeout)` en `net._http_response` significa que la petición no salió de la base de datos. También
se puede mirar `cron.job_run_details` desde el panel de Supabase y `net._http_response` en el *SQL
Editor*.

**Vuelta atrás**: `npm run db:cron -- --remove` desprograma el job y deja las extensiones, que son
inertes. Es reversible y repetible: si el job no está, lo dice y no rompe.

Comprobado contra la base de datos real (septiembre de 2026): a través del *Session pooler* de
Supabase funcionan `create schema`, `create extension`, `cron.schedule(nombre, ...)` y
`cron.unschedule(nombre)`, y el job se crea, se lee y se borra. El pooler no da ningún problema aquí.

Lo único que queda por mirar en vivo es que `cron.use_background_workers` está en **`off`** en este
proyecto (es lo que trae Supabase), así que cada ejecución del job **abre una conexión nueva a
`cron.host`**, que es `localhost`. Debería funcionar, pero si algún día dejara de poder abrirse el
job se programarían igual, no daría ningún error, y solo se vería en `cron.job_run_details`. Por eso
`--check` imprime ese ajuste.

## Ver si el sincronizador está vivo

Que el cron dispare **no** es lo mismo que el sincronizador funcione. `net.http_post` encola la
petición y devuelve; no espera al Worker ni mira lo que conteste. Un Worker que no levanta, una base
de datos que no responde o un `profileId` mal escrito producen el mismo `200` y el mismo "todo bien"
en `cron.job_run_details`. Por eso el `200` del cron no vale como prueba, y por eso el rastro va
aparte.

Cada pasada deja su rastro en `Setting["sync.lastRun"]`: contadores, reintentos, pausas por límite de
peticiones, el error de la ladder, el error del recálculo, el de la detección de directos y **los
jugadores que no se pudieron sincronizar con el motivo literal** de la API. Se escribe al final de
`syncApprovedPlayers()`, así que lo hacen todas las vías por igual: el cron de Supabase, la llamada
manual de un admin, `npm run sync` y el alta desde el panel.

Ese rastro se lee con `getSyncHealth()` y se enseña como aviso en **`/admin`**, la pestaña donde se
trabaja: enterarse al entrar y no acordarse de mirar otra pantalla. El aviso lleva **en línea** el
motivo de cada jugador que no se pudo sincronizar, porque sin el texto literal de la API no sirve de
nada: no dice si hay que corregir un `profileId` en el panel o solo esperar a que AoE4World deje de
limitar.

**No va en `/admin/alertas`**, y no por descuido: esa pestaña es para comportamientos anómalos de los
participantes, no para salud de un proceso. Meter el estado del sincronizador allí sería ocupar con
datos de sistema el sitio donde viven las alertas de jugador.

Tres estados que se distinguen a propósito, porque confundirlos es lo que hace que un fallo parezca
sano:

- **Sin rastro**: no es "todo bien", es que nunca se ha escrito una pasada. La pestaña lo dice así.
- **Pasada a medias** (`degraded`): algún jugador falló, la ladder no se refrescó o no se pudo
  recalcular. La web pública puede estar enseñando una clasificación vieja.
- **Pasada vieja** (`stale`): no se escribe ninguna desde hace más de `SYNC_STALE_MINUTES` (20). Es
  el estado que detecta al Worker sin entrar, donde no hay nada nuevo que leer. La ventana es holgada
  a propósito porque el cron dispara cada 5 minutos y una pasada tarda unos segundos.

El rastro arrastra además `lastSuccessAt`, que **no avanza cuando una pasada sale a medias**: es lo
que contesta «¿desde cuándo está roto?» durante una racha de fallos. Sin él, un rastro siempre
fresco y siempre roto diría que no pasa nada.

**Lo que no hay** es histórico de pasadas. Enseñar la última y el marcador de la última buena
responde a «¿está roto ahora y desde cuándo?», que es lo que hace falta para actuar; una serie
pertenece a `ScoreSnapshot`, que sigue diferido.

## El límite de CPU del plan Free

Esto no es una preferencia, es la restricción que manda, así que conviene tenerlo medido y escrito.

En el plan **Free**, Cloudflare da **10 ms de CPU por invocación**, y cuenta igual en una petición
HTTP que en un Cron Trigger. Una pasada del sync gasta del orden de **500 ms de CPU** (Prisma con su
*query compiler* en WASM, el parseo del JSON de la API y el recálculo de la puntuación): unas **50
veces** el presupuesto.

Cada *isolate* tolera que una invocación se pase del límite **de forma esporádica**; lo que no tolera
es que se pase de forma consistente, y entonces la mata con `Worker exceeded CPU time limit.` (error
1102). Medido: con un Cron Trigger nativo cada 5 minutos (que se probó y se retiró, commit `459ed27`)
el *isolate* aguantó una hora y a partir de ahí mató **todas** las pasadas — 44 errores en una hora,
ni un solo sync terminado. Con el workflow de GitHub, que GitHub retrasa a cada 4-6 h, el exceso es
esporádico y pasa. La falta de puntualidad de GitHub, que es lo que llevó a buscar el cron nativo,
resulta ser también lo que mantiene el sync dentro de lo que el *isolate* tolera.

**Supabase Cron no cambia el presupuesto, cambia la cuenta.** La hipótesis detrás de `npm run db:cron`
es que el fallo anterior no lo causaba el volumen sino el *self-fetch* del Cron Trigger nativo (dos
invocaciones sobre el mismo *isolate*): con un disparo HTTP externo hay **una sola invocación por
evento**, con nada que la comparta. La primera hora de prueba la respalda: entre las 16:05 y las
17:05 UTC del 29-sep-2026, trece pasadas disparadas por `pg_cron`, todas con `200` y **cero** `Worker
exceeded CPU time limit`, con la CPU por pasada en 589 ms de media y 852 ms de máximo. **No es una
garantía** —el Cron Trigger nativo también aguantó una hora antes de empezar a morir—, así que
merece la pena mirar Workers Logs de vez en cuando: si el *isolate* vuelve a morir con 1102, la
conclusión es que el límite no perdona ni así, y toca el plan Paid.

De ahí las dos consecuencias:

- **Un sync cada 5 minutos de verdad necesita el plan Workers Paid** ($5/mes): el presupuesto sube a
  30 s por Cron Trigger y 5 min por petición, y el mismo código sobra. Si algún día se sube, el
  camino ya está andado: el *handler* `scheduled` sobre un *custom worker* de OpenNext
  (["Custom Worker"](https://opennext.js.org/cloudflare/howtos/custom-worker)) funcionó; lo que no
  cabía era la CPU, no el mecanismo.
- **Mientras se siga en Free**, la llamada manual que hace un admin desde `/admin` dispara el mismo
  trabajo y está sujeta a lo mismo: pasa cuando es esporádico. Por eso su candado es de **5 minutos**
  y no de uno —y por eso comparte ese mismo candado con el job de Supabase Cron en vez de tener el
  suyo, y con el endpoint `/api/sync` que usa el cron—: en Free, insistir es lo único que garantiza
  que Cloudflare empiece a matar pasadas.

## Inscripción pública

`/participar` es un endpoint público y sin autenticación, así que la Server Action `registerPlayer`
(`src/app/(public)/participar/actions.ts`) tiene cinco capas, en este orden:

1. **Campo trampa** (`website`): no escribe nada y devuelve la misma confirmación que un alta bueno,
   para que un bot no pueda aprender a esquivarla.
2. **Límite de frecuencia por IP** (`src/lib/rate-limit.ts`): cuenta en Postgres, con la IP
   **hasheada** (HMAC-SHA-256 con `RATE_LIMIT_SALT`, nunca en claro), en una ventana fija. El
   incremento es un `INSERT ... ON CONFLICT DO UPDATE` de una sola sentencia, así que el despliegue
   serverless no lo evita y dos envíos simultáneos se serializan. Sin IP identificable
   (`x-forwarded-for` / `x-real-ip`) cae a un cubo compartido `global`. Por defecto, 5 envíos por hora
   y IP.
3. **Captcha** (Cloudflare Turnstile, `src/lib/turnstile.ts`): cierra el hueco que el límite no puede,
   que es rotar `x-forwarded-for` detrás de un proxy que la reenvía sin reescribir. Verifica el token
   del campo `cf-turnstile-response` contra `siteverify`, **falla cerrado** (si no se puede
   comprobar, el envío no pasa) y **se desactiva solo si no hay `TURNSTILE_SECRET_KEY`**, para que el
   proyecto funcione sin configurar nada. La site key (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`) la usa el
   componente cliente; los dos nombres del contrato están en `src/lib/turnstile-contract.ts`.
4. **Validadores de los campos** compartidos con el alta de admin (`src/lib/player-input.ts`) y
   comprobación de la fila existente: lo sale gratis y no gasta API. El **correo es obligatorio** y se
   guarda en `Player.contactEmail`, para que la organización pueda responder dudas.
5. **Comprobación del perfil** (`src/lib/registration.ts`): `GET /players/:id` con un presupuesto de
   8 s. Un 404 es un error de campo en `profileId`; cualquier otro fallo (red, 429, timeout) **no**
   crea nada y devuelve un mensaje reintentable. Si el perfil existe, se guarda el nombre oficial en
   `Player.aoe4WorldName` y `Player.name` conserva el de display que escribió la persona.

El resultado siempre se deja en `PENDING`: aprobar o rechazar es decisión de la organización. Lo único
que se **reescribe** es un envío de un perfil que estaba `REJECTED`: actualiza esa misma fila (nombre,
canal, correo, nombre oficial y retrato) y la devuelve a `PENDING`, en vez de crear una segunda
solicitud. Un perfil `APPROVED` o `PENDING` sigue bloqueando el envío.

## Alertas de comportamiento

El motor vigila **comportamientos anómalos de los participantes** sobre las partidas clasificatorias ya
guardadas, y deja una fila por alerta en la tabla `Alert`. Las ocho reglas, sus umbrales y el modelo de
datos están en [`docs/PLAN.md`](./PLAN.md#f9--motor-de-alertas-de-comportamiento-).

```bash
npm run verify:alerts              # 53 comprobaciones puras, SIN base de datos
npm run alerts:check                # evaluación completa + resumen por consola
npm run alerts:check -- 6000037     # solo esos profileId
npm run alerts:cutoffs              # deriva o refresca los cortes de división (rm_solo y rm_team)
npm run alerts:cutoffs -- --ladder=rm_team   # solo una ladder
npm run alerts:cutoffs -- --show    # solo enseña los cortes cacheados
```

**Cuándo se evalúa.** Colgado del sincronizador, cada 5 minutos: en `syncApprovedPlayers()`,
después de `recomputeScores()`, se evalúan **solo los jugadores tocados** en la pasada, y en una
pasada sin novedades no se lee ni una fila de `Match`. También se reevalúa a un jugador cuando el
panel **revierte o restaura** una partida (su conjunto de clasificatorias ha cambiado), se evalúa
entero cuando la ventana del torneo ha terminado (`Setting["alerts.tournamentClose"]` lo marca para
no repetirlo en cada pasada), y a mano con `npm run alerts:check`. El resultado va en el resumen del
sincronizador (`alerts` y `alertsError` de `SyncSummary`) y en `Setting["sync.lastRun"]`; un fallo
del motor de alertas **no** mueve el `lastSuccessAt` del rastro, porque no ha parado ni una partida.

**El informe del panel hace una comprobación completa antes de generarse.**
`GET /admin/alertas/reporte` (detrás de `requireAdmin()`) es el botón de la pestaña y devuelve un CSV
para Excel con dos bloques —alertas disparadas y rachas abiertas en curso—, con la ventana del
torneo, la versión del ruleset y la fecha de generación en la cabecera. Antes llama a
`evaluateAlerts({ full: true })` (idempotente) para que describa el estado recién calculado y no el
de la última pasada del sincronizador.

**Cero llamadas nuevas a la API al evaluar.** Todo sale de `Match` y de su `rawJson`. La única
excepción es la derivación de los **cortes de división** que necesita la regla R5, y no la hace el
motor: se cachean en `Setting["alerts.divisionCutoffs"]` y se derivan a mano. Es trabajo de una sola
vez —con búsqueda binaria sobre la ladder, **151 peticiones** para `rm_team` (50 847 jugadores, 1 017
páginas) y **130** para `rm_solo` (23 735, 475) en septiembre de 2026— porque la API ignora en
silencio `rating_min`, `rating_max` y `rank_level` y no hay más forma de saber a partir de qué rating
empieza cada subdivisión. Sin cortes cacheados, **R5 se omite con un aviso** y las otras siete reglas
siguen funcionando; `alerts:check` lo dice y recuerda el comando para derivarlos.

**Idempotente por construcción**: el motor inserta solo lo que no está, con
`createMany({ skipDuplicates: true })` sobre el `dedupeKey` único de cada alerta. Repetirlo con los
mismos datos no crea nada, así que `npm run alerts:check` dos veces seguidas es también la forma de
comprobar que el dedupe no se ha roto. Los **umbrales** son configurables sin desplegar en
`Setting["alerts.ruleset"]` (versión 1, con `DEFAULT_ALERTS_RULESET` de respaldo); `window` y `modes`
**no** se duplican ahí: se leen del ruleset de puntuación, y el filtro de clasificatorias es el mismo
`rankedMatchWhere()` que usa el motor de puntos.

## Simulaciones

### Simulación con fixtures (mock de AoE4World)

Para ver `/` y `/partidas` poblados sin depender de la API real y sin gastar cuota de *rate limit*
existe un modo mock, **opt-in** y solo para desarrollo. `AOE4WORLD_MOCK=1` intercepta el único punto
de salida HTTP, `performRequest()` en `src/lib/aoe4world/http.ts`, y responde con las fixtures
locales de `src/lib/aoe4world/mock/` en lugar de salir a la red. Los parsers, el worker y el motor de
puntuación son exactamente los mismos, así que la simulación ejercita el código real. Con el flag
activo y `NODE_ENV=production`, la configuración falla al arrancar: el mock no puede estar activo en
producción. Por defecto (`0`) no hay ningún cambio de comportamiento.

```bash
npm run mock:tournament  # crea o actualiza el torneo simulado y sincroniza
npm run mock:clean       # retira exactamente lo que crea la simulación
```

`npm run mock:tournament`:

- Crea o actualiza los **10 participantes** del torneo simulado como `APPROVED`, con `profileId` en
  el rango reservado `90000001`–`90000010` (no se solapa con perfiles reales ni con el jugador de
  prueba de `verify:sync --db`).
- Sincroniza **solo esos perfiles**: no toca ni le pide nada a ningún otro jugador aprobado que haya
  en la base, y al final recalcula la clasificación.
- Resultado: **127 filas de partida** (71 partidas distintas: 68 terminadas y 3 en directo), de las
  que **122 están resueltas** con resultado informado. Los 3 directos dejan **5 filas** con
  `finishedAt` a `null`: una sola en el cruce contra un rival externo y dos por cada cruce entre
  participantes. Además, **10 puntuaciones distintas** entre sí, **5 canales de Twitch**, **4 de
  YouTube** y **3 de Kick**, con alguien en directo en cada una de las tres plataformas (el script
  los planta: la detección de YouTube y Kick está apagada en la simulación para no tocar ninguna API
  externa).
- **Rivales externos**: el calendario incluye partidas contra gente de la ladder que no juega la
  liga, con `profileId` en el rango reservado `92000001`–`92000010`: **20 terminadas** (dos por
  participante, una ganada y una perdida, que dejan los totales separados entre sí) y **1 de los 3
  directos** (Serrano Hernández contra Brazo de Plata). Esos rivales **no** se convierten en filas
  `Player`: solo aparecen como `opponentProfileId` / `opponentName`, igual que en la base real. En la
  base quedan 21 filas con `opponentProfileId` ajeno a la liga.
- Es **idempotente**: se puede lanzar N veces seguidas sin duplicar partidas ni acumular basura.

`npm run mock:clean` borra exactamente esos 10 jugadores (la cascada del schema borra sus `Match` y
`PlayerScore`) y sus cursores `Setting` (`aoe4world.sync.player.<profileId>`), sin tocar nada ni
nadie más de la base de datos, y **comprobando antes que las filas son las del mock** (coinciden
`profileId`, nombre y canal con `src/lib/aoe4world/mock/players.ts`): si algo no cuadra, no borra
nada.

> **Aviso**: el cron `POST /api/cron/sync` también respeta el flag. Si activas el mock en local con
> jugadores reales aprobados, esos perfiles recibirán 404 del mock (no existen en las fixtures); por
> eso el script acota la pasada a los perfiles del torneo simulado.

Cómo se sostiene en el tiempo: el histórico de partidas terminadas está anclado a una **epoch fija**,
así que no se mueve entre ejecuciones, y las **3 partidas en vivo** recalculan su `started_at` como
"hace 10–20 minutos" en cada petición. De ese modo nunca salen de la ventana de 60 minutos que
define "en directo" ni se borran por abandonadas, aunque la simulación repose días.

### Torneo simulado con jugadores reales (API de verdad)

`mock:tournament` usa fixtures. Esta otra simulación mete en la base de datos **gente real de la
ladder de AoE4World**, con sus partidas reales, para probar la web con datos de verdad sin esperar al
torneo real.

```bash
npm run simulate:tournament                    # elige, da de alta, importa la ventana y recalcula
npm run simulate:tournament -- --select-only   # solo elige y lo informa (no toca la base de datos)
npm run simulate:tournament -- --max-candidates=30 --max-pages=6   # más margen para divisiones difíciles
npm run simulate:clean                         # deshace lo que creó
npm run simulate:clean -- --dry-run            # comprueba qué borraría, sin borrar nada
```

- **Quién entra**: un jugador por división (`src/lib/divisions.ts`) con **más de 20 partidas de
  ladder (`rm_solo`) en los últimos 14 días**, contadas con el mismo criterio con el que se importan
  (`normalizeGame`), así que el número del informe es el número de filas que acaban en la tabla.
- **Cómo se los busca**: la API **ignora** `rating_min`/`rating_max` y `rank_level` (devuelven
  siempre la página 1), así que no hay forma de pedir "los bronces". El script recorre la ladder por
  páginas con **búsqueda binaria** sobre la monotonía de las divisiones (~49 llamadas en vez de las
  461 que tiene `rm_solo`), lee las primeras páginas de cada bloque y valida candidatos de uno en
  uno. Se eligen por orden de ladder dentro de la división, así que el reparto es siempre el mismo
  mientras la ladder no se mueva.
- **Ventana**: el torneo simulado son 4 semanas de las que ya han pasado 3. El script **siembra el
  cursor de sincronización** de cada jugador en el arranque del torneo en vez de dejar que el worker
  recorra el histórico entero (miles de partidas que no cuentan), y a partir de ahí el cursor avanza
  con normalidad: la simulación **sigue creciendo** con cada pasada real del cron.
- **Elo, división, racha y avatar** no se rellenan en el alta: los deja `syncLadderSnapshot`, el
  mismo paso que usa el worker con todos los jugadores aprobados.
- **Coste**: ~90 llamadas a la API y unos 40 s (49 de búsqueda binaria + 18 de páginas + ~24 de
  conteo de partidas), más ~17 llamadas y ~6 s para importar la ventana. Resultado medido en
  septiembre de 2026: 415 filas importadas.
- **Idempotente**: repetirlo no duplica jugadores ni partidas, no resetea el cursor hacia atrás y
  vuelve a imprimir la misma clasificación.

#### Cómo se deshace (importante)

La base de datos es la de producción y dentro de un mes contendrá los participantes de verdad, así
que **no hay ningún rango de `profileId` reservado** que marque las filas de esta simulación. Lo que
la marca es el **manifiesto** que el script escribe en `Setting["simulation.roster"]`: la lista de
jugadores que dio de alta, con la identidad usada en el momento (`profileId`, nombre, división, fecha
de la ventana).

`npm run simulate:clean`:

1. Lee el manifiesto. Si no hay manifiesto, no borra nada y lo dice (no adivina).
2. **Comprueba la identidad de cada fila** contra el manifiesto antes de tocar nada: si el número de
   filas no cuadra, si algún `profileId` no está en el manifiesto o si **el nombre de la fila no es
   el que escribió la simulación** (por ejemplo, porque alguien lo editó en `/admin`), **aborta y no
   borra**.
3. Avisa (sin abortar) de los jugadores que quedaron de una ejecución anterior y de las partidas que
   caen fuera de la ventana del torneo, porque el borrado en cascada se las llevaría por delante.
4. Solo entonces borra: los jugadores dados de alta (y en cascada sus `Match` y `PlayerScore`), sus
   cursores `aoe4world.sync.player.<profileId>` y el propio manifiesto. Las partidas en las que esos
   jugadores eran **rivales** de otros no se tocan: son de otros.

Use `--dry-run` antes si quiere ver el plan sin ejecutar nada. Y si el manifiesto llegara a perderse,
el borrado hay que hacerlo **a mano**: es preferible a borrar filas de participantes reales.
Verificado en septiembre de 2026 con una fila alterada a mano: abortó, y tras `simulate:clean` la base
quedó con 0 jugadores, 0 partidas, 0 puntuaciones y 0 cursores.

## Verificación

```bash
npm run verify:sync          # normalización con datos de ejemplo (no necesita BBDD)
npm run verify:sync -- --db  # además comprueba el guardado y borra lo que crea
```

`--db` necesita `DATABASE_URL` y trabaja con un jugador de prueba (`profileId` 9000001) que **borra al
terminar siempre, incluso si una comprobación falla**, así que se puede repetir tantas veces como
haga falta. Solo hay un caso en el que se niega a arrancar: que ese jugador ya exista porque una
ejecución anterior murió antes de poder limpiarlo; entonces avisa y para para no pisar datos ajenos.
Borrarlo con `npm run simulate:clean` no sirve (es de otra simulación), así que se borra desde
`/admin/jugadores` o a mano por su `profileId`.

## Cuando la base de datos no responde

Un corte puntual de la base (límite de conexiones de Supabase, un reinicio, un pico de red) no puede
ser un 500 con una traza en el log: la web del torneo tiene que seguir contestando y decir que no ha
podido leer. Las lecturas de `src/lib/public.ts` y `src/lib/scoring.ts` devuelven por eso un
discriminante en vez del dato pelado:

```ts
type PublicRead<T> = { status: "ok"; data: T } | { status: "degraded"; data: null };

const { status, data } = await getStandings(); // StandingRow[] | LiveMatch[] | ObjectiveView
```

- `status: "ok"` → `data` es el valor de siempre y la pantalla se pinta como ahora.
- `status: "degraded"` → `data` es **`null`**, y a propósito **no** una lista vacía: un vacío se
  leería como "no hay participantes" o "no hay partidas en juego ahora mismo", que es una afirmación
  falsa. Quien pinte tiene que distinguir los dos casos y decir que no se ha podido leer.

El motivo del fallo **no** viaja en el objeto: esto se serializa al navegador dentro del *payload* de
RSC. Se queda en el log del servidor, con el prefijo `[db]` y el `scope` de la lectura, por ejemplo:

```
[db] public/getStandings: PrismaClientKnownRequestError (P1001): Can't reach database server at db.abc.supabase.co
```

El mensaje va saneado: se elimina el usuario y la clave de cualquier URL de conexión y los
parámetros `password=`, y se conserva el *host*, que es lo que hace falta para diagnosticar. Los
scripts de `scripts/` y `verify:sync --db` usan `unwrapRead()` de `@/lib/db-errors`, que **aborta** en
vez de devolver vacío: una comprobación que se traga un corte de la base y sale con "todo correcto" es
peor que no comprobar nada.

## Requisitos operativos de un despliegue

En orden, sobre la base de datos que usa el Worker:

```bash
npm run db:push                  # sincroniza el schema
npm run db:security -- --check   # comprueba la postura de RLS; aplica el script si sale mal
npm run countries:seed           # publica la lista de países del formulario de inscripción
npm run db:window                # publica la ventana de fechas del torneo (opcional pero recomendado)
npm run db:cron                  # programa el job de sincronización cada 5 minutos
```

- `db:security` es obligatorio **después de cada `db:push` que añada tablas**: `prisma db push` no
  gestiona RLS ni GRANTs, y una tabla nueva nace con los permisos por defecto de Supabase en
  `public`, sería legible con la clave publicable por la Data API y no quedaría en ninguna parte del
  repositorio. Detalle en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md) §7.
- `countries:seed` siembra `Setting["registration.countries"]` desde `paises.txt`. Sin ella el
  formulario de inscripción no tiene la lista de países que admite el torneo.
- `db:window` publica `window` en `Setting["scoring.ruleset"]`. Es opcional, pero mientras no
  exista la clasificación puntúa con las fechas **de prueba** del código (15-sep-2026 a
  15-oct-2026): el 15 de octubre `startedAt < to` deja de cumplirse para todo lo nuevo y la
  clasificación se congela en silencio, sin error ni aviso.
- `YOUTUBE_API_KEY` en el panel del Worker (Settings → Variables and Secrets) es **opcional**: sin ella
  la detección de YouTube no se hace (ni una petición) y `Player.youtubeIsLive` se queda en `false`
  con un aviso en el rastro de la pasada. El detalle de los tres canales está en
  [`docs/PLAN.md`](./PLAN.md#f10--youtube-y-kick-en-el-tratamiento-de-canales-de-directo-).

Lo que hay que poner en el panel del Worker (secretos, `NEXT_PUBLIC_*` también en *Build variables
and secrets*, y el paso de Hyperdrive) está en
[`docs/DESPLIEGUE.md`](./DESPLIEGUE.md#publicar).
