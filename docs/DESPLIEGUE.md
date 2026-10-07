# Despliegue

Cómo se publica la Liga Hispana AoE4: dónde vive cada pieza, qué dispara cada
despliegue y qué variables necesita. Lo operativo (base de datos, reloj, alertas)
está en [`docs/OPERACION.md`](./OPERACION.md).

## Resumen

| Entorno | Disparador | Comandos | URL |
|---|---|---|---|
| Producción | Push a `main` (Workers Builds) | `npx opennextjs-cloudflare build` + `npx wrangler deploy` | `https://laligahispana.es` |
| Preview | Push a una rama que no sea `main` (Workers Builds) | `npx opennextjs-cloudflare build` + `npx wrangler preview` | `<rama>-ligahispana-aoe4.javierr-ma93.workers.dev` (`noindex`) |
| Manual | A mano, con el repositorio | `npm run deploy` / `npm run preview` | — |
| CI | Pull request (GitHub Actions) | `npm run lint`, `npm run build`, `npm test` | — |

- El Worker se llama **`ligahispana-aoe4`**.
- El despliegue es **automático**: el repositorio está conectado a Workers Builds.
- `npm run deploy` es solo el camino manual, para una máquina con el repositorio.

## Partes que participan

| Pieza | Qué hace |
|---|---|
| GitHub (repo y PRs) | Código, issues y pull requests. |
| GitHub Actions | CI en cada PR (`ci.yml`) y respaldo del reloj (`cron-sync.yml`). |
| Workers Builds (Cloudflare) | Construye y despliega en cada push: `main` a producción, el resto a Preview. |
| Worker `ligahispana-aoe4` | La web (Next.js empaquetado con OpenNext). |
| Cloudflare Logs | Trazas del Worker (`observability` en `wrangler.jsonc`). |
| Hyperdrive (Cloudflare) | Pool de conexiones a Postgres delante de Supabase. |
| Custom Domain (Cloudflare) | `laligahispana.es` apuntando al Worker. |
| Supabase Postgres | Base de datos. |
| Supabase Cron (`pg_cron` + `pg_net`) | Reloj del torneo: `POST /api/sync` cada 5 minutos. |

## Canales de despliegue

### Producción

- Push a `main` → Workers Builds → build de OpenNext + `npx wrangler deploy`.
- URL pública: `https://laligahispana.es` (Custom Domain).
- Si el build falla, **producción se queda sirviendo la versión anterior** sin que la web lo diga.
- Manual: `npm run deploy` (= `opennextjs-cloudflare build` y luego
  [`scripts/deploy-worker.mjs`](../scripts/deploy-worker.mjs), que ejecuta `deploy --keep-vars`).

### Previews

- Push a una rama que no sea `main` → Workers Builds → build de OpenNext + `npx wrangler preview`.
- Un Preview es el mismo Worker en un entorno aislado: URL propia por rama, `X-Robots-Tag: noindex`,
  logs y bindings propios.
- El **build command es el mismo** que en producción (`npx opennextjs-cloudflare build`): solo cambia
  el paso de deploy. `wrangler preview` sube `.open-next/worker.js`, y ese fichero solo lo genera OpenNext.
- Límite en plan Free: 100 Previews por Worker; Cloudflare va borrando los más antiguos.
- Configuración: `previews_enabled: true` y `previews_base_config.build_command` en el panel de Workers Builds.
- El bloque `previews` de `wrangler.jsonc` es **obligatorio** (wrangler ≥ 4.135 lo exige). Declara
  `HYPERDRIVE` e `IMAGES`, porque los bindings no se heredan del nivel superior; los Cron Triggers no se replican.
- `HYPERDRIVE` del Preview apunta a la **base de producción** a propósito, para poder mirar la interfaz con
  datos reales. Consecuencia: **lo que se escriba en un Preview va a la base de producción**.
- Runtime del Preview: **sin secretos** (no hereda los del Worker). Degrada: no se detecta YouTube en
  directo, Turnstile se desactiva y `/api/cron/sync` no se autoriza. Las `NEXT_PUBLIC_*` sí llegan,
  porque Next las compila dentro del bundle.

### GitHub Actions

- [`ci.yml`](../.github/workflows/ci.yml): solo en pull requests. Dos jobs en paralelo, cada uno con su
  `npm ci` y Node 22: `verificar` (`npm run lint`, `npm run build`) y `test` (`npm test`). **No despliega.**
