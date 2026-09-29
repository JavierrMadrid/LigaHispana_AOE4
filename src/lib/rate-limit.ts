import "server-only";

import { createHmac } from "node:crypto";
import { headers } from "next/headers";

import { db } from "@/lib/db";
import { readRuntimeEnv } from "@/lib/runtime-env";

/**
 * Límite de frecuencia para los endpoints públicos y sin sesión. Hoy, el único
 * que lo usa es la inscripción de `/participar` (F6): sin él, cualquiera puede
 * inundar la cola de revisión de `/admin/jugadores` **y** gastar cuota de la API
 * de AoE4World, porque cada envío válido llega a pedir un perfil.
 *
 * Tres decisiones que sostienen el módulo:
 *
 * 1. **La IP no se guarda ni se registra.** Lo que cuenta y lo que se escribe es
 *    un HMAC-SHA-256 con una clave del entorno. La tabla queda con hashes
 *    irrecuperables, y un log con la IP en claro sería una filtración de dato
 *    personal, así que en este fichero la IP no aparece en ningún `console`.
 * 2. **El contador vive en Postgres, no en memoria.** El despliegue es serverless
 *    y cada instancia tendría su propia memoria: un contador en el módulo dejaría
 *    pasar el límite tantas veces como instancias hubiera. El incremento es un
 *    `INSERT ... ON CONFLICT DO UPDATE` de una sola sentencia, que en Postgres
 *    bloquea la fila en conflicto, así que dos envíos simultáneos del mismo cubo
 *    se serializan y ninguno se cuela por debajo del umbral.
 * 3. **Si no hay IP identificable, hay cubo compartido.** La clave `global` es la
 *    última línea: mejor un límite demasiado estricto para quien no envía
 *    cabeceras que quedarnos sin ninguno.
 *
 * **Limitación conocida y deliberada:** detrás de un proxy que reenvíe un
 * `x-forwarded-for` puesto por el cliente sin reescribirlo, un atacante puede
 * rotar la cabecera y abrir un cubo nuevo en cada envío. Por eso el cubo se
 * limita por número de peticiones y no por personaje, y porque lo único que de
 * verdad cuesta dinero (la llamada a la API) solo ocurre con un perfil que existe.
 * Un captcha es la capa que cerraría ese hueco, y sigue pendiente en F6.
 */

export type RateLimitConfig = {
  /** Envíos permitidos por clave dentro de la ventana. */
  maxAttempts: number;
  /** Longitud de la ventana, en segundos. */
  windowSeconds: number;
  /** Una fila sin actividad desde hace esto se considera caducada y se borra. */
  staleSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** Envíos contados en la ventana en curso, este incluido. */
  count: number;
  limit: number;
  /** De dónde salió la clave: la IP hasheada o el cubo compartido. */
  scope: "ip" | "global";
  /** Cuánto queda para que la ventana se reinicie, en segundos. */
  retryAfterSeconds: number;
};

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SECONDS = 3_600;
const DEFAULT_STALE_SECONDS = 86_400;

/**
 * Marca de la última limpieza, por proceso. No es estado de petición (aquí no
 * hay nada que compartir entre renderizados) sino mantenimiento: como mucho una
 * purga por minuto, para que la tabla no crezca con una fila por cada IP vista
 * sin fin.
 */
const PURGE_INTERVAL_MS = 60_000;

let lastPurgeAt = 0;

/**
 * Sal de reserva cuando no hay ninguna variable de entorno configurada.
 *
 * Un hash con sal fija protege contra la lectura de la tabla (dentro no hay nada
 * personal), pero no contra un ataque de diccionario sobre el espacio de IPv4,
 * porque la sal es pública en el repositorio. Con `RATE_LIMIT_SALT` o
 * `CRON_SECRET` definida eso deja de ser un problema; sin ninguna de las dos, es
 * el precio de que el proyecto funcione sin configurar nada.
 */
const FALLBACK_SALT = "ligahispana-aoe4/rate-limit/v1";

/** Clave del cubo compartido: la que se usa cuando no se puede identificar la IP. */
const GLOBAL_KEY = "global";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Forma mínima de una IPv6. No es un parser: solo acota el espacio de claves a
 * caracteres hexadecimales, puntos, dos puntos y un posible identificador de
 * zona, y a una longitud razonable. Suficiente, porque lo que sale de aquí va
 * hasheado.
 */
