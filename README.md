# LigaHispana_AOE4

Web para el seguimiento de la Liga Hispana de Age of Empires IV: torneo individual con clasificación calculada a partir de las partidas de los participantes (vía la API de [AoE4World](https://aoe4world.com/api)).

> **Puntuación**: los puntos se suman por **cualquier partida clasificatoria**, no solo por las partidas de la ladder *ranked* 1v1. El motor de puntuación (F3) decide qué cuenta como clasificatoria; por eso cada partida guarda su `leaderboard` y el JSON crudo de la API, para poder filtrar y recalcular sin volver a historicarlo.

## Stack

- **Next.js 16** (App Router) + **TypeScript** + **TailwindCSS**
- **Prisma 7** + **PostgreSQL**
- Despliegue en Vercel (o auto-host Node)

## Requisitos

- Node.js 20+ (probado con 24)
- Una base de datos PostgreSQL (ver [Base de datos](#base-de-datos))

## Puesta en marcha

```bash
npm install          # instala dependencias + genera el cliente Prisma (postinstall)
cp .env.example .env # crea tu .env local y rellena DATABASE_URL
npm run db:push      # crea las tablas en la base de datos (Supabase)
npm run dev          # arranca en http://localhost:3000
```

Otros comandos:

```bash
npm run generate   # regenera el cliente Prisma
npm run db:push    # sincroniza el schema con la BBDD (sin shadow DB, apto para Supabase)
npm run studio     # abre Prisma Studio
npm run lint       # eslint
npm run build      # build de producción
npm run sync       # sincroniza las partidas de AoE4World (ver "Sincronización")
npm run verify:sync  # comprobaciones de normalización y guardado (ver más abajo)
```

## Base de datos

Se usa **Supabase** (Postgres cloud). La conexión se define en `.env` (`DATABASE_URL`).

> **Importante**: usa el *Session pooler* (host `...pooler.supabase.com`, puerto `5432`). La conexión *direct* (`db.<ref>.supabase.co`) es solo IPv6 y suele fallar en redes IPv4.

> Nota: con Supabase no se puede usar `prisma migrate dev` (requiere crear una *shadow database*, que Supabase no permite). Por eso usamos `prisma db push` para desarrollo.

### Variables de entorno (`.env`)

| Variable | Uso |
|---|---|
| `DATABASE_URL` | Conexión PostgreSQL para Prisma |
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto Supabase (auth/API) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable de Supabase (auth/API) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Alternativa antigua a la clave publicable |
| `AOE4WORLD_API_BASE` | Base de la API de AoE4World (por defecto `https://aoe4world.com`) |
| `AOE4WORLD_API_KEY` | Opcional, para partidas privadas de AoE4World |
| `AOE4WORLD_USER_AGENT` | Cómo se identifica el worker ante la API |
| `AOE4WORLD_TIMEOUT_MS` | Timeout por petición (15000) |
| `AOE4WORLD_MAX_RETRIES` | Reintentos por petición, además del intento inicial (3) |
| `AOE4WORLD_RETRY_BASE_MS` / `AOE4WORLD_RETRY_MAX_MS` | Base y techo del *backoff* (500 / 15000) |
| `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` | Separación mínima entre peticiones (300) |
| `AOE4WORLD_SYNC_PAGE_SIZE` | Partidas por página en el histórico (50, el máximo real de la API) |
| `AOE4WORLD_SYNC_MAX_PAGES` | Páginas máximas por pasada y jugador (10 → 500 partidas) |
| `AOE4WORLD_SYNC_CONCURRENCY` | Jugadores a la vez (3) |
| `AOE4WORLD_SYNC_DEADLINE_MS` | Plazo global de una pasada (240000) |
| `CRON_SECRET` | Secreto para llamar a `POST /api/cron/sync` sin sesión |

## Sincronización con AoE4World

El worker descarga las partidas de **todos** los participantes aprobados y las guarda con deduplicación por `(playerId, gameId)`. Trae **todas** las ladders (no solo `rm_solo`): cada partida guarda su `leaderboard` y el JSON crudo de la API para que el motor de puntuación pueda filtrar y recalcular sin volver a historicarlo.

Hay un único punto de entrada, `POST /api/cron/sync` (y `GET`, porque Vercel Cron solo emite `GET`). Acepta dos formas de autenticación:

- sesión de un admin de Supabase (misma protección que el resto de `/admin`), o
- `Authorization: Bearer $CRON_SECRET` (imprescindible para un cron externo, que no manda cookies).

```bash
# Desde la terminal, sin levantar el servidor
npm run sync
npm run sync -- 4635035 8139502     # solo esos profileId

# Como route handler (mismo trabajo)
curl -X POST http://localhost:3000/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"
```

Devuelve un resumen en JSON con el detalle por jugador (partidas vistas, nuevas, actualizadas, descartadas, resueltas por refetch y abandonadas) y los contadores de la API (peticiones, reintentos, pausas por *rate limit*).

### Cadencia recomendada

**Cada 5 minutos**. La API pide uso responsable y ya ha devuelto 429; por debajo de 3 minutos el worker dispara demasiadas peticiones por minuto solo con un puñado de jugadores. Con más jugadores, sube `AOE4WORLD_MIN_REQUEST_INTERVAL_MS` antes que la frecuencia. Para F4 ("en directo") 5 minutos es suficiente: una partida en directo se detecta en la siguiente pasada y se marca con `finishedAt = null`.

### Decisiones de la fase F2

- **"Partida en directo"**: la API solo publica partidas terminadas. Una partida se considera en directo si (`ongoing === true` o `state !== "processed"`) **y** empezó hace menos de `LIVE_GAME_WINDOW_MINUTES = 60`. Se persiste con `finishedAt` y `result` a `null`; en la pasada siguiente la API ya la devuelve procesada y se actualiza.
- **Cursor de sincronización**: por jugador, en `Setting`, clave `aoe4world.sync.player.<profileId>` → `{ since, maxStartedAt, lastSyncedAt, historyTruncated, abandonedCount, abandonedGameIds, lastAbandonedAt }`. `since` es el `startedAt` más nuevo visto menos 60 min de solape, para no perder partidas que la API publica con retraso. El cursor nunca retrocede.
- **Refetch de partidas en curso**: el cursor puede dejar una partida en curso fuera del listado para siempre (si `startedAt < since`). Antes de paginar, el worker busca las partidas propias con `finishedAt IS NULL` que caigan fuera de la ventana y las refresca con `GET /players/:id/games/:game_id`. Coste habitual: 0 a 2 llamadas por jugador y pasada.
- **Partida abandonada**: si la API nunca publica el desenlace, **esa partida no cuenta nunca** (regla del torneo, ver [`docs/PLAN.md`](docs/PLAN.md)). El worker borra la fila para que F3 no pueda colarla y deja rastro en `Setting`. Nunca se resuelve como `LOSS` automáticamente.
- **Tope de histórico**: 10 páginas × 50 partidas en la primera pasada (la API nunca devuelve más de 50 por página, aunque se pidan más). Como pagina de más reciente a más antigua, el tope recorta el pasado y nunca deja sin traer partidas nuevas; `historyTruncated` deja constancia de que quedó histórico por traer.
- **`result` es nullable**: en una partida en curso el resultado todavía no existe. F3 debe puntuar solo partidas con `result` y `finishedAt`.
- **`points` se deja a 0**: los calcula el motor de F3.
- **Rival guardado**: en modos por equipos (`rm_2v2` y superiores) se guarda el primer jugador del equipo contrario, porque el schema tiene un único par de campos de rival. El equipo completo queda en `rawJson`.

### Verificación

```bash
npm run verify:sync          # normalización con datos de ejemplo (no necesita BBDD)
npm run verify:sync -- --db  # además comprueba el guardado y borra lo que crea
```

`--db` necesita `DATABASE_URL` y crea un jugador de prueba con `profileId` 9000001; si ya existe, la comprobación avisa y para. La limpieza se hace siempre, incluso si algo falla.

## Panel de administración

Acceso en `/admin`, protegido con **Supabase Auth** (cookies SSR vía `@supabase/ssr` + `src/proxy.ts`). Cualquier usuario autenticado es admin, así que **desactiva los registros públicos** en Supabase (Authentication → Sign In / Providers) y crea las cuentas a mano.

- `/login` — inicio de sesión.
- `/admin` — resumen (jugadores, aprobados, pendientes, partidas).
- `/admin/jugadores` — alta de jugadores por `profileId` de AoE4World, aprobación/rechazo y borrado.

## Modelo de datos (inicial)

- `Player`: participante (`profileId` de AoE4World, nombre, canal de Twitch opcional, estado PENDING/APPROVED/REJECTED).
- `Match`: partida de un jugador (`gameId`, `leaderboard`, resultado, civs, mapa, fechas, puntos y JSON crudo de la API). Se guardan **todas** las partidas, no solo las clasificatorias: el filtro es del motor de puntuación. La unicidad es por `(playerId, gameId)`: en un torneo individual dos participantes pueden jugar la misma partida y cada uno necesita su fila.
- `Setting`: configuración del torneo (fechas, reglas, etc.) y memoria del worker (`aoe4world.sync.player.<profileId>`).

## Estado y plan

- **Estado actual**: F0 completada (setup, Prisma, BBDD conectada y sincronizada), F1 completada (auth con Supabase + panel admin) y F2 completada (cliente de la API de AoE4World + worker de sincronización).
- **Plan completo** (roadmap, arquitectura, decisiones): ver [`docs/PLAN.md`](docs/PLAN.md).

## Agentes y skills

`AGENTS.md` es la guía del **orquestador**: contexto general del proyecto y reglas de enrutado. El trabajo se delega a dos subagentes, cada uno con su propio md y sus skills cargadas en el paso 0:

| Subagente | Ámbito | Skills |
|---|---|---|
| `@design-ux` (`.opencode/agent/design-ux.md`) | UI, componentes, Tailwind, copy | `design-taste-frontend`, `frontend-design` |
| `@logic-data` (`.opencode/agent/logic-data.md`) | Lógica, Prisma, Supabase, API de AoE4World, workers | `vercel-react-best-practices`, `supabase`, `supabase-postgres-best-practices` |

Las skills viven en `.opencode/skills/` (scope del proyecto, versionadas), no globalmente. Origen y actualización:

```bash
npx skills update                                  # actualiza las instaladas
npx skills add supabase/agent-skills --skill supabase -a opencode -y   # reinstallar o añadir
```

| Skill | Origen |
|---|---|
| `design-taste-frontend` | [leonxlnx/taste-skill](https://github.com/leonxlnx/taste-skill) |
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills) |
| `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) |
| `supabase` | [supabase/agent-skills](https://github.com/supabase/agent-skills) |
| `supabase-postgres-best-practices` | [supabase/agent-skills](https://github.com/supabase/agent-skills) |

