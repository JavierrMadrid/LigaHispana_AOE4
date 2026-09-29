import "dotenv/config";

import { Client } from "pg";

/**
 * Disparo periódico del sync con AoE4World desde la propia base de datos:
 * Supabase Cron (`pg_cron`) llama a `net.http_post` (`pg_net`) cada 5 minutos.
 *
 *   npm run db:cron              # aplica extensiones + job (idempotente)
 *   npm run db:cron -- --check   # solo comprueba, no escribe; sale con 1 si no cuadra
 *   npm run db:cron -- --remove  # desprograma el job (vuelta atrás)
 *
 * ## Qué problema resuelve esto
 *
 * El sync tarda ~15 s y gasta ~500 ms de CPU, y el plan Free de Cloudflare da
 * **10 ms de CPU por invocación**. Con un Cron Trigger nativo cada 5 minutos el
 * isolate moría a la hora con `Worker exceeded CPU time limit` (error 1102) y
 * hubo que revertirlo (commit `459ed27`); con el workflow de GitHub la cadencia
 * la retrasa GitHub a una pasada cada 4-6 h, que no sirve para las partidas en
 * vivo. Faltaba un reloj de verdad que no tocara el presupuesto de CPU del
 * Worker, y el cron de Postgres es exactamente eso: la espera ocurre en la base
 * de datos y el Worker solo se despierta cuando ya hay trabajo.
 *
 * **Es una prueba, y hay que vigilarla.** La hipótesis es que el fallo anterior
 * no lo causaba el volumen sino el *self-fetch* del cron nativo (dos invocaciones
 * sobre el mismo isolate). Aquí no hay self-fetch: el disparo es una petición
 * HTTP externa, una invocación cada 5 minutos. Si el isolate vuelve a morir con
 * 1102, la conclusión es que el límite no perdona ni así, y toca el plan Paid.
 *
 * ## Por qué apunta a `/api/sync` (público) y no a `/api/cron/sync` (con secreto)
 *
 * Por no meter `CRON_SECRET` en la base de datos. `cron.job.command` es una
 * columna de texto plano, y `cron.job_run_details` guarda una copia del comando
 * de cada ejecución: un secreto ahí quedaría escrito en dos sitios y en los
 * logs del panel, sin ninguna de las protecciones que tiene una variable de
 * entorno. El endpoint público evita el problema entero: **no hay ningún secreto
 * que escribir**, y aun así no es una puerta abierta, porque
 * `src/app/api/sync/route.ts` pone las dos condiciones que lo cierran:
 *
 * - exige `content-type: application/json` (lo que `pg_net` manda siempre), que
 *   es justo lo que descarta un POST de formulario de otro sitio, y
 * - lleva un **candado global de 5 minutos** (clave `public/manual-sync`), así
 *   que ni este job ni quien descubra la URL pueden provocar más de una pasada
 *   por ventana. Si alguien pulsa "Actualizar" en `/partidas` dentro de la
 *   ventana, el cron recibe `{"status":"cooldown"}` con 200 y no duplica trabajo.
 *
 * `/api/cron/sync` y ese candado no se tocan: siguen siendo los del workflow de
 * GitHub, que queda como red de seguridad.
 *
 * ## Por qué habla con `pg` y no con Prisma
 *
 * Igual que `scripts/db-security.ts` y por el mismo motivo: el cliente de Prisma
 * de la web está generado con `runtime = "workerd"` y no puede cargar su query
 * compiler bajo `tsx`. Además, nada de esto es una tabla de Prisma: son
 * extensiones y el catálogo de `cron`, y `prisma db push` no las gestiona ni las
 * conoce.
 *
 * ## Por qué es un script y no un `.sql` suelto
 *
 * Porque un job creado a mano desde el panel de Supabase no está en ninguna
 * parte del repositorio: el siguiente que separe el caso no sabría ni que
 * existe, ni con qué frecuencia dispara ni a qué URL. Esto lo deja escrito,
 * repetible, comprobable y —lo importante— **deshacible**: `--remove` lo deja
 * como estaba.
 *
 * ## Detalles que no son obvios
 *
 * - **El nombre del job es fijo** (`ligahispana-sync`) porque
 *   `cron.schedule(nombre, ...)` hace *upsert* sobre `jobname_username_uniq`:
 *   repetir el script actualiza el job existente en vez de crear un segundo.
 * - **`timeout_milliseconds` va explícito** porque el valor por defecto de
 *   `net.http_post` son 2-5 s y una pasada tarda ~15 s: con el valor por defecto
 *   la petición se cortaría antes de que el Worker terminara.
 * - **`pg_net` se instala en `extensions`**, no en `public`: es donde lo pone
 *   Supabase y es lo que evita el aviso del *Security Advisor*. Si algún día
 *   estuviera en `public`, este script lo avisa en vez de moverlo (mover una
 *   extensión ya instalada es un `drop` + `create`, y eso no se decide solo).
 * - **`SITE_URL`** es la URL pública del Worker. Está declarado en
 *   `.env.example` pero no hace falta definirlo: sin él (o con la cadena vacía
 *   de ejemplo) sale el valor por defecto de más abajo. Conviene ponerlo si
 *   algún día el sitio cambia de dominio.
 * - **`cron.job` tiene RLS** con una política que solo deja ver los jobs del rol
 *   propio. Da igual mientras se programe y se compruebe con el mismo
 *   `DATABASE_URL` (el rol `postgres` de Supabase), que es lo normal, pero por
 *   eso la comprobación lista *todos* los jobs visibles: si el job no aparece,
 *   lo primero que hay que mirar es con qué rol se está mirando.
 *
 * ## Comprobado contra la base de datos real
 *
 * En septiembre de 2026, con `DATABASE_URL` apuntando al *Session pooler* de
 * Supabase (puerto 5432), todo esto quedó verificado: `create schema`,
 * `create extension`, `cron.schedule(nombre, ...)` y `cron.unschedule(nombre)`
 * funcionan a través del pooler, y el job se crea, se lee y se borra. El pooler
 * no es un problema para nada de lo que hace este script.
 *
 * ## Lo que este script no hace
 *
 * - No toca la web, ni los endpoints, ni `prisma/schema.prisma`, ni
 *   `wrangler.jsonc`. Solo escribe extensiones y filas de `cron.job`.
 * - No guarda secretos: ni los hay ni se imprimen. Los mensajes de error se
 *   sanean antes de mostrarlos, porque un error de `pg` puede incluir la cadena
 *   de conexión.
 */

