# Objetivos

Los **82 objetivos** del torneo, que reparten puntuación extra sobre la clasificación. Es el catálogo
funcional: qué mide cada uno, cuántos puntos da y **quién lo cobra**. La puntuación base está en
[`docs/PUNTUACION.md`](./PUNTUACION.md); aquí solo están los objetivos.

## Competición y logro

Hay **dos formas de cobrar**, y es la diferencia de fondo de este catálogo:

- **Competición** (`competition`): *winner-takes-all*. Lo cobra **una sola persona**, la que va
  primera. Un único poseedor.
- **Logro** (`achievement`): lo cobra **todo el que cumple la condición**. Puede ser binario (se
  cumple o no) o acumulativo (`imparable`: 1 punto por día, hasta 14). **No hay poseedor único.**

Se resuelven sobre las mismas partidas que puntúan, así que el corte de inscripción de cada jugador
también les aplica: un alta a mitad de torneo no puede ganar un objetivo con partidas anteriores. El
catálogo está en código (`src/lib/objectives.ts`) y la web lo lee con `getObjectives()`.

## Grupos

| Grupo | Competiciones | Logros | Objetivos |
|---|---|---|---|
| Actividad | 1 | 1 | 2 |
| Racha | 1 | 1 | 2 |
| Hazañas | 0 | 3 | 3 |
| Formatos | 4 | 0 | 4 |
| Civilizaciones | 23 | 48 | 71 |
| **Total** | **29** | **53** | **82** |

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

## Logros (cobra quien cumple)

| Objetivo | Puntos | Condición |
|---|---|---|
| Imparable | 1 por día, tope 14 | Al menos una partida clasificatoria cada **día natural** (Europe/Madrid). |
| Imbatible | 32 | Conseguir una racha de 5 victorias seguidas. |
| Agresor | 24 | Ganar al menos 3 partidas de menos de 10 minutos. |
| Estratega | 24 | Ganar al menos 3 partidas de más de 20 minutos. |
| Por tierra y agua | 81 | Jugar al menos 3 partidas en **cada** mapa del pool activo. |
| Polifacético | 96 | Ganar al menos 3 partidas con **cada una** de las 23 civilizaciones. |
| Líder `<civ>` (×23) | 12 | Ganar al menos 3 partidas con esa civilización. |
| Jugón | 24 | Jugar al menos 3 partidas con **cada una** de las 23 civilizaciones. |
| Acólito `<civ>` (×23) | 6 | Jugar al menos 3 partidas con esa civilización. |

- En `agresor`/`estratega` las partidas sin duración quedan fuera. Umbrales: `< 600 s` y `> 1200 s`.
- En `imparable` el valor del ranking es el número real de días; los puntos van con tope (14).
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

Los 23 `masterizando-<civ>` no forman familia —no tienen cabeza que los agrupe—, pero en `/objetivos`
se leen igual: bajo el titular «Masterizando», un riel con el mismo filtro de banderas y la misma
navegación, con cada tarjeta abriendo la clasificación de esa civilización.

## Pool de mapas

`por-tierra-y-agua` usa los mapas de `Setting["scoring.mapPool"]`: una lista de nombres **exactamente**
como los publica AoE4World en `Match.map` (`"Dry Arabia"`). El worker la refresca **una vez al día**
desde el pool activo de AoE4World (el homepage, no la API), y la organización puede reescribirla a mano.
Si la clave no existe o no es válida, se usa el valor por defecto de `src/lib/map-pool.ts`, que son los
9 mapas reales de la rotación en curso. El detalle del refresco está en
[`docs/OPERACION.md`](./OPERACION.md#pool-de-mapas).

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
- El registro de hitos (`ObjectiveEvent`) solo se escribe **cuando la ventana del torneo ya ha
  terminado**, con `achievedAt` = el fin de la ventana. Con la ventana abierta no se registra nada.
  Hay un evento por objetivo y jugador, porque un logro tiene varios beneficiarios.

## Total de puntos

A diferencia del catálogo anterior, el total en juego **no es un número cerrado**: un logro lo cobra
cada participante que lo cumple, así que su reparto se multiplica por el número de beneficiarios.
`imparable` reparte puntos variables por jugador. La **suma nominal** del catálogo —cada objetivo
contado una vez, `imparable` a su tope de 14— es **4.679 puntos**: es la cifra que resume la banda de
`/puntuacion`. Los puntos por objetivo, uno a uno, están en las tablas de arriba y en
`OBJECTIVE_POINTS`.
