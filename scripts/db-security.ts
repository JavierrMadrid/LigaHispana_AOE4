import "dotenv/config";

import { Client } from "pg";

/**
 * Postura de seguridad de la base de datos: RLS sin políticas y sin permisos para
 * los roles de cliente.
 *
 *   npm run db:security              # aplica la postura "cerrada" (idempotente)
 *   npm run db:security -- --check   # solo comprueba, no escribe
 *   npm run db:security -- --solo-rls  # la otra postura: RLS filtra, hay SELECT
 *
 * ## Por qué habla con `pg` y no con Prisma
 *
 * Todo lo que hace este script es SQL crudo, así que usa `pg` directamente en vez
 * de `@/lib/db`. No es una preferencia: el cliente de Prisma de la web está
 * generado con `runtime = "workerd"` (obligatorio, porque `workerd` prohíbe
 * `new WebAssembly.Module`) y ese cliente **no puede cargar su query compiler
 * bajo `tsx`**, que es como corren los scripts. Con `pg` el script no depende de
 * Prisma en absoluto y sigue funcionando con cualquiera de los dos clientes
 * generados. No volver esto a "usar Prisma como el resto de scripts": es
 * exactamente lo que lo rompe.
 *
 * ## Por qué es un script y no un fichero `.sql` suelto
 *
 * `prisma db push` calcula la diferencia entre `prisma/schema.prisma` y la base de
 * datos, y **ni RLS ni los GRANT entran en esa comparación**. Un `alter table`
 * hecho a mano desde el panel de Supabase no está en ninguna parte del
 * repositorio, así que el siguiente `db push` o el siguiente que separe el caso no
 * sabría ni que existe. Esto lo deja escrito, repetible y comprobable.
 *
 * La postura es la de `docs/MODELO-DATOS.md` §7, y cabe en tres frases:
 * - la web **nunca** se conecta con una clave de cliente: todo pasa por el DAL con
 *   `DATABASE_URL`, así que las tablas no tienen por qué ser legibles por nadie más;
 * - con RLS activada y **ninguna** política, un rol sin `BYPASSRLS` ve cero filas;
 * - quitar además los permisos a `anon` y `authenticated` es el refuerzo: que ni
 *   siquiera puedan intentar la lectura.
 *
 * Lo que **no** se toca, y es deliberado:
 * - `anon` y `authenticated` conservan el `USAGE` sobre el esquema `public`. Sin él
 *   la Data API no llega a resolver la tabla y contesta 401; lo que se quiere es
 *   que conteste por el motivo correcto, no por uno que confunda.
 * - `service_role` conserva sus permisos y su `BYPASSRLS`: es un rol de
 *   infraestructura de Supabase, no un cliente de este torneo.
 *
 * ## Las dos posturas, y por qué esto tiene un interruptor
 *
 * En Postgres **el permiso de tabla se comprueba antes que RLS**. De ahí que las dos
 * posturas den respuestas distintas a la Data API y no se puedan tener a la vez:
 *
 * | Postura | RLS | `GRANT` a `anon` | La Data API contesta |
 * |---|---|---|---|
 * | `cerrada` (la de aquí, por defecto) | activada, 0 políticas | ninguno | `401 permission denied` |
 * | `solo-rls` (`--solo-rls`) | activada, 0 políticas | `SELECT` | `200 []` |
 *
 * `cerrada` es la más fuerte: no depende de que nadie añada nunca una política, que
 * es la condición que hay que mantener para que la segunda siga filtrando. `solo-rls`
 * da exactamente la respuesta `[]`, pero para llegar a ella hay que **conceder**
 * `SELECT` a `anon`, que es justo lo contrario de lo que pedía el endurecimiento.
 *
 * El interruptor existe para que la elección sea explícita y reversible sin editar
 * SQL, no para suavizar el valor por defecto, que sigue siendo el seguro.
 */

type RoleRow = { rolname: string; rolbypassrls: boolean; rolsuper: boolean };

type TablePostureRow = {
  tabla: string;
  rls: boolean;
  /** `count()::bigint` vuelve como texto en `pg`, no como `bigint`. */
  politicas: bigint | string;
  permisos_de_cliente: string;
};

