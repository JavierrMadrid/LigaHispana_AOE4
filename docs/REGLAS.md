# Reglas

Todas las reglas del torneo, agrupadas por tipo. Es el reflejo de la página `/reglas`. El sistema de
puntos está en [`docs/PUNTUACION.md`](./PUNTUACION.md) y los objetivos en
[`docs/OBJETIVOS.md`](./OBJETIVOS.md).

## Reglas

La columna **Cómo se controla** dice qué comprueba cada regla: el **alta** (validaciones del
formulario), la **organización** desde el panel, o el **motor** con una **alerta**. Las reglas
definitorias no se controlan: describen cómo es el torneo.

### Definitorias

Definen la competición. No se pueden incumplir.

| Regla | Cómo se controla |
|---|---|
| El torneo es **individual**: no hay equipos; cada persona compite con su cuenta. | — |
| Se compite en la **ladder *ranked***: 1v1 y ranked por equipos. El *quick match*, las partidas personalizadas y el resto de modos no cuentan. | — |
| Solo puntúa la partida **resuelta**: una en curso no cuenta. | — |
| Solo cuentan las partidas **dentro de las fechas del torneo** y **posteriores a la inscripción** del jugador. | — |
| Los puntos son **10 por victoria** clasificatoria más los **38 objetivos** ([puntuación](./PUNTUACION.md), [objetivos](./OBJETIVOS.md)). | — |

### De participación

Lo que hace falta para inscribirse.

| Regla | Cómo se controla |
|---|---|
| El alta se hace por **`profileId`** de AoE4World, con **correo** obligatorio. | Alta |
| Toda solicitud queda **pendiente de aprobación**: la organización la aprueba o la rechaza. | Organización |
| Las inscripciones se hacen **hasta 1 día antes del inicio del torneo**. | Organización |

### Normas

De obligado cumplimiento dentro del torneo. El incumplimiento de cualquiera de ellas es **motivo de
expulsión**. El motor vigila sobre las partidas clasificatorias las que tienen alerta y avisa a la
organización; las demás las comprueba la organización.

| Norma | Cómo se controla |
|---|---|
| **Cuenta real y personal**: no se admiten cuentas *smurf* (alternativas o de segunda cuenta). | Organización |
| **Partidas de posicionamiento**: hay que haber completado las **5 partidas de posicionamiento** de ranked 1v1 de la temporada actual. | Organización |
| **Presencia en Discord**: permanecer en el servidor del torneo durante todo el torneo. | Alerta de Discord fuera del servidor |
| **Retransmisión en directo**: emitir las partidas del torneo (Twitch, YouTube o Kick). | Organización |
| **Historial público**: mantener el historial de partidas de la cuenta en público. | Alerta de historial no público |
| **Jugar hasta el final**: no abandonar ni perder a propósito para manipular el elo. | Alerta de partidas cortas |
| **Sin rivales repetidos**: no repetir rival en 1v1 para acumular victorias. | Alerta de rival repetido |
| **Equipos equilibrados**: no jugar por equipos con compañeros de elo muy superior a la propia, ni por debajo de la propia división. | Alertas de brecha de elo y de equipo bajo la división |
| **Partidas verificables**: las partidas de ladder deben llegarnos y poder verificarse. | Alerta de partidas de ladder que no llegan |

**Manipular el elo está prohibido.** Las derrotas no restan, así que dejarse perder o abandonar para
bajar de elo y después ganar contra rivales peores infla la clasificación. El aviso de partidas cortas
salta con partidas repetidas muy por debajo del umbral de duración, que es la señal de ese abandono
deliberado.

Las alertas son **avisos para que la organización revise**, no sanciones automáticas, y sus umbrales son
configurables sin desplegar. El motor vigila además el **compañero repetido** en partidas por equipos;
ese aviso no corresponde a una regla del torneo. El detalle operativo está en
[`docs/OPERACION.md`](./OPERACION.md#alertas-de-comportamiento).

**Dónde se cambian.** El historial de partidas se abre en el propio juego, en el retrato del jugador (en
inglés, *Share History*). El servidor de Discord se enlaza desde la propia inscripción, con un botón que
conecta la cuenta; no hay que añadir a nadie a mano.

### De la organización

Facultades internas para gestionar el torneo.

| Regla | Cómo se controla |
|---|---|
| **Aprobar, rechazar y editar** participantes. | Panel |
| **Revertir o restaurar** una partida: deja de contar sin borrarla, de forma reversible. | Panel |
| **Versionar el reglamento**: un cambio de estructura sube la versión y recalcula la clasificación. | Panel |
| Dejar **registro** de cada acción en el panel. | Panel |
