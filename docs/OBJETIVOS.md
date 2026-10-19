# Objetivos

Los **88 objetivos** del torneo, que reparten puntuación extra sobre la clasificación. Es el catálogo
funcional: qué mide cada uno, cuántos puntos da y **quién lo cobra**. La puntuación base está en
[`docs/PUNTUACION.md`](./PUNTUACION.md); aquí solo están los objetivos. El catálogo es el del código,
pero el ruleset puede **desactivar** objetivos de una edición a otra (ver
[Desactivar un objetivo](#desactivar-un-objetivo)).

## Competición y logro

Hay **dos formas de cobrar**, y es la diferencia de fondo de este catálogo:

- **Competición** (`competition`): *winner-takes-all*. Lo cobra **una sola persona**, la que va
  primera. Un único poseedor.
- **Logro** (`achievement`): lo cobra **todo el que cumple la condición**. Puede ser binario (se
  cumple o no), con tope (`imparable`: 1 punto por día, hasta 14) o **sin tope** (`victorias`: paga los
  puntos por victoria de la regla activa por cada victoria). **No hay poseedor único.**

Se resuelven sobre las mismas partidas que puntúan, así que el corte de inscripción de cada jugador
también les aplica: un alta a mitad de torneo no puede ganar un objetivo con partidas anteriores. El
catálogo está en código (`src/lib/objectives.ts`) y la web lo lee con `getObjectives()`.

En la clasificación, los puntos de un logro se publican como **permanentes** y los de una competición
como **temporales** (puede cambiar de dueño hasta el cierre): ver [`PUNTUACION.md`](./PUNTUACION.md).

## Grupos

| Grupo | Competiciones | Logros | Objetivos |
|---|---|---|---|
| Actividad | 1 | 2 | 3 |
| Racha | 1 | 2 | 3 |
| Hazañas | 0 | 7 | 7 |
| Formatos | 4 | 0 | 4 |
| Civilizaciones | 23 | 48 | 71 |
| **Total** | **29** | **59** | **88** |

El grupo **Divisiones desaparece**: los antiguos `sensei-*` ya no existen.

## Competiciones (winner-takes-all, un poseedor)

| Objetivo | Puntos | Métrica | Condición |
|---|---|---|---|
| Bienhadado | 200 | racha | La racha de victorias seguidas más larga. |
| Loco por ganar | 50 | partidas | Quien más partidas clasificatorias ha jugado. Sin mínimo. |
| Masterizando `<civ>` (×23) | 120 | victorias | Quien más victorias tiene con esa civilización. Sin mínimo. |
| Rey del 1v1 / 2v2 / 3v3 / 4v4 | 240 | victorias | Quien más victorias tiene en ese formato. |

- El `id` de `masterizando-*` es el de AoE4World de la civilización (`masterizando-japanese`), que es
  lo que guarda `Match.civ`. El catálogo con los nombres en español es `src/lib/civs.ts`.
- El formato sale del `kind` de la partida (p. ej. `rm_2v2`) y, si no está, del `leaderboard`; una
  partida cuyo formato no se pueda determinar no entra en ningún `rey-*`.
- Las partidas con civilización **aleatoria** quedan fuera de los objetivos de civilización (no de los
  demás). El interruptor es `countRandomizedCivs` del ruleset.
- En caso de empate lo cobra quien alcanzó esa cifra antes (desempate 3, ver
  [Desempates](#desempates-dentro-de-un-objetivo)); la tarjeta lo dice en su descripción.

## Logros (cobra quien cumple)

| Objetivo | Puntos | Condición |
|---|---|---|
| Imparable | 1 por día, tope 14 | Al menos una partida clasificatoria cada **día natural** (Europe/Madrid). |
| Victorias | `pointsPerWin` por victoria, sin tope | Cada victoria clasificatoria. Es el objetivo que paga las victorias del torneo. |
| Imbatible | 32 | Conseguir una racha de 5 victorias seguidas. |
| Ansioso | 6 | Encadenar 3 partidas clasificatorias seguidas con 120 APM o más. |
| Agresor | 24 | Ganar al menos 3 partidas de menos de 10 minutos. |
| Estratega | 24 | Ganar al menos 3 partidas de más de 20 minutos. |
| Avance relámpago: Feudal | 4 | Llegar a la Edad Feudal antes de 4 minutos en una partida clasificatoria. |
| Avance relámpago: Castillos | 8 | Llegar a la Edad de los Castillos antes de 9 minutos en una partida clasificatoria. |
| Avance relámpago: Imperial | 12 | Llegar a la Edad Imperial antes de 16 minutos en una partida clasificatoria. |
| Defensor del pueblo | 12 | Terminar una partida de 15 minutos o más perdiendo menos de 3 aldeanos, menos de 2 aldeanos dorados y ningún aldeano montado. |
| Por tierra y agua | 81 | Jugar al menos 3 partidas en **cada** mapa del pool activo. |
| Polifacético | 96 | Ganar al menos 3 partidas con **cada una** de las 23 civilizaciones. |
| Líder `<civ>` (×23) | 12 | Ganar al menos 3 partidas con esa civilización. |
| Jugón | 24 | Jugar al menos 3 partidas con **cada una** de las 23 civilizaciones. |
| Acólito `<civ>` (×23) | 6 | Jugar al menos 3 partidas con esa civilización. |

- `victorias` **no tiene premio propio**: cada victoria vale lo que diga `pointsPerWin` del ruleset (hoy
  2). Es la única fuente de lo que vale una victoria, así que un `objectives["victorias"]` retocado en
  `Setting` se ignora. Su `points` en el catálogo (2) es documental.
- En `agresor`/`estratega` las partidas sin duración quedan fuera. Umbrales: `< 600 s` y `> 1200 s`.
- **`ansioso`, los tres `avance-relampago` y `defensor-del-pueblo`** salen del **resumen de partida**
  (APM, tiempos de edad y pérdidas), que vive en el sitio de AoE4World —no en su API— y el worker pide
  aparte y guarda en `Match`. Una partida
  **sin resumen** no cumple ninguna hazaña y **corta** la racha de `ansioso`: un umbral sobre un dato que
  no existe no se puede afirmar. `ansioso` publica su racha (métrica `racha-partidas`, la de partidas
  seguidas por APM) y los cuatro `avance-relampago`/`defensor` el recuento de partidas que consiguen la
  hazaña (métrica `partidas`): ese recuento es su valor de ranking, con umbral 1. Cómo se consigue, en
  [`OPERACION.md`](./OPERACION.md#resumen-de-partida).
- En `imparable` el valor del ranking es el número real de días; los puntos van con tope (14). Las
  **repeticiones** que publica la web también son los días reales ("20 x Imparable +14").
- Las partidas con civilización aleatoria no cuentan para los objetivos de civilización.

### Familias

`polifacético` es la cabeza de los 23 `lider-<civ>`, y `jugón` lo es de los 23 `acolito-<civ>`: son
los logros globales de cada familia. Se modelan con un campo `parent` en la definición (la cabeza
tiene `parent: null`; cada hijo apunta a su cabeza) y la interfaz los agrupa en un bloque. En
`/objetivos` el bloque es la tarjeta de la cabeza más un riel de subobjetivos, y la tarjeta explica
el reparto del conjunto —lo que da cada subobjetivo y lo que suma completarlos todos con el global—
a partir de sus `points` y del número de hijos. En la ficha de un participante la cabeza sigue en las
secciones (es un objetivo que se consigue) y sus hijos van en un carrusel por familia, **dentro de "Al
alcance"** y tras sus tarjetas individuales, con el avance del jugador y las tarjetas ordenadas de
mayor a menor porcentaje de consecución.

La tarjeta de la cabeza añade además el detalle por civilización: la **lista más corta de las dos**
—las hechas o las que quedan— con la bandera de cada una y la cifra en partidas (Jugón) o victorias
(Polifacético). La ventana volteable la lista entera, en el resumen frontal y en la cara de
clasificación.

Los 23 `masterizando-<civ>` no forman familia —no tienen cabeza que los agrupe—, pero en `/objetivos`
se leen igual: bajo el titular «Masterizando», un riel con el mismo filtro de banderas y la misma
navegación, con cada tarjeta abriendo la clasificación de esa civilización.

## Desactivar un objetivo

El ruleset (`Setting["scoring.ruleset"].disabledObjectives`) puede apagar objetivos del catálogo, uno a
uno y por su `id`. Un objetivo apagado:

- **no se computa**: `computeObjectives()` se salta su definición antes de calcular candidatos;
- **no se publica**: no aparece en `/objetivos`, ni en la ficha de un participante, ni en el snapshot
  (`Setting["scoring.objectives"]`, que se reescribe porque cambia su huella);
- **no reparte puntos**: nadie lo cobra, así que el total de la clasificación sale de los **activos**;
- **pierde sus eventos**: `ObjectiveEvent` (logros) es un espejo de lo que se cobra hoy, así que la
  reconciliación borra las filas del objetivo apagado; y si era una **competición**, su poseedor
  desaparece del cómputo y el registro de liderazgos (`ObjectiveLeadEvent`) anota una `LOST` para el
  que la tenía.

Apagar la **cabeza** de una familia (`polifacetico`, `jugon`) no apaga a sus hijos: la familia es una
agrupación de la interfaz, no una dependencia, y cada objetivo se apaga por su id. Un id que no exista
en el catálogo o repetido se avisa y se ignora.

La etiqueta de la regla se recalcula con los objetivos activos, así que la web no anuncia objetivos que
ya no existen. Lo cambia el superadministrador desde el panel; el detalle, en
[`OPERACION.md`](./OPERACION.md#configurar-la-edición).

## Pool de mapas

`por-tierra-y-agua` usa los mapas de `Setting["scoring.mapPool"]`: una lista de nombres **exactamente**
como los publica AoE4World en `Match.map` (`"Dry Arabia"`). El worker la refresca **una vez al día**
desde el pool activo de AoE4World (el homepage, no la API), y la organización puede reescribirla a mano.
Si la clave no existe o no es válida, se usa el valor por defecto de `src/lib/map-pool.ts`, que son los
9 mapas reales de la rotación en curso. El detalle del refresco está en
[`docs/OPERACION.md`](./OPERACION.md#pool-de-mapas).

El avance del jugador en este objetivo se publica **por mapa**: los mapas del pool que le faltan y
cuántas partidas le faltan en cada uno (`missing`, 1..3), sin los ya completados y sin el umbral. En la
ficha se lee "Faltan 7 mapas · 1 × X, 2 × Y, 3 × Z"; el campo es `mapGaps` (ver el contrato de
`ObjectiveContender` / `ParticipantObjective`).

## Desempates dentro de un objetivo

Cadena lineal y estable, para **competiciones** (decide el poseedor) y para ordenar el ranking de un
logro (que no decide puntos: todos los que cumplen cobran):

1. La **métrica** del objetivo, descendente.
2. **Victorias totales** clasificatorias, descendente.
3. **Antigüedad**: quién alcanzó antes el valor que sostiene el empate.
4. **`profileId`**, ascendente (único, así que el empate siempre se rompe).

## Calendario

- **Todos** los objetivos se resuelven en caliente: se recalculan con los datos de ahora mismo y su
  poseedor o sus beneficiarios pueden cambiar de una jornada a otra. Ya **no hay carreras**: el
  catálogo no tiene ningún objetivo que se cierre al completarse.
- El registro de **logros** (`ObjectiveEvent`) solo se escribe **cuando la ventana del torneo ya ha
  terminado**, con `achievedAt` = el fin de la ventana. Con la ventana abierta no se registra nada.
  Hay un evento por objetivo y jugador, porque un logro tiene varios beneficiarios.
- Los cambios de poseedor de una **competición** (`ObjectiveLeadEvent`) se registran **en vivo**, en
  cada recálculo: cada vez que una competición cambia de manos se anotan dos filas con el mismo
  instante —`LOST` para el que la suelta y `GAINED` para el que la agarra—, y la primera vez que se
  ve un poseedor se siembra con una sola `GAINED`. Es lo que permite contar en `/historial` "ahora
  lidera" y "ya no lidera" durante el torneo. Una competición que no cambia de dueño no escribe nada.
- Si la edición ya se jugó antes de activar ese registro, `npm run backfill:objective-leads`
  reconstruye la secuencia desde las partidas contadas: borra y reescribe las filas de la edición,
  con el `finishedAt` de la partida que cambió el poseedor. Es idempotente, toma el cerrojo del
  recálculo y `-- --dry-run` lo enseña sin escribir.

## Total de puntos

A diferencia del catálogo anterior, el total en juego **no es un número cerrado**: un logro lo cobra
cada participante que lo cumple, así que su reparto se multiplica por el número de beneficiarios.
`imparable` reparte puntos variables por jugador. La **suma nominal** del catálogo —cada objetivo de
premio fijo contado una vez, `imparable` a su tope de 14— es **4.721 puntos**: es la cifra que resume la
banda de `/puntuacion`. `victorias` **queda fuera** de esa suma, porque no reparte un premio fijo sino
`pointsPerWin` por victoria y sin tope: contarlo una vez diría que el catálogo reparte una cifra que no
reparte. El criterio está en código (`hasFixedPrize()`), y en una tarjeta ya resuelta se lee en
`kind === "achievement" && target === null`. Los puntos por objetivo, uno a uno, están en las tablas de
arriba y en `OBJECTIVE_POINTS`.
