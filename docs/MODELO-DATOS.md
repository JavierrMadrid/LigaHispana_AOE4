# Modelo de datos — Liga Hispana AoE4

Traducción a tablas de las reglas de puntuación. Es la especificación de
`docs/PUNTUACION.md` (que define **qué** puntúa y **cuánto**) al esquema de
la base de datos (que define **dónde vive cada dato**).

> **Estado en esta rama: aplicado a medias.** La parte del modelo que no depende
> de las reglas ya está en `prisma/schema.prisma` y en la base de datos. La parte
> que sí depende (el *ruleset* Wololo completo, los snapshots y las categorías)
> sigue sin aplicarse, a la espera de que la comunidad cierre las reglas.
> **El capítulo "Adaptación al MVP" es el mapa de qué es cuál**, y lo primero que
> hay que leer para no confundirse con el diseño completo.

| | |
|---|---|
| Estado | **Parcialmente aplicado.** Ver "Adaptación al MVP" (§0 bis) para el desglose exacto de qué sí y qué no. |
| Depende de | `docs/PUNTUACION.md` (§9 lista los once requisitos que este documento tiene que cubrir) y `docs/PLAN.md` (reglas heredadas de F2). |
| Punto de partida | `prisma/schema.prisma` a fecha de hoy: `Player`, `Match`, `Setting`, más `PlayerScore`, `RateLimitCounter`, `AdminAction`, `ObjectiveEvent` y `Alert`. |
| Cubre | Los once requisitos de `PUNTUACION.md` §9. El cruce está en §3 y en §5. |
| No cubre | El motor de cálculo (F3, código), la interfaz (F4), el panel de admin ni la seguridad del formulario público (`RateLimitCounter`, §1.5). |

> **Dónde está `PUNTUACION.md`.** Este documento lo referencia unas veinte veces
> como si estuviera al lado, y **no lo está**: las reglas de puntuación completas
> viven en la rama `docs/f3-puntuacion` (`git show docs/f3-puntuacion:docs/PUNTUACION.md`).
> Tampoco se han copiado aquí, porque sus reglas no son las que se aplican hoy.
> Mientras la comunidad no las valide, este documento se lee como **diseño de
> referencia**: explica a dónde va cada cosa, no qué está funcionando.

## 0. Cómo se lee y cómo se edita

- **§1 es intocable.** Es el modelo que ya está en producción con datos. Si algo de ahí parece
  mejor de otra forma, está justificado en `PLAN.md` y el coste de cambiarlo está en §1.3.
- **§3 y §4 son la propuesta.** Campos, tipos, índices y el SQL que Prisma no sabe expresar.
- **§5 es el mapa que delata los huecos**: qué tabla alimenta cada regla. Si una casilla está
  vacía o dice "de momento en `rawJson`", ahí hay una decisión pendiente.
- **§9 separa las dos clases de decisión**, y no se mezclan:
  - **Decisiones de producto (P-nn)**: son del cliente. Cambiarlas no cuesta código, cuesta lo
    que el cliente quiera que signifique.
  - **Decisiones técnicas (M-nn)**: son mías, con motivo. El cliente puede revertirlas, pero
    conviene que sepa qué se rompe al hacerlo.
- Las decisiones de producto **que ya están abiertas en `PUNTUACION.md` §10 (D-01 a D-16) no se
  repiten aquí**: se enlazan. Este documento solo añade las que son específicamente de datos.

## 0 bis. Adaptación al MVP (lo que hay de este diseño en el código hoy)

Este documento describe un modelo completo, pensado para unas reglas de cinco categorías
todavía por decidir. Lo que se ha implementado **ya** es el MVP: un torneo en marcha con una
regla provisional de un punto por victoria en partida clasificatoria. Este capítulo es el
mapa de los deltas, para que nadie lea §3 y dé por hecho que `civsWonCount` existe.

### 0 bis.1 La regla que se aplica ahora

> **10 puntos por victoria clasificatoria (ranked 1v1 o por equipos) más 38 objetivos
> especiales.** La definición completa y viva está en `docs/PUNTUACION.md`; lo que
> resume este capítulo es la forma que toma en la base de datos.

- **Clasificatoria** = `Match.mode ∈ ('rm_solo', 'rm_team')`, partida **resuelta**
  (`result` y `finishedAt` no nulos) y `startedAt` dentro de la **ventana** del
  ruleset. Las dos ladders *ranked* del modo competitivo y nada más: ni customs
  (`qm_*`), ni `ew_*`, ni `ffa_*`. Una partida en curso nunca puntúa, ni a favor
  ni en contra.
- Derrota = 0 puntos (pero cuenta como partida jugada).
- **La ventana** es un intervalo `[from, to)` sobre `Match.startedAt`, con `to`
  opcional (`null` = sin fin). Vive en `Setting`, clave `scoring.ruleset`
  (`window`), es reconfigurable sin desplegar y **no** sube la versión de las
  reglas. El valor en el código es de pruebas: **2026-09-15 → 2026-10-15** en
  medianoche UTC, a la espera de que la organización fije las suyas (§0 bis.2).
  No hay duración mínima, categorías ni desempate por rating.
  El desempate es `total desc, wins desc, profileId asc`, que termina en un valor
  único, así que el puesto es un entero denso sin empates que repartir.
- La versión de reglas activa es la **`2`**, y la fija el código: `RULESET_VERSION` en
  `src/lib/scoring.ts`. Los números que sí se pueden tocar sin desplegar (puntos por
  victoria, puntos por objetivo, mínimos) viven en `Setting`, clave `scoring.ruleset`.
  La versión 1 (la regla provisional de "1 punto por victoria") ya no la publica
  nadie: su constante se eliminó y sus filas de `PlayerScore` se borraron con los
  jugadores que las tenían.

### 0 bis.2 Aplicado

| Pieza | Dónde | Nota |
|---|---|---|
| `Match.mode` + correspondencia mecánica | `resolveGameMode()` en `src/lib/aoe4world/normalize.ts` | `rm_1v1` → `rm_solo`; `rm_2v2`/`rm_3v3`/`rm_4v4` → `rm_team`; el resto tal cual (§3.1.1). `leaderboard` **no** se toca. |
| `Match.civRandomized` | `readOwnCivRandomized()` en el mismo archivo | Se lee de la entrada del jugador con nuestro `profileId` dentro de `rawJson.teams[]`, en las dos formas en que la API la manda (anidada y plana), porque `parse.ts` ya la normaliza (§3.1.2). |
| `Match`: índice `(mode, startedAt)` | `prisma/schema.prisma` | Como en §3.1.3. Ya lo usaba el filtro por modo; con la ventana también es el que cubre el rango de fechas. Medido en esta base de datos: el planificador lo elige con `mode = ANY (...)` y `startedAt >= … and < …` como condiciones de índice. |
| `PlayerScore` (tabla nueva) | `prisma/schema.prisma` | Agregado versionado, con la pk compuesta y el índice `(ruleSetVersion, rank)` de §3.2. **Sin las columnas de categorías Wololo**; el `breakdown` JSON las absorbe. |
| `Player.scores` | `prisma/schema.prisma` | Relación inversa, como en el borrador de §4. |
| `RateLimitCounter` (tabla nueva, F6) | `prisma/schema.prisma`, `src/lib/rate-limit.ts` | **Ajena a las reglas de puntuación**: sostiene el límite de frecuencia de los endpoints públicos sin sesión (§1.5). Aditiva, sin RLS ni permisos para los roles de cliente, como las otras. |
| `Player.contactEmail` (columna nueva, F6) | `prisma/schema.prisma`, `src/lib/player-input.ts` | **Ajena a las reglas de puntuación** por el mismo motivo: es un dato de contacto para que la organización responda dudas, no algo de juego. Nullable, aditiva, sin índice y sin RLS nueva. Ver §1.1 y §3.5. |
| `Match.points` con valor real | `src/lib/scoring.ts` | **Cambio de fondo respecto a §3.1.4**: allí la columna se quedaba a 0 porque ninguna regla repartía puntos por partida. Aquí sí: vale `ruleset.pointsPerWin` en cada victoria clasificatoria resuelta **y dentro de la ventana**, y 0 en el resto. Es justamente la "regla de puntos por partida" que §3.1.4 anticipaba, y por eso la columna ya existía y no hubo que crearla. |
| Ventana de fechas del torneo | `src/lib/ranked-match.ts` (definición) y `src/lib/scoring.ts` (ruleset) | `Setting["scoring.ruleset"].window` = `{ from, to }`, instantes ISO-8601 UTC con zona explícita, `[from, to)` sobre `Match.startedAt`, con `to: null` como ventana abierta. **Aplicada**: una partida fuera de la ventana deja `Match.points = 0` y no entra ni en el agregado ni en los objetivos. El filtro vive en un solo módulo y lo consumen las tres consultas del motor. **Sin columnas ni índices nuevos**: el índice `(mode, startedAt)` de §3.1.3 ya lo cubría. |
| `scoring.lastRun` en `Setting` | `writeScoringLastRun()` en `src/lib/settings.ts` | Rastro de la última pasada (§3.4). Lo escribe el motor **dentro** de su transacción, así que se confirma junto con la clasificación. |
| `Match.revertedAt` (columna nueva) | `prisma/schema.prisma`, `src/lib/ranked-match.ts` | Marca de "esta partida no puntúa", nullable (`null` = cuenta). **No es un borrado**: el worker de sync volvería a importarla en su siguiente pasada, y el panel tiene que poder deshacer el cambio. Aplica a las tres traducciones de la regla (`countsAsRanked`, `rankedMatchWhere`, `rankedMatchSql`), así que una partida revertida no da ni victorias ni objetivos. El historial del panel la **lista** marcada, con `classificatoryWhere()`. |
| `AdminAction` (tabla nueva) | `prisma/schema.prisma`, `src/lib/admin-actions.ts` | Rastro de lo que hace una persona administradora. **Ajena a las reglas de puntuación**, como `RateLimitCounter`: se escribe en la misma transacción que el cambio que registra. Aditiva, sin RLS propia más allá de la postura de §7 (`TABLES` en `scripts/db-security.ts`). |
| `ObjectiveEvent` (tabla nueva) | `prisma/schema.prisma`, `src/lib/objective-events.ts` | Registro de **cuándo se cumplió cada objetivo**, para que el historial del panel pueda decirlo junto a las partidas. Es el único modelo que se apoya en §6 (carreras congeladas frente a objetivos en caliente): los del grupo `civilizacion` se escriben en cuanto hay poseedor y los 14 "en caliente" solo cuando el torneo ha terminado. §1.6. |
| `Alert` (tabla nueva, F9) | `prisma/schema.prisma`, `src/lib/alerts/` | Registro **append-only** de los comportamientos anómalos que el motor detecta sobre las clasificatorias. **Ajena a las reglas de puntuación**, como `AdminAction` y `ObjectiveEvent`: sus umbrales están en `Setting["alerts.ruleset"]` y su qué-es-clasificatoria es el `rankedMatchWhere()` de siempre, así que no añade ninguna definición nueva. Aditiva, con RLS propia solo por la postura de §7 (`TABLES` en `scripts/db-security.ts`). §1.7. |
| *Backfill* de `mode` y `civRandomized` | `npm run backfill:model` (`scripts/backfill-model.ts`) | Los SQL 3a y 3b de §8.1, idempotentes, más sus comprobaciones. |

**Formato exacto de `PlayerScore.breakdown` en el MVP.** Es un objeto con tres campos, y las
dos familias clasificatorias están **siempre presentes** (con ceros si no aplican), para que
quien lo lea no tenga que defenderse de una clave que puede no existir:

```json
{
  "ruleSetVersion": 2,
  "rule": "10 puntos por victoria clasificatoria más 38 objetivos especiales; solo el primero los cobra",
  "byMode": {
    "rm_solo": { "wins": 3, "points": 30, "matches": 5 },
    "rm_team": { "wins": 1, "points": 10, "matches": 2 }
  },
  "objectives": { "points": 125, "earned": ["loco-por-ganar", "rey-1v1"] }
}
```

El tipo exportado es `ScoreBreakdown` en `src/lib/scoring.ts`. Cuando entren las categorías
Wololo, este JSON **crece** (claves `civs`, `maps`, `crowns`, `milestones`...) sin tocar el
schema: para eso es JSON y no columnas.

### 0 bis.3 Diferido hasta que la comunidad cierre las reglas

Nada de esto está en el código, y no es un olvido: son piezas que no tienen sentido sin las
reglas que las define.

