import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * La cookie `discord_link`: el puente entre el callback de Discord y el formulario.
 *
 * ## Por qué viaja en una cookie firmada y no en un `FormData`
 *
 * La persona llega del callback con su identidad ya resuelta y vuelve al formulario,
 * que es una página distinta. Hay tres formas de pasarle esa identidad de una a
 * otra, y dos son malas:
 *
 * 1. **Un campo de texto en el formulario.** Es la que el cliente descartó de
 *    entrada, y con razón: quien lo rellene pone lo que quiera. `discordUserId` es
 *    justo el dato que no puede escribirse a mano.
 * 2. **Guardar la identidad en la base de datos antes de tener la inscripción.** Deja
 *    filas a medias de gente que empezó a rellenar el formulario y se fue, y obliga a
 *    tener una tabla de "inscripciones pendientes" para algo que dura veinte minutos.
 * 3. **Una cookie firmada con HMAC-SHA-256**, que es lo que hay aquí: el servidor la
 *    escribe en el callback y `registerPlayer` la verifica, así que el `userId` que
 *    llega a la base de datos es el que Discord devolvió y nadie lo ha podido
 *    cambiar por el camino.
 *
 * ## Qué lleva dentro y por qué son cuatro campos
 *
 * ```
 * { userId, username, joined, iat }
 * ```
 *
 * - `userId`: lo que se guarda en `Player.discordUserId`. Es lo único que identifica.
 * - `username`: lo que se guarda en `Player.discordUsername`, ya **normalizado** —sin
 *   arroba y en minúsculas— por el callback antes de firmar. **No es un dato
 *   confiable** (Discord deja renombrarse) y no se usa para decidir nada: va para que
 *   el panel reconozca a la persona de un vistazo y para que el worker pueda encontrar
 *   la cuenta en el roster del servidor.
 * - `joined`: si el auto-unión funcionó. Viaja porque el formulario tiene que poder
 *   enseñar la invitación de respaldo cuando viene `false`, y porque esa distinción
 *   solo la sabe quien hizo la unión.
 * - `iat`: el instante en que se firmó, en segundos. Es lo que hace que la cookie
 *   **caduque**: el TTL no lo aplica el navegador (que solo sabe	maxAge`), lo aplica
 *   esta comprobación, porque un `maxAge` que el cliente decide de no cumplir no es
 *   un plazo.
 *
 * ## El formato es `base64url(payload).base64url(HMAC)`
 *
 * Con un punto de separación y **sin cifrar**: el objetivo es que no se pueda
 * *alterar* lo que dice, no esconder lo que dice. El `userId` no es un secreto (va
 * también en la base de datos y lo ve el panel), y el secreto de firma nunca sale
 * del servidor.
 *
 * ## Por qué la comparación es en tiempo constante
 *
 * `timingSafeEqual` en vez de `===`, igual que en `/api/cron/sync`: comparar firmas
 * carácter a carácter devuelve antes en el primer dígito que no coincide, y eso es
 * justo lo que hace falta para reconstruir una firma válida a base de muchos intentos.
 * La comparación va sobre los bytes decodificados, y si las longitudes no coinciden
 * se devuelve `false` sin comparar (no hay nada que comparar y `timingSafeEqual`
 * lanza con longitudes distintas).
 *
 * ## Por qué `now` es un parámetro
 *
 * `verifyDiscordLink()` recibe el instante en vez de llamar a `Date.now()`, y
 * `signDiscordLink()` hace lo mismo. Es lo que permite comprobar la caducidad con el
 * reloj en la mano, en `tests/unit/lib/discord/link.test.ts`, sin temporizadores
 * reales ni esperas.
 */

/** Lo que va dentro de la cookie, ya verificado. */
export type DiscordLink = {
  /** `id` de la cuenta de Discord. */
  userId: string;
  /** `username` en el momento del vínculo. */
  username: string;
  /** `true` si el bot lo metió en el servidor con el auto-unión. */
  joined: boolean;
  /** Instante de la firma, en segundos epoch. */
  iat: number;
};

/** Motivo por el que una cookie no vale. Solo para el log y para los tests. */
export type DiscordLinkFailure =
  | "vacia"
  | "sin-secreto"
  | "formato"
  | "firma"
  | "contenido"
  | "caducada";

export type DiscordLinkVerification =
  | { ok: true; link: DiscordLink }
  | { ok: false; reason: DiscordLinkFailure };

/** Nombre de la cookie. Va en el `path` de `/participar`. */
export const DISCORD_LINK_COOKIE = "discord_link";

/**
 * Nombre de la cookie de `state` del paso OAuth.
 *
 * Es un valor **sin firmar** y sin ningún dato dentro: solo es un número aleatorio
 * que tiene que coincidir con el que va en la URL de autorización, y cuya única
 * función es que un callback que venga de otra pestaña (o de otro sitio) no pueda
 * engancharse a esta inscripción. La firma de la que sí importa es la de
 * `discord_link`.
 */
export const DISCORD_STATE_COOKIE = "discord_oauth_state";

/**
 * Comparación en tiempo constante de dos cadenas.
 *
 * `timingSafeEqual` exige que las dos entradas tengan la misma longitud, así que el
 * caso desigual se resuelve antes. No es una fuga: la **longitud** de una firma es
 * fija y pública, y solo la comparación deja de ser constante.
 */
function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

/**
 * `base64url` sin `=` de relleno.
 *
 * Se codifica a base y luego se sustituyen los dos caracteres que no valen en el
 * valor de una cookie (`+` y `/`, que el navegador o el `Set-Cookie` pueden
 * entender como separadores) por los dos propios de base64url (`-` y `_`). Sin
 * esto la cookie podría llegar recortada o alterada al volver, y la firma no
 * cuadraría por un problema de transporte en lugar de por uno de seguridad.
 */
function encode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decode(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === "" ? null : trimmed;
}

/**
 * Firma el vínculo y devuelve el valor de la cookie.
 *
 * `iat` se toma del `now` que se le pase (o del reloj si no se le pasa), así que la
 * caducidad de la cookie es una propiedad de la firma y no de quién la verifica.
 */
export function signDiscordLink(
  link: Omit<DiscordLink, "iat">,
  secret: string,
  now: number = Date.now(),
): string {
  const payload: DiscordLink = { ...link, iat: Math.floor(now / 1000) };
  const body = encode(JSON.stringify(payload));

  return `${body}.${encode(createHmac("sha256", secret).update(body).digest())}`;
}

/**
 * Verifica la cookie y devuelve el vínculo, o el motivo por el que no vale.
 *
 * **Nunca lanza**, y el orden de las comprobaciones es el que importa: primero la
 * forma, después la firma, después el contenido y por último la caducidad. Verificar
 * la caducidad antes de la firma sería decir "caducada" de una cookie manipulada, que
 * es información sobre algo que nadie ha autenticado; y comprobar el contenido antes
 * de la firma leería campos de un `JSON` que ha escrito cualquiera.
 *
 * `ttlSeconds` es la vida de la cookie (20 minutos por defecto en el módulo de
 * entorno). Un `iat` en el futuro —más de un minuto, que es la tolerancia de reloj
 * entre el isolate que firma y el que verifica— se trata como caducada, porque si el
 * reloj va hacia atrás el TTL no protege de nada. Un `secret` nulo es `sin-secreto`: no
 * hay contra qué verificar y **cualquier** cookie es inválida, en vez de aceptada.
 */
export function verifyDiscordLink(
  value: string | undefined | null,
  secret: string | null,
  ttlSeconds: number,
  now: number = Date.now(),
): DiscordLinkVerification {
  // Sin secreto no hay nada contra lo que verificar, así que **cualquier** cookie es
  // inválida. No es un camino que se pueda dar en producción (sin secreto,
  // `isDiscordOAuthConfigured()` es `false` y nadie exige la cookie), pero está para
  // que quien llame no tenga que comprobarlo antes y para que un despliegue mal
  // configurado no acepte nada en vez de aceptarlo todo.
  if (secret === null || secret === "") {
    return { ok: false, reason: "sin-secreto" };
  }

  if (value === undefined || value === null || value.trim() === "") {
    return { ok: false, reason: "vacia" };
  }

  const separator = value.indexOf(".");

  if (separator <= 0 || separator === value.length - 1) {
    return { ok: false, reason: "formato" };
  }

  const body = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");

  if (!safeEquals(signature, expected)) {
    return { ok: false, reason: "firma" };
  }

  const decoded = decode(body);

  if (decoded === null) {
    return { ok: false, reason: "formato" };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, reason: "formato" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "contenido" };
  }

  const record = parsed as Record<string, unknown>;
  const userId = readString(record.userId);
  const username = readString(record.username);
  const joined = record.joined;
  const iat = record.iat;

  if (
    userId === null ||
    username === null ||
    typeof joined !== "boolean" ||
    typeof iat !== "number" ||
    !Number.isFinite(iat)
  ) {
    return { ok: false, reason: "contenido" };
  }

  const ageSeconds = Math.floor(now / 1000) - iat;

  // Más de un minuto en el futuro: el reloj del que verifica va detrás del del que
  // firmó, y un TTL medido con dos relojes que no coinciden no es un plazo.
  if (ageSeconds < -60) {
    return { ok: false, reason: "caducada" };
  }

  if (ageSeconds > ttlSeconds) {
    return { ok: false, reason: "caducada" };
  }

  return { ok: true, link: { userId, username, joined, iat } };
}
