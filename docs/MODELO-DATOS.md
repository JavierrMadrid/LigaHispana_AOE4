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
| `ObjectiveEvent` | Un **logro** cobrado por un jugador y cuándo. | único `(objectiveId, playerId)` |
| `ObjectiveLeadEvent` | Un cambio de poseedor de una **competición** (append-only). | `id` |
| `ObjectiveProgressEvent` | Un cambio de **progreso** de un objetivo, con sus valores (append-only). Lo lee la API del overlay. | `id` |
| `ObjectiveProgressState` | El progreso **actual** de un jugador en un objetivo, por edición. Uso interno de la reconciliación. | pk `(playerId, objectiveId, editionFrom)` |
| `Alert` | Un comportamiento anómalo detectado (append-only). | `id`; único `dedupeKey` |
| `AdminAction` | Una acción del panel (append-only). | `id` |
| `AdminAct` | Una **actuación administrativa**: expulsión, anulación o reversión, con razón pública. | `id` |
| `AdminActMatch` | Qué partidas anuló una actuación. | pk `(actId, matchId)` |
| `Admin` | Una cuenta con acceso al panel de administración. | `id`; `email` único |
| `RateLimitCounter` | Un contador de frecuencia por IP hasheada. | `key` |
| `Setting` | Configuración y memoria de los procesos. | `key` |

Relaciones: `Match`, `PlayerScore`, `ObjectiveEvent`, `ObjectiveLeadEvent`,
`ObjectiveProgressEvent`, `ObjectiveProgressState` y `Alert` apuntan a `Player` con
`onDelete: Cascade`. `AdminAct` apunta a `Player` con `onDelete: SetNull` (la actuación
sobrevive al borrado del jugador con la foto de nombre y perfil), y `AdminActMatch` cae en cascada
con `AdminAct` y con `Match`. El resto de tablas son independientes.

## Enums

| Enum | Valores |
|---|---|
| `PlayerStatus` | `PENDING`, `APPROVED`, `REJECTED`, `BANNED` |
| `MatchResult` | `WIN`, `LOSS` |
| `ObjectiveLeadKind` | `LOST`, `GAINED` (en ese orden, y no es decorativo: ver abajo) |
| `ObjectiveProgressKind` | `CUMPLIDO`, `PERDIDO`, `PROGRESADO` (el orden no significa nada: el feed va por `at`) |
| `AdminActionType` | `PLAYER_CREATED`, `PLAYER_REMOVED`, `MATCH_POINTS_REVERTED`, `MATCH_POINTS_RESTORED`, `PLAYER_EDITED`, `PLAYER_APPROVED`, `PLAYER_REJECTED`, `ADMIN_ADDED`, `ADMIN_DEACTIVATED`, `ADMIN_REACTIVATED`, `ACTION_REVERTED`, `CONFIG_CHANGED` |
| `AdminActKind` | `BAN`, `MATCH_ANNULMENT`, `REVERSAL` |
| `AlertRule` | `SHORT_MATCH_STREAK`, `SHORT_MATCH_TOTAL`, `REPEATED_OPPONENT_STREAK`, `REPEATED_OPPONENT_TOTAL`, `REPEATED_TEAMMATE_STREAK`, `REPEATED_TEAMMATE_TOTAL`, `TEAMMATE_ELO_GAP` (legado), `LOW_DIVISION_TEAM_GAME` (legado), `HISTORY_NOT_PUBLIC`, `MISSING_LADDER_MATCHES`, `DISCORD_NOT_IN_GUILD`, `NO_STREAM_CHANNEL` (solo si la edición exige retransmisión), `NO_VILLAGERS_FIRST_MINUTES`, `NO_MILITARY_GAP`, `NO_RESOURCES_GAP`, `SUMMARY_NOT_REVIEWED` |
| `AlertKind` | `STREAK_CLOSED`, `STREAK_AT_TOURNAMENT_END`, `TOTAL_REACHED`, `STATE_DETECTED`, `MATCH_DETECTED` |

Los valores nuevos de un enum se añaden **al final**: en Postgres `ALTER TYPE … ADD VALUE` solo
añade al final, y poner uno en medio obligaría a recrear el tipo.

`ObjectiveLeadKind` es además el **orden de desempate** de las dos filas de un cambio de poseedor de
una competición: `LOST` va declarado antes que `GAINED` a propósito, porque Postgres ordena un enum
por su orden de declaración y así un `orderBy` de `kind` con el **mismo sentido** que el resto de la
consulta deja la ganancia delante en descendente (el estado que queda: el nuevo poseedor). No hay
que reordenarlo; el que se añada va al final.

`PlayerStatus.BANNED` es un estado **reversible**: lo pone una actuación administrativa (`AdminAct` de
tipo `BAN`) y solo se sale de él revirtiéndola. No es la baja destructiva (`deletePlayer`): conserva
todos los datos del participante y el motor lo trata como no aprobado (solo publica `APPROVED`).

Dos valores de `AlertRule` son **legado**: `TEAMMATE_ELO_GAP` (brecha de elo con un compañero) y
`LOW_DIVISION_TEAM_GAME` (equipo en una división muy distinta) ya no los calcula el motor, porque su
caso pasó a ser una condición de **puntuación** (una partida por equipos con un compañero a dos
escalones o más no cuenta; ver [`PUNTUACION.md`](./PUNTUACION.md)). Se quedan —con su etiqueta y su
frase— porque hay filas históricas de `Alert` en la tabla, y las que caen en la edición activa se
siguen leyendo en el panel y en el informe.

## `Player`

