# Portada · Liga Hispana AoE IV

La clasificación es la tarea principal: ver quién lidera y con cuántos puntos al entrar. La información secundaria se consulta en los laterales o al desplegar un jugador.

| Elemento                     | Regla                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| Ámbito                       | Solo `/`, incluida cabecera y pie; otras rutas conservan su diseño                          |
| Fondo / panel / borde        | Tinta `#090F1A` / azul heráldico `#122039` / metal azulado `#2B405D`                        |
| Texto principal / secundario | `#EDF1F8` / `#B6C3D6`                                                                       |
| Acento                       | Oro `#D6B568` para inscripción, selección, foco y primer puesto; rojo para emisión          |
| Tipografía                   | Cinzel para identidad; Inter para tablas, controles y títulos funcionales; cifras tabulares |
| Espaciado                    | Base 4–8px; laterales separados 24px; conjunto de ancho máximo 1360px                       |
| Radios                       | Tabla y paneles 6px; controles 4px                                                          |
| Iconos                       | Phosphor Icons, peso regular; `/ssr` en servidor; assets oficiales de marcas y divisiones   |
| Modo                         | Operate: resultados visibles desde el primer render, sin entradas animadas de filas         |

## Composición y densidad

- Desde 1440px: orientación a la izquierda (192px), clasificación central y actividad a la derecha (208px). Identidad con escudo transparente; panorama adaptado del Sacro Imperio Romano debajo de la navegación y detrás del comienzo del contenido, sin duplicarlo dentro de la identidad.
- De 1100 a 1439px: identidad y estado compactos sobre la tabla; actividad a la derecha; ayuda de puntuación debajo.
- Por debajo de 1100px: una columna; identidad breve, clasificación, actividad y ayuda. El orden del DOM mantiene primero la tabla y después los enlaces de apoyo.
- Móvil: escudo pequeño y participantes sobre la tabla; cuenta atrás y actualización pasan debajo de la clasificación y la actividad. El refresco de datos se monta una sola vez.
- Tabla continua de fondo neutro y separadores finos. Filas de 44px en escritorio y 52px en móvil; altura uniforme con independencia de emisión o podio.
- Columnas: puesto, jugador, puntos totales, V / D, Elo y expansión. Victorias y derrotas permanecen visibles en móvil, con etiqueta accesible completa. Reutilizan los colores del detalle: victorias verdes y derrotas rojas si son mayores que cero; separador y cero neutros. En móvil Elo pasa al detalle. Nombre de 15px en escritorio; puntos de 19px. Puestos planos con color discreto para los tres primeros.
- Sin avatares, banderas de fondo, placas de puesto, halo del puntero ni observadores que oculten filas. La bandera pequeña junto al nombre se conserva.
- Identidad de una línea: nombre truncable con nombre completo accesible, bandera, punto de partida y canales que emiten. Alias y canales registrados completos en el detalle.
- Elo: emblema de 22×26px junto a la cifra; sin nombre de división visible. Una clasificación ausente se muestra con `—`.
- Actividad: hasta tres jugadores emitiendo, con sus enlaces de Twitch, YouTube o Kick; no depende de los filtros de tabla. Se omite la sección de streams si está vacía. Partidas distingue cero de información no disponible.
- Objetivo de revisión, con zoom 100%, filtros cerrados y filas plegadas: al menos ocho filas a 1440×900, seis a 1366×768 y cuatro a 390×844.

## Filtros y navegación de resultados

- Una barra compacta: «Clasificación», búsqueda de jugador/alias/canal y botón «Filtros» con número de filtros activos. Sin barra de orden permanente.
- Escritorio: panel anclado de 320px en la capa superior nativa (`popover`), sin desplazar la tabla. Móvil: `dialog` modal inferior con foco protegido, fondo inerte y bloqueo de scroll; botón «Ver resultados» para cerrar.
- Un solo contenido y estado para ambas presentaciones: selección múltiple de divisiones con emblemas, «En partida», «En directo», orden y dirección. Cambios inmediatos; combinar actividad aplica AND.
- Escape, cierre y clic exterior cierran y devuelven foco al disparador. Escape de la lista de divisiones cierra solo esa lista. Flechas, Inicio/Fin y tabulador conservan su navegación.
- Chips extraíbles solo con filtros activos, además de «Limpiar». «Restablecer vista» borra búsqueda y filtros, vuelve a puesto ascendente y página 1; se activa ante cualquier cambio de la vista inicial. «Limpiar» en los chips conserva búsqueda y orden. El vacío filtrado permite limpiar búsqueda y filtros juntos.
- Cabeceras ordenables: puesto, jugador, puntos y Elo. Nuevos criterios numéricos comienzan descendentes; puesto y nombre, ascendentes. Valores nulos al final. Panel y cabeceras comparten estado. Las divisiones seleccionadas se combinan con OR entre sí y con AND respecto a actividad y búsqueda; cuentan como un único filtro.
- Filtrar, buscar y ordenar opera sobre toda la colección antes de paginar y vuelve a página 1. Páginas de 25, rango anunciado y navegación al pie. Las primeras 25 filas son legibles en HTML sin JavaScript.

