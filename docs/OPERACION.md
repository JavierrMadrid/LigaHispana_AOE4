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
       url := 'https://laligahispana.es/api/sync',
       body := '{}'::jsonb,
       headers := '{"Content-Type": "application/json"}'::jsonb,
       timeout_milliseconds := 240000
     );$$
);
```

La URL de `url :=` es el valor por defecto de [`scripts/db-cron.ts`](../scripts/db-cron.ts), y por qué
ese valor es el que es está en [Cuándo cambia el reloj de dominio](#cuándo-cambia-el-reloj-de-domino).

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

### El reloj del torneo y el cambio de dominio

El job dispara contra `https://laligahispana.es/api/sync`. `SITE_URL` sale del entorno y, si no está,
sale el valor por defecto de [`scripts/db-cron.ts`](../scripts/db-cron.ts), que ya es ese mismo.

**Hubo un momento en que ese valor por defecto era `workers.dev`, y el cambio se hizo a posteriori a
propósito.** La zona de `laligahispana.es` estuvo `pending` varias horas (los nameservers no llegaban al
TLD `.es`), así que el dominio no resolvía. Adelantarlo habría sido mandar cada pasada a un sitio
que no contesta, y ese fallo es **invisible donde se mira primero**:

- **`cron.job_run_details` seguiría dando `200`.** `net.http_post` encola la petición y devuelve; no
  espera al Worker ni mira lo que conteste.