const JOB_NAME = "ligahispana-sync";

const SCHEDULE = "*/5 * * * *";

/** Si el sitio cambia de dominio, se define `SITE_URL` en `.env`. */
const DEFAULT_SITE_URL = "https://ligahispana-aoe4.javierr-ma93.workers.dev";

/** Timeout del cliente HTTP de `pg_net`, en ms. */
const HTTP_TIMEOUT_MS = 240_000;

/**
 * `SITE_URL` vacío cae al valor por defecto a propósito, y con `||` y no con
 * `??`: en `.env.example` está declarado como `SITE_URL=""`, y `??` se quedaría
 * con la cadena vacía y dejaría el job apuntando a `/api/sync`, que no es
 * ninguna URL.
 */
const SITE_URL = (process.env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");

const SYNC_URL = `${SITE_URL}/api/sync`;

type ExtensionRow = {
  extname: string;
  extversion: string;
  esquema: string;
};

type JobRow = {
  /** `bigint` vuelve como texto en `pg`, no como `number`. */
  jobid: string;
  jobname: string;
  schedule: string;
  command: string;
  database: string;
  username: string;
  active: boolean;
};

type ResponseRow = {
  id: string;
  status_code: number | null;
  timed_out: boolean | null;
  error_msg: string | null;
  created: Date;
  /**
   * Cuerpo de la respuesta. Es el resumen de `/api/sync`, sin secretos, y es
   * lo que distingue una pasada de verdad (`"status":"ok"`) de un `"cooldown"`.
   */
  content: string | null;
};

type CronSettings = {
  use_background_workers: string | null;
  host: string | null;
};

/** Mismo saneado que `src/lib/db-errors.ts`, para no repetirlo con otros nombres. */
const URL_WITH_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;
const SECRET_PARAM = /\b(password|sslpassword|secret)=([^&\s"']+)/gi;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message
    .replace(URL_WITH_CREDENTIALS, "$1[redactado]@")
    .replace(SECRET_PARAM, "$1=[redactado]");
}

/**
 * Literal SQL para el *check*, que imprime el comando. El comando que se
 * programa va **parametrizado** (`cron.schedule` recibe `text`), así que esto
 * no es lo que se aplica: es solo cómo se muestra.
 */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * El comando del job, en un único sitio para que aplicar y comprobar no puedan
 * separarse. Se compara con los espacios normalizados porque el texto que se
 * grabó en `cron.job` depende de cómo se imprimió.
 */
function buildCommand(): string {
  return [
    "select net.http_post(",
    `url := ${literal(SYNC_URL)},`,
    "body := '{}'::jsonb,",
    `headers := '{"Content-Type": "application/json"}'::jsonb,`,
    `timeout_milliseconds := ${HTTP_TIMEOUT_MS}`,
    ");",
  ].join(" ");
}

function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/g, " ").trim();
}

