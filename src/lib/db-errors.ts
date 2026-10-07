import "server-only";

/**
 * Fallos de base de datos: cómo describirlos sin filtrar secretos, cómo
 * registrarlos, y cómo decidir si una lectura **degrada** la respuesta o la
 * tumba.
 *
 * Por qué existe. Las tres páginas públicas que leen Postgres (`/`,
 * `/partidas`, `/objetivos`) son la web del torneo, y un corte puntual de la base
 * —límite de conexiones de Supabase, un reinicio, un pico de red— no puede
 * convertirse en un 500 con una traza en el log: lo que tiene que pasar es que la
 * página siga contestando y diga que no ha podido leer. El módulo da la forma de
 * expresarlo sin inventar copy: devuelve un **discriminante**, y el texto y el
 * marcado los pone quien pinte la pantalla.
 *
 * Se apoya en una regla que evita clasificar errores a ojo: el `try`/`catch`
 * envuelve **solo la llamada a la base de datos**, nunca la lógica de alrededor.
 * Así todo lo que sale de `readFromDatabase` es un fallo de base de datos por
 * definición, sin listas de clases de error que se queden viejas. En las Server
 * Actions, que sí hacen otras cosas (validar, llamar a la API de AoE4World), el
 * mismo criterio obliga a envolver la llamada a `db` y no la acción entera: un
 * error de validación o de red tiene que seguir siendo un error de aplicación.
 */

/** Un fallo de base de datos, ya sanado para poder ir al log. */
export type DatabaseFailure = {
  /**
   * Nombre del error: `PrismaClientKnownRequestError`, `PrismaClientInitializationError`,
   * `AggregateError`… Es lo primero que hay que mirar para saber de qué capa viene.
   */
  type: string;
  /**
   * Código de Prisma (`P1001`, `P2002`…) o de PostgreSQL (`53300`, `28P01`…),
   * si el error lo trae. Los de PostgreSQL son los que dicen si la base está
   * viva pero sin conexiones, o si las credenciales no valen.
   */
  code: string | null;
  /** Mensaje sin credenciales ni cadena de conexión. */
  message: string;
};

/**
 * Resultado de una lectura que puede degradarse.
 *
 * `data` es `null` y no una lista vacía a propósito: una lista vacía la leería
 * la interfaz como "no hay participantes" o "no hay partidas en juego", que es
 * una afirmación falsa. Con `null` quien pinte está obligado a distinguir los dos
 * casos, que es justo lo que se le pide.
 *
 * El motivo del fallo **no** viaja en el objeto: esto se serializa al navegador
 * dentro del *payload* de RSC, así que el detalle se queda en el log del servidor
 * y la pantalla solo necesita el discriminante.
 */
export type PublicRead<T> = { status: "ok"; data: T } | { status: "degraded"; data: null };

/**
 * Credenciales dentro de una URL (`postgres://usuario:clave@host/base`). Se
 * conserva el esquema y el host porque el host es justo lo que hace falta para
 * diagnosticar, y se tira lo que hay antes de la `@`.
 */
const URL_WITH_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

