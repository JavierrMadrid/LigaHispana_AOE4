# Despliegue

Cómo se publica la Liga Hispana AoE4: dónde vive cada pieza, qué dispara cada
despliegue y qué variables necesita. Lo operativo (base de datos, reloj, alertas)
está en [`docs/OPERACION.md`](./OPERACION.md).

## Resumen

| Entorno | Disparador | Comandos | URL |
|---|---|---|---|
| Producción | Push a `main` (Workers Builds) | `npx opennextjs-cloudflare build` + `npx wrangler deploy` | `https://laligahispana.es` |
| Preview | Push a una rama que no sea `main` (Workers Builds) | `npx opennextjs-cloudflare build` + `npx wrangler preview` | `<rama>-ligahispana-aoe4.laligahispana.workers.dev` (`noindex`) |
| Desarrollo | `npm run dev` en local | `next dev` | `http://localhost:3000` |
| Manual | A mano, con el repositorio | `npm run deploy` / `npm run preview` | — |
| CI | Pull request (GitHub Actions) | `npm run lint`, `npm run build`, `npm test` | — |

Producción y desarrollo son **proyectos Supabase distintos**. Los Previews y `next dev` usan el proyecto de desarrollo; solo el Worker de producción usa el de producción. El detalle de variables y Hyperdrive está más abajo.

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
| Supabase Auth | Cuentas del panel. El **Site URL** y las **plantillas de correo** (Authentication → URL Configuration / Email Templates) deciden a dónde llevan los correos de invitación y recuperación. |
| Supabase Cron (`pg_cron` + `pg_net`) | Reloj del torneo: `POST /api/sync` cada 10 minutos. |

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
- `HYPERDRIVE` del Preview apunta a la **base de desarrollo** (`ligahispana-aoe4-dev`, id
  `9ee4c8de68e240dba17bd2aba2a0880e`). Producción y desarrollo son proyectos Supabase distintos:
  **lo que se escriba en un Preview va a desarrollo**, nunca a producción.
- Todos los Previews comparten la base de desarrollo. Es desechable: se rellena con
  `npm run mock:tournament` y se resetea cuando haga falta. Los cambios de schema se aplican a mano
  con `npm run db:push` antes de probar la rama.
- Runtime del Preview: recibe la configuración **Previews Base** de Workers Builds, con las claves y
  secretos de desarrollo (`SUPABASE_SERVICE_ROLE_KEY`, `SUPERADMIN_EMAIL`, `RATE_LIMIT_SALT`). No
  hereda los secretos del Worker de producción. Sin `CRON_SECRET`, `DISCORD_*`, `YOUTUBE_API_KEY` ni
  `TURNSTILE_SECRET_KEY` de producción: degrada sin ellos.
- Las `NEXT_PUBLIC_*` se compilan dentro del bundle. Cambiarlas exige un build nuevo, y los Previews
  ya existentes **no se actualizan solos**: hay que redesplegarlos o borrarlos.
- **Estado actual (23-oct-2026)**: la creación automática de Previews está desactivada
  (`previews_enabled: false`) hasta que el cambio de `previews.hyperdrive` esté en `main`. Si no, una
  rama sin ese cambio usaría el Hyperdrive de producción con el Auth de desarrollo. El Preview manual
  de `feat/143-entorno-pruebas` sigue vivo; se reactiva al mergear el cambio.

### GitHub Actions

- [`ci.yml`](../.github/workflows/ci.yml): solo en pull requests. Dos jobs en paralelo, cada uno con su
  `npm ci` y Node 22: `verificar` (`npm run lint`, `npm run build`) y `test` (`npm test`). **No despliega.**
- [`cron-sync.yml`](../.github/workflows/cron-sync.yml): cada 10 minutos (`workflow_dispatch` para lanzarlo
  a mano). Llama a `POST $SITE_URL/api/cron/sync` con `Authorization: Bearer $CRON_SECRET`. Necesita, en el
  repositorio, la variable `SITE_URL` y el secreto `CRON_SECRET`.
- `cron-sync` es el **respaldo** del reloj. El reloj principal es Supabase Cron.

## Configuración versionada

| Archivo | Por qué está versionado |
|---|---|
| `wrangler.jsonc` | Si falta, OpenNext lo genera en cada build y `wrangler deploy` reconstruye el Worker sin los bindings ni el `observability` del panel, y sin el `keep_vars` que conserva las `vars` de texto. |
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
- `keep_vars: true`: las `vars` de texto del panel sobreviven al despliegue (los secretos, siempre).
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

