# Portada · Liga Hispana AoE IV

Referencia inicial: Capital Overview Dashboard, de Sourasith Phomhome. Se conserva su jerarquía compacta; la identidad medieval de Age of Empires IV define ahora el material, la tipografía y el acento.

| Elemento | Regla |
|---|---|
| Ámbito | Solo `/`, incluida cabecera y pie; otras rutas conservan su diseño |
| Fondo / panel / borde | Tinta `#090F1A` / azul heráldico `#122039` / metal azulado `#2B405D` |
| Texto principal / secundario | `#EDF1F8` / `#B6C3D6` |
| Acento | Oro `#D6B568` solo para inscripción, controles seleccionados, foco y primer puesto; rojo `#EF8D7D` para emisión |
| Tipografía | Cinzel para marca, titular y títulos de sección; Inter para filas, controles y cifras; JetBrains Mono para metadatos |
| Espaciado | Base 8px; separación 16–32px; ancho máximo 1440px |
| Radios | Paneles 6px, controles 4px; emblemas de objetivos circulares y placas de puesto con base de escudo |
| Iconos | Phosphor Icons (`@phosphor-icons/react`), peso regular; importación `/ssr` en servidor |
| Identidad | Emblema de la liga, banderas, escudos y marcas de plataformas existentes |
| Movimiento | Filas que aparecen al entrar en pantalla (340ms), objetivos (250ms) y transiciones de color/borde en controles; movimiento reducido estático |

## Composición

