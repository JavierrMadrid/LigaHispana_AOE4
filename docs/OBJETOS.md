# Objetos utilizables

POC de la issue 134. Un **objeto** se gana con una victoria del día y reparte una
**desventaja** a quien lo porta hasta que la cumple. Está conectado a la puntuación,
al worker y al bot. El panel tiene la página **`/admin/objetos`** para lanzar y dar
la desventaja por cumplida. Aquí están las reglas y el alcance, el catálogo y las
funciones puras en [`src/lib/objects.ts`](../src/lib/objects.ts), la persistencia y
las operaciones en [`src/lib/object-awards.ts`](../src/lib/object-awards.ts), las
acciones del panel en
[`src/app/admin/objetos/actions.ts`](../src/app/admin/objetos/actions.ts), los avisos
en [`src/lib/object-announcements.ts`](../src/lib/object-announcements.ts) y las
tablas en [`MODELO-DATOS.md`](./MODELO-DATOS.md#objectaward).

## Qué es

Un objeto es una **carga** que viaja entre participantes y que no se puede rechazar.
Se otorga una vez al día por tipo, se puede lanzar a otro jugador y, mientras está
pendiente, las partidas de quien lo porta **no puntúan** (ver
[Exclusión de partidas](#exclusión-de-partidas)). La desventaja no se aplica sola: el
admin la da por cumplida sobre una partida concreta, cuando la comprueba.

## Modo configurable

El modo de objetos es un **ajuste de edición**, no del ruleset de puntos: vive en
`Setting["edition.config"].objectsEnabled`, junto a `streamingRequired` (ver
[`MODELO-DATOS.md`](./MODELO-DATOS.md)).

| Aspecto | Cómo funciona |
|---|---|
| Por defecto | **Apagado**. Una edición sin configurar no crea premios ni bloquea partidas |
| Quién lo cambia | **Solo el superadministrador**, desde Administración → Edición (`saveEditionConfig`) |
| Al apagarlo | Efecto inmediato: `disableObjectsMode()` cierra los premios pendientes (`exitedAt` = ahora) y desbloquea **todas** las partidas marcadas (`excludedByAwardId` = `null`); si había partidas bloqueadas, se recalcula la clasificación. No se congela ni se reanuda nada |
| Al encenderlo | **Sin efectos retroactivos**: empieza limpio, sin premios ni bloqueos anteriores. Un objeto que ya estaba cerrado no se reabre |
| Mientras está apagado | El worker no crea premios (`syncDailyObjectAwards()` devuelve vacío) ni marca partidas (`applyObjectBlocks()` devuelve 0); lanzar y cumplir responden con error. El panel enseña un aviso y no ofrece ninguno de los dos formularios; el histórico se sigue viendo |
| Histórico | Se conserva: apagar no borra premios, lanzamientos ni partidas; solo levanta la exclusión |

La comprobación vive en [`src/lib/object-awards.ts`](../src/lib/object-awards.ts), no
solo en la interfaz, porque al servicio también llegan el worker, una consola de
servidor y las Server Actions.

## Los tres objetos

| `kind` | Nombre | Se obtiene con la primera victoria del día por... |
|---|---|---|
| `RELIQUIA` | Reliquia pagana | victoria sagrada o religiosa |
| `MONEDA` | Moneda del Rey falsificada | conquista |
| `MONUMENTO` | Monumento | maravilla |

### Desventajas

| Objeto | `penaltyId` | Texto |
|---|---|---|
| Reliquia pagana | `sin-guarecer-reliquias` | No se pueden guarecer reliquias. |
| Reliquia pagana | `sin-unidades-monasterio` | No se pueden crear unidades del monasterio. |
| Reliquia pagana | `sin-victoria-sagrada` | No se puede ganar por victoria sagrada. |
| Moneda del Rey falsificada | `sin-2tc` | No se puede hacer 2TC. |
| Moneda del Rey falsificada | `sin-militares-5min` | No se pueden construir unidades militares los 5 primeros minutos. |
| Moneda del Rey falsificada | `sin-barcos-pesqueros` | No se pueden crear barcos pesqueros. |
| Monumento | `sin-fuertes` | No se pueden construir fuertes. |
| Monumento | `victoria-minuto-25` | Debes ganar la partida a partir del minuto 25. |
| Monumento | `sin-fuerte-toda-la-partida` | No se puede construir un fuerte en toda la partida. |

Cada objeto tiene **tres** desventajas y se sortea una con `pickPenalty()`. En la base
se guarda su **id** (`ObjectAward.penaltyId`), no el texto: el texto vive en el
catálogo y una redacción nueva no reescribe el histórico.

## Cómo se obtienen

- **Día UTC.** El día de un objeto es la **medianoche UTC** de la partida que lo
  otorga (`objectDay()`). Se guarda normalizado para que `@@unique([kind, day])`
  impida dos objetos del mismo tipo el mismo día, sea cual sea la hora a la que corra
  el proceso que los cree.
- **Primera partida del día.** De todas las victorias de un tipo en un día gana la
  **más temprana** por `startedAt`; si dos empiezan al mismo instante, desempata el
  `gameId` menor (`pickDailyAwards()`). No es "la primera que se sincroniza", que
  dependería del orden de las peticiones.
- **Motivo de la victoria.** El tipo sale de `Match.winReason` (`objectKindForWinReason()`),
  que se compara por tokens, sin distinguir mayúsculas ni acentos:

| Tokens | Objeto |
|---|---|
| `religious`, `sacred`, `sagrad` | `RELIQUIA` |
| `conquest`, `conquista`, `elimination` | `MONEDA` |
| `wonder`, `maravilla` | `MONUMENTO` |

  El mapeo es deliberadamente **tolerante**: los literales de la victoria sagrada y la
  maravilla no están confirmados (sí los de `"Surrender"`, `"Conquest"` y
  `"Elimination"`). `"Surrender"` no otorga objeto, y un motivo desconocido o `null`
  tampoco: no se crea nada.
- **Un objeto por tipo y día.** El segundo ganador del día de un tipo ya otorgado no
  crea fila: la regla la sostiene el índice único `(kind, day)`.

## Lanzamiento y devolución

- El portador puede **lanzar el objeto a otro jugador una vez al día**. En el POC el
  lanzamiento se hace desde el panel de admin, no hay automatismo ni bot.
- **Probabilidad de devolución** (`returnProbability()`), con el puesto en la
  clasificación (`1` = primero) y el total de jugadores clasificados:

  ```text
  probabilidad = min(0,99, max(0,01, (puestoObjetivo - puestoLanzador) / totalJugadores))
  ```

  Lanzar a alguien **peor clasificado** (un puesto mayor) sube la probabilidad de que
  se devuelva; lanzar a alguien mejor la deja en el suelo. Nunca es `0` ni `1`: la
  tirada siempre existe. Con menos de un jugador clasificado no hay proporción que
  calcular y devuelve `0,01`.
- Si **se devuelve**, el objeto sigue en el lanzador y ese día ya no puede volver a
  lanzarlo.
- Si **no se devuelve**, el portador pasa a ser el objetivo, con `heldSince` en el
  instante del lanzamiento; las partidas de la ventana anterior ya quedaron marcadas
  y la ventana nueva queda abierta (ver [Estados de la ventana](#estados-de-la-ventana)).
- Cada lanzamiento deja una fila en `ObjectThrow` con la tirada (`roll`) y si se
  devolvió (`returned`). Es **append-only**: cuenta lo que pasó, aunque el objeto
  cambie de manos después.
- **Regla Y:** un mismo objetivo no puede recibir el mismo objeto dos veces en el
  mismo día UTC (`sameTargetBlocked()`). Cuenta cualquier lanzamiento anotado, se
  devolviera o no.

## Persistencia y worker

Las operaciones con base de datos viven en
[`src/lib/object-awards.ts`](../src/lib/object-awards.ts); las reglas puras siguen
en [`src/lib/objects.ts`](../src/lib/objects.ts).

| Operación | Qué hace | Quién la llama |
|---|---|---|
| `isObjectsModeEnabled()` | Lee `edition.config.objectsEnabled`; es la puerta de las operaciones que escriben | Servicio, en cada operación |
| `syncDailyObjectAwards()` | Lee las partidas que puntúan y crea los premios que faltan, uno por tipo y día UTC, con el portador y la desventaja sorteados. Con el modo apagado devuelve vacío | Worker, en cada pasada |
| `applyObjectBlocks()` | Marca `Match.excludedByAwardId` en las partidas del portador que caen en una ventana abierta. Con el modo apagado devuelve 0 | Worker, en cada pasada |
| `disableObjectsMode()` | Cierra los premios pendientes y desbloquea todas las partidas marcadas: el efecto de apagar el modo | `saveEditionConfig`, fuera de la transacción |
| `throwObject()` | Valida el lanzamiento, anota `ObjectThrow` y mueve la ventana si no se devuelve. Con el modo apagado lanza un error | Panel, vía `throwObjectAction()` |
| `fulfillObject()` | Da la desventaja por cumplida sobre una partida y desbloquea esa y las posteriores. Con el modo apagado lanza un error | Panel, vía `fulfillObjectAction()` |
| `listObjectAwardsForAdmin()` | Devuelve los premios de los últimos 14 días con nombres, perfiles, desventaja y lanzamientos ya resueltos. No se filtra por el modo: el histórico se sigue viendo | Panel (lectura de la página) |
| `listAwardMatchesForAdmin()` | Las partidas del portador actual posteriores a `heldSince`, con su `excludedByAwardId`, para elegir la que cumple la desventaja | Panel (lectura de la página) |
| `listObjectThrowTargetsForAdmin()` | Los aprobados con nombre, perfil y puesto en la clasificación vigente, ordenados por puesto | Panel (lectura de la página) |

- **Una sola ventana por objeto.** `ObjectAward.heldSince` y `exitedAt` describen la
  ventana **actual**, no un histórico de tramos. Al lanzar sin devolución, la
  ventana anterior se consolida en las partidas ya marcadas y la fila se reabre con
  el objetivo (por eso `exitedAt` vuelve a `null`). Al devolverse, no se toca: solo
  se anota el lanzamiento.
- **El premio del día.** `syncDailyObjectAwards()` hace **una** consulta cruda sobre
  `Match` unida a `Player` con `rankedMatchSql()` —la misma regla que puntúa— más
  `result = 'WIN'` y `winReason` informado. Los pares `(kind, day)` ya existentes se
  excluyen antes de proponerlos (`pickDailyAwards()`) y la inserción usa
  `createManyAndReturn({ skipDuplicates: true })` sobre `@@unique([kind, day])`: dos
  pasadas simultáneas no crean el mismo premio dos veces. El premio se crea en cuanto
  el worker ve la primera victoria del día; si una partida **anterior** de ese día
  llega después, no reescribe el premio (el índice único lo impide).
- **La desventaja** se sortea con `pickPenalty()` en el momento de crear el premio y
  se guarda su id (`penaltyId`), no el texto. El azar entra por parámetro
  (`random`); por defecto es `Math.random()`, porque no es un secreto y evita
  depender de `node:crypto` en el runtime de los Workers.
- **Los bloqueos son idempotentes.** `applyObjectBlocks()` solo recorre ventanas
  abiertas (`exitedAt IS NULL`) y solo marca partidas con `excludedByAwardId` a
  `null`; dos pasadas seguidas dejan el mismo estado. Devuelve cuántas ha marcado.
- **El lanzamiento** consolida la ventana actual (marca sus partidas) **antes** de
  moverla y anota el `ObjectThrow` en la misma transacción. La probabilidad sale de
  `PlayerScore.rank` del ruleset vigente; si falta la fila de alguno de los dos, se
  degrada a `0,01` con `throwReturnProbability()` y el lanzamiento no se bloquea.
- **La pasada del worker** ejecuta los dos primeros pasos **después** del resumen de
  partida y **antes** de decidir si recalcula. Cada uno va en su `try`/`catch`: un
  fallo no tumba la pasada, se avisa por `console.warn` y queda en `objectsError`
  del resumen y del rastro. Si se creó algún premio o se marcó alguna partida, la
  pasada **fuerza el recálculo** de la clasificación (`shouldRecomputeScores()`).
  Con el modo apagado, los dos pasos no hacen nada: el servicio lo comprueba antes
  de consultar partidas y devuelve vacío.

### Estados de la ventana

| Estado | `heldSince` | `exitedAt` | `satisfiedByMatchId` |
|---|---|---|---|
| Pendiente | cuando llegó al portador | `null` | `null` |
| Devuelto | sin cambios: sigue en el lanzador | `null` | `null` |
| Movido (no devuelto) | el instante del lanzamiento | `null`: la ventana nueva queda abierta en el objetivo | `null` |
| Cumplido | cuando llegó al portador | `startedAt` de la partida que cumple | esa partida |

La fila guarda **una** ventana, así que al moverla no cabe el cierre de la anterior:
su rastro queda en las partidas que ya se marcaron (`Match.excludedByAwardId`) y en
el `ObjectThrow` que anotó el lanzamiento. Por eso `exitedAt` vuelve a `null` al
cambiar de portador, que es lo que deja la desventaja nueva activa.

## Operación

### Lanzar y cumplir

Las acciones viven en
[`src/app/admin/objetos/actions.ts`](../src/app/admin/objetos/actions.ts) y las sirve
la página `/admin/objetos`. Las dos exigen `requireAdmin()`.

| Acción | Campos (`FormData`) | Qué hace |
|---|---|---|
| `throwObjectAction` | `awardId`, `toId` | Llama a `throwObject()` y devuelve el resultado (devuelto o aceptado) con la probabilidad aplicada |
| `fulfillObjectAction` | `awardId`, `matchId` | Llama a `fulfillObject()` y da la desventaja por cumplida sobre esa partida |

- **Estado**: `{ ok, message }`, con `INITIAL_THROW_OBJECT_STATE` e
  `INITIAL_FULFILL_OBJECT_STATE` en
  [`src/app/admin/objetos/state.ts`](../src/app/admin/objetos/state.ts): un fichero
  `"use server"` solo puede exportar funciones asíncronas. Los errores del servicio ya
  están redactados en español y se devuelven tal cual. No hay `redirect`.
- **Después del cambio**: `recomputeScores()` en un `try`/`catch`. Si el recálculo
  falla, el lanzamiento o el cumplimiento **no** se deshace: el mensaje avisa de que
  la clasificación se pondrá al día en la siguiente pasada del worker.
- **Revalidación**: `/admin/objetos`, `/` y el layout `/(public)`, porque la
  desventaja mueve puntos de la clasificación pública.

### Página del panel

`/admin/objetos` ([`src/app/admin/objetos/page.tsx`](../src/app/admin/objetos/page.tsx))
es un componente de servidor: hace `requireAdmin()`, lee las tres listas y la puerta
del modo, y pinta la pantalla. La lógica de negocio no está en el cliente; los
componentes de cliente solo
llevan el estado de los dos formularios (`useActionState`), el botón (`useFormStatus`) y
la banda de confirmación (`useActionFeedback`), que conserva el éxito cuando la tarjeta
deja de estar pendiente y desaparece del listado. El error se queda bajo el botón.

| Bloque | Qué enseña |
|---|---|
| **Pendientes ahora** | Una tarjeta por objeto pendiente: desventaja, día UTC, ganador, portador y desde cuándo, historial de lanzamientos y los dos formularios (solo con el modo encendido) |
| **Historial** | Los objetos ya cerrados, compactos, con la partida que cumplió la desventaja enlazada a AoE4World |

- **El lanzamiento no se ofrece si no puede funcionar.** Si el portador ya lanzó hoy
  (`sameThrowerBlocked()`) se explica en su lugar, y los destinos que ya recibieron el
  objeto hoy se listan aparte en vez de ofrecerse (`sameTargetBlocked()`). Las dos
  reglas se leen de `src/lib/objects.ts`, no se reescriben en la página.
- **El cumplimiento** trae solo las partidas del portador posteriores a `heldSince`,
  con fecha, rival, mapa, resultado y si la partida cuenta o está excluida por este
  objeto o por otro. El aviso recuerda que la partida elegida y las posteriores
  vuelven a puntuar y las anteriores no.
- **La probabilidad no se guarda.** `ObjectThrow` conserva la tirada (`roll`) y si se
  devolvió, pero no el umbral que se aplicó; la tarjeta enseña la tirada y el
  resultado, y lo dice.
- **Con el modo apagado** la cabecera avisa de que en esta edición no se crean objetos
  ni se excluyen partidas y no se ofrecen los dos formularios; el historial se pinta
  igual. Si un fallo dejara algún pendiente, su tarjeta se enseña sin acciones.

### Avisos del bot

Van al canal de avisos (`DISCORD_BOT_TOKEN` + `DISCORD_ANNOUNCE_CHANNEL_ID`, ver
[`OPERACION.md`](./OPERACION.md)) desde
[`src/lib/object-announcements.ts`](../src/lib/object-announcements.ts).

| Aviso | Lo lanza | Qué cuenta |
|---|---|---|
| Premio nuevo | El worker, justo después de `syncDailyObjectAwards()`, uno por premio creado | Objeto, ganador, motivo y desventaja sorteada |
| Lanzamiento | `throwObjectAction()`, tras el cambio | Objeto, lanzador, objetivo, probabilidad, si se ha devuelto o ha sido aceptado y la desventaja |
| Desventaja cumplida | `fulfillObjectAction()`, tras el cambio | Objeto, portador y desventaja superada |

- **Tolerantes**: sin token o sin canal no se envía nada y no se falla; un fallo de la
  base o de Discord queda en `console.warn` y no tumba la acción ni la pasada del
  worker.
- **Sin menciones**: los mensajes llevan `suppressMentions`, para que un `@` en el
  nombre de un jugador no pinguee al servidor. No mencionan al rol de participante.
- Los textos se componen en funciones puras del mismo módulo
  (`newObjectAwardAnnouncementText()`, `objectThrowAnnouncementText()`,
  `objectFulfillmentAnnouncementText()`) y se prueban sin base en
  `tests/unit/lib/object-announcements.test.ts`.

## Exclusión de partidas

Mientras un objeto está pendiente, las partidas del portador **no puntúan** ni dan
objetivos (`isMatchBlocked()`). La comparación es con `startedAt` y **estricta** en
los dos bordes:

| Partida del portador | ¿Excluida? |
|---|---|
| `startedAt <= heldSince` | No: ya estaba jugando cuando llegó el objeto, o es la partida que se lo dio |
| `startedAt > heldSince` y `exitedAt` a `null` | Sí: el objeto sigue pendiente |
| `startedAt > heldSince` y `startedAt < exitedAt` | Sí: cayó dentro de la ventana |
| `startedAt >= exitedAt` | No: la ventana ya se cerró |

La exclusión se **materializa** en `Match.excludedByAwardId`: `applyObjectBlocks()`
marca las partidas del portador que caen dentro de la ventana y el motor añade
`excludedByAwardId IS NULL` a su regla única
([`ranked-match.ts`](../src/lib/ranked-match.ts)), en las tres traducciones: el
`where` de Prisma, el predicado SQL y `countsAsRanked()`. Una partida marcada no
suma puntos ni victorias ni objetivos, aunque siga guardada y visible en el panel.

La desventaja se da por **cumplida** cuando el admin la marca sobre una partida
concreta: `fulfillObject()` cierra `exitedAt` en su `startedAt`, desbloquea las
partidas del portador con ese `excludedByAwardId` y `startedAt >= exitedAt` —la que
cumple **cuenta**— y la siguiente vuelve a puntuar. Si el jugador estaba en partida
cuando el objeto le llegó, no le afecta hasta la siguiente. La regla de qué cuenta
como partida clasificatoria sigue siendo la de
[`PUNTUACION.md`](./PUNTUACION.md#qué-cuenta-como-partida-clasificatoria); esto solo
añade una exclusión encima.

**Limitación conocida.** `applyObjectBlocks()` solo recorre ventanas **abiertas**.
Una partida que llega a la base **después** de cerrar la ventana (por un relleno
tardío, un recheck o una publicación retrasada de AoE4World) ya no se quema: se
queda con `excludedByAwardId` a `null` y cuenta. Es aceptable en el POC; cerrarlo
exigiría guardar el histórico de ventanas que este diseño evita a propósito.

## Verificación manual

- **Reglas puras:** `npx vitest run tests/unit/lib/objects.test.ts`. Cubre el día UTC,
  el mapeo de motivos, la primera partida del día, la probabilidad (también la
  degradada), el sorteo, la exclusión, la regla Y y el lanzamiento único por día,
  todo sin base de datos. La decisión de recalcular y la exclusión en
  `countsAsRanked()` se prueban en
  `tests/unit/lib/aoe4world/sync.test.ts` y `tests/unit/lib/ranked-match.test.ts`.
- **Avisos y orden del desplegable:** `npx vitest run tests/unit/lib/object-announcements.test.ts
  tests/unit/lib/object-awards.test.ts`. Cubren los textos de los tres avisos, el
  formato de la probabilidad y el orden por puesto de los destinos de lanzamiento,
  sin base ni red.
- **Catálogo:** comparar la tabla de [Desventajas](#desventajas) con
  `OBJECT_CATALOG` (`src/lib/objects.ts`). Los ids son la clave que se guarda.
- **Esquema:** `npx prisma validate` y `npx prisma generate`. Las tablas **no** están
  aplicadas todavía en ninguna base, y `Match.excludedByAwardId` tampoco: al
  aplicarlas hay que añadir las dos tablas a la lista de
  [`scripts/db-security.ts`](../scripts/db-security.ts) (ver
  [`MODELO-DATOS.md`](./MODELO-DATOS.md#objectaward)).
- **Worker:** `objects` (premios creados) y `objectsBlocked` (partidas marcadas) en
  el resumen de `npm run sync`; `objectsError` en ese resumen y en
  `Setting["sync.lastRun"]`.
- **Una fila concreta:** `ObjectAward` dice quién lo ganó (`winnerId`,
  `winnerMatchId`), quién lo tiene (`holderId`, `heldSince`), si sigue pendiente
  (`exitedAt`) y con qué partida se cumplió (`satisfiedByMatchId`); `ObjectThrow`
  dice cada lanzamiento y `Match.excludedByAwardId` qué partidas dejó fuera. La
  desventaja es `penaltyId`, que se resuelve contra el catálogo.

## Alcance del POC

| Hay | No hay |
|---|---|
| Esquema (`ObjectAward`, `ObjectThrow`, enum `ObjectKind`, `Match.excludedByAwardId`) | Migración aplicada: el `db push` queda pendiente |
| Catálogo y reglas puras en `src/lib/objects.ts`, con sus tests | Sorteo manual del objeto desde el panel: la desventaja se sortea al crearlo |
| Persistencia y operaciones en `src/lib/object-awards.ts` | Probabilidad aplicada en cada lanzamiento: se guardan la tirada y si se devolvió |
| Exclusión en el motor (`Match.excludedByAwardId`) y paso del worker, con su efecto en el recálculo | Notificaciones por privado o menciones al rol de participante |
| Server Actions de lanzar y cumplir (`src/app/admin/objetos/actions.ts`) | Literales confirmados de victoria sagrada y maravilla |
| Página `/admin/objetos` con las tres lecturas, los dos formularios y el aviso de modo apagado | |
| Avisos del bot al canal de Discord (`src/lib/object-announcements.ts`) | |
| Mapeo tolerante de `winReason` | |

La desventaja **se sortea al crear el objeto** (`penaltyId` es obligatorio). La página
del panel es la vía normal para lanzar y cerrar una desventaja; las Server Actions son
la capa que llama a `throwObject()` y `fulfillObject()`, que también se pueden invocar
desde una consola de servidor o un script. El worker ya crea los premios, aplica la
exclusión en cada pasada y avisa de los premios nuevos al canal.