Un participante. `status` decide quién puntúa: solo `APPROVED` entra en la clasificación.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | Clave interna. Nunca se expone. |
| `profileId` | `Int` único | Identificador de AoE4World. |
| `name` | `String` | Nombre de display: lo escribe quien se inscribe o el admin; el worker no lo toca. |
| `aoe4WorldName` | `String?` | Nombre oficial de AoE4World, en columna aparte. Lo escriben la ladder y, si falta o la caché ha caducado, `GET /players/:profile_id`. `null` = sin sincronizar. |
| `twitchChannel`, `youtubeChannel`, `kickChannel` | `String?` | Canales de la persona (los escribe quien se inscribe o el admin). YouTube sin arroba, Kick como slug. |
| `twitchUrl` | `String?` | Respaldo: el canal que declara AoE4World. |
| `contactEmail` | `String?` | Correo de contacto (nullable: el panel lo pide opcional y las filas antiguas no lo tienen). El motor no lo lee. |
| `country` | `String?` | País con el rótulo canónico de `registration.countries`. El motor no lo lee. |
| `discordUserId` | `String?` **único** | Identidad de Discord. La firma Discord (OAuth o worker); el panel no la edita. |
| `discordUsername` | `String?` **único** | `@usuario` en forma canónica: sin arroba y en minúsculas. |
| `discordInGuild` | `Boolean?` | `null` = sin comprobar; un `false` solo se escribe ante una respuesta de Discord. |
| `discordCheckedAt` | `DateTime?` | Cuándo se comprobó lo anterior (caché de 12 h). |
| `discordVerificationRequestedAt` | `DateTime?` | La fila está **sujeta** a la verificación del alta (issue 119). `null` = no lo está: filas antiguas y altas de `/participar`. Se escribe en toda alta de admin con la verificación configurada y **no se limpia** al rechazar, para que una re-aprobación vuelva a exigir confirmación. |
| `discordVerificationSentAt` | `DateTime?` | Último privado de verificación enviado. `null` = no se ha mandado (o se invalidó al corregir el `@usuario`). |
| `discordVerificationToken` | `String?` **único** | Token aleatorio de los botones (`pv:c:<token>` / `pv:d:<token>`). Se rota al reenviar, se invalida al corregir el `@usuario` y se limpia al resolver. **No se expone**: permite **encontrar** la fila, pero resolverla exige además pulsar desde la cuenta destinataria (`discordVerificationUserId`) y que siga `PENDING`. |
| `discordVerificationUserId` | `String?` | Cuenta de Discord a la que se mandó el privado; la interacción comprueba que quien pulsa es esa cuenta. No es una FK ni tiene unicidad: es el destinatario del mensaje, no una identidad vinculada. |
| `discordVerifiedAt` | `DateTime?` | La persona **confirmó** desde su cuenta. No confundir con `discordUserId`: ese es "lo que dice Discord" y puede estar resuelto sin consentimiento. Es lo que hace que la puerta deje aprobar. |
| `discordDeclinedAt` | `DateTime?` | Cuándo pulsó "No". |
| `status` | `PlayerStatus` | `PENDING` por defecto. `BANNED` lo pone una actuación de expulsión y solo se sale revirtiéndola. |
| `registeredAt` | `DateTime?` | Cuándo se **inscribió** (no cuándo se aprobó). Define el corte `max(window.from, registeredAt)`. `null` = cuenta desde el inicio de la ventana; sin *backfill*. |
| `elo`, `rankLevel`, `streak`, `ladderGamesCount` | `Int`/`String`/`Int`/`Int?` | De la ladder (`GET /leaderboards/rm_solo`). `rankLevel` es el literal (`gold_2`), no la división resuelta. `streak` con signo. |
| `ladderLastGameAt` | `DateTime?` | `last_game_at` de la ladder. Va por delante de lo que importamos: solo sirve para la alerta `MISSING_LADDER_MATCHES`. |
| `ladderUpdatedAt` | `DateTime?` | Última lectura de la ladder. Distingue "sin ladder" de "sin sync". |
| `twitchIsLive`, `youtubeIsLive`, `kickIsLive` | `Boolean` | `false` = "no comprobado o no en directo". Los tres son degradables. |
| `avatarUrl` | `String?` | `avatars.full` de AoE4World; `null` dibuja monograma. |
| `profileCheckedAt` | `DateTime?` | Sello de la caché de perfil: cuándo se refrescaron el nombre oficial y el avatar. `null` = sin comprobar. Lo escriben la ladder y `GET /players/:profile_id`; con menos de 1 h no se pide el perfil. |
| `historyPublic` | `Boolean?` | Historial de partidas público. `null` = sin comprobar (un fallo no escribe "cerrado"). |
| `historyCheckedAt` | `DateTime?` | Caché de la comprobación de historial (12 h). |
| `windowComplete` | `Boolean` (`false`) | `true` = se ha recorrido la ventana del torneo entera hasta el corte. `false` = pendiente; también es el valor de migración y el de un alta nueva. |
| `backfillPage` | `Int` (`1`) | Página del relleno por la que sigue. Las páginas 1..`backfillPage−1` ya se leyeron. |
| `windowCheckedAt` | `DateTime?` | Cuándo se completó por última vez el recorrido de la ventana, incluidos los rechecks de F2b. `null` = nunca. |
| `createdAt`, `updatedAt` | `DateTime` | |

Regla de la puerta (issue 119): una fila con `discordVerificationRequestedAt` informado y
`discordVerifiedAt` a `null` **no puede quedar `APPROVED`**, salvo la aprobación explícita sin
verificación del superadministrador. Se comprueba en las Server Actions, no en las consultas de
puntuación: un `PENDING` ya queda fuera de la clasificación, de la web y del rol.

Índices: `id` (pk), `profileId` (único) y `(status, windowComplete, backfillPage)` para la cola del
relleno (`status` filtra; `windowComplete` y `backfillPage` ordenan, con los pendientes primero). Los
únicos de Discord (`discordUserId` y `discordUsername`) son **restricciones**, no filtros: sostienen
"una cuenta y un `@usuario` no están en dos participantes". El de `discordVerificationToken` existe
porque es la única forma de encontrar la fila desde el `custom_id` de un botón: la interacción de
Discord no manda ningún otro identificador.