| Pieza diferida | Por qué espera |
|---|---|
| `ScoreSnapshot` (tabla) | El rastro de cada cálculo completo y su delta es útil cuando hay varias versiones conviviendo. Con una sola versión provisional, la tabla `PlayerScore` ya dice todo. Es el paso 7 de §8.1. |
| Columnas de categoría de `PlayerScore`: `civsWonCount`, `mapsWonCount`, `crownsCount`, `milestonesReached`, `ratingUsed` | Son una columna por categoría del ruleset Wololo. Con el MVP, `wins`/`matches` cubren la clasificación y `breakdown` recoge lo que la interfaz necesite. |
| Ruleset completo en `Setting` (`scoring.ruleset.active`, `scoring.ruleset.v{N}` de §3.4) | El reparto en varias versiones de documento y el puntero que las lista solo tienen sentido cuando haya más de una versión que conservar. Hoy hay una sola, y `scoring.ruleset` guarda directamente el documento activo con la v2 fijada por el código. **`scoring.lastRun` sí está aplicado** (§3.4). |
| Filtro de duración mínima | Depende del dato que pone la comunidad (D-03). El de fechas ya está aplicado (fila anterior de §0 bis.2). |
| Desempate por ratio y por rating de `rm_solo` | El rating viene de la API y cambia solo; la cadena de desempates provisional acaba en `profileId`, que es único. |
| Índice parcial de partidas en directo (§3.6) | No aplicado: la consulta de F4 (`finishedAt IS NULL` sobre unos pocos miles de filas de las decenas de miles) no lo necesita todavía, y un índice que no está en el schema es una complicación en cada `db push`. |
| *Backfills* de §8.1 que solo aplican a las reglas | Los pasos 3c, 3d y 3e que hypotheticalmente existieran para categorías que hoy no hay. Los que sí aplican (3a y 3b) están hechos. |

**Lo que sí está aplicado y antes esperaba aquí: RLS sin políticas (§7).** Ya no es una fila de
esta tabla: está hecho, versionado en `scripts/db-security.ts` y se comprueba con
`npm run db:security -- --check`. Ver §7 para el detalle y para lo que se comprobó al aplicarlo.

### 0 bis.4 Lo que esto no cambia del diseño

- El aggregate versionado sigue siendo la tabla de lectura de la web, no `Match` (§3.2).
- El puesto se sigue **guardando** en `rank` y no resolviéndose en la consulta (§3.2, punto 1).
- El mapeo de `kind` a ladder sigue estando **en código**, no en el ruleset (§3.1.1, M-02).
- `rawJson` no se toca y las partidas no se borran (P-04).
- `Player.status` sigue siendo el filtro de quién rankea (requisito 11).
- P-02 se respeta: un jugador aprobado **sin ninguna partida clasificatoria resuelta no tiene
  fila** en `PlayerScore` y por tanto no aparece en la clasificación.

### 0 bis.5 Comandos

