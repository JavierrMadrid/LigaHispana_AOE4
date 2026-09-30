# Puntuación de la Liga Hispana AoE4 — reglas v2

Estado: **propuesta para validación del cliente**. Este documento es la fuente de
las reglas; el código que las aplica vive en `src/lib/scoring.ts` (ruleset,
tabla y desempate general) y `src/lib/objectives.ts` (los 38 objetivos).

El resumen de cambios respecto a la regla provisional del MVP (1 punto por
victoria, versión de reglas 1) está en §9.

---

## 1. Qué cuenta como partida clasificatoria

- `Match.mode` ∈ `["rm_solo", "rm_team"]` (la familia de ladder resuelta; 1v1 y
  por equipos).
- `Match.result` informado (`WIN` o `LOSS`) **y** `Match.finishedAt` informado:
  una partida en curso nunca puntúa, ni a favor ni en contra.
- `Match.startedAt` dentro de la **ventana del torneo**: `>= window.from` y
  `< window.to` (§8). La ventana vive en el ruleset y se cambia sin desplegar.
- El jugador está `APPROVED`.

No se distingue entre ladder ranked y quick match: lo que la API marca como
`rm_solo`/`rm_team` es lo que puntúa. No hay mínimo de duración.

**La ventana.** Es un intervalo de instantes, `[from, to)`, y decide **cuándo se
jugó** la partida, no cuándo se publicó el resultado: la regla va sobre
`Match.startedAt` y no sobre `finishedAt`, así que una partida empezada el último
día del torneo cuenta aunque termine después. `from` es obligatorio y `to` es
opcional: con `to: null` la ventana queda abierta por la derecha, que es lo que
permite fijar el fin del torneo más tarde sin tocar código. Los dos valores son
**instantes ISO-8601 con zona explícita** (`Z` o `±hh:mm`) y se normalizan a UTC.

> **Valor de pruebas: del 15 de septiembre de 2026 al 15 de octubre de 2026,
> medianoche UTC** (`from` = `2026-09-15T00:00:00.000Z`, `to` =
> `2026-10-15T00:00:00.000Z`). Son fechas de trabajo, no las del torneo: la
> organización las pone en `Setting["scoring.ruleset"].window` (o publica el
> documento entero de nuevo) y a partir de ahí manda lo que esté escrito ahí.
> Mientras el documento guardado **no tenga** `window`, aplica la de
> `DEFAULT_RULESET`, o sea la de estas fechas.
>
> **Por qué UTC.** El proyecto guarda los instantes en ISO-8601 UTC (`since`,
> `lastSyncedAt`, el `startedAt` que publica AoE4World) y `Match.startedAt` es un
> `timestamp` sin zona **interpretado en UTC**. Escribir "medianoche
> Europe/Madrid" metería un offset que además cambia con el horario de verano, de
> modo que la frontera de la ventana se movería dos veces al año. Con instantes
> UTC el corte es el mismo los 365 días.

**El filtro es uno solo.** La misma definición decide las victorias por partida
(`Match.points`), el agregado de la clasificación (`PlayerScore.matches` y
`wins`) y **las partidas que cuentan para los objetivos**: no hay forma de ganar
un objetivo con partidas que no puntúan. Vive en `src/lib/ranked-match.ts`, que
la aplica en sus tres formas (`countsAsRanked()` fila a fila, `rankedMatchWhere()`
como filtro de Prisma y `rankedMatchSql()` como predicado SQL). El worker sigue
guardando **todo** el histórico: la ventana se aplica al puntuar, no al importar.

## 2. Puntos por partida

- **10 puntos por victoria clasificatoria.**
- Derrota clasificatoria: 0 puntos (cuenta para los ratios, no para la suma).
- Se guarda partida a partida en `Match.points`, así que el total es auditable
  sin volver a agregarlo.

