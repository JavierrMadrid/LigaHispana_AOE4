# Puntuación

Cómo se reparten los puntos de la Liga Hispana AoE4. Es el reflejo de la página `/puntuacion`. Las
normas del torneo están en [`docs/REGLAS.md`](./REGLAS.md) y los objetivos adicionales, con sus
puntos, en [`docs/OBJETIVOS.md`](./OBJETIVOS.md).

## Qué cuenta como partida clasificatoria

Una partida puntúa si cumple **todo** esto:

- **Modo**: pertenece a la ladder *ranked*, 1v1 (`rm_solo`) o por equipos (`rm_team`). El
  identificador se normaliza en código (`rm_1v1` → `rm_solo`, `rm_2v2`/`rm_3v3`/`rm_4v4` →
  `rm_team`); la lista de familias que cuentan la da el ruleset, no el esquema.
- **Resuelta**: `result` (`WIN`/`LOSS`) y `finishedAt` informados. Una partida en curso no puntúa
  nunca, ni a favor ni en contra.
- **Dentro de la ventana** del torneo (ver abajo).
- **Posterior al corte de inscripción** del jugador (ver abajo).
- **No revertida** por la organización: la marca es reversible y la partida sigue en el histórico.
- **Equipo equilibrado** (solo partidas por equipos): ningún compañero está a **dos escalones o
  más** de división del jugador (ver abajo).
- El jugador está `APPROVED`.

El filtro es **uno solo**: vive en `src/lib/ranked-match.ts` y decide las victorias por partida, el
agregado de la clasificación **y** los objetivos. Así no se puede ganar un objetivo con partidas que
no puntúan. El worker guarda **todo** el histórico: el filtro se aplica al puntuar, no al importar.

Ese módulo tiene tres formas —`countsAsRanked()` fila a fila, `rankedMatchWhere()` como filtro de
Prisma y `rankedMatchSql()` como predicado SQL—, pero la condición de equipo solo cabe en **dos**:
necesita el JSON de la partida y los cortes de división, y un `where` de Prisma no lee ni un `Json`
ni un `Setting`. Quien lo usa filtra después en memoria con la misma función, así que las partidas
que puntúan son las mismas en las tres.

### La condición de equipo

En una partida **por equipos** (2v2, 3v3 y 4v4), la partida solo cuenta si **ningún compañero está a
dos escalones o más** del jugador, por arriba o por abajo. Se compara **cada compañero contra el
jugador** y nunca los compañeros entre sí, y el escalón es la **división** (bronce, plata, oro,
platino, diamante, conquistador): el subrango I/II/III no cuenta, así que un compañero en oro está a
cero escalones tanto si es `gold_3` como si es `gold_1`.

- Ejemplo: jugador en **oro** → cuenta con compañeros en plata, oro o platino; **no** cuenta con un
  compañero en bronce ni con uno en diamante (dos escalones).
- Es **por participante**: la misma partida puede contar para un jugador y no para otro, y para el
  que no cuenta no da ni puntos, ni victorias, ni partidas, ni objetivos.
- La condición **degrada hacia "cuenta"**: si no se puede leer el rating del jugador o de algún
  compañero (payload malformado, rating ausente, el jugador no aparece en el equipo) o no hay cortes
  de división cacheados, la partida **cuenta**. No se puede demostrar la infracción con un dato que
  no existe. Cuando faltan los cortes, el rastro del recálculo
  (`Setting["scoring.lastRun"]`) lo dice.
- Los cortes rating → división se derivan a mano con `npm run alerts:cutoffs` y se cachean en
  `Setting["alerts.divisionCutoffs"]`. Sin ellos la comprobación no se aplica (ver arriba), así que
  conviene derivarlos antes de que el torneo empiece a puntuar en serio.
- En el historial del panel (`/admin/historial`) estas partidas **se siguen listando**, con 0 puntos:
  es el recorrido del jugador, igual que las revertidas.

### La ventana

Es un intervalo `[from, to)` sobre `Match.startedAt` (cuándo se jugó, no cuándo se publicó el
resultado), en instantes ISO-8601 UTC. `from` es obligatorio y `to` es opcional: con `to: null` la
ventana queda abierta y permite fijar el fin más tarde sin tocar código. Vive en el ruleset y se
cambia sin desplegar. La página `/puntuacion` muestra el periodo con las fechas reales; si la lectura
de la base falla, cae al texto genérico y no inventa fechas.

La página `/puntuacion` lee además el **ruleset activo** para las demás cifras: los puntos por victoria
y los **objetivos activos**, de los que salen el recuento y el total que reparten (hoy 83 y 4.679
puntos). No hay cifras escritas a mano en el copy. Con la base caída la banda de resumen no se pinta y
los párrafos caen a su forma genérica, en vez de enseñar los números de la edición anterior.