- Hay **dos** configuraciones de build, la del trigger de `main` (producción) y la de *Previews Base*
  (desarrollo). No heredan nada entre ellas: cada una tiene su propia lista.
- Las build variables **no** llegan a runtime, y un Preview **no** hereda los secretos del Worker.

La tabla siguiente es la de **producción**:

| Variable | Worker (runtime) | Build |
|---|---|---|
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | — | Sí (obligatoria, solo para la emulación del CLI) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `NEXT_PUBLIC_SITE_URL` | — | Sí (Next las sustituye por literales al compilar) |
| `DATABASE_URL` | Sí (respaldo si no hay binding de Hyperdrive) | — |
| `CRON_SECRET`, `RATE_LIMIT_SALT`, `TURNSTILE_SECRET_KEY`, `YOUTUBE_API_KEY`, `DISCORD_*` | Sí (secretos) | Sí (por si un módulo de servidor las lee al importar) |
| `SUPERADMIN_EMAIL` | Sí (texto) | — |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí (secreto) | Sí (por si un módulo de servidor la lee al importar) |

- `NEXT_PUBLIC_SITE_URL = https://laligahispana.es`. Si cambia el dominio, se cambia en las dos listas.
- `DISCORD_ANNOUNCE_CHANNEL_ID` y `DISCORD_PARTICIPANT_ROLE_ID` son **ids, no secretos**: van en la
  lista del Worker como variables de **texto** (y por tanto solo sobreviven a un despliegue con
  `keep_vars`, ver abajo). Los demás `DISCORD_*` son secretos. El resto de la configuración del bot
  está en [`OPERACION.md`](./OPERACION.md#discord).
- Sin la variable de Hyperdrive en build, el `next build` termina bien y el `npx wrangler deploy` muere con
  un mensaje engañoso que habla de *developing locally*; mientras tanto, producción se queda en la versión anterior.

### Previews Base (desarrollo)

| Variable | Dónde | Valor |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Build | Proyecto Supabase de desarrollo. |
| `NEXT_PUBLIC_SITE_URL` | Build | `https://laligahispana.es` (los enlaces absolutos no cambian). |
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | Build (secreto) | Cadena de emulación de desarrollo; el CLI solo comprueba que exista, no conecta con ella. |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPERADMIN_EMAIL`, `RATE_LIMIT_SALT` | Secretos base de Previews (runtime) | Proyecto Supabase de desarrollo. |

- **No** se configuran en Previews Base `DATABASE_URL`, `CRON_SECRET`, `DISCORD_*`, `YOUTUBE_API_KEY`
  ni `TURNSTILE_SECRET_KEY` de producción. Sin ellos el Preview degrada: no manda a Discord, no
  detecta YouTube, desactiva Turnstile y `/api/cron/sync` no se autoriza.
- Las `NEXT_PUBLIC_*` son de build: cambiarlas exige un build nuevo. Los Previews ya existentes no se
  actualizan solos; hay que redesplegarlos o borrarlos.
- En local, `.env.local` apunta al proyecto de desarrollo. Las credenciales de producción no se cargan
  en `next dev` ni en los scripts diarios; para operar contra producción se exportan de forma explícita.

### Qué sobrevive a un despliegue

`wrangler deploy` (y `wrangler versions upload`) toman `wrangler.jsonc` como **fuente de verdad** de la
configuración, como un fichero de Terraform: por defecto las `vars` de texto del panel **se borran** y
solo quedan las declaradas en el archivo. Como `wrangler.jsonc` **no** tiene bloque `vars`, sin
protección quedan cero.

| Tipo en el panel | ¿Sobrevive a un despliegue? |
|---|---|
| Variable de **texto** (`vars`) | Solo con `keep_vars: true`, ya activo en `wrangler.jsonc`. |
| **Secreto** (`secret`) | **Siempre**: un despliegue nunca borra secretos. |

- Workers Builds ejecuta `npx wrangler deploy` **sin** `--keep-vars`: la protección depende del
  `keep_vars` del archivo. `npm run deploy` pasa `--keep-vars`, que equivale a `keep_vars: true`.
- Un despliegue sin `keep_vars` y sin `--keep-vars` es el que dejó al Worker sin las credenciales de
  Discord en octubre de 2026 (ver [Problemas conocidos](#problemas-conocidos)).

## Hyperdrive

Hay **dos** configuraciones, una por proyecto:

| Configuración | Proyecto | ID | La usa |
|---|---|---|---|
| `ligahispana-aoe4-db` | Producción | `04fab935a8f34fce814ccebfc4301042` | `hyperdrive` del nivel superior (Worker de producción). |
| `ligahispana-aoe4-dev` | Desarrollo | `9ee4c8de68e240dba17bd2aba2a0880e` | `previews.hyperdrive` (Previews). |

| Dónde | Cadena |
|---|---|
| Configuración de Hyperdrive (runtime) | **Directa**: `db.<ref>.supabase.co:5432`, sin `?sslmode=require`. El pooling lo pone Hyperdrive. |
| Build variable del CLI (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`) | **Session pooler** (`*.pooler.supabase.com:5432`) del entorno que se esté construyendo. El CLI solo comprueba que exista. |
| `.env.local` (Next y scripts) | Session pooler del proyecto de **desarrollo**: la directa es solo IPv6. |

