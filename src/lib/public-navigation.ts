/**
 * Los destinos públicos del sitio, en el orden en que se leen.
 *
 * `label` es el rótulo de la cabecera y el título de la página de destino;
 * `tabLabel` es la forma que cabe en la barra inferior de móvil, donde siete
 * destinos dejan muy poco ancho por columna y «Clasificación» no entra sin recortarse;
 * `homeLabel` es la forma corta que usa la cabecera de la portada, que comparte fila
 * con la marca y las acciones. El `href` y el orden son la única fuente de verdad
 * para las tres formas.
 */
export const PUBLIC_NAVIGATION = [
  {
    id: "standings",
    href: "/",
    label: "Clasificación",
    tabLabel: "Puestos",
  },
  {
    id: "matches",
    href: "/partidas",
    label: "Partidas en juego",
    tabLabel: "Partidas",
    homeLabel: "Partidas",
  },
  {
    id: "objectives",
    href: "/objetivos",
    label: "Objetivos",
    tabLabel: "Objetivos",
  },
  {
    id: "scoring",
    href: "/puntuacion",
    label: "Puntuación",
    tabLabel: "Puntos",
  },
  { id: "rules", href: "/reglas", label: "Reglas", tabLabel: "Reglas" },
  { id: "objects", href: "/objetos", label: "Objetos", tabLabel: "Objetos" },
  { id: "news", href: "/noticias", label: "Noticias", tabLabel: "Noticias" },
] as const;