La suma de 4.679 es la de los objetivos de **premio fijo** (cada uno contado una vez, `imparable` a su
tope): `victorias` queda fuera, porque no reparte un premio sino `pointsPerWin` por victoria y sin tope
(ver [`OBJETIVOS.md`](./OBJETIVOS.md#total-de-puntos)). El criterio está en código (`hasFixedPrize()`);
en una tarjeta ya resuelta se reconoce en `kind === "achievement" && target === null`.

En el panel (`/admin/administracion/puntuacion`) la ventana se escribe como **fecha y hora local de
Europe/Madrid** (`datetime-local`), que es la zona con la que la organización lee el torneo; el
servidor la interpreta en Madrid y guarda el instante **ISO-8601 UTC**. El campo sigue aceptando un
ISO con zona escrito a mano. `parseMadridLocalInstant()` / `formatMadridLocalInstant()`
(`src/lib/ranked-match.ts`) hacen la conversión: en las horas del cambio de hora, la ambigua de
octubre se resuelve con la segunda ocurrencia (invierno) y la inexistente de marzo, con el instante
justo después del salto.

### El corte de inscripción

`corte(jugador) = max(window.from, Player.registeredAt)`. La ventana es global, pero el corte es de
cada participante: a quien se da de alta a mitad de torneo no le cuentan las partidas que jugó antes de
entrar. `registeredAt` es la fecha del envío del alta (no la de la aprobación) y no se toca al aprobar.
`null` = cuenta desde `window.from`.

## Puntos por partida

| Hecho | Puntos |
|---|---|
| Victoria clasificatoria | `pointsPerWin` del ruleset (hoy **2**) |
| Derrota clasificatoria | 0 (cuenta para las partidas jugadas y los ratios, no para la suma) |
| Partida en curso, abandonada, revertida o de equipo desequilibrado | 0 |

- Se guarda partida a partida en `Match.points`, así que el total es auditable.
- **Sin ponderación por formato**: una victoria en 2v2 vale lo mismo que en 1v1. El ruleset admite un
  `pointsByMode` si algún día hiciera falta.

## Cómo se cobra una victoria

Cada victoria clasificatoria se cobra como el objetivo **`victorias`**: un logro repetible, sin tope, que
paga `ruleset.pointsPerWin` por victoria. `pointsPerWin` es la **única fuente** de lo que vale una
victoria —un `objectives["victorias"]` guardado en `Setting` se ignora—, así que no puede haber dos
cifras distintas de lo mismo.

Con eso, **todo punto de un jugador sale de sus objetivos**: `PlayerScore.total` es la suma de los
objetivos de esa fila. `Match.points` y `byMode[*].points` se conservan como **auditoría** (y para
`/admin/historial`), pero no se suman aparte: hacerlo contaría dos veces las victorias.

## Permanentes y temporales

La clasificación publica el total partido en dos columnas, y las dos suman **siempre** el total
(`PlayerScore.total`):

| Columna | Qué la compone |
|---|---|
| **Permanentes** | Los **logros** ya conseguidos (`kind: "achievement"`), que se cobran al cumplirlos y no se pierden. Las victorias están aquí, porque son el objetivo `victorias`. |
| **Temporales** | Las **competiciones** (`kind: "competition"`), que se deciden al cierre y pueden cambiar de dueño. |

El motor guarda, por objetivo cobrado, su importe real y sus repeticiones (`breakdown.objectives.awards`),
así que el total es exacto. Para repartirlo entre las dos columnas, las competiciones salen de sumar su
precio de catálogo —su precio es fijo— recortado al total, y los logros son **el resto** hasta el total:
`imparable` reparte 1 punto por día con tope, `victorias` paga por victoria, y sumar precios de logros se
quedaría con puntos que aquella fila no cobró. De ahí sale exacto también `imparable`. La diferencia
entre competición y logro está en [`OBJETIVOS.md`](./OBJETIVOS.md).

## Desempates de la clasificación

La clasificación se ordena por esta cadena, el primero por delante del siguiente:

| Criterio | Sentido |
|---|---|
| **Total** de puntos | Descendente |
| **Tasa de victorias** (victorias entre partidas jugadas) | Descendente |
| **Partidas ganadas** | Descendente |
| **Partidas jugadas** | Descendente |

La tasa se compara con producto cruzado, sin coma flotante, para que el orden sea exacto. Si dos
personas coinciden en los cuatro, **comparten puesto**: ranking de competición (1, 2, 2, 4, con el hueco
del puesto compartido). `profileId` ascendente solo fija el orden de presentación dentro del puesto
compartido, no decide el puesto. Si hay premios, el puesto compartido se reparte a partes iguales entre
quienes lo comparten. El **premio base** de la edición se anuncia en esta sección de `/puntuacion`
(importe y nota de `Setting["edition.config"]`); la campaña de donaciones, cuando está publicada, se
suma a él (ver [`REGLAS.md`](./REGLAS.md)). (El desempate **dentro de un objetivo** es otro:
ver [`OBJETIVOS.md`](./OBJETIVOS.md).)

Aparecen **todos los jugadores aprobados**: quien todavía no haya cerrado ninguna clasificatoria figura
con 0 puntos y 0 partidas, así que queda detrás de cualquiera que haya jugado alguna (y, entre ellos,
comparten el último puesto). Un jugador no aprobado no figura.

## El ruleset

El ruleset activo vive en `Setting`, clave **`scoring.ruleset`**:

```json
{
  "version": 4,
  "label": "2 puntos por victoria clasificatoria más 83 objetivos: 29 competiciones y 54 logros",
  "modes": ["rm_solo", "rm_team"],
  "window": { "from": "2026-09-15T00:00:00.000Z", "to": "2026-10-15T00:00:00.000Z" },
  "pointsPerWin": 2,
  "countRandomizedCivs": false,
  "objectives": { "loco-por-ganar": 50, "bienhadado": 200, "rey-1v1": 240 },
  "disabledObjectives": []
}
```

- **La versión la fija el código** (`RULESET_VERSION` en `src/lib/scoring.ts`, hoy **4**): cambiar un
  número no exige despliegue, cambiar la estructura sí.
- **Un documento de la versión anterior se migra**, no se descarta. La v3 no tenía
  `disabledObjectives`, así que se lee entera y el campo que falta queda vacío (catálogo completo
  activo); `ensureRuleset()` publica una vez el documento migrado para que la migración no se repita en
  cada lectura. Una versión **desconocida o futura** sí se descarta con aviso: el motor avisa y usa los
  valores por defecto **sin pisar lo guardado**.
- **`disabledObjectives`** es la lista de objetivos **apagados** (ids del catálogo). Uno apagado no se
  computa, no se publica en `/objetivos`, no reparte puntos y sus eventos de `ObjectiveEvent` se borran
  en la siguiente reconciliación. Un id que no exista o repetido se avisa y se ignora, sin tumbar el
  resto del documento. Ver [`OBJETIVOS.md`](./OBJETIVOS.md).
- **`window` no se reescribe al guardar.** Si falta, se usa la del documento por defecto; si es
  inservible, se descarta con aviso. `from` tiene que ser un instante con zona, `to` puede ser `null`,
  y `to <= from` se rechaza entero. El panel convierte antes la fecha y hora local de Madrid a UTC
  (ver [La ventana](#la-ventana)), así que lo guardado siempre cumple esto.
- **La etiqueta (`label`) la calcula el código** (`ruleLabel()`), no el documento: sale de
  `pointsPerWin` y de los objetivos **activos** ("2 puntos por victoria clasificatoria más 82 objetivos:
  28 competiciones y 54 logros" con un objetivo apagado). El `label` guardado se ignora y
  `ensureRuleset` corrige la copia de la tabla.
- **`objectives["victorias"]` se ignora** por el motor: lo que vale una victoria lo dice `pointsPerWin`
  (ver [Cómo se cobra una victoria](#cómo-se-cobra-una-victoria)). El panel no deja editarlo.
- Cada recálculo escribe `PlayerScore` solo en la versión activa; las versiones anteriores se quedan
  como histórico. El rastro de la última pasada va en `Setting["scoring.lastRun"]`.

**Quién lo cambia.** El ruleset lo publica el **superadministrador** desde el panel de administración
(`saveScoringRuleset`): valida antes de escribir y deja el rastro en `AdminAction` (`CONFIG_CHANGED`).
Un cambio que mueva puntos —ventana, familias, puntos por victoria, civ aleatoria, puntos de objetivos
u objetivos desactivados— recalcula la clasificación al guardar; si el recálculo falla, las reglas
quedan guardadas y el aviso lo dice (la clasificación se pone al día en la siguiente pasada). El
detalle operativo está en [`OPERACION.md`](./OPERACION.md#configurar-la-edición).

Forma del desglose (`PlayerScore.breakdown`): las dos familias siempre presentes, con ceros si no
aplican.

```json
{
  "ruleSetVersion": 4,
  "rule": "2 puntos por victoria clasificatoria más 83 objetivos: 29 competiciones y 54 logros",
  "byMode": {
    "rm_solo": { "wins": 3, "points": 6, "matches": 5 },
    "rm_team": { "wins": 1, "points": 2, "matches": 2 }
  },
  "objectives": {
    "points": 458,
    "earned": ["victorias", "loco-por-ganar", "rey-1v1"],
    "awards": {
      "victorias": { "points": 168, "count": 84 },
      "loco-por-ganar": { "points": 50, "count": 1 },
      "rey-1v1": { "points": 240, "count": 1 }
    }
  }
}
```

- `objectives.points` es el total de la fila: todo punto de un jugador sale de sus objetivos.
- `awards` guarda, por id cobrado, el **importe real** y las **repeticiones** (`count`), que es lo que
  permite publicar `2×Imparable +2` sin rehacer la cuenta desde el catálogo. Va aparte de `earned` (los
  ids, en orden) y **falta** en las filas escritas antes de que existiera: quien lo lea cae al precio de
  catálogo y a una repetición.
- `byMode` y `Match.points` son **auditoría** y no se suman al total.

## Ejemplo

Jugador con 140 clasificatorias y 84 victorias (60 %):

- Objetivos: las 84 victorias del objetivo `victorias` (84 × 2 = **168 puntos**) más 185 puntos de los
  demás objetivos.
- Total: **353 puntos**.

Los objetivos rompen empates y premian el estilo; con 2 puntos por victoria, completarlos pesa más que
sumar victorias en el total de un jugador fuerte.