No hay ponderación por formato: una victoria en 2v2 vale lo mismo que en 1v1.
Es una decisión deliberada (el torneo es individual y todos juegan las dos
familias); si algún día hiciera falta, el ruleset admite un `pointsByMode`.

## 3. Los objetivos

**38 objetivos**, repartidos en 5 grupos. Solo el **primero** se lleva los puntos
(*winner takes all*): no hay puestos parciales ni puntos repartidos.

### 3.1 Grupos y orden

| Grupo | Cuántos | Métrica |
| --- | --- | --- |
| `actividad` | 2 | `loco-por-ganar`: partidas clasificatorias jugadas; `otp`: victorias con la misma civ |
| `racha` | 2 | `golpe-de-suerte`: victorias seguidas; `prohibido-perder`: ratio global |
| `division` | 6 | victorias totales |
| `formato` | 4 | victorias en ese formato |
| `civilizacion` | 24 | victorias con esa civilización; y el objetivo que las abarca todas |

Ese es también el orden de presentación (`ObjectiveView.options`), y dentro de
cada grupo el orden de la lista: en `actividad`, `loco-por-ganar` antes que
`otp`; en `racha`, `golpe-de-suerte` antes que `prohibido-perder` (el grupo se
llama Racha, así que la racha se lee primero); divisiones de Bronce a
Conquistador; formatos de 1v1 a 4v4; civilizaciones por orden alfabético de
`id` y, **al final del grupo**, `masterizarlos-a-todos`.

### 3.2 Actividad — `loco-por-ganar` (70) y `otp` (60)

- `loco-por-ganar`: quien más partidas clasificatorias ha jugado. Sin mínimo:
  con una sola partida ya se puede ser el líder.
- `otp` (*one-trick pony*): quien tiene **más victorias con una misma
  civilización** (su mejor civ). Es el máximo, así que **no lleva mínimo de
  partidas**: un umbral solo podría dejar el objetivo sin nadie que cogerlo.
  Quien no ha ganado con ninguna civilización no entra en la carrera.

Si un jugador empata en victorias entre varias de sus civilizaciones, la que se
presenta es la de **más partidas jugadas** con ella (y si aún así empata, la de
`id` menor): es un criterio interno, determinista, para que `matches` y el
desempate 3 (§5) no dependan del orden del mapa.

Las partidas con civilización aleatoria (`civRandomized`) **no** cuentan para
`otp`, para `masterizar-*` ni para `masterizarlos-a-todos`; sí cuentan para el
resto (siguen siendo partidas clasificatorias). El interruptor es
`countRandomizedCivs` del ruleset.

### 3.3 Racha — `golpe-de-suerte` (50) y `prohibido-perder` (60)

- `golpe-de-suerte`: la racha más larga de victorias seguidas, **mínimo 10
  partidas clasificatorias** (`minimums.streak`) y con al menos una victoria en
  la racha. Se calcula sobre el orden en que terminaron las partidas
  (`finishedAt`). Rótulo público: **¿Golpe de suerte?**.
- `prohibido-perder`: mejor ratio de victorias sobre el total de partidas.
  Exige **mínimo 10 partidas clasificatorias** (`minimums.winrate`), porque sin
  umbral quien lleva dos partidas ganadas lideraría con el 100 %.

### 3.4 Divisiones — `sensei-<división>` (40–60)

Seis objetivos, uno por división. Cada uno lo tiene el jugador **de esa
división** (la división actual de su ladder, `Player.rankLevel`) con más
victorias totales; hace falta al menos una victoria. Si en una división no hay
nadie, el objetivo queda sin poseedor. Rótulo público por objetivo:
**El Sensei de Bronce**, **El Sensei de Oro**, …

| Objetivo | Puntos |
| --- | --- |
| `sensei-bronce` | 40 |
| `sensei-plata` | 40 |
| `sensei-oro` | 45 |
| `sensei-platino` | 50 |
| `sensei-diamante` | 55 |
| `sensei-conquistador` | 60 |