async function readExtensions(sql: Client): Promise<ExtensionRow[]> {
  const { rows } = await sql.query<ExtensionRow>(`
    select e.extname::text, e.extversion::text, n.nspname::text as esquema
      from pg_extension e
      join pg_namespace n on n.oid = e.extnamespace
     where e.extname in ('pg_cron', 'pg_net')
     order by e.extname
  `);

  return rows;
}

/**
 * Cómo ejecuta `pg_cron` los jobs, que no es un detalle: con
 * `cron.use_background_workers = "off"` cada ejecución **abre una conexión
 * nueva** a `cron.host` en lugar de correr en un *background worker*. Es lo que
 * hay puesto en Supabase y funciona, pero conviene verlo, porque si algún día
 * esa conexión dejara de poder abrirse el job se programa bien, no da ningún
 * error, y solo se nota en `cron.job_run_details`.
 */
async function readCronSettings(sql: Client): Promise<CronSettings> {
  const { rows } = await sql.query<CronSettings>(`
    select
      (select setting from pg_settings where name = 'cron.use_background_workers') as use_background_workers,
      (select setting from pg_settings where name = 'cron.host') as host
  `);

  return rows[0] ?? { use_background_workers: null, host: null };
}

async function readJob(sql: Client, name: string): Promise<JobRow | null> {
  const { rows } = await sql.query<JobRow>(
    `select jobid::text, jobname::text, schedule::text, command::text,
            database::text, username::text, active
       from cron.job
      where jobname = $1`,
    [name],
  );

  return rows[0] ?? null;
}

async function readAllJobs(sql: Client): Promise<JobRow[]> {
  const { rows } = await sql.query<JobRow>(
    `select jobid::text, jobname::text, schedule::text, command::text,
            database::text, username::text, active
       from cron.job
      order by jobid`,
  );

  return rows;
}

async function readLastResponses(sql: Client): Promise<ResponseRow[]> {
  const { rows } = await sql.query<ResponseRow>(`
    select id::text, status_code, timed_out, error_msg, created, content
      from net._http_response
     order by id desc
     limit 3
  `);

  return rows;
}

/** Cuánto del cuerpo se imprime: da para leer el `status` sin volcar un log. */
const MAX_CUERPO = 160;

async function apply(sql: Client): Promise<void> {
  console.log("");
  console.log("--- Aplicando ---");

  // `pg_net` es la que no se puede usar sin esquema en Supabase: el aviso del
  // Security Advisor salta si sus objetos cuelgan de `public`. El esquema ya
  // existe; la sentencia solo está por si algún día no lo estuviera.
  await sql.query(`create schema if not exists extensions`);
  console.log('Esquema "extensions" asegurado.');

  // `if not exists`: repetirlo solo emite un aviso. En `pg_cron` no se indica
  // esquema porque su `.control` lo fija en `pg_catalog`, que es donde lo deja
  // Supabase; en `pg_net` sí, y `net` sigue siendo el nombre del esquema de la
  // API (eso lo decide la propia extensión).
  await sql.query(`create extension if not exists pg_cron`);
  console.log("Extensión pg_cron: asegurada.");

  await sql.query(`create extension if not exists pg_net with schema extensions`);
  console.log("Extensión pg_net: asegurada.");

  // Parametrizado, no interpolado: el nombre, la expresión y el comando van
  // como parámetros. Es un `upsert` sobre `jobname_username_uniq`, así que esto
  // no puede dejar dos jobs con el mismo nombre.
  const { rows } = await sql.query<{ jobid: string }>(
    `select cron.schedule($1::text, $2::text, $3::text)::text as jobid`,
    [JOB_NAME, SCHEDULE, buildCommand()],
  );

  console.log(`Job "${JOB_NAME}" programado con "${SCHEDULE}" (jobid ${rows[0]?.jobid}).`);
  console.log(`Dispara: POST ${SYNC_URL}`);
}

