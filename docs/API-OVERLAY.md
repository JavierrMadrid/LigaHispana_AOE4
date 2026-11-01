# API para el overlay

Contrato de lectura que consume el overlay del stream. El esquema formal, para generadores y
validadores, está en [`openapi-overlay.yaml`](./openapi-overlay.yaml) (OpenAPI 3.2.1, versión 1.1.1).
Este documento es la versión humana: qué hay, qué significa cada campo y qué se puede esperar.

## Base

| Dato | Valor |
|---|---|
| URL | `https://laligahispana.es/api/v0` |
| Acceso | Solo lectura (`GET` y `OPTIONS`). Sin autenticación, sin cookies, sin claves. |
| CORS | `Access-Control-Allow-Origin: *` |
| Caché | `Cache-Control: no-store` |
| Polling recomendado | 30 s |

El dato de fondo cambia al ritmo del recálculo (cada 10 minutos), así que pedir más a menudo no
adelanta nada. Las rutas no pasan por sesión: no están en el `matcher` del Proxy.

## Endpoints

| Endpoint | Devuelve |
|---|---|
| [`GET /participantes`](#participantes) | Los participantes aprobados: `id` y `alias`. |
| [`GET /clasificacion`](#clasificacion) | La fila de un participante y hasta dos vecinos, con su feed de objetivos. |
| [`GET /objetivos`](#objetivos) | El catálogo de objetivos activos con sus puntos y su icono. |

## `/participantes`

| Aspecto | Comportamiento |
|---|---|
| `?id=` | Opcional. `Player.profileId` como cadena (1 a 10 dígitos, sin ceros a la izquierda). |
| 200 sin `id` | Lista completa, ordenada por `profileId`. Vacía si no hay aprobados. |
| 200 con `id` | Lista de una fila. |
| 400 | El `id` no es válido (no es un entero positivo). |
| 404 | Se pidió un `id` que no existe o que no está aprobado. |

| Campo | Origen | Nota |
|---|---|---|
| `id` | `Player.profileId` | Cadena, no número. |
| `alias` | `Player.name` | Nombre con el que compite. |

```json
[
  { "id": "7099800", "alias": "Miguel Narvaez" },
  { "id": "6946414", "alias": "Mecroid" }
]
```

## `/clasificacion`

| Aspecto | Comportamiento |
|---|---|
| `id` | **Obligatorio**. 400 si falta o no es válido. |
| `desde` | Opcional, ISO 8601 **con zona** (`2026-10-24T14:30:00Z` o `+02:00`). Inclusivo (`>=`). |
| 200 | De 1 a 3 filas, en orden de posición. |
| 404 | No hay fila publicada para ese participante (o no está aprobado). |
| 503 | La base de datos no responde. |

### La ventana de filas

- Devuelve el participante solicitado y **hasta dos vecinos** en el orden publicado.
- En un extremo, los dos del lado disponible; en medio, uno por encima y uno por debajo.
- Solo la fila solicitada lleva `eventos_objetivos`; los vecinos llevan `{}`.
- `posicion` es `PlayerScore.rank`: los empates comparten puesto y el desempate de presentación es
  `profileId` ascendente.

### Campos

| Campo | Origen | Nota |
|---|---|---|
| `id` | `Player.profileId` | Cadena. |
| `posicion` | `PlayerScore.rank` | Puede repetirse por empate. |
| `partidas` | `PlayerScore.matches` | Partidas clasificatorias contadas. |
| `puntos.volatiles` | Desglose | Puntos de las competiciones (se poseen y se pierden). |
| `puntos.permanentes` | Desglose | Logros más el bono de eventos; sumados a `volatiles` dan el total. |
| `rango` | `Player.elo` + `rankLevel` | `null` sin ladder. |
| `victorias` / `derrotas` | `wins` y `matches - wins` | |
| `racha` | `PlayerScore.streak` | Firmada: ver abajo. `null` sin partidas. Nunca 0. |
| `eventos_objetivos` | `ObjectiveProgressEvent` | Último evento por objetivo. `{}` en los vecinos. |

### `rango`

`{ puntos, liga, division }` o `null`.

- `puntos` es el ELO.
- `liga` es el id de división: `bronce`, `plata`, `oro`, `platino`, `diamante`, `conquistador`.
- `division` es el subrango `1`–`3`.
- Es `null` si falta el ELO, la división o el subrango: el overlay no pinta un rango a medias.

### `racha`

Racha del **torneo**, firmada:

| Valor | Significado |
|---|---|
| `> 0` | Victorias clasificatorias seguidas. |
| `< 0` | Derrotas clasificatorias seguidas. |
| `null` | Sin partidas clasificatorias contadas. |

Nunca vale `0`. No es la racha de la ladder de AoE4World.

### `eventos_objetivos`

Mapa `id de objetivo → evento más reciente`. Solo aparecen objetivos **activos** (los desactivados
por la organización se descartan).

| `tipo` | Cuándo | `progreso` | `repeticion` |
|---|---|---|---|
| `cumplido` | Logro completado o competición ganada. | `propio` (`>= 1`) | Si el objetivo es repetible. |
| `perdido` | **Solo competiciones**: dejó de poseerla. | `propio` (`>= 0`) y `ajeno` si hay nuevo poseedor (`>= 1`). | **Nunca**. |
| `progresado` | Avance sin completar ni ganar. | `propio` (`>= 1`) | Si el objetivo es repetible. |

- `progreso.propio` puede ser `0` en un `perdido`: todas las partidas que lo sostenían se
  revirtieron.
- `progreso.ajeno` solo existe en `perdido` y solo si hay nuevo poseedor.
- `repeticion` solo aparece en objetivos repetibles (`victorias`, `imparable`).
- `fechahora` es ISO 8601 con zona.

**Cuándo se escribe.** El feed sale de `ObjectiveProgressEvent`, que escribe `recomputeScores()` en
cada pasada (cada 10 minutos). Los logros y las competiciones aparecen **en vivo**, con el retraso
del recálculo, no solo al cierre de la edición.

- La primera pasada de una edición siembra `CUMPLIDO` y `PROGRESADO`; **no hay `PERDIDO`** en la
  siembra, porque no había nada que perder.
- `at` es el instante del pase, salvo la siembra de un logro con la ventana ya cerrada, que usa
  `window.to`.

**`desde` y la fusión.** La primera llamada sin `desde` devuelve la foto completa (el último evento
de cada objetivo). Las siguientes, con `desde`, devuelven solo lo nuevo. El cliente debe **fusionar
y deduplicar** por `id` + `fechahora`: dos eventos pueden compartir instante.

**Una bajada no se publica.** Revertir una partida (o anularla) actualiza el estado interno pero no
genera evento: el contrato no tiene un tipo `retrocedido`. La siguiente subida vuelve a anotarse; en
competiciones, perder el liderazgo sí genera `perdido`.

```json
[
  {
    "id": "7099800",
    "posicion": 1,
    "partidas": 29,
    "puntos": { "volatiles": 836, "permanentes": 106 },
    "rango": null,
    "victorias": 13,
    "derrotas": 16,
    "racha": null,
    "eventos_objetivos": {}
  },
  {
    "id": "6946414",
    "posicion": 2,
    "partidas": 17,
    "puntos": { "volatiles": 480, "permanentes": 94 },
    "rango": { "puntos": 1618, "liga": "conquistador", "division": 3 },
    "victorias": 6,
    "derrotas": 11,
    "racha": -2,
    "eventos_objetivos": {
      "loco-por-ganar": {
        "tipo": "perdido",
        "fechahora": "2026-10-24T14:30:30Z",
        "progreso": { "propio": 0, "ajeno": 29 }
      },
      "victorias": {
        "tipo": "progresado",
        "fechahora": "2026-10-24T14:30:00Z",
        "progreso": { "propio": 6 },
        "repeticion": 6
      },
      "imparable": {
        "tipo": "cumplido",
        "fechahora": "2026-10-24T14:20:00Z",
        "progreso": { "propio": 9 },
        "repeticion": 9
      }
    }
  },
  {
    "id": "2194511",
    "posicion": 3,
    "partidas": 4,
    "puntos": { "volatiles": 360, "permanentes": 7 },
    "rango": { "puntos": 1033, "liga": "platino", "division": 1 },
    "victorias": 3,
    "derrotas": 1,
    "racha": 2,
    "eventos_objetivos": {}
  }
]
```

## `/objetivos`

Catálogo activo, en orden de presentación. Sin parámetros.

| Campo | Nota |
|---|---|
| `id` | Id estable del catálogo (`loco-por-ganar`, `victorias`, `imparable`, `lider-japanese`). |
| `nombre` | Etiqueta para pintar. |
| `descripcion` | Frase de la regla. |
| `icono_url` | URL **absoluta** en los objetivos de civilización; `""` en el resto. |
| `puntos` | Puntos con la regla activa. En `victorias`, el precio **por victoria**. |
| `volatil` | `true` en competiciones (se poseen y se pierden); `false` en logros. |
| `repetible` | `true` en `victorias` e `imparable`. |
| `max_progreso` | `null` en competiciones y en `victorias`; umbral en los logros con tope; tamaño del pool en `por-tierra-y-agua`. |

`max_progreso` no es un cero: `null` significa "sin tope".

```json
[
  {
    "id": "loco-por-ganar",
    "nombre": "Loco por ganar",
    "descripcion": "El jugador con más partidas clasificatorias jugadas en el torneo. En caso de empate, lo cobra quien alcanzó esta cifra antes.",
    "icono_url": "",
    "puntos": 50,
    "volatil": true,
    "repetible": false,
    "max_progreso": null
  },
  {
    "id": "lider-japanese",
    "nombre": "Líder Japoneses",
    "descripcion": "Gana al menos 3 partidas con Japoneses.",
    "icono_url": "https://laligahispana.es/imagenes/civilizaciones/Japanese_AoE4.webp",
    "puntos": 12,
    "volatil": false,
    "repetible": false,
    "max_progreso": 3
  }
]
```

## CORS y errores

Todas las respuestas (también las de error) llevan:

| Cabecera | Valor |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, OPTIONS` |
| `Access-Control-Allow-Headers` | `Accept, Content-Type` |
| `Cache-Control` | `no-store` |

`OPTIONS` responde **204** sin cuerpo. No hay `Access-Control-Allow-Credentials`: el navegador no
manda la sesión de nadie.

| Estado | `codigo` | Cuándo |
|---|---|---|
| 400 | `parametro_invalido` | Falta un parámetro obligatorio o no tiene el formato esperado. |
| 404 | `participante_no_encontrado` | El participante no existe, no está aprobado o no tiene fila publicada. |
| 503 | `servicio_no_disponible` | La base de datos no responde. |

```json
{ "codigo": "participante_no_encontrado", "mensaje": "No se encontró un participante con el identificador indicado." }
```

El `codigo` es estable y va en `snake_case`; el `mensaje` es texto en español y puede cambiar.

## Despliegue y verificación

```bash
npm run db:push                  # crea ObjectiveProgressEvent y ObjectiveProgressState
npm run db:security -- --check   # RLS de las dos tablas nuevas (aplica con db:security)
npm run score                    # siembra el feed (idempotente)
npm run verify:overlay-api       # comprueba la API contra DATABASE_URL, solo lectura
```

- `SCORING_CACHE_VERSION = 2` fuerza el recálculo en el primer pase tras el despliegue; sin ese
  salto, el worker podría saltarse la pasada y el feed no se sembraría hasta la siguiente partida.
- Las dos tablas se leen **solo** por el DAL: la Data API no las expone.
- `verify:overlay-api` es de solo lectura y compara lo que devuelven los lectores de
  [`src/lib/overlay-api.ts`](../src/lib/overlay-api.ts) con lo que hay en la base.
