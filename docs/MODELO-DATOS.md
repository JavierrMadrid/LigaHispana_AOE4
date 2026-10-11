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
| `RateLimitCounter` | Un contador de frecuencia por IP hasheada. | `key` |
| `Setting` | Configuración y memoria de los procesos. | `key` |

Relaciones: `Match`, `PlayerScore`, `ObjectiveEvent` y `Alert` apuntan a `Player` con
`onDelete: Cascade`. El resto de tablas son independientes.

## Enums

| Enum | Valores |
|---|---|
| `PlayerStatus` | `PENDING`, `APPROVED`, `REJECTED` |
| `MatchResult` | `WIN`, `LOSS` |
| `AdminActionType` | `PLAYER_CREATED`, `PLAYER_REMOVED`, `MATCH_POINTS_REVERTED`, `MATCH_POINTS_RESTORED`, `PLAYER_EDITED` |
| `AlertRule` | `SHORT_MATCH_STREAK`, `SHORT_MATCH_TOTAL`, `REPEATED_OPPONENT_STREAK`, `REPEATED_OPPONENT_TOTAL`, `REPEATED_TEAMMATE_STREAK`, `REPEATED_TEAMMATE_TOTAL`, `TEAMMATE_ELO_GAP`, `LOW_DIVISION_TEAM_GAME`, `HISTORY_NOT_PUBLIC`, `MISSING_LADDER_MATCHES`, `DISCORD_NOT_IN_GUILD` |
| `AlertKind` | `STREAK_CLOSED`, `STREAK_AT_TOURNAMENT_END`, `TOTAL_REACHED`, `STATE_DETECTED` |

Los valores nuevos de un enum se añaden **al final**: en Postgres `ALTER TYPE … ADD VALUE` solo
añade al final, y poner uno en medio obligaría a recrear el tipo.

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
| `rawJson` | `Json` | La partida tal cual la devolvió la API. **No se borra nunca.** |
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
| `rank` | `Int` | Puesto con el desempate ya aplicado. **Se guarda** porque el orden no se resuelve en SQL. |
| `total` | `Int` | `sum(byMode.points) + objectives.points`. |
| `wins`, `matches` | `Int` | Victorias y partidas clasificatorias. |
| `breakdown` | `Json` | Desglose (ver formato abajo). |
| `computedAt` | `DateTime` | |

Índices: pk `(playerId, ruleSetVersion)` e `(ruleSetVersion, rank)`, que sostiene la clasificación
sin `sort`. Un aprobado sin ninguna clasificatoria resuelta **no tiene fila**, así que no aparece.

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
| `rule` | `AlertRule` | Qué comportamiento. La lista es fija en código; los umbrales, no (`alerts.ruleset`). |
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
fila. `summary` va ya redactado en español.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `type` | `AdminActionType` | |
| `actorEmail` | `String` | Correo del usuario de Supabase Auth. |
| `summary` | `String` | Frase ya redactada. |
| `targetId` | `String?` | `Player.id` o `Match.id` según el `type`. Texto y no FK a propósito. |
| `details` | `Json?` | Datos de la acción (no se usan para pintar). |
| `createdAt` | `DateTime` | |

Índices: `(createdAt)` (paginación, lo más reciente primero) y `(type, createdAt)` (filtro por tipo).

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
| `scoring.ruleset` | Reglas de puntuación activas (versión fija en código; puntos, ventana y objetivos). | `ensureRuleset()` en `src/lib/scoring.ts` |
| `scoring.mapPool` | Pool de mapas del objetivo `por-tierra-y-agua`. | Worker (`refreshMapPool()`) o a mano (organización) |
| `scoring.mapPoolSync` | Contabilidad del último refresco del pool (`fetchedAt`, `startedAt`, `nextRefresh`, `maps`). | Worker (`refreshMapPool()`) |
| `scoring.lastRun` | Rastro del último recálculo. | `recomputeScores()` |
| `sync.lastRun` | Rastro de la última pasada de sincronización. | Worker (`src/lib/aoe4world/sync.ts`) |
| `alerts.ruleset` | Umbrales de las reglas de alerta. | `npm run alerts:*` / código |
| `alerts.divisionCutoffs` | Cortes rating → subdivisión por familia de ladder que necesita la regla R5 (hoy solo `rm_team`). | `npm run alerts:cutoffs` |
| `discord.roster` | Lista de miembros del servidor cacheada (TTL 12 h). | `src/lib/discord/roster-cache.ts` |
| `registration.countries` | Países que admite el formulario. | `npm run countries:seed` |
| `registration.open` | Si la inscripción está abierta. | Panel de admin |
| `donations.matcherino` | Campaña de donaciones de Matcherino: si el banner está activo y su URL. | Panel de admin |
| `simulation.roster` | Manifiesto de `npm run simulate:tournament`. | `simulate:tournament` |
| `streams.youtube.channel.<handle>` | `channelId` de YouTube ya resuelto. | Worker |
| `aoe4world.sync.player.<profileId>` | Cursor de sincronización por jugador. | Worker |

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
| `PlayerScore` | `(ruleSetVersion, rank)` | **La consulta más caliente**: la clasificación, sin `sort`. |
| `ObjectiveEvent` | `(objectiveId, playerId)` (único), `achievedAt`, `playerId` | Reconciliación, feed del historial, filtro por jugador y cascada. |
| `Alert` | `dedupeKey` (único), `createdAt`, `(playerId, rule)` | Idempotencia, listado, detalle por jugador. |
| `AdminAction` | `createdAt`, `(type, createdAt)` | Listado y filtro por tipo. |
| `RateLimitCounter` | `key` (pk) | El `INSERT ... ON CONFLICT`. |

