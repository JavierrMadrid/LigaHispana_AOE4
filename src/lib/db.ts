import "server-only";

import { after } from "next/server";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { logDatabaseFailure } from "@/lib/db-errors";
import {
  readCloudflareContext,
  readHyperdriveConnectionString,
  readRuntimeEnv,
  type CloudflareRequestContext,
} from "@/lib/runtime-env";

/**
 * Cliente de Prisma, **perezoso** y con la vida corta que pide cada sitio donde
 * corre.
 *
 * Antes se construía al importar este módulo. Eso obligaba a que `next build`
 * tuviera `DATABASE_URL`: al recopilar los datos de página Next importa las
 * rutas, el import creaba el cliente y el build moría con "DATABASE_URL no está
 * definida" si la variable no estaba en el entorno de compilación. Creándolo en
 * la primera llamada, importar `db` no toca la base y el build deja de
 * necesitar el secreto de la base de datos.
 *
 * ## Un cliente por petición en el Worker, y solo uno fuera
 *
 * En `workerd` un socket TCP creado con `connect()` **solo es válido durante la
 * invocación que lo abre**: al terminar la petición el runtime lo cierra sin
 * emitir `error`. Un cliente cacheado entre invocaciones saca ese socket muerto
 * del *pool*, el `write` se pierde y nada resuelve ni rechaza la promesa: la
 * consulta se queda colgada para siempre y Cloudflare mata la invocación con el
 * error 1101 ("your Worker's code had hung and would never generate a response").
 * Por eso aquí no hay caché entre peticiones, y es lo que documenta Cloudflare
 * ("create a new `Client` instance for each request").
 *
 * Fuera del Worker (`next dev` y los scripts de `scripts/`, que son Node de
 * proceso largo) el comportamiento es el de siempre: **una** instancia
 * reutilizada, guardada en `globalThis` para que el hot reload de Next no abra
 * una conexión nueva en cada recarga.
 *
 * La señal para distinguir los dos sitios **no** es `process.env.NODE_ENV`: en el
 * bundle del Worker es un literal sustituido al compilar y siempre valdría
 * `"production"`, así que los dos casos caerían en la misma rama. Es la
 * **existencia del contexto de Cloudflare** (`readCloudflareContext()`), que el
 * *entrypoint* del Worker publica en cada invocación y que en Node nunca está.
 * Se descarta `getCloudflareContext()` de `@opennextjs/cloudflare` porque es una
 * dependencia de desarrollo con *peer dependencies* sobre `wrangler` y `next`:
 * importarla desde `src/lib` metería al build del Worker cosas que Cloudflare
 * instala y construye, que es justo el riesgo que evita leer el símbolo global
 * directamente (`runtime-env.ts`).
 *
 * ## Cómo se cierran las conexiones
 *
 * Un cliente por petición sin cerrar dejaría el *pool* y su socket abiertos
 * hasta que el runtime los mata, y el trabajo de cerrarlos se pierde. Se cierran
 * con `after()` de `next/server`, que es la forma canónica de decir "esto va
 * cuando la respuesta esté enviada", y que en el Worker aterriza en
 * `ctx.waitUntil`: la invocación sigue viva hasta que la promesa resuelve, así
 * que el `pool.end()` ocurre **dentro** de la invocación, con el socket todavía
 * válido. Se descarta llamar a `ctx.waitUntil` directamente porque esa promesa
 * **empieza en el momento de registrarla**: cerraría el *pool* mientras la
 * página todavía está consultando. Y se descarta un finalizador en
 * `AsyncLocalStorage` porque `db.ts` no es la entrada de la petición: el único
 * punto por el que pasa todo lo de Next es el Proxy, y ahí no se abre ningún
 * ámbito que este módulo pueda cerrar.
 *
 * `after()` viene de `next/server` y solo existe dentro del ámbito de una
 * petición de Next, así que **nunca se llama en la rama de Node**: los scripts de
 * `scripts/` y `next dev` toman la otra rama del `if` de `prisma()` y no llegan
 * aquí. El `import "server-only"` de arriba y este import no se estorban (los dos
 * son de servidor y ninguno tiene efectos al importarse), pero el orden importa en
 * otro sentido: como `after()` lanza fuera del ámbito, el registro va envuelto en
 * un `try`/`catch` que, si algún día faltara `waitUntil` en algún runtime,
 * degrada a "el socket lo cierra el runtime" en vez de tumbar la primera lectura
 * de la base de datos de la petición.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Un cliente por invocación del Worker, indexado por el contexto de Cloudflare.
 *
 * La clave es el propio objeto de contexto, que el *entrypoint* crea nuevo en
 * cada petición: identidad de clave es identidad de invocación. Al ser un
 * `WeakMap`, el cliente se va con la petición y no queda ninguna referencia que
 * lo retenga entre invocaciones.
 */