- `src/lib/db.ts` lee `env.HYPERDRIVE.connectionString` y, si no está, cae a `DATABASE_URL`.
- Los Previews no tienen `DATABASE_URL`: si el binding de desarrollo falla, fallan en vez de caer a producción.
- Plan Free: 100.000 consultas al día **por cuenta**, compartidas por producción y desarrollo.

### Caché de consultas: desactivada a propósito

- Las dos configuraciones, `ligahispana-aoe4-db` (producción) y `ligahispana-aoe4-dev` (desarrollo),
  tienen la caché de consultas **desactivada** (`caching.disabled: true`), no por defecto.
- Porqué: este panel lee inmediatamente después de escribir (aprobar, editar, borrar) y Hyperdrive
  **no invalida** las lecturas cacheadas cuando la aplicación escribe. Con la caché activa
  (`max_age` 60 s, `stale_while_revalidate` 15 s), la relectura del propio action y el re-render de
  `/admin` seguían viendo el estado anterior hasta 60-75 s: la interfaz mostraba el estado viejo, el
  botón parecía muerto y cada clic repetía la acción (el historial de acciones acumulaba aprobaciones
  repetidas).
- El *pool* de conexiones y su arranque rápido se conservan: solo se apaga la caché.
- Cómo rehacerlo: al **crear** una configuración, `wrangler hyperdrive create <nombre> --caching-disabled`;
  para una existente, `wrangler hyperdrive update <ID> --caching-disabled`.