> Las tres columnas de la ventana y su índice ya están aplicados en producción con el `db:push` de F2.

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
| `apm` | `Int?` | APM de la partida según su resumen. `null` = **sin resumen** (no es `0`), y es la marca de que la partida tiene resumen. |
| `feudalAgeSeconds`, `castleAgeSeconds`, `imperialAgeSeconds` | `Int?` | Segundos de partida en que se alcanzó cada edad; gana el **primer** instante. |
| `villagersLost`, `gildedVillagersLost`, `mountedVillagersLost` | `Int?` | Aldeanos perdidos, por tipo. Los dorados y los montados van aparte porque `defensor-del-pueblo` los exige por separado. |
| `summaryCheckedAt` | `DateTime?` | Cuándo se obtuvo una respuesta **concluyente** del resumen (200 o 404). `null` = nunca. Saca la partida de la cola: ya se sabe si hay resumen o no. |
| `summaryLastAttemptAt` | `DateTime?` | Cuándo se pidió el resumen por última vez, con **cualquier** desenlace (200, 404, fallo o 429). `null` = nunca se intentó. Sostiene el reintento de 1 h y detecta las partidas que se intentaron y nunca se resolvieron (`SUMMARY_NOT_REVIEWED`). |
| `summaryAnomalies` | `Json?` | Evidencia compacta del resumen para las alertas. `null` = no hay resumen. Forma: `{ buildOrderReadable, firstVillagerSeconds, militaryNoGrowth: { fromSeconds, toSeconds }[], noResourceGain: { fromSeconds, toSeconds } \| null }`, con `null` en lo que no se pudo leer. `militaryNoGrowth` es una **lista** (todos los tramos sin máximo nuevo, los 10 más largos y de mayor a menor) porque la gracia inicial se descuenta después; `noResourceGain` es solo el más largo. Ver `src/lib/aoe4world/summary-anomalies.ts`. |
| `points` | `Int` (`0`) | Puntos que aporta según el ruleset: `pointsPerWin` en una victoria clasificatoria, 0 en el resto. Solo lo escribe el motor. |
| `revertedAt` | `DateTime?` | Marca de "deja de puntuar" (reversible). `null` = puntúa. |
| `rawJson` | `Json` | La partida tal cual la devolvió la API. **No se borra nunca.** De aquí salen los compañeros y su rating para la condición de equipo. |
| `createdAt` | `DateTime` | |

