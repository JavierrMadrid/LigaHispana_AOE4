# Objetivos

Los **38 objetivos especiales** del torneo, que reparten puntuación extra sobre la clasificación. Es el
catálogo funcional: qué mide cada uno, cuántos puntos da y a quién.

## Cómo se reparten

- Son **winner-takes-all**: cada objetivo lo cobra **una sola persona**, la que va primera. No hay
  puestos parciales ni puntos repartidos.
- Se resuelven sobre las mismas partidas que puntúan, así que el corte de inscripción de cada jugador
  también les aplica: un alta a mitad de torneo no puede ganar un objetivo con partidas anteriores.
- Habitualmente se resuelven **en cada recálculo de la clasificación**, así que el poseedor puede
  cambiar de una jornada a otra. La excepción son las **carreras** de civilización, que se cierran al
  completarse y no se reabren (ver "Calendario").
- El catálogo está en código (`src/lib/objectives.ts`) y la web lo lee con `getObjectives()`.

Cinco grupos, **2420 puntos** en juego:

| Grupo | Objetivos | Puntos |
|---|---|---|
| Actividad | 2 | 130 |
| Racha | 2 | 110 |
| Divisiones | 6 | 290 |
| Formatos | 4 | 180 |
| Civilizaciones | 24 | 1710 |
| **Total** | **38** | **2420** |

## Actividad

| Objetivo | Puntos | Quién lo gana |
|---|---|---|
| Loco por ganar | 70 | Quien más partidas clasificatorias ha jugado. Sin mínimo: con una partida ya se puede liderar. |
| OTP | 60 | Quien tiene más victorias con una misma civilización (su mejor civ). Sin mínimo: un umbral podría dejar el objetivo desierto. |

Si un jugador empata en victorias entre varias de sus civilizaciones, se presenta la de **más partidas
jugadas** con ella (y si aún así empata, la de `id` menor); es un criterio determinista.

Las partidas con civilización **aleatoria** no cuentan para OTP ni para los objetivos de civilización
(sí para el resto). El interruptor es `countRandomizedCivs` del ruleset.

## Racha

| Objetivo | Puntos | Quién lo gana | Mínimo |
|---|---|---|---|
| ¿Golpe de suerte? | 50 | La racha más larga de victorias seguidas, con al menos una victoria. Se mide por el orden en que terminaron las partidas. | 10 clasificatorias |
| Prohibido perder | 60 | El mejor ratio de victorias sobre el total. | 10 clasificatorias |

Sin el mínimo, quien llevara dos partidas ganadas lideraría el ratio con el 100 %.

## Divisiones

Un objetivo por división. Lo tiene el jugador **de esa división** (la de su ladder) con más victorias
totales; hace falta al menos una victoria. Si en una división no hay nadie, el objetivo queda sin
poseedor.

| Objetivo | Puntos |
|---|---|
| El Sensei de Bronce | 40 |
| El Sensei de Plata | 40 |
| El Sensei de Oro | 45 |
| El Sensei de Platino | 50 |
| El Sensei de Diamante | 55 |
| El Sensei de Conquistador | 60 |

Los puntos crecen con la división a propósito: estar en Conquistador ya exige ganar mucho.

## Formatos

Uno por tamaño de partida, con más victorias **en ese formato**. El formato sale del `kind` de la
partida (p. ej. `rm_2v2`) y, si no está, del `leaderboard`; una partida cuyo formato no se pueda
determinar no entra en este grupo.

| Objetivo | Puntos |
|---|---|
| Rey del 1v1 | 55 |
| Rey del 2v2 | 45 |
| Rey del 3v3 | 40 |
| Rey del 4v4 | 40 |

## Civilizaciones

Un objetivo por civilización (**23**) más **Masterízalos a todos**. Todos son **carreras**: gana quien
llega primero y la carrera no se reabre.

| Objetivo | Puntos | Quién lo gana |
|---|---|---|
| Masterizando &lt;civilización&gt; (×23) | 70 | El primero en llegar a **10 victorias** con esa civilización. Hasta que alguien llega a 10, el objetivo está en carrera y nadie suma por él. |
| Masterízalos a todos | 100 | El primero en ganar **al menos una partida con cada una** de las 23 civilizaciones. |

- El `id` de cada `masterizar-*` es el `id` de AoE4World de la civilización (`masterizar-japanese`,
  `masterizar-delhi_sultanate`…), que es lo que guarda `Match.civ`. El catálogo con los nombres en
  español es `src/lib/civs.ts`.
- Una civilización que no esté en el catálogo (un DLC que aún no se conoce) no cuenta para
  Masterízalos a todos.
- Las partidas con civilización aleatoria quedan fuera de todos ellos, porque no se sabe qué
  civilización se jugó.
- **Masterízalos a todos** desempata por civilizaciones distintas con al menos una victoria, luego
  victorias totales y luego antigüedad.

## Desempates dentro de un objetivo

Cadena lineal y estable:

1. La **métrica** del objetivo, descendente. En los que deciden por ratio, la comparación se hace como
   fracción (sin redondear).
2. **Victorias totales** clasificatorias, descendente.
3. **Antigüedad de la hazaña**, ascendente: quién llegó antes al valor que sostiene el empate. Gana el
   que lo logró primero.
4. **`profileId`**, ascendente (único, así que el empate siempre se rompe).

En el grupo **Civilizaciones** la regla 1 no aplica: manda quién llegó primero a completar la carrera (y
después, `profileId`).

## Calendario

- **En caliente** (los 14 que no son de civilización): se resuelven en cada recálculo con los datos de
  ahora mismo. Si hoy gana uno y mañana otro, el poseedor cambia.
- **Carreras** (los 24 de civilización): se resuelven **solo al completarse**. Antes de que alguien
  llegue a las 10 victorias (o a las 23 civilizaciones) no hay poseedor, y una vez completada la
  carrera no se reabre. Aunque la partida que la cerró se revierta, la carrera se recalcula desde cero.