const porInvocacion = new WeakMap<CloudflareRequestContext, PrismaClient>();

/** Ya se ha avisado de que `after()` no está disponible, para no repetirlo. */
let avisoAfterAusente = false;

/**
 * Cadena de conexión de donde toque: el binding de Hyperdrive si el Worker lo
 * tiene, y `DATABASE_URL` si no.
 *
 * Las dos rutas conviven a propósito. La cadena de Hyperdrive **solo** existe en
 * runtime, dentro de `env.HYPERDRIVE.connectionString`, y no se puede copiar a
 * ninguna variable de entorno; mientras el binding no exista, `DATABASE_URL` es
 * lo que hay, y es también lo que necesitan `next dev` y los scripts de Node.
 */
function connectionString(): string {
  const value = readHyperdriveConnectionString() ?? readRuntimeEnv("DATABASE_URL");

  if (value === undefined || value === "") {
    throw new Error(
      "DATABASE_URL no está definida y el Worker no tiene el binding HYPERDRIVE de Hyperdrive.",
    );
  }

  return value;
}

function createPrismaClient(): PrismaClient {
  // Lectura de la configuración en dos capas (bindings de Cloudflare y
  // `process.env`), y **aquí** y no al importar el módulo: es lo que mantiene
  // `next build` sin necesitar la variable, porque en la recapitulación de datos
  // de página no hay petición y no hay ningún binding al que preguntar.
  //
  // El adaptador recibe la **configuración** del `pool` y no un `Pool` hecho a
  // mano, para que sea él quien lo cree y quien lo cierre en `$disconnect()`
  // (`pool.end()`), sin tener que acordarse de hacerlo a mano.
  const adapter = new PrismaPg(
    { connectionString: connectionString() },
    {
      // El error de un cliente **ocioso** del *pool* no lo ve ninguna consulta:
      // el adaptador se lo pasa a este callback y ahí se acabaría. Es justo la
      // firma de un socket que el runtime ya ha cerrado, así que se registra en
      // vez de tragárselo.
      onPoolError: (error) => {
        logDatabaseFailure("db/pool", error);
      },
    },
  );

  return new PrismaClient({ adapter });
}

/**
 * Cierra el *pool* del cliente cuando la respuesta esté enviada.
 *
 * `after()` es lo que da el momento; en el Worker, además, mantiene viva la
 * invocación mientras el `pool.end()` se ejecuta. Si no estuviera disponible (no
 * hay ámbito de petición, o el runtime no ofrece `waitUntil`) no es un problema
 * funcional: el socket lo cierra el runtime al terminar la invocación, que es
 * justo el fallo que el cliente por petición ya evita. Se avisa **una vez** para
 * no llenar el log de peticiones, y se sigue.
 */
function closeWhenRequestEnds(client: PrismaClient): void {
  try {
    after(async () => {
      try {
        await client.$disconnect();
      } catch (error) {
        logDatabaseFailure("db/cierre", error);
      }
    });
  } catch (error) {
    if (!avisoAfterAusente) {
      avisoAfterAusente = true;
      logDatabaseFailure("db/lifecycle", error);
    }
  }
}

function prisma(): PrismaClient {
  const invocation = readCloudflareContext();

  if (invocation === undefined) {
    // Node: una sola instancia en `globalThis`, reutilizada y estable entre
    // recargas del hot reload.
    globalForPrisma.prisma ??= createPrismaClient();

    return globalForPrisma.prisma;
  }

  const cached = porInvocacion.get(invocation);

  if (cached !== undefined) {
    return cached;
  }

  const client = createPrismaClient();

  porInvocacion.set(invocation, client);
  closeWhenRequestEnds(client);

  return client;
}

/**
 * Proxy que hace de cliente sin instanciarlo: cada acceso resuelve el cliente
 * real y devuelve el método **ligado a él**, para que los campos privados de
 * `PrismaClient` sigan viendo su propio `this` y no el del proxy.
 */
export const db = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = prisma();
    const value: unknown = Reflect.get(client, property);

    return typeof value === "function" ? value.bind(client) : value;
  },
});