Los puntos crecen con la división a propósito: estar en Conquistador ya exige
ganar mucho, así que ese objetivo es el más difícil de coger y el más caro.

### 3.5 Formatos — `rey-<formato>` (55/45/40/40)

Uno por tamaño de partida, con más victorias **en ese formato**. El tamaño sale
del `kind` de la partida (`rawJson.kind`, p. ej. `rm_2v2`) y, si no está, del
`leaderboard`; una partida cuyo formato no se pueda determinar no entra en este
grupo.

| Objetivo | Puntos |
| --- | --- |
| `rey-1v1` | 55 |
| `rey-2v2` | 45 |
| `rey-3v3` | 40 |
| `rey-4v4` | 40 |

### 3.6 Civilizaciones — `masterizar-<civilización>` (70) y `masterizarlos-a-todos` (100)

Un objetivo por civilización (23). Gana quien llegue **primero a 10 victorias**
con esa civilización (`minimums.masterizar`); hasta que alguien llega a 10, el
objetivo está en carrera y **nadie** suma por él. Id de objetivo = `id` de
AoE4World (`masterizar-japanese`, `masterizar-delhi_sultanate`, …), que es lo
que guarda `Match.civ`.

`src/lib/civs.ts` es el catálogo (id → nombre en español) y también la lista
que fija el orden.

#### `masterizarlos-a-todos` (100)

El objetivo que **abarca las 23 civilizaciones**: gana quien sea el primero en
ganar **al menos una partida con cada una** del catálogo. Se presenta al final
del grupo `civilizacion`, después de los 23 `masterizar-*`.

Es una **carrera**, igual que ellos: hasta que alguien cierra las 23 nadie cobra,
y una vez cerrada la carrera no se reabre. El poseedor lo decide el instante
(`finishedAt` de la partida, en milisegundos) de la victoria con la **última**
civilización que le faltaba, con desempate por `profileId` si dos jugadores la
completan en la misma partida. Por debajo del poseedor, la clasificación se
ordena por **civilizaciones distintas con al menos una victoria** (23 en total),
luego por victorias totales y luego por antigüedad (§5).

- **`matches`** del contendiente: la suma de las partidas jugadas **con las
  civilizaciones con las que ya tiene alguna victoria**, que son las que producen
  el `value`. Se descarta así lo que no ha servido para el objetivo: no es el
  total del jugador ni el de todas sus partidas clasificatorias.
- **`eligible`** solo cuando tiene victoria con **las 23**. Una civilización que
  no esté en el catálogo (una civ de un DLC que `civs.ts` todavía no conoce) no
  cuenta ni para el `value` ni para cerrar la carrera.
- Las partidas con civ aleatoria quedan fuera, igual que en `masterizar-*`
  (`countRandomizedCivs`): no se sabe qué civilización se jugó.
- Quien no ha ganado con ninguna civilización del catálogo no entra en la
  carrera, igual que en `otp`: sin progreso no hay clasificación que enseñar.
- Los **100 puntos** son una propuesta: el objetivo es mucho más difícil que un
  `masterizar-*` (70) porque no basta con llegar a 10 victorias con una civ, hay
  que ganar con cada una, y hay al menos dos que son las que más se juego. Sube
  el total en juego de 2320 a 2420 (§4).

`minimums.masterizar` no aplica aquí: basta una victoria por civ, así que el
objetivo no tiene ningún umbral configurable y por eso **no** aparece en
`minimums` de la vista.

### 3.7 Contrato de lectura — `getObjectives()`

La web no monta nada de esto a mano: consume la vista que devuelve
`getObjectives()` (reexportada desde `src/lib/public.ts`). Forma exacta, para
programar la interfaz contra ella:

```ts
type ObjectiveView = {
  ruleSetVersion: number; // versión activa de las reglas
  rule: string; // RULE_LABEL: el texto que se pinta como regla
  pointsPerWin: number; // puntos por victoria del ruleset activo (§2)
  window: {
    from: string; // instante ISO-8601 UTC, inclusive (§1)
    to: string | null; // instante ISO-8601 UTC, exclusivo; null = sin fin
  };
  minimums: {
    winrate: number; // mín. partidas de prohibido-perder (§3.3)
    streak: number; // mín. partidas de golpe-de-suerte (§3.3)
    masterizar: number; // victorias de masterizar-* (§3.6)
  };
  options: ObjectiveOption[]; // los 38, en el orden de §3.1
};

type ObjectiveOption = {
  id: string;
  group: "actividad" | "racha" | "division" | "formato" | "civilizacion";
  label: string; // copy exacto, p. ej. "¿Golpe de suerte?"
  description: string; // la regla en una frase corta (§3.7)
  metric: "partidas" | "winrate" | "racha" | "victorias";
  points: number; // del ruleset activo, no de la constante
  holder: ObjectiveContender | null; // null = sin poseedor
  ranking: ObjectiveContender[]; // todos, ordenados por §5
};

type ObjectiveContender = {
  profileId: number;
  name: string;
  avatarUrl: string | null;
  profileUrl: string | null; // https://aoe4world.com/players/<profileId>
  value: number; // valor de la métrica
  matches: number; // partidas de las que sale `value`
  eligible: boolean; // solo un elegible puede poseer el objetivo
  detail?: { id: string; label: string } | null;
};
```

- `pointsPerWin`, `window` y `minimums` salen del ruleset activo: son los
  números vivos para el resumen y para el copy de mínimos (no hay constantes en
  la UI). `window` está para que `/reglas` pueda decir qué periodo cuenta sin
  escribir fechas en el texto, que es lo que dejaría de ser cierto el día que se
  cambien en `Setting`.
- `rule` es `RULE_LABEL`, texto que fija el código (§8).
- `profileUrl` sigue el mismo criterio que `StandingRow.profileUrl`.
- `description` vive en el catálogo, no en la interfaz, porque es la regla: si
  el copy estuviera en el componente, cada tarjeta podría acabar contando una
  cosa distinta de la que el motor aplica. No lleva dentro números
  configurables (el de `masterizar-*` sale de `minimums.masterizar`), así que no
  puede quedarse mintiendo cuando cambien en `Setting`. Las 23
  `masterizar-<civ>` comparten plantilla con el nombre de la civ.
- `ranking` es la **lista entera** de contendientes, ordenada por la cadena de
  §5: no hay tope y la paginación la hace el cliente. Solo entra quien tiene al
  menos una partida dentro del objetivo (mismo criterio que antes, que descartaba
  a los que no habían jugado); **no** se rellena con jugadores a cero. El
  poseedor **no** se pone el primero: aparece en la posición que le da su
  métrica y lo distingue `holder`, que es lo único que hace falta porque en las
  carreras `masterizar-*` el que más victorias tiene puede no ser quien llegó
  antes al mínimo.
- `detail` hoy solo lo rellena `otp` (§3.2): la civilización con la que el
  jugador acumula sus victorias, como `{ id, label }` con el nombre en español;
  en el resto de objetivos llega a `null`. El campo queda reservado para futuros
  detalles.

## 4. Resumen de puntos

| Grupo | Objetivos | Puntos en juego |
| --- | --- | --- |
| Actividad | 2 | 130 |
| Racha | 2 | 110 |
| Divisiones | 6 | 290 |
| Formatos | 4 | 180 |
| Civilizaciones | 24 | 1710 |
| **Total** | **38** | **2420** |

Los 14 objetivos que no son de civilización suman 710 puntos; los 24 de
civilización, 1710. Como solo un jugador puede coger cada uno, en la práctica un
participante rara vez pasa de 5 u 6 objetivos (≈ 250–350 puntos).

## 5. Desempates dentro de un objetivo

Cadena lineal y estable, en este orden:

1. **Métrica** del objetivo, descendente. Hoy solo `prohibido-perder` decide
   por ratio y entonces la comparación se hace como fracción, sin decimales
   redondeados; el resto de métricas son valores enteros (partidas, victorias,
   racha).
