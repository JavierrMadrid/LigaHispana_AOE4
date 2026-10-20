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

**Aprobar o dar de alta no lanza una pasada.** Tanto el aprobado de una solicitud (`approvePlayer`)
como el alta de admin (`createPlayer`) **escriben sin lanzar una pasada**: el estado (o el jugador,
en el alta), con su línea en `AdminAction`, y el jugador entra en la clasificación en la siguiente
pasada del cron (hasta 10 minutos) o con la llamada manual (`syncNow`). No es un olvido, es lo que
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

**Cadencia: cada 10 minutos.** La API ya ha devuelto 429; por debajo de 3 minutos se disparan
demasiadas peticiones. Con más jugadores, sube `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` antes que la
frecuencia. Para las partidas en directo, 10 minutos basta: se detectan en la siguiente pasada. Son
10 y no 5 por el presupuesto de CPU del plan Free de Cloudflare: la mitad de pasadas es la mitad de
CPU gastada (ver [El límite de CPU del plan Free](#el-límite-de-cpu-del-plan-free)).

Hay **dos relojes**, y el primario no es GitHub:

| Reloj | Qué es | Frecuencia real |
|---|---|---|
| **Supabase Cron** (primario) | Job de `pg_cron` que llama por HTTP a `POST /api/sync` con `pg_net` | 10 minutos |
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
  '*/10 * * * *',
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
  global, **compartido con la llamada manual de admin**. Con el reloj a 10 minutos y el candado a 5, el
  cron ya no llega al filo de la ventana anterior (era el motivo del "se salta 1 de cada 5" cuando el
  reloj iba a 5), así que esa vuelta solo se pierde si una pasada manual cae justo antes del disparo; en
  el día a día la cadencia es de 10 minutos clavados.
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

- **Menos pasadas**: el reloj pasa de 5 a **10 minutos**. La mitad de CPU gastada, y las partidas se
  siguen viendo (en la pasada siguiente).
- **Menos trabajo por visita**: `/objetivos` y la ficha de participante ya **no** barren todas las
  clasificatorias ni recomputan el catálogo en JS. `recomputeScores()` publica la vista de objetivos
  entera (objetivos, rankings, pool y ventana) en `Setting["scoring.objectives"]`, en la misma
  transacción y **solo si la huella del contenido cambió**; las páginas leen esa clave. Si falta, no
  valida o es de otra versión de las reglas, caen al cómputo en vivo de siempre, de modo que la
  degradación es segura.
- **Menos sondeos del navegador**: el refresco automático de `/` y `/partidas` (`LiveRefresh`) pasa de
  75 s a **150 s**. La frescura real la marca el sync (cada 10 minutos), así que la mitad de sondeos
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
- Mientras se siga en Free, la llamada manual de un admin está sujeta a lo mismo. Por eso su candado
  es de **5 minutos** y comparte el del cron: insistir es lo único que garantiza que Cloudflare
  empiece a matar pasadas. Con el reloj a 10 minutos, además, las dos vías ya no se solapan.

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
| Superadministrador | El correo de `SUPERADMIN_EMAIL`, y solo ese | Todo lo de un admin, más la configuración de la edición y las opciones de inscripción y donaciones, invitar, dar de baja y reactivar admins, deshacer sus acciones y mandar el aviso de prueba del bot |
| Admin | Una fila **activa** de la tabla `Admin` | El panel entero salvo la gestión de admins, la reversión, la configuración de la edición y las opciones de inscripción y donaciones |

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
| `MATCH_POINTS_REVERTED` / `MATCH_POINTS_RESTORED` | Quita o vuelve a poner la marca de la partida | Sí, con el revert/restore del historial |
| `PLAYER_CREATED` | **Borra al jugador** y todo lo suyo, con su cursor de sincronización | **No**: es irreversible |

- **Solo los tipos revertibles** (`isRevertibleActionType()`, `src/lib/admin-revert.ts`) y **una acción
  ya revertida no se revierte dos veces**. `PLAYER_REMOVED` no está: el dato ya no existe. Tampoco
  `ADMIN_*` (la baja de un admin se deshace reactivándolo), `ACTION_REVERTED` ni `CONFIG_CHANGED` (la
  configuración se cambia publicando otra).
- **Si algo ha cambiado después, se dice y no se escribe nada.** Deshacer una aprobación cuando el
  jugador ya está en otro estado —o una edición cuyos valores ya volvieron— pisaría ese cambio
  posterior: el panel lo explica en vez de deshacer "todo lo que vino detrás".
- **Al deshacer una edición se valida otra vez el valor anterior**, con los mismos parsers del
  formulario. Un `@usuario` que entonces estaba libre y hoy es de otra fila da un error claro y no
  escribe nada: la reversión es todo o nada.
- **Deshacer un alta es la excepción irreversible**: borra al jugador, sus partidas y su cursor de
  sincronización, con el mismo tratamiento que la baja del panel. La interfaz pide confirmación.

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
| `DISCORD_REDIRECT_URI` | URI registrada en Discord. Si falta, se deriva del origen + `/api/discord/oauth/callback` | No, pero conviene fijarla |
| `DISCORD_INVITE_URL` | Invitación de respaldo si el auto-unión falla | No |
| `DISCORD_API_BASE`, `DISCORD_TIMEOUT_MS`, `DISCORD_USER_AGENT` | Cliente de Discord | No (valores por defecto) |
| `DISCORD_CHECK_MAX_PER_RUN` | Tope de cuentas comprobadas por pasada (10) | No |
| `DISCORD_ROSTER_MAX_PAGES`, `DISCORD_ROSTER_TTL_HOURS` | Páginas de la lista de miembros por refresco (20) y horas de caché (12) | No |
| `DISCORD_ANNOUNCE_CHANNEL_ID` | Canal donde el bot avisa de los **hitos de la edición** (comienzo, final, recordatorios y cierre de inscripciones) y manda el **informe diario de clasificación** | Sí, para avisar |
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
4. **Invitar el bot al servidor** con los permisos `CREATE_INSTANT_INVITE` (meter a quien se inscribe) y
   `MANAGE_ROLES` (poner y quitar el rol de participante), y **colocar su rol por encima** del rol de
   participante (Configuración del servidor → Roles). Sin `CREATE_INSTANT_INVITE`, el `PUT …/members`
   responde 403 y **la inscripción no se bloquea**: se acepta con `joined: false` y se enseña el
   `DISCORD_INVITE_URL`. Sin `MANAGE_ROLES` o con el rol por debajo, el paso del rol responde 403 y el
   rastro lo dice ([ver abajo](#rol-de-participante-en-discord)).
5. **Activar el intent privilegiado `GUILD_MEMBERS`** (Bot → Privileged Gateway Intents → SERVER
   MEMBERS INTENT). Es manual y no se puede pedir por API; es lo que permite leer la **lista de
   miembros** del servidor, que comprueba a todos de una vez y **enlaza la cuenta de las altas de
   admin** por su `@usuario`. Sin él, el sistema funciona por el camino corto (ver abajo).
6. Copiar el **id del servidor** a `DISCORD_GUILD_ID` y el **id del rol de participante** a
   `DISCORD_PARTICIPANT_ROLE_ID`.

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

El motor vigila **10 reglas**: **6 de patrón** sobre las clasificatorias (partidas cortas, rival
repetido y compañero repetido, cada uno en racha y en total), **3 de estado** (historial no público,
partidas de ladder que no llegan, y Discord fuera del servidor) y **1 condicional** (participante sin
canal de directo, solo si la edición exige retransmisión).

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
  partidas cortas < 180 s, rachas de 2 y 3, acumulados cada 5/10 y compañero repetido 7. `window` y
  `modes` **no** se duplican: se leen del ruleset de puntuación, con el mismo `rankedMatchWhere()` y
  el corte de inscripción.
- **Qué partidas mira**: exactamente las que puntúan. Además del filtro de `rankedMatchWhere()` aplica
  en memoria la condición de equipo del motor de puntos, porque no cabe en un `where` de Prisma.
- **Cuándo se evalúa**: en `syncApprovedPlayers()`, después de `recomputeScores()`, **solo los
  jugadores tocados**; y también al revertir o restaurar una partida, al cerrar el torneo
  (`Setting["alerts.tournamentClose"]` lo marca) y a mano.
- **`NO_STREAM_CHANNEL`** es la única **condicional**: se evalúa solo si
  `Setting["edition.config"].streamingRequired` está activo, y avisa de los participantes aprobados
  **sin ningún canal** (`twitchChannel`, `youtubeChannel`, `kickChannel` y `twitchUrl` vacíos). No mira
  partidas, así que va sin ancla ni ventana —como la de Discord—, y su clave es de estado: reevaluarla
  cada pasada no inserta nada. Apagar el interruptor no borra las alertas ya escritas. Al **encenderlo**,
  los avisos aparecen en la siguiente evaluación que cubra a cada jugador: una pasada sin partidas
  nuevas evalúa a todos los aprobados, y el informe de alertas fuerza una completa.
- **Informe**: `GET /admin/alertas/reporte` (detrás de `requireAdmin()`) es un CSV para Excel con
  alertas disparadas y rachas abiertas, y llama a `evaluateAlerts({ full: true })` antes.
- **Idempotente**: `createMany({ skipDuplicates: true })` sobre `dedupeKey`; repetirlo no crea nada.
- **Dos reglas retiradas**: `TEAMMATE_ELO_GAP` (brecha de elo) y `LOW_DIVISION_TEAM_GAME` (equipo en
  una división muy distinta) **ya no se calculan**: su caso pasó a ser la condición de equipo de la
  puntuación (una partida con un compañero a dos escalones o más no cuenta, ver
  [`PUNTUACION.md`](./PUNTUACION.md)). Sus valores del enum, sus etiquetas y sus frases se quedan
  porque hay filas históricas de `Alert` que el panel sigue pintando.
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
| Cadencia | A mano, cuando cambie el reparto de la temporada. El motor **nunca** los deriva: el sincronizador corre cada 10 minutos |

- **Sin cortes, la condición no se aplica**: las partidas de equipo cuentan (no se puede demostrar la
  infracción), y el aviso sale en el rastro del recálculo —`Setting["scoring.lastRun"]`, campo
  `warnings`— y en el log con el prefijo `[scoring]`. Es un hueco de configuración de todo el torneo,
  no de una partida.
- `npm run alerts:cutoffs -- --show` enseña lo cacheado con su fecha y su coste, para que nadie los
  tome por un dato que se recalcula solo.
- Unos cortes nuevos **no cambian la clasificación por sí solos**: hay que recalcular (`npm run score`,
  o la siguiente pasada del cron), que es cuando el motor los aplica.

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
| Cadencia | Una vez cada **24 h** (`MAP_POOL_REFRESH_INTERVAL_HOURS`); la rotación es mensual y el worker corre cada 10 min |
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
`src/lib/sync-summaries.ts`).

| Qué | Cuánto |
|---|---|
| Petición | Una por partida a `…/players/{profileId}/games/{gameId}/summary?camelize=true`, con el `User-Agent` del proyecto |
| Partidas por pasada | **20** (`SUMMARY_MAX_PER_RUN`); el resto, a la siguiente |
| Orden | De la partida **más nueva a la más vieja**, con el histórico rellenándose por detrás |
| Reintento | Un fallo se reintenta pasada la hora; sin resolver, una partida **no** se reintenta después de **24 h** |
| Columnas | Las ocho del resumen en `Match` (`apm` … `summaryCheckedAt`, ver [`MODELO-DATOS.md`](./MODELO-DATOS.md)) |

- **Qué partidas**: exactamente las que puntúan (el mismo `rankedMatchSql()` que la clasificación) y de
  un jugador que no tenga el historial cerrado. El filtro `historyPublic is distinct from false` deja
  pasar el "sin comprobar" y descarta a quien consta que no publica partidas.
- **Un `404` es concluyente**: la partida no tiene resumen, se apunta en `summaryCheckedAt` y no se
  vuelve a preguntar. Un fallo de red, un `5xx` o un `200` ilegible **no escriben nada** —ni métricas ni
  la marca—, así que la partida vuelve a la cola: no saber no es "no hay".
- `apm` es la **marca de "hubo resumen"**, y `null` en cualquiera de las ocho columnas significa "no hay
  resumen", nunca "cero". Una partida sin resumen no cumple ninguna hazaña y **corta** la racha de
  `ansioso` (ver [`OBJETIVOS.md`](./OBJETIVOS.md#logros-cobra-quien-cumple)).
- Con `AOE4WORLD_MOCK=1` **no sale a la red**: se sirve una fixture determinista por partida, con la
  misma forma que el resumen de verdad, para que el lector y los objetivos se ejerciten en las
  simulaciones.
- Dónde mirar: `summariesError` en el rastro (`[sync] Summaries de partida: …`), con cuántos se han
  guardado, cuántos no tienen resumen y cuántos quedan para la pasada siguiente. **No** mueve
  `lastSuccessAt`: un resumen que no llega solo deja unos objetivos a medias.

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

El bot manda mensajes a un canal (`DISCORD_ANNOUNCE_CHANNEL_ID`). Son de tres clases: los **hitos de la
edición** (esta sección), el **informe diario de clasificación** y los **avisos de las acciones de
administración** (las dos subsecciones de abajo). Los hitos los manda el worker en su pasada
(`announceEditionWindow()`): mira la ventana del ruleset (`Setting["scoring.ruleset"].window`) y la fecha
de cierre de inscripciones (`Setting["registration.closesAt"]`).

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

Cuando la organización quita algo del torneo, el bot lo cuenta: un **privado** a la persona afectada y un
**mensaje global** al canal de avisos. Lo hace la propia Server Action, después de la transacción
(`dispatchAdminNotice()`, `src/lib/admin-notice-send.ts`).

| Acción | Cuándo avisa |
|---|---|
| **Baja de participante** (`deletePlayer`, `PLAYER_REMOVED`) | siempre |
| **Invalidar los puntos de una partida** (`revertMatchPoints`, `MATCH_POINTS_REVERTED`) | solo al invalidar; restaurar puntos no avisa |

No avisan **restaurar** puntos, **deshacer** una acción ni aprobar o rechazar: no quitan nada ni son
noticia.

| Qué | Cómo |
|---|---|
| Privado (DM) | `POST /users/@me/channels` + publicar. Necesita `discordUserId`; si solo hay `@usuario`, se resuelve contra el roster cacheado |
| Global | Al canal de avisos, por `postChannelMessage()`. Corto, sin decir quién lo hizo (eso está en el historial del panel) |
| Texto de la baja | «Retirado del torneo» solo si estaba `APPROVED`; si era una solicitud (`PENDING`/`REJECTED`), «solicitud descartada» |

- **No bloquea la acción y no puede hacerla fallar**: el aviso se aplaza con `ctx.waitUntil()` (o se deja
  correr fuera del Worker), va después de la transacción —si el cambio falla no hay nada que avisar— y un
  fallo de Discord queda en el log con el prefijo `[admin-notice]` **sin** cambiar lo que ve el
  administrador ni el historial.
- **Sin cuenta resoluble no hay privado**, y sin canal no hay global; los dos son **independientes** y
  ninguno es un fallo. Sin `DISCORD_BOT_TOKEN` no se avisa de nada (solo queda el log).

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
| Memoria de avisos | `Setting["edition.events.announcements"]` (`sent`: `${eventId}:24h`/`12h`/`1h` → instante) |
| Dónde mirar | `announceError` (avisos) y `discordError` (elegibilidad) en `Setting["sync.lastRun"]`. Ninguno mueve `lastSuccessAt` |

### Avisos

El worker manda **tres recordatorios** por evento, dentro de su tramo y nunca atrasados:

| Aviso | Cuándo (`now`) |
|---|---|
| 24 h | `[inicio − 24 h, inicio − 12 h)` |
| 12 h | `[inicio − 12 h, inicio − 1 h)` |
| 1 h | `[inicio − 1 h, inicio)` |

- **Un evento ya empezado no genera recordatorios**: su información va en el aviso de comienzo.
- **Un tramo saltado no se recupera**: si la pasada de las 24 h no ocurre, no se manda al día
  siguiente; sale el tramo en el que estemos. Un aviso ya anotado no se repite.
- El texto lleva el nombre, la ventana en hora de Madrid, el multiplicador, la descripción si la
  hay y, si el evento lo pide, que solo cobran quienes estén en el servidor de Discord.
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
  cron de 5–10 minutos.
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
npm run alerts:cutoffs           # deriva los cortes de división de la condición de equipo
npm run backfill:objective-leads # reconstruye el historial de liderazgos de la edición
npm run db:cron                  # programa el reloj cada 10 minutos
```

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