const IPV6_BODY = /^[0-9a-f:.%]+$/i;

const MAX_IP_LENGTH = 45;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = readRuntimeEnv(name);

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    // Un valor mal escrito no debe tumbar el formulario: se avisa y se usa el
    // valor por defecto, que es el que protege.
    console.warn(
      `[rate-limit] ${name} no es un número positivo (valor recibido: "${raw}"): se usa ${fallback}.`,
    );
    return fallback;
  }

  return Math.floor(value);
}

export function getRateLimitConfig(): RateLimitConfig {
  return {
    maxAttempts: readPositiveIntEnv("RATE_LIMIT_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
    windowSeconds: readPositiveIntEnv("RATE_LIMIT_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS),
    staleSeconds: readPositiveIntEnv("RATE_LIMIT_STALE_SECONDS", DEFAULT_STALE_SECONDS),
  };
}

/** ¿Es un IPv4 en rango, o algo que tiene toda la pinta de ser un IPv6? */
function isPlausibleIp(value: string): boolean {
  if (IPV4.test(value)) {
    return value.split(".").every((octet) => Number(octet) <= 255);
  }

  return value.includes(":") && IPV6_BODY.test(value);
}

/**
 * IP del cliente según las cabeceras de reenvío.
 *
 * `x-forwarded-for` es una lista a la que cada salto añade su parte, así que el
 * **primer** elemento es el cliente original. Se mira esa cabecera primero y
 * `x-real-ip` después, que es la que ponen los proxies y los anfitriones más
 * habituales. Se acepta la primera IP plausible del conjunto; si ninguna vale,
 * `null`, y quien llama cae al cubo compartido.
 *
 * Que se acepte el primer elemento plausible (y no solo el primero) y que se
 * descarten las cadenas que no tienen forma de IP no es cortesía: acota el
 * espacio de claves a algo que cabe en 45 caracteres y a caracteres hexadecimales,
 * de modo que nadie pueda escribir una clave arbitrariamente larga en la tabla.
 */
export function readClientIp(requestHeaders: Headers): string | null {
  const candidates: string[] = [];

  for (const header of ["x-forwarded-for", "x-real-ip"]) {
    const value = requestHeaders.get(header);

    if (value !== null) {
      candidates.push(...value.split(","));
    }
  }

  for (const candidate of candidates) {
    const ip = candidate.trim().toLowerCase();

    if (ip.length > 0 && ip.length <= MAX_IP_LENGTH && isPlausibleIp(ip)) {
      return ip;
    }
  }

  return null;
}

/**
 * Secreto con el que se calcula el HMAC de la IP.
 *
 * `RATE_LIMIT_SALT` es lo propio de este límite; `CRON_SECRET` se acepta como
 * alternativa para no obligar a tener dos secretos, y es igual de bueno porque
 * solo se usa aquí.
 */
function readSalt(): string {
  const configured = readRuntimeEnv("RATE_LIMIT_SALT")?.trim() ?? "";
  const cronSecret = readRuntimeEnv("CRON_SECRET")?.trim() ?? "";

  if (configured !== "") {
    return configured;
  }

  if (cronSecret !== "") {
    return cronSecret;
  }

  return FALLBACK_SALT;
}

/**
 * Clave de la fila: HMAC con el secreto del entorno, con prefijo de ámbito.
 *
 * El prefijo no aporta nada contra las colisiones (256 bits no colisionan de
 * forma práctica) y sí separa los dos ámbitos de un vistazo al mirar la tabla:
 * todo lo que empieza por `ip:` es una IP hasheada y el resto es el cubo global.
 */
function buildKey(scope: RateLimitResult["scope"], ip: string | null): string {
  if (scope === "global") {
    return GLOBAL_KEY;
  }

  return `ip:${createHmac("sha256", readSalt()).update(ip ?? "").digest("hex")}`;
}

/** Fila que devuelve el `RETURNING` del contador. */
type CounterRow = { count: number };

/**
 * Suma uno al contador de la clave y devuelve el total.
 *
 * Todo en una sentencia, y por eso es atómica frente a dos envíos a la vez: el
 * `ON CONFLICT DO UPDATE` espera a que termine la transacción que ya tiene esa
 * fila y vuelve a evaluarla sobre la versión nueva, así que el segundo envío ve
 * el incremento del primero.
 *
 * La ventana se decide **en SQL** con `now()` en vez de pasando una fecha desde
 * el código: `DateTime` de Prisma es `timestamp` sin zona, y mezclarlo con un
 * `Date` de JavaScript depende de la zona horaria de la sesión, que es
 * exactamente el tipo de fallo que no aparece hasta que aparece.
 */
async function bumpCounter(key: string, windowSeconds: number): Promise<number> {
  const rows = await db.$queryRaw<CounterRow[]>`
    insert into "RateLimitCounter" ("key", "count", "windowStart", "updatedAt")
    values (${key}, 1, now(), now())
    on conflict ("key") do update
       set "count" = case
                       when "RateLimitCounter"."windowStart"
                            <= now() - (${windowSeconds}::int * interval '1 second')
                       then 1
                       else "RateLimitCounter"."count" + 1
                     end,
           "windowStart" = case
                              when "RateLimitCounter"."windowStart"
                                   <= now() - (${windowSeconds}::int * interval '1 second')
                              then now()
                              else "RateLimitCounter"."windowStart"
                            end,
           "updatedAt" = now()
    returning "count" as "count"
  `;

  const count = rows[0]?.count;

  if (typeof count !== "number") {
    throw new Error("El contador de frecuencia no ha devuelto el total esperado.");
  }

  return count;
}

/**
 * Cuenta un intento contra la clave indicada y decide si pasa.
 *
 * `key` es opaca para quien llama (la construye `consumePublicFormAttempt`); el
 * `scope` solo se usa para saber en el mensaje de error si el límite se ha
 * alcanzado por esa IP o por el cubo compartido.
 */
export async function consumeRateLimit(
  key: string,
  scope: RateLimitResult["scope"],
  config: RateLimitConfig = getRateLimitConfig(),
): Promise<RateLimitResult> {
  const count = await bumpCounter(key, config.windowSeconds);
  const allowed = count <= config.maxAttempts;

  // Al alcanzar el límite, la ventana que importa es la que acaba de empezar,
  // así que el tiempo que queda es el de esa y no el de la anterior.
  const retryAfterSeconds = allowed ? 0 : config.windowSeconds;

  // La purga va de paso y nunca en el camino que puede fallar: cada 25 envíos se
  // intenta, y `purgeStaleCounters` ya se traga sus propios errores.
  if (count % 25 === 0) {
    await purgeStaleCounters(config.staleSeconds);
  }

  return { allowed, count, limit: config.maxAttempts, scope, retryAfterSeconds };
}

/**
 * Punto de entrada del límite para un endpoint público.
 *
 * Lee la IP de las cabeceras de la petición (en Next 16 `headers()` es async),
 * la hashea y cuenta el intento. Si se pasa `ip` explícitamente no se leen las
 * cabeceras: es lo que permite verificar el límite sin una petición de por medio.
 */
export async function consumePublicFormAttempt(
  options: { ip?: string | null } = {},
): Promise<RateLimitResult> {
  const ip = options.ip === undefined ? readClientIp(await headers()) : options.ip;
  const scope: RateLimitResult["scope"] = ip === null ? "global" : "ip";

  return consumeRateLimit(buildKey(scope, ip), scope);
}

/**
 * Borra las filas cuya ventana caducó hace más de `staleSeconds`.
 *
 * Sin esto la tabla crecería con una fila por cada IP que ha enviado algo una vez,
 * para siempre. Se llama de tanto en tanto desde `consumeRateLimit`.
 */
async function purgeStaleCounters(staleSeconds: number): Promise<void> {
  const now = Date.now();

  if (now - lastPurgeAt < PURGE_INTERVAL_MS) {
    return;
  }

  lastPurgeAt = now;

  try {
    const deleted = await db.rateLimitCounter.deleteMany({
      where: { windowStart: { lt: new Date(now - staleSeconds * 1000) } },
    });

    if (deleted.count > 0) {
      console.info(`[rate-limit] Purgadas ${deleted.count} filas de contador caducadas.`);
    }
  } catch (error) {
    console.error(
      "[rate-limit] No se han podido purgar los contadores caducados:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