2. **Victorias totales** clasificatorias, descendente.
3. **Antigüedad de la hazaña**, ascendente: quién llegó antes al valor que
   sostiene el empate (`finishedAt` de la partida que lo completó). Gana el que
   lo logró primero.
4. **`profileId`**, ascendente (único, así que el empate siempre se rompe).

En el grupo `civilizacion` la regla 1 no aplica: manda **quien llegó primero a
completar la carrera** —a 10 victorias con su civ en `masterizar-*`, a las 23 en
`masterizarlos-a-todos`— (y después `profileId`), porque son carreras y no una
tabla.

## 6. Calendario: "en caliente" y carreras congeladas

- Todos los objetivos se resuelven **en caliente**, es decir, en cada recálculo
  del worker (cada 5 minutos) con los datos que hay ahora mismo. Si hoy gana
  uno y mañana otro, el poseedor cambia.
- **Excepción, grupo `civilizacion`**: esos objetivos se resuelven **solo al
  completarse**. Antes de que alguien llegue a 10 victorias con la civ —o a las
  23 civilizaciones, en `masterizarlos-a-todos`— no hay poseedor; una vez
  completada, la carrera no se reabre (ver §5: gana el que llegó primero).

## 7. Ejemplo de reparto

Jugador fuerte: 140 partidas clasificatorias, 84 victorias (60 %).

- Partidas: 84 × 10 = **840 puntos**.
- Objetivos: `loco-por-ganar` (70) + `prohibido-perder` (60) + `rey-1v1` (55) =
  **185 puntos** (18 % del total).
- Total: **1025 puntos**.

Los objetivos buscan estar **entre el 15 % y el 30 %** del total de un jugador
fuerte: suficiente para que rompan empates y premien el estilo de juego, sin
llegar a pesar más que jugar partidas.

## 8. Ruleset configurable y versionado

El ruleset activo vive en `Setting`, clave **`scoring.ruleset`**:

```json
{
  "version": 2,
  "label": "10 puntos por victoria clasificatoria más 38 objetivos especiales; solo el primero los cobra",
  "modes": ["rm_solo", "rm_team"],
  "window": { "from": "2026-09-15T00:00:00.000Z", "to": "2026-10-15T00:00:00.000Z" },
  "pointsPerWin": 10,
  "minimums": { "winrate": 10, "streak": 10, "masterizar": 10 },
  "countRandomizedCivs": false,
  "objectives": { "loco-por-ganar": 70, "masterizar-japanese": 70, "masterizarlos-a-todos": 100 }
}
```

- **La versión la fija el código** (`RULESET_VERSION` en `src/lib/scoring.ts`);
  cambiar un número no exige despliegue, cambiar la estructura sí. La ventana es
  un **número con forma fija**, así que se reconfigura como `pointsPerWin` y **no**
  sube la versión: publicar otro `window` no invalida el `PlayerScore` que ya hay.
  Subiría si la ventana dejara de ser un intervalo (por ejemplo, una lista de
  intervalos), porque entonces un documento guardado describiría otra cosa.
- **`window` no se reescribe al guardar.** Si la clave no está en el documento
  guardado, se usa la de `DEFAULT_RULESET` sin tocar nada; si está pero es
  inservible, se descarta y se avisa por log. Las tres reglas de validación:
  `from` tiene que ser un instante ISO-8601 **con zona** (`Z` o `±hh:mm`), `to`
  puede ser `null` (ventana abierta) o un instante, y `to <= from` se rechaza
  entero porque sería una ventana que no puntúa nada. Un `to` **ausente** (clave
  no escrita) hereda el del documento por defecto y avisa: abrir la ventana hay
  que pedirlo escribiendo `null`, no por olvidarse. Lo que sí se corrige solo es
  la etiqueta, y es lo mismo que en el punto anterior.