Índices: único `(playerId, gameId)` (dedupe del worker); `(playerId, startedAt)`,
`(playerId, finishedAt)`, `(mode, startedAt)`. Ver [Índices](#índices).

`mode` y `civRandomized` se rellenaron con `npm run backfill:model` en las filas anteriores; a
partir de ahí las escribe el worker con cada partida.

Las **ocho métricas** del resumen de partida (`apm` … `mountedVillagersLost`) más **dos columnas de
control** (`summaryCheckedAt` y `summaryLastAttemptAt`) y la evidencia (`summaryAnomalies`) las escribe
el worker desde una ruta del **sitio** de AoE4World (no de su API) que se pide aparte y solo importa a
las partidas que puntúan; el detalle está en
[`OPERACION.md`](./OPERACION.md#resumen-de-partida). Las métricas las leen cinco objetivos, y en todas
ellas `null` significa "**no hay resumen**", nunca "cero": una partida sin resumen no cumple ninguna
hazaña y corta la racha de `ansioso`. `apm` es la marca de que la partida tiene resumen. Las dos marcas
de control no son métricas del juego: `summaryCheckedAt` dice si hubo respuesta concluyente y
`summaryLastAttemptAt` cuándo se intentó por última vez. `summaryAnomalies` no lo lee ningún objetivo:
es la evidencia que consume el motor de alertas (`NO_VILLAGERS_FIRST_MINUTES`, `NO_MILITARY_GAP` y
`NO_RESOURCES_GAP`), y `null` ahí es "no hay resumen o no se pudo leer", que no genera alerta.

## `PlayerScore`

La clasificación agregada: **una fila por jugador y versión de reglas**. Es la tabla de la que lee
la web; `Match` no se lee para pintar la clasificación.

| Campo | Tipo | Nota |
|---|---|---|
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `ruleSetVersion` | `Int` | Con qué versión de reglas se calculó. Permite convivir dos versiones sin pisarse. |
| `rank` | `Int` | Puesto de competición con el desempate ya aplicado: dos filas empatadas en total, tasa de victorias, victorias y partidas **comparten** puesto (1, 2, 2, 4). **Se guarda** porque el orden no se resuelve en SQL. |
| `total` | `Int` | `objectives.points + events.points`: la suma de los objetivos del jugador y el bono de los eventos puntuales. Las victorias son el objetivo `victorias`; el bono es un concepto aparte. |
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

Formato de `breakdown` (tipo `ScoreBreakdown` en `src/lib/scoring.ts`): las familias y los dos bloques
de puntos están siempre presentes en una fila nueva, con ceros si no aplican.

```json
{
  "ruleSetVersion": 4,
  "rule": "2 puntos por victoria clasificatoria más 88 objetivos: 29 competiciones y 59 logros",
  "byMode": {
    "rm_solo": { "wins": 3, "points": 6, "matches": 5 },
    "rm_team": { "wins": 1, "points": 2, "matches": 2 }
  },
  "objectives": {
    "points": 283,
    "earned": ["victorias", "loco-por-ganar", "rey-1v1"],
    "awards": {
      "victorias": { "points": 168, "count": 84 },
      "loco-por-ganar": { "points": 25, "count": 1 },
      "rey-1v1": { "points": 90, "count": 1 }
    }
  },
  "events": {
    "points": 12,
    "awards": {
      "clasico-otono": { "points": 12, "wins": 3, "multiplier": 3 }
    }
  }
}
```

`objectives.points` + `events.points` es el total de la fila. `awards` guarda, por id cobrado, el
**importe real** y las **repeticiones** (`count`): `imparable` cobra 1 punto por día con tope y
`victorias`, `pointsPerWin` por victoria, así que el precio del catálogo no es lo que se cobró. Las filas
escritas antes de que existiera `awards` no lo traen, y quien las lea cae al precio de catálogo y a una
repetición. `byMode` y `Match.points` son auditoría: no se suman al total.

`events` es **opcional** en las filas escritas antes de que existieran los eventos. `awards` va por
`EditionEvent.id` y guarda las victorias que cobraron ese evento, su multiplicador y los puntos que
salieron de ellas. `Match.points` sigue siendo el punto base por victoria; el bono no se materializa en
`Match`, solo aquí (ver [`PUNTUACION.md`](./PUNTUACION.md)).

## `ObjectiveEvent`

Un **logro** cobrado por un jugador y **cuándo**. Un evento por objetivo y jugador: en un logro
puede haber muchos (todos los que lo completan). Las **competiciones** no viven aquí sino en
`ObjectiveLeadEvent`. Lo leen los dos historiales que mezclan partidas y objetivos
(`/admin/historial` y `/historial`); no alimenta la clasificación.

| Campo | Tipo | Nota |
|---|---|---|
| `objectiveId` | `String` | Id del catálogo (`imparable`, `lider-japanese`…). Solo logros. |
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `achievedAt` | `DateTime` | Fin de la ventana del torneo (los logros se resuelven en caliente). |
| `recordedAt` | `DateTime` | Cuándo lo registró el motor. |

Índices: `(objectiveId, playerId)` (único, para la reconciliación), `(achievedAt, objectiveId)` (feed:
fecha y desempate) y `(playerId, achievedAt)` (filtro por jugador y cascada desde su primera columna).

Es un **espejo del cómputo, no un log**: si cambia quien completa un logro, la fila se actualiza o se
borra. Todo el catálogo de logros se registra al cerrar la ventana; mientras está abierta no se
escribe nada. Un objetivo apagado (`disabledObjectives`) no llega al cómputo y su fila se borra.

## `ObjectiveLeadEvent`

Un **cambio de poseedor de una competición**: quién pasa a poseerla (`GAINED`) o deja de poseerla
(`LOST`), y **cuándo**. Es lo que permite contar "ahora lidera" y "ya no lidera" en los dos
historiales, en vivo y tantas veces como una competición cambie de manos. Si la edición ya se jugó
antes de activar el registro, `npm run backfill:objective-leads` reconstruye la secuencia desde las
partidas contadas.

Es un registro **append-only**, al revés que `ObjectiveEvent`: describe un hecho de un instante —el
jugador pasó a liderar «Rey del 1v1»— y eso no deja de ser cierto porque después cambie el poseedor.
Lo escribe `reconcileObjectiveLeadEvents()` (`src/lib/objective-leads.ts`) dentro de la transacción de
`recomputeScores()`, derivando el poseedor actual de `awarded` y comparándolo con el último estado
anotado; no escribe nada mientras no cambie ningún poseedor (el worker pasa 288 veces al día).

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `objectiveId` | `String` | Id del catálogo de una **competición** (`loco-por-ganar`, `rey-1v1`, `masterizando-…`). |
| `playerId` | `String` | FK a `Player.id`, cascada. El que pasa a poseerla o el que la suelta. |
| `kind` | `ObjectiveLeadKind` | `GAINED` o `LOST`. |
| `at` | `DateTime` | Instante del recálculo que lo detectó; en el backfill, el `finishedAt` de la partida que cambió el poseedor. **El mismo en las dos filas** de un cambio. |
| `editionFrom` | `DateTime` | `window.from` de la ventana **con la que se escribió** la fila; sella la cohorte (ver abajo). |
| `recordedAt` | `DateTime` | Cuándo lo registró el motor. |

Índices: `(editionFrom, at, objectiveId, kind)` (feed: cohorte, rango de fecha y orden del merge) y
`(playerId, editionFrom, at)` (filtro por jugador y cascada desde su primera columna). **No hay índice
único**: la única clave posible sería `(objectiveId, playerId, kind, at)` y no impediría el caso real que
hay que evitar (una repetición con otro instante), así que la idempotencia la sostiene la comparación, no
una restricción.

Un cambio de poseedor escribe **dos filas con el mismo `at`**: la `LOST` del anterior y la `GAINED`
del nuevo. Un poseedor que desaparece (objetivo apagado, ventana reabierta, una partida revertida que
cambia el ranking) deja una sola `LOST`, y una competición sin filas previas y con poseedor, una sola
`GAINED` (siembra, sin reconstruir el pasado: el primer estado se anota con el instante del pase que
lo descubre). Las dos filas de un cambio solo se separan por el `kind`, que es el desempate del enum
(ver arriba).

**Cohortes.** `editionFrom` es la cohorte de la fila. Los dos feeds publican solo las de la edición
activa (igualdad con el `from` de la ventana en uso), así que una edición nueva arranca su registro
sin arrastrar los liderazgos de la anterior; y como el filtro es por ventana y no por la fecha de la
fila, **sí se ven** las correcciones posteriores al cierre de la edición en curso.

No guarda la etiqueta ni los puntos: se resuelven **al leer** (`resolveObjective()` y el ruleset
activo), como en `ObjectiveEvent`. En una competición el importe es el mismo para la pérdida y para
la ganancia (premio fijo), así que las dos filas de un cambio llevan la misma cifra y el signo lo
decide quien pinta.

## `ObjectiveProgressEvent`

Un **cambio de progreso** de un objetivo: cuándo un jugador lo cumplió (`CUMPLIDO`), lo perdió
(`PERDIDO`) o avanzó hacia él (`PROGRESADO`), **con los valores** de progreso de ese instante. Es el
feed que lee la API del overlay (`GET /api/v0/clasificacion`), que publica por objetivo el `tipo`, la
`fechahora` y el `progreso { propio, ajeno? }` de cada evento. **No alimenta la clasificación.**

El contrato que lo publica —endpoints, campos, tipos y errores— está en
[`API-OVERLAY.md`](./API-OVERLAY.md).

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `objectiveId` | `String` | Id del catálogo (`victorias`, `imparable`, `loco-por-ganar`…). Sin FK: son constantes de código, como en `ObjectiveEvent` y `ObjectiveLeadEvent`. |
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `kind` | `ObjectiveProgressKind` | `CUMPLIDO`, `PERDIDO` o `PROGRESADO`. |
| `at` | `DateTime` | Instante del **recálculo que detectó el cambio**, no la fecha de la partida. En la siembra de un logro con la ventana cerrada, `window.to`. |
| `editionFrom` | `DateTime` | `window.from` de la edición que sella la cohorte (ver abajo). |
| `ownValue` | `Int` | Progreso propio en el momento del evento. |
| `otherValue` | `Int?` | Solo en `PERDIDO`: valor del **nuevo poseedor**. `null` si no hay poseedor, y `null` en los otros dos tipos. |
| `repetition` | `Int?` | Solo en los objetivos repetibles (`victorias`, `imparable`); `null` en el resto. |
| `recordedAt` | `DateTime` | Cuándo lo registró el motor. |

Índices: `(playerId, editionFrom, at)` (consulta de la API por jugador y `desde`, con el orden del
feed detrás) y `(editionFrom, at, objectiveId)` (cohorte y orden del feed completo de una edición).

Es **append-only**, al revés que `ObjectiveEvent`, y **no es un espejo**: describe un hecho de un
instante —"pasó de 7 a 8 victorias"— que no deja de ser cierto porque después se revierta una partida;
lo que hay que anotar es el cambio siguiente. Un espejo no serviría, porque el overlay necesita la
secuencia, no el estado final.

**Cohortes.** `editionFrom` es la cohorte de la fila, como en `ObjectiveLeadEvent`: la API filtra por
la edición activa, así que una edición nueva arranca su feed sin mezclar el progreso de la anterior.

**Por qué guarda los valores.** Las tablas de historial anteriores no los guardan: `ObjectiveEvent`
solo anota el cierre de la ventana y `ObjectiveLeadEvent` solo el cambio de poseedor. El contrato del
overlay pide el progreso histórico **exacto**, y el valor de hoy no sirve para reconstruir el de ayer.

**Siembra.** La primera fila de un objetivo **no reconstruye el pasado**: se anota con el instante del
pase que la descubre, porque el momento en que el progreso empezó no consta en ninguna parte.

**Quién la escribe.** `recomputeScores()`, en la misma transacción que la clasificación.

## `ObjectiveProgressState`

El **estado actual** del progreso de un jugador en un objetivo, dentro de una edición: la memoria de
trabajo de la reconciliación. **No se publica** y no tiene relación con la API.

| Campo | Tipo | Nota |
|---|---|---|
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `objectiveId` | `String` | Id del catálogo de objetivos. |
| `editionFrom` | `DateTime` | `window.from` de la edición a la que pertenece el estado. |
| `value` | `Int` | Progreso actual, **recortado al máximo** en los objetivos con tope. |
| `completed` | `Boolean` | Posee la competición o ha completado el logro. No es lo mismo que "tiene el máximo". |
| `repetition` | `Int?` | Repeticiones actuales en los repetibles; `null` en el resto. |
| `updatedAt` | `DateTime` | |

Clave primaria `(playerId, objectiveId, editionFrom)` —una fila por jugador, objetivo y edición, porque
el progreso se reinicia con la edición— e índice `(editionFrom, objectiveId)` para cargar el estado de
una edición entera de una vez.

**Evento y estado no son lo mismo.** El evento es historia y no se toca; el estado se reescribe en cada
pase y existe solo para que el recálculo sepa **qué cambió** sin releer el feed entero: carga el estado
de la edición, lo compara con el cómputo del pase y anexa un evento por cada diferencia.

**Quién la escribe.** `recomputeScores()`, igual que el feed.

## `Alert`

Un comportamiento anómalo, detectado sobre las partidas clasificatorias. Es **append-only**: una
fila dice "a la 1 se detectó esto" y no se reescribe. Las lecturas del panel y del informe se acotan
a la **edición activa** (`createdAt >= window.from`): las filas de ediciones anteriores siguen en la
tabla, pero dejan de publicarse al avanzar la ventana.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `rule` | `AlertRule` | Qué comportamiento. La lista es fija en código; los umbrales, no (`alerts.ruleset`). Dos de sus valores son legado y ya no se calculan, pero hay filas escritas con ellos. |
| `kind` | `AlertKind` | Cómo se detectó. |
| `playerId` | `String` | FK a `Player.id`, cascada. |
| `subjectProfileId`, `subjectName` | `Int?`, `String?` | El rival (R2) o compañero (R3). No es FK: el sujeto suele ser de fuera de la liga. |
| `count`, `threshold` | `Int` | Magnitud medida y umbral del ruleset. En las reglas de estado, la magnitud con la que se comparó. En las tres de partida nacidas del resumen: los segundos del tramo (0 en la de aldeanos, "cero aldeanos") y el umbral que lo dispara (en la de aldeanos, los segundos del arranque). |
| `anchorGameId` | `String?` | La partida que disparó la alerta. `null` en las reglas de estado. **No** es `null` en `MATCH_DETECTED`: el hallazgo **es** una partida. |
| `dedupeKey` | `String` **único** | Clave compuesta en código; ver abajo. |
| `summary` | `String` | Una línea en español, ya redactada al escribir la fila. |
| `details` | `Json` | Evidencia estructurada. |
| `createdAt` | `DateTime` | |

Índices: `dedupeKey` (único), `(createdAt)` y `(playerId, rule)`.

La `dedupeKey` es texto y no un índice único compuesto porque en Postgres los `NULL` de un índice
único no colisionan, y el sujeto es opcional. Se compone con (regla, tipo, jugador, sujeto y el
remate: la partida o el número), salvo en `STATE_DETECTED`, que es solo (regla, tipo, jugador)
porque un estado no tiene remate y si no insertaría una fila nueva cada 12 horas.

`MATCH_DETECTED` es lo contrario de `STATE_DETECTED`: es el **hallazgo de una partida concreta** (no
creó aldeanos en el arranque, no hizo un máximo militar, no recolectó), lleva el `anchorGameId` en la
clave y por eso hay **una fila por partida y regla**. `SUMMARY_NOT_REVIEWED` es de **estado** y una por
jugador: cuenta las partidas que pasaron la ventana de revisión del resumen sin respuesta concluyente,
tras haberse intentado. Las dos existen a la vez porque `HISTORY_NOT_PUBLIC` afirma que el historial está
cerrado (lo confirmó el sondeo) y `SUMMARY_NOT_REVIEWED` dice que no se pudo confirmar nada.

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

## `AdminAct`

Una **actuación administrativa**: la unidad con la que la organización expulsa a un participante,
anula partidas ganadas o revierte actuaciones anteriores. Es un historial **aparte de `AdminAction`**:
la actuación tiene razón pública (la que se anuncia), información privada (que no sale del panel),
autor y fecha, y se aplica en el momento. `AdminAction` sigue siendo el rastro técnico de cada cambio;
`AdminAct` es el expediente que lo explica.

| Campo | Tipo | Nota |
|---|---|---|
| `id` | `String` (cuid) | |
| `kind` | `AdminActKind` | `BAN`, `MATCH_ANNULMENT` o `REVERSAL`. Una actuación tiene **una sola** acción. |
| `playerId` | `String?` | FK a `Player.id` con `SetNull`: la actuación sobrevive al borrado del jugador. |
| `playerName`, `profileId` | `String`, `Int` | Foto del momento, la que queda si `playerId` pasa a `null`. |
| `summary` | `String` | Frase ya redactada en español (`adminActSummary()`). No lleva información privada. |
| `publicReason` | `String` | Obligatoria (máx. 600 caracteres). Es lo único que se manda a Discord. |
| `privateInfo` | `String?` | Opcional (máx. 4000). **Nunca** sale del panel ni se loguea. |
| `actorEmail` | `String` | Correo del usuario de Supabase Auth que la creó. |
| `matchCount` | `Int` | Partidas anuladas; en una reversión, la unión de las afectadas por lo revertido. |
| `statusBefore` | `PlayerStatus?` | Estado que tenía el jugador antes de una expulsión. Es lo que restaura la reversión. `null` en los otros tipos. |
| `revertedAt`, `revertedByEmail` | `DateTime?`, `String?` | Marca de que otra actuación la revirtió. `null` = vigente. En una `REVERSAL` siempre es `null`. |
| `reversedByActId` | `String?` | La actuación de reversión que la deshizo. Autorrelación con `SetNull`. |
| `createdAt` | `DateTime` | |

Índices: `(createdAt)` (listado), `(kind, createdAt)` (filtro por tipo), `(playerId, createdAt)`
(filtro por jugador y `SetNull`), `(revertedAt, kind)` (vigentes/revertidas) y `(reversedByActId)`
(autorrelación). Son las consultas del listado y del detalle, no índices preventivos.

La **reversión es final**: una `REVERSAL` no se puede revertir, y un objetivo de reversión tiene que
ser una actuación vigente que no sea `REVERSAL`. Una expulsión y una anulación del mismo jugador son
**dos** actuaciones; la única que selecciona varias filas es la reversión, y siempre del mismo
participante.

El **borrado del jugador** se rechaza mientras tenga actuaciones vigentes y revertibles
(`revertedAt null` y `kind != REVERSAL`) o esté `BANNED`: primero se revierte, después se decide la
baja. Las actuaciones históricas quedan con `playerId = null` y su foto de nombre y perfil.

## `AdminActMatch`

Qué partidas anuló una actuación (`MATCH_ANNULMENT`). Es la lista de vínculos, no una copia de la
partida: los datos se leen en vivo de `Match`.

| Campo | Tipo | Nota |
|---|---|---|
| `actId` | `String` | FK a `AdminAct.id`, cascada. |
| `matchId` | `String` | FK a `Match.id`, cascada. |

Clave primaria `(actId, matchId)` e índice `(matchId)` para "qué actuaciones anularon esta partida" y
para la cascada desde `Match`. Una reversión de una anulación quita `Match.revertedAt`; los vínculos se
quedan, porque son el historial de qué actuación hizo qué.

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
| `scoring.lastRun` | Rastro del último recálculo: `ruleSetVersion`, `cacheVersion` (`SCORING_CACHE_VERSION`), `playersRanked` y las cifras del resultado. Lo lee el worker para decidir si puede saltarse el recálculo. | `recomputeScores()` |
| `scoring.objectives` | Vista pública de objetivos (`ObjectiveView`) con su `snapshotVersion` (hoy 3) y la huella del contenido. La leen `/objetivos` y la ficha de participante; si falta o no valida, se recomputa en vivo. | `recomputeScores()` |
| `sync.lastRun` | Rastro de la última pasada de sincronización. | Worker (`src/lib/aoe4world/sync.ts`) |
| `sync.gamesCursor` | Cursor global de partidas: `updatedAt` (el `updated_since` de la siguiente pasada), `seededAt`, `seededFrom`, la racha de lotes truncados y el mejor `backfillPending` visto. | Worker (`src/lib/aoe4world/sync.ts`), con `writeGamesCursor()` |
| `streams.lastRun` | Cuándo se comprobó por última vez el estado de directo de YouTube/Kick, en ISO-8601 UTC. Separa el reloj del paso (10 min) del de las partidas (1-3 min) para no gastar la cuota de YouTube. | Worker (`src/lib/aoe4world/sync.ts`), con `writeStreamsLastRun()` |
| `alerts.ruleset` | Umbrales de las reglas de alerta. | `npm run alerts:*` / código |
| `alerts.divisionCutoffs` | Cortes rating → subdivisión por familia de ladder (hoy solo `rm_team`): los usa la **condición de equipo** del motor de puntuación, y el de alertas los lee para filtrar con la misma regla. | `npm run alerts:cutoffs` |
| `discord.roster` | Lista de miembros del servidor cacheada (TTL 12 h). | `src/lib/discord/roster-cache.ts` |
| `discord.participantRole` | Memoria del rol de participante: los `discordUserId` a los que el bot ha puesto el rol (`granted`) y cuándo se sincronizó (`syncedAt`). Permite quitarle el rol a quien deja de estar aprobado aunque su fila se haya borrado. | Worker (`src/lib/discord/role-sync.ts`) |
| `discord.standingsReport` | Memoria del informe diario de clasificación: el día de Madrid del último informe completo (`lastDay`), el día a medias (`pendingDay`) y cuántos trozos ya salieron (`sentChunks`). Evita repetir el informe del mismo día y permite reanudarlo sin repetir mensajes. | Worker (`src/lib/standings-report.ts`) |
| `registration.countries` | Países que admite el formulario, en el orden del catálogo. | `npm run countries:seed` o el panel (**solo el superadministrador**), con `saveCountries` |
| `registration.open` | Si la inscripción está abierta. | Panel (**solo superadministrador**), con `setRegistrationOpen`; el cambio deja `CONFIG_CHANGED` en `AdminAction` |
| `registration.closesAt` | Fecha de cierre de inscripciones (ISO-8601 UTC). Pasada, el plazo se cierra solo; el interruptor sigue pudiendo cerrar antes. Ausente = sin fecha. | Panel (**solo superadministrador**), con `setRegistrationClosesAt`; el cambio deja `CONFIG_CHANGED` en `AdminAction` |
| `donations.matcherino` | Campaña de donaciones de Matcherino: si el banner está activo y su URL. | Panel (**solo superadministrador**), con `setMatcherinoDonations`; el cambio deja `CONFIG_CHANGED` en `AdminAction` |
| `edition.config` | Configuración de la edición: nombre, premio base (importe y nota), retransmisión obligatoria y marca (emblema y color de acento). Versión 1 fija en código. | Panel de admin (**solo el superadministrador**) |
| `edition.events` | Eventos puntuales de la edición: id estable, nombre, instrucciones, ventana `[from, to)` en ISO-8601 UTC, multiplicador entero `>= 2` y si exige Discord. Versión 1 fija en código. Solo se crean o editan **antes de `window.from`**; cada evento cae dentro de la ventana del torneo y no se solapa con otro. | Panel de admin (**solo el superadministrador**), con `saveEditionEvent` / `deleteEditionEvent` |
| `edition.events.state` | Snapshot de elegibilidad por evento, congelado al empezar: `checkedAt`, `checkedPlayerIds` y `eligiblePlayerIds`. Un evento con `discordRequired` sin snapshot no reparte bono. Versión 1. | Proceso de comprobación de Discord (el worker); al borrar un evento, su entrada se borra en la misma transacción |
| `edition.events.announcements` | Memoria de los avisos de eventos en Discord: `sent` con la clave `${eventId}:24h`/`12h`/`1h`/`start`/`end` → instante ISO en que se mandó. Un documento roto se lee como vacío. Versión 1. | Worker (`src/lib/edition-event-announcements.ts`) |
| `edition.announcements` | Memoria de los avisos de la edición en Discord: comienzo y final (`startedAt`/`finishedAt`, o `null`), los hitos nuevos ya avisados (`sent`: clave de hito → instante) y si el plazo de inscripción llegó a estar abierto (`registrationWasOpen`). Una marca puesta no se quita nunca. | Worker (`src/lib/edition-announcements.ts`) |
| `simulation.roster` | Manifiesto de `npm run simulate:tournament`. | `simulate:tournament` |
| `streams.youtube.channel.<handle>` | `channelId` de YouTube y su playlist de subidas, ya resueltos (30 días). | Worker |
| `aoe4world.sync.player.<profileId>` | Estado de **auditoría** del último relleno del jugador: `since`, `maxStartedAt`, `lastSyncedAt` y abandonos. Ya no es el cursor de petición; ese es global (`sync.gamesCursor`). | Worker; la baja de `/admin` lo **borra** con el jugador (misma transacción), para que un alta posterior del mismo perfil no herede una auditoría vieja. |

## Índices

Los índices reales en producción, y la consulta que sostiene cada uno. La regla: **un índice que no
aparece en una consulta, no se crea.**

| Tabla | Índice | Consulta |
|---|---|---|
| `Player` | `id` (pk), `profileId` (único) | Ficha por id o por `profileId`. |
| `Player` | `discordUserId`, `discordUsername` (únicos) | Restricciones, no filtros. |
| `Player` | `discordVerificationToken` (único) | Única forma de encontrar la fila desde la interacción de Discord: la petición solo trae el `custom_id` del botón. |
| `Player` | `(status, windowComplete, backfillPage)` | Candidatos al relleno: aprobados con la ventana pendiente, por página. |
| `Match` | único `(playerId, gameId)` | Dedupe del worker. |
| `Match` | `(playerId, startedAt)` | Partidas de un jugador por fecha. |
| `Match` | `(playerId, finishedAt)` | Partidas en curso y orden de hitos. |
| `Match` | `(mode, startedAt)` | Clasificatorias dentro de la ventana (igualdad + rango). |
| `PlayerScore` | pk `(playerId, ruleSetVersion)` | Ficha del jugador; de paso indexa la FK para el `Cascade`. |
| `PlayerScore` | `(ruleSetVersion, rank)` | **La consulta más caliente**: la clasificación, ordenada por `rank` y, dentro del puesto compartido, por `Player.profileId`. |
| `ObjectiveEvent` | `(objectiveId, playerId)` (único), `(achievedAt, objectiveId)`, `(playerId, achievedAt)` | Reconciliación; feed paginado por ventanas (fecha y desempate por objetivo); filtro por jugador y cascada. |
| `ObjectiveLeadEvent` | `(editionFrom, at, objectiveId, kind)`, `(playerId, editionFrom, at)` | Feed paginado por ventanas (cohorte, rango de fecha y orden del merge); filtro por jugador y cascada. |
| `ObjectiveProgressEvent` | `(playerId, editionFrom, at)`, `(editionFrom, at, objectiveId)` | Consulta de la API del overlay por jugador, edición y `at >= desde`; cohorte y orden del feed de una edición. |
| `ObjectiveProgressState` | pk `(playerId, objectiveId, editionFrom)`, `(editionFrom, objectiveId)` | Estado de un jugador y cascada desde su primera columna; carga del estado de una edición en la reconciliación. |
| `Alert` | `dedupeKey` (único), `createdAt`, `(playerId, rule)` | Idempotencia, listado, detalle por jugador. |
| `AdminAction` | `createdAt`, `(type, createdAt)` | Listado y filtro por tipo. |
| `AdminAct` | `createdAt`, `(kind, createdAt)`, `(playerId, createdAt)`, `(revertedAt, kind)`, `(reversedByActId)` | Listado y filtros por tipo, jugador y estado; autorrelación de la reversión. |
| `AdminActMatch` | pk `(actId, matchId)`, `(matchId)` | Vínculos de una anulación; cascada desde `Match`. |
| `Admin` | `email` (único), `authUserId` (único) | Acceso al panel por correo y vínculo con Auth. |
| `RateLimitCounter` | `key` (pk) | El `INSERT ... ON CONFLICT`. |

## Consultas calientes

| Dónde | Consulta | Índice |
|---|---|---|
| `/` (clasificación) | `PlayerScore where ruleSetVersion = V order by rank, Player.profileId` + `Player` por id; si sale vacía, `max(ruleSetVersion) < V` y la misma consulta con esa versión (respaldo, ver `docs/OPERACION.md`) | `(ruleSetVersion, rank)` |
| `/partidas` | `Match where finishedAt is null` y `Player.status = APPROVED`, por `startedAt` | `(playerId, finishedAt)`; sin índice parcial (no se ha necesitado) |
| `/objetivos` | `Match` clasificatorias de todos los aprobados, en la ventana | `(mode, startedAt)` |
| `/admin` (jugadores) | `Player order by profileId` | `profileId` (único) |
| `/admin/historial` | Las mismas filas que `/historial`, de todos los aprobados: `Match` victorias clasificatorias con puntos (o revertidas) + `ObjectiveEvent` + `ObjectiveLeadEvent` (estos, filtrados por `editionFrom`), paginados por ventanas | `(mode, startedAt)`, `(playerId, startedAt)`, `(achievedAt, objectiveId)`, `(playerId, achievedAt)`, `(editionFrom, at, objectiveId, kind)`, `(playerId, editionFrom, at)` |
| `/historial` y el historial de un participante (`/detalle-jugador/<id>/historial`) | Las mismas tablas, pero solo ganancias: `Match` victorias clasificatorias con puntos (o revertidas) de `Player.status = APPROVED`, y `ObjectiveEvent` de los aprobados, más los `ObjectiveLeadEvent` de la edición activa; paginados por ventanas | `(mode, startedAt)`, `(playerId, startedAt)`, `(achievedAt, objectiveId)`, `(playerId, achievedAt)`, `(editionFrom, at, objectiveId, kind)`, `(playerId, editionFrom, at)` |
| Relleno de la ventana (F2/F2b) | `Player where status = APPROVED and (windowComplete = false or (windowComplete = true and (windowCheckedAt is null or windowCheckedAt < now − RECHECK_MAX_AGE_DAYS))) order by windowComplete, backfillPage, profileId`; y el `count` de `windowComplete = false` para `backfillPending` | `(status, windowComplete, backfillPage)` |
| `/admin/alertas` | `Alert` de la edición activa (`createdAt >= window.from`) `[por jugador/regla] order by createdAt` | `createdAt`, `(playerId, rule)` |
| `/admin/actuaciones` | `AdminAct` por fecha descendente, filtrada por tipo, jugador o estado | `createdAt`, `(kind, createdAt)`, `(playerId, createdAt)`, `(revertedAt, kind)` |
| Inscripción | `RateLimitCounter` con `ON CONFLICT` | `key` (pk) |
| Acceso al panel (`requireAdmin`) | `Admin` por `email` (una fila por petición con sesión) | `email` (único) |
| Motor (recálculo) | `Match where mode = any(...) and startedAt en ventana and result/finishedAt no nulos` | `(mode, startedAt)` |
| API del overlay (`GET /api/v0/clasificacion`) | `ObjectiveProgressEvent where playerId = X and editionFrom = edición and at >= desde order by at` | `(playerId, editionFrom, at)` |
| Motor (reconciliación del progreso) | `ObjectiveProgressState where editionFrom = edición`, y una fila por `(playerId, objectiveId, editionFrom)` al comparar | `(editionFrom, objectiveId)`; pk `(playerId, objectiveId, editionFrom)` |

El filtro de qué cuenta es **uno solo**: `src/lib/ranked-match.ts` (ventana, corte de inscripción,
marca de revertida y la condición de equipo de las partidas por equipos) y lo reparte como
`countsAsRanked`, `rankedMatchWhere` y `rankedMatchSql` —la condición de equipo solo cabe en las dos
últimas, así que quien use el `where` de Prisma la filtra después en memoria—. El panel usa
`classificatoryWhere()`, que es lo mismo sin la marca de revertida, para poder listarlas.

## RLS y privilegios

Postura **cerrada**, aplicada a las catorce tablas de `public`:

| Paso | Qué |
|---|---|
| 1 | `enable row level security` en todas las tablas. |
| 2 | **Ninguna política**: con RLS y sin políticas, cualquier rol sin `BYPASSRLS` ve cero filas. |
| 3 | **Ningún `grant`** a `anon` ni a `authenticated`. |
| 4 | Comprobar con `npm run db:security -- --check`. |

Estado real: RLS activa y 0 políticas en las catorce tablas, y sin permisos para `anon` ni
`authenticated`. `service_role` conserva sus permisos y su `BYPASSRLS`: es un rol de infraestructura
de Supabase, no un cliente del torneo. Consecuencia en la Data API: **`401 permission denied`** (el
permiso de tabla se comprueba antes que RLS). No se "arregla" concediendo `SELECT`; si algún día
hace falta servir una tabla, sería con una vista `security_invoker = true` y un `grant` a la vista.

- Vive en [`scripts/db-security.ts`](../scripts/db-security.ts) y no en el schema porque `prisma db
  push` no modela RLS ni permisos.
- Antes de activar RLS, el script comprueba que el rol de `DATABASE_URL` tenga `BYPASSRLS`; si no,
  se niega a aplicar nada (la web dejaría de ver datos en silencio).
- La lista de tablas del script es **explícita**: al añadir una tabla hay que añadirla ahí, porque
  una tabla nueva nace con los permisos por defecto de Supabase. Las catorce están en esa lista;
  `ObjectiveProgressEvent` y `ObjectiveProgressState` entraron con la API del overlay y se leen solo
  por el DAL, nunca por la Data API.

## Cambios de esquema

**Todo** cambio de esquema —una columna incluida, no solo una tabla— se aplica con `db:push` en
**desarrollo y en producción**. Son dos bases distintas y ninguna hereda el esquema de la otra.

- La fuente es `prisma/schema.prisma`. Un cambio va ahí, luego `npm run generate` y `npm run db:push`.
- `npm run db:check` dice si una base está al día: **0** = al día, **2** = le falta el schema, **1** =
  error. Compara contra el `DATABASE_URL` del entorno y no escribe nada. No va en CI ni en el build: el
  workflow y las Workers Builds no definen esa variable en *build* a propósito.
- **Por qué una columna ausente no es un detalle**: Prisma pide `SELECT` de **todas** las columnas del
  modelo, así que la que falta tumba cualquier lectura o escritura de esa tabla (`The column Player.X
  does not exist in the current database`), aunque las consultas públicas usen `select` explícito y
  sigan funcionando. El motivo real solo está en el log del servidor, con el prefijo `[db]`; la
  interfaz dice "La base de datos no ha respondido" y despista hacia un corte transitorio.
- **Nada de `prisma migrate dev`**: el script `migrate` del `package.json` no es válido en este
  proyecto, porque Supabase no permite *shadow database*. `migrate diff` (lo que ejecuta `db:check`)
  sí: solo compara y no abre shadow database.
- La base es la de **producción y no hay *staging*`. Nada de `--accept-data-loss`: si `db push`
  avisa de pérdida, hay que mirarlo.
- **Después de cada `db:push` que añada tablas**: `npm run db:security -- --check` (una tabla nueva
  nace accesible para los roles de cliente). Si falla, `npm run db:security`.
- Los cambios de datos masivos (por ejemplo un *backfill*) se hacen con el worker parado.