- Si algún día se quiere caché para lecturas que la toleren, sería una **segunda** configuración con su
  propio binding, y **nunca** para el panel ni para la autenticación.

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
3. Supabase de **producción** → Authentication: **URL Configuration** (*Site URL* al dominio nuevo y
   `https://laligahispana.es/**` en *Redirect URLs*) y las **plantillas de correo** de invitación y
   recuperación ([`OPERACION.md`](./OPERACION.md#alta-por-invitación)). Sin esto, los correos siguen
   llevando al dominio viejo o a un flujo que no llega a fijar contraseña. El proyecto de **desarrollo**
   tiene su propia URL Configuration (localhost y los dominios de Preview).
4. `routes` en `wrangler.jsonc`: opcional, **no** se hizo.

El orden importa: primero la build variable (solo afecta a los metadatos) y después el reloj (si falla, sí se nota). El paso de Supabase no se nota hasta el siguiente correo de Auth.

## Despliegue manual

```bash
npm run deploy     # opennextjs-cloudflare build + scripts/deploy-worker.mjs (deploy --keep-vars)
npm run preview    # opennextjs-cloudflare build + preview local
```

- `--keep-vars` evita que un despliegue borre las **variables de texto** del panel (los secretos no se
  borran nunca; equivale al `keep_vars: true` de `wrangler.jsonc`).
- Los secretos van en el panel, **nunca** en `wrangler.jsonc`.
- Requiere `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` en `.dev.vars` (o en el entorno).
- **Ojo con el deploy manual**: `npm run deploy` compila con el entorno del proceso, y `.env.local`
  apunta a desarrollo. El camino normal es Workers Builds (que usa las variables de producción del
  trigger). Para un deploy manual a producción hay que exportar antes
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y `NEXT_PUBLIC_SITE_URL` de
  producción; si no, el bundle saldría apuntando a desarrollo. `scripts/deploy-worker.mjs` busca la
  referencia del proyecto de desarrollo en `.open-next` y **aborta** antes de publicar si la encuentra.

## Checklist

Antes de probar una rama (desarrollo):

```bash
npm run db:push                  # sincroniza el schema en desarrollo
npm run db:security -- --check   # RLS; obligatorio tras un db:push que añada tablas
npm run countries:seed           # lista de países del formulario de inscripción
npm run db:window                # ventana de fechas del torneo (opcional, recomendado)
```

En producción, los mismos comandos se ejecutan **de forma deliberada** con la URL de producción; no
se heredan del entorno de desarrollo. `db:cron` es **solo de producción**.

- La variable de Hyperdrive en la build del trigger, o el despliegue no publica.
- Las `NEXT_PUBLIC_*` y los secretos de servidor, en la lista de build que corresponda.
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
| Un Preview da 500 y el proyecto de desarrollo está pausado | El plan Free pausa los proyectos tras una semana sin actividad. Reanudarlo en el dashboard. El workflow `dev-keepalive.yml` hace una consulta diaria; necesita el secreto `DEV_DATABASE_URL` del repositorio. |
| Un Preview antiguo sigue viendo o escribiendo en producción | Los Previews no se actualizan solos: se crearon antes de cambiar el Hyperdrive/base config. Hay que redesplegarlo o borrarlo. |
| `npm run deploy` publica un bundle que apunta a desarrollo | `.env.local` apunta al proyecto de desarrollo. Exportar las variables de producción antes del build manual o desplegar con Workers Builds. |
| `npm run db:cron` contra desarrollo programa un reloj que llama a producción | Sin `SITE_URL`, el script usa `https://laligahispana.es`. Es un comando solo de producción. |
| `npm run db:window` en una base vacía deja un `scoring.ruleset` sin versión y se ignoran las reglas guardadas | Pasa al crear la clave desde cero: el script solo añade `window`. Publicar primero el ruleset con `npm run score` y después fijar la ventana; o sembrar el documento completo. |
| El dominio nuevo no carga para algunos visitantes | Caché DNS antigua; se resuelve sola. |
| Una variable del panel desaparece tras un despliegue | Era una variable de **texto** y el despliegue no llevaba `keep_vars`: el archivo es la fuente de verdad y las borra. Ya está activo en `wrangler.jsonc` (y los secretos nunca se borran). |
| El panel de admin no refleja una aprobación o edición reciente (y el historial de acciones repite la misma acción) | La caché de consultas de Hyperdrive servía `SELECT` anteriores a la escritura. La configuración va **sin caché** (`caching.disabled`) a propósito. |
| El correo de invitación de un admin lleva a un dominio viejo (p. ej. un `workers.dev` que ya no existe) | El **Site URL** del proyecto de Supabase sigue en el dominio anterior: `inviteUserByEmail` va sin `redirectTo` a propósito y el destino lo pone el proyecto (Authentication → URL Configuration). Aplicar el [paso del cambio de dominio](#pasos-del-cambio-de-dominio); a quien ya recibió el enlace roto, mandarle un correo de recuperación desde Authentication → Users. |
| La invitación crea la cuenta en Auth, pero nadie llega a fijar contraseña (el enlace acaba en la portada) | La plantilla del correo usa `{{ .ConfirmationURL }}`: la verificación ocurre en `supabase.co` y deja la sesión en el fragmento, que la web no consume; `/auth/confirm` nunca se ejecuta. Las plantillas de *invite* y *recovery* tienen que enlazar a `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=…` ([detalle](./OPERACION.md#alta-por-invitación)). Hacen falta plantillas editables, o sea **SMTP propio**. |
| El editor de plantillas de Auth está bloqueado («Set up custom SMTP to edit the source») y los correos solo llegan a los miembros del equipo | Proyecto Free nuevo con el correo por defecto de Supabase: desde el 3 de junio de 2026 sus plantillas no se pueden editar y solo entrega a direcciones del equipo de la organización (2 correos/hora, sin garantía). Las invitaciones de admin necesitan un SMTP propio (Resend y similares) en Authentication → SMTP Settings. |
| Los correos de Auth fallan (500 en `/auth/v1/recover`) y el proveedor no registra el intento | En Authentication → SMTP Settings: el host va **sin esquema** (`smtp.resend.com`, no `http://smtp.resend.com`) y el remitente cuelga del dominio verificado en el proveedor. Ver [`OPERACION.md`](./OPERACION.md#alta-por-invitación). |
