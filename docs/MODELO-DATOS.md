# Modelo de datos

Base de datos PostgreSQL en Supabase. La fuente del esquema es
[`prisma/schema.prisma`](../prisma/schema.prisma), ya aplicado en producción. Las reglas que
alimenta están en [`docs/PUNTUACION.md`](./PUNTUACION.md) y los procedimientos en
[`docs/OPERACION.md`](./OPERACION.md).

**Todo el acceso pasa por el DAL del servidor** (`DATABASE_URL`): la web nunca lee con la clave
publicable, y las tablas no son accesibles desde la Data API ([RLS](#rls-y-privilegios)).

## Tablas

| Tabla | Qué guarda | Clave |
|---|---|---|
| `Player` | Un participante, por identidad de AoE4World. | `id`; `profileId` único |
| `Match` | Una fila por (jugador, partida). | `id`; único `(playerId, gameId)` |
| `PlayerScore` | La clasificación agregada, por version de reglas. | pk `(playerId, ruleSetVersion)` |
| `ObjectiveEvent` | Un objetivo cobrado por un jugador y cuándo. | único `(objectiveId, playerId)` |
| `Alert` | Un comportamiento anómalo detectado (append-only). | `id`; único `dedupeKey` |
| `AdminAction` | Una acción del panel (append-only). | `id` |
| `Admin` | Una cuenta con acceso al panel de administración. | `id`; `email` único |
| `RateLimitCounter` | Un contador de frecuencia por IP hasheada. | `key` |
| `Setting` | Configuración y memoria de los procesos. | `key` |

Relaciones: `Match`, `PlayerScore`, `ObjectiveEvent` y `Alert` apuntan a `Player` con
`onDelete: Cascade`. El resto de tablas son independientes.

## Enums

| Enum | Valores |
|---|---|
| `PlayerStatus` | `PENDING`, `APPROVED`, `REJECTED` |
| `MatchResult` | `WIN`, `LOSS` |
| `AdminActionType` | `PLAYER_CREATED`, `PLAYER_REMOVED`, `MATCH_POINTS_REVERTED`, `MATCH_POINTS_RESTORED`, `PLAYER_EDITED`, `PLAYER_APPROVED`, `PLAYER_REJECTED`, `ADMIN_ADDED`, `ADMIN_DEACTIVATED`, `ADMIN_REACTIVATED`, `ACTION_REVERTED`, `CONFIG_CHANGED` |
| `AlertRule` | `SHORT_MATCH_STREAK`, `SHORT_MATCH_TOTAL`, `REPEATED_OPPONENT_STREAK`, `REPEATED_OPPONENT_TOTAL`, `REPEATED_TEAMMATE_STREAK`, `REPEATED_TEAMMATE_TOTAL`, `TEAMMATE_ELO_GAP` (legado), `LOW_DIVISION_TEAM_GAME` (legado), `HISTORY_NOT_PUBLIC`, `MISSING_LADDER_MATCHES`, `DISCORD_NOT_IN_GUILD`, `NO_STREAM_CHANNEL` (solo si la edición exige retransmisión) |
| `AlertKind` | `STREAK_CLOSED`, `STREAK_AT_TOURNAMENT_END`, `TOTAL_REACHED`, `STATE_DETECTED` |

Los valores nuevos de un enum se añaden **al final**: en Postgres `ALTER TYPE … ADD VALUE` solo
añade al final, y poner uno en medio obligaría a recrear el tipo.

Dos valores de `AlertRule` son **legado**: `TEAMMATE_ELO_GAP` (brecha de elo con un compañero) y
`LOW_DIVISION_TEAM_GAME` (equipo en una división muy distinta) ya no los calcula el motor, porque su
caso pasó a ser una condición de **puntuación** (una partida por equipos con un compañero a dos
escalones o más no cuenta; ver [`PUNTUACION.md`](./PUNTUACION.md)). Se quedan —con su etiqueta y su
frase— porque hay filas históricas de `Alert` que el panel y el informe siguen leyendo.

## `Player`

Un participante. `status` decide quién puntúa: solo `APPROVED` entra en la clasificación.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | Clave interna. Nunca se expone. |
| `profileId` | `Int` único | Identificador de AoE4World. |
| `name` | `String` | Nombre de display: lo escribe quien se inscribe o el admin; el worker no lo toca. |
| `aoe4WorldName` | `String?` | Nombre oficial de AoE4World, en columna aparte. `null` = sin sincronizar. |
| `twitchChannel`, `youtubeChannel`, `kickChannel` | `String?` | Canales de la persona (los escribe quien se inscribe o el admin). YouTube sin arroba, Kick como slug. |
| `twitchUrl` | `String?` | Respaldo: el canal que declara AoE4World. |
| `contactEmail` | `String?` | Correo de contacto (nullable: el panel lo pide opcional y las filas antiguas no lo tienen). El motor no lo lee. |
| `country` | `String?` | País con el rótulo canónico de `registration.countries`. El motor no lo lee. |
| `discordUserId` | `String?` **único** | Identidad de Discord. La firma Discord (OAuth o worker); el panel no la edita. |
| `discordUsername` | `String?` **único** | `@usuario` en forma canónica: sin arroba y en minúsculas. |
| `discordInGuild` | `Boolean?` | `null` = sin comprobar; un `false` solo se escribe ante una respuesta de Discord. |
| `discordCheckedAt` | `DateTime?` | Cuándo se comprobó lo anterior (caché de 12 h). |
| `status` | `PlayerStatus` | `PENDING` por defecto. |
| `registeredAt` | `DateTime?` | Cuándo se **inscribió** (no cuándo se aprobó). Define el corte `max(window.from, registeredAt)`. `null` = cuenta desde el inicio de la ventana; sin *backfill*. |
| `elo`, `rankLevel`, `streak`, `ladderGamesCount` | `Int`/`String`/`Int`/`Int?` | De la ladder (`GET /leaderboards/rm_solo`). `rankLevel` es el literal (`gold_2`), no la división resuelta. `streak` con signo. |
| `ladderLastGameAt` | `DateTime?` | `last_game_at` de la ladder. Va por delante de lo que importamos: solo sirve para la alerta `MISSING_LADDER_MATCHES`. |
| `ladderUpdatedAt` | `DateTime?` | Última lectura de la ladder. Distingue "sin ladder" de "sin sync". |
| `twitchIsLive`, `youtubeIsLive`, `kickIsLive` | `Boolean` | `false` = "no comprobado o no en directo". Los tres son degradables. |
| `avatarUrl` | `String?` | `avatars.full` de AoE4World; `null` dibuja monograma. |
| `historyPublic` | `Boolean?` | Historial de partidas público. `null` = sin comprobar (un fallo no escribe "cerrado"). |
| `historyCheckedAt` | `DateTime?` | Caché de la comprobación de historial (12 h). |
| `createdAt`, `updatedAt` | `DateTime` | |

Índices: `id` (pk) y `profileId` (único). Los dos únicos de Discord son **restricciones**, no
filtros: sostienen "una cuenta y un `@usuario` no están en dos participantes". No hay índice en
`status`: la tabla tiene decenas de filas y el listado del panel ya recorre entera.

## `Match`

Una fila por **jugador y partida**: dos participantes que se enfrentan generan dos filas, con su
resultado, civilización y puntos propios. El worker guarda **todo** el histórico; el filtro de qué
puntúa lo aplica el motor, no el importador.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `gameId` | `String` | Id de la partida en AoE4World. `String` aunque la API lo mande como número, para no reventar `int4`. |
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `opponentProfileId`, `opponentName` | `Int?`, `String?` | Solo el **primer** rival del equipo contrario (limitación conocida). |
| `civ`, `opponentCiv` | `String?` | Civilizaciones. |
| `map` | `String?` | |
| `leaderboard` | `String` (`rm_solo`) | Lo que dijo la API (o el `kind`). No se toca. |
| `mode` | `String?` | Familia de ladder resuelta (`rm_2v2` → `rm_team`). La correspondencia está en código; la lista de qué puntúa, en el ruleset. |
| `civRandomized` | `Boolean` (`false`) | La API marcó la civ de este jugador como aleatoria. |
| `result` | `MatchResult?` | `null` = la partida sigue en curso. |
| `startedAt` | `DateTime` | Ancla de la ventana de clasificatorias. |
| `finishedAt` | `DateTime?` | `null` = en curso (es lo que lista `/partidas`). |
| `durationSeconds` | `Int?` | |
| `points` | `Int` (`0`) | Puntos que aporta según el ruleset: `pointsPerWin` en una victoria clasificatoria, 0 en el resto. Solo lo escribe el motor. |
| `revertedAt` | `DateTime?` | Marca de "deja de puntuar" (reversible). `null` = puntúa. |
| `rawJson` | `Json` | La partida tal cual la devolvió la API. **No se borra nunca.** De aquí salen los compañeros y su rating para la condición de equipo. |
| `createdAt` | `DateTime` | |

Índices: único `(playerId, gameId)` (dedupe del worker); `(playerId, startedAt)`,
`(playerId, finishedAt)`, `(mode, startedAt)`. Ver [Índices](#índices).

`mode` y `civRandomized` se rellenaron con `npm run backfill:model` en las filas anteriores; a
partir de ahí las escribe el worker con cada partida.

## `PlayerScore`

La clasificación agregada: **una fila por jugador y versión de reglas**. Es la tabla de la que lee
la web; `Match` no se lee para pintar la clasificación.

| Campo | Tipo | Nota |
|---|---|---|
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `ruleSetVersion` | `Int` | Con qué versión de reglas se calculó. Permite convivir dos versiones sin pisarse. |
| `rank` | `Int` | Puesto de competición con el desempate ya aplicado: dos filas empatadas en total, tasa de victorias, victorias y partidas **comparten** puesto (1, 2, 2, 4). **Se guarda** porque el orden no se resuelve en SQL. |
| `total` | `Int` | `sum(byMode.points) + objectives.points`. |
| `wins`, `matches` | `Int` | Victorias y partidas clasificatorias. |
| `streak` | `Int?` | Racha **actual del torneo**: positiva = victorias clasificatorias seguidas, negativa = derrotas seguidas. `null` sin ninguna clasificatoria contada (la web pinta "-"; no es `0`). No es la racha de la ladder: esa vive en `Player.streak`. |
| `breakdown` | `Json` | Desglose (ver formato abajo). |
| `computedAt` | `DateTime` | |

Índices: pk `(playerId, ruleSetVersion)` e `(ruleSetVersion, rank)`, que sostiene el orden de la
clasificación; dentro de un puesto compartido el desempate es `Player.profileId` ascendente. Todo jugador
**aprobado** tiene fila, aunque todavía no haya jugado ninguna clasificatoria:
sale con `total`, `wins` y `matches` a 0, el `breakdown` con ceros (las familias del ruleset, con 0,
y `objectives` a 0 y vacío) y `streak` a `null`. Un jugador **no aprobado** (`PENDING`/`REJECTED`) no
tiene fila y no aparece.

Formato de `breakdown` (tipo `ScoreBreakdown` en `src/lib/scoring.ts`): las dos familias están
siempre presentes, con ceros si no aplican.

```json
{
  "ruleSetVersion": 3,
  "rule": "2 puntos por victoria clasificatoria más 82 objetivos: 29 competiciones y 53 logros",
  "byMode": {
    "rm_solo": { "wins": 3, "points": 6, "matches": 5 },
    "rm_team": { "wins": 1, "points": 2, "matches": 2 }
  },
  "objectives": { "points": 125, "earned": ["loco-por-ganar", "rey-1v1", "lider-french"] }
}
```

## `ObjectiveEvent`

Un objetivo **cobrado por un jugador** y **cuándo**. Un evento por objetivo y jugador: en una
competición hay uno (el poseedor) y en un logro puede haber muchos (todos los que lo completan). Lo lee
el historial del panel (`/admin/historial`); no alimenta la clasificación.

| Campo | Tipo | Nota |
|---|---|---|
| `objectiveId` | `String` | Id del catálogo (`loco-por-ganar`, `lider-japanese`…). |
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `achievedAt` | `DateTime` | Fin de la ventana del torneo (todos los objetivos se resuelven en caliente). |
| `recordedAt` | `DateTime` | Cuándo lo registró el motor. |

Índices: `(objectiveId, playerId)` (único, para la reconciliación), `achievedAt` y `playerId` (feed y
cascada).

Es un **espejo del cómputo, no un log**: si cambia el poseedor de una competición, o quien completa un
logro, la fila se actualiza o se borra. Todo el catálogo se registra al cerrar la ventana; mientras está
abierta no se escribe nada.

## `Alert`

Un comportamiento anómalo, detectado sobre las partidas clasificatorias. Es **append-only**: una
fila dice "a la 1 se detectó esto" y no se reescribe.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `rule` | `AlertRule` | Qué comportamiento. La lista es fija en código; los umbrales, no (`alerts.ruleset`). Dos de sus valores son legado y ya no se calculan, pero hay filas escritas con ellos. |
| `kind` | `AlertKind` | Cómo se detectó. |
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `subjectProfileId`, `subjectName` | `Int?`, `String?` | El rival (R2) o compañero (R3). No es FK: el sujeto suele ser de fuera de la liga. |
| `count`, `threshold` | `Int` | Magnitud medida y umbral del ruleset. En las reglas de estado, la magnitud con la que se comparó. |
| `anchorGameId` | `String?` | La partida que disparó la alerta. `null` en las reglas de estado. |
| `dedupeKey` | `String` **único** | Clave compuesta en código; ver abajo. |
| `summary` | `String` | Una línea en español, ya redactada al escribir la fila. |
| `details` | `Json` | Evidencia estructurada. |
| `createdAt` | `DateTime` | |

Índices: `dedupeKey` (único), `(createdAt)` y `(playerId, rule)`.

La `dedupeKey` es texto y no un índice único compuesto porque en Postgres los `NULL` de un índice
único no colisionan, y el sujeto es opcional. Se compone con (regla, tipo, jugador, sujeto y el
remate: la partida o el número), salvo en `STATE_DETECTED`, que es solo (regla, tipo, jugador)
porque un estado no tiene remate y si no insertaría una fila nueva cada 12 horas.

## `AdminAction`

Una acción del panel, para poder pintar su historial. **Append-only**: quién hizo qué y sobre qué
fila. `summary` va ya redactado en español. Registra lo que cambia datos que se ven desde fuera:
altas, bajas y ediciones de participante, aprobaciones y rechazos de solicitud (aprobar mete al
jugador en la clasificación y rechazar lo deja fuera), los revert/restore de puntos de una partida,
la gestión de admins, los cambios de configuración de la edición y la **reversión** de una acción
anterior (`ACTION_REVERTED`). La única escritura sobre una fila ya existente es la marca de revertida
(`revertedAt`/`revertedByEmail`): el rastro de lo hecho sobrevive a que se deshaga, y lo único que
dice la marca es que ya no está vigente. Qué tipos se pueden deshacer y qué hace cada uno está en
[`OPERACION.md`](./OPERACION.md#deshacer-una-acción).

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `type` | `AdminActionType` | |
| `actorEmail` | `String` | Correo del usuario de Supabase Auth. |
| `summary` | `String` | Frase ya redactada. |
| `targetId` | `String?` | `Player.id`, `Match.id` o `Admin.id` según el `type`. Texto y no FK a propósito. |
| `details` | `Json?` | Datos de la acción (no se usan para pintar). |
| `revertedAt` | `DateTime?` | `null` = la acción sigue vigente. Marca de revertida, reversible. La escribe la reversión, que además añade una fila `ACTION_REVERTED`. |
| `revertedByEmail` | `String?` | Quién la revirtió (no es el `actorEmail`, que es quien la hizo). |
| `createdAt` | `DateTime` | |

Índices: `(createdAt)` (paginación, lo más reciente primero) y `(type, createdAt)` (filtro por tipo).

## `Admin`

Las cuentas con acceso al panel. Hasta esta tabla, **cualquier** usuario de Supabase Auth era admin
(los registros públicos están desactivados, así que solo había cuentas de la organización), y eso
hacía imposible dar de baja a nadie. Con ella, la comprobación de acceso (`requireAdmin()` en
`src/lib/auth.ts`) deja pasar al correo del superadministrador o a una fila **activa**.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `email` | `String` **único** | Canónico: en minúsculas y sin espacios. Es lo que se compara al entrar. |
| `authUserId` | `String?` **único** | `auth.users.id`. `null` = aún sin vincular. Los `null` no colisionan. |
| `active` | `Boolean` (`true`) | `false` = de baja: pierde el acceso sin borrar la fila. |
| `deactivatedAt` | `DateTime?` | Cuándo se dio de baja. `null` mientras está activa. |
| `addedByEmail` | `String?` | Correo de quien le dio de alta (también en `AdminAction`). |
| `createdAt`, `updatedAt` | `DateTime` | |

Índices: `id` (pk), `email` (único) y `authUserId` (único). La **baja es `active = false`**, no un
borrado: la organización quiere desactivar sin perder la relación con lo que hizo la persona, y el
rastro de quién hizo qué vive en `AdminAction`, que no depende de esta tabla. **No hay columna de
rol**: el superadministrador es único y sale de la variable `SUPERADMIN_EMAIL` (ver
[`OPERACION.md`](./OPERACION.md)), así que la tabla solo dice quién es admin normal.

## `RateLimitCounter`

El límite de frecuencia de los endpoints públicos sin sesión (hoy, la inscripción). Una fila por
clave, con incremento atómico en una sola sentencia.

| Campo | Tipo | Nota |
|---|---|---|
| `key` | `String` | `ip:<hmac-sha256>` o el cubo `global`. **Nunca es una IP en claro.** |
| `count` | `Int` | Envíos de la ventana en curso, este incluido. |
| `windowStart` | `DateTime` | Inicio de la ventana (fija, no deslizante). |
| `updatedAt` | `DateTime` | |

Sin índices aparte de la pk: la purga de filas caducadas es periódica y la tabla es muy pequeña.

## `Setting`

Clave-valor. No es solo configuración: es la **memoria de los procesos** (cursores, rulesets,
cachés y rastros). Se lee siempre por clave.

| Campo | Tipo |
|---|---|
| `key` | `String` (pk) |
| `value` | `Json` |
| `updatedAt` | `DateTime` |

### Claves de Setting

Claves vivas en producción, con quién las escribe:

| Clave | Qué es | La escribe |
|---|---|---|
| `scoring.ruleset` | Reglas de puntuación activas (versión fija en código; puntos, ventana, objetivos y objetivos desactivados). Un documento de la versión anterior se migra al leerlo. | `ensureRuleset()` en `src/lib/scoring.ts`; el panel, con `saveScoringRuleset` |
| `scoring.mapPool` | Pool de mapas del objetivo `por-tierra-y-agua`. | Worker (`refreshMapPool()`) o a mano (organización) |
| `scoring.mapPoolSync` | Contabilidad del último refresco del pool (`fetchedAt`, `startedAt`, `nextRefresh`, `maps`). | Worker (`refreshMapPool()`) |
| `scoring.lastRun` | Rastro del último recálculo. | `recomputeScores()` |
| `scoring.objectives` | Vista pública de objetivos (`ObjectiveView`) con su `snapshotVersion` y la huella del contenido. La leen `/objetivos` y la ficha de participante; si falta o no valida, se recomputa en vivo. | `recomputeScores()` |
| `sync.lastRun` | Rastro de la última pasada de sincronización. | Worker (`src/lib/aoe4world/sync.ts`) |
| `alerts.ruleset` | Umbrales de las reglas de alerta. | `npm run alerts:*` / código |
| `alerts.divisionCutoffs` | Cortes rating → subdivisión por familia de ladder (hoy solo `rm_team`): los usa la **condición de equipo** del motor de puntuación, y el de alertas los lee para filtrar con la misma regla. | `npm run alerts:cutoffs` |
| `discord.roster` | Lista de miembros del servidor cacheada (TTL 12 h). | `src/lib/discord/roster-cache.ts` |
| `registration.countries` | Países que admite el formulario, en el orden del catálogo. | `npm run countries:seed` o el panel (**solo el superadministrador**), con `saveCountries` |
| `registration.open` | Si la inscripción está abierta. | Panel (**solo superadministrador**), con `setRegistrationOpen`; el cambio deja `CONFIG_CHANGED` en `AdminAction` |
| `donations.matcherino` | Campaña de donaciones de Matcherino: si el banner está activo y su URL. | Panel (**solo superadministrador**), con `setMatcherinoDonations`; el cambio deja `CONFIG_CHANGED` en `AdminAction` |
| `edition.config` | Configuración de la edición: nombre, premio base (importe y nota), retransmisión obligatoria y marca (emblema y color de acento). Versión 1 fija en código. | Panel de admin (**solo el superadministrador**) |
| `edition.announcements` | Memoria de los avisos del torneo en Discord: cuándo se mandó el de comienzo y cuándo el de final (`startedAt`/`finishedAt`, o `null` si no se ha dado). Una marca puesta no se quita nunca, aunque la ventana se mueva. | Worker (`src/lib/edition-announcements.ts`) |
| `simulation.roster` | Manifiesto de `npm run simulate:tournament`. | `simulate:tournament` |
| `streams.youtube.channel.<handle>` | `channelId` de YouTube y su playlist de subidas, ya resueltos (30 días). | Worker |
| `aoe4world.sync.player.<profileId>` | Cursor de sincronización por jugador. | Worker; la baja de `/admin` lo **borra** con el jugador (misma transacción), para que un alta posterior del mismo perfil no herede un cursor viejo. |

## Índices

Los índices reales en producción, y la consulta que sostiene cada uno. La regla: **un índice que no
aparece en una consulta, no se crea.**

| Tabla | Índice | Consulta |
|---|---|---|
| `Player` | `id` (pk), `profileId` (único) | Ficha por id o por `profileId`. |
| `Player` | `discordUserId`, `discordUsername` (únicos) | Restricciones, no filtros. |
| `Match` | único `(playerId, gameId)` | Dedupe del worker. |
| `Match` | `(playerId, startedAt)` | Partidas de un jugador por fecha. |
| `Match` | `(playerId, finishedAt)` | Partidas en curso y orden de hitos. |
| `Match` | `(mode, startedAt)` | Clasificatorias dentro de la ventana (igualdad + rango). |
| `PlayerScore` | pk `(playerId, ruleSetVersion)` | Ficha del jugador; de paso indexa la FK para el `Cascade`. |
| `PlayerScore` | `(ruleSetVersion, rank)` | **La consulta más caliente**: la clasificación, ordenada por `rank` y, dentro del puesto compartido, por `Player.profileId`. |
| `ObjectiveEvent` | `(objectiveId, playerId)` (único), `achievedAt`, `playerId` | Reconciliación, feed del historial, filtro por jugador y cascada. |
| `Alert` | `dedupeKey` (único), `createdAt`, `(playerId, rule)` | Idempotencia, listado, detalle por jugador. |
| `AdminAction` | `createdAt`, `(type, createdAt)` | Listado y filtro por tipo. |
| `Admin` | `email` (único), `authUserId` (único) | Acceso al panel por correo y vínculo con Auth. |
| `RateLimitCounter` | `key` (pk) | El `INSERT ... ON CONFLICT`. |

## Consultas calientes

| Dónde | Consulta | Índice |
|---|---|---|
| `/` (clasificación) | `PlayerScore where ruleSetVersion = V order by rank, Player.profileId` + `Player` por id | `(ruleSetVersion, rank)` |
| `/partidas` | `Match where finishedAt is null` y `Player.status = APPROVED`, por `startedAt` | `(playerId, finishedAt)`; sin índice parcial (no se ha necesitado) |
| `/objetivos` | `Match` clasificatorias de todos los aprobados, en la ventana | `(mode, startedAt)` |
| `/admin` (jugadores) | `Player order by profileId` | `profileId` (único) |
| `/admin/historial` | `Match` clasificatorias **y revertidas** + `ObjectiveEvent` | `(mode, startedAt)`, `(playerId, startedAt)`, `achievedAt` |
| `/admin/alertas` | `Alert [por jugador/regla] order by createdAt` | `createdAt`, `(playerId, rule)` |
| Inscripción | `RateLimitCounter` con `ON CONFLICT` | `key` (pk) |
| Acceso al panel (`requireAdmin`) | `Admin` por `email` (una fila por petición con sesión) | `email` (único) |
| Motor (recálculo) | `Match where mode = any(...) and startedAt en ventana and result/finishedAt no nulos` | `(mode, startedAt)` |

El filtro de qué cuenta es **uno solo**: `src/lib/ranked-match.ts` (ventana, corte de inscripción,
marca de revertida y la condición de equipo de las partidas por equipos) y lo reparte como
`countsAsRanked`, `rankedMatchWhere` y `rankedMatchSql` —la condición de equipo solo cabe en las dos
últimas, así que quien use el `where` de Prisma la filtra después en memoria—. El panel usa
`classificatoryWhere()`, que es lo mismo sin la marca de revertida, para poder listarlas.

## RLS y privilegios

Postura **cerrada**, aplicada a las nueve tablas de `public`:

| Paso | Qué |
|---|---|
| 1 | `enable row level security` en todas las tablas. |
| 2 | **Ninguna política**: con RLS y sin políticas, cualquier rol sin `BYPASSRLS` ve cero filas. |
| 3 | **Ningún `grant`** a `anon` ni a `authenticated`. |
| 4 | Comprobar con `npm run db:security -- --check`. |

Estado real: RLS activa y 0 políticas en las nueve tablas, y sin permisos para `anon` ni
`authenticated`. `service_role` conserva sus permisos y su `BYPASSRLS`: es un rol de infraestructura
de Supabase, no un cliente del torneo. Consecuencia en la Data API: **`401 permission denied`** (el
permiso de tabla se comprueba antes que RLS). No se "arregla" concediendo `SELECT`; si algún día
hace falta servir una tabla, sería con una vista `security_invoker = true` y un `grant` a la vista.

- Vive en [`scripts/db-security.ts`](../scripts/db-security.ts) y no en el schema porque `prisma db
  push` no modela RLS ni permisos.
- Antes de activar RLS, el script comprueba que el rol de `DATABASE_URL` tenga `BYPASSRLS`; si no,
  se niega a aplicar nada (la web dejaría de ver datos en silencio).
- La lista de tablas del script es **explícita**: al añadir una tabla hay que añadirla ahí, porque
  una tabla nueva nace con los permisos por defecto de Supabase. `Admin` ya está en esa lista.

## Cambios de esquema

- La fuente es `prisma/schema.prisma`. Un cambio va ahí, luego `npm run generate` y `npm run db:push`.
- **Nada de `prisma migrate`**: Supabase no permite *shadow database*. El script `migrate` del
  `package.json` no es válido en este proyecto.
- La base es la de **producción y no hay *staging*`. Nada de `--accept-data-loss`: si `db push`
  avisa de pérdida, hay que mirarlo.
- **Después de cada `db:push` que añada tablas**: `npm run db:security -- --check` (una tabla nueva
  nace accesible para los roles de cliente). Si falla, `npm run db:security`.
- Los cambios de datos masivos (por ejemplo un *backfill*) se hacen con el worker parado.