type GrantRow = { granted: boolean };

/**
 * Tablas de la aplicación, en el mismo orden que el schema.
 *
 * La lista es explícita y hay que actualizarla cuando aparece una tabla nueva:
 * `prisma db push` no la añade sola, y sin ella la tabla nueva nace con los
 * permisos por defecto de Supabase en `public`, es decir, **legible con la clave
 * publicable** a través de la Data API. Es el motivo de que el script exista.
 */
const TABLES = ["Player", "Match", "PlayerScore", "Setting", "RateLimitCounter", "AdminAction"] as const;

const ROLES_CLIENTE = "anon, authenticated";

type Postura = "cerrada" | "solo-rls";

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Comprobación 0.1 del modelo de datos, y la única que puede romper la web en
 * silencio: activar RLS sin políticas deja al rol de la aplicación sin ver datos,
 * **sin error**. Por eso se comprueba antes de aplicar y no después.
 */
async function assertAppRoleCanBypassRls(sql: Client): Promise<void> {
  const { rows } = await sql.query<RoleRow>(
    `select rolname, rolbypassrls, rolsuper
       from pg_roles
      where rolname = current_user`,
  );
  const role = rows[0];

  if (role === undefined) {
    throw new Error("No se ha podido leer el rol de la conexión.");
  }

  if (!role.rolbypassrls && !role.rolsuper) {
    throw new Error(
      `El rol "${role.rolname}" no tiene BYPASSRLS ni es superusuario: con RLS y sin políticas ` +
        "la web se quedaría sin datos sin ningún error. No se aplica nada.",
    );
  }

  console.log(
    `Rol de la aplicación: ${role.rolname} (bypassrls=${String(role.rolbypassrls)}, superuser=${String(role.rolsuper)})`,
  );
}

async function applyPosture(sql: Client, postura: Postura): Promise<void> {
  console.log("");
  console.log(`--- Aplicando (postura "${postura}") ---`);

  for (const table of TABLES) {
    // Idempotente por naturaleza: repetirlo solo emite un aviso.
    await sql.query(`alter table public.${quote(table)} enable row level security`);
    console.log(`RLS activada: public."${table}"`);
  }

  if (postura === "solo-rls") {
    // Lo contrario del endurecimiento, y hay que decirlo: se le está dando a `anon`
    // el permiso de leer, y lo único que lo para son las cero políticas de RLS.
    console.log("");
    console.warn(
      "AVISO: postura \"solo-rls\": se concede SELECT a los roles de cliente y quien " +
        "filtra es RLS. Si algún día se añade una política permisiva, las tablas quedan " +
        "abiertas a la clave publicable.",
    );
    console.log("");
  }

  // Hoy `public` no tiene ninguna secuencia (todas las claves son texto o las pone
  // la aplicación), pero el permiso se revoca igualmente: si algún día entra una
  // columna con `serial`, la secuencia nace con los permisos por defecto de Supabase
  // y quedaría expuesta sin que nadie se dé cuenta.
  await sql.query(`revoke all on all sequences in schema public from ${ROLES_CLIENTE}`);
  console.log(`Permisos de secuencias de public revocados a: ${ROLES_CLIENTE}`);

  for (const table of TABLES) {
    if (postura === "cerrada") {
      await sql.query(`revoke all on table public.${quote(table)} from ${ROLES_CLIENTE}`);
      console.log(`Permisos revocados a ${ROLES_CLIENTE}: public."${table}"`);
    } else {
      // `SELECT` es lo mínimo que hace falta para que la petición llegue a RLS. Con
      // solo eso y cero políticas, la Data API devuelve `[]` en vez de 401.
      await sql.query(`grant select on table public.${quote(table)} to ${ROLES_CLIENTE}`);
      console.log(`SELECT concedido a ${ROLES_CLIENTE}: public."${table}"`);
    }
  }
}