/** Parámetros de conexión que son un secreto en sí mismos. */
const SECRET_PARAM = /\b(password|sslpassword|secret)=([^&\s"']+)/gi;

/**
 * Quita del mensaje lo que no debe aparecer en un log: la parte de usuario y
 * clave de cualquier URL y los parámetros `password=`. No pretende ser un
 * saneador exhaustivo; pretende que un error de Prisma o de `pg` que incluya la
 * cadena de conexión no la mande al log del Worker, que en Workers Logs es de
 * acceso público.
 */
function sanitize(message: string): string {
  return message
    .replace(URL_WITH_CREDENTIALS, "$1[redactado]@")
    .replace(SECRET_PARAM, "$1=[redactado]");
}

/** El `code` de Prisma o de PostgreSQL, si el error lo trae. */
function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const { code } = error as { code?: unknown };

  return typeof code === "string" && code !== "" ? code : null;
}

/** Normaliza cualquier valor lanzado a un fallo describible y sin secretos. */
export function describeDatabaseFailure(error: unknown): DatabaseFailure {
  if (error instanceof Error) {
    return {
      type: error.name,
      code: errorCode(error),
      message: sanitize(error.message),
    };
  }

  return { type: typeof error, code: null, message: sanitize(String(error)) };
}

/**
 * Registra un fallo de base de datos y lo devuelve ya descrito.
 *
 * El prefijo `[db]` es lo que permite distinguirlo de un fallo de aplicación en
 * Workers Logs sin tener que leer el mensaje entero. El `scope` dice **dónde**:
 * la lectura que lo ha producido (`public/getStandings`, `participar/alta`…) o la
 * etapa (`db/pool` para el error de un cliente ocioso del *pool*, que en el
 * Worker es la firma de un socket que el runtime ya cerró).
 */
export function logDatabaseFailure(scope: string, error: unknown): DatabaseFailure {
  const failure = describeDatabaseFailure(error);
  const code = failure.code === null ? "" : ` (${failure.code})`;

  console.error(`[db] ${scope}: ${failure.type}${code}: ${failure.message}`);

  return failure;
}

/**
 * ¿El fallo es una violación de unicidad de **esta** columna?
 *
 * `Player` tiene tres columnas únicas (`profileId`, `discordUserId`,
 * `discordUsername`) y las tres saltan con el mismo código, `P2002`. Sin
 * distinguir **cuál** saltó, alguien con el perfil de AoE4World nuevo y el
 * `@usuario` de otra persona recibiría "ese perfil ya está registrado", que no es
 * cierto y no lleva a ninguna corrección.
 *
 * `meta.target` trae el nombre de la columna —como cadena o como lista— y **su
 * forma depende de la versión del cliente**, así que se aceptan las dos, y además
 * se compara sin importar si viene el nombre de la restricción de Postgres
 * (`Player_discordUsername_key`) en vez del de la columna. Si no llega nada
 * utilizable sale `false`, y quien llama trata el error como su caso por defecto,
 * que es lo que hay que hacer cuando no se puede saber.
 *
 * Se leen `code` y `meta` **sin mirar la clase** del error a propósito: así
 * funciona igual con el error real de Prisma y con cualquier otro que traiga la
 * misma forma, y quien llama no necesita importar nada de Prisma para usarlo.
 */
export function uniqueViolationOn(error: unknown, column: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const { code, meta } = error as { code?: unknown; meta?: unknown };

  if (code !== "P2002" || typeof meta !== "object" || meta === null) {
    return false;
  }

  const target = (meta as { target?: unknown }).target;

  if (typeof target === "string") {
    return target === column || target.includes(column);
  }

  return Array.isArray(target) && target.some((item) => item === column);
}

/**
 * Ejecuta una lectura de la base de datos y devuelve un `PublicRead`.
 *
 * El `scope` va al log y describe la lectura, no la pantalla. Lo que se ejecuta
 * dentro de `run` tiene que ser **solo** acceso a la base de datos: es lo que
 * hace que todo lo que se capture aquí sea un fallo de base de datos.
 */
export async function readFromDatabase<T>(
  scope: string,
  run: () => Promise<T>,
): Promise<PublicRead<T>> {
  try {
    return { status: "ok", data: await run() };
  } catch (error) {
    logDatabaseFailure(scope, error);

    return { status: "degraded", data: null };
  }
}

/**
 * Lee una `PublicRead` exigiendo que haya datos, y lanza si está degradada.
 *
 * Para las **herramientas de `scripts/`** y para cualquier verificación: allí un
 * fallo de base de datos tiene que abortar, no devolver una lista vacía. Una
 * comprobación que se traga un corte de la base y sale con "todo correcto" es
 * peor que no comprobar nada, porque dice que la clasificación cuadra cuando
 * nadie la ha mirado.
 */
export function unwrapRead<T>(read: PublicRead<T>, scope: string): T {
  if (read.status === "ok") {
    return read.data;
  }

  throw new Error(
    `${scope}: no se ha podido leer de la base de datos. El motivo está en el log con el prefijo [db].`,
  );
}