/**
 * @param despuesDeQuitar `true` cuando se viene de `--remove`: entonces que el
 *   job **no** exista es lo correcto, y su presencia solo se informa.
 */
async function check(sql: Client, despuesDeQuitar = false): Promise<boolean> {
  console.log("");
  console.log("--- Comprobación ---");

  let correcto = true;

  const extensiones = await readExtensions(sql);
  const nombres = new Set(extensiones.map((row) => row.extname));

  console.log("");
  console.log("Extensiones:");

  for (const nombre of ["pg_cron", "pg_net"] as const) {
    const fila = extensiones.find((row) => row.extname === nombre);

    if (fila === undefined) {
      correcto = false;
      console.log(`  ${nombre}: NO instalada — hay que ejecutar "npm run db:cron"`);
      continue;
    }

    console.log(`  ${fila.extname} ${fila.extversion} (esquema "${fila.esquema}")`);
  }

  const pgNet = extensiones.find((row) => row.extname === "pg_net");

  if (pgNet !== undefined && pgNet.esquema === "public") {
    // No se arregla solo: mover una extensión ya instalada es un `drop` + `create`
    // que borra la cola de peticiones y las respuestas guardadas. Se avisa.
    console.warn("");
    console.warn(
      "AVISO: pg_net está instalada en \"public\". Supabase recomienda \"extensions\" y el " +
        "Security Advisor avisa por esto. El job funciona igual, pero moverla exige un " +
        '"drop extension pg_net" + "create extension pg_net with schema extensions", que ' +
        "pierde las respuestas guardadas de net._http_response. Decídelo a mano.",
    );
  }

  // Sin pg_cron no existe el esquema `cron`, así que esto no se puede preguntar.
  if (!nombres.has("pg_cron")) {
    console.log("");
    console.log(`Job "${JOB_NAME}": no se puede comprobar, falta pg_cron.`);

    return false;
  }

  const ajustes = await readCronSettings(sql);
  const fondo = ajustes.use_background_workers;

  console.log("");
  console.log("pg_cron:");
  console.log(
    `  cron.use_background_workers = "${fondo ?? "(sin definir)"}", cron.host = "${ajustes.host ?? "(sin definir)"}"`,
  );

  if (fondo === "on") {
    console.log('  Con "on" el job corre en un background worker de la propia base.');
  } else {
    console.log(
      `  Con "${fondo}" cada ejecución abre una conexión nueva a cron.host. En Supabase ` +
        "(localhost) funciona, pero si algún día dejara de poder abrirse, el job se " +
        "programaría igual, no daría ningún error, y solo se vería en cron.job_run_details.",
    );
  }

  const job = await readJob(sql, JOB_NAME);

  console.log("");
  console.log(`Job "${JOB_NAME}":`);

  if (job === null) {
    if (!despuesDeQuitar) {
      correcto = false;
    }

    console.log(
      despuesDeQuitar
        ? "  no existe, como se pidió."
        : '  no existe. Hay que ejecutar "npm run db:cron"',
    );
  } else {
    const problemas: string[] = [];

    if (despuesDeQuitar) {
      problemas.push("sigue existiendo");
    }

    if (job.schedule !== SCHEDULE) {
      problemas.push(`schedule "${job.schedule}" en vez de "${SCHEDULE}"`);
    }

    if (normalizeSql(job.command) !== normalizeSql(buildCommand())) {
      problemas.push("el comando no es el de este script");
    }

    if (!job.active) {
      problemas.push("está desactivado");
    }

    const estado = problemas.length === 0 ? "correcto" : `REVISAR: ${problemas.join(", ")}`;

    correcto = correcto && problemas.length === 0;

    console.log(`  jobid ${job.jobid} — usuario "${job.username}", base "${job.database}"`);
    console.log(`  schedule ${job.schedule} — activo: ${job.active ? "sí" : "no"} — ${estado}`);
    console.log(`  comando: ${normalizeSql(job.command)}`);
  }

  const otros = await readAllJobs(sql);

  console.log("");
  console.log(`Jobs de cron en la base (${otros.length}):`);

  for (const otro of otros) {
    const marca = otro.jobname === JOB_NAME ? "  <- este" : "";

    console.log(`  [${otro.jobid}] ${otro.jobname ?? "(sin nombre)"} — ${otro.schedule}${marca}`);
  }

  // `cron.job` tiene RLS con una política que solo deja ver los jobs del rol
  // propio, así que esta lista y el `--remove` ven lo mismo que quien programa.
  if (!nombres.has("pg_net")) {
    return correcto;
  }

  const respuestas = await readLastResponses(sql);

  console.log("");
  console.log("Últimas respuestas de pg_net (se guardan 6 h):");

  if (respuestas.length === 0) {
    console.log(
      job === null
        ? "  ninguna. No hay ningún job programado, así que no se espera ninguna."
        : "  ninguna todavía. El job dispara en el siguiente múltiplo de 5 minutos.",
    );
  } else {
    for (const respuesta of respuestas) {
      const estado =
        respuesta.error_msg !== null
          ? `error: ${respuesta.error_msg}`
          : respuesta.timed_out === true
            ? "sin respuesta (timeout)"
            : `HTTP ${respuesta.status_code ?? "?"}`;

      const cuerpo =
        respuesta.content === null
          ? ""
          : ` — ${respuesta.content.replaceAll(/\s+/g, " ").slice(0, MAX_CUERPO)}`;

      console.log(
        `  [${respuesta.id}] ${respuesta.created.toISOString()} — ${estado}${cuerpo}`,
      );
    }
  }

  return correcto;
}

