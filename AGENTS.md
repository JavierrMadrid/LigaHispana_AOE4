<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# LigaHispana_AOE4 — guía del orquestador

Torneo individual de Age of Empires IV. La clasificación se calcula a partir de las partidas de los participantes obtenidas de la API de [AoE4World](https://aoe4world.com/api).

## Qué es este proyecto

- **Web** de seguimiento del torneo: clasificación, partidas en directo, streams de Twitch y panel de administración.
- **Puntuación**: se suma por **cualquier partida clasificatoria**, no solo por la ladder *ranked* 1v1. El motor de puntos (F3) define qué cuenta como clasificatoria; el esquema actual guarda `leaderboard` en cada partida para poder filtrar.
- **Fases**: el estado vive en [`docs/PLAN.md`](docs/PLAN.md). **Léelo antes de tocar nada.**

## Stack (no lo cambies sin motivo)

| Capa | Elección |
|---|---|
| Framework | Next.js 16 (App Router, `src/app`, Proxy en vez de *middleware*) + TypeScript |
| Estilos | TailwindCSS v4, tokens en `src/app/globals.css` |
| Datos | PostgreSQL en Supabase + Prisma 7 (`prisma/schema.prisma`, cliente en `src/lib/db.ts`) |
| Auth | Supabase Auth solo para admins (`src/lib/supabase/`, `src/lib/auth.ts`, `src/proxy.ts`) |
| Datos externos | API de AoE4World (rate limits: polling conservador con *backoff*) |

## Cómo trabajo: delego, con vía rápida para lo pequeño

Esta guía es la del agente `orchestrator` (`.opencode/agent/orchestrator.md`), que es el agente por defecto del repo (`default_agent` en `opencode.json`). Planifica, reparte y verifica. Puede editar código, pero solo para la **vía rápida** (abajo); el trabajo de verdad lo hacen los subagentes.

| Si el cambio toca… | Delega a | Archivo | Skills disponibles (a elección del subagente) |
|---|---|---|---|
| UI, páginas, componentes, Tailwind, estilos, copy | `@design-ux` | `.opencode/agent/design-ux.md` | `design-taste-frontend`, `frontend-design`, `impeccable` |
| Lógica, Prisma, Supabase Auth, API de AoE4World, Server Actions, workers | `@logic-data` | `.opencode/agent/logic-data.md` | `supabase`, `supabase-postgres-best-practices`, `vercel-react-best-practices` |

Las skills **no** se cargan en bloque por subagente: cada uno las elige con una tabla según lo que toca el encargo. Un cambio de despliegue, de `package.json` o de configuración no carga ninguna.

### Vía rápida (sin ceremonia)

Un cambio es **pequeño** si no toca el modelo (`prisma/`), el plan, el stack/arquitectura, las dependencias, la seguridad, la API externa, los workers ni ninguna lógica de negocio o puntuación, y además es de superficie y acotado: copy/typo, alineación o espaciado, un color de un token existente, un atributo accesible, renombrar una variable local, un comentario, un pequeño fix o responder una duda.

Esos cambios se hacen **directamente** (el orquestador, o el subagente de turno si se delega), y **sin**: cargar skills, `todowrite`, tocar `docs/PLAN.md` ni `npm run build` (`lint` solo si el cambio puede romper tipos o sintaxis). Se cierra con una línea.

Todo lo demás es **vía completa**: skills según el paso 0 de cada subagente (solo las que apliquen), ciclo de trabajo entero y `lint` + `build`.

Reglas de enrutado (vía completa):

- Ante la duda, delega: es más barato que rehacer la interfaz después.
- Un cambio que atraviesa ambas capas se parte: primero la lógica (`@logic-data`), después la UI (`@design-ux`).
- Fuera de la vía rápida, no escribas JSX ni CSS tú mismo, y no escribas schema ni queries tú mismo.
- Cada subagente se mantiene en su ámbito; si necesita algo del otro, lo pide en su informe y tú lo reencargas.
- Al cerrar la vía completa, revisa el diff completo contra las skills de diseño: si tocaste UI sin pasar por `@design-ux`, corrígelo.

## Reglas del repositorio

- **Textos en español**, sin emojis.
- Comentarios de código solo cuando explican un *porqué* no obvio.
- Nada de secretos en el código, en los logs ni en commits.
- `npm run lint` y `npm run build` deben pasar antes de dar cualquier tarea por terminada.
- No hagas commits salvo que te lo pidan explícitamente.

## Skills del proyecto

Viven en `.opencode/skills/` (scope local, versionadas). Se actualizan con `npx skills update`. Cada subagente decide cuáles carga según lo que toca el encargo; un cambio que no coincide con ninguna fila de su tabla no carga ninguna.
