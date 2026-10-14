/**
 * Quién puede entrar al panel: el cálculo, sin tocar la base ni el entorno.
 *
 * Vive aparte de `src/lib/auth.ts` (que es quien lee la sesión, la tabla `Admin` y
 * `SUPERADMIN_EMAIL`) porque este módulo es **puro** y por tanto se prueba sin
 * Supabase, sin Postgres y sin variables de entorno. La decisión de acceso es
 * pequeña, pero es la puerta de `/admin`: tenerla aislada es lo que permite fijar
 * sus reglas en un test en vez de confiar en leer bien tres condiciones repartidas
 * por media app.
 *
 * No lleva `server-only` a propósito: no importa nada del servidor, así que
 * cualquiera puede importarlo (el test incluido) sin arrastrar `next/headers`.
 */

/** El papel de una cuenta respecto al panel. */
export type AdminAccess = "superadmin" | "admin" | "none";

/**
 * La forma mínima de una fila de `Admin` que necesita la decisión de acceso.
 *
 * No es la fila entera: lo único que se compara es el correo y si está activa.
 * Pedir dos campos y no siete deja claro que lo demás no decide nada.
 */
export type AccessRow = {
  /** `Admin.email`, ya canónico. */
  email: string;
  /** `Admin.active`. Una fila inactiva es una baja y no deja entrar. */
  active: boolean;
};

/**
 * La forma canónica de un correo de administración: **sin espacios y en
 * minúsculas**.
 *
 * Es la misma que se guarda en `Admin.email` y con la que se compara la sesión, y
 * tiene que ser una sola: el correo de Supabase Auth y el que escribe la
 * organización pueden venir con cualquier caja, y "Beast@Correo.com" y
 * "beast@correo.com" son la misma cuenta, no dos. Con dos normalizaciones
 * distintas el superadministrador podría no reconocerse a sí mismo.
 */
export function normalizeAdminEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * ¿El correo es el del superadministrador?
 *
 * El superadministrador es **único** y vive en el entorno (`SUPERADMIN_EMAIL`), no
 * en la base: sin la variable, `superadminEmail` es `null` y **nadie** lo es. La
 * comparación es sobre las dos formas canónicas, así que una variable escrita con
 * mayúsculas o con espacios alrededor sigue reconociendo la cuenta.
 */
export function isSuperadminEmail(
  email: string,
  superadminEmail: string | null | undefined,
): boolean {
  if (superadminEmail === null || superadminEmail === undefined) {
    return false;
  }

  const canonico = superadminEmail.trim().toLowerCase();

  return canonico !== "" && normalizeAdminEmail(email) === canonico;
}

/**
 * Resuelve el acceso de un correo: superadministrador, administrador o ninguno.
 *
 * El orden de las dos preguntas es la regla entera. Primero el superadministrador
 * —por entorno, sin mirar la tabla— y solo después la fila activa. Eso hace que el
 * superadministrador lo sea aunque no tenga fila en `Admin` (no la necesita), y que
 * su correo no se pueda "dar de baja" desde el panel: la baja toca la tabla, y la
 * tabla no decide sobre él.
 *
 * El correo entra tal cual lo devuelve la sesión y se normaliza aquí: quien llama
 * no tiene por qué acordarse de hacerlo.
 */
export function resolveAdminAccess(input: {
  email: string;
  superadminEmail: string | null | undefined;
  admins: readonly AccessRow[];
}): AdminAccess {
  const email = normalizeAdminEmail(input.email);

  if (email === "") {
    return "none";
  }

  if (isSuperadminEmail(email, input.superadminEmail)) {
    return "superadmin";
  }

  const fila = input.admins.find(
    (admin) => admin.active && normalizeAdminEmail(admin.email) === email,
  );

  return fila === undefined ? "none" : "admin";
}