async function remove(sql: Client): Promise<void> {
  console.log("");
  console.log("--- Desprogramando ---");

  // `cron.unschedule(nombre)` lanza una excepción si el job no existe, así que
  // primero se mira: "--remove" tiene que poder repetirse sin romper.
  const job = await readJob(sql, JOB_NAME);

  if (job === null) {
    console.log(`El job "${JOB_NAME}" no estaba programado. No hay nada que deshacer.`);
    return;
  }

  await sql.query(`select cron.unschedule($1::text)`, [JOB_NAME]);
  console.log(`Job "${JOB_NAME}" (jobid ${job.jobid}) desprogramado.`);
  console.log("Las extensiones se quedan: no hacen daño y quitarlas es otra operación.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const soloComprobar = args.includes("--check");
  const quitar = args.includes("--remove");

  if (soloComprobar && quitar) {
    process.exitCode = 1;
    console.error("--check y --remove son excluyentes: uno mira y el otro escribe.");
    return;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    process.exitCode = 1;
    console.error("DATABASE_URL no está definida.");
    return;
  }

  const sql = new Client({ connectionString });
  // `connect()` va dentro del `try` a propósito: un fallo de conexión es
  // justo el error que más puede traer la cadena de conexión, y el mensaje pasa
  // por el saneado de `describeError` en vez de subir como un stack pelado.
  let conectado = false;

  try {
    await sql.connect();
    conectado = true;

    if (soloComprobar) {
      console.log("Comprobando el disparo periódico del sync.");
    } else if (quitar) {
      console.log("Retirando el disparo periódico del sync.");
      await remove(sql);
    } else {
      console.log("Disparo periódico del sync con Supabase Cron (pg_cron + pg_net).");
      await apply(sql);
    }

    const correcto = await check(sql, quitar);

    if (!correcto) {
      process.exitCode = 1;
      console.error("");
      console.error("El disparo periódico no es el esperado. Revisar el listado de arriba.");
      return;
    }

    console.log("");
    console.log(
      quitar
        ? "Ya no hay disparo periódico desde la base de datos: el workflow de GitHub vuelve a ser el único."
        : "Lo que toca ahora: esperar al siguiente múltiplo de 5 minutos y mirar la respuesta " +
          "de pg_net en la comprobación, o en net._http_response desde el panel de Supabase.",
    );
  } catch (error) {
    process.exitCode = 1;
    console.error("");
    console.error(`db:cron ha fallado: ${describeError(error)}`);
  } finally {
    if (conectado) {
      await sql.end();
    }
  }
}

void main();
