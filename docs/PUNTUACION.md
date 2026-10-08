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
- El jugador está `APPROVED`.

El filtro es **uno solo**: vive en `src/lib/ranked-match.ts` en sus tres formas (`countsAsRanked()`
fila a fila, `rankedMatchWhere()` como filtro de Prisma y `rankedMatchSql()` como predicado SQL), y
decide las victorias por partida, el agregado de la clasificación **y** los objetivos. Así no se puede
ganar un objetivo con partidas que no puntúan. El worker guarda **todo** el histórico: el filtro se
aplica al puntuar, no al importar.

### La ventana

Es un intervalo `[from, to)` sobre `Match.startedAt` (cuándo se jugó, no cuándo se publicó el
resultado), en instantes ISO-8601 UTC. `from` es obligatorio y `to` es opcional: con `to: null` la
ventana queda abierta y permite fijar el fin más tarde sin tocar código. Vive en el ruleset y se
cambia sin desplegar. La página `/puntuacion` muestra el periodo con las fechas reales; si la lectura
de la base falla, cae al texto genérico y no inventa fechas.

### El corte de inscripción

`corte(jugador) = max(window.from, Player.registeredAt)`. La ventana es global, pero el corte es de
cada participante: a quien se da de alta a mitad de torneo no le cuentan las partidas que jugó antes de
entrar. `registeredAt` es la fecha del envío del alta (no la de la aprobación) y no se toca al aprobar.
`null` = cuenta desde `window.from`.

## Puntos por partida

| Hecho | Puntos |
|---|---|
| Victoria clasificatoria | `pointsPerWin` del ruleset (hoy **10**) |
| Derrota clasificatoria | 0 (cuenta para las partidas jugadas y los ratios, no para la suma) |
| Partida en curso, abandonada o revertida | 0 |

- Se guarda partida a partida en `Match.points`, así que el total es auditable.
- **Sin ponderación por formato**: una victoria en 2v2 vale lo mismo que en 1v1. El ruleset admite un
  `pointsByMode` si algún día hiciera falta.

## Desempates de la clasificación

Total descendente, luego victorias descendentes, luego `profileId` ascendente. Como `profileId` es
único, el orden es total y el puesto un entero denso. (El desempate **dentro de un objetivo** es otro:
ver [`OBJETIVOS.md`](./OBJETIVOS.md).)

## El ruleset

El ruleset activo vive en `Setting`, clave **`scoring.ruleset`**:

```json
{
  "version": 3,
  "label": "10 puntos por victoria clasificatoria más 82 objetivos: 29 competiciones y 53 logros",
  "modes": ["rm_solo", "rm_team"],
  "window": { "from": "2026-09-15T00:00:00.000Z", "to": "2026-10-15T00:00:00.000Z" },
  "pointsPerWin": 10,
  "countRandomizedCivs": false,
  "objectives": { "loco-por-ganar": 50, "bienhadado": 200, "rey-1v1": 180 }
}
```

- **La versión la fija el código** (`RULESET_VERSION` en `src/lib/scoring.ts`): cambiar un número no
  exige despliegue, cambiar la estructura sí. Si el documento guardado no coincide en versión, el motor
  avisa y usa los valores por defecto **sin pisar lo guardado**.
- **`window` no se reescribe al guardar.** Si falta, se usa la del documento por defecto; si es
  inservible, se descarta con aviso. `from` tiene que ser un instante con zona, `to` puede ser `null`,
  y `to <= from` se rechaza entero.
- **La etiqueta (`label`) también la fija el código**: es texto de producto, no configuración.
- Cada recálculo escribe `PlayerScore` solo en la versión activa; las versiones anteriores se quedan
  como histórico. El rastro de la última pasada va en `Setting["scoring.lastRun"]`.

Forma del desglose (`PlayerScore.breakdown`): las dos familias siempre presentes, con ceros si no
aplican.

```json
{
  "ruleSetVersion": 3,
  "rule": "10 puntos por victoria clasificatoria más 82 objetivos: 29 competiciones y 53 logros",
  "byMode": {
    "rm_solo": { "wins": 3, "points": 30, "matches": 5 },
    "rm_team": { "wins": 1, "points": 10, "matches": 2 }
  },
  "objectives": { "points": 125, "earned": ["loco-por-ganar", "rey-1v1", "lider-french"] }
}
```

## Ejemplo

Jugador con 140 clasificatorias y 84 victorias (60 %):

- Partidas: 84 × 10 = **840 puntos**.
- Objetivos: 185 puntos (ver [`OBJETIVOS.md`](./OBJETIVOS.md)).
- Total: **1025 puntos**.

Los objetivos buscan pesar entre el 15 % y el 30 % del total de un jugador fuerte: rompen empates y
premian el estilo, sin pesar más que jugar partidas.
