# Overlay del directo

Tarjeta para superponer al juego mientras se retransmite el torneo. Se abre en una fuente de
navegador de OBS y se actualiza sola: no hay escenas ni temas. La posición, el tamaño, las secciones
y las animaciones se eligen en `/overlay` y viajan en la URL del overlay.

## URLs

| Ruta | Qué es |
|---|---|
| `/overlay` | El configurador: elige un participante, ajusta la tarjeta, previsualiza y copia la URL. |
| `/overlay/<profileId>` | La tarjeta del directo de ese participante. `profileId` es el identificador de AoE4World. |

La ruta del overlay no lleva cabecera, pie ni scroll, y su documento es **transparente**: está pensada
para grabarse encima del juego, no para abrirse como una página normal.

## Configuración

La configuración viaja en la URL del overlay. El configurador de `/overlay` solo añade los parámetros
que no están en el defecto, así que la URL de una tarjeta sin cambios sigue siendo la corta; los
demás se pueden escribir a mano para OBS. Un valor desconocido cae al defecto en vez de romper.

| Parámetro | Valores | Defecto |
|---|---|---|
| `posicion` | `tr`, `tl`, `br`, `bl` | `tr` |
| `tamano` | `compacto`, `normal`, `grande` | `normal` |
| `secciones` | `ambas`, `ranking`, `objetivos` | `ambas` |
| `animaciones` | `0` desactiva; `1` o `true` activan | activas |

- **Posición**: la esquina donde se ancla la tarjeta. Por defecto, arriba a la derecha.
- **Tamaño**: escala la tarjeta sin cambiar su ancho base; la esquina de anclaje no se mueve.
- **Secciones**: `ranking` oculta los últimos objetivos, `objetivos` oculta la clasificación y
  `ambas` enseña las dos.
- **Animaciones**: desactivadas, la tarjeta no sustituye la vista fija (clasificación u objetivos) por
  los eventos y deja de avanzar la cola.

## Qué muestra

| Vista | Contenido |
|---|---|
| Ranking | El puesto, el nombre y los puntos del jugador y de sus vecinos: uno por arriba y otro por abajo; en un extremo, los dos del lado disponible. La fila propia va con filete y la etiqueta «Tú». |
| Últimos objetivos | Hasta tres hitos recientes (solo `cumplido` y `progresado`, sin repetir objetivo). Los cumplidos llevan un tick; el progreso numérico (`2/3`, `8/8`) se mantiene en ambos casos. No hay etiquetas de «Cumplido» ni «Progreso». |
| Animación | Cuando llega un objetivo cumplido o progresado, sustituye la vista fija unos 4,5 s por evento, rota por todos los de la cola y vuelve a ella. Un `perdido` no interrumpe. |

La primera carga **no anima**: siembra el estado y solo anima lo que llegue después. La marca de la
tarjeta es el emblema y el nombre de la edición activa; si la configuración no se puede leer, usa el
emblema y el oro de la casa.

## Añadirlo en OBS

1. Añade una fuente de **Navegador** a la escena.
2. Pega la URL de `/overlay/<profileId>` con la configuración que hayas elegido.
3. Ajusta el tamaño de la fuente al del overlay (tabla de abajo).
4. No añadas fondo: la página ya es transparente.
5. Activa «Refrescar el navegador cuando la escena se active».
6. La tarjeta se actualiza sola cada 30 segundos.

| Tamaño | Resolución de la fuente |
|---|---|
| Compacto | 360 × 320 |
| Normal | 400 × 360 |
| Grande | 460 × 400 |

Si el overlay va a pantalla completa, usa **1920 × 1080**.

Por defecto la tarjeta se ancla arriba a la derecha; `posicion` la lleva a cualquiera de las cuatro
esquinas. En OBS se puede mover o recortar como cualquier fuente.

## Actualización

| Aspecto | Comportamiento |
|---|---|
| Sondeo | Cada **30 s** contra `/api/v0`. |
| Recálculo del torneo | Cada **10 min**; pedir más a menudo no adelanta el dato. |
| Pestaña oculta | El sondeo se pausa y se reanuda al volver a la escena. |
| Primera carga | Se siembra sin animar. |
| Fallo de red | Reintento con espera creciente (30, 60 y 120 s) conservando los últimos datos. |

## Estados y errores

| Estado | Qué se ve |
|---|---|
| Cargando | La marca y un aviso discreto. |
| `not-found` | El identificador no corresponde a un participante aprobado. |
| `unavailable` | La clasificación no responde; hay botón «Reintentar». |
| Reconectando | El subtítulo de la cabecera lo indica; los datos siguen a la vista. |
| Identificador inválido | La URL no tiene forma de `profileId`; la tarjeta lo explica. |

El contrato de datos está en [`API-OVERLAY.md`](./API-OVERLAY.md) y
[`openapi-overlay.yaml`](./openapi-overlay.yaml).
