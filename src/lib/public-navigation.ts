export const PUBLIC_NAVIGATION = [
  {
    id: "standings",
    href: "/",
    label: "Clasificación",
    tabLabel: "Clasificación",
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
] as const;
