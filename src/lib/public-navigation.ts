/**
 * Los destinos públicos del sitio, en el orden en que se leen.
 *
 * `label` es el rótulo de la cabecera y el título de la página de destino;
 * `tabLabel` es la forma que cabe en la barra inferior de móvil, donde seis
 * destinos dejan poco ancho por columna y «Clasificación» no entra sin recortarse.
 * El `href` y el orden son la única fuente de verdad para las dos formas.
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
] as const;