/** Qué postura hay ahora mismo, deducida de si queda algún permiso a los clientes. */
async function readPostura(sql: Client): Promise<Postura> {
  const { rows } = await sql.query<GrantRow>(`
    select exists (
      select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join information_schema.role_table_grants g
          on g.table_schema = 'public' and g.table_name = c.relname
       where n.nspname = 'public'
         and c.relkind = 'r'
         and g.grantee in ('anon', 'authenticated')
    ) as granted
  `);

  return rows[0]?.granted === true ? "solo-rls" : "cerrada";
}

async function checkPosture(sql: Client): Promise<boolean> {
  const { rows } = await sql.query<TablePostureRow>(`
    select
      c.relname::text as tabla,
      c.relrowsecurity as rls,
      (
        select count(*)::bigint
          from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname
      ) as politicas,
      coalesce(
        (
          select string_agg(distinct g.grantee, ', ')
            from information_schema.role_table_grants g
           where g.table_schema = 'public'
             and g.table_name = c.relname
             and g.grantee in ('anon', 'authenticated')
        ),
        '(ninguno)'
      ) as permisos_de_cliente
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by c.relname
  `);

  const postura = await readPostura(sql);

  console.log("");
  console.log(`--- Comprobación (postura "${postura}") ---`);

  const esperadas = new Set<string>(TABLES);
  const sobrantes = rows.map((row) => row.tabla).filter((tabla) => !esperadas.has(tabla));

  if (sobrantes.length > 0) {
    console.log(
      `Tablas de public que no son de la aplicación: ${sobrantes.join(", ")}. ` +
        "Hay que decidir qué hacer con ellas antes de dar la postura por buena.",
    );
  }

  // Lo que hay que exigir siempre: RLS activada y cero políticas. Es lo que sostiene
  // las dos posturas, y lo que no depende de quién mire.
  let correcto = true;

  for (const row of rows) {
    const problemas: string[] = [];

    if (!row.rls) {
      problemas.push("RLS sin activar");
    }

    if (Number(row.politicas) > 0) {
      problemas.push(`${row.politicas} políticas (debe ser 0)`);
    }

    if (postura === "cerrada" && row.permisos_de_cliente !== "(ninguno)") {
      problemas.push(`permisos para ${row.permisos_de_cliente} en una postura "cerrada"`);
    }

    const estado = problemas.length === 0 ? "correcto" : `REVISAR: ${problemas.join(", ")}`;

    correcto = correcto && problemas.length === 0;

    console.log(
      `  ${row.tabla}: RLS=${row.rls ? "si" : "NO"}, políticas=${row.politicas}, ` +
        `clientes=${row.permisos_de_cliente} — ${estado}`,
    );
  }

  if (postura === "solo-rls") {
    console.log("");
    console.warn(
      "Aviso: la postura activa es \"solo-rls\" (hay SELECT para los roles de cliente y " +
        "filtra RLS). Es válida, pero es más débil que \"cerrada\": depende de que no haya " +
        "ninguna política. Para volver a la de por defecto, npm run db:security.",
    );
  }

  return correcto;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const soloComprobar = args.includes("--check");
  const soloRls = args.includes("--solo-rls");

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL no está definida.");
  }

  const sql = new Client({ connectionString });
  await sql.connect();

  try {
    if (!soloComprobar) {
      console.log("Postura de la base de datos.");
      await assertAppRoleCanBypassRls(sql);
      await applyPosture(sql, soloRls ? "solo-rls" : "cerrada");
    } else {
      console.log("Comprobando la postura de la base de datos.");
    }

    const correcto = await checkPosture(sql);

    if (!correcto) {
      process.exitCode = 1;
      console.error("");
      console.error("La postura de la base de datos no es la esperada. Revisar el listado de arriba.");
      return;
    }

    const espera =
      (await readPostura(sql)) === "cerrada"
        ? "La Data API debería contestar 401 permission denied: en Postgres el permiso de " +
            "tabla se comprueba antes que RLS, y no hay permiso. No es un 401 que haya que arreglar."
        : "La Data API debería contestar 200 []: el SELECT pasa y RLS, sin políticas, no deja pasar ninguna fila.";

    console.log("");
    console.log(espera);
  } finally {
    await sql.end();
  }
}

void main();