- Marcador: identidad alineada a la izquierda en la franja de portada, banda de estado y clasificación en un panel único.
- Banda de estado compacta en una línea en escritorio: punto rojo con la animación de `LiveDot`, «N Partidas en juego ahora», participantes, cuenta atrás y actualización. Sin subtítulo ni recuadro de icono; adapta los datos a varias líneas en pantallas estrechas. Con movimiento reducido, punto estático.
- La tabla empieza directamente en filtros; su título «Clasificación general» solo se conserva para lectores de pantalla. El enlace de puntuación permanece en el pie.
- Orden: selector nativo con flecha Phosphor superpuesta sin eventos y 36px de espacio reservado; dirección independiente.
- Inscripción de cabecera (`home-signup-gold`): oro metálico con arista iluminada y halo discreto; un reflejo al pasar/enfocar, estático con movimiento reducido. Los demás botones primarios conservan su acabado habitual.
- Franja heráldica de 236px en escritorio: escudo transparente de 196px de alto junto al título «Liga Hispana» en Cinzel, «Age of Empires IV» y una línea descriptiva en HTML. Identidad a la izquierda; paisaje del Sultanato de Delhi y elefante a la derecha, con fundido azul gradual, profundidad estática y marco metálico fino. En móvil se apila, con escudo de 144px de alto, texto centrado y paisaje más tenue. Cabecera y pie conservan sus emblemas actuales; la marca de la cabecera dice «La Liga Hispana».
- Fondo con grano mate fino y luz azul grisácea estática de baja intensidad. Paneles neutros: sin baños dorados ni texturas amarillas.
- Podio: oro, plata y bronce; primera fila con superficie neutra más clara y filete dorado estrecho. Emblemas de división grandes y objetivos con medallón de metal neutro.
- Variante de revisión: `/?concept=hub` añade líderes y mayor presencia de identidad; solo en desarrollo.
- Filtros con etiquetas visibles e iconos de partida/emisión; leyenda «Filtros de estado». Controles de 44px y texto de 14px; recuento y orden separados.
- Escritorio: filas uniformes de 80px y separación de 5px; nombre a 17px (truncado con nombre completo accesible), puntos a 28px y desglose textual. Fichas móviles/tablet de 232px, sin cambios de altura por emisión o podio.
- Móvil y tableta: fichas de competición de 232px de alto, con puesto, identidad, puntos y métricas legibles, sin desplazamiento horizontal de página.
- Filtros combinables: nombre/canal, división, en partida y en directo; limpiar filtros explícitamente.
- División: lista accesible con iconos oficiales en opciones y selección; flechas, Inicio/Fin, Escape y tabulador.
- Foco: una sola señal en el contenedor de búsqueda y en los controles; nunca un segundo contorno interior.
- Bandera: junto al nombre y en un único lienzo decorativo por fila. SVG con proporción natural pegado a la derecha; una franja de 1px de su borde izquierdo se prolonga mediante transformación para igualar sus colores. Velo y máscara suavizan el conjunto. En móvil, motivo centrado de 140px de alto. Nunca estirar el SVG ni pintarlo por celda.
- Elo: emblema junto a la cifra en una fila centrada bajo su cabecera, sin nombre de división visible; el nombre se conserva en la ayuda al pasar el ratón. Espacio fijo para el emblema incluso cuando no hay clasificación. Derrotas y rachas negativas en rojo.
- Objetivos e indicador «En partida»: comparten `HomeObjectiveHelp` por hover, foco o toque; Escape cierra la ayuda. Un provider de portada permite una sola ayuda activa: al entrar, enfocar o pulsar otra, cierra la anterior y cancela su espera. Conserva 160ms de salida para alcanzar el tooltip con el puntero. El estado conserva su punto de 10px, con botón accesible de 24px y tooltip de ancho natural, sin ayuda nativa de `title`.
- Tarjetas de objetivos desplegados: el botón y el área de ayuda ocupan toda la tarjeta, incluidos borde y espaciado. Fondo con transición de 200ms al pasar el ratón o enfocar con teclado; sin transición con movimiento reducido.
- Enlaces de portada en pestaña nueva, salvo el salto al contenido de la misma página.
- Fuera de `?preview=stress`, nunca inventar resultados, gráficos u horas de sincronización. Una lectura fallida muestra un aviso sin recuentos falsos.
- Previsualizaciones de desarrollo: `?preview=loading`, `empty`, `unavailable` y `live`; no escriben en la base.
- Paginación de 25 jugadores: buscar, filtrar y ordenar en la colección completa antes de dividirla; esas acciones vuelven a página 1. Controles de primera/anterior/siguiente/última y rango anunciado.
- `?preview=stress`: 1.500 jugadores ficticios deterministas, con 25 filas en el HTML inicial y por página; la página omite lecturas de clasificación. Incluye una franja de estado ficticia según [la simulación documentada](docs/OPERACION.md#carga-de-1500-participantes-en-la-portada). Un único `IntersectionObserver` por página revela las filas en ambos modos. HTML inicial y ausencia de JavaScript siguen siendo legibles; el foco revela inmediatamente.
- Sin importes de premios inventados, etiquetas de muestra ni indicadores de desarrollo visibles; la portada no muestra un bloque de premios hasta disponer de información publicada.
- Navegación de portada: texto sin iconos ni fondos; subrayado dorado al pasar y en la ruta activa. Alineada hacia inscripción; el acceso de organización vive solo en el pie.
- `stress` conserva sus datos ficticios y páginas de 25, pero usa la presentación habitual sin avisos, rótulos de prueba ni etiquetas de muestra visibles.

## Detalles independientes

- `home-row-glow` / `home-pointer-row`: luz interior de 100px y tramo de borde de 120px próximos al puntero, con coordenadas de la fila, variables CSS y `requestAnimationFrame`; nunca en cabecera, filtros ni paginación. Sin estado React por movimiento, desactivada para tacto/movimiento reducido.
- Canales de portada: `ChannelLinks.animateLive` pinta gris sin emisión y en el color de plataforma con un pulso luminoso de 3s cuando está en directo; el estado se anuncia en el nombre accesible y el título. Movimiento reducido conserva una luz estática. Las demás rutas mantienen su comportamiento.
- `home-heraldic-frame`: esquinas finas del marco ilustrado.
- `home-row-outline`: contorno permanente por encima de las banderas, independiente del halo de puntero.
- `home-focus-command`: borde de fila y placa de puesto que acompañan el foco de teclado.

## Criterio de las skills

- `gpt-taste`: contraste, encabezados legibles, interacción y revisión visual.
- `frontend-design`: jerarquía y lenguaje propios de una competición.
- El encargo explícito prevalece sobre patrones cinematográficos, GSAP y fuentes predeterminadas de las skills.
- La referencia visual pegada por el usuario guía la jerarquía heráldica y el azul real; no se copia ni se sirve como imagen del sitio.

## Ilustración

- Escudo de portada: `public/imagenes/portada/escudo-liga-hispana.webp`, WebP transparente de 960×804px (~295KB). Extraído del banner facilitado por el usuario con ImageGen; conserva los caballeros, globo, corona y cinta «Liga Hispana». Los textos de presentación se componen en HTML.
- Fondo de portada: `public/imagenes/portada/aoe4-delhi-banner.webp`, WebP de 1920×823px (~145KB), decorativo y sin precarga; el escudo conserva su precarga.
- Grano mate: `public/imagenes/portada/matte-grain.png`, textura procedural neutra de 96px (~10KB), sin movimiento.
- Fuente oficial del paisaje: [Age of Empires IV](https://www.ageofempires.com/games/age-of-empires-iv/), ilustración del Sultanato de Delhi.
- [Original de la ilustración](https://www.ageofempires.com/wp-content/themes/ageOfEmpires/public/images/bgs/del-splash-4k.23350b.webp).
- Arte del paisaje propiedad de Microsoft / World's Edge. La liga es una competición comunitaria no oficial y no afirma afiliación.
