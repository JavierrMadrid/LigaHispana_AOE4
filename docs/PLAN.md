# Plan de desarrollo — LigaHispana_AOE4

Seguimiento de la Liga Hispana de Age of Empires IV. Torneo **individual** con clasificación calculada a partir de las partidas de los participantes, obtenidas de la API de [AoE4World](https://aoe4world.com/api).

> **Regla de puntos**: puntúa **cualquier partida clasificatoria**, no solo la ladder *ranked* 1v1 (`rm_solo`). Por eso `Match` guarda `leaderboard` y `rawJson`: el motor de F3 filtra y puede recalcular sin volver a pedir todo el histórico a la API. `rm_solo` es el valor por defecto porque hoy es el caso mayoritario, no porque sea el único válido. Desde F8 hay una **cuarta** condición: una partida marcada con `Match.revertedAt` por el panel de admin deja de puntuar, pero sigue en el histórico y se puede restaurar.

## Referencia funcional: ordreduwololo.fr

Ya existe un sitio que resuelve un problema muy parecido: [ordreduwololo.fr/challenges](https://ordreduwololo.fr/challenges). Es la **guía funcional** para este proyecto, con dos diferencias: aquí el torneo es **individual** (no por equipos) y las reglas/objetivos de puntuación cambian.

Cómo leer esa referencia:

- **Nivel de comportamiento**: qué pantallas existen, qué información se muestra y en qué momento. La web debe funcionar "de forma muy similar" a celle-là.
- **Nivel visual**: explícitamente **no** es referencia. El diseño propio se decide en F4/F7 aplicando las skills de diseño del repo.

De ella se derivan los requisitos que ya estructuran las fases: clasificación siempre actualizada, listado de partidas en curso con participantes del torneo, y streams de Twitch de los participantes que estén en directo.

## Decisiones de stack

| Área | Decisión | Motivo |
|---|---|---|
| Frontend + Backend | **Next.js 16** (App Router) + TypeScript | Un solo lenguaje, SSR/ISR, API routes, despliegue fácil en Vercel |
| Estilos | TailwindCSS v4 | Incluido por defecto en create-next-app |
| BBDD | **PostgreSQL** vía **Supabase** (cloud) | Relacional, encaja con el modelo; Supabase gratis + auth integrada |
| ORM | **Prisma 7** (`prisma-client`) | Tipado, migraciones; schema en `prisma/schema.prisma` |
| Auth | **Supabase Auth** (solo admin) | Ya tenemos proyecto Supabase; `@supabase/ssr` para sesiones en Next |
| Tareas en segundo plano | **Supabase Cron** (`pg_cron` + `pg_net`) que llama por HTTP al Worker; workflow de GitHub como red de seguridad | El reloj vive en la base de datos, no en el Worker: en el plan Free de Cloudflare el sync no cabe en el presupuesto de CPU (ver [`docs/OPERACION.md`](./OPERACION.md#el-límite-de-cpu-del-plan-free)) |
| Twitch | Helix API (requiere app registrada) | Detectar streamers en directo |

## Estado actual

### F0 — Setup ✅

- [x] Scaffold Next.js 16.3.6 + TS + Tailwind (App Router, `src/`)
- [x] Prisma 7.10.0 instalado; config en `prisma7.config.ts`
- [x] Schema inicial (`Player`, `Match`, `Setting`) en `prisma/schema.prisma`
- [x] Cliente generado en `src/generated/prisma` (import: `@/generated/prisma/client`)
- [x] Supabase: `DATABASE_URL` (session pooler, IPv4) + claves `NEXT_PUBLIC_*`
- [x] Tablas creadas en Supabase vía `npm run db:push`
- [x] `lint` y `build` pasan sin errores
- [x] README actualizado

### F1 — Auth + panel admin ✅
- [x] `@supabase/ssr` + cliente Prisma con driver adapter (`@prisma/adapter-pg`)
- [x] Helpers de Supabase: `src/lib/supabase/{env,server,proxy}.ts`
- [x] `src/proxy.ts` (antes *middleware* en Next 16): refresca la sesión y protege `/admin`
- [x] DAL de auth: `requireAdmin()` en `src/lib/auth.ts` (verificación segura con `auth.getUser()`)
- [x] `/login` con Server Action (`useActionState`) y logout
- [x] `/admin`: resumen con contadores y aviso de pendientes
- [x] `/admin/jugadores`: alta por `profileId`, aprobar/rechazar/eliminar — **superado por F8**,
      que lo reorganicó en cuatro pestañas y movió las acciones a `/app/admin/actions.ts`
- [x] Ampliar el modelo de datos (objetivos, snapshot de clasificación) — se hace en F3
- [x] **Alta de admins por invitación**: `GET /auth/confirm` (Route Handler) verifica el
      `token_hash` del correo en servidor con `verifyOtp()` y deja la sesión en cookies, en lugar
      de dejarla en el fragmento de la URL, donde el navegador no la entrega y nada la consumía. El
      destino `next` solo puede ser una ruta interna y todo fallo va a `/login?error=enlace`; los
      tipos de token admitidos cubren la invitación y la recuperación, así que el mismo mecanismo
      sirve para el "he olvidado la contraseña". `/login/establecer-contrasena` (página y
      formulario, Server Action `setPassword`) fija la contraseña con esa sesión y entra a
      `/admin`. Requiere el **paso manual** en el panel de Supabase —Site URL/Redirect URLs y la
      plantilla "Invite user"— documentado en el [README](../README.md#alta-de-admins-por-invitación).

Decisión: todo usuario autenticado es admin → **registros públicos de Supabase desactivados**; las cuentas se crean a mano.

### F2 — Integración AoE4World + worker de polling ✅

- [x] Cliente HTTP tipado en `src/lib/aoe4world/` con **único punto de salida** (`http.ts`): timeout, cancelación, separación mínima entre peticiones, *backoff* exponencial con jitter y respeto de `Retry-After` / `X-RateLimit-*`.
- [x] `unknown` + validación en la frontera (`parse.ts`): sin `any` ni casteos ciegos; un payload raro se descarta, no se guarda.
- [x] Endpoints tipados: perfil, partidas (paginado + `since`), partida concreta, leaderboard (hasta 50 ids) y autocomplete.
- [x] Normalización a `Match` en `normalize.ts`, con `leaderboard` + `rawJson` para que F3 pueda filtrar y recalcular.
- [x] Worker `syncApprovedPlayers()`: una pasada por jugador aprobado, concurrencia limitada, un fallo no tumba el lote y todo queda resumido en JSON.
- [x] Punto de entrada único `POST|GET /api/cron/sync`, con sesión de admin **o** `Authorization: Bearer $CRON_SECRET`.
- [x] `npm run sync` (CLI) y `npm run verify:sync` (comprobaciones con datos de ejemplo, con `--db` para el guardado).
- [x] Cero de la API, tabla de rate limit y `Setting` por jugador (`aoe4world.sync.player.<profileId>`).
- [x] `mode` y `civRandomized` se rellenan al guardar cada partida, y los *backfills* de las
  filas anteriores están en `npm run backfill:model`.
- [x] **Modo mock** (`AOE4WORLD_MOCK=1`): `performRequest()` resuelve con las fixtures locales de
  `src/lib/aoe4world/mock/` en lugar de salir a la red, sin tocar parsers, worker ni motor. Solo
  fuera de producción: si el flag está activo con `NODE_ENV=production`, la configuración falla
  al arrancar. Por defecto no cambia nada.
- [x] **Simulación del torneo**: `npm run mock:tournament` crea/actualiza 10 participantes
  `APPROVED` (profileId `90000001`–`90000010`, rango reservado que no choca con los de
  `verify:sync`), sincroniza **solo** esos perfiles contra el mock y recalcula la clasificación.
  Sale: 127 filas de partida (71 partidas distintas: 68 terminadas + **3 en directo**, estas
  últimas 5 filas por la unicidad `(playerId, gameId)`), 10 puntuaciones distintas y 5 canales de
  Twitch. Idempotente; `npm run mock:clean` retira exactamente esos 10 jugadores y sus cursores,
  **comprobando antes que las filas son las del mock** (coinciden `profileId`, nombre y canal con
  `src/lib/aoe4world/mock/players.ts`): si algo no cuadra, no borra nada.
  - **Rivales externos**: el torneo es individual, así que no todos los rivales son de la liga.
    Las fixtures incluyen 10 rivales de ladder (`profileId` `92000001`–`92000010`) que **nunca**
    se convierten en `Player`: 20 partidas terminadas (2 por participante, una ganada y una
    perdida) y **1 de los 3 directos** es participante vs externo, que es el caso que deja la
    tarjeta de `/partidas` con una sola fila y sin el distintivo "jugadores de la liga". En la BD
    quedan 21 filas con `opponentProfileId` ajeno a la liga.
  - Tiempos: el histórico está **anclado a una epoch fija** (determinista) y las 3 partidas en
    vivo calculan su `started_at` como "hace 10–20 min" **en cada petición**, con lo que nunca
    salen de la ventana de 60 min y el cursor `since` no dispara el borrado por abandonada: la
    simulación no se pudre con el paso de las horas.

- [x] **Avatar de AoE4World** (`Player.avatarUrl` = `avatars.full`): se guarda desde la ladder
  y también desde el perfil que `syncPlayer()` ya pedía en cada pasada (únicamente vía para los
  jugadores que la ladder `rm_solo` no devuelve). Un `avatars.full` vacío **no pisa** el último
  guardado: null no comunica nada y borrarlo degradaría la tabla a monograma sin motivo.
  Verificado contra la API real en septiembre de 2026: `/leaderboards/:ladder` y
  `/players/:id` devuelven la foto en `avatars.full`. El mock sirve el mismo contrato.
  La UI ya la pinta en la clasificación (`PlayerAvatar`, con monograma de reserva).
- [x] **Paginación de la ladder completa** (`Aoe4WorldLadderPage`, `parseLadderPage`,
  `getLadderPage`): `GET /leaderboards/:ladder` **sin** `profile_id` devuelve la clasificación
  entera paginada (`page`, `per_page`, `total_count`, `next_page`), y con `?page=N` se puede
  recorrer. Es la única vía para localizar un tramo de divisiones, porque la API **ignora en
  silencio** `rating_min`/`rating_max` y `rank_level` (los tres devuelven siempre la página 1).
  El tamaño de página se toma del `per_page` de la respuesta, nunca del pedido.
- [x] **Torneo simulado con jugadores reales** (`npm run simulate:tournament` /
  `npm run simulate:clean`, `scripts/simulate-tournament.ts`): elige **un jugador real por
  división** con más de 20 partidas de ladder (`rm_solo`) en los últimos 14 días, lo da de
  alta `APPROVED`, importa las partidas de la ventana del torneo y recalcula la clasificación.
  Detalles y coste en [README](../README.md#torneo-simulado-con-jugadores-reales-api-de-verdad).
  - **Selección con búsqueda binaria** (`src/lib/simulation/select.ts`): las divisiones son
    bloques contiguos en la ladder, así que la primera página de cada una se localiza con
    `log2(461) ≈ 9` llamadas en vez de paginar las 461. Medido en septiembre de 2026: **49
    llamadas** para las seis divisiones (los bloques quedaron en bronce 396–461, plata 314–395,
    oro 139–313, platino 59–138, diamante 25–58 y conquistador 1–24), **18** más para leer las
    primeras tres páginas de cada bloque y **24** para contar las partidas de los candidatos
    descartados: ~90 llamadas y ~40 s en total. La búsqueda binaria además se **verifica** con
    un paseo acotado de páginas vecinas, porque el rating fluctúa y el entrelazado de dos
    divisiones en la misma página desplazaría el límite.
  - **El recuento de partidas reutiliza `normalizeGame`**, o sea el mismo criterio que aplica el
    import (partida resuelta y con este `profileId` dentro de `teams`), así que "+20 partidas"
    significa "+20 filas que van a acabar en `Match`". Se pide `leaderboard=rm_solo` (el filtro
    **sí** funciona: en un jugador de ejemplo `total_count` baja de 114 a 28) e
    `include_alts=false`, porque lo que se juega con un alt pertenece a otro `profileId`.
  - **Ventana acotada sembrando el cursor**: el torneo son 4 semanas de las que han pasado 3, así
    que el alta **sembró el cursor `since`** de cada jugador en el arranque del torneo
    (menos 1 h de margen, el mismo solape del worker). Sin eso el worker recorrería el
    histórico entero —hasta 500 partidas por jugador y pasada, y volvería a pedirlas en cada
    ejecución— para importar partidas anteriores al torneo, que no cuentan para nada. El cursor
    **nunca retrocede**: si ya es más reciente, se respeta. Resultado: 415 filas importadas y, a
    partir de ahí, la simulación **sigue creciendo** con el worker real.
  - **Reversibilidad por manifiesto, no por rango de ids**: como los jugadores son reales no hay
    `profileId` reservado que los marque. `Setting["simulation.roster"]` guarda quién se dio de
    alta y con qué identidad, y `npm run simulate:clean` **verifica cada fila contra el manifiesto
    antes de borrar** (mismo patrón que `mock:clean`): si el nombre de la fila no es el que
    escribió la simulación, o falta alguna, **aborta**. `--dry-run` hace la verificación entera
    sin borrar. Verificado en septiembre de 2026 con una fila alterada a mano: abortó, y tras
    `simulate:clean` la base quedó con 0 jugadores, 0 partidas, 0 puntuaciones y 0 cursores.

Decisiones de F2 que condicionan F3/F4:

- **Partida en directo**: (`ongoing === true` o `state !== "processed"`) **y** `started_at` de hace menos de `LIVE_GAME_WINDOW_MINUTES = 60`. Se guarda con `finishedAt` y `result` a `null`. F4 debe listar por `finishedAt IS NULL`.
- **`result` pasa a ser nullable** (`prisma/schema.prisma`): en una partida en curso el resultado no existe todavía. F3 puntúa solo partidas con `result` y `finishedAt` informados.
- **La unicidad de `Match` pasa a `(playerId, gameId)`** (antes `gameId` a secas): dos participantes del torneo pueden jugar la misma partida y cada uno necesita su fila con su resultado, civ y puntos. Con la unicidad global, la fila del segundo jugador se perdía en silencio.
- **Cursor incremental**: `since` = `startedAt` más nuevo visto − 60 min de solape, guardado en `Setting` por jugador. El cursor nunca retrocede.
- **Refetch de partidas en curso**: el cursor puede dejar fuera del listado una partida en curso (si `startedAt < since`, es decir, más de 60 min antes de la partida más nueva del jugador). Antes de paginar, el worker pide las partidas propias con `finishedAt IS NULL` que caigan fuera de la ventana y las refresca una a una con `GET /players/:id/games/:game_id`. Sin esto, una partida en curso podía quedarse sin resolver para siempre. El conjunto afectado suele ser de 0 a 2 filas, así que el coste es de 0 a 2 llamadas por jugador y pasada.
- **Histórico**: 10 páginas × 50 partidas por pasada y jugador (configurable). La API nunca devuelve más de 50 partidas por página, aunque se le pidan más, y pagina de más reciente a más antigua: el tope recorta el pasado y nunca deja sin traer partidas nuevas.

### Reglas de datos que heredan F3 y F4

> **Regla: una partida abandonada nunca cuenta.** Si la API no publica el desenlace de una partida (el jugador se desconectó, la partida se colgó, o la API simplemente nunca la procesa), esa partida **no suma ni resta nunca** para la clasificación. No se resuelve como `LOSS` automáticamente ni bajo ninguna circunstancia.

Cómo lo materializa F2:

- Una partida cuenta solo si tiene `result` (`WIN`/`LOSS`) **y** `finishedAt`. Son las dos condiciones que F3 debe filtrar.
- Cuando el refetch confirma que una partida en curso ya no va a resolverse (la API sigue diciendo `ongoing`/`state !== "processed"` pasadas las 60 min, o devuelve 404), **se borra la fila**. No se deja con `finishedAt = null` para siempre, porque `finishedAt = null` significa "en curso" para F4 y una fila sin resolver sería indistinguible de una partida viva: F3 podría colarla por error.
- Cada borrado se anota en `Setting`, clave `aoe4world.sync.player.<profileId>`, campos `abandonedCount`, `abandonedGameIds` (últimos 20) y `lastAbandonedAt`. Es solo rastro: no puntúa nada, pero hace la decisión auditable.
- El resumen del worker expone `resolvedByRefetch` y `abandonedMatches`, y cada descarte se escribe en el log con el motivo.

Consecuencia para F4: una partida en directo que se abandona desaparece de la lista al cabo de ~60 min, no se queda colgada para siempre. Es intencionado.

Consecuencia para F3: no hace falta que F3 regurgite partidas abandonadas porque no existen en la tabla. Aun así, el filtro `(result IS NOT NULL AND finishedAt IS NOT NULL)` debe seguir presente: es la garantía de que una partida en curso nunca puntúa.

Detalles de la API comprobados al implementar (no están en su documentación):

- `/leaderboards/:ladder?profile_id=1,2` acepta **varios ids separados por comas**. Mandar el parámetro repetido (`?profile_id=1&profile_id=2`) no da error pero solo devuelve el último jugador.
- `/players/:id/games?limit=N` devuelve como máximo 50 partidas (`per_page: 50`), en silencio.
- `/players/:id/games?leaderboard=rm_solo` **sí filtra** (a diferencia de los de la ladder):
  en un jugador de ejemplo `total_count` pasa de 114 a 28. `include_alts` no cambia el resultado
  en los jugadores medidos, pero se manda a `false` porque lo jugado con un alt es de otro perfil.
- `/leaderboards/:ladder` **sin** `profile_id` devuelve la ladder completa paginada (`page`,
  `per_page`, `total_count`, `next_page`, `offset`); con `?page=N` se recorre y **más allá de la
  última página contesta `200` con la lista vacía**, no un 404. En cambio `rating_min`,
  `rating_max` y `rank_level` **se ignoran en silencio**: devuelven siempre la página 1.
- `teams` viene anidado (`{ player: {...} }`) en la lista y plano en el detalle de una partida; ambos se leen.
- La API no manda `finished_at`: se deriva de `started_at + duration`.

## Arquitectura

```
AoE4World API ──poll──► Worker/Cron ──► PostgreSQL (Supabase)
                                          │
                                          ▼
                              API propia (Next.js) ──► Frontend (React)
                                                       ├─ Clasificación
                                                       ├─ Partidas en vivo
                                                       ├─ Streams Twitch (embeds)
                                                       └─ Panel admin (Supabase Auth)
```

## Modelo de datos (schema actual)

```
Player     (id, profileId unico, name, aoe4WorldName?, twitchChannel?, contactEmail?, status: PENDING|APPROVED|REJECTED, timestamps)
Match      (id, [playerId, gameId] unico, playerId FK, opponentProfileId?, opponentName?,
            civ?, opponentCiv?, civRandomized, map?, leaderboard="rm_solo", mode?,
            result?: WIN|LOSS (null = sin resolver),
            startedAt, finishedAt?, durationSeconds?, points, revertedAt?, rawJson, createdAt)
PlayerScore(playerId, ruleSetVersion) pk, rank, total, wins, matches, breakdown JSON, computedAt
Setting    (key PK, value JSON, updatedAt)
AdminAction(id, type: PLAYER_CREATED|PLAYER_EDITED|PLAYER_REMOVED|MATCH_POINTS_REVERTED|MATCH_POINTS_RESTORED,
            actorEmail, summary, targetId?, details JSON, createdAt)
Alert     (id, rule: AlertRule, kind: AlertKind, playerId FK cascade, subjectProfileId?, subjectName?,
            count, threshold, anchorGameId?, dedupeKey unico, summary, details JSON, createdAt)
ObjectiveEvent(objectiveId unico, playerId FK cascade, achievedAt, recordedAt)
```

Notas:
- `gameId` se guarda como `String` y la unicidad es **por jugador** (`@@unique([playerId, gameId])`): el torneo es individual y dos participantes pueden jugar la misma partida, cada uno con su propio resultado y sus puntos.
- `rawJson` conserva la partida completa de la API para poder recalcular puntos si cambian las reglas.
- Se guardan **todas** las partidas del jugador, no solo las clasificatorias: el filtro por `mode` y por fecha lo hace el motor. Así también salen las "partidas en directo" (F4) del mismo histórico.
- `leaderboard` es una `String` (no enum) precisamente para no tener que migrar cada vez que aparece un modo de juego nuevo en la API. `mode` es la **familia de ladder resuelta** (`rm_1v1` -> `rm_solo`, `rm_2v2`/`rm_3v3`/`rm_4v4` -> `rm_team`) y es por la que filtra el motor; `leaderboard` no se toca, porque es el registro literal de lo que dijo la API.
- `result` admite `null`: significa que la partida aún no está resuelta por la API. El motor no puntúa esas filas.
- `revertedAt` es la cuarta condición de "cuenta como clasificatoria" (F8): es la marca que pone el panel para que una partida deje de puntuar, y la regla la lee `src/lib/ranked-match.ts` en sus tres traducciones, así que no da ni victorias ni objetivos. **El worker no la toca**, y por eso la marca sobrevive a la reimportación.
- `AdminAction` es el historial **append-only** de lo que hace la organización (F8). `summary` se redacta en español en el momento de escribir la fila (`src/lib/admin-actions.ts`) y la interfaz lo pinta tal cual, para que el rastro y la pantalla no puedan divergir. El enum es corto a propósito —solo lo que **alguien más ve**: un jugador entra, sale o se le corrigen sus datos, una partida deja de puntuar o vuelve a puntuar—, y aprobar o rechazar una solicitud **no** se registra porque no cambia nada de lo que ve el público. Editar **sí**: el nombre y los canales salen en la clasificación y en `/partidas`.
- `ObjectiveEvent` es un **espejo reconciliado** del cómputo de objetivos, no un log: una fila por objetivo cumplido (38 como mucho) y `achievedAt` = el instante de la hazaña en las carreras de `civilizacion` y el fin del torneo en los 14 objetivos "en caliente", que solo se registran cuando la ventana ya ha terminado. Lo escribe `recomputeScores()` dentro de su transacción (`src/lib/objective-events.ts`), y **se borra** si el objetivo deja de cumplirse: por eso no guarda etiqueta ni puntos (se resuelven al leer del catálogo y del ruleset activo) ni puede quedar apuntando a un poseedor al que ya le movieron los puntos. Detalle en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md) §1.6.
- `PlayerScore` es el agregado **versionado** que lee la web. El modelo completo está en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md): la parte que no depende de las reglas ya está aplicada y la que depende (ruleset Wololo, snapshots, categorías) está diferida.
- `Alert` es el registro **append-only** de los comportamientos anómalos que el motor detecta sobre
  las partidas clasificatorias (F9). Es append-only como `AdminAction`, y por el mismo motivo: nadie
  edita filas, y la corrección es que la condición que produjo la alerta deje de cumplirse (una
  partida revertida, una ventana movida, un umbral retocado). `summary` se redacta en español al
  escribir la fila (`src/lib/alerts/rules.ts`) y **no lleva el nombre del jugador**: la fila ya es
  suya y el nombre se renombra, así que guardarlo sería congelar un texto que dejaría de ser cierto.
  El sujeto (rival o compañero) sí se guarda con su nombre, porque puede no estar en la liga y no
  sale de ningún `join`. El `dedupeKey` es una **columna de texto** y no un índice único compuesto
  porque en Postgres los `NULL` de un índice único no colisionan, y el sujeto es opcional; sobre él
  va el `skipDuplicates` que hace la evaluación idempotente.
- `Setting` no es solo configuración: también es la memoria del worker (`aoe4world.sync.player.<profileId>`) y el rastro del motor (`scoring.lastRun`). Añade `sync.lastRun`, el rastro de la última pasada del sincronizador, que es lo que hace visible un fallo suyo: contadores, errores y los jugadores que no se pudieron sincronizar, más un `lastSuccessAt` que solo avanza en las pasadas enteras. La simulación con jugadores reales añade `simulation.roster`, el **manifiesto de a quién dio de alta y con qué identidad**: es lo único que permite deshacerla sin borrar participantes de verdad.

## Integración con AoE4World

Endpoints relevantes:

| Endpoint | Uso |
|---|---|
| `GET /api/v0/players/:profile_id` | Perfil y stats del jugador |
| `GET /api/v0/players/:profile_id/games` | Partidas (pag `page`/`limit`, filtro `since`; `leaderboard` opcional para acotar) |
| `GET /api/v0/players/:profile_id/games/:game_id` | Partida concreta (detalle) |
| `GET /api/v0/players/autocomplete?leaderboard=rm_solo&query=...` | Búsqueda de jugador |
| `GET /api/v0/leaderboards/:leaderboard?profile_id=...` | Leaderboard (hasta 50 ids) |
| `GET /api/v0/leaderboards/:leaderboard?page=...` | Ladder completa por páginas (la usa la simulación para localizar divisiones) |

Consideraciones:
- **Rate limits**: la API pide uso responsable (hemos visto 429). Polling conservador (cada 2–5 min), con caché y *backoff*. Implementado en F2: separación mínima entre peticiones, *backoff* con jitter y pausa global cuando la API dice `Retry-After` o `X-RateLimit-Reset`.
- **Partidas en vivo**: la API devuelve partidas terminadas. "En directo" se infiere de `ongoing`/`state` más una ventana de 60 minutos (ver F2 en "Estado actual").
- **Puntuación**: no existe en AoE4World; se calcula y guarda en local (F3).
- **Campos útiles en la respuesta**: además de `leaderboard` y `kind`, la API devuelve `ongoing`, `just_finished`, `state`, `duration`, `average_mmr` y los equipos con `result`, `civilization`, `rating` y `mmr` por jugador. Todo eso queda en `rawJson` para F3.

## Roadmap

### F1 — Auth + panel admin ✅ (ver "Estado actual")

### F2 — Integración AoE4World + worker de polling ✅ (ver "Estado actual")

### F3 — Motor de puntuación v2 (reglas del torneo) ✅ / puntos por validar

El sistema de puntuación real está definido e implementado. La rama antigua de reglas
(`docs/f3-puntuacion`) se borró y las reglas se reescribieron desde 0 en
[`docs/PUNTUACION.md`](./PUNTUACION.md), que es la fuente de verdad de las reglas.

- [x] **Reglas v2**: 10 puntos por victoria clasificatoria (`mode` en `rm_solo` o `rm_team`,
  partida resuelta) más **38 objetivos especiales** *winner-takes-all* (solo el primero los
  cobra), reflejados en caliente: si cambia el poseedor, los puntos se trasladan.
- [x] Ruleset versionado (versión 2) publicado en `Setting` (`scoring.ruleset`); los números
  (puntos por victoria, puntos por objetivo, mínimos) se reconfiguran sin despliegue y el
  motor tiene fallback a `DEFAULT_RULESET`.
- [x] **Ventana de fechas del torneo** (`window` en el ruleset): una partida solo puntúa si
  **empezó** en `[from, to)`, con `to` opcional (ventana abierta) y todo en instantes
  ISO-8601 UTC. Aplicada en los tres sitios que filtran partidas —`Match.points`, el
  agregado y los objetivos— con la definición en un único módulo (`src/lib/ranked-match.ts`)
  y sin columnas ni índices nuevos. El worker sigue importando el histórico entero. Las
  fechas del código son **de pruebas** (15-sep-2026 → 15-oct-2026) y las oficiales se
  reconfiguran en `Setting` sin desplegar.
- [x] **38 objetivos en 5 grupos** tras la reagrupación del cliente: Actividad
  (`loco-por-ganar`, `otp`), Racha (`golpe-de-suerte`, `prohibido-perder`), Divisiones
  (6 `sensei-*`), Formatos (4 `rey-*`) y Civilizaciones (23 `masterizar-*`, carreras a
  10 victorias: nadie cobra hasta que alguien llega a 10, más
  `masterizarlos-a-todos`: el primero en ganar una partida con **las 23** civilizaciones
  del catálogo, al final del grupo, 100 puntos).
- [x] Mínimos de 10 partidas clasificatorias para los objetivos de ratio y racha; desempates
  deterministas documentados en `docs/PUNTUACION.md` §5.
- [x] Catálogo de civilizaciones (`src/lib/civs.ts`: 23 civs, slug de AoE4World → nombre en
  español) y divisiones movidas a `src/lib/divisions.ts` (6, incluido platino).
- [x] `ScoreBreakdown` v2 (`byMode` + desglose de objetivos por id y grupo) y contrato
  `getObjectives()` en `src/lib/public.ts`: poseedor, **ranking completo** (la paginación la
  hace el cliente), `description` por objetivo, mínimos y `pointsPerWin` vivos,
  `profileUrl` y detalle de civilización en `otp`.
- [x] `npm run score` y `verify:sync` ampliado, con comprobación del contrato de objetivos
  (23 comprobaciones sin base de datos —incluido el catálogo de los 38 objetivos— y el
  contrato publicado con `--db`). Sin cambios de schema.
- [x] **RLS sin políticas y sin permisos para los roles de cliente** sobre las cuatro tablas,
  versionado en `scripts/db-security.ts` (`npm run db:security`, y `-- --check` después de cada
  `db push`): `prisma db push` no gestiona RLS ni GRANTs, así que si solo se hiciera a mano
  desde el panel no quedaría en ninguna parte del repositorio. Antes de este trabajo, la clave
  publicable del proyecto leía las tablas por la Data API; ahora contesta `401`. Detalle y
  comprobaciones en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md) §7.
- [x] **Rastro de la última pasada** en `Setting["scoring.lastRun"]`, escrito dentro de la
  transacción del recálculo (sin tabla nueva, que era justo lo que pedía `ScoreSnapshot`).
- [x] **Un solo `UPDATE` para `Match.points`** (antes eran dos `updateMany` en cadena) y con la
  guarda de no reescribir las filas cuyo valor no cambia: una pasada sin novedades deja la tabla
  intacta. Se conserva la idempotencia del diseño en dos pasos, incluido el caso de que el
  ruleset deje de contar una familia o baje `pointsPerWin`.
- [x] **`pg_advisory_xact_lock` al principio del recálculo**, para que el cron y un `npm run score`
  a mano no se estorben en el `deleteMany` de `PlayerScore`.
- [x] Base de datos limpia de los datos de `mock:tournament` (10 jugadores, 127 partidas y sus
  puntuaciones v1 y v2, y los 10 cursores). Antes de borrar, `mock:clean` verifica que las filas
  son las del mock por `profileId`, nombre y canal, y aborta si no cuadran.

Pendiente:

- [ ] **Validar con el cliente la tabla de puntos** (10/victoria; objetivos de 40 a 100; 2420
  puntos extra en juego). La propuesta estadística está en `docs/PUNTUACION.md` §4 y los
  números se retocan en `Setting` sin tocar código.
- [ ] Los números del copy de la UI (`10 puntos`, `10 partidas`, `10 victorias`) siguen
  hardcodeados en `/reglas` y `/objetivos`: si se retoca el ruleset, exponer los valores
  vivos para que el copy no mienta.
- [ ] `ScoreSnapshot` (histórico de cada cálculo con su delta), índice parcial de partidas
  en directo y agregados incrementales en vez de recálculo completo (diferidos, ver
  [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md)).

### F4 — Frontend público (MVP) ✅ / crecimiento pendiente

Páginas públicas en español, con navegación compartida y **tema propio de torneo
medieval (pizarra + oro antiguo + marfil)**, aplicando las skills de diseño del repo; la
referencia ordreduwololo.fr y soloqchallenge.gg solo mandan en comportamiento, no en estética.
**Sin títulos visibles**: las páginas empiezan directamente por su contenido (el `h1` es
`sr-only`), y todo lo que hay que saber del torneo vive en `/reglas`.

- [x] `/` — Clasificación general: `getStandings()`. **Rediseño de cara completa**: tabla con
  columnas Puesto | Jugador | Partidas | Puntos (total con desglose por victorias y objetivos) |
  Elo | V - D | Racha | Stats (enlace a AoE4World), con
  indicador "en partida" y icono de Twitch (en directo o apagado) junto al nombre.
- [x] **Filtros en cliente** sobre la tabla: búsqueda por nombre/canal (insensible a acentos),
  pills "En partida" y "En directo", y selección única de división con el emblema de cada una
  (los 6 SVG son originales, en `src/components/division-icon.tsx`). Estados vacíos de filtro
  con "Quitar filtros".
- [x] **Iconos oficiales de liga** en la clasificación: los filtros usan el **rango 3** de cada
  liga y la columna Elo, el **rango exacto** de `rankLevel` (p. ej. `gold_2`). La resolución
  `rankLevel` → fichero vive en `src/components/league-icon.tsx` (por nombre, no por lista
  cerrada) y cae al escudo propio si el SVG no existe. Los assets, 18 SVG en
  `public/imagenes/iconos-ligas/` (carpeta renombrada, antes `iconos ligas`;
  `solo_platinum_23.svg` corregido a `solo_platinum_2.svg`).
- [x] `/partidas` — Partidas en directo de participantes (1vs1 y por equipos):
  `getLiveMatches()`, con auto-refresco opcional por `router.refresh()`.
- [x] **Remodelación de `/partidas`** (iteración con el cliente, referencia de comportamiento
  `aoe4world.com/tools/game-finder`): **una tarjeta por partida** con banda de **imagen del mapa**,
  tipo de partida, duración en vivo y **alineación completa** (todos los jugadores con su **icono
  de civilización**). Si dos participantes de la liga juegan la misma partida, sale **una sola vez**
  y cada nombre una sola vez: la agrupación y la deduplicación las resuelve el DAL, no la UI.
  - `getLiveMatches()` entrega `LiveMatch[]` (una entrada por partida): `participants` con
    `isLeaguePlayer`, `division`, `civ`, `team` (la alineación se lee de `rawJson.teams`, con
    degradado a las columnas si no es legible), `format` y `elapsedSeconds`.
  - **Solo salen las clasificatorias**: la consulta se filtra por la **familia de ladder**
    del ruleset vivo (`rankedModesWhere()`, en `src/lib/ranked-match.ts`, la misma lista que
    lee el motor) y no por la regla entera, porque una partida en curso no cumple por
    definición las otras tres condiciones —no tiene `result` ni `finishedAt`— y
    `rankedMatchWhere()` dejaría la pantalla vacía. El filtro es de **presentación**: el
    worker sigue importando en `Match` todo lo que juega un participante, quick match y FFA
    incluidos, porque el histórico entero es lo que permite recalcular sin volver a pedirlo
    todo a la API. Lo que resuelve es que `/partidas` cumpla lo que promete su copy
    ("ladder ranked"): antes, una QM FFA en curso salía etiquetada como "1vs1".
    - **El indicador "en partida" del home usa el mismo criterio** (`getStandings`, mismo
      `rankedModesWhere()`), a propósito y no por parecido. El contador "N partidas en juego"
      de la cabecera del home sale de `getLiveMatches()`, así que con dos criterios distintos
      la misma página podía marcar a un jugador "en partida" y no enseñar su partida; y la
      terminología de F7 sigue valiendo ("en partida" = estado del jugador, "en juego" = las
      partidas de `/partidas`), porque las dos cosas son la misma por construcción. Por lo
      mismo, `/partidas` y el "en partida" se degradan a la vez: si la base no responde,
      `getStandings()` lo devuelve entero como `degraded`.
  - **Filtros en cliente** por tipo de partida (1vs1, 2vs2…) y por **división** (las 6, sin rangos
    internos): la partida pasa si alguno de sus participantes de la liga es de esa división.
  - **74 imágenes de mapa** versionadas en `public/imagenes/mapas/` (minimapas del CDN de AoE4World,
    `nombre → fichero` en `src/lib/maps.ts`; un mapa sin asset cae a un recuadro con su nombre).
  - El **`CivilizationIcon`** se extrajo de `objective-icon.tsx` a
    `src/components/civilization-icon.tsx` para que las dos pantallas compartan el mismo icono.
  - Corregido el copy de `/reglas`: ya no dice que el rival mostrado es solo el primero del equipo
    contrario (ahora se ve la alineación completa); solo la puntuación sigue siendo por jugador.
- [x] `/reglas` — Conocimiento del torneo: formato, puntuación (10 puntos por victoria),
  sección de objetivos especiales y qué cuenta como partida clasificatoria.
- [x] **Requisito de participación en `/reglas`** (F11): la página gana la sección
  "Historial de partidas" (en el índice lateral y plegado, y en el cuerpo, tras
  "Formato"), donde se pide que la cuenta de AoE4World tenga el historial en
  público "para que la organización pueda revisar las partidas". Es copy de
  **requisito y transparencia** y no menciona consecuencias ni puntuación: cerrar
  el historial no altera el resultado (medido: las partidas siguen llegando a la
  API con resultado, civilización, mapa y duración y puntúan igual; solo se pierde
  el resumen, que el sitio no publica). No había recuento que actualizar porque
  `/reglas` no enumera reglas de conducta.
- [x] `/objetivos` — Los 38 objetivos especiales por grupos, con los puntos de cada uno, el
  poseedor en caliente y la clasificación deتميز (`getObjectives()`); cada tarjeta explica
  su regla.
- [x] **Limpieza visual del cliente**: fuera los títulos visibles de las páginas públicas, los
  leads descriptivos, los contadores de relleno del home y de `/objetivos`, y los textos que
  repetían lo que dice `/reglas`.
- [x] **`/streams` eliminada** (el requisito de streams se resuelve con el icono de Twitch en
  la clasificación); `getTwitchChannels()` se conserva como base de F5 y de `verify:sync`.
- [x] Estados vacíos como primera clase, responsive (clasificación en tarjetas apiladas por
  debajo de `lg` y tabla completa a partir de ahí) y
  `dynamic = "force-dynamic"` en las páginas con datos.
- [x] `StandingRow.matches` retirado del contrato público (la UI calcula `wins + losses`);
  `joinNames()` retirado de `format.ts`.

- [x] **Icono de la app desde `logo sin fondo.jfif`** (la H dorada transparente): regenera
  `favicon.ico`, `icon.png`, `apple-icon.png` y `emblema-*.png` con `npm run brand:assets`
  (`scripts/build-brand-assets.ts`). Recorte por saturación con pre-multiplicación para no
  dejar halo; `apple-icon` va opaco porque iOS no admite transparencia.
- [x] **Marca en la interfaz y ordenación** (iteración con el cliente): el wordmark de la
  cabecera es una unidad clicable (antes "AoE IV" tenía color propio y no heredaba el hover);
  emblema a 40/48 px desde `emblema-256.png` (misma H que el icono de pestaña, caja intrínseca
  = tamaño pintado para no ampliar el candidato 2x), emblema también en el pie y en `/login`;
  icono de Twitch en el filtro "En directo"; y **columnas ordenables** en cliente (asc → desc →
  orden original del servidor, `aria-sort` + chevron, "V - D" por diferencia con desempate por
   victorias, nulos al final en ambos sentidos, "Quitar filtros" no toca el orden).
- [x] **Objetivos por participante en la clasificación** (iteración con el cliente): la fila del
   home muestra un control `+X objetivos` con chevron cuando el jugador posee alguno, y al pulsarlo
   (texto o icono) se despliega bajo la fila el detalle de los objetivos que tiene ahora mismo,
   agrupados por familia, con su icono (reutiliza `ObjectiveIcon` de `/objetivos`) y sus puntos.
   El panel se lee como una sección de la propia fila (misma superficie, filete de acento,
   indentado bajo el nombre y `tbody` por participante para que el hover abarque fila y panel).
   El contrato `StandingRow.objectives` lo resuelve `getStandings()` contra el ruleset activo
   (labels del catálogo, puntos con overrides de `Setting`); sin objetivos no se pinta nada y el
   estado de desplegado se ancla a `profileId` para sobrevivir a filtros y orden.
- [x] **Partidas jugadas y puntos en una sola columna** (iteración con el cliente): la columna de
   **Partidas** (`wins + losses`, equivalente a `PlayerScore.matches`) va justo antes de **Puntos**,
   que vuelve a ser una única columna ordenable por el total y muestra las tres cifras sin hover
   (total dominante y, debajo, el desglose `N / N` de victorias y objetivos, con esas dos etiquetas
   como sub-rótulo de la cabecera). `StandingRow` sigue exponiendo
   `pointsByWins` y `pointsByObjectives` con la invariante `pointsByWins + pointsByObjectives === points`;
   los `SortKey` `winsPoints`/`objectivePoints` se retiraron al desaparecer sus columnas. Además,
   cursor de mano en todos los controles pulsables (`button:not(:disabled)` en `globals.css`),
   que Tailwind v4 dejaba en `default` y hacía indistinguible un botón de un texto inerte.

Pendiente de F4:

- [ ] Página por jugador (ficha con historial de partidas).
- [ ] Crecer `/` con las secciones previstas (últimas partidas, hitos, etc.).
- [ ] Opcional: `next/image` para avatares (exige `remotePatterns` en `next.config.ts`).
- [ ] **Assets de marca generados sin rastrear en git** (`public/imagenes/marca/`,
      `src/app/{icon.png,apple-icon.png,favicon.ico,opengraph-image*}`): o se versionan
      o el build ejecuta `npm run brand:assets` antes de compilar. Hoy un despliegue
      desde un checkout limpio serviría 404 en cabecera e icono de pestaña.

### F5 — Twitch
- Registro de app en Twitch (Client ID/Secret).
- Helix API para detectar streamers en directo + embeds. Hoy el indicador "En directo" de la
  clasificación lee `twitchIsLive`, que rellena el worker desde `twitch_is_live` de la ladder
  de AoE4World: sirve para el icono, pero sin Helix no hay embed ni garantía de frescura.

### F6 — Registro público
- [x] **Formulario de inscripción** en `/participar` (perfil AoE4World, email de contacto y Twitch opcional)
      → Server Action pública `registerPlayer` que crea el `Player` en estado `PENDING` y lo
      deja en la cola de aprobación de `/admin/jugadores`. Validación de servidor compartida con
      el alta de admin (`src/lib/player-input.ts`), honeypot y mensajes de error por campo.
- [x] **Aviso del requisito de historial en `/participar`** (F11): una nota en la
      introducción del formulario —sin campo ni casilla nuevos— avisa de que el perfil
      de AoE4World debe tener el historial de partidas en público para que la
      organización pueda revisar las partidas, y enlaza a `/reglas#historial`. Se
      eligió la introducción y no una casilla de confirmación a propósito: el cliente no
      pidió un compromiso y añadir un campo a un formulario público encarece el alta.
- [x] **Verificación del perfil contra AoE4World**: `registerPlayer` solo crea la solicitud si
      `GET /players/:id` responde (con presupuesto acotado, `src/lib/registration.ts`); un 404 da
      error de campo y cualquier otro fallo (red/429/timeout) no crea nada y pide reintentar. El
      nombre oficial se guarda en `Player.aoe4WorldName`, separado del de display (`Player.name`,
      el que escribe la persona), que la clasificación publica como subtítulo.
- [x] **Rate limiting real por IP** (`src/lib/rate-limit.ts`): contador en Postgres
      (`RateLimitCounter`, incremento atómico), IP hasheada con HMAC y cubo compartido si no hay
      IP. Valores por defecto 5/hora por IP, ajustables por `RATE_LIMIT_*`. Requisito operativo:
      pasar `npm run db:security` después de cada `db:push` que añada tablas (la tabla nueva nace
      sin RLS si no).
- [x] **Captcha Cloudflare Turnstile** (`src/lib/turnstile.ts` + `turnstile-widget.tsx`):
      verificación en servidor con `fetch` inyectable, falla cerrado y **desactivado si no hay
      `TURNSTILE_SECRET_KEY`** (en producción hay que definir site key y secret). Cierra el hueco
      de rotar `x-forwarded-for` que dejaba el rate limit.
- [x] **Email de contacto obligatorio** (`Player.contactEmail`, nullable en BD porque en el panel
      es opcional): validado en servidor y visible en la columna Contacto de
      `/admin/jugadores`.
  - **El panel también lo pide, y es opcional (#29)**: el alta de admin y el diálogo de edición
      lo escriben con el **mismo criterio que el país** —vacío es `null` ("no lo sabemos") y un
      valor escrito que no es una dirección es un error, no un `null` en silencio—, y con el
      mismo `parseEmail` de `player-input.ts` que usa `/participar`. Es opcional, y no
      obligatorio como en la inscripción pública, por el mismo motivo que el país: se puede dar
      de alta a alguien cuyo correo no se conoce, y las filas que ya estaban en la base de
      producción no lo tienen. La columna sigue siendo nullable y **no lleva `backfill`**.
      - Se añadió también a la **edición** (`updatePlayer`, que pasa de cinco a seis campos) y no
        solo al alta para que un correo mal escrito se pueda corregir sin borrar y rehacer el
        alta. Entra en el mismo criterio que el resto de campos editables: vacío es `null`.
      - El texto del error es **propio del panel** (`EMAIL_INVALID_ERROR`), como los de los
        canales: los dos formularios validan con el mismo parser, pero cada uno habla con quien
        lo rellena —en `/participar` se le habla de "te" a quien se inscribe, aquí a quien
        administra—, y lo que sí se comparte entre alta y edición es la constante, para que el
        mismo campo no se valide de dos maneras en el mismo panel.
- [x] **Reinscripción de un `REJECTED`**: un envío nuevo actualiza la fila existente (nombre,
      Twitch, email, `aoe4WorldName`, avatar) y la devuelve a `PENDING`, con el `UPDATE` filtrado
      por estado para no pisar una aprobación concurrente. `APPROVED` y `PENDING` siguen
      bloqueando.
- [x] **País del participante** (`Player.country`, nullable en BD por lo mismo que el correo):
      **obligatorio** en la inscripción pública y **opcional** en el alta de admin, que es donde se
      gestiona y donde sale en los listados. Es un `String` con el **rótulo canónico** ("República
      Dominicana") y no un enum, porque la lista admitida la cambia la organización y un enum
      obligaría a una migración sobre la base de producción.
  - **La lista admitida vive en `Setting["registration.countries"]`** (`src/lib/countries.ts`), no
      en el código: `DEFAULT_COUNTRIES` es el respaldo para cuando aún no se ha publicado nada, y
      `paises.txt` en la raíz del repositorio es la fuente de verdad para **sembrarla** (22 países,
      en el orden en que los ve quien se inscribe). `readCountries()` nunca lanza y aplica el mismo
      criterio de los rulesets, con una decisión que es propia de este documento: lo que no se
      entiende **se descarta entero**. Una lista a medias admitiría países que la organización ya
      no admite y rechazaría los que sí, sin error ni aviso más allá del log; quedarse con 20 de 22
      es peor que quedarse con la lista del código. Un fallo de la base de datos sí se propaga, y
      quien valida un formulario responde con el mensaje de "no hemos podido registrar" en vez de
      validar en silencio contra el respaldo.
  - **`parseCountry()`** vive en `src/lib/player-input.ts`, el módulo puro que ya comparten los dos
      formularios: recibe la lista viva y devuelve el rótulo canónico o `null`, resolviendo el valor
      escrito **insensible a acentos y mayúsculas** ("Republica Dominicana", " PUERTO RICO "), que
      evita que un `FormData` hecho a mano rechace a alguien que eligió bien. En el alta de admin un
      país escrito mal es un error y vacío es `null`: guardar `null` en lo primero diría "no lo
      sabemos" de algo que en realidad está mal escrito.
  - **El país elegido se contrasta con el de AoE4World** (`findCountryIsoConflict()`, en
       `src/lib/countries.ts`). Es la única comprobación de la inscripción que **no falla cerrando**:
       solo bloquea cuando los dos países se resuelven y son distintos, y entonces sale como error
       del campo `country` nombrando los dos. Se compara el `country` del perfil —un **ISO 3166-1
       alfa-2 en minúsculas**, que la API ya traía y que hasta aquí se descartaba— contra el **rótulo
       canónico** que resolvió `parseCountry()`: el código se traduce con `COUNTRY_LABEL_BY_ISO`, una
       tabla de ISO → rótulo que vive **junto a `DEFAULT_COUNTRIES`** y que hay que ampliar cada vez
       que se añada un país a la lista (los dos casos que confunden son `pr` = Puerto Rico y
       `do` = República Dominicana; `npm run verify:sync` comprueba que las dos mitades no diverjan).
       El rótulo traducido se resuelve **contra la lista admitida vigente**, no contra la del código:
       si el país del perfil ya no está en la lista publicada, no hay contradicción que afirmar.
       **Criterio de degradación**: perfil sin país (`country` a `null`), comprobación que no se ha
       podido hacer (llamada fallida o perfil inexistente) o ISO que no se puede traducir a un rótulo
       de la lista (por ejemplo `"gb"`) → **se deja pasar**, porque "no se ha podido comprobar" no es
       "está mal" y bloquear ahí dejaría fuera a alguien que sí cumple. El mensaje dice cuál de los dos
       países es cuál e invita a corregir el desplegable, porque sin nombrarlos el error no indica qué
       corregir.
  - **Interfaz**: `/participar` lo pide con un desplegable **obligatorio** cuyo primer `option`
      es "Elige tu país", deshabilitado; la lista se lee en el servidor con `readCountries()` y se
      pasa al formulario cliente, y la página declara `force-dynamic` por esa lectura. El alta de
      admin lo pide **opcional**, con "Sin especificar". El listado de participantes gana su
      columna de **País** (se pliega bajo el nombre por debajo de `lg`, como las demás
      secundarias) y el buscador encuentra por país, no solo por nombre, perfil o canal.
  - **Requisito operativo, al desplegar**: `npm run db:push` (añade `Player.country`) y después
      `npm run countries:seed`, que publica en `Setting` la lista de `paises.txt` (con `--show`
      para ver la vigente y `--dry-run` para ver el cambio sin escribir). Hasta que se siembre, todo
      funciona con `DEFAULT_COUNTRIES`. **No** hace falta `npm run db:security`: no se crea ninguna
      tabla.

### F7 — Reglas reales + pulido
- [x] **Objetivos y reglas del torneo definidos y conectados al motor** (versión 2, ver F3 y
      [`docs/PUNTUACION.md`](./PUNTUACION.md)).
- [x] **Pulido visual con las skills de diseño** (revisión completa con `design-taste-frontend`,
      `frontend-design` y la skill `impeccable` instalada a nivel local en
      `.agents/skills/impeccable`, enlazada desde `.opencode/skills/impeccable`):
      - Dirección de diseño **"crónica de guerra"**: campo pizarra, texto marfil, oro antiguo como
      único acento de marca, **Cinzel** display + **Geist** para dato (`tabular-nums`).
      - Tokens nuevos en `globals.css`: `--line-strong`, `--podium-silver/bronze`, `--live`
        (brasa, señal de emisión, separada del oro) y `--thread` (hilo dorado, único recurso de
        textura, reservado a cabecera/pie/masthead). Regla de color: oro = liga/estructura,
        brasa = en partida, morado = Twitch.
      - Chrome: hilo dorado en cabecera y pie, foco único (anillo dorado global, sin
        `focus:border`), superficies del navegador tematizadas, controles a `h-10`/`size-10`.
      - Home: masthead de torneo (estado de emisión + recuento + enlace a reglas), podio con
        medallas en Cinzel, tabla con **ordenación por columna** (`aria-sort`, 3 estados),
        "Quitar filtros" también con resultados, `EmptyState` reutilizado.
      - `/partidas`, `/reglas` (sección de objetivos + tabla de modos compacta en móvil), `/objetivos`
        (recuento por grupo, pills a 40px), `/login` y `/admin` migrados al mismo dialecto
        (fuera `neutral-*`/`amber-*`, sin doble foco). Copy normativo de `/reglas` intacto.
      - Terminología unificada: **en partida** = estado del jugador, **en juego** = partidas que
        se juegan, **en directo** = emisión (en cualquiera de las plataformas de F10).
      - `eslint.config.mjs` ignora `.agents/**` y `.opencode/**` (el binario de la skill generaba
        94 warnings); lint 0/0 y build OK.
- [x] **Pulido responsive (móvil)**: revisión completa con las skills de diseño. La clasificación
      deja el scroll horizontal y pasa a **tarjetas apiladas** por debajo de `lg` (misma
      información, con un control de orden `Ordenar` en chips que reproduce el ciclo de 3
      estados) y vuelve a la tabla completa a partir de `lg`. La tabla de admin colapsa las
      columnas secundarias bajo el nombre; `/reglas` gana un índice "En esta página" plegado y su
      tabla de modos cabe sin desplazar; la cabecera pública blinda el `min-w-0` de la nav y ajusta
      el CTA a 320 px; refuerzo de tamaño táctil en pills, botones y enlaces. Sin cambios de
      identidad, tokens ni copy.

### F7.1 — Segunda pasada responsive (móvil) ✅

La pasada anterior resolvió el *qué* (qué se ve en cada ancho) pero no el *cómo*: la web era legible
en móvil y aun así gastaba dos tercios de la primera pantalla en controles y era incómoda al
tocar. Esta pasada se hizo **midiendo el sitio desplegado con Playwright** a 320/360/375/390/412/768/1023
px —`scrollWidth` real, cajas, alturas de los targets de pulsación y tamaños de fuente— en lugar de a
ojo, y cierra cinco cosas.

- [x] **`/objetivos` desbordaba la página a 320 px** (el único desbordamiento real que había):
      `scrollWidth` 358 contra 320 de ventana. La causa no era el contenido sino el contenedor: el
      `<article>` de `ObjectiveCard` es ítem de la rejilla, así que su ancho mínimo era `auto`, o sea
      su **min-content**, y ese lo fijaba el pie de la tarjeta (poseedor + botón "Ver clasificación",
      300 px) más el `p-5`. Con `min-w-0` el pie cede donde ya se recortaba y la página deja de
      desbordar a cualquier ancho (verificado inyectando la clase en el DOM antes de escribirla).
- [x] **Objetivos plegados por debajo de `sm`**. Los `<details open>` medían los 38 objetivos
      como ~11.000 px de desplazamiento (unas 29 pantallas a 390 px), donde "el contenido es la
      página" ya no describe nada. En móvil arrancan plegados y las cinco cabeceras hacen de índice,
      con "Desplegar los grupos" para quien quiera leerlo entero; en escritorio siguen abiertos. La
      sección pasa de ~11.100 px a ~660 px. El defecto **no lo decide JavaScript**: el cuerpo se
      renderiza siempre y lo muestra el CSS (`hidden sm:grid`), así que el HTML sale entero desde
      el servidor —los 38 objetivos se pueden rastrear y un escritorio sin JS los lee— y no hay
      parpadeo al hidratar. `useSyncExternalStore` con `matchMedia` solo ajusta `aria-expanded` y el
      rótulo; una decisión explícita de la persona manda sobre el defecto del ancho.
- [x] **Barra de destinos fija en móvil** (`SiteTabBar`, en `site-nav.tsx`). El problema era que la
      nav de cabecera medía 463 px de contenido en 370 px visibles: "Reglas" quedaba **fuera de
      pantalla con un desplazamiento horizontal sin ninguna señal** de que había más. Por debajo de
      `sm` los cuatro destinos bajan a una barra fija al pie, con etiqueta corta ("Partidas" en vez
      de "Partidas en juego") y glifos propios en el dialecto de `objective-icon.tsx`. A partir de
      `sm` la nav de cabecera cabe entera y no cambia nada. La cabecera móvil baja de **119 a 59 px**,
      que era el 14 % del viewport en `sticky` para mostrar un emblema, un wordmark y dos botones.
- [x] **Controles de la clasificación plegados** por debajo de `lg`: una fila con el buscador a la
      vista, un botón "Filtros" con contador de activos y un "Ordenar" que muestra el campo y el
      sentido vigentes; el panel de cada uno se abre a petición. Los controles pasan de **226 a 56 px**
      y la primera tarjeta de jugador sube de y≈531 a y≈269 en la página real. El orden no puede
      desaparecer sin sustituto —por debajo de `lg` no hay cabeceras de tabla que pulsar—, así que
      su panel abre los mismos `SortControls` de tres estados. `StandingsFilters` se desmontó en
      `SearchField`, `StatusFilterPills` y `DivisionFilterButtons`, que usan las dos formas sin
      duplicar comportamiento.
- [x] **Cifras de la tarjeta de clasificación con rejilla fija**. `CompactStats` usaba `flex-wrap`, así
      que el alto dependía del ancho del nombre (medido entre 98 y 134 px para el mismo componente) y
      las tarjetas no se comparaban entre sí. Ahora es una rejilla de dos columnas con la **cifra
      encima de su rótulo**, no al lado: a 320 px la columna central ronda los 115 px y con el par en
      línea "Partidas 56" el número quedaba recortado. Lo que no se recorta nunca es el dato.
      Además, el `490 / 290` del total llevaba su leyenda en el subtítulo del `<th>`, que no existe
      en móvil: ahora es `CompactPointsBreakdown`, "490 de victorias + 290 de objetivos", y el total
      lleva su rótulo "Puntos".
- [x] **Áreas de pulsación y tamaño de texto**: `+N objetivos`, el enlace al perfil de AoE4World,
      "Ver clasificación" y los enlaces del pie pasan a **44 px** con `py-3`/`py-3.5` y márgenes
      negativos `-my-3` (el relleno amplía el área sin que la tarjeta crezca ni una línea); los
      enlaces del pie llevan además su propia fila en vez de un `gap` del grupo, que les daba la
      altura del interlineado (18 px). Los 44 nodos que había a `text-[10px]` y `text-[11px]` —25 en
      `/objetivos`, 19 en la clasificación— pasan a `text-xs`, que además responde al zoom del
      navegador, cosa que un tamaño fijo en px no hace.

Verificado en navegador antes y después: desbordamiento de documento 358→320 a 320 px; targets por
debajo de 44 px 20→0; nodos por debajo de 12 px 44→0; alturas de tarjeta 98–134→iguales; ninguna
cifra recortada a 320 px. Sin cambios de tokens, paleta, tipografía ni copy normativo de `/reglas`.

**Lo que sigue pendiente en móvil**: el wordmark se recorta a "LIGA HI…" de 320 a 412 px (recuperarlo
exigiría ocultar el wordmark o una de las dos acciones de la cabecera); la cabecera pública sigue en
dos filas —125 px— entre 640 y 1023 px, donde la nav no cabe en la primera fila hasta `xl`; y
`scroll-padding-top: 5.5rem` de `globals.css` queda holgado para una cabecera de 59 px. El panel
`/admin` no se ha revisado: requiere sesión y las cuatro tablas son `overflow-x-auto` con columnas
colapsadas en lugar de tarjetas, así que el patrón de la clasificación pública sigue sin llevarse
ahí.

### F8 — Panel de administración en 4 pestañas ✅

El panel dejó de ser "Resumen + Jugadores" y pasó a tener **cuatro pestañas**: Participantes
(`/admin`), Historial de partidas (`/admin/historial`), Alertas (`/admin/alertas`) e Historial
de acciones (`/admin/acciones`). `/admin/jugadores` redirecta a `/admin` para no romper
enlaces antiguos. El resumen con los contadores **se integra dentro de Participantes** y la
cola de aprobación `PENDING` se queda en esa misma pestaña, con un bloque que solo aparece
cuando hay pendientes.

- [x] **Revertir los puntos de una partida no la borra**: `Match.revertedAt` la marca como no
  puntuable y el motor la excluye de los puntos, del agregado y de los objetivos. Es
  **reversible** con `restoreMatchPoints`, y sobrevive al worker de sync porque ni
  `applyMatchUpdate` ni el `createMany` del sync tocan ese campo (una partida borrada
  reaparecería en la siguiente pasada, en ~5 min).
- [x] **La condición vive en `src/lib/ranked-match.ts`**, el módulo que ya era la fuente única
  de "qué cuenta como clasificatoria", y está en sus tres traducciones más
  `countsAsRanked()`. `verify:sync` la contrasta contra la base.
- [x] **El fallo del recálculo se compensa, no se propaga**: `recomputeScores()` es atómico, así
  que si falla lo único que queda fuera de su transacción es la marca; la compensación vuelve a
  poner `revertedAt` como estaba y borra su fila de `AdminAction`, en una sola transacción. La
  alternativa dejaría un estado que nadie puede ver (el panel diciendo "revertidos 10 puntos"
  con una clasificación que sigue contando 10). En un borrado de jugador, en cambio, **no** se
  compensa: no se puede deshacer y no queda nada incoherente, así que es un éxito con aviso.
- [x] **Historial de partidas**: solo clasificatorias, paginadas en servidor (25 por página,
  tope 100), de la más reciente a la más antigua, con filtros por jugador y por rango de
  fechas **en la URL** (el estado es compartible y la recarga no lo pierde). Columnas Fecha |
  Descripción ("X ganó a Y: +N puntos") | acción. Las revertidas se listan **marcadas** y
  ofrecen **Restaurar**; el botón de revertir solo aparece donde hay puntos que quitar. El
  filtro de clasificatorias sale del ruleset activo, como el motor.
  - **El feed mezcla también los objetivos cumplidos** (`ObjectiveEvent`, §1.6 del modelo de
    datos): lo pidió la organización ("añade cuando un objetivo se cumple") y son 38 filas
    como mucho, así que se traen enteras y se mezclan con las partidas por fecha, con la
    paginación y el contador conjuntos. Las carreras de `civilizacion` salen en cuanto se
    cierran (con la fecha de la partida que las cerró) y los 14 objetivos "en caliente"
    **solo cuando el torneo ha terminado**, con la fecha del fin. Con el filtro de `resultado`
    activo no salen: un hito no es ni una victoria ni una derrota. Etiqueta, grupo y puntos
    llegan resueltos en la fila (etiqueta, grupo, métrica y puntos), así que la interfaz no
    tiene que mirar el catálogo.
- [x] **Historial de acciones** (`AdminAction`): altas, ediciones, bajas y cambios de
  puntos, con la quien los hizo y cuándo. Se registra en la **misma transacción** que el
  cambio, así que o hay las dos cosas o no hay ninguna.
- [x] **Ordenación por columna en el panel**: `/admin/historial` ordena por **Fecha** y
  **Resultado** (por defecto Fecha, descendente) y `/admin/acciones` por **Fecha**, **Acción**
  (por el tipo) y **Admin**. La Descripción del historial es la frase del feed y las Acciones no
  son un dato ordenable, así que van sin chevron. El orden vive en la URL (`sort`/`dir`), viaja
  con la paginación y el `aria-sort` se pinta desde el orden **efectivo** que publica el DAL
  (`data.sort`), no deduciéndolo de `searchParams`: con un valor inválido, la cabecera enseña el
  orden por defecto real. La cabecera se extrajo a `src/components/sortable-header.tsx`
  (`SortableHeaderLink` para las listas de servidor, con enlace, y `SortableHeaderButton` para
  el listado de participantes, con estado de cliente) y resuelve el ciclo de tres estados, el
  `aria-sort` y el chevron una sola vez para las cuatro tablas.
- [x] **Todas las acciones destructivas piden confirmación**: `deletePlayer` (que antes borraba
  de un clic), `revertMatchPoints` y `restoreMatchPoints`. Diálogo propio sobre el `<dialog>`
  nativo (no hay librería de primitivas en el proyecto): foco al abrir y devuelto al cerrar,
  `Esc` bloqueado mientras hay una acción en curso, scroll de fondo bloqueado, y el **error se
  queda dentro del diálogo** sin cerrarlo para que se pueda reintentar. Los botones que no
  pueden fallar en silencio usan `useFormStatus` (`PendingButton`).
- [x] **El fallo del sincronizador ya no es invisible**: `syncApprovedPlayers()` deja el
      rastro de cada pasada en `Setting["sync.lastRun"]` —contadores, reintentos, pausas
      por límite de peticiones, error de ladder, error de recálculo y los jugadores que
      no se pudieron sincronizar con su motivo literal— y `/admin` enseña un aviso con
      ese motivo cuando el estado no es bueno. El rastro arrastra `lastSuccessAt`, que
      **no** avanza cuando una pasada sale a medias: es lo que contesta «¿desde cuándo
      está roto?» en una racha de fallos. Se considera vieja una pasada de más de
      `SYNC_STALE_MINUTES` (20), que es el estado que detecta al Worker sin entrar,
      donde no se escribe nada nuevo. Se distingue también «sin rastro», que no es lo
      mismo que «todo bien».
      Cierra el peor fallo que ha tenido el torneo: estuvo caído horas sin que nada lo
      dijera, porque el cron dispara por HTTP y tira la respuesta y el error por
      jugador solo iba a `console.error`.
- [x] **La llamada manual del sincronizador es una Server Action de `/admin`** (`syncNow`),
      no el botón público que estaba detrás de `/partidas`. Es para cuando el cron falla, así
      que va detrás de `requireAdmin()`: recuperar un torneo congelado es una operación de la
      organización, no un botón que cualquiera pueda machacar. Comparte el **candado global**
      con `/api/sync` (`src/lib/manual-sync.ts`, clave `public/manual-sync`, una pasada cada
      5 min), de modo que el admin y el cron de Supabase se cuentan la una a la otra y no se
      apilan pasadas contra la API de AoE4World. `/api/sync` **no se cierra**: sigue siendo el
      disparo del cron, sin cambios de comportamiento. La acción no registra `AdminAction`
      porque la pasada ya deja su rastro en `Setting["sync.lastRun"]`.
- [x] **Motor de alertas de comportamiento** (F9, ver "F9 — Alertas de comportamiento"): la
      pestaña dejó de ser un placeholder porque ya está definido qué dispara una alerta. Las
      ocho reglas, sus umbrales versionados y el modelo `Alert` están en su sección del
      roadmap. El estado del sincronizador, que sí es salud del sistema, sigue viviendo aparte,
      en `getSyncHealth()` y en el aviso de `/admin`: una alerta de comportamiento y una avería
      del sync son cosas distintas y no se mezclan.
- [x] **Editar un participante que ya está en el panel** (`updatePlayer`, en
      `src/app/admin/actions.ts`, con la interfaz en la pestaña de participantes):
      reescribe **seis** campos —`name`, `contactEmail`, `twitchChannel`,
      `youtubeChannel`, `kickChannel` y `country`— y nada más. Se quedan fuera a
      propósito el **estado** (que ya tiene aprobar/rechazar/eliminar), el
      **`profileId`** (es la identidad en AoE4World y único: cambiarlo sería cambiar
      de persona), el `aoe4WorldName`, el avatar y todo lo que escribe el worker
      (elo, división, racha, `*IsLive`), y por supuesto los puntos y el ranking,
      que ni se leen.
  - **No recalcula ni trae partidas**, al revés que el alta: ninguno de los seis
      campos entra en el motor de puntos ni en el de alertas —`PlayerScore` y `Alert`
      hablan de partidas, no de cómo se llama alguien—, así que no hay nada derivado
      que se quede viejo. Revalida solo `/admin`; la web pública es `force-dynamic`.
  - **El formulario es una foto completa de la fila**: los seis campos se reescriben
      con lo que venga y un vacío es `null` ("no tiene canal", "no lo sabemos del
      correo o del país"), que es el criterio del alta. **No hay un "no tocado"** y es
      deliberado: un contrato de "escribe solo los campos que mande el formulario"
      daría dos formas de lo mismo en el mismo panel y dejaría que un `FormData` al
      que le faltara un campo borrara el canal sin que nadie lo pidiera. Quien llama
      es un admin (lo comprueba `requireAdmin`) y el formulario se pinta con los
      valores que ya trae `AdminParticipant`.
  - **Validación compartida con el alta**: los mismos parsers y los mismos textos
      (`YOUTUBE_INVALID_ERROR`, `YOUTUBE_LEGACY_URL_ERROR`, `KICK_INVALID_ERROR`,
      `TWITCH_INVALID_ERROR`, `COUNTRY_UNKNOWN_ERROR`, `EMAIL_INVALID_ERROR`), y el
      país y el correo **opcionales** —vacío es `null` y un valor mal escrito es un
      error—. La lista se lee de
      `Setting` **solo si el envío trae país**, para que un corte al leerla no impida
      corregir el nombre o un canal. Los **tres** canales, el de Twitch incluido, se
      rechazan igual en el alta y en la edición: la asimetría que había —`createPlayer`
      guardaba el canal de Twitch inválido como `null` en silencio— era una incoherencia
      dentro del mismo panel, dos formularios para el mismo campo con dos reglas, y el
      que peor salía era el alta, que es donde el valor se escribe la primera vez y
      donde guardarlo mal no lo vuelve a corregir nadie.
  - **Concurrencia**: aprobar, rechazar y editar escriben **conjuntos de columnas
      disjuntos** —estado por un lado, los seis campos por otro—, así que ninguna
      puede deshacer lo que escribió la otra y no hace falta coordinarlas. Es lo
      contrario de la reinscripción de `/participar`, donde el estado **cambia** y su
      `UPDATE` filtra por él justamente para no pisar una aprobación. No se usa
      `Player.updatedAt` como versión: el worker escribe la fila de cada aprobado en
      cada pasada (`ladder.ts`), así que se movería solo y daría conflictos falsos.
      Lo que queda es el último `UPDATE` gana entre dos admins, y el mensaje de vuelta
      dice qué campos han cambiado (y, si no cambia ninguno, no se escribe nada).
  - **La interfaz es un formulario propio, no el del alta** (`PlayerEditDialog`, en
      `src/app/admin/player-edit-dialog.tsx`): se abre desde un botón **"Editar"** en la
      columna Acciones, a la cabeza de las acciones y en tono neutro —filete tenue, texto
      en `muted`— porque es la de uso diario y no debe competir con aprobar, rechazar ni
      eliminar, que sí cambian el estado o borran. El alta (`player-form.tsx`, con
      `createPlayer`) pide además `profileId` y estado y puede tardar segundos trayendo
      partidas; la edición no toca ninguno de esos dos y solo manda una foto de los seis
      campos, así que compartir el componente obligaría a parametrizarlo entero para ganar
      unas pocas líneas, y se copia su dialecto de campos (mismas clases, mismas pistas).
      La capa es `Modal` (foco al abrir y devuelto al cerrar, `Esc`, clic en el fondo,
      scroll bloqueado) con el cromo de tarjeta del panel.
  - **Los campos son controlados**, y no por gusto: React resetea los formularios de una
      Server Action al enviarlos, así que con valores no controlados un error de validación
      llegaría con lo escrito borrado. Manteniendo el valor en estado de React, el error
      sale en `role="alert"` **sin perder lo escrito**. El error se copia a estado propio y
      no se pinta desde `useActionState` para poder limpiarlo al abrir de nuevo.
  - **Descartar lo escrito pide confirmación**: cerrar con cambios sin guardar abre el
      `ConfirmDialog` del panel ("Seguir editando" / "Descartar"); sin cambios, cierra
      directo. El éxito cierra el diálogo y el mensaje —que dice qué campos cambiaron— viaja
      a la banda de `ActionFeedback`, que sobrevive al refresco de la ruta.
  - **El desplegable de país usa la lista viva** que la página ya lee con `readCountries()`
      (la misma que valida la acción, para que no diverjan) y, si el jugador tiene un país
      que la organización ya retiró, lo añade marcado "(ya no admitido)" en lugar de perderlo
      del desplegable; al enviarlo, `updatePlayer` lo rechaza con su propio mensaje.
  - **La edición sí registra `AdminAction`** (`PLAYER_EDITED`), dentro de la **misma
      transacción** que el `UPDATE`, como `createPlayer` y las demás: o se ven el cambio
      y su línea o no se ve ninguno. Encaja en el criterio del enum —cambia datos que
      alguien más ve— porque el nombre y los canales salen en la clasificación y en
      `/partidas`, así que no es una nota privada del panel. Solo se escribe cuando hay
      cambios de verdad: abrir el formulario y cerrarlo sin tocar nada ya salía antes de
      escribir, y sigue sin escribir nada, tampoco en el rastro.
    - **La frase dice el jugador y los campos** (`Edición de BeastWizard (AoE4World
      123456): nombre, canal de Twitch`), con los **mismos rótulos** que el mensaje de
      la acción, y se redacta en `admin-actions.ts` como todas las demás para que el
      historial y la pantalla no puedan divergir. En `details` va lo estructurado y útil
      para investigar: `name`, `profileId`, la lista de columnas en `campos` y, por
      columna, `<campo>.antes` y `<campo>.despues`. Las claves van **planas** y no
      anidadas porque el DAL aplana `details` a primitivos de un nivel (`readDetails()`
      en `src/lib/admin.ts`) y lo anidado se descartaría al leer.
    - **Requisito operativo, ya aplicado**: `npm run db:push` (añade el valor
      `PLAYER_EDITED` a `enum AdminActionType`). No hace falta `npm run db:security`:
      no se crea ninguna tabla ni columna. El valor va **al final** del enum a propósito,
      porque en Postgres `ALTER TYPE … ADD VALUE` solo añade al final y ponerlo entre los
      tipos de jugador obligaría a recrear el tipo, que sobre la base de producción es
      rehacer una columna entera por algo que se añade con una sentencia de
      milisegundos. Ese orden es además el que usa la columna "Acción" del panel al
      ordenar por tipo, así que los valores nuevos salen detrás de los ya escritos.

Decisiones que condicionan lo que viene:

- **Las Server Actions de admin viven en `src/app/admin/actions.ts`** y todas empiezan por
  `requireAdmin()`. El `matcher` del Proxy cubre `/admin/:path*` y **excluir una ruta del
  `matcher` excluye también sus Server Functions**, así que una acción fuera de `/admin`
  ni siquiera llegaría a comprobar nada.
- **El candado del sync vive en `src/lib/manual-sync.ts`** y lo comparten el disparo del cron
  (`/api/sync`) y la acción manual de admin (`syncNow`). Con dos candados, un admin podía
  encadenar pasadas mientras el cron seguía creyendo que tenía su ventana libre, que es justo
  lo que el candado existe para impedir; y al revés, el cron podía pisarle la pasada manual.
  Está fuera del endpoint porque lo que protege son **la API de AoE4World y el presupuesto de
  CPU del plan Free**, no quién pulse: por eso sigue siendo global y no por IP aunque ahora lo
  use alguien autenticado. `consumeManualSyncLock()` **lanza** si no se puede comprobar, y los
  dos consumidores tratan ese caso como "no se pasa": un `allowed: false` de verdad sería
  indistinguible de un fallo, y una pasada sin candado es justo lo que hay que evitar.
- **`classificatoryWhere()`** se exporta en `ranked-match.ts` aparte de `rankedMatchWhere()`: es
  la misma regla **sin** la marca de revertida, y existe para un solo consumidor (el historial,
  que tiene que enseñar las revertidas). No es un `options: { includeReverted }` porque una
  bandera que alguien pueda olvidar es peor que una función cuyo nombre dice lo que hace.
- Los puntos del listado de participantes salen de `PlayerScore` y no de un agregado sobre
  `Match`: es el mismo número que ve el público, sale en una consulta y respeta un ruleset
  retocado sin desplegar. Un jugador sin fila sale con `null` y no con `0`, porque `0` quiere
  decir "está en la clasificación y no tiene nada".

**Requisito operativo, ya hecho**: el schema trae la tabla `AdminAction` y la columna
`Match.revertedAt`, y ambos están aplicados en producción: `npm run db:push` seguido de
`npm run db:security`, que dejó la tabla nueva con RLS activada, cero políticas y sin permisos
para `anon` ni `authenticated` (comprobado por el propio script). Lo mismo se hizo con la tabla
`Alert` de F9: está en la lista explícita de `TABLES` de `scripts/db-security.ts` y
`npm run db:security -- --check` la da correcta. El paso hace falta cada vez que se añada una tabla
al schema, porque una tabla nueva nace con los permisos por defecto de Supabase en `public` y sería
legible con la clave publicable por la Data API.

### F9 — Motor de alertas de comportamiento ✅

F8 dejó `/admin/alertas` como un placeholder a propósito: es para **comportamientos anómalos de
los participantes**, no para salud del sistema, y no se podía enseñar nada sin inventar las
condiciones. Aquí están esas condiciones, acordadas con el cliente, y el motor que las vigila. El
estado del sincronizador sigue en su sitio (`getSyncHealth()` y el aviso de `/admin`): son cosas
distintas y mezclarlas haría que "el torneo lleva roto desde las 10:00" significara dos cosas.

**El modelo de las ocho de comportamiento.** Para cada regla hay un *flag* por partida sobre la
secuencia de clasificatorias del jugador ordenada por `startedAt`. Una **racha** es un tramo
maximal de partidas consecutivas con el flag, y el aviso sale **cuando la racha se rompe** (llega
una clasificatoria sin el flag), diciendo cuántas duró. Si el torneo se cierra con la racha
abierta, sale con el conteo que tenga (`STREAK_AT_TOURNAMENT_END`): sin ese caso, una racha que
acaba con la última partida del torneo no se avisaría nunca. Los **acumulados** se cuentan sobre
todas las clasificatorias de la ventana y avisan al cruzar el umbral. La unidad de "consecutiva" es
la secuencia completa de clasificatorias: una 1v1 en medio **rompe** la racha de "tres de equipo
seguidas con este compañero", porque lo que se vigila es el comportamiento seguido. Lo que no la
rompe son las partidas no clasificatorias, y eso está resuelto antes de llegar al motor.

| Regla | Modo | Flag por partida | Racha | Acumulado |
|---|---|---|---|---|
| **R1** `SHORT_MATCH_*` | 1v1 y equipos | `durationSeconds < 180` | 2 | cada 5, uno por múltiplo |
| **R2** `REPEATED_OPPONENT_*` | solo `rm_solo` | la partida tiene rival con `opponentProfileId` | 3 **con el mismo rival** | cada 10 **con el mismo rival** |
| **R3** `REPEATED_TEAMMATE_*` | solo `rm_team` | el mismo compañero está en mi equipo | 3 **con ese compañero** | 7 con ese compañero, **una sola** |
| **R4** `TEAMMATE_ELO_GAP` | solo `rm_team` | algún compañero a `>= 500` de elo en esa partida | 1 | — |
| **R5** `LOW_DIVISION_TEAM_GAME` | solo `rm_team` | la media de elo de la partida cae `>= 3` escalones de subdivisión por debajo de la 1v1 del jugador | 1 | — |

R2 y R3 llevan **sujeto** (el rival, el compañero), así que rachas y acumulados son *por sujeto*:
"tres contra el mismo rival", no "tres contra quien sea". El sujeto es un `profileId` de
AoE4World y puede ser de alguien que no está en la liga, que es lo normal en un torneo individual;
por eso `Alert.subjectName` guarda su nombre al escribir la fila. R2 excluye las partidas de equipo
a propósito: allí `opponentProfileId` es solo el primer rival del otro equipo y "tres veces contra
el mismo" no significaría nada.

**Qué cuenta como partida es la misma regla de siempre.** El motor no decide qué es clasificatoria:
carga con `rankedMatchWhere()` (`src/lib/ranked-match.ts`), o sea familia del ruleset de puntos,
partida resuelta, dentro de la ventana y **no revertida**. Por eso una alerta nunca puede acusar a
alguien de una partida revertida, y no hay una segunda definición que se pueda desincronizar de la
primera. Los umbrales de la ventana y la lista de modos **no** se duplican en el ruleset de
alertas: se leen del de puntuación.

**Los umbrales son configurables sin desplegar**: `Setting["alerts.ruleset"]`, versión 1, con
`DEFAULT_ALERTS_RULESET` de respaldo y una validación que **nunca lanza** (mismo patrón que
`readRuleset`/`mergeRuleset` del motor de puntos, con `warnings`). Un umbral inútil cae al valor por
defecto y avisa; una `version` que no sea la del código invalida el documento entero.

**El intervalo, y por qué no se derivan datos de la API al evaluar.**

- **Cada 5 min, colgado del sincronizador**: en `syncApprovedPlayers()`, después de
  `recomputeScores()`, se evalúan **solo los jugadores tocados** en la pasada (los que tengan
  `matchesInserted`, `matchesUpdated`, `matchesResolvedByRefetch` o `matchesAbandoned` > 0). En una
  pasada sin novedades —lo normal— no se lee ni una fila de `Match`. El coste de evaluar a un
  jugador es leer sus clasificatorias y pasarlas por un módulo puro.
- **Al revertir o restaurar una partida** (`src/app/admin/actions.ts`): ese jugador se reevalúa,
  porque su conjunto de clasificatorias ha cambiado y eso mueve rachas y acumulados por las dos
  direcciones. Va fuera de la compensación del revert a propósito: las alertas son un informe
  derivado, y un fallo suyo no debe dar la vuelta atrás un cambio que ya está bien.
- **Comprobación completa bajo demanda**: `npm run alerts:check`, que además imprime las **rachas
  abiertas** (tramos que todavía no han terminado y que aún no avisan de nada).
- **Al descargar el informe del panel**: `GET /admin/alertas/reporte` (detrás de `requireAdmin()`) es
  el botón de la pestaña y devuelve un CSV para Excel con dos bloques —alertas disparadas y rachas
  abiertas en curso—, con la ventana del torneo, la versión del ruleset y la fecha de generación en la
  cabecera. **Hace la comprobación completa antes de generarlo** (`evaluateAlerts({ full: true })`,
  idempotente) para que describa el estado recién calculado y no el de la última pasada del
  sincronizador. Vive en `src/lib/alerts/report.ts` y no en el DAL del panel: un informe no degrada a
  medias, sale entero o no sale.
- **Cierre de torneo**: una única evaluación completa cuando `now >= window.to`, marcada en
  `Setting["alerts.tournamentClose"]` para que el cron no la repita cada 5 min desde el `to`. La marca
  guarda **la ventana**, no solo una fecha, así que si se alarga el final del torneo el cierre se
  vuelve a hacer.
- **Cero llamadas nuevas a la API de AoE4World al evaluar.** Todo sale de `Match` y de su
  `rawJson`. La única excepción es la derivación puntual de los cortes de división de R5, y no la
  hace el motor: se cachean en `Setting["alerts.divisionCutoffs"]` y se derivan a mano con
  `npm run alerts:cutoffs`. Sin cortes, R5 se **omite con aviso** y las otras siete reglas siguen.

**Por qué R5 necesita cortes y de dónde salen.** Hay que comparar la media de elo de una partida
de equipos (un número, `average_mmr`) con la división 1v1 del jugador (un `rank_level`, `gold_3`), y
eso exige saber a partir de qué rating empieza cada subdivisión **en la ladder de esa partida**:
`average_mmr` es elo de equipos, y los cortes de otra ladder darían escalones que no existen.
La API **no lo publica**: `rating_min`, `rating_max` y `rank_level` los ignora en silencio y siempre
devuelven la página 1, así que la única vía es recorrer la ladder por páginas. Se hace con
búsqueda binaria sobre bloques contiguos —la misma técnica que `src/lib/simulation/select.ts`—, con
la corrección de límites por páginas vecinas. Medido en septiembre de 2026: **151 peticiones** para
`rm_team` (50 847 jugadores, 1 017 páginas) y **130** para `rm_solo` (23 735, 475). Es un trabajo de
una sola vez, cacheado y refrescable a mano (`npm run alerts:cutoffs`, con `--show` para verlo), y
el motor no lo hace nunca porque 288 × 130 peticiones al día no caben en ningún presupuesto. Una
derivación **incompleta** (alguna subdivisión vacía) se **descarta**: con el catálogo a medias, la
cuenta de escalones sería falsa sin que nada fallara.

**Lo que degrada en vez de romper.** Un `rawJson` ilegible no lanza: esa partida no aporta flags a
las reglas de equipo y sale en el resumen como `unreadableMatches`. Un jugador sin `rankLevel` 1v1
no se evalúa con R5, con aviso. Es la dirección segura: una regla que no se puede calcular no puede
acusar a nadie.

**Lo que ve la pestaña.** `getAdminAlerts()` publica las alertas disparadas paginadas, de la más
reciente a la más antigua, y `getAdminAlertRules()` los **umbrales vivos** más la ventana del torneo:
sin ellos, el copy de las reglas escrito en la interfaz mentiría en cuanto se retocara un número en
`Setting` (es el mismo pendiente que tienen `/reglas` y `/objetivos` con los del ruleset de puntos). Las
etiquetas de regla y de tipo (`ALERT_RULE_LABELS`, `ALERT_KIND_LABELS`) viven en el dominio y las
comparten la pestaña y el CSV, para que no puedan divergir en cómo llaman a la misma regla.

**Filtros y orden de la pestaña.** La tabla ya no es fija: acepta `playerId`, `from`/`to`, `regla`
(los diez valores de `AlertRule`) y `tipo` (los cuatro de `AlertKind`), y orden por `fecha` (por
defecto, descendente), `jugador`, `regla`, `sujeto` o `conteo`. Las etiquetas de los desplegables
salen de `ALERT_RULE_LABELS` / `ALERT_KIND_LABELS` y el valor que viaja en la URL es el literal
del enum, que se compara literal. **No** hay filtro por **sujeto**, **detalle** ni **conteo**, y
es una decisión y no un hueco: el sujeto es un rival o compañero que puede no estar en la liga y
no hay lista de la que elegir; el detalle es una frase redactada por el motor (filtrar por un
trozo de texto libre es un buscador, no un filtro); y el conteo se escanea con la vista. Por el
mismo motivo la columna **Detalle** y el distintivo de tipo tampoco son ordenables —el orden por
regla agrupa por familia, y el tipo se recorta con `?tipo=`. El informe descargable y las reglas
siguen en la cabecera aunque la tabla degrade (son acciones independientes de la lectura), y el
estado vacío con filtros dice que hay filtros en vez de "todavía no hay alertas".

**Verificación**: `npm test` cubre el motor con secuencias sintéticas, sin base de datos: rachas y su
ruptura, los múltiplos de 5 y de 10, R3 por pareja, el borde 499/500 de R4, el borde de escalones de
R5 y su omisión sin cortes, el cierre de torneo, la idempotencia de las claves de dedupe, la
validación del ruleset y la lectura de la caché de cortes. Reparto: 35 casos en
`tests/unit/lib/alerts/compute.test.ts`, 30 en `rules.test.ts` y 19 en `division-cutoffs.test.ts`, con el
catálogo de subdivisiones en `tests/unit/lib/divisions.test.ts`. `npm run alerts:check` es la comprobación
contra la base de verdad, y es idempotente: la segunda pasada con los mismos datos inserta 0 filas.

### F11 — Transparencia del historial de partidas ✅

Las ocho reglas de F9 miran **las partidas que ya tenemos**. Esta fase añade las dos que
miran **por qué puede que no las tengamos**, que es un problema distinto y del que el
motor puro no puede enterarse: no sale de `Match`, sino del juego del jugador y de una
ruta del sitio de AoE4World.

**El problema.** En AoE4 hay un toggle "Share History" (menú principal -> retrato ->
Match History) y el FAQ de AoE4World dice que los *game summaries* de un jugador **solo
existen si está en "Public"**. Con el historial cerrado, sus partidas dejan de
publicarse: sigue jugando, nosotros no las apuntamos, y la clasificación se queda corta
sin que nada lo diga. **La API no expone ningún campo que lo diga.**

**El motivo de la regla es la transparencia del torneo**, y eso es lo que decide el
tono: la organización quiere poder consultar cualquier partida de un participante. No
es una regla de conducta ni de juego, así que **la frase dice lo que se ha comprobado y
nunca la causa**: nadie ha hecho nada malo, hay un ajuste del juego. Por eso el resumen
es "Su historial de partidas no es público" y no nada que suene a acusación; el equipo no
sabe si el jugador cambió el ajuste, si se le olvidó, si la API dejó de publicar su
historial o si el problema es nuestro.

#### La sonda: fuera de la API, y eso hay que saberlo

La comprobación sale a una ruta del **sitio**, no a la API:

```
HEAD https://aoe4world.com/players/{profileId}/games/{gameId}
  200 -> la partida tiene summary -> el historial está público
  404 -> no lo tiene
```

Comprobado contra producción el 2026-10-05: el `HEAD` funciona y devuelve **0 bytes**
(solo el código), no hace falta el parámetro `sig`, y el slug solo importa por su
**prefijo numérico** (`/players/21050396` y `/players/21050396-` valen; `/players/2105039`,
un dígito menos, ya da 404), así que la URL se compone con el `profileId` pelado. Casos
de referencia: el jugador `7328774` tiene el historial **cerrado** y las 6 partidas suyas
`processed` dan 404; el `21050396` lo tiene **abierto** y da 200.

Dos consecuencias de que sea una ruta **sin documentar**:

1. **No hay rate limit declarado y nadie nos ha dado permiso.** Es el mismo servidor que
   sirve la API, así que se le habla con su mismo `User-Agent` y se le trata con el mismo
   respeto, y el presupuesto es el que hace que no sea un problema: un `HEAD` de 0 bytes
   por partida, **tres partidas como mucho y solo por jugador cada 12 horas**. Con el
   torneo de treinta participantes son menos de cinco peticiones al día. Si el volumen
   creciera, lo que toca es **avisar a AoE4World por su Discord**, que es lo que pide su
   documentación antes de un uso de este tipo; no subir el ritmo por las bravas.
2. **Un cambio en el sitio rompe el sondeo en silencio**, y no hay forma de aviso propio: por
   eso el resultado se cachea en `Player.historyPublic` y el motivo va al rastro de la
   pasada (`historyError`).

#### Las dos reglas

| Regla | Qué comprueba | De dónde sale |
|---|---|---|
| `HISTORY_NOT_PUBLIC` | El toggle "Share History" del jugador, a través de si sus partidas tienen summary | `HEAD` al sitio, 3 partidas |
| `MISSING_LADDER_MATCHES` | La ladder registra una partida que no nos ha llegado | `Player.ladderGamesCount` / `ladderLastGameAt` y nuestra `rm_solo` más reciente |

**La segunda existe porque la primera tiene un agujero exacto**: solo puede mirar
partidas que ya tenemos. Si alguien cerrara su historial **y** sus partidas dejaran de
aparecer en la API, no habría ningún `gameId` que sondear y no se comprobaría nada. La
segunda mira el otro lado —lo que AoE4World **sí** publica de ese jugador, su fila de la
ladder— y lo compara con lo que nosotros tenemos. Sale de las columnas que ya se
rellenaban de la ladder (F11), así que **no cuesta ninguna llamada nueva**.

**No hemos observado este caso en los 136 jugadores de `rm_solo` medidos**, y aun así la
regla está: es una guarda de barrera contra el fallo que más caro saldría (una
clasificación incompleta y nadie enterándose), y su coste es una agregación por jugador
sobre un índice que ya existe. **Quitarla** no costaría nada en peticiones, pero dejaría
ese agujero abierto, que es justo el que no se puede detectar desde dentro.

#### Las condiciones, y por qué cada guarda existe

`MISSING_LADDER_MATCHES` avisa si se cumple todo esto:

1. `ladderGamesCount >= 10`. **Sin este mínimo saltaría sola a mitad de torneo** con
   cualquiera que hubiera jugado diez partidas en septiembre y nada desde entonces: su
   `last_game_at` es viejo y no tendríamos ninguna partida, que es exactamente la forma en
   que se lee "no está jugando" como "nos está ocultando algo". Diez partidas de ladder
   son el mínimo que dice "esto es alguien que compite".
2. `ladderLastGameAt` **dentro de la ventana** del torneo. Si su última partida de ladder
   es de antes del torneo, es la de alguien que todavía no ha entrado a jugar.
3. La ladder va **más de `LADDER_PUBLICATION_LAG_MINUTES` (75 min) por delante** de
   nuestra `rm_solo` más reciente. El margen existe porque el `last_game_at` de la ladder
   **va por delante de lo que vemos**: medido el 2026-10-05 sobre 136 jugadores, entre 1 y
   71 minutos, porque la ladder se actualiza en tiempo real al empezar la partida y la
   fila se publica después. Sin el margen, avisaríamos de todos los jugadores que acaban
   de jugar.
4. El **filtro es `rm_solo`**, no "clasificatoria". Si el jugador juega `rm_team` y lo que
   le falta son las de `rm_solo`, comparar contra las de equipos taparía la alarma sola,
   porque su última de equipos sí nos habría llegado.

Cuando no tenemos **ninguna** partida `rm_solo` en la ventana, el signo de la comparación
es el contrario —"¿hace ya más de 75 minutos que la ladder dice eso y no lo tenemos?"—,
que es lo que evita que un jugador recién aprobado salte solo porque su primera partida
del torneo todavía no se ha publicado.

**Las tres partidas del sondeo y solo `processed`.** Una partida en curso (`state: "new"`)
y una con el replay invalidado tras una actualización del juego (`state: "invalid"`, que le
ocurre a alrededor del 5 % de las partidas de jugadores normales) dan **404 con el historial
abierto**. Con una sola partida, ese falso negativo sería la regla entera; por eso se
sondean **las tres más recientes que se sepa resueltas** y se exige que **las tres** den
404. Un solo 200 cancela: es una respuesta positiva y no hay nada más que buscar. El
`state` no hay que pedirlo a nadie —la API lo manda en cada partida y viaja dentro de
`Match.rawJson`—, así que el filtro no cuesta nada.

#### Dónde vive, y qué no hace

El sondeo y la escritura en `Player` van en el **worker del sincronizador**, en
`src/lib/history-checks.ts`, y no dentro de `computePlayerAlerts()`: el sondeo es una
llamada de red a una ruta que no es la API, y el motor de alertas es **puro** y se
comprueba con secuencias sintéticas. Lo que sí está en el dominio de alertas es el valor
del enum (`AlertRule`) y la **frase**, en `src/lib/alerts/rules.ts`, cuyo `switch` es
exhaustivo para que una regla sin frase no pueda llegar a la base.

**La fila de alerta se escribe junto a las columnas**, en el mismo sitio y a propósito: la
corrección de un estado **es** una columna —el jugador abre el historial y se ve en
`Player.historyPublic` sin recalcular nada—, así que escribirlas en sitios distintos
obligaría a cruzar dos tablas para responder "¿esto sigue pasando?".

**Un `unknown` no escribe nada.** Ni columnas ni alerta: un timeout, un `5xx` o un error de
red **no** significan "historial cerrado", y publicar eso por un corte de red sería una
afirmación que no se sabe. El jugador vuelve a la cola en la siguiente pasada.

**La `dedupeKey` de las reglas de estado es estable por (regla, tipo, jugador)**, sin
partida ancla ni número. Es la excepción documentada del resto: un estado no tiene remate
—su corrección es que la condición deje de cumplirse— y como estas reglas se reevalúan
cada 5 minutos, una clave con el número medido insertaría una fila nueva cada 12 horas y
para siempre por jugador. Con la clave estable, la segunda pasada inserta 0 filas y la
alerta sigue siendo la que se escribió la primera vez. Lo fija un test explícito en
`rules.test.ts` porque es una propiedad que se rompe sin que nada falle.

#### La cara pública de la regla

El copy de la regla vive en dos sitios y en ninguno pide nada al margen del formulario:

- **`/reglas`**, sección "Historial de partidas" (en el índice lateral y plegado, y en el
  cuerpo tras "Formato"). Dice que la cuenta con la que se compite tiene que tener el
  historial en público **para que la organización pueda revisar las partidas**, y sitúa el
  ajuste en el propio juego (*Share History*, en el retrato del jugador).
- **`/participar`**, una nota en la introducción del formulario, sin campo ni casilla
  nuevos, con enlace a `/reglas#historial`.

La redacción es de **requisito y transparencia y no menciona consecuencias**: cerrar el
historial **no** cambia la puntuación (las partidas siguen llegando a la API con
resultado, civilización, mapa y duración, y puntúan igual; lo único que se pierde es el
*summary*, que el sitio no publica), así que ningún texto puede insinuar lo contrario ni
usar lenguaje de sanción. Es la pieza que F11 tiene que proteger: el motor avisa para que
la organización mire, no para acusar.

En el panel, la pestaña de Alertas ya lista `HISTORY_NOT_PUBLIC` y
`MISSING_LADDER_MATCHES` con su etiqueta en español (los **diez** valores de `AlertRule` y
los **cuatro** de `AlertKind` salen en los filtros), y la ventana "Reglas" explica las dos
comprobaciones de estado además de las cinco de comportamiento. El listado de
participantes **no** pinta `Player.historyPublic`: la señal accionable ya está en Alertas
y una columna de tres estados cacheados 12 h en una tabla ya densa añadiría ruido, además
de exigir un campo nuevo en el contrato del DAL.

#### Requisito operativo

Ya aplicado: `npm run db:push` (los dos valores nuevos de `AlertRule`, `STATE_DETECTED` en
`AlertKind` y las cuatro columnas de `Player`) y `npm run db:security -- --check`, que
sigue dando las ocho tablas correctas. **No** hace falta volver a aplicar `db:security`:
no hay tabla nueva.

### F10 — YouTube y Kick en el tratamiento de canales de directo ✅ / por desplegar

Hasta aquí el "treatment" de canales era solo de Twitch, y con una comodidad que no
se puede repetir: `twitch_is_live` viene en la **ladder de AoE4World**, así que el
indicador de "en directo" no costaba una sola llamada. Aquí se añaden **YouTube y
Kick**, y la diferencia de contexto es justo lo que decide el diseño: **para estas
dos plataformas el directo hay que preguntarlo fuera**, porque AoE4World no publica
ni los canales ni si están emitiendo.

**Lo que se decide.**

- **El canal lo escribe la persona o el admin, y AoE4World no lo respalda.** A
  diferencia de Twitch, donde `Player.twitchUrl` da un plan B cuando el panel no
  tiene canal, aquí las columnas `Player.youtubeChannel` y `Player.kickChannel` son
  la única fuente. Se piden en el alta de admin **y** en la inscripción pública, con
  los mismos parsers (`src/lib/player-input.ts`) y el mismo criterio de "valor
  inválido = error": como no hay respaldo, un canal mal escrito no lo arregla nadie en
  la siguiente pasada, así que guardarlo como `null` en silencio mentiría.
- **Formas canónicas**: el handle de YouTube **sin arroba** (es la forma que consume
  `forHandle` de la Data API y la que se compone en la URL) y el slug de Kick en
  minúsculas. Los dos parsers aceptan el `@nombre` y la URL con o sin esquema, con o
  sin `www.`, con parámetros y con barra final.
- **Las URL `/c/…` y `/user/…` de YouTube se rechazan con motivo explícito.** No son
  derivables a un handle (el identificador del canal es un `UC…` que no lo contiene)
  y adivinarlas sería guardar un canal que no existe; el formulario dice "usa el
  @nombre del canal", que es la información que le sirve a quien escribe.
- **La detección va en el worker de sincronización, no en el DAL ni en la web.** El
  despliegue es un Worker del plan **Free** (10 ms de CPU por invocación, ~500 ms por
  pasada, ver [`docs/OPERACION.md`](./OPERACION.md#el-límite-de-cpu-del-plan-free)), así que preguntar a dos APIs externas en cada visita a la web
  sería una petición saliente por lectura de página, con la cuota de YouTube expuesta
  a cualquier visitante. Va **una vez por pasada**, en `syncApprovedPlayers()`, después
  del recálculo y de las alertas, y con la misma tolerancia: si falla, la pasada
  sigue y el motivo va al rastro.
- **Un único punto de salida HTTP** (`src/lib/streams/http.ts`), con timeout corto,
  separación mínima entre peticiones y *backoff* con jitter ante 429/5xx. Es un
  módulo aparte y no una ampliación del cliente de AoE4World: son APIs distintas, con
  su propia autenticación y sus propios límites, y un 429 de una frenaría a la otra.
- **El `channelId` de YouTube se resuelve una vez y se cachea** en
  `Setting["streams.youtube.channel.<handle>"]` (con la fecha de resolución y 30 días
  de margen). `channels.list?forHandle=@…` es la llamada cara y `search.list` exige un
  `channelId`, así que sin caché serían dos unidades de cuota por participante y por
  pasada para aprender cada cinco minutos algo que **no cambia**. También se cachea
  el "no existe", que es lo más probable: repetirlo cada pasada sería la forma más
  rápida de vaciar la cuota.
- **Se escribe solo lo que cambia.** Una pasada sin novedades (288 al día) no toca ni
  una fila de `Player`, y lo que no se ha podido comprobar **no se escribe**: un
  `false` puesto por un fallo publicaría "no está en directo", que es una afirmación
  que no se sabe.

**Coste por pasada, con N participantes con canal.**

| | Peticiones | Notas |
|---|---|---|
| Sin ningún participante con canal | **0** | Se sale antes de crear el cliente HTTP: ni red, ni `Setting`, ni escrituras |
| Por participante con una sola plataforma | 1 | `search.list` de YouTube o `GET /api/v2/channels/<slug>` de Kick |
| Por participante con las dos | 2 | Con el `channelId` ya cacheado, que es el caso normal a partir de la segunda pasada |
| Resoluciones de handle nuevas | +1 cada una | `channels.list`, una vez por canal y de nuevo pasado el mes |
| Separación entre peticiones | `STREAMS_MIN_REQUEST_INTERVAL_MS` (200 ms) | El coste dominante es la espera, que no es CPU |

Con el tope de `STREAMS_MAX_CHECKS_PER_RUN` (24 comprobaciones = 12 participantes con
las dos plataformas) el máximo absoluto por pasada son 24 peticiones, y los que se
quedan fuera salen como `skipped` en el resumen, nunca como un error. Con el torneo
actual el tope no muerde. La CPU añadida es de parsear unas decenas de respuestas
JSON pequeñas, frente a los ~500 ms que ya gasta la pasada: es ruido al lado del
presupuesto que manda.

**Degradación sin credenciales.** `YOUTUBE_API_KEY` es la **única** credencial nueva
y es **opcional**, en el mismo sentido que el captcha: sin ella la detección de
YouTube **no se hace** (ni una petición), `Player.youtubeIsLive` se queda en `false`
y sale un aviso en el rastro de la pasada. El proyecto arranca y funciona sin
configurar nada. Kick **no necesita clave**: si su endpoint no responde, el estado se
queda en su valor anterior y el motivo va al aviso, nunca un error que tumbe la
pasada.

**El riesgo del endpoint de Kick.** `https://kick.com/api/v2/channels/<slug>` es un
endpoint **no documentado**: no hay developer portal, ni documentación, ni registro,
ni cuota declarada. Se usa porque es lo único que hay sin clave ni registro (la
alternativa sería no detectar nada en Kick, o hacer *scraping* del HTML, que es
frágil y bastante menos honesto), y porque devuelve exactamente el dato que se busca.
Si algún día deja de funcionar, cambia de forma o pasa a pedir credenciales, el
resultado es que **el estado se queda en `false` y aparece un aviso**: la respuesta
que no se entiende se convierte en `null`, no se escribe nada y la pasada continúa.
Por eso el módulo está tratado como degradable y no como fuente fiable, y por eso su
docblock dice qué hacer cuando eso ocurra (no tocar el archivo: aceptar que Kick se
quede sin detectar y que la organización decida si merece otra vía). El riesgo
aceptado es, en el peor caso, **que la web no muestre el directo de un canal de
Kick**, nunca que el torneo se quede sin sincronizar.

**Requisito operativo, al desplegar**:

1. `npm run db:push` (añade `Player.youtubeChannel`, `Player.kickChannel`,
   `Player.youtubeIsLive` y `Player.kickIsLive`). **No** hace falta
   `npm run db:security`: no se crea ninguna tabla y las columnas nuevas heredan la
   postura de `Player`.
2. Definir `YOUTUBE_API_KEY` en el panel del Worker (Settings → Variables and
   Secrets), como secreto, y **además** en *Build variables and secrets* del trigger
   de Workers Builds, que es otra lista distinta: la del proceso de build, no la del
   Worker. **Sin ella no pasa nada**, pero tampoco se detecta ningún directo de YouTube;
   con ella definida se detecta. Ver
   [`docs/DESPLIEGUE.md`](./DESPLIEGUE.md#los-dos-sitios-del-panel-secretos-del-worker-y-build-variables).

**La interfaz de los tres canales** (`@design-ux`, ya hecha). La capa de datos
publica los cuatro campos por participante (`StandingRow` y `AdminParticipant`) y el
enlace sale de `twitchChannelUrl()` / `youtubeChannelUrl()` / `kickChannelUrl()`; la
interfaz solo pinta:

- Los tres canales se piden en `/participar` y en el alta de admin
  (`name="youtubeChannel"` y `name="kickChannel"`, opcionales, con la pista de la
  forma canónica de cada uno: el `@nombre` de YouTube, el slug de Kick).
- En la clasificación pública se muestran como **icono-enlace junto al nombre**, cada
  uno con su glifo (`youtube-icon.tsx`, `kick-icon.tsx`, originales y a
  `currentColor`, como el de Twitch). El distintivo "En directo" se pinta **solo en
  la plataforma que emite y con su color**; una plataforma sin canal no pinta nada.
- El filtro "En directo" de la clasificación cubre **las tres plataformas** (basta con
  que emita en una) y su marca son los tres iconos, no solo el de Twitch.
- El listado de participantes cambia la antigua columna de texto de Twitch por una de
  **Canales** con los tres icono-enlace (no ordenable: son enlaces), y su buscador
  encuentra también por canal de YouTube y de Kick.

La detección de directo en **Twitch** por Helix sigue siendo F5, y no se toca aquí.

**Verificación**: `npm run verify:sync` incorpora dos bloques de comprobaciones puras,
sin base de datos y sin red. Uno de **los parsers y los normalizadores** (las tres
formas de escribir un canal, los dos formatos rechazados de YouTube, los rangos de
cada plataforma, el `File` que no debe lanzar, que todo lo que un parser guarda lo
acepta el normalizador del DAL, y las tres URLs). Y otro de **la lectura de las
respuestas de las dos plataformas**, con un cliente HTTP falso: que
`liveBroadcastContent` distingue una emisión en curso de una ya terminada (el caso
que separa pintar el icono de no pintarlo), que un payload raro de YouTube avisa en
vez de leerse como "no hay directo", y que en Kick lo que no se entiende es `null`,
un `404` es un canal que no existe y un fallo de red no se convierte en un `false`.

## Requisitos del cliente (frozen)

Vienen del encargo inicial. Si alguno cambia, se actualiza esta sección antes de tocar el código.

1. **Torneo individual**: todos los jugadores apuntados juegan partidas clasificatorias y suma el **mayor número de puntos**; no hay equipos.
2. **Clasificación siempre actualizada** ("en todo momento"): la tabla de puntos refleja el estado real sin que el usuario tenga que recargar a mano.
3. **Partidas en directo**: listar las partidas que se estén jugando en ese momento en las que participa alguien del torneo.
4. **Streams**: si un participante tiene canal de Twitch enlazado y está en directo, la web lo muestra.

## Decisiones pendientes

- [x] **Qué cuenta como partida clasificatoria y cómo se puntúa.** Resuelto en la versión 2 de
  las reglas: [`docs/PUNTUACION.md`](./PUNTUACION.md) es la fuente de verdad (10 puntos por
  victoria clasificatoria + 38 objetivos especiales, solo el primero los cobra). La rama de
  reglas antigua (`docs/f3-puntuacion`) se borró al empezar de cero. Queda por validar la
  tabla de puntos con el cliente; el agregado sigue versionado por si cambian las reglas.
- [x] **Ventana de clasificatorias y duración mínima.** La ventana **sí aplica** y es
  configurable sin desplegar (D-02: `[from, to)` sobre `startedAt`, en el ruleset); lo que
  queda por decidir son las fechas oficiales y si el fin se deja abierto. La **duración
  mínima** (D-03) sigue sin existir: es un parámetro del ruleset cuando el cliente lo pida.
- [x] **Cómo se cumple el requisito 2 ("en todo momento")**: resuelto con **Supabase Cron**
  (`npm run db:cron`, [`scripts/db-cron.ts`](../scripts/db-cron.ts)). Un job de `pg_cron` llama
  cada 5 minutos por HTTP a `POST /api/sync` con `pg_net`, y la web relee el servidor en cada
  visita (el DAL ya es `force-dynamic`), así que no hace falta revalidación por etiqueta. El
  workflow de GitHub queda solo como red de seguridad, porque GitHub retrasa su `schedule` a una
  pasada cada 4-6 h. El reloj **no** puede ser un Cron Trigger de Cloudflare: en el plan Free cada
  invocación tiene 10 ms de CPU y una pasada del sync gasta ~500 ms, así que un cron nativo cada
  5 minutos acaba matando el *isolate* con el error 1102. Se probó y se retiró (commit `459ed27`);
  el detalle medido está en [`docs/OPERACION.md`](./OPERACION.md#el-límite-de-cpu-del-plan-free).
- [ ] Rival en partidas por equipos: el schema tiene un único par de campos, así que en
  `rm_2v2` y superiores se guarda solo el primer jugador del equipo contrario (el equipo
  completo está en `rawJson`). Si las reglas necesitaran "partida contra dos rivales", habría
  que añadir columnas.
- [ ] **Detectar si un canal de Twitch está en directo**: la clasificación ya muestra el icono
  con `twitchIsLive` (lo rellena el worker desde el campo `twitch_is_live` de la ladder de
  AoE4World), pero sin la app de Twitch y Helix (F5) no hay embed ni frescura garantizada.

## Consideraciones técnicas / riesgos

- **Next.js 16**: breaking changes respecto a versiones anteriores. Revisar docs en `node_modules/next/dist/docs/` antes de programar.
- **Supabase + migraciones**: no soporta *shadow database* → usamos `db push` en dev (en producción convendrá `prisma migrate` con cadena directa o revisar estrategia).
- **La base de datos es la de producción y no hay migraciones**: no hay entorno de staging, así que un cambio de datos va con copia de seguridad previa y una forma de volver atrás. `pg_dump` no viene con el proyecto (no hay cliente de Postgres instalado): se usó el de los binarios de PostgreSQL 17 de EDB, descargados fuera del repo.
- **`db push` no gestiona RLS ni GRANTs**, solo el schema de Prisma. La postura de seguridad de `public` vive en `scripts/db-security.ts` y hay que comprobarla con `npm run db:security -- --check` después de cada `db push` (y volver a aplicar el script si se creara una tabla nueva). Detalle en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md) §7.
- **Prisma 7**: usa `prisma7.config.ts`, generador `prisma-client` (ESM), carga `DATABASE_URL` desde `.env` vía `dotenv/config` y requiere *driver adapter* (`@prisma/adapter-pg`) para instanciar el cliente (`src/lib/db.ts`).
- **Next.js 16**: *middleware* → **Proxy** (`src/proxy.ts`). Los helpers de tipos `LayoutProps<"/ruta">` se generan con `next dev/build/typegen`.
- **Supabase Auth**: sesiones en cookies SSR; el Proxy refresca el token y aplica las cabeceras anti-caché, el DAL hace la verificación segura.
- **Rate limits AoE4World**: resueltos en F2 (backoff exponencial con jitter, separación mínima entre peticiones, pausa global ante `Retry-After`). Pendiente solo el ritmo del cron en producción y si hace falta cacheo.
- **El plan Free de Cloudflare es el techo del sync**: 10 ms de CPU por invocación contra los ~500 ms que gasta una pasada. Un disparo **esporádico** se tolera (el *isolate* tiene flexibilidad para pasarse de vez en cuando); uno **consistente** se mata con el error 1102. Por eso el reloj es Supabase Cron y no un Cron Trigger, y por eso el candado global de las pasadas a mano (la del admin y la del cron) es de 5 minutos. Si algún día se necesita más margen, la salida es Workers Paid (5 $/mes); el *handler* `scheduled` ya se probó y funcionaba.
- **Los Cron Triggers se declaran explícitamente**: en `wrangler.jsonc`, `"triggers": { "crons": [] }`. No es decorativo: `wrangler deploy` solo reemplaza los triggers existentes por los del archivo, y con la clave `undefined` **los deja como están**. Quitar la clave al retirar el cron nativo dejó el trigger vivo disparando cada 5 minutos contra un Worker sin handler `scheduled` hasta que se declaró el array vacío.