## Detalles y puntuación

- El botón de expansión anuncia jugador y estado con `aria-expanded` y `aria-controls`.
- Ayuda lateral «Cómo sumar puntos»: «Por victorias» (victorias clasificatorias y bonos de los eventos activos) y «Por objetivos» (completa logros o lidera retos para sumar puntos extra). No fija una tarifa que pueda variar por edición o evento. Conserva enlaces a puntuación y objetivos.
- Detalle: Acumulados, Por liderato, partidas, victorias/derrotas, racha, Elo en móvil, alias, canales y tarjetas existentes de objetivos.
- Acumulados = `pointsByAchievements` (victorias, logros y bonos de eventos); Por liderato = `pointsByCompetitions` (objetivos competitivos actuales). Ambos son autoritativos de la clasificación v1.0, sin reconstruirlos en UI. La fila cerrada muestra solo el total. Nunca renombrar el antiguo reparto victorias/objetivos como si fuera esta división.
- La lectura usa `Standings.rows` y conserva el aviso de `pendingRuleSetVersion` cuando los puntos publicados siguen calculados con reglas anteriores.
- Objetivos de v1.0: descripción y tipo provienen de cada fila; `objectiveTitle` conserva repeticiones y `points` muestra lo cobrado. Pulsar abre bajo demanda la clasificación con `ObjectiveRankingDialog` y su tarjeta grande; carga y fallo tienen estados accesibles, sin respuestas tardías que reabran un diálogo cerrado.
- Tarjetas de objetivos: toda la superficie activa la ayuda y cambia fondo en 200ms al pasar o enfocar. `HomeObjectiveHelpProvider` admite una sola ayuda activa, con 160ms de margen para mover el puntero al tooltip. Foco, toque y Escape disponibles.
- Movimiento reducido: sin animación decorativa ni transición de hover; expansión inmediata. Canales en directo conservan el color de su plataforma y ayuda accesible.

## Estados y continuidad

- Esqueleto compacto, vacío, fallo y clasificación usan la misma composición responsive.
- Previews solo en desarrollo: `loading`, `empty`, `unavailable`, `live` y `stress`; no leen ni escriben clasificación en base de datos. `stress` contiene 1500 jugadores deterministas y primeras filas con actividad variada.
- Fuera de previews no se inventan participantes, partidas, objetivos ni horas de sincronización. Una lectura fallida muestra recuperación y actividad no disponible.
- Sin nuevos premios, campañas ni anuncios inventados. Se conservan los banners de eventos y donaciones, el estandarte y crédito del patrocinador y la configuración de edición (nombre, emblema y acento), también en la portada.
- Navegación y pie mantienen identidad, paleta y enlaces en pestaña nueva, salvo salto al contenido. Marca de cabecera: «La Liga Hispana».
- Inscripción mantiene su acabado dorado; navegación textual con subrayado de estado. La navegación sticky recupera su fondo azul opaco, sin imagen. El panorama aparece en una franja de 220px inmediatamente debajo de la navegación, a todo el ancho y detrás de la parte superior del contenido (160px en móvil). Un único velo azul tinta se oscurece hacia abajo y funde a sólido al final de la franja. El contenido empieza a 64px bajo la navegación en escritorio (+40px frente a la vista compacta) y 36px en móvil (+24px), dejando una banda ilustrada visible. La imagen no intercepta eventos ni se fija al scroll; el resto de la página es tinta sólida y la tabla permanece opaca.

## Assets y criterio

- Escudo: `public/imagenes/portada/escudo-liga-hispana.webp`, WebP transparente 960×804px, extraído con ImageGen del material facilitado. Los textos son HTML.
- Panorama superior del contenido: `public/imagenes/portada/aoe4-hre-panorama.webp`, WebP 1920×320px (~211KB), sin transparencias, texto ni degradados integrados. Adaptación con ImageGen del [arte oficial del Sacro Imperio Romano](https://cdn.ageofempires.com/aoe/wp-content/uploads/2021/08/bg-age4-civ-hre-splash-right-desk.webp), referencia propiedad de Microsoft / World's Edge; no es el original oficial. Composición: paisaje completo, caballero y estandarte rojo a la derecha, en formato panorámico bajo. Exportado desde el generado 2172×724 con recorte vertical 90–452 y reducción a 1920×320.
- Se conserva `public/imagenes/portada/aoe4-hre-banner.webp` como referencia oficial original; no se utiliza en la franja actual.
- Se conserva `public/imagenes/portada/aoe4-delhi-banner.webp` como asset existente, sin uso en el fondo actual.
- Grano: `public/imagenes/portada/matte-grain.png`, textura mate neutra estática.
- `frontend-design`: jerarquía y tipografía de competición. `impeccable` en modo Operate: reducir ruido, conservar funciones mediante detalle y verificar estados/responsive. El encargo explícito prevalece sobre patrones cinematográficos de las skills.