- La etiqueta (`label`) también la fija el código (`RULE_LABEL`): es texto
  de producto, no configuración. El valor guardado se ignora al leer y
  `ensureRuleset` corrige la copia almacenada en el siguiente recálculo, así
  que la interfaz no puede enseñar el texto de otra versión.
- Si la clave no existe, el motor la publica con los valores por defecto en el
  primer recálculo.
- Si el documento guardado está mal formado o su `version` no coincide con la
  del código, el motor **avisa y usa los valores por defecto, sin pisar lo
  guardado** (a mano se corrige desde el panel o con un SQL); la única
  excepción es la corrección automática de la etiqueta del punto anterior.
- Cada recálculo escribe `PlayerScore` **solo** en la versión activa; la versión
  1 (regla provisional) sigue en su tabla, sin tocarse: es el histórico.

## 9. Qué cambia frente al MVP y qué queda abierto

Cambia:

- 1 → **10 puntos por victoria** (§2).
- Se añaden **38 objetivos** (§3) y sus desempates (§5).
- `PlayerScore.breakdown` añade el bloque `objectives` (`points` y `earned`);
  `byMode.points` sigue siendo solo puntos de partidas.
- Reagrupación: desaparece el grupo **Dominio**; `otp` pasa a **Actividad** y
  `prohibido-perder` a **Racha** (§3.1). Solo cambia la agrupación y el orden de
  presentación: `id`, puntos, métricas y mínimos no se tocan.
- `otp` decide por **victorias con la misma civilización**, sin umbral (§3.2).
- Se añade **`masterizarlos-a-todos`** al final del grupo Civilizaciones: carrera
  a ganar con las 23 (§3.6), 100 puntos.
- Rótulos públicos fijados por el cliente: **¿Golpe de suerte?**,
  **El Sensei de &lt;división&gt;** (§3.3, §3.4) y **Masterízalos a todos**
  (§3.6).
- **Ventana de fechas** del torneo sobre `Match.startedAt`, configurable en el
  ruleset y aplicada por igual a las victorias, al agregado y a los objetivos
  (§1). Con el worker guardando el histórico entero, como hasta ahora.
- La vista de objetivos entrega los números vivos (`pointsPerWin`, `window`,
  `minimums`), `profileUrl`, el `detail` de `otp`, una `description` por objetivo
  y el `ranking` **completo** en vez del top 3 (§3.7).

Abierto, a decidir por el cliente:

1. **38 objetivos**: 14 sin civilización (2 actividad + 2 racha + 6
   divisiones + 4 formatos) + 24 de civilización (23 `masterizar-*` más
   `masterizarlos-a-todos`). El número que se manejó al empezar (36) no cuadraba
   con 23 civs; si se quisiera recortar, el candidato natural sigue siendo fundir
   `rey-3v3` y `rey-4v4`.
2. **Puntos exactos** (§4): todas las cifras son propuesta, no están cerradas.
   En particular, los 100 de `masterizarlos-a-todos` (los últimos puntos de
   §3.6) y los 60 de `otp`, que se propusieron con la métrica de ratio y ahora
   que gana el máximo de victorias con una civ el objetivo se coge más fácil: si
   compensa, ese es el sitio natural para ajustar.
3. **Traducciones de civilizaciones**: los nombres en español de
   `src/lib/civs.ts` son propuesta (p. ej. `jeanne_darc` → "Juana de Arco").
4. **Sin ponderación por formato** (§2). Y la **ventana de fechas** (§1) ya
   existe y es configurable, pero con **fechas de trabajo**: 15-sep-2026 →
   15-oct-2026. Lo que falta es que la organización las fije, y con ellas la
   pregunta de si el fin se deja abierto (`to: null`) para que la ventana pueda
   seguir creciendo durante el torneo.
5. La rama histórica `docs/f3-puntuacion` con un diseño anterior (5 categorías,
   techo 109) **no existe en este repositorio**; este documento la sustituye.