- [`cron-sync.yml`](../.github/workflows/cron-sync.yml): cada 5 minutos (`workflow_dispatch` para lanzarlo
  a mano). Llama a `POST $SITE_URL/api/cron/sync` con `Authorization: Bearer $CRON_SECRET`. Necesita, en el
  repositorio, la variable `SITE_URL` y el secreto `CRON_SECRET`.
- `cron-sync` es el **respaldo** del reloj. El reloj principal es Supabase Cron.

## Configuración versionada

| Archivo | Por qué está versionado |
|---|---|
| `wrangler.jsonc` | Si falta, OpenNext lo genera en cada build y `wrangler deploy` reconstruye el Worker sin las variables ni los bindings del panel. |
| `open-next.config.ts` | Igual: sin el archivo, se pierde en cada build. |
| `next.config.ts` | `outputFileTracingIncludes` mete la rama `workerd` de `pg-cloudflare` en el trace; sin ella el build muere con `Could not resolve "pg-cloudflare"`. |
| `scripts/deploy-worker.mjs` | Exporta `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` desde `.dev.vars` antes de lanzar el CLI; sin ella el deploy falla al emular Hyperdrive. |
| `prisma/schema.prisma` | `runtime = "workerd"` en el generator; sin él la base revienta en el Worker con `Wasm code generation disallowed by embedder`. |

Claves de `wrangler.jsonc`:

- `name: "ligahispana-aoe4"`, `main: ".open-next/worker.js"`, `assets`, `services`
  (`WORKER_SELF_REFERENCE`), `images` (`IMAGES`).
- `compatibility_date: "2025-03-25"`, por debajo del umbral `2025-04-01` de
  `nodejs_compat_populate_process_env`: ese flag **no** está activo. Por eso el runtime lee los bindings
  primero y `process.env` solo de reserva ([`src/lib/runtime-env.ts`](../src/lib/runtime-env.ts)). El aviso
  de Workers Builds pidiendo subir la fecha se puede ignorar; subirla es una decisión con riesgo.
- `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`.
- `triggers.crons: []`: un array vacío es lo único que borra los Cron Triggers en un deploy.
- `hyperdrive`: binding `HYPERDRIVE`, id `04fab935a8f34fce814ccebfc4301042`.
- `observability`: logs y trazas activos, muestreo al máximo (`head_sampling_rate: 1`).
- Sin bloque `routes`: el Custom Domain no se declara.
- `previews`: bloque obligatorio para `wrangler preview`.

## Del build al Worker

```
next build  →  .next/  →  OpenNext  →  .open-next/  →  wrangler deploy | preview  →  Worker
```

- OpenNext empaqueta con la condición `workerd` (esbuild con `platform: "node"` y `conditions: ["workerd"]`).
- `pg-cloudflare`: en `dependencies` (no solo como opcional de `pg`) **y** en el trace de `next.config.ts`.
- Prisma: `runtime = "workerd"` importa el `.wasm` como módulo, sin generación de código en runtime.
  `@opennextjs/cloudflare` 1.20.7 parchea los ayudantes de carga de Turbopack. Tras tocar el schema:
  `npx prisma generate` (lo hace el `postinstall`).
- Los scripts de `scripts/` corren en Node con `tsx` y cargan el WASM con
  `--import ./scripts/prisma-wasm-node.mjs`. El Worker no se ve afectado.

## Variables: los dos sitios del panel

Son **dos listas distintas y no intercambiables**:

| Sitio del panel | Quién la lee | Cuándo existe |
|---|---|---|
| Settings → Variables and Secrets (Worker) | El Worker en runtime (`ctx.env`). | Mientras el Worker esté desplegado. |
| Build variables and secrets (Workers Builds) | El proceso de build: `next build` y `npx wrangler deploy`. | Solo durante el build. |

- Hay **dos** configuraciones de build, la del trigger de `main` y la de *Previews Base*; no heredan nada
  entre ellas, así que lo que va en una va también en la otra.
- Las build variables **no** llegan a runtime, y un Preview **no** hereda los secretos del Worker.

| Variable | Worker (runtime) | Build |
|---|---|---|
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | — | Sí (obligatoria) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_SITE_URL` | — | Sí (Next las sustituye por literales al compilar) |
| `DATABASE_URL` | Sí (respaldo si no hay binding de Hyperdrive) | — |
| `CRON_SECRET`, `RATE_LIMIT_SALT`, `TURNSTILE_SECRET_KEY`, `YOUTUBE_API_KEY`, `DISCORD_*` | Sí (secretos) | Sí (por si un módulo de servidor las lee al importar) |

- `NEXT_PUBLIC_SITE_URL = https://laligahispana.es`. Si cambia el dominio, se cambia en las dos listas.
- Sin la variable de Hyperdrive en build, el `next build` termina bien y el `npx wrangler deploy` muere con
  un mensaje engañoso que habla de *developing locally*; mientras tanto, producción se queda en la versión anterior.