- **El síntoma real llegaba veinte minutos después**: como ninguna pasada terminaba,
  `Setting["sync.lastRun"]` envejecía y `/admin` enseñaba **pasada vieja** (`stale`) (ver
  [Ver si el sincronizador está vivo](#ver-si-el-sincronizador-está-vivo)), con la clasificación
  congelada y sin el dato de que la causa era el nombre del dominio.
- **Revertirlo no era local**: había que acordarse de que era eso y volver a lanzar el script.

Por eso el orden fue **build variable primero, reloj después**: los metadatos no rompen nada si fallan,
el reloj sí. Todo el razonamiento, y los tres pasos con su orden, están en
[`docs/DESPLIEGUE.md`](./DESPLIEGUE.md#lo-que-se-hizo-y-en-qué-orden).

**Para volver a cambiarlo** (a otro dominio, o para deshacer), con la zona nueva ya activa y
comprobando que `curl -I` contesta antes de tocar nada:

```bash
SITE_URL=https://laligahispana.es npm run db:cron
SITE_URL=https://laligahispana.es npm run db:cron -- --check   # el comando tiene que salir con el dominio
```

Es un **upsert** sobre `jobname_username_uniq`: reprograma `ligahispana-sync` con la URL nueva, no crea
un segundo job, y por eso se puede repetir sin miedo. Después hay que mirar la primera respuesta de
`pg_net` en `net._http_response`: `"status":"ok"`, y no un error de resolución de nombre.

**`SITE_URL` también al `--check`.** La comprobación compara el comando guardado con el que genera
**el `SITE_URL` del entorno**, así que si no se le pasa, avisa `REVISAR: el comando no es el de este
script` aunque el job sea correcto. Pasa la variable también ahí y el aviso desaparece.

**Y las variables hay que exportarlas antes.** Los scripts de `scripts/` arrancan con
`import "dotenv/config"`, que lee **`.env`**, y en este equipo lo que hay es **`.env.local`**
(no versionado). Sin exportarlas primero, `npm run db:cron` muere con `DATABASE_URL no está definida`:

```bash
set -a && . ./.env.local && set +a
SITE_URL=https://laligahispana.es npm run db:cron
```

Y ojo con que hay **dos** `SITE_URL` distintos: este (el del script, que solo se lee al programar el
job) y el del [workflow de GitHub](.github/workflows/cron-sync.yml), que es la *variable* del
repositorio en Settings → Secrets and variables → Actions → Variables. Ese segundo **sigue apuntando a
`workers.dev` y no hay que tocarlo**: es la red de seguridad del reloj primario, y conviene que sea el
que no depende de la zona, porque es el único que seguiría funcionando si el dominio se cayera.

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
(`src/app/(public)/participar/actions.ts`) tiene cinco capas contra el abuso y un requisito de
producto, en este orden:

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

Y entre la 3 y la 4, como **requisito y no como capa de defensa**, el **paso de Discord** (F12): si
`isDiscordOAuthConfigured()` es `true` se lee y verifica la cookie `discord_link` y, sin ella, sale un
error de campo `discord` sin escribir nada. Va ahí porque es gratis (leer una cookie y verificar una
firma no sale a nada) y porque `discordUserId` se escribe en la misma línea que el nombre: sin él no
hay nada que guardar. Los pasos están en [Discord obligatorio (F12)](#discord-obligatorio-f12).

El resultado siempre se deja en `PENDING`: aprobar o rechazar es decisión de la organización. Lo único
que se **reescribe** es un envío de un perfil que estaba `REJECTED`: actualiza esa misma fila (nombre,
canal, correo, nombre oficial y retrato) y la devuelve a `PENDING`, en vez de crear una segunda
solicitud. Un perfil `APPROVED` o `PENDING` sigue bloqueando el envío.

## Discord obligatorio (F12)

La inscripción de `/participar` **exige** conectar la cuenta de Discord cuando el OAuth
está configurado. No hay campo de texto: hay un botón que va a la pantalla de permisos
de Discord y vuelve con la identidad en una cookie firmada. El detalle del diseño está
en [`docs/PLAN.md`](./PLAN.md#f12--discord-obligatorio-y-pertenencia-al-servidor-entrega-2).

**Sin credenciales el paso no existe**, no falla: `isDiscordOAuthConfigured()` es `false`,
el formulario no pinta el botón y la acción no exige la cookie. Es el mismo patrón que el
captcha con `TURNSTILE_SECRET_KEY`. **En producción las credenciales son obligatorias**, y
si falta alguna de las cinco (o el secreto de firma) lo que se ve es un formulario de
inscripción sin el paso y un aviso `[discord]` en el log.

### Las variables, y dónde va cada una

| Variable | Para qué | ¿Obligatoria? |
|---|---|---|
| `DISCORD_CLIENT_ID` | Client ID de la aplicación OAuth2 | Sí, en producción |
| `DISCORD_CLIENT_SECRET` | Canje del `code` por un token | Sí, en producción. **Nunca** en el cliente ni en un log |
| `DISCORD_BOT_TOKEN` | `Authorization: Bot …` del auto-unión y de la comprobación de pertenencia | Sí, en producción |
| `DISCORD_GUILD_ID` | Servidor del torneo | Sí, en producción |
| `DISCORD_OAUTH_SECRET` | Firma de la cookie `discord_link`. Sin ella se usa `CRON_SECRET`; **no hay valor de respaldo en el código** | Sí, en producción |
| `DISCORD_REDIRECT_URI` | URI de redirección registrada en Discord. Si falta, se deriva del origen de la petición + `/api/discord/oauth/callback` | No, pero conviene fijarla en producción |
| `DISCORD_INVITE_URL` | Invitación de respaldo cuando el auto-unión falla | No |
| `DISCORD_API_BASE`, `DISCORD_TIMEOUT_MS`, `DISCORD_USER_AGENT` | Base, presupuesto y `User-Agent` del cliente | No (valores por defecto) |
| `DISCORD_CHECK_MAX_PER_RUN` | Tope de cuentas comprobadas por pasada en el worker. Por defecto 10 | No (valor por defecto) |
| `DISCORD_ROSTER_MAX_PAGES` | Páginas de `GET /guilds/{guild_id}/members` por refresco de la lista de miembros (mil por página). Por defecto 20. Alcanzarlo **sin** haber visto la última página hace que la lista se descarte: se vuelve a la comprobación por cuenta | No (valor por defecto) |
| `DISCORD_ROSTER_TTL_HOURS` | Horas que se cachea la lista de miembros del servidor. Por defecto 12, igual que el veredicto por jugador pero **por separado**: uno es un dato compartido y el otro uno por fila | No (valor por defecto) |

Van en el panel del Worker (Settings → Variables and Secrets) **y además** en *Build
variables and secrets* del trigger, que es otra lista distinta (ver
[`docs/DESPLIEGUE.md`](./DESPLIEGUE.md#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables)).
Los secretos van como **secretos**, no como *vars*.

### Los pasos manuales, una sola vez

1. **Crear la aplicación** en el [portal de Discord para desarrolladores](https://discord.com/developers/applications)
   (OAuth2 → General Information): client id y client secret. El secret **solo se muestra
   una vez**; es el `DISCORD_CLIENT_SECRET`.
2. **OAuth2 → Redirects**: añadir `https://laligahispana.es/api/discord/oauth/callback`
   (y el del `*.workers.dev` del Preview si se prueba ahí). Con `DISCORD_REDIRECT_URI`
   definida tiene que ser exactamente la misma cadena.
3. **OAuth2 → Scopes**: añadir `identify` y `guilds.join`.
4. **Crear el bot** (Bot → Add Bot) y copiar su token: es el `DISCORD_BOT_TOKEN`. Es el
   mismo token que se puede "Regenerate"; si se regenera, hay que actualizar la variable.
5. **Invitar el bot al servidor** con el **bot** autorizado y con el permiso
   `CREATE_INSTANT_INVITE` en el contexto `Use Application Commands` / al añadirlo, o
   granting scopes afterwards. Sin ese permiso el `PUT …/members/{user_id}` responde 403
   y **el paso no bloquea**: la inscripción se acepta con `joined: false` y el
   formulario enseña `DISCORD_INVITE_URL`.
6. **Abrir el servidor al bot** con la opción que lo deja ver la lista de miembros (o
   darle el rol que corresponda). Es lo que necesita la comprobación de la entrega 2
   (`GET /guilds/{guild_id}/members/{user_id}`).
7. **Activar el intent privilegiado `GUILD_MEMBERS`** (Bot → Privileged Gateway Intents →
   **SERVER MEMBERS INTENT** → Save Changes). Es **manual** y no se puede pedir por API,
   y es lo que hace que el worker pueda leer la **lista de miembros del servidor**
   (`GET /guilds/{guild_id}/members`), que es lo que comprueba a todos de una vez y lo que
   **enlaza la cuenta de las altas de admin** a partir de su `@usuario`. Sin este paso el
   sistema funciona igual, pero por el camino corto: ver "Sin lista de miembros" más
   abajo. El botón desaparece solo en servidores de más de cien miembros; es un límite
   de Discord y no hay que hacer nada.
8. Copiar el **id del servidor** (Developer Mode → clic derecho sobre el servidor →
   "Copiar id de servidor") al bot: es el `DISCORD_GUILD_ID`.

### Si algo falla, dónde se mira

- El log del Worker, con el prefijo `[discord]`. **El motivo nunca va en la URL**: el
  callback solo redirige a `/participar?discord=ok|cancel|error|no-config`, y
  `?discord=no-config` no dice qué variable falta.
- Un `?discord=error` casi siempre es el `state` (cookie caducada o viaje empezado en
  otro navegador) o un canje rechazado (`invalid_grant`, que pasa cuando el `code` ya se
  usó o el `redirect_uri` no coincide con el registrado).
- Un `?discord=ok` con el formulario pidiendo la cuenta otra vez es una cookie caducada
  (20 min) o un enlace de invitación sin `DISCORD_INVITE_URL` definido.
- `discordUserId` o `discordUsername` duplicados en dos filas son imposibles por los
  índices únicos; lo que sí sale es el `P2002` en el envío o en el panel, con su propio
  mensaje.
- Un `P2002` de `discordUsername` al **inscribirse** casi siempre es un `@usuario` que la
  organización le escribió mal a otro participante al darlo de alta. El mensaje pide
  escribir por el correo: hay que mirar la fila del otro y corregir su `@usuario`.

### Sin lista de miembros

Es el estado normal **mientras no se haya activado el intent `GUILD_MEMBERS`**, y no es
un fallo: la comprobación por cuenta (`GET /guilds/{guild_id}/members/{user_id}`) **no lo
necesita** y sigue funcionando. Discord no da ningún error en ese caso —contesta `200`
con la lista vacía—, así que el worker lo trata como "no se ha podido comprobar":

| | Qué hace |
|---|---|
| Columnas | No escribe ni `discordInGuild` ni `discordCheckedAt` por la lista, ni ninguna alerta. Decir "no está en el servidor" con una lista vacía sería afirmar algo falso de todo el torneo |
| Comprobación | Cae a la consulta por cuenta para quien tenga `discordUserId`. Quien solo tenga `@usuario` (altas de admin) **no se comprueba** y sale como omitido, con su contador |
| Rastro | `discordError` lo dice en todas las pasadas: "sin lista de miembros (...)" con el motivo, y cuántos quedaron sin comprobar |
| `lastSuccessAt` | **No** se mueve. No saber si alguien sigue en el servidor no ha parado ninguna partida |

Para que las altas de admin se comprueben, hay que activar el intent (paso 7 de arriba);
no hay nada más que configurar. Y **un roster viejo no se usa como reserva**: si la
lectura falla, se vuelve a la consulta por cuenta, porque una lista a la que le falta la
mitad afirmaría "no está" de la mitad del servidor.

**Si la lista sale vacía pero el intent sí está activo**, mirar (a) que el token del bot
sea el de la aplicación correcta y no uno regenerado, (b) que el bot siga en el servidor,
y (c) el `DiscordError` del rastro, que trae la ruta y el estado y nunca el token.

### Requisito operativo

`npm run db:push` (las cuatro columnas de `Player`, el valor `DISCORD_NOT_IN_GUILD` de
`AlertRule` y el **`@unique` de `discordUsername`**). **No** hace falta
`npm run db:security`: no se crea ninguna tabla y las columnas nuevas heredan la postura
de `Player`.

**Si el `db push` falla con una violación de unicidad en `discordUsername`**, es que dos
filas anteriores al ajuste comparten nombre con el discriminador antiguo (`pepito#1234` y
`pepito#5678`), que sin él son el mismo `@usuario`. No es un despliegue roto: hay que
decidir qué fila se queda con el `@usuario`, **corregir o vaciar el de la otra por SQL**
con el panel cerrado, y repetir. Para verlo antes:

```sql
select lower(split_part(discord_username, '#', 1)) as canonico, count(*)
from "Player"
where discord_username is not null
group by 1
having count(*) > 1;
```

## Alertas de comportamiento

El motor vigila **comportamientos anómalos de los participantes** sobre las partidas clasificatorias ya
guardadas, y deja una fila por alerta en la tabla `Alert`. Las ocho reglas, sus umbrales y el modelo de
datos están en [`docs/PLAN.md`](./PLAN.md#f9--motor-de-alertas-de-comportamiento-).

```bash
npm test                      # el motor, con secuencias sintéticas y SIN base de datos
npm run alerts:check           # evaluación completa + resumen por consola
npm run alerts:check -- 6000037     # solo esos profileId
npm run alerts:cutoffs              # deriva o refresca los cortes de división (rm_solo y rm_team)
npm run alerts:cutoffs -- --ladder=rm_team   # solo una ladder
npm run alerts:cutoffs -- --show    # solo enseña los cortes cacheados
```

La parte que no necesita la base está en los tests de `tests/unit/lib/alerts/`: `compute.test.ts` (las reglas
sobre secuencias de partidas), `rules.test.ts` (umbrales, frases y claves de dedupe) y
`division-cutoffs.test.ts` (rating → subdivisión y lectura de la caché). Los tres pasan en `npm test`.

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
`rankedMatchWhere()` que usa el motor de puntos, más el corte de inscripción del jugador.

## Transparencia del historial de partidas

Las dos reglas de F11 (`HISTORY_NOT_PUBLIC` y `MISSING_LADDER_MATCHES`) se comprueban en
`syncApprovedPlayers()`, **después** del motor de alertas y antes de los directos, y su resultado va
al resumen (`history` y `historyError` de `SyncSummary`) y a `Setting["sync.lastRun"]`. El detalle de
las reglas está en [`docs/PLAN.md`](./PLAN.md#f11--transparencia-del-historial-de-partidas-).

**Cuesta muy poco, y es lo que hay que mirar si cambia.** La regla de la ladder es una agregación
por jugador sobre `Match` y **cero peticiones**: lee `Player.ladderGamesCount` y `ladderLastGameAt`,
que ya se rellenaban con el lote de ladder del principio de la pasada. La del historial es la única
que sale a la red, y su presupuesto es:

| Qué | Cuánto |
|---|---|
| Peticiones al **sitio** de AoE4World | un `HEAD` de 0 bytes por partida, **3 partidas** como mucho |
| Cada cuánto por jugador | una vez cada **12 h** (`HISTORY_CHECK_TTL_HOURS`, cacheado en `Player.historyCheckedAt`) |
| Cuántos jugadores por pasada | **6** (`HISTORY_CHECK_MAX_PER_RUN`); el resto sale como "para la siguiente pasada" |
| Con 30 participantes | menos de **5 peticiones al día** en total |

El tope por pasada **existe por el despliegue**: al activarlo todas las filas tienen
`historyCheckedAt = null`, así que la primera pasada tendría a todo el torneo venciendo la caché a la
vez. Con seis, se escalona en cinco pasadas (~25 minutos) y a partir de ahí el ritmo es de uno por
jugador cada 12 horas. Los seis por pasada sostienen ese ritmo hasta unos 860 participantes.

**No hay rate limit declarado en esa ruta y nadie nos ha dado permiso.** Es el mismo servidor que
sirve la API, así que se le habla con su mismo `User-Agent`. **Si el volumen creciera, lo que toca es
avisar a AoE4World por su Discord**, que es lo que pide su documentación antes de un uso de este
tipo; no subir el ritmo.

**Dónde mirar si deja de funcionar.** En el rastro de la pasada, `historyError`, que sale también en
el log como `[sync] Historial de partidas: …`. Es el sitio donde se ve el recuento ("6 comprobados, 1
cerrado"), cuántos quedaron para la siguiente pasada y el motivo de cada `unknown`. **No mueve el
`lastSuccessAt`**, igual que `alertsError` y `streamsError`: no saber si un participante tiene el
historial abierto no ha parado ni una partida. Un `unknown` —un timeout, un `5xx` o un error de
red— **no escribe nada** en `Player`: el jugador vuelve a la cola en la siguiente pasada.

Con `AOE4WORLD_MOCK=1` (la simulación de abajo) este paso **no sale a la red** y no escribe nada: la
ruta del sitio no tiene fixtures, y preguntar por los `profileId` de la simulación daría 404 para
todo, o sea, acusaciones contra jugadores que no existen. `syncApprovedPlayers({ history: false })`
lo apaga del todo.

## Pertenencia al servidor de Discord

La tercera regla de estado (`DISCORD_NOT_IN_GUILD`, F12) se comprueba en
`syncApprovedPlayers()`, **después** del historial y antes de los directos, y su resultado va al
resumen (`discord` y `discordError` de `SyncSummary`) y a `Setting["sync.lastRun"]`. El detalle de
la regla está en [`docs/PLAN.md`](./PLAN.md#f12--discord-obligatorio-y-pertenencia-al-servidor-entrega-2).

| Qué | Cuánto |
|---|---|
| Peticiones a la API de Discord, **con lista de miembros** | `ceil(miembros / 1000)` cada **12 h** (`DISCORD_ROSTER_TTL_HOURS`, cacheado en `Setting["discord.roster"]`), y **cero** en las pasadas donde el roster está al día |
| Peticiones a la API de Discord, **sin lista de miembros** | una por cuenta, `GET /guilds/{id}/members/{user}` con `Authorization: Bot …` |
| Cada cuánto por jugador | una vez cada **12 h** (`DISCORD_CHECK_TTL_HOURS`, cacheado en `Player.discordCheckedAt`) |
| Cuántos jugadores por pasada | **10** (`DISCORD_CHECK_MAX_PER_RUN`, ajustable con la variable de entorno del mismo nombre) |
| Con 30 participantes y el intent activo | **2 peticiones al día** en total (las dos de la lista de miembros), en vez de unas 60 |

**Se comprueba a quien tiene cuenta vinculada o `@usuario`.** El filtro es `APPROVED` y
(`discordUserId` **o** `discordUsername`) informado. A quien no tenga ninguno —filas
anteriores a F12 y el torneo simulado— no se le pregunta y **no se le avisa**: no hay nada
con qué preguntarle ni por quién. Con el roster es además donde se **resuelve** la cuenta
de las altas de admin, que solo tienen `@usuario`.

**Sin credenciales no se comprueba, y no es un fallo.** Si faltan `DISCORD_BOT_TOKEN` o
`DISCORD_GUILD_ID`, el paso no lee ni una fila de `Player`, no sale a la red y deja un aviso
permanente en `discordError`. Es el mismo patrón que la falta de `YOUTUBE_API_KEY` en los
directos, y el motivo es el mismo: si no sale en el rastro no hay ningún sitio donde se vea que
la comprobación lleva apagada.

**Dónde mirar si deja de funcionar.** En `discordError`, que sale también en el log como
`[sync] Discord: …`. **No mueve el `lastSuccessAt`**, igual que `historyError`: no saber si
alguien se ha salido del servidor no ha parado ni una partida. Un `unknown` —un timeout, un
`5xx`, un `401` de un token caducado, **o una lista de miembros vacía**— **no escribe
nada**: ni columnas ni alerta, y el jugador vuelve a la cola en la siguiente pasada. Solo
un `404` (o una lista de miembros de verdad en la que el id no aparece) afirma algo, y por
eso un `5xx` de Discord no pondría a todo el torneo en la lista de alertas.

**La línea del rastro dice qué se ha hecho**, y es lo primero que hay que leer:
`roster de 47 miembros, recién leída`, `sin lista de miembros (…GUILD_MEMBERS…)`, cuántos
enlazados por `@usuario`, cuántos sin aparecer por su `@usuario`, cuántos sin Discord y
cuántos se han quedado sin comprobar por no haber lista. Ver
[Sin lista de miembros](#sin-lista-de-miembros).

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
- `YOUTUBE_API_KEY` va **además** en *Build variables and secrets* del trigger de Workers Builds, que
  es otra lista distinta y es la única que existe durante el build. Igual que el resto de secretos que
  lee el código de servidor.
- Las **cinco** variables de Discord (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` y `DISCORD_OAUTH_SECRET`) van en el panel del Worker
  **y** en *Build variables and secrets*, igual que `YOUTUBE_API_KEY`. Sin ellas la inscripción
  pública sigue funcionando, pero **sin el paso de Discord**: no es un error, es la degradación
  documentada, y en producción el paso es obligatorio. El detalle y los pasos manuales para crear
  la aplicación y el bot están en [Discord obligatorio (F12)](#discord-obligatorio-f12).
- `NEXT_PUBLIC_SITE_URL` va **también** en *Build variables and secrets*, en las **dos**
  configuraciones de build, y vale `https://laligahispana.es`: sin ella, los canónicos y las rutas
  absolutas de las imágenes caen al `localhost` de desarrollo, que es lo que se veía en producción antes
  de definirla. Si algún día cambia el dominio, hay que cambiar el valor en las dos listas. Ver
  [El dominio propio](./DESPLIEGUE.md#el-dominio-propio-y-por-qué-no-está-en-el-archivo).

Lo que hay que poner en el panel del Worker (secretos y build variables, que no son la misma cosa, y
el paso de Hyperdrive) está en
[`docs/DESPLIEGUE.md`](./DESPLIEGUE.md#publicar) y en
[Los dos sitios del panel](./DESPLIEGUE.md#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables).