| Comando | Qué hace |
|---|---|
| `npm run score` | Recalcula la clasificación y la imprime. Es lo que hace el worker al final de cada pasada, pero a mano. |
| `npm run alerts:check` | Evalúa las alertas de comportamiento de todo el torneo (o de los `profileId` que se le pasen) e imprime el resumen y las rachas abiertas. Idempotente. |
| `npm run alerts:cutoffs` | Deriva o refresca los cortes rating → subdivisión que necesita la regla R5 y los cachea en `Setting["alerts.divisionCutoffs"]`. Con `--show` solo enseña los que hay. |
| `npm run db:security` | Aplica la postura de RLS sin políticas y sin permisos para los roles de cliente (§7). Idempotente. Con `-- --solo-rls` aplica la otra postura, la que hace que la Data API conteste `[]`. |
| `npm run db:security -- --check` | Solo comprueba la postura y sale con código 1 si no se cumple. Dice cuál de las dos está activa. **Es la comprobación que hay que hacer después de cada `db push`.** |
| `npm run backfill:model` | Rellena `mode` y `civRandomized` de las partidas que ya había en la base de datos. Idempotente. |
| `npm run verify:sync -- --db` | Comprueba normalización, guardado, motor de puntuación y lecturas públicas contra la base de datos de verdad, con datos de ejemplo que limpia al terminar. |
| `npm test` | Los tests de la lógica pura de `src/lib`, entre ellos los del motor de alertas (F9): `tests/unit/lib/alerts/compute.test.ts` sobre secuencias sintéticas, `rules.test.ts` para umbrales, frases y claves de dedupe, y `division-cutoffs.test.ts` para el rating → subdivisión y la lectura de la caché de cortes. Viven en el árbol espejo `tests/unit/lib/`, que espeja `src/lib`. **Sin base de datos**: todo lo que decide el motor es una función pura, y eso es justo lo que permite comprobarlo sin preparar nada ni dejar nada limpio. |
| `npm run simulate:tournament` | Torneo simulado con **jugadores reales** de AoE4World: elige 1 por división, da de alta, importa la ventana del torneo y recalcula. Escribe su manifiesto en `Setting["simulation.roster"]`. Idempotente. Con `-- --select-only` solo elige e informa, sin tocar la base de datos. |
| `npm run simulate:clean` | Deshace esa simulación. **Verifica la identidad de cada fila contra el manifiesto antes de borrar y aborta si no cuadra**; con `-- --dry-run` comprueba y no borra. Detalle en [`PLAN.md`](./PLAN.md) y en [`docs/OPERACION.md`](./OPERACION.md#torneo-simulado-con-jugadores-reales-api-de-verdad). |

## 1. El modelo actual

### 1.1 `Player`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | Clave primaria interna. Nunca se expone. |
| `profileId` | `Int` | Identificador de AoE4World. **Único**: un jugador es una persona en AoE4World. |
| `name` | `String` | **Nombre de display**: lo escribe quien se inscribió (formulario de inscripción) o el admin. El worker no lo toca nunca. |
| `aoe4WorldName` | `String?` | **Nombre oficial de AoE4World**, en columna aparte para poder publicar los dos. Lo refresca el worker con `GET /players/:profile_id`; `null` = todavía no sincronizado. Nullable y sin valor por defecto a propósito: las filas que ya existían no tienen oficial y no hay que inventárselo con un *backfill*. |
| `twitchChannel` | `String?` | Lo rellena el admin. Lo usa F5, no el motor de puntos. |
| `contactEmail` | `String?` | **Correo de contacto** (F6). Lo exige el formulario público de `/participar` y lo valida `parseEmail` en `src/lib/player-input.ts`, con tope de 254 caracteres (el máximo de RFC 5321) y guardado en minúsculas. **Nullable a propósito:** el alta manual de admin no lo pide y las filas anteriores no lo tienen. El motor no lo lee: no entra en la clasificación ni en ningún desglose. |
| `status` | `PlayerStatus` (`PENDING`/`APPROVED`/`REJECTED`) | Filtro de la clasificación: solo `APPROVED` puntúa (requisito 11). |
| `createdAt`, `updatedAt` | `DateTime` | |

Índices: `id` (pk) y `profileId` (único). **Ninguno más**, y está justificado en §6.

### 1.2 `Match`

Una fila por **jugador y partida**. Dos participantes que se enfrentan generan dos filas con
resultados, civilizaciones y puntos propios.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | `String` (cuid) | |
| `gameId` | `String` | Id de la partida en AoE4World. `String` y no `Int` porque la API lo manda como número pero no garantiza el rango, y no queremos un `Int4` que reviente. |
| `playerId` | `String` | FK a `Player.id`, `onDelete: Cascade`. |
| `opponentProfileId` | `Int?` | Solo el **primer** rival del equipo contrario. Limitación conocida y anotada en `PLAN.md`. |
| `opponentName` | `String?` | |
| `civ`, `opponentCiv` | `String?` | Alimentan las categorías 2 y 4. |
| `map` | `String?` | Alimenta la categoría 3. |
| `leaderboard` | `String` (por defecto `rm_solo`) | Lo que dice la API, o el `kind` si la API no manda `leaderboard`. |
| `result` | `MatchResult?` (`WIN`/`LOSS`) | **`null` = la partida sigue en curso.** El resultado todavía no existe. |
| `startedAt` | `DateTime` | Ancla de la ventana de clasificatorias. |
| `finishedAt` | `DateTime?` | Derivado (`started_at + duration`). **`null` = en curso**, que es lo que F4 lista como partida en directo. |
| `durationSeconds` | `Int?` | Alimenta el filtro de duración mínima. |
| `points` | `Int` (por defecto 0) | **En el diseño completo siempre vale 0.** Ver §3.1.4. Con las reglas activas **sí** vale `ruleset.pointsPerWin` por victoria clasificatoria resuelta: §0 bis.2. |
| `rawJson` | `Json` | La partida tal cual la devolvió la API. **No se borra nunca.** |
| `createdAt` | `DateTime` | |

| Índice | Tipo | Consulta que sostiene |
|---|---|---|
| `(playerId, gameId)` | único | Deduplicación del worker. |
| `(playerId, startedAt)` | compuesto | Partidas de un jugador ordenadas por fecha: ficha de jugador, rango de hitos, agregados. |
| `(playerId, finishedAt)` | compuesto | Partidas en directo de un jugador, y orden por `finishedAt` para los hitos. |

### 1.3 Decisiones heredadas que no se tocan

| Decisión | Por qué | Coste de revertirla |
|---|---|---|
| `leaderboard` es `String`, no enum | La API publica modos nuevos y no queremos una migración por cada uno. | Alto y recurrente: obliga a migrar cada vez que aparece un modo. |
| `rawJson` se guarda entero | Es lo que permite recalcular puntos sin volver a pedir nada a la API (`PUNTUACION` §5.1). | **Irreversible en la práctica**: una partida que la API ya no devuelve no se puede recuperar. |
| `result` y `finishedAt` admiten `null` | `null` significa "en curso" y F4 lo lista como partida en directo. F2 borra la fila cuando la partida se abandona. | Alto: `finishedAt = null` es la señal de "vivo"; si se llena con un centinela, F4 deja de poder filtrar. |
| Unicidad `(playerId, gameId)`, no `gameId` | Dos participantes pueden jugar la misma partida y cada uno necesita su fila. | **Pérdida silenciosa de datos**: con unicidad global, la fila del segundo jugador no se guarda y su resultado desaparece. |
| El worker guarda **todas** las partidas, no solo las clasificatorias | El filtro por modo y por fecha lo hace el motor, y así las partidas en directo salen del mismo histórico. | Medio: obligaría al worker a saber las reglas, y a reescribir el histórico cada vez que cambian. |
| `Setting` como memoria del worker | Ya existe y ya guarda el cursor de sincronización por jugador. Reutilizarlo evita una segunda configuración clave-valor. | Bajo, pero duplicaría la misma idea en dos sitios. |

### 1.4 `Setting`

| Campo | Tipo | Notas |
|---|---|---|
| `key` | `String` | Clave primaria. |
| `value` | `Json` | |
| `updatedAt` | `DateTime` | |

Sin índices adicionales: se lee siempre por clave, que es la primaria.

### 1.5 `RateLimitCounter`

No tiene nada que ver con las reglas de puntuación: es la pieza de datos del límite de frecuencia de los endpoints públicos sin sesión (hoy, la inscripción de `/participar`). Vive en el esquema, y no en `Setting`, por una razón concreta: hace falta **una fila por clave y una escritura por intento**, con un incremento atómico. En `Setting` el valor sería un JSON dentro de una fila compartida, y el "leer, comprobar y escribir" no sería una operación atómica sin un cerrojo; además, meter una fila por IP dentro de un JSON de configuración rompería el diseño clave-valor que ya tiene.

| Campo | Tipo | Notas |
|---|---|---|
| `key` | `String` | Clave primaria. Es `ip:<hmac-sha256>` o el cubo compartido `global`. **Nunca es una IP**: lo que se guarda es el HMAC, con `RATE_LIMIT_SALT` (o `CRON_SECRET`) como clave. |
| `count` | `Int` | Envíos contados en la ventana en curso, este incluido. |
| `windowStart` | `DateTime` | Inicio de la ventana en curso. La ventana es **fija**, no deslizante: cuando caduca, el contador vuelve a 1. |
| `updatedAt` | `DateTime` | |

Índices: solo `key` (la primaria). **Ninguno más**, y es deliberado: la única consulta por rango es la purga periódica de filas caducadas (`RATE_LIMIT_STALE_SECONDS`, una vez por minuto como mucho, desde el propio contador), y con una fila por IP vista un recorrido secuencial de una tabla tan pequeña sale más barato que mantener un índice que casi no se usa. La regla de §6 ("un índice que no aparece en una consulta, no se crea") manda también aquí.

**Atomicidad.** El incremento es un `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count` de **una sola sentencia** (`bumpCounter` en `src/lib/rate-limit.ts`). Es lo que hace que dos envíos simultáneos no se cuelen: el `ON CONFLICT` espera a la transacción que ya tiene esa fila y la reevalúa sobre la versión nueva, así que el segundo ve el incremento del primero. Un `SELECT` seguido de un `UPDATE`, o un contador en memoria del proceso, dejarían pasar el umbral tantas veces como instancias serverless hubiera.

**La ventana se decide en SQL** (`now() - $ventana`), no pasando una fecha desde el código: `DateTime` de Prisma es `timestamp` sin zona y mezclarlo con un `Date` de JavaScript depende de la zona horaria de la sesión.

### 1.6 `ObjectiveEvent`

Un objetivo del torneo que alguien cumplió, con **cuándo** se cumplió. Es una fila
por objetivo del catálogo y como mucho **38 filas en toda la vida del torneo**: la
forma más barata de responder a lo que la organización pidió ("añade también cuando
un objetivo se cumple") sin tocar el modelo de `PlayerScore`.

| Campo | Tipo | Notas |
|---|---|---|
| `objectiveId` | `String` | Id estable del catálogo (`loco-por-ganar`, `masterizar-japanese`…), y a la vez **clave única** de la fila. |
| `playerId` | `String` | FK a `Player.id`, `onDelete: Cascade`, como `Match` y `PlayerScore`. |
| `achievedAt` | `DateTime` | El instante de la hazaña. Ver "Cuándo se registra" abajo: es lo que cambia según el grupo. |
| `recordedAt` | `DateTime` (`now()`) | Cuándo se escribió la fila. `achievedAt` es el dato del torneo; esto es solo el rastro de que el motor (que corre cada 5 minutos) llegó a verlo. |

| Índice | Tipo | Consulta que sostiene |
|---|---|---|
| `(objectiveId)` | **único** | El `upsert` de la reconciliación y, sobre todo, la garantía de que un objetivo solo tiene un evento: es lo que hace que el registro se pueda reescribir cuando el cómputo cambia. |
| `(achievedAt)` | compuesto | El feed del historial, que ordena y filtra por ahí. |
| `(playerId)` | compuesto | Índice de la FK: el panel filtra los hitos por jugador y el `Cascade` al borrar un participante los recorre. Postgres **no** indexa las FK por su cuenta. |

**Cuándo se registra (la traducción de `PUNTUACION.md` §6).** `§6` divide los
objetivos en dos: los que se resuelven en caliente en cada recálculo y el grupo
`civilizacion`, que son **carreras** y se resuelven al completarse. El registro
hereda esa división:

- **Carreras** (los 23 `masterizar-<civ>` y `masterizarlos-a-todos`): en cuanto hay
  poseedor, con `achievedAt` = el `finishedAt` de la partida que cerró la carrera. El
  motor ya lo tenía: es el mismo `raceAt` con el que `pickHolder()` decide quién se la
  quedó, o sea el desempate 3 de §5.
- **Los 14 "en caliente"**: solo cuando la ventana del torneo tiene `to` informado
  **y** ya ha pasado, con `achievedAt` = ese `window.to`. Con la ventana abierta
  (`to: null`) no se registra nada todavía.

Un objetivo **sin poseedor** no tiene evento, y si lo tenía, se borra. Es el otro
caso de §6, y es real: si el panel revierte la partida que cerró una carrera, los
puntos se mueven y el evento del poseedor anterior tendría que irse con ellos.

**No guarda etiqueta ni puntos.** Los dos se resuelven **al leer**, contra
`OBJECTIVE_DEFINITIONS` y el ruleset activo, con el criterio de `public.ts`
(`ruleset.objectives[id] ?? definition.points`) y en un solo sitio
(`resolveObjective()` en `src/lib/objective-events.ts`). Una copia en la tabla sería
una segunda fuente de verdad que se queda vieja en cuanto se retoque un punto en
`Setting`, y el historial enseñaría una cifra que ya no es la del torneo.

**Espejo, no log.** Es la diferencia con `AdminAction` y con `Alert`, que sí son
append-only: aquí la fila describe **quién posee el objetivo ahora mismo**, y eso no
puede haber pasado. La escribe `reconcileObjectiveEvents()` dentro de la transacción
de `recomputeScores()`, con el cerrojo de la clasificación ya tomado, así que o el
registro y la clasificación dicen lo mismo o no cambia ninguno de los dos, y todos los
caminos que recalculan (worker, `npm run score`, revertir o restaurar puntos, aprobar
o dar de alta a un jugador) lo dejan al día. La reconciliación lee las ≤38 filas,
compara con lo esperado y **solo escribe lo que difiere**: altas (`createMany`),
cambios de poseedor o de instante (`update`) y bajas (`deleteMany`). En una pasada sin
novedades no hay ni una escritura.

**Relleno de verdad, medido.** Con la base de datos de este torneo y la ventana de
pruebas (15-sep-2026 → 15-oct-2026, sin terminar) el motor registró 4 eventos, los
cuatro `masterizar-*` cerrados entre el 16 y el 25 de septiembre, con `achievedAt` en
el `finishedAt` de la partida que los cerró. Los otros 13 objetivos con poseedor no
tienen evento, que es lo correcto: el torneo aún no había terminado.

### 1.7 `Alert`

Un comportamiento anómalo de un participante, detectado sobre las partidas
clasificatorias que ya están guardadas. Es un registro **append-only**, como
`AdminAction` y a diferencia de `ObjectiveEvent`: la fila dice "a la 1 se detectó
esto" y no se reescribe nunca. La corrección de una alerta que salió mal no es
borrarla, es que la condición que la produjo deje de cumplirse (una partida
revertida, una ventana movida, un umbral retocado) y el informe dé cuenta del estado
en cada momento.

| Campo | Tipo | Notas |
|---|---|---|
| `rule` | `AlertRule` | Qué comportamiento se detectó. Enum **fijo en el código**: lo configurable son los umbrales (`Setting["alerts.ruleset"]`), no la lista de comportamientos. |
| `kind` | `AlertKind` | `STREAK_CLOSED`, `STREAK_AT_TOURNAMENT_END` o `TOTAL_REACHED`. Ver "Por qué tres" abajo. |
| `playerId` | `String` | FK a `Player.id`, `onDelete: Cascade`, como `Match` y `PlayerScore`. |
| `subjectProfileId` | `Int?` | El rival (R2) o el compañero (R3) de la que habla la alerta. Es un `profileId` de AoE4World y **no** una FK a `Player`, porque el torneo es individual y casi todos los rivales y compañeros son de fuera de la liga. `null` en las reglas sin sujeto. |
| `subjectName` | `String?` | Nombre del sujeto **en el momento de escribir la fila**. Es el único registro que queda de a quién señalaba, y no se puede resolver con un `join`: el sujeto puede no estar en `Player`. |
| `count` | `Int` | Partidas del tramo, o el número que se ha cruzado en un acumulado. En un total es siempre el múltiplo o el umbral, así que `count == threshold`. |
| `threshold` | `Int` | Umbral del ruleset activo, guardado para que el informe pueda decir con qué criterio se avisó aunque las reglas cambien después. |
| `anchorGameId` | `String?` | La partida que **rompió** la racha o cruzó el umbral; en el cierre de torneo, la última de la racha, que es la única que se puede señalar porque no hubo ninguna que la rompiera. |
| `dedupeKey` | `String` **único** | Ver abajo. |
| `summary` | `String` | Una línea en español **ya redactada** al escribir la fila (`src/lib/alerts/rules.ts`), que el informe pinta tal cual. |
| `details` | `Json` | Lo que hay detrás de la frase, para el que tenga que investigar. De ahí no se lee nada para pintar el resumen. |

| Índice | Tipo | Consulta que sostiene |
|---|---|---|
| `(dedupeKey)` | **único** | El `createMany({ skipDuplicates: true })` del motor. Ver abajo. |
| `(createdAt)` | compuesto | El listado del panel, que es "lo más reciente primero". |
| `(playerId, rule)` | compuesto | El detalle de un jugador y el recuento por regla, sin perder ese orden. |

**Por qué `dedupeKey` es una columna de texto y no un índice único compuesto.** El
motor es idempotente y corre muchas veces sobre los mismos datos (cada pasada del
sincronizador, el cierre de torneo, `alerts:check`), así que tiene que poder insertar
"solo lo nuevo" **sin leer antes lo que ya hay**: eso es un `createMany` con
`skipDuplicates` sobre un único índice único. Y en Postgres los `NULL` de un índice
único **no colisionan** (dos filas con `subjectProfileId = NULL` pasarían ambas), y
el sujeto es opcional. Un índice único compuesto con columnas nullable no sujetaría
lo que parece sujetar, así que la clave es texto no nulo y se compone en código.
Lo que identifica una alerta es (regla, tipo, jugador, sujeto, y el remate: la
partida que rompió la racha o el número que se cruzó); por eso el `kind` entra en la
clave, para que una racha rota y una racha que solo cerró el fin del torneo no
colisionen.

**Por qué tres `kind` y no dos.** Una racha normalmente se avisa cuando se rompe,
porque es cuando se sabe cuánto duró. Pero si el torneo se cierra con la racha
abierta, el patrón ya no se va a romper nunca, y sin `STREAK_AT_TOURNAMENT_END` esa
racha no se avisaría jamás. Los acumulados no son rachas: no tienen ni principio ni
fin, y por eso tienen su propio `kind`.

**`summary` no lleva el nombre del jugador.** La fila ya es de un jugador y el
informe hace el `join` con `Player`, así que guardarlo ahí solo serviría para que un
nombre renombrado dejara de ser cierto en el informe. El del **sujeto** sí se
guarda, porque ese no sale de ningún `join` (puede no estar en la liga).

**Cuántas filas sale.** Con los datos de este torneo y la ventana de pruebas,
`npm run alerts:check` registró 25 alertas de 8 jugadores (casi todas
`REPEATED_TEAMMATE_*`: `I'm the washing machine` juega con los mismos compañeros
muchas veces seguidas), 3 rachas abiertas y 0 `rawJson` ilegibles. Repetir el
comando insertó **0** filas: esa es la comprobación de que el dedupe funciona.

**Lo que degrada en vez de romper.** Un `rawJson` ilegible no lanza: esa partida no
aporta flags a las reglas de equipo y sale en el resumen. Un jugador sin
`rankLevel` 1v1 no se evalúa con R5, con aviso. Y **R5 entera se omite** si no hay
cortes de división cacheados (`Setting["alerts.divisionCutoffs"]`, que se derivan a
mano con `npm run alerts:cutoffs` y no desde el motor: son ~150 peticiones por
ladder y el sincronizador corre cada 5 minutos). El detalle de por qué R5 necesita
cortes de la ladder **de la partida** está en `docs/PLAN.md` F9.

## 2. Resumen de lo que hay que añadir

| # | Pieza | Tipo de cambio | Requisito de `PUNTUACION.md` §9 |
|---|---|---|---|
| 1 | `Match.mode` | Columna nueva | 1 (modo canónico consultable) |
| 2 | `Match.civRandomized` | Columna nueva | 1 (y D-04) |
| 3 | `Match`: índice `(mode, startedAt)` | Índice nuevo | 7 |
| 4 | `PlayerScore` | **Tabla nueva** | 2 y 3 (agregado versionado y desglose) |
| 5 | `ScoreSnapshot` | **Tabla nueva** | 5 y 6 (auditoría de cada cálculo) |
| 6 | Reglas y memoria del motor en `Setting` | Filas nuevas (`scoring.ruleset` y `scoring.lastRun`, hechas) | 4 |
| 7 | Índice parcial de partidas en directo | **SQL a mano** | 7 (corregido, ver §3.6) |
| 8 | RLS sin políticas | **SQL a mano** (hecho, §7) | 10 |
| — | `Player` | Una columna (`contactEmail`, F6; §3.5) | 11 (ya resuelto con `status`) |
| — | `Match.points` | Sin cambios de schema; la columna ya tomaba valor | 8 |

Dos tablas y dos columnas. Nada se borra ni se renombra.

## 3. El modelo completo, pieza a pieza

### 3.1 `Match`: dos columnas nuevas

#### 3.1.1 `mode` (requisito 1)

| | |
|---|---|
| Qué es | La **familia de ladder** de la partida: `rm_solo`, `rm_team`, `qm_1v1`… |
| Para qué | El filtro de modos es la condición más frecuente del motor, y hoy no se puede filtrar en SQL. |
| Tipo | `String?` |
| Por qué `String` y no enum | Misma razón que `leaderboard`: la API publica familias nuevas y no queremos migrar por cada una. Además, la lista de qué familias cuentan es **dato del ruleset**, no del esquema. |
| Por qué nullable | Las filas que ya existen no lo tienen. Se rellena con un *backfill* (§8) y, si algún día se quiere, se pasa a `NOT NULL`. |

El problema que resuelve, con precisión: hoy la columna `leaderboard` guarda
`game.leaderboard ?? game.kind` (ver `normalize.ts`). Para un ranked 2v2 eso significa que puede
guardar `rm_team` **o** `rm_2v2`, según lo que mande la API. Un ruleset que liste `rm_team` no
encontraría las filas guardadas como `rm_2v2`, y el filtro de la clasificación se quedaría corto
sin avisar.

La solución es una correspondencia mecánica, **fija y en código**, no una lista de modos del torneo:

| Valor guardado | `mode` resuelto | Comentario |
|---|---|---|
| `rm_1v1` | `rm_solo` | |
| `rm_2v2`, `rm_3v3`, `rm_4v4` | `rm_team` | La ladder de equipos cubre los tres tamaños. |
| Cualquier otro valor | Él mismo | `qm_1v1`, `ew_*`, `ffa_*`… pasan tal cual. |
| Sin valor reconocible | `null` | No cuenta, y el ruleset lo descarta igualmente. |

La frontera queda así, y es importante que quede clara:

- **El código sabe cómo llama la API a las cosas** (que `rm_2v2` cuelga de `rm_team`).
- **El ruleset decide qué cuenta** (que en este torneo puntúa `rm_solo`, `rm_team` y `qm_*`).

Con esa separación, si el cliente mañana añade `ew_1v1` a la lista del ruleset, **las filas ya
guardadas empiezan a contar sin volver a escribir nada**. Ese es el motivo de que la
correspondencia sea mecánica y no "si el valor está en la lista del ruleset".

#### 3.1.2 `civRandomized` (requisito 1, y D-04)

| | |
|---|---|
| Qué es | `true` si la API marcó que la civilización de **este** jugador fue aleatoria. |
| Para qué | Que una victoria con civ aleatoria no cuente para la categoría 2 ni para la 4 (D-04). |
| Tipo | `Boolean`, por defecto `false`. |
| De dónde sale | `rawJson.teams[].civilization_randomized` del jugador con nuestro `profileId`. |

Por qué una columna si el dato ya está en `rawJson`: porque el motor tiene que contar
civilizaciones distintas **en SQL** (`count(distinct civ)`), y filtrar por un campo de `jsonb`
dentro de un array de arrays de objetos no es indexable. Con la columna, el backfill y los
agregados son un `group by` normal. El coste es una columna booleana (1 byte por fila) y un
backfill que hay que hacer bien (§8).

Riesgo conocido y por eso lo digo: el valor por defecto es `false`, así que **una fila antigua
sin backfill cuenta como "no aleatoria"**, y si el backfill se hace mal, las categorías 2 y 4
salen mal. No es un riesgo teórico, es el motivo de que el paso 3b de §8 sea una comprobación
explícita y no un detalle.

#### 3.1.3 Índice `(mode, startedAt)`

| | |
|---|---|
| Consulta que lo sostiene | "Todas las partidas clasificatorias de todos los jugadores aprobados dentro de la ventana": `where mode = any(...) and startedAt >= from and startedAt < to and result is not null and finishedAt is not null and durationSeconds >= min`. |
| Por qué en ese orden | `mode` es igualdad, `startedAt` es rango. El índice compuesto pone la igualdad primero y el rango último, que es el orden que aprovecha un índice en Postgres. |
| Por qué en Prisma y no a mano | Prisma sí sabe expresar este. Ver §3.6 para el índice que sí necesita SQL. |

#### 3.1.4 `points` se queda (requisito 8)

> **Lo que sigue describe el diseño completo.** Con las reglas activas esta columna **sí** se
> usa: vale `ruleset.pointsPerWin` en cada victoria clasificatoria resuelta. Ver §0 bis.2. El
> resto del razonamiento de aquí sigue en pie, y es justamente por eso por lo que la columna
> existía.

`Match.points` **no se borra y no se usa**. En la v1 las cinco categorías son agregadas o por
puesto: ninguna reparte puntos sobre una partida concreta, así que la columna vale 0 en todas
las filas y se queda así.

Razones para no borrarla: el worker de F2 la escribe en el alta y la respeta en la actualización
(`sync.ts`), así que borrarla obliga a tocar código de F2 para ganar una columna vacía. Y el día
que entre la regla "puntos por partida" de `PUNTUACION` §8, la columna es justo donde tienen que
caer esos puntos. Lo que esa regla necesitará entonces, y que hoy no existe, es una columna
`pointsRuleSetVersion` para poder recalcular: **no se añade ahora** (sería una columna muerta)
y queda anotado en §5 para cuando haga falta.

### 3.2 `PlayerScore`: el agregado versionado (requisitos 2 y 3)

Una fila por **jugador y versión de reglas**. Es la tabla de la que lee la web, y la única que
contiene puntos.

| Campo | Tipo | Qué guarda | De dónde sale |
|---|---|---|---|
| `playerId` | `String` | FK a `Player.id`, cascada | |
| `ruleSetVersion` | `Int` | Con qué versión de las reglas se calculó esta fila | `Setting` (ruleset activo) |
| `rank` | `Int` | Puesto en la clasificación final, **ya con la cadena de desempates aplicada** | El motor |
| `total` | `Int` | Puntos de las cinco categorías | El motor |
| `wins` | `Int` | Victorias clasificatorias | `Match` |
| `matches` | `Int` | Partidas clasificatorias resueltas (victorias y derrotas) | `Match` |
| `civsWonCount` | `Int` | Civilizaciones distintas ganadas | `Match.civ` |
| `mapsWonCount` | `Int` | Mapas distintos ganados | `Match.map` |
| `crownsCount` | `Int` | Civilizaciones de las que es rey | derivado |
| `milestonesReached` | `Int` | Cuántos escalones de victorias ha alcanzado | derivado |
| `ratingUsed` | `Int?` | El rating de `rm_solo` que se usó en el desempate de esta fila | `GET /leaderboards/rm_solo` |
| `breakdown` | `Json` | El desglose por categoría, con la lista de civs, mapas, coronas e hitos | El motor |
| `computedAt` | `DateTime` | Cuándo se calculó esta fila | El motor |

| Índice | Tipo | Consulta que sostiene |
|---|---|---|
| `(playerId, ruleSetVersion)` | **pk compuesta** | Lectura de la ficha de un jugador. De paso indexa la FK a `Player` (columna más a la izquierda), que es lo que evita un escaneo en el `Cascade` al borrar un jugador. |
| `(ruleSetVersion, rank)` | compuesto | **La consulta más caliente del sitio**: la clasificación, `where ruleSetVersion = V order by rank asc`. Igualdad y rango ordenados, sin `sort`. |

Tres decisiones de diseño detrás de esta tabla, que son las que conviene que el cliente
entienda porque son las que hacen el resto del modelo necesario:

**1. El puesto se guarda, no se calcula en la consulta.** La cadena de desempates de
`PUNTUACION` §4.1 acaba en el rating, que no está en la base de datos (viene de la API y cambia
solo). Por lo tanto **el orden no se puede resolver en SQL**: hay que calcularlo en el motor y
guardarlo. Por eso existe `rank` y por eso el índice de la clasificación es por `rank` y no por
`total` (esto corrige lo que decía `PUNTUACION` §9.2, que proponía `(ruleSetVersion, total desc)`:
con `total` solo, dos jugadores empatados quedarían en orden arbitrario y habría que resolverlo
en la capa de aplicación).

**2. El desglose es JSON, no columnas.** Las categorías cambian con cada versión de las reglas
(un ruleset con seis categorías no cabe en columnas sin migrar). El desglose vive **dentro de la
fila versionada**, así que conviven dos versiones sin molestar. A cambio se pierde la
posibilidad de consultar en SQL "quién ha ganado con los French"; queda anotado en §5.

**3. El recuento y la lista van los dos.** `civsWonCount` es la cifra que se muestra y se
ordena; `breakdown.civs` es la evidencia de qué civilizaciones son. Es duplicación, pero la
escribe siempre el mismo motor en la misma operación, así que no puede desincronizarse, y evita
parsear JSON para pintar un "3 coronas".

### 3.3 `ScoreSnapshot`: el rastro (requisitos 5 y 6)

Una fila por **cálculo completo**, con su resultado y su delta. No es una tabla de lectura
caliente: la web nunca la lee.

| Campo | Tipo | Qué guarda |
|---|---|---|
| `id` | `String` (cuid) | |
| `ruleSetVersion` | `Int` | Con qué versión se calculó |
| `asOf` | `DateTime` | Momento del corte |
| `watermark` | `DateTime?` | `max(finishedAt)` de las partidas incluidas. Dice hasta dónde llegan los datos. |
| `reason` | `SnapshotReason` | Por qué se calculó: ver abajo |
| `rows` | `Json` | La clasificación de esa versión, con nombre, puesto, total y desglose |
| `delta` | `Json?` | Qué cambió respecto al cálculo anterior, por jugador y por regla |

`reason` (enum):

| Valor | Cuándo |
|---|---|
| `RULESET_PUBLISH` | Se ha publicado una versión nueva de las reglas y se ha recalculado. |
| `MANUAL_RECALC` | Un admin ha pedido un recálculo. |
| `WINDOW_CHANGE` | Se ha cambiado la ventana de fechas o la lista de modos. |
| `SEASON_CLOSE` | Cierre de la temporada. |

Índices: único `(ruleSetVersion, asOf)` (evita dos snapshots del mismo corte) y
`(asOf desc)` para el historial del panel.

**Aviso importante sobre la frecuencia.** `PUNTUACION` §6 sugiere hacer un snapshot al final de
cada pasada del worker. Eso está mal y hay que corregirlo aquí: el worker corre cada 5 minutos,
son 288 pasadas al día, y con ~60 jugadores el `rows` de cada una ronda los 50 KB. Son **10 MB al
día**, casi 4 GB al año, para guardar 287 veces lo mismo. La regla correcta es:

> **El snapshot se escribe por evento, no por pasada.** Cada publicación de versión, cada
> recálculo manual y cada cierre de temporada. El estado de la última pasada se guarda
> **sobrescribiendo una fila de `Setting`** (`scoring.lastRun`), que es una sola fila y no crece.

Los datos de la tabla se conservan todos. Con unos cuantos snapshots por temporada, la tabla
pesa menos de 1 MB.

**Por qué tabla y no filas de `Setting`.** `PUNTUACION` §9.5 decía "un JSON por snapshot", y
la forma es correcta; lo que cambia es dónde vive. En `Setting` habría que inventar una clave
por snapshot (`scoring.snapshot.v3.2026-10-14T1830Z`), y para listar el historial habría que
hacer `LIKE 'scoring.snapshot%'` y ordenar el texto de la clave. Una tabla con dos columnas
resuelve eso con un índice y sin formato de clave que mantener. El rastro de las pasadas del
worker (requisito 6) **sí** se queda en `Setting`, porque es memoria de trabajo que se
sobrescribe, no un histórico.

### 3.4 `Setting`: las claves nuevas

Sin tabla nueva. Se reutiliza la que F2 ya usa.

| Clave | Contenido | Quién la escribe | Quién la lee |
|---|---|---|---|
| `scoring.ruleset` | El documento de reglas activo, con la versión fijada por el código. Es el equivalente ya simplificado de `scoring.ruleset.active` + `scoring.ruleset.v{N}`: con una sola versión no hace falta el puntero ni el formato de clave por versión. | `ensureRuleset()` en `src/lib/scoring.ts` | El motor, en cada pasada |
| `scoring.lastRun` | Resultado de la última pasada: versión, duración, jugadores clasificados y retirados, puntos totales, objetivos con poseedor y puntos de objetivos, y partidas con puntos actualizados. **Sin `snapshotId`, porque `ScoreSnapshot` sigue diferido.** | `recomputeScores()`, dentro de su transacción | Panel de admin (todavía no lo pinta nadie) |
| `aoe4world.sync.player.{profileId}` | Ya existe desde F2 (cursor) | Worker | Worker |

Decisiones detrás de este reparto:

- **El ruleset son filas de `Setting`, no una tabla** (`PUNTUACION` §9.4). Una tabla por regla
  invitaría a editar media regla y necesitaría su propio versionado. Un documento se edita entero
  o no se edita.
- **La versión activa es un puntero, no una copia.** `scoring.ruleset.active` guarda el número de
  versión y la lista de versiones publicadas, y el documento se lee de `scoring.ruleset.v{N}`.
  Así el puntero no puede desincronizarse del documento: hay una sola copia de cada versión.
- **La lista de versiones viaja en el puntero** para que el panel no tenga que hacer `LIKE` sobre
  las claves. Es el único punto donde hay dos fuentes de verdad (el puntero y las claves), y
  ambos los escribe la misma acción de admin, en la misma transacción.
- **`publishedBy` no necesita columna**: cabe dentro del documento JSON de la versión, así que
  el schema no tiene que registrar quién publicó cada versión.

Coste conocido de no tener tabla de rulesets: **`ruleSetVersion` no tiene integridad referencial**.
Nada impide escribir una fila de `PlayerScore` con una versión que no existe en `Setting`. Se
cubre validando en la escritura (el motor no publica una versión sin guardar antes su documento,
y no calcula contra una versión que no esté en el puntero), y es un riesgo que solo puede cometer
el propio código, no un usuario.

### 3.5 `Player`: una columna que no es de las reglas

Requisito 11 cubierto por `status`. Los jugadores `PENDING` y `REJECTED` no entran ni en la
clasificación ni en el reparto de premios.

Desde F6 hay **una** columna nueva, y no la pidió ninguna regla: `contactEmail`. Es el correo de
contacto que el formulario público de `/participar` exige para que la organización pueda responder
dudas, y por eso se distingue de todo lo demás:

- **Es nullable y sin valor por defecto.** El alta manual de admin no lo pide, y las filas que ya
  existían no lo tienen. Hacerlo obligatorio obligaría a un *backfill* inventado sobre datos que
  nadie tiene, que es justo lo que este diseño evita en todas partes.
- **No lleva índice.** No se filtra por correo en ninguna consulta: se escribe una vez (al
  inscribirse o al reinscribirse) y se lee en el panel. La regla de §6 manda: un índice que no
  aparece en una consulta no se crea.
- **No la lee el motor.** No aparece en ningún desglose, ni en `breakdown` ni en la
  clasificación. Es dato de contacto, no de juego, así que no se mezcla con la regla de puntos.

Lo que se ha considerado y **no** se añade:

| Candidato | Por qué no |
|---|---|
| `country` (la API lo devuelve) | Ninguna regla de la v1 lo usa. Es un dato de presentación, y se puede pedir cuando F4 lo necesite. |
| `seasonId` o `tournamentId` | La ventana de fechas del ruleset ya separa temporadas. Una columna más que mantener y que rellenar sería redundante. Ver P-01. |
| Índice en `status` | La consulta es "jugadores aprobados" sobre una tabla de decenas o pocos cientos de filas, y se ordena por `profileId` (que sí está indexado por ser único). Un índice aquí no se va a usar. |
| Índice único en `contactEmail` | El correo no es una identidad: se puede compartir en una casa o en un club, y en Postgres los `null` de un índice único no chocan entre sí, así que el índice no sujetaría lo que parece sujetar. Además no hay ninguna consulta que lo necesite (§6). |

### 3.6 Índices que Prisma no sabe expresar

**Corrección de `PUNTUACION` §9.7.** Allí se propuso un índice parcial sobre las partidas
**resueltas** (`where result is not null and finishedAt is not null`). Es un error: ese predicado
excluye un puñado de filas (las que están en curso) de un total de decenas de miles, así que el
índice parcial sería casi tan grande como uno completo, y a cambio obligaría a mantenerlo con SQL
a mano. No compensa.

Donde un índice parcial **sí** compensa es en la consulta de partidas en directo: ahí el predicato
`finishedAt is null` es selectivo de verdad, porque en cualquier momento hay unas pocas partidas vivas
entre decenas de miles de terminadas).

```sql
-- ÍNDICE PARCIAL: Prisma no lo expresa. Crear DESPUÉS del `db push`, nunca antes.
-- Envoltido en un bloque DO para que se pueda reponer a mano.
do $$
begin
  if not exists (
    select 1 from pg_class where relname = 'match_live_idx'
  ) then
    create index match_live_idx on "Match" ("startedAt")
    where "finishedAt" is null;
  end if;
end $$;
```

Soporta la consulta de F4: `where finishedAt is null and Player.status = 'APPROVED' order by
startedAt desc`. Con el predicado en el índice, `finishedAt` no necesita estar en la clave.

**El aviso importante:** `prisma db push` calcula la diferencia entre el schema y la base de
datos. Un índice que no está en el schema no le es familiar: puede avisar y pedir confirmación, o
proponerlo como pérdida de datos. Por eso el bloque va con `DO` (se puede reponer) y hay que
**comprobarlo después de cada `db push`**. La comprobación:

```sql
select indexname from pg_indexes where tablename = 'Match' order by indexname;
```

Alternativa si se quiere evitar SQL a mano: declarar en Prisma `@@index([finishedAt, startedAt])`.
Funciona (el `finishedAt` delante permite filtrar por `IS NULL`) pero indexa las 30.000 filas en
vez de unas pocas. Es la opción M-04 de §9.

## 4. Borrador de `prisma/schema.prisma`

> **Este bloque ya no es la referencia del schema: lo es `prisma/schema.prisma`.** Se conserva
> intacto como **registro histórico del diseño completo**, y para ver los comentarios del
> porqué que Prisma no admite. Difiere del schema real en los puntos que enumera
> "Adaptación al MVP" (§0 bis): sin `SnapshotReason`, sin `ScoreSnapshot`, sin las columnas de
> categoría en `PlayerScore` (`civsWonCount`, `mapsWonCount`, `crownsCount`,
> `milestonesReached`, `ratingUsed`), y con `Match.points` tomando valor real en vez de
> quedarse a 0. Cuando se aplique el resto, el bloque y el schema convergerán.

Propuesta completa, tal como estaba el día que se escribió. Los comentarios explican el porqué
de lo que no es obvio, que es la regla del repositorio.

```prisma
// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema

generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

enum PlayerStatus {
  PENDING
  APPROVED
  REJECTED
}

enum MatchResult {
  WIN
  LOSS
}

/// Por qué se calcula: se escribe al publicar una versión de las reglas o al
/// recalcular, nunca en cada pasada del worker (que correría 288 veces al día).
enum SnapshotReason {
  RULESET_PUBLISH
  MANUAL_RECALC
  WINDOW_CHANGE
  SEASON_CLOSE
}

model Player {
  id            String        @id @default(cuid())
  profileId     Int           @unique
  name          String
  twitchChannel String?
  status        PlayerStatus  @default(PENDING)
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  matches       Match[]
  scores        PlayerScore[]
}

model Match {
  id                String      @id @default(cuid())
  gameId            String
  playerId          String
  player            Player      @relation(fields: [playerId], references: [id], onDelete: Cascade)
  opponentProfileId Int?
  opponentName      String?
  civ               String?
  opponentCiv       String?
  map               String?
  // Lo que dice la API, o el `kind` si la API no manda `leaderboard`. No se toca:
  // es el registro de lo que la API publicó.
  leaderboard       String      @default("rm_solo")
  // Familia de ladder resuelta (`rm_2v2` -> `rm_team`). Es lo que permite filtrar
  // por modo en SQL; la lista de qué familias puntúan la da el ruleset, no el código.
  mode              String?
  // La API marca si la civilización de este jugador fue aleatoria. Sin esto, la
  // categoría 2 premiaría jugar civilizaciones que no se dominan.
  civRandomized     Boolean     @default(false)
  // Null mientras la partida sigue en curso: el resultado todavía no existe.
  // El motor de F3 solo debe puntuar partidas con `result` y `finishedAt`.
  result            MatchResult?
  startedAt         DateTime
  finishedAt        DateTime?
  durationSeconds   Int?
  // Siempre 0 en la v1: ninguna regla reparte puntos por partida. No se borra
  // porque el worker de F2 la escribe y la futura regla por partida la necesita.
  points            Int         @default(0)
  rawJson           Json
  createdAt         DateTime    @default(now())

  // La unicidad es por jugador, no global: en un torneo individual dos
  // participantes pueden jugar la misma partida y cada uno necesita su fila
  // (resultado, civ y puntos propios). Un único `gameId` global descartaría la
  // mitad de los datos de esos cruces.
  @@unique([playerId, gameId])
  @@index([playerId, startedAt])
  // Sostiene la consulta de "partidas en directo" de F4 (`finishedAt IS NULL`).
  @@index([playerId, finishedAt])
  // Sostiene el filtro de partidas clasificatorias por ventana: `mode` es
  // igualdad y `startedAt` es rango, y ese es el orden que aprovecha el índice.
  @@index([mode, startedAt])
}

/// Puntuación de un jugador con una versión concreta de las reglas.
///
/// Las dos versiones de una regla conviven aquí sin molestar: es lo que permite
/// publicar una versión nueva y recalcular al lado de la anterior, y comparar.
model PlayerScore {
  playerId       String
  ruleSetVersion Int
  player         Player   @relation(fields: [playerId], references: [id], onDelete: Cascade)

  /// Puesto final con la cadena de desempates ya aplicada. Se guarda porque el
  /// desempate acaba en el rating, que no está en la base de datos: el orden
  /// final no se puede resolver en SQL.
  rank           Int
  total          Int      @default(0)
  wins           Int      @default(0)
  matches        Int      @default(0)
  civsWonCount   Int      @default(0)
  mapsWonCount   Int      @default(0)
  crownsCount    Int      @default(0)
  milestonesReached Int   @default(0)

  /// Rating de `rm_solo` usado en esta fila. Se guarda para que el recálculo sea
  /// reproducible: si el rating de la API cambia, el snapshot sigue siendo fiel.
  ratingUsed     Int?

  /// Desglose por categoría, con la lista de civilizaciones, mapas, coronas e
  /// hitos. Es JSON y no columnas porque el número de categorías cambia con cada
  /// versión de las reglas, y migrar columnas en cada versión no es una opción.
  breakdown      Json
  computedAt     DateTime @default(now())

  // Clave compuesta: una fila por jugador y versión. Indexa también la FK a
  // Player (columna más a la izquierda), que es lo que hace barato el borrado
  // en cascada cuando se elimina un jugador.
  @@id([playerId, ruleSetVersion])
  // La consulta más caliente del sitio: clasificación por puesto, sin `sort`.
  @@index([ruleSetVersion, rank])
}

/// Resultado de un cálculo completo, con su delta respecto al anterior.
///
/// No es una tabla de lectura caliente: la web lee `PlayerScore`. Esto es el
/// rastro que responde a "por qué el martes esto tenía 87 puntos".
model ScoreSnapshot {
  id             String         @id @default(cuid())
  ruleSetVersion Int
  asOf           DateTime
  /// `max(finishedAt)` de las partidas incluidas: dice hasta dónde llegan los datos.
  watermark      DateTime?
  reason         SnapshotReason
  /// La clasificación tal como quedó, con nombre, puesto, total y desglose.
  rows           Json
  /// Qué cambió respecto al cálculo anterior, por jugador y por regla.
  delta          Json?

  @@unique([ruleSetVersion, asOf])
  @@index([asOf(sort: Desc)])
}

model Setting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt
}
```

Lo que **no** aparece en ese bloque y hay que hacer aparte: el índice parcial de §3.6, los
`alter table ... enable row level security` de §7 (que no están en `prisma/schema.prisma` porque
Prisma no los modela, sino en `scripts/db-security.ts`) y los *backfills* de §8.

## 5. Mapa regla → dato

Una fila por pieza de `PUNTUACION.md`. La columna "dato" es la que hay que mirar para saber si
el modelo aguanta.

| Pieza de las reglas | Dato que la alimenta | Dónde vive | ¿Falta algo? |
|---|---|---|---|
| **Categoría 1** (victorias) | `Match.result = WIN` con los filtros de clasificatoria | `Match` → `PlayerScore.wins` | — |
| **Categoría 2** (civilizaciones) | `count(distinct Match.civ)` de las ganadas, excluyendo aleatorias | `Match.civ`, `Match.civRandomized` → `PlayerScore.civsWonCount` y `breakdown.civs` | — |
| **Categoría 3** (mapas) | `count(distinct Match.map)` de las ganadas, excluyendo nulo y `Unknown Map` | `Match.map` → `mapsWonCount` y `breakdown.maps` | Confirmar el literal exacto del mapa desconocido (comprobación 0.4 de §8.0) |
| **Categoría 4** (coronas) | Agrupar victorias por civ, quedarse con el máximo de cada civ, con el mínimo de 10 | Derivado de `Match.civ` → `crownsCount` y `breakdown.crowns` | — |
| **Categoría 5** (hitos) | `PlayerScore.wins` contra los escalones, y la fecha de la `n`-ésima victoria | `Match.finishedAt` + `PlayerScore.milestonesReached` | — |
| **Ventana de fechas** | Ruleset `window.from` / `window.to` contra `Match.startedAt` | `Setting` + `Match.startedAt` | **Aplicada** (D-02 con fechas de trabajo; §0 bis.2). Sin columnas nuevas. |
| **Filtro de modo** | Ruleset `modes.include` / `modes.exclude` contra `Match.mode` | `Setting` + `Match.mode` | — |
| **Filtro de resultado resuelto** | `Match.result is not null and finishedAt is not null` | `Match` | — |
| **Filtro de duración** | Ruleset `minDurationSeconds` contra `Match.durationSeconds` | `Setting` + `Match.durationSeconds` | — |
| **Filtro de civ aleatoria** | Ruleset `countRandomizedCivs` contra `Match.civRandomized` | `Setting` + `Match.civRandomized` | — |
| **Desempate 1** (métrica de la categoría) | `PlayerScore` según la categoría | `PlayerScore` | — |
| **Desempate 2** (victorias) | `PlayerScore.wins` | `PlayerScore` | — |
| **Desempate 3** (ratio) | `wins / matches` | `PlayerScore.wins`, `PlayerScore.matches` | — |
| **Desempate 4** (rating `rm_solo`) | `GET /leaderboards/rm_solo?profile_id=...` | `PlayerScore.ratingUsed` | — |
| **Desempate 5** (`profileId`) | `Player.profileId` | `Player` | — |
| **Reparto por puesto (mecanismo N..1)** | `rank` dentro de cada categoría | Solo en el motor; sale en `breakdown` | — |
| **Puesto final** | Cadena de desempates aplicada | `PlayerScore.rank` | — |
| **Total** | Suma de las cinco categorías | `PlayerScore.total` | — |
| **Desglose para la interfaz** | Por categoría, con la lista de civs, mapas, coronas e hitos | `PlayerScore.breakdown` | — |
| **Versionado** | Ruleset con número de versión, archivado | `Setting` + `ruleSetVersion` en `PlayerScore` y `ScoreSnapshot` | — |
| **Rastro de un recálculo** | Resultado y delta | `ScoreSnapshot` (+ `Setting` `scoring.lastRun`) | — |
| **Jugadores rankeables (N)** | `status = APPROVED` **y** al menos una partida clasificatoria | `Player.status` + `PlayerScore.matches > 0` | — |
| **Partidas en directo** | `finishedAt is null` en jugadores aprobados | `Match` | Índice parcial (§3.6) |
| **Regla `bonus` (reservada, `PUNTUACION` §5.3)** | Puntos a mano por jugador, con motivo | **No hay dónde guardarlos** | **Hueco real: M-05** |
| **Regla "puntos por partida" (futura)** | Puntos por partida con versión de reglas | `Match.points` (sin versión) | Hueco menor: M-06 |
| **Racha de victorias (futura)** | Racha actual y mejor racha | Solo derivable de `Match` | Hueco menor: hace falta un `metric` nuevo |
| **Bonificación por upset (futura)** | Victoria contra rival de rating superior | Solo en `rawJson` | Hueco menor |

Los tres huecos de abajo del todo **no bloquean la v1**: las tres reglas están marcadas como
reservadas o futuras en `PUNTUACION` §5.3 y §8. El de `bonus` sí merece una tabla el día que se
active, y por eso está en §9.

## 6. Consultas calientes

Cada consulta con el índice que la sostiene. Un índice que no aparece aquí, no se crea.

| # | Dónde | Forma de la consulta | Índice que la sostiene | Comentario |
|---|---|---|---|---|
| 1 | `/` clasificación | `PlayerScore where ruleSetVersion = V order by rank asc take 50 skip N` | `@@index([ruleSetVersion, rank])` | Igualdad + orden. Sin `sort`. Con 60 filas, `skip` no duele; si algún día son miles, paginación por cursor sobre `rank` (M-07). |
| 2 | `/` clasificación | Lo anterior + `Player` para nombre y canal de Twitch | El anterior + `Player.id` (pk) | 60 filas, un `in` de ids. Sin joins duplicados. |
| 3 | `/jugador/[id]` | `Player where profileId = X` | `Player.profileId` (único) | |
| 4 | `/jugador/[id]` | `PlayerScore where playerId = X and ruleSetVersion = V` | pk compuesta | Una fila, leída por clave primaria. |
| 5 | `/jugador/[id]` | `Match where playerId = X order by startedAt desc take 20` | `@@index([playerId, startedAt])` | Postgres recorre el índice al revés: **no hace falta un índice `desc` aparte**. |
| 6 | `/partidas` en directo | `Match where finishedAt is null order by startedAt desc take 50`, con `Player.status = APPROVED` | Índice parcial de §3.6 | El único índice parcial que se justifica: el predicado es selectivo. |
| 7 | Worker (sync) | `Match where playerId = X and gameId in (...)` | pk única `(playerId, gameId)` | Sin cambios respecto a F2. |
| 8 | Worker (sync) | `Match where playerId = X and finishedAt is null and startedAt < cursor` | `@@index([playerId, finishedAt])` | El refetch de partidas en curso. Sin cambios. |
| 9 | Motor, recálculo completo | `Match where mode = any(...) and startedAt >= from and startedAt < to and result is not null and finishedAt is not null` (+ `durationSeconds >= min` cuando exista) | `@@index([mode, startedAt])` | Lee todas las partidas clasificatorias de la temporada. Con 30.000 filas es un escaneo de unos milisegundos; el índice lo hace mejor y evita que crezca mal. **Es la consulta que aplica la ventana** (el filtro de duración sigue diferido, así que esa parte de la condición no está en el SQL todavía). |
| 10 | Motor, agregado de un jugador | Ídem 9 con `playerId = X` | `@@index([playerId, startedAt])` | La columna que más filas trae va en la fecha. |
| 11 | Motor, orden de los hitos | `Match where playerId = X and result = WIN and finishedAt is not null order by finishedAt, startedAt, gameId` | `@@index([playerId, finishedAt])` | El desempate por fecha de la `n`-ésima victoria. `startedAt` y `gameId` no están en el índice: se resuelve ordenando en memoria, que son ≤ 8 consultas por jugador. Con la ventana son las partidas de dentro de la ventana. |
| 12 | Motor, reyes por civ | `Match where result = WIN and mode = any(...) and startedAt en ventana group by civ` | Ídem 9 | Se apoya en el mismo índice del recálculo. |
| 13 | `/admin` jugadores | `Player order by profileId` | `Player.profileId` (único) | Decenas de filas. **Sin índice en `status`** (M-09). |
| 14 | Motor, ruleset | `Setting where key in ('scoring.ruleset.active', 'scoring.ruleset.v3')` | pk | Dos filas por pasada. |
| 15 | `/admin` historial | `ScoreSnapshot order by asOf desc` | `@@index([asOf(sort: Desc)])` | Pocas filas. |
| 16 | Inscripción, límite de frecuencia | `insert ... on conflict ("key") do update ... returning count` sobre `RateLimitCounter` | pk | Una fila por IP hasheada (o el cubo `global`). El `ON CONFLICT` bloquea la fila, que es lo que serializa dos envíos simultáneos (§1.5). |
| 17 | Inscripción, purga de contadores | `delete from "RateLimitCounter" where "windowStart" < $antiguedad` | **Ninguno, a propósito** | Una vez por minuto como mucho, desde el propio contador, y la tabla es de una fila por IP vista. Un recorrido secuencial sale más barato que un índice que casi no se usaría (§1.5). |
| 18 | `/admin` historial de partidas | `Match where <clasificatorias> [and playerId = X] [and startedAt en rango] order by startedAt desc, id desc take/skip` | `@@index([mode, startedAt])`, `@@index([playerId, startedAt])` | Es la consulta 9 **más las revertidas**: el panel las tiene que listar marcadas, así que usa `classificatoryWhere()` (la regla sin `revertedAt is null`). El `id` de desempate es lo que hace estable la paginación. |
| 19 | `/admin` historial de acciones | `AdminAction order by createdAt desc, id desc take/skip` | `@@index([createdAt])` | Pocas filas (crece con las acciones del panel, no con las del torneo), así que la paginación es barata. El índice `(type, createdAt)` del schema sirve para el día que se filtre por tipo. |
| 20 | `/admin` historial de partidas | `ObjectiveEvent where [playerId = X] [achievedAt en rango] order by achievedAt desc, objectiveId desc` | `@@index([achievedAt])`, `@@index([playerId])` | **Sin paginar**: son ≤ 38 filas en toda la vida del torneo, así que el feed mezclado las trae enteras. El total de la pantalla sale sumando su recuento al de las partidas, y el hueco de partidas que hay que traer depende de cuántas hay (§1.6 y el docblock de `getAdminMatchHistory`). |
| 21 | Motor, registro de hitos | `ObjectiveEvent` leída entera y escrita solo en lo que difiere, dentro de la transacción del recálculo | `@@unique([objectiveId])` para el `upsert`, `@@index([playerId])` para el `Cascade` | No aparece en ninguna consulta como rango: es una lectura de ≤38 filas y tres escrituras (`createMany`, `update`, `deleteMany`) que no ejecutan nada cuando no hay nada que cambiar. |
| 22 | Motor de alertas, carga | `Match where playerId in (...) and <clasificatorias> order by startedAt, gameId` | `@@index([playerId, startedAt])` | Es la consulta 9 más el `playerId`: el motor de alertas (F9) carga **las clasificatorias de los jugadores tocados** y las pasa por un módulo puro. `orderBy` por `(startedAt, gameId)` porque dos jugadores de la liga en la misma partida tienen el mismo `startedAt`, y sin el desempate el orden dentro del empate dependería del planificador. |
| 23 | Motor de alertas, escritura | `Alert createMany (skipDuplicates) sobre dedupeKey` | `(dedupeKey)` único | Es la idempotencia entera del motor: una sentencia, sin leer antes lo que ya hay (§1.7). |
| 24 | `/admin` alertas | `Alert [where playerId = X] [where rule = R] order by createdAt desc, id desc take/skip` | `@@index([createdAt])`, `@@index([playerId, rule])` | Pocas filas por temporada (25 en la de este torneo, todas de `REPEATED_TEAMMATE_*`), así que la paginación es barata. |

Las consultas 9 a 12 son las que corren en cada pasada del worker. Con el volumen de un torneo
(30 jugadores, 30.000 a 50.000 partidas) son milisegundos: no es un problema de rendimiento, es un
problema de **correctitud** (que el filtro se aplique en SQL y no se pierda nada por un `join`
mal hecho). Las cuatro llevan hoy la ventana de fechas y la marca de revertida; y el filtro no está
escrito cuatro veces: `src/lib/ranked-match.ts` lo construye una vez y lo reparte como filtro de
Prisma (`rankedMatchWhere`), como predicado SQL (`rankedMatchSql`) y fila a fila
(`countsAsRanked`). `classificatoryWhere()` es la misma regla sin la marca de revertida, y solo la
consume el listado del panel (§5, fila 18).

## 7. RLS y privilegios

Postura recomendada, y el motivo de que sea esta: **la web no se conecta nunca a la base de
datos con una clave de cliente.** Todo el acceso pasa por el DAL del servidor con `DATABASE_URL`.
Así que las tablas no tienen por qué ser legibles para nadie más.

> **Estado: APLICADO, no diferido.** Vive en `scripts/db-security.ts` y se ejecuta con
> `npm run db:security`. Los cuatro pasos de la tabla se hicieron sobre las ocho tablas que
> existen (`Player`, `Match`, `PlayerScore`, `Setting`, `RateLimitCounter`, `AdminAction`,
> `Alert` y `ObjectiveEvent`);
> `ScoreSnapshot` no se creará hasta que las reglas cierren lo que le falta, y cuando se cree
> hay que volver a pasar el script. La lista de `TABLES` en el script es **explícita**: al
> añadir una tabla al schema hay que añadirla ahí, porque una tabla nueva nace con los
> permisos por defecto de Supabase y, sin el paso 3, sería legible con la clave publicable a
> través de la Data API. Pasada esa con `RateLimitCounter` (F6), el `--check` la cazó con
> `clientes=anon, authenticated`. **Y con `Alert` y `ObjectiveEvent`**: las dos nacieron
> con RLS desactivada y `SELECT` para los roles de cliente, el `--check` posterior al
> `db push` lo dijo, y `npm run db:security` lo cerró.

| Paso | Qué | Por qué |
|---|---|---|
| 1 | `alter table ... enable row level security` en **todas** las tablas de `public` | Es la capa que no se puede olvidar: aunque alguien conceda permisos por error, sin políticas las filas siguen no saliendo. |
| 2 | **Ninguna política.** Cero `create policy` | Una tabla con RLS y sin políticas devuelve **cero filas** a cualquier rol que no tenga `BYPASSRLS`. Eso es exactamente lo que queremos para `anon` y `authenticated`. |
| 3 | **Ningún `grant`** a `anon` ni a `authenticated` | Refuerzo, y es el paso que hace que la puerta esté cerrada aunque alguien añada una política el día de mañana. |
| 4 | Comprobar | `npm run db:security -- --check`, que sale con código 1 si algo no cuadra. |

```sql
-- Lo que ejecuta el script, en este orden y sin más.
alter table public."Player"            enable row level security;
alter table public."Match"             enable row level security;
alter table public."PlayerScore"       enable row level security;
alter table public."Setting"           enable row level security;
alter table public."RateLimitCounter"  enable row level security;
alter table public."AdminAction"       enable row level security;
alter table public."Alert"             enable row level security;
alter table public."ObjectiveEvent"    enable row level security;

-- Refuerzo: que los roles de cliente no puedan ni intentar leer. Sobre las
-- secuencias no hace falta hoy (public no tiene ninguna), pero se revoca igual:
-- si algún día entra una columna con `serial`, la secuencia nace con los
-- permisos por defecto de Supabase y quedaría expuesta sin que nadie se entere.
revoke all on all sequences in schema public from anon, authenticated;

revoke all on table public."Player"           from anon, authenticated;
revoke all on table public."Match"            from anon, authenticated;
revoke all on table public."PlayerScore"      from anon, authenticated;
revoke all on table public."Setting"          from anon, authenticated;
revoke all on table public."RateLimitCounter" from anon, authenticated;
revoke all on table public."AdminAction"      from anon, authenticated;
revoke all on table public."Alert"            from anon, authenticated;
revoke all on table public."ObjectiveEvent"   from anon, authenticated;
```

### 7 bis. Por qué está en un script y no en el schema

`prisma db push` compara `prisma/schema.prisma` con la base de datos, y **ni RLS ni los
permisos entran en esa comparación**: no los modela, no los lee y no los toca. Un `alter table`
hecho a mano desde el panel de Supabase no aparece en ninguna parte del repositorio, así que el
siguiente `db push` no lo sabría y el siguiente que separe el caso tampoco. Por eso el SQL está
versionado en `scripts/db-security.ts`, es idempotente y se puede repetir sin miedo.

Comprobado: un `db push` con la base ya sincronizada responde "The database is already in sync"
y **no toca** ni el RLS ni los permisos; el `--check` posterior sigue dando la postura correcta.

### 7 ter. La comprobación de que la web sigue viendo datos

**Comprobación obligatoria antes de habilitar RLS**, y el script la hace ella solo y **se niega a
aplicar nada** si no se cumple: si el rol de `DATABASE_URL` no tiene `BYPASSRLS`, activar RLS sin
políticas hará que la web deje de ver datos **en silencio**, sin error.

```sql
-- Debe devolver rolbypassrls = true (o rolsuper = true) para el rol de la app.
select current_user, rolbypassrls, rolsuper from pg_roles where rolname = current_user;
```

Comprobado en esta base de datos: `postgres`, `rolbypassrls = true`, `rolsuper = false`.
`anon` y `authenticated` siguen con `rolbypassrls = false` y `rolcanlogin = false`.

### 7 quater. Qué contesta la Data API, y por qué NO es `[]`

> **Aviso que hay que leer antes de tocar nada aquí.** Con los cuatro pasos aplicados, la Data
> API contesta **`401` `permission denied`**, no `[]`.

```json
{"code":"42501","hint":"Grant the required privileges to the current role with: GRANT SELECT ON public.\"Player\" TO anon;","message":"permission denied for table Player"}
```

No es un fallo de la postura: es la postura. En Postgres **el permiso de tabla se comprueba antes
que RLS**, así que sin `GRANT SELECT` la consulta ni siquiera llega a evaluarse. Los dos
resultados son de "no se ve nada" y se midieron por separado:

| Estado | `GET /rest/v1/Player?select=count` con la clave publicable |
|---|---|
| RLS desactivada + `SELECT` concedido a `anon` (antes de este trabajo) | `200` `[{"count":10}]` — **los datos de los jugadores, expuestos a cualquiera con la clave del navegador** |
| RLS activada + `SELECT` concedido a `anon` | `200` `[]` — RLS con cero políticas filtra todo |
| RLS activada **sin** ningún permiso para `anon` (estado actual) | `401` `permission denied` — la puerta cerrada, sin llegar a consultar |

**Cuál es el estado actual y por qué.** Se eligió el tercero: es el único que no depende de que
nadie añada nunca una política, que es la condición que hay que mantener para que el segundo siga
filtrando. El segundo da exactamente la respuesta `[]`, pero a cambio de que la seguridad
dependa de una condición que nadie vigila.

> **No se "arregle" el 401 concediendo `SELECT` a `anon`.** La pista del mensaje de error de
> Postgres sugiere exactamente eso, y sería volver a abrir la tabla. Si algún día hace falta
> que la Data API sirva alguna de estas tablas, la forma no es un `grant`: es una vista con
> `security_invoker = true` más un `grant` a esa vista, nunca a la tabla.

**Las dos posturas están en el script, y se cambian con un interruptor** (el valor por defecto
es la fuerte, para que nadie weakens por accidente):

```bash
npm run db:security                 # "cerrada":   RLS + REVOKE. La Data API contesta 401
npm run db:security -- --solo-rls   # "solo-rls":  RLS + GRANT SELECT. La Data API contesta []
npm run db:security -- --check      # dice cuál de las dos está activa y valida RLS y políticas
```

> **Aviso de seguridad.** La postura `solo-rls` **concede `SELECT` a los roles de cliente**: es
> literalmente el endurecimiento invertido, y la salida del script avisa de ello. Antes de
> pasarse a ella, que sea una decisión consciente.

### 7 quinquies. Lo que no se toca, y es deliberado

- `anon` y `authenticated` **conservan el `USAGE` sobre el esquema `public`**. Sin él la Data API
  no resuelve ni la tabla y contesta 401 por un motivo distinto; con él contesta 401 por el motivo
  correcto, o `[]` si algún día se restituye el permiso.
- `service_role` conserva sus permisos y su `BYPASSRLS`: es un rol de infraestructura de
  Supabase, no un cliente de este torneo.

Nota sobre vistas: si algún día se crea una vista para simplificar la clasificación, **una vista
se salta RLS por defecto**. Hay que crearla con `security_invoker = true` (Postgres 15+) o
revocar los permisos de `anon` y `authenticated` sobre ella. Ninguna tabla de este modelo necesita
vistas hoy.

## 8. Orden de aplicación y riesgos

### 8.0 Antes de tocar nada (solo lectura, reversible, sin riesgo)

Siete consultas que hay que hacer en Supabase antes de aplicar nada. Las tres primeras pueden
cambiar el plan.

| # | Comprobación | Por qué | Si el resultado sorprende |
|---|---|---|---|
| 0.1 | Rol de `DATABASE_URL`: `select current_user, rolbypassrls, rolsuper from pg_roles where rolname = current_user` | Si no tiene `BYPASSRLS`, RLS rompe la web en silencio (§7) | Parar. Resolver antes de aplicar nada |
| 0.2 | Estado de RLS actual: la consulta de `pg_class` de §7 | No sabemos si las tres tablas existentes ya lo tienen | Si ya lo tienen, el paso 5 se reduce a las dos nuevas |
| 0.3 | Volumen: `select count(*) from "Match"` | Decide si el *backfill* se hace de una vez o en lotes | Con más de 500.000 filas, lotes y `vacuum` |
| 0.4 | **Modos reales**: `select "leaderboard", count(*) from "Match" group by 1 order by 2 desc`, y mapas raros: `select "map", count(*) from "Match" where "map" ilike '%unknown%' group by 1` | Confirma de una vez los nombres de la API (D-01), el mapa `kind` → ladder del §3.1.1 y el literal con el que la API marca el mapa desconocido | Si aparece un modo que no esperábamos, la lista de D-01 cambia; si el mapa desconocido no se llama `Unknown Map`, el filtro de la categoría 3 hay que cambiarlo |
| 0.5 | **Claves de `rawJson`**: `select jsonb_pretty("rawJson"->'teams') from "Match" where "rawJson"->'teams' is not null limit 1` | Confirma `civilization_randomized` y que vienen las dos formas (anidada y plana) | Si la clave no es esa, el *backfill* 3b cambia |
| 0.6 | FKs sin índice (consulta de la guía de Postgres, abajo) | Un índice que falta en una FK ralentiza los `join` y los `Cascade` | Añadir el índice que falte |
| 0.7 | Duplicados: `select "playerId", "gameId", count(*) from "Match" group by 1,2 having count(*) > 1 limit 5` | Si hubiera duplicados, algún índice nuevo fallaría al crearse | Limpiar antes de aplicar |

```sql
-- 0.6: foreign keys sin ningún índice que las cubra.
select conrelid::regclass as tabla, a.attname as columna
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
where c.contype = 'f'
  and not exists (
    select 1 from pg_index i
    where i.indrelid = c.conrelid and a.attnum = any(i.indkey)
  );
```

### 8.1 Orden

> **Estado real de esta tabla.** Los pasos **1, 2, 3a, 3b y 5 están hechos**: el schema aplicado
> es el de `prisma/schema.prisma`, el `db push` fue aditivo y sin pérdidas, los dos *backfills* se
> ejecutan con `npm run backfill:model`, y el paso 5 (RLS) con `npm run db:security`, que además
> es la comprobación que hay que repetir después de cada `db push`. Los pasos **4 y 6 están
> diferidos** (ver §0 bis.3). El paso **7 está hecho a medias**: el motor calcula y publica la
> clasificación (`npm run score`) y deja el rastro de la pasada en `Setting["scoring.lastRun"]`,
> pero **no** hay `ScoreSnapshot` porque esa tabla no existe. El paso 8 se cubre en parte con
> `npm run verify:sync -- --db`.

| Paso | Qué | Riesgo | Reversible |
|---|---|---|---|
| 1 | Copiar el borrador a `prisma/schema.prisma` y `npm run generate` | Ninguno (no toca la base de datos) | Sí |
| 2 | `npm run db push` | **Ninguno**: 2 columnas aditivas, 2 tablas nuevas, 1 índice. Ni una operación destructiva | Sí, borrando tablas y columnas |
| 3a | *Backfill* de `mode` (§ SQL abajo) | Bajo. Un `UPDATE` de una columna | Sí: `set "mode" = null` y repetir |
| 3b | *Backfill* de `civRandomized` | Medio: si las claves son incorrectas, las categorías 2 y 4 salen mal | Sí: `set "civRandomized" = false` y repetir |
| 4 | Índice parcial de partidas en directo | Ninguno | Sí, `drop index` |
| 5 | RLS en las tablas que falten | **Alto si se hace sin la comprobación 0.1**: la web deja de ver datos sin error. El script la hace y se niega a aplicar si falla | Sí, `disable row level security` |
| 6 | Publicar el ruleset v1 en `Setting` | Ninguno | Sí |
| 7 | Primera pasada de puntuación + primer `ScoreSnapshot` con `reason = RULESET_PUBLISH` | Ninguno (solo escribe en las tablas nuevas) | Sí, `truncate` de las dos tablas |
| 8 | Verificación funcional (§6, consultas 1, 4, 6 y 9 a mano, con `EXPLAIN ANALYZE`) | Ninguno | — |

**El paso 3 se hace con el worker parado.** Los dos *backfills* escriben masivamente y pueden
bloquear las escrituras del worker durante unos segundos. Con este volumen no es un problema, pero
no hay razón para hacerlo en producción a la vez que entra una pasada.

```sql
-- 3a: familia de ladder. Idempotente (solo toca filas a null).
update "Match"
set "mode" = case
  when "leaderboard" = 'rm_1v1' then 'rm_solo'
  when "leaderboard" in ('rm_2v2', 'rm_3v3', 'rm_4v4') then 'rm_team'
  else "leaderboard"
end
where "mode" is null;

-- 3b: civilización aleatoria del jugador de esta fila. Idempotente: el valor se
-- recalcula siempre desde rawJson, así que se puede repetir sin miedo.
update "Match" m
set "civRandomized" = coalesce((
  select coalesce(
           p.ent -> 'player' ->> 'civilization_randomized',
           p.ent ->> 'civilization_randomized'
         ) = 'true'
  from jsonb_array_elements(m."rawJson" -> 'teams') as equipo,
       lateral jsonb_array_elements(equipo) as p(ent)
  where coalesce(
          p.ent -> 'player' ->> 'profile_id',
          p.ent ->> 'profile_id'
        ) = pl."profileId"::text
  limit 1
), false)
from "Player" pl
where pl."id" = m."playerId";

-- Verificación de 3a y 3b. La primera debe devolver 0.
select count(*) from "Match" where "mode" is null;
select count(*) from "Match" where "rawJson" -> 'teams' is not null and "civRandomized" = false;
```

La segunda verificación da un número **que no tiene que ser 0**: sirve para comparar con el
resultado del mismo `count` si se ejecuta antes del *backfill*, y confirmar que el `UPDATE` ha
tocado lo que tocaba. Si el *backfill* 3b falla en silencio (por ejemplo, si `rawJson->'teams'`
viene como un array plano y no anidado en algunas filas), esa cuenta no se moverá.

> Estos dos `UPDATE` son los que ejecuta `scripts/backfill-model.ts` (`npm run backfill:model`).
> El 3b **no** necesita el `coalesce` de las dos formas porque en el worker la lectura se hace
> sobre `teams` ya normalizado en `parse.ts`, que acepta la anidada y la plana; el SQL sí tiene
> que leer el `rawJson` crudo, y por eso ahí sí hace falta.

### 8.2 Supabase: lo que hay que tener en cuenta

| Aviso | Detalle |
|---|---|
| **No hay *shadow database*** | Nada de `prisma migrate dev` en desarrollo: no puede crear una base de sombra para calcular la diferencia. El camino válido es `db push` contra la base real. |
| **El script `migrate` del `package.json` es un pie** | `npm run migrate` ejecuta `prisma migrate dev`, que en Supabase fallará. No está en ningún flujo, pero ahí está. Decisión M-10: documentarlo como no válido en desarrollo, o quitarlo. |
| **DDL a través del *pooler*** | `prisma7.config.ts` solo tiene `url`, y `DATABASE_URL` apunta al *session pooler* de Supabase. DDL por el *pooler* funciona, pero lo propio es hacerlo contra la conexión directa. Decisión M-11: añadir `directUrl` a la config y una segunda variable de entorno. |
| **`db push` contra un *pooler* con un solo cliente** | Si `db push` se queda colgado, casi siempre es esto. Con `directUrl` desaparece. |
| **El estado de la base de datos es la fuente** | Sin migraciones, el schema es la verdad. Si alguien cambia algo a mano en el panel de Supabase, `db push` no lo sabe hasta que lo encuentra. |
| **`db push` pide confirmación si detecta pérdida** | Con el índice parcial de §3.6 puede avisar. **Nunca** usar `--accept-data-loss`: significaría que ha decidido que algo se borra. |
| **Asesor de la base de datos** | `supabase db advisors` (CLI 2.81.3+) o el equivalente por MCP, después de aplicar. Avisa de RLS, de permisos y de índices que faltan. |

## 9. Decisiones pendientes

Dos clases, y no se mezclan.

### 9.1 Decisiones de producto (son del cliente)

Las que ya están abiertas en `PUNTUACION.md` §10 **no se repiten**: son D-01 a D-16 y se resuelven
allá. Estas son solo las que son de datos y no estaban allí.

| # | Pregunta | Recomendación | Coste de cambiarla |
|---|---|---|---|
| **P-01** | **¿Cuántas temporadas conviven en la misma base de datos?** | **Todas, sin columna de temporada.** La ventana de fechas del ruleset ya las separa: los datos de la temporada 1 no cuentan en la temporada 2 porque su ventana es otra. | Añadir `seasonId` después: una columna, un índice y un filtro más en cada consulta. Feo pero no difícil. La razón de no hacerlo ahora es que la ventana ya resuelve el problema. |
| **P-02** | **¿Los jugadores aprobados que no han jugado aparecen en la web?** | **No en la clasificación.** Con la decisión D-09 (`rankableIfHasMatches: true`) no tienen fila en `PlayerScore`, así que no aparecen. **Sí en el panel de admin**, que los lista desde `Player`. | Si tienen que aparecer, el motor crea filas a 0 para ellos y hay que decidir si cuentan para `N` al repartir premios (que es justo lo que D-09 evita) o no. |
| **P-03** | **¿El desglose por categoría se publica en la web o se queda en el panel?** | **En la web.** Es lo que hace que la clasificación se entienda y lo que hace visible el versionado ("tus puntos son de la v2"). | El desglose está en `PlayerScore.breakdown` en los dos casos; no cambia el modelo, cambia el DAL. Publicarlo antes de que haya una versión 2 sería enseñar una estructura que va a cambiar. |
| **P-04** | **¿Se puede borrar el histórico de partidas al acabar la temporada?** | **No.** Es lo único que hace posible recalcular (`PUNTUACION` §5.1), y con unos cientos de KB por temporada no hay presión de espacio. | Irreversible. Si se perdieran las partidas de la temporada 1, esa temporada no se podría volver a calcular nunca. |
| **P-05** | **¿Cuánto tiempo se conservan los snapshots y las versiones de reglas?** | **Todos.** Un snapshot ocupa ~50 KB y una versión de reglas unos pocos KB. Con unas decenas de filas por temporada, la tabla entera pesa menos de 1 MB. Conservarlos es lo que permite responder "por qué cambió la clasificación". | Ninguno, y la alternativa (borrar los antiguos) pierde justamente la evidencia que justifica este modelo. |
| **P-06** | **¿Quién puede publicar una versión de las reglas?** | **Solo un admin** (Supabase Auth), desde el panel, y la acción queda anotada con `publishedBy` y la nota de cambios dentro del propio documento de la versión. | Permitir que cualquiera publique convierte el torneo en algo editable por cualquiera, y el recálculo es una operación cara. |

### 9.2 Decisiones técnicas (son mías, con motivo)

Estas se pueden revertir, pero hay que saber qué se rompe.

| # | Decisión | Mi valor | Por qué | Qué pasa si se revierte |
|---|---|---|---|---|
| **M-01** | `mode` es una columna aparte, y `leaderboard` no se toca | Sí, columnas separadas | `leaderboard` es el registro de lo que dijo la API y no se puede sobrescribir sin perder información. Además, la nueva columna es *nullable* y el *backfill* es una Sentencia | Si se sobrescribiera `leaderboard`, se pierde el dato original y la resolución quedaría ligada a la versión de la API del momento |
| **M-02** | La correspondencia `kind` → ladder va en **código**, no en el ruleset | Código | Es cómo llama la API a las cosas, no qué cuenta en este torneo. Con ella en código, cambiar la lista de modos del ruleset no obliga a reescribir datos | Si la lista de nombres se pusiera en el ruleset, cada versión nueva que añadiera un modo obligaría a volver a escribir `mode` en todas las filas |
| **M-03** | `civRandomized` como columna, con *backfill* | Sí | El conteo de civilizaciones distintas tiene que ser un `group by` en SQL | Sin la columna, el motor tendría que parsear 30.000 documentos JSON en cada recálculo para filtrar, y el filtro quedaría en memoria |
| **M-04** | Índice de partidas en directo: **parcial a mano** | Parcial | El predicado `finishedAt is null` es selectivo de verdad: unas pocas filas entre decenas de miles | Con `@@index([finishedAt, startedAt])` en Prisma funciona igual de bien y no hay que mantener nada a mano, pero el índice tiene 30.000 entradas en vez de unas pocas |
| **M-05** | Los puntos a mano (regla `bonus`) **no tienen tabla** | Sin tabla | La regla 7 del Wololo está descartada y `bonus` es un evaluador reservado. Añadir una tabla que no se usa es deuda | Cuando se active, hará falta una tabla `ScoreBonus` (jugador, versión, categoría, cantidad, motivo, quién lo concedió) para que el bonus entre en el recálculo y en la auditoría. **No bloquea la v1.** |
| **M-06** | `Match.points` se queda sin columna de versión | Se queda | Con las reglas activas la columna **sí** se usa, pero siempre la escribe el motor entero de una vez, así que no hay dos versiones conviviendo y no hay nada que versionar. Añadir `pointsRuleSetVersion` sería una columna muerta | Cuando se quisiera conservar el `points` de dos versiones de reglas a la vez, esa columna se añade con el *backfill* a 0, y las reglas por partida se recalculan desde cero |
| **M-07** | Paginación de la clasificación por `skip`/`take` | `skip`/`take` sobre `rank` | Con decenas o pocos cientos de jugadores no hay problema, y `rank` es un entero denso: no hay filas que se muevan | Con miles de jugadores, `skip` empieza a escanear filas de más. El salto a paginación por cursor sobre `rank` es local a la consulta del DAL |
| **M-08** | `PlayerScore` sin `seasonId` ni `RuleSet` relacionada | Sin referencias | Una tabla de rulesets daría integridad referencial a `ruleSetVersion`, pero el documento completo pesa poco y `Setting` ya es la memoria del worker. El coste es que nada impide una fila con una versión inexistente, y se cubre validando en la escritura | Si aparece un problema real de integridad, la migración es una tabla `RuleSet(id, version, publishedAt)` y una FK. Nada del resto cambia |
| **M-09** | Sin índice en `Player.status` | Sin índice | La consulta "jugadores aprobados" es sobre una tabla diminuta y se ordena por `profileId`, que ya está indexado por ser único | Si algún día hubiera 100.000 jugadores, el índice empezaría a merecer. No antes |
| **M-10** | Qué hacer con el script `migrate` de `package.json` | Documentarlo como no válido en desarrollo | Ejecuta `prisma migrate dev`, que no funciona sin *shadow database*. Es un pie esperando a que alguien lo pruebe | (Borrarlo o renombrarlo es un cambio de una línea, pero no lo he hecho porque este encargo es solo documentación) |
| **M-11** | `directUrl` para el DDL | Añadirlo | `prisma7.config.ts` solo tiene `url`, y apunta al *pooler*. El DDL no necesita *pooler* y a veces se queda colgado | Si no se añade, `db push` sigue funcionando, pero con menos margen |

### 9.3 Qué bloquea la implementación de F3

| Bloqueo | De quién es | Por qué bloquea |
|---|---|---|
| **Los nombres exactos de los modos** (D-01) | Producto, con un dato de la API | El filtro de partidas clasificatorias depende de la lista. Se resuelve con la consulta 0.4 y una decisión del cliente |
| **Las fechas de la ventana** (D-02) | Producto, pero **ya no bloquea** | El motor tiene el filtro aplicado y configurable (`window` en el ruleset, `[from, to)` sobre `startedAt`, fin opcional). Lo que sale del código son fechas de trabajo, 15-sep-2026 → 15-oct-2026; publicarlas es escribir `window` en `Setting`, sin despliegue. |
| **La duración mínima** (D-03) | Producto, con un dato de las partidas ya guardadas | Es un parámetro, no un bloqueo técnico: se puede arrancar con 600 s y recalcular cuando el cliente lo cambie. Sigue sin existir en el ruleset, así que es el filtro que falta. |
| **La calibración de las categorías 4 y 5** (D-06, D-07) | Producto | El motor las implementa con los valores que le den. Se puede arrancar con 5 y 3 y recalcular |
| **Publicar el ruleset v1** | Admin, con el cliente | Sin documento en `Setting` no hay nada que calcular. Es un paso de §8.1, no una decisión de diseño |
| **La comprobación 0.1 del rol** | **Resuelta** | `postgres` tiene `rolbypassrls = true`, así que RLS no deja la web sin datos. Está comprobado y `scripts/db-security.ts` lo verifica antes de aplicar (§7 ter) |

Ninguno de ellos impide **empezar** F3: el motor se puede escribir con el ruleset v1 de
`PUNTUACION` §5.4, que ya tiene valores. Los bloquean para **publicar una clasificación que no
vaya a cambiar** la semana siguiente.
