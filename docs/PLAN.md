# Plan de desarrollo — LigaHispana_AOE4

Seguimiento de la Liga Hispana de Age of Empires IV. Torneo **individual** con clasificación calculada a partir de las partidas de los participantes, obtenidas de la API de [AoE4World](https://aoe4world.com/api).

> **Regla de puntos**: puntúa **cualquier partida clasificatoria**, no solo la ladder *ranked* 1v1 (`rm_solo`). Por eso `Match` guarda `leaderboard` y `rawJson`: el motor de F3 filtra y puede recalcular sin volver a pedir todo el histórico a la API. `rm_solo` es el valor por defecto porque hoy es el caso mayoritario, no porque sea el único válido.

## Referencia funcional: ordreduwololo.fr

Ya existe un sitio que resuelve un problema muy parecido: [ordreduwololo.fr/challenges](https://ordreduwololo.fr/challenges). Es la **guía funcional** para este proyecto, con dos diferencias: aquí el torneo es **individual** (no por equipos) y las reglas/objetivos de puntuación cambian.

Cómo leer esa referencia:

- **Nivel de comportamiento**: qué pantallas existen, qué información se muestra y en qué momento. La web debe funcionar "de forma muy similar" a celle-là.
- **Nivel visual**: explícitamente **no** es referencia. El diseño propio se decide en F4/F7 aplicando las skills de diseño del repo.

De ella se derivan los requisitos que ya estructuran las fases: clasificación siempre actualizada, listado de partidas en curso con participantes del torneo, y streams de Twitch de los participantes que estén en directo.

## Decisiones de stack

| Área | Decisión | Motivo |
|---|---|---|
| Frontend + Backend | **Next.js 16** (App Router) + TypeScript | Un solo lenguaje, SSR/ISR, API routes, despliegue fácil en Vercel |
| Estilos | TailwindCSS v4 | Incluido por defecto en create-next-app |
| BBDD | **PostgreSQL** vía **Supabase** (cloud) | Relacional, encaja con el modelo; Supabase gratis + auth integrada |
| ORM | **Prisma 7** (`prisma-client`) | Tipado, migraciones; schema en `prisma/schema.prisma` |
| Auth | **Supabase Auth** (solo admin) | Ya tenemos proyecto Supabase; `@supabase/ssr` para sesiones en Next |
| Tareas en segundo plano | Cron (Vercel Cron o `node-cron`) | Polling periódico de la API de AoE4World |
| Twitch | Helix API (requiere app registrada) | Detectar streamers en directo |

## Estado actual

### F0 — Setup ✅

- [x] Scaffold Next.js 16.3.6 + TS + Tailwind (App Router, `src/`)
- [x] Prisma 7.10.0 instalado; config en `prisma7.config.ts`
- [x] Schema inicial (`Player`, `Match`, `Setting`) en `prisma/schema.prisma`
- [x] Cliente generado en `src/generated/prisma` (import: `@/generated/prisma/client`)
- [x] Supabase: `DATABASE_URL` (session pooler, IPv4) + claves `NEXT_PUBLIC_*`
- [x] Tablas creadas en Supabase vía `npm run db:push`
- [x] `lint` y `build` pasan sin errores
- [x] README actualizado

### F1 — Auth + panel admin ✅
- [x] `@supabase/ssr` + cliente Prisma con driver adapter (`@prisma/adapter-pg`)
- [x] Helpers de Supabase: `src/lib/supabase/{env,server,proxy}.ts`
- [x] `src/proxy.ts` (antes *middleware* en Next 16): refresca la sesión y protege `/admin`
- [x] DAL de auth: `requireAdmin()` en `src/lib/auth.ts` (verificación segura con `auth.getUser()`)
- [x] `/login` con Server Action (`useActionState`) y logout
- [x] `/admin`: resumen con contadores y aviso de pendientes
- [x] `/admin/jugadores`: alta por `profileId`, aprobar/rechazar/eliminar
- [x] Ampliar el modelo de datos (objetivos, snapshot de clasificación) — se hace en F3

Decisión: todo usuario autenticado es admin → **registros públicos de Supabase desactivados**; las cuentas se crean a mano.

### F2 — Integración AoE4World + worker de polling ✅

- [x] Cliente HTTP tipado en `src/lib/aoe4world/` con **único punto de salida** (`http.ts`): timeout, cancelación, separación mínima entre peticiones, *backoff* exponencial con jitter y respeto de `Retry-After` / `X-RateLimit-*`.
- [x] `unknown` + validación en la frontera (`parse.ts`): sin `any` ni casteos ciegos; un payload raro se descarta, no se guarda.
- [x] Endpoints tipados: perfil, partidas (paginado + `since`), partida concreta, leaderboard (hasta 50 ids) y autocomplete.
- [x] Normalización a `Match` en `normalize.ts`, con `leaderboard` + `rawJson` para que F3 pueda filtrar y recalcular.
- [x] Worker `syncApprovedPlayers()`: una pasada por jugador aprobado, concurrencia limitada, un fallo no tumba el lote y todo queda resumido en JSON.
- [x] Punto de entrada único `POST|GET /api/cron/sync`, con sesión de admin **o** `Authorization: Bearer $CRON_SECRET`.
- [x] `npm run sync` (CLI) y `npm run verify:sync` (comprobaciones con datos de ejemplo, con `--db` para el guardado).
- [x] Cero de la API, tabla de rate limit y `Setting` por jugador (`aoe4world.sync.player.<profileId>`).

Decisiones de F2 que condicionan F3/F4:

- **Partida en directo**: (`ongoing === true` o `state !== "processed"`) **y** `started_at` de hace menos de `LIVE_GAME_WINDOW_MINUTES = 60`. Se guarda con `finishedAt` y `result` a `null`. F4 debe listar por `finishedAt IS NULL`.
- **`result` pasa a ser nullable** (`prisma/schema.prisma`): en una partida en curso el resultado no existe todavía. F3 puntúa solo partidas con `result` y `finishedAt` informados.
- **La unicidad de `Match` pasa a `(playerId, gameId)`** (antes `gameId` a secas): dos participantes del torneo pueden jugar la misma partida y cada uno necesita su fila con su resultado, civ y puntos. Con la unicidad global, la fila del segundo jugador se perdía en silencio.
- **Cursor incremental**: `since` = `startedAt` más nuevo visto − 60 min de solape, guardado en `Setting` por jugador. El cursor nunca retrocede.
- **Refetch de partidas en curso**: el cursor puede dejar fuera del listado una partida en curso (si `startedAt < since`, es decir, más de 60 min antes de la partida más nueva del jugador). Antes de paginar, el worker pide las partidas propias con `finishedAt IS NULL` que caigan fuera de la ventana y las refresca una a una con `GET /players/:id/games/:game_id`. Sin esto, una partida en curso podía quedarse sin resolver para siempre. El conjunto afectado suele ser de 0 a 2 filas, así que el coste es de 0 a 2 llamadas por jugador y pasada.
- **Histórico**: 10 páginas × 50 partidas por pasada y jugador (configurable). La API nunca devuelve más de 50 partidas por página, aunque se le pidan más, y pagina de más reciente a más antigua: el tope recorta el pasado y nunca deja sin traer partidas nuevas.

### Reglas de datos que heredan F3 y F4

> **Regla: una partida abandonada nunca cuenta.** Si la API no publica el desenlace de una partida (el jugador se desconectó, la partida se colgó, o la API simplemente nunca la procesa), esa partida **no suma ni resta nunca** para la clasificación. No se resuelve como `LOSS` automáticamente ni bajo ninguna circunstancia.

Cómo lo materializa F2:

- Una partida cuenta solo si tiene `result` (`WIN`/`LOSS`) **y** `finishedAt`. Son las dos condiciones que F3 debe filtrar.
- Cuando el refetch confirma que una partida en curso ya no va a resolverse (la API sigue diciendo `ongoing`/`state !== "processed"` pasadas las 60 min, o devuelve 404), **se borra la fila**. No se deja con `finishedAt = null` para siempre, porque `finishedAt = null` significa "en curso" para F4 y una fila sin resolver sería indistinguible de una partida viva: F3 podría colarla por error.
- Cada borrado se anota en `Setting`, clave `aoe4world.sync.player.<profileId>`, campos `abandonedCount`, `abandonedGameIds` (últimos 20) y `lastAbandonedAt`. Es solo rastro: no puntúa nada, pero hace la decisión auditable.
- El resumen del worker expone `resolvedByRefetch` y `abandonedMatches`, y cada descarte se escribe en el log con el motivo.

Consecuencia para F4: una partida en directo que se abandona desaparece de la lista al cabo de ~60 min, no se queda colgada para siempre. Es intencionado.

Consecuencia para F3: no hace falta que F3 regurgite partidas abandonadas porque no existen en la tabla. Aun así, el filtro `(result IS NOT NULL AND finishedAt IS NOT NULL)` debe seguir presente: es la garantía de que una partida en curso nunca puntúa.

Detalles de la API comprobados al implementar (no están en su documentación):

- `/leaderboards/:ladder?profile_id=1,2` acepta **varios ids separados por comas**. Mandar el parámetro repetido (`?profile_id=1&profile_id=2`) no da error pero solo devuelve el último jugador.
- `/players/:id/games?limit=N` devuelve como máximo 50 partidas (`per_page: 50`), en silencio.
- `teams` viene anidado (`{ player: {...} }`) en la lista y plano en el detalle de una partida; ambos se leen.
- La API no manda `finished_at`: se deriva de `started_at + duration`.

## Arquitectura

```
AoE4World API ──poll──► Worker/Cron ──► PostgreSQL (Supabase)
                                          │
                                          ▼
                              API propia (Next.js) ──► Frontend (React)
                                                       ├─ Clasificación
                                                       ├─ Partidas en vivo
                                                       ├─ Streams Twitch (embeds)
                                                       └─ Panel admin (Supabase Auth)
```

## Modelo de datos (schema actual)

```
Player     (id, profileId unico, name, twitchChannel?, status: PENDING|APPROVED|REJECTED, timestamps)
Match      (id, [playerId, gameId] unico, playerId FK, opponentProfileId?, opponentName?,
            civ?, opponentCiv?, map?, leaderboard="rm_solo", result?: WIN|LOSS (null = sin resolver),
            startedAt, finishedAt?, durationSeconds?, points, rawJson, createdAt)
Setting    (key PK, value JSON, updatedAt)
```

Notas:
- `gameId` se guarda como `String` y la unicidad es **por jugador** (`@@unique([playerId, gameId])`): el torneo es individual y dos participantes pueden jugar la misma partida, cada uno con su propio resultado y sus puntos.
- `rawJson` conserva la partida completa de la API para poder recalcular puntos si cambian las reglas.
- Se guardan **todas** las partidas del jugador, no solo las clasificatorias: el filtro por `leaderboard` y por fecha lo hace el motor de F3. Así también salen las "partidas en directo" (F4) del mismo histórico.
- `leaderboard` es una `String` (no enum) precisamente para no tener que migrar cada vez que aparece un modo de juego nuevo en la API.
- `result` admite `null`: significa que la partida aún no está resuelta por la API. F3 no debe puntuar esas filas.
- El motor de puntuación (F3) amplía este modelo con el agregado versionado (`PlayerScore`) y los snapshots (`ScoreSnapshot`). El diseño completo está en [`docs/MODELO-DATOS.md`](MODELO-DATOS.md); aún no está aplicado al schema.

## Integración con AoE4World

Endpoints relevantes:

| Endpoint | Uso |
|---|---|
| `GET /api/v0/players/:profile_id` | Perfil y stats del jugador |
| `GET /api/v0/players/:profile_id/games` | Partidas (pag `page`/`limit`, filtro `since`; `leaderboard` opcional para acotar) |
| `GET /api/v0/players/:profile_id/games/:game_id` | Partida concreta (detalle) |
| `GET /api/v0/players/autocomplete?leaderboard=rm_solo&query=...` | Búsqueda de jugador |
| `GET /api/v0/leaderboards/:leaderboard?profile_id=...` | Leaderboard (hasta 50 ids) |

Consideraciones:
- **Rate limits**: la API pide uso responsable (hemos visto 429). Polling conservador (cada 2–5 min), con caché y *backoff*. Implementado en F2: separación mínima entre peticiones, *backoff* con jitter y pausa global cuando la API dice `Retry-After` o `X-RateLimit-Reset`.
- **Partidas en vivo**: la API devuelve partidas terminadas. "En directo" se infiere de `ongoing`/`state` más una ventana de 60 minutos (ver F2 en "Estado actual").
- **Puntuación**: no existe en AoE4World; se calcula y guarda en local (F3).
- **Campos útiles en la respuesta**: además de `leaderboard` y `kind`, la API devuelve `ongoing`, `just_finished`, `state`, `duration`, `average_mmr` y los equipos con `result`, `civilization`, `rating` y `mmr` por jugador. Todo eso queda en `rawJson` para F3.

## Roadmap

### F1 — Auth + panel admin ✅ (ver "Estado actual")

### F2 — Integración AoE4World + worker de polling ✅ (ver "Estado actual")

### F3 — Motor de puntuación — **diseño hecho, pendiente de que el cliente lo valide**

- [x] Reglas de puntuación v1 adaptadas a individual: [`docs/PUNTUACION.md`](PUNTUACION.md)
- [x] Modelo de datos completo derivado de esas reglas: [`docs/MODELO-DATOS.md`](MODELO-DATOS.md)
- [ ] Cliente valida y cierra las 16 decisiones abiertas de `PUNTUACION.md` §10 (y las P-01 a P-06 de `MODELO-DATOS.md` §9.1)
- [ ] Confirmar contra la API los nombres exactos de los modos de juego (D-01)
- [ ] Publicar el ruleset v1 y arrancar el motor
- [ ] Motor: agregados incrementales, reparto de premios por puesto, recálculo completo al cambiar de versión
- [ ] Persistencia de la clasificación y de los snapshots

Ver `docs/MODELO-DATOS.md` §9.3 para qué bloquea y qué no.

### F4 — Frontend público
- Clasificación en vivo.
- Partidas en directo.
- Página por jugador.

### F5 — Twitch
- Registro de app en Twitch (Client ID/Secret).
- Helix API para detectar streamers en directo + embeds.

### F6 — Registro público
- Formulario de inscripción (perfil AoE4World + Twitch opcional) → estado `PENDING` → aprobación admin.

### F7 — Reglas reales + pulido
- Definir objetivos/reglas del torneo y conectarlos al motor.
- Pulido visual (aplicando las skills de diseño instaladas).

## Requisitos del cliente (frozen)

Vienen del encargo inicial. Si alguno cambia, se actualiza esta sección antes de tocar el código.

1. **Torneo individual**: todos los jugadores apuntados juegan partidas clasificatorias y suma el **mayor número de puntos**; no hay equipos.
2. **Clasificación siempre actualizada** ("en todo momento"): la tabla de puntos refleja el estado real sin que el usuario tenga que recargar a mano.
3. **Partidas en directo**: listar las partidas que se estén jugando en ese momento en las que participa alguien del torneo.
4. **Streams**: si un participante tiene canal de Twitch enlazado y está en directo, la web lo muestra.

## Decisiones pendientes

- [ ] **Qué cuenta como partida clasificatoria** y cómo se punctúa. Es una decisión del cliente, no técnica. **Resuelto el 27/09/2026 como diseño**: `docs/PUNTUACION.md` define la v1 (base Wololo adaptada a individual, 5 categorías, techo 109) y deja 16 decisiones abiertas con su recomendación por defecto. Pendiente de que el cliente lo valide. Mientras tanto F2 guarda todo y `points` está a 0 en todas las filas, así que las reglas se pueden cambiar sin volver a pedir nada a la API.
- [ ] Fecha/ventana de clasificatorias. Resuelto en diseño: vive en la versión de las reglas (`Setting`) y se ancla en `startedAt`. Falta que el cliente ponga las fechas (D-02 de `PUNTUACION.md`).
- [ ] Cómo se cumple el requisito 2 ("en todo momento"): el worker de F2 corre cada 5 minutos; queda decidir si F4 revalida el server con esa cadencia o hace polling en cliente.
- [ ] Rival en partidos por equipos: el schema tiene un único par de campos, así que en `rm_2v2` y superiores se guarda solo el primer jugador del equipo contrario (el equipo completo está en `rawJson`). Si las reglas necesitaran "partida contra dos rivales", habría que añadir columnas.

## Consideraciones técnicas / riesgos

- **Next.js 16**: breaking changes respecto a versiones anteriores. Revisar docs en `node_modules/next/dist/docs/` antes de programar.
- **Supabase + migraciones**: no soporta *shadow database* → usamos `db push` en dev (en producción convendrá `prisma migrate` con cadena directa o revisar estrategia).
- **Prisma 7**: usa `prisma7.config.ts`, generador `prisma-client` (ESM), carga `DATABASE_URL` desde `.env` vía `dotenv/config` y requiere *driver adapter* (`@prisma/adapter-pg`) para instanciar el cliente (`src/lib/db.ts`).
- **Next.js 16**: *middleware* → **Proxy** (`src/proxy.ts`). Los helpers de tipos `LayoutProps<"/ruta">` se generan con `next dev/build/typegen`.
- **Supabase Auth**: sesiones en cookies SSR; el Proxy refresca el token y aplica las cabeceras anti-caché, el DAL hace la verificación segura.
- **Rate limits AoE4World**: resueltos en F2 (backoff exponencial con jitter, separación mínima entre peticiones, pausa global ante `Retry-After`). Pendiente solo el ritmo del cron en producción y si hace falta cacheo.