## Hyperdrive

| Dónde | Cadena |
|---|---|
| Configuración de Hyperdrive (runtime) | **Directa**: `db.<ref>.supabase.co:5432`, sin `?sslmode=require`. El pooling lo pone Hyperdrive. |
| Build variable del CLI (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`) | **Session pooler** (`*.pooler.supabase.com:5432`), el mismo que el `.env` local. |
| `.env` local (Next y scripts) | Session pooler: la directa es solo IPv6. |

- `src/lib/db.ts` lee `env.HYPERDRIVE.connectionString` y, si no está, cae a `DATABASE_URL`.
- Plan Free: 100.000 consultas al día.

## Dominio propio

- `laligahispana.es` es **Custom Domain** del Worker: zona `active` desde el 4 de octubre de 2026,
  certificado Let's Encrypt (se renueva solo). `www` redirige al apex y `http` a `https`.
- **No** se declara en `wrangler.jsonc`: los Custom Domains cuelgan del Worker y no son una ruta que
  `wrangler deploy` reconstruya. Declararlo solo añadiría un paso que puede tumbar un despliegue sin ganar nada.
- El apex solo tiene el `AAAA 100::` proxied que creó el Custom Domain; **no hace falta un `A`**.
- Si un visitante no entra, suele ser caché DNS antigua apuntando a la IP vieja; se resuelve sola.

### Pasos del cambio de dominio

1. `NEXT_PUBLIC_SITE_URL = https://laligahispana.es` en **las dos** configuraciones de build.
2. `SITE_URL=https://laligahispana.es npm run db:cron` (mueve el reloj al dominio).
3. `routes` en `wrangler.jsonc`: opcional, **no** se hizo.

El orden importa: primero la build variable (solo afecta a los metadatos) y después el reloj (si falla, sí se nota).

## Despliegue manual

```bash
npm run deploy     # opennextjs-cloudflare build + scripts/deploy-worker.mjs (deploy --keep-vars)
npm run preview    # opennextjs-cloudflare build + preview local
```

- `--keep-vars` evita que un despliegue borre las variables y secretos del panel.
- Los secretos van en el panel, **nunca** en `wrangler.jsonc`.
- Requiere `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` en `.dev.vars` (o en el entorno).

## Checklist

Sobre la base de datos que usa el Worker, antes de dar un despliegue por bueno:

```bash
npm run db:push                  # sincroniza el schema
npm run db:security -- --check   # RLS; obligatorio tras un db:push que añada tablas
npm run countries:seed           # lista de países del formulario de inscripción
npm run db:window                # ventana de fechas del torneo (opcional, recomendado)
npm run db:cron                  # reloj cada 5 minutos (Supabase Cron)
```

- La variable de Hyperdrive en la build del trigger, o el despliegue no publica.
- Las `NEXT_PUBLIC_*` y los secretos de servidor, en las dos listas de build.
- El detalle operativo de estos comandos está en [`docs/OPERACION.md`](./OPERACION.md#requisitos-operativos-de-un-despliegue).

## Problemas conocidos

| Síntoma | Causa |
|---|---|
| El build de Next termina y `wrangler deploy` muere pidiendo una cadena Postgres local | Falta `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` en *Build variables*. |
| La web entera da 500 con `Wasm code generation disallowed by embedder` | Falta `runtime = "workerd"` en el generator de Prisma. |
| `Could not resolve "pg-cloudflare"` al construir el Worker | Falta la rama `workerd` de `pg-cloudflare` en el trace (`outputFileTracingIncludes`). |
| `ERROR Failed to copy node_modules/{...}` en rojo | Ruido del CLI de Prisma (`devDependencies`): el build termina bien. |
| `WARN workerd compatibility_date: 2025-03-25...` | Aviso esperado; la fecha está por debajo del umbral a propósito. |
| Un Preview sin YouTube ni Turnstile, y `/api/cron/sync` sin autorizar | Un Preview no hereda los secretos del Worker (por diseño). |
| El dominio nuevo no carga para algunos visitantes | Caché DNS antigua; se resuelve sola. |
