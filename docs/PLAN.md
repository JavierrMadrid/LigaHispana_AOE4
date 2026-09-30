# Plan de desarrollo — LigaHispana_AOE4

Seguimiento de la Liga Hispana de Age of Empires IV. Torneo **individual** con clasificación calculada a partir de las partidas de los participantes, obtenidas de la API de [AoE4World](https://aoe4world.com/api).

> **Regla de puntos**: puntúa **cualquier partida clasificatoria**, no solo la ladder *ranked* 1v1 (`rm_solo`). Por eso `Match` guarda `leaderboard` y `rawJson`: el motor de F3 filtra y puede recalcular sin volver a pedir todo el histórico a la API. `rm_solo` es el valor por defecto porque hoy es el caso mayoritario, no porque sea el único válido.

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
| Tareas en segundo plano | **Supabase Cron** (`pg_cron` + `pg_net`) que llama por HTTP al Worker; workflow de GitHub como red de seguridad | El reloj vive en la base de datos, no en el Worker: en el plan Free de Cloudflare el sync no cabe en el presupuesto de CPU (ver README, "El límite de CPU del plan Free") |
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
- [x] `/admin/jugadores`: alta por `profileId`, aprobar/rechazar/eliminar
- [x] Ampliar el modelo de datos (objetivos, snapshot de clasificación) — se hace en F3

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
            startedAt, finishedAt?, durationSeconds?, points, rawJson, createdAt)
PlayerScore(playerId, ruleSetVersion) pk, rank, total, wins, matches, breakdown JSON, computedAt
Setting    (key PK, value JSON, updatedAt)
```

Notas:
- `gameId` se guarda como `String` y la unicidad es **por jugador** (`@@unique([playerId, gameId])`): el torneo es individual y dos participantes pueden jugar la misma partida, cada uno con su propio resultado y sus puntos.
- `rawJson` conserva la partida completa de la API para poder recalcular puntos si cambian las reglas.
- Se guardan **todas** las partidas del jugador, no solo las clasificatorias: el filtro por `mode` y por fecha lo hace el motor. Así también salen las "partidas en directo" (F4) del mismo histórico.
- `leaderboard` es una `String` (no enum) precisamente para no tener que migrar cada vez que aparece un modo de juego nuevo en la API. `mode` es la **familia de ladder resuelta** (`rm_1v1` -> `rm_solo`, `rm_2v2`/`rm_3v3`/`rm_4v4` -> `rm_team`) y es por la que filtra el motor; `leaderboard` no se toca, porque es el registro literal de lo que dijo la API.
- `result` admite `null`: significa que la partida aún no está resuelta por la API. El motor no puntúa esas filas.
- `PlayerScore` es el agregado **versionado** que lee la web. El modelo completo está en [`docs/MODELO-DATOS.md`](./MODELO-DATOS.md): la parte que no depende de las reglas ya está aplicada y la que depende (ruleset Wololo, snapshots, categorías) está diferida.
- `Setting` no es solo configuración: también es la memoria del worker (`aoe4world.sync.player.<profileId>`) y el rastro del motor (`scoring.lastRun`). La simulación con jugadores reales añade `simulation.roster`, el **manifiesto de a quién dio de alta y con qué identidad**: es lo único que permite deshacerla sin borrar participantes de verdad.

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
- [x] **Email de contacto obligatorio** (`Player.contactEmail`, nullable en BD porque el alta de
      admin no lo pide): validado en servidor y visible en la columna Contacto de
      `/admin/jugadores`.
- [x] **Reinscripción de un `REJECTED`**: un envío nuevo actualiza la fila existente (nombre,
      Twitch, email, `aoe4WorldName`, avatar) y la devuelve a `PENDING`, con el `UPDATE` filtrado
      por estado para no pisar una aprobación concurrente. `APPROVED` y `PENDING` siguen
      bloqueando.

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
        se juegan, **en directo** = solo Twitch.
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
  el detalle medido está en el README, "El límite de CPU del plan Free".
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
- **El plan Free de Cloudflare es el techo del sync**: 10 ms de CPU por invocación contra los ~500 ms que gasta una pasada. Un disparo **esporádico** se tolera (el *isolate* tiene flexibilidad para pasarse de vez en cuando); uno **consistente** se mata con el error 1102. Por eso el reloj es Supabase Cron y no un Cron Trigger, y por eso el candado del botón de `/partidas` es de 5 minutos. Si algún día se necesita más margen, la salida es Workers Paid (5 $/mes); el *handler* `scheduled` ya se probó y funcionaba.
- **Los Cron Triggers se declaran explícitamente**: en `wrangler.jsonc`, `"triggers": { "crons": [] }`. No es decorativo: `wrangler deploy` solo reemplaza los triggers existentes por los del archivo, y con la clave `undefined` **los deja como están**. Quitar la clave al retirar el cron nativo dejó el trigger vivo disparando cada 5 minutos contra un Worker sin handler `scheduled` hasta que se declaró el array vacío.