## Consultas calientes

| Dónde | Consulta | Índice |
|---|---|---|
| `/` (clasificación) | `PlayerScore where ruleSetVersion = V order by rank` + `Player` por id | `(ruleSetVersion, rank)` |
| `/partidas` | `Match where finishedAt is null` y `Player.status = APPROVED`, por `startedAt` | `(playerId, finishedAt)`; sin índice parcial (no se ha necesitado) |
| `/objetivos` | `Match` clasificatorias de todos los aprobados, en la ventana | `(mode, startedAt)` |
| `/admin` (jugadores) | `Player order by profileId` | `profileId` (único) |
| `/admin/historial` | `Match` clasificatorias **y revertidas** + `ObjectiveEvent` | `(mode, startedAt)`, `(playerId, startedAt)`, `achievedAt` |
| `/admin/alertas` | `Alert [por jugador/regla] order by createdAt` | `createdAt`, `(playerId, rule)` |
| Inscripción | `RateLimitCounter` con `ON CONFLICT` | `key` (pk) |
| Motor (recálculo) | `Match where mode = any(...) and startedAt en ventana and result/finishedAt no nulos` | `(mode, startedAt)` |

El filtro de qué cuenta es **uno solo**: `src/lib/ranked-match.ts` (ventana, corte de inscripción y
marca de revertida) y lo reparte como `countsAsRanked`, `rankedMatchWhere` y `rankedMatchSql`. El
panel usa `classificatoryWhere()`, que es lo mismo sin la marca de revertida, para poder listarlas.

## RLS y privilegios

Postura **cerrada**, aplicada a las ocho tablas de `public`:

| Paso | Qué |
|---|---|
| 1 | `enable row level security` en todas las tablas. |
| 2 | **Ninguna política**: con RLS y sin políticas, cualquier rol sin `BYPASSRLS` ve cero filas. |
| 3 | **Ningún `grant`** a `anon` ni a `authenticated`. |
| 4 | Comprobar con `npm run db:security -- --check`. |

Estado real: RLS activa y 0 políticas en las ocho tablas, y sin permisos para `anon` ni
`authenticated`. `service_role` conserva sus permisos y su `BYPASSRLS`: es un rol de infraestructura
de Supabase, no un cliente del torneo. Consecuencia en la Data API: **`401 permission denied`** (el
permiso de tabla se comprueba antes que RLS). No se "arregla" concediendo `SELECT`; si algún día
hace falta servir una tabla, sería con una vista `security_invoker = true` y un `grant` a la vista.

- Vive en [`scripts/db-security.ts`](../scripts/db-security.ts) y no en el schema porque `prisma db
  push` no modela RLS ni permisos.
- Antes de activar RLS, el script comprueba que el rol de `DATABASE_URL` tenga `BYPASSRLS`; si no,
  se niega a aplicar nada (la web dejaría de ver datos en silencio).
- La lista de tablas del script es **explícita**: al añadir una tabla hay que añadirla ahí, porque
  una tabla nueva nace con los permisos por defecto de Supabase.

## Cambios de esquema

- La fuente es `prisma/schema.prisma`. Un cambio va ahí, luego `npm run generate` y `npm run db:push`.
- **Nada de `prisma migrate`**: Supabase no permite *shadow database*. El script `migrate` del
  `package.json` no es válido en este proyecto.
- La base es la de **producción y no hay *staging*`. Nada de `--accept-data-loss`: si `db push`
  avisa de pérdida, hay que mirarlo.
- **Después de cada `db:push` que añada tablas**: `npm run db:security -- --check` (una tabla nueva
  nace accesible para los roles de cliente). Si falla, `npm run db:security`.
- Los cambios de datos masivos (por ejemplo un *backfill*) se hacen con el worker parado.
